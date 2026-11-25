// Lot 2, commit 3 (v3 V3.2, V3.3, V3.6 point 1 ; v2 R2.7 N12 ; v3 V3.1
// N12 bis) : les AUTEURS de sources sur un produit à documents compilés par
// les CLI réelles. Oracles écrits ici :
// - sur un produit périmé, `compile:backend-contract` et
//   `compile:application-design` sont PERMIS et impriment `SOURCES_A_LIER`
//   (une ligne par source à lier, lue ici) ; les consommateurs restent
//   refusés ;
// - les auteurs restent soumis à l'intégrité (N12, N12 bis) ;
// - P-M3a à P-M3c : empreintes de contrat selon le mode.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { planApplicationDesignPublication } from './core/application-design-publication.mjs';
import {
    planExternalApplicationShell,
    publishExternalApplicationShell,
} from './core/application-workspace.mjs';
import { sha256 } from './core/generation-manifest.mjs';
import { writeApplicationDesignFixture } from './test-support/application-design-fixture.mjs';
import {
    fixtureParent,
    installMetadataOnly,
    prepareFixture,
    snapshotTree,
    TOOLS_ROOT,
} from './test-support/external-application-fixture.mjs';
import {
    nativeDocumentFixture,
    SHARED_DOCUMENT_SOURCE,
} from './proof-support/external-document-native.mjs';
import {
    backendArgs,
    compileDocumentFixture,
    designArgs,
    documentFixture,
    runDocumentCli,
} from './test-support/external-document-fixture.mjs';

// Appli créée sur la conception compilée.
const APP = 'doc-app';
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const STALE = (genre, path, app = APP) =>
    new RegExp(
        `APP_SOURCES_STALE ${app} ${genre} ${escape(path)} ; lancer update-app --target-root <racine> --dry-run`
    );
const touch = async (root, path) =>
    writeFile(
        join(root, path),
        (await readFile(join(root, path), 'utf8')) + '\n'
    );

// Auteurs (V3.2, V3.6 point 1) : produit à documents compilés par les CLI
// réelles (conception extérieure SANS empreinte de contrat : P-M3a), appli
// créée sur la conception compilée.
const DOC = 'descriptions/ext03a-b';
const DOC_APP = APP;
async function documentProduct(t) {
    const fixture = await documentFixture(t, 'B');
    await installMetadataOnly(fixture.plan);
    await compileDocumentFixture(fixture);
    const written = JSON.parse(
        await readFile(join(fixture.root, fixture.designPath), 'utf8')
    );
    assert.equal(written.schema_version, '1.3.0');
    assert.ok(
        written.backend_contracts.every(
            (reference) => !Object.hasOwn(reference, 'sha256')
        ),
        'P-M3a : aucune empreinte de contrat dans la conception écrite'
    );
    const shell = {
        workspaceRoot: TOOLS_ROOT,
        targetRoot: fixture.root,
        designPath: fixture.designPath,
        experienceId: written.experiences[0].id,
        appName: DOC_APP,
        profile: 'angular-pwa',
        applicationDesignSchema: fixture.applicationDesignSchema,
        backendContractSchema: fixture.backendContractSchema,
    };
    const plan = await planExternalApplicationShell(shell);
    await publishExternalApplicationShell(
        { ...shell, expectedPlanId: plan.plan_id },
        { run: () => undefined }
    );
    return { fixture, shell, request: fixture.backendRequests[0] };
}
const toBind = (stderr) =>
    stderr.split('\n').filter((line) => line.startsWith('SOURCES_A_LIER: '));
const LINE = (genre, path) =>
    `SOURCES_A_LIER: ${genre} ${path} ; lancer update-app --target-root <racine> --dry-run`;

test('auteurs PERMIS sur un produit périmé, lignes SOURCES_A_LIER ; consommateurs refusés', async (t) => {
    const { fixture, shell, request } = await documentProduct(t);
    const fresh = runDocumentCli('compile-backend-contract', [
        ...backendArgs(fixture, request),
        '--dry-run',
    ]);
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.deepEqual(toBind(fresh.stderr), []);
    // Source du contrat retouchée : le produit est périmé.
    const definition = await readFile(
        join(fixture.root, request.definitionPath)
    );
    await touch(fixture.root, request.definitionPath);
    const preview = runDocumentCli('compile-backend-contract', [
        ...backendArgs(fixture, request),
        '--dry-run',
    ]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(toBind(preview.stderr), [
        LINE('contract', request.definitionPath),
    ]);
    // Lot 2, commit 6a (index du pilote, L-21) : l'application à la MÊME
    // sortie remplace le contrat présent, celui que le plan relu nomme
    // (`output_before_sha256`), par un renommage atomique.
    const plan = JSON.parse(preview.stdout);
    const present = await readFile(join(fixture.root, request.outputPath));
    assert.equal(plan.output_before_sha256, sha256(present));
    assert.notEqual(plan.output_sha256, plan.output_before_sha256);
    const replace = runDocumentCli('compile-backend-contract', [
        ...backendArgs(fixture, request),
        '--apply',
        plan.plan_id,
    ]);
    assert.equal(replace.status, 0, replace.stderr);
    assert.equal(
        sha256(await readFile(join(fixture.root, request.outputPath))),
        plan.output_sha256
    );
    // Le contrat compilé, source liée, est remplacé : la ligne le nomme, avec
    // sa définition (la mise à jour reliera les deux).
    assert.deepEqual(toBind(replace.stderr), [
        LINE('contract', request.outputPath),
        LINE('contract', request.definitionPath),
    ]);
    // Seconde compilation à la MÊME sortie (P8, partie auteur) : son plan
    // nomme le contrat que la première a écrit, et son application le
    // remplace à son tour.
    await touch(fixture.root, request.definitionPath);
    const second = runDocumentCli('compile-backend-contract', [
        ...backendArgs(fixture, request),
        '--dry-run',
    ]);
    assert.equal(second.status, 0, second.stderr);
    const secondPlan = JSON.parse(second.stdout);
    assert.equal(secondPlan.output_before_sha256, plan.output_sha256);
    const secondArgs = [
        ...backendArgs(fixture, request),
        '--apply',
        secondPlan.plan_id,
    ];
    const secondApply = runDocumentCli('compile-backend-contract', secondArgs);
    assert.equal(secondApply.status, 0, secondApply.stderr);
    assert.equal(
        sha256(await readFile(join(fixture.root, request.outputPath))),
        secondPlan.output_sha256
    );
    // Limite écrite (ADR) : le rejeu d'un REMPLACEMENT fait est périmé, son
    // « avant » n'existe plus ; un plan neuf voit l'après et ne change rien.
    const replay = runDocumentCli('compile-backend-contract', secondArgs);
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /reviewed plan id is stale or invalid/);
    assert.equal(
        sha256(await readFile(join(fixture.root, request.outputPath))),
        secondPlan.output_sha256
    );
    // La suite part du contrat d'origine, remis, pour éprouver les sorties
    // NEUVES seules.
    await writeFile(join(fixture.root, request.outputPath), present);
    // Application à une sortie NOUVELLE : permise sur le produit périmé.
    const next = `${DOC}/contracts/backend.next.contract.json`;
    const nextArgs = [
        '--target-root',
        fixture.root,
        '--definition',
        request.definitionPath,
        '--out',
        next,
        '--adapter',
        request.adapter,
    ];
    const nextPlan = runDocumentCli('compile-backend-contract', [
        ...nextArgs,
        '--dry-run',
    ]);
    assert.equal(nextPlan.status, 0, nextPlan.stderr);
    const apply = runDocumentCli('compile-backend-contract', [
        ...nextArgs,
        '--apply',
        JSON.parse(nextPlan.stdout).plan_id,
    ]);
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepEqual(toBind(apply.stderr), [
        LINE('contract', request.definitionPath),
    ]);
    // Seconde compilation sur le produit périmé : permise aussi.
    const again = runDocumentCli('compile-backend-contract', [
        ...backendArgs(fixture, request),
        '--dry-run',
    ]);
    assert.equal(again.status, 0, again.stderr);
    await assert.rejects(
        planExternalApplicationShell({ ...shell, appName: 'doc-two' }),
        STALE('contract', request.definitionPath, DOC_APP)
    );
    // Conception recompilée sur un produit périmé par SA conception (la
    // source du contrat rendue, la conception liée retouchée à la main) :
    // permise, sortie neuve ; la ligne nomme la conception à lier.
    await writeFile(join(fixture.root, request.definitionPath), definition);
    await touch(fixture.root, fixture.designPath);
    const designArgsNext = [
        '--target-root',
        fixture.root,
        '--source',
        fixture.sourcePath,
        '--out',
        `${DOC}/application-design.next.json`,
    ];
    const design = runDocumentCli('compile-application-design', [
        ...designArgsNext,
        '--dry-run',
    ]);
    assert.equal(design.status, 0, design.stderr);
    // Sortie neuve : le plan public de la conception nomme un « avant » nul.
    assert.equal(JSON.parse(design.stdout).output_before_sha256, null);
    assert.deepEqual(toBind(design.stderr), [
        LINE('design', fixture.designPath),
    ]);
    const designApply = runDocumentCli('compile-application-design', [
        ...designArgsNext,
        '--apply',
        JSON.parse(design.stdout).plan_id,
    ]);
    assert.equal(designApply.status, 0, designApply.stderr);
});

test('N12 et N12 bis : sur un produit périmé, les auteurs restent soumis à l’intégrité', async (t) => {
    const { fixture, request } = await documentProduct(t);
    await touch(fixture.root, request.definitionPath);
    const page = JSON.parse(
        await readFile(join(fixture.root, fixture.designPath), 'utf8')
    ).pages[0].id;
    for (const out of [
        `libs/${DOC_APP}-socle/src/x.json`,
        `libs/${DOC_APP}-interface/project.json`,
        `libs/${DOC_APP}-interface/src/pages/${page}/x.json`,
    ]) {
        const before = await snapshotTree(fixture.root, ['node_modules']);
        const result = runDocumentCli('compile-backend-contract', [
            '--target-root',
            fixture.root,
            '--definition',
            request.definitionPath,
            '--out',
            out,
            '--adapter',
            request.adapter,
            '--dry-run',
        ]);
        assert.equal(result.status, 1, out);
        assert.match(
            result.stderr,
            /document collides with a reserved workspace namespace/,
            out
        );
        assert.deepEqual(
            await snapshotTree(fixture.root, ['node_modules']),
            before,
            out
        );
    }
    // N12 bis : fichier possédé du socle retouché → refus par l'intégrité.
    await touch(fixture.root, `libs/${DOC_APP}-socle/src/index.ts`);
    const drift = runDocumentCli('compile-backend-contract', [
        ...backendArgs(fixture, request),
        '--dry-run',
    ]);
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /workspace ownership drift/);
});

test('P-M3a à P-M3c : empreintes de contrat selon le mode', async (t) => {
    const { fixture, shell, request } = await documentProduct(t);
    // P-M3b : une conception extérieure qui déclare l'empreinte est refusée,
    // à la création (produit à jour) comme à la compilation.
    const declared = JSON.parse(
        await readFile(join(fixture.root, fixture.sourcePath), 'utf8')
    );
    declared.backend_contracts[0].sha256 = sha256(
        await readFile(join(fixture.root, request.outputPath))
    );
    const copy = `${DOC}/declared-design.json`;
    await writeFile(
        join(fixture.root, copy),
        `${JSON.stringify(declared, null, 2)}\n`
    );
    await assert.rejects(
        planExternalApplicationShell({
            ...shell,
            appName: 'doc-two',
            designPath: copy,
        }),
        new RegExp(
            `EXTERNAL_DESIGN_CONTRACT_DIGEST ${escape(request.outputPath)}`
        )
    );
    const refused = runDocumentCli('compile-application-design', [
        '--target-root',
        fixture.root,
        '--source',
        copy,
        '--out',
        `${DOC}/declared-out.json`,
        '--dry-run',
    ]);
    assert.equal(refused.status, 1);
    assert.match(
        refused.stderr,
        new RegExp(
            `EXTERNAL_DESIGN_CONTRACT_DIGEST ${escape(request.outputPath)}`
        )
    );
    // P-M3a : le plan de la conception change quand le contrat change.
    const first = runDocumentCli('compile-application-design', [
        ...designArgs(fixture),
        '--dry-run',
    ]);
    assert.equal(first.status, 0, first.stderr);
    await touch(fixture.root, request.outputPath);
    const second = runDocumentCli('compile-application-design', [
        ...designArgs(fixture),
        '--dry-run',
    ]);
    assert.equal(second.status, 0, second.stderr);
    assert.notEqual(
        JSON.parse(second.stdout).plan_id,
        JSON.parse(first.stdout).plan_id
    );
    // P-M3c : mode interne (sans --target-root) : l'empreinte est exigée.
    const internal = await fixtureParent(t);
    const data = await writeApplicationDesignFixture(
        internal,
        fixture.backendContractSchema
    );
    const design = structuredClone(data.design);
    design.schema_version = '1.3.0';
    delete design.backend_contracts[0].sha256;
    await writeFile(
        join(internal, 'design-source.json'),
        `${JSON.stringify(design, null, 2)}\n`
    );
    await assert.rejects(
        planApplicationDesignPublication({
            workspaceRoot: internal,
            sourcePath: 'design-source.json',
            outputPath: 'design.json',
            applicationDesignSchema: fixture.applicationDesignSchema,
            backendContractSchema: fixture.backendContractSchema,
        }),
        new RegExp(
            `INTERNAL_DESIGN_CONTRACT_DIGEST ${escape(design.backend_contracts[0].snapshot_uri)}`
        )
    );
});

// CI #48 sur `be7bf4e9`, cellule EXT03a/A : les documents de A, dont le brief
// vit HORS de `descriptions/` (`examples/…`, contre-exemple T11), compilés par
// les CLI réelles. La ligne `SOURCES_A_LIER` relisait l'espace en
// CONSOMMATEUR (voisins documentaires refusés) : la commande échouait après
// son plan. Elle le relit désormais comme son plan, en auteur.
test('CI #48 : un auteur dont un document vit hors de descriptions/ réussit et n’imprime rien à lier', async (t) => {
    const prepared = await prepareFixture(t, ['angular-pwa', 'react-spa']);
    const fixture = await nativeDocumentFixture(prepared.root, 'A');
    assert.ok(
        fixture.design.sources.some(
            (source) => source.snapshot_uri === SHARED_DOCUMENT_SOURCE
        )
    );
    const { receipts } = await compileDocumentFixture(fixture);
    for (const receipt of receipts) {
        assert.equal(receipt.apply.status, 0, receipt.tool);
        assert.deepEqual(toBind(receipt.preview.stderr), [], receipt.tool);
        assert.deepEqual(toBind(receipt.apply.stderr), [], receipt.tool);
    }
});

// Lot 2, commit 6a (index du pilote, A-7) : un dossier de sortie absent est un
// refus NOMMÉ, par les deux auteurs, sans `ENOENT` brut ni chemin local ; rien
// n'est écrit.
test('A-7 : dossier de sortie absent, refus nommé et sans chemin local', async (t) => {
    const { fixture, request } = await documentProduct(t);
    const before = await snapshotTree(fixture.root);
    const backend = backendArgs(fixture, request);
    backend[backend.indexOf('--out') + 1] =
        `${DOC}/absent/backend.contract.json`;
    const runs = [
        runDocumentCli('compile-backend-contract', [...backend, '--dry-run']),
        runDocumentCli('compile-application-design', [
            '--target-root',
            fixture.root,
            '--source',
            fixture.sourcePath,
            '--out',
            `${DOC}/absent/application-design.json`,
            '--dry-run',
        ]),
    ];
    for (const run of runs) {
        assert.equal(run.status, 1, run.stderr);
        assert.match(
            run.stderr,
            new RegExp(
                `output parent directory missing: ${escape(`${DOC}/absent`)}\\n`
            )
        );
        assert.equal(run.stderr.includes('ENOENT'), false, run.stderr);
        assert.equal(run.stderr.includes(fixture.root), false, run.stderr);
    }
    // Même classe : une source absente est nommée, sans chemin local.
    const missing = backendArgs(fixture, request);
    missing[missing.indexOf('--definition') + 1] = `${DOC}/absente.json`;
    const sources = [
        [
            runDocumentCli('compile-backend-contract', [
                ...missing,
                '--dry-run',
            ]),
            `definition missing: ${DOC}/absente.json`,
        ],
        [
            runDocumentCli('compile-application-design', [
                '--target-root',
                fixture.root,
                '--source',
                `${DOC}/absente.json`,
                '--out',
                `${DOC}/application-design.next.json`,
                '--dry-run',
            ]),
            `source missing: ${DOC}/absente.json`,
        ],
    ];
    for (const [run, message] of sources) {
        assert.equal(run.status, 1, run.stderr);
        assert.match(run.stderr, new RegExp(`${escape(message)}\\n`));
        assert.equal(run.stderr.includes('ENOENT'), false, run.stderr);
        assert.equal(run.stderr.includes(fixture.root), false, run.stderr);
    }
    assert.deepEqual(await snapshotTree(fixture.root), before);
});

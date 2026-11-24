// Lot 2, commit 3 (v2 R2.2 à R2.4 et R2.7 partielle ; v3 V3.2, V3.3, V3.5 b
// et f, V3.6 point 1 ; v4 V4.5 ; v5 L-2) : liaison des sources d'une appli
// et fraîcheur, sur des produits fictifs (runner natif injecté : rien ne
// compile). Oracles écrits ici :
// - N1 : une source liée retouchée (conception, brief, contrat, source lue
//   DANS le contrat) → tout consommateur REFUSÉ, à vide compris
//   (préparation de l'espace, `create-app`, publication, renommage) :
//   `APP_SOURCES_STALE <app> <genre> <chemin> ; lancer update-app …` ;
// - le vérificateur du produit écrit `SOURCES_STALE` et
//   `INTERFACE_PAGE_ORPHAN` (texte de `staleSources` embarqué tel quel) ;
// - les reprises passent sur un produit périmé ;
// - N5 bis : source retouchée PENDANT la transaction d'une publication ou
//   d'une création → `… inputs changed`, produit inchangé ;
// - P-M3d, partie `create-app` (L-2) : la liaison porte l'empreinte du
//   contrat ; la conception extérieure n'en porte aucune ;
// - le manifeste porte `sources` de même forme dans les deux modes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
    planApplicationPublication,
    publishApplicationPublication,
    recoverApplicationPublication,
} from './core/application-publication.mjs';
import { planApplicationShell } from './core/application-shell-publication.mjs';
import { staleSources } from './core/application-sources.mjs';
import {
    planApplicationWorkspace,
    planExternalApplicationShell,
    publishExternalApplicationShell,
} from './core/application-workspace.mjs';
import { SIGNATURE_FILES } from './core/atelier-signature.mjs';
import { sha256 } from './core/generation-manifest.mjs';
import { planProductPrefixRename } from './core/product-prefix-rename.mjs';
import { recoverProductPrefixRename } from './core/product-prefix-rename-transaction.mjs';
import { appManifestPath } from './renderers/external-product-layout.mjs';
import {
    withProductPrefix,
    writeApplicationDesignFixture,
} from './test-support/application-design-fixture.mjs';
import {
    fixtureParent,
    schemas,
    shellFixture,
    snapshotTree,
    TOOLS_ROOT,
    writeExternalDesign,
} from './test-support/external-application-fixture.mjs';
import {
    interruptAt,
    publication,
    readManifest,
    sessionApp,
} from './test-support/external-publication-fixture.mjs';
import {
    renameProduct,
    renameTo,
} from './test-support/product-prefix-rename-fixture.mjs';

const APP = 'session-observatory';
const BASE = 'descriptions/session-observatory';
// Liaison attendue de l'appli à session, oracle écrit ici : la conception et
// son brief (genre `design`), le contrat et la source relue DANS le contrat
// (genre `contract`).
const BOUND = [
    ['design', `${BASE}/application-design.json`],
    ['design', `${BASE}/brief.md`],
    ['contract', `${BASE}/backend.json`],
    ['contract', `${BASE}/declared.json`],
];
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

test('P-M3d (create-app, L-2) : la liaison porte la fermeture par genre ; la conception extérieure n’a aucune empreinte de contrat', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const manifest = await readManifest(product);
    const design = JSON.parse(
        await readFile(join(product.root, product.shell.designPath), 'utf8')
    );
    assert.equal(design.schema_version, '1.3.0');
    assert.ok(
        design.backend_contracts.every(
            (reference) => !Object.hasOwn(reference, 'sha256')
        )
    );
    const expected = [];
    for (const [genre, path] of BOUND) {
        const bytes = await readFile(join(product.root, path));
        expected.push({
            genre,
            path,
            sha256: sha256(bytes),
            bytes: bytes.length,
        });
    }
    assert.deepEqual(
        manifest.sources,
        expected.sort((a, b) => (a.path < b.path ? -1 : 1))
    );
    // Les contrats de page recopient l'empreinte RÉSOLUE (V3.3 point 6).
    const contract = manifest.sources.find(
        (entry) => entry.path === `${BASE}/backend.json`
    );
    for (const entry of await readdir(
        join(product.app, SIGNATURE_FILES.pages)
    )) {
        const page = JSON.parse(
            await readFile(
                join(product.app, SIGNATURE_FILES.pages, entry),
                'utf8'
            )
        );
        assert.equal(page.backend_contracts[0].sha256, contract.sha256);
    }
});

test('N1 : une source liée retouchée → tout consommateur REFUSÉ, à vide compris, APP_SOURCES_STALE', async (t) => {
    // Un produit neuf par source (sans sous-test : le premier échec nomme ce
    // cas, critère de mort des mutants).
    for (const [genre, path] of BOUND) {
        const product = await sessionApp(t, 'observatory');
        await touch(product.root, path);
        const stale = STALE(genre, path);
        await assert.rejects(planApplicationWorkspace(product.options), stale);
        await assert.rejects(
            planExternalApplicationShell({
                ...product.shell,
                appName: 'second-app',
            }),
            stale
        );
        await assert.rejects(
            planApplicationPublication(
                publication(product, {
                    [product.notice]: 'export const notice = 1;\n',
                })
            ),
            stale
        );
        await assert.rejects(
            planProductPrefixRename({
                workspaceRoot: TOOLS_ROOT,
                targetRoot: product.root,
                to: 'qz',
            }),
            stale
        );
    }
});

test('vérificateur du produit : SOURCES_STALE (modified, missing) et INTERFACE_PAGE_ORPHAN, texte de staleSources embarqué', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const script = join(
        product.root,
        SIGNATURE_FILES.support,
        'check-socle.mjs'
    );
    const text = await readFile(script, 'utf8');
    assert.ok(text.includes(staleSources.toString()), 'une seule définition');
    const { socleDrifts } = await import(pathToFileURL(script).href);
    assert.deepEqual(await socleDrifts(APP), []);
    await touch(product.root, `${BASE}/declared.json`);
    await rm(join(product.root, `${BASE}/brief.md`));
    const orphan = `libs/${APP}-interface/src/pages/page_orpheline`;
    await mkdir(join(product.root, orphan), { recursive: true });
    const hint = ' ; lancer update-app --target-root <racine> --dry-run';
    assert.deepEqual(await socleDrifts(APP), [
        `SOURCES_STALE design ${BASE}/brief.md (missing)${hint}`,
        `SOURCES_STALE contract ${BASE}/declared.json (modified)${hint}`,
        `INTERFACE_PAGE_ORPHAN ${orphan}`,
    ]);
    // La cible `check-socle` du socle lance ce script pour SON appli.
    const project = JSON.parse(
        await readFile(
            join(product.root, `libs/${APP}-socle/project.json`),
            'utf8'
        )
    );
    assert.equal(
        project.targets['check-socle'].options.command,
        `node ${SIGNATURE_FILES.support}/check-socle.mjs --app ${APP}`
    );
});

test('reprises PERMISES sur un produit périmé (V3.2) : publication interrompue', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const options = publication(product, {
        [product.notice]: 'export const notice = 1;\n',
    });
    await interruptAt(product, options);
    await touch(product.root, `${BASE}/backend.json`);
    const result = await recoverApplicationPublication(product.base);
    assert.equal(result.recovered, true);
    // Le produit reste périmé : un consommateur reste refusé.
    await assert.rejects(
        planApplicationPublication(options),
        STALE('contract', `${BASE}/backend.json`)
    );
});

test('N5 bis : source retouchée pendant la transaction d’une publication → publication inputs changed, produit inchangé', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const options = publication(product, {
        [product.notice]: 'export const notice = 1;\n',
    });
    const plan = await planApplicationPublication(options);
    const contract = join(product.root, `${BASE}/backend.json`);
    const original = await readFile(contract);
    const before = await snapshotTree(product.root, [
        'node_modules',
        BASE.split('/')[0],
    ]);
    await assert.rejects(
        publishApplicationPublication(
            { ...options, expectedPlanId: plan.plan_id },
            {
                run: () => undefined,
                phase: async (name) => {
                    if (name === 'candidate-staged')
                        await writeFile(
                            contract,
                            Buffer.concat([original, Buffer.from('\n')])
                        );
                },
            }
        ),
        /publication inputs changed/
    );
    assert.deepEqual(
        await snapshotTree(product.root, ['node_modules', BASE.split('/')[0]]),
        before
    );
});

test('N5 bis : source d’une AUTRE appli retouchée pendant la création → shell inputs changed, rien de créé', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const input = await writeExternalDesign(product.root);
    const options = {
        workspaceRoot: TOOLS_ROOT,
        targetRoot: product.root,
        designPath: input.designPath,
        experienceId: input.experienceId,
        appName: 'native-angular',
        profile: 'angular-pwa',
        applicationDesignSchema: input.applicationDesignSchema,
        backendContractSchema: input.backendContractSchema,
    };
    const plan = await planExternalApplicationShell(options);
    const contract = join(product.root, `${BASE}/backend.json`);
    await assert.rejects(
        publishExternalApplicationShell(
            { ...options, expectedPlanId: plan.plan_id },
            {
                run: () => undefined,
                phase: async (name) => {
                    if (name === 'candidate-staged')
                        await writeFile(
                            contract,
                            (await readFile(contract, 'utf8')) + '\n'
                        );
                },
            }
        ),
        /shell inputs changed/
    );
    await assert.rejects(
        readFile(join(product.root, appManifestPath('native-angular'))),
        { code: 'ENOENT' }
    );
});

test('le manifeste porte `sources` de même forme dans les deux modes (V3.5 f)', async (t) => {
    // Interne : banc à une racine ; la conception déclare ses empreintes.
    const root = await fixtureParent(t);
    await mkdir(join(root, 'apps'));
    await mkdir(join(root, 'designs'));
    const loaded = await schemas();
    const data = await writeApplicationDesignFixture(
        root,
        loaded.backendContractSchema
    );
    await writeFile(
        join(root, 'designs/sample.json'),
        `${JSON.stringify(withProductPrefix(data.design), null, 2)}\n`
    );
    const internal = JSON.parse(
        (
            await planApplicationShell({
                workspaceRoot: root,
                designPath: 'designs/sample.json',
                experienceId: 'citizen-web',
                appName: 'sample-app',
                profile: 'angular-pwa',
                ...loaded,
            })
        ).files[SIGNATURE_FILES.appManifest]
    );
    // Extérieur : la même conception, sans empreinte de contrat.
    const fixture = await shellFixture(t);
    const plan = await planExternalApplicationShell(fixture.shell);
    const external = JSON.parse(
        plan.files[appManifestPath(fixture.shell.appName)]
    );
    const shape = (manifest) => ({
        keys: Object.keys(manifest).filter((key) => key !== 'ownership'),
        sources: manifest.sources.map((entry) => [
            entry.genre,
            Object.keys(entry),
        ]),
        design: manifest.sources.some(
            (entry) =>
                entry.genre === 'design' &&
                entry.path === manifest.design_ref.path &&
                entry.sha256 === manifest.design_ref.sha256
        ),
    });
    assert.deepEqual(shape(external), shape(internal));
    assert.equal(shape(internal).design, true);
    // Seule l'ORIGINE de l'empreinte du contrat diffère : déclarée en interne.
    const contract = (manifest) =>
        manifest.sources.find(
            (entry) =>
                entry.genre === 'contract' &&
                entry.path.endsWith('backend.contract.json')
        );
    assert.equal(
        contract(internal).sha256,
        data.design.backend_contracts[0].sha256
    );
    assert.equal(
        contract(external).sha256,
        sha256(await readFile(join(fixture.root, contract(external).path)))
    );
});

// Image d'un arrêt brutal (forme de product-prefix-rename-recovery.test.mjs) :
// le produit et ses voisins de même préfixe, sans verrous.
const ownName = (name) => name === 'product' || name.startsWith('.product.');
async function takeImage(product, image) {
    await rm(image, { recursive: true, force: true });
    for (const name of await readdir(product.parent))
        if (ownName(name) && !name.endsWith('.generation-lock'))
            await cp(join(product.parent, name), join(image, name), {
                recursive: true,
                filter: (source) =>
                    !basename(source).endsWith('.generation-lock'),
            });
}
async function restoreImage(product, image) {
    for (const name of await readdir(product.parent))
        if (ownName(name))
            await rm(join(product.parent, name), {
                recursive: true,
                force: true,
            });
    for (const name of await readdir(image))
        await cp(join(image, name), join(product.parent, name), {
            recursive: true,
        });
}

test('reprise du renommage PERMISE sur un produit périmé (V3.2)', async (t) => {
    const product = await renameProduct(t, undefined, { shells: false });
    const crash = join(await fixtureParent(t), 'crash');
    await assert.rejects(
        renameTo(product, 'qz', {
            phase: async (name) => {
                if (name !== 'staged') return;
                await takeImage(product, crash);
                throw new Error('arrêt simulé');
            },
        }),
        /arrêt simulé/
    );
    await restoreImage(product, crash);
    await touch(product.root, `${BASE}/backend.json`);
    const result = await recoverProductPrefixRename(product.base);
    assert.equal(result.direction, 'back');
    await assert.rejects(
        planApplicationWorkspace(product.options),
        STALE('contract', `${BASE}/backend.json`)
    );
});

// Revue de l'étape A, A-3 : le script par appli, exécuté comme sa cible
// (`node <sig>/support/check-socle.mjs --app <app>`), sur un produit dont les
// dépendances ne sont que des métadonnées (TypeScript absent) : usage refusé
// (64), écarts NOMMÉS sans pile ni chemin local, appli inconnue nommée.
test('check-socle.mjs exécuté : usage, espace invérifiable et appli inconnue nommés, sans pile ni chemin local', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const script = join(
        product.root,
        SIGNATURE_FILES.support,
        'check-socle.mjs'
    );
    const run = (...args) =>
        spawnSync(process.execPath, [script, ...args], {
            cwd: product.root,
            encoding: 'utf8',
            env: { PATH: '/usr/bin:/bin' },
            timeout: 60_000,
        });
    const usage = run();
    assert.equal(usage.status, 64);
    assert.equal(
        usage.stderr,
        `Usage : node ${SIGNATURE_FILES.support}/check-socle.mjs --app <app>\n`
    );
    const own = run('--app', APP);
    assert.equal(own.status, 1);
    assert.equal(own.stderr, 'Échec du contrat workspace.\n');
    const unknown = run('--app', 'inconnue');
    assert.equal(unknown.status, 1);
    assert.equal(
        unknown.stderr,
        'Échec du contrat workspace.\nÉchec du socle inconnue : lecture impossible.\n'
    );
    for (const result of [usage, own, unknown])
        assert.ok(!`${result.stdout}${result.stderr}`.includes(product.root));
});

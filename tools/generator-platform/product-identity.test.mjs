// Identité du produit (lot MARQUE, commit 2) : préfixe DÉCLARÉ, ou proposé
// par les initiales du nom du dépôt, scellé dans l'espace extérieur ; porté
// par la conception (1.2.0) pour un banc interne. Refus nommés : forme,
// préfixes réservés (catalogue de l'atelier, déclarations des renderers),
// préfixe changé hors de la commande dédiée, mode interne sans préfixe.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseArgs } from '../prepare-application-workspace.mjs';
import {
    planApplicationShell,
    publicApplicationShellPlan,
} from './core/application-shell-publication.mjs';
import {
    planApplicationWorkspace,
    planExternalApplicationShell,
    publicApplicationWorkspacePlan,
    publishApplicationWorkspace,
} from './core/application-workspace.mjs';
import { planApplicationDesignPublication } from './core/application-design-publication.mjs';
import { SIGNATURE_FILES } from './core/atelier-signature.mjs';
import { pathExists } from './core/external-application-paths.mjs';
import {
    assertReservedDeclarations,
    prefixInitials,
    PRODUCT_NAME_FAMILIES,
    productNameForms,
    prefixRefusals,
    productForms,
} from './core/product-identity.mjs';
import {
    prefixContext,
    RESERVED_PREFIX_DECLARATIONS,
} from './core/product-prefix.mjs';
import { sampleCommandInput } from './renderers/angular-page-composition-api.mjs';
import { renderAngularPwaShell } from './renderers/angular-pwa-shell-renderer.mjs';
import { renderReactSpaShell } from './renderers/react-spa-shell-renderer.mjs';
import {
    applicationDesign,
    FIXTURE_PREFIX,
    withProductPrefix,
    writeApplicationDesignFixture,
} from './test-support/application-design-fixture.mjs';
import {
    createApplicationSessionFixture,
    SESSION_FIXTURE_DOMAINS,
} from './test-support/application-session-fixture.mjs';
import {
    compileDocumentFixture,
    documentFixture,
} from './test-support/external-document-fixture.mjs';
import {
    fixtureParent,
    schemas,
    shellFixture,
    snapshotTree,
    TOOLS_ROOT,
    workspaceOptions,
} from './test-support/external-application-fixture.mjs';

const INVALID = ['q', 'abcdefg', 'Qz', 'q-z', '1q', '', undefined, 7];

test('formes du préfixe : une seule source, motif fermé', () => {
    const forms = productForms('qz');
    assert.deepEqual(forms, {
        prefix: 'qz',
        scope: '@qz',
        kebab: 'qz-',
        snake: 'qz_',
        env: 'QZ_',
        global: '__qz',
        nginxDir: '/etc/nginx/qz/',
    });
    assert.ok(Object.isFrozen(forms));
    assert.deepEqual(productForms('abcdef').prefix, 'abcdef');
    for (const bad of INVALID) {
        assert.throws(
            () => productForms(bad),
            /^Error: product identity: invalid prefix/,
            String(bad)
        );
        const reasons = prefixRefusals(bad);
        assert.equal(reasons.length, 1, String(bad));
        assert.match(reasons[0], /^préfixe invalide /);
    }
});

test('initiales : partie après « / », mots séparés par -, _ ou ., 6 lettres au plus', () => {
    for (const [name, expected] of [
        ['native-shells', 'ns'],
        ['equipment-hire', 'eh'],
        ['Equipment-Hire', 'eh'],
        ['my_great.product-app', 'mgpa'],
        ['observatory', 'observ'],
        ['a-b-c-d-e-f-g', 'abcdef'],
        // Proposés mais invalides : jamais complétés, refusés plus loin.
        ['x', 'x'],
        ['9-lives', '9l'],
        ['', ''],
    ])
        assert.equal(prefixInitials(name), expected, name);
});

test('préfixes réservés : portées du catalogue et déclarations des renderers, chacune nommée', async () => {
    const context = await prefixContext(TOOLS_ROOT);
    assert.deepEqual(
        RESERVED_PREFIX_DECLARATIONS.map(({ prefix }) => prefix),
        ['nginx', 'http', 'arg', 'cookie', 'ng', 'node']
    );
    for (const declaration of RESERVED_PREFIX_DECLARATIONS) {
        const reasons = prefixRefusals(declaration.prefix, context);
        assert.equal(reasons.length, 1, declaration.prefix);
        assert.ok(reasons[0].includes(declaration.variable), reasons[0]);
    }
    // Portée npm du catalogue de l'atelier (`@nx/…`).
    assert.ok(context.scopes.includes('nx'));
    assert.deepEqual(prefixRefusals('nx', context), [
        "préfixe réservé nx : portée npm @nx du catalogue de l'atelier",
    ]);
    for (const accepted of [FIXTURE_PREFIX, 'qz', 'abcdef'])
        assert.deepEqual(prefixRefusals(accepted, context), [], accepted);
    // Une déclaration sans variable nommée est refusée : la liste reste
    // falsifiable.
    for (const declaration of [
        { prefix: 'zz', mechanism: 'collision' },
        { prefix: 'zz', mechanism: 'collision', variable: ' ' },
        { prefix: 'zz', mechanism: '', variable: 'ZZ_X' },
        { prefix: 'Z', mechanism: 'collision', variable: 'ZZ_X' },
    ])
        assert.throws(
            () => assertReservedDeclarations([declaration]),
            /reserved prefix declaration without a named variable/
        );
});

test('espace : préfixe proposé par les initiales du dépôt, même plan à l’--apply sans --prefix, puis scellé', async (t) => {
    const parent = await fixtureParent(t);
    const options = workspaceOptions(join(parent, 'product'));
    const proposed = await planApplicationWorkspace(options);
    assert.deepEqual(proposed.identity, {
        prefix: FIXTURE_PREFIX,
        provenance: 'proposé : initiales de native-shells',
    });
    assert.deepEqual(
        publicApplicationWorkspacePlan(proposed).identity,
        proposed.identity
    );
    assert.deepEqual(proposed.manifest.identity, { prefix: FIXTURE_PREFIX });
    assert.equal(proposed.manifest.schema_version, '1.1.0');
    // Déclarer le préfixe proposé donne le même plan : seule la provenance
    // affichée change.
    const declared = await planApplicationWorkspace({
        ...options,
        prefix: FIXTURE_PREFIX,
    });
    assert.equal(declared.identity.provenance, 'déclaré');
    assert.equal(declared.plan_id, proposed.plan_id);
    assert.equal(
        declared.manifest.workspace_id,
        proposed.manifest.workspace_id
    );
    // Un autre préfixe change l'identité de l'espace, donc le plan.
    const other = await planApplicationWorkspace({ ...options, prefix: 'qz' });
    assert.notEqual(other.plan_id, proposed.plan_id);
    assert.notEqual(
        other.manifest.workspace_id,
        proposed.manifest.workspace_id
    );
    const before = await snapshotTree(parent);
    await assert.rejects(
        publishApplicationWorkspace({
            ...options,
            expectedPlanId: other.plan_id,
        }),
        /reviewed workspace plan required or stale/
    );
    assert.deepEqual(await snapshotTree(parent), before);
    // `--apply` sans `--prefix` : les initiales sont recalculées à
    // l'identique, le plan revu tombe juste.
    assert.equal(
        (
            await publishApplicationWorkspace({
                ...options,
                expectedPlanId: proposed.plan_id,
            })
        ).status,
        'prepared'
    );
    const manifest = JSON.parse(
        await readFile(
            join(options.targetRoot, SIGNATURE_FILES.workspaceManifest),
            'utf8'
        )
    );
    assert.deepEqual(manifest.identity, { prefix: FIXTURE_PREFIX });
    // Scellé : un autre préfixe est refusé, le même ou aucun est accepté.
    const prepared = await snapshotTree(parent);
    await assert.rejects(
        planApplicationWorkspace({ ...options, prefix: 'qz' }),
        /PRODUCT_PREFIX_SEALED: change it with rename-product-prefix/
    );
    assert.deepEqual(await snapshotTree(parent), prepared);
    for (const prefix of [FIXTURE_PREFIX, undefined]) {
        const again = await planApplicationWorkspace({ ...options, prefix });
        assert.deepEqual(again.identity, {
            prefix: FIXTURE_PREFIX,
            provenance: 'scellé dans l’espace',
        });
        assert.equal(again.manifest.workspace_id, manifest.workspace_id);
    }
});

test('espace : préfixe déclaré invalide ou réservé, proposé refusé : refus nommé, rien écrit', async (t) => {
    const parent = await fixtureParent(t);
    const options = workspaceOptions(join(parent, 'product'));
    const before = await snapshotTree(parent);
    for (const bad of ['q', 'abcdefg', 'Qz', '1q', 'nginx', 'http', 'nx'])
        await assert.rejects(
            planApplicationWorkspace({ ...options, prefix: bad }),
            /external application: --prefix refused: préfixe (invalide|réservé) /,
            bad
        );
    for (const [repository, proposed] of [
        ['fixture-laboratory/x', 'x'],
        ['fixture-laboratory/9-lives', '9l'],
        ['fixture-laboratory/nginx', 'nginx'],
    ]) {
        const refused = { ...options, githubRepository: repository };
        await assert.rejects(
            planApplicationWorkspace(refused),
            new RegExp(
                `proposed prefix "${proposed}" \\(initials of "${repository.split('/')[1]}"\\) refused: .* ; déclarer --prefix$`
            ),
            repository
        );
        // Déclaré, le même dépôt est accepté.
        assert.equal(
            (await planApplicationWorkspace({ ...refused, prefix: 'qz' }))
                .identity.prefix,
            'qz'
        );
    }
    assert.deepEqual(await snapshotTree(parent), before);
    assert.equal(await pathExists(options.targetRoot), false);
});

test('CLI : --prefix facultatif, unique, affiché au --dry-run', async (t) => {
    const base = [
        '--target-root',
        '/fixture/product',
        '--profiles',
        'angular-pwa',
        '--github-repository',
        'fixture/repository',
        '--review-owner',
        'reviewer',
    ];
    assert.equal(parseArgs([...base, '--dry-run']).prefix, undefined);
    assert.equal(
        parseArgs([...base, '--prefix', 'qz', '--dry-run']).prefix,
        'qz'
    );
    for (const [bad, refusal] of [
        [
            [...base, '--prefix', 'qz', '--prefix', 'qx', '--dry-run'],
            /^Error: Une option ne peut pas être répétée\.$/,
        ],
        [
            [...base, '--prefix', '--dry-run'],
            /^Error: Valeur d’option requise\.$/,
        ],
        [
            [...base, '--dry-run', '--prefix'],
            /^Error: Valeur d’option requise\.$/,
        ],
    ])
        assert.throws(() => parseArgs(bad), refusal, bad.join(' '));
    const parent = await fixtureParent(t);
    const options = workspaceOptions(join(parent, 'product'));
    const cli = (prefix) =>
        spawnSync(
            process.execPath,
            [
                join(TOOLS_ROOT, 'tools/prepare-application-workspace.mjs'),
                '--target-root',
                options.targetRoot,
                '--profiles',
                options.profiles.join(','),
                '--github-repository',
                options.githubRepository,
                '--review-owner',
                options.reviewOwner,
                '--prefix',
                prefix,
                '--dry-run',
            ],
            {
                cwd: parent,
                encoding: 'utf8',
                env: { HOME: parent, PATH: '/usr/bin:/bin' },
            }
        );
    const accepted = cli('qz');
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(accepted.stdout).identity, {
        prefix: 'qz',
        provenance: 'déclaré',
    });
    const refused = cli('Q');
    assert.equal(refused.status, 1);
    assert.match(
        refused.stderr,
        /^external application: --prefix refused: préfixe invalide "Q"/
    );
    assert.equal(await pathExists(options.targetRoot), false);
});

test('produit extérieur : le préfixe n’a qu’une source, l’espace ; une conception qui le déclare est refusée', async (t) => {
    const fixture = await shellFixture(t);
    // Sans déclaration : accepté, rendu au préfixe scellé, affiché au
    // `--dry-run` avec sa provenance.
    const sealed = await planExternalApplicationShell(fixture.shell);
    assert.ok(
        Object.values(sealed.files)
            .join('\n')
            .includes(`window.__${FIXTURE_PREFIX}AppAccessContext`)
    );
    assert.deepEqual(publicApplicationShellPlan(sealed).identity, {
        prefix: FIXTURE_PREFIX,
        provenance: 'scellé dans l’espace',
    });
    // Déclaration du MÊME préfixe ou d'un autre : refus nommé, rien écrit.
    const declaring = async (prefix, name) => {
        const designPath = `descriptions/${name}.application-design.json`;
        await writeFile(
            join(fixture.root, designPath),
            `${JSON.stringify(withProductPrefix(fixture.input.design, prefix), null, 2)}\n`,
            { flag: 'wx' }
        );
        return { ...fixture.shell, designPath };
    };
    const same = await declaring(FIXTURE_PREFIX, 'same-prefix');
    const other = await declaring('qz', 'other-prefix');
    const before = await snapshotTree(fixture.root);
    for (const options of [same, other])
        await assert.rejects(
            planExternalApplicationShell(options),
            /PRODUCT_PREFIX_IN_DESIGN: an external product design must not declare identity\.prefix; the prefix is sealed in the workspace/,
            options.designPath
        );
    assert.deepEqual(await snapshotTree(fixture.root), before);
});

test('produit extérieur : la compilation d’une conception qui déclare identity.prefix est refusée, même refus nommé', async (t) => {
    const fixture = await documentFixture(t, 'A');
    await compileDocumentFixture(fixture);
    // Conception 1.2.0 qui porte le préfixe scellé, compilée dans le produit.
    const sourcePath = `${fixture.prefix}/design-source-declaring.json`;
    await writeFile(
        join(fixture.root, sourcePath),
        `${JSON.stringify(withProductPrefix(fixture.design, FIXTURE_PREFIX), null, 2)}\n`,
        { flag: 'wx' }
    );
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
        planApplicationDesignPublication({
            workspaceRoot: TOOLS_ROOT,
            targetRoot: fixture.root,
            sourcePath,
            outputPath: `${fixture.prefix}/application-design-declaring.json`,
            applicationDesignSchema: fixture.applicationDesignSchema,
            backendContractSchema: fixture.backendContractSchema,
        }),
        /PRODUCT_PREFIX_IN_DESIGN: an external product design must not declare identity\.prefix; the prefix is sealed in the workspace/
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
    // La même source, sans la déclaration, se compile toujours.
    const plain = `${fixture.prefix}/design-source-plain.json`;
    await writeFile(
        join(fixture.root, plain),
        `${JSON.stringify(fixture.design, null, 2)}\n`,
        { flag: 'wx' }
    );
    const plan = await planApplicationDesignPublication({
        workspaceRoot: TOOLS_ROOT,
        targetRoot: fixture.root,
        sourcePath: plain,
        outputPath: `${fixture.prefix}/application-design-plain.json`,
        applicationDesignSchema: fixture.applicationDesignSchema,
        backendContractSchema: fixture.backendContractSchema,
    });
    assert.match(plan.plan_id, /^[a-f0-9]{64}$/);
});

test('banc interne : préfixe obligatoire dans la conception 1.2.0, réservés refusés, schéma fermé', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'product-identity-internal-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'apps'));
    await mkdir(join(root, 'designs'));
    const loaded = await schemas();
    const data = await writeApplicationDesignFixture(
        root,
        loaded.backendContractSchema
    );
    const designPath = 'designs/sample-app.application-design.json';
    const plan = async (design) => {
        await writeFile(
            join(root, designPath),
            `${JSON.stringify(design, null, 2)}\n`
        );
        return planApplicationShell({
            workspaceRoot: root,
            designPath,
            experienceId: 'citizen-web',
            appName: 'sample-app',
            profile: 'angular-pwa',
            ...loaded,
        });
    };
    const carrying = (schemaVersion, prefix) => ({
        ...data.design,
        schema_version: schemaVersion,
        design: { ...data.design.design, identity: { prefix } },
    });
    for (const [design, refusal] of [
        [
            data.design,
            /internal mode requires design\.identity\.prefix \(application design 1\.2\.0\)/,
        ],
        [
            withProductPrefix(data.design, 'nginx'),
            /design\.identity\.prefix refused: préfixe réservé nginx : .*NGINX_ENVSUBST_FILTER/,
        ],
        [
            withProductPrefix(data.design, 'types'),
            /design\.identity\.prefix refused: préfixe réservé types : portée npm @types/,
        ],
        // `nx` est déjà refusé par la neutralité de la conception, avant le
        // préfixe : un nom de cible n'y entre pas.
        [
            withProductPrefix(data.design, 'nx'),
            /design rejected:\n\$: target-specific token forbidden/,
        ],
        // Le champ n'existe qu'en 1.2.0 ; sa forme est fermée par le schéma.
        [carrying('1.0.0', FIXTURE_PREFIX), /design rejected/],
        [carrying('1.1.0', FIXTURE_PREFIX), /design rejected/],
        [withProductPrefix(data.design, 'Ns'), /design rejected/],
        [withProductPrefix(data.design, 'abcdefg'), /design rejected/],
    ])
        await assert.rejects(
            plan(design),
            refusal,
            JSON.stringify(design.design.identity)
        );
    const accepted = await plan(withProductPrefix(data.design));
    assert.ok(
        accepted.files['src/app/access.guard.ts'].includes(
            `window.__${FIXTURE_PREFIX}AppAccessContext`
        )
    );
    assert.deepEqual(publicApplicationShellPlan(accepted).identity, {
        prefix: FIXTURE_PREFIX,
        provenance: 'déclaré dans la conception',
    });
    assert.equal(await pathExists(join(root, 'apps/sample-app')), false);
});

// Chaque nom que le produit possède porte son préfixe, et seulement lui : le
// rendu au préfixe `qz`, où `qz` est remplacé par `qx`, est le rendu au
// préfixe `qx`, à l'octet (le manifeste, qui porte les empreintes, est
// comparé par ses chemins).
test('valeurs d’exemple : un courriel trop long est tronqué sur sa partie locale, domaine intact', () => {
    const model = (constraints) => ({
        actions: [
            {
                port: {
                    input: {
                        kind: 'object',
                        fields: [
                            {
                                name: 'courriel',
                                validations: [
                                    { kind: 'format', format: 'email' },
                                ],
                                constraints,
                            },
                            {
                                name: 'reference',
                                validations: [],
                                constraints,
                            },
                        ],
                    },
                },
            },
        ],
    });
    const sample = (prefix, constraints) =>
        sampleCommandInput(model(constraints), prefix);
    // Préfixe de 6, `max_length` 16 : exemple valide, sous la borne.
    const long = sample('abcdef', { max_length: 16 });
    assert.equal(long.courriel, 'abc@exemple.test');
    assert.ok(long.courriel.length <= 16);
    assert.match(long.courriel, /^[a-z0-9]+@exemple\.test$/);
    assert.equal(long.reference, 'abcdef-contrat');
    // Préfixe de 3 et `max_length` ≥ 16 : octets inchangés.
    for (const constraints of [{}, { max_length: 16 }, { max_length: 40 }])
        assert.equal(
            sample('abc', constraints).courriel,
            'abc@exemple.test',
            JSON.stringify(constraints)
        );
    // Au moins un caractère local ; le domaine n'est jamais coupé.
    assert.equal(sample('abc', { max_length: 15 }).courriel, 'ab@exemple.test');
    assert.equal(sample('abc', { max_length: 5 }).courriel, 'a@exemple.test');
});

// Familles de noms que le produit possède : source unique dans
// product-identity.mjs (aussi lue par la contre-preuve du renommage).
const FAMILIES = PRODUCT_NAME_FAMILIES;
const SESSION_FAMILIES = Object.keys(FAMILIES).filter(
    (family) => family !== 'contexte d’accès du navigateur'
);

test('rendu : un seul préfixe, porté par chaque nom que le produit possède', async (t) => {
    const session = await createApplicationSessionFixture({
        domain: SESSION_FIXTURE_DOMAINS[0],
    });
    t.after(() => rm(session.root, { recursive: true, force: true }));
    const shell = applicationDesign('a'.repeat(64), 'b'.repeat(64));
    const spa = {
        ...shell,
        experiences: shell.experiences.map((experience) => ({
            ...experience,
            offline_policy: 'none',
        })),
    };
    const cases = [
        [
            'angular-session',
            renderAngularPwaShell,
            session.design,
            [
                'qz-sw',
                'qz-session-static-v1',
                'QZ_UPSTREAM_',
                'QZ_UPSTREAMS_VALIDATED',
                'QZ_ENVSUBST_FILTER_INVALID',
                'QZ_DEV_PROXY_FILE',
                '/etc/nginx/qz/',
                'deploy/nginx/docker-entrypoint.d/15-qz-upstreams.envsh',
                '$qz_cache_control',
                '$qz_relay_guard',
                'qz_check ',
            ],
            SESSION_FAMILIES,
        ],
        [
            'angular-shell',
            renderAngularPwaShell,
            shell,
            ['qz-sw', 'qz-shell-v1', 'window.__qzAppAccessContext'],
            [
                'politique du service worker',
                'caches du service worker',
                'contexte d’accès du navigateur',
            ],
        ],
        [
            'react-shell',
            renderReactSpaShell,
            spa,
            ['window.__qzAppAccessContext'],
            ['contexte d’accès du navigateur'],
        ],
    ];
    const swap = (text) => text.replaceAll('qz', 'qx').replaceAll('QZ', 'QX');
    for (const [name, render, design, owned, families] of cases) {
        const files = async (prefix) =>
            (
                await render({
                    design,
                    experienceId: design.experiences[0].id,
                    appName: 'prefix-flow',
                    designPath: 'design/prefix.json',
                    designSha256: 'c'.repeat(64),
                    externalWorkspace: true,
                    prefix,
                })
            ).files;
        const qz = await files('qz');
        const qx = await files('qx');
        const { [SIGNATURE_FILES.appManifest]: manifestQz, ...restQz } = qz;
        const { [SIGNATURE_FILES.appManifest]: manifestQx, ...restQx } = qx;
        assert.deepEqual(
            Object.fromEntries(
                Object.entries(restQz).map(([path, content]) => [
                    swap(path),
                    swap(content),
                ])
            ),
            restQx,
            name
        );
        const paths = (manifest) =>
            JSON.parse(manifest).generated_files.map(({ path }) => path);
        assert.deepEqual(paths(manifestQz).map(swap), paths(manifestQx), name);
        const all = Object.entries(qz)
            .map(([path, content]) => `${path}\n${content}`)
            .join('\n');
        for (const form of owned)
            assert.ok(all.includes(form), `${name} : ${form}`);
        // Chaque occurrence de chaque famille porte le préfixe déclaré, et
        // les familles de ce rendu y sont toutes.
        const forms = productNameForms(all);
        for (const family of Object.keys(FAMILIES)) {
            assert.deepEqual(
                [...(forms.get(family) ?? [])],
                families.includes(family) ? ['qz'] : [],
                `${name} : ${family}`
            );
        }
    }
});

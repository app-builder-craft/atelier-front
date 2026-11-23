// Lot MARQUE, commit 3 : refus nommés de `rename-product-prefix` (§ 6 et
// § 7.2), tous au `--dry-run` ou au plan revu, sans rien écrire : préfixe
// invalide ou réservé, sans changement, produit modifié à la main, plan
// périmé, publication qui dépend du préfixe, coque ou composition non
// reproductible par le générateur courant. Puis la ligne de commande, et le
// verrou du produit pris par la compilation d'un document (B).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
    computeOwnershipSeal,
    inventoryTreeSha,
} from './core/application-ownership.mjs';
import {
    planExternalApplicationShell,
    publishExternalApplicationShell,
} from './core/application-workspace.mjs';
import { sha256 } from './core/generation-manifest.mjs';
import { withProductWriterLocks } from './core/generation-transaction.mjs';
import { prefixContext } from './core/product-prefix.mjs';
import { planProductPrefixRename } from './core/product-prefix-rename.mjs';
import { publishProductPrefixRename } from './core/product-prefix-rename-transaction.mjs';
import {
    planStructuredBackendPublication,
    publishStructuredBackendContract,
} from './core/structured-backend-publication.mjs';
import { TOOLS_ROOT } from './test-support/external-application-fixture.mjs';
import { documentFixture } from './test-support/external-document-fixture.mjs';
import { publish } from './test-support/external-publication-fixture.mjs';
import {
    APP_MANIFEST,
    native,
    readManifest,
    renameOptions,
    renameProduct,
    SESSION_APP,
    snapshot,
} from './test-support/product-prefix-rename-fixture.mjs';

const NOTICE = 'src/app/generated/x1-proof/notice.ts';
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// Refus au plan, et rien d'écrit.
async function refused(product, to, pattern) {
    const untouched = await snapshot(product);
    await assert.rejects(
        planProductPrefixRename(renameOptions(product, to)),
        pattern,
        to
    );
    assert.deepEqual(await snapshot(product), untouched, to);
}

// Fichier d'appli réécrit et manifeste rescellé de façon COHÉRENTE : un
// inventaire valide, comme l'aurait laissé une autre version du générateur.
async function forge(product, appName, path, edit, { shell = false } = {}) {
    const root = join(product.apps, appName);
    const manifest = await readManifest(product, appName);
    const original = await readFile(join(root, path), 'utf8');
    const content = edit(original);
    await writeFile(join(root, path), content);
    const digest = {
        sha256: sha256(content),
        bytes: Buffer.byteLength(content),
    };
    const restore = json(manifest);
    for (const entry of manifest.generated_files)
        if (entry.path === path) Object.assign(entry, digest);
    manifest.tree_sha256 = inventoryTreeSha(manifest.generated_files);
    if (shell) manifest.ownership.shell_tree_sha256 = manifest.tree_sha256;
    for (const record of manifest.ownership.publications)
        for (const file of record.files)
            if (file.path === path) Object.assign(file, digest);
    manifest.ownership.seal_sha256 = computeOwnershipSeal(manifest);
    await writeFile(join(root, APP_MANIFEST), json(manifest));
    return async () => {
        await writeFile(join(root, path), original);
        await writeFile(join(root, APP_MANIFEST), restore);
    };
}

// Fichier AJOUTÉ à la dernière publication d'un outil, manifeste rescellé de
// façon cohérente (inventaire, arbre, sceau).
async function forgeAdded(product, appName, path, content, tool) {
    const root = join(product.apps, appName);
    const manifest = await readManifest(product, appName);
    const restore = json(manifest);
    const entry = {
        path,
        bytes: Buffer.byteLength(content),
        sha256: sha256(content),
    };
    await writeFile(join(root, path), content, { flag: 'wx' });
    manifest.generated_files = [...manifest.generated_files, entry].sort(
        (left, right) => left.path.localeCompare(right.path)
    );
    manifest.tree_sha256 = inventoryTreeSha(manifest.generated_files);
    const record = manifest.ownership.publications.findLast(
        (candidate) => candidate.tool === tool
    );
    record.files = [...record.files, { ...entry, change: 'added' }].sort(
        (left, right) => (left.path < right.path ? -1 : 1)
    );
    manifest.ownership.seal_sha256 = computeOwnershipSeal(manifest);
    await writeFile(join(root, APP_MANIFEST), json(manifest));
    return async () => {
        await rm(join(root, path));
        await writeFile(join(root, APP_MANIFEST), restore);
    };
}

function cli(script, args) {
    return spawnSync(
        process.execPath,
        [join(TOOLS_ROOT, 'tools', script), ...args],
        {
            cwd: TOOLS_ROOT,
            encoding: 'utf8',
            timeout: 120_000,
            env: {
                PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
                NO_COLOR: '1',
                NX_DAEMON: 'false',
            },
        }
    );
}

test('renommage du préfixe : refus nommés, rien écrit', async (t) => {
    const product = await renameProduct(t, undefined);
    const context = await prefixContext(TOOLS_ROOT);

    await t.test('préfixe invalide, réservé, ou sans changement', async () => {
        for (const to of ['q', 'abcdefg', 'Qz', '1z'])
            await refused(product, to, /--to refused: préfixe invalide/);
        // Réservés : dérivés des sources de l'atelier, pas d'une liste écrite
        // dans ce test.
        for (const to of [
            context.scopes[0],
            ...context.declarations.map(({ prefix }) => prefix),
        ])
            await refused(product, to, /--to refused: préfixe réservé/);
        await refused(product, 'ns', /rename without change/);
    });

    await t.test(
        'fichier possédé modifié à la main : refus au plan et au plan revu',
        async () => {
            const plan = await planProductPrefixRename(
                renameOptions(product, 'qz')
            );
            const path = join(product.apps, 'native-angular', 'src/main.ts');
            const original = await readFile(path, 'utf8');
            await appendFile(path, '// main\n');
            await refused(product, 'qz', /drift/);
            const untouched = await snapshot(product);
            await assert.rejects(
                publishProductPrefixRename(
                    {
                        ...renameOptions(product, 'qz'),
                        expectedPlanId: plan.plan_id,
                    },
                    native()
                ),
                /drift/
            );
            assert.deepEqual(await snapshot(product), untouched);
            await writeFile(path, original);
        }
    );

    await t.test(
        'composition non reproductible par le générateur courant',
        async () => {
            const manifest = await readManifest(product, SESSION_APP);
            const spec = manifest.generated_files.find((entry) =>
                entry.path.endsWith('page-composition.contract.spec.ts')
            ).path;
            // Spec réécrite et enregistrement de composition rescellé : un état
            // cohérent, comme l'aurait laissé une autre version du générateur.
            const restore = await forge(
                product,
                SESSION_APP,
                spec,
                (content) => `${content}// ancienne composition\n`
            );
            await refused(
                product,
                'qz',
                /PRODUCT_COMPOSITION_NOT_REPRODUCIBLE: app session-observatory composition is not reproducible by the current generator; republish it with generate:page-composition before renaming/
            );
            await restore();
            // Un fichier de plus dans l'enregistrement de composition, absent
            // du rendu courant : non reproductible lui aussi.
            const undo = await forgeAdded(
                product,
                SESSION_APP,
                `${dirname(spec)}/extra.ts`,
                'export const extra = 1;\n',
                'generate:page-composition'
            );
            await refused(
                product,
                'qz',
                /PRODUCT_COMPOSITION_NOT_REPRODUCIBLE: app session-observatory composition/
            );
            await undo();
        }
    );

    await t.test(
        'coque non reproductible par le générateur courant',
        async () => {
            const restore = await forge(
                product,
                'native-angular',
                'src/main.ts',
                (content) => `${content}// ancien générateur\n`,
                { shell: true }
            );
            await refused(
                product,
                'qz',
                /PRODUCT_SHELL_NOT_REPRODUCIBLE: app native-angular shell is not reproducible by the current generator \(src\/main\.ts\); regenerate the base before renaming \(lot 2\)/
            );
            await restore();
        }
    );

    await t.test(
        'ligne de commande : options fermées, --dry-run puis --expect-plan, aucun chemin local',
        async () => {
            for (const args of [
                [],
                ['--target-root', product.root],
                ['--target-root', product.root, '--to', 'qz'],
                [
                    '--target-root',
                    product.root,
                    '--to',
                    'qz',
                    '--dry-run',
                    '--expect-plan',
                    'a'.repeat(64),
                ],
                [
                    '--target-root',
                    product.root,
                    '--to',
                    'qz',
                    '--expect-plan',
                    'nope',
                ],
                [
                    '--target-root',
                    product.root,
                    '--to',
                    'qz',
                    '--dry-run',
                    '--force',
                ],
                [
                    '--target-root',
                    product.root,
                    '--to',
                    'qz',
                    '--to',
                    'rr',
                    '--dry-run',
                ],
            ]) {
                const result = cli('rename-product-prefix.mjs', args);
                assert.equal(result.status, 1, args.join(' '));
                assert.equal(result.stdout, '');
            }
            const dry = cli('rename-product-prefix.mjs', [
                '--target-root',
                product.root,
                '--to',
                'qz',
                '--dry-run',
            ]);
            assert.equal(dry.status, 0, dry.stderr);
            const plan = JSON.parse(dry.stdout);
            assert.match(plan.plan_id, /^[a-f0-9]{64}$/);
            assert.deepEqual(plan.prefix, { before: 'ns', after: 'qz' });
            assert.equal(dry.stdout.includes(product.root), false);
            assert.equal(dry.stdout.includes(TOOLS_ROOT), false);
            const stale = cli('rename-product-prefix.mjs', [
                '--target-root',
                product.root,
                '--to',
                'qz',
                '--expect-plan',
                'a'.repeat(64),
            ]);
            assert.equal(stale.status, 1);
            assert.match(stale.stderr, /reviewed rename plan is stale/);
            const recover = cli('recover-product-prefix.mjs', [
                '--target-root',
                product.root,
            ]);
            assert.equal(recover.status, 0, recover.stderr);
            assert.equal(
                JSON.parse(recover.stdout).status,
                'nothing-to-recover'
            );
            assert.equal(
                cli('recover-product-prefix.mjs', ['--target-root']).status,
                1
            );
        }
    );

    await t.test(
        'plan périmé : une appli change, ou une appli apparaît',
        async () => {
            for (const change of [
                () =>
                    publish({
                        ...product.app,
                        tool: 'generate:action-request',
                        files: { [NOTICE]: 'export const notice = 1;\n' },
                    }),
                async () => {
                    const shell = {
                        ...product.base,
                        designPath:
                            'descriptions/shells.application-design.json',
                        experienceId: 'citizen-web',
                        appName: 'late-app',
                        profile: 'react-spa',
                    };
                    const plan = await planExternalApplicationShell(shell);
                    await publishExternalApplicationShell(
                        { ...shell, expectedPlanId: plan.plan_id },
                        native()
                    );
                },
            ]) {
                const plan = await planProductPrefixRename(
                    renameOptions(product, 'qz')
                );
                await change();
                const untouched = await snapshot(product);
                await assert.rejects(
                    publishProductPrefixRename(
                        {
                            ...renameOptions(product, 'qz'),
                            expectedPlanId: plan.plan_id,
                        },
                        native()
                    ),
                    /reviewed rename plan is stale/
                );
                assert.deepEqual(await snapshot(product), untouched);
            }
        }
    );

    await t.test(
        'publication qui porte une forme de p, ou qui a réécrit un fichier dépendant du préfixe',
        async () => {
            await publish({
                ...product.app,
                tool: 'generate:action-request',
                files: { [NOTICE]: "export const policy = 'ns-sw';\n" },
            });
            await refused(
                product,
                'qz',
                /PRODUCT_PREFIX_REMAINS: app session-observatory path src\/app\/generated\/x1-proof\/notice\.ts written by generate:action-request keeps prefix ns \(politique du service worker\)/
            );
            await publish({
                ...product.app,
                tool: 'generate:action-request',
                files: { [NOTICE]: 'export const notice = 2;\n' },
            });
            const manifest = await readManifest(product, SESSION_APP);
            const spec = manifest.generated_files.find((entry) =>
                entry.path.endsWith('page-composition.contract.spec.ts')
            ).path;
            const content = await readFile(
                join(product.apps, SESSION_APP, spec),
                'utf8'
            );
            await publish({
                ...product.app,
                tool: 'generate:action-request',
                files: { [spec]: `${content}// réécrit\n` },
            });
            await refused(
                product,
                'qz',
                new RegExp(
                    `PRODUCT_PREFIX_IN_PUBLICATION: app session-observatory path ${spec.replaceAll('.', '\\.')} written by generate:action-request depends on the prefix`
                )
            );
        }
    );
});

test('B : la compilation d’un document dans un produit prend le verrou du produit', async (t) => {
    const fixture = await documentFixture(t, 'A');
    const options = {
        workspaceRoot: TOOLS_ROOT,
        targetRoot: fixture.root,
        backendContractSchema: fixture.backendContractSchema,
        ...fixture.backendRequests.at(-1),
    };
    const plan = await planStructuredBackendPublication(options);
    let release;
    const barrier = new Promise((done) => {
        release = done;
    });
    let entered;
    const started = new Promise((done) => {
        entered = done;
    });
    const holder = withProductWriterLocks(fixture.root, [], async () => {
        entered();
        await barrier;
    });
    await started;
    try {
        await assert.rejects(
            publishStructuredBackendContract({
                ...options,
                planId: plan.plan_id,
            }),
            /another generation owns/
        );
    } finally {
        release();
        await holder;
    }
    const published = await publishStructuredBackendContract({
        ...options,
        planId: plan.plan_id,
    });
    assert.equal(published.already_published, false);
});

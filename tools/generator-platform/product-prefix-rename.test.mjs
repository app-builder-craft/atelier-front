// Lot MARQUE, commit 3 : `rename-product-prefix` (voie R2), de bout en bout
// sur des produits fictifs. Preuve positive (un renommage égale une création
// directe), D.1 (deux renommages), D.2 (publier après), D.3 (annuler une
// publication après), D.5 (écrivains concurrents), contre-preuve dérivée et
// sortie du `--dry-run` (S6). Le runner injecté ne compile rien : la chaîne
// native est celle des publications (`check:external-application-shells`).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
    lastWriters,
    RENAME_TOOL,
    verifyApplicationOwnership,
} from './core/application-ownership.mjs';
import { recoverApplicationPublication } from './core/application-publication.mjs';
import {
    planApplicationWorkspace,
    planExternalApplicationShell,
    publishApplicationWorkspace,
    publishExternalApplicationShell,
    readOwnedWorkspace,
} from './core/application-workspace.mjs';
import { relayEnvshPath } from './core/external-application-paths.mjs';
import { planExternalPageComposition } from './core/external-page-composition.mjs';
import {
    PAGE_COMPOSITION_TOOL,
    pageCompositionRoot,
    publishingTool,
} from './core/external-publication-paths.mjs';
import { withProductWriterLocks } from './core/generation-transaction.mjs';
import { productNameForms } from './core/product-identity.mjs';
import {
    planProductPrefixRename,
    publicProductPrefixRenamePlan,
} from './core/product-prefix-rename.mjs';
import {
    publishProductPrefixRename,
    recoverProductPrefixRename,
} from './core/product-prefix-rename-transaction.mjs';
import { snapshotTree } from './test-support/external-application-fixture.mjs';
import {
    interruptAfterSwap,
    publish,
} from './test-support/external-publication-fixture.mjs';
import {
    APP_MANIFEST,
    assertRenamedEqualsCreated,
    native,
    readManifest,
    renameOptions,
    renameProduct,
    renameTo,
    SESSION_APP,
    snapshot,
    PRODUCT_APPS,
} from './test-support/product-prefix-rename-fixture.mjs';

const LOCKED = /another generation owns/;
const APPS = PRODUCT_APPS;
const NOTICE = 'src/app/generated/x1-proof/notice.ts';

// Familles portées par les fichiers possédés (hors manifestes d'appli) :
// famille → préfixes trouvés.
async function productFamilies(product) {
    const found = new Map();
    for (const [path, kind] of await snapshotTree(product.root)) {
        if (kind !== 'file' || path.endsWith(APP_MANIFEST)) continue;
        const content = await readFile(join(product.root, path), 'utf8');
        for (const [family, prefixes] of productNameForms(content))
            found.set(
                family,
                new Set([...(found.get(family) ?? []), ...prefixes])
            );
    }
    return found;
}

// Écarts d'une appli entre deux produits, manifeste d'appli exclu (il porte
// le sceau) : ce que le plan d'un renommage de l'un vers l'autre annonce.
async function treeChanges(from, to, appName) {
    const entries = async (product) =>
        new Map(
            (await snapshotTree(join(product.apps, appName)))
                .filter(
                    ([path, kind]) =>
                        kind !== 'directory' && path !== APP_MANIFEST
                )
                .map(([path, kind, value]) => [path, `${kind}:${value}`])
        );
    const left = await entries(from);
    const right = await entries(to);
    const changes = [];
    for (const [path, value] of left)
        if (!right.has(path)) changes.push({ path, change: 'removed' });
        else if (right.get(path) !== value)
            changes.push({ path, change: 'replaced' });
    for (const path of right.keys())
        if (!left.has(path)) changes.push({ path, change: 'added' });
    return changes.sort((x, y) => (x.path < y.path ? -1 : 1));
}

const compositionManifest = (product) =>
    `${pageCompositionRoot(product.page.pageId)}/generation-manifest.json`;

// Création d'une appli NOUVELLE dans le produit (conception des coques du
// produit fictif, déjà présente).
const lateApp = (product, appName = 'late-app') => ({
    ...product.base,
    designPath: 'descriptions/shells.application-design.json',
    experienceId: 'citizen-web',
    appName,
    profile: 'angular-pwa',
});

const notice = (product, value) => ({
    ...product.app,
    tool: 'generate:action-request',
    files: { [NOTICE]: `export const notice = ${value};\n` },
});

test('renommage du préfixe : égal à une création directe, deux fois, puis publications et écrivains concurrents', async (t) => {
    const a = await renameProduct(t, undefined);
    const b = await renameProduct(t, 'qz');
    const c = await renameProduct(t, 'rr');
    assert.deepEqual([a.prefix, b.prefix, c.prefix], ['ns', 'qz', 'rr']);
    const original = await readManifest(a, SESSION_APP);
    const familiesBefore = await productFamilies(a);

    await t.test(
        'D.5 : un écrivain tient le verrou du produit ; tous les autres sont refusés, rien écrit',
        async () => {
            const plan = await planProductPrefixRename(renameOptions(a, 'qz'));
            const shell = await planExternalApplicationShell(lateApp(a));
            const workspace = await planApplicationWorkspace(a.options);
            const untouched = await snapshot(a);
            let release;
            const barrier = new Promise((done) => {
                release = done;
            });
            let entered;
            const started = new Promise((done) => {
                entered = done;
            });
            const holder = withProductWriterLocks(a.root, [], async () => {
                entered();
                await barrier;
            });
            await started;
            try {
                const attempts = {
                    renommage: () =>
                        publishProductPrefixRename(
                            {
                                ...renameOptions(a, 'qz'),
                                expectedPlanId: plan.plan_id,
                            },
                            native()
                        ),
                    publication: () => publish(notice(a, 1)),
                    'reprise d’une publication': () =>
                        recoverApplicationPublication(a.app),
                    'reprise d’un renommage': () =>
                        recoverProductPrefixRename(a.base),
                    'création d’une appli nouvelle': () =>
                        publishExternalApplicationShell(
                            { ...lateApp(a), expectedPlanId: shell.plan_id },
                            native()
                        ),
                    'préparation de l’espace': () =>
                        publishApplicationWorkspace({
                            ...a.options,
                            expectedPlanId: workspace.plan_id,
                        }),
                };
                for (const [label, attempt] of Object.entries(attempts))
                    await assert.rejects(attempt(), LOCKED, label);
            } finally {
                release();
                await holder;
            }
            assert.deepEqual(await snapshot(a), untouched);
        }
    );

    await t.test(
        'preuve positive : ns → qz égale une création en qz ; S6 au --dry-run',
        async () => {
            // S2 / S7 au plan, avant toute écriture : chaque appli annonce
            // exactement les chemins où A, en ns, diffère de B, créé en qz.
            const reviewed = publicProductPrefixRenamePlan(
                await planProductPrefixRename(renameOptions(a, 'qz'))
            );
            assert.deepEqual(
                reviewed.apps.map(({ app_name }) => app_name).sort(),
                [...APPS]
            );
            for (const { app_name, changes } of reviewed.apps)
                assert.deepEqual(
                    changes,
                    await treeChanges(a, b, app_name),
                    `changements du plan de ${app_name}`
                );
            const seen = [];
            const { visible, result } = await renameTo(a, 'qz', {
                phase: async (name) => {
                    seen.push(name);
                    if (name !== 'locked') return;
                    // Ordre fixe : verrou du produit, puis de chaque appli.
                    const locks = (await snapshotTree(a.parent))
                        .map(([path]) => path)
                        .filter((path) => path.endsWith('.generation-lock'));
                    assert.deepEqual(locks.sort(), [
                        '.product.generation-lock',
                        ...APPS.map(
                            (app) => `product/apps/.${app}.generation-lock`
                        ),
                    ]);
                    // Second écrivain pendant le renommage : refusé.
                    await assert.rejects(publish(notice(a, 1)), LOCKED);
                    const shell = await planExternalApplicationShell(
                        lateApp(a)
                    );
                    await assert.rejects(
                        publishExternalApplicationShell(
                            { ...lateApp(a), expectedPlanId: shell.plan_id },
                            native()
                        ),
                        LOCKED
                    );
                },
            });
            assert.equal(result.status, 'renamed');
            assert.deepEqual(seen, [
                'locked',
                'prepared',
                ...APPS.map(() => 'candidate-staged'),
                'staged',
                'swapped',
                'switched',
                'derived',
                'verified',
            ]);
            await assertRenamedEqualsCreated(a, b);
            // Aucun artefact de transaction ne survit à côté du produit.
            assert.deepEqual(
                [
                    ...new Set(
                        (await snapshotTree(a.parent)).map(
                            ([path]) => path.split('/')[0]
                        )
                    ),
                ],
                ['product']
            );
            // S6 : table des variables service par service, filtre, dossier
            // nginx, script d'entrée renommé, caches orphelins.
            assert.deepEqual(visible.prefix, { before: 'ns', after: 'qz' });
            const session = visible.apps.find(
                (app) => app.app_name === SESSION_APP
            );
            assert.deepEqual(session.relay_entry_script, {
                before: relayEnvshPath('ns'),
                after: relayEnvshPath('qz'),
            });
            assert.ok(
                visible.operator_variables.some(({ before }) =>
                    before.startsWith('NS_UPSTREAM_')
                )
            );
            for (const { before, after } of visible.operator_variables)
                assert.equal(after, `QZ_${before.slice('NS_'.length)}`, before);
            assert.deepEqual(visible.envsubst_filter, {
                before: '^NS_',
                after: '^QZ_',
            });
            assert.deepEqual(visible.nginx_directory, {
                before: '/etc/nginx/ns/',
                after: '/etc/nginx/qz/',
            });
            assert.deepEqual(visible.orphaned_service_worker_caches, [
                {
                    name: 'ns-session-static-v1',
                    replaced_by: 'qz-session-static-v1',
                },
                { name: 'ns-shell-v1', replaced_by: 'qz-shell-v1' },
            ]);
            // P6 : l'auteur du manifeste de composition reste la composition ;
            // le dernier écrivain du sceau est le renommage.
            const renamed = await readManifest(a, SESSION_APP);
            assert.equal(
                publishingTool(renamed, compositionManifest(a)),
                PAGE_COMPOSITION_TOOL
            );
            assert.equal(
                lastWriters(renamed, renamed.ownership.workspace_id).get(
                    compositionManifest(a)
                ),
                RENAME_TOOL
            );
            // Contre-preuve dérivée : mêmes familles qu'avant, toutes en qz.
            const familiesAfter = await productFamilies(a);
            assert.deepEqual(
                [...familiesAfter.keys()].sort(),
                [...familiesBefore.keys()].sort()
            );
            for (const [family, prefixes] of familiesAfter)
                assert.deepEqual([...prefixes], ['qz'], family);
            for (const [family, prefixes] of familiesBefore)
                assert.deepEqual([...prefixes], ['ns'], family);
        }
    );

    await t.test(
        'D.1 : qz → rr égale une création en rr ; rejeu inverse à travers deux renommages',
        async () => {
            await renameTo(a, 'rr');
            await assertRenamedEqualsCreated(a, c);
            const manifest = await readManifest(a, SESSION_APP);
            const renames = manifest.ownership.publications.filter(
                (record) => record.tool === RENAME_TOOL
            );
            assert.deepEqual(
                renames.map((record) => [
                    record.prefix_before,
                    record.prefix_after,
                ]),
                [
                    ['ns', 'qz'],
                    ['qz', 'rr'],
                ]
            );
            const path = (record, kind) =>
                record.files.find((file) => file.change === kind)?.path;
            assert.equal(path(renames[0], 'added'), relayEnvshPath('qz'));
            assert.equal(path(renames[1], 'removed'), relayEnvshPath('qz'));
            // Le rejeu inverse redonne la coque créée en ns (sceau inchangé).
            assert.equal(
                manifest.ownership.shell_tree_sha256,
                original.ownership.shell_tree_sha256
            );
            verifyApplicationOwnership(
                manifest,
                manifest.ownership.workspace_id
            );
            await readOwnedWorkspace(a.base);
        }
    );

    await t.test(
        'D.2 : publier après le renommage, puis vérifier',
        async () => {
            // Le générateur de composition, en rr, rend exactement ce que le
            // renommage a écrit : rien à publier.
            await assert.rejects(
                planExternalPageComposition(a.page),
                /publication without change/
            );
            const manifest = await readManifest(a, SESSION_APP);
            const spec = manifest.generated_files.find((entry) =>
                entry.path.endsWith('page-composition.contract.spec.ts')
            ).path;
            assert.equal(
                lastWriters(manifest, manifest.ownership.workspace_id).get(
                    spec
                ),
                RENAME_TOOL
            );
            const content = await readFile(
                join(a.apps, SESSION_APP, spec),
                'utf8'
            );
            await publish({
                ...a.app,
                tool: PAGE_COMPOSITION_TOOL,
                files: { [spec]: `${content}// v2\n` },
            });
            const after = await readManifest(a, SESSION_APP);
            assert.equal(
                lastWriters(after, after.ownership.workspace_id).get(spec),
                PAGE_COMPOSITION_TOOL
            );
            // Vérifié (rejeu inverse jusqu'à la coque en ns) par le sceau.
            verifyApplicationOwnership(after, after.ownership.workspace_id);
            assert.equal(
                after.ownership.shell_tree_sha256,
                original.ownership.shell_tree_sha256
            );
            await readOwnedWorkspace(a.base);
        }
    );

    await t.test(
        'D.3 : annuler une publication après le renommage revient à « renommé, non publié »',
        async () => {
            const renamed = await snapshot(a);
            const manifest = await readFile(
                join(a.apps, SESSION_APP, APP_MANIFEST),
                'utf8'
            );
            await interruptAfterSwap(
                { ...a, app: join(a.apps, SESSION_APP) },
                notice(a, 2)
            );
            await assert.rejects(
                readOwnedWorkspace(a.base),
                /interrupted publication/
            );
            await recoverApplicationPublication(a.app);
            assert.deepEqual(await snapshot(a), renamed);
            assert.equal(
                await readFile(join(a.apps, SESSION_APP, APP_MANIFEST), 'utf8'),
                manifest
            );
            await readOwnedWorkspace(a.base);
        }
    );

    await t.test(
        'après le renommage, une appli nouvelle naît liée au nouvel espace',
        async () => {
            const plan = await planExternalApplicationShell(lateApp(a));
            assert.equal(plan.identity.prefix, 'rr');
            await publishExternalApplicationShell(
                { ...lateApp(a), expectedPlanId: plan.plan_id },
                native()
            );
            const workspace = await readOwnedWorkspace(a.base);
            assert.equal(
                (await readManifest(a, 'late-app')).ownership.workspace_id,
                workspace.manifest.workspace_id
            );
        }
    );
});

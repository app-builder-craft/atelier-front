// X1 (ADR-0103) : inventaire d'application scellé et publications sous plan.
// Le runner injecté ne compile rien : la chaîne native est prouvée par
// check:external-application-shells. Lot 2 (conception v5, V5.1, V5.2,
// C-B3) : une publication écrit le manifeste dans la coque et ses sorties
// dans le SOCLE ; sa transaction porte sur ces deux racines, avec un journal
// à côté du produit ; l'inventaire est relatif au produit.
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { planApplicationShell } from './core/application-shell-publication.mjs';
import { planExternalApplicationShell } from './core/application-workspace.mjs';
import {
    computeOwnershipSeal,
    inventoryTreeSha,
    verifyApplicationOwnership,
} from './core/application-ownership.mjs';
import {
    planApplicationPublication,
    publishApplicationPublication,
    recoverApplicationPublication,
} from './core/application-publication.mjs';
import { transactionJournalRoot } from './core/application-transaction.mjs';
import { pathExists } from './core/external-application-paths.mjs';
import { sha256 } from './core/generation-manifest.mjs';
import { renameAndSync } from './core/generation-transaction.mjs';
import {
    schemas,
    snapshotTree,
    TOOLS_ROOT,
} from './test-support/external-application-fixture.mjs';
import { SESSION_FIXTURE_DOMAINS } from './test-support/external-session-fixture.mjs';
import {
    interruptAfterSwap,
    interruptAt,
    publication,
    publish,
    readManifest,
    sessionApp,
} from './test-support/external-publication-fixture.mjs';
import { SIGNATURE_FILES } from './core/atelier-signature.mjs';

// Un octet change, la longueur reste identique (constat V8-R2).
function sameLength(bytes) {
    const copy = Buffer.from(bytes);
    copy[copy.lastIndexOf('}')] = 0x5d;
    assert.equal(copy.length, bytes.length);
    assert.notDeepEqual(copy, bytes);
    return copy;
}

const replacedPage = (title) =>
    `export const X1_PAGE = ${JSON.stringify(title)};\n`;

// Racines du produit d'une appli et arbres de travail visibles.
const socle = (product) => `libs/${product.shell.appName}-socle`;
const coque = (product) => `apps/${product.shell.appName}`;
async function workingTrees(product) {
    const found = [];
    for (const space of ['apps', 'libs'])
        for (const name of await readdir(join(product.root, space)))
            if (name.startsWith('.')) found.push(`${space}/${name}`);
    for (const name of await readdir(product.parent))
        if (name.startsWith('.product.')) found.push(name);
    return found.sort();
}
const writeProduct = async (product, path, content) => {
    await mkdir(dirname(join(product.root, path)), { recursive: true });
    await writeFile(join(product.root, path), content);
};
const readProduct = (product, path) =>
    readFile(join(product.root, path), 'utf8');

test('X1 : create-app --target-root scelle le manifeste d’application au produit', async (t) => {
    for (const domain of SESSION_FIXTURE_DOMAINS) {
        const product = await sessionApp(t, domain);
        const manifest = await readManifest(product);
        assert.equal(manifest.ownership.workspace_id, product.workspaceId);
        assert.equal(
            manifest.ownership.shell_tree_sha256,
            manifest.tree_sha256
        );
        assert.deepEqual(manifest.ownership.publications, []);
        assert.equal(
            manifest.ownership.seal_sha256,
            computeOwnershipSeal(manifest)
        );
        verifyApplicationOwnership(manifest, product.workspaceId);
        // Lot 2 : l'inventaire porte sur les trois racines, relatif au produit.
        for (const root of [
            coque(product),
            socle(product),
            `libs/${product.shell.appName}-interface`,
        ])
            assert.ok(
                manifest.generated_files.some((entry) =>
                    entry.path.startsWith(`${root}/`)
                ),
                root
            );
    }
});

test('X1 : ajout et remplacement déclarés acceptés, sous plan, sur deux produits fictifs', async (t) => {
    for (const domain of SESSION_FIXTURE_DOMAINS) {
        const product = await sessionApp(t, domain);
        const workshopBefore = await snapshotTree(TOOLS_ROOT);
        const options = publication(product, {
            [product.notice]: `export const X1_NOTICE = '${domain}';\n`,
            [product.page]: replacedPage(domain),
        });
        const { plan, result, labels } = await publish(options);
        assert.equal(result.recovered, false);
        const app = product.shell.appName;
        // Candidat du socle compilé seul, puis la liste unique des contrôles
        // (C-B2 : lint AVANT la construction, test du socle).
        assert.deepEqual(labels, [
            'native-compiler',
            `${app}:lint`,
            `${app}-socle:lint`,
            `${app}-interface:lint`,
            `${app}:build:production`,
            `${app}-socle:test`,
            'workspace-contract',
        ]);
        assert.deepEqual(
            plan.changes.map(({ path, change }) => [path, change]),
            [
                [product.notice, 'added'],
                [product.page, 'replaced'],
            ].sort(([left], [right]) => (left < right ? -1 : 1))
        );
        const manifest = await readManifest(product);
        const [record] = manifest.ownership.publications;
        assert.equal(record.plan_id, plan.plan_id);
        assert.equal(record.tool, 'generate:action-request');
        // V5.4 : le module de page vide rendu par la coque est remplacé, avec
        // son empreinte d'avant.
        const replaced = record.files.find(
            (file) => file.change === 'replaced'
        );
        assert.equal(replaced.before.sha256, sha256('export {};\n'));
        assert.equal(
            replaced.before.sha256,
            sha256(plan.previousFiles[product.page])
        );
        assert.equal(
            await readProduct(product, product.notice),
            `export const X1_NOTICE = '${domain}';\n`
        );
        assert.deepEqual(await workingTrees(product), [], 'Aucun reste');
        // L'état publié reste vérifiable et une seconde publication s'enchaîne
        // (C-B3 : le fichier ajouté par une publication est remplaçable par son
        // dernier écrivain).
        const second = await publish(
            publication(product, {
                [product.notice]: `export const X1_NOTICE = '${domain}-2';\n`,
            })
        );
        assert.equal(second.plan.changes[0].change, 'replaced');
        assert.equal(
            (await readManifest(product)).ownership.publications.length,
            2
        );
        await planExternalApplicationShell({
            ...product.shell,
            appName: `${product.shell.appName}-b`,
        });
        assert.deepEqual(await snapshotTree(TOOLS_ROOT), workshopBefore);
    }
});

test('X1 : plan obligatoire, périmé ou rejoué', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const options = publication(product, { [product.notice]: 'export {};\n' });
    await assert.rejects(
        publishApplicationPublication(options, { run: () => assert.fail() }),
        /publication requires a reviewed plan/
    );
    const plan = await planApplicationPublication(options);
    await assert.rejects(
        publishApplicationPublication(
            { ...options, expectedPlanId: 'f'.repeat(64) },
            { run: () => assert.fail() }
        ),
        /reviewed publication plan is stale/
    );
    const done = await publishApplicationPublication(
        { ...options, expectedPlanId: plan.plan_id },
        { run: () => undefined }
    );
    assert.equal(done.recovered, false);
    assert.equal(done.replayed, false);
    const before = await snapshotTree(product.root, []);
    const again = await publishApplicationPublication(
        { ...options, expectedPlanId: plan.plan_id },
        { run: () => assert.fail('Republication') }
    );
    // M-7 : un rejeu n'est pas une reprise.
    assert.equal(again.replayed, true);
    assert.equal(again.recovered, false);
    assert.equal(again.plan, undefined);
    assert.deepEqual(await snapshotTree(product.root, []), before);
});

test('X1 : zones non déclarées et changements vides refusés avant toute écriture', async (t) => {
    const product = await sessionApp(t, 'equipment-hire');
    const before = await snapshotTree(product.root, []);
    const app = product.shell.appName;
    const cases = [
        // La coque, sa signature et la configuration des bibliothèques ne
        // sont jamais une zone de publication (V5.1 règle 1).
        [`${coque(product)}/project.json`, /outside declared zones/],
        [`${coque(product)}/src/app/app.routes.ts`, /outside declared zones/],
        [
            `${coque(product)}/${SIGNATURE_FILES.libraries}`,
            /outside declared zones/,
        ],
        [`${socle(product)}/project.json`, /outside declared zones/],
        [`${socle(product)}/src/index.ts`, /outside declared zones/],
        [`${socle(product)}/src/session/extra.ts`, /outside declared zones/],
        [`libs/${app}-interface/src/pages/x.ts`, /outside declared zones/],
        // Page non déclarée (aucun contrat de page) : hors zone.
        [
            `${socle(product)}/src/pages/page_0000000000000000/x.ts`,
            /outside declared zones/,
        ],
        [`${socle(product)}/src/actions/.hidden.ts`, /outside declared zones/],
        ['../escape.ts', /external application:/],
    ];
    for (const [path, pattern] of cases)
        await assert.rejects(
            planApplicationPublication(
                publication(product, { [path]: 'export {};\n' })
            ),
            pattern,
            path
        );
    const current = await readProduct(product, product.page);
    await assert.rejects(
        planApplicationPublication(
            publication(product, { [product.page]: current })
        ),
        /publication without change/
    );
    await assert.rejects(
        planApplicationPublication(
            publication(product, { [product.notice]: 'x' }, 'outil-inconnu')
        ),
        /publication tool is not declared/
    );
    assert.deepEqual(await snapshotTree(product.root, []), before);
});

test('X1 : fichier ajouté à la main, octet modifié et zone racine non déclarée refusés', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const options = publication(product, { [product.notice]: 'export {};\n' });
    const hand = `${socle(product)}/src/actions/hand/hand.ts`;
    await writeProduct(product, hand, 'export const hand = 1;\n');
    await assert.rejects(
        planApplicationPublication(options),
        /generated inventory drift/
    );
    await rm(join(product.root, socle(product), 'src/actions'), {
        recursive: true,
    });
    const path = join(product.root, product.page);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from(' ')]));
    await assert.rejects(planApplicationPublication(options), /drift/);
    await writeFile(path, original);
    // V8-R2 : un octet modifié à longueur identique.
    const store = join(
        product.root,
        socle(product),
        'src/session/session.store.ts'
    );
    const storeBytes = await readFile(store);
    await writeFile(store, sameLength(storeBytes));
    await assert.rejects(
        planApplicationPublication(options),
        /workspace ownership drift/
    );
    await writeFile(store, storeBytes);
    await mkdir(join(product.root, '.github'));
    await assert.rejects(
        planApplicationPublication(options),
        /unowned workspace directory/
    );
    await rm(join(product.root, '.github'), { recursive: true });
    await planApplicationPublication(options);
});

test('X1 : registre falsifié refusé sous toutes ses formes (constat I-2)', async (t) => {
    const product = await sessionApp(t, 'equipment-hire');
    const options = publication(product, { [product.notice]: 'export {};\n' });
    const manifestPath = join(product.root, product.manifestPath);
    const original = await readFile(manifestPath);
    const handText = 'export const hand = 1;\n';
    const handPath = `${socle(product)}/src/actions/hand/hand.ts`;
    await writeProduct(product, handPath, handText);
    const forge = async (change) => {
        const manifest = JSON.parse(original.toString('utf8'));
        change(manifest);
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    };
    const listHand = (manifest) => {
        manifest.generated_files = [
            ...manifest.generated_files,
            {
                path: handPath,
                bytes: handText.length,
                sha256: sha256(handText),
            },
        ].sort((left, right) => left.path.localeCompare(right.path));
        manifest.tree_sha256 = inventoryTreeSha(manifest.generated_files);
    };
    const reseal = (manifest) => {
        manifest.ownership.seal_sha256 = computeOwnershipSeal(manifest);
    };
    const project = `${coque(product)}/project.json`;
    const forgeries = [
        // I-2 exact : inventaire édité avec la bonne empreinte du fichier.
        [listHand, /app ownership seal mismatch/],
        // Sceau retiré : aucun retour silencieux à l'auto-déclaration.
        [
            (m) => {
                listHand(m);
                delete m.ownership;
            },
            /app ownership seal missing/,
        ],
        // Sceau recalculé mais aucune publication n'explique le fichier.
        [
            (m) => {
                listHand(m);
                reseal(m);
            },
            /not explained by sealed publications/,
        ],
        // Publication inventée hors zone (la coque), sceau recalculé.
        [
            (m) => {
                const entry = m.generated_files.find((e) => e.path === project);
                m.ownership.publications.push({
                    plan_id: 'a'.repeat(64),
                    tool: 'generate:action-request',
                    files: [
                        {
                            path: project,
                            change: 'replaced',
                            sha256: 'b'.repeat(64),
                            bytes: 1,
                            before: {
                                sha256: entry.sha256,
                                bytes: entry.bytes,
                            },
                        },
                    ],
                });
                entry.sha256 = 'b'.repeat(64);
                entry.bytes = 1;
                m.tree_sha256 = inventoryTreeSha(m.generated_files);
                reseal(m);
            },
            /outside declared zones/,
        ],
        // V8-R3 : tree_sha256 incohérent avec l'inventaire, sceau recalculé.
        [
            (m) => {
                m.tree_sha256 = 'd'.repeat(64);
                reseal(m);
            },
            /app inventory digest mismatch/,
        ],
        // Manifeste lié à un autre produit.
        [
            (m) => {
                m.ownership.workspace_id = 'c'.repeat(64);
                reseal(m);
            },
            /bound to another workspace/,
        ],
    ];
    for (const [change, pattern] of forgeries) {
        await forge(change);
        await assert.rejects(planApplicationPublication(options), pattern);
        await assert.rejects(
            planExternalApplicationShell({
                ...product.shell,
                appName: 'other',
            }),
            pattern
        );
    }
    await writeFile(manifestPath, original);
    await rm(join(product.root, socle(product), 'src/actions'), {
        recursive: true,
    });
    await planApplicationPublication(options);
});

// Phases réelles d'une publication, relevées sur un produit d'essai.
async function publicationPhases(t) {
    const probe = await sessionApp(t, 'observatory');
    const phases = [];
    await publish(publication(probe, { [probe.notice]: 'export {};\n' }), {
        phase: (name) => phases.push(name),
    });
    assert.deepEqual(
        phases.filter((name) => name.startsWith('swapped:')),
        [`swapped:${coque(probe)}`, `swapped:${socle(probe)}`]
    );
    return phases;
}

test('X1 : échec injecté à chaque phase réelle : retour exact sur les deux racines, aucun reste', async (t) => {
    for (const failing of await publicationPhases(t)) {
        await t.test(failing, async (child) => {
            const product = await sessionApp(child, 'observatory');
            const options = publication(product, {
                [product.notice]: 'export {};\n',
            });
            const before = await snapshotTree(product.root, []);
            const plan = await planApplicationPublication(options);
            await assert.rejects(
                publishApplicationPublication(
                    { ...options, expectedPlanId: plan.plan_id },
                    {
                        run: () => undefined,
                        phase: (name) => {
                            if (name === failing)
                                throw new Error(`injected ${name}`);
                        },
                    }
                ),
                new RegExp(`injected ${failing}`)
            );
            assert.deepEqual(await workingTrees(product), []);
            if (failing === 'verified')
                // Point de non-retour : la fin en avant est faite.
                assert.equal(
                    (await readManifest(product)).ownership.publications.at(-1)
                        .plan_id,
                    plan.plan_id
                );
            else assert.deepEqual(await snapshotTree(product.root, []), before);
        });
    }
});

test('X1 : arrêt brutal à chaque phase réelle (entre chaque paire de racines), puis recover:application-publication (lot 2, V5.2)', async (t) => {
    for (const at of await publicationPhases(t)) {
        await t.test(at, async (child) => {
            const product = await sessionApp(child, 'observatory');
            const options = publication(product, {
                [product.notice]: 'export {};\n',
            });
            const before = await snapshotTree(product.root, []);
            const plan = await interruptAt(product, options, at);
            // Le journal bloque toute autre commande.
            await assert.rejects(
                planExternalApplicationShell({
                    ...product.shell,
                    appName: 'other',
                }),
                /interrupted application publication pending; recover it first/
            );
            const recovered = await recoverApplicationPublication(options);
            const forward = at === 'verified';
            assert.deepEqual(recovered, {
                recovered: true,
                transactions: [
                    {
                        genre: 'publication',
                        plan_id: plan.plan_id,
                        direction: forward ? 'forward' : 'back',
                    },
                ],
            });
            assert.deepEqual(await workingTrees(product), []);
            if (forward)
                assert.equal(
                    (await readManifest(product)).ownership.publications.at(-1)
                        .plan_id,
                    plan.plan_id
                );
            else assert.deepEqual(await snapshotTree(product.root, []), before);
        });
    }
});

test('X1 : un arbre neuf ou un candidat altéré n’est jamais déplacé ; la reprise refuse, nommée (V8-R1, V8-R2, S1a-1)', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const options = publication(product, { [product.notice]: 'export {};\n' });
    const before = await snapshotTree(product.root, []);
    const refusedRollback = (cause, detail) => (error) =>
        error instanceof AggregateError &&
        /publication rollback refused/.test(error.message) &&
        cause.test(error.errors[0].message) &&
        detail.test(error.errors[1].message);
    // V8-R1 : arbre neuf du socle altéré après l'échange, puis échec : rien ne
    // bouge, et la reprise refuse à son tour.
    let plan = await planApplicationPublication(options);
    const foreign = join(product.root, socle(product), 'src/etranger.ts');
    await assert.rejects(
        publishApplicationPublication(
            { ...options, expectedPlanId: plan.plan_id },
            {
                run: () => undefined,
                phase: async (name) => {
                    if (name !== 'published') return;
                    await writeFile(foreign, 'export {};\n', { flag: 'wx' });
                    throw new Error('altered');
                },
            }
        ),
        refusedRollback(
            /altered/,
            /libs\/session-observatory-socle renamed tree drifted/
        )
    );
    assert.equal(await readFile(foreign, 'utf8'), 'export {};\n');
    await assert.rejects(
        recoverApplicationPublication(options),
        /ambiguous interrupted application publication: libs\/session-observatory-socle renamed tree drifted/
    );
    await rm(foreign);
    await recoverApplicationPublication(options);
    assert.deepEqual(await snapshotTree(product.root, []), before);
    // V8-R2 et S1a-1 : candidat altéré à longueur identique. Le contrôle du
    // candidat le refuse ; le retour arrière n'admet pas un candidat altéré :
    // « candidate drifted », RIEN n'est déplacé ni retiré.
    plan = await planApplicationPublication(options);
    const candidate = join(
        product.root,
        'libs',
        `.${product.shell.appName}-socle.publication-candidate-${plan.plan_id}`
    );
    const staged = join(candidate, 'src/session/session.store.ts');
    await assert.rejects(
        publishApplicationPublication(
            { ...options, expectedPlanId: plan.plan_id },
            {
                run: () => undefined,
                phase: async (name) => {
                    if (name === 'candidate-staged')
                        await writeFile(
                            staged,
                            sameLength(await readFile(staged))
                        );
                },
            }
        ),
        refusedRollback(/generated file drift/, /candidate drifted/)
    );
    assert.equal(await pathExists(staged), true);
    await assert.rejects(
        recoverApplicationPublication(options),
        /libs\/session-observatory-socle candidate drifted/
    );
    assert.equal(await pathExists(staged), true);
    await rm(candidate, { recursive: true });
    await recoverApplicationPublication(options);
    assert.deepEqual(await snapshotTree(product.root, []), before);
    assert.deepEqual(await workingTrees(product), []);
});

test('X1 : application extérieure non scellée refusée ; mode atelier inchangé', async (t) => {
    const product = await sessionApp(t, 'equipment-hire');
    const manifestPath = join(product.root, product.manifestPath);
    const manifest = await readManifest(product);
    const { ownership: _ownership, ...unsealed } = manifest;
    void _ownership;
    await writeFile(manifestPath, JSON.stringify(unsealed, null, 2) + '\n');
    await assert.rejects(
        planApplicationPublication(
            publication(product, { [product.notice]: 'export {};\n' })
        ),
        /app ownership seal missing/
    );
    const loaded = await schemas();
    const atelier = await planApplicationShell({
        workspaceRoot: TOOLS_ROOT,
        designPath:
            'designs/application-conception-proof.application-design.json',
        experienceId: 'visitor-web',
        appName: 'x1-atelier-mode',
        profile: 'angular-pwa',
        ...loaded,
    });
    const atelierManifest = JSON.parse(
        atelier.files[SIGNATURE_FILES.appManifest]
    );
    assert.equal(atelierManifest.ownership, undefined);
    assert.equal(atelier.external_workspace, undefined);
});

test('X1 suivi : limite connue, une forge complète qui recalcule le sceau passe (ADR-0103)', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const path = `${socle(product)}/src/actions/forge/forge.ts`;
    const text = 'export const forged = 1;\n';
    await writeProduct(product, path, text);
    const manifest = await readManifest(product);
    const entry = {
        path,
        bytes: Buffer.byteLength(text),
        sha256: sha256(text),
    };
    manifest.generated_files = [...manifest.generated_files, entry].sort(
        (left, right) => left.path.localeCompare(right.path)
    );
    manifest.tree_sha256 = inventoryTreeSha(manifest.generated_files);
    // Outil et plan inventés : ils sont déclaratifs, jamais revérifiés.
    manifest.ownership.publications.push({
        plan_id: '0'.repeat(64),
        tool: 'generate:action-request',
        files: [{ ...entry, change: 'added' }],
    });
    manifest.ownership.seal_sha256 = computeOwnershipSeal(manifest);
    await writeFile(
        join(product.root, product.manifestPath),
        JSON.stringify(manifest, null, 2) + '\n'
    );
    // Le sceau empêche l'adoption par erreur, pas la forge délibérée.
    verifyApplicationOwnership(manifest, product.workspaceId);
    await planApplicationPublication(
        publication(product, { [product.notice]: 'export {};\n' })
    );
    await planExternalApplicationShell({ ...product.shell, appName: 'other' });
});

// Lot 10 : l'outil `page-realization` a quitté la liste fermée des publieurs.
// Un registre qui porte une publication de cet outil est refusé, même
// rescellé ; le même enregistrement sous un outil admis passe (témoin : seul
// l'outil change).
test('X1 suivi : une publication de l’outil retiré page-realization est refusée, même rescellée', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const manifest = await readManifest(product);
    const text = 'export const forged = 1;\n';
    const entry = {
        path: `${socle(product)}/src/actions/forge/forge.ts`,
        bytes: Buffer.byteLength(text),
        sha256: sha256(text),
    };
    manifest.generated_files = [...manifest.generated_files, entry].sort(
        (left, right) => left.path.localeCompare(right.path)
    );
    manifest.tree_sha256 = inventoryTreeSha(manifest.generated_files);
    const record = {
        plan_id: '0'.repeat(64),
        tool: 'page-realization',
        files: [{ ...entry, change: 'added' }],
    };
    manifest.ownership.publications.push(record);
    manifest.ownership.seal_sha256 = computeOwnershipSeal(manifest);
    assert.throws(
        () => verifyApplicationOwnership(manifest, product.workspaceId),
        /publication record is invalid/
    );
    record.tool = 'generate:action-request';
    manifest.ownership.seal_sha256 = computeOwnershipSeal(manifest);
    verifyApplicationOwnership(manifest, product.workspaceId);
});

test('X1 suivi : une publication interrompue bloque toute autre commande jusqu’à sa reprise (I-1)', async (t) => {
    const product = await sessionApp(t, 'equipment-hire');
    const options = publication(product, { [product.notice]: 'export {};\n' });
    const other = { ...product.shell, appName: 'other' };
    const pending =
        /interrupted application publication pending; recover it first \(recover:application-publication\)/;
    const before = await snapshotTree(product.root, []);
    // Échange fait, contrôles non confirmés : l'arbre neuf n'est adopté par
    // aucune autre commande, ni par un nouveau plan de la même application.
    await interruptAfterSwap(product, options);
    await assert.rejects(planExternalApplicationShell(other), pending);
    await assert.rejects(planApplicationPublication(options), pending);
    const recovered = await recoverApplicationPublication(options);
    assert.equal(recovered.recovered, true);
    assert.deepEqual(await snapshotTree(product.root, []), before);
    await planExternalApplicationShell(other);
    // Candidats seuls (arrêt avant l'échange) : même refus ; la publication
    // relue de cette application reprend puis publie.
    const plan = await interruptAt(product, options, 'candidate-staged');
    assert.ok(
        await pathExists(
            transactionJournalRoot(product.root, 'publication', plan.plan_id)
        )
    );
    await assert.rejects(planExternalApplicationShell(other), pending);
    const done = await publishApplicationPublication(
        { ...options, expectedPlanId: plan.plan_id },
        { run: () => undefined }
    );
    assert.equal(done.recovered, true);
    assert.equal(done.replayed, false);
    await planExternalApplicationShell(other);
});

test('X1 suivi : un échec à chacun des quatre renommages laisse l’application restaurée (I-1)', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const options = publication(product, { [product.notice]: 'export {};\n' });
    const before = await snapshotTree(product.root, []);
    // Deux racines, deux renommages chacune : [renommage en échec, effectué
    // avant l'échec (fsync) ou non].
    for (const call of [1, 2, 3, 4])
        for (const done of [false, true]) {
            let calls = 0;
            const rename = async (from, to) => {
                calls += 1;
                if (calls === call && !done) throw new Error('injected rename');
                await renameAndSync(from, to);
                if (calls === call) throw new Error('injected rename');
            };
            const plan = await planApplicationPublication(options);
            await assert.rejects(
                publishApplicationPublication(
                    { ...options, expectedPlanId: plan.plan_id },
                    { run: () => undefined, rename }
                ),
                /injected rename/
            );
            assert.deepEqual(
                await snapshotTree(product.root, []),
                before,
                `${call}/${done}`
            );
            assert.deepEqual(await workingTrees(product), []);
        }
    await planExternalApplicationShell({ ...product.shell, appName: 'other' });
});

// Lot MARQUE, commit 3 : transaction de `rename-product-prefix` et reprise.
// § 7.2 : échec injecté à CHAQUE étape (phases, compilateur, contrôles nx,
// contrat de l'espace, chaque échange, bascule de l'espace) → état EXACT
// d'avant ; interruption après `verified` → état exact d'après. Règle C : la
// reprise décide d'après l'état OBSERVÉ (manifeste d'espace, arbres) ; un état
// ambigu est refusé et rien n'est déplacé. D.6 : la post-condition `derived`
// annule un candidat cohérent mais différent du rendu au préfixe scellé.
import assert from 'node:assert/strict';
import { appendFile, cp, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { planApplicationPublication } from './core/application-publication.mjs';
import {
    planApplicationWorkspace,
    planExternalApplicationShell,
    readOwnedWorkspace,
    renderExternalShellFiles,
} from './core/application-workspace.mjs';
import { SIGNATURE_FILES } from './core/atelier-signature.mjs';
import { renameAndSync } from './core/generation-transaction.mjs';
import { recoverProductPrefixRename } from './core/product-prefix-rename-transaction.mjs';
import { coqueRoot, socleRoot } from './core/socle-names.mjs';
import { fixtureParent } from './test-support/external-application-fixture.mjs';
import {
    renameProduct,
    renameTo,
    SESSION_APP,
    snapshot,
    PRODUCT_APPS,
} from './test-support/product-prefix-rename-fixture.mjs';

const PENDING = /interrupted prefix rename pending; recover it first/;
const AMBIGUOUS = /ambiguous interrupted prefix rename/;
const APPS = PRODUCT_APPS;
// Contrôles natifs du point `verified` (C-B2 : la liste unique, dérivée des
// configurations rendues ; T-E8 = P1 : lint avant la construction). Oracle
// écrit ici, fait mesuré au lot 2 : lint des trois projets, construction de la
// coque, puis le test du projet qui porte les specs (le socle de l'appli à
// session, dont la coque n'a plus de cible `test` ; la coque sinon).
const controls = (app) => [
    `${app}:lint`,
    `${app}-socle:lint`,
    `${app}-interface:lint`,
    `${app}:build:production`,
    app === SESSION_APP ? `${app}-socle:test` : `${app}:test`,
];
const PHASES_BEFORE_VERIFIED = [
    'prepared',
    'candidate-staged',
    'staged',
    'swapped',
    'switched',
    'derived',
];

class Injected extends Error {}

const ownName = (name) => name === 'product' || name.startsWith('.product.');

// Image du produit et de son journal au moment d'un arrêt brutal, sans les
// verrous (ceux d'un processus mort sont repris : comportement existant).
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

// Toute commande pendant un renommage interrompu est refusée, nommément.
async function assertBlocked(product) {
    await assert.rejects(readOwnedWorkspace(product.base), PENDING);
    await assert.rejects(planApplicationWorkspace(product.options), PENDING);
    await assert.rejects(
        planApplicationPublication({
            ...product.app,
            tool: 'generate:action-request',
            files: {
                [`${socleRoot(SESSION_APP)}/src/actions/x1-proof/notice.ts`]:
                    'x\n',
            },
        }),
        PENDING
    );
    await assert.rejects(
        planExternalApplicationShell({
            ...product.base,
            designPath: 'descriptions/shells.application-design.json',
            experienceId: 'citizen-web',
            appName: 'late-app',
            profile: 'angular-pwa',
        }),
        PENDING
    );
}

// Libellé d'un appel du runner : compilateur d'un candidat, cible nx d'une
// appli, ou contrat de l'espace.
function runLabel(args) {
    if (args[0].endsWith('check-workspace.mjs')) return 'check-workspace';
    if (args[1] === 'run') return args[2];
    return `compile ${basename(dirname(args[2])).split('.')[1]}`;
}

test('renommage du préfixe : échec injecté, arrêt brutal et reprise par l’état observé', async (t) => {
    const product = await renameProduct(t, undefined);
    const images = await fixtureParent(t);
    const start = join(images, 'start');
    const crash = join(images, 'crash');
    await takeImage(product, start);
    const before = await snapshot(product);
    const backToStart = async () => {
        await restoreImage(product, start);
        assert.deepEqual(await snapshot(product), before);
        await readOwnedWorkspace(product.base);
    };
    // Référence : un renommage réussi enregistre les appels du runner et les
    // échanges ; les injections en sont dérivées.
    const runs = [];
    const swaps = [];
    await renameTo(product, 'qz', {
        run: (_command, args) => runs.push(runLabel(args)),
        rename: async (from, to) => {
            swaps.push(`${basename(from)} → ${basename(to)}`);
            await renameAndSync(from, to);
        },
    });
    const after = await snapshot(product);
    assert.notDeepEqual(after, before);
    assert.deepEqual(runs, [
        ...APPS.map((app) => `compile ${app}`),
        ...APPS.flatMap(controls),
        'check-workspace',
    ]);
    assert.equal(swaps.length, APPS.length * 2 + 1);
    assert.match(swaps.at(-1), /^\.workspace-rename-[a-f0-9]{64}\.tmp → /);
    await backToStart();

    const failing = async (dependencies, label, pattern = Injected) => {
        await assert.rejects(renameTo(product, 'qz', dependencies), pattern);
        assert.deepEqual(await snapshot(product), before, label);
        await readOwnedWorkspace(product.base);
    };

    await t.test(
        'échec injecté à chaque phase avant verified : état exact d’avant',
        async () => {
            for (const target of PHASES_BEFORE_VERIFIED)
                await failing(
                    {
                        phase: (name) => {
                            if (name === target) throw new Injected(name);
                        },
                    },
                    target
                );
        }
    );

    await t.test(
        'échec injecté à chaque appel du runner : compilateur, nx, contrat de l’espace',
        async () => {
            for (const [index, label] of runs.entries()) {
                let calls = 0;
                await failing(
                    {
                        run: () => {
                            if (calls++ === index) throw new Injected(label);
                        },
                    },
                    label
                );
            }
        }
    );

    await t.test(
        'échec injecté à chaque échange et à la bascule, avant et après le renommage',
        async () => {
            for (const performed of [false, true])
                for (const [index, label] of swaps.entries()) {
                    let calls = 0;
                    await failing(
                        {
                            rename: async (from, to) => {
                                if (calls++ !== index)
                                    return renameAndSync(from, to);
                                if (performed) await renameAndSync(from, to);
                                throw new Injected(label);
                            },
                        },
                        `${label} (${performed ? 'après' : 'avant'})`
                    );
                }
        }
    );

    await t.test(
        'D.6 : un octet du candidat différent du rendu en q est annulé avant verified',
        async () => {
            const seen = [];
            await failing(
                {
                    phase: (name) => seen.push(name),
                    // Erreur de dérivation au plan : la coque rendue en `qz` porte
                    // un octet de trop ; enregistrement, candidat et manifeste
                    // restent cohérents entre eux.
                    renderShell: async (workspace, manifest, prefix) => {
                        const files = await renderExternalShellFiles(
                            workspace,
                            manifest,
                            prefix
                        );
                        if (
                            prefix === 'qz' &&
                            manifest.app_name === SESSION_APP
                        )
                            files[`${coqueRoot(SESSION_APP)}/src/main.ts`] +=
                                ' ';
                        return files;
                    },
                },
                'derived',
                /PRODUCT_RENAME_NOT_DERIVED: app session-observatory path apps\/session-observatory\/src\/main\.ts/
            );
            assert.equal(seen.at(-1), 'switched');
            assert.ok(!seen.includes('derived'));
        }
    );

    await t.test(
        'arrêt brutal à chaque phase avant verified : commandes refusées, reprise en arrière',
        async () => {
            const crashes = [
                ...PHASES_BEFORE_VERIFIED.map((target) => [
                    target,
                    {
                        phase: async (name) => {
                            if (name !== target) return;
                            await takeImage(product, crash);
                            throw new Injected(name);
                        },
                    },
                ]),
                // Entre les deux renommages de l'échange de la première appli.
                [
                    'échange coupé',
                    {
                        rename: async (from, to) => {
                            await renameAndSync(from, to);
                            if (basename(to).includes('.rename-previous-')) {
                                await takeImage(product, crash);
                                throw new Injected('swap');
                            }
                        },
                    },
                ],
                // C : fichier temporaire écrit, manifeste d'espace pas encore
                // remplacé (manifeste ANCIEN observé).
                [
                    'bascule non faite',
                    {
                        rename: async (from, to) => {
                            if (
                                basename(to) ===
                                basename(SIGNATURE_FILES.workspaceManifest)
                            ) {
                                await takeImage(product, crash);
                                throw new Injected('switch');
                            }
                            await renameAndSync(from, to);
                        },
                    },
                ],
                // C : manifeste d'espace remplacé, journal encore en `swapped`
                // (manifeste NOUVEAU observé, phase < verified).
                [
                    'bascule faite, non inscrite',
                    {
                        rename: async (from, to) => {
                            await renameAndSync(from, to);
                            if (
                                basename(to) ===
                                basename(SIGNATURE_FILES.workspaceManifest)
                            ) {
                                await takeImage(product, crash);
                                throw new Injected('switch');
                            }
                        },
                    },
                ],
            ];
            for (const [label, dependencies] of crashes) {
                await failing(dependencies, label);
                await restoreImage(product, crash);
                await assertBlocked(product);
                const result = await recoverProductPrefixRename(product.base);
                assert.equal(result.direction, 'back', label);
                assert.equal(result.prefix, 'ns', label);
                assert.deepEqual(await snapshot(product), before, label);
                await readOwnedWorkspace(product.base);
            }
            assert.deepEqual(await recoverProductPrefixRename(product.base), {
                recovered: false,
            });
        }
    );

    await t.test('état ambigu : refus, rien n’est déplacé', async () => {
        const cases = [
            [
                'switched',
                'manifeste d’espace ni ancien ni nouveau',
                () =>
                    appendFile(
                        join(product.root, SIGNATURE_FILES.workspaceManifest),
                        ' '
                    ),
            ],
            [
                'swapped',
                'arbre renommé modifié',
                () =>
                    appendFile(
                        join(product.apps, SESSION_APP, 'src/main.ts'),
                        ' '
                    ),
            ],
            [
                'staged',
                'arbres de renommage sans journal',
                async () => {
                    for (const name of await readdir(product.parent))
                        if (name.startsWith('.product.rename-'))
                            await rm(join(product.parent, name), {
                                recursive: true,
                            });
                },
            ],
        ];
        for (const [target, label, edit] of cases) {
            await failing(
                {
                    phase: async (name) => {
                        if (name !== target) return;
                        await takeImage(product, crash);
                        throw new Injected(name);
                    },
                },
                label
            );
            await restoreImage(product, crash);
            await edit();
            const frozen = await snapshot(product);
            await assert.rejects(
                recoverProductPrefixRename(product.base),
                AMBIGUOUS,
                label
            );
            assert.deepEqual(await snapshot(product), frozen, label);
            await backToStart();
        }
    });

    await t.test(
        'interruption après verified : reprise en avant, état exact d’après',
        async () => {
            await assert.rejects(
                renameTo(product, 'qz', {
                    phase: async (name) => {
                        if (name !== 'verified') return;
                        await takeImage(product, crash);
                        throw new Injected(name);
                    },
                }),
                Injected
            );
            // La transaction confirmée va en avant, même interrompue.
            assert.deepEqual(await snapshot(product), after);
            await restoreImage(product, crash);
            await assertBlocked(product);
            const result = await recoverProductPrefixRename(product.base);
            assert.equal(result.direction, 'forward');
            assert.equal(result.prefix, 'qz');
            assert.deepEqual(await snapshot(product), after);
            await readOwnedWorkspace(product.base);
        }
    );
});

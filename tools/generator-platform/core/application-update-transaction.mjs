// Lot 2, commit 6c (cadrage § 20 ; conception v2 R2.1.6, v3 V3.5 a et c,
// V3.6 point 4, v4 V4.6 point 2) : transaction d'`update-app` et sa reprise
// (`recover:application-update`), sur la brique commune. Le journal vit à
// côté du produit, au niveau du PRODUIT (toutes les applis mises à jour, un
// seul `plan_id`) ; il porte des opérations `tree` (coque, socle : racines
// exactes) et `files` (configuration et amorces de l'interface, C-B1). Dans
// cet ordre :
// 1. candidats et programmes témoins (coque + socle + amorces de TOUTES les
//    pages à la place des sources de l'interface) ; témoin BLOQUANT avant
//    tout échange (compilations, puis ESLint de l'interface sur les
//    amorces) : un rouge est `UPDATE_GENERATOR_BROKEN <couche> <fichier>`,
//    retour exact, rien n'est adopté ; les arbres témoins sont retirés avant
//    l'échange ;
// 2. échanges, dans l'ordre fixé ; contrôles BLOQUANTS du socle et contrat
//    de l'espace ; post-condition `derived` (le produit égale son rendu) ;
// 3. appli réelle (coque et interface de l'IA) lancée et RAPPORTÉE, sans
//    bloquer : une ligne `RAPPORT_INTERFACE: VERT | ROUGE <couche> <chemin>` ;
// 4. `verified`, point de non-retour.
// Avant `verified`, toute reprise revient à l'état d'avant, décidée par
// l'état OBSERVÉ de chaque arbre et de chaque fichier ; à `verified`, elle
// finit en avant ; un état ambigu est refusé sans rien déplacer.
import { readdir } from 'node:fs/promises';
import { basename, dirname, posix, resolve } from 'node:path';

import { EXTERNAL_WORKSPACE_SIGNATURE } from '../renderers/application-workspace-renderer.mjs';
import { appManifestPath } from '../renderers/external-product-layout.mjs';
import { repositoryRoot } from '../validate-ir.mjs';
import { nativeControls } from './application-native-controls.mjs';
import { UPDATE_TOOL } from './application-ownership.mjs';
import {
    pendingTransactionJournals,
    TRANSACTION_PHASES,
    transactionJournalRoot,
    transactionTrees,
    UPDATE_RECOVERY_COMMAND,
    validTransactionTree,
    WORKING_TREE,
    workingTreeName,
} from './application-transaction.mjs';
import { planApplicationUpdate } from './application-update.mjs';
import { ownedAppNames } from './application-workspace-root.mjs';
import {
    installedBin,
    readOwnedWorkspace,
    runExternalApplicationCommand,
    verifyTransactionTrees,
} from './application-workspace.mjs';
import { escapeRegExp } from './atelier-signature.mjs';
import {
    assertSourceWeight,
    externalApplicationContext,
    externalFailure,
    pathExists,
    readProductFile,
    stageGeneratedTree,
} from './external-application-paths.mjs';
import {
    removeTreeAndSync,
    renameAndSync,
    withProductWriterLocks,
} from './generation-transaction.mjs';
import {
    completeFiles,
    planFilesRevert,
    prepareFilesOperation,
    revertFiles,
    swapFiles,
    validFilesOperation,
} from './product-files-operation.mjs';
import {
    completeTrees,
    exactKeys,
    planTreesRevert,
    poseTransactionJournal,
    readTransactionJournal,
    removeStagingDirectories,
    revertTrees,
    swapTree,
    writeTransactionJournal,
} from './product-transaction.mjs';
import {
    APPS_ROOT,
    coqueRoot,
    INTERFACE_ENTRY,
    interfaceAlias,
    interfaceLibraryName,
    interfaceRoot,
    LIBS_ROOT,
    SOCLE_COQUE_ENTRY,
    SOCLE_ENTRY,
    socleAlias,
    socleCoqueAlias,
    socleRoot,
} from './socle-names.mjs';

const GENRE = 'update';
const HEX = /^[a-f0-9]{64}$/;
const APP_NAME = /^[a-z][a-z0-9-]*$/;
const WITNESS_CONFIG = 'tsconfig.witness.json';
export const REPORT_PREFIX = 'RAPPORT_INTERFACE:';

const stagingPrefix = (productRoot) =>
    `.${basename(productRoot)}.${GENRE}-staging-`;

// Programmes témoins d'une appli : la coque et l'interface, à côté de leur
// racine, nommés par le plan.
export const witnessTrees = (app, planId) => [
    `${APPS_ROOT}/${workingTreeName(app, GENRE, 'witness', planId)}`,
    `${LIBS_ROOT}/${workingTreeName(interfaceLibraryName(app), GENRE, 'witness', planId)}`,
];

function ambiguous(detail, drift) {
    const error = new Error(
        `external application: ambiguous interrupted application update: ${detail}`
    );
    if (drift) error.drift = drift;
    throw error;
}

function journalOf(plan, apps, trees, operations) {
    return {
        schema_version: '1.0.0',
        kind: 'application-update-journal',
        genre: GENRE,
        plan_id: plan.plan_id,
        apps,
        trees: trees.map((tree) => ({
            root: tree.root,
            candidate: tree.candidate,
            previous: tree.previous,
            before: tree.before,
            files: tree.files,
        })),
        operations,
        phase: 'prepared',
    };
}

const validJournal = (journal, planId) =>
    exactKeys(journal, [
        'schema_version',
        'kind',
        'genre',
        'plan_id',
        'apps',
        'trees',
        'operations',
        'phase',
    ]) &&
    journal.schema_version === '1.0.0' &&
    journal.kind === 'application-update-journal' &&
    journal.genre === GENRE &&
    journal.plan_id === planId &&
    TRANSACTION_PHASES.includes(journal.phase) &&
    Array.isArray(journal.apps) &&
    journal.apps.length > 0 &&
    journal.apps.every(
        (app, index) =>
            APP_NAME.test(app ?? '') &&
            (index === 0 || journal.apps[index - 1] < app)
    ) &&
    Array.isArray(journal.trees) &&
    journal.trees.every((tree) => validTransactionTree(tree, GENRE, planId)) &&
    Array.isArray(journal.operations) &&
    journal.operations.every((operation) =>
        validFilesOperation(operation, (root) =>
            journal.apps.some((app) => root === interfaceRoot(app))
        )
    );

const journalTrees = (productRoot, journal) =>
    journal.trees.map((tree) => ({
        ...tree,
        parent: resolve(productRoot, dirname(tree.root)),
        name: basename(tree.root),
        label: tree.root,
    }));

async function removeWitnesses(productRoot, journal) {
    for (const app of journal.apps)
        for (const path of witnessTrees(app, journal.plan_id))
            if (await pathExists(resolve(productRoot, path)))
                await removeTreeAndSync(resolve(productRoot, path));
}

// Retour à l'état d'avant (phase < verified) : TOUS les arbres et tous les
// fichiers sont examinés AVANT le premier déplacement (règle C, C-B1).
async function revertUpdate(productRoot, journal) {
    const root = transactionJournalRoot(productRoot, GENRE, journal.plan_id);
    const trees = await planTreesRevert(
        journalTrees(productRoot, journal),
        ambiguous
    );
    const files = await planFilesRevert(
        productRoot,
        root,
        journal.operations,
        journal.plan_id,
        ambiguous
    );
    await revertTrees(trees);
    await revertFiles(files);
    await removeWitnesses(productRoot, journal);
    await removeTreeAndSync(root);
}

// Phase `verified` : en avant, nettoyage seul, après contrôle de l'état.
async function completeUpdate(productRoot, journal) {
    await completeTrees(journalTrees(productRoot, journal), ambiguous);
    await completeFiles(
        productRoot,
        journal.operations,
        journal.plan_id,
        ambiguous
    );
    await removeWitnesses(productRoot, journal);
    await removeTreeAndSync(
        transactionJournalRoot(productRoot, GENRE, journal.plan_id)
    );
}

async function readJournal(productRoot, planId) {
    return readTransactionJournal(
        transactionJournalRoot(productRoot, GENRE, planId),
        (journal) => validJournal(journal, planId),
        ambiguous
    );
}

// Couche et premier fichier en erreur d'une sortie (v4 V4.6 point 2) : le
// premier chemin d'une racine de l'appli, relatif au produit ; à défaut, la
// racine du projet du contrôle.
export function failureLocation(appName, text, productRoot, fallback) {
    const roots = [
        [interfaceRoot(appName), 'interface'],
        [socleRoot(appName), 'socle'],
        [coqueRoot(appName), 'coque'],
    ];
    // Un arbre de travail (candidat, témoin) est nommé par sa racine.
    const relative = String(text)
        .split(`${productRoot}/`)
        .join('')
        .replace(
            /\b(apps|libs)\/\.([a-z][a-z0-9-]*)\.update-(?:candidate|witness)-[a-f0-9]{64}/g,
            '$1/$2'
        );
    const pattern = new RegExp(
        `(${roots.map(([root]) => escapeRegExp(root)).join('|')})/[A-Za-z0-9._/-]*[A-Za-z0-9_-]`
    );
    const match = pattern.exec(relative);
    if (!match) return fallback;
    const layer = roots.find(([root]) => root === match[1])[1];
    return { layer, path: match[0] };
}

// Commande lancée avec sa sortie recueillie (et rendue), pour nommer la
// couche et le fichier d'un échec.
async function collected(run, command, args, root) {
    const chunks = [];
    const output = {
        write(chunk) {
            chunks.push(String(chunk));
            process.stderr.write(chunk);
        },
    };
    try {
        await run(command, args, root, { output });
        return null;
    } catch (error) {
        return `${chunks.join('')}\n${error.message}`;
    }
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const relativeTo = (from, to) => posix.relative(from, to) || '.';

// Programmes témoins (v3 V3.5 a) : l'interface rendue par le générateur
// (configuration d'après et amorces de TOUTES les pages), et la coque
// candidate ; leurs alias visent le socle candidat (ou le socle, s'il ne
// change pas) et l'interface témoin.
function witnessFiles(plan, app) {
    const [coqueWitness, interfaceWitness] = witnessTrees(
        app.app_name,
        plan.plan_id
    );
    const socleTree = app.trees.find(
        (tree) => tree.root === socleRoot(app.app_name)
    );
    const socle = socleTree
        ? `${LIBS_ROOT}/${workingTreeName(basename(socleTree.root), GENRE, 'candidate', plan.plan_id)}`
        : socleRoot(app.app_name);
    const ui = interfaceRoot(app.app_name);
    const interfaceFiles = {};
    for (const [path, content] of Object.entries(app.product))
        if (path.startsWith(`${ui}/`))
            interfaceFiles[path.slice(ui.length + 1)] = content;
    for (const [path, content] of Object.entries(app.allSeeds))
        interfaceFiles[path.slice(ui.length + 1)] = content;
    interfaceFiles[WITNESS_CONFIG] = json({
        extends: './tsconfig.lib.json',
        compilerOptions: {
            paths: {
                [socleAlias(app.app_name)]: [
                    relativeTo(interfaceWitness, `${socle}/${SOCLE_ENTRY}`),
                ],
                [interfaceAlias(app.app_name)]: [`./${INTERFACE_ENTRY}`],
            },
        },
    });
    const coque = app.trees.find(
        (tree) => tree.root === coqueRoot(app.app_name)
    );
    const coqueFiles = { ...coque.files };
    coqueFiles[WITNESS_CONFIG] = json({
        extends: './tsconfig.app.json',
        compilerOptions: {
            paths: {
                [socleAlias(app.app_name)]: [
                    relativeTo(coqueWitness, `${socle}/${SOCLE_ENTRY}`),
                ],
                [interfaceAlias(app.app_name)]: [
                    relativeTo(
                        coqueWitness,
                        `${interfaceWitness}/${INTERFACE_ENTRY}`
                    ),
                ],
                [socleCoqueAlias(app.app_name)]: [
                    relativeTo(coqueWitness, `${socle}/${SOCLE_COQUE_ENTRY}`),
                ],
            },
        },
    });
    return {
        socle,
        // L'interface d'abord : la coque l'importe.
        trees: [
            {
                path: interfaceWitness,
                files: interfaceFiles,
                layer: 'interface',
            },
            { path: coqueWitness, files: coqueFiles, layer: 'coque' },
        ],
    };
}

// Arbres témoins d'une appli posés dans le produit (source unique de la
// transaction et des preuves natives).
export async function stageWitnessTrees(plan, app) {
    for (const tree of witnessFiles(plan, app).trees)
        await stageGeneratedTree(
            resolve(plan.productRoot, tree.path),
            tree.files
        );
}

// Contrôles du témoin (v3 V3.5 a point 2), dans l'ordre : socle, interface
// témoin, coque témoin, chacun compilé sans émettre (ngc en Angular, tsc en
// React) ; PUIS l'ESLint de l'interface sur l'interface témoin
// (configuration d'après et amorces de toutes les pages : une amorce doit
// respecter les règles de l'interface), lancé depuis la racine du produit
// avec la configuration de l'interface témoin, sans avertissement admis. La
// règle de frontières de Nx lit le graphe EN CACHE et ne vise que les
// fichiers d'un projet : elle se tait dans le témoin, qui n'en est pas un ;
// les autres règles de l'interface s'y appliquent. `bin` : [paquet,
// exécutable] du produit installé ; chemins absolus. Source unique de
// l'exécution et des tests.
export function witnessControls(plan, app) {
    const compiler =
        app.profile === 'angular-pwa'
            ? ['@angular/compiler-cli', 'ngc']
            : ['typescript', 'tsc'];
    const { socle, trees } = witnessFiles(plan, app);
    const at = (path) => resolve(plan.productRoot, path);
    const label = (name) => `witness:${app.app_name}:${name}`;
    const ui = trees.find(({ layer }) => layer === 'interface').path;
    return [
        ...[
            { layer: 'socle', config: `${socle}/tsconfig.lib.json` },
            ...trees.map(({ path, layer }) => ({
                layer,
                config: `${path}/${WITNESS_CONFIG}`,
            })),
        ].map(({ layer, config }) => ({
            layer,
            label: label(layer),
            bin: compiler,
            args: ['-p', at(config), '--noEmit'],
        })),
        {
            layer: 'interface',
            label: label('interface-lint'),
            bin: ['eslint', 'eslint'],
            args: [
                '--config',
                at(`${ui}/eslint.config.mjs`),
                '--max-warnings',
                '0',
                at(ui),
            ],
        },
    ];
}

function generatorBroken(app, location) {
    externalFailure(
        `UPDATE_GENERATOR_BROKEN ${location.layer} ${location.path} (app ${app})`
    );
}

async function witness(plan, apps, run, phase) {
    for (const app of apps) {
        await stageWitnessTrees(plan, app);
        for (const control of witnessControls(plan, app)) {
            const failure = await collected(
                run,
                process.execPath,
                [installedBin(plan, ...control.bin), ...control.args],
                plan.productRoot
            );
            if (failure !== null)
                generatorBroken(
                    app.app_name,
                    failureLocation(app.app_name, failure, plan.productRoot, {
                        layer: control.layer,
                        path: layerRoot(app.app_name, control.layer),
                    })
                );
            await phase(control.label, plan);
        }
    }
}

const projectLayer = (app, project) =>
    project === `${interfaceLibraryName(app)}`
        ? 'interface'
        : project === basename(socleRoot(app))
          ? 'socle'
          : 'coque';
const layerRoot = (app, layer) =>
    layer === 'interface'
        ? interfaceRoot(app)
        : layer === 'socle'
          ? socleRoot(app)
          : coqueRoot(app);

function nx(plan, label) {
    return [
        installedBin(plan, 'nx', 'nx'),
        'run',
        label,
        '--skipNxCache',
        '--outputStyle=stream',
    ];
}

// Après les échanges : contrôles du SOCLE, bloquants (un rouge est une faute
// du générateur), puis contrat de l'espace.
async function socleControls(plan, apps, run, phase) {
    for (const app of apps) {
        for (const control of nativeControls(app.app_name, app.product)) {
            if (projectLayer(app.app_name, control.project) !== 'socle')
                continue;
            const failure = await collected(
                run,
                process.execPath,
                nx(plan, control.label),
                plan.productRoot
            );
            if (failure !== null)
                generatorBroken(
                    app.app_name,
                    failureLocation(app.app_name, failure, plan.productRoot, {
                        layer: 'socle',
                        path: socleRoot(app.app_name),
                    })
                );
            await phase(control.label, plan);
        }
    }
    await run(
        process.execPath,
        [
            resolve(
                plan.productRoot,
                `${EXTERNAL_WORKSPACE_SIGNATURE.support}/check-workspace.mjs`
            ),
        ],
        plan.productRoot
    );
    await assertSourceWeight(plan.productRoot);
}

// Appli réelle (coque et interface de l'IA), lancée et RAPPORTÉE sans
// bloquer (lecture A) : la ligne nomme la couche et le premier fichier du
// premier contrôle rouge, appli par appli dans l'ordre des noms.
async function interfaceReport(plan, apps, run, phase) {
    let first = null;
    for (const app of apps)
        for (const control of nativeControls(app.app_name, app.product)) {
            if (projectLayer(app.app_name, control.project) === 'socle')
                continue;
            const failure = await collected(
                run,
                process.execPath,
                nx(plan, control.label),
                plan.productRoot
            );
            if (failure !== null && first === null) {
                const layer = projectLayer(app.app_name, control.project);
                first = failureLocation(
                    app.app_name,
                    failure,
                    plan.productRoot,
                    {
                        layer,
                        path: layerRoot(app.app_name, layer),
                    }
                );
            }
            await phase(control.label, plan);
        }
    return first === null
        ? `${REPORT_PREFIX} VERT`
        : `${REPORT_PREFIX} ROUGE ${first.layer} ${first.path}`;
}

// Post-condition `derived` : rendu aux sources PRÉSENTES par les renderers
// RÉELS (jamais ceux qu'une preuve injecte), le produit mis à jour n'a plus
// rien à changer.
async function assertDerived(options, internal) {
    try {
        await planApplicationUpdate(options, internal);
    } catch (error) {
        if (error.message === 'external application: update without change')
            return;
        throw error;
    }
    externalFailure(
        'UPDATE_NOT_DERIVED: the updated product differs from its render'
    );
}

// Rejeu d'une mise à jour faite (v2 R2.1.4) : le dernier enregistrement d'une
// appli porte déjà ce `plan_id`.
async function alreadyUpdated(options, productRoot) {
    await readOwnedWorkspace({ ...options, command: 'update-app' });
    for (const name of await ownedAppNames(productRoot)) {
        const manifest = JSON.parse(
            (
                await readProductFile(productRoot, appManifestPath(name))
            ).toString('utf8')
        );
        const last = manifest.ownership?.publications?.at(-1);
        if (
            last?.tool === UPDATE_TOOL &&
            last.plan_id === options.expectedPlanId
        )
            return true;
    }
    return false;
}

async function appOutputs(productRoot) {
    return (await ownedAppNames(productRoot)).map((name) =>
        resolve(productRoot, APPS_ROOT, name)
    );
}

export async function publishApplicationUpdate(options, dependencies = {}) {
    if (!HEX.test(options.expectedPlanId ?? ''))
        externalFailure('update requires a reviewed plan');
    const run = dependencies.run ?? runExternalApplicationCommand;
    const phase = dependencies.phase ?? (() => undefined);
    // Injectable pour éprouver un arrêt à chaque échange de racine.
    const swap = dependencies.rename ?? renameAndSync;
    const { productRoot } = await externalApplicationContext({
        workspaceRoot: options.workspaceRoot ?? repositoryRoot,
        targetRoot: options.targetRoot,
    });
    return withProductWriterLocks(
        productRoot,
        await appOutputs(productRoot),
        async () => {
            if (await alreadyUpdated(options, productRoot))
                return {
                    plan_id: options.expectedPlanId,
                    replayed: true,
                    report: null,
                };
            const plan = await planApplicationUpdate(options, {}, dependencies);
            if (plan.plan_id !== options.expectedPlanId)
                externalFailure('reviewed update plan is stale');
            const internal = { transaction: plan.plan_id };
            const recheck = async () => {
                const current = await planApplicationUpdate(
                    options,
                    internal,
                    dependencies
                );
                if (current.plan_id !== plan.plan_id)
                    externalFailure('update inputs changed');
            };
            const apps = plan.apps.filter((app) => app.status === 'updated');
            const trees = apps.flatMap((app) =>
                transactionTrees(
                    plan.productRoot,
                    GENRE,
                    plan.plan_id,
                    app.trees
                )
            );
            const operations = [];
            const copies = [];
            const contents = [];
            for (const app of apps) {
                if (Object.keys(app.interface.files).length === 0) continue;
                const prepared = await prepareFilesOperation(
                    plan.productRoot,
                    app.interface.root,
                    app.interface.files,
                    operations.length
                );
                operations.push(prepared.operation);
                copies.push(...prepared.copies);
                contents.push(app.interface.files);
            }
            const root = transactionJournalRoot(
                plan.productRoot,
                GENRE,
                plan.plan_id
            );
            const journal = journalOf(
                plan,
                apps.map((app) => app.app_name),
                trees,
                operations
            );
            await poseTransactionJournal(
                plan.productRoot,
                stagingPrefix(plan.productRoot),
                root,
                copies,
                journal
            );
            const step = async (name) => {
                journal.phase = name;
                await writeTransactionJournal(root, journal);
            };
            try {
                for (const tree of trees)
                    await stageGeneratedTree(
                        resolve(tree.parent, tree.candidate),
                        tree.content
                    );
                await phase('candidate-staged', plan);
                await recheck();
                await witness(plan, apps, run, phase);
                // Les arbres témoins sont retirés AVANT l'échange : leurs
                // `project.json` (dossier caché que le `.gitignore` du
                // produit n'ignore pas) feraient voir à Nx deux projets du
                // même nom aux contrôles d'après l'échange.
                await removeWitnesses(plan.productRoot, journal);
                await phase('witnessed', plan);
                await recheck();
                // Les candidats sont vérifiés à l'octet en DERNIER, juste
                // avant le premier échange : un fichier glissé après les
                // contrôles n'est jamais échangé.
                await verifyTransactionTrees(trees, 'candidate');
                await step('staged');
                for (const tree of trees) {
                    await swapTree(tree, swap);
                    await phase(`swapped:${tree.root}`, plan);
                }
                for (const [index, operation] of operations.entries())
                    await swapFiles(
                        plan.productRoot,
                        operation,
                        contents[index],
                        plan.plan_id,
                        (name) => phase(name, plan)
                    );
                await step('swapped');
                await phase('published', plan);
                await verifyTransactionTrees(trees);
                await socleControls(plan, apps, run, phase);
                await assertDerived(options, internal);
                await phase('derived', plan);
                const report = await interfaceReport(plan, apps, run, phase);
                await step('verified');
                await phase('verified', plan);
                await completeUpdate(plan.productRoot, journal);
                return { plan_id: plan.plan_id, replayed: false, plan, report };
            } catch (error) {
                try {
                    const current = await readJournal(
                        plan.productRoot,
                        plan.plan_id
                    );
                    if (current.phase === 'verified')
                        await completeUpdate(plan.productRoot, current);
                    else await revertUpdate(plan.productRoot, current);
                } catch (rollbackError) {
                    throw new AggregateError(
                        [error, rollbackError],
                        `external application: update rollback refused; run ${UPDATE_RECOVERY_COMMAND}`,
                        { cause: rollbackError }
                    );
                }
                throw error;
            }
        }
    );
}

// Commande de reprise (`recover:application-update`) : racine du produit
// vérifiée, marqueur présent, puis verrous ; la mise à jour interrompue est
// finie (verified) ou annulée selon son état observé, ou refusée comme
// ambiguë sans rien déplacer. Un arbre de travail de mise à jour sans
// journal est ambigu ; les dossiers de préparation d'un journal jamais posé
// sont retirés.
export async function recoverApplicationUpdate(options) {
    const context = await externalApplicationContext({
        workspaceRoot: options.workspaceRoot ?? repositoryRoot,
        targetRoot: options.targetRoot,
    });
    if (
        !(await pathExists(
            resolve(context.productRoot, EXTERNAL_WORKSPACE_SIGNATURE.manifest)
        ))
    )
        externalFailure('workspace ownership marker missing');
    const productRoot = context.productRoot;
    return withProductWriterLocks(
        productRoot,
        await appOutputs(productRoot),
        async () => {
            const journals = (await pendingTransactionJournals(productRoot))
                .filter(({ genre }) => genre === GENRE)
                .map(({ planId }) => planId);
            if (journals.length > 1)
                ambiguous('several interrupted updates', {
                    tree: null,
                    path: null,
                    kind: 'several',
                });
            for (const space of [APPS_ROOT, LIBS_ROOT]) {
                const parent = resolve(productRoot, space);
                if (!(await pathExists(parent))) continue;
                for (const name of await readdir(parent)) {
                    const match = WORKING_TREE.exec(name);
                    if (match?.[2] === GENRE && !journals.includes(match[4]))
                        ambiguous('working tree without a journal', {
                            tree: `${space}/${name}`,
                            path: null,
                            kind: 'orphan',
                        });
                }
            }
            let direction = null;
            if (journals.length === 1) {
                const journal = await readJournal(productRoot, journals[0]);
                direction = journal.phase === 'verified' ? 'forward' : 'back';
                if (direction === 'forward')
                    await completeUpdate(productRoot, journal);
                else await revertUpdate(productRoot, journal);
            }
            await removeStagingDirectories(
                productRoot,
                stagingPrefix(productRoot)
            );
            // Reprise (V3.2) : la fraîcheur est rapportée, l'intégrité exigée.
            if (direction !== null)
                await readOwnedWorkspace({
                    ...options,
                    workspaceRoot: context.toolsRoot,
                    targetRoot: productRoot,
                    command: UPDATE_RECOVERY_COMMAND,
                });
            return { recovered: direction !== null, direction };
        }
    );
}

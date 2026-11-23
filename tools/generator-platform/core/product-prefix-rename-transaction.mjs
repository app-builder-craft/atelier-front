// Lot MARQUE, commit 3 : transaction de `rename-product-prefix` et sa reprise
// (`recover:product-prefix`). Mêmes briques qu'une publication (ADR-0103) :
// verrous, candidats, échanges par renommage, journal écrit par renommage
// atomique. Le journal vit à côté du produit ; le point de non-retour est la
// phase `verified`, posée après la post-condition `derived` et les contrôles
// natifs. Avant elle, toute reprise revient à l'état d'avant, décidée par
// l'état OBSERVÉ (empreintes), jamais par la phase seule. Journal, état
// observé des arbres, retour, fin et nettoyage viennent de la brique commune
// (`product-transaction.mjs`) ; restent ici le contenu du journal, la bascule
// du manifeste d'espace et les contrôles propres au renommage.
import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { EXTERNAL_WORKSPACE_SIGNATURE } from '../renderers/application-workspace-renderer.mjs';
import { repositoryRoot } from '../validate-ir.mjs';
import { lastWriters, RENAME_TOOL } from './application-ownership.mjs';
import {
    installedBin,
    readOwnedWorkspace,
    runExternalApplicationCommand,
} from './application-workspace.mjs';
import {
    pendingRenameJournals,
    renameJournalRoot,
    sealedProductPrefix,
} from './application-workspace-root.mjs';
import { SIGNATURE, SIGNATURE_FILES } from './atelier-signature.mjs';
import {
    assertSourceWeight,
    externalApplicationContext,
    externalFailure,
    fileArtifacts,
    pathExists,
    readProductFile,
    stageGeneratedTree,
    verifyGeneratedTree,
} from './external-application-paths.mjs';
import { PAGE_COMPOSITION_TOOL } from './external-publication-paths.mjs';
import { sha256 } from './generation-manifest.mjs';
import {
    removeTreeAndSync,
    renameAndSync,
    withProductWriterLocks,
    writeDocument,
} from './generation-transaction.mjs';
import {
    assertOnlyPrefix,
    planProductPrefixRename,
    renderAppForPrefix,
} from './product-prefix-rename.mjs';
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

const APP_MANIFEST = SIGNATURE_FILES.appManifest;
const WORKSPACE_MANIFEST = SIGNATURE_FILES.workspaceManifest;
const PREVIOUS_WORKSPACE = 'workspace.previous.json';
const HEX = /^[a-f0-9]{64}$/;
const APP_NAME = /^[a-z][a-z0-9-]*$/;
export const RENAME_PHASES = Object.freeze([
    'prepared',
    'staged',
    'swapped',
    'switched',
    'derived',
    'verified',
]);

// Fichier temporaire de la bascule : DANS le dossier de signature du produit ;
// son renommage est le seul remplacement de fichier hors de apps/ (S5).
const switchTemporary = (productRoot, planId) =>
    resolve(productRoot, SIGNATURE.dir, `.workspace-rename-${planId}.tmp`);
const stagingPrefix = (productRoot) =>
    `.${basename(productRoot)}.rename-staging-`;

function ambiguous(detail) {
    externalFailure(`ambiguous interrupted prefix rename: ${detail}`);
}

function notDerived(app, path) {
    externalFailure(
        `PRODUCT_RENAME_NOT_DERIVED: app ${app} path ${path} differs from its render with the sealed prefix`
    );
}

function journalOf(plan) {
    return {
        schema_version: '1.0.0',
        kind: 'product-prefix-rename-journal',
        plan_id: plan.plan_id,
        prefix_before: plan.prefix_before,
        prefix_after: plan.prefix_after,
        workspace_id_before: plan.workspace_id_before,
        workspace_id_after: plan.workspace_id_after,
        workspace_manifest_before_sha256: sha256(
            plan.workspace_manifest_before
        ),
        workspace_manifest_after_sha256: sha256(plan.workspace_manifest_after),
        apps: plan.apps.map((app) => ({
            app_name: app.app_name,
            manifest_before_sha256: app.manifest_before_sha256,
            manifest_after_sha256: app.manifest_after_sha256,
            candidate: basename(app.candidate),
            previous: basename(app.previous),
            files: fileArtifacts(app.next),
        })),
        phase: 'prepared',
    };
}

const JOURNAL_KEYS = [
    'schema_version',
    'kind',
    'plan_id',
    'prefix_before',
    'prefix_after',
    'workspace_id_before',
    'workspace_id_after',
    'workspace_manifest_before_sha256',
    'workspace_manifest_after_sha256',
    'apps',
    'phase',
];
const JOURNAL_APP_KEYS = [
    'app_name',
    'manifest_before_sha256',
    'manifest_after_sha256',
    'candidate',
    'previous',
    'files',
];

const validJournal = (journal, planId) =>
    exactKeys(journal, JOURNAL_KEYS) &&
    journal.schema_version === '1.0.0' &&
    journal.kind === 'product-prefix-rename-journal' &&
    journal.plan_id === planId &&
    RENAME_PHASES.includes(journal.phase) &&
    [
        journal.workspace_id_before,
        journal.workspace_id_after,
        journal.workspace_manifest_before_sha256,
        journal.workspace_manifest_after_sha256,
    ].every((value) => HEX.test(value ?? '')) &&
    Array.isArray(journal.apps) &&
    journal.apps.length > 0 &&
    journal.apps.every(
        (app) =>
            exactKeys(app, JOURNAL_APP_KEYS) &&
            APP_NAME.test(app.app_name ?? '') &&
            HEX.test(app.manifest_before_sha256 ?? '') &&
            HEX.test(app.manifest_after_sha256 ?? '') &&
            app.candidate === `.${app.app_name}.rename-candidate-${planId}` &&
            app.previous === `.${app.app_name}.rename-previous-${planId}` &&
            Array.isArray(app.files) &&
            app.files.every(
                (file) =>
                    exactKeys(file, ['path', 'bytes', 'sha256']) &&
                    HEX.test(file.sha256 ?? '')
            )
    );

const readJournal = (root, planId) =>
    readTransactionJournal(
        root,
        (journal) => validJournal(journal, planId),
        ambiguous
    );

const workspaceManifestPath = (productRoot) =>
    resolve(productRoot, WORKSPACE_MANIFEST);

// Arbres de chaque appli inscrite au journal, dans apps/ : noms, artefacts du
// candidat et empreintes de manifeste attendues avant et après.
const appsRoot = (productRoot) => resolve(productRoot, 'apps');
const journalTrees = (journal) =>
    journal.apps.map((app) => ({
        name: app.app_name,
        candidate: app.candidate,
        previous: app.previous,
        files: app.files,
        before: app.manifest_before_sha256,
        after: app.manifest_after_sha256,
        label: `app ${app.app_name}`,
    }));

// Retour à l'état d'avant (phase < verified), décidé par l'état observé.
// Tout est contrôlé AVANT le premier déplacement : un état ambigu est refusé
// et rien n'est retiré (règle C).
async function revertRename(productRoot, journal) {
    const root = renameJournalRoot(productRoot, journal.plan_id);
    const temporary = switchTemporary(productRoot, journal.plan_id);
    const observed = sha256(
        await readProductFile(productRoot, WORKSPACE_MANIFEST)
    );
    const before = journal.workspace_manifest_before_sha256;
    const after = journal.workspace_manifest_after_sha256;
    if (observed !== before && observed !== after)
        ambiguous('workspace manifest matches neither side');
    let copy;
    if (observed === after) {
        copy = await readFile(resolve(root, PREVIOUS_WORKSPACE));
        if (sha256(copy) !== before)
            ambiguous('previous workspace copy drifted');
    }
    const hasTemporary = await pathExists(temporary);
    if (hasTemporary) {
        const content = sha256(await readFile(temporary));
        if (content !== before && content !== after)
            ambiguous('switch temporary drifted');
    }
    const actions = await planTreesRevert(
        appsRoot(productRoot),
        journalTrees(journal),
        ambiguous
    );
    // Contrôles faits : déplacements, chacun atomique et rejouable.
    if (hasTemporary) await removeTreeAndSync(temporary);
    if (copy) {
        await writeDocument(temporary, copy);
        await renameAndSync(temporary, workspaceManifestPath(productRoot));
    }
    await revertTrees(actions);
    await removeTreeAndSync(root);
}

// Phase `verified` : en avant, nettoyage seul, après contrôle de l'état.
async function completeRename(productRoot, journal) {
    const root = renameJournalRoot(productRoot, journal.plan_id);
    if (
        sha256(await readProductFile(productRoot, WORKSPACE_MANIFEST)) !==
            journal.workspace_manifest_after_sha256 ||
        (await pathExists(switchTemporary(productRoot, journal.plan_id)))
    )
        ambiguous('verified rename does not match its workspace manifest');
    await completeTrees(
        appsRoot(productRoot),
        journalTrees(journal),
        ambiguous
    );
    await removeTreeAndSync(root);
}

// Dossiers de préparation d'un journal jamais posé : sans effet, retirés sous
// verrou du produit.
const removeStaging = (productRoot) =>
    removeStagingDirectories(productRoot, stagingPrefix(productRoot));

// Post-condition `derived` (A) : depuis l'espace basculé, préfixe scellé
// relu, coque et compositions rendues avec lui (renderers réels), comparées à
// l'octet aux fichiers écrits ET aux `changes` de l'enregistrement.
async function assertDerived(plan, options) {
    const internal = { renaming: plan.plan_id };
    const sealed = await sealedProductPrefix(plan.productRoot);
    if (sealed !== plan.prefix_after) notDerived('-', WORKSPACE_MANIFEST);
    const context = {
        productRoot: plan.productRoot,
        toolsRoot: plan.toolsRoot,
    };
    for (const app of plan.apps) {
        const text = (
            await readProductFile(app.outputAbsolute, APP_MANIFEST)
        ).toString('utf8');
        if (sha256(text) !== app.manifest_after_sha256)
            notDerived(app.app_name, APP_MANIFEST);
        const manifest = JSON.parse(text);
        const record = manifest.ownership.publications.at(-1);
        if (record?.tool !== RENAME_TOOL || record.plan_id !== plan.plan_id)
            notDerived(app.app_name, APP_MANIFEST);
        const rendered = await renderAppForPrefix(
            context,
            options,
            manifest,
            app.pages,
            sealed,
            { internal }
        );
        const files = { ...rendered.shell.files, ...rendered.compositions };
        const read = async (path) =>
            (await pathExists(resolve(app.outputAbsolute, path)))
                ? (await readProductFile(app.outputAbsolute, path)).toString(
                      'utf8'
                  )
                : undefined;
        for (const change of record.files) {
            const disk = await read(change.path);
            if (change.change === 'removed') {
                if (disk !== undefined || Object.hasOwn(files, change.path))
                    notDerived(app.app_name, change.path);
                continue;
            }
            if (
                disk === undefined ||
                files[change.path] === undefined ||
                sha256(disk) !== change.sha256 ||
                sha256(files[change.path]) !== change.sha256
            )
                notDerived(app.app_name, change.path);
        }
        const writers = lastWriters(manifest, plan.workspace_id_after);
        for (const [path, content] of Object.entries(files)) {
            const writer = writers.get(path);
            if (
                [RENAME_TOOL, 'shell', PAGE_COMPOSITION_TOOL].includes(
                    writer
                ) &&
                (await read(path)) !== content
            )
                notDerived(app.app_name, path);
        }
    }
}

// Contrôles du point `verified`, sous le NOUVEL espace : sceaux et entrées
// (readOwnedWorkspace), contrôles natifs de chaque appli, contrat de l'espace,
// poids des sources, arbres exacts et contre-preuve dérivée.
async function verifyRenamed(plan, options, run) {
    const internal = { renaming: plan.plan_id };
    const owned = async () => {
        const workspace = await readOwnedWorkspace(options, internal);
        if (
            workspace.manifest.workspace_id !== plan.workspace_id_after ||
            workspace.manifest.identity.prefix !== plan.prefix_after
        )
            externalFailure('workspace changed during prefix rename');
    };
    await owned();
    for (const app of plan.apps)
        for (const target of ['build:production', 'lint', 'test']) {
            await run(
                process.execPath,
                [
                    installedBin(plan, 'nx', 'nx'),
                    'run',
                    `${app.app_name}:${target}`,
                    '--skipNxCache',
                    '--outputStyle=stream',
                ],
                plan.productRoot
            );
            await verifyGeneratedTree(app.outputAbsolute, app.next);
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
    for (const app of plan.apps) {
        await verifyGeneratedTree(app.outputAbsolute, app.next);
        assertOnlyPrefix(
            app.next,
            plan.prefix_after,
            (path) => `app ${app.app_name} path ${path}`
        );
    }
    await owned();
}

export async function publishProductPrefixRename(options, dependencies = {}) {
    if (!HEX.test(options.expectedPlanId ?? ''))
        externalFailure('prefix rename requires a reviewed plan');
    const run = dependencies.run ?? runExternalApplicationCommand;
    const phase = dependencies.phase ?? (() => undefined);
    // Injectable pour éprouver un échec à chaque échange et à la bascule.
    const swap = dependencies.rename ?? renameAndSync;
    const initial = await planProductPrefixRename(options, {}, dependencies);
    if (initial.plan_id !== options.expectedPlanId)
        externalFailure('reviewed rename plan is stale');
    return withProductWriterLocks(
        initial.productRoot,
        initial.apps.map((app) => app.outputAbsolute),
        async () => {
            await phase('locked', initial);
            await removeStaging(initial.productRoot);
            const plan = await planProductPrefixRename(
                options,
                {},
                dependencies
            );
            if (plan.plan_id !== initial.plan_id)
                externalFailure('reviewed rename plan is stale');
            const root = renameJournalRoot(plan.productRoot, plan.plan_id);
            const journal = journalOf(plan);
            // `prepared` : copie de l'ancien manifeste et journal écrits dans
            // un dossier de préparation, puis posés par un seul renommage.
            await poseTransactionJournal(
                plan.productRoot,
                stagingPrefix(plan.productRoot),
                root,
                [[PREVIOUS_WORKSPACE, plan.workspace_manifest_before]],
                journal
            );
            const step = async (name) => {
                journal.phase = name;
                await writeTransactionJournal(root, journal);
                await phase(name, plan);
            };
            try {
                await phase('prepared', plan);
                for (const app of plan.apps) {
                    await stageGeneratedTree(app.candidate, app.next);
                    await phase('candidate-staged', plan, app);
                }
                for (const app of plan.apps) {
                    const angular = app.profile === 'angular-pwa';
                    await run(
                        process.execPath,
                        [
                            installedBin(
                                plan,
                                angular
                                    ? '@angular/compiler-cli'
                                    : 'typescript',
                                angular ? 'ngc' : 'tsc'
                            ),
                            '-p',
                            resolve(app.candidate, 'tsconfig.app.json'),
                            '--noEmit',
                        ],
                        plan.productRoot
                    );
                    await verifyGeneratedTree(app.candidate, app.next);
                }
                await step('staged');
                for (const app of plan.apps)
                    await swapTree(
                        app.outputAbsolute,
                        app.candidate,
                        app.previous,
                        swap
                    );
                await step('swapped');
                const temporary = switchTemporary(
                    plan.productRoot,
                    plan.plan_id
                );
                await writeDocument(temporary, plan.workspace_manifest_after);
                await swap(temporary, workspaceManifestPath(plan.productRoot));
                await step('switched');
                await assertDerived(plan, options);
                await step('derived');
                await verifyRenamed(plan, options, run);
                await step('verified');
            } catch (error) {
                try {
                    const current = await readJournal(root, plan.plan_id);
                    if (current.phase === 'verified')
                        await completeRename(plan.productRoot, current);
                    else await revertRename(plan.productRoot, current);
                } catch (rollbackError) {
                    throw new AggregateError(
                        [error, rollbackError],
                        'external application: prefix rename rollback refused; run recover:product-prefix',
                        { cause: rollbackError }
                    );
                }
                throw error;
            }
            await completeRename(plan.productRoot, journal);
            return { plan_id: plan.plan_id, status: 'renamed', plan };
        }
    );
}

// Arbres de renommage présents dans apps/ : appli, genre, plan_id.
async function renameTrees(productRoot) {
    const found = [];
    const apps = resolve(productRoot, 'apps');
    if (!(await pathExists(apps))) return found;
    for (const name of await readdir(apps)) {
        const match =
            /^\.([a-z][a-z0-9-]*)\.rename-(candidate|previous)-([a-f0-9]{64})$/.exec(
                name
            );
        if (match)
            found.push({ app: match[1], kind: match[2], planId: match[3] });
    }
    return found;
}

async function recoverUnderLocks(productRoot, options) {
    const journals = await pendingRenameJournals(productRoot);
    const strays = await renameTrees(productRoot);
    if (journals.length === 0) {
        if (strays.length) ambiguous('rename trees without a journal');
        await removeStaging(productRoot);
        return { recovered: false };
    }
    if (journals.length > 1) ambiguous('several rename journals');
    const [planId] = journals;
    const journal = await readJournal(
        renameJournalRoot(productRoot, planId),
        planId
    );
    if (
        strays.some(
            (tree) =>
                tree.planId !== planId ||
                !journal.apps.some((app) => app.app_name === tree.app)
        )
    )
        ambiguous('rename trees of another plan');
    const forward = journal.phase === 'verified';
    if (forward) await completeRename(productRoot, journal);
    else await revertRename(productRoot, journal);
    await removeStaging(productRoot);
    // L'état retrouvé doit être un produit possédé, cohérent.
    await readOwnedWorkspace(options);
    return {
        recovered: true,
        plan_id: planId,
        direction: forward ? 'forward' : 'back',
        prefix: forward ? journal.prefix_after : journal.prefix_before,
    };
}

// Commande de reprise explicite : mêmes verrous que le renommage (produit,
// puis chaque appli vue dans apps/ ou dans ses arbres de travail).
export async function recoverProductPrefixRename(options) {
    const context = await externalApplicationContext({
        workspaceRoot: options.workspaceRoot ?? repositoryRoot,
        targetRoot: options.targetRoot,
    });
    const { productRoot } = context;
    if (!(await pathExists(workspaceManifestPath(productRoot))))
        externalFailure('workspace ownership marker missing');
    const names = new Set();
    for (const entry of await readdir(resolve(productRoot, 'apps'), {
        withFileTypes: true,
    }))
        if (entry.isDirectory() && APP_NAME.test(entry.name))
            names.add(entry.name);
    for (const tree of await renameTrees(productRoot)) names.add(tree.app);
    return withProductWriterLocks(
        productRoot,
        [...names].map((name) => resolve(productRoot, 'apps', name)),
        () =>
            recoverUnderLocks(productRoot, {
                ...options,
                workspaceRoot: context.toolsRoot,
                targetRoot: productRoot,
            })
    );
}

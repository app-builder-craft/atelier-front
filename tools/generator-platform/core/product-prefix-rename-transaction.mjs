// Lot MARQUE, commit 3 : transaction de `rename-product-prefix` et sa reprise
// (`recover:product-prefix`). Mêmes briques qu'une publication (ADR-0103) :
// verrous, candidats, échanges par renommage, journal écrit par renommage
// atomique. Le journal vit à côté du produit ; le point de non-retour est la
// phase `verified`, posée après la post-condition `derived` et les contrôles
// natifs. Avant elle, toute reprise revient à l'état d'avant, décidée par
// l'état OBSERVÉ (empreintes), jamais par la phase seule.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

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
    treeInventory,
    verifyGeneratedTree,
} from './external-application-paths.mjs';
import { PAGE_COMPOSITION_TOOL } from './external-publication-paths.mjs';
import { sha256 } from './generation-manifest.mjs';
import {
    removeTreeAndSync,
    renameAndSync,
    syncTreeDirectories,
    withProductWriterLocks,
    writeDocument,
} from './generation-transaction.mjs';
import {
    assertOnlyPrefix,
    planProductPrefixRename,
    renderAppForPrefix,
} from './product-prefix-rename.mjs';

const APP_MANIFEST = SIGNATURE_FILES.appManifest;
const WORKSPACE_MANIFEST = SIGNATURE_FILES.workspaceManifest;
const JOURNAL = 'journal.json';
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

const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

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

async function writeJournal(root, journal) {
    const temporary = resolve(root, `.journal-${randomUUID()}.tmp`);
    await writeDocument(temporary, `${JSON.stringify(journal, null, 2)}\n`);
    await renameAndSync(temporary, resolve(root, JOURNAL));
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

async function readJournal(root, planId) {
    let journal;
    try {
        journal = JSON.parse(await readFile(resolve(root, JOURNAL), 'utf8'));
    } catch {
        ambiguous('unreadable journal');
    }
    const valid =
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
                app.candidate ===
                    `.${app.app_name}.rename-candidate-${planId}` &&
                app.previous === `.${app.app_name}.rename-previous-${planId}` &&
                Array.isArray(app.files) &&
                app.files.every(
                    (file) =>
                        exactKeys(file, ['path', 'bytes', 'sha256']) &&
                        HEX.test(file.sha256 ?? '')
                )
        );
    if (!valid) ambiguous('invalid journal');
    return journal;
}

// Empreinte du manifeste d'un arbre EXACT selon son propre manifeste, sinon
// `null` : un arbre changé n'est jamais déplacé.
async function exactTreeManifestSha(root) {
    try {
        const text = (await readProductFile(root, APP_MANIFEST)).toString(
            'utf8'
        );
        const files = { [APP_MANIFEST]: text };
        for (const entry of JSON.parse(text).generated_files) {
            const content = await readProductFile(root, entry.path);
            if (
                sha256(content) !== entry.sha256 ||
                content.length !== entry.bytes
            )
                return null;
            files[entry.path] = content.toString('utf8');
        }
        await verifyGeneratedTree(root, files);
        return sha256(text);
    } catch {
        return null;
    }
}

// Candidat partiel ou complet : chaque fichier présent est celui inscrit au
// journal, et aucun dossier n'est étranger à son inventaire.
async function candidateWithin(root, artifacts) {
    const expected = new Map(artifacts.map((entry) => [entry.path, entry]));
    try {
        for (const entry of await treeInventory(root)) {
            const wanted = expected.get(entry.path);
            if (
                !wanted ||
                wanted.sha256 !== entry.sha256 ||
                wanted.bytes !== entry.bytes
            )
                return false;
        }
        const directories = [];
        const visit = async (directory) => {
            for (const entry of await readdir(directory, {
                withFileTypes: true,
            }))
                if (entry.isDirectory()) {
                    const absolute = resolve(directory, entry.name);
                    directories.push(
                        `${relative(root, absolute).split(sep).join('/')}/`
                    );
                    await visit(absolute);
                }
        };
        await visit(root);
        return directories.every((prefix) =>
            [...expected.keys()].some((path) => path.startsWith(prefix))
        );
    } catch {
        return false;
    }
}

const workspaceManifestPath = (productRoot) =>
    resolve(productRoot, WORKSPACE_MANIFEST);

async function trees(productRoot, app) {
    const apps = resolve(productRoot, 'apps');
    const output = resolve(apps, app.app_name);
    const candidate = resolve(apps, app.candidate);
    const previous = resolve(apps, app.previous);
    const [hasOutput, hasCandidate, hasPrevious] = await Promise.all(
        [output, candidate, previous].map(pathExists)
    );
    return {
        output,
        candidate,
        previous,
        hasOutput,
        hasCandidate,
        hasPrevious,
    };
}

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
    const actions = [];
    for (const app of journal.apps) {
        const state = await trees(productRoot, app);
        const label = `app ${app.app_name}`;
        const outputSha = state.hasOutput
            ? await exactTreeManifestSha(state.output)
            : undefined;
        if (state.hasPrevious) {
            if (
                (await exactTreeManifestSha(state.previous)) !==
                app.manifest_before_sha256
            )
                ambiguous(`${label} previous tree drifted`);
            if (state.hasOutput) {
                if (state.hasCandidate) ambiguous(`${label} has several trees`);
                if (outputSha !== app.manifest_after_sha256)
                    ambiguous(`${label} renamed tree drifted`);
                actions.push({ kind: 'unswap', state });
            } else {
                if (
                    state.hasCandidate &&
                    !(await candidateWithin(state.candidate, app.files))
                )
                    ambiguous(`${label} candidate drifted`);
                actions.push({ kind: 'restore', state });
            }
            continue;
        }
        if (outputSha !== app.manifest_before_sha256)
            ambiguous(`${label} tree drifted`);
        if (state.hasCandidate) {
            if (!(await candidateWithin(state.candidate, app.files)))
                ambiguous(`${label} candidate drifted`);
            actions.push({ kind: 'dispose', state });
        }
    }
    // Contrôles faits : déplacements, chacun atomique et rejouable.
    if (hasTemporary) await removeTreeAndSync(temporary);
    if (copy) {
        await writeDocument(temporary, copy);
        await renameAndSync(temporary, workspaceManifestPath(productRoot));
    }
    for (const { kind, state } of actions) {
        if (kind === 'unswap') {
            await renameAndSync(state.output, state.candidate);
            await renameAndSync(state.previous, state.output);
        } else if (kind === 'restore')
            await renameAndSync(state.previous, state.output);
        if (await pathExists(state.candidate))
            await removeTreeAndSync(state.candidate);
    }
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
    const previous = [];
    for (const app of journal.apps) {
        const state = await trees(productRoot, app);
        if (
            state.hasCandidate ||
            !state.hasOutput ||
            (await exactTreeManifestSha(state.output)) !==
                app.manifest_after_sha256
        )
            ambiguous(`app ${app.app_name} renamed tree drifted`);
        if (state.hasPrevious) {
            if (
                (await exactTreeManifestSha(state.previous)) !==
                app.manifest_before_sha256
            )
                ambiguous(`app ${app.app_name} previous tree drifted`);
            previous.push(state.previous);
        }
    }
    for (const path of previous) await removeTreeAndSync(path);
    await removeTreeAndSync(root);
}

// Dossiers de préparation d'un journal jamais posé : sans effet, retirés sous
// verrou du produit.
async function removeStaging(productRoot) {
    const prefix = stagingPrefix(productRoot);
    for (const entry of await readdir(dirname(productRoot), {
        withFileTypes: true,
    }))
        if (entry.name.startsWith(prefix) && entry.isDirectory())
            await removeTreeAndSync(resolve(dirname(productRoot), entry.name));
}

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
            const staging = await mkdtemp(
                resolve(
                    dirname(plan.productRoot),
                    stagingPrefix(plan.productRoot)
                )
            );
            try {
                await writeDocument(
                    resolve(staging, PREVIOUS_WORKSPACE),
                    plan.workspace_manifest_before
                );
                await writeJournal(staging, journal);
                await syncTreeDirectories(staging);
                await renameAndSync(staging, root);
            } catch (error) {
                await removeTreeAndSync(staging);
                throw error;
            }
            const step = async (name) => {
                journal.phase = name;
                await writeJournal(root, journal);
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
                for (const app of plan.apps) {
                    await swap(app.outputAbsolute, app.previous);
                    await swap(app.candidate, app.outputAbsolute);
                }
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

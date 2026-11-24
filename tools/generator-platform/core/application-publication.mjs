// ADR-0103 : seule voie pour changer l'inventaire d'une application extérieure.
// Même modèle que create-app : plan relu, verrou, candidats, binaires du
// produit, échange atomique, contrôles natifs et retour arrière exact. Lot 2
// (conception v5, V5.2) : une publication écrit le manifeste dans la coque et
// ses sorties dans le socle ; sa transaction porte sur ces DEUX racines, sur
// la brique commune, avec un journal à côté du produit.
import { resolve } from 'node:path';

import { EXTERNAL_WORKSPACE_SIGNATURE } from '../renderers/application-workspace-renderer.mjs';
import { appManifestPath } from '../renderers/external-product-layout.mjs';
import {
    compileLibraryCandidates,
    qualifyProductInstallation,
    readOwnedWorkspace,
    runExternalApplicationCommand,
    runNativeControls,
    verifyTransactionTrees,
} from './application-workspace.mjs';
import { inputFilePath } from './application-workspace-root.mjs';
import {
    PUBLICATION_TOOLS,
    publishedManifest,
    verifyApplicationOwnership,
} from './application-ownership.mjs';
import {
    filesUnder,
    openTransaction,
    recoverApplicationTransactions,
    transactionTrees,
} from './application-transaction.mjs';
import { escapeRegExp } from './atelier-signature.mjs';
import { canonicalizeGeneratedFiles } from './canonicalize-generated.mjs';
import { repositoryRoot } from '../validate-ir.mjs';
import {
    assertSourceWeight,
    externalApplicationContext,
    externalFailure,
    fileArtifacts,
    pathExists,
    readProductFile,
    stageGeneratedTree,
} from './external-application-paths.mjs';
import { sha256, stableStringify } from './generation-manifest.mjs';
import {
    renameAndSync,
    withProductWriterLocks,
} from './generation-transaction.mjs';
import { swapTree } from './product-transaction.mjs';
import { coqueRoot, socleRoot } from './socle-names.mjs';

function appLocation(options) {
    if (!/^[a-z][a-z0-9-]*$/.test(options.appName ?? ''))
        externalFailure('invalid app name');
    if (typeof options.targetRoot !== 'string')
        externalFailure('publication requires a target root');
    const product = resolve(options.targetRoot);
    const apps = resolve(product, 'apps');
    return { product, apps, output: resolve(apps, options.appName) };
}

// Entrées du produit liées au plan (X2) : relues et comparées à chaque plan,
// donc aussi sous verrou. Une dérive périme la publication.
async function verifiedInputs(root, inputs) {
    if (!Array.isArray(inputs)) externalFailure('publication inputs invalid');
    const verified = [];
    for (const input of inputs) {
        if (
            !input ||
            typeof input.path !== 'string' ||
            !/^[a-f0-9]{64}$/.test(input.sha256 ?? '')
        )
            externalFailure('publication inputs invalid');
        const path = inputFilePath(input.path);
        if (sha256(await readProductFile(root, path)) !== input.sha256)
            externalFailure('publication input drift');
        verified.push({ path, sha256: input.sha256 });
    }
    verified.sort((left, right) => (left.path < right.path ? -1 : 1));
    if (
        verified.some(
            (entry, i) => i > 0 && verified[i - 1].path === entry.path
        )
    )
        externalFailure('publication inputs invalid');
    return verified;
}

// Un préfixe couvert (X2) est republié en entier : aucun fichier ancien sous
// ce préfixe ne peut rester sans être expliqué par la nouvelle sortie. Lot 2 :
// un préfixe couvert est un dossier des sources du SOCLE de l'appli.
function assertCoveredPrefix(prefix, files, current, appName) {
    if (prefix === undefined) return null;
    if (
        typeof prefix !== 'string' ||
        !new RegExp(
            `^${escapeRegExp(socleRoot(appName))}/src/[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)*/$`
        ).test(prefix)
    )
        externalFailure('publication covered prefix is invalid');
    if (Object.keys(files).some((path) => !path.startsWith(prefix)))
        externalFailure('publication outside its covered prefix');
    for (const path of current.keys())
        if (path.startsWith(prefix) && !Object.hasOwn(files, path))
            externalFailure('publication would leave an unexplained file');
    return prefix;
}

// Application courante : ses fichiers possédés et son manifeste, chemins
// relatifs au produit (lot 2, V3.1 point 4).
async function currentApplication(workspace, appName) {
    const root = resolve(workspace.productRoot, 'apps', appName);
    if (!(await pathExists(root))) externalFailure('application is absent');
    const manifestPath = appManifestPath(appName);
    const manifestBytes = await readProductFile(
        workspace.productRoot,
        manifestPath
    );
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const files = { [manifestPath]: manifestBytes.toString('utf8') };
    for (const entry of manifest.generated_files)
        files[entry.path] = (
            await readProductFile(workspace.productRoot, entry.path)
        ).toString('utf8');
    return { root, manifest, manifestBytes, files, manifestPath };
}

// Liaison d'une publication : tout ce que son `plan_id` engage. Exportée,
// avec `publicationPlanId`, pour recalculer un `plan_id` hors de cette
// fonction (paliers de non-régression du lot MARQUE) ; seule source de la
// forme de la liaison.
export function publicationBinding({
    workspace,
    installation,
    appName,
    appManifestBytes,
    tool,
    inputs,
    coveredPrefix,
    changes,
}) {
    return {
        tools_root: workspace.toolsRoot,
        target_root: workspace.productRoot,
        workspace_plan_id: workspace.plan_id,
        provenance: workspace.provenance,
        lock_sha256: installation.lock_sha256,
        installed: installation.metadata,
        app_name: appName,
        app_manifest_sha256: sha256(appManifestBytes),
        tool,
        inputs,
        covered_prefix: coveredPrefix,
        changes,
    };
}

export function publicationPlanId(binding) {
    return sha256(stableStringify(binding));
}

// `internal.transaction` : la publication elle-même, sous verrou, qui relit
// son plan pendant sa transaction (lot 2, V5.2).
export async function planApplicationPublication(options, internal = {}) {
    const { output } = appLocation(options);
    if (!PUBLICATION_TOOLS.includes(options.tool))
        externalFailure('publication tool is not declared');
    const entries = Object.entries(options.files ?? {});
    if (
        entries.length === 0 ||
        entries.some(([, content]) => typeof content !== 'string')
    )
        externalFailure('publication requires file contents');
    const workspace = await readOwnedWorkspace(options, internal);
    const workspaceId = workspace.manifest.workspace_id;
    const installation = await qualifyProductInstallation(workspace);
    const app = await currentApplication(workspace, options.appName);
    const current = new Map(
        app.manifest.generated_files.map((entry) => [entry.path, entry])
    );
    const coveredPrefix = assertCoveredPrefix(
        options.coveredPrefix,
        options.files,
        current,
        options.appName
    );
    const inputs = await verifiedInputs(
        workspace.productRoot,
        options.inputs ?? []
    );
    const changes = entries
        .filter(
            ([path, content]) =>
                !options.omitUnchanged ||
                current.get(path)?.sha256 !== sha256(content)
        )
        .map(([path, content]) => {
            const before = current.get(path);
            const change = {
                path,
                change: before ? 'replaced' : 'added',
                sha256: sha256(content),
                bytes: Buffer.byteLength(content),
            };
            if (before)
                change.before = { sha256: before.sha256, bytes: before.bytes };
            return change;
        })
        .sort((left, right) => (left.path < right.path ? -1 : 1));
    if (
        changes.length === 0 ||
        changes.some((entry) => entry.before?.sha256 === entry.sha256)
    )
        externalFailure('publication without change');
    const binding = publicationBinding({
        workspace,
        installation,
        appName: options.appName,
        appManifestBytes: app.manifestBytes,
        tool: options.tool,
        inputs,
        coveredPrefix,
        changes,
    });
    const planId = publicationPlanId(binding);
    const record = { plan_id: planId, tool: options.tool, files: changes };
    const next = publishedManifest(app.manifest, record, workspaceId);
    const manifestText = (
        await canonicalizeGeneratedFiles({
            [app.manifestPath]: JSON.stringify(next, null, 2) + '\n',
        })
    )[app.manifestPath];
    const files = { ...app.files, ...options.files };
    files[app.manifestPath] = manifestText;
    // Deux racines : la coque (manifeste) et le socle (sorties) ; chacune avec
    // ses listes d'artéfacts d'avant et d'après.
    const roots = [coqueRoot(options.appName), socleRoot(options.appName)].map(
        (root) => ({
            root,
            files: filesUnder(files, root),
            before: fileArtifacts(filesUnder(app.files, root)),
        })
    );
    return {
        plan_id: planId,
        app_name: options.appName,
        profile: app.manifest.profile,
        tool: options.tool,
        output: `apps/${options.appName}`,
        outputAbsolute: output,
        root: workspace.productRoot,
        changes,
        inputs,
        manifest_sha256: sha256(manifestText),
        files,
        previousFiles: app.files,
        roots,
        workspace,
        installation,
    };
}

export function publicApplicationPublicationPlan(plan) {
    return {
        schema_version: '1.0.0',
        plan_id: plan.plan_id,
        app_name: plan.app_name,
        tool: plan.tool,
        output: plan.output,
        inputs: plan.inputs,
        changes: plan.changes,
        manifest_sha256: plan.manifest_sha256,
    };
}

// Commande de reprise explicite (recover:application-publication) : racine du
// produit vérifiée, marqueur présent, puis verrous ; chaque transaction
// interrompue de l'appli (création ou publication) est finie ou annulée selon
// son état observé, ou refusée comme ambiguë sans rien déplacer.
export async function recoverApplicationPublication(options) {
    const { output } = appLocation(options);
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
    return withProductWriterLocks(context.productRoot, [output], async () => {
        const transactions = await recoverApplicationTransactions(
            context.productRoot,
            options.appName
        );
        if (transactions.length)
            await readOwnedWorkspace({
                ...options,
                workspaceRoot: context.toolsRoot,
                targetRoot: context.productRoot,
            });
        return { recovered: transactions.length > 0, transactions };
    });
}

// Lot 2 (V5.2) : la commande d'un outil relue reprend D'ABORD la transaction
// interrompue de son appli (verrous tenus), PUIS lit le produit pour rendre
// sa publication : sa lecture ne voit jamais un état de transaction, et toute
// autre commande reste refusée tant que la reprise n'est pas faite.
export async function publishRenderedPublication(
    options,
    render,
    dependencies
) {
    if (!/^[a-f0-9]{64}$/.test(options.expectedPlanId ?? ''))
        externalFailure('publication requires a reviewed plan');
    const { recovered } = await recoverApplicationPublication(options);
    const rendered = await render(options);
    const result = await publishApplicationPublication(
        { ...rendered.publication, expectedPlanId: options.expectedPlanId },
        dependencies
    );
    return {
        rendered,
        result: {
            ...result,
            recovered: recovered || result.recovered === true,
        },
    };
}

async function alreadyPublished(options) {
    const workspace = await readOwnedWorkspace(options);
    const app = await currentApplication(workspace, options.appName);
    return (
        app.manifest.ownership.publications.at(-1)?.plan_id ===
        options.expectedPlanId
    );
}

export async function publishApplicationPublication(
    options,
    dependencies = {}
) {
    if (!/^[a-f0-9]{64}$/.test(options.expectedPlanId ?? ''))
        externalFailure('publication requires a reviewed plan');
    const run = dependencies.run ?? runExternalApplicationCommand;
    const phase = dependencies.phase ?? (() => undefined);
    // Injectable pour éprouver un échec à chaque échange de racine.
    const swap = dependencies.rename ?? renameAndSync;
    const { product, output } = appLocation(options);
    return withProductWriterLocks(product, [output], async () => {
        // Une transaction interrompue de cette appli est reprise d'abord.
        const recovered =
            (await recoverApplicationTransactions(product, options.appName))
                .length > 0;
        if (await alreadyPublished(options))
            return {
                plan_id: options.expectedPlanId,
                replayed: true,
                recovered,
            };
        const plan = await planApplicationPublication(options);
        if (plan.plan_id !== options.expectedPlanId)
            externalFailure('reviewed publication plan is stale');
        const internal = { transaction: plan.plan_id };
        const recheck = async () => {
            const current = await planApplicationPublication(options, internal);
            if (current.plan_id !== plan.plan_id)
                externalFailure('publication inputs changed');
        };
        const trees = transactionTrees(
            plan.root,
            'publication',
            plan.plan_id,
            plan.roots
        );
        const transaction = await openTransaction(
            plan.root,
            'publication',
            plan.plan_id,
            plan.app_name,
            trees
        );
        try {
            for (const tree of trees)
                await stageGeneratedTree(
                    resolve(tree.parent, tree.candidate),
                    tree.content
                );
            await phase('candidate-staged', plan);
            await compileLibraryCandidates(plan, trees, run);
            await verifyTransactionTrees(trees, 'candidate');
            await phase('compiled', plan);
            await recheck();
            await transaction.step('staged');
            for (const tree of trees) {
                await swapTree(tree, swap);
                await phase(`swapped:${tree.root}`, plan);
            }
            await transaction.step('swapped');
            await phase('published', plan);
            await runNativeControls(plan, plan.files, run, async (label) => {
                await verifyTransactionTrees(trees);
                await phase(label, plan);
            });
            await run(
                process.execPath,
                [
                    resolve(
                        plan.root,
                        `${EXTERNAL_WORKSPACE_SIGNATURE.support}/check-workspace.mjs`
                    ),
                ],
                plan.root
            );
            await assertSourceWeight(plan.root);
            await verifyTransactionTrees(trees);
            const after = await readOwnedWorkspace(options, internal);
            if (after.plan_id !== plan.workspace.plan_id)
                externalFailure('workspace changed during publication');
            verifyApplicationOwnership(
                JSON.parse(plan.files[appManifestPath(plan.app_name)]),
                after.manifest.workspace_id
            );
            await transaction.step('verified');
            await phase('verified', plan);
            await transaction.complete();
            return {
                plan_id: plan.plan_id,
                replayed: false,
                recovered,
                plan,
            };
        } catch (error) {
            try {
                await transaction.settle();
            } catch (rollbackError) {
                throw new AggregateError(
                    [error, rollbackError],
                    'external application: publication rollback refused; run recover:application-publication',
                    { cause: rollbackError }
                );
            }
            throw error;
        }
    });
}

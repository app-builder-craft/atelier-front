// Lot MARQUE, commit 3 : plan de `rename-product-prefix` (voie R2). Le
// renommage d'un produit extérieur ajoute à chaque appli un enregistrement
// `rename-product-prefix` (ADR-0103) ; aucun enregistrement existant n'est
// réécrit. Sa zone est DÉRIVÉE ici : les chemins dont le rendu en `q` diffère
// du rendu en `p` (coque et compositions), plus la paire de scripts d'entrée
// nginx. Ce module ne fait que planifier ; la transaction est dans
// `product-prefix-rename-transaction.mjs`.
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
    lastWriters,
    RENAME_TOOL,
    renamedManifest,
    renameMayReplace,
} from './application-ownership.mjs';
import {
    qualifyProductInstallation,
    readOwnedWorkspace,
    renamedWorkspaceManifest,
    renderExternalShellFiles,
} from './application-workspace.mjs';
import { escapeRegExp, SIGNATURE_FILES } from './atelier-signature.mjs';
import { canonicalizeGeneratedFiles } from './canonicalize-generated.mjs';
import {
    externalFailure,
    readProductFile,
    relayEnvshPath,
} from './external-application-paths.mjs';
import { expectedExternalPageCompositionFiles } from './external-page-composition.mjs';
import {
    PAGE_COMPOSITION_TOOL,
    pageCompositionRoot,
} from './external-publication-paths.mjs';
import { sha256, stableStringify } from './generation-manifest.mjs';
import {
    PRODUCT_NAME_FAMILIES,
    prefixRefusals,
    productForms,
    productNameForms,
} from './product-identity.mjs';
import { prefixContext } from './product-prefix.mjs';

const APP_MANIFEST = SIGNATURE_FILES.appManifest;
const WORKSPACE_MANIFEST = SIGNATURE_FILES.workspaceManifest;
const COMPOSITION_MANIFEST = 'generation-manifest.json';

// Liaison du renommage : tout ce que son `plan_id` engage (S3). Exportée,
// avec `renamePlanId`, comme `publicationBinding`.
export function renameBinding({
    workspace,
    installation,
    prefixAfter,
    workspaceIdAfter,
    apps,
}) {
    return {
        tools_root: workspace.toolsRoot,
        target_root: workspace.productRoot,
        workspace_plan_id: workspace.plan_id,
        provenance: workspace.provenance,
        lock_sha256: installation.lock_sha256,
        installed: installation.metadata,
        workspace_manifest_sha256: sha256(workspace.files[WORKSPACE_MANIFEST]),
        prefix_before: workspace.manifest.identity.prefix,
        prefix_after: prefixAfter,
        workspace_id_before: workspace.manifest.workspace_id,
        workspace_id_after: workspaceIdAfter,
        apps: apps.map((app) => ({
            app_name: app.app_name,
            app_manifest_sha256: app.manifest_before_sha256,
            changes: app.changes,
        })),
    };
}

export function renamePlanId(binding) {
    return sha256(stableStringify(binding));
}

// Arbres de travail d'un renommage dans apps/, nommés par son plan_id.
export const renameWorkingTree = (productRoot, appName, kind, planId) =>
    resolve(productRoot, 'apps', `.${appName}.rename-${kind}-${planId}`);

function shellNotReproducible(appName, path) {
    externalFailure(
        `PRODUCT_SHELL_NOT_REPRODUCIBLE: app ${appName} shell is not reproducible by the current generator (${path}); regenerate the base before renaming (lot 2)`
    );
}

function compositionNotReproducible(appName) {
    externalFailure(
        `PRODUCT_COMPOSITION_NOT_REPRODUCIBLE: app ${appName} composition is not reproducible by the current generator; republish it with generate:page-composition before renaming`
    );
}

function prefixInPublication(appName, path, writer) {
    externalFailure(
        `PRODUCT_PREFIX_IN_PUBLICATION: app ${appName} path ${path} written by ${writer} depends on the prefix; it cannot be renamed`
    );
}

// Champs du manifeste d'appli hors inventaire et sceau : ils ne dépendent pas
// du préfixe, et ceux de la coque rendue doivent être ceux du manifeste.
const SHELL_INVENTORY_FIELDS = new Set([
    'generated_files',
    'tree_sha256',
    'ownership',
]);
function shellFields(manifest) {
    return stableStringify(
        Object.fromEntries(
            Object.entries(manifest).filter(
                ([key]) => !SHELL_INVENTORY_FIELDS.has(key)
            )
        )
    );
}

function splitShell(files) {
    const { [APP_MANIFEST]: manifest, ...rest } = files;
    return { manifest: JSON.parse(manifest), files: rest };
}

async function currentFiles(root, manifest) {
    const files = {};
    for (const entry of manifest.generated_files)
        files[entry.path] = (await readProductFile(root, entry.path)).toString(
            'utf8'
        );
    return files;
}

// Pages dont la composition est publiée : celles dont le manifeste de
// génération est dans l'inventaire, au chemin de `pageCompositionRoot`.
function composedPages(inventory) {
    const pages = [];
    for (const path of inventory.keys()) {
        const pageId = path.split('/')[4];
        if (
            /^page_[a-f0-9]{16}$/.test(pageId ?? '') &&
            path === `${pageCompositionRoot(pageId)}/${COMPOSITION_MANIFEST}`
        )
            pages.push(pageId);
    }
    return pages.sort();
}

async function compositionFiles(options, appName, pageId, internal) {
    try {
        return await expectedExternalPageCompositionFiles(
            {
                workspaceRoot: options.workspaceRoot,
                targetRoot: options.targetRoot,
                appName,
                pageId,
            },
            internal
        );
    } catch (error) {
        throw Object.assign(
            new Error(
                `external application: PRODUCT_COMPOSITION_NOT_REPRODUCIBLE: app ${appName} page ${pageId} composition is not reproducible by the current generator; republish it with generate:page-composition before renaming`
            ),
            { cause: error }
        );
    }
}

// Rendus d'une appli : coque et compositions, avec un préfixe. `renderShell`
// est injectable pour éprouver la post-condition `derived` (D.6) ; la phase
// `derived` rend toujours avec les renderers réels.
export async function renderAppForPrefix(
    workspace,
    options,
    manifest,
    pages,
    prefix,
    { renderShell = renderExternalShellFiles, internal = {} } = {}
) {
    const shell = splitShell(await renderShell(workspace, manifest, prefix));
    const compositions = {};
    for (const pageId of pages)
        Object.assign(
            compositions,
            await compositionFiles(options, manifest.app_name, pageId, {
                ...internal,
                prefix,
            })
        );
    return { shell, compositions };
}

const replacedChange = (path, before, content) => ({
    path,
    change: 'replaced',
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    before: { sha256: before.sha256, bytes: before.bytes },
});

// Zone dérivée d'une appli (S2), après le contrôle de reproductibilité : la
// coque et chaque composition rendues en `p` reproduisent chaque fichier dont
// elles sont le dernier écrivain ; un chemin dont le rendu change avec le
// préfixe doit être dans la zone structurelle (`renameMayReplace`).
function deriveChanges(app, before, after, prefixes) {
    const { name, inventory, writers, files } = app;
    if (shellFields(before.shell.manifest) !== shellFields(app.manifest))
        shellNotReproducible(name, APP_MANIFEST);
    if (shellFields(after.shell.manifest) !== shellFields(app.manifest))
        externalFailure(
            `app ${name} manifest fields depend on the prefix; it cannot be renamed`
        );
    const explained = new Set();
    const changes = [];
    const compare = (family, pathsBefore, pathsAfter, notReproducible) => {
        for (const [path, content] of Object.entries(pathsBefore)) {
            const writer = writers.get(path);
            if (writer === undefined) notReproducible(path);
            const zone =
                writer === 'shell' ||
                writer === RENAME_TOOL ||
                (family === 'composition' && writer === PAGE_COMPOSITION_TOOL);
            if (zone) {
                if (files[path] !== content) notReproducible(path);
                explained.add(path);
            }
            const next = pathsAfter[path];
            if (next === undefined || next === content) continue;
            if (!zone || !renameMayReplace(path, writer, inventory))
                prefixInPublication(name, path, writer);
            changes.push(replacedChange(path, inventory.get(path), next));
        }
    };
    compare('shell', before.shell.files, after.shell.files, (path) =>
        shellNotReproducible(name, path)
    );
    compare('composition', before.compositions, after.compositions, () =>
        compositionNotReproducible(name)
    );
    // Seule différence de structure admise : la paire de scripts d'entrée.
    const relay = {
        before: relayEnvshPath(prefixes.before),
        after: relayEnvshPath(prefixes.after),
    };
    const removed = Object.keys(before.shell.files).filter(
        (path) => !Object.hasOwn(after.shell.files, path)
    );
    const added = Object.keys(after.shell.files).filter(
        (path) => !Object.hasOwn(before.shell.files, path)
    );
    const structure =
        Object.keys(before.compositions).sort().join('\0') !==
        Object.keys(after.compositions).sort().join('\0');
    if (
        structure ||
        removed.length !== added.length ||
        removed.length > 1 ||
        (removed.length === 1 &&
            (removed[0] !== relay.before || added[0] !== relay.after))
    )
        externalFailure(
            `app ${name} file structure depends on the prefix beyond the nginx entry script; it cannot be renamed`
        );
    if (removed.length === 1) {
        const entry = inventory.get(relay.before);
        changes.push({
            path: relay.before,
            change: 'removed',
            before: { sha256: entry.sha256, bytes: entry.bytes },
        });
        const content = after.shell.files[relay.after];
        if (inventory.has(relay.after))
            prefixInPublication(name, relay.after, writers.get(relay.after));
        changes.push({
            path: relay.after,
            change: 'added',
            sha256: sha256(content),
            bytes: Buffer.byteLength(content),
        });
    }
    // Tout fichier écrit en dernier par la coque, un renommage ou une
    // composition est expliqué par un rendu ; sinon il vient d'un autre
    // générateur.
    for (const [path, writer] of writers) {
        if (explained.has(path)) continue;
        if (writer === PAGE_COMPOSITION_TOOL) compositionNotReproducible(name);
        if (writer === 'shell' || writer === RENAME_TOOL)
            shellNotReproducible(name, path);
    }
    if (changes.length === 0)
        externalFailure(`rename without change for app ${name}`);
    return changes.sort((left, right) => (left.path < right.path ? -1 : 1));
}

// Contre-preuve dérivée : aucune forme d'un autre préfixe que `q` dans les
// fichiers possédés, relevée par familles quel que soit le préfixe. Le
// manifeste d'appli est exclu : son historique cite l'ancien préfixe.
export function assertOnlyPrefix(files, prefix, describe) {
    for (const [path, content] of Object.entries(files)) {
        if (path === APP_MANIFEST) continue;
        for (const [family, prefixes] of productNameForms(content))
            for (const found of prefixes)
                if (found !== prefix)
                    externalFailure(
                        `PRODUCT_PREFIX_REMAINS: ${describe(path)} keeps prefix ${found} (${family}) after rename`
                    );
    }
}

function applyChanges(files, changes, rendered) {
    const next = { ...files };
    for (const change of changes) {
        if (change.change === 'removed') delete next[change.path];
        else next[change.path] = rendered[change.path];
    }
    return next;
}

async function ownedAppNames(productRoot) {
    return (
        await readdir(resolve(productRoot, 'apps'), { withFileTypes: true })
    )
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();
}

// Plan du renommage. `internal.renaming` : réservé à la transaction et à sa
// reprise ; `dependencies.renderShell` : injection de D.6.
export async function planProductPrefixRename(
    options,
    internal = {},
    dependencies = {}
) {
    const workspace = await readOwnedWorkspace(options, internal);
    const before = workspace.manifest.identity.prefix;
    const after = options.to;
    const refusals = prefixRefusals(
        after,
        await prefixContext(workspace.toolsRoot)
    );
    if (refusals.length)
        externalFailure(`--to refused: ${refusals.join(' ; ')}`);
    if (after === before) externalFailure('rename without change');
    const installation = await qualifyProductInstallation(workspace);
    const renamed = await renamedWorkspaceManifest(workspace.manifest, after);
    const workspaceIdBefore = workspace.manifest.workspace_id;
    const apps = [];
    for (const name of await ownedAppNames(workspace.productRoot)) {
        const root = resolve(workspace.productRoot, 'apps', name);
        const manifestText = (
            await readProductFile(root, APP_MANIFEST)
        ).toString('utf8');
        const manifest = JSON.parse(manifestText);
        const inventory = new Map(
            manifest.generated_files.map((entry) => [entry.path, entry])
        );
        const writers = lastWriters(manifest, workspaceIdBefore);
        const pages = composedPages(inventory);
        const app = {
            name,
            manifest,
            inventory,
            writers,
            files: await currentFiles(root, manifest),
        };
        const renderBefore = await renderAppForPrefix(
            workspace,
            options,
            manifest,
            pages,
            before,
            { internal, renderShell: dependencies.renderShell }
        );
        const renderAfter = await renderAppForPrefix(
            workspace,
            options,
            manifest,
            pages,
            after,
            { internal, renderShell: dependencies.renderShell }
        );
        const changes = deriveChanges(app, renderBefore, renderAfter, {
            before,
            after,
        });
        apps.push({
            app_name: name,
            profile: manifest.profile,
            root,
            manifest,
            manifestText,
            manifest_before_sha256: sha256(manifestText),
            files: app.files,
            pages,
            changes,
            rendered: {
                ...renderAfter.shell.files,
                ...renderAfter.compositions,
            },
        });
    }
    if (apps.length === 0) externalFailure('rename requires at least one app');
    const binding = renameBinding({
        workspace,
        installation,
        prefixAfter: after,
        workspaceIdAfter: renamed.manifest.workspace_id,
        apps,
    });
    const planId = renamePlanId(binding);
    for (const app of apps) {
        app.record = {
            plan_id: planId,
            tool: RENAME_TOOL,
            prefix_before: before,
            prefix_after: after,
            workspace_id_before: workspaceIdBefore,
            files: app.changes,
        };
        const next = renamedManifest(
            app.manifest,
            app.record,
            renamed.manifest.workspace_id
        );
        const manifestPath = `apps/${app.app_name}/${APP_MANIFEST}`;
        const nextText = (
            await canonicalizeGeneratedFiles({
                [manifestPath]: JSON.stringify(next, null, 2) + '\n',
            })
        )[manifestPath];
        app.next = {
            ...applyChanges(app.files, app.changes, app.rendered),
            [APP_MANIFEST]: nextText,
        };
        app.manifest_after_sha256 = sha256(nextText);
        app.outputAbsolute = app.root;
        app.candidate = renameWorkingTree(
            workspace.productRoot,
            app.app_name,
            'candidate',
            planId
        );
        app.previous = renameWorkingTree(
            workspace.productRoot,
            app.app_name,
            'previous',
            planId
        );
        const nextWriters = lastWriters(next, renamed.manifest.workspace_id);
        assertOnlyPrefix(
            app.next,
            after,
            (path) =>
                `app ${app.app_name} path ${path} written by ${nextWriters.get(path)}`
        );
    }
    const { [WORKSPACE_MANIFEST]: _marker, ...workspaceFiles } =
        workspace.files;
    void _marker;
    delete workspaceFiles['bun.lock'];
    assertOnlyPrefix(workspaceFiles, after, (path) => `workspace file ${path}`);
    return {
        plan_id: planId,
        binding,
        productRoot: workspace.productRoot,
        toolsRoot: workspace.toolsRoot,
        workspace,
        installation,
        prefix_before: before,
        prefix_after: after,
        workspace_id_before: workspaceIdBefore,
        workspace_id_after: renamed.manifest.workspace_id,
        workspace_manifest_before: workspace.files[WORKSPACE_MANIFEST],
        workspace_manifest_after: renamed.text,
        apps,
    };
}

// Noms de l'opérateur qui changent (S6), relevés dans les fichiers actuels :
// variables `<P>_…` service par service, filtre, dossier nginx, caches.
function operatorTable(plan) {
    const formsBefore = productForms(plan.prefix_before);
    const formsAfter = productForms(plan.prefix_after);
    const variable = new RegExp(
        `\\b${escapeRegExp(formsBefore.env)}[A-Z0-9_]*[A-Z0-9]\\b`,
        'g'
    );
    const cache = new RegExp(
        PRODUCT_NAME_FAMILIES['caches du service worker'],
        'g'
    );
    const variables = new Set();
    const caches = new Set();
    for (const app of plan.apps)
        for (const [path, content] of Object.entries(app.files)) {
            if (path === APP_MANIFEST) continue;
            for (const [name] of content.matchAll(variable))
                variables.add(name);
            for (const match of content.matchAll(cache))
                if (match[1] === plan.prefix_before) caches.add(match[0]);
        }
    const swap = (name, from, to) => `${to}${name.slice(from.length)}`;
    return {
        variables: [...variables].sort().map((name) => ({
            before: name,
            after: swap(name, formsBefore.env, formsAfter.env),
        })),
        envsubst_filter: {
            before: `^${formsBefore.env}`,
            after: `^${formsAfter.env}`,
        },
        nginx_directory: {
            before: formsBefore.nginxDir,
            after: formsAfter.nginxDir,
        },
        caches: [...caches].sort().map((name) => ({
            name,
            replaced_by: swap(name, plan.prefix_before, plan.prefix_after),
        })),
    };
}

export function publicProductPrefixRenamePlan(plan) {
    const operator = operatorTable(plan);
    return {
        schema_version: '1.0.0',
        plan_id: plan.plan_id,
        prefix: { before: plan.prefix_before, after: plan.prefix_after },
        workspace_id: {
            before: plan.workspace_id_before,
            after: plan.workspace_id_after,
        },
        apps: plan.apps.map((app) => {
            const removed = app.changes.find(
                (change) => change.change === 'removed'
            );
            const added = app.changes.find(
                (change) => change.change === 'added'
            );
            return {
                app_name: app.app_name,
                changes: app.changes.map(({ path, change }) => ({
                    path,
                    change,
                })),
                relay_entry_script: removed
                    ? { before: removed.path, after: added.path }
                    : null,
            };
        }),
        operator_variables: operator.variables,
        envsubst_filter: operator.envsubst_filter,
        nginx_directory: operator.nginx_directory,
        orphaned_service_worker_caches: operator.caches,
        notice: 'Les caches du service worker de l’ancien préfixe restent chez les utilisateurs : aucun sw.js ne les supprime à l’activation (clients.claim() seul). Leur nettoyage est un lot séparé.',
    };
}

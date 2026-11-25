// Lot MARQUE, commit 3 : plan de `rename-product-prefix` (voie R2). Le
// renommage d'un produit extérieur ajoute à chaque appli un enregistrement
// `rename-product-prefix` (ADR-0103) ; aucun enregistrement existant n'est
// réécrit. Sa zone est DÉRIVÉE ici : les chemins dont le rendu en `q` diffère
// du rendu en `p` (la coque), plus la paire de scripts d'entrée nginx. Lot 2
// (V5.3) : le socle et l'interface ne portent aucune forme du préfixe ;
// MARQUE ne s'étend pas à `libs/` et ne re-rend plus les compositions, qui y
// vivent. Ce module ne fait que planifier ; la transaction est dans
// `product-prefix-rename-transaction.mjs`.
import { resolve } from 'node:path';

import {
    DERIVED_WRITERS,
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
import { appManifestPath } from '../renderers/external-product-layout.mjs';
import { filesUnder } from './application-transaction.mjs';
import { ownedAppNames } from './application-workspace-root.mjs';
import { escapeRegExp, SIGNATURE_FILES } from './atelier-signature.mjs';
import { canonicalizeGeneratedFiles } from './canonicalize-generated.mjs';
import {
    externalFailure,
    readProductFile,
    relayEnvshPath,
} from './external-application-paths.mjs';
import { sha256, stableStringify } from './generation-manifest.mjs';
import {
    PRODUCT_NAME_FAMILIES,
    prefixRefusals,
    productForms,
    productNameForms,
} from './product-identity.mjs';
import { prefixContext } from './product-prefix.mjs';
import { coqueRoot } from './socle-names.mjs';

const APP_MANIFEST = SIGNATURE_FILES.appManifest;
const WORKSPACE_MANIFEST = SIGNATURE_FILES.workspaceManifest;

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
        // Lot 2, commit 3 (V3.5 b) : liaison courante de toutes les applis.
        sources_binding: workspace.sources_binding,
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

// Rendu de la coque, chemins relatifs au produit (trois racines, lot 2) :
// manifeste à part.
function splitShell(files, appName) {
    const { [appManifestPath(appName)]: manifest, ...rest } = files;
    return { manifest: JSON.parse(manifest), files: rest };
}

// Fichiers possédés de l'appli, relatifs au produit.
async function currentFiles(productRoot, manifest) {
    const files = {};
    for (const entry of manifest.generated_files)
        files[entry.path] = (
            await readProductFile(productRoot, entry.path)
        ).toString('utf8');
    return files;
}

// Rendu d'une appli avec un préfixe : la coque et ses bibliothèques, telles
// que `create-app` les rend. `renderShell` est injectable pour éprouver la
// post-condition `derived` (D.6) ; la phase `derived` rend toujours avec les
// renderers réels.
export async function renderAppForPrefix(
    workspace,
    manifest,
    prefix,
    { renderShell = renderExternalShellFiles } = {}
) {
    return {
        shell: splitShell(
            await renderShell(workspace, manifest, prefix),
            manifest.app_name
        ),
    };
}

const replacedChange = (path, before, content) => ({
    path,
    change: 'replaced',
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
    before: { sha256: before.sha256, bytes: before.bytes },
});

// Zone dérivée d'une appli (S2), après le contrôle de reproductibilité : le
// rendu en `p` reproduit chaque fichier dont la coque (ou un renommage) est le
// dernier écrivain, sur les trois racines ; un chemin dont le rendu change
// avec le préfixe doit être dans la zone structurelle (`renameMayReplace`,
// coque seulement) : un fichier du socle ou de l'interface qui dépendrait du
// préfixe fait refuser le renommage.
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
    for (const [path, content] of Object.entries(before.shell.files)) {
        const writer = writers.get(path);
        if (writer === undefined) shellNotReproducible(name, path);
        const zone = DERIVED_WRITERS.has(writer);
        if (zone) {
            if (files[path] !== content) shellNotReproducible(name, path);
            explained.add(path);
        }
        const next = after.shell.files[path];
        if (next === undefined || next === content) continue;
        if (!zone || !renameMayReplace(path, writer, name))
            prefixInPublication(name, path, writer);
        changes.push(replacedChange(path, inventory.get(path), next));
    }
    // Seule différence de structure admise : la paire de scripts d'entrée,
    // sous la coque.
    const relay = {
        before: `${coqueRoot(name)}/${relayEnvshPath(prefixes.before)}`,
        after: `${coqueRoot(name)}/${relayEnvshPath(prefixes.after)}`,
    };
    const removed = Object.keys(before.shell.files).filter(
        (path) => !Object.hasOwn(after.shell.files, path)
    );
    const added = Object.keys(after.shell.files).filter(
        (path) => !Object.hasOwn(before.shell.files, path)
    );
    if (
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
    // Tout fichier écrit en dernier par la coque ou un renommage est expliqué
    // par un rendu ; sinon il vient d'un autre générateur. Un fichier publié
    // (socle) n'est pas re-rendu : il reste égal à l'octet.
    for (const [path, writer] of writers) {
        if (explained.has(path)) continue;
        if (DERIVED_WRITERS.has(writer)) shellNotReproducible(name, path);
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
        const app = {
            name,
            manifest,
            inventory,
            writers,
            files: await currentFiles(workspace.productRoot, manifest),
        };
        const renderBefore = await renderAppForPrefix(
            workspace,
            manifest,
            before,
            { renderShell: dependencies.renderShell }
        );
        const renderAfter = await renderAppForPrefix(
            workspace,
            manifest,
            after,
            { renderShell: dependencies.renderShell }
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
            changes,
            rendered: renderAfter.shell.files,
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
        const manifestPath = appManifestPath(app.app_name);
        const nextText = (
            await canonicalizeGeneratedFiles({
                [manifestPath]: JSON.stringify(next, null, 2) + '\n',
            })
        )[manifestPath];
        // Lot 2 : le renommage ne change que la coque ; ses arbres (avant,
        // après) sont relatifs à `apps/<app>`, son inventaire au produit.
        app.product = applyChanges(app.files, app.changes, app.rendered);
        const coque = coqueRoot(app.app_name);
        app.current = {
            ...filesUnder(app.files, coque),
            [APP_MANIFEST]: app.manifestText,
        };
        app.next = {
            ...filesUnder(app.product, coque),
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
        // Contre-preuve sur les trois racines (inventaire, relatif au produit).
        assertOnlyPrefix(
            app.product,
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

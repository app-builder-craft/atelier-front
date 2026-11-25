// Lot 2, commit 6c (cadrage § 20 ; conception v2 R2.1, v3 V3.5 c et g, V3.6
// point 4, v5 C-B3) : plan d'`update-app`, la mise à jour d'une appli sous
// plan. Portée : TOUT le produit, sans `--app` (v2 R2.1.1) ; une seule
// liaison de plan pour toutes les applis, comme le renommage du préfixe.
// Dans cet ordre (v2 R2.1.2) :
// 1. intégrité d'abord, inchangée (`readOwnedWorkspace`, classe `update` :
//    la fraîcheur est rapportée, jamais refusée) ; un fichier possédé
//    retouché est refusé avant toute lecture de source ;
// 2. espace re-rendu par le générateur courant : un écart est un refus
//    nommé `UPDATE_REQUIRES_WORKSPACE_CHANGE <fichier>`, hors § 20 ;
// 3. chaque appli rendue depuis ses sources PRÉSENTES, par les renderers de
//    `create-app` ; une conception que la validation refuse arrête le plan
//    entier (`UPDATE_APP_REJECTED`, toutes les applis en cause, triées) ;
// 4. changements chemin par chemin, zone par DERNIER ÉCRIVAIN : un fichier
//    écrit en dernier par une publication n'est jamais touché (module de
//    page composé : gardé, C-B3) ; vouloir le réécrire, ou garder une
//    publication d'une page retirée, est `UPDATE_PATH_OWNED_BY_PUBLICATION` ;
// 5. amorces des pages NOUVELLES, chemins et octets dans le plan, à des
//    chemins absents (`UPDATE_SEED_PATH_TAKEN` sinon).
// Ce module ne fait que planifier ; la transaction est dans
// `application-update-transaction.mjs`.
import { resolve } from 'node:path';

import { appManifestPath } from '../renderers/external-product-layout.mjs';
import {
    DERIVED_WRITERS,
    lastWriters,
    publicationZone,
    UPDATE_TOOL,
    updatedManifest,
} from './application-ownership.mjs';
import { ownedAppNames, ownedFiles } from './application-workspace-root.mjs';
import { renderApplicationWorkspace } from '../renderers/application-workspace-renderer.mjs';
import {
    qualifyProductInstallation,
    readOwnedWorkspace,
    renderProductShell,
} from './application-workspace.mjs';
import { sourceToolchain } from './application-workspace-toolchain.mjs';
import { filesUnder } from './application-transaction.mjs';
import { escapeRegExp, SIGNATURE_FILES } from './atelier-signature.mjs';
import { canonicalizeGeneratedFiles } from './canonicalize-generated.mjs';
import {
    assertPhysicalPath,
    externalFailure,
    fileArtifacts,
    pathExists,
    readProductFile,
} from './external-application-paths.mjs';
import { sha256, stableStringify } from './generation-manifest.mjs';
import {
    coqueRoot,
    INTERFACE_PAGES_DIR,
    interfaceRoot,
    socleRoot,
} from './socle-names.mjs';

const WORKSPACE_MANIFEST = SIGNATURE_FILES.workspaceManifest;
const APP_MANIFEST = SIGNATURE_FILES.appManifest;
// Champs du manifeste d'appli hors inventaire et sceau : ceux de la coque
// rendue deviennent ceux du manifeste mis à jour.
const INVENTORY_FIELDS = new Set([
    'generated_files',
    'tree_sha256',
    'ownership',
]);
export const UPDATE_NOTICE =
    'L’interface peut ne plus compiler : RAPPORT_INTERFACE dira où (point 1.1).';

const digestOf = (content) => ({
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
});
const byPath = (left, right) => (left.path < right.path ? -1 : 1);

// Une appli existante rendue depuis ses sources PRÉSENTES (aucune liaison :
// les empreintes de contrat sont lues dans les octets), par les mêmes
// renderers que create-app : inventaire, amorces de toutes les pages,
// fermeture des sources (v2 R2.1.2, étape 4).
export async function renderApplicationForUpdate(workspace, manifest) {
    return renderProductShell({
        productRoot: workspace.productRoot,
        toolsRoot: workspace.toolsRoot,
        appName: manifest.app_name,
        designPath: manifest.design_ref?.path,
        experienceId: manifest.experience_id,
        profile: manifest.profile,
        prefix: workspace.manifest.identity.prefix,
    });
}

// Fichiers de l'espace d'un produit existant, rendus par le générateur
// COURANT depuis les champs de son manifeste (v3 V3.6 point 2).
export async function renderWorkspaceFiles(workspace) {
    const toolchain = await sourceToolchain(
        workspace.toolsRoot,
        workspace.profiles
    );
    return renderApplicationWorkspace({
        workspaceRoot: workspace.toolsRoot,
        targetRoot: workspace.productRoot,
        githubRepository: workspace.manifest.github_repository,
        reviewOwner: workspace.manifest.review_owner,
        prefix: workspace.manifest.identity.prefix,
        ...toolchain,
        profiles: workspace.profiles,
    });
}

// Espace rendu par le générateur courant, comparé aux fichiers que son
// manifeste inscrit (hors `bun.lock` et manifeste d'espace : v3 V3.6 point 2).
async function assertWorkspaceRendered(workspace, render) {
    const files = await render(workspace);
    const recorded = new Map(
        workspace.manifest.files.map((entry) => [entry.path, entry])
    );
    const paths = [...new Set([...Object.keys(files), ...recorded.keys()])]
        .filter((path) => path !== 'bun.lock' && path !== WORKSPACE_MANIFEST)
        .sort();
    for (const path of paths) {
        const entry = recorded.get(path);
        const content = files[path];
        if (
            !entry ||
            content === undefined ||
            sha256(content) !== entry.sha256 ||
            Buffer.byteLength(content) !== entry.bytes
        )
            externalFailure(`UPDATE_REQUIRES_WORKSPACE_CHANGE ${path}`);
    }
}

function ownedByPublication(app, path, writer) {
    externalFailure(
        `UPDATE_PATH_OWNED_BY_PUBLICATION ${app} ${path} ${writer}`
    );
}

// Pages déclarées : identifiants des contrats de page parmi des chemins.
function declaredPages(app, paths) {
    const contract = new RegExp(
        `^${escapeRegExp(`${coqueRoot(app)}/${SIGNATURE_FILES.pages}/`)}(page_[a-f0-9]{16})\\.json$`
    );
    return [...paths]
        .map((path) => contract.exec(path)?.[1])
        .filter(Boolean)
        .sort();
}

// Écart de la liaison, source par source (plan public).
function sourceChanges(before, after) {
    const old = new Map(before.map((entry) => [entry.path, entry]));
    const next = new Map(after.map((entry) => [entry.path, entry]));
    return [...new Set([...old.keys(), ...next.keys()])]
        .sort()
        .flatMap((path) => {
            const left = old.get(path);
            const right = next.get(path);
            if (left && right && left.sha256 === right.sha256) return [];
            return [
                {
                    genre: (right ?? left).genre,
                    path,
                    change: !left ? 'added' : !right ? 'removed' : 'modified',
                    before: left?.sha256 ?? null,
                    after: right?.sha256 ?? null,
                },
            ];
        });
}

// Une appli : rendu présent, changements dans la zone, amorces nouvelles.
async function planApp(workspace, name, rendered) {
    const productRoot = workspace.productRoot;
    const manifestPath = appManifestPath(name);
    const manifestText = (
        await readProductFile(productRoot, manifestPath)
    ).toString('utf8');
    const manifest = JSON.parse(manifestText);
    const inventory = new Map(
        manifest.generated_files.map((entry) => [entry.path, entry])
    );
    const writers = lastWriters(manifest, workspace.manifest.workspace_id);
    const current = await ownedFiles(productRoot, manifest.generated_files);
    const { [manifestPath]: renderedManifestText, ...files } = rendered.files;
    const changes = [];
    const kept = [];
    for (const path of [
        ...new Set([...inventory.keys(), ...Object.keys(files)]),
    ].sort()) {
        const entry = inventory.get(path);
        const content = files[path];
        const writer = writers.get(path) ?? 'shell';
        if (content === undefined) {
            if (DERIVED_WRITERS.has(writer))
                changes.push({
                    path,
                    change: 'removed',
                    before: { sha256: entry.sha256, bytes: entry.bytes },
                });
            else kept.push(path);
            continue;
        }
        const next = digestOf(content);
        if (!entry) {
            changes.push({ path, change: 'added', ...next });
            continue;
        }
        if (entry.sha256 === next.sha256 && entry.bytes === next.bytes)
            continue;
        if (DERIVED_WRITERS.has(writer))
            changes.push({
                path,
                change: 'replaced',
                ...next,
                before: { sha256: entry.sha256, bytes: entry.bytes },
            });
        // v5 C-B3 : le module de page composé par une publication est gardé.
        else if (publicationZone(name, path, inventory)?.pageModule)
            kept.push(path);
        else ownedByPublication(name, path, writer);
    }
    // Inventaire d'après ; une publication gardée doit rester dans sa zone
    // (une page retirée de la conception emporte son contrat).
    const after = new Map(inventory);
    for (const change of changes)
        if (change.change === 'removed') after.delete(change.path);
        else after.set(change.path, change);
    for (const path of kept)
        if (!publicationZone(name, path, after))
            ownedByPublication(name, path, writers.get(path));
    // Une configuration possédée de l'interface n'est jamais retirée (limite
    // de l'opération `files`, qui n'écrit que des fichiers d'après).
    const ui = `${interfaceRoot(name)}/`;
    for (const change of changes)
        if (change.change === 'removed' && change.path.startsWith(ui))
            externalFailure(
                `UPDATE_INTERFACE_FILE_REMOVED ${name} ${change.path}`
            );
    // Amorces des pages NOUVELLES, à des chemins absents (v3 V3.5 c).
    const pagesBefore = declaredPages(name, inventory.keys());
    const pagesAfter = declaredPages(name, after.keys());
    const addedPages = pagesAfter.filter((page) => !pagesBefore.includes(page));
    const removedPages = pagesBefore.filter(
        (page) => !pagesAfter.includes(page)
    );
    const seeds = {};
    for (const [path, content] of Object.entries(rendered.seeds))
        if (
            addedPages.some((page) =>
                path.startsWith(`${ui}${INTERFACE_PAGES_DIR}/${page}/`)
            )
        ) {
            const absolute = resolve(productRoot, path);
            await assertPhysicalPath(absolute, { missing: true });
            if (await pathExists(absolute))
                externalFailure(`UPDATE_SEED_PATH_TAKEN ${path}`);
            seeds[path] = content;
        }
    const renderedManifest = JSON.parse(renderedManifestText);
    const fields = Object.fromEntries(
        Object.entries(renderedManifest).filter(
            ([key]) => !INVENTORY_FIELDS.has(key)
        )
    );
    const sourcesBefore = manifest.sources;
    const sourcesAfter = rendered.inputs;
    const sourcesChanged =
        stableStringify(sourcesBefore) !== stableStringify(sourcesAfter);
    changes.sort(byPath);
    return {
        app_name: name,
        profile: manifest.profile,
        manifest,
        manifestText,
        manifest_before_sha256: sha256(manifestText),
        current,
        rendered: files,
        changes,
        seeds,
        // Amorces de TOUTES les pages : le programme témoin (v3 V3.5 a).
        allSeeds: rendered.seeds,
        fields,
        sources_before: sourcesBefore,
        sources_after: sourcesAfter,
        status: changes.length > 0 || sourcesChanged ? 'updated' : 'current',
        reason: sourcesChanged ? 'sources' : 'generator',
        pages: { added: addedPages, removed: removedPages },
    };
}

// Liaison d'`update-app` : tout ce que son `plan_id` engage (v2 R2.1.2,
// v3 V3.5 b et c).
export function updateBinding({ workspace, installation, apps }) {
    return {
        tools_root: workspace.toolsRoot,
        target_root: workspace.productRoot,
        workspace_plan_id: workspace.plan_id,
        provenance: workspace.provenance,
        lock_sha256: installation.lock_sha256,
        installed: installation.metadata,
        workspace_manifest_sha256: sha256(workspace.files[WORKSPACE_MANIFEST]),
        sources_binding: workspace.sources_binding,
        apps: apps.map((app) => ({
            app_name: app.app_name,
            app_manifest_sha256: app.manifest_before_sha256,
            sources_before: app.sources_before,
            sources_after: app.sources_after,
            changes: app.changes,
            seeds: fileArtifacts(app.seeds),
        })),
    };
}

// Arbres et fichiers d'une appli mise à jour (V3.6 point 4) : la coque
// (manifeste compris) et le socle, racines exactes, par l'opération `tree` ;
// la configuration de l'interface et les amorces, par l'opération `files`.
function updateRoots(app, nextManifestText) {
    const product = { ...app.current };
    for (const change of app.changes)
        if (change.change === 'removed') delete product[change.path];
        else product[change.path] = app.rendered[change.path];
    const coque = coqueRoot(app.app_name);
    const socle = socleRoot(app.app_name);
    const ui = interfaceRoot(app.app_name);
    const trees = [
        {
            root: coque,
            files: {
                ...filesUnder(product, coque),
                [APP_MANIFEST]: nextManifestText,
            },
            before: fileArtifacts({
                ...filesUnder(app.current, coque),
                [APP_MANIFEST]: app.manifestText,
            }),
        },
    ];
    if (app.changes.some((change) => change.path.startsWith(`${socle}/`)))
        trees.push({
            root: socle,
            files: filesUnder(product, socle),
            before: fileArtifacts(filesUnder(app.current, socle)),
        });
    const interfaceFiles = {
        ...filesUnder(
            Object.fromEntries(
                app.changes
                    .filter((change) => change.path.startsWith(`${ui}/`))
                    .map((change) => [change.path, product[change.path]])
            ),
            ui
        ),
        ...filesUnder(app.seeds, ui),
    };
    return { trees, interface: { root: ui, files: interfaceFiles }, product };
}

// Plan de la mise à jour. `internal.transaction` : réservé à la transaction
// et à sa reprise ; `dependencies.renderShell` et `renderWorkspace` :
// injections des preuves (montée du générateur simulée, espace changé).
export async function planApplicationUpdate(
    options,
    internal = {},
    dependencies = {}
) {
    const workspace = await readOwnedWorkspace(
        { ...options, command: 'update-app' },
        internal
    );
    const installation = await qualifyProductInstallation(workspace);
    await assertWorkspaceRendered(
        workspace,
        dependencies.renderWorkspace ?? renderWorkspaceFiles
    );
    const render = dependencies.renderShell ?? renderApplicationForUpdate;
    const apps = [];
    const rejected = [];
    for (const name of await ownedAppNames(workspace.productRoot)) {
        const manifest = JSON.parse(
            (
                await readProductFile(
                    workspace.productRoot,
                    appManifestPath(name)
                )
            ).toString('utf8')
        );
        let rendered;
        try {
            rendered = await render(workspace, manifest);
        } catch (error) {
            if (!error.validation) throw error;
            rejected.push(
                `UPDATE_APP_REJECTED ${name} design ${manifest.design_ref.path} : ${error.validation[0]}`
            );
            continue;
        }
        apps.push(await planApp(workspace, name, rendered));
    }
    if (rejected.length) externalFailure(rejected.sort().join('\n'));
    if (apps.length === 0) externalFailure('update requires at least one app');
    if (apps.every((app) => app.status === 'current'))
        externalFailure('update without change');
    const binding = updateBinding({ workspace, installation, apps });
    const planId = sha256(stableStringify(binding));
    for (const app of apps) {
        if (app.status !== 'updated') continue;
        app.record = {
            plan_id: planId,
            tool: UPDATE_TOOL,
            sources_before: app.sources_before,
            sources_after: app.sources_after,
            files: app.changes,
        };
        const next = updatedManifest(
            app.manifest,
            app.record,
            workspace.manifest.workspace_id,
            app.fields
        );
        const manifestPath = appManifestPath(app.app_name);
        const nextText = (
            await canonicalizeGeneratedFiles({
                [manifestPath]: JSON.stringify(next, null, 2) + '\n',
            })
        )[manifestPath];
        app.manifest_after_sha256 = sha256(nextText);
        Object.assign(app, updateRoots(app, nextText));
    }
    return {
        plan_id: planId,
        binding,
        productRoot: workspace.productRoot,
        toolsRoot: workspace.toolsRoot,
        workspace,
        installation,
        apps,
    };
}

// Ce que le `--dry-run` montre (v2 R2.1.2) : rien de local, chemins relatifs
// au produit.
export function publicApplicationUpdatePlan(plan) {
    return {
        schema_version: '1.0.0',
        plan_id: plan.plan_id,
        apps: plan.apps.map((app) =>
            app.status === 'current'
                ? { app_name: app.app_name, status: 'current' }
                : {
                      app_name: app.app_name,
                      status: 'updated',
                      reason: app.reason,
                      sources: sourceChanges(
                          app.sources_before,
                          app.sources_after
                      ),
                      pages: app.pages,
                      files: app.changes.map(({ path, change }) => ({
                          path,
                          change,
                      })),
                      interface_seeds: Object.keys(app.seeds).sort(),
                      interface_orphans: app.pages.removed.map(
                          (page) =>
                              `${interfaceRoot(app.app_name)}/${INTERFACE_PAGES_DIR}/${page}`
                      ),
                      notice: UPDATE_NOTICE,
                  }
        ),
    };
}

// Vérification de la racine d'un produit extérieur : marqueur, fichiers
// possédés, applications scellées (ADR-0103) et fermeture des entrées.
// Extrait de application-workspace.mjs sans changement de comportement.
import { lstat, readdir } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

import { EXTERNAL_WORKSPACE_SIGNATURE } from '../renderers/application-workspace-renderer.mjs';
import {
    applicationRoots,
    isInterfaceFreePath,
    verifyApplicationOwnership,
} from './application-ownership.mjs';
import {
    assertNoPendingTransaction,
    pendingTransactionJournals,
    WORKING_TREE,
} from './application-transaction.mjs';
import { escapeRegExp, SIGNATURE_FILES } from './atelier-signature.mjs';
import {
    assertNoLocalConfiguration,
    assertPhysicalPath,
    assertSourcePath,
    externalApplicationContext,
    externalFailure,
    isReservedProductPath,
    pathExists,
    readProductFile,
    RUNTIME_ROOTS,
    safeRelativePath,
    treeInventory,
    verifyGeneratedTree,
} from './external-application-paths.mjs';
import {
    applicationSources,
    assertApplicationSources,
    commandClass,
    staleMessage,
    staleSources,
} from './application-sources.mjs';
import { sha256 } from './generation-manifest.mjs';
import { prefixRefusals } from './product-identity.mjs';
import {
    coqueRoot,
    interfaceLibraryName,
    interfaceRoot,
    LIBS_ROOT,
    socleLibraryName,
    socleRoot,
} from './socle-names.mjs';

const MANIFEST = EXTERNAL_WORKSPACE_SIGNATURE.manifest;

// Renommage du préfixe (lot MARQUE, commit 3) : son journal vit à côté du
// produit, comme son verrou ; ses arbres de travail dans apps/.
export const RENAME_PENDING =
    'interrupted prefix rename pending; recover it first (recover:product-prefix)';
export const renameJournalRoot = (productRoot, planId) =>
    resolve(dirname(productRoot), `.${basename(productRoot)}.rename-${planId}`);

// Journaux de renommage présents à côté du produit : `plan_id` de chacun.
export async function pendingRenameJournals(productRoot) {
    const pattern = new RegExp(
        `^\\.${escapeRegExp(basename(productRoot))}\\.rename-([a-f0-9]{64})$`
    );
    const found = [];
    for (const name of await readdir(dirname(productRoot))) {
        const match = pattern.exec(name);
        if (match) found.push(match[1]);
    }
    return found.sort();
}

// Un renommage interrompu bloque toute commande ; seuls ce renommage (ses
// contrôles) et sa reprise le tolèrent, par `internal.renaming` (son plan_id).
async function assertNoPendingRename(productRoot, renaming) {
    for (const planId of await pendingRenameJournals(productRoot))
        if (planId !== renaming) externalFailure(RENAME_PENDING);
}

// Racine d'un produit déjà créé : racine vérifiée, puis marqueur présent. Sans
// marqueur, refus fermé plutôt qu'une erreur système portant un chemin local.
export async function ownedProductContext(options, internal = {}) {
    const context = await externalApplicationContext(options);
    if (!(await pathExists(resolve(context.productRoot, MANIFEST))))
        externalFailure('workspace ownership marker missing');
    await assertNoPendingRename(context.productRoot, internal.renaming);
    // Lot 2 (V5.2) : tout journal de transaction d'appli bloque toute autre
    // commande ; seule la transaction elle-même le tolère.
    await assertNoPendingTransaction(context.productRoot, internal.transaction);
    await assertNoLocalConfiguration(context.productRoot);
    return context;
}

// Manifeste d'une appli du produit, sous le dossier de signature courant : le
// seul lecteur de ce marqueur avant la vérification de la racine. Une appli
// sans lui (par exemple à la disposition d'avant le renommage de la signature,
// lot MARQUE) est refusée, nommée, et non par une erreur système portant un
// chemin local.
export async function readAppManifest(appRoot) {
    if (!(await pathExists(resolve(appRoot, SIGNATURE_FILES.appManifest))))
        externalFailure('app ownership marker missing');
    return readProductFile(appRoot, SIGNATURE_FILES.appManifest);
}

// Préfixe du produit scellé dans son espace (`identity.prefix`, couvert par
// `workspace_id`) ; validé avant tout usage.
export async function sealedProductPrefix(productRoot) {
    const manifest = JSON.parse(
        (await readProductFile(productRoot, MANIFEST)).toString('utf8')
    );
    const prefix = manifest.identity?.prefix;
    if (prefixRefusals(prefix).length > 0)
        externalFailure('workspace identity prefix is missing or invalid');
    return prefix;
}

// Empreinte d'une source liée, lue par le contrôle de chemin unique ;
// absente : null (la fraîcheur la rapporte `missing`).
async function sourceDigest(productRoot, path) {
    await assertSourcePath(productRoot, path, {
        missing: true,
        label: 'source',
    });
    if (!(await pathExists(resolve(productRoot, path)))) return null;
    const content = await readProductFile(productRoot, path);
    return { sha256: sha256(content), bytes: content.length };
}

// Lot 2, commit 3 (v2 R2.2, v3 V3.2 et V3.5 b) : deux contrôles distincts.
// INTÉGRITÉ, toujours et d'abord : sceau, inventaire, arbres, fichiers
// d'espace et non possédés, interruptions. FRAÎCHEUR : la liaison `sources`
// de chaque appli comparée aux fichiers présents ; son effet dépend de la
// classe de la commande (`command`, défaut fermé : consommateur). Une
// transaction relue par elle-même (`plan.transaction`, `plan.renaming`) ne
// refuse pas : ses empreintes courantes entrent dans `sources_binding`, et
// son `plan_id` change (« … inputs changed »). Rend la liaison courante.
export async function verifyWorkspaceRoot(
    plan,
    { documentSources = false, command } = {}
) {
    const { productRoot } = plan;
    if (!(await pathExists(resolve(productRoot, MANIFEST))))
        externalFailure('workspace ownership marker missing');
    await assertNoPendingRename(productRoot, plan.renaming);
    await assertNoPendingTransaction(productRoot, plan.transaction);
    const journals = new Set(
        (await pendingTransactionJournals(productRoot)).map(
            ({ genre, planId }) => `${genre}-${planId}`
        )
    );
    // Arbre de travail d'une transaction d'appli : toléré seulement pour la
    // transaction en cours, dont le journal existe (V5.2, garde).
    const transactionTree = (name) => {
        const match = WORKING_TREE.exec(name);
        if (!match) return false;
        if (!journals.has(`${match[2]}-${match[4]}`))
            externalFailure(
                `application ${match[2]} working tree without a journal: ${name}; inspect the product`
            );
        if (match[4] !== plan.transaction)
            externalFailure(
                `interrupted application ${match[2]} pending; recover it first (recover:application-publication)`
            );
        return true;
    };
    if (
        sha256(await readProductFile(productRoot, MANIFEST)) !==
        sha256(plan.files[MANIFEST])
    )
        externalFailure('workspace ownership drift');
    for (const path of plan.manifest.directories) {
        const absolute = await assertPhysicalPath(resolve(productRoot, path));
        if (!(await lstat(absolute)).isDirectory())
            externalFailure('workspace directory missing');
    }
    for (const [path, expected] of Object.entries(plan.files)) {
        if (path === 'bun.lock') continue;
        const content = await readProductFile(productRoot, path);
        if (sha256(content) !== sha256(expected))
            externalFailure('workspace ownership drift');
    }
    const expected = new Set(Object.keys(plan.files));
    const inputs = new Set(plan.inputPaths ?? []);
    const ownedRoots = new Set([...expected].map((path) => path.split('/')[0]));
    const appNames = new Set();
    const apps = [];
    for (const entry of await readdir(resolve(productRoot, 'apps'), {
        withFileTypes: true,
    })) {
        const working =
            /^\.([a-z][a-z0-9-]*)\.(?:rename-(?:candidate|previous)-([a-f0-9]{64})|generation-lock(?:\..*)?)$/.exec(
                entry.name
            );
        if (working || WORKING_TREE.test(entry.name)) {
            if (!entry.isDirectory() || entry.isSymbolicLink())
                externalFailure('invalid working directory');
            // Arbre d'un renommage du préfixe : seul ce renommage le tolère.
            if (working?.[2] !== undefined && working[2] !== plan.renaming)
                externalFailure(RENAME_PENDING);
            if (!working) transactionTree(entry.name);
            continue;
        }
        if (entry.name.startsWith('.')) externalFailure('unowned app entry');
        if (!entry.isDirectory() || entry.isSymbolicLink())
            externalFailure('unowned app entry');
        const appRoot = resolve(productRoot, 'apps', entry.name);
        const app = JSON.parse(
            (await readAppManifest(appRoot)).toString('utf8')
        );
        if (app.app_name !== entry.name || !plan.profiles.includes(app.profile))
            externalFailure('unowned app manifest');
        appNames.add(entry.name);
        // ADR-0103 : inventaire scellé, expliqué par ses publications.
        verifyApplicationOwnership(app, plan.manifest.workspace_id);
        for (const source of assertApplicationSources(app))
            inputs.add(source.path);
        await verifyApplicationTrees(productRoot, app);
        apps.push(app);
    }
    // Lot 2 (V3.1 point 3) : `libs` est un espace de produit comme `apps`,
    // pour TOUTES les classes de commande : jamais une source de document ;
    // chaque entrée est le socle ou l'interface d'une appli présente.
    const libraries = resolve(productRoot, LIBS_ROOT);
    if (await pathExists(libraries)) {
        const allowed = new Set(
            [...appNames].flatMap((name) => [
                socleLibraryName(name),
                interfaceLibraryName(name),
            ])
        );
        for (const entry of await readdir(libraries, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink())
                externalFailure('unowned library entry');
            if (
                /^\.[a-z][a-z0-9-]*\.generation-lock(?:\..*)?$/.test(entry.name)
            )
                continue;
            if (WORKING_TREE.test(entry.name)) {
                transactionTree(entry.name);
                continue;
            }
            if (!allowed.has(entry.name))
                externalFailure('unowned library entry');
        }
    }
    // Fraîcheur, après l'intégrité de toutes les applis (N3).
    const binding = [];
    const stale = [];
    for (const app of apps) {
        const read = (path) => sourceDigest(productRoot, path);
        for (const source of app.sources) {
            const found = await read(source.path);
            binding.push({
                app: app.app_name,
                genre: source.genre,
                path: source.path,
                sha256: found?.sha256 ?? null,
                bytes: found?.bytes ?? null,
            });
        }
        for (const drift of await staleSources(app.sources, read))
            stale.push({ app: app.app_name, ...drift });
    }
    const order = (left, right) =>
        left.app < right.app ||
        (left.app === right.app && left.path < right.path)
            ? -1
            : 1;
    binding.sort(order);
    stale.sort(order);
    const ownTransaction =
        plan.transaction !== undefined || plan.renaming !== undefined;
    if (stale.length && commandClass(command) === 'consumer' && !ownTransaction)
        externalFailure(stale.map(staleMessage).join('\n'));
    const runtimeRoots = new Set(RUNTIME_ROOTS);
    async function reserved(directory, prefix = '') {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = prefix + entry.name;
            if (!prefix && runtimeRoots.has(entry.name)) {
                if (entry.isSymbolicLink())
                    externalFailure('symbolic runtime root');
                continue;
            }
            if (
                path === 'descriptions' ||
                path === 'apps' ||
                path === LIBS_ROOT
            ) {
                if (!entry.isDirectory() || entry.isSymbolicLink())
                    externalFailure('invalid product namespace');
                if (path !== 'descriptions' || !documentSources) continue;
            }
            if (entry.isSymbolicLink())
                externalFailure('symbolic workspace entry');
            const documentSource =
                documentSources && !ownedRoots.has(path.split('/')[0]);
            if (documentSource && !entry.isDirectory() && !entry.isFile())
                externalFailure('special document source entry');
            if (entry.isDirectory()) {
                if (
                    !documentSource &&
                    ![...expected, ...inputs].some((name) =>
                        name.startsWith(path + '/')
                    )
                )
                    externalFailure('unowned workspace directory');
                await reserved(resolve(directory, entry.name), path + '/');
            } else if (
                !documentSource &&
                !expected.has(path) &&
                !inputs.has(path) &&
                path !== 'bun.lock'
            ) {
                externalFailure('unowned workspace file');
            }
        }
    }
    await reserved(productRoot);
    return { sourcesBinding: binding, stale };
}

// Lot 2 (V3.1 point 4, L-1) : l'inventaire d'une appli, relatif au produit,
// porte sur ses trois racines. Coque et socle : arbres EXACTS (rien d'ajouté) ;
// interface : fichiers possédés exacts, fichiers non possédés admis SEULEMENT
// dans sa zone libre.
export async function verifyApplicationTrees(productRoot, app) {
    const roots = applicationRoots(app.app_name);
    const owned = await ownedFiles(productRoot, app.generated_files);
    const byRoot = new Map(roots.map((root) => [root, {}]));
    for (const [path, content] of Object.entries(owned)) {
        const root = roots.find((candidate) =>
            path.startsWith(`${candidate}/`)
        );
        if (!root) externalFailure('app inventory outside its roots');
        byRoot.get(root)[path.slice(root.length + 1)] = content;
    }
    const coque = coqueRoot(app.app_name);
    byRoot.get(coque)[SIGNATURE_FILES.appManifest] = await readProductFile(
        resolve(productRoot, coque),
        SIGNATURE_FILES.appManifest
    );
    await verifyGeneratedTree(resolve(productRoot, coque), byRoot.get(coque));
    const socle = socleRoot(app.app_name);
    await verifyGeneratedTree(resolve(productRoot, socle), byRoot.get(socle));
    const ui = interfaceRoot(app.app_name);
    const uiOwned = byRoot.get(ui);
    const uiRoot = resolve(productRoot, ui);
    for (const entry of await treeInventory(uiRoot)) {
        if (Object.hasOwn(uiOwned, entry.path)) continue;
        if (!isInterfaceFreePath(app.app_name, `${ui}/${entry.path}`))
            externalFailure('unowned interface file');
    }
    // Un dossier vide hors de la zone libre n'acquiert pas de propriété.
    const visit = async (directory, prefix) => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const path = `${prefix}${entry.name}/`;
            if (
                !isInterfaceFreePath(app.app_name, `${ui}/${path}`) &&
                !Object.keys(uiOwned).some((owned) => owned.startsWith(path))
            )
                externalFailure('unowned interface directory');
            await visit(resolve(directory, entry.name), path);
        }
    };
    await visit(uiRoot, '');
}

export async function ownedFiles(root, artifacts) {
    const files = {};
    for (const artifact of artifacts) {
        if (Object.hasOwn(files, artifact.path))
            externalFailure('duplicate owned path');
        const content = await readProductFile(root, artifact.path);
        if (
            sha256(content) !== artifact.sha256 ||
            content.length !== artifact.bytes
        )
            externalFailure('workspace ownership drift');
        files[artifact.path] = content.toString('utf8');
    }
    return files;
}

export function inputFilePath(path) {
    safeRelativePath(path);
    const reserved = new Set([
        'package.json',
        'bun.lock',
        'nx.json',
        'tsconfig.base.json',
        'eslint.config.mjs',
        '.prettierrc.json',
        '.prettierignore',
        '.gitignore',
        'README.md',
        'AGENTS.md',
    ]);
    if (reserved.has(path) || isReservedProductPath(path))
        externalFailure('input collides with reserved workspace namespace');
    return path;
}

// Fermeture des entrées d'une conception (lot 2, commit 3 : par GENRE, table
// de `application-sources.mjs`, v4 V4.5). Chaque chemin passe le contrôle
// unique des sources ; une empreinte DÉCLARÉE (preuves de la conception,
// contrat résolu, sources relues dans le contrat) doit égaler les octets.
// Rend [{genre, path, sha256, bytes}], trié par chemin.
export async function productInputClosure(root, designPath, design) {
    inputFilePath(designPath);
    const declared = new Map();
    const declare = (source) => {
        if (source?.snapshot_uri && source.sha256 !== undefined)
            declared.set(source.snapshot_uri, source.sha256);
    };
    for (const source of [
        ...(design.sources ?? []),
        ...(design.backend_contracts ?? []),
    ])
        declare(source);
    // Inputs stay at their declared relative paths; descriptions/ is a
    // convention, not a fallback or an additional business schema.
    const read = async (path) => {
        inputFilePath(path);
        await assertSourcePath(root, path, { label: 'input' });
        const content = await readProductFile(root, path);
        if (declared.has(path) && sha256(content) !== declared.get(path))
            externalFailure(
                'product application-design rejected: workspace app input drift'
            );
        return content;
    };
    for (const reference of design.backend_contracts ?? [])
        for (const source of JSON.parse(
            (await read(reference.snapshot_uri)).toString('utf8')
        ).sources ?? [])
            declare(source);
    return applicationSources(design, designPath, read);
}

// ADR-0103 : inventaire d'application extérieure scellé et mis à jour sous plan.
// Le sceau ne dépend d'aucun secret : il empêche l'adoption par erreur ou en
// silence, pas une forge délibérée (calcul public, `tool` et `plan_id`
// déclaratifs) : voir les limites de l'ADR.
import {
    externalFailure,
    relayEnvshPath,
    safeRelativePath,
} from './external-application-paths.mjs';
import {
    escapeRegExp,
    SIGNATURE,
    SIGNATURE_FILES,
} from './atelier-signature.mjs';
import { sha256, stableStringify } from './generation-manifest.mjs';
import { PREFIX_PATTERN } from './product-identity.mjs';
import {
    coqueRoot,
    INTERFACE_FREE_DIR,
    interfaceRoot,
    PAGE_MODULE,
    SOCLE_ACTIONS_DIR,
    SOCLE_PAGES_DIR,
    SOCLE_QUERIES_DIR,
    socleRoot,
} from './socle-names.mjs';

// Version du sceau, DÉRIVÉE de l'historique (lot 2, commit 6c, v3 V3.5 d) :
// 1.0.0 tant qu'il ne porte que des publications ; 1.1.0 dès qu'il porte un
// renommage du préfixe (lot MARQUE, commit 3) ; 1.2.0 dès qu'il porte une
// mise à jour (`update-app`), avec ou sans renommage. Un manifeste sans
// renommage ni mise à jour ne change donc pas d'un octet.
export const OWNERSHIP_SCHEMA_VERSION = '1.0.0';
export const OWNERSHIP_RENAMED_SCHEMA_VERSION = '1.1.0';
export const OWNERSHIP_UPDATED_SCHEMA_VERSION = '1.2.0';
// Renommage du préfixe : un genre d'enregistrement à part, hors des outils de
// publication.
export const RENAME_TOOL = 'rename-product-prefix';
// Mise à jour d'une appli sous plan (cadrage § 20, lot 2, commit 6c) : un
// genre d'enregistrement à part, qui lie aussi les sources (`sources_before`,
// `sources_after`).
export const UPDATE_TOOL = 'update-app';
// Derniers écrivains DÉRIVÉS, un seul ensemble partagé par le renommage et la
// mise à jour (v2 R2.1.5) : la coque, un renommage, une mise à jour. Un
// fichier écrit en dernier par une publication (composition comprise : v5
// C-B3, page conservée) n'est re-rendu ni par l'un ni par l'autre.
export const DERIVED_WRITERS = Object.freeze(
    new Set(['shell', RENAME_TOOL, UPDATE_TOOL])
);
export function ownershipSchemaVersion(publications) {
    if (publications.some((record) => record?.tool === UPDATE_TOOL))
        return OWNERSHIP_UPDATED_SCHEMA_VERSION;
    if (publications.some((record) => record?.tool === RENAME_TOOL))
        return OWNERSHIP_RENAMED_SCHEMA_VERSION;
    return OWNERSHIP_SCHEMA_VERSION;
}
export const PUBLICATION_TOOLS = Object.freeze([
    'compile:page-execution-plan',
    'generate:action-request',
    'generate:list-query',
    'generate:page-composition',
]);

const HEX = /^[a-f0-9]{64}$/;
const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const digest = (entry) =>
    exactKeys(entry, ['sha256', 'bytes']) &&
    HEX.test(entry.sha256) &&
    Number.isSafeInteger(entry.bytes) &&
    entry.bytes >= 0;

export function inventoryTreeSha(entries) {
    return sha256(
        [...entries]
            .sort((left, right) => left.path.localeCompare(right.path))
            .map((entry) => `${entry.path}\0${entry.sha256}`)
            .join('\0')
    );
}

export function computeOwnershipSeal(manifest) {
    const { seal_sha256: _seal, ...ownership } = manifest.ownership ?? {};
    void _seal;
    return sha256(stableStringify({ ...manifest, ownership }));
}

function inventoryMap(entries) {
    const inventory = new Map();
    for (const entry of entries ?? []) {
        if (
            !exactKeys(entry, ['path', 'bytes', 'sha256']) ||
            inventory.has(entry.path)
        )
            externalFailure('app inventory is invalid');
        inventory.set(entry.path, { sha256: entry.sha256, bytes: entry.bytes });
    }
    return inventory;
}

const inventoryEntries = (inventory) =>
    [...inventory]
        .map(([path, { sha256: hash, bytes }]) => ({
            path,
            bytes,
            sha256: hash,
        }))
        .sort((left, right) => left.path.localeCompare(right.path));

// Lot 2 (V5.1, C-B3) : l'inventaire porte des chemins RELATIFS AU PRODUIT ;
// toutes les publications écrivent dans le socle de leur appli. Contrat de
// page déclaré par la coque, sous son dossier de signature.
export const pageContractPath = (appName, pageId) =>
    `${coqueRoot(appName)}/${SIGNATURE_FILES.pages}/${pageId}.json`;
const SEGMENT = '[a-z0-9][a-z0-9._-]*';
const PAGE_ID = 'page_[a-f0-9]{16}';

// Zone de publication d'un chemin, construite depuis la disposition fixe du
// socle (`socle-names.mjs`, source unique) : commande et lecture sous leur
// dossier, page sous le sien si elle est DÉCLARÉE (contrat de page présent).
// `pageModule` : le module de page du socle (V5.4). `null` hors de toute zone.
export function publicationZone(appName, path, inventory) {
    const socle = escapeRegExp(socleRoot(appName));
    const primitive = new RegExp(
        `^${socle}/(?:${escapeRegExp(SOCLE_ACTIONS_DIR)}|${escapeRegExp(SOCLE_QUERIES_DIR)})/${SEGMENT}/[^/].*$`
    );
    if (primitive.test(path)) return { page: null, pageModule: false };
    const page = new RegExp(
        `^${socle}/${escapeRegExp(SOCLE_PAGES_DIR)}/(${PAGE_ID})/[^/].*$`
    ).exec(path);
    if (!page || !inventory.has(pageContractPath(appName, page[1])))
        return null;
    return {
        page: page[1],
        pageModule:
            path ===
            `${socleRoot(appName)}/${SOCLE_PAGES_DIR}/${page[1]}/${PAGE_MODULE}`,
    };
}

// Racines d'une appli (V3.1 point 4) : tout chemin de son inventaire est sous
// l'une d'elles.
export const applicationRoots = (appName) => [
    coqueRoot(appName),
    socleRoot(appName),
    interfaceRoot(appName),
];

// Zone LIBRE de l'appli (V5.1) : les sources de l'interface, hors fichiers
// possédés. Source unique de la vérification de la racine du produit, du
// contrôle du produit et du test « rendus de la zone libre ⊆ amorces » (R-8a).
export const isInterfaceFreePath = (appName, path) =>
    path.startsWith(`${interfaceRoot(appName)}/${INTERFACE_FREE_DIR}/`);

// Zone d'un chemin du produit pour l'appli : `owned` (dans l'inventaire),
// `free` (sources de l'interface hors inventaire), sinon `null` (aucun
// fichier ne peut y exister sans être possédé).
export function productPathZone(appName, path, inventory) {
    if (inventory.has(path)) return 'owned';
    if (isInterfaceFreePath(appName, path)) return 'free';
    return null;
}

// Zones fermées (V5.1 règle 1, C-B3) : un AJOUT dans une zone de publication ;
// un REMPLACEMENT d'un fichier de l'inventaire, dans une zone, si son DERNIER
// ÉCRIVAIN est un outil de publication, ou si c'est le module de page du socle
// d'une page déclarée (quel que soit son dernier écrivain). Rien d'autre de la
// coque ni de la configuration d'une bibliothèque. `published` (chemins
// ajoutés) ne décide plus de la zone.
export function assertPublicationZone(
    path,
    change,
    inventory,
    writers,
    appName
) {
    safeRelativePath(path);
    if (path.split('/').some((part) => part.startsWith('.')))
        externalFailure('publication outside declared zones');
    const zone = publicationZone(appName, path, inventory);
    if (!zone) externalFailure('publication outside declared zones');
    if (change === 'added') {
        if (inventory.has(path))
            externalFailure('publication adds an owned file');
    } else if (change === 'replaced') {
        if (!inventory.has(path))
            externalFailure('publication replaces an unowned file');
        if (
            !PUBLICATION_TOOLS.includes(writers.get(path) ?? 'shell') &&
            !zone.pageModule
        )
            externalFailure('publication outside declared zones');
    } else externalFailure('publication change is invalid');
}

// Enregistrement de renommage : clés exactes, préfixes valides et différents,
// identité d'espace d'avant ; `replaced` avec `before`, et au plus la paire
// `removed`/`added` des scripts d'entrée nginx des deux préfixes, ensemble,
// sous la coque de l'appli (chemins relatifs au produit, lot 2).
function validRenameRecord(record, appName) {
    if (
        !exactKeys(record, [
            'plan_id',
            'tool',
            'prefix_before',
            'prefix_after',
            'workspace_id_before',
            'files',
        ]) ||
        !HEX.test(record.plan_id) ||
        !HEX.test(record.workspace_id_before) ||
        typeof record.prefix_before !== 'string' ||
        typeof record.prefix_after !== 'string' ||
        !PREFIX_PATTERN.test(record.prefix_before) ||
        !PREFIX_PATTERN.test(record.prefix_after) ||
        record.prefix_before === record.prefix_after ||
        !Array.isArray(record.files) ||
        record.files.length === 0
    )
        externalFailure('rename record is invalid');
    // Forme de chaque entrée d'abord : aucune lecture d'une entrée mal formée.
    for (const file of record.files) {
        const keys = ['path', 'change', 'sha256', 'bytes'];
        const shape =
            file?.change === 'replaced'
                ? exactKeys(file, [...keys, 'before']) &&
                  digest(file.before) &&
                  file.before.sha256 !== file.sha256
                : file?.change === 'added'
                  ? exactKeys(file, keys)
                  : file?.change === 'removed'
                    ? exactKeys(file, ['path', 'change', 'before']) &&
                      digest(file.before)
                    : false;
        if (
            !shape ||
            typeof file.path !== 'string' ||
            (file.change !== 'removed' &&
                !digest({ sha256: file.sha256, bytes: file.bytes }))
        )
            externalFailure('rename record is invalid');
    }
    const paths = record.files.map((file) => file.path);
    if (paths.some((path, index) => index > 0 && paths[index - 1] >= path))
        externalFailure('rename record is invalid');
    const removed = record.files.filter((file) => file.change === 'removed');
    const added = record.files.filter((file) => file.change === 'added');
    if (
        removed.length > 1 ||
        added.length > 1 ||
        removed.length !== added.length ||
        (removed.length === 1 &&
            (removed[0].path !==
                `${coqueRoot(appName)}/${relayEnvshPath(record.prefix_before)}` ||
                added[0].path !==
                    `${coqueRoot(appName)}/${relayEnvshPath(record.prefix_after)}`))
    )
        externalFailure('rename record outside its zone');
}

// Liaison d'un enregistrement de mise à jour : forme de `sources` au
// manifeste d'appli (clés exactes, genre nommé, chemins triés et uniques).
const validSources = (sources) =>
    Array.isArray(sources) &&
    sources.every(
        (entry, index) =>
            exactKeys(entry, ['genre', 'path', 'sha256', 'bytes']) &&
            /^[a-z][a-z0-9-]*$/.test(entry.genre ?? '') &&
            typeof entry.path === 'string' &&
            digest({ sha256: entry.sha256, bytes: entry.bytes }) &&
            (index === 0 || sources[index - 1].path < entry.path)
    );

// Enregistrement `update-app` (v2 R2.1.3) : clés exactes, liaison d'avant et
// d'après complètes, fichiers `added`, `replaced` (avec `before`) ou
// `removed` (avec `before`), triés ; vide seulement si la liaison change.
function validUpdateRecord(record) {
    if (
        !exactKeys(record, [
            'plan_id',
            'tool',
            'sources_before',
            'sources_after',
            'files',
        ]) ||
        !HEX.test(record.plan_id ?? '') ||
        !validSources(record.sources_before) ||
        !validSources(record.sources_after) ||
        !Array.isArray(record.files)
    )
        externalFailure('update record is invalid');
    for (const file of record.files) {
        const keys = ['path', 'change', 'sha256', 'bytes'];
        const shape =
            file?.change === 'replaced'
                ? exactKeys(file, [...keys, 'before']) &&
                  digest(file.before) &&
                  file.before.sha256 !== file.sha256
                : file?.change === 'added'
                  ? exactKeys(file, keys)
                  : file?.change === 'removed'
                    ? exactKeys(file, ['path', 'change', 'before']) &&
                      digest(file.before)
                    : false;
        if (
            !shape ||
            typeof file.path !== 'string' ||
            (file.change !== 'removed' &&
                !digest({ sha256: file.sha256, bytes: file.bytes }))
        )
            externalFailure('update record is invalid');
    }
    const paths = record.files.map((file) => file.path);
    if (paths.some((path, index) => index > 0 && paths[index - 1] >= path))
        externalFailure('update record is invalid');
    if (
        record.files.length === 0 &&
        stableStringify(record.sources_before) ===
            stableStringify(record.sources_after)
    )
        externalFailure('update record is invalid');
}

function validRecord(record, appName) {
    if (record?.tool === RENAME_TOOL) return validRenameRecord(record, appName);
    if (record?.tool === UPDATE_TOOL) return validUpdateRecord(record);
    if (
        !exactKeys(record, ['plan_id', 'tool', 'files']) ||
        !HEX.test(record.plan_id) ||
        !PUBLICATION_TOOLS.includes(record.tool) ||
        !Array.isArray(record.files) ||
        record.files.length === 0
    )
        externalFailure('publication record is invalid');
    const paths = record.files.map((file) => file.path);
    if (paths.some((path, index) => index > 0 && paths[index - 1] >= path))
        externalFailure('publication record is invalid');
    for (const file of record.files) {
        const keys = ['path', 'change', 'sha256', 'bytes'];
        const shape =
            file?.change === 'replaced'
                ? exactKeys(file, [...keys, 'before']) && digest(file.before)
                : exactKeys(file, keys);
        if (
            !shape ||
            !digest({ sha256: file.sha256, bytes: file.bytes }) ||
            (file.change === 'replaced' && file.before.sha256 === file.sha256)
        )
            externalFailure('publication record is invalid');
    }
}

// Zone d'un `replaced` de renommage, d'après le seul manifeste : dernier
// écrivain coque ou renommage, SOUS LA COQUE de l'appli, et jamais son
// dossier de signature. Le socle et l'interface n'y entrent jamais (V5.3 : ils
// ne portent aucune forme du préfixe). Source unique du plan et de la
// vérification.
export function renameMayReplace(path, writer, appName) {
    const coque = `${coqueRoot(appName)}/`;
    return (
        DERIVED_WRITERS.has(writer) &&
        path.startsWith(coque) &&
        !path.startsWith(`${coque}${SIGNATURE.dir}/`)
    );
}

// Renommage, en avant : chaque `replaced` porte sur un fichier dont le
// dernier écrivain est dans la zone (coque, renommage) ; la paire de
// scripts, écrite par la coque ou par un renommage, est retirée
// puis ajoutée. Le script ajouté n'entre pas dans `published` : aucune
// publication ne peut le remplacer, et nulle ne peut l'ajouter à nouveau (il
// est dans l'inventaire).
function applyRename(inventory, record, writers, appName) {
    const next = new Map(inventory);
    const nextWriters = new Map(writers);
    for (const file of record.files) {
        safeRelativePath(file.path);
        const current = inventory.get(file.path);
        if (file.change === 'added') {
            if (current) externalFailure('rename adds an owned file');
            next.set(file.path, { sha256: file.sha256, bytes: file.bytes });
            nextWriters.set(file.path, RENAME_TOOL);
            continue;
        }
        if (!current) externalFailure('rename touches an unowned file');
        if (
            current.sha256 !== file.before.sha256 ||
            current.bytes !== file.before.bytes
        )
            externalFailure('rename replaces a changed file');
        const writer = writers.get(file.path) ?? 'shell';
        if (file.change === 'removed') {
            if (!DERIVED_WRITERS.has(writer))
                externalFailure('rename record outside its zone');
            next.delete(file.path);
            nextWriters.delete(file.path);
            continue;
        }
        if (!renameMayReplace(file.path, writer, appName))
            externalFailure('rename record outside its zone');
        next.set(file.path, { sha256: file.sha256, bytes: file.bytes });
        nextWriters.set(file.path, RENAME_TOOL);
    }
    return { inventory: next, writers: nextWriters };
}

// Zone d'`update-app` (v2 R2.1.5, v5 C-B3), par DERNIER ÉCRIVAIN : un chemin
// des trois racines de l'appli, jamais dans la zone libre de l'interface ; un
// remplacement ou un retrait porte sur un fichier de l'inventaire dont le
// dernier écrivain est dérivé. Un fichier écrit en dernier par une
// publication n'est jamais touché. Source unique du plan et de la
// vérification.
export function updateMayWrite(path, change, inventory, writers, appName) {
    safeRelativePath(path);
    if (!applicationRoots(appName).some((root) => path.startsWith(`${root}/`)))
        return false;
    if (change === 'added')
        return !inventory.has(path) && !isInterfaceFreePath(appName, path);
    return (
        inventory.has(path) && DERIVED_WRITERS.has(writers.get(path) ?? 'shell')
    );
}

// Mise à jour, en avant : chaque fichier dans la zone ; un remplacement ou un
// retrait part de l'empreinte de l'inventaire.
function applyUpdate(inventory, record, writers, appName) {
    const next = new Map(inventory);
    const nextWriters = new Map(writers);
    for (const file of record.files) {
        if (
            !updateMayWrite(file.path, file.change, inventory, writers, appName)
        )
            externalFailure('update record outside its zone');
        if (file.change !== 'added') {
            const current = inventory.get(file.path);
            if (
                current.sha256 !== file.before.sha256 ||
                current.bytes !== file.before.bytes
            )
                externalFailure('update replaces a changed file');
        }
        if (file.change === 'removed') {
            next.delete(file.path);
            nextWriters.delete(file.path);
            continue;
        }
        next.set(file.path, { sha256: file.sha256, bytes: file.bytes });
        nextWriters.set(file.path, UPDATE_TOOL);
    }
    return { inventory: next, writers: nextWriters };
}

// Applique un enregistrement (publication ou renommage) à l'inventaire de
// l'appli `appName`, en contrôlant ses zones. `writers` : dernier écrivain de
// chaque chemin (`shell` par défaut).
export function applyPublication(
    inventory,
    record,
    published,
    writers,
    appName
) {
    validRecord(record, appName);
    if (record.tool === RENAME_TOOL) {
        const renamed = applyRename(inventory, record, writers, appName);
        return { ...renamed, published: new Set(published) };
    }
    if (record.tool === UPDATE_TOOL) {
        const updated = applyUpdate(inventory, record, writers, appName);
        return { ...updated, published: new Set(published) };
    }
    const next = new Map(inventory);
    const nextWriters = new Map(writers);
    for (const file of record.files) {
        assertPublicationZone(
            file.path,
            file.change,
            inventory,
            writers,
            appName
        );
        if (file.change === 'replaced') {
            const current = inventory.get(file.path);
            if (
                current.sha256 !== file.before.sha256 ||
                current.bytes !== file.before.bytes
            )
                externalFailure('publication replaces a changed file');
        }
        next.set(file.path, { sha256: file.sha256, bytes: file.bytes });
        nextWriters.set(file.path, record.tool);
    }
    const nextPublished = new Set(published);
    for (const file of record.files)
        if (file.change === 'added') nextPublished.add(file.path);
    return { inventory: next, published: nextPublished, writers: nextWriters };
}

export function sealShellManifest(manifest, workspaceId) {
    if (!HEX.test(workspaceId ?? ''))
        externalFailure('workspace identity is invalid');
    if (manifest.ownership !== undefined)
        externalFailure('shell manifest is already sealed');
    if (inventoryTreeSha(manifest.generated_files) !== manifest.tree_sha256)
        externalFailure('app inventory digest mismatch');
    const sealed = {
        ...manifest,
        ownership: {
            schema_version: OWNERSHIP_SCHEMA_VERSION,
            workspace_id: workspaceId,
            shell_tree_sha256: manifest.tree_sha256,
            publications: [],
        },
    };
    sealed.ownership.seal_sha256 = computeOwnershipSeal(sealed);
    return sealed;
}

function publishedPaths(publications) {
    const published = new Set();
    for (const record of publications)
        if (!DERIVED_WRITERS.has(record.tool))
            for (const file of record.files)
                if (file.change === 'added') published.add(file.path);
    return published;
}

export function verifyApplicationOwnership(manifest, workspaceId) {
    const ownership = manifest?.ownership;
    if (ownership === undefined) externalFailure('app ownership seal missing');
    if (
        !exactKeys(ownership, [
            'schema_version',
            'workspace_id',
            'shell_tree_sha256',
            'publications',
            'seal_sha256',
        ]) ||
        !HEX.test(ownership.shell_tree_sha256) ||
        !HEX.test(ownership.seal_sha256) ||
        !Array.isArray(ownership.publications) ||
        ownership.schema_version !==
            ownershipSchemaVersion(ownership.publications)
    )
        externalFailure('app ownership seal is invalid');
    if (ownership.workspace_id !== workspaceId)
        externalFailure('app ownership bound to another workspace');
    if (computeOwnershipSeal(manifest) !== ownership.seal_sha256)
        externalFailure('app ownership seal mismatch');
    const current = inventoryMap(manifest.generated_files);
    if (inventoryTreeSha(manifest.generated_files) !== manifest.tree_sha256)
        externalFailure('app inventory digest mismatch');
    // Annulation de la dernière publication à la première : on doit retrouver
    // exactement l'inventaire créé par create-app.
    const shell = new Map(current);
    for (const record of [...ownership.publications].reverse()) {
        validRecord(record, manifest.app_name);
        for (const file of record.files) {
            const entry = shell.get(file.path);
            // Un fichier retiré par un renommage est absent après lui ; on le
            // remet par `before`.
            if (file.change === 'removed') {
                if (entry)
                    externalFailure(
                        'app inventory not explained by sealed publications'
                    );
                shell.set(file.path, { ...file.before });
                continue;
            }
            if (
                !entry ||
                entry.sha256 !== file.sha256 ||
                entry.bytes !== file.bytes
            )
                externalFailure(
                    'app inventory not explained by sealed publications'
                );
            if (file.change === 'added') shell.delete(file.path);
            else shell.set(file.path, { ...file.before });
        }
    }
    if (
        inventoryTreeSha(inventoryEntries(shell)) !==
        ownership.shell_tree_sha256
    )
        externalFailure('app inventory not explained by sealed publications');
    // Rejeu dans l'ordre : chaque enregistrement respecte ses zones ; le
    // dernier écrivain de chaque chemin en découle. Les renommages forment une
    // chaîne : chacun part du préfixe auquel le précédent est arrivé.
    // Les mises à jour forment la chaîne des sources (v2 R2.1.4) : chacune part
    // de la liaison à laquelle la précédente est arrivée, et la dernière
    // arrive à la liaison du manifeste.
    let state = { inventory: shell, published: new Set(), writers: new Map() };
    let prefix;
    let sources;
    for (const record of ownership.publications) {
        if (record.tool === RENAME_TOOL) {
            if (prefix !== undefined && record.prefix_before !== prefix)
                externalFailure('rename record breaks the prefix chain');
            prefix = record.prefix_after;
        }
        if (record.tool === UPDATE_TOOL) {
            if (
                sources !== undefined &&
                stableStringify(record.sources_before) !== sources
            )
                externalFailure('update record breaks the sources chain');
            sources = stableStringify(record.sources_after);
        }
        state = applyPublication(
            state.inventory,
            record,
            state.published,
            state.writers,
            manifest.app_name
        );
    }
    if (sources !== undefined && stableStringify(manifest.sources) !== sources)
        externalFailure('update record breaks the sources chain');
    return {
        inventory: current,
        published: publishedPaths(ownership.publications),
        writers: state.writers,
    };
}

// Dernier écrivain de chaque chemin de l'inventaire : `shell` pour un chemin
// que rien n'a réécrit, sinon l'outil du dernier enregistrement qui l'a écrit.
export function lastWriters(manifest, workspaceId) {
    const { inventory, writers } = verifyApplicationOwnership(
        manifest,
        workspaceId
    );
    return new Map(
        [...inventory.keys()].map((path) => [
            path,
            writers.get(path) ?? 'shell',
        ])
    );
}

// Nouveau manifeste après une publication relue, scellé à nouveau.
export function publishedManifest(manifest, record, workspaceId) {
    if (record?.tool === RENAME_TOOL)
        externalFailure('a rename is not a publication');
    if (record?.tool === UPDATE_TOOL)
        externalFailure('an update is not a publication');
    const { published, writers } = verifyApplicationOwnership(
        manifest,
        workspaceId
    );
    const { inventory } = applyPublication(
        inventoryMap(manifest.generated_files),
        record,
        published,
        writers,
        manifest.app_name
    );
    const generated = inventoryEntries(inventory);
    const next = {
        ...manifest,
        generated_files: generated,
        tree_sha256: inventoryTreeSha(generated),
        ownership: {
            ...manifest.ownership,
            schema_version: ownershipSchemaVersion([
                ...manifest.ownership.publications,
                record,
            ]),
            publications: [...manifest.ownership.publications, record],
        },
    };
    next.ownership.seal_sha256 = computeOwnershipSeal(next);
    verifyApplicationOwnership(next, workspaceId);
    return next;
}

// Manifeste après une mise à jour relue (lot 2, commit 6c) : l'enregistrement
// est ajouté à l'historique ; les champs de la coque (`fields` : conception,
// liaison `sources`, expérience…, hors inventaire et sceau) sont ceux du
// rendu ; l'inventaire suit l'enregistrement ; la version est dérivée.
export function updatedManifest(manifest, record, workspaceId, fields) {
    if (record?.tool !== UPDATE_TOOL)
        externalFailure('update record is invalid');
    const { published, writers } = verifyApplicationOwnership(
        manifest,
        workspaceId
    );
    const { inventory } = applyPublication(
        inventoryMap(manifest.generated_files),
        record,
        published,
        writers,
        manifest.app_name
    );
    const generated = inventoryEntries(inventory);
    const next = {
        ...fields,
        generated_files: generated,
        tree_sha256: inventoryTreeSha(generated),
        ownership: {
            ...manifest.ownership,
            schema_version: ownershipSchemaVersion([
                ...manifest.ownership.publications,
                record,
            ]),
            publications: [...manifest.ownership.publications, record],
        },
    };
    next.ownership.seal_sha256 = computeOwnershipSeal(next);
    verifyApplicationOwnership(next, workspaceId);
    return next;
}

// Manifeste après un renommage du préfixe : l'enregistrement est ajouté à
// l'historique, l'appli est rattachée à la nouvelle identité d'espace, le
// sceau est recalculé, et la version est dérivée de l'historique (1.1.0, ou
// 1.2.0 si une mise à jour le précède : v3 V3.5 d).
export function renamedManifest(manifest, record, workspaceIdAfter) {
    if (record?.tool !== RENAME_TOOL)
        externalFailure('rename record is invalid');
    if (!HEX.test(workspaceIdAfter ?? ''))
        externalFailure('workspace identity is invalid');
    const { published, writers } = verifyApplicationOwnership(
        manifest,
        record.workspace_id_before
    );
    if (workspaceIdAfter === record.workspace_id_before)
        externalFailure('rename keeps the workspace identity');
    const { inventory } = applyPublication(
        inventoryMap(manifest.generated_files),
        record,
        published,
        writers,
        manifest.app_name
    );
    const generated = inventoryEntries(inventory);
    const next = {
        ...manifest,
        generated_files: generated,
        tree_sha256: inventoryTreeSha(generated),
        ownership: {
            ...manifest.ownership,
            schema_version: ownershipSchemaVersion([
                ...manifest.ownership.publications,
                record,
            ]),
            workspace_id: workspaceIdAfter,
            publications: [...manifest.ownership.publications, record],
        },
    };
    next.ownership.seal_sha256 = computeOwnershipSeal(next);
    verifyApplicationOwnership(next, workspaceIdAfter);
    return next;
}

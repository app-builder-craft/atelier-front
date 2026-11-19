// ADR-0103 : inventaire d'application extérieure scellé et mis à jour sous plan.
// Le sceau ne dépend d'aucun secret : il empêche l'adoption par erreur ou en
// silence, pas une forge délibérée (calcul public, `tool` et `plan_id`
// déclaratifs) : voir les limites de l'ADR.
import {
    externalFailure,
    relayEnvshPath,
    safeRelativePath,
} from './external-application-paths.mjs';
import { SIGNATURE, SIGNATURE_FILES } from './atelier-signature.mjs';
import { sha256, stableStringify } from './generation-manifest.mjs';
import { PREFIX_PATTERN } from './product-identity.mjs';

// Version du sceau : 1.0.0 tant que l'historique ne porte que des
// publications ; 1.1.0 dès qu'il porte un enregistrement de renommage du
// préfixe (lot MARQUE, commit 3). Un manifeste sans renommage ne change donc
// pas d'un octet.
export const OWNERSHIP_SCHEMA_VERSION = '1.0.0';
export const OWNERSHIP_RENAMED_SCHEMA_VERSION = '1.1.0';
// Renommage du préfixe : un genre d'enregistrement à part, hors des outils de
// publication, seul à pouvoir retirer un fichier.
export const RENAME_TOOL = 'rename-product-prefix';
// Derniers écrivains dont un renommage peut remplacer un fichier : la coque
// (hors pages), un renommage précédent, la composition de page. Tout fichier
// écrit en dernier par une autre publication est hors de sa zone.
const RENAMEABLE_WRITERS = new Set([
    'shell',
    RENAME_TOOL,
    'generate:page-composition',
]);
export const PUBLICATION_TOOLS = Object.freeze([
    'compile:page-execution-plan',
    'generate:action-request',
    'generate:list-query',
    'generate:page-composition',
    'page-realization',
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

function pageZone(path, inventory) {
    const match = /^src\/app\/pages\/([^/]+)\/[^/].*$/.exec(path);
    return Boolean(
        match && inventory.has(`${SIGNATURE_FILES.pages}/${match[1]}.json`)
    );
}

// Zones fermées : ajout sous generated/ ou dans une page déclarée ; remplacement
// d'un fichier de page de la coque ou d'un fichier ajouté par une publication.
export function assertPublicationZone(path, change, inventory, published) {
    safeRelativePath(path);
    if (
        path.startsWith(`${SIGNATURE.dir}/`) ||
        path.split('/').some((part) => part.startsWith('.'))
    )
        externalFailure('publication outside declared zones');
    const generated = /^src\/app\/generated\/[^/].*$/.test(path);
    if (change === 'added') {
        if (inventory.has(path))
            externalFailure('publication adds an owned file');
        if (!generated && !pageZone(path, inventory))
            externalFailure('publication outside declared zones');
    } else if (change === 'replaced') {
        if (!inventory.has(path))
            externalFailure('publication replaces an unowned file');
        if (!published.has(path) && !pageZone(path, inventory))
            externalFailure('publication outside declared zones');
    } else externalFailure('publication change is invalid');
}

// Enregistrement de renommage : clés exactes, préfixes valides et différents,
// identité d'espace d'avant ; `replaced` avec `before`, et au plus la paire
// `removed`/`added` des scripts d'entrée nginx des deux préfixes, ensemble.
function validRenameRecord(record) {
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
            (removed[0].path !== relayEnvshPath(record.prefix_before) ||
                added[0].path !== relayEnvshPath(record.prefix_after)))
    )
        externalFailure('rename record outside its zone');
}

function validRecord(record) {
    if (record?.tool === RENAME_TOOL) return validRenameRecord(record);
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
// écrivain coque (hors fichier de page), renommage ou composition, et jamais
// le dossier de signature. Source unique du plan et de la vérification.
export function renameMayReplace(path, writer, inventory) {
    return (
        RENAMEABLE_WRITERS.has(writer) &&
        !(writer === 'shell' && pageZone(path, inventory)) &&
        !path.startsWith(`${SIGNATURE.dir}/`)
    );
}

// Renommage, en avant : chaque `replaced` porte sur un fichier dont le
// dernier écrivain est dans la zone (coque hors pages, renommage, composition)
// ; la paire de scripts, écrite par la coque ou par un renommage, est retirée
// puis ajoutée. Le script ajouté n'entre pas dans `published` : aucune
// publication ne peut le remplacer, et nulle ne peut l'ajouter à nouveau (il
// est dans l'inventaire).
function applyRename(inventory, record, writers) {
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
            if (writer !== 'shell' && writer !== RENAME_TOOL)
                externalFailure('rename record outside its zone');
            next.delete(file.path);
            nextWriters.delete(file.path);
            continue;
        }
        if (!renameMayReplace(file.path, writer, inventory))
            externalFailure('rename record outside its zone');
        next.set(file.path, { sha256: file.sha256, bytes: file.bytes });
        nextWriters.set(file.path, RENAME_TOOL);
    }
    return { inventory: next, writers: nextWriters };
}

// Applique un enregistrement (publication ou renommage) à un inventaire, en
// contrôlant ses zones. `writers` : dernier écrivain de chaque chemin
// (`shell` par défaut).
export function applyPublication(
    inventory,
    record,
    published,
    writers = new Map()
) {
    validRecord(record);
    if (record.tool === RENAME_TOOL) {
        const renamed = applyRename(inventory, record, writers);
        return { ...renamed, published: new Set(published) };
    }
    const next = new Map(inventory);
    const nextWriters = new Map(writers);
    for (const file of record.files) {
        assertPublicationZone(file.path, file.change, inventory, published);
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
        if (record.tool !== RENAME_TOOL)
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
            (ownership.publications.some(
                (record) => record?.tool === RENAME_TOOL
            )
                ? OWNERSHIP_RENAMED_SCHEMA_VERSION
                : OWNERSHIP_SCHEMA_VERSION)
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
        validRecord(record);
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
    let state = { inventory: shell, published: new Set(), writers: new Map() };
    let prefix;
    for (const record of ownership.publications) {
        if (record.tool === RENAME_TOOL) {
            if (prefix !== undefined && record.prefix_before !== prefix)
                externalFailure('rename record breaks the prefix chain');
            prefix = record.prefix_after;
        }
        state = applyPublication(
            state.inventory,
            record,
            state.published,
            state.writers
        );
    }
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
    const { published, writers } = verifyApplicationOwnership(
        manifest,
        workspaceId
    );
    const { inventory } = applyPublication(
        inventoryMap(manifest.generated_files),
        record,
        published,
        writers
    );
    const generated = inventoryEntries(inventory);
    const next = {
        ...manifest,
        generated_files: generated,
        tree_sha256: inventoryTreeSha(generated),
        ownership: {
            ...manifest.ownership,
            publications: [...manifest.ownership.publications, record],
        },
    };
    next.ownership.seal_sha256 = computeOwnershipSeal(next);
    verifyApplicationOwnership(next, workspaceId);
    return next;
}

// Manifeste après un renommage du préfixe : l'enregistrement est ajouté à
// l'historique, l'appli est rattachée à la nouvelle identité d'espace, le
// sceau est recalculé, et la version passe à celle qui admet un renommage.
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
        writers
    );
    const generated = inventoryEntries(inventory);
    const next = {
        ...manifest,
        generated_files: generated,
        tree_sha256: inventoryTreeSha(generated),
        ownership: {
            ...manifest.ownership,
            schema_version: OWNERSHIP_RENAMED_SCHEMA_VERSION,
            workspace_id: workspaceIdAfter,
            publications: [...manifest.ownership.publications, record],
        },
    };
    next.ownership.seal_sha256 = computeOwnershipSeal(next);
    verifyApplicationOwnership(next, workspaceIdAfter);
    return next;
}

// Lot 2, commit 6b (conception v5, C-B1 ; index du pilote) : opération
// `files` de la brique de transaction (`product-transaction.mjs`), pour une
// racine EXISTANTE et PARTIELLEMENT possédée (`libs/<app>-interface` : sa
// configuration et ses amorces). Le journal porte, pour chaque fichier LISTÉ
// (ordre des chemins, fixé), son avant (empreinte et octets, ou `null` s'il
// est absent) et son après, et la copie du contenu d'avant
// (`before/<opération>/<index>` dans le dossier du journal) ; les dossiers
// que l'opération crée pour un fichier ajouté sont listés, du plus profond au
// moins profond. La bascule écrit un temporaire nommé par le plan
// (`.<nom>.<plan_id>.tmp`) dans le dossier du fichier, le synchronise, puis le
// renomme sur le fichier. La reprise décide par l'état OBSERVÉ de chaque
// fichier. Aucun fichier non listé n'est lu, déplacé ni copié : un fichier
// libre de l'IA voisin n'entre ni dans l'état, ni dans le retour.
import {
    lstat,
    mkdir,
    open,
    readdir,
    readFile,
    rmdir,
    unlink,
} from 'node:fs/promises';
import { basename, dirname, posix, resolve } from 'node:path';

import {
    assertPhysicalPath,
    externalFailure,
    pathExists,
    safeRelativePath,
} from './external-application-paths.mjs';
import { sha256 } from './generation-manifest.mjs';
import { renameAndSync, writeDocument } from './generation-transaction.mjs';
import { exactKeys } from './product-transaction.mjs';

const HEX = /^[a-f0-9]{64}$/;

// Temporaire d'un fichier listé : nommé par le plan, dans le dossier du
// fichier ; la reprise le retrouve sans rien chercher d'autre.
export const filesTemporary = (absolute, planId) =>
    resolve(dirname(absolute), `.${basename(absolute)}.${planId}.tmp`);

// Copie du contenu d'avant du fichier `index` de l'opération `operation`,
// relative au dossier du journal.
export const filesCopyName = (operation, index) =>
    `before/${operation}/${index}`;

const deeperFirst = (left, right) =>
    right.split('/').length - left.split('/').length ||
    left.localeCompare(right);

async function syncDirectory(path) {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function removeFileAndSync(path) {
    await unlink(path);
    await syncDirectory(dirname(path));
}

// Contenu observé d'un fichier listé : `null` s'il est absent.
async function observe(absolute) {
    let metadata;
    try {
        metadata = await lstat(absolute);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink())
        return { irregular: true };
    const content = await readFile(absolute);
    return { sha256: sha256(content), bytes: content.length, content };
}

const matches = (seen, artifact) =>
    seen !== null &&
    !seen.irregular &&
    seen.sha256 === artifact.sha256 &&
    seen.bytes === artifact.bytes;

// État d'un fichier listé (C-B1) : `before` si son contenu égale l'avant (ou
// s'il est absent et que l'avant est l'absence), `after` s'il égale l'après,
// sinon `ambiguous`.
function stateOf(seen, file) {
    if (file.before === null ? seen === null : matches(seen, file.before))
        return 'before';
    return matches(seen, file.after) ? 'after' : 'ambiguous';
}

// Préparation, rien n'étant écrit dans le produit : l'opération à inscrire au
// journal, et les copies d'avant à poser avec lui (`[nom, octets]`). `files` :
// { chemin relatif à la racine : contenu d'après } ; `operation` : rang de
// l'opération dans le journal.
export async function prepareFilesOperation(
    productRoot,
    root,
    files,
    operation
) {
    const rootAbsolute = resolve(productRoot, safeRelativePath(root));
    await assertPhysicalPath(rootAbsolute);
    if (!(await lstat(rootAbsolute)).isDirectory())
        externalFailure(`files operation root is not a directory: ${root}`);
    const entries = [];
    const copies = [];
    const created = new Set();
    for (const path of Object.keys(files).sort()) {
        const absolute = resolve(rootAbsolute, safeRelativePath(path));
        await assertPhysicalPath(absolute, { missing: true });
        const seen = await observe(absolute);
        if (seen?.irregular)
            externalFailure(
                `files operation target is not a regular file: ${root}/${path}`
            );
        if (seen === null) {
            for (
                let parent = posix.dirname(path);
                parent !== '.';
                parent = posix.dirname(parent)
            )
                if (!(await pathExists(resolve(rootAbsolute, parent))))
                    created.add(`${root}/${parent}`);
        } else
            copies.push([
                filesCopyName(operation, entries.length),
                seen.content,
            ]);
        const content = Buffer.from(files[path]);
        entries.push({
            path,
            before: seen && { sha256: seen.sha256, bytes: seen.bytes },
            after: { sha256: sha256(content), bytes: content.length },
        });
    }
    return {
        operation: {
            root,
            files: entries,
            created_directories: [...created].sort(deeperFirst),
        },
        copies,
    };
}

// Bascule, fichier par fichier, dans l'ordre fixé ; `phase` est appelée après
// l'écriture de chaque temporaire et après chaque renommage (points d'arrêt
// éprouvés).
export async function swapFiles(
    productRoot,
    operation,
    files,
    planId,
    phase = () => undefined
) {
    for (const directory of [...operation.created_directories].reverse()) {
        await mkdir(resolve(productRoot, directory), { recursive: true });
        await syncDirectory(dirname(resolve(productRoot, directory)));
    }
    for (const file of operation.files) {
        const absolute = resolve(productRoot, operation.root, file.path);
        const temporary = filesTemporary(absolute, planId);
        await writeDocument(temporary, Buffer.from(files[file.path]));
        await phase(`file-written:${operation.root}/${file.path}`);
        await renameAndSync(temporary, absolute);
        await phase(`file-swapped:${operation.root}/${file.path}`);
    }
}

// Retour arrière (phase < verified), décidé APRÈS l'examen de tous les
// fichiers de toutes les opérations : un seul fichier `ambiguous` → refus
// nommé (`ambiguous(détail, écart)`), rien n'est déplacé. Un état mixte (des
// fichiers basculés, d'autres non) est l'état normal d'une coupure et revient
// en arrière. Les copies d'avant sont relues et vérifiées avant tout
// déplacement.
export async function planFilesRevert(
    productRoot,
    journalRoot,
    operations,
    planId,
    ambiguous
) {
    const temporaries = [];
    const reverted = [];
    const directories = [];
    const drifted = [];
    for (const [index, operation] of operations.entries()) {
        for (const [position, file] of operation.files.entries()) {
            const absolute = resolve(productRoot, operation.root, file.path);
            temporaries.push(filesTemporary(absolute, planId));
            const state = stateOf(await observe(absolute), file);
            if (state === 'ambiguous')
                drifted.push({
                    tree: operation.root,
                    path: file.path,
                    kind: 'modified',
                });
            else if (state === 'after')
                reverted.push({ index, position, operation, file, absolute });
        }
        directories.push(
            ...operation.created_directories.map((path) =>
                resolve(productRoot, path)
            )
        );
    }
    if (drifted.length > 0)
        ambiguous(`${drifted[0].tree} ${drifted[0].path}`, drifted[0]);
    const actions = [];
    for (const { index, position, operation, file, absolute } of reverted) {
        if (file.before === null) {
            actions.push({ absolute });
            continue;
        }
        let copy;
        try {
            copy = await readFile(
                resolve(journalRoot, filesCopyName(index, position))
            );
        } catch {
            copy = null;
        }
        if (
            copy === null ||
            sha256(copy) !== file.before.sha256 ||
            copy.length !== file.before.bytes
        )
            ambiguous(`${operation.root} ${file.path} journal copy drifted`, {
                tree: operation.root,
                path: file.path,
                kind: 'copy',
            });
        actions.push({
            absolute,
            copy,
            temporary: filesTemporary(absolute, planId),
        });
    }
    return { temporaries, actions, directories };
}

// Déplacements du retour arrière, chacun atomique et rejouable : temporaires
// retirés ; fichier ajouté supprimé ; fichier remplacé réécrit depuis sa
// copie par un temporaire puis un renommage ; dossier créé retiré s'il est
// vide.
export async function revertFiles({ temporaries, actions, directories }) {
    for (const temporary of temporaries)
        if (await pathExists(temporary)) await removeFileAndSync(temporary);
    for (const action of actions)
        if (action.copy === undefined) await removeFileAndSync(action.absolute);
        else {
            await writeDocument(action.temporary, action.copy);
            await renameAndSync(action.temporary, action.absolute);
        }
    for (const directory of directories)
        if (
            (await pathExists(directory)) &&
            (await readdir(directory)).length === 0
        ) {
            await rmdir(directory);
            await syncDirectory(dirname(directory));
        }
}

// Fin (phase `verified`) : chaque fichier listé doit être à son après, sinon
// refus nommé ; les temporaires sont retirés.
export async function completeFiles(
    productRoot,
    operations,
    planId,
    ambiguous
) {
    const temporaries = [];
    for (const operation of operations)
        for (const file of operation.files) {
            const absolute = resolve(productRoot, operation.root, file.path);
            if (!matches(await observe(absolute), file.after))
                ambiguous(`${operation.root} ${file.path} not swapped`, {
                    tree: operation.root,
                    path: file.path,
                    kind: 'modified',
                });
            temporaries.push(filesTemporary(absolute, planId));
        }
    for (const temporary of temporaries)
        if (await pathExists(temporary)) await removeFileAndSync(temporary);
}

const validArtifact = (artifact) =>
    exactKeys(artifact, ['sha256', 'bytes']) &&
    HEX.test(artifact.sha256 ?? '') &&
    Number.isSafeInteger(artifact.bytes);

function safePath(path) {
    try {
        safeRelativePath(path);
        return true;
    } catch {
        return false;
    }
}

// Opération inscrite au journal, contrôlée à la relecture ; `validRoot` : la
// règle des racines de l'appelant. Un journal refusé est un état ambigu.
export const validFilesOperation = (operation, validRoot) =>
    exactKeys(operation, ['root', 'files', 'created_directories']) &&
    validRoot(operation.root) &&
    Array.isArray(operation.files) &&
    operation.files.length > 0 &&
    operation.files.every(
        (file) =>
            exactKeys(file, ['path', 'before', 'after']) &&
            safePath(file.path) &&
            (file.before === null || validArtifact(file.before)) &&
            validArtifact(file.after)
    ) &&
    Array.isArray(operation.created_directories) &&
    operation.created_directories.every(
        (path) =>
            typeof path === 'string' &&
            path.startsWith(`${operation.root}/`) &&
            safePath(path)
    );

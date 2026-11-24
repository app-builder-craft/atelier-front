// Brique de transaction commune d'un produit extérieur, extraite de la
// transaction de MARQUE (`product-prefix-rename-transaction.mjs`, ADR-0103,
// commit 1a) puis généralisée au commit 1b du lot 2 (conception v5, V5.2) :
// journal posé puis réécrit par renommage atomique, à côté du produit ;
// opération `tree` sur une racine ENTIÈREMENT possédée ou ABSENTE, dans
// `apps/` ou `libs/` ; état OBSERVÉ de chaque arbre, comparé aux LISTES
// D'ARTÉFACTS (chemin, empreinte, octets) inscrites au journal, jamais la
// phase seule ; retour arrière et fin décidés par cet état, tout étant
// contrôlé AVANT le premier déplacement ; nettoyage des dossiers de
// préparation. Les messages d'état ambigu passent par la fonction
// `ambiguous` de l'appelant.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { pathExists, treeInventory } from './external-application-paths.mjs';
import {
    removeTreeAndSync,
    renameAndSync,
    syncTreeDirectories,
    writeDocument,
} from './generation-transaction.mjs';

const JOURNAL = 'journal.json';

export const exactKeys = (value, keys) =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

export async function writeTransactionJournal(root, journal) {
    const temporary = resolve(root, `.journal-${randomUUID()}.tmp`);
    await writeDocument(temporary, `${JSON.stringify(journal, null, 2)}\n`);
    await renameAndSync(temporary, resolve(root, JOURNAL));
}

// Journal illisible, ou refusé par `valid` : état ambigu.
export async function readTransactionJournal(root, valid, ambiguous) {
    let journal;
    try {
        journal = JSON.parse(await readFile(resolve(root, JOURNAL), 'utf8'));
    } catch {
        ambiguous('unreadable journal');
    }
    if (!valid(journal)) ambiguous('invalid journal');
    return journal;
}

// Phase `prepared` : documents et journal écrits dans un dossier de
// préparation à côté du produit, puis posés en `root` par un seul renommage.
export async function poseTransactionJournal(
    productRoot,
    stagingPrefix,
    root,
    documents,
    journal
) {
    const staging = await mkdtemp(resolve(dirname(productRoot), stagingPrefix));
    try {
        for (const [name, content] of documents)
            await writeDocument(resolve(staging, name), content);
        await writeTransactionJournal(staging, journal);
        await syncTreeDirectories(staging);
        await renameAndSync(staging, root);
    } catch (error) {
        await removeTreeAndSync(staging);
        throw error;
    }
}

// Dossiers de préparation d'un journal jamais posé : sans effet, retirés sous
// verrou du produit.
export async function removeStagingDirectories(productRoot, stagingPrefix) {
    for (const entry of await readdir(dirname(productRoot), {
        withFileTypes: true,
    }))
        if (entry.name.startsWith(stagingPrefix) && entry.isDirectory())
            await removeTreeAndSync(resolve(dirname(productRoot), entry.name));
}

// Dossiers d'un arbre, chacun suivi de `/`.
async function treeDirectories(root) {
    const directories = [];
    const visit = async (directory) => {
        for (const entry of await readdir(directory, { withFileTypes: true }))
            if (entry.isDirectory()) {
                const absolute = resolve(directory, entry.name);
                directories.push(
                    `${relative(root, absolute).split(sep).join('/')}/`
                );
                await visit(absolute);
            }
    };
    await visit(root);
    return directories;
}

// Arbre EXACTEMENT égal à sa liste d'artéfacts : mêmes chemins, empreintes et
// octets, aucun fichier ni dossier de plus. Un arbre changé n'est jamais
// déplacé ; ce qui rend vérifiable une racine qui ne porte pas de manifeste
// (le socle).
export async function exactTree(root, artifacts) {
    try {
        const actual = await treeInventory(root);
        if (actual.length !== artifacts.length) return false;
        const expected = new Map(artifacts.map((entry) => [entry.path, entry]));
        for (const entry of actual) {
            const wanted = expected.get(entry.path);
            if (
                !wanted ||
                wanted.sha256 !== entry.sha256 ||
                wanted.bytes !== entry.bytes
            )
                return false;
        }
        return (await treeDirectories(root)).every((prefix) =>
            artifacts.some((entry) => entry.path.startsWith(prefix))
        );
    } catch {
        return false;
    }
}

// Premier écart observé d'un arbre avec sa liste d'artéfacts, en chemin
// relatif (M-3) : la commande de reprise le nomme sans chemin local. `tree` :
// le nom de l'arbre, relatif au produit.
export async function firstTreeDrift(root, artifacts, tree) {
    let actual;
    try {
        actual = await treeInventory(root);
    } catch {
        return { tree, path: null, kind: 'entry' };
    }
    const expected = new Map(artifacts.map((entry) => [entry.path, entry]));
    for (const entry of actual) {
        const wanted = expected.get(entry.path);
        if (!wanted) return { tree, path: entry.path, kind: 'unlisted' };
        if (wanted.sha256 !== entry.sha256 || wanted.bytes !== entry.bytes)
            return { tree, path: entry.path, kind: 'modified' };
    }
    const present = new Set(actual.map((entry) => entry.path));
    for (const path of expected.keys())
        if (!present.has(path)) return { tree, path, kind: 'missing' };
    return { tree, path: null, kind: 'tree' };
}

// Candidat partiel ou complet : chaque fichier présent est celui inscrit au
// journal, et aucun dossier n'est étranger à son inventaire.
export async function candidateWithin(root, artifacts) {
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
        return (await treeDirectories(root)).every((prefix) =>
            [...expected.keys()].some((path) => path.startsWith(prefix))
        );
    } catch {
        return false;
    }
}

// Arbres d'une opération `tree` dans son dossier parent (`apps/` ou `libs/`) :
// sortie, candidat, arbre mis de côté. `tree` : { parent, name, candidate,
// previous } (noms dans `parent`, chemin absolu de `parent`).
export async function treeState(tree) {
    const output = resolve(tree.parent, tree.name);
    const candidate = resolve(tree.parent, tree.candidate);
    const previous = resolve(tree.parent, tree.previous);
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

// Échange d'un arbre : la sortie est mise de côté, puis le candidat la
// remplace ; une racine ABSENTE avant (`before === null`, création) reçoit le
// candidat sans rien mettre de côté. `rename` est injectable pour éprouver
// chaque échange.
export async function swapTree(tree, rename) {
    const { output, candidate, previous } = await treeState(tree);
    if (tree.before !== null) await rename(output, previous);
    await rename(candidate, output);
}

// Retour arrière des arbres (phase < verified), décidé par l'état observé.
// Chaque arbre est contrôlé ici et AUCUN n'est déplacé : un état ambigu est
// refusé avant le premier déplacement (règle C). `trees` : { parent, name,
// candidate, previous, files, before, label }, `files` étant la liste
// d'artéfacts d'après (le candidat) et `before` celle d'avant, ou `null` pour
// une racine absente avant. `ambiguous(message, drift)` reçoit aussi le
// premier écart observé (M-3), que l'appelant peut nommer.
export async function planTreesRevert(trees, ambiguous) {
    const actions = [];
    const working = (tree, name) => `${dirname(tree.label)}/${name}`;
    for (const tree of trees) {
        const state = await treeState(tree);
        const label = tree.label;
        const drifted = async (message, root, artifacts, name = label) =>
            ambiguous(message, await firstTreeDrift(root, artifacts, name));
        if (state.hasPrevious) {
            if (tree.before === null)
                ambiguous(`${label} previous tree drifted`);
            if (!(await exactTree(state.previous, tree.before)))
                await drifted(
                    `${label} previous tree drifted`,
                    state.previous,
                    tree.before,
                    working(tree, tree.previous)
                );
            if (state.hasOutput) {
                if (state.hasCandidate) ambiguous(`${label} has several trees`);
                if (!(await exactTree(state.output, tree.files)))
                    await drifted(
                        `${label} renamed tree drifted`,
                        state.output,
                        tree.files
                    );
                actions.push({ kind: 'unswap', state });
            } else {
                if (
                    state.hasCandidate &&
                    !(await candidateWithin(state.candidate, tree.files))
                )
                    await drifted(
                        `${label} candidate drifted`,
                        state.candidate,
                        tree.files,
                        working(tree, tree.candidate)
                    );
                actions.push({ kind: 'restore', state });
            }
            continue;
        }
        if (tree.before === null) {
            if (state.hasOutput) {
                if (state.hasCandidate) ambiguous(`${label} has several trees`);
                if (!(await exactTree(state.output, tree.files)))
                    await drifted(
                        `${label} created tree drifted`,
                        state.output,
                        tree.files
                    );
                actions.push({ kind: 'withdraw', state });
                continue;
            }
        } else if (!state.hasOutput) ambiguous(`${label} tree drifted`);
        else if (!(await exactTree(state.output, tree.before)))
            await drifted(`${label} tree drifted`, state.output, tree.before);
        if (state.hasCandidate) {
            if (!(await candidateWithin(state.candidate, tree.files)))
                await drifted(
                    `${label} candidate drifted`,
                    state.candidate,
                    tree.files,
                    working(tree, tree.candidate)
                );
            actions.push({ kind: 'dispose', state });
        }
    }
    return actions;
}

// Déplacements du retour arrière, chacun atomique et rejouable. `withdraw` :
// une racine créée par la transaction est retirée en passant par son nom de
// candidat.
export async function revertTrees(actions) {
    for (const { kind, state } of actions) {
        if (kind === 'unswap') {
            await renameAndSync(state.output, state.candidate);
            await renameAndSync(state.previous, state.output);
        } else if (kind === 'restore')
            await renameAndSync(state.previous, state.output);
        else if (kind === 'withdraw')
            await renameAndSync(state.output, state.candidate);
        if (await pathExists(state.candidate))
            await removeTreeAndSync(state.candidate);
    }
}

// Fin des arbres (phase `verified`) : en avant, nettoyage seul, après
// contrôle de CHAQUE arbre ; les arbres mis de côté sont alors retirés.
export async function completeTrees(trees, ambiguous) {
    const previous = [];
    for (const tree of trees) {
        const state = await treeState(tree);
        if (
            state.hasCandidate ||
            !state.hasOutput ||
            !(await exactTree(state.output, tree.files))
        )
            ambiguous(`${tree.label} renamed tree drifted`);
        if (state.hasPrevious) {
            if (
                tree.before === null ||
                !(await exactTree(state.previous, tree.before))
            )
                ambiguous(`${tree.label} previous tree drifted`);
            previous.push(state.previous);
        }
    }
    for (const path of previous) await removeTreeAndSync(path);
}

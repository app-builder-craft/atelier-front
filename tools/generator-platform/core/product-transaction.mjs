// Brique de transaction commune d'un produit extérieur, extraite TELLE QUELLE
// de la transaction de MARQUE (`product-prefix-rename-transaction.mjs`,
// ADR-0103) : journal posé puis réécrit par renommage atomique, à côté du
// produit ; état OBSERVÉ des arbres (empreintes), jamais la phase seule ;
// retour arrière et fin décidés par cet état, tout étant contrôlé AVANT le
// premier déplacement ; nettoyage des dossiers de préparation. Les messages
// d'état ambigu passent par la fonction `ambiguous` de l'appelant.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { SIGNATURE_FILES } from './atelier-signature.mjs';
import {
    pathExists,
    readProductFile,
    treeInventory,
    verifyGeneratedTree,
} from './external-application-paths.mjs';
import { sha256 } from './generation-manifest.mjs';
import {
    removeTreeAndSync,
    renameAndSync,
    syncTreeDirectories,
    writeDocument,
} from './generation-transaction.mjs';

const APP_MANIFEST = SIGNATURE_FILES.appManifest;
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

// Empreinte du manifeste d'un arbre EXACT selon son propre manifeste, sinon
// `null` : un arbre changé n'est jamais déplacé.
export async function exactTreeManifestSha(root) {
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

// Arbres d'une opération dans `parent` : sortie, candidat, arbre mis de côté.
// `tree` : { name, candidate, previous } (noms dans `parent`).
export async function treeState(parent, tree) {
    const output = resolve(parent, tree.name);
    const candidate = resolve(parent, tree.candidate);
    const previous = resolve(parent, tree.previous);
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
// remplace ; `rename` est injectable pour éprouver chaque échange.
export async function swapTree(output, candidate, previous, rename) {
    await rename(output, previous);
    await rename(candidate, output);
}

// Retour arrière des arbres (phase < verified), décidé par l'état observé.
// Chaque arbre est contrôlé ici et AUCUN n'est déplacé : un état ambigu est
// refusé avant le premier déplacement (règle C). `trees` : { name, candidate,
// previous, files, before, after, label }, `before` et `after` étant les
// empreintes de manifeste attendues.
export async function planTreesRevert(parent, trees, ambiguous) {
    const actions = [];
    for (const tree of trees) {
        const state = await treeState(parent, tree);
        const label = tree.label;
        const outputSha = state.hasOutput
            ? await exactTreeManifestSha(state.output)
            : undefined;
        if (state.hasPrevious) {
            if ((await exactTreeManifestSha(state.previous)) !== tree.before)
                ambiguous(`${label} previous tree drifted`);
            if (state.hasOutput) {
                if (state.hasCandidate) ambiguous(`${label} has several trees`);
                if (outputSha !== tree.after)
                    ambiguous(`${label} renamed tree drifted`);
                actions.push({ kind: 'unswap', state });
            } else {
                if (
                    state.hasCandidate &&
                    !(await candidateWithin(state.candidate, tree.files))
                )
                    ambiguous(`${label} candidate drifted`);
                actions.push({ kind: 'restore', state });
            }
            continue;
        }
        if (outputSha !== tree.before) ambiguous(`${label} tree drifted`);
        if (state.hasCandidate) {
            if (!(await candidateWithin(state.candidate, tree.files)))
                ambiguous(`${label} candidate drifted`);
            actions.push({ kind: 'dispose', state });
        }
    }
    return actions;
}

// Déplacements du retour arrière, chacun atomique et rejouable.
export async function revertTrees(actions) {
    for (const { kind, state } of actions) {
        if (kind === 'unswap') {
            await renameAndSync(state.output, state.candidate);
            await renameAndSync(state.previous, state.output);
        } else if (kind === 'restore')
            await renameAndSync(state.previous, state.output);
        if (await pathExists(state.candidate))
            await removeTreeAndSync(state.candidate);
    }
}

// Fin des arbres (phase `verified`) : en avant, nettoyage seul, après
// contrôle de CHAQUE arbre ; les arbres mis de côté sont alors retirés.
export async function completeTrees(parent, trees, ambiguous) {
    const previous = [];
    for (const tree of trees) {
        const state = await treeState(parent, tree);
        if (
            state.hasCandidate ||
            !state.hasOutput ||
            (await exactTreeManifestSha(state.output)) !== tree.after
        )
            ambiguous(`${tree.label} renamed tree drifted`);
        if (state.hasPrevious) {
            if ((await exactTreeManifestSha(state.previous)) !== tree.before)
                ambiguous(`${tree.label} previous tree drifted`);
            previous.push(state.previous);
        }
    }
    for (const path of previous) await removeTreeAndSync(path);
}

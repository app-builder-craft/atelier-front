// Lot 2 (conception v5, V5.2) : transactions d'une appli extérieure sur
// plusieurs racines, `create-app` (trois racines créées depuis l'absence) et
// publications (coque et socle), sur la brique commune
// (`product-transaction.mjs`). Le journal vit à côté du produit et porte, pour
// chaque racine, ses listes d'artéfacts d'avant et d'après : c'est ce qui rend
// le socle, sans manifeste, vérifiable. Avant `verified`, toute reprise revient
// à l'état d'avant, décidée par l'état OBSERVÉ ; à `verified`, elle finit en
// avant ; un état ambigu est refusé sans rien déplacer.
import { readdir, rmdir } from 'node:fs/promises';
import { basename, dirname, posix, resolve } from 'node:path';

import { escapeRegExp } from './atelier-signature.mjs';
import {
    externalFailure,
    fileArtifacts,
    pathExists,
} from './external-application-paths.mjs';
import {
    assertGenerationLockFree,
    removeTreeAndSync,
} from './generation-transaction.mjs';
import {
    completeTrees,
    exactKeys,
    planTreesRevert,
    poseTransactionJournal,
    readTransactionJournal,
    removeStagingDirectories,
    revertTrees,
    writeTransactionJournal,
} from './product-transaction.mjs';
import { APPS_ROOT, LIBS_ROOT } from './socle-names.mjs';

// Lot 2, commit 6c : `update` (mise à jour de tout le produit, journal au
// niveau du produit, `application-update-transaction.mjs`).
export const TRANSACTION_GENRES = Object.freeze([
    'creation',
    'publication',
    'update',
]);
export const TRANSACTION_PHASES = Object.freeze([
    'prepared',
    'staged',
    'swapped',
    'verified',
]);
const HEX = /^[a-f0-9]{64}$/;
const APP_NAME = /^[a-z][a-z0-9-]*$/;
const TRANSACTION_ROOT = new RegExp(
    `^(?:${escapeRegExp(APPS_ROOT)}|${escapeRegExp(LIBS_ROOT)})/[a-z][a-z0-9-]*$`
);

export const RECOVERY_COMMAND = 'recover:application-publication';
export const UPDATE_RECOVERY_COMMAND = 'recover:application-update';
// Commande de reprise de chaque genre, nommée par tout refus « pending ».
export const RECOVERY_COMMANDS = Object.freeze({
    creation: RECOVERY_COMMAND,
    publication: RECOVERY_COMMAND,
    update: UPDATE_RECOVERY_COMMAND,
});

// Journal d'une transaction d'appli, à côté du produit, nommé par son genre et
// son plan_id.
export const transactionJournalRoot = (productRoot, genre, planId) =>
    resolve(
        dirname(productRoot),
        `.${basename(productRoot)}.${genre}-${planId}`
    );
const stagingPrefix = (productRoot, genre) =>
    `.${basename(productRoot)}.${genre}-staging-`;

// Journaux de transaction d'appli présents à côté du produit.
export async function pendingTransactionJournals(productRoot) {
    const pattern = new RegExp(
        `^\\.${escapeRegExp(basename(productRoot))}\\.(${TRANSACTION_GENRES.join('|')})-([a-f0-9]{64})$`
    );
    const found = [];
    for (const name of await readdir(dirname(productRoot))) {
        const match = pattern.exec(name);
        if (match) found.push({ genre: match[1], planId: match[2] });
    }
    return found.sort((left, right) =>
        `${left.genre}-${left.planId}`.localeCompare(
            `${right.genre}-${right.planId}`
        )
    );
}

// Arbres de travail d'une racine (`apps/<app>`, `libs/<bibliothèque>`) :
// dans son dossier parent, nommés par le genre et le plan_id.
export const workingTreeName = (rootName, genre, kind, planId) =>
    `.${rootName}.${genre}-${kind}-${planId}`;
// `witness` : programme témoin d'une mise à jour (v3 V3.5 a), à côté de la
// racine dont il prend la place le temps des contrôles.
export const WORKING_TREE = new RegExp(
    `^\\.([a-z][a-z0-9-]*)\\.(${TRANSACTION_GENRES.join('|')})-(candidate|previous|witness)-([a-f0-9]{64})$`
);

// Tout journal présent bloque toute commande extérieure ; seule la
// transaction elle-même (`transaction` : son plan_id) le tolère.
export async function assertNoPendingTransaction(productRoot, transaction) {
    for (const { genre, planId } of await pendingTransactionJournals(
        productRoot
    ))
        if (planId !== transaction) {
            // Transaction d'un autre processus vivant : il tient le verrou.
            await assertGenerationLockFree(productRoot);
            externalFailure(
                `interrupted application ${genre} pending; recover it first (${RECOVERY_COMMANDS[genre]})`
            );
        }
}

// Fichiers d'une racine, relatifs à elle, depuis une carte relative au produit.
export function filesUnder(files, root) {
    const prefix = `${root}/`;
    return Object.fromEntries(
        Object.entries(files)
            .filter(([path]) => path.startsWith(prefix))
            .map(([path, content]) => [path.slice(prefix.length), content])
    );
}

// Arbres d'une transaction : `roots` = [{ root, files, before }], `root` étant
// relatif au produit, `files` les fichiers d'après relatifs à la racine, et
// `before` la liste d'artéfacts d'avant (`null` : racine absente avant).
export function transactionTrees(productRoot, genre, planId, roots) {
    return roots.map(({ root, files, before }) => {
        const name = basename(root);
        return {
            root,
            parent: resolve(productRoot, dirname(root)),
            name,
            candidate: workingTreeName(name, genre, 'candidate', planId),
            previous: workingTreeName(name, genre, 'previous', planId),
            content: files,
            files: fileArtifacts(files),
            before,
            label: root,
        };
    });
}

function journalOf(genre, planId, appName, trees, createdDirectories) {
    return {
        schema_version: '1.0.0',
        kind: 'application-transaction-journal',
        genre,
        plan_id: planId,
        app_name: appName,
        // Dossiers parents créés par la transaction (`libs/` à la première
        // appli) : retirés au retour arrière s'ils sont vides.
        created_directories: createdDirectories,
        trees: trees.map((tree) => ({
            root: tree.root,
            candidate: tree.candidate,
            previous: tree.previous,
            before: tree.before,
            files: tree.files,
        })),
        phase: 'prepared',
    };
}

const validArtifacts = (files) =>
    Array.isArray(files) &&
    files.every(
        (file) =>
            exactKeys(file, ['path', 'bytes', 'sha256']) &&
            HEX.test(file.sha256 ?? '') &&
            Number.isSafeInteger(file.bytes)
    );

// Arbre d'une opération `tree` inscrit au journal (création, publication,
// mise à jour) : racine d'appli, arbres de travail nommés par le genre et le
// plan, listes d'artéfacts.
export const validTransactionTree = (tree, genre, planId) =>
    exactKeys(tree, ['root', 'candidate', 'previous', 'before', 'files']) &&
    typeof tree.root === 'string' &&
    posix.normalize(tree.root) === tree.root &&
    TRANSACTION_ROOT.test(tree.root) &&
    tree.candidate ===
        workingTreeName(basename(tree.root), genre, 'candidate', planId) &&
    tree.previous ===
        workingTreeName(basename(tree.root), genre, 'previous', planId) &&
    (tree.before === null || validArtifacts(tree.before)) &&
    validArtifacts(tree.files);

const validJournal = (journal, genre, planId) =>
    exactKeys(journal, [
        'schema_version',
        'kind',
        'genre',
        'plan_id',
        'app_name',
        'created_directories',
        'trees',
        'phase',
    ]) &&
    Array.isArray(journal.created_directories) &&
    journal.created_directories.every((path) => path === LIBS_ROOT) &&
    journal.schema_version === '1.0.0' &&
    journal.kind === 'application-transaction-journal' &&
    journal.genre === genre &&
    journal.plan_id === planId &&
    APP_NAME.test(journal.app_name ?? '') &&
    TRANSACTION_PHASES.includes(journal.phase) &&
    Array.isArray(journal.trees) &&
    journal.trees.length > 0 &&
    journal.trees.every((tree) => validTransactionTree(tree, genre, planId));

// Refus d'un état ambigu, avec le premier écart observé quand il est connu
// (M-3) : la commande de reprise le nomme, en chemin relatif au produit.
const ambiguousFor = (genre) => (detail, drift) => {
    const error = new Error(
        `external application: ambiguous interrupted application ${genre}: ${detail}`
    );
    if (drift) error.drift = drift;
    throw error;
};

async function readJournal(productRoot, genre, planId) {
    return readTransactionJournal(
        transactionJournalRoot(productRoot, genre, planId),
        (journal) => validJournal(journal, genre, planId),
        ambiguousFor(genre)
    );
}

const journalTrees = (productRoot, journal) =>
    journal.trees.map((tree) => ({
        ...tree,
        parent: resolve(productRoot, dirname(tree.root)),
        name: basename(tree.root),
        label: tree.root,
    }));

// Retour à l'état d'avant (phase < verified) : tout est contrôlé AVANT le
// premier déplacement (règle C), puis le journal est retiré.
async function revertTransaction(productRoot, journal) {
    const actions = await planTreesRevert(
        journalTrees(productRoot, journal),
        ambiguousFor(journal.genre)
    );
    await revertTrees(actions);
    for (const path of journal.created_directories) {
        const absolute = resolve(productRoot, path);
        if (
            (await pathExists(absolute)) &&
            (await readdir(absolute)).length === 0
        )
            await rmdir(absolute);
    }
    await removeTreeAndSync(
        transactionJournalRoot(productRoot, journal.genre, journal.plan_id)
    );
}

// Phase `verified` : en avant, nettoyage seul, après contrôle de l'état.
async function completeTransaction(productRoot, journal) {
    await completeTrees(
        journalTrees(productRoot, journal),
        ambiguousFor(journal.genre)
    );
    await removeTreeAndSync(
        transactionJournalRoot(productRoot, journal.genre, journal.plan_id)
    );
}

// Arbres de travail d'une appli présents dans `apps/` et `libs/`.
async function applicationWorkingTrees(productRoot, appName) {
    const found = [];
    for (const space of [APPS_ROOT, LIBS_ROOT]) {
        const parent = resolve(productRoot, space);
        if (!(await pathExists(parent))) continue;
        for (const name of await readdir(parent)) {
            const match = WORKING_TREE.exec(name);
            if (
                match &&
                [appName, `${appName}-socle`, `${appName}-interface`].includes(
                    match[1]
                )
            )
                found.push({
                    name: `${space}/${name}`,
                    genre: match[2],
                    planId: match[4],
                });
        }
    }
    return found;
}

// Reprise, verrous tenus : la transaction interrompue de l'appli est finie
// (verified) ou annulée ; une transaction d'une AUTRE appli reste et bloque.
// Plusieurs transactions de l'appli, ou un arbre de travail sans journal :
// rien n'est choisi ni déplacé, refus nommé. Les dossiers de préparation d'un
// journal jamais posé sont retirés.
export async function recoverApplicationTransactions(productRoot, appName) {
    const recovered = [];
    const journals = [];
    for (const { genre, planId } of await pendingTransactionJournals(
        productRoot
    )) {
        // Une mise à jour interrompue porte sur tout le produit : elle a sa
        // propre reprise, et bloque celle d'une appli.
        if (genre === 'update')
            externalFailure(
                `interrupted application update pending; recover it first (${UPDATE_RECOVERY_COMMAND})`
            );
        const journal = await readJournal(productRoot, genre, planId);
        if (journal.app_name === appName) journals.push(journal);
    }
    if (journals.length > 1)
        ambiguousFor(journals[0].genre)('several interrupted transactions', {
            tree: appName,
            path: null,
            kind: 'several',
        });
    for (const tree of await applicationWorkingTrees(productRoot, appName))
        if (
            !journals.some(
                (journal) =>
                    journal.genre === tree.genre &&
                    journal.plan_id === tree.planId
            )
        )
            ambiguousFor(tree.genre)('working tree without a journal', {
                tree: tree.name,
                path: null,
                kind: 'orphan',
            });
    for (const journal of journals) {
        const { genre, plan_id: planId } = journal;
        if (journal.phase === 'verified')
            await completeTransaction(productRoot, journal);
        else await revertTransaction(productRoot, journal);
        recovered.push({
            genre,
            plan_id: planId,
            direction: journal.phase === 'verified' ? 'forward' : 'back',
        });
    }
    for (const genre of TRANSACTION_GENRES)
        await removeStagingDirectories(
            productRoot,
            stagingPrefix(productRoot, genre)
        );
    return recovered;
}

// Transaction en cours : journal posé (`prepared`), phases écrites par
// renommage atomique, et fin ou retour selon la phase atteinte.
export async function openTransaction(
    productRoot,
    genre,
    planId,
    appName,
    trees,
    { createdDirectories = [] } = {}
) {
    const root = transactionJournalRoot(productRoot, genre, planId);
    const journal = journalOf(
        genre,
        planId,
        appName,
        trees,
        createdDirectories
    );
    await poseTransactionJournal(
        productRoot,
        stagingPrefix(productRoot, genre),
        root,
        [],
        journal
    );
    return {
        journal,
        async step(phase) {
            journal.phase = phase;
            await writeTransactionJournal(root, journal);
        },
        async settle() {
            const current = await readJournal(productRoot, genre, planId);
            if (current.phase === 'verified')
                await completeTransaction(productRoot, current);
            else await revertTransaction(productRoot, current);
        },
        complete: () => completeTransaction(productRoot, journal),
    };
}

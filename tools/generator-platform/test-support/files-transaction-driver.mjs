// Lot 2, commit 6b : pilote d'essai de l'opération `files` (C-B1), sur les
// fonctions RÉELLES de la brique : journal posé à côté du produit avec les
// copies d'avant, phase réécrite par renommage atomique, reprise par l'état
// observé (retour avant `verified`, fin à `verified`). La transaction
// d'`update-app` (commit 6c) emploie l'opération de la même façon ; ce pilote
// ne sert qu'aux preuves d'arrêt brutal de la brique.
import { basename, dirname, resolve } from 'node:path';

import { removeTreeAndSync } from '../core/generation-transaction.mjs';
import {
    completeFiles,
    planFilesRevert,
    prepareFilesOperation,
    revertFiles,
    swapFiles,
    validFilesOperation,
} from '../core/product-files-operation.mjs';
import {
    exactKeys,
    poseTransactionJournal,
    readTransactionJournal,
    writeTransactionJournal,
} from '../core/product-transaction.mjs';

export const FILES_ROOT = 'libs/demo-interface';

export const filesJournalRoot = (productRoot, planId) =>
    resolve(dirname(productRoot), `.${basename(productRoot)}.files-${planId}`);
const stagingPrefix = (productRoot) =>
    `.${basename(productRoot)}.files-staging-`;

const ambiguous = (detail) => {
    throw new Error(`ambiguous interrupted transaction: ${detail}`);
};

const validJournal = (journal, planId) =>
    exactKeys(journal, ['plan_id', 'operations', 'phase']) &&
    journal.plan_id === planId &&
    ['prepared', 'verified'].includes(journal.phase) &&
    Array.isArray(journal.operations) &&
    journal.operations.every((operation) =>
        validFilesOperation(operation, (root) => root === FILES_ROOT)
    );

// Transaction complète : préparation, journal posé, bascules, `verified`,
// fin. `phase(nom)` est appelée à chaque point d'arrêt.
export async function runFilesTransaction(
    productRoot,
    files,
    planId,
    phase = () => undefined
) {
    const { operation, copies } = await prepareFilesOperation(
        productRoot,
        FILES_ROOT,
        files,
        0
    );
    const root = filesJournalRoot(productRoot, planId);
    const journal = {
        plan_id: planId,
        operations: [operation],
        phase: 'prepared',
    };
    await poseTransactionJournal(
        productRoot,
        stagingPrefix(productRoot),
        root,
        copies,
        journal
    );
    await phase('prepared');
    await swapFiles(productRoot, operation, files, planId, phase);
    journal.phase = 'verified';
    await writeTransactionJournal(root, journal);
    await phase('verified');
    await completeFiles(productRoot, journal.operations, planId, ambiguous);
    await removeTreeAndSync(root);
}

// Reprise : retour avant `verified`, fin à `verified` ; le journal est retiré
// ensuite.
export async function recoverFilesTransaction(productRoot, planId) {
    const root = filesJournalRoot(productRoot, planId);
    const journal = await readTransactionJournal(
        root,
        (value) => validJournal(value, planId),
        ambiguous
    );
    if (journal.phase === 'verified')
        await completeFiles(productRoot, journal.operations, planId, ambiguous);
    else
        await revertFiles(
            await planFilesRevert(
                productRoot,
                root,
                journal.operations,
                planId,
                ambiguous
            )
        );
    await removeTreeAndSync(root);
    return journal.phase === 'verified' ? 'forward' : 'back';
}

// Lot 2 (conception v5, V5.2) : la brique de transaction généralisée
// (`core/product-transaction.mjs`), éprouvée seule sur des arbres réels. Le
// retour arrière est décidé par l'état OBSERVÉ de chaque arbre, comparé aux
// listes d'artéfacts du journal ; tout état ambigu est refusé AVANT le
// premier déplacement, avec son premier écart (M-3). Couvre le trou S1a-1
// (« candidat toujours admis » survivait au commit 1a).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { fileArtifacts } from './core/external-application-paths.mjs';
import {
    completeTrees,
    planTreesRevert,
    revertTrees,
} from './core/product-transaction.mjs';
import { snapshotTree } from './test-support/external-application-fixture.mjs';

const BEFORE = { 'src/index.ts': 'export const A = 1;\n' };
const AFTER = {
    'src/index.ts': 'export const A = 2;\n',
    'src/extra.ts': 'export const B = 1;\n',
};

async function parent(t) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'brique-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'libs'));
    return root;
}

async function write(root, files) {
    for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
    }
}

// Arbre `libs/x` d'une transaction : sortie, candidat et arbre mis de côté
// dans `libs/`. `before === null` : racine absente avant (création).
const tree = (root, before) => ({
    parent: join(root, 'libs'),
    name: 'x',
    candidate: '.x.publication-candidate-0',
    previous: '.x.publication-previous-0',
    files: fileArtifacts(AFTER),
    before: before === null ? null : fileArtifacts(before),
    label: 'libs/x',
});
const at = (root, name) => join(root, 'libs', name);

// Refus attendu, et rien déplacé : l'arbre entier est inchangé.
async function refused(root, trees, message, drift) {
    const frozen = await snapshotTree(root);
    let seen;
    await assert.rejects(
        planTreesRevert(trees, (text, found) => {
            seen = found;
            throw new Error(text);
        }),
        message
    );
    if (drift) assert.deepEqual(seen, drift);
    assert.deepEqual(await snapshotTree(root), frozen);
}

test('S1a-1 : candidat d’une création (racine absente) partiel admis, altéré REFUSÉ et nommé, rien déplacé', async (t) => {
    const root = await parent(t);
    const trees = [tree(root, null)];
    // Candidat partiel, chaque fichier présent est celui du journal : jeté.
    await write(at(root, '.x.publication-candidate-0'), {
        'src/index.ts': AFTER['src/index.ts'],
    });
    assert.deepEqual(
        (await planTreesRevert(trees, assert.fail)).map(({ kind }) => kind),
        ['dispose']
    );
    // Un fichier étranger au journal : ambigu, nommé, rien déplacé.
    await write(at(root, '.x.publication-candidate-0'), {
        'src/stray.ts': 'export {};\n',
    });
    await refused(root, trees, /libs\/x candidate drifted/, {
        tree: 'libs/.x.publication-candidate-0',
        path: 'src/stray.ts',
        kind: 'unlisted',
    });
    // Un fichier du journal altéré : idem.
    await rm(at(root, '.x.publication-candidate-0/src/stray.ts'));
    await write(at(root, '.x.publication-candidate-0'), {
        'src/index.ts': 'export const A = 3;\n',
    });
    await refused(root, trees, /libs\/x candidate drifted/, {
        tree: 'libs/.x.publication-candidate-0',
        path: 'src/index.ts',
        kind: 'modified',
    });
});

test('S1a-1 : candidat altéré à côté d’une sortie mise de côté (restauration) : refusé, rien déplacé', async (t) => {
    const root = await parent(t);
    const trees = [tree(root, BEFORE)];
    await write(at(root, '.x.publication-previous-0'), BEFORE);
    await write(at(root, '.x.publication-candidate-0'), {
        'src/index.ts': 'export const A = 9;\n',
    });
    await refused(root, trees, /libs\/x candidate drifted/);
    // Le même candidat exact : restauration, puis l'état d'avant exact.
    await write(at(root, '.x.publication-candidate-0'), AFTER);
    const actions = await planTreesRevert(trees, assert.fail);
    assert.deepEqual(
        actions.map(({ kind }) => kind),
        ['restore']
    );
    await revertTrees(actions);
    assert.deepEqual(
        (await snapshotTree(join(root, 'libs'))).map(([path]) => path),
        ['x', 'x/src', 'x/src/index.ts']
    );
});

test('échange fait : arbre renommé exact → retour ; altéré → refusé, nommé, rien déplacé', async (t) => {
    const root = await parent(t);
    const trees = [tree(root, BEFORE)];
    await write(at(root, '.x.publication-previous-0'), BEFORE);
    await write(at(root, 'x'), AFTER);
    await write(at(root, 'x'), { 'src/extra.ts': 'export const B = 2;\n' });
    await refused(root, trees, /libs\/x renamed tree drifted/, {
        tree: 'libs/x',
        path: 'src/extra.ts',
        kind: 'modified',
    });
    await write(at(root, 'x'), AFTER);
    const actions = await planTreesRevert(trees, assert.fail);
    assert.deepEqual(
        actions.map(({ kind }) => kind),
        ['unswap']
    );
    await revertTrees(actions);
    assert.deepEqual(
        (await snapshotTree(join(root, 'libs'))).map(([path]) => path),
        ['x', 'x/src', 'x/src/index.ts']
    );
});

test('reprise : une sortie ni avant ni après n’est jamais prise pour l’état d’avant', async (t) => {
    const root = await parent(t);
    const trees = [tree(root, BEFORE)];
    // Aucun arbre de travail, sortie altérée : ambigu, rien déplacé.
    await write(at(root, 'x'), { 'src/index.ts': 'export const A = 5;\n' });
    await refused(root, trees, /libs\/x tree drifted/, {
        tree: 'libs/x',
        path: 'src/index.ts',
        kind: 'modified',
    });
    // Sortie absente d'une racine qui existait avant : ambigu.
    await rm(at(root, 'x'), { recursive: true });
    await refused(root, trees, /libs\/x tree drifted/);
});

test('création échangée : la racine créée est retirée ; fin : candidat restant ou arbre altéré refusés', async (t) => {
    const root = await parent(t);
    const trees = [tree(root, null)];
    await write(at(root, 'x'), AFTER);
    await completeTrees(trees, assert.fail);
    const actions = await planTreesRevert(trees, assert.fail);
    assert.deepEqual(
        actions.map(({ kind }) => kind),
        ['withdraw']
    );
    await revertTrees(actions);
    assert.deepEqual(await snapshotTree(join(root, 'libs')), []);
    await write(at(root, 'x'), AFTER);
    await write(at(root, '.x.publication-candidate-0'), AFTER);
    await assert.rejects(
        completeTrees(trees, (text) => {
            throw new Error(text);
        }),
        /libs\/x renamed tree drifted/
    );
});

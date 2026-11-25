// Lot 2, commit 1 : une seule liste des racines réservées du produit (`libs`
// compris), lue par les trois gardes de chemin ; contrôle unique des chemins
// de source (`assertSourcePath`, N12 ter) ; `libs` est un espace de produit
// pour toute commande (conception v3 V3.1, v4 §V4.6 point 1).
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { SIGNATURE } from './core/atelier-signature.mjs';
import {
    planApplicationWorkspace,
    planCompilationWorkspace,
} from './core/application-workspace.mjs';
import { inputFilePath } from './core/application-workspace-root.mjs';
import { assertCompilationPaths } from './core/compilation-context.mjs';
import {
    assertSourcePath,
    PRODUCT_RESERVED_ROOTS,
    PRODUCT_SPACES,
    RUNTIME_ROOTS,
} from './core/external-application-paths.mjs';
import { LIBS_ROOT } from './core/socle-names.mjs';
import {
    backendArgs,
    documentFixture,
    designArgs,
    runDocumentCli,
} from './test-support/external-document-fixture.mjs';
import {
    fixtureParent,
    snapshotTree,
} from './test-support/external-application-fixture.mjs';
import {
    inspectionCli,
    observationFixture,
} from './test-support/observation-evidence-fixture.mjs';

test('une seule liste de racines réservées, espaces de produit compris', () => {
    assert.deepEqual(PRODUCT_SPACES, ['apps', LIBS_ROOT]);
    assert.deepEqual(PRODUCT_RESERVED_ROOTS, [
        ...PRODUCT_SPACES,
        SIGNATURE.dir,
        ...RUNTIME_ROOTS,
    ]);
    assert.equal(
        new Set(PRODUCT_RESERVED_ROOTS).size,
        PRODUCT_RESERVED_ROOTS.length
    );
    assert.ok(Object.isFrozen(PRODUCT_RESERVED_ROOTS));
});

test('les trois gardes refusent chaque racine réservée de la liste', async (t) => {
    const parent = await fixtureParent(t);
    const context = { productRoot: parent, marker: { files: [] } };
    for (const root of PRODUCT_RESERVED_ROOTS) {
        const path = `${root}/x/y.json`;
        // Consommateurs : fermeture des entrées d'une appli.
        assert.throws(
            () => inputFilePath(path),
            /input collides with reserved workspace namespace/,
            path
        );
        // Auteurs : source et sortie d'une compilation.
        await assert.rejects(
            assertCompilationPaths(context, path, 'descriptions/out.json'),
            /document collides with a reserved workspace namespace/,
            path
        );
        await assert.rejects(
            assertCompilationPaths(context, 'descriptions/in.json', path),
            /document collides with a reserved workspace namespace/,
            path
        );
    }
});

test('la garde des observations refuse chaque racine réservée, fichier valide présent', async (t) => {
    const fixture = await observationFixture(t);
    const selection = await readFile(join(fixture.root, fixture.selectionPath));
    const accepted = inspectionCli(fixture.root, fixture.selectionPath);
    assert.equal(accepted.status, 0, accepted.stderr);
    for (const root of PRODUCT_RESERVED_ROOTS) {
        // Une sélection VALIDE sous la racine réservée : seul le refus du
        // chemin peut l'arrêter.
        const path = `${root}/x/selection.json`;
        await mkdir(join(fixture.root, root, 'x'), { recursive: true });
        await writeFile(join(fixture.root, path), selection);
        const result = inspectionCli(fixture.root, path);
        assert.equal(result.status, 1, path);
        assert.equal(result.stderr, 'OBS_FILE\n', path);
    }
});

test('assertSourcePath : formes fautives refusées, chemin sain admis (N12 ter)', async (t) => {
    const root = await fixtureParent(t);
    await mkdir(join(root, 'descriptions'), { recursive: true });
    await mkdir(join(root, 'elsewhere'), { recursive: true });
    await writeFile(join(root, 'descriptions/ok.json'), '{}\n');
    await writeFile(join(root, 'elsewhere/real.json'), '{}\n');
    assert.equal(
        await assertSourcePath(root, 'descriptions/ok.json'),
        'descriptions/ok.json'
    );
    await assert.rejects(
        assertSourcePath(root, '../x.json'),
        /external application: unsafe relative path/
    );
    await assert.rejects(
        assertSourcePath(root, 'libs/fixture-socle/src/x.json'),
        /source collides with a reserved workspace namespace/
    );
    // Lien symbolique vers le socle d'une appli.
    await symlink(
        join(root, 'libs/fixture-socle/src/x.json'),
        join(root, 'descriptions/lien.json')
    );
    await assert.rejects(
        assertSourcePath(root, 'descriptions/lien.json'),
        /external application: symbolic path/
    );
    await assert.rejects(
        assertSourcePath(root, 'descriptions/lien.json', { missing: true }),
        /external application: symbolic path/
    );
    // Dossier de sources lui-même symbolique.
    await symlink(join(root, 'elsewhere'), join(root, 'linked'));
    await assert.rejects(
        assertSourcePath(root, 'linked/real.json'),
        /external application: symbolic path/
    );
    await assert.rejects(
        assertSourcePath(root, 'linked/absent.json', { missing: true }),
        /external application: symbolic path/
    );
});

test('N12 ter : un auteur ne lit ni n’écrit par un chemin fautif, rien n’est écrit', async (t) => {
    const fixture = await documentFixture(t, 'A');
    const cases = [
        { name: 'relatif', source: '../x.json' },
        {
            name: 'lien vers le socle',
            source: 'descriptions/lien.json',
            setup: () =>
                symlink(
                    join(fixture.root, 'libs/fixture-socle/src/x.json'),
                    join(fixture.root, 'descriptions/lien.json')
                ),
        },
    ];
    for (const entry of cases) {
        await entry.setup?.();
        const before = await snapshotTree(fixture.root);
        const args = designArgs(fixture);
        args[args.indexOf('--source') + 1] = entry.source;
        const result = runDocumentCli('compile-application-design', [
            ...args,
            '--dry-run',
        ]);
        assert.notEqual(result.status, 0, entry.name);
        assert.match(
            result.stderr,
            /unsafe relative path|symbolic path/,
            entry.name
        );
        assert.deepEqual(await snapshotTree(fixture.root), before, entry.name);
    }
});

test('libs : une entrée inconnue est refusée à tout consommateur et à tout auteur', async (t) => {
    const fixture = await documentFixture(t, 'A');
    await mkdir(join(fixture.root, LIBS_ROOT, 'autre'), { recursive: true });
    await assert.rejects(
        planApplicationWorkspace(fixture.options),
        /external application: unowned library entry/
    );
    await assert.rejects(
        planCompilationWorkspace(fixture.options),
        /external application: unowned library entry/
    );
    const author = runDocumentCli('compile-backend-contract', [
        ...backendArgs(fixture, fixture.backendRequests[0]),
        '--dry-run',
    ]);
    assert.notEqual(author.status, 0);
    assert.match(author.stderr, /unowned library entry/);
});

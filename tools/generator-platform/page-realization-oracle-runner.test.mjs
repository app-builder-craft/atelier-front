import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { invocation, main } from './page-realization-oracle-runner.mjs';

// Lot 2 (C-B2) : configurations des trois projets d'une appli `demo-app`.
// `tests` : racines dont le `project.json` déclare la cible `test` ; `vite` :
// racines qui portent une configuration Vite (cible inférée, C-A3).
async function application(t, { tests = [], vite = [] } = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'oracle-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const projects = {
        'apps/demo-app': 'demo-app',
        'libs/demo-app-socle': 'demo-app-socle',
        'libs/demo-app-interface': 'demo-app-interface',
    };
    for (const [projectRoot, name] of Object.entries(projects)) {
        const targets = { lint: {} };
        if (tests.includes(projectRoot)) targets.test = {};
        const files = {
            'project.json': JSON.stringify({ name, targets }),
            ...(vite.includes(projectRoot)
                ? { 'vite.config.mts': 'export default {};\n' }
                : {}),
        };
        for (const [path, content] of Object.entries(files)) {
            await mkdir(dirname(join(root, projectRoot, path)), {
                recursive: true,
            });
            await writeFile(join(root, projectRoot, path), content);
        }
    }
    return root;
}

for (const profile of ['angular-pwa', 'react-spa']) {
    test(`le test ${profile} délègue à la cible native du projet qui la porte (C-B2)`, async (t) => {
        for (const [layout, expected] of [
            [{ tests: ['libs/demo-app-socle'] }, 'demo-app-socle:test'],
            [{ tests: ['apps/demo-app'] }, 'demo-app:test'],
            [{ vite: ['apps/demo-app'] }, 'demo-app:test'],
        ]) {
            const root = await application(t, layout);
            const command = invocation('test', 'demo-app', profile, root);
            assert.equal(command.script, 'node_modules/nx/dist/bin/nx.js');
            assert.deepEqual(command.argv, ['run', expected, '--skipNxCache']);
        }
    });
}

test('le test refuse, nommé, une appli sans projet de test, à deux projets de test ou à projet absent', async (t) => {
    const none = await application(t);
    assert.throws(
        () => invocation('test', 'demo-app', 'angular-pwa', none),
        /un seul projet de test attendu : aucun/
    );
    const two = await application(t, {
        tests: ['apps/demo-app', 'libs/demo-app-socle'],
    });
    assert.throws(
        () => invocation('test', 'demo-app', 'angular-pwa', two),
        /un seul projet de test attendu : demo-app:test, demo-app-socle:test/
    );
    await rm(join(two, 'libs/demo-app-interface'), { recursive: true });
    assert.throws(
        () => invocation('test', 'demo-app', 'angular-pwa', two),
        /projet absent : libs\/demo-app-interface/
    );
});

test('le runner refuse tout oracle hors de la liste fermée', () => {
    assert.throws(
        () => invocation('shell', 'demo-app', 'angular-pwa'),
        /non autorisé/
    );
});

test('sélectionne un compilateur fermé à partir du profil publié', () => {
    assert.equal(
        invocation('compile', 'demo-app', 'angular-pwa').script,
        'node_modules/@angular/compiler-cli/bundles/src/bin/ngc.js'
    );
    assert.equal(
        invocation('compile', 'demo-app', 'react-spa').script,
        'node_modules/typescript/bin/tsc'
    );
    assert.throws(
        () => invocation('compile', 'demo-app', 'unknown'),
        /profil d'application invalide/
    );
});

test('l’oracle lance Nx sans démon, même si l’environnement en demande un', async (t) => {
    const previous = process.env.NX_DAEMON;
    process.env.NX_DAEMON = 'true';
    t.after(() => {
        if (previous === undefined) delete process.env.NX_DAEMON;
        else process.env.NX_DAEMON = previous;
    });
    const calls = [];
    const root = await application(t, { tests: ['libs/demo-app-socle'] });
    main(
        ['--oracle', 'test', '--app', 'demo-app', '--profile', 'angular-pwa'],
        (command, argv, options) => {
            calls.push({ command, argv, options });
            return { status: 0, stdout: '', stderr: '' };
        },
        root
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].argv[0], 'node_modules/nx/dist/bin/nx.js');
    assert.equal(calls[0].options.env.NX_DAEMON, 'false');
    assert.equal(calls[0].options.env.PATH, process.env.PATH);
});

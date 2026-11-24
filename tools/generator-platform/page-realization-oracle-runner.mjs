#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    applicationProjectRoots,
    nativeControls,
} from './core/application-native-controls.mjs';

function fail(message) {
    throw new Error(`page realization oracle: ${message}`);
}

function parseArgs(argv) {
    if (
        argv.length !== 6 ||
        argv[0] !== '--oracle' ||
        argv[2] !== '--app' ||
        argv[4] !== '--profile'
    ) {
        fail(
            'arguments attendus : --oracle <id> --app <nom> --profile <profil>'
        );
    }
    const oracle = argv[1];
    const app = argv[3];
    const profile = argv[5];
    if (!/^[a-z][a-z0-9-]*$/.test(app)) fail("nom d'application invalide");
    if (!['angular-pwa', 'react-spa'].includes(profile))
        fail("profil d'application invalide");
    return { oracle, app, profile };
}

function regularFile(path, label) {
    if (!existsSync(path)) fail(`${label} absent`);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        fail(`${label} doit être un fichier régulier`);
    }
    return path;
}

// C-B2 : le projet qui porte la cible `test` de l'appli, lu dans la liste
// unique des contrôles natifs, sur les configurations de ses trois projets
// sous `root` (le socle d'une appli à session, la coque sinon). Fermé : un
// seul projet, sinon refus nommé.
export function testProject(app, root = process.cwd()) {
    const files = {};
    for (const projectRoot of applicationProjectRoots(app))
        for (const name of [
            'project.json',
            'eslint.config.mjs',
            'vite.config.mts',
        ]) {
            const path = `${projectRoot}/${name}`;
            if (existsSync(join(root, path)))
                files[path] = readFileSync(
                    regularFile(join(root, path), path),
                    'utf8'
                );
        }
    for (const projectRoot of applicationProjectRoots(app))
        if (!Object.hasOwn(files, `${projectRoot}/project.json`))
            fail(`projet absent : ${projectRoot}`);
    const tests = nativeControls(app, files).filter(
        (control) => control.target === 'test'
    );
    if (tests.length !== 1)
        fail(
            `un seul projet de test attendu : ${tests.map(({ label }) => label).join(', ') || 'aucun'}`
        );
    return tests[0].label;
}

export function invocation(oracle, app, profile, root = process.cwd()) {
    if (!['angular-pwa', 'react-spa'].includes(profile))
        fail("profil d'application invalide");
    if (oracle === 'compile') {
        const compiler =
            profile === 'angular-pwa'
                ? {
                      path: 'node_modules/@angular/compiler-cli/bundles/src/bin/ngc.js',
                      label: 'binaire ngc',
                  }
                : {
                      path: 'node_modules/typescript/bin/tsc',
                      label: 'binaire tsc',
                  };
        return {
            script: regularFile(compiler.path, compiler.label),
            argv: ['-p', `apps/${app}/tsconfig.app.json`, '--noEmit'],
        };
    }
    const script = regularFile('node_modules/nx/dist/bin/nx.js', 'binaire Nx');
    if (oracle === 'build') {
        return {
            script,
            argv: ['run', `${app}:build:production`, '--skipNxCache'],
        };
    }
    if (oracle === 'lint') {
        return { script, argv: ['run', `${app}:lint`, '--skipNxCache'] };
    }
    if (oracle === 'test') {
        return {
            script,
            argv: ['run', testProject(app, root), '--skipNxCache'],
        };
    }
    fail(`oracle non autorisé : ${oracle}`);
}

// Aucun démon Nx : il survivrait à l'oracle et écrirait plus tard dans
// l'arbre courant, comme ailleurs dans le dépôt (NX_DAEMON=false).
export function oracleEnvironment(environment = process.env) {
    return { ...environment, NX_DAEMON: 'false' };
}

export function main(
    argv = process.argv.slice(2),
    spawn = spawnSync,
    root = process.cwd()
) {
    const { oracle, app, profile } = parseArgs(argv);
    const command = invocation(oracle, app, profile, root);
    const result = spawn(process.execPath, [command.script, ...command.argv], {
        cwd: root,
        env: oracleEnvironment(),
        shell: false,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) fail(result.error.message);
    if (result.signal) fail(`terminé par le signal ${result.signal}`);
    if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    try {
        main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

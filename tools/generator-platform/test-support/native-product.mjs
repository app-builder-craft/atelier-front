// Produits fictifs écrits sur disque pour les preuves natives LÉGÈRES des
// frontières (lot 2) : l'espace rendu, deux applis d'un profil, leurs
// amorces, le verrou de l'atelier (Nx y lit les dépendances externes) et les
// dépendances LIÉES depuis l'atelier (comme T13, aucune installation). Nx
// tourne sans démon, ses données sous le produit.
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { renderAngularPwaShell } from '../renderers/angular-pwa-shell-renderer.mjs';
import { renderApplicationWorkspace } from '../renderers/application-workspace-renderer.mjs';
import { renderReactSpaShell } from '../renderers/react-spa-shell-renderer.mjs';
import {
    applicationDesign,
    FIXTURE_PREFIX,
} from './application-design-fixture.mjs';
import { createApplicationSessionFixture } from './application-session-fixture.mjs';
import { fixtureParent, TOOLS_ROOT } from './external-application-fixture.mjs';

export const run = promisify(execFile);

// Produit fictif d'un profil : l'espace, l'appli `app` (à session en
// Angular) et une seconde appli `other` du même profil, sans session.
export async function nativeProduct(t, profile) {
    const root = join(await fixtureParent(t), profile);
    await mkdir(root);
    const source = JSON.parse(await readFile(join(TOOLS_ROOT, 'package.json')));
    const packages = Object.fromEntries(
        ['dependencies', 'devDependencies'].flatMap((group) =>
            Object.entries(source[group] ?? {}).map(([name, version]) => [
                name,
                { group, version },
            ])
        )
    );
    const files = {
        // Nx lit les dépendances externes dans le verrou du produit (T13).
        'bun.lock': await readFile(join(TOOLS_ROOT, 'bun.lock')),
        ...(await renderApplicationWorkspace({
            profiles: [profile],
            packages,
            packageManager: source.packageManager,
            engines: source.engines,
            githubRepository: 'fixture-laboratory/native-boundaries',
            reviewOwner: 'fixture-reviewer',
        })),
    };
    const angular = profile === 'angular-pwa';
    const shell = applicationDesign('a'.repeat(64), 'b'.repeat(64));
    const plain = angular
        ? shell
        : {
              ...shell,
              experiences: shell.experiences.map((experience) => ({
                  ...experience,
                  offline_policy: 'none',
              })),
          };
    const session = angular
        ? await createApplicationSessionFixture({ domain: 'observatory' })
        : undefined;
    const render = angular ? renderAngularPwaShell : renderReactSpaShell;
    for (const [appName, design] of [
        ['app', session?.design ?? plain],
        ['other', plain],
    ]) {
        const output = await render({
            design,
            experienceId: design.experiences[0].id,
            appName,
            designPath: `descriptions/${appName}.json`,
            designSha256: 'c'.repeat(64),
            externalWorkspace: true,
            prefix: FIXTURE_PREFIX,
        });
        Object.assign(files, output.files, output.seeds);
    }
    for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
    }
    await mkdir(join(root, 'node_modules'));
    for (const entry of await readdir(join(TOOLS_ROOT, 'node_modules')))
        if (!['.cache', '.vite', '.vite-temp', '.nx'].includes(entry))
            await symlink(
                join(TOOLS_ROOT, 'node_modules', entry),
                join(root, 'node_modules', entry)
            );
    return { root, files };
}

export const nativeEnv = (root) => ({
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    HOME: root,
    TMPDIR: root,
    CI: 'true',
    NX_DAEMON: 'false',
    NX_NO_CLOUD: 'true',
    NX_ISOLATE_PLUGINS: 'false',
    NX_WORKSPACE_DATA_DIRECTORY: join(root, '.nx/workspace-data'),
    NX_CACHE_DIRECTORY: join(root, '.nx/cache'),
});

// Cible Nx d'un projet du produit, SEULE (`--exclude-task-dependencies` :
// `check-socle`, qui vérifie des dépendances INSTALLÉES, ne tourne pas sur
// des dépendances liées). Les arguments en plus vont à la commande native
// (`--format=json` pour ESLint). Rend le code de sortie et la sortie sans
// couleur ni préfixe de projet.
export async function nxTarget(root, project, target, extra = []) {
    const result = await run(
        process.execPath,
        [
            join(root, 'node_modules/nx/dist/bin/nx.js'),
            'run',
            `${project}:${target}`,
            '--exclude-task-dependencies',
            '--skip-nx-cache',
            '--output-style=stream-without-prefixes',
            ...extra,
        ],
        { cwd: root, env: nativeEnv(root), maxBuffer: 64 * 1024 * 1024 }
    ).then(
        (output) => ({ ...output, code: 0 }),
        (error) => error
    );
    return {
        code: result.code,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(
            // eslint-disable-next-line no-control-regex
            /\u001b\[[0-9;]*m/g,
            ''
        ),
    };
}

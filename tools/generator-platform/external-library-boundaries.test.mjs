// Lot 2 (conception v4 §V4.4 et commit 1 ; v5 R-3) : frontières des deux
// bibliothèques d'une appli, éprouvées par les OUTILS NATIFS du produit sur
// des produits fictifs écrits sur disque (dépendances liées depuis l'atelier,
// comme T13) :
// - R-R : les alias de la coque, RÉSOLUS, visent les fichiers des alias de la
//   racine ; la coque a exactement une clé de plus, la clé exacte de son
//   entrée réservée ;
// - TypeScript ne résout ni `@socle-coque/<autre>` depuis la coque, ni
//   `@socle-coque/<app>` depuis l'interface (TS2307, R-S c) ;
// - `^typecheck` : la construction de la coque dépend de la vérification de
//   types de ses bibliothèques (graphe des tâches de Nx), en Angular (cible
//   déclarée, ngc) comme en React (cible inférée, tsc) ;
// - `no-restricted-imports` : l'ESLint du produit refuse, dans l'interface,
//   l'entrée réservée à la coque.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import ts from 'typescript';

import { renderAngularPwaShell } from './renderers/angular-pwa-shell-renderer.mjs';
import { renderApplicationWorkspace } from './renderers/application-workspace-renderer.mjs';
import { renderReactSpaShell } from './renderers/react-spa-shell-renderer.mjs';
import { applicationDesign } from './test-support/application-design-fixture.mjs';
import { FIXTURE_PREFIX } from './test-support/application-design-fixture.mjs';
import { createApplicationSessionFixture } from './test-support/application-session-fixture.mjs';
import {
    fixtureParent,
    TOOLS_ROOT,
} from './test-support/external-application-fixture.mjs';

const run = promisify(execFile);

// Produit fictif d'un profil : l'espace, l'appli `app` (à session en
// Angular) et une seconde appli `other` du même profil, sans session.
async function nativeProduct(t, profile) {
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

const options = (root, path) =>
    ts.getParsedCommandLineOfConfigFile(
        join(root, path),
        {},
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: assert.fail }
    ).options;
const resolved = (root, config, from, specifier) =>
    ts.resolveModuleName(
        specifier,
        join(root, from),
        options(root, config),
        ts.sys
    ).resolvedModule?.resolvedFileName;

for (const profile of ['angular-pwa', 'react-spa']) {
    test(`${profile} : R-R après résolution, clé exacte de la coque, TS2307 hors de sa portée`, async (t) => {
        const { root, files } = await nativeProduct(t, profile);
        const base = JSON.parse(files['tsconfig.base.json']).compilerOptions
            .paths;
        const coque = JSON.parse(files['apps/app/tsconfig.json'])
            .compilerOptions.paths;
        // R-R : pour chaque clé de la racine, la cible résolue depuis le
        // fichier qui la déclare est la même ; jamais une comparaison de texte.
        for (const [key, targets] of Object.entries(base))
            assert.deepEqual(
                coque[key].map((target) => resolve(root, 'apps/app', target)),
                targets.map((target) => resolve(root, target)),
                key
            );
        assert.deepEqual(
            Object.keys(coque).sort(),
            [...Object.keys(base), '@socle-coque/app'].sort()
        );
        // Résolution par TypeScript lui-même, avec la configuration de chaque
        // projet.
        const main = `apps/app/src/${profile === 'angular-pwa' ? 'main.ts' : 'main.tsx'}`;
        const coqueConfig = 'apps/app/tsconfig.app.json';
        assert.equal(
            resolved(root, coqueConfig, main, '@socle-coque/app'),
            join(root, 'libs/app-socle/src/coque.ts')
        );
        assert.equal(
            resolved(root, coqueConfig, main, '@interface/app'),
            join(root, 'libs/app-interface/src/index.ts')
        );
        // L'entrée réservée d'une AUTRE appli, depuis la coque : non résolue.
        assert.equal(
            resolved(root, coqueConfig, main, '@socle-coque/other'),
            undefined
        );
        // Depuis l'interface, l'entrée réservée de sa propre coque : non
        // résolue ; son API publique, résolue.
        const page = 'libs/app-interface/src/index.ts';
        const uiConfig = 'libs/app-interface/tsconfig.lib.json';
        assert.equal(
            resolved(root, uiConfig, page, '@socle-coque/app'),
            undefined
        );
        assert.equal(
            resolved(root, uiConfig, page, '@socle/app'),
            join(root, 'libs/app-socle/src/index.ts')
        );
    });
}

const env = (root) => ({
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

test(
    '^typecheck : la construction de la coque dépend de la vérification de types de ses bibliothèques (graphe des tâches Nx)',
    { timeout: 240_000 },
    async (t) => {
        // Angular à session : la coque importe le socle et l'interface ;
        // React sans session : l'interface seule (aucune arête vers le socle).
        for (const [profile, libraries] of [
            ['angular-pwa', ['app-interface', 'app-socle']],
            ['react-spa', ['app-interface']],
        ]) {
            const { root } = await nativeProduct(t, profile);
            const { stdout } = await run(
                process.execPath,
                [
                    join(root, 'node_modules/nx/dist/bin/nx.js'),
                    'run',
                    'app:build:production',
                    '--graph=stdout',
                ],
                {
                    cwd: root,
                    env: env(root),
                    maxBuffer: 64 * 1024 * 1024,
                }
            );
            // Graphe des tâches de `nx run … --graph=stdout` : `tasks.tasks` et
            // `tasks.dependencies` (Nx 24).
            const { tasks } = JSON.parse(stdout.slice(stdout.indexOf('{')));
            const build = 'app:build:production';
            assert.ok(tasks.tasks[build], `${profile} : ${build}`);
            assert.deepEqual(
                tasks.dependencies[build]
                    .map(({ id }) => id)
                    // Vérifications des BIBLIOTHÈQUES (React lance aussi celle
                    // de la coque, `typecheck`).
                    .filter(
                        (id) =>
                            id.endsWith(':typecheck') && !id.startsWith('app:')
                    )
                    .sort(),
                libraries.map((name) => `${name}:typecheck`),
                profile
            );
        }
    }
);

test(
    'no-restricted-imports : l’ESLint du produit refuse dans l’interface l’entrée réservée à la coque',
    { timeout: 240_000 },
    async (t) => {
        for (const profile of ['angular-pwa', 'react-spa']) {
            const { root } = await nativeProduct(t, profile);
            const probe = 'libs/app-interface/src/probe.ts';
            // ESLint du produit, lancé dans le produit (un processus par
            // produit : la configuration TypeScript-ESLint est par racine).
            const rules = async (specifier) => {
                await writeFile(
                    join(root, probe),
                    `export * from '${specifier}';\n`
                );
                const output = await run(
                    process.execPath,
                    [
                        join(root, 'node_modules/eslint/bin/eslint.js'),
                        '--format',
                        'json',
                        probe,
                    ],
                    { cwd: root, env: env(root), maxBuffer: 16 * 1024 * 1024 }
                ).catch((error) => error);
                const [result] = JSON.parse(output.stdout);
                return result.messages.map(
                    ({ ruleId, message }) => ruleId ?? message
                );
            };
            assert.ok(
                (await rules('@socle-coque/app')).includes(
                    'no-restricted-imports'
                ),
                profile
            );
            assert.ok(
                !(await rules('@socle/app')).includes('no-restricted-imports'),
                profile
            );
        }
    }
);

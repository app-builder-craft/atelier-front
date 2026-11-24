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
// (L'entrée réservée à la coque refusée par l'ESLint du produit est éprouvée
// avec les frontières natives du commit 2, `external-library-frontiers.test.mjs`.)
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';

import ts from 'typescript';

import {
    nativeEnv,
    nativeProduct,
    run,
} from './test-support/native-product.mjs';

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
                    env: nativeEnv(root),
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

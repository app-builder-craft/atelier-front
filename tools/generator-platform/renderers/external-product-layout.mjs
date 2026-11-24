// Lot 2 (conception v5, V5.1) : disposition d'une appli EXTÉRIEURE en trois
// racines, structure neutre et contenu natif par pile. La coque
// (`apps/<app>`) garde tout ce qui porte une forme du préfixe ; le socle
// (`libs/<app>-socle`, arbre exact) reçoit la session et, plus tard, tout le
// code publié ; l'interface (`libs/<app>-interface`) n'a de possédé que sa
// configuration et sa carte des pages, ses amorces de page étant libres. Le
// mode interne (sans `--target-root`) garde sa disposition à une racine.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { SIGNATURE_FILES } from '../core/atelier-signature.mjs';
import { canonicalizeGeneratedFiles } from '../core/canonicalize-generated.mjs';
import {
    coqueRoot,
    EMPTY_PAGE_MODULE,
    INTERFACE_ENTRY,
    INTERFACE_PAGES_DIR,
    interfaceAlias,
    interfaceLibraryName,
    interfaceRoot,
    PAGE_MODULE,
    ROOT_PATH_ALIASES,
    SOCLE_COQUE_ENTRY,
    SOCLE_ENTRY,
    SOCLE_PAGES_DIR,
    SOCLE_SESSION_DIR,
    socleAlias,
    socleCoqueAlias,
    socleLibraryName,
    socleRoot,
} from '../core/socle-names.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// L-5 (V5.5) : un projet porte une cible `test` si, et seulement si, ses
// fichiers rendus contiennent au moins une spec. Source unique de la règle,
// lue par le rendu ET par la liste des contrôles natifs (C-B2, C-A3).
export const SPEC_FILE = /\.spec\.tsx?$/;
export const hasSpecs = (paths) => paths.some((path) => SPEC_FILE.test(path));

// Chemins de la coque vers les bibliothèques (§V4.4) : les deux motifs racine
// RE-BASÉS par le calcul du chemin relatif, plus la clé EXACTE de l'entrée
// réservée à la coque. Aucun chemin écrit à la main.
export function coquePaths(appName) {
    const up = posix.relative(coqueRoot(appName), '.');
    const paths = {};
    for (const [alias, targets] of Object.entries(ROOT_PATH_ALIASES))
        paths[alias] = targets.map((target) => posix.join(up, target));
    paths[socleCoqueAlias(appName)] = [
        posix.join(up, socleRoot(appName), SOCLE_COQUE_ENTRY),
    ];
    return paths;
}

// Spécifieurs de la coque : API publique du socle, entrée de la coque et
// carte des pages de l'interface.
export const coqueSpecifiers = (appName) => ({
    socle: socleAlias(appName),
    coque: socleCoqueAlias(appName),
    pages: interfaceAlias(appName),
});

// Tags des trois projets (L-3) ; les contraintes viennent au commit 2.
export const coqueTags = (appName, experienceId) => [
    'type:app',
    `experience:${experienceId}`,
    `app:${appName}`,
];
const LAYER = { socle: 'layer:socle', interface: 'layer:interface' };

// Fichier de configuration du projet d'une bibliothèque. Angular : cible
// `typecheck` déclarée (ngc, `strictTemplates`, sans émettre), lancée depuis
// la racine du projet comme la cible inférée qu'elle remplace ; React : la
// cible est inférée par `@nx/js/typescript` (`tsc -p tsconfig.lib.json
// --noEmit`). Cible `test` selon L-5.
function libraryProject({ profile, appName, layer, root, specs }) {
    const angular = profile === 'angular-pwa';
    const up = posix.relative(root, '.');
    const targets = {
        lint: { options: { config: 'eslint.config.mjs', 'max-warnings': 0 } },
    };
    if (angular) {
        targets.typecheck = {
            executor: 'nx:run-commands',
            options: {
                command: `node ${up}/node_modules/@angular/compiler-cli/bundles/src/bin/ngc.js -p tsconfig.lib.json --noEmit`,
                cwd: root,
            },
        };
        if (specs)
            // V5.5 : `buildTarget` vise la construction de la COQUE (un autre
            // projet) ; racine et sources sont celles de la bibliothèque.
            targets.test = {
                executor: '@angular/build:unit-test',
                options: {
                    buildTarget: `${appName}:build:development`,
                    tsConfig: `${root}/tsconfig.spec.json`,
                    runnerConfig: `${SIGNATURE_FILES.support}/angular-unit-test.config.mjs`,
                    watch: false,
                },
            };
    }
    return json({
        name:
            layer === 'socle'
                ? socleLibraryName(appName)
                : interfaceLibraryName(appName),
        $schema: `${up}/node_modules/nx/schemas/project-schema.json`,
        projectType: 'library',
        sourceRoot: `${root}/src`,
        ...(angular ? { prefix: 'app' } : {}),
        tags: [LAYER[layer], `app:${appName}`],
        targets,
    });
}

// C-A3 : en React, la cible `test` est INFÉRÉE par `@nx/vitest` dès qu'une
// configuration Vite existe ; L-5 s'y réalise donc par le RENDU conditionnel
// de `vite.config.mts`, porteur de la section `test` et de
// `resolve.tsconfigPaths`.
function libraryViteConfig(root, name) {
    return `/// <reference types="vitest" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
    root: import.meta.dirname,
    cacheDir: '../../node_modules/.vite/${root}',
    plugins: [react()],
    resolve: { tsconfigPaths: true },
    test: {
        name: ${JSON.stringify(name)},
        watch: false,
        globals: true,
        environment: 'jsdom',
        include: ['src/**/*.spec.{ts,tsx}'],
        reporters: ['default'],
    },
}));
`;
}

// TypeScript 6.0.3 : avec `outDir` et sans `rootDir`, un fichier importé hors
// du dossier du tsconfig est refusé TS6059, même sans émettre (mesuré). Les
// trois projets d'une appli s'importent par leurs alias : `rootDir` est la
// racine du produit, calculée depuis celle du projet.
export const productRootDir = (root) => posix.relative(root, '.');

function libraryTsconfigs({ profile, specs, root }) {
    const angular = profile === 'angular-pwa';
    const rootDir = productRootDir(root);
    const references = [{ path: './tsconfig.lib.json' }];
    if (specs) references.push({ path: './tsconfig.spec.json' });
    const files = {
        'tsconfig.json': json(
            angular
                ? {
                      extends: '../../tsconfig.base.json',
                      compilerOptions: {
                          noPropertyAccessFromIndexSignature: true,
                          isolatedModules: true,
                          emitDecoratorMetadata: false,
                      },
                      angularCompilerOptions: {
                          enableI18nLegacyMessageIdFormat: false,
                          strictInjectionParameters: true,
                          strictInputAccessModifiers: true,
                          strictTemplates: true,
                      },
                      files: [],
                      include: [],
                      references,
                  }
                : {
                      extends: '../../tsconfig.base.json',
                      compilerOptions: {
                          jsx: 'react-jsx',
                          allowJs: false,
                          allowSyntheticDefaultImports: true,
                          strict: true,
                      },
                      files: [],
                      include: [],
                      references,
                  }
        ),
        'tsconfig.lib.json': json(
            angular
                ? {
                      extends: './tsconfig.json',
                      compilerOptions: {
                          outDir: '../../dist/out-tsc',
                          rootDir,
                          types: ['@angular/localize'],
                      },
                      include: ['src/**/*.ts'],
                      exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
                  }
                : {
                      extends: './tsconfig.json',
                      compilerOptions: {
                          outDir: '../../dist/out-tsc',
                          rootDir,
                      },
                      include: ['src/**/*.ts', 'src/**/*.tsx'],
                      exclude: [
                          'src/**/*.spec.ts',
                          'src/**/*.test.ts',
                          'src/**/*.spec.tsx',
                          'src/**/*.test.tsx',
                      ],
                  }
        ),
    };
    if (specs)
        files['tsconfig.spec.json'] = json(
            angular
                ? {
                      extends: './tsconfig.json',
                      compilerOptions: {
                          outDir: '../../dist/out-tsc',
                          rootDir,
                          types: ['vitest/globals', '@angular/localize'],
                      },
                      include: ['src/**/*.spec.ts', 'src/**/*.d.ts'],
                  }
                : {
                      extends: './tsconfig.json',
                      compilerOptions: {
                          outDir: '../../dist/out-tsc',
                          rootDir,
                          types: ['vitest/globals', 'vite/client', 'node'],
                      },
                      include: [
                          'vite.config.mts',
                          'src/**/*.spec.ts',
                          'src/**/*.spec.tsx',
                          'src/**/*.d.ts',
                      ],
                  }
        );
    return files;
}

// ESLint de la bibliothèque : celui de la pile, comme la coque. L'interface
// refuse en plus tout import de l'entrée réservée à la coque (index 2 de la
// v4, jambe (ii) : règle native `no-restricted-imports`).
function libraryEslint({ profile, layer }) {
    const restricted =
        layer === 'interface'
            ? `
    {
        files: ['**/*.{ts,tsx}'],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: [${JSON.stringify(`${socleCoqueAlias('*')}`)}],
                            message: "L'entrée de la coque n'est pas une API de l'interface.",
                        },
                    ],
                },
            ],
        },
    },`
            : '';
    if (profile === 'angular-pwa')
        return `import angular from 'angular-eslint';
import ts from 'typescript-eslint';
import base from '../../eslint.config.mjs';

export default ts.config(
    ...base,
    {
        files: ['**/*.ts'],
        extends: [angular.configs.tsRecommended],
        processor: angular.processInlineTemplates,
        rules: {
            '@angular-eslint/directive-selector': ['error', { type: 'attribute', prefix: 'app', style: 'camelCase' }],
            '@angular-eslint/component-selector': ['error', { type: 'element', prefix: 'app', style: 'kebab-case' }],
        },
    },
    {
        files: ['**/*.html'],
        extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    },${restricted}
);
`;
    return `import reactHooks from 'eslint-plugin-react-hooks';
import baseConfig from '../../eslint.config.mjs';

export default [
    ...baseConfig,
    {
        files: ['**/*.ts', '**/*.tsx'],
        plugins: reactHooks.configs.flat.recommended.plugins,
        rules: reactHooks.configs.flat.recommended.rules,
    },${restricted}
];
`;
}

// API publique du socle (V3.4 point 3, V5.4) : la session publique de l'appli
// (état, déconnexion, menu) et, PAR PAGE de l'expérience, l'espace de noms de
// son module de page.
function socleIndex(pages, session) {
    const lines = [];
    if (session)
        lines.push(
            `export { ApplicationSession } from './session/session.store';`,
            `export { ApplicationSessionMenu } from './session/session-menu';`,
            `export type { SessionMenuItem } from './session/session.types';`
        );
    for (const page of pages)
        lines.push(
            `export * as ${page.id} from './${posix.relative('src', `${SOCLE_PAGES_DIR}/${page.id}/${posix.dirname(PAGE_MODULE)}`)}';`
        );
    return `${lines.join('\n')}\n`;
}

// Entrée réservée à la coque (V3.7.10) : les fournisseurs du socle (la session
// et son intercepteur, seul point de passage des requêtes, jamais exporté ;
// les points d'accès du relais), la garde de route et la configuration de
// session. Sans session, rien à fournir. Les points d'accès du relais ne sont
// fournis que si le module de relais est rendu (`relay-endpoints.ts`).
const RELAY_MODULE = 'relay-endpoints';
function socleCoque(session) {
    if (!session) return 'export {};\n';
    const relay = Object.hasOwn(session, `${RELAY_MODULE}.ts`);
    return `import { provideHttpClient, withInterceptors } from '@angular/common/http';
import type { EnvironmentProviders, Provider } from '@angular/core';

${relay ? `import { RELAY_ENDPOINTS } from './session/${RELAY_MODULE}';\n` : ''}import { applicationSessionInterceptor } from './session/session.interceptor';
import { ApplicationSession } from './session/session.store';
import { APPLICATION_SESSION } from './session/session.types';

export { applicationSessionGuard } from './session/session.guard';
export { SESSION_CONFIGURATION } from './session/session.store';

export function provideSocle(): (Provider | EnvironmentProviders)[] {
    return [
        provideHttpClient(withInterceptors([applicationSessionInterceptor])),
        { provide: APPLICATION_SESSION, useExisting: ApplicationSession },${relay ? '\n        RELAY_ENDPOINTS,' : ''}
    ];
}
`;
}

// Carte des pages de l'interface (V5.1 règle 6) : un chargeur paresseux par
// page, vers son amorce (ou la page que l'IA a écrite au même module).
export function interfaceIndex(profile, pages) {
    const loaders = pages.map((page) =>
        profile === 'angular-pwa'
            ? `    ${page.id}: () => import('./pages/${page.id}/page.component').then((m) => m.PageComponent),`
            : `    ${page.id}: () => import('./pages/${page.id}/page').then((m) => m.Page),`
    );
    return `export const pages = {\n${loaders.join('\n')}\n};\n`;
}

// Chemins relatifs à la racine de chaque bibliothèque → chemins du produit.
const under = (root, files) =>
    Object.fromEntries(
        Object.entries(files).map(([path, content]) => [
            `${root}/${path}`,
            content,
        ])
    );

// Disposition d'une appli extérieure. `coque` : fichiers de la coque, relatifs
// à `apps/<app>` ; `session` : fichiers de session, relatifs au dossier de
// session du socle ; `seeds` : amorces de page de l'interface, relatives à son
// dossier de pages. Rend `{ owned, seeds }`, chemins relatifs au produit :
// `owned` entre dans l'inventaire de l'appli, `seeds` jamais.
export function layoutExternalProduct({
    profile,
    appName,
    pages,
    coque,
    session,
    seeds,
}) {
    const socle = socleRoot(appName);
    const ui = interfaceRoot(appName);
    const socleSources = {
        [SOCLE_ENTRY]: socleIndex(pages, Boolean(session)),
        [SOCLE_COQUE_ENTRY]: socleCoque(session),
    };
    for (const [path, content] of Object.entries(session ?? {}))
        socleSources[`${SOCLE_SESSION_DIR}/${path}`] = content;
    for (const page of pages)
        socleSources[`${SOCLE_PAGES_DIR}/${page.id}/${PAGE_MODULE}`] =
            EMPTY_PAGE_MODULE;
    const socleSpecs = hasSpecs(Object.keys(socleSources));
    const socleFiles = {
        'project.json': libraryProject({
            profile,
            appName,
            layer: 'socle',
            root: socle,
            specs: socleSpecs,
        }),
        ...libraryTsconfigs({ profile, specs: socleSpecs, root: socle }),
        'eslint.config.mjs': libraryEslint({ profile, layer: 'socle' }),
        ...socleSources,
    };
    if (profile === 'react-spa' && socleSpecs)
        socleFiles['vite.config.mts'] = libraryViteConfig(
            socle,
            socleLibraryName(appName)
        );
    const interfaceSeeds = under(`${ui}/${INTERFACE_PAGES_DIR}`, seeds);
    // L'interface n'a aucune spec à sa création : pas de cible `test` (L-5) ;
    // le lot 7 la crée avec la première spec.
    const interfaceFiles = {
        'project.json': libraryProject({
            profile,
            appName,
            layer: 'interface',
            root: ui,
            specs: false,
        }),
        ...libraryTsconfigs({ profile, specs: false, root: ui }),
        'eslint.config.mjs': libraryEslint({ profile, layer: 'interface' }),
        [INTERFACE_ENTRY]: interfaceIndex(profile, pages),
    };
    return {
        owned: {
            ...under(coqueRoot(appName), coque),
            ...under(socle, socleFiles),
            ...under(ui, interfaceFiles),
        },
        seeds: interfaceSeeds,
    };
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex');

const SESSION_SOURCES = 'src/app/session/';
const PAGE_SOURCE = /^src\/app\/pages\/(page_[a-f0-9]{16})\/(.+)$/;

// Coque extérieure rendue à une racine (même rendu que le mode interne, plus
// les adaptations extérieures) → trois racines. La session va au socle, les
// amorces de page à l'interface (hors inventaire) ; la coque garde le reste,
// porte les tags de l'appli, des chemins re-basés vers les bibliothèques
// (§V4.4) et l'accroche de leur vérification de types (index 7 de la v4), et
// n'a de cible `test` que si elle garde une spec (L-5 : une coque à session
// n'en a plus). Chemins du résultat relatifs au produit.
export async function externalShellProduct({
    profile,
    files,
    appName,
    pages,
    experience,
    designPath,
    designSha256,
}) {
    const coque = {};
    const session = {};
    const seeds = {};
    for (const [path, content] of Object.entries(files)) {
        const page = PAGE_SOURCE.exec(path);
        if (path.startsWith(SESSION_SOURCES))
            session[path.slice(SESSION_SOURCES.length)] = content;
        else if (page) seeds[`${page[1]}/${page[2]}`] = content;
        else coque[path] = content;
    }
    const project = JSON.parse(coque['project.json']);
    project.tags = coqueTags(appName, experience.id);
    project.targets.build.dependsOn = [
        ...new Set([...(project.targets.build.dependsOn ?? []), '^typecheck']),
    ];
    const tsconfig = JSON.parse(coque['tsconfig.json']);
    tsconfig.compilerOptions.paths = coquePaths(appName);
    if (!hasSpecs(Object.keys(coque))) {
        delete project.targets.test;
        delete coque['tsconfig.spec.json'];
        tsconfig.references = tsconfig.references.filter(
            (reference) => reference.path !== './tsconfig.spec.json'
        );
    }
    for (const name of ['tsconfig.app.json', 'tsconfig.spec.json'])
        if (coque[name]) {
            const config = JSON.parse(coque[name]);
            config.compilerOptions.rootDir = productRootDir(coqueRoot(appName));
            coque[name] = json(config);
        }
    coque['project.json'] = json(project);
    coque['tsconfig.json'] = json(tsconfig);
    const { owned, seeds: interfaceSeeds } = layoutExternalProduct({
        profile,
        appName,
        pages,
        coque,
        session: experience.session ? session : undefined,
        seeds,
    });
    const canonical = await canonicalizeGeneratedFiles({
        ...owned,
        ...interfaceSeeds,
    });
    const product = Object.fromEntries(
        Object.keys(owned).map((path) => [path, canonical[path]])
    );
    const seedFiles = Object.fromEntries(
        Object.keys(interfaceSeeds).map((path) => [path, canonical[path]])
    );
    // Inventaire de l'appli : chemins RELATIFS AU PRODUIT (V3.1 point 4), sur
    // les trois racines ; les amorces n'y entrent jamais.
    const artifacts = Object.entries(product)
        .map(([path, content]) => ({
            path,
            bytes: Buffer.byteLength(content),
            sha256: sha256(content),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
        schema_version: '1.0.0',
        kind: 'application-shell-manifest',
        app_name: appName,
        profile,
        design_ref: { path: designPath, sha256: designSha256 },
        experience_id: experience.id,
        generated_files: artifacts,
        tree_sha256: sha256(
            artifacts
                .map((entry) => `${entry.path}\0${entry.sha256}`)
                .join('\0')
        ),
    };
    const manifestPath = appManifestPath(appName);
    product[manifestPath] = (
        await canonicalizeGeneratedFiles({ [manifestPath]: json(manifest) })
    )[manifestPath];
    return { files: product, seeds: seedFiles, manifest, experience, pages };
}

// Manifeste d'une appli extérieure, relatif au produit.
export const appManifestPath = (appName) =>
    `${coqueRoot(appName)}/${SIGNATURE_FILES.appManifest}`;

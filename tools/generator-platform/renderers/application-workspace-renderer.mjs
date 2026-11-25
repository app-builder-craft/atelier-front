import { SIGNATURE_FILES } from '../core/atelier-signature.mjs';
import { canonicalizeGeneratedFiles } from '../core/canonicalize-generated.mjs';
import { stableStringify } from '../core/generation-manifest.mjs';
import { productForms } from '../core/product-identity.mjs';
import {
    ALIAS_SCOPES,
    APPS_ROOT,
    INTERFACE_FREE_DIR,
    interfaceLibraryName,
    LIBS_ROOT,
    LAYER_CONSTRAINTS,
    ROOT_PATH_ALIASES,
    socleCoqueAlias,
    socleLibraryName,
} from '../core/socle-names.mjs';
import {
    EXTERNAL_CSP_HEADER_PATH,
    renderCspHeaderTemplate,
    withCspMeta,
} from './external-content-security-policy.mjs';
import { socleCheck } from './product-socle-check.mjs';

// Lot 2, correction de l'étape A (revue Fable, B-3) : sélecteurs de
// \`no-restricted-syntax\` de l'interface (formes de Vite hors de la règle de
// frontières de Nx), en données exportées par l'ESLint racine du produit.
export const INTERFACE_RESTRICTED_SYNTAX = Object.freeze([
    Object.freeze({
        selector:
            "MemberExpression[object.type='MetaProperty'][property.name=/^glob/]",
        message:
            "`import.meta.glob` n'est pas une API de l'interface : importer l'API publique du socle.",
    }),
    // Tout `import.meta` DANS l'appel d'un worker (réserve R3 de la
    // validation de l'étape A, mesurée : Vite empaquette aussi le fichier visé
    // par `new URL(…, import.meta.url).href` et `.toString()`).
    Object.freeze({
        selector:
            'NewExpression[callee.name=/^(?:Shared)?Worker$/] MetaProperty',
        message:
            "Un worker construit sur un chemin n'est pas une API de l'interface : importer l'API publique du socle.",
    }),
]);

// Disposition unique du produit extérieur, consommée aussi par ses preuves et gardes.
export const EXTERNAL_WORKSPACE_SIGNATURE = Object.freeze({
    manifest: SIGNATURE_FILES.workspaceManifest,
    support: SIGNATURE_FILES.support,
    proof: SIGNATURE_FILES.proof,
});

export const SHELL_PACKAGES = Object.freeze({
    common: {
        dependencies: ['tslib'],
        devDependencies: [
            'nx',
            'typescript',
            'eslint',
            '@eslint/js',
            'typescript-eslint',
            '@nx/eslint',
            // Lot 2, commit 2 : `@nx/enforce-module-boundaries`, importé par
            // l'ESLint racine du produit (v1 §12.3).
            '@nx/eslint-plugin',
            '@nx/web',
            'prettier',
            '@playwright/test',
            'vitest',
            'jsdom',
            'sass',
            '@types/node',
        ],
    },
    'angular-pwa': {
        dependencies: [
            '@angular/common',
            '@angular/compiler',
            '@angular/core',
            '@angular/localize',
            '@angular/platform-browser',
            '@angular/router',
            'rxjs',
        ],
        devDependencies: [
            '@angular/build',
            '@angular/compiler-cli',
            'angular-eslint',
            '@angular-devkit/core',
            '@angular-devkit/architect',
        ],
    },
    'react-spa': {
        dependencies: ['react', 'react-dom', 'react-router'],
        devDependencies: [
            '@nx/js',
            '@nx/react',
            '@nx/vite',
            '@nx/vitest',
            '@vitejs/plugin-react',
            '@types/react',
            '@types/react-dom',
            'vite',
            'eslint-plugin-react-hooks',
        ],
    },
});

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function workspacePluginConsumers(plugins, declared) {
    const consumers = new Set();
    for (const entry of plugins ?? []) {
        const plugin = typeof entry === 'string' ? entry : entry?.plugin;
        if (
            typeof plugin !== 'string' ||
            !/^[a-zA-Z0-9@_./-]+$/.test(plugin) ||
            plugin.split('/').some((part) => ['', '.', '..'].includes(part))
        )
            throw new Error('Plugin natif invalide');
        const name = plugin.startsWith('@')
            ? plugin.split('/').slice(0, 2).join('/')
            : plugin.split('/')[0];
        if (!Object.hasOwn(declared, name))
            throw new Error('Plugin non déclaré');
        consumers.add(name);
    }
    return consumers;
}

function productCheck() {
    return `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const packageName = (name) => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
const ignored = new Set(['.git', 'node_modules', '.nx', '.angular', 'dist', 'coverage', 'tmp']);
// Lot 2 : disposition des trois racines d'une appli et alias admis, tirés de
// la source unique de l'atelier (socle-names.mjs) au rendu.
const PATHS = ${JSON.stringify(ROOT_PATH_ALIASES)};
const ALIAS_SCOPES = ${JSON.stringify(ALIAS_SCOPES)};
const APPS = ${JSON.stringify(APPS_ROOT)};
const LIBS = ${JSON.stringify(LIBS_ROOT)};
const SUFFIXES = ${JSON.stringify([socleLibraryName(''), interfaceLibraryName('')])};
const INTERFACE_FREE = ${JSON.stringify(INTERFACE_FREE_DIR + '/')};
const APP_MANIFEST = ${JSON.stringify(SIGNATURE_FILES.appManifest)};

// Écart nommé : la sortie le cite (chemin relatif au produit, rien de local).
export class WorkspaceDrift extends Error {}
const drift = (message) => { throw new WorkspaceDrift(message); };

${workspacePluginConsumers.toString()}

${stableStringify.toString()}

// Appli d'un chemin relatif au produit : sa coque, ou l'une de ses deux
// bibliothèques.
function appOf(path) {
    const [space, entry] = path.split('/');
    if (space === APPS) return entry ?? null;
    if (space === LIBS && entry) for (const suffix of SUFFIXES) if (entry.endsWith(suffix)) return entry.slice(0, -suffix.length);
    return null;
}

async function treeFiles(directory, prefix, found) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + entry.name;
        if (entry.isSymbolicLink()) drift('Lien dans une racine de l’appli : ' + path);
        if (entry.isDirectory()) await treeFiles(resolve(directory, entry.name), path + '/', found);
        else if (entry.isFile()) found.push(path);
        else drift('Entrée spéciale dans une racine de l’appli : ' + path);
    }
    return found;
}

// Lot 2 (v1 §4.2, V3.1 point 4) : coque et socle EXACTS ; interface exacte
// hors de ses sources, libres. Tout fichier possédé est vérifié par empreinte.
async function exactApplication(app) {
    const owned = new Map(app.generated_files.map((file) => [file.path, file]));
    for (const file of app.generated_files) {
        let bytes;
        try { bytes = await readFile(resolve(root, file.path)); }
        catch { drift('Fichier possédé absent : ' + file.path); }
        if (hash(bytes) !== file.sha256) drift('Fichier possédé modifié hors du générateur : ' + file.path);
    }
    const { seal_sha256: seal, ...ownership } = app.ownership ?? {};
    if (!seal || hash(stableStringify({ ...app, ownership })) !== seal) drift('Sceau de l’appli invalide : ' + app.app_name);
    const roots = [APPS + '/' + app.app_name, ...SUFFIXES.map((suffix) => LIBS + '/' + app.app_name + suffix)];
    for (const [index, prefix] of roots.entries()) {
        for (const path of await treeFiles(resolve(root, prefix), prefix + '/', [])) {
            if (owned.has(path) || path === roots[0] + '/' + APP_MANIFEST) continue;
            if (index === 2 && path.startsWith(prefix + '/' + INTERFACE_FREE)) continue;
            drift('Fichier ajouté hors du générateur : ' + path);
        }
    }
    return roots;
}

async function sources(directory, found) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        assert.equal(entry.isSymbolicLink(), false, 'Lien dans les sources');
        if (entry.isDirectory()) {
            if (!ignored.has(entry.name)) await sources(path, found);
        } else if (entry.isFile() && /\\.(?:[cm]?[jt]s|jsx|tsx|html|css|scss)$/.test(entry.name)) {
            const content = await readFile(path, 'utf8');
            const lines = content.split('\\n').length - (content.endsWith('\\n') ? 1 : 0);
            assert.ok(lines <= 800 && Buffer.byteLength(content) <= 1048576, 'Poids source');
            found.push([path, content]);
        }
    }
}

export async function checkWorkspace() {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(resolve(root, '${EXTERNAL_WORKSPACE_SIGNATURE.manifest}'), 'utf8'));
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.equal(manifest.kind, 'application-workspace-manifest');
    assert.deepEqual(Object.keys(declared).sort(), Object.keys(manifest.packages).sort(), 'Fermeture des packages');
    for (const file of manifest.files) {
        assert.equal(hash(await readFile(resolve(root, file.path))), file.sha256, 'Configuration modifiée');
    }
    for (const [name, version] of Object.entries(declared)) {
        assert.match(version, /^\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9.-]+)?$/);
        assert.equal(version, manifest.packages[name].version);
        const path = resolve(root, 'node_modules', name, 'package.json');
        const physical = await realpath(path);
        assert.ok(physical.startsWith(resolve(root, 'node_modules') + '/'), 'Dépendance hors produit');
        assert.equal(JSON.parse(await readFile(path, 'utf8')).version, version, 'Version installée');
    }
    const base = JSON.parse(await readFile(resolve(root, 'tsconfig.base.json'), 'utf8'));
    assert.equal(base.compilerOptions.strict, true);
    assert.deepEqual(base.compilerOptions.paths, PATHS, 'Alias du produit');
    assert.equal(base.extends, undefined);
    const found = [];
    await sources(root, found);
    const nx = JSON.parse(await readFile(resolve(root, 'nx.json'), 'utf8'));
    const consumers = workspacePluginConsumers(nx.plugins, declared);
    for (const [path, content] of found) {
        if (!/\\.(?:[cm]?[jt]s|jsx|tsx)$/.test(path)) continue;
        const ast = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
        function inspect(node) {
            let name;
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) name = node.moduleSpecifier.text;
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) name = node.arguments[0].text;
            if (name) {
                if (name.startsWith('.')) {
                    assert.ok(resolve(dirname(path), name).startsWith(root + '/'), 'Import relatif hors produit');
                } else if (ALIAS_SCOPES.some((scope) => name.startsWith(scope))) {
                    // Alias du socle et de l'interface : résolus par les tsconfig,
                    // jamais un paquet (garde du catalogue de l'atelier).
                } else if (!name.startsWith('node:') && !builtinModules.includes(name)) {
                    assert.ok(!name.startsWith('/') && !name.includes(':'), 'Import extérieur');
                    const consumer = packageName(name);
                    assert.ok(Object.hasOwn(declared, consumer), 'Import non déclaré');
                    consumers.add(consumer);
                    const owner = appOf(path.slice(root.length + 1));
                    if (owner && path.includes('/src/')) {
                        const app = JSON.parse(ts.sys.readFile(resolve(root, APPS, owner, APP_MANIFEST)) ?? '{}');
                        if (app.profile === 'angular-pwa') assert.ok(!/^react(?:$|-|\\/)/.test(name), 'Import React dans Angular');
                        if (app.profile === 'react-spa') assert.ok(!name.startsWith('@angular/'), 'Import Angular dans React');
                    }
                }
            }
            ts.forEachChild(node, inspect);
        }
        inspect(ast);
    }
    const profiles = new Set();
    const names = new Set();
    for (const entry of await readdir(resolve(root, 'apps'), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const appRoot = resolve(root, 'apps', entry.name);
        const app = JSON.parse(await readFile(resolve(appRoot, '${SIGNATURE_FILES.appManifest}'), 'utf8'));
        profiles.add(app.profile);
        names.add(entry.name);
        // Lot 2, commit 3 : la fraîcheur des sources liées est vérifiée par
        // appli, dans \`check-socle.mjs\` (\`staleSources\`, liaison \`sources\`).
        for (const projectRoot of await exactApplication(app)) {
            const project = JSON.parse(await readFile(resolve(root, projectRoot, 'project.json'), 'utf8'));
            for (const target of Object.values(project.targets ?? {})) {
                if (!target.executor) continue;
                const name = target.executor.split(':')[0];
                assert.ok(Object.hasOwn(declared, name), 'Executor non déclaré');
                consumers.add(name);
            }
        }
    }
    try {
        for (const entry of await readdir(resolve(root, LIBS), { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const owner = appOf(LIBS + '/' + entry.name);
            if (!entry.isDirectory() || !owner || !names.has(owner)) drift('Entrée de bibliothèque sans appli : ' + LIBS + '/' + entry.name);
        }
    } catch (error) {
        if (error instanceof WorkspaceDrift || error?.code !== 'ENOENT') throw error;
    }
    const native = new Set(['nx', 'typescript', 'eslint', 'prettier', 'jsdom', 'sass', 'vite', 'tslib', '@types/node', '@types/react', '@types/react-dom', '@nx/react', '@angular/compiler', '@angular/compiler-cli', '@angular/localize', '@angular-devkit/core', '@angular-devkit/architect', 'rxjs']);
    // The prepared workspace may contain the qualified build-tool union
    // before its second application exists. Enforce actual consumers once
    // each declared profile has an application; never permit an extra package.
    if (manifest.profiles.every((profile) => profiles.has(profile))) {
        for (const name of Object.keys(declared)) assert.ok(consumers.has(name) || native.has(name), 'Paquet direct sans consommateur');
    }
    assert.ok((await lstat(resolve(root, 'bun.lock'))).isFile(), 'Verrou requis');
    process.stdout.write('Workspace : configurations, imports, versions et poids vérifiés.\\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    checkWorkspace().catch((error) => {
        process.stderr.write(error instanceof WorkspaceDrift ? 'Échec du contrat workspace : ' + error.message + '.\\n' : 'Échec du contrat workspace.\\n');
        process.exitCode = 1;
    });
}
`;
}

function browserSmoke() {
    return `import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const [buildPath, browserPath, fixturePath] = process.argv.slice(2);
assert.ok(buildPath && browserPath && fixturePath, 'Arguments de preuve requis');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const root = resolve(buildPath);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (request, response) => {
    try {
        const path = resolve(root, '.' + new URL(request.url ?? '/', 'http://localhost').pathname);
        assert.ok(path === root || path.startsWith(root + '/'));
        let bytes;
        let extension = extname(path);
        try { bytes = await readFile(path); }
        catch { bytes = await readFile(resolve(root, 'index.html')); extension = '.html'; }
        response.writeHead(200, { 'content-type': types[extension] ?? 'application/octet-stream' });
        response.end(bytes);
    } catch { response.writeHead(400); response.end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = 'http://127.0.0.1:' + address.port;
let browser;
try {
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    // This oracle covers routing/guards, not offline behaviour. Simulate a
    // browser without service-worker support so it cannot mask a fresh build.
    await context.addInitScript(() => {
        Reflect.deleteProperty(globalThis.Navigator.prototype, 'serviceWorker');
    });
    const external = [];
    await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== origin) {
            external.push(true);
            return route.abort();
        }
        return route.continue();
    });
    const page = await context.newPage();
    await page.goto(origin + fixture.publicPath);
    await page.getByRole('heading', { name: fixture.publicTitle, exact: true }).waitFor();
    assert.equal(await page.title(), fixture.title);
    await page.goto(origin + fixture.protectedPath);
    // Here the fixture has no API or polling. Wait for lazy route chunks
    // and rendering before the negative assertion; a guard-removal mutant
    // must not pass merely because its component is still downloading.
    await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('heading', { name: fixture.protectedTitle, exact: true }).count(), 0, 'La garde doit refuser');
    await page.goto(origin + fixture.publicPath);
    await page.getByRole('heading', { name: fixture.publicTitle, exact: true }).waitFor();
    assert.deepEqual(external, [], 'Requête extérieure interdite');
    process.stdout.write('Navigateur : titre, route publique et garde vérifiés.\\n');
} finally {
    if (browser) await browser.close();
    await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
}
`;
}

export async function renderApplicationWorkspace(options) {
    const {
        profiles,
        packages,
        packageManager,
        engines,
        githubRepository,
        reviewOwner,
    } = options;
    const group = (key) =>
        Object.fromEntries(
            Object.entries(packages)
                .filter(([, value]) => value.group === key)
                .map(([name, value]) => [name, value.version])
                .sort(([a], [b]) => a.localeCompare(b))
        );
    const files = {
        'package.json': json({
            name: `@${githubRepository.toLowerCase()}`,
            version: '0.0.0',
            private: true,
            packageManager,
            engines,
            overrides: options.packageOverrides,
            workspaces: ['apps/*'],
            scripts: {
                'check:workspace': `node ${EXTERNAL_WORKSPACE_SIGNATURE.support}/check-workspace.mjs`,
                build: 'node node_modules/nx/dist/bin/nx.js run-many -t build --configuration=production --skipNxCache',
                lint: 'node node_modules/nx/dist/bin/nx.js run-many -t lint --skipNxCache',
                test: 'node node_modules/nx/dist/bin/nx.js run-many -t test --skipNxCache',
                'format:check':
                    'node node_modules/prettier/bin/prettier.cjs --check .',
            },
            dependencies: group('dependencies'),
            devDependencies: group('devDependencies'),
        }),
        'nx.json': json({
            $schema: './node_modules/nx/schemas/nx-schema.json',
            analytics: false,
            defaultBase: 'main',
            workspaceLayout: { appsDir: 'apps', libsDir: 'libs' },
            namedInputs: {
                default: [
                    '{projectRoot}/**/*',
                    '{workspaceRoot}/tsconfig.base.json',
                    '{workspaceRoot}/eslint.config.mjs',
                ],
            },
            targetDefaults: {
                build: { cache: false },
                test: { cache: false },
                lint: { cache: false, options: { 'max-warnings': 0 } },
                typecheck: { cache: false },
            },
            plugins: [
                {
                    plugin: '@nx/eslint/plugin',
                    options: { targetName: 'lint' },
                },
                ...(profiles.includes('react-spa')
                    ? [
                          {
                              plugin: '@nx/js/typescript',
                              options: {
                                  typecheck: { targetName: 'typecheck' },
                              },
                          },
                          { plugin: '@nx/vite/plugin' },
                          {
                              plugin: '@nx/vitest',
                              options: {
                                  testTargetName: 'test',
                                  testMode: 'run',
                              },
                          },
                      ]
                    : []),
            ],
        }),
        'tsconfig.base.json': json({
            compilerOptions: {
                target: 'ES2022',
                module: 'ESNext',
                moduleResolution: 'bundler',
                lib: ['ES2022', 'DOM', 'DOM.Iterable'],
                strict: true,
                noImplicitOverride: true,
                noFallthroughCasesInSwitch: true,
                noPropertyAccessFromIndexSignature: true,
                forceConsistentCasingInFileNames: true,
                skipLibCheck: true,
                isolatedModules: true,
                experimentalDecorators: true,
                importHelpers: true,
                resolveJsonModule: true,
                esModuleInterop: true,
                allowSyntheticDefaultImports: true,
                // Lot 2 (V3.4 point 1) : deux motifs FIXES, sans préfixe ni nom
                // d'appli ; aucune commande n'a plus à toucher ce fichier.
                paths: ROOT_PATH_ALIASES,
            },
        }),
        'eslint.config.mjs': `import js from '@eslint/js';
import nx from '@nx/eslint-plugin';
import ts from 'typescript-eslint';

// Frontières natives (lot 2, commit 2) : contraintes de COUCHE, fixes, en
// DONNÉES ; chaque projet redéclare la règle en entier avec la contrainte de
// son appli. Entrée \`no-restricted-imports\` de l'interface, en DONNÉES.
export const LAYER_CONSTRAINTS = ${JSON.stringify(LAYER_CONSTRAINTS)};
export const SOCLE_COQUE_RESTRICTION = { patterns: [{ group: [${JSON.stringify(socleCoqueAlias('*'))}], message: "L'entrée de la coque n'est pas une API de l'interface." }] };
// Revue Fable de l'étape A, B-3 : des formes de Vite que la règle de Nx ne
// voit pas (chemin passé à \`import.meta.glob\`, \`new Worker(new URL(…))\`,
// types de Vite tirés par une directive) atteindraient le socle depuis
// l'interface ; deux règles STANDARD les ferment, en DONNÉES.
export const INTERFACE_RESTRICTED_SYNTAX = ${JSON.stringify(INTERFACE_RESTRICTED_SYNTAX)};

export default [
    { ignores: ['node_modules/**', 'dist/**', 'coverage/**', '.nx/**', '.angular/**', 'tmp/**', 'apps/.*-candidate-*/**', 'apps/.*-previous-*/**', 'libs/.*-candidate-*/**', 'libs/.*-previous-*/**'] },
    { ...js.configs.recommended, files: ['**/*.mjs', '**/*.js'], languageOptions: { globals: { process: 'readonly', Buffer: 'readonly', URL: 'readonly', self: 'readonly', caches: 'readonly', fetch: 'readonly' } } },
    ...ts.configs.recommended,
    { files: ['**/*.{js,mjs,ts,tsx,mts}'], rules: { 'no-console': 'error', 'no-debugger': 'error', '@typescript-eslint/no-explicit-any': 'error' } },
    { files: ['**/*.{ts,tsx,mts}'], plugins: { '@nx': nx }, rules: { '@nx/enforce-module-boundaries': ['error', { allow: [], depConstraints: LAYER_CONSTRAINTS }] } },
];
`,
        '.prettierrc.json': json({
            printWidth: 80,
            tabWidth: 4,
            singleQuote: true,
            trailingComma: 'es5',
        }),
        '.prettierignore':
            'node_modules/\ndist/\ncoverage/\n.nx/\n.angular/\nbun.lock\ntmp/\n',
        '.gitignore':
            'node_modules/\ndist/\ncoverage/\n.nx/\n.angular/\ntmp/\n.env\n.env.*\n*.har\napps/.*-candidate-*/\napps/.*-previous-*/\napps/.*.generation-lock*/\nlibs/.*-candidate-*/\nlibs/.*-previous-*/\nlibs/.*.generation-lock*/\n',
        'README.md': `# Workspace applicatif\n\nProfils natifs : ${profiles.join(', ')}.\n\nDépôt : ${githubRepository}. Relecture : @${reviewOwner}.\n\nInstaller les dépendances avec bun install --frozen-lockfile --ignore-scripts depuis cette racine ; le verrou candidat attend sa qualification native.\nLes entrées approuvées vivent ici. Aucun lien vers les outils de création.\nLes contrôles production T19–T28 attendent leur qualification avant publication.\n`,
        'AGENTS.md':
            '# Règles du produit\n\nEntrées et contrats approuvés uniquement. Angular et React restent natifs et séparés.\nAucun secret, HAR, environnement réel, appel serveur implicite ni publication sans accord.\nCompiler, linter sans avertissement et tester chaque cible après modification.\n',
        [`${EXTERNAL_WORKSPACE_SIGNATURE.support}/check-workspace.mjs`]:
            productCheck(),
        [`${EXTERNAL_WORKSPACE_SIGNATURE.support}/check-socle.mjs`]:
            socleCheck(),
        [`${EXTERNAL_WORKSPACE_SIGNATURE.support}/browser-smoke.mjs`]:
            browserSmoke(),
    };
    if (profiles.includes('angular-pwa')) {
        files[
            `${EXTERNAL_WORKSPACE_SIGNATURE.support}/angular-unit-test.config.mjs`
        ] = "export default { server: { host: '127.0.0.1' } };\n";
    }
    return canonicalizeGeneratedFiles(files);
}

// Coque extérieure : le service worker s'enregistre sous Trusted Types par la
// politique `<préfixe>-sw`, créée avant tout autre code et locale au module.
const WORKSHOP_MAIN = `import { bootstrapApplication } from '@angular/platform-browser';

import { App } from './app/app';
import { appConfig } from './app/app.config';

bootstrapApplication(App, appConfig)
    .then(() => {
        if ('serviceWorker' in navigator) {
            void navigator.serviceWorker.register('/sw.js');
        }
    })
    .catch((error: unknown) => console.error(error));
`;

function externalMain(workshop, prefix) {
    // Politique Trusted Types du service worker, au préfixe du produit.
    const forms = productForms(prefix);
    if (workshop !== WORKSHOP_MAIN)
        throw new Error('application shell: main.ts is not the shell main');
    return `import { bootstrapApplication } from '@angular/platform-browser';

import { App } from './app/app';
import { appConfig } from './app/app.config';

// Politique Trusted Types du service worker (politique de la coque) :
// \`register\` est un puits TrustedScriptURL. \`${forms.kebab}sw\` est créée avant tout
// autre code, n'accepte que l'URL exacte du service worker et reste locale à ce
// module. Si Trusted Types existe et que la création échoue, l'erreur remonte :
// aucun repli. Sans Trusted Types dans le navigateur, il n'y a pas de puits :
// la chaîne littérale est enregistrée, et worker-src 'self' borne l'URL.
interface ServiceWorkerUrlPolicy {
    createScriptURL(input: string): unknown;
}
interface TrustedTypesFactory {
    createPolicy(
        name: string,
        rules: { createScriptURL(input: string): string }
    ): ServiceWorkerUrlPolicy;
}
const SERVICE_WORKER_URL = '/sw.js';
const serviceWorkerPolicy = (
    globalThis as { trustedTypes?: TrustedTypesFactory }
).trustedTypes?.createPolicy('${forms.kebab}sw', {
    createScriptURL: (input) => {
        if (input !== SERVICE_WORKER_URL)
            throw new TypeError('${forms.kebab}sw: service worker URL refused');
        return input;
    },
});
const serviceWorkerScript = serviceWorkerPolicy
    ? serviceWorkerPolicy.createScriptURL(SERVICE_WORKER_URL)
    : SERVICE_WORKER_URL;

bootstrapApplication(App, appConfig)
    .then(() => {
        if ('serviceWorker' in navigator) {
            // Le navigateur accepte un TrustedScriptURL ; le type DOM de
            // TypeScript ne connaît que string | URL.
            void navigator.serviceWorker.register(serviceWorkerScript as string);
        }
    })
    .catch(() => {
        const message = document.createElement('p');
        message.setAttribute('role', 'alert');
        message.textContent = 'L’application n’a pas pu démarrer.';
        document.body.replaceChildren(message);
    });
`;
}

// Coque extérieure : le relais de même origine sert /api/ ; le service worker
// ne met jamais une réponse /api/ en cache, quelle que soit sa destination
// (image, document...). La variante avec session remplace ce fichier par le
// sien, limité au document, au manifeste et à l'icône.
const WORKER_ORIGIN_GUARD =
    '    if (requestUrl.origin !== self.location.origin) return;\n';

function externalWorker(worker) {
    if (worker?.split(WORKER_ORIGIN_GUARD).length !== 2)
        throw new Error('application shell: sw.js is not the shell worker');
    return worker.replace(
        WORKER_ORIGIN_GUARD,
        `${WORKER_ORIGIN_GUARD}    if (/^\\/api(?:\\/|$)/.test(requestUrl.pathname)) return;\n`
    );
}

export function adaptExternalShellFiles(files, { profile, appName, prefix }) {
    const root = `apps/${appName}`;
    const project = JSON.parse(files['project.json']);
    const angular = profile === 'angular-pwa';
    project.targets ??= {};
    project.targets.lint = {
        options: {
            config: 'eslint.config.mjs',
            'max-warnings': 0,
        },
    };
    if (angular) {
        project.targets.test.options.runnerConfig = `${EXTERNAL_WORKSPACE_SIGNATURE.support}/angular-unit-test.config.mjs`;
        for (const [path, content] of Object.entries(files)) {
            if (!path.endsWith('.ts') || !content.includes('@Component({'))
                continue;
            files[path] = content
                .replace(
                    "import { Component } from '@angular/core';",
                    "import { ChangeDetectionStrategy, Component } from '@angular/core';"
                )
                .replace(
                    '@Component({',
                    '@Component({\n    changeDetection: ChangeDetectionStrategy.OnPush,'
                );
        }
        // L'ESLint de la coque extérieure (pile et frontières) est rendu par la
        // disposition des trois racines (`projectEslint`, lot 2, commit 2).
        // X4-sécurité : politique de sécurité de contenu générée, scellée.
        files['src/index.html'] = withCspMeta(files['src/index.html'], prefix);
        files[EXTERNAL_CSP_HEADER_PATH] = renderCspHeaderTemplate(prefix);
        // L'inlining du CSS critique ajoute un gestionnaire `onload` en ligne,
        // refusé par `script-src 'self'` ; l'inlining des polices joindrait le
        // réseau au build. Les deux sont coupés explicitement.
        project.targets.build.configurations.production.optimization = {
            scripts: true,
            styles: { minify: true, inlineCritical: false },
            fonts: false,
        };
        files['src/main.ts'] = externalMain(files['src/main.ts'], prefix);
        files['public/sw.js'] = externalWorker(files['public/sw.js']);
    } else {
        project.targets.build = {
            // Keep the native Vite command even if its inference input is
            // missing. An options-only target would become nx:noop.
            command: 'vite build',
            defaultConfiguration: 'production',
            dependsOn: ['^build', 'typecheck'],
            options: { cwd: root, config: 'vite.config.mts' },
            configurations: { production: { mode: 'production' } },
        };
        project.targets.test = {
            options: { config: 'vite.config.mts', watch: false },
        };
        project.targets['serve-static'] = {
            executor: '@nx/web:file-server',
            continuous: true,
            options: {
                buildTarget: `${appName}:build:production`,
                staticFilePath: `dist/${root}`,
                spa: true,
            },
            readyWhen: { signal: true },
            dependsOn: ['build'],
        };
        files['vite.config.mts'] = files['vite.config.mts'].replace(
            "import { defineConfig } from 'vite';",
            "import { defineConfig } from 'vitest/config';"
        );
    }
    files['project.json'] = json(project);
    for (const name of ['tsconfig.app.json', 'tsconfig.spec.json']) {
        const config = JSON.parse(files[name]);
        config.compilerOptions.outDir = `../../dist/out-tsc/${appName}/${name.includes('spec') ? 'spec' : 'app'}`;
        files[name] = json(config);
    }
}

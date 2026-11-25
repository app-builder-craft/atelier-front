// Lot 2, commit 2 (conception v4 § V4.3 et index 8 ; v5 :154 ; revue du 1b,
// A-2) : frontières NATIVES du produit, éprouvées par les outils installés
// (Nx et ESLint du produit, `nx run <projet>:lint`, sortie JSON d'ESLint) sur
// des produits fictifs à deux applis `app` et `other` :
// - le code rendu des trois projets passe la règle (code PUBLIÉ du socle
//   compris) ;
// - les quatre formes qu'ouvrait le 1b, depuis l'interface, sont REFUSÉES :
//   import relatif vers l'entrée de la coque, vers l'interne du socle, vers la
//   coque, et `@socle/<autre>` ; avec `@socle-coque/<app>` (jambe ii) ;
// - le socle ne dépend pas de l'interface ; la coque n'importe ni le socle
//   d'une autre appli, ni son socle par un chemin relatif ;
// - `check-socle` (L-1) : le `lint` de la coque et celui de l'interface
//   dépendent de la cible de LEUR socle (graphe des tâches) ;
// - R-S (b) : sous Vite, le build React de la coque ne résout pas
//   `@socle-coque/<app>` depuis une page de l'interface ;
// - `create-app` d'une troisième appli laisse l'ESLint racine identique à
//   l'octet ; chaque appli a sa contrainte dans ses trois projets.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';

import {
    planExternalApplicationShell,
    publishExternalApplicationShell,
} from './core/application-workspace.mjs';
import { applicationProjectRoots } from './core/application-native-controls.mjs';
import { shellFixture } from './test-support/external-application-fixture.mjs';
import {
    nativeEnv,
    nativeProduct,
    nxTarget,
    run,
} from './test-support/native-product.mjs';

const BOUNDARIES = '@nx/enforce-module-boundaries';
const RELATIVE = [BOUNDARIES, 'noRelativeOrAbsoluteImportsAcrossLibraries'];
const ONLY_TAGS = [BOUNDARIES, 'onlyTagsConstraintViolation'];

// `lint` d'un projet, sortie JSON d'ESLint : { chemin relatif → [[règle,
// identifiant de message, texte]] }, fichiers sans message omis.
async function lintMessages(root, project) {
    const { code, output } = await nxTarget(root, project, 'lint', [
        '--format=json',
    ]);
    const line = output.split('\n').find((entry) => entry.startsWith('[{'));
    assert.ok(line, `${project} : sortie JSON d'ESLint absente\n${output}`);
    const found = {};
    for (const result of JSON.parse(line))
        if (result.messages.length)
            found[relative(root, result.filePath)] = result.messages.map(
                ({ ruleId, messageId, message }) => [ruleId, messageId, message]
            );
    return { code, found };
}

// Sondes écrites, `lint` du projet, sondes retirées ; chaque sonde porte
// EXACTEMENT les refus attendus (règle et identifiant de message) et le
// texte du message natif est cité ; rien d'autre n'est refusé. `cite`
// inscrit au journal du test chaque sonde (chemin, import écrit).
async function refused(root, project, probes, cite = () => undefined) {
    for (const [path, { source }] of Object.entries(probes))
        await writeFile(join(root, path), source);
    if (Object.keys(probes).length)
        cite(
            `${project} sondes ${JSON.stringify(Object.fromEntries(Object.entries(probes).map(([path, { source }]) => [path, source.trim()])))}`
        );
    try {
        const { code, found } = await lintMessages(root, project);
        const expected = Object.fromEntries(
            Object.entries(probes)
                .filter(([, { refusals }]) => refusals.length)
                .map(([path, { refusals }]) => [path, refusals])
        );
        assert.deepEqual(
            Object.fromEntries(
                Object.entries(found).map(([path, messages]) => [
                    path,
                    messages.map(([rule, id]) => [rule, id]),
                ])
            ),
            expected,
            `${project} : refus\n${JSON.stringify(found, null, 2)}`
        );
        assert.equal(code === 0, Object.keys(expected).length === 0, project);
        return found;
    } finally {
        for (const path of Object.keys(probes))
            await rm(join(root, path), { force: true });
    }
}

// Un fichier INTERNE du socle de l'appli (ni son API, ni l'entrée de la
// coque), lu dans le rendu ; même chose pour la coque.
const internal = (files, prefix, excluded) =>
    Object.keys(files)
        .filter(
            (path) =>
                path.startsWith(prefix) &&
                /\.tsx?$/.test(path) &&
                !/\.spec\.tsx?$/.test(path) &&
                !excluded.includes(path)
        )
        .sort()[0];
const specifier = (path) => path.replace(/\.tsx?$/, '');

for (const profile of ['angular-pwa', 'react-spa']) {
    test(
        `${profile} : frontières natives du produit, quatre formes du 1b refusées, sortie d'ESLint citée`,
        { timeout: 420_000 },
        async (t) => {
            const { root, files } = await nativeProduct(t, profile);
            const cite = (line) => t.diagnostic(line);
            // Code rendu : les trois projets de l'appli passent la règle ; le
            // socle PUBLIÉ n'importe que le socle et des paquets.
            for (const project of ['app', 'app-socle', 'app-interface'])
                await refused(root, project, {});
            const ui = 'libs/app-interface/src';
            const socleInternal = internal(files, 'libs/app-socle/src/', [
                'libs/app-socle/src/index.ts',
                'libs/app-socle/src/coque.ts',
            ]);
            const coqueFile = internal(files, 'apps/app/src/', []);
            assert.ok(socleInternal && coqueFile, profile);
            const fromUi = (path) => relative(join(root, ui), join(root, path));
            const cited = await refused(
                root,
                'app-interface',
                {
                    // Formes ouvertes au 1b (revue, carnet 5), toutes refusées.
                    [`${ui}/probe-entree-coque-relative.ts`]: {
                        source: `export * from '${specifier(fromUi('libs/app-socle/src/coque.ts'))}';\n`,
                        refusals: [RELATIVE],
                    },
                    [`${ui}/probe-socle-interne-relatif.ts`]: {
                        source: `export * from '${specifier(fromUi(socleInternal))}';\n`,
                        refusals: [RELATIVE],
                    },
                    [`${ui}/probe-coque-relative.ts`]: {
                        source: `export * from '${specifier(fromUi(coqueFile))}';\n`,
                        refusals: [RELATIVE],
                    },
                    [`${ui}/probe-autre-socle.ts`]: {
                        source: "export * from '@socle/other';\n",
                        refusals: [ONLY_TAGS],
                    },
                    // Jambe (ii), gardée.
                    [`${ui}/probe-entree-coque.ts`]: {
                        source: "export * from '@socle-coque/app';\n",
                        refusals: [
                            [
                                'no-restricted-imports',
                                'patternWithCustomMessage',
                            ],
                        ],
                    },
                    // Revue de l'étape A, B-3 : formes de Vite hors de la
                    // règle de Nx (un chemin passé au globbing ou à un worker,
                    // types de Vite tirés par une directive) ; refusées par
                    // deux règles standard de l'ESLint de l'interface.
                    [`${ui}/probe-vite-glob.ts`]: {
                        source: `/// <reference types="vite/client" />\nexport const coque = import.meta.glob('${fromUi('libs/app-socle/src/coque.ts')}', { eager: true });\n`,
                        refusals: [
                            [
                                '@typescript-eslint/triple-slash-reference',
                                'tripleSlashReference',
                            ],
                            ['no-restricted-syntax', 'restrictedSyntax'],
                        ],
                    },
                    [`${ui}/probe-worker-url.ts`]: {
                        source: `export const worker = new Worker(new URL('${fromUi('libs/app-socle/src/coque.ts')}', import.meta.url), { type: 'module' });\n`,
                        refusals: [
                            ['no-restricted-syntax', 'restrictedSyntax'],
                        ],
                    },
                    // Réserve R3 de la validation de l'étape A : réécritures
                    // que Vite SUIT jusqu'au fichier visé (mesuré par une
                    // construction), refusées par le même sélecteur.
                    [`${ui}/probe-worker-url-href.ts`]: {
                        source: `export const worker = new Worker(new URL('${fromUi('libs/app-socle/src/coque.ts')}', import.meta.url).href, { type: 'module' });\n`,
                        refusals: [
                            ['no-restricted-syntax', 'restrictedSyntax'],
                        ],
                    },
                    [`${ui}/probe-worker-url-chaine.ts`]: {
                        source: `export const worker = new Worker(new URL('${fromUi('libs/app-socle/src/coque.ts')}', import.meta.url).toString(), { type: 'module' });\n`,
                        refusals: [
                            ['no-restricted-syntax', 'restrictedSyntax'],
                        ],
                    },
                    // Admis : l'API publique du socle de l'appli.
                    [`${ui}/probe-admis.ts`]: {
                        source: "export * from '@socle/app';\n",
                        refusals: [],
                    },
                },
                cite
            );
            // Textes natifs cités (`@nx/eslint-plugin` 24.0.3), et inscrits
            // au journal du test (sortie JSON d'ESLint, chemins du produit).
            t.diagnostic(`interface ${JSON.stringify(cited)}`);
            assert.match(
                cited[`${ui}/probe-entree-coque-relative.ts`][0][2],
                /^Projects cannot be imported by a relative or absolute path, and must begin with a npm scope$/
            );
            assert.match(
                cited[`${ui}/probe-autre-socle.ts`][0][2],
                /^A project tagged with "app:app" can only depend on libs tagged with "app:app"$/
            );
            // B-3 : textes natifs de la directive et du sélecteur.
            assert.match(
                cited[`${ui}/probe-vite-glob.ts`][0][2],
                /^Do not use a triple slash reference for vite\/client, use `import` style instead\.$/
            );
            assert.match(
                cited[`${ui}/probe-vite-glob.ts`][1][2],
                /^`import\.meta\.glob` n'est pas une API de l'interface/
            );
            assert.match(
                cited[`${ui}/probe-worker-url.ts`][0][2],
                /^Un worker construit sur un chemin n'est pas une API de l'interface/
            );
            // Le socle ne dépend ni de l'interface, ni d'un autre socle.
            const socleCited = await refused(
                root,
                'app-socle',
                {
                    'libs/app-socle/src/probe-interface.ts': {
                        source: "export * from '@interface/app';\n",
                        refusals: [ONLY_TAGS],
                    },
                    'libs/app-socle/src/probe-autre-socle.ts': {
                        source: "export * from '@socle/other';\n",
                        refusals: [ONLY_TAGS],
                    },
                },
                cite
            );
            t.diagnostic(`socle ${JSON.stringify(socleCited)}`);
            assert.match(
                socleCited['libs/app-socle/src/probe-interface.ts'][0][2],
                /^A project tagged with "layer:socle" can only depend on libs tagged with "layer:socle"$/
            );
            // La coque : ni le socle d'une autre appli, ni un chemin relatif.
            const coqueCited = await refused(
                root,
                'app',
                {
                    'apps/app/src/probe-autre-socle.ts': {
                        source: "export * from '@socle/other';\n",
                        refusals: [ONLY_TAGS],
                    },
                    'apps/app/src/probe-socle-relatif.ts': {
                        source: `export * from '${specifier(relative(join(root, 'apps/app/src'), join(root, 'libs/app-socle/src/index.ts')))}';\n`,
                        refusals: [RELATIVE],
                    },
                },
                cite
            );
            t.diagnostic(`coque ${JSON.stringify(coqueCited)}`);
        }
    );
}

test(
    'L-1 : le lint de la coque et celui de l’interface dépendent du `check-socle` de LEUR socle (graphe des tâches Nx)',
    { timeout: 240_000 },
    async (t) => {
        for (const profile of ['angular-pwa', 'react-spa']) {
            const { root, files } = await nativeProduct(t, profile);
            const dependencies = async (project) => {
                const { stdout } = await run(
                    process.execPath,
                    [
                        join(root, 'node_modules/nx/dist/bin/nx.js'),
                        'run',
                        `${project}:lint`,
                        '--graph=stdout',
                    ],
                    {
                        cwd: root,
                        env: nativeEnv(root),
                        maxBuffer: 64 * 1024 * 1024,
                    }
                );
                const { tasks } = JSON.parse(stdout.slice(stdout.indexOf('{')));
                return tasks.dependencies[`${project}:lint`]
                    .map(({ id }) => id)
                    .sort();
            };
            for (const app of ['app', 'other']) {
                for (const project of [app, `${app}-interface`])
                    assert.deepEqual(
                        await dependencies(project),
                        [`${app}-socle:check-socle`],
                        `${profile} ${project}`
                    );
                assert.deepEqual(
                    await dependencies(`${app}-socle`),
                    [],
                    `${profile} ${app}-socle`
                );
            }
            // La cible lance le vérificateur scellé du produit, PAR APPLI
            // (commit 3, v2 R2.4 point 4).
            const socle = JSON.parse(files['libs/app-socle/project.json']);
            assert.deepEqual(socle.targets['check-socle'], {
                executor: 'nx:run-commands',
                options: {
                    command: 'node .atelier/support/check-socle.mjs --app app',
                },
            });
        }
    }
);

test(
    'R-S (b) : sous Vite, le build React de la coque ne résout pas `@socle-coque/<app>` depuis une page de l’interface ; `typecheck` de l’interface ROUGE',
    { timeout: 240_000 },
    async (t) => {
        const { root, files } = await nativeProduct(t, 'react-spa');
        const page = Object.keys(files).find((path) =>
            /^libs\/app-interface\/src\/pages\/[^/]+\/page\.tsx$/.test(path)
        );
        assert.ok(page);
        const before = await nxTarget(root, 'app', 'build:production');
        assert.equal(before.code, 0, before.output);
        const original = await readFile(join(root, page), 'utf8');
        await writeFile(
            join(root, page),
            "import '@socle-coque/app';\n" + original
        );
        const build = await nxTarget(root, 'app', 'build:production');
        const typecheck = await nxTarget(root, 'app-interface', 'typecheck');
        await writeFile(join(root, page), original);
        assert.notEqual(build.code, 0, build.output);
        assert.match(
            build.output,
            /Rolldown failed to resolve import "@socle-coque\/app" from "[^"]+\/libs\/app-interface\/src\/pages\/[^/]+\/page\.tsx"/
        );
        assert.notEqual(typecheck.code, 0, typecheck.output);
        assert.match(typecheck.output, /error TS\d+: .*'@socle-coque\/app'/);
    }
);

for (const profile of ['angular-pwa', 'react-spa'])
    test(`${profile} : \`create-app\` d’une troisième appli : ESLint racine identique à l’octet ; chaque appli a sa contrainte dans ses trois projets`, async (t) => {
        // Revue de l'étape A, A-6 : les deux piles (React importe aussi
        // `eslint-plugin-react-hooks`).
        const fixture = await shellFixture(t, profile);
        const rootEslint = () =>
            readFile(join(fixture.root, 'eslint.config.mjs'), 'utf8');
        const before = await rootEslint();
        // Oracle écrit ici (v4 § V4.3 point 1) : les seules contraintes de
        // COUCHE, en données exportées, et la règle déclarée avec elles.
        assert.ok(
            normalized(before).includes(
                normalized(
                    'export const LAYER_CONSTRAINTS = [' +
                        '{"sourceTag":"type:app","onlyDependOnLibsWithTags":["layer:socle","layer:interface"]},' +
                        '{"sourceTag":"layer:interface","onlyDependOnLibsWithTags":["layer:socle"]},' +
                        '{"sourceTag":"layer:socle","onlyDependOnLibsWithTags":["layer:socle"]}];'
                )
            ),
            before
        );
        assert.doesNotMatch(before, /app:/);
        // Chaque paquet importé par un ESLint du produit est DÉCLARÉ par le
        // produit, sur l'espace réellement planifié par l'atelier (paquets choisis
        // par ses tables) : son vérificateur l'exige (« Import non déclaré »).
        const product = JSON.parse(
            await readFile(join(fixture.root, 'package.json'), 'utf8')
        );
        const declared = {
            ...product.dependencies,
            ...product.devDependencies,
        };
        const imported = new Set();
        const assertDeclared = (path, text) => {
            for (const [, name] of text.matchAll(
                /from '((?:@[^/']+\/)?[^/'.][^/']*)/g
            )) {
                imported.add(name);
                assert.ok(Object.hasOwn(declared, name), `${path} : ${name}`);
            }
        };
        assertDeclared('eslint.config.mjs', before);
        assert.ok(imported.has('@nx/eslint-plugin'), [...imported].join());
        for (const appName of ['alpha', 'beta', 'gamma']) {
            const options = { ...fixture.shell, appName };
            const plan = await planExternalApplicationShell(options);
            // Le plan n'écrit que les trois racines de l'appli.
            assert.deepEqual(plan.roots.map(({ root }) => root).sort(), [
                `apps/${appName}`,
                `libs/${appName}-interface`,
                `libs/${appName}-socle`,
            ]);
            await publishExternalApplicationShell(
                { ...options, expectedPlanId: plan.plan_id },
                { run: () => undefined }
            );
            assert.equal(await rootEslint(), before, appName);
            for (const projectRoot of applicationProjectRoots(appName)) {
                const text = await readFile(
                    join(fixture.root, projectRoot, 'eslint.config.mjs'),
                    'utf8'
                );
                assert.ok(
                    normalized(text).includes(
                        normalized(
                            `depConstraints: [...LAYER_CONSTRAINTS, { sourceTag: 'app:${appName}', onlyDependOnLibsWithTags: ['app:${appName}'] }]`
                        )
                    ),
                    `${projectRoot} : contrainte de l'appli\n${text}`
                );
                assertDeclared(`${projectRoot}/eslint.config.mjs`, text);
            }
        }
    });

// Texte sans blancs, guillemets ni virgules finales, pour retrouver une
// donnée rendue par Prettier (clés sans guillemets, chaînes entre
// apostrophes, virgule finale des listes sur plusieurs lignes).
const normalized = (text) =>
    text.replace(/[\s'"]/g, '').replace(/,(?=[\]}])/g, '');

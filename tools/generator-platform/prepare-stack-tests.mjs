import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    mkdir,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { dirname, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIGNATURE, SIGNATURE_FILES } from './core/atelier-signature.mjs';
import {
    applicationProjectRoots,
    nativeControls,
} from './core/application-native-controls.mjs';
import {
    actionOutputRoot,
    SESSION_MODULE,
} from './core/external-publication-paths.mjs';
import {
    coqueRoot,
    interfaceRoot,
    SOCLE_PAGES_DIR,
    SOCLE_SESSION_DIR,
    socleRoot,
} from './core/socle-names.mjs';
import { coquePaths } from './renderers/external-product-layout.mjs';
import { computeAngularPageCompositionTarget } from './page-composition-targets.mjs';
import {
    createApplicationSessionFixture,
    SESSION_FIXTURE_DOMAINS,
} from './test-support/application-session-fixture.mjs';
import { FIXTURE_PREFIX } from './test-support/application-design-fixture.mjs';
import { renderAngularPwaShell } from './renderers/angular-pwa-shell-renderer.mjs';
import { renderAngularActionRequestV2 } from './renderers/angular-action-request-v2-renderer.mjs';
import { sessionEndpointToken } from './renderers/angular-application-session-renderer.mjs';
import { pascalCase } from './renderers/shared.mjs';
import {
    catalogueRead,
    sessionConsumers,
} from './test-support/session-consumers.mjs';
import { renderApplicationWorkspace } from './renderers/application-workspace-renderer.mjs';

const generatorRoot = dirname(fileURLToPath(import.meta.url));
const outputRoot = resolve(generatorRoot, '.stack-test-runtime');
const target = process.argv[2];

if (target !== 'angular') {
    throw new Error(
        'Usage: node tools/generator-platform/prepare-stack-tests.mjs angular'
    );
}

async function writeTargetFiles(root, files) {
    for (const [relativePath, content] of Object.entries(files)) {
        const outputPath = resolve(root, relativePath);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content);
    }
}

async function runtimeFileHashes(root) {
    const entries = await readdir(root, {
        recursive: true,
        withFileTypes: true,
    });
    assert.ok(entries.every((entry) => !entry.isSymbolicLink()));
    const files = await Promise.all(
        entries
            .filter((entry) => entry.isFile())
            .map(async (entry) => {
                const path = resolve(entry.parentPath, entry.name);
                return [
                    relative(root, path).split(sep).join('/'),
                    createHash('sha256')
                        .update(await readFile(path))
                        .digest('hex'),
                ];
            })
    );
    return Object.fromEntries(
        files.sort(([left], [right]) => left.localeCompare(right))
    );
}

// These specs exercise both complete session products. They are compiled by
// Angular's native test target, separately from the raw-TS Vitest runner used
// by the other stack fixtures. X5 C2 adds the external-profile read.
const sessionSpecs = [
    'action-request-session.spec.ts',
    'application-session-tab.spec.ts',
    'application-session.spec.ts',
    'list-query-external-session.spec.ts',
    'page-composition-session.spec.ts',
];

// Lot 2 (conception v5, V5.1) : le runtime de test des sessions est un PRODUIT
// à deux applis (coques, socles et interfaces aux chemins du produit), plus un
// dossier de fixture par domaine. Les alias de la coque (`@socle/*`,
// `@interface/*`, `@socle-coque/<app>`) y sont résolus par les chemins de
// chaque coque (`coquePaths`, source unique) re-basés vers la configuration
// qui les lit : jamais une liste écrite à la main.
const SESSION_RUNTIME = 'application-session';
function runtimePaths(runtimeRoot) {
    const paths = {};
    for (const domain of SESSION_FIXTURE_DOMAINS) {
        const coque = posix.join(runtimeRoot, coqueRoot(domain));
        for (const [alias, targets] of Object.entries(coquePaths(domain)))
            paths[alias] = targets.map(
                (target) => `./${posix.join(coque, target)}`
            );
    }
    return paths;
}
// Sources d'une appli du produit : sous `src/` de l'une de ses racines.
const productSource = (domain, path) =>
    applicationProjectRoots(domain).some((root) =>
        path.startsWith(`${root}/src/`)
    );

async function prepareSessionTestWorkspace() {
    const workspaceRoot = resolve(generatorRoot, '../..');
    const view = resolve(outputRoot, 'application-session-native');
    await rm(view, { recursive: true, force: true });
    const packageSource = await readFile(
        resolve(workspaceRoot, 'package.json')
    );
    const packageModel = JSON.parse(packageSource.toString('utf8'));
    const workspace = await renderApplicationWorkspace({
        profiles: ['angular-pwa'],
        packages: {},
        packageManager: packageModel.packageManager,
        engines: packageModel.engines,
        githubRepository: 'fixtures/session-stack-tests',
        reviewOwner: 'fixture-reviewer',
    });
    await writeTargetFiles(view, workspace);
    // Chaque produit est copié À SES CHEMINS (trois racines) dans la vue : ses
    // projets Nx et leurs configurations.
    const copiedProducts = {};
    for (const domain of SESSION_FIXTURE_DOMAINS) {
        const product = resolve(
            outputRoot,
            'application-session-products',
            domain
        );
        const productHashes = await runtimeFileHashes(product);
        const files = {};
        for (const path of Object.keys(productHashes)) {
            files[path] = await readFile(resolve(product, path));
        }
        await writeTargetFiles(view, files);
        for (const [path, sha256] of Object.entries(productHashes))
            assert.equal(
                createHash('sha256')
                    .update(await readFile(resolve(view, path)))
                    .digest('hex'),
                sha256,
                path
            );
        copiedProducts[domain] = productHashes;
    }
    // Keep the specs and their relative imports byte-identical. These
    // runtime sources have already been compared with the full products.
    const runtime = resolve(outputRoot, 'angular', SESSION_RUNTIME);
    const runtimeHashes = await runtimeFileHashes(runtime);
    const runtimeFiles = {};
    for (const path of Object.keys(runtimeHashes)) {
        runtimeFiles[path] = await readFile(resolve(runtime, path));
    }
    const nativeRuntime = `tools/generator-platform/.stack-test-runtime/angular/${SESSION_RUNTIME}`;
    await writeTargetFiles(resolve(view, nativeRuntime), runtimeFiles);
    assert.deepEqual(
        await runtimeFileHashes(resolve(view, nativeRuntime)),
        runtimeHashes
    );
    const specRoot = 'tools/generator-platform/stack-tests/angular';
    const specHashes = {};
    for (const name of sessionSpecs) {
        const content = await readFile(resolve(workspaceRoot, specRoot, name));
        await writeTargetFiles(resolve(view, specRoot), { [name]: content });
        assert.deepEqual(
            await readFile(resolve(view, specRoot, name)),
            content
        );
        specHashes[name] = createHash('sha256').update(content).digest('hex');
    }
    assert.deepEqual(
        (await readdir(resolve(view, specRoot))).sort(),
        sessionSpecs
    );
    // C-B2 : le projet qui porte la cible `test` de l'appli, lu dans la liste
    // unique des contrôles natifs (le socle, pour une appli à session).
    const [domain] = SESSION_FIXTURE_DOMAINS;
    const owned = {};
    for (const path of Object.keys(copiedProducts[domain]))
        owned[path] = await readFile(resolve(view, path), 'utf8');
    const tests = nativeControls(domain, owned).filter(
        (control) => control.target === 'test'
    );
    assert.equal(tests.length, 1, 'one native test target');
    const [nativeTest] = tests;
    const projectRoot = applicationProjectRoots(domain).find(
        (root) =>
            JSON.parse(owned[`${root}/project.json`]).name ===
            nativeTest.project
    );
    const projectPath = `${projectRoot}/project.json`;
    const originalProject = owned[projectPath];
    const project = JSON.parse(originalProject);
    assert.equal(project.targets.test.executor, '@angular/build:unit-test');
    assert.equal(project.targets.test.options.watch, false);
    assert.equal(
        project.targets.test.options.runnerConfig,
        `${SIGNATURE_FILES.support}/angular-unit-test.config.mjs`
    );
    const include = sessionSpecs.map((name) => resolve(view, specRoot, name));
    project.targets.test.options = {
        ...project.targets.test.options,
        include,
        tsConfig: 'session-tests.tsconfig.json',
        reporters: ['verbose'],
    };
    const overlay = JSON.stringify(project, null, 4) + '\n';
    await writeTargetFiles(view, {
        [projectPath]: overlay,
        'package.json': packageSource,
        'bun.lock': await readFile(resolve(workspaceRoot, 'bun.lock')),
        // Les alias de la coque visent les sources du RUNTIME copié (une
        // seule copie de chaque module, donc de chaque jeton d'injection).
        'session-tests.tsconfig.json':
            JSON.stringify(
                {
                    extends: `./${projectRoot}/tsconfig.spec.json`,
                    compilerOptions: { paths: runtimePaths(nativeRuntime) },
                    files: sessionSpecs.map((name) => `${specRoot}/${name}`),
                    include: [],
                },
                null,
                4
            ) + '\n',
        'session-tests-provenance.json':
            JSON.stringify(
                {
                    fixtureOnly: true,
                    networkVerified: false,
                    nativeTarget: nativeTest.label,
                    bidomain: [...SESSION_FIXTURE_DOMAINS],
                    include,
                    specHashes,
                    copiedProducts,
                    projectOverlay: {
                        path: projectPath,
                        beforeSha256: createHash('sha256')
                            .update(originalProject)
                            .digest('hex'),
                        afterSha256: createHash('sha256')
                            .update(overlay)
                            .digest('hex'),
                        changedOptionsOnly: [
                            'include',
                            'tsConfig',
                            'reporters',
                        ],
                    },
                    testBedInitialization: 'Angular native builder only',
                    installs: false,
                },
                null,
                4
            ) + '\n',
    });
    // Reuse the acquired dependencies; this preparation never installs them.
    await symlink(
        resolve(workspaceRoot, 'node_modules'),
        resolve(view, 'node_modules'),
        'dir'
    );
}

const targetRoot = resolve(outputRoot, target);
const runtimeConfigurationFiles = {
    'tsconfig.json': `${JSON.stringify(
        {
            extends: '../../../../tsconfig.base.json',
            compilerOptions: {
                emitDecoratorMetadata: true,
                experimentalDecorators: true,
            },
            include: ['**/*.ts'],
        },
        null,
        4
    )}\n`,
    // Vérification de types du runtime et des specs de pile : la
    // configuration de l'atelier, plus les alias des coques du runtime.
    'tsconfig.typecheck.json': `${JSON.stringify(
        {
            extends: '../../tsconfig.angular-tests.json',
            compilerOptions: { paths: runtimePaths(SESSION_RUNTIME) },
        },
        null,
        4
    )}\n`,
};

await rm(targetRoot, { recursive: true, force: true });
await writeTargetFiles(targetRoot, runtimeConfigurationFiles);

if (target === 'angular') {
    const otherTargets = await runtimeFileHashes(targetRoot);
    const productRoot = resolve(outputRoot, 'application-session-products');
    await rm(productRoot, { recursive: true, force: true });
    const runtime = resolve(targetRoot, SESSION_RUNTIME);
    for (const domain of SESSION_FIXTURE_DOMAINS) {
        const data = await createApplicationSessionFixture({ domain });
        try {
            const fixtureDir = resolve(runtime, domain);
            const experience = data.design.experiences[0];
            const shell = await renderAngularPwaShell({
                design: data.design,
                experienceId: experience.id,
                appName: domain,
                designPath: `design/${domain}.json`,
                designSha256: data.pages.values().next().value.pageContract
                    .design_ref.sha256,
                externalWorkspace: true,
                // Produit fictif de la pile : le préfixe neutre des tests.
                prefix: FIXTURE_PREFIX,
            });
            // Lot 2 : le produit, à ses chemins (trois racines), amorces de
            // l'interface comprises ; le runtime de test n'en reçoit que les
            // sources. Product configuration belongs to a real product
            // workspace, not to Vite's nearest-tsconfig lookup.
            const productDestination = resolve(productRoot, domain);
            const productFiles = { ...shell.files, ...shell.seeds };
            const expectedProductFiles = { ...productFiles };
            await writeTargetFiles(productDestination, productFiles);
            await writeTargetFiles(
                runtime,
                Object.fromEntries(
                    Object.entries(productFiles).filter(([path]) =>
                        productSource(domain, path)
                    )
                )
            );
            // Publications de la pile, aux chemins du socle : dans le produit
            // ET le runtime, à l'octet.
            async function writePublished(base, files) {
                for (const [path, content] of Object.entries(files))
                    expectedProductFiles[`${base}/${path}`] = content;
                await Promise.all(
                    [runtime, productDestination].map((root) =>
                        writeTargetFiles(resolve(root, base), files)
                    )
                );
            }
            // Spécifieurs depuis le dossier de fixture du domaine.
            const fromFixture = (path) =>
                relative(fixtureDir, resolve(runtime, path))
                    .split(sep)
                    .join('/');
            const session = `${socleRoot(domain)}/${SOCLE_SESSION_DIR}`;
            const exported = [
                `export { App } from '${fromFixture(`${coqueRoot(domain)}/src/app/app`)}';`,
                `export { appRoutes } from '${fromFixture(`${coqueRoot(domain)}/src/app/app.routes`)}';`,
                `export * from '${fromFixture(session)}';`,
                `export { applicationSessionInterceptor } from '${fromFixture(`${session}/session.interceptor`)}';`,
                `export { applicationSessionGuard } from '${fromFixture(`${session}/session.guard`)}';`,
                "export { consumedRoutes } from './fixture-consumers';",
            ];
            for (const [id, { model }] of data.actions) {
                // Commande au chemin de sa publication (V5.1), session par le
                // spécifieur dérivé de production.
                const action = renderAngularActionRequestV2(model, {
                    services: {
                        [domain + '-service']: {
                            module: SESSION_MODULE,
                            token: sessionEndpointToken(domain + '-service'),
                        },
                    },
                });
                const base = actionOutputRoot(domain, id);
                await writePublished(base, action.files);
                const role = id.slice(domain.length + 1),
                    name = pascalCase(id);
                exported.push(
                    `export { ${name}Facade as ${pascalCase(role)}Facade } from '${fromFixture(`${base}/src/${id}.facade`)}';`
                );
                exported.push(
                    `export { ${name}Source as ${pascalCase(role)}Source } from '${fromFixture(`${base}/src/${id}.source`)}';`
                );
            }
            // Composition de la pile, sous le dossier de la page du socle
            // (`execution`, propre au banc) : même profondeur vers la session
            // qu'avant le lot 2, donc mêmes spécifieurs.
            const execution = (id) =>
                `${socleRoot(domain)}/${SOCLE_PAGES_DIR}/${id}/execution`;
            const pages = {};
            for (const [id, page] of data.pages) {
                const role = page.page.path.slice(1);
                pages[role] = id;
                if (!page.plan) continue;
                const hostBindings = structuredClone(data.hostBindings);
                hostBindings.session.module = '../../../session';
                hostBindings.services[domain + '-service'].module =
                    '../../../../../session';
                const result = await computeAngularPageCompositionTarget({
                    plan: page.plan,
                    artifactRoot: data.root,
                    hostBindings,
                });
                await writePublished(
                    execution(id),
                    Object.fromEntries(
                        Object.entries(result.angular.files).map(
                            ([path, content]) => [
                                path.replace(/^src\//, ''),
                                content,
                            ]
                        )
                    )
                );
                const name = pascalCase(role);
                exported.push(
                    `export { PageComposition as ${name}Composition } from '${fromFixture(`${execution(id)}/page-composition`)}';`
                );
                exported.push(
                    `export { PAGE_COMPOSITION_PROVIDERS as ${name.toUpperCase()}_PROVIDERS } from '${fromFixture(`${execution(id)}/page-composition.providers`)}';`
                );
            }
            exported.push(
                `export const fixture = ${JSON.stringify({
                    domain,
                    names: data.names,
                    pages,
                    sessionResult: data.sessionResult,
                    wireResponse: data.wireResponse,
                    commandResult: data.commandResult,
                    enterInput: data.enterInput,
                    // Forme de la lecture catalogue (liste ou page, entrée).
                    catalogueRead: catalogueRead(data),
                    // Chemins déclarés par le contrat du fixture (source unique).
                    operations: Object.fromEntries(
                        data.contract.operations.map((operation) => [
                            operation.id.slice(domain.length + 1),
                            operation.path,
                        ])
                    ),
                    endpoint: {
                        contract_id: data.contract.contract.id,
                        service_id: domain + '-service',
                        base_url: `https://${domain}.example/api`,
                    },
                    inputFixtureOnly: true,
                    networkVerified: false,
                })} as const;`
            );
            // Fixtures du banc : dans le runtime seul, jamais dans le produit.
            await writeTargetFiles(fixtureDir, {
                'fixture-consumers.ts': sessionConsumers(data, {
                    routes: fromFixture(
                        `${coqueRoot(domain)}/src/app/app.routes`
                    ),
                    composition: (id) => fromFixture(execution(id)),
                }),
                'fixture-runtime.ts': exported.join('\n') + '\n',
            });
            // These filesystem invariants run in Node during preparation,
            // before the browser-oriented TypeScript and Vitest commands.
            const productHashes = await runtimeFileHashes(productDestination);
            for (const path of [
                `${coqueRoot(domain)}/project.json`,
                `${coqueRoot(domain)}/tsconfig.json`,
                `${coqueRoot(domain)}/tsconfig.app.json`,
                `${coqueRoot(domain)}/eslint.config.mjs`,
                `${coqueRoot(domain)}/public/manifest.webmanifest`,
                `${socleRoot(domain)}/project.json`,
                `${socleRoot(domain)}/tsconfig.lib.json`,
                `${socleRoot(domain)}/tsconfig.spec.json`,
                `${interfaceRoot(domain)}/project.json`,
                `${interfaceRoot(domain)}/tsconfig.lib.json`,
            ]) {
                assert.ok(
                    Object.hasOwn(productHashes, path),
                    `session product must retain its native configuration: ${path}`
                );
            }
            assert.deepEqual(
                productHashes,
                Object.fromEntries(
                    Object.entries(expectedProductFiles).map(
                        ([path, content]) => [
                            path,
                            createHash('sha256').update(content).digest('hex'),
                        ]
                    )
                ),
                'session product output must contain every native file'
            );
            // Fichiers du runtime propres à ce domaine.
            const own = (path) =>
                path.startsWith(`${domain}/`) || productSource(domain, path);
            const testPaths = Object.keys(
                await runtimeFileHashes(runtime)
            ).filter(own);
            for (const path of [
                `${coqueRoot(domain)}/src/app/app.ts`,
                `${domain}/fixture-consumers.ts`,
                `${domain}/fixture-runtime.ts`,
            ]) {
                assert.ok(
                    testPaths.includes(path),
                    `session test target must contain its entry point: ${path}`
                );
            }
            const toolConfiguration =
                /(?:^|\/)(?:tsconfig(?:\.[^/]+)?\.json|(?:project|package|angular|nx)\.json|(?:eslint|vite|vitest)\.config\.[^/]+|\.eslintrc(?:\.[^/]+)?)$/;
            assert.deepEqual(
                testPaths.filter((path) => toolConfiguration.test(path)),
                [],
                'session test target must not contain product tool configuration'
            );
            assert.ok(
                testPaths.every(
                    (path) =>
                        !path.split('/').includes(SIGNATURE.dir) &&
                        !path.split('/').includes('public')
                ),
                'session test target must not contain product metadata or assets'
            );
            const expectedTestPaths = [
                ...Object.keys(expectedProductFiles).filter((path) =>
                    productSource(domain, path)
                ),
                `${domain}/fixture-consumers.ts`,
                `${domain}/fixture-runtime.ts`,
            ];
            assert.deepEqual(
                testPaths.sort(),
                expectedTestPaths.sort(),
                'session test target must contain every source and fixture file'
            );
            for (const path of testPaths.filter((entry) =>
                productSource(domain, entry)
            )) {
                assert.deepEqual(
                    await readFile(resolve(runtime, path)),
                    await readFile(resolve(productDestination, path)),
                    `session source must be byte-identical in both outputs: ${path}`
                );
            }
        } finally {
            await rm(data.root, { recursive: true, force: true });
        }
    }
    for (const [path, content] of Object.entries(runtimeConfigurationFiles))
        assert.equal(
            await readFile(resolve(targetRoot, path), 'utf8'),
            content,
            'shared Angular test configuration must remain unchanged'
        );
    const afterSession = await runtimeFileHashes(targetRoot);
    for (const path of Object.keys(afterSession))
        if (path.startsWith(`${SESSION_RUNTIME}/`)) delete afterSession[path];
    assert.deepEqual(
        afterSession,
        otherTargets,
        'session preparation changed another target'
    );
    await prepareSessionTestWorkspace();
}

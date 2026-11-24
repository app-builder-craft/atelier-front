// X0 (lot produit extérieur) : coque Angular avec session créée par
// `create-app --target-root` dans deux produits fictifs indépendants.
// Le runner injecté ne compile rien : la compilation, le build, le lint, les
// tests et le navigateur réels sont prouvés par check:external-application-shells.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
    planExternalApplicationShell,
    publishExternalApplicationShell,
} from './core/application-workspace.mjs';
import {
    pathExists,
    verifyGeneratedTree,
} from './core/external-application-paths.mjs';
import { EXTERNAL_WORKSPACE_SIGNATURE as WORKSPACE } from './renderers/application-workspace-renderer.mjs';
import { renderAngularPwaShell } from './renderers/angular-pwa-shell-renderer.mjs';
import {
    externalCspHeader,
    EXTERNAL_CSP_HEADER_PATH,
    externalCspMeta,
} from './renderers/external-content-security-policy.mjs';
import {
    RELAY_FILES,
    relayEnvshPath,
} from './renderers/external-relay-renderer.mjs';
import { FIXTURE_PREFIX } from './test-support/application-design-fixture.mjs';
import { createApplicationSessionFixture } from './test-support/application-session-fixture.mjs';
import {
    hash,
    installMetadataOnly,
    prepareFixture,
    snapshotTree,
    TOOLS_ROOT,
} from './test-support/external-application-fixture.mjs';
import { runDocumentCli } from './test-support/external-document-fixture.mjs';
import {
    createAppArguments,
    INTERNAL_MODULE_SPECIFIER,
    SESSION_FIXTURE_DOMAINS,
    sessionShellOptions,
    writeExternalSessionDesign,
} from './test-support/external-session-fixture.mjs';
import { SIGNATURE_FILES, INTERNAL } from './core/atelier-signature.mjs';
import { appManifestPath } from './renderers/external-product-layout.mjs';

// Lot 2 (V5.1) : la session vit dans le socle ; chemins relatifs au produit.
const coque = (app) => `apps/${app}`;
const session = (app) => `libs/${app}-socle/src/session`;
const verifyRoots = async (plan) => {
    for (const { root, files } of plan.roots)
        await verifyGeneratedTree(join(plan.root, root), files);
};

async function sessionProduct(t, domain) {
    const fixture = await prepareFixture(t);
    const input = await writeExternalSessionDesign(fixture.root, domain);
    await installMetadataOnly(fixture.plan);
    return { ...fixture, input, shell: sessionShellOptions(input) };
}

// Politique de la coque au préfixe des produits fictifs.
const EXTERNAL_CSP_META = externalCspMeta(FIXTURE_PREFIX);
const EXTERNAL_CSP_HEADER = externalCspHeader(FIXTURE_PREFIX);

const typescript = (plan) =>
    Object.entries(plan.files).filter(([path]) => path.endsWith('.ts'));

test('X0 : deux produits fictifs planifient une coque Angular avec session, sans import de la portée de l’atelier ni URL de service', async (t) => {
    const plans = [];
    for (const domain of SESSION_FIXTURE_DOMAINS) {
        const product = await sessionProduct(t, domain);
        const plan = await planExternalApplicationShell(product.shell);
        plans.push(plan);
        assert.equal(plan.profile, 'angular-pwa');
        assert.equal(plan.compiler_validation, 'angular-ngc');
        // La fermeture des entrées est exactement celle du produit.
        assert.deepEqual(
            plan.external_workspace.inputs.map((entry) => entry.path),
            product.input.inputPaths
        );
        for (const entry of plan.external_workspace.inputs)
            assert.equal(
                entry.sha256,
                hash(await readFile(join(product.root, entry.path)))
            );
        const files = Object.keys(plan.files);
        for (const path of [
            'session.guard.ts',
            'session.store.ts',
            'session.interceptor.ts',
        ])
            assert.ok(
                files.includes(`${session(plan.app_name)}/${path}`),
                path
            );
        const source = typescript(plan)
            .map(([, content]) => content)
            .join('\n');
        assert.doesNotMatch(source, INTERNAL_MODULE_SPECIFIER);
        assert.equal(
            typescript(plan).filter(([, content]) =>
                /export const SKIP_AUTH =/.test(content)
            ).length,
            1
        );
        // Aucune URL déclarée du contrat n'est embarquée : elles sont
        // injectées au lancement par SESSION_ENDPOINTS.
        assert.ok(product.input.serviceUrls.length > 0);
        for (const url of product.input.serviceUrls)
            for (const [path, content] of Object.entries(plan.files))
                assert.equal(content.includes(url), false, path);
        const routes =
            plan.files[`${coque(plan.app_name)}/src/app/app.routes.ts`];
        for (const page of product.input.design.pages)
            assert.match(
                routes,
                new RegExp(
                    `page_id: ['"]${page.id}['"] },\\s*canActivate: \\[applicationSessionGuard\\]`
                )
            );
        assert.match(
            routes,
            new RegExp(
                `path: ['"]\\*\\*['"], redirectTo: ['"]${product.input.reconnectPage.path}['"]`
            )
        );
        const entry = JSON.parse(
            plan.files[
                `${coque(plan.app_name)}/${SIGNATURE_FILES.pages}/${product.input.entryPage.id}.json`
            ]
        );
        assert.equal(entry.experience.session.storage, 'memory');
        assert.equal(
            entry.experience.session.producer.page_id,
            product.input.entryPage.id
        );
    }
    assert.notEqual(plans[0].plan_id, plans[1].plan_id);
    assert.notEqual(plans[0].tree_sha256, plans[1].tree_sha256);
});

test('X0/T4 : le plan relu d’un produit ne se transfère pas à un produit aux entrées identiques', async (t) => {
    const a = await sessionProduct(t, 'observatory');
    const b = await sessionProduct(t, 'observatory');
    const planA = await planExternalApplicationShell(a.shell);
    const planB = await planExternalApplicationShell(b.shell);
    assert.equal(planA.tree_sha256, planB.tree_sha256);
    assert.notEqual(planA.plan_id, planB.plan_id);
    const before = await snapshotTree(b.root, []);
    await assert.rejects(
        publishExternalApplicationShell(
            { ...b.shell, expectedPlanId: planA.plan_id },
            { run: () => assert.fail('Plan transféré accepté') }
        ),
        /reviewed shell plan is stale/
    );
    assert.deepEqual(await snapshotTree(b.root, []), before);
});

test('X0 : React reste refusé pour une conception avec session, en API comme en CLI, sans écriture', async (t) => {
    const product = await sessionProduct(t, 'equipment-hire');
    const before = await snapshotTree(product.root, []);
    const react = sessionShellOptions(product.input, 'react-spa');
    await assert.rejects(
        planExternalApplicationShell(react),
        /APP_SESSION_REACT_UNSUPPORTED/
    );
    const cli = runDocumentCli('create-app', [
        ...createAppArguments(react),
        '--dry-run',
    ]);
    assert.equal(cli.status, 1);
    assert.equal(cli.stdout, '');
    assert.match(cli.stderr, /Création extérieure refusée/);
    assert.deepEqual(await snapshotTree(product.root, []), before);
});

test('X0 : create-app --target-root --dry-run, puis publication relue avec les seuls exécutables du produit', async (t) => {
    const workshopBefore = await snapshotTree(TOOLS_ROOT);
    for (const domain of SESSION_FIXTURE_DOMAINS) {
        const product = await sessionProduct(t, domain);
        const preview = runDocumentCli('create-app', [
            ...createAppArguments(product.shell),
            '--dry-run',
        ]);
        assert.equal(preview.status, 0, preview.stderr);
        const reviewed = JSON.parse(preview.stdout);
        const plan = await planExternalApplicationShell(product.shell);
        assert.equal(reviewed.plan_id, plan.plan_id);
        assert.equal(reviewed.output, `apps/session-${domain}`);
        assert.deepEqual(reviewed.files, Object.keys(plan.files).sort());
        assert.deepEqual(reviewed.seeds, Object.keys(plan.seeds).sort());
        // Le dry-run n'écrit rien dans le produit.
        assert.equal(await pathExists(plan.outputAbsolute), false);
        assert.equal(await pathExists(join(product.root, 'libs')), false);
        const marker = await readFile(
            join(product.root, SIGNATURE_FILES.workspaceManifest)
        );
        const calls = [];
        const result = await publishExternalApplicationShell(
            { ...product.shell, expectedPlanId: reviewed.plan_id },
            {
                run: (command, args, cwd) => {
                    calls.push({ command, args, cwd });
                },
            }
        );
        assert.equal(result.recovered, false);
        assert.equal(result.plan.plan_id, reviewed.plan_id);
        const labels = calls.map(({ command, args, cwd }) => {
            assert.equal(command, process.execPath);
            assert.equal(cwd, product.root);
            assert.ok(args[0].startsWith(product.root + '/'), args[0]);
            return args[0].endsWith('check-workspace.mjs')
                ? 'workspace-contract'
                : args[1] === 'run'
                  ? args[2]
                  : 'native-compiler';
        });
        const app = `session-${domain}`;
        // Lot 2 : compilation des deux candidats de bibliothèque, puis la liste
        // unique des contrôles (C-B2) : lint de chaque projet AVANT la
        // construction (T-E8 = P1), puis la cible `test` du SOCLE ; la coque à
        // session n'en a plus.
        assert.deepEqual(labels, [
            'native-compiler',
            'native-compiler',
            `${app}:lint`,
            `${app}-socle:lint`,
            `${app}-interface:lint`,
            `${app}:build:production`,
            `${app}-socle:test`,
            'workspace-contract',
        ]);
        assert.ok(
            calls[0].args[0].startsWith(join(product.root, 'node_modules/'))
        );
        assert.equal(
            calls.at(-1).args[0],
            join(product.root, WORKSPACE.support, 'check-workspace.mjs')
        );
        await verifyRoots(plan);
        const manifest = JSON.parse(plan.files[appManifestPath(app)]);
        assert.equal(manifest.design_ref.path, product.input.designPath);
        assert.ok(
            manifest.generated_files.some(
                (entry) => entry.path === `${session(app)}/session.guard.ts`
            )
        );
        assert.deepEqual(
            await readFile(
                join(product.root, SIGNATURE_FILES.workspaceManifest)
            ),
            marker
        );
        // Une seconde publication du même plan reprend sans réécrire.
        const again = await publishExternalApplicationShell(
            { ...product.shell, expectedPlanId: reviewed.plan_id },
            { run: () => undefined }
        );
        assert.equal(again.recovered, true);
    }
    assert.deepEqual(
        await snapshotTree(TOOLS_ROOT),
        workshopBefore,
        'L’atelier a changé pendant la création extérieure'
    );
});

test('X0 : une entrée de session modifiée après relecture périme le plan, sans candidat ni sortie', async (t) => {
    const product = await sessionProduct(t, 'observatory');
    const plan = await planExternalApplicationShell(product.shell);
    const contract = join(
        product.root,
        'descriptions/session-observatory/backend.json'
    );
    await writeFile(contract, (await readFile(contract, 'utf8')) + ' ');
    const before = await snapshotTree(product.root, []);
    await assert.rejects(
        publishExternalApplicationShell(
            { ...product.shell, expectedPlanId: plan.plan_id },
            { run: () => assert.fail('Entrée modifiée acceptée') }
        ),
        /external application:/
    );
    assert.deepEqual(await snapshotTree(product.root, []), before);
});

test('X0 : un fichier ajouté à la main dans la coque avec session bloque toute commande suivante', async (t) => {
    // Lot 2 (v1 commit 1) : fichier ajouté ou modifié dans la coque ou le
    // socle, ou hors des sources de l'interface : REFUSÉ par l'atelier ;
    // fichier libre dans les sources de l'interface : ADMIS.
    const app = 'session-equipment-hire';
    for (const [path, refusal] of [
        [`${coque(app)}/src/app/hand-made.ts`, /generated inventory drift/],
        [`${session(app)}/hand-made.ts`, /generated inventory drift/],
        [`libs/${app}-interface/hand-made.ts`, /unowned interface file/],
        [`libs/${app}-interface/src/pages/notes.ts`, null],
    ]) {
        await t.test(path, async (child) => {
            const product = await sessionProduct(child, 'equipment-hire');
            const plan = await planExternalApplicationShell(product.shell);
            await publishExternalApplicationShell(
                { ...product.shell, expectedPlanId: plan.plan_id },
                { run: () => undefined }
            );
            await writeFile(
                join(product.root, path),
                'export const handMade = true;\n',
                { flag: 'wx' }
            );
            const second = {
                ...product.shell,
                appName: 'session-equipment-hire-second',
            };
            if (!refusal) {
                await planExternalApplicationShell(second);
                return;
            }
            // État d'entrée du lot : aucune adoption, même d'un fichier anodin.
            await assert.rejects(
                planExternalApplicationShell(product.shell),
                refusal
            );
            await assert.rejects(planExternalApplicationShell(second), refusal);
        });
    }
    await t.test('fichier possédé du socle modifié', async (child) => {
        const product = await sessionProduct(child, 'equipment-hire');
        const plan = await planExternalApplicationShell(product.shell);
        await publishExternalApplicationShell(
            { ...product.shell, expectedPlanId: plan.plan_id },
            { run: () => undefined }
        );
        const owned = join(product.root, session(app), 'session.store.ts');
        await writeFile(owned, (await readFile(owned, 'utf8')) + '\n');
        await assert.rejects(
            planExternalApplicationShell({
                ...product.shell,
                appName: 'session-equipment-hire-second',
            }),
            /workspace ownership drift/
        );
    });
});

// Régression trouvée par la preuve native X0 : sans test, la cible native
// `test` du produit échoue (« No tests found ») et create-app refuse `created`.
test('X0 : la coque extérieure avec session porte son test de garde ; le mode atelier reste sans', async (t) => {
    for (const domain of SESSION_FIXTURE_DOMAINS) {
        const data = await createApplicationSessionFixture({ domain });
        t.after(() => rm(data.root, { recursive: true, force: true }));
        const render = async (externalWorkspace) =>
            renderAngularPwaShell({
                design: data.design,
                experienceId: data.design.experiences[0].id,
                appName: 'session-mode',
                designPath: `design/${domain}.json`,
                designSha256: hash('mode'),
                externalWorkspace,
                prefix: FIXTURE_PREFIX,
            });
        const atelier = (await render(false)).files;
        const product = await render(true);
        const external = product.files;
        const specs = (files) =>
            Object.keys(files).filter((path) => path.endsWith('.spec.ts'));
        assert.deepEqual(specs(atelier), []);
        // Lot 2 : la garde, la connectivité (X4-sécurité-3, G1) et la
        // navigation bornée (P-A4) et leurs specs vivent dans le socle.
        const socle = session('session-mode');
        const spec = `${socle}/session.guard.spec.ts`;
        const connectivity = `${socle}/connectivity.ts`;
        const connectivitySpec = `${socle}/connectivity.spec.ts`;
        const navigationSpec = `${socle}/session.navigation.spec.ts`;
        assert.deepEqual(specs(external).sort(), [
            connectivitySpec,
            spec,
            navigationSpec,
        ]);
        // Chaque fichier du mode atelier a sa place dans la disposition
        // extérieure : session au socle, amorces de page à l'interface, le
        // reste dans la coque.
        for (const path of Object.keys(atelier)) {
            const page = /^src\/app\/pages\/(page_[a-f0-9]{16})\/(.+)$/.exec(
                path
            );
            if (path === SIGNATURE_FILES.appManifest) continue;
            // L-5 : sans spec, la coque perd aussi sa configuration de specs.
            if (path === 'tsconfig.spec.json') {
                assert.equal(
                    Object.hasOwn(
                        external,
                        `${coque('session-mode')}/tsconfig.spec.json`
                    ),
                    false
                );
                continue;
            }
            if (path.startsWith('src/app/session/'))
                assert.ok(
                    Object.hasOwn(
                        external,
                        `${socle}/${path.slice('src/app/session/'.length)}`
                    ),
                    path
                );
            else if (page)
                assert.ok(
                    Object.hasOwn(
                        product.seeds,
                        `libs/session-mode-interface/src/pages/${page[1]}/${page[2]}`
                    ),
                    path
                );
            else
                assert.ok(
                    Object.hasOwn(external, `${coque('session-mode')}/${path}`),
                    path
                );
        }
        for (const path of [
            EXTERNAL_CSP_HEADER_PATH,
            ...Object.values(RELAY_FILES).filter(
                (path) => path !== RELAY_FILES.endpoints
            ),
            relayEnvshPath(FIXTURE_PREFIX),
        ])
            assert.ok(
                Object.hasOwn(external, `${coque('session-mode')}/${path}`),
                path
            );
        assert.ok(Object.hasOwn(external, `${socle}/relay-endpoints.ts`));
        assert.match(
            external[connectivity],
            /readonly online: Signal<boolean>/
        );
        assert.match(external[spec], /from '\.\/session\.guard'/);
        assert.match(external[spec], /toBeInstanceOf\(UrlTree\)/);
        assert.ok(
            JSON.parse(
                external[appManifestPath('session-mode')]
            ).generated_files.some((entry) => entry.path === spec)
        );
        // L-5 : la coque à session n'a plus de spec, donc pas de cible `test` ;
        // le socle en porte une, qui vise la construction de la coque (V5.5).
        const coqueProject = JSON.parse(
            external[`${coque('session-mode')}/project.json`]
        );
        assert.equal(coqueProject.targets.test, undefined);
        const socleProject = JSON.parse(
            external['libs/session-mode-socle/project.json']
        );
        assert.equal(
            socleProject.targets.test.executor,
            '@angular/build:unit-test'
        );
        assert.equal(
            socleProject.targets.test.options.buildTarget,
            'session-mode:build:development'
        );
    }
});

// X4-sécurité : la coque extérieure porte sa politique de sécurité de
// contenu, en balise meta avant toute ressource et en gabarit d'en-tête, les
// deux possédés et scellés ; le mode atelier reste sans politique.
test('X4-sécurité : politique de sécurité de contenu générée par la coque extérieure, mode atelier inchangé', async (t) => {
    const data = await createApplicationSessionFixture({
        domain: SESSION_FIXTURE_DOMAINS[0],
    });
    t.after(() => rm(data.root, { recursive: true, force: true }));
    const render = async (externalWorkspace) =>
        (
            await renderAngularPwaShell({
                design: data.design,
                experienceId: data.design.experiences[0].id,
                appName: 'session-mode',
                designPath: 'design/csp.json',
                designSha256: hash('csp'),
                externalWorkspace,
                prefix: FIXTURE_PREFIX,
            })
        ).files;
    const atelier = await render(false);
    const rendered = await render(true);
    // Lot 2 : la coque extérieure, relative à elle.
    const external = Object.fromEntries(
        Object.entries(rendered)
            .filter(([path]) => path.startsWith('apps/session-mode/'))
            .map(([path, content]) => [
                path.slice('apps/session-mode/'.length),
                content,
            ])
    );
    assert.doesNotMatch(atelier['src/index.html'], /Content-Security-Policy/);
    assert.equal(atelier[EXTERNAL_CSP_HEADER_PATH], undefined);
    const index = external['src/index.html'];
    const metas = [
        ...index.matchAll(
            /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g
        ),
    ];
    assert.equal(metas.length, 1);
    assert.equal(metas[0][1], EXTERNAL_CSP_META);
    // Avant toute ressource : base, manifeste, scripts injectés au build.
    for (const later of ['<base href', '<link rel="manifest"', '<title>'])
        assert.ok(index.indexOf(metas[0][0]) < index.indexOf(later), later);
    const directives = new Map(
        EXTERNAL_CSP_META.split('; ').map((entry) => {
            const [name, ...values] = entry.split(' ');
            return [name, values.join(' ')];
        })
    );
    assert.equal(directives.get('connect-src'), "'self'");
    assert.equal(directives.get('script-src'), "'self'");
    assert.equal(directives.get('base-uri'), "'self'");
    assert.equal(directives.get('form-action'), "'none'");
    assert.equal(directives.get('object-src'), "'none'");
    assert.equal(directives.get('frame-src'), "'none'");
    assert.equal(directives.has('frame-ancestors'), false);
    // Aucune origine nommée, aucun joker, aucun code dynamique.
    for (const value of directives.values())
        assert.doesNotMatch(value, /\*|https?:|unsafe-eval|\/\//);
    assert.equal(
        EXTERNAL_CSP_HEADER,
        `${EXTERNAL_CSP_META}; frame-ancestors 'none'`
    );
    assert.ok(
        external[EXTERNAL_CSP_HEADER_PATH].includes(
            `add_header Content-Security-Policy "${EXTERNAL_CSP_HEADER}" always;`
        )
    );
    const manifest = JSON.parse(external[SIGNATURE_FILES.appManifest]);
    for (const path of ['src/index.html', EXTERNAL_CSP_HEADER_PATH])
        assert.ok(
            manifest.generated_files.some(
                (entry) => entry.path === `apps/session-mode/${path}`
            ),
            path
        );
    // Le CSS critique en ligne ajouterait un gestionnaire onload refusé.
    assert.deepEqual(
        JSON.parse(external['project.json']).targets.build.configurations
            .production.optimization,
        {
            scripts: true,
            styles: { minify: true, inlineCritical: false },
            fonts: false,
        }
    );
    assert.equal(
        JSON.parse(atelier['project.json']).targets.build.configurations
            .production.optimization,
        undefined
    );
});

// V9-R1 : l'oracle du test 37 refuse aussi un import sans `from`.
test('X0 : l’oracle « aucun module de l’atelier » voit chaque forme d’import, sans faux positif', () => {
    for (const source of [
        `import { session } from '${INTERNAL.scope}/shared-domain';`,
        `import '${INTERNAL.scope}/x';`,
        `import "${INTERNAL.scope}/x";`,
        `export * from '${INTERNAL.scope}/x';`,
        `const lazy = await import('${INTERNAL.scope}/x');`,
        `const old = require(\`${INTERNAL.scope}/x\`);`,
    ])
        assert.match(source, INTERNAL_MODULE_SPECIFIER, source);
    for (const source of [
        "import { inject } from '@angular/core';",
        `import { tokens } from '${INTERNAL.scope}x/y';`,
        `// ${INTERNAL.name} est le nom de l’atelier, pas un module.`,
    ])
        assert.doesNotMatch(source, INTERNAL_MODULE_SPECIFIER, source);
});

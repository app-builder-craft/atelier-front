// Lot 2 (conception v5) : disposition en trois racines d'une appli
// extérieure, lue sur le RENDU des trois profils (Angular à session, Angular
// et React sans session). C-B2 et T-E8 = P1 : la liste unique des contrôles
// natifs, dérivée des configurations rendues, lint avant construction ;
// V5.5 réduite et C-A3 : une cible `test` si et seulement si le projet porte
// une spec ; R-8a : la zone libre ne reçoit que les amorces ; V5.4 : un module
// de page vide par page, une ligne d'export par page ; V5.3 : `libs/` ne porte
// aucune forme du préfixe. Oracles écrits ici.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { nativeControls } from './core/application-native-controls.mjs';
import { isInterfaceFreePath } from './core/application-ownership.mjs';
import { pageModulePath } from './core/external-publication-paths.mjs';
import { productNameForms } from './core/product-identity.mjs';
import { renderAngularPwaShell } from './renderers/angular-pwa-shell-renderer.mjs';
import { renderReactSpaShell } from './renderers/react-spa-shell-renderer.mjs';
import { applicationDesign } from './test-support/application-design-fixture.mjs';
import { createApplicationSessionFixture } from './test-support/application-session-fixture.mjs';
import { DISTINCTIVE_PREFIX } from './test-support/distinctive-prefix.mjs';

const SPEC = /\.spec\.tsx?$/;

// Les trois profils, rendus pour l'appli `app` au préfixe donné.
async function renders(t, prefix = 'ns') {
    const session = await createApplicationSessionFixture({
        domain: 'observatory',
    });
    t.after(() => rm(session.root, { recursive: true, force: true }));
    const shell = applicationDesign('a'.repeat(64), 'b'.repeat(64));
    const spa = {
        ...shell,
        experiences: shell.experiences.map((experience) => ({
            ...experience,
            offline_policy: 'none',
        })),
    };
    const cases = [
        ['angular-session', renderAngularPwaShell, session.design, true],
        ['angular', renderAngularPwaShell, shell, false],
        ['react', renderReactSpaShell, spa, false],
    ];
    const rendered = [];
    for (const [label, render, design, withSession] of cases) {
        const output = await render({
            design,
            experienceId: design.experiences[0].id,
            appName: 'app',
            designPath: 'descriptions/app.json',
            designSha256: 'c'.repeat(64),
            externalWorkspace: true,
            prefix,
        });
        rendered.push({ label, withSession, ...output });
    }
    return rendered;
}

const under = (files, root) =>
    Object.keys(files).filter((path) => path.startsWith(`${root}/`));

test('C-B2 et T-E8 = P1 : liste unique des contrôles natifs, lint des trois projets avant la construction, puis les tests', async (t) => {
    const expected = {
        'angular-session': [
            'app:lint',
            'app-socle:lint',
            'app-interface:lint',
            'app:build:production',
            'app-socle:test',
        ],
        angular: [
            'app:lint',
            'app-socle:lint',
            'app-interface:lint',
            'app:build:production',
            'app:test',
        ],
        react: [
            'app:lint',
            'app-socle:lint',
            'app-interface:lint',
            'app:build:production',
            'app:test',
        ],
    };
    for (const { label, files } of await renders(t)) {
        const labels = nativeControls('app', files).map(
            (control) => control.label
        );
        assert.deepEqual(labels, expected[label], label);
        const build = labels.indexOf('app:build:production');
        for (const [index, entry] of labels.entries())
            if (entry.endsWith(':lint')) assert.ok(index < build, entry);
            else if (entry.endsWith(':test')) assert.ok(index > build, entry);
    }
});

test('V5.5 réduite et C-A3 : cible `test` si et seulement si le projet porte une spec ; la coque à session n’en a plus', async (t) => {
    for (const { label, files, profile, withSession } of await renders(t)) {
        const tests = new Set(
            nativeControls('app', files)
                .filter((control) => control.target === 'test')
                .map((control) => control.project)
        );
        for (const [project, root] of [
            ['app', 'apps/app'],
            ['app-socle', 'libs/app-socle'],
            ['app-interface', 'libs/app-interface'],
        ]) {
            const specs = under(files, root).filter((path) => SPEC.test(path));
            assert.equal(
                tests.has(project),
                specs.length > 0,
                `${label} : ${project}`
            );
            // C-A3 : en React, la configuration Vite (qui fait inférer la
            // cible) n'est rendue que pour un projet qui porte une spec.
            if (profile === 'react-spa' && root.startsWith('libs/'))
                assert.equal(
                    Object.hasOwn(files, `${root}/vite.config.mts`),
                    specs.length > 0,
                    `${label} : ${root}/vite.config.mts`
                );
        }
        const coque = JSON.parse(files['apps/app/project.json']);
        assert.equal(Boolean(coque.targets.test), !withSession, label);
        if (withSession) {
            // V5.5 : la cible du socle vise la construction de la COQUE.
            const socle = JSON.parse(files['libs/app-socle/project.json']);
            assert.equal(
                socle.targets.test.executor,
                '@angular/build:unit-test'
            );
            assert.equal(
                socle.targets.test.options.buildTarget,
                'app:build:development'
            );
            assert.equal(
                socle.targets.test.options.tsConfig,
                'libs/app-socle/tsconfig.spec.json'
            );
        }
    }
});

test('R-8a : la zone libre de l’interface ne reçoit que les amorces ; de possédé, seule sa carte des pages', async (t) => {
    for (const { label, files, seeds, pages } of await renders(t)) {
        // Fichiers POSSÉDÉS rendus dans la zone libre : la seule carte.
        assert.deepEqual(
            Object.keys(files).filter((path) =>
                isInterfaceFreePath('app', path)
            ),
            ['libs/app-interface/src/index.ts'],
            label
        );
        // Les amorces : toutes dans la zone libre, sous le dossier de leur
        // page, aucune possédée.
        const seedPaths = Object.keys(seeds);
        assert.ok(seedPaths.length > 0, label);
        for (const path of seedPaths) {
            assert.ok(isInterfaceFreePath('app', path), path);
            assert.equal(Object.hasOwn(files, path), false, path);
            assert.ok(
                pages.some(({ id }) =>
                    path.startsWith(`libs/app-interface/src/pages/${id}/`)
                ),
                path
            );
        }
    }
});

test('V5.4 : un module de page vide par page, et une ligne d’export par page dans l’API du socle', async (t) => {
    for (const { label, files, pages } of await renders(t)) {
        assert.ok(pages.length > 0, label);
        const index = files['libs/app-socle/src/index.ts'];
        for (const { id } of pages) {
            assert.equal(files[pageModulePath('app', id)], 'export {};\n', id);
            assert.deepEqual(
                index.split('\n').filter((line) => line.includes(id)),
                [`export * as ${id} from './pages/${id}/composition/src';`],
                `${label} : ${id}`
            );
        }
        const modules = Object.keys(files).filter((path) =>
            /^libs\/app-socle\/src\/pages\/[^/]+\/composition\/src\/index\.ts$/.test(
                path
            )
        );
        assert.equal(modules.length, pages.length, label);
    }
});

test('V5.3 : les bibliothèques ne portent aucune forme du préfixe, et sont égales à l’octet d’un préfixe à l’autre', async (t) => {
    const ns = await renders(t, 'ns');
    const distinctive = await renders(t, DISTINCTIVE_PREFIX);
    for (const [index, { label, files }] of distinctive.entries()) {
        const libs = Object.keys(files).filter((path) =>
            path.startsWith('libs/')
        );
        assert.ok(libs.length > 0, label);
        for (const path of libs) {
            assert.equal(
                files[path].includes(DISTINCTIVE_PREFIX),
                false,
                `${label} : ${path}`
            );
            assert.deepEqual(
                [...productNameForms(files[path]).keys()],
                [],
                `${label} : ${path}`
            );
            assert.equal(files[path], ns[index].files[path], path);
        }
        // Les amorces aussi.
        for (const [path, content] of Object.entries(distinctive[index].seeds))
            assert.equal(content, ns[index].seeds[path], path);
    }
});

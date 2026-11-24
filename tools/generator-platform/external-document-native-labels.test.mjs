// CI #48 (job « External application shells », étape T9–T18) : le
// coordinateur jugeait les appels du runner d'une cellule EXT03a par un nombre
// écrit à la main (5), alors que la création du 1b en fait 8 (un compilateur
// par candidat de bibliothèque, la liste unique C-B2, le contrat de l'espace).
// Il les juge désormais contre la liste dérivée du plan de la création.
import assert from 'node:assert/strict';
import test from 'node:test';

import { applicationProjectRoots } from './core/application-native-controls.mjs';
import { assertNativeCellLabels } from './proof-support/external-document-native.mjs';
import { renderAngularPwaShell } from './renderers/angular-pwa-shell-renderer.mjs';
import { renderReactSpaShell } from './renderers/react-spa-shell-renderer.mjs';
import { applicationDesign } from './test-support/application-design-fixture.mjs';

// Plan de création d'une cellule, réduit à ce que lit la liste unique : nom,
// racines et fichiers possédés rendus.
async function cellPlan(profile) {
    const design = applicationDesign('a'.repeat(64), 'b'.repeat(64));
    const app = `ext03a-a-${profile}`;
    const render =
        profile === 'angular-pwa' ? renderAngularPwaShell : renderReactSpaShell;
    const plain =
        profile === 'angular-pwa'
            ? design
            : {
                  ...design,
                  experiences: design.experiences.map((experience) => ({
                      ...experience,
                      offline_policy: 'none',
                  })),
              };
    const { files } = await render({
        design: plain,
        experienceId: plain.experiences[0].id,
        appName: app,
        designPath: 'descriptions/app.json',
        designSha256: 'c'.repeat(64),
        externalWorkspace: true,
        prefix: 'ns',
    });
    return {
        app,
        plan: {
            app_name: app,
            files,
            roots: applicationProjectRoots(app).map((root) => ({ root })),
        },
    };
}

const receipt = (labels, planned = labels) => ({
    native: { labels },
    native_labels: planned,
});

for (const profile of ['angular-pwa', 'react-spa']) {
    test(`${profile} : appels de la cellule jugés contre la liste dérivée du plan`, async () => {
        const { app, plan } = await cellPlan(profile);
        // Oracle écrit ici : deux compilateurs de bibliothèque, lint des trois
        // projets, construction, test de la coque (sans session), contrat.
        const expected = [
            'native-compiler',
            'native-compiler',
            `${app}:lint`,
            `${app}-socle:lint`,
            `${app}-interface:lint`,
            `${app}:build:production`,
            `${app}:test`,
            'workspace-contract',
        ];
        assertNativeCellLabels(receipt(expected), plan);
        // L'ancienne forme (cinq appels, construction avant lint) : refusée.
        const before = [
            'native-compiler',
            `${app}:build:production`,
            `${app}:lint`,
            `${app}:test`,
            'workspace-contract',
        ];
        assert.throws(
            () => assertNativeCellLabels(receipt(before), plan),
            assert.AssertionError
        );
        // Ordre changé, appel en trop, liste du plan différente : refusés.
        for (const labels of [
            [...expected].reverse(),
            [...expected, `${app}:test`],
        ])
            assert.throws(
                () => assertNativeCellLabels(receipt(labels), plan),
                assert.AssertionError
            );
        assert.throws(
            () =>
                assertNativeCellLabels(
                    receipt(expected, expected.slice(1)),
                    plan
                ),
            assert.AssertionError
        );
    });
}

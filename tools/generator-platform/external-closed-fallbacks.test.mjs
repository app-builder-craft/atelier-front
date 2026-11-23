// CI #389 : fermeture des replis silencieux. Une donnée attendue absente
// arrête le rendu de la composition avec un refus nommé ; un repli restant
// porte sa justification sur son site.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { renderAngularPageComposition } from './renderers/angular-page-composition-renderer.mjs';

const SESSION_MODULE = '../../../../../session';
// Liaisons d'hôte du profil sans session : le rendu d'une commande ne lit
// aucun service, la table reste vide (rendu identique à l'ancienne fixture).
const PLAIN_HOST = Object.freeze({
    schema_version: '1.0.0',
    kind: 'angular-page-host-bindings',
    services: {},
});
const SESSION_HOST = Object.freeze({
    schema_version: '1.1.0',
    kind: 'angular-page-host-bindings',
    session: { module: SESSION_MODULE, token: 'APPLICATION_SESSION' },
    connectivity: {
        module: `${SESSION_MODULE}/connectivity`,
        token: 'ApplicationConnectivity',
    },
    services: {},
});

function commandNode(permissions) {
    return {
        id: 'archive',
        primitive_ref: {
            uri: 'apps/fixture/src/app/generated/actions/archive-op/execution-model.json',
            kind: 'action-request-execution-model',
            schema_version: '1.1.0',
            operation_id: 'archive-op',
        },
        authorization: {
            mode: 'required',
            ...(permissions === undefined ? {} : { permissions }),
            denied_behavior: 'hide',
        },
        invalidates: [],
    };
}

const RENDERED = Object.freeze([
    {
        kind: 'command',
        nodeId: 'archive',
        target: {
            actionId: 'archive-op',
            files: { 'src/index.ts': 'export {};\n' },
            artifacts: [{ path: 'src/index.ts', artifact_id: 'public-api' }],
        },
    },
]);

const PROFILES = Object.freeze({
    interne: (node) =>
        renderAngularPageComposition(
            {
                schema_version: '1.0.0',
                kind: 'page-execution-plan',
                query_nodes: [],
                command_nodes: [node],
            },
            RENDERED,
            PLAIN_HOST
        ),
    extérieur: (node, session = { effects: [] }) =>
        renderAngularPageComposition(
            {
                schema_version: '1.1.0',
                kind: 'page-execution-plan',
                session,
                query_nodes: [],
                command_nodes: [node],
            },
            RENDERED,
            SESSION_HOST,
            {
                externalNodes: {
                    archive: {
                        root: 'actions/archive-op/src',
                        module: '../../../../actions/archive-op/src',
                        sampleInput: { field: 'exemple-contrat' },
                        serviceToken: 'FIXTURE_SERVICE_API_URL',
                    },
                },
            }
        ),
});

// Priorité du pilote : en mode `required`, une liste de permissions absente
// ou vide rendait `[].every()` vrai, donc l'action autorisée sans permission.
for (const [profile, render] of Object.entries(PROFILES))
    test(`composition ${profile} : permissions absentes ou vides en mode required → refus nommé`, () => {
        const files = render(commandNode(['archive.write'])).files;
        assert.match(
            Object.values(files).join('\n'),
            /PermissionSignals = \["archive\.write"\]/
        );
        for (const permissions of [undefined, [], [''], [7]])
            assert.throws(
                () => render(commandNode(permissions)),
                /page composition: archive authorization required without permissions/,
                JSON.stringify(permissions)
            );
    });

test('composition extérieure : une session sans effets déclarés → refus nommé', () => {
    assert.throws(
        () => PROFILES.extérieur(commandNode(['archive.write']), {}),
        /page composition: session without declared effects/
    );
});

// Balayage : chaque repli `?? []`, `?? {}`, `|| []` ou `|| {}` du périmètre
// porte sa justification sur son site, même ligne ou ligne au-dessus.
const SWEPT = [
    'renderers/angular-page-composition-renderer.mjs',
    'renderers/page-composition-guards.mjs',
];
const FALLBACK = /\?\? \[\]|\?\? \{\}|\|\| \[\]|\|\| \{\}/;
const MARKER = '// repli justifié : ';

test('balayage : aucun repli sans sa justification sur le site', async () => {
    const unmarked = [];
    for (const path of SWEPT) {
        const lines = (
            await readFile(new URL(`./${path}`, import.meta.url), 'utf8')
        ).split('\n');
        lines.forEach((line, index) => {
            if (
                FALLBACK.test(line) &&
                !line.includes(MARKER) &&
                !(lines[index - 1] ?? '').includes(MARKER)
            )
                unmarked.push(`${path}:${index + 1}`);
        });
    }
    assert.deepEqual(unmarked, []);
});

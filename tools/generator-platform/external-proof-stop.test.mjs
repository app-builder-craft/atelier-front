// EXT01 v7 et CI #48 : la ligne STOP du rapport des preuves natives. Une
// ligne, bornée, sans contrôle ni séquence de terminal ; le message d'une
// assertion (et ses valeurs) est écarté, mais le contrôle en cause est nommé
// (opérateur et lieu dans l'atelier), sous une forme fermée.
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
    formatProofStop,
    TOOLS_ROOT,
} from './test-support/external-application-fixture.mjs';

test('EXT01 v7 : STOP conserve un message explicite du code', () => {
    assert.equal(
        formatProofStop(new Error('Arrêt fictif du code')),
        'STOP Error: Arrêt fictif du code; aucun succès global revendiqué.'
    );
});

test('EXT01 v7 : STOP écarte aussi une assertion personnalisée avec diff intégré', () => {
    const explicit = new assert.AssertionError({
        message: 'Contrat fictif refusé',
        actual: 'sortie-enfant-fictive',
        expected: 'valeur-fictive',
        operator: 'strictEqual',
    });
    assert.equal(explicit.generatedMessage, false);
    assert.match(explicit.message, /sortie-enfant-fictive/);
    // Le contrôle en cause est nommé (opérateur, lieu dans l'atelier) ; ni le
    // message ni les valeurs.
    const line = formatProofStop(explicit);
    assert.match(line, STOP_ASSERTION('strictEqual'));
    assert.doesNotMatch(line, /fictive|Contrat/);
});

test('EXT01 v7 : STOP écarte le message d’une assertion générée', () => {
    const generated = new assert.AssertionError({
        actual: 'sortie-enfant-fictive',
        expected: 'valeur-fictive',
        operator: 'strictEqual',
    });
    assert.equal(generated.generatedMessage, true);
    assert.match(generated.message, /sortie-enfant-fictive/);
    const line = formatProofStop(generated);
    assert.match(line, STOP_ASSERTION('strictEqual'));
    assert.doesNotMatch(line, /fictive/);
});

// CI #48 : un STOP sur une assertion doit dire QUEL contrôle a échoué. Forme
// attendue : opérateur et lieu de l'appel, relatif à l'atelier.
function STOP_ASSERTION(operator) {
    return new RegExp(
        `^STOP AssertionError \\[${operator}\\] tools/generator-platform/external-proof-stop\\.test\\.mjs:\\d+:\\d+; aucun succès global revendiqué\\.$`
    );
}

// Assertion réelle levée par un contrôle de l'atelier (ici, ce fichier).
function failingControl(actual) {
    assert.deepEqual(actual, ['valeur-attendue-fictive']);
}

test('CI #48 : STOP nomme le contrôle d’une assertion (opérateur, lieu), sans ses valeurs', () => {
    let error;
    try {
        failingControl(['secret-fictif-de-sortie']);
    } catch (thrown) {
        error = thrown;
    }
    const line = formatProofStop(error);
    assert.match(line, STOP_ASSERTION('deepStrictEqual'));
    assert.doesNotMatch(line, /secret|valeur|fictif/);
});

test('CI #48 : STOP n’écrit ni lieu hors de l’atelier, ni dépendance, ni opérateur hors forme', () => {
    const forged = (operator, frames) => {
        const error = new assert.AssertionError({
            actual: 1,
            expected: 2,
            operator: 'strictEqual',
        });
        error.operator = operator;
        error.stack = ['AssertionError: x', ...frames].join('\n');
        return formatProofStop(error);
    };
    const bare = 'STOP AssertionError; aucun succès global revendiqué.';
    const atelier = pathToFileURL(TOOLS_ROOT).href;
    for (const frames of [
        ['    at f (file:///etc/secret-fictif/x.mjs:1:2)'],
        [`    at f (${atelier}/node_modules/pkg/a.js:1:2)`],
        [`    at f (${atelier}/tools/a%20b.mjs:1:2)`],
        [`    at f (${atelier}/../dehors/x.mjs:1:2)`],
        ['    at node:internal/x:1:2'],
    ])
        assert.equal(forged('', frames), bare, frames[0]);
    for (const operator of ['strictEqual; secret', 'x'.repeat(40), 'Égal'])
        assert.equal(forged(operator, []), bare, operator);
    assert.equal(
        forged('strictEqual', [
            `    at f (${atelier}/tools/generator-platform/x.mjs:12:3)`,
        ]),
        'STOP AssertionError [strictEqual] tools/generator-platform/x.mjs:12:3; aucun succès global revendiqué.'
    );
});

test('EXT01 v7 : STOP tient sur une ligne sans contrôle ni séquence de terminal', () => {
    const error = new Error(
        'début \u001b[31mrouge\u001b[0m fin\u0000\t\u007f\u202esuite'
    );
    const line = formatProofStop(error);
    assert.equal(
        line,
        'STOP Error: début rouge fin suite; aucun succès global revendiqué.'
    );
    error.name = 'Erreur\n\u0007fictive';
    assert.doesNotMatch(formatProofStop(error), /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
});

test('EXT01 v7 : STOP borne la ligne entière à 400 caractères', () => {
    const line = formatProofStop(new Error('é'.repeat(1000)));
    assert.equal(line.length, 400);
    assert.ok(line.startsWith('STOP Error: é'));
    assert.ok(line.endsWith('; aucun succès global revendiqué.'));
});

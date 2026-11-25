// CI #48 sur `be7bf4e9` (job « External application shells », T9–T18) : la
// cellule EXT03a/A/angular-pwa a échoué et le rapport ne disait que
// `native-cell exit=1` et une empreinte de diagnostic. La ligne FAIL nomme
// désormais, sous forme FERMÉE, l'appel natif en échec (label de
// `nativeRunLabels(plan)`, code de sortie) ou, hors appel natif, le contrôle
// en cause (opérateur, lieu dans l'atelier) ; jamais une sortie. Oracles
// écrits ici.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    cellFailureDetail,
    cellFailureNote,
    nativeDocumentFixture,
    proveCellCalls,
} from './proof-support/external-document-native.mjs';
import { record } from './proof-support/external-application-runtime.mjs';
import {
    installMetadataOnly,
    prepareFixture,
} from './test-support/external-application-fixture.mjs';

const CELL = 'A/angular-pwa';
const APP = 'ext03a-a-angular-pwa';
const PLANNED = [
    'native-compiler',
    'native-compiler',
    `${APP}:lint`,
    `${APP}-socle:lint`,
    `${APP}-interface:lint`,
    `${APP}:build:production`,
    `${APP}:test`,
    'workspace-contract',
];
// Une vraie assertion de l'atelier, avec sa pile.
const failedAssertion = () => {
    try {
        assert.equal(1, 0, 'sortie d’enfant : /chemin/local jeton=abc');
    } catch (error) {
        return error;
    }
    throw new Error('assertion attendue');
};

test('appel natif en échec : label pris dans la liste du plan et code de sortie', () => {
    const note = cellFailureNote({
        error: new Error('Échec de la preuve'),
        failed: { label: `${APP}-interface:lint`, exit: 1 },
        expected: PLANNED,
    });
    assert.deepEqual(note, {
        call: `${APP}-interface:lint`,
        control: '',
        exit: 1,
    });
    assert.equal(
        cellFailureDetail(JSON.parse(JSON.stringify(note)), CELL),
        `call=${APP}-interface:lint call_exit=1`
    );
    // Arrêt par signal : forme fermée elle aussi.
    assert.equal(
        cellFailureDetail(
            cellFailureNote({
                failed: { label: 'native-compiler', exit: 'interrupted' },
                expected: PLANNED,
            }),
            CELL
        ),
        'call=native-compiler call_exit=interrupted'
    );
});

test('échec hors appel natif : opérateur et lieu dans l’atelier, jamais le message', () => {
    const error = failedAssertion();
    const note = cellFailureNote({ error, failed: null, expected: PLANNED });
    assert.equal(note.call, null);
    assert.match(
        note.control,
        /^\[strictEqual\] tools\/generator-platform\/external-document-native-failure\.test\.mjs:\d+:\d+$/
    );
    const detail = cellFailureDetail(note, CELL);
    assert.equal(detail, `call=aucun at=${note.control}`);
    assert.doesNotMatch(detail, /sortie|chemin|jeton/);
});

test('label hors de la liste du plan : jamais écrit', () => {
    // La cellule ne nomme que ce que le plan prévoit…
    const note = cellFailureNote({
        error: failedAssertion(),
        failed: { label: 'other-app:lint', exit: 1 },
        expected: PLANNED,
    });
    assert.equal(note.call, null);
    // … et le coordinateur revérifie la note qu'il lit : liste fermée de
    // l'appli de la cellule, code de sortie, clés exactes, contrôle fermé.
    for (const forged of [
        { call: 'other-app:lint', control: '', exit: 1 },
        { call: `${APP}:lint`, control: '', exit: 256 },
        { call: `${APP}:lint`, control: '', exit: '1' },
        { call: `${APP}:lint --verbose`, control: '', exit: 1 },
        { call: null, control: 'Error: /chemin/local jeton=abc', exit: null },
        { call: null, control: '[equal] /absolu/x.mjs:1:1', exit: null },
        {
            call: null,
            control: '[equal] node_modules/x/y.mjs:1:1',
            exit: null,
        },
        { call: null, control: '', exit: 1 },
        { call: `${APP}:lint`, control: '', exit: 1, output: 'x' },
        null,
        [],
    ])
        assert.equal(
            cellFailureDetail(forged, CELL),
            'call=illisible',
            JSON.stringify(forged)
        );
    assert.equal(
        cellFailureDetail({ call: null, control: '', exit: null }, CELL),
        'call=aucun'
    );
});

test('la ligne FAIL porte le complément, la sortie de l’enfant reste écartée', () => {
    const session = { lines: [] };
    const write = process.stdout.write;
    process.stdout.write = () => true;
    try {
        assert.throws(
            () =>
                record(
                    session,
                    `EXT03a/${CELL}/native-cell`,
                    {
                        status: 1,
                        signal: null,
                        stdout: 'sortie privée',
                        stderr: '',
                    },
                    { detail: `call=${APP}:lint call_exit=1` }
                ),
            /Échec de la preuve EXT03a\/A\/angular-pwa\/native-cell/
        );
    } finally {
        process.stdout.write = write;
    }
    assert.equal(
        session.lines[0],
        `FAIL EXT03a/${CELL}/native-cell exit=1 call=${APP}:lint call_exit=1`
    );
    assert.ok(!session.lines.some((line) => line.includes('sortie privée')));
});

test('cellule réelle, runner injecté : l’appel natif en échec est celui que la note nomme', async (t) => {
    // Plan réel de la création (cellule A), aucun natif : l'appel du `lint`
    // de l'interface échoue ; la note reçoit son label, pris dans la liste
    // du plan, et son code de sortie.
    const prepared = await prepareFixture(t, ['angular-pwa', 'react-spa']);
    await installMetadataOnly(prepared.plan);
    const fixture = await nativeDocumentFixture(prepared.root, 'A');
    const failing = `${APP}-interface:lint`;
    const reported = [];
    const notes = [];
    await assert.rejects(
        proveCellCalls({
            root: prepared.root,
            cell: CELL,
            fixture,
            execute: (args) => ({
                status: args[1] === 'run' && args[2] === failing ? 1 : 0,
                signal: null,
                stdout: '',
                stderr: '',
            }),
            report: (label, result) => {
                reported.push(label);
                if (result.status !== 0) throw new Error(`échec ${label}`);
            },
            onFailure: (note) => {
                notes.push(note);
            },
        })
    );
    assert.equal(reported.at(-1), failing);
    assert.deepEqual(notes, [{ call: failing, control: '', exit: 1 }]);
    assert.equal(
        cellFailureDetail(JSON.parse(JSON.stringify(notes[0])), CELL),
        `call=${failing} call_exit=1`
    );
});

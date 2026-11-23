// Corpus des refus de l'atelier 1 (lot 10) : intégrité des DONNÉES gardées
// après le retrait de la grammaire. Le jugement (chaque sonde « lint »
// refusée par la configuration résolue de l'interface, les classes
// « exécution » renvoyées aux pages fautives) est la preuve de sortie des
// lots 5 et 6, qui lisent ce corpus.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
    COUNTER_PROBES,
    PAGE_PROBES,
    SECOND_PROBES,
    VALIDATOR_PROBES,
} from './test-support/page-probes.mjs';
import {
    COUNTER_PROBE_CLASSES,
    PROBE_CLASSES,
} from './test-support/page-probe-classes.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// Formes canoniques, mêmes que celles qui ont mesuré les sondes d'ORIGINE.
const probeDigest = (probe) =>
    sha256(
        JSON.stringify([
            probe.id,
            probe.file,
            probe.text,
            probe.mode,
            probe.find ?? null,
            probe.mechanism,
        ])
    );
const counterDigest = (probe) =>
    sha256(JSON.stringify([probe.id, probe.file, probe.text, probe.refused]));
const CLASSES = new Set([
    'lint',
    'limite',
    'forme',
    'permise',
    'compilateur',
    'exécution',
    'soumission-native',
    'écart-du-banc',
    'style',
]);

test('corpus : les 204 sondes du validateur (77 puis 127), identifiants uniques', () => {
    assert.equal(VALIDATOR_PROBES.length, 77);
    assert.equal(SECOND_PROBES.length, 127);
    assert.deepEqual(PAGE_PROBES, [...VALIDATOR_PROBES, ...SECOND_PROBES]);
    assert.equal(new Set(PAGE_PROBES.map((probe) => probe.id)).size, 204);
});

test('corpus : chaque sonde est celle d’origine, avec sa classe et sa décision', () => {
    assert.deepEqual(
        PROBE_CLASSES.map(([id]) => id),
        PAGE_PROBES.map((probe) => probe.id)
    );
    PAGE_PROBES.forEach((probe, index) => {
        const [id, kind, decision, origin, ...rest] = PROBE_CLASSES[index];
        assert.deepEqual(rest, [], id);
        assert.ok(CLASSES.has(kind), `${id} : classe ${kind}`);
        assert.ok(decision.trim().length > 0, `${id} : décision vide`);
        assert.equal(probeDigest(probe), origin, `${id} : sonde modifiée`);
    });
});

test('contre-sondes : 11 et 7 du gabarit, 15 et 5 de l’hôte, chacune d’origine et classée', () => {
    const count = (file, refused) =>
        COUNTER_PROBES.filter(
            (probe) => probe.file === file && probe.refused === refused
        ).length;
    assert.deepEqual(
        [
            count('p.html', true),
            count('p.html', false),
            count('x.ts', true),
            count('x.ts', false),
        ],
        [11, 7, 15, 5]
    );
    assert.equal(
        new Set(COUNTER_PROBES.map((probe) => probe.id)).size,
        COUNTER_PROBES.length
    );
    assert.deepEqual(
        COUNTER_PROBE_CLASSES.map(([id]) => id),
        COUNTER_PROBES.map((probe) => probe.id)
    );
    COUNTER_PROBES.forEach((probe, index) => {
        const [id, kind, decision, origin, ...rest] =
            COUNTER_PROBE_CLASSES[index];
        assert.deepEqual(rest, [], id);
        assert.equal(kind, probe.refused ? 'lint' : 'témoin', id);
        assert.ok(decision.trim().length > 0, `${id} : décision vide`);
        assert.equal(
            counterDigest(probe),
            origin,
            `${id} : contre-sonde modifiée`
        );
    });
});

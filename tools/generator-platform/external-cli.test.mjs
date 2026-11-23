// Avertissement des pages qui consomment une commande ou une lecture
// republiée (I-1) : chaque page est nommée avec son plan et, si elle est
// publiée, sa composition ; la marche à suivre ne nomme que les deux
// commandes du socle. Aucune page réalisée : la chaîne est retirée (ADR
// « Retrait de la grammaire héritée »).
import assert from 'node:assert/strict';
import test from 'node:test';

import { dependentPagesNotice } from './core/external-cli.mjs';

function capture(t, run) {
    const lines = [];
    t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
    run();
    return lines;
}

test('pages dépendantes : plan et composition nommés, marche à suivre du socle seule', (t) => {
    const pages = [
        { page_id: 'page_a', composition: false },
        { page_id: 'page_b', composition: true },
    ];
    assert.deepEqual(
        capture(t, () => dependentPagesNotice(pages)),
        [
            '⚠ Pages qui consomment cette commande : page_a (plan), page_b (plan, composition). Après publication, relancer compile:page-execution-plan puis generate:page-composition pour chacune.',
        ]
    );
    assert.deepEqual(
        capture(t, () =>
            dependentPagesNotice(pages.slice(0, 1), 'cette lecture')
        ),
        [
            '⚠ Pages qui consomment cette lecture : page_a (plan). Après publication, relancer compile:page-execution-plan puis generate:page-composition pour chacune.',
        ]
    );
});

test('pages dépendantes : rien à dire sans page', (t) => {
    assert.deepEqual(
        capture(t, () => dependentPagesNotice([])),
        []
    );
    assert.deepEqual(
        capture(t, () => dependentPagesNotice(undefined)),
        []
    );
});

// Texte d'absence d'une liaison de lecture, donnée de la conception scellée au
// plan (socle) : borne de la liste blanche du diagnostic tiers aveugle, motif
// du schéma du plan, et forme d'un texte déclaré sur une liaison. Les deux
// premiers cas viennent à l'identique de l'ancien test de la section
// `read_states` du bon de travail (retiré avec lui).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    ABSENT_TEXT_MAX,
    ABSENT_TEXT_PATTERN,
    absentTextBindingError,
    absentTextError,
} from './core/absent-text.mjs';

test('absent_text : liste blanche du tiers, bornes, refus nommés', () => {
    for (const text of [
        'Non renseigné',
        'Non communiqué par le demandeur',
        'N/A',
        'Œuvre',
        '« Inconnu »',
        'é'.repeat(ABSENT_TEXT_MAX),
    ])
        assert.equal(absentTextError(text), undefined, text);
    for (const [label, text, message] of [
        ['vide', '', /1 to 40 characters/],
        ['trop long', 'a'.repeat(ABSENT_TEXT_MAX + 1), /1 to 40 characters/],
        ['non chaîne', 1, /must be a string/],
        ['symbole seul', '—', /at least one letter/],
        ['chiffres seuls', '12', /at least one letter/],
        ['espace en tête', ' a', /single inner spaces/],
        ['espace en fin', 'a ', /single inner spaces/],
        ['espace doublée', 'a  b', /single inner spaces/],
    ]) {
        const error = absentTextError(text);
        assert.match(error, /^PAGE_ABSENT_TEXT_INVALID: /, label);
        assert.match(error, message, label);
    }
    for (const character of [
        ...'{}<>@`$"&\\|#%*+=[]^~_×÷',
        '\u0000',
        '\u007f',
        ' ',
        ' ',
        '​',
        '‮',
        '⁦',
        ' ',
        '﻿',
        '\n',
        '́',
        'а',
        'ο',
    ])
        assert.match(
            absentTextError(`a${character}b`),
            /^PAGE_ABSENT_TEXT_INVALID: /,
            `U+${character.codePointAt(0).toString(16)}`
        );
});

// Le plan scellé porte le texte, borné par le même motif dans son schéma.
test('absent_text : le schéma du plan porte le motif exact, sans drapeau u', async () => {
    const schema = JSON.parse(
        await readFile(
            new URL(
                './schemas/page-execution-plan.schema.json',
                import.meta.url
            ),
            'utf8'
        )
    );
    assert.deepEqual(schema.$defs.outputBinding.properties.absent_text, {
        type: 'string',
        minLength: 1,
        maxLength: ABSENT_TEXT_MAX,
        pattern: ABSENT_TEXT_PATTERN,
    });
    assert.ok(new RegExp(ABSENT_TEXT_PATTERN).test('Non renseigné'));
});

// Forme d'un texte déclaré sur une liaison du plan : liaison de LECTURE
// seulement, texte dans la liste blanche ; une liaison sans texte n'a rien à
// juger.
test('absent_text d’une liaison : lecture seulement, forme jugée, absence permise', () => {
    const binding = (absent_text) => ({ id: 'rows', absent_text });
    assert.equal(absentTextBindingError({ id: 'rows' }, 'query'), undefined);
    assert.equal(absentTextBindingError({ id: 'rows' }, 'command'), undefined);
    assert.equal(
        absentTextBindingError(binding('Non renseigné'), 'query'),
        undefined
    );
    assert.equal(
        absentTextBindingError(binding('Non renseigné'), 'command'),
        'PAGE_ABSENT_TEXT_INVALID: rows absent_text applies to read bindings only'
    );
    assert.match(
        absentTextBindingError(binding('12'), 'query'),
        /^rows PAGE_ABSENT_TEXT_INVALID: .*at least one letter/
    );
});

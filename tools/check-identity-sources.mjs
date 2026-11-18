#!/usr/bin/env node
/**
 * check:identity-sources — la signature de l'atelier et les formes du préfixe
 * du produit ne s'écrivent qu'à UN endroit :
 * `tools/generator-platform/core/atelier-signature.mjs` et
 * `tools/generator-platform/core/product-identity.mjs`.
 *
 * Tout est dérivé, rien n'est déclaré à la main :
 * - les VALEURS refusées sont celles qu'exportent les deux modules ;
 * - le PÉRIMÈTRE est l'ensemble des fichiers suivis `tools/**` et
 *   `examples/**` en `.mjs`, hors tests (`*.test.mjs`) et hors les deux
 *   modules eux-mêmes.
 * Une valeur réécrite en dur ailleurs ferait diverger l'atelier le jour où la
 * signature ou le préfixe change : elle est refusée, nommée, avec sa ligne.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIGNATURE_VALUES } from './generator-platform/core/atelier-signature.mjs';
import { LEGACY_PRODUCT_VALUES } from './generator-platform/core/product-identity.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const IDENTITY_SOURCES = Object.freeze([
    'tools/generator-platform/core/atelier-signature.mjs',
    'tools/generator-platform/core/product-identity.mjs',
]);

export const IDENTITY_VALUES = Object.freeze(
    [...new Set([...SIGNATURE_VALUES, ...LEGACY_PRODUCT_VALUES])].sort()
);

export function identityScope(paths) {
    return paths
        .filter(
            (path) =>
                /^(?:tools|examples)\/.+\.mjs$/.test(path) &&
                !path.endsWith('.test.mjs') &&
                !IDENTITY_SOURCES.includes(path)
        )
        .sort();
}

export function hardcodedValues(text, values = IDENTITY_VALUES) {
    const found = [];
    for (const [index, line] of text.split('\n').entries()) {
        for (const value of values) {
            if (line.includes(value)) found.push({ line: index + 1, value });
        }
    }
    return found;
}

export function verifyIdentitySources(root = ROOT, values = IDENTITY_VALUES) {
    const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
        encoding: 'utf8',
    })
        .split('\0')
        .filter(Boolean);
    const files = identityScope(tracked);
    const errors = [];
    if (values.length === 0)
        errors.push(
            'aucune valeur exportée par les sources uniques — contrôle cassé'
        );
    if (files.length === 0)
        errors.push('aucun fichier dans le périmètre — balayage cassé');
    for (const file of files) {
        const text = readFileSync(join(root, file), 'utf8');
        for (const { line, value } of hardcodedValues(text, values)) {
            errors.push(
                `${file}:${line} : ${JSON.stringify(value)} écrit en dur ; passer par ${IDENTITY_SOURCES.join(' ou ')}`
            );
        }
    }
    return { ok: errors.length === 0, files: files.length, values, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const result = verifyIdentitySources();
    if (!result.ok) {
        console.error('\n❌ Signature ou préfixe écrits en dur :');
        for (const error of result.errors) console.error(`  - ${error}`);
        process.exitCode = 1;
    } else {
        console.log(
            `✔ check:identity-sources — ${result.files} fichier(s) balayé(s), ${result.values.length} valeur(s) dérivée(s), aucune écrite en dur.`
        );
    }
}

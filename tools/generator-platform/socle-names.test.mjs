// Lot 2, commit 1 : les noms FIXES émis dans le produit (`socle-names.mjs`)
// ne sont jamais des formes du préfixe, et leurs portées d'alias ne masquent
// aucun paquet du catalogue ni de la coque (conception v3 V3.4 point 8, v4
// §V4.1 et §V4.2).
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
    PREFIX_PATTERN,
    PRODUCT_NAME_FAMILIES,
    prefixRefusals,
    productForms,
} from './core/product-identity.mjs';
import {
    ALIAS_SCOPES,
    FIXED_NAMES,
    INTERFACE_ALIAS,
    ROOT_PATH_ALIASES,
    SAMPLE_EMAIL,
    SAMPLE_TEXT,
    SOCLE_ALIAS,
    socleCoqueAlias,
} from './core/socle-names.mjs';
import { SHELL_PACKAGES } from './renderers/application-workspace-renderer.mjs';
import { TOOLS_ROOT } from './test-support/external-application-fixture.mjs';
import { DISTINCTIVE_PREFIX } from './test-support/distinctive-prefix.mjs';

test('aucun nom fixe ne correspond à une famille de noms du produit', () => {
    for (const name of [...FIXED_NAMES, socleCoqueAlias('observatory')])
        for (const [family, source] of Object.entries(PRODUCT_NAME_FAMILIES))
            assert.doesNotMatch(
                name,
                new RegExp(source),
                `${name} : ${family}`
            );
});

// C-A6 (V5.3) : les DEUX valeurs d'exemple ne portent aucun segment `<p>-` ou
// `<p>_` où `<p>` est un préfixe LÉGAL (motif construit depuis
// `PREFIX_PATTERN.source`, sans liste) : aucune ne peut être lue comme une
// forme d'un préfixe. Ne vaut pas pour les alias (`@socle-coque/`, préfixe
// légal `socle` admis par la v4 §V4.1) : ils restent couverts par « aucune
// famille ».
test('C-A6 : aucune valeur d’exemple ne porte un segment préfixe-tiret ou préfixe-souligné', () => {
    const body = PREFIX_PATTERN.source.replace(/^\^/, '').replace(/\$$/, '');
    const segment = new RegExp(`\\b${body}[-_]`);
    assert.ok(segment.test('abc-exemple'), 'contre-preuve du motif');
    assert.ok(segment.test('qz_upstream'), 'contre-preuve du motif');
    for (const value of [SAMPLE_EMAIL, SAMPLE_TEXT])
        assert.doesNotMatch(value, segment, value);
});

test('le préfixe de banc distinctif est admis et absent de tout nom fixe', () => {
    assert.deepEqual(prefixRefusals(DISTINCTIVE_PREFIX), []);
    for (const form of Object.values(productForms(DISTINCTIVE_PREFIX)))
        assert.ok(
            form.toLowerCase().includes(DISTINCTIVE_PREFIX),
            `toute forme du préfixe porte sa chaîne : ${form}`
        );
    for (const name of FIXED_NAMES)
        assert.ok(
            !name.toLowerCase().includes(DISTINCTIVE_PREFIX),
            `${name} contient ${DISTINCTIVE_PREFIX}`
        );
});

test('deux motifs racine fixes, une étoile chacun, sans nom d’appli', () => {
    assert.deepEqual(Object.keys(ROOT_PATH_ALIASES), [
        SOCLE_ALIAS,
        INTERFACE_ALIAS,
    ]);
    for (const [key, targets] of Object.entries(ROOT_PATH_ALIASES)) {
        assert.equal(key.split('*').length, 2, key);
        assert.equal(targets.length, 1, key);
        assert.equal(targets[0].split('*').length, 2, targets[0]);
    }
    assert.equal(socleCoqueAlias('observatory').includes('*'), false);
});

async function catalogPackages() {
    const root = join(TOOLS_ROOT, 'conventions/libraries');
    const packages = [];
    for (const platform of await readdir(root, { withFileTypes: true })) {
        if (!platform.isDirectory()) continue;
        for (const name of await readdir(join(root, platform.name)))
            if (name.endsWith('.setup.json'))
                packages.push(
                    ...JSON.parse(
                        await readFile(join(root, platform.name, name), 'utf8')
                    ).packages
                );
    }
    return packages;
}

test('les portées des alias ne masquent aucun paquet du catalogue ni de la coque', async () => {
    const catalog = await catalogPackages();
    assert.ok(catalog.length > 0, 'catalogue lu');
    const shell = Object.values(SHELL_PACKAGES).flatMap((group) => [
        ...group.dependencies,
        ...group.devDependencies,
    ]);
    for (const name of [...catalog, ...shell])
        for (const scope of ALIAS_SCOPES)
            assert.ok(
                !name.startsWith(scope),
                `${name} est masqué par ${scope}`
            );
});

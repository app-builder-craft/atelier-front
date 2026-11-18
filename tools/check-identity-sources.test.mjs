// check:identity-sources : chaque valeur exportée par les sources uniques,
// réécrite en dur dans un fichier du périmètre, est refusée et nommée ; le
// périmètre et les valeurs sont dérivés ; un périmètre ou des valeurs vides
// font échouer le contrôle. Les valeurs viennent des modules : ce fichier
// n'en écrit aucune.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
    hardcodedValues,
    IDENTITY_SOURCES,
    IDENTITY_VALUES,
    identityScope,
    verifyIdentitySources,
} from './check-identity-sources.mjs';
import {
    INTERNAL,
    SIGNATURE,
    SIGNATURE_FILES,
    signatureGlobal,
    signatureIdentifier,
    signatureName,
    signaturePath,
    toolEnv,
} from './generator-platform/core/atelier-signature.mjs';

async function repository(t, files) {
    const root = await mkdtemp(join(tmpdir(), 'identity-sources-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', root]);
    for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
    }
    execFileSync('git', ['-C', root, 'add', '-A']);
    return root;
}

test('les valeurs refusées couvrent chaque famille de la signature', () => {
    for (const value of [
        SIGNATURE.dir,
        SIGNATURE.dataAttribute,
        SIGNATURE.generator,
        SIGNATURE.openapiExtension,
        SIGNATURE.postmanVariable,
        SIGNATURE.gitRefs,
        INTERNAL.scope,
        INTERNAL.env,
    ])
        assert.ok(IDENTITY_VALUES.includes(value), value);
    assert.ok(!IDENTITY_VALUES.includes(SIGNATURE.name), 'nom nu exclu');
    assert.ok(
        IDENTITY_VALUES.every((value) => value.length > SIGNATURE.name.length)
    );
});

test('les formes composées passent par les modules et ont les valeurs attendues', () => {
    assert.equal(signaturePath('a', 'b'), `${SIGNATURE.dir}/a/b`);
    assert.equal(
        SIGNATURE_FILES.appManifest,
        `${SIGNATURE.dir}/app-manifest.json`
    );
    assert.equal(signatureName('x'), `${SIGNATURE.name}-x`);
    assert.equal(toolEnv('X'), `${INTERNAL.env}X`);
    assert.equal(SIGNATURE.idAttribute, `${SIGNATURE.dataAttribute}id`);
    assert.equal(signatureIdentifier('X'), `${SIGNATURE.name}X`);
    assert.equal(signatureGlobal('X'), `__${SIGNATURE.name}X`);
});

test('chaque valeur réécrite en dur est refusée, nommée, avec sa ligne', async (t) => {
    for (const value of IDENTITY_VALUES) {
        const root = await repository(t, {
            'tools/clean.mjs': 'export const ok = 1;\n',
            'tools/x/y.mjs': `// ligne 1\nexport const p = ${JSON.stringify(value)};\n`,
        });
        const result = verifyIdentitySources(root);
        assert.equal(result.ok, false, value);
        assert.ok(
            result.errors.some((error) =>
                error.startsWith(
                    `tools/x/y.mjs:2 : ${JSON.stringify(value)} écrit en dur`
                )
            ),
            `${value} : ${result.errors.join(' | ')}`
        );
    }
});

test('périmètre dérivé : tools et examples en .mjs suivis, hors tests et sources', async (t) => {
    const value = IDENTITY_VALUES[0];
    const line = `export const p = ${JSON.stringify(value)};\n`;
    const root = await repository(t, {
        'tools/clean.mjs': 'export const ok = 1;\n',
        'tools/a.test.mjs': line,
        [IDENTITY_SOURCES[0]]: line,
        [IDENTITY_SOURCES[1]]: line,
        'tools/notes.md': line,
        'apps/x/main.mjs': line,
        'examples/demo/render.mjs': line,
    });
    await writeFile(join(root, 'tools/untracked.mjs'), line);
    const result = verifyIdentitySources(root);
    assert.deepEqual(
        result.errors.map((error) => error.split(' : ')[0]),
        ['examples/demo/render.mjs:1']
    );
    assert.equal(result.files, 2);
    assert.deepEqual(
        identityScope([
            'tools/b.mjs',
            'tools/a.test.mjs',
            'examples/a.mjs',
            'docs/x.mjs',
        ]),
        ['examples/a.mjs', 'tools/b.mjs']
    );
});

test('fermé par défaut : périmètre vide ou valeurs vides refusés ; propre accepté', async (t) => {
    const empty = await repository(t, { 'docs/readme.md': 'x\n' });
    assert.deepEqual(verifyIdentitySources(empty).errors, [
        'aucun fichier dans le périmètre — balayage cassé',
    ]);
    const clean = await repository(t, {
        'tools/clean.mjs': 'export const ok = 1;\n',
    });
    assert.deepEqual(verifyIdentitySources(clean).errors, []);
    assert.deepEqual(verifyIdentitySources(clean, []).errors, [
        'aucune valeur exportée par les sources uniques — contrôle cassé',
    ]);
    assert.deepEqual(hardcodedValues('a\nb', ['b']), [{ line: 2, value: 'b' }]);
});

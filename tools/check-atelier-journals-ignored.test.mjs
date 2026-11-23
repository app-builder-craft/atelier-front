// Contrôle des journaux d'outil : la liste vient des appels
// `signaturePath('<nom>'…)` des outils (décision A du lot MARQUE). Un fichier
// n'est pas un répertoire de journal (CI de la PR #389 : `escape.txt` lu comme
// `escape/`) ; un vrai répertoire reste détecté ; un scan vide échoue ; les
// deux journaux connus du dépôt sont trouvés (témoin positif). Les valeurs de
// signature viennent du module : ce fichier n'en écrit aucune.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    signatureDirectoryNames,
    scanSignatureDirectories,
    verifySignatureJournalsIgnored,
} from './check-atelier-journals-ignored.mjs';
import {
    retiredAppTombstone,
    SIGNATURE,
    SIGNATURE_FILES,
} from './generator-platform/core/atelier-signature.mjs';

const call = (...names) =>
    `signaturePath(${names.map((name) => `'${name}'`).join(', ')})`;

test('un fichier sous le dossier de signature n’est pas pris pour un répertoire', () => {
    assert.deepEqual(
        signatureDirectoryNames(`writeFileSync(${call('escape.txt')}, 'x')`),
        []
    );
    assert.deepEqual(
        signatureDirectoryNames('signaturePath(`escape.tar.gz`)'),
        []
    );
    assert.deepEqual(signatureDirectoryNames(call('escape_x')), []);
    assert.deepEqual(signatureDirectoryNames(call('escapeX')), []);
});

test('un vrai répertoire reste détecté, quelle que soit la mise en forme', () => {
    assert.deepEqual(signatureDirectoryNames(call('escape')), ['escape']);
    assert.deepEqual(
        signatureDirectoryNames('signaturePath("escape", `${id}.json`)'),
        ['escape']
    );
    assert.deepEqual(
        signatureDirectoryNames(
            "signaturePath(\n    'a-b'\n);\njoin(root, signaturePath('c', x))"
        ),
        ['a-b', 'c']
    );
});

test('le gabarit du dossier de signature est aussi une source de journaux', () => {
    const template = (rest) => '`$' + '{SIGNATURE.dir}/' + rest + '`';
    assert.deepEqual(signatureDirectoryNames(template('journal-x')), [
        'journal-x',
    ]);
    assert.deepEqual(
        signatureDirectoryNames(template('journal-x/${id}.json')),
        ['journal-x']
    );
    assert.deepEqual(signatureDirectoryNames(template('escape.txt')), []);
    assert.deepEqual(signatureDirectoryNames(template('${name}/probe')), []);
});

test('un chemin écrit en dur n’est plus une source de journaux', () => {
    assert.deepEqual(signatureDirectoryNames(`'${SIGNATURE.dir}/escape'`), []);
});

async function repository(t, files) {
    const root = await mkdtemp(join(tmpdir(), 'journals-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', root]);
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(root, path, '..'), { recursive: true });
        await writeFile(join(root, path), content);
    }
    return root;
}

test('journal non ignoré signalé, ignoré accepté, scan vide signalé', async (t) => {
    const tool = { 'tools/x.mjs': `export const p = ${call('journal-x')};\n` };
    const bare = await repository(t, tool);
    assert.deepEqual(verifySignatureJournalsIgnored(bare).errors, [
        `${SIGNATURE.dir}/journal-x/ n'est pas ignoré par Git : ce journal salirait le dépôt et ferait échouer la publication`,
    ]);
    const ignored = await repository(t, {
        ...tool,
        '.gitignore': `/${SIGNATURE.dir}/journal-x/\n`,
    });
    assert.deepEqual(verifySignatureJournalsIgnored(ignored), {
        ok: true,
        names: ['journal-x'],
        errors: [],
    });
    const fileOnly = await repository(t, {
        'tools/x.mjs': `export const p = ${call('escape.txt')};\n`,
    });
    assert.deepEqual(verifySignatureJournalsIgnored(fileOnly).errors, [
        `aucun journal ${SIGNATURE.dir} détecté — scan cassé`,
    ]);
    // Un test porte des noms d'exemple : il n'est jamais balayé.
    const testOnly = await repository(t, {
        'tools/x.test.mjs': `export const p = ${call('journal-x')};\n`,
    });
    assert.deepEqual(verifySignatureJournalsIgnored(testOnly).errors, [
        `aucun journal ${SIGNATURE.dir} détecté — scan cassé`,
    ]);
});

// Les dossiers que la signature exporte (`SIGNATURE_FILES`), pierres tombales
// de `retire-app` comprises (Q3 du lot MARQUE), sont versionnés : jamais lus
// comme des journaux, même appelés par `signaturePath('<nom>')`.
test('les dossiers gouvernés de la signature ne sont pas des journaux', async (t) => {
    const governed = [
        ...Object.values(SIGNATURE_FILES),
        retiredAppTombstone('x'),
    ].map((path) => path.slice(SIGNATURE.dir.length + 1).split(/[/.]/)[0]);
    assert.ok(governed.includes('retired-apps'));
    const root = await repository(t, {
        'tools/x.mjs': [...governed, 'journal-x']
            .map(
                (name) =>
                    `export const p_${name.replaceAll('-', '_')} = ${call(name)};\n`
            )
            .join(''),
        '.gitignore': `/${SIGNATURE.dir}/journal-x/\n`,
    });
    assert.deepEqual(verifySignatureJournalsIgnored(root), {
        ok: true,
        names: ['journal-x'],
        errors: [],
    });
});

test('témoin positif : les deux journaux connus du dépôt sont trouvés', () => {
    assert.deepEqual(scanSignatureDirectories(), [
        'retire-app-transactions',
        'retire-module-transactions',
    ]);
});

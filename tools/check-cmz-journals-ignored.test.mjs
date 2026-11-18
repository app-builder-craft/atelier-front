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
    cmzDirectoryNames,
    scanCmzDirectories,
    verifyCmzJournalsIgnored,
} from './check-cmz-journals-ignored.mjs';
import { SIGNATURE } from './generator-platform/core/atelier-signature.mjs';

const call = (...names) =>
    `signaturePath(${names.map((name) => `'${name}'`).join(', ')})`;

test('un fichier sous le dossier de signature n’est pas pris pour un répertoire', () => {
    assert.deepEqual(
        cmzDirectoryNames(`writeFileSync(${call('escape.txt')}, 'x')`),
        []
    );
    assert.deepEqual(cmzDirectoryNames('signaturePath(`escape.tar.gz`)'), []);
    assert.deepEqual(cmzDirectoryNames(call('escape_x')), []);
    assert.deepEqual(cmzDirectoryNames(call('escapeX')), []);
});

test('un vrai répertoire reste détecté, quelle que soit la mise en forme', () => {
    assert.deepEqual(cmzDirectoryNames(call('escape')), ['escape']);
    assert.deepEqual(
        cmzDirectoryNames('signaturePath("escape", `${id}.json`)'),
        ['escape']
    );
    assert.deepEqual(
        cmzDirectoryNames(
            "signaturePath(\n    'a-b'\n);\njoin(root, signaturePath('c', x))"
        ),
        ['a-b', 'c']
    );
});

test('un chemin écrit en dur n’est plus une source de journaux', () => {
    assert.deepEqual(cmzDirectoryNames(`'${SIGNATURE.dir}/escape'`), []);
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
    assert.deepEqual(verifyCmzJournalsIgnored(bare).errors, [
        `${SIGNATURE.dir}/journal-x/ n'est pas ignoré par Git : ce journal salirait le dépôt et ferait échouer la publication`,
    ]);
    const ignored = await repository(t, {
        ...tool,
        '.gitignore': `/${SIGNATURE.dir}/journal-x/\n`,
    });
    assert.deepEqual(verifyCmzJournalsIgnored(ignored), {
        ok: true,
        names: ['journal-x'],
        errors: [],
    });
    const fileOnly = await repository(t, {
        'tools/x.mjs': `export const p = ${call('escape.txt')};\n`,
    });
    assert.deepEqual(verifyCmzJournalsIgnored(fileOnly).errors, [
        `aucun journal ${SIGNATURE.dir} détecté — scan cassé`,
    ]);
    // Un test porte des noms d'exemple : il n'est jamais balayé.
    const testOnly = await repository(t, {
        'tools/x.test.mjs': `export const p = ${call('journal-x')};\n`,
    });
    assert.deepEqual(verifyCmzJournalsIgnored(testOnly).errors, [
        `aucun journal ${SIGNATURE.dir} détecté — scan cassé`,
    ]);
});

test('témoin positif : les deux journaux connus du dépôt sont trouvés', () => {
    assert.deepEqual(scanCmzDirectories(), [
        'retire-app-transactions',
        'retire-module-transactions',
    ]);
});

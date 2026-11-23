import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    lockfileOf,
    productLockfiles,
    RETIRED_NAME,
    retiredFindings,
    staticFindings,
    treeFindings,
    withoutIntegrity,
} from './check-retired-name.mjs';
import { signatureName } from './generator-platform/core/atelier-signature.mjs';

// Le motif n'est jamais écrit dans ce fichier : il vient du contrôle, et ses
// formes sont composées ici, à l'exécution.
const M = RETIRED_NAME;
const UPPER = M.toUpperCase();

async function scratch(t) {
    const root = await mkdtemp(
        join(tmpdir(), signatureName('retired-name-test-'))
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

// Dépôt jetable : fichiers suivis par `git add`, sans commit ni hook.
async function repository(t, files, packageManager = 'bun@1.4.4') {
    const root = await scratch(t);
    await writeFile(
        join(root, 'package.json'),
        `${JSON.stringify({ name: 'sonde', packageManager })}\n`
    );
    for (const [path, content] of Object.entries(files)) {
        await mkdir(join(root, path, '..'), { recursive: true });
        await writeFile(join(root, path), content);
    }
    const git = (...args) =>
        execFileSync(
            'git',
            ['-c', 'init.defaultBranch=main', '-C', root, ...args],
            {
                env: {
                    PATH: process.env.PATH,
                    HOME: root,
                    GIT_CONFIG_NOSYSTEM: '1',
                },
            }
        );
    git('init', '--quiet');
    git('add', '--all');
    return root;
}

test('le motif est composé, en minuscules, et ce fichier ne le contient pas en clair', () => {
    assert.match(M, /^[a-z]{3}$/);
    const own = readFileSync(new URL(import.meta.url));
    assert.deepEqual(retiredFindings('check-retired-name.test.mjs', own), []);
});

test('chaque forme d’un préfixe est trouvée, sans casse et collée à un mot', () => {
    const forms = [
        `@${M}/core`,
        `${M}-sw`,
        `${M}_relay_guard`,
        `${UPPER}_UPSTREAM_`,
        `window.__${M}AppAccessContext`,
        `/etc/nginx/${M}/`,
        `.${M}/app-manifest.json`,
        `${M.slice(0, 1).toUpperCase()}${M.slice(1)} Platform`,
    ];
    const text = ['neutre', ...forms].join('\n');
    assert.deepEqual(
        retiredFindings('a.txt', Buffer.from(text)),
        forms.map((_, index) => `a.txt:${index + 2}`)
    );
    assert.deepEqual(
        retiredFindings(
            'a.txt',
            Buffer.from('atelier @atelier/core ATELIER_X')
        ),
        []
    );
});

test('un chemin est jugé ; un contenu binaire ne l’est que par son chemin', () => {
    assert.deepEqual(
        retiredFindings(`docs/${M}-guide.md`, Buffer.from('neutre')),
        [`docs/${M}-guide.md (chemin)`]
    );
    const binary = Buffer.concat([
        Buffer.from(M),
        Buffer.from([0]),
        Buffer.from(M),
    ]);
    assert.deepEqual(retiredFindings('image.png', binary), []);
    assert.deepEqual(retiredFindings(`${M}.png`, binary), [
        `${M}.png (chemin)`,
    ]);
    assert.deepEqual(retiredFindings(`${M}/a`, undefined), [`${M}/a (chemin)`]);
});

test('le verrou est déduit de packageManager ; un autre gestionnaire est refusé', () => {
    assert.equal(lockfileOf({ packageManager: 'bun@1.4.4' }), 'bun.lock');
    for (const packageManager of [
        'npm@11.0.0',
        'pnpm@10.0.0',
        'yarn@4.0.0',
        'bun',
        undefined,
    ])
        assert.throws(
            () => lockfileOf({ packageManager }),
            /gestionnaire de paquets non pris en charge/
        );
});

test('statique : fichiers suivis, chemins compris ; le verrou déduit est jugé hors ses seules valeurs d’intégrité', async (t) => {
    const root = await repository(t, {
        'bun.lock': `{\n  "name": "@${M}/source",\n  "a": ["a@1.0.0", "", {}, "sha512-x${UPPER}y="],\n}\n`,
        'yarn.lock': `${M}\n`,
        'README.md': `# titre\nnom ${UPPER}_X\n`,
        [`.agents/skills/${M}-steward/SKILL.md`]: 'neutre\n',
        'logo.png': Buffer.concat([Buffer.from(M), Buffer.from([0])]),
        'propre.mjs': 'export const x = 1;\n',
    });
    await writeFile(join(root, 'non-suivi.txt'), `${M}\n`);
    const result = staticFindings(root);
    assert.equal(result.lockfile, 'bun.lock');
    assert.equal(result.scanned, 7);
    assert.deepEqual(
        result.findings.sort(),
        [
            `.agents/skills/${M}-steward/SKILL.md (chemin)`,
            'README.md:2',
            'bun.lock:2',
            'yarn.lock:1',
        ].sort()
    );
    assert.equal(result.whitened, 1);
});

test('statique : un lien symbolique est jugé sur sa cible écrite', async (t) => {
    const root = await repository(t, { 'propre.txt': 'neutre\n' });
    await symlink(`../${M}/cible`, join(root, 'lien'));
    execFileSync('git', ['-C', root, 'add', 'lien'], {
        env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.deepEqual(staticFindings(root).findings, ['lien:1']);
});

test('statique : fermé sans fichier suivi ou sans gestionnaire pris en charge', async (t) => {
    const empty = await scratch(t);
    execFileSync(
        'git',
        ['-c', 'init.defaultBranch=main', '-C', empty, 'init', '--quiet'],
        {
            env: {
                PATH: process.env.PATH,
                HOME: empty,
                GIT_CONFIG_NOSYSTEM: '1',
            },
        }
    );
    assert.throws(() => staticFindings(empty), /aucun fichier suivi/);
    const other = await repository(t, { 'a.txt': 'neutre\n' }, 'npm@11.0.0');
    assert.throws(
        () => staticFindings(other),
        /gestionnaire de paquets non pris en charge/
    );
});

test('arbre entier : entrées cachées, noms, contenus et liens', async (t) => {
    const root = await scratch(t);
    await mkdir(join(root, '.generation-transaction-x', 'apps'), {
        recursive: true,
    });
    await writeFile(
        join(root, '.generation-transaction-x', 'apps', 'journal.json'),
        `{"note": "${UPPER}"}\n`
    );
    await mkdir(join(root, 'produit', `.${M}`), { recursive: true });
    await writeFile(join(root, 'produit', 'propre.txt'), 'neutre\n');
    await writeFile(join(root, 'produit', `${M}-sw.js`), 'neutre\n');
    await symlink(`/etc/nginx/${M}/`, join(root, 'produit', 'lien'));
    const result = await treeFindings(root);
    assert.equal(result.scanned, 8);
    assert.deepEqual(
        result.findings.sort(),
        [
            '.generation-transaction-x/apps/journal.json:1',
            `produit/.${M} (chemin)`,
            `produit/${M}-sw.js (chemin)`,
            'produit/lien:1',
        ].sort()
    );
    const clean = await scratch(t);
    await writeFile(join(clean, '.cache'), 'neutre\n');
    assert.deepEqual((await treeFindings(clean)).findings, []);
});

test('produits sonde : le verrou de CHAQUE produit, reconnu par son packageManager, est jugé hors ses seules valeurs d’intégrité', async (t) => {
    const root = await scratch(t);
    for (const [product, packageManager] of [
        ['p', 'bun@1.4.4'],
        ['q', 'npm@11.0.0'],
    ]) {
        await mkdir(join(root, product));
        await writeFile(
            join(root, product, 'package.json'),
            `${JSON.stringify({ name: `@sonde/${product}`, packageManager })}\n`
        );
    }
    // Les faux positifs réels : une intégrité SRI dont le base64 porte le motif.
    await writeFile(
        join(root, 'p', 'bun.lock'),
        `{\n  "packages": {\n    "a": ["a@1.0.0", "", {}, "sha512-ab${UPPER}x+/9=="],\n    "b": ["b@1.0.0", "", {}, "sha384-${M}Q"],\n  }\n}\n`
    );
    await writeFile(join(root, 'p', 'yarn.lock'), `${M}\n`);
    const lockfiles = await productLockfiles(root, ['p']);
    assert.deepEqual(lockfiles, ['p/bun.lock']);
    const clean = await treeFindings(root, lockfiles);
    assert.deepEqual(clean.findings, ['p/yarn.lock:1']);
    assert.equal(clean.whitened, 2);
    assert.deepEqual((await treeFindings(root)).findings.sort(), [
        'p/bun.lock:3',
        'p/bun.lock:4',
        'p/yarn.lock:1',
    ]);
    // Un vrai nom à l’ancien nom dans le verrou d’un produit est refusé.
    await writeFile(
        join(root, 'p', 'bun.lock'),
        `{\n  "workspaces": {\n    "": { "name": "@${M}/source" },\n  },\n  "packages": {\n    "@${M}/x": ["@${M}/x@1.0.0", "", {}, "sha512-abc="],\n  }\n}\n`
    );
    assert.deepEqual((await treeFindings(root, lockfiles)).findings, [
        'p/bun.lock:3',
        'p/bun.lock:6',
        'p/yarn.lock:1',
    ]);
    await assert.rejects(
        productLockfiles(root, ['p', 'q']),
        /gestionnaire de paquets non pris en charge/
    );
});

test('intégrité : seules des chaînes JSON entières de la grammaire SRI sont blanchies', () => {
    const text = [
        `"sha512-${M}AA=="`,
        `"sha256-x${UPPER}"`,
        `"note sha512-${M}AA=="`,
        `"sha1-${M}AA=="`,
        `"sha512-${M}"x`,
        `sha512-${M}AA==`,
    ].join('\n');
    const { bytes, carried } = withoutIntegrity(Buffer.from(text));
    assert.equal(carried, 3);
    assert.deepEqual(retiredFindings('v.lock', bytes), [
        'v.lock:3',
        'v.lock:4',
        'v.lock:6',
    ]);
});

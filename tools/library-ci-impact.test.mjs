import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
    changedPathsSince,
    classifyLibraryCiImpact,
    COMMON_EXACT_INPUTS,
    INTEGRATION_EXACT_INPUTS,
    ISOLATION_EXACT_INPUTS,
} from './library-ci-impact.mjs';

const NONE = {
    isolation: false,
    integration: false,
    reasons: { isolation: [], integration: [] },
};

describe('impact CI des preuves bibliothèque', () => {
    it('garde seulement le contrat rapide pour une PR applicative ou documentaire', () => {
        assert.deepEqual(
            classifyLibraryCiImpact([
                'apps/demo-angular/src/app/app.ts',
                'docs/proprietaire/atelier.md',
                'libs/demo/ui/src/lib/demo.component.ts',
            ]),
            NONE
        );
    });

    it('active les deux preuves pour chaque entrée commune', () => {
        for (const path of COMMON_EXACT_INPUTS) {
            const result = classifyLibraryCiImpact([path]);
            assert.equal(result.isolation, true, path);
            assert.equal(result.integration, true, path);
            assert.deepEqual(result.reasons, {
                isolation: [path],
                integration: [path],
            });
        }
    });

    it('active isolation et E2E pour toute la fermeture du confinement', () => {
        for (const path of ISOLATION_EXACT_INPUTS) {
            const result = classifyLibraryCiImpact([path]);
            assert.equal(result.isolation, true, path);
            assert.equal(result.integration, true, path);
        }
    });

    it('active seulement l’E2E pour chaque entrée propre à l’intégration', () => {
        for (const path of INTEGRATION_EXACT_INPUTS.filter(
            (candidate) => !ISOLATION_EXACT_INPUTS.includes(candidate)
        )) {
            const result = classifyLibraryCiImpact([path]);
            assert.equal(result.isolation, false, path);
            assert.equal(result.integration, true, path);
            assert.deepEqual(result.reasons.integration, [path]);
        }
    });

    it('couvre automatiquement toute nouvelle recette, matrice ou source du moteur', () => {
        for (const path of [
            'conventions/libraries/angular/new-library.setup.json',
            'conventions/libraries/angular/new-library.compat.json',
            'designs/future-application.application-design.json',
            'examples/application-conception-proof/future-contract.json',
            'tools/library-setup/new-runtime-proof.mjs',
            'tools/library-setup/runtime-fixtures/new-probe.ts',
        ]) {
            const result = classifyLibraryCiImpact([path]);
            assert.equal(result.integration, true, path);
        }
    });

    it('ne confond pas des chemins voisins avec la surface gouvernée', () => {
        assert.deepEqual(
            classifyLibraryCiImpact([
                'docs/conventions/libraries/example.md',
                'tools/library-setup-old/sandbox.mjs',
                'package.json.md',
            ]),
            NONE
        );
    });

    it('déduplique et trie les raisons pour un diagnostic déterministe', () => {
        assert.deepEqual(
            classifyLibraryCiImpact([
                'tools/create-app.mjs',
                'bun.lock',
                'tools/create-app.mjs',
            ]),
            {
                isolation: true,
                integration: true,
                reasons: {
                    isolation: ['bun.lock'],
                    integration: ['bun.lock', 'tools/create-app.mjs'],
                },
            }
        );
    });
});

// Détection de la base d'un push, lue telle quelle dans `ci.yml` (une seule
// forme, aux quatre endroits), puis exécutée par `/bin/sh -e`.
const PARENT_FORM = (() => {
    const lines = readFileSync(
        new URL('../.github/workflows/ci.yml', import.meta.url),
        'utf8'
    )
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('if git cat-file -p HEAD'));
    // Deux sélecteurs d'impact bibliothèque et deux `NX_BASE`.
    assert.equal(lines.length, 4, 'détection du parent aux quatre endroits');
    assert.equal(new Set(lines).size, 1, 'une seule forme de détection');
    return lines[0];
})();
const ciBase = (cwd) =>
    execFileSync('/bin/sh', ['-ec', `${PARENT_FORM}\nprintf %s "$base"`], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });

// Dépôt jetable : commit racine, puis une branche qui avance pendant que
// `main` avance aussi.
function repository(t) {
    const root = mkdtempSync(join(tmpdir(), 'library-ci-base-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args) =>
        execFileSync('git', args, {
            cwd: root,
            encoding: 'utf8',
            env: {
                PATH: process.env.PATH,
                HOME: root,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_AUTHOR_NAME: 'fixture',
                GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
                GIT_COMMITTER_NAME: 'fixture',
                GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
            },
        }).trim();
    const commit = (path, message) => {
        writeFileSync(join(root, path), `${message}\n`);
        git('add', path);
        git('commit', '-q', '-m', message);
    };
    git('init', '-q', '-b', 'main');
    return { root, git, commit };
}

describe('base du diff de la CI', () => {
    it('commit sans parent : la forme de la CI rend l’arbre vide, et tout le contenu est changé', (t) => {
        const { root, git, commit } = repository(t);
        commit('a.txt', 'racine');
        commit('b.txt', 'racine-bis');
        git('checkout', '-q', '--orphan', 'reset');
        // Commit racine : même arbre, sans parent, comme un `main` réécrit.
        git('commit', '-q', '-m', 'orphelin');
        assert.throws(() => git('rev-parse', '--verify', '-q', 'HEAD~1'));
        const base = ciBase(root);
        assert.equal(base, git('hash-object', '-t', 'tree', '/dev/null'));
        assert.equal(git('cat-file', '-t', base), 'tree');
        assert.deepEqual(changedPathsSince(base, { cwd: root }), [
            'a.txt',
            'b.txt',
        ]);
        // La forme `base...HEAD` ne vaut que pour un commit : refusée par Git.
        assert.throws(() => git('diff', '--name-only', `${base}...HEAD`));
    });

    it('commit avec parent : même résultat que `base...HEAD`, branche comprise', (t) => {
        const { root, git, commit } = repository(t);
        commit('a.txt', 'racine');
        git('checkout', '-q', '-b', 'branche');
        commit('branche.txt', 'branche');
        git('checkout', '-q', 'main');
        commit('main.txt', 'main avance');
        git('checkout', '-q', 'branche');
        const threeDots = (base) =>
            git('diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`)
                .split('\0')
                .filter(Boolean);
        for (const base of ['main', 'HEAD~1']) {
            assert.deepEqual(
                changedPathsSince(base, { cwd: root }),
                threeDots(base),
                base
            );
            assert.deepEqual(changedPathsSince(base, { cwd: root }), [
                'branche.txt',
            ]);
        }
    });

    it('commit avec parent : la forme de la CI rend le parent', (t) => {
        const { root, git, commit } = repository(t);
        commit('a.txt', 'racine');
        commit('b.txt', 'second');
        assert.equal(ciBase(root), git('rev-parse', 'HEAD~1'));
    });

    it('clone peu profond d’un commit qui a un parent : la forme de la CI échoue bruyamment', (t) => {
        const { root, commit } = repository(t);
        commit('a.txt', 'racine');
        commit('b.txt', 'second');
        const shallow = join(root, 'peu-profond');
        execFileSync('git', [
            'clone',
            '-q',
            '--depth',
            '1',
            `file://${root}`,
            shallow,
        ]);
        // Le parent est dans l'objet commit, mais absent du clone.
        assert.match(
            execFileSync('git', ['cat-file', '-p', 'HEAD'], {
                cwd: shallow,
                encoding: 'utf8',
            }),
            /^parent [0-9a-f]{40}$/m
        );
        assert.throws(() => ciBase(shallow), { status: 128 });
        // Témoin : l'ancienne forme y retombait en silence sur l'arbre vide.
        assert.equal(
            execFileSync(
                '/bin/sh',
                [
                    '-c',
                    'git rev-parse --verify -q HEAD~1 || git hash-object -t tree /dev/null',
                ],
                { cwd: shallow, encoding: 'utf8' }
            ).trim(),
            '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
        );
    });

    it('révision invalide : échec, sans repli', (t) => {
        const { root, commit } = repository(t);
        commit('a.txt', 'racine');
        for (const base of ['', '--all', 'absente', 'HEAD~1'])
            assert.throws(
                () => changedPathsSince(base, { cwd: root }),
                Error,
                base
            );
    });
});

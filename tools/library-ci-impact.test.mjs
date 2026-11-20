import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { parse as parseYaml } from 'yaml';

import { evaluateTemplate } from './check-branch-protection-contexts.mjs';

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

// File de fusion : les étapes qui calculent la base sont exécutées telles
// quelles (`bash -e`, comme le shell par défaut de GitHub), avec
// l'environnement que GitHub leur donne : leurs expressions `env` sont
// évaluées sur le contexte de l'événement, et GITHUB_EVENT_NAME est posé.
// Elles sont dérivées de `ci.yml` : toute étape qui publie une base
// (`NX_BASE=` ou `library-ci-impact.mjs --base`) doit suivre la forme commune.
const BASE_STEPS = (() => {
    const ci = parseYaml(
        readFileSync(
            new URL('../.github/workflows/ci.yml', import.meta.url),
            'utf8'
        )
    );
    const all = Object.entries(ci.jobs).flatMap(([job, { steps = [] }]) =>
        steps.map((step) => ({ job, step }))
    );
    const producers = all.filter(({ step }) =>
        /NX_BASE=|library-ci-impact\.mjs --base/.test(step.run ?? '')
    );
    const steps = all.filter(({ step }) =>
        step.run?.split('\n').some((l) => l.trim() === PARENT_FORM)
    );
    assert.ok(producers.length > 0, 'aucune étape ne publie de base');
    assert.deepEqual(steps, producers, 'producteur de base hors forme commune');
    return steps;
})();

// Ce que l'étape publie : `base=` (sélecteur bibliothèque) ou `NX_BASE=`.
function runBaseStep(t, { step }, cwd, github, shell = ['-e']) {
    const out = mkdtempSync(join(tmpdir(), 'ci-base-out-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    const files = {
        GITHUB_ENV: join(out, 'env'),
        GITHUB_OUTPUT: join(out, 'output'),
    };
    const env = Object.fromEntries(
        Object.entries(step.env ?? {}).map(([name, value]) => [
            name,
            evaluateTemplate(value, { github }),
        ])
    );
    execFileSync('/bin/bash', [...shell, '-c', step.run], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            PATH: process.env.PATH,
            HOME: cwd,
            GITHUB_EVENT_NAME: github.event_name,
            ...files,
            ...env,
        },
    });
    const published = Object.values(files)
        .flatMap((file) => {
            try {
                return readFileSync(file, 'utf8').trim().split('\n');
            } catch {
                return [];
            }
        })
        .filter((line) => /^(?:base|NX_BASE)=/.test(line));
    assert.equal(published.length, 1, published.join(' | '));
    return published[0].replace(/^(?:base|NX_BASE)=/, '');
}

// Deux PR ; la file empile leurs entrées : celle de la seconde a pour parent
// celle de la première (docs « Managing a merge queue »). La première entre
// par squash, la seconde par rebase (deux commits) : le parent de l'entrée
// (`base_sha`) n'est donc pas `HEAD~1`. Un faux sélecteur d'impact recopie la
// base reçue.
function queuedRepository(t) {
    const repo = repository(t);
    const { root, git, commit } = repo;
    commit('a.txt', 'racine');
    git('checkout', '-q', '-b', 'pr1', 'main');
    commit('pr1.txt', 'pr1');
    git('checkout', '-q', '-b', 'pr2', 'main');
    commit('pr2.txt', 'pr2');
    commit('pr2-bis.txt', 'pr2-bis');
    git('checkout', '-q', '-b', 'file', 'main');
    git('merge', '-q', '--squash', 'pr1');
    git('commit', '-q', '-m', 'entrée pr1');
    const first = git('rev-parse', 'HEAD');
    git('cherry-pick', 'main..pr2');
    mkdirSync(join(root, 'tools'));
    writeFileSync(
        join(root, 'tools/library-ci-impact.mjs'),
        "const a = process.argv.slice(2);\nconsole.log('base=' + a[a.indexOf('--base') + 1]);\n"
    );
    const head = git('rev-parse', 'HEAD');
    assert.notEqual(git('rev-parse', 'HEAD~1'), first);
    return { ...repo, first, head };
}

const queueRun = (head, base) => {
    const ref = `refs/heads/gh-readonly-queue/main/pr-2-${head}`;
    return {
        event_name: 'merge_group',
        ref,
        sha: head,
        base_ref: '',
        event: {
            merge_group: {
                head_sha: head,
                head_ref: ref,
                base_sha: base,
                base_ref: 'refs/heads/main',
            },
        },
    };
};

describe('base du diff dans la file de fusion', () => {
    it('merge_group : chaque étape rend le parent de l’entrée, et tout le diff de la PR', (t) => {
        const { root, first, head } = queuedRepository(t);
        for (const entry of BASE_STEPS) {
            const base = runBaseStep(t, entry, root, queueRun(head, first));
            assert.equal(base, first, entry.job);
            assert.deepEqual(changedPathsSince(base, { cwd: root }), [
                'pr2-bis.txt',
                'pr2.txt',
            ]);
        }
    });

    it('merge_group : HEAD autre que le groupe, base absente, non ancêtre ou vide : échec sur la commande visée', (t) => {
        const { root, git, first, head } = queuedRepository(t);
        const outsider = git('rev-parse', 'pr1');
        // Critère de mort : le code de sortie ET la dernière commande tracée
        // par `bash -x`, qui doit être la vérification visée.
        const cases = [
            [
                'HEAD autre que le groupe',
                queueRun(first, first),
                1,
                /^\+ test [0-9a-f]{40} = [0-9a-f]{40}$/,
            ],
            [
                'groupe vide',
                queueRun('', first),
                1,
                /^\+ test [0-9a-f]{40} = ''$/,
            ],
            [
                'base absente',
                queueRun(head, 'f'.repeat(40)),
                128,
                /^\+\+ git rev-parse --verify 'f{40}\^\{commit\}'$/,
            ],
            [
                'base vide',
                queueRun(head, ''),
                128,
                /^\+\+ git rev-parse --verify '\^\{commit\}'$/,
            ],
            [
                'base non ancêtre',
                queueRun(head, outsider),
                1,
                /^\+ git merge-base --is-ancestor [0-9a-f]{40} HEAD$/,
            ],
        ];
        for (const [name, run, status, lastCommand] of cases)
            for (const entry of BASE_STEPS) {
                const label = `${name} › ${entry.job}`;
                let failure;
                try {
                    runBaseStep(t, entry, root, run, ['-e', '-x']);
                } catch (error) {
                    failure = error;
                }
                assert.ok(failure, `accepté : ${label}`);
                assert.equal(failure.status, status, label);
                // Les traces d'affectation (`+ base=…`) varient selon la
                // version de bash : seule la dernière COMMANDE tracée compte.
                const traced = String(failure.stderr)
                    .split('\n')
                    .filter(
                        (line) =>
                            line.startsWith('+') &&
                            !/^\++ [A-Za-z_][A-Za-z0-9_]*=/.test(line)
                    );
                assert.match(traced.at(-1), lastCommand, label);
            }
    });

    it('pull_request et push : comportement inchangé', (t) => {
        const { root, git } = queuedRepository(t);
        const pullRequest = {
            event_name: 'pull_request',
            ref: 'refs/pull/2/merge',
            base_ref: 'main',
            event: { pull_request: { number: 2 } },
        };
        const push = { event_name: 'push', ref: 'refs/heads/main', event: {} };
        for (const entry of BASE_STEPS) {
            assert.equal(
                runBaseStep(t, entry, root, pullRequest),
                'origin/main'
            );
            assert.equal(
                runBaseStep(t, entry, root, push),
                git('rev-parse', 'HEAD~1')
            );
        }
    });
});

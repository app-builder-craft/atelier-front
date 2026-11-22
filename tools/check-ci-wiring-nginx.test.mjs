// NGINX-FRAICHEUR (C1) : structure (a) exacte et bloquante en CI, fraîcheur
// (b) dans son seul workflow quotidien, et nulle part ailleurs. Importé par
// check-ci-wiring.test.mjs (plafond de lignes de check:weight).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

import { STEP_LEVEL_REPORT_ONLY } from './check-branch-protection-contexts.mjs';
import {
    nginxWiringErrors,
    REQUIRED_STANDALONE_SCRIPTS,
} from './check-ci-wiring.mjs';
import { NGINX_FRESHNESS_WORKFLOW } from './check-workflow-privileges.mjs';
test('NGINX-FRAICHEUR (C1) : structure exacte et bloquante en CI, fraîcheur dans son seul workflow quotidien', () => {
    const workflows = readdirSync(
        new URL('../.github/workflows/', import.meta.url)
    )
        .filter((file) => /\.ya?ml$/.test(file))
        .sort()
        .map((file) => ({
            file,
            workflow: parse(
                readFileSync(
                    new URL(`../.github/workflows/${file}`, import.meta.url),
                    'utf8'
                )
            ),
        }));
    const { scripts } = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    );
    const contexts = JSON.parse(
        readFileSync(
            new URL('../.github/branch-protection.main.json', import.meta.url),
            'utf8'
        )
    ).required_status_checks.contexts;
    for (const script of ['check:nginx-image', 'check:nginx-digest'])
        assert.ok(REQUIRED_STANDALONE_SCRIPTS.includes(script), script);
    assert.equal(
        scripts['check:nginx-image'],
        'node tools/generator-platform/check-nginx-image.mjs'
    );
    assert.equal(
        scripts['check:nginx-digest'],
        'node tools/generator-platform/check-nginx-digest.mjs'
    );
    const errors = (mutate, pkg = scripts, required = contexts) => {
        const copy = structuredClone(workflows);
        const byFile = Object.fromEntries(
            copy.map(({ file, workflow }) => [file, workflow])
        );
        mutate?.(byFile, copy);
        return nginxWiringErrors(copy, pkg, required);
    };
    assert.deepEqual(errors(), []);
    const shells = (w) => w['ci.yml'].jobs['external-application-shells'];
    const structure = (w) =>
        shells(w).steps.find((s) => s.run === 'bun run check:nginx-image');
    const freshness = (w) =>
        w[NGINX_FRESHNESS_WORKFLOW].jobs.freshness.steps.find((s) =>
            s.run?.includes('check-nginx-digest.mjs')
        );
    for (const [label, mutate, pkg] of [
        ['(a) retiré de la CI', (w) => (structure(w).run = 'true')],
        ['(a) avec argument', (w) => (structure(w).run += ' --skip')],
        [
            '(a) seulement affiché',
            (w) => (structure(w).run = "echo 'bun run check:nginx-image'"),
        ],
        ['(a) conditionnel', (w) => (structure(w).if = 'false')],
        ['(a) toléré', (w) => (structure(w)['continue-on-error'] = true)],
        ['job (a) conditionnel', (w) => (shells(w).if = 'false')],
        ['job (a) non requis', (w) => (shells(w).name = 'Autre')],
        ['CI sans PR', (w) => delete w['ci.yml'].on.pull_request],
        ['CI sans push', (w) => delete w['ci.yml'].on.push],
        [
            '(b) en CI par bun',
            (w) => shells(w).steps.push({ run: 'bun run check:nginx-digest' }),
        ],
        [
            '(b) en CI par node',
            (w) =>
                shells(w).steps.push({
                    run: 'node tools/generator-platform/check-nginx-digest.mjs',
                }),
        ],
        [
            '(b) en CI avec argument',
            (w) =>
                shells(w).steps.push({
                    run: 'x && bun run check:nginx-digest --y',
                }),
        ],
        [
            '(b) dans un autre workflow',
            (w) =>
                w['nightly-integration.yml'].jobs[
                    Object.keys(w['nightly-integration.yml'].jobs)[0]
                ].steps.push({ run: 'bun run check:nginx-digest' }),
        ],
        ['(b) absent du quotidien', (w) => (freshness(w).run = 'true')],
        ['(b) avec argument', (w) => (freshness(w).run += ' --x')],
        ['(b) toléré', (w) => (freshness(w)['continue-on-error'] = true)],
        [
            'job (b) conditionnel',
            (w) => (w[NGINX_FRESHNESS_WORKFLOW].jobs.freshness.if = 'false'),
        ],
        [
            '(b) appelé deux fois',
            (w) =>
                w[NGINX_FRESHNESS_WORKFLOW].jobs.freshness.steps.push({
                    run: 'bun run check:nginx-digest',
                }),
        ],
        [
            'quotidien sur PR',
            (w) => (w[NGINX_FRESHNESS_WORKFLOW].on.pull_request = null),
        ],
        [
            'quotidien supprimé',
            (w, list) =>
                list.splice(
                    list.findIndex((e) => e.file === NGINX_FRESHNESS_WORKFLOW),
                    1
                ),
        ],
        [
            'définition (b) changée',
            undefined,
            { ...scripts, 'check:nginx-digest': 'node tools/autre.mjs' },
        ],
        [
            'définition (a) changée',
            (w) =>
                (structure(w).run =
                    'node tools/generator-platform/check-nginx-image.mjs'),
            { ...scripts, 'check:nginx-image': 'node tools/autre.mjs' },
        ],
    ])
        assert.notDeepEqual(errors(mutate, pkg), [], label);

    // (b) hors de son workflow : toute forme est refusée, pas seulement
    // l'appel exact, y compris par un autre script package.json.
    const outside =
        /ci\.yml › external-application-shells : check:nginx-digest dépend du registre/;
    for (const [label, run] of [
        ['bun sans run', 'bun check:nginx-digest'],
        ['npm run', 'npm run check:nginx-digest'],
        ['node ./', 'node ./tools/generator-platform/check-nginx-digest.mjs'],
        [
            'dans un script',
            'set -e\nnode tools/generator-platform/check-nginx-digest.mjs --x',
        ],
    ])
        assert.match(
            errors((w) => shells(w).steps.push({ run })).join('\n'),
            outside,
            label
        );
    const shellsTests = scripts['test:external-application-shells'];
    for (const leaf of [
        'bun run check:nginx-digest',
        'node tools/generator-platform/check-nginx-digest.mjs',
    ])
        assert.match(
            errors(undefined, {
                ...scripts,
                'test:external-application-shells': `${shellsTests} && ${leaf}`,
            }).join('\n'),
            /package\.json › test:external-application-shells : compose check:nginx-digest/,
            leaf
        );
    // Une seconde forme dans le quotidien n'est plus « un seul appel ».
    assert.match(
        errors((w) =>
            w[NGINX_FRESHNESS_WORKFLOW].jobs.freshness.steps.push({
                run: 'bun check:nginx-digest',
            })
        ).join('\n'),
        /un seul appel exact de check:nginx-digest/
    );

    // Appel exact : l'étape ne contient que lui, aux blancs de bord près. Un
    // préfixe ou un suffixe peut la rendre verte malgré l'échec du script.
    for (const [step, forms, refused] of [
        [
            structure,
            [
                'bun run check:nginx-image',
                'node tools/generator-platform/check-nginx-image.mjs',
            ],
            /ci\.yml : check:nginx-image doit être appelé exactement/,
        ],
        [
            freshness,
            [
                'node tools/generator-platform/check-nginx-digest.mjs',
                'bun run check:nginx-digest',
            ],
            /un seul appel exact de check:nginx-digest/,
        ],
    ]) {
        for (const form of forms)
            for (const run of [form, `${form}\n`, `  ${form}  `])
                assert.deepEqual(
                    errors((w) => (step(w).run = run)),
                    [],
                    `appel exact accepté : ${JSON.stringify(run)}`
                );
        const call = forms[0];
        for (const [label, run] of [
            ['suivi de || true', `${call} || true`],
            ['suivi de ; true', `${call}; true`],
            ['suivi de && true', `${call} && true`],
            ['suivi de exit 0', `${call}\nexit 0`],
            ['suivi d une autre ligne', `${call}\necho fin`],
            ['précédé de true ||', `true || ${call}`],
            ['précédé de exit 0', `exit 0\n${call}`],
        ])
            assert.match(
                errors((w) => (step(w).run = run)).join('\n'),
                refused,
                `${call} ${label}`
            );
    }

    // Exécution telle quelle : ni `shell` ni `working-directory` sur l'étape,
    // ni `defaults.run` sur son job ou son workflow. La règle est bornée à
    // l'étape et à ce qui la contient : une autre étape, un autre job, non.
    const daily = (w) => w[NGINX_FRESHNESS_WORKFLOW].jobs.freshness;
    for (const [name, step, job, file, refused] of [
        [
            '(a)',
            structure,
            shells,
            'ci.yml',
            /ci\.yml : check:nginx-image doit être appelé exactement/,
        ],
        [
            '(b)',
            freshness,
            daily,
            NGINX_FRESHNESS_WORKFLOW,
            /un seul appel exact de check:nginx-digest/,
        ],
    ]) {
        const neutral = { shell: 'true {0}' };
        const elsewhere = { 'working-directory': 'autre' };
        for (const [label, mutate] of [
            ['shell true {0} sur l étape', (w) => (step(w).shell = 'true {0}')],
            ['shell bash sur l étape', (w) => (step(w).shell = 'bash')],
            [
                'working-directory sur l étape',
                (w) => (step(w)['working-directory'] = 'autre'),
            ],
            [
                'defaults.run.shell du job',
                (w) => (job(w).defaults = { run: neutral }),
            ],
            [
                'defaults.run.working-directory du job',
                (w) => (job(w).defaults = { run: elsewhere }),
            ],
            [
                'defaults.run.shell du workflow',
                (w) => (w[file].defaults = { run: neutral }),
            ],
            [
                'defaults.run.working-directory du workflow',
                (w) => (w[file].defaults = { run: elsewhere }),
            ],
        ])
            assert.match(
                errors(mutate).join('\n'),
                refused,
                `${name} ${label}`
            );
        const sibling = (w) =>
            job(w).steps.find((other) => other.run && other !== step(w));
        const otherJob = (w) =>
            Object.values(w[file].jobs).find((other) => other !== job(w));
        for (const [label, mutate] of [
            [
                'shell sur une autre étape',
                (w) => (sibling(w).shell = 'true {0}'),
            ],
            [
                'working-directory sur une autre étape',
                (w) => (sibling(w)['working-directory'] = 'autre'),
            ],
            [
                'defaults.run sur un autre job',
                (w) => (otherJob(w).defaults = { run: neutral }),
            ],
        ])
            assert.deepEqual(errors(mutate), [], `${name} accepté : ${label}`);
    }

    // Chaîne `needs` (G-2) : un job sauté compte comme réussi pour un check
    // requis, et ses dépendants sont sautés avec lui. Aucun job dont dépend
    // celui de (a) ou de (b), de proche en proche, n'a d'`if`. Un job hors de
    // cette chaîne, en aval par exemple, garde le droit d'en avoir un. Les
    // jobs ajoutés y sont requis (leurs ids parmi les contextes) : ce bloc ne
    // vise que la règle `if`, la règle « chaîne requise » (G-3) a le sien.
    const fixtures = [...contexts, 'amont', 'relais', 'absent'];
    for (const [name, job, file, refused] of [
        [
            '(a)',
            shells,
            'ci.yml',
            /ci\.yml : check:nginx-image doit être appelé exactement/,
        ],
        [
            '(b)',
            daily,
            NGINX_FRESHNESS_WORKFLOW,
            /un seul appel exact de check:nginx-digest/,
        ],
    ]) {
        const add = (w, id, extra) => {
            assert.ok(!Object.hasOwn(w[file].jobs, id), `${file} › ${id}`);
            w[file].jobs[id] = {
                'runs-on': 'ubuntu-24.04',
                steps: [{ run: 'true' }],
                ...extra,
            };
        };
        const conditional = "github.event_name == 'schedule'";
        for (const [label, mutate] of [
            [
                'needs vers un job if false',
                (w) => {
                    add(w, 'amont', { if: 'false' });
                    job(w).needs = ['amont'];
                },
            ],
            [
                'needs vers un job a if conditionnel',
                (w) => {
                    add(w, 'amont', { if: conditional });
                    job(w).needs = ['amont'];
                },
            ],
            [
                'needs en texte vers un job a if conditionnel',
                (w) => {
                    add(w, 'amont', { if: conditional });
                    job(w).needs = 'amont';
                },
            ],
            [
                'needs transitif vers un job if false',
                (w) => {
                    add(w, 'amont', { if: 'false' });
                    add(w, 'relais', { needs: 'amont' });
                    job(w).needs = ['relais'];
                },
            ],
            [
                'needs vers un job absent',
                (w) => {
                    assert.ok(!Object.hasOwn(w[file].jobs, 'absent'));
                    job(w).needs = ['absent'];
                },
            ],
        ])
            assert.match(
                errors(mutate, scripts, fixtures).join('\n'),
                refused,
                `${name} ${label}`
            );
        const ownId = (w) =>
            Object.keys(w[file].jobs).find((id) => w[file].jobs[id] === job(w));
        for (const [label, mutate] of [
            [
                'chaine needs sans if',
                (w) => {
                    add(w, 'amont', {});
                    add(w, 'relais', { needs: 'amont' });
                    job(w).needs = ['relais'];
                },
            ],
            [
                'if sur un autre job',
                (w) =>
                    (Object.values(w[file].jobs).find(
                        (other) => other !== job(w)
                    ).if = 'false'),
            ],
            [
                'if sur un job en aval',
                (w) => add(w, 'aval', { if: 'false', needs: [ownId(w)] }),
            ],
        ])
            assert.deepEqual(
                errors(mutate, scripts, fixtures),
                [],
                `${name} accepté : ${label}`
            );
    }

    // Chaîne `needs` de (a) (G-3) : un job de la chaîne qui ÉCHOUE saute (a),
    // dont le check requis, sauté, passe. Chaque job de la chaîne de (a) est
    // donc lui-même requis : tous ses noms de check, matrice dépliée, sont des
    // contextes requis. Chaque refus a son pendant accepté, une fois les noms
    // manquants ajoutés aux contextes : seul le caractère requis les sépare.
    // (b) n'est pas concerné : un run rouge du quotidien ouvre l'issue.
    const refusedA = /ci\.yml : check:nginx-image doit être appelé exactement/;
    const ciJobs = (w) => w['ci.yml'].jobs;
    const addJob = (w, file, id, extra) => {
        assert.ok(!Object.hasOwn(w[file].jobs, id), `${file} › ${id}`);
        w[file].jobs[id] = {
            'runs-on': 'ubuntu-24.04',
            steps: [{ run: 'true' }],
            ...extra,
        };
    };
    const durability = (w) => {
        assert.ok(Object.hasOwn(ciJobs(w), 'publication-durability'));
        return ciJobs(w)['publication-durability'];
    };
    for (const [label, mutate, missing] of [
        [
            'needs vers un job non requis',
            (w) => {
                addJob(w, 'ci.yml', 'amont', {});
                shells(w).needs = ['amont'];
            },
            ['amont'],
        ],
        [
            'needs en texte vers un job non requis',
            (w) => {
                addJob(w, 'ci.yml', 'amont', { name: 'Amont' });
                shells(w).needs = 'amont';
            },
            ['Amont'],
        ],
        [
            'needs transitif vers un job non requis',
            (w) => {
                addJob(w, 'ci.yml', 'amont', {});
                assert.ok(Object.hasOwn(ciJobs(w), 'guardrails'));
                ciJobs(w).guardrails.needs = ['amont'];
                shells(w).needs = ['guardrails'];
            },
            ['amont'],
        ],
        [
            'needs vers une matrice dont une jambe n est pas requise',
            (w) => {
                durability(w).strategy.matrix.include.push({
                    profile: 'windows-ntfs',
                    runner: 'windows-2025',
                    platform: 'win32',
                });
                shells(w).needs = ['publication-durability'];
            },
            ['Publication durability (windows-ntfs)'],
        ],
    ]) {
        assert.match(
            errors(mutate).join('\n'),
            refusedA,
            `(a) G-3 refuse : ${label}`
        );
        assert.deepEqual(
            errors(mutate, scripts, [...contexts, ...missing]),
            [],
            `(a) G-3 accepté si requis : ${label}`
        );
    }
    // Un nom de check non résolu ne peut pas être requis : refusé.
    assert.match(
        errors((w) => {
            durability(w).name =
                'Publication durability (${{ matrix.inconnu }})';
            shells(w).needs = ['publication-durability'];
        }).join('\n'),
        refusedA,
        '(a) G-3 refuse : needs vers une matrice au nom non resolu'
    );
    // Le cas réel : un job en rapport seul de ci.yml (aujourd'hui `sast`).
    for (const id of STEP_LEVEL_REPORT_ONLY)
        assert.match(
            errors((w) => (shells(w).needs = [id])).join('\n'),
            refusedA,
            `(a) G-3 refuse : needs vers ${id}, job en rapport seul`
        );
    for (const [label, mutate] of [
        [
            'needs vers un job requis',
            (w) => {
                assert.ok(Object.hasOwn(ciJobs(w), 'guardrails'));
                shells(w).needs = ['guardrails'];
            },
        ],
        [
            'needs vers une matrice requise',
            (w) => {
                durability(w);
                shells(w).needs = 'publication-durability';
            },
        ],
    ])
        assert.deepEqual(errors(mutate), [], `(a) G-3 accepté : ${label}`);
    assert.deepEqual(
        errors((w) => {
            addJob(w, NGINX_FRESHNESS_WORKFLOW, 'amont', {});
            daily(w).needs = ['amont'];
        }),
        [],
        '(b) G-3 accepté : needs vers un job non requis'
    );
});

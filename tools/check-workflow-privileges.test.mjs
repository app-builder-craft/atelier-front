import './runtime-version-policy.test.mjs';
import assert from 'node:assert/strict';
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
    ALLOWED_JOB_WRITES,
    checkWorkflows,
    eventViolations,
    permissionViolations,
    workflowEvents,
} from './check-workflow-privileges.mjs';

const TRUSTED = "github.ref == 'refs/heads/main'";

const DISPATCH = '  schedule:\n    - cron: "0 0 * * *"\n  workflow_dispatch:';
const REVIEWED = {
    'f.yml': {
        events: ['schedule', 'workflow_dispatch'],
        jobs: { publish: ['contents'] },
    },
};

function readOnly(on, body) {
    return `name: F\non:\n${on}\npermissions:\n  contents: read\n${body}`;
}

function runStep(value, id = 's') {
    const identity = id === null ? '' : `        id: ${id}\n`;
    return `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n${identity}        env:\n          T: ${value}\n`;
}

function publishJob(on, condition) {
    return `name: F\non:\n${on}\njobs:\n  publish:\n    runs-on: ubuntu-latest\n${condition}    permissions:\n      contents: write\n    steps:\n      - run: echo ok\n`;
}

function check(content, writes = {}, handovers = {}) {
    return checkWorkflows([{ file: 'f.yml', content }], { writes, handovers });
}

// ─── Événements ─────────────────────────────────────────────────────────────

test('lit les trois écritures de `on`', () => {
    assert.deepEqual(workflowEvents({ on: 'push' }), ['push']);
    assert.deepEqual(workflowEvents({ on: ['push', 'pull_request'] }), [
        'pull_request',
        'push',
    ]);
    assert.deepEqual(workflowEvents({ on: { schedule: [], push: null } }), [
        'push',
        'schedule',
    ]);
    assert.equal(workflowEvents({}), null);
});

test('refuse un événement non relu et un `on` absent', () => {
    for (const event of [
        'pull_request_target',
        'workflow_run',
        'workflow_call',
    ])
        assert.match(
            eventViolations('f.yml', { on: { [event]: null } })[0],
            new RegExp(`événement \`${event}\` non relu`)
        );
    assert.match(eventViolations('f.yml', {})[0], /absents ou illisibles/);
    assert.deepEqual(
        eventViolations('f.yml', { on: ['push', 'schedule'] }),
        []
    );
});

// File de fusion : `github.ref` y est la branche de l'entrée, jamais `main`
// (docs « Events that trigger workflows », merge_group) ; la garde `main` des
// écritures et des secrets ne s'y ouvre donc pas.
test('merge_group est un événement relu', () => {
    assert.deepEqual(
        eventViolations('ci.yml', {
            on: {
                pull_request: { branches: ['main'] },
                merge_group: {
                    types: ['checks_requested'],
                    branches: ['main'],
                },
            },
        }),
        []
    );
});

test('workflow_run reste refusé dans tout workflow', () => {
    const on = {
        schedule: [],
        workflow_dispatch: null,
        workflow_run: { workflows: ['CI'], types: ['completed'] },
    };
    for (const file of [
        'f.yml',
        'ci.yml',
        'nx-migrations.yml',
        'security-overrides-repair.yml',
    ]) {
        assert.ok(
            eventViolations(file, { on }).some((e) =>
                e.includes('workflow_run')
            )
        );
    }
});

// ─── Jetons et écritures ────────────────────────────────────────────────────

test('accepte un jeton racine en lecture et un bloc racine vide', () => {
    for (const permissions of [{ contents: 'read' }, {}])
        assert.deepEqual(
            permissionViolations('f.yml', {
                on: 'push',
                permissions,
                jobs: { build: {}, test: {} },
            }),
            []
        );
});

test('refuse un job sans bloc quand le workflow ne borne rien', () => {
    const violations = permissionViolations('f.yml', {
        on: 'push',
        jobs: { build: {}, test: { permissions: { contents: 'read' } } },
    });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /f\.yml › build : aucun bloc/);
});

test('refuse write-all, read-all et une écriture racine', () => {
    assert.match(
        permissionViolations('f.yml', {
            on: 'push',
            permissions: 'write-all',
            jobs: { a: {} },
        })[0],
        /permissions: write-all/
    );
    assert.match(
        permissionViolations('f.yml', {
            on: 'push',
            permissions: {},
            jobs: { a: { permissions: 'read-all' } },
        })[0],
        /f\.yml › a : `permissions: read-all`/
    );
    assert.match(
        permissionViolations('f.yml', {
            on: 'push',
            permissions: { contents: 'write' },
            jobs: { a: {} },
        })[0],
        /écriture `contents` accordée à tous les jobs/
    );
});

test('accepte une écriture relue, liée à ses événements et à main', () => {
    assert.deepEqual(
        check(publishJob(DISPATCH, `    if: ${TRUSTED} && true\n`), REVIEWED),
        []
    );
    assert.deepEqual(
        check(publishJob(DISPATCH, `    if: \${{ ${TRUSTED} }}\n`), REVIEWED),
        []
    );
});

test('refuse une écriture absente de la liste, ou une liste périmée', () => {
    assert.match(
        check(publishJob(DISPATCH, `    if: ${TRUSTED} && true\n`))[0],
        /écriture non relue \(contents\)/
    );
    assert.match(
        check(publishJob(DISPATCH, `    if: ${TRUSTED} && true\n`), {
            'f.yml': {
                events: ['schedule', 'workflow_dispatch'],
                jobs: { publish: ['contents', 'issues'] },
            },
        })[0],
        /liste issues que le job ne demande plus/
    );
    assert.match(
        check(
            readOnly(DISPATCH, 'jobs:\n  a:\n    runs-on: x\n'),
            REVIEWED
        ).join('\n'),
        /cite le job `publish`, absent/
    );
});

test('refuse une écriture relue déclenchée par un autre événement', () => {
    assert.match(
        check(
            publishJob('  pull_request:', `    if: ${TRUSTED} && true\n`),
            REVIEWED
        ).join('\n'),
        /relues pour les événements schedule, workflow_dispatch ; le workflow se déclenche sur pull_request/
    );
});

test('refuse une écriture que ne garde pas la ref main', () => {
    for (const condition of [
        '',
        "    if: needs.a.outputs.x == 'true'\n",
        `    if: ${TRUSTED} && false || always()\n`,
        `    if: always() && ${TRUSTED}\n`,
        "    if: github.ref == 'refs/heads/mainx' && true\n",
        "    if: github.ref != 'refs/heads/main' && true\n",
        `    if: ${TRUSTED} != true\n`,
        `    if: ${TRUSTED} == false && true\n`,
    ])
        assert.match(
            check(publishJob(DISPATCH, condition), REVIEWED).join('\n'),
            /un job qui écrit doit porter `if: github\.ref == 'refs\/heads\/main' && …`/,
            condition
        );
});

// ─── Agrégation ─────────────────────────────────────────────────────────────

test('checkWorkflows refuse un YAML illisible et un fichier cité mais absent', () => {
    assert.match(
        checkWorkflows([{ file: 'f.yml', content: 'a: [1' }], {
            writes: {},
            handovers: {},
        })[0],
        /f\.yml : YAML illisible/
    );
    assert.match(
        checkWorkflows([{ file: 'f.yml', content: '- a\n' }], {
            writes: {},
            handovers: {},
        })[0],
        /n'est pas un mapping YAML/
    );
    assert.deepEqual(
        checkWorkflows(
            [{ file: 'f.yml', content: readOnly('  push:', runStep("'x'")) }],
            {
                writes: { 'gone.yml': { events: ['push'], jobs: {} } },
                handovers: { 'lost.yml': {}, 'gone.yml': {} },
            }
        ),
        [
            'gone.yml : cité par ce garde mais introuvable.',
            'lost.yml : cité par ce garde mais introuvable.',
        ]
    );
});

test('checkWorkflows refuse un audit hors de son point d’entrée (règle 6)', () => {
    const audit = (run) =>
        checkWorkflows(
            [
                {
                    file: 'f.yml',
                    content: readOnly(
                        '  push:',
                        `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`
                    ),
                },
            ],
            { writes: {}, handovers: {} }
        );
    assert.deepEqual(audit('node tools/audit-exceptions.mjs'), []);
    assert.deepEqual(audit('bun audit --audit-level=high --ignore=GHSA-x'), [
        "f.yml : job a : --ignore d'audit écrit à la main, refusé (exceptions : AUDIT_IGNORES)",
    ]);
    assert.deepEqual(audit('bun audit --audit-level=high'), [
        'f.yml : job a : audit lancé hors de node tools/audit-exceptions.mjs',
    ]);
});

test('Nx : suivi natif limité aux issues et gardé par main, sans élargir les autres jobs', () => {
    const file = 'nx-migrations.yml';
    const workflow = parseYaml(
        readFileSync(
            new URL(`../.github/workflows/${file}`, import.meta.url),
            'utf8'
        )
    );
    const check = (w) =>
        checkWorkflows([{ file, content: stringifyYaml(w) }], {
            writes: { [file]: ALLOWED_JOB_WRITES[file] },
            handovers: {},
        });
    assert.deepEqual(check(workflow), []);
    for (const mutate of [
        (w) => {
            w.jobs.followup.permissions.contents = 'write';
        },
        (w) => {
            w.jobs.followup.permissions['pull-requests'] = 'write';
        },
        (w) => {
            w.jobs.followup.if = "github.event_name == 'pull_request'";
        },
        (w) => {
            w.jobs.assess.permissions = { issues: 'write' };
        },
    ]) {
        const bad = structuredClone(workflow);
        mutate(bad);
        assert.ok(check(bad).length > 0);
    }
});

test('le vrai shell du suivi crée une issue, puis actualise cette même issue, et refuse un doublon', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'nx-issue-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const gh = join(root, 'gh');
    writeFileSync(
        gh,
        `#!${process.execPath}\nconst fs = require('node:fs');
const path = process.env.GH_TEST_STATE;
const state = JSON.parse(fs.readFileSync(path));
const command = process.argv[3];
if (command === 'list') console.log(JSON.stringify(state.issues));
else if (command === 'create') { state.created++; state.issues.push({number:7,title:process.argv[process.argv.indexOf('--title')+1],state:'OPEN'}); }
else if (command === 'edit') { if(process.argv[4] !== '7') process.exit(2); state.edited++; }
else process.exit(3);
fs.writeFileSync(path,JSON.stringify(state));\n`
    );
    chmodSync(gh, 0o755);
    const statePath = join(root, 'issues.json');
    writeFileSync(
        statePath,
        JSON.stringify({ issues: [], created: 0, edited: 0 })
    );
    const script = parseYaml(
        readFileSync(
            new URL('../.github/workflows/nx-migrations.yml', import.meta.url),
            'utf8'
        )
    ).jobs.followup.steps[0].run;
    const run = () =>
        spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', script], {
            encoding: 'utf8',
            env: {
                ...process.env,
                TARGET: '24.0.1',
                GITHUB_REPOSITORY: 'test/repo',
                GITHUB_RUN_ID: '123',
                GITHUB_RUN_ATTEMPT: '1',
                PATH: `${root}:${process.env.PATH}`,
                RUNNER_TEMP: root,
                GH_TEST_STATE: statePath,
            },
        });
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    result = run();
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(readFileSync(statePath));
    assert.equal(state.created, 1);
    assert.equal(state.edited, 1);
    state.issues.push({ ...state.issues[0], number: 8 });
    writeFileSync(statePath, JSON.stringify(state));
    assert.notEqual(run().status, 0);
    assert.equal(JSON.parse(readFileSync(statePath)).created, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    cartesianProduct,
    checkRepository,
    declaredContexts,
    diffContexts,
    evaluateExpression,
    evaluateTemplate,
    expandMatrix,
    expectedContexts,
    isReportOnly,
    jobContexts,
    mergeGroupTriggerError,
    mergeQueueErrors,
    renderName,
    requiredJobs,
    simulatedRuns,
    stepConditionContexts,
} from './check-branch-protection-contexts.mjs';

test('cartesianProduct combine tous les axes', () => {
    assert.deepEqual(
        cartesianProduct({ os: ['linux', 'mac'], node: ['20', '22'] }),
        [
            { os: 'linux', node: '20' },
            { os: 'linux', node: '22' },
            { os: 'mac', node: '20' },
            { os: 'mac', node: '22' },
        ]
    );
});

test('expandMatrix déplie une matrice `include` seule', () => {
    assert.deepEqual(
        expandMatrix({
            include: [
                { profile: 'linux-ext4', runner: 'ubuntu-24.04' },
                { profile: 'macos-apfs', runner: 'macos-14' },
            ],
        }),
        [
            { profile: 'linux-ext4', runner: 'ubuntu-24.04' },
            { profile: 'macos-apfs', runner: 'macos-14' },
        ]
    );
});

test('expandMatrix applique exclude puis include sur des axes', () => {
    assert.deepEqual(
        expandMatrix({
            os: ['linux', 'mac'],
            node: ['20', '22'],
            exclude: [{ os: 'mac', node: '20' }],
            include: [{ os: 'linux', node: '22', extra: 'coverage' }],
        }),
        [
            { os: 'linux', node: '20' },
            { os: 'linux', node: '22', extra: 'coverage' },
            { os: 'mac', node: '22' },
        ]
    );
});

test('renderName substitue les jetons matrix et signale les non résolus', () => {
    assert.equal(
        renderName('Publication durability (${{ matrix.profile }})', {
            profile: 'linux-ext4',
        }),
        'Publication durability (linux-ext4)'
    );
    assert.throws(
        () => renderName('X (${{ matrix.missing }})', { profile: 'y' }),
        /non résolu/
    );
});

test('jobContexts : job simple, job matrice templatée, job matrice non templatée', () => {
    assert.deepEqual(
        jobContexts('secrets', { name: 'Secret scan (gitleaks)' }),
        ['Secret scan (gitleaks)']
    );
    assert.deepEqual(
        jobContexts('pub', {
            name: 'Publication durability (${{ matrix.profile }})',
            strategy: {
                matrix: { include: [{ profile: 'a' }, { profile: 'b' }] },
            },
        }),
        ['Publication durability (a)', 'Publication durability (b)']
    );
    assert.deepEqual(
        jobContexts('build', {
            name: 'Build',
            strategy: { matrix: { node: ['20', '22'] } },
        }),
        ['Build (20)', 'Build (22)']
    );
});

test('jobContexts retombe sur la clé de job sans `name`', () => {
    assert.deepEqual(jobContexts('lint', {}), ['lint']);
});

test('isReportOnly : continue-on-error job + allowlist step-level', () => {
    assert.equal(isReportOnly('x', { 'continue-on-error': true }), true);
    assert.equal(isReportOnly('sast', {}), true);
    assert.equal(isReportOnly('oracle', {}), false);
});

test('expectedContexts exige un déclencheur PR vers main', () => {
    assert.throws(
        () =>
            expectedContexts(
                'on:\n  push:\n    branches: [main]\njobs:\n  a:\n    name: A\n',
                'sansPR.yml'
            ),
        /pull_request` vers `main`/
    );
});

test('expectedContexts exclut les jobs rapport-seul, garde les autres', () => {
    const yml = `
on:
  pull_request:
    branches: [main]
jobs:
  guardrails:
    name: Garde-fous socle
    steps: []
  sast:
    name: SAST (Semgrep, rapport seul)
    steps: []
  bundle:
    name: Bundle info
    continue-on-error: true
    steps: []
  pub:
    name: Publication durability (\${{ matrix.profile }})
    strategy:
      matrix:
        include:
          - profile: linux-ext4
          - profile: macos-apfs
    steps: []
`;
    assert.deepEqual(
        [...expectedContexts(yml, 'test.yml')].sort(),
        [
            'Garde-fous socle',
            'Publication durability (linux-ext4)',
            'Publication durability (macos-apfs)',
        ].sort()
    );
});

test('expectedContexts refuse une allowlist référençant un job absent', () => {
    // `sast` est dans STEP_LEVEL_REPORT_ONLY : un workflow sans ce job doit lever.
    assert.throws(
        () =>
            expectedContexts(
                'on:\n  pull_request:\n    branches: [main]\njobs:\n  a:\n    name: A\n',
                'test.yml'
            ),
        /STEP_LEVEL_REPORT_ONLY référence des jobs absents/
    );
});

test('declaredContexts lit la liste, rejette une forme invalide', () => {
    assert.deepEqual(
        declaredContexts(
            '{"required_status_checks":{"contexts":["A","B"]}}',
            't'
        ),
        ['A', 'B']
    );
    assert.throws(
        () => declaredContexts('{"required_status_checks":{}}', 't'),
        /absent ou non-liste/
    );
});

test('diffContexts remonte missing / stale / duplicates', () => {
    assert.deepEqual(
        diffContexts(new Set(['A', 'B', 'C']), ['B', 'C', 'C', 'D']),
        { missing: ['A'], stale: ['D'], duplicates: ['C'] }
    );
});

test('cohérence réelle : ci.yml ↔ branch-protection.main.json', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');

    const expected = expectedContexts(
        readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
    );
    const declared = declaredContexts(
        readFileSync(join(root, '.github/branch-protection.main.json'), 'utf8')
    );
    assert.deepEqual(diffContexts(expected, declared), {
        missing: [],
        stale: [],
        duplicates: [],
    });
});

// ─── File de fusion (merge_group) ───────────────────────────────────────────

const DECLARED = ['Garde-fous socle', 'Oracle'];
const PR_OR_REF =
    '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}';

// Un workflow conforme : deux jobs requis, un job rapport seul, un job libre.
function queueWorkflow() {
    return {
        name: 'CI',
        on: {
            pull_request: { branches: ['main'] },
            merge_group: { types: ['checks_requested'], branches: ['main'] },
        },
        concurrency: { group: PR_OR_REF, 'cancel-in-progress': true },
        jobs: {
            guardrails: { name: 'Garde-fous socle', steps: [{ run: 'true' }] },
            sast: { name: 'SAST', steps: [] },
            oracle: {
                name: 'Oracle',
                needs: 'guardrails',
                steps: [
                    { id: 'impact', run: 'true' },
                    { if: "steps.impact.outputs.run == 'true'", run: 'true' },
                    { if: "needs.guardrails.result == 'success'", run: 'x' },
                    { if: "matrix.os == 'linux'", run: 'true' },
                    { if: 'failure()', run: 'true' },
                    { if: '${{ always() }}', run: 'true' },
                ],
            },
            report: {
                name: 'Rapport',
                if: "github.event_name == 'push'",
                steps: [],
            },
        },
    };
}

const queueErrors = (mutate) => {
    const workflow = queueWorkflow();
    mutate?.(workflow);
    return mergeQueueErrors('ci.yml', workflow, DECLARED);
};

test('file de fusion : un workflow conforme passe ; sans contexte requis, rien n’est exigé', () => {
    assert.deepEqual(queueErrors(), []);
    assert.deepEqual(
        mergeQueueErrors(
            'nightly.yml',
            { on: { schedule: [] }, jobs: { a: { name: 'Nightly' } } },
            DECLARED
        ),
        []
    );
    assert.deepEqual(
        requiredJobs(queueWorkflow(), DECLARED).map(([key]) => key),
        ['guardrails', 'oracle']
    );
});

test('file de fusion : le déclencheur merge_group est exigé, avec checks_requested et sans filtre de chemin', () => {
    assert.equal(mergeGroupTriggerError(queueWorkflow()), null);
    const accepted = queueWorkflow();
    delete accepted.on.merge_group.branches;
    assert.equal(mergeGroupTriggerError(accepted), null);
    for (const trigger of [
        undefined,
        null,
        {},
        { types: ['checks_requested', 'destroyed'] },
        { types: ['checks_requested'], paths: ['src/**'] },
        { types: ['checks_requested'], 'branches-ignore': ['x'] },
        { types: ['checks_requested'], branches: ['release'] },
        { types: ['checks_requested'], branches: ['main', '!main'] },
        { types: ['checks_requested'], branches: 'main' },
    ]) {
        const errors = queueErrors((w) => {
            if (trigger === undefined) delete w.on.merge_group;
            else w.on.merge_group = trigger;
        });
        // `JSON.stringify(undefined)` vaut undefined : libellé explicite.
        const label = JSON.stringify(trigger) ?? 'merge_group absent';
        assert.equal(errors.length, 1, label);
        assert.match(errors[0], /^ci\.yml : .*merge_group/);
        assert.match(errors[0], /n'arrivent jamais/);
    }
    // Formes liste et chaîne : déclenché, mais sans `types` ; sans
    // `merge_group`, le diagnostic le dit.
    for (const [on, expected] of [
        [
            ['pull_request', 'merge_group'],
            /^ci\.yml : `merge_group` sans `types`/,
        ],
        ['merge_group', /^ci\.yml : `merge_group` sans `types`/],
        [['pull_request'], /^ci\.yml : ne se déclenche pas sur `merge_group`/],
    ]) {
        const errors = queueErrors((w) => {
            w.on = on;
        });
        assert.equal(errors.length, 1, JSON.stringify(on));
        assert.match(errors[0], expected, `forme ${JSON.stringify(on)}`);
    }
});

test('file de fusion : un job requis ne porte aucune condition de job', () => {
    for (const condition of [
        "github.event_name != 'merge_group'",
        'always()',
        false,
    ]) {
        const errors = queueErrors((w) => {
            w.jobs.oracle.if = condition;
        });
        assert.equal(errors.length, 1);
        assert.match(
            errors[0],
            /ci\.yml › oracle : `if: .*` sur un job requis ; un job sauté rapporte « Success »/
        );
    }
    // Rapport seul compris : `continue-on-error` ou une clé de
    // STEP_LEVEL_REPORT_ONLY (propre à ci.yml) n'exemptent pas, dans un autre
    // workflow, un job qui produit un contexte requis.
    for (const [key, extra] of [
        ['scan', { 'continue-on-error': true }],
        ['sast', {}],
    ]) {
        const errors = mergeQueueErrors(
            'autre.yml',
            {
                on: queueWorkflow().on,
                jobs: {
                    [key]: {
                        name: 'Oracle',
                        ...extra,
                        if: "github.event_name != 'merge_group'",
                        steps: [],
                    },
                },
            },
            DECLARED
        );
        assert.equal(errors.length, 1, `rapport seul exempté : ${key}`);
        assert.match(errors[0], new RegExp(`^autre\\.yml › ${key} : \`if: `));
    }
});

test('file de fusion : un job requis ne dépend que de jobs requis', () => {
    for (const needs of [['guardrails', 'report'], 'sast', ['absent']]) {
        const errors = queueErrors((w) => {
            w.jobs.oracle.needs = needs;
        });
        assert.equal(errors.length, 1, JSON.stringify(needs));
        assert.match(
            errors[0],
            /ci\.yml › oracle : dépend de `(report|sast|absent)`, qui n'est pas un contrôle requis/
        );
    }
});

test('file de fusion : une étape d’un job requis ne se décide pas sur l’événement', () => {
    const cases = [
        ["github.event_name == 'pull_request'", /`github`/],
        ["${{ github.ref == 'refs/heads/main' }}", /`github`/],
        ["env.CI == 'true'", /`env`/],
        ["inputs.mode == 'x'", /`inputs`/],
        ["contains(steps.a.outputs.b, 'x')", /`contains`/],
        [false, /la valeur false/],
        ['${{ steps.a.outputs.b }} && ${{ github.ref }}', /forme non reconnue/],
    ];
    for (const [condition, expected] of cases) {
        const errors = queueErrors((w) => {
            w.jobs.oracle.steps.push({ id: 'test', if: condition, run: 'x' });
        });
        assert.equal(errors.length, 1, String(condition));
        assert.match(errors[0], /ci\.yml › oracle › étape test : `if` lit /);
        assert.match(errors[0], expected);
    }
    // Un job non requis reste libre de ses conditions.
    assert.deepEqual(
        queueErrors((w) => {
            w.jobs.report.steps.push({ if: "github.ref == 'x'", run: 'x' });
        }),
        []
    );
    assert.deepEqual(stepConditionContexts(undefined), []);
});

test('file de fusion : une PR et la file, ou deux entrées, ne partagent jamais un groupe de concurrence', () => {
    const cases = [
        ['${{ github.workflow }}', [/une PR et son entrée/, /deux entrées/]],
        [
            '${{ github.workflow }}-${{ github.event.pull_request.number || github.event_name }}',
            [/deux entrées de la file partagent le groupe « ci-merge_group »/],
        ],
        [
            "${{ github.event_name == 'pull_request' && 'File' || 'file' }}",
            [/une PR et son entrée/, /deux entrées/],
        ],
        ["${{ hashFiles('x') }}", [/groupe de concurrence non simulable/]],
        ['${{ inputs.target }}', [/non simulable/]],
    ];
    for (const [group, expected] of cases) {
        const errors = queueErrors((w) => {
            w.concurrency.group = group;
        });
        for (const pattern of expected)
            assert.ok(
                errors.some((error) => pattern.test(error)),
                `${group} : ${pattern}`
            );
        assert.equal(errors.length, expected.length, group);
        assert.ok(errors.every((e) => e.startsWith('ci.yml › workflow : ')));
    }
    for (const group of [
        '${{ github.workflow }}-${{ github.head_ref || github.run_id }}',
        '${{ github.workflow }}-${{ github.ref }}',
        'ci-${{ github.event.merge_group.head_sha || github.ref }}',
    ])
        assert.deepEqual(
            queueErrors((w) => {
                w.concurrency = group;
            }),
            [],
            group
        );
    assert.match(
        queueErrors((w) => {
            w.jobs.oracle.concurrency = 'oracle';
        })[0],
        /^ci\.yml › job oracle : une PR et son entrée/
    );
});

test('expressions simulées : sous-ensemble évalué comme GitHub, le reste refusé', () => {
    const { pullRequest, firstEntry } = simulatedRuns('CI');
    assert.equal(
        firstEntry.github.ref,
        `refs/heads/gh-readonly-queue/main/pr-7-${'b'.repeat(40)}`
    );
    const value = (source, run) => evaluateExpression(source, run);
    assert.equal(
        value('github.event.pull_request.number || github.ref', pullRequest),
        7
    );
    assert.equal(
        evaluateTemplate(PR_OR_REF, firstEntry),
        `CI-${firstEntry.github.ref}`
    );
    assert.equal(
        value("format('origin/{0}', github.base_ref)", pullRequest),
        'origin/main'
    );
    assert.equal(
        value(
            "github.event_name == 'pull_request' && format('origin/{0}', github.base_ref) || ''",
            firstEntry
        ),
        ''
    );
    assert.equal(
        value("github.event_name == 'PULL_REQUEST'", pullRequest),
        true
    );
    assert.equal(value('!github.event.pull_request', firstEntry), true);
    assert.equal(value('github.event.merge_group.base_sha', pullRequest), null);
    assert.equal(value("(1 == 1) != false && 'oui'", pullRequest), 'oui');
    assert.equal(
        value('github.event.merge_group.base_sha == null', pullRequest),
        true
    );
    for (const source of [
        // Types mêlés : GitHub convertit en nombre (7 == '7', null == '').
        "github.event.pull_request.number == '7'",
        "github.event.merge_group.base_sha == ''",
        'github.event_name != 0',
        'inputs.x',
        'toJSON(github)',
        'github.event_name github.ref',
        "github['ref']",
        'github.',
        '',
        "format('{{0}}', github.ref)",
        "format('{0}}', github.ref)",
        'format(1, github.ref)',
    ])
        assert.throws(() => value(source, pullRequest), /non simulée/, source);
});

test('dépôt réel : chaque contexte requis déclaré tourne dans la file, aucun sauté', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { parse } = await import('yaml');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const declared = declaredContexts(
        readFileSync(join(root, '.github/branch-protection.main.json'), 'utf8')
    );
    const produced = new Set();
    const files = readdirSync(join(root, '.github/workflows')).filter((file) =>
        /\.ya?ml$/.test(file)
    );
    for (const file of files) {
        const workflow = parse(
            readFileSync(join(root, '.github/workflows', file), 'utf8')
        );
        assert.deepEqual(mergeQueueErrors(file, workflow, declared), [], file);
        if (mergeGroupTriggerError(workflow) !== null) continue;
        for (const [key, job] of requiredJobs(workflow, declared))
            for (const context of jobContexts(key, job)) produced.add(context);
    }
    assert.deepEqual([...produced].sort(), [...declared].sort());
});

// Copie jetable du dépôt : JSON de protection réel, `ci.yml` réel (modifié par
// `mutate` s'il est donné), et d'autres workflows éventuels ({ fichier: objet }).
async function repositoryCopy(t, mutate, others = {}) {
    const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } =
        await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { parse, stringify } = await import('yaml');
    const real = join(dirname(fileURLToPath(import.meta.url)), '..');
    const copy = mkdtempSync(join(tmpdir(), 'branch-protection-'));
    t.after(() => rmSync(copy, { recursive: true, force: true }));
    mkdirSync(join(copy, '.github/workflows'), { recursive: true });
    const protection = '.github/branch-protection.main.json';
    writeFileSync(
        join(copy, protection),
        readFileSync(join(real, protection), 'utf8')
    );
    const ci = parse(
        readFileSync(join(real, '.github/workflows/ci.yml'), 'utf8')
    );
    mutate?.(ci);
    for (const [file, workflow] of Object.entries({ 'ci.yml': ci, ...others }))
        writeFileSync(
            join(copy, '.github/workflows', file),
            stringify(workflow)
        );
    return { real, copy };
}

test('décision de sortie : ci.yml sans merge_group rend le dépôt rouge', async (t) => {
    const { real, copy } = await repositoryCopy(t, (ci) => {
        delete ci.on.merge_group;
    });
    assert.equal(checkRepository(real).ok, true);
    const report = checkRepository(copy);
    assert.deepEqual(
        [report.missing, report.stale, report.duplicates],
        [[], [], []]
    );
    assert.equal(report.queue.length, 1);
    assert.match(
        report.queue[0],
        /^\.github\/workflows\/ci\.yml : ne se déclenche pas sur `merge_group`/
    );
    assert.equal(report.ok, false, 'erreur de file sans sortie rouge');
});

test('dépôt : tout workflow qui produit un contexte requis est lu, .yaml compris', async (t) => {
    const { copy } = await repositoryCopy(t, undefined, {
        'autre.yaml': {
            on: { pull_request: { branches: ['main'] } },
            jobs: { scan: { name: 'Secret scan (gitleaks)', steps: [] } },
        },
        'libre.yml': {
            on: { schedule: [{ cron: '0 3 * * *' }] },
            jobs: { nuit: { name: 'Nightly', steps: [] } },
        },
    });
    const report = checkRepository(copy);
    assert.deepEqual(
        [report.missing, report.stale, report.duplicates],
        [[], [], []]
    );
    assert.equal(
        report.queue.length,
        1,
        `file : ${report.queue.length} erreur(s) ${report.queue.join(' | ')}`
    );
    assert.match(
        report.queue[0],
        /^\.github\/workflows\/autre\.yaml : ne se déclenche pas sur `merge_group`/
    );
    assert.equal(report.ok, false);
});

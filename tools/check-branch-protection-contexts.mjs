#!/usr/bin/env node
/**
 * check-branch-protection-contexts.mjs — audit gouvernance `main`
 *
 * Même classe de bug que `check-ci-wiring.mjs`, côté forge : la liste
 * `required_status_checks.contexts` de `.github/branch-protection.main.json`
 * est maintenue à la main. Rien ne garantit qu'elle reste synchronisée avec
 * les jobs bloquants réellement produits par `.github/workflows/ci.yml` sur
 * une PR vers `main`. Deux dérives silencieuses possibles :
 *
 *   1. Un job bloquant ajouté / renommé dans `ci.yml` mais absent des
 *      contextes → la PR peut être fusionnée sans que ce job soit vert.
 *   2. Un contexte requis obsolète (job supprimé / renommé) → GitHub attend
 *      indéfiniment un check qui n'arrivera jamais : **toutes les PR sont
 *      bloquées**.
 *
 * Ce script impose l'égalité stricte entre :
 *   - l'ensemble des noms de check-runs des jobs bloquants de `ci.yml`
 *     (matrices dépliées) ;
 *   - `required_status_checks.contexts` du JSON de protection.
 *
 * « Bloquant » = tout job, SAUF :
 *   - un job portant `continue-on-error: true` au niveau job ;
 *   - un job explicitement listé dans `STEP_LEVEL_REPORT_ONLY` (rapport seul
 *     via `continue-on-error` au niveau step — cf. `sast` / Semgrep, T4-3).
 *
 * Fail-closed : tout NOUVEAU job est requis par défaut. Pour en exclure un,
 * il faut consciemment l'ajouter ci-dessous, avec sa justification.
 *
 * File de fusion : tout workflow dont un job, même en rapport seul, produit
 * un contexte requis (déduit de ce même JSON, jamais recopié) doit aussi
 * tourner VRAIMENT sur le commit du groupe (`mergeQueueErrors`) : déclencheur
 * `merge_group`, aucun job requis sauté, groupes de concurrence distincts.
 *
 * Usage : bun run check:branch-protection-contexts
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { tokenizeExpression } from './check-workflow-privileges.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS_DIR = '.github/workflows';
const WORKFLOW_PATH = `${WORKFLOWS_DIR}/ci.yml`;
const PROTECTION_PATH = '.github/branch-protection.main.json';

/**
 * Jobs `ci.yml` volontairement non bloquants alors qu'ils n'ont PAS de
 * `continue-on-error` au niveau job (il porte sur une step). Clé = clé de job.
 */
export const STEP_LEVEL_REPORT_ONLY = new Set([
    // T4-3 — Semgrep en rapport seul pour ce rollout : le step `scan` porte
    // `continue-on-error: true` et n'utilise pas `--error`. À retirer d'ici
    // quand le job repassera bloquant (cf. docstring du job dans ci.yml).
    'sast',
]);

/** Produit cartésien des axes de matrice `{ k: [v1, v2], ... }`. */
export function cartesianProduct(axes) {
    return Object.entries(axes).reduce(
        (combos, [key, values]) =>
            combos.flatMap((combo) =>
                (Array.isArray(values) ? values : [values]).map((value) => ({
                    ...combo,
                    [key]: value,
                }))
            ),
        [{}]
    );
}

/**
 * Déplie `strategy.matrix` en la liste des combinaisons effectives, en
 * appliquant `exclude` puis `include` (sémantique GitHub, cas usuels).
 */
export function expandMatrix(matrix) {
    if (!matrix || typeof matrix !== 'object') return [{}];

    const { include = [], exclude = [], ...axes } = matrix;
    let combos = Object.keys(axes).length ? cartesianProduct(axes) : [];

    for (const removed of exclude) {
        combos = combos.filter(
            (combo) =>
                !Object.entries(removed).every(([k, v]) => combo[k] === v)
        );
    }

    for (const added of include) {
        const axisKeys = Object.keys(axes);
        const overlap = Object.keys(added).filter((k) => axisKeys.includes(k));
        const target = combos.find((combo) =>
            overlap.every((k) => combo[k] === added[k])
        );
        if (overlap.length && target) {
            Object.assign(target, added);
        } else {
            combos.push({ ...added });
        }
    }

    return combos.length ? combos : [{}];
}

/** Remplace les `${{ matrix.<clef> }}` d'un gabarit de nom par la combinaison. */
export function renderName(template, combo) {
    const unresolved = [];
    const rendered = template.replace(
        /\$\{\{\s*matrix\.([\w.-]+)\s*\}\}/g,
        (_, key) => {
            if (!(key in combo)) {
                unresolved.push(key);
                return _;
            }
            return String(combo[key]);
        }
    );
    if (unresolved.length) {
        throw new Error(
            `Gabarit de nom non résolu (${unresolved.join(', ')}) : ` +
                `"${template}" — étendre check-branch-protection-contexts.mjs.`
        );
    }
    return rendered;
}

/** Le nom de check-run GitHub pour un job (matrice dépliée si besoin). */
export function jobContexts(jobKey, job) {
    const base = typeof job?.name === 'string' ? job.name : jobKey;
    const matrix = job?.strategy?.matrix;
    if (!matrix) return [base];

    const combos = expandMatrix(matrix);
    const templated = /\$\{\{\s*matrix\./.test(base);
    return combos.map((combo) =>
        templated
            ? renderName(base, combo)
            : `${base} (${Object.values(combo).join(', ')})`
    );
}

/** True si le job est volontairement non bloquant. */
export function isReportOnly(jobKey, job) {
    return (
        job?.['continue-on-error'] === true ||
        STEP_LEVEL_REPORT_ONLY.has(jobKey)
    );
}

/** Vérifie que le workflow se déclenche bien sur une PR vers `main`. */
export function assertPullRequestToMain(workflow, label) {
    // YAML parse `on:` en clé booléenne `true` dans certains cas.
    const on = workflow?.on ?? workflow?.true;
    const pr = on?.pull_request;
    const branches = pr?.branches ?? [];
    if (!pr || !branches.includes('main')) {
        throw new Error(
            `${label} : ne se déclenche pas sur \`pull_request\` vers \`main\` — ` +
                `le modèle des status checks requis ne s'applique plus, revoir ce script.`
        );
    }
}

/** Ensemble des contextes bloquants attendus, calculé depuis `ci.yml`. */
export function expectedContexts(workflowContent, label = 'ci.yml') {
    let workflow;
    try {
        workflow = parseYaml(workflowContent);
    } catch (error) {
        throw new Error(`${label} : YAML invalide (${error.message})`, {
            cause: error,
        });
    }
    assertPullRequestToMain(workflow, label);

    const jobs = workflow?.jobs ?? {};
    const missingExclusions = [...STEP_LEVEL_REPORT_ONLY].filter(
        (key) => !(key in jobs)
    );
    if (missingExclusions.length) {
        throw new Error(
            `STEP_LEVEL_REPORT_ONLY référence des jobs absents de ${label} ` +
                `(${missingExclusions.join(', ')}) — renommage non répercuté ?`
        );
    }

    const contexts = new Set();
    for (const [jobKey, job] of Object.entries(jobs)) {
        if (isReportOnly(jobKey, job)) continue;
        for (const context of jobContexts(jobKey, job)) contexts.add(context);
    }
    return contexts;
}

/** Contextes déclarés dans le JSON de protection. */
export function declaredContexts(
    protectionContent,
    label = 'branch-protection'
) {
    let json;
    try {
        json = JSON.parse(protectionContent);
    } catch (error) {
        throw new Error(`${label} : JSON invalide (${error.message})`, {
            cause: error,
        });
    }
    const contexts = json?.required_status_checks?.contexts;
    if (!Array.isArray(contexts)) {
        throw new Error(
            `${label} : \`required_status_checks.contexts\` absent ou non-liste.`
        );
    }
    return contexts;
}

/** { missing, stale } — asymétries entre attendu et déclaré. */
export function diffContexts(expected, declared) {
    const declaredSet = new Set(declared);
    return {
        missing: [...expected].filter((c) => !declaredSet.has(c)).sort(),
        stale: declared.filter((c) => !expected.has(c)).sort(),
        duplicates: declared.filter((c, i) => declared.indexOf(c) !== i).sort(),
    };
}

// ─── File de fusion (`merge_group`) ─────────────────────────────────────────
// Docs GitHub : sans `merge_group`, la file attend un contrôle requis qui
// n'arrive jamais (« Managing a merge queue ») ; un job sauté par une
// condition rapporte « Success », et un job dont une dépendance échoue est
// sauté (« Troubleshooting required status checks »). La file fusionnerait
// alors sans le contrôle. Le groupe a pour ref `gh-readonly-queue/main/…`.

const isMapping = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const text = (value) =>
    value === null || value === undefined ? '' : String(value);

/** Erreur du déclencheur `merge_group` d'un workflow, ou `null`. */
export function mergeGroupTriggerError(workflow) {
    const on = workflow?.on ?? workflow?.true;
    // `on: merge_group` ou `on: [..., merge_group]` : déclenché, sans `types`.
    if ([on].flat().includes('merge_group'))
        return '`merge_group` sans `types`';
    if (!isMapping(on) || !('merge_group' in on))
        return 'ne se déclenche pas sur `merge_group`';
    const trigger = on.merge_group;
    if (!isMapping(trigger)) return '`merge_group` sans `types`';
    const filters = Object.keys(trigger).filter(
        (key) => key !== 'types' && key !== 'branches'
    );
    if (filters.length)
        return `filtre(s) ${filters.join(', ')} refusé(s) sous \`merge_group\``;
    if (JSON.stringify(trigger.types) !== '["checks_requested"]')
        return '`merge_group.types` doit valoir [checks_requested]';
    const { branches } = trigger;
    if (
        branches !== undefined &&
        (!Array.isArray(branches) ||
            !branches.includes('main') ||
            branches.some((b) => typeof b !== 'string' || b.startsWith('!')))
    )
        return '`merge_group.branches` doit inclure main, sans exclusion';
    return null;
}

/**
 * Jobs d'un workflow qui produisent un contexte requis, rapport seul compris :
 * `STEP_LEVEL_REPORT_ONLY` ne vaut que pour `ci.yml`, et un job sauté
 * rapporte « Success » même s'il porte `continue-on-error`.
 */
export function requiredJobs(workflow, declared) {
    const required = new Set(declared);
    const jobs = isMapping(workflow?.jobs) ? workflow.jobs : {};
    return Object.entries(jobs).filter(([key, job]) =>
        jobContexts(key, job).some((context) => required.has(context))
    );
}

const STEP_CONDITION_ROOTS = new Set(['steps', 'needs', 'matrix']);
const STATUS_FUNCTIONS = new Set(['success', 'failure', 'always', 'cancelled']);
const LITERALS = new Set(['true', 'false', 'null']);

/**
 * Contextes qu'une condition d'étape lit hors de ce que le job a lui-même
 * calculé (steps, needs, matrix, état du job). `[]` si aucun.
 */
export function stepConditionContexts(condition) {
    if (condition === undefined) return [];
    if (typeof condition !== 'string')
        return [`la valeur ${JSON.stringify(condition)}`];
    const wrapped = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition);
    const source = wrapped ? wrapped[1] : condition;
    const tokens = source.includes('${{') ? null : tokenizeExpression(source);
    if (tokens === null) return ['une forme non reconnue'];
    const foreign = tokens.filter(
        (token, index) =>
            IDENTIFIER.test(token) &&
            tokens[index - 1] !== '.' &&
            !LITERALS.has(token) &&
            !STEP_CONDITION_ROOTS.has(token) &&
            !(STATUS_FUNCTIONS.has(token) && tokens[index + 1] === '(')
    );
    return [...new Set(foreign)].map((token) => `\`${token}\``);
}

/**
 * Valeur d'une expression GitHub, pour le sous-ensemble que ce garde simule :
 * littéraux, chemins de contexte, `!`, `==` et `!=` entre valeurs de même
 * type, `&&`, `||`, parenthèses et `format()`. Tout le reste échoue : le garde
 * ne devine jamais.
 */
export function evaluateExpression(source, contexts) {
    const tokens = tokenizeExpression(source);
    const fail = () => {
        throw new Error(`expression non simulée : ${source.trim()}`);
    };
    if (tokens === null) fail();
    let at = 0;
    const take = (expected) => {
        const token = tokens[at++];
        if (token === undefined || (expected && token !== expected)) fail();
        return token;
    };
    // Types différents : GitHub convertit en nombre (docs « Evaluate
    // expressions », « loose equality ») ; non simulé.
    const equal = (a, b) => {
        const [left, right] = [a ?? null, b ?? null];
        if (typeof left !== typeof right) fail();
        return typeof left === 'string'
            ? left.toLowerCase() === right.toLowerCase()
            : left === right;
    };
    function primary() {
        const token = take();
        if (token === '(') {
            const value = or();
            take(')');
            return value;
        }
        if (token === '!') return !primary();
        if (token.startsWith("'"))
            return token.slice(1, -1).replace(/''/g, "'");
        if (/^[0-9]/.test(token)) return Number(token);
        if (LITERALS.has(token)) return JSON.parse(token);
        if (token === 'format' && tokens[at] === '(') {
            take('(');
            const args = [or()];
            while (tokens[at] === ',') {
                take(',');
                args.push(or());
            }
            take(')');
            // `{{` et `}}` sont des accolades échappées : non simulées.
            if (typeof args[0] !== 'string' || /\{\{|\}\}/.test(args[0]))
                fail();
            return args[0].replace(/\{(\d+)\}/g, (_, n) =>
                text(args[Number(n) + 1])
            );
        }
        if (!IDENTIFIER.test(token) || !Object.hasOwn(contexts, token)) fail();
        if (tokens[at] === '(') fail();
        let value = contexts[token];
        while (tokens[at] === '.') {
            take('.');
            const key = take();
            if (!IDENTIFIER.test(key)) fail();
            value =
                isMapping(value) && Object.hasOwn(value, key)
                    ? value[key]
                    : null;
        }
        return value;
    }
    function comparison() {
        let left = primary();
        while (tokens[at] === '==' || tokens[at] === '!=') {
            const negate = take() === '!=';
            left = equal(left, primary()) !== negate;
        }
        return left;
    }
    function and() {
        let left = comparison();
        while (tokens[at] === '&&') {
            take('&&');
            const right = comparison();
            left = left ? right : left;
        }
        return left;
    }
    function or() {
        let left = and();
        while (tokens[at] === '||') {
            take('||');
            const right = and();
            left = left ? left : right;
        }
        return left;
    }
    const value = or();
    if (at !== tokens.length) fail();
    return value;
}

/** Interpole les `${{ … }}` d'une chaîne, comme GitHub (null → vide). */
export function evaluateTemplate(template, contexts) {
    return String(template).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, source) =>
        text(evaluateExpression(source, contexts))
    );
}

/**
 * Contexte `github` d'une PR vers `main`, puis de deux entrées de file. La
 * doc ne garantit que le préfixe `gh-readonly-queue/{base_branch}` et une
 * branche par PR (`main/pr-1`, `main/pr-2`) : le suffixe simulé est libre.
 */
export function simulatedRuns(workflowName) {
    const run = (github) => ({ github: { workflow: workflowName, ...github } });
    const entry = (number, head, base, runId) => {
        const ref = `refs/heads/gh-readonly-queue/main/pr-${number}-${head}`;
        return run({
            event_name: 'merge_group',
            ref,
            sha: head,
            base_ref: '',
            head_ref: '',
            run_id: runId,
            event: {
                merge_group: {
                    head_sha: head,
                    head_ref: ref,
                    base_sha: base,
                    base_ref: 'refs/heads/main',
                },
            },
        });
    };
    return {
        pullRequest: run({
            event_name: 'pull_request',
            ref: 'refs/pull/7/merge',
            sha: 'a'.repeat(40),
            base_ref: 'main',
            head_ref: 'branche-7',
            run_id: '1',
            event: { pull_request: { number: 7 } },
        }),
        firstEntry: entry(7, 'b'.repeat(40), '0'.repeat(40), '2'),
        secondEntry: entry(8, 'c'.repeat(40), 'b'.repeat(40), '3'),
    };
}

/**
 * Un run de PR et un run de la file ne partagent jamais un groupe de
 * concurrence, ni deux entrées de la file : sinon l'un annule l'autre (le
 * nom de groupe ignore la casse, docs « Control the concurrency »).
 */
export function concurrencyErrors(label, workflow, jobs) {
    const runs = simulatedRuns(
        typeof workflow?.name === 'string' ? workflow.name : label
    );
    const sources = [
        ['workflow', workflow?.concurrency],
        ...jobs.map(([key, job]) => [`job ${key}`, job?.concurrency]),
    ];
    const errors = [];
    for (const [where, concurrency] of sources) {
        if (concurrency === undefined) continue;
        const template = isMapping(concurrency)
            ? concurrency.group
            : concurrency;
        try {
            const [pr, first, second] = [
                runs.pullRequest,
                runs.firstEntry,
                runs.secondEntry,
            ].map((context) =>
                evaluateTemplate(template, context).toLowerCase()
            );
            if (pr === first)
                errors.push(
                    `${label} › ${where} : une PR et son entrée de file partagent le groupe « ${first} » ; l'un annulerait l'autre.`
                );
            if (first === second)
                errors.push(
                    `${label} › ${where} : deux entrées de la file partagent le groupe « ${first} » ; l'une annulerait l'autre.`
                );
        } catch (error) {
            errors.push(
                `${label} › ${where} : groupe de concurrence non simulable (${error.message}) ; simplifier l'expression ou étendre ce garde.`
            );
        }
    }
    return errors;
}

/** Ce qui empêcherait un contexte requis de tourner vraiment dans la file. */
export function mergeQueueErrors(label, workflow, declared) {
    let jobs;
    try {
        jobs = requiredJobs(workflow, declared);
    } catch (error) {
        return [`${label} : ${error.message}`];
    }
    if (jobs.length === 0) return [];
    const errors = [];
    const trigger = mergeGroupTriggerError(workflow);
    if (trigger)
        errors.push(
            `${label} : ${trigger} ; la file attendrait des contextes requis qui n'arrivent jamais.`
        );
    const requiredKeys = new Set(jobs.map(([key]) => key));
    for (const [key, job] of jobs) {
        if (job.if !== undefined)
            errors.push(
                `${label} › ${key} : \`if: ${job.if}\` sur un job requis ; un job sauté rapporte « Success » et la file fusionnerait sans ce contrôle.`
            );
        const needs =
            job.needs === undefined
                ? []
                : [job.needs].flat().map((need) => String(need));
        for (const need of needs)
            if (!requiredKeys.has(need))
                errors.push(
                    `${label} › ${key} : dépend de \`${need}\`, qui n'est pas un contrôle requis ; son échec sauterait ce job, compté réussi.`
                );
        (Array.isArray(job.steps) ? job.steps : []).forEach((step, index) => {
            const foreign = stepConditionContexts(step?.if);
            if (foreign.length)
                errors.push(
                    `${label} › ${key} › étape ${step?.id ?? step?.name ?? index + 1} : \`if\` lit ${foreign.join(', ')} ; une étape d'un job requis ne se décide que sur steps, needs, matrix ou l'état du job.`
                );
        });
    }
    return [...errors, ...concurrencyErrors(label, workflow, jobs)];
}

/** Erreurs de file de fusion de chaque workflow de `<root>/.github/workflows`. */
export function workflowQueueErrors(root, declared) {
    const dir = join(root, WORKFLOWS_DIR);
    const files = readdirSync(dir)
        .filter((file) => /\.ya?ml$/.test(file))
        .sort();
    return files.flatMap((file) => {
        const label = `${WORKFLOWS_DIR}/${file}`;
        let workflow;
        try {
            workflow = parseYaml(readFileSync(join(dir, file), 'utf8'));
        } catch (error) {
            return [`${label} : YAML illisible (${error.message})`];
        }
        return mergeQueueErrors(label, workflow, declared);
    });
}

/**
 * Contrôle complet d'un dépôt : contextes requis ↔ jobs bloquants de
 * `ci.yml`, puis file de fusion. `ok` est la seule décision de sortie.
 */
export function checkRepository(root = ROOT) {
    const expected = expectedContexts(
        readFileSync(join(root, WORKFLOW_PATH), 'utf8')
    );
    const declared = declaredContexts(
        readFileSync(join(root, PROTECTION_PATH), 'utf8')
    );
    const { missing, stale, duplicates } = diffContexts(expected, declared);
    const queue = workflowQueueErrors(root, declared);
    const ok = [missing, stale, duplicates, queue].every(
        (list) => list.length === 0
    );
    return { expected, declared, missing, stale, duplicates, queue, ok };
}

function main() {
    const { expected, declared, missing, stale, duplicates, queue, ok } =
        checkRepository();

    console.log(
        `[check:branch-protection-contexts] ${expected.size} job(s) bloquant(s) ` +
            `dans ci.yml · ${declared.length} contexte(s) requis déclaré(s).`
    );

    if (queue.length) {
        console.error(
            '\n✖ Contexte(s) requis qui ne tourneraient pas vraiment dans la file de fusion :\n'
        );
        for (const error of queue) console.error(`  ✖ ${error}`);
    }

    if (ok) {
        console.log(
            '\n✔ `.github/branch-protection.main.json` couvre exactement les ' +
                'jobs bloquants de `ci.yml`, et chaque contexte requis tourne ' +
                'dans la file de fusion (`merge_group`, aucun job requis ' +
                'sauté, groupes de concurrence distincts).'
        );
        return;
    }

    if (missing.length) {
        console.error(
            '\n✖ Job(s) bloquant(s) de `ci.yml` absent(s) des contextes requis ' +
                '(fusionnable sans ce job vert) :\n'
        );
        for (const c of missing) console.error(`  + ${c}`);
    }
    if (stale.length) {
        console.error(
            '\n✖ Contexte(s) requis sans job correspondant dans `ci.yml` ' +
                "(GitHub attend un check qui n'arrivera jamais → toute PR bloquée) :\n"
        );
        for (const c of stale) console.error(`  - ${c}`);
    }
    if (duplicates.length) {
        console.error('\n✖ Contexte(s) requis en double :\n');
        for (const c of duplicates) console.error(`  ! ${c}`);
    }
    if (missing.length || stale.length || duplicates.length)
        console.error(
            '\nMettre à jour `required_status_checks.contexts` dans ' +
                '`.github/branch-protection.main.json` puis `bun run protect:main`. ' +
                'Un job volontairement en rapport seul se déclare dans ' +
                'STEP_LEVEL_REPORT_ONLY (ce fichier) avec sa justification.'
        );
    process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

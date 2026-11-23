#!/usr/bin/env node
/**
 * check-ci-wiring.mjs
 *
 * Audit Big Tech 2026-08-14 — root cause d'une classe de bug déjà rencontrée
 * 3 fois dans ce dépôt (check:pair-schema/check:corpus-tools en 2026-08-11,
 * check:dto-schema/check:pattern-nx:workflow-action/action-request/
 * read-only-view en 2026-08-14) : un script `check:*` ajouté à `check:all`
 * dans `package.json` est documenté comme "branché" alors que `check:all`
 * lui-même n'est JAMAIS invoqué automatiquement (ni CI, ni husky — c'est un
 * raccourci local pour développeur). Sans step CI ou hook husky dédié qui
 * l'appelle individuellement, un tel script est une pure intention : il ne
 * bloque jamais rien tant que personne ne pense à le lancer à la main.
 *
 * Ce script comble l'angle mort à la racine plutôt que de re-découvrir
 * chaque instance a posteriori par audit manuel : pour CHAQUE script
 * `check:*` référencé dans `check:all` (package.json), plus les gates coûteuses
 * explicitement obligatoires hors agrégateur, il vérifie que le script est
 * réellement invoqué par au moins un des deux mécanismes d'exécution
 * automatique réels du dépôt :
 *   1. Une step `run:` de `.github/workflows/ci.yml` (ou tout autre workflow
 *      sous `.github/workflows/`) qui invoque ce script — directement
 *      (`node tools/check-x.mjs`) ou via bun (`bun run check:x`).
 *   2. Un hook `.husky/*` qui l'invoque (`bun run check:x`).
 *
 * `check:all` lui-même est délibérément exclu de l'analyse (c'est
 * l'agrégateur, pas une des feuilles à vérifier).
 *
 * Usage : bun run check:ci-wiring
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { jobContexts } from './check-branch-protection-contexts.mjs';
import {
    NGINX_FRESHNESS_WORKFLOW,
    workflowEvents,
} from './check-workflow-privileges.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REQUIRED_STANDALONE_SCRIPTS = [
    'check:library-candidate-isolation',
    // X4-config : relais nginx, en CI Linux seulement (Docker, registre public).
    'check:nginx-relay',
    // NGINX-FRAICHEUR (C1) : structure de l'image (a), sans réseau et
    // bloquante en CI ; fraîcheur (b) contre le registre, dans son seul
    // workflow quotidien. Leurs appels exacts : nginxWiringErrors.
    'check:nginx-image',
    'check:nginx-digest',
    'check:nginx-relay-browser',
    'check:library-setup-integration',
];

export function workflowRunCommands(content, label = 'workflow') {
    let workflow;
    try {
        workflow = parseYaml(content);
    } catch (error) {
        throw new Error(`${label}: YAML invalide (${error.message})`, {
            cause: error,
        });
    }
    const commands = [];
    for (const job of Object.values(workflow?.jobs ?? {})) {
        for (const step of job?.steps ?? []) {
            if (typeof step?.run === 'string') commands.push(step.run);
        }
    }
    return commands;
}

export function hookCommands(content) {
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
}

export function commandSegments(command) {
    return command
        .split(/\r?\n/)
        .flatMap((line) => line.split(/\s*(?:&&|\|\||;)\s*/))
        .map((segment) => segment.trim());
}

export function commandInvokes(command, invocation) {
    return commandSegments(command).some(
        (segment) =>
            segment === invocation || segment.startsWith(`${invocation} `)
    );
}

export function packageToolInvocations(definition) {
    return definition
        .split(/\s*&&\s*/)
        .map((command) => command.trim())
        .filter((command) =>
            /^node(?:\s+--test)?\s+tools\/.+\.mjs(?:\s|$)/.test(command)
        );
}

// ─── NGINX-FRAICHEUR (C1) ───────────────────────────────────────────────────
// La structure (a) bloque la CI des PR et de main ; la fraîcheur (b), qui
// dépend du registre, ne tourne que dans son workflow quotidien. Un appel est
// exact si l'étape ne contient que lui : son `run`, aux blancs de bord près,
// est égal à l'une des deux formes admises par isWired, `bun run <script>` ou
// la définition package.json réduite à une seule commande Node feuille. Ni
// argument, ni préfixe, ni suffixe : `|| true`, `; true` ou une ligne `exit 0`
// rendraient l'étape verte malgré l'échec du script.
// L'absence de (b) se juge sur toute mention, quelle qu'en soit la forme
// (`bun`, `npm run`, `node ./…`, composition dans un autre script) : une
// forme que l'appel exact ignore ne doit pas le ramener dans la CI des PR.
export const NGINX_STRUCTURE_SCRIPT = 'check:nginx-image';
export const NGINX_FRESHNESS_SCRIPT = 'check:nginx-digest';
const FRESHNESS_EVENTS = ['schedule', 'workflow_dispatch'];
const FRESHNESS_MENTION = /check:nginx-digest|check-nginx-digest\.mjs/;

function exactForms(script, pkgScripts) {
    const definition = pkgScripts?.[script];
    const leaves =
        typeof definition === 'string'
            ? packageToolInvocations(definition)
            : [];
    const single = leaves.length === 1 && leaves[0] === definition.trim();
    return [`bun run ${script}`, ...(single ? leaves : [])];
}

function runSteps(workflow, matches) {
    const found = [];
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {}))
        for (const step of job?.steps ?? [])
            if (typeof step?.run === 'string' && matches(step.run))
                found.push({ workflow, jobId, job, step });
    return found;
}

const exactSteps = (workflow, forms) =>
    runSteps(workflow, (run) => forms.some((form) => run.trim() === form));

const freshnessMentions = (workflow) =>
    runSteps(workflow, (run) => FRESHNESS_MENTION.test(run));

// Modèle de menace : cette garde attrape les erreurs PLAUSIBLES de câblage,
// celles d'un auteur de bonne foi qui touche un workflow. Un contournement
// délibéré par l'auteur d'une PR (`env` comme `BASH_ENV`, `NODE_OPTIONS` ou
// `PATH`, `container`, une étape précédente qui écrit `$GITHUB_ENV` ou
// `$GITHUB_PATH`) n'est pas fermé ici : il relève de la relecture des PR.
// `.github/CODEOWNERS` couvre `/.github/`, workflows compris, et
// `.github/branch-protection.main.json` exige la revue de ses propriétaires.
//
// Chaîne `needs` : un job sauté compte comme réussi pour un check requis, et
// les jobs qui en dépendent sont sautés avec lui. Les jobs dont dépend celui
// de l'étape, de proche en proche, sont lus dans le workflow : aucun n'a
// d'`if`. Un `needs` vers un job absent du workflow est refusé. La chaîne
// donne chaque job avec sa clé : `[id, job]`, `job` valant `null` s'il manque.
function needsChain(workflow, job) {
    const chain = [];
    const pending = [job];
    const seen = new Set();
    while (pending.length > 0)
        for (const id of [pending.pop().needs ?? []].flat()) {
            if (seen.has(id)) continue;
            seen.add(id);
            const needed = Object.hasOwn(workflow.jobs ?? {}, id)
                ? (workflow.jobs[id] ?? null)
                : null;
            chain.push([id, needed]);
            if (needed !== null) pending.push(needed);
        }
    return chain;
}

// Chaîne `needs` de (a) (G-3) : un job qui ÉCHOUE saute aussi ceux qui en
// dépendent, et le check requis de (a), sauté, passerait. Chaque job de la
// chaîne est donc lui-même requis sur main : tous ses noms de check (`name`
// ou clé, matrice dépliée), calculés par `jobContexts`, la fonction de
// check:branch-protection-contexts, figurent parmi les contextes requis.
// Son échec bloque alors la fusion de lui-même. Un nom non résolu est refusé.
// (b) n'est pas concerné : un run rouge du quotidien ouvre l'issue.
const requiredChain = ({ workflow, job }, requiredContexts) =>
    needsChain(workflow, job).every(([id, needed]) => {
        try {
            return jobContexts(id, needed).every((context) =>
                requiredContexts.includes(context)
            );
        } catch {
            return false;
        }
    });

// Ni condition ni erreur tolérée : l'étape et son job échouent vraiment. Et
// `run` s'exécute tel quel, sous le shell et dans le dossier par défaut de
// GitHub : ni `shell` ni `working-directory` sur l'étape, ni `defaults.run`,
// qui les fixe pour tout un job ou tout un workflow. Un `shell: 'true {0}'`,
// ou un dossier dont le package.json redéfinit le script, rendrait l'étape
// verte sans le lancer. Aucune n'est nécessaire à un appel seul.
const blocking = ({ workflow, job, step }) =>
    [
        job.if,
        step.if,
        job['continue-on-error'],
        step['continue-on-error'],
        step.shell,
        step['working-directory'],
        job.defaults?.run,
        workflow.defaults?.run,
    ].every((value) => value === undefined) &&
    needsChain(workflow, job).every(
        ([, needed]) => needed !== null && needed.if === undefined
    );

/**
 * @param {{ file: string, workflow: object }[]} workflows workflows lus
 * @param {Record<string, string>} pkgScripts scripts de package.json
 * @param {string[]} requiredContexts contextes requis sur main
 */
export function nginxWiringErrors(workflows, pkgScripts, requiredContexts) {
    const errors = [];
    const structure = exactForms(NGINX_STRUCTURE_SCRIPT, pkgScripts);
    const freshness = exactForms(NGINX_FRESHNESS_SCRIPT, pkgScripts);
    const byFile = new Map(
        workflows.map(({ file, workflow }) => [file, workflow])
    );
    for (const [file, workflow] of byFile) {
        if (file === NGINX_FRESHNESS_WORKFLOW) continue;
        for (const { jobId } of freshnessMentions(workflow))
            errors.push(
                `${file} › ${jobId} : ${NGINX_FRESHNESS_SCRIPT} dépend du registre ; il ne tourne que dans ${NGINX_FRESHNESS_WORKFLOW}`
            );
    }
    for (const [name, definition] of Object.entries(pkgScripts ?? {}))
        if (
            name !== NGINX_FRESHNESS_SCRIPT &&
            typeof definition === 'string' &&
            FRESHNESS_MENTION.test(definition)
        )
            errors.push(
                `package.json › ${name} : compose ${NGINX_FRESHNESS_SCRIPT} ; une étape qui l'appelle le ferait tourner hors de ${NGINX_FRESHNESS_WORKFLOW}`
            );
    const daily = byFile.get(NGINX_FRESHNESS_WORKFLOW);
    if (daily === undefined) {
        errors.push(
            `${NGINX_FRESHNESS_WORKFLOW} absent : la fraîcheur (b) n'est plus vérifiée`
        );
    } else {
        const events = workflowEvents(daily) ?? [];
        if (JSON.stringify(events) !== JSON.stringify(FRESHNESS_EVENTS))
            errors.push(
                `${NGINX_FRESHNESS_WORKFLOW} : déclencheurs ${FRESHNESS_EVENTS.join(' + ')} seulement, trouvé ${events.join(', ') || '(aucun)'}`
            );
        const calls = freshnessMentions(daily);
        const exact = exactSteps(daily, freshness);
        if (calls.length !== 1 || exact.length !== 1 || !blocking(exact[0]))
            errors.push(
                `${NGINX_FRESHNESS_WORKFLOW} : un seul appel exact de ${NGINX_FRESHNESS_SCRIPT} (${freshness.join(' ou ')}), sans condition (étape, job ou chaîne needs), continue-on-error, shell, working-directory ni defaults.run`
            );
    }
    const ci = byFile.get('ci.yml');
    const ciEvents = workflowEvents(ci ?? {}) ?? [];
    const required = exactSteps(ci, structure).filter(
        (call) => blocking(call) && requiredContexts.includes(call.job.name)
    );
    if (
        !ciEvents.includes('pull_request') ||
        !ciEvents.includes('push') ||
        !required.some((call) => requiredChain(call, requiredContexts))
    )
        errors.push(
            `ci.yml : ${NGINX_STRUCTURE_SCRIPT} doit être appelé exactement (${structure.join(' ou ')}), sans condition (étape, job ou chaîne needs), continue-on-error, shell, working-directory ni defaults.run, dans un job requis sur main dont toute la chaîne needs est requise, en PR et sur push`
        );
    return errors;
}

function loadCheckAllScripts() {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const checkAll = pkg.scripts?.['check:all'];
    if (!checkAll) {
        console.error(
            'Erreur : package.json ne déclare plus de script "check:all" — ce script dépend de son existence pour connaître la liste des gates attendus.'
        );
        process.exit(2);
    }
    // "bun run check:x" répété, chaîné par " && "
    const re = /bun run (check:[a-zA-Z0-9:_-]+)/g;
    const scripts = [];
    let m;
    while ((m = re.exec(checkAll))) {
        scripts.push(m[1]);
    }
    if (scripts.length === 0) {
        console.error(
            'Erreur : aucun "bun run check:*" trouvé dans check:all — regex désynchronisée de la forme réelle de la commande ?'
        );
        process.exit(2);
    }
    return scripts;
}

function loadAutomationSources() {
    const sources = [];

    const workflowsDir = join(ROOT, '.github/workflows');
    let workflowFiles = [];
    try {
        workflowFiles = readdirSync(workflowsDir).filter(
            (f) => f.endsWith('.yml') || f.endsWith('.yaml')
        );
    } catch {
        // dossier absent — pas fatal ici, juste aucune source CI.
    }
    for (const file of workflowFiles) {
        const label = `.github/workflows/${file}`;
        sources.push({
            label,
            commands: workflowRunCommands(
                readFileSync(join(workflowsDir, file), 'utf8'),
                label
            ),
        });
    }

    for (const hook of ['pre-commit', 'pre-push', 'commit-msg']) {
        const path = join(ROOT, '.husky', hook);
        try {
            sources.push({
                label: `.husky/${hook}`,
                commands: hookCommands(readFileSync(path, 'utf8')),
            });
        } catch {
            // hook absent — pas fatal, juste aucune source pour celui-là.
        }
    }

    return sources;
}

function loadParsedWorkflows() {
    const directory = join(ROOT, '.github/workflows');
    return readdirSync(directory)
        .filter((file) => /\.ya?ml$/.test(file))
        .sort()
        .map((file) => ({
            file,
            workflow: parseYaml(readFileSync(join(directory, file), 'utf8')),
        }));
}

/**
 * Un script est "câblé" si son nom apparaît dans une source d'automatisation
 * — soit en toutes lettres (`bun run check:x`), soit via l'appel direct au
 * fichier node sous-jacent (on tolère cette forme : plusieurs jobs CI
 * appellent `node tools/check-x.mjs` plutôt que `bun run check:x` pour
 * éviter une installation `bun` complète dans des jobs qui n'en ont pas
 * besoin par ailleurs — même résultat, forme différente, cf. jobs
 * `docs-freshness`/`secrets` existants).
 */
function isWired(scriptName, pkgScripts, sources) {
    for (const { commands } of sources) {
        if (
            commands.some((command) =>
                commandInvokes(command, `bun run ${scriptName}`)
            )
        )
            return true;
        if (
            commands.some((command) =>
                commandInvokes(command, `bunx nx run ${scriptName}`)
            )
        )
            return true;
    }
    // Repli : lorsqu'une step développe le script package.json au lieu de
    // l'appeler par son nom, TOUTES ses commandes Node feuilles doivent être
    // réellement exécutées. Une seule mention de fichier ne suffit pas.
    const def = pkgScripts[scriptName] ?? '';
    const leaves = packageToolInvocations(def);
    if (leaves.length > 0) {
        return leaves.every((leaf) =>
            sources.some(({ commands }) =>
                commands.some((command) => commandInvokes(command, leaf))
            )
        );
    }
    return false;
}

async function main() {
    const { repositoryRuntimeErrors } =
        await import('./runtime-version-policy.mjs');
    const runtimeErrors = repositoryRuntimeErrors(ROOT);
    if (runtimeErrors.length) throw new Error(runtimeErrors.join('\n'));
    const scripts = [
        ...new Set([...loadCheckAllScripts(), ...REQUIRED_STANDALONE_SCRIPTS]),
    ];
    const sources = loadAutomationSources();
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

    const undefinedScripts = REQUIRED_STANDALONE_SCRIPTS.filter(
        (script) => typeof pkg.scripts?.[script] !== 'string'
    );
    if (undefinedScripts.length) {
        console.error(
            `✖ Gate(s) CI obligatoire(s) absente(s) de package.json : ${undefinedScripts.join(', ')}`
        );
        process.exit(1);
    }

    const nginxErrors = nginxWiringErrors(
        loadParsedWorkflows(),
        pkg.scripts,
        JSON.parse(
            readFileSync(
                join(ROOT, '.github/branch-protection.main.json'),
                'utf8'
            )
        ).required_status_checks.contexts
    );
    if (nginxErrors.length) {
        for (const error of nginxErrors) console.error(`✖ ${error}`);
        process.exit(1);
    }

    const orphans = scripts.filter((s) => !isWired(s, pkg.scripts, sources));

    console.log(
        `[check:ci-wiring] ${scripts.length} gate(s) obligatoire(s), dont ${REQUIRED_STANDALONE_SCRIPTS.length} hors check:all ; sources d'automatisation scannées : ${sources.map((s) => s.label).join(', ')}.`
    );

    if (orphans.length > 0) {
        console.error(
            "\n✖ Script(s) présent(s) dans check:all mais jamais invoqué(s) individuellement par CI ou husky (donc jamais réellement bloquant, quoi qu'affirme la documentation) :\n"
        );
        for (const s of orphans) {
            console.error(`  ${s}`);
        }
        console.error(
            '\nAjouter une step CI (.github/workflows/ci.yml) ou un hook husky (.husky/*) ' +
                'qui invoque ce script individuellement — "branché dans check:all" seul ne ' +
                "rend rien bloquant, check:all lui-même n'est jamais exécuté automatiquement."
        );
        process.exit(1);
    }

    console.log(
        "\n✔ Toutes les gates obligatoires sont câblées à au moins un mécanisme d'exécution automatique (CI ou husky)."
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

#!/usr/bin/env node
// Mise à jour d'une appli sous plan (cadrage § 20 ; lot 2, commit 6c). Portée :
// tout le produit, sans `--app`. Le `--dry-run` affiche le plan, sans rien
// écrire ; `--expect-plan <plan_id>` applique exactement ce plan, ou refuse
// s'il a changé. L'application imprime la ligne `RAPPORT_INTERFACE` (lecture
// A : rapportée, jamais bloquante) ; une faute du générateur sort en erreur
// (`UPDATE_GENERATOR_BROKEN`).
import { pathToFileURL } from 'node:url';

import {
    planApplicationUpdate,
    publicApplicationUpdatePlan,
} from './generator-platform/core/application-update.mjs';
import { publishApplicationUpdate } from './generator-platform/core/application-update-transaction.mjs';
import { toolEnv } from './generator-platform/core/atelier-signature.mjs';
import { repositoryRoot } from './generator-platform/validate-ir.mjs';

// Code d'erreur d'usage de la ligne de commande.
const CLI_USAGE = toolEnv('CLI_USAGE');

function fail(message) {
    throw Object.assign(new Error(message), { code: CLI_USAGE });
}

export function parseArgs(argv) {
    const options = { dryRun: false };
    const names = new Map([
        ['--target-root', 'targetRoot'],
        ['--expect-plan', 'expectedPlanId'],
    ]);
    const seen = new Set();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (seen.has(argument)) fail('Une option ne peut pas être répétée.');
        seen.add(argument);
        if (argument === '--dry-run') options.dryRun = true;
        else if (names.has(argument)) {
            const value = argv[++index];
            if (!value || value.startsWith('--'))
                fail('Valeur d’option requise.');
            options[names.get(argument)] = value;
        } else fail('Argument inconnu ou option interdite.');
    }
    if (!options.targetRoot) fail('--target-root est requis.');
    if (options.dryRun === Boolean(options.expectedPlanId))
        fail('Choisir exactement --dry-run ou --expect-plan <plan_id>.');
    if (
        options.expectedPlanId &&
        !/^[a-f0-9]{64}$/.test(options.expectedPlanId)
    )
        fail('--expect-plan exige un plan_id SHA-256 valide.');
    return options;
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const common = { ...options, workspaceRoot: repositoryRoot };
    if (options.dryRun) {
        const plan = await planApplicationUpdate(common);
        process.stdout.write(
            `${JSON.stringify(publicApplicationUpdatePlan(plan), null, 2)}\n`
        );
        return;
    }
    const result = await publishApplicationUpdate(common);
    process.stdout.write(
        `${JSON.stringify(
            {
                schema_version: '1.0.0',
                plan_id: result.plan_id,
                replayed: result.replayed,
                ...(result.replayed
                    ? {}
                    : {
                          apps: result.plan.apps.map(
                              ({ app_name, status }) => ({
                                  app_name,
                                  status,
                              })
                          ),
                      }),
            },
            null,
            2
        )}\n`
    );
    if (result.report) process.stderr.write(`${result.report}\n`);
}

if (
    process.argv[1] &&
    pathToFileURL(process.argv[1]).href === import.meta.url
) {
    main().catch((error) => {
        const known =
            error.code === CLI_USAGE ||
            error.message.startsWith('external application:');
        const locked = error.message.startsWith('another generation owns');
        process.stderr.write(
            `${known ? error.message : locked ? 'Une autre commande tient le verrou de ce produit ; relancer quand elle est terminée.' : 'Mise à jour refusée ; inspecter le produit localement.'}\n`
        );
        process.exitCode = 1;
    });
}

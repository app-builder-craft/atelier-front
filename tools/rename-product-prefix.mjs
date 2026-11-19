#!/usr/bin/env node
// Renommage du préfixe d'un produit extérieur (lot MARQUE, commit 3). Le
// `--dry-run` affiche le plan, sans rien écrire ; `--expect-plan <plan_id>`
// publie exactement ce plan, ou refuse s'il a changé (cadrage § 19, point 1).
import { pathToFileURL } from 'node:url';

import { toolEnv } from './generator-platform/core/atelier-signature.mjs';
import {
    planProductPrefixRename,
    publicProductPrefixRenamePlan,
} from './generator-platform/core/product-prefix-rename.mjs';
import { publishProductPrefixRename } from './generator-platform/core/product-prefix-rename-transaction.mjs';
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
        ['--to', 'to'],
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
    if (!options.targetRoot || !options.to)
        fail('--target-root et --to sont requis.');
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
        const plan = await planProductPrefixRename(common);
        process.stdout.write(
            `${JSON.stringify(publicProductPrefixRenamePlan(plan), null, 2)}\n`
        );
        return;
    }
    const result = await publishProductPrefixRename(common);
    process.stdout.write(
        `${JSON.stringify(
            {
                schema_version: '1.0.0',
                plan_id: result.plan_id,
                status: result.status,
                prefix: {
                    before: result.plan.prefix_before,
                    after: result.plan.prefix_after,
                },
            },
            null,
            2
        )}\n`
    );
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
            `${known ? error.message : locked ? 'Une autre commande tient le verrou de ce produit ; relancer quand elle est terminée.' : 'Renommage refusé ; inspecter le produit localement.'}\n`
        );
        process.exitCode = 1;
    });
}

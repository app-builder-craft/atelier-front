#!/usr/bin/env node
// Reprise explicite d'une mise à jour interrompue (lot 2, commit 6c). Sans
// plan : avant le point `verified`, retour à l'état d'avant ; après,
// nettoyage seul. Un état ambigu est refusé et rien n'est déplacé.
import { pathToFileURL } from 'node:url';

import { recoverApplicationUpdate } from './generator-platform/core/application-update-transaction.mjs';
import { toolEnv } from './generator-platform/core/atelier-signature.mjs';
import { repositoryRoot } from './generator-platform/validate-ir.mjs';

// Code d'erreur d'usage de la ligne de commande.
const CLI_USAGE = toolEnv('CLI_USAGE');

function fail(message) {
    throw Object.assign(new Error(message), { code: CLI_USAGE });
}

export function parseArgs(argv) {
    if (argv.length !== 2 || argv[0] !== '--target-root')
        fail('--target-root est requis, seul.');
    if (!argv[1] || argv[1].startsWith('--')) fail('Valeur d’option requise.');
    return { targetRoot: argv[1] };
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const result = await recoverApplicationUpdate({
        workspaceRoot: repositoryRoot,
        ...options,
    });
    process.stdout.write(
        `${JSON.stringify(
            {
                schema_version: '1.0.0',
                status: result.recovered ? 'recovered' : 'nothing-to-recover',
                ...(result.recovered ? { direction: result.direction } : {}),
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
            `${known ? error.message : locked ? 'Une autre commande tient le verrou de ce produit ; relancer la reprise quand elle est terminée.' : 'Reprise refusée ; inspecter le produit localement.'}\n`
        );
        process.exitCode = 1;
    });
}

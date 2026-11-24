#!/usr/bin/env node
// Reprise explicite d'une transaction interrompue d'une application
// extérieure (ADR-0103 ; lot 2, V5.2 : création ou publication). Sans plan :
// la reprise lit le journal de la transaction, finit un état `verified`,
// annule un état d'avant `verified` décidé par l'état observé, ou refuse un
// état ambigu et laisse tout en place.
import { pathToFileURL } from 'node:url';

import { recoverApplicationPublication } from './generator-platform/core/application-publication.mjs';
import { toolEnv } from './generator-platform/core/atelier-signature.mjs';
import { repositoryRoot } from './generator-platform/validate-ir.mjs';

const GUIDE = 'docs/etape-b/external-application-creation.md';

// Code d'erreur d'usage de la ligne de commande.
const CLI_USAGE = toolEnv('CLI_USAGE');

function fail(message) {
    throw Object.assign(new Error(message), { code: CLI_USAGE });
}

// Lot 2 : chaque arbre est comparé à sa liste d'artéfacts inscrite au journal.
const DRIFT = {
    unlisted: 'fichier absent de la liste de cet arbre au journal',
    modified: 'contenu différent de la liste de cet arbre au journal',
    missing: 'fichier inscrit au journal mais absent',
    entry: 'entrée spéciale ou lien symbolique',
    tree: 'arbre non conforme à sa liste au journal',
    several: 'plusieurs transactions interrompues pour cette application',
    orphan: 'arbre de travail sans journal',
};

// M-3 : premier écart, en chemin relatif au produit, jamais un chemin local.
// Le nom est cité en JSON pour qu'aucun caractère du produit ne s'interprète.
export function describeDrift({ tree, path, kind }) {
    const where = path === null ? tree : `${tree}/${path}`;
    return `Écart : ${JSON.stringify(where)} (${DRIFT[kind] ?? kind}).`;
}

export function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 2) {
        const [argument, value] = [argv[index], argv[index + 1]];
        if (!['--target-root', '--app'].includes(argument))
            fail(`Argument inconnu : ${argument}`);
        if (!value || value.startsWith('--')) fail('Valeur d’option requise.');
        const key = argument === '--app' ? 'appName' : 'targetRoot';
        if (key in options) fail('Une option ne peut pas être répétée.');
        options[key] = value;
    }
    if (!options.targetRoot || !options.appName)
        fail('--target-root et --app sont requis.');
    return options;
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const result = await recoverApplicationPublication({
        workspaceRoot: repositoryRoot,
        ...options,
    });
    console.log(
        JSON.stringify(
            {
                schema_version: '1.0.0',
                app_name: options.appName,
                status: result.recovered ? 'recovered' : 'nothing-to-recover',
                transactions: result.transactions,
            },
            null,
            2
        )
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
        console.error(
            `❌ ${known ? error.message : locked ? 'Une autre commande tient le verrou de cette application ; relancer la reprise quand elle est terminée.' : 'Reprise refusée ; inspecter le produit localement.'}`
        );
        if (error.message.includes('ambiguous interrupted application')) {
            if (error.drift) console.error(`   ${describeDrift(error.drift)}`);
            console.error(
                `   Rien n'a été déplacé. Marche à suivre : ${GUIDE}, section « Ownership et reprise ».`
            );
        }
        process.exitCode = 1;
    });
}

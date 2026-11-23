#!/usr/bin/env node
/**
 * Contrôle des journaux d'outil : tout journal d'outil rangé sous le dossier de
 * signature du dépôt (`SIGNATURE.dir`) doit être ignoré par Git.
 *
 * Un journal d'exécution non ignoré rend le dépôt sale et peut faire échouer une
 * publication transactionnelle après les étapes coûteuses. Ce contrôle dérive
 * donc la liste depuis le CODE : un chemin sous le dossier de signature ne
 * s'écrit que par `signaturePath('<nom>', …)` (le contrôle des sources uniques
 * refuse le littéral), et chaque `<nom>` d'outil ainsi appelé doit être
 * ignoré, sauf les dossiers GOUVERNÉS qu'exporte la signature
 * (`SIGNATURE_FILES`), versionnés.
 * Un nouveau journal non ignoré échoue sans que personne ait à y penser ; un
 * balayage vide échoue aussi (fermé par défaut).
 *
 * Couplage avec `check:identity-sources` : un chemin LITTÉRAL sous le dossier
 * de signature n'est plus lu ici comme un journal ; c'est l'autre contrôle
 * qui le refuse. Les deux formes non littérales sont lues ici : l'appel
 * `signaturePath('<nom>'…)` et le gabarit `` `${SIGNATURE.dir}/<nom>…` ``,
 * pour qu'aucune voie n'échappe aux deux contrôles.
 */
import { execFileSync } from 'node:child_process';
import {
    globSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    internalName,
    SIGNATURE,
    SIGNATURE_FILES,
} from './generator-platform/core/atelier-signature.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Noms GOUVERNÉS sous le dossier de signature, dérivés de `SIGNATURE_FILES` :
 * manifeste, bibliothèques et pages d'une app (`apps/<app>/<dir>/…`),
 * disposition du produit, pierres tombales des applis retirées. Ils sont
 * versionnés : ce ne sont pas des journaux d'exécution.
 */
export const GOVERNED = new Set(
    Object.values(SIGNATURE_FILES).map(
        (path) =>
            path.slice(SIGNATURE.dir.length + 1).match(/^([a-z][a-z0-9-]*)/)[1]
    )
);

// `signaturePath('<nom>'…)` désigne un répertoire de journal ;
// `signaturePath('<nom>.<ext>')` est un fichier. Le nom doit être complet et
// littéral : la quote fermante suit immédiatement, sinon `escape.txt`
// donnerait `escape`.
const JOURNAL_CALL = /\bsignaturePath\(\s*(['"`])([a-z][a-z0-9-]*)\1\s*[,)]/g;
// Gabarit `${SIGNATURE.dir}/<nom>` : le nom doit être complet (ni `.`, ni
// caractère de nom ensuite), comme pour l'ancien littéral.
const JOURNAL_TEMPLATE =
    /\$\{\s*SIGNATURE\.dir\s*\}\/([a-z][a-z0-9-]*)(?![\w.-])/g;

export function signatureDirectoryNames(source) {
    return [
        ...[...source.matchAll(JOURNAL_CALL)].map(([, , name]) => name),
        ...[...source.matchAll(JOURNAL_TEMPLATE)].map(([, name]) => name),
    ];
}

export function scanSignatureDirectories(root = ROOT) {
    const names = new Set();
    for (const file of globSync('tools/**/*.mjs', { cwd: root })) {
        // Les tests portent des noms d'exemple, pas des journaux d'outil.
        if (file.endsWith('.test.mjs')) continue;
        const source = readFileSync(join(root, file), 'utf8');
        for (const name of signatureDirectoryNames(source)) {
            if (!GOVERNED.has(name)) names.add(name);
        }
    }
    return [...names].sort();
}

export function ignoredByGit(root, relativePath) {
    try {
        execFileSync('git', ['-C', root, 'check-ignore', '-q', relativePath], {
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
}

const PROBE = `${SIGNATURE.dir}-ignore-probe`;

export function verifySignatureJournalsIgnored(root = ROOT) {
    const errors = [];
    const names = scanSignatureDirectories(root);
    if (names.length === 0)
        errors.push(`aucun journal ${SIGNATURE.dir} détecté — scan cassé`);
    for (const name of names) {
        // `check-ignore` répond sur un chemin, existant ou non ; on crée une
        // sonde réelle pour couvrir aussi les motifs qui exigent un fichier.
        const probeDirectory = join(root, SIGNATURE.dir, name);
        const probe = join(probeDirectory, PROBE);
        let created = false;
        try {
            mkdirSync(probeDirectory, { recursive: true });
            writeFileSync(probe, '');
            created = true;
            if (!ignoredByGit(root, `${SIGNATURE.dir}/${name}/${PROBE}`)) {
                errors.push(
                    `${SIGNATURE.dir}/${name}/ n'est pas ignoré par Git : ce journal salirait le dépôt et ferait échouer la publication`
                );
            }
        } finally {
            if (created) rmSync(probe, { force: true });
            rmSync(probeDirectory, { recursive: true, force: true });
        }
    }
    return { ok: errors.length === 0, names, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const result = verifySignatureJournalsIgnored();
    if (!result.ok) {
        console.error(`\n❌ Journaux ${SIGNATURE.dir} non ignorés :`);
        for (const error of result.errors) console.error(`  - ${error}`);
        process.exitCode = 1;
    } else {
        console.log(
            `✔ check:${internalName('journals-ignored')} — ${result.names.length} journal(aux) d'outil sous ${SIGNATURE.dir}/, tous ignorés par Git.`
        );
    }
}

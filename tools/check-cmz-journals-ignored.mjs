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
 * ignoré, sauf ceux qui sont relatifs à une app ou au produit, donc gouvernés.
 * Un nouveau journal non ignoré échoue sans que personne ait à y penser ; un
 * balayage vide échoue aussi (fermé par défaut).
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
} from './generator-platform/core/atelier-signature.mjs';
import { EXTERNAL_WORKSPACE_CMZ } from './generator-platform/renderers/application-workspace-renderer.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Répertoires de signature portés par une APPLICATION (`apps/<app>/<dir>/…`),
 * donc versionnés : ce sont des artefacts gouvernés, pas des journaux
 * d'exécution.
 */
export const APP_SCOPED = new Set(['app-manifest', 'libraries', 'pages']);

const PRODUCT_SCOPED = new Set(
    Object.values(EXTERNAL_WORKSPACE_CMZ).map(
        (path) =>
            path.slice(SIGNATURE.dir.length + 1).match(/^([a-z][a-z0-9-]*)/)[1]
    )
);

// `signaturePath('<nom>'…)` désigne un répertoire de journal ;
// `signaturePath('<nom>.<ext>')` est un fichier. Le nom doit être complet et
// littéral : la quote fermante suit immédiatement, sinon `escape.txt`
// donnerait `escape`.
const JOURNAL_CALL = /\bsignaturePath\(\s*(['"`])([a-z][a-z0-9-]*)\1\s*[,)]/g;

export function cmzDirectoryNames(source) {
    return [...source.matchAll(JOURNAL_CALL)].map(([, , name]) => name);
}

export function scanCmzDirectories(root = ROOT) {
    const names = new Set();
    for (const file of globSync('tools/**/*.mjs', { cwd: root })) {
        // Les tests portent des noms d'exemple, pas des journaux d'outil.
        if (file.endsWith('.test.mjs')) continue;
        const source = readFileSync(join(root, file), 'utf8');
        for (const name of cmzDirectoryNames(source)) {
            if (!APP_SCOPED.has(name) && !PRODUCT_SCOPED.has(name))
                names.add(name);
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

export function verifyCmzJournalsIgnored(root = ROOT) {
    const errors = [];
    const names = scanCmzDirectories(root);
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
    const result = verifyCmzJournalsIgnored();
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

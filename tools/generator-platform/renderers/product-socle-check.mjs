import { staleSources, UPDATE_HINT } from '../core/application-sources.mjs';
import { SIGNATURE_FILES } from '../core/atelier-signature.mjs';
import {
    APPS_ROOT,
    INTERFACE_PAGES_DIR,
    interfaceLibraryName,
    LIBS_ROOT,
} from '../core/socle-names.mjs';

// Lot 2, commit 3 (v2 R2.4 ; v3 V3.5, manque 8 ; L-1) : vérificateur scellé
// PAR APPLI, `<sig>/support/check-socle.mjs --app <app>`, cible `check-socle`
// du socle : les contrôles d'espace (`check-workspace.mjs`, intégrité), puis,
// pour CETTE appli, la fraîcheur de sa liaison (`staleSources`, texte de
// l'atelier) et les dossiers de page de l'interface absents de sa
// conception. Tous les écarts sont écrits d'un coup, un par ligne, chemins
// relatifs au produit ; l'espace est chargé à l'appel (la preuve légère lit
// `socleDrifts` sans charger TypeScript).
export function socleCheck() {
    return `import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APPS = ${JSON.stringify(APPS_ROOT)};
const APP_MANIFEST = ${JSON.stringify(SIGNATURE_FILES.appManifest)};
const PAGES = (app) => ${JSON.stringify(LIBS_ROOT + '/')} + app + ${JSON.stringify(interfaceLibraryName('') + '/' + INTERFACE_PAGES_DIR)};
const UPDATE_HINT = ${JSON.stringify(UPDATE_HINT)};

class SocleDrift extends Error {}

${staleSources.toString()}

// Empreinte d'une source : dans le produit, aucun lien, fichier ordinaire ;
// absente : null.
async function digest(path) {
    let current = root;
    for (const part of path.split('/')) {
        current = resolve(current, part);
        let metadata;
        try {
            metadata = await lstat(current);
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
        if (metadata.isSymbolicLink()) throw new SocleDrift('Lien dans une source : ' + path);
    }
    if ((await realpath(current)) !== current || !(await lstat(current)).isFile()) throw new SocleDrift('Source hors produit ou spéciale : ' + path);
    const bytes = await readFile(current);
    return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

// Écarts de l'appli, dans l'ordre : sources liées périmées, puis dossiers de
// page de l'interface absents de la conception.
export async function socleDrifts(app) {
    const manifest = JSON.parse(await readFile(resolve(root, APPS, app, APP_MANIFEST), 'utf8'));
    const lines = (await staleSources(manifest.sources, digest)).map(({ genre, path, kind }) => 'SOURCES_STALE ' + genre + ' ' + path + ' (' + kind + ')' + UPDATE_HINT);
    const design = JSON.parse(await readFile(resolve(root, manifest.design_ref.path), 'utf8'));
    const declared = new Set((design.pages ?? []).map((page) => page.id));
    let entries = [];
    try {
        entries = await readdir(resolve(root, PAGES(app)), { withFileTypes: true });
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    for (const entry of entries.map((item) => item.name).sort())
        if (!declared.has(entry)) lines.push('INTERFACE_PAGE_ORPHAN ' + PAGES(app) + '/' + entry);
    return lines;
}

async function main(argv) {
    const [flag, app, ...rest] = argv;
    if (flag !== '--app' || rest.length || !/^[a-z][a-z0-9-]*$/.test(app ?? '')) {
        process.stderr.write('Usage : node ${SIGNATURE_FILES.support}/check-socle.mjs --app <app>\\n');
        process.exitCode = 64;
        return;
    }
    const lines = [];
    const workspace = await import('./check-workspace.mjs');
    try {
        await workspace.checkWorkspace();
    } catch (error) {
        lines.push(error instanceof workspace.WorkspaceDrift ? 'Échec du contrat workspace : ' + error.message + '.' : 'Échec du contrat workspace.');
    }
    try {
        lines.push(...(await socleDrifts(app)));
    } catch (error) {
        // Un message d'erreur système porterait un chemin local : seul le
        // message d'un écart nommé ici est recopié.
        lines.push('Échec du socle ' + app + ' : ' + (error instanceof SocleDrift ? error.message : 'lecture impossible') + '.');
    }
    if (lines.length) {
        process.stderr.write(lines.join('\\n') + '\\n');
        process.exitCode = 1;
    } else process.stdout.write('Socle ' + app + ' : sources liées à jour.\\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
`;
}

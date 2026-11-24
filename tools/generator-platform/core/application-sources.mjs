// Lot 2, commit 3 : sources d'une appli, liaison et fraîcheur générique
// (conception du lot 2 : v2 R2.2 à R2.4, v3 V3.2, V3.3 et V3.5 b et f, v4
// V4.5).
// - Table des GENRES : pour chacun, ses références dans la conception, sa
//   FERMETURE (une fonction : certains chemins se lisent dans une source,
//   comme `contract.sources[]`), le schéma qui le valide et les racines qu'il
//   fait rendre. Les lots 3 et 4 n'ajoutent que des entrées.
// - `staleSources` : fonction PURE, sans import ni nom extérieur, embarquée
//   telle quelle (`toString`) dans le vérificateur du produit : une seule
//   définition pour l'atelier et pour le produit.
// - `resolveDesignDigests` : les empreintes de contrat résolues UNE fois, à
//   l'entrée, selon le mode (interne : déclarées ; extérieur : interdites dans
//   la conception, lues dans la liaison, sinon dans les octets).
// - Table des CLASSES de commande : l'effet de la fraîcheur selon la
//   commande ; défaut fermé « consommateur ».
import { externalFailure } from './external-application-paths.mjs';
import { sha256 } from './generation-manifest.mjs';

const parse = (bytes) => JSON.parse(Buffer.from(bytes).toString('utf8'));

export const SOURCE_GENRES = Object.freeze([
    Object.freeze({
        genre: 'design',
        // La conception elle-même, et ses preuves `design.sources[]` (brief,
        // décisions), qui gardent leur empreinte DANS la conception ; la
        // liaison la recopie (v2 R2.3 point 2).
        references: (design, designPath) => [
            { field: 'design_ref.path', path: designPath },
            ...(design.sources ?? []).map((source, index) => ({
                field: `sources[${index}].snapshot_uri`,
                path: source.snapshot_uri,
            })),
        ],
        closure: async (design, _read, designPath) => [
            designPath,
            ...(design.sources ?? []).map((source) => source.snapshot_uri),
        ],
        schema: 'application-design',
        renders: Object.freeze(['coque', 'socle', 'interface']),
    }),
    Object.freeze({
        genre: 'contract',
        // Le contrat, et ses sources relues DANS le contrat (v4 V4.5).
        references: (design) =>
            (design.backend_contracts ?? []).map((reference, index) => ({
                field: `backend_contracts[${index}].snapshot_uri`,
                path: reference.snapshot_uri,
            })),
        closure: async (design, read) => {
            const paths = [];
            for (const reference of design.backend_contracts ?? []) {
                paths.push(reference.snapshot_uri);
                const contract = parse(await read(reference.snapshot_uri));
                for (const source of contract.sources ?? [])
                    if (source.snapshot_uri) paths.push(source.snapshot_uri);
            }
            return paths;
        },
        schema: 'backend-contract',
        renders: Object.freeze(['coque', 'socle']),
    }),
]);

// Fermeture COMPLÈTE d'une conception, genre par genre : `read(path)` rend
// les octets (le contrôle de chemin unique est celui de l'appelant). Rend
// [{genre, path, sha256, bytes}] trié par chemin ; un chemin cité par deux
// genres est refusé.
export async function applicationSources(
    design,
    designPath,
    read,
    genres = SOURCE_GENRES
) {
    const found = new Map();
    for (const entry of genres)
        for (const path of await entry.closure(design, read, designPath)) {
            const known = found.get(path);
            if (known && known.genre !== entry.genre)
                externalFailure(`source cited by two genres: ${path}`);
            if (known) continue;
            const bytes = await read(path);
            found.set(path, {
                genre: entry.genre,
                path,
                sha256: sha256(bytes),
                bytes: bytes.length,
            });
        }
    return [...found.values()].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    );
}

// Chemins de la fermeture d'une conception, sans lire d'empreinte (inventaire
// des entrées admises d'une création ; les empreintes sont lues au rendu).
export async function sourcePaths(
    design,
    designPath,
    read,
    genres = SOURCE_GENRES
) {
    const paths = new Set();
    for (const entry of genres)
        for (const path of await entry.closure(design, read, designPath))
            paths.add(path);
    return [...paths].sort();
}

// Écarts COMPLETS d'une liaison avec les fichiers présents : `read(path)` rend
// `{ sha256, bytes }`, ou `null` si le fichier est absent (un lien ou un
// fichier spécial fait lever `read` : c'est l'intégrité, pas la fraîcheur).
// PURE et sans dépendance : son texte est embarqué dans le produit.
export async function staleSources(sources, read) {
    const stale = [];
    for (const source of sources) {
        if (
            !/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(source.path) ||
            source.path.split('/').some((part) => part === '.' || part === '..')
        )
            throw new Error('unsafe source path');
        const found = await read(source.path);
        if (found === null)
            stale.push({
                genre: source.genre,
                path: source.path,
                kind: 'missing',
            });
        else if (found.sha256 !== source.sha256 || found.bytes !== source.bytes)
            stale.push({
                genre: source.genre,
                path: source.path,
                kind: 'modified',
            });
    }
    return stale;
}

// Forme d'une liaison rendue au manifeste d'appli : clés exactes, genre nommé,
// chemins triés et uniques, entrée `design` égale à `design_ref`.
export function assertApplicationSources(manifest) {
    const sources = manifest?.sources;
    const valid =
        Array.isArray(sources) &&
        sources.every(
            (entry, index) =>
                entry !== null &&
                typeof entry === 'object' &&
                Object.keys(entry).sort().join() ===
                    'bytes,genre,path,sha256' &&
                /^[a-z][a-z0-9-]*$/.test(entry.genre) &&
                typeof entry.path === 'string' &&
                /^[a-f0-9]{64}$/.test(entry.sha256) &&
                Number.isSafeInteger(entry.bytes) &&
                entry.bytes >= 0 &&
                (index === 0 || sources[index - 1].path < entry.path)
        ) &&
        sources.some(
            (entry) =>
                entry.genre === 'design' &&
                entry.path === manifest.design_ref?.path &&
                entry.sha256 === manifest.design_ref?.sha256
        );
    if (!valid) externalFailure('app sources binding is invalid');
    return sources;
}

// V3.3 : copie de la conception où chaque `backend_contracts[]` porte un
// `sha256`, résolu UNE fois. Interne : la conception le déclare (refus nommé
// sinon) ; extérieur : elle ne le déclare pas (refus nommé sinon) et il vient
// de la liaison de l'appli (`binding`, genre `contract`, même chemin), à
// défaut des octets du contrat lus ici, rendus à l'appelant (`read`) pour
// qu'il les lie à son plan.
export async function resolveDesignDigests(
    design,
    { mode, binding = [], read }
) {
    const contracts = design.backend_contracts ?? [];
    if (mode === 'internal') {
        for (const reference of contracts)
            if (!/^[a-f0-9]{64}$/.test(reference.sha256 ?? ''))
                externalFailure(
                    `INTERNAL_DESIGN_CONTRACT_DIGEST ${reference.snapshot_uri}`
                );
        return { design, read: [] };
    }
    if (mode !== 'external') externalFailure('unknown design digest mode');
    for (const reference of contracts)
        if (Object.hasOwn(reference, 'sha256'))
            externalFailure(
                `EXTERNAL_DESIGN_CONTRACT_DIGEST ${reference.snapshot_uri}`
            );
    const bound = new Map(
        binding
            .filter((entry) => entry.genre === 'contract')
            .map((entry) => [entry.path, entry.sha256])
    );
    const readOnce = [];
    const resolved = [];
    for (const reference of contracts) {
        let digest = bound.get(reference.snapshot_uri);
        if (digest === undefined) {
            const bytes = await read(reference.snapshot_uri);
            digest = sha256(bytes);
            readOnce.push({
                path: reference.snapshot_uri,
                sha256: digest,
                bytes: bytes.length,
            });
        }
        resolved.push({ ...reference, sha256: digest });
    }
    return {
        design: Object.hasOwn(design, 'backend_contracts')
            ? { ...design, backend_contracts: resolved }
            : design,
        read: readOnce,
    };
}

// Message d'une liaison périmée, commun à l'atelier et au produit.
export const UPDATE_HINT =
    ' ; lancer update-app --target-root <racine> --dry-run';
export const staleMessage = ({ app, genre, path }) =>
    `APP_SOURCES_STALE ${app} ${genre} ${path}${UPDATE_HINT}`;
// V3.6 point 1 : lignes d'un auteur, une par source à lier (genre, chemin),
// sans doublon entre applis.
export const sourcesToBindLines = (stale) => [
    ...new Set(
        stale.map(
            ({ genre, path }) =>
                `SOURCES_A_LIER: ${genre} ${path}${UPDATE_HINT}`
        )
    ),
];

// V3.2 : classes des commandes extérieures, UNE table, par commande de
// l'atelier (jamais par appli). La source de la liste est DÉRIVÉE : les outils
// exécutables de l'atelier qui acceptent `--target-root` (test
// d'exhaustivité, dans les deux sens). `pending` : commande prévue par un lot
// ultérieur, pas encore outillée ; elle reste consommateur jusque-là.
const row = (tool, kind, extra = {}) =>
    Object.freeze({ tool, class: kind, ...extra });
const GP = 'tools/generator-platform';
export const EXTERNAL_COMMAND_CLASSES = Object.freeze({
    'create-app': row('tools/create-app.mjs', 'consumer'),
    'prepare:application-workspace': row(
        'tools/prepare-application-workspace.mjs',
        'consumer'
    ),
    'generate:list-query': row(`${GP}/generate-list-query.mjs`, 'consumer'),
    'generate:action-request': row(
        `${GP}/generate-action-request.mjs`,
        'consumer'
    ),
    'compile:page-execution-plan': row(
        `${GP}/compile-page-execution-plan.mjs`,
        'consumer'
    ),
    'generate:page-composition': row(
        `${GP}/generate-page-composition.mjs`,
        'consumer'
    ),
    'rename-product-prefix': row('tools/rename-product-prefix.mjs', 'consumer'),
    'compile:backend-contract': row(
        'tools/compile-backend-contract.mjs',
        'author',
        { genre: 'contract' }
    ),
    'compile:application-design': row(
        'tools/compile-application-design.mjs',
        'author',
        { genre: 'design' }
    ),
    'inspect-runtime-observations': row(
        'tools/inspect-runtime-observations.mjs',
        'reader'
    ),
    'recover:application-publication': row(
        'tools/recover-application-publication.mjs',
        'recovery'
    ),
    'recover:product-prefix': row(
        'tools/recover-product-prefix.mjs',
        'recovery'
    ),
    'update-app': row('tools/update-app.mjs', 'update', {
        pending: 'lot 2, commit 6',
    }),
    'recover:application-update': row(
        'tools/recover-application-update.mjs',
        'recovery',
        { pending: 'lot 2, commit 6' }
    ),
    'extract:messages': row('tools/extract-messages.mjs', 'author', {
        genre: 'texts',
        pending: 'lot 4',
    }),
    'add-library': row('tools/add-library.mjs', 'consumer', {
        pending: 'mode extérieur, lot à venir',
    }),
    'retire-app': row('tools/retire-app.mjs', 'consumer', {
        pending: 'mode extérieur, lot à venir, qui fixe sa classe',
    }),
});
export const commandClass = (name) =>
    Object.hasOwn(EXTERNAL_COMMAND_CLASSES, name ?? '') &&
    !EXTERNAL_COMMAND_CLASSES[name].pending
        ? EXTERNAL_COMMAND_CLASSES[name].class
        : 'consumer';

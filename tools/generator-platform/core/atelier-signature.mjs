// Signature de l'atelier : SOURCE UNIQUE des noms qui désignent l'OUTIL,
// même visibles dans un produit (dossier de métadonnées, ancre DOM de la
// grammaire, vocabulaire d'entrée des adaptateurs, noms temporaires), et des
// noms internes du dépôt de l'atelier (portée npm, skills, variables et codes
// d'outils). Un nom qui désigne le PRODUIT n'est pas ici : il dérive du
// préfixe du produit (`product-identity.mjs`).
//
// Les VALEURS composées sont exportées pour le contrôle dérivé
// (`tools/check-identity-sources.mjs`) : aucune ne doit être écrite en dur
// hors de ce module et de `product-identity.mjs`.

// Nom de l'atelier : signature rangée dans les produits et les bancs, et noms
// internes de son dépôt (lot MARQUE, commits 4 et 6).
const NAME = 'atelier';

const dir = `.${NAME}`;

export const SIGNATURE = Object.freeze({
    name: NAME,
    dir,
    dataAttribute: `data-${NAME}-`,
    idAttribute: `data-${NAME}-id`,
    generator: `${NAME}-generator-platform`,
    openapiExtension: `x-${NAME}-`,
    postmanVariable: `${NAME}_`,
    gitRefs: `refs/${NAME}/`,
});

/** Chemin sous le dossier de signature : `<dir>/<parties…>`. */
export function signaturePath(...parts) {
    return [dir, ...parts].join('/');
}

/** Nom signé (temporaire, sonde, harnais) : `<nom>-<suffixe>`. */
export function signatureName(suffix) {
    return `${NAME}-${suffix}`;
}

/** Identifiant JavaScript signé d'un harnais : `<nom><Suffixe>`. */
export function signatureIdentifier(suffix) {
    return `${NAME}${suffix}`;
}

/** Propriété globale signée d'un harnais : `__<nom><Suffixe>`. */
export function signatureGlobal(suffix) {
    return `__${NAME}${suffix}`;
}

// Fichiers et dossiers de signature rangés dans un produit ou un banc.
export const SIGNATURE_FILES = Object.freeze({
    appManifest: signaturePath('app-manifest.json'),
    libraries: signaturePath('libraries.json'),
    pages: signaturePath('pages'),
    workspaceManifest: signaturePath('application-workspace.json'),
    support: signaturePath('support'),
    proof: signaturePath('proof'),
    // Pierres tombales des applis retirées (`retire-app`), versionnées.
    retiredApps: signaturePath('retired-apps'),
});

/** Pierre tombale d'une appli retirée : `<dir>/retired-apps/<app>.json`. */
export function retiredAppTombstone(appName) {
    return `${SIGNATURE_FILES.retiredApps}/${appName}.json`;
}

// Noms internes du dépôt de l'atelier, dérivés du même nom.
export const INTERNAL = Object.freeze({
    name: NAME,
    scope: `@${NAME}`,
    env: `${NAME.toUpperCase()}_`,
});

/** Nom interne de l'atelier (skill, agent) : `<nom>-<suffixe>`. */
export function internalName(suffix) {
    return `${NAME}-${suffix}`;
}

/** Variable d'environnement ou code d'outil : `<NOM>_<suffixe>`. */
export function toolEnv(suffix) {
    return `${INTERNAL.env}${suffix}`;
}

/** Échappe un texte pour l'insérer dans une expression régulière. */
export function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// Valeurs composées, refusées en dur hors des deux sources uniques.
export const SIGNATURE_VALUES = Object.freeze(
    [
        SIGNATURE.dir,
        SIGNATURE.dataAttribute,
        SIGNATURE.generator,
        SIGNATURE.openapiExtension,
        SIGNATURE.postmanVariable,
        SIGNATURE.gitRefs,
        INTERNAL.scope,
        INTERNAL.env,
    ].sort()
);

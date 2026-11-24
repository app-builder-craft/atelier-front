// Noms FIXES que l'atelier émet dans un produit (lot 2, conception v4, §V4.1
// et §V4.2) : SOURCE UNIQUE. Aucun n'est une forme du préfixe du produit :
// `rename-product-prefix` réécrit le contenu par familles et ne renomme aucun
// chemin, et le code libre de l'IA importe ces alias. Les lots 3 et 4 ajoutent
// ici leurs propres noms fixes.

// Espace de produit des bibliothèques Nx (le `libsDir` de `nx.json`).
export const LIBS_ROOT = 'libs';

// Deux bibliothèques par appli : le socle généré et scellé, et l'interface
// (configuration scellée, sources libres sous `src/`).
const SOCLE_SUFFIX = '-socle';
const INTERFACE_SUFFIX = '-interface';
export const socleLibraryName = (appName) => `${appName}${SOCLE_SUFFIX}`;
export const interfaceLibraryName = (appName) =>
    `${appName}${INTERFACE_SUFFIX}`;
export const socleRoot = (appName) =>
    `${LIBS_ROOT}/${socleLibraryName(appName)}`;
export const interfaceRoot = (appName) =>
    `${LIBS_ROOT}/${interfaceLibraryName(appName)}`;

// Racine de la coque : le projet appli Nx, seul porteur des formes du préfixe.
export const APPS_ROOT = 'apps';
export const coqueRoot = (appName) => `${APPS_ROOT}/${appName}`;

// Points d'entrée publics : l'API du socle pour l'interface et la coque,
// l'entrée réservée à la coque, et la carte des pages de l'interface.
export const SOCLE_ENTRY = 'src/index.ts';
export const SOCLE_COQUE_ENTRY = 'src/coque.ts';
export const INTERFACE_ENTRY = 'src/index.ts';

// Disposition du socle (conception v5, V5.1) : la session, puis TOUT le code
// publié, chacun sous son dossier fixe, relatif à la racine du socle.
export const SOCLE_SESSION_DIR = 'src/session';
export const SOCLE_ACTIONS_DIR = 'src/actions';
export const SOCLE_QUERIES_DIR = 'src/queries';
export const SOCLE_PAGES_DIR = 'src/pages';
// Module de page du socle (V5.4) : l'API publique de la composition de la
// page, sous son dossier ; `create-app` le rend vide, la composition le
// remplace.
export const PAGE_COMPOSITION_DIR = 'composition';
export const PAGE_MODULE = `${PAGE_COMPOSITION_DIR}/src/index.ts`;
export const EMPTY_PAGE_MODULE = 'export {};\n';
// Zone LIBRE de l'interface (V5.1) : ses sources, hors fichiers possédés ;
// les amorces de page y sont rendues, jamais possédées.
export const INTERFACE_FREE_DIR = 'src';
export const INTERFACE_PAGES_DIR = `${INTERFACE_FREE_DIR}/pages`;

// Valeurs d'exemple FIXES et neutres des specs de contrat des compositions
// (V5.3) : la composition ne dépend plus du préfixe. Le domaine `.test` est
// réservé (RFC 2606, §2).
export const SAMPLE_EMAIL = 'utilisateur@exemple.test';
export const SAMPLE_TEXT = 'contrat-exemple';

// Alias de chemin : deux motifs FIXES à une étoile, sans préfixe ni nom
// d'appli, posés une seule fois dans `tsconfig.base.json` (V3.4) ; Nx ne lit
// que ce fichier. L'étoile y vaut le nom de l'appli. Les cibles sont
// RELATIVES (`./`) : sans `baseUrl`, TypeScript 6.0.3 refuse une cible non
// relative (TS5090, mesuré au commit 1b).
export const SOCLE_ALIAS = '@socle/*';
export const INTERFACE_ALIAS = '@interface/*';
export const ROOT_PATH_ALIASES = Object.freeze({
    [SOCLE_ALIAS]: Object.freeze([
        `./${LIBS_ROOT}/*${SOCLE_SUFFIX}/${SOCLE_ENTRY}`,
    ]),
    [INTERFACE_ALIAS]: Object.freeze([
        `./${LIBS_ROOT}/*${INTERFACE_SUFFIX}/${INTERFACE_ENTRY}`,
    ]),
});

// Clé EXACTE de l'entrée réservée à la coque, déclarée dans le seul tsconfig
// de la coque (§V4.4 point 3) : un motif `@socle-coque/*` laisserait la coque
// d'une appli importer l'entrée d'une autre sans aucun refus.
const SOCLE_COQUE_SCOPE = '@socle-coque/';
export const socleCoqueAlias = (appName) => `${SOCLE_COQUE_SCOPE}${appName}`;
// Spécifieur d'une appli par un motif : l'étoile vaut le nom, à TOUTES ses
// occurrences, et le nom est inséré tel quel (aucun motif de remplacement de
// `String.prototype.replace`, `$&` ou `$1`, n'est interprété). Découpage et
// jointure natifs, plutôt qu'un remplacement de la première occurrence.
export const fillAliasPattern = (pattern, appName) =>
    pattern.split('*').join(appName);
export const socleAlias = (appName) => fillAliasPattern(SOCLE_ALIAS, appName);
export const interfaceAlias = (appName) =>
    fillAliasPattern(INTERFACE_ALIAS, appName);

// Lot 2, commit 2 (v4 §V4.3, L-3) : tags Nx des trois projets d'une appli et
// contraintes de COUCHE de `@nx/enforce-module-boundaries`, fixes, posées une
// fois dans l'ESLint racine du produit et exportées comme DONNÉES (E-2 du lot
// 5). Chaque projet ajoute la contrainte de SON appli (`app:<a>` ne dépend
// que de `app:<a>`), sans jamais retoucher la racine.
export const COQUE_TAG = 'type:app';
export const SOCLE_TAG = 'layer:socle';
export const INTERFACE_TAG = 'layer:interface';
export const appTag = (appName) => `app:${appName}`;
export const LAYER_CONSTRAINTS = Object.freeze([
    Object.freeze({
        sourceTag: COQUE_TAG,
        onlyDependOnLibsWithTags: Object.freeze([SOCLE_TAG, INTERFACE_TAG]),
    }),
    Object.freeze({
        sourceTag: INTERFACE_TAG,
        onlyDependOnLibsWithTags: Object.freeze([SOCLE_TAG]),
    }),
    Object.freeze({
        sourceTag: SOCLE_TAG,
        onlyDependOnLibsWithTags: Object.freeze([SOCLE_TAG]),
    }),
]);
export const appConstraint = (appName) => ({
    sourceTag: appTag(appName),
    onlyDependOnLibsWithTags: [appTag(appName)],
});

// Portées npm masquées par ces alias : la garde du catalogue des
// bibliothèques refuse tout paquet qui commence par l'une d'elles (V3.4
// point 8).
export const ALIAS_SCOPES = Object.freeze([
    SOCLE_ALIAS.slice(0, -1),
    INTERFACE_ALIAS.slice(0, -1),
    SOCLE_COQUE_SCOPE,
]);

// Noms fixes émis dans le produit, tels quels : lus par les tests
// d'invariant (aucune famille de préfixe, chaîne du préfixe de banc absente).
export const FIXED_NAMES = Object.freeze([
    LIBS_ROOT,
    SOCLE_SUFFIX,
    INTERFACE_SUFFIX,
    SOCLE_ENTRY,
    SOCLE_COQUE_ENTRY,
    INTERFACE_ENTRY,
    SOCLE_ALIAS,
    INTERFACE_ALIAS,
    ...Object.values(ROOT_PATH_ALIASES).flat(),
    SOCLE_COQUE_SCOPE,
    APPS_ROOT,
    SOCLE_SESSION_DIR,
    SOCLE_ACTIONS_DIR,
    SOCLE_QUERIES_DIR,
    SOCLE_PAGES_DIR,
    PAGE_MODULE,
    INTERFACE_FREE_DIR,
    INTERFACE_PAGES_DIR,
    SAMPLE_EMAIL,
    SAMPLE_TEXT,
    COQUE_TAG,
    SOCLE_TAG,
    INTERFACE_TAG,
]);

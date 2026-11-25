// Identité du produit : préfixe DÉCLARÉ et SCELLÉ, et SOURCE UNIQUE des formes
// qui en dérivent (noms que le produit expose comme les siens : variables
// d'exploitation du relais, chemins et variables nginx, politique Trusted
// Types et caches du service worker, propriété globale du navigateur).
//
// Aucun renderer n'écrit une forme en dur : il reçoit `productForms(prefixe)`.
// Le préfixe d'un produit extérieur est un champ déclaré de son espace
// (`identity.prefix`, scellé par `workspace_id`) ; celui d'un banc interne est
// porté par sa conception (`design.identity.prefix`, schéma 1.2.0).

// 2 à 6 caractères, minuscule ou chiffre, une lettre en tête.
export const PREFIX_PATTERN = /^[a-z][a-z0-9]{1,5}$/;
export const PREFIX_RULE =
    '2 à 6 caractères, minuscules ou chiffres, une lettre en tête';

/** Toutes les formes dérivées d'un préfixe, et seulement elles. */
export function productForms(prefix) {
    if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix))
        throw new Error(
            `product identity: invalid prefix ${JSON.stringify(prefix)}`
        );
    return Object.freeze({
        prefix,
        scope: `@${prefix}`,
        kebab: `${prefix}-`,
        snake: `${prefix}_`,
        env: `${prefix.toUpperCase()}_`,
        global: `__${prefix}`,
        nginxDir: `/etc/nginx/${prefix}/`,
    });
}

/**
 * Préfixe proposé par défaut, à partir d'un nom (pour un produit extérieur, la
 * partie après « / » de `--github-repository`) : en minuscules, mots séparés
 * par tout caractère hors `[a-z0-9]` (`-`, `_`, `.`…) ; une lettre par mot ;
 * s'il y en a moins de 2, les premières lettres du premier mot ; 6 au plus.
 * Le résultat n'est pas garanti valide (une initiale chiffre, un mot d'une
 * lettre, un nom réservé) : il est soumis à `prefixRefusals` comme un préfixe
 * déclaré, et jamais complété ; refusé, il fait demander `--prefix`.
 */
export function prefixInitials(name) {
    const words = String(name ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    if (words.length === 0) return '';
    const initials = words.map((word) => word[0]).join('');
    return (initials.length < 2 ? words[0] : initials).slice(0, 6);
}

/**
 * Une déclaration de préfixe réservé nomme le préfixe, le mécanisme qui crée
 * la collision et la variable concernée ; sans variable nommée, elle est
 * refusée (la liste reste falsifiable).
 */
export function assertReservedDeclarations(declarations) {
    for (const declaration of declarations) {
        const { prefix, mechanism, variable } = declaration ?? {};
        if (
            typeof prefix !== 'string' ||
            !PREFIX_PATTERN.test(prefix) ||
            typeof mechanism !== 'string' ||
            mechanism.trim() === '' ||
            typeof variable !== 'string' ||
            variable.trim() === ''
        )
            throw new Error(
                `product identity: reserved prefix declaration without a named variable: ${JSON.stringify(declaration)}`
            );
    }
    return declarations;
}

/** Portées npm du catalogue de l'atelier qui ont la forme d'un préfixe. */
export function catalogScopes(packageJson) {
    const names = new Set();
    for (const field of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
    ])
        for (const name of Object.keys(packageJson?.[field] ?? {}))
            names.add(name);
    const catalogs = [
        packageJson?.catalog,
        packageJson?.workspaces?.catalog,
        ...Object.values(
            packageJson?.catalogs ?? packageJson?.workspaces?.catalogs ?? {}
        ),
    ];
    for (const catalog of catalogs)
        for (const name of Object.keys(catalog ?? {})) names.add(name);
    return [
        ...new Set(
            [...names]
                .filter((name) => name.startsWith('@') && name.includes('/'))
                .map((name) => name.slice(1, name.indexOf('/')))
                .filter((scope) => PREFIX_PATTERN.test(scope))
        ),
    ].sort();
}

/**
 * Raisons de refus d'un préfixe : forme, puis réservés (portées du catalogue,
 * déclarations des renderers). Liste vide : préfixe accepté.
 */
export function prefixRefusals(
    prefix,
    { scopes = [], declarations = [] } = {}
) {
    if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix))
        return [`préfixe invalide ${JSON.stringify(prefix)} : ${PREFIX_RULE}`];
    const reasons = [];
    if (scopes.includes(prefix))
        reasons.push(
            `préfixe réservé ${prefix} : portée npm @${prefix} du catalogue de l'atelier`
        );
    for (const declaration of declarations)
        if (declaration.prefix === prefix)
            reasons.push(
                `préfixe réservé ${prefix} : ${declaration.mechanism} (${declaration.variable})`
            );
    return reasons;
}

// Familles de noms que le produit possède, relevées QUEL QUE SOIT le préfixe
// qu'elles portent : une forme écrite en dur, ou laissée par un ancien
// préfixe, y apparaît sous un autre préfixe que celui scellé. Source unique du
// test « un seul préfixe » et de la contre-preuve du renommage.
const FAMILY_PREFIX = '([a-z][a-z0-9]{1,5})';
export const PRODUCT_NAME_FAMILIES = Object.freeze({
    'politique du service worker': `\\b${FAMILY_PREFIX}-sw\\b`,
    'caches du service worker': `\\b${FAMILY_PREFIX}-(?:shell|session-static)-v1\\b`,
    // Lot 2, cadrage § 22 : clé de la session gardée dans l'onglet,
    // `<p>-session-v1:<app>`, rendue par la coque seule (V3.7.2).
    'clé de session de l’onglet': `\\b${FAMILY_PREFIX}-session-v1:`,
    'contexte d’accès du navigateur': `\\b__${FAMILY_PREFIX}AppAccessContext\\b`,
    "variables de l'opérateur":
        '\\b([A-Z][A-Z0-9]{1,5})_(?:UPSTREAMS?_|ENVSUBST_FILTER_INVALID|DEV_PROXY)',
    'dossier nginx': `/etc/nginx/${FAMILY_PREFIX}/`,
    "script d'entrée nginx": `\\b15-${FAMILY_PREFIX}-upstreams\\.envsh\\b`,
    'variables nginx': `\\$${FAMILY_PREFIX}_(?:cache_control|relay_guard|forwarded_proto)\\b`,
});

/**
 * Préfixes portés par chaque famille dans un texte, en minuscules : `Map`
 * famille → ensemble des préfixes trouvés (familles absentes omises).
 */
export function productNameForms(text) {
    const found = new Map();
    for (const [family, source] of Object.entries(PRODUCT_NAME_FAMILIES)) {
        const prefixes = new Set(
            [...String(text).matchAll(new RegExp(source, 'g'))].map((match) =>
                match[1].toLowerCase()
            )
        );
        if (prefixes.size) found.set(family, prefixes);
    }
    return found;
}

// Identité du produit : SOURCE UNIQUE des formes dérivées du préfixe du
// produit (noms que le produit expose comme les siens : variables
// d'exploitation du relais, chemins et variables nginx, politique Trusted
// Types et caches du service worker, propriété globale du navigateur).
//
// Aucun renderer n'écrit une forme en dur : il reçoit `productForms(prefixe)`.
// Le préfixe hérité ci-dessous est celui de la génération actuelle ; il
// disparaît quand le préfixe devient une donnée déclarée et scellée.
export const LEGACY_PREFIX = 'cmz';

/** Toutes les formes dérivées d'un préfixe, et seulement elles. */
export function productForms(prefix) {
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

// Valeurs composées du préfixe hérité, refusées en dur hors des sources
// uniques (le préfixe nu n'en fait pas partie).
export const LEGACY_PRODUCT_VALUES = Object.freeze(
    Object.entries(productForms(LEGACY_PREFIX))
        .filter(([key]) => key !== 'prefix')
        .map(([, value]) => value)
        .sort()
);

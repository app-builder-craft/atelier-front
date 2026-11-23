// Noms de prototype refusés comme noms de champ lus par une page (refus
// `LIST_QUERY_EXTERNAL_READ_NAME`, `list-query-external-profile.mjs`). Table
// du socle, indépendante de toute page : un champ lu nommé `__proto__`,
// `constructor` ou `toString` entrerait en collision avec un membre de
// prototype dans les objets que le décodeur généré construit.
//
// Noms propres d'Object.prototype et de Function.prototype, plus `prototype`,
// `constructor` et `__proto__`, moins une exclusion nommée (arbitrage du
// pilote, 2026-11-11) : `length` et `name`, données courantes (compte d'une
// liste, nom d'une entité). Les autres noms propres (`call`, `apply`, `bind`,
// `caller`, `arguments`, `constructor`…) restent refusés.
export const PROTOTYPE_DATA_NAMES = Object.freeze(['length', 'name']);
export const PROTOTYPE_NAMES = Object.freeze(
    [
        ...new Set([
            ...Object.getOwnPropertyNames(Object.prototype),
            ...Object.getOwnPropertyNames(Function.prototype),
            'prototype',
            'constructor',
            '__proto__',
        ]),
    ]
        .filter((name) => !PROTOTYPE_DATA_NAMES.includes(name))
        .sort()
);
const PROTOTYPE = new Set(PROTOTYPE_NAMES);
export const isPrototypeName = (name) => PROTOTYPE.has(name);

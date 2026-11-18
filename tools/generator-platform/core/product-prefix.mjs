// Préfixe du produit : résolution et refus nommés, pour l'espace extérieur
// (champ déclaré `identity.prefix`, scellé par `workspace_id`) et pour les
// bancs internes (porté par la conception, schéma 1.2.0).
//
// Préfixes réservés, sans liste écrite à la main par appli :
// - (a) portées npm du catalogue de l'atelier (`package.json`) ;
// - (b) déclarations des renderers qui créent la collision, chacune avec son
//   mécanisme et sa variable nommée (`RELAY_RESERVED_PREFIXES`).
import { RELAY_RESERVED_PREFIXES } from '../renderers/external-relay-renderer.mjs';
import {
    externalFailure,
    readProductFile,
} from './external-application-paths.mjs';
import {
    assertReservedDeclarations,
    catalogScopes,
    prefixInitials,
    prefixRefusals,
} from './product-identity.mjs';

export const RESERVED_PREFIX_DECLARATIONS = Object.freeze(
    assertReservedDeclarations([...RELAY_RESERVED_PREFIXES])
);

export async function prefixContext(toolsRoot) {
    const pkg = JSON.parse(
        (await readProductFile(toolsRoot, 'package.json')).toString('utf8')
    );
    return {
        scopes: catalogScopes(pkg),
        declarations: RESERVED_PREFIX_DECLARATIONS,
    };
}

// Espace extérieur : préfixe déclaré par `--prefix`, ou proposé par les
// initiales du nom du dépôt (`<propriétaire>/<nom>`). Un préfixe proposé
// refusé n'est jamais complété : on demande de déclarer `--prefix`.
export async function resolveWorkspacePrefix({
    toolsRoot,
    declared,
    githubRepository,
}) {
    const context = await prefixContext(toolsRoot);
    if (declared !== undefined) {
        const refusals = prefixRefusals(declared, context);
        if (refusals.length)
            externalFailure(`--prefix refused: ${refusals.join(' ; ')}`);
        return { prefix: declared, provenance: 'déclaré' };
    }
    const name = String(githubRepository ?? '').split('/')[1] ?? '';
    const proposed = prefixInitials(name);
    const refusals = prefixRefusals(proposed, context);
    if (refusals.length)
        externalFailure(
            `proposed prefix ${JSON.stringify(proposed)} (initials of ${JSON.stringify(name)}) refused: ${refusals.join(' ; ')} ; déclarer --prefix`
        );
    return { prefix: proposed, provenance: `proposé : initiales de ${name}` };
}

// Banc interne : le préfixe est OBLIGATOIRE dans la conception (1.2.0).
export async function assertDesignPrefix({ toolsRoot, design, fail }) {
    const prefix = design?.design?.identity?.prefix;
    if (prefix === undefined)
        fail(
            'internal mode requires design.identity.prefix (application design 1.2.0)'
        );
    const refusals = prefixRefusals(prefix, await prefixContext(toolsRoot));
    if (refusals.length)
        fail(`design.identity.prefix refused: ${refusals.join(' ; ')}`);
    return prefix;
}

// Produit extérieur : une conception qui déclare un autre préfixe que celui
// scellé dans l'espace est refusée ; sans déclaration, le préfixe scellé vaut.
export function assertSealedPrefix(design, sealed) {
    const declared = design?.design?.identity?.prefix;
    if (declared !== undefined && declared !== sealed)
        externalFailure(
            'PRODUCT_PREFIX_SEALED: change it with rename-product-prefix'
        );
    return sealed;
}

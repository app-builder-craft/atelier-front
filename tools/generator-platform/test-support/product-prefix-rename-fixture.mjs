// Lot MARQUE, commit 3 : produits fictifs pour `rename-product-prefix`. Un
// produit porte trois applis : une coque Angular avec session (domaine
// `observatory`), sa commande, son plan de page et sa composition (lot 2,
// V5.3 : valeurs d'exemple fixes, indépendantes du préfixe) ; une coque
// Angular et une coque React sans session. Le runner injecté ne compile rien.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RENAME_TOOL } from '../core/application-ownership.mjs';
import {
    planApplicationWorkspace,
    planExternalApplicationShell,
    publishApplicationWorkspace,
    publishExternalApplicationShell,
    readOwnedWorkspace,
} from '../core/application-workspace.mjs';
import { SIGNATURE_FILES } from '../core/atelier-signature.mjs';
import {
    planExternalActionRequest,
    publishExternalActionRequest,
} from '../core/external-action-request.mjs';
import {
    planExternalPageComposition,
    publishExternalPageComposition,
} from '../core/external-page-composition.mjs';
import {
    planExternalPagePlan,
    publishExternalPagePlan,
} from '../core/external-page-plan.mjs';
import {
    planProductPrefixRename,
    publicProductPrefixRenamePlan,
} from '../core/product-prefix-rename.mjs';
import { publishProductPrefixRename } from '../core/product-prefix-rename-transaction.mjs';
import {
    fixtureParent,
    installMetadataOnly,
    snapshotTree,
    TOOLS_ROOT,
    workspaceOptions,
    writeExternalDesign,
} from './external-application-fixture.mjs';
import {
    sessionShellOptions,
    writeExternalActionDefinitions,
    writeExternalSessionDesign,
} from './external-session-fixture.mjs';

export const APP_MANIFEST = SIGNATURE_FILES.appManifest;
export const native = () => ({ run: () => undefined });
export const SESSION_APP = 'session-observatory';
// Coques sans session du produit fictif : source unique de leurs noms.
const SHELL_APPS = Object.freeze([
    ['native-angular', 'angular-pwa'],
    ['native-react', 'react-spa'],
]);
// Applis du produit fictif, dans l'ordre des noms.
export const PRODUCT_APPS = Object.freeze(
    [SESSION_APP, ...SHELL_APPS.map(([name]) => name)].sort()
);

async function publishWith(plan, publish, options) {
    const reviewed = await plan(options);
    await publish({ ...options, expectedPlanId: reviewed.plan_id }, native());
    return reviewed;
}

// Produit au préfixe donné (sans préfixe : les initiales du dépôt fictif).
export async function renameProduct(t, prefix, { shells = true } = {}) {
    const parent = await fixtureParent(t);
    const options = {
        ...workspaceOptions(join(parent, 'product')),
        ...(prefix === undefined ? {} : { prefix }),
    };
    const workspace = await planApplicationWorkspace(options);
    await publishApplicationWorkspace({
        ...options,
        expectedPlanId: workspace.plan_id,
    });
    const root = options.targetRoot;
    await installMetadataOnly(workspace);
    const session = sessionShellOptions(
        await writeExternalSessionDesign(root, 'observatory')
    );
    await publishWith(
        planExternalApplicationShell,
        publishExternalApplicationShell,
        session
    );
    const base = { workspaceRoot: TOOLS_ROOT, targetRoot: root };
    const app = { ...base, appName: SESSION_APP };
    const { enter } = await writeExternalActionDefinitions(root, 'observatory');
    await publishWith(planExternalActionRequest, publishExternalActionRequest, {
        ...app,
        definitionPath: enter,
    });
    const design = JSON.parse(
        await readFile(join(root, session.designPath), 'utf8')
    );
    const experience = design.experiences.find(
        (entry) => entry.id === session.experienceId
    );
    const page = { ...app, pageId: experience.entry_page_id };
    await publishWith(planExternalPagePlan, publishExternalPagePlan, page);
    await publishWith(
        planExternalPageComposition,
        publishExternalPageComposition,
        page
    );
    if (shells) {
        const input = await writeExternalDesign(root);
        for (const [appName, profile] of SHELL_APPS)
            await publishWith(
                planExternalApplicationShell,
                publishExternalApplicationShell,
                {
                    ...base,
                    designPath: input.designPath,
                    experienceId: input.experienceId,
                    appName,
                    profile,
                    applicationDesignSchema: input.applicationDesignSchema,
                    backendContractSchema: input.backendContractSchema,
                }
            );
    }
    return {
        parent,
        root,
        options,
        base,
        app,
        page,
        apps: join(root, 'apps'),
        prefix: (await readOwnedWorkspace(base)).manifest.identity.prefix,
    };
}

export const renameOptions = (product, to) => ({ ...product.base, to });

// Renommage complet, plan revu puis publié.
export async function renameTo(product, to, dependencies = {}) {
    const options = renameOptions(product, to);
    const plan = await planProductPrefixRename(options, {}, dependencies);
    const result = await publishProductPrefixRename(
        { ...options, expectedPlanId: plan.plan_id },
        { ...native(), ...dependencies }
    );
    return { plan, visible: publicProductPrefixRenamePlan(plan), result };
}

export const snapshot = (product) => snapshotTree(product.parent);

export const readManifest = async (product, appName) =>
    JSON.parse(
        await readFile(join(product.apps, appName, APP_MANIFEST), 'utf8')
    );

const withoutOwnership = ({ ownership: _ownership, ...rest }) => {
    void _ownership;
    return rest;
};

// Preuve positive (S7, précisée par P5) : A renommé a les FICHIERS de B, créé
// au préfixe d'arrivée avec les mêmes publications ; les manifestes d'appli ne
// diffèrent que par le sceau, et l'écart des empreintes d'enregistrements est
// borné aux chemins que les renommages ont remplacés.
export async function assertRenamedEqualsCreated(renamed, created) {
    const a = await snapshotTree(renamed.root);
    const b = await snapshotTree(created.root);
    assert.deepEqual(
        a.map(([path, kind]) => [path, kind]),
        b.map(([path, kind]) => [path, kind])
    );
    const manifests = [];
    for (const [index, [path, kind, hash]] of a.entries()) {
        if (kind !== 'file') continue;
        if (path.endsWith(`/${APP_MANIFEST}`) && path.startsWith('apps/'))
            manifests.push(path.split('/')[1]);
        else assert.equal(hash, b[index][2], path);
    }
    assert.ok(manifests.length >= 1);
    for (const appName of manifests) {
        const left = await readManifest(renamed, appName);
        const right = await readManifest(created, appName);
        assert.deepEqual(withoutOwnership(left), withoutOwnership(right));
        assert.equal(left.ownership.workspace_id, right.ownership.workspace_id);
        assert.equal(left.ownership.schema_version, '1.1.0');
        assert.equal(right.ownership.schema_version, '1.0.0');
        const renames = left.ownership.publications.filter(
            (record) => record.tool === RENAME_TOOL
        );
        assert.ok(renames.length >= 1, appName);
        const replaced = new Set(
            renames.flatMap((record) =>
                record.files
                    .filter((file) => file.change === 'replaced')
                    .map((file) => file.path)
            )
        );
        const records = left.ownership.publications.filter(
            (record) => record.tool !== RENAME_TOOL
        );
        assert.equal(records.length, right.ownership.publications.length);
        for (const [index, record] of records.entries()) {
            const other = right.ownership.publications[index];
            assert.equal(record.tool, other.tool);
            assert.deepEqual(
                record.files.map(({ path, change }) => [path, change]),
                other.files.map(({ path, change }) => [path, change])
            );
            for (const [position, file] of record.files.entries())
                if (!replaced.has(file.path))
                    assert.deepEqual(file, other.files[position], file.path);
        }
    }
}

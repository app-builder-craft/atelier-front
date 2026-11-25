// Lot 2, commit 6c : produit de banc des preuves d'`update-app` (cadrage
// § 20). Produit à documents compilés par les CLI réelles (contrat et
// conception), une appli créée sur la conception compilée ; aides pour
// recompiler le contrat par son auteur, ajouter ou retirer une page de la
// conception, et lancer le contrôle de l'espace du produit tel quel.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    planExternalApplicationShell,
    publishExternalApplicationShell,
} from '../core/application-workspace.mjs';
import { SIGNATURE_FILES } from '../core/atelier-signature.mjs';
import {
    installMetadataOnly,
    TOOLS_ROOT,
} from './external-application-fixture.mjs';
import {
    backendArgs,
    compileDocumentFixture,
    designArgs,
    documentFixture,
    runDocumentCli,
} from './external-document-fixture.mjs';

export const APP = 'doc-app';
export const NEW_PAGE = 'page_3333333333333333';
// Contrôles natifs injectés : aucun n'échoue.
export const quietRun = () => undefined;

export const updateOptions = (fixture, extra = {}) => ({
    workspaceRoot: TOOLS_ROOT,
    targetRoot: fixture.root,
    ...extra,
});

// Appli `appName` créée sur une conception compilée du produit (par défaut,
// celle de la fixture).
export async function createApp(
    fixture,
    appName = APP,
    designPath = fixture.designPath
) {
    const design = JSON.parse(
        await readFile(join(fixture.root, designPath), 'utf8')
    );
    const shell = {
        workspaceRoot: TOOLS_ROOT,
        targetRoot: fixture.root,
        designPath,
        experienceId: design.experiences[0].id,
        appName,
        profile: 'angular-pwa',
        applicationDesignSchema: fixture.applicationDesignSchema,
        backendContractSchema: fixture.backendContractSchema,
    };
    const plan = await planExternalApplicationShell(shell);
    await publishExternalApplicationShell(
        { ...shell, expectedPlanId: plan.plan_id },
        { run: quietRun }
    );
    return shell;
}

export async function updateProduct(t) {
    const fixture = await documentFixture(t, 'B');
    await installMetadataOnly(fixture.plan);
    await compileDocumentFixture(fixture);
    const shell = await createApp(fixture);
    return { fixture, shell, request: fixture.backendRequests[0] };
}

// L'auteur recompile le contrat à la MÊME sortie, après une retouche de sa
// définition (`n` octets de fin) ; plan relu puis appliqué par la CLI réelle.
export async function recompileContract(fixture, request, n = 1) {
    const definition = join(fixture.root, request.definitionPath);
    await writeFile(
        definition,
        (await readFile(definition, 'utf8')) + '\n'.repeat(n)
    );
    const plan = runDocumentCli('compile-backend-contract', [
        ...backendArgs(fixture, request),
        '--dry-run',
    ]);
    assert.equal(plan.status, 0, plan.stderr);
    const apply = runDocumentCli('compile-backend-contract', [
        ...backendArgs(fixture, request),
        '--apply',
        JSON.parse(plan.stdout).plan_id,
    ]);
    assert.equal(apply.status, 0, apply.stderr);
}

// L'auteur compile la conception de la fixture à la sortie `out` : plan relu
// puis appliqué par la CLI réelle (une seconde conception du produit, ou la
// même recompilée, remplacement d'une sortie présente sous plan compris).
export function compileDesign(fixture, out = fixture.designPath) {
    const args = designArgs({ ...fixture, designPath: out });
    const plan = runDocumentCli('compile-application-design', [
        ...args,
        '--dry-run',
    ]);
    assert.equal(plan.status, 0, plan.stderr);
    const apply = runDocumentCli('compile-application-design', [
        ...args,
        '--apply',
        JSON.parse(plan.stdout).plan_id,
    ]);
    assert.equal(apply.status, 0, apply.stderr);
}

async function editDesign(fixture, edit) {
    const path = join(fixture.root, fixture.designPath);
    const design = JSON.parse(await readFile(path, 'utf8'));
    edit(design);
    await writeFile(path, `${JSON.stringify(design, null, 2)}\n`);
}

// Page ajoutée à la conception : copie de la page d'accueil, à un autre
// chemin, dans la même expérience, atteinte depuis l'accueil par une action
// de navigation.
const openAction = (id) => `open-${id.slice(-4)}`;
export const addPage = (fixture, id = NEW_PAGE) =>
    editDesign(fixture, (design) => {
        const page = structuredClone(design.pages[0]);
        page.id = id;
        page.path = `/${id.slice(-4)}`;
        page.title = `Page ${id.slice(-4)}`;
        const entry = design.pages[0];
        entry.actions.push({
            ...structuredClone(entry.actions[0]),
            id: openAction(id),
            destination_page_id: id,
            label: `Open ${id.slice(-4)}`,
        });
        for (const region of entry.regions)
            for (const element of region.elements)
                if (element.action_ids.includes(entry.actions[0].id))
                    element.action_ids.push(openAction(id));
        design.pages.push(page);
        design.experiences[0].page_ids.push(id);
    });

export const removePage = (fixture, id = NEW_PAGE) =>
    editDesign(fixture, (design) => {
        design.pages = design.pages.filter((page) => page.id !== id);
        design.experiences[0].page_ids = design.experiences[0].page_ids.filter(
            (page) => page !== id
        );
        const entry = design.pages[0];
        entry.actions = entry.actions.filter(
            (action) => action.id !== openAction(id)
        );
        for (const region of entry.regions)
            for (const element of region.elements)
                element.action_ids = element.action_ids.filter(
                    (action) => action !== openAction(id)
                );
    });

// Écarts que le contrôle du produit (`check-socle`, lancé par son `lint`)
// rapporte pour l'appli : le script scellé du produit, importé tel quel.
export async function productDrifts(fixture, app = APP) {
    const script = join(
        fixture.root,
        SIGNATURE_FILES.support,
        'check-socle.mjs'
    );
    const { socleDrifts } = await import(pathToFileURL(script).href);
    return socleDrifts(app);
}

// Fichiers du produit hors arbres de travail, verrous et dépendances.
export const ownedSnapshot = (tree) =>
    tree.filter(
        ([path]) =>
            !path.includes('.generation-lock') &&
            !/(^|\/)node_modules(\/|$)/.test(path)
    );

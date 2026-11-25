// Lot 2, commit 6c (cadrage § 20 ; conception v2 R2.1.4, R2.1.6 et R2.7,
// v3 V3.5 a et c, v4 V4.6 points 2 et 3) : l'application d'`update-app`
// (`--expect-plan`), contrôles natifs injectés. Oracles écrits ici :
// - N4, N5, N6 : plan non relu, source changée pendant la transaction,
//   fichier glissé dans un candidat : refus, produit égal à l'octet ;
// - témoin et contrôles du socle BLOQUANTS : `UPDATE_GENERATOR_BROKEN
//   <couche> <fichier>`, retour exact ; l'appli réelle RAPPORTÉE sans
//   bloquer : `RAPPORT_INTERFACE: VERT | ROUGE <couche> <chemin>` (P2) ;
// - P1, N1, N14 : consommateurs refusés tant que la source n'est pas liée,
//   acceptés après ; contrôle de l'espace rouge puis vert ;
// - P3 (rejeu qui annule), P4 (plan égal à l'application), P7 (page ajoutée
//   puis retirée), P8 (boucle de l'auteur complète), P5 (renommage).
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { planExternalApplicationShell } from './core/application-workspace.mjs';
import { UPDATE_TOOL } from './core/application-ownership.mjs';
import {
    planApplicationUpdate,
    publicApplicationUpdatePlan,
    renderApplicationForUpdate,
} from './core/application-update.mjs';
import {
    publishApplicationUpdate,
    recoverApplicationUpdate,
    witnessControls,
    witnessTrees,
} from './core/application-update-transaction.mjs';
import { SIGNATURE_FILES } from './core/atelier-signature.mjs';
import { pathExists } from './core/external-application-paths.mjs';
import { planProductPrefixRename } from './core/product-prefix-rename.mjs';
import { publishProductPrefixRename } from './core/product-prefix-rename-transaction.mjs';
import { appManifestPath } from './renderers/external-product-layout.mjs';
import { snapshotTree } from './test-support/external-application-fixture.mjs';
import {
    addPage,
    APP,
    productDrifts,
    createApp,
    NEW_PAGE,
    quietRun,
    recompileContract,
    removePage,
    updateOptions,
    updateProduct,
} from './test-support/application-update-fixture.mjs';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const REPORT =
    /^RAPPORT_INTERFACE: (?:VERT|ROUGE (interface|coque|socle) (\S+))$/;
const manifestOf = async (fixture, app = APP) =>
    JSON.parse(
        await readFile(join(fixture.root, appManifestPath(app)), 'utf8')
    );
// Produit hors fichiers de l'appli à changer : rien ne bouge hors du plan.
const tree = (fixture) => snapshotTree(fixture.root);

async function apply(fixture, dependencies = {}) {
    const plan = await planApplicationUpdate(updateOptions(fixture));
    const result = await publishApplicationUpdate(
        updateOptions(fixture, { expectedPlanId: plan.plan_id }),
        { run: quietRun, ...dependencies }
    );
    return { plan, result };
}

// Un contrôle injecté qui échoue : sa sortie nomme `file` (chemin absolu,
// comme un compilateur), puis l'échec confiné.
const failing = (matches, file) => (command, args, root, options) => {
    if (!matches(args)) return undefined;
    options?.output?.write(`${root}/${file}(1,1): error TS2304\n`);
    throw new Error(
        'external application: product command failed under confinement (code 2)'
    );
};

test('N4 : identifiant non relu, ou source changée entre le plan et l’application : périmé, rien ne bouge', async (t) => {
    const { fixture, request } = await updateProduct(t);
    await recompileContract(fixture, request);
    const plan = await planApplicationUpdate(updateOptions(fixture));
    const before = await tree(fixture);
    await assert.rejects(
        publishApplicationUpdate(
            updateOptions(fixture, { expectedPlanId: 'f'.repeat(64) }),
            { run: quietRun }
        ),
        /^Error: external application: reviewed update plan is stale$/
    );
    assert.deepEqual(await tree(fixture), before);
    await recompileContract(fixture, request, 2);
    const changed = await tree(fixture);
    await assert.rejects(
        publishApplicationUpdate(
            updateOptions(fixture, { expectedPlanId: plan.plan_id }),
            { run: quietRun }
        ),
        /^Error: external application: reviewed update plan is stale$/
    );
    assert.deepEqual(await tree(fixture), changed);
});

test('N5, N6 : source changée pendant la transaction, fichier glissé dans un candidat : refus, retour exact', async (t) => {
    const { fixture, request } = await updateProduct(t);
    await recompileContract(fixture, request);
    const plan = await planApplicationUpdate(updateOptions(fixture));
    // Le contrat compilé, source liée sans empreinte déclarée : retouché, il
    // change la liaison sans rendre la conception invalide.
    const definition = join(fixture.root, request.outputPath);
    const before = await tree(fixture);
    const original = await readFile(definition, 'utf8');
    await assert.rejects(
        publishApplicationUpdate(
            updateOptions(fixture, { expectedPlanId: plan.plan_id }),
            {
                run: quietRun,
                phase: async (name) => {
                    if (name === 'candidate-staged')
                        await writeFile(definition, `${original}\n`);
                },
            }
        ),
        /^Error: external application: update inputs changed$/
    );
    await writeFile(definition, original);
    assert.deepEqual(await tree(fixture), before);
    // N6 : un fichier glissé dans un candidat après les contrôles n'est
    // jamais échangé (candidats vérifiés en dernier) ; la brique refuse de
    // retirer un candidat qui porte un fichier étranger : état ambigu, nommé,
    // racines de l'appli inchangées ; le fichier retiré, la reprise rend
    // l'état d'avant.
    const slipped = join(
        fixture.root,
        'apps',
        `.${APP}.update-candidate-${plan.plan_id}`,
        'glissé.ts'
    );
    await assert.rejects(
        publishApplicationUpdate(
            updateOptions(fixture, { expectedPlanId: plan.plan_id }),
            {
                run: quietRun,
                phase: async (name) => {
                    if (name === 'witnessed')
                        await writeFile(slipped, 'export {};\n');
                },
            }
        ),
        /update rollback refused; run recover:application-update/
    );
    const roots = (entries) =>
        entries.filter(([path]) => /^(apps|libs)\/(?!\.)/.test(path));
    assert.deepEqual(roots(await tree(fixture)), roots(before));
    await assert.rejects(
        recoverApplicationUpdate(updateOptions(fixture)),
        /^Error: external application: ambiguous interrupted application update: apps\/doc-app candidate drifted$/
    );
    await rm(slipped);
    assert.deepEqual(await recoverApplicationUpdate(updateOptions(fixture)), {
        recovered: true,
        direction: 'back',
    });
    assert.deepEqual(await tree(fixture), before);
});

test('témoin bloquant : un socle ou une interface d’amorces rouges sont une faute du générateur, rien n’est adopté', async (t) => {
    const { fixture, request } = await updateProduct(t);
    await addPage(fixture);
    await recompileContract(fixture, request);
    const before = await tree(fixture);
    const plan = await planApplicationUpdate(updateOptions(fixture));
    const reviewed = updateOptions(fixture, { expectedPlanId: plan.plan_id });
    const socleFile = `libs/${APP}-socle/src/index.ts`;
    await assert.rejects(
        publishApplicationUpdate(reviewed, {
            run: failing(
                (args) =>
                    args[1] === '-p' &&
                    args[2].endsWith('tsconfig.lib.json') &&
                    args[2].includes(`${APP}-socle`),
                socleFile
            ),
        }),
        new RegExp(
            `^Error: external application: ${escape(`UPDATE_GENERATOR_BROKEN socle ${socleFile} (app ${APP})`)}$`
        )
    );
    assert.deepEqual(await tree(fixture), before);
    // L'interface témoin : la sortie nomme l'arbre témoin ; le refus nomme la
    // racine réelle.
    const page = `src/pages/${NEW_PAGE}/index.ts`;
    await assert.rejects(
        publishApplicationUpdate(reviewed, {
            run: failing(
                (args) =>
                    args[1] === '-p' &&
                    args[2].includes('interface.update-witness'),
                `libs/.${APP}-interface.update-witness-${plan.plan_id}/${page}`
            ),
        }),
        new RegExp(
            `${escape(`UPDATE_GENERATOR_BROKEN interface libs/${APP}-interface/${page} (app ${APP})`)}$`
        )
    );
    assert.deepEqual(await tree(fixture), before);
    // V3.5 a point 2 : l'ESLint de l'interface sur les AMORCES, au témoin. Une
    // amorce fautive (rendue par le générateur) est sa faute, nommée par la
    // racine réelle, AVANT tout échange ; rien n'est adopté.
    const app = plan.apps.find(({ app_name }) => app_name === APP);
    const lint = witnessControls(plan, app).find(
        ({ label }) => label === `witness:${APP}:interface-lint`
    );
    assert.ok(lint, 'ESLint de l’interface au témoin');
    const seed = Object.keys(app.seeds).sort()[0];
    const ui = `libs/${APP}-interface/`;
    assert.ok(seed?.startsWith(ui), seed);
    const phases = [];
    await assert.rejects(
        publishApplicationUpdate(reviewed, {
            run: failing(
                (args) =>
                    JSON.stringify(args.slice(1)) === JSON.stringify(lint.args),
                seed.replace(
                    ui,
                    `libs/.${APP}-interface.update-witness-${plan.plan_id}/`
                )
            ),
            phase: (name) => phases.push(name),
        }),
        new RegExp(
            `^Error: external application: ${escape(`UPDATE_GENERATOR_BROKEN interface ${seed} (app ${APP})`)}$`
        )
    );
    assert.deepEqual(
        phases.filter((name) => name.startsWith('swapped:')),
        [],
        'ESLint du témoin : rouge avant tout échange'
    );
    assert.deepEqual(await tree(fixture), before);
    // Contrôle du socle après l'échange, bloquant : retour exact.
    await assert.rejects(
        publishApplicationUpdate(reviewed, {
            run: failing(
                (args) => args[1] === 'run' && args[2] === `${APP}-socle:lint`,
                socleFile
            ),
        }),
        /UPDATE_GENERATOR_BROKEN socle /
    );
    assert.deepEqual(await tree(fixture), before);
    // Témoin vert : l'application passe. Les arbres témoins existent pendant
    // l'ESLint du témoin, et plus aucun pendant les `nx run` d'après
    // l'échange (Nx y verrait deux projets du même nom).
    const present = async () => {
        const found = [];
        for (const path of witnessTrees(APP, plan.plan_id))
            if (await pathExists(join(fixture.root, path))) found.push(path);
        return found;
    };
    const atLint = [];
    const atNx = [];
    const done = await publishApplicationUpdate(reviewed, {
        run: async (command, args) => {
            if (JSON.stringify(args.slice(1)) === JSON.stringify(lint.args))
                atLint.push(...(await present()));
            if (args[1] === 'run')
                atNx.push(
                    ...(await present()).map((path) => `${args[2]} ${path}`)
                );
        },
    });
    assert.deepEqual(atLint, witnessTrees(APP, plan.plan_id));
    assert.deepEqual(atNx, [], 'aucun arbre témoin pendant les nx run');
    assert.equal(done.report, 'RAPPORT_INTERFACE: VERT');
});

test('P2 : casse voulue de l’interface, application réussie, rapport ROUGE lisible par machine ; coque rouge rapportée aussi', async (t) => {
    const { fixture, request } = await updateProduct(t);
    await recompileContract(fixture, request);
    const page = `libs/${APP}-interface/src/pages/page_1111111111111111/page.ts`;
    const { plan, result } = await apply(fixture, {
        run: failing(
            (args) => args[1] === 'run' && args[2] === `${APP}-interface:lint`,
            page
        ),
    });
    assert.equal(result.replayed, false);
    const line = REPORT.exec(result.report);
    assert.ok(line, result.report);
    assert.deepEqual(line.slice(1), ['interface', page]);
    const manifest = await manifestOf(fixture);
    assert.equal(manifest.ownership.publications.at(-1).tool, UPDATE_TOOL);
    assert.equal(manifest.ownership.publications.at(-1).plan_id, plan.plan_id);
    // Coque rouge à la construction : rapportée `coque`, faute du générateur.
    await recompileContract(fixture, request, 2);
    const main = `apps/${APP}/src/main.ts`;
    const second = await apply(fixture, {
        run: failing(
            (args) =>
                args[1] === 'run' && args[2] === `${APP}:build:production`,
            main
        ),
    });
    assert.deepEqual(REPORT.exec(second.result.report).slice(1), [
        'coque',
        main,
    ]);
});

test('P1, N1, N14 : source liée seulement par update-app ; consommateurs et lint rouges avant, verts après ; interface intacte', async (t) => {
    const { fixture, shell, request } = await updateProduct(t);
    assert.deepEqual(await productDrifts(fixture), []);
    const interfaceTree = async () =>
        (await tree(fixture)).filter(([path]) =>
            path.startsWith(`libs/${APP}-interface/src/`)
        );
    const ui = await interfaceTree();
    await recompileContract(fixture, request);
    const hint = ' ; lancer update-app --target-root <racine> --dry-run';
    assert.deepEqual(await productDrifts(fixture), [
        `SOURCES_STALE contract ${request.outputPath} (modified)${hint}`,
        `SOURCES_STALE contract ${request.definitionPath} (modified)${hint}`,
    ]);
    const before = await tree(fixture);
    await assert.rejects(
        planExternalApplicationShell({ ...shell, appName: 'doc-two' }),
        new RegExp(`APP_SOURCES_STALE ${APP} contract `)
    );
    assert.deepEqual(await tree(fixture), before);
    const { plan } = await apply(fixture);
    const [app] = publicApplicationUpdatePlan(plan).apps;
    assert.deepEqual(
        app.sources.map(({ genre, change }) => [genre, change]),
        [
            ['contract', 'modified'],
            ['contract', 'modified'],
        ]
    );
    assert.equal(
        (await manifestOf(fixture)).ownership.publications.filter(
            (record) => record.tool === UPDATE_TOOL
        ).length,
        1
    );
    assert.deepEqual(await productDrifts(fixture), []);
    assert.deepEqual(await interfaceTree(), ui);
    await createApp(fixture, 'doc-two');
});

test('P3 : rejeu qui annule ; A → B → A égal à l’octet ; deux enregistrements chaînés ; rejeu du plan sans effet', async (t) => {
    const { fixture, request } = await updateProduct(t);
    const owned = async () =>
        (await tree(fixture)).filter(
            ([path]) =>
                (path.startsWith(`apps/${APP}/`) ||
                    path.startsWith(`libs/${APP}-`)) &&
                path !== appManifestPath(APP)
        );
    const atA = await owned();
    const sourcesA = (await manifestOf(fixture)).sources;
    const saved = {};
    for (const path of [request.definitionPath, request.outputPath])
        saved[path] = await readFile(join(fixture.root, path));
    await recompileContract(fixture, request);
    await apply(fixture);
    for (const [path, bytes] of Object.entries(saved))
        await writeFile(join(fixture.root, path), bytes);
    const { plan } = await apply(fixture);
    assert.deepEqual(await owned(), atA);
    const manifest = await manifestOf(fixture);
    assert.deepEqual(manifest.sources, sourcesA);
    const updates = manifest.ownership.publications.filter(
        (record) => record.tool === UPDATE_TOOL
    );
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[1].sources_before, updates[0].sources_after);
    assert.deepEqual(updates[1].sources_after, updates[0].sources_before);
    const replay = await publishApplicationUpdate(
        updateOptions(fixture, { expectedPlanId: plan.plan_id }),
        { run: quietRun }
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(await manifestOf(fixture), manifest);
});

test('P4, P7 : l’application écrit exactement le plan ; page ajoutée puis retirée, dossier d’interface gardé et signalé', async (t) => {
    const { fixture } = await updateProduct(t);
    await addPage(fixture);
    const before = new Map(
        (await tree(fixture))
            .filter(([, kind]) => kind === 'file')
            .map(([path, , hash]) => [path, hash])
    );
    const { plan } = await apply(fixture);
    const [app] = plan.apps;
    const after = new Map(
        (await tree(fixture))
            .filter(([, kind]) => kind === 'file')
            .map(([path, , hash]) => [path, hash])
    );
    const written = [...new Set([...before.keys(), ...after.keys()])]
        .filter((path) => before.get(path) !== after.get(path))
        .sort();
    assert.deepEqual(
        written,
        [
            ...app.changes.map((change) => change.path),
            ...Object.keys(app.seeds),
            appManifestPath(APP),
        ].sort()
    );
    const contract = `apps/${APP}/${SIGNATURE_FILES.pages}/${NEW_PAGE}.json`;
    assert.ok(after.has(contract));
    const seeds = Object.keys(app.seeds);
    assert.ok(seeds.length > 0);
    // Page retirée : route et contrat retirés ; le dossier d'interface reste,
    // signalé, à l'octet.
    await removePage(fixture);
    const removal = await planApplicationUpdate(updateOptions(fixture));
    const [shown] = publicApplicationUpdatePlan(removal).apps;
    assert.deepEqual(shown.pages, { added: [], removed: [NEW_PAGE] });
    assert.deepEqual(shown.interface_orphans, [
        `libs/${APP}-interface/src/pages/${NEW_PAGE}`,
    ]);
    assert.ok(
        shown.files.some(
            ({ path, change }) => path === contract && change === 'removed'
        )
    );
    await publishApplicationUpdate(
        updateOptions(fixture, { expectedPlanId: removal.plan_id }),
        { run: quietRun }
    );
    const final = new Map(
        (await tree(fixture))
            .filter(([, kind]) => kind === 'file')
            .map(([path, , hash]) => [path, hash])
    );
    assert.equal(final.has(contract), false);
    for (const seed of seeds) assert.equal(final.get(seed), after.get(seed));
    // Le contrôle du produit le signale jusqu'à sa suppression par l'IA.
    assert.deepEqual(await productDrifts(fixture), [
        `INTERFACE_PAGE_ORPHAN libs/${APP}-interface/src/pages/${NEW_PAGE}`,
    ]);
});

test('P8 : deux compilations du contrat à la même sortie, puis update-app : tout passe, lint vert', async (t) => {
    const { fixture, request } = await updateProduct(t);
    await recompileContract(fixture, request, 1);
    await recompileContract(fixture, request, 2);
    const { result } = await apply(fixture);
    assert.equal(result.report, 'RAPPORT_INTERFACE: VERT');
    assert.deepEqual(await productDrifts(fixture), []);
    await assert.rejects(
        planApplicationUpdate(updateOptions(fixture)),
        /update without change/
    );
});

test('P5 : renommage après une mise à jour, mise à jour après un renommage : les deux chaînes valides', async (t) => {
    const { fixture, request } = await updateProduct(t);
    await recompileContract(fixture, request);
    await apply(fixture);
    const rename = async (to) => {
        const plan = await planProductPrefixRename(
            updateOptions(fixture, { to })
        );
        await publishProductPrefixRename(
            updateOptions(fixture, { to, expectedPlanId: plan.plan_id }),
            { run: quietRun }
        );
    };
    await rename('qz8y');
    assert.equal((await manifestOf(fixture)).ownership.schema_version, '1.2.0');
    await recompileContract(fixture, request, 2);
    await apply(fixture);
    const manifest = await manifestOf(fixture);
    assert.deepEqual(
        manifest.ownership.publications.map((record) => record.tool),
        [UPDATE_TOOL, 'rename-product-prefix', UPDATE_TOOL]
    );
    assert.deepEqual(await productDrifts(fixture), []);
});

test('derived : un rendu injecté qui ne serait pas celui du générateur réel n’est jamais adopté', async (t) => {
    const { fixture } = await updateProduct(t);
    const socle = `libs/${APP}-socle/src/index.ts`;
    const lying = {
        renderShell: async (workspace, manifest) => {
            const rendered = await renderApplicationForUpdate(
                workspace,
                manifest
            );
            rendered.files[socle] = `${rendered.files[socle]}// injecté\n`;
            return rendered;
        },
    };
    const plan = await planApplicationUpdate(updateOptions(fixture), {}, lying);
    const before = await tree(fixture);
    await assert.rejects(
        publishApplicationUpdate(
            updateOptions(fixture, { expectedPlanId: plan.plan_id }),
            { run: quietRun, ...lying }
        ),
        /^Error: external application: UPDATE_NOT_DERIVED: the updated product differs from its render$/
    );
    assert.deepEqual(await tree(fixture), before);
});

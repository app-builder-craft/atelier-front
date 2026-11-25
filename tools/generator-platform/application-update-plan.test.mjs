// Lot 2, commit 6c (cadrage § 20 ; conception v2 R2.1.2, R2.1.5, R2.1.8 et
// R2.7, v3 V3.5 c et g, V3.6 point 2, v4 V4.6 ; index du pilote, R5) : le
// plan d'`update-app` (`--dry-run`). Oracles écrits ici :
// - R5 : le message de la fraîcheur nomme une commande EXACTE, qui existe et
//   rend un plan ;
// - N11 : rien à changer → `update without change` ;
// - N2, N3 : un fichier possédé retouché est refusé par l'intégrité, même
//   si une source a changé ;
// - N9 : `UPDATE_REQUIRES_WORKSPACE_CHANGE <fichier>` ;
// - P6 : montée du générateur simulée, sources inchangées → `generator` ;
// - N8 : `UPDATE_PATH_OWNED_BY_PUBLICATION <app> <chemin> <outil>` ;
// - N13 : `UPDATE_APP_REJECTED`, toutes les applis en cause, triées ; N13
//   bis (deux conceptions) : A valide, B refusée, rien n'est écrit pour A ;
// - `UPDATE_SEED_PATH_TAKEN <chemin>` ; rien n'est écrit par un plan.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { UPDATE_HINT } from './core/application-sources.mjs';
import { RECOVERY_COMMANDS } from './core/application-transaction.mjs';
import {
    planApplicationUpdate,
    publicApplicationUpdatePlan,
    renderApplicationForUpdate,
    renderWorkspaceFiles,
} from './core/application-update.mjs';
import {
    planApplicationPublication,
    publishApplicationPublication,
} from './core/application-publication.mjs';
import { renderProductShell } from './core/application-workspace.mjs';
import { SIGNATURE_FILES } from './core/atelier-signature.mjs';
import { appManifestPath } from './renderers/external-product-layout.mjs';
import {
    snapshotTree,
    TOOLS_ROOT,
} from './test-support/external-application-fixture.mjs';
import {
    addPage,
    APP,
    compileDesign,
    createApp,
    NEW_PAGE,
    quietRun,
    recompileContract,
    removePage,
    updateOptions,
    updateProduct,
} from './test-support/application-update-fixture.mjs';
import { publishApplicationUpdate } from './core/application-update-transaction.mjs';

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const exactly = (message) =>
    new RegExp(`^Error: external application: ${escape(message)}$`);

function runUpdateCli(args) {
    return spawnSync(
        process.execPath,
        [join(TOOLS_ROOT, 'tools/update-app.mjs'), ...args],
        { cwd: TOOLS_ROOT, encoding: 'utf8', timeout: 120_000 }
    );
}

test('R5 : le message de la fraîcheur nomme une commande exacte, qui existe et rend un plan', async (t) => {
    const match = /^ ; lancer (\S+) (--target-root) <racine> (--dry-run)$/.exec(
        UPDATE_HINT
    );
    assert.ok(match, UPDATE_HINT);
    const scripts = JSON.parse(
        await readFile(join(TOOLS_ROOT, 'package.json'), 'utf8')
    ).scripts;
    assert.equal(scripts[match[1]], 'node tools/update-app.mjs');
    // La reprise nommée par un refus « pending » existe aussi.
    assert.equal(
        scripts[RECOVERY_COMMANDS.update],
        'node tools/recover-application-update.mjs'
    );
    const { fixture, request } = await updateProduct(t);
    await recompileContract(fixture, request);
    // La commande du message, telle quelle, la racine substituée.
    const result = runUpdateCli([match[2], fixture.root, match[3]]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.match(plan.plan_id, /^[a-f0-9]{64}$/);
    assert.deepEqual(
        plan.apps.map(({ app_name, status, reason }) => [
            app_name,
            status,
            reason,
        ]),
        [[APP, 'updated', 'sources']]
    );
    assert.deepEqual(
        plan.apps[0].sources.map(({ genre, path, change }) => [
            genre,
            path,
            change,
        ]),
        [
            ['contract', request.outputPath, 'modified'],
            ['contract', request.definitionPath, 'modified'],
        ]
    );
    assert.equal(result.stdout.includes(fixture.root), false);
});

test('N11 : rien à changer, refus nommé ; un plan n’écrit rien', async (t) => {
    const { fixture } = await updateProduct(t);
    const before = await snapshotTree(fixture.root);
    const result = runUpdateCli(['--target-root', fixture.root, '--dry-run']);
    assert.equal(result.status, 1);
    assert.equal(
        result.stderr,
        'external application: update without change\n'
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
});

test('N2, N3 : un fichier du socle retouché est refusé par l’intégrité, même avec une source changée', async (t) => {
    const { fixture, request } = await updateProduct(t);
    const socle = join(fixture.root, `libs/${APP}-socle/src/index.ts`);
    await writeFile(socle, `${await readFile(socle, 'utf8')}// retouche\n`);
    await assert.rejects(
        planApplicationUpdate(updateOptions(fixture)),
        exactly('workspace ownership drift')
    );
    // La source change à la main (l'auteur, lui, est refusé par l'intégrité,
    // N12) : l'intégrité reste la première refusée.
    const definition = join(fixture.root, request.definitionPath);
    await writeFile(definition, `${await readFile(definition, 'utf8')}\n`);
    await assert.rejects(
        planApplicationUpdate(updateOptions(fixture)),
        exactly('workspace ownership drift')
    );
});

test('N9 : un fichier d’espace que le générateur courant rend autrement est un refus nommé', async (t) => {
    const { fixture, request } = await updateProduct(t);
    await recompileContract(fixture, request);
    // Témoin : sans injection, le plan passe.
    await planApplicationUpdate(updateOptions(fixture));
    await assert.rejects(
        planApplicationUpdate(
            updateOptions(fixture),
            {},
            {
                renderWorkspace: async (workspace) => {
                    const files = await renderWorkspaceFiles(workspace);
                    return { ...files, 'nx.json': `${files['nx.json']} ` };
                },
            }
        ),
        exactly('UPDATE_REQUIRES_WORKSPACE_CHANGE nx.json')
    );
});

// Montée du générateur simulée : un fichier du socle rendu autrement.
const SOCLE_INDEX = `libs/${APP}-socle/src/index.ts`;
const upgraded = async (workspace, manifest) => {
    const rendered = await renderApplicationForUpdate(workspace, manifest);
    rendered.files[SOCLE_INDEX] = `${rendered.files[SOCLE_INDEX]}// v2\n`;
    return rendered;
};

test('P6 : montée du générateur simulée, sources inchangées : raison `generator`, fichier remplacé', async (t) => {
    const { fixture } = await updateProduct(t);
    const plan = await planApplicationUpdate(
        updateOptions(fixture),
        {},
        {
            renderShell: upgraded,
        }
    );
    const [app] = publicApplicationUpdatePlan(plan).apps;
    assert.equal(app.status, 'updated');
    assert.equal(app.reason, 'generator');
    assert.deepEqual(app.sources, []);
    assert.deepEqual(app.files, [{ path: SOCLE_INDEX, change: 'replaced' }]);
});

test('N8 : un chemin écrit en dernier par une publication n’est jamais réécrit ; une page retirée qui garde une publication est refusée', async (t) => {
    const { fixture, request } = await updateProduct(t);
    // Une lecture publiée dans le socle.
    const query = `libs/${APP}-socle/src/queries/liste/model.json`;
    const publication = {
        workspaceRoot: TOOLS_ROOT,
        targetRoot: fixture.root,
        appName: APP,
        tool: 'generate:list-query',
        files: { [query]: '{"liste":1}\n' },
    };
    const reviewed = await planApplicationPublication(publication);
    await publishApplicationPublication(
        { ...publication, expectedPlanId: reviewed.plan_id },
        { run: quietRun }
    );
    // Le rendu veut réécrire ce chemin : refus nommé.
    await assert.rejects(
        planApplicationUpdate(
            updateOptions(fixture),
            {},
            {
                renderShell: async (workspace, manifest) => {
                    const rendered = await renderApplicationForUpdate(
                        workspace,
                        manifest
                    );
                    rendered.files[query] = '{"liste":2}\n';
                    return rendered;
                },
            }
        ),
        exactly(
            `UPDATE_PATH_OWNED_BY_PUBLICATION ${APP} ${query} generate:list-query`
        )
    );
    // Une mise à jour réelle garde la publication telle quelle.
    await recompileContract(fixture, request);
    const plan = await planApplicationUpdate(updateOptions(fixture));
    assert.equal(
        plan.apps[0].changes.some((change) => change.path === query),
        false
    );
    // Page ajoutée, publiée dans le socle, puis retirée : refus nommé.
    await addPage(fixture);
    const added = await planApplicationUpdate(updateOptions(fixture));
    await publishApplicationUpdate(
        updateOptions(fixture, { expectedPlanId: added.plan_id }),
        { run: quietRun }
    );
    const pageFile = `libs/${APP}-socle/src/pages/${NEW_PAGE}/vue/model.json`;
    const pagePublication = {
        ...publication,
        tool: 'generate:action-request',
        files: { [pageFile]: '{"page":1}\n' },
    };
    const pageReviewed = await planApplicationPublication(pagePublication);
    await publishApplicationPublication(
        { ...pagePublication, expectedPlanId: pageReviewed.plan_id },
        { run: quietRun }
    );
    await removePage(fixture);
    await assert.rejects(
        planApplicationUpdate(updateOptions(fixture)),
        exactly(
            `UPDATE_PATH_OWNED_BY_PUBLICATION ${APP} ${pageFile} generate:action-request`
        )
    );
});

test('N13 : une conception refusée arrête tout le plan ; toutes les applis en cause, triées ; rien n’est écrit', async (t) => {
    const { fixture } = await updateProduct(t);
    await createApp(fixture, 'doc-two');
    // L'erreur de validation accompagne le refus, au message inchangé.
    const design = join(fixture.root, fixture.designPath);
    const valid = await readFile(design, 'utf8');
    const broken = JSON.parse(valid);
    broken.pages[0].actions[0].destination_page_id = 'page_ffffffffffffffff';
    await writeFile(design, `${JSON.stringify(broken, null, 2)}\n`);
    const before = await snapshotTree(fixture.root);
    const error = await renderProductShell({
        productRoot: fixture.root,
        toolsRoot: TOOLS_ROOT,
        appName: APP,
        designPath: fixture.designPath,
        experienceId: broken.experiences[0].id,
        profile: 'angular-pwa',
        prefix: JSON.parse(
            await readFile(
                join(fixture.root, SIGNATURE_FILES.workspaceManifest),
                'utf8'
            )
        ).identity.prefix,
    }).catch((caught) => caught);
    assert.equal(
        error.message,
        'external application: product application-design rejected'
    );
    assert.ok(error.validation.length > 0);
    const rejected = await planApplicationUpdate(updateOptions(fixture)).catch(
        (caught) => caught
    );
    const lines = rejected.message
        .replace(/^external application: /, '')
        .split('\n');
    assert.deepEqual(
        lines.map((line) => line.split(' : ')[0]),
        [
            `UPDATE_APP_REJECTED ${APP} design ${fixture.designPath}`,
            `UPDATE_APP_REJECTED doc-two design ${fixture.designPath}`,
        ]
    );
    assert.ok(lines.every((line) => line.split(' : ')[1].length > 0));
    assert.deepEqual(await snapshotTree(fixture.root), before);
    // Issue : la conception corrigée, la mise à jour passe pour les deux,
    // avec le même plan.
    await writeFile(design, valid.replace(/\n$/, '\n\n'));
    const plan = await planApplicationUpdate(updateOptions(fixture));
    assert.deepEqual(
        plan.apps.map((app) => [app.app_name, app.status]),
        [
            [APP, 'updated'],
            ['doc-two', 'updated'],
        ]
    );
    await publishApplicationUpdate(
        updateOptions(fixture, { expectedPlanId: plan.plan_id }),
        { run: quietRun }
    );
    for (const app of [APP, 'doc-two']) {
        const manifest = JSON.parse(
            await readFile(join(fixture.root, appManifestPath(app)), 'utf8')
        );
        assert.equal(
            manifest.ownership.publications.at(-1).plan_id,
            plan.plan_id
        );
    }
});

test('N13 bis : A valide, B refusée sur sa propre conception : rien n’est écrit pour A, même en suivant le plan à vide', async (t) => {
    // V3.5 g : deux conceptions, chacune compilée par son auteur (la CLI
    // réelle), une appli sur chacune ; le contrat recompilé rend A à mettre à
    // jour, et la conception de B devient invalide.
    const { fixture, request } = await updateProduct(t);
    const second = fixture.designPath.replace(/\.json$/, '-two.json');
    compileDesign(fixture, second);
    await createApp(fixture, 'doc-two', second);
    await recompileContract(fixture, request);
    const path = join(fixture.root, second);
    const valid = await readFile(path, 'utf8');
    const broken = JSON.parse(valid);
    broken.pages[0].actions[0].destination_page_id = 'page_ffffffffffffffff';
    await writeFile(path, `${JSON.stringify(broken, null, 2)}\n`);
    const before = await snapshotTree(fixture.root);
    // L'auteur suit le plan à vide, s'il en rend un : appliqué, il écrirait A
    // seule. Rien ne doit être écrit, ni pour A, ni pour B.
    const dry = await planApplicationUpdate(updateOptions(fixture)).catch(
        (caught) => caught
    );
    if (!(dry instanceof Error))
        await publishApplicationUpdate(
            updateOptions(fixture, { expectedPlanId: dry.plan_id }),
            { run: quietRun }
        ).catch(() => undefined);
    assert.deepEqual(
        await snapshotTree(fixture.root),
        before,
        'N13 : rien n’est écrit pour A'
    );
    // Le refus nomme B seul, avec la raison de la validation.
    assert.ok(dry instanceof Error, 'N13 : le plan à vide est refusé');
    const lines = dry.message
        .replace(/^external application: /, '')
        .split('\n');
    assert.deepEqual(
        lines.map((line) => line.split(' : ')[0]),
        [`UPDATE_APP_REJECTED doc-two design ${second}`]
    );
    assert.ok(lines[0].split(' : ')[1].length > 0);
    // Issue : l'auteur recompile B (remplacement de sa sortie présente, sous
    // plan), puis UN plan pour les deux, un enregistrement par appli, même
    // `plan_id`.
    compileDesign(fixture, second);
    assert.equal(await readFile(path, 'utf8'), valid);
    const plan = await planApplicationUpdate(updateOptions(fixture));
    assert.deepEqual(
        plan.apps.map((app) => [app.app_name, app.status]),
        [
            [APP, 'updated'],
            ['doc-two', 'updated'],
        ]
    );
    await publishApplicationUpdate(
        updateOptions(fixture, { expectedPlanId: plan.plan_id }),
        { run: quietRun }
    );
    for (const app of [APP, 'doc-two']) {
        const manifest = JSON.parse(
            await readFile(join(fixture.root, appManifestPath(app)), 'utf8')
        );
        assert.equal(
            manifest.ownership.publications.at(-1).plan_id,
            plan.plan_id
        );
    }
});

test('UPDATE_SEED_PATH_TAKEN : une amorce d’une page nouvelle ne prend jamais un chemin présent', async (t) => {
    const { fixture } = await updateProduct(t);
    await addPage(fixture);
    const plan = await planApplicationUpdate(updateOptions(fixture));
    const [app] = publicApplicationUpdatePlan(plan).apps;
    assert.deepEqual(app.pages, { added: [NEW_PAGE], removed: [] });
    assert.ok(app.interface_seeds.length > 0);
    assert.ok(
        app.interface_seeds.every((path) =>
            path.startsWith(`libs/${APP}-interface/src/pages/${NEW_PAGE}/`)
        )
    );
    const taken = app.interface_seeds[0];
    await mkdir(dirname(join(fixture.root, taken)), { recursive: true });
    await writeFile(join(fixture.root, taken), '// écrit par l’IA\n');
    const before = await snapshotTree(fixture.root);
    await assert.rejects(
        planApplicationUpdate(updateOptions(fixture)),
        exactly(`UPDATE_SEED_PATH_TAKEN ${taken}`)
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
});

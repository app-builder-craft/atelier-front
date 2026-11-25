// Lot 2, commit 6a (index du pilote, L-21 ; avis de Fable sur L-21) :
// remplacement d'une sortie présente par son auteur, sous plan. Oracles écrits
// ici :
// - le plan lie l'empreinte de la sortie présente (`output_before_sha256`) ;
//   l'application ne remplace qu'elle, par un renommage atomique ; changée
//   après le plan, ou étrangère, elle est refusée et laissée telle quelle ;
// - reprise après une coupure (candidat écrit, ou sortie liée) ;
// - gardes de course de `publishCompilationWithContext`.
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
    planApplicationDesignPublication,
    publishApplicationDesign,
} from './core/application-design-publication.mjs';
import { publishCompilationWithContext } from './core/compilation-context.mjs';
import { publishDocument } from './core/document-publication.mjs';
import { sha256 } from './core/generation-manifest.mjs';
import {
    planStructuredBackendPublication,
    publishStructuredBackendContract,
} from './core/structured-backend-publication.mjs';
import { TOOLS_ROOT } from './test-support/external-application-fixture.mjs';
import {
    compileDocumentFixture,
    documentFixture,
} from './test-support/external-document-fixture.mjs';

const backendOptions = (fixture, request = fixture.backendRequests.at(-1)) => ({
    workspaceRoot: TOOLS_ROOT,
    targetRoot: fixture.root,
    backendContractSchema: fixture.backendContractSchema,
    ...request,
});
const designOptions = (fixture) => ({
    workspaceRoot: TOOLS_ROOT,
    targetRoot: fixture.root,
    sourcePath: fixture.sourcePath,
    outputPath: fixture.designPath,
    applicationDesignSchema: fixture.applicationDesignSchema,
    backendContractSchema: fixture.backendContractSchema,
});

// Lot 2, commit 6a (index du pilote, L-21) : l'auteur remplace la sortie
// PRÉSENTE que son plan relu nomme (`output_before_sha256`, lié au
// `plan_id`), par un renommage atomique ; une sortie changée après le
// plan, ou étrangère, est refusée et laissée telle quelle.
test('L-21 : sortie présente remplacée sous plan ; changée après le plan, refusée ; reprise après le candidat', async (t) => {
    const fixture = await documentFixture(t, 'B');
    await compileDocumentFixture(fixture);
    const request = fixture.backendRequests.at(-1);
    const options = backendOptions(fixture, request);
    const output = join(fixture.root, request.outputPath);
    const definition = join(fixture.root, request.definitionPath);
    const published = await readFile(output);
    await writeFile(
        definition,
        Buffer.concat([await readFile(definition), Buffer.from('\n')])
    );
    const plan = await planStructuredBackendPublication(options);
    assert.equal(plan.output_before_sha256, sha256(published));
    assert.notEqual(plan.output_sha256, plan.output_before_sha256);
    // Sortie changée APRÈS le plan relu : plan périmé, rien remplacé.
    await writeFile(output, 'changée après le plan\n');
    await assert.rejects(
        publishStructuredBackendContract({
            ...options,
            planId: plan.plan_id,
        }),
        /reviewed plan id is stale/
    );
    assert.equal(await readFile(output, 'utf8'), 'changée après le plan\n');
    await writeFile(output, published);
    // Coupure entre l'écriture du candidat et son renommage : reprise.
    await writeFile(plan.candidate, plan.content, { flag: 'wx' });
    const replaced = await publishStructuredBackendContract({
        ...options,
        planId: plan.plan_id,
    });
    assert.equal(replaced.already_published, false);
    assert.equal(sha256(await readFile(output)), plan.output_sha256);
    await assert.rejects(readFile(plan.candidate), /ENOENT/);
    // Le plan d'avant est périmé ; un plan neuf voit l'après en place.
    await assert.rejects(
        publishStructuredBackendContract({
            ...options,
            planId: plan.plan_id,
        }),
        /reviewed plan id is stale/
    );
    const again = await planStructuredBackendPublication(options);
    assert.equal(again.output_before_sha256, again.output_sha256);
    const replay = await publishStructuredBackendContract({
        ...options,
        planId: again.plan_id,
    });
    assert.equal(replay.already_published, true);
    // La conception aussi lie sa sortie présente : changée après le
    // plan, la publication est refusée et la sortie laissée.
    const designPlan = await planApplicationDesignPublication(
        designOptions(fixture)
    );
    const designOutput = join(fixture.root, fixture.designPath);
    assert.equal(
        designPlan.output_before_sha256,
        sha256(await readFile(designOutput))
    );
    await writeFile(designOutput, '{}\n');
    await assert.rejects(
        publishApplicationDesign({
            ...designOptions(fixture),
            planId: designPlan.plan_id,
        }),
        /reviewed plan id is stale/
    );
    assert.equal(await readFile(designOutput, 'utf8'), '{}\n');
});

test('L-21 : publishDocument refuse une sortie étrangère et une sortie disparue, sans rien écrire', async (t) => {
    const fixture = await documentFixture(t, 'B');
    const parent = join(fixture.root, 'descriptions');
    const outputAbsolute = join(parent, 'l21.json');
    const plan = (before) => ({
        outputAbsolute,
        outputParent: parent,
        candidate: join(parent, '.l21.json.candidate'),
        content: Buffer.from('après\n'),
        output_sha256: sha256('après\n'),
        output_before_sha256: before,
    });
    const failure = (message) => {
        throw new Error(message);
    };
    await writeFile(outputAbsolute, 'étrangère\n');
    await assert.rejects(
        publishDocument(plan(sha256('avant\n')), failure),
        /^Error: existing output hash does not match the reviewed plan$/
    );
    await assert.rejects(
        publishDocument(plan(null), failure),
        /^Error: existing output hash does not match the reviewed plan$/
    );
    assert.equal(await readFile(outputAbsolute, 'utf8'), 'étrangère\n');
    await assert.rejects(readFile(plan(null).candidate), /ENOENT/);
    await writeFile(outputAbsolute, 'avant\n');
    const done = await publishDocument(plan(sha256('avant\n')), failure);
    assert.equal(done.replaced, true);
    assert.equal(await readFile(outputAbsolute, 'utf8'), 'après\n');
    await rename(outputAbsolute, `${outputAbsolute}.retirée`);
    await assert.rejects(
        publishDocument(plan(sha256('avant\n')), failure),
        /^Error: existing output disappeared since the reviewed plan$/
    );
    await assert.rejects(readFile(outputAbsolute), /ENOENT/);
    await mkdir(outputAbsolute);
    await assert.rejects(
        publishDocument(plan(sha256('avant\n')), failure),
        /^Error: existing output is not a regular file$/
    );
});

test('L-21 : plan de création relu, sortie et candidat présents (coupure après le lien) : reprise sans effet', async (t) => {
    const fixture = await documentFixture(t, 'B');
    const options = backendOptions(fixture);
    const plan = await planStructuredBackendPublication(options);
    assert.equal(plan.output_before_sha256, null);
    assert.equal(plan.plan_id, plan.creation_plan_id);
    await writeFile(plan.candidate, plan.content, { flag: 'wx' });
    await writeFile(plan.outputAbsolute, plan.content, { flag: 'wx' });
    const recovered = await publishStructuredBackendContract({
        ...options,
        planId: plan.plan_id,
    });
    assert.equal(recovered.already_published, true);
    await assert.rejects(readFile(plan.candidate), /ENOENT/);
    assert.equal(
        sha256(await readFile(plan.outputAbsolute)),
        plan.output_sha256
    );
});

// Gardes de course de `publishCompilationWithContext`, éprouvées par les
// états qu'elle observe (sous verrou, puis après la publication).
test('L-21 : sous verrou, plan relu retrouvé sur l’état observé ; après, seule l’identité hors sortie compte', async (t) => {
    const fixture = await documentFixture(t, 'B');
    const options = backendOptions(fixture);
    const real = await planStructuredBackendPublication(options);
    // Plan relu de REMPLACEMENT (avant non nul) : son identifiant n'est
    // pas celui de création.
    const base = {
        ...real,
        plan_id: 'a'.repeat(64),
        output_before_sha256: 'f'.repeat(64),
    };
    const failure = (message) => {
        throw new Error(message);
    };
    const run = (states) => {
        const calls = [];
        let index = 0;
        const result = publishCompilationWithContext(
            { ...options, planId: base.plan_id },
            base,
            async () => states[index++],
            async (current) => {
                calls.push(current.plan_id);
                return { plan: current, already_published: false };
            },
            failure
        );
        return { calls, result };
    };
    // Positif : la publication change l'état de la sortie, l'identité
    // hors sortie reste.
    const published = {
        ...base,
        plan_id: 'b'.repeat(64),
        output_before_sha256: base.output_sha256,
    };
    const ok = run([base, published]);
    assert.equal((await ok.result).already_published, false);
    assert.deepEqual(ok.calls, [base.plan_id]);
    // Sous verrou, autre identité hors sortie (même identifiant de plan).
    const moved = run([{ ...base, creation_plan_id: 'c'.repeat(64) }]);
    await assert.rejects(
        moved.result,
        /external compilation: reviewed plan changed under lock$/
    );
    assert.deepEqual(moved.calls, []);
    // Sous verrou, sortie changée depuis le plan relu.
    const drifted = run([
        {
            ...base,
            plan_id: 'd'.repeat(64),
            output_before_sha256: 'e'.repeat(64),
        },
    ]);
    await assert.rejects(
        drifted.result,
        /external compilation: reviewed plan changed under lock$/
    );
    assert.deepEqual(drifted.calls, []);
    // Après la publication, autre identité hors sortie.
    const changed = run([
        base,
        { ...published, creation_plan_id: 'c'.repeat(64) },
    ]);
    await assert.rejects(
        changed.result,
        /external compilation: context changed during publication; inspect the preserved output$/
    );
    assert.deepEqual(changed.calls, [base.plan_id]);
});

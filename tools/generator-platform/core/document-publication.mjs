import { createHash } from 'node:crypto';
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}

// Lot 2, commit 6a (index du pilote, L-21) : identité d'un plan de document.
// L'empreinte de la sortie présente au plan (`before`) n'y entre que si la
// sortie existe : un plan de création garde l'identité qu'il avait avant le
// lot 2, et `creation_plan_id` (la même identité, sortie absente) nomme le
// plan sans l'état de sa sortie.
function documentPlanIdentity(fields, before) {
    const identity = (value) =>
        sha256(
            JSON.stringify(
                value === null
                    ? fields
                    : { ...fields, output_before_sha256: value }
            )
        );
    return { plan_id: identity(before), creation_plan_id: identity(null) };
}

// Candidat d'un plan, nommé par l'identifiant du plan relu.
const documentCandidate = (outputAbsolute, planId) =>
    resolve(
        dirname(outputAbsolute),
        `.${basename(outputAbsolute)}.${planId}.candidate`
    );

// Plan relu par son identifiant : le plan de l'état présent de la sortie, ou
// le plan de CRÉATION dont la sortie est apparue depuis (rejeu d'une
// publication faite, ou sortie étrangère, que `publishDocument` tranche).
// Une sortie présente changée depuis le plan relu le rend périmé.
export function reviewedDocumentPlan(plan, planId, fail) {
    if (planId === plan.plan_id) return plan;
    if (planId !== plan.creation_plan_id)
        fail('reviewed plan id is stale or invalid');
    return {
        ...plan,
        plan_id: planId,
        output_before_sha256: null,
        candidate: documentCandidate(plan.outputAbsolute, planId),
    };
}

async function entryExists(path) {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function syncDirectory(path) {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function assertContent(path, expectedHash, label, fail) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        fail(`${label} is not a regular file`);
    }
    if (sha256(await readFile(path)) !== expectedHash) {
        fail(`${label} hash does not match the reviewed plan`);
    }
}

async function presentDigest(path, label, fail) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        fail(`${label} is not a regular file`);
    }
    return sha256(await readFile(path));
}

// Lot 2, commit 6a (index du pilote, L-21) : partie commune de TOUT plan de
// document, calculée ici seulement. L'empreinte de la sortie PRÉSENTE au plan
// (`output_before_sha256`, `null` si elle est absente) entre dans l'identité
// du plan : c'est la seule sortie que l'application peut remplacer. `output` :
// { absolute, parent } de la sortie, résolue par le planificateur.
export async function documentPlan(fields, output, fail) {
    const before = (await entryExists(output.absolute))
        ? await presentDigest(output.absolute, 'existing output', fail)
        : null;
    const identity = documentPlanIdentity(fields, before);
    return {
        ...identity,
        output_before_sha256: before,
        candidate: documentCandidate(output.absolute, identity.plan_id),
        outputAbsolute: output.absolute,
        outputParent: output.parent,
    };
}

// Candidat du plan : repris s'il est exact (reprise après une coupure), sinon
// écrit à neuf, jamais par-dessus un fichier présent.
async function stageCandidate(plan, candidateExists, fail) {
    if (candidateExists) {
        await assertContent(
            plan.candidate,
            plan.output_sha256,
            'recovery candidate',
            fail
        );
        return;
    }
    const handle = await open(plan.candidate, 'wx', 0o644);
    try {
        await handle.writeFile(plan.content);
        await handle.sync();
    } finally {
        await handle.close();
    }
    await syncDirectory(plan.outputParent);
}

// Une sortie présente n'est remplacée que si elle est EXACTEMENT celle du plan
// relu (`output_before_sha256`), par un renommage atomique du candidat ; une
// sortie étrangère (ni l'avant ni l'après du plan) est toujours refusée, et
// l'après déjà en place est une publication faite (rejeu sans effet).
export async function publishDocument(plan, fail) {
    const before = plan.output_before_sha256;
    const outputExists = await entryExists(plan.outputAbsolute);
    const candidateExists = await entryExists(plan.candidate);
    if (outputExists) {
        const present = await presentDigest(
            plan.outputAbsolute,
            'existing output',
            fail
        );
        if (present === plan.output_sha256) {
            if (candidateExists) {
                await assertContent(
                    plan.candidate,
                    plan.output_sha256,
                    'recovery candidate',
                    fail
                );
                await unlink(plan.candidate);
                await syncDirectory(plan.outputParent);
            }
            return { plan, already_published: true };
        }
        if (present !== before)
            fail('existing output hash does not match the reviewed plan');
        await stageCandidate(plan, candidateExists, fail);
        await rename(plan.candidate, plan.outputAbsolute);
        await syncDirectory(plan.outputParent);
        await assertContent(
            plan.outputAbsolute,
            plan.output_sha256,
            'published output',
            fail
        );
        return { plan, already_published: false, replaced: true };
    }
    if (before !== null)
        fail('existing output disappeared since the reviewed plan');

    await stageCandidate(plan, candidateExists, fail);

    try {
        await link(plan.candidate, plan.outputAbsolute);
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await assertContent(
            plan.outputAbsolute,
            plan.output_sha256,
            'concurrent output',
            fail
        );
    }
    await syncDirectory(plan.outputParent);
    await assertContent(
        plan.outputAbsolute,
        plan.output_sha256,
        'published output',
        fail
    );
    await unlink(plan.candidate);
    await syncDirectory(plan.outputParent);
    return { plan, already_published: false };
}

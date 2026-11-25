// Lot 2, commit 6c (conception v3 V3.6 point 4 et V3.5 c, v2 R2.7 N10 ;
// v5 C-B1) : `update-app` arrêté par SIGKILL à CHAQUE phase de sa
// transaction (candidats, chaque contrôle du témoin, chaque échange de
// racine, chaque écriture et chaque bascule de fichier de l'interface, pose
// d'amorce comprise, chaque contrôle après l'échange, `derived`, rapport,
// `verified`). Oracles écrits ici :
// - toute autre commande est refusée tant que la reprise n'est pas faite,
//   en nommant `recover:application-update` ;
// - la reprise rend l'état EXACT d'avant (à l'octet), ou finit en avant à
//   `verified` (plus rien à changer, amorces présentes) ;
// - état ambigu (arbre échangé ou fichier basculé retouché pendant l'arrêt,
//   arbre de travail sans journal) : refus nommé, rien n'est déplacé.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { recoverApplicationPublication } from './core/application-publication.mjs';
import { planApplicationUpdate } from './core/application-update.mjs';
import {
    publishApplicationUpdate,
    recoverApplicationUpdate,
} from './core/application-update-transaction.mjs';
import { appManifestPath } from './renderers/external-product-layout.mjs';
import { snapshotTree } from './test-support/external-application-fixture.mjs';
import {
    addPage,
    APP,
    ownedSnapshot,
    quietRun,
    recompileContract,
    updateOptions,
    updateProduct,
} from './test-support/application-update-fixture.mjs';

const MODULE = new URL(
    './core/application-update-transaction.mjs',
    import.meta.url
).href;
const PENDING =
    /^Error: external application: interrupted application update pending; recover it first \(recover:application-update\)$/;

// Produit à mettre à jour sur trois racines : page ajoutée (contrat de page,
// module du socle, amorces et carte des chargeurs de l'interface) et contrat
// recompilé.
async function scenario(t) {
    const { fixture, request } = await updateProduct(t);
    await addPage(fixture);
    await recompileContract(fixture, request);
    const plan = await planApplicationUpdate(updateOptions(fixture));
    return { fixture, plan, before: await snapshotTree(fixture.root) };
}

function killedAt(fixture, plan, interrupted) {
    const program = `import { publishApplicationUpdate } from ${JSON.stringify(MODULE)};
await publishApplicationUpdate(JSON.parse(process.argv[1]), { run() { return undefined; }, phase(name) { if (name === process.argv[2]) process.kill(process.pid, 'SIGKILL'); } });`;
    const result = spawnSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            program,
            JSON.stringify(
                updateOptions(fixture, { expectedPlanId: plan.plan_id })
            ),
            interrupted,
        ],
        { cwd: fixture.parent, encoding: 'utf8', timeout: 120_000 }
    );
    assert.equal(result.signal, 'SIGKILL', result.stderr);
}

test('N10 : arrêt brutal à chaque phase, toute commande refusée, reprise exacte ou en avant', async (t) => {
    const probe = await scenario(t);
    const phases = [];
    await publishApplicationUpdate(
        updateOptions(probe.fixture, { expectedPlanId: probe.plan.plan_id }),
        { run: quietRun, phase: (name) => phases.push(name) }
    );
    // Les points d'arrêt exigés par la conception sont tous observés.
    for (const required of [
        'candidate-staged',
        'witnessed',
        `swapped:apps/${APP}`,
        `swapped:libs/${APP}-socle`,
        'published',
        'derived',
        'verified',
    ])
        assert.ok(phases.includes(required), required);
    const seeds = Object.keys(probe.plan.apps[0].seeds);
    assert.ok(seeds.length > 0);
    for (const seed of seeds)
        assert.ok(phases.includes(`file-swapped:${seed}`), seed);
    for (const interrupted of phases)
        await t.test(`arrêt brutal à ${interrupted}`, async (child) => {
            const { fixture, plan, before } = await scenario(child);
            killedAt(fixture, plan, interrupted);
            // Toute autre commande est refusée, en nommant la reprise.
            await assert.rejects(
                planApplicationUpdate(updateOptions(fixture)),
                PENDING
            );
            await assert.rejects(
                recoverApplicationPublication(
                    updateOptions(fixture, { appName: APP })
                ),
                PENDING
            );
            const recovered = await recoverApplicationUpdate(
                updateOptions(fixture)
            );
            if (interrupted !== 'verified') {
                assert.deepEqual(recovered, {
                    recovered: true,
                    direction: 'back',
                });
                assert.deepEqual(await snapshotTree(fixture.root), before);
                return;
            }
            assert.deepEqual(recovered, {
                recovered: true,
                direction: 'forward',
            });
            await assert.rejects(
                planApplicationUpdate(updateOptions(fixture)),
                /update without change/
            );
            const manifest = JSON.parse(
                await readFile(join(fixture.root, appManifestPath(APP)), 'utf8')
            );
            assert.equal(
                manifest.ownership.publications.at(-1).plan_id,
                plan.plan_id
            );
            for (const seed of Object.keys(plan.apps[0].seeds))
                assert.equal(
                    await readFile(join(fixture.root, seed), 'utf8'),
                    plan.apps[0].seeds[seed]
                );
        });
});

test('N10 : état ambigu (arbre échangé ou fichier basculé retouché, arbre sans journal) refusé, rien n’est déplacé', async (t) => {
    // Arbre de la coque échangé, puis retouché pendant l'arrêt.
    {
        const { fixture, plan } = await scenario(t);
        killedAt(fixture, plan, `swapped:apps/${APP}`);
        const main = join(fixture.root, `apps/${APP}/src/main.ts`);
        await writeFile(main, `${await readFile(main, 'utf8')}// retouche\n`);
        const seen = ownedSnapshot(await snapshotTree(fixture.parent));
        await assert.rejects(
            recoverApplicationUpdate(updateOptions(fixture)),
            new RegExp(
                `^Error: external application: ambiguous interrupted application update: apps/${APP} renamed tree drifted$`
            )
        );
        assert.deepEqual(
            ownedSnapshot(await snapshotTree(fixture.parent)),
            seen
        );
    }
    // Amorce basculée, puis retouchée pendant l'arrêt.
    {
        const { fixture, plan } = await scenario(t);
        const seed = Object.keys(plan.apps[0].seeds)[0];
        killedAt(fixture, plan, `file-swapped:${seed}`);
        await writeFile(join(fixture.root, seed), '// retouchée\n');
        const seen = ownedSnapshot(await snapshotTree(fixture.parent));
        const root = `libs/${APP}-interface`;
        await assert.rejects(
            recoverApplicationUpdate(updateOptions(fixture)),
            new RegExp(
                `^Error: external application: ambiguous interrupted application update: ${root} ${seed.slice(root.length + 1)}$`
            )
        );
        assert.deepEqual(
            ownedSnapshot(await snapshotTree(fixture.parent)),
            seen
        );
    }
    // Arbre de travail d'une mise à jour sans journal.
    {
        const { fixture } = await updateProduct(t);
        await mkdir(
            join(
                fixture.root,
                'apps',
                `.${APP}.update-candidate-${'e'.repeat(64)}`
            )
        );
        const seen = ownedSnapshot(await snapshotTree(fixture.parent));
        await assert.rejects(
            recoverApplicationUpdate(updateOptions(fixture)),
            /^Error: external application: ambiguous interrupted application update: working tree without a journal$/
        );
        assert.deepEqual(
            ownedSnapshot(await snapshotTree(fixture.parent)),
            seen
        );
    }
});

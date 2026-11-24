// Lot 2 (conception v5, V5.2) : `create-app` arrêté par SIGKILL à chaque point
// de sa transaction sur trois racines (après les candidats, après CHAQUE
// échange de racine, après l'échange complet, après un contrôle natif, au
// point de non-retour) ; le journal bloque toute commande, le verrou mort est
// repris, et la reprise rend l'état exact d'avant ou d'après.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { recoverApplicationPublication } from './core/application-publication.mjs';
import {
    planExternalApplicationShell,
    publishExternalApplicationShell,
} from './core/application-workspace.mjs';
import {
    pathExists,
    verifyGeneratedTree,
} from './core/external-application-paths.mjs';
import {
    shellFixture,
    snapshotTree,
    TOOLS_ROOT,
} from './test-support/external-application-fixture.mjs';

test('T7 : arrêt brutal du processus entre chaque paire de racines, reprise exacte et verrou mort repris (lot 2, V5.2)', async (t) => {
    const probe = await shellFixture(t);
    const probePlan = await planExternalApplicationShell(probe.shell);
    const phases = [];
    await publishExternalApplicationShell(
        { ...probe.shell, expectedPlanId: probePlan.plan_id },
        { run: () => undefined, phase: (phase) => phases.push(phase) }
    );
    // Après les candidats, après CHAQUE échange de racine, après l'échange
    // complet, après un contrôle natif, et au point de non-retour.
    const interrupted = [
        'compiled',
        ...phases.filter((phase) => phase.startsWith('swapped:')),
        'published',
        phases.find((phase) => phase.endsWith(':lint')),
        'verified',
    ];
    assert.equal(
        interrupted.filter((phase) => phase.startsWith('swapped:')).length,
        3
    );
    for (const interruptedPhase of interrupted) {
        await t.test(interruptedPhase, async (child) => {
            const fixture = await shellFixture(child);
            const before = await snapshotTree(fixture.root, []);
            const plan = await planExternalApplicationShell(fixture.shell);
            const options = { ...fixture.shell, expectedPlanId: plan.plan_id };
            delete options.applicationDesignSchema;
            delete options.backendContractSchema;
            const moduleUrl = pathToFileURL(
                join(
                    TOOLS_ROOT,
                    'tools/generator-platform/core/application-workspace.mjs'
                )
            ).href;
            const program = `import { publishExternalApplicationShell } from ${JSON.stringify(moduleUrl)};
await publishExternalApplicationShell(JSON.parse(process.argv[1]), {
run() { return undefined; }, phase(phase) { if (phase === ${JSON.stringify(interruptedPhase)}) process.kill(process.pid, 'SIGKILL'); }
});`;
            const result = spawnSync(
                process.execPath,
                ['--input-type=module', '-e', program, JSON.stringify(options)],
                {
                    cwd: fixture.parent,
                    encoding: 'utf8',
                    timeout: 60_000,
                    env: { HOME: fixture.parent, PATH: '/usr/bin:/bin' },
                }
            );
            assert.equal(result.signal, 'SIGKILL', result.stderr);
            // Le journal bloque toute commande, sauf la reprise ; le verrou du
            // processus mort est repris.
            await assert.rejects(
                publishExternalApplicationShell(options, {
                    run: () => assert.fail('aucun contrôle avant la reprise'),
                }),
                /interrupted application creation pending; recover it first/
            );
            assert.equal(
                await pathExists(
                    join(
                        fixture.root,
                        'apps',
                        `.${plan.app_name}.generation-lock`
                    )
                ),
                false
            );
            const recovered = await recoverApplicationPublication({
                workspaceRoot: TOOLS_ROOT,
                targetRoot: fixture.root,
                appName: plan.app_name,
            });
            assert.equal(recovered.recovered, true);
            const forward = interruptedPhase === 'verified';
            assert.deepEqual(
                recovered.transactions.map(({ genre, direction }) => [
                    genre,
                    direction,
                ]),
                [['creation', forward ? 'forward' : 'back']]
            );
            if (forward) {
                for (const { root, files } of plan.roots)
                    await verifyGeneratedTree(join(fixture.root, root), files);
                return;
            }
            // Retour EXACT : le produit est égal à l'octet à l'état d'avant.
            assert.deepEqual(await snapshotTree(fixture.root, []), before);
            const result2 = await publishExternalApplicationShell(options, {
                run: () => undefined,
            });
            assert.equal(result2.recovered, false);
        });
    }
});

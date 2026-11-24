// Reprise explicite d'une transaction interrompue d'une appli (ADR-0103 ;
// lot 2, V5.2 : création ou publication, par son journal) : verrou, frontière
// du passe-droit `transaction` et commande recover:application-publication.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';

import {
    planExternalApplicationShell,
    publishExternalApplicationShell,
} from './core/application-workspace.mjs';
import {
    planApplicationPublication,
    publishApplicationPublication,
    recoverApplicationPublication,
} from './core/application-publication.mjs';
import { planExternalActionRequest } from './core/external-action-request.mjs';
import { pathExists } from './core/external-application-paths.mjs';
import { withGenerationLock } from './core/generation-transaction.mjs';
import {
    snapshotTree,
    TOOLS_ROOT,
} from './test-support/external-application-fixture.mjs';
import {
    interruptAfterSwap,
    interruptAt,
    publication,
    sessionApp,
} from './test-support/external-publication-fixture.mjs';
import {
    pendingTransactionJournals,
    transactionJournalRoot,
} from './core/application-transaction.mjs';
import { writeExternalActionDefinitions } from './test-support/external-session-fixture.mjs';
import { describeDrift } from '../recover-application-publication.mjs';
import {
    escapeRegExp,
    SIGNATURE,
    SIGNATURE_FILES,
} from './core/atelier-signature.mjs';

const CLI = join(TOOLS_ROOT, 'tools/recover-application-publication.mjs');

function recoverCli(args) {
    return spawnSync(process.execPath, [CLI, ...args], {
        cwd: TOOLS_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
    });
}

// « Aucun chemin local », dérivé et sans liste de systèmes : ni la racine réelle
// du produit, ni celle de l'atelier, ni un code d'erreur système (errno), quel
// que soit le système qui exécute le test.
function assertNoLocalPath(stderr, product) {
    for (const root of [product.root, TOOLS_ROOT])
        assert.doesNotMatch(stderr, new RegExp(escapeRegExp(root)));
    assert.doesNotMatch(stderr, /\bE[A-Z]{2,}\b:/);
}

test('X2 préparatoire : la reprise explicite prend le verrou de l’application (V-MC)', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const options = publication(product, { [product.notice]: 'export {};\n' });
    const before = await snapshotTree(product.root, []);
    await withGenerationLock(product.app, async () => {
        await assert.rejects(
            recoverApplicationPublication(options),
            /another generation owns/
        );
    });
    assert.deepEqual(await recoverApplicationPublication(options), {
        recovered: false,
        transactions: [],
    });
    assert.deepEqual(await snapshotTree(product.root, []), before);
});

// Fable I-1 (revue du suivi X1) : l'exception de reprise est un second
// paramètre de fonctions exportées. Seuls le planificateur d'espace, la
// vérification de la racine qu'il délègue et la publication la portent.
test('X2 préparatoire : le passe-droit `transaction` n’apparaît que dans les modules autorisés', async () => {
    // Lot 2 : une transaction tolère son propre journal par un second
    // paramètre (`internal.transaction`), jamais une option publique.
    const allowed = new Set([
        'tools/generator-platform/core/application-workspace.mjs',
        'tools/generator-platform/core/application-workspace-root.mjs',
        'tools/generator-platform/core/application-publication.mjs',
        relative(TOOLS_ROOT, new URL(import.meta.url).pathname),
    ]);
    const pattern =
        /\binternal\.transaction\b|\bplan\.transaction\b|\{ transaction: /;
    const skipped = new Set(['node_modules', '.stack-test-runtime']);
    const found = [];
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (skipped.has(entry.name)) continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await visit(path);
            else if (
                entry.isFile() &&
                entry.name.endsWith('.mjs') &&
                pattern.test(await readFile(path, 'utf8'))
            )
                found.push(relative(TOOLS_ROOT, path));
        }
    }
    await visit(join(TOOLS_ROOT, 'tools'));
    assert.ok(found.length >= 3, 'Oracle inopérant');
    assert.deepEqual(
        found.filter((path) => !allowed.has(path)),
        [],
        'Passe-droit de transaction utilisé hors des modules autorisés'
    );
});

test('X2 préparatoire : un arbre de travail sans journal est refusé, la reprise n’invente rien (M-7)', async (t) => {
    const product = await sessionApp(t, 'equipment-hire');
    const candidate = join(
        product.root,
        'apps',
        `.${product.shell.appName}.publication-candidate-${'e'.repeat(64)}`
    );
    await cp(product.app, candidate, { recursive: true });
    const before = await snapshotTree(product.root, []);
    await assert.rejects(
        planExternalApplicationShell({ ...product.shell, appName: 'other' }),
        /publication working tree without a journal/
    );
    await assert.rejects(
        recoverApplicationPublication(product.base),
        (error) =>
            /ambiguous interrupted application publication: working tree without a journal/.test(
                error.message
            ) && error.drift.kind === 'orphan'
    );
    assert.deepEqual(await snapshotTree(product.root, []), before);
});

test('X2 préparatoire : recover:application-publication reprend, refuse l’ambigu et n’invente rien', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const options = publication(product, { [product.notice]: 'export {};\n' });
    const args = [
        '--target-root',
        product.root,
        '--app',
        product.shell.appName,
    ];
    const before = await snapshotTree(product.root, []);
    let result = recoverCli(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'nothing-to-recover');
    // Interruption après échange : la commande rend l'état relu.
    const plan = await interruptAfterSwap(product, options);
    result = recoverCli(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
        schema_version: '1.0.0',
        app_name: product.shell.appName,
        status: 'recovered',
        transactions: [
            { genre: 'publication', plan_id: plan.plan_id, direction: 'back' },
        ],
    });
    assert.deepEqual(await snapshotTree(product.root, []), before);
    await planApplicationPublication(options);
    // État altéré : refus, rien n'est déplacé, la marche à suivre est donnée.
    await interruptAfterSwap(product, options);
    await writeFile(join(product.root, product.page), 'modifié à la main\n');
    const altered = await snapshotTree(product.root, []);
    result = recoverCli(args);
    assert.equal(result.status, 1);
    assert.match(
        result.stderr,
        /ambiguous interrupted application publication/
    );
    assert.match(result.stderr, /Ownership et reprise/);
    assertNoLocalPath(result.stderr, product);
    assert.deepEqual(await snapshotTree(product.root, []), altered);
    // Usage fermé : options requises, inconnues ou répétées refusées.
    for (const [argv, pattern] of [
        [
            ['--app', product.shell.appName],
            /--target-root et --app sont requis/,
        ],
        [[...args, '--force', 'x'], /Argument inconnu : --force/],
        [[...args, '--app', 'x'], /ne peut pas être répétée/],
        [['--target-root', 'relatif', '--app', 'x'], /canonical absolute/],
    ]) {
        result = recoverCli(argv);
        assert.equal(result.status, 1);
        assert.match(result.stderr, pattern);
    }
});

test('X3 préparatoire : un produit sans marqueur est refusé proprement par la reprise et les plans', async (t) => {
    const product = await sessionApp(t, 'equipment-hire');
    const { enter } = await writeExternalActionDefinitions(
        product.root,
        'equipment-hire'
    );
    const marker = join(product.root, SIGNATURE_FILES.workspaceManifest);
    await rename(marker, `${marker}.aside`);
    const before = await snapshotTree(product.root, []);
    const missing = (error) =>
        error.message ===
        'external application: workspace ownership marker missing';
    await assert.rejects(recoverApplicationPublication(product.base), missing);
    await assert.rejects(
        planApplicationPublication(
            publication(product, { [product.notice]: 'export {};\n' })
        ),
        missing
    );
    await assert.rejects(
        planExternalActionRequest({ ...product.base, definitionPath: enter }),
        missing
    );
    const result = recoverCli([
        '--target-root',
        product.root,
        '--app',
        product.shell.appName,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /workspace ownership marker missing/);
    assertNoLocalPath(result.stderr, product);
    assert.deepEqual(await snapshotTree(product.root, []), before);
    await rename(`${marker}.aside`, marker);
});

// Lot MARQUE, commit 4 : un produit à la disposition d'avant le renommage de
// la signature (dossier sous l'ANCIEN nom) est refusé par chaque commande, par
// un message fermé, sans erreur système ni chemin local, et rien ne bouge. Le
// vrai ancien nom est employé : un repli de compatibilité vers l'ancien dossier
// serait vu. Il est composé, pour que le contrôle du commit 7 (aucun ancien
// nom écrit en dur) n'ait rien à exempter.
test('MARQUE : un produit à l’ancienne disposition de la signature est refusé, nommé', async (t) => {
    const product = await sessionApp(t, 'equipment-hire');
    const { enter } = await writeExternalActionDefinitions(
        product.root,
        'equipment-hire'
    );
    const previous = `.${['c', 'mz'].join('')}`;
    assert.notEqual(previous, SIGNATURE.dir);
    // Les deux lecteurs du manifeste d'appli passent par `readAppManifest` : la
    // vérification de la racine (publication, et toute commande qui planifie
    // l'espace) et `sessionApplication` (requête d'action, et les quatre autres
    // commandes de session, qui l'appellent avant la vérification).
    // Chaque commande est nommée dans le message d'un refus manqué.
    const commands = [
        [
            'publication',
            () =>
                planApplicationPublication(
                    publication(product, { [product.notice]: 'export {};\n' })
                ),
        ],
        [
            'requête d’action',
            () =>
                planExternalActionRequest({
                    ...product.base,
                    definitionPath: enter,
                }),
        ],
    ];
    const refusedWith = (message) => (error) =>
        error.message === `external application: ${message}`;
    // Appli seule à l'ancienne disposition : refus à la lecture de son manifeste.
    const appSignature = join(product.app, SIGNATURE.dir);
    await rename(appSignature, join(product.app, previous));
    const mixed = await snapshotTree(product.root, []);
    for (const [name, command] of commands)
        await assert.rejects(
            command,
            refusedWith('app ownership marker missing'),
            `appli seule à l’ancienne disposition : ${name}`
        );
    assert.deepEqual(await snapshotTree(product.root, []), mixed);
    // Produit entier à l'ancienne disposition : refus au marqueur de l'espace.
    const rootSignature = join(product.root, SIGNATURE.dir);
    await rename(rootSignature, join(product.root, previous));
    const old = await snapshotTree(product.root, []);
    for (const [name, command] of [
        ...commands,
        ['reprise', () => recoverApplicationPublication(product.base)],
    ])
        await assert.rejects(
            command,
            refusedWith('workspace ownership marker missing'),
            `produit entier à l’ancienne disposition : ${name}`
        );
    const result = recoverCli([
        '--target-root',
        product.root,
        '--app',
        product.shell.appName,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /workspace ownership marker missing/);
    assertNoLocalPath(result.stderr, product);
    assert.deepEqual(await snapshotTree(product.root, []), old);
    await rename(join(product.root, previous), rootSignature);
    await rename(join(product.app, previous), appSignature);
});

// V-X2-3 : plusieurs sauvegardes ou candidats pour une application, la reprise
// ne choisit pas ; rien ne bouge.
test('X3 préparatoire : plusieurs transactions interrompues, reprise refusée sans rien déplacer', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const options = publication(product, { [product.notice]: 'export {};\n' });
    const args = [
        '--target-root',
        product.root,
        '--app',
        product.shell.appName,
    ];
    const plan = await interruptAfterSwap(product, options);
    // Un second journal valide pour la même appli : la reprise ne choisit pas.
    const journal = transactionJournalRoot(
        product.root,
        'publication',
        plan.plan_id
    );
    const other = 'a'.repeat(64);
    const copy = transactionJournalRoot(product.root, 'publication', other);
    await cp(journal, copy, { recursive: true });
    const text = await readFile(join(copy, 'journal.json'), 'utf8');
    await writeFile(
        join(copy, 'journal.json'),
        text.replaceAll(plan.plan_id, other)
    );
    const before = await snapshotTree(product.root, []);
    await assert.rejects(
        recoverApplicationPublication(product.base),
        (error) =>
            /ambiguous interrupted application publication: several interrupted transactions/.test(
                error.message
            ) && error.drift.kind === 'several'
    );
    const result = recoverCli(args);
    assert.equal(result.status, 1);
    assert.match(
        result.stderr,
        /plusieurs transactions interrompues pour cette application/
    );
    assert.deepEqual(await snapshotTree(product.root, []), before);
    await rm(copy, { recursive: true });
    assert.equal(
        (await recoverApplicationPublication(product.base)).recovered,
        true
    );
});

test('X3 préparatoire : après un retour arrière refusé, l’écart est nommé puis la reprise rend l’état relu', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const options = publication(product, { [product.notice]: 'export {};\n' });
    const before = await snapshotTree(product.root, []);
    const plan = await planApplicationPublication(options);
    const socle = `libs/${product.shell.appName}-socle`;
    const foreign = `${socle}/src/etranger.ts`;
    await assert.rejects(
        publishApplicationPublication(
            { ...options, expectedPlanId: plan.plan_id },
            {
                run: () => undefined,
                phase: async (name) => {
                    if (name !== 'published') return;
                    await writeFile(
                        join(product.root, foreign),
                        'export {};\n',
                        {
                            flag: 'wx',
                        }
                    );
                    throw new Error('altered');
                },
            }
        ),
        /publication rollback refused/
    );
    assert.ok(
        await pathExists(
            transactionJournalRoot(product.root, 'publication', plan.plan_id)
        )
    );
    const args = [
        '--target-root',
        product.root,
        '--app',
        product.shell.appName,
    ];
    const altered = await snapshotTree(product.root, []);
    let result = recoverCli(args);
    assert.equal(result.status, 1);
    assert.ok(
        result.stderr.includes(
            `Écart : "${foreign}" (fichier absent de la liste de cet arbre au journal).`
        ),
        result.stderr
    );
    assertNoLocalPath(result.stderr, product);
    assert.deepEqual(await snapshotTree(product.root, []), altered);
    // Marche à suivre : retirer l'altération nommée, relancer la reprise.
    await rm(join(product.root, foreign));
    result = recoverCli(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'recovered');
    assert.deepEqual(await snapshotTree(product.root, []), before);
    // Un fichier inscrit modifié est nommé comme tel.
    await interruptAfterSwap(product, options);
    await writeFile(join(product.root, product.page), 'modifié\n');
    result = recoverCli(args);
    assert.equal(result.status, 1);
    assert.ok(
        result.stderr.includes(
            `Écart : "${product.page}" (contenu différent de la liste de cet arbre au journal).`
        ),
        result.stderr
    );
});

test('Reprise : chaque écart reçoit un libellé, neutre quand la liste ne l’explique pas (M-5)', () => {
    assert.equal(
        describeDrift({ tree: 'apps/app', path: null, kind: 'tree' }),
        'Écart : "apps/app" (arbre non conforme à sa liste au journal).'
    );
    for (const kind of [
        'unlisted',
        'modified',
        'missing',
        'entry',
        'tree',
        'several',
        'orphan',
    ])
        assert.doesNotMatch(
            describeDrift({ tree: 'apps/app', path: 'x.ts', kind }),
            new RegExp(`\\(${kind}\\)`),
            kind
        );
});

// Revue Fable du 1b, A-1 : la jambe « détenteur » d'`assertGenerationLockFree`.
// L'opération qui TIENT le verrou du produit (création de l'appli B) et
// rencontre le journal INTERROMPU de l'appli A dit « interrupted … recover it
// first » ; jamais « another generation owns » avec son propre pid.
test('V5.2 : le détenteur du verrou qui trouve la transaction interrompue d’une autre appli la nomme interrompue', async (t) => {
    const product = await sessionApp(t, 'observatory');
    const other = { ...product.shell, appName: 'other' };
    const reviewed = await planExternalApplicationShell(other);
    await interruptAt(
        product,
        publication(product, { [product.notice]: 'export {};\n' })
    );
    assert.equal((await pendingTransactionJournals(product.root)).length, 1);
    const before = await snapshotTree(product.root, []);
    await assert.rejects(
        publishExternalApplicationShell(
            { ...other, expectedPlanId: reviewed.plan_id },
            { run: () => assert.fail('aucun contrôle natif') }
        ),
        (error) =>
            /interrupted application publication pending; recover it first/.test(
                error.message
            ) && !/another generation owns/.test(error.message)
    );
    assert.deepEqual(await snapshotTree(product.root, []), before);
});

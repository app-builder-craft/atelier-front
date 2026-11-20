import assert from 'node:assert/strict';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseArgs } from '../retire-app.mjs';
import {
    planApplicationRetirement,
    publishApplicationRetirement,
    recoverApplicationRetirement,
} from './core/application-retirement.mjs';
import {
    planApplicationShell,
    publishApplicationShell,
} from './core/application-shell-publication.mjs';
import { signaturePath } from './core/atelier-signature.mjs';
import {
    withProductPrefix,
    writeApplicationDesignFixture,
} from './test-support/application-design-fixture.mjs';

const applicationDesignSchema = JSON.parse(
    await readFile(
        new URL('./schemas/application-design.schema.json', import.meta.url),
        'utf8'
    )
);
const backendContractSchema = JSON.parse(
    await readFile(
        new URL('./schemas/backend-contract.schema.json', import.meta.url),
        'utf8'
    )
);

// Q3 du lot MARQUE : la pierre tombale vit sous le dossier de signature.
const TOMBSTONE = signaturePath('retired-apps', 'sample-app.json');

async function exists(path) {
    try {
        await access(path);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'application-retirement-'));
    await mkdir(join(root, 'apps'));
    await mkdir(join(root, 'designs'));
    const data = await writeApplicationDesignFixture(
        root,
        backendContractSchema
    );
    // Banc interne : la conception porte le préfixe du produit (1.2.0).
    await writeFile(
        join(root, 'designs/sample-app.application-design.json'),
        `${JSON.stringify(withProductPrefix(data.design), null, 2)}\n`
    );
    const shellOptions = {
        workspaceRoot: root,
        designPath: 'designs/sample-app.application-design.json',
        experienceId: 'citizen-web',
        appName: 'sample-app',
        profile: 'angular-pwa',
        applicationDesignSchema,
        backendContractSchema,
    };
    await publishApplicationShell(shellOptions, { run: () => '' });
    const dependencies = {
        findConsumers: () => [],
        findReferences: () => [],
        gitIdentity: () => ({ head: 'a'.repeat(40), branch: 'main' }),
        withLock: (_root, _app, operation) => operation(),
        assertStorage: () => undefined,
        install: () => undefined,
        postGate: () => undefined,
    };
    return { root, shellOptions, dependencies };
}

test('la CLI retire-app ferme dry-run/apply et reprise/abort', () => {
    assert.deepEqual(parseArgs(['--app', 'sample-app', '--dry-run']), {
        dryRun: true,
        resume: false,
        abort: false,
        appName: 'sample-app',
    });
    assert.deepEqual(parseArgs(['--app', 'sample-app', '--resume']), {
        dryRun: false,
        resume: true,
        abort: false,
        appName: 'sample-app',
    });
    assert.throws(
        () => parseArgs(['--app', 'sample-app', '--resume', '--abort']),
        /utilisé seul/
    );
});

test('retire une app possédée, publie le tombstone et prouve les gates', async () => {
    const data = await fixture();
    const plan = await planApplicationRetirement(
        { workspaceRoot: data.root, appName: 'sample-app' },
        data.dependencies
    );
    assert.equal(plan.tombstone, TOMBSTONE);
    const calls = [];
    const result = await publishApplicationRetirement(
        {
            workspaceRoot: data.root,
            appName: 'sample-app',
            planId: plan.plan_id,
        },
        {
            ...data.dependencies,
            install: () => calls.push('install+frozen'),
            postGate: () => calls.push('nx-post-gate'),
        }
    );
    assert.equal(result.plan.tree_sha256, plan.tree_sha256);
    assert.deepEqual(calls, ['install+frozen', 'nx-post-gate']);
    assert.equal(await exists(join(data.root, 'apps/sample-app')), false);
    assert.equal(
        JSON.parse(await readFile(join(data.root, TOMBSTONE), 'utf8')).kind,
        'retired-application'
    );
    await assert.rejects(
        () => planApplicationShell(data.shellOptions),
        /tombstone forbids implicit recreation/
    );
});

test('tout échec de gate restaure l’app et retire son tombstone', async () => {
    const data = await fixture();
    const plan = await planApplicationRetirement(
        { workspaceRoot: data.root, appName: 'sample-app' },
        data.dependencies
    );
    await assert.rejects(
        () =>
            publishApplicationRetirement(
                {
                    workspaceRoot: data.root,
                    appName: 'sample-app',
                    planId: plan.plan_id,
                },
                {
                    ...data.dependencies,
                    install: () => {
                        throw new Error('frozen lock failure');
                    },
                }
            ),
        /frozen lock failure/
    );
    assert.equal(
        await exists(join(data.root, 'apps/sample-app/project.json')),
        true
    );
    assert.equal(await exists(join(data.root, TOMBSTONE)), false);
});

test('refuse consommateurs Nx et références textuelles avant écriture', async () => {
    const data = await fixture();
    await assert.rejects(
        () =>
            planApplicationRetirement(
                { workspaceRoot: data.root, appName: 'sample-app' },
                {
                    ...data.dependencies,
                    findConsumers: () => [
                        {
                            consumer: 'portal',
                            target: 'sample-app',
                            type: 'static',
                        },
                    ],
                }
            ),
        /incoming Nx consumers/
    );
    await assert.rejects(
        () =>
            planApplicationRetirement(
                { workspaceRoot: data.root, appName: 'sample-app' },
                {
                    ...data.dependencies,
                    findReferences: () => ['transloco.config.ts'],
                }
            ),
        /external references/
    );
});

test('reprend une transaction interrompue après déplacement exact', async () => {
    const data = await fixture();
    const plan = await planApplicationRetirement(
        { workspaceRoot: data.root, appName: 'sample-app' },
        data.dependencies
    );
    const transaction = join(
        data.root,
        signaturePath('retire-app-transactions', 'sample-app')
    );
    const backup = join(transaction, 'app');
    const tombstonePath = join(data.root, TOMBSTONE);
    const tombstone = `${JSON.stringify(
        {
            schema_version: '1.0.0',
            kind: 'retired-application',
            app_name: 'sample-app',
            design_ref: plan.design_ref,
            retired_tree_sha256: plan.tree_sha256,
            git_head: plan.git_head,
        },
        null,
        2
    )}\n`;
    await mkdir(transaction, { recursive: true });
    await rename(join(data.root, 'apps/sample-app'), backup);
    await mkdir(join(data.root, signaturePath('retired-apps')), {
        recursive: true,
    });
    await writeFile(tombstonePath, tombstone);
    const tombstoneHash = await import('node:crypto').then(({ createHash }) =>
        createHash('sha256').update(tombstone).digest('hex')
    );
    await writeFile(
        join(transaction, 'state.json'),
        `${JSON.stringify(
            {
                schema_version: '1.0.0',
                phase: 'moved',
                plan_id: plan.plan_id,
                app_name: 'sample-app',
                output: 'apps/sample-app',
                tree_sha256: plan.tree_sha256,
                tombstone: TOMBSTONE,
                tombstone_parent_existed: false,
                tombstone_sha256: tombstoneHash,
            },
            null,
            2
        )}\n`
    );
    await recoverApplicationRetirement(
        {
            workspaceRoot: data.root,
            appName: 'sample-app',
            abort: false,
        },
        data.dependencies
    );
    assert.equal(await exists(transaction), false);
    assert.equal(await exists(join(data.root, 'apps/sample-app')), false);
});

// Produit fictif avec une coque Angular avec session, pour les publications
// extérieures sous plan (ADR-0103). Le runner injecté ne compile rien.
import assert from 'node:assert/strict';
import { cp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { transactionJournalRoot } from '../core/application-transaction.mjs';
import { pageModulePath } from '../core/external-publication-paths.mjs';
import { appManifestPath } from '../renderers/external-product-layout.mjs';
import {
    planExternalApplicationShell,
    publishExternalApplicationShell,
} from '../core/application-workspace.mjs';
import {
    planApplicationPublication,
    publishApplicationPublication,
} from '../core/application-publication.mjs';
import {
    installMetadataOnly,
    prepareFixture,
    TOOLS_ROOT,
} from './external-application-fixture.mjs';
import {
    INTERNAL_MODULE_SPECIFIER,
    sessionShellOptions,
    writeExternalSessionDesign,
} from './external-session-fixture.mjs';

// Lot 2 (V5.1) : une publication écrit dans le SOCLE de son appli ; chemins
// relatifs au produit. Fichier d'essai sous la zone des commandes, et module
// de page du socle de la page d'entrée (remplaçable, C-B3 ii).
export const noticePath = (appName) =>
    `libs/${appName}-socle/src/actions/x1-proof/notice.ts`;

export async function sessionApp(t, domain, edit) {
    const fixture = await prepareFixture(t);
    const input = await writeExternalSessionDesign(fixture.root, domain, edit);
    await installMetadataOnly(fixture.plan);
    const shell = sessionShellOptions(input);
    const plan = await planExternalApplicationShell(shell);
    await publishExternalApplicationShell(
        { ...shell, expectedPlanId: plan.plan_id },
        { run: () => undefined }
    );
    const app = join(fixture.root, 'apps', shell.appName);
    return {
        ...fixture,
        input,
        shell,
        app,
        manifestPath: appManifestPath(shell.appName),
        notice: noticePath(shell.appName),
        page: pageModulePath(shell.appName, input.entryPage.id),
        workspaceId: plan.workspace.manifest.workspace_id,
        base: {
            workspaceRoot: TOOLS_ROOT,
            targetRoot: fixture.root,
            appName: shell.appName,
        },
    };
}

export const readManifest = async (product) =>
    JSON.parse(
        await readFile(join(product.root, product.manifestPath), 'utf8')
    );

export function publication(product, files, tool = 'generate:action-request') {
    return { ...product.base, tool, files };
}

export async function publish(options, dependencies = {}) {
    const plan = await planApplicationPublication(options);
    const labels = [];
    const result = await publishApplicationPublication(
        { ...options, expectedPlanId: plan.plan_id },
        {
            run: (command, args, cwd) => {
                assert.equal(command, process.execPath);
                assert.equal(cwd, options.targetRoot);
                assert.ok(args[0].startsWith(options.targetRoot + '/'));
                labels.push(
                    args[0].endsWith('check-workspace.mjs')
                        ? 'workspace-contract'
                        : args[1] === 'run'
                          ? args[2]
                          : 'native-compiler'
                );
            },
            ...dependencies,
        }
    );
    return { plan, result, labels };
}

// Arrêt brutal à une phase (`published` par défaut : les deux racines
// échangées) : l'état COMPLET du produit et le journal sont copiés à cette
// phase, puis rendus après le retour arrière de l'échec simulé, comme si le
// processus avait été tué là.
export async function interruptAt(product, options, at = 'published') {
    const plan = await planApplicationPublication(options);
    const journal = transactionJournalRoot(
        product.root,
        'publication',
        plan.plan_id
    );
    const copies = {
        product: join(product.parent, 'interrupted-product'),
        journal: join(product.parent, 'interrupted-journal'),
    };
    await assert.rejects(
        publishApplicationPublication(
            { ...options, expectedPlanId: plan.plan_id },
            {
                run: () => undefined,
                phase: async (name) => {
                    if (name !== at) return;
                    await cp(product.root, copies.product, {
                        recursive: true,
                        verbatimSymlinks: true,
                    });
                    await cp(journal, copies.journal, { recursive: true });
                    throw new Error('stop');
                },
            }
        ),
        /stop/
    );
    await rm(product.root, { recursive: true });
    await rename(copies.product, product.root);
    await rename(copies.journal, journal);
    // Les verrous copiés appartiennent au processus vivant ; dans un arrêt
    // réel, ils sont morts et repris par le verrou lui-même (prouvé par
    // l'arrêt SIGKILL de create-app).
    for (const space of ['apps', 'libs'])
        for (const name of await readdir(join(product.root, space)))
            if (/\.generation-lock/.test(name))
                await rm(join(product.root, space, name), { recursive: true });
    return plan;
}
export const interruptAfterSwap = (product, options) =>
    interruptAt(product, options, 'published');

// T11 : la sortie n'importe que les paquets installés du produit et ses propres
// fichiers possédés ; aucun module ni chemin de l'atelier.
export function assertProductOnlyImports(files, owned) {
    for (const [path, content] of Object.entries(files)) {
        assert.doesNotMatch(content, INTERNAL_MODULE_SPECIFIER, path);
        assert.equal(content.includes(TOOLS_ROOT), false, path);
        assert.doesNotMatch(content, /\/Users\/|\/private\/|https?:\/\//, path);
        if (!path.endsWith('.ts')) continue;
        for (const [, specifier] of content.matchAll(
            /(?:from|import)\s*\(?\s*'([^']+)'/g
        )) {
            if (!specifier.startsWith('.')) {
                // Une spec publiée est lancée par le vitest installé du
                // produit, comme les specs de la coque.
                if (path.endsWith('.spec.ts') && specifier === 'vitest')
                    continue;
                assert.match(
                    specifier,
                    /^(?:@angular\/[a-z-]+(?:\/[a-z-]+)?|rxjs)$/,
                    path
                );
                continue;
            }
            const target = posix.join(posix.dirname(path), specifier);
            assert.ok(
                owned.has(`${target}.ts`) || owned.has(`${target}/index.ts`),
                `${path} importe ${specifier} hors de l’application`
            );
        }
    }
}

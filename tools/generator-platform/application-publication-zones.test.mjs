// Lot 2 (conception v5, V5.1 règle 1, C-B3, V5.4) : zones de publication
// d'une appli extérieure, éprouvées sur l'inventaire scellé lui-même (gardes
// de comportement de `application-ownership.mjs`, rejouées à chaque
// vérification). Chemins relatifs au produit.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    inventoryTreeSha,
    publishedManifest,
    sealShellManifest,
    verifyApplicationOwnership,
} from './core/application-ownership.mjs';
import { SIGNATURE_FILES } from './core/atelier-signature.mjs';
import { pageModulePath } from './core/external-publication-paths.mjs';
import { sha256 } from './core/generation-manifest.mjs';
import { EMPTY_PAGE_MODULE } from './core/socle-names.mjs';

const WORKSPACE = 'a'.repeat(64);
const APP = 'zone-app';
const PAGE = 'page_0123456789abcdef';
const CONTRACT = `apps/${APP}/${SIGNATURE_FILES.pages}/${PAGE}.json`;
const MODULE = pageModulePath(APP, PAGE);
const SHELL = {
    [CONTRACT]: '{}\n',
    [MODULE]: EMPTY_PAGE_MODULE,
    [`apps/${APP}/project.json`]: '{}\n',
    [`libs/${APP}-socle/src/index.ts`]: 'export {};\n',
    [`libs/${APP}-socle/project.json`]: '{}\n',
    [`libs/${APP}-interface/src/index.ts`]: 'export const pages = {};\n',
};

const artifact = (path, content) => ({
    path,
    bytes: Buffer.byteLength(content),
    sha256: sha256(content),
});

// Coque scellée d'une appli fictive, telle que `create-app` la rend.
function shellManifest() {
    const generated = Object.entries(SHELL)
        .map(([path, content]) => artifact(path, content))
        .sort((left, right) => left.path.localeCompare(right.path));
    return sealShellManifest(
        {
            schema_version: '1.0.0',
            kind: 'application-shell-manifest',
            app_name: APP,
            profile: 'angular-pwa',
            design_ref: {
                path: 'descriptions/design.json',
                sha256: 'b'.repeat(64),
            },
            experience_id: 'visitor',
            generated_files: generated,
            tree_sha256: inventoryTreeSha(generated),
        },
        WORKSPACE
    );
}

let plans = 0;
// Enregistrement d'une publication : `files` = { chemin: [avant, après] },
// `avant` absent pour un ajout.
function publish(manifest, tool, files) {
    plans += 1;
    const record = {
        plan_id: plans.toString(16).padStart(64, '0'),
        tool,
        files: Object.entries(files)
            .map(([path, [before, after]]) => ({
                path,
                change: before === undefined ? 'added' : 'replaced',
                sha256: sha256(after),
                bytes: Buffer.byteLength(after),
                ...(before === undefined
                    ? {}
                    : {
                          before: {
                              sha256: sha256(before),
                              bytes: Buffer.byteLength(before),
                          },
                      }),
            }))
            .sort((left, right) => (left.path < right.path ? -1 : 1)),
    };
    return publishedManifest(manifest, record, WORKSPACE);
}

test('C-B3 : le module de page du socle est remplacé, puis REMPLACÉ DE NOUVEAU (dernier écrivain), jamais refusé', () => {
    const first = 'export const PAGE = 1;\n';
    const second = 'export const PAGE = 2;\n';
    let manifest = publish(shellManifest(), 'generate:page-composition', {
        [MODULE]: [EMPTY_PAGE_MODULE, first],
    });
    // Le cas du bloquant B-3 : un fichier REMPLACÉ (jamais ajouté), dont le
    // contenu n'est plus le module vide, est remplacé de nouveau.
    manifest = publish(manifest, 'generate:page-composition', {
        [MODULE]: [first, second],
    });
    const { writers } = verifyApplicationOwnership(manifest, WORKSPACE);
    assert.equal(writers.get(MODULE), 'generate:page-composition');
    assert.equal(
        manifest.ownership.publications.at(-1).files[0].before.sha256,
        sha256(first)
    );
});

test('C-B3 (i) : un fichier ajouté par une publication est remplacé par une publication ; la zone se lit au dernier écrivain', () => {
    const path = `libs/${APP}-socle/src/actions/zone-action/src/index.ts`;
    let manifest = publish(shellManifest(), 'generate:action-request', {
        [path]: [undefined, 'export const A = 1;\n'],
    });
    manifest = publish(manifest, 'generate:action-request', {
        [path]: ['export const A = 1;\n', 'export const A = 2;\n'],
    });
    assert.equal(
        verifyApplicationOwnership(manifest, WORKSPACE).writers.get(path),
        'generate:action-request'
    );
});

test('V5.1 règle 1 : coque, configuration et entrées des bibliothèques, page non déclarée et interface : hors zone', () => {
    const refused = [
        // Fichiers de la coque ou du socle écrits par elle, hors du module de
        // page : jamais remplaçables par une publication.
        [`apps/${APP}/project.json`, '{}\n'],
        [`libs/${APP}-socle/src/index.ts`, 'export {};\n'],
        [`libs/${APP}-socle/project.json`, '{}\n'],
        [`libs/${APP}-interface/src/index.ts`, 'export const pages = {};\n'],
    ];
    for (const [path, before] of refused)
        assert.throws(
            () =>
                publish(shellManifest(), 'generate:page-composition', {
                    [path]: [before, 'export const X = 1;\n'],
                }),
            /publication outside declared zones/,
            path
        );
    for (const path of [
        // Page non déclarée : aucun contrat de page dans l'inventaire.
        pageModulePath(APP, 'page_fedcba9876543210'),
        `libs/${APP}-interface/src/pages/${PAGE}/page.component.ts`,
        `libs/${APP}-socle/src/session/extra.ts`,
        `libs/autre-socle/src/actions/x/src/index.ts`,
        `apps/${APP}/src/app/generated/x.ts`,
    ])
        assert.throws(
            () =>
                publish(shellManifest(), 'generate:action-request', {
                    [path]: [undefined, 'export {};\n'],
                }),
            /publication outside declared zones/,
            path
        );
});

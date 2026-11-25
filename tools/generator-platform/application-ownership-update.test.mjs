// Lot 2, commit 6c (cadrage § 20 ; conception v2 R2.1.3 à R2.1.5, v3 V3.5 d,
// v5 C-B3) : enregistrement `update-app` dans le sceau d'une appli
// extérieure. Oracles écrits ici :
// - zone par DERNIER ÉCRIVAIN : coque, renommage, mise à jour ; jamais un
//   fichier écrit en dernier par une publication, jamais la zone libre de
//   l'interface ;
// - chaîne des sources : chaque mise à jour part de la liaison d'arrivée de
//   la précédente, la dernière arrive à la liaison du manifeste ;
// - version du sceau dérivée : 1.2.0 dès qu'une mise à jour est présente,
//   avec ou sans renommage (P5 bis) ;
// - N7 : enregistrements forgés puis rescellés, chacun refusé, nommé.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
    computeOwnershipSeal,
    inventoryTreeSha,
    lastWriters,
    OWNERSHIP_SCHEMA_VERSION,
    OWNERSHIP_UPDATED_SCHEMA_VERSION,
    publishedManifest,
    RENAME_TOOL,
    renamedManifest,
    sealShellManifest,
    UPDATE_TOOL,
    updatedManifest,
    verifyApplicationOwnership,
} from './core/application-ownership.mjs';
import { SIGNATURE_FILES } from './core/atelier-signature.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const digest = (text) => ({
    sha256: sha(text),
    bytes: Buffer.byteLength(text),
});
const ID = { p: 'a'.repeat(64), q: 'b'.repeat(64) };
const PAGE = 'page_1111111111111111';
// Oracle des chemins, écrit ici (appli `essai`).
const MAIN = 'apps/essai/src/main.ts';
const CONTRACT = `apps/essai/${SIGNATURE_FILES.pages}/${PAGE}.json`;
const SOCLE_INDEX = 'libs/essai-socle/src/index.ts';
const SOCLE_OLD = 'libs/essai-socle/src/client/ancien.ts';
const SOCLE_NEW = 'libs/essai-socle/src/client/nouveau.ts';
const MODULE = `libs/essai-socle/src/pages/${PAGE}/composition/src/index.ts`;
const MODEL = 'libs/essai-socle/src/actions/enter/execution-model.json';
const INTERFACE_INDEX = 'libs/essai-interface/src/index.ts';
const INTERFACE_PROJECT = 'libs/essai-interface/project.json';
const DESIGN = 'descriptions/essai/application-design.json';
const CONTRACT_SOURCE = 'descriptions/essai/backend.contract.json';

// Liaison des sources d'une version `n` : conception et contrat.
// Triée par chemin, comme au manifeste.
const sources = (n) => [
    { genre: 'design', path: DESIGN, ...digest(`conception ${n}\n`) },
    { genre: 'contract', path: CONTRACT_SOURCE, ...digest(`contrat ${n}\n`) },
];
// Champs de la coque, hors inventaire et sceau, pour la liaison `n`.
const fields = (n) => ({
    schema_version: '1.0.0',
    app_name: 'essai',
    design_ref: { path: DESIGN, sha256: sha(`conception ${n}\n`) },
    sources: sources(n),
});

// Coque fictive scellée sur la liaison 0, puis une commande publiée.
function product() {
    const files = {
        [MAIN]: 'export const main = 0;\n',
        [CONTRACT]: '{}\n',
        [SOCLE_INDEX]: 'export {};\n',
        [SOCLE_OLD]: 'export const ancien = 0;\n',
        [MODULE]: 'export {};\n',
        [INTERFACE_INDEX]: 'export const pages = {};\n',
        [INTERFACE_PROJECT]: '{ "name": "essai-interface" }\n',
    };
    const generated = Object.entries(files)
        .map(([path, content]) => ({ path, ...digest(content) }))
        .sort((left, right) => left.path.localeCompare(right.path));
    const shell = sealShellManifest(
        {
            ...fields(0),
            generated_files: generated,
            tree_sha256: inventoryTreeSha(generated),
        },
        ID.p
    );
    return publishedManifest(
        shell,
        {
            plan_id: 'd'.repeat(64),
            tool: 'generate:action-request',
            files: [added(MODEL, '{"commande":1}\n')],
        },
        ID.p
    );
}

const added = (path, content) => ({
    path,
    change: 'added',
    ...digest(content),
});
const replaced = (path, before, content) => ({
    path,
    change: 'replaced',
    ...digest(content),
    before: digest(before),
});
const removed = (path, before) => ({
    path,
    change: 'removed',
    before: digest(before),
});
// Fichiers triés par chemin, comme au manifeste.
const record = (plan, before, after, files) => ({
    plan_id: plan.repeat(64),
    tool: UPDATE_TOOL,
    sources_before: sources(before),
    sources_after: sources(after),
    files: [...files].sort((left, right) => (left.path < right.path ? -1 : 1)),
});
// Mise à jour 0 → 1 : coque remplacée, socle ajouté et retiré, configuration
// de l'interface remplacée.
const FIRST = record('1', 0, 1, [
    replaced(INTERFACE_PROJECT, '{ "name": "essai-interface" }\n', '{}\n'),
    replaced(MAIN, 'export const main = 0;\n', 'export const main = 1;\n'),
    removed(SOCLE_OLD, 'export const ancien = 0;\n'),
    added(SOCLE_NEW, 'export const nouveau = 1;\n'),
]);

// Manifeste FORGÉ : l'enregistrement appliqué sans contrôle, puis rescellé.
function forge(manifest, entry, next = fields(1), version) {
    const inventory = new Map(
        manifest.generated_files.map((file) => [file.path, file])
    );
    for (const file of entry.files)
        if (file.change === 'removed') inventory.delete(file.path);
        else
            inventory.set(file.path, {
                path: file.path,
                sha256: file.sha256,
                bytes: file.bytes,
            });
    const generated = [...inventory.values()].sort((left, right) =>
        left.path.localeCompare(right.path)
    );
    const forged = {
        ...next,
        generated_files: generated,
        tree_sha256: inventoryTreeSha(generated),
        ownership: {
            ...manifest.ownership,
            // Liaison de création, posée comme l'écrivain la pose.
            shell_sources: manifest.ownership.shell_sources ?? manifest.sources,
            schema_version: version ?? OWNERSHIP_UPDATED_SCHEMA_VERSION,
            publications: [...manifest.ownership.publications, entry],
        },
    };
    forged.ownership.seal_sha256 = computeOwnershipSeal(forged);
    return forged;
}
// Sceau retouché puis rescellé.
function resealed(manifest, edit) {
    const next = structuredClone(manifest);
    edit(next.ownership);
    next.ownership.seal_sha256 = computeOwnershipSeal(next);
    return next;
}

test('update-app : enregistrement admis, version 1.2.0, derniers écrivains, chaîne de deux mises à jour', () => {
    const before = product();
    assert.equal(before.ownership.schema_version, OWNERSHIP_SCHEMA_VERSION);
    const first = updatedManifest(before, FIRST, ID.p, fields(1));
    assert.equal(
        first.ownership.schema_version,
        OWNERSHIP_UPDATED_SCHEMA_VERSION
    );
    assert.deepEqual(first.sources, sources(1));
    // La première mise à jour pose la liaison de création.
    assert.deepEqual(first.ownership.shell_sources, sources(0));
    assert.equal(Object.hasOwn(before.ownership, 'shell_sources'), false);
    const writers = lastWriters(first, ID.p);
    assert.equal(writers.get(MAIN), UPDATE_TOOL);
    assert.equal(writers.get(SOCLE_NEW), UPDATE_TOOL);
    assert.equal(writers.get(INTERFACE_PROJECT), UPDATE_TOOL);
    assert.equal(writers.get(MODEL), 'generate:action-request');
    assert.equal(writers.has(SOCLE_OLD), false);
    // Seconde mise à jour, liaison seule (aucun fichier) : admise ; elle
    // part de la liaison d'arrivée de la première.
    const second = updatedManifest(
        first,
        record('2', 1, 2, []),
        ID.p,
        fields(2)
    );
    verifyApplicationOwnership(second, ID.p);
    assert.equal(second.ownership.publications.length, 3);
    // La liaison de création n'est jamais réécrite.
    assert.deepEqual(second.ownership.shell_sources, sources(0));
});

test('update-app : zone par dernier écrivain ; publication, zone libre et hors racines refusées', () => {
    const before = product();
    const composed = publishedManifest(
        before,
        {
            plan_id: 'e'.repeat(64),
            tool: 'generate:page-composition',
            files: [
                replaced(MODULE, 'export {};\n', 'export const page = 1;\n'),
            ],
        },
        ID.p
    );
    for (const [label, manifest, file] of [
        [
            'fichier écrit par une publication remplacé',
            before,
            replaced(MODEL, '{"commande":1}\n', '{"commande":2}\n'),
        ],
        [
            'fichier écrit par une publication retiré',
            before,
            removed(MODEL, '{"commande":1}\n'),
        ],
        [
            'module de page composé (C-B3, page conservée) remplacé',
            composed,
            replaced(MODULE, 'export const page = 1;\n', 'export {};\n'),
        ],
        [
            'ajout dans la zone libre de l’interface',
            before,
            added('libs/essai-interface/src/pages/libre.ts', 'x\n'),
        ],
        [
            'ajout hors des racines de l’appli',
            before,
            added('apps/autre/x.ts', 'x\n'),
        ],
    ])
        assert.throws(
            () =>
                updatedManifest(
                    manifest,
                    record('1', 0, 1, [file]),
                    ID.p,
                    fields(1)
                ),
            /^Error: external application: update record outside its zone$/,
            label
        );
});

test('N7 : enregistrements forgés puis rescellés, chacun refusé', () => {
    const before = product();
    const first = updatedManifest(before, FIRST, ID.p, fields(1));
    for (const [label, forged, message] of [
        [
            'zone : remplacement d’un fichier écrit par une publication',
            forge(
                before,
                record('1', 0, 1, [
                    replaced(MODEL, '{"commande":1}\n', '{"commande":2}\n'),
                ])
            ),
            /update record outside its zone/,
        ],
        [
            // Relecture de l'étape B : la première est comparée elle aussi.
            'chaîne : la première ne part pas de la liaison de création',
            forge(before, record('1', 2, 1, FIRST.files)),
            /update record breaks the sources chain/,
        ],
        [
            'liaison de création absente après une mise à jour',
            resealed(first, (ownership) => {
                delete ownership.shell_sources;
            }),
            /app ownership seal is invalid/,
        ],
        [
            'liaison de création sans mise à jour',
            resealed(before, (ownership) => {
                ownership.shell_sources = sources(0);
            }),
            /app ownership seal is invalid/,
        ],
        [
            'chaîne : la seconde ne part pas de l’arrivée de la première',
            forge(first, record('2', 0, 2, []), fields(2)),
            /update record breaks the sources chain/,
        ],
        [
            'chaîne : la dernière n’arrive pas à la liaison du manifeste',
            forge(before, FIRST, fields(2)),
            /update record breaks the sources chain/,
        ],
        [
            'version 1.2.0 sans mise à jour',
            (() => {
                const manifest = structuredClone(before);
                manifest.ownership.schema_version =
                    OWNERSHIP_UPDATED_SCHEMA_VERSION;
                manifest.ownership.seal_sha256 = computeOwnershipSeal(manifest);
                return manifest;
            })(),
            /app ownership seal is invalid/,
        ],
        [
            'mise à jour en version 1.0.0',
            forge(before, FIRST, fields(1), OWNERSHIP_SCHEMA_VERSION),
            /app ownership seal is invalid/,
        ],
        [
            'mise à jour sans aucun changement',
            forge(before, record('1', 0, 0, []), fields(0)),
            /update record is invalid/,
        ],
        [
            'fichiers non triés',
            forge(before, {
                ...FIRST,
                files: [...FIRST.files].reverse(),
            }),
            /update record is invalid/,
        ],
    ])
        assert.throws(
            () => verifyApplicationOwnership(forged, ID.p),
            message,
            label
        );
});

test('P5 bis : mise à jour puis renommage, renommage puis mise à jour : version 1.2.0, sceau vérifié', () => {
    const rename = (manifest, plan, before, after, from, to) =>
        renamedManifest(
            manifest,
            {
                plan_id: plan.repeat(64),
                tool: RENAME_TOOL,
                prefix_before: from,
                prefix_after: to,
                workspace_id_before: ID.p,
                files: [replaced(MAIN, before, after)],
            },
            ID.q
        );
    // Mise à jour, puis renommage d'un fichier écrit en dernier par elle.
    const updated = updatedManifest(product(), FIRST, ID.p, fields(1));
    const renamed = rename(
        updated,
        '3',
        'export const main = 1;\n',
        'export const main = 2;\n',
        'ns',
        'nq'
    );
    assert.equal(
        renamed.ownership.schema_version,
        OWNERSHIP_UPDATED_SCHEMA_VERSION
    );
    verifyApplicationOwnership(renamed, ID.q);
    assert.equal(lastWriters(renamed, ID.q).get(MAIN), RENAME_TOOL);
    // Renommage, puis mise à jour d'un fichier écrit en dernier par lui.
    const first = rename(
        product(),
        '4',
        'export const main = 0;\n',
        'export const main = 2;\n',
        'ns',
        'nq'
    );
    const next = updatedManifest(
        first,
        record('5', 0, 1, [
            replaced(
                MAIN,
                'export const main = 2;\n',
                'export const main = 3;\n'
            ),
        ]),
        ID.q,
        fields(1)
    );
    assert.equal(
        next.ownership.schema_version,
        OWNERSHIP_UPDATED_SCHEMA_VERSION
    );
    assert.equal(lastWriters(next, ID.q).get(MAIN), UPDATE_TOOL);
});

// Lot MARQUE, commit 3 : enregistrement de renommage du préfixe dans le sceau
// d'une appli extérieure (ADR-0103, voie R2). Zone fermée par le dernier
// écrivain, paire de scripts d'entrée nginx, genre `removed`, rejeu inverse
// jusqu'à la coque d'origine, version du sceau. Lot 2 : chemins relatifs au
// produit ; la zone d'un renommage est la COQUE seule (V5.3 : le socle et
// l'interface ne portent aucune forme du préfixe).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
    computeOwnershipSeal,
    inventoryTreeSha,
    lastWriters,
    OWNERSHIP_RENAMED_SCHEMA_VERSION,
    OWNERSHIP_SCHEMA_VERSION,
    publishedManifest,
    RENAME_TOOL,
    renamedManifest,
    sealShellManifest,
    verifyApplicationOwnership,
} from './core/application-ownership.mjs';
import { SIGNATURE_FILES } from './core/atelier-signature.mjs';
import { relayEnvshPath } from './core/external-application-paths.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const digest = (text) => ({
    sha256: sha(text),
    bytes: Buffer.byteLength(text),
});
const ID = { p: 'a'.repeat(64), q: 'b'.repeat(64), r: 'c'.repeat(64) };
const PAGE = 'page_1111111111111111';
// Oracle des chemins, écrit ici (appli `essai`).
const MAIN = 'apps/essai/src/main.ts';
const ENVSH = (prefix) => `apps/essai/${relayEnvshPath(prefix)}`;
const CONTRACT = `apps/essai/${SIGNATURE_FILES.pages}/${PAGE}.json`;
const SOCLE_INDEX = 'libs/essai-socle/src/index.ts';
const INTERFACE_INDEX = 'libs/essai-interface/src/index.ts';
const MODULE = `libs/essai-socle/src/pages/${PAGE}/composition/src/index.ts`;
const SPEC = `libs/essai-socle/src/pages/${PAGE}/composition/src/page-composition.spec.ts`;
const MODEL = 'libs/essai-socle/src/actions/enter/execution-model.json';

// Coque fictive en `p` : un fichier de coque, le script d'entrée nginx de
// `p`, le contrat de page qui déclare la page ; l'entrée du socle et son module
// de page vide, l'entrée de l'interface, écrits par la coque.
function shell(prefix = 'ns') {
    const files = {
        [MAIN]: `policy ${prefix}-sw\n`,
        [ENVSH(prefix)]:
            `export ${prefix.toUpperCase()}_UPSTREAMS_VALIDATED=1\n`,
        [CONTRACT]: '{}\n',
        [SOCLE_INDEX]: 'export {};\n',
        [MODULE]: 'export {};\n',
        [INTERFACE_INDEX]: 'export const pages = {};\n',
    };
    const generated = Object.entries(files)
        .map(([path, content]) => ({ path, ...digest(content) }))
        .sort((left, right) => left.path.localeCompare(right.path));
    const manifest = sealShellManifest(
        {
            schema_version: '1.0.0',
            app_name: 'essai',
            generated_files: generated,
            tree_sha256: inventoryTreeSha(generated),
        },
        ID.p
    );
    return { manifest, files };
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
const sorted = (files) =>
    [...files].sort((left, right) => (left.path < right.path ? -1 : 1));

// Coque, puis une commande (modèle) et une composition (spec).
function published() {
    const { manifest, files } = shell();
    let next = publishedManifest(
        manifest,
        {
            plan_id: 'd'.repeat(64),
            tool: 'generate:action-request',
            files: [added(MODEL, '{"p":"ns"}\n')],
        },
        ID.p
    );
    next = publishedManifest(
        next,
        {
            plan_id: 'e'.repeat(64),
            tool: 'generate:page-composition',
            files: [added(SPEC, 'utilisateur@exemple.test\n')],
        },
        ID.p
    );
    return {
        manifest: next,
        files: {
            ...files,
            [MODEL]: '{"p":"ns"}\n',
            [SPEC]: 'utilisateur@exemple.test\n',
        },
    };
}

const renameRecord = (
    files,
    from,
    to,
    before = ID.p,
    planId = 'f'.repeat(64)
) => ({
    plan_id: planId,
    tool: RENAME_TOOL,
    prefix_before: from,
    prefix_after: to,
    workspace_id_before: before,
    files: sorted(files),
});

function renameFiles(files, from, to) {
    return [
        replaced(MAIN, files[MAIN], `policy ${to}-sw\n`),
        removed(ENVSH(from), files[ENVSH(from)]),
        added(ENVSH(to), `export ${to.toUpperCase()}_UPSTREAMS_VALIDATED=1\n`),
    ];
}

test('renommage : enregistrement accepté, identité rattachée, version 1.1.0, rejeu inverse jusqu’à la coque en p', () => {
    const { manifest, files } = published();
    assert.equal(manifest.ownership.schema_version, OWNERSHIP_SCHEMA_VERSION);
    const record = renameRecord(renameFiles(files, 'ns', 'qz'), 'ns', 'qz');
    const next = renamedManifest(manifest, record, ID.q);
    assert.equal(
        next.ownership.schema_version,
        OWNERSHIP_RENAMED_SCHEMA_VERSION
    );
    assert.equal(next.ownership.workspace_id, ID.q);
    assert.equal(
        next.ownership.shell_tree_sha256,
        manifest.ownership.shell_tree_sha256
    );
    const paths = next.generated_files.map(({ path }) => path);
    assert.ok(paths.includes(ENVSH('qz')));
    assert.ok(!paths.includes(ENVSH('ns')));
    verifyApplicationOwnership(next, ID.q);
    assert.throws(
        () => verifyApplicationOwnership(next, ID.p),
        /bound to another workspace/
    );
    // Dernier écrivain : le renommage, pour les fichiers qu'il a écrits.
    const writers = lastWriters(next, ID.q);
    assert.equal(writers.get(MAIN), RENAME_TOOL);
    // V5.3 : la composition n'est plus re-rendue par le renommage.
    assert.equal(writers.get(SPEC), 'generate:page-composition');
    assert.equal(writers.get(MODEL), 'generate:action-request');
    assert.equal(writers.get(MODULE), 'shell');
    assert.equal(writers.get(SOCLE_INDEX), 'shell');
});

test('renommage : version du sceau liée à la présence d’un renommage', () => {
    const { manifest, files } = published();
    const next = renamedManifest(
        manifest,
        renameRecord(renameFiles(files, 'ns', 'qz'), 'ns', 'qz'),
        ID.q
    );
    // Chaque version forgée est RESCELLÉE : seule la règle de version peut
    // la refuser, pas l'empreinte du sceau.
    const forged = structuredClone(next);
    forged.ownership.schema_version = OWNERSHIP_SCHEMA_VERSION;
    forged.ownership.seal_sha256 = computeOwnershipSeal(forged);
    assert.throws(
        () => verifyApplicationOwnership(forged, ID.q),
        /seal is invalid/
    );
    const lifted = structuredClone(manifest);
    lifted.ownership.schema_version = OWNERSHIP_RENAMED_SCHEMA_VERSION;
    lifted.ownership.seal_sha256 = computeOwnershipSeal(lifted);
    assert.throws(
        () => verifyApplicationOwnership(lifted, ID.p),
        /seal is invalid/
    );
});

test('renommage forgé : dernier écrivain hors zone, fichier de page, paire de scripts violée, préfixes', () => {
    const { manifest, files } = published();
    const cases = [
        [
            'modèle écrit par une commande',
            [replaced(MODEL, files[MODEL], '{"p":"qz"}\n')],
            /outside its zone/,
        ],
        // V5.3 : socle et interface hors zone, même écrits par la coque.
        [
            'spec de composition',
            [replaced(SPEC, files[SPEC], 'qz@exemple.test\n')],
            /outside its zone/,
        ],
        [
            'entrée du socle écrite par la coque',
            [
                replaced(
                    SOCLE_INDEX,
                    files[SOCLE_INDEX],
                    'export const X = 1;\n'
                ),
            ],
            /outside its zone/,
        ],
        [
            'module de page vide',
            [replaced(MODULE, files[MODULE], 'export const X = 1;\n')],
            /outside its zone/,
        ],
        [
            'entrée de l’interface',
            [
                replaced(
                    INTERFACE_INDEX,
                    files[INTERFACE_INDEX],
                    'export const pages = { x: 1 };\n'
                ),
            ],
            /outside its zone/,
        ],
        [
            'dossier de signature de la coque',
            [replaced(CONTRACT, files[CONTRACT], '[]\n')],
            /outside its zone/,
        ],
        [
            'deux removed',
            [
                removed(ENVSH('ns'), files[ENVSH('ns')]),
                removed(MAIN, files[MAIN]),
            ],
            /outside its zone/,
        ],
        [
            'removed hors de la paire',
            [removed(MAIN, files[MAIN]), added(ENVSH('qz'), 'x\n')],
            /outside its zone/,
        ],
        [
            'removed sans added',
            [removed(ENVSH('ns'), files[ENVSH('ns')])],
            /outside its zone/,
        ],
        [
            'added hors de la paire',
            [
                removed(ENVSH('ns'), files[ENVSH('ns')]),
                added('apps/essai/src/app/autre.ts', 'x\n'),
            ],
            /outside its zone/,
        ],
    ];
    for (const [label, recordFiles, refusal] of cases)
        assert.throws(
            () =>
                renamedManifest(
                    manifest,
                    renameRecord(recordFiles, 'ns', 'qz'),
                    ID.q
                ),
            refusal,
            label
        );
    for (const [from, to] of [
        ['ns', 'ns'],
        ['ns', 'Q'],
        ['N', 'qz'],
    ])
        assert.throws(
            () =>
                renamedManifest(
                    manifest,
                    renameRecord(
                        [replaced(MAIN, files[MAIN], 'x\n')],
                        from,
                        to
                    ),
                    ID.q
                ),
            /rename record is invalid/,
            `${from} → ${to}`
        );
});

// Enregistrement de renommage posé à la main dans l'historique, inventaire et
// sceau recalculés : seule la zone structurelle peut le refuser (D.4).
function forged(manifest, record) {
    const next = structuredClone(manifest);
    const inventory = new Map(
        next.generated_files.map((entry) => [entry.path, entry])
    );
    for (const file of record.files)
        if (file.change === 'removed') inventory.delete(file.path);
        else
            inventory.set(file.path, {
                path: file.path,
                sha256: file.sha256,
                bytes: file.bytes,
            });
    next.generated_files = [...inventory.values()].sort((left, right) =>
        left.path.localeCompare(right.path)
    );
    next.tree_sha256 = inventoryTreeSha(next.generated_files);
    next.ownership.schema_version = OWNERSHIP_RENAMED_SCHEMA_VERSION;
    next.ownership.publications.push(record);
    next.ownership.seal_sha256 = computeOwnershipSeal(next);
    return next;
}

const QUERY = 'libs/essai-socle/src/queries/catalogue/execution-model.json';
const PLAN = `libs/essai-socle/src/pages/${PAGE}/plan/page-execution-plan.json`;

test('D.4 : enregistrement forgé et rescellé, refusé par la zone structurelle', () => {
    let { manifest, files } = published();
    // Derniers écrivains de chaque genre : lecture, plan.
    for (const [tool, change] of [
        ['generate:list-query', added(QUERY, '{"q":1}\n')],
        ['compile:page-execution-plan', added(PLAN, '{"plan":1}\n')],
    ])
        manifest = publishedManifest(
            manifest,
            { plan_id: '6'.repeat(64), tool, files: [change] },
            ID.p
        );
    files = {
        ...files,
        [QUERY]: '{"q":1}\n',
        [PLAN]: '{"plan":1}\n',
    };
    const cases = [
        ['commande', [replaced(MODEL, files[MODEL], '{"p":"qz"}\n')]],
        ['lecture', [replaced(QUERY, files[QUERY], '{"q":2}\n')]],
        ['plan', [replaced(PLAN, files[PLAN], '{"plan":2}\n')]],
        ['dossier de signature', [replaced(CONTRACT, files[CONTRACT], '[]\n')]],
        [
            'entrée du socle',
            [
                replaced(
                    SOCLE_INDEX,
                    files[SOCLE_INDEX],
                    'export const X = 1;\n'
                ),
            ],
        ],
        [
            'deux removed',
            [
                removed(ENVSH('ns'), files[ENVSH('ns')]),
                removed(MAIN, files[MAIN]),
            ],
        ],
        [
            'removed hors de la paire',
            [removed(MAIN, files[MAIN]), added(ENVSH('qz'), 'x\n')],
        ],
        ['removed sans added', [removed(ENVSH('ns'), files[ENVSH('ns')])]],
    ];
    for (const [label, recordFiles] of cases)
        assert.throws(
            () =>
                verifyApplicationOwnership(
                    forged(manifest, renameRecord(recordFiles, 'ns', 'qz')),
                    ID.p
                ),
            /rename record outside its zone/,
            label
        );
    // Le même enregistrement dans la zone passe : le refus vient bien de la
    // zone, pas de la forge.
    verifyApplicationOwnership(
        forged(
            manifest,
            renameRecord(
                [replaced(MAIN, files[MAIN], 'policy qz-sw\n')],
                'ns',
                'qz'
            )
        ),
        ID.p
    );
});

test('chaîne des préfixes : un renommage part du préfixe auquel le précédent est arrivé', () => {
    const { manifest, files } = published();
    const first = renamedManifest(
        manifest,
        renameRecord(renameFiles(files, 'ns', 'qz'), 'ns', 'qz'),
        ID.q
    );
    const afterQ = {
        ...files,
        [MAIN]: 'policy qz-sw\n',
    };
    assert.throws(
        () =>
            renamedManifest(
                first,
                renameRecord(
                    [replaced(MAIN, afterQ[MAIN], 'policy tt-sw\n')],
                    'rr',
                    'tt',
                    ID.q,
                    '9'.repeat(64)
                ),
                ID.r
            ),
        /rename record breaks the prefix chain/
    );
});

test('renommer deux fois : le script ajouté par le premier est retiré par le second ; rejeu inverse à travers les deux', () => {
    const { manifest, files } = published();
    const first = renamedManifest(
        manifest,
        renameRecord(renameFiles(files, 'ns', 'qz'), 'ns', 'qz'),
        ID.q
    );
    const afterQ = {
        ...files,
        [MAIN]: 'policy qz-sw\n',
        [ENVSH('qz')]: 'export QZ_UPSTREAMS_VALIDATED=1\n',
    };
    delete afterQ[ENVSH('ns')];
    const second = renamedManifest(
        first,
        renameRecord(
            renameFiles(afterQ, 'qz', 'rr'),
            'qz',
            'rr',
            ID.q,
            '9'.repeat(64)
        ),
        ID.r
    );
    verifyApplicationOwnership(second, ID.r);
    const paths = second.generated_files.map(({ path }) => path);
    assert.ok(paths.includes(ENVSH('rr')));
    assert.ok(!paths.includes(ENVSH('qz')));
    assert.ok(!paths.includes(ENVSH('ns')));
    assert.equal(
        second.ownership.shell_tree_sha256,
        manifest.ownership.shell_tree_sha256
    );
});

test('renommer puis publier : la composition, jamais touchée par le renommage (V5.3), se republie ; aucune publication ne touche le script ajouté', () => {
    const { manifest, files } = published();
    const renamed = renamedManifest(
        manifest,
        renameRecord(renameFiles(files, 'ns', 'qz'), 'ns', 'qz'),
        ID.q
    );
    const republished = publishedManifest(
        renamed,
        {
            plan_id: '8'.repeat(64),
            tool: 'generate:page-composition',
            files: [
                replaced(
                    SPEC,
                    'utilisateur@exemple.test\n',
                    'utilisateur@exemple.test\n// v2\n'
                ),
            ],
        },
        ID.q
    );
    verifyApplicationOwnership(republished, ID.q);
    assert.equal(
        lastWriters(republished, ID.q).get(SPEC),
        'generate:page-composition'
    );
    assert.equal(
        republished.ownership.shell_tree_sha256,
        manifest.ownership.shell_tree_sha256
    );
    // Le script d'entrée ajouté par le renommage n'est pas dans `published` :
    // aucune publication ne peut le remplacer, ni l'ajouter à nouveau.
    for (const change of [
        replaced(ENVSH('qz'), 'export QZ_UPSTREAMS_VALIDATED=1\n', 'x\n'),
        added(ENVSH('qz'), 'x\n'),
    ])
        assert.throws(
            () =>
                publishedManifest(
                    renamed,
                    {
                        plan_id: '7'.repeat(64),
                        tool: 'generate:page-composition',
                        files: [change],
                    },
                    ID.q
                ),
            /outside declared zones|adds an owned file/
        );
    // Une publication ne peut pas porter l'outil de renommage.
    assert.throws(
        () =>
            publishedManifest(
                renamed,
                renameRecord(
                    [replaced(MAIN, 'policy qz-sw\n', 'x\n')],
                    'qz',
                    'rr',
                    ID.q
                ),
                ID.q
            ),
        /a rename is not a publication/
    );
});

// Lot MARQUE, commit 3 : enregistrement de renommage du préfixe dans le sceau
// d'une appli extérieure (ADR-0103, voie R2). Zone fermée par le dernier
// écrivain, paire de scripts d'entrée nginx, genre `removed`, rejeu inverse
// jusqu'à la coque d'origine, version du sceau.
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
const SPEC =
    'src/app/generated/pages/page_1111111111111111/composition/src/page-composition.spec.ts';
const MODEL = 'src/app/generated/actions/enter/execution-model.json';
const PAGE_FILE = `src/app/pages/${PAGE}/page.component.ts`;

// Coque fictive en `p` : un fichier de coque, un fichier de page, le script
// d'entrée nginx de `p`, le contrat de page qui déclare la page.
function shell(prefix = 'ns') {
    const files = {
        'src/main.ts': `policy ${prefix}-sw\n`,
        [PAGE_FILE]: 'export class Page {}\n',
        [relayEnvshPath(prefix)]:
            `export ${prefix.toUpperCase()}_UPSTREAMS_VALIDATED=1\n`,
        [`${SIGNATURE_FILES.pages}/${PAGE}.json`]: '{}\n',
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
            files: [added(SPEC, 'ns@exemple.test\n')],
        },
        ID.p
    );
    return {
        manifest: next,
        files: {
            ...files,
            [MODEL]: '{"p":"ns"}\n',
            [SPEC]: 'ns@exemple.test\n',
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
        replaced('src/main.ts', files['src/main.ts'], `policy ${to}-sw\n`),
        replaced(SPEC, files[SPEC], `${to}@exemple.test\n`),
        removed(relayEnvshPath(from), files[relayEnvshPath(from)]),
        added(
            relayEnvshPath(to),
            `export ${to.toUpperCase()}_UPSTREAMS_VALIDATED=1\n`
        ),
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
    assert.ok(paths.includes(relayEnvshPath('qz')));
    assert.ok(!paths.includes(relayEnvshPath('ns')));
    verifyApplicationOwnership(next, ID.q);
    assert.throws(
        () => verifyApplicationOwnership(next, ID.p),
        /bound to another workspace/
    );
    // Dernier écrivain : le renommage, pour les fichiers qu'il a écrits.
    const writers = lastWriters(next, ID.q);
    assert.equal(writers.get('src/main.ts'), RENAME_TOOL);
    assert.equal(writers.get(SPEC), RENAME_TOOL);
    assert.equal(writers.get(MODEL), 'generate:action-request');
    assert.equal(writers.get(PAGE_FILE), 'shell');
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
        [
            'fichier de page de la coque',
            [replaced(PAGE_FILE, files[PAGE_FILE], 'export class Autre {}\n')],
            /outside its zone/,
        ],
        [
            'deux removed',
            [
                removed(relayEnvshPath('ns'), files[relayEnvshPath('ns')]),
                removed('src/main.ts', files['src/main.ts']),
            ],
            /outside its zone/,
        ],
        [
            'removed hors de la paire',
            [
                removed('src/main.ts', files['src/main.ts']),
                added(relayEnvshPath('qz'), 'x\n'),
            ],
            /outside its zone/,
        ],
        [
            'removed sans added',
            [removed(relayEnvshPath('ns'), files[relayEnvshPath('ns')])],
            /outside its zone/,
        ],
        [
            'added hors de la paire',
            [
                removed(relayEnvshPath('ns'), files[relayEnvshPath('ns')]),
                added('src/app/autre.ts', 'x\n'),
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
                        [replaced('src/main.ts', files['src/main.ts'], 'x\n')],
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

const QUERY = 'src/app/generated/queries/catalogue/execution-model.json';
const PLAN = `src/app/generated/pages/${PAGE}/plan/page-execution-plan.json`;

test('D.4 : enregistrement forgé et rescellé, refusé par la zone structurelle', () => {
    let { manifest, files } = published();
    // Derniers écrivains de chaque genre : lecture, plan, réalisation.
    for (const [tool, change] of [
        ['generate:list-query', added(QUERY, '{"q":1}\n')],
        ['compile:page-execution-plan', added(PLAN, '{"plan":1}\n')],
        [
            'page-realization',
            replaced(PAGE_FILE, files[PAGE_FILE], 'export class Real {}\n'),
        ],
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
        [PAGE_FILE]: 'export class Real {}\n',
    };
    const pageContract = `${SIGNATURE_FILES.pages}/${PAGE}.json`;
    const cases = [
        ['commande', [replaced(MODEL, files[MODEL], '{"p":"qz"}\n')]],
        ['lecture', [replaced(QUERY, files[QUERY], '{"q":2}\n')]],
        ['plan', [replaced(PLAN, files[PLAN], '{"plan":2}\n')]],
        ['réalisation', [replaced(PAGE_FILE, files[PAGE_FILE], 'x\n')]],
        [
            'dossier de signature',
            [replaced(pageContract, files[pageContract], '[]\n')],
        ],
        [
            'deux removed',
            [
                removed(relayEnvshPath('ns'), files[relayEnvshPath('ns')]),
                removed('src/main.ts', files['src/main.ts']),
            ],
        ],
        [
            'removed hors de la paire',
            [
                removed('src/main.ts', files['src/main.ts']),
                added(relayEnvshPath('qz'), 'x\n'),
            ],
        ],
        [
            'removed sans added',
            [removed(relayEnvshPath('ns'), files[relayEnvshPath('ns')])],
        ],
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
                [
                    replaced(
                        'src/main.ts',
                        files['src/main.ts'],
                        'policy qz-sw\n'
                    ),
                ],
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
        'src/main.ts': 'policy qz-sw\n',
        [SPEC]: 'qz@exemple.test\n',
    };
    assert.throws(
        () =>
            renamedManifest(
                first,
                renameRecord(
                    [
                        replaced(
                            'src/main.ts',
                            afterQ['src/main.ts'],
                            'policy tt-sw\n'
                        ),
                    ],
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
        'src/main.ts': 'policy qz-sw\n',
        [SPEC]: 'qz@exemple.test\n',
        [relayEnvshPath('qz')]: 'export QZ_UPSTREAMS_VALIDATED=1\n',
    };
    delete afterQ[relayEnvshPath('ns')];
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
    assert.ok(paths.includes(relayEnvshPath('rr')));
    assert.ok(!paths.includes(relayEnvshPath('qz')));
    assert.ok(!paths.includes(relayEnvshPath('ns')));
    assert.equal(
        second.ownership.shell_tree_sha256,
        manifest.ownership.shell_tree_sha256
    );
});

test('renommer puis publier : une composition remplace la spec écrite par le renommage ; aucune publication ne touche le script ajouté', () => {
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
                replaced(SPEC, 'qz@exemple.test\n', 'qz@exemple.test\n// v2\n'),
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
        replaced(
            relayEnvshPath('qz'),
            'export QZ_UPSTREAMS_VALIDATED=1\n',
            'x\n'
        ),
        added(relayEnvshPath('qz'), 'x\n'),
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
                    [replaced('src/main.ts', 'policy qz-sw\n', 'x\n')],
                    'qz',
                    'rr',
                    ID.q
                ),
                ID.q
            ),
        /a rename is not a publication/
    );
});

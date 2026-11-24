// Lot 2, commit 3 (v2 R2.4 points 1 et 6 ; v3 V3.2 et V3.3 ; v4 V4.5) : le
// module des sources, unitairement. Oracles écrits ici :
// - `staleSources` rend la liste COMPLÈTE des écarts, sans connaître les
//   genres (genre inventé `x-test` contrôlé sans changer le code) ;
// - la fermeture d'un genre lit les chemins DANS une source (`contract.sources`),
//   pas seulement les références de la conception ;
// - `resolveDesignDigests` : interne déclarée, extérieur interdite, liaison
//   d'abord, octets lus une seule fois sinon ;
// - la table des classes est EXHAUSTIVE dans les deux sens, sur la liste
//   DÉRIVÉE des outils exécutables qui acceptent `--target-root`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
    applicationSources,
    assertApplicationSources,
    commandClass,
    EXTERNAL_COMMAND_CLASSES,
    resolveDesignDigests,
    SOURCE_GENRES,
    sourcesToBindLines,
    staleSources,
} from './core/application-sources.mjs';
import { sha256 } from './core/generation-manifest.mjs';
import { TOOLS_ROOT } from './test-support/external-application-fixture.mjs';

const digestOf = (text) => ({
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
});

test('staleSources : genre inventé contrôlé sans code ; écarts complets, modifiés et absents', async () => {
    const files = new Map([
        ['descriptions/a.json', 'a'],
        ['descriptions/b.json', 'b changé'],
    ]);
    const sources = [
        { genre: 'x-test', path: 'descriptions/a.json', ...digestOf('a') },
        { genre: 'x-test', path: 'descriptions/b.json', ...digestOf('b') },
        { genre: 'contract', path: 'descriptions/c.json', ...digestOf('c') },
    ];
    const read = async (path) =>
        files.has(path) ? digestOf(files.get(path)) : null;
    assert.deepEqual(await staleSources(sources, read), [
        { genre: 'x-test', path: 'descriptions/b.json', kind: 'modified' },
        { genre: 'contract', path: 'descriptions/c.json', kind: 'missing' },
    ]);
    await assert.rejects(
        staleSources([{ ...sources[0], path: '../a.json' }], read),
        /unsafe source path/
    );
});

// Un script `package.json` lance l'outil : jeton `node` suivi du chemin
// EXACT de l'outil, comparés comme chaînes (aucune expression construite, donc
// aucun échappement à faire ; CI #48, CodeQL `js/incomplete-sanitization`).
const scriptRunsTool = (script, tool) => {
    const words = script.split(/\s+/);
    return words.some(
        (word, index) => word === 'node' && words[index + 1] === tool
    );
};

test('scriptRunsTool : chemin exact, jamais un motif (point, barre oblique inverse)', () => {
    assert.equal(
        scriptRunsTool('node tools/create-app.mjs', 'tools/create-app.mjs'),
        true
    );
    assert.equal(
        scriptRunsTool(
            'bun x && node tools/create-app.mjs --x',
            'tools/create-app.mjs'
        ),
        true
    );
    // Formes fautives : un point lu comme « n'importe quel caractère », une
    // barre oblique inverse, un préfixe ou un suffixe du chemin.
    for (const script of [
        'node tools/create-appXmjs',
        'node tools\\create-app.mjs',
        'node tools/create-app.mjs.bak',
        'node xtools/create-app.mjs',
        'nodetools/create-app.mjs',
    ])
        assert.equal(
            scriptRunsTool(script, 'tools/create-app.mjs'),
            false,
            script
        );
    assert.equal(scriptRunsTool('node a\\b.mjs', 'a\\b.mjs'), true);
});

// Source DÉRIVÉE de la table (V3.2) : outils `tools/**/*.mjs` suivis, hors
// tests et supports, qui portent la garde d'exécution et le littéral
// `'--target-root'`.
const EXECUTION_GUARD =
    /pathToFileURL\(process\.argv\[1\]\)\.href\s*===\s*import\.meta\.url|import\.meta\.url\s*===\s*pathToFileURL\(process\.argv\[1\]\)\.href/;
async function externalTools() {
    const tracked = execFileSync('git', ['ls-files', 'tools'], {
        cwd: TOOLS_ROOT,
        encoding: 'utf8',
    })
        .split('\n')
        .filter(
            (path) =>
                path.endsWith('.mjs') &&
                !path.endsWith('.test.mjs') &&
                !/\/(?:test-support|proof-support)\//.test(path)
        );
    const found = [];
    for (const path of tracked) {
        const text = await readFile(join(TOOLS_ROOT, path), 'utf8');
        if (EXECUTION_GUARD.test(text) && text.includes("'--target-root'"))
            found.push(path);
    }
    return found.sort();
}

test('V3.2 : table des classes exhaustive dans les deux sens ; défaut fermé consommateur', async () => {
    const tools = await externalTools();
    const rows = Object.entries(EXTERNAL_COMMAND_CLASSES);
    const declared = rows
        .filter(([, row]) => !row.pending)
        .map(([, row]) => row.tool);
    assert.deepEqual([...declared].sort(), tools);
    for (const [name, row] of rows.filter(([, row]) => row.pending))
        assert.ok(
            !tools.includes(row.tool),
            `${name} : outil présent, marque pending à retirer`
        );
    const scripts = JSON.parse(
        await readFile(join(TOOLS_ROOT, 'package.json'), 'utf8')
    ).scripts;
    for (const [name, row] of rows.filter(([, row]) => !row.pending))
        if (Object.hasOwn(scripts, name))
            assert.ok(scriptRunsTool(scripts[name], row.tool), name);
    assert.equal(commandClass(undefined), 'consumer');
    assert.equal(commandClass('commande-inconnue'), 'consumer');
    assert.equal(commandClass('update-app'), 'consumer'); // pending : pas encore outillée
});

test('V4.5 : la fermeture du genre contract lit les chemins DANS le contrat ; un chemin cité par deux genres est refusé', async () => {
    const files = new Map([
        ['d/design.json', '{}'],
        ['d/brief.md', 'brief'],
        [
            'd/contract.json',
            JSON.stringify({
                sources: [
                    { snapshot_uri: 'd/source.json' },
                    { kind: 'inline' },
                ],
            }),
        ],
        ['d/source.json', 'source'],
    ]);
    const read = async (path) => Buffer.from(files.get(path));
    const design = {
        sources: [{ snapshot_uri: 'd/brief.md' }],
        backend_contracts: [{ snapshot_uri: 'd/contract.json' }],
    };
    assert.deepEqual(
        (await applicationSources(design, 'd/design.json', read)).map(
            ({ genre, path }) => [genre, path]
        ),
        [
            ['design', 'd/brief.md'],
            ['contract', 'd/contract.json'],
            ['design', 'd/design.json'],
            ['contract', 'd/source.json'],
        ]
    );
    await assert.rejects(
        applicationSources(
            { ...design, sources: [{ snapshot_uri: 'd/contract.json' }] },
            'd/design.json',
            read
        ),
        /source cited by two genres: d\/contract\.json/
    );
    // Les lots 3 et 4 n'ajoutent que des entrées de table.
    assert.deepEqual(
        SOURCE_GENRES.map(({ genre }) => genre),
        ['design', 'contract']
    );
});

test('V3.3 : résolution des empreintes de contrat, une fois, selon le mode (P-M3b, P-M3c)', async () => {
    const reads = [];
    const read = async (path) => {
        reads.push(path);
        return Buffer.from('contrat');
    };
    const internal = {
        backend_contracts: [{ snapshot_uri: 'c.json', sha256: 'a'.repeat(64) }],
    };
    assert.equal(
        (await resolveDesignDigests(internal, { mode: 'internal' })).design,
        internal
    );
    await assert.rejects(
        resolveDesignDigests(
            { backend_contracts: [{ snapshot_uri: 'c.json' }] },
            { mode: 'internal' }
        ),
        /INTERNAL_DESIGN_CONTRACT_DIGEST c\.json/
    );
    await assert.rejects(
        resolveDesignDigests(internal, { mode: 'external', read }),
        /EXTERNAL_DESIGN_CONTRACT_DIGEST c\.json/
    );
    const external = { backend_contracts: [{ snapshot_uri: 'c.json' }] };
    // Sans liaison : octets lus UNE fois, rendus à l'appelant.
    const fromBytes = await resolveDesignDigests(external, {
        mode: 'external',
        read,
    });
    assert.equal(
        fromBytes.design.backend_contracts[0].sha256,
        sha256(Buffer.from('contrat'))
    );
    assert.deepEqual(fromBytes.read, [
        { path: 'c.json', sha256: sha256(Buffer.from('contrat')), bytes: 7 },
    ]);
    assert.deepEqual(reads, ['c.json']);
    assert.equal(
        Object.hasOwn(external.backend_contracts[0], 'sha256'),
        false,
        'conception source intacte'
    );
    // Liaison d'une appli existante : elle prime, rien n'est lu.
    const bound = await resolveDesignDigests(external, {
        mode: 'external',
        binding: [
            {
                genre: 'contract',
                path: 'c.json',
                sha256: 'b'.repeat(64),
                bytes: 1,
            },
        ],
        read,
    });
    assert.equal(bound.design.backend_contracts[0].sha256, 'b'.repeat(64));
    assert.deepEqual(reads, ['c.json']);
});

test('liaison rendue : forme fermée, entrée design égale à design_ref ; lignes SOURCES_A_LIER sans doublon', () => {
    const design = {
        genre: 'design',
        path: 'd/design.json',
        sha256: 'a'.repeat(64),
        bytes: 2,
    };
    const contract = {
        genre: 'contract',
        path: 'd/contract.json',
        sha256: 'b'.repeat(64),
        bytes: 3,
    };
    const manifest = {
        design_ref: { path: 'd/design.json', sha256: 'a'.repeat(64) },
        sources: [contract, design],
    };
    assert.deepEqual(assertApplicationSources(manifest), [contract, design]);
    for (const sources of [
        [design, contract],
        [contract],
        [contract, { ...design, sha256: 'c'.repeat(64) }],
        [contract, { ...design, extra: true }],
    ])
        assert.throws(
            () => assertApplicationSources({ ...manifest, sources }),
            /app sources binding is invalid/
        );
    assert.deepEqual(
        sourcesToBindLines([
            { app: 'a', genre: 'contract', path: 'd/contract.json' },
            { app: 'b', genre: 'contract', path: 'd/contract.json' },
        ]),
        [
            'SOURCES_A_LIER: contract d/contract.json ; lancer update-app --target-root <racine> --dry-run',
        ]
    );
});

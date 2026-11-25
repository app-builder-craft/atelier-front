// Lot 2, commit 6b (conception v5, C-B1 ; index du pilote) : opération
// `files` de la brique, éprouvée par un ARRÊT BRUTAL réel (SIGKILL d'un
// processus enfant) après chaque bascule de fichier et entre l'écriture de
// chaque temporaire et son renommage, sur une opération de quatre fichiers
// dont deux remplacés et deux ajoutés (dossiers créés), à côté d'un fichier
// libre de l'IA. Oracles écrits ici :
// - reprise avant `verified` : produit égal à l'octet à l'état d'avant
//   (fichiers ajoutés supprimés, dossiers créés retirés, fichiers remplacés
//   restaurés, temporaires absents, fichier libre égal) ; à `verified` : égal
//   à l'état d'après ;
// - un fichier listé modifié pendant l'arrêt, une copie d'avant abîmée, un
//   journal falsifié : refus nommé, rien n'est déplacé (arbre comparé à
//   l'octet avant et après la tentative).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { pathExists } from './core/external-application-paths.mjs';
import { sha256 } from './core/generation-manifest.mjs';
import { prepareFilesOperation } from './core/product-files-operation.mjs';
import { snapshotTree } from './test-support/external-application-fixture.mjs';
import {
    FILES_ROOT,
    filesJournalRoot,
    recoverFilesTransaction,
    runFilesTransaction,
} from './test-support/files-transaction-driver.mjs';

const DRIVER = new URL(
    './test-support/files-transaction-driver.mjs',
    import.meta.url
).href;
const PLAN = sha256('lot2-commit-6b');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// Racine partiellement possédée, d'avant : deux fichiers que l'opération
// remplace, un fichier possédé qu'elle ne liste pas, un fichier libre de
// l'IA.
const BEFORE = {
    'eslint.config.mjs': 'export default [];\n',
    'project.json': '{ "name": "demo-interface" }\n',
    'src/index.ts': 'export {};\n',
    'src/pages/accueil/accueil.ts': '// écrit par l’IA\n',
};
// Fichiers LISTÉS, d'après : deux remplacés, deux ajoutés (l'un crée deux
// dossiers).
const AFTER = {
    'eslint.config.mjs': 'export default [{ rules: {} }];\n',
    'project.json': '{ "name": "demo-interface", "tags": [] }\n',
    'src/pages/nouvelle/profonde/nouvelle.ts': 'export const nouvelle = 1;\n',
    'tsconfig.lib.json': '{}\n',
};
const LISTED = Object.keys(AFTER).sort();
const artifact = (text) => ({
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
});

async function product(t) {
    // Chemin physique : le dossier temporaire de macOS passe par un lien.
    const parent = await realpath(
        await mkdtemp(join(tmpdir(), 'files-operation-'))
    );
    t.after(() => rm(parent, { recursive: true, force: true }));
    const root = join(parent, 'product');
    for (const [path, content] of Object.entries(BEFORE)) {
        const absolute = join(root, FILES_ROOT, path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content);
    }
    return { parent, root };
}
// Tout ce qui vit à côté du produit compte : journal, préparation.
const state = (fixture) => snapshotTree(fixture.parent, []);
const recover = (fixture) => recoverFilesTransaction(fixture.root, PLAN);

// Transaction lancée dans un processus enfant, tué par SIGKILL au point
// nommé.
function killedAt(fixture, interrupted) {
    const program = `import { runFilesTransaction } from ${JSON.stringify(DRIVER)};
await runFilesTransaction(process.argv[1], JSON.parse(process.argv[2]), process.argv[3], (name) => { if (name === process.argv[4]) process.kill(process.pid, 'SIGKILL'); });`;
    const result = spawnSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            program,
            fixture.root,
            JSON.stringify(AFTER),
            PLAN,
            interrupted,
        ],
        { encoding: 'utf8', timeout: 60_000 }
    );
    assert.equal(result.signal, 'SIGKILL', result.stderr);
}

async function afterState(t) {
    const fixture = await product(t);
    await runFilesTransaction(fixture.root, AFTER, PLAN);
    return state(fixture);
}

test('C-B1 : la préparation inscrit avant, après, copies et dossiers créés, sans rien écrire', async (t) => {
    const fixture = await product(t);
    const before = await state(fixture);
    const { operation, copies } = await prepareFilesOperation(
        fixture.root,
        FILES_ROOT,
        AFTER,
        0
    );
    assert.deepEqual(
        operation.files.map((file) => file.path),
        LISTED
    );
    assert.deepEqual(
        operation.files.map((file) => file.before),
        [
            artifact(BEFORE['eslint.config.mjs']),
            artifact(BEFORE['project.json']),
            null,
            null,
        ]
    );
    assert.deepEqual(
        operation.files.map((file) => file.after),
        LISTED.map((path) => artifact(AFTER[path]))
    );
    assert.deepEqual(operation.created_directories, [
        `${FILES_ROOT}/src/pages/nouvelle/profonde`,
        `${FILES_ROOT}/src/pages/nouvelle`,
    ]);
    assert.deepEqual(
        copies.map(([name, content]) => [name, content.toString()]),
        [
            ['before/0/0', BEFORE['eslint.config.mjs']],
            ['before/0/1', BEFORE['project.json']],
        ]
    );
    assert.deepEqual(await state(fixture), before);
    // Une cible qui n'est pas un fichier régulier est refusée, nommée.
    await mkdir(join(fixture.root, FILES_ROOT, 'tsconfig.lib.json'));
    await assert.rejects(
        prepareFilesOperation(fixture.root, FILES_ROOT, AFTER, 0),
        /^Error: external application: files operation target is not a regular file: libs\/demo-interface\/tsconfig\.lib\.json$/
    );
});

test('C-B1 : arrêt brutal après chaque bascule et entre chaque temporaire et son renommage ; reprise exacte', async (t) => {
    const probe = await product(t);
    const phases = [];
    await runFilesTransaction(probe.root, AFTER, PLAN, (name) =>
        phases.push(name)
    );
    const after = await state(probe);
    assert.deepEqual(phases, [
        'prepared',
        ...LISTED.flatMap((path) => [
            `file-written:${FILES_ROOT}/${path}`,
            `file-swapped:${FILES_ROOT}/${path}`,
        ]),
        'verified',
    ]);
    for (const interrupted of phases)
        await t.test(`arrêt brutal à ${interrupted}`, async (child) => {
            const fixture = await product(child);
            const before = await state(fixture);
            killedAt(fixture, interrupted);
            assert.equal(
                await pathExists(filesJournalRoot(fixture.root, PLAN)),
                true
            );
            const forward = interrupted === 'verified';
            assert.equal(await recover(fixture), forward ? 'forward' : 'back');
            assert.deepEqual(await state(fixture), forward ? after : before);
        });
});

test('C-B1 : un fichier listé modifié pendant l’arrêt rend la reprise ambiguë ; rien n’est déplacé', async (t) => {
    const interrupted = `file-swapped:${FILES_ROOT}/project.json`;
    // Un fichier basculé puis retouché ; le DERNIER fichier de l'ordre, pas
    // encore basculé, posé à la main (les deux premiers sont basculés : la
    // décision attend l'examen de tous).
    for (const [path, content] of [
        ['eslint.config.mjs', 'retouché à la main\n'],
        ['tsconfig.lib.json', 'posé à la main\n'],
    ]) {
        const fixture = await product(t);
        killedAt(fixture, interrupted);
        await writeFile(join(fixture.root, FILES_ROOT, path), content);
        const seen = await state(fixture);
        await assert.rejects(
            recover(fixture),
            new RegExp(
                `^Error: ambiguous interrupted transaction: ${escape(FILES_ROOT)} ${escape(path)}$`
            )
        );
        assert.deepEqual(await state(fixture), seen);
    }
});

test('C-B1 : une copie d’avant abîmée ou absente est refusée avant tout déplacement', async (t) => {
    for (const [copy, path, damage] of [
        [
            'before/0/1',
            'project.json',
            (absolute) => writeFile(absolute, 'copie abîmée\n'),
        ],
        ['before/0/0', 'eslint.config.mjs', (absolute) => rm(absolute)],
    ]) {
        const fixture = await product(t);
        killedAt(fixture, `file-swapped:${FILES_ROOT}/project.json`);
        await damage(join(filesJournalRoot(fixture.root, PLAN), copy));
        const seen = await state(fixture);
        await assert.rejects(
            recover(fixture),
            new RegExp(
                `^Error: ambiguous interrupted transaction: ${escape(FILES_ROOT)} ${escape(path)} journal copy drifted$`
            )
        );
        assert.deepEqual(await state(fixture), seen);
    }
});

test('C-B1 : à verified, un fichier qui n’est pas à son après est refusé ; un temporaire resté est retiré', async (t) => {
    const after = await afterState(t);
    const fixture = await product(t);
    killedAt(fixture, 'verified');
    const temporary = join(
        fixture.root,
        FILES_ROOT,
        `.project.json.${PLAN}.tmp`
    );
    await writeFile(temporary, 'temporaire resté\n');
    const target = join(fixture.root, FILES_ROOT, 'tsconfig.lib.json');
    await writeFile(target, 'retouché\n');
    const seen = await state(fixture);
    await assert.rejects(
        recover(fixture),
        /^Error: ambiguous interrupted transaction: libs\/demo-interface tsconfig\.lib\.json not swapped$/
    );
    assert.deepEqual(await state(fixture), seen);
    await writeFile(target, AFTER['tsconfig.lib.json']);
    assert.equal(await recover(fixture), 'forward');
    assert.deepEqual(await state(fixture), after);
});

test('C-B1 : un fichier absent au plan et apparu avant sa bascule n’est jamais écrasé ; refus nommé, reprise ambiguë puis exacte', async (t) => {
    // Relecture de l'étape B : la fenêtre entre la dernière relecture et la
    // bascule. Le DERNIER fichier de l'ordre est ajouté (avant nul) ; l'IA y
    // pose le sien après l'écriture du temporaire, avant son renommage.
    const path = 'tsconfig.lib.json';
    assert.equal(LISTED.at(-1), path);
    assert.equal(Object.hasOwn(BEFORE, path), false);
    const fixture = await product(t);
    const before = await state(fixture);
    const absolute = join(fixture.root, FILES_ROOT, path);
    const appeared = '// posé par l’IA juste avant la bascule\n';
    await assert.rejects(
        runFilesTransaction(fixture.root, AFTER, PLAN, async (name) => {
            if (name === `file-written:${FILES_ROOT}/${path}`)
                await writeFile(absolute, appeared);
        }),
        new RegExp(
            `^Error: external application: files operation target appeared: ${escape(`${FILES_ROOT}/${path}`)}$`
        )
    );
    assert.equal(await readFile(absolute, 'utf8'), appeared);
    // Tant que le fichier apparu est là, la reprise est ambiguë et ne déplace
    // rien ; retiré par son auteur, elle rend l'état d'avant à l'octet.
    const seen = await state(fixture);
    await assert.rejects(
        recover(fixture),
        new RegExp(
            `^Error: ambiguous interrupted transaction: ${escape(FILES_ROOT)} ${escape(path)}$`
        )
    );
    assert.deepEqual(await state(fixture), seen);
    await rm(absolute);
    assert.equal(await recover(fixture), 'back');
    assert.deepEqual(await state(fixture), before);
});

test('C-B1 : un fichier libre écrit dans un dossier créé reste ; le dossier créé vide est retiré', async (t) => {
    const fixture = await product(t);
    killedAt(
        fixture,
        `file-swapped:${FILES_ROOT}/src/pages/nouvelle/profonde/nouvelle.ts`
    );
    const free = join(fixture.root, FILES_ROOT, 'src/pages/nouvelle/libre.ts');
    await writeFile(free, '// écrit par l’IA pendant l’arrêt\n');
    assert.equal(await recover(fixture), 'back');
    assert.equal(
        await readFile(free, 'utf8'),
        '// écrit par l’IA pendant l’arrêt\n'
    );
    assert.equal(
        await pathExists(
            join(fixture.root, FILES_ROOT, 'src/pages/nouvelle/profonde')
        ),
        false
    );
    for (const [path, content] of Object.entries(BEFORE))
        assert.equal(
            await readFile(join(fixture.root, FILES_ROOT, path), 'utf8'),
            content
        );
    assert.equal(
        await pathExists(join(fixture.root, FILES_ROOT, 'tsconfig.lib.json')),
        false
    );
});

test('C-B1 : un journal falsifié est refusé, rien n’est déplacé', async (t) => {
    for (const [label, forge] of [
        [
            'chemin qui sort de la racine',
            (operation) => {
                operation.files[2].path = '../autre/nouvelle.ts';
            },
        ],
        [
            'dossier créé hors de la racine',
            (operation) => {
                operation.created_directories[0] = 'libs/autre/dossier';
            },
        ],
        [
            // Relecture de l'étape B : le moins profond d'abord, le retour ne
            // retirerait pas le dossier parent (encore plein).
            'dossiers créés hors de l’ordre de la préparation',
            (operation) => {
                operation.created_directories.reverse();
            },
        ],
        [
            'dossier créé en double',
            (operation) => {
                operation.created_directories.splice(
                    1,
                    0,
                    operation.created_directories[0]
                );
            },
        ],
        [
            'racine étrangère',
            (operation) => {
                // Ses dossiers suivent : seule la règle des racines refuse.
                operation.root = 'libs/autre-interface';
                operation.created_directories =
                    operation.created_directories.map((path) =>
                        path.replace(FILES_ROOT, operation.root)
                    );
            },
        ],
        [
            'après sans empreinte valide',
            (operation) => {
                operation.files[0].after = { sha256: 'abc', bytes: 1 };
            },
        ],
    ]) {
        const fixture = await product(t);
        killedAt(fixture, `file-swapped:${FILES_ROOT}/project.json`);
        const path = join(filesJournalRoot(fixture.root, PLAN), 'journal.json');
        const journal = JSON.parse(await readFile(path, 'utf8'));
        forge(journal.operations[0]);
        await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`);
        const seen = await state(fixture);
        await assert.rejects(
            recover(fixture),
            /^Error: ambiguous interrupted transaction: invalid journal$/,
            label
        );
        assert.deepEqual(await state(fixture), seen, label);
    }
});

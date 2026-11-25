import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { nativeRunLabels } from '../core/application-native-controls.mjs';
import { planExternalApplicationShell } from '../core/application-workspace.mjs';
import { toolEnv } from '../core/atelier-signature.mjs';
import { isWithin } from '../core/external-application-paths.mjs';
import {
    interfaceLibraryName,
    socleLibraryName,
} from '../core/socle-names.mjs';
import {
    assertionControl,
    hash,
    isProofControl,
    TOOLS_ROOT,
} from '../test-support/external-application-fixture.mjs';
import {
    NATIVE_CELLS,
    proveNativeDocumentCell,
    writeDocumentInputs,
} from '../test-support/external-document-fixture.mjs';
import { confinedNode, record } from './external-application-runtime.mjs';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const SHARED_DOCUMENT_SOURCE =
    'examples/application-conception-proof/project-brief.md';

// Preserve the existing same-relative-path counterexample with A's exact brief.
// B keeps its original independent inputs and supplies the authenticated route.
export async function nativeDocumentFixture(root, kind) {
    const fixture = await writeDocumentInputs(root, kind, { shell: true });
    if (kind === 'A') {
        const source = fixture.design.sources.find((item) =>
            item.snapshot_uri.endsWith('/project-brief.md')
        );
        assert.ok(source);
        const bytes = await readFile(join(TOOLS_ROOT, SHARED_DOCUMENT_SOURCE));
        assert.equal(hash(bytes), source.sha256);
        await mkdir(dirname(join(root, SHARED_DOCUMENT_SOURCE)), {
            recursive: true,
        });
        await writeFile(join(root, SHARED_DOCUMENT_SOURCE), bytes, {
            flag: 'wx',
        });
        fixture.variant.changes.push({
            path: `sources[${fixture.design.sources.indexOf(source)}].snapshot_uri`,
            before: source.snapshot_uri,
            after: SHARED_DOCUMENT_SOURCE,
            reason: 'same bytes at the same relative path as the workshop; T11 closure counterexample',
        });
        source.snapshot_uri = SHARED_DOCUMENT_SOURCE;
        const sourceBytes = json(fixture.design);
        await writeFile(join(root, fixture.sourcePath), sourceBytes);
        fixture.variant.compiled_source_sha256 = hash(sourceBytes);
    }
    return fixture;
}

export function nativeCellEnvironment(node, root, cell, contextPath) {
    assert.ok(NATIVE_CELLS.includes(cell));
    for (const path of [node, root, contextPath])
        assert.equal(resolve(path), path);
    return {
        PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        LANG: 'C',
        NO_COLOR: '1',
        CI: '1',
        NX_DAEMON: 'false',
        NX_NO_CLOUD: 'true',
        [toolEnv('EXT03A_NATIVE_CELL')]: cell,
        [toolEnv('EXT03A_NATIVE_ROOT')]: root,
        [toolEnv('EXT03A_NATIVE_CONTEXT')]: contextPath,
    };
}

export function nativeCellContext(context, root, cell, contextPath) {
    assert.ok(NATIVE_CELLS.includes(cell));
    assert.equal(context.schema_version, 1);
    assert.equal(context.cell, cell);
    assert.equal(context.fixture.root, root);
    assert.equal(context.fixture.kind, cell.split('/')[0]);
    assert.ok(['macos', 'docker'].includes(context.session.backend));
    for (const path of [root, contextPath, context.session.root])
        assert.equal(resolve(path), path);
    assert.ok(isWithin(context.session.root, root));
    assert.ok(isWithin(context.session.root, contextPath));
    assert.equal(dirname(contextPath), context.session.root);
    assert.equal(context.session.hostNode, process.execPath);
    return {
        fixture: context.fixture,
        session: { ...context.session, lines: [] },
        receiptPath: `${contextPath}.receipt.json`,
    };
}

// CI #48 (`be7bf4e9`) : la ligne FAIL d'une cellule native nomme, sous forme
// FERMÉE, l'appel natif en échec : son label, pris dans `nativeRunLabels(plan)`
// par la cellule, et son code de sortie ; hors appel natif, le contrôle en
// cause (opérateur et lieu dans l'atelier, comme le STOP d'`e023a1ed`). Jamais
// une sortie ni un message. La cellule écrit la note ; le coordinateur la
// revérifie (clés exactes, label dans la liste fermée de SON appli) avant de
// l'écrire au rapport.
const NOTE_KEYS = ['call', 'control', 'exit'];
const CELL_TARGETS = ['lint', 'build:production', 'test'];
const cellApp = (cell) => `ext03a-${cell.replace('/', '-').toLowerCase()}`;
const cellLabels = (cell) => {
    const app = cellApp(cell);
    return new Set([
        'native-compiler',
        'workspace-contract',
        ...[app, socleLibraryName(app), interfaceLibraryName(app)].flatMap(
            (project) => CELL_TARGETS.map((target) => `${project}:${target}`)
        ),
    ]);
};
const isExit = (value) =>
    value === 'interrupted' ||
    (Number.isInteger(value) && value >= 0 && value <= 255);

export function cellFailureNote({ error, failed, expected }) {
    const call =
        failed && expected.includes(failed.label) && isExit(failed.exit)
            ? failed.label
            : null;
    return {
        call,
        control: call || !error ? '' : assertionControl(error),
        exit: call ? failed.exit : null,
    };
}

export function cellFailureDetail(note, cell) {
    if (
        note === null ||
        typeof note !== 'object' ||
        Object.keys(note).sort().join() !== NOTE_KEYS.join()
    )
        return 'call=illisible';
    if (note.call !== null) {
        if (!cellLabels(cell).has(note.call) || !isExit(note.exit))
            return 'call=illisible';
        return `call=${note.call} call_exit=${note.exit}`;
    }
    if (note.exit !== null || typeof note.control !== 'string')
        return 'call=illisible';
    if (!note.control) return 'call=aucun';
    return isProofControl(note.control)
        ? `call=aucun at=${note.control}`
        : 'call=illisible';
}

// Note d'échec écrite par la cellule ; absente ou spéciale : `call=absent`.
async function readCellFailure(contextPath, cell) {
    const path = `${contextPath}.failure.json`;
    try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.size > 4096) return 'call=illisible';
    } catch {
        return 'call=absent';
    }
    try {
        return cellFailureDetail(
            JSON.parse(await readFile(path, 'utf8')),
            cell
        );
    } catch {
        return 'call=illisible';
    }
}

// Appels natifs d'une cellule (CI #48) : label de chaque appel, liste fermée
// du plan de la création (`nativeRunLabels`, reçue par `onPlan`) et appel en
// échec ; sur un échec, la note fermée est remise à `onFailure` avant que
// l'erreur ne remonte. Exécution et compte rendu injectés.
export async function proveCellCalls({
    root,
    cell,
    fixture,
    execute,
    report,
    onFailure,
}) {
    const labels = [];
    let expected = [];
    let failed = null;
    const run = (command, args, cwd) => {
        assert.equal(command, process.execPath);
        assert.equal(cwd, root);
        const label =
            args[1] === 'run'
                ? args[2]
                : args[0].endsWith('check-workspace.mjs')
                  ? 'workspace-contract'
                  : 'native-compiler';
        const result = execute(args);
        if (result.status !== 0 || result.signal)
            failed = { label, exit: result.status ?? 'interrupted' };
        report(label, result);
        labels.push(label);
    };
    try {
        const receipt = await proveNativeDocumentCell(root, cell, {
            fixture,
            run,
            onPlan: (plan) => {
                expected = nativeRunLabels(plan);
            },
        });
        return { labels, receipt };
    } catch (error) {
        await onFailure(cellFailureNote({ error, failed, expected }));
        throw error;
    }
}

// The test runner stays in the trusted workshop; every compiler/Nx child is
// executed by the existing native sandbox with no workshop mount and no network.
export async function provePreparedDocumentCell(root, cell, contextPath) {
    const context = JSON.parse(await readFile(contextPath, 'utf8'));
    const { fixture, session, receiptPath } = nativeCellContext(
        context,
        root,
        cell,
        contextPath
    );
    const { labels, receipt } = await proveCellCalls({
        root,
        cell,
        fixture,
        execute: (args) => confinedNode(session, root, args),
        report: (label, result) =>
            record(session, `EXT03a/${cell}/${label}`, result),
        onFailure: (note) =>
            writeFile(`${contextPath}.failure.json`, json(note), {
                flag: 'wx',
                mode: 0o600,
            }),
    });
    // C-B2 : liste dérivée du plan de création (sans session : test de la
    // coque, lint des trois projets avant la construction).
    assert.deepEqual(labels, receipt.native_labels);
    receipt.native = {
        backend: session.backend,
        labels,
        report: session.lines,
    };
    await writeFile(receiptPath, json(receipt), { flag: 'wx' });
    return receipt;
}

// C-B2 : les appels du runner d'une cellule sont ceux que la liste unique
// dérive du plan de la création (`nativeRunLabels`), RECALCULÉ ici par le
// coordinateur ; jamais un nombre écrit à la main (CI #48, 1b : la création
// fait 8 appels, le contrôle en attendait 5).
export function assertNativeCellLabels(receipt, plan) {
    const expected = nativeRunLabels(plan);
    assert.deepEqual(receipt.native.labels, expected, 'native cell labels');
    assert.deepEqual(
        receipt.native_labels,
        expected,
        'native cell plan labels'
    );
}

// CI #48 (run 45377254689, sur 845fa02e) : le plan d'une création LIE la
// liaison des sources de TOUTES les autres applis du produit (v3 V3.5 b
// point 2) ; un plan relu devient donc périmé dès qu'une autre appli est
// créée après lui (point 3 : « plan périmé »), à juste titre. Les plans des
// coques d'un produit sont relus APRÈS toutes ses cellules, dans l'état que
// la reprise (T9–T12) appliquera.
export async function reviewCellShells(root, kind, fixture, profiles, runCell) {
    const receipts = [];
    for (const profile of profiles) receipts.push(await runCell(profile));
    const reviewed = [];
    for (const [index, profile] of profiles.entries()) {
        const shell = {
            workspaceRoot: TOOLS_ROOT,
            targetRoot: root,
            appName: `ext03a-${kind.toLowerCase()}-${profile}`,
            profile,
            designPath: fixture.designPath,
            experienceId: fixture.design.experiences[0].id,
        };
        const plan = await planExternalApplicationShell(shell);
        reviewed.push({
            shell: { ...shell, expectedPlanId: plan.plan_id },
            plan,
            receipt: receipts[index],
        });
    }
    return reviewed;
}

export async function runNativeDocumentCell(session, fixture, profile) {
    const cell = `${fixture.kind}/${profile}`;
    assert.ok(NATIVE_CELLS.includes(cell));
    const contextPath = join(
        session.root,
        `cell-${fixture.kind}-${profile}.json`
    );
    const context = {
        schema_version: 1,
        cell,
        fixture,
        session: {
            root: session.root,
            backend: session.backend,
            policy: session.policy,
            hostNode: session.hostNode,
            cache: session.cache,
            home: session.home,
        },
    };
    await writeFile(contextPath, json(context), { flag: 'wx' });
    const start = performance.now();
    const child = spawnSync(
        session.hostNode,
        [
            '--test',
            '--test-concurrency=1',
            join(
                TOOLS_ROOT,
                'tools/generator-platform/external-document-compilation.test.mjs'
            ),
        ],
        {
            cwd: TOOLS_ROOT,
            env: nativeCellEnvironment(
                session.hostNode,
                fixture.root,
                cell,
                contextPath
            ),
            // Per-command limits remain in runDocumentCli/runConfined. The CI job
            // supplies the 45-minute aggregate bound; do not kill a coordinator
            // mid-command with a second watchdog that cannot reap its children.
            encoding: 'utf8',
            maxBuffer: 8 * 1024 * 1024,
        }
    );
    if (child.status !== 0 || child.signal) {
        // Private laboratory diagnostic; the public report keeps only its hash.
        await writeFile(
            `${contextPath}.failure.txt`,
            `${child.stdout ?? ''}${child.stderr ?? ''}`,
            { flag: 'wx', mode: 0o600 }
        );
    }
    record(session, `EXT03a/${cell}/native-cell`, child, {
        detail:
            child.status !== 0 || child.signal
                ? await readCellFailure(contextPath, cell)
                : '',
    });
    const receiptBytes = await readFile(`${contextPath}.receipt.json`);
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    assert.equal(receipt.cell, cell);
    assert.equal(receipt.native.backend, session.backend);
    // Les appels du runner sont jugés par `assertNativeCellLabels`, contre le
    // plan de la création recalculé par le coordinateur.
    session.lines.push(
        ...receipt.native.report,
        `EXT03a/${cell} receipt_sha256=${hash(receiptBytes)} elapsed_ms=${Math.round(performance.now() - start)}`,
        `EXT03a/${cell} variant=${JSON.stringify(receipt.variant)}; no PWA claim`,
        `EXT03a/${cell} routes=${JSON.stringify(receipt.shell.routes)}`
    );
    await session.save();
    return receipt;
}

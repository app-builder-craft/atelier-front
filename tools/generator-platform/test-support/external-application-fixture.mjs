import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    readlink,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { repositoryRoot } from '../validate-ir.mjs';
import {
    planApplicationWorkspace,
    publishApplicationWorkspace,
} from '../core/application-workspace.mjs';
import { signatureName } from '../core/atelier-signature.mjs';
import { filesUnder } from '../core/application-transaction.mjs';
import {
    pathExists,
    stageGeneratedTree,
} from '../core/external-application-paths.mjs';
import { stableStringify } from '../core/generation-manifest.mjs';
import { writeApplicationDesignFixture } from './application-design-fixture.mjs';

export const TOOLS_ROOT = repositoryRoot;
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Contrôle en cause d'une assertion : son opérateur et le lieu de l'appel
// dans l'atelier (chemin RELATIF à l'atelier, ligne, colonne), lus dans la
// pile. Ce sont des faits du code, jamais des valeurs : le message d'une
// assertion, généré ou non, peut porter des sorties d'enfant ou des valeurs
// comparées et reste écarté (EXT01 v7). Forme FERMÉE, sinon rien : aucun
// chemin hors de l'atelier, aucune dépendance installée, aucun `..`.
const ASSERT_OPERATOR = /^[a-z][A-Za-z]{1,30}$/;
const CODE_LOCATION =
    /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.m?js:\d{1,6}:\d{1,6}$/;
export function assertionControl(error) {
    const operator = ASSERT_OPERATOR.test(error.operator ?? '')
        ? error.operator
        : '';
    const root = `${pathToFileURL(TOOLS_ROOT).href}/`;
    let location = '';
    for (const frame of String(error.stack ?? '').split('\n')) {
        const url = /(file:\/\/[^\s()]+)/.exec(frame)?.[1];
        if (!url?.startsWith(root)) continue;
        const candidate = url.slice(root.length);
        if (
            CODE_LOCATION.test(candidate) &&
            !candidate.split('/').includes('node_modules')
        )
            location = candidate;
        break;
    }
    return [operator && `[${operator}]`, location].filter(Boolean).join(' ');
}

// Forme FERMÉE d'un contrôle en cause (`assertionControl`), revérifiée par un
// lecteur qui la reçoit d'un autre processus : `[opérateur]`, lieu, ou les deux.
export function isProofControl(text) {
    if (typeof text !== 'string' || text.length > 200) return false;
    const parts = text.split(' ');
    if (parts.length > 2 || parts.some((part) => !part)) return false;
    const [first, second] = parts;
    const operator = /^\[([a-z][A-Za-z]{1,30})\]$/.exec(first)?.[1];
    const location = operator ? second : first;
    if (operator && !ASSERT_OPERATOR.test(operator)) return false;
    if (!operator && second !== undefined) return false;
    return (
        location === undefined ||
        (CODE_LOCATION.test(location) &&
            !location.split('/').includes('node_modules'))
    );
}

export function formatProofStop(error) {
    const assertion = error?.code === 'ERR_ASSERTION';
    const name =
        error instanceof Error && typeof error.name === 'string'
            ? error.name
            : 'Error';
    const message =
        error instanceof Error &&
        !assertion &&
        typeof error.message === 'string'
            ? error.message.split(/[\r\n\u0085\u2028\u2029]/u, 1)[0]
            : '';
    const control =
        assertion && error instanceof Error ? assertionControl(error) : '';
    const suffix = '; aucun succès global revendiqué.';
    const detail = stripVTControlCharacters(
        `STOP ${name}${control ? ' ' + control : ''}${message ? ': ' + message : ''}`
    )
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    return detail.slice(0, 400 - suffix.length) + suffix;
}

// Synthetic approved source edge; identities can vary without special treatment.
// Mutations are tested against the unchanged source and qualified edge policy.
export function peerDeviationFixture({
    parent = '@nx/vitest',
    name = 'vitest',
    field = 'peerDependencies',
    optional = true,
} = {}) {
    const requested = '^1.0.0';
    const version = '2.0.0';
    const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
    const parentRecord = [
        parent + '@1.0.0',
        '',
        {
            [field]: { [name]: requested },
            ...(optional ? { optionalPeers: [name] } : {}),
        },
        integrity,
    ];
    const childRecord = [name + '@' + version, '', {}, integrity];
    const lock = {
        lockfileVersion: 1,
        configVersion: 1,
        workspaces: { '': {} },
        packages: { [parent]: parentRecord, [name]: childRecord },
    };
    return {
        lock,
        packages: { [parent]: { version: '1.0.0' } },
        policy: {
            peerDeviations: [
                {
                    parent,
                    identity: parentRecord[0],
                    field,
                    name,
                    requested,
                    resolved: childRecord[0],
                    reason: 'optional-peer',
                    effective_requested: version,
                    parent_sha256: hash(stableStringify(parentRecord)),
                    child_sha256: hash(stableStringify(childRecord)),
                },
            ],
        },
    };
}

export async function schemas() {
    const read = async (name) =>
        JSON.parse(
            await readFile(
                join(
                    TOOLS_ROOT,
                    `tools/generator-platform/schemas/${name}.schema.json`
                ),
                'utf8'
            )
        );
    return {
        applicationDesignSchema: await read('application-design'),
        backendContractSchema: await read('backend-contract'),
    };
}

export async function fixtureParent(t) {
    const parent = await realpath(
        await mkdtemp(join(tmpdir(), signatureName('external-unit-')))
    );
    t.after(() => rm(parent, { recursive: true, force: true }));
    return parent;
}

export function workspaceOptions(
    targetRoot,
    profiles = ['angular-pwa', 'react-spa']
) {
    return {
        workspaceRoot: TOOLS_ROOT,
        targetRoot,
        profiles,
        githubRepository: 'fixture-laboratory/native-shells',
        reviewOwner: 'fixture-reviewer',
    };
}

export async function prepareFixture(t, profiles) {
    const parent = await fixtureParent(t);
    const options = workspaceOptions(join(parent, 'product'), profiles);
    const plan = await planApplicationWorkspace(options);
    await publishApplicationWorkspace({
        ...options,
        expectedPlanId: plan.plan_id,
    });
    return { parent, root: options.targetRoot, options, plan };
}

// Lot 2, commit 3 (V3.3) : forme EXTÉRIEURE d'une conception : version
// 1.3.0, aucune empreinte de contrat (elle vit dans la liaison de l'appli).
export function externalDesign(design) {
    design.schema_version = '1.3.0';
    for (const reference of design.backend_contracts ?? [])
        delete reference.sha256;
    return design;
}

export async function writeExternalDesign(root, sharedSource) {
    const loaded = await schemas();
    const fixture = await writeApplicationDesignFixture(
        root,
        loaded.backendContractSchema,
        'descriptions'
    );
    const design = externalDesign(fixture.design);
    design.design.title = 'Laboratoire des shells natifs';
    design.experiences[0].offline_policy = 'none';
    design.pages[0].title = 'Accueil fictif';
    design.pages[1].title = 'Page réservée fictive';
    if (sharedSource) {
        const path = join(root, sharedSource.path);
        await mkdir(resolve(path, '..'), { recursive: true });
        await writeFile(path, sharedSource.content, { flag: 'wx' });
        design.sources[0].snapshot_uri = sharedSource.path;
        design.sources[0].sha256 = hash(sharedSource.content);
    }
    const designPath = 'descriptions/shells.application-design.json';
    await writeFile(
        join(root, designPath),
        `${JSON.stringify(design, null, 2)}\n`,
        { flag: 'wx' }
    );
    return {
        ...loaded,
        design,
        designPath,
        experienceId: 'citizen-web',
        browserFixture: {
            title: design.design.title,
            publicPath: design.pages[0].path,
            publicTitle: design.pages[0].title,
            protectedPath: design.pages[1].path,
            protectedTitle: design.pages[1].title,
        },
    };
}

/**
 * Metadata-only installation for negative publication/unit tests. These are
 * NOT executable packages and never prove T9/T10/T11/T12/T18. The real gate
 * installs its own packages in runConfined and does not call this function.
 */
export async function installMetadataOnly(plan) {
    for (const [name, metadata] of Object.entries(plan.manifest.packages)) {
        const direct = join(TOOLS_ROOT, 'node_modules', name);
        const source = await realpath(
            (await pathExists(direct))
                ? direct
                : join(TOOLS_ROOT, 'node_modules/.bun/node_modules', name)
        );
        const destination = join(plan.productRoot, 'node_modules', name);
        await mkdir(destination, { recursive: true });
        await writeFile(
            join(destination, 'package.json'),
            await readFile(join(source, 'package.json')),
            { flag: 'wx' }
        );
        for (const bin of Object.values(metadata.bin)) {
            const path = join(destination, bin.path);
            await mkdir(resolve(path, '..'), { recursive: true });
            await writeFile(path, await readFile(join(source, bin.path)), {
                flag: 'wx',
            });
        }
    }
}

export async function shellFixture(t, profile = 'angular-pwa') {
    const fixture = await prepareFixture(t);
    const input = await writeExternalDesign(fixture.root);
    await installMetadataOnly(fixture.plan);
    return {
        ...fixture,
        input,
        shell: {
            workspaceRoot: TOOLS_ROOT,
            targetRoot: fixture.root,
            designPath: input.designPath,
            experienceId: input.experienceId,
            appName:
                profile === 'angular-pwa' ? 'native-angular' : 'native-react',
            profile,
            applicationDesignSchema: input.applicationDesignSchema,
            backendContractSchema: input.backendContractSchema,
        },
    };
}

// Lot 2 : fichiers de la coque d'un plan, relatifs à elle (inventaire et
// plans relatifs au produit).
export const coqueFiles = (plan) =>
    filesUnder(plan.files, `apps/${plan.app_name}`);

// Lot 2 : les trois racines d'un plan de création écrites à leur place, sans
// transaction (état d'une appli déjà créée).
export async function writePlanRoots(plan) {
    await mkdir(join(plan.root, 'libs'), { recursive: true });
    for (const { root, files } of plan.roots)
        await stageGeneratedTree(join(plan.root, root), files);
}

export async function snapshotTree(root, excluded = ['node_modules', '.git']) {
    const found = [];
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (excluded.includes(entry.name)) continue;
            const absolute = join(directory, entry.name);
            const path = relative(root, absolute);
            if (entry.isSymbolicLink())
                found.push([path, 'link', await readlink(absolute)]);
            else if (entry.isDirectory()) {
                found.push([path, 'directory']);
                await visit(absolute);
            } else found.push([path, 'file', hash(await readFile(absolute))]);
        }
    }
    await visit(root);
    return found.sort(([left], [right]) => left.localeCompare(right));
}

export async function baselineRenderer(profile) {
    const file =
        profile === 'angular-pwa'
            ? 'angular-pwa-shell-renderer.mjs'
            : 'react-spa-shell-renderer.mjs';
    const source = execFileSync(
        'git',
        [
            '--no-optional-locks',
            'show',
            `3f5922287a6bda7c477e9b304136f14b9ae4c177:tools/generator-platform/renderers/${file}`,
        ],
        { cwd: TOOLS_ROOT, encoding: 'utf8' }
    );
    const canonical = new URL(
        '../core/canonicalize-generated.mjs',
        import.meta.url
    ).href;
    const rewritten = source.replace(
        "'../core/canonicalize-generated.mjs'",
        JSON.stringify(canonical)
    );
    return import(
        `data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`
    );
}

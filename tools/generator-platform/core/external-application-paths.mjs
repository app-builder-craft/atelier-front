import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    realpath,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    relative,
    resolve,
    sep,
} from 'node:path';

import {
    escapeRegExp,
    SIGNATURE,
    SIGNATURE_FILES,
} from './atelier-signature.mjs';
import { sha256, stableStringify } from './generation-manifest.mjs';
import { syncTreeDirectories } from './generation-transaction.mjs';
import { PREFIX_PATTERN, productForms } from './product-identity.mjs';
import { LIBS_ROOT } from './socle-names.mjs';

export function externalFailure(code) {
    throw new Error(`external application: ${code}`);
}

// Lot 2 (conception v3, V3.1) : SOURCE UNIQUE des racines réservées d'un
// produit. Les espaces de produit (`apps`, `libs`) n'appartiennent qu'à
// l'atelier ; les racines d'exécution sont celles des outils natifs ; le
// dossier de signature porte les marqueurs. Aucune garde n'en tient une copie.
export const PRODUCT_SPACES = Object.freeze(['apps', LIBS_ROOT]);
export const RUNTIME_ROOTS = Object.freeze([
    'node_modules',
    '.git',
    '.nx',
    '.angular',
    'dist',
    'coverage',
    'tmp',
]);
export const PRODUCT_RESERVED_ROOTS = Object.freeze([
    ...PRODUCT_SPACES,
    SIGNATURE.dir,
    ...RUNTIME_ROOTS,
]);
const RESERVED_ROOT_SET = new Set(PRODUCT_RESERVED_ROOTS);

/** Premier segment d'un chemin relatif au produit pris dans une racine réservée. */
export const isReservedProductPath = (path) =>
    RESERVED_ROOT_SET.has(String(path).split('/')[0]);

export async function pathExists(path) {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

export function isWithin(root, path) {
    const child = relative(root, path);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`));
}

export function safeRelativePath(path) {
    if (
        typeof path !== 'string' ||
        !/^[a-zA-Z0-9._/-]+$/.test(path) ||
        isAbsolute(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
        externalFailure('unsafe relative path');
    }
    return path;
}

export async function assertPhysicalPath(path, { missing = false } = {}) {
    const absolute = resolve(path);
    let current = sep;
    let existing = sep;
    let absent = false;
    for (const part of absolute.split(sep).filter(Boolean)) {
        current = resolve(current, part);
        if (absent) continue;
        try {
            const metadata = await lstat(current);
            if (metadata.isSymbolicLink()) externalFailure('symbolic path');
            if (current !== absolute && !metadata.isDirectory())
                externalFailure('non-directory ancestor');
            existing = current;
        } catch (error) {
            if (missing && error.code === 'ENOENT') absent = true;
            else throw error;
        }
    }
    if ((await realpath(existing)) !== existing)
        externalFailure('non-canonical physical path');
    return absolute;
}

// Lot 2 (conception v4, §V4.6 point 1) : contrôle UNIQUE de toute référence
// qu'un auteur lit ou écrit, et de tout chemin de fermeture des sources d'une
// appli. Chemin relatif sûr (ni absolu, ni segment vide, `.` ou `..`, ni
// caractère hors liste), hors de toute racine réservée, puis physique : ni
// lien symbolique, ni ancêtre qui ne soit pas un dossier, ni chemin réel
// différent. `missing` admet un fichier encore absent (sortie à écrire) ;
// `label` nomme la référence dans le refus (« document » pour un auteur).
export async function assertSourcePath(
    root,
    path,
    { missing = false, label = 'source' } = {}
) {
    safeRelativePath(path);
    if (isReservedProductPath(path))
        externalFailure(
            `${label} collides with a reserved workspace namespace`
        );
    await assertPhysicalPath(resolve(root, path), { missing });
    return path;
}

// Version du manifeste d'espace : 1.1.0 depuis que le préfixe du produit
// (`identity.prefix`) y est un champ déclaré, requis par un schéma fermé.
export const WORKSPACE_MANIFEST_VERSION = '1.1.0';

async function ownedGitRoot(root) {
    try {
        const path = resolve(root, SIGNATURE_FILES.workspaceManifest);
        await assertPhysicalPath(path);
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        const { workspace_id: workspaceId, ...identity } = manifest;
        return (
            manifest.kind === 'application-workspace-manifest' &&
            manifest.schema_version === WORKSPACE_MANIFEST_VERSION &&
            /^[a-f0-9]{64}$/.test(workspaceId ?? '') &&
            workspaceId === sha256(stableStringify(identity))
        );
    } catch {
        return false;
    }
}

async function knownRepositoryRoots(toolsRoot) {
    const roots = new Set([toolsRoot]);
    const listed = execFileSync(
        'git',
        [
            '--no-optional-locks',
            '-C',
            toolsRoot,
            'worktree',
            'list',
            '--porcelain',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    for (const line of listed.split('\n')) {
        if (line.startsWith('worktree '))
            roots.add(await realpath(line.slice('worktree '.length)));
    }
    // The principal and sibling clones have independent Git metadata.
    for (const entry of await readdir(dirname(toolsRoot), {
        withFileTypes: true,
    })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const sibling = resolve(dirname(toolsRoot), entry.name);
        if (await pathExists(resolve(sibling, '.git'))) roots.add(sibling);
    }
    return [...roots];
}

export async function externalApplicationContext({
    workspaceRoot,
    targetRoot,
}) {
    if (
        typeof targetRoot !== 'string' ||
        !isAbsolute(targetRoot) ||
        targetRoot !== resolve(targetRoot) ||
        targetRoot === sep
    ) {
        externalFailure('canonical absolute target-root required');
    }
    const toolsRoot = await realpath(resolve(workspaceRoot));
    await assertPhysicalPath(toolsRoot);
    const productRoot = await assertPhysicalPath(targetRoot, { missing: true });
    // No marker can grant ownership of the active tools or their ancestors
    // and descendants. This refusal precedes the owned-product exception.
    if (isWithin(toolsRoot, productRoot) || isWithin(productRoot, toolsRoot))
        externalFailure('target overlaps the active workshop');
    const parent = dirname(productRoot);
    await assertPhysicalPath(parent);
    if (!(await lstat(parent)).isDirectory())
        externalFailure('existing target parent required');
    const ownsGit = await ownedGitRoot(productRoot);
    for (const protectedRoot of await knownRepositoryRoots(toolsRoot)) {
        if (protectedRoot === productRoot && ownsGit) continue;
        if (
            isWithin(protectedRoot, productRoot) ||
            isWithin(productRoot, protectedRoot)
        )
            externalFailure('target overlaps a repository or worktree');
    }
    for (let current = productRoot; ; current = dirname(current)) {
        if (await pathExists(resolve(current, '.git'))) {
            if (current !== productRoot || !ownsGit)
                externalFailure('target nested in an existing Git repository');
        }
        if (current === sep) break;
    }
    if (await pathExists(productRoot)) {
        if (!(await lstat(productRoot)).isDirectory())
            externalFailure('target must be a directory');
    }
    return { toolsRoot, productRoot };
}

export async function readProductFile(root, path) {
    const absolute = resolve(root, safeRelativePath(path));
    if (!isWithin(root, absolute) || absolute === root)
        externalFailure('file escapes product');
    await assertPhysicalPath(absolute);
    if (!(await lstat(absolute)).isFile())
        externalFailure('regular file required');
    const handle = await open(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
        if (!(await handle.stat()).isFile())
            externalFailure('regular file required');
        const content = await handle.readFile();
        if ((await realpath(absolute)) !== absolute)
            externalFailure('file changed its physical path');
        return content;
    } finally {
        await handle.close();
    }
}

export async function treeInventory(root) {
    await assertPhysicalPath(root);
    const result = [];
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const absolute = resolve(directory, entry.name);
            const path = relative(root, absolute).split(sep).join('/');
            safeRelativePath(path);
            if (entry.isSymbolicLink())
                externalFailure('symbolic generated entry');
            if (entry.isDirectory()) await visit(absolute);
            else if (entry.isFile()) {
                const content = await readProductFile(root, path);
                result.push({
                    path,
                    bytes: content.length,
                    sha256: sha256(content),
                });
            } else externalFailure('special generated entry');
        }
    }
    await visit(root);
    return result.sort((left, right) => left.path.localeCompare(right.path));
}

export function fileArtifacts(files) {
    return Object.entries(files)
        .map(([path, content]) => ({
            path: safeRelativePath(path),
            bytes: Buffer.byteLength(content),
            sha256: sha256(content),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
}

export async function verifyGeneratedTree(
    root,
    files,
    { partial = false, directories = [] } = {}
) {
    const expected = new Map(
        fileArtifacts(files).map((entry) => [entry.path, entry])
    );
    const declaredDirectories = new Set(directories.map(safeRelativePath));
    const actual = await treeInventory(root);
    if (!partial && actual.length !== expected.size)
        externalFailure('generated inventory drift');
    for (const entry of actual) {
        const wanted = expected.get(entry.path);
        if (
            !wanted ||
            entry.bytes !== wanted.bytes ||
            entry.sha256 !== wanted.sha256
        )
            externalFailure('generated file drift');
    }
    // Empty foreign directories must not acquire ownership either.
    async function visitDirectories(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const absolute = resolve(directory, entry.name);
            const prefix = `${relative(root, absolute).split(sep).join('/')}/`;
            if (
                !declaredDirectories.has(prefix.slice(0, -1)) &&
                ![...expected.keys(), ...declaredDirectories].some((path) =>
                    path.startsWith(prefix)
                )
            )
                externalFailure('unowned generated directory');
            await visitDirectories(absolute);
        }
    }
    await visitDirectories(root);
    if (!partial) {
        for (const path of declaredDirectories) {
            const absolute = await assertPhysicalPath(resolve(root, path));
            if (!(await lstat(absolute)).isDirectory())
                externalFailure('declared directory missing');
        }
    }
}

// X4-config : seul le script de validation du relais est exécutable (l'image
// nginx ignore un .envsh non exécutable) ; tout autre fichier possédé est écrit
// en 0644. Son nom dérive du préfixe du produit : une seule forme, écrite ici.
const relayEnvshFor = (stem) =>
    `deploy/nginx/docker-entrypoint.d/15-${stem}-upstreams.envsh`;
export const relayEnvshPath = (prefix) =>
    relayEnvshFor(productForms(prefix).prefix);
const STEM = '\u0000';
const EXECUTABLE_OWNED = new RegExp(
    `(?:^|/)${escapeRegExp(relayEnvshFor(STEM)).replace(
        STEM,
        PREFIX_PATTERN.source.slice(1, -1)
    )}$`
);
export const ownedFileMode = (path) =>
    EXECUTABLE_OWNED.test(path) ? 0o755 : 0o644;

// X4-config : les fichiers de configuration locale vivent hors du produit.
// Leur présence sous la racine est refusée, indépendamment de Git.
const LOCAL_CONFIGURATION = /^(?:\.env(?:\..*)?|proxy\.local\.json)$/;

export async function assertNoLocalConfiguration(productRoot) {
    const found = [];
    for (const name of await readdir(productRoot))
        if (LOCAL_CONFIGURATION.test(name)) found.push(name);
    const apps = resolve(productRoot, 'apps');
    if (await pathExists(apps))
        for (const entry of await readdir(apps, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            for (const name of await readdir(resolve(apps, entry.name)))
                if (LOCAL_CONFIGURATION.test(name))
                    found.push(`apps/${entry.name}/${name}`);
        }
    if (found.length)
        externalFailure(
            `local configuration file inside the product: ${found.sort()[0]}`
        );
}

export async function stageGeneratedTree(
    root,
    files,
    { directories = [] } = {}
) {
    fileArtifacts(files);
    directories.forEach(safeRelativePath);
    await assertPhysicalPath(dirname(root));
    if (await pathExists(root)) {
        await verifyGeneratedTree(root, files, { partial: true, directories });
    } else {
        await mkdir(root, { mode: 0o700 });
    }
    for (const [path, content] of Object.entries(files).sort(([a], [b]) =>
        a.localeCompare(b)
    )) {
        const absolute = resolve(root, safeRelativePath(path));
        if (await pathExists(absolute)) continue;
        await assertPhysicalPath(dirname(absolute), { missing: true });
        await mkdir(dirname(absolute), { recursive: true });
        await assertPhysicalPath(dirname(absolute));
        const mode = ownedFileMode(path);
        const handle = await open(absolute, 'wx', mode);
        try {
            await handle.writeFile(content);
            await handle.chmod(mode);
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
    for (const path of directories) {
        const absolute = resolve(root, path);
        await assertPhysicalPath(absolute, { missing: true });
        await mkdir(absolute, { recursive: true });
    }
    await syncTreeDirectories(root);
    await verifyGeneratedTree(root, files, { directories });
}

export async function assertSourceWeight(root) {
    const excluded = new Set([
        '.git',
        'node_modules',
        '.nx',
        '.angular',
        'dist',
        'coverage',
        'tmp',
    ]);
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink())
                externalFailure('symbolic source entry');
            const absolute = resolve(directory, entry.name);
            if (entry.isDirectory()) {
                if (!excluded.has(entry.name)) await visit(absolute);
            } else if (
                entry.isFile() &&
                /\.(?:[cm]?[jt]s|jsx|tsx|html|scss|css)$/.test(entry.name)
            ) {
                const content = await readFile(absolute);
                const lines =
                    content.toString('utf8').split('\n').length -
                    (content.at(-1) === 10 ? 1 : 0);
                if (content.length > 1024 * 1024 || lines > 800)
                    externalFailure(
                        `source weight: ${relative(root, absolute)}`
                    );
            }
        }
    }
    await visit(root);
}

export function workspaceCandidate(root, planId) {
    return resolve(
        dirname(root),
        `.${basename(root)}.workspace-candidate-${planId}`
    );
}

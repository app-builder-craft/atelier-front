import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

import { validateApplicationDesignWithDependencies } from './application-design.mjs';
import {
    documentPlan,
    publishDocument,
    reviewedDocumentPlan,
} from './document-publication.mjs';
import {
    assertCompilationPaths,
    beginCompilationContext,
    bindCompilationContext,
    publicCompilationContext,
    publishCompilationWithContext,
} from './compilation-context.mjs';
import { assertNoProductDesignPrefix } from './product-prefix.mjs';
import { resolveDesignDigests } from './application-sources.mjs';
import {
    assertSourcePath,
    readProductFile,
} from './external-application-paths.mjs';
import { parseStructuredSource } from './source-document.mjs';

function fail(message) {
    throw new Error(`application design publication: ${message}`);
}

function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.keys(value)
            .sort()
            .map((key) => [key, canonicalize(value[key])])
    );
}

function assertInside(root, absolute, label) {
    if (absolute === root || !absolute.startsWith(`${root}${sep}`))
        fail(`${label} must be a file inside the workspace`);
}

// Lot 2, commit 6a (A-7) : un composant absent est un refus NOMMÉ, par son
// chemin RELATIF au produit, jamais un `ENOENT` brut ni un chemin local.
async function assertComponents(root, absolute, includeLeaf) {
    const parts = relative(root, absolute).split(sep).filter(Boolean);
    const limit = includeLeaf ? parts.length : parts.length - 1;
    let current = root;
    for (let index = 0; index < limit; index += 1) {
        current = resolve(current, parts[index]);
        const shown = relative(root, current).split(sep).join('/');
        let metadata;
        try {
            metadata = await lstat(current);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            fail(
                includeLeaf
                    ? `source missing: ${shown}`
                    : `output parent directory missing: ${shown}`
            );
        }
        if (metadata.isSymbolicLink())
            fail(`symbolic path component forbidden: ${current}`);
        if (index < limit - 1 && !metadata.isDirectory())
            fail(`non-directory path component: ${current}`);
    }
}

async function sourceFile(root, path) {
    const absolute = resolve(root, path);
    assertInside(root, absolute, 'source');
    await assertComponents(root, absolute, true);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink())
        fail('source must be a regular non-symlink file');
    const content = await readFile(absolute);
    return {
        absolute,
        relative: relative(root, absolute).split(sep).join('/'),
        content,
        design: parseStructuredSource(content, 'application design source'),
    };
}

async function outputFile(root, path) {
    const absolute = resolve(root, path);
    assertInside(root, absolute, 'output');
    await assertComponents(root, absolute, false);
    const parent = dirname(absolute);
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        fail('output parent must be a regular directory');
    const canonicalParent = await realpath(parent);
    const canonicalOutput = resolve(canonicalParent, basename(absolute));
    assertInside(root, canonicalOutput, 'canonical output');
    return {
        absolute,
        parent,
        relative: relative(root, absolute).split(sep).join('/'),
    };
}

export async function planApplicationDesignPublication({
    workspaceRoot,
    targetRoot,
    sourcePath,
    outputPath,
    applicationDesignSchema,
    backendContractSchema,
}) {
    const context = await beginCompilationContext({
        workspaceRoot,
        targetRoot,
    });
    await assertCompilationPaths(context, sourcePath, outputPath);
    const root =
        context?.productRoot ?? (await realpath(resolve(workspaceRoot)));
    const source = await sourceFile(root, sourcePath);
    const output = await outputFile(root, outputPath);
    // Lot 2, commit 3 (V3.3) : empreintes de contrat résolues UNE fois, à
    // l'entrée ; interne : déclarées ; extérieur : lues dans les octets (la
    // conception compilée est la PROCHAINE valeur d'une source, liée ensuite
    // par la mise à jour).
    const { design: resolved } = await resolveDesignDigests(source.design, {
        mode: context ? 'external' : 'internal',
        read: async (path) => {
            await assertSourcePath(root, path, { label: 'document' });
            return readProductFile(root, path);
        },
    });
    const compilationContext = await bindCompilationContext(context, {
        kind: 'design',
        sourcePath,
        sourceContent: source.content,
        outputPath,
        document: resolved,
        schemas: {
            'application-design': applicationDesignSchema,
            'backend-contract': backendContractSchema,
        },
    });
    const errors = await validateApplicationDesignWithDependencies({
        design: resolved,
        applicationDesignSchema,
        backendContractSchema,
        workspaceRoot: root,
    });
    if (errors.length > 0) fail(`design rejected:\n${errors.join('\n')}`);
    // Produit extérieur : le préfixe est scellé dans l'espace ; une conception
    // qui en déclare un est refusée dès la compilation, avec le refus nommé
    // de la création de coque.
    if (context) assertNoProductDesignPrefix(source.design);
    const content = Buffer.from(
        `${JSON.stringify(canonicalize(source.design), null, 2)}\n`
    );
    const sourceHash = sha256(source.content);
    const outputHash = sha256(content);
    const identity = await documentPlan(
        {
            source: source.relative,
            source_sha256: sourceHash,
            output: output.relative,
            output_sha256: outputHash,
            ...(compilationContext
                ? { compilation_context_sha256: compilationContext.sha256 }
                : {}),
        },
        output,
        fail
    );
    return {
        ...identity,
        ...(compilationContext
            ? { compilation_context: compilationContext }
            : {}),
        source: source.relative,
        source_sha256: sourceHash,
        output: output.relative,
        output_sha256: outputHash,
        content,
        design: source.design,
    };
}

export async function publishApplicationDesign(options) {
    const plan = reviewedDocumentPlan(
        await planApplicationDesignPublication(options),
        options.planId,
        fail
    );
    return publishCompilationWithContext(
        options,
        plan,
        planApplicationDesignPublication,
        publishDocument,
        fail
    );
}

export function publicApplicationDesignPlan(plan) {
    return {
        ...publicCompilationContext(plan),
        plan_id: plan.plan_id,
        source: plan.source,
        source_sha256: plan.source_sha256,
        output: plan.output,
        output_sha256: plan.output_sha256,
        output_before_sha256: plan.output_before_sha256,
    };
}

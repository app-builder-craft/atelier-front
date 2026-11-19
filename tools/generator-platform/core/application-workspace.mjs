import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { repositoryRoot, validateJsonSchema } from '../validate-ir.mjs';
import { renderAngularPwaShell } from '../renderers/angular-pwa-shell-renderer.mjs';
import { renderReactSpaShell } from '../renderers/react-spa-shell-renderer.mjs';
import {
    EXTERNAL_WORKSPACE_CMZ,
    renderApplicationWorkspace,
} from '../renderers/application-workspace-renderer.mjs';
import { nxConfinementEnvironment } from '../../library-setup/sandbox.mjs';
import { validateApplicationDesignWithDependencies } from './application-design.mjs';
import { SIGNATURE_FILES } from './atelier-signature.mjs';
import { canonicalizeGeneratedFiles } from './canonicalize-generated.mjs';
import { runConfinedProductCommand } from './external-product-confinement.mjs';
import {
    assertSealedPrefix,
    resolveWorkspacePrefix,
} from './product-prefix.mjs';
import {
    assertPhysicalPath,
    assertSourceWeight,
    externalApplicationContext,
    externalFailure,
    fileArtifacts,
    pathExists,
    readProductFile,
    stageGeneratedTree,
    verifyGeneratedTree,
    workspaceCandidate,
    WORKSPACE_MANIFEST_VERSION,
} from './external-application-paths.mjs';
import { sha256, stableStringify } from './generation-manifest.mjs';
import { sealShellManifest } from './application-ownership.mjs';
import {
    inputFilePath,
    ownedFiles,
    ownedProductContext,
    productInputClosure,
    verifyWorkspaceRoot,
} from './application-workspace-root.mjs';
import {
    commitDirectoryTransaction,
    withProductWriterLocks,
} from './generation-transaction.mjs';

import {
    projectProductLock,
    qualifyProductInstallation,
    sourceProvenance,
    sourceToolchain,
} from './application-workspace-toolchain.mjs';
export {
    productDependencyClosure,
    qualifyProductInstallation,
} from './application-workspace-toolchain.mjs';

const MANIFEST = EXTERNAL_WORKSPACE_CMZ.manifest;
function normalizeWorkspaceOptions(options) {
    if (
        !Array.isArray(options.profiles) ||
        !options.profiles.length ||
        new Set(options.profiles).size !== options.profiles.length ||
        options.profiles.some(
            (profile) => !['angular-pwa', 'react-spa'].includes(profile)
        )
    )
        externalFailure('explicit unique profiles required');
    if (
        !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(
            options.githubRepository ?? ''
        ) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(options.reviewOwner ?? '')
    )
        externalFailure('GitHub repository and review owner required');
    return [...options.profiles].sort();
}

async function manifestSchema(toolsRoot) {
    return JSON.parse(
        (
            await readProductFile(
                toolsRoot,
                'tools/generator-platform/schemas/application-workspace-manifest.schema.json'
            )
        ).toString('utf8')
    );
}

async function workspaceSnapshot(context, options, profiles) {
    const marker = resolve(context.productRoot, MANIFEST);
    if (!(await pathExists(marker)))
        externalFailure('workspace ownership drift');
    const bytes = await readProductFile(context.productRoot, MANIFEST);
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (
        validateJsonSchema(manifest, await manifestSchema(context.toolsRoot))
            .length
    )
        externalFailure('workspace ownership drift');
    const { workspace_id: identity, ...fields } = manifest;
    if (
        identity !== workspaceId(fields) ||
        stableStringify(profiles) !== stableStringify(manifest.profiles) ||
        options.githubRepository !== manifest.github_repository ||
        options.reviewOwner !== manifest.review_owner
    )
        externalFailure('workspace ownership drift');
    // Préfixe scellé : une préparation qui en déclare un autre est refusée.
    if (
        options.prefix !== undefined &&
        options.prefix !== manifest.identity.prefix
    )
        externalFailure(
            'PRODUCT_PREFIX_SEALED: change it with rename-product-prefix'
        );
    const files = await ownedFiles(context.productRoot, manifest.files);
    files[MANIFEST] = bytes.toString('utf8');
    files['bun.lock'] = (
        await readProductFile(context.productRoot, 'bun.lock')
    ).toString('utf8');
    return { files, manifest };
}

// Public workspace creation and shell generation retain strict ownership.
// `internal.recoveringApp` est réservé à la reprise sous verrou d'une
// publication (application-publication.mjs) ; ce n'est pas une option publique.
// Identifiant de l'espace produit : empreinte de ses champs déclarés.
export function workspaceId(fields) {
    return sha256(stableStringify(fields));
}

// `plan_id` de l'espace : chemins, identifiant, provenance du générateur et
// fichiers. Exporté pour le recalcul des paliers du lot MARQUE.
export function workspacePlanId({
    toolsRoot,
    productRoot,
    workspaceId: id,
    provenance,
    files,
}) {
    return sha256(
        stableStringify({
            tools_root: toolsRoot,
            target_root: productRoot,
            workspace_id: id,
            provenance,
            files: fileArtifacts(files),
        })
    );
}

export async function planApplicationWorkspace(options, internal = {}) {
    return planWorkspace(options, false, internal);
}

// Compilation only: neighbours may be sources without becoming dependencies.
export async function planCompilationWorkspace(options) {
    return planWorkspace(options, true);
}

async function planWorkspace(options, documentSources, internal = {}) {
    const profiles = normalizeWorkspaceOptions(options);
    const context = await externalApplicationContext({
        workspaceRoot: options.workspaceRoot ?? repositoryRoot,
        targetRoot: options.targetRoot,
    });
    const provenance = await sourceProvenance(context.toolsRoot);
    let snapshot;
    let identity;
    if (await pathExists(context.productRoot)) {
        snapshot = await workspaceSnapshot(context, options, profiles);
        identity = {
            prefix: snapshot.manifest.identity.prefix,
            provenance: 'scellé dans l’espace',
        };
    } else {
        // Préfixe du produit : déclaré par `--prefix`, ou proposé par les
        // initiales du nom du dépôt ; refus nommé sinon.
        identity = await resolveWorkspacePrefix({
            toolsRoot: context.toolsRoot,
            declared: options.prefix,
            githubRepository: options.githubRepository,
        });
        const toolchain = await sourceToolchain(context.toolsRoot, profiles);
        const files = await renderApplicationWorkspace({
            ...options,
            ...toolchain,
            profiles,
        });
        const fields = {
            schema_version: WORKSPACE_MANIFEST_VERSION,
            kind: 'application-workspace-manifest',
            profiles,
            github_repository: options.githubRepository,
            review_owner: options.reviewOwner,
            identity: { prefix: identity.prefix },
            quality_profile: 'production',
            qualification: 'pending',
            packages: toolchain.packages,
            overrides: toolchain.overrides,
            dependency_closure_sha256: toolchain.dependencyClosureSha256,
            files: fileArtifacts(files),
            dependency_deviations: toolchain.dependencyDeviations,
            directories: ['apps', 'descriptions'],
        };
        const manifest = {
            ...fields,
            workspace_id: workspaceId(fields),
        };
        if (
            validateJsonSchema(
                manifest,
                await manifestSchema(context.toolsRoot)
            ).length
        )
            externalFailure('workspace manifest schema');
        Object.assign(
            files,
            await canonicalizeGeneratedFiles({
                [MANIFEST]: JSON.stringify(manifest, null, 2) + '\n',
            })
        );
        files['bun.lock'] = projectProductLock(
            JSON.parse(files['package.json']),
            toolchain
        );
        snapshot = { files, manifest };
    }
    const planId = workspacePlanId({
        toolsRoot: context.toolsRoot,
        productRoot: context.productRoot,
        workspaceId: snapshot.manifest.workspace_id,
        provenance,
        files: snapshot.files,
    });
    const plan = {
        ...context,
        ...snapshot,
        profiles,
        provenance,
        identity,
        plan_id: planId,
        inputPaths: options.inputPaths ?? [],
        output: context.productRoot,
        candidate: workspaceCandidate(context.productRoot, planId),
        recoveringApp: internal.recoveringApp,
        // Réservé au renommage du préfixe et à sa reprise (plan_id du
        // renommage) : ses arbres de travail et son journal sont tolérés.
        renaming: internal.renaming,
    };
    if (await pathExists(context.productRoot))
        await verifyWorkspaceRoot(plan, documentSources);
    return plan;
}

export function publicApplicationWorkspacePlan(plan) {
    return {
        schema_version: '1.0.0',
        plan_id: plan.plan_id,
        tools_root: plan.toolsRoot,
        target_root: plan.productRoot,
        profiles: plan.profiles,
        packages: plan.manifest.packages,
        provenance: plan.provenance,
        overrides: plan.manifest.overrides,
        dependency_closure_sha256: plan.manifest.dependency_closure_sha256,
        dependency_deviations: plan.manifest.dependency_deviations,
        github_repository: plan.manifest.github_repository,
        review_owner: plan.manifest.review_owner,
        // Préfixe effectif du produit et sa provenance (déclaré, proposé par
        // les initiales du nom du dépôt, ou scellé) ; il entre dans le plan_id.
        identity: plan.identity,
        files: fileArtifacts(plan.files),
        qualification: 'pending',
        directories: plan.manifest.directories,
    };
}

export async function publishApplicationWorkspace(options) {
    const initial = await planApplicationWorkspace(options);
    if (
        !/^[a-f0-9]{64}$/.test(options.expectedPlanId ?? '') ||
        initial.plan_id !== options.expectedPlanId
    )
        externalFailure('reviewed workspace plan required or stale');
    return withProductWriterLocks(initial.productRoot, [], async () => {
        const plan = await planApplicationWorkspace(options);
        if (plan.plan_id !== initial.plan_id)
            externalFailure('workspace changed under lock');
        let recovered = true;
        if (!(await pathExists(plan.productRoot))) {
            await stageGeneratedTree(plan.candidate, plan.files, {
                directories: plan.manifest.directories,
            });
            await externalApplicationContext({
                workspaceRoot: plan.toolsRoot,
                targetRoot: plan.productRoot,
            });
            await commitDirectoryTransaction({
                outputRoot: plan.productRoot,
                candidateRoot: plan.candidate,
                expectedState: 'absent',
            });
            recovered = false;
        }
        await verifyWorkspaceRoot(plan);
        return {
            ...publicApplicationWorkspacePlan(plan),
            status: 'prepared',
            recovered,
        };
    });
}

export async function readOwnedWorkspace(options, internal = {}) {
    const context = await ownedProductContext(
        {
            workspaceRoot: options.workspaceRoot ?? repositoryRoot,
            targetRoot: options.targetRoot,
        },
        internal
    );
    const manifest = JSON.parse(
        (await readProductFile(context.productRoot, MANIFEST)).toString('utf8')
    );
    if (
        validateJsonSchema(manifest, await manifestSchema(context.toolsRoot))
            .length
    )
        externalFailure('workspace marker is invalid');
    let inputPaths = [];
    if (options.designPath) {
        inputFilePath(options.designPath);
        const design = JSON.parse(
            (
                await readProductFile(context.productRoot, options.designPath)
            ).toString('utf8')
        );
        inputPaths = (
            await productInputClosure(
                context.productRoot,
                options.designPath,
                design
            )
        ).map((entry) => entry.path);
    }
    return planApplicationWorkspace(
        {
            workspaceRoot: context.toolsRoot,
            targetRoot: context.productRoot,
            profiles: manifest.profiles,
            githubRepository: manifest.github_repository,
            reviewOwner: manifest.review_owner,
            prefix: manifest.identity.prefix,
            inputPaths,
        },
        internal
    );
}

async function renderProductShell(options) {
    const {
        productRoot,
        toolsRoot,
        appName,
        designPath,
        experienceId,
        profile,
    } = options;
    if (!/^[a-z][a-z0-9-]*$/.test(appName ?? ''))
        externalFailure('invalid app name');
    if (!['angular-pwa', 'react-spa'].includes(profile))
        externalFailure('unsupported shell profile');
    inputFilePath(designPath);
    const designBytes = await readProductFile(productRoot, designPath);
    const design = JSON.parse(designBytes.toString('utf8'));
    const loadSchema = async (name) =>
        JSON.parse(
            (
                await readProductFile(
                    toolsRoot,
                    `tools/generator-platform/schemas/${name}.schema.json`
                )
            ).toString('utf8')
        );
    const errors = await validateApplicationDesignWithDependencies({
        design,
        workspaceRoot: productRoot,
        applicationDesignSchema:
            options.applicationDesignSchema ??
            (await loadSchema('application-design')),
        backendContractSchema:
            options.backendContractSchema ??
            (await loadSchema('backend-contract')),
    });
    if (errors.length) externalFailure('product application-design rejected');
    // Le préfixe scellé de l'espace vaut ; une conception qui en déclare un
    // est refusée (une seule source).
    const prefix = assertSealedPrefix(design, options.prefix);
    const inputs = await productInputClosure(productRoot, designPath, design);
    const render =
        profile === 'angular-pwa' ? renderAngularPwaShell : renderReactSpaShell;
    const rendered = await render({
        design,
        experienceId,
        appName,
        designPath,
        designSha256: sha256(designBytes),
        externalWorkspace: true,
        prefix,
    });
    return { ...rendered, inputs, designSha256: sha256(designBytes) };
}

// Renommage du préfixe (lot MARQUE, commit 3) : la coque d'une appli
// existante, rendue depuis ses entrées scellées (conception, expérience, nom,
// profil) avec un préfixe donné. Mêmes entrées que create-app, sans plan.
export async function renderExternalShellFiles(workspace, manifest, prefix) {
    return (
        await renderProductShell({
            productRoot: workspace.productRoot,
            toolsRoot: workspace.toolsRoot,
            appName: manifest.app_name,
            designPath: manifest.design_ref?.path,
            experienceId: manifest.experience_id,
            profile: manifest.profile,
            prefix,
        })
    ).files;
}

// Manifeste d'espace avec un autre préfixe : mêmes champs dans le même ordre,
// `identity.prefix` changé, `workspace_id` recalculé, texte canonique comme à
// la préparation de l'espace.
export async function renamedWorkspaceManifest(manifest, prefix) {
    const { workspace_id: _id, ...fields } = manifest;
    void _id;
    const renamed = { ...fields, identity: { ...fields.identity, prefix } };
    const next = { ...renamed, workspace_id: workspaceId(renamed) };
    const text = (
        await canonicalizeGeneratedFiles({
            [MANIFEST]: JSON.stringify(next, null, 2) + '\n',
        })
    )[MANIFEST];
    return { manifest: next, text };
}

export async function planExternalApplicationShell(options) {
    const workspace = await readOwnedWorkspace(options);
    const profile = options.profile ?? 'angular-pwa';
    if (!workspace.profiles.includes(profile))
        externalFailure('profile absent from workspace plan');
    const installation = await qualifyProductInstallation(workspace);
    const rendered = await renderProductShell({
        ...workspace,
        ...options,
        profile,
        prefix: workspace.manifest.identity.prefix,
    });
    // ADR-0103 : le manifeste de la coque extérieure naît scellé au produit.
    const manifestPath = `apps/${options.appName}/${SIGNATURE_FILES.appManifest}`;
    const sealed = sealShellManifest(
        JSON.parse(rendered.files[SIGNATURE_FILES.appManifest]),
        workspace.manifest.workspace_id
    );
    rendered.files[SIGNATURE_FILES.appManifest] = (
        await canonicalizeGeneratedFiles({
            [manifestPath]: JSON.stringify(sealed, null, 2) + '\n',
        })
    )[manifestPath];
    const treeSha = sha256(stableStringify(fileArtifacts(rendered.files)));
    const binding = {
        tools_root: workspace.toolsRoot,
        target_root: workspace.productRoot,
        workspace_plan_id: workspace.plan_id,
        provenance: workspace.provenance,
        workspace_manifest_sha256: sha256(workspace.files[MANIFEST]),
        lock_sha256: installation.lock_sha256,
        installed: installation.metadata,
        inputs: rendered.inputs,
        tree_sha256: treeSha,
        app_name: options.appName,
        experience_id: options.experienceId,
        design: options.designPath,
        profile,
    };
    const planId = sha256(stableStringify(binding));
    return {
        plan_id: planId,
        app_name: options.appName,
        profile,
        design: options.designPath,
        design_sha256: rendered.designSha256,
        experience_id: options.experienceId,
        output: `apps/${options.appName}`,
        outputAbsolute: resolve(workspace.productRoot, 'apps', options.appName),
        candidate: resolve(
            workspace.productRoot,
            'apps',
            `.${options.appName}.external-candidate-${planId}`
        ),
        root: workspace.productRoot,
        toolsRoot: workspace.toolsRoot,
        tree_sha256: treeSha,
        // Préfixe du produit, lu dans l'espace : affiché au `--dry-run`.
        identity: {
            prefix: workspace.manifest.identity.prefix,
            provenance: 'scellé dans l’espace',
        },
        files: rendered.files,
        external_workspace: binding,
        compiler: profile === 'angular-pwa' ? 'ngc' : 'tsc',
        compiler_validation:
            profile === 'angular-pwa' ? 'angular-ngc' : 'typescript-tsc',
        workspace,
        installation,
    };
}

// X4-sécurité : chaque commande du produit tourne confinée (aucun réseau,
// aucune lecture hors du produit, environnement propre).
export async function runExternalApplicationCommand(
    command,
    args,
    root,
    options = {}
) {
    const confinement = nxConfinementEnvironment(root);
    const temporary = resolve(root, 'tmp');
    for (const path of [
        temporary,
        ...Object.values(confinement).filter((value) =>
            value.startsWith(root + '/')
        ),
    ]) {
        await assertPhysicalPath(path, { missing: true });
        await mkdir(path, { recursive: true });
        await assertPhysicalPath(path);
    }
    await runConfinedProductCommand(command, args, root, {
        workspaceRoot: repositoryRoot,
        ...options,
    });
}

export function installedBin(plan, packageName, command) {
    const pkg = plan.installation.installed[packageName];
    const bin = pkg?.bin[command];
    if (!bin) externalFailure('qualified native executable missing');
    return resolve(pkg.packageRoot, bin.path);
}

export async function publishExternalApplicationShell(
    options,
    dependencies = {}
) {
    if (!/^[a-f0-9]{64}$/.test(options.expectedPlanId ?? ''))
        externalFailure('external creation requires a reviewed plan');
    const initial = await planExternalApplicationShell(options);
    if (options.expectedPlanId !== initial.plan_id)
        externalFailure('reviewed shell plan is stale');
    const run = dependencies.run ?? runExternalApplicationCommand;
    const phase = dependencies.phase ?? (() => undefined);
    // Lot MARQUE, commit 3 (B) : verrou du produit, puis celui de l'appli.
    const outputs = [initial.outputAbsolute];
    return withProductWriterLocks(initial.root, outputs, async () => {
        const plan = await planExternalApplicationShell(options);
        if (plan.plan_id !== initial.plan_id)
            externalFailure('shell changed under lock');
        const recheck = async () => {
            const current = await planExternalApplicationShell(options);
            if (current.plan_id !== plan.plan_id)
                externalFailure('shell inputs changed during publication');
        };
        const hadOutput = await pathExists(plan.outputAbsolute);
        const hadCandidate = await pathExists(plan.candidate);
        if (hadOutput)
            await verifyGeneratedTree(plan.outputAbsolute, plan.files);
        else await stageGeneratedTree(plan.candidate, plan.files);
        const compilerPackage =
            plan.profile === 'angular-pwa'
                ? '@angular/compiler-cli'
                : 'typescript';
        const compilationRoot = hadOutput
            ? plan.outputAbsolute
            : plan.candidate;
        await phase('candidate-staged', plan);
        await recheck();
        await run(
            process.execPath,
            [
                installedBin(plan, compilerPackage, plan.compiler),
                '-p',
                resolve(compilationRoot, 'tsconfig.app.json'),
                '--noEmit',
            ],
            plan.root
        );
        await verifyGeneratedTree(compilationRoot, plan.files);
        await phase('compiled', plan);
        await recheck();
        let published = hadOutput;
        try {
            if (!hadOutput) {
                await commitDirectoryTransaction({
                    outputRoot: plan.outputAbsolute,
                    candidateRoot: plan.candidate,
                    expectedState: 'absent',
                });
                published = true;
            }
            await phase('published', plan);
            for (const target of ['build:production', 'lint', 'test']) {
                await run(
                    process.execPath,
                    [
                        installedBin(plan, 'nx', 'nx'),
                        'run',
                        `${plan.app_name}:${target}`,
                        '--skipNxCache',
                        '--outputStyle=stream',
                    ],
                    plan.root
                );
                await verifyGeneratedTree(plan.outputAbsolute, plan.files);
                await phase(target, plan);
                await recheck();
            }
            await run(
                process.execPath,
                [
                    resolve(
                        plan.root,
                        `${EXTERNAL_WORKSPACE_CMZ.support}/check-workspace.mjs`
                    ),
                ],
                plan.root
            );
            await assertSourceWeight(plan.root);
            await recheck();
            await verifyGeneratedTree(plan.outputAbsolute, plan.files);
            await phase('verified', plan);
            await recheck();
            await verifyGeneratedTree(plan.outputAbsolute, plan.files);
            return { plan, recovered: hadOutput || hadCandidate };
        } catch (error) {
            if (
                published &&
                !hadOutput &&
                !(await pathExists(plan.candidate))
            ) {
                // A changed/foreign tree is never moved for recovery. Leave
                // evidence in place and fail; exact owned output may roll back.
                try {
                    await verifyGeneratedTree(plan.outputAbsolute, plan.files);
                    await commitDirectoryTransaction({
                        outputRoot: plan.candidate,
                        candidateRoot: plan.outputAbsolute,
                        expectedState: 'absent',
                    });
                } catch (rollbackError) {
                    throw new AggregateError(
                        [error, rollbackError],
                        'external application: rollback refused; inspect the owned tree locally',
                        { cause: rollbackError }
                    );
                }
            }
            throw error;
        }
    });
}

// X3 : `generate:page-composition --target-root`. La composition Angular d'une
// page est rendue depuis son plan publié, recompilé à l'identique depuis l'état
// courant de l'application. Elle consomme les commandes publiées par
// `generate:action-request` au lieu d'en rendre une copie, et elle est publiée
// dans le registre scellé (ADR-0103). Le typage est fait par le compilateur du
// produit.
import { posix } from 'node:path';

import {
    angularPrimitiveBindings,
    EXTERNAL_COMPOSITION_COMMAND_OPTIONS,
} from '../page-composition-targets.mjs';
import { renderAngularActionRequestV2 } from '../renderers/angular-action-request-v2-renderer.mjs';
import { renderAngularExternalListQuery } from '../renderers/angular-external-list-query.mjs';
import { sampleResponse } from './list-query-conformance.mjs';
import { sampleCommandInput } from '../renderers/angular-page-composition-api.mjs';
import {
    ANGULAR_PAGE_COMPOSITION_CAPABILITIES,
    renderAngularPageComposition,
} from '../renderers/angular-page-composition-renderer.mjs';
import { loadJson, repositoryRoot } from '../validate-ir.mjs';
import { bindRenderedArtifacts, buildArtifactPlan } from './artifact-plan.mjs';
import { ownedProductContext } from './application-workspace-root.mjs';
import {
    planApplicationPublication,
    publicApplicationPublicationPlan,
    publishRenderedPublication,
} from './application-publication.mjs';
import { canonicalizeGeneratedFiles } from './canonicalize-generated.mjs';
import {
    assertShellServiceBinding,
    SESSION_MODULE,
    sessionApplication,
} from './external-action-request.mjs';
import { externalFailure } from './external-application-paths.mjs';
import {
    compileOwnedPagePlan,
    publishedModelPattern,
} from './external-page-plan.mjs';
import {
    ACTION_REQUEST_TOOL,
    actionOutputRoot,
    COMPOSITION_SESSION_MODULE,
    compositionActionModule,
    compositionQueryModule,
    LIST_QUERY_TOOL,
    ownedAppFile,
    PAGE_COMPOSITION_TOOL,
    PAGE_PLAN_TOOL,
    pageCompositionRoot,
    pagePlanPath,
    publishingTool,
    queryOutputRoot,
} from './external-publication-paths.mjs';
import { buildGenerationManifest } from './generation-manifest.mjs';
import { validatePageExecutionCapabilities } from './page-execution-plan.mjs';
import {
    SOCLE_ACTIONS_DIR,
    SOCLE_QUERIES_DIR,
    socleRoot,
} from './socle-names.mjs';

export { PAGE_COMPOSITION_TOOL } from './external-publication-paths.mjs';
// Lot 2 (V5.1) : le code publié vit sous les sources du socle de l'appli ;
// la matérialisation de la composition est relative à elles.
const generatedRoot = (appName) => `${socleRoot(appName)}/src/`;

// X5 C4 : fichiers publiés d'une primitive (sous `base`, relatif au produit),
// comparés à l'octet au rendu.
async function assertPublished(app, files, base, message) {
    for (const [path, content] of Object.entries(files)) {
        let published;
        try {
            published = (await ownedAppFile(app, `${base}/${path}`)).toString(
                'utf8'
            );
        } catch {
            published = undefined;
        }
        if (published !== content) externalFailure(message);
    }
}

// X5 C4 (E7) : nœud de lecture, symétrique d'un nœud de commande. La lecture
// publiée doit être exactement celle que la composition rendrait ; elle est
// alors consommée telle quelle.
async function consumedQuery(app, node, modelPath) {
    const appName = app.manifest.app_name;
    const match = publishedModelPattern(appName, SOCLE_QUERIES_DIR).exec(
        modelPath
    );
    if (!match || publishingTool(app.manifest, modelPath) !== LIST_QUERY_TOOL)
        externalFailure(`page load ${node.id} has no published read`);
    const queryId = match[1];
    const model = JSON.parse(
        (await ownedAppFile(app, modelPath)).toString('utf8')
    );
    const query = model.queries.find(
        (candidate) => candidate.id === node.primitive_ref.operation_id
    );
    if (!query) externalFailure(`page load ${node.id} has no published read`);
    const serviceId = query.transport.service_id;
    const token = assertShellServiceBinding(
        app.endpoints,
        serviceId,
        model.backend_contract.id
    );
    const rendered = renderAngularExternalListQuery(model, {
        module: SESSION_MODULE,
        token,
    });
    const files = await canonicalizeGeneratedFiles(rendered.files);
    await assertPublished(
        app,
        files,
        queryOutputRoot(appName, queryId),
        `page load ${node.id} differs from its published read; republish it with generate:list-query`
    );
    return {
        queryId,
        token,
        serviceId,
        hasInput: query.port.input.kind === 'object',
        // X5 C6 (F-C6-idle) : lecture protégée par la session de l'hôte.
        protectedRead: query.request_policy.authentication.mode === 'host',
        responseSample: sampleResponse(query),
        rendered: {
            kind: 'query',
            nodeId: node.id,
            target: {
                ...rendered,
                ...bindRenderedArtifacts(
                    buildArtifactPlan(model, model.kind),
                    files,
                    angularPrimitiveBindings(node.id, files)
                ),
            },
        },
    };
}

// Références du plan (lot 2, V5.1 règle 4) : chacune est un chemin de
// L'INVENTAIRE DE CETTE APPLI, relatif au produit ; jamais un chemin hors du
// produit, d'une autre application ou non inscrit.
export function assertPlanReferences(plan, owned) {
    const references = [
        plan.source?.page_contract?.uri,
        ...[...(plan.query_nodes ?? []), ...(plan.command_nodes ?? [])].map(
            (node) => node.primitive_ref?.uri
        ),
    ];
    return references.map((uri) => {
        if (
            typeof uri !== 'string' ||
            posix.normalize(uri) !== uri ||
            uri.split('/').includes('..') ||
            !owned.has(uri)
        )
            externalFailure(
                'page plan references a file outside the application'
            );
        return uri;
    });
}

// Nœud de commande : la commande publiée doit être exactement celle que la
// composition rendrait pour ce nœud ; elle est alors consommée telle quelle.
async function consumedCommand(app, node, modelPath) {
    const appName = app.manifest.app_name;
    const match = publishedModelPattern(appName, SOCLE_ACTIONS_DIR).exec(
        modelPath
    );
    if (
        !match ||
        publishingTool(app.manifest, modelPath) !== ACTION_REQUEST_TOOL
    )
        externalFailure(`page command ${node.id} has no published command`);
    const actionId = match[1];
    const model = JSON.parse(
        (await ownedAppFile(app, modelPath)).toString('utf8')
    );
    const operation = model.actions.find(
        (candidate) => candidate.id === node.primitive_ref.operation_id
    );
    // `actionId` vient du chemin du modèle : le chemin est exact par
    // construction (validation X3, S7).
    if (!operation)
        externalFailure(`page command ${node.id} has no published command`);
    const serviceId = operation.transport.service_id;
    const token = assertShellServiceBinding(
        app.endpoints,
        serviceId,
        model.backend_contract.id
    );
    const rendered = renderAngularActionRequestV2(
        model,
        { services: { [serviceId]: { module: SESSION_MODULE, token } } },
        EXTERNAL_COMPOSITION_COMMAND_OPTIONS
    );
    const files = await canonicalizeGeneratedFiles(rendered.files);
    await assertPublished(
        app,
        files,
        actionOutputRoot(appName, actionId),
        `page command ${node.id} differs from its published command; republish it with generate:action-request`
    );
    return {
        actionId,
        token,
        serviceId,
        // V5.3 : valeurs d'exemple FIXES et neutres, sans préfixe du produit.
        sampleInput: sampleCommandInput(model),
        rendered: {
            kind: 'command',
            nodeId: node.id,
            target: {
                ...rendered,
                ...bindRenderedArtifacts(
                    buildArtifactPlan(model, model.kind),
                    files,
                    angularPrimitiveBindings(node.id, files)
                ),
            },
        },
    };
}

// `internal.renaming` (jamais en ligne de commande) : tolère le journal d'un
// renommage en cours. Lot 2 (V5.3) : la composition ne dépend plus du
// préfixe ; elle n'est plus re-rendue par le renommage.
async function renderExternalPageComposition(options, internal = {}) {
    const context = await ownedProductContext(
        {
            workspaceRoot: options.workspaceRoot ?? repositoryRoot,
            targetRoot: options.targetRoot,
        },
        internal
    );
    const app = await sessionApplication(
        context.productRoot,
        options.appName,
        'external page composition'
    );
    const GENERATED = generatedRoot(options.appName);
    const planPath = pagePlanPath(options.appName, options.pageId);
    const owned = new Set(app.manifest.generated_files.map(({ path }) => path));
    if (
        !owned.has(planPath) ||
        publishingTool(app.manifest, planPath) !== PAGE_PLAN_TOOL
    )
        externalFailure(
            'page execution plan is not published; run compile:page-execution-plan'
        );
    const planDocument = await ownedAppFile(app, planPath);
    const plan = JSON.parse(planDocument.toString('utf8'));
    const [, ...modelPaths] = assertPlanReferences(plan, owned);
    // Références : lectures d'abord, puis commandes (assertPlanReferences).
    const queryPaths = modelPaths.slice(0, plan.query_nodes.length);
    const commandPaths = modelPaths.slice(plan.query_nodes.length);
    // Recompilation déterministe : le plan publié doit être celui que l'état
    // courant de l'application produit, octet pour octet.
    const expected = await compileOwnedPagePlan(
        app,
        options.appName,
        options.pageId
    );
    if (expected.files[planPath] !== planDocument.toString('utf8'))
        externalFailure(
            'page execution plan is stale; recompile it with compile:page-execution-plan'
        );
    if (plan.schema_version !== '1.1.0')
        externalFailure(
            'external page composition supports session pages only'
        );
    const unsupported = validatePageExecutionCapabilities(
        plan,
        ANGULAR_PAGE_COMPOSITION_CAPABILITIES
    );
    if (unsupported.length > 0)
        externalFailure('page plan requires unsupported capabilities');
    const services = {};
    const renderedNodes = [];
    const externalNodes = {};
    const queries = [];
    for (const [index, node] of plan.query_nodes.entries()) {
        const read = await consumedQuery(app, node, queryPaths[index]);
        services[read.serviceId] = {
            module: SESSION_MODULE,
            token: read.token,
        };
        renderedNodes.push(read.rendered);
        queries.push(queryOutputRoot(options.appName, read.queryId));
        externalNodes[node.id] = {
            root: `${queryOutputRoot(options.appName, read.queryId).slice(GENERATED.length)}/src`,
            module: compositionQueryModule(read.queryId),
            serviceToken: read.token,
            queryInput: read.hasInput,
            protectedRead: read.protectedRead,
            responseSample: read.responseSample,
        };
    }
    for (const [index, node] of plan.command_nodes.entries()) {
        const command = await consumedCommand(app, node, commandPaths[index]);
        services[command.serviceId] = {
            module: SESSION_MODULE,
            token: command.token,
        };
        renderedNodes.push(command.rendered);
        externalNodes[node.id] = {
            root: `${actionOutputRoot(options.appName, command.actionId).slice(GENERATED.length)}/src`,
            module: compositionActionModule(command.actionId),
            sampleInput: command.sampleInput,
            serviceToken: command.token,
        };
    }
    const rendered = renderAngularPageComposition(
        plan,
        renderedNodes,
        {
            schema_version: '1.1.0',
            kind: 'angular-page-host-bindings',
            session: {
                module: COMPOSITION_SESSION_MODULE,
                token: 'APPLICATION_SESSION',
            },
            // X4-sécurité-3, G2 : verrou du profil extérieur. Seule cette
            // liaison fait rendre `online`, la table `api` et son assertion.
            connectivity: {
                module: `${COMPOSITION_SESSION_MODULE}/connectivity`,
                token: 'ApplicationConnectivity',
            },
            services,
        },
        { externalNodes }
    );
    // Matérialisation complète, relative aux sources du socle : fichiers de la
    // composition et commandes consommées. Seuls les premiers sont publiés ; le
    // manifeste de génération lie les empreintes des secondes.
    const base = pageCompositionRoot(options.appName, options.pageId);
    const local = (path) =>
        path.startsWith('src/')
            ? `${base.slice(GENERATED.length)}/${path}`
            : path;
    const canonical = await canonicalizeGeneratedFiles(rendered.files);
    const files = {};
    const bindings = {};
    for (const [path, content] of Object.entries(canonical)) {
        files[local(path)] = content;
        bindings[local(path)] = rendered.bindings[path];
    }
    const artifactPlan = buildArtifactPlan(plan, 'page-execution-plan');
    const bound = bindRenderedArtifacts(artifactPlan, files, bindings);
    const profile = await loadJson(
        new URL('../profiles/angular-nx.profile.json', import.meta.url)
    );
    const manifest = buildGenerationManifest(
        plan,
        artifactPlan,
        profile,
        bound
    );
    const publication = {};
    for (const [path, content] of Object.entries(files))
        if (path.startsWith(`${base.slice(GENERATED.length)}/`))
            publication[`${GENERATED}${path}`] = content;
    const manifestPath = `${base}/generation-manifest.json`;
    Object.assign(
        publication,
        await canonicalizeGeneratedFiles({
            [manifestPath]: JSON.stringify(manifest, null, 2) + '\n',
        })
    );
    return {
        pageId: options.pageId,
        commands: Object.values(externalNodes)
            .filter(({ root }) =>
                `${GENERATED}${root}`.startsWith(
                    `${socleRoot(options.appName)}/${SOCLE_ACTIONS_DIR}/`
                )
            )
            .map(({ root }) => `${GENERATED}${root.replace(/\/src$/, '')}`),
        queries,
        publication: {
            workspaceRoot: options.workspaceRoot ?? repositoryRoot,
            targetRoot: options.targetRoot,
            appName: options.appName,
            tool: PAGE_COMPOSITION_TOOL,
            files: publication,
            inputs: [],
            omitUnchanged: true,
            coveredPrefix: `${base}/`,
        },
    };
}

// X4-sécurité-3 (Π2) : fichiers que le générateur courant publierait pour la
// composition de cette page, à comparer octet pour octet à la composition
// publiée.
export async function expectedExternalPageCompositionFiles(
    options,
    internal = {}
) {
    return (await renderExternalPageComposition(options, internal)).publication
        .files;
}

export async function planExternalPageComposition(options) {
    const rendered = await renderExternalPageComposition(options);
    return {
        ...(await planApplicationPublication(rendered.publication)),
        page_id: rendered.pageId,
        consumed_commands: rendered.commands,
        // X5 C4 : présent seulement pour une page à lectures (sortie
        // inchangée pour une page de commandes).
        ...(rendered.queries.length
            ? { consumed_queries: rendered.queries }
            : {}),
    };
}

export function publicExternalPageCompositionPlan(plan) {
    return {
        ...publicApplicationPublicationPlan(plan),
        page_id: plan.page_id,
        consumed_commands: plan.consumed_commands,
        ...(plan.consumed_queries
            ? { consumed_queries: plan.consumed_queries }
            : {}),
    };
}

export async function publishExternalPageComposition(options, dependencies) {
    const { rendered, result } = await publishRenderedPublication(
        options,
        (reviewed) => renderExternalPageComposition(reviewed),
        dependencies
    );
    return { ...result, page_id: rendered.pageId };
}

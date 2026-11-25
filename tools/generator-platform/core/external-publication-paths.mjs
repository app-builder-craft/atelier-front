// Publications extérieures d'une application (ADR-0103) : outils, chemins de
// sortie et lecture exacte des fichiers possédés, partagés par la commande
// (X2), le plan et la composition de page (X3) sans cycle d'import.
import { posix } from 'node:path';

import {
    externalFailure,
    readProductFile,
} from './external-application-paths.mjs';
import { DERIVED_WRITERS } from './application-ownership.mjs';
import { escapeRegExp } from './atelier-signature.mjs';
import { sha256 } from './generation-manifest.mjs';
import {
    PAGE_COMPOSITION_DIR,
    PAGE_MODULE,
    SOCLE_ACTIONS_DIR,
    SOCLE_PAGES_DIR,
    SOCLE_QUERIES_DIR,
    SOCLE_SESSION_DIR,
    socleRoot,
} from './socle-names.mjs';

export const ACTION_REQUEST_TOOL = 'generate:action-request';
export const LIST_QUERY_TOOL = 'generate:list-query';
export const PAGE_PLAN_TOOL = 'compile:page-execution-plan';
export const PAGE_COMPOSITION_TOOL = 'generate:page-composition';

// Lot 2 (V5.1) : tout le code publié vit dans le SOCLE de l'appli, sous sa
// disposition fixe (`socle-names.mjs`) ; chemins relatifs au PRODUIT, comme
// l'inventaire de l'appli.
export const actionOutputRoot = (appName, actionId) =>
    `${socleRoot(appName)}/${SOCLE_ACTIONS_DIR}/${actionId}`;
// Le modèle d'exécution est publié avec la commande ; le plan de page le
// référence, et la composition consomme cette commande publiée.
export const actionExecutionModelPath = (appName, actionId) =>
    `${actionOutputRoot(appName, actionId)}/execution-model.json`;

// X5 C3a : une lecture publiée, symétrique d'une commande publiée.
export const queryOutputRoot = (appName, queryId) =>
    `${socleRoot(appName)}/${SOCLE_QUERIES_DIR}/${queryId}`;
export const queryExecutionModelPath = (appName, queryId) =>
    `${queryOutputRoot(appName, queryId)}/execution-model.json`;

export const pageOutputRoot = (appName, pageId) =>
    `${socleRoot(appName)}/${SOCLE_PAGES_DIR}/${pageId}`;
export const pagePlanPath = (appName, pageId) =>
    `${pageOutputRoot(appName, pageId)}/plan/page-execution-plan.json`;
export const pageCompositionRoot = (appName, pageId) =>
    `${pageOutputRoot(appName, pageId)}/${PAGE_COMPOSITION_DIR}`;
// Module de page du socle (V5.4) : l'API publique de la composition.
export const pageModulePath = (appName, pageId) =>
    `${pageOutputRoot(appName, pageId)}/${PAGE_MODULE}`;
// Session de l'appli, sous son socle : index public des modules générés et
// jetons de service.
export const sessionIndexPath = (appName) =>
    `${socleRoot(appName)}/${SOCLE_SESSION_DIR}/index.ts`;
export const sessionEndpointsPath = (appName) =>
    `${socleRoot(appName)}/${SOCLE_SESSION_DIR}/service-endpoints.ts`;

// V5.1 règle 3 (C-A7) : spécifieurs relatifs du code publié DÉRIVÉS des
// constantes de disposition du socle par `posix.relative`, jamais écrits à la
// main. Dossiers relatifs à la racine du socle ; un segment quelconque tient
// la place de l'identifiant (seule la profondeur compte).
const relativeModule = (from, to) => posix.relative(from, to);
const ID = 'id';
const ACTION_SOURCES = `${SOCLE_ACTIONS_DIR}/${ID}/src`;
const COMPOSITION_SOURCES = `${SOCLE_PAGES_DIR}/${ID}/${posix.dirname(PAGE_MODULE)}`;
// Depuis les sources d'une commande ou d'une lecture vers la session.
export const SESSION_MODULE = relativeModule(ACTION_SOURCES, SOCLE_SESSION_DIR);
// Depuis les sources d'une composition vers la session, puis vers les
// sources d'une commande ou d'une lecture publiée.
export const COMPOSITION_SESSION_MODULE = relativeModule(
    COMPOSITION_SOURCES,
    SOCLE_SESSION_DIR
);
export const compositionActionModule = (actionId) =>
    relativeModule(COMPOSITION_SOURCES, `${SOCLE_ACTIONS_DIR}/${actionId}/src`);
export const compositionQueryModule = (queryId) =>
    relativeModule(COMPOSITION_SOURCES, `${SOCLE_QUERIES_DIR}/${queryId}/src`);

const pagePlanPattern = (appName) =>
    new RegExp(
        `^${escapeRegExp(`${socleRoot(appName)}/${SOCLE_PAGES_DIR}/`)}(page_[a-f0-9]{16})/plan/page-execution-plan\\.json$`
    );

export function assertPageId(pageId) {
    if (!/^page_[a-f0-9]{16}$/.test(pageId ?? ''))
        externalFailure('invalid page id');
    return pageId;
}

// Fichier possédé de l'application, exact selon son registre (chemin relatif
// au produit).
export async function ownedAppFile(app, path) {
    const entry = app.manifest.generated_files.find(
        (candidate) => candidate.path === path
    );
    if (!entry) externalFailure('file is not owned by the application');
    const content = await readProductFile(app.productRoot, path);
    if (sha256(content) !== entry.sha256 || content.length !== entry.bytes)
        externalFailure('owned application file drift');
    return content;
}

// Dernier outil qui a publié ce fichier ; `null` pour un fichier de la coque.
// Un renommage du préfixe n'en est pas un : il réécrit en `q` la sortie de la
// coque ou de la composition, prouvée égale à leur rendu (phase `derived`),
// et l'auteur reste le leur. Une mise à jour (`update-app`) non plus : elle
// ne réécrit que des fichiers dérivés (lot 2, commit 6c).
export function publishingTool(manifest, path) {
    return (
        manifest.ownership.publications.findLast(
            (record) =>
                !DERIVED_WRITERS.has(record.tool) &&
                record.files.some((file) => file.path === path)
        )?.tool ?? null
    );
}

// I-1 : pages dont le plan publié référence le modèle de cette commande (ou de
// cette lecture, X5 C3a). Une nouvelle publication les rend périmées : le plan, puis la
// composition, sont à recompiler après elle (X2 → plan → composition).
// X5 C3a : même règle pour une lecture, par ses nœuds de lecture.
async function pagesConsuming(app, appName, modelPath, nodesKey) {
    // Lot 2 (V5.1 règle 4) : la référence du plan EST le chemin de
    // l'inventaire, relatif au produit.
    const uri = modelPath;
    const pagePlan = pagePlanPattern(appName);
    const pages = [];
    for (const { path } of app.manifest.generated_files) {
        const match = pagePlan.exec(path);
        if (!match || publishingTool(app.manifest, path) !== PAGE_PLAN_TOOL)
            continue;
        const plan = JSON.parse((await ownedAppFile(app, path)).toString());
        if (
            !(plan[nodesKey] ?? []).some(
                (node) => node.primitive_ref?.uri === uri
            )
        )
            continue;
        const composition = `${pageCompositionRoot(appName, match[1])}/generation-manifest.json`;
        pages.push({
            page_id: match[1],
            composition:
                publishingTool(app.manifest, composition) ===
                PAGE_COMPOSITION_TOOL,
        });
    }
    return pages.sort((left, right) =>
        left.page_id.localeCompare(right.page_id)
    );
}

export const pagesConsumingCommand = (app, appName, actionId) =>
    pagesConsuming(
        app,
        appName,
        actionExecutionModelPath(appName, actionId),
        'command_nodes'
    );
export const pagesConsumingQuery = (app, appName, queryId) =>
    pagesConsuming(
        app,
        appName,
        queryExecutionModelPath(appName, queryId),
        'query_nodes'
    );

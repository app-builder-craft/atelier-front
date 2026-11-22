#!/usr/bin/env node
/**
 * check:retired-name — l'ancien nom interne de l'atelier ne revient ni dans
 * un fichier suivi, ni dans un produit (lot MARQUE).
 *
 * Tout est dérivé, rien n'est déclaré à la main :
 * - le MOTIF est l'ancien nom, composé ici et seulement ici : aucun fichier
 *   suivi ne le porte en clair, pas même ce contrôle ni son test. Il est
 *   cherché SANS casse et en sous-chaîne : chaque forme d'un préfixe (`@x/`,
 *   `x-`, `x_`, `X_`, `__x…`, `/etc/nginx/x/`) le contient, même collée à un
 *   mot (`__xAppAccessContext`) ;
 * - STATIQUE : chaque fichier suivi (`git ls-files`), par son chemin et par
 *   son contenu ; un lien symbolique est jugé sur sa cible écrite, un contenu
 *   binaire (octet NUL) sur son seul chemin. Le seul contenu écarté est celui
 *   du fichier de verrouillage du gestionnaire de paquets, DÉDUIT de
 *   `packageManager` (`bun@…` → `bun.lock`) : ses empreintes base64 portent
 *   le motif par hasard. Un autre gestionnaire est refusé ;
 * - DYNAMIQUE : un produit sonde publié RÉELLEMENT dans un dossier jetable,
 *   par les publieurs du générateur (plan revu, puis publication liée à son
 *   identifiant, comme `--expect-plan`), dans les deux profils : espace,
 *   coque Angular avec session et relais, commande, plans de page,
 *   compositions, bon de travail, réalisation et lecture de chaque domaine de
 *   fixture ; coques Angular et React d'une conception ; contrats backend et
 *   conceptions compilés. Puis l'arbre ENTIER du dossier jetable est balayé,
 *   noms et contenus, fichiers et dossiers cachés compris (verrous, journaux
 *   et racines de transaction vivent à côté du produit). Le contenu du verrou
 *   de chaque produit, déduit de SON `packageManager`, n'est pas jugé : ses
 *   noms viennent du `package.json` du produit, balayé
 *   (`projectProductLock`), ses empreintes base64 du verrou de l'atelier.
 *
 * Limites : un contenu binaire n'est jugé que par son chemin, et une image
 * qui DESSINE le motif n'est pas vue ; un nom temporaire de transaction n'est
 * vu que s'il survit (il dérive de `signatureName`, source unique gardée par
 * `check:identity-sources`) ; le contenu d'un verrou n'est pas jugé (celui de
 * l'atelier garde le nom de sa racine tel que Bun l'a écrit).
 *
 * Usage : bun run check:retired-name
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import {
    lstat,
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GP = new URL('./generator-platform/', import.meta.url);
const load = (path) => import(new URL(path, GP).href);

/** L'ancien nom interne, composé pour n'être écrit en clair nulle part. */
export const RETIRED_NAME = ['c', 'mz'].join('');

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Occurrences du motif dans un chemin et dans un contenu. `bytes` absent :
 * seul le chemin est jugé ; contenu binaire (octet NUL) : idem.
 */
export function retiredFindings(label, bytes, motif = RETIRED_NAME) {
    const pattern = new RegExp(escapeRegExp(motif), 'i');
    const findings = [];
    if (pattern.test(label)) findings.push(`${label} (chemin)`);
    if (bytes === undefined || bytes.includes(0)) return findings;
    for (const [index, line] of bytes.toString('utf8').split('\n').entries())
        if (pattern.test(line)) findings.push(`${label}:${index + 1}`);
    return findings;
}

/** Fichier de verrouillage, déduit de `packageManager` ; fermé sinon. */
export function lockfileOf(packageJson) {
    const manager = packageJson?.packageManager;
    if (typeof manager !== 'string' || !/^bun@\S+$/.test(manager))
        throw new Error(
            `check:retired-name : gestionnaire de paquets non pris en charge (packageManager ${JSON.stringify(manager)})`
        );
    return 'bun.lock';
}

/** Contrôle statique sur les fichiers suivis d'un dépôt. */
export function staticFindings(root, motif = RETIRED_NAME) {
    const paths = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
    })
        .split('\0')
        .filter(Boolean);
    if (paths.length === 0)
        throw new Error('check:retired-name : aucun fichier suivi');
    const lockfile = lockfileOf(
        JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    );
    const findings = [];
    for (const path of paths) {
        const absolute = join(root, path);
        let bytes;
        try {
            bytes = lstatSync(absolute).isSymbolicLink()
                ? Buffer.from(readlinkSync(absolute))
                : readFileSync(absolute);
        } catch (error) {
            throw new Error(
                `check:retired-name : fichier suivi illisible : ${path} (${error.code ?? error.message})`,
                { cause: error }
            );
        }
        findings.push(
            ...retiredFindings(
                path,
                path === lockfile ? undefined : bytes,
                motif
            )
        );
    }
    return { scanned: paths.length, lockfile, findings };
}

/**
 * Balayage d'un arbre entier : noms et contenus, entrées cachées comprises.
 * `lockfiles` : chemins relatifs dont seul le nom est jugé (verrous déduits
 * du `packageManager` de chaque produit).
 */
export async function treeFindings(root, lockfiles = [], motif = RETIRED_NAME) {
    const skipped = new Set(lockfiles);
    const findings = [];
    let scanned = 0;
    const visit = async (relative) => {
        const entries = await readdir(join(root, relative));
        for (const name of entries.sort()) {
            const path = relative ? `${relative}/${name}` : name;
            const absolute = join(root, path);
            const stat = await lstat(absolute);
            scanned += 1;
            if (stat.isDirectory()) {
                findings.push(...retiredFindings(path, undefined, motif));
                await visit(path);
            } else if (stat.isSymbolicLink())
                findings.push(
                    ...retiredFindings(
                        path,
                        Buffer.from(await readlink(absolute)),
                        motif
                    )
                );
            else
                findings.push(
                    ...retiredFindings(
                        path,
                        skipped.has(path)
                            ? undefined
                            : await readFile(absolute),
                        motif
                    )
                );
        }
    };
    await visit('');
    return { scanned, findings };
}

/** Verrous des produits sonde, chacun déduit du `packageManager` du produit. */
export async function productLockfiles(parent, products) {
    const lockfiles = [];
    for (const product of products)
        lockfiles.push(
            `${product}/${lockfileOf(JSON.parse(await readFile(join(parent, product, 'package.json'), 'utf8')))}`
        );
    return lockfiles;
}

// ── Produit sonde ─────────────────────────────────────────────────────────

const NOOP_RUN = { run: async () => undefined };

async function reviewed(plan, publish, options) {
    const planned = await plan(options);
    await publish({ ...options, expectedPlanId: planned.plan_id }, NOOP_RUN);
    return planned;
}

async function workspace(root) {
    const fixture = await load('test-support/external-application-fixture.mjs');
    const { planApplicationWorkspace, publishApplicationWorkspace } =
        await load('core/application-workspace.mjs');
    const options = fixture.workspaceOptions(root, [
        'angular-pwa',
        'react-spa',
    ]);
    const planned = await reviewed(
        planApplicationWorkspace,
        publishApplicationWorkspace,
        options
    );
    await fixture.installMetadataOnly(planned);
    await (
        await load('test-support/external-realization-product.mjs')
    ).linkTypePackages(root);
    return planned.manifest.identity.prefix;
}

async function sessionProduct(root, domain) {
    const { TOOLS_ROOT } = await load(
        'test-support/external-application-fixture.mjs'
    );
    const session = await load('test-support/external-session-fixture.mjs');
    const shells = await load('core/application-workspace.mjs');
    const actions = await load('core/external-action-request.mjs');
    const pagePlan = await load('core/external-page-plan.mjs');
    const composition = await load('core/external-page-composition.mjs');
    const realization = await load('core/external-page-realization.mjs');
    const lists = await load('core/external-list-query.mjs');
    const { connexionRealizationFiles } = await load(
        'test-support/external-realization-fixture.mjs'
    );
    const { sha256 } = await load('core/generation-manifest.mjs');
    const prefix = await workspace(root);
    const input = await session.writeExternalSessionDesign(root, domain);
    const shell = session.sessionShellOptions(input);
    await reviewed(
        shells.planExternalApplicationShell,
        shells.publishExternalApplicationShell,
        shell
    );
    const base = {
        workspaceRoot: TOOLS_ROOT,
        targetRoot: root,
        appName: shell.appName,
    };
    const { enter } = await session.writeExternalActionDefinitions(
        root,
        domain
    );
    await reviewed(
        actions.planExternalActionRequest,
        actions.publishExternalActionRequest,
        { ...base, definitionPath: enter }
    );
    const page = (pageId) => ({ ...base, pageId });
    const entry = page(input.entryPage.id);
    for (const [plan, publish] of [
        [pagePlan.planExternalPagePlan, pagePlan.publishExternalPagePlan],
        [
            composition.planExternalPageComposition,
            composition.publishExternalPageComposition,
        ],
        [
            realization.planExternalPageRealizationWorkOrder,
            realization.publishExternalPageRealizationWorkOrder,
        ],
    ])
        await reviewed(plan, publish, entry);
    // Réalisation de la page d'entrée : le brouillon de la preuve native X4.
    const app = join(root, 'apps', shell.appName);
    const workOrder = JSON.parse(
        await readFile(
            join(app, realization.workOrderPath(input.entryPage.id)),
            'utf8'
        )
    );
    const contract = await readFile(join(app, workOrder.page_contract.path));
    const draft = join(root, workOrder.draft_root);
    await rm(draft, { recursive: true, force: true });
    await mkdir(draft, { recursive: true });
    for (const [name, content] of Object.entries(
        connexionRealizationFiles({
            pageContract: JSON.parse(contract),
            contractSha256: sha256(contract),
            composition: workOrder.composition.module,
        })
    ))
        await writeFile(join(draft, name), content);
    await reviewed(
        realization.planExternalPageRealization,
        realization.publishExternalPageRealization,
        entry
    );
    // Lecture, puis plan et composition de la page qui la charge.
    const definitionPath = await session.writeExternalQueryDefinition(
        root,
        domain
    );
    await reviewed(
        lists.planExternalListQuery,
        lists.publishExternalListQuery,
        {
            ...base,
            definitionPath,
        }
    );
    const reading = input.design.pages.find(
        (candidate) => candidate.loads.length > 0
    );
    if (!reading)
        throw new Error(`sonde ${domain} : aucune page ne charge de lecture`);
    for (const [plan, publish] of [
        [pagePlan.planExternalPagePlan, pagePlan.publishExternalPagePlan],
        [
            composition.planExternalPageComposition,
            composition.publishExternalPageComposition,
        ],
    ])
        await reviewed(plan, publish, page(reading.id));
    return prefix;
}

async function designShells(root) {
    const fixture = await load('test-support/external-application-fixture.mjs');
    const shells = await load('core/application-workspace.mjs');
    const prefix = await workspace(root);
    const design = await fixture.writeExternalDesign(root);
    for (const [appName, profile] of [
        ['native-angular', 'angular-pwa'],
        ['native-react', 'react-spa'],
    ])
        await reviewed(
            shells.planExternalApplicationShell,
            shells.publishExternalApplicationShell,
            {
                workspaceRoot: fixture.TOOLS_ROOT,
                targetRoot: root,
                designPath: design.designPath,
                experienceId: design.experienceId,
                appName,
                profile,
            }
        );
    return prefix;
}

async function compiledDocuments(root, kind) {
    const fixture = await load('test-support/external-application-fixture.mjs');
    const { writeDocumentInputs } = await load(
        'test-support/external-document-fixture.mjs'
    );
    const backend = await load('core/structured-backend-publication.mjs');
    const designs = await load('core/application-design-publication.mjs');
    const prefix = await workspace(root);
    const loaded = await fixture.schemas();
    const inputs = await writeDocumentInputs(root, kind);
    const base = {
        workspaceRoot: fixture.TOOLS_ROOT,
        targetRoot: root,
        backendContractSchema: loaded.backendContractSchema,
    };
    for (const {
        definitionPath,
        outputPath,
        adapter,
    } of inputs.backendRequests) {
        const options = { ...base, definitionPath, outputPath, adapter };
        const planned = await backend.planStructuredBackendPublication(options);
        await backend.publishStructuredBackendContract({
            ...options,
            planId: planned.plan_id,
        });
    }
    const options = {
        ...base,
        sourcePath: inputs.sourcePath,
        outputPath: inputs.designPath,
        applicationDesignSchema: loaded.applicationDesignSchema,
    };
    const planned = await designs.planApplicationDesignPublication(options);
    await designs.publishApplicationDesign({
        ...options,
        planId: planned.plan_id,
    });
    return prefix;
}

/**
 * Publie le produit sonde sous `parent` et rend les préfixes de ses espaces.
 * Fermé : un préfixe de sonde qui porte le motif invaliderait la sonde.
 */
export async function publishProbe(parent, motif = RETIRED_NAME) {
    const { SESSION_FIXTURE_DOMAINS } = await load(
        'test-support/external-session-fixture.mjs'
    );
    const { DOCUMENT_CASES } = await load(
        'test-support/external-document-fixture.mjs'
    );
    const prefixes = {};
    for (const domain of SESSION_FIXTURE_DOMAINS)
        prefixes[`session-${domain}`] = await sessionProduct(
            join(parent, `session-${domain}`),
            domain
        );
    prefixes.shells = await designShells(join(parent, 'shells'));
    for (const kind of DOCUMENT_CASES)
        prefixes[`documents-${kind}`] = await compiledDocuments(
            join(parent, `documents-${kind}`),
            kind
        );
    for (const [product, prefix] of Object.entries(prefixes))
        if (
            typeof prefix !== 'string' ||
            retiredFindings(prefix, undefined, motif).length > 0
        )
            throw new Error(
                `check:retired-name : préfixe de sonde invalide pour ${product} : ${JSON.stringify(prefix)}`
            );
    return prefixes;
}

async function main() {
    const lock = staticFindings(ROOT);
    const { signatureName } = await load('core/atelier-signature.mjs');
    const parent = await realpath(
        await mkdtemp(join(tmpdir(), signatureName('retired-name-')))
    );
    let probe;
    let prefixes;
    let lockfiles;
    try {
        prefixes = await publishProbe(parent);
        lockfiles = await productLockfiles(parent, Object.keys(prefixes));
        probe = await treeFindings(parent, lockfiles);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
    const failed = lock.findings.length + probe.findings.length;
    for (const finding of lock.findings)
        console.error(`  fichier suivi : ${finding}`);
    for (const finding of probe.findings)
        console.error(`  produit sonde : ${finding}`);
    const summary = `fichiers suivis : ${lock.findings.length} sur ${lock.scanned} (contenu de ${lock.lockfile} écarté, déduit de packageManager) ; produit sonde : ${probe.findings.length} sur ${probe.scanned} entrées, contenu de ${lockfiles.length} verrou(s) de produit écarté (${Object.entries(
        prefixes
    )
        .map(([product, prefix]) => `${product} « ${prefix} »`)
        .join(', ')})`;
    if (failed > 0) {
        console.error(`ÉCHEC check:retired-name — ${summary}`);
        process.exit(1);
    }
    console.log(`OK  ancien nom interne absent — ${summary}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

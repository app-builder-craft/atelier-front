#!/usr/bin/env node
// X4-config, preuves 8 et 10, et politique `<p>-sw` : la coque construite par
// la preuve native, servie par le relais nginx, ouverte par son Chromium.
//   10 : Trusted Types et politique exacte en en-tête, meta présente, aucune
//        violation au chargement ;
//    8 : service worker enregistré et actif (URL et portée), aucune violation ;
//        nouveau document au rechargement ; cache conforme à la variante
//        déclarée par la conception de la coque (table fermée) ; hors ligne,
//        serveur réellement arrêté, document servi par le service worker ;
//   <p>-sw : seconde création refusée, nom hors liste refusé ; innerHTML et
//        new Worker par chaîne toujours bloqués.
//   form-action : une soumission native de même origine est bloquée et
//        signalée par chaque politique livrée qui porte `form-action 'none'`,
//        document inchangé ; un formulaire `method="dialog"` reste permis.
// La liste des vérifications est STATIQUE (`RELAY_BROWSER_CHECKS`) : un nom
// hors liste est refusé et le compte attendu en dérive.
// Usage : --browser-proof-root <racine d'une preuve native> [--mutations].
import assert from 'node:assert/strict';
import {
    cp,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    HOST_CONF,
    get,
    relayFixture,
    stage,
    stopRelay,
    withRelay,
} from './check-nginx-relay.mjs';
import {
    SIGNATURE_FILES,
    signatureGlobal,
    signatureName,
} from './core/atelier-signature.mjs';
import { sealedProductPrefix } from './core/application-workspace-root.mjs';
import { productForms } from './core/product-identity.mjs';
import {
    externalCspHeader,
    externalCspMeta,
} from './renderers/external-content-security-policy.mjs';

const READY_TIMEOUT_MS = 15_000;
// Attente après la dernière violation attendue : une violation de plus serait
// rapportée dans ce délai.
const SETTLE_MS = 500;

// Liste STATIQUE des vérifications de chaque coque : gabarits de noms, dont
// `<kebab>` est la seule partie rendue (forme du préfixe du produit). Le compte
// attendu en dérive ; il ne se déduit jamais des résultats obtenus.
export const RELAY_BROWSER_CHECKS = Object.freeze([
    '10-trusted-types-on-nginx',
    '8-service-worker-registered',
    '8-reload-new-document',
    '<kebab>sw-policy-closed',
    'sinks-still-blocked',
    'cache-security',
    '8-offline-document',
    'form-action-none',
    'form-dialog-allowed',
]);

export const relayBrowserCheckNames = (prefix) =>
    RELAY_BROWSER_CHECKS.map((name) =>
        name.replace('<kebab>', productForms(prefix).kebab)
    );

// Une politique porte-t-elle `form-action 'none'` ? Chaque politique livrée
// (en-tête, balise meta) qui la porte rapporte sa propre violation (CSP3
// §4.2.4) : le nombre attendu de violations en dérive.
const FORM_ACTION_NONE = /(?:^|;)\s*form-action 'none'\s*(?:;|$)/;
export const formActionSources = (policies) =>
    policies.filter((policy) => FORM_ACTION_NONE.test(policy ?? '')).length;

// Contre-mutations de la directive, sur la COPIE servie (jamais l'arbre du
// dépôt) : `'none'` → `'self'` dans l'en-tête nginx, dans la balise meta, ou
// dans les deux. Critères de mort spécifiques ; sous une seule source
// affaiblie, la sonde comportementale reste verte (l'autre bloque).
export const FORM_ACTION_MUTATIONS = Object.freeze([
    Object.freeze({
        id: 'form-action-header',
        sources: Object.freeze(['header']),
        killedBy: '10-trusted-types-on-nginx',
        stillGreen: 'form-action-none',
    }),
    Object.freeze({
        id: 'form-action-meta',
        sources: Object.freeze(['meta']),
        killedBy: '10-trusted-types-on-nginx',
        stillGreen: 'form-action-none',
    }),
    Object.freeze({
        id: 'form-action-both',
        sources: Object.freeze(['header', 'meta']),
        killedBy: 'form-action-none',
    }),
]);

// Affaiblit la directive dans un fichier de la copie : exactement une
// occurrence, sinon la contre-mutation s'arrête (ancre absente ou ambiguë).
export async function weakenFormAction(path) {
    const text = await readFile(path, 'utf8');
    const count = text.split("form-action 'none'").length - 1;
    if (count !== 1)
        throw new Error(
            `contre-mutation form-action : ${count} occurrence(s) dans ${path}`
        );
    await writeFile(
        path,
        text.replace("form-action 'none'", "form-action 'self'")
    );
}
// Globale d'instrumentation du harnais et marqueur de redéploiement.
const VIOLATIONS = signatureGlobal('Violations');
const DEPLOY = signatureName('deploy');
// Composant routé : le premier enfant d'app-root est le router-outlet, caché.
const ROUTED = 'app-root router-outlet + *';
export const SW_CACHES_API = `
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || !url.pathname.startsWith('/api/')) return;
    event.respondWith(fetch(event.request).then((response) => {
        const copy = response.clone();
        return caches.open(CACHE).then((cache) => cache.put(event.request, copy)).then(() => response);
    }));
});
`;
const SHELL_ENTRIES = [
    '/',
    '/icon.svg',
    '/index.html',
    '/manifest.webmanifest',
];

// Attendus par variante déclarée (session, offline_policy). Une variante
// absente de la table arrête la preuve.
export const EXPECTATIONS = {
    // Avec session : offline_policy none (X0) ; document, manifeste et icône
    // seulement, version installée ; aucun démarrage hors ligne revendiqué.
    'session:none': {
        cache: (cached, files, forms) =>
            assert.deepEqual(cached, [
                [`${forms.kebab}session-static-v1`, SHELL_ENTRIES],
            ]),
        offlineDeploy: 0,
        bootsOffline: false,
    },
    // Sans session : service worker de la coque, réseau d'abord ; le cache
    // garde la coque et ses ressources de même origine, jamais /api/.
    'shell:none': {
        cache: (cached, files, forms) => {
            assert.equal(cached.length, 1);
            assert.equal(cached[0][0], `${forms.kebab}shell-v1`);
            const entries = cached[0][1];
            for (const entry of SHELL_ENTRIES)
                assert.ok(entries.includes(entry), entry);
            for (const entry of entries.filter(
                (path) => !SHELL_ENTRIES.includes(path)
            ))
                assert.ok(
                    /^\/[A-Za-z0-9_-]+(?:-[A-Za-z0-9_]+)?\.(?:js|css)$/.test(
                        entry
                    ) && files.includes(entry.slice(1)),
                    entry
                );
            for (const prefix of ['main-', 'polyfills-', 'styles-'])
                assert.ok(
                    entries.some((entry) => entry.startsWith('/' + prefix)),
                    prefix
                );
        },
        offlineDeploy: 1,
        bootsOffline: true,
    },
};

// Enregistreur des vérifications d'une coque : un nom hors de la liste
// statique, ou une vérification lancée deux fois, arrête la preuve ; le compte
// attendu ne peut donc pas être contourné.
export function relayCheckRecorder(prefix) {
    const results = {};
    const declared = relayBrowserCheckNames(prefix);
    const check = async (name, run) => {
        if (!declared.includes(name) || Object.hasOwn(results, name))
            throw new Error(`vérification non déclarée ou répétée : ${name}`);
        try {
            await run();
            results[name] = 'PASS';
        } catch (error) {
            results[name] = `FAIL ${String(error.message).split('\n')[0]}`;
        }
    };
    return { results, check };
}

// Sondes `form-action` (décision L10-2 = B), après la vérification 10 et par
// DELTA du tableau de violations du document courant. Le formulaire est créé
// par l'API du DOM (jamais innerHTML : Trusted Types).
// - `form-action-none` : un formulaire POST de MÊME origine soumis par
//   `requestSubmit()` est bloqué (au moins une violation dans le délai, même
//   URL, composant routé présent) ; chaque entrée ajoutée vient de
//   `form-action` ; leur nombre égale celui des politiques livrées qui portent
//   `form-action 'none'` (en-tête servi, balise meta), au moins une.
// - `form-dialog-allowed` : un `<form method="dialog">` dans un `<dialog open>`
//   ferme le dialogue sans aucune violation (HTML : aucune navigation).
export async function runFormActionChecks(
    page,
    check,
    { violations, violationsName, servedHeader, routed }
) {
    const settle = () =>
        page.evaluate(
            (delay) => new Promise((done) => setTimeout(done, delay)),
            SETTLE_MS
        );
    await check('form-action-none', async () => {
        const href = page.url();
        const before = (await violations()).length;
        const meta = await page
            .locator('meta[http-equiv="Content-Security-Policy"]')
            .getAttribute('content');
        const expected = formActionSources([servedHeader, meta]);
        await page.evaluate(() => {
            const form = document.createElement('form');
            form.setAttribute('method', 'post');
            form.setAttribute('action', '/sonde');
            document.body.appendChild(form);
            form.requestSubmit();
        });
        // Une soumission non bloquée navigue : l'attente échoue (délai ou
        // contexte détruit), puis l'URL nomme la cause.
        const reported = await page
            .waitForFunction(
                ([name, count]) => globalThis[name].length >= count,
                [violationsName, before + Math.max(expected, 1)],
                { timeout: READY_TIMEOUT_MS }
            )
            .then(
                () => true,
                () => false
            );
        if (reported) await settle();
        assert.equal(page.url(), href, 'soumission native non bloquée');
        assert.ok(reported, 'violation form-action non rapportée');
        assert.ok((await page.locator(routed).count()) > 0, 'document changé');
        const added = (await violations()).slice(before);
        assert.ok(
            added.every((entry) => entry.startsWith('form-action ')),
            added.join(' | ')
        );
        assert.ok(
            expected >= 1,
            "aucune politique ne porte form-action 'none'"
        );
        assert.equal(added.length, expected);
    });
    await check('form-dialog-allowed', async () => {
        const before = (await violations()).length;
        const open = await page.evaluate(() => {
            const dialog = document.createElement('dialog');
            dialog.setAttribute('open', '');
            const form = document.createElement('form');
            form.setAttribute('method', 'dialog');
            dialog.appendChild(form);
            document.body.appendChild(dialog);
            form.requestSubmit();
            return dialog.open;
        });
        await settle();
        assert.equal(open, false, 'dialogue resté ouvert');
        assert.deepEqual((await violations()).slice(before), []);
    });
}

// Assertions communes, quel que soit le serveur. `server.update(index)` remplace
// index.html servi ; `server.stop()` arrête réellement le serveur.
export async function runShellBrowserChecks(
    launched,
    origin,
    server,
    { expectation, files, api, prefix }
) {
    // Noms au préfixe du produit servi : caches, politique, CSP.
    const forms = productForms(prefix);
    const { results, check } = relayCheckRecorder(prefix);
    const context = await launched.newContext();
    await context.addInitScript((name) => {
        const violations = [];
        Object.defineProperty(globalThis, name, {
            value: violations,
        });
        document.addEventListener('securitypolicyviolation', (event) =>
            violations.push(`${event.effectiveDirective} ${event.sample}`)
        );
    }, VIOLATIONS);
    const page = await context.newPage();
    const violations = () =>
        page.evaluate((name) => globalThis[name], VIOLATIONS);
    // Politique servie en en-tête, lue AVANT toute assertion (les sondes
    // `form-action` en dérivent leur compte, même si la vérification 10 échoue).
    let servedHeader;
    try {
        await check('10-trusted-types-on-nginx', async () => {
            const response = await page.goto(origin + '/');
            servedHeader = response.headers()['content-security-policy'];
            assert.equal(response.status(), 200);
            assert.equal(servedHeader, externalCspHeader(prefix));
            // En-tête ET balise meta égaux, chacun, au texte rendu par l'atelier.
            const meta = page.locator(
                'meta[http-equiv="Content-Security-Policy"]'
            );
            assert.equal(await meta.count(), 1);
            assert.equal(
                await meta.getAttribute('content'),
                externalCspMeta(prefix)
            );
            await page
                .locator(ROUTED)
                .first()
                .waitFor({ timeout: READY_TIMEOUT_MS });
            assert.deepEqual(await violations(), []);
        });
        await check('8-service-worker-registered', async () => {
            const registration = await page.evaluate(
                (timeout) =>
                    Promise.race([
                        navigator.serviceWorker.ready.then((ready) => ({
                            scope: ready.scope,
                            script: ready.active?.scriptURL,
                        })),
                        new Promise((done) =>
                            setTimeout(() => done('timeout'), timeout)
                        ),
                    ]),
                READY_TIMEOUT_MS
            );
            assert.deepEqual(registration, {
                scope: origin + '/',
                script: origin + '/sw.js',
            });
            assert.deepEqual(await violations(), []);
        });
        await check('8-reload-new-document', async () => {
            await server.update((index) =>
                index.replace(
                    '</head>',
                    `<meta name="${DEPLOY}" content="2"></head>`
                )
            );
            await page.reload();
            await page
                .locator(ROUTED)
                .first()
                .waitFor({ timeout: READY_TIMEOUT_MS });
            assert.equal(
                await page.locator(`meta[name="${DEPLOY}"]`).count(),
                1
            );
            assert.equal(
                await page.evaluate(() =>
                    Boolean(navigator.serviceWorker.controller)
                ),
                true
            );
            assert.deepEqual(await violations(), []);
        });
        await check(`${forms.kebab}sw-policy-closed`, async () => {
            const outcome = await page.evaluate(
                (names) => {
                    const attempt = (name) => {
                        try {
                            globalThis.trustedTypes.createPolicy(name, {});
                            return 'created';
                        } catch (error) {
                            return error.name;
                        }
                    };
                    return {
                        duplicate: attempt(names.duplicate),
                        unlisted: attempt(names.unlisted),
                    };
                },
                {
                    duplicate: `${forms.kebab}sw`,
                    unlisted: `${forms.kebab}other`,
                }
            );
            assert.deepEqual(outcome, {
                duplicate: 'TypeError',
                unlisted: 'TypeError',
            });
        });
        await check('sinks-still-blocked', async () => {
            const outcome = await page.evaluate(() => {
                const blocked = (run) => {
                    try {
                        run();
                        return 'allowed';
                    } catch (error) {
                        return error.name;
                    }
                };
                return {
                    innerHTML: blocked(() => {
                        document.createElement('div').innerHTML = '<b>x</b>';
                    }),
                    worker: blocked(() => new Worker('/sw.js')),
                };
            });
            assert.deepEqual(outcome, {
                innerHTML: 'TypeError',
                worker: 'TypeError',
            });
        });
        // Garde de sécurité des deux variantes : la page appelle réellement le
        // relais (fetch GET, fetch POST, image GET) ; le cache ne contient
        // jamais /api/, jamais une requête autre que GET, jamais une autre
        // origine.
        await check('cache-security', async () => {
            const statuses = await page.evaluate(async (base) => {
                const image = await new Promise((done) => {
                    const element = new Image();
                    element.onload = element.onerror = () => done('image');
                    element.src = base + 'ok?image';
                });
                return [
                    (await fetch(base + 'ok')).status,
                    (await fetch(base + 'echo', { method: 'POST', body: 'x' }))
                        .status,
                    image,
                ];
            }, api);
            assert.deepEqual(statuses, [200, 200, 'image']);
            const requests = await page.evaluate(async () =>
                (
                    await Promise.all(
                        (await caches.keys()).map(async (name) =>
                            (await (await caches.open(name)).keys()).map(
                                (entry) => [entry.method, entry.url]
                            )
                        )
                    )
                ).flat()
            );
            assert.ok(requests.length > 0, 'cache vide');
            for (const [method, url] of requests) {
                assert.equal(method, 'GET', url);
                assert.equal(new URL(url).origin, origin, url);
                assert.ok(!new URL(url).pathname.startsWith('/api'), url);
            }
        });
        // Après la vérification 10 (qui exige un tableau VIDE) et après les
        // vérifications 8 qui l'exigent aussi dans le même document ; avant
        // l'arrêt du serveur.
        await runFormActionChecks(page, check, {
            violations,
            violationsName: VIOLATIONS,
            servedHeader,
            routed: ROUTED,
        });
        await check('8-offline-document', async () => {
            const cached = await page.evaluate(async () =>
                Promise.all(
                    (await caches.keys()).map(async (name) => [
                        name,
                        (await (await caches.open(name)).keys())
                            .map((entry) => new URL(entry.url).pathname)
                            .sort(),
                    ])
                )
            );
            expectation.cache(cached, files, forms);
            await server.stop();
            const response = await page.goto(origin + '/');
            assert.equal(response?.status(), 200);
            assert.equal(
                response?.fromServiceWorker(),
                true,
                'servi par le service worker'
            );
            assert.equal(
                await page.locator(`meta[name="${DEPLOY}"]`).count(),
                expectation.offlineDeploy
            );
            if (expectation.bootsOffline)
                await page
                    .locator(ROUTED)
                    .first()
                    .waitFor({ timeout: READY_TIMEOUT_MS });
            assert.equal(
                await page
                    .locator('meta[http-equiv="Content-Security-Policy"]')
                    .count(),
                1
            );
        });
    } finally {
        await context.close();
    }
    return results;
}

// Variante déclarée d'une coque Angular : session et offline_policy, lues dans
// la conception que référence son manifeste.
export async function shellVariant(product, app) {
    const manifest = JSON.parse(
        await readFile(
            join(product, 'apps', app, SIGNATURE_FILES.appManifest),
            'utf8'
        )
    );
    if (manifest.profile !== 'angular-pwa') return null;
    const design = JSON.parse(
        await readFile(join(product, manifest.design_ref.path), 'utf8')
    );
    const experience = design.experiences.find(
        (entry) => entry.id === manifest.experience_id
    );
    assert.ok(experience, `${app} : expérience introuvable`);
    const key = `${experience.session ? 'session' : 'shell'}:${experience.offline_policy}`;
    assert.ok(EXPECTATIONS[key], `${app} : variante non qualifiée ${key}`);
    return key;
}

// Coques Angular construites avec service worker, et Chromium d'une racine de
// preuve native.
export async function fromProofRoot(root) {
    const shells = [];
    for (const product of (await readdir(root))
        .filter((name) => name.startsWith('product-'))
        .sort()) {
        const dist = join(root, product, 'dist', 'apps');
        for (const app of (await readdir(dist).catch(() => [])).sort()) {
            const build = join(dist, app, 'browser');
            const files = await readdir(build).catch(() => []);
            if (!files.includes('sw.js')) continue;
            const variant = await shellVariant(join(root, product), app);
            if (variant)
                shells.push({
                    app: `${product}/${app}`,
                    build,
                    variant,
                    prefix: await sealedProductPrefix(join(root, product)),
                });
        }
    }
    const browsers = (await readdir(join(root, 'browser'), { recursive: true }))
        .filter((path) => /(?:^|\/)chrome-headless-shell$/.test(path))
        .map((path) => join(root, 'browser', path));
    for (const variant of Object.keys(EXPECTATIONS))
        assert.ok(
            shells.some((shell) => shell.variant === variant),
            `aucune coque construite pour ${variant}`
        );
    assert.equal(browsers.length, 1, 'Chromium de la preuve introuvable');
    return { shells, browser: browsers[0] };
}

// Le relais sert-il le nouveau document ? Le partage de fichiers de Docker
// Desktop (macOS) propage une écriture avec un court délai ; sous Linux, la
// première lecture suffit. Borné : au-delà, la preuve échoue.
async function waitServed(port, expected) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await get(port, '/index.html')).body === expected) return;
        await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error('nouveau document non servi par le relais');
}

export async function runRelayBrowserChecks({
    build,
    browser,
    variant,
    prefix,
    mutateServiceWorker = false,
    weakenFormActionIn = [],
}) {
    // Le relais est rendu au préfixe du produit servi : sa CSP, son dossier
    // nginx et son filtre doivent être ceux du build.
    const { files, table } = await relayFixture({ prefix });
    const root = await mkdtemp(join(tmpdir(), signatureName('nginx-browser-')));
    try {
        await stage(root, files, { prefix });
        await rm(join(root, 'html'), { recursive: true, force: true });
        await cp(build, join(root, 'html'), { recursive: true });
        const index = join(root, 'html', 'index.html');
        const builtFiles = await readdir(join(root, 'html'));
        // Contre-mutation : un service worker qui met /api/ en cache.
        if (mutateServiceWorker)
            await writeFile(
                join(root, 'html', 'sw.js'),
                (await readFile(join(root, 'html', 'sw.js'), 'utf8')) +
                    SW_CACHES_API
            );
        // Contre-mutations `form-action` : la copie de l'en-tête, la balise
        // meta de la copie du build, ou les deux.
        const formActionFiles = {
            header: join(root, HOST_CONF, 'content-security-policy.conf'),
            meta: index,
        };
        for (const source of weakenFormActionIn)
            await weakenFormAction(formActionFiles[source]);
        return await withRelay(
            root,
            table[0].variable,
            'http://svc:8000/',
            async (port, _network, relay) => {
                const { chromium } = await import('@playwright/test');
                const launched = await chromium.launch({
                    executablePath: browser,
                    headless: true,
                });
                try {
                    return await runShellBrowserChecks(
                        launched,
                        `http://127.0.0.1:${port}`,
                        {
                            update: async (change) => {
                                const next = change(
                                    await readFile(index, 'utf8')
                                );
                                await writeFile(index, next);
                                await waitServed(port, next);
                            },
                            stop: async () => stopRelay(relay),
                        },
                        {
                            expectation: EXPECTATIONS[variant],
                            files: builtFiles,
                            api: table[0].path,
                            prefix,
                        }
                    );
                } finally {
                    await launched.close();
                }
            },
            { prefix }
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

async function main() {
    const index = process.argv.indexOf('--browser-proof-root');
    assert.ok(
        index > 0 && process.argv[index + 1],
        'usage : --browser-proof-root <racine>'
    );
    const { shells, browser } = await fromProofRoot(process.argv[index + 1]);
    const results = {};
    for (const shell of shells)
        for (const [name, outcome] of Object.entries(
            await runRelayBrowserChecks({ ...shell, browser })
        ))
            results[`${shell.app} ${shell.variant} ${name}`] = outcome;
    let failed = 0;
    // Contre-mutation par variante : la garde de cache devient rouge.
    let killed = 0;
    if (process.argv.includes('--mutations'))
        for (const variant of Object.keys(EXPECTATIONS)) {
            const shell = shells.find((entry) => entry.variant === variant);
            const mutated = await runRelayBrowserChecks({
                ...shell,
                browser,
                mutateServiceWorker: true,
            });
            const red = mutated['cache-security'] !== 'PASS';
            console.log(
                `${red ? 'PASS' : 'FAIL'} nginx-relay-browser/mutation sw-caches-api ${shell.app} -> cache-security ${red ? 'red' : 'still green'}`
            );
            if (red) killed += 1;
            else failed += 1;
        }
    // Contre-mutations `form-action`, par coque : une ligne par mutant et par
    // coque ; mort SPÉCIFIQUE (la vérification nommée rougit) ; sous une seule
    // source affaiblie, la sonde comportementale reste verte (l'autre source
    // bloque encore : intersection des deux politiques).
    let formActionKilled = 0;
    const formActionMutants = process.argv.includes('--mutations')
        ? FORM_ACTION_MUTATIONS.length * shells.length
        : 0;
    if (formActionMutants)
        for (const shell of shells)
            for (const mutation of FORM_ACTION_MUTATIONS) {
                const mutated = await runRelayBrowserChecks({
                    ...shell,
                    browser,
                    weakenFormActionIn: mutation.sources,
                });
                const red = mutated[mutation.killedBy] !== 'PASS';
                const green =
                    !mutation.stillGreen ||
                    mutated[mutation.stillGreen] === 'PASS';
                console.log(
                    `${red && green ? 'PASS' : 'FAIL'} nginx-relay-browser/mutation ${mutation.id} ${shell.app} -> ${mutation.killedBy} ${red ? 'red' : 'still green'}${mutation.stillGreen ? `, ${mutation.stillGreen} ${mutated[mutation.stillGreen]}` : ''}`
                );
                if (red && green) formActionKilled += 1;
                else failed += 1;
            }
    for (const [name, outcome] of Object.entries(results)) {
        console.log(
            `${outcome === 'PASS' ? 'PASS' : 'FAIL'} nginx-relay-browser/${name}${outcome === 'PASS' ? '' : ' ' + outcome.slice(5)}`
        );
        if (outcome !== 'PASS') failed += 1;
    }
    const expected = RELAY_BROWSER_CHECKS.length * shells.length;
    console.log(
        `nginx-relay-browser checks=${Object.keys(results).length}/${expected} failed=${failed}`
    );
    process.exitCode =
        failed ||
        Object.keys(results).length !== expected ||
        formActionKilled !== formActionMutants
            ? 1
            : 0;
    if (killed) console.log(`nginx-relay-browser mutations killed=${killed}`);
    if (formActionMutants)
        console.log(
            `nginx-relay-browser form-action mutations killed=${formActionKilled}/${formActionMutants}`
        );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

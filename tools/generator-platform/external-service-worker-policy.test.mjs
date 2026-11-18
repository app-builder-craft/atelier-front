// Coque extérieure : enregistrement du service worker sous Trusted Types par la
// politique `<préfixe>-sw` du main.ts généré. Lecture statique du rendu, puis
// exécution du main.ts compilé dans un contexte isolé, navigateur simulé :
// avec Trusted Types, sans Trusted Types, et création de politique en échec.
// Le navigateur réel est mesuré par check:nginx-relay-browser.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import ts from 'typescript';

import { renderAngularPwaShell } from './renderers/angular-pwa-shell-renderer.mjs';
import { adaptExternalShellFiles } from './renderers/application-workspace-renderer.mjs';
import {
    externalCspHeader,
    externalCspMeta,
} from './renderers/external-content-security-policy.mjs';
import { FIXTURE_PREFIX } from './test-support/application-design-fixture.mjs';
import { createApplicationSessionFixture } from './test-support/application-session-fixture.mjs';
import { applicationDesign } from './test-support/application-design-fixture.mjs';
import { hash } from './test-support/external-application-fixture.mjs';
import { SESSION_FIXTURE_DOMAINS } from './test-support/external-session-fixture.mjs';

// Politique Trusted Types du service worker, au préfixe du produit fictif.
const SW_POLICY = `${FIXTURE_PREFIX}-sw`;
const EXTERNAL_CSP_META = externalCspMeta(FIXTURE_PREFIX);
const EXTERNAL_CSP_HEADER = externalCspHeader(FIXTURE_PREFIX);

async function renderMains(t) {
    const data = await createApplicationSessionFixture({
        domain: SESSION_FIXTURE_DOMAINS[0],
    });
    t.after(() => rm(data.root, { recursive: true, force: true }));
    const render = async (externalWorkspace) =>
        (
            await renderAngularPwaShell({
                design: data.design,
                experienceId: data.design.experiences[0].id,
                appName: 'session-sw',
                designPath: 'design/sw.json',
                designSha256: hash('sw'),
                externalWorkspace,
                prefix: FIXTURE_PREFIX,
            })
        ).files;
    return { atelier: await render(false), external: await render(true) };
}

function calls(source, name) {
    const found = [];
    const file = ts.createSourceFile(
        'main.ts',
        source,
        ts.ScriptTarget.ES2022,
        true
    );
    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const called = ts.isPropertyAccessExpression(callee)
                ? callee.name.text
                : ts.isIdentifier(callee)
                  ? callee.text
                  : undefined;
            if (called === name) found.push(node.getStart(file));
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return { found, file };
}

// Exécute le main.ts compilé, imports remplacés par des témoins.
async function execute(main, { trustedTypes } = {}) {
    const output = ts.transpileModule(main, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText;
    assert.doesNotMatch(output, /^\s*export\b/m);
    const seen = { bootstrap: 0, register: [] };
    const sandbox = {
        App: {},
        appConfig: {},
        bootstrapApplication: () => {
            seen.bootstrap += 1;
            return Promise.resolve();
        },
        navigator: {
            serviceWorker: {
                register: (url) => {
                    seen.register.push(url);
                    return Promise.resolve();
                },
            },
        },
        document: {},
        console,
    };
    if (trustedTypes) sandbox.trustedTypes = trustedTypes;
    vm.createContext(sandbox);
    let error;
    try {
        vm.runInContext(output.replace(/^import [^;]+;$/gm, ''), sandbox);
    } catch (thrown) {
        error = thrown;
    }
    await new Promise((done) => setImmediate(done));
    return { seen, error, sandbox };
}

function fakeTrustedTypes() {
    const created = [];
    return {
        created,
        createPolicy(name, rules) {
            created.push({ name, rules });
            return {
                createScriptURL: (input) => ({
                    trusted: rules.createScriptURL(input),
                }),
            };
        },
    };
}

test(`${SW_POLICY} : politique de la coque, sans allow-duplicates, en meta comme en en-tête`, () => {
    for (const policy of [EXTERNAL_CSP_META, EXTERNAL_CSP_HEADER]) {
        const directive = policy
            .split('; ')
            .find((entry) => entry.startsWith('trusted-types '));
        assert.equal(
            directive,
            `trusted-types angular angular#bundler ${SW_POLICY}`
        );
        assert.doesNotMatch(policy, /allow-duplicates/);
    }
});

test(`${SW_POLICY} : créée une fois, avant l’amorçage, locale au module ; mode atelier inchangé`, async (t) => {
    const { atelier, external } = await renderMains(t);
    const main = external['src/main.ts'];
    const policies = calls(main, 'createPolicy');
    const bootstraps = calls(main, 'bootstrapApplication');
    assert.equal(policies.found.length, 1);
    assert.equal(bootstraps.found.length, 1);
    assert.ok(
        policies.found[0] < bootstraps.found[0],
        'création avant l’amorçage'
    );
    // Premier code exécuté : rien entre les imports et la politique, sauf des
    // déclarations de type et la constante de l'URL.
    for (const statement of policies.file.statements) {
        // L'instruction qui contient l'appel est la constante de la politique.
        if (statement.getEnd() > policies.found[0]) {
            assert.match(
                statement.getText(policies.file),
                /^const serviceWorkerPolicy = /
            );
            break;
        }
        assert.ok(
            ts.isImportDeclaration(statement) ||
                ts.isInterfaceDeclaration(statement) ||
                (ts.isVariableStatement(statement) &&
                    statement.getText(policies.file) ===
                        "const SERVICE_WORKER_URL = '/sw.js';"),
            statement.getText(policies.file)
        );
    }
    assert.match(
        main,
        new RegExp(`trustedTypes\\?\\.createPolicy\\('${SW_POLICY}', \\{`)
    );
    assert.doesNotMatch(main, /^\s*export\b/m);
    // Code seul, commentaires retirés : rien n'est attaché au global.
    const code = ts.transpileModule(main, {
        compilerOptions: { removeComments: true },
    }).outputText;
    assert.doesNotMatch(code, /\b(?:window|self)\b/);
    assert.doesNotMatch(code, /globalThis[^;]*\.[\w$]+\s*=[^=]/);
    assert.doesNotMatch(code, /Object\.(?:defineProperty|assign)|Reflect\./);
    // Le mode atelier garde son main.ts, sans politique ni CSP.
    assert.doesNotMatch(atelier['src/main.ts'], /createPolicy|trustedTypes/);
    assert.match(
        atelier['src/main.ts'],
        /navigator\.serviceWorker\.register\('\/sw\.js'\)/
    );
});

test(`${SW_POLICY} : URL exacte acceptée, toute autre refusée ; enregistrement par la valeur de confiance`, async (t) => {
    const { external } = await renderMains(t);
    const trustedTypes = fakeTrustedTypes();
    const { seen, error } = await execute(external['src/main.ts'], {
        trustedTypes,
    });
    assert.equal(error, undefined);
    assert.deepEqual(
        trustedTypes.created.map((entry) => entry.name),
        [SW_POLICY]
    );
    assert.equal(seen.bootstrap, 1);
    assert.deepEqual(seen.register, [{ trusted: '/sw.js' }]);
    const { rules } = trustedTypes.created[0];
    assert.equal(rules.createScriptURL('/sw.js'), '/sw.js');
    for (const refused of [
        '',
        'sw.js',
        './sw.js',
        '/sw.js?v=2',
        '/sw.js#x',
        '/sw.js/',
        '/SW.js',
        ' /sw.js',
        '/sw.js\n',
        '/other.js',
        '//example.invalid/sw.js',
        'http://127.0.0.1/sw.js',
        'data:text/javascript,0',
        'blob:http://127.0.0.1/0',
    ])
        assert.throws(
            () => rules.createScriptURL(refused),
            {
                name: 'TypeError',
                message: `${SW_POLICY}: service worker URL refused`,
            },
            JSON.stringify(refused)
        );
});

test(`${SW_POLICY} : sans Trusted Types, chaîne littérale ; création en échec, erreur remontée sans repli`, async (t) => {
    const { external } = await renderMains(t);
    const main = external['src/main.ts'];
    const absent = await execute(main);
    assert.equal(absent.error, undefined);
    assert.equal(absent.seen.bootstrap, 1);
    assert.deepEqual(absent.seen.register, ['/sw.js']);
    // Trusted Types présent, création refusée (doublon, nom hors liste) :
    // l'erreur remonte, ni amorçage, ni enregistrement.
    const failing = await execute(main, {
        trustedTypes: {
            createPolicy() {
                throw new TypeError(`Policy "${SW_POLICY}" disallowed.`);
            },
        },
    });
    assert.equal(failing.error?.message, `Policy "${SW_POLICY}" disallowed.`);
    assert.equal(failing.seen.bootstrap, 0);
    assert.deepEqual(failing.seen.register, []);
    // Rien n'est attaché au global.
    const present = await execute(main, { trustedTypes: fakeTrustedTypes() });
    assert.deepEqual(Object.keys(present.sandbox).sort(), [
        'App',
        'appConfig',
        'bootstrapApplication',
        'console',
        'document',
        'navigator',
        'trustedTypes',
    ]);
});

test(`${SW_POLICY} : un main.ts d’atelier qui a dérivé arrête la coque extérieure`, async (t) => {
    const { atelier } = await renderMains(t);
    const files = {
        ...atelier,
        'src/main.ts': atelier['src/main.ts'].replace(
            "register('/sw.js')",
            "register('/other.js')"
        ),
    };
    assert.throws(
        () =>
            adaptExternalShellFiles(files, {
                profile: 'angular-pwa',
                appName: 'session-sw',
                prefix: FIXTURE_PREFIX,
            }),
        /application shell: main\.ts is not the shell main/
    );
});

// Le gestionnaire fetch d'un sw.js, exécuté dans un contexte isolé : renvoie
// les requêtes que le service worker prend en charge (respondWith).
function handled(worker, requests) {
    const listeners = {};
    const sandbox = {
        URL,
        self: {
            location: { origin: 'http://127.0.0.1:8080' },
            addEventListener: (type, listener) => {
                listeners[type] = listener;
            },
            clients: { claim: () => Promise.resolve() },
        },
        caches: {},
        fetch: () => new Promise(() => undefined),
    };
    vm.createContext(sandbox);
    vm.runInContext(worker, sandbox);
    return requests.filter(([url, destination, method = 'GET']) => {
        let responded = false;
        listeners.fetch({
            request: {
                url: 'http://127.0.0.1:8080' + url,
                method,
                destination,
                mode: destination === 'document' ? 'navigate' : 'no-cors',
            },
            respondWith: () => {
                responded = true;
            },
        });
        return responded;
    });
}

const API_REQUESTS = [
    ['/api/svc/avatar.png', 'image'],
    ['/api/svc/report', 'document'],
    ['/api/svc/x.js', 'script'],
    ['/api/svc/x.css', 'style'],
    ['/api/svc/f.woff2', 'font'],
    ['/api/svc/data', ''],
    ['/api', 'document'],
    ['/api/', 'image'],
];

test('sw.js extérieur : jamais /api/ pris en charge, quelle que soit la destination ; mode atelier inchangé', async () => {
    const design = applicationDesign('a'.repeat(64), 'b'.repeat(64));
    const experience = design.experiences.find((entry) => !entry.session);
    const render = async (externalWorkspace) =>
        (
            await renderAngularPwaShell({
                design,
                experienceId: experience.id,
                appName: 'shell-sw',
                designPath: 'design/shell.json',
                designSha256: hash('shell'),
                externalWorkspace,
                prefix: FIXTURE_PREFIX,
            })
        ).files['public/sw.js'];
    const atelier = await render(false);
    const external = await render(true);
    assert.doesNotMatch(atelier, /\/api/);
    assert.equal(external.match(/\/\^\\\/api\(\?:\\\/\|\$\)\//g).length, 1);
    assert.deepEqual(handled(external, API_REQUESTS), []);
    // Ressources de la coque : toujours prises en charge (contrôle positif).
    const shell = [
        ['/', 'document'],
        ['/main-ABC.js', 'script'],
        ['/styles-ABC.css', 'style'],
        ['/icon.svg', 'image'],
        ['/apiary.png', 'image'],
    ];
    assert.deepEqual(handled(external, shell), shell);
    // Le mode atelier garde son comportement : toute requête /api/ de
    // destination cacheable y reste prise en charge (fetch() exclu).
    assert.deepEqual(
        handled(atelier, API_REQUESTS),
        API_REQUESTS.filter(([, destination]) => destination !== '')
    );
    // Un sw.js d'atelier qui a dérivé arrête la coque extérieure.
    const files = {
        ...(
            await renderAngularPwaShell({
                design,
                experienceId: experience.id,
                appName: 'shell-sw',
                designPath: 'design/shell.json',
                designSha256: hash('shell'),
                externalWorkspace: false,
                prefix: FIXTURE_PREFIX,
            })
        ).files,
    };
    files['public/sw.js'] = files['public/sw.js'].replace(
        'requestUrl.origin !== self.location.origin',
        'requestUrl.origin === null'
    );
    assert.throws(
        () =>
            adaptExternalShellFiles(files, {
                profile: 'angular-pwa',
                appName: 'shell-sw',
                prefix: FIXTURE_PREFIX,
            }),
        /application shell: sw\.js is not the shell worker/
    );
});

test('sw.js de session extérieur : jamais /api/, seulement document, manifeste et icône', async (t) => {
    const { external } = await renderMains(t);
    const worker = external['public/sw.js'];
    assert.ok(worker.includes(`${FIXTURE_PREFIX}-session-static-v1`));
    assert.deepEqual(handled(worker, API_REQUESTS), []);
    assert.deepEqual(
        handled(worker, [
            ['/', 'document'],
            ['/index.html', 'document'],
            ['/manifest.webmanifest', 'manifest'],
            ['/icon.svg', 'image'],
            ['/main-ABC.js', 'script'],
            ['/index.html?x=1', 'document'],
        ]).map(([url]) => url),
        ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']
    );
});

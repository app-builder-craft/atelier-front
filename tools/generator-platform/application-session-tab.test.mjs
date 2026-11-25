// Lot 2, commit 4 : session gardée dans l'onglet (cadrage § 22 ; conception
// v3 V3.7, v4 V4.7). Unitaires des fonctions PURES de la projection (le module
// rendu `session.projection.ts`, transpilé tel quel) et contrôle de texte des
// fichiers rendus de la coque et du socle (V3.7.10 point 1, corrigé par V4.7
// points 3, 5 et 9).
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import ts from 'typescript';
import { sessionRenderConfiguration } from './core/application-design-session.mjs';
import { sha256, stableStringify } from './core/generation-manifest.mjs';
import { productNameForms } from './core/product-identity.mjs';
import { assertOnlyPrefix } from './core/product-prefix-rename.mjs';
import {
    renderAngularApplicationSession,
    renderSessionProjection,
    tabSessionKey,
} from './renderers/angular-application-session-renderer.mjs';
import { renderAngularPwaShell } from './renderers/angular-pwa-shell-renderer.mjs';
import { FIXTURE_PREFIX } from './test-support/application-design-fixture.mjs';
import {
    createApplicationSessionFixture,
    SESSION_FIXTURE_DOMAINS,
} from './test-support/application-session-fixture.mjs';

const projection = await import(
    'data:text/javascript;base64,' +
        Buffer.from(
            ts.transpileModule(renderSessionProjection(), {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.ESNext,
                },
            }).outputText
        ).toString('base64')
);
const APP = 'tab-session';
const FAMILY = 'clé de session de l’onglet';
const FIELDS = [
    'acknowledged',
    'app',
    'config',
    'menu',
    'paths',
    'permissions',
    'stages',
    'token',
    'v',
];

async function domainSession(t, domain) {
    const fixture = await createApplicationSessionFixture({ domain });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const config = sessionRenderConfiguration(
        fixture.design,
        fixture.design.experiences[0]
    );
    return {
        fixture,
        config,
        digest: sha256(stableStringify(config)),
        session: projection.projectSession(
            projection.snapshot(fixture.sessionResult),
            config
        ),
    };
}

const restore = (raw, { config, digest }) =>
    projection.restoreTabSession(raw, APP, digest, config);
const plain = (session) => ({
    token: session.token,
    menu: session.menu,
    paths: [...session.paths],
    permissions: [...session.permissions],
    stages: { ...session.stages },
    acknowledged: [...session.acknowledged].sort(),
});

for (const domain of SESSION_FIXTURE_DOMAINS) {
    test(`V3.7.2 : la projection exacte, jamais la réponse du producteur : ${domain}`, async (t) => {
        const context = await domainSession(t, domain);
        const { fixture, config, digest, session } = context;
        const raw = projection.serializeTabSession(session, APP, digest);
        const value = JSON.parse(raw);
        assert.deepEqual(Object.keys(value).sort(), FIELDS);
        assert.equal(value.v, 1);
        assert.equal(value.app, APP);
        assert.equal(value.config, digest);
        // Chaque étape porte le RÉSULTAT de son prédicat, jamais la valeur lue.
        assert.deepEqual(
            Object.keys(value.stages),
            config.stages.map((stage) => stage.id)
        );
        for (const stage of config.stages) {
            const read = projection.pointer(
                fixture.sessionResult,
                stage.predicate.pointer
            );
            assert.equal(
                value.stages[stage.id],
                stage.predicate.operator === 'is-null'
                    ? read === null
                    : read === true,
                stage.id
            );
        }
        assert.deepEqual(value.acknowledged, []);
        // Ni le sujet ni le reste de la réponse : seuls le jeton, le menu, les
        // chemins et les permissions en sortent.
        const subject = projection.pointer(
            fixture.sessionResult,
            config.projection.subject_pointer
        );
        for (const [field, entry] of Object.entries(subject)) {
            const kept = [
                config.projection.menu_pointer,
                config.projection.allowed_paths_pointer,
                config.projection.permissions_pointer,
                ...config.stages.map((stage) => stage.predicate.pointer),
            ].some((path) =>
                (path ?? '').startsWith(
                    `${config.projection.subject_pointer}/${field}`
                )
            );
            if (!kept && typeof entry === 'string')
                assert.equal(raw.includes(entry), false, field);
        }
        assert.equal(raw.includes('Fixture operator'), false);
        // Reprise : la même projection, la même étape en cours.
        const restored = restore(raw, context);
        assert.deepEqual(plain(restored), plain(session));
        assert.equal(
            projection.pendingStage(restored, config)?.id,
            projection.pendingStage(session, config)?.id
        );
        assert.ok(projection.pendingStage(session, config));
        // Une étape franchie le reste après la reprise (attente S2 du lot 4).
        const first = projection.pendingStage(session, config).id;
        const advanced = Object.freeze({
            ...session,
            acknowledged: new Set([first]),
        });
        const again = restore(
            projection.serializeTabSession(advanced, APP, digest),
            context
        );
        assert.deepEqual([...again.acknowledged], [first]);
        assert.notEqual(projection.pendingStage(again, config)?.id, first);
    });

    test(`S8 et S13 : chaque règle de la reprise échoue fermé ; étapes falsifiées bien formées ADMISES : ${domain}`, async (t) => {
        const context = await domainSession(t, domain);
        const { config, digest, session } = context;
        const raw = projection.serializeTabSession(session, APP, digest);
        const base = () => JSON.parse(raw);
        const edited = (change) => {
            const value = base();
            change(value);
            return JSON.stringify(value);
        };
        const max = projection.TAB_SESSION_MAX_CHARS;
        assert.equal(max, 2621440);
        // Borne AVANT l'analyse : exactement la borne passe, un caractère de
        // plus est refusé (le JSON reste valide : seule la borne le refuse).
        assert.deepEqual(
            plain(restore(raw + ' '.repeat(max - raw.length), context)),
            plain(session)
        );
        const ids = config.stages.map((stage) => stage.id);
        const refused = [
            [
                'taille au-dessus de la borne',
                raw + ' '.repeat(max - raw.length + 1),
            ],
            ['valeur non textuelle', 42],
            ['JSON invalide', raw.slice(0, -1)],
            ['valeur non objet', '[]'],
            ['clé en trop', edited((value) => (value.subject = {}))],
            ['clé manquante', edited((value) => delete value.config)],
            ['autre appli', edited((value) => (value.app = 'autre-appli'))],
            ['v faux', edited((value) => (value.v = 2))],
            [
                'S13 : configuration de session différente',
                edited((value) => (value.config = '0'.repeat(64))),
            ],
            ['jeton avec espace', edited((value) => (value.token = 'a b'))],
            ['jeton vide', edited((value) => (value.token = ''))],
            [
                'jeton trop long',
                edited((value) => (value.token = 'x'.repeat(8193))),
            ],
            ['chemins non textuels', edited((value) => (value.paths = [1]))],
            [
                'permissions hors liste',
                edited((value) => (value.permissions = 'tout')),
            ],
            [
                'menu refusé par sessionMenu',
                edited((value) => (value.menu = 'menu')),
            ],
            [
                'étape inconnue',
                edited((value) => (value.stages.inconnue = true)),
            ],
            ['étape manquante', edited((value) => delete value.stages[ids[0]])],
            [
                'étape non booléenne',
                edited((value) => (value.stages[ids[0]] = 'oui')),
            ],
            [
                'étape franchie inconnue',
                edited((value) => (value.acknowledged = ['inconnue'])),
            ],
            [
                'étape franchie en double',
                edited((value) => (value.acknowledged = [ids[0], ids[0]])),
            ],
            [
                'objet hérité',
                edited((value) => (value.stages = { __proto__: null })),
            ],
        ];
        for (const [name, value] of refused)
            assert.throws(
                () => restore(value, context),
                /SessionFailure|ne peut pas/,
                name
            );
        // Gardes d'AFFICHAGE (V4.7 point 6) : des étapes falsifiées mais bien
        // formées sont admises ; l'autorité reste le serveur.
        const skipped = restore(
            edited((value) => {
                for (const id of ids) value.stages[id] = false;
            }),
            context
        );
        assert.equal(projection.pendingStage(skipped, config), null);
        // Un chemin non admis du menu est admis mais FILTRÉ, comme à
        // l'ouverture (V3.7.3 point 4 : « menu accepté par sessionMenu »).
        const menu = structuredClone(session.menu);
        const label = config.menu.label_pointer.slice(1);
        const path = config.menu.path_pointer.slice(1);
        const items = Array.isArray(menu) ? menu : [];
        items.push({ [label]: 'Hors route', [path]: '/hors-route' });
        const forged = restore(
            edited((value) => (value.menu = items)),
            context
        );
        const shown = projection.sessionMenu(
            forged.menu,
            forged.paths,
            forged.permissions,
            config
        );
        assert.equal(JSON.stringify(shown).includes('/hors-route'), false);
    });
}

test('S12 : une ancienne clé de l’onglet laissée dans la coque est refusée au renommage (famille de MARQUE)', () => {
    assert.throws(
        () =>
            assertOnlyPrefix(
                {
                    'apps/x/src/app/app.config.ts':
                        "{ provide: SESSION_STORAGE_KEY, useValue: 'ns-session-v1:x' }",
                },
                'qz',
                (path) => path
            ),
        /^Error: external application: PRODUCT_PREFIX_REMAINS: apps\/x\/src\/app\/app\.config\.ts keeps prefix ns \(clé de session de l’onglet\) after rename$/
    );
    assertOnlyPrefix(
        {
            'apps/x/src/app/app.config.ts':
                "{ provide: SESSION_STORAGE_KEY, useValue: 'qz-session-v1:x' }",
        },
        'qz',
        (path) => path
    );
});

test('S12 : les clés de la même famille, sous un autre préfixe, sont relevées pour effacement', () => {
    assert.deepEqual(
        [
            ...projection.staleTabSessionKeys(
                [
                    'qz-session-v1:app',
                    'qx-session-v1:app',
                    'q1y2z3-session-v1:app',
                    'qx-session-v1:autre',
                    'session-v1:app',
                    'q12345678-session-v1:app',
                    'Qx-session-v1:app',
                    '1x-session-v1:app',
                    'qx-session-static-v1',
                    null,
                    'autre',
                ],
                'qz-session-v1:app',
                'app'
            ),
        ],
        ['qx-session-v1:app', 'q1y2z3-session-v1:app']
    );
    assert.equal(projection.TAB_SESSION_KEY_FAMILY, '-session-v1:');
});

for (const domain of SESSION_FIXTURE_DOMAINS) {
    test(`V3.7.2 : la clé de l'onglet est rendue par la COQUE seule ; le socle n'en porte aucune forme : ${domain}`, async (t) => {
        const { fixture, digest } = await domainSession(t, domain);
        const key = tabSessionKey(FIXTURE_PREFIX, APP);
        assert.equal(key, `${FIXTURE_PREFIX}-session-v1:${APP}`);
        const { files } = await renderAngularPwaShell({
            design: fixture.design,
            experienceId: fixture.design.experiences[0].id,
            appName: APP,
            designPath: 'design/session.json',
            designSha256: 'c'.repeat(64),
            externalWorkspace: true,
            prefix: FIXTURE_PREFIX,
        });
        const appConfig = files[`apps/${APP}/src/app/app.config.ts`];
        assert.ok(
            appConfig.includes(
                `{ provide: SESSION_STORAGE_KEY, useValue: '${key}' }`
            ),
            appConfig
        );
        assert.deepEqual(
            [...(productNameForms(appConfig).get(FAMILY) ?? [])],
            [FIXTURE_PREFIX]
        );
        const socle = Object.entries(files).filter(([path]) =>
            path.startsWith(`libs/${APP}-socle/`)
        );
        assert.ok(socle.length > 0);
        for (const [path, content] of socle) {
            assert.deepEqual([...productNameForms(content)], [], path);
            assert.equal(content.includes(key), false, path);
        }
        const coque = files[`libs/${APP}-socle/src/coque.ts`];
        const publicApi = files[`libs/${APP}-socle/src/index.ts`];
        assert.match(
            coque,
            /export \{ SESSION_STORAGE_KEY \} from '\.\/session\/session\.types';/
        );
        assert.equal(publicApi.includes('SESSION_STORAGE_KEY'), false);
        const store = files[`libs/${APP}-socle/src/session/session.store.ts`];
        assert.match(
            store,
            new RegExp(`SESSION_CONFIGURATION_SHA256 =\\s*'${digest}';`)
        );
        assert.ok(store.includes(`const SESSION_APP = '${APP}'`));
        // Mode interne : la coque fournit la même clé.
        const internal = await renderAngularApplicationSession({
            design: fixture.design,
            experience: fixture.design.experiences[0],
            prefix: FIXTURE_PREFIX,
            appName: APP,
        });
        assert.ok(
            internal['src/app/app.config.ts'].includes(
                `{ provide: SESSION_STORAGE_KEY, useValue: ${JSON.stringify(key)} }`
            )
        );
        assert.equal(
            internal['src/app/session/session.store.ts'].includes(key),
            false
        );
    });

    test(`V3.7.10 et V4.7 : stockages, ouvreur et cibles dans les fichiers rendus de la coque et du socle : ${domain}`, async (t) => {
        const { fixture } = await domainSession(t, domain);
        const external = await renderAngularPwaShell({
            design: fixture.design,
            experienceId: fixture.design.experiences[0].id,
            appName: APP,
            designPath: 'design/session.json',
            designSha256: 'c'.repeat(64),
            externalWorkspace: true,
            prefix: FIXTURE_PREFIX,
        });
        const internal = await renderAngularApplicationSession({
            design: fixture.design,
            experience: fixture.design.experiences[0],
            prefix: FIXTURE_PREFIX,
            appName: APP,
        });
        for (const [mode, files, store] of [
            [
                'extérieur',
                { ...external.files, ...external.seeds },
                `libs/${APP}-socle/src/session/session.store.ts`,
            ],
            ['interne', internal, 'src/app/session/session.store.ts'],
        ]) {
            const entries = Object.entries(files);
            const matching = (pattern) =>
                entries
                    .filter(([, content]) => pattern.test(content))
                    .map(([path]) => path);
            // `sessionStorage` : le seul magasin, par le jeton de clé.
            assert.deepEqual(matching(/\bsessionStorage\b/), [store], mode);
            assert.match(files[store], /inject\(SESSION_STORAGE_KEY\)/);
            // `localStorage` nulle part au lot 2 (le lot 3, commit 2, l'ouvre
            // à sa seule clé) ; ni IndexedDB, ni cookie, ni `cookieStore`.
            for (const pattern of [
                /\blocalStorage\b/,
                /\bindexedDB\b/,
                /\bdocument\s*\.\s*cookie\b/,
                /\bcookieStore\b/,
                /\b(?:window|globalThis|self|top|parent)\s*\.\s*open\s*\(/,
                /\brel\s*=\s*["'][^"']*\bopener\b/i,
                /\[(?:attr\.)?rel\]\s*=\s*["'][^"']*opener/i,
                /<base\b[^>]*\btarget\s*=/i,
                /\bopener\s*(?:\.\s*location\s*)?=(?!=)/,
            ])
                assert.deepEqual(matching(pattern), [], `${mode} : ${pattern}`);
            // La seule LECTURE de l'ouvreur : le magasin de session.
            assert.deepEqual(matching(/\bopener\b/), [store], mode);
        }
    });
}

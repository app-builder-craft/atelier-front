// Parties sans navigateur de `check-nginx-relay-browser.mjs` : liste statique
// des vérifications et son compte, refus d'un nom hors liste, nombre de
// politiques qui portent `form-action 'none'`, contre-mutations sur une copie.
// La preuve dans Chromium derrière nginx tourne en CI
// (`check:nginx-relay-browser --mutations`).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    FORM_ACTION_MUTATIONS,
    RELAY_BROWSER_CHECKS,
    formActionSources,
    relayBrowserCheckNames,
    relayCheckRecorder,
    runShellBrowserChecks,
    weakenFormAction,
} from './check-nginx-relay-browser.mjs';
import { productForms } from './core/product-identity.mjs';
import {
    externalCspHeader,
    externalCspMeta,
} from './renderers/external-content-security-policy.mjs';

const PREFIX = 'ns';

test('liste statique : figée, noms uniques, gabarit <kebab> rendu au préfixe', () => {
    assert.ok(Object.isFrozen(RELAY_BROWSER_CHECKS));
    assert.equal(
        new Set(RELAY_BROWSER_CHECKS).size,
        RELAY_BROWSER_CHECKS.length
    );
    for (const name of ['form-action-none', 'form-dialog-allowed'])
        assert.ok(RELAY_BROWSER_CHECKS.includes(name), name);
    const names = relayBrowserCheckNames(PREFIX);
    assert.ok(names.includes(`${productForms(PREFIX).kebab}sw-policy-closed`));
    assert.ok(names.every((name) => !name.includes('<kebab>')));
});

test('enregistreur : un nom hors liste ou répété arrête la preuve', async () => {
    const { results, check } = relayCheckRecorder(PREFIX);
    await check('cache-security', async () => undefined);
    await check('form-action-none', async () => {
        throw new Error('rouge\nsuite');
    });
    assert.deepEqual(results, {
        'cache-security': 'PASS',
        'form-action-none': 'FAIL rouge',
    });
    await assert.rejects(
        () => check('vérification-inconnue', async () => undefined),
        /vérification non déclarée ou répétée : vérification-inconnue/
    );
    await assert.rejects(
        () => check('cache-security', async () => undefined),
        /vérification non déclarée ou répétée : cache-security/
    );
});

// Navigateur factice dont chaque appel échoue : chaque vérification est
// lancée une fois, sous son nom déclaré, et rendue FAIL. Les noms obtenus
// sont EXACTEMENT ceux de la liste statique (le compte en dérive).
test('coque : chaque vérification lancée porte un nom de la liste, une fois', async () => {
    const broken = () => {
        throw new Error('navigateur factice');
    };
    // `then` absent : la page n'est pas une promesse.
    const page = new Proxy(
        {},
        { get: (_, key) => (key === 'then' ? undefined : broken) }
    );
    const context = {
        addInitScript: async () => undefined,
        newPage: async () => page,
        close: async () => undefined,
    };
    const results = await runShellBrowserChecks(
        { newContext: async () => context },
        'http://127.0.0.1:1',
        { update: broken, stop: broken },
        { expectation: {}, files: [], api: '/api/x/', prefix: PREFIX }
    );
    assert.deepEqual(
        Object.keys(results).sort(),
        [...relayBrowserCheckNames(PREFIX)].sort()
    );
    assert.ok(
        Object.values(results).every((value) => value.startsWith('FAIL'))
    );
});

test('form-action : une violation attendue par politique livrée qui porte none', () => {
    const header = externalCspHeader(PREFIX);
    const meta = externalCspMeta(PREFIX);
    assert.equal(formActionSources([header, meta]), 2);
    const weak = (policy) =>
        policy.replace("form-action 'none'", "form-action 'self'");
    assert.equal(formActionSources([weak(header), meta]), 1);
    assert.equal(formActionSources([header, weak(meta)]), 1);
    assert.equal(formActionSources([weak(header), weak(meta)]), 0);
    assert.equal(formActionSources([undefined, null]), 0);
    assert.equal(
        formActionSources(["default-src 'self'; form-action 'none' 'self'"]),
        0
    );
});

test('contre-mutations : trois, critères de mort pris dans la liste statique', () => {
    assert.ok(Object.isFrozen(FORM_ACTION_MUTATIONS));
    assert.deepEqual(
        FORM_ACTION_MUTATIONS.map((mutation) => mutation.sources),
        [['header'], ['meta'], ['header', 'meta']]
    );
    for (const mutation of FORM_ACTION_MUTATIONS) {
        assert.ok(RELAY_BROWSER_CHECKS.includes(mutation.killedBy));
        if (mutation.stillGreen)
            assert.ok(RELAY_BROWSER_CHECKS.includes(mutation.stillGreen));
    }
    assert.equal(FORM_ACTION_MUTATIONS[2].killedBy, 'form-action-none');
});

test('contre-mutation : une seule occurrence affaiblie, sinon arrêt', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'relay-browser-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const once = join(root, 'once.conf');
    await writeFile(once, `add_header X "${externalCspHeader(PREFIX)}";\n`);
    await weakenFormAction(once);
    const text = await readFile(once, 'utf8');
    assert.ok(text.includes("form-action 'self'"));
    assert.ok(!text.includes("form-action 'none'"));
    await assert.rejects(
        () => weakenFormAction(once),
        /contre-mutation form-action : 0 occurrence/
    );
    const twice = join(root, 'twice.html');
    await writeFile(
        twice,
        `${externalCspMeta(PREFIX)}\n${externalCspMeta(PREFIX)}\n`
    );
    await assert.rejects(
        () => weakenFormAction(twice),
        /contre-mutation form-action : 2 occurrence/
    );
});

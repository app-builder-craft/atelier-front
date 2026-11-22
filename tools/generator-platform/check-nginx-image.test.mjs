// X4-config, NGINX-FRAICHEUR (a) : structure de l'image nginx du relais,
// sans réseau. Les empreintes des témoins sont construites à l'exécution :
// ce fichier suivi ne contient aucun épinglage littéral.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    NGINX_HARNESS_DOCKERFILE,
    nginxImageStructureErrors,
    pinnedNginxImage,
    readNginxHarnessDockerfile,
} from './check-nginx-image.mjs';
import { toolEnv } from './core/atelier-signature.mjs';
import { nginxImage } from './renderers/external-relay-renderer.mjs';

const HEX = 'ab'.repeat(32);
const pin = (tag = '1.31-alpine', hex = HEX) => `nginx:${tag}@sha256:${hex}`;
const harness = (from = `FROM ${pin()}`) => `# Relais.\n${from}\n`;
const errorsOf = (dockerfile, files) =>
    nginxImageStructureErrors(dockerfile, files).join('\n');

// Témoins invalides du Dockerfile, chacun avec le refus attendu.
const INVALID_HARNESSES = [
    ['FROM nginx:1.31-alpine', /forme nginx:<tag>@sha256/],
    [`FROM ${pin('1.31-alpine', HEX.slice(2))}`, /forme nginx:<tag>@sha256/],
    [`FROM ${pin('1.31-alpine', `${HEX}ab`)}`, /forme nginx:<tag>@sha256/],
    [`FROM ${pin('1.31-alpine', HEX.toUpperCase())}`, /forme/],
    [`FROM nginx@sha256:${HEX}`, /forme nginx:<tag>@sha256/],
    [`FROM ${pin()} AS relais`, /forme nginx:<tag>@sha256/],
    [`from ${pin()}`, /forme nginx:<tag>@sha256/],
    [`FROM docker.io/library/${pin()}`, /forme nginx:<tag>@sha256/],
    [`FROM ${pin('latest')}`, /tag latest hors politique/],
    [`FROM ${pin('1.31.2-alpine')}`, /hors politique/],
    [`FROM ${pin()}\nFROM ${pin()}`, /2 ligne\(s\) FROM, une seule attendue/],
    ['# rien', /0 ligne\(s\) FROM, une seule attendue/],
];

test('(a) accepte le Dockerfile réel, seule source, et un témoin conforme', () => {
    const real = readNginxHarnessDockerfile();
    assert.deepEqual(nginxImageStructureErrors(real, []), []);
    assert.match(pinnedNginxImage(real).tag, /^\d+\.\d+-alpine$/);
    assert.match(pinnedNginxImage(real).digest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(
        nginxImageStructureErrors(harness(), [
            { path: NGINX_HARNESS_DOCKERFILE, text: harness() },
            { path: 'docs/a.md', text: 'FROM nginx:<tag>@sha256:<empreinte>' },
            { path: 'tools/b.mjs', text: `nginx:1.31-alpine sha256:${HEX}` },
        ]),
        []
    );
});

test('(a) refuse empreinte absente, courte, longue, en majuscules, sans tag, FROM double ou absent, tag hors politique', () => {
    for (const [from, expected] of INVALID_HARNESSES) {
        assert.match(errorsOf(harness(from), []), expected, from);
    }
});

test('(a) refuse tout autre épinglage de nginx, dans le harnais ou ailleurs', () => {
    assert.match(
        errorsOf(`# ancienne : ${pin()}\nFROM ${pin()}\n`, []),
        /Dockerfile:1 : second épinglage de nginx hors de la ligne FROM/
    );
    for (const [path, text, expected] of [
        ['docs/x.md', `Image : ${pin()}`, /^docs\/x\.md:1 : épinglage/],
        ['a.yml', `x\n  image: ${pin()}`, /^a\.yml:2 : épinglage/],
        ['b.json', `"docker.io/library/nginx@sha256:${HEX}"`, /^b\.json:1/],
        ['c.mjs', `'${pin('1.31-alpine', HEX.toUpperCase())}'`, /^c\.mjs:1/],
        ['deploy/Dockerfile', 'FROM nginx:1.31-alpine', /autre Dockerfile/],
        ['x/Dockerfile.dev', 'FROM --platform=x nginx', /autre Dockerfile/],
        ['y/relay.dockerfile', 'FROM docker.io/library/nginx', /autre/],
    ])
        assert.match(
            errorsOf(harness(), [{ path, text }]),
            expected,
            `${path} : ${text}`
        );
    // Un Dockerfile qui tire une autre image reste admis.
    assert.deepEqual(
        nginxImageStructureErrors(harness(), [
            { path: 'z/Dockerfile', text: 'FROM node:26-alpine\n' },
        ]),
        []
    );
});

test('(a) la commande sur le dépôt réel : vert et référence complète', () => {
    const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./check-nginx-image.mjs', import.meta.url))],
        { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
        result.stdout,
        `${toolEnv('NGINX_IMAGE_OK')} ${pinnedNginxImage(readNginxHarnessDockerfile()).reference}\n`
    );
});

// La politique de tag reste à (a) ; le relais refuse exactement ce que
// l'analyseur refuse, et lit sinon la même référence.
test('C3 : un seul analyseur de la ligne FROM, partagé par le relais et (a)', () => {
    assert.equal(
        nginxImage(),
        pinnedNginxImage(readNginxHarnessDockerfile()).reference
    );
    for (const [from] of [[`FROM ${pin()}`], ...INVALID_HARNESSES]) {
        const dockerfile = harness(from);
        const pinned = pinnedNginxImage(dockerfile);
        if (pinned === null)
            assert.throws(() => nginxImage(dockerfile), /not pinned/, from);
        else assert.equal(nginxImage(dockerfile), pinned.reference, from);
    }
    // L'analyseur refuse lui-même toute forme que (a) refuse, sauf la
    // politique de tag : le relais ne lit jamais un Dockerfile à deux FROM.
    for (const [from, expected] of INVALID_HARNESSES)
        if (!String(expected).includes('politique'))
            assert.equal(
                pinnedNginxImage(harness(from)),
                null,
                `analyseur : ${from}`
            );
});

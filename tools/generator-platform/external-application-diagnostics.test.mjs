// CI de la PR #389 : une étape native en échec ne publie que des lignes
// `${toolEnv('DIAG')}=` de forme fermée, jamais la sortie brute, un jeton ou une ligne
// d'environnement.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    diagnosticLines,
    record,
} from './proof-support/external-application-runtime.mjs';
import { toolEnv } from './core/atelier-signature.mjs';

// Préfixe des lignes de diagnostic, dérivé de la source unique.
const DIAG = toolEnv('DIAG');

// Faux jeton construit à l'exécution : aucun secret n'est écrit en clair.
const FAKE_TOKEN = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0'].join('');

test('seules les lignes de diagnostic de forme fermée sont gardées', () => {
    const output = [
        `${DIAG}=stage:heading`,
        `${DIAG}=error:TimeoutError: locator.waitFor: Timeout 30000ms exceeded.`,
        `${DIAG}=http:200 /main-ABC123.js`,
        `${DIAG}=http:299 /connexion`,
        `${DIAG}=csp:require-trusted-types-for=2`,
        `${DIAG}=console:Refused to load http://127.0.0.1:41234/x.png from /workspace/dist/app`,
        'raw line from the child',
        `${DIAG}=error:leaked ${FAKE_TOKEN}`,
        `${DIAG}=console:CI_SECRET=value`,
        `${DIAG}=env:HOME=/fixture-home`,
        `${DIAG}=http:200 /x?token=abc`,
        `${DIAG}=stage:Heading`,
        `${DIAG}=console:Bearer abcdef`,
        `${DIAG}=console:${'a'.repeat(40)}`,
        `GITHUB_TOKEN=${FAKE_TOKEN}`,
        // CI #389 (e) : chemins de navigation N2, chemins seuls.
        `${DIAG}=route:final /enter`,
        `${DIAG}=route:expected /enter,/agree,/dashboard`,
        `${DIAG}=route:expected `,
        `${DIAG}=route:final http://127.0.0.1:41234/enter`,
        `${DIAG}=route:final /enter?token=abc`,
        `${DIAG}=route:final enter`,
        `${DIAG}=route:other /enter`,
    ].join('\n');
    assert.deepEqual(diagnosticLines(output), [
        `${DIAG}=stage:heading`,
        `${DIAG}=error:TimeoutError: locator.waitFor: Timeout 30000ms exceeded.`,
        `${DIAG}=http:200 /main-ABC123.js`,
        `${DIAG}=http:299 /connexion`,
        `${DIAG}=csp:require-trusted-types-for=2`,
        `${DIAG}=console:Refused to load <origin>/x.png from <path>`,
        `${DIAG}=route:final /enter`,
        `${DIAG}=route:expected /enter,/agree,/dashboard`,
        `${DIAG}=route:expected `,
    ]);
    const many = Array.from(
        { length: 80 },
        (_, index) => `${DIAG}=http:200 /f${index}.js`
    ).join('\n');
    assert.equal(diagnosticLines(many).length, 60);
});

test('record en échec publie le diagnostic filtré, jamais la sortie brute', () => {
    const session = { lines: [] };
    const stdout = [
        `${DIAG}=stage:heading`,
        `GITHUB_TOKEN=${FAKE_TOKEN}`,
        `${DIAG}=error:token ${FAKE_TOKEN}`,
        'HOME=/Users/someone',
        `${DIAG}=http:200 /index.html`,
    ].join('\n');
    assert.throws(
        () =>
            record(session, 'X4/fictif/browser-realized-page', {
                status: 1,
                signal: null,
                stdout,
                stderr: 'stack /Users/someone/x.mjs:1',
            }),
        /Échec de la preuve X4\/fictif\/browser-realized-page/
    );
    assert.equal(
        session.lines[0],
        'FAIL X4/fictif/browser-realized-page exit=1'
    );
    assert.match(session.lines[1], /^diagnostic_sha256=[0-9a-f]{64}$/);
    assert.deepEqual(session.lines.slice(2), [
        `diagnostic X4/fictif/browser-realized-page ${DIAG}=stage:heading`,
        `diagnostic X4/fictif/browser-realized-page ${DIAG}=http:200 /index.html`,
    ]);
    const report = session.lines.join('\n');
    for (const leaked of [FAKE_TOKEN, 'GITHUB_TOKEN', '/Users/', 'HOME='])
        assert.equal(report.includes(leaked), false, leaked);
});

test('record en succès ne publie aucun diagnostic', () => {
    const session = { lines: [] };
    record(session, 'X4/fictif/ok', {
        status: 0,
        signal: null,
        stdout: `${DIAG}=stage:done\n`,
        stderr: '',
    });
    assert.deepEqual(session.lines, ['PASS X4/fictif/ok exit=0']);
});

// R-ROUTE (Fable) : les genres http et route, publiés bruts, abandonnent une
// ligne en forme de jeton ; les routes légitimes passent. Les faux jetons sont
// construits à l'exécution : aucun secret n'est écrit en clair.
test('http et route : ligne en forme de jeton abandonnée, routes légitimes publiées', () => {
    const repeat = (unit, count) => unit.repeat(count);
    const legit = [
        `${DIAG}=route:expected /enter,/agree,/rotate,/dashboard,/catalogue,/restricted`,
        `${DIAG}=route:expected /connexion,/confidentialite,/mot-de-passe,/territorial-structure/regions`,
        `${DIAG}=route:final /enter`,
        `${DIAG}=http:299 /enter`,
        `${DIAG}=http:200 /main-JXHWV5W3.js`,
        `${DIAG}=http:502 /api/observatory-service/v1.0/access`,
    ];
    const secret = [
        `${DIAG}=http:200 /${['ghp', '_'].join('')}${repeat('A1b2', 9)}`,
        `${DIAG}=route:final /${['AK', 'IA'].join('')}${repeat('Q7', 8)}`,
        `${DIAG}=route:final /${['s', 'k-'].join('')}${repeat('x9', 10)}`,
        `${DIAG}=http:200 /x/${repeat('aZ3_', 10)}`,
        `${DIAG}=route:expected /enter,/${repeat('Kd9-', 10)}`,
    ];
    assert.deepEqual(diagnosticLines([...legit, ...secret].join('\n')), legit);
});

// Réserve R2 de la validation de l'étape A (CI #48 `missing/…/red exit=0`) :
// un REFUS attendu exige un code de sortie entier NON NUL ; une sortie 0, même
// avec le diagnostic attendu, est un FAIL, comme une interruption.
test('record négatif : un refus exige un code de sortie non nul', () => {
    const run = (status, { signal = null, diagnostic } = {}) => {
        const session = { lines: [] };
        let error;
        try {
            record(
                session,
                'R2/fictif/red',
                { status, signal, stdout: 'refus attendu\n', stderr: '' },
                { negative: true, diagnostic }
            );
        } catch (caught) {
            error = caught;
        }
        return { line: session.lines[0], error };
    };
    for (const [status, options, expected] of [
        [1, {}, 'PASS R2/fictif/red exit=1'],
        [2, { diagnostic: /refus attendu/ }, 'PASS R2/fictif/red exit=2'],
        [0, {}, 'FAIL R2/fictif/red exit=0'],
        [0, { diagnostic: /refus attendu/ }, 'FAIL R2/fictif/red exit=0'],
        [null, { signal: 'SIGKILL' }, 'FAIL R2/fictif/red exit=interrupted'],
        [1, { diagnostic: /autre refus/ }, 'FAIL R2/fictif/red exit=1'],
    ]) {
        const { line, error } = run(status, options);
        assert.equal(line, expected, `${status} ${String(options.diagnostic)}`);
        assert.equal(Boolean(error), expected.startsWith('FAIL'), expected);
        if (error)
            assert.match(
                error.message,
                /^Échec de la preuve R2\/fictif\/red\./
            );
    }
});

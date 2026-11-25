// Contrat de la fixture de session (lot 2, commit 0) : la valeur par défaut
// rend le contrat d'origine, et `operationCopies` le multiplie pour la mesure
// d'échelle R-D, sans casser le contrat natif ni le banc.
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import test from 'node:test';
import { validateBackendContract } from './core/backend-contract.mjs';
import { observationInputPrimitives as io } from './core/runtime-observation-evidence.mjs';
import {
    createApplicationSessionFixture,
    SESSION_FIXTURE_DOMAINS,
} from './test-support/application-session-fixture.mjs';
import {
    bytesOf,
    canonicalFixture,
    declaration,
} from './test-support/session-fixture-contract.mjs';

const schema = io.parseSchema(
    await readFile(
        new URL('./schemas/backend-contract.schema.json', import.meta.url)
    )
);

function canonical(domain, options) {
    const declared = declaration(domain, options);
    const { names: _names, ...source } = declared;
    void _names;
    return canonicalFixture(
        declared,
        `fixtures/${domain}.declared.json`,
        bytesOf(source),
        domain
    );
}

for (const domain of SESSION_FIXTURE_DOMAINS) {
    test(`fixture ${domain} : une copie par défaut, contrat d'origine`, () => {
        assert.deepEqual(
            declaration(domain),
            declaration(domain, { operationCopies: 1 })
        );
        const contract = canonical(domain);
        assert.deepEqual(
            contract.operations.map((operation) => operation.id),
            ['enter', 'agree', 'rotate', 'catalogue'].map(
                (name) => `${domain}-${name}`
            )
        );
        assert.deepEqual(validateBackendContract(contract, schema), []);
    });

    test(`fixture ${domain} : 128 copies, 512 opérations natives et uniques`, () => {
        const contract = canonical(domain, { operationCopies: 128 });
        assert.equal(contract.operations.length, 512);
        assert.equal(
            new Set(contract.operations.map((operation) => operation.id)).size,
            512
        );
        assert.equal(
            new Set(
                contract.operations.map((operation) =>
                    [
                        operation.service_id,
                        operation.method,
                        operation.path,
                    ].join(' ')
                )
            ).size,
            512
        );
        assert.deepEqual(validateBackendContract(contract, schema), []);
        // La copie est comparée dans la DÉCLARATION : la forme canonique
        // ajoute des preuves dont le pointeur porte l'index de l'opération.
        const { operations } = declaration(domain, { operationCopies: 128 });
        const copy = operations.find(
            (operation) => operation.id === `${domain}-rotate-copy-128`
        );
        const original = operations.find(
            (operation) => operation.id === `${domain}-rotate`
        );
        const { id: _a, path: copyPath, ...copyRest } = copy;
        const { id: _b, path, ...originalRest } = original;
        void [_a, _b];
        assert.equal(copyPath, `${path}/copy-128`);
        assert.deepEqual(copyRest, originalRest);
    });
}

test('fixture : nombre de copies refusé hors des entiers positifs', () => {
    for (const operationCopies of [0, -1, 1.5, '2', Number.NaN, null])
        assert.throws(
            () => declaration('observatory', { operationCopies }),
            /operationCopies must be a positive integer/
        );
});

test('fixture : le banc de session construit un contrat multiplié', async (t) => {
    const fixture = await createApplicationSessionFixture({
        domain: 'equipment-hire',
        operationCopies: 2,
    });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    assert.equal(fixture.contract.operations.length, 8);
    assert.deepEqual([...fixture.actions.keys()].sort(), [
        'equipment-hire-agree',
        'equipment-hire-agree-copy-2',
        'equipment-hire-enter',
        'equipment-hire-enter-copy-2',
        'equipment-hire-rotate',
        'equipment-hire-rotate-copy-2',
    ]);
});

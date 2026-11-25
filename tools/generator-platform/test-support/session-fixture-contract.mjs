// Contrat déclaré de la fixture de session (deux produits fictifs aux
// structures différentes) : la déclaration et sa forme canonique.
// Extrait de `application-session-fixture.mjs` (lot 2, commit 0), sans
// changement des objets rendus.
//
// Mesure d'échelle (lot 2, risque R-D) : `operationCopies` multiplie les
// opérations du contrat. Chaque copie garde la méthode, l'entrée, la sortie et
// l'accès de son original ; seuls son identifiant et son chemin changent, pour
// rester uniques. La valeur par défaut, 1, rend le contrat d'origine à
// l'octet.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { backendDefinition } from './application-design-fixture.mjs';
import { catalogueContractShape } from './session-catalogue-query.mjs';

export const digest = (value) =>
    createHash('sha256').update(value).digest('hex');
export const bytesOf = (value) =>
    Buffer.from(JSON.stringify(value, null, 2) + '\n');
const primitive = (name) => ({ kind: 'primitive', name });
const array = (items) => ({ kind: 'array', items });

function copiesOf(operations, operationCopies) {
    assert.ok(
        Number.isSafeInteger(operationCopies) && operationCopies >= 1,
        `operationCopies must be a positive integer, got ${String(operationCopies)}`
    );
    const copies = [];
    for (let copy = 2; copy <= operationCopies; copy += 1)
        for (const operation of operations)
            copies.push({
                ...structuredClone(operation),
                id: `${operation.id}-copy-${copy}`,
                path: `${operation.path}/copy-${copy}`,
            });
    return [...operations, ...copies];
}

export function declaration(domain, { operationCopies = 1 } = {}) {
    const alternate = domain === 'equipment-hire';
    const names = Object.fromEntries(
        [
            ['token', 'credential', 'ticket'],
            ['secret', 'value', 'secret'],
            ['subject', 'member', 'operator'],
            ['menu', 'sections', 'navigation'],
            ['paths', 'paths', 'route_set'],
            ['permissions', 'grants', 'claims'],
            ['privacy', 'consent', 'policy'],
            ['accepted', 'accepted_at', 'confirmed'],
            ['rotate', 'must_rotate', 'must_renew'],
            ['label', 'caption', 'title'],
            ['path', 'href', 'url'],
            ['children', 'entries', 'links'],
            ['error', 'error', 'rejected'],
            ['message', 'message', 'notice'],
        ].map(([key, one, two]) => [key, alternate ? two : one])
    );
    const id = (name) => `${domain}-${name}`;
    const model = (name) => ({ kind: 'model', model_id: id(name) });
    const field = (name, type, options = {}) => ({
        name,
        type,
        description: 'Declared fixture field.',
        required: true,
        nullable: false,
        ...options,
    });
    const text = (name, options = {}) =>
        field(name, primitive('string'), options);
    const object = (name, fields, options = {}) => ({
        id: id(name),
        kind: 'object',
        description: 'Declared fixture model.',
        fields,
        ...options,
    });
    const catalogue = catalogueContractShape({
        alternate,
        object,
        field,
        model,
    });
    const models = [
        object('enter-input', [text('identity'), text('passphrase')]),
        object('token', [text(names.secret)]),
        object('privacy', [text(names.accepted, { nullable: true })]),
        object('leaf', [
            text(names.label),
            text(names.path),
            field('active', primitive('boolean')),
        ]),
        object('group', [
            text(names.label),
            text(names.path, { nullable: true }),
            field(names.children, array(model('leaf'))),
            text('statut'),
        ]),
        object('subject', [
            text('name'),
            text('toString'),
            field('is_admin', primitive('boolean')),
            field(names.privacy, model('privacy')),
            field(names.rotate, primitive('boolean')),
            field(names.menu, array(model('group'))),
            field(names.paths, array(primitive('string'))),
            field(names.permissions, array(primitive('string'))),
            text('note', {
                required: false,
                nullable: true,
            }),
        ]),
        object('session-result', [
            field(names.token, model('token'), { required: false }),
            field(names.subject, model('subject'), { required: false }),
            field('challenge', primitive('boolean')),
        ]),
        object('rotate-input', [
            text('current_secret'),
            text('next_secret'),
            text('confirmation'),
        ]),
        object('command-result', [
            field(names.error, primitive('boolean')),
            text(names.message),
            field('data', primitive('null'), { nullable: true }),
        ]),
        object('bad-request', [
            field(names.error, primitive('boolean')),
            text(names.message),
            field('statusCode', primitive('integer')),
        ]),
        object('unauthenticated', [text(names.message)]),
        object('field-errors', [], {
            additional_properties: array(primitive('string')),
        }),
        object('validation-error', [
            text(names.message),
            field('errors', model('field-errors')),
        ]),
        object('item', [field('id', primitive('string')), text('label')]),
        {
            id: id('items'),
            kind: 'array',
            description: 'Declared fixture collection.',
            items: model('item'),
        },
        ...catalogue.models,
    ];
    const response = (status, outcome, name, envelope = { kind: 'none' }) => ({
        status,
        outcome,
        description: 'Declared fixture response.',
        body: { media_type: 'application/json', model_id: id(name), envelope },
    });
    const errorResponses = [
        response(400, 'error', 'bad-request'),
        response(401, 'error', 'unauthenticated'),
        response(422, 'error', 'validation-error'),
    ];
    const access = (mode) => ({
        mode,
        security_scheme_ids: mode === 'public' ? [] : [id('bearer')],
        permissions: [],
    });
    const operation = (
        name,
        method,
        path,
        input,
        output = 'command-result',
        mode = 'authenticated',
        envelope = method === 'GET'
            ? {
                  kind: 'object',
                  error_field: names.error,
                  message_field: names.message,
                  data_field: 'data',
              }
            : { kind: 'none' },
        parameters = []
    ) => ({
        id: id(name),
        service_id: id('service'),
        method,
        path: (alternate ? '/v1.0' : '') + path,
        description: 'Declared fixture operation.',
        access: access(mode),
        request: {
            parameters,
            ...(input
                ? {
                      body: {
                          model_id: id(input),
                          required: true,
                          media_types: ['application/json'],
                      },
                  }
                : {}),
        },
        responses: [
            response(200, 'success', output, envelope),
            ...(method === 'GET' ? [errorResponses[1]] : errorResponses),
        ],
    });
    const operations = copiesOf(
        [
            operation(
                'enter',
                'POST',
                '/access',
                'enter-input',
                'session-result',
                'public',
                alternate
                    ? { kind: 'none' }
                    : {
                          kind: 'object',
                          error_field: names.error,
                          message_field: names.message,
                          data_field: 'payload',
                      }
            ),
            operation('agree', 'POST', '/consents', null),
            operation('rotate', 'PATCH', '/credentials', 'rotate-input'),
            operation(
                'catalogue',
                'GET',
                '/items',
                null,
                catalogue.output,
                'authenticated',
                undefined,
                catalogue.parameters
            ),
        ],
        operationCopies
    );
    const defaults = backendDefinition();
    Object.assign(defaults.contract, {
        id: id('api'),
        title: `Fixture ${domain}`,
        description: 'Synthetic declared fixture; never a network proof.',
    });
    Object.assign(defaults.services[0], {
        id: id('service'),
        description: 'Fixture endpoint.',
    });
    defaults.services[0].base_urls = [
        { environment: 'test', url: `https://${domain}.example/api/` },
    ];
    Object.assign(defaults.security_schemes[0], {
        id: id('bearer'),
        description: 'Declared fixture bearer.',
    });
    return {
        names,
        contract: defaults.contract,
        services: defaults.services,
        security_schemes: defaults.security_schemes,
        models,
        operations,
    };
}

export function canonicalFixture(declared, sourceUri, sourceDocument, domain) {
    const sourceId = `${domain}-fixture-source`;
    const result = structuredClone(declared);
    delete result.names;
    result.schema_version = '1.1.0';
    result.kind = 'backend-contract';
    result.sources = [
        {
            id: sourceId,
            kind: 'manual',
            authority: 'declared',
            status: 'planned',
            snapshot_uri: sourceUri,
            sha256: digest(sourceDocument),
        },
    ];
    const proof = (value, pointer) => {
        value.evidence = [{ source_id: sourceId, locator: pointer }];
    };
    for (const collection of [
        'services',
        'security_schemes',
        'models',
        'operations',
    ])
        for (const [index, value] of result[collection].entries()) {
            value.status = 'planned';
            proof(value, `/${collection}/${index}`);
        }
    for (const [index, model] of result.models.entries())
        for (const [fieldIndex, field] of (model.fields ?? []).entries())
            proof(field, `/models/${index}/fields/${fieldIndex}`);
    for (const [index, operation] of result.operations.entries()) {
        const path = `/operations/${index}`;
        if (operation.request.body)
            proof(operation.request.body, `${path}/request/body`);
        for (const [
            parameterIndex,
            parameter,
        ] of operation.request.parameters.entries())
            proof(parameter, `${path}/request/parameters/${parameterIndex}`);
        for (const [responseIndex, response] of operation.responses.entries()) {
            const pointer = `${path}/responses/${responseIndex}`;
            proof(response, pointer);
            proof(response.body, `${pointer}/body`);
        }
    }
    return result;
}

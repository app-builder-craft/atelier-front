// Lecture « catalogue » de la fixture de session (X5 C2). Une lecture de
// session est au profil EXTÉRIEUR : politique honnête `bypass`, échec qui
// efface les lignes (`on_error: clear`), décodeur projeté sur les champs lus
// (D-X5-2, D-X5-4, D-X5-6).
import { EXTERNAL_LIST_QUERY_EXECUTION } from '../core/list-query-external-profile.mjs';
import { compileListQueryV2ExecutionModel } from '../core/list-query-v2-compiler.mjs';

// X5 C6 : forme de la lecture « catalogue » dans le contrat de la fixture.
// Observatory lit une PAGE (forme paginée usuelle : paramètre de requête
// `page`, entier, facultatif, seul) ; equipment-hire, une liste. Les deux
// branches de la façade (liste et page) tournent ainsi en natif.
const primitive = (name) => ({ kind: 'primitive', name });
const array = (items) => ({ kind: 'array', items });

export function catalogueContractShape({ alternate, object, field, model }) {
    if (alternate) return { output: 'items', models: [], parameters: [] };
    return {
        output: 'items-page',
        models: [
            object('items-page', [
                field('items', array(model('item'))),
                field('current_page', primitive('integer')),
                field('last_page', primitive('integer')),
                field('per_page', primitive('integer')),
                field('total', primitive('integer')),
            ]),
        ],
        parameters: [
            {
                name: 'page',
                in: 'query',
                description: 'One-based page, optional; page 1 when absent.',
                required: false,
                type: primitive('integer'),
                constraints: { minimum: 1 },
            },
        ],
    };
}

// X5 C6 : entrée et résultat d'une lecture paginée (observatory) ; une liste
// (equipment-hire) n'en déclare aucun.
const pagedRead = (domain) =>
    domain === 'equipment-hire'
        ? {}
        : {
              input: {
                  fields: [
                      {
                          name: 'page',
                          parameter_ref: { name: 'page', in: 'query' },
                      },
                  ],
              },
              result: {
                  kind: 'page',
                  items_field: 'items',
                  page_fields: {
                      currentPage: 'current_page',
                      lastPage: 'last_page',
                      pageSize: 'per_page',
                      totalItems: 'total',
                  },
              },
          };

// Définition de la lecture « catalogue » (profil extérieur), aussi écrite dans
// un produit extérieur par la fixture de C3a. Gabarit fictif en ligne : même
// objet, clés dans le même ordre, que l'ancien gabarit lu sur disque ; une
// lecture paginée ajoute `input` et `result` en fin d'opération.
export async function sessionCatalogueDefinition({ domain, backendReference }) {
    const id = domain + '-catalogue';
    return {
        schema_version: '2.0.0',
        kind: 'list-query',
        feature: {
            id: domain + '-catalogue-feature',
            name: 'Fixture catalogue',
            description: 'Synthetic fixture.',
        },
        backend_contract: backendReference,
        operations: [
            {
                id,
                operation_ref: { operation_id: id },
                success_response_status: 200,
                read_model: {
                    id: domain + '-item-projection',
                    description: 'Fixture row.',
                    fields: [
                        { name: 'id', source_field: 'id' },
                        { name: 'label', source_field: 'label' },
                    ],
                },
                execution: structuredClone(EXTERNAL_LIST_QUERY_EXECUTION),
                ...pagedRead(domain),
            },
        ],
    };
}

export async function compileSessionCatalogueQuery({
    domain,
    backend,
    backendReference,
}) {
    const definition = await sessionCatalogueDefinition({
        domain,
        backendReference,
    });
    return compileListQueryV2ExecutionModel({
        definition,
        backendContractDocument: backend.document,
        backendContractUri: backend.uri,
        profile: 'external',
    });
}

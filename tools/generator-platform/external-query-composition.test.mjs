// X5 C4 (E6, E7, D-X5-3) : composition extérieure d'une page À LECTURE. La
// lecture publiée par `generate:list-query` est consommée telle quelle ; ses
// six membres fermés entrent dans la table `api` (G-A5) ; la spec de contrat
// des lectures est générée. Le runner injecté ne compile rien : la chaîne
// native du produit est prouvée par les preuves natives.
import assert from 'node:assert/strict';
import test from 'node:test';

import { queryOutputRoot } from './core/external-list-query.mjs';
import {
    planExternalPageComposition,
    publicExternalPageCompositionPlan,
} from './core/external-page-composition.mjs';
import { QUERY_MEMBER_KINDS } from './renderers/angular-page-composition-api.mjs';
import {
    publication,
    publish,
} from './test-support/external-publication-fixture.mjs';
import { SESSION_FIXTURE_DOMAINS } from './test-support/external-session-fixture.mjs';
import {
    compositionFile,
    queryPage,
} from './test-support/external-query-page.mjs';

test('C4 : page à lecture composée sur deux produits fictifs, en consommant la lecture publiée', async (t) => {
    for (const domain of SESSION_FIXTURE_DOMAINS) {
        const { options, queryId } = await queryPage(t, domain);
        const plan = await planExternalPageComposition(options);
        const visible = publicExternalPageCompositionPlan(plan);
        assert.deepEqual(visible.consumed_commands, []);
        assert.deepEqual(visible.consumed_queries, [
            `src/app/generated/queries/${queryId}`,
        ]);
        // La lecture n'est pas recopiée : seule la composition est publiée.
        assert.ok(
            plan.changes.every(
                ({ path }) =>
                    !path.startsWith(`${queryOutputRoot(queryId)}/`) &&
                    path.includes('/composition/')
            )
        );
        // Table `api` : `online` et les six membres fermés, genre par genre.
        const api = compositionFile(plan, 'page-composition.api.ts');
        for (const [member, kind] of Object.entries(QUERY_MEMBER_KINDS))
            assert.match(
                api,
                new RegExp(`path: 'catalogue\\.${member}',\\s*kind: '${kind}'`)
            );
        assert.match(
            api,
            /IsCommand<PageComposition\[['"]catalogue['"]\]\[['"]load['"]\]>/
        );
        assert.match(
            api,
            /IsDataSignal<PageComposition\[['"]catalogue['"]\]\[['"]items['"]\]>/
        );
        // Patrons fermés : lecture ou délégation à la façade seulement.
        const source = compositionFile(plan, 'page-composition.ts');
        assert.match(
            source,
            /error: computed\(\(\) => this\.catalogueFacade\.error\(\)\?\.statusCode\)/
        );
        // X5 C6 (B) : la lecture d'observatory est PAGINÉE et prend une entrée
        // (`page`, facultatif) : \`load\` la transmet à la façade ; celle
        // d'equipment-hire reste une liste sans entrée.
        const paged = domain !== 'equipment-hire';
        assert.match(
            source,
            paged
                ? /load: \(\s*input: Parameters<[A-Za-z]+\['load'\]>\[0\]\s*\): Observable<undefined> =>\s*defer\(\(\) => \{\s*this\.catalogueFacade\.load\(input\);\s*return of\(undefined\);\s*\}\)/
                : /load: \(\s*input: Readonly<Record<string, never>>\s*\): Observable<undefined> =>\s*defer\(\(\) => \{\s*void input;\s*this\.catalogueFacade\.load\(\);\s*return of\(undefined\);\s*\}\)/
        );
        // Décision du pilote : lecture initiale du nœud \`page-enter\` à la
        // construction, par la façade, une seule fois.
        // Lecture initiale : sans entrée (liste) ou entrée vide `{}` (page :
        // le serveur sert la première page, aucune valeur n'est inventée).
        assert.equal(
            [
                ...source.matchAll(
                    paged
                        ? /this\.catalogueFacade\.load\((input|\{\})\);/g
                        : /this\.catalogueFacade\.load\(\);/g
                ),
            ].length,
            2
        );
        assert.match(
            source,
            paged
                ? /inject\(DestroyRef\)\.onDestroy\(reset\);\s*this\.catalogueFacade\.load\(\{\}\);\s*\}/
                : /inject\(DestroyRef\)\.onDestroy\(reset\);\s*this\.catalogueFacade\.load\(\);\s*\}/
        );
        // G3 : aucune adresse, aucun appel HTTP ; F-d : aucun gel de donnée dans
        // la composition (seul le sac de membres de chaque nœud est gelé).
        assert.doesNotMatch(source, /HttpClient|injector|this\.http/);
        assert.deepEqual(
            [...source.matchAll(/Object\.freeze\(/g)].length,
            [
                ...source.matchAll(
                    /readonly [a-z][A-Za-z0-9]* = Object\.freeze\(\{/g
                ),
            ].length
        );
        // Spec de contrat des lectures générée ; celle des commandes n'a aucune
        // commande.
        const spec = compositionFile(plan, 'page-composition.queries.spec.ts');
        assert.match(spec, /name: 'catalogue'/);
        assert.match(spec, /deux load, les requêtes précédentes sont annulées/);
        // X5 C6 (F-C6-idle) : la lecture du produit est protégée par la
        // session ; le cas « déconnectée » est émis, `connected` pilotable.
        assert.match(
            spec,
            /name: 'catalogue',\s+initial: true,\s+protected: true,/
        );
        assert.match(
            spec,
            /session déconnectée, load accepté, aucune requête et état idle/
        );
        assert.match(spec, /connected: \(\) => options\.connected \?\? true/);
        // Page de lectures seules : aucune spec des commandes (une liste vide
        // ne se type pas) ; la spec des lectures porte les contrôles généraux.
        assert.equal(
            compositionFile(plan, 'page-composition.contract.spec.ts'),
            undefined
        );
        assert.match(
            spec,
            /expose exactement la table api, en Données lisibles/
        );
    }
});

test('C4 : une lecture publiée qui diffère du rendu attendu est refusée, nommée', async (t) => {
    const { product, options, queryId } = await queryPage(t, 'observatory');
    const facade = `${queryOutputRoot(queryId)}/src/${queryId}.facade.ts`;
    await publish(
        publication(
            product,
            { [facade]: 'export const altered = true;\n' },
            'generate:list-query'
        )
    );
    await assert.rejects(
        planExternalPageComposition(options),
        /page load catalogue differs from its published read; republish it with generate:list-query/
    );
});

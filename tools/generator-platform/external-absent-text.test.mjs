// X5 C5 (B+) : le texte d'absence d'une liaison de lecture va de la conception
// au plan SCELLÉ, puis à une constante de la composition générée
// (`absentText.<liaison>`), membre de donnée de sa table `api`. Deux produits
// fictifs ; le champ `label` y est déclaré nullable.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { planExternalPageComposition } from './core/external-page-composition.mjs';
import { pagePlanPath } from './core/external-publication-paths.mjs';
import { SESSION_FIXTURE_DOMAINS } from './test-support/external-session-fixture.mjs';
import {
    compositionFile,
    nullableLabel,
    queryPage,
} from './test-support/external-query-page.mjs';

const TEXT = 'Non renseigné';

test('B+ : texte scellé au plan, constante de composition', async (t) => {
    for (const domain of SESSION_FIXTURE_DOMAINS) {
        const { product, page, options } = await queryPage(
            t,
            domain,
            nullableLabel(domain, TEXT)
        );
        const composition = await planExternalPageComposition(options);
        // Le plan scellé porte le texte (lot 2 : sous le socle de l'appli).
        const plan = JSON.parse(
            await readFile(
                join(product.root, pagePlanPath(options.appName, page.id)),
                'utf8'
            )
        );
        assert.deepEqual(
            plan.output_bindings.map((binding) => [
                binding.id,
                binding.absent_text,
            ]),
            [['catalogue-rows', TEXT]],
            domain
        );
        // La composition le publie en constante, littéral inerte.
        assert.match(
            compositionFile(composition, 'page-composition.ts'),
            /readonly absentText = Object\.freeze\(\{\n\s+catalogueRows: 'Non renseigné',\n\s+\}\);/,
            domain
        );
        assert.match(
            compositionFile(composition, 'page-composition.api.ts'),
            /IsData<PageComposition\['absentText'\]\['catalogueRows'\]>/,
            domain
        );
    }
});

// Le refus est au PLAN de la page : `planExternalPagePlan`, cœur de
// `compile:page-execution-plan`, appelé par `queryPage`.
test('B+ : un champ lu nullable sans texte d’absence, refus nommé au plan de la page', async (t) => {
    const domain = SESSION_FIXTURE_DOMAINS[0];
    await assert.rejects(
        () => queryPage(t, domain, nullableLabel(domain, undefined)),
        /page plan refused \(page execution planner: PAGE_ABSENT_TEXT_MISSING: data binding catalogue-rows needs absent_text for label\)/
    );
});

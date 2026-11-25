// Lot 2, corrections de l'étape B (relecture Fable, L-6c-2 ; conception v3
// V3.5 a point 2) : l'ESLint de l'interface sur les AMORCES, au témoin
// d'`update-app`, éprouvé par les outils INSTALLÉS (ESLint et Nx de
// l'atelier, liés dans un produit fictif, aucune installation ; preuve
// légère, la preuve native d'`update-app` sur un produit installé reste au
// commit 14). Oracles écrits ici :
// - le contrôle lancé est celui de la transaction (`witnessControls`), sur
//   l'arbre témoin qu'elle pose (`stageWitnessTrees`), depuis la racine du
//   produit, le graphe des projets en cache comme après `create-app` ;
// - les amorces du générateur passent ; une amorce fautive (forme de Vite
//   que l'interface refuse) est refusée, et l'échec se lit comme la
//   transaction le lit (`failureLocation`) : couche `interface`, chemin de
//   la racine RÉELLE ; un avertissement seul suffit à refuser ;
// - Nx voit les arbres témoins (dossier caché que le `.gitignore` rendu
//   n'ignore pas) : tant qu'ils existent, le graphe est refusé (deux projets
//   du même nom). C'est pourquoi la transaction les retire avant l'échange.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
    failureLocation,
    stageWitnessTrees,
    witnessControls,
    witnessTrees,
} from './core/application-update-transaction.mjs';
import { removeTreeAndSync } from './core/generation-transaction.mjs';
import {
    coqueRoot,
    INTERFACE_PAGES_DIR,
    interfaceRoot,
} from './core/socle-names.mjs';
import {
    nativeEnv,
    nativeProduct,
    run,
} from './test-support/native-product.mjs';

const APP = 'app';
const PLAN_ID = 'e'.repeat(64);

// Commande du produit, depuis sa racine, sans démon : code et sortie.
async function command(root, args) {
    const result = await run(process.execPath, args, {
        cwd: root,
        env: nativeEnv(root),
        maxBuffer: 64 * 1024 * 1024,
    }).then(
        (output) => ({ ...output, code: 0 }),
        (error) => error
    );
    return {
        code: result.code,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(
            // eslint-disable-next-line no-control-regex
            /\u001b\[[0-9;]*m/g,
            ''
        ),
    };
}

const nxProjects = (root) =>
    command(root, [
        join(root, 'node_modules/nx/dist/bin/nx.js'),
        'show',
        'projects',
    ]);

const under = (files, root) =>
    Object.fromEntries(
        Object.entries(files)
            .filter(([path]) => path.startsWith(`${root}/`))
            .map(([path, content]) => [path.slice(root.length + 1), content])
    );

// L'appli `app` du produit fictif, sous la forme que la transaction lit :
// arbre de la coque, fichiers possédés de l'interface et amorces de toutes
// les pages (relatifs au produit).
function witnessApp(files, profile) {
    const ui = interfaceRoot(APP);
    const seeds = `${ui}/${INTERFACE_PAGES_DIR}/`;
    const interfaceFiles = Object.entries(files).filter(([path]) =>
        path.startsWith(`${ui}/`)
    );
    return {
        app_name: APP,
        profile,
        trees: [{ root: coqueRoot(APP), files: under(files, coqueRoot(APP)) }],
        product: Object.fromEntries(
            interfaceFiles.filter(([path]) => !path.startsWith(seeds))
        ),
        allSeeds: Object.fromEntries(
            interfaceFiles.filter(([path]) => path.startsWith(seeds))
        ),
    };
}

for (const profile of ['angular-pwa', 'react-spa']) {
    test(
        `${profile} : ESLint de l’interface au témoin, amorces du générateur vertes, amorce fautive refusée ; Nx voit les arbres témoins`,
        { timeout: 420_000 },
        async (t) => {
            const { root, files } = await nativeProduct(t, profile);
            const plan = { plan_id: PLAN_ID, productRoot: root };
            const app = witnessApp(files, profile);
            const lint = witnessControls(plan, app).find(
                ({ label }) => label === `witness:${APP}:interface-lint`
            );
            assert.ok(lint, profile);
            assert.equal(lint.layer, 'interface');
            // L'exécutable du paquet installé, par son champ `bin` (celui
            // qu'`installedBin` lit pour la transaction).
            const [packageName, executable] = lint.bin;
            const packageRoot = join(root, 'node_modules', packageName);
            const manifest = JSON.parse(
                await readFile(join(packageRoot, 'package.json'), 'utf8')
            );
            const eslint = () =>
                command(root, [
                    join(packageRoot, manifest.bin[executable]),
                    ...lint.args,
                ]);
            // Graphe des projets en cache, comme après les contrôles natifs
            // de `create-app`.
            const graph = await nxProjects(root);
            assert.equal(graph.code, 0, graph.output);
            await stageWitnessTrees(plan, app);
            const clean = await eslint();
            assert.equal(
                clean.code,
                0,
                `${profile} : amorces\n${clean.output}`
            );
            assert.doesNotMatch(clean.output, /No cached ProjectGraph/);
            // Amorce fautive, rendue telle quelle par un générateur cassé.
            const seed = Object.keys(app.allSeeds)
                .filter(
                    (path) => /\.tsx?$/.test(path) && !/\.spec\./.test(path)
                )
                .sort()[0];
            assert.ok(seed, profile);
            const [, interfaceWitness] = witnessTrees(APP, PLAN_ID);
            const witnessSeed = join(
                root,
                interfaceWitness,
                seed.slice(interfaceRoot(APP).length + 1)
            );
            const original = await readFile(witnessSeed, 'utf8');
            const fallback = { layer: 'interface', path: interfaceRoot(APP) };
            await writeFile(
                witnessSeed,
                `${original}\nexport const worker = new Worker(new URL('./worker.js', import.meta.url));\n`
            );
            const faulty = await eslint();
            assert.notEqual(
                faulty.code,
                0,
                `amorce fautive refusée\n${faulty.output}`
            );
            assert.match(faulty.output, /no-restricted-syntax/);
            assert.deepEqual(
                failureLocation(APP, faulty.output, root, fallback),
                { layer: 'interface', path: seed },
                faulty.output
            );
            t.diagnostic(
                `${profile} amorce fautive : ${faulty.output.trim().split('\n').slice(0, 3).join(' | ')}`
            );
            // Un avertissement seul (directive inutile) suffit à refuser.
            await writeFile(
                witnessSeed,
                `${original}\n// eslint-disable-next-line no-console\nexport const quiet = 1;\n`
            );
            const warned = await eslint();
            assert.notEqual(
                warned.code,
                0,
                `avertissement seul refusé\n${warned.output}`
            );
            assert.match(warned.output, /Unused eslint-disable directive/);
            assert.match(warned.output, /0 errors, 1 warning/);
            assert.deepEqual(
                failureLocation(APP, warned.output, root, fallback),
                { layer: 'interface', path: seed },
                warned.output
            );
            await writeFile(witnessSeed, original);
            // Nx voit les arbres témoins : deux projets du même nom.
            const seen = await nxProjects(root);
            assert.notEqual(
                seen.code,
                0,
                `Nx refuse le graphe, témoins présents\n${seen.output}`
            );
            assert.match(seen.output, /defined in multiple locations/);
            assert.ok(seen.output.includes(interfaceWitness), seen.output);
            t.diagnostic(
                `${profile} Nx, témoins présents : ${seen.output.trim().split('\n').slice(0, 5).join(' | ')}`
            );
            for (const path of witnessTrees(APP, PLAN_ID))
                await removeTreeAndSync(join(root, path));
            const after = await nxProjects(root);
            assert.equal(after.code, 0, after.output);
        }
    );
}

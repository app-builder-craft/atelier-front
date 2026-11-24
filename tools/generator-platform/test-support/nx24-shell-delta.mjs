import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { SIGNATURE_FILES } from '../core/atelier-signature.mjs';
import { canonicalizeGeneratedFiles } from '../core/canonicalize-generated.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Test oracle only. The native before/after fixtures qualify this transformation;
// production renderers never import it or migrate an existing application.
export async function nx24ShellDelta(profile, original) {
    const files = { ...original };
    const changed = {};
    if (profile === 'angular-pwa') {
        const { tags, targets, ...rest } = JSON.parse(files['project.json']);
        const serve = targets.serve;
        assert.equal(serve.executor, '@angular/build:dev-server');
        const { configurations, ...serveOptions } = serve;
        targets.serve = {
            ...serveOptions,
            readyWhen: { signal: true },
            configurations,
        };
        const staticTarget = targets['serve-static'];
        assert.equal(staticTarget.executor, '@nx/web:file-server');
        targets['serve-static'] = {
            ...staticTarget,
            readyWhen: { signal: true },
            dependsOn: ['build'],
        };
        changed['project.json'] = JSON.stringify(
            { ...rest, tags, targets },
            null,
            2
        );
    } else {
        assert.equal(profile, 'react-spa');
        const before = files['vite.config.mts'];
        const imports = [...before.matchAll(/^import .+;\n/gm)];
        const pluginPattern = /plugins: \[([^\]\n]+)\]/g;
        assert.ok(imports.length > 0);
        assert.equal([...before.matchAll(pluginPattern)].length, 1);
        const last = imports.at(-1);
        const position = last.index + last[0].length;
        changed['vite.config.mts'] = (
            before.slice(0, position) +
            "import { nxReadySignal } from '@nx/vite/plugins/nx-ready-signal.plugin';\n" +
            before.slice(position)
        ).replace(pluginPattern, 'plugins: [$1, nxReadySignal()]');
    }
    Object.assign(files, await canonicalizeGeneratedFiles(changed));
    const manifestPath = SIGNATURE_FILES.appManifest;
    if (Object.hasOwn(files, manifestPath)) {
        const manifest = JSON.parse(files[manifestPath]);
        for (const entry of manifest.generated_files) {
            if (!Object.hasOwn(changed, entry.path)) continue;
            entry.bytes = Buffer.byteLength(files[entry.path]);
            entry.sha256 = hash(files[entry.path]);
        }
        manifest.tree_sha256 = hash(
            manifest.generated_files
                .map((entry) => `${entry.path}\0${entry.sha256}`)
                .join('\0')
        );
        Object.assign(
            files,
            await canonicalizeGeneratedFiles({
                [manifestPath]: JSON.stringify(manifest, null, 2),
            })
        );
    }
    return files;
}

// Lot 2, commit 3 (v3 V3.5 f) : le manifeste d'appli porte `sources` dans
// les deux modes, juste après `design_ref` ; un rendu sans liaison fournie
// (cette référence historique) le rend vide. Oracle de test, comme ci-dessus.
export async function lot2SourcesDelta(original) {
    const files = { ...original };
    const manifestPath = SIGNATURE_FILES.appManifest;
    const manifest = JSON.parse(files[manifestPath]);
    assert.equal(Object.hasOwn(manifest, 'sources'), false);
    const next = {};
    for (const [key, value] of Object.entries(manifest)) {
        next[key] = value;
        if (key === 'design_ref') next.sources = [];
    }
    assert.deepEqual(next.sources, []);
    return {
        ...files,
        ...(await canonicalizeGeneratedFiles({
            [manifestPath]: JSON.stringify(next, null, 2),
        })),
    };
}

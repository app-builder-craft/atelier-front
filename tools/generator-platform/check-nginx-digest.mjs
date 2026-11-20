#!/usr/bin/env node
// X4-config, NGINX-FRAICHEUR (b) : fraîcheur de l'empreinte de l'image nginx
// du relais. Dependabot (écosystème docker, tous les jours) met lui-même à
// jour cette empreinte, même à tag inchangé : PR #13 du 2026-11-16, et
// dependabot-core docker/lib/dependabot/docker/update_checker.rb:244-285
// (@5838e62c). Il en est la source primaire ; ce script n'est que son chien
// de garde. Il tourne chaque jour, après Dependabot, dans
// .github/workflows/nginx-digest-freshness.yml, et jamais dans la CI des PR :
// une republication par Docker Hub ne rougit plus main ni les PR. Il voit ce
// que Dependabot laisse passer : index multi-arch changé à manifestes
// identiques, suppression expérimentale des PR d'empreinte, registre muet.
// Il compare l'empreinte épinglée, lue par le seul analyseur
// (check-nginx-image.mjs), à celle du tag dans le registre, avec trois issues
// fermées :
//   0 : concordance ;
//   1 : empreinte périmée (écart) ;
//   2 : vérification impossible (registre injoignable, délai, réponse illisible).
// Jamais de vert par défaut, et l'issue 2 ne masque jamais un écart.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    pinnedNginxImage,
    readNginxHarnessDockerfile,
} from './check-nginx-image.mjs';

export const DIGEST_TIMEOUT_MS = 60_000;

function defaultRun(args) {
    return spawnSync('docker', args, {
        encoding: 'utf8',
        timeout: DIGEST_TIMEOUT_MS,
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
}

export function checkNginxDigest(dockerfile, run = defaultRun) {
    const pinned = pinnedNginxImage(dockerfile);
    if (!pinned)
        return {
            code: 2,
            message:
                'CMZ_NGINX_DIGEST_UNVERIFIABLE image non épinglée par tag et empreinte',
        };
    const image = `nginx:${pinned.tag}`;
    const unverifiable = {
        code: 2,
        message: `CMZ_NGINX_DIGEST_UNVERIFIABLE ${image} : vérification impossible`,
    };
    let result;
    try {
        result = run(['buildx', 'imagetools', 'inspect', image]);
    } catch {
        return unverifiable;
    }
    if (!result || result.error || result.signal || result.status !== 0)
        return unverifiable;
    const digests = [
        ...String(result.stdout ?? '').matchAll(
            /^Digest:\s+(sha256:[a-f0-9]{64})\s*$/gm
        ),
    ].map((found) => found[1]);
    if (digests.length !== 1) return unverifiable;
    return digests[0] === pinned.digest
        ? { code: 0, message: `CMZ_NGINX_DIGEST_OK ${image}` }
        : {
              code: 1,
              message: `CMZ_NGINX_DIGEST_STALE ${image} : empreinte périmée`,
          };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const outcome = checkNginxDigest(readNginxHarnessDockerfile());
    (outcome.code === 0 ? console.log : console.error)(outcome.message);
    process.exitCode = outcome.code;
}

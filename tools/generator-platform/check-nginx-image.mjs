#!/usr/bin/env node
// X4-config, NGINX-FRAICHEUR (a) : structure de l'image nginx du relais.
// Déterministe et sans réseau, ce contrôle bloque la CI des PR et de main :
//   - le Dockerfile du harnais est la seule source de l'image : une seule
//     ligne FROM, `FROM nginx:<majeure>.<mineure>-alpine@sha256:<64 hex>` ;
//   - aucun autre fichier suivi n'épingle nginx par empreinte, et aucun autre
//     Dockerfile ne tire nginx ;
//   - `pinnedNginxImage` est le seul analyseur de cette ligne : le relais
//     (`renderers/external-relay-renderer.mjs`) et la fraîcheur
//     (`check-nginx-digest.mjs`) le consomment.
// Limite assumée : une empreinte bien formée mais publiée pour un autre tag
// passe ici, et le relais la tire. Seule la fraîcheur quotidienne (b) la voit.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolEnv } from './core/atelier-signature.mjs';

export const NGINX_HARNESS_DOCKERFILE =
    'tools/generator-platform/nginx-harness/Dockerfile';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const FROM_INSTRUCTION = /^\s*FROM\b/i;
const PINNED_FROM = /^FROM nginx:([a-z0-9][a-z0-9.-]*)@(sha256:[a-f0-9]{64})$/;
const TAG_POLICY = /^\d+\.\d+-alpine$/;
// Toute référence à l'image nginx qui porte une empreinte, quelle qu'en soit
// la casse ou le préfixe de registre.
const DIGEST_PIN = /\bnginx(?::[\w.-]+)?@sha256:[0-9a-f]{64}/i;
const OTHER_DOCKERFILE =
    /(?:^|\/)(?:Dockerfile|Containerfile)[^/]*$|\.(?:docker|container)file$/i;
const FROM_NGINX = /^\s*FROM\s+(?:--\S+\s+)*(?:\S*\/)?nginx(?:[:@\s]|$)/i;

const lines = (text) => String(text ?? '').split(/\r?\n/);

export function readNginxHarnessDockerfile(root = ROOT) {
    return readFileSync(join(root, NGINX_HARNESS_DOCKERFILE), 'utf8');
}

// Seul analyseur de la ligne FROM : `null` si le fichier n'a pas exactement
// une instruction FROM, de la forme stricte ci-dessus.
export function pinnedNginxImage(dockerfile) {
    const froms = lines(dockerfile).filter((line) =>
        FROM_INSTRUCTION.test(line)
    );
    if (froms.length !== 1) return null;
    const found = PINNED_FROM.exec(froms[0]);
    if (!found) return null;
    return {
        tag: found[1],
        digest: found[2],
        reference: `nginx:${found[1]}@${found[2]}`,
    };
}

// `files` : fichiers suivis `{ path, text }`, chemins POSIX relatifs.
export function nginxImageStructureErrors(dockerfile, files = []) {
    const errors = [];
    const source = lines(dockerfile);
    const froms = source.filter((line) => FROM_INSTRUCTION.test(line));
    const pinned = pinnedNginxImage(dockerfile);
    if (froms.length !== 1)
        errors.push(
            `${NGINX_HARNESS_DOCKERFILE} : ${froms.length} ligne(s) FROM, une seule attendue`
        );
    else if (!pinned)
        errors.push(
            `${NGINX_HARNESS_DOCKERFILE} : FROM attendu sous la forme nginx:<tag>@sha256:<64 hex minuscules>`
        );
    else if (!TAG_POLICY.test(pinned.tag))
        errors.push(
            `${NGINX_HARNESS_DOCKERFILE} : tag ${pinned.tag} hors politique <majeure>.<mineure>-alpine`
        );
    source.forEach((line, index) => {
        if (!FROM_INSTRUCTION.test(line) && DIGEST_PIN.test(line))
            errors.push(
                `${NGINX_HARNESS_DOCKERFILE}:${index + 1} : second épinglage de nginx hors de la ligne FROM`
            );
    });
    for (const { path, text } of files) {
        if (path === NGINX_HARNESS_DOCKERFILE) continue;
        const dockerfileLike = OTHER_DOCKERFILE.test(path);
        lines(text).forEach((line, index) => {
            if (DIGEST_PIN.test(line))
                errors.push(
                    `${path}:${index + 1} : épinglage de nginx hors du Dockerfile du harnais`
                );
            else if (dockerfileLike && FROM_NGINX.test(line))
                errors.push(
                    `${path}:${index + 1} : autre Dockerfile qui tire nginx`
                );
        });
    }
    return errors;
}

export function trackedFiles(root = ROOT) {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    })
        .split('\0')
        .filter(Boolean)
        .sort();
}

function readTracked(root, path) {
    try {
        return readFileSync(join(root, path), 'utf8');
    } catch (error) {
        // Fichier suivi supprimé de l'arbre, ou lien de sous-module.
        if (error.code === 'ENOENT' || error.code === 'EISDIR') return '';
        throw error;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    let errors;
    let dockerfile;
    try {
        dockerfile = readNginxHarnessDockerfile();
        errors = nginxImageStructureErrors(
            dockerfile,
            trackedFiles().map((path) => ({
                path,
                text: readTracked(ROOT, path),
            }))
        );
    } catch (error) {
        errors = [`lecture impossible (${error.message})`];
    }
    if (errors.length === 0)
        console.log(
            `${toolEnv('NGINX_IMAGE_OK')} ${pinnedNginxImage(dockerfile).reference}`
        );
    for (const error of errors)
        console.error(`${toolEnv('NGINX_IMAGE_INVALID')} ${error}`);
    process.exitCode = errors.length === 0 ? 0 : 1;
}

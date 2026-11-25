// Lot 2 (conception v5, C-B2 ; décision du pilote T-E8 = P1) : SOURCE UNIQUE
// des contrôles natifs d'une appli extérieure, lue par `create-app`, les
// publications, le renommage du préfixe (`verifyRenamed`), l'exécuteur
// d'oracle et les preuves natives. La liste se lit dans les configurations
// RENDUES de l'appli (jamais une liste écrite à la main) : `lint` de chaque
// projet, PUIS `build:production` de la coque (qui lance `^typecheck`), PUIS
// `test` de chaque projet qui PORTE la cible. Le lint passe avant la
// construction : une directive `@plugin` ou `@config` de Tailwind dans le CSS
// d'une page ferait importer par la construction un module de la zone libre
// (constat T-E8) ; le refus Stylelint du lot 5 doit pouvoir passer d'abord.
import {
    coqueRoot,
    interfaceRoot,
    LIBS_ROOT,
    socleRoot,
} from './socle-names.mjs';

// Les trois projets d'une appli, dans l'ordre : coque, socle, interface.
export const applicationProjectRoots = (appName) => [
    coqueRoot(appName),
    socleRoot(appName),
    interfaceRoot(appName),
];

// Un projet porte une cible : déclarée dans son `project.json`, ou INFÉRÉE
// par le greffon natif depuis son fichier de configuration (`lint` :
// `eslint.config.mjs`, greffon `@nx/eslint` ; `test` en React :
// `vite.config.mts`, greffon `@nx/vitest`, C-A3).
function carries(files, root, target) {
    const project = JSON.parse(files[`${root}/project.json`]);
    if (project.targets?.[target]) return true;
    if (target === 'lint')
        return Object.hasOwn(files, `${root}/eslint.config.mjs`);
    if (target === 'test')
        return Object.hasOwn(files, `${root}/vite.config.mts`);
    return false;
}

// `files` : fichiers possédés de l'appli, relatifs au produit (inventaire).
// Rend [{ project, target, label }], `label` étant l'argument de `nx run`.
export function nativeControls(appName, files) {
    const projects = applicationProjectRoots(appName).map((root) => ({
        root,
        name: JSON.parse(files[`${root}/project.json`]).name,
    }));
    const controls = [];
    for (const { root, name } of projects)
        if (carries(files, root, 'lint'))
            controls.push({ project: name, target: 'lint' });
    controls.push({ project: projects[0].name, target: 'build:production' });
    for (const { root, name } of projects)
        if (carries(files, root, 'test'))
            controls.push({ project: name, target: 'test' });
    return controls.map((control) => ({
        ...control,
        label: `${control.project}:${control.target}`,
    }));
}

// Appels du runner attendus d'un plan d'appli (création ou publication) : un
// compilateur par candidat de BIBLIOTHÈQUE (`plan.roots` sous `libs/`, L-14),
// puis la liste unique des contrôles natifs, puis le contrat de l'espace. Lu
// par les tests et les preuves natives, jamais réécrit à la main.
export function nativeRunLabels(plan) {
    return [
        ...plan.roots
            .filter(({ root }) => root.startsWith(`${LIBS_ROOT}/`))
            .map(() => 'native-compiler'),
        ...nativeControls(plan.app_name, plan.files).map(({ label }) => label),
        'workspace-contract',
    ];
}

# ADR 0105 — Socle séparé et frontières natives

- Statut : acceptée (2026-11-24).
- Portée : atelier 2, disposition des produits extérieurs (lot 2, commits 1a,
  1b, 2 et 3, corrections de l'étape A, correction de tête de l'étape B et
  commit 6a) et outils de l'atelier qui les écrivent.
- Décisions appliquées : point 1 des décisions de l'atelier 2 (trois couches,
  option A) ; lecture A du pilote (tout le code généré est au socle) ;
  frontières par projet (conception du lot 2, v4 § V4.3) ; noms fixes sans
  préfixe (v4 § V4.1 et § V4.2).

## Contexte

Une appli d'un produit extérieur vivait dans une seule racine, `apps/<app>`, où
le code généré, la configuration et les pages écrites par l'IA se côtoyaient.
L'atelier 2 sépare ce qui est généré et scellé (le socle) de ce qui est libre
(l'interface), et doit le garantir par les outils du produit eux-mêmes, sans
contrôle maison qu'un développeur ne verrait pas.

## Décision

### 1. Trois racines par appli (lecture A)

| Racine                     | Projet Nx         | Tags                                       | Statut                                                  |
| -------------------------- | ----------------- | ------------------------------------------ | ------------------------------------------------------- |
| `apps/<app>` (coque)       | `<app>`           | `type:app`, `experience:<id>`, `app:<app>` | arbre exact, possédé                                    |
| `libs/<app>-socle` (socle) | `<app>-socle`     | `layer:socle`, `app:<app>`                 | arbre exact, possédé                                    |
| `libs/<app>-interface`     | `<app>-interface` | `layer:interface`, `app:<app>`             | configuration et `src/index.ts` exacts ; `src/**` libre |

- **Coque** : tout ce qui porte une forme du préfixe ou qui est propre au
  déploiement (configuration du projet, `index.html`, point d'entrée, routes,
  garde d'accès sans session, `public/**` dont le service worker, relais
  `deploy/**`, dossier de signature avec le manifeste d'appli).
- **Socle** : la session, et TOUT le code publié par les outils de l'atelier
  (commandes, lectures, plans et compositions de page). Son API publique est
  `src/index.ts` (alias `@socle/<app>`) ; `src/coque.ts` est l'entrée réservée à
  la coque (clé exacte `@socle-coque/<app>`, dans le seul tsconfig de la coque).
- **Interface** : la carte des pages (`src/index.ts`, possédée) et, sous
  `src/pages/<page>/`, des amorces non possédées que l'IA remplace librement.
- L'inventaire `generated_files` du manifeste d'appli porte des chemins relatifs
  au produit ; le manifeste reste dans la coque. Le vérificateur scellé du
  produit (`<sig>/support/check-workspace.mjs`) vérifie les trois racines :
  socle exact, interface exacte hors de `src/**`, aucun fichier ajouté hors du
  générateur, aucune entrée de `libs/` sans appli.
- **Zones d'écriture** : une publication n'ajoute que sous
  `libs/<app>-socle/src/{actions,queries}/…` et sous
  `libs/<app>-socle/src/pages/<page>/…` d'une page déclarée ; elle ne remplace
  qu'un fichier qu'une publication a ajouté, ou le module vide de page du socle
  ; jamais un autre fichier de la coque, ni la configuration d'une bibliothèque.
  Les motifs viennent d'une seule source (`socle-names.mjs`).
- **Imports du code généré** : les spécifieurs relatifs entre fichiers du socle
  sont dérivés des constantes de disposition (`posix.relative`), jamais écrits à
  la main.

### 2. Noms fixes, et où le préfixe a le droit d'exister

- Les alias `@socle/*`, `@interface/*` (racine, motifs fixes) et la clé
  `@socle-coque/<app>` (coque), les tags et les contraintes de couche viennent
  d'une seule source de l'atelier,
  `tools/generator-platform/core/socle-names.mjs`. Aucun nom fixe ne correspond
  à une famille de noms du préfixe.
- Une forme du préfixe n'existe que dans la coque et les fichiers d'espace, et
  seulement pour un nom que le renommage de préfixe classe déjà par famille ; le
  socle et la configuration de l'interface n'en portent aucune (trois couches de
  preuve : contexte des renderers sans identité, préfixe distinctif cherché
  partout, familles). **Qui hérite** : le renommage de préfixe reste sur
  `apps/<app>` et le manifeste d'espace ; il ne touche jamais `libs/`.

### 3. Modèle de transaction sur plusieurs racines

- Une brique commune (`core/product-transaction.mjs`), extraite du renommage de
  préfixe (ADR-0103) puis généralisée, porte `create-app` (trois racines créées
  depuis l'absence), les quatre publications du socle (coque et socle) et la
  reprise.
- Opération `tree` sur une racine entièrement possédée ou absente : candidat
  `.<racine>.<genre>-candidate-<plan>` et arbre mis de côté
  `.<racine>.<genre>-previous-<plan>`, à côté de la racine, échange par deux
  renommages. Les états « avant » et « après » sont des listes d'artéfacts
  (chemin, empreinte, octets) inscrites au journal : c'est ce qui rend
  vérifiable le socle, qui ne porte pas de manifeste.
- Journal à côté du produit, phases `prepared`, `staged`, `swapped`, `verified`
  ; la reprise décide par l'état OBSERVÉ de chaque arbre ; avant `verified`,
  retour arrière ; à `verified`, nettoyage en avant ; état ambigu : rien n'est
  déplacé, refus nommé. Tout journal présent bloque toute autre commande, sauf
  la reprise de cette transaction.
- L'opération `files` (bascule fichier par fichier d'une racine partiellement
  possédée), prévue pour la grammaire, n'est pas construite : la grammaire est
  retirée (ADR 0104) et aucune publication n'écrit l'interface après sa
  création.

### 4. Fichiers d'espace changés par le lot 2

Ligne « lot 2 » du tableau des lots qui changent l'espace :

- commit 1b : `tsconfig.base.json` (deux motifs fixes), le vérificateur scellé,
  et — hors du tableau de conception, pour que Nx ne voie pas deux projets de
  même nom pendant les contrôles natifs — les dossiers de travail des
  transactions ajoutés aux ignorés de `.gitignore` et de l'ESLint racine ;
- commit 2 : l'ESLint racine (contraintes de couche) et le paquet
  `@nx/eslint-plugin` (`package.json`, `bun.lock` du produit) ;
- commit 3 : `<sig>/support/check-socle.mjs` ajouté (vérificateur par appli) et
  `<sig>/support/check-workspace.mjs` modifié : la chaîne d'empreintes
  conception → contrat le quitte (remplacée par `staleSources` de la liaison,
  dans `check-socle.mjs`) et `WorkspaceDrift` y est exporté, pour que
  `check-socle.mjs` nomme son échec ;
- correction de l'étape A (revue, B-3) : l'ESLint racine exporte en plus
  `INTERFACE_RESTRICTED_SYNTAX` ;
- correction de tête de l'étape B (validation de l'étape A, réserve R3) : le
  sélecteur du worker de `INTERFACE_RESTRICTED_SYNTAX` est élargi (ESLint
  racine).

Aucun produit extérieur n'existait avant ces changements ; il n'y a pas de
migration.

### 5. Frontières natives

- **Racine** (`eslint.config.mjs` de l'espace, rendu une fois) : déclare
  `@nx/enforce-module-boundaries` avec les seules contraintes de COUCHE,
  exportées comme données (`LAYER_CONSTRAINTS`) : `type:app` ne dépend que de
  `layer:socle` et `layer:interface` ; `layer:interface` que de `layer:socle` ;
  `layer:socle` que de `layer:socle`. Elle exporte aussi l'entrée
  `no-restricted-imports` de l'interface (`SOCLE_COQUE_RESTRICTION`), une seule
  entrée par règle et par groupe de fichiers.
- **Chaque projet** (coque, socle, interface) a son `eslint.config.mjs`, rendu
  par `create-app`, qui importe la racine et REDÉCLARE la règle en entier :
  contraintes de couche, plus `app:<app>` ne dépend que de `app:<app>`. La
  redéclaration entière est obligatoire : avec ESLint 10, des options données
  plus tard remplacent les précédentes. La racine n'est jamais retouchée par
  appli ; `create-app` d'une nouvelle appli la laisse identique à l'octet.
- **Ce que la règle refuse, mesuré** sur des produits fictifs des deux piles
  (`external-library-frontiers.test.mjs`, sortie JSON d'ESLint citée au journal
  du test) :

    | Import écrit                                                                                                                      | Refus natif                                                                                                           |
    | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
    | interface → `../../<app>-socle/src/coque` (relatif vers l'entrée de la coque)                                                     | `noRelativeOrAbsoluteImportsAcrossLibraries` : « Projects cannot be imported by a relative or absolute path… »        |
    | interface → fichier interne du socle, par un chemin relatif                                                                       | idem                                                                                                                  |
    | interface → fichier de la coque, par un chemin relatif                                                                            | idem                                                                                                                  |
    | interface → `@socle/<autre>`                                                                                                      | `onlyTagsConstraintViolation` : « A project tagged with "app:<app>" can only depend on libs tagged with "app:<app>" » |
    | interface → `@socle-coque/<app>`                                                                                                  | `no-restricted-imports` (et, au `typecheck` de l'interface, TS2307 ; TS2882 pour un import d'effet)                   |
    | interface → `import.meta.glob('<relatif>')` (globbing de Vite)                                                                    | `no-restricted-syntax` (`import.meta.glob…`, données `INTERFACE_RESTRICTED_SYNTAX`)                                   |
    | interface → `/// <reference types="vite/client" />`                                                                               | `@typescript-eslint/triple-slash-reference` (`lib`, `path`, `types` : `never`)                                        |
    | interface → `new Worker(…)` dont l'appel contient `import.meta` (`new URL('<relatif>', import.meta.url)`, `.href`, `.toString()`) | `no-restricted-syntax` (worker construit sur un chemin)                                                               |
    | socle → `@interface/<app>`                                                                                                        | `onlyTagsConstraintViolation` (`layer:socle`)                                                                         |
    | socle ou coque → `@socle/<autre>`                                                                                                 | `onlyTagsConstraintViolation` (`app:<app>`)                                                                           |
    | coque → socle par un chemin relatif                                                                                               | `noRelativeOrAbsoluteImportsAcrossLibraries`                                                                          |
    | interface → `@socle/<app>` (API publique)                                                                                         | admis                                                                                                                 |

    Les quatre premières formes étaient OUVERTES au commit 1b (revue du 1b, A-2)
    : TypeScript compile un import relatif hors de `include` sans erreur, parce
    que le `rootDir` des projets est la racine du produit ; seule la règle de
    frontières les ferme, au `lint`. Les trois formes de Vite ne passent pas par
    la résolution de modules que lit la règle de Nx : sans les deux règles
    standard de l'interface, une page React qui les écrit passe le `lint`, la
    vérification de types (avec la directive de types de Vite) et la
    construction (mesuré par la revue de l'étape A, B-3) ; avec elles, le `lint`
    les refuse (cas du test, sortie citée).

- **Réécritures des formes de Vite, mesurées** (validation de l'étape A, réserve
  R3 : construction Vite 8.3.5 d'un produit fictif React, marqueur à effet de
  bord dans un fichier du socle, sortie cherchée dans `dist/`) :
  `new Worker(new URL('<relatif>', import.meta.url).href)` et `.toString()` sont
  SUIVIES par Vite (le fichier du socle est empaqueté en worker), alors que le
  `lint` et la vérification de types passaient : le sélecteur refuse désormais
  tout `import.meta` dans l'appel d'un worker. Trois réécritures ne sont PAS
  suivies par la construction et ne sont pas refusées par le `lint` : l'accès
  calculé `import.meta['glob'](…)` (pas une forme de Vite ; `undefined` à
  l'exécution), un `URL` renommé (`const U = URL; new Worker(new U(…))`) et une
  URL construite hors de l'appel du worker
  (`const u = new URL(…); new Worker(u)`) : rien du socle n'est émis, et
  l'adresse vise un chemin que le produit ne sert pas. C'est la limite exacte :
  ces formes n'atteignent pas le code du socle dans la construction mesurée ; le
  serveur de développement de Vite n'a pas été mesuré.
- **Portée des règles de l'interface, par construction** :
  `no-restricted-syntax` et `@typescript-eslint/triple-slash-reference` ne sont
  posées que sur l'interface. Ce n'est pas une limite : le socle et la coque
  sont des fichiers POSSÉDÉS et scellés, écrits par le générateur seul et
  refusés à toute dérive par l'intégrité (§ 1) ; l'IA n'y écrit pas.

- **Garantie « l'interface n'importe pas l'entrée de la coque »**, quatre jambes
  natives, chacune accrochée au portail et mutée : (i) le `typecheck` de
  l'interface, avec son propre tsconfig (TS2307), dont dépend la construction de
  la coque (`^typecheck`) ; (ii) `no-restricted-imports` sur `@socle-coque/*` ;
  (iii) `noRelativeOrAbsoluteImportsAcrossLibraries` pour les chemins relatifs
  et absolus ; (iv) `no-restricted-syntax` et
  `@typescript-eslint/triple-slash-reference` pour les formes de Vite.
- **Issue de R-S (b), mesurée** : sous Vite 8.3.5, le build React de la coque,
  qui paquette les pages de l'interface, NE résout PAS l'ALIAS
  `@socle-coque/<app>` écrit dans une page de l'interface (« Rolldown failed to
  resolve import »). Cela ne vaut que pour l'alias : un chemin RELATIF vers le
  socle passe la construction React et `tsc`, et les formes de Vite ci-dessus
  aussi (revue de l'étape A). La garantie contre les relatifs et les formes de
  Vite est donc celle du `lint` par Nx, qui passe AVANT la construction dans les
  contrôles natifs d'une création ou d'une publication (liste unique C-B2) ; une
  construction lancée seule, sans `lint`, ne la donne pas. En Angular, le build
  de la coque compile les pages de l'interface dans son propre programme
  TypeScript, avec les `paths` de la coque, où l'alias se résout (conception du
  lot 2, v4 § V4.4) : la garantie y repose sur les jambes du `lint` et du
  `typecheck` ; `import.meta.glob` n'existe pas dans la construction Angular
  (non mesuré).
- **Limite native connue** : la règle lit le graphe du produit en cache. La
  cible `lint` (`nx run <projet>:lint`) le calcule avant ESLint ; un appel
  direct d'ESLint sans graphe en cache saute la règle avec un avertissement
  (`@nx/eslint-plugin` 24.0.3), que `--max-warnings=0` ne voit pas (mesuré par
  la revue). Le produit ne se lint que par ses cibles Nx.

### 6. Cible `check-socle`

- Le socle de chaque appli porte la cible `check-socle` (`nx:run-commands`) ; le
  `lint` de la coque et celui de l'interface en dépendent. Au commit 2, elle
  lance le vérificateur scellé de l'espace ; depuis le commit 3, le script PAR
  APPLI `<sig>/support/check-socle.mjs --app <app>` : contrôles d'espace, puis
  sources liées de CETTE appli (`SOURCES_STALE <genre> <chemin>`) et dossiers de
  page de l'interface absents de sa conception (`INTERFACE_PAGE_ORPHAN`), tous
  les écarts d'un coup, sans chemin local. Le `lint` d'une appli à jour reste
  vert si une autre est périmée.
- La dépendance NOMME le projet socle de l'appli
  (`{ target: 'check-socle', projects: ['<app>-socle'] }`) au lieu de la forme
  `^check-socle` de la conception : `^` suit les arêtes du graphe, et une appli
  sans session n'en a aucune vers son socle (la coque ni l'interface n'importent
  le socle) ; mesuré sur un produit React, la forme `^check-socle` ne déclenche
  rien (mesure confirmée par la revue ; forme retenue par le pilote, lecture L-1
  bis). Le `lint` du socle n'en dépend pas.
- Les contrôles natifs d'une création ou d'une publication lancent `check-socle`
  comme dépendance de tâche du `lint` de la coque et de l'interface
  (`runNativeControls` ne le nomme pas) ; la mise à jour d'appli du lot 2 le
  lancera aussi explicitement. Cette dépendance est prouvée par le graphe des
  tâches de Nx (`--graph=stdout`) : les preuves légères lancent les cibles sans
  leurs dépendances (dépendances liées depuis l'atelier, que le vérificateur
  d'espace refuse) ; l'exécution réelle de `check-socle` sur un produit installé
  est celle de la preuve native de la CI.

## Conséquences

- Un import qui franchit une frontière est refusé par le `lint` natif du
  produit, avec le message de l'outil ; aucune liste par appli n'est maintenue,
  et une nouvelle appli ne touche pas la racine.
- Le contrôle avant échange compile les candidats de bibliothèque seuls (`ngc`
  ou `tsc`, `--noEmit`) ; la coque se compile après l'échange, avant `verified`.
- Une forme de frontière nouvelle s'ajoute comme contrainte de couche dans
  `socle-names.mjs`, ou comme sélecteur de `INTERFACE_RESTRICTED_SYNTAX`, jamais
  dans un fichier d'appli.
- La directive `/// <reference …>` est refusée dans TOUT fichier de l'interface,
  configuration comprise : le `vite.config.mts` que le lot 7 rendra pour
  l'interface (première spec) s'écrit sans elle (sa configuration importe
  `vitest/config`, qui porte déjà les types de la section `test`).
- Remplacement d'une sortie par son auteur (commit 6a) : le plan d'un document
  lie l'empreinte de la sortie présente (`output_before_sha256`, nulle pour une
  création, dont l'identifiant de plan ne change pas), calculée en un seul lieu
  (`documentPlan`). L'application ne remplace que cette sortie, par le renommage
  atomique d'un candidat nommé par le plan relu ; une sortie étrangère, ou
  changée depuis le plan, est refusée et laissée telle quelle ; l'après déjà en
  place est un rejeu sans effet. Limite : le rejeu d'un remplacement FAIT est
  refusé comme périmé, puisque son « avant » n'existe plus ; un plan neuf voit
  l'après, et son application ne change rien. La seconde compilation d'un
  contrat à la même sortie est prouvée ; la preuve P8 est complète au commit 6c,
  avec `update-app`.
- Un dossier de sortie absent, ou une source absente, est un refus nommé par son
  chemin relatif au produit (`output parent directory missing: <chemin>`), sans
  `ENOENT` brut ni chemin local (commit 6a).

# ADR 0105 — Socle séparé et frontières natives

- Statut : acceptée (2026-11-24).
- Portée : atelier 2, disposition des produits extérieurs (lot 2, commits 1a, 1b
  et 2) et outils de l'atelier qui les écrivent.
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
  `@nx/eslint-plugin` (`package.json`, `bun.lock` du produit).

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

    | Import écrit                                                                  | Refus natif                                                                                                           |
    | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
    | interface → `../../<app>-socle/src/coque` (relatif vers l'entrée de la coque) | `noRelativeOrAbsoluteImportsAcrossLibraries` : « Projects cannot be imported by a relative or absolute path… »        |
    | interface → fichier interne du socle, par un chemin relatif                   | idem                                                                                                                  |
    | interface → fichier de la coque, par un chemin relatif                        | idem                                                                                                                  |
    | interface → `@socle/<autre>`                                                  | `onlyTagsConstraintViolation` : « A project tagged with "app:<app>" can only depend on libs tagged with "app:<app>" » |
    | interface → `@socle-coque/<app>`                                              | `no-restricted-imports` (et TS2307 au `typecheck` de l'interface)                                                     |
    | socle → `@interface/<app>`                                                    | `onlyTagsConstraintViolation` (`layer:socle`)                                                                         |
    | socle ou coque → `@socle/<autre>`                                             | `onlyTagsConstraintViolation` (`app:<app>`)                                                                           |
    | coque → socle par un chemin relatif                                           | `noRelativeOrAbsoluteImportsAcrossLibraries`                                                                          |
    | interface → `@socle/<app>` (API publique)                                     | admis                                                                                                                 |

    Les quatre premières formes étaient OUVERTES au commit 1b (revue du 1b, A-2)
    : TypeScript compile un import relatif hors de `include` sans erreur, parce
    que le `rootDir` des projets est la racine du produit ; seule la règle de
    frontières les ferme, au `lint`.

- **Garantie « l'interface n'importe pas l'entrée de la coque »**, trois jambes
  natives, chacune accrochée au portail et mutée : (i) le `typecheck` de
  l'interface, avec son propre tsconfig (TS2307), dont dépend la construction de
  la coque (`^typecheck`) ; (ii) `no-restricted-imports` sur `@socle-coque/*` ;
  (iii) `noRelativeOrAbsoluteImportsAcrossLibraries` pour les chemins relatifs
  et absolus.
- **Issue de R-S (b), mesurée** : sous Vite 8.3.5, le build React de la coque,
  qui paquette les pages de l'interface, NE résout PAS `@socle-coque/<app>`
  écrit dans une page de l'interface (« Rolldown failed to resolve import ») ;
  la garantie tient donc aussi sous Vite, en plus des trois jambes. En Angular,
  le build de la coque compile les pages de l'interface dans son propre
  programme TypeScript, avec les `paths` de la coque, où l'alias se résout
  (conception du lot 2, v4 § V4.4) : la garantie y repose sur les trois jambes.
- **Limite native connue** : la règle lit le graphe du produit en cache. La
  cible `lint` (`nx run <projet>:lint`) le calcule avant ESLint ; un appel
  direct d'ESLint sans graphe en cache saute la règle avec un avertissement
  (`@nx/eslint-plugin` 24.0.3). Le produit ne se lint que par ses cibles Nx.

### 6. Cible `check-socle`

- Le socle de chaque appli porte la cible `check-socle` (`nx:run-commands`), qui
  lance le vérificateur scellé du produit ; le `lint` de la coque et celui de
  l'interface en dépendent. Le script par appli, avec la fraîcheur des sources,
  la remplace au commit suivant du lot 2.
- La dépendance NOMME le projet socle de l'appli
  (`{ target: 'check-socle', projects: ['<app>-socle'] }`) au lieu de la forme
  `^check-socle` de la conception : `^` suit les arêtes du graphe, et une appli
  sans session n'en a aucune vers son socle (la coque ni l'interface n'importent
  le socle) ; mesuré sur un produit React, la forme `^check-socle` ne déclenche
  rien. Le `lint` du socle n'en dépend pas : la commande qui régénère une appli
  lance `check-socle` explicitement.

## Conséquences

- Un import qui franchit une frontière est refusé par le `lint` natif du
  produit, avec le message de l'outil ; aucune liste par appli n'est maintenue,
  et une nouvelle appli ne touche pas la racine.
- Le contrôle avant échange compile les candidats de bibliothèque seuls (`ngc`
  ou `tsc`, `--noEmit`) ; la coque se compile après l'échange, avant `verified`.
- Une forme de frontière nouvelle s'ajoute comme contrainte de couche dans
  `socle-names.mjs`, jamais dans un fichier d'appli.

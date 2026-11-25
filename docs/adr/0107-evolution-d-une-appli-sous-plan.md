# ADR 0107 — Évolution d'une appli sous plan

- Statut : acceptée (2026-11-25).
- Portée : atelier 2, mise à jour des applis d'un produit extérieur (lot 2,
  commit 6c) : `update-app`, sa reprise `recover:application-update`,
  l'enregistrement `update-app` du sceau, et les preuves de la commande. Les
  preuves natives (produit installé, deux piles) viennent au commit 14.
- Décisions appliquées : cadrage § 20 ; lectures A et B du pilote (conception du
  lot 2, v4 § V4.8) ; décisions du pilote T-B1 à T-B4 de l'étape B ; zone par
  dernier écrivain et page conservée (v5 C-B3) ; opération `files` (ADR 0105,
  commit 6b).

## Contexte

Une appli extérieure était créée par `create-app`, puis seulement publiée ou
renommée : toute retouche d'une source liée (conception, contrat et leurs
sources) rendait le produit périmé, et tout consommateur était refusé
(`APP_SOURCES_STALE … ; lancer update-app --target-root <racine> --dry-run`),
sans commande pour lier la nouvelle valeur. Le cadrage § 20 demande cette
commande, sous plan, qui montre la source changée, son empreinte avant et après,
et les fichiers générés touchés.

## Décision

### 1. Une commande pour tout le produit

`bun run update-app --target-root <racine> --dry-run` montre le plan, sans rien
écrire ; `--expect-plan <plan_id>` l'applique exactement, ou refuse s'il a
changé (`reviewed update plan is stale`). Il n'y a pas d'option `--app` : des
applis peuvent partager une source, et la garde de fraîcheur est globale. Une
seule transaction porte toutes les applis, avec le même `plan_id` dans chaque
enregistrement, comme le renommage du préfixe.

### 2. Le plan, dans cet ordre

1. L'intégrité d'abord, inchangée : un fichier possédé retouché est refusé avant
   toute lecture de source ; `update-app` ne blanchit jamais une retouche. Sa
   classe (`update`) rapporte la fraîcheur sans la refuser.
2. L'espace est re-rendu par le générateur courant et comparé aux fichiers que
   son manifeste inscrit : un écart est
   `UPDATE_REQUIRES_WORKSPACE_CHANGE <fichier>`.
3. Chaque appli est rendue depuis ses sources PRÉSENTES par les renderers de
   `create-app`. Une conception que la validation refuse arrête tout le plan :
   `UPDATE_APP_REJECTED <app> design <chemin> : <raison>`, une ligne par appli
   en cause, triées ; rien n'est écrit, pas même pour les autres.
4. Les changements sont calculés chemin par chemin, par DERNIER ÉCRIVAIN (§ 3).
5. Les amorces des pages NOUVELLES entrent dans le plan (chemins et octets), à
   des chemins absents, sinon `UPDATE_SEED_PATH_TAKEN <chemin>`. Une page
   retirée perd sa route et son contrat ; son dossier d'interface reste, cité
   par le plan (`interface_orphans`) et par le contrôle du produit
   (`INTERFACE_PAGE_ORPHAN`).
6. Aucun changement nulle part (ni liaison, ni fichier) :
   `update without change`.

Le `plan_id` lie l'outil, le produit, l'espace, l'installation, la liaison
courante de toutes les applis, et par appli son manifeste, sa liaison d'avant et
d'après, ses changements et ses amorces. Le plan public ne montre que des
chemins relatifs au produit.

### 3. Zone par dernier écrivain

Un seul ensemble d'écrivains DÉRIVÉS, partagé par le renommage et la mise à jour
: la coque, un renommage, une mise à jour. `update-app` remplace ou retire un
fichier de l'inventaire dont le dernier écrivain est dérivé ; il ajoute un
fichier des trois racines de l'appli, jamais dans la zone libre de l'interface.
Un fichier écrit en dernier par une publication n'est jamais touché : vouloir le
réécrire est `UPDATE_PATH_OWNED_BY_PUBLICATION <app> <chemin> <outil>`.
Exception écrite par la conception (C-B3) : le module de page composé d'une page
CONSERVÉE garde sa composition publiée, même si la coque rendrait le module
vide. Une publication gardée doit rester dans sa zone : celle d'une page retirée
est refusée du même code.

### 4. L'enregistrement, la chaîne des sources, la version du sceau

L'enregistrement `update-app` porte `sources_before`, `sources_after` (listes
complètes) et ses fichiers (`added`, `replaced` et `removed`, avec `before`),
triés ; il peut n'avoir aucun fichier si seule la liaison change. Le niveau haut
du manifeste porte la liaison courante. La première mise à jour pose dans le
sceau la liaison de CRÉATION (`ownership.shell_sources`, la liaison scellée du
manifeste qu'elle prolonge) ; la clé est exigée dès qu'une mise à jour est
présente, absente sinon, et jamais réécrite. La vérification rejoue l'historique
: la première mise à jour part de la liaison de création, chaque suivante de la
liaison d'arrivée de la précédente, la dernière arrive à celle du manifeste
(`update record breaks the sources chain`). La version du sceau est dérivée de
l'historique : 1.0.0, 1.1.0 avec un renommage, 1.2.0 dès qu'une mise à jour est
présente. Tous les écrivains du manifeste l'emploient (publication, renommage,
mise à jour).

### 5. La transaction

Le journal vit à côté du produit, au niveau du produit. Il porte des opérations
`tree` (coque et socle, racines exactes) et `files` (configuration et amorces de
l'interface, copies d'avant dans le journal). Dans cet ordre :

1. Candidats, puis témoin BLOQUANT : le socle candidat (ou le socle en place
   s'il ne change pas), une interface témoin (la configuration d'après et les
   amorces de TOUTES les pages, à la place des sources de l'IA), puis la coque
   candidate, chacun compilé sans émettre, leurs alias tournés vers les
   candidats ; puis l'ESLint de l'interface sur l'interface témoin, depuis la
   racine du produit, sans avertissement admis : une amorce doit respecter les
   règles de l'interface. Un rouge est
   `UPDATE_GENERATOR_BROKEN <couche> <fichier>` : une faute du générateur,
   jamais de l'IA ; retour exact. Les arbres témoins sont retirés avant
   l'échange : leur `project.json`, dans un dossier caché que le `.gitignore` du
   produit n'ignore pas, ferait voir à Nx deux projets du même nom (mesuré, Nx
   refuse alors le graphe : `defined in multiple locations`).
2. Les candidats sont vérifiés à l'octet en dernier, juste avant le premier
   échange ; puis les échanges, dans l'ordre fixé.
3. Contrôles du SOCLE (`lint`, `test`) et contrat de l'espace, BLOQUANTS ; puis
   post-condition `derived` : rendu aux sources présentes, le produit n'a plus
   rien à changer.
4. L'appli réelle (coque et interface de l'IA) est lancée et RAPPORTÉE, sans
   bloquer (lecture A) : une ligne `RAPPORT_INTERFACE: VERT`, ou
   `RAPPORT_INTERFACE: ROUGE <couche> <chemin>`, la couche valant `interface` (à
   l'IA de corriger), `coque` ou `socle` (faute du générateur, à rapporter). Le
   code de sortie vaut 0 : un rapport rouge ne vaut jamais « tout va bien », le
   `lint` et la construction du produit restent rouges.
5. `verified`, point de non-retour.

Rejouer un plan appliqué est sans effet (`replayed: true`) : le dernier
enregistrement porte déjà ce `plan_id`.

### 6. La reprise

Tout journal de mise à jour bloque toute autre commande, en nommant
`recover:application-update`, y compris la reprise d'une publication. La reprise
décide par l'état OBSERVÉ de chaque arbre et de chaque fichier : avant
`verified`, retour à l'état d'avant ; à `verified`, fin en avant. Un état ambigu
(arbre échangé ou fichier basculé retouché, candidat qui porte un fichier
étranger, arbre de travail sans journal, plusieurs journaux) est refusé, nommé,
sans rien déplacer.

## Conséquences

- Le parcours de l'auteur se ferme : `compile:backend-contract` (une fois ou
  plus, à la même sortie, ADR 0105), puis `update-app --dry-run`, puis
  `--expect-plan`. Revenir en arrière se fait par rejeu : remettre les sources
  d'avant, puis `update-app` ; les fichiers dérivés reviennent égaux à l'octet
  au rendu des anciennes sources par le générateur courant, et l'historique
  garde les deux enregistrements.
- Le renommage du préfixe lit le même ensemble d'écrivains dérivés : un fichier
  écrit par une mise à jour se renomme, et un fichier renommé se met à jour.

## Limites écrites

- Au témoin, la règle de frontières de Nx (`@nx/enforce-module-boundaries`) se
  tait : elle lit le graphe des projets EN CACHE et ne vise que les fichiers
  d'un projet, et l'interface témoin n'en est pas un. Les autres règles de
  l'interface (formes de Vite, entrée de la coque, règles de la pile) s'y
  appliquent ; les frontières des amorces sont vues sur l'appli réelle, au
  rapport, et par le `lint` bloquant de `create-app` sur les mêmes amorces. Les
  contrôles du socle (`lint`, `test`) sont bloquants mais tournent APRÈS
  l'échange, Nx ne voyant pas un candidat ; le retour reste exact. L'ESLint du
  témoin est éprouvé par les outils installés sur un produit fictif (amorces du
  générateur admises, amorce fautive refusée, dans les deux piles) ; la justesse
  native du témoin et des contrôles sur un produit installé est prouvée au
  commit 14.
- Un fichier POSSÉDÉ de l'interface n'est jamais retiré par la mise à jour
  (`UPDATE_INTERFACE_FILE_REMOVED <app> <chemin>`) : l'opération `files` n'écrit
  que des fichiers d'après.
- `UPDATE_APP_REJECTED` nomme le genre `design` de l'appli refusée : la
  validation dit la raison, qui peut venir d'un contrat qu'elle lit.
- Une publication d'une page retirée ne peut pas être retirée avant le lot 10
  (aucun outil ne retire une publication) : le refus est une limite, pas un état
  inatteignable ; sur le produit réel, les outils de la grammaire ne servent
  pas.
- Un produit d'une disposition antérieure au lot 2 (manifeste sans liaison) est
  refusé par l'intégrité (`app sources binding is invalid`) avant tout plan ;
  aucune migration n'est prévue, aucun produit extérieur n'existant encore.

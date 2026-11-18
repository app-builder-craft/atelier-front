# Guide du propriétaire — créer une application

Ce guide suit une application (le « produit ») de l'idée jusqu'à la page qui
fonctionne. La première partie décrit ce que tu vis pendant le parcours. La
seconde décrit les commandes que l'IA lance pour toi, pour que tu puisses les
lire, les vérifier et dépanner. Pour installer l'atelier lui-même, voir
[atelier.md](./atelier.md) ; pour piloter les agents, [agents.md](./agents.md).

Règle de lecture : après chaque commande, le guide dit ce qu'elle doit afficher.
Si ce n'est pas le cas, arrête-toi. Les textes entre `<` et `>` sont à
remplacer.

## 1. Le parcours, vu de ta place

Le produit vit dans **sa propre racine**, un dossier hors de l'atelier, avec son
propre dépôt GitHub. L'atelier ne reçoit jamais tes faits métier, tes contrats
ni ta conception.

Tu n'écris ni JSON, ni code, ni configuration. Tu réponds aux questions, tu
valides ou tu corriges. L'IA écrit les documents et lance les commandes ; les
commandes calculent un plan, le publient et vérifient le résultat.

### 1.1 Parler avec l'IA

Ouvre une conversation avec l'agent et demande-lui de lire
[LLM_APP_BUILDER.md](../../LLM_APP_BUILDER.md), puis de t'accompagner. Ce
fichier est sa méthode. Sa première réponse te pose trois questions : le
problème à résoudre, les utilisateurs principaux, le premier résultat concret
attendu.

L'IA pose ensuite une à trois questions à la fois. Elle n'invente jamais un
endpoint, un champ, une permission ni une règle métier : ce qu'elle ne sait pas
reste marqué comme inconnu. À la fin de chaque réponse, elle affiche un bloc
`SUIVI` (phase, page actuelle, ce qui est validé, la prochaine décision).

### 1.2 La fiche du projet

L'IA présente une fiche courte : problème, utilisateurs, application publique ou
interne, fonctionnalités du premier lot (MVP), contraintes, hors périmètre.
Chaque point porte un statut :

- `CONFIRMÉ` : tu l'as dit ou validé ;
- `DÉDUIT` : trouvé dans le dépôt ou conséquence d'une convention ;
- `INCONNU` : décision ou donnée qui manque.

Corrige ou valide. Après ta validation, l'IA l'enregistre dans
`<racine du produit>/descriptions/project-brief.md`.

### 1.3 La carte des pages

L'IA propose la plus petite carte de pages qui livre le MVP : pour chaque page,
son objectif, ses utilisateurs, son action principale, sa priorité, et comment
on y entre. Elle vérifie aussi les cas transversaux : page introuvable, accès
interdit, session expirée, erreur, absence de données, chargement, mobile.
Valide la carte et l'ordre de construction ; elle est enregistrée dans
`descriptions/page-map.md`.

### 1.4 Le contrat de page, que tu valides

On construit **une page à la fois**. Pour la page en cours, l'IA décrit son
objectif, son contenu, ses états (chargement, succès, vide, erreurs, accès
interdit), ses actions et les contrats techniques dont elle dépend. Elle termine
par : « Valides-tu ce contrat de page avant son implémentation ? »

- Réponds clairement oui ou non. Une réponse ambiguë n'est pas une validation.
- Si le backend n'existe pas encore, l'IA te propose d'attendre le contrat, de
  définir un contrat à faire valider par l'équipe backend, ou d'utiliser un
  bouchon clairement isolé. C'est ta décision.
- Valider une page n'autorise pas les suivantes.

### 1.5 La génération

L'IA traduit le contrat validé en documents, puis lance les commandes du § 3 :
préparation de la racine, contrats backend, conception, coque de l'application,
lectures et actions, plan et composition de la page. Chaque commande montre
d'abord un plan (`--dry-run`), puis publie exactement ce plan.

### 1.6 La réalisation de la page

L'atelier publie un **bon de travail** pour la page : les fichiers permis, les
contrats, les identifiants à respecter. L'IA de réalisation écrit l'interface
dans ce cadre, dans un brouillon hors de l'application. Elle est libre de la
présentation, jamais des règles métier.

### 1.7 La vérification

`verify:page-realization` contrôle le brouillon, puis le publie à la place de la
page d'attente. Compilation, build de production, lint et tests du produit
doivent passer. Ensuite, regarde la page dans ton navigateur. L'IA présente un
bloc `PAGE TERMINÉE` et te demande : corriger, ajouter un cas, valider et passer
à la page suivante, ou arrêter.

### 1.8 Le déploiement

L'atelier ne déploie pas. La coque contient sa configuration de serveur (relais
nginx de même origine, politique de sécurité de contenu), mais les contrôles de
production ne sont pas encore qualifiés par l'atelier. Le déploiement se décide
et se fait depuis le dépôt du produit. Aucun agent ne déploie, ne publie ni
n'appelle un backend réel sans ton autorisation explicite.

## 2. Le réflexe `--explain` (et `--help`)

Avant une première utilisation, ou après une évolution de l'atelier, demande à
la commande ce qu'elle fait :

```sh
bun run prepare:application-workspace --explain
bun run create-app --explain
bun run add-library --explain
```

La sortie JSON indique les fichiers que la commande possède, ses phases, ses
contrôles, ses fichiers temporaires et sa reprise (rubrique `transaction`). Elle
n'écrit rien et ne demande aucun autre argument : `--explain` s'utilise seul.

Les autres commandes de la chaîne n'ont pas `--explain`, mais affichent leur
mode d'emploi avec `--help` : `generate:list-query`, `generate:action-request`,
`compile:page-execution-plan`, `generate:page-composition`,
`prepare:page-realization`, `verify:page-realization`.
`compile:backend-contract` et `compile:application-design` n'ont ni l'un ni
l'autre : leurs options sont décrites ci-dessous.

Pour lire un échec : repère la dernière phase affichée, ne regarde que les
fichiers que la commande possède, puis suis sa rubrique `transaction`.

## 3. Les commandes, dans l'ordre

Toutes se lancent depuis l'atelier (`~/atelier-front`) et visent le produit par
`--target-root`, un chemin **absolu**, réel (sans lien symbolique), hors de
l'atelier. Les autres chemins sont relatifs à la racine du produit (par
convention sous `descriptions/`).

**Principe commun.** Chaque commande se lance deux fois :

1. avec `--dry-run` : elle affiche un plan en JSON, avec un champ `plan_id` (64
   caractères hexadécimaux), et n'écrit rien ;
2. après relecture, avec `--apply <plan_id>` (`--expect-plan <plan_id>` pour
   `create-app`) : elle publie exactement ce plan, ou refuse si quelque chose a
   changé depuis.

Une option inconnue, répétée ou manquante est refusée. Aucune option ne force
une publication.

### 3.1 Préparer la racine : `prepare:application-workspace`

```sh
bun run prepare:application-workspace --target-root <racine absolue> --profiles angular-pwa --github-repository <propriétaire>/<dépôt> --review-owner <identifiant GitHub du relecteur> --dry-run
bun run prepare:application-workspace --target-root <racine absolue> --profiles angular-pwa --github-repository <propriétaire>/<dépôt> --review-owner <identifiant GitHub du relecteur> --apply <plan_id>
```

- `--profiles` : `angular-pwa`, `react-spa`, ou les deux séparés par une virgule
  (`angular-pwa,react-spa`).
- Le dossier parent de la racine doit exister. La racine ne doit être ni dans
  l'atelier, ni dans un dépôt Git. L'outil ne crée ni Git ni dépôt distant : le
  `git init` du produit se fait après.
- Le second appel doit afficher un JSON avec `"status": "prepared"`. Cela ne
  veut dire ni installé ni compilé.
- L'installation se fait ensuite dans la racine du produit, avant `create-app` :
  `bun install --frozen-lockfile --ignore-scripts`. `create-app` compile et
  teste avec les outils installés dans le produit.

### 3.2 Compiler le contrat backend : `compile:backend-contract`

Choisir exactement un adaptateur selon la source fournie :

```sh
bun run compile:backend-contract --target-root <racine absolue> --adapter structured --definition descriptions/<source>.json --out descriptions/<contrat>.json --dry-run
bun run compile:backend-contract --target-root <racine absolue> --adapter openapi --definition descriptions/<openapi>.json --out descriptions/<contrat>.json --dry-run
bun run compile:backend-contract --target-root <racine absolue> --adapter postman --definition descriptions/<collection>.json --out descriptions/<contrat-reference>.json --dry-run
```

Puis la même ligne avec `--apply <plan_id>` à la place de `--dry-run`. Elle doit
afficher `Publié : <sortie> (sha256 …)` (ou `Déjà publié : …` si rien n'a
changé).

Une collection Postman donne toujours un contrat `reference` : il inspire, il ne
pilote jamais une page. Les options avancées (`--adopt-reference`, l'adaptateur
`runtime-observation`) sont décrites dans le
[protocole extérieur](../etape-b/external-application-creation.md).

### 3.3 Compiler la conception : `compile:application-design`

```sh
bun run compile:application-design --target-root <racine absolue> --source descriptions/<conception-source>.json --out descriptions/<conception>.json --dry-run
bun run compile:application-design --target-root <racine absolue> --source descriptions/<conception-source>.json --out descriptions/<conception>.json --apply <plan_id>
```

La source peut être en JSON ou en YAML. Le second appel doit afficher
`Publiée : <sortie> (sha256 …)`. Une conception `approved` est refusée s'il
reste une inconnue, une page inaccessible, ou un champ ou endpoint absent du
contrat cible.

### 3.4 Créer la coque : `create-app`

```sh
bun run create-app --explain
bun run create-app --target-root <racine absolue> --design descriptions/<conception>.json --experience <experience> --app <nom-app> --profile angular-pwa --dry-run
bun run create-app --target-root <racine absolue> --design descriptions/<conception>.json --experience <experience> --app <nom-app> --profile angular-pwa --expect-plan <plan_id>
```

- `--profile` : `angular-pwa` (par défaut) ou `react-spa`.
- `create-app` n'a pas d'option `--apply` : c'est `--expect-plan`.
- Le second appel doit afficher un JSON avec `"status": "created"` et
  `"phase": "finalized"`. La coque a été compilée, construite, lintée sans
  avertissement et testée avec les outils du produit.
- La coque porte la session, le relais nginx et la politique de sécurité. Elle
  ne contient aucune règle métier.

### 3.5 Ajouter une bibliothèque : `add-library`

```sh
bun run add-library --explain
bun run add-library --app <nom-app> --library <bibliothèque> --dry-run
bun run add-library --app <nom-app> --library <bibliothèque> --expect-plan <library-plan:…>
```

`add-library` applique une bibliothèque déjà qualifiée (piste `verified`) à une
application **de l'atelier** (dossier `apps/` de l'atelier). Il n'a pas d'option
`--target-root` : aujourd'hui, il sert aux bancs de qualification
([atelier.md](./atelier.md), § 5.3), pas aux produits extérieurs.

- Il exige un dépôt entièrement propre et une branche attachée.
- Il ne modifie que `apps/<nom-app>/`, dans un seul commit qu'il crée lui-même
  (identité Git locale requise).
- Un refus à la phase `qualified-track` veut dire que la qualification est
  absente ou périmée : requalifier, ne pas forcer.

### 3.6 Lectures et actions : `generate:list-query`, `generate:action-request`

```sh
bun run generate:list-query --target-root <racine absolue> --app <nom-app> --definition descriptions/<lecture>.json --dry-run
bun run generate:list-query --target-root <racine absolue> --app <nom-app> --definition descriptions/<lecture>.json --apply <plan_id>
bun run generate:action-request --target-root <racine absolue> --app <nom-app> --definition descriptions/<action>.json --dry-run
bun run generate:action-request --target-root <racine absolue> --app <nom-app> --definition descriptions/<action>.json --apply <plan_id>
```

Une lecture affiche des données ; une action envoie un formulaire ou déclenche
une opération. Ces deux commandes visent une application Angular avec session.
Le second appel doit afficher un JSON avec `"status": "published"` (ou
`"already-published"`).

Si une page utilise déjà cette lecture ou cette action, un avertissement
`⚠ Pages qui consomment …` nomme les commandes à relancer pour elle : suis-le.

### 3.7 Plan et composition d'une page : `compile:page-execution-plan`, `generate:page-composition`

```sh
bun run compile:page-execution-plan --target-root <racine absolue> --app <nom-app> --page <page_id> --dry-run
bun run compile:page-execution-plan --target-root <racine absolue> --app <nom-app> --page <page_id> --apply <plan_id>
bun run generate:page-composition --target-root <racine absolue> --app <nom-app> --page <page_id> --dry-run
bun run generate:page-composition --target-root <racine absolue> --app <nom-app> --page <page_id> --apply <plan_id>
```

Toujours dans cet ordre : le plan d'exécution, puis la composition. Une page
peut combiner plusieurs lectures et actions indépendantes ; un enchaînement
ordonné entre elles n'est pas pris en charge.

### 3.8 Réaliser et vérifier la page : `prepare:page-realization`, `verify:page-realization`

```sh
bun run prepare:page-realization --target-root <racine absolue> --app <nom-app> --page <page_id> --dry-run
bun run prepare:page-realization --target-root <racine absolue> --app <nom-app> --page <page_id> --apply <plan_id>
```

Le second appel publie le bon de travail (`work_order_path` dans le JSON). L'IA
de réalisation écrit alors la page dans
`descriptions/page-realizations/<nom-app>/<page_id>/`.

```sh
bun run verify:page-realization --target-root <racine absolue> --app <nom-app> --page <page_id> --dry-run
bun run verify:page-realization --target-root <racine absolue> --app <nom-app> --page <page_id> --apply <plan_id>
```

- `--dry-run` contrôle le brouillon. Il doit afficher un JSON avec `"ok": true`
  et un `plan_id`. En cas de refus, il affiche `"ok": false` et la liste
  `violations` : l'IA corrige seulement cette page et relance.
- `--apply <plan_id>` publie la page à la place de la page d'attente.

## 4. Reprendre après un échec

**Règle d'or : ne jamais supprimer un journal, un verrou ou un dossier de
travail à la main.** L'un d'eux peut contenir le seul exemplaire de ton
application relue.

- Un échec **avant publication** laisse le produit inchangé : corrige la cause
  et relance la même commande.
- Les commandes du produit n'ont **ni `--resume` ni `--abort`** : la reprise est
  automatique et fondée sur les empreintes. Relancer la même commande avec le
  même plan revérifie et complète le travail interrompu ; un verrou laissé par
  un processus mort est repris. (`--explain` le confirme :
  `"resume_command": null`.)
- `create-app` interrompu après sa publication : relance le même
  `create-app … --expect-plan <plan_id>` ; il termine les contrôles.
- Une publication interrompue dans une application existante bloque toutes les
  autres commandes avec
  `interrupted publication pending for app <app>; recover it first`. Lance la
  reprise, sans plan :

    ```sh
    bun run recover:application-publication --target-root <racine absolue> --app <nom-app>
    ```

    Elle doit afficher `"status": "recovered"` ou
    `"status": "nothing-to-recover"`. Si elle répond
    `ambiguous interrupted publication`, rien n'a été déplacé : elle nomme le
    premier écart (`Écart : "…" (…).`). Fais retirer ou rétablir ce fichier par
    l'IA, puis relance la reprise, tant qu'un écart est nommé. Le détail est
    dans la section « Ownership et reprise » du
    [protocole extérieur](../etape-b/external-application-creation.md).

- `add-library` : avant sa publication, le dépôt est inchangé ; après, son
  commit est complet. Il n'existe pas d'état à moitié publié.

Les dossiers et fichiers de travail à ne jamais toucher :
`apps/.<app>.external-candidate-<plan_id>/`,
`apps/.<app>.publication-candidate-<plan_id>/`,
`apps/.<app>.previous-candidate-<plan_id>/`, `apps/.<app>.generation-lock/`, les
dossiers `.<…>.generation-transaction-…`, et dans `.git/` : `cmz-library.lock`,
`cmz-library-transaction.json`, `cmz-library-promotion.lock`.

Seule exception à la règle « ni `--resume` ni `--abort` » : `retire-app`, qui
retire une application **de l'atelier** (pas d'un produit).

## 5. Dépannage

Les messages sont copiés du code ; `…` remplace une partie variable.

| Message affiché                                                                                                                                                                                                                                           | Cause                                                                                                         | Que faire                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `❌ --target-root est requis : seul le mode produit extérieur existe.`                                                                                                                                                                                    | Commande de génération lancée sans `--target-root`                                                            | Ajouter `--target-root <racine absolue>`                                                                                               |
| `Choisir exactement --dry-run ou --apply <plan_id>.`, `Utiliser exactement --dry-run ou --apply <plan_id>.`, `… requires --dry-run or --apply <plan_id>`                                                                                                  | Ni `--dry-run` ni `--apply`, ou les deux                                                                      | Lancer d'abord `--dry-run`, puis `--apply <plan_id>`                                                                                   |
| `Le mode extérieur exige --dry-run ou --expect-plan <plan_id>.`                                                                                                                                                                                           | `create-app --target-root` sans plan                                                                          | Lancer `--dry-run`, puis `--expect-plan <plan_id>`                                                                                     |
| `--apply a été retiré : la création est directe. Utiliser --expect-plan <plan_id> pour vérifier un plan revu.`                                                                                                                                            | `--apply` donné à `create-app`                                                                                | Remplacer par `--expect-plan <plan_id>`                                                                                                |
| `--apply exige un plan_id SHA-256 valide.` ou `--expect-plan exige un plan_id SHA-256 valide.`                                                                                                                                                            | `plan_id` mal copié                                                                                           | Copier les 64 caractères du champ `plan_id`, sans guillemets                                                                           |
| `Argument inconnu : …`, `Argument inconnu ou option interdite.` ou `argument not allowed with --target-root: …`                                                                                                                                           | Option qui n'existe pas pour cette commande                                                                   | Vérifier avec `--explain` ou `--help` (§ 2) ; ne pas reprendre l'option d'une autre commande                                           |
| `reviewed workspace plan required or stale`, `reviewed plan id is stale or invalid`, `reviewed shell plan is stale` ou `reviewed publication plan is stale`                                                                                               | Le plan est périmé : une entrée, un outil ou le verrou a changé depuis le `--dry-run`                         | Refaire le `--dry-run`, relire, publier le nouveau `plan_id`                                                                           |
| `plan attendu library-plan:…, obtenu library-plan:…`                                                                                                                                                                                                      | Plan `add-library` périmé (un commit depuis le `--dry-run`)                                                   | Refaire le `--dry-run`                                                                                                                 |
| `Une autre commande tient le verrou de cette application ; relancer quand elle est terminée.`                                                                                                                                                             | Une autre commande travaille sur la même application                                                          | Attendre sa fin, puis relancer                                                                                                         |
| `interrupted publication pending for app …; recover it first`                                                                                                                                                                                             | Une publication a été interrompue                                                                             | `recover:application-publication` (§ 4)                                                                                                |
| `ambiguous interrupted publication` suivi de `Écart : "…" (…).`                                                                                                                                                                                           | Un fichier a été ajouté ou modifié dans l'application pendant la publication                                  | Faire retirer ou rétablir le fichier nommé, puis relancer la reprise (§ 4)                                                             |
| `publication rollback refused; inspect the owned tree locally`                                                                                                                                                                                            | L'arbre de l'application a changé pendant les contrôles                                                       | Ne rien supprimer ; lancer la reprise, puis suivre l'écart nommé                                                                       |
| `Préparation refusée ; inspecter les entrées localement.`, `Création extérieure refusée ; inspecter les entrées localement.`, `Génération extérieure refusée ; inspecter les entrées localement.` ou `Reprise refusée ; inspecter le produit localement.` | Refus volontairement peu bavard (aucun chemin ni détail n'est affiché)                                        | Ne pas relancer avec d'autres options. Faire diagnostiquer par un agent (`task-specialist`, mode `diagnose`) avec la commande exacte   |
| `"ok": false` et une liste `violations` (vérification de page)                                                                                                                                                                                            | Le brouillon de la page sort de son bon de travail                                                            | L'IA corrige seulement cette page, puis relance `verify:page-realization --dry-run`                                                    |
| `input collides with reserved workspace namespace`                                                                                                                                                                                                        | Une entrée porte un nom réservé (`package.json`, `README.md`, `apps/…`, `.cmz/…`…)                            | Ranger les entrées sous `descriptions/`                                                                                                |
| `canonical absolute target-root required`, `non-canonical physical path`, `existing target parent required`, `target overlaps the active workshop` ou `target nested in an existing Git repository`                                                       | La racine n'est pas un chemin absolu réel, son parent manque, ou elle est dans l'atelier ou dans un dépôt Git | Choisir un chemin absolu, sans lien symbolique, hors de l'atelier et de tout dépôt Git ; créer le dossier parent (`mkdir -p <parent>`) |
| `explicit unique profiles required` ou `GitHub repository and review owner required`                                                                                                                                                                      | `--profiles`, `--github-repository` ou `--review-owner` absent ou mal écrit                                   | `--profiles angular-pwa` (ou `react-spa`), `--github-repository <propriétaire>/<dépôt>`, `--review-owner <identifiant>`                |
| `dépôt entièrement propre requis`, `… piste verified compatible`, `… a changé depuis la qualification`                                                                                                                                                    | Préconditions d'`add-library`                                                                                 | Voir le dépannage de [atelier.md](./atelier.md), § 8                                                                                   |

## 6. Exemples

- Un produit fictif complet côté documents (fiche de projet, source de
  conception, contrats backend de référence et cible, réalisation de page) :
  [examples/application-conception-proof/](../../examples/application-conception-proof/).
- Un catalogue d'exemples de mise en page approuvés, qui guident la composition
  d'une interface sans valoir preuve ni autorité métier :
  [examples/presentation/](../../examples/presentation/README.md).

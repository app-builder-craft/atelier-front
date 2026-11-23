# ADR 0104 — Retrait de la grammaire héritée

- Statut : acceptée (2026-11-23).
- Portée : atelier 2, socle des produits extérieurs et outils de l'atelier.
- Décisions du propriétaire appliquées : point 1.7 et point 12.3 des décisions
  de l'atelier 2 (la grammaire fermée et le bon de travail sont abandonnés) ;
  réponses du 2026-11-23 aux questions du lot 10, mot pour mot « L10-1 A on y
  reviendra plustard pour un controle, L10-2 B ».

## Contexte

L'atelier 1 imposait la FORME de chaque page : un bon de travail
(`prepare:page-realization`) remettait à l'IA les fichiers, les imports et une
grammaire fermée (31 codes de refus) ; `verify:page-realization` jugeait le
brouillon par cette grammaire et ses couches de renfort, puis le publiait comme
fichier possédé de la coque. Des preuves de réalisation (X4, X4-sécurité), des
témoins de soumission (N4) et une chaîne « rôle → archétype » n'existaient que
pour cette chaîne.

L'atelier 2 laisse l'interface libre : une page est refusée si elle n'utilise
pas les éléments offerts (contrat, lectures et commandes générées, session,
charte, bibliothèques qualifiées) ou si elle échoue à un contrôle bloquant ;
seules les règles officielles bloquent.

## Décision

1. **Retrait.** Le bon de travail, la grammaire fermée, la vérification et la
   publication de réalisation (l'outil `page-realization` quitte la liste
   fermée des publieurs ; un enregistrement qui le porte est refusé), les
   preuves de réalisation X4 et X4-sécurité de la page, les témoins N4, la
   chaîne rôle → archétype (`conventions/archetypes/**`, schémas, sélection)
   et la dépendance `css-tree` qu'elle seule importait. La liste des 66
   fichiers retirés est DÉRIVÉE du code (fermeture d'imports, chaînes, exports
   orphelins), redérivée sur l'arbre recâblé avant le retrait.
2. **`check:target-archetype-coverage` est retiré sans remplaçant** : il ne
   vérifiait que la chaîne rôle → archétype, dont le seul consommateur était le
   bon de travail.
3. **Ce qui reste au socle** : plan d'exécution et composition par page,
   contrat de page `.atelier/pages/<page>.json` (son genre
   `page-realization-contract` garde son nom), client, session, propriété et
   sceaux, publication sous plan, confinement des commandes du produit,
   politique de sécurité de contenu et relais. La table des noms de prototype
   passe dans `core/prototype-names.mjs` ; le texte d'absence OBLIGATOIRE
   (`PAGE_ABSENT_TEXT_MISSING`) quitte le bon de travail pour la compilation
   du plan. Restent aussi, sans lien avec la chaîne retirée : l'entrée
   `idAttribute` de la signature de l'atelier (source de qualification des
   bibliothèques, retirée au prochain lot qui requalifie), et les exécuteurs
   génériques `page-realization-*` des bancs. Le « work order » du modèle
   d'organisation des agents est un homonyme : il délimite une étape de
   développement, pas une page.
4. **Soumission native (L10-2 = B).** La politique scellée des coques Angular
   porte `form-action 'none'` : toute soumission native d'un formulaire est
   bloquée par le navigateur, même vers l'application ; `<form method="dialog">`
   reste permis. La politique React naîtra avec la même directive. Les témoins
   N4 sont retirés. Preuve : `check:nginx-relay-browser` soumet un formulaire de
   même origine sur la coque servie par nginx ; chaque politique livrée qui
   porte la directive (en-tête et `meta`) rapporte sa violation, et le document
   ne change pas. La directive tient tant qu'UNE des deux sources la porte ; la
   vérification 10 garde l'égalité exacte des deux sources au texte rendu ; la
   sonde prouve le comportement quand les deux sont affaiblies (trois
   contre-mutations : en-tête, `meta`, les deux).
5. **Corpus.** Les 204 sondes du validateur de l'atelier 1 et 38 contre-sondes
   sont gardées comme DONNÉES
   (`tools/generator-platform/test-support/page-probes*.mjs`), avec leur
   tableau de décisions (`page-probe-classes.mjs`) et un test d'intégrité. Leur
   jugement contre les règles de l'interface est la preuve de sortie du lot 5.

## Limites acceptées (L10-1 = A)

Ce que plus aucune machine ne refuse, accepté par le propriétaire ; un contrôle
pour ces deux cas sera revu plus tard (« on y reviendra plus tard pour un
contrôle »). Section rendue depuis le tableau de décisions du corpus :

<!-- limites : début (rendu de LIMITS et de la classe « limite » de tools/generator-platform/test-support/page-probe-classes.mjs, vérifié par tools/generator-platform/page-probes.test.mjs) -->
- **E6** : des caractères bidirectionnels invisibles dans le code (U+202E, U+2066…) et le trait d’union conditionnel (U+00AD) : aucune règle officielle installée ne les refuse ; no-irregular-whitespace ne refuse que U+2028 et U+200B (mesuré au verrou).
- **E7** : une faute maquillée (nom calculé, alias, détour par event.view, style injecté par un nom construit) dans du code qu’aucun test n’exécute : la règle officielle ne voit que la forme écrite. Bornée par les tests de l’IA qui échouent sur une requête hors socle (lots 6 et 7), la couverture d’au moins 80 % par page (§27 bis, Q7 = B), la politique de sécurité de contenu et la relecture. Sondes de l’atelier 1 de cette limite (17) : `T-sendBeacon-concat`, `T-cookie-indirect`, `N-ts-descriptor-defaultView`, `N-ts-table-proto-pollution`, `N-ts-table-proto-litteral-objet`, `N-ts-injector-get-parametre`, `N-ts-injector-get-tableau`, `N-ts-injector-records-document`, `R2-ts-destructure-cookie`, `R2-ts-vue-sans-evenement-viewChild`, `L-ts-propriete-top`, `L-ts-propriete-nativeElement`, `L-ts-propriete-setAttribute`, `L-ts-propriete-postMessage`, `L-ts-propriete-fetch`, `L-ts-propriete-parent`, `L-ts-propriete-createElement`.
<!-- limites : fin -->

## Intervalle et transferts

Ce retrait passe AVANT la suite de la séparation socle / interface (lot 2, à
partir de son commit 1b), les règles de l'interface (lot 5), le test
indépendant par page (lot 6) et les tests de l'IA (lot 7). Dans cet
intervalle :

- aucun contrôle automatique ne juge la FORME d'une page, et aucune page de
  l'IA n'existe ;
- la mesure du comportement de la politique de sécurité de contenu se réduit à
  `check:nginx-relay-browser` et à sa sonde `form-action` (la page piège et ses
  13 sondes partent avec X4) jusqu'au test indépendant par page ;
- la preuve de la politique et le confinement des commandes du produit
  restent.

Transferts : le jugement du corpus passe aux règles de l'interface (lot 5) ; les
classes « exécution » aux pages fautives du test indépendant (lot 6) ;
`form-action 'none'` de la politique React à sa naissance (lot 2, commit 13) ;
la règle du texte d'absence suit la déclaration du texte si elle quitte la
conception (lot 4).

**Confinement de bout en bout (E8-a).** La preuve qu'une spec écrite hors du
générateur, lancée par une commande de l'atelier, tourne confinée arrive avec
la première cible `test` de l'interface (lot 7). D'ici là, rien n'est à confiner de
bout en bout, parce que :

1. l'unique chemin des commandes du produit extérieur est
   `runExternalApplicationCommand` (`core/application-workspace.mjs`), qui
   passe par `runConfinedProductCommand` ; ses appelants hors tests sont la
   publication (`core/application-publication.mjs`), l'espace
   (`core/application-workspace.mjs`) et le renommage du préfixe
   (`core/product-prefix-rename-transaction.mjs`) ; le chemin non confiné
   `runApplicationShellCommand` (`core/application-shell-publication.mjs`) ne
   sert qu'aux applications internes de l'atelier ;
2. tout fichier exécuté par ces commandes avant la cible `test` de l'interface
   (`project.json`, `eslint.config.mjs`, `vite.config.mts`, `tsconfig*`) est
   possédé et exact ; la construction compile sans exécuter le code libre ;
3. le test du mécanisme (`external-product-confinement.test.mjs`) reste en CI
   (`test:external-application-shells`).

Condition : tant que l'interface n'a pas de cible `test`, aucun lot ne rend
dans la zone libre un fichier de configuration exécuté par la construction
(par exemple `postcss.config` ou `tailwind.config`).

## Conséquences

- Les commandes `prepare:page-realization`, `verify:page-realization`,
  `check:page-submit-witnesses` et `check:target-archetype-coverage`
  n'existent plus.
- Une conception dont une lecture a un champ nullable ou facultatif sans texte
  d'absence est refusée dès `compile:page-execution-plan`.
- Un produit déjà créé ne reçoit `form-action 'none'` qu'en recréant son
  application (la coque ne se republie pas).

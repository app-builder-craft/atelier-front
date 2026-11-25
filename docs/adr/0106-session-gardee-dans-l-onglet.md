# ADR 0106 — Session gardée dans l'onglet

- Statut : acceptée (2026-11-25).
- Portée : atelier 2, session générée du socle des produits extérieurs, pile
  Angular (lot 2, commit 4) ; la pile React la reçoit à sa naissance (commit 12)
  ; les mesures dans trois navigateurs la complètent au commit 14.
- Décisions du propriétaire appliquées : session au rafraîchissement, réponse «
  B » du 2026-11-20 (« gardée dans l'onglet ; F5 garde l'utilisateur connecté,
  sur la même page ; fermer l'onglet déconnecte ; jamais partagée entre onglets
  ; effacée à la déconnexion et à son expiration ; la valeur `memory` est
  remplacée ; une ADR suit ») ; lectures du pilote L1, L2, L3 et « effacée dès
  que l'expiration est constatée », inscrites le 2026-11-20.

## Contexte

Jusqu'au lot 2, la session vivait en mémoire seulement : un rafraîchissement
renvoyait à la connexion. Le propriétaire a choisi de la garder dans l'onglet.
Le socle est seul à toucher le stockage du navigateur ; l'interface, code libre
de l'IA, n'y a jamais accès (décision « aucun stockage du navigateur dans
l'interface », règles du lot 5). La politique de sécurité du contenu stricte,
avec Trusted Types, reste la défense principale contre un script injecté.

## Décision

### 1. La valeur du schéma

`experiences[].session.storage` vaut `tab`, et seulement `tab` : `memory` est
refusée par le schéma et par la résolution de la session, et la capacité de page
`session.tab@1` remplace `session.memory@1` des deux côtés (exigence du plan de
page, offre de la composition). Aucun produit extérieur n'existait : aucune
migration.

### 2. La clé, rendue par la coque

`<préfixe>-session-v1:<appli>`. C'est un nom que le produit expose dans le
navigateur, donc une forme du préfixe : elle est rendue dans la COQUE seule
(`app.config.ts`, fournisseur du jeton `SESSION_STORAGE_KEY`, que l'entrée
`@socle-coque/<appli>` exporte), et le renommage de préfixe la reconnaît par sa
famille « clé de session de l'onglet ». Le socle n'en porte aucune forme. Sans
fournisseur, la session vit en mémoire pour ce document.

### 3. Ce qui est gardé : la projection exacte, jamais la réponse

Un objet JSON aux clés exactes `v` (1), `app`, `token`, `menu` (valeur lue au
pointeur du menu), `paths`, `permissions`, `stages` (pour chaque étape de la
configuration, le RÉSULTAT de son prédicat, jamais la valeur lue),
`acknowledged` (étapes franchies, triées) et `config` (empreinte sha256 de la
configuration de session rendue). L'état en mémoire est exactement cette
projection. On n'y met jamais : la réponse entière du producteur, le sujet, ce
que l'utilisateur a saisi, les données des pages, l'époque, un texte ou la
langue ; et jamais ailleurs que le stockage de session de l'onglet
(`localStorage`, IndexedDB, cookie, Cache Storage et URL exclus).

### 4. Le cycle

- **Au démarrage**, dans le constructeur du service de session, donc avant la
  première décision de route : stockage indisponible → mémoire, sans erreur ;
  ouvreur présent (`window.opener !== null`) → la copie est EFFACÉE, jamais
  reprise ; clé absente → non connecté ; clé présente → contrôles dans cet
  ordre, et tout échec efface la clé : longueur au plus `TAB_SESSION_MAX_CHARS`
  (2 621 440 unités UTF-16, les 5 Mio que les navigateurs accordent au stockage
  de session d'une origine, selon MDN) AVANT toute analyse, analyse JSON et
  copie bornée, clés exactes, version, appli, empreinte de la configuration
  COURANTE, jeton (la règle de l'ouverture), chemins et permissions, menu
  accepté par la règle de l'ouverture, étapes exactement celles de la
  configuration courante. Les clés de la même famille pour cette appli, sous un
  autre préfixe (restes d'un renommage), sont effacées.
- **À l'ouverture de session et à chaque étape franchie** : la projection est
  écrite ; trop longue ou refusée par le navigateur (quota), la clé est effacée
  et la session reste en mémoire pour ce document (un rafraîchissement
  déconnecte).
- **À la déconnexion, au 401 et à l'effet `clear-and-reconnect`** : la clé est
  effacée, puis l'état.
- **À l'expiration** : constatée par le serveur (premier 401 d'une opération
  protégée), comme avant ; aucune horloge côté client. Après un rafraîchissement
  avec un jeton expiré, une page sans requête protégée reste affichée jusqu'à la
  première requête protégée.
- **Fermer l'onglet** : le navigateur efface le stockage de session.

### 5. Contrôles

- Test de texte sur tous les fichiers rendus de la coque et du socle, dans les
  deux modes : `sessionStorage` n'apparaît que dans le magasin de session, par
  le jeton de clé ; `localStorage` nulle part au lot 2 (le lot 3 l'ouvre à sa
  seule clé de préférence) ; ni IndexedDB, ni `document.cookie`, ni
  `cookieStore`, ni `window.open`, ni `rel` portant `opener`, ni
  `<base target>`, ni écriture de `window.opener` ; la seule lecture de
  l'ouvreur est dans le magasin.
- Unitaires des fonctions PURES de la projection (ouverture, reprise, clés
  périmées), une règle de la reprise par cas ; banc Angular de la pile.
- Comportement dans le navigateur, trois moteurs, derrière le relais :
  commit 14.

## Conséquences

- Un script injecté dans l'origine peut LIRE le jeton tant que l'onglet vit ; en
  mémoire seule, il pouvait déjà s'en SERVIR, par le service de session et
  l'intercepteur. La politique stricte avec Trusted Types reste la défense
  principale ; le relais émet déjà `Cross-Origin-Opener-Policy: same-origin`.
  Risque accepté par le propriétaire (« B »).
- Limites natives, lectures du pilote : L1, un onglet dupliqué par l'utilisateur
  ; L2, un onglet fermé puis rouvert, ou une session du navigateur restaurée ;
  L3, un onglet de l'appli ouvert PAR une page d'une autre origine depuis un
  onglet où l'utilisateur s'était connecté (copie du stockage de session,
  ouvreur nul), mesurée au commit 14. Leur seule borne est l'expiration du jeton
  chez le serveur : au lot 2, la déconnexion est locale et n'invalide pas le
  jeton.
- `token`, `menu`, `paths`, `permissions`, `stages` et `acknowledged` sont
  modifiables à la main dans l'onglet : les chemins, les permissions et les
  étapes ne sont que des gardes d'AFFICHAGE. Des étapes falsifiées mais bien
  formées sont admises ; le serveur reste l'autorité, et doit refuser une
  opération tant qu'une étape obligatoire n'est pas franchie chez lui : les
  étapes ne sont pas protégées par le client.
- Une origine par appli : le relais est rendu par appli.
- Toute régénération qui change la configuration de session (étapes, pointeurs,
  opérations protégées, protocole) change son empreinte : les sessions d'onglet
  sont effacées au premier chargement qui suit le déploiement.
- Stockage bloqué par l'utilisateur : la session vit en mémoire.

## Écartés

- `localStorage` : partagé entre onglets et persistant, contraire à la décision.
- Un cookie posé par le script : non HttpOnly, et envoyé seul au serveur.
- IndexedDB : asynchrone (pas de reprise avant la garde de route) et partagé
  entre onglets.
- Un verrou par onglet (Web Locks) : il ne ferme ni L2 ni, quand l'onglet
  ouvreur a quitté l'appli, L3 ; non construit sans mesure dans trois moteurs.
- Reprendre seulement sur un rechargement : il déconnecterait à toute navigation
  du même onglet (changement de langue compris).

## Plus tard

Un cookie HttpOnly posé par le serveur reste possible, client par client ; il
ferait passer `storage` à une autre valeur, sans changer l'interface.

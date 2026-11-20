# Guide du propriétaire — l'atelier

Ce guide explique comment installer, faire tourner et entretenir l'atelier. Il
s'adresse au propriétaire, pas aux agents. Les deux autres guides sont
[produit.md](./produit.md) (créer une application) et [agents.md](./agents.md)
(piloter les agents).

Règle de lecture : chaque commande est suivie de ce qu'elle doit afficher. Si tu
ne vois pas ce résultat, arrête-toi et ne passe pas à l'étape suivante. Les
textes entre `<` et `>` sont à remplacer par ta valeur.

## 1. L'atelier en bref

L'atelier est un dépôt Nx, avec Bun et Angular. Il sert à générer des
applications extérieures : Angular de la coque aux pages, React pour la coque
seulement. Chaque application vit dans sa propre racine, hors de l'atelier.
L'atelier ne contient aucune donnée d'application : ses tests utilisent
seulement des exemples fictifs. La charte qui fixe tout cela est
[PROJECT_AUTHORITY.md](../../PROJECT_AUTHORITY.md).

## 2. Préparer le poste de travail

Deux systèmes fonctionnent : **Windows avec WSL2 (Ubuntu)** et **macOS**.
Windows natif (PowerShell, Git Bash) ne fonctionne pas : voir § 2.10.

### 2.1 Windows : installer Ubuntu dans WSL2

1. Ouvre PowerShell en administrateur, puis lance :

    ```powershell
    wsl --install -d Ubuntu
    ```

    Redémarre si Windows le demande. Au premier lancement, Ubuntu demande un nom
    d'utilisateur et un mot de passe Linux : note-les.

2. Vérifie, dans PowerShell :

    ```powershell
    wsl -l -v
    ```

    Doit afficher une ligne `Ubuntu` avec `2` dans la colonne `VERSION`.

3. Dans Windows Terminal, fais d'Ubuntu le profil par défaut : Paramètres →
   Démarrage → Profil par défaut → Ubuntu → Enregistrer. Chaque nouvel onglet
   s'ouvre alors dans Ubuntu.

À partir d'ici, **toutes les commandes se tapent dans le terminal Ubuntu**, sauf
mention contraire.

### 2.2 Les outils de base d'Ubuntu

```sh
sudo apt update && sudo apt install -y git curl unzip
```

Doit se terminer sans ligne `E:`. `unzip` sert à l'installation de Bun.

### 2.3 VS Code

1. Installe VS Code sous Windows.
2. Installe l'extension « WSL » (éditeur Microsoft).
3. Plus tard, une fois l'atelier cloné (§ 2.6), ouvre-le depuis Ubuntu :

    ```sh
    cd ~/atelier-front
    code .
    ```

    VS Code s'ouvre et affiche « WSL: Ubuntu » en bas à gauche.

### 2.4 Docker Desktop

Sous Linux (donc dans WSL2), la qualification des bibliothèques enferme chaque
exécution dans Docker. Les preuves du relais nginx utilisent aussi Docker.

1. Installe Docker Desktop sous Windows.
2. Dans Docker Desktop : Settings → Resources → WSL integration → active «
   Ubuntu » → Apply & restart.
3. Vérifie, dans Ubuntu, sans `sudo` :

    ```sh
    docker info > /dev/null && echo DOCKER-OK
    ```

    Doit afficher `DOCKER-OK`. Sinon, voir le dépannage (§ 8).

### 2.5 Identité Git et accès à GitHub

1. Identité générale :

    ```sh
    git config --global user.name "<prénom nom>"
    git config --global user.email "<adresse>"
    ```

2. Accès à GitHub depuis WSL, par le gestionnaire d'identifiants de Windows. Git
   pour Windows doit être installé côté Windows.

    ```sh
    git config --global credential.helper "/mnt/c/Program\ Files/Git/mingw64/bin/git-credential-manager.exe"
    ```

    Au premier `git push`, une fenêtre Windows de connexion à GitHub s'ouvre.

L'identité doit **aussi** être écrite dans le clone lui-même : voir § 2.6.

### 2.6 Cloner l'atelier

Clone dans le système de fichiers Linux (`~`), **jamais sous `/mnt/c`** : les
montages Windows sont lents et ne donnent pas les droits Linux dont les verrous
de l'atelier ont besoin.

```sh
git clone <adresse du dépôt> ~/atelier-front
cd ~/atelier-front
```

L'adresse du dépôt est sur sa page GitHub, bouton « Code ». Depuis l'explorateur
Windows, le dossier est visible à
`\\wsl.localhost\Ubuntu\home\<utilisateur>\atelier-front`.

Écris ensuite l'identité **dans le clone**, sans `--global` :

```sh
git config user.name "<prénom nom>"
git config user.email "<adresse>"
git config --local user.name && git config --local user.email
```

La dernière ligne doit afficher ton nom puis ton adresse. Pourquoi : la commande
`add-library` crée elle-même un commit, en ignorant volontairement la
configuration globale (`GIT_CONFIG_GLOBAL=/dev/null` dans
`tools/library-setup/library-application.mjs` et
`tools/library-setup/publication-transaction.mjs`). Sans identité locale, elle
échoue avec `Author identity unknown`.

### 2.7 Node (par nvm), puis Bun

Les versions exactes sont écrites dans le dépôt : Node dans `.nvmrc`, Bun dans
le champ `packageManager` de `package.json`. Ne tape jamais un numéro de version
à la main : les commandes ci-dessous le lisent.

1. Installe nvm en suivant son installation officielle
   (<https://github.com/nvm-sh/nvm#installing-and-updating>), puis ferme et
   rouvre le terminal.
2. Installe le Node de l'atelier :

    ```sh
    cd ~/atelier-front
    nvm install
    nvm use
    nvm alias default "$(cat .nvmrc)"
    test "$(node --version)" = "v$(cat .nvmrc)" && echo NODE-OK
    ```

    Doit afficher `NODE-OK`. Un message `npm error … AppData\Roaming\npm`
    pendant `nvm install` est sans gravité (voir § 8).

3. Installe le Bun de l'atelier, avec sa version exacte :

    ```sh
    curl -fsSL https://bun.sh/install | bash -s "bun-v$(node -p "require('./package.json').packageManager.slice(4)")"
    source ~/.bashrc
    test "$(bun --version)" = "$(node -p "require('./package.json').packageManager.slice(4)")" && echo BUN-OK
    ```

    Doit afficher `BUN-OK`.

### 2.8 Installer les dépendances et vérifier

```sh
cd ~/atelier-front
bun install --frozen-lockfile
git status --short
bun run check:engines
```

- `bun install` vérifie d'abord Node (`preinstall`), puis active les hooks Git
  (`prepare`). Il ne doit afficher aucune ligne `✖`.
- `git status --short` ne doit rien afficher.
- `check:engines` doit afficher une ligne qui commence par
  `✔ Environnement conforme — Node`.

### 2.9 macOS

Tout fonctionne nativement : nvm, Bun et Docker Desktop, avec les mêmes
commandes (§ 2.5 à § 2.8, sans la ligne `credential.helper` propre à Windows).
Sur Mac, la qualification des bibliothèques utilise le confinement natif de
macOS (`sandbox-exec`), pas Docker ; Docker reste utile pour les preuves du
relais nginx.

### 2.10 Ce qui ne fonctionne pas : Windows natif

PowerShell et Git Bash ne sont pas pris en charge. Deux raisons, visibles dans
le code :

- `selectSandboxBackend` (`tools/library-setup/sandbox.mjs`) n'accepte que
  `darwin` (macOS) et `linux` ;
- `tools/check-secrets.mjs`, lancé par le hook `pre-push`, n'a pas de binaire
  gitleaks pour `win32`.

Les messages correspondants sont dans le dépannage (§ 8).

## 3. Les commandes de tous les jours

Toutes se lancent dans `~/atelier-front`.

| Commande                                   | À quoi elle sert                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `git switch main && git pull`              | Revenir sur `main` à jour                                                   |
| `bun install --frozen-lockfile`            | Installer exactement les versions du verrou `bun.lock`, sans le réécrire    |
| `bun run check:engines`                    | Vérifier que Node et Bun sont dans la plage `engines` de `package.json`     |
| `bun run check:all`                        | Lancer tous les contrôles locaux de l'atelier (long)                        |
| `bun run check:docs`                       | Vérifier la charte et les liens entre documents                             |
| `bun run format`                           | Mettre en forme `apps/`, `libs/`, `tools/` et les configurations            |
| `bun run format:check`                     | Vérifier la mise en forme sans rien modifier                                |
| `bun run check:secrets`                    | Chercher des secrets dans l'historique (gitleaks)                           |
| `bun run check:library-setup`              | Contrôler les bibliothèques qualifiées (Material, Tailwind)                 |
| `bun run test:external-application-shells` | Tester la chaîne de création des applications extérieures                   |
| `bun run check:nginx-image`                | Vérifier la forme de l'image nginx du relais, sans réseau                   |
| `bun run check:nginx-digest`               | Comparer l'empreinte de l'image nginx du relais au registre (Docker requis) |
| `bunx nx show projects`                    | Lister les projets du dépôt                                                 |
| `bun run protect:main -- --dry-run`        | Afficher la protection de `main` sans l'appliquer                           |

`bun run protect:main` (sans `--dry-run`) applique réellement la protection de
`main` et les réglages de fusion sur GitHub. Il demande `gh auth login`. C'est
un acte du propriétaire, à faire seulement quand
`.github/branch-protection.main.json` a changé.

## 4. Les versions de Node et de Bun

### 4.1 Ce qui est figé, et où

Node est écrit dans `.nvmrc`, Bun dans `package.json` → `packageManager`. Le
reste en découle. Pour lire les valeurs : `cat .nvmrc` et
`node -p "require('./package.json').packageManager"`.

| Fichier                                 | Ce qu'il fixe                                                                                                            | Qui le lit                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `.nvmrc`                                | Node, version exacte                                                                                                     | la CI (`setup-node`, puis une vérification d'égalité exacte), `nvm`, la politique des versions                       |
| `package.json` → `packageManager`       | Bun, version exacte                                                                                                      | la CI (`setup-bun`, puis une vérification d'égalité exacte), la politique des versions ; recopié dans chaque produit |
| `package.json` → `engines`              | la plage acceptée de Node et de Bun                                                                                      | `bun install` (script `preinstall` = `check:engines`) ; recopié dans chaque produit                                  |
| `conventions/libraries/*/*.compat.json` | pour chaque bibliothèque : des plages (`requirements`) et les versions testées, exactes (`verification.tested_versions`) | `add-library`, `check:library-setup`, le job CI « Library integration »                                              |
| `bun.lock`                              | la version exacte de chaque dépendance                                                                                   | `bun install --frozen-lockfile` ; projeté dans chaque produit                                                        |

Deux contrôles ne regardent pas la même chose :

- `bun install` (`check:engines`) vérifie seulement que Node est **dans la
  plage** `engines`. Il accepte une version voisine de `.nvmrc`.
- L'usage d'une bibliothèque qualifiée exige l'**égalité exacte** entre la
  version qui tourne et celle qui a été testée
  (`tools/library-setup/compatibility.mjs`, fonction `selectCompatibilityTrack`,
  et `tools/library-setup/library-application.mjs` pour `add-library`). C'est là
  qu'un écart se voit.

### 4.2 Les effets d'un changement

Même un petit changement de Node ou de Bun oblige à requalifier les
bibliothèques. C'est l'étape la plus longue.

| Ce qui est touché            | Ce qui se passe                                                                                   | Ce qu'il faut faire                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| La CI                        | Elle lit `.nvmrc` et `packageManager` et installe d'elle-même les nouvelles versions              | Rien                                                        |
| Les bibliothèques qualifiées | Leurs versions testées ne correspondent plus : `add-library` et « Library integration » refusent  | Repasser les pistes en `candidate`, puis requalifier (§ 5)  |
| Le verrou `bun.lock`         | Une nouvelle version de Bun peut résoudre les dépendances autrement                               | Relire le diff du verrou, le committer                      |
| Les nouveaux produits        | Ils reçoivent les nouveaux `packageManager` et `engines`, et un verrou tiré de celui de l'atelier | Vérifier qu'un produit d'essai ne change que sur ces points |
| Les produits déjà créés      | Ils gardent leurs anciennes versions                                                              | Les mettre à jour un par un, chacun par sa PR               |
| Les plans en attente         | Un plan est lié à l'état exact du dépôt (commit, versions, verrou) : il est périmé                | Refaire le `--dry-run`                                      |
| Les machines                 | Chaque poste et chaque clone garde l'ancienne version                                             | Installer la nouvelle partout                               |

### 4.3 La procédure, dans une seule PR

Les commandes se lancent dans `~/atelier-front`. L'exemple change Node ; pour
Bun, c'est la même chose avec `packageManager`.

1. **Créer une branche depuis `main` à jour.**

    ```sh
    git switch main && git pull
    git switch -c chore/node-<nouvelle-version>
    ```

2. **Installer la nouvelle version sur la machine.**

    ```sh
    nvm install <nouvelle-version>
    ```

    Pour Bun :
    `curl -fsSL https://bun.sh/install | bash -s "bun-v<nouvelle-version>"`.

3. **Écrire la nouvelle version dans le dépôt**, et nulle part ailleurs.

    ```sh
    echo <nouvelle-version> > .nvmrc
    nvm use
    ```

    Pour Bun : dans `package.json`,
    `"packageManager": "bun@<nouvelle-version>"`. Si la version sort de la plage
    `engines` de `package.json`, ajuste aussi cette plage.

4. **Réinstaller les dépendances**, sans `--frozen-lockfile` cette fois, puis
   relire ce qui a changé.

    ```sh
    bun install
    git diff --stat
    ```

5. **Lancer les contrôles.**

    ```sh
    bun run check:engines
    node --test tools/runtime-version-policy.test.mjs
    bun run check:all
    ```

    Si `check:all` échoue seulement dans `check:library-setup` (pistes
    périmées), fais d'abord les étapes 6 et 7, puis relance `bun run check:all`.

6. **Committer le changement de version.**

    ```sh
    git add .nvmrc package.json bun.lock
    git commit -m "chore(runtime): passer à Node <nouvelle-version>"
    ```

7. **Repasser les trois pistes en `candidate`.** Une promotion n'accepte qu'une
   piste `candidate` : une piste encore `verified` est refusée
   (`0 piste candidate compatible (attendu exactement 1)`). Demande-le à un
   agent (rôle `task-specialist`, mode `fix`, voir [agents.md](./agents.md)) :
   dans chaque `.compat.json`, `"status": "candidate"` et
   `"verification": null`, dans un commit à part. Tu ne modifies pas ces
   fichiers à la main.

8. **Requalifier les bibliothèques** : les cinq commandes du § 5.3, avec un
   commit après chacune.

9. **Vérifier la chaîne de création** sur les produits d'essai :

    ```sh
    bun run test:external-application-shells
    ```

10. **Pousser et ouvrir la PR**, assignée au relecteur (§ 6.4). Attendre la CI
    verte, puis la fusion par le relecteur.

### 4.4 Ce qu'il faut observer

| Étape                 | Commande de contrôle                                                                         | Signe que c'est bon                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 2-3. Version          | `test "$(node --version)" = "v$(cat .nvmrc)" && echo NODE-OK`                                | `NODE-OK` (pour Bun : la commande `BUN-OK` du § 2.7)                                                                       |
| 4. Dépendances        | `bun install`, puis `git diff --stat`                                                        | Aucune ligne `✖`. Pour Node seul, le diff ne montre en général que `.nvmrc`. Pour Bun : `package.json`, souvent `bun.lock` |
| 5. Contrôles          | les trois commandes de l'étape 5                                                             | Code de sortie 0 (`echo $?` affiche `0`) ; `# fail 0` pour le test                                                         |
| 7. Pistes             | `node -p "require('./conventions/libraries/angular/tailwind.compat.json').tracks[0].status"` | `candidate`, et de même pour les deux autres fichiers                                                                      |
| 8. Requalification    | le contrôle du § 5.3 après chaque promotion                                                  | `verified / Node <version de .nvmrc>`                                                                                      |
| 8. Contrôle final     | `bun run check:library-setup`                                                                | `✅ Matrices de compatibilité : 3 bibliothèque(s) couvertes.` puis une ligne `✔ check:library-setup —`                     |
| 9. Chaîne de création | `bun run test:external-application-shells`                                                   | `# fail 0`                                                                                                                 |
| 10. CI                | la page de la PR sur GitHub                                                                  | Tous les jobs verts, surtout « Library integration » et « External application shells »                                    |

Le contrôle le plus important est celui de l'étape 8 : la version inscrite dans
les preuves doit être exactement celle de `.nvmrc`. C'est elle que la CI
utilise.

### 4.5 Après la fusion

- **Les autres machines** : dans chaque clone, `git pull`, puis `nvm install` et
  `nvm use` (ils lisent `.nvmrc`), puis `bun install --frozen-lockfile`.
- **Les produits déjà créés** gardent leurs anciennes versions dans leur propre
  `package.json`. Chacun se met à jour par sa PR, avec ses tests et sa CI.

### 4.6 Cas particuliers : version majeure, Angular, Nx

**Nouvelle version majeure de Node.** Lis la plage actuelle des pistes :

```sh
node -p "require('./conventions/libraries/angular/tailwind.compat.json').tracks[0].requirements.node"
```

Si la nouvelle version sort de cette plage, deux étapes s'ajoutent :

1. vérifier qu'Angular et Nx prennent en charge cette version de Node ;
2. faire ajouter par un agent, dans chaque `.compat.json`, une nouvelle piste
   `candidate` avec la nouvelle plage, puis la qualifier (§ 5). Deux pistes
   d'une même bibliothèque ne doivent pas se chevaucher (`check:library-setup`
   refuse les `pistes chevauchantes`).

**Nx.** Dependabot ignore Nx. Le workflow `.github/workflows/nx-migrations.yml`
s'en charge chaque lundi, ou à la demande (GitHub → Actions → « Nx — migrations
natives » → Run workflow). Il applique les migrations natives, requalifie
lui-même les trois bibliothèques en CI et ouvre une PR brouillon
`build(deps): appliquer les migrations Nx <version>`. S'il ne peut pas conclure,
il ouvre un ticket `Nx <version> — instructions de migration à traiter`.

**Angular.** Les paquets Angular arrivent par une PR Dependabot groupée (groupe
`angular`). Les pistes sont liées à la version exacte d'Angular : une telle PR
exige la requalification (§ 7).

Règle de base : **une version change dans une PR à elle, et la CI verte
décide.**

## 5. Requalifier les bibliothèques

### 5.1 Quand

Le job CI « Library integration » et `add-library` exigent des pistes `verified`
dont la preuve correspond à l'état actuel du dépôt. Il faut requalifier :

- après un changement de Node ou de Bun (§ 4) ;
- après un changement d'Angular, de React ou de Nx (versions testées exactes) ;
- après un changement d'une entrée qui gouverne la qualification :
    - la recette `conventions/libraries/<plateforme>/<bibliothèque>.setup.json`,
      les schémas et la politique de `conventions/libraries/` ;
    - `nx.json`, `tsconfig.base.json` et `.gitattributes` ;
    - les outils de `tools/library-setup/` et les quelques outils voisins listés
      dans `tools/library-setup/tooling-fingerprint.mjs` ;
    - les versions des paquets qualifiés dans `package.json` et `bun.lock` ;
- quand un message du dépannage (§ 8) le demande.

Avant de commencer, chaque piste doit être `candidate` (§ 4.3, étape 7) :

```sh
node -p "require('./conventions/libraries/angular/tailwind.compat.json').tracks[0].status"
node -p "require('./conventions/libraries/react/tailwind.compat.json').tracks[0].status"
node -p "require('./conventions/libraries/angular/angular-material.compat.json').tracks[0].status"
```

Les trois lignes doivent afficher `candidate`.

### 5.2 Avant de commencer

1. Travaille dans le clone principal sous `~` (pas sous `/mnt/c`, pas dans un
   `git worktree`) : le verrou de promotion exige un vrai répertoire `.git`.
2. Versions exactes :

    ```sh
    test "$(node --version)" = "v$(cat .nvmrc)" && echo NODE-OK
    test "$(bun --version)" = "$(node -p "require('./package.json').packageManager.slice(4)")" && echo BUN-OK
    ```

    Doit afficher `NODE-OK` puis `BUN-OK`. La promotion inscrit la version de
    Node **qui tourne**, pas celle de `.nvmrc` : un écart ici rendra « Library
    integration » rouge en CI.

3. Docker (sous Linux) : `docker info > /dev/null && echo DOCKER-OK` doit
   afficher `DOCKER-OK`. Au premier usage, trois images épinglées sont
   téléchargées (`oven/bun`, `node`, `mcr.microsoft.com/playwright`, environ 3
   Gio). Il faut une machine x86-64.
4. Réseau vers `registry.npmjs.org`, Docker Hub, `mcr.microsoft.com` et
   `storage.googleapis.com`.
5. Au moins 15 Gio libres (`df -h ~`).
6. Identité Git locale :
   `git config --local user.name && git config --local user.email` doit afficher
   ton nom et ton adresse (§ 2.6).
7. Dépôt propre et à jour :

    ```sh
    bun install --frozen-lockfile
    git status --short
    ```

    `git status --short` ne doit rien afficher.

8. Une seule fois dans le terminal, pour que `tee` ne masque pas un échec :

    ```sh
    set -o pipefail
    ```

Compte de 10 à 30 minutes par commande, davantage la première fois.

### 5.3 Les cinq commandes, dans cet ordre

L'ordre est imposé. Tailwind Angular se qualifie sur
`library-qualification-angular`, qui contient Material. Material se qualifie sur
`library-qualification-angular-tailwind`, qui doit d'abord recevoir Tailwind. Et
`add-library` n'accepte Tailwind qu'une fois sa piste `verified`.

Après chaque promotion, contrôle la piste avec cette commande, en remplaçant
`<plateforme>/<bibliothèque>` :

```sh
node -p "const t=require('./conventions/libraries/<plateforme>/<bibliothèque>.compat.json').tracks[0]; t.status + ' / Node ' + t.verification.tested_versions.node"
```

Elle doit afficher `verified / Node ` suivi exactement du contenu de `.nvmrc`.

**Commande 1 — Tailwind Angular**

```sh
bun run promote-library-compatibility --app library-qualification-angular --library tailwind 2>&1 | tee ~/requalif-1.log
```

- Doit afficher les étapes `[1/8] preconditions` à `[8/8] dry-run-complete`,
  puis un JSON qui contient `"library": "tailwind"` et `"platform": "angular"`.
- `git status --short` doit afficher exactement
  ` M conventions/libraries/angular/tailwind.compat.json`.
- Contrôle de la piste avec `angular/tailwind`.

```sh
git add conventions/libraries/angular/tailwind.compat.json
git commit -m "test(deps): requalifier Tailwind Angular"
```

**Commande 2 — Tailwind React**

```sh
bun run promote-library-compatibility --app library-qualification-react --library tailwind 2>&1 | tee ~/requalif-2.log
```

- Mêmes signes de réussite, avec `"platform": "react"`.
- `git status --short` doit afficher exactement
  ` M conventions/libraries/react/tailwind.compat.json`.
- Contrôle de la piste avec `react/tailwind`.

```sh
git add conventions/libraries/react/tailwind.compat.json
git commit -m "test(deps): requalifier Tailwind React"
```

**Commande 3 — ajouter Tailwind au banc
`library-qualification-angular-tailwind`**

D'abord, regarde si le banc a déjà Tailwind :

```sh
node -p "require('./apps/library-qualification-angular-tailwind/.cmz/libraries.json').libraries"
```

- `[]` : fais la commande 3. C'est le cas après une reconstruction du banc.
- `[ 'tailwind' ]` : passe directement à la commande 4.

La commande 3 se fait en deux temps : un plan sans publication, puis la
publication liée à ce plan exact.

```sh
bun run --silent add-library --app library-qualification-angular-tailwind --library tailwind --dry-run > ~/requalif-3-plan.json
echo $?
PLAN=$(node -p "require(process.env.HOME + '/requalif-3-plan.json').plan.plan_id")
echo "$PLAN"
node -p "require(process.env.HOME + '/requalif-3-plan.json').published"
```

- `echo $?` doit afficher `0`.
- `echo "$PLAN"` doit afficher `library-plan:` suivi de 64 caractères
  hexadécimaux.
- La dernière commande doit afficher `false`.

Puis, sans aucun commit entre les deux (sinon le plan est périmé) :

```sh
bun run add-library --app library-qualification-angular-tailwind --library tailwind --expect-plan "$PLAN" 2>&1 | tee ~/requalif-3.log
```

- Doit afficher `[1/8] preconditions` à `[8/8] publication`, puis un JSON avec
  `"published": true`.
- **Pas de commit à faire** : `add-library` crée lui-même le commit.
- `git log -1 --format=%s` doit afficher
  `chore(library-qualification-angular-tailwind): add tailwind`, et
  `git status --short` ne rien afficher.

**Commande 4 — Angular Material**

```sh
bun run promote-library-compatibility --app library-qualification-angular-tailwind --library angular-material 2>&1 | tee ~/requalif-4.log
```

- Mêmes signes de réussite, avec `"library": "angular-material"`.
- `git status --short` doit afficher exactement
  ` M conventions/libraries/angular/angular-material.compat.json`.
- Contrôle de la piste avec `angular/angular-material`.

```sh
git add conventions/libraries/angular/angular-material.compat.json
git commit -m "test(deps): requalifier Angular Material"
```

**Commande 5 — contrôle final**

```sh
bun run check:library-setup 2>&1 | tee ~/requalif-5.log
```

Doit sortir avec le code 0 et afficher
`✅ Matrices de compatibilité : 3 bibliothèque(s) couvertes.`, puis une ligne
qui commence par `✔ check:library-setup —`. Aucun fichier ne doit changer : pas
de commit.

Ensuite, ne modifie plus les entrées gouvernantes (§ 5.1) dans cette branche :
sinon tout est à refaire.

### 5.4 En cas d'échec

1. **Arrête-toi.** Ne passe pas à la commande suivante.
2. **Ne corrige rien à la main** : ni `.compat.json`, ni fichier de banc, ni
   verrou. Ne relance pas avec d'autres options.
3. Si une promotion échoue, l'outil remet lui-même la matrice dans son état
   d'origine.
4. Un verrou `.git/cmz-library-promotion.lock` peut rester après un Ctrl-C. La
   promotion suivante reprend d'elle-même un verrou dont le processus est mort
   sur la même machine. Ne le supprime jamais : si le message
   `promotion déjà active` persiste, signale-le.
5. Transmets à un agent (`task-specialist`, mode `diagnose`) : le journal
   `~/requalif-<N>.log` (et `~/requalif-3-plan.json` pour la commande 3), la
   sortie de `git status --short` et celle de `git log --oneline -6`.

## 6. Git, commits, hooks et PR

### 6.1 Branches

- `main` est la branche de référence. On n'y pousse jamais directement : tout
  passe par une PR.
- Une branche par sujet, nommée `<type>/<sujet-court>`, par exemple
  `chore/node-<version>` ou `docs/guide-atelier`. Ce nom n'est pas contrôlé.
- `main` est protégée (source : `.github/branch-protection.main.json`) : PR
  obligatoire, une approbation d'une autre personne sur le dernier push,
  relecture des propriétaires de code, tous les jobs bloquants verts, historique
  linéaire, conversations résolues, aucune poussée forcée. La fusion se fait par
  squash et la branche est supprimée ensuite
  (`.github/repository-settings.json`).
- Un changement de `tsconfig.base.json`, `nx.json` ou `eslint.config.mjs` ne
  reste jamais plus de 24 h hors d'une PR ouverte (au besoin en brouillon).

### 6.2 Messages de commit

La convention est vérifiée par commitlint (`commitlint.config.mjs`) :

```text
<type>(<portée>): <sujet>
```

| Élément | Règle                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------- |
| Type    | `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `revert`            |
| Portée  | facultative, en minuscules avec tirets (`generator-platform`, `runtime`…)                      |
| Sujet   | sans point final ; ni tout en majuscules, ni une majuscule à chaque mot (l'usage : minuscules) |
| En-tête | 72 caractères au plus                                                                          |
| Corps   | lignes de 100 caractères au plus                                                               |

Exemple : `docs(proprietaire): préciser la requalification`.

### 6.3 Hooks

Ils s'activent au `bun install` (script `prepare`, Husky).

| Moment       | Ce qui est vérifié                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pre-commit` | poids et nombre de lignes des fichiers (`check:weight`), mise en forme (lint-staged)                                                             |
| `commit-msg` | message conforme à la convention (commitlint)                                                                                                    |
| `pre-push`   | versions du catalogue (`check:versions`), secrets des commits à pousser (`check:secrets -- --pre-push`), fichiers dupliqués (`check:duplicates`) |

Un hook ne se contourne jamais (`--no-verify`) : la CI rejoue ces contrôles et
bloque la PR. Si un hook échoue sur `bun: not found` depuis un client Git
graphique, crée un fichier `~/.config/husky/init.sh` qui ajoute le dossier de
Bun au `PATH` (les hooks ajoutent déjà `$HOME/.bun/bin`).

### 6.4 Ouvrir une PR

```sh
git push -u origin <branche>
gh pr create --base main --assignee soumailakouda --title "<type>(<portée>): <sujet>" --body "<ce qui change et pourquoi>"
```

`gh` est la ligne de commande GitHub (installation : <https://cli.github.com>,
puis `gh auth login` une fois). Sans `gh`, ouvre la PR depuis la page GitHub du
dépôt (bouton « Compare & pull request ») et assigne-la à `soumailakouda`.
Ajoute `--draft` si le travail n'est pas prêt.

Chaque nouveau push relance la CI et annule l'approbation précédente.

### 6.5 La CI : les jobs et ce qu'un rouge veut dire

La CI (`.github/workflows/ci.yml`) tourne sur chaque PR vers `main` et sur
`main`. Pour reproduire un contrôle en local, lance la commande `bun run …`
écrite dans le nom de l'étape rouge.

| Job                                                        | Un rouge veut le plus souvent dire                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Garde-fous socle                                           | un contrôle `check:…` a échoué ; le nom de l'étape le dit. « Format check » : lancer `bun run format`                                                            |
| Publication durability (linux-ext4 / macos-apfs)           | une régression des publications transactionnelles du moteur                                                                                                      |
| Library candidate isolation (linux-docker / macos-sandbox) | une régression du confinement des bibliothèques (lancé seulement si ses outils changent)                                                                         |
| Library integration (create-app → Material → Tailwind)     | pistes non `verified`, versions testées différentes de la CI, ou entrées gouvernantes changées : requalifier (§ 5). Lancé seulement si ses entrées changent      |
| External application shells                                | une régression de la chaîne de création ; ou la forme de l'image nginx : voir `CMZ_NGINX_IMAGE_INVALID` (§ 8). Une image republiée ne rougit plus ce job (§ 8.2) |
| Secret scan (gitleaks)                                     | un secret dans l'historique : ne pas contourner, le retirer et le révoquer                                                                                       |
| Oracle — lint + build + ngc + test                         | un projet modifié ne compile pas, a un avertissement de lint ou un test rouge                                                                                    |
| E2E smoke (Playwright)                                     | la preuve navigateur du projet `workspace-react-proof` a échoué (lancée seulement si ce projet est concerné)                                                     |
| Dead-code (knip)                                           | un fichier, un export ou une dépendance inutilisés                                                                                                               |
| Dependency audit (bun audit)                               | une vulnérabilité haute ou critique ; une exception d'`AUDIT_IGNORES` expirée, périmée, rendue inutile par un correctif ou invérifiable (registre npm)           |
| Third-party licenses (license-checker)                     | une dépendance de production sous licence non permissive                                                                                                         |
| Duplicate files (MD5)                                      | deux fichiers identiques entre modules                                                                                                                           |
| SAST (Semgrep, rapport seul)                               | un rapport à lire ; ce job ne bloque pas la fusion                                                                                                               |

Un job **annulé** parce qu'il a dépassé sa durée maximale (machines chargées)
n'est pas un échec du code : relance-le (page du run → « Re-run failed jobs »,
ou `gh run rerun <numéro-du-run> --failed`). Un même échec deux fois de suite
n'est plus un hasard : fais-le diagnostiquer.

## 7. Les PR automatiques

Dependabot (`.github/dependabot.yml`) propose des mises à jour pour trois
familles : chaque lundi, les paquets (`build(deps): …`) et les actions GitHub
(`ci(deps): …`) ; chaque jour, l'image nginx du relais (`build(docker): …`).
Deux workflows ouvrent aussi des PR : `security-overrides-repair.yml`
(réparation quotidienne des surcharges de sécurité,
`fix(deps): auto-repair vulnerable security overrides`) et `nx-migrations.yml`
(§ 4.6). Le workflow quotidien `nginx-digest-freshness.yml` n'ouvre pas de PR :
en cas d'écart, il ouvre une issue (§ 8.2).

| Type de PR                                                                                                                             | Que faire                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mise à jour simple, CI verte                                                                                                           | Lire le titre et le journal des changements lié ; approuver ; la fusion est faite par le relecteur                                                                                                                                                                                                                           |
| Mise à jour d'une bibliothèque qualifiée (`@angular/material`, `@angular/cdk`, `tailwindcss`, `@tailwindcss/*`) ou d'Angular, de React | « Library integration » devient rouge : les pistes doivent être adaptées et requalifiées dans la même PR. Récupère la branche (`gh pr checkout <numéro>`), fais repasser les pistes en `candidate` par un agent (et mettre à jour leurs versions de paquets si la PR les change), requalifie (§ 5), pousse                   |
| Nx                                                                                                                                     | Dependabot ne la propose pas : c'est la PR brouillon de `nx-migrations.yml`, déjà requalifiée ; vérifier sa CI                                                                                                                                                                                                               |
| Nouvelle version d'une action GitHub (`ci(deps)`)                                                                                      | La relire : une action s'exécute avec le jeton du dépôt. Si `check:dependabot-policy` ou `check:ci-wiring` affiche `action non relue dans la publication`, l'action sert à la publication de `nx-migrations.yml` : la liste relue est dans `tools/nx-migration-plan.mjs`, à faire mettre à jour par un agent après relecture |
| Toute PR qui change `.nvmrc` ou `packageManager`                                                                                       | Suivre la procédure du § 4.3                                                                                                                                                                                                                                                                                                 |
| Image nginx (`build(docker)`)                                                                                                          | Vérifier que « External application shells » est vert : forme de l'image et relais sur la nouvelle empreinte. La faire fusionner vite : tant qu'elle attend, la vérification quotidienne reste rouge et son issue ouverte. Si une autre PR propose la même empreinte, fermer l'une des deux (§ 8.2)                          |
| Jobs annulés par dépassement de durée                                                                                                  | Relancer (§ 6.5)                                                                                                                                                                                                                                                                                                             |

Après un push humain sur une branche Dependabot, Dependabot ne la met plus à
jour : c'est normal.

## 8. Dépannage

Un message d'erreur ne se contourne jamais. Ne modifie rien au hasard : corrige
la cause, puis relance. Les messages ci-dessous sont copiés du code (`…`
remplace une partie variable) ; ceux de Windows, WSL, Docker ou npm viennent de
ces outils.

| Message affiché                                                                                                                            | Cause                                                                                                           | Que faire                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[check:secrets] plateforme non supportée: win32/x64. Installez gitleaks v… et exportez GITLEAKS_BIN.`                                     | Git lancé depuis Windows natif : le hook `pre-push` n'a pas de gitleaks pour Windows                            | Travailler dans Ubuntu (WSL2), dans `~/atelier-front` (§ 2)                                                                                                                                                     |
| `plateforme sans backend de confinement approuvé : win32`                                                                                  | Qualification lancée sous Windows natif : seuls macOS et Linux ont un confinement                               | Travailler dans Ubuntu (WSL2)                                                                                                                                                                                   |
| `git commit-tree a échoué … Author identity unknown …`                                                                                     | `add-library` ignore l'identité globale ; le clone n'a pas d'identité locale                                    | `git config user.name "<prénom nom>"` et `git config user.email "<adresse>"` dans le clone, sans `--global` (le conseil `--global` de Git ne suffit pas ici), puis refaire la commande 3 depuis son `--dry-run` |
| `Could not resolve host`                                                                                                                   | Le DNS de WSL ne répond pas                                                                                     | Relancer une fois ; sinon, dans PowerShell, `wsl --shutdown` puis rouvrir Ubuntu ; en dernier recours, § 8.1                                                                                                    |
| `The command 'docker' could not be found in this WSL 2 distro.`                                                                            | L'intégration WSL de Docker Desktop n'est pas activée pour Ubuntu                                               | Docker Desktop → Settings → Resources → WSL integration → Ubuntu → Apply & restart ; puis `docker info > /dev/null && echo DOCKER-OK`                                                                           |
| `Docker absent (exécutable introuvable)`, `Docker présent mais accès/socket refusé` ou `Docker installé mais daemon indisponible (code …)` | Docker Desktop arrêté ou non relié à Ubuntu                                                                     | Démarrer Docker Desktop, vérifier l'intégration WSL, puis `docker info > /dev/null && echo DOCKER-OK` (sans `sudo`)                                                                                             |
| `npm error … AppData\Roaming\npm` pendant `nvm install`                                                                                    | Le npm de Windows est vu à travers le `PATH` partagé avec Windows                                               | Sans gravité. Vérifier `command -v node` : le chemin doit contenir `/.nvm/`                                                                                                                                     |
| `CMZ_NGINX_IMAGE_INVALID …`                                                                                                                | La ligne `FROM` du Dockerfile du harnais n'a pas la forme attendue, ou nginx est épinglé ailleurs dans le dépôt | Corriger la ligne `FROM`, ou retirer l'autre épinglage : § 8.2                                                                                                                                                  |
| `CMZ_NGINX_DIGEST_STALE nginx:… : empreinte périmée`                                                                                       | L'image officielle a été republiée sous le même tag (vérification quotidienne, ou lancée à la main)             | Faire fusionner la PR Dependabot ; sans PR Dependabot, § 8.2                                                                                                                                                    |
| `CMZ_NGINX_DIGEST_UNVERIFIABLE nginx:… : vérification impossible`                                                                          | Registre injoignable ou Docker indisponible                                                                     | Vérifier Docker et le réseau, puis relancer `bun run check:nginx-digest` ou le workflow de fraîcheur (§ 8.2)                                                                                                    |
| ``✖ Environnement non conforme au champ `engines` :``                                                                                      | Node ou Bun hors de la plage `engines`                                                                          | `nvm install` puis `nvm use` (sans numéro : ils lisent `.nvmrc`). Ignorer le numéro proposé à la dernière ligne du message                                                                                      |
| `runtime-policy: packageManager non exact` ou `runtime-policy: .nvmrc non exact`                                                           | Version écrite avec `^` ou `~`, déclarée deux fois, ou ligne en trop                                            | Écrire une seule version exacte, comme `1.2.3`                                                                                                                                                                  |
| `Bun exécuté … différent du packageManager …`                                                                                              | Le Bun installé n'est pas celui de `packageManager`                                                             | Réinstaller Bun avec sa version exacte (§ 2.7)                                                                                                                                                                  |
| `… piste verified compatible`                                                                                                              | Aucune piste `verified` ne correspond aux versions actuelles                                                    | Requalifier (§ 5)                                                                                                                                                                                               |
| `node … différent de la qualification`                                                                                                     | Le Node qui tourne n'est pas celui des preuves                                                                  | `nvm use` ; si `.nvmrc` a changé, requalifier (§ 4.3)                                                                                                                                                           |
| `… a changé depuis la qualification` (par exemple `le contexte source a changé depuis la qualification`)                                   | Une entrée gouvernante a changé après la qualification                                                          | Repasser la piste en `candidate` et requalifier (§ 4.3 étape 7, puis § 5)                                                                                                                                       |
| `0 piste candidate compatible (attendu exactement 1)`                                                                                      | Promotion d'une piste encore `verified`, ou nouvelle version hors de la plage de la piste                       | Repasser la piste en `candidate` (§ 4.3 étape 7) ; hors plage, créer une nouvelle piste (§ 4.6)                                                                                                                 |
| « Library integration » rouge en CI, vert chez toi                                                                                         | Preuves faites avec un Node différent de `.nvmrc`, ou entrées gouvernantes changées depuis                      | Aligner la machine sur `.nvmrc` (`nvm use`) et requalifier                                                                                                                                                      |
| `plan attendu library-plan:…, obtenu library-plan:…`                                                                                       | Plan périmé : un commit ou un changement depuis le `--dry-run`                                                  | Refaire le `--dry-run` de la commande 3, puis la publication avec le nouveau plan                                                                                                                               |
| `promotion déjà active (pid …)`                                                                                                            | Une autre promotion tourne, ou un verrou laissé sous un autre nom de machine                                    | Vérifier qu'aucune promotion ne tourne. Ne pas supprimer `.git/cmz-library-promotion.lock` : signaler                                                                                                           |
| `ancienne transaction présente (…)`                                                                                                        | Une publication `add-library` a été interrompue                                                                 | Ne pas supprimer le journal ni le verrou nommés : signaler, avec `git status --short` et `git log --oneline -6`                                                                                                 |
| `dépôt entièrement propre requis`                                                                                                          | `git status --short` n'est pas vide                                                                             | Committer ou faire examiner les changements ; jamais de nettoyage à l'aveugle                                                                                                                                   |
| `… n'est pas installé à la racine`                                                                                                         | Dépendances absentes ou anciennes                                                                               | `bun install --frozen-lockfile`                                                                                                                                                                                 |
| `.git doit être un vrai répertoire canonique en V1`                                                                                        | Promotion lancée depuis un `git worktree` ou un chemin lié                                                      | Lancer depuis le clone principal                                                                                                                                                                                |
| `bun: not found` dans un hook                                                                                                              | Client Git graphique sans le `PATH` du terminal                                                                 | Créer `~/.config/husky/init.sh` (§ 6.3)                                                                                                                                                                         |
| `action non relue dans la publication`                                                                                                     | Nouvelle version d'une action utilisée par la publication de `nx-migrations.yml`                                | Voir § 7                                                                                                                                                                                                        |
| Job CI annulé pour dépassement de durée                                                                                                    | Machines de la CI chargées                                                                                      | Relancer le job (§ 6.5)                                                                                                                                                                                         |

### 8.1 Dernier recours pour le DNS de WSL

1. Regarde d'abord `cat /etc/wsl.conf`. S'il contient déjà une section
   `[network]`, arrête-toi et demande de l'aide.
2. Désactive la génération automatique du DNS :

    ```sh
    printf '[network]\ngenerateResolvConf = false\n' | sudo tee -a /etc/wsl.conf
    ```

3. Dans PowerShell : `wsl --shutdown`, puis rouvre Ubuntu.
4. Écris un serveur DNS :

    ```sh
    sudo rm -f /etc/resolv.conf
    echo 'nameserver 1.1.1.1' | sudo tee /etc/resolv.conf
    getent hosts github.com
    ```

    La dernière commande doit afficher une adresse.

### 8.2 Mettre à jour l'empreinte de l'image nginx

Le relais tire l'image nginx par son empreinte, écrite à un seul endroit :
`tools/generator-platform/nginx-harness/Dockerfile`. Docker Hub republie parfois
le même tag sous une nouvelle empreinte. Trois mécanismes se partagent le
travail :

| Mécanisme                                                        | Quand                                                                                                                                 | Rôle                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check:nginx-image` (a)                                          | Chaque PR et chaque push sur `main`, job « External application shells »                                                              | Forme seulement, sans réseau : une seule ligne `FROM nginx:<tag>@sha256:<64 caractères>`, aucun autre épinglage de nginx dans le dépôt. Bloquant                                                                                             |
| Dependabot, PR `build(docker): bump nginx …`                     | Chaque jour, à l'heure fixe écrite dans `.github/dependabot.yml`                                                                      | Ouvre la PR qui met à jour l'empreinte, même quand le tag ne change pas. C'est la source normale des mises à jour                                                                                                                            |
| `nginx-digest-freshness.yml`, qui lance `check:nginx-digest` (b) | Chaque jour, au moins deux heures après Dependabot ; ou à la main (Actions → « Fraîcheur de l'image nginx du relais » → Run workflow) | Compare l'empreinte épinglée à celle du registre. Ne bloque aucune PR. En échec, le run reste rouge, et une seule issue « nginx du relais : empreinte épinglée à rafraîchir », assignée au propriétaire, est ouverte, actualisée ou rouverte |

Le cas normal : la PR Dependabot arrive dans la journée ; la relire et la faire
fusionner (§ 7). L'issue ne s'ouvre que si l'empreinte est encore périmée au
passage de (b). Une PR Dependabot d'empreinte n'est pas remplacée tant qu'elle
reste ouverte : si le tag a encore été republié entre-temps, commenter
`@dependabot recreate` sur la PR.

**(b) rouge sans PR Dependabot.** Dans trois cas connus, Dependabot n'ouvre rien
alors que (b) est rouge :

- l'index multi-architecture a changé, mais le manifeste de chaque plate-forme
  est identique : Dependabot juge la mise à jour inutile, alors que (b) compare
  l'empreinte de l'index ;
- GitHub a activé, de son côté, la suppression des PR d'empreinte seule (une
  expérience de Dependabot) ;
- le registre n'a pas rendu d'empreinte à Dependabot : il suppose alors l'image
  à jour, sans le signaler.

Un échec de Dependabot lui-même n'apparaît que dans « Insights → Dependency
graph → Dependabot ». Dans ces cas, mettre l'empreinte à jour à la main
(procédure ci-dessous). Si (b) affiche `CMZ_NGINX_DIGEST_UNVERIFIABLE`, c'est le
registre ou Docker : relancer le workflow avant toute autre action. GitHub
suspend aussi les workflows planifiés d'un dépôt public après 60 jours sans
activité : s'il est suspendu, le réactiver dans Actions.

**Risque accepté.** (a) ne vérifie que la forme. Une empreinte bien formée mais
publiée pour un autre tag nginx, plus ancien par exemple, passe (a) et le
relais, qui la tire sans erreur. Seule (b) la voit, à son passage suivant : au
plus tard le lendemain.

**Empreinte retirée du registre.** Une empreinte périmée reste tirée par le
relais : la CI des PR ne dépend plus de la fraîcheur. Si Docker Hub cessait de
servir l'empreinte épinglée, `check:nginx-relay` (job « External application
shells ») échouerait au tirage de l'image sur toutes les PR. Ce cas n'a pas été
observé ; la conduite est la mise à jour à la main ci-dessous.

**Mise à jour à la main**, dans une branche dédiée :

1. Lis le tag épinglé :
   `grep '^FROM nginx:' tools/generator-platform/nginx-harness/Dockerfile`.
2. Demande l'empreinte actuelle de ce tag :

    ```sh
    docker buildx imagetools inspect nginx:<tag>
    ```

    Note la valeur de la ligne `Digest:` (`sha256:` suivi de 64 caractères).

3. Dans `tools/generator-platform/nginx-harness/Dockerfile`, remplace
   l'empreinte de la ligne `FROM nginx:<tag>@sha256:…` par la nouvelle.
4. Vérifie la forme, puis la fraîcheur :

    ```sh
    bun run check:nginx-image
    bun run check:nginx-digest
    ```

    Doivent afficher `CMZ_NGINX_IMAGE_OK nginx:<tag>@sha256:…`, puis
    `CMZ_NGINX_DIGEST_OK nginx:<tag>`.

5. Commit, puis PR (§ 6.4). Si une PR Dependabot propose la même empreinte,
   fermer l'une des deux.
6. Après la fusion, relance le workflow de fraîcheur à la main ; s'il est vert,
   ferme l'issue de suivi.

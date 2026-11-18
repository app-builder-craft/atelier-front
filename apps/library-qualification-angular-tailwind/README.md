# Banc de qualification Angular avec Tailwind

Cette application interne minimale n'est ni un produit ni une cible de
déploiement. Elle sert exclusivement à qualifier Angular Material en présence de
Tailwind : elle reçoit `tailwind` par `add-library`, puis
`promote-library-compatibility` y qualifie `angular-material` avant sa promotion
en `verified`.

Elle ne reçoit aucun code métier et ne pose aucune typographie globale. La
preuve `material-preserves-host-typography` charge tout le CSS compilé de
l'application après une typographie hôte sentinelle et exige qu'elle reste
intacte : une police posée par le banc ferait échouer la preuve sans rapport
avec Material. Ce banc n'est donc pas une coque produite par `create-app`, qui
fixe sa propre police racine.

Toute bibliothèque présente dans `.cmz/libraries.json` doit avoir été ajoutée
par `add-library` et prouvée par les oracles runtime du workspace.

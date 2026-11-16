# Universal Clone — Module 1 (Cloneur Web)

Application de bureau locale (Windows `.exe` / Linux `.deb`) permettant de cloner l'interface web d'un site, d'intercepter son trafic API XHR/Fetch, d'en déduire un schéma de base de données relationnel, de générer automatiquement un backend PHP 8 natif (PDO) accompagné d'un script `database.sql` (MySQL 8 / Alwaysdata) et d'une base `preview.sqlite` exploitable dans le **Data Studio** intégré.

## Fonctionnalités principales

1. **Aspiration Frontend fidèle** : rendu complet via un vrai navigateur Chromium (Playwright), déclenchement du lazy-loading au défilement, téléchargement et déduplication des ressources (`css`, `js`, `img`, `fonts`, `media`), réécriture intégrale des liens et attributs en chemins relatifs hors ligne.
2. **Sniffer Réseau XHR/Fetch** : capture temps réel des appels API REST/JSON, normalisation des routes (`/api/users/42` → `/api/users/{id}`) et anonymisation automatique des données sensibles (jetons, mots de passe, cookies, emails).
3. **Inférence de Schéma & Générateur Backend** :
   - Détection automatique des tables, colonnes, types SQL, clés primaires et étrangères.
   - Génération de `database.sql` (MySQL 8 InnoDB `utf8mb4`) et `preview.sqlite`.
   - Génération d'un backend PHP 8 natif (`PDO`, requêtes 100 % préparées, routeur REST reproduisant les chemins d'origine) et injection de `clone-shim.js` pour rediriger de manière transparente les appels `fetch`/`XMLHttpRequest` du site cloné.
4. **Data Studio intégré** : explorateur et éditeur SQLite complet (inspiré de phpMyAdmin) avec pagination, tri, filtres, édition en ligne, ajout/suppression/duplication avec annulation 5 s, console SQL sécurisée, sauvegarde automatique avant écriture et import/export CSV/JSON/SQL.
5. **Aperçu local instantané** : serveur HTTP local intégré permettant de tester immédiatement le site cloné hors ligne.

## Prérequis

- **Node.js** >= 20.x et `npm`
- **Python** >= 3.11 avec `venv`
- **Outils de compilation natifs** (pour `better-sqlite3` : `build-essential` / Python)
- Optionnel : **PHP 8+** (pour tester le backend PHP généré en local)

## Installation

```bash
# 1. Installer les dépendances Node.js (et compiler better-sqlite3 pour Electron)
npm install

# 2. Configurer l'environnement Python (.venv) et installer Playwright + Chromium
npm run setup

# 3. Vérifier l'environnement complet
npm run check
```

## Démarrage

```bash
# Lancer l'application Electron
npm start

# Mode développement (avec outils de développement)
npm run dev
```

## Tests

```bash
# Tests unitaires et d'intégration Node.js (SQLite, dépôts, IPC, Data Studio)
npm test

# Tests unitaires du moteur Python (UrlRewriter, CssProcessor, PathNormalizer, SchemaInferrer, SqlGenerator)
npm run test:engine
```

## Empaquetage (Build)

```bash
# Générer le paquet Linux (.deb)
npm run build:linux

# Générer l'installateur Windows (.exe NSIS)
npm run build:win
```

## Documentation

- [Architecture technique](docs/ARCHITECTURE.md)
- [Protocole Electron ↔ Python](docs/PROTOCOL.md)
- [Décisions techniques](docs/DECISIONS.md)

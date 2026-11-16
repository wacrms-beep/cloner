# Architecture Technique — Universal Clone

## 1. Vue d'ensemble

Universal Clone est structuré selon un modèle **multi-processus isolé** :

1. **Processus Principal Electron (`src/main/`)** :
   - Orchestre le cycle de vie des fenêtres (`WindowManager.js`).
   - Expose une passerelle IPC strictement validée (`IpcRouter.js`).
   - Gère la base de données SQLite locale via `better-sqlite3` en mode `WAL` (`Database.js` + `repositories/`).
   - Supervise le moteur Python enfant via `EngineBridge.js` (JSON Lines sur `stdin`/`stdout`, heartbeat, file FIFO, redémarrage automatique).
   - Fournit le serveur d'aperçu HTTP local (`PreviewServer.js`) et le service d'exploration SQLite (`DataStudioService.js`).
   - Applique le contrôle de licence centralisé (`LicenseManager.js`).

2. **Preload Sandboxé (`src/preload/preload.js`)** :
   - Expose `window.api` via `contextBridge.exposeInMainWorld` en filtrant les canaux IPC autorisés par liste blanche.

3. **Processus Renderer (`src/renderer/`)** :
   - Interface utilisateur native ES Modules sans framework tiers, design system Glassmorphisme (`styles/`).
   - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, Content Security Policy stricte.

4. **Moteur Python (`engine/`)** :
   - Processus autonome communiquant en JSON Lines (`protocol.py`).
   - Architecture modulaire extensible (`Module` / `ModuleRegistry`), dont `WebCloneModule` (`CloneJob`) est l'implémentation du Module 1.
   - Utilise Playwright (Chromium headless) pour le rendu DOM complet, l'interception d'assets (`AssetStore`) et le sniffing XHR/Fetch (`NetworkSniffer`).
   - Génère le schéma relationnel (`SchemaInferrer`), les scripts SQL (`SqlGenerator` : MySQL 8 + SQLite) et le backend PHP 8 PDO (`PhpGenerator`).

---

## 2. Sécurité et Isolation SQL / IPC

- **Validation IPC** : Chaque canal enregistré dans `IpcRouter.js` vérifie les types, plages numériques, longueurs de chaînes et formats d'URL avant d'appeler un service.
- **Requêtes SQL 100 % préparées** : Toutes les valeurs passent par des paramètres liés (`?`). Dans le Data Studio, les noms dynamiques de tables et de colonnes sont systématiquement vérifiés contre le catalogue réel de SQLite (`sqlite_master` et `PRAGMA table_info`) avant d'être entourés de guillemets doubles échappés (`"nom"`).

---

## 3. Système de Licence (`LicenseManager.js`) et Extensibilité Future

Actuellement, `LicenseManager.js` est en mode **préparé mais inactif** (renvoie toujours `valid` / `full`). Toutes les vérifications passent par une unique porte d'entrée (`licenseManager.guard(feature)`), appelée au démarrage de `main.js` et avant chaque exécution de `clone.start` ou d'ouverture d'un module.

### Comment brancher une vraie vérification de licence plus tard sans modifier le reste de l'application :

1. **Clé signée asymétrique (Ed25519 / RSA-PSS)** :
   - Embarquer uniquement la **clé publique** dans `LicenseManager.js` via le module natif `node:crypto`.
   - Une clé de licence fournie par l'utilisateur aura le format `UC1.<payload_base64url>.<signature_base64url>`, où `payload` contient `{ plan, features, machineIdHash, issuedAt, expiresAt }`.
   - Dans `activate(key)`, vérifier la signature cryptographique avec `crypto.verify(null, payloadBuffer, publicKey, signatureBuffer)`.

2. **Empreinte Machine (`machineId`)** :
   - Calculer un hash SHA-256 stable à partir de l'identifiant système (`/etc/machine-id` sous Linux, `MachineGuid` du registre sous Windows) salé avec l'identifiant de l'application.
   - Comparer ce hash avec `payload.machineIdHash` pour lier la licence au poste.

3. **Fonctionnement hors-ligne avec échéance** :
   - Stocker le jeton signé (ou son empreinte + métadonnées vérifiées) dans la table `license_state` de SQLite.
   - Dans `check()`, vérifier la signature locale et comparer `expiresAt` à l'horloge locale (en vérifiant que `checked_at` ne recule pas dans le temps pour éviter le recul d'horloge).
   - Mettre à jour la table `FEATURES` selon `payload.plan` pour activer/désactiver sélectivement `clone_web`, `backend_gen`, `data_studio`, `clone_apk`, `clone_exe`.

---

## 4. Extensibilité Multi-Modules (`Module` / `ModuleRegistry`)

Le moteur Python définit dans `engine/models.py` et `engine/engine.py` :
- `Module` (classe abstraite) : propriétés `name`, `supported_inputs`, méthode `run(params, emitter, cancel_event, pause_event)`.
- `ModuleRegistry` : registre central où est enregistré `WebCloneModule` (`web_clone`) et où seront enregistrés plus tard `ApkCloneModule` (`apk_clone`) et `ExeCloneModule` (`exe_clone`).
- Côté Node.js, la table des modules et le canal IPC `modules:list` exposent l'état de disponibilité de chaque module à l'interface.

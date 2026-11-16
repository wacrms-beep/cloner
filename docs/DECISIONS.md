# Journal des Décisions Techniques (`DECISIONS.md`)

Ce document consigne les choix d'architecture et de sécurité retenus lorsque plusieurs approches étaient possibles.

1. **Exécution SQLite duale (Electron + Node.js CLI/Tests)** :
   - `better-sqlite3` est un addon natif C++. Lorsqu'il est compilé pour Electron (`electron-rebuild`), son ABI Node peut différer de celle du binaire `node` système utilisé par `npm test` ou `npm run check`.
   - **Décision** : Fournir dans `Database.js` un chargeur résilient qui utilise `better-sqlite3` par défaut et bascule automatiquement sur `node:sqlite` (`DatabaseSync` intégré à Node 22+/24+) si l'ABI de `better-sqlite3` est compilée pour Electron lors de l'exécution des tests Node hors Electron, tout en compilant `better-sqlite3` pour Electron lors du démarrage d'Electron. Ainsi `npm test`, `npm run check` et `npm start` fonctionnent tous sans friction.

2. **Génération de `preview.sqlite` côté Moteur Python** :
   - Python dispose nativement du module `sqlite3`. `SqlGenerator` crée simultanément `database.sql` (dialecte MySQL 8 `utf8mb4` InnoDB pour Alwaysdata) et `preview.sqlite` (fichier SQLite local peuplé avec les mêmes tables et données d'échantillon issues du sniffer XHR/Fetch).
   - Même lorsqu'un site statique (ex. `quotes.toscrape.com` classique sans `/scroll`) n'émet aucun appel XHR/Fetch JSON, `SqlGenerator` génère un fichier `preview.sqlite` valide contenant une table de métadonnées `clone_metadata` (et le cas échéant les éléments extraits) afin que le bouton « Data Studio (preview.sqlite) » soit toujours fonctionnel à la fin d'un job.

3. **Réécriture des chemins de pages HTML (`HtmlProcessor` & `UrlRewriter`)** :
   - Chaque page HTML (ex. `/page/2/` ou `/about.html`) est sauvegardée sous forme de dossier avec un `index.html` (`site/page/2/index.html` ou `site/about.html/index.html`, ou fichier `.html` direct si extension explicite, normalisé de façon cohérente dans `UrlRewriter`).
   - **Décision** : Normaliser systématiquement toutes les pages HTML en `site/<chemin_sans_index>/index.html` (et `site/index.html` pour la racine `/`). Cela garantit que les URLs avec ou sans slash final fonctionnent de manière identique sur `PreviewServer` comme sur un serveur Apache/Nginx statique, et rend le calcul de `posix.relpath` déterministe depuis le dossier de la page courante.

4. **Transaction annulable de 5 secondes pour la suppression dans Data Studio** :
   - Le cahier des charges demande une suppression avec confirmation + annulation possible pendant 5 secondes.
   - **Décision** : Lorsqu'une ligne est supprimée dans `DataStudioService.deleteRow`, le service lit d'abord la ligne complète via une requête préparée, la stocke dans un tampon d'annulation en mémoire (avec un jeton `undoToken` valable 10 s côté serveur, affiché 5 s dans l'interface avec bouton « Annuler »), exécute le `DELETE` préparé dans une transaction, et permet une restauration transactionnelle exacte (`INSERT` préparé avec les valeurs d'origine) via `studio:undoDelete` si l'utilisateur clique sur « Annuler ».

5. **Validation des URLs dans `HomeView` et `IpcRouter`** :
   - Par sécurité (prévention SSRF locale), seules les URLs `http:` et `https:` sont acceptées. Les hôtes `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` et `::1` sont refusés par défaut, sauf si le paramètre `allowLocalNetwork` est explicitement activé dans les réglages ou pour les tests locaux contrôlés.

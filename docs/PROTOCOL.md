# Protocole de Communication Electron ↔ Python (`JSON Lines`)

## 1. Principes de transport

- Le processus Node.js (`EngineBridge.js`) lance `engine/engine.py` via `child_process.spawn`.
- Encodage : **UTF-8**, séparateur de messages : `\n` (une ligne JSON valide par message).
- **`stdout` du processus Python** : réservé **exclusivement** aux messages JSON du protocole. Toute écriture est protégée par un verrou (`threading.Lock`) et suivie d'un `flush()` immédiat.
- **`stderr` du processus Python** : réservé aux traces techniques et journaux de débogage interceptés par `Logger.js`.

---

## 2. Commandes (Node.js → Python via `stdin`)

Chaque commande possède un identifiant unique `id` (UUID v4) permettant de corréler l'accusé de réception (`ack`).

### 2.1 `ping`
Vérifie la réactivité du moteur (envoyé toutes les 10 s par le heartbeat).
```json
{"id": "550e8400-e29b-41d4-a716-446655440000", "cmd": "ping"}
```

### 2.2 `clone.start`
Démarre une tâche de clonage web.
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "cmd": "clone.start",
  "params": {
    "cloneId": 1,
    "url": "https://quotes.toscrape.com",
    "outputDir": "/chemin/vers/output/quotes.toscrape.com_20261114-1800",
    "options": {
      "max_depth": 2,
      "max_pages": 50,
      "same_domain_only": true,
      "include_subdomains": false,
      "viewport": "1440x900",
      "mobile_emulation": false,
      "user_agent": null,
      "wait_strategy": "networkidle",
      "extra_wait_ms": 1500,
      "scroll_to_bottom": true,
      "scroll_steps": 8,
      "respect_robots": true,
      "request_delay_ms": 300,
      "concurrency": 4,
      "max_asset_mb": 50,
      "max_total_mb": 1500,
      "strip_trackers": true,
      "sniff_api": true,
      "generate_backend": true,
      "sample_limit_per_endpoint": 20,
      "timeout_s": 45
    }
  }
}
```

### 2.3 `clone.pause`
Met en pause la tâche active entre deux étapes ou pages.
```json
{"id": "550e8400-e29b-41d4-a716-446655440002", "cmd": "clone.pause"}
```

### 2.4 `clone.resume`
Reprend la tâche en pause.
```json
{"id": "550e8400-e29b-41d4-a716-446655440003", "cmd": "clone.resume"}
```

### 2.5 `clone.cancel`
Annule proprement la tâche en cours et ferme immédiatement le navigateur Chromium.
```json
{"id": "550e8400-e29b-41d4-a716-446655440004", "cmd": "clone.cancel"}
```

### 2.6 `shutdown`
Demande l'arrêt propre du moteur Python.
```json
{"id": "550e8400-e29b-41d4-a716-446655440005", "cmd": "shutdown"}
```

---

## 3. Événements (Python → Node.js via `stdout`)

### 3.1 `ready`
Émis dès que le moteur Python est initialisé.
```json
{"type": "ready", "version": "1.0.0"}
```

### 3.2 `ack`
Accusé de réception d'une commande `cmd`.
```json
{"type": "ack", "id": "550e8400-e29b-41d4-a716-446655440000", "status": "ok"}
```

### 3.3 `log`
Entrée de journal horodatée et associée à une phase.
```json
{
  "type": "log",
  "cloneId": 1,
  "level": "info",
  "phase": "crawl",
  "message": "Page aspirée : https://quotes.toscrape.com/",
  "data": {"status": 200}
}
```

### 3.4 `progress`
Progression globale (0 à 100 %) et par phase (`prepare`, `crawl`, `network`, `schema`, `backend`, `package`).
```json
{
  "type": "progress",
  "cloneId": 1,
  "phase": "crawl",
  "percent": 32.5,
  "detail": "Aspiration page 4/10"
}
```

### 3.5 `stat`
Compteurs en temps réel du job.
```json
{
  "type": "stat",
  "cloneId": 1,
  "pages": 4,
  "assets": 18,
  "bytes": 412900,
  "endpoints": 1,
  "tables": 2
}
```

### 3.6 `page`
Notification d'une page HTML enregistrée localement.
```json
{
  "type": "page",
  "cloneId": 1,
  "url": "https://quotes.toscrape.com/page/2/",
  "localPath": "site/page/2/index.html",
  "status": 200,
  "title": "Quotes to Scrape",
  "depth": 1
}
```

### 3.7 `endpoint`
Notification d'un endpoint API XHR/Fetch capturé et normalisé.
```json
{
  "type": "endpoint",
  "cloneId": 1,
  "method": "GET",
  "normalizedPath": "/api/quotes",
  "sampleUrl": "https://quotes.toscrape.com/api/quotes?page=1",
  "requestExample": {"query": {"page": ["1"]}, "body": null},
  "responseExample": {"has_next": true, "page": 1, "quotes": []},
  "statusCode": 200,
  "contentType": "application/json",
  "hits": 3
}
```

### 3.8 `result`
Fin normale du clonage avec les chemins produits et le résumé.
```json
{
  "type": "result",
  "cloneId": 1,
  "outputDir": "/chemin/output/quotes.toscrape.com_20261114-1800",
  "zipPath": "/chemin/output/quotes.toscrape.com_20261114-1800.zip",
  "summary": {
    "pages": 10,
    "assets": 22,
    "bytes": 524100,
    "endpoints": 1,
    "tables": 2,
    "tableSpecs": []
  }
}
```

### 3.9 `error`
Erreur non fatale (`fatal: false`) ou fatale (`fatal: true`, arrêtant le job).
```json
{
  "type": "error",
  "cloneId": 1,
  "code": "ROBOTS_DISALLOWED",
  "message": "Accès refusé par robots.txt pour cette URL.",
  "fatal": true
}
```

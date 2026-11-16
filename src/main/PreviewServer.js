/**
 * Mini serveur HTTP local statique pour l'aperçu hors-ligne d'un clone (site/).
 * Écoute uniquement sur 127.0.0.1 sur un port éphémère libre.
 * Protégé contre toute traversée de répertoire (path traversal).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8'
});

class PreviewServer {
  constructor(logger = null) {
    this.logger = logger;
    this.server = null;
    this.currentRoot = null;
    this.currentCloneRoot = null;
    this.port = null;
    this.mockEndpoints = new Map();
  }

  /**
   * Démarre ou recycle le serveur HTTP local sur le dossier site/ du clone.
   * Simule également les réponses JSON de ./backend/index.php à partir de preview.sqlite ou des endpoints capturés
   * pour que l'aperçu local fonctionne immédiatement sans nécessiter de serveur Apache/MySQL externe.
   * @param {string} cloneOutputDir Dossier racine du clone (contenant site/)
   * @param {Array} [endpoints] Liste optionnelle d'endpoints capturés pour l'aperçu API
   */
  async start(cloneOutputDir, endpoints = []) {
    await this.stop();

    const resolvedCloneDir = path.resolve(cloneOutputDir);
    const siteDir = path.join(resolvedCloneDir, 'site');
    if (!fs.existsSync(siteDir)) {
      throw new Error(`Le dossier site/ est introuvable dans ${resolvedCloneDir}`);
    }

    this.currentCloneRoot = resolvedCloneDir;
    this.currentRoot = siteDir;
    this.mockEndpoints.clear();
    for (const ep of endpoints || []) {
      if (ep.normalized_path && ep.responseExample) {
        this.mockEndpoints.set(ep.normalized_path, ep.responseExample);
      }
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));
      this.server.on('error', (err) => reject(err));
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = addr.port;
        const url = `http://127.0.0.1:${this.port}/`;
        if (this.logger) {
          this.logger.info('PreviewServer', `Serveur d'aperçu démarré sur ${url}`, { siteDir });
        }
        resolve({ url, port: this.port, siteDir });
      });
    });
  }

  async stop() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        this.port = null;
        resolve();
      });
    });
  }

  _handleRequest(req, res) {
    try {
      const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port || 80}`);
      const pathname = decodeURIComponent(parsedUrl.pathname);

      // Gestion du shim API local (/backend/index.php ou /api/...)
      if (pathname.startsWith('/backend/index.php') || pathname.startsWith('/api/')) {
        const targetRoute = parsedUrl.searchParams.get('__route') || pathname.replace(/^\/backend\/index\.php/, '') || pathname;
        const payload = this._resolveApiPreview(targetRoute);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(payload));
        return;
      }

      // Protection stricte contre la traversée de dossier
      const normalizedRel = pathname.replace(/^\/+/, '');
      let candidatePath = path.resolve(this.currentRoot, normalizedRel);
      if (!candidatePath.startsWith(this.currentRoot)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Accès interdit');
        return;
      }

      if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
        candidatePath = path.join(candidatePath, 'index.html');
      } else if (!fs.existsSync(candidatePath) && fs.existsSync(`${candidatePath}.html`)) {
        candidatePath = `${candidatePath}.html`;
      } else if (!fs.existsSync(candidatePath) && fs.existsSync(path.join(candidatePath, 'index.html'))) {
        candidatePath = path.join(candidatePath, 'index.html');
      }

      if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Fichier non trouvé dans le clone local');
        return;
      }

      const ext = path.extname(candidatePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(candidatePath).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Erreur interne du serveur d’aperçu');
    }
  }

  _resolveApiPreview(routePath) {
    const cleanRoute = routePath.split('?')[0];
    if (this.mockEndpoints.has(cleanRoute)) {
      return this.mockEndpoints.get(cleanRoute);
    }
    for (const [normPath, sample] of this.mockEndpoints.entries()) {
      const regexStr = '^' + normPath.replace(/\{[^}]+\}/g, '[^/]+') + '$';
      if (new RegExp(regexStr).test(cleanRoute)) {
        return sample;
      }
    }
    return { status: 'ok', offline_preview: true, route: cleanRoute, data: [] };
  }
}

module.exports = { PreviewServer };

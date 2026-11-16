/**
 * Gestion sécurisée des dossiers de sortie des clones (création horodatée,
 * vérification de chemin contre le path traversal, suppression sécurisée, ouverture shell).
 */
const fs = require('node:fs');
const path = require('node:path');

class ProjectFileService {
  /**
   * @param {import('./SettingsService').SettingsService} settingsService
   * @param {import('./Logger').Logger} [logger]
   */
  constructor(settingsService, logger = null) {
    this.settingsService = settingsService;
    this.logger = logger;
  }

  /**
   * Prépare un dossier de sortie dédié pour un clone : <baseDir>/<domaine>_<AAAAMMJJ-HHMMSS>/
   */
  prepareCloneOutputDir(domain, customBaseDir = null) {
    const baseDir = customBaseDir || this.settingsService.getAll().outputDir;
    fs.mkdirSync(baseDir, { recursive: true });

    const safeDomain = String(domain || 'site')
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '_')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 80) || 'site';

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const folderName = `${safeDomain}_${stamp}`;
    const fullPath = path.resolve(baseDir, folderName);

    // Vérification que fullPath est bien à l'intérieur de baseDir
    const resolvedBase = path.resolve(baseDir);
    if (!fullPath.startsWith(resolvedBase + path.sep)) {
      throw new Error('Chemin de sortie invalide (tentative de sortie du dossier parent).');
    }

    fs.mkdirSync(fullPath, { recursive: true });
    return fullPath;
  }

  /**
   * Supprime les fichiers d'un clone (dossier et archive .zip) après vérification de sécurité.
   */
  deleteCloneArtifacts(outputDir, zipPath) {
    const baseDir = path.resolve(this.settingsService.getAll().outputDir);

    if (outputDir) {
      const resolvedOut = path.resolve(outputDir);
      if (resolvedOut.startsWith(baseDir + path.sep) && fs.existsSync(resolvedOut)) {
        fs.rmSync(resolvedOut, { recursive: true, force: true });
      }
    }

    if (zipPath) {
      const resolvedZip = path.resolve(zipPath);
      if (resolvedZip.startsWith(baseDir + path.sep) && fs.existsSync(resolvedZip)) {
        fs.rmSync(resolvedZip, { force: true });
      }
    }
    return true;
  }

  /**
   * Retourne le chemin vers la miniature d'un clone (en data URL base64 pour la CSP) si elle existe.
   */
  getThumbnailDataUrl(outputDir) {
    if (!outputDir) return null;
    const thumbPath = path.join(outputDir, 'thumbnail.png');
    if (!fs.existsSync(thumbPath)) return null;
    try {
      const buf = fs.readFileSync(thumbPath);
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch (_) {
      return null;
    }
  }
}

module.exports = { ProjectFileService };

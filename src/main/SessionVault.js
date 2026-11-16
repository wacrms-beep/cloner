/**
 * SessionVault : coffre-fort local de chiffrement pour tokens Gmail, cookies,
 * storage_state Playwright et mots de passe de comptes tests (Modules 1B & 1C).
 *
 * Utilise l'API Electron `safeStorage` lorsque disponible et active (trousseau OS :
 * DPAPI sous Windows, Keychain sous macOS, libsecret/kwallet sous Linux).
 * En environnement de test CLI Node.js ou sur un système Linux headless sans trousseau,
 * bascule sur un chiffrement authentifié AES-256-GCM (node:crypto) avec clé maître
 * dérivée et stockée en permissions 0600 dans userData/vault/.master.key.
 *
 * Aucun secret n'est jamais écrit en clair sur le disque ni dans les journaux.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function getElectronSafeStorage() {
  try {
    const electron = require('electron');
    if (electron && electron.safeStorage && typeof electron.safeStorage.isEncryptionAvailable === 'function') {
      if (electron.safeStorage.isEncryptionAvailable()) {
        return electron.safeStorage;
      }
    }
  } catch (_) {
    // Hors processus Electron
  }
  return null;
}

class SessionVault {
  /**
   * @param {object} options
   * @param {string} options.vaultDir Dossier de stockage chiffré (ex: userData/vault)
   * @param {object} [options.safeStorage] Injection optionnelle pour les tests
   * @param {import('./Logger').Logger} [options.logger]
   */
  constructor(options = {}) {
    this.vaultDir = options.vaultDir || path.join(process.cwd(), '.vault');
    this.safeStorage = options.safeStorage !== undefined ? options.safeStorage : getElectronSafeStorage();
    this.logger = options.logger || null;

    fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
    this._masterKey = null;
  }

  /**
   * Retourne ou initialise la clé AES-256 de repli lorsque safeStorage OS n'est pas actif.
   */
  _getFallbackKey() {
    if (this._masterKey) return this._masterKey;
    const keyPath = path.join(this.vaultDir, '.master.key');
    if (fs.existsSync(keyPath)) {
      const raw = fs.readFileSync(keyPath);
      if (raw.length === 32) {
        this._masterKey = raw;
        return this._masterKey;
      }
    }
    const generated = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, generated, { mode: 0o600 });
    this._masterKey = generated;
    return this._masterKey;
  }

  /**
   * Chiffre une chaîne UTF-8 et retourne une chaîne encodée (préfixée par le mode).
   * @param {string} plainText
   * @returns {string}
   */
  encryptString(plainText) {
    const str = String(plainText ?? '');
    if (this.safeStorage && typeof this.safeStorage.encryptString === 'function') {
      try {
        const buf = this.safeStorage.encryptString(str);
        return `ss1:${buf.toString('base64')}`;
      } catch (_) {
        // Repli AES-256-GCM
      }
    }

    const key = this._getFallbackKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `gcm1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  /**
   * Déchiffre une chaîne produite par encryptString.
   * @param {string} cipherText
   * @returns {string}
   */
  decryptString(cipherText) {
    const raw = String(cipherText || '');
    if (!raw) throw new Error('Données chiffrées vides.');

    if (raw.startsWith('ss1:')) {
      if (!this.safeStorage || typeof this.safeStorage.decryptString !== 'function') {
        throw new Error('safeStorage Electron requis pour déchiffrer cette entrée.');
      }
      const buf = Buffer.from(raw.slice(4), 'base64');
      return this.safeStorage.decryptString(buf);
    }

    if (raw.startsWith('gcm1:')) {
      const parts = raw.split(':');
      if (parts.length !== 4) {
        throw new Error('Format de jeton chiffré invalide.');
      }
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const data = Buffer.from(parts[3], 'base64');
      const key = this._getFallbackKey();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
      return decrypted.toString('utf8');
    }

    throw new Error('Schéma de chiffrement non reconnu.');
  }

  /**
   * Construit un chemin de fichier sécurisé pour un type ('gmail', 'cookies', 'signup_auto', 'manual')
   * et un identifiant logique.
   */
  _resolveFilePath(type, key) {
    const safeType = String(type || 'session').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    const safeKey = String(key || 'default').replace(/[^a-z0-9._-]/gi, '_').toLowerCase();
    return path.join(this.vaultDir, `${safeType}__${safeKey}.enc`);
  }

  /**
   * Sauvegarde un objet JSON chiffré dans le coffre-fort.
   * @param {string} type Ex: 'gmail', 'cookies', 'signup_auto', 'manual'
   * @param {string} key Identifiant (ex: 'oauth_tokens' ou domaine)
   * @param {object} payload Objet à sérialiser et chiffrer
   * @returns {string} Clé de coffre (vaultKey = `${type}:${key}`)
   */
  store(type, key, payload) {
    const filePath = this._resolveFilePath(type, key);
    const json = JSON.stringify(payload ?? {});
    const encrypted = this.encryptString(json);
    fs.writeFileSync(filePath, encrypted, { encoding: 'utf8', mode: 0o600 });
    return `${type}:${key}`;
  }

  /**
   * Charge et déchiffre un objet JSON depuis le coffre-fort.
   * @param {string} typeOrVaultKey Soit 'gmail', soit 'gmail:oauth_tokens'
   * @param {string} [key]
   * @returns {object|null}
   */
  load(typeOrVaultKey, key = null) {
    let type = typeOrVaultKey;
    let targetKey = key;
    if (targetKey === null && String(typeOrVaultKey).includes(':')) {
      const idx = String(typeOrVaultKey).indexOf(':');
      type = typeOrVaultKey.slice(0, idx);
      targetKey = typeOrVaultKey.slice(idx + 1);
    }
    const filePath = this._resolveFilePath(type, targetKey || 'default');
    if (!fs.existsSync(filePath)) return null;
    const encrypted = fs.readFileSync(filePath, 'utf8');
    const json = this.decryptString(encrypted);
    return JSON.parse(json);
  }

  /**
   * Supprime définitivement un fichier chiffré du coffre-fort.
   */
  remove(typeOrVaultKey, key = null) {
    let type = typeOrVaultKey;
    let targetKey = key;
    if (targetKey === null && String(typeOrVaultKey).includes(':')) {
      const idx = String(typeOrVaultKey).indexOf(':');
      type = typeOrVaultKey.slice(0, idx);
      targetKey = typeOrVaultKey.slice(idx + 1);
    }
    const filePath = this._resolveFilePath(type, targetKey || 'default');
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      return true;
    }
    return false;
  }

  /**
   * Vérifie si une entrée existe dans le coffre-fort.
   */
  exists(typeOrVaultKey, key = null) {
    let type = typeOrVaultKey;
    let targetKey = key;
    if (targetKey === null && String(typeOrVaultKey).includes(':')) {
      const idx = String(typeOrVaultKey).indexOf(':');
      type = typeOrVaultKey.slice(0, idx);
      targetKey = typeOrVaultKey.slice(idx + 1);
    }
    const filePath = this._resolveFilePath(type, targetKey || 'default');
    return fs.existsSync(filePath);
  }
}

module.exports = { SessionVault };

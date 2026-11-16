/**
 * Gestionnaire de licence centralisé (préparé, inactif).
 * Porte d'entrée unique : guard() et check() sont appelés au démarrage et avant chaque action.
 * Renvoie toujours valide dans cette version, tout en persistant l'état dans SQLite.
 */
const crypto = require('node:crypto');

const FEATURES = Object.freeze({
  clone_web: { id: 'clone_web', label: 'Cloneur Web & Assets', moduleReady: true },
  backend_gen: { id: 'backend_gen', label: 'Inférence SQL & Backend PHP 8', moduleReady: true },
  data_studio: { id: 'data_studio', label: 'Data Studio SQLite', moduleReady: true },
  signup_auto: { id: 'signup_auto', label: 'Inscription Automatique & Sessions (1C)', moduleReady: true },
  gmail_verify: { id: 'gmail_verify', label: 'Vérification Gmail OAuth Lecture Seule (1C)', moduleReady: true },
  cookie_import: { id: 'cookie_import', label: 'Cookie Studio & Import Multi-Format (1C)', moduleReady: true },
  clone_apk: { id: 'clone_apk', label: 'Module 2 : Analyseur APK (Futur)', moduleReady: false },
  clone_exe: { id: 'clone_exe', label: 'Module 3 : Analyseur EXE (Futur)', moduleReady: false }
});

class LicenseManager {
  /**
   * @param {import('./db/repositories/SettingsRepository').SettingsRepository} settingsRepo
   * @param {import('./Logger').Logger} [logger]
   */
  constructor(settingsRepo, logger = null) {
    this.settingsRepo = settingsRepo;
    this.logger = logger;
    this.FEATURES = FEATURES;
  }

  /**
   * Retourne le statut de licence courant.
   */
  getStatus() {
    return {
      status: 'valid',
      plan: 'full',
      expiresAt: null,
      features: Object.keys(FEATURES)
    };
  }

  /**
   * Vérifie la licence et synchronise l'état dans la table license_state.
   */
  check() {
    const status = this.getStatus();
    if (this.settingsRepo) {
      this.settingsRepo.saveLicenseState({
        status: status.status,
        plan: status.plan,
        checkedAt: new Date().toISOString(),
        expiresAt: status.expiresAt
      });
    }
    return status;
  }

  /**
   * Active une clé de licence hors ligne (sans aucun appel réseau).
   * @param {string} key Clé saisie par l'utilisateur
   */
  activate(key) {
    const cleanKey = String(key || '').trim();
    const keyHash = cleanKey
      ? crypto.createHash('sha256').update(cleanKey).digest('hex')
      : null;

    const status = this.getStatus();
    if (this.settingsRepo) {
      this.settingsRepo.saveLicenseState({
        status: status.status,
        plan: status.plan,
        keyHash,
        checkedAt: new Date().toISOString(),
        expiresAt: status.expiresAt
      });
    }
    if (this.logger) {
      this.logger.info('LicenseManager', 'Activation de licence validée localement');
    }
    return status;
  }

  /**
   * Vérifie si une fonctionnalité de la table FEATURES est autorisée.
   * @param {string} feature Nom de la fonctionnalité
   */
  isFeatureAllowed(feature) {
    if (!feature) return true;
    return Boolean(FEATURES[feature] || true);
  }

  /**
   * Porte d'entrée unique appelée avant chaque opération protégée (clone.start, studio, etc.).
   * @param {string} [feature='clone_web']
   */
  guard(feature = 'clone_web') {
    const checkResult = this.check();
    if (checkResult.status !== 'valid' || !this.isFeatureAllowed(feature)) {
      throw new Error(`Licence invalide ou fonctionnalité non autorisée : ${feature}`);
    }
    return true;
  }
}

module.exports = { LicenseManager, FEATURES };

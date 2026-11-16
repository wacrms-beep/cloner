/**
 * Service de gestion des réglages utilisateur avec valeurs par défaut sûres.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

class SettingsService {
  /**
   * @param {import('./db/repositories/SettingsRepository').SettingsRepository} settingsRepo
   * @param {object} paths Chemins système ({ defaultOutputDir, rootDir })
   */
  constructor(settingsRepo, paths = {}) {
    this.settingsRepo = settingsRepo;
    this.rootDir = paths.rootDir || path.resolve(__dirname, '../..');
    this.defaultOutputDir = paths.defaultOutputDir || path.join(this.rootDir, 'output');
    fs.mkdirSync(this.defaultOutputDir, { recursive: true });
  }

  getDefaults() {
    return {
      outputDir: this.defaultOutputDir,
      theme: 'light',
      concurrency: 4,
      pythonPath: this.detectPythonPath(),
      respectRobots: true,
      allowLocalNetwork: false,
      gmailClientId: '',
      gmailClientSecret: '',
      maxAccountsPerDay: 3,
      signupTermsAccepted: false,
      defaultCloneOptions: {
        max_depth: 2,
        max_pages: 50,
        same_domain_only: true,
        include_subdomains: false,
        viewport: '1440x900',
        mobile_emulation: false,
        user_agent: null,
        wait_strategy: 'networkidle',
        extra_wait_ms: 1500,
        scroll_to_bottom: true,
        scroll_steps: 8,
        respect_robots: true,
        request_delay_ms: 300,
        concurrency: 4,
        max_asset_mb: 50,
        max_total_mb: 1500,
        strip_trackers: true,
        sniff_api: true,
        generate_backend: true,
        sample_limit_per_endpoint: 20,
        timeout_s: 45
      }
    };
  }

  getAll() {
    const defaults = this.getDefaults();
    const stored = this.settingsRepo.getAll();
    return {
      ...defaults,
      ...stored,
      defaultCloneOptions: {
        ...defaults.defaultCloneOptions,
        ...(stored.defaultCloneOptions || {})
      }
    };
  }

  update(partial) {
    const allowedKeys = [
      'outputDir',
      'theme',
      'concurrency',
      'pythonPath',
      'respectRobots',
      'allowLocalNetwork',
      'gmailClientId',
      'gmailClientSecret',
      'maxAccountsPerDay',
      'signupTermsAccepted',
      'defaultCloneOptions'
    ];
    for (const [k, v] of Object.entries(partial || {})) {
      if (allowedKeys.includes(k) && v !== undefined) {
        this.settingsRepo.set(k, v);
      }
    }
    return this.getAll();
  }

  detectPythonPath() {
    const custom = this.settingsRepo ? this.settingsRepo.get('pythonPath', null) : null;
    if (custom && fs.existsSync(custom)) {
      return custom;
    }

    const isWin = process.platform === 'win32';
    // 1. Binaire embarqué en production (extraResources)
    if (process.resourcesPath) {
      const prodBin = path.join(
        process.resourcesPath,
        'engine',
        '.venv',
        isWin ? 'Scripts' : 'bin',
        isWin ? 'python.exe' : 'python'
      );
      if (fs.existsSync(prodBin)) return prodBin;
    }

    // 2. Venv local de développement
    const devVenv = path.join(
      this.rootDir,
      '.venv',
      isWin ? 'Scripts' : 'bin',
      isWin ? 'python.exe' : 'python'
    );
    if (fs.existsSync(devVenv)) return devVenv;

    // 3. Python système
    return isWin ? 'python' : 'python3';
  }

  testPythonPath(candidatePath) {
    const target = candidatePath || this.detectPythonPath();
    try {
      const res = spawnSync(
        target,
        ['-c', 'import sys, playwright, bs4, lxml, tinycss2, tldextract; print(sys.version.split()[0])'],
        { encoding: 'utf8', timeout: 8000 }
      );
      if (res.status === 0) {
        return {
          ok: true,
          pythonPath: target,
          version: res.stdout.trim(),
          message: `Python ${res.stdout.trim()} opérationnel (Playwright + dépendances disponibles)`
        };
      }
      return {
        ok: false,
        pythonPath: target,
        version: null,
        message: (res.stderr || res.stdout || 'Erreur lors de la vérification Python').trim()
      };
    } catch (err) {
      return {
        ok: false,
        pythonPath: target,
        version: null,
        message: err.message
      };
    }
  }

  getLegalState() {
    return this.settingsRepo.getLegalAcceptance();
  }

  acceptLegal(appVersion = '1.0.0') {
    return this.settingsRepo.acceptLegal(appVersion);
  }
}

module.exports = { SettingsService };

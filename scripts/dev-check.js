/**
 * Script de diagnostic de l'environnement de développement (dev-check.js)
 * Vérifie Node.js, better-sqlite3, Python (.venv), les modules Python et Chromium.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const VENV_DIR = path.join(ROOT_DIR, '.venv');
const isWin = process.platform === 'win32';
const venvPython = path.join(VENV_DIR, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');

let hasErrors = false;

function report(label, ok, detail) {
  const badge = ok ? '[  OK  ]' : '[ERREUR]';
  console.log(`${badge} ${label.padEnd(32, ' ')} : ${detail}`);
  if (!ok) hasErrors = true;
}

console.log('=== Diagnostic Universal Clone ===\n');

// 1. Node.js
const nodeVer = process.version;
const major = parseInt(nodeVer.slice(1).split('.')[0], 10);
report('Node.js (>= 18)', major >= 18, nodeVer);

// 2. better-sqlite3 / AppDatabase
try {
  const { openSqliteConnection } = require('../src/main/db/Database');
  const db = openSqliteConnection(':memory:');
  const row = db.prepare('SELECT sqlite_version() AS v').get();
  db.close();
  const binaryPath = path.join(ROOT_DIR, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  const hasNative = fs.existsSync(binaryPath);
  report('SQLite (better-sqlite3)', hasNative, `SQLite v${row.v} (binaire Electron compilé)`);
} catch (err) {
  report('SQLite (better-sqlite3)', false, err.message.split('\n')[0]);
}

// 3. Python (.venv)
if (fs.existsSync(venvPython)) {
  const pyVer = spawnSync(venvPython, ['--version'], { encoding: 'utf8' });
  report('Python (.venv)', pyVer.status === 0, (pyVer.stdout || pyVer.stderr).trim());

  // 4. Modules Python
  const checkImport = spawnSync(
    venvPython,
    ['-c', 'import playwright, bs4, lxml, tinycss2, tldextract, pytest; print("Modules importés avec succès")'],
    { encoding: 'utf8' }
  );
  report('Dépendances Python', checkImport.status === 0, (checkImport.stdout || checkImport.stderr).trim().split('\n')[0]);

  // 5. Chromium Playwright
  const checkChromium = spawnSync(
    venvPython,
    ['-c', 'from playwright.sync_api import sync_playwright; p = sync_playwright().start(); b = p.chromium.launch(headless=True); v = b.version; b.close(); p.stop(); print(f"Chromium {v}")'],
    { encoding: 'utf8', timeout: 20000 }
  );
  report('Playwright Chromium', checkChromium.status === 0, (checkChromium.stdout || checkChromium.stderr).trim().split('\n')[0]);
} else {
  report('Python (.venv)', false, `Introuvable dans ${venvPython} (exécutez "npm run setup")`);
}

// 6. PHP (optionnel pour test du serveur généré)
const phpCheck = spawnSync('php', ['-v'], { encoding: 'utf8' });
if (phpCheck.status === 0) {
  report('PHP CLI (optionnel)', true, phpCheck.stdout.split('\n')[0]);
} else {
  console.log('[ INFO ] PHP CLI (optionnel)              : Non installé (non bloquant)');
}

console.log('\n==================================');
if (hasErrors) {
  console.error('Diagnostic échoué. Corrigez les erreurs ci-dessus.');
  process.exit(1);
} else {
  console.log('Tous les contrôles critiques sont validés.');
}

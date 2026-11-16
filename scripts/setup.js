/**
 * Script d'installation et de préparation de l'environnement Python (.venv)
 * Crée l'environnement virtuel, installe les paquets de engine/requirements.txt
 * et télécharge le navigateur Chromium pour Playwright.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const VENV_DIR = path.join(ROOT_DIR, '.venv');
const REQ_FILE = path.join(ROOT_DIR, 'engine', 'requirements.txt');
const isWin = process.platform === 'win32';

function findSystemPython() {
  const candidates = isWin ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const cmd of candidates) {
    const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (res.status === 0) {
      return cmd;
    }
  }
  throw new Error('Python 3.11+ est introuvable sur le système.');
}

function getVenvBin(tool) {
  const binDir = isWin ? 'Scripts' : 'bin';
  const ext = isWin ? '.exe' : '';
  return path.join(VENV_DIR, binDir, `${tool}${ext}`);
}

function runStep(title, cmd, args) {
  console.log(`\n[SETUP] ${title}...`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1' }
  });
  if (res.status !== 0) {
    throw new Error(`Échec de l'étape "${title}" (code ${res.status})`);
  }
}

function main() {
  console.log('=== Configuration de Universal Clone (Moteur Python) ===');
  const sysPython = findSystemPython();
  console.log(`[SETUP] Python système détecté : ${sysPython}`);

  if (!fs.existsSync( getVenvBin('python') )) {
    runStep('Création de l’environnement virtuel .venv', sysPython, ['-m', 'venv', VENV_DIR]);
  } else {
    console.log('[SETUP] Environnement virtuel .venv déjà présent.');
  }

  const venvPython = getVenvBin('python');

  runStep('Mise à jour de pip', venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
  runStep('Installation des dépendances Python', venvPython, ['-m', 'pip', 'install', '-r', REQ_FILE]);
  runStep('Installation de Chromium via Playwright', venvPython, ['-m', 'playwright', 'install', 'chromium']);

  console.log('\n[SETUP] Configuration terminée avec succès.');
}

try {
  main();
} catch (err) {
  console.error(`\n[SETUP ERREUR] ${err.message}`);
  process.exit(1);
}

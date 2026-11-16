/**
 * SettingsView : réglages de l'application :
 * - Dossier de sortie par défaut
 * - Thème (Clair, Sombre, Automatique)
 * - Concurrence par défaut
 * - Chemin Python (détection auto + bouton test)
 * - Vérification de l'état du moteur (bouton diagnostic ping)
 * - Section Licence (affiche « Actif ») et Modules disponibles.
 */
import { Api } from '../core/Api.js';
import { Toast } from '../core/Toast.js';
import { icon } from '../core/Icons.js';
import { createGlassCard } from '../components/GlassCard.js';
import { createChip } from '../components/Chip.js';

export class SettingsView {
  constructor(root, params, router) {
    this.root = root;
    this.router = router;
  }

  async mount() {
    const [settings, license, engineStatus, modules] = await Promise.all([
      Api.invoke('settings:get'),
      Api.invoke('license:status'),
      Api.invoke('engine:status'),
      Api.invoke('modules:list')
    ]);

    this.root.innerHTML = `
      <div style="padding:8px;">
        <h1>Réglages</h1>
        <div class="settings-grid" id="settings-grid"></div>
      </div>
    `;

    const grid = this.root.querySelector('#settings-grid');

    // 1. Carte Préférences générales
    const genCard = createGlassCard({ title: 'Préférences générales', cascade: true });
    genCard.innerHTML += `
      <div class="form-row">
        <span>Thème d’interface</span>
        <select id="set-theme" class="glass-input">
          <option value="light" ${settings.theme === 'light' ? 'selected' : ''}>Clair (Blanc)</option>
          <option value="dark" ${settings.theme === 'dark' ? 'selected' : ''}>Sombre</option>
          <option value="auto" ${settings.theme === 'auto' ? 'selected' : ''}>Automatique</option>
        </select>
      </div>
      <div class="form-row">
        <span>Concurrence par défaut</span>
        <input id="set-concurrency" type="number" min="1" max="16" class="glass-input" style="width:90px;" value="${settings.concurrency || 4}" />
      </div>
      <div class="form-row">
        <span>Dossier de sortie</span>
        <div style="display:flex;gap:6px;">
          <input id="set-outdir" type="text" class="glass-input" style="width:210px;" value="${settings.outputDir || ''}" />
          <button id="set-pick-dir" class="btn btn-secondary">${icon('folder')}</button>
        </div>
      </div>
    `;
    grid.appendChild(genCard);

    // 2. Carte Moteur Python & Diagnostic
    const engCard = createGlassCard({ title: 'Moteur Python & Chromium', cascade: true });
    engCard.innerHTML += `
      <div class="form-row">
        <span>État du processus</span>
        <span class="chip chip-${engineStatus.state === 'ready' ? 'success' : 'warn'}">${engineStatus.state} ${engineStatus.version ? `(v${engineStatus.version})` : ''}</span>
      </div>
      <div class="form-row">
        <span>Exécutable Python</span>
        <input id="set-python" type="text" class="glass-input mono" style="width:240px;font-size:12px;" value="${settings.pythonPath || ''}" />
      </div>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button id="btn-test-python" class="btn btn-secondary">${icon('check')} Tester Python</button>
        <button id="btn-ping-engine" class="btn btn-primary">${icon('refresh')} Diagnostic Ping</button>
      </div>
      <div id="diag-output" style="margin-top:10px;font-size:12.5px;color:var(--text-secondary);"></div>
    `;
    grid.appendChild(engCard);

    // 3. Carte Licence (§10)
    const licCard = createGlassCard({ title: 'Licence', cascade: true });
    licCard.innerHTML += `
      <div class="form-row">
        <span>Statut</span>
        <span class="chip chip-success">${icon('shield')} Actif (${license.plan.toUpperCase()})</span>
      </div>
      <div class="form-row">
        <span>Validité</span>
        <span>Permanente (Hors-ligne)</span>
      </div>
    `;
    grid.appendChild(licCard);

    // 4. Carte Modules (§11 Extensibilité)
    const modCard = createGlassCard({ title: 'Modules installés', cascade: true });
    for (const m of modules) {
      const row = document.createElement('div');
      row.className = 'form-row';
      row.innerHTML = `
        <div>
          <strong>${m.title}</strong>
          <div style="font-size:12px;color:var(--text-secondary);">${m.description}</div>
        </div>
      `;
      row.appendChild(createChip({
        label: m.status === 'active' ? 'Actif' : 'Prévu',
        variant: m.status === 'active' ? 'success' : 'default'
      }));
      modCard.appendChild(row);
    }
    grid.appendChild(modCard);

    // Événements
    const themeSel = genCard.querySelector('#set-theme');
    themeSel.addEventListener('change', async () => {
      const theme = themeSel.value;
      document.documentElement.setAttribute('data-theme', theme);
      await Api.invoke('settings:update', { theme });
      Toast.show('Thème mis à jour');
    });

    const concInput = genCard.querySelector('#set-concurrency');
    concInput.addEventListener('change', async () => {
      await Api.invoke('settings:update', { concurrency: Number(concInput.value) });
      Toast.show('Concurrence enregistrée');
    });

    const outInput = genCard.querySelector('#set-outdir');
    outInput.addEventListener('change', async () => {
      await Api.invoke('settings:update', { outputDir: outInput.value.trim() });
      Toast.show('Dossier de sortie enregistré');
    });

    genCard.querySelector('#set-pick-dir').addEventListener('click', async () => {
      const res = await Api.invoke('settings:pickDirectory');
      if (!res.canceled && res.path) {
        outInput.value = res.path;
        await Api.invoke('settings:update', { outputDir: res.path });
        Toast.show('Dossier de sortie mis à jour');
      }
    });

    const diagOut = engCard.querySelector('#diag-output');
    const pyInput = engCard.querySelector('#set-python');

    engCard.querySelector('#btn-test-python').addEventListener('click', async () => {
      diagOut.textContent = 'Vérification de Python et Playwright...';
      const res = await Api.invoke('settings:testPython', { pythonPath: pyInput.value.trim() });
      diagOut.textContent = res.message;
      if (res.ok) {
        await Api.invoke('settings:update', { pythonPath: res.pythonPath });
        Toast.show('Environnement Python validé');
      } else {
        Toast.show(res.message, { type: 'error' });
      }
    });

    engCard.querySelector('#btn-ping-engine').addEventListener('click', async () => {
      try {
        const res = await Api.invoke('engine:ping');
        diagOut.textContent = `Moteur prêt (PID ${res.pid}) — Latence ping/pong : ${res.latencyMs} ms`;
        Toast.show(`Pong reçu en ${res.latencyMs} ms`);
      } catch (err) {
        diagOut.textContent = `Erreur : ${err.message}`;
        Toast.show(err.message, { type: 'error' });
      }
    });
  }
}

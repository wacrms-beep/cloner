/**
 * JobView : suivi temps réel d'un clone et actions de fin :
 * - ProgressRing central animé
 * - StepTimeline (Préparation → Aspiration → Réseau → Schéma → Backend → Emballage)
 * - Compteurs (pages, assets, Mo, endpoints, tables) en Chips animés
 * - ConsolePanel repliable
 * - Boutons Pause / Reprendre / Annuler en cours
 * - Boutons Ouvrir dossier, Aperçu (PreviewServer), Data Studio (ouvre preview.sqlite), Ouvrir le .zip, Recloner à la fin.
 */
import { Api } from '../core/Api.js';
import { Toast } from '../core/Toast.js';
import { icon } from '../core/Icons.js';
import { ProgressRing } from '../components/ProgressRing.js';
import { StepTimeline, getPhaseLabel } from '../components/StepTimeline.js';
import { ConsolePanel } from '../components/ConsolePanel.js';
import { createChip } from '../components/Chip.js';

export class JobView {
  constructor(root, params, router) {
    this.root = root;
    this.cloneId = Number(params.cloneId);
    this.router = router;
    this.clone = null;
    this.unsubscribe = null;
  }

  async mount() {
    this.root.innerHTML = `<div class="job-layout" id="job-layout"></div>`;
    const layout = this.root.querySelector('#job-layout');

    // En-tête
    const topBar = document.createElement('div');
    topBar.style.display = 'flex';
    topBar.style.alignItems = 'center';
    topBar.style.justifyContent = 'space-between';

    this.titleEl = document.createElement('h1');
    this.titleEl.textContent = 'Chargement...';
    this.statusBadge = createChip({ label: 'Statut', value: '...' });

    topBar.appendChild(this.titleEl);
    topBar.appendChild(this.statusBadge);
    layout.appendChild(topBar);

    // Carte centrale avec ProgressRing, StepTimeline, Chips et boutons
    const centerCard = document.createElement('div');
    centerCard.className = 'job-center-panel glass-card-strong';

    this.ring = new ProgressRing({ size: 172, stroke: 12 });
    this.timeline = new StepTimeline();

    // Compteurs Chips
    const statsRow = document.createElement('div');
    statsRow.className = 'job-stats-row';
    this.chipPages = createChip({ label: 'Pages', value: 0 });
    this.chipAssets = createChip({ label: 'Assets', value: 0 });
    this.chipMb = createChip({ label: 'Mo', value: '0.0' });
    this.chipEndpoints = createChip({ label: 'Endpoints', value: 0 });
    this.chipTables = createChip({ label: 'Tables', value: 0 });
    statsRow.append(this.chipPages, this.chipAssets, this.chipMb, this.chipEndpoints, this.chipTables);

    this.actionsRow = document.createElement('div');
    this.actionsRow.className = 'job-actions-row';

    centerCard.append(this.ring.el, this.timeline.el, statsRow, this.actionsRow);
    layout.appendChild(centerCard);

    // Console temps réel
    this.consolePanel = new ConsolePanel();
    layout.appendChild(this.consolePanel.el);

    await this._loadInitialClone();

    this.unsubscribe = Api.onEngineEvent((evt) => {
      this._handleEngineEvent(evt);
    });
  }

  unmount() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  async _loadInitialClone() {
    try {
      this.clone = await Api.invoke('clone:get', { id: this.cloneId });
      this._syncUiFromClone(this.clone);
      this.consolePanel.setLogs(this.clone.logs || []);
    } catch (err) {
      Toast.show(err.message, { type: 'error' });
      this.router.navigate('home');
    }
  }

  _syncUiFromClone(c) {
    this.titleEl.textContent = c.domain || c.url;
    this.statusBadge.setValue(c.status);

    const isDone = c.status === 'done';
    const phaseLabel = isDone ? 'Terminé' : getPhaseLabel(c.current_phase);
    this.ring.update(c.progress || 0, phaseLabel);
    this.timeline.setPhase(c.current_phase || 'prepare', isDone);

    this.chipPages.setValue(c.pages_count || 0);
    this.chipAssets.setValue(c.assets_count || 0);
    const mb = ((c.assets_bytes || 0) / (1024 * 1024)).toFixed(2);
    this.chipMb.setValue(mb);
    this.chipEndpoints.setValue(c.endpoints_count || 0);
    this.chipTables.setValue(c.tables_count || 0);

    this._renderActionButtons(c);
  }

  _renderActionButtons(c) {
    this.actionsRow.innerHTML = '';

    if (c.status === 'running' || c.status === 'paused' || c.status === 'queued') {
      if (c.status === 'running') {
        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'btn btn-secondary';
        pauseBtn.innerHTML = `${icon('pause')} <span>Pause</span>`;
        pauseBtn.addEventListener('click', async () => {
          await Api.invoke('clone:pause');
          this.clone.status = 'paused';
          this._syncUiFromClone(this.clone);
        });
        this.actionsRow.appendChild(pauseBtn);
      } else if (c.status === 'paused') {
        const resumeBtn = document.createElement('button');
        resumeBtn.className = 'btn btn-primary';
        resumeBtn.innerHTML = `${icon('play')} <span>Reprendre</span>`;
        resumeBtn.addEventListener('click', async () => {
          await Api.invoke('clone:resume');
          this.clone.status = 'running';
          this._syncUiFromClone(this.clone);
        });
        this.actionsRow.appendChild(resumeBtn);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-danger';
      cancelBtn.innerHTML = `${icon('stop')} <span>Annuler</span>`;
      cancelBtn.addEventListener('click', async () => {
        await Api.invoke('clone:cancel', { cloneId: c.id });
        this.clone.status = 'cancelled';
        this._syncUiFromClone(this.clone);
        Toast.show('Tâche annulée proprement', { type: 'warn' });
      });
      this.actionsRow.appendChild(cancelBtn);
      return;
    }

    // Boutons de fin : Ouvrir dossier, Aperçu, Data Studio (preview.sqlite), Ouvrir .zip, Recloner
    if (c.output_dir) {
      const previewBtn = document.createElement('button');
      previewBtn.className = 'btn btn-primary';
      previewBtn.innerHTML = `${icon('eye')} <span>Aperçu</span>`;
      previewBtn.addEventListener('click', async () => {
        try {
          const res = await Api.invoke('clone:preview', { id: c.id, openBrowser: true });
          Toast.show(`Aperçu actif sur ${res.url}`, { type: 'info' });
        } catch (err) {
          Toast.show(err.message, { type: 'error' });
        }
      });

      const studioBtn = document.createElement('button');
      studioBtn.className = 'btn btn-secondary';
      studioBtn.innerHTML = `${icon('database')} <span>Data Studio</span>`;
      studioBtn.addEventListener('click', () => {
        this.router.navigate('studio', { cloneId: c.id });
      });

      const folderBtn = document.createElement('button');
      folderBtn.className = 'btn btn-secondary';
      folderBtn.innerHTML = `${icon('folder')} <span>Dossier</span>`;
      folderBtn.addEventListener('click', async () => {
        try {
          await Api.invoke('clone:openFolder', { id: c.id });
        } catch (err) {
          Toast.show(err.message, { type: 'error' });
        }
      });

      const zipBtn = document.createElement('button');
      zipBtn.className = 'btn btn-secondary';
      zipBtn.innerHTML = `${icon('archive')} <span>.ZIP</span>`;
      zipBtn.addEventListener('click', async () => {
        try {
          await Api.invoke('clone:openZip', { id: c.id });
        } catch (err) {
          Toast.show(err.message, { type: 'error' });
        }
      });

      this.actionsRow.append(previewBtn, studioBtn, folderBtn, zipBtn);
    }

    const recloneBtn = document.createElement('button');
    recloneBtn.className = 'btn btn-secondary';
    recloneBtn.innerHTML = `${icon('refresh')} <span>Recloner</span>`;
    recloneBtn.addEventListener('click', () => {
      this.router.navigate('home', { prefillUrl: c.url });
    });
    this.actionsRow.appendChild(recloneBtn);
  }

  _handleEngineEvent(evt) {
    if (!evt || Number(evt.cloneId) !== this.cloneId) return;

    if (evt.type === 'log') {
      this.consolePanel.appendLog(evt);
    } else if (evt.type === 'progress') {
      this.clone.current_phase = evt.phase || this.clone.current_phase;
      this.clone.progress = evt.percent ?? this.clone.progress;
      this.ring.update(this.clone.progress, evt.detail || getPhaseLabel(this.clone.current_phase));
      this.timeline.setPhase(this.clone.current_phase, false);
    } else if (evt.type === 'stat') {
      this.clone.pages_count = evt.pages ?? this.clone.pages_count;
      this.clone.assets_count = evt.assets ?? this.clone.assets_count;
      this.clone.assets_bytes = evt.bytes ?? this.clone.assets_bytes;
      this.clone.endpoints_count = evt.endpoints ?? this.clone.endpoints_count;
      this.clone.tables_count = evt.tables ?? this.clone.tables_count;
      this._syncUiFromClone(this.clone);
    } else if (evt.type === 'status') {
      this.clone.status = evt.status;
      this._syncUiFromClone(this.clone);
    } else if (evt.type === 'result') {
      this.clone.status = 'done';
      this.clone.progress = 100;
      this.clone.current_phase = 'package';
      this.clone.output_dir = evt.outputDir;
      this.clone.zip_path = evt.zipPath;
      if (evt.summary) {
        this.clone.pages_count = evt.summary.pages;
        this.clone.assets_count = evt.summary.assets;
        this.clone.assets_bytes = evt.summary.bytes;
        this.clone.endpoints_count = evt.summary.endpoints;
        this.clone.tables_count = evt.summary.tables;
      }
      this._syncUiFromClone(this.clone);
      Toast.show('Clonage terminé avec succès', { type: 'info' });
    } else if (evt.type === 'error' && evt.fatal) {
      this.clone.status = 'failed';
      this._syncUiFromClone(this.clone);
      Toast.show(evt.message || 'Erreur fatale lors du clonage', { type: 'error' });
    }
  }
}

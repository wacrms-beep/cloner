/**
 * HomeView : écran d'accueil épuré :
 * - Grand champ URL glass centré
 * - Bouton rond « Cloner »
 * - Bouton Options ouvrant un Sheet (profondeur, pages max, mobile, trackers, API, backend, délai, robots.txt, dossier de sortie)
 * - Validation d'URL stricte côté client
 * - Dernières tâches en cartes avec cascade
 */
import { Api } from '../core/Api.js';
import { store } from '../core/Store.js';
import { Toast } from '../core/Toast.js';
import { icon } from '../core/Icons.js';
import { Sheet } from '../components/Sheet.js';
import { createSwitch } from '../components/Switch.js';
import { createChip } from '../components/Chip.js';

export class HomeView {
  constructor(root, params, router) {
    this.root = root;
    this.params = params || {};
    this.router = router;
    this.options = {
      max_depth: 2,
      max_pages: 50,
      mobile_emulation: false,
      strip_trackers: true,
      sniff_api: true,
      generate_backend: true,
      request_delay_ms: 300,
      respect_robots: true,
      outputDir: ''
    };
  }

  async mount() {
    const settings = await Api.invoke('settings:get');
    this.options = {
      ...this.options,
      ...(settings.defaultCloneOptions || {}),
      outputDir: settings.outputDir || ''
    };

    const recentClones = await Api.invoke('clone:list', { limit: 6 });
    store.setState({ settings, recentClones });

    this.root.innerHTML = `
      <div class="home-hero">
        <div style="text-align:center;">
          <h1>Cloneur Web</h1>
        </div>

        <div class="url-launcher-bar glass-card-strong">
          <input
            id="home-url-input"
            type="url"
            class="url-input-main"
            placeholder="https://quotes.toscrape.com"
            value="${this.params.prefillUrl || ''}"
            aria-label="URL à cloner"
          />
          <button id="home-options-btn" class="btn btn-secondary btn-icon" title="Options de clonage" aria-label="Options">
            ${icon('Sliders')}
          </button>
          <button id="home-clone-btn" class="btn btn-circle-lg" title="Cloner" aria-label="Cloner">
            ${icon('play')}
          </button>
        </div>

        <div id="home-active-badges" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;"></div>
      </div>

      <section style="padding: 0 12px 24px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <h2>Récent</h2>
          <button id="home-all-history-btn" class="btn btn-secondary" style="padding:6px 14px;font-size:12.5px;">
            ${icon('history')} <span>Tout voir</span>
          </button>
        </div>
        <div id="home-recent-grid" class="recent-grid"></div>
      </section>
    `;

    this._renderOptionChips();
    this._renderRecentCards(recentClones);

    const urlInput = this.root.querySelector('#home-url-input');
    const cloneBtn = this.root.querySelector('#home-clone-btn');
    const optionsBtn = this.root.querySelector('#home-options-btn');
    const allHistBtn = this.root.querySelector('#home-all-history-btn');

    const triggerClone = async () => {
      const rawUrl = urlInput.value.trim();
      if (!rawUrl) {
        Toast.show('Veuillez saisir une URL http:// ou https://', { type: 'warn' });
        urlInput.focus();
        return;
      }
      try {
        cloneBtn.disabled = true;
        const clone = await Api.invoke('clone:start', {
          url: rawUrl,
          options: this.options
        });
        await this.router.navigate('job', { cloneId: clone.id });
      } catch (err) {
        Toast.show(err.message, { type: 'error' });
      } finally {
        cloneBtn.disabled = false;
      }
    };

    cloneBtn.addEventListener('click', triggerClone);
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') triggerClone();
    });

    optionsBtn.addEventListener('click', () => this._openOptionsSheet());
    allHistBtn.addEventListener('click', () => this.router.navigate('history'));
  }

  _renderOptionChips() {
    const wrap = this.root.querySelector('#home-active-badges');
    if (!wrap) return;
    wrap.innerHTML = '';
    wrap.appendChild(createChip({ label: 'Profondeur', value: this.options.max_depth }));
    wrap.appendChild(createChip({ label: 'Pages max', value: this.options.max_pages }));
    if (this.options.respect_robots) {
      wrap.appendChild(createChip({ label: 'robots.txt', variant: 'success' }));
    }
    if (this.options.sniff_api) {
      wrap.appendChild(createChip({ label: 'Sniffer API', variant: 'accent' }));
    }
    if (this.options.generate_backend) {
      wrap.appendChild(createChip({ label: 'Backend PHP/SQL', variant: 'accent' }));
    }
  }

  _renderRecentCards(clones = []) {
    const grid = this.root.querySelector('#home-recent-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (clones.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'glass-card';
      empty.style.padding = '28px';
      empty.style.gridColumn = '1 / -1';
      empty.style.textAlign = 'center';
      empty.style.color = 'var(--text-secondary)';
      empty.textContent = 'Aucune tâche récente. Entrez une URL ci-dessus pour démarrer.';
      grid.appendChild(empty);
      return;
    }

    clones.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'clone-card glass-card cascade-item';
      card.style.cursor = 'pointer';

      const statusVariant = item.status === 'done'
        ? 'success'
        : (item.status === 'failed' || item.status === 'interrupted' ? 'danger' : 'warn');

      const thumbHtml = item.thumbnail
        ? `<img src="${item.thumbnail}" alt="${item.domain}" class="clone-thumb" />`
        : `<div class="clone-thumb">${icon('brand')}</div>`;

      card.innerHTML = `
        ${thumbHtml}
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <strong style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${item.domain}</strong>
          <span class="chip chip-${statusVariant}" style="padding:3px 10px;font-size:11px;">${item.status}</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--text-secondary);">
          <span>${item.pages_count || 0} pages</span> •
          <span>${item.assets_count || 0} assets</span> •
          <span>${item.endpoints_count || 0} API</span>
        </div>
      `;

      card.addEventListener('click', () => {
        this.router.navigate('job', { cloneId: item.id });
      });

      grid.appendChild(card);
    });
  }

  _openOptionsSheet() {
    const content = document.createElement('div');
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.gap = '6px';

    const makeNumberRow = (label, key, min, max) => {
      const row = document.createElement('div');
      row.className = 'form-row';
      row.innerHTML = `<span>${label}</span>`;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'glass-input';
      inp.style.width = '110px';
      inp.min = String(min);
      inp.max = String(max);
      inp.value = String(this.options[key]);
      inp.addEventListener('change', () => {
        this.options[key] = Number(inp.value);
      });
      row.appendChild(inp);
      return row;
    };

    const makeSwitchRow = (label, key) => {
      const row = document.createElement('div');
      row.className = 'form-row';
      const span = document.createElement('span');
      span.textContent = label;
      const sw = createSwitch({
        checked: Boolean(this.options[key]),
        label,
        onChange: (val) => {
          this.options[key] = val;
        }
      });
      row.appendChild(span);
      row.appendChild(sw);
      return row;
    };

    content.appendChild(makeNumberRow('Profondeur max', 'max_depth', 0, 10));
    content.appendChild(makeNumberRow('Pages max', 'max_pages', 1, 1000));
    content.appendChild(makeNumberRow('Délai entre requêtes (ms)', 'request_delay_ms', 0, 10000));
    content.appendChild(makeSwitchRow('Respecter robots.txt', 'respect_robots'));
    content.appendChild(makeSwitchRow('Émulation Mobile', 'mobile_emulation'));
    content.appendChild(makeSwitchRow('Supprimer les trackers', 'strip_trackers'));
    content.appendChild(makeSwitchRow('Sniffer API (XHR/Fetch)', 'sniff_api'));
    content.appendChild(makeSwitchRow('Générer Backend PHP 8 + SQL', 'generate_backend'));

    // Dossier de sortie
    const dirRow = document.createElement('div');
    dirRow.className = 'form-row';
    dirRow.innerHTML = `<span>Dossier de sortie</span>`;
    const dirControls = document.createElement('div');
    dirControls.style.display = 'flex';
    dirControls.style.gap = '6px';
    const dirInput = document.createElement('input');
    dirInput.type = 'text';
    dirInput.className = 'glass-input';
    dirInput.style.width = '240px';
    dirInput.value = this.options.outputDir || '';
    dirInput.addEventListener('change', () => {
      this.options.outputDir = dirInput.value.trim();
    });
    const pickBtn = document.createElement('button');
    pickBtn.className = 'btn btn-secondary';
    pickBtn.innerHTML = icon('folder');
    pickBtn.addEventListener('click', async () => {
      const res = await Api.invoke('settings:pickDirectory');
      if (!res.canceled && res.path) {
        dirInput.value = res.path;
        this.options.outputDir = res.path;
      }
    });
    dirControls.appendChild(dirInput);
    dirControls.appendChild(pickBtn);
    dirRow.appendChild(dirControls);
    content.appendChild(dirRow);

    Sheet.open({
      title: 'Options de clonage',
      contentNode: content,
      onClose: () => this._renderOptionChips()
    });
  }
}

/**
 * HistoryView : grille de cartes avec vignette, domaine, date, statut, stats ;
 * recherche, filtre par statut, suppression (avec confirmation), relance.
 */
import { Api } from '../core/Api.js';
import { Toast } from '../core/Toast.js';
import { icon } from '../core/Icons.js';
import { Sheet } from '../components/Sheet.js';

export class HistoryView {
  constructor(root, params, router) {
    this.root = root;
    this.router = router;
    this.statusFilter = '';
    this.searchQuery = '';
  }

  async mount() {
    this.root.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px;padding:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
          <h1>Historique</h1>
          <div style="display:flex;gap:10px;align-items:center;">
            <input
              id="hist-search"
              type="search"
              class="glass-input"
              placeholder="Rechercher domaine ou URL..."
              style="width:240px;"
            />
            <select id="hist-status" class="glass-input">
              <option value="">Tous les statuts</option>
              <option value="done">Terminés (done)</option>
              <option value="running">En cours (running)</option>
              <option value="failed">Échoués (failed)</option>
              <option value="cancelled">Annulés (cancelled)</option>
              <option value="interrupted">Interrompus (interrupted)</option>
            </select>
          </div>
        </div>

        <div id="hist-grid" class="history-grid"></div>
      </div>
    `;

    const searchInput = this.root.querySelector('#hist-search');
    const statusSelect = this.root.querySelector('#hist-status');

    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this._loadList();
    });
    statusSelect.addEventListener('change', () => {
      this.statusFilter = statusSelect.value;
      this._loadList();
    });

    await this._loadList();
  }

  async _loadList() {
    const items = await Api.invoke('clone:list', {
      status: this.statusFilter || null,
      search: this.searchQuery,
      limit: 200
    });

    const grid = this.root.querySelector('#hist-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'glass-card';
      empty.style.padding = '32px';
      empty.style.gridColumn = '1 / -1';
      empty.style.textAlign = 'center';
      empty.textContent = 'Aucun clone correspondant.';
      grid.appendChild(empty);
      return;
    }

    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'clone-card glass-card cascade-item';

      const thumbHtml = item.thumbnail
        ? `<img src="${item.thumbnail}" alt="${item.domain}" class="clone-thumb" />`
        : `<div class="clone-thumb">${icon('brand')}</div>`;

      const dateStr = item.created_at ? new Date(item.created_at).toLocaleString('fr-FR') : '';
      const mb = ((item.assets_bytes || 0) / (1024 * 1024)).toFixed(1);

      card.innerHTML = `
        ${thumbHtml}
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <strong>${item.domain}</strong>
          <span class="chip" style="padding:3px 10px;font-size:11px;">${item.status}</span>
        </div>
        <div style="font-size:12px;color:var(--text-secondary);">${dateStr}</div>
        <div style="font-size:12.5px;color:var(--text-secondary);">
          ${item.pages_count || 0} pages • ${item.assets_count || 0} assets (${mb} Mo) • ${item.endpoints_count || 0} API
        </div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button class="btn btn-primary open-btn" style="flex:1;padding:7px 10px;font-size:12px;">Ouvrir</button>
          <button class="btn btn-secondary reclone-btn" title="Relancer" style="padding:7px 10px;">${icon('refresh')}</button>
          <button class="btn btn-danger delete-btn" title="Supprimer" style="padding:7px 10px;">${icon('trash')}</button>
        </div>
      `;

      card.querySelector('.open-btn').addEventListener('click', () => {
        this.router.navigate('job', { cloneId: item.id });
      });

      card.querySelector('.reclone-btn').addEventListener('click', () => {
        this.router.navigate('home', { prefillUrl: item.url });
      });

      card.querySelector('.delete-btn').addEventListener('click', () => {
        this._confirmDelete(item);
      });

      grid.appendChild(card);
    }
  }

  _confirmDelete(item) {
    const content = document.createElement('div');
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.gap = '14px';
    content.innerHTML = `
      <p>Voulez-vous supprimer l’entrée <strong>${item.domain}</strong> ?</p>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
        <input type="checkbox" id="del-files-chk" checked />
        <span>Supprimer aussi le dossier de sortie et l’archive .zip</span>
      </label>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button id="confirm-del-btn" class="btn btn-danger">${icon('trash')} <span>Supprimer</span></button>
      </div>
    `;

    const sheet = Sheet.open({ title: 'Confirmation de suppression', contentNode: content });
    content.querySelector('#confirm-del-btn').addEventListener('click', async () => {
      const deleteFiles = content.querySelector('#del-files-chk').checked;
      await Api.invoke('clone:delete', { id: item.id, deleteFiles });
      sheet.close();
      Toast.show('Clone supprimé', { type: 'info' });
      await this._loadList();
    });
  }
}

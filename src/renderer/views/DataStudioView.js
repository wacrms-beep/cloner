/**
 * DataStudioView (§5) : explorateur et éditeur SQLite complet (comme phpMyAdmin) :
 * - Sélecteur de base : (a) Base de l'app, (b) Ouvrir fichier .sqlite/.db (ou preview.sqlite d'un clone)
 * - Liste des tables et vues (nombre de lignes)
 * - Onglets : Données (grille paginée 50/100/500, tri, recherche globale, filtre par colonne,
 *   édition en ligne double-clic, ajout, duplication, suppression avec annulation 5s),
 *   Structure (colonnes, types, PK, FK, index), Console SQL (lecture seule par défaut, basculable,
 *   historique, 1000 lignes max)
 * - Export CSV/JSON/SQL et Import CSV.
 */
import { Api } from '../core/Api.js';
import { Toast } from '../core/Toast.js';
import { icon } from '../core/Icons.js';
import { DataGrid } from '../components/DataGrid.js';
import { Sheet } from '../components/Sheet.js';
import { createSwitch } from '../components/Switch.js';

export class DataStudioView {
  constructor(root, params, router) {
    this.root = root;
    this.params = params || {};
    this.router = router;

    this.dbInfo = null;
    this.currentTable = null;
    this.activeTab = 'rows'; // 'rows' | 'structure' | 'sql'
    this.page = 1;
    this.pageSize = 50;
    this.sortBy = null;
    this.sortDir = 'ASC';
    this.globalSearch = '';
    this.columnFilters = {};
    this.sqlReadOnly = true;
  }

  async mount() {
    this.root.innerHTML = `
      <div class="studio-layout">
        <aside class="studio-sidebar glass-card">
          <div style="display:flex;flex-direction:column;gap:8px;">
            <h3>Base SQLite</h3>
            <div style="display:flex;gap:6px;">
              <button id="studio-app-db-btn" class="btn btn-secondary" style="flex:1;padding:6px 8px;font-size:12px;">App DB</button>
              <button id="studio-open-file-btn" class="btn btn-primary" style="flex:1;padding:6px 8px;font-size:12px;">${icon('folder')} Ouvrir</button>
            </div>
            <div id="studio-db-name" class="mono" style="font-size:11.5px;color:var(--text-secondary);word-break:break-all;"></div>
          </div>

          <div style="margin-top:8px;">
            <h3 style="margin-bottom:8px;">Tables & Vues</h3>
            <div id="studio-tables-list" style="display:flex;flex-direction:column;gap:4px;"></div>
          </div>
        </aside>

        <section class="studio-main glass-card-strong">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
            <div style="display:flex;gap:6px;">
              <button class="btn btn-secondary studio-tab-btn active" data-tab="rows">Données</button>
              <button class="btn btn-secondary studio-tab-btn" data-tab="structure">Structure</button>
              <button class="btn btn-secondary studio-tab-btn" data-tab="sql">${icon('terminal')} Console SQL</button>
            </div>

            <div id="studio-toolbar-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <input id="studio-global-search" type="search" class="glass-input" placeholder="Recherche globale..." style="width:180px;padding:6px 10px;" />
              <select id="studio-pagesize" class="glass-input" style="padding:6px 10px;">
                <option value="50">50 / page</option>
                <option value="100">100 / page</option>
                <option value="500">500 / page</option>
              </select>
              <button id="studio-insert-btn" class="btn btn-primary" style="padding:6px 12px;">${icon('plus')} Ligne</button>
              <button id="studio-export-btn" class="btn btn-secondary" style="padding:6px 12px;">${icon('download')} Export</button>
              <button id="studio-import-btn" class="btn btn-secondary" style="padding:6px 12px;">${icon('upload')} Import CSV</button>
            </div>
          </div>

          <div id="studio-tab-content" style="flex:1;display:flex;flex-direction:column;gap:10px;overflow:hidden;"></div>
        </section>
      </div>
    `;

    this.grid = new DataGrid({
      onSort: (col, dir) => {
        this.sortBy = col;
        this.sortDir = dir;
        this._loadRows();
      },
      onFilterChange: (filters) => {
        this.columnFilters = filters;
        this.page = 1;
        this._loadRows();
      },
      onUpdateCell: async ({ locator, column, value }) => {
        await Api.invoke('studio:updateCell', {
          table: this.currentTable,
          locator,
          column,
          value
        });
        Toast.show(`Cellule "${column}" mise à jour`, { durationMs: 2200 });
      },
      onDeleteRow: (locator, row) => this._confirmAndDeleteRow(locator, row),
      onDuplicateRow: (row) => this._openInsertSheet(row)
    });

    this._bindTopEvents();

    // Ouverture initiale (soit preview.sqlite du cloneId, soit la base de l'application)
    try {
      if (this.params.cloneId) {
        this.dbInfo = await Api.invoke('studio:openDb', { cloneId: this.params.cloneId });
      } else {
        this.dbInfo = await Api.invoke('studio:openDb', { path: 'app' });
      }
      this._renderSidebar();
    } catch (err) {
      Toast.show(err.message, { type: 'error' });
    }
  }

  _bindTopEvents() {
    this.root.querySelector('#studio-app-db-btn').addEventListener('click', async () => {
      this.dbInfo = await Api.invoke('studio:openDb', { path: 'app' });
      this.currentTable = null;
      this._renderSidebar();
    });

    this.root.querySelector('#studio-open-file-btn').addEventListener('click', async () => {
      const res = await Api.invoke('studio:openDb', { pickFile: true });
      if (!res.canceled) {
        this.dbInfo = res;
        this.currentTable = null;
        this._renderSidebar();
      }
    });

    this.root.querySelectorAll('.studio-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.activeTab = btn.getAttribute('data-tab');
        this.root.querySelectorAll('.studio-tab-btn').forEach((b) => {
          b.classList.toggle('btn-primary', b === btn);
          b.classList.toggle('btn-secondary', b !== btn);
        });
        this._renderActiveTab();
      });
    });

    const searchInp = this.root.querySelector('#studio-global-search');
    searchInp.addEventListener('input', () => {
      this.globalSearch = searchInp.value;
      this.page = 1;
      if (this.activeTab === 'rows') this._loadRows();
    });

    const pageSizeSel = this.root.querySelector('#studio-pagesize');
    pageSizeSel.addEventListener('change', () => {
      this.pageSize = Number(pageSizeSel.value);
      this.page = 1;
      if (this.activeTab === 'rows') this._loadRows();
    });

    this.root.querySelector('#studio-insert-btn').addEventListener('click', () => this._openInsertSheet());
    this.root.querySelector('#studio-export-btn').addEventListener('click', () => this._openExportSheet());
    this.root.querySelector('#studio-import-btn').addEventListener('click', async () => {
      if (!this.currentTable) return;
      try {
        const res = await Api.invoke('studio:import', { table: this.currentTable, pickFile: true });
        if (!res.canceled) {
          Toast.show(`${res.importedRows} lignes importées dans ${this.currentTable}`);
          await this._refreshTablesList();
          await this._loadRows();
        }
      } catch (err) {
        Toast.show(err.message, { type: 'error' });
      }
    });
  }

  async _refreshTablesList() {
    const info = await Api.invoke('studio:listTables');
    this.dbInfo.tables = info.tables;
    this._renderSidebar();
  }

  _renderSidebar() {
    const nameEl = this.root.querySelector('#studio-db-name');
    const listEl = this.root.querySelector('#studio-tables-list');
    if (!this.dbInfo) return;

    nameEl.textContent = this.dbInfo.dbPath;
    listEl.innerHTML = '';

    const tables = this.dbInfo.tables || [];
    if (!this.currentTable && tables.length > 0) {
      this.currentTable = tables[0].name;
    }

    for (const t of tables) {
      const btn = document.createElement('button');
      btn.className = `table-nav-item ${this.currentTable === t.name ? 'active' : ''}`.trim();
      btn.innerHTML = `
        <span>${t.name}</span>
        <span style="font-size:11px;opacity:0.85;">${t.rowsCount}</span>
      `;
      btn.addEventListener('click', () => {
        this.currentTable = t.name;
        this.page = 1;
        this.sortBy = null;
        this.columnFilters = {};
        this._renderSidebar();
      });
      listEl.appendChild(btn);
    }

    this._renderActiveTab();
  }

  async _renderActiveTab() {
    const container = this.root.querySelector('#studio-tab-content');
    const toolbar = this.root.querySelector('#studio-toolbar-actions');
    if (!container) return;
    container.innerHTML = '';

    toolbar.style.display = this.activeTab === 'rows' ? 'flex' : 'none';

    if (this.activeTab === 'rows') {
      container.appendChild(this.grid.el);
      this.paginationBar = document.createElement('div');
      this.paginationBar.style.display = 'flex';
      this.paginationBar.style.alignItems = 'center';
      this.paginationBar.style.justifyContent = 'space-between';
      container.appendChild(this.paginationBar);
      await this._loadRows();
    } else if (this.activeTab === 'structure') {
      await this._renderStructureTab(container);
    } else if (this.activeTab === 'sql') {
      this._renderSqlConsoleTab(container);
    }
  }

  async _loadRows() {
    if (!this.currentTable) return;
    try {
      const data = await Api.invoke('studio:rows', {
        table: this.currentTable,
        page: this.page,
        pageSize: this.pageSize,
        sortBy: this.sortBy,
        sortDir: this.sortDir,
        search: this.globalSearch,
        columnFilters: this.columnFilters
      });

      this.currentColumns = data.columns;
      this.grid.render({
        columns: data.columns,
        primaryKeys: data.primaryKeys,
        rows: data.rows,
        sortBy: this.sortBy,
        sortDir: this.sortDir
      });

      if (this.paginationBar) {
        this.paginationBar.innerHTML = `
          <span style="font-size:12.5px;color:var(--text-secondary);">
            Total : <strong>${data.total}</strong> lignes — Page ${data.page} / ${data.totalPages}
          </span>
          <div style="display:flex;gap:6px;">
            <button id="pg-prev" class="btn btn-secondary" style="padding:4px 12px;" ${data.page <= 1 ? 'disabled' : ''}>Précédent</button>
            <button id="pg-next" class="btn btn-secondary" style="padding:4px 12px;" ${data.page >= data.totalPages ? 'disabled' : ''}>Suivant</button>
          </div>
        `;
        this.paginationBar.querySelector('#pg-prev')?.addEventListener('click', () => {
          this.page -= 1;
          this._loadRows();
        });
        this.paginationBar.querySelector('#pg-next')?.addEventListener('click', () => {
          this.page += 1;
          this._loadRows();
        });
      }
    } catch (err) {
      Toast.show(err.message, { type: 'error' });
    }
  }

  _confirmAndDeleteRow(locator, row) {
    const content = document.createElement('div');
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.gap = '14px';
    content.innerHTML = `
      <p>Supprimer cette ligne de <strong>${this.currentTable}</strong> ?</p>
      <p style="font-size:12.5px;color:var(--text-secondary);">Vous disposerez de 5 secondes pour annuler la suppression.</p>
      <div style="display:flex;justify-content:flex-end;gap:8px;">
        <button id="confirm-row-del" class="btn btn-danger">${icon('trash')} Confirmer</button>
      </div>
    `;
    const sheet = Sheet.open({ title: 'Supprimer la ligne', contentNode: content });
    content.querySelector('#confirm-row-del').addEventListener('click', async () => {
      sheet.close();
      try {
        const res = await Api.invoke('studio:deleteRow', {
          table: this.currentTable,
          locator
        });
        await this._refreshTablesList();
        await this._loadRows();

        Toast.show('Ligne supprimée', {
          durationMs: 5000,
          actionLabel: 'Annuler (5s)',
          onAction: async () => {
            try {
              await Api.invoke('studio:deleteRow', { undoToken: res.undoToken });
              Toast.show('Suppression annulée, ligne restaurée');
              await this._refreshTablesList();
              await this._loadRows();
            } catch (err) {
              Toast.show(err.message, { type: 'error' });
            }
          }
        });
      } catch (err) {
        Toast.show(err.message, { type: 'error' });
      }
    });
  }

  _openInsertSheet(prefillRow = null) {
    if (!this.currentTable || !this.currentColumns) return;
    const content = document.createElement('form');
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.gap = '10px';

    const inputs = new Map();
    for (const col of this.currentColumns) {
      const rowDiv = document.createElement('div');
      rowDiv.className = 'form-row';
      const label = document.createElement('label');
      label.textContent = `${col.name} (${col.type || 'TEXT'})${col.pk ? ' [PK]' : ''}`;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'glass-input';
      inp.style.width = '260px';
      if (col.pk) {
        inp.placeholder = 'Auto / laisser vide';
      }
      if (prefillRow && !col.pk && prefillRow[col.name] !== undefined && prefillRow[col.name] !== null) {
        inp.value = String(prefillRow[col.name]);
      }
      inputs.set(col.name, inp);
      rowDiv.append(label, inp);
      content.appendChild(rowDiv);
    }

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.style.marginTop = '10px';
    submitBtn.innerHTML = `${icon('check')} <span>Enregistrer</span>`;
    content.appendChild(submitBtn);

    const sheet = Sheet.open({
      title: prefillRow ? `Dupliquer dans ${this.currentTable}` : `Nouvelle ligne (${this.currentTable})`,
      contentNode: content
    });

    content.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rowData = {};
      for (const [colName, inp] of inputs.entries()) {
        if (inp.value !== '') {
          rowData[colName] = inp.value;
        }
      }
      try {
        await Api.invoke('studio:insertRow', { table: this.currentTable, row: rowData });
        sheet.close();
        Toast.show('Ligne ajoutée');
        await this._refreshTablesList();
        await this._loadRows();
      } catch (err) {
        Toast.show(err.message, { type: 'error' });
      }
    });
  }

  _openExportSheet() {
    if (!this.currentTable) return;
    const content = document.createElement('div');
    content.style.display = 'flex';
    content.style.gap = '10px';
    content.style.justifyContent = 'center';

    ['csv', 'json', 'sql'].forEach((fmt) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.innerHTML = `${icon('download')} <span>Exporter en .${fmt.toUpperCase()}</span>`;
      btn.addEventListener('click', async () => {
        try {
          const res = await Api.invoke('studio:export', {
            table: this.currentTable,
            format: fmt,
            saveDialog: true
          });
          if (!res.canceled) {
            Toast.show(`Export ${fmt.toUpperCase()} enregistré (${res.rowCount} lignes)`);
          }
        } catch (err) {
          Toast.show(err.message, { type: 'error' });
        }
      });
      content.appendChild(btn);
    });

    Sheet.open({ title: `Exporter la table ${this.currentTable}`, contentNode: content });
  }

  async _renderStructureTab(container) {
    if (!this.currentTable) return;
    const desc = await Api.invoke('studio:describe', { table: this.currentTable });

    const wrap = document.createElement('div');
    wrap.style.overflowY = 'auto';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '14px';

    const colTable = document.createElement('table');
    colTable.className = 'data-grid-table';
    colTable.innerHTML = `
      <thead>
        <tr>
          <th>#</th><th>Colonne</th><th>Type</th><th>Not Null</th><th>Défaut</th><th>Clé Primaire</th>
        </tr>
      </thead>
      <tbody>
        ${desc.columns.map((c) => `
          <tr>
            <td>${c.cid}</td>
            <td><strong>${c.name}</strong></td>
            <td class="mono">${c.type}</td>
            <td>${c.notnull ? 'OUI' : 'NON'}</td>
            <td class="mono">${c.defaultValue ?? 'NULL'}</td>
            <td>${c.pk ? `PK (${c.pk})` : '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    `;
    wrap.appendChild(colTable);

    if (desc.sql) {
      const sqlPre = document.createElement('pre');
      sqlPre.className = 'glass-input mono selectable';
      sqlPre.style.padding = '12px';
      sqlPre.style.whiteSpace = 'pre-wrap';
      sqlPre.textContent = desc.sql;
      wrap.appendChild(sqlPre);
    }

    container.appendChild(wrap);
  }

  _renderSqlConsoleTab(container) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '10px';
    wrap.style.height = '100%';

    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';
    topRow.style.justifyContent = 'space-between';

    const roWrap = document.createElement('div');
    roWrap.style.display = 'flex';
    roWrap.style.alignItems = 'center';
    roWrap.style.gap = '10px';
    const roLabel = document.createElement('span');
    roLabel.style.fontWeight = '600';
    roLabel.textContent = 'Mode lecture seule (recommandé)';
    const roSwitch = createSwitch({
      checked: this.sqlReadOnly,
      onChange: (val) => {
        this.sqlReadOnly = val;
      }
    });
    roWrap.append(roLabel, roSwitch);

    const runBtn = document.createElement('button');
    runBtn.className = 'btn btn-primary';
    runBtn.innerHTML = `${icon('play')} <span>Exécuter (max 1000 lignes)</span>`;

    topRow.append(roWrap, runBtn);

    const textarea = document.createElement('textarea');
    textarea.className = 'glass-input mono';
    textarea.rows = 4;
    textarea.value = this.currentTable ? `SELECT * FROM "${this.currentTable}" LIMIT 50;` : 'SELECT name, type FROM sqlite_master;';

    const resultBox = document.createElement('div');
    resultBox.className = 'data-grid-wrapper';
    resultBox.style.flex = '1';

    runBtn.addEventListener('click', async () => {
      try {
        const res = await Api.invoke('studio:runSql', {
          sql: textarea.value,
          readOnly: this.sqlReadOnly
        });
        resultBox.innerHTML = '';
        if (res.rows && res.rows.length > 0) {
          const cols = Object.keys(res.rows[0]);
          const tbl = document.createElement('table');
          tbl.className = 'data-grid-table';
          tbl.innerHTML = `
            <thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
            <tbody>
              ${res.rows.map((r) => `<tr>${cols.map((c) => `<td class="selectable">${r[c] ?? 'NULL'}</td>`).join('')}</tr>`).join('')}
            </tbody>
          `;
          resultBox.appendChild(tbl);
        } else {
          resultBox.innerHTML = `<div style="padding:16px;">Exécuté en ${res.durationMs} ms — Lignes affectées : ${res.changes || 0}</div>`;
        }
        await this._refreshTablesList();
      } catch (err) {
        Toast.show(err.message, { type: 'error' });
      }
    });

    wrap.append(topRow, textarea, resultBox);
    container.appendChild(wrap);
  }
}

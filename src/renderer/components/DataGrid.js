/**
 * Composant DataGrid : grille interactive pour le Data Studio (§5)
 * - Tri par colonne (clic sur en-tête)
 * - Filtre par colonne (champ sous en-tête)
 * - Édition en ligne au double-clic sur une cellule → saisie → Entrée → validation
 * - Boutons par ligne : Dupliquer, Supprimer
 */
import { icon } from '../core/Icons.js';

export class DataGrid {
  constructor({ onSort, onFilterChange, onUpdateCell, onDeleteRow, onDuplicateRow }) {
    this.onSort = onSort;
    this.onFilterChange = onFilterChange;
    this.onUpdateCell = onUpdateCell;
    this.onDeleteRow = onDeleteRow;
    this.onDuplicateRow = onDuplicateRow;

    this.el = document.createElement('div');
    this.el.className = 'data-grid-wrapper';
    this.columnFilters = {};
  }

  render({ columns = [], primaryKeys = [], rows = [], sortBy = null, sortDir = 'ASC' }) {
    this.el.innerHTML = '';

    if (columns.length === 0) {
      const empty = document.createElement('div');
      empty.style.padding = '28px';
      empty.style.textAlign = 'center';
      empty.style.color = 'var(--text-secondary)';
      empty.textContent = 'Sélectionnez une table pour afficher ses données.';
      this.el.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'data-grid-table';

    // En-tête de colonnes + tri
    const thead = document.createElement('thead');
    const trHead = document.createElement('tr');

    for (const col of columns) {
      const th = document.createElement('th');
      const isSorted = sortBy === col.name;
      const arrow = isSorted ? (sortDir === 'ASC' ? ' ▲' : ' ▼') : '';
      const pkBadge = col.pk > 0 ? ' [PK]' : '';
      th.textContent = `${col.name}${pkBadge} (${col.type || 'TEXT'})${arrow}`;
      th.addEventListener('click', () => {
        const nextDir = isSorted && sortDir === 'ASC' ? 'DESC' : 'ASC';
        this.onSort(col.name, nextDir);
      });
      trHead.appendChild(th);
    }

    const thActions = document.createElement('th');
    thActions.textContent = 'Actions';
    thActions.style.width = '96px';
    trHead.appendChild(thActions);
    thead.appendChild(trHead);

    // Ligne de filtres par colonne
    const trFilters = document.createElement('tr');
    for (const col of columns) {
      const tdF = document.createElement('td');
      tdF.style.padding = '4px 6px';
      tdF.style.background = 'var(--surface-muted)';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'glass-input';
      inp.style.width = '100%';
      inp.style.padding = '4px 8px';
      inp.style.fontSize = '12px';
      inp.placeholder = `Filtrer ${col.name}...`;
      inp.value = this.columnFilters[col.name] || '';
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.columnFilters[col.name] = inp.value;
          this.onFilterChange({ ...this.columnFilters });
        }
      });
      tdF.appendChild(inp);
      trFilters.appendChild(tdF);
    }
    const tdEmptyAction = document.createElement('td');
    tdEmptyAction.style.background = 'var(--surface-muted)';
    trFilters.appendChild(tdEmptyAction);
    thead.appendChild(trFilters);

    table.appendChild(thead);

    // Corps de la table
    const tbody = document.createElement('tbody');
    if (rows.length === 0) {
      const trEmpty = document.createElement('tr');
      const tdEmpty = document.createElement('td');
      tdEmpty.colSpan = columns.length + 1;
      tdEmpty.style.textAlign = 'center';
      tdEmpty.style.padding = '24px';
      tdEmpty.textContent = 'Aucune ligne trouvée.';
      trEmpty.appendChild(tdEmpty);
      tbody.appendChild(trEmpty);
    } else {
      for (const row of rows) {
        const tr = document.createElement('tr');
        const locator = this._extractLocator(row, primaryKeys);

        for (const col of columns) {
          const td = document.createElement('td');
          td.className = 'selectable';
          const val = row[col.name];
          this._renderCellValue(td, val);

          // Double-clic pour édition en ligne
          td.addEventListener('dblclick', () => {
            this._startInlineEdit(td, col, val, locator);
          });

          tr.appendChild(td);
        }

        // Actions (Dupliquer / Supprimer)
        const tdAct = document.createElement('td');
        tdAct.style.display = 'flex';
        tdAct.style.gap = '6px';

        const dupBtn = document.createElement('button');
        dupBtn.className = 'btn btn-secondary';
        dupBtn.style.padding = '4px 8px';
        dupBtn.title = 'Dupliquer la ligne';
        dupBtn.innerHTML = icon('copy');
        dupBtn.addEventListener('click', () => this.onDuplicateRow(row));

        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-danger';
        delBtn.style.padding = '4px 8px';
        delBtn.title = 'Supprimer la ligne';
        delBtn.innerHTML = icon('trash');
        delBtn.addEventListener('click', () => this.onDeleteRow(locator, row));

        tdAct.appendChild(dupBtn);
        tdAct.appendChild(delBtn);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      }
    }

    table.appendChild(tbody);
    this.el.appendChild(table);
  }

  _renderCellValue(td, val) {
    td.innerHTML = '';
    if (val === null || val === undefined) {
      const span = document.createElement('span');
      span.className = 'cell-null';
      span.textContent = 'NULL';
      td.appendChild(span);
    } else {
      td.textContent = String(val);
    }
  }

  _extractLocator(row, primaryKeys) {
    const loc = {};
    if (primaryKeys && primaryKeys.length > 0) {
      for (const pk of primaryKeys) {
        loc[pk] = row[pk];
      }
    }
    if (row.__rowid__ !== undefined) {
      loc.__rowid__ = row.__rowid__;
    }
    return loc;
  }

  _startInlineEdit(td, col, initialVal, locator) {
    if (td.querySelector('input')) return;
    td.innerHTML = '';

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'glass-input';
    inp.style.width = '100%';
    inp.style.padding = '3px 6px';
    inp.value = initialVal === null || initialVal === undefined ? '' : String(initialVal);

    let finished = false;
    const commit = async () => {
      if (finished) return;
      finished = true;
      const nextVal = inp.value;
      if (String(initialVal ?? '') === nextVal) {
        this._renderCellValue(td, initialVal);
        return;
      }
      try {
        await this.onUpdateCell({ locator, column: col.name, value: nextVal });
        this._renderCellValue(td, nextVal);
      } catch (_) {
        this._renderCellValue(td, initialVal);
      }
    };

    const cancel = () => {
      if (finished) return;
      finished = true;
      this._renderCellValue(td, initialVal);
    };

    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') cancel();
    });
    inp.addEventListener('blur', commit);

    td.appendChild(inp);
    inp.focus();
    inp.select();
  }
}

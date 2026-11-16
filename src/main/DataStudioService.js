/**
 * DataStudioService : service d'exploration et de modification de bases SQLite
 * (comme phpMyAdmin, 100 % local).
 *
 * RÈGLES DE SÉCURITÉ STRICTES :
 * - Toutes les valeurs passent exclusivement par des requêtes préparées (paramètres ?).
 * - Tous les identifiants dynamiques (tables, vues, colonnes) sont vérifiés contre la liste
 *   réelle retournée par sqlite_master et PRAGMA table_info avant d'être entourés de
 *   guillemets doubles échappés ("identifiant").
 * - Une sauvegarde instantanée horodatée (dans userData/backups) est créée avant toute
 *   opération d'écriture en masse (import CSV, exécution SQL en mode écriture).
 * - La suppression d'une ligne crée un jeton d'annulation (valable pendant 5+ secondes)
 *   permettant de restaurer la ligne dans une transaction atomique.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openSqliteConnection } = require('./db/Database');

class DataStudioService {
  /**
   * @param {object} options
   * @param {string} options.appDbPath Chemin de la base principale de l'application
   * @param {string} options.backupsDir Dossier de sauvegarde horodatée (userData/backups)
   * @param {import('./Logger').Logger} [options.logger]
   */
  constructor({ appDbPath, backupsDir, logger = null }) {
    this.appDbPath = appDbPath;
    this.backupsDir = backupsDir;
    this.logger = logger;
    fs.mkdirSync(this.backupsDir, { recursive: true });

    this.currentPath = appDbPath;
    this.conn = null;
    this.undoBuffer = new Map(); // token -> { dbPath, table, row, expiresAt }
    this.queryHistory = [];
    this.openDatabase(appDbPath);
  }

  /**
   * Ouvre une base SQLite (celle de l'application ou n'importe quel fichier .sqlite/.db).
   * @param {string} targetPath Chemin du fichier SQLite ou 'app'
   */
  openDatabase(targetPath) {
    const resolved = (!targetPath || targetPath === 'app')
      ? this.appDbPath
      : path.resolve(String(targetPath));

    if (resolved !== ':memory:' && !fs.existsSync(resolved)) {
      throw new Error(`Fichier SQLite introuvable : ${resolved}`);
    }

    if (this.conn) {
      try {
        this.conn.close();
      } catch (_) {
        // Ignorer
      }
    }

    this.conn = openSqliteConnection(resolved, { readonly: false });
    this.conn.pragma('foreign_keys = ON');
    this.currentPath = resolved;

    return {
      dbPath: this.currentPath,
      isAppDb: this.currentPath === this.appDbPath,
      name: path.basename(this.currentPath),
      tables: this.listTables()
    };
  }

  /**
   * Échappe un identifiant SQLite après qu'il a été validé contre le catalogue réel.
   */
  _quoteIdent(ident) {
    return `"${String(ident).replace(/"/g, '""')}"`;
  }

  /**
   * Récupère la liste réelle des tables et vues depuis sqlite_master.
   */
  _getValidObjects() {
    const stmt = this.conn.prepare(`
      SELECT name, type, sql
      FROM sqlite_master
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type ASC, name ASC
    `);
    return stmt.all();
  }

  /**
   * Vérifie que la table ou vue existe réellement dans sqlite_master et retourne sa fiche.
   */
  _assertValidTable(tableName) {
    const clean = String(tableName || '');
    const objects = this._getValidObjects();
    const found = objects.find((o) => o.name === clean);
    if (!found) {
      throw new Error(`Table ou vue invalide ou inexistante : ${clean}`);
    }
    return found;
  }

  /**
   * Retourne les colonnes réelles de la table via PRAGMA table_info.
   */
  _getValidColumns(tableName) {
    this._assertValidTable(tableName);
    const qTable = this._quoteIdent(tableName);
    const cols = this.conn.pragma(`table_info(${qTable})`) || [];
    return cols.map((c) => ({
      cid: c.cid,
      name: c.name,
      type: c.type || 'TEXT',
      notnull: Boolean(c.notnull),
      defaultValue: c.dflt_value,
      pk: Number(c.pk) || 0
    }));
  }

  /**
   * Vérifie qu'un nom de colonne appartient réellement à la table donnée.
   */
  _assertValidColumn(tableName, columnName, cachedCols = null) {
    const cols = cachedCols || this._getValidColumns(tableName);
    const found = cols.find((c) => c.name === String(columnName));
    if (!found) {
      throw new Error(`Colonne invalide "${columnName}" pour la table "${tableName}"`);
    }
    return found;
  }

  /**
   * Liste toutes les tables et vues avec leur nombre de lignes exact.
   */
  listTables() {
    const objects = this._getValidObjects();
    return objects.map((obj) => {
      const qName = this._quoteIdent(obj.name);
      let rowsCount = 0;
      try {
        const row = this.conn.prepare(`SELECT COUNT(*) AS cnt FROM ${qName}`).get();
        rowsCount = row ? Number(row.cnt) : 0;
      } catch (_) {
        rowsCount = 0;
      }
      return {
        name: obj.name,
        type: obj.type,
        rowsCount
      };
    });
  }

  /**
   * Décrit la structure complète d'une table (colonnes, types, clés primaires, clés étrangères, index).
   */
  describeTable(tableName) {
    const obj = this._assertValidTable(tableName);
    const qTable = this._quoteIdent(obj.name);
    const columns = this._getValidColumns(obj.name);
    const foreignKeys = this.conn.pragma(`foreign_key_list(${qTable})`) || [];
    const indexList = this.conn.pragma(`index_list(${qTable})`) || [];

    const indexes = indexList.map((idx) => {
      const qIdx = this._quoteIdent(idx.name);
      const idxCols = this.conn.pragma(`index_info(${qIdx})`) || [];
      return {
        name: idx.name,
        unique: Boolean(idx.unique),
        origin: idx.origin,
        columns: idxCols.map((ic) => ic.name)
      };
    });

    const pkColumns = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);

    return {
      name: obj.name,
      type: obj.type,
      sql: obj.sql,
      columns,
      primaryKeys: pkColumns,
      foreignKeys,
      indexes
    };
  }

  /**
   * Récupère les lignes paginées avec tri par colonne, recherche globale et filtres par colonne.
   */
  getRows({
    table,
    page = 1,
    pageSize = 50,
    sortBy = null,
    sortDir = 'ASC',
    search = '',
    columnFilters = {}
  }) {
    const meta = this.describeTable(table);
    const cols = meta.columns;
    const qTable = this._quoteIdent(meta.name);

    const allowedSizes = [50, 100, 500];
    const safePageSize = allowedSizes.includes(Number(pageSize)) ? Number(pageSize) : 50;
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safePageSize;

    const whereClauses = [];
    const params = [];

    // Recherche globale
    const trimmedSearch = String(search || '').trim();
    if (trimmedSearch && cols.length > 0) {
      const sub = cols.map((c) => `CAST(${this._quoteIdent(c.name)} AS TEXT) LIKE ?`);
      whereClauses.push(`(${sub.join(' OR ')})`);
      for (let i = 0; i < cols.length; i += 1) {
        params.push(`%${trimmedSearch}%`);
      }
    }

    // Filtres par colonne
    if (columnFilters && typeof columnFilters === 'object') {
      for (const [colName, val] of Object.entries(columnFilters)) {
        const filterStr = String(val ?? '').trim();
        if (!filterStr) continue;
        const validCol = this._assertValidColumn(meta.name, colName, cols);
        whereClauses.push(`CAST(${this._quoteIdent(validCol.name)} AS TEXT) LIKE ?`);
        params.push(`%${filterStr}%`);
      }
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Tri validé
    let orderSql = '';
    if (sortBy) {
      const validSortCol = this._assertValidColumn(meta.name, sortBy, cols);
      const safeDir = String(sortDir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
      orderSql = `ORDER BY ${this._quoteIdent(validSortCol.name)} ${safeDir}`;
    }

    // Sélection incluant rowid si c'est une table standard
    let selectPrefix = '*';
    let hasRowid = false;
    if (meta.type === 'table') {
      try {
        this.conn.prepare(`SELECT rowid FROM ${qTable} LIMIT 1`).get();
        selectPrefix = 'rowid AS "__rowid__", *';
        hasRowid = true;
      } catch (_) {
        selectPrefix = '*';
      }
    }

    const countStmt = this.conn.prepare(`SELECT COUNT(*) AS total FROM ${qTable} ${whereSql}`);
    const totalRow = countStmt.get(...params);
    const total = totalRow ? Number(totalRow.total) : 0;

    const dataStmt = this.conn.prepare(`
      SELECT ${selectPrefix}
      FROM ${qTable}
      ${whereSql}
      ${orderSql}
      LIMIT ? OFFSET ?
    `);
    const rows = dataStmt.all(...params, safePageSize, offset);

    return {
      table: meta.name,
      columns: cols,
      primaryKeys: meta.primaryKeys,
      hasRowid,
      rows,
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / safePageSize))
    };
  }

  /**
   * Valide et convertit une valeur selon le type SQL déclaré de la colonne.
   */
  _coerceAndValidateValue(colSpec, rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
      if (colSpec.notnull && rawValue === null) {
        throw new Error(`La colonne "${colSpec.name}" ne peut pas être NULL.`);
      }
      if (rawValue === null) return null;
    }

    const upperType = String(colSpec.type || 'TEXT').toUpperCase();
    if (upperType.includes('INT')) {
      if (rawValue === '') return colSpec.notnull ? 0 : null;
      const parsed = Number(rawValue);
      if (!Number.isInteger(parsed)) {
        throw new Error(`Valeur entière attendue pour la colonne "${colSpec.name}".`);
      }
      return parsed;
    }
    if (upperType.includes('REAL') || upperType.includes('FLOA') || upperType.includes('DOUB') || upperType.includes('DEC') || upperType.includes('NUM')) {
      if (rawValue === '') return colSpec.notnull ? 0.0 : null;
      const parsed = Number(rawValue);
      if (Number.isNaN(parsed)) {
        throw new Error(`Valeur numérique attendue pour la colonne "${colSpec.name}".`);
      }
      return parsed;
    }
    return typeof rawValue === 'object' ? JSON.stringify(rawValue) : String(rawValue);
  }

  /**
   * Construit une clause WHERE d'identification unique de ligne (Clé primaire obligatoire, sinon rowid).
   */
  _buildRowLocator(meta, locator) {
    if (!locator || typeof locator !== 'object') {
      throw new Error('Identifiant de ligne (clé primaire ou rowid) manquant.');
    }

    if (meta.primaryKeys.length > 0) {
      const clauses = [];
      const values = [];
      for (const pk of meta.primaryKeys) {
        if (locator[pk] === undefined) {
          throw new Error(`Valeur de clé primaire "${pk}" requise.`);
        }
        clauses.push(`${this._quoteIdent(pk)} = ?`);
        values.push(locator[pk]);
      }
      return { whereClause: clauses.join(' AND '), values };
    }

    if (locator.__rowid__ !== undefined || locator.rowid !== undefined) {
      const rid = locator.__rowid__ ?? locator.rowid;
      return { whereClause: 'rowid = ?', values: [Number(rid)] };
    }

    throw new Error('Cette table ne possède ni clé primaire explicite ni rowid utilisable.');
  }

  /**
   * Met à jour une cellule unique via une requête UPDATE préparée.
   */
  updateCell({ table, locator, column, value }) {
    const meta = this.describeTable(table);
    const colSpec = this._assertValidColumn(meta.name, column, meta.columns);
    const coerced = this._coerceAndValidateValue(colSpec, value);
    const { whereClause, values } = this._buildRowLocator(meta, locator);

    const qTable = this._quoteIdent(meta.name);
    const qCol = this._quoteIdent(colSpec.name);

    const stmt = this.conn.prepare(`UPDATE ${qTable} SET ${qCol} = ? WHERE ${whereClause}`);
    const info = stmt.run(coerced, ...values);
    return { updated: info.changes };
  }

  /**
   * Insère une nouvelle ligne (ou duplique une ligne) via une requête INSERT préparée.
   */
  insertRow({ table, row }) {
    const meta = this.describeTable(table);
    if (!row || typeof row !== 'object') {
      throw new Error('Données de ligne invalides.');
    }

    const colNames = [];
    const placeholders = [];
    const values = [];

    for (const [key, rawVal] of Object.entries(row)) {
      if (key === '__rowid__') continue;
      const colSpec = this._assertValidColumn(meta.name, key, meta.columns);
      // Si c'est une clé primaire auto-incrémentée et vide, on laisse SQLite la générer
      if (colSpec.pk > 0 && (rawVal === '' || rawVal === undefined || rawVal === null)) {
        continue;
      }
      colNames.push(this._quoteIdent(colSpec.name));
      placeholders.push('?');
      values.push(this._coerceAndValidateValue(colSpec, rawVal));
    }

    const qTable = this._quoteIdent(meta.name);
    const sql = colNames.length > 0
      ? `INSERT INTO ${qTable} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`
      : `INSERT INTO ${qTable} DEFAULT VALUES`;

    const stmt = this.conn.prepare(sql);
    const info = stmt.run(...values);
    return { inserted: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
  }

  /**
   * Supprime une ligne dans une transaction et retourne un undoToken permettant d'annuler
   * l'opération pendant 5 secondes (conservé 15 s côté service pour tolérer la latence UI).
   */
  deleteRow({ table, locator }) {
    const meta = this.describeTable(table);
    const { whereClause, values } = this._buildRowLocator(meta, locator);
    const qTable = this._quoteIdent(meta.name);

    const selectStmt = this.conn.prepare(`SELECT * FROM ${qTable} WHERE ${whereClause} LIMIT 1`);
    const existingRow = selectStmt.get(...values);
    if (!existingRow) {
      throw new Error('Ligne introuvable pour la suppression.');
    }

    const deleteStmt = this.conn.prepare(`DELETE FROM ${qTable} WHERE ${whereClause}`);
    const tx = this.conn.transaction(() => deleteStmt.run(...values));
    const info = tx();

    const undoToken = crypto.randomUUID();
    this.undoBuffer.set(undoToken, {
      dbPath: this.currentPath,
      table: meta.name,
      row: existingRow,
      expiresAt: Date.now() + 15000
    });

    return {
      deleted: info.changes,
      undoToken,
      undoWindowMs: 5000
    };
  }

  /**
   * Restaure une ligne supprimée récemment à partir de son undoToken.
   */
  undoDelete(undoToken) {
    const entry = this.undoBuffer.get(String(undoToken));
    if (!entry) {
      throw new Error('Délai d’annulation expiré ou jeton invalide.');
    }
    this.undoBuffer.delete(String(undoToken));

    if (Date.now() > entry.expiresAt) {
      throw new Error('Le délai d’annulation de 5 secondes est dépassé.');
    }
    if (entry.dbPath !== this.currentPath) {
      this.openDatabase(entry.dbPath);
    }

    const res = this.insertRow({ table: entry.table, row: entry.row });
    return { restored: true, ...res };
  }

  /**
   * Crée une sauvegarde instantanée horodatée de la base courante dans userData/backups.
   */
  createInstantBackup(reason = 'write') {
    if (!this.currentPath || this.currentPath === ':memory:' || !fs.existsSync(this.currentPath)) {
      return null;
    }
    const baseName = path.basename(this.currentPath, path.extname(this.currentPath));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${baseName}_${reason}_${stamp}.sqlite`;
    const backupPath = path.join(this.backupsDir, backupName);
    fs.copyFileSync(this.currentPath, backupPath);
    if (this.logger) {
      this.logger.info('DataStudioService', `Sauvegarde instantanée créée : ${backupPath}`);
    }
    return backupPath;
  }

  /**
   * Console SQL : exécute une requête SQL.
   * Mode lecture seule par défaut ; limite à 1000 lignes affichées ; sauvegarde auto si écriture.
   */
  runSql({ sql, readOnly = true }) {
    const trimmed = String(sql || '').trim();
    if (!trimmed) {
      throw new Error('Requête SQL vide.');
    }

    const isReadQuery = /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed) && !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH)\b/i.test(trimmed);

    if (readOnly && !isReadQuery) {
      throw new Error('Mode lecture seule actif : seules les requêtes de consultation (SELECT, PRAGMA, EXPLAIN) sont autorisées.');
    }

    let backupPath = null;
    if (!isReadQuery) {
      backupPath = this.createInstantBackup('sql-console');
    }

    const startedAt = Date.now();
    const stmt = this.conn.prepare(trimmed);
    let rows = [];
    let changes = 0;

    if (/^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed)) {
      const allRows = stmt.all();
      rows = allRows.slice(0, 1000);
    } else {
      const info = stmt.run();
      changes = info.changes;
    }

    const durationMs = Date.now() - startedAt;
    const historyItem = {
      sql: trimmed,
      readOnly: Boolean(readOnly),
      durationMs,
      rowCount: rows.length,
      changes,
      executedAt: new Date().toISOString()
    };
    this.queryHistory.unshift(historyItem);
    if (this.queryHistory.length > 50) this.queryHistory.pop();

    return {
      rows,
      rowCount: rows.length,
      truncated: rows.length === 1000,
      changes,
      durationMs,
      backupPath,
      history: this.queryHistory
    };
  }

  /**
   * Exporte une table au format CSV, JSON ou SQL.
   */
  exportTable({ table, format = 'csv', targetPath = null }) {
    const meta = this.describeTable(table);
    const qTable = this._quoteIdent(meta.name);
    const rows = this.conn.prepare(`SELECT * FROM ${qTable}`).all();
    const cols = meta.columns.map((c) => c.name);

    const fmt = String(format || 'csv').toLowerCase();
    let content = '';

    if (fmt === 'json') {
      content = JSON.stringify(rows, null, 2);
    } else if (fmt === 'sql') {
      const lines = [`-- Export SQL de la table ${meta.name}`, meta.sql ? `${meta.sql};` : ''];
      for (const row of rows) {
        const vals = cols.map((c) => this._formatSqlLiteral(row[c]));
        lines.push(`INSERT INTO ${qTable} (${cols.map((c) => this._quoteIdent(c)).join(', ')}) VALUES (${vals.join(', ')});`);
      }
      content = lines.filter(Boolean).join('\n');
    } else {
      // CSV (RFC 4180)
      const escapeCsv = (val) => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (/[",\r\n]/.test(str)) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };
      const csvLines = [cols.map(escapeCsv).join(',')];
      for (const row of rows) {
        csvLines.push(cols.map((c) => escapeCsv(row[c])).join(','));
      }
      content = csvLines.join('\n');
    }

    if (targetPath) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, content, 'utf8');
    }

    return {
      table: meta.name,
      format: fmt,
      rowCount: rows.length,
      targetPath,
      content
    };
  }

  /**
   * Importe des données CSV dans une table existante (avec sauvegarde instantanée et transaction).
   */
  importCsv({ table, csvContent }) {
    const meta = this.describeTable(table);
    const text = String(csvContent || '').trim();
    if (!text) {
      throw new Error('Contenu CSV vide.');
    }

    const records = this._parseCsv(text);
    if (records.length < 2) {
      throw new Error('Le fichier CSV doit contenir une ligne d’en-tête et au moins une ligne de données.');
    }

    const headers = records[0].map((h) => h.trim());
    const validCols = headers.map((h) => this._assertValidColumn(meta.name, h, meta.columns));

    const backupPath = this.createInstantBackup('csv-import');
    const qTable = this._quoteIdent(meta.name);
    const colList = validCols.map((c) => this._quoteIdent(c.name)).join(', ');
    const placeholders = validCols.map(() => '?').join(', ');

    const insertStmt = this.conn.prepare(`INSERT INTO ${qTable} (${colList}) VALUES (${placeholders})`);

    const tx = this.conn.transaction((dataRows) => {
      let count = 0;
      for (const rowArr of dataRows) {
        if (rowArr.length === 1 && rowArr[0] === '') continue;
        const coercedVals = validCols.map((colSpec, idx) => {
          const raw = rowArr[idx] !== undefined ? rowArr[idx] : null;
          return this._coerceAndValidateValue(colSpec, raw);
        });
        insertStmt.run(...coercedVals);
        count += 1;
      }
      return count;
    });

    const importedRows = tx(records.slice(1));
    return {
      table: meta.name,
      importedRows,
      backupPath
    };
  }

  _formatSqlLiteral(val) {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number' && Number.isFinite(val)) return String(val);
    return `'${String(val).replace(/'/g, "''")}'`;
  }

  _parseCsv(text) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          currentField += '"';
          i += 1;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          currentField += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(currentField);
        currentField = '';
      } else if (ch === '\r' && next === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i += 1;
      } else if (ch === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
      } else {
        currentField += ch;
      }
    }
    currentRow.push(currentField);
    rows.push(currentRow);
    return rows;
  }

  close() {
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
  }
}

module.exports = { DataStudioService };

/**
 * Tests unitaires Node.js pour DataStudioService (§5 et §8) :
 * - Ouverture d'une base SQLite (dont un fichier preview.sqlite)
 * - Liste des tables et description (colonnes, clés primaires, index)
 * - Pagination, tri, recherche globale et filtres par colonne
 * - Édition en ligne (updateCell) avec validation de type
 * - Insertion (insertRow), suppression (deleteRow) et annulation dans les 5 s (undoDelete)
 * - Console SQL (mode lecture seule par défaut + mode écriture avec backup auto)
 * - Export CSV/JSON/SQL et Import CSV
 * - Protection contre l'injection SQL sur les noms de tables/colonnes
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openSqliteConnection } = require('../src/main/db/Database');
const { DataStudioService } = require('../src/main/DataStudioService');

describe('DataStudioService', () => {
  let tmpDir;
  let previewDbPath;
  let backupsDir;
  let studio;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uclone-studio-test-'));
    previewDbPath = path.join(tmpDir, 'preview.sqlite');
    backupsDir = path.join(tmpDir, 'backups');

    // Création d'une base preview.sqlite de test simulant quotes / authors
    const raw = openSqliteConnection(previewDbPath);
    raw.exec(`
      CREATE TABLE authors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        born_date TEXT
      );
      CREATE TABLE quotes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        author_id INTEGER REFERENCES authors(id),
        text TEXT NOT NULL,
        rating INTEGER NOT NULL DEFAULT 5
      );
      CREATE INDEX idx_quotes_author ON quotes(author_id);
      INSERT INTO authors (name, born_date) VALUES
        ('Albert Einstein', '1879-03-14'),
        ('J.K. Rowling', '1965-07-31');
      INSERT INTO quotes (author_id, text, rating) VALUES
        (1, 'The world as we have created it is a process of our thinking.', 5),
        (2, 'It is our choices, Harry, that show what we truly are.', 4);
    `);
    raw.close();

    studio = new DataStudioService({
      appDbPath: previewDbPath,
      backupsDir
    });
  });

  afterEach(() => {
    if (studio) studio.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('liste les tables et décrit leur structure (colonnes, PK, FK, index)', () => {
    const tables = studio.listTables();
    assert.equal(tables.length, 2);
    const quotesTable = tables.find((t) => t.name === 'quotes');
    assert.equal(quotesTable.rowsCount, 2);

    const desc = studio.describeTable('quotes');
    assert.deepEqual(desc.primaryKeys, ['id']);
    assert.equal(desc.columns.length, 4);
    assert.equal(desc.foreignKeys.length, 1);
    assert.equal(desc.indexes.length, 1);
  });

  it('bloque toute tentative d’injection SQL dans les noms de tables ou de colonnes', () => {
    assert.throws(() => studio.describeTable('quotes; DROP TABLE authors;--'), /invalide ou inexistante/);
    assert.throws(() => studio.getRows({ table: 'quotes', sortBy: 'id; DROP TABLE quotes' }), /Colonne invalide/);
    assert.throws(
      () => studio.updateCell({ table: 'quotes', locator: { id: 1 }, column: 'bad_col', value: 'x' }),
      /Colonne invalide/
    );
  });

  it('pagine, trie, recherche globalement et filtre par colonne', () => {
    const page1 = studio.getRows({ table: 'quotes', page: 1, pageSize: 50, sortBy: 'rating', sortDir: 'ASC' });
    assert.equal(page1.total, 2);
    assert.equal(page1.rows[0].rating, 4);

    const searched = studio.getRows({ table: 'quotes', search: 'Harry' });
    assert.equal(searched.total, 1);
    assert.equal(searched.rows[0].author_id, 2);

    const filtered = studio.getRows({ table: 'quotes', columnFilters: { rating: '5' } });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.rows[0].author_id, 1);
  });

  it('modifie une cellule (updateCell), valide le type, insère, supprime et annule la suppression (undoDelete)', () => {
    // Validation de type entier sur rating
    assert.throws(
      () => studio.updateCell({ table: 'quotes', locator: { id: 1 }, column: 'rating', value: 'not-an-int' }),
      /Valeur entière attendue/
    );

    const upd = studio.updateCell({
      table: 'quotes',
      locator: { id: 1 },
      column: 'text',
      value: 'Citation modifiée dans Data Studio'
    });
    assert.equal(upd.updated, 1);

    const ins = studio.insertRow({
      table: 'quotes',
      row: { author_id: 1, text: 'Nouvelle citation', rating: 5 }
    });
    assert.equal(ins.inserted, 1);
    assert.equal(studio.getRows({ table: 'quotes' }).total, 3);

    // Suppression avec undoToken
    const del = studio.deleteRow({ table: 'quotes', locator: { id: ins.lastInsertRowid } });
    assert.equal(del.deleted, 1);
    assert.ok(del.undoToken);
    assert.equal(studio.getRows({ table: 'quotes' }).total, 2);

    // Annulation dans les 5 secondes
    const restored = studio.undoDelete(del.undoToken);
    assert.equal(restored.restored, true);
    assert.equal(studio.getRows({ table: 'quotes' }).total, 3);
  });

  it('exécute la console SQL (bloque les écritures en mode lecture seule, crée un backup en mode écriture)', () => {
    const readRes = studio.runSql({ sql: 'SELECT name FROM authors ORDER BY id ASC', readOnly: true });
    assert.equal(readRes.rowCount, 2);
    assert.equal(readRes.rows[0].name, 'Albert Einstein');

    assert.throws(
      () => studio.runSql({ sql: "DELETE FROM quotes WHERE id = 1", readOnly: true }),
      /Mode lecture seule actif/
    );

    const writeRes = studio.runSql({
      sql: "INSERT INTO authors (name, born_date) VALUES ('Marie Curie', '1867-11-07')",
      readOnly: false
    });
    assert.equal(writeRes.changes, 1);
    assert.ok(writeRes.backupPath);
    assert.equal(fs.existsSync(writeRes.backupPath), true);
  });

  it('exporte en CSV/JSON/SQL et importe un CSV avec sauvegarde automatique', () => {
    const csvExport = studio.exportTable({ table: 'authors', format: 'csv' });
    assert.ok(csvExport.content.includes('Albert Einstein'));

    const sqlExport = studio.exportTable({ table: 'authors', format: 'sql' });
    assert.ok(sqlExport.content.includes('INSERT INTO "authors"'));

    const csvToImport = 'name,born_date\n"Isaac Newton","1643-01-04"\n"Galileo Galilei","1564-02-15"';
    const imp = studio.importCsv({ table: 'authors', csvContent: csvToImport });
    assert.equal(imp.importedRows, 2);
    assert.ok(imp.backupPath);
    assert.equal(studio.getRows({ table: 'authors' }).total, 4);
  });
});

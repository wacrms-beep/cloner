/**
 * Tests unitaires Node.js pour Database.js et l'ensemble des dépôts (Repositories).
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../src/main/db/Database');
const { SettingsRepository } = require('../src/main/db/repositories/SettingsRepository');
const { CloneRepository } = require('../src/main/db/repositories/CloneRepository');
const { PageRepository } = require('../src/main/db/repositories/PageRepository');
const { EndpointRepository } = require('../src/main/db/repositories/EndpointRepository');
const { LogRepository } = require('../src/main/db/repositories/LogRepository');

describe('Database & Repositories', () => {
  let tmpDir;
  let dbPath;
  let db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uclone-db-test-'));
    dbPath = path.join(tmpDir, 'test.sqlite');
    db = new AppDatabase(dbPath).init();
  });

  afterEach(() => {
    if (db) db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applique la migration 001_init.sql, active WAL et foreign_keys', () => {
    const journalMode = db.pragma('journal_mode', { simple: true });
    const fk = db.pragma('foreign_keys', { simple: true });
    assert.equal(String(journalMode).toLowerCase(), 'wal');
    assert.equal(Number(fk), 1);

    const mig = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get();
    assert.ok(mig);
    assert.equal(mig.version, 1);
  });

  it('marque tout clone running en interrupted au redémarrage', () => {
    const cloneRepo = new CloneRepository(db);
    const created = cloneRepo.create({
      url: 'https://example.com',
      domain: 'example.com',
      status: 'running',
      options: { max_depth: 1 }
    });
    assert.equal(created.status, 'running');
    db.close();

    // Réouverture de la base
    db = new AppDatabase(dbPath).init();
    const repo2 = new CloneRepository(db);
    const reloaded = repo2.getById(created.id);
    assert.equal(reloaded.status, 'interrupted');
    assert.ok(reloaded.finished_at);
  });

  it('gère SettingsRepository (settings, legal_acceptance, license_state)', () => {
    const settingsRepo = new SettingsRepository(db);
    assert.equal(settingsRepo.get('theme', 'light'), 'light');

    settingsRepo.set('theme', 'dark');
    settingsRepo.set('concurrency', 6);
    assert.equal(settingsRepo.get('theme'), 'dark');
    assert.equal(settingsRepo.get('concurrency'), 6);

    assert.equal(settingsRepo.getLegalAcceptance(), null);
    const legal = settingsRepo.acceptLegal('1.0.0');
    assert.ok(legal.accepted_at);
    assert.equal(legal.app_version, '1.0.0');

    const lic = settingsRepo.saveLicenseState({ status: 'valid', plan: 'full' });
    assert.equal(lic.status, 'valid');
    assert.equal(lic.plan, 'full');
  });

  it('gère CloneRepository, PageRepository, EndpointRepository, LogRepository et suppression CASCADE', () => {
    const cloneRepo = new CloneRepository(db);
    const pageRepo = new PageRepository(db);
    const endpointRepo = new EndpointRepository(db);
    const logRepo = new LogRepository(db);

    const clone = cloneRepo.create({
      url: 'https://quotes.toscrape.com',
      domain: 'quotes.toscrape.com',
      status: 'running',
      options: { max_depth: 2 }
    });

    pageRepo.add({
      cloneId: clone.id,
      url: 'https://quotes.toscrape.com/',
      localPath: 'site/index.html',
      status: 200,
      title: 'Quotes',
      depth: 0
    });
    assert.equal(pageRepo.countByClone(clone.id), 1);

    endpointRepo.upsert({
      cloneId: clone.id,
      method: 'GET',
      normalizedPath: '/api/quotes',
      sampleUrl: 'https://quotes.toscrape.com/api/quotes?page=1',
      responseExample: { quotes: [{ id: 1 }] }
    });
    endpointRepo.upsert({
      cloneId: clone.id,
      method: 'GET',
      normalizedPath: '/api/quotes',
      sampleUrl: 'https://quotes.toscrape.com/api/quotes?page=2'
    });

    const endpoints = endpointRepo.listByClone(clone.id);
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].hits, 2);

    logRepo.add({
      cloneId: clone.id,
      level: 'info',
      phase: 'crawl',
      message: 'Page téléchargée',
      data: { page: 1 }
    });
    const logs = logRepo.listByClone(clone.id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].data.page, 1);

    cloneRepo.completeClone(clone.id, {
      outputDir: '/tmp/out',
      zipPath: '/tmp/out.zip',
      summary: {
        pages: 1,
        assets: 5,
        bytes: 12000,
        endpoints: 1,
        tables: 1,
        tableSpecs: [{ table_name: 'quotes', columns: [{ name: 'id', sql_type: 'INT' }], rows_count: 10 }]
      }
    });

    const doneClone = cloneRepo.getById(clone.id);
    assert.equal(doneClone.status, 'done');
    assert.equal(doneClone.progress, 100);
    assert.equal(cloneRepo.listCloneTables(clone.id).length, 1);

    // Suppression CASCADE
    assert.equal(cloneRepo.delete(clone.id), true);
    assert.equal(pageRepo.countByClone(clone.id), 0);
    assert.equal(endpointRepo.listByClone(clone.id).length, 0);
    assert.equal(logRepo.listByClone(clone.id).length, 0);
  });
});

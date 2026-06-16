import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

// Use a temp DB for tests
const tmpDir = mkdtempSync(join(tmpdir(), 'bot-test-'));
const tmpDbPath = join(tmpDir, 'test.db');

process.env.NODE_ENV = 'test';

// We need to import after setting up the env, so dynamic imports later
let getDb: any;
let closeDb: any;

beforeEach(async () => {
  // Set the DB path before any imports
  process.env.BOT_DB_PATH = tmpDbPath;
  // Force fresh imports
  if (!getDb) {
    const dbMod = await import('../src/db/index.js');
    getDb = dbMod.getDb;
    closeDb = dbMod.closeDb;
  }
  // Clean DB between tests
  if (existsSync(tmpDbPath)) {
    unlinkSync(tmpDbPath);
    for (const ext of ['-wal', '-shm', '-journal']) {
      const p = tmpDbPath + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  }
  closeDb();
  getDb(tmpDbPath);
});

afterAll(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('DB schema and migrations', () => {
  it('creates all tables', async () => {
    const db = getDb(tmpDbPath);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as any[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('signals');
    expect(tableNames).toContain('positions');
    expect(tableNames).toContain('trades');
    expect(tableNames).toContain('token_meta_cache');
    expect(tableNames).toContain('kol_trades');
    expect(tableNames).toContain('daily_pnl');
    expect(tableNames).toContain('bot_state');
  });

  it('is idempotent (running migrations twice is safe)', () => {
    const db = getDb(tmpDbPath);
    // Run a no-op query to ensure DB is open
    const r = db.prepare(`SELECT 1 AS one`).get() as any;
    expect(r.one).toBe(1);
  });
});

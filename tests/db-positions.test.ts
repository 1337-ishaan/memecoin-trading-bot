import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'bot-pos-test-'));
const tmpDbPath = join(tmpDir, 'pos.db');

process.env.BOT_DB_PATH = tmpDbPath;

let openPosition: any;
let updatePosition: any;
let getPositionById: any;
let getDb: any;
let closeDb: any;

beforeEach(async () => {
  if (existsSync(tmpDbPath)) {
    unlinkSync(tmpDbPath);
    for (const ext of ['-wal', '-shm', '-journal']) {
      const p = tmpDbPath + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  }
  if (!getDb) {
    const dbMod = await import('../../src/db/index.js');
    const posMod = await import('../../src/db/positions.js');
    getDb = dbMod.getDb;
    closeDb = dbMod.closeDb;
    openPosition = posMod.openPosition;
    updatePosition = posMod.updatePosition;
    getPositionById = posMod.getPositionById;
  }
  closeDb();
  getDb(tmpDbPath);
});

afterAll(() => {
  if (closeDb) closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Position DB operations', () => {
  it('opens a position and reads it back', () => {
    const id = openPosition({
      mint: 'MINT1',
      symbol: 'TEST',
      entryPrice: 0.001,
      entryTimestamp: Date.now(),
      amountSol: 1.0,
      amountTokens: 1000,
      partialTaken: false,
      highWaterPrice: 0.001,
      source: 'kol_mirror',
      contributingSignals: ['sig1'],
      status: 'open',
    });
    expect(id).toBeGreaterThan(0);
    const pos = getPositionById(id);
    expect(pos).not.toBeNull();
    expect(pos!.mint).toBe('MINT1');
    expect(pos!.amountSol).toBe(1.0);
    expect(pos!.partialTaken).toBe(false);
  });

  it('updatePosition with boolean partialTaken=true does not crash SQLite', () => {
    const id = openPosition({
      mint: 'MINT2',
      symbol: 'T2',
      entryPrice: 0.001,
      entryTimestamp: Date.now(),
      amountSol: 2.0,
      amountTokens: 2000,
      partialTaken: false,
      highWaterPrice: 0.001,
      source: 'gake_strategy',
      contributingSignals: [],
      status: 'open',
    });
    // This is what the bot's Gake rule exits do: set partialTaken: true
    expect(() => updatePosition(id, { partialTaken: true })).not.toThrow();
    const pos = getPositionById(id);
    expect(pos!.partialTaken).toBe(true);
  });

  it('updatePosition with full close fields works', () => {
    const id = openPosition({
      mint: 'MINT3',
      symbol: 'T3',
      entryPrice: 0.001,
      entryTimestamp: Date.now(),
      amountSol: 1.0,
      amountTokens: 1000,
      partialTaken: false,
      highWaterPrice: 0.001,
      source: 'kol_mirror',
      contributingSignals: [],
      status: 'open',
    });
    expect(() => updatePosition(id, {
      status: 'closed',
      closeTimestamp: Date.now(),
      closePrice: 0.002,
      closeReason: 'gake_tp_50pct_at_2x',
      realizedPnlSol: 0.5,
      realizedPnlPct: 0.5,
      amountTokens: 0,
      amountSol: 0,
    })).not.toThrow();
    const pos = getPositionById(id);
    expect(pos!.status).toBe('closed');
    expect(pos!.realizedPnlSol).toBe(0.5);
  });

  it('updatePosition with partial updates preserves other fields', () => {
    const id = openPosition({
      mint: 'MINT4',
      symbol: 'T4',
      entryPrice: 0.001,
      entryTimestamp: Date.now(),
      amountSol: 1.0,
      amountTokens: 1000,
      partialTaken: false,
      highWaterPrice: 0.001,
      source: 'kol_mirror',
      contributingSignals: [],
      status: 'open',
    });
    updatePosition(id, { highWaterPrice: 0.002 });
    const pos = getPositionById(id);
    expect(pos!.highWaterPrice).toBe(0.002);
    expect(pos!.amountSol).toBe(1.0); // unchanged
  });
});

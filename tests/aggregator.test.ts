import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'bot-agg-test-'));
const tmpDbPath = join(tmpDir, 'agg.db');

process.env.BOT_DB_PATH = tmpDbPath;

let SignalAggregator: any;
let insertSignal: any;
let getDb: any;
let closeDb: any;
let resetConfigCache: any;
let loadConfig: any;
let randomUUID: any;

beforeEach(async () => {
  if (existsSync(tmpDbPath)) {
    unlinkSync(tmpDbPath);
    for (const ext of ['-wal', '-shm', '-journal']) {
      const p = tmpDbPath + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  }
  if (!getDb) {
    const dbMod = await import('../src/db/index.js');
    const sigMod = await import('../src/db/signals.js');
    const aggMod = await import('../src/aggregator/index.js');
    const cfgMod = await import('../src/config/index.js');
    const crypto = await import('node:crypto');
    getDb = dbMod.getDb;
    closeDb = dbMod.closeDb;
    insertSignal = sigMod.insertSignal;
    SignalAggregator = aggMod.SignalAggregator;
    loadConfig = cfgMod.loadConfig;
    resetConfigCache = cfgMod.resetConfigCache;
    randomUUID = crypto.randomUUID;
  }
  resetConfigCache();
  closeDb();
  getDb(tmpDbPath);
});

afterAll(() => {
  if (closeDb) closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('SignalAggregator', () => {
  it('returns null when no signals exist', () => {
    const agg = new SignalAggregator();
    const result = agg.aggregate('NONEXISTENT');
    expect(result).toBeNull();
  });

  it('aggregates single signal below threshold → shouldAct false', () => {
    const sig = {
      id: randomUUID(),
      source: 'kol_mirror' as const,
      mint: 'MINT',
      symbol: 'TEST',
      side: 'buy' as const,
      sizePct: 0.05,
      confidence: 0.3, // below threshold
      reason: 'test',
      timestamp: Date.now(),
      ttlSeconds: 60,
    };
    insertSignal(sig);
    const agg = new SignalAggregator();
    const result = agg.aggregate('MINT');
    expect(result).not.toBeNull();
    expect(result!.shouldAct).toBe(false);
  });

  it('aggregates multi-layer signals above threshold → shouldAct true', () => {
    const t = Date.now();
    insertSignal({
      id: randomUUID(),
      source: 'kol_mirror',
      mint: 'MINT',
      symbol: 'TEST',
      side: 'buy',
      sizePct: 0.03,
      confidence: 0.7,
      reason: 'KOL bought',
      timestamp: t,
      ttlSeconds: 60,
    });
    insertSignal({
      id: randomUUID(),
      source: 'gake_strategy',
      mint: 'MINT',
      symbol: 'TEST',
      side: 'buy',
      sizePct: 0.04,
      confidence: 0.8,
      reason: 'Nadir detected',
      timestamp: t,
      ttlSeconds: 60,
    });
    const agg = new SignalAggregator();
    const result = agg.aggregate('MINT');
    expect(result).not.toBeNull();
    expect(result!.shouldAct).toBe(true);
    expect(result!.contributingSignals.length).toBe(2);
  });

  it('sums sizePct across signals, capped at MAX_POSITION_PCT', () => {
    const t = Date.now();
    insertSignal({
      id: randomUUID(),
      source: 'kol_mirror',
      mint: 'MINT',
      symbol: 'TEST',
      side: 'buy',
      sizePct: 0.5, // huge
      confidence: 0.8,
      reason: 'test',
      timestamp: t,
      ttlSeconds: 60,
    });
    const agg = new SignalAggregator();
    const cfg = loadConfig();
    const result = agg.aggregate('MINT');
    expect(result!.sizePct).toBeLessThanOrEqual(cfg.MAX_POSITION_PCT / 100);
  });

  it('expires signals older than TTL', () => {
    const t = Date.now() - 10 * 60 * 1000; // 10 min ago
    insertSignal({
      id: randomUUID(),
      source: 'kol_mirror',
      mint: 'MINT',
      symbol: 'TEST',
      side: 'buy',
      sizePct: 0.03,
      confidence: 0.8,
      reason: 'stale',
      timestamp: t,
      ttlSeconds: 60, // 1 min TTL — already expired
    });
    const agg = new SignalAggregator();
    const result = agg.aggregate('MINT');
    expect(result).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'bot-risk-test-'));
const tmpDbPath = join(tmpDir, 'risk.db');

process.env.BOT_DB_PATH = tmpDbPath;

let RiskManager: any;
let getDb: any;
let closeDb: any;
let resetConfigCache: any;
let loadConfig: any;

beforeEach(async () => {
  // Reset module cache
  if (existsSync(tmpDbPath)) {
    unlinkSync(tmpDbPath);
    for (const ext of ['-wal', '-shm', '-journal']) {
      const p = tmpDbPath + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  }
  if (!getDb) {
    const dbMod = await import('../../src/db/index.js');
    const riskMod = await import('../../src/layers/risk.js');
    const cfgMod = await import('../../src/config/index.js');
    getDb = dbMod.getDb;
    closeDb = dbMod.closeDb;
    RiskManager = riskMod.RiskManager;
    loadConfig = cfgMod.loadConfig;
    resetConfigCache = cfgMod.resetConfigCache;
  }
  resetConfigCache();
  closeDb();
  getDb(tmpDbPath);
});

afterAll(() => {
  if (closeDb) closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('RiskManager', () => {
  it('rejects blacklisted mints', () => {
    const rm = new RiskManager();
    rm.blacklist('BLACKLISTED', 'test');
    const decision = rm.evaluate({
      id: '1', source: 'kol_mirror', mint: 'BLACKLISTED', side: 'buy',
      sizePct: 0.05, confidence: 0.7, reason: 'test',
      timestamp: Date.now(), ttlSeconds: 60,
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('token_blacklisted');
  });

  it('rejects tokens with mint authority', () => {
    const rm = new RiskManager();
    const decision = rm.evaluate(
      {
        id: '1', source: 'kol_mirror', mint: 'MINT', side: 'buy',
        sizePct: 0.05, confidence: 0.7, reason: 'test',
        timestamp: Date.now(), ttlSeconds: 60,
      },
      {
        mint: 'MINT', symbol: 'T', name: 'T', decimals: 9,
        mintAuthorityActive: true, freezeAuthorityActive: false,
        updatedAt: Date.now(),
      }
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('mint_authority_active');
  });

  it('rejects tokens with freeze authority', () => {
    const rm = new RiskManager();
    const decision = rm.evaluate(
      {
        id: '1', source: 'kol_mirror', mint: 'MINT', side: 'buy',
        sizePct: 0.05, confidence: 0.7, reason: 'test',
        timestamp: Date.now(), ttlSeconds: 60,
      },
      {
        mint: 'MINT', symbol: 'T', name: 'T', decimals: 9,
        mintAuthorityActive: false, freezeAuthorityActive: true,
        updatedAt: Date.now(),
      }
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('freeze_authority_active');
  });

  it('rejects top10 concentration >80%', () => {
    const rm = new RiskManager();
    const decision = rm.evaluate(
      {
        id: '1', source: 'kol_mirror', mint: 'MINT', side: 'buy',
        sizePct: 0.05, confidence: 0.7, reason: 'test',
        timestamp: Date.now(), ttlSeconds: 60,
      },
      {
        mint: 'MINT', symbol: 'T', name: 'T', decimals: 9,
        mintAuthorityActive: false, freezeAuthorityActive: false,
        top10Concentration: 0.95, liquidityUsd: 50_000,
        updatedAt: Date.now(),
      }
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('top10_concentration_too_high');
  });

  it('rejects low liquidity', () => {
    const rm = new RiskManager();
    const decision = rm.evaluate(
      {
        id: '1', source: 'kol_mirror', mint: 'MINT', side: 'buy',
        sizePct: 0.05, confidence: 0.7, reason: 'test',
        timestamp: Date.now(), ttlSeconds: 60,
      },
      {
        mint: 'MINT', symbol: 'T', name: 'T', decimals: 9,
        mintAuthorityActive: false, freezeAuthorityActive: false,
        top10Concentration: 0.20, liquidityUsd: 1_000,
        updatedAt: Date.now(),
      }
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('liquidity_too_low');
  });

  it('caps size to MAX_POSITION_PCT', () => {
    const rm = new RiskManager();
    const decision = rm.evaluate(
      {
        id: '1', source: 'kol_mirror', mint: 'MINT', side: 'buy',
        sizePct: 0.50, // way over cap
        confidence: 0.7, reason: 'test',
        timestamp: Date.now(), ttlSeconds: 60,
      },
      {
        mint: 'MINT', symbol: 'T', name: 'T', decimals: 9,
        mintAuthorityActive: false, freezeAuthorityActive: false,
        top10Concentration: 0.20, liquidityUsd: 50_000,
        updatedAt: Date.now(),
      }
    );
    expect(decision.allow).toBe(true);
    const cfg = loadConfig();
    expect(decision.adjustedSizePct).toBeLessThanOrEqual(cfg.MAX_POSITION_PCT / 100);
  });
});

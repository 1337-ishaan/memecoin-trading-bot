import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config/index.js';

describe('Config', () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it('loads with paper mode default', () => {
    const cfg = loadConfig();
    expect(cfg.TRADING_MODE).toBe('paper');
    expect(cfg.MAX_POSITION_PCT).toBeGreaterThan(0);
    expect(cfg.KOL_WALLETS_LIST).toBeInstanceOf(Array);
  });

  it('parses KOL_WALLETS as list', () => {
    const cfg = loadConfig({ KOL_WALLETS: 'A,B,C' });
    expect(cfg.KOL_WALLETS_LIST).toEqual(['A', 'B', 'C']);
  });

  it('coerces numeric strings', () => {
    const cfg = loadConfig({ MAX_POSITION_PCT: '7.5', MAX_CONCURRENT_POSITIONS: '20' });
    expect(cfg.MAX_POSITION_PCT).toBe(7.5);
    expect(cfg.MAX_CONCURRENT_POSITIONS).toBe(20);
  });

  it('rejects out-of-range weights', () => {
    expect(() => loadConfig({ WEIGHT_KOL_MIRROR: '5' })).toThrow();
  });

  it('rejects invalid nadir range', () => {
    expect(() => loadConfig({ NADIR_DRAWDOWN_MIN: '0.9', NADIR_DRAWDOWN_MAX: '0.5' })).toThrow();
  });
});

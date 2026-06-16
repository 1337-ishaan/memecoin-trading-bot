import { describe, it, expect } from 'vitest';
import { GakeStrategyLayer } from '../../src/layers/gake-strategy.js';
import { DexScreenerClient } from '../../src/data/dexscreener.js';
import { BirdeyeClient } from '../../src/data/birdeye.js';
import { JupiterClient } from '../../src/data/jupiter.js';
import { PriceOracle } from '../../src/data/oracle.js';
import type { TokenMeta } from '../../src/signals/types.js';

// Mock the data clients
const mockDex = {} as DexScreenerClient;
const mockBirdeye = {} as BirdeyeClient;
const mockJupiter = {} as JupiterClient;
const mockOracle = {} as PriceOracle;

describe('GakeStrategyLayer', () => {
  const layer = new GakeStrategyLayer(mockDex, mockBirdeye, mockOracle);

  describe('scoreCatalysts', () => {
    it('scores high for sustained volume + good holder distribution', () => {
      const meta: TokenMeta = {
        mint: 'X',
        symbol: 'TEST',
        name: 'Test',
        decimals: 9,
        mcapUsd: 500_000,
        liquidityUsd: 50_000,
        priceUsd: 0.001,
        volume24hUsd: 5_000,
        holderCount: 5000,
        top10Concentration: 0.20,
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        lpLocked: true,
        updatedAt: Date.now(),
      };
      const score = layer.scoreCatalysts(meta);
      expect(score.composite).toBeGreaterThan(0.4);
    });

    it('scores low for illiquid, concentrated tokens', () => {
      const meta: TokenMeta = {
        mint: 'X',
        symbol: 'TEST',
        name: 'Test',
        decimals: 9,
        mcapUsd: 50_000,
        liquidityUsd: 1_000,
        priceUsd: 0.0001,
        volume24hUsd: 50,
        holderCount: 50,
        top10Concentration: 0.90,
        mintAuthorityActive: true,
        freezeAuthorityActive: false,
        updatedAt: Date.now(),
      };
      const score = layer.scoreCatalysts(meta);
      expect(score.composite).toBeLessThan(0.4);
    });
  });

  describe('shouldExitGake (the secret sauce: 50% at 2x + TSL + hard stop)', () => {
    it('takes 50% at 2x', () => {
      const result = layer.shouldExitGake(
        0.001,    // entry
        0.0021,   // current (2.1x)
        0.0021,   // high water
        false     // partial not yet taken
      );
      expect(result.shouldExit).toBe(true);
      expect(result.exitFraction).toBe(0.5);
      expect(result.reason).toBe('gake_tp_50pct_at_2x');
    });

    it('does not re-trigger TP after partial taken', () => {
      const result = layer.shouldExitGake(
        0.001,
        0.005,   // way above 2x
        0.006,
        true     // partial already taken
      );
      expect(result.shouldExit).toBe(false);
    });

    it('triggers TSL after partial taken if price drops 20% from high', () => {
      const result = layer.shouldExitGake(
        0.001,
        0.0048,  // 20% below high water
        0.006,   // high water
        true     // partial already taken
      );
      expect(result.shouldExit).toBe(true);
      expect(result.exitFraction).toBe(1.0);
      expect(result.reason).toBe('gake_tsl_after_tp');
    });

    it('triggers hard stop at -50% from entry', () => {
      const result = layer.shouldExitGake(
        0.001,
        0.0004,  // down 60%
        0.001,
        false
      );
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('gake_hard_stop_50pct');
    });

    it('holds at small gains with partial not taken', () => {
      const result = layer.shouldExitGake(
        0.001,
        0.0015,  // 50% gain
        0.0016,
        false
      );
      expect(result.shouldExit).toBe(false);
    });
  });
});

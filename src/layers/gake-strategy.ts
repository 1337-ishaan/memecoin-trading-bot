/**
 * Layer 2: Gake Strategy Replicator
 *
 * Implements Gake's documented strategy in code:
 *  - NOT a launch sniper
 *  - Buys tokens at nadir (70-90% off 30d ATH)
 *  - MCap filter: >$100K (preferred >$1M)
 *  - Catalyst scoring: dev activity, community growth, volume trend
 *  - Exits: 50% at 2x, then diamond hands / band trading
 *
 * Reads from the local token_meta_cache. To populate it, run a backfill job
 * (see scripts/backfill-tokens.ts — TODO) or rely on KOL Mirror layer to seed.
 */

import { randomUUID } from 'node:crypto';
import { upsertTokenMeta, getNadirTokens } from '../db/tokens.js';
import { insertSignal } from '../db/signals.js';
import { DexScreenerClient } from '../data/dexscreener.js';
import { BirdeyeClient } from '../data/birdeye.js';
import { PriceOracle } from '../data/oracle.js';
import type { Signal, TokenMeta } from '../signals/types.js';
import { loadConfig } from '../config/index.js';

export interface CatalystScore {
  devActivity: number;        // 0-1
  communityGrowth: number;    // 0-1
  volumeTrend: number;        // 0-1
  holderConcentration: number; // 0-1 (higher = more distributed = better)
  /** Composite weighted score, 0-1 */
  composite: number;
}

export class GakeStrategyLayer {
  private dexscreener: DexScreenerClient;
  private birdeye: BirdeyeClient;
  private oracle: PriceOracle;

  constructor(
    dexscreener: DexScreenerClient,
    birdeye: BirdeyeClient,
    oracle: PriceOracle
  ) {
    this.dexscreener = dexscreener;
    this.birdeye = birdeye;
    this.oracle = oracle;
  }

  /**
   * Score a token's catalyst potential based on available metadata.
   * In production this would query dev wallet activity, social signals, etc.
   * For now, uses proxies from DexScreener/Birdeye.
   */
  scoreCatalysts(meta: TokenMeta): CatalystScore {
    // Dev activity proxy: token still has volume despite being at nadir
    const volumeSustained = (meta.volume24hUsd ?? 0) > 1000;
    const devActivity = volumeSustained ? 0.5 : 0.2;

    // Community growth proxy: holder count present
    const hasHolders = (meta.holderCount ?? 0) > 100;
    const communityGrowth = hasHolders ? 0.6 : 0.3;

    // Volume trend: prefer sustained over spiking
    const volumeTrend = volumeSustained ? 0.5 : 0.2;

    // Holder concentration: lower = better (more distributed)
    const top10 = meta.top10Concentration ?? 1.0;
    const holderConcentration = Math.max(0, 1 - top10);

    const composite =
      devActivity * 0.30 +
      communityGrowth * 0.30 +
      volumeTrend * 0.20 +
      holderConcentration * 0.20;

    return {
      devActivity,
      communityGrowth,
      volumeTrend,
      holderConcentration,
      composite,
    };
  }

  /**
   * Scan the local token cache for nadir candidates.
   * Returns a list of (token, score) pairs.
   */
  scanNadirCandidates(): Array<{ meta: TokenMeta; score: CatalystScore }> {
    const cfg = loadConfig();
    const tokens = getNadirTokens(
      cfg.NADIR_DRAWDOWN_MIN,
      cfg.NADIR_DRAWDOWN_MAX,
      cfg.MCAP_MIN_USD,
      50
    );

    return tokens
      .map((meta) => ({ meta, score: this.scoreCatalysts(meta) }))
      .filter((c) => c.score.composite >= 0.40)
      .sort((a, b) => b.score.composite - a.score.composite);
  }

  /**
   * Emit a buy signal for a specific nadir candidate.
   * Returns null if the token doesn't pass filters.
   */
  emitSignalForToken(mint: string): Signal | null {
    const cfg = loadConfig();
    const meta = (this.scanNadirCandidates().find((c) => c.meta.mint === mint))?.meta;
    if (!meta) return null;

    if (meta.mcapUsd === undefined || meta.mcapUsd < cfg.MCAP_MIN_USD) return null;
    if (meta.drawdownFromAth30d === undefined) return null;
    if (meta.drawdownFromAth30d < cfg.NADIR_DRAWDOWN_MIN) return null;
    if (meta.drawdownFromAth30d > cfg.NADIR_DRAWDOWN_MAX) return null;
    if (meta.mintAuthorityActive) return null;
    if (meta.freezeAuthorityActive) return null;
    if ((meta.liquidityUsd ?? 0) < 5000) return null;

    const score = this.scoreCatalysts(meta);
    const sizePct = Math.min(cfg.MAX_POSITION_PCT / 100, this.sizeForScore(score.composite));

    const signal: Signal = {
      id: randomUUID(),
      source: 'gake_strategy',
      mint,
      symbol: meta.symbol,
      side: 'buy',
      sizePct,
      confidence: score.composite,
      reason: `Gake-strategy nadir: ${meta.symbol} ${(meta.drawdownFromAth30d * 100).toFixed(0)}% off ATH, score ${score.composite.toFixed(2)}, mcap $${(meta.mcapUsd / 1000).toFixed(0)}K`,
      timestamp: Date.now(),
      ttlSeconds: 600, // 10 min — nadir plays are slower
      metadata: {
        drawdown: meta.drawdownFromAth30d,
        mcapUsd: meta.mcapUsd,
        catalystScore: score,
      },
    };
    insertSignal(signal);
    return signal;
  }

  /**
   * Refresh metadata for a specific token from DexScreener + Birdeye.
   * Use this to populate the cache before scanning.
   */
  async refreshTokenMeta(mint: string): Promise<TokenMeta | null> {
    const ds = await this.dexscreener.getTokenMeta(mint);
    if (!ds) return null;

    // Get 30d ATH from Birdeye (if configured)
    let ath30dUsd = ds.priceUsd;
    if (this.birdeye.isConfigured()) {
      const ath = await this.birdeye.getAth30d(mint);
      if (ath) ath30dUsd = ath;
    }

    // Compute drawdown
    const drawdown = ath30dUsd && ds.priceUsd && ath30dUsd > 0
      ? Math.max(0, Math.min(1, 1 - ds.priceUsd / ath30dUsd))
      : undefined;

    const enriched: TokenMeta = {
      ...ds,
      ath30dUsd,
      drawdownFromAth30d: drawdown,
      updatedAt: Date.now(),
    };

    upsertTokenMeta(enriched);
    return enriched;
  }

  /**
   * For an open position, decide whether to take the 50% at 2x exit
   * or trigger a trailing stop loss.
   */
  shouldExitGake(
    entryPrice: number,
    currentPrice: number,
    highWaterPrice: number,
    partialTaken: boolean,
    takeProfit: number = 2.0,
    trailingStopPct: number = 0.20
  ): { shouldExit: boolean; exitFraction: number; reason: string } {
    const gainMultiple = currentPrice / entryPrice;
    const drawdownFromHigh = (highWaterPrice - currentPrice) / highWaterPrice;

    // 50% at 2x
    if (!partialTaken && gainMultiple >= takeProfit) {
      return { shouldExit: true, exitFraction: 0.5, reason: 'gake_tp_50pct_at_2x' };
    }

    // Trailing stop: if we gave back X% from the high water
    if (partialTaken && drawdownFromHigh >= trailingStopPct) {
      return { shouldExit: true, exitFraction: 1.0, reason: 'gake_tsl_after_tp' };
    }

    // Hard stop: -50% from entry (don't hold to zero)
    if (gainMultiple <= 0.5) {
      return { shouldExit: true, exitFraction: 1.0, reason: 'gake_hard_stop_50pct' };
    }

    return { shouldExit: false, exitFraction: 0, reason: 'hold' };
  }

  private sizeForScore(score: number): number {
    // Higher catalyst score = larger position
    if (score >= 0.7) return 0.05;
    if (score >= 0.5) return 0.035;
    return 0.025;
  }
}

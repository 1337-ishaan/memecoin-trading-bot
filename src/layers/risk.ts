/**
 * Layer 5: Risk Manager
 *
 * Pre-trade and post-trade risk checks. Catches things like:
 *  - Per-trade cap (no single position > X% of portfolio)
 *  - Daily loss limit (stop after -Y% in a day)
 *  - Drawdown kill switch (pause if portfolio -Z% from peak)
 *  - Token blacklist (known rugs, honeypots)
 *  - Concentration (max N concurrent positions)
 *  - Cash reserve (always keep W% in SOL)
 */

import { getOpenPositions } from '../db/positions.js';
import { getDailyTradeCount } from '../db/state.js';
import { getPortfolioState, setPortfolioState } from '../db/state.js';
import type { Portfolio, Signal, TokenMeta } from '../signals/types.js';
import { loadConfig } from '../config/index.js';

export interface RiskDecision {
  allow: boolean;
  reason?: string;
  /** If non-zero, overrides the signal's sizePct */
  adjustedSizePct?: number;
}

const KNOWN_HONEYPOT_INDICATORS = {
  /** If mint authority still active, dev can mint more tokens and dump */
  mintAuthority: 'mint_authority_active',
  /** If freeze authority active, dev can freeze copiers' tokens */
  freezeAuthority: 'freeze_authority_active',
  /** If LP not locked, dev can pull liquidity */
  lpNotLocked: 'lp_not_locked',
  /** If top 10 holders own >80%, severe rug risk */
  highConcentration: 'top10_concentration_too_high',
} as const;

export class RiskManager {
  private blacklistMints: Set<string> = new Set();

  /** Compute current portfolio state. */
  computePortfolio(currentPrices: Map<string, number>): Portfolio {
    const state = getPortfolioState();
    const positions = getOpenPositions();
    let positionsValue = 0;
    for (const pos of positions) {
      const price = currentPrices.get(pos.mint) ?? pos.entryPrice;
      positionsValue += pos.amountTokens * price;
    }
    const total = state.cashSol + positionsValue;
    const drawdown = state.peakSol > 0 ? (total - state.peakSol) / state.peakSol : 0;

    return {
      totalSol: total,
      cashSol: state.cashSol,
      positionsSol: positionsValue,
      realizedPnlSol: state.realizedPnlSol,
      unrealizedPnlSol: positionsValue - positions.reduce((s, p) => s + p.amountSol, 0),
      peakSol: state.peakSol,
      drawdownPct: drawdown,
      openPositionCount: positions.length,
    };
  }

  /** Update peak after each portfolio value update. */
  recordPeak(totalSol: number): void {
    const state = getPortfolioState();
    if (totalSol > state.peakSol) {
      state.peakSol = totalSol;
      setPortfolioState(state);
    }
  }

  /** Pre-trade risk check. Returns allow/adjustment. */
  evaluate(signal: Signal, meta?: TokenMeta): RiskDecision {
    const cfg = loadConfig();

    // 1. Token blacklist
    if (this.blacklistMints.has(signal.mint)) {
      return { allow: false, reason: 'token_blacklisted' };
    }

    // 2. Anti-rug from meta
    if (meta) {
      if (meta.mintAuthorityActive) {
        return { allow: false, reason: KNOWN_HONEYPOT_INDICATORS.mintAuthority };
      }
      if (meta.freezeAuthorityActive) {
        return { allow: false, reason: KNOWN_HONEYPOT_INDICATORS.freezeAuthority };
      }
      if (meta.lpLocked === false) {
        return { allow: false, reason: KNOWN_HONEYPOT_INDICATORS.lpNotLocked };
      }
      if ((meta.top10Concentration ?? 0) > 0.8) {
        return { allow: false, reason: KNOWN_HONEYPOT_INDICATORS.highConcentration };
      }
      if ((meta.liquidityUsd ?? 0) < 5000) {
        return { allow: false, reason: 'liquidity_too_low' };
      }
    }

    // 3. Daily trade count cap
    const todayTrades = getDailyTradeCount();
    if (todayTrades >= cfg.MAX_TRADES_PER_DAY) {
      return { allow: false, reason: 'daily_trade_limit' };
    }

    // 4. Position count cap
    const open = getOpenPositions();
    if (open.length >= cfg.MAX_CONCURRENT_POSITIONS) {
      return { allow: false, reason: 'max_concurrent_positions' };
    }

    // 5. Cash reserve
    const state = getPortfolioState();
    const minCash = (cfg.CASH_RESERVE_PCT / 100) * state.peakSol;
    if (state.cashSol < minCash) {
      return { allow: false, reason: 'cash_reserve_floor' };
    }

    // 6. Drawdown kill switch
    const portfolio = this.computePortfolio(new Map());
    if (portfolio.drawdownPct <= -cfg.DRAWDOWN_KILL_SWITCH_PCT / 100) {
      return { allow: false, reason: 'drawdown_kill_switch' };
    }

    // 7. Per-trade size cap
    const maxSize = cfg.MAX_POSITION_PCT / 100;
    const adjustedSizePct = Math.min(signal.sizePct, maxSize);

    return { allow: true, adjustedSizePct };
  }

  /** Add a mint to the blacklist (e.g., after a rug-pull detection). */
  blacklist(mint: string, reason: string): void {
    this.blacklistMints.add(mint);
    console.warn(`[risk] Blacklisted ${mint}: ${reason}`);
  }

  /** Manually clear blacklist. */
  unblacklist(mint: string): void {
    this.blacklistMints.delete(mint);
  }

  getBlacklist(): string[] {
    return Array.from(this.blacklistMints);
  }
}

/**
 * Paper-Trade Engine
 *
 * Simulates trade execution with realistic conditions:
 *  - Latency: 1-10s from signal to fill (we're a follower, not the leader)
 *  - Slippage: based on liquidity & trade size (0.5-25%)
 *  - Priority fee: 0.001-0.05 SOL based on congestion
 *  - Platform fee: 0.8-1% (Trojan/Bloom/Maestro standard)
 *  - DEX fee: 0.25-1% (Jupiter/Raydium)
 *  - Token tax: 0-25% (some scam tokens)
 *
 * After fill, applies Gake's exit rules:
 *  - 50% at 2x (TP)
 *  - Trailing stop after TP
 *  - Hard stop at -50%
 */

import { randomUUID } from 'node:crypto';
import { PriceOracle } from '../data/oracle.js';
import {
  openPosition,
  updatePosition,
  getOpenPositions,
  getPositionByMint,
  insertTrade,
} from '../db/positions.js';
import { getPortfolioState, setPortfolioState, recordDailyTrade, upsertDailyPnl } from '../db/state.js';
import { getTokenMeta } from '../db/tokens.js';
import { GakeStrategyLayer } from '../layers/gake-strategy.js';
import { RiskManager } from '../layers/risk.js';
import type { Position, Trade, TradingMode } from '../signals/types.js';
import type { AggregatedSignal } from '../aggregator/index.js';
import { loadConfig } from '../config/index.js';

const SIM_LATENCY_MIN_MS = 1_000;
const SIM_LATENCY_MAX_MS = 10_000;

const SIM_PRIORITY_FEE_MIN = 0.001;
const SIM_PRIORITY_FEE_MAX = 0.05;

const SIM_PLATFORM_FEE_PCT = 0.01; // 1%
const SIM_DEX_FEE_PCT = 0.003;     // 0.3%

export interface SimFill {
  /** Final price we got after slippage (per token, in USD) */
  fillPriceUsd: number;
  /** Slippage in basis points */
  slippageBps: number;
  /** Latency applied (ms) */
  latencyMs: number;
  /** Priority fee in SOL */
  priorityFeeSol: number;
  /** Platform fee in SOL */
  platformFeeSol: number;
  /** Total cost (SOL) for buys, or proceeds for sells */
  totalCostSol: number;
  /** Number of tokens filled */
  tokensFilled: number;
}

export class PaperTradeEngine {
  private oracle: PriceOracle;
  private risk: RiskManager;
  private gakeStrategy: GakeStrategyLayer;
  private mode: TradingMode;

  constructor(oracle: PriceOracle, risk: RiskManager, gakeStrategy: GakeStrategyLayer) {
    this.oracle = oracle;
    this.risk = risk;
    this.gakeStrategy = gakeStrategy;
    const cfg = loadConfig();
    this.mode = cfg.TRADING_MODE;
  }

  /**
   * Process a buy signal. Returns the fill (or null if rejected).
   * In paper mode, simulates realistic slippage/fees/latency.
   */
  async processBuy(agg: AggregatedSignal): Promise<{ trade: Trade; position: Position } | null> {
    if (agg.side !== 'buy') return null;
    if (!agg.shouldAct) return null;

    // Already in this position?
    const existing = getPositionByMint(agg.mint);
    if (existing) return null;

    // Risk check
    const meta = getTokenMeta(agg.mint) ?? undefined;
    const decision = this.risk.evaluate(
      { ...agg.contributingSignals[0], sizePct: agg.sizePct },
      meta
    );
    if (!decision.allow) {
      console.log(`[paper] buy rejected: ${decision.reason} (${agg.mint})`);
      return null;
    }
    const sizePct = decision.adjustedSizePct ?? agg.sizePct;

    // Simulate latency
    const latencyMs = this.randomLatency();
    await this.sleep(latencyMs);

    // Get current price
    const quote = await this.oracle.getQuote(agg.mint, 0.1);
    if (!quote) {
      console.log(`[paper] no quote for ${agg.mint}`);
      return null;
    }

    // Position sizing
    const state = getPortfolioState();
    const portfolio = this.risk.computePortfolio(new Map());
    const positionSol = portfolio.totalSol * sizePct;

    if (positionSol > state.cashSol) {
      console.log(`[paper] insufficient cash: need ${positionSol} have ${state.cashSol}`);
      return null;
    }

    // Simulate slippage (worse for illiquid tokens)
    const slippageBps = this.simulateSlippageBps(meta?.liquidityUsd ?? 0, positionSol);
    const fillPriceUsd = quote.priceUsd * (1 + slippageBps / 10_000);

    // Compute fees
    const priorityFeeSol = this.randomPriorityFee();
    const platformFeeSol = positionSol * SIM_PLATFORM_FEE_PCT;
    const dexFeeSol = positionSol * SIM_DEX_FEE_PCT;
    const totalFeesSol = priorityFeeSol + platformFeeSol + dexFeeSol;

    const tokensFilled = (positionSol - totalFeesSol) / fillPriceUsd;
    const totalCostSol = positionSol;

    // Open position
    const positionId = openPosition({
      mint: agg.mint,
      symbol: agg.symbol ?? meta?.symbol ?? agg.mint.slice(0, 6),
      entryPrice: fillPriceUsd,
      entryTimestamp: Date.now(),
      amountSol: totalCostSol,
      amountTokens: tokensFilled,
      partialTaken: false,
      highWaterPrice: fillPriceUsd,
      source: agg.contributingSignals[0].source,
      contributingSignals: agg.contributingSignals.map((s) => s.id),
      status: 'open',
    });

    // Record trade
    const trade: Trade = {
      id: 0,
      mint: agg.mint,
      symbol: agg.symbol ?? meta?.symbol ?? agg.mint.slice(0, 6),
      side: 'buy',
      price: fillPriceUsd,
      amountSol: totalCostSol,
      amountTokens: tokensFilled,
      timestamp: Date.now(),
      source: agg.contributingSignals[0].source,
      signalId: agg.contributingSignals[0].id,
      simulatedSlippageBps: slippageBps,
      simulatedPriorityFeeSol: priorityFeeSol,
      simulatedPlatformFeePct: SIM_PLATFORM_FEE_PCT * 100,
      mode: this.mode,
      positionId,
    };
    const tradeId = insertTrade(trade);
    trade.id = tradeId;

    // Update cash
    state.cashSol -= totalCostSol;
    state.totalTrades += 1;
    setPortfolioState(state);
    recordDailyTrade();

    return { trade: { ...trade, id: tradeId }, position: { ...trade, id: positionId, status: 'open' } as unknown as Position };
  }

  /**
   * Process a sell signal. Returns fill or null.
   * For sells we apply the Gake 50%-at-2x rule independently.
   */
  async processSell(agg: AggregatedSignal): Promise<Trade | null> {
    if (agg.side !== 'sell') return null;
    if (!agg.shouldAct) return null;

    const pos = getPositionByMint(agg.mint);
    if (!pos) return null;

    // Simulate latency
    const latencyMs = this.randomLatency();
    await this.sleep(latencyMs);

    const quote = await this.oracle.getQuote(agg.mint, 0.1);
    if (!quote) return null;

    // Decide sell fraction based on Gake rule
    const decision = this.gakeStrategy.shouldExitGake(
      pos.entryPrice,
      quote.priceUsd,
      pos.highWaterPrice,
      pos.partialTaken,
      2.0,
      0.20
    );

    let sellFraction: number;
    if (decision.shouldExit) {
      sellFraction = decision.exitFraction;
    } else if (agg.sizePct < 1) {
      // Explicit partial sell from signal
      sellFraction = agg.sizePct;
    } else {
      // Default: don't blindly copy KOL sells, only exit on Gake rule or hard stop
      console.log(`[paper] sell rejected: Gake rule says hold (${agg.mint})`);
      return null;
    }

    const tokensToSell = pos.amountTokens * sellFraction;
    const meta = getTokenMeta(agg.mint);
    const slippageBps = this.simulateSlippageBps(meta?.liquidityUsd ?? 0, tokensToSell * quote.priceUsd);
    const fillPriceUsd = quote.priceUsd * (1 - slippageBps / 10_000);

    const grossProceedsSol = (tokensToSell * fillPriceUsd) / this.oracle.getSolUsd();
    const priorityFeeSol = this.randomPriorityFee();
    const platformFeeSol = grossProceedsSol * SIM_PLATFORM_FEE_PCT;
    const dexFeeSol = grossProceedsSol * SIM_DEX_FEE_PCT;
    const totalFeesSol = priorityFeeSol + platformFeeSol + dexFeeSol;
    const netProceedsSol = Math.max(0, grossProceedsSol - totalFeesSol);

    const costBasisSol = pos.amountSol * sellFraction;
    const pnlSol = netProceedsSol - costBasisSol;
    const pnlPct = pnlSol / costBasisSol;

    // Record trade
    const trade: Trade = {
      id: 0,
      mint: agg.mint,
      symbol: pos.symbol,
      side: 'sell',
      price: fillPriceUsd,
      amountSol: netProceedsSol,
      amountTokens: tokensToSell,
      timestamp: Date.now(),
      source: agg.contributingSignals[0].source,
      signalId: agg.contributingSignals[0].id,
      simulatedSlippageBps: slippageBps,
      simulatedPriorityFeeSol: priorityFeeSol,
      simulatedPlatformFeePct: SIM_PLATFORM_FEE_PCT * 100,
      mode: this.mode,
      positionId: pos.id,
      pnlSol,
      pnlPct,
    };
    const tradeId = insertTrade(trade);
    trade.id = tradeId;

    // Update position
    const newAmountTokens = pos.amountTokens - tokensToSell;
    const newAmountSol = pos.amountSol - costBasisSol;
    const remaining = newAmountTokens > 0.0001;

    if (remaining) {
      const updates: Partial<Position> = {
        amountTokens: newAmountTokens,
        amountSol: newAmountSol,
      };
      if (sellFraction >= 0.5 && !pos.partialTaken) {
        updates.partialTaken = true;
      }
      updatePosition(pos.id, updates);
    } else {
      updatePosition(pos.id, {
        status: 'closed',
        closeTimestamp: Date.now(),
        closePrice: fillPriceUsd,
        closeReason: decision.reason,
        realizedPnlSol: pnlSol,
        realizedPnlPct: pnlPct,
        amountTokens: 0,
        amountSol: 0,
      });
    }

    // Update cash + PnL
    const state = getPortfolioState();
    state.cashSol += netProceedsSol;
    state.realizedPnlSol += pnlSol;
    setPortfolioState(state);
    recordDailyTrade();
    upsertDailyPnl(new Date().toISOString().slice(0, 10), pnlSol, pnlSol > 0);

    return trade;
  }

  /**
   * Check all open positions against Gake's exit rules.
   * Called every tick to trigger exits that aren't driven by signals.
   */
  async checkOpenPositions(): Promise<Trade[]> {
    const positions = getOpenPositions();
    const exits: Trade[] = [];

    for (const pos of positions) {
      const quote = await this.oracle.getQuote(pos.mint, 0.1);
      if (!quote) continue;

      // Update high water mark
      if (quote.priceUsd > pos.highWaterPrice) {
        updatePosition(pos.id, { highWaterPrice: quote.priceUsd });
      }

      const decision = this.gakeStrategy.shouldExitGake(
        pos.entryPrice,
        quote.priceUsd,
        Math.max(pos.highWaterPrice, quote.priceUsd),
        pos.partialTaken
      );

      if (decision.shouldExit) {
        const sellSignal: AggregatedSignal = {
          mint: pos.mint,
          symbol: pos.symbol,
          side: 'sell',
          sizePct: decision.exitFraction,
          confidence: 0.9,
          reason: `Gake-rule exit: ${decision.reason}`,
          contributingSignals: [{
            id: `gake-exit-${pos.id}`,
            source: 'gake_strategy',
            mint: pos.mint,
            symbol: pos.symbol,
            side: 'sell',
            sizePct: decision.exitFraction,
            confidence: 0.9,
            reason: decision.reason,
            timestamp: Date.now(),
            ttlSeconds: 30,
          }],
          shouldAct: true,
        };
        const trade = await this.processSell(sellSignal);
        if (trade) exits.push(trade);
      }
    }
    return exits;
  }

  private randomLatency(): number {
    return SIM_LATENCY_MIN_MS + Math.random() * (SIM_LATENCY_MAX_MS - SIM_LATENCY_MIN_MS);
  }

  private randomPriorityFee(): number {
    return SIM_PRIORITY_FEE_MIN + Math.random() * (SIM_PRIORITY_FEE_MAX - SIM_PRIORITY_FEE_MIN);
  }

  /**
   * Simulate slippage in basis points based on liquidity and trade size.
   * Low liquidity = more slippage. Larger trade = more slippage.
   */
  private simulateSlippageBps(liquidityUsd: number, tradeSizeUsd: number): number {
    if (liquidityUsd <= 0) return 2500; // 25% cap
    const ratio = tradeSizeUsd / liquidityUsd;
    // 0.5% at ratio=0.001, 5% at ratio=0.1, 25% at ratio=1
    const slippagePct = 0.5 + Math.log10(ratio * 10 + 1) * 10;
    return Math.min(2500, Math.max(50, Math.floor(slippagePct * 100)));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

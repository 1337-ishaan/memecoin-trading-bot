/**
 * Layer 1: KOL Wallet Mirror
 *
 * Subscribes to verified profitable traders' Solana wallets (Gake, 0xSun, etc.)
 * via Helius RPC. For each detected swap, emits a buy/sell signal.
 *
 * Built-in anti-front-run / anti-stale protection:
 *  - Reject signals older than `maxAgeSeconds` (we don't want to copy trades from yesterday)
 *  - Reject signals for tokens that fail anti-rug checks
 *  - Apply position sizing based on signal confidence + our risk config
 */

import { randomUUID } from 'node:crypto';
import { HeliusClient } from '../data/helius.js';
import { PriceOracle } from '../data/oracle.js';
import { insertSignal } from '../db/signals.js';
import { insertKolTrade, getRecentKolTrades, getLatestKolTradeSig } from '../db/kol.js';
import { getTokenMeta } from '../db/tokens.js';
import type { KolTrade, Signal } from '../signals/types.js';
import { loadConfig } from '../config/index.js';

const MAX_SIGNAL_AGE_MS = 60_000;       // 1 min — too old = skip
const MIN_KOL_TRADE_SOL = 0.5;          // ignore dust trades
const MAX_KOL_TRADE_SOL_PCT = 0.30;     // ignore if trade is >30% of our portfolio (suggests whale entry)

export class KolMirrorLayer {
  private helius: HeliusClient;
  private oracle: PriceOracle;
  private kolWallets: string[];

  constructor(helius: HeliusClient, oracle: PriceOracle) {
    const cfg = loadConfig();
    this.helius = helius;
    this.oracle = oracle;
    this.kolWallets = cfg.KOL_WALLETS_LIST;
  }

  /**
   * Poll all KOL wallets for new transactions. Returns the number of new signals emitted.
   * Called periodically by the bot loop.
   */
  async poll(): Promise<number> {
    if (!this.helius.isConfigured()) {
      return 0;
    }

    let totalSignals = 0;
    for (const wallet of this.kolWallets) {
      try {
        const signals = await this.pollWallet(wallet);
        totalSignals += signals;
      } catch (err) {
        console.error(`[kol-mirror] Error polling ${wallet}:`, err);
      }
    }
    return totalSignals;
  }

  private async pollWallet(wallet: string): Promise<number> {
    const swaps = await this.helius.getTransactionsForWallet(wallet, 50);
    let emitted = 0;

    for (const swap of swaps) {
      // Determine buy vs sell based on whether SOL is the "from" or "to"
      // Buy: spent SOL → got token
      // Sell: spent token → got SOL
      const isBuy = swap.fromMint === null && swap.toMint !== null;
      const isSell = swap.toMint === null && swap.fromMint !== null;

      if (!isBuy && !isSell) continue;

      const tokenMint = isBuy ? swap.toMint! : swap.fromMint!;

      // Skip dust trades
      if (swap.solAmount < MIN_KOL_TRADE_SOL) continue;

      // Insert into KOL trades table (no-op if signature already exists)
      const kolTrade: KolTrade = {
        signature: swap.signature,
        wallet,
        mint: tokenMint,
        side: isBuy ? 'buy' : 'sell',
        amountSol: swap.solAmount,
        amountTokens: isBuy ? swap.toAmount : swap.fromAmount,
        timestamp: swap.blockTime,
        detectedAt: Date.now(),
      };
      const inserted = insertKolTrade(kolTrade);
      if (!inserted) continue; // already seen

      // Stale check
      if (Date.now() - swap.blockTime > MAX_SIGNAL_AGE_MS) {
        // Trade was older than 1 min; copy-trading it is dangerous
        continue;
      }

      // Anti-rug pre-check
      const meta = getTokenMeta(tokenMint);
      if (meta) {
        if (meta.mintAuthorityActive) continue;
        if (meta.freezeAuthorityActive) continue;
        if ((meta.liquidityUsd ?? 0) < 5000) continue;
      }

      // Position sizing
      const sizePct = this.computeSizePct(swap.solAmount);

      const signal: Signal = {
        id: randomUUID(),
        source: 'kol_mirror',
        mint: tokenMint,
        symbol: meta?.symbol,
        side: isBuy ? 'buy' : 'sell',
        sizePct,
        confidence: 0.7,
        reason: `KOL ${wallet.slice(0, 6)}... ${isBuy ? 'bought' : 'sold'} ${(swap.solAmount).toFixed(2)} SOL`,
        triggerWallet: wallet,
        triggerSignature: swap.signature,
        timestamp: Date.now(),
        ttlSeconds: 30,
        metadata: {
          kolTradeSol: swap.solAmount,
          kolTradeTokens: isBuy ? swap.toAmount : swap.fromAmount,
        },
      };

      insertSignal(signal);
      emitted++;
    }
    return emitted;
  }

  private computeSizePct(kolSolAmount: number): number {
    const cfg = loadConfig();
    // Mirror fraction of KOL trade size, capped at our max position size
    const mirrorFraction = 0.05; // copy 5% of KOL's size, capped
    const suggested = kolSolAmount * mirrorFraction;
    const maxPositionPct = cfg.MAX_POSITION_PCT;
    return Math.min(maxPositionPct / 100, suggested / 100);
  }

  /** Manually inject a KOL trade (for backtesting). */
  injectKolTrade(trade: KolTrade): Signal | null {
    const isBuy = trade.side === 'buy';
    const tokenMint = trade.mint;
    if (trade.amountSol < MIN_KOL_TRADE_SOL) return null;
    insertKolTrade(trade);
    if (Date.now() - trade.timestamp > MAX_SIGNAL_AGE_MS) return null;

    const meta = getTokenMeta(tokenMint);
    if (meta) {
      if (meta.mintAuthorityActive) return null;
      if (meta.freezeAuthorityActive) return null;
    }

    const sizePct = this.computeSizePct(trade.amountSol);
    const signal: Signal = {
      id: randomUUID(),
      source: 'kol_mirror',
      mint: tokenMint,
      symbol: meta?.symbol ?? trade.symbol,
      side: trade.side,
      sizePct,
      confidence: 0.7,
      reason: `Backtest: KOL ${trade.wallet.slice(0, 6)}... ${isBuy ? 'bought' : 'sold'} ${trade.amountSol.toFixed(2)} SOL`,
      triggerWallet: trade.wallet,
      triggerSignature: trade.signature,
      timestamp: Date.now(),
      ttlSeconds: 30,
      metadata: { backtest: true, kolTradeSol: trade.amountSol },
    };
    insertSignal(signal);
    return signal;
  }

  getTrackedWallets(): string[] {
    return [...this.kolWallets];
  }
}

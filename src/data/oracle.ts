/**
 * Unified price oracle combining DexScreener (metadata) and Jupiter (real-time quotes).
 * For paper trading, this is the source of truth for fills.
 */

import { DexScreenerClient } from './dexscreener.js';
import { JupiterClient } from './jupiter.js';
import { upsertTokenMeta, getTokenMeta } from '../db/tokens.js';
import type { TokenMeta } from '../signals/types.js';

export interface PriceQuote {
  mint: string;
  symbol: string;
  /** Price in USD per 1 token */
  priceUsd: number;
  /** Price in SOL per 1 token (for portfolio math) */
  pricePerTokenSol: number;
  /** Estimated price impact if we trade X SOL */
  priceImpactPct: number;
  /** Total liquidity in USD */
  liquidityUsd: number;
  /** Source that produced the quote */
  source: 'jupiter' | 'dexscreener' | 'cache';
  /** Timestamp of the quote */
  timestamp: number;
}

const SOL_USD = 200; // Approximate; should be refreshed from a price feed

export class PriceOracle {
  constructor(
    private jupiter: JupiterClient,
    private dexscreener: DexScreenerClient
  ) {}

  /** Get a price quote for a token, preferring Jupiter for accuracy. */
  async getQuote(mint: string, solAmount: number = 0.1): Promise<PriceQuote | null> {
    // Try cache first (TTL 30s)
    const cached = getTokenMeta(mint);
    if (cached && Date.now() - cached.updatedAt < 30_000 && cached.priceUsd) {
      return {
        mint,
        symbol: cached.symbol,
        priceUsd: cached.priceUsd,
        pricePerTokenSol: cached.priceUsd / SOL_USD,
        priceImpactPct: 0,
        liquidityUsd: cached.liquidityUsd ?? 0,
        source: 'cache',
        timestamp: Date.now(),
      };
    }

    // Refresh metadata
    let meta: TokenMeta | null = cached;
    if (!meta || Date.now() - meta.updatedAt > 5 * 60_000) {
      try {
        const fresh = await this.dexscreener.getTokenMeta(mint);
        if (fresh) {
          meta = fresh;
          upsertTokenMeta(fresh);
        }
      } catch (err) {
        console.warn(`[oracle] DexScreener refresh failed for ${mint.slice(0, 8)}...: ${(err as Error).message.slice(0, 100)}`);
      }
    }

    if (!meta) return null;

    // Try Jupiter for real-time quote (price impact) — gracefully fall back on failure
    let jupQuote: { pricePerTokenSol: number; priceImpactPct: number } | null = null;
    try {
      jupQuote = await this.jupiter.getSolToTokenPrice(mint, solAmount);
    } catch (err) {
      // Network/DNS failure — log once per minute, then fall back
      if (Math.random() < 0.1) {
        console.warn(`[oracle] Jupiter unavailable: ${(err as Error).message.slice(0, 80)}`);
      }
    }

    if (jupQuote && meta.priceUsd) {
      // Cross-check: Jupiter price (via SOL) vs DexScreener price (USD)
      const jupPriceUsd = jupQuote.pricePerTokenSol * SOL_USD;
      const drift = Math.abs(jupPriceUsd - meta.priceUsd) / meta.priceUsd;
      const priceUsd = drift < 0.20 ? (jupPriceUsd + meta.priceUsd) / 2 : meta.priceUsd;

      return {
        mint,
        symbol: meta.symbol,
        priceUsd,
        pricePerTokenSol: priceUsd / SOL_USD,
        priceImpactPct: jupQuote.priceImpactPct,
        liquidityUsd: meta.liquidityUsd ?? 0,
        source: 'jupiter',
        timestamp: Date.now(),
      };
    }

    if (meta.priceUsd) {
      return {
        mint,
        symbol: meta.symbol,
        priceUsd: meta.priceUsd,
        pricePerTokenSol: meta.priceUsd / SOL_USD,
        priceImpactPct: 0,
        liquidityUsd: meta.liquidityUsd ?? 0,
        source: 'dexscreener',
        timestamp: Date.now(),
      };
    }

    return null;
  }

  /** Get USD price of SOL (for portfolio valuation). */
  getSolUsd(): number {
    return SOL_USD;
  }
}

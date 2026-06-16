/**
 * DexScreener API client.
 * Used for token metadata, price, market cap, volume, liquidity.
 * Free, no API key required, generous rate limits.
 *
 * https://api.dexscreener.com/latest
 */

import { loadConfig } from '../config/index.js';
import type { TokenMeta } from '../signals/types.js';

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: { h1?: { buys: number; sells: number }; h24?: { buys: number; sells: number } };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

export class DexScreenerClient {
  private baseUrl: string;

  constructor() {
    const cfg = loadConfig();
    this.baseUrl = cfg.DEXSCREENER_API_URL;
  }

  isConfigured(): boolean {
    return true; // DexScreener free API requires no key
  }

  async getPairsByToken(mint: string): Promise<DexScreenerPair[]> {
    const url = `${this.baseUrl}/dex/tokens/${mint}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`DexScreener error ${response.status} for ${mint}: ${await response.text()}`);
    }
    const data = (await response.json()) as { pairs?: DexScreenerPair[] };
    return data.pairs ?? [];
  }

  async getTokenMeta(mint: string): Promise<TokenMeta | null> {
    try {
      const pairs = await this.getPairsByToken(mint);
      if (pairs.length === 0) return null;
      // Pick the highest-liquidity Solana pair
      const solPairs = pairs
        .filter((p) => p.chainId === 'solana')
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const best = solPairs[0];
      if (!best) return null;

      const priceUsd = best.priceUsd ? parseFloat(best.priceUsd) : undefined;
      const mcapUsd = best.marketCap ?? best.fdv;
      const liquidityUsd = best.liquidity?.usd;

      // We don't get 30d ATH from DexScreener directly; we'd need historical data
      // We'll approximate drawdown from 24h change as a weak proxy in the meta-cache layer
      return {
        mint,
        symbol: best.baseToken.symbol,
        name: best.baseToken.name,
        decimals: 9, // Default for Solana SPL; refine if needed
        mcapUsd,
        liquidityUsd,
        priceUsd,
        volume24hUsd: best.volume?.h24,
        updatedAt: Date.now(),
      };
    } catch (err) {
      console.error(`[dexscreener] Failed to get meta for ${mint}:`, err);
      return null;
    }
  }

  /** Search for tokens by query string. */
  async searchTokens(query: string): Promise<DexScreenerPair[]> {
    const url = `${this.baseUrl}/dex/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`DexScreener search error ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as { pairs?: DexScreenerPair[] };
    return (data.pairs ?? []).filter((p) => p.chainId === 'solana');
  }
}

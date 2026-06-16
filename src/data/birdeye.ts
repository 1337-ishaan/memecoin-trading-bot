/**
 * Birdeye API client (optional — paid tier).
 * Used for OHLCV, holder history, dev wallet activity.
 * Falls back gracefully when no API key is configured.
 *
 * https://public-api.birdeye.so
 */

import { loadConfig } from '../config/index.js';
import type { TokenMeta } from '../signals/types.js';

interface BirdeyeOhlcvResponse {
  data?: {
    items?: Array<{
      unixTime: number;
      o: number;
      h: number;
      l: number;
      c: number;
      v: number;
    }>;
  };
}

export class BirdeyeClient {
  private apiKey: string;
  private baseUrl: string = 'https://public-api.birdeye.so';

  constructor() {
    const cfg = loadConfig();
    this.apiKey = cfg.BIRDEYE_API_KEY;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private async fetch<T>(path: string): Promise<T | null> {
    if (!this.isConfigured()) {
      return null;
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        'X-API-KEY': this.apiKey,
        'x-chain': 'solana',
      },
    });
    if (!response.ok) {
      console.warn(`[birdeye] ${path} returned ${response.status}`);
      return null;
    }
    return (await response.json()) as T;
  }

  /**
   * Get OHLCV for a token. Returns the highest price in the window (used as ATH proxy).
   */
  async getAth30d(mint: string): Promise<number | null> {
    const data = await this.fetch<BirdeyeOhlcvResponse>(
      `/defi/ohlcv?address=${mint}&type=1D&time_from=${Math.floor(Date.now() / 1000) - 30 * 86400}&time_to=${Math.floor(Date.now() / 1000)}`
    );
    if (!data?.data?.items || data.data.items.length === 0) return null;
    const ath = Math.max(...data.data.items.map((i) => i.h));
    return ath;
  }

  async getTokenOverview(mint: string): Promise<Partial<TokenMeta> | null> {
    const data = await this.fetch<{ data?: any }>(`/defi/token_overview?address=${mint}`);
    if (!data?.data) return null;
    const d = data.data;
    return {
      mcapUsd: d.mc,
      liquidityUsd: d.liquidity,
      priceUsd: d.price,
      volume24hUsd: d.v24hUSD,
      holderCount: d.holder,
    };
  }
}

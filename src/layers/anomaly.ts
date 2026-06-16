/**
 * Layer 4: Anomaly Detector
 *
 * Watches for unusual on-chain activity before it hits leaderboards:
 *  - New mints with concentrated dev/insider accumulation
 *  - Sudden volume spikes on quiet tokens
 *  - Smart wallet clusters buying the same token
 *
 * For v1 this is a placeholder/stub — would integrate Helius webhooks +
 * gRPC for real-time monitoring. Most signal value comes from
 * (a) DexScreener trending tokens (we already have this) and
 * (b) Helius transaction monitoring on a list of smart wallets.
 */

import type { Signal } from '../signals/types.js';

export interface AnomalyConfig {
  /** Minimum number of smart wallets buying same token within window to trigger */
  clusterThreshold: number;
  /** Window in ms to check for clusters */
  clusterWindowMs: number;
  /** Min volume spike ratio (current 5min volume vs avg 1h) */
  volumeSpikeRatio: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  clusterThreshold: 3,
  clusterWindowMs: 5 * 60 * 1000, // 5 min
  volumeSpikeRatio: 5,
};

export interface ClusterEvent {
  mint: string;
  symbol?: string;
  smartWallets: string[];
  detectedAt: number;
  /** Aggregate SOL spent in cluster */
  totalSol: number;
}

export class AnomalyLayer {
  private config: AnomalyConfig;
  /** Recent buys per token: mint → list of (wallet, timestamp, solAmount) */
  private recentBuys: Map<string, Array<{ wallet: string; ts: number; sol: number }>> = new Map();

  constructor(config: AnomalyConfig = DEFAULT_ANOMALY_CONFIG) {
    this.config = config;
  }

  /**
   * Feed a detected buy (from Helius or any other source) into the cluster detector.
   * Returns a Signal if a cluster is detected.
   */
  recordBuy(wallet: string, mint: string, solAmount: number, ts: number = Date.now()): Signal | null {
    if (!this.recentBuys.has(mint)) this.recentBuys.set(mint, []);
    const list = this.recentBuys.get(mint)!;
    list.push({ wallet, ts, sol: solAmount });

    // Prune
    const cutoff = ts - this.config.clusterWindowMs;
    while (list.length > 0 && list[0].ts < cutoff) list.shift();

    // Count unique wallets in window
    const uniqueWallets = new Set(list.map((b) => b.wallet));
    if (uniqueWallets.size >= this.config.clusterThreshold) {
      const totalSol = list.reduce((s, b) => s + b.sol, 0);
      const signal: Signal = {
        id: `anomaly-${mint}-${ts}`,
        source: 'anomaly',
        mint,
        side: 'buy',
        sizePct: 0.02,
        confidence: Math.min(0.9, 0.5 + uniqueWallets.size * 0.1),
        reason: `Smart-wallet cluster: ${uniqueWallets.size} wallets bought in ${this.config.clusterWindowMs / 1000}s (${totalSol.toFixed(2)} SOL)`,
        timestamp: ts,
        ttlSeconds: 60,
        metadata: {
          clusterSize: uniqueWallets.size,
          totalSol,
        },
      };
      return signal;
    }
    return null;
  }

  /** Prune old entries to prevent memory leak. */
  prune(): void {
    const cutoff = Date.now() - this.config.clusterWindowMs;
    for (const [mint, list] of this.recentBuys) {
      while (list.length > 0 && list[0].ts < cutoff) list.shift();
      if (list.length === 0) this.recentBuys.delete(mint);
    }
  }
}

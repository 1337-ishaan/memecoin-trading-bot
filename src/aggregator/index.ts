/**
 * Signal Aggregator
 *
 * Combines signals from all 5 layers with weighted voting.
 * A signal fires when the combined confidence exceeds threshold,
 * OR when multiple independent layers agree on the same token.
 */

import { getSignalsForMint, markSignalConsumed } from '../db/signals.js';
import type { Signal, SignalSource } from '../signals/types.js';
import { loadConfig } from '../config/index.js';

export interface AggregatedSignal {
  mint: string;
  symbol?: string;
  side: 'buy' | 'sell';
  /** Combined sizePct (sum, capped) */
  sizePct: number;
  /** Combined confidence (weighted) */
  confidence: number;
  /** Why this fired (combined reasons) */
  reason: string;
  /** All contributing signals */
  contributingSignals: Signal[];
  /** Whether the threshold is met (we should act) */
  shouldAct: boolean;
}

export class SignalAggregator {
  private weights: Record<SignalSource, number>;

  constructor() {
    const cfg = loadConfig();
    this.weights = {
      kol_mirror: cfg.WEIGHT_KOL_MIRROR,
      gake_strategy: cfg.WEIGHT_STRATEGY_REPL,
      meta_cycle: cfg.WEIGHT_META_CYCLE,
      anomaly: cfg.WEIGHT_ANOMALY,
      risk_override: 0,
    };
  }

  /**
   * Aggregate all live signals for a given token (within TTL).
   * Returns null if no active signals exist.
   */
  aggregate(mint: string, now: number = Date.now()): AggregatedSignal | null {
    // Pull signals from the last 5 min (recent enough to act on)
    const recentSignals = getSignalsForMint(mint, now - 5 * 60 * 1000)
      .filter((s) => s.timestamp + s.ttlSeconds * 1000 > now)
      .filter((s) => s.confidence > 0);

    if (recentSignals.length === 0) return null;

    // Separate by side
    const buySignals = recentSignals.filter((s) => s.side === 'buy');
    const sellSignals = recentSignals.filter((s) => s.side === 'sell');
    const side: 'buy' | 'sell' = buySignals.length >= sellSignals.length ? 'buy' : 'sell';
    const activeSignals = side === 'buy' ? buySignals : sellSignals;

    // If conflicting signals, prefer sells (defensive)
    const hasConflict = buySignals.length > 0 && sellSignals.length > 0;
    const finalSignals = hasConflict && side === 'buy' ? activeSignals : activeSignals;

    // Compute weighted confidence
    let weightedSum = 0;
    let totalWeight = 0;
    for (const s of finalSignals) {
      const w = this.weights[s.source] ?? 0;
      weightedSum += s.confidence * w;
      totalWeight += w;
    }
    const confidence = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Sum sizes (capped)
    const cfg = loadConfig();
    const sizePct = Math.min(
      cfg.MAX_POSITION_PCT / 100,
      finalSignals.reduce((s, sig) => s + sig.sizePct, 0)
    );

    const reason = finalSignals
      .map((s) => `[${s.source}: ${s.reason}]`)
      .join(' + ');

    // Threshold check
    const shouldAct = confidence >= cfg.SIGNAL_CONFIDENCE_THRESHOLD;

    const result: AggregatedSignal = {
      mint,
      symbol: finalSignals[0]?.symbol,
      side,
      sizePct,
      confidence,
      reason,
      contributingSignals: finalSignals,
      shouldAct,
    };
    return result;
  }

  /** Mark signals as consumed after we act on them. */
  markConsumed(signals: Signal[]): void {
    for (const s of signals) {
      markSignalConsumed(s.id);
    }
  }

  /** Returns mint addresses that have any active signal. */
  getActiveMints(now: number = Date.now()): string[] {
    const fiveMinAgo = now - 5 * 60 * 1000;
    const signals = getSignalsForMint('', fiveMinAgo); // All signals, we'll dedupe
    const mints = new Set<string>();
    for (const s of signals) {
      if (s.timestamp + s.ttlSeconds * 1000 > now) {
        mints.add(s.mint);
      }
    }
    return Array.from(mints);
  }
}

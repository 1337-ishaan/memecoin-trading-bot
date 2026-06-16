import type { Signal } from '../signals/types.js';
import { getDb } from './index.js';

export function insertSignal(signal: Signal): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO signals
      (id, source, mint, symbol, side, size_pct, confidence, reason,
       trigger_wallet, trigger_signature, timestamp, ttl_seconds, metadata, consumed)
    VALUES
      (@id, @source, @mint, @symbol, @side, @sizePct, @confidence, @reason,
       @triggerWallet, @triggerSignature, @timestamp, @ttlSeconds, @metadata, 0)
  `).run({
    id: signal.id,
    source: signal.source,
    mint: signal.mint,
    symbol: signal.symbol ?? null,
    side: signal.side,
    sizePct: signal.sizePct,
    confidence: signal.confidence,
    reason: signal.reason,
    triggerWallet: signal.triggerWallet ?? null,
    triggerSignature: signal.triggerSignature ?? null,
    timestamp: signal.timestamp,
    ttlSeconds: signal.ttlSeconds,
    metadata: signal.metadata ? JSON.stringify(signal.metadata) : null,
  });
}

export function getRecentSignals(sinceMs: number, limit: number = 100): Signal[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM signals
    WHERE timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(sinceMs, limit) as any[];

  return rows.map(rowToSignal);
}

export function getSignalsForMint(mint: string, sinceMs: number): Signal[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM signals
    WHERE mint = ? AND timestamp >= ?
    ORDER BY timestamp DESC
  `).all(mint, sinceMs) as any[];
  return rows.map(rowToSignal);
}

export function markSignalConsumed(id: string): void {
  const db = getDb();
  db.prepare(`UPDATE signals SET consumed = 1 WHERE id = ?`).run(id);
}

function rowToSignal(row: any): Signal {
  return {
    id: row.id,
    source: row.source,
    mint: row.mint,
    symbol: row.symbol ?? undefined,
    side: row.side,
    sizePct: row.size_pct,
    confidence: row.confidence,
    reason: row.reason,
    triggerWallet: row.trigger_wallet ?? undefined,
    triggerSignature: row.trigger_signature ?? undefined,
    timestamp: row.timestamp,
    ttlSeconds: row.ttl_seconds,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

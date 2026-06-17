import type { KolTrade } from '../signals/types.js';
import { getDb } from './index.js';

export function insertKolTrade(trade: KolTrade): boolean {
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO kol_trades
      (signature, wallet, mint, symbol, side, amount_sol, amount_tokens, price_usd, timestamp, detected_at)
    VALUES
      (@signature, @wallet, @mint, @symbol, @side, @amountSol, @amountTokens, @priceUsd, @timestamp, @detectedAt)
  `).run({
    signature: trade.signature,
    wallet: trade.wallet,
    mint: trade.mint,
    symbol: trade.symbol ?? null,
    side: trade.side,
    amountSol: trade.amountSol,
    amountTokens: trade.amountTokens,
    priceUsd: trade.priceUsd ?? null,
    timestamp: trade.timestamp,
    detectedAt: trade.detectedAt,
  });
  return result.changes > 0;
}

export function getRecentKolTrades(wallet: string, sinceMs: number, limit: number = 100): KolTrade[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM kol_trades
    WHERE wallet = ? AND timestamp >= ?
    ORDER BY timestamp DESC LIMIT ?
  `).all(wallet, sinceMs, limit) as any[];
  return rows.map(rowToKolTrade);
}

export function getLatestKolTradeSig(wallet: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT signature FROM kol_trades WHERE wallet = ? ORDER BY timestamp DESC LIMIT 1
  `).get(wallet) as any;
  return row?.signature ?? null;
}

function rowToKolTrade(row: any): KolTrade {
  return {
    signature: row.signature,
    wallet: row.wallet,
    mint: row.mint,
    symbol: row.symbol ?? undefined,
    side: row.side,
    amountSol: row.amount_sol,
    amountTokens: row.amount_tokens,
    priceUsd: row.price_usd ?? undefined,
    timestamp: row.timestamp,
    detectedAt: row.detected_at,
  };
}

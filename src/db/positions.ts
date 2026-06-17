import type { Position, Trade } from '../signals/types.js';
import { getDb } from './index.js';

export function openPosition(pos: Omit<Position, 'id'>): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO positions
      (mint, symbol, entry_price, entry_timestamp, amount_sol, amount_tokens,
       partial_taken, high_water_price, source, contributing_signals, status)
    VALUES
      (@mint, @symbol, @entryPrice, @entryTimestamp, @amountSol, @amountTokens,
       @partialTaken, @highWaterPrice, @source, @contributingSignals, @status)
  `).run({
    mint: pos.mint,
    symbol: pos.symbol,
    entryPrice: pos.entryPrice,
    entryTimestamp: pos.entryTimestamp,
    amountSol: pos.amountSol,
    amountTokens: pos.amountTokens,
    partialTaken: pos.partialTaken ? 1 : 0,
    highWaterPrice: pos.highWaterPrice,
    source: pos.source,
    contributingSignals: JSON.stringify(pos.contributingSignals),
    status: pos.status,
  });
  return Number(result.lastInsertRowid);
}

export function updatePosition(id: number, updates: Partial<Position>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: any = { id };

  const fieldMap: Record<string, string> = {
    partialTaken: 'partial_taken',
    highWaterPrice: 'high_water_price',
    status: 'status',
    closeTimestamp: 'close_timestamp',
    closePrice: 'close_price',
    closeReason: 'close_reason',
    realizedPnlSol: 'realized_pnl_sol',
    realizedPnlPct: 'realized_pnl_pct',
  };

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const col = fieldMap[key];
    if (!col) continue;
    setClauses.push(`${col} = @${key}`);
    values[key] = value;
  }

  if (setClauses.length === 0) return;

  db.prepare(`UPDATE positions SET ${setClauses.join(', ')} WHERE id = @id`).run(values);
}

export function getOpenPositions(): Position[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM positions WHERE status = 'open' ORDER BY entry_timestamp ASC
  `).all() as any[];
  return rows.map(rowToPosition);
}

export function getPositionByMint(mint: string): Position | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM positions WHERE mint = ? AND status = 'open' LIMIT 1
  `).get(mint) as any;
  return row ? rowToPosition(row) : null;
}

export function getPositionById(id: number): Position | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM positions WHERE id = ?`).get(id) as any;
  return row ? rowToPosition(row) : null;
}

export function insertTrade(trade: Omit<Trade, 'id'>): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO trades
      (mint, symbol, side, price, amount_sol, amount_tokens, timestamp,
       signature, source, signal_id, simulated_slippage_bps, simulated_priority_fee_sol,
       simulated_platform_fee_pct, mode, position_id, pnl_sol, pnl_pct)
    VALUES
      (@mint, @symbol, @side, @price, @amountSol, @amountTokens, @timestamp,
       @signature, @source, @signalId, @simulatedSlippageBps, @simulatedPriorityFeeSol,
       @simulatedPlatformFeePct, @mode, @positionId, @pnlSol, @pnlPct)
  `).run({
    mint: trade.mint,
    symbol: trade.symbol,
    side: trade.side,
    price: trade.price,
    amountSol: trade.amountSol,
    amountTokens: trade.amountTokens,
    timestamp: trade.timestamp,
    signature: trade.signature ?? null,
    source: trade.source,
    signalId: trade.signalId ?? null,
    simulatedSlippageBps: trade.simulatedSlippageBps ?? null,
    simulatedPriorityFeeSol: trade.simulatedPriorityFeeSol ?? null,
    simulatedPlatformFeePct: trade.simulatedPlatformFeePct ?? null,
    mode: trade.mode,
    positionId: trade.positionId ?? null,
    pnlSol: trade.pnlSol ?? null,
    pnlPct: trade.pnlPct ?? null,
  });
  return Number(result.lastInsertRowid);
}

export function getTradesForPosition(positionId: number): Trade[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM trades WHERE position_id = ? ORDER BY timestamp ASC
  `).all(positionId) as any[];
  return rows.map(rowToTrade);
}

export function getRecentTrades(limit: number = 100): Trade[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?
  `).all(limit) as any[];
  return rows.map(rowToTrade);
}

function rowToPosition(row: any): Position {
  return {
    id: row.id,
    mint: row.mint,
    symbol: row.symbol,
    entryPrice: row.entry_price,
    entryTimestamp: row.entry_timestamp,
    amountSol: row.amount_sol,
    amountTokens: row.amount_tokens,
    partialTaken: row.partial_taken === 1,
    highWaterPrice: row.high_water_price,
    source: row.source,
    contributingSignals: JSON.parse(row.contributing_signals || '[]'),
    status: row.status,
    closeTimestamp: row.close_timestamp ?? undefined,
    closePrice: row.close_price ?? undefined,
    closeReason: row.close_reason ?? undefined,
    realizedPnlSol: row.realized_pnl_sol ?? undefined,
    realizedPnlPct: row.realized_pnl_pct ?? undefined,
  };
}

function rowToTrade(row: any): Trade {
  return {
    id: row.id,
    mint: row.mint,
    symbol: row.symbol,
    side: row.side,
    price: row.price,
    amountSol: row.amount_sol,
    amountTokens: row.amount_tokens,
    timestamp: row.timestamp,
    signature: row.signature ?? undefined,
    source: row.source,
    signalId: row.signal_id ?? undefined,
    simulatedSlippageBps: row.simulated_slippage_bps ?? undefined,
    simulatedPriorityFeeSol: row.simulated_priority_fee_sol ?? undefined,
    simulatedPlatformFeePct: row.simulated_platform_fee_pct ?? undefined,
    mode: row.mode,
    positionId: row.position_id ?? undefined,
    pnlSol: row.pnl_sol ?? undefined,
    pnlPct: row.pnl_pct ?? undefined,
  };
}

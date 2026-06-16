import { getDb } from './index.js';
import { loadConfig } from '../config/index.js';

const PORTFOLIO_KEY = 'portfolio';
const DAILY_TRADE_COUNT_KEY = 'daily_trade_count';
const DAILY_DATE_KEY = 'daily_date';

interface PortfolioState {
  cashSol: number;
  realizedPnlSol: number;
  peakSol: number;
  totalTrades: number;
}

export function getPortfolioState(): PortfolioState {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM bot_state WHERE key = ?`).get(PORTFOLIO_KEY) as any;
  if (!row) {
    const cfg = loadConfig();
    const initial: PortfolioState = {
      cashSol: cfg.TRADING_MODE === 'paper' ? cfg.PAPER_INITIAL_SOL : 0,
      realizedPnlSol: 0,
      peakSol: cfg.PAPER_INITIAL_SOL,
      totalTrades: 0,
    };
    setPortfolioState(initial);
    return initial;
  }
  return JSON.parse(row.value);
}

export function setPortfolioState(state: PortfolioState): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)
  `).run(PORTFOLIO_KEY, JSON.stringify(state));
}

export function recordDailyTrade(): void {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const dateRow = db.prepare(`SELECT value FROM bot_state WHERE key = ?`).get(DAILY_DATE_KEY) as any;
  if (dateRow?.value !== today) {
    db.prepare(`INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)`)
      .run(DAILY_DATE_KEY, today);
    db.prepare(`INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)`)
      .run(DAILY_TRADE_COUNT_KEY, '0');
  }
  const countRow = db.prepare(`SELECT value FROM bot_state WHERE key = ?`).get(DAILY_TRADE_COUNT_KEY) as any;
  const count = parseInt(countRow?.value ?? '0', 10) + 1;
  db.prepare(`INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)`)
    .run(DAILY_TRADE_COUNT_KEY, String(count));
}

export function getDailyTradeCount(): number {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const dateRow = db.prepare(`SELECT value FROM bot_state WHERE key = ?`).get(DAILY_DATE_KEY) as any;
  if (dateRow?.value !== today) return 0;
  const countRow = db.prepare(`SELECT value FROM bot_state WHERE key = ?`).get(DAILY_TRADE_COUNT_KEY) as any;
  return parseInt(countRow?.value ?? '0', 10);
}

export function upsertDailyPnl(date: string, realizedPnl: number, isWin: boolean): void {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM daily_pnl WHERE date = ?`).get(date) as any;
  if (row) {
    const winInc = isWin ? 1 : 0;
    const lossInc = isWin ? 0 : 1;
    db.prepare(`
      UPDATE daily_pnl SET
        realized_pnl_sol = realized_pnl_sol + ?,
        trade_count = trade_count + 1,
        win_count = win_count + ?,
        loss_count = loss_count + ?
      WHERE date = ?
    `).run(realizedPnl, winInc, lossInc, date);
  } else {
    db.prepare(`
      INSERT INTO daily_pnl (date, realized_pnl_sol, trade_count, win_count, loss_count)
      VALUES (?, ?, 1, ?, ?)
    `).run(date, realizedPnl, isWin ? 1 : 0, isWin ? 0 : 1);
  }
}

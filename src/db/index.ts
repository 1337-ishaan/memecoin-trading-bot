import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_DB_PATH = join(__dirname, '..', '..', 'data', 'bot.db');

let _db: Database.Database | null = null;

export function getDb(path: string = DEFAULT_DB_PATH): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  applyMigrations(_db);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      side TEXT NOT NULL,
      size_pct REAL NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT NOT NULL,
      trigger_wallet TEXT,
      trigger_signature TEXT,
      timestamp INTEGER NOT NULL,
      ttl_seconds INTEGER NOT NULL,
      metadata TEXT,
      consumed INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_signals_mint ON signals(mint);
    CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
    CREATE INDEX IF NOT EXISTS idx_signals_consumed ON signals(consumed);

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      symbol TEXT NOT NULL,
      entry_price REAL NOT NULL,
      entry_timestamp INTEGER NOT NULL,
      amount_sol REAL NOT NULL,
      amount_tokens REAL NOT NULL,
      partial_taken INTEGER NOT NULL DEFAULT 0,
      high_water_price REAL NOT NULL,
      source TEXT NOT NULL,
      contributing_signals TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'open',
      close_timestamp INTEGER,
      close_price REAL,
      close_reason TEXT,
      realized_pnl_sol REAL,
      realized_pnl_pct REAL
    );

    CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_entry ON positions(entry_timestamp);

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      amount_sol REAL NOT NULL,
      amount_tokens REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      signature TEXT,
      source TEXT NOT NULL,
      signal_id TEXT,
      simulated_slippage_bps REAL,
      simulated_priority_fee_sol REAL,
      simulated_platform_fee_pct REAL,
      mode TEXT NOT NULL,
      position_id INTEGER,
      pnl_sol REAL,
      pnl_pct REAL
    );

    CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_trades_position ON trades(position_id);

    CREATE TABLE IF NOT EXISTS token_meta_cache (
      mint TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      mcap_usd REAL,
      liquidity_usd REAL,
      price_usd REAL,
      volume_24h_usd REAL,
      ath_30d_usd REAL,
      atl_30d_usd REAL,
      drawdown_from_ath_30d REAL,
      holder_count INTEGER,
      top10_concentration REAL,
      mint_authority_active INTEGER,
      freeze_authority_active INTEGER,
      lp_locked INTEGER,
      genre TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_token_meta_mcap ON token_meta_cache(mcap_usd);
    CREATE INDEX IF NOT EXISTS idx_token_meta_drawdown ON token_meta_cache(drawdown_from_ath_30d);
    CREATE INDEX IF NOT EXISTS idx_token_meta_updated ON token_meta_cache(updated_at);

    CREATE TABLE IF NOT EXISTS kol_trades (
      signature TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      side TEXT NOT NULL,
      amount_sol REAL NOT NULL,
      amount_tokens REAL NOT NULL,
      price_usd REAL,
      timestamp INTEGER NOT NULL,
      detected_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kol_trades_wallet ON kol_trades(wallet);
    CREATE INDEX IF NOT EXISTS idx_kol_trades_mint ON kol_trades(mint);
    CREATE INDEX IF NOT EXISTS idx_kol_trades_timestamp ON kol_trades(timestamp);

    CREATE TABLE IF NOT EXISTS daily_pnl (
      date TEXT PRIMARY KEY,
      realized_pnl_sol REAL NOT NULL DEFAULT 0,
      trade_count INTEGER NOT NULL DEFAULT 0,
      win_count INTEGER NOT NULL DEFAULT 0,
      loss_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

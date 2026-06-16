#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Commands:
 *   start              Start the bot (default: paper mode)
 *   start --mode live  Start in live mode
 *   stop               Signal the running bot to stop (via pid file)
 *   status             Show current portfolio + open positions
 *   signals            Show recent signals (last 24h)
 *   pnl                Show PnL breakdown
 *   backtest           Backtest a KOL wallet
 *   config             Show current configuration
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resetConfigCache } from './config/index.js';
import { getDb, closeDb } from './db/index.js';
import { getOpenPositions, getRecentTrades } from './db/positions.js';
import { getRecentSignals } from './db/signals.js';
import { getPortfolioState } from './db/state.js';
import { Bot } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PID_FILE = join(__dirname, '..', 'data', 'bot.pid');

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { command: 'help', flags: {} };
  }
  const command = args[0];
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { command, flags };
}

function printHelp(): void {
  console.log(`
memecoin-trading-bot — Solana memecoin trading bot

Usage: npm run cli -- <command> [options]

Commands:
  start              Start the bot in paper mode
    --mode <mode>    'paper' (default) or 'live'
  stop               Stop the running bot
  status             Show current portfolio + open positions
  signals            Show recent signals (last 24h)
    --limit <n>      Number of signals to show (default 20)
  pnl                Show PnL breakdown
    --days <n>       Show last N days (default 30)
  backtest           Backtest a KOL wallet's trades
    --kol <address>  KOL wallet address
    --days <n>       Days to backtest (default 30)
  config             Show current configuration
  help               Show this help

Default: bot runs in paper mode (no real money). Set HELIUS_API_KEY
in .env to enable live KOL mirroring. To go live, set TRADING_MODE=live
and configure an execution platform.
`);
}

async function cmdStart(flags: Record<string, string | boolean>): Promise<void> {
  // Set mode if specified
  if (flags.mode === 'live') {
    process.env.TRADING_MODE = 'live';
    resetConfigCache();
    const cfg = loadConfig();
    if (!cfg.HELIUS_API_KEY) {
      console.error('❌ HELIUS_API_KEY is required for live mode. Aborting.');
      process.exit(1);
    }
    if (cfg.EXECUTION_PLATFORM === 'none') {
      console.error('❌ EXECUTION_PLATFORM must be set (trojan/maestro) for live mode. Aborting.');
      process.exit(1);
    }
  } else {
    process.env.TRADING_MODE = 'paper';
    resetConfigCache();
  }

  // Write PID file
  writeFileSync(PID_FILE, String(process.pid));

  const bot = new Bot();

  // Graceful shutdown
  const shutdown = () => {
    bot.stop();
    try {
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } catch {
      // PID file already gone
    }
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}

function cmdStop(): void {
  if (!existsSync(PID_FILE)) {
    console.log('No bot running (no PID file)');
    return;
  }
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8'), 10);
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to bot (pid ${pid})`);
  } catch (err) {
    console.log(`Bot not running (pid ${pid} not found)`);
  }
  try {
    unlinkSync(PID_FILE);
  } catch {
    // PID file already gone
  }
}

function cmdStatus(): void {
  const db = getDb();
  const positions = getOpenPositions();
  const state = getPortfolioState();
  const positionsValue = positions.reduce((s, p) => s + p.amountSol, 0);
  const total = state.cashSol + positionsValue;

  console.log('\n=== PORTFOLIO ===');
  console.log(`Cash:          ${state.cashSol.toFixed(4)} SOL`);
  console.log(`Positions:     ${positionsValue.toFixed(4)} SOL (${positions.length} open)`);
  console.log(`Total:         ${total.toFixed(4)} SOL`);
  console.log(`Realized PnL:  ${state.realizedPnlSol.toFixed(4)} SOL`);
  console.log(`Peak:          ${state.peakSol.toFixed(4)} SOL`);
  console.log(`Total trades:  ${state.totalTrades}`);

  if (positions.length > 0) {
    console.log('\n=== OPEN POSITIONS ===');
    for (const p of positions) {
      const ageMin = ((Date.now() - p.entryTimestamp) / 60000).toFixed(1);
      console.log(
        `  ${p.symbol.padEnd(8)} ${p.mint.slice(0, 8)}... ` +
        `size=${p.amountSol.toFixed(3)}SOL ` +
        `entry=$${p.entryPrice.toExponential(2)} ` +
        `tokens=${p.amountTokens.toExponential(2)} ` +
        `age=${ageMin}min ` +
        `src=${p.source}`
      );
    }
  } else {
    console.log('\nNo open positions.');
  }
  closeDb();
}

function cmdSignals(flags: Record<string, string | boolean>): void {
  const limit = parseInt(String(flags.limit ?? '20'), 10);
  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
  const signals = getRecentSignals(sinceMs, limit);

  console.log(`\n=== SIGNALS (last 24h, ${signals.length}) ===`);
  if (signals.length === 0) {
    console.log('No signals yet. Make sure HELIUS_API_KEY is set and KOL wallets are tracking.');
    closeDb();
    return;
  }
  for (const s of signals) {
    const ts = new Date(s.timestamp).toISOString().slice(11, 19);
    console.log(
      `  ${ts} ${s.side.toUpperCase().padEnd(4)} ` +
      `${(s.symbol ?? s.mint.slice(0, 8)).padEnd(10)} ` +
      `conf=${s.confidence.toFixed(2)} ` +
      `size=${(s.sizePct * 100).toFixed(1)}% ` +
      `[${s.source}] ${s.reason}`
    );
  }
  closeDb();
}

function cmdPnl(flags: Record<string, string | boolean>): void {
  const days = parseInt(String(flags.days ?? '30'), 10);
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM daily_pnl
    WHERE date >= date('now', ?)
    ORDER BY date DESC
  `).all(`-${days} days`) as any[];

  console.log(`\n=== PNL BREAKDOWN (last ${days} days) ===`);
  if (rows.length === 0) {
    console.log('No PnL data yet. Run the bot first to generate trades.');
    closeDb();
    return;
  }

  let totalPnl = 0;
  let totalTrades = 0;
  let totalWins = 0;
  for (const r of rows) {
    totalPnl += r.realized_pnl_sol;
    totalTrades += r.trade_count;
    totalWins += r.win_count;
    const wr = r.trade_count > 0 ? (r.win_count / r.trade_count * 100).toFixed(0) : '0';
    console.log(
      `  ${r.date}  trades=${String(r.trade_count).padStart(3)} ` +
      `wins=${String(r.win_count).padStart(2)}/${String(r.loss_count).padStart(2)} ` +
      `(${wr.padStart(3)}%)  PnL=${r.realized_pnl_sol.toFixed(4).padStart(8)} SOL`
    );
  }
  const overallWr = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : '0';
  console.log(`\n  TOTAL: ${totalTrades} trades, ${overallWr}% win rate, ${totalPnl.toFixed(4)} SOL PnL`);
  closeDb();
}

async function cmdBacktest(flags: Record<string, string | boolean>): Promise<void> {
  console.log('Backtest not yet implemented as a CLI command.');
  console.log('For now, the paper-trade engine will run a live backtest as KOL trades are detected.');
  console.log('You can also use the API directly:');
  console.log('  import { HeliusClient } from "./src/data/helius.js"');
  console.log('  await new HeliusClient().getTransactionsForWallet("WALLET", 1000)');
  closeDb();
}

function cmdConfig(): void {
  const cfg = loadConfig();
  console.log('\n=== CONFIG ===');
  const entries = Object.entries(cfg)
    .filter(([k]) => !k.endsWith('_LIST') && k !== 'KOL_WALLETS')
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of entries) {
    if (typeof v === 'object') continue;
    const display = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '...' : v;
    console.log(`  ${k.padEnd(32)} ${display}`);
  }
  console.log(`  ${'KOL_WALLETS_LIST'.padEnd(32)} [${cfg.KOL_WALLETS_LIST.length} wallets]`);
  for (const w of cfg.KOL_WALLETS_LIST) {
    console.log(`    - ${w}`);
  }
  closeDb();
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  try {
    switch (command) {
      case 'start':
        await cmdStart(flags);
        break;
      case 'stop':
        cmdStop();
        break;
      case 'status':
        cmdStatus();
        break;
      case 'signals':
        cmdSignals(flags);
        break;
      case 'pnl':
        cmdPnl(flags);
        break;
      case 'backtest':
        await cmdBacktest(flags);
        break;
      case 'config':
        cmdConfig();
        break;
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error('CLI error:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

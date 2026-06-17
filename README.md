# Solana Memecoin Trading Bot

A multi-strategy Solana memecoin trading bot that **clones profitable on-chain traders** (Gake, 0xSun) and validates edge via **paper trading** before risking real capital.

> **We need to win.** This bot exists to prove a strategy is profitable in simulation first, then in live trading. By default it runs in **paper mode** — no real money moves.

## What it does

Implements **5 strategy layers** that emit buy/sell signals:

1. **KOL Wallet Mirror** — subscribes to Gake's + 0xSun's on-chain wallets, mirrors their trades with position-sizing + anti-rug + anti-front-run filters.
2. **Gake Strategy Replicator** — reverse-engineers Gake's actual strategy (nadir buying 70–90% off ATH, mcap filter, catalyst scoring, **50%-at-2x exit rule**, band trading).
3. **Meta-Cycle Detector** — tracks which genre (memes, celebrity, art, AI/tech) is hot/cold and suppresses/boostes signals accordingly.
4. **Anomaly Detector** — watches for unusual on-chain activity (smart-wallet clusters, new-mint insider accumulation) before it hits leaderboards.
5. **Risk Manager** — per-trade caps, daily-loss limit, drawdown kill switch, token blacklist, cash reserve.

Signals are **aggregated with weighted voting**. If a token gets signals from multiple layers, confidence goes up. Only fires when confidence exceeds threshold.

Then executes via:
- **Paper-trade engine** (default) — full simulation with realistic latency, slippage, fees
- **Live-trade engine** (disabled by default) — routes through Trojan/Maestro API

## Quick start

```bash
# 1. Install
npm install

# 2. Configure (optional - paper mode works out of the box)
cp .env.example .env
# edit .env to add HELIUS_API_KEY for live data, leave blank for offline mode

# 3. Run in paper mode (no real money)
npm run cli -- start --mode paper

# 4. Check status
npm run cli -- status
npm run cli -- signals
npm run cli -- pnl
```

## CLI

```bash
npm run cli -- start              # Start bot in paper mode
npm run cli -- start --mode live  # Start bot in live mode (requires API keys)
npm run cli -- stop               # Stop the running bot
npm run cli -- status             # Show current portfolio + open positions
npm run cli -- signals            # Show recent signals (last 24h)
npm run cli -- pnl                # Show PnL breakdown
npm run cli -- backtest --kol <address> --days 30   # Backtest a KOL wallet
npm run cli -- send-test          # Send a test alert to Telegram
npm run cli -- config             # Show current configuration
```

## Telegram alerts (optional)

Get real-time notifications on your phone when the bot trades, when risk events fire, or when it starts/stops.

Setup:
1. Open Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, follow prompts to get a bot token.
2. Copy the token to `TELEGRAM_BOT_TOKEN` in `.env`.
3. Open a chat with your new bot and send any message.
4. Visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` — find your `chat.id` in the JSON response.
5. Copy the chat id to `TELEGRAM_CHAT_ID` in `.env`.
6. Set `TELEGRAM_ENABLED=true` in `.env`.
7. Run `npm run cli -- send-test` — you should see a 🧪 Test alert message in your Telegram.

Alerts fire on:
- Bot started / stopped
- Every executed buy / sell (with mint, size, price, PnL)
- Drawdown kill switch triggered
- Bot errors

The client is fire-and-forget — failed sends are logged but never crash the bot.

## Strategy

### Why Gake?

Gake (`DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm`) is a verified Solana memecoin trader:
- **$7.26M total PnL, $18.64M realized** (SolanaTracker verified)
- **70.5% win rate** (above the suspicious 80% threshold, but backed by 26,810 trades across 1,149 tokens = not survivorship bias)
- **Labels: KOL, Bot** — publicly shares strategy
- **"Doesn't dump on followers"** reputation — sells 50% at 2x, lets rest run

His strategy (decoded from his pinned article "Of nadirs and bidding death in memecoins"):
- **NOT a launch sniper** — buys at >$100K mcap, often >$1M
- **Buys at nadir** — tokens 70–90% off 30-day ATH
- **Favors catalysts**: dev activity, community growth, potential future backers
- **Genre awareness**: tracks which meta is rotating (memes → celebrity → art → AI/tech)
- **50% at 2x exit** — secures principal, lets rest run with diamond hands

### Why 0xSun?

Backup KOL with $17.7M PnL, 163.7% ROI. "High-conviction, low-frequency, widely tracked by copy traders" = proven to be copyable. Used as a secondary mirror source.

## Architecture

```
STRATEGY ORCHESTRATOR (the brain — our code)
  ├─ Layer 1: KOL Wallet Mirror
  ├─ Layer 2: Gake Strategy Replicator
  ├─ Layer 3: Meta-Cycle Detector
  ├─ Layer 4: Anomaly Detector
  └─ Layer 5: Risk Manager
        ↓ signals
  SIGNAL AGGREGATOR (weighted vote, confidence, TTL)
        ↓ decisions
  EXECUTION ADAPTER (Trojan API primary, Maestro secondary)
        ↓
  PAPER-TRADE ENGINE  │  LIVE-TRADE ENGINE
        ↓
  OBSERVABILITY (SQLite + dashboard JSON)
```

## Reality check

The research is clear: **copy-trading memecoin traders is structurally unprofitable for most participants.**
- 48.48% of copy traders are profitable (90-day multi-exchange study, 100K+ trades)
- Only 43.61% of leaders deliver positive follower PnL
- Realistic PnL capture: **30–50% of the original's returns at best**
- Round-trip costs: 2.5–12% per trade
- Sniper bots, alpha decay, honeypots, exit timing mismatch — every disadvantage compounds

This bot is designed to **maximize the realistic 30–50% capture rate** by:
- Anti-MEV routing (Jito bundles)
- Anti-rug filtering (mint/freeze authority, holder concentration)
- Smart position sizing
- Independent exit logic (we don't blindly copy sells)
- Dry-run before live

If after paper-trading for 30+ days the bot is not profitable, **don't flip to live.** That signal matters more than any backtest.

## Tech stack

- **TypeScript** + **Node 18** (tsx for dev, tsc for build)
- **SQLite** (better-sqlite3) for trade history + audit trail
- **Helius** for Solana RPC + transaction fetching
- **DexScreener** for token metadata
- **Jupiter** for swap quotes (used for paper-trade pricing)
- **Birdeye** (optional) for OHLCV
- **Vitest** for tests

## Project structure

```
src/
├─ config/         # Env loading + validation (zod)
├─ db/             # SQLite schema + migrations + queries
├─ data/           # Helius, DexScreener, Birdeye, Jupiter clients
├─ signals/        # Signal type definitions
├─ layers/         # The 5 strategy layers
│  ├─ kol-mirror.ts
│  ├─ gake-strategy.ts
│  ├─ meta-cycle.ts
│  ├─ anomaly.ts
│  └─ risk.ts
├─ aggregator/     # Signal weighting + threshold
├─ execution/      # Trojan + Maestro adapters (interface)
├─ paper/          # Paper-trade engine
├─ cli.ts          # CLI entry point
└─ index.ts        # Bot loop
tests/
├─ layers/
├─ aggregator/
├─ paper/
└─ execution/
data/              # SQLite + paper-trade state
docs/              # Research notes + design decisions
```

## Development

```bash
npm test              # Run all tests
npm run typecheck     # TypeScript type check
npm run lint          # ESLint
npm run dev           # Run in watch mode
```

## Disclaimer

This is experimental software. Memecoin trading is extremely high-risk; most participants lose money. Past performance of cloned traders does not guarantee future results. The bot starts in **paper mode by default**. Switch to live only after validating edge.

## License

MIT

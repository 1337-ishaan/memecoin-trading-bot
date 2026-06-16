# DESIGN.md

## Overview

A multi-strategy Solana memecoin trading bot that clones profitable on-chain traders (Gake, 0xSun) and validates edge via paper trading before risking real capital.

## Core principle

**Paper-trade first, prove edge, then go live.** The bot starts in paper mode by default. It will only operate in live mode if the user explicitly opts in AND has validated the strategy in paper mode for 30+ days with positive results.

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

## The 5 strategy layers

### Layer 1: KOL Wallet Mirror
Subscribes to Gake + 0xSun via Helius RPC. For each detected swap, emits a buy/sell signal.

Built-in protections:
- Reject signals older than 60s (no copying yesterday's trades)
- Anti-rug pre-check (mint/freeze authority, liquidity)
- Position sizing = 5% of KOL's trade size, capped at our MAX_POSITION_PCT

### Layer 2: Gake Strategy Replicator
Implements Gake's documented strategy:
- **Nadir scanner**: tokens 70–90% off 30d ATH
- **Mcap filter**: >$100K (preferred >$1M)
- **Catalyst scoring**: dev activity, community growth, volume trend, holder concentration
- **Exit**: 50% at 2x → diamond hands → trailing stop after TP → hard stop at -50%

### Layer 3: Meta-Cycle Detector
Tracks which token genre (memes / celebrity / art / AI / community / news) is hot or cold. Suppresses entries in hot genres (likely at peak), boosts cold genres (contrarian entry).

### Layer 4: Anomaly Detector
Detects smart-wallet clusters (≥3 unique wallets buying same token within 5 min). Fires signal when cluster detected.

### Layer 5: Risk Manager
Pre-trade and post-trade risk gates:
- Token blacklist (honeypots, rugs)
- Anti-rug: mint/freeze authority, holder concentration, LP lock
- Per-trade cap: MAX_POSITION_PCT
- Daily loss limit
- Drawdown kill switch
- Cash reserve

## Signal aggregator

Each layer emits a `Signal { mint, side, sizePct, confidence, ttl }`. The aggregator:
- Pulls all live signals for a given mint (within TTL)
- Computes weighted confidence: `Σ (signal.confidence × layer.weight) / Σ layer.weight`
- Sums sizePct (capped at MAX_POSITION_PCT)
- Fires only when weighted confidence ≥ SIGNAL_CONFIDENCE_THRESHOLD (default 0.65)

Default weights (sum to 1.0):
- kol_mirror: 0.30
- gake_strategy: 0.40
- meta_cycle: 0.10
- anomaly: 0.20

## Paper-trade engine

Simulates fills with realistic conditions:
- **Latency**: 1–10s from signal to fill (we're a follower, not the leader)
- **Slippage**: 0.5–25% based on liquidity & trade size
- **Priority fee**: 0.001–0.05 SOL
- **Platform fee**: 1% (Trojan/Bloom/Maestro standard)
- **DEX fee**: 0.3%

After fill, applies Gake's exit rules independently from any KOL mirror signals.

## Tech stack

- **TypeScript** + **Node 20** (via `tsx` for dev, `tsc` for build)
- **SQLite** (better-sqlite3) for trade history + audit trail
- **Helius** for Solana RPC + transaction fetching
- **DexScreener** (free) for token metadata
- **Jupiter** for swap quotes (paper-trade pricing)
- **Birdeye** (optional, paid) for 30d ATH data
- **Vitest** for tests
- **ESLint flat config** for linting

## Component isolation

Each component has a single clear purpose and communicates through narrow interfaces:

| Component | Purpose | Inputs | Outputs |
|-----------|---------|--------|---------|
| `HeliusClient` | Fetch on-chain data | Wallet address | ParsedSwap[] |
| `DexScreenerClient` | Token metadata | Mint | TokenMeta |
| `JupiterClient` | Swap quotes | input/output mint, amount | JupiterQuote |
| `PriceOracle` | Unified pricing | Mint | PriceQuote |
| `KolMirrorLayer` | Detect KOL trades | Wallet | Signal[] |
| `GakeStrategyLayer` | Replicate Gake's strategy | Token cache | Signal[] + exit decisions |
| `MetaCycleLayer` | Genre heat tracking | Search queries | heatByGenre map |
| `AnomalyLayer` | Smart-wallet clusters | Buy events | Signal[] |
| `RiskManager` | Risk gates | Signal + meta | RiskDecision |
| `SignalAggregator` | Combine signals | Signal[] | AggregatedSignal |
| `PaperTradeEngine` | Simulated execution | AggregatedSignal | Trade, Position |
| `ExecutionAdapter` | Real execution | Order | OrderResult |
| `Bot` | Main loop | — | ticks, logs |

## Data flow

1. **Tick** (every 30s):
   - Helius polls → KOL mirror emits Signals
   - Meta-cycle refresh (every 30 min) → updates heatByGenre
   - Gake strategy scans nadir candidates → emits Signals
   - Aggregator pulls active Signals, computes AggregatedSignal per mint
   - Risk check → if pass, PaperTradeEngine.processBuy/processSell
   - Check open positions for Gake-rule exits
   - Update peak portfolio value

2. **Persistence**: every signal, position, trade is written to SQLite. Database file: `data/bot.db`.

3. **Observability**: CLI commands `status`, `signals`, `pnl` query the DB.

## Error handling

- Helius rate limit / network error → log + continue (next tick)
- Jupiter price failure → reject trade, log
- SQLite error → crash (data integrity is critical)
- Position sizing math → strict type checks + unit tests

## Testing

44 tests covering:
- Config loading and validation
- DB schema and migrations
- Gake strategy (catalyst scoring, exit rules)
- Risk manager (all gates)
- Meta-cycle (genre classification, multiplier)
- Anomaly detector (cluster detection, time window)
- Signal aggregator (weighted vote, threshold, TTL)
- Slippage simulation math

## YAGNI

We deliberately don't build:
- Multi-tenant SaaS / auth
- React / mobile UI (CLI + JSON output)
- Launch sniping / MEV extraction
- Cross-chain routing
- Social signal analysis
- Options / perps
- Real-time WebSocket UI

These are all "could be useful" but not in service of "win via cloning Gake."

## Build sequence

1. Scaffold + tooling (done)
2. Core lib: types, config, DB (done)
3. Data fetchers: Helius, DexScreener, Jupiter, Birdeye (done)
4. The 5 strategy layers (done)
5. Signal aggregator (done)
6. Risk manager (done)
7. Paper-trade engine (done)
8. Execution adapter interface (done — stubs)
9. CLI (done)
10. Tests (done — 44 passing)
11. GitHub repo + push (in progress)

## Future work

- v1.1: Wire real Trojan/Maestro HTTP API for live execution
- v1.2: Launch detection (pump.fun new mints)
- v1.3: Social signals (X mentions, KOL following)
- v1.4: Web dashboard (Next.js or simple HTML)
- v2.0: Cross-chain (Base, ETH memecoins)
- v2.0: Replicate other KOLs dynamically

/**
 * Demo: run a synthetic full-pipeline paper trade to demonstrate the system.
 * This injects a fake KOL trade, runs it through the aggregator + risk + paper
 * engine, and sends the resulting Telegram alert (if enabled).
 *
 * Use this to verify the full pipeline works without waiting for Gake to actually trade.
 *
 * Usage: npm run cli -- demo
 */

import { HeliusClient } from '../data/helius.js';
import { DexScreenerClient } from '../data/dexscreener.js';
import { BirdeyeClient } from '../data/birdeye.js';
import { JupiterClient } from '../data/jupiter.js';
import { PriceOracle } from '../data/oracle.js';
import { KolMirrorLayer } from '../layers/kol-mirror.js';
import { GakeStrategyLayer } from '../layers/gake-strategy.js';
import { RiskManager } from '../layers/risk.js';
import { SignalAggregator } from '../aggregator/index.js';
import { PaperTradeEngine } from '../paper/engine.js';
import { TelegramClient, TelegramAlerts } from '../notifications/telegram.js';
import { insertKolTrade, getRecentKolTrades } from '../db/kol.js';
import { upsertTokenMeta, getTokenMeta } from '../db/tokens.js';
import { insertSignal } from '../db/signals.js';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';

export interface DemoOptions {
  /** KOL wallet to fake the trade from (default: first from KOL_WALLETS) */
  kolWallet?: string;
  /** Token mint to fake the trade for (default: pick a real trending memecoin) */
  tokenMint?: string;
  /** SOL amount for the synthetic trade */
  amountSol?: number;
  /** Skip the Telegram alert */
  skipTelegram?: boolean;
}

const FALLBACK_MINTS = [
  // SOL native
  'So11111111111111111111111111111111111111111',
  // USDC
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
];

export async function runDemo(opts: DemoOptions = {}): Promise<void> {
  const cfg = loadConfig();
  const kolWallet = opts.kolWallet ?? cfg.KOL_WALLETS_LIST[0];
  if (!kolWallet) {
    console.error('No KOL wallet configured. Set KOL_WALLETS in .env.');
    return;
  }
  const amountSol = opts.amountSol ?? 2.0;

  console.log('\n=== DEMO PAPER TRADE ===\n');

  // Init clients
  const helius = new HeliusClient();
  const dexscreener = new DexScreenerClient();
  const birdeye = new BirdeyeClient();
  const jupiter = new JupiterClient();
  const oracle = new PriceOracle(jupiter, dexscreener);
  const kolLayer = new KolMirrorLayer(helius, oracle);
  const gakeLayer = new GakeStrategyLayer(dexscreener, birdeye, oracle);
  const risk = new RiskManager();
  const aggregator = new SignalAggregator();
  const paper = new PaperTradeEngine(oracle, risk, gakeLayer);
  const telegram = new TelegramClient();

  // 1. Pick a token — either user-provided, or first we can find meta for
  let tokenMint = opts.tokenMint;
  let meta = null;
  if (tokenMint) {
    meta = getTokenMeta(tokenMint);
    if (!meta) {
      console.log(`Looking up meta for ${tokenMint}...`);
      meta = await dexscreener.getTokenMeta(tokenMint);
      if (meta) upsertTokenMeta(meta);
    }
  } else {
    // Try a few known liquid memecoins
    const candidates = [
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
      'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
      '7GCihgDB8fe6KNjn2MYtkzZcRjQyTFS8Y9AWGkkEPjy5', // PUMP (pump.fun)
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (always works)
    ];
    for (const mint of candidates) {
      const m = await dexscreener.getTokenMeta(mint);
      if (m && (m.liquidityUsd ?? 0) > 1000) {
        tokenMint = mint;
        meta = m;
        upsertTokenMeta(m);
        break;
      }
    }
  }

  if (!tokenMint || !meta) {
    console.error('Could not find a valid token. Pass --mint <address>.');
    return;
  }

  console.log(`KOL wallet:  ${kolWallet}`);
  console.log(`Token:       ${meta.symbol} (${tokenMint})`);
  console.log(`MCap:        $${((meta.mcapUsd ?? 0) / 1000).toFixed(0)}K`);
  console.log(`Liquidity:   $${((meta.liquidityUsd ?? 0) / 1000).toFixed(0)}K`);
  console.log(`Trade size:  ${amountSol} SOL\n`);

  // 2. Inject a synthetic KOL trade (timestamp = now so it passes the 60s stale check)
  const now = Date.now();
  const kolTrade = {
    signature: `demo-${randomUUID()}`,
    wallet: kolWallet,
    mint: tokenMint,
    symbol: meta.symbol,
    side: 'buy' as const,
    amountSol,
    amountTokens: amountSol / (meta.priceUsd ?? 0.000001),
    timestamp: now,
    detectedAt: now,
  };
  insertKolTrade(kolTrade);
  console.log(`✓ Injected synthetic KOL trade`);

  // 3. Run KolMirrorLayer.injectKolTrade to emit a signal
  const signal = kolLayer.injectKolTrade(kolTrade);
  if (!signal) {
    console.log('✗ KOL mirror did not emit a signal (anti-rug rejection?)');
    console.log('  Token may have failed risk checks. Try a different token.');
    return;
  }
  console.log(`✓ Emitted KOL mirror signal (conf=${signal.confidence.toFixed(2)})`);

  // 4. Also emit a Gake strategy signal for the same token (boosts confidence)
  const gakeSignal = gakeLayer.emitSignalForToken(tokenMint);
  if (gakeSignal) {
    console.log(`✓ Emitted Gake strategy signal (conf=${gakeSignal.confidence.toFixed(2)})`);
  }

  // 5. Aggregate
  const agg = aggregator.aggregate(tokenMint);
  if (!agg) {
    console.log('✗ Aggregator returned null');
    return;
  }
  console.log(`\n  Aggregated: shouldAct=${agg.shouldAct} conf=${agg.confidence.toFixed(3)} sizePct=${(agg.sizePct * 100).toFixed(2)}%`);
  console.log(`  Contributing signals: ${agg.contributingSignals.length}`);

  if (!agg.shouldAct) {
    console.log(`\n  ⚠️  Combined confidence ${agg.confidence.toFixed(2)} is below threshold ${cfg.SIGNAL_CONFIDENCE_THRESHOLD}`);
    console.log('  This means the demo trade alone isn\'t strong enough. The real bot waits for multiple signals to align.');
  } else {
    // 6. Execute paper trade
    console.log(`\n  Executing paper buy...`);
    const result = await paper.processBuy(agg);
    if (result) {
      console.log(`  ✓ Position opened:`);
      console.log(`    Position ID:  ${result.position.id}`);
      console.log(`    Symbol:       ${result.trade.symbol}`);
      console.log(`    Size:         ${result.trade.amountSol.toFixed(4)} SOL`);
      console.log(`    Fill price:   $${result.trade.price.toExponential(3)}`);
      console.log(`    Slippage:     ${result.trade.simulatedSlippageBps} bps`);
      console.log(`    Tokens:       ${result.trade.amountTokens.toExponential(3)}`);

      // 7. Send Telegram alert
      if (!opts.skipTelegram) {
        const ok = await telegram.send(
          TelegramAlerts.tradeExecuted(
            'buy',
            result.trade.symbol,
            result.trade.mint,
            result.trade.amountSol,
            result.trade.price,
            undefined,
            `DEMO (${result.trade.source})`
          )
        );
        console.log(`\n  ${ok ? '✅' : '⚠️ '} Telegram alert: ${ok ? 'sent' : 'skipped (not configured)'}`);
      }
    } else {
      console.log('  ✗ Paper trade rejected by risk manager');
    }
  }

  // 8. Show next steps
  console.log('\n=== NEXT STEPS ===');
  console.log('Run `npm run cli -- status` to see the open position.');
  console.log('Run `npm run cli -- pnl` to see PnL.');
  console.log('Run `npm run cli -- stop && npm run cli -- start` to restart the bot in continuous mode.');
}

/**
 * Backfill: pull historical KOL trades from on-chain and populate the kol_trades table.
 * Also pulls token meta from DexScreener so the nadir scanner has data to work with.
 *
 * Usage: npm run cli -- backfill --kol <address> --days 7
 *        npm run cli -- backfill --days 7   (defaults to KOL_WALLETS from env)
 */

import { HeliusClient } from '../data/helius.js';
import { DexScreenerClient } from '../data/dexscreener.js';
import { BirdeyeClient } from '../data/birdeye.js';
import { PriceOracle } from '../data/oracle.js';
import { KolMirrorLayer } from '../layers/kol-mirror.js';
import { insertKolTrade } from '../db/kol.js';
import { upsertTokenMeta, getTokenMeta } from '../db/tokens.js';
import { loadConfig } from '../config/index.js';
import type { KolTrade } from '../signals/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackfillOptions {
  wallets: string[];
  sinceMs: number;
  /** If true, also seed token meta cache from DexScreener for each unique mint found */
  seedTokenMeta: boolean;
  /** If true, emit signals for trades (won't trigger paper-trade engine — signals expire fast) */
  emitSignals: boolean;
}

export interface BackfillResult {
  wallet: string;
  txCount: number;
  swapCount: number;
  tokensSeeded: number;
  errors: number;
}

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult[]> {
  const helius = new HeliusClient();
  const dexscreener = new DexScreenerClient();
  const birdeye = new BirdeyeClient();
  const jupiter = new (await import('../data/jupiter.js')).JupiterClient();
  const oracle = new PriceOracle(jupiter, dexscreener);
  const kolLayer = new KolMirrorLayer(helius, oracle);

  const results: BackfillResult[] = [];

  for (const wallet of opts.wallets) {
    const result: BackfillResult = {
      wallet,
      txCount: 0,
      swapCount: 0,
      tokensSeeded: 0,
      errors: 0,
    };

    try {
      // Fetch up to 1000 txs, paginating if needed
      const allSwaps: any[] = [];
      let before: string | undefined;
      while (allSwaps.length < 1000) {
        const swaps = await helius.getTransactionsForWallet(wallet, 100, before);
        if (swaps.length === 0) break;
        result.txCount += swaps.length;

        // Filter by time window
        const filtered = swaps.filter((s) => s.blockTime >= opts.sinceMs);
        allSwaps.push(...filtered);

        // Pagination: use last signature as "before" for next batch
        if (swaps.length < 100) break; // No more to fetch
        before = swaps[swaps.length - 1].signature;

        // Stop if oldest in this batch is already older than window
        if (swaps[swaps.length - 1].blockTime < opts.sinceMs) break;
      }

      // Dedupe by signature
      const seen = new Set<string>();
      const uniqueSwaps = allSwaps.filter((s) => {
        if (seen.has(s.signature)) return false;
        seen.add(s.signature);
        return true;
      });

      // Insert into kol_trades + optionally seed token meta + emit signals
      const uniqueMints = new Set<string>();
      for (const swap of uniqueSwaps) {
        const isBuy = swap.fromMint === null && swap.toMint !== null;
        const isSell = swap.toMint === null && swap.fromMint !== null;
        if (!isBuy && !isSell) continue;
        const tokenMint = isBuy ? swap.toMint! : swap.fromMint!;
        if (!tokenMint) continue;

        uniqueMints.add(tokenMint);

        const trade: KolTrade = {
          signature: swap.signature,
          wallet,
          mint: tokenMint,
          side: isBuy ? 'buy' : 'sell',
          amountSol: swap.solAmount,
          amountTokens: isBuy ? swap.toAmount : swap.fromAmount,
          timestamp: swap.blockTime,
          detectedAt: Date.now(),
        };
        const inserted = insertKolTrade(trade);
        if (inserted) result.swapCount++;
      }

      // Seed token meta for unique mints
      if (opts.seedTokenMeta) {
        for (const mint of uniqueMints) {
          try {
            const meta = await dexscreener.getTokenMeta(mint);
            if (!meta) continue;

            // Get 30d ATH from Birdeye if available
            let ath30d = meta.priceUsd;
            if (birdeye.isConfigured()) {
              const ath = await birdeye.getAth30d(mint);
              if (ath) ath30d = ath;
            }
            const drawdown = ath30d && meta.priceUsd && ath30d > 0
              ? Math.max(0, Math.min(1, 1 - meta.priceUsd / ath30d))
              : undefined;

            upsertTokenMeta({
              ...meta,
              ath30dUsd: ath30d,
              drawdownFromAth30d: drawdown,
              updatedAt: Date.now(),
            });
            result.tokensSeeded++;
          } catch (err) {
            result.errors++;
          }
        }
      }

      // Optionally emit signals (only for recent trades, within TTL)
      if (opts.emitSignals) {
        for (const swap of uniqueSwaps) {
          // Only emit signals for trades in the last 5 minutes
          if (Date.now() - swap.blockTime > 5 * 60 * 1000) continue;
          const isBuy = swap.fromMint === null && swap.toMint !== null;
          const isSell = swap.toMint === null && swap.fromMint !== null;
          const tokenMint = isBuy ? swap.toMint! : swap.fromMint!;
          if (!tokenMint) continue;

          const trade: KolTrade = {
            signature: swap.signature,
            wallet,
            mint: tokenMint,
            side: isBuy ? 'buy' : 'sell',
            amountSol: swap.solAmount,
            amountTokens: isBuy ? swap.toAmount : swap.fromAmount,
            timestamp: swap.blockTime,
            detectedAt: Date.now(),
          };
          kolLayer.injectKolTrade(trade);
        }
      }
    } catch (err) {
      result.errors++;
      console.error(`[backfill] Error processing ${wallet}:`, err);
    }

    results.push(result);
  }

  return results;
}

export async function backfillFromFlags(flags: Record<string, string | boolean>): Promise<void> {
  const cfg = loadConfig();
  const days = parseInt(String(flags.days ?? '7'), 10);
  const sinceMs = Date.now() - days * DAY_MS;

  let wallets: string[];
  if (flags.kol) {
    wallets = [String(flags.kol)];
  } else {
    wallets = cfg.KOL_WALLETS_LIST;
  }

  if (wallets.length === 0) {
    console.error('No wallets to backfill. Set KOL_WALLETS in .env or pass --kol <address>.');
    return;
  }

  console.log(`\n=== BACKFILL ===`);
  console.log(`Wallets: ${wallets.length}`);
  console.log(`Window:  last ${days} days`);
  console.log(`Seed token meta: yes (DexScreener${cfg.BIRDEYE_API_KEY ? ' + Birdeye' : ''})`);
  console.log(`Emit signals: no (use --signals to enable)\n`);

  const results = await runBackfill({
    wallets,
    sinceMs,
    seedTokenMeta: true,
    emitSignals: flags.signals === true,
  });

  let totalTx = 0;
  let totalSwaps = 0;
  let totalSeeded = 0;
  let totalErrors = 0;
  for (const r of results) {
    totalTx += r.txCount;
    totalSwaps += r.swapCount;
    totalSeeded += r.tokensSeeded;
    totalErrors += r.errors;
    console.log(
      `  ${r.wallet.slice(0, 8)}...${r.wallet.slice(-6)}  ` +
      `tx=${r.txCount}  swaps=${r.swapCount}  tokensSeeded=${r.tokensSeeded}  errors=${r.errors}`
    );
  }
  console.log(`\n  TOTAL: ${totalTx} txs, ${totalSwaps} swaps, ${totalSeeded} tokens seeded, ${totalErrors} errors`);
  console.log(`\nRun \`npm run cli -- status\` to see your portfolio.`);
  console.log(`Run \`npm run cli -- signals --limit 10\` to see recent signals.`);
}

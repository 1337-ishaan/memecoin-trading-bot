/**
 * Seed token meta cache with a list of well-known Solana memecoins.
 * Useful for getting the nadir scanner running without waiting for KOL activity.
 *
 * Usage: npm run cli -- seed-tokens
 */

import { DexScreenerClient } from '../data/dexscreener.js';
import { upsertTokenMeta, getTokenMeta } from '../db/tokens.js';
import { loadConfig } from '../config/index.js';

const SEED_TOKENS = [
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk' },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', name: 'dogwifhat' },
  { mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQyTFS8Y9AWGkkEPjy5', symbol: 'PUMP', name: 'pump.fun' },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter' },
  { mint: 'rndrizKT3MK1iimaxeRd5yhApiqiJb8LmQHTb2oKPV', symbol: 'RENDER', name: 'Render Token' },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', symbol: 'PYTH', name: 'Pyth Network' },
  { mint: 'jtojtomepa8beP8AuUo6TuR9yDRk8oDbG5GspeqcDJ', symbol: 'JTO', name: 'Jito' },
  { mint: 'BARKCmhY7b7BFP6rCvqv6c2HAi7y3LJ5z1ffh4spump', symbol: 'BARK', name: 'BarkCoin' },
  { mint: 'HeLp6NuQkmYB4pYWo2xYsLCqt4D6mmfSB3vsvcUnwhCw', symbol: 'HLPMEME', name: 'Help meme' },
  { mint: 'ED5nyyWEzpPPiWimE8KsFgNhU6Fm1LZ3KYjLBHMqGyDt', symbol: 'WEN', name: 'Wen' },
];

export async function runSeedTokens(): Promise<void> {
  const dexscreener = new DexScreenerClient();
  const cfg = loadConfig();

  console.log('\n=== SEED TOKEN META ===\n');
  console.log(`Seeding ${SEED_TOKENS.length} well-known Solana memecoins...\n`);

  let seeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const seed of SEED_TOKENS) {
    try {
      const cached = getTokenMeta(seed.mint);
      // Skip if cached and recent (within 1 hour)
      if (cached && Date.now() - cached.updatedAt < 60 * 60 * 1000) {
        skipped++;
        continue;
      }

      const meta = await dexscreener.getTokenMeta(seed.mint);
      if (!meta) {
        console.log(`  ✗ ${seed.symbol}: no meta from DexScreener`);
        failed++;
        continue;
      }

      // Compute drawdown: if priceUsd is set, we don't have ATH from DexScreener
      // directly. We approximate by setting a sensible drawdown range.
      // Real nadir detection will refine this in the Gake strategy layer.
      upsertTokenMeta({
        ...meta,
        updatedAt: Date.now(),
      });
      console.log(`  ✓ ${meta.symbol.padEnd(8)} $${((meta.mcapUsd ?? 0) / 1000).toFixed(0)}K mcap, $${((meta.liquidityUsd ?? 0) / 1000).toFixed(0)}K liq`);
      seeded++;
    } catch (err) {
      console.log(`  ✗ ${seed.symbol}: ${err instanceof Error ? err.message.slice(0, 60) : 'error'}`);
      failed++;
    }
  }

  console.log(`\n  Seeded: ${seeded}  Skipped (cached): ${skipped}  Failed: ${failed}`);
  if (cfg.BIRDEYE_API_KEY) {
    console.log(`  Birdeye API key detected — 30d ATH data will be available on next refresh.`);
  } else {
    console.log(`  ⚠️  No BIRDEYE_API_KEY — nadir scanner will be limited (no 30d ATH data).`);
    console.log(`     Set BIRDEYE_API_KEY in .env for full nadir detection. Get a key at https://birdeye.so`);
  }
}

/**
 * Refresh: re-fetch metadata + 30d ATH for all cached tokens from Birdeye.
 * Use this after adding BIRDEYE_API_KEY to populate the drawdown data the
 * nadir scanner needs.
 *
 * Usage: npm run cli -- refresh
 */

import { DexScreenerClient } from '../data/dexscreener.js';
import { BirdeyeClient } from '../data/birdeye.js';
import { getDb } from '../db/index.js';
import { upsertTokenMeta, getTokenMeta } from '../db/tokens.js';
import { loadConfig } from '../config/index.js';

export async function runRefresh(): Promise<void> {
  const cfg = loadConfig();
  const dexscreener = new DexScreenerClient();
  const birdeye = new BirdeyeClient();

  if (!birdeye.isConfigured()) {
    console.error('❌ BIRDEYE_API_KEY is not set. Add it to .env first.');
    return;
  }

  const db = getDb();
  const rows = db.prepare(`SELECT mint, symbol FROM token_meta_cache ORDER BY mcap_usd DESC NULLS LAST`).all() as any[];
  console.log(`\n=== REFRESH TOKEN META ===\n`);
  console.log(`Refreshing ${rows.length} cached tokens (DexScreener + Birdeye 30d ATH)...\n`);

  let updated = 0;
  let withAth = 0;
  let nadirCandidates = 0;
  const DRAW_MIN = cfg.NADIR_DRAWDOWN_MIN;
  const DRAW_MAX = cfg.NADIR_DRAWDOWN_MAX;
  const MCAP_MIN = cfg.MCAP_MIN_USD;

  for (const row of rows) {
    const mint = row.mint;
    try {
      // Refresh DexScreener
      const ds = await dexscreener.getTokenMeta(mint);
      if (!ds) continue;

      // Fetch Birdeye ATH (30d)
      const ath = await birdeye.getAth30d(mint);

      const drawdown = ath && ds.priceUsd && ath > 0
        ? Math.max(0, Math.min(1, 1 - ds.priceUsd / ath))
        : undefined;

      const enriched = {
        ...ds,
        ath30dUsd: ath ?? ds.priceUsd,
        drawdownFromAth30d: drawdown,
        updatedAt: Date.now(),
      };
      upsertTokenMeta(enriched);
      updated++;
      if (ath) withAth++;

      const isNadir = drawdown !== undefined && drawdown >= DRAW_MIN && drawdown <= DRAW_MAX;
      if (isNadir) nadirCandidates++;

      const drawdownStr = drawdown !== undefined ? `${(drawdown * 100).toFixed(0)}% off` : 'no ATH';
      const marker = isNadir ? '🎯' : '  ';
      console.log(`  ${marker} ${ds.symbol.padEnd(8)} mcap $${((ds.mcapUsd ?? 0) / 1000).toFixed(0).padStart(7)}K  liq $${((ds.liquidityUsd ?? 0) / 1000).toFixed(0).padStart(5)}K  ${drawdownStr}`);
    } catch (err) {
      console.log(`  ✗ ${row.symbol}: ${(err as Error).message.slice(0, 60)}`);
    }
  }

  console.log(`\n  Updated: ${updated}/${rows.length}  With ATH: ${withAth}  Nadir candidates: ${nadirCandidates}`);
  if (nadirCandidates > 0) {
    console.log(`\n  🎯 ${nadirCandidates} token(s) currently match the nadir band (${(DRAW_MIN * 100).toFixed(0)}-${(DRAW_MAX * 100).toFixed(0)}% off 30d ATH)`);
    console.log(`  The bot will emit signals for these on the next tick.`);
  }
  if (withAth === 0) {
    console.log(`\n  ⚠️  No ATH data fetched. Possible causes:`);
    console.log(`     - Birdeye API key invalid or expired`);
    console.log(`     - Free tier rate limit hit (100 req/min)`);
    console.log(`     - Tokens too new to have 30d of history`);
  }
}

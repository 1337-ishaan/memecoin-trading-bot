import type { TokenMeta } from '../signals/types.js';
import { getDb } from './index.js';

export function upsertTokenMeta(meta: TokenMeta): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO token_meta_cache
      (mint, symbol, name, decimals, mcap_usd, liquidity_usd, price_usd,
       volume_24h_usd, ath_30d_usd, atl_30d_usd, drawdown_from_ath_30d,
       holder_count, top10_concentration, mint_authority_active,
       freeze_authority_active, lp_locked, genre, updated_at)
    VALUES
      (@mint, @symbol, @name, @decimals, @mcapUsd, @liquidityUsd, @priceUsd,
       @volume24hUsd, @ath30dUsd, @atl30dUsd, @drawdownFromAth30d,
       @holderCount, @top10Concentration, @mintAuthorityActive,
       @freezeAuthorityActive, @lpLocked, @genre, @updatedAt)
    ON CONFLICT(mint) DO UPDATE SET
      symbol = excluded.symbol,
      name = excluded.name,
      decimals = excluded.decimals,
      mcap_usd = excluded.mcap_usd,
      liquidity_usd = excluded.liquidity_usd,
      price_usd = excluded.price_usd,
      volume_24h_usd = excluded.volume_24h_usd,
      ath_30d_usd = excluded.ath_30d_usd,
      atl_30d_usd = excluded.atl_30d_usd,
      drawdown_from_ath_30d = excluded.drawdown_from_ath_30d,
      holder_count = excluded.holder_count,
      top10_concentration = excluded.top10_concentration,
      mint_authority_active = excluded.mint_authority_active,
      freeze_authority_active = excluded.freeze_authority_active,
      lp_locked = excluded.lp_locked,
      genre = excluded.genre,
      updated_at = excluded.updated_at
  `).run({
    mint: meta.mint,
    symbol: meta.symbol,
    name: meta.name,
    decimals: meta.decimals,
    mcapUsd: meta.mcapUsd ?? null,
    liquidityUsd: meta.liquidityUsd ?? null,
    priceUsd: meta.priceUsd ?? null,
    volume24hUsd: meta.volume24hUsd ?? null,
    ath30dUsd: meta.ath30dUsd ?? null,
    atl30dUsd: meta.atl30dUsd ?? null,
    drawdownFromAth30d: meta.drawdownFromAth30d ?? null,
    holderCount: meta.holderCount ?? null,
    top10Concentration: meta.top10Concentration ?? null,
    mintAuthorityActive: meta.mintAuthorityActive === undefined ? null : meta.mintAuthorityActive ? 1 : 0,
    freezeAuthorityActive: meta.freezeAuthorityActive === undefined ? null : meta.freezeAuthorityActive ? 1 : 0,
    lpLocked: meta.lpLocked === undefined ? null : meta.lpLocked ? 1 : 0,
    genre: meta.genre ?? null,
    updatedAt: meta.updatedAt,
  });
}

export function getTokenMeta(mint: string): TokenMeta | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM token_meta_cache WHERE mint = ?`).get(mint) as any;
  if (!row) return null;
  return {
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    mcapUsd: row.mcap_usd ?? undefined,
    liquidityUsd: row.liquidity_usd ?? undefined,
    priceUsd: row.price_usd ?? undefined,
    volume24hUsd: row.volume_24h_usd ?? undefined,
    ath30dUsd: row.ath_30d_usd ?? undefined,
    atl30dUsd: row.atl_30d_usd ?? undefined,
    drawdownFromAth30d: row.drawdown_from_ath_30d ?? undefined,
    holderCount: row.holder_count ?? undefined,
    top10Concentration: row.top10_concentration ?? undefined,
    mintAuthorityActive: row.mint_authority_active === null ? undefined : row.mint_authority_active === 1,
    freezeAuthorityActive: row.freeze_authority_active === null ? undefined : row.freeze_authority_active === 1,
    lpLocked: row.lp_locked === null ? undefined : row.lp_locked === 1,
    genre: row.genre ?? undefined,
    updatedAt: row.updated_at,
  };
}

/** Returns tokens that are within the nadir band (e.g., 70-90% off 30d ATH). */
export function getNadirTokens(
  minDrawdown: number,
  maxDrawdown: number,
  minMcap: number,
  limit: number = 100
): TokenMeta[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM token_meta_cache
    WHERE drawdown_from_ath_30d >= ?
      AND drawdown_from_ath_30d <= ?
      AND mcap_usd >= ?
      AND mint_authority_active = 0
      AND freeze_authority_active = 0
    ORDER BY volume_24h_usd DESC NULLS LAST
    LIMIT ?
  `).all(minDrawdown, maxDrawdown, minMcap, limit) as any[];
  return rows.map(rowToTokenMeta);
}

function rowToTokenMeta(row: any): TokenMeta {
  return {
    mint: row.mint,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    mcapUsd: row.mcap_usd ?? undefined,
    liquidityUsd: row.liquidity_usd ?? undefined,
    priceUsd: row.price_usd ?? undefined,
    volume24hUsd: row.volume_24h_usd ?? undefined,
    ath30dUsd: row.ath_30d_usd ?? undefined,
    atl30dUsd: row.atl_30d_usd ?? undefined,
    drawdownFromAth30d: row.drawdown_from_ath_30d ?? undefined,
    holderCount: row.holder_count ?? undefined,
    top10Concentration: row.top10_concentration ?? undefined,
    mintAuthorityActive: row.mint_authority_active === null ? undefined : row.mint_authority_active === 1,
    freezeAuthorityActive: row.freeze_authority_active === null ? undefined : row.freeze_authority_active === 1,
    lpLocked: row.lp_locked === null ? undefined : row.lp_locked === 1,
    genre: row.genre ?? undefined,
    updatedAt: row.updated_at,
  };
}

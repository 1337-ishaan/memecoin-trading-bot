/**
 * Layer 3: Meta-Cycle Detector
 *
 * Tracks the relative heat of different token genres:
 *   pure_meme | celebrity | art | ai_tech | community_web2 | news
 *
 * In 2024 the cycle was: pure memes → celebrity → art → AI/tech.
 * 2025 is "chaotic frontier" with multiple genres coexisting.
 *
 * When a genre is in a hot phase, suppress entries (likely at peak).
 * When a genre is in a cold phase with high-quality tokens at nadirs, boost.
 *
 * For v1, we use DexScreener trending data + a genre classifier on token names.
 */

import { DexScreenerClient } from '../data/dexscreener.js';
import type { TokenGenre, Signal } from '../signals/types.js';

const GENRE_KEYWORDS: Record<TokenGenre, RegExp[]> = {
  pure_meme: [/pepe/i, /doge/i, /wojak/i, /chad/i, /bonk/i, /wif/i, /moodeng/i, /goat/i, /cat/i, /inu/i, /elon/i],
  celebrity: [/trump/i, /harris/i, /kanye/i, /taylor/i, /bieber/i, /drake/i, /rihanna/i],
  art: [/art/i, /nft/i, /pixel/i, /punk/i, /bayc/i, /azuki/i, /milady/i, /monkey/i],
  ai_tech: [/ai/i, /gpt/i, /agent/i, /llm/i, /render/i, /fetch/i, /qnt/i, /iotx/i, /robo/i, /bot/i],
  community_web2: [/discord/i, /telegram/i, /twitter/i, /tiktok/i, /youtube/i, /ig/i, /ig-/i, /x-/i],
  news: [/news/i, /breaking/i, /live/i, /alrt/i, /reuters/i, /cnn/i],
  unknown: [],
};

export class MetaCycleLayer {
  private dexscreener: DexScreenerClient;
  private heatByGenre: Map<TokenGenre, number> = new Map();
  private lastUpdate: number = 0;

  constructor(dexscreener: DexScreenerClient) {
    this.dexscreener = dexscreener;
    for (const g of Object.keys(GENRE_KEYWORDS) as TokenGenre[]) {
      this.heatByGenre.set(g, 0.5);
    }
  }

  /** Classify a token symbol/name into a genre. */
  classifyGenre(symbol: string, name: string = ''): TokenGenre {
    const combined = `${symbol} ${name}`.toLowerCase();
    for (const [genre, patterns] of Object.entries(GENRE_KEYWORDS) as Array<[TokenGenre, RegExp[]]>) {
      if (genre === 'unknown') continue;
      if (patterns.some((p) => p.test(combined))) return genre;
    }
    return 'unknown';
  }

  /** Refresh heat scores for each genre based on recent volume/launch data. */
  async refreshHeat(): Promise<void> {
    // In a full impl: query DexScreener for trending tokens by category,
    // Birdeye for category volume, etc.
    // For v1: use a coarse heuristic via search.
    try {
      const searches = [
        { genre: 'pure_meme' as TokenGenre, query: 'pepe' },
        { genre: 'ai_tech' as TokenGenre, query: 'ai agent' },
        { genre: 'celebrity' as TokenGenre, query: 'trump' },
        { genre: 'community_web2' as TokenGenre, query: 'community' },
      ];

      for (const s of searches) {
        const pairs = await this.dexscreener.searchTokens(s.query);
        const totalVol = pairs.reduce(
          (sum, p) => sum + (p.volume?.h24 ?? 0),
          0
        );
        const heat = Math.tanh(totalVol / 1_000_000); // normalize
        this.heatByGenre.set(s.genre, heat);
      }
      this.lastUpdate = Date.now();
    } catch (err) {
      console.error('[meta-cycle] refresh failed:', err);
    }
  }

  /**
   * Given a buy signal, return a confidence multiplier (0.5 to 1.5).
   * Hot genre = suppress (lower confidence).
   * Cold genre with nadir candidates = boost.
   */
  multiplierFor(signal: Signal): number {
    if (signal.source !== 'gake_strategy' && signal.source !== 'kol_mirror') {
      return 1.0;
    }
    const genre = this.classifyGenre(signal.symbol ?? signal.mint.slice(0, 6));
    if (genre === 'unknown') return 1.0;

    const heat = this.heatByGenre.get(genre) ?? 0.5;

    // High heat (>0.7) = we're late, suppress by 30%
    if (heat > 0.7) return 0.7;
    // Low heat (<0.3) = contrarian entry, boost by 30%
    if (heat < 0.3) return 1.3;
    return 1.0;
  }

  getHeatByGenre(): Record<string, number> {
    return Object.fromEntries(this.heatByGenre);
  }

  isStale(): boolean {
    return Date.now() - this.lastUpdate > 30 * 60 * 1000; // 30 min
  }
}

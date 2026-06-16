import { describe, it, expect } from 'vitest';
import { MetaCycleLayer } from '../../src/layers/meta-cycle.js';
import type { Signal } from '../../src/signals/types.js';

const mockDex = {} as any;

function makeSignal(symbol: string, source: 'kol_mirror' | 'gake_strategy' = 'gake_strategy'): Signal {
  return {
    id: 'test',
    source,
    mint: 'MINT',
    symbol,
    side: 'buy',
    sizePct: 0.05,
    confidence: 0.7,
    reason: 'test',
    timestamp: Date.now(),
    ttlSeconds: 60,
  };
}

describe('MetaCycleLayer', () => {
  const layer = new MetaCycleLayer(mockDex);

  describe('classifyGenre', () => {
    it('classifies pure meme tokens', () => {
      expect(layer.classifyGenre('PEPE', 'Pepe the Frog')).toBe('pure_meme');
      expect(layer.classifyGenre('BONK', 'Bonk')).toBe('pure_meme');
    });

    it('classifies celebrity tokens', () => {
      expect(layer.classifyGenre('TRUMP', 'Make Memes Great Again')).toBe('celebrity');
    });

    it('classifies AI tokens', () => {
      expect(layer.classifyGenre('GPT', 'GPT Agent')).toBe('ai_tech');
      expect(layer.classifyGenre('ROBO', 'Robot Coin')).toBe('ai_tech');
    });

    it('classifies art tokens', () => {
      expect(layer.classifyGenre('BAYC', 'Bored Ape')).toBe('art');
      expect(layer.classifyGenre('PUNK', 'CryptoPunk')).toBe('art');
    });

    it('returns unknown for ambiguous tokens', () => {
      expect(layer.classifyGenre('XYZ', 'Random Coin')).toBe('unknown');
    });
  });

  describe('multiplierFor', () => {
    it('returns 1.0 for unknown genre', () => {
      const sig = makeSignal('UNKNOWN');
      const mult = layer.multiplierFor(sig);
      expect(mult).toBe(1.0);
    });

    it('returns 1.0 for non-strategy sources', () => {
      const sig: Signal = { ...makeSignal('PEPE'), source: 'anomaly' };
      expect(layer.multiplierFor(sig)).toBe(1.0);
    });

    it('suppresses hot genre (<1.0)', () => {
      // Manually inject a hot heat
      (layer as any).heatByGenre.set('pure_meme', 0.9);
      const sig = makeSignal('PEPE');
      const mult = layer.multiplierFor(sig);
      expect(mult).toBeLessThan(1.0);
    });

    it('boosts cold genre (>1.0)', () => {
      (layer as any).heatByGenre.set('pure_meme', 0.1);
      const sig = makeSignal('PEPE');
      const mult = layer.multiplierFor(sig);
      expect(mult).toBeGreaterThan(1.0);
    });
  });
});

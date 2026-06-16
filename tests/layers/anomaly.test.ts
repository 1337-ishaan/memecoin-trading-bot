import { describe, it, expect } from 'vitest';
import { AnomalyLayer, DEFAULT_ANOMALY_CONFIG } from '../../src/layers/anomaly.js';

describe('AnomalyLayer cluster detection', () => {
  it('does not fire below threshold', () => {
    const layer = new AnomalyLayer();
    const result1 = layer.recordBuy('W1', 'MINT', 1, Date.now());
    const result2 = layer.recordBuy('W2', 'MINT', 1, Date.now());
    expect(result1).toBeNull();
    expect(result2).toBeNull();
  });

  it('fires when cluster threshold reached', () => {
    const layer = new AnomalyLayer();
    const t = Date.now();
    const r1 = layer.recordBuy('W1', 'MINT', 1, t);
    const r2 = layer.recordBuy('W2', 'MINT', 2, t + 1000);
    const r3 = layer.recordBuy('W3', 'MINT', 3, t + 2000);
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(r3).not.toBeNull();
    expect(r3!.source).toBe('anomaly');
    expect(r3!.side).toBe('buy');
  });

  it('does not double-count same wallet', () => {
    const layer = new AnomalyLayer();
    const t = Date.now();
    layer.recordBuy('W1', 'MINT', 1, t);
    layer.recordBuy('W1', 'MINT', 1, t + 1000); // same wallet, ignored for cluster count
    const r3 = layer.recordBuy('W1', 'MINT', 1, t + 2000);
    expect(r3).toBeNull();
  });

  it('respects time window', () => {
    const layer = new AnomalyLayer({ ...DEFAULT_ANOMALY_CONFIG, clusterWindowMs: 1000 });
    const t = Date.now();
    layer.recordBuy('W1', 'MINT', 1, t);
    layer.recordBuy('W2', 'MINT', 1, t + 2000); // outside window
    const r3 = layer.recordBuy('W3', 'MINT', 1, t + 5000);
    expect(r3).toBeNull();
  });

  it('prune cleans up old entries', () => {
    const layer = new AnomalyLayer({ ...DEFAULT_ANOMALY_CONFIG, clusterWindowMs: 100 });
    layer.recordBuy('W1', 'MINT1', 1, Date.now() - 1000);
    layer.recordBuy('W1', 'MINT2', 1, Date.now());
    layer.recordBuy('W2', 'MINT2', 1, Date.now());
    layer.recordBuy('W3', 'MINT2', 1, Date.now());
    layer.prune();
    // After prune: MINT1 list is empty (deleted), MINT2 list keeps recent entries
    // Next cluster check on MINT2 should still fire
    const r = layer.recordBuy('W4', 'MINT2', 1, Date.now());
    expect(r).not.toBeNull(); // fresh cluster with MINT2 (4 unique wallets)
  });
});

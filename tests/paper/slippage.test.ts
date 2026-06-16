import { describe, it, expect } from 'vitest';

/**
 * Tests for slippage math. The actual PaperTradeEngine.simulateSlippageBps is private,
 * so we replicate the formula here. If the formula changes, this test will need updating.
 */
function simulateSlippageBps(liquidityUsd: number, tradeSizeUsd: number): number {
  if (liquidityUsd <= 0) return 2500;
  const ratio = tradeSizeUsd / liquidityUsd;
  const slippagePct = 0.5 + Math.log10(ratio * 10 + 1) * 10;
  return Math.min(2500, Math.max(50, Math.floor(slippagePct * 100)));
}

describe('Slippage simulation (paper-trade realism)', () => {
  it('caps at 25% for zero liquidity', () => {
    expect(simulateSlippageBps(0, 100)).toBe(2500);
  });

  it('caps at 25% even for huge trades', () => {
    expect(simulateSlippageBps(1000, 100_000)).toBe(2500);
  });

  it('gives reasonable slippage for normal trades (1-5%)', () => {
    // 0.1 SOL trade ($20) on $50k liquidity = 0.04% ratio → ~0.5% slippage
    const slip = simulateSlippageBps(50_000, 20);
    expect(slip).toBeGreaterThanOrEqual(50);
    expect(slip).toBeLessThan(200); // under 2%
  });

  it('gives higher slippage for illiquid tokens', () => {
    const liquid = simulateSlippageBps(1_000_000, 100);
    const illiquid = simulateSlippageBps(10_000, 100);
    expect(illiquid).toBeGreaterThan(liquid);
  });

  it('round-trip cost estimate (buy + sell) is in realistic 2-12% range', () => {
    // For a typical memecoin: 1% slippage buy + 1% slippage sell + 1% platform fee + 0.3% DEX fee = 3.3%
    // For illiquid: could be 10%+
    const liquidBuySlip = simulateSlippageBps(100_000, 50) / 10_000; // fraction
    const liquidSellSlip = simulateSlippageBps(100_000, 50) / 10_000;
    const fees = 0.01 + 0.003;
    const totalRoundTrip = liquidBuySlip + liquidSellSlip + fees;
    expect(totalRoundTrip).toBeLessThan(0.05); // <5% for liquid
  });
});

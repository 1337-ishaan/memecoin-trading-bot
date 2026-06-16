/**
 * Bot loop — the main orchestrator.
 * 
 * Runs continuously:
 *  1. Poll KOL wallets for new trades
 *  2. Scan nadir candidates
 *  3. Refresh anomaly detection
 *  4. Aggregate signals
 *  5. Execute via paper-trade engine
 *  6. Check open positions for Gake-rule exits
 *  7. Update peak portfolio value
 *  8. Sleep until next tick
 */

import { KolMirrorLayer } from './layers/kol-mirror.js';
import { GakeStrategyLayer } from './layers/gake-strategy.js';
import { MetaCycleLayer } from './layers/meta-cycle.js';
import { AnomalyLayer } from './layers/anomaly.js';
import { RiskManager } from './layers/risk.js';
import { SignalAggregator } from './aggregator/index.js';
import { PaperTradeEngine } from './paper/engine.js';
import { HeliusClient } from './data/helius.js';
import { DexScreenerClient } from './data/dexscreener.js';
import { BirdeyeClient } from './data/birdeye.js';
import { JupiterClient } from './data/jupiter.js';
import { PriceOracle } from './data/oracle.js';
import { loadConfig } from './config/index.js';

const TICK_INTERVAL_MS = 30_000; // 30s

export class Bot {
  private running: boolean = false;
  private helius!: HeliusClient;
  private dexscreener!: DexScreenerClient;
  private birdeye!: BirdeyeClient;
  private jupiter!: JupiterClient;
  private oracle!: PriceOracle;
  private kolLayer!: KolMirrorLayer;
  private gakeLayer!: GakeStrategyLayer;
  private metaLayer!: MetaCycleLayer;
  private anomalyLayer!: AnomalyLayer;
  private risk!: RiskManager;
  private aggregator!: SignalAggregator;
  private paper!: PaperTradeEngine;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Init data clients
    this.helius = new HeliusClient();
    this.dexscreener = new DexScreenerClient();
    this.birdeye = new BirdeyeClient();
    this.jupiter = new JupiterClient();
    this.oracle = new PriceOracle(this.jupiter, this.dexscreener);

    // Init layers
    this.kolLayer = new KolMirrorLayer(this.helius, this.oracle);
    this.gakeLayer = new GakeStrategyLayer(this.dexscreener, this.birdeye, this.oracle);
    this.metaLayer = new MetaCycleLayer(this.dexscreener);
    this.anomalyLayer = new AnomalyLayer();
    this.risk = new RiskManager();
    this.aggregator = new SignalAggregator();
    this.paper = new PaperTradeEngine(this.oracle, this.risk, this.gakeLayer);

    const cfg = loadConfig();
    console.log('========================================');
    console.log('  Memecoin Trading Bot');
    console.log('========================================');
    console.log(`Mode:        ${cfg.TRADING_MODE.toUpperCase()}`);
    console.log(`Helius:      ${this.helius.isConfigured() ? 'configured' : 'NOT configured (KOL Mirror disabled)'}`);
    console.log(`Birdeye:     ${this.birdeye.isConfigured() ? 'configured' : 'NOT configured (ATH detection disabled)'}`);
    console.log(`KOL Wallets: ${this.kolLayer.getTrackedWallets().length}`);
    console.log(`Strategy:    kol=${cfg.WEIGHT_KOL_MIRROR} gake=${cfg.WEIGHT_STRATEGY_REPL} meta=${cfg.WEIGHT_META_CYCLE} anomaly=${cfg.WEIGHT_ANOMALY}`);
    console.log(`Threshold:   ${cfg.SIGNAL_CONFIDENCE_THRESHOLD}`);
    console.log(`Risk:        maxPos=${cfg.MAX_POSITION_PCT}% dailyLoss=${cfg.DAILY_LOSS_LIMIT_PCT}% drawdownKill=${cfg.DRAWDOWN_KILL_SWITCH_PCT}% cashReserve=${cfg.CASH_RESERVE_PCT}%`);
    console.log(`Tick:        ${TICK_INTERVAL_MS / 1000}s`);
    console.log('========================================\n');

    if (!this.helius.isConfigured()) {
      console.warn('⚠️  HELIUS_API_KEY not set. KOL mirror layer will be inactive.');
      console.warn('   Set HELIUS_API_KEY in .env to enable live wallet mirroring.\n');
    }

    // Main loop
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        console.error('[bot] tick error:', err);
      }
      if (this.running) await this.sleep(TICK_INTERVAL_MS);
    }
  }

  stop(): void {
    this.running = false;
    console.log('\n[bot] Stopping after current tick...');
  }

  private async tick(): Promise<void> {
    // 1. KOL wallet mirror
    const newKolSignals = await this.kolLayer.poll();

    // 2. Meta cycle refresh (every 30 min)
    if (this.metaLayer.isStale()) {
      await this.metaLayer.refreshHeat();
    }

    // 3. Scan nadir candidates and emit signals for top ones
    const candidates = this.gakeLayer.scanNadirCandidates();
    for (const c of candidates.slice(0, 5)) {
      this.gakeLayer.emitSignalForToken(c.meta.mint);
    }

    // 4. Aggregate signals and execute
    const activeMints = this.aggregator.getActiveMints();
    let buysExecuted = 0;
    let sellsExecuted = 0;

    for (const mint of activeMints) {
      const agg = this.aggregator.aggregate(mint);
      if (!agg || !agg.shouldAct) continue;

      // Apply meta-cycle multiplier
      const metaMult = this.metaLayer.multiplierFor(agg.contributingSignals[0]);
      const adjustedConfidence = agg.confidence * metaMult;
      if (adjustedConfidence < loadConfig().SIGNAL_CONFIDENCE_THRESHOLD) continue;

      if (agg.side === 'buy') {
        const result = await this.paper.processBuy(agg);
        if (result) buysExecuted++;
      } else {
        const result = await this.paper.processSell(agg);
        if (result) sellsExecuted++;
      }
      this.aggregator.markConsumed(agg.contributingSignals);
    }

    // 5. Check open positions for Gake-rule exits
    const exits = await this.paper.checkOpenPositions();
    sellsExecuted += exits.length;

    // 6. Update peak
    const portfolio = this.risk.computePortfolio(new Map());
    this.risk.recordPeak(portfolio.totalSol);

    if (buysExecuted || sellsExecuted || newKolSignals) {
      console.log(
        `[tick] kolSignals=${newKolSignals} buys=${buysExecuted} sells=${sellsExecuted} ` +
        `positions=${portfolio.openPositionCount} cash=${portfolio.cashSol.toFixed(2)} ` +
        `total=${portfolio.totalSol.toFixed(2)} pnl=${portfolio.realizedPnlSol.toFixed(2)}SOL`
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

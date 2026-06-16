/**
 * Execution adapter interface.
 * All execution platforms (Trojan, Maestro, Jupiter direct) implement this.
 * In paper mode we don't need a real one — PaperTradeEngine handles simulation.
 * In live mode, an adapter routes the order to the platform.
 */

import type { Position, Trade } from '../signals/types.js';
import { loadConfig } from '../config/index.js';

export interface BuyOrder {
  mint: string;
  /** Amount in SOL to spend */
  amountSol: number;
  /** Max acceptable slippage (basis points) */
  maxSlippageBps: number;
  /** Priority fee in SOL */
  priorityFeeSol: number;
  /** Optional referrer */
  referrer?: string;
}

export interface SellOrder {
  mint: string;
  /** Number of tokens to sell (in smallest units) */
  amountTokens: number;
  /** Max acceptable slippage */
  maxSlippageBps: number;
  /** Priority fee in SOL */
  priorityFeeSol: number;
}

export interface OrderResult {
  success: boolean;
  signature?: string;
  fillPriceUsd?: number;
  amountFilled?: number;
  error?: string;
}

export interface ExecutionAdapter {
  name: string;
  isConfigured(): boolean;
  buy(order: BuyOrder): Promise<OrderResult>;
  sell(order: SellOrder): Promise<OrderResult>;
}

/**
 * Stub Trojan adapter. Real impl would POST to Trojan's HTTP API
 * (or send commands via Telegram bot API).
 * Reference: https://trojan.com (HTTP API exists, undocumented but available)
 */
export class TrojanAdapter implements ExecutionAdapter {
  name = 'trojan';
  private apiUrl: string;
  private apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  isConfigured(): boolean {
    return Boolean(this.apiUrl && this.apiKey);
  }

  async buy(order: BuyOrder): Promise<OrderResult> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Trojan adapter not configured (TROJAN_API_URL/TROJAN_API_KEY)' };
    }
    // TODO: implement when API docs are public
    return { success: false, error: 'TrojanAdapter.buy() not yet implemented — wire to Trojan HTTP API' };
  }

  async sell(order: SellOrder): Promise<OrderResult> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Trojan adapter not configured' };
    }
    return { success: false, error: 'TrojanAdapter.sell() not yet implemented' };
  }
}

/**
 * Stub Maestro adapter.
 * Maestro has a public HTTP API: https://docs.maestrobots.com
 */
export class MaestroAdapter implements ExecutionAdapter {
  name = 'maestro';
  private apiUrl: string;
  private apiKey: string;

  constructor(apiUrl: string, apiKey: string) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
  }

  isConfigured(): boolean {
    return Boolean(this.apiUrl && this.apiKey);
  }

  async buy(order: BuyOrder): Promise<OrderResult> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Maestro adapter not configured (MAESTRO_API_URL/MAESTRO_API_KEY)' };
    }
    return { success: false, error: 'MaestroAdapter.buy() not yet implemented — wire to Maestro API' };
  }

  async sell(order: SellOrder): Promise<OrderResult> {
    if (!this.isConfigured()) {
      return { success: false, error: 'Maestro adapter not configured' };
    }
    return { success: false, error: 'MaestroAdapter.sell() not yet implemented' };
  }
}

/** Factory: returns the configured execution adapter. */
export function createExecutionAdapter(): ExecutionAdapter {
  const cfg = loadConfig();
  switch (cfg.EXECUTION_PLATFORM) {
    case 'trojan':
      return new TrojanAdapter(cfg.TROJAN_API_URL, cfg.TROJAN_API_KEY);
    case 'maestro':
      return new MaestroAdapter(cfg.MAESTRO_API_URL, cfg.MAESTRO_API_KEY);
    default:
      return {
        name: 'noop',
        isConfigured: () => false,
        buy: async () => ({ success: false, error: 'No execution platform configured (set EXECUTION_PLATFORM)' }),
        sell: async () => ({ success: false, error: 'No execution platform configured' }),
      };
  }
}

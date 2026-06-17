/**
 * Helius RPC client for Solana.
 * Used for fetching transactions for KOL wallets, token metadata, and account info.
 *
 * In offline / paper mode without an API key, returns mock/empty data so the
 * bot can still run and backtest against historical snapshots.
 */

import { loadConfig } from '../config/index.js';

export interface ParsedSwap {
  signature: string;
  blockTime: number;
  fee: number;
  /** Token mint swapped FROM (sold). null if SOL. */
  fromMint: string | null;
  /** Token mint swapped TO (bought). null if SOL. */
  toMint: string | null;
  /** Amount of from-token in UI units */
  fromAmount: number;
  /** Amount of to-token in UI units */
  toAmount: number;
  /** SOL amount involved (estimated) */
  solAmount: number;
}

interface HeliusRpcResponse<T> {
  jsonrpc: string;
  id: string;
  result?: T;
  error?: { code: number; message: string };
}

export class HeliusClient {
  private rpcUrl: string;
  private apiKey: string;

  constructor() {
    const cfg = loadConfig();
    this.apiKey = cfg.HELIUS_API_KEY;
    this.rpcUrl = this.apiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`
      : cfg.SOLANA_RPC_URL;
  }

  isConfigured(): boolean {
    // Always "configured" — we use either Helius (preferred) or public RPC.
    // Public RPC has rate limits (~100 req / 10s) but works for getSignatures +
    // getTransaction at 30s poll intervals.
    return Boolean(this.rpcUrl);
  }

  isUsingHelius(): boolean {
    return Boolean(this.apiKey);
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `bot-${Date.now()}`,
        method,
        params,
      }),
    });
    if (!response.ok) {
      throw new Error(`Helius RPC error ${response.status}: ${await response.text()}`);
    }
    const data = (await response.json()) as HeliusRpcResponse<T>;
    if (data.error) {
      throw new Error(`Helius RPC error: ${data.error.message}`);
    }
    return data.result as T;
  }

  /**
   * Get parsed transaction history for a wallet.
   * Returns up to `limit` transactions, most recent first.
   */
  async getTransactionsForWallet(
    wallet: string,
    limit: number = 100,
    before?: string
  ): Promise<ParsedSwap[]> {
    const provider = this.apiKey ? 'Helius' : 'public Solana RPC';
    try {
      const signatures = await this.rpc<any[]>(
        'getSignaturesForAddress',
        [
          wallet,
          { limit, ...(before ? { before } : {}) },
        ]
      );

      if (!signatures || signatures.length === 0) return [];

      const sigs = signatures
        .filter((s: any) => !s.err)
        .map((s: any) => s.signature);

      const txs = await this.rpc<any[]>(
        'getTransactions',
        [sigs]
      );

      const swaps: ParsedSwap[] = [];
      for (const tx of txs) {
        const parsed = this.parseSwap(tx);
        if (parsed) swaps.push(parsed);
      }
      return swaps;
    } catch (err) {
      // Public RPC often 429s or returns compressed tx we can't parse.
      // Log once per call but don't crash the bot.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') || msg.includes('rate limit')) {
        // Only log rate-limit warnings occasionally to avoid spam
        if (Math.random() < 0.1) console.warn(`[helius] ${provider} rate-limited`);
      } else {
        console.warn(`[helius] ${provider} error: ${msg.slice(0, 200)}`);
      }
      return [];
    }
  }

  /**
   * Parse a transaction looking for a token swap via Jupiter / Raydium / Pump.fun.
   * Heuristic: find token balance changes in preBalances/postBalances.
   */
  private parseSwap(tx: any): ParsedSwap | null {
    if (!tx || !tx.blockTime) return null;

    const meta = tx.meta;
    if (!meta || meta.err) return null;

    const preBalances = meta.preTokenBalances || [];
    const postBalances = meta.postTokenBalances || [];

    if (preBalances.length === 0 && postBalances.length === 0) return null;

    // Find token balance changes
    const changes: Array<{ mint: string; amount: number; owner: string }> = [];
    const balanceMap = new Map<string, { mint: string; pre: number; post: number; owner: string }>();

    for (const bal of preBalances) {
      const key = `${bal.mint}-${bal.owner}`;
      balanceMap.set(key, {
        mint: bal.mint,
        pre: bal.uiTokenAmount.uiAmount || 0,
        post: 0,
        owner: bal.owner,
      });
    }
    for (const bal of postBalances) {
      const key = `${bal.mint}-${bal.owner}`;
      const existing = balanceMap.get(key);
      if (existing) {
        existing.post = bal.uiTokenAmount.uiAmount || 0;
      } else {
        balanceMap.set(key, {
          mint: bal.mint,
          pre: 0,
          post: bal.uiTokenAmount.uiAmount || 0,
          owner: bal.owner,
        });
      }
    }

    for (const val of balanceMap.values()) {
      const diff = val.post - val.pre;
      if (Math.abs(diff) > 0) {
        changes.push({ mint: val.mint, amount: diff, owner: val.owner });
      }
    }

    // Identify buy/sell: 1 token decreased (sold), 1 token increased (bought)
    if (changes.length < 2) return null;

    const decreased = changes.filter((c) => c.amount < 0);
    const increased = changes.filter((c) => c.amount > 0);

    if (decreased.length === 0 || increased.length === 0) return null;

    // The "from" is the one with the larger absolute value, typically SOL or the sold token
    const from = decreased.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
    const to = increased.sort((a, b) => b.amount - a.amount)[0];

    // SOL is wrapped as "So11111111111111111111111111111111111111111" or "11111111111111111111111111111111"
    const SOL_MINT = 'So11111111111111111111111111111111111111111';
    const fromMint = from.mint === SOL_MINT ? null : from.mint;
    const toMint = to.mint === SOL_MINT ? null : to.mint;

    // Estimate SOL amount from native balance change
    const nativeDiff = (meta.postBalances?.[0] ?? 0) - (meta.preBalances?.[0] ?? 0);
    const solAmount = Math.abs(nativeDiff) / 1e9 - (tx.transaction?.message?.header?.feeNumerator ?? 5000) / 1e9;

    return {
      signature: tx.transaction?.signatures?.[0] ?? '',
      blockTime: tx.blockTime * 1000,
      fee: (meta.fee ?? 5000) / 1e9,
      fromMint,
      toMint,
      fromAmount: Math.abs(from.amount),
      toAmount: Math.abs(to.amount),
      solAmount: Math.max(0, solAmount),
    };
  }
}

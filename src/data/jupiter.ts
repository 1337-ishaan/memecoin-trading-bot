/**
 * Jupiter Aggregator API client.
 * Used for swap quotes (paper-trade pricing) and routing.
 *
 * https://quote-api.jup.ag/v6
 */

import { loadConfig } from '../config/index.js';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee?: { amount: string; feeBps: number };
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
}

const SOL_MINT = 'So11111111111111111111111111111111111111111';

export class JupiterClient {
  private baseUrl: string;

  constructor() {
    const cfg = loadConfig();
    this.baseUrl = cfg.JUPITER_API_URL;
  }

  isConfigured(): boolean {
    return true;
  }

  /**
   * Get a quote for swapping `amountIn` (in raw smallest units) of `inputMint` to `outputMint`.
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amountInSmallestUnits: number | string,
    slippageBps: number = 200
  ): Promise<JupiterQuote | null> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(amountInSmallestUnits),
      slippageBps: String(slippageBps),
      swapMode: 'ExactIn',
    });

    const url = `${this.baseUrl}/quote?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    const quote = (await response.json()) as JupiterQuote;
    return quote;
  }

  /**
   * Get a SOL→token quote and return effective price (SOL per token, token per SOL).
   */
  async getSolToTokenPrice(
    tokenMint: string,
    solAmount: number
  ): Promise<{ pricePerTokenSol: number; priceImpactPct: number } | null> {
    const lamports = Math.floor(solAmount * 1e9);
    const quote = await this.getQuote(SOL_MINT, tokenMint, lamports);
    if (!quote) return null;

    const tokensOut = Number(quote.outAmount);
    if (tokensOut === 0) return null;

    return {
      pricePerTokenSol: solAmount / tokensOut,
      priceImpactPct: Number(quote.priceImpactPct),
    };
  }

  /**
   * Get a token→SOL quote for an exit.
   */
  async getTokenToSolPrice(
    tokenMint: string,
    tokenAmountSmallestUnits: number | string
  ): Promise<{ solOut: number; pricePerTokenSol: number; priceImpactPct: number } | null> {
    const quote = await this.getQuote(tokenMint, SOL_MINT, tokenAmountSmallestUnits);
    if (!quote) return null;

    const solOut = Number(quote.outAmount) / 1e9;
    return {
      solOut,
      pricePerTokenSol: solOut / (Number(tokenAmountSmallestUnits) / 1e9),
      priceImpactPct: Number(quote.priceImpactPct),
    };
  }
}

export { SOL_MINT };

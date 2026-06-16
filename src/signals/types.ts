// Core type definitions for the trading bot

export type TradingMode = 'paper' | 'live';

export type Side = 'buy' | 'sell';

export type SignalSource =
  | 'kol_mirror'
  | 'gake_strategy'
  | 'meta_cycle'
  | 'anomaly'
  | 'risk_override';

export type TokenGenre =
  | 'pure_meme'
  | 'celebrity'
  | 'art'
  | 'ai_tech'
  | 'community_web2'
  | 'news'
  | 'unknown';

/** A trade signal emitted by a strategy layer. */
export interface Signal {
  id: string;
  source: SignalSource;
  mint: string;            // SPL token mint address
  symbol?: string;         // Token symbol (best-effort)
  side: Side;
  /** Suggested size as fraction of portfolio (0-1) */
  sizePct: number;
  /** 0-1 confidence that this signal is good */
  confidence: number;
  /** Why the signal was emitted */
  reason: string;
  /** Optional reference: a KOL wallet that triggered this */
  triggerWallet?: string;
  /** Optional reference: a specific transaction signature */
  triggerSignature?: string;
  /** Unix ms timestamp */
  timestamp: number;
  /** Signal expires after this many seconds */
  ttlSeconds: number;
  /** Extra structured context for post-mortem */
  metadata?: Record<string, unknown>;
}

export interface Position {
  id: number;
  mint: string;
  symbol: string;
  entryPrice: number;        // Price in USD or SOL at entry
  entryTimestamp: number;
  amountSol: number;         // Size of position in SOL
  amountTokens: number;      // Size of position in tokens
  /** Has the 50% take-profit at 2x been taken? */
  partialTaken: boolean;
  /** Current high-water mark since entry (for trailing stop) */
  highWaterPrice: number;
  /** Source that opened the position */
  source: SignalSource;
  /** Layer signals that contributed to opening */
  contributingSignals: string[];
  status: 'open' | 'closed';
  closeTimestamp?: number;
  closePrice?: number;
  closeReason?: string;
  realizedPnlSol?: number;
  realizedPnlPct?: number;
}

export interface Trade {
  id: number;
  mint: string;
  symbol: string;
  side: Side;
  price: number;
  amountSol: number;
  amountTokens: number;
  timestamp: number;
  signature?: string;
  source: SignalSource;
  signalId?: string;
  /** Simulated fill conditions for paper mode */
  simulatedSlippageBps?: number;
  simulatedPriorityFeeSol?: number;
  simulatedPlatformFeePct?: number;
  mode: TradingMode;
  positionId?: number;
  pnlSol?: number;
  pnlPct?: number;
}

export interface Portfolio {
  /** Total value in SOL (cash + positions) */
  totalSol: number;
  /** Available cash in SOL */
  cashSol: number;
  /** Sum of position values in SOL */
  positionsSol: number;
  /** Realized PnL in SOL since inception */
  realizedPnlSol: number;
  /** Unrealized PnL in SOL on open positions */
  unrealizedPnlSol: number;
  /** Peak total value (for drawdown calc) */
  peakSol: number;
  /** Drawdown from peak (negative number, e.g., -0.20) */
  drawdownPct: number;
  /** Open position count */
  openPositionCount: number;
}

export interface TokenMeta {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Market cap in USD */
  mcapUsd?: number;
  /** Liquidity in USD */
  liquidityUsd?: number;
  /** Current price in USD */
  priceUsd?: number;
  /** 24h volume in USD */
  volume24hUsd?: number;
  /** 30-day all-time high price (USD) */
  ath30dUsd?: number;
  /** 30-day all-time low price (USD) */
  atl30dUsd?: number;
  /** Drawdown from 30d ATH (0-1, e.g., 0.80 = down 80%) */
  drawdownFromAth30d?: number;
  /** Holder count */
  holderCount?: number;
  /** Top-10 holder concentration (0-1) */
  top10Concentration?: number;
  /** Mint authority still active? */
  mintAuthorityActive?: boolean;
  /** Freeze authority still active? */
  freezeAuthorityActive?: boolean;
  /** LP locked? */
  lpLocked?: boolean;
  /** Genre classification */
  genre?: TokenGenre;
  /** Last updated unix ms */
  updatedAt: number;
}

export interface KolTrade {
  signature: string;
  wallet: string;
  mint: string;
  symbol?: string;
  side: Side;
  amountSol: number;
  amountTokens: number;
  priceUsd?: number;
  timestamp: number;
  /** Detected via */
  detectedAt: number;
}

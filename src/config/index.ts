import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

const tradingModeSchema = z.enum(['paper', 'live']);

const envSchema = z.object({
  TRADING_MODE: tradingModeSchema.default('paper'),

  // Risk
  MAX_POSITION_PCT: z.coerce.number().min(0.01).max(100).default(5),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().int().min(1).max(100).default(15),
  DAILY_LOSS_LIMIT_PCT: z.coerce.number().min(0.1).max(100).default(10),
  DRAWDOWN_KILL_SWITCH_PCT: z.coerce.number().min(0.1).max(100).default(30),
  CASH_RESERVE_PCT: z.coerce.number().min(0).max(100).default(30),
  MAX_TRADES_PER_DAY: z.coerce.number().int().min(1).max(1000).default(50),

  // Strategy weights (must sum to 1.0 in practice, but we don't enforce)
  WEIGHT_KOL_MIRROR: z.coerce.number().min(0).max(1).default(0.30),
  WEIGHT_STRATEGY_REPL: z.coerce.number().min(0).max(1).default(0.40),
  WEIGHT_META_CYCLE: z.coerce.number().min(0).max(1).default(0.10),
  WEIGHT_ANOMALY: z.coerce.number().min(0).max(1).default(0.20),
  SIGNAL_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),

  // KOL wallets (comma-separated)
  KOL_WALLETS: z.string().default(
    'DNfuF1L62WWyW3pNakVkyGGFzVVhj4Yr52jSmdTyeBHm,HUpPyLU8KWisCAr3mzWy2FKT6uuxQ2qGgJQxyTpDoes5'
  ),

  // Gake strategy
  NADIR_DRAWDOWN_MIN: z.coerce.number().min(0).max(1).default(0.70),
  NADIR_DRAWDOWN_MAX: z.coerce.number().min(0).max(1).default(0.90),
  MCAP_MIN_USD: z.coerce.number().min(0).default(100_000),
  MCAP_PREFERRED_USD: z.coerce.number().min(0).default(1_000_000),
  EXIT_TAKE_PROFIT: z.coerce.number().min(1.01).default(2.0),
  EXIT_TRAILING_STOP: z.coerce.number().min(0.01).max(0.99).default(0.20),

  // Data providers (optional — paper mode works without)
  HELIUS_API_KEY: z.string().optional().default(''),
  BIRDEYE_API_KEY: z.string().optional().default(''),
  JUPITER_API_URL: z.string().default('https://quote-api.jup.ag/v6'),
  DEXSCREENER_API_URL: z.string().default('https://api.dexscreener.com/latest'),
  SOLANA_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),

  // Execution (live only)
  EXECUTION_PLATFORM: z.enum(['trojan', 'maestro', 'none']).default('none'),
  TROJAN_API_URL: z.string().optional().default(''),
  TROJAN_API_KEY: z.string().optional().default(''),
  MAESTRO_API_URL: z.string().optional().default(''),
  MAESTRO_API_KEY: z.string().optional().default(''),

  // Telegram notifications (optional)
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),
  TELEGRAM_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),

  // Paper-trade starting capital
  PAPER_INITIAL_SOL: z.coerce.number().min(1).default(100),
});

export type AppConfig = z.infer<typeof envSchema> & {
  KOL_WALLETS_LIST: string[];
};

let cached: AppConfig | null = null;

export function loadConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  if (cached) return cached;

  const env = { ...process.env, ...overrides };
  const parsed = envSchema.parse(env);

  const kolList = parsed.KOL_WALLETS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  cached = { ...parsed, KOL_WALLETS_LIST: kolList };

  // sanity checks
  const totalWeight =
    cached.WEIGHT_KOL_MIRROR +
    cached.WEIGHT_STRATEGY_REPL +
    cached.WEIGHT_META_CYCLE +
    cached.WEIGHT_ANOMALY;
  if (Math.abs(totalWeight - 1.0) > 0.01) {
    console.warn(
      `[config] Strategy weights sum to ${totalWeight.toFixed(2)} (expected ~1.0). ` +
      `Adjust to taste: kol=${cached.WEIGHT_KOL_MIRROR} repl=${cached.WEIGHT_STRATEGY_REPL} ` +
      `meta=${cached.WEIGHT_META_CYCLE} anomaly=${cached.WEIGHT_ANOMALY}`
    );
  }

  if (cached.NADIR_DRAWDOWN_MIN >= cached.NADIR_DRAWDOWN_MAX) {
    throw new Error(
      `NADIR_DRAWDOWN_MIN (${cached.NADIR_DRAWDOWN_MIN}) must be < NADIR_DRAWDOWN_MAX (${cached.NADIR_DRAWDOWN_MAX})`
    );
  }

  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}

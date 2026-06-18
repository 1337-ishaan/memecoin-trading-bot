/**
 * Telegram Bot API client for notifications.
 *
 * Sends alerts to a configured chat when key bot events happen:
 *   - Bot started / stopped
 *   - Trade executed (buy/sell)
 *   - Risk event (kill switch, daily loss limit, blacklist)
 *   - Errors
 *
 * Setup:
 *   1. Message @BotFather on Telegram, send /newbot, follow prompts
 *   2. Copy the bot token to TELEGRAM_BOT_TOKEN in .env
 *   3. Message your new bot, then visit:
 *      https://api.telegram.org/bot<TOKEN>/getUpdates
 *      to find your chat_id, copy to TELEGRAM_CHAT_ID
 *   4. Set TELEGRAM_ENABLED=true
 *   5. Test: npm run cli -- send-test
 *
 * The client is fire-and-forget by design — failed sends should not crash the bot.
 * Rate limits: 30 msg/sec globally, 1 msg/sec per chat.
 */

import { loadConfig } from '../config/index.js';

const TELEGRAM_API = 'https://api.telegram.org';

export type AlertSeverity = 'info' | 'success' | 'warning' | 'error';

export interface Alert {
  severity: AlertSeverity;
  title: string;
  message: string;
  /** Optional structured data shown as a code block */
  data?: Record<string, string | number>;
}

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '🚨',
};

export class TelegramClient {
  private botToken: string;
  private chatId: string;
  private enabled: boolean;

  constructor() {
    const cfg = loadConfig();
    this.botToken = cfg.TELEGRAM_BOT_TOKEN;
    this.chatId = cfg.TELEGRAM_CHAT_ID;
    this.enabled = cfg.TELEGRAM_ENABLED && Boolean(this.botToken) && Boolean(this.chatId);
  }

  isConfigured(): boolean {
    return this.enabled;
  }

  /**
   * Send an alert. Returns true on success, false on failure (or if not configured).
   * Never throws — failure to send must not crash the bot.
   * Retries up to 3 times with exponential backoff on network errors.
   */
  async send(alert: Alert): Promise<boolean> {
    if (!this.enabled) return false;
    const text = this.format(alert);
    const url = `${TELEGRAM_API}/bot${this.botToken}/sendMessage`;

    const maxAttempts = 3;
    const baseTimeoutMs = 15_000; // 15s per attempt, generous for slow networks
    let lastError: string = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), baseTimeoutMs);

        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          return true;
        }
        const body = await response.text();
        // 4xx errors (except 429) are not retryable
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          console.warn(`[telegram] non-retryable ${response.status}: ${body.slice(0, 200)}`);
          return false;
        }
        // 5xx + 429 are retryable
        lastError = `${response.status}: ${body.slice(0, 200)}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;
        // Network errors: retry
      }
      if (attempt < maxAttempts) {
        const backoff = 1000 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    console.warn(`[telegram] send failed after ${maxAttempts} attempts: ${lastError}`);
    return false;
  }

  /**
   * Send a test message. Used by the CLI to verify the bot is set up correctly.
   */
  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    if (!this.botToken) {
      return { ok: false, error: 'TELEGRAM_BOT_TOKEN is empty. Set it in .env first.' };
    }
    if (!this.chatId) {
      return { ok: false, error: 'TELEGRAM_CHAT_ID is empty. Message the bot, then check getUpdates.' };
    }
    if (!this.enabled) {
      return { ok: false, error: 'TELEGRAM_ENABLED is false. Set it to true in .env.' };
    }
    const ok = await this.send({
      severity: 'success',
      title: '🧪 Test alert',
      message: 'Memecoin trading bot Telegram integration is working.',
      data: { timestamp: new Date().toISOString() },
    });
    return ok ? { ok: true } : { ok: false, error: 'Telegram API rejected the message. Check bot token + chat_id.' };
  }

  private format(alert: Alert): string {
    const emoji = SEVERITY_EMOJI[alert.severity];
    let text = `${emoji} <b>${escapeHtml(alert.title)}</b>\n\n${escapeHtml(alert.message)}`;
    if (alert.data && Object.keys(alert.data).length > 0) {
      const lines = Object.entries(alert.data)
        .map(([k, v]) => `  <code>${escapeHtml(k)}</code>: ${escapeHtml(String(v))}`)
        .join('\n');
      text += `\n\n${lines}`;
    }
    return text;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Convenience constructors for common alerts. */
export const TelegramAlerts = {
  botStarted: (mode: string, trackedWallets: number) => ({
    severity: 'info' as AlertSeverity,
    title: 'Bot started',
    message: `Memecoin trading bot is now running.`,
    data: { mode, trackedWallets, time: new Date().toISOString() },
  }),

  botStopped: (reason: string = 'shutdown signal') => ({
    severity: 'warning' as AlertSeverity,
    title: 'Bot stopped',
    message: `The bot has stopped.`,
    data: { reason, time: new Date().toISOString() },
  }),

  tradeExecuted: (
    side: 'buy' | 'sell',
    symbol: string,
    mint: string,
    sizeSol: number,
    priceUsd: number,
    pnlSol?: number,
    source?: string
  ): Alert => ({
    severity: side === 'buy' ? 'info' : (pnlSol && pnlSol > 0 ? 'success' : 'warning'),
    title: `${side === 'buy' ? '🟢 Bought' : '🔴 Sold'} ${symbol}`,
    message: side === 'buy'
      ? `Opened a position.`
      : `Closed${pnlSol !== undefined ? ` with PnL ${pnlSol > 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL` : ''}.`,
    data: {
      mint,
      sizeSol: sizeSol.toFixed(4),
      priceUsd: priceUsd.toExponential(3),
      ...(pnlSol !== undefined ? { pnlSol: pnlSol.toFixed(4) } : {}),
      ...(source ? { source } : {}),
    },
  }),

  riskEvent: (kind: string, details: string) => ({
    severity: 'warning' as AlertSeverity,
    title: `Risk event: ${kind}`,
    message: details,
    data: { time: new Date().toISOString() },
  }),

  killSwitch: (drawdownPct: number) => ({
    severity: 'error' as AlertSeverity,
    title: '🚨 Drawdown kill switch triggered',
    message: `Portfolio drawdown exceeded threshold. Trading halted.`,
    data: { drawdownPct: drawdownPct.toFixed(2), time: new Date().toISOString() },
  }),

  error: (context: string, err: unknown) => ({
    severity: 'error' as AlertSeverity,
    title: `Error: ${context}`,
    message: err instanceof Error ? err.message : String(err),
    data: { time: new Date().toISOString() },
  }),
};

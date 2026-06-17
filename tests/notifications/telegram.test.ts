import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TelegramClient, TelegramAlerts, type Alert } from '../../src/notifications/telegram.js';

const originalFetch = globalThis.fetch;

describe('TelegramClient', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-12345';
    process.env.TELEGRAM_CHAT_ID = '123456789';
    process.env.TELEGRAM_ENABLED = 'true';
    // Reset config cache
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_ENABLED;
    globalThis.fetch = originalFetch;
  });

  it('reports not configured when token is empty', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '';
    vi.resetModules();
    const { TelegramClient: C } = await import('../../src/notifications/telegram.js');
    const { resetConfigCache } = await import('../../src/config/index.js');
    resetConfigCache();
    const c = new C();
    expect(c.isConfigured()).toBe(false);
    const result = await c.sendTest();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('reports not configured when chat_id is empty', async () => {
    process.env.TELEGRAM_CHAT_ID = '';
    vi.resetModules();
    const { TelegramClient: C } = await import('../../src/notifications/telegram.js');
    const { resetConfigCache } = await import('../../src/config/index.js');
    resetConfigCache();
    const c = new C();
    expect(c.isConfigured()).toBe(false);
  });

  it('reports not configured when enabled is false', async () => {
    process.env.TELEGRAM_ENABLED = 'false';
    vi.resetModules();
    const { TelegramClient: C } = await import('../../src/notifications/telegram.js');
    const { resetConfigCache } = await import('../../src/config/index.js');
    resetConfigCache();
    const c = new C();
    expect(c.isConfigured()).toBe(false);
  });

  it('sends a message to the correct API endpoint with correct payload', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: any;
    globalThis.fetch = vi.fn(async (url, opts) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(opts?.body as string);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as any;

    const c = new TelegramClient();
    const alert: Alert = {
      severity: 'info',
      title: 'Test',
      message: 'Hello world',
      data: { foo: 'bar' },
    };
    const ok = await c.send(alert);
    expect(ok).toBe(true);
    expect(capturedUrl).toBe('https://api.telegram.org/bottest-bot-token-12345/sendMessage');
    expect(capturedBody.chat_id).toBe('123456789');
    expect(capturedBody.text).toContain('Test');
    expect(capturedBody.text).toContain('Hello world');
    expect(capturedBody.text).toContain('bar');
    expect(capturedBody.parse_mode).toBe('HTML');
  });

  it('returns false on HTTP error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"ok":false,"description":"bad token"}', { status: 401 })
    ) as any;
    const c = new TelegramClient();
    const ok = await c.send({ severity: 'info', title: 'x', message: 'y' });
    expect(ok).toBe(false);
  });

  it('returns false on fetch exception (does not throw)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as any;
    const c = new TelegramClient();
    const ok = await c.send({ severity: 'info', title: 'x', message: 'y' });
    expect(ok).toBe(false);
  });

  it('escapes HTML in alert content to prevent injection', async () => {
    let capturedBody: any;
    globalThis.fetch = vi.fn(async (_url, opts) => {
      capturedBody = JSON.parse(opts?.body as string);
      return new Response('{"ok":true}', { status: 200 });
    }) as any;
    const c = new TelegramClient();
    await c.send({
      severity: 'info',
      title: '<script>alert(1)</script>',
      message: 'a & b < c',
    });
    expect(capturedBody.text).toContain('&lt;script&gt;');
    expect(capturedBody.text).toContain('a &amp; b &lt; c');
  });
});

describe('TelegramAlerts (constructors)', () => {
  it('builds botStarted alert with mode + wallets', () => {
    const a = TelegramAlerts.botStarted('paper', 2);
    expect(a.severity).toBe('info');
    expect(a.title).toBe('Bot started');
    expect(a.data?.mode).toBe('paper');
    expect(a.data?.trackedWallets).toBe(2);
  });

  it('builds botStopped with reason', () => {
    const a = TelegramAlerts.botStopped('SIGTERM');
    expect(a.severity).toBe('warning');
    expect(a.data?.reason).toBe('SIGTERM');
  });

  it('builds tradeExecuted buy with mint + size', () => {
    const a = TelegramAlerts.tradeExecuted('buy', 'PEPE', 'MINT123', 0.5, 0.001, undefined, 'kol_mirror');
    expect(a.title).toContain('Bought');
    expect(a.title).toContain('PEPE');
    expect(a.data?.mint).toBe('MINT123');
    expect(a.data?.source).toBe('kol_mirror');
  });

  it('builds tradeExecuted sell with PnL', () => {
    const a = TelegramAlerts.tradeExecuted('sell', 'PEPE', 'MINT', 0.5, 0.002, 0.1, 'gake_strategy');
    expect(a.severity).toBe('success');
    expect(a.data?.pnlSol).toBe('0.1000');
  });

  it('builds killSwitch alert with drawdown', () => {
    const a = TelegramAlerts.killSwitch(-32.5);
    expect(a.severity).toBe('error');
    expect(a.data?.drawdownPct).toBe('-32.50');
  });

  it('builds error alert from unknown', () => {
    const a = TelegramAlerts.error('test', new Error('boom'));
    expect(a.severity).toBe('error');
    expect(a.message).toBe('boom');
  });
});

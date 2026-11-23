// Webhook sender allowlist (GET {api}/ips) and the checkout switch.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPaddleSenderCache, ipv4InCidr, isPaddleSender, paddleSenderCidrs } from '../src/billing/paddle-ips';
import { paddleClientConfig } from '../src/billing/paddle';
import { paddleWebhookRouter } from '../src/routes/webhooks/paddle';
import type { Env } from '../src/types';
import { paddleSignature, requestUrl } from './app-helpers';
import subscriptionCreated from './fixtures/paddle/subscription.created.json';

const SANDBOX_IPS = ['34.194.127.46/32', '54.234.237.108/32', '3.208.120.145/32'];
const LIVE_IPS = ['34.232.58.13/32', '34.195.105.136/32'];
const HOUR = 60 * 60 * 1000;

function mockIps(lists: Record<string, string[] | 'down'>): string[] {
  const seen: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = requestUrl(input as RequestInfo);
    seen.push(url.href);
    const list = lists[url.origin];
    if (url.pathname !== '/ips' || list === undefined) throw new Error(`unexpected fetch ${url.href}`);
    if (list === 'down') return new Response('unavailable', { status: 503 });
    return Response.json({ data: { ipv4_cidrs: list }, meta: { request_id: 'req_1' } });
  });
  return seen;
}

beforeEach(() => clearPaddleSenderCache());
afterEach(() => vi.restoreAllMocks());

describe('address matching', () => {
  it('matches /32 and wider IPv4 ranges and nothing malformed', () => {
    expect(ipv4InCidr('34.194.127.46', '34.194.127.46/32')).toBe(true);
    expect(ipv4InCidr('34.194.127.47', '34.194.127.46/32')).toBe(false);
    expect(ipv4InCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipv4InCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);
    for (const ip of ['', '34.194.127', '34.194.127.46.1', '34.194.127.256', '::ffff:34.194.127.46', '2001:db8::1', 'x.y.z.w']) {
      expect(ipv4InCidr(ip, '34.194.127.46/32'), ip).toBe(false);
    }
    expect(ipv4InCidr('34.194.127.46', 'not-a-cidr')).toBe(false);
    expect(isPaddleSender(null, SANDBOX_IPS)).toBe(false);
    expect(isPaddleSender('54.234.237.108', SANDBOX_IPS)).toBe(true);
  });
});

describe('the sender list', () => {
  it('is fetched from the environment\'s own API, cached for an hour, and refreshed after that', async () => {
    const seen = mockIps({ 'https://sandbox-api.paddle.com': SANDBOX_IPS, 'https://api.paddle.com': LIVE_IPS });
    expect(await paddleSenderCidrs('https://sandbox-api.paddle.com', 0)).toEqual(SANDBOX_IPS);
    expect(await paddleSenderCidrs('https://api.paddle.com', 0)).toEqual(LIVE_IPS);
    expect(await paddleSenderCidrs('https://sandbox-api.paddle.com', HOUR - 1)).toEqual(SANDBOX_IPS);
    expect(seen).toHaveLength(2);
    await paddleSenderCidrs('https://sandbox-api.paddle.com', HOUR + 1);
    expect(seen).toHaveLength(3);
  });

  it('keeps the last good list while Paddle is unreachable, and is null if it never had one', async () => {
    mockIps({ 'https://api.paddle.com': LIVE_IPS });
    await paddleSenderCidrs('https://api.paddle.com', 0);
    vi.restoreAllMocks();
    mockIps({ 'https://api.paddle.com': 'down' });
    expect(await paddleSenderCidrs('https://api.paddle.com', 2 * HOUR)).toEqual(LIVE_IPS);
    clearPaddleSenderCache();
    expect(await paddleSenderCidrs('https://api.paddle.com', 3 * HOUR)).toBeNull();
  });

  it('ignores a malformed answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: { ipv4_cidrs: ['nonsense', 42] } }));
    expect(await paddleSenderCidrs('https://api.paddle.com', 0)).toBeNull();
  });
});

describe('POST /webhooks/paddle outside local development', () => {
  const deployed: Env = { ...env, ENVIRONMENT: 'staging', PADDLE_ENV: 'sandbox' };
  const raw = JSON.stringify({ ...subscriptionCreated, event_id: 'evt_ips_0001' });

  async function deliver(ip: string | null): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'paddle-signature': await paddleSignature(raw) };
    if (ip) headers['cf-connecting-ip'] = ip;
    return paddleWebhookRouter.request('/paddle', { method: 'POST', headers, body: raw }, deployed);
  }

  it('accepts a correctly signed event from one of Paddle\'s addresses', async () => {
    mockIps({ 'https://sandbox-api.paddle.com': SANDBOX_IPS });
    expect((await deliver('34.194.127.46')).status).toBe(200);
  });

  it('refuses any other sender with 403 before reading the body, even with a valid signature', async () => {
    mockIps({ 'https://sandbox-api.paddle.com': SANDBOX_IPS });
    const text = vi.spyOn(Request.prototype, 'arrayBuffer');
    for (const ip of ['203.0.113.9', '34.232.58.13', '2001:db8::1', null]) {
      const response = await deliver(ip);
      expect(response.status, String(ip)).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('forbidden');
    }
    expect(text).not.toHaveBeenCalled();
  });

  it('answers 503 (Paddle retries) when the list was never available', async () => {
    mockIps({ 'https://sandbox-api.paddle.com': 'down' });
    expect((await deliver('34.194.127.46')).status).toBe(503);
  });

  it('is not checked in local development and tests', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const body = raw.replace('evt_ips_0001', 'evt_ips_0002');
    const local = await paddleWebhookRouter.request(
      '/paddle',
      { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': await paddleSignature(body) }, body },
      env,
    );
    expect(local.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the checkout switch', () => {
  it('keeps checkout closed unless CHECKOUT_ENABLED is exactly "true", even with every Paddle value set', () => {
    expect(paddleClientConfig(env)).not.toBeNull();
    for (const value of [undefined, '', 'false', 'TRUE', '1']) {
      expect(paddleClientConfig({ ...env, CHECKOUT_ENABLED: value }), String(value)).toBeNull();
    }
  });
});

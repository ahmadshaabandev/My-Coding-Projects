// The code of the PDF feature deployed to a database that does not have migration 0006 yet
// (pdf_usage, browser_usage): with PDFs off, nothing outside PDFs may break. The dashboard's
// /api/me reads pdf_usage and the daily cron reads browser_usage, so both must degrade.
// This file drops the two tables; storage is isolated per test file.
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { createUser, dashboard, sessionCookieFor } from './app-helpers';

const off: Env = { ...env, PDF_ENABLED: 'false' };

beforeAll(async () => {
  await env.DB.exec('DROP TABLE pdf_usage');
  await env.DB.exec('DROP TABLE browser_usage');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deployed before migration 0006', () => {
  it('GET /api/me still answers, with usage.pdf at zero', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = await createUser('free');
    const response = await dashboard(await sessionCookieFor(user.id), 'GET', '/api/me', undefined, off);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { usage: { pdf: unknown } }).usage.pdf).toEqual({ count: 0, images: 0 });
  });

  it('the daily cron cleans up and runs the PDF alarm without failing', async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.map(String).join(' ')));
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ id: 'em_1' }));
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '17 3 * * *' }), off, ctx);
    await waitOnExecutionContext(ctx);
    expect(errors.filter((line) => /cleanup failed|pdf budget alarm failed/.test(line))).toEqual([]);
    expect(logs.some((line) => line.startsWith('cleanup:'))).toBe(true);
    expect(logs.some((line) => line.startsWith('pdf budget:') && line.includes('"over":false'))).toBe(true);
  });
});

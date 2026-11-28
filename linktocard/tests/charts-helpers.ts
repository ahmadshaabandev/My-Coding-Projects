// Helpers for the chart tests that drive the real Worker app.
import { env } from 'cloudflare:workers';
import { buildChartUrl } from '../src/charts/url';
import type { OgExtension } from '../src/lib/signed-url';
import type { Env, SiteRow } from '../src/types';
import { bearer, bytesOf, call, siteSecret } from './app-helpers';

/** A small chart that draws quickly. */
export const CHART = {
  type: 'bar',
  title: 'Monthly revenue',
  labels: ['Jan', 'Feb', 'Mar'],
  series: [{ name: 'Revenue', data: [4200, 5100, 4800] }],
  width: 300,
  height: 200,
};

/** The same chart with another title: another chart. */
export const chartNamed = (title: string): typeof CHART => ({ ...CHART, title });

/** Path + query of a correctly signed chart URL. `chart` is the JSON text, or an object written with JSON.stringify. */
export async function chartPath(site: SiteRow, chart: unknown = CHART, ext: OgExtension = 'png', secret?: string): Promise<string> {
  const url = await buildChartUrl({
    baseUrl: 'http://localhost',
    siteId: site.id,
    ext,
    chartJson: typeof chart === 'string' ? chart : JSON.stringify(chart),
    secret: secret ?? (await siteSecret(site)),
  });
  return url.slice('http://localhost'.length);
}

export interface Shown {
  status: number;
  cache: string | null;
  credits: string | null;
  /** The cache key, from the ETag. */
  key: string;
  bytes: Uint8Array;
  headers: Headers;
}

/** One request for a chart image, body read. */
export async function show(path: string, bindings: Env = env, init: RequestInit = {}): Promise<Shown> {
  const response = await call(path, init, bindings);
  return {
    status: response.status,
    cache: response.headers.get('x-ltc-cache'),
    credits: response.headers.get('x-ltc-credits-used'),
    key: (response.headers.get('etag') ?? '').replaceAll('"', ''),
    bytes: await bytesOf(response),
    headers: response.headers,
  };
}

export function postChart(secret: string | null, body: unknown, bindings: Env = env): Promise<Response> {
  return call(
    '/v1/charts',
    {
      method: 'POST',
      headers: { ...(secret === null ? {} : bearer(secret)), 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    bindings,
  );
}

/** The free chart maker's request, the way the page sends it. */
export function postTool(body: unknown, bindings: Env = env, headers: Record<string, string> = {}): Promise<Response> {
  return call(
    '/api/tools/chart',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(env.APP_URL).origin, 'cf-connecting-ip': '203.0.113.7', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    bindings,
  );
}

// The routes beside the v3 mount points (/v1/batches, /api/batches, /v1/pdf-tools) are unchanged.
// Those mount points were 503 stubs until their routes landed (the stub file is gone):
// bulk documents are tested in tests/batches-route.test.ts and the PDF toolkit, including its
// 503 not_configured for every method and path while PDF_TOOLKIT_ENABLED is off, in
// tests/pdftools-route.test.ts.
import { describe, expect, it } from 'vitest';
import { apiKeyFor, bearer, call, createUser } from './app-helpers';

describe('the routes around the v3 mount points', () => {
  it('leaves the API-key and dashboard routes around them as they were', async () => {
    const user = await createUser('starter');
    const key = await apiKeyFor(user.id);
    expect((await call('/v1/usage', { headers: bearer(key.secret) })).status).toBe(200);
    expect((await call('/v1/usage')).status).toBe(401);
    expect((await call('/v1/batch')).status).toBe(404);
    expect((await call('/api/me')).status).toBe(401);
  });

  // The chart routes (src/routes/charts.ts: /v1/chart/..., /v1/charts, /api/tools/chart) are mounted
  // beside these; their own behaviour, and 503 not_configured for every method and path while
  // CHARTS_ENABLED is off, is tested in tests/charts-url.test.ts and tests/charts-api.test.ts.
  it('leaves the routes around the chart mount points as they were', async () => {
    const user = await createUser('starter');
    const key = await apiKeyFor(user.id);
    // A neighbour of /v1/chart and /v1/charts is still an unknown API path, with or without a key.
    expect((await call('/v1/chartx', { headers: bearer(key.secret) })).status).toBe(404);
    expect((await call('/v1/charts-old', { method: 'POST', headers: bearer(key.secret) })).status).toBe(404);
    // POST /v1/charts wants an API key like POST /v1/images; POST /v1/images is unchanged.
    expect((await call('/v1/charts', { method: 'POST' })).status).toBe(401);
    expect((await call('/v1/images', { method: 'POST' })).status).toBe(401);
    expect((await call('/v1/usage', { headers: bearer(key.secret) })).status).toBe(200);
    // The other free tools under /api/tools answer as before.
    expect((await call('/api/tools/og-check')).status).toBe(400);
    expect((await call('/api/tools/charts')).status).not.toBe(503);
  });
});

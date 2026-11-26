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
});

// Simultaneous first requests for one chart are charged one image: the ledger row of the stored
// copy is claimed once (src/lib/quota.ts CLAIM_LEDGER_SQL), the other requests are duplicates.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiKeyFor, createSite, createUser, renderCount, usageOf } from './app-helpers';
import { chartNamed, chartPath, postChart, show } from './charts-helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every request misses the edge cache, so it is answered from R2 or drawn. */
const withoutEdgeCache = () => vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);

describe('simultaneous first requests for one chart', () => {
  it('three at once by its signed URL: one is charged, all are answered', async () => {
    withoutEdgeCache();
    const user = await createUser('free');
    const site = await createSite(user.id);
    const path = await chartPath(site, chartNamed('Three at once'));
    const answers = await Promise.all([show(path), show(path), show(path)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(answers.map((answer) => answer.credits).sort()).toEqual(['0', '0', '1']);
    expect(new Set(answers.map((answer) => answer.key)).size).toBe(1);
    expect((await usageOf(user.id)).used).toBe(1);
    expect(await renderCount(user.id)).toBe(1);
  });

  it('by its signed URL and by the API at the same moment: one image', async () => {
    withoutEdgeCache();
    const user = await createUser('free');
    const site = await createSite(user.id);
    const key = await apiKeyFor(user.id);
    const chart = chartNamed('URL and API at once');
    const [viaUrl, viaApi] = await Promise.all([show(await chartPath(site, chart)), postChart(key.secret, chart)]);
    expect([viaUrl.status, viaApi.status]).toEqual([200, 200]);
    const answer = (await viaApi.json()) as { id: string; credits_used: number };
    expect(answer.id).toBe(viaUrl.key);
    expect(Number(viaUrl.credits) + answer.credits_used).toBe(1);
    expect((await usageOf(user.id)).used).toBe(1);
  });
});

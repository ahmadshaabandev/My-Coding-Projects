/**
 * TEMPORARY dev entry. It serves one demo card through the full template path
 * (renderCard with HTML + CSS input) so `npm run smoke` can prove the renderer
 * in real workerd:
 *
 *   GET /spike.png|jpg|webp ?title= &subtitle= &size=og|square|portrait &wm=none|free|preview
 */
import { Hono } from 'hono';
import { EXTENSION_TO_FORMAT, SIZES } from './config';
import { ApiError, errorResponse } from './lib/errors';
import { renderCard } from './render';
import { initRuns } from './render/engine';
import { SAMPLE_CSS, SAMPLE_HTML, sampleData, sampleDeps } from './render/sample-card';
import type { Env, WatermarkMode } from './types';

const app = new Hono<{ Bindings: Env }>();

const WATERMARKS: readonly WatermarkMode[] = ['none', 'free', 'preview'];

app.get('/', (c) => c.text('linktocard dev entry: see /spike.png, /spike.jpg, /spike.webp'));

app.get('/:file{spike\\.[a-z]+}', async (c) => {
  const format = EXTENSION_TO_FORMAT[c.req.param('file').slice('spike.'.length)];
  if (!format) throw new ApiError('unsupported_format', 'Use /spike.png, /spike.jpg or /spike.webp.');
  const size = Object.values(SIZES).find((candidate) => candidate.id === (c.req.query('size') ?? 'og'));
  if (!size) throw new ApiError('unsupported_size', 'size must be og, square or portrait.');
  const watermark = WATERMARKS.find((mode) => mode === (c.req.query('wm') ?? 'none'));
  if (!watermark) throw new ApiError('invalid_request', 'wm must be none, free or preview.');

  const output = await renderCard(
    {
      html: SAMPLE_HTML,
      css: SAMPLE_CSS,
      data: sampleData(c.req.query('title'), c.req.query('subtitle')),
      width: size.width,
      height: size.height,
      format,
      watermark,
    },
    sampleDeps,
  );
  return new Response(output.bytes, {
    headers: {
      'content-type': output.contentType,
      // NB: in production workerd the clock only advances on I/O, so these read 0 there.
      'server-timing': Object.entries(output.timings)
        .map(([name, ms]) => `${name.replace(/Ms$/, '')};dur=${ms.toFixed(1)}`)
        .join(', '),
      'x-render-warnings': encodeURIComponent(JSON.stringify(output.warnings)),
      'x-init-runs': JSON.stringify(initRuns()),
    },
  });
});

app.onError((error, c) => {
  if (error instanceof ApiError) return errorResponse(error, c.env.APP_URL ?? '');
  console.error(error);
  return errorResponse(new ApiError('internal_error', 'Unexpected error.'), c.env.APP_URL ?? '');
});

export default app;

/**
 * Dev-only Worker behind scripts/render-samples.mjs. It renders the starter
 * templates in real workerd with the production renderer, but without the
 * product's router, database or bucket, so gallery samples can be regenerated
 * while the API is being changed. scripts/samples.wrangler.toml never deploys it.
 *
 *   GET /templates                       the starter ids, names and sample data
 *   GET /render/<id>.png?size=&wm=&...   every other query parameter is template data
 */
import { SIZES, type SizeId } from '../src/config';
import { ApiError, errorResponse } from '../src/lib/errors';
import { renderCard } from '../src/render';
import { STARTER_TEMPLATES, getStarterTemplate } from '../src/render/templates';
import type { RenderDeps, WatermarkMode } from '../src/types';

/** The one image the samples worker can "fetch": it has no network access on purpose. */
const DEMO_IMAGE_URL = 'https://samples.linktocard.test/avatar.svg';

const DEMO_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="#d9c8b4"/>' +
  '<circle cx="48" cy="38" r="17" fill="#6b4f3a"/><path d="M14 96c2-22 16-33 34-33s32 11 34 33z" fill="#6b4f3a"/></svg>';

const WATERMARKS: readonly WatermarkMode[] = ['none', 'free', 'preview'];
const RESERVED_PARAMS = new Set(['size', 'wm']);

const deps: RenderDeps = {
  fetchImage: async (url) => {
    if (url !== DEMO_IMAGE_URL) throw new ApiError('image_fetch_failed', `The samples worker only serves ${DEMO_IMAGE_URL}.`);
    return { dataUri: `data:image/svg+xml;base64,${btoa(DEMO_IMAGE_SVG)}` };
  },
};

function templateList(): Response {
  return Response.json(STARTER_TEMPLATES.map(({ id, name, sample }) => ({ id, name, sample })));
}

async function renderSample(id: string, query: URLSearchParams): Promise<Response> {
  const template = getStarterTemplate(id);
  if (!template) throw new ApiError('not_found', `Unknown starter template "${id}".`);
  const size = SIZES[(query.get('size') ?? 'og') as SizeId];
  if (!size) throw new ApiError('unsupported_size', `Unknown size "${query.get('size')}".`);
  const watermark = (query.get('wm') ?? 'none') as WatermarkMode;
  if (!WATERMARKS.includes(watermark)) throw new ApiError('invalid_request', `Unknown watermark mode "${watermark}".`);

  const data: Record<string, string> = {};
  for (const [key, value] of query) if (!RESERVED_PARAMS.has(key)) data[key] = value;

  const output = await renderCard(
    { html: template.html, css: template.css, data, width: size.width, height: size.height, format: 'png', watermark },
    deps,
  );
  return new Response(output.bytes, {
    headers: {
      'Content-Type': output.contentType,
      'Cache-Control': 'no-store',
      'X-Render-Ms': output.timings.totalMs.toFixed(1),
      'X-Render-Warnings': encodeURIComponent(JSON.stringify(output.warnings)),
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/templates') return templateList();
      const match = /^\/render\/([a-z]+)\.png$/.exec(url.pathname);
      if (!match?.[1]) throw new ApiError('not_found', 'Use /templates or /render/<id>.png.');
      return await renderSample(match[1], url.searchParams);
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(error, url.origin);
      throw error;
    }
  },
};

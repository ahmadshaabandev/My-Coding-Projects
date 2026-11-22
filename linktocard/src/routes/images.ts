/**
 * GET /i/{userId}/{cacheKey}.{ext} - a stored image, as returned in `url` by
 * POST /v1/images. The 256-bit cache key in the path is the capability; there
 * is nothing to sign. Never renders, never counts.
 */
import { Hono } from 'hono';
import { ApiError } from '../lib/errors';
import { etagFor, matchesEtag, notModified } from '../lib/http';
import { parseImageFile, readStoredImage, storedImageHeaders } from '../lib/images';
import type { AppEnv } from '../types';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const imagesRouter = new Hono<AppEnv>();

imagesRouter.get('/:userId/:file', async (c) => {
  const request = c.req.raw;
  const userId = c.req.param('userId');
  const file = parseImageFile(c.req.param('file'));
  const now = Date.now();
  const head = request.method === 'HEAD';
  const conditional = file !== null && matchesEtag(request, etagFor(file.cacheKey));
  const stored =
    file && USER_ID_RE.test(userId)
      ? await readStoredImage(c.env.BUCKET, userId, file.cacheKey, file.format, now, !head && !conditional)
      : null;
  if (!stored) throw new ApiError('not_found', 'Image not found. It may have expired: render it again to get a fresh URL.');

  const headers = storedImageHeaders(stored.image, 'hit', now);
  if (conditional) return notModified(headers);
  if (head) headers.set('content-length', String(stored.image.bytes));
  return new Response(stored.body, { headers });
});

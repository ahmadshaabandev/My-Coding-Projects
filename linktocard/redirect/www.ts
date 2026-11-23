/**
 * www.linktocard.com -> https://linktocard.com, same path and query, 301.
 *
 * A separate Worker because the main one cannot do it: its static pages are
 * served by Workers Static Assets before any Worker code runs, so a request
 * for www.linktocard.com/pricing would never reach a redirect in src/.
 */
export const CANONICAL_HOST = 'linktocard.com';

export function canonicalUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.protocol = 'https:';
  url.hostname = CANONICAL_HOST;
  url.port = '';
  return url.toString();
}

export default {
  fetch(request: Request): Response {
    return new Response(null, { status: 301, headers: { location: canonicalUrl(request.url), 'cache-control': 'public, max-age=86400' } });
  },
};

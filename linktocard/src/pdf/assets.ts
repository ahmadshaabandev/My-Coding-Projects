/**
 * Remote images of a PDF document, fetched before the browser runs and written into the
 * document as data: URIs, so the browser itself never needs the network (and is not allowed
 * it: see allowRequestPattern in src/pdf/render.ts).
 *
 * Every download goes through the SSRF-guarded fetcher of the image renderer
 * (src/render/proxy.ts: http(s) only, default ports, public addresses checked over DNS on
 * every redirect hop, type, size and pixel limits, a timeout). On top of that:
 *   - Link To Card's own hosts are refused, so a document cannot reach our internal paths;
 *   - all images of one document together may be at most PDF.maxAssetBytes;
 *   - at most PDF.maxRemoteAssets distinct URLs (src/pdf/template.ts counts them).
 */
import { PDF } from '../config';
import { ApiError } from '../lib/errors';
import { fetchRemoteImage, type ImageFetchOptions } from '../render/proxy';

/** Our production and staging hosts (and their subdomains), refused besides APP_URL's host. */
const OWN_HOSTS: readonly string[] = ['linktocard.com', 'linktocard-staging.names-on-base.workers.dev'];
/** Downloads in flight at once for one document. */
const CONCURRENCY = 4;

export interface AssetOptions {
  /** This deployment's origin; its host is refused like OWN_HOSTS. */
  appUrl: string;
  /** Test hooks, passed to the guarded fetcher. */
  fetchOptions?: Pick<ImageFetchOptions, 'fetchImpl' | 'resolveHost' | 'timeoutMs'>;
}

function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/\.$/, '');
}

/** True for one of Link To Card's own hosts or a subdomain of one. */
export function isOwnHost(hostname: string, appUrl: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const own = [...OWN_HOSTS, hostOf(appUrl)];
  return own.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
}

function ownHostError(url: string): ApiError {
  return new ApiError(
    'image_fetch_failed',
    `Images cannot be loaded from Link To Card's own addresses (${hostOf(url)}). Host the image elsewhere or embed it as a data: URI.`,
    { details: { reason: 'blocked_host', url } },
  );
}

function totalTooLarge(): ApiError {
  return new ApiError(
    'template_error',
    `The images in this document add up to more than ${PDF.maxAssetBytes / (1024 * 1024)} MB. Use smaller or fewer images.`,
    { details: { limit: PDF.maxAssetBytes } },
  );
}

/** The guarded fetcher's fetch, refusing our own hosts on every hop (a redirect included). */
function refusingOwnHosts(appUrl: string, base: typeof fetch): typeof fetch {
  return (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isOwnHost(hostOf(target), appUrl)) return Promise.reject(ownHostError(target));
    return base(input, init);
  };
}

/**
 * Downloads every URL and returns url -> data: URI. Throws the first failure:
 * ApiError('image_fetch_failed') for an image that cannot be used (with details.reason and
 * url), ApiError('template_error') when the images together are over the cap.
 */
export async function inlineRemoteAssets(urls: readonly string[], options: AssetOptions): Promise<Map<string, string>> {
  const inlined = new Map<string, string>();
  if (urls.length === 0) return inlined;
  for (const url of urls) if (isOwnHost(hostOf(url), options.appUrl)) throw ownHostError(url);

  // Read the global at call time and call it unbound (workerd's fetch throws "Illegal invocation"
  // as a method of another object); tests replace it with vi.spyOn.
  const base = options.fetchOptions?.fetchImpl ?? ((input, init) => fetch(input, init));
  const fetchImpl = refusingOwnHosts(options.appUrl, base);
  let next = 0;
  let used = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed && next < urls.length) {
      const url = urls[next++]!;
      const left = PDF.maxAssetBytes - used;
      if (left <= 0) throw totalTooLarge();
      try {
        const image = await fetchRemoteImage(url, { ...options.fetchOptions, fetchImpl, maxBytes: left });
        used += image.bytes;
        if (used > PDF.maxAssetBytes) throw totalTooLarge();
        inlined.set(url, image.dataUri);
      } catch (error) {
        failed = true;
        // Each download may use what is left of the budget, so "too large" means the total is over it.
        if (error instanceof ApiError && error.details?.reason === 'too_large') throw totalTooLarge();
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return inlined;
}

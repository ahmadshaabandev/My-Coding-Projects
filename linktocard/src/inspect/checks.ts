/**
 * The checklist: one entry per CHECK_IDS item, always all of them and in that order, each
 * pass | warn | fail with a plain fix. Thresholds come from INSPECT (src/config.ts). Where
 * a check talks about platforms it says what the Open Graph / X Cards markup asks for,
 * not how a given platform behaves, which we cannot observe from here.
 */
import { INSPECT } from '../config';
import type { ImageOutcome } from './image';
import { urlForm } from './parse';
import type { CheckId, CheckItem, CheckStatus, OgFields, RobotsResult, TwitterFields } from './types';

export interface ChecklistInput {
  og: OgFields;
  twitter: TwitterFields;
  /** The image that was probed: og:image, else twitter:image. */
  imageSource: 'og' | 'twitter' | null;
  /** That tag's raw value. */
  imageRaw: string | null;
  /** The resolved absolute URL (null when the value is not a URL). */
  imageUrl: URL | null;
  image: ImageOutcome | null;
  robots: RobotsResult;
  responseMs: number;
}

const MB = 1024 * 1024;
const TWITTER_CARDS = ['summary', 'summary_large_image', 'app', 'player'];

function item(id: CheckId, status: CheckStatus, title: string, detail: string, fix: string | null = null): CheckItem {
  return { id, status, title, detail, fix: status === 'pass' ? null : fix };
}

function chars(text: string): number {
  return Array.from(text).length;
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / MB) * 10) / 10} MB`;
}

const NO_IMAGE = 'Not checked: the page has no og:image or twitter:image.';
const ADD_IMAGE = 'Add <meta property="og:image" content="https://..."> first.';

function imageChecks(input: ChecklistInput): CheckItem[] {
  const { imageRaw, imageUrl, image } = input;
  const out: CheckItem[] = [];

  if (input.og.image) {
    out.push(item('og_image', 'pass', 'og:image is set', `og:image is "${input.og.image}".`));
  } else {
    const fallback = input.imageSource === 'twitter' ? ' The twitter:image was checked instead, but services that read only Open Graph tags will show no image.' : '';
    out.push(
      item(
        'og_image',
        'fail',
        'og:image is missing',
        `The page has no og:image tag.${fallback}`,
        'Add <meta property="og:image" content="https://example.com/card.png"> to the page <head>, pointing at a 1200x630 PNG or JPEG.',
      ),
    );
  }

  if (!imageRaw) {
    for (const [id, title] of [
      ['og_image_absolute', 'Image URL is absolute'],
      ['og_image_https', 'Image URL uses https'],
      ['og_image_reachable', 'Image loads'],
      ['og_image_size', 'Image file size'],
      ['og_image_dimensions', 'Image dimensions'],
      ['og_image_ratio', 'Image aspect ratio'],
    ] as const) {
      out.push(item(id, 'warn', title, NO_IMAGE, ADD_IMAGE));
    }
    return out;
  }

  const form = urlForm(imageRaw);
  const resolved = imageUrl ? ` We resolved it to ${imageUrl.href}, but a crawler is not guaranteed to do the same.` : '';
  if (form === 'absolute') {
    out.push(item('og_image_absolute', 'pass', 'Image URL is absolute', 'The image URL is a full address.'));
  } else {
    out.push(
      item(
        'og_image_absolute',
        form === 'relative' ? 'fail' : 'warn',
        form === 'relative' ? 'Image URL is relative' : 'Image URL has no scheme',
        `The image URL "${imageRaw}" is ${form === 'relative' ? 'relative to the page' : 'scheme-relative (starts with //)'}.${resolved}`,
        `Use the full address, starting with https://${imageUrl ? ` (${imageUrl.href})` : ''}.`,
      ),
    );
  }

  if (imageUrl?.protocol === 'https:') {
    out.push(item('og_image_https', 'pass', 'Image URL uses https', 'The image is served over https.'));
  } else {
    out.push(
      item(
        'og_image_https',
        'fail',
        imageUrl?.protocol === 'http:' ? 'Image URL uses http' : 'Image URL is not a web address',
        imageUrl?.protocol === 'http:'
          ? 'The image is served over plain http, not https. Some services may not load http images.'
          : `The image URL "${imageRaw}" is not an http(s) address.`,
        'Serve the image over https and use the https:// address in the tag.',
      ),
    );
  }

  const probe = image?.probe ?? null;
  const reachable = image !== null && image.error === null && probe !== null && probe.status !== null && probe.status < 300;
  out.push(
    reachable
      ? item('og_image_reachable', 'pass', 'Image loads', `HTTP ${probe.status}, ${probe.content_type}.`)
      : item(
          'og_image_reachable',
          'fail',
          'Image does not load',
          image?.error ?? 'The image could not be fetched.',
          'Open the image URL in a private browser window: it must load without a login and be served with an image content type (image/png, image/jpeg, ...).',
        ),
  );

  if (!reachable) {
    const why = 'Not checked: the image did not load.';
    out.push(item('og_image_size', 'warn', 'Image file size', why, 'Fix the image URL first.'));
  } else if (image.overReadCap) {
    out.push(
      item(
        'og_image_size',
        'warn',
        'Image is very large',
        `The image is larger than ${megabytes(INSPECT.imageMaxBytes)} (we stopped reading there).`,
        `Compress the image to under ${megabytes(INSPECT.imageWarnBytes)}; a 1200x630 JPEG or PNG is usually well under 1 MB.`,
      ),
    );
  } else if (probe.bytes === null) {
    out.push(item('og_image_size', 'warn', 'Image file size unknown', 'The server did not say how large the image is.', 'Serve the image with a Content-Length header.'));
  } else if (probe.bytes > INSPECT.imageWarnBytes) {
    out.push(
      item(
        'og_image_size',
        'warn',
        'Image is over 5 MB',
        `The image is ${megabytes(probe.bytes)}. Large images load slowly and some services may refuse them.`,
        `Compress the image to under ${megabytes(INSPECT.imageWarnBytes)}; a 1200x630 JPEG or PNG is usually well under 1 MB.`,
      ),
    );
  } else {
    out.push(item('og_image_size', 'pass', 'Image file size is fine', `The image is ${megabytes(probe.bytes)}.`));
  }

  const min = INSPECT.minImageSidePx;
  if (!reachable || probe.width === null || probe.height === null) {
    const why = !reachable
      ? 'Not checked: the image did not load.'
      : 'We could not read the pixel size (we read PNG, JPEG, GIF and WebP headers).';
    out.push(item('og_image_dimensions', 'warn', 'Image dimensions', why, 'Use a 1200x630 PNG or JPEG.'));
    out.push(item('og_image_ratio', 'warn', 'Image aspect ratio', why, 'Use a 1200x630 PNG or JPEG.'));
    return out;
  }
  const { width, height } = probe;
  out.push(
    width < min || height < min
      ? item(
          'og_image_dimensions',
          'fail',
          `Image is smaller than ${min} px`,
          `The image is ${width}x${height} px; at least ${min}x${min} px is needed, and services may show a small image as a thumbnail or not at all.`,
          'Use a 1200x630 image.',
        )
      : item('og_image_dimensions', 'pass', 'Image dimensions are fine', `The image is ${width}x${height} px.`),
  );
  const ratio = width / height;
  const target = INSPECT.targetAspectRatio;
  const off = Math.abs(ratio / target - 1);
  out.push(
    off <= INSPECT.aspectRatioTolerance
      ? item('og_image_ratio', 'pass', 'Aspect ratio is 1.91:1', `${width}x${height} is ${ratio.toFixed(2)}:1.`)
      : item(
          'og_image_ratio',
          'warn',
          'Aspect ratio is not 1.91:1',
          `${width}x${height} is ${ratio.toFixed(2)}:1. Large link previews are commonly about 1.91:1 (1200x630, approximate), so other shapes may be cropped or shown small.`,
          'Use a 1200x630 image.',
        ),
  );
  return out;
}

function textCheck(id: 'og_title' | 'og_description', tag: string, value: string | null, max: number, missing: CheckStatus): CheckItem {
  const name = id === 'og_title' ? 'title' : 'description';
  if (value === null) {
    return item(id, missing, `${tag} is missing`, `The page has no ${tag} tag.`, `Add <meta property="${tag}" content="..."> with the ${name} the preview should show.`);
  }
  const length = chars(value);
  if (length > max) {
    return item(
      id,
      'warn',
      `${tag} is longer than ${max} characters`,
      `${tag} is ${length} characters; previews usually cut long text short.`,
      `Shorten ${tag} to ${max} characters or fewer.`,
    );
  }
  return item(id, 'pass', `${tag} is set`, `${tag} is ${length} characters.`);
}

export function buildChecks(input: ChecklistInput): CheckItem[] {
  const checks = imageChecks(input);

  const card = input.twitter.card;
  if (card === null) {
    checks.push(
      item(
        'twitter_card',
        'warn',
        'twitter:card is missing',
        'The page has no twitter:card tag, which tells X which card layout to use.',
        'Add <meta name="twitter:card" content="summary_large_image"> for a large image card.',
      ),
    );
  } else if (!TWITTER_CARDS.includes(card)) {
    checks.push(
      item('twitter_card', 'warn', 'twitter:card has an unknown value', `twitter:card is "${card}"; the documented values are ${TWITTER_CARDS.join(', ')}.`, 'Use content="summary_large_image".'),
    );
  } else {
    checks.push(item('twitter_card', 'pass', 'twitter:card is set', `twitter:card is "${card}".`));
  }

  checks.push(textCheck('og_title', 'og:title', input.og.title, INSPECT.maxTitleChars, 'fail'));
  checks.push(textCheck('og_description', 'og:description', input.og.description, INSPECT.maxDescriptionChars, 'warn'));

  const { robots } = input;
  if (robots.checked && robots.allowed === false) {
    checks.push(
      item(
        'robots',
        'warn',
        'robots.txt blocks this page',
        `${robots.note ?? 'robots.txt disallows this page.'} Preview crawlers that obey robots.txt may not read the page.`,
        'Allow the page in robots.txt (or add an Allow rule for the preview crawlers you care about).',
      ),
    );
  } else {
    checks.push(item('robots', 'pass', 'robots.txt allows this page', robots.note ?? 'robots.txt does not block this page.'));
  }

  const seconds = (input.responseMs / 1000).toFixed(1);
  checks.push(
    input.responseMs > INSPECT.slowResponseMs
      ? item(
          'response_time',
          'warn',
          'Page is slow to respond',
          `The page took ${seconds} s. Preview crawlers give up after a while, so a slow page can end up with no preview.`,
          'Make the page (or at least its <head>) respond faster: cache it or serve it from a CDN.',
        )
      : item('response_time', 'pass', 'Page responds quickly', `The page took ${seconds} s.`),
  );
  return checks;
}

/**
 * The OG checker's public JSON (GET /api/tools/og-check and GET /v1/inspect). Field
 * names are part of the API contract (openapi.yaml, /docs/api): snake_case, ISO times.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail';

export const CHECK_IDS = [
  'og_image',
  'og_image_absolute',
  'og_image_https',
  'og_image_reachable',
  'og_image_size',
  'og_image_dimensions',
  'og_image_ratio',
  'twitter_card',
  'og_title',
  'og_description',
  'robots',
  'response_time',
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export interface CheckItem {
  id: CheckId;
  status: CheckStatus;
  title: string;
  detail: string;
  fix: string | null;
}

export interface PageFields {
  title: string | null;
  description: string | null;
  canonical: string | null;
  /** Absolute URL: the first icon link resolved against the final URL, else /favicon.ico. */
  favicon: string | null;
  theme_color: string | null;
}

/** Values exactly as the page wrote them (trimmed); relative URLs are not rewritten here. */
export interface OgFields {
  title: string | null;
  description: string | null;
  image: string | null;
  image_alt: string | null;
  image_width: string | null;
  image_height: string | null;
  url: string | null;
  type: string | null;
  site_name: string | null;
}

export interface TwitterFields {
  card: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  site: string | null;
}

export interface ImageProbe {
  /** Absolute URL that was probed (og:image, else twitter:image, resolved against the final URL). */
  url: string;
  status: number | null;
  content_type: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  aspect_ratio: number | null;
  response_ms: number | null;
}

export interface RobotsResult {
  checked: boolean;
  allowed: boolean | null;
  note: string | null;
}

export interface PreviewFields {
  title: string | null;
  description: string | null;
  domain: string;
  site_name: string | null;
  image: string | null;
  favicon: string | null;
}

export interface CheckResult {
  id: string;
  url: string;
  final_url: string;
  status: number;
  fetched_at: string;
  response_ms: number;
  cached: boolean;
  expires_at: string;
  page: PageFields;
  og: OgFields;
  twitter: TwitterFields;
  image: ImageProbe | null;
  robots: RobotsResult;
  checks: CheckItem[];
  preview: PreviewFields;
}

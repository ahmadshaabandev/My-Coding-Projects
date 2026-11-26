/**
 * The OG checker's "Make this card": a watermarked preview of the card a page would get,
 * built from a check that is already stored (og_checks, kept INSPECT.cacheTtlMs).
 *
 * Nothing here fetches. The page is not read again, and the page's images are left out of
 * the preview on purpose: drawing them would mean downloading files a stranger's page
 * names, from a public endpoint with no account behind it. The paid card (POST
 * /v1/cards/from-url) loads them through the image proxy; the preview shows the text.
 */
import { liveCheck } from '../inspect/check';
import type { CheckResult } from '../inspect/types';
import type { TemplateData } from '../types';
import { cardDataFromLink, linkFieldsFromCheck, templateFieldNames, withoutPageImages, type LinkFieldLimits } from './from-url';

export const PREVIEW_THEMES: readonly string[] = ['light', 'dark'];

/** The stored result of an unexpired check, or null (unknown id, expired, or a row that does not parse). */
export async function checkForPreview(db: D1Database, checkId: string, now: number): Promise<CheckResult | null> {
  const row = await liveCheck(db, checkId, now);
  if (!row) return null;
  try {
    return JSON.parse(row.result) as CheckResult;
  } catch {
    return null;
  }
}

/**
 * Preview data for one template: the page's text under the template's field names, no
 * image URLs (so rendering it fetches nothing), and `theme` when the visitor picked one.
 */
export function previewDataFromCheck(
  result: CheckResult,
  template: { html: string; css: string },
  limits: LinkFieldLimits,
  theme?: string,
): TemplateData {
  const data = withoutPageImages(cardDataFromLink(linkFieldsFromCheck(result, limits), templateFieldNames(template)));
  if (theme !== undefined && PREVIEW_THEMES.includes(theme)) data.theme = theme;
  return data;
}

const PREVIEW_FILE = /^([a-z][a-z0-9-]{0,63})\.png$/;

/** "{template}.png" from the preview path, or null. Only PNG: the playground makes nothing else. */
export function parsePreviewFile(file: string): string | null {
  return PREVIEW_FILE.exec(file)?.[1] ?? null;
}

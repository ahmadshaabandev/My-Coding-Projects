/**
 * The [[tokens]] the one-app preview pages (site/pages/tools/x-card-validator.html, ...-preview.html,
 * built with the "previews" site feature) need beyond those of scripts/v3-site-tokens.ts, read from
 * INSPECT in src/config.ts, so a page never types a checker limit itself
 * (tests/node/preview-pages-draft.test.ts fails when one does).
 *
 * The pages also use [[inspect.cacheMinutes]] and [[inspect.maxRedirects]] from v3-site-tokens.ts.
 * scripts/build-site.ts merges both: `Object.assign(tokens, v3SiteTokens(), previewsSiteTokens())` in
 * buildTokens(). This file exists only because the preview pages were prepared in parallel with the
 * other build v3 steps; folding it into v3-site-tokens.ts later changes nothing.
 *
 * Formatting follows build-site.ts: sizes through the same MB rounding as inUnits() there ("5", "1.5").
 */
import { INSPECT } from '../src/config';

const MB = 1024 * 1024;

export function previewsSiteTokens(): Record<string, string> {
  return {
    // Unformatted, for the URL field's maxlength="..." (inspect.maxUrlChars prints "2,048").
    'inspect.raw.maxUrlChars': String(INSPECT.maxUrlChars),
    // The image size above which the checklist warns (og_image_size), for "keep it well under ... MB".
    'inspect.imageWarnMb': String(Math.round((INSPECT.imageWarnBytes / MB) * 100) / 100),
  };
}

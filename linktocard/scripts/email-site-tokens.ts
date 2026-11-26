/**
 * The [[tokens]] of the personalized email image pages (site/content/docs/email-images.md and
 * site/content/guides/personalized-email-images.md): every number those pages print about open
 * fields, read from EMAIL_FIELDS in src/config.ts, so a page never types a limit itself
 * (tests/node/email-content-draft.test.ts fails when one does).
 *
 * scripts/build-site.ts merges them into its own tokens, like scripts/v3-site-tokens.ts:
 * `Object.assign(tokens, emailSiteTokens())` in buildTokens(). They sit in their own file only
 * because the email pages were prepared in parallel with the other build v3 steps; folding them
 * into v3-site-tokens.ts later changes nothing.
 *
 * Formatting follows build-site.ts: counts through formatCount ("2,000").
 */
import { formatCount } from '../src/billing/plans';
import { DAY_MS, EMAIL_FIELDS, SIZES } from '../src/config';

/**
 * Tokens the pages use that wait for a config value, and the value each one needs. build-site.ts
 * already prints size.<id>.width and size.<id>.height for every preset in SIZES, so the email
 * size tokens appear by themselves once the preset exists; until then a build that publishes the
 * pages fails on an unknown token instead of printing a guessed size.
 */
export function pendingEmailConfigTokens(): Readonly<Record<string, string>> {
  if (Object.hasOwn(SIZES, 'email')) return {};
  const needs = 'SIZES.email in src/config.ts (and "email" in SizeId, src/types.ts): the email size preset of contract T5, 1200 x 400';
  return { 'size.email.width': needs, 'size.email.height': needs };
}

export function emailSiteTokens(): Record<string, string> {
  // Cache-Control carries seconds; the docs speak in days, so the setting must be whole days.
  const maxAgeDays = (EMAIL_FIELDS.maxAgeSeconds * 1000) / DAY_MS;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1) {
    throw new Error(`EMAIL_FIELDS.maxAgeSeconds must be whole days for the docs, got ${EMAIL_FIELDS.maxAgeSeconds} s`);
  }
  const daily = EMAIL_FIELDS.maxUniqueRendersPerDay;
  return {
    'email.maxOpenFields': String(EMAIL_FIELDS.maxOpenFields),
    'email.maxValueChars': String(EMAIL_FIELDS.maxValueChars),
    'email.dailyFree': formatCount(daily.free),
    'email.dailyStarter': formatCount(daily.starter),
    'email.dailyPro': formatCount(daily.pro),
    'email.maxAgeDays': String(maxAgeDays),
  };
}

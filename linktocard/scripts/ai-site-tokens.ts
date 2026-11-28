/**
 * The [[tokens]] and generated partials of the AI image pages (site feature "ai"): the three tool pages
 * under site/pages/tools/, their partials site/partials/ai-*.html, /docs/ai-images and the AI blocks of
 * the terms and the privacy policy. Every number those pages print about AI images is read from AI in
 * src/config.ts (and the plans of src/billing/plans.ts), so a page never types a limit itself
 * (tests/node/ai-site.test.ts fails when one does).
 *
 * scripts/build-site.ts merges them into its own tokens, like the other *-site-tokens.ts files.
 */
import { PLANS, PLAN_ORDER, formatCount } from '../src/billing/plans';
import { AI, AI_MOTIFS, AI_STYLES } from '../src/config';

const KB = 1024;
const HOUR_MS = 3_600_000;

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "Free", "Starter and Pro", "Free, Starter and Pro". */
const nameList = (names: string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** "soft-gradient" -> "Soft gradient". */
export const aiLabel = (id: string): string => {
  const words = id.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function wholeHours(ms: number, name: string): number {
  const hours = ms / HOUR_MS;
  if (!Number.isInteger(hours) || hours < 1) throw new Error(`AI.${name} must be whole hours for the site, got ${ms} ms`);
  return hours;
}

function wholeKb(bytes: number, name: string): number {
  if (bytes % KB !== 0) throw new Error(`AI.uploads.${name} must be whole KB for the site, got ${bytes}`);
  return bytes / KB;
}

/**
 * Which images pay for AI images, in words, from AI.freePlanAllowance and the plans: the monthly images
 * of the paid plans (and of Free only when freePlanAllowance is true), and top-up images on every plan
 * that can buy one.
 */
function paidByText(): string {
  const plans = PLAN_ORDER.map((id) => PLANS[id]);
  const free = plans.filter((plan) => plan.priceUsd === 0);
  const monthly = plans.filter((plan) => plan.monthlyImages > 0 && (plan.priceUsd > 0 || AI.freePlanAllowance));
  const topUps = plans.filter((plan) => plan.topUps);
  const topUpPlans =
    topUps.length === plans.length
      ? `every plan${free.length > 0 && topUps.some((plan) => free.includes(plan)) ? `, ${nameList(free.map((plan) => plan.name))} included` : ''}`
      : nameList(topUps.map((plan) => plan.name));
  const paidBy = `AI images are paid from the monthly images of ${nameList(monthly.map((plan) => plan.name))}${topUps.length > 0 ? `, and from top-up images on ${topUpPlans}` : ''}.`;
  const excluded = plans.filter((plan) => plan.monthlyImages > 0 && !monthly.includes(plan));
  return excluded.length === 0 ? paidBy : `${paidBy} The monthly images of the ${nameList(excluded.map((plan) => plan.name))} plan${excluded.length === 1 ? '' : 's'} do not pay for AI images.`;
}

const plural = (n: number, word: string): string => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;

export function aiSiteTokens(): Record<string, string> {
  const { cover, header } = AI.coverSizes;
  const percent = AI.qr.minWidthFraction * 100;
  if (!Number.isInteger(Math.round(percent * 1000) / 1000)) throw new Error(`AI.qr.minWidthFraction must be a whole percentage for the site, got ${AI.qr.minWidthFraction}`);
  if (AI.timeoutMs % 1000 !== 0) throw new Error(`AI.timeoutMs must be whole seconds for the site, got ${AI.timeoutMs}`);
  return {
    'ai.styles': AI_STYLES.map((style) => `\`${style}\``).join(', '),
    'ai.motifs': AI_MOTIFS.map((motif) => `\`${motif}\``).join(', '),
    'ai.styleCount': String(AI_STYLES.length),
    'ai.motifCount': String(AI_MOTIFS.length),
    'ai.maxPaletteColors': String(AI.maxPaletteColours),
    'ai.coverWidth': String(cover.width),
    'ai.coverHeight': String(cover.height),
    'ai.headerWidth': String(header.width),
    'ai.headerHeight': String(header.height),
    'ai.previewWidth': String(AI.previewCover.width),
    'ai.previewHeight': String(AI.previewCover.height),
    'ai.qrPreviewPx': String(AI.qrPreviewSide),
    'ai.qrFullPx': String(AI.qrPaidSide),
    'ai.creditsPerImage': String(AI.creditsPerImage),
    'ai.creditsPerImageText': plural(AI.creditsPerImage, 'credit'),
    'ai.creditsPerImageImages': plural(AI.creditsPerImage, 'image'),
    'ai.paidByText': paidByText(),
    'ai.freePreviewsPerDay': String(AI.freePreviewsPerIpPerDay),
    'ai.freePreviewsPerPageText': plural(AI.freePreviewsPerPagePerIpPerDay, 'preview'),
    'ai.previewHours': String(wholeHours(AI.freePreviewTtlMs, 'freePreviewTtlMs')),
    'ai.backgroundHours': String(wholeHours(AI.backgroundTtlMs, 'backgroundTtlMs')),
    'ai.uploadHours': String(wholeHours(AI.uploadTtlMs, 'uploadTtlMs')),
    'ai.maxImagesPerAccountPerDay': formatCount(AI.maxImagesPerAccountPerDay),
    'ai.timeoutSeconds': String(AI.timeoutMs / 1000),
    'ai.maxLogoKb': String(wholeKb(AI.uploads.maxLogoBytes, 'maxLogoBytes')),
    'ai.maxLogoPx': formatCount(AI.uploads.maxLogoSide),
    'ai.maxReferences': String(AI.uploads.maxReferences),
    'ai.maxReferenceKb': String(wholeKb(AI.uploads.maxReferenceBytes, 'maxReferenceBytes')),
    'ai.maxReferencePx': formatCount(AI.uploads.maxReferenceSide),
    'ai.maxUrlChars': String(AI.qr.maxUrlChars),
    'ai.qrErrorCorrection': AI.qr.ecc,
    'ai.qrQuietZoneModules': String(AI.qr.quietZoneModules),
    'ai.qrMinContrast': String(AI.qr.minContrast),
    'ai.qrMinWidthPercent': String(Math.round(percent)),
    'ai.abuseRetentionDays': String(AI.abuse.retentionDays),
    // Unformatted, for the maxlength="..." and data-max-* attributes the page script reads.
    'ai.raw.maxPaletteColors': String(AI.maxPaletteColours),
    'ai.raw.maxTitleChars': String(AI.maxChars.title),
    'ai.raw.maxDescriptionChars': String(AI.maxChars.description),
    'ai.raw.maxSiteNameChars': String(AI.maxChars.siteName),
    'ai.raw.maxUrlChars': String(AI.qr.maxUrlChars),
    'ai.raw.maxReportTargetChars': String(AI.abuse.maxTargetChars),
    'ai.raw.maxReportChars': String(AI.abuse.maxReasonChars),
  };
}

/** [[> ai-style-options]] and [[> ai-motif-options]]: the <option>s of the style and motif <select>s. */
export function aiPartials(): Record<string, string> {
  const option = (value: string, label: string, selected: boolean): string => `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  return {
    'ai-style-options': AI_STYLES.map((style, i) => option(style, aiLabel(style), i === 0)).join(''),
    'ai-motif-options': [option('auto', 'Chosen from the title', true), ...AI_MOTIFS.map((motif) => option(motif, aiLabel(motif), false))].join(''),
  };
}

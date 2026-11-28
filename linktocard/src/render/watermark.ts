/**
 * Watermark for the free plan and for previews.
 *
 * The badge is stamped into Satori's SVG output, as the last child of the root
 * <svg>. It is not part of the template's element tree, so template CSS cannot
 * select it, and SVG paints in document order with no z-index, so nothing the
 * template draws can cover it (research/spike-render.md, 7d). It is embedded as
 * a nested SVG image so its ids can never collide with the card's.
 */
import { base64Encode } from '../lib/crypto';
import type { WatermarkMode } from '../types';
import { renderSvg, type LayoutBox, type VNode } from './engine';
import { fontStack } from './fonts';

type Mode = Exclude<WatermarkMode, 'none'>;

const WATERMARK_TEXT: Record<Mode, string> = {
  free: 'linktocard.com',
  preview: 'Preview - linktocard.com',
};

/** Badge metrics at the 1200px-wide Open Graph size; other sizes scale with their width. */
const REFERENCE_WIDTH = 1200;
const BADGE_HEIGHT = 28;
const BADGE_MARGIN = 16;
const BADGE_FONT_SIZE = 14;
const BADGE_PADDING_X = 12;

function badge(text: string, height: number, scale: number): VNode {
  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        left: 0,
        top: 0,
        display: 'flex',
        alignItems: 'center',
        boxSizing: 'border-box',
        height,
        padding: `0 ${BADGE_PADDING_X * scale}px`,
        borderRadius: height / 2,
        // Dark pill with a faint light rim: readable on light and on dark cards alike.
        background: 'rgba(17, 24, 39, 0.78)',
        border: `${Math.max(1, Math.round(scale))}px solid rgba(255, 255, 255, 0.28)`,
        color: '#ffffff',
        fontFamily: fontStack('Inter'),
        fontSize: BADGE_FONT_SIZE * scale,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      },
      children: text,
    },
  };
}

/**
 * Height of the strip at the bottom of a canvas this wide that the badge and its margin take up.
 * A layout that leaves this strip empty (charts do) is never covered by the badge.
 */
export function watermarkStrip(width: number): number {
  const scale = width / REFERENCE_WIDTH;
  return Math.round(BADGE_HEIGHT * scale) + Math.round(BADGE_MARGIN * scale);
}

async function renderBadge(width: number, height: number, mode: Mode): Promise<string> {
  const scale = width / REFERENCE_WIDTH;
  const badgeHeight = Math.round(BADGE_HEIGHT * scale);
  const margin = Math.round(BADGE_MARGIN * scale);
  const node = badge(WATERMARK_TEXT[mode], badgeHeight, scale);

  // First pass measures the pill, second pass renders it on a canvas of exactly that size.
  let measured = 0;
  await renderSvg(node, {
    width,
    height: badgeHeight,
    onNodeDetected: (box: LayoutBox) => {
      if (box.type === 'div') measured = box.width;
    },
  });
  const badgeWidth = Math.ceil(measured);
  if (badgeWidth <= 0 || badgeWidth > width) throw new Error('Watermark badge could not be measured.');
  const svg = await renderSvg(node, { width: badgeWidth, height: badgeHeight });

  const x = width - margin - badgeWidth;
  const y = height - margin - badgeHeight;
  return `<image x="${x}" y="${y}" width="${badgeWidth}" height="${badgeHeight}" href="data:image/svg+xml;base64,${base64Encode(new TextEncoder().encode(svg))}"/>`;
}

const cache = new Map<string, Promise<string>>();

/** The <image> element for a card of this size, rendered once per size and mode per isolate. */
export function watermarkMarkup(width: number, height: number, mode: Mode): Promise<string> {
  const key = `${width}x${height}:${mode}`;
  let markup = cache.get(key);
  if (!markup) {
    markup = renderBadge(width, height, mode);
    cache.set(key, markup);
    // A failed render must not be remembered for the lifetime of the isolate.
    markup.catch(() => cache.delete(key));
  }
  return markup;
}

/** Inserts the watermark as the last child of the root <svg>, so it paints over everything else. */
export function stampWatermark(svg: string, markup: string): string {
  if (svg.endsWith('</svg>')) return `${svg.slice(0, -'</svg>'.length)}${markup}</svg>`;
  // A card that draws nothing (e.g. `html { display: none }`) is a self-closed root element.
  if (svg.startsWith('<svg') && svg.endsWith('/>') && svg.indexOf('>') === svg.length - 1) return `${svg.slice(0, -2)}>${markup}</svg>`;
  throw new Error('Unexpected SVG: no closing root tag.');
}

/**
 * A cover from an AI background (AI-SPEC.md section 4), on the cards' Satori/resvg pipeline:
 *
 *   background   the model's image, scaled to cover the canvas and centred (never stretched)
 *   scrim        a dark gradient (layout "left") or overlay ("center"), so white text always reads
 *   text         site name, title and description, drawn by Satori with the bundled fonts
 *   logo         the account's uploaded logo, drawn on top; it is never sent to the model
 *   mark         the Free corner mark (Free accounts) or the preview mark (free previews)
 *
 * Text is never drawn by the model. The canvas is 1200 x 630 (size "cover") or 1200 x 400 (size
 * "header"); a preview is the same picture rasterised at a smaller width. Every failure is an
 * ApiError (504 render_timeout, 500 render_failed); nothing is stored or charged for it.
 */
import { AI, LIMITS, type AiCoverSize, type AiLayout } from '../config';
import { base64Encode } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { assetLoader, startBudget } from '../render';
import { encodeSvg, renderSvg, type VNode } from '../render/engine';
import { fontStack } from '../render/fonts';
import { assertSvgWithinLimits } from '../render/svg-check';
import { stampWatermark, watermarkMarkup } from '../render/watermark';
import type { RenderDeps } from '../types';

export interface PixelImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

export interface CoverText {
  title: string;
  description: string | null;
  siteName: string | null;
}

export type CoverMark = 'none' | 'free' | 'preview';

export interface CoverInput {
  size: AiCoverSize;
  layout: AiLayout;
  text: CoverText;
  background: PixelImage;
  logo?: PixelImage | null;
  mark: CoverMark;
  /** Rasterised at this width (the free preview); the canvas width by default. */
  outputWidth?: number;
}

export interface ComposedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export function dataUri(image: Pick<PixelImage, 'bytes' | 'mime'>): string {
  return `data:${image.mime};base64,${base64Encode(image.bytes)}`;
}

/** The background as an absolutely placed <img> that covers a width x height canvas, centred. */
export function coverImageNode(image: PixelImage, width: number, height: number): VNode {
  const scale = Math.max(width / image.width, height / image.height);
  const w = Math.ceil(image.width * scale);
  const h = Math.ceil(image.height * scale);
  return {
    type: 'img',
    props: {
      src: dataUri(image),
      width: w,
      height: h,
      style: { position: 'absolute', left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2), width: w, height: h },
    },
  };
}

function titleSize(title: string, header: boolean): number {
  const length = [...title].length;
  if (header) return length <= 40 ? 52 : length <= 70 ? 44 : 38;
  return length <= 40 ? 66 : length <= 70 ? 56 : 46;
}

function textBlock(input: CoverInput, width: number, height: number): VNode {
  const header = input.size === 'header';
  const centred = input.layout === 'center';
  const { title, description, siteName } = input.text;
  const children: VNode[] = [];
  if (input.logo) {
    const logoHeight = header ? 48 : 64;
    const logoWidth = Math.min(header ? 200 : 260, Math.round((input.logo.width / input.logo.height) * logoHeight));
    const fitted = Math.min(logoHeight, Math.round((logoWidth / input.logo.width) * input.logo.height));
    children.push({
      type: 'img',
      props: { src: dataUri(input.logo), width: logoWidth, height: fitted, style: { width: logoWidth, height: fitted, marginBottom: header ? 14 : 22, objectFit: 'contain' } },
    });
  }
  if (siteName) {
    children.push({
      type: 'div',
      props: { style: { display: 'block', fontSize: header ? 22 : 28, fontWeight: 600, color: 'rgba(255,255,255,0.86)', marginBottom: header ? 10 : 16, lineClamp: 1 }, children: siteName },
    });
  }
  children.push({
    type: 'div',
    props: { style: { display: 'block', fontSize: titleSize(title, header), fontWeight: 700, lineHeight: 1.12, color: '#ffffff', lineClamp: header ? 2 : 3 }, children: title },
  });
  if (description) {
    children.push({
      type: 'div',
      props: { style: { display: 'block', fontSize: header ? 22 : 28, lineHeight: 1.35, color: 'rgba(255,255,255,0.88)', marginTop: header ? 12 : 20, lineClamp: header ? 1 : 2 }, children: description },
    });
  }
  const padding = header ? 56 : 72;
  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        top: 0,
        left: centred ? Math.round(width * 0.1) : padding,
        width: centred ? Math.round(width * 0.8) : Math.round(width * 0.6),
        height,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: centred ? 'center' : 'flex-start',
        textAlign: centred ? 'center' : 'left',
        fontFamily: fontStack('Inter'),
      },
      children,
    },
  };
}

function scrim(layout: AiLayout, width: number, height: number): VNode {
  return {
    type: 'div',
    props: {
      style: {
        position: 'absolute',
        left: 0,
        top: 0,
        width,
        height,
        ...(layout === 'center'
          ? { backgroundColor: 'rgba(8,10,18,0.56)' }
          : { backgroundImage: 'linear-gradient(90deg, rgba(8,10,18,0.84) 0%, rgba(8,10,18,0.64) 52%, rgba(8,10,18,0.12) 100%)' }),
      },
    },
  };
}

export async function composeCover(input: CoverInput, deps: Pick<RenderDeps, 'loadEmoji'> = {}): Promise<ComposedImage> {
  const { width, height } = AI.coverSizes[input.size];
  const outputWidth = input.outputWidth ?? width;
  const budget = startBudget(LIMITS.renderTimeoutMs);
  try {
    const root: VNode = {
      type: 'div',
      props: {
        style: { display: 'flex', position: 'relative', width, height, backgroundColor: '#111827', overflow: 'hidden' },
        children: [coverImageNode(input.background, width, height), scrim(input.layout, width, height), textBlock(input, width, height)],
      },
    };
    let svg = await budget.race(renderSvg(root, { width, height, loadAdditionalAsset: assetLoader(deps, () => undefined) }));
    if (svg.length > LIMITS.maxSvgBytes + 4 * 1024 * 1024) throw new ApiError('render_failed', 'The cover is too large to draw.');
    assertSvgWithinLimits(svg, { ...LIMITS, maxSvgBytes: LIMITS.maxSvgBytes + 4 * 1024 * 1024 });
    if (input.mark !== 'none') svg = stampWatermark(svg, await budget.race(watermarkMarkup(width, height, input.mark)));
    budget.check();
    const image = await encodeSvg(svg, outputWidth, 'png');
    budget.check();
    return { bytes: image.bytes, width: outputWidth, height: Math.round((height * outputWidth) / width) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('[ai] cover composition failed:', error);
    throw new ApiError('render_failed', 'The cover could not be drawn. Nothing was charged.');
  } finally {
    budget.stop();
  }
}

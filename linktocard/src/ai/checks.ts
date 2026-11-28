/**
 * Checks on images (AI-SPEC.md section 3) and the one way a background is generated.
 *
 * generateCheckedBackground: budget and per-account cap BEFORE the model call, the call under
 * AI.timeoutMs, the estimated neurons recorded after it, then the output check (Mistral Small 3.1
 * on Workers AI, or the mock checker). A background with readable text, a document or form, a face,
 * a person or body, a brand logo or nudity is refused; one retry with a new seed, then 422
 * unclean_output. Workers AI's own refusal (3030) is 422 content_flagged. None of these is ever
 * charged: credits are taken only for a finished image (src/ai/service.ts).
 *
 * Uploads (logos and reference images): PNG or JPEG by their bytes, size and pixel limits read from
 * the file header, then the same checker with the purpose's own refusal list.
 */
import { AI, AI_MODELS } from '../config';
import { ApiError } from '../lib/errors';
import type { Background } from '../lib/http';
import type { Env } from '../types';
import { assertAccountImages, assertBudget, countAccountImages, recordSpend, type SpendScope } from './budget';
import { buildPrompt, type PromptSpec } from './prompt';
import { checkerFor, estimateNeurons, providerFor, withModelTimeout, type AiImageMime, type CheckVerdict, type GeneratedImage } from './provider';

export interface BackgroundJob {
  scope: SpendScope;
  /** The paying account (its daily image cap applies); null for a free preview. */
  userId: string | null;
  spec: PromptSpec;
  width: number;
  height: number;
  refs?: { bytes: Uint8Array; width: number; height: number }[];
}

export interface CheckedBackground {
  image: GeneratedImage;
  /** Model generations it took (1, or 2 after a refused first image). */
  attempts: number;
  /** Estimated neurons of every call made for it, checks included. */
  neurons: number;
}

export function uncleanError(): ApiError {
  return new ApiError('unclean_output', 'The generated image did not pass our image check twice. Nothing was charged; try another style or motif.');
}

function rejected(verdict: CheckVerdict, flags: readonly string[]): boolean {
  return !verdict.readable || flags.some((flag) => verdict.flags[flag] === true);
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff;
}

export async function generateCheckedBackground(env: Env, background: Background, job: BackgroundJob, now: number): Promise<CheckedBackground> {
  const provider = providerFor(env);
  const checker = AI.outputCheck.enabled ? checkerFor(env) : null;
  const model = AI_MODELS[AI.model];
  const refs = job.refs ?? [];
  const prompt = buildPrompt(job.spec);
  const callEstimate = estimateNeurons(model, job.width, job.height, refs) + (checker ? AI.outputCheck.estimatedNeurons : 0);
  let neurons = 0;
  for (let attempt = 1; attempt <= 1 + AI.outputCheck.retries; attempt++) {
    await assertBudget(env, job.scope, callEstimate, now);
    if (job.userId !== null) await assertAccountImages(env.DB, job.userId, 1, now);

    let image: GeneratedImage;
    try {
      image = await withModelTimeout((signal) =>
        provider.generate({ prompt, width: job.width, height: job.height, seed: randomSeed(), refs: refs.map((ref) => ref.bytes), refSizes: refs.map(({ width, height }) => ({ width, height })) }, signal),
      );
    } catch (error) {
      // A call that ran out of time may still be billed: count its estimate. A refused (3030) call was billed 0.
      if (error instanceof ApiError && error.code === 'ai_timeout') await recordSpend(env, background, job.scope, callEstimate, now);
      throw error;
    }
    neurons += image.estimatedNeurons;
    await recordSpend(env, background, job.scope, image.estimatedNeurons, now);
    if (job.userId !== null) await countAccountImages(env.DB, job.userId, 1, now);

    if (!checker) return { image, attempts: attempt, neurons };
    const verdict = await withModelTimeout((signal) => checker.inspect({ bytes: image.bytes, mime: image.mime }, signal));
    neurons += verdict.estimatedNeurons;
    await recordSpend(env, background, job.scope, verdict.estimatedNeurons, now);
    if (!rejected(verdict, AI.outputCheck.rejectWhen)) return { image, attempts: attempt, neurons };
    console.log(`[ai] background refused by the check (attempt ${attempt}): ${JSON.stringify(verdict.flags)}`);
  }
  throw uncleanError();
}

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

export type UploadPurpose = 'logo' | 'reference';

export interface ImageHeader {
  mime: AiImageMime;
  width: number;
  height: number;
}

/** PNG or JPEG pixel size from the file header, or null when the bytes are neither (or are cut short). */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        at += 2;
        continue;
      }
      const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
      // Start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (bytes[at + 5]! << 8) | bytes[at + 6]!;
        const width = (bytes[at + 7]! << 8) | bytes[at + 8]!;
        return width > 0 && height > 0 ? { mime: 'image/jpeg', width, height } : null;
      }
      if (length < 2) return null;
      at += 2 + length;
    }
  }
  return null;
}

function refused(message: string, reason: string, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError('upload_refused', message, { details: { reason, ...extra } });
}

/** Size, type and pixel limits of an upload, from its bytes alone. */
export function assertUploadShape(bytes: Uint8Array, purpose: UploadPurpose): ImageHeader {
  const maxBytes = purpose === 'logo' ? AI.uploads.maxLogoBytes : AI.uploads.maxReferenceBytes;
  const maxSide = purpose === 'logo' ? AI.uploads.maxLogoSide : AI.uploads.maxReferenceSide;
  if (bytes.byteLength > maxBytes) throw refused(`The file is larger than ${Math.round(maxBytes / 1024)} KB.`, 'too_large', { max_bytes: maxBytes });
  const header = readImageHeader(bytes);
  if (!header) throw refused('The file is not a PNG or JPEG image.', 'not_png_or_jpeg');
  if (header.width > maxSide || header.height > maxSide) {
    throw refused(`The image is ${header.width} x ${header.height} pixels; the largest allowed is ${maxSide} x ${maxSide}.`, 'too_many_pixels', { max_side: maxSide });
  }
  return header;
}

/** The image check of an upload (account scope of the budget). Throws 422 upload_refused when it shows what the purpose forbids. */
export async function checkUpload(env: Env, background: Background, image: { bytes: Uint8Array; mime: AiImageMime }, purpose: UploadPurpose, now: number): Promise<void> {
  if (!AI.outputCheck.enabled) return;
  const checker = checkerFor(env);
  await assertBudget(env, 'account', AI.outputCheck.estimatedNeurons, now);
  const verdict = await withModelTimeout((signal) => checker.inspect(image, signal));
  await recordSpend(env, background, 'account', verdict.estimatedNeurons, now);
  const flags = AI.outputCheck.rejectUploadWhen[purpose];
  if (rejected(verdict, flags)) {
    const shown = flags.filter((flag) => verdict.flags[flag] === true);
    throw refused(
      purpose === 'logo'
        ? 'This logo was refused by our image check: logos may not show faces, people, documents or nudity.'
        : 'This image was refused by our image check: reference images may not show faces, people, documents, brand logos or nudity.',
      'image_check',
      shown.length > 0 ? { flags: shown } : {},
    );
  }
}

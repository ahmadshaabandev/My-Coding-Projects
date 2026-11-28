/**
 * Image providers (AI-SPEC.md section 1). One interface, picked by configuration:
 *
 *   "workers-ai:flux-2-klein-4b"   Cloudflare Workers AI through the AI binding (staging, production)
 *   "mock"                         a deterministic gradient of the requested size, no network
 *                                  (wrangler dev and the tests; src/ai/mock.ts)
 *
 * AI_PROVIDER picks "workers-ai" or "mock"; the model is AI.model. Another provider would plug in
 * here: a class implementing ImageProvider and one more entry in providerFor.
 *
 * Errors are ApiErrors and nothing is charged for them: Workers AI's 3030 ("Your output has been
 * flagged") is 422 content_flagged, a call still running after AI.timeoutMs is 504 ai_timeout, any
 * other failure is 502 ai_unavailable. The model's bytes are never served: callers store them in
 * R2 first (src/ai/storage.ts).
 */
import { AI, AI_MODELS, type AiModel, type AiModelId } from '../config';
import { ApiError } from '../lib/errors';
import type { AiBinding, Env } from '../types';
import { MockImageProvider, MockOutputChecker } from './mock';

export type AiImageMime = 'image/jpeg' | 'image/png';

export interface GenerateRequest {
  prompt: string;
  width: number;
  height: number;
  seed: number;
  /** Reference images (JPEG or PNG, each at most the model's maxRefSide on both sides). */
  refs?: Uint8Array[];
  /** Pixel sizes of the references, for the neuron estimate. */
  refSizes?: { width: number; height: number }[];
}

export interface GeneratedImage {
  bytes: Uint8Array;
  mime: AiImageMime;
  width: number;
  height: number;
  /** The model name, e.g. "@cf/black-forest-labs/flux-2-klein-4b", or "mock". */
  model: string;
  estimatedNeurons: number;
}

export interface ImageProvider {
  readonly id: string;
  generate(request: GenerateRequest, signal: AbortSignal): Promise<GeneratedImage>;
}

/** What a vision check answered: the flags it raised, or that the answer could not be read. */
export interface CheckVerdict {
  /** True when every flag the caller rejects on is false and the answer parsed. */
  readable: boolean;
  flags: Record<string, boolean>;
  model: string;
  estimatedNeurons: number;
}

export interface OutputChecker {
  readonly id: string;
  inspect(image: { bytes: Uint8Array; mime: AiImageMime }, signal: AbortSignal): Promise<CheckVerdict>;
}

/* ------------------------------------------------------------------ */
/* Neuron estimate                                                     */
/* ------------------------------------------------------------------ */

/** AI.models' formula: per started megapixel of output, plus input tiles pro rata. Budget only. */
export function estimateNeurons(model: Pick<AiModel, 'neuronsPerOutputMegapixel' | 'neuronsPerInputTile'>, width: number, height: number, refs: readonly { width: number; height: number }[] = []): number {
  const output = Math.max(1, Math.ceil((width * height) / 1_000_000)) * model.neuronsPerOutputMegapixel;
  const input = refs.reduce((sum, ref) => sum + ((ref.width * ref.height) / (512 * 512)) * model.neuronsPerInputTile, 0);
  return Math.round((output + input) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export function flaggedError(): ApiError {
  return new ApiError('content_flagged', 'The image model refused this combination. Try another style or motif. Nothing was charged.');
}

export function timeoutError(): ApiError {
  return new ApiError('ai_timeout', `The image model did not answer within ${AI.timeoutMs / 1000} seconds. Nothing was charged; try again.`);
}

export function unavailableError(): ApiError {
  return new ApiError('ai_unavailable', 'The image model is not available right now. Nothing was charged; try again in a minute.');
}

/** Workers AI's own refusal: error code 3030 "Your output has been flagged". */
function isFlagged(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b3030\b/.test(message) || /output has been flagged/i.test(message);
}

/** Runs one model call under AI.timeoutMs; maps its failure to the three errors above. */
export async function withModelTimeout<T>(work: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  outer?.addEventListener('abort', abort);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, AI.timeoutMs);
  });
  try {
    const running = work(controller.signal);
    running.catch(() => undefined);
    return await Promise.race([running, timeout]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isFlagged(error)) throw flaggedError();
    console.error('[ai] model call failed:', error instanceof Error ? error.message : error);
    throw unavailableError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener('abort', abort);
  }
}

/* ------------------------------------------------------------------ */
/* Workers AI                                                          */
/* ------------------------------------------------------------------ */

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function sniffMime(bytes: Uint8Array): AiImageMime | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

/** Snap a size to what the model takes: a multiple of sizeStep within minSide..maxSide. */
export function modelSide(model: Pick<AiModel, 'minSide' | 'maxSide' | 'sizeStep'>, side: number): number {
  const snapped = Math.round(side / model.sizeStep) * model.sizeStep;
  return Math.min(model.maxSide, Math.max(model.minSide, snapped));
}

export class WorkersAiProvider implements ImageProvider {
  readonly id: string;
  private readonly model: AiModel;

  constructor(
    private readonly binding: AiBinding,
    modelId: AiModelId,
  ) {
    this.model = AI_MODELS[modelId];
    if (!this.model.selectable) throw new Error(`model ${modelId} is not selectable`);
    this.id = `workers-ai:${modelId}`;
  }

  async generate(request: GenerateRequest, signal: AbortSignal): Promise<GeneratedImage> {
    const width = modelSide(this.model, request.width);
    const height = modelSide(this.model, request.height);
    const refs = (request.refs ?? []).slice(0, this.model.maxRefs);
    // klein-4b takes a multipart form, even for a prompt alone (Cloudflare changelog 2026-01-15).
    const form = new FormData();
    form.append('prompt', request.prompt);
    form.append('width', String(width));
    form.append('height', String(height));
    form.append('seed', String(request.seed));
    // guidance and steps are left to the model's defaults, as in the trial (steps are fixed at 4).
    refs.forEach((bytes, index) => {
      form.append(`input_image_${index}`, new Blob([bytes], { type: sniffMime(bytes) ?? 'image/png' }));
    });
    // FormData exposes no body or boundary; a Response serialises it and sets the content type.
    const serialised = new Response(form);
    const output = (await this.binding.run(
      this.model.id,
      { multipart: { body: serialised.body, contentType: serialised.headers.get('content-type') ?? 'multipart/form-data' } },
      { signal },
    )) as { image?: unknown } | null;
    if (!output || typeof output.image !== 'string') throw new Error('Workers AI answered without an image.');
    const bytes = decodeBase64(output.image);
    const mime = sniffMime(bytes);
    if (!mime) throw new Error('Workers AI answered with an image that is neither JPEG nor PNG.');
    return {
      bytes,
      mime,
      width,
      height,
      model: this.model.id,
      estimatedNeurons: estimateNeurons(this.model, width, height, request.refSizes ?? []),
    };
  }
}

/** Mistral Small 3.1 (Apache-2.0) as the output check: image in, JSON flags out (AI-SPEC.md section 3). */
export class WorkersAiChecker implements OutputChecker {
  readonly id = `workers-ai:${AI.outputCheck.model}`;

  constructor(private readonly binding: AiBinding) {}

  async inspect(image: { bytes: Uint8Array; mime: AiImageMime }, signal: AbortSignal): Promise<CheckVerdict> {
    let binary = '';
    for (let index = 0; index < image.bytes.length; index += 0x8000) binary += String.fromCharCode(...image.bytes.subarray(index, index + 0x8000));
    const dataUrl = `data:${image.mime};base64,${btoa(binary)}`;
    const output = (await this.binding.run(
      AI.outputCheck.model,
      {
        messages: [{ role: 'user', content: [{ type: 'text', text: AI.outputCheck.question }, { type: 'image_url', image_url: { url: dataUrl } }] }],
        max_tokens: AI.outputCheck.maxTokens,
        temperature: 0,
      },
      { signal },
    )) as { response?: unknown } | null;
    return { ...parseCheckAnswer(output?.response), model: AI.outputCheck.model, estimatedNeurons: AI.outputCheck.estimatedNeurons };
  }
}

/**
 * The check's answer: JSON, often inside a markdown fence (seen in the trial), sometimes already
 * parsed by the binding. Anything that is not an object of booleans is unreadable.
 */
export function parseCheckAnswer(response: unknown): { readable: boolean; flags: Record<string, boolean> } {
  let value: unknown = response;
  if (typeof value === 'string') {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(value);
    const text = (fenced ? fenced[1]! : value).trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    try {
      value = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : null;
    } catch {
      value = null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { readable: false, flags: {} };
  const flags: Record<string, boolean> = {};
  for (const [key, flag] of Object.entries(value)) if (typeof flag === 'boolean') flags[key] = flag;
  return { readable: Object.keys(flags).length > 0, flags };
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

function notConfigured(): ApiError {
  return new ApiError('not_configured', 'AI images are not set up on this deployment yet.');
}

function providerKind(env: Pick<Env, 'AI_PROVIDER'>): 'mock' | 'workers-ai' {
  const value = (env.AI_PROVIDER ?? '').trim();
  if (value === 'mock' || value === 'workers-ai') return value;
  throw notConfigured();
}

/** The provider AI_PROVIDER names, with AI.model. 503 not_configured when it is unknown or its binding is missing. */
export function providerFor(env: Pick<Env, 'AI_PROVIDER' | 'AI'>): ImageProvider {
  if (providerKind(env) === 'mock') return new MockImageProvider();
  if (!env.AI) throw notConfigured();
  return new WorkersAiProvider(env.AI, AI.model);
}

/** The output and upload check that goes with the provider. */
export function checkerFor(env: Pick<Env, 'AI_PROVIDER' | 'AI'>): OutputChecker {
  if (providerKind(env) === 'mock') return new MockOutputChecker();
  if (!env.AI) throw notConfigured();
  return new WorkersAiChecker(env.AI);
}

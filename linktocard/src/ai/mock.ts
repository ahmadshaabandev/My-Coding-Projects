/**
 * The "mock" AI provider (AI_PROVIDER = "mock": wrangler dev and the tests). It never touches the
 * network and costs nothing: generate() draws a deterministic gradient JPEG of the requested size
 * from the seed (soft diagonal colours, a few round shapes and a busier band at the edges, so a QR
 * code drawn on it is tested against more than a flat colour), and the checker passes every image.
 *
 * Tests steer it through mockAi: queue a failure for the next generation ('flagged' = Workers
 * AI's 3030, 'error', 'timeout') or the next check's answer (flags, or 'unreadable'), and read
 * how many calls were made and which prompts were sent.
 */
import { AI, AI_MODELS } from '../config';
import { ApiError } from '../lib/errors';
import { encodeRasterJpeg } from '../render/engine';
import { estimateNeurons, type CheckVerdict, type GenerateRequest, type GeneratedImage, type ImageProvider, type OutputChecker } from './provider';

export type MockFailure = 'flagged' | 'error' | 'timeout';

interface MockState {
  generateCalls: number;
  checkCalls: number;
  prompts: string[];
  failNextGenerate: MockFailure[];
  nextCheckAnswers: (Record<string, boolean> | 'unreadable')[];
  reset(): void;
}

export const mockAi: MockState = {
  generateCalls: 0,
  checkCalls: 0,
  prompts: [],
  failNextGenerate: [],
  nextCheckAnswers: [],
  reset() {
    this.generateCalls = 0;
    this.checkCalls = 0;
    this.prompts = [];
    this.failNextGenerate = [];
    this.nextCheckAnswers = [];
  },
};

/** mulberry32: a small deterministic PRNG. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** RGBA pixels of the mock background. */
export function mockPixels(width: number, height: number, seed: number): Uint8Array {
  const next = random(seed);
  const colour = (): [number, number, number] => [40 + next() * 200, 40 + next() * 200, 40 + next() * 200];
  const [a, b, c] = [colour(), colour(), colour()];
  const circles = Array.from({ length: 5 }, () => ({ x: next() * width, y: next() * height, r: (0.08 + next() * 0.2) * Math.min(width, height) }));
  const band = Math.round(Math.min(width, height) * 0.12);
  const stripe = 6 + Math.floor(next() * 10);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      let r = a[0] * (1 - t) + b[0] * t;
      let g = a[1] * (1 - t) + b[1] * t;
      let bl = a[2] * (1 - t) + b[2] * t;
      for (const circle of circles) {
        const d = Math.hypot(x - circle.x, y - circle.y);
        if (d < circle.r) {
          const w = 0.35 * (1 - d / circle.r);
          r = r * (1 - w) + c[0] * w;
          g = g * (1 - w) + c[1] * w;
          bl = bl * (1 - w) + c[2] * w;
        }
      }
      const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
      if (edge < band && Math.floor((x + y) / stripe) % 2 === 0) {
        r *= 0.7;
        g *= 0.7;
        bl *= 0.7;
      }
      const at = (y * width + x) * 4;
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = bl;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

export class MockImageProvider implements ImageProvider {
  readonly id = 'mock';

  async generate(request: GenerateRequest, _signal: AbortSignal): Promise<GeneratedImage> {
    mockAi.generateCalls++;
    mockAi.prompts.push(request.prompt);
    const failure = mockAi.failNextGenerate.shift();
    if (failure === 'flagged') throw new Error('AiError: 3030: Your output has been flagged. Please choose another prompt / input image combination');
    if (failure === 'timeout') throw new ApiError('ai_timeout', `The image model did not answer within ${AI.timeoutMs / 1000} seconds. Nothing was charged; try again.`);
    if (failure === 'error') throw new Error('mock model error');
    const { width, height, seed } = request;
    const bytes = await encodeRasterJpeg({ width, height, pixels: mockPixels(width, height, seed) });
    // The same estimate as the real model, so budget tests count what staging would.
    return { bytes, mime: 'image/jpeg', width, height, model: 'mock', estimatedNeurons: estimateNeurons(AI_MODELS[AI.model], width, height, request.refSizes ?? []) };
  }
}

export class MockOutputChecker implements OutputChecker {
  readonly id = 'mock';

  async inspect(_image: { bytes: Uint8Array }, _signal: AbortSignal): Promise<CheckVerdict> {
    mockAi.checkCalls++;
    const answer = mockAi.nextCheckAnswers.shift();
    const base = { model: 'mock', estimatedNeurons: AI.outputCheck.estimatedNeurons };
    if (answer === 'unreadable') return { ...base, readable: false, flags: {} };
    const clean = Object.fromEntries(AI.outputCheck.rejectWhen.map((flag) => [flag, false]));
    return { ...base, readable: true, flags: { ...clean, ...(answer ?? {}) } };
  }
}

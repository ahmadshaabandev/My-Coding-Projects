/**
 * The JSON body of POST /v1/pdf-tools/{op}, checked and turned into the operations' options,
 * and the dispatcher that runs an operation once its files are in hand. Fetching and reading
 * files is the route's job (it holds the guarded fetcher, R2 and the account), so this module
 * returns file references and never does I/O:
 *
 *   { "files": [ { "url": "https://..." } | { "base64": "JVBERi0..." } | { "pdf_id": "<64 hex>" } ], ...options,
 *     "response": "url" | "binary", "filename": "out.pdf" }
 *
 * Options per operation (snake_case, as the API documents them):
 *   merge        files[].pages ("3,1-2": order kept)
 *   split        ranges ("1-3,5") or every (n); response "url" only, since it makes several files
 *   stamp        text, font, font_size, color, opacity, rotation, position, margin, pages
 *                or image ({ url } | { base64 }), width, opacity, rotation, position, margin, pages
 *   fill         values { name: value }, flatten
 *   fields       nothing else (answers JSON, writes no file)
 *   from-images  files are PNG/JPEG; page_size, fit, orientation, margin
 *   protect      user_password, owner_password, permissions { printing, modifying, copying,
 *                annotating, filling_forms, content_accessibility, document_assembly }
 *
 * Numbers arrive as JSON numbers; a field of the wrong JSON type is a 400 that names it. Value
 * ranges are checked by the operations themselves (src/pdftools/*.ts), so a direct caller and
 * the API get the same rules.
 */
import { PDF_TOOLKIT, type PdfToolkitOp } from '../config';
import { ApiError } from '../lib/errors';
import { assertKnownFields, isJsonObject, type JsonObject } from '../lib/http';
import { parseFilename } from '../pdf/page';
import { assertPublicHttpUrl } from '../render/proxy';
import { fields, fill, type FieldInfo, type FillValue } from './forms';
import { fromImages, type FromImagesOptions } from './from-images';
import { merge } from './merge';
import { protect, type ProtectPermissions } from './protect';
import { split } from './split';
import { stamp, type StampOptions } from './stamp';
import type { PdfOutput } from './types';

export type FileRef = { kind: 'url'; url: string } | { kind: 'base64'; bytes: Uint8Array } | { kind: 'pdf_id'; id: string };

export type ToolkitResponseMode = 'url' | 'binary';

export interface ToolkitRequest {
  op: PdfToolkitOp;
  files: FileRef[];
  /** merge: the "pages" of each file, by index. */
  pages: (string | undefined)[];
  /** stamp with an image: the image file. */
  image?: FileRef;
  /** Everything else the operation takes, ready for runToolkitOp. */
  options: Record<string, unknown>;
  response: ToolkitResponseMode;
  filename: string;
}

export type ToolkitResult = { kind: 'pdf'; outputs: (PdfOutput & { range?: string })[] } | { kind: 'fields'; fields: FieldInfo[]; pages: number };

const COMMON = ['files', 'response', 'filename'];
const LAYOUT = ['opacity', 'rotation', 'position', 'margin', 'pages'];
const OP_FIELDS: Record<PdfToolkitOp, readonly string[]> = {
  merge: [],
  split: ['ranges', 'every'],
  stamp: ['text', 'font', 'font_size', 'color', 'image', 'width', ...LAYOUT],
  fill: ['values', 'flatten'],
  fields: [],
  'from-images': ['page_size', 'fit', 'orientation', 'margin'],
  protect: ['user_password', 'owner_password', 'permissions'],
};
const PERMISSION_FIELDS: Record<string, keyof ProtectPermissions> = {
  printing: 'printing',
  modifying: 'modifying',
  copying: 'copying',
  annotating: 'annotating',
  filling_forms: 'fillingForms',
  content_accessibility: 'contentAccessibility',
  document_assembly: 'documentAssembly',
};
const PDF_ID = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DATA_URL = /^data:[a-z0-9.+/-]*;base64,/i;

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

export function isToolkitOp(value: string): value is PdfToolkitOp {
  return (PDF_TOOLKIT.ops as readonly string[]).includes(value);
}

/** Strict base64 (a data: URL prefix is allowed), refused before decoding when it is too large. */
function decodeBase64(value: string, what: string): Uint8Array {
  const text = value.replace(DATA_URL, '').replace(/\s+/g, '');
  if (Math.floor((text.length * 3) / 4) > PDF_TOOLKIT.maxInputBytes) {
    throw new ApiError('payload_too_large', `${what} is larger than ${PDF_TOOLKIT.maxInputBytes} bytes.`, { details: { max_bytes: PDF_TOOLKIT.maxInputBytes } });
  }
  if (text.length % 4 !== 0 || !BASE64.test(text)) throw invalid(`${what} is not valid base64.`);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fileRef(value: unknown, what: string, allowPdfId: boolean, extra: readonly string[] = []): FileRef {
  if (!isJsonObject(value)) throw invalid(`${what} must be an object: { "url": ... }, { "base64": ... }${allowPdfId ? ' or { "pdf_id": ... }' : ''}.`);
  const sources = ['url', 'base64', ...(allowPdfId ? ['pdf_id'] : [])].filter((key) => value[key] !== undefined);
  const unknown = Object.keys(value).filter((key) => !['url', 'base64', 'pdf_id', ...extra].includes(key) || (key === 'pdf_id' && !allowPdfId));
  if (unknown.length > 0) throw invalid(`${what} has unknown field "${unknown[0]}".`);
  if (sources.length !== 1) throw invalid(`${what} needs exactly one of "url", "base64"${allowPdfId ? ' or "pdf_id"' : ''}.`);
  const source = sources[0]!;
  const raw = value[source];
  if (typeof raw !== 'string' || raw === '') throw invalid(`${what}.${source} must be a non-empty string.`);
  if (source === 'url') {
    try {
      assertPublicHttpUrl(raw);
    } catch (error) {
      if (error instanceof ApiError) throw invalid(`${what}.url: ${error.message}`);
      throw error;
    }
    return { kind: 'url', url: raw };
  }
  if (source === 'base64') return { kind: 'base64', bytes: decodeBase64(raw, `${what}.base64`) };
  if (!PDF_ID.test(raw)) throw invalid(`${what}.pdf_id must be the "id" of one of your stored PDFs (64 hex characters).`);
  return { kind: 'pdf_id', id: raw };
}

function optional<T>(body: JsonObject, key: string, type: 'string' | 'number' | 'boolean' | 'object'): T | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  const ok = type === 'object' ? isJsonObject(value) : typeof value === type;
  if (!ok) throw invalid(`"${key}" must be ${type === 'object' ? 'an object' : `a ${type}`}.`);
  return value as T;
}

function stampOptions(body: JsonObject): { options: Record<string, unknown>; image?: FileRef } {
  const layout = {
    opacity: optional<number>(body, 'opacity', 'number'),
    rotation: optional<number>(body, 'rotation', 'number'),
    position: optional<string>(body, 'position', 'string'),
    margin: optional<number>(body, 'margin', 'number'),
    pages: optional<string>(body, 'pages', 'string'),
  };
  const hasText = body.text !== undefined;
  const hasImage = body.image !== undefined;
  if (hasText === hasImage) throw invalid('Give either "text" or "image" to stamp, not both.');
  if (hasText) {
    if (body.width !== undefined) throw invalid('"width" goes with "image"; text is sized with "font_size".');
    return {
      options: {
        text: {
          text: optional<string>(body, 'text', 'string'),
          font: optional<string>(body, 'font', 'string'),
          fontSize: optional<number>(body, 'font_size', 'number'),
          color: optional<string>(body, 'color', 'string'),
          ...layout,
        },
      },
    };
  }
  for (const key of ['font', 'font_size', 'color']) if (body[key] !== undefined) throw invalid(`"${key}" goes with "text", not "image".`);
  return { options: { image: { width: optional<number>(body, 'width', 'number'), ...layout } }, image: fileRef(body.image, 'image', false) };
}

function protectOptions(body: JsonObject): Record<string, unknown> {
  const input = optional<JsonObject>(body, 'permissions', 'object');
  const permissions: Record<string, unknown> = {};
  if (input) {
    for (const [key, value] of Object.entries(input)) {
      const name = PERMISSION_FIELDS[key];
      if (!name) throw invalid(`permissions has unknown field "${key}". Allowed: ${Object.keys(PERMISSION_FIELDS).join(', ')}.`);
      permissions[name] = value;
    }
  }
  return { userPassword: body.user_password, ownerPassword: body.owner_password, permissions };
}

/** Checks the body of POST /v1/pdf-tools/{op}. Throws ApiError invalid_request naming the field. */
export function parseToolkitRequest(op: PdfToolkitOp, body: JsonObject): ToolkitRequest {
  assertKnownFields(body, [...COMMON, ...OP_FIELDS[op]]);
  const list = body.files;
  if (!Array.isArray(list) || list.length === 0) throw invalid(`"files" must be a non-empty list of files: [{ "url": ... } | { "base64": ... } | { "pdf_id": ... }].`);
  const max = op === 'merge' || op === 'from-images' ? PDF_TOOLKIT.maxFiles : 1;
  if (list.length > max) throw invalid(max === 1 ? `"${op}" takes one file; ${list.length} were given.` : `At most ${max} files per request; ${list.length} were given.`);
  const files = list.map((item, index) => fileRef(item, `files[${index}]`, op !== 'from-images', op === 'merge' ? ['pages'] : []));
  const pages = list.map((item, index) => {
    const value = (item as JsonObject).pages;
    if (value !== undefined && typeof value !== 'string') throw invalid(`files[${index}].pages must be a string like "1-3,5".`);
    return value as string | undefined;
  });

  const response = body.response ?? 'url';
  if (response !== 'url' && response !== 'binary') throw invalid('"response" must be "url" (default) or "binary".');
  if (response === 'binary' && (op === 'split' || op === 'fields')) throw invalid(`"${op}" answers JSON; "response": "binary" is not available for it.`);
  const filename = parseFilename(body.filename, `${op}.pdf`);

  let options: Record<string, unknown> = {};
  let image: FileRef | undefined;
  switch (op) {
    case 'split':
      options = { ranges: optional<string>(body, 'ranges', 'string'), every: optional<number>(body, 'every', 'number') };
      break;
    case 'stamp':
      ({ options, image } = stampOptions(body));
      break;
    case 'fill':
      if (!isJsonObject(body.values)) throw invalid('"values" must be an object of field names and values.');
      options = { values: body.values as Record<string, FillValue>, flatten: optional<boolean>(body, 'flatten', 'boolean') };
      break;
    case 'from-images':
      options = {
        pageSize: optional<string>(body, 'page_size', 'string'),
        fit: optional<string>(body, 'fit', 'string'),
        orientation: optional<string>(body, 'orientation', 'string'),
        margin: optional<number>(body, 'margin', 'number'),
      } satisfies Record<keyof Omit<FromImagesOptions, 'freeMark'>, unknown>;
      break;
    case 'protect':
      options = protectOptions(body);
      break;
    default:
      break;
  }
  return { op, files, pages, ...(image ? { image } : {}), options, response, filename };
}

/**
 * Runs a parsed request on its files (`files[i]` are the bytes of `request.files[i]`, `image`
 * those of `request.image`). `freeMark` is the Free plan's mark (src/pdf/service.ts planMark).
 */
export async function runToolkitOp(request: ToolkitRequest, input: { files: Uint8Array[]; image?: Uint8Array }, freeMark: boolean): Promise<ToolkitResult> {
  const { files } = input;
  const one = files[0]!;
  const o = request.options;
  switch (request.op) {
    case 'merge':
      return { kind: 'pdf', outputs: [await merge(files.map((bytes, i) => ({ bytes, pages: request.pages[i] })), { freeMark })] };
    case 'split':
      return { kind: 'pdf', outputs: (await split(one, { ...o, freeMark })).outputs };
    case 'stamp': {
      const options = (o.text ? { text: o.text, freeMark } : { image: { ...(o.image as object), image: input.image }, freeMark }) as StampOptions;
      return { kind: 'pdf', outputs: [await stamp(one, options)] };
    }
    case 'fill':
      return { kind: 'pdf', outputs: [await fill(one, { values: o.values as Record<string, FillValue>, flatten: o.flatten as boolean | undefined, freeMark })] };
    case 'fields':
      return { kind: 'fields', ...(await fields(one)) };
    case 'from-images':
      return { kind: 'pdf', outputs: [await fromImages(files, { ...(o as FromImagesOptions), freeMark })] };
    case 'protect':
      return { kind: 'pdf', outputs: [await protect(one, { ...o, freeMark })] };
  }
}

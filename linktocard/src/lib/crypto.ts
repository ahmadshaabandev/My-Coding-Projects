/**
 * Small Web Crypto helpers. Everything here runs unchanged in Workers,
 * browsers and Node 20+ (no Node built-ins).
 */

const encoder = new TextEncoder();

type Bytes = Uint8Array | ArrayBuffer;

function toBytes(input: string | Bytes): Uint8Array {
  if (typeof input === 'string') return encoder.encode(input);
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

export function toHex(input: Bytes): string {
  const bytes = toBytes(input);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

export function base64UrlEncode(input: Bytes): string {
  const bytes = toBytes(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64Encode(input: Bytes): string {
  const bytes = toBytes(input);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function sha256Hex(input: string | Bytes): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', toBytes(input)));
}

export async function hmacSha256(key: string | Bytes, message: string | Bytes): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toBytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, toBytes(message)));
}

export async function hmacSha256Hex(key: string | Bytes, message: string | Bytes): Promise<string> {
  return toHex(await hmacSha256(key, message));
}

/**
 * Constant-time comparison of two strings (used for signatures and hashes).
 * Length is not secret here: every caller compares fixed-length hex digests.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Uniform random string over an alphabet (rejection sampling, no modulo bias). */
function randomString(alphabet: string, length: number): string {
  const max = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    const buf = crypto.getRandomValues(new Uint8Array(length * 2));
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const b = buf[i]!;
      if (b < max) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

/** High-entropy secret, URL-safe: 40 base62 chars is about 238 bits. */
export function randomSecret(length = 40): string {
  return randomString(BASE62, length);
}

/** Opaque public id such as "u_4k2j9x0q1m7c8d5e". Not a secret. */
export function randomId(prefix: string, length = 16): string {
  return `${prefix}_${randomString(BASE36, length)}`;
}

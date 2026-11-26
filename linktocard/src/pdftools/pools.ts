/**
 * pdf-lib's object pools, made collectable.
 *
 * @cantoo/pdf-lib 2.11.1 (exact-pinned in package.json) interns every PDFRef ("n g R") and every
 * PDFName in a module-level Map (node_modules/@cantoo/pdf-lib/es/core/objects/PDFRef.js and
 * PDFName.js), so that the same reference or name is always the same object: PDFDict and
 * PDFContext key their Maps by that identity. Nothing ever removes an entry, so every distinct
 * object number and name any request parses stayed in the isolate for its whole life: four toolkit
 * requests of 300,000 distinct references each left 200 MB behind in Node, and an isolate has
 * 128 MB (security review SEC-1).
 *
 * This module replaces the two factories (PDFRef.of and PDFName.of are plain writable static
 * properties, and pdf-lib calls them through the class every time) with versions that keep the
 * interning but hold each instance through a WeakRef:
 *  - identity is unchanged: while anything holds an instance, `of` returns that same instance;
 *    an instance is only made anew once nothing can compare against the old one;
 *  - PDFName's static constants (PDFName.Type, PDFName.Length, ...) were made by the original
 *    factory when pdf-lib loaded; they are seeded into the new pool and kept, so `of('Type')`
 *    still returns PDFName.Type;
 *  - entries whose instance has been collected are dropped whenever a pool has doubled since its
 *    last sweep, and at the start of every toolkit operation (sweepPdfObjectPools, called by
 *    loadPdf and newPdf in src/pdftools/document.ts). FinalizationRegistry callbacks do not run
 *    in workerd (checked in the test pool), so the sweeps do it.
 *
 * The instances are made the way the private constructors make them (they check a module-private
 * token, so they cannot be called): the same prototype and the same own fields in the same order.
 * tests/pdftools-pools.test.ts compares them with the original factory's output. Any other module
 * of pdf-lib that interns objects would need the same treatment; 2.11.1 has only these two pools.
 *
 * Installed once, when this module is first imported; every module of src/pdftools imports
 * document.ts, which imports this before it does anything with pdf-lib.
 */
import { PDFName, PDFRef } from '@cantoo/pdf-lib';

/** A pool is swept when it has grown to this size, then whenever it has doubled again. */
const MIN_SWEEP_AT = 4096;

interface WeakPool<T extends object> {
  entries: Map<string, WeakRef<T>>;
  sweepAt: number;
}

const newPool = <T extends object>(): WeakPool<T> => ({ entries: new Map(), sweepAt: MIN_SWEEP_AT });

function sweep<T extends object>(pool: WeakPool<T>): number {
  let dropped = 0;
  for (const [key, ref] of pool.entries) {
    if (ref.deref() === undefined) {
      pool.entries.delete(key);
      dropped++;
    }
  }
  pool.sweepAt = Math.max(MIN_SWEEP_AT, pool.entries.size * 2);
  return dropped;
}

function lookup<T extends object>(pool: WeakPool<T>, key: string): T | undefined {
  return pool.entries.get(key)?.deref();
}

function remember<T extends object>(pool: WeakPool<T>, key: string, value: T): T {
  if (pool.entries.size >= pool.sweepAt) sweep(pool);
  pool.entries.set(key, new WeakRef(value));
  return value;
}

const refPool = newPool<PDFRef>();
const namePool = newPool<PDFName>();
/** The static PDFName constants, held strongly so their pool entries never die. */
const pinnedNames: PDFName[] = [];

/** The original factories, for tests that compare instances (calling them grows pdf-lib's own pool). */
export const ORIGINAL_FACTORIES = { refOf: PDFRef.of, nameOf: PDFName.of };

/** pdf-lib's IsIrregular table (es/core/syntax/Irregular.js): PDF white-space, delimiters and "#". */
const IRREGULAR = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25, 0x23]);
const isRegularChar = (code: number): boolean => code >= 0x21 && code <= 0x7e && !IRREGULAR.has(code);

/** PDFName.of's decodeName: "#xx" escapes with upper-case hex digits only, exactly as pdf-lib decodes them. */
const decodeName = (name: string): string => name.replace(/#([\dABCDEF]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** What the PDFName constructor stores: "/" and each UTF-16 unit, irregular ones as "#XX". */
function encodeName(decoded: string): string {
  let encoded = '/';
  for (let i = 0; i < decoded.length; i++) {
    const character = decoded[i]!;
    const code = character.charCodeAt(0);
    encoded += isRegularChar(code) ? character : `#${code.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  return encoded;
}

function makeRef(objectNumber: number, generationNumber: number, tag: string): PDFRef {
  const ref = Object.create(PDFRef.prototype) as { objectNumber: number; generationNumber: number; tag: string };
  ref.objectNumber = objectNumber;
  ref.generationNumber = generationNumber;
  ref.tag = tag;
  return ref as unknown as PDFRef;
}

function makeName(decoded: string): PDFName {
  const name = Object.create(PDFName.prototype) as { encodedName: string };
  name.encodedName = encodeName(decoded);
  return name as unknown as PDFName;
}

function refOf(objectNumber: number, generationNumber = 0): PDFRef {
  const tag = `${objectNumber} ${generationNumber} R`;
  return lookup(refPool, tag) ?? remember(refPool, tag, makeRef(objectNumber, generationNumber, tag));
}

function nameOf(name: string): PDFName {
  const decoded = decodeName(name);
  return lookup(namePool, decoded) ?? remember(namePool, decoded, makeName(decoded));
}

/** True once the collectable factories are in place (WeakRef exists in workerd and in Node). */
export const POOLS_COLLECTABLE = typeof WeakRef === 'function';

if (POOLS_COLLECTABLE) {
  for (const value of Object.values(PDFName)) {
    if (!(value instanceof PDFName)) continue;
    const encoded = value.asString();
    // Every constant is a plain word ("/Type"): its pool key is the word itself.
    if (encoded.includes('#')) throw new Error(`pdf-lib constant ${encoded} has an escape; src/pdftools/pools.ts cannot key it`);
    pinnedNames.push(value);
    namePool.entries.set(encoded.slice(1), new WeakRef(value));
  }
  PDFRef.of = refOf;
  PDFName.of = nameOf;
}

/** Drops pool entries whose instance has been collected. Returns how many entries were dropped. */
export function sweepPdfObjectPools(): number {
  if (!POOLS_COLLECTABLE) return 0;
  return sweep(refPool) + sweep(namePool);
}

/** Entries in the two pools (live or not yet swept), for tests. */
export function pdfObjectPoolSizes(): { refs: number; names: number; pinnedNames: number } {
  return { refs: refPool.entries.size, names: namePool.entries.size, pinnedNames: pinnedNames.length };
}

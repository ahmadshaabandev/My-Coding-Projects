// Makes satori@0.63.x usable in workerd. Import this module BEFORE 'satori/standalone'
// (ES imports are evaluated in order).
//
// Problem: every Satori build (including `satori/standalone`) inlines HarfBuzz
// (harfbuzzjs@0.10.0 `hb.wasm`, Emscripten) as a base64 string and starts it while the satori
// module is being evaluated. Satori exposes no hook for it: `init()` only covers the layout
// engine (`layout.wasm`). In workerd that start-up fails in three places:
//
//  1. Emscripten sees `WorkerGlobalScope` and reads `self.location.href`. workerd has no
//     `self.location`:
//       TypeError: Cannot read properties of undefined (reading 'href')
//     -> define a dummy `self.location` (the jSquash codecs do the same thing themselves).
//
//  2. It calls `WebAssembly.instantiate(<bytes>, imports)`. workerd refuses to compile wasm
//     from bytes:
//       CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder
//     -> wrap `WebAssembly.instantiate`; the one call carrying exactly the HarfBuzz bytes is
//        answered with the same binary imported as a precompiled WebAssembly.Module
//        (`harfbuzzjs/hb.wasm`, byte-identical to the copy inlined in satori).
//
//  3. harfbuzzjs then calls Emscripten's `addFunction(fn, 'vi')` once. Emscripten turns the JS
//     callback into a table entry by compiling a 34-byte adapter with
//     `new WebAssembly.Module(<bytes>)`:
//       CompileError: WebAssembly.Module(): Wasm code generation disallowed by embedder
//     (that one is thrown inside a promise executor's callback, so Satori does not fail, it
//     HANGS forever.)
//     -> wrap `WebAssembly.Module`; that exact adapter is answered with a precompiled copy
//        (./wasm/emscripten-adapter-vi.wasm).
//
// Every other WebAssembly call is passed through untouched (and still fails in workerd, as it
// should). If satori or harfbuzzjs is upgraded and the inlined binary changes, the fingerprint
// below stops matching, error 2 comes back, and tests/spike.test.ts fails: re-pin harfbuzzjs to
// the version satori inlines and update HB_WASM_BYTE_LENGTH / HB_WASM_FNV1A.
import hbWasmModule from 'harfbuzzjs/hb.wasm'
import adapterViModule from './wasm/emscripten-adapter-vi.wasm'

/** Byte length and FNV-1a (32 bit) hash of node_modules/harfbuzzjs/hb.wasm (harfbuzzjs@0.10.0). */
export const HB_WASM_BYTE_LENGTH = 381964
export const HB_WASM_FNV1A = 0xcf11fe61

/**
 * Bytes Emscripten's convertJsFunctionToWasm(fn, 'vi') generates: one function type
 * (i32) -> (), imported as "e"."f" and re-exported as "f".
 */
const ADAPTER_VI_BYTES = [
  0, 97, 115, 109, 1, 0, 0, 0, 1, 135, 0, 1, 96, 129, 0, 127, 128, 0, 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5,
  1, 1, 102, 0, 0,
]

interface ShimState {
  /** How many instantiate() calls were answered with the precompiled HarfBuzz module. */
  hits: number
  /** How many `new WebAssembly.Module()` calls were answered with the precompiled adapter. */
  adapterHits: number
}
const STATE_KEY = Symbol.for('linktocard.render.harfbuzzShim')
const globalState = globalThis as unknown as Record<symbol, ShimState | undefined>

function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function asBytes(source: unknown): Uint8Array | undefined {
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  return undefined
}

function install(): ShimState {
  const existing = globalState[STATE_KEY]
  if (existing) return existing // already wrapped in this isolate (e.g. vitest re-evaluation)

  const state: ShimState = { hits: 0, adapterHits: 0 }
  globalState[STATE_KEY] = state

  // (1) Emscripten's worker branch reads self.location.href.
  const scope = globalThis as unknown as { location?: { href: string } }
  if (scope.location === undefined) scope.location = { href: '' }

  // (2) HarfBuzz itself.
  const original = WebAssembly.instantiate.bind(WebAssembly) as (
    source: unknown,
    imports?: WebAssembly.Imports,
  ) => Promise<WebAssembly.Instance | { module: WebAssembly.Module; instance: WebAssembly.Instance }>

  const patched = async (source: unknown, imports?: WebAssembly.Imports) => {
    const bytes = asBytes(source)
    if (bytes && bytes.byteLength === HB_WASM_BYTE_LENGTH && fnv1a(bytes) === HB_WASM_FNV1A) {
      state.hits++
      const instance = (await original(hbWasmModule, imports)) as WebAssembly.Instance
      // Same result shape as the bytes overload that the caller asked for.
      return { module: hbWasmModule, instance }
    }
    return original(source, imports)
  }
  ;(WebAssembly as unknown as { instantiate: typeof patched }).instantiate = patched

  // (3) Emscripten's addFunction adapter. A Proxy keeps `x instanceof WebAssembly.Module` and
  // `WebAssembly.Module.imports()` working.
  const OriginalModule = WebAssembly.Module
  const ModuleProxy: typeof WebAssembly.Module = new Proxy(OriginalModule, {
    construct(target, args, newTarget) {
      const bytes = asBytes(args[0])
      if (
        bytes &&
        bytes.byteLength === ADAPTER_VI_BYTES.length &&
        ADAPTER_VI_BYTES.every((byte, i) => bytes[i] === byte)
      ) {
        state.adapterHits++
        return adapterViModule
      }
      return Reflect.construct(target, args, newTarget === ModuleProxy ? target : newTarget) as object
    },
  })
  ;(WebAssembly as unknown as { Module: typeof WebAssembly.Module }).Module = ModuleProxy
  return state
}

const state = install()

/** Number of times the HarfBuzz substitution happened in this isolate (expected: 1). */
export function harfbuzzShimHits(): number {
  return state.hits
}

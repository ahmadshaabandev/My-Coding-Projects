# Spike: rendering stack inside workerd (Satori + resvg-wasm + jSquash)

Date: 2026-11-21. Project: `/home/user/My-Coding-Projects/linktocard`. Nothing was deployed; everything below was run locally.

## 0. Verdict

**It works.** A Satori VDOM is rendered to PNG, JPEG and WebP at 1200x630, 1080x1080 and 1080x1350 inside real workerd (`wrangler dev`, no `nodejs_compat`), and inside the vitest Workers pool. 40 tests pass, `tsc --noEmit` is clean, the HTTP smoke returns a PNG whose text is visibly set in Inter / Source Serif 4 / JetBrains Mono.

But it only works with a workaround, and several assumptions in the brief are out of date:

1. **`satori/standalone` does not run in workerd as documented.** Satori 0.63.2 inlines HarfBuzz as base64 wasm in every build and compiles it from bytes. I had to patch `self.location`, `WebAssembly.instantiate` and `WebAssembly.Module` (section 2.1). This is the single most fragile part of the stack.
2. **`@cloudflare/vitest-pool-workers` is deprecated** (renamed `@cloudflare/vitest-plugin`). The skeleton uses the successor. This is a deliberate deviation from the brief (section 1.1).
3. **The vitest pool is not a faithful copy of production workerd.** It hid a crash that only `wrangler dev` showed. `npm run smoke` exists for that reason.
4. **Satori 0.63 is not the Satori the brief describes.** It now uses Taffy + HarfBuzz, lays out block/inline/grid like a browser, supports `z-index`, RTL, `<style>` stylesheets with selectors, and WOFF2. `div` no longer needs `display:flex`. This is all recent: harfbuzzjs appears in 0.33.0 (2026-08-20), `yoga-layout` is gone from 0.37.0 (2026-10-08), and 0.63.2 is from 2026-10-20, 64 releases in two months. Expect churn.
5. **Shadows and blurs are a CPU bomb.** One `box-shadow` with a 60px blur costs about 2 s, 150px costs 19 s, 200px crashes resvg. Hard caps are required (section 7i).
6. **Workers Free cannot run this.** Its CPU limit is 10 ms per request; a warm render here is 95-215 ms (section 5).

## 1. Pinned versions (all installed with exact versions)

Runtime dependencies:

| Package | Version | Note |
| --- | --- | --- |
| hono | 4.13.19 | |
| satori | 0.63.2 | newest; works only with the shim in 2.1 |
| harfbuzzjs | 0.10.0 | **added by me**; must equal the version satori pins (`"harfbuzzjs": "0.10.0"`), its `hb.wasm` is imported by the shim |
| @resvg/resvg-wasm | 2.6.2 | |
| @jsquash/jpeg | 1.6.0 | |
| @jsquash/webp | 1.5.0 | pulls wasm-feature-detect 1.10.1 |
| htmlparser2 | 12.0.0 | |
| domhandler | 6.0.1 | |
| domutils | 4.0.2 | |
| css-select | 7.0.0 | |
| css-what | 8.0.0 | |

Dev dependencies:

| Package | Version | Note |
| --- | --- | --- |
| wrangler | 4.166.0 | brings workerd 1.20261119.1, miniflare 5.20261119.0-beta, esbuild 0.28.2 |
| @cloudflare/vitest-plugin | 1.9.0 | **replaces** `@cloudflare/vitest-pool-workers` (see 1.1) |
| vitest | 5.1.1 | vite 8.3.8 |
| typescript | 7.0.2 | |
| @cloudflare/workers-types | 5.20261121.1 | wrangler peer: `^5.20261119.1` |
| tsx | 4.23.15 | |
| @fontsource/inter | 5.3.0 | only a source of .woff files |
| @fontsource/source-serif-4 | 5.3.1 | only a source of .woff files |
| @fontsource/jetbrains-mono | 5.3.0 | only a source of .woff files |

Toolchain: Node v22.23.5, system npm 10.9.9; the lockfile was written by `npx npm@12.2.3 install`.

Source for every version: `npm view <pkg> version` and `npm ls` run on 2026-11-21.

### 1.1 Deviation: `@cloudflare/vitest-plugin` instead of `@cloudflare/vitest-pool-workers`

- `node_modules/@cloudflare/vitest-pool-workers/README.md` (0.23.0, the latest): "`@cloudflare/vitest-pool-workers` has been renamed to `@cloudflare/vitest-plugin`. This package will not receive future updates." The npm `deprecated` field says the same, and it prints that warning on every run.
- 0.23.0 hard-pins `wrangler@4.124.0` / `miniflare@5.20260815.0-alpha` (workerd 1.20260815.1) and peers `vitest ^4.1.0` (plus `@vitest/runner`, `@vitest/snapshot` `^4.1.0`). With `compatibility_date = "2026-11-19"` the pool refuses to start:
  `This Worker requires compatibility date "2026-11-19", but the newest date supported by this server binary is "2026-08-22".`
- I did run it once with `compatibility_date = "2026-08-15"` + vitest 4.1.12: the PNG test passed there too (with the shim), so the stack is proven on workerd 1.20260815.1 as well.
- `@cloudflare/vitest-plugin@1.9.0` (published 2026-11-20) peers `vitest ^4.1.0 || ^5.0.0` and uses the same miniflare/workerd as wrangler 4.166.0, so there is one workerd binary and tests run on the runtime `wrangler dev` uses. Same API: `cloudflareTest({ wrangler: { configPath } })`.
- To go back: swap the package name in `package.json` and `vitest.config.ts`, pin `vitest@4.1.12`, and lower `compatibility_date` to at most `2026-08-22`. I do not recommend it.

### 1.2 Install pitfalls

- **npm 10.9.9 crashes** resolving vitest 4's peer set: `npm error Cannot read properties of null (reading 'edgesOut')` (arborist `#loadPeerSet`). `npx -y npm@12.2.3 install` worked. With the final set (vitest 5.1.1) `npm ci --dry-run` and `npm install --dry-run` also succeed on npm 10.9.9.
- **npm 12 blocks install scripts**: "2 packages had install scripts blocked because they are not covered by allowScripts: esbuild@0.28.2, workerd@1.20261119.1". Both binaries work without their postinstall (wrangler dev, vitest and dry-run all ran).
- `npm audit`: 2 moderate, both `fflate 0.7.3` via satori (GHSA-px8p-9vwx-vf98, `unzipSync` infinite loop on malformed ZIP64). Satori uses `inflateSync` on WOFF tables and our fonts are bundled, not user-supplied. `npm audit fix --force` would downgrade to `satori@0.32.0`; do not run it.

### 1.3 Fonts

30 `.woff` files copied from `@fontsource/*` into `src/render/fonts/`, **642,432 bytes** total:

| Family | Files | Bytes |
| --- | --- | --- |
| Inter 400/600/700/800 x latin, latin-ext, cyrillic, greek, vietnamese | 20 | 423,912 |
| Source Serif 4 400, 600, 400-italic x latin, latin-ext | 6 | 142,384 |
| JetBrains Mono 400, 700 x latin, latin-ext | 4 | 76,136 |

Licences: `src/render/fonts/LICENSES/{Inter,SourceSerif4,JetBrainsMono}-OFL.txt` (copied from each package's `LICENSE`; each contains the SIL OFL 1.1 text).

The brief says "Satori cannot read woff2". That is no longer true: 0.63.2 decodes WOFF2 (tested, 7f). The same 30 files as `.woff2` are 498,192 bytes (144 KB less). I kept `.woff` as instructed; `wrangler.toml` already has a `Data` rule for `.woff2`.

## 2. The code that works

### 2.1 Satori in workerd: the shim

What the installed package says (`node_modules/satori/package.json`, `README.md`, `dist/`):

- Exports: `.`, `./standalone`, `./experimental`, `./jsx`, `./layout.wasm`. **There is no `satori/wasm` and no yoga any more.** Layout is Taffy compiled to `layout.wasm` (520,763 bytes).
- README: "If there is a limitation on dynamically loading WASM (e.g. Cloudflare Workers), you can use the Standalone Build" and "Satori's standalone build doesn't include the WASM binary of its layout engine by default".
- Reality: `dist/standalone.js` still contains harfbuzzjs's `hb.wasm` as a 509,288-character base64 string (I decoded it: 381,964 bytes, sha256 `d2ab9751...`, byte-identical to `node_modules/harfbuzzjs/hb.wasm`). `init()` only covers the layout engine. HarfBuzz starts during module evaluation with no hook.

Running `satori/standalone` as documented fails in workerd in three successive ways:

| # | Where seen | Error |
| --- | --- | --- |
| 1 | `wrangler dev` only | `TypeError: Cannot read properties of undefined (reading 'href')` at `hb.js` (Emscripten reads `self.location.href`) |
| 2 | pool and `wrangler dev` | `RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder)` |
| 3 | pool and `wrangler dev` | `CompileError: WebAssembly.Module(): Wasm code generation disallowed by embedder` from Emscripten `addFunction` -> `convertJsFunctionToWasm`. Thrown inside a promise callback, so **`satori()` does not reject, it hangs forever** |

The fix is `src/render/satori-workerd-shim.ts` (129 lines, fully commented). The essential part:

```ts
// src/render/satori-workerd-shim.ts  (must be imported BEFORE 'satori/standalone')
import hbWasmModule from 'harfbuzzjs/hb.wasm'                      // precompiled by wrangler
import adapterViModule from './wasm/emscripten-adapter-vi.wasm'    // 34 bytes, checked in

export const HB_WASM_BYTE_LENGTH = 381964   // harfbuzzjs@0.10.0 hb.wasm
export const HB_WASM_FNV1A = 0xcf11fe61     // FNV-1a 32 of the same file

// (1) Emscripten's worker branch reads self.location.href
if ((globalThis as any).location === undefined) (globalThis as any).location = { href: '' }

// (2) answer the one instantiate(<HarfBuzz bytes>) call with the precompiled module
const original = WebAssembly.instantiate.bind(WebAssembly)
;(WebAssembly as any).instantiate = async (source: unknown, imports?: WebAssembly.Imports) => {
  const bytes = asBytes(source)
  if (bytes && bytes.byteLength === HB_WASM_BYTE_LENGTH && fnv1a(bytes) === HB_WASM_FNV1A) {
    const instance = await original(hbWasmModule, imports)
    return { module: hbWasmModule, instance }          // shape of the bytes overload
  }
  return original(source as any, imports)
}

// (3) answer `new WebAssembly.Module(<34-byte 'vi' adapter>)` with a precompiled copy
const OriginalModule = WebAssembly.Module
const ModuleProxy = new Proxy(OriginalModule, {
  construct(target, args, newTarget) {
    const bytes = asBytes(args[0])
    if (bytes && bytes.byteLength === ADAPTER_VI_BYTES.length && ADAPTER_VI_BYTES.every((b, i) => bytes[i] === b)) return adapterViModule
    return Reflect.construct(target, args, newTarget === ModuleProxy ? target : newTarget)
  },
})
;(WebAssembly as any).Module = ModuleProxy
```

Every other WebAssembly call is passed through unchanged. `harfbuzzjs` is a direct, exact dependency so that `harfbuzzjs/hb.wasm` resolves and stays the version satori inlines.

Blunt assessment of the shim:

- It patches three globals. It is small and inert for other callers, but it is a monkey-patch.
- It is coupled to satori's exact build. If satori ships a different HarfBuzz, the fingerprint misses, error 2 returns and `tests/spike.test.ts` fails. Fix: re-pin harfbuzzjs and update the two constants (recompute with a 5-line Node script, see the comment in the file).
- Only the `'vi'` adapter is precompiled. Satori takes glyph outlines from opentype.js, not HarfBuzz draw callbacks, so nothing else is needed today. If a future satori calls another `addFunction` signature, error 3 returns as a hang.
- The 509,288-char base64 copy of HarfBuzz stays in the bundle as dead weight (about 201,586 bytes gzip) and is still base64-decoded once at startup.
- Fallback if this becomes unmaintainable: `satori@0.32.0` (2026-08-20) is the last release without harfbuzzjs; it used `yoga-layout` and exports `./standalone` + `./yoga.wasm`. Untested here, and it has none of the 0.63 behaviours described in section 7.

### 2.2 Engine imports and one-time init (`src/render/engine.ts`)

```ts
import { harfbuzzShimHits } from './satori-workerd-shim'          // FIRST import
import satori, { init as initSatori } from 'satori/standalone'
import layoutWasm from 'satori/layout.wasm'
import { Resvg, initWasm as initResvg } from '@resvg/resvg-wasm'
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
import encodeJpeg, { init as initJpegEncoder } from '@jsquash/jpeg/encode.js'
import jpegEncWasm from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'
import encodeWebp, { init as initWebpEncoder } from '@jsquash/webp/encode.js'
import webpEncWasm from '@jsquash/webp/codec/enc/webp_enc_simd.wasm'   // the SIMD build, see below

// init promise remembered per LIBRARY INSTANCE: WeakMap on globalThis keyed by the library's init fn
const registry = ((globalThis as any)[Symbol.for('linktocard.render.init')] ??= { promises: new WeakMap(), runs: {} })
function once(name: string, libraryInit: object, run: () => Promise<unknown>): Promise<void> {
  let promise = registry.promises.get(libraryInit)
  if (!promise) {
    registry.runs[name] = (registry.runs[name] ?? 0) + 1
    promise = run().then(() => undefined, (e) => { registry.promises.delete(libraryInit); throw e })
    registry.promises.set(libraryInit, promise)
  }
  return promise
}
const ensureSatori = () => once('satori', initSatori, async () => initSatori(layoutWasm))
const ensureResvg = () => once('resvg', initResvg, async () => {
  try { await initResvg(resvgWasm) }
  catch (e) { if (!(e instanceof Error && e.message.includes('Already initialized'))) throw e }
})
const ensureJpeg = () => once('jpeg', initJpegEncoder, () => initJpegEncoder(jpegEncWasm))
const ensureWebp = () => once('webp', initWebpEncoder, () => initWebpEncoder(webpEncWasm))
```

Why the registry is keyed by the library's init function and not a plain module-level flag:

- resvg-wasm sets its `initialized` flag only after an `await`, so two concurrent first requests would both instantiate. A shared promise prevents that.
- My first version used a global `{satori: promise}` map. The test that calls `vi.resetModules()` and re-imports the engine then **hung for 30 s**: vitest re-evaluated satori too, the new satori instance never got `init()`, and `satori()` waited forever. Keying by library instance handles both cases: same instance -> no second init (resvg would throw `Already initialized. The \`initWasm()\` function can be used only once.`); new instance -> initialised again.
- Evidence: `init runs before/after module re-evaluation {"satori":1,"resvg":1,"jpeg":1,"webp":1,"harfbuzz":1} {"satori":2,...}` in the pool; `x-init-runs: {"satori":1,"resvg":1,"jpeg":1,"webp":1,"harfbuzz":1}` after many requests in `wrangler dev`.

WebP: `@jsquash/webp/encode.js` picks its SIMD glue when `wasm-feature-detect`'s `simd()` is true. In workerd it is true (`WebAssembly.validate` is allowed), so the SIMD binary must be supplied. jSquash's own Workers example does the same (https://raw.githubusercontent.com/jamsinclair/jSquash/main/examples/cloudflare-worker-esm-format/src/index.js). Exact wasm paths: `@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm` (251,524 B), `@jsquash/webp/codec/enc/webp_enc_simd.wasm` (345,584 B); the non-SIMD one is `webp_enc.wasm` (281,261 B).

jSquash wants a DOM `ImageData`; workerd has none. It only reads `.data/.width/.height`, so a plain object works:

```ts
{ data: new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height }
```

### 2.3 Premultiplied alpha (brief item 4)

Measured on resvg directly, 50%-opaque red rect:

| `background` option | First pixel RGBA | Meaning |
| --- | --- | --- |
| none | `[128, 0, 0, 128]` | premultiplied (straight would be `[255, 0, 0, 128]`) |
| `#ffffff` | `[255, 127, 127, 255]` | opaque |
| `rgba(255,255,255,0.5)` | `[192, 64, 64, 192]` | premultiplied |

So `RenderedImage.pixels` is premultiplied RGBA. The engine always passes an opaque `background` (default `#ffffff`), every alpha is 255 (asserted in `tests/spike.test.ts`), and premultiplied equals straight. Pixels go to the JPEG/WebP encoders unchanged. If transparent output is ever wanted, un-premultiply first.

### 2.4 Public API of the engine

```ts
render(vdom, { width, height, format: 'png' | 'jpeg' | 'webp', quality?, background?, svg? }): Promise<Uint8Array>
renderWithTimings(vdom, options): Promise<{ bytes, timings: { svg, raster, encode, total } }>
renderPng / renderJpeg / renderWebp(vdom, { width, height })
renderSvg(vdom, { width, height, fonts?, graphemeImages?, loadAdditionalAsset?, onStyleError?, onNodeDetected?, limits? })
rasterize(svg, width, background?) / svgToPng(svg, width, background?) / encodeRasterJpeg / encodeRasterWebp
warmUp()        // instantiate all four wasm modules now
initRuns()      // diagnostics
RenderInputError, DEFAULT_LIMITS
```

`renderSvg` runs `assertSafeVdom` (`src/render/guard.ts`) first: data-URI-only, max 3000 nodes, max depth 100 (provisional numbers, see 7i).

## 3. Config that works

`wrangler.toml`:

```toml
name = "linktocard"
main = "src/index.ts"
compatibility_date = "2026-11-19"

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
fallthrough = true

[[rules]]
type = "Data"
globs = ["**/*.woff", "**/*.woff2", "**/*.ttf", "**/*.otf"]
fallthrough = true
```

- **`nodejs_compat` is not needed.** Verified by running the full pipeline (PNG, JPEG, WebP) and a separate htmlparser2/css-select worker under `wrangler dev` with no `compatibility_flags`. Side observation: at this compatibility date `typeof process === 'object'` and `typeof Buffer === 'function'` even without the flag; `location` is undefined and `new Function` throws `EvalError: Code generation from strings disallowed for this context`.
- The `CompiledWasm` rule is redundant: I removed it and tests plus dry-run still passed (wrangler treats `.wasm` as `WebAssembly.Module` by default; cloudflare-docs `workers/wrangler/bundling.mdx`). It is kept because the brief asks for it and it documents intent.
- The `Data` rule is required. Without it wrangler fails with `No loader is configured for ".woff" files: src/render/fonts/inter-latin-400-normal.woff`, and the pool fails with `TypeError: Invalid value used as weak map key`.
- `compatibility_date` must not be newer than the installed workerd supports (1.20261119.1 here).

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-plugin'

const probes = process.env.PROBES === '1'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
  test: {
    include: probes ? ['tests/probes/**/*.probe.ts'] : ['tests/**/*.test.ts'],
    testTimeout: probes ? 600_000 : 30_000,
  },
})
```

`tsconfig.json`: `strict`, `module: ESNext`, `moduleResolution: Bundler`, `lib: ["ES2022"]`, `types: ["@cloudflare/workers-types"]`, `noEmit`, `verbatimModuleSyntax`, `skipLibCheck`. `src/types/assets.d.ts` declares `*.wasm` (`WebAssembly.Module`) and `*.woff|*.woff2|*.ttf|*.otf` (`ArrayBuffer`).

`package.json` scripts:

| Script | Command | Purpose |
| --- | --- | --- |
| `dev` | `wrangler dev` | |
| `test` | `vitest run` | 40 tests in workerd, about 6 s |
| `typecheck` | `tsc --noEmit` | |
| `smoke` | `node scripts/smoke.mjs` | starts `wrangler dev` on 8799, fetches `/spike.{png,jpg,webp}`, checks bytes, kills the process group |
| `bench` | `node scripts/smoke.mjs --bench` | fresh server per format: cold + 10 warm |
| `probes` | `PROBES=1 vitest run --silent=false` | slow log-only exploration files (about 80 s) |
| `build:dry` | `wrangler deploy --dry-run --outdir dist` | |

`.gitignore`: `node_modules`, `.wrangler`, `.dev.vars`, `dist`.

## 4. Every pitfall hit, and its fix

| # | Pitfall | Fix |
| --- | --- | --- |
| 1 | npm 10.9.9 `Cannot read properties of null (reading 'edgesOut')` | install with npm 12.2.3, or use vitest 5 |
| 2 | vitest-pool-workers deprecated; old workerd rejects the compat date | `@cloudflare/vitest-plugin` |
| 3 | `satori/standalone` compile errors and hang | shim, 2.1 |
| 4 | **The pool hid error 1 of the shim.** Inside the pool `self.location`/`__filename` exist, `nodejs_compat` is forced on (`process.versions.node` was "22.23.4") and `new Function('return 1')()` returns 1. Tests were green while `wrangler dev` returned 500 | `npm run smoke` against real workerd; treat it as a required check |
| 5 | Hono route `/spike.:ext` returned 404 for `/spike.png` | `app.get('/:file{spike\\.[a-z]+}', ...)` |
| 6 | First PNG had no bottom row. Satori 0.63 follows CSS: `box-sizing` defaults to `content-box`, so `width:100%; height:100%; padding:64` overflows the canvas | `boxSizing: 'border-box'` on the root |
| 7 | Global init map hung after `vi.resetModules()` | key the registry by library instance, 2.2 |
| 8 | After a wasm trap in `resvg.render()`, `resvg.free()` throws `recursive use of an object detected which would lead to unsafe aliasing in rust`, masking the real `RuntimeError: unreachable` | `withResvg` swallows errors from `free()` |
| 9 | TypeScript: no `ImageData`, no `WebAssembly.WebAssemblyInstantiatedSource` in workers-types | local types / casts |
| 10 | css-select typing: `selectOne(sel, document)` is typed as returning `Document` | pass `doc.children`, or cast |
| 11 | vitest 5 hides `console.log` of passing tests | `--silent=false` |
| 12 | `wrangler dev` stopped listening once after several hot reloads in a row | restart it; the smoke script always starts a fresh one |

## 5. Timings

Measured in real workerd 1.20261119.1 via `npm run bench` (in-Worker `performance.now()`, reported through a `Server-Timing` header). Machine: container, 4 vCPU, Intel Xeon 2.10 GHz. Card: `src/render/sample-card.ts` (gradient background, five text runs, three font families), 1200x630. Range over four bench runs; warm = median of 10 requests with a different title each time.

| Format | Output size | Cold total | Warm total | Warm: satori | Warm: resvg | Warm: encode |
| --- | --- | --- | --- | --- | --- | --- |
| PNG | 149,812 B | 328-463 ms | 95-99 ms | 4-5 ms | 91-94 ms (includes PNG encoding) | - |
| JPEG q85 | 29,051 B | 444-594 ms | 183-214 ms | 5-6 ms | 68-85 ms | 109-120 ms |
| WebP q85 | 18,858 B | 382-567 ms | 141-154 ms | 5-6 ms | 68-74 ms | 67-71 ms |

- "Cold" is the first request in a fresh isolate. It includes wasm instantiation and parsing all 30 fonts. It does **not** include isolate startup (module evaluation), which `wrangler check startup` profiled locally at 113.8 ms active.
- Cold satori stage is about 190-250 ms. Of that, parsing the 30 fonts is about 114 ms (probe: 1 font 10 ms, 4 fonts 24 ms, 8 fonts 54 ms, 30 fonts 114 ms). All fonts in the array are parsed eagerly on first use.
- **These numbers are local.** In production `performance.now()` only advances on I/O (cloudflare-docs `workers/runtime-apis/performance.mdx`), so the `Server-Timing` header will read 0 there; use Workers analytics for CPU time.
- Workers Free allows 10 ms CPU per request; Workers Paid 5 min (default 30 s) (cloudflare-docs `workers/platform/limits.mdx`). A warm render is 10-20x the Free limit.

Encoder options (same raster, median of 4, pool):

| Encoder setting | Time | Size |
| --- | --- | --- |
| JPEG q85, jSquash defaults (progressive) | 99 ms | 28.4 kB |
| JPEG q85, `progressive: false` | 50 ms | 32.7 kB |
| JPEG q85, `baseline: true, progressive: false, optimize_coding: false` | 66 ms | 35.1 kB |
| WebP q85, default `method: 4` | 64 ms | 18.4 kB |
| WebP q85, `method: 2` | 39 ms | 18.7 kB |
| WebP q85, `method: 0` | 21 ms | 21.6 kB |
| WebP q85, `method: 6` | 93 ms | 18.2 kB |
| WebP lossless | 328 ms | 24.1 kB |

The engine currently uses jSquash defaults plus `quality`. `progressive: false` and `method: 2` would roughly halve encode time for 2-15% more bytes; that is a product decision I left open.

## 6. Bundle size

`npx wrangler deploy --dry-run --outdir <scratchpad>/dry`: **Total Upload: 6296.96 KiB / gzip: 2576.07 KiB** (39 files). With `--minify`: 5732.44 KiB / gzip 2511.86 KiB.

| Module | Raw bytes | gzip -9 bytes |
| --- | --- | --- |
| `@resvg/resvg-wasm/index_bg.wasm` | 2,478,606 | 948,791 |
| `index.js` (all JavaScript) | 1,827,088 | 517,317 |
| 30 x `.woff` | 642,432 | 642,294 (already compressed) |
| `satori/layout.wasm` | 520,763 | 210,536 |
| `harfbuzzjs/hb.wasm` | 381,964 | 154,327 |
| `@jsquash/webp/.../webp_enc_simd.wasm` | 345,584 | 125,927 |
| `@jsquash/jpeg/.../mozjpeg_enc.wasm` | 251,524 | 59,129 |
| `emscripten-adapter-vi.wasm` | 34 | 119 |

Inside `index.js` (esbuild metafile, bytes in output): satori 1,110,807 (of which 509,288 is the unused HarfBuzz base64); @shuding/opentype.js 253,844; @jsquash/webp glue 137,785 (SIMD and non-SIMD glue are both bundled); linebreak 63,903; @jsquash/jpeg glue 62,090; hono 61,979; css-to-react-native 28,398; app code 19,260; resvg-wasm JS 18,188.

Not yet in that total: htmlparser2 + css-select + css-what + domutils + domhandler. A worker importing only those is 182.50 KiB / gzip 48.46 KiB.

Limits (cloudflare-docs `workers/platform/limits.mdx`, fetched 2026-11-21): Worker size 64 MiB uncompressed on both plans ("There is no compressed size limit"); startup time 1 second; memory 128 MB per isolate. Size is not a constraint.

## 7. Satori behaviours to design around

Evidence for each item is an assertion in `tests/satori-behaviour.test.ts` (kept, runs in workerd) or a log line from `tests/probes/*.probe.ts`. Source references are to satori 0.63.2's TypeScript sources recovered from `dist/standalone.js.map`.

### 7a. `<img>` with data URIs

| Source | `<img>` | `background-image: url()` | Notes |
| --- | --- | --- | --- |
| `data:image/png;base64` | renders | renders | |
| `data:image/jpeg;base64` | renders | renders | |
| `data:image/gif;base64` | renders | renders | 1x1 test image; animation not tested |
| `data:image/svg+xml` (base64 or URL-encoded) | renders | renders | |
| `data:image/webp;base64` | **blank, no error** | **blank, no error** | Satori emits `<image href="data:image/webp...">`; resvg-wasm 2.6.2 does not decode WebP (confirmed by feeding resvg directly) |

- WebP inputs must be transcoded to PNG/JPEG before they reach the engine. `@jsquash/webp` has a decoder (`codec/dec/webp_dec.wasm`, 137,960 B) that would need the same manual init.
- `width`/`height` are **not required** (README: "recommended"). Without either, a 16x16 image was laid out at 300x300 in a 300px container: full container width, intrinsic aspect ratio. With only `width=50` it was 50x50. Attribute or CSS size both work. Always give at least one dimension.
- A failed image load combined with no size throws `Image size cannot be determined. Please provide the width and height of the image.` (seen for `list-style-image` and `content: url()`).

### 7b. Satori fetches by itself

Yes. `src/handler/image.ts` calls `fetch(url, { redirect: 'manual' })` for any image source starting with `http`. With a fetch spy and the guard bypassed, one call each for:

- `<img src="https://...">` and `http://`
- `background-image: url(...)`, `background: url(...)`
- `mask-image: url(...)`
- `list-style-image: url(...)`
- SVG `<image href="https://...">` inside inline `<svg>`
- a rule inside a `<style>` element (`div.x{background-image:url(...)}`)
- `::before{content:url(...)}` in a `<style>` element

No fetch for `@import`, `<link rel="stylesheet">`, `@font-face`. A failed fetch is swallowed (`console.error("Can't load image ...")`) and the render continues without the image. Relative URL: `Image source must be an absolute URL: /local.png`. Private address: `Image source resolves to a blocked address (SSRF protection): http://127.0.0.1/x.png`. There is no option to disable fetching.

How the skeleton guarantees no fetch:

1. **`assertSafeVdom` in `src/render/guard.ts`, called by `renderSvg` on every render.** It rejects (`RenderInputError`) any `src`/`srcSet`/`poster`/`href`/`xlinkHref` prop that is not `data:` or `#fragment` (except `<a href>`), any CSS `url()` in any prop or style value that is not `data:`/`#`, and the same inside `<style>` text. It also checks `graphemeImages` values and wraps `loadAdditionalAsset` so a returned non-`data:` string throws. Satori only reaches `fetch` for strings starting with `http`, so this closes it. Tested: all sinks rejected, zero fetch calls for a data-only tree.
2. **Stubbing is not needed, but works as a second layer.** In real workerd `globalThis.fetch` is assignable. With `globalThis.fetch = () => Promise.reject(new Error('global fetch is disabled'))` and the guard bypassed, Satori's attempt hit the stub, logged `Can't load image https://example.com/a.png: global fetch is disabled in the render worker` and rendered without the image. If the product wants this: capture `const platformFetch = globalThis.fetch.bind(globalThis)` at module scope for its own downloads, then replace the global permanently. Do **not** swap it around a single render: renders are async and concurrent requests share the isolate. I did not enable this in the skeleton.

Also relevant: `new Function('s','return import(s)')` in Satori's DNS check throws `EvalError` in workerd and is caught; it is only on the fetch path.

### 7c. Missing glyphs, `loadAdditionalAsset`, RTL

- With only the Latin/Cyrillic/Greek fonts loaded, emoji, CJK, Arabic, Hebrew, Thai, Devanagari render as **tofu** (the `.notdef` box of the last font in the fallback chain). No crash, no error. Looked at a rendered sample: boxed-X rectangles, one per character.
- Shape (from `dist/standalone.d.ts`): `loadAdditionalAsset?: (languageCode: string, segment: string) => Promise<string | Array<FontOptions>>`, with `FontOptions = { data: Buffer | ArrayBuffer; name: string; weight?: 100..900; style?: 'normal' | 'italic'; lang?: string }`.
- Observed calls for `'Hi 😀 你好 こんにちは 안녕 مرحبا שלום → 👍'`:
  `['emoji','😀'], ['emoji','👍'], ['ja-JP|zh-CN|zh-TW|zh-HK','你好'], ['ja-JP','こんにちは'], ['ko-KR','안녕'], ['ar-AR','مرحبا'], ['he-IL','שלום'], ['symbol','→']`
  - `emoji`: one call per distinct emoji grapheme (ZWJ sequences arrive whole).
  - other codes: one call per code, with that code's unique graphemes concatenated.
  - code values (`src/language.ts`): `emoji`, `symbol`, `math`, `unknown`, or locales joined by `|` from `ja-JP, ko-KR, zh-CN, zh-TW, zh-HK, th-TH, bn-IN, ar-AR, ta-IN, ml-IN, he-IL, te-IN, devanagari, kannada`. `∑` and `℃` arrive as `symbol`, because `symbol` is tested before `math`.
- Return a string -> used as the image for that segment. Return fonts -> added to the cached font loader (they persist for later renders that use the same `fonts` array; `font.addFonts` in `src/satori.ts`).
- **Emoji as SVG data URI works**: returning `data:image/svg+xml;base64,...` for `emoji` drew the image as a font-size square (100x100 at `fontSize: 100`). `graphemeImages: { '😀': dataUri }` works too. README: "The image will be resized to the current font-size (both width and height) as a square."
- RTL: **partly supported now.** README, CSS table: "`direction` - Also set by the `dir` attribute, except for `auto`. With `rtl`, flex rows, grid columns, block boxes and lines of text start at the right. Lines with inline elements in them are aligned, but their content isn't reordered yet. `unicodeBidi` isn't supported". README, typography: "HarfBuzz also improves glyph shaping for complex scripts such as Arabic. Words are ordered with a simplified Unicode bidirectional algorithm, so right-to-left text in a left-to-right element, and left-to-right text and numbers in a right-to-left one, follow browser ordering, and lines with `direction: rtl` are laid out from the right. Explicit embeddings with `unicodeBidi`, bracket pairs and reordering text with inline elements in it aren't supported yet." Tested: `direction: rtl` and `dir="rtl"` move a line's ink from x 3-94 to x 207-298 in a 300px box. Arabic/Hebrew shaping quality was not tested (no such font bundled).

### 7d. Paint order and the watermark

`zIndex` is "Supported" in the README table, and it is. Colour at the overlap of two 100x100 absolutely positioned boxes:

| Case | On top |
| --- | --- |
| red, then blue, no z-index | blue (later sibling) |
| red `z-index:10`, then blue | red |
| red, then blue `z-index:-1` | red |
| static red sibling, then absolute blue last sibling | blue |
| absolute red **descendant** of an earlier sibling, then absolute blue last sibling | blue |
| **red descendant `z-index:9999`, then blue last sibling (z auto or `z-index:1`)** | **red** |
| same, template wrapped in `isolation: isolate` | blue |
| same, template wrapped in `position: relative; z-index: 0` | blue |
| `position: fixed; z-index: 9999` inside the isolated wrapper | blue |
| markup appended to Satori's SVG before `</svg>` | appended markup, always |

Conclusions:

- A last-sibling absolute element does paint above earlier siblings and their absolute descendants, **as long as the template uses no z-index**. A template with `z-index` beats it.
- In-tree defence: put the template inside a wrapper that is its own stacking context (`isolation: isolate`), and the watermark as a later sibling.
- Safest: stamp the watermark **after Satori**, by inserting SVG markup before the closing `</svg>` (output ends with `</svg>`; SVG has no z-index, later markup paints last). It is also immune to template CSS selectors, which matters if user `<style>` is ever passed to Satori, since a selector could otherwise target the watermark node.

### 7e. Layout rules

- **The "div needs explicit display:flex" error no longer exists** (the string is absent from `dist/`). `<div><div>a</div><div>b</div></div>` lays out as blocks: `div 300x38`, children at y 0 and 19.
- Preset styles (`src/handler/presets.ts`, modelled on Chromium's `html.css`). Elements are **inline by default**; these get presets:
  - hidden: `area base basefont datalist head link meta noembed noframes param rp script style template title`
  - `display:block`: `html address article aside details figcaption footer form header hgroup main nav search section summary div dt`
  - block with margins: `body` (margin 8), `p`, `blockquote`, `figure`, `dl`, `dd`, `ul ol menu dir` (padding-left 40), `pre` (monospace, `white-space:pre`), `hr`, `center`, `h1`-`h6` (bold; 2em/1.5em/1.17em/1em/0.83em/0.67em with their margins)
  - `li`: `list-item`; `dialog`: absolute, bordered
  - inline tweaks: `b strong` bold, `i em` italic, `u` underline, `s` line-through, `code kbd` `font-family: monospace`, `mark`, `big`, `small`
  - `input button textarea select`: `inline-block`
- Verified: `<h1>` + `<p>` at `font-size:20` give `h1@0,27 300x48`, `p@0,102 300x24` (2em, 0.67em margin, collapsed margins). `<html><body>` shifts content by 8px.
- Text plus inline children share a line: in `Hello <b>world</b>` the `<b>` starts at x=53.8; without the space at 48.2.
- Whitespace follows CSS `white-space: normal`: runs of spaces/newlines collapse; a whitespace-only text node between inline elements is one space; whitespace-only text between block children creates no line; `<pre>` keeps newlines. In a flex row the trailing space of a text item is trimmed.
- An invalid value in an **inline style** fails the whole render, e.g. `display: table`:
  `Invalid value for CSS property "display". Allowed values: "block" | "flow-root" | "list-item" | "flex" | "-webkit-flex" | "-webkit-box" | "grid" | "inline" | "inline-block" | "inline-flex" | "-webkit-inline-flex" | "inline-grid" | "contents" | "none". Received: "table".`
  With `onStyleError` the declaration is dropped and the render continues. Unknown properties (`columns`, `cursor`), unknown elements (`<foo>`), `<table>` markup and `color: notacolour` did not throw.
- `style` must be an object. A string (`style="color:red"`) is silently ignored. Kebab-case keys (`'background-color'`) work.
- `class`/`className`/`id` plus a `<style>` child work: Satori has a real stylesheet engine now (selectors, specificity, `!important`, nesting, `@media`, `::before/::after`; README "Stylesheets"). This could replace part of the planned css-select inliner; whether to rely on it is a design decision.
- `box-sizing` defaults to `content-box`: `width:100%; height:100%; padding:20` is 340x240 on a 300x200 canvas.
- Root overflow is clipped. If `height` is omitted the SVG height is the content height.

### 7f. Fonts

- **Caching**: yes. `src/satori.ts` has `fontCache = new WeakMap()` keyed by the `fonts` array identity (fast path), a second `Map` keyed by each buffer's identity + name/weight/style (max 8 loaders), and `cachedParsedFont = new WeakMap()` keyed by the data buffer (`src/font.ts`). Measured: same array 1-2 ms per render; a new array of the same buffers about 18 ms; new buffers every time about 113 ms (re-parse). Keep `FONTS` a module-level constant (README tip, issue vercel/satori#590).
- **Same family name for several subset files does NOT fall back per glyph.** `FontLoader.get()` returns one font per (name, weight, style); with identical name/weight/style the first registered wins. Test: Latin + Cyrillic files both named `X` render `Привет` as tofu, byte-identical to Latin-only; naming the second `Y` renders it.
- Therefore `src/render/fonts.ts` registers each subset under its own family (`Inter`, `Inter Latin Ext`, `Inter Cyrillic`, `Inter Greek`, `Inter Vietnamese`, `Source Serif 4`, `Source Serif 4 Latin Ext`, `JetBrains Mono`, `JetBrains Mono Latin Ext`).
- **Fallback order** = families in `fontFamily`, then every other family in registration order, per grapheme. Consequence, tested: `ł` with `font-family: "Source Serif 4"` comes from **Inter Latin Ext** (registered earlier), not the serif. The converter must expand each logical family to its full stack; `fontStack('Source Serif 4')` returns `"Source Serif 4", "Source Serif 4 Latin Ext"`.
- Generic families select nothing (README: "generic families like `serif` don't select a font"). `<code>`'s preset `monospace` rendered in Inter. Map `serif`/`sans-serif`/`monospace` explicitly.
- Missing weights are synthesised: weight 800 with only a 400 file gave 22% more ink (faux bold, `src/font.ts`: requested >= 600 and font `usWeightClass` < 600). Missing italic is skewed (seen in the smoke image: Cyrillic/Greek in the italic serif row are slanted Inter).
- Formats: README "Satori supports four font formats: TTF, OTF, WOFF and WOFF2." WOFF2 tested and working (2 fonts: 14 ms parse vs 9 ms for WOFF, 25% fewer bytes).
- Variable fonts: README "Variable fonts are rendered as their default instance, e.g. the regular weight." Not tested.
- No fonts: `No fonts are loaded. At least one font is required to calculate the layout.`

### 7g. Supported CSS (trimmed from `node_modules/satori/README.md`)

"Properties marked 'Supported' behave as in browsers; otherwise, the differences are listed."

| Property | Support |
| --- | --- |
| CSS variables | Supported |
| `display` | Supported, except `table`, `ruby`, their inner values and two-value syntax, which throw |
| `position` | Supported; positioned inline elements are not containing blocks; sticky inline not moved |
| `float`, `clear` | Supported with differences (float mid-paragraph goes to paragraph start) |
| `zIndex`, `visibility`, `opacity`, `isolation`, `mixBlendMode` | Supported |
| `color` | Modern colour syntaxes converted to rgb(); system colours unsupported |
| `margin*`, `top/right/bottom/left/inset`, `width`, `height`, `aspectRatio`, `boxSizing` | Supported |
| `min/max-width/height` | Some keywords (`fit-content`, `stretch`, ...) ignored |
| `border*`, `borderRadius*`, `cornerShape` | Supported (dotted style differs on rounded corners) |
| `outline*` | Not drawn on inline elements |
| Flex: `flexDirection flexWrap flexGrow flexShrink flexBasis alignItems alignContent alignSelf justifyContent gap order` | Supported |
| Grid: templates, areas, auto rows/cols/flow, placement, `justifyItems/Self`, `place*` | Supported, except `subgrid` (throws) and `masonry` |
| Lists: `listStyleType/Position/Image`, counters | Mostly; no `::marker`; `listStyleImage` only `url()` |
| `fontFamily` | Only fonts passed in `fonts`; generic families select nothing |
| `fontSize fontWeight fontStyle fontFeatureSettings fontKerning fontVariant*` | Supported (small caps not synthesised) |
| `direction`, `textAlign`, `textIndent`, `tabSize` | Supported with RTL limits (7c) |
| `verticalAlign` | Some keywords only on atomic inlines |
| `textTransform textShadow letterSpacing wordSpacing overflowWrap` | Supported |
| `lineHeight` | Rounded to whole pixels |
| `whiteSpace`, `wordBreak` | Supported (`break-spaces` like `pre-wrap`, `auto-phrase` like `normal`) |
| `textOverflow: ellipsis`, `lineClamp`, `textWrap: balance/pretty` | Only for text without inline elements in it |
| `textDecoration` | Per element; `textUnderlinePosition` unsupported |
| `background*` incl. `backgroundClip`, `backgroundBlendMode` | Supported, except `image-set()` and `cross-fade()` |
| `transform` (2D/3D), `transformOrigin`, `transformStyle`, `backfaceVisibility` | Supported; perspective approximated |
| `objectFit`, `objectPosition` | Supported |
| `boxShadow` | Supported (very expensive, 7i) |
| `overflow*`, `overflowClipMargin` | Supported; no scrollbars |
| `filter` | Supported; `url()` only for SVG filters in the document |
| `backdropFilter` | Supported except `url()` |
| `clipPath` | Supported except `url()` and geometry boxes |
| `mask*` | Supported; `maskMode` unsupported |
| `WebkitTextStroke*`, `WebkitTextFillColor`, `paintOrder` | Supported |

Notable unsupported or ignored (README notes): `display: table`/`ruby`; `columns`, `writingMode`, `fontStretch` ("Properties that aren't listed are ignored"); `@font-face`, `@keyframes`, `@scope`, `@import` ignored; `::marker`, `::first-line`; interaction pseudo-classes never match; percentages inside `calc()` only in sizes/margins/paddings/insets/gaps/flex-basis/translations; `unicodeBidi`; `inherit` on non-inherited properties resets to initial; external `<link>`/`<script>` not loaded. "Invalid values in inline styles throw an error, which fails the whole render, unless they're ignored with `onStyleError`."

### 7h. htmlparser2 + css-select in workerd

Works. `tests/html-parsing.test.ts` runs `parseDocument`, `selectOne`/`selectAll`/`is`, `css-what`'s `parse` and `domutils` helpers inside the pool. A separate worker importing them ran under `wrangler dev` without `nodejs_compat` and bundled to 182.50 KiB / gzip 48.46 KiB with zero `node:` imports.

Things the converter must handle:

- HTML mode lower-cases **attribute** names (`viewBox` -> `viewbox`, `gradientUnits` -> `gradientunits`) but keeps SVG **tag** case (`linearGradient`, `foreignObject`). `parseDocument(html, { lowerCaseAttributeNames: false })` keeps attribute case. Satori accepted a lower-case `viewbox` on the root `<svg>`; other camelCase SVG attributes were not tested in lower case.
- Inline `style="..."` strings must be parsed into objects (7e).

### 7i. Large inputs and pathological CSS (resvg+PNG time unless stated; 1200x630; local)

Tree size (flex boxes each containing a short text):

| Input | satori | resvg + PNG | SVG size |
| --- | --- | --- | --- |
| 100 nodes | 19-26 ms | 30 ms | 148 KB |
| 500 nodes | 66-100 ms | 57-60 ms | 984 KB |
| 2000 nodes | 312-388 ms | 182-225 ms | 4.4 MB |
| 5000 nodes | 757-787 ms | ~200 ms (off-canvas nodes are culled) | 4.4 MB |
| 22,800 characters of 12px text | 143-204 ms | 306-311 ms | 4.5 MB |
| nesting depth 50 / 200 | 5 / 13 ms | 20 ms | |
| nesting depth 1000 | `RangeError: Maximum call stack size exceeded` | | |

One `box-shadow: 0 8px <blur> rgba(0,0,0,.4)` on one element:

| Blur | 200x120 element | 1000x500 element |
| --- | --- | --- |
| 0 | ~25-50 ms | 187 ms |
| 8px | 25 ms | 281 ms |
| 16px | 48 ms | 359 ms |
| 24px | 103 ms | 506 ms |
| 32px | 225 ms | 747 ms |
| 40px | 481 ms | 1165 ms |
| 48px | 832 ms | 1684 ms |
| 64px | 2264 ms | 3471 ms |
| 100px | 7.6 s | |
| 150px | 19.2 s | |
| 200px | **`RuntimeError: unreachable` after 15.8 s** (wasm trap; later renders in the same isolate still worked) | |
| 300-1000px | ~3.3-3.6 s, no error (shadow correctness not checked) | |

Cause (`src/builder/shadow.ts`): the SVG filter region grows by `blurRadius^2 / 4` px on each side (blur 200 -> 10,000 px), and resvg rasterises the whole region. The source carries the comment "It seems that SVG filters are pretty expensive for resvg".

Other effects:

| CSS | Cost |
| --- | --- |
| `text-shadow` on a 96px headline, blur 0 / 8 / 16 / 24 / 32 px | 38 / 61 / 113 / 275 / 463 ms |
| `text-shadow: 0 0 100px` on a 120px word | 8.5 s |
| `box-shadow` with 10 layers of 50px blur | 9.6 s |
| `box-shadow: inset 0 0 100px` | 7.6 s |
| 12 elements each with a 20px-blur shadow | 749 ms |
| `filter: blur(2..40px)` on one 400x300 element | 242-387 ms each (region is the whole canvas) |
| `filter: blur(10px)` on 12 elements | 2.9 s |
| `filter: blur(1000px)` | 3.6 s |
| `filter: drop-shadow(...)` blur 2..40px | 440-638 ms each |
| `backdrop-filter: blur(2..40px)` | 45-100 ms each; 12 elements 449 ms |
| 100,000px element with a shadow | 1.6 s |
| `conic-gradient` full canvas | 185 ms |
| huge `border-radius`, dashed thick borders, `opacity`/`mix-blend-mode` x12, 1px repeating gradients, 5000px font size | 19-100 ms (harmless) |

Caps I recommend (numbers are provisional; the first two are already enforced by `guard.ts`):

- nodes <= 3000, depth <= 100;
- total text length (e.g. <= 5,000 characters);
- `box-shadow` / `text-shadow` blur <= 24-32px, at most a few shadowed elements, at most 2-3 layers per element, no huge spread;
- `filter` / `backdrop-filter`: blur <= 40px and a small count (each costs 0.05-0.6 s);
- reject absurd lengths (element or font sizes in the tens of thousands of px).

A synchronous wasm render cannot be interrupted from inside the isolate, so validation before rendering is the only in-process defence.

Possible optimisation, proof of concept only (`tests/probes/d.probe.ts`): rewriting Satori's `<filter id="satori_s-...">` region to `filterUnits="userSpaceOnUse"` covering the canvas plus 3 sigma gave **pixel-identical** output and cut blur 60px from 2147 to 622 ms and blur 100px from 7240 to 736 ms. It is only valid for elements without transforms and is not implemented in the engine.

### 7j. Inline `<svg>` children

Supported: `<svg>` VDOM nodes are serialised and embedded as a nested `data:image/svg+xml` `<image>`.

- Work: basic shapes and paths, kebab-case (`stroke-width`) and camelCase (`strokeWidth`) attributes, `currentColor`, `<defs>`/`linearGradient`/`<use>`, `style` objects on children, classes styled from a `<style>` element, CSS size on the `<svg>`.
- No `width`/`height`, only `viewBox`: fills the container width (same rule as `<img>`).
- `<text>` inside `<svg>` **throws and fails the render**: `<text> nodes are not currently supported, please convert them to <path>`.
- `<foreignObject>` content: nothing drawn, no error.
- Raster `<image href="data:image/png...">` inside inline `<svg>`: nothing drawn, no error. Put raster images in HTML `<img>` instead.
- Inline SVG is passed through verbatim, including `<script>` and `onclick` (seen in the output as `%3Cscript%3Ealert(1)%3C/script%3E`). Harmless once rasterised; never serve Satori's SVG output to browsers.

## 8. What did not work

- `satori/standalone` used as its README describes (init with `layout.wasm` only): three failures, section 2.1.
- The default `satori` entry: by inspection of `dist/index.js` it inlines both `hb.wasm` and `layout.wasm` as base64, so it has the same problem twice. Not executed.
- `@cloudflare/vitest-pool-workers@0.23.0` with a current compatibility date.
- `npm install` of vitest 4 on npm 10.9.9.
- Trusting the vitest pool as proof of "works in workerd" (pitfall 4).
- WebP as an input image; `<text>`, `<foreignObject>` and raster `<image>` inside inline SVG.
- Several font files under one family name.
- `box-shadow` blur around 200px (resvg trap), nesting depth 1000 (stack overflow).
- A plain last-sibling watermark against a template that uses `z-index`.

## 9. Unverified

- **Anything on Cloudflare's network.** Nothing was deployed. Production CPU time per render, production startup time and behaviour under the real CPU limiter are unknown. `wrangler check startup` reported 113.8 ms active locally and itself warns the number does not transfer.
- **Memory.** Peak wasm memory per render versus the 128 MB isolate limit was not measured. The blur-200 trap is probably an allocation failure for a ~20,000 x 20,000 px filter region; that is an inference.
- State of the resvg instance after a wasm trap: one later render succeeded; leaks or corruption over time not studied.
- Long-run stability: no soak test (a few hundred renders at most per isolate).
- Variable fonts (README claim only). Arabic/Hebrew shaping and bidi quality (no such fonts bundled). Colour-font emoji. APNG, animated GIF, AVIF inputs. Lower-cased camelCase SVG attributes other than `viewbox`.
- `loadAdditionalAsset` code for scripts outside Satori's table (Cyrillic, Greek) when uncovered: `unknown` according to `src/language.ts`; not observed, since those fonts are bundled.
- `satori@0.32.0` as a fallback: identified from npm metadata only, not run.
- Whether the shim survives the next satori release. 64 versions were published from 0.33.0 to 0.63.2.
- Whether a Worker CPU limit can be lowered in configuration to cap a runaway render (the limits page only describes raising it).
- An in-engine version of the filter-region optimisation (7i) for transformed elements.

## 10. What is left in the repo

```
linktocard/
  package.json, package-lock.json, tsconfig.json, wrangler.toml, vitest.config.ts, .gitignore
  scripts/smoke.mjs                      real-workerd smoke + benchmark
  src/index.ts                           Hono app: /, /spike.png|jpg|webp (?w=&h=&title=)
  src/render/engine.ts                   pipeline, one-time init, public API
  src/render/satori-workerd-shim.ts      the three workerd patches for Satori's HarfBuzz
  src/render/wasm/emscripten-adapter-vi.wasm   34-byte precompiled adapter
  src/render/guard.ts                    data-URI-only + node/depth limits
  src/render/fonts.ts                    30 imports, FONTS, FONT_STACKS, fontStack()
  src/render/fonts/*.woff, LICENSES/*.txt
  src/render/sample-card.ts              card used by tests and smoke
  src/types/assets.d.ts
  tests/spike.test.ts                    the tests the brief asked for (9)
  tests/satori-behaviour.test.ts         characterisation of section 7 (28)
  tests/html-parsing.test.ts             7h (3)
  tests/helpers.ts
  tests/probes/*.probe.ts                slow exploration, `npm run probes`
```

Checks at hand-off: `npm test` 40/40 passed; `npm run typecheck` clean; `npm run smoke` OK; `node_modules` installed (444 MB).

Outputs in the scratchpad: `spike.png`, `spike.jpg`, `spike.webp` (smoke outputs; I viewed the PNG and JPEG), `tofu.png` (missing-glyph sample), `dry/` (dry-run bundle), `dry-meta.json` (esbuild metafile), `worker-startup.cpuprofile`, `probes-full.log`.

Git: I did not commit or push. However, the branch `claude/link-to-card-mvp-a5yy3s` has a commit `491755f` "WIP: scaffold Link To Card project skeleton" made at 19:48:11 UTC, mid-spike, by something else in this session, and `origin` points at it. It is an early snapshot: it predates the shim, the guard, the plugin switch and all tests but the first, and does not work. The working tree is the real result and is uncommitted.

## 11. Sources

- Installed packages read directly: `node_modules/satori/{package.json,README.md,dist/*.d.ts,dist/standalone.js,dist/standalone.js.map}` (TypeScript sources recovered from the source map: `src/satori.ts`, `src/font.ts`, `src/harfbuzz.ts`, `src/language.ts`, `src/handler/{image,url-safety,presets,preprocess}.ts`, `src/builder/{shadow,backdrop-filter}.ts`, `src/layout.ts`, `src/layout-engine/wasm*.ts`), `node_modules/harfbuzzjs/{hb.wasm,hbjs.js,index.js}`, `node_modules/@resvg/resvg-wasm/{index.mjs,index.d.ts}`, `node_modules/@jsquash/{jpeg,webp}/{encode.js,utils.js,meta.js,README.md,codec/}`, `node_modules/@cloudflare/vitest-pool-workers/{README.md,package.json,dist/pool/index.d.mts}`, `@cloudflare/vitest-plugin@1.9.0` tarball (`npm pack`).
- npm registry: `npm view <pkg> version|dist-tags|time|dependencies|peerDependencies|deprecated`.
- https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/platform/limits.mdx (CPU 10 ms Free / 5 min Paid, default 30 s; memory 128 MB; Worker size 64 MiB uncompressed; startup 1 second)
- https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/runtime-apis/web-standards.mdx ("not allowed: `eval()`, `new Function`, `WebAssembly.compile`, `WebAssembly.compileStreaming`, `WebAssembly.instantiate` with a buffer parameter, `WebAssembly.instantiateStreaming`")
- https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/runtime-apis/performance.mdx (timers advance only after I/O when deployed; they advance normally in local dev)
- https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/workers/wrangler/bundling.mdx (`.wasm` imports are `WebAssembly.Module` by default)
- https://raw.githubusercontent.com/jamsinclair/jSquash/main/README.md and `.../examples/cloudflare-worker-esm-format/{src/index.js,README.md}` (manual wasm init, `webp_enc_simd.wasm`)
- Commands run: `npx vitest run`, `PROBES=1 npx vitest run --silent=false`, `node scripts/smoke.mjs [--bench]`, `npx wrangler dev --port 8799`, `npx wrangler deploy --dry-run --outdir ... [--metafile ...] [--minify]`, `npx wrangler check startup`, `npx tsc --noEmit`.

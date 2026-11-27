#!/usr/bin/env node
// Real-runtime smoke test: the whole product over HTTP against `wrangler dev`.
//
// The vitest pool is not the real runtime (it force-enables nodejs_compat, allows eval and
// never goes through static-asset routing), so this script is the proof that the Worker
// boots in plain workerd, that pages are served as static assets without reaching the
// Worker, and that sign-in -> API key -> render -> cache -> signed URL -> usage hold end to end.
//
//   npm run smoke          builds the site, uses a fresh throw-away D1/R2 directory,
//                          starts wrangler dev on port 8799, prints one line per check,
//                          stops the server it started and exits non-zero on the first failure.
//
// wrangler dev is started three times, one after another, on the same port and data directory:
//   1. as configured (every build v3 switch "true", as in wrangler.toml's top-level [vars]);
//   2. with APP_URL on an https origin, so a card can be made from one of the Worker's own
//      static pages (the inspector reads its own site from the static assets, as in production);
//   3. with the four build v3 switches "false", as in production: every new route answers 503.
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8799
const base = `http://127.0.0.1:${PORT}`
const wranglerBin = path.join(root, 'node_modules/wrangler/bin/wrangler.js')
// Local-only values, passed with --var so the run never depends on (or sends mail with) a developer's .dev.vars.
const VARS = {
  APP_URL: base,
  SIGNING_MASTER_SECRET: 'smoke-master-secret-not-a-real-secret',
  PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_smoke_not_a_real_secret',
  RESEND_API_KEY: '',
}
const TOOL_ENV = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }

const PAGES = ['/', '/pricing', '/terms', '/privacy', '/refund', '/contact', '/login', '/dashboard']
const PADDLE_SENTENCE = 'Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders.'
const FORMATS = [
  { format: 'png', type: 'image/png', valid: (b) => isPng(b) },
  { format: 'jpeg', type: 'image/jpeg', valid: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { format: 'webp', type: 'image/webp', valid: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
]

const isPng = (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const pngSize = (b) => `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`

let passed = 0
/** One line per check; the first failure ends the run. */
function check(label, condition, detail = '') {
  if (!condition) throw new Error(`${label}${detail ? `: ${detail}` : ''}`)
  passed += 1
  console.log(`ok   ${label}`)
}

function runTool(label, command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...TOOL_ENV, ...env }, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${label} failed:\n${result.stdout}\n${result.stderr}`)
}

async function listening() {
  try {
    await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

async function startServer(persistDir, overrides = {}) {
  const vars = Object.entries({ ...VARS, ...overrides }).flatMap(([name, value]) => ['--var', `${name}:${value}`])
  const child = spawn(process.execPath, [wranglerBin, 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persistDir, ...vars], {
    cwd: root,
    detached: true, // own process group, so workerd is stopped together with wrangler
    stdio: ['ignore', 'pipe', 'pipe'],
    env: TOOL_ENV,
  })
  let log = ''
  child.stdout.on('data', (chunk) => (log += chunk))
  child.stderr.on('data', (chunk) => (log += chunk))
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', resolve)
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        resolve()
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }, 3000).unref()
    })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`)
    if (await listening()) return { stop, log: () => log }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await stop()
  throw new Error(`wrangler dev did not become ready:\n${log}`)
}

/** One HTTP exchange; redirects are never followed so a page that redirects fails its check. */
async function http(method, pathOrUrl, { headers = {}, json, body } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${base}${pathOrUrl}`
  const started = performance.now()
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: { ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: json === undefined ? body : JSON.stringify(json),
  })
  const bytes = Buffer.from(await res.arrayBuffer())
  return {
    res,
    status: res.status,
    bytes,
    ms: performance.now() - started,
    text: () => bytes.toString('utf8'),
    json: () => JSON.parse(bytes.toString('utf8')),
    brief: () => `${res.status} ${bytes.toString('utf8').slice(0, 200)}`,
  }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

/** A blank one-page PDF, base64, for the PDF toolkit check. */
async function onePagePdfBase64() {
  const { PDFDocument } = await import('@cantoo/pdf-lib')
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  return Buffer.from(await doc.save({ useObjectStreams: false })).toString('base64')
}

/** A file of tests/fixtures/pdftools (the toolkit's own test fixtures), base64. */
const fixture = (name) => readFileSync(path.join(root, 'tests/fixtures/pdftools', name)).toString('base64')

/** Pages of a PDF, read with the same library the Worker uses; null when it does not load. */
async function pdfPages(bytes) {
  const { PDFDocument } = await import('@cantoo/pdf-lib')
  try {
    return (await PDFDocument.load(bytes)).getPageCount()
  } catch {
    return null
  }
}

const isPdf = (b) => b.subarray(0, 5).toString('latin1') === '%PDF-'
/** Toolkit units for an output of this many pages (src/config.ts PDF_TOOLKIT.pagesPerUnit is 10). */
const toolkitUnits = (pages) => Math.max(1, Math.ceil(pages / 10))

/** How a customer signs a link-card URL (docs/link-cards.md): HMAC-SHA256 of path, names, name=value lines. */
function signLinkUrl(origin, siteId, siteSecret, template, params) {
  const pathname = `/v1/link/${siteId}/${template}`
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const canonical = [pathname, entries.map(([name]) => name).join(','), ...entries.map(([name, value]) => `${name}=${value}`)].join('\n')
  const sig = createHmac('sha256', siteSecret).update(canonical).digest('hex')
  return `${origin}${pathname}?${new URLSearchParams([...entries, ['sig', sig]])}`
}

/** A fresh Free account: session cookie, API key header and one site. `origin` is sent as Origin (null: none). */
async function newAccount(label, origin) {
  const headers = origin ? { origin } : {}
  const email = `smoke-${label}-${Date.now()}@example.com`
  const link = await http('POST', '/auth/magic-link', { headers, json: { email } })
  const devLink = link.status === 200 ? link.json().dev_link : undefined
  if (typeof devLink !== 'string') throw new Error(`${label}: sign-in link: ${link.brief()}`)
  const verify = await http('POST', '/auth/verify', { headers, json: { token: new URL(devLink).searchParams.get('token') } })
  const cookie = verify.res.headers.getSetCookie().map((value) => value.split(';')[0]).find((pair) => pair.startsWith('ltc_session='))
  if (verify.status !== 200 || !cookie) throw new Error(`${label}: sign-in: ${verify.brief()}`)
  const session = { ...headers, cookie }
  const createdKey = await http('POST', '/api/keys', { headers: session, json: { name: `smoke ${label}` } })
  if (createdKey.status !== 201) throw new Error(`${label}: API key: ${createdKey.brief()}`)
  const site = await http('POST', '/api/sites', { headers: session, json: { name: `smoke ${label}` } })
  if (site.status !== 201) throw new Error(`${label}: site: ${site.brief()}`)
  const auth = { authorization: `Bearer ${createdKey.json().secret}` }
  return {
    session,
    auth,
    siteId: site.json().site.id,
    siteSecret: site.json().secret,
    usage: async () => (await http('GET', '/v1/usage', { headers: auth })).json().used,
  }
}

async function smoke() {
  /* ---- static site: served as assets, the Worker is not involved ---- */
  for (const page of PAGES) {
    const r = await http('GET', page)
    const html = r.res.headers.get('content-type')?.startsWith('text/html') === true
    check(`GET ${page} -> 200 html, no redirect, no cookie`, r.status === 200 && html && r.res.headers.getSetCookie().length === 0, r.brief())
    if (page === '/terms') check('/terms carries the Paddle Merchant of Record sentence, verbatim', r.text().includes(PADDLE_SENTENCE))
    if (page === '/refund') {
      const text = r.text().replace(/<[^>]+>/g, '')
      check('/refund states the 30-day window', /within\s+30 days/i.test(text))
    }
  }

  /* ---- Worker: health and the playground ---- */
  const health = await http('GET', '/healthz')
  check('GET /healthz -> {"ok":true}', health.status === 200 && health.json().ok === true, health.brief())
  check('Worker responses carry X-Request-Id and nosniff', Boolean(health.res.headers.get('x-request-id')) && health.res.headers.get('x-content-type-options') === 'nosniff')

  const playground = await http('GET', '/playground/card.png?template=blog&title=Smoke%20test&author=wrangler%20dev')
  check('playground card is a valid 1200x630 PNG', playground.status === 200 && isPng(playground.bytes) && pngSize(playground.bytes) === '1200x630', playground.brief())

  /* ---- sign in with the development link ---- */
  const origin = { origin: base }
  const email = `smoke-${Date.now()}@example.com`
  const link = await http('POST', '/auth/magic-link', { headers: origin, json: { email } })
  const devLink = link.status === 200 ? link.json().dev_link : undefined
  check('POST /auth/magic-link returns dev_link in development', typeof devLink === 'string', link.brief())
  const token = new URL(devLink).searchParams.get('token')
  const verify = await http('POST', '/auth/verify', { headers: origin, json: { token } })
  const cookie = verify.res.headers.getSetCookie().map((value) => value.split(';')[0]).find((pair) => pair.startsWith('ltc_session='))
  check('POST /auth/verify sets the session cookie', verify.status === 200 && Boolean(cookie), verify.brief())
  const session = { ...origin, cookie }
  const me = await http('GET', '/api/me', { headers: session })
  check('GET /api/me knows the new Free account', me.status === 200 && me.json().user.email === email && me.json().user.plan === 'free', me.brief())

  /* ---- API key and POST /v1/images ---- */
  const createdKey = await http('POST', '/api/keys', { headers: session, json: { name: 'smoke' } })
  check('POST /api/keys creates an API key', createdKey.status === 201 && createdKey.json().secret.startsWith('ltc_'), createdKey.brief())
  const { key, secret } = createdKey.json()
  const auth = { authorization: `Bearer ${secret}` }
  const usage = async () => (await http('GET', '/v1/usage', { headers: auth })).json().used
  let uniqueRenders = 0

  const jsonCard = (format) => ({ template: 'blog', format, data: { title: `Smoke ${format} via JSON`, author: 'smoke.mjs' } })
  const binaryCard = (format) => ({ template: 'dark', format, response: 'binary', data: { title: `Smoke ${format} as bytes` } })
  for (const { format, type, valid } of FORMATS) {
    const rendered = await http('POST', '/v1/images', { headers: auth, json: jsonCard(format) })
    const image = rendered.status === 200 ? rendered.json() : {}
    check(`POST /v1/images ${format} (json) -> rendered 1200x630, not cached`, image.cached === false && image.width === 1200 && image.height === 630, rendered.brief())
    uniqueRenders += 1
    const fetched = await http('GET', image.url)
    check(`GET the returned url -> ${type}`, fetched.status === 200 && fetched.res.headers.get('content-type') === type && valid(fetched.bytes) && fetched.bytes.length === image.bytes, `${fetched.status}`)

    const binary = await http('POST', '/v1/images', { headers: auth, json: binaryCard(format) })
    check(`POST /v1/images ${format} (binary) -> ${type} bytes`, binary.status === 200 && binary.res.headers.get('content-type') === type && valid(binary.bytes) && binary.res.headers.get('x-ltc-cache') === 'miss', binary.brief())
    uniqueRenders += 1
  }
  const usedAfterRenders = await usage()
  for (const { format } of FORMATS) {
    const again = await http('POST', '/v1/images', { headers: auth, json: jsonCard(format) })
    const binaryAgain = await http('POST', '/v1/images', { headers: auth, json: binaryCard(format) })
    check(`repeat ${format} -> cached`, again.json().cached === true && binaryAgain.res.headers.get('x-ltc-cache') === 'hit', again.brief())
  }
  check('repeats left usage unchanged', (await usage()) === usedAfterRenders && usedAfterRenders === uniqueRenders, `used ${await usage()}, expected ${uniqueRenders}`)

  // An inline template, so the check does not depend on which fields a starter template shows.
  const emojiCard = { html: '<div style="display: flex; font-size: 72px; padding: 80px">{{title}}</div>', data: { title: 'Emoji from static assets \u{1F680}\u{2728}' } }
  const emoji = await http('POST', '/v1/images', { headers: auth, json: emojiCard })
  const emojiWarnings = emoji.status === 200 ? emoji.json().warnings : ['request failed']
  check('a title with emoji renders with no emoji warning (/_emoji through the assets binding)', emoji.status === 200 && !emojiWarnings.some((warning) => /emoji/i.test(warning)), emoji.brief())
  uniqueRenders += 1

  /* ---- site, signer, signed URL ---- */
  const site = await http('POST', '/api/sites', { headers: session, json: { name: 'smoke site' } })
  check('POST /api/sites creates a site with a secret', site.status === 201 && site.json().secret.startsWith('ltcs_'), site.brief())
  const signed = await http('POST', '/api/sign', { headers: session, json: { site_id: site.json().site.id, template: 'blog', data: { title: 'Signed by the smoke test', author: 'smoke.mjs' } } })
  const signedUrl = signed.status === 200 ? signed.json().url : ''
  check('POST /api/sign returns a signed URL and meta tags', signedUrl.startsWith(`${base}/v1/og/`) && signed.json().meta_tags.includes('og:image'), signed.brief())

  const head = await http('HEAD', signedUrl)
  check('HEAD on the signed URL renders nothing', head.status === 200 && head.bytes.length === 0 && (await usage()) === uniqueRenders, head.brief())
  const card = await http('GET', signedUrl)
  const cacheable = /^public, max-age=[1-9]\d*$/.test(card.res.headers.get('cache-control') ?? '') && /^"[0-9a-f]{64}"$/.test(card.res.headers.get('etag') ?? '')
  check('GET signed URL -> 200 PNG with Cache-Control and ETag', card.status === 200 && isPng(card.bytes) && pngSize(card.bytes) === '1200x630' && cacheable && card.res.headers.get('x-ltc-cache') === 'miss', card.brief())
  uniqueRenders += 1
  const cardAgain = await http('GET', signedUrl)
  check('GET signed URL again -> cache hit', cardAgain.status === 200 && cardAgain.res.headers.get('x-ltc-cache') === 'hit' && cardAgain.bytes.equals(card.bytes), cardAgain.brief())
  const notModified = await http('GET', signedUrl, { headers: { 'if-none-match': card.res.headers.get('etag') } })
  check('If-None-Match -> 304', notModified.status === 304 && notModified.bytes.length === 0, `${notModified.status}`)
  const tampered = await http('GET', signedUrl.replace(/sig=([0-9a-f])/, (_, digit) => `sig=${digit === '0' ? '1' : '0'}`))
  check('tampered sig -> 403 invalid_signature', tampered.status === 403 && tampered.json().error.code === 'invalid_signature', tampered.brief())

  check('usage equals the number of unique renders', (await usage()) === uniqueRenders, `used ${await usage()}, expected ${uniqueRenders}`)

  /* ---- build v3 (wrangler dev reads the top-level [vars]: every v3 kill switch is "true") ---- */
  const emailSigned = await http('POST', '/api/sign', { headers: session, json: { site_id: site.json().site.id, template: 'email-banner', size: 'email', data: { title: 'Smoke banner', greeting: 'Hi', name_default: 'there' }, open: ['name'] } })
  const emailUrl = emailSigned.status === 200 ? emailSigned.json().url : ''
  check('POST /api/sign with open fields -> a URL ending in &name=', emailUrl.startsWith(`${base}/v1/og/`) && emailUrl.endsWith('&name=') && emailUrl.includes('size=email'), emailSigned.brief())
  const emailCard = await http('GET', `${emailUrl}Maya`)
  check('the open-field URL with a value -> 1200x400 PNG (size preset "email")', emailCard.status === 200 && isPng(emailCard.bytes) && pngSize(emailCard.bytes) === '1200x400', emailCard.brief())
  uniqueRenders += 1
  // Charge once (owner decision of 2026-11-27): the first open is counted, repeat opens are not.
  const emailHeader = (r, name) => r.res.headers.get(name)
  check('the first open -> x-ltc-cache miss, x-ltc-credits-used 1', emailHeader(emailCard, 'x-ltc-cache') === 'miss' && emailHeader(emailCard, 'x-ltc-credits-used') === '1', `${emailHeader(emailCard, 'x-ltc-cache')} ${emailHeader(emailCard, 'x-ltc-credits-used')}`)
  const repeatOpens = []
  for (let n = 0; n < 3; n++) repeatOpens.push(await http('GET', `${emailUrl}Maya`))
  check(
    'three repeat opens -> the same PNG, x-ltc-cache hit, x-ltc-credits-used 0',
    repeatOpens.every((r) => r.status === 200 && r.bytes.equals(emailCard.bytes) && emailHeader(r, 'x-ltc-cache') === 'hit' && emailHeader(r, 'x-ltc-credits-used') === '0'),
    repeatOpens.map((r) => `${r.status} ${emailHeader(r, 'x-ltc-cache')} ${emailHeader(r, 'x-ltc-credits-used')}`).join(', '),
  )
  check('the repeat opens counted nothing', (await usage()) === uniqueRenders, `used ${await usage()}, expected ${uniqueRenders}`)
  // The five social starter templates refuse the email size (1200x400) on the server (owner decision of 2026-11-27).
  const sizeRefused = (r) => r.status === 400 && r.json().error.code === 'invalid_request' && r.json().error.details?.reason === 'size_not_supported' && JSON.stringify(r.json().error.details?.supported_sizes) === '["og","square","portrait"]'
  const blogEmail = await http('POST', '/v1/images', { headers: auth, json: { template: 'blog', size: 'email', data: { title: 'Too wide' } } })
  check('POST /v1/images blog with size email -> 400 size_not_supported', sizeRefused(blogEmail), blogEmail.brief())
  const quoteWide = await http('POST', '/v1/images', { headers: auth, json: { template: 'quote', width: 1200, height: 400, data: { title: 'Too wide' } } })
  check('POST /v1/images quote at width 1200, height 400 -> 400 size_not_supported', sizeRefused(quoteWide), quoteWide.brief())
  const signWide = await http('POST', '/api/sign', { headers: session, json: { site_id: site.json().site.id, template: 'launch', size: 'email', data: { title: 'Too wide' } } })
  check('POST /api/sign launch with size email -> 400 size_not_supported', sizeRefused(signWide), signWide.brief())
  const inlineWide = await http('POST', '/v1/images', { headers: auth, json: { html: '<div style="display: flex; font-size: 64px; padding: 60px">{{title}}</div>', size: 'email', data: { title: 'Inline HTML at the email size' } } })
  check('POST /v1/images inline HTML with size email -> rendered 1200x400', inlineWide.status === 200 && inlineWide.json().width === 1200 && inlineWide.json().height === 400, inlineWide.brief())
  if (inlineWide.status === 200) uniqueRenders += 1
  const certificatePage = await http('GET', '/v/crt_00000000000000000000')
  const verifyCsp = certificatePage.res.headers.get('content-security-policy') ?? ''
  check('GET /v/{unknown id} -> 404 HTML, noindex, with its own CSP', certificatePage.status === 404 && certificatePage.res.headers.get('content-type')?.startsWith('text/html') === true && certificatePage.res.headers.get('x-robots-tag') === 'noindex' && verifyCsp.includes("default-src 'none'"), certificatePage.brief())
  const certificateJson = await http('GET', '/v/crt_00000000000000000000.json')
  check('GET /v/{unknown id}.json -> JSON 404', certificateJson.status === 404 && certificateJson.json().error.code === 'not_found', certificateJson.brief())
  const linkCard = await http('GET', `/v1/link/${site.json().site.id}/blog.png?url=${encodeURIComponent('https://example.com/')}&sig=${'0'.repeat(64)}`)
  check('GET /v1/link/... with a wrong signature -> 403 invalid_signature (nothing fetched)', linkCard.status === 403 && linkCard.json().error.code === 'invalid_signature', linkCard.brief())
  const notInBuild = (r, message) => r.status === 503 && r.json().error.code === 'not_configured' && r.json().error.message === message
  const batches = await http('POST', '/v1/batches', { headers: auth, json: { template: 'certificate', rows: [{}] } })
  // Bulk documents are on in wrangler dev, but they also need PDF rendering, which has no Browser Run binding here.
  check('POST /v1/batches -> 503 not_configured (needs PDF rendering)', notInBuild(batches, 'PDF rendering is not enabled yet.'), batches.brief())
  const toolkitEmpty = await http('POST', '/v1/pdf-tools/merge', { headers: auth, json: { files: [] } })
  check('POST /v1/pdf-tools/merge without files -> 400 invalid_request (toolkit on, nothing counted)', toolkitEmpty.status === 400 && toolkitEmpty.json().error.code === 'invalid_request', toolkitEmpty.brief())
  check('usage counts the one email image', (await usage()) === uniqueRenders, `used ${await usage()}, expected ${uniqueRenders}`)
  // The toolkit needs no browser: pdf-lib runs in plain workerd. Binary, because GET /i/....pdf needs PDF rendering on.
  const onePage = await onePagePdfBase64()
  const merged = await http('POST', '/v1/pdf-tools/merge', { headers: auth, json: { files: [{ base64: onePage }, { base64: onePage }], response: 'binary' } })
  if (merged.status === 200) uniqueRenders += 1
  const mergedHeaders = (name) => merged.res.headers.get(name)
  check(
    'POST /v1/pdf-tools/merge of two one-page PDFs -> a 2-page PDF, 1 image',
    merged.status === 200 && mergedHeaders('content-type') === 'application/pdf' && merged.bytes.subarray(0, 5).toString('latin1') === '%PDF-' && mergedHeaders('x-ltc-pages') === '2' && mergedHeaders('x-ltc-credits-used') === '1' && /\/i\/u_[^/]+\/[0-9a-f]{64}\.pdf$/.test(mergedHeaders('x-ltc-pdf-url') ?? ''),
    merged.brief(),
  )
  check('usage counts the toolkit result', (await usage()) === uniqueRenders, `used ${await usage()}, expected ${uniqueRenders}`)

  // The toolkit on its own test fixtures: a merge kept on the account (JSON), a text stamp on that
  // result by pdf_id, an image stamp, and the free "fields" listing of a form.
  const multiPage = fixture('multi-page.pdf')
  const rotated = fixture('rotated.pdf')
  const fixturePages = (await pdfPages(Buffer.from(multiPage, 'base64'))) + (await pdfPages(Buffer.from(rotated, 'base64')))
  const fixtureMerge = await http('POST', '/v1/pdf-tools/merge', { headers: auth, json: { files: [{ base64: multiPage }, { base64: rotated }], filename: 'smoke-merge.pdf' } })
  const mergeResult = fixtureMerge.status === 200 ? fixtureMerge.json() : {}
  check(
    `merge of multi-page.pdf and rotated.pdf (JSON) -> ${fixturePages} pages, ${toolkitUnits(fixturePages)} image(s), stored with an id`,
    mergeResult.op === 'merge' && mergeResult.pages === fixturePages && mergeResult.credits_used === toolkitUnits(fixturePages) && /^[0-9a-f]{64}$/.test(mergeResult.id ?? '') && mergeResult.filename === 'smoke-merge.pdf',
    fixtureMerge.brief(),
  )
  uniqueRenders += mergeResult.credits_used ?? 0
  const textStamp = await http('POST', '/v1/pdf-tools/stamp', { headers: auth, json: { files: [{ pdf_id: mergeResult.id }], text: 'PAID', color: '#15803d', rotation: 30, opacity: 0.3, response: 'binary' } })
  const textStampPages = textStamp.status === 200 ? await pdfPages(textStamp.bytes) : null
  check(
    `stamp "PAID" on the merged result by pdf_id (binary) -> a valid ${fixturePages}-page PDF, ${toolkitUnits(fixturePages)} image(s)`,
    textStamp.status === 200 && isPdf(textStamp.bytes) && textStampPages === fixturePages && textStamp.res.headers.get('x-ltc-pages') === String(fixturePages) && textStamp.res.headers.get('x-ltc-credits-used') === String(toolkitUnits(fixturePages)),
    textStamp.brief(),
  )
  uniqueRenders += Number(textStamp.res.headers.get('x-ltc-credits-used') ?? 0)
  const rotatedPages = await pdfPages(Buffer.from(rotated, 'base64'))
  const imageStamp = await http('POST', '/v1/pdf-tools/stamp', { headers: auth, json: { files: [{ base64: rotated }], image: { base64: fixture('logo.png') }, width: 48, position: 'top-right', pages: '1', response: 'binary' } })
  check(
    `stamp logo.png on page 1 of rotated.pdf (binary) -> a valid ${rotatedPages}-page PDF`,
    imageStamp.status === 200 && isPdf(imageStamp.bytes) && (await pdfPages(imageStamp.bytes)) === rotatedPages && imageStamp.res.headers.get('x-ltc-credits-used') === String(toolkitUnits(rotatedPages)),
    imageStamp.brief(),
  )
  uniqueRenders += Number(imageStamp.res.headers.get('x-ltc-credits-used') ?? 0)
  const formFields = await http('POST', '/v1/pdf-tools/fields', { headers: auth, json: { files: [{ base64: fixture('form.pdf') }] } })
  check(
    'fields of form.pdf -> its form fields, 0 images',
    formFields.status === 200 && formFields.json().op === 'fields' && formFields.json().credits_used === 0 && Array.isArray(formFields.json().fields) && formFields.json().fields.length > 0,
    formFields.brief(),
  )
  const encrypted = await http('POST', '/v1/pdf-tools/merge', { headers: auth, json: { files: [{ base64: fixture('encrypted-user.pdf') }, { base64: multiPage }] } })
  check('merge with an encrypted fixture -> refused (4xx), nothing counted', encrypted.status >= 400 && encrypted.status < 500 && typeof encrypted.json().error?.code === 'string', encrypted.brief())
  check('usage counts every toolkit result by its pages', (await usage()) === uniqueRenders, `used ${await usage()}, expected ${uniqueRenders}`)

  /* ---- warm render timings (dashboard preview: always rendered, never stored or counted) ---- */
  const timings = []
  for (const { format, type } of FORMATS) {
    const runs = []
    for (let run = 0; run < 4; run++) {
      const preview = await http('POST', '/api/preview', { headers: session, json: { template: 'blog', format, data: { title: `Timing ${format} ${run}`, author: 'smoke.mjs' } } })
      if (preview.status !== 200 || preview.res.headers.get('content-type') !== type) throw new Error(`preview ${format}: ${preview.brief()}`)
      if (run > 0) runs.push(preview.ms)
    }
    timings.push(`${format} ${Math.round(median(runs))} ms`)
  }
  check('usage is untouched by previews', (await usage()) === uniqueRenders)

  /* ---- PDFs: `wrangler dev` has no Browser Run binding, so every PDF route is switched off ---- */
  const config = await http('GET', '/api/config')
  check('GET /api/config reports pdf_enabled false without a BROWSER binding', config.status === 200 && config.json().pdf_enabled === false, config.brief())
  const notEnabled = (r) => r.status === 503 && r.json().error.code === 'not_configured' && r.json().error.message === 'PDF rendering is not enabled yet.'
  const pdfApi = await http('POST', '/v1/pdf', { headers: auth, json: { template: 'invoice', data: { seller_name: 'smoke.mjs' } } })
  check('POST /v1/pdf -> 503 not_configured', notEnabled(pdfApi), pdfApi.brief())
  const pdfSigned = await http('GET', `/v1/pdf/${site.json().site.id}/invoice.pdf?sig=${'0'.repeat(64)}`)
  check('GET /v1/pdf/{site}/{template}.pdf -> 503 not_configured', notEnabled(pdfSigned), pdfSigned.brief())
  const pdfTool = await http('POST', '/api/tools/pdf', { headers: origin, json: { tool: 'html-to-pdf', html: '<p>smoke</p>' } })
  check('POST /api/tools/pdf -> 503 not_configured', notEnabled(pdfTool), pdfTool.brief())
  const pdfFile = await http('GET', `/i/u_smoke/${'0'.repeat(64)}.pdf`)
  check('GET /i/{user}/{key}.pdf -> 503 not_configured', notEnabled(pdfFile), pdfFile.brief())
  check('usage is untouched by the PDF routes', (await usage()) === uniqueRenders)

  /* ---- revocation, webhook signature, JSON 404 ---- */
  const revoke = await http('DELETE', `/api/keys/${key.id}`, { headers: session })
  const afterRevoke = await http('GET', '/v1/usage', { headers: auth })
  check('revoked key -> 401 invalid_api_key', revoke.status === 200 && afterRevoke.status === 401 && afterRevoke.json().error.code === 'invalid_api_key', afterRevoke.brief())
  const webhook = await http('POST', '/webhooks/paddle', { headers: { 'paddle-signature': `ts=${Math.floor(Date.now() / 1000)};h1=${'0'.repeat(64)}` }, json: { event_id: 'evt_smoke', event_type: 'subscription.created', occurred_at: new Date().toISOString(), data: {} } })
  check('webhook with a bad signature -> 401', webhook.status === 401 && webhook.json().error.code === 'unauthorized', webhook.brief())
  // The raw bytes are what Paddle signs: odd spacing must survive the trip to the handler.
  const rawEvent = `{ "event_id": "evt_smoke_${Date.now()}",  "event_type": "transaction.paid", "occurred_at": "${new Date().toISOString()}", "data": {} }`
  const ts = Math.floor(Date.now() / 1000)
  const h1 = createHmac('sha256', VARS.PADDLE_WEBHOOK_SECRET).update(`${ts}:${rawEvent}`).digest('hex')
  const signedWebhook = await http('POST', '/webhooks/paddle', { headers: { 'content-type': 'application/json', 'paddle-signature': `ts=${ts};h1=${h1}` }, body: rawEvent })
  check('webhook with a valid signature is accepted', signedWebhook.status === 200 && signedWebhook.json().ok === true, signedWebhook.brief())
  const logout = await http('POST', '/auth/logout', { headers: session })
  const signedOut = await http('GET', '/api/me', { headers: session })
  check('bodyless POST /auth/logout ends the session', logout.status === 200 && signedOut.status === 401, `${logout.brief()} / ${signedOut.status}`)
  const unknown = await http('GET', '/v1/does-not-exist')
  check('unknown /v1 path -> JSON 404', unknown.status === 404 && unknown.res.headers.get('content-type')?.includes('application/json') === true && unknown.json().error.code === 'not_found', unknown.brief())

  console.log(`warm render, 1200x630 "blog" card, median of 3 over HTTP: ${timings.join(', ')}`)
}

/**
 * Run 2: APP_URL and the site's own URL (SITE_URL, so og:image and every absolute link on the
 * pages) are an https origin on an IPv6 literal from 3ffe::/16, a block returned to IANA and
 * assigned to no one. The page checker reads APP_URL's own pages and images from the static
 * assets instead of the network (src/inspect/fetch.ts ownSiteFetch, the path production uses for
 * linktocard.com), and an address literal needs no DNS lookup. The cards use a template of the
 * account with no image field, so the renderer downloads nothing: no request leaves the machine.
 * Requests still go to 127.0.0.1.
 */
const LOCAL_PAGE_ORIGIN = 'https://[3ffe::1]'
/** Every field it prints is text, so no page image is drawn (fields a template lacks are ignored). */
const TEXT_ONLY_TEMPLATE = {
  name: 'smoke link card',
  html: '<div class="card"><div class="title">{{title}}</div><div class="text">{{description}}</div><div class="text">{{site}}</div></div>',
  css: '.card { display: flex; flex-direction: column; justify-content: center; width: 100%; height: 100%; padding: 80px; background: #0f172a; color: #f8fafc; } .title { font-size: 72px; font-weight: 700; } .text { font-size: 32px; margin-top: 24px; }',
}

/** A URL the Worker built from APP_URL, as a path on the local server. */
const onLocalServer = (url) => {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

/** og:title of a built page, the title the checker should read. */
function builtTitle(page) {
  const html = readFileSync(path.join(root, 'site/dist', `${page}.html`), 'utf8')
  return /<meta property="og:title" content="([^"]*)">/.exec(html)?.[1]?.replace(/&amp;/g, '&') ?? null
}

async function linkCardsFromLocalPage() {
  const account = await newAccount('link', null)
  const created = await http('POST', '/api/templates', { headers: account.session, json: TEXT_ONLY_TEMPLATE })
  check('POST /api/templates creates a text-only card template', created.status === 201 && /^t_/.test(created.json().template?.id ?? ''), created.brief())
  const template = created.json().template.id
  const page = `${LOCAL_PAGE_ORIGIN}/pricing`
  const title = builtTitle('pricing')
  const made = await http('POST', '/v1/cards/from-url', { headers: account.auth, json: { url: page, template } })
  const card = made.status === 200 ? made.json() : {}
  check(
    `POST /v1/cards/from-url of the local /pricing page -> a 1200x630 card titled "${title}", not cached`,
    card.width === 1200 && card.height === 630 && card.cached === false && card.link?.final_url === page && card.link?.check_cached === false && typeof title === 'string' && card.link?.data?.title === title,
    made.brief(),
  )
  const image = await http('GET', onLocalServer(card.url ?? `${LOCAL_PAGE_ORIGIN}/`))
  check('GET the link card url -> PNG 1200x630', image.status === 200 && isPng(image.bytes) && pngSize(image.bytes) === '1200x630' && image.bytes.length === card.bytes, image.brief())
  check('the link card counts one image', (await account.usage()) === 1, `used ${await account.usage()}`)
  const again = await http('POST', '/v1/cards/from-url', { headers: account.auth, json: { url: page, template } })
  check('the same link card again -> cached card from the cached page check, not counted', again.status === 200 && again.json().cached === true && again.json().link.check_cached === true && (await account.usage()) === 1, again.brief())

  // Starter templates: the preview leaves the page's images out on purpose, so it fetches nothing.
  const preview = await http('GET', `/playground/from-check/${card.link?.check_id}/dark.png`)
  check('GET /playground/from-check/{check id}/dark.png -> watermarked 1200x630 PNG from the stored check, not counted', preview.status === 200 && isPng(preview.bytes) && pngSize(preview.bytes) === '1200x630' && (await account.usage()) === 1, preview.brief())
  const unknownCheck = await http('GET', '/playground/from-check/chk_0000000000000000/blog.png')
  check('GET /playground/from-check/{unknown id}/blog.png -> 404', unknownCheck.status === 404 && unknownCheck.json().error.code === 'not_found', unknownCheck.brief())

  const signedLink = signLinkUrl(LOCAL_PAGE_ORIGIN, account.siteId, account.siteSecret, `${template}.png`, { url: page, site: 'Smoke' })
  const linkCard = await http('GET', onLocalServer(signedLink))
  check('signed GET /v1/link/{site}/{template}.png?url=<local page> -> PNG 1200x630, counted once', linkCard.status === 200 && isPng(linkCard.bytes) && pngSize(linkCard.bytes) === '1200x630' && (await account.usage()) === 2, linkCard.brief())
  const linkAgain = await http('GET', onLocalServer(signedLink))
  check('the signed link URL again -> the same image, not counted', linkAgain.status === 200 && linkAgain.bytes.equals(linkCard.bytes) && (await account.usage()) === 2, linkAgain.brief())
  const otherPage = await http('GET', onLocalServer(signedLink).replace('%2Fpricing', '%2Fterms'))
  check('the signed link URL pointed at another page -> 403 invalid_signature', otherPage.status === 403 && otherPage.json().error.code === 'invalid_signature', otherPage.brief())
}

/** Run 3: the four build v3 switches "false", as in production. */
const OFF_SWITCHES = { BATCH_ENABLED: 'false', PDF_TOOLKIT_ENABLED: 'false', LINK_CARDS_ENABLED: 'false', EMAIL_FIELDS_ENABLED: 'false' }

async function switchedOff() {
  const account = await newAccount('off', base)
  const certificate = 'crt_00000000000000000000'
  const off = (label, r, message) => check(`${label} -> 503 "${message}"`, r.status === 503 && r.json().error.code === 'not_configured' && r.json().error.message === message, r.brief())

  const batches = 'Bulk documents are not enabled yet.'
  off('POST /v1/batches', await http('POST', '/v1/batches', { headers: account.auth, json: { template: 'certificate', rows: [{}] } }), batches)
  off('GET /v1/batches', await http('GET', '/v1/batches', { headers: account.auth }), batches)
  off('GET /v1/batches/{id}', await http('GET', '/v1/batches/bat_00000000000000000000', { headers: account.auth }), batches)
  off('GET /v1/batches/{id}/zip?part=1', await http('GET', '/v1/batches/bat_00000000000000000000/zip?part=1', { headers: account.auth }), batches)
  off('POST /v1/batches/{id}/cancel', await http('POST', '/v1/batches/bat_00000000000000000000/cancel', { headers: account.auth }), batches)
  off('GET /api/batches/templates', await http('GET', '/api/batches/templates', { headers: account.session }), batches)
  off('POST /api/batches', await http('POST', '/api/batches', { headers: account.session, json: { template: 'certificate', rows: [{}] } }), batches)
  off('GET /api/batches', await http('GET', '/api/batches', { headers: account.session }), batches)
  off('POST /v1/certificates/{id}/revoke', await http('POST', `/v1/certificates/${certificate}/revoke`, { headers: account.auth }), batches)
  off('POST /api/certificates/{id}/revoke', await http('POST', `/api/certificates/${certificate}/revoke`, { headers: account.session }), batches)
  off('GET /v/{id}.json', await http('GET', `/v/${certificate}.json`), batches)
  const verifyPage = await http('GET', `/v/${certificate}`)
  check(
    'GET /v/{id} -> 503 HTML page, noindex, with its own CSP',
    verifyPage.status === 503 && verifyPage.res.headers.get('content-type')?.startsWith('text/html') === true && verifyPage.res.headers.get('x-robots-tag') === 'noindex' && (verifyPage.res.headers.get('content-security-policy') ?? '').includes("default-src 'none'"),
    verifyPage.brief(),
  )
  const config = await http('GET', '/api/config', { headers: account.session })
  check('GET /api/config -> batch.enabled false', config.status === 200 && config.json().batch?.enabled === false, config.brief())

  const toolkit = 'The PDF toolkit is not enabled yet.'
  const onePage = await onePagePdfBase64()
  off('POST /v1/pdf-tools/merge', await http('POST', '/v1/pdf-tools/merge', { headers: account.auth, json: { files: [{ base64: onePage }, { base64: onePage }] } }), toolkit)
  off('POST /v1/pdf-tools/stamp', await http('POST', '/v1/pdf-tools/stamp', { headers: account.auth, json: { files: [{ base64: onePage }], text: 'PAID' } }), toolkit)
  off('POST /v1/pdf-tools/fields', await http('POST', '/v1/pdf-tools/fields', { headers: account.auth, json: { files: [{ base64: onePage }] } }), toolkit)

  const linkCards = 'Cards from links are not enabled yet.'
  off('POST /v1/cards/from-url', await http('POST', '/v1/cards/from-url', { headers: account.auth, json: { url: 'https://example.com/' } }), linkCards)
  const signedLink = signLinkUrl(base, account.siteId, account.siteSecret, 'blog.png', { url: 'https://example.com/' })
  off('a correctly signed GET /v1/link/...', await http('GET', signedLink), linkCards)
  off('GET /playground/from-check/{id}/blog.png', await http('GET', '/playground/from-check/chk_0000000000000000/blog.png'), linkCards)

  const emailFields = 'Open fields for email images are not enabled yet.'
  off('POST /api/sign with open fields', await http('POST', '/api/sign', { headers: account.session, json: { site_id: account.siteId, template: 'email-banner', size: 'email', data: { title: 'Off' }, open: ['name'] } }), emailFields)
  // The size block is not behind a switch: with email images off the message says their starters are not on yet.
  const refusedOff = (r) => r.status === 400 && r.json().error.details?.reason === 'size_not_supported' && r.json().error.message.includes('are not switched on yet')
  const blogWideOff = await http('POST', '/v1/images', { headers: account.auth, json: { template: 'blog', size: 'email', data: { title: 'Off' } } })
  check('with every switch off, POST /v1/images blog with size email -> 400 size_not_supported (email starters "not switched on yet")', refusedOff(blogWideOff), blogWideOff.brief())
  const signWideOff = await http('POST', '/api/sign', { headers: account.session, json: { site_id: account.siteId, template: 'docs', size: 'email', data: { title: 'Off' } } })
  check('with every switch off, POST /api/sign docs with size email -> 400 size_not_supported', refusedOff(signWideOff), signWideOff.brief())

  // What existed before build v3 keeps working with every switch off.
  const signed = await http('POST', '/api/sign', { headers: account.session, json: { site_id: account.siteId, template: 'blog', data: { title: 'Switched off', author: 'smoke.mjs' } } })
  const signedCard = signed.status === 200 ? await http('GET', signed.json().url) : signed
  check('with every switch off, a signed card URL still renders a 1200x630 PNG', signedCard.status === 200 && isPng(signedCard.bytes) && pngSize(signedCard.bytes) === '1200x630', signedCard.brief())
  const image = await http('POST', '/v1/images', { headers: account.auth, json: { template: 'dark', data: { title: 'Switched off' } } })
  check('with every switch off, POST /v1/images still renders', image.status === 200 && image.json().width === 1200, image.brief())
  check('nothing but the two cards was counted', (await account.usage()) === 2, `used ${await account.usage()}`)
}

/** Stops one server and waits until the port is free for the next run. */
async function stopServer(running) {
  await running.stop()
  const deadline = Date.now() + 15_000
  while ((await listening()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
}

let failed = false
let server
let siteBuiltForLocalOrigin = false
const persistDir = mkdtempSync(path.join(os.tmpdir(), 'linktocard-smoke-'))
const buildSite = (label, env) => runTool(label, process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', 'build:site'], env)
try {
  if (await listening()) throw new Error(`port ${PORT} is already in use; stop that server first (this script only stops what it started)`)
  buildSite('site build')
  runTool('D1 migrations', process.execPath, [wranglerBin, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir])
  server = await startServer(persistDir)
  await smoke()
  await stopServer(server)
  console.log(`--- wrangler dev again, APP_URL and SITE_URL ${LOCAL_PAGE_ORIGIN}: link cards from the Worker's own page ---`)
  siteBuiltForLocalOrigin = true
  buildSite(`site build with SITE_URL ${LOCAL_PAGE_ORIGIN}`, { SITE_URL: LOCAL_PAGE_ORIGIN })
  server = await startServer(persistDir, { APP_URL: LOCAL_PAGE_ORIGIN })
  await linkCardsFromLocalPage()
  await stopServer(server)
  buildSite('site build (again, as configured)', { SITE_URL: '' })
  siteBuiltForLocalOrigin = false
  console.log(`--- wrangler dev again, ${Object.keys(OFF_SWITCHES).join(', ')} "false" (as in production) ---`)
  server = await startServer(persistDir, OFF_SWITCHES)
  await switchedOff()
  console.log(`smoke: OK (${passed} checks)`)
} catch (error) {
  failed = true
  console.error(`smoke: FAILED after ${passed} checks\n`, error)
  if (server) console.error(`--- wrangler dev output (tail) ---\n${server.log().slice(-3000)}`)
} finally {
  await server?.stop()
  rmSync(persistDir, { recursive: true, force: true })
  // Never leave site/dist pointing at the throw-away origin of run 2.
  if (siteBuiltForLocalOrigin) {
    try {
      buildSite('site build (restoring the configured SITE_URL)', { SITE_URL: '' })
    } catch (error) {
      console.error(error)
      failed = true
    }
  }
}
process.exit(failed ? 1 : 0)

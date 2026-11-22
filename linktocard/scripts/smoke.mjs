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
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
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

function runTool(label, command, args) {
  const result = spawnSync(command, args, { cwd: root, env: TOOL_ENV, encoding: 'utf8' })
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

async function startServer(persistDir) {
  const vars = Object.entries(VARS).flatMap(([name, value]) => ['--var', `${name}:${value}`])
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

let failed = false
let server
const persistDir = mkdtempSync(path.join(os.tmpdir(), 'linktocard-smoke-'))
try {
  if (await listening()) throw new Error(`port ${PORT} is already in use; stop that server first (this script only stops what it started)`)
  runTool('site build', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '--silent', 'build:site'])
  runTool('D1 migrations', process.execPath, [wranglerBin, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistDir])
  server = await startServer(persistDir)
  await smoke()
  console.log(`smoke: OK (${passed} checks)`)
} catch (error) {
  failed = true
  console.error(`smoke: FAILED after ${passed} checks\n`, error)
  if (server) console.error(`--- wrangler dev output (tail) ---\n${server.log().slice(-3000)}`)
} finally {
  await server?.stop()
  rmSync(persistDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

#!/usr/bin/env node
// Post-deploy check against a live deployment (staging or production).
//
//   npm run check:deploy -- https://linktocard-staging.<subdomain>.workers.dev
//
// Without credentials it checks the public site, the headers and the playground
// renderer (5 real renders, which are not counted against any account).
// Optional, for the full check (values from the dashboard of a test account):
//   LTC_API_KEY=ltc_...                 POST /v1/images, caching and /v1/usage (4 images counted)
//   LTC_SITE_ID=s_... LTC_SITE_SECRET=ltcs_...   a signed URL, its cache, 304 and a forged signature
// Nothing secret is printed. Exits non-zero on the first run with any failure.
import { createHmac } from 'node:crypto'

const base = (process.argv[2] ?? '').replace(/\/+$/, '')
if (!/^https?:\/\//.test(base)) {
  console.error('usage: npm run check:deploy -- <base-url>')
  process.exit(2)
}
const apiKey = process.env.LTC_API_KEY
const siteId = process.env.LTC_SITE_ID
const siteSecret = process.env.LTC_SITE_SECRET
const PADDLE_SENTENCE = 'Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders.'
let failures = 0
const check = (name, ok, extra = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  [${extra}]` : ''}`)
}
const isPng = (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const pngSize = (b) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) })
const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8
const isWebp = (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'

async function get(path, init = {}) {
  const started = performance.now()
  const response = await fetch(base + path, { redirect: 'manual', ...init })
  const body = Buffer.from(await response.arrayBuffer())
  return { response, body, ms: Math.round(performance.now() - started), h: (n) => response.headers.get(n) }
}

// 1. Public pages: 200, no redirect, no cookie.
const pages = ['/', '/pricing', '/terms', '/privacy', '/refund', '/contact', '/login', '/dashboard', '/docs', '/docs/quickstart',
  '/docs/signed-urls', '/docs/html-css-templates', '/docs/frameworks', '/docs/api', '/docs/limits', '/compare/bannerbear', '/compare/vercel-og']
for (const path of pages) {
  const r = await get(path)
  check(`GET ${path} -> 200 html, no cookie`, r.response.status === 200 && (r.h('content-type') ?? '').includes('text/html') && !r.h('set-cookie'), `${r.response.status} ${r.ms}ms`)
  if (path === '/terms') check('/terms has the Merchant of Record sentence verbatim', r.body.toString().includes(PADDLE_SENTENCE))
  if (path === '/refund') check('/refund states 30 days', /30 days/.test(r.body.toString()))
  if (path === '/') check('/ sends a Content-Security-Policy', (r.h('content-security-policy') ?? '').includes("script-src 'self'"))
}
const spec = await get('/openapi.yaml')
check('GET /openapi.yaml -> 200', spec.response.status === 200 && spec.body.toString().startsWith('openapi: 3.1'))
const missing = await get('/no-such-page')
check('unknown page -> 404 page', missing.response.status === 404)
const health = await get('/healthz')
check('GET /healthz -> {"ok":true}', health.response.status === 200 && health.body.toString().includes('"ok":true'), health.body.toString().slice(0, 80))

// 2. Playground renders on Cloudflare, each starter template once (first = real render).
const stamp = Date.now().toString(36)
for (const template of ['blog', 'dark', 'quote', 'launch', 'docs']) {
  const r = await get(`/playground/card.png?template=${template}&title=${encodeURIComponent(`Staging check ${stamp} ${template}`)}`)
  const ok = r.response.status === 200 && isPng(r.body) && pngSize(r.body).width === 1200 && pngSize(r.body).height === 630
  check(`playground ${template}: 1200x630 PNG`, ok, `${r.response.status} ${r.ms}ms total, cache=${r.h('x-ltc-cache')}, ${r.body.length} bytes${ok ? '' : ' ' + r.body.toString().slice(0, 200)}`)
}
const again = await get(`/playground/card.png?template=blog&title=${encodeURIComponent(`Staging check ${stamp} blog`)}`)
check('playground repeat is served from storage', again.response.status === 200 && again.h('x-ltc-cache') === 'hit', `cache=${again.h('x-ltc-cache')} ${again.ms}ms`)

// 3. API key: render, cache, usage.
let usedBefore = NaN
const auth = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
if (apiKey) {
const before = await get('/v1/usage', { headers: auth })
check('GET /v1/usage with the test key', before.response.status === 200, before.body.toString().slice(0, 160))
usedBefore = before.response.status === 200 ? JSON.parse(before.body).used : NaN
for (const [format, valid] of [['png', isPng], ['jpeg', isJpeg], ['webp', isWebp]]) {
  const body = JSON.stringify({ template: 'blog', data: { title: `API ${format} ${stamp}` }, format })
  const first = await get('/v1/images', { method: 'POST', headers: auth, body })
  const json = first.response.status === 200 ? JSON.parse(first.body) : {}
  check(`POST /v1/images ${format}: rendered`, first.response.status === 200 && json.cached === false, `${first.response.status} ${first.ms}ms ${first.response.status === 200 ? '' : first.body.toString().slice(0, 200)}`)
  if (json.url) {
    const image = await fetch(json.url)
    const bytes = Buffer.from(await image.arrayBuffer())
    check(`GET hosted ${format} url`, image.status === 200 && valid(bytes), `${image.status} ${image.headers.get('content-type')}`)
  }
  const second = await get('/v1/images', { method: 'POST', headers: auth, body })
  check(`POST /v1/images ${format} repeat: cached`, second.response.status === 200 && JSON.parse(second.body).cached === true, `${second.ms}ms`)
}
const after = await get('/v1/usage', { headers: auth })
check('usage rose by exactly the 3 unique renders', JSON.parse(after.body).used === usedBefore + 3, `before ${usedBefore}, after ${JSON.parse(after.body).used}`)
} else console.log('skip API key checks (set LTC_API_KEY)')

// 4. Signed URL.
if (siteId && siteSecret) {
const params = { title: `Signed ${stamp}`, author: 'Staging check' }
const path = `/v1/og/${siteId}/blog.png`
const names = Object.keys(params).sort()
const sig = createHmac('sha256', siteSecret).update([path, names.join(','), ...names.map((n) => `${n}=${params[n]}`)].join('\n')).digest('hex')
const signed = `${path}?${new URLSearchParams({ ...params, sig })}`
const s1 = await get(signed)
check('signed URL -> 200 PNG, cacheable', s1.response.status === 200 && isPng(s1.body) && (s1.h('cache-control') ?? '').includes('max-age'), `${s1.response.status} ${s1.ms}ms cache=${s1.h('x-ltc-cache')} cc=${s1.h('cache-control')}`)
const s2 = await get(signed)
check('signed URL repeat -> hit', s2.response.status === 200 && s2.h('x-ltc-cache') === 'hit', `${s2.ms}ms cache=${s2.h('x-ltc-cache')}`)
const etag = s1.h('etag')
if (etag) {
  const s3 = await get(signed, { headers: { 'if-none-match': etag } })
  check('If-None-Match -> 304', s3.response.status === 304, String(s3.response.status))
}
const tampered = await get(signed.replace(/sig=[0-9a-f]{4}/, 'sig=0000'))
check('tampered signature -> 403', tampered.response.status === 403, tampered.body.toString().slice(0, 120))
if (apiKey) {
  const finalUsage = JSON.parse((await get('/v1/usage', { headers: auth })).body)
  check('signed URL counted once', finalUsage.used === usedBefore + 4, `used ${finalUsage.used}`)
}
} else console.log('skip signed URL checks (set LTC_SITE_ID and LTC_SITE_SECRET)')
const free = await get('/v1/usage', { headers: { authorization: 'Bearer ltc_not_a_real_key' } })
check('bad API key -> 401', free.response.status === 401)

console.log(failures === 0 ? `check:deploy OK (${base})` : `check:deploy: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)

#!/usr/bin/env node
// Real-runtime smoke test: starts `wrangler dev` (real workerd, the flags from wrangler.toml,
// no test-pool extras), fetches the demo card from /spike.{png,jpg,webp} over HTTP and checks
// the bytes. The demo card is rendered by renderCard() from HTML + CSS, so this proves the
// whole template path (HTML parser, CSS pre-processing, image inlining, Satori, resvg,
// watermark, encoders) in the plain runtime.
//
// The vitest pool is NOT equivalent to the real runtime: it always enables nodejs_compat and
// allows eval, and it defines globals (e.g. `self.location`) that plain workerd lacks. This
// script is the check that the Worker boots and renders without them.
//
//   node scripts/smoke.mjs                 one server: each format cold then warm, then the options
//   node scripts/smoke.mjs --bench         fresh server per format (true cold numbers), 10 warm runs
//   node scripts/smoke.mjs --out card.png  also save card.png / card.jpg / card.webp / card-free.png
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const port = Number(option('--port', 8799))
const warmRuns = Number(option('--warm', flag('--bench') ? 10 : 3))
const base = `http://127.0.0.1:${port}`

const isPng = (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
const pngSize = (b) => `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`
const CHECKS = {
  png: (b) => isPng(b) && pngSize(b) === '1200x630',
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
}

async function startServer() {
  const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--port', String(port)], {
    cwd: root,
    detached: true, // own process group, so workerd is killed together with wrangler
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  const stop = () =>
    new Promise((resolve) => {
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
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`)
    try {
      const res = await fetch(`${base}/`)
      if (res.ok) return { stop, log: () => log }
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  await stop()
  throw new Error(`wrangler dev did not become ready:\n${log}`)
}

async function request(ext, query = {}) {
  const started = performance.now()
  const res = await fetch(`${base}/spike.${ext}?${new URLSearchParams(query)}`)
  const body = Buffer.from(await res.arrayBuffer())
  return { res, body, wall: performance.now() - started }
}

async function get(ext, query = {}, check = CHECKS[ext]) {
  const { res, body, wall } = await request(ext, query)
  const label = `/spike.${ext}?${new URLSearchParams(query)}`
  if (res.status !== 200) throw new Error(`${label} -> ${res.status}: ${body.toString().slice(0, 500)}`)
  if (!check(body)) throw new Error(`${label}: unexpected bytes ${body.subarray(0, 24).toString('hex')}`)
  const warnings = JSON.parse(decodeURIComponent(res.headers.get('x-render-warnings') ?? '[]'))
  if (warnings.length) throw new Error(`${label}: unexpected render warnings ${JSON.stringify(warnings)}`)
  const timing = Object.fromEntries(
    (res.headers.get('server-timing') ?? '').split(', ').filter(Boolean).map((part) => {
      const [name, dur] = part.split(';dur=')
      return [name, Number(dur)]
    }),
  )
  return { body, wall, timing, init: res.headers.get('x-init-runs') }
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const fmt = (n) => n.toFixed(0).padStart(5)
const STAGES = ['compile', 'images', 'layout', 'raster', 'encode']
const stages = (pick) => STAGES.map((name) => `${name} ${fmt(pick(name)).trim()}`).join(', ')

async function measure(ext) {
  const cold = await get(ext)
  const warm = []
  // A different title per run, so the warm numbers are not flattered by Satori's shaping cache.
  for (let i = 0; i < warmRuns; i++) warm.push(await get(ext, { title: `Warm run ${i + 1} of ${warmRuns}` }))
  const m = (key) => median(warm.map((w) => w.timing[key]))
  console.log(
    `${ext.padEnd(4)} ${String(cold.body.length).padStart(7)} B | cold total ${fmt(cold.timing.total)} ms (${stages((name) => cold.timing[name])}) | ` +
      `warm median of ${warmRuns}: total ${fmt(m('total'))} ms (${stages(m)}) | init ${warm.at(-1).init}`,
  )
  return cold
}

/** Options of the template path that the per-format runs do not touch. */
async function checkOptions(plain) {
  const free = await get('png', { wm: 'free' })
  const preview = await get('png', { wm: 'preview' })
  if (free.body.equals(plain.body) || preview.body.equals(free.body)) throw new Error('watermark modes did not change the image')
  for (const [size, expected] of [['square', '1080x1080'], ['portrait', '1080x1350']]) {
    await get('png', { size, wm: 'free' }, (b) => isPng(b) && pngSize(b) === expected)
  }
  // Markup in a data value must end up as text: the render succeeds and nothing is fetched.
  await get('png', { title: '<script>alert(1)</script><img src=http://127.0.0.1/x.png>' })
  const refused = await request('png', { size: 'huge' })
  const error = refused.res.status === 400 ? JSON.parse(refused.body.toString()).error : undefined
  if (error?.code !== 'unsupported_size') throw new Error(`size=huge -> ${refused.res.status} ${refused.body.toString().slice(0, 200)}`)
  console.log('options: watermark free/preview, square, portrait, markup-in-data, error response OK')
  return free
}

let failed = false
try {
  if (flag('--bench')) {
    for (const ext of ['png', 'jpg', 'webp']) {
      const server = await startServer()
      try {
        const cold = await measure(ext)
        if (ext === 'png' && option('--out')) writeFileSync(option('--out'), cold.body)
      } finally {
        await server.stop()
      }
    }
  } else {
    const server = await startServer()
    try {
      const out = option('--out')
      let plain
      for (const ext of ['png', 'jpg', 'webp']) {
        const cold = await measure(ext)
        if (ext === 'png') plain = cold
        if (out) writeFileSync(out.replace(/\.png$/, `.${ext}`), cold.body)
      }
      const free = await checkOptions(plain)
      if (out) writeFileSync(out.replace(/\.png$/, '-free.png'), free.body)
    } finally {
      await server.stop()
    }
  }
  console.log('smoke: OK')
} catch (error) {
  failed = true
  console.error('smoke: FAILED\n', error)
}
process.exit(failed ? 1 : 0)

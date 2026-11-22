#!/usr/bin/env node
// Renders the starter-template gallery samples and the site's own og.png with the real
// renderer in real workerd. It starts `wrangler dev` for the dev-only samples worker
// (scripts/samples-worker.mts, scripts/samples.wrangler.toml), fetches the cards over HTTP,
// writes the files and stops the process it started.
//
//   node scripts/render-samples.mjs                  site/public/assets/img/samples/<id>.png + og.png
//   node scripts/render-samples.mjs --review <dir>   also every review variant (sizes, long title,
//                                                    title only, dark theme, with image) into <dir>
//   node scripts/render-samples.mjs --bench          warm render time per template at 1200x630
//   node scripts/render-samples.mjs --no-write       skip the site files (with --review / --bench)
//   --port <n>       port for wrangler dev (default 8798)
//   --base <url>     use a samples worker that is already running instead of starting one
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const port = Number(option('--port', 8798))
const externalBase = option('--base', '')
const base = externalBase || `http://127.0.0.1:${port}`
const reviewDir = option('--review', '')
const imgDir = path.join(root, 'site/public/assets/img')

// Must match DEMO_IMAGE_URL in scripts/samples-worker.mts (the only image that worker resolves;
// a Worker module may only export handlers, so the constant cannot be shared).
const DEMO_IMAGE_URL = 'https://samples.linktocard.test/avatar.svg'

const OG_CARD = {
  template: 'blog',
  data: {
    title: 'Turn every link into a beautiful share card',
    description: 'The signed og:image URL for sites that are not on Vercel.',
    site: 'linktocard.com',
  },
}

// Exactly 140 and 200 characters: the longest title the starter templates promise to fit, and an overlong description.
const LONG_DATA = {
  title: 'How we moved forty thousand Open Graph images from a headless browser fleet to plain HTML and CSS templates without breaking one single link',
  description:
    'A field report with every number we measured on the way: cold starts, cache hit rates, the cost per thousand images, and the three template mistakes that made our first week tougher than it had to be.',
  author: 'Alexandra Konstantinopoulou-Whitfield',
  site: 'engineering.longcompanyname.example',
  tag: 'Infrastructure field notes',
  image: DEMO_IMAGE_URL,
}

const SIZE_PIXELS = { og: [1200, 630], square: [1080, 1080], portrait: [1080, 1350] }

/** Every card a designer should look at before the samples are published. */
function reviewVariants(sample) {
  const playground = { title: sample.title, description: sample.description ?? '', author: sample.author ?? '' }
  return [
    { name: 'sample', size: 'og', data: sample },
    { name: 'sample', size: 'square', data: sample },
    { name: 'sample', size: 'portrait', data: sample },
    { name: 'title-only', size: 'og', data: { title: sample.title } },
    { name: 'title-only', size: 'square', data: { title: sample.title } },
    { name: 'title-only', size: 'portrait', data: { title: sample.title } },
    { name: 'short-title', size: 'og', data: { title: 'Changelog' } },
    { name: 'long', size: 'og', data: LONG_DATA },
    { name: 'long', size: 'square', data: LONG_DATA },
    { name: 'long', size: 'portrait', data: LONG_DATA },
    { name: 'playground', size: 'og', data: playground },
    { name: 'playground-dark', size: 'og', data: { ...playground, theme: 'dark' } },
    { name: 'dark', size: 'og', data: { ...sample, theme: 'dark' } },
    { name: 'dark', size: 'square', data: { ...sample, theme: 'dark' } },
    { name: 'image', size: 'og', data: { ...sample, image: DEMO_IMAGE_URL } },
    { name: 'image', size: 'portrait', data: { ...sample, image: DEMO_IMAGE_URL } },
    { name: 'watermark', size: 'og', data: sample, wm: 'free' },
  ]
}

async function startServer() {
  const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js')
  const config = path.join(root, 'scripts/samples.wrangler.toml')
  const state = path.join(root, '.wrangler', `samples-${port}`) // git-ignored; the samples worker stores nothing
  const child = spawn(process.execPath, [wrangler, 'dev', '--config', config, '--port', String(port), '--persist-to', state], {
    cwd: root,
    detached: true, // own process group, so workerd is stopped together with wrangler
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
      if ((await fetch(`${base}/templates`)).ok) return stop
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  await stop()
  throw new Error(`wrangler dev did not become ready:\n${log}`)
}

/** Fetches one card; fails on a non-200 answer, wrong dimensions or any render warning. */
async function render(template, { size = 'og', data, wm = 'none' }) {
  const query = new URLSearchParams({ ...data, size, wm })
  const label = `${template} ${size} ${JSON.stringify(data).slice(0, 80)}`
  const res = await fetch(`${base}/render/${template}.png?${query}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (res.status !== 200) throw new Error(`${label} -> ${res.status}: ${bytes.toString().slice(0, 500)}`)
  const [width, height] = SIZE_PIXELS[size]
  if (bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw new Error(`${label}: not a ${width}x${height} PNG`)
  const warnings = JSON.parse(decodeURIComponent(res.headers.get('x-render-warnings') ?? '[]'))
  if (warnings.length) throw new Error(`${label}: render warnings ${JSON.stringify(warnings)}`)
  return { bytes, ms: Number(res.headers.get('x-render-ms')) }
}

const kB = (bytes) => `${(bytes.length / 1000).toFixed(1)} kB`
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

function save(file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, bytes)
  console.log(`${path.relative(root, file).padEnd(46)} ${kB(bytes)}`)
}

async function writeSiteFiles(templates) {
  for (const { id, sample } of templates) {
    const { bytes } = await render(id, { data: sample })
    save(path.join(imgDir, 'samples', `${id}.png`), bytes)
  }
  const { bytes } = await render(OG_CARD.template, { data: OG_CARD.data })
  save(path.join(imgDir, 'og.png'), bytes)
}

async function writeReview(templates, dir) {
  for (const { id, sample } of templates) {
    for (const variant of reviewVariants(sample)) {
      const { bytes } = await render(id, variant)
      save(path.join(dir, `${id}-${variant.name}-${variant.size}.png`), bytes)
    }
  }
}

/** Warm in-Worker render time (performance.now() around renderCard), a different title per request. */
async function bench(templates) {
  console.log('\nwarm render at 1200x630, sample data, median of 10 (in-Worker ms)')
  for (const { id, sample } of templates) {
    await render(id, { data: sample })
    const runs = []
    for (let i = 0; i < 10; i++) runs.push((await render(id, { data: { ...sample, title: `${sample.title} ${i}` } })).ms)
    console.log(`${id.padEnd(8)} ${median(runs).toFixed(0)} ms   (min ${Math.min(...runs).toFixed(0)}, max ${Math.max(...runs).toFixed(0)})`)
  }
}

const stop = externalBase ? async () => {} : await startServer()
try {
  const templates = await (await fetch(`${base}/templates`)).json()
  if (!flag('--no-write')) await writeSiteFiles(templates)
  if (reviewDir) await writeReview(templates, path.resolve(reviewDir))
  if (flag('--bench')) await bench(templates)
} finally {
  await stop()
}

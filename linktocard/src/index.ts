import { Hono } from 'hono'
import { CONTENT_TYPES, initRuns, render, type ImageFormat } from './render/engine'
import { sampleCard } from './render/sample-card'

const app = new Hono()

app.get('/', (c) => c.text('linktocard: see /spike.png, /spike.jpg, /spike.webp'))

const SPIKE_FORMATS: Record<string, ImageFormat> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' }

// Smoke endpoint: /spike.png?w=1200&h=630&title=Hello
app.get('/spike.:ext', async (c) => {
  const format = SPIKE_FORMATS[c.req.param('ext')]
  if (!format) return c.text('unknown format', 404)
  const width = Number(c.req.query('w') ?? 1200)
  const height = Number(c.req.query('h') ?? 630)
  const started = performance.now()
  const bytes = await render(sampleCard(c.req.query('title')), { width, height, format })
  return new Response(bytes, {
    headers: {
      'content-type': CONTENT_TYPES[format],
      'x-render-ms': String(Math.round(performance.now() - started)),
      'x-init-runs': JSON.stringify(initRuns()),
    },
  })
})

export default app

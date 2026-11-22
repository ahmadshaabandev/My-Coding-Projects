import { Hono } from 'hono'
import { CONTENT_TYPES, initRuns, renderWithTimings, type ImageFormat } from './render/engine'
import { sampleCard } from './render/sample-card'

const app = new Hono()

app.get('/', (c) => c.text('linktocard: see /spike.png, /spike.jpg, /spike.webp'))

const SPIKE_FORMATS: Record<string, ImageFormat> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' }

// Smoke endpoint: /spike.png?w=1200&h=630&title=Hello
app.get('/:file{spike\\.[a-z]+}', async (c) => {
  const format = SPIKE_FORMATS[c.req.param('file').slice('spike.'.length)]
  if (!format) return c.text('unknown format', 404)
  const width = Number(c.req.query('w') ?? 1200)
  const height = Number(c.req.query('h') ?? 630)
  const { bytes, timings } = await renderWithTimings(sampleCard(c.req.query('title')), { width, height, format })
  return new Response(bytes, {
    headers: {
      'content-type': CONTENT_TYPES[format],
      // NB: in production workerd the clock only advances on I/O, so these read 0 there.
      'server-timing': Object.entries(timings)
        .map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`)
        .join(', '),
      'x-init-runs': JSON.stringify(initRuns()),
    },
  })
})

export default app

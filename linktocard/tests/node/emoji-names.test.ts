import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { emojiFileName } from '../../src/render/emoji'

// emojiFileName must produce names of files that really ship in @twemoji/svg (the site
// build copies that directory to /_emoji/), so this is checked against the package itself.
const TWEMOJI_DIR = fileURLToPath(new URL('../../node_modules/@twemoji/svg/', import.meta.url))

const hasFile = (name: string): boolean => existsSync(`${TWEMOJI_DIR}${name}.svg`)

describe('emojiFileName against @twemoji/svg', () => {
  it.each([
    ['rocket', '\u{1F680}', '1f680'],
    ['red heart (with U+FE0F)', '❤️', '2764'],
    ['keycap #', '#️⃣', '23-20e3'],
    ['man technologist (ZWJ)', '\u{1F468}‍\u{1F4BB}', '1f468-200d-1f4bb'],
    ['rainbow flag (ZWJ + U+FE0F)', '\u{1F3F3}️‍\u{1F308}', '1f3f3-fe0f-200d-1f308'],
    ['heart on fire (ZWJ + U+FE0F)', '❤️‍\u{1F525}', '2764-fe0f-200d-1f525'],
    ['flag of Lebanon', '\u{1F1F1}\u{1F1E7}', '1f1f1-1f1e7'],
    ['thumbs up, medium skin tone', '\u{1F44D}\u{1F3FD}', '1f44d-1f3fd'],
    ['flag of Scotland (tag sequence)', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}', '1f3f4-e0067-e0062-e0073-e0063-e0074-e007f'],
  ])('%s -> a file that exists', (_label, grapheme, expected) => {
    expect(emojiFileName(grapheme)).toBe(expected)
    expect(hasFile(expected)).toBe(true)
  })

  it('maps every shipped file name back to itself', () => {
    const names = readdirSync(TWEMOJI_DIR)
      .filter((file) => file.endsWith('.svg'))
      .map((file) => file.slice(0, -4))
    expect(names.length).toBeGreaterThan(3000)
    const unstable = names.filter((name) => {
      const grapheme = String.fromCodePoint(...name.split('-').map((hex) => Number.parseInt(hex, 16)))
      return emojiFileName(grapheme) !== name
    })
    expect(unstable).toEqual([])
  })

  it('documents the exception the loader falls back for: eye in speech bubble ships without U+FE0F', () => {
    const qualified = emojiFileName('\u{1F441}️‍\u{1F5E8}️')
    expect(qualified).toBe('1f441-fe0f-200d-1f5e8-fe0f')
    expect(hasFile(qualified)).toBe(false)
    expect(hasFile('1f441-200d-1f5e8')).toBe(true)
  })
})

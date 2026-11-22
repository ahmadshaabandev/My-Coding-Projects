import { defineConfig } from 'vitest/config'

// Node project: tests/node/*.test.ts run in plain Node. They cover things that live
// outside the Worker runtime: the static-site build, config/catalog consistency,
// cross-language signing vectors (node, php, python) and docs snippets.
export default defineConfig({
  test: {
    include: ['tests/node/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})

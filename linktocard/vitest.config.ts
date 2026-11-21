import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

// Tests run INSIDE workerd. Bindings, compatibility date/flags and the module rules
// (.wasm -> CompiledWasm, .woff/.ttf -> Data) are read from wrangler.toml.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
    }),
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
})

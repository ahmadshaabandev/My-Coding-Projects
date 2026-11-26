import { defineConfig } from 'vitest/config';

// The app is CommonJS (what Zapier runs); Vitest needs ESM test files, hence *.test.mjs.
// test/setup.mjs blocks every real network connection, so the suite runs offline and a request
// without a matching nock fails instead of reaching linktocard.com.
export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    setupFiles: ['./test/setup.mjs'],
    testTimeout: 20_000,
  },
});

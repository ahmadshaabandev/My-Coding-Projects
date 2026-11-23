import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Workers project: tests/*.test.ts run INSIDE workerd (the same runtime `wrangler dev`
// uses) with local D1, R2, rate limiters and the static-assets binding from wrangler.toml.
//
// The pool is close to, but not identical to, production workerd (it force-enables
// nodejs_compat, allows eval and has extra globals). `npm run smoke` exercises
// the plain runtime through `wrangler dev`.
//
// Storage (D1, R2, rate-limit counters) is isolated per test FILE, not per test.
//
// PROBES=1 (npm run probes) runs the slow, log-only exploration files in tests/probes.
const probes = process.env.PROBES === '1'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // wrangler.toml points [assets] at site/dist; make sure it exists even before
      // `npm run build:site` has run (tests that need real pages build the site first).
      mkdirSync(fileURLToPath(new URL('./site/dist', import.meta.url)), { recursive: true })
      const migrations = await readD1Migrations(fileURLToPath(new URL('./src/db/migrations', import.meta.url)))
      return {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Test-only bindings. They override wrangler.toml [vars] and .dev.vars, so the
          // suite behaves the same on a laptop and in CI. None of these are real secrets.
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: 'test',
            APP_URL: 'https://linktocard.test',
            SUPPORT_EMAIL: 'support@linktocard.test',
            MAIL_FROM: 'Link To Card <login@linktocard.test>',
            SIGNING_MASTER_SECRET: 'test-master-secret-not-a-real-secret',
            RESEND_API_KEY: 're_test_not_a_real_key',
            PADDLE_ENV: 'sandbox',
            CHECKOUT_ENABLED: 'true',
            PADDLE_CLIENT_TOKEN: 'test_clienttoken0000000000000',
            PADDLE_API_KEY: 'pdl_sdbx_apikey_test_not_a_real_key',
            PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_test_not_a_real_secret',
            PADDLE_PRICE_STARTER: 'pri_test_starter',
            PADDLE_PRICE_PRO: 'pri_test_pro',
            PADDLE_PRICE_TOPUP: 'pri_test_topup',
            // Rate limiting is switched off for tests that are not about rate limiting
            // (honoured only when ENVIRONMENT is "test"); rate-limit tests re-enable it.
            RATE_LIMITS_DISABLED: '1',
          },
        },
      }
    }),
  ],
  test: {
    include: probes ? ['tests/probes/**/*.probe.ts'] : ['tests/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: probes ? 600_000 : 60_000,
    hookTimeout: 60_000,
  },
})

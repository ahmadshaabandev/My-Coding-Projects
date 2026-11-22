// Types for `import { env } from 'cloudflare:workers'` inside tests.
declare namespace Cloudflare {
  interface Env extends ImportedEnv {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
    RATE_LIMITS_DISABLED?: string
  }
  interface GlobalProps {
    mainModule: typeof import('../src/index')
  }
}

type ImportedEnv = import('../src/types').Env

import { createRequire } from 'node:module';
import { afterEach, beforeEach } from 'vitest';

const require = createRequire(import.meta.url);
const nock = require('nock');

// Offline by construction: any request that no nock interceptor matches fails at once.
nock.disableNetConnect();

beforeEach(() => {
  delete process.env.LTC_BASE_URL;
});

afterEach(() => {
  nock.cleanAll();
  delete process.env.LTC_BASE_URL;
});

'use strict';

/**
 * Output fields and samples shared by the actions. Zapier shows the sample in the Zap editor
 * before a real run and requires one on every visible action (zapier-platform-schema
 * requiredSamples). The values are examples: the ids and links are made up, and the usage block
 * is what a Starter account could see (tests/node/zapier-connector-sync.test.ts checks its
 * numbers against src/billing/plans.ts). Nested fields are flattened by Zapier with "__".
 */

/** @typedef {import('zapier-platform-core').PlainOutputField} OutputField */

const SAMPLE_USAGE = {
  plan: 'starter',
  period_start: '2026-11-01T00:00:00.000Z',
  period_end: '2026-12-01T00:00:00.000Z',
  limit: 2000,
  used: 412,
  remaining: 1588,
  topup_remaining: 0,
  total_remaining: 1588,
  cache_days: 30,
  watermark: false,
};

/** @type {OutputField[]} */
const USAGE_OUTPUT_FIELDS = [
  { key: 'usage__plan', label: 'Plan' },
  { key: 'usage__used', label: 'Images Used This Period', type: 'integer' },
  { key: 'usage__total_remaining', label: 'Images Left (Allowance and Top-Ups)', type: 'integer' },
];

const SAMPLE_IMAGE = {
  id: '9b1f0c7e3a5d48c2b6e4f1a8d7c3e5b9a2f6d4c8e1b7a3f5d9c2e6b4a8f1d3c7',
  url: 'https://linktocard.com/i/u_hkr8wty4jftnyum3/9b1f0c7e3a5d48c2b6e4f1a8d7c3e5b9a2f6d4c8e1b7a3f5d9c2e6b4a8f1d3c7.png',
  width: 1200,
  height: 630,
  format: 'png',
  bytes: 48213,
  cached: false,
  template: 'blog',
  created_at: '2026-11-26T09:12:44.031Z',
  expires_at: '2026-12-26T09:12:44.031Z',
  warnings: [],
  usage: SAMPLE_USAGE,
  file: 'https://linktocard.com/i/u_hkr8wty4jftnyum3/9b1f0c7e3a5d48c2b6e4f1a8d7c3e5b9a2f6d4c8e1b7a3f5d9c2e6b4a8f1d3c7.png',
};

/** @type {OutputField[]} */
const IMAGE_OUTPUT_FIELDS = [
  { key: 'id', label: 'Image ID' },
  { key: 'url', label: 'Image URL' },
  { key: 'file', label: 'Image File', type: 'file' },
  { key: 'width', label: 'Width (px)', type: 'integer' },
  { key: 'height', label: 'Height (px)', type: 'integer' },
  { key: 'format', label: 'Image Format' },
  { key: 'bytes', label: 'File Size (bytes)', type: 'integer' },
  { key: 'cached', label: 'Served From Storage', type: 'boolean' },
  { key: 'template', label: 'Template' },
  { key: 'created_at', label: 'Created At', type: 'datetime' },
  { key: 'expires_at', label: 'Link Expires At', type: 'datetime' },
  { key: 'warnings', label: 'Warnings', list: true },
  ...USAGE_OUTPUT_FIELDS,
];

/** A one-page invoice: `credits_used` is what one page counts (pdfUnits in src/config.ts). */
const SAMPLE_PDF = {
  id: '4c7e2a9f1b8d3e6a0c5f2b9d4a7e1c8f3b6d0a5e2c9f4b1d8a3e7c0f6b2d5a9e',
  url: 'https://linktocard.com/i/u_hkr8wty4jftnyum3/4c7e2a9f1b8d3e6a0c5f2b9d4a7e1c8f3b6d0a5e2c9f4b1d8a3e7c0f6b2d5a9e.pdf',
  pages: 1,
  bytes: 61842,
  credits_used: 2,
  cached: false,
  template: 'invoice',
  filename: 'invoice-2026-001.pdf',
  created_at: '2026-11-26T09:12:44.031Z',
  expires_at: '2026-12-26T09:12:44.031Z',
  warnings: [],
  usage: SAMPLE_USAGE,
  file: 'https://linktocard.com/i/u_hkr8wty4jftnyum3/4c7e2a9f1b8d3e6a0c5f2b9d4a7e1c8f3b6d0a5e2c9f4b1d8a3e7c0f6b2d5a9e.pdf',
};

/**
 * A batch as POST /v1/batches answers it (202): queued, nothing made yet, no ZIP parts. The
 * same fields come back from GET /v1/batches/{id}, which adds `rows`.
 */
const SAMPLE_BATCH_STARTED = {
  id: 'bat_m4q8x2k7v1c9d3e6',
  status: 'queued',
  template: 'certificate',
  verify: true,
  total: 2,
  counts: { queued: 2, running: 0, done: 0, failed: 0, cancelled: 0 },
  pages: 0,
  credits_used: 0,
  created_at: '2026-11-26T09:12:44.031Z',
  started_at: null,
  finished_at: null,
  cancelled_at: null,
  zip_url: 'https://linktocard.com/v1/batches/bat_m4q8x2k7v1c9d3e6/zip',
  zip_parts: [],
};

/**
 * The same batch once finished, as GET /v1/batches/{id} answers, plus the fields Find Batch adds
 * (`finished`, `zip_part_count`, `zip_file` and a `file` on every ZIP part). Rows without a File
 * Name Pattern are named after the template and the row number (certificate-1.pdf, ...).
 */
const SAMPLE_BATCH = {
  ...SAMPLE_BATCH_STARTED,
  status: 'done',
  counts: { queued: 0, running: 0, done: 2, failed: 0, cancelled: 0 },
  pages: 2,
  credits_used: 4,
  started_at: '2026-11-26T09:12:46.112Z',
  finished_at: '2026-11-26T09:12:49.874Z',
  rows: [
    {
      index: 0,
      status: 'done',
      filename: 'certificate-1.pdf',
      pages: 1,
      credits_used: 2,
      url: 'https://linktocard.com/i/u_hkr8wty4jftnyum3/0f6e2b9d4a1c8e3f7b5d2a9c6e1f4b8d3a7c0e5f2b9d6a1c4e8f3b7d0a2c5e9f.pdf',
      error: null,
      certificate_id: 'crt_8w3k5q0m2r7t9v4x6z1b',
      verify_url: 'https://linktocard.com/v/crt_8w3k5q0m2r7t9v4x6z1b',
    },
    {
      index: 1,
      status: 'done',
      filename: 'certificate-2.pdf',
      pages: 1,
      credits_used: 2,
      url: 'https://linktocard.com/i/u_hkr8wty4jftnyum3/7c2a9e4f1b8d3c6a0e5f2b9d4a7c1e8f3b6d0a5c2e9f4b1d8a3c7e0f6b2d5a9c.pdf',
      error: null,
      certificate_id: 'crt_3n7p1q9s5t2v8w4x0y6z',
      verify_url: 'https://linktocard.com/v/crt_3n7p1q9s5t2v8w4x0y6z',
    },
  ],
  zip_parts: [
    {
      part: 1,
      entries: 2,
      bytes: 70318,
      url: 'https://linktocard.com/v1/batches/bat_m4q8x2k7v1c9d3e6/zip?part=1',
      file: 'https://linktocard.com/v1/batches/bat_m4q8x2k7v1c9d3e6/zip?part=1',
    },
  ],
  finished: true,
  zip_part_count: 1,
  zip_file: 'https://linktocard.com/v1/batches/bat_m4q8x2k7v1c9d3e6/zip?part=1',
};

/** @type {OutputField[]} What POST /v1/batches and GET /v1/batches/{id} both answer. */
const BATCH_OUTPUT_FIELDS = [
  { key: 'id', label: 'Batch ID' },
  { key: 'status', label: 'Status' },
  { key: 'template', label: 'Template' },
  { key: 'verify', label: 'Certificate Verification', type: 'boolean' },
  { key: 'total', label: 'Documents', type: 'integer' },
  { key: 'counts__queued', label: 'Documents Queued', type: 'integer' },
  { key: 'counts__running', label: 'Documents Running', type: 'integer' },
  { key: 'counts__done', label: 'Documents Done', type: 'integer' },
  { key: 'counts__failed', label: 'Documents Failed', type: 'integer' },
  { key: 'counts__cancelled', label: 'Documents Cancelled', type: 'integer' },
  { key: 'pages', label: 'Pages Made', type: 'integer' },
  { key: 'credits_used', label: 'Images Counted', type: 'integer' },
  { key: 'created_at', label: 'Created At', type: 'datetime' },
  { key: 'started_at', label: 'Started At', type: 'datetime' },
  { key: 'finished_at', label: 'Finished At', type: 'datetime' },
  { key: 'cancelled_at', label: 'Cancelled At', type: 'datetime' },
];

module.exports = { SAMPLE_USAGE, SAMPLE_IMAGE, SAMPLE_PDF, SAMPLE_BATCH_STARTED, SAMPLE_BATCH, BATCH_OUTPUT_FIELDS, IMAGE_OUTPUT_FIELDS, USAGE_OUTPUT_FIELDS };

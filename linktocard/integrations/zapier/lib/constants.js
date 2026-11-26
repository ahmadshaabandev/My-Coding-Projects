'use strict';

/**
 * Fixed choices of the Link To Card API that no endpoint lists.
 *
 * The Zapier app is uploaded to Zapier on its own, so it cannot import the Worker's TypeScript
 * (src/config.ts, src/pdf/templates). These are copies, in the Worker's own shape where it has
 * one. tests/node/zapier-connector-sync.test.ts in the Worker compares every value here with
 * the source and fails when they drift apart: change the Worker first, then this file.
 *
 * Card starter templates are not copied: GET /v1/templates lists them with their fields.
 */

/** Where the API lives unless the LTC_BASE_URL environment variable says otherwise (lib/base-url.js). */
const DEFAULT_BASE_URL = 'https://linktocard.com';

/** src/config.ts SIZES, in that order. */
const CARD_SIZES = [
  { id: 'og', label: 'Open Graph', width: 1200, height: 630 },
  { id: 'square', label: 'Square', width: 1080, height: 1080 },
  { id: 'portrait', label: 'Portrait', width: 1080, height: 1350 },
  { id: 'email', label: 'Email', width: 1200, height: 400 },
];

/** src/config.ts DEFAULT_SIZE. */
const DEFAULT_CARD_SIZE = 'og';

/** src/config.ts FORMATS, in that order, and DEFAULT_FORMAT. */
const IMAGE_FORMATS = [
  { id: 'png', label: 'PNG' },
  { id: 'jpeg', label: 'JPEG' },
  { id: 'webp', label: 'WebP' },
];
const DEFAULT_IMAGE_FORMAT = 'png';

/** src/config.ts PDF.formats, in that order, and PDF.defaultFormat (used when a template sets no page). */
const PDF_PAGE_FORMATS = [
  { id: 'a4', label: 'A4' },
  { id: 'letter', label: 'US Letter' },
  { id: 'a5', label: 'A5' },
];
const DEFAULT_PDF_PAGE_FORMAT = 'a4';

/** src/config.ts LINK_CARDS.defaultTemplate: what POST /v1/cards/from-url uses without a template. */
const DEFAULT_LINK_CARD_TEMPLATE = 'blog';

/**
 * src/pdf/templates PDF_TEMPLATES: id, name and fields (key, label, kind, required, itemFields).
 * GET /v1/templates lists card starters only, so the PDF starters and their fields live here.
 */
const PDF_STARTER_TEMPLATES = [
  {
    id: 'invoice',
    name: 'Invoice',
    fields: [
      { key: 'seller_name', label: 'Seller name', kind: 'text', required: true },
      { key: 'seller_address', label: 'Seller address', kind: 'text', required: false },
      { key: 'seller_email', label: 'Seller email', kind: 'text', required: false },
      { key: 'seller_tax_id', label: 'Seller tax ID', kind: 'text', required: false },
      { key: 'logo_url', label: 'Logo URL', kind: 'text', required: false },
      { key: 'buyer_name', label: 'Buyer name', kind: 'text', required: true },
      { key: 'buyer_address', label: 'Buyer address', kind: 'text', required: false },
      { key: 'buyer_email', label: 'Buyer email', kind: 'text', required: false },
      { key: 'invoice_number', label: 'Invoice number', kind: 'text', required: true },
      { key: 'issue_date', label: 'Issue date', kind: 'text', required: true },
      { key: 'due_date', label: 'Due date', kind: 'text', required: false },
      { key: 'currency', label: 'Currency', kind: 'text', required: false },
      { key: 'items', label: 'Line items', kind: 'items', required: true, itemFields: ['description', 'quantity', 'unit_price', 'amount'] },
      { key: 'subtotal', label: 'Subtotal', kind: 'text', required: false },
      { key: 'tax_label', label: 'Tax label', kind: 'text', required: false },
      { key: 'tax', label: 'Tax', kind: 'text', required: false },
      { key: 'total', label: 'Total', kind: 'text', required: true },
      { key: 'payment_terms', label: 'Payment terms', kind: 'text', required: false },
      { key: 'notes', label: 'Notes', kind: 'text', required: false },
    ],
  },
  {
    id: 'receipt',
    name: 'Receipt',
    fields: [
      { key: 'seller_name', label: 'Seller name', kind: 'text', required: true },
      { key: 'seller_address', label: 'Seller address', kind: 'text', required: false },
      { key: 'seller_email', label: 'Seller email', kind: 'text', required: false },
      { key: 'logo_url', label: 'Logo URL', kind: 'text', required: false },
      { key: 'receipt_number', label: 'Receipt number', kind: 'text', required: true },
      { key: 'date', label: 'Date', kind: 'text', required: true },
      { key: 'buyer_name', label: 'Paid by', kind: 'text', required: false },
      { key: 'payment_method', label: 'Payment method', kind: 'text', required: false },
      { key: 'currency', label: 'Currency', kind: 'text', required: false },
      { key: 'items', label: 'Items', kind: 'items', required: true, itemFields: ['description', 'quantity', 'amount'] },
      { key: 'subtotal', label: 'Subtotal', kind: 'text', required: false },
      { key: 'tax_label', label: 'Tax label', kind: 'text', required: false },
      { key: 'tax', label: 'Tax', kind: 'text', required: false },
      { key: 'total', label: 'Total paid', kind: 'text', required: true },
      { key: 'notes', label: 'Notes', kind: 'text', required: false },
    ],
  },
  {
    id: 'quote',
    name: 'Quote (estimate)',
    fields: [
      { key: 'seller_name', label: 'Seller name', kind: 'text', required: true },
      { key: 'seller_address', label: 'Seller address', kind: 'text', required: false },
      { key: 'seller_email', label: 'Seller email', kind: 'text', required: false },
      { key: 'logo_url', label: 'Logo URL', kind: 'text', required: false },
      { key: 'buyer_name', label: 'Prepared for', kind: 'text', required: true },
      { key: 'buyer_address', label: 'Buyer address', kind: 'text', required: false },
      { key: 'quote_number', label: 'Quote number', kind: 'text', required: true },
      { key: 'issue_date', label: 'Issue date', kind: 'text', required: true },
      { key: 'valid_until', label: 'Valid until', kind: 'text', required: false },
      { key: 'currency', label: 'Currency', kind: 'text', required: false },
      { key: 'items', label: 'Line items', kind: 'items', required: true, itemFields: ['description', 'quantity', 'unit_price', 'amount'] },
      { key: 'subtotal', label: 'Subtotal', kind: 'text', required: false },
      { key: 'tax_label', label: 'Tax label', kind: 'text', required: false },
      { key: 'tax', label: 'Tax', kind: 'text', required: false },
      { key: 'total', label: 'Total', kind: 'text', required: true },
      { key: 'terms', label: 'Terms', kind: 'text', required: false },
      { key: 'notes', label: 'Notes', kind: 'text', required: false },
    ],
  },
  {
    id: 'certificate',
    name: 'Certificate of completion',
    fields: [
      { key: 'title', label: 'Title', kind: 'text', required: true },
      { key: 'recipient_name', label: 'Recipient name', kind: 'text', required: true },
      { key: 'achievement', label: 'Achievement', kind: 'text', required: true },
      { key: 'issuer_name', label: 'Issuer name', kind: 'text', required: true },
      { key: 'date', label: 'Date', kind: 'text', required: true },
      { key: 'signer_name', label: 'Signer name', kind: 'text', required: false },
      { key: 'signer_title', label: 'Signer title', kind: 'text', required: false },
      { key: 'certificate_id', label: 'Certificate ID', kind: 'text', required: false },
      { key: 'logo_url', label: 'Logo URL', kind: 'text', required: false },
    ],
  },
  {
    id: 'report',
    name: 'Report',
    fields: [
      { key: 'title', label: 'Title', kind: 'text', required: true },
      { key: 'subtitle', label: 'Subtitle', kind: 'text', required: false },
      { key: 'author', label: 'Author', kind: 'text', required: false },
      { key: 'date', label: 'Date', kind: 'text', required: false },
      { key: 'summary', label: 'Summary', kind: 'text', required: false },
      { key: 'items', label: 'Sections', kind: 'items', required: false, itemFields: ['heading', 'body'] },
      { key: 'footer_note', label: 'Footer note', kind: 'text', required: false },
    ],
  },
];

/**
 * Keys a batch with verification fills in for every row (certificate ID, its page and a QR code).
 * POST /v1/batches refuses a row that brings its own, so the batch form does not offer them
 * unless verification is switched off.
 */
const VERIFY_KEYS = ['certificate_id', 'verify_url', 'verify_qr'];

/**
 * The largest file z.stashFile accepts: UPLOAD_MAX_SIZE in zapier-platform-core 19.3.0
 * (src/constants.js, "1GB, in zapier backend too"); larger streams are refused before upload.
 * test/get-batch.test.mjs compares it with the installed core. A batch ZIP part can be up to
 * 2 GiB (the API's limit), so Find Batch offers no file for a part above this.
 */
const ZAPIER_MAX_FILE_BYTES = 1000 * 1000 * 1000;

/** Batch statuses after which nothing changes any more. */
const BATCH_FINAL_STATUSES = ['done', 'partial', 'failed', 'cancelled'];

module.exports = {
  DEFAULT_BASE_URL,
  CARD_SIZES,
  DEFAULT_CARD_SIZE,
  IMAGE_FORMATS,
  DEFAULT_IMAGE_FORMAT,
  PDF_PAGE_FORMATS,
  DEFAULT_PDF_PAGE_FORMAT,
  DEFAULT_LINK_CARD_TEMPLATE,
  PDF_STARTER_TEMPLATES,
  VERIFY_KEYS,
  ZAPIER_MAX_FILE_BYTES,
  BATCH_FINAL_STATUSES,
};

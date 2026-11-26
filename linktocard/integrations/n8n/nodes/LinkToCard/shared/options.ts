import type { INodePropertyOptions } from 'n8n-workflow';

/*
 * The fixed choices the Link To Card API accepts. They mirror SIZES, FORMATS and PDF.formats in
 * the service's src/config.ts; tests/node/n8n-connector-sync.test.ts in the service repository
 * fails when the two drift apart. This package is published on its own, so it cannot import them.
 */

/** "size" of POST /v1/images and POST /v1/cards/from-url. */
export const CARD_SIZE_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Open Graph (1200×630)', value: 'og' },
	{ name: 'Square (1080×1080)', value: 'square' },
	{ name: 'Portrait (1080×1350)', value: 'portrait' },
	{ name: 'Email (1200×400)', value: 'email' },
];

/** "format" of card images. The API also accepts "jpg" for "jpeg". */
export const IMAGE_FORMAT_OPTIONS: INodePropertyOptions[] = [
	{ name: 'PNG', value: 'png' },
	{ name: 'JPEG', value: 'jpeg' },
	{ name: 'WebP', value: 'webp' },
];

/** "pdf.format" of POST /v1/pdf and POST /v1/batches. */
export const PDF_PAGE_FORMAT_OPTIONS: INodePropertyOptions[] = [
	{ name: 'A4', value: 'a4' },
	{ name: 'Letter', value: 'letter' },
	{ name: 'A5', value: 'a5' },
];

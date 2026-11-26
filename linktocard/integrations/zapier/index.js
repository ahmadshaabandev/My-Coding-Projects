'use strict';

/**
 * Link To Card on Zapier: the app definition the Zapier CLI builds and uploads
 * (`zapier-platform push`). Every action is one request to the public API under /v1 with the
 * connection's API key, so a Zap gets the same results, limits and counting as any API client.
 * See README.md for how it is registered, tested and published.
 */

const { authentication } = require('./lib/authentication');
const hydrators = require('./lib/hydrators');
const { handleErrors, includeApiKey } = require('./lib/middleware');
const cardFromLink = require('./creates/card_from_link');
const createCardImage = require('./creates/create_card_image');
const createPdf = require('./creates/create_pdf');
const startBulkPdfs = require('./creates/start_bulk_pdfs');
const checkLinkPreview = require('./searches/check_link_preview');
const getBatch = require('./searches/get_batch');

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,

  authentication,
  beforeRequest: [includeApiKey],
  afterResponse: [handleErrors],
  hydrators,

  triggers: {},
  creates: {
    [createCardImage.key]: createCardImage,
    [createPdf.key]: createPdf,
    [cardFromLink.key]: cardFromLink,
    [startBulkPdfs.key]: startBulkPdfs,
  },
  searches: {
    [getBatch.key]: getBatch,
    [checkLinkPreview.key]: checkLinkPreview,
  },
};

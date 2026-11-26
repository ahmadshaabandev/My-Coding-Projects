'use strict';

const { postJson } = require('../lib/api');
const { cardValue, collectData, optionalText } = require('../lib/data');
const { inputError } = require('../lib/errors');
const { DEFAULT_LINK_CARD_TEMPLATE } = require('../lib/constants');
const { cardTemplateChoices, formatField, sizeField } = require('../lib/fields');
const hydrators = require('../lib/hydrators');
const { IMAGE_OUTPUT_FIELDS, SAMPLE_IMAGE } = require('../lib/outputs');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */
/** @typedef {import('zapier-platform-core').Bundle} Bundle */

/**
 * POST /v1/cards/from-url: the API reads the page (the link checker's rules, cache and daily
 * limit) and fills the template from its title, description, site name and icon. Without a
 * template the API picks its default; Overrides replace what the page says.
 *
 * @param {ZObject} z
 * @param {Bundle} bundle
 */
async function perform(z, bundle) {
  const input = bundle.inputData;
  const url = optionalText(input.url);
  if (url === undefined) throw inputError('Fill in the Page URL.');
  const template = optionalText(input.template);
  const size = optionalText(input.size);
  const format = optionalText(input.format);
  const overrides = collectData({ data: input.overrides }, cardValue);

  const response = await postJson(z, '/v1/cards/from-url', {
    url,
    ...(template === undefined ? {} : { template }),
    ...(Object.keys(overrides).length === 0 ? {} : { data: overrides }),
    ...(size === undefined ? {} : { size }),
    ...(format === undefined ? {} : { format }),
  });
  const card = response.data;
  return { ...card, file: z.dehydrateFile(hydrators.downloadFile, { url: card.url }) };
}

const SAMPLE_LINK_CARD = {
  ...SAMPLE_IMAGE,
  link: {
    url: 'https://fieldnotes.example/design-for-the-first-glance',
    final_url: 'https://fieldnotes.example/design-for-the-first-glance',
    check_id: 'chk_7q2m9x4k1v8c3d6e',
    check_cached: false,
    data: {
      title: 'Design for the first glance',
      description: 'What people notice before they read a single word.',
      site: 'fieldnotes.example',
    },
  },
};

module.exports = {
  key: 'card_from_link',
  noun: 'Card',
  display: {
    label: 'Create Card From Link',
    description: "Makes a card image from a web page's own title, description, site name and icon. Returns its link and the file.",
  },
  operation: {
    inputFields: [
      { key: 'url', label: 'Page URL', required: true, helpText: 'The `https://` address of the page, for example a new blog post.' },
      {
        key: 'template',
        label: 'Template',
        choices: { perform: cardTemplateChoices },
        helpText: `A starter template or one of your own. Leave empty for the \`${DEFAULT_LINK_CARD_TEMPLATE}\` starter template.`,
      },
      {
        key: 'overrides',
        label: 'Overrides',
        dict: true,
        helpText: 'Template fields to set yourself, as key and value, for example `title` and a shorter headline. They replace what the page says.',
      },
      sizeField(),
      formatField(),
    ],
    perform,
    sample: SAMPLE_LINK_CARD,
    outputFields: [
      ...IMAGE_OUTPUT_FIELDS,
      { key: 'link__url', label: 'Page URL' },
      { key: 'link__final_url', label: 'Page URL After Redirects' },
      { key: 'link__data__title', label: 'Title Used' },
      { key: 'link__data__description', label: 'Description Used' },
    ],
  },
};

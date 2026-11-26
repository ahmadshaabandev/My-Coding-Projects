'use strict';

const { postJson } = require('../lib/api');
const { cardValue, collectData, optionalText } = require('../lib/data');
const { inputError } = require('../lib/errors');
const { cardDataFields, cardTemplateChoices, dataDictField, formatField, sizeField } = require('../lib/fields');
const hydrators = require('../lib/hydrators');
const { IMAGE_OUTPUT_FIELDS, SAMPLE_IMAGE } = require('../lib/outputs');

/** @typedef {import('zapier-platform-core').ZObject} ZObject */
/** @typedef {import('zapier-platform-core').Bundle} Bundle */

/**
 * POST /v1/images: one card from a template and data. The answer is returned as it is, plus a
 * `file` that later steps can upload: a pointer Zapier resolves only when it is used.
 *
 * @param {ZObject} z
 * @param {Bundle} bundle
 */
async function perform(z, bundle) {
  const input = bundle.inputData;
  const template = optionalText(input.template);
  if (template === undefined) throw inputError('Pick a Template.');
  const size = optionalText(input.size);
  const format = optionalText(input.format);

  const response = await postJson(z, '/v1/images', {
    template,
    data: collectData(input, cardValue),
    ...(size === undefined ? {} : { size }),
    ...(format === undefined ? {} : { format }),
  });
  const image = response.data;
  return { ...image, file: z.dehydrateFile(hydrators.downloadFile, { url: image.url }) };
}

module.exports = {
  key: 'create_card_image',
  noun: 'Card Image',
  display: {
    label: 'Create Card Image',
    description:
      'Renders a card image, such as an Open Graph image, from a starter template or one of your own templates and your data. Returns its link and the file. The same card again is served from storage and counts nothing while it is stored.',
  },
  operation: {
    inputFields: [
      {
        key: 'template',
        label: 'Template',
        required: true,
        altersDynamicFields: true,
        choices: { perform: cardTemplateChoices },
        helpText: "A starter template or one of your own. A starter template shows its fields below; for your own templates use **Data**.",
      },
      cardDataFields,
      dataDictField(),
      sizeField(),
      formatField(),
    ],
    perform,
    sample: SAMPLE_IMAGE,
    outputFields: IMAGE_OUTPUT_FIELDS,
  },
};

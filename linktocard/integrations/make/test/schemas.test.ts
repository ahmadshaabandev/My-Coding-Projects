// Every file of app/ against the JSON schemas Make's Apps Editor for VS Code checks them with
// (vendored in test/vendor/make-apps-editor, see SOURCE.md there). The file-name-to-schema rules
// mirror the editor's package.json "contributes.jsonValidation" for *.iml.json files.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { readJson, referencedFiles, type Json, type JsonObject } from './helpers';

const VENDOR = fileURLToPath(new URL('./vendor/make-apps-editor/', import.meta.url));

// ajv-formats is CommonJS with a default export; under NodeNext it arrives as the module object.
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as (ajv: Ajv) => Ajv;

function compileAll(): Ajv {
  // unicodeRegExp: false because response.json has the pattern "\-", which is not valid with the
  // "u" flag; strict: false because the editor's schemas use keywords Ajv's strict mode refuses
  // (for example "markdownDescription" for VS Code hovers).
  const ajv = new Ajv({ strict: false, allErrors: true, unicodeRegExp: false });
  addFormats(ajv);
  const dir = path.join(VENDOR, 'imljson');
  for (const file of readdirSync(dir)) ajv.addSchema(JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as object, file);
  ajv.addSchema(JSON.parse(readFileSync(path.join(VENDOR, 'local-development/makecomapp.schema.json'), 'utf8')) as object, 'makecomapp.schema.json');
  return ajv;
}

const ajv = compileAll();
const schema = (id: string): ValidateFunction => {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`schema ${id} is missing`);
  return validate;
};

/** File name -> schema, in the editor's order (the first match wins). */
const RULES: ReadonlyArray<[RegExp, string]> = [
  [/\.oauth-communication\.iml\.jsonc?$/, 'api-oauth.json'],
  [/\.communication\.iml\.jsonc?$/, 'api.json'],
  [/\.(params|static-params|mappable-params|interface)\.iml\.jsonc?$/, 'parameters.json'],
  [/\.samples\.iml\.jsonc?$/, 'samples.json'],
  [/\.epoch\.iml\.jsonc?$/, 'epoch.json'],
  [/(^|\/)base\.iml\.jsonc?$/, 'base.json'],
  [/(^|\/)groups\.json$/, 'groups.json'],
];

/**
 * The one deliberate exception. The universal module sends the user's headers and query string
 * the way Make's documentation describes it, as one expression that builds a collection
 * ("{{toCollection(parameters.headers, 'key', 'value')}}"); the editor's schema only allows an
 * object there (sources.json "headers" and "qs"). The two values are checked exactly here and left
 * out of the schema check; everything else in that file is still validated.
 */
const UNIVERSAL_FILE = 'modules/make-api-call/make-api-call.communication.iml.json';
const UNIVERSAL_EXPRESSIONS: Record<string, string> = {
  headers: "{{toCollection(parameters.headers, 'key', 'value')}}",
  qs: "{{toCollection(parameters.qs, 'key', 'value')}}",
};

function errorsOf(validate: ValidateFunction, data: Json): string {
  return validate(data) ? '' : JSON.stringify(validate.errors, null, 1);
}

describe('Make Apps Editor schemas', () => {
  it('makecomapp.json matches the local-development project schema', () => {
    expect(errorsOf(schema('makecomapp.schema.json'), readJson('makecomapp.json'))).toBe('');
  });

  const files = referencedFiles().filter((file) => file !== 'README.md');
  it.each(files)('%s', (file) => {
    const rule = RULES.find(([pattern]) => pattern.test(file));
    expect(rule, `no schema rule for ${file}`).toBeDefined();
    let data = readJson<Json>(file);
    if (file === UNIVERSAL_FILE) {
      const request = data as JsonObject;
      for (const [key, expression] of Object.entries(UNIVERSAL_EXPRESSIONS)) {
        expect(request[key]).toBe(expression);
      }
      data = Object.fromEntries(Object.entries(request).filter(([key]) => !(key in UNIVERSAL_EXPRESSIONS)));
    }
    expect(errorsOf(schema(rule![1]), data)).toBe('');
  });

  it('the exception is needed: the editor schema refuses the documented universal-module form', () => {
    expect(schema('api.json')(readJson(UNIVERSAL_FILE))).toBe(false);
  });

  it('the schemas do catch mistakes (a module request without a URL, an unknown parameter key)', () => {
    expect(schema('api.json')({ method: 'POST', body: {} })).toBe(false);
    expect(schema('parameters.json')([{ name: 'x', type: 'text', lable: 'typo' }])).toBe(false);
    expect(schema('makecomapp.schema.json')({ fileVersion: 1 })).toBe(false);
  });
});

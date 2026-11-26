// Every request the app sends is one the Link To Card API answers: the method and path of the
// operation (test/api-contract.json), only body keys the API accepts (it refuses unknown ones),
// the keys it needs, and the API key in the Authorization header. A module may follow its API call
// with a download of the file the API just stored; that request goes to the URL the API returned.
import { describe, expect, it } from 'vitest';
import contractJson from './api-contract.json' with { type: 'json' };
import { base, connection, moduleById, modules, parameterNames, requests, rpcs, type Json, type JsonObject, type Module, type Request } from './helpers';

interface Operation {
  method: 'GET' | 'POST';
  path: string;
  body?: string[];
  required?: string[];
  page?: string[];
  query?: string[];
}
const contract = contractJson as unknown as {
  baseUrl: string;
  operations: Record<string, Operation>;
  connection: string;
  rpcs: Record<string, string>;
  modules: Record<string, string[]>;
};

/** "/v1/batches/{{parameters.id}}" -> "/v1/batches/{}" and the parameters used in the path. */
function pathShape(url: string): { shape: string; params: string[] } {
  const params = [...url.matchAll(/\{\{parameters\.([A-Za-z]+)\}\}/g)].map((match) => match[1] as string);
  return { shape: url.replace(/\{\{parameters\.[A-Za-z]+\}\}/g, '{}'), params };
}
const openApiShape = (path: string): string => path.replace(/\{[a-z_]+\}/g, '{}');

const keysOf = (value: Json | undefined): string[] => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []);

/** The temp variable a request keeps its answer in: response.temp = { <name>: "{{body}}" }. */
function tempName(request: Request): string {
  const temp = (request.response as JsonObject | undefined)?.temp as JsonObject | undefined;
  const names = keysOf(temp);
  expect(names).toHaveLength(1);
  expect(temp![names[0]!]).toBe('{{body}}');
  return names[0]!;
}

function checkApiRequest(module: Module | null, request: Request, operation: Operation, label: string): void {
  expect(request.method, label).toBe(operation.method);
  const url = String(request.url);
  expect(url.startsWith('/'), `${label}: relative to the base URL`).toBe(true);
  const { shape, params } = pathShape(url);
  expect(shape, label).toBe(openApiShape(operation.path));
  if (module) {
    const names = parameterNames([...module.staticParams, ...module.mappableParams]);
    for (const name of params) expect(names.has(name), `${label}: path parameter ${name}`).toBe(true);
  }

  const body = request.body as JsonObject | undefined;
  if (operation.method === 'GET') {
    expect(body, `${label}: a GET has no body`).toBeUndefined();
  } else {
    const keys = keysOf(body);
    for (const key of keys) expect(operation.body, `${label}: body key ${key}`).toContain(key);
    for (const key of operation.required ?? []) expect(keys, `${label}: needs ${key}`).toContain(key);
    for (const key of keysOf(body?.pdf)) expect(operation.page, `${label}: pdf.${key}`).toContain(key);
    // Make evaluates {{...}} in mapped text, so inline HTML would lose its placeholders: the app
    // sends template ids only (the docs page says the same for HTTP modules).
    expect(keys).not.toContain('html');
    expect(keys).not.toContain('css');
    // JSON answers only; files are fetched from the stored URL (see the download request).
    expect(keys).not.toContain('response');
  }
  expect(keysOf(request.qs).sort(), `${label}: query`).toEqual([...(operation.query ?? [])].sort());
  // Every request inherits the Authorization header from base; none sets its own.
  expect(keysOf(request.headers), label).toEqual([]);
}

describe('api-contract.json', () => {
  it('names a request list for every module, and only known operations', () => {
    expect(Object.keys(contract.modules).sort()).toEqual(modules.map((module) => module.id).sort());
    for (const steps of Object.values(contract.modules)) {
      for (const step of steps) if (step !== 'download' && step !== 'universal') expect(contract.operations[step], step).toBeDefined();
    }
  });
});

describe('base', () => {
  it('sends every module request to linktocard.com (or the connection\'s test address) with the API key', () => {
    expect(base.baseUrl).toBe(`{{ifempty(connection.apiUrl, '${contract.baseUrl}')}}`);
    expect(base.headers).toEqual({ authorization: 'Bearer {{connection.apiKey}}' });
  });

  it('keeps the API key out of Make\'s logs and shows the API\'s own error message and code', () => {
    expect(base.log).toEqual({ sanitize: ['request.headers.authorization'] });
    const error = (base.response as JsonObject).error as JsonObject;
    expect(error.message).toBe('[{{statusCode}}] {{body.error.message}} (error code: {{body.error.code}})');
    expect((error['401'] as JsonObject).type).toBe('InvalidAccessTokenError');
    expect((error['429'] as JsonObject).type).toBe('RateLimitError');
    for (const [key, value] of Object.entries(error)) {
      if (key === 'message') continue;
      expect(key).toMatch(/^[45]\d\d$/);
      expect((value as JsonObject).message).toBe(error.message);
    }
  });
});

describe('connection', () => {
  const operation = contract.operations[contract.connection]!;

  it('checks the key with GET /v1/usage, which counts nothing', () => {
    // A connection does not inherit base (the editor's AppsProvider.js), so it has the full URL and
    // its own header, both from the connection's own parameters.
    expect(connection.communication.method).toBe(operation.method);
    expect(connection.communication.url).toBe(`{{ifempty(parameters.apiUrl, '${contract.baseUrl}')}}${operation.path}`);
    expect(connection.communication.headers).toEqual({ authorization: 'Bearer {{parameters.apiKey}}' });
    expect(connection.communication.log).toEqual({ sanitize: ['request.headers.authorization'] });
    expect(((connection.communication.response as JsonObject).metadata as JsonObject).value).toBe('{{body.plan}} plan');
  });

  it('asks for the key as a password, and for the address only as an advanced field', () => {
    expect(connection.params.map((param) => param.name)).toEqual(['apiKey', 'apiUrl']);
    expect(connection.params[0]).toMatchObject({ type: 'password', required: true });
    expect(connection.params[1]).toMatchObject({ type: 'url', advanced: true, default: contract.baseUrl });
  });
});

describe('RPCs', () => {
  it.each(rpcs.map((rpc) => [rpc.id, rpc] as const))('%s lists templates with GET /v1/templates', (id, rpc) => {
    checkApiRequest(null, rpc.communication, contract.operations[contract.rpcs[id]!]!, id);
    const response = rpc.communication.response as JsonObject;
    expect(response.output).toEqual({ label: '{{item.name}}', value: '{{item.id}}' });
  });

  it('card templates are the starters and your own; own templates only yours (no endpoint lists PDF starters)', () => {
    const iterate = (id: string): Json | undefined => (rpcs.find((rpc) => rpc.id === id)!.communication.response as JsonObject).iterate;
    expect(iterate('listCardTemplates')).toBe('{{merge(body.starter, body.custom)}}');
    expect(iterate('listOwnTemplates')).toBe('{{body.custom}}');
  });
});

describe.each(modules.map((module) => [module.id, module] as const))('%s', (id, module) => {
  const steps = contract.modules[id]!;
  const list = requests(module.communication);

  it('sends the requests of its operations, in order', () => {
    expect(list).toHaveLength(steps.length);
  });

  it('each request matches the API contract', () => {
    steps.forEach((step, index) => {
      const request = list[index]!;
      const label = `${id} request ${index + 1} (${step})`;
      if (step === 'universal') {
        expect(request.url).toBe('/{{parameters.url}}');
        expect(request.method).toBe('{{parameters.method}}');
        return;
      }
      if (step === 'download') {
        // GET of the file the first request stored: its own URL, as JSON on errors, binary on 200.
        const name = tempName(list[0]!);
        expect(request.url, label).toBe(`{{temp.${name}.url}}`);
        expect(request.method, label).toBe('GET');
        expect(request.body, label).toBeUndefined();
        expect((request.response as JsonObject).type, label).toEqual({ '*': 'json', '200': 'binary' });
        return;
      }
      checkApiRequest(module, request, contract.operations[step]!, label);
    });
  });

  if (steps.length === 2) {
    it('downloads only when asked, and otherwise outputs the API answer unchanged', () => {
      const name = tempName(list[0]!);
      const second = list[1]!;
      const condition = second.condition as JsonObject;
      const flag = /^\{\{parameters\.([A-Za-z]+)\}\}$/.exec(String(condition.condition))?.[1];
      expect(flag, 'condition is one parameter').toBeDefined();
      const toggle = module.staticParams.find((param) => param.name === flag);
      expect(toggle, 'a static Yes/No parameter').toMatchObject({ type: 'boolean', required: true });
      expect(condition.default).toBe(`{{temp.${name}}}`);
      if (steps[1] === 'getBatchZip') {
        expect((second.response as JsonObject).type).toEqual({ '*': 'json', '200': 'binary' });
        // ?part=N (decision D9): part 1 unless the scenario names another one.
        expect(second.qs).toEqual({ part: '{{ifempty(parameters.zipPart, 1)}}' });
        expect(module.mappableParams.find((param) => param.name === 'zipPart')).toMatchObject({ type: 'uinteger', default: 1, validate: { min: 1 } });
      }
    });

    it('outputs every field its interface declares, from the API answer plus the file', () => {
      const name = tempName(list[0]!);
      const output = (list[1]!.response as JsonObject).output as JsonObject;
      expect(Object.keys(output).sort()).toEqual(module.interface.map((field) => field.name).sort());
      for (const [key, value] of Object.entries(output)) {
        if (key === 'data') expect(value).toBe('{{body}}');
        else if (key !== 'fileName') expect(value).toBe(`{{temp.${name}.${key}}}`);
      }
    });
  }
});

describe('file names of downloads', () => {
  it('a PDF keeps the name the API gave it; images are named by id and format; a zip by the batch id and part', () => {
    const fileName = (id: string): Json => ((requests(moduleById(id).communication)[1]!.response as JsonObject).output as JsonObject).fileName as Json;
    expect(fileName('createPdf')).toBe('{{temp.pdf.filename}}');
    expect(fileName('createCardImage')).toBe('{{temp.image.id}}.{{temp.image.format}}');
    expect(fileName('cardFromLink')).toBe('{{temp.card.id}}.{{temp.card.format}}');
    expect(fileName('getBatch')).toBe('{{temp.batch.id}}-part-{{ifempty(parameters.zipPart, 1)}}.zip');
  });
});

describe('optional fields are left out, never sent empty', () => {
  // The API treats only a missing key as "use the default": null or "" for size, format, filename
  // or pdf.format is refused (src/lib/images.ts parseSize/parseFormat, src/pdf/page.ts). Make drops
  // a body key whose expression gives undefined (Make's custom-app docs, "processing of input
  // parameters", from a search summary; to be confirmed in Make, README.md test plan step 3).
  const optional: Array<[string, string, string]> = [
    ['createCardImage', 'size', 'parameters.size'],
    ['createCardImage', 'format', 'parameters.format'],
    ['cardFromLink', 'template', 'parameters.template'],
    ['cardFromLink', 'size', 'parameters.size'],
    ['cardFromLink', 'format', 'parameters.format'],
    ['createPdf', 'filename', 'parameters.filename'],
    ['startBulkPdfs', 'verify', 'parameters.verify'],
  ];
  it.each(optional)('%s sends %s only when it is filled in', (id, key, expression) => {
    const body = requests(moduleById(id).communication)[0]!.body as JsonObject;
    expect(body[key]).toBe(`{{ifempty(${expression}, undefined)}}`);
  });

  it.each(['createPdf', 'startBulkPdfs'])('%s sends page size and orientation only when filled in', (id) => {
    const body = requests(moduleById(id).communication)[0]!.body as JsonObject;
    // When both are empty the body has "pdf": {}, which the API reads as "the template's own".
    expect(body.pdf).toEqual({ format: '{{ifempty(parameters.pageFormat, undefined)}}', landscape: '{{ifempty(parameters.landscape, undefined)}}' });
  });

  it('card data is always an object (the API refuses "data": null for cards)', () => {
    for (const [id, list] of [['createCardImage', 'data'], ['cardFromLink', 'overrides']] as const) {
      const body = requests(moduleById(id).communication)[0]!.body as JsonObject;
      expect(body.data).toBe(`{{toCollection(ifempty(parameters.${list}, emptyarray), 'key', 'value')}}`);
    }
  });

  it("the batch file name pattern turns [key] into the API's {{key}} without writing braces into IML", () => {
    const body = requests(moduleById('startBulkPdfs').communication)[0]!.body as JsonObject;
    // decodeURL('%7B%7B') is "{{" and decodeURL('%7D%7D') is "}}".
    expect(decodeURIComponent('%7B%7B')).toBe('{{');
    expect(decodeURIComponent('%7D%7D')).toBe('}}');
    expect(body.filename).toBe(
      "{{ifempty(replace(replace(ifempty(parameters.filename, emptystring), '[', decodeURL('%7B%7B')), ']', decodeURL('%7D%7D')), undefined)}}",
    );
  });
});

describe('the contract check itself', () => {
  const operation = contract.operations.createImage!;
  const good = requests(moduleById('createCardImage').communication)[0]!;
  const goodBody = good.body as JsonObject;
  const { template: _template, ...withoutTemplate } = goodBody;

  it('passes the real request', () => {
    expect(() => checkApiRequest(moduleById('createCardImage'), good, operation, 'probe')).not.toThrow();
  });

  it.each([
    ['a body key the API refuses', { ...good, body: { ...goodBody, colour: 'red' } }],
    ['inline HTML', { ...good, body: { ...goodBody, html: '<h1>{{title}}</h1>' } }],
    ['a missing required key', { ...good, body: withoutTemplate }],
    ['another method', { ...good, method: 'PUT' }],
    ['another path', { ...good, url: '/v1/image' }],
    ['an absolute URL that skips the base', { ...good, url: 'https://linktocard.com/v1/images' }],
    ['a header of its own', { ...good, headers: { authorization: 'Bearer ltc_x' } }],
  ] as Array<[string, Request]>)('refuses %s', (_name, request) => {
    expect(() => checkApiRequest(moduleById('createCardImage'), request, operation, 'probe')).toThrow();
  });
});

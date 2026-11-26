// A static check of every IML expression ("{{...}}") in the app. Make's IML engine is not
// available outside Make (the @integromat/iml package cannot be downloaded from the public npm
// registry), so this checks what can be checked without it:
//   - only built-in functions Make documents, and only the keywords the editor's IML grammar knows;
//   - every parameters.<name> is a parameter of that component, every connection.<name> a
//     connection parameter, every temp.<name> set by an earlier request of the same module;
//   - body, headers, statusCode only inside a response; item only where a response iterates;
//   - one argument style everywhere (", " and 'single quotes'), so switching it after the first
//     test in Make (README.md, test plan step 2) is one search and replace;
//   - no braces outside expressions, where Make could take text for an expression.
import { describe, expect, it } from 'vitest';
import { base, connection, eachString, imlExpressions, modules, parameterNames, requests, rpcs, type Json, type JsonObject, type Param } from './helpers';

/**
 * Built-in IML functions the app uses. Each is in Make's own list of built-in functions
 * (@makehq/skills 2.0.1, skills/make-scenario-building/references/iml-functions.md).
 */
const FUNCTIONS = new Set(['ifempty', 'toCollection', 'merge', 'replace', 'decodeURL', 'length', 'map']);
/** Keywords of the editor's IML grammar (syntaxes/iml/iml.tmLanguage in integromat/vscode-apps-sdk). */
const KEYWORDS = new Set(['undefined', 'emptyarray', 'emptystring']);
/** Context variables of the same grammar that the app reads. */
const RESPONSE_VARIABLES = new Set(['body', 'headers', 'statusCode']);

type Where = 'request' | 'response' | 'iterate';

interface Scope {
  label: string;
  parameters: Set<string>;
  /** connection.<name> is readable (modules, RPCs and base; not the connection itself). */
  connection: boolean;
  temps: Set<string>;
}

const connectionParams = new Set(connection.params.map((param) => param.name as string));

/** Splits an expression into identifiers and dotted paths, leaving out quoted strings. */
function tokens(expression: string): string[] {
  const withoutStrings = expression.replace(/'[^']*'/g, "''");
  return [...withoutStrings.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)].map((match) => match[0]);
}

function checkExpression(expression: string, where: Where, scope: Scope, at: string): void {
  const label = `${scope.label} ${at}: {{${expression}}}`;
  expect(expression, label).toBe(expression.trim());
  expect(expression, `${label}: no nested braces`).not.toMatch(/[{}]/);
  expect(expression, `${label}: single quotes only`).not.toContain('"');
  expect((expression.match(/'/g) ?? []).length % 2, `${label}: quotes balanced`).toBe(0);
  const bare = expression.replace(/'[^']*'/g, "''");
  expect((bare.match(/\(/g) ?? []).length, `${label}: parentheses balanced`).toBe((bare.match(/\)/g) ?? []).length);
  expect(bare, `${label}: arguments are separated by ", "`).not.toMatch(/;|,(?! )/);

  for (const call of bare.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\(/g)) expect(FUNCTIONS.has(call[1]!), `${label}: function ${call[1]}`).toBe(true);
  for (const token of tokens(expression)) {
    if (FUNCTIONS.has(token) && bare.includes(`${token}(`)) continue;
    const [head, name] = token.split('.') as [string, string | undefined];
    if (KEYWORDS.has(token)) continue;
    if (head === 'parameters') expect(scope.parameters.has(name ?? ''), `${label}: parameters.${name} is not a parameter`).toBe(true);
    else if (head === 'connection') {
      expect(scope.connection, `${label}: connection is not readable here`).toBe(true);
      expect(connectionParams.has(name ?? ''), `${label}: connection.${name}`).toBe(true);
    } else if (head === 'temp') expect(scope.temps.has(name ?? ''), `${label}: temp.${name} is set by an earlier request`).toBe(true);
    else if (RESPONSE_VARIABLES.has(head)) expect(where, `${label}: ${head} only in a response`).not.toBe('request');
    else if (head === 'item') expect(where, `${label}: item only where a response iterates`).toBe('iterate');
    else throw new Error(`${label}: unknown name "${token}"`);
  }
}

function checkStrings(value: Json | undefined, where: Where, scope: Scope, at: string): number {
  let count = 0;
  if (value === undefined) return 0;
  eachString(value, (text, path) => {
    const expressions = imlExpressions(text);
    // What is left once the expressions are taken out must hold no brace at all.
    expect(text.replace(/\{\{.*?\}\}/g, ''), `${scope.label} ${at}${path}: stray brace`).not.toMatch(/[{}]/);
    for (const expression of expressions) checkExpression(expression, where, scope, `${at}${path}`);
    count += expressions.length;
  });
  return count;
}

/** One request: everything but "response" is the request side; "iterate" and the rest are the response side. */
function checkRequest(request: JsonObject, scope: Scope, at: string): number {
  let count = 0;
  for (const [key, value] of Object.entries(request)) {
    if (key === 'response') {
      for (const [directive, part] of Object.entries(value as JsonObject)) {
        const where: Where = directive === 'iterate' || (directive === 'output' && 'iterate' in (value as JsonObject)) ? 'iterate' : 'response';
        count += checkStrings(part, where, scope, `${at}/response/${directive}`);
      }
    } else if (key === 'condition' && value && typeof value === 'object') {
      // condition.default is the module output when the condition is false: temp is readable there.
      count += checkStrings(value, 'request', scope, `${at}/condition`);
    } else count += checkStrings(value, 'request', scope, `${at}/${key}`);
  }
  return count;
}

/** Parameter definitions are not evaluated as IML: labels and help texts must not look like it. */
function checkNoBracesInDefinitions(params: Param[], label: string): void {
  eachString(params as unknown as Json, (text, path) => {
    if (text.startsWith('rpc://')) return;
    expect(text, `${label}${path}`).not.toMatch(/\{\{|\}\}/);
  });
}

describe('IML expressions', () => {
  let total = 0;

  it.each(modules.map((module) => [module.id, module] as const))('%s', (id, module) => {
    const names = parameterNames([...module.staticParams, ...module.mappableParams]);
    const scope: Scope = { label: id, parameters: names, connection: true, temps: new Set() };
    requests(module.communication).forEach((request, index) => {
      total += checkRequest(request, scope, `request ${index + 1}`);
      const temp = (request.response as JsonObject | undefined)?.temp;
      if (temp && typeof temp === 'object') for (const name of Object.keys(temp)) scope.temps.add(name);
    });
    for (const [name, list] of [['static', module.staticParams], ['mappable', module.mappableParams], ['interface', module.interface]] as const) {
      checkNoBracesInDefinitions(list, `${id} ${name}`);
    }
    checkStrings(module.samples, 'response', scope, 'samples');
  });

  it.each(rpcs.map((rpc) => [rpc.id, rpc] as const))('RPC %s', (id, rpc) => {
    total += checkRequest(rpc.communication, { label: id, parameters: parameterNames(rpc.params), connection: true, temps: new Set() }, 'request');
  });

  it('base', () => {
    total += checkRequest(base, { label: 'base', parameters: new Set(), connection: true, temps: new Set() }, 'base');
  });

  it('connection (reads its own parameters; it does not inherit base and has no connection variable)', () => {
    total += checkRequest(connection.communication, { label: 'connection', parameters: connectionParams, connection: false, temps: new Set() }, 'connection');
    checkNoBracesInDefinitions(connection.params, 'connection params');
  });

  it('found the expressions (the check is not vacuous)', () => {
    expect(total).toBeGreaterThan(100);
  });
});

describe('the checker itself', () => {
  const scope: Scope = { label: 'probe', parameters: new Set(['size']), connection: true, temps: new Set(['image']) };
  it.each([
    ['an unknown function', 'ifEmpty(parameters.size, undefined)'],
    ['a function Make does not have', 'removeEmpty(parameters.size)'],
    ['an unknown parameter', 'parameters.sise'],
    ['a temp nobody set', 'temp.pdf.url'],
    ['the scenario-mapper separator', "ifempty(parameters.size; 'og')"],
    ['double quotes', 'ifempty(parameters.size, "og")'],
    ['a response variable in a request', 'body.id'],
    ['item outside an iteration', 'item.id'],
  ])('refuses %s', (_name, expression) => {
    expect(() => checkExpression(expression, 'request', scope, 'probe')).toThrow();
  });

  it('accepts what the app writes', () => {
    expect(() => checkExpression("ifempty(parameters.size, undefined)", 'request', scope, 'probe')).not.toThrow();
    expect(() => checkExpression('temp.image.url', 'request', scope, 'probe')).not.toThrow();
    expect(() => checkExpression("length(map(body.checks, 'id', 'status', 'fail'))", 'response', scope, 'probe')).not.toThrow();
  });
});

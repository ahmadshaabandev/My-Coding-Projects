// Loads the Make app in app/ the way Make's Apps Editor for VS Code reads it: makecomapp.json lists
// every component and the path of each code file, relative to app/. Plain data, no Make runtime:
// none exists outside a Make account (see README.md, "What could not be tested here").
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
export const APP_DIR = path.join(PACKAGE_DIR, 'app');

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Param = JsonObject & { name?: string; type: string };

export interface ComponentMeta {
  label: string;
  description?: string;
  moduleType?: string;
  actionCrud?: string | null;
  connectionType?: string;
  connection?: string;
  codeFiles: Record<string, string | null>;
}

export interface Makecomapp {
  fileVersion: number;
  generalCodeFiles: Record<string, string | null>;
  components: Record<string, Record<string, ComponentMeta>>;
  origins: JsonObject[];
}

export interface Module {
  id: string;
  meta: ComponentMeta;
  communication: Json;
  staticParams: Param[];
  mappableParams: Param[];
  interface: Param[];
  samples: JsonObject;
}

export interface Request extends JsonObject {}

export const readText = (rel: string): string => readFileSync(path.join(APP_DIR, rel), 'utf8');

/** Strict JSON: the files are written without comments, so JSON.parse reads exactly what Make gets. */
export const readJson = <T = Json>(rel: string): T => JSON.parse(readText(rel)) as T;

export const manifest = readJson<Makecomapp>('makecomapp.json');

function code<T>(meta: ComponentMeta, name: string): T {
  const rel = meta.codeFiles[name];
  if (typeof rel !== 'string') throw new Error(`${meta.label}: code file "${name}" is not set`);
  return readJson<T>(rel);
}

export const modules: Module[] = Object.entries(manifest.components.module ?? {}).map(([id, meta]) => ({
  id,
  meta,
  communication: code<Json>(meta, 'communication'),
  staticParams: code<Param[]>(meta, 'staticParams'),
  mappableParams: code<Param[]>(meta, 'mappableParams'),
  interface: code<Param[]>(meta, 'interface'),
  samples: code<JsonObject>(meta, 'samples'),
}));

export function moduleById(id: string): Module {
  const found = modules.find((module) => module.id === id);
  if (!found) throw new Error(`no module ${id}`);
  return found;
}

export const connectionMeta = manifest.components.connection?.apiKey as ComponentMeta;
export const connection = {
  communication: code<Request>(connectionMeta, 'communication'),
  params: code<Param[]>(connectionMeta, 'params'),
};
export const base = readJson<Request>(manifest.generalCodeFiles.base as string);

export const rpcs = Object.entries(manifest.components.rpc ?? {}).map(([id, meta]) => ({
  id,
  meta,
  communication: code<Request>(meta, 'communication'),
  params: code<Param[]>(meta, 'params'),
}));

/** A communication is one request or a list of chained requests. */
export function requests(communication: Json): Request[] {
  if (Array.isArray(communication)) return communication as Request[];
  if (communication && typeof communication === 'object') return [communication as Request];
  throw new Error('communication must be an object or an array');
}

/** Every file under app/, relative to it, with "/" separators. */
export function appFiles(dir = APP_DIR): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? appFiles(full) : [path.relative(APP_DIR, full).split(path.sep).join('/')];
  });
}

/** Every code file makecomapp.json points at (general codes and components). */
export function referencedFiles(): string[] {
  const files = Object.values(manifest.generalCodeFiles).filter((file): file is string => typeof file === 'string');
  for (const components of Object.values(manifest.components)) {
    for (const meta of Object.values(components)) {
      for (const file of Object.values(meta.codeFiles)) if (typeof file === 'string') files.push(file);
    }
  }
  return files;
}

/**
 * The names a module can read as {{parameters.<name>}}: its static and mappable parameters, plus
 * the parameters nested under select options and boolean branches, which Make puts next to their
 * parent (a collection's own fields stay inside the collection's value).
 */
export function parameterNames(params: Param[]): Set<string> {
  const names = new Set<string>();
  const visit = (list: Json): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const param = item as Param;
      if (typeof param.name === 'string') names.add(param.name);
      if (Array.isArray(param.options)) {
        for (const option of param.options) {
          if (option && typeof option === 'object' && !Array.isArray(option)) visit((option as JsonObject).nested ?? null);
        }
      }
      if (param.nested && typeof param.nested === 'object') {
        visit(param.nested);
        if (!Array.isArray(param.nested)) for (const branch of Object.values(param.nested)) visit(branch);
      }
    }
  };
  visit(params);
  return names;
}

/** Visits every string in a JSON value with its JSON pointer-like path. */
export function eachString(value: Json, visit: (text: string, at: string) => void, at = ''): void {
  if (typeof value === 'string') visit(value, at);
  else if (Array.isArray(value)) value.forEach((item, index) => eachString(item, visit, `${at}/${index}`));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) eachString(item, visit, `${at}/${key}`);
}

/** The IML expressions of a string: what stands between "{{" and "}}". */
export function imlExpressions(text: string): string[] {
  return [...text.matchAll(/\{\{(.*?)\}\}/g)].map((match) => match[1] as string);
}

/** A select option list written in the file (not one an RPC loads). */
export function staticOptions(param: Param): Array<{ label: string; value: string; nested?: Param[] }> {
  if (!Array.isArray(param.options)) throw new Error(`${param.name}: options are not a static list`);
  return param.options as unknown as Array<{ label: string; value: string; nested?: Param[] }>;
}

export function param(list: Param[], name: string): Param {
  const found = list.find((item) => item.name === name);
  if (!found) throw new Error(`no parameter ${name}`);
  return found;
}

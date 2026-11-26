// The app's files are complete and in the layout Make's Apps Editor for VS Code reads
// (README-local-development-for-apps.md and src/local-development of integromat/vscode-apps-sdk):
// every file parses, makecomapp.json points at each one, names follow the editor's rules, and every
// component has the keys and code files its type needs.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_DIR, PACKAGE_DIR, appFiles, connectionMeta, manifest, modules, readJson, readText, referencedFiles, rpcs, type JsonObject } from './helpers';

/** src/local-development/helpers/validate-id.ts of the editor. */
const MODULE_OR_RPC_ID = /^[a-zA-Z][0-9a-zA-Z]{2,63}$/;
const CONNECTION_LOCAL_ID = /^[a-zA-Z][0-9a-zA-Z-]{1,33}[0-9a-zA-Z]$/;

/** "createCardImage" -> "create-card-image": the editor's folder and file names. */
const kebab = (id: string): string => id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Code files each component type has in local development (the editor's component-code-def.ts). */
const MODULE_CODES = ['communication', 'staticParams', 'mappableParams', 'interface', 'samples'];
const CODE_SUFFIX: Record<string, string> = {
  communication: 'communication',
  staticParams: 'static-params',
  mappableParams: 'mappable-params',
  interface: 'interface',
  samples: 'samples',
  params: 'params',
};

describe('files', () => {
  const files = appFiles();

  it('every JSON file parses as strict JSON (no comments) and is written as the editor writes it', () => {
    const json = files.filter((file) => file.endsWith('.json'));
    expect(json.length).toBeGreaterThan(40);
    for (const file of json) {
      const text = readText(file);
      const parsed = JSON.parse(text) as unknown; // throws on a comment or a trailing comma
      // 4-space indentation and a final newline, like JSON.stringify(x, null, 4) in the editor's
      // clone.ts, so a pull from Make produces no formatting diff.
      expect(text, file).toBe(`${JSON.stringify(parsed, null, 4)}\n`);
    }
  });

  it('code files use the released .iml.json naming (the editor 2.9.0 writes it; newer ones read it too)', () => {
    const code = files.filter((file) => file !== 'makecomapp.json' && file !== 'README.md' && file !== 'modules/groups.json');
    for (const file of code) expect(file, file).toMatch(/\.iml\.json$/);
    expect(files.filter((file) => file.endsWith('.jsonc'))).toEqual([]);
  });

  it('makecomapp.json points at every file, and every file it points at exists', () => {
    const referenced = referencedFiles();
    for (const file of referenced) expect(existsSync(path.join(APP_DIR, file)), file).toBe(true);
    expect([...files].sort()).toEqual(['makecomapp.json', ...referenced].sort());
    expect(new Set(referenced).size).toBe(referenced.length);
  });

  it('has the four general codes: base, readme and groups as files, no common data', () => {
    expect(manifest.fileVersion).toBe(1);
    expect(manifest.generalCodeFiles).toEqual({ base: 'general/base.iml.json', common: null, readme: 'README.md', groups: 'modules/groups.json' });
    expect(readText('README.md').trim().length).toBeGreaterThan(200);
  });

  it('ships without an origin: Deploy to Make offers "Deploy into another app" and writes one to fill in', () => {
    // src/local-development/deploy.ts calls askForOrigin(..., enableFeatureAddNewOrigin = true),
    // which appends an origin with "-FILL-ME-" values (makecomappjson.ts addEmptyOriginInMakecomappjson).
    // Once Ahmad has filled one in, it must name a real zone and app and keep the key out of the file.
    for (const origin of manifest.origins) {
      expect(String(origin.baseUrl)).toMatch(/^https:\/\/(eu1|eu2|us1|us2)\.make\.com\/api$/);
      expect(String(origin.apikeyFile)).toBe('../.secrets/apikey');
      expect(JSON.stringify(origin)).not.toContain('-FILL-ME-');
    }
  });
});

describe('icon', () => {
  it('assets/icon-512.png is the 512 x 512 PNG Make asks for (the Make API client checks it before an upload)', () => {
    // @makehq/sdk 1.19.0 setIcon: "The icon must be a 512x512 PNG". Drawn from the site's favicon.
    const png = readFileSync(path.join(PACKAGE_DIR, 'assets/icon-512.png'));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.toString('ascii', 12, 16)).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512]);
  });
});

describe('components', () => {
  it('has one API-key connection, seven modules and two RPCs, and nothing else', () => {
    expect(Object.keys(manifest.components).sort()).toEqual(['connection', 'endpoint', 'function', 'module', 'rpc', 'webhook']);
    expect(Object.keys(manifest.components.connection ?? {})).toEqual(['apiKey']);
    expect(connectionMeta.connectionType).toBe('basic');
    expect(modules.map((module) => module.id)).toEqual(['createCardImage', 'createPdf', 'cardFromLink', 'startBulkPdfs', 'getBatch', 'checkLinkPreview', 'makeApiCall']);
    expect(rpcs.map((rpc) => rpc.id)).toEqual(['listCardTemplates', 'listOwnTemplates']);
    // Custom IML functions cannot be deployed by external developers today (the editor's
    // src/local-development/deploy.ts), so the app must not depend on any.
    expect(manifest.components.function).toEqual({});
    expect(manifest.components.webhook).toEqual({});
    expect(manifest.components.endpoint).toEqual({});
  });

  it('ids follow the editor rules, and folders and files are named after them', () => {
    for (const id of Object.keys(manifest.components.connection ?? {})) expect(id).toMatch(CONNECTION_LOCAL_ID);
    for (const [type, components] of [['module', manifest.components.module], ['rpc', manifest.components.rpc], ['connection', manifest.components.connection]] as const) {
      for (const [id, meta] of Object.entries(components ?? {})) {
        if (type !== 'connection') expect(id).toMatch(MODULE_OR_RPC_ID);
        for (const [codeName, file] of Object.entries(meta.codeFiles)) {
          if (file === null) continue;
          expect(file, `${id} ${codeName}`).toBe(`${type}s/${kebab(id)}/${kebab(id)}.${CODE_SUFFIX[codeName]}.iml.json`);
        }
      }
    }
  });

  it('every module has a label, a description, its type and all five code files', () => {
    for (const { id, meta } of modules) {
      expect(meta.label.length, id).toBeGreaterThan(5);
      expect(meta.label, id).toMatch(/^[A-Z]/);
      expect(meta.description?.length ?? 0, id).toBeGreaterThan(40);
      expect(Object.keys(meta.codeFiles).sort(), id).toEqual([...MODULE_CODES].sort());
      expect(meta.connection, id).toBe('apiKey');
      if (meta.moduleType === 'action') expect(['create', 'read'], id).toContain(meta.actionCrud);
      else expect(meta.moduleType, id).toBe('universal');
    }
  });

  it('has exactly one universal module (Make\'s review asks for one, by search summaries of its docs; see README.md)', () => {
    expect(modules.filter((module) => module.meta.moduleType === 'universal').map((module) => module.id)).toEqual(['makeApiCall']);
  });

  it('every RPC and the connection use their own code files', () => {
    for (const rpc of rpcs) {
      expect(Object.keys(rpc.meta.codeFiles).sort()).toEqual(['communication', 'params']);
      expect(rpc.meta.connection).toBe('apiKey');
      expect(rpc.params).toEqual([]);
    }
    expect(connectionMeta.codeFiles).toEqual({
      communication: 'connections/api-key/api-key.communication.iml.json',
      params: 'connections/api-key/api-key.params.iml.json',
      common: null,
    });
  });

  it('groups.json puts every module in exactly one group', () => {
    const groups = readJson<Array<{ label: string; modules: string[] }>>('modules/groups.json');
    const grouped = groups.flatMap((group) => group.modules);
    expect([...grouped].sort()).toEqual(modules.map((module) => module.id).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const group of groups) expect(group.label.length).toBeGreaterThan(2);
  });

  it('every module has an interface, and samples only for fields it declares', () => {
    for (const module of modules) {
      const declared = new Set(module.interface.map((field) => field.name));
      expect(declared.size, module.id).toBeGreaterThan(2);
      for (const key of Object.keys(module.samples)) expect(declared.has(key), `${module.id} sample ${key}`).toBe(true);
    }
  });

  it('modules that return a file declare it with the file semantics later modules look for', () => {
    // The editor's own "filedata" snippet (syntaxes/imljson/snippets.json): filename + file:name, buffer + file:data.
    for (const id of ['createCardImage', 'createPdf', 'cardFromLink', 'getBatch']) {
      const module = modules.find((candidate) => candidate.id === id)!;
      const byName = Object.fromEntries(module.interface.map((field) => [field.name, field])) as Record<string, JsonObject>;
      expect(byName.fileName, id).toMatchObject({ type: 'filename', semantic: 'file:name' });
      expect(byName.data, id).toMatchObject({ type: 'buffer', semantic: 'file:data' });
    }
  });
});

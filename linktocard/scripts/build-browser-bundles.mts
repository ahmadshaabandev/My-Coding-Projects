/**
 * Browser bundles for the static site, made with the esbuild in node_modules:
 *
 *   site/src-browser/pdf-local.ts  ->  site/public/assets/js/vendor/pdf-local.js
 *
 *   npm run build:browser          (tsx scripts/build-browser-bundles.mts) writes them
 *
 * The site has no bundler on purpose: its page scripts are plain modules served as they are.
 * The in-browser PDF tools are the exception, because pdf-lib only ships as npm modules. The
 * bundle is built before scripts/build-site.ts runs, which copies site/public (and leaves the
 * bundle out of builds whose feature is off). It is a build output, so it is not committed.
 *
 * Each bundle is one minified ES module that imports nothing, for browsers with ES2020 (every
 * browser that runs <script type="module"> with dynamic import well). Its first comment says
 * what the file is and carries the name, version, licence and full licence text of every
 * third-party package esbuild put in it: pdf-lib and its dependencies are MIT, Zlib and 0BSD
 * licensed, and the MIT licence asks for its notice in every copy. Same sources, same lockfile,
 * same bytes: nothing time- or machine-dependent goes into the file.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, version as esbuildVersion, type Metafile, type Plugin } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface BrowserBundle {
  /** Source, relative to the repository root. */
  entry: string;
  /** Output, relative to the repository root. */
  out: string;
  /** One line for the banner. */
  description: string;
}

export const BROWSER_BUNDLES: readonly BrowserBundle[] = [
  {
    entry: 'site/src-browser/pdf-local.ts',
    out: 'site/public/assets/js/vendor/pdf-local.js',
    description: "Link To Card's in-browser PDF tools (merge PDFs, images to PDF). Your files are processed on your device by this code.",
  },
];

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  /** The package's licence file, verbatim. */
  licenseText: string;
}

export interface BundleResult {
  code: string;
  packages: BundledPackage[];
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

/** "node_modules/@pdf-lib/upng/x.js" -> the package directory and name (scoped names included). */
function packageOf(input: string): { dir: string; name: string } | null {
  const parts = input.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return null;
  const scoped = parts[at + 1]!.startsWith('@');
  const nameParts = parts.slice(at + 1, at + (scoped ? 3 : 2));
  return { dir: parts.slice(0, at + 1 + nameParts.length).join(sep), name: nameParts.join('/') };
}

/**
 * npm installs a package once per dependent when the root holds another version of it: this
 * repository's root has pako 0.2.9, so pdf-lib and its two helper packages each get their own
 * copy of pako 1.0.11, and esbuild would bundle all three (about 90 KB more). The same name and
 * version is the same code, so every import of it is pointed at one copy. Which copy is used
 * cannot change the output: the files are identical and the minified bundle names no paths.
 */
export function dedupePackages(): Plugin {
  return {
    name: 'dedupe-packages',
    setup(pluginBuild) {
      const chosen = new Map<string, string>();
      pluginBuild.onResolve({ filter: /^[^./]/ }, async (args) => {
        if (args.pluginData === 'dedupe-packages') return undefined;
        const resolved = await pluginBuild.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: 'dedupe-packages' });
        if (resolved.errors.length > 0) return { errors: resolved.errors };
        const found = resolved.external ? null : packageOf(resolved.path);
        let path = resolved.path;
        if (found) {
          const { version } = JSON.parse(readFileSync(join(found.dir, 'package.json'), 'utf8')) as { version?: string };
          const key = `${found.name}@${version ?? '?'}`;
          const dir = chosen.get(key) ?? found.dir;
          chosen.set(key, dir);
          path = join(dir, relative(found.dir, resolved.path));
        }
        return { path, namespace: resolved.namespace, external: resolved.external, sideEffects: resolved.sideEffects };
      });
    },
  };
}

/** Name, version, licence and licence text of every package that has code in the output. */
function bundledPackages(metafile: Metafile, cwd: string): BundledPackage[] {
  const output = Object.values(metafile.outputs)[0];
  if (!output) throw new Error('esbuild produced no output');
  const dirs = new Map<string, string>();
  for (const [input, info] of Object.entries(output.inputs)) {
    if (info.bytesInOutput === 0) continue;
    const found = packageOf(input);
    if (found) dirs.set(found.dir, found.name);
  }
  return [...dirs]
    .map(([dir, name]) => {
      const absolute = join(cwd, dir);
      const manifest = JSON.parse(readFileSync(join(absolute, 'package.json'), 'utf8')) as { name?: string; version?: string; license?: string };
      const file = readdirSync(absolute).find((entry) => LICENSE_FILE.test(entry));
      if (!file) throw new Error(`${name}: no licence file in ${dir}; a bundled package must ship one`);
      if (!manifest.version || !manifest.license) throw new Error(`${name}: package.json has no version or licence`);
      return { name: manifest.name ?? name, version: manifest.version, license: manifest.license, licenseText: readFileSync(join(absolute, file), 'utf8').trim() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The leading comment. "/*!" keeps it through any later minifier; a "*\/" inside a licence text would end it early, so it is defused. */
export function licenseBanner(bundle: BrowserBundle, packages: readonly BundledPackage[]): string {
  const line = (text: string): string => ` * ${text.replace(/\*\//g, '* /')}`.trimEnd();
  const lines = [
    `/*! ${relative('site/public', bundle.out).split(sep).join('/')}: ${bundle.description}`,
    line(`Built from ${bundle.entry} with esbuild ${esbuildVersion}. Third-party code in this file:`),
    ...packages.map((pkg) => line(`  ${pkg.name} ${pkg.version}: ${pkg.license}`)),
    ...packages.flatMap((pkg) => [' *', line(`----- ${pkg.name} ${pkg.version} -----`), ...pkg.licenseText.split(/\r?\n/).map(line)]),
    ' */',
  ];
  return `${lines.join('\n')}\n`;
}

/** Bundles one entry in memory: the minified code (banner first) and what went into it. */
export async function bundleBrowserCode(bundle: BrowserBundle, options: { root?: string } = {}): Promise<BundleResult> {
  const root = options.root ?? ROOT;
  const result = await build({
    absWorkingDir: root,
    entryPoints: [bundle.entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    // Licence comments are collected into the banner instead (complete texts, not fragments).
    legalComments: 'none',
    charset: 'utf8',
    metafile: true,
    write: false,
    logLevel: 'silent',
    plugins: [dedupePackages()],
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`${bundle.entry}: esbuild produced no output`);
  const packages = bundledPackages(result.metafile, root);
  return { code: licenseBanner(bundle, packages) + output.text, packages };
}

/** Writes every bundle; returns the paths written with their sizes. */
export async function buildBrowserBundles(options: { root?: string; outRoot?: string } = {}): Promise<Array<{ out: string; bytes: number; packages: string[] }>> {
  const root = options.root ?? ROOT;
  const outRoot = options.outRoot ?? root;
  const written: Array<{ out: string; bytes: number; packages: string[] }> = [];
  for (const bundle of BROWSER_BUNDLES) {
    const { code, packages } = await bundleBrowserCode(bundle, { root });
    const target = join(outRoot, bundle.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, code);
    written.push({ out: target, bytes: Buffer.byteLength(code), packages: packages.map((pkg) => `${pkg.name}@${pkg.version}`) });
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    for (const { out, bytes, packages } of await buildBrowserBundles()) {
      console.log(`Bundled ${relative(ROOT, out)} (${Math.round(bytes / 1024)} KB; ${packages.join(', ')})`);
    }
  } catch (error) {
    console.error(`Browser bundle failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

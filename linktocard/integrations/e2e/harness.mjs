// End-to-end harness shared by the Zapier, n8n and Make checks in this folder (README.md).
// Starts the real Worker of this repository under `wrangler dev` (local D1, R2, rate limiters and
// the real local queue with its consumer) from a generated copy of the top-level wrangler.toml
// section, plus one change: BROWSER is a service binding to a stand-in for Browser Run, written
// into the run's temporary folder, that answers quickAction('pdf') with a real Chrome PDF from
// tests/fixtures/pdf. Everything else, including the vars (every v3 switch "true"), is the
// repository's own development configuration. Nothing is deployed and nothing leaves this machine.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repository folder (linktocard/), two levels up from integrations/e2e. */
export const ROOT = path.resolve(HERE, '../..');

/** A stand-in for Browser Run: a WorkerEntrypoint whose quickAction('pdf') answers with a fixture PDF. */
const FAKE_BROWSER = `import { WorkerEntrypoint } from 'cloudflare:workers';
import onePage from './1-page.pdf';
import threePages from './3-pages.pdf';

export default class FakeBrowser extends WorkerEntrypoint {
  async quickAction(action, options) {
    if (action !== 'pdf') return new Response(JSON.stringify({ success: false, errors: [{ message: 'unexpected ' + action }] }), { status: 400 });
    // A document whose HTML contains THREE-PAGES gets the 3-page fixture.
    const bytes = String(options?.html ?? '').includes('THREE-PAGES') ? threePages : onePage;
    return new Response(bytes.slice(0), { status: 200, headers: { 'content-type': 'application/pdf', 'x-browser-ms-used': '321' } });
  }

  async fetch() {
    return new Response('stand-in browser', { status: 404 });
  }
}
`;
const FAKE_BROWSER_CONFIG = `name = "ltc-fake-browser"
main = "index.js"
compatibility_date = "2026-11-19"

[[rules]]
type = "Data"
globs = ["**/*.pdf"]
fallthrough = true
`;

export async function startWorker(root, port, { label = 'connector-e2e', browser = true } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const wranglerBin = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };
  const VARS = { APP_URL: base, SIGNING_MASTER_SECRET: 'e2e-master-secret-not-a-real-secret', PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_e2e_not_a_real_secret', RESEND_API_KEY: '' };

  // The top-level (development) part of wrangler.toml, with its relative paths made absolute.
  const source = readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
  const top = source.slice(0, source.indexOf('# ---------------------------------------------------------------- staging'));
  if (!top.includes('[vars]') || !top.includes('[[queues.consumers]]')) throw new Error('unexpected wrangler.toml layout');
  let config = top
    .replace(/^main = "src\/index\.ts"$/m, `main = "${path.join(root, 'src/index.ts')}"`)
    .replace(/^directory = "\.\/site\/dist"$/m, `directory = "${path.join(root, 'site/dist')}"`)
    .replace(/^migrations_dir = "src\/db\/migrations"$/m, `migrations_dir = "${path.join(root, 'src/db/migrations')}"`);
  for (const needle of [root + '/src/index.ts', root + '/site/dist', root + '/src/db/migrations']) if (!config.includes(needle)) throw new Error(`path not rewritten: ${needle}`);
  if (browser) config += `\n# e2e only: a stand-in for Browser Run\n[[services]]\nbinding = "BROWSER"\nservice = "ltc-fake-browser"\n`;

  const work = mkdtempSync(path.join(os.tmpdir(), `ltc-${label}-`));
  const configDir = path.join(work, 'config');
  mkdirSync(configDir);
  const configPath = path.join(configDir, 'wrangler.toml');
  writeFileSync(configPath, config);
  const persist = path.join(work, 'state');
  const browserDir = path.join(work, 'fake-browser');
  if (browser) {
    mkdirSync(browserDir);
    writeFileSync(path.join(browserDir, 'index.js'), FAKE_BROWSER);
    writeFileSync(path.join(browserDir, 'wrangler.toml'), FAKE_BROWSER_CONFIG);
    for (const name of ['1-page.pdf', '3-pages.pdf']) copyFileSync(path.join(root, 'tests/fixtures/pdf', name), path.join(browserDir, name));
  }

  const up = async () => {
    try {
      await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      return false;
    }
  };
  if (await up()) throw new Error(`port ${port} busy`);
  const mig = spawnSync(process.execPath, [wranglerBin, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persist, '-c', configPath], { cwd: configDir, env, encoding: 'utf8' });
  if (mig.status !== 0) throw new Error(`migrations: ${mig.stderr}\n${mig.stdout}`);

  const vars = Object.entries(VARS).flatMap(([k, v]) => ['--var', `${k}:${v}`]);
  const configs = ['-c', configPath, ...(browser ? ['-c', path.join(browserDir, 'wrangler.toml')] : [])];
  const child = spawn(process.execPath, [wranglerBin, 'dev', ...configs, '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, ...vars], {
    cwd: configDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let log = '';
  child.stdout.on('data', (c) => (log += c));
  child.stderr.on('data', (c) => (log += c));
  const deadline = Date.now() + 180_000;
  while (!(await up())) {
    if (child.exitCode !== null || Date.now() > deadline) {
      const tail = log.slice(-3000);
      await stop();
      throw new Error(`wrangler dev not ready:\n${tail}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  async function stop() {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    rmSync(work, { recursive: true, force: true });
  }

  /** SQL against the local D1 of this run (for test set-up only, e.g. a plan change). */
  function sql(command) {
    const out = spawnSync(process.execPath, [wranglerBin, 'd1', 'execute', 'DB', '--local', '--persist-to', persist, '-c', configPath, '--json', '--command', command], { cwd: configDir, env, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`sql: ${out.stderr}`);
    return JSON.parse(out.stdout);
  }

  /** Sign in with the development link and create an API key, as scripts/smoke.mjs does. */
  async function account(name) {
    const origin = { origin: base, 'content-type': 'application/json' };
    const email = `${name}-${Date.now()}@example.com`;
    const link = await (await fetch(`${base}/auth/magic-link`, { method: 'POST', headers: origin, body: JSON.stringify({ email }) })).json();
    const token = new URL(link.dev_link).searchParams.get('token');
    const verify = await fetch(`${base}/auth/verify`, { method: 'POST', headers: origin, body: JSON.stringify({ token }) });
    const cookie = verify.headers.getSetCookie().map((v) => v.split(';')[0]).find((p) => p.startsWith('ltc_session='));
    const created = await (await fetch(`${base}/api/keys`, { method: 'POST', headers: { ...origin, cookie }, body: JSON.stringify({ name }) })).json();
    if (typeof created.secret !== 'string') throw new Error(`no key: ${JSON.stringify(created)}`);
    return { email, cookie, apiKey: created.secret };
  }

  /** Poll GET /v1/batches/{id} until the batch has finished (or the time runs out). */
  async function waitForBatch(apiKey, id, timeoutMs = 90_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const batch = await (await fetch(`${base}/v1/batches/${id}`, { headers: { authorization: `Bearer ${apiKey}` } })).json();
      if (['done', 'partial', 'failed', 'cancelled'].includes(batch.status) || Date.now() > until) return batch;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return { base, stop, sql, account, waitForBatch, log: () => log };
}

/** A small pass/fail recorder for the checks. */
export function recorder() {
  const results = [];
  const record = (label, ok, detail = '') => {
    results.push({ label, ok: Boolean(ok) });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -> ${String(detail).slice(0, 400)}` : ''}`);
  };
  const summary = (name) => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`${name} e2e: ${results.length - failed} ok, ${failed} failed`);
    return failed;
  };
  return { record, summary, results };
}

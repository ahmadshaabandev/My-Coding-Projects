/*
 * access.cjs: the access gate of an online Mommy (web/access.html, web/access.js,
 * backend/mommy/access.py; docs/CONTRACT.md, "Access gate"), in headless Chromium against
 * the REAL app: create_app() with MOMMY_ACCESS_CODE set, fake speech components, the
 * offline brain and the Tanzil text, served by uvicorn with --proxy-headers on a free
 * loopback port. Each browser context sends its own X-Forwarded-For, so the per-client
 * failure limit of one check does not reach the next.
 *
 * Checks: the link /#code=<code> lands in the app with the fragment gone and an HttpOnly
 * cookie; a reload stays in; a wrong code shows the translated error in en, fr and ar
 * (RTL, Arabic-Indic digits), typed or from the link; typing the code works (also with
 * Arabic-Indic digits); too many tries; the page at 360 px; no console errors, no other
 * host; the server log never shows the code.
 *
 *   node tests/web/access.cjs            (about 30 s; MOMMY_SHOTS_DIR=... for screenshots)
 */
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { chromium } = require('playwright');
const H = require('./helpers.cjs');

const { check, finish, sleep } = H;

const CODE = 'k7m2p9q4r8s3';
const WRONG = 'wrongcode234';
const ARABIC_INDIC = (s) => s.replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)]);
const LOCALES = { en: 'en-GB', fr: 'fr-FR', ar: 'ar' };

// The app as build_default_app() makes it, with fakes for Whisper and Piper (no models
// loaded), and the logging of the mommy loggers to stderr at DEBUG.
const SERVER_PY = `
import sys
sys.path.insert(0, "backend")
import uvicorn
from mommy.app import _configure_logging, create_app
from mommy.asr import FakeTranscriber
from mommy.config import load_settings
from mommy.llm import OfflineBrain
from mommy.quran import Quran
from mommy.tts import FakeTTS
_configure_logging()
settings = load_settings()
app = create_app(settings, FakeTranscriber("hello"), FakeTTS(), OfflineBrain(), Quran(settings.quran_dir))
uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), proxy_headers=True, forwarded_allow_ips="127.0.0.1", log_level="info")
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startApp() {
  const port = await freePort();
  const env = Object.assign({}, process.env, { MOMMY_ACCESS_CODE: CODE, MOMMY_LOG_LEVEL: 'DEBUG', PYTHONUNBUFFERED: '1' });
  delete env.MOMMY_ALLOWED_HOSTS;
  const proc = spawn(H.PYTHON, ['-c', SERVER_PY, String(port)], { cwd: H.ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  proc.stdout.on('data', (d) => (out.text += d));
  proc.stderr.on('data', (d) => (out.text += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error('the server stopped:\n' + out.text);
    try {
      const r = await fetch(base + '/access.js');
      if (r.status === 200) break;
    } catch (e) {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('the server did not start:\n' + out.text);
    await sleep(200);
  }
  return { proc, base, out };
}

let clientNo = 0;
let cookieValue = null;

/** A context in one language at 360 px, as its own client (X-Forwarded-For). */
async function open(browser, base, lang) {
  clientNo += 1;
  const context = await browser.newContext({
    locale: LOCALES[lang],
    viewport: { width: 360, height: 740 },
    extraHTTPHeaders: { 'X-Forwarded-For': `198.51.100.${clientNo}` },
  });
  const page = await context.newPage();
  const problems = [];
  H.watchPage(page, base, problems);
  return { context, page, problems };
}

/** Chromium logs the 403 of a wrong code and the 429 of too many as console errors. */
const refusedCode = (problems) => problems.filter((p) => !/Failed to load resource: the server responded with a status of (403|429)/.test(p));

async function inApp(page) {
  await page.waitForSelector('#ai-badge', { timeout: 10000 }); // index.html, not the gate page
  assert.equal(await page.$('#access-form'), null);
  await page.waitForFunction(() => document.querySelector('.screen:not([hidden])'));
}

async function gateShown(page, lang) {
  await page.waitForSelector('#access-form:not([hidden])');
  assert.equal(await page.getAttribute('html', 'lang'), lang);
  assert.equal(await page.getAttribute('html', 'dir'), lang === 'ar' ? 'rtl' : 'ltr');
  const S = H.uiStrings(lang, 'access.js');
  assert.equal((await page.textContent('#access-title')).trim(), S.title);
  assert.equal(await page.title(), S.doc_title);
  assert.equal((await page.textContent('label[for="access-code"]')).trim(), S.label);
  assert.equal((await page.textContent('#access-submit')).trim(), S.submit);
}

async function layout(page, name) {
  await H.noHorizontalScroll(page);
  assert.deepEqual(await H.overflowing(page), []);
  assert.deepEqual(await H.smallTargets(page), []);
  await H.shot(page, name);
}

async function submitAndWait(page) {
  const [res] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === '/api/access'),
    page.click('#access-submit'),
  ]);
  return res;
}

function stringChecks() {
  const en = H.uiStrings('en', 'access.js');
  const fr = H.uiStrings('fr', 'access.js');
  const ar = H.uiStrings('ar', 'access.js');
  assert.ok(Object.keys(en).length >= 12, 'the English block was read');
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  const arKeys = Object.keys(en).filter((k) => k !== 'minutes_other').concat(['minutes_two', 'minutes_few', 'minutes_many']);
  assert.deepEqual(Object.keys(ar).sort(), arKeys.sort());
  // French: a no-break space, never a plain one, before : ; ! ? and inside « ».
  for (const [k, v] of Object.entries(fr)) assert.ok(!/ [:;!?»]/.test(v) && !/« /.test(v), 'fr ' + k);
  // Arabic: gender-neutral (يُرجى + a verbal noun, verbal-noun buttons), no Latin digits.
  const BANNED = ['اكتب', 'اكتبي', 'أدخل', 'أدخلي', 'انتظر', 'انتظري', 'حاول', 'حاولي', 'تحقق', 'تحققي', 'اضغط', 'اضغطي', 'أعد', 'أعيدي', 'ادخل', 'ادخلي', 'تريد', 'تريدين', 'أنتَ', 'أنتِ'];
  for (const [k, v] of Object.entries(ar)) {
    assert.ok(!/[0-9]/.test(v), 'ar ' + k + ' has Latin digits');
    for (const w of v.split(/[\s.،؛؟!…]+/u)) assert.ok(!BANNED.includes(w), `ar ${k}: ${w}`);
  }
  for (const k of ['hint', 'err_empty', 'err_bad', 'err_many', 'err_network', 'err_other']) assert.match(ar[k], /يُرجى/, 'ar ' + k);
  assert.equal(ar.submit, 'دخول');
}

async function main() {
  console.log('# strings (Node)');
  await check('access.js: the same strings in en, fr and ar; French spaces; gender-neutral Arabic', stringChecks);

  const app = await startApp();
  const { base } = app;
  const browser = await chromium.launch();
  try {
    console.log('# the link');
    const en = await open(browser, base, 'en');
    await check('en: the link /#code=… lands in the app, the fragment is gone, the cookie is HttpOnly', async () => {
      await en.page.goto(base + '/#code=' + CODE);
      await inApp(en.page);
      assert.ok(!en.page.url().includes(CODE) && !en.page.url().includes('code='), en.page.url());
      const cookies = await en.context.cookies();
      assert.equal(cookies.length, 1);
      const [c] = cookies;
      assert.equal(c.name, 'mommy_access');
      assert.ok(c.httpOnly && c.sameSite === 'Lax' && c.path === '/' && c.secure === false, JSON.stringify(c));
      const days = (c.expires * 1000 - Date.now()) / 86400000;
      assert.ok(days > 179 && days <= 180.01, 'cookie lifetime ' + days + ' days');
      assert.ok(!c.value.includes(CODE));
      cookieValue = c.value;
      assert.equal(await en.page.evaluate(() => document.cookie), '');
      // The history holds no entry with the code.
      await en.page.goBack().catch(() => null);
      assert.ok(!en.page.url().includes(CODE), en.page.url());
      assert.deepEqual(en.problems, []);
    });
    await check('en: a reload stays in, and so does a new tab', async () => {
      await en.page.goto(base + '/');
      await inApp(en.page);
      await en.page.reload();
      await inApp(en.page);
      const tab = await en.context.newPage();
      H.watchPage(tab, base, en.problems);
      await tab.goto(base + '/');
      await inApp(tab);
      const health = await tab.evaluate(async () => (await fetch('/api/health')).status);
      assert.equal(health, 200);
      await tab.close();
      assert.deepEqual(en.problems, []);
    });
    await en.context.close();

    console.log('# a wrong code, in each language');
    for (const lang of ['en', 'fr', 'ar']) {
      const S = H.uiStrings(lang, 'access.js');
      const ctx = await open(browser, base, lang);
      await check(`${lang}: a wrong code in the link shows the translated error, at 360 px`, async () => {
        await ctx.page.goto(base + '/#code=' + WRONG);
        await gateShown(ctx.page, lang);
        await ctx.page.waitForFunction(() => document.getElementById('access-error').textContent !== '');
        assert.equal((await ctx.page.textContent('#access-error')).trim(), S.err_bad);
        assert.equal(ctx.page.url(), base + '/'); // the fragment was removed at once
        assert.equal(await ctx.page.evaluate(() => document.activeElement.id), 'access-code');
        assert.equal(await ctx.page.textContent('#access-status'), '');
        if (lang === 'ar') {
          assert.equal(await ctx.page.$eval('#access-title', (n) => getComputedStyle(n).direction), 'rtl');
          assert.equal(await ctx.page.$eval('#access-code', (n) => getComputedStyle(n).direction), 'ltr');
        }
        await layout(ctx.page, `access-${lang}-wrong-link`);
        assert.deepEqual(refusedCode(ctx.problems), []);
      });
      await check(`${lang}: a wrong code typed, then an empty one`, async () => {
        await ctx.page.fill('#access-code', 'not-the-code');
        const res = await submitAndWait(ctx.page);
        assert.equal(res.status(), 403);
        await ctx.page.waitForFunction(() => !document.getElementById('access-submit').disabled);
        assert.equal((await ctx.page.textContent('#access-error')).trim(), S.err_bad);
        await ctx.page.fill('#access-code', '   ');
        await ctx.page.click('#access-submit');
        assert.equal((await ctx.page.textContent('#access-error')).trim(), S.err_empty);
        await layout(ctx.page, `access-${lang}-empty`);
        assert.deepEqual(refusedCode(ctx.problems), []);
        assert.ok(ctx.problems.length >= 1, 'the 403s were seen');
      });
      await ctx.context.close();
    }

    console.log('# typing the code');
    for (const [lang, typed, how] of [['en', CODE, 'Enter key'], ['ar', ARABIC_INDIC(CODE), 'Arabic-Indic digits']]) {
      const ctx = await open(browser, base, lang);
      await check(`${lang}: typing the code opens the app (${how})`, async () => {
        await ctx.page.goto(base + '/recite');
        await gateShown(ctx.page, lang);
        assert.equal(await ctx.page.textContent('#access-error'), '');
        assert.equal(await ctx.page.evaluate(() => document.activeElement.id), 'access-code');
        await layout(ctx.page, `access-${lang}-form`);
        await ctx.page.fill('#access-code', typed);
        if (how === 'Enter key') await ctx.page.press('#access-code', 'Enter');
        else await ctx.page.click('#access-submit');
        await inApp(ctx.page);
        assert.equal(new URL(ctx.page.url()).pathname, '/');
        await ctx.page.reload();
        await inApp(ctx.page);
        assert.deepEqual(ctx.problems, []);
      });
      await ctx.context.close();
    }

    console.log('# too many tries');
    for (const lang of ['ar', 'fr']) {
      const S = H.uiStrings(lang, 'access.js');
      const ctx = await open(browser, base, lang);
      await check(`${lang}: the 11th wrong code asks to wait, in the UI language`, async () => {
        await ctx.page.goto(base + '/');
        await gateShown(ctx.page, lang);
        for (let i = 0; i < 10; i++) {
          await ctx.page.fill('#access-code', WRONG + i);
          assert.equal((await submitAndWait(ctx.page)).status(), 403);
          await ctx.page.waitForFunction(() => !document.getElementById('access-submit').disabled);
        }
        await ctx.page.fill('#access-code', CODE);
        const res = await submitAndWait(ctx.page);
        assert.equal(res.status(), 429);
        assert.ok(Number(res.headers()['retry-after']) > 0);
        await ctx.page.waitForFunction(() => !document.getElementById('access-submit').disabled);
        const wait = lang === 'ar' ? '١٠ دقائق' : '10 minutes';
        assert.equal((await ctx.page.textContent('#access-error')).trim(), S.err_many.replace('{wait}', wait));
        await layout(ctx.page, `access-${lang}-too-many`);
        assert.deepEqual(refusedCode(ctx.problems), []);
      });
      await ctx.context.close();
    }

    console.log('# without the cookie');
    const bare = await open(browser, base, 'en');
    await check('no cookie: the API and the app files answer 401, the gate files 200', async () => {
      await bare.page.goto(base + '/');
      await gateShown(bare.page, 'en');
      const statuses = await bare.page.evaluate(async () => {
        const out = {};
        for (const p of ['/api/health', '/app.js', '/index.html', '/access.js', '/styles.css']) out[p] = (await fetch(p)).status;
        return out;
      });
      assert.deepEqual(statuses, { '/api/health': 401, '/app.js': 401, '/index.html': 401, '/access.js': 200, '/styles.css': 200 });
    });
    await bare.context.close();
  } finally {
    await browser.close();
    app.proc.kill('SIGTERM');
    await new Promise((resolve) => (app.proc.exitCode !== null ? resolve() : app.proc.on('exit', resolve)));
  }

  console.log('# the server log');
  await check('the server log shows the requests but never the code or the cookie', async () => {
    const log = app.out.text;
    assert.match(log, /access code accepted/);
    assert.match(log, /refused a wrong access code/);
    assert.match(log, /"POST \/api\/access HTTP\/1\.1" 204/);
    assert.ok(!log.includes(CODE) && !log.includes(ARABIC_INDIC(CODE)), 'the code is in the server log');
    assert.ok(!log.includes(WRONG), 'a typed code is in the server log');
    assert.ok(cookieValue && !log.includes(cookieValue), 'the cookie is in the server log');
  });
  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

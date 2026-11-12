/*
 * access.cjs: the access gate of an online Mommy (web/access.html, web/access.js,
 * backend/mommy/access.py; docs/CONTRACT.md, "Access gate"), in headless Chromium against
 * the REAL app: create_app() with MOMMY_ACCESS_CODE set, fake speech components, the
 * offline brain and the Tanzil text, served by uvicorn with --proxy-headers on a free
 * loopback port. Each browser context sends its own X-Forwarded-For, so the per-client
 * failure limit of one check does not reach the next.
 *
 * Checks: the link /#code=<code> lands in the app with the fragment gone and an HttpOnly
 * cookie; a reload stays in; the link pasted into a tab that already shows the code page
 * works too (hashchange); a wrong code shows the translated error in en, fr and ar (RTL,
 * Arabic-Indic digits), typed or from the link; typing the code works (also with
 * Arabic-Indic digits); too many tries; while the app is starting (503) or cannot be
 * reached, a link's code is kept, tried again by itself after 20 s, and "Enter" with an
 * empty field tries it; the page at 360 px; in the app, the consent box follows the real
 * /api/health ("online": true with the gate on): the recordings and texts go to this
 * server, never "nothing leaves this computer" (en, fr, ar); no console errors, no other
 * host; the server log never shows the code.
 *
 * The server's part in the AI consent (docs/REWARDS.md, V6), against a second real app
 * whose brain is a fake Claude brain (name "claude", no network; it logs the name of each
 * method called): a request built by an older client (no ai_consent field) is answered by
 * the offline brain and the fake is never called; so are ai_consent=0, a field in the query
 * string only and "1" sent beside "0"; ai_consent=1 lets the fake answer. The log names the
 * brain, never the text or the age group.
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
// A text and an age group that must never reach the server log.
const PRIVATE_TEXT = 'Le zèbre grignote doucement une pomme verte.';
const PRIVATE_AGE = '14-18'; // never a date: no month 14

// The app as build_default_app() makes it, with fakes for Whisper and Piper (no models
// loaded), and the logging of the mommy loggers to stderr at DEBUG.
const SERVER_PY = `
import logging
import sys
sys.path.insert(0, "backend")
import uvicorn
from mommy.app import _configure_logging, create_app
from mommy.asr import FakeTranscriber
from mommy.config import load_settings
from mommy.llm import OfflineBrain
from mommy.quran import Quran
from mommy.tts import FakeTTS


class FakeClaude:
    """Answers as ClaudeBrain does, with fixed texts and no network; logs only the name
    of each method called, never what it was given."""

    name = "claude"

    def _called(self, method):
        logging.getLogger("mommy.fake_claude").info("fake Claude brain called: %s", method)

    def read_page(self, image_jpeg, lang_hint):
        self._called("read_page")
        return {"text": "Claude read this page.", "lang": "en", "notes": "", "contains_quran": False, "needs_manual": False}

    def read_handwriting(self, image_jpeg, lang):
        self._called("read_handwriting")
        return {"text": "Claude read this writing.", "uncertain_words": [], "legible": True, "needs_manual": False}

    def judge_meaning(self, expected_text, heard_text, lang, age):
        self._called("judge_meaning")
        return {"verdict": "same_meaning", "missing_ideas": [], "wrong_ideas": [], "feedback": "Claude judged the meaning."}

    def word_feedback(self, result_summary, lang, age):
        self._called("word_feedback")
        return "Claude worded this feedback."


_configure_logging()
settings = load_settings()
brain = FakeClaude() if sys.argv[2:] == ["claude"] else OfflineBrain()
app = create_app(settings, FakeTranscriber("hello there"), FakeTTS(), brain, Quran(settings.quran_dir))
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

/** The app under uvicorn; brain 'claude' gives it the fake Claude brain of SERVER_PY. */
async function startApp(brain) {
  const port = await freePort();
  const env = Object.assign({}, process.env, { MOMMY_ACCESS_CODE: CODE, MOMMY_LOG_LEVEL: 'DEBUG', PYTHONUNBUFFERED: '1' });
  delete env.MOMMY_ALLOWED_HOSTS;
  const args = ['-c', SERVER_PY, String(port)].concat(brain === 'claude' ? ['claude'] : []);
  const proc = spawn(H.PYTHON, args, { cwd: H.ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** Chromium logs the 403 of a wrong code, the 429 of too many and the 503 of a starting
 * app as console errors (and a refused connection as a failed load). */
const refusedCode = (problems) =>
  problems.filter((p) => !/Failed to load resource: (the server responded with a status of (403|429|503)|net::ERR_CONNECTION_REFUSED)/.test(p));

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

/**
 * In the app, the consent box of the family setup as the real server makes it: online
 * (the gate is on) with the offline brain, so the recordings and texts go to this
 * server and nothing to an AI service; no sentence says that nothing leaves the device.
 */
async function onlineConsent(page, lang) {
  const health = await page.evaluate(async () => (await fetch('/api/health')).json());
  assert.equal(health.online, true);
  assert.equal(health.brain, 'offline');
  await page.waitForSelector('#consent-extra:not([hidden])');
  assert.equal(await page.getAttribute('html', 'lang'), lang);
  const S = H.allStrings(lang);
  assert.equal((await page.textContent('#consent-privacy')).trim(), S.consent_online_no_photos);
  assert.equal((await page.textContent('#consent-extra')).trim(), S.consent_online_no_ai);
  assert.deepEqual(await H.localSentencesShown(page), []);
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
  for (const k of ['hint', 'err_empty', 'err_bad', 'err_many', 'err_network', 'err_starting', 'err_other']) assert.match(ar[k], /يُرجى/, 'ar ' + k);
  assert.equal(ar.submit, 'دخول');
}

/**
 * In the page: the five requests whose handling can reach the brain (a typed dictation
 * check, a dictation photo, a page photo, a recitation word by word and one by meaning),
 * each with the extra form fields `fields` ([name, value] pairs) and the query string
 * `query`. Returns their [{status, body}]. Without a field, this is how a tab still running
 * an older app.js, or any other client, builds them.
 */
async function brainRequests({ text, age, fields, query }) {
  const tone = () => {
    // 1 s of a 440 Hz tone, 16 kHz mono PCM16: loud and long enough to be "heard".
    const n = 16000;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 440 * i) / 16000)), true);
    return new Blob([buf], { type: 'audio/wav' });
  };
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 100;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 200, 100);
  const photo = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  const send = async (path, parts) => {
    const form = new FormData();
    for (const [k, v, name] of parts) {
      if (name) form.append(k, v, name);
      else form.append(k, v);
    }
    for (const [k, v] of fields) form.append(k, v);
    const r = await fetch(path + query, { method: 'POST', body: form });
    return { status: r.status, body: await r.json() };
  };
  return [
    await send('api/dictation/check', [['expected_text', text], ['lang', 'fr'], ['age', age], ['written_text', text]]),
    await send('api/dictation/check', [['expected_text', text], ['lang', 'fr'], ['age', age], ['image', photo, 'paper.jpg']]),
    await send('api/page/read', [['lang', 'fr'], ['image', photo, 'page.jpg']]),
    await send('api/recite/check', [['expected_text', 'hello there'], ['lang', 'en'], ['mode', 'strict'], ['age', age], ['audio', tone(), 'child.wav']]),
    await send('api/recite/check', [['expected_text', 'hello there my friend'], ['lang', 'en'], ['mode', 'contextual'], ['age', age], ['audio', tone(), 'child.wav']]),
  ];
}

const FAKE_CLAUDE_CALLED = /fake Claude brain called/;

/**
 * The server's part in the AI consent (V6), against the real app with the fake Claude
 * brain: what an older client sends (no field) and every other request without a consent
 * that counts is answered by the offline brain, and the fake is never called; with
 * ai_consent=1 it answers. Returns the app (stopped by the caller) for its log.
 */
async function serverConsent(browser) {
  const app = await startApp('claude');
  const { base } = app;
  const ctx = await open(browser, base, 'en');
  const ask = (fields, query) => ctx.page.evaluate(brainRequests, { text: PRIVATE_TEXT, age: PRIVATE_AGE, fields, query: query || '' });
  try {
    await check('AI consent (V6): a request built by an older client (no ai_consent) gets the offline brain from the real app; its Claude brain is never called', async () => {
      await ctx.page.goto(base + '/#code=' + CODE);
      await inApp(ctx.page);
      const health = await ctx.page.evaluate(async () => (await fetch('/api/health')).json());
      assert.equal(health.brain, 'claude', 'the server has (a fake) Claude');
      const cases = { 'no field': [[], ''], '0': [[['ai_consent', '0']], ''], 'query string only': [[], '?ai_consent=1'], '1 beside 0': [[['ai_consent', '1'], ['ai_consent', '0']], ''] };
      for (const [name, [fields, query]] of Object.entries(cases)) {
        const [typed, paper, page, strict, meaning] = await ask(fields, query);
        assert.deepEqual([typed.status, paper.status, page.status, strict.status, meaning.status], [200, 501, 200, 200, 200], name);
        assert.deepEqual([typed.body.brain, page.body.brain, strict.body.brain, meaning.body.brain], ['offline', 'offline', 'offline', 'offline'], name);
        assert.equal(paper.body.error, 'needs_manual', name);
        assert.ok(!/Claude/.test(typed.body.feedback) && !/Claude/.test(strict.body.feedback) && !/Claude/.test(meaning.body.feedback), name);
        assert.deepEqual([page.body.source, page.body.needs_manual, page.body.text], ['offline', true, ''], name);
        assert.equal(meaning.body.judgement.approximate, true, name + ': the offline meaning check is approximate');
      }
      assert.doesNotMatch(app.out.text, FAKE_CLAUDE_CALLED, 'the Claude brain was called without the consent');
      assert.deepEqual(refusedNeedsManual(ctx.problems), []);
    });
    await check('AI consent (V6): with ai_consent=1 the real app lets its Claude brain answer', async () => {
      const [typed, paper, page, strict, meaning] = await ask([['ai_consent', '1']]);
      assert.deepEqual([typed.status, paper.status, page.status, strict.status, meaning.status], [200, 200, 200, 200, 200]);
      assert.deepEqual([typed.body.brain, paper.body.brain, page.body.brain, strict.body.brain, meaning.body.brain], ['claude', 'claude', 'claude', 'claude', 'claude']);
      assert.equal(typed.body.feedback, 'Claude worded this feedback.');
      assert.equal(paper.body.read_text, 'Claude read this writing.');
      assert.deepEqual([page.body.text, page.body.source], ['Claude read this page.', 'claude']);
      assert.equal(strict.body.feedback, 'Claude worded this feedback.');
      assert.deepEqual([meaning.body.judgement.verdict, meaning.body.feedback], ['same_meaning', 'Claude judged the meaning.']);
      assert.equal(meaning.body.judgement.approximate, undefined);
      for (const method of ['word_feedback', 'read_handwriting', 'read_page', 'judge_meaning']) assert.match(app.out.text, new RegExp('fake Claude brain called: ' + method));
      assert.deepEqual(refusedNeedsManual(ctx.problems), []);
    });
  } finally {
    await ctx.context.close();
    app.proc.kill('SIGTERM');
    await new Promise((resolve) => (app.proc.exitCode !== null ? resolve() : app.proc.on('exit', resolve)));
  }
  return app;
}

/** Chromium logs the 501 of a photo the offline brain cannot read as a console error. */
const refusedNeedsManual = (problems) => problems.filter((p) => !/Failed to load resource: the server responded with a status of 501/.test(p));

async function main() {
  console.log('# strings (Node)');
  await check('access.js: the same strings in en, fr and ar; French spaces; gender-neutral Arabic', stringChecks);

  const app = await startApp();
  const { base } = app;
  const browser = await chromium.launch();
  let claudeApp = null;
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
    await check('en: in the app, the consent box says that the recordings and texts go to this server (/api/health "online"), never "nothing leaves this computer"', async () => {
      await en.page.goto(base + '/');
      await inApp(en.page);
      await onlineConsent(en.page, 'en');
      assert.deepEqual(en.problems, []);
    });
    // What the family data line (fam_privacy_line) says of the server, checked against
    // the real app: the texts and the age group are not kept (the log is read at the end).
    await check('en: a text check and a typed dictation check through the real app (their log lines are read at the end)', async () => {
      const res = await en.page.evaluate(async ({ text, age }) => {
        const t = await fetch('api/text/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang: 'fr', mode: 'strict' }) });
        const form = new FormData();
        form.append('expected_text', text);
        form.append('lang', 'fr');
        form.append('age', age);
        form.append('written_text', text);
        const d = await fetch('api/dictation/check', { method: 'POST', body: form });
        return [t.status, d.status];
      }, { text: PRIVATE_TEXT, age: PRIVATE_AGE });
      assert.deepEqual(res, [200, 200]);
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

    const pasted = await open(browser, base, 'en');
    await check('en: the link pasted into a tab that shows the code page opens the app (hashchange)', async () => {
      await pasted.page.goto(base + '/');
      await gateShown(pasted.page, 'en');
      await pasted.page.goto(base + '/#code=' + CODE); // only the fragment changes: no new page load
      await inApp(pasted.page);
      assert.ok(!pasted.page.url().includes('code='), pasted.page.url());
      assert.equal((await pasted.context.cookies()).length, 1);
      assert.deepEqual(pasted.problems, []);
    });
    await pasted.context.close();

    console.log('# the app is starting, or cannot be reached');
    for (const lang of ['ar', 'fr']) {
      const S = H.uiStrings(lang, 'access.js');
      const ctx = await open(browser, base, lang);
      await check(`${lang}: while the app is starting (503) the link's code is kept and tried again after 20 s`, async () => {
        await ctx.page.clock.install();
        let starting = true;
        let posts = 0;
        await ctx.page.route('**/api/access', (route) => {
          posts += 1;
          return starting ? route.fulfill({ status: 503, contentType: 'text/html', body: '<html>starting</html>' }) : route.fallback();
        });
        await ctx.page.goto(base + '/#code=' + CODE);
        await gateShown(ctx.page, lang);
        await ctx.page.waitForFunction(() => document.getElementById('access-error').textContent !== '');
        assert.equal((await ctx.page.textContent('#access-error')).trim(), S.err_starting);
        assert.equal(ctx.page.url(), base + '/'); // the code is in memory only
        await layout(ctx.page, `access-${lang}-starting`);
        assert.equal(posts, 1);
        starting = false;
        await ctx.page.clock.fastForward(20000);
        await inApp(ctx.page);
        assert.equal(posts, 2);
        await onlineConsent(ctx.page, lang);
        assert.deepEqual(refusedCode(ctx.problems), []);
      });
      await ctx.context.close();
    }
    const offline = await open(browser, base, 'en');
    await check('en: after a network error, Enter with an empty field tries the link\'s code again', async () => {
      let down = true;
      await offline.page.route('**/api/access', (route) => (down ? route.abort('connectionrefused') : route.fallback()));
      await offline.page.goto(base + '/#code=' + CODE);
      await gateShown(offline.page, 'en');
      await offline.page.waitForFunction(() => document.getElementById('access-error').textContent !== '');
      assert.equal((await offline.page.textContent('#access-error')).trim(), H.uiStrings('en', 'access.js').err_network);
      assert.equal(await offline.page.inputValue('#access-code'), ''); // never shown in the field
      down = false;
      await offline.page.press('#access-code', 'Enter');
      await inApp(offline.page);
      assert.deepEqual(refusedCode(offline.problems), []);
    });
    await offline.context.close();

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

    console.log('# the AI consent, decided by the server (an app with a fake Claude brain)');
    claudeApp = await serverConsent(browser);
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
  await check('the server log notes the language and the kind of check, never the text or the age group (fam_privacy_line)', async () => {
    const log = app.out.text;
    assert.match(log, /text\/check strict fr: /);
    assert.match(log, /dictation\/check fr: /);
    for (const word of PRIVATE_TEXT.replace(/[.,]/g, '').split(/\s+/).filter((w) => w.length > 3)) assert.ok(!log.includes(word), `"${word}" of the text is in the server log`);
    assert.ok(!log.includes(PRIVATE_AGE), 'the age group is in the server log');
  });
  await check('the log of the app with the fake Claude brain names which brain answered, never the text, the age group or the code', async () => {
    assert.ok(claudeApp, 'the app with the fake Claude brain ran');
    const log = claudeApp.out.text;
    for (const line of [/dictation\/check fr: brain offline/, /dictation\/check fr: brain claude/, /recite\/check strict en: brain offline/, /recite\/check contextual en: brain claude/, /page\/read: image \d+ bytes, brain claude, source claude/]) assert.match(log, line);
    for (const word of PRIVATE_TEXT.replace(/[.,]/g, '').split(/\s+/).filter((w) => w.length > 3)) assert.ok(!log.includes(word), `"${word}" of the text is in the server log`);
    assert.ok(!log.includes(PRIVATE_AGE), 'the age group is in the server log');
    assert.ok(!log.includes(CODE), 'the code is in the server log');
  });
  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

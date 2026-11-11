#!/usr/bin/env node
/*
 * Smoke test for the Mommy web client (web/).
 *
 * Runs without the Python backend: web/ is served by a tiny Node static server on a free
 * port, and every /api/* request is answered by page.route() with contract-shaped fake
 * JSON (docs/CONTRACT.md, "HTTP API"). The fake Quran endpoints read the verbatim Tanzil
 * files in data/quran/ (read only) so the page is checked against the real text.
 *
 * What is checked:
 *   - node --check on every web/*.js file;
 *   - recorder.js signal helpers in Node (WAV header, resampling, anti-aliasing, meter);
 *   - in headless Chromium with a fake microphone: no console errors, no external
 *     requests, consent gating, the Arabic UI switching dir="rtl", photo resizing to a
 *     <= 2000 px JPEG without EXIF, a real 16 kHz mono PCM16 WAV upload, the four word
 *     styles of a strict result (colour and shape), say-again, contextual mode,
 *     dictation with the parent confirmation step, the Quran screen (verbatim text,
 *     attribution, hidden text with hints, "where am I?", and no speech synthesis),
 *     disabled features with explanations, the server-down banner, the 120 s limit
 *     mechanism and the ScriptProcessor fallback, and no horizontal scroll at 360 px;
 *   - review fixes: localized 422 quran_text / text_too_long messages with a button to
 *     the Quran section (and the text checked at "Confirm text"), the contains_quran
 *     hint, the X-Speech-Check note and fresh take on Repeat, Next/Repeat waiting for
 *     the voice (no skipped phrase), next-phrase prefetch, late feedback speech dropped
 *     during a recording or on another screen, Arabic-Indic digits in the Arabic UI
 *     (range fields accept both digit systems), ayah numbers and pause marks that never
 *     wrap away from their word, "Nearly the same meaning", consent before a typed check
 *     whose feedback Claude words, a complete notice of what Claude receives, the text
 *     language following the UI and the script of the text, re-checking an edited
 *     dictation reading before the child sees it, the too_short hint, the length-limit
 *     note and the mode-change reset; "Start the dictation" disabled, with the reason
 *     shown, after a whole-ayah phrase refusal (reciting stays available), also for a
 *     basmala on a line of its own (a text with line breaks is checked line by line too)
 *     and for a phrase the voice refuses (back to the start of the dictation, not to
 *     the Quran section); Arabic UI strings without singular imperatives or visibly
 *     gendered second-person forms; the riwaya named in Arabic in the Arabic UI.
 *
 * Run:   node tests/web/smoke.cjs
 * Screenshots (optional): MOMMY_SHOTS_DIR=/some/dir node tests/web/smoke.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const WEB = path.join(ROOT, 'web');
const QURAN_DIR = path.join(ROOT, 'data', 'quran');
const SHOTS = process.env.MOMMY_SHOTS_DIR || '';
const PYTHON = path.join(ROOT, '.venv', 'bin', 'python');

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

const results = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   - ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL - ${name}\n       ${String((err && err.stack) || err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Static server for web/
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(WEB, rel));
    if (!file.startsWith(WEB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Binary helpers: multipart, WAV, JPEG
// ---------------------------------------------------------------------------

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  assert.ok(m, 'multipart boundary missing: ' + contentType);
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const parts = {};
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    pos += boundary.length;
    if (buf.slice(pos, pos + 2).toString() === '--') break;
    pos += 2;
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    const head = buf.slice(pos, headEnd).toString('utf8');
    const next = buf.indexOf(boundary, headEnd + 4);
    const data = buf.slice(headEnd + 4, next - 2);
    const name = /name="([^"]*)"/.exec(head)[1];
    const filename = (/filename="([^"]*)"/.exec(head) || [])[1];
    const type = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1];
    parts[name] = { filename, type, data, text: data.toString('utf8') };
    pos = next;
  }
  return parts;
}

function parseWav(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
  assert.equal(buf.toString('ascii', 36, 40), 'data');
  return {
    riffSize: buf.readUInt32LE(4),
    format: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    rate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bits: buf.readUInt16LE(34),
    dataBytes: buf.readUInt32LE(40),
  };
}

function silentWav(seconds) {
  const n = Math.round(16000 * seconds);
  const buf = Buffer.alloc(44 + 2 * n);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + 2 * n, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(2 * n, 40);
  return buf;
}

/** Width and height from a JPEG's SOF marker. */
function jpegSize(buf) {
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  let pos = 2;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) throw new Error('bad JPEG marker at ' + pos);
    const marker = buf[pos + 1];
    const len = buf.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(pos + 5), width: buf.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  throw new Error('no SOF marker');
}

/** Insert a minimal APP1 Exif segment right after SOI (to prove it is dropped). */
function withExif(jpeg) {
  const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const seg = Buffer.alloc(4);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpeg.slice(0, 2), seg, body, jpeg.slice(2)]);
}

// ---------------------------------------------------------------------------
// Verbatim Tanzil data for the fake Quran endpoints (read only)
// ---------------------------------------------------------------------------

const ATTRIBUTION = 'Quran text: Tanzil Project (tanzil.net), Hafs, Uthmani v1.1, CC BY 3.0, verbatim';

function readTanzil(file) {
  const map = new Map();
  for (const raw of fs.readFileSync(path.join(QURAN_DIR, file), 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    const [s, a, ...rest] = line.split('|');
    map.set(`${Number(s)}:${Number(a)}`, rest.join('|'));
  }
  return map;
}

function readSurahs() {
  const js = fs.readFileSync(path.join(QURAN_DIR, 'quran-data.js'), 'utf8');
  const block = js.slice(js.indexOf('QuranData.Sura'), js.indexOf('];', js.indexOf('QuranData.Sura')));
  const re = /\[\s*(\d+),\s*(\d+),\s*\d+,\s*\d+,\s*'((?:[^'\\]|\\.)*)',\s*"((?:[^"\\]|\\.)*)",\s*'((?:[^'\\]|\\.)*)'/g;
  const out = [];
  let m;
  while ((m = re.exec(block))) {
    const unesc = (s) => s.replace(/\\(.)/g, '$1');
    out.push({ number: out.length + 1, name_ar: unesc(m[3]), ayah_count: Number(m[2]), name_translit: unesc(m[4]), name_en: unesc(m[5]) });
  }
  return out;
}

const isPauseMark = (tok) => tok.length > 0 && [...tok].every((ch) => ch.codePointAt(0) >= 0x06d6 && ch.codePointAt(0) <= 0x06ed);

/** The line without its first `count` whitespace-separated words (basmala handling). */
function dropWords(line, count) {
  const re = /\S+/g;
  let m;
  let n = 0;
  while ((m = re.exec(line))) {
    n++;
    if (n === count) return line.slice(m.index + m[0].length).replace(/^\s+/, '');
  }
  throw new Error('short line');
}

const TANZIL = { uthmani: null, clean: null, surahs: null };

function ayah(surah, a) {
  let display = TANZIL.uthmani.get(`${surah}:${a}`);
  let match = TANZIL.clean.get(`${surah}:${a}`);
  if (a === 1 && surah !== 1 && surah !== 9) {
    display = dropWords(display, 4);
    match = dropWords(match, 4);
  }
  return {
    surah,
    ayah: a,
    display,
    display_words: display.split(/\s+/).filter((t) => t && !isPauseMark(t)),
    match_words: match.split(/\s+/).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Fake API (contract-shaped)
// ---------------------------------------------------------------------------

const PAGE_TEXT = 'The cat sat on the mat.';

const STRICT_RESULT = {
  mode: 'strict',
  heard_text: 'The hat sat the mat today',
  result: {
    ops: [
      { kind: 'match', exp_index: 0, heard_index: 0, expected: 'The', heard: 'The' },
      { kind: 'sub', exp_index: 1, heard_index: 1, expected: 'cat', heard: 'hat' },
      { kind: 'match', exp_index: 2, heard_index: 2, expected: 'sat', heard: 'sat' },
      { kind: 'del', exp_index: 3, heard_index: null, expected: 'on', heard: null },
      { kind: 'match', exp_index: 4, heard_index: 3, expected: 'the', heard: 'the' },
      { kind: 'match', exp_index: 5, heard_index: 4, expected: 'mat', heard: 'mat' },
      { kind: 'ins', exp_index: null, heard_index: 5, expected: null, heard: 'today' },
    ],
    n_expected: 6,
    n_errors: 3,
    first_error_exp_index: 1,
    verdict: 'mistakes',
    say_again: false,
    word_accuracy: 4 / 6,
  },
  feedback: 'Almost! Listen again: cat.',
  quality: { seconds: 1.5, rms: 0.08, too_quiet: false, too_short: false },
};

const SAY_AGAIN_RESULT = {
  mode: 'strict',
  heard_text: '',
  result: { ops: [], n_expected: 6, n_errors: 6, first_error_exp_index: 0, verdict: 'unclear', say_again: true, word_accuracy: 0 },
  feedback: "I couldn't hear you well. Can you say it again?",
  quality: { seconds: 0.3, rms: 0.001, too_quiet: true, too_short: true },
};

const CONTEXTUAL_RESULT = {
  mode: 'contextual',
  heard_text: 'a cat was sitting',
  judgement: { verdict: 'partly', missing_ideas: ['on the mat'], wrong_ideas: [], approximate: true },
  feedback: 'Good try! Where was the cat sitting?',
  quality: { seconds: 1.5, rms: 0.08, too_quiet: false, too_short: false },
};

const DICTATION_RESULT = {
  read_text: 'The cat sat on the matt',
  source: 'typed',
  uncertain_words: [],
  result: {
    ops: [
      { kind: 'match', exp_index: 0, heard_index: 0, expected: 'The', heard: 'The' },
      { kind: 'match', exp_index: 1, heard_index: 1, expected: 'cat', heard: 'cat' },
      { kind: 'match', exp_index: 2, heard_index: 2, expected: 'sat', heard: 'sat' },
      { kind: 'match', exp_index: 3, heard_index: 3, expected: 'on', heard: 'on' },
      { kind: 'match', exp_index: 4, heard_index: 4, expected: 'the', heard: 'the' },
      { kind: 'sub', exp_index: 5, heard_index: 5, expected: 'mat', heard: 'matt' },
    ],
    n_expected: 6,
    n_errors: 1,
    first_error_exp_index: 5,
    verdict: 'mistakes',
    say_again: false,
    word_accuracy: 5 / 6,
  },
  feedback: 'Very good! Look again at: mat.',
  needs_parent_confirmation: true,
};

/** Fake Quran check: one substitution, one skipped word and one added word. */
function fakeQuranCheck(surah, from, to) {
  const words = [];
  for (let a = from; a <= to; a++) {
    const ay = ayah(surah, a);
    ay.match_words.forEach((mw, i) => {
      const dj = Math.min(i, ay.display_words.length - 1);
      words.push({ ayah: a, i, dj, clean: mw, display: ay.display_words[dj] });
    });
  }
  const ops = [];
  let heardIndex = 0;
  words.forEach((w, g) => {
    const base = { exp_index: g, expected: w.clean, surah, ayah: w.ayah, word_index: w.i, word_index_display: w.dj, expected_display: w.display };
    if (g === 6) ops.push({ kind: 'ins', exp_index: null, heard_index: heardIndex++, expected: null, heard: 'و', surah: null, ayah: null, word_index: null, word_index_display: null, expected_display: null });
    if (g === 1) ops.push(Object.assign({ kind: 'sub', heard_index: heardIndex++, heard: 'هم' }, base));
    else if (g === 5) ops.push(Object.assign({ kind: 'del', heard_index: null, heard: null }, base));
    else ops.push(Object.assign({ kind: 'match', heard_index: heardIndex++, heard: w.clean }, base));
  });
  const first = words[1];
  return {
    heard_text: ops.filter((o) => o.heard).map((o) => o.heard).join(' '),
    ops,
    verdict: 'mistakes',
    say_again: false,
    first_error: { surah, ayah: first.ayah, word_index_display: first.dj, expected_display_word: first.display, kind: 'sub' },
    feedback: 'تنبيه: «' + first.display + '»', // as feedback.quran_feedback words it
  };
}

/** A Quran text (112:1-4, Simple-Clean words) that the general endpoints refuse. */
const QURAN_SAMPLE = 'قل هو الله أحد الله الصمد لم يلد ولم يولد ولم يكن له كفوا أحد';
/** The server's English refusal message: it must never reach a child-facing status. */
const QURAN_MESSAGE = 'This text is from the Quran. Please use the Quran section: it checks recitation against the verbatim Tanzil text, without AI and without a synthetic voice.';
const isQuranSample = (s) => typeof s === 'string' && s.includes('قل هو الله أحد');
/** A school text whose basmala is a phrase of its own: it may be recited, but the real
 * /api/dictation/phrases refuses it with scope "phrase" (the voice never reads an ayah). */
const BASMALA_TEXT = 'بسم الله الرحمن الرحيم. ذهب الولد إلى المدرسة مع أخيه.';
/** The same with the basmala on a line of its own, without a full stop: the real server
 * joins the two lines into one phrase and accepts the text as typed, but refuses it with
 * scope "phrase" when each line is a paragraph of its own. */
const BASMALA_LINE = 'بسم الله الرحمن الرحيم';
const BASMALA_LINE_TEXT = BASMALA_LINE + '\nذهب الولد إلى المدرسة مع أخيه.';
const hasBasmalaParagraph = (s) => s.split(/\n[^\S\n]*\n/).some((part) => part.trim() === BASMALA_LINE);
const QURAN_PHRASE_MESSAGE = 'A phrase of this text is a whole ayah of the Quran, which is never read out by the synthetic voice, so the text cannot be used for dictation. It can still be recited.';

function makeFakeApi(opts) {
  const o = Object.assign({ health: { asr: true, tts: true, brain: 'claude', quran: true, languages: ['ar', 'en', 'fr'] }, phrases: ['The cat sat', 'on the mat.'] }, opts || {});
  const calls = [];
  const reciteQueue = [];
  const dictationQueue = [];
  const refused = new Set(); // endpoints that answer 422 quran_text whatever the text
  const unreachable = new Set(); // endpoints whose requests fail as if the server were down
  let tts = { delay: () => 0, check: (j) => (j.slow ? 'passed' : 'skipped') };
  let pageRead = null;
  let healthDown = !!o.healthDown;
  const refuseQuran = (p, text) => refused.has(p) || isQuranSample(text);

  async function handler(route, request) {
    const url = new URL(request.url());
    const p = url.pathname;
    const method = request.method();
    const call = { path: p, method, query: url.searchParams, headers: request.headers() };
    const body = request.postDataBuffer();
    if (body && /multipart\/form-data/.test(call.headers['content-type'] || '')) call.form = parseMultipart(body, call.headers['content-type']);
    else if (body) {
      try {
        call.json = JSON.parse(body.toString('utf8'));
      } catch (e) {
        call.raw = body;
      }
    }
    calls.push(call);
    if (unreachable.has(p)) return route.abort('connectionrefused');
    const json = (data, status) => route.fulfill({ status: status || 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(data) });

    if (p === '/api/health') {
      if (healthDown) return route.abort('connectionrefused');
      return json(o.health);
    }
    const quranRefusal = () => json({ error: 'quran_text', message: QURAN_MESSAGE }, 422);
    if (p === '/api/page/read' && method === 'POST') {
      return json(pageRead || { text: PAGE_TEXT, lang: 'en', notes: '', source: 'claude', needs_manual: false, contains_quran: false });
    }
    if (p === '/api/recite/check' && method === 'POST') {
      if (refuseQuran(p, call.form.expected_text.text)) return quranRefusal();
      const mode = call.form && call.form.mode ? call.form.mode.text : 'strict';
      const next = reciteQueue.length ? reciteQueue.shift() : mode === 'contextual' ? CONTEXTUAL_RESULT : STRICT_RESULT;
      return json(next);
    }
    if (p === '/api/tts' && method === 'POST') {
      if (!o.health.tts) return json({ error: 'tts_unavailable', message: 'TTS models are missing' }, 503);
      if (refuseQuran(p, call.json.text)) return quranRefusal();
      const delay = tts.delay(call.json);
      if (delay) await sleep(delay);
      return route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'X-Speech-Check': tts.check(call.json) }, body: silentWav(0.2) });
    }
    if (p === '/api/dictation/phrases' && method === 'POST') {
      if (refuseQuran(p, call.json.text)) return quranRefusal();
      if (call.json.text === BASMALA_TEXT || hasBasmalaParagraph(call.json.text)) return json({ error: 'quran_text', message: QURAN_PHRASE_MESSAGE, scope: 'phrase' }, 422);
      if (call.json.text.includes('[?]')) return json({ error: 'unreadable_text', message: 'The text has [?] where a word could not be read. Please type the missing words first.' }, 400);
      if (call.json.text.length > 20000) return json({ error: 'text_too_long', message: 'The text is longer than 20000 characters.' }, 400);
      return json({ phrases: o.phrases });
    }
    if (p === '/api/dictation/check' && method === 'POST') {
      if (refuseQuran(p, call.form.expected_text.text)) return quranRefusal();
      return json(dictationQueue.length ? dictationQueue.shift() : DICTATION_RESULT);
    }
    if (p === '/api/quran/surahs') {
      return json({ surahs: TANZIL.surahs.map((s) => ({ number: s.number, name_ar: s.name_ar, ayah_count: s.ayah_count, name_translit: s.name_translit, name_en: s.name_en })), riwaya: 'hafs', attribution: ATTRIBUTION, source_url: 'https://tanzil.net' });
    }
    if (p === '/api/quran/ayat') {
      const surah = Number(url.searchParams.get('surah'));
      const from = Number(url.searchParams.get('from'));
      const to = Number(url.searchParams.get('to'));
      if (!(to >= from) || to - from + 1 > 50) return json({ error: 'bad_range', message: 'bad range' }, 400);
      const ayat = [];
      for (let a = from; a <= to; a++) {
        const ay = ayah(surah, a);
        ayat.push({ surah, ayah: a, display: ay.display, display_words: ay.display_words });
      }
      return json({ ayat, attribution: ATTRIBUTION });
    }
    if (p === '/api/quran/check' && method === 'POST') {
      const f = call.form;
      return json(fakeQuranCheck(Number(f.surah.text), Number(f.from.text), Number(f.to.text)));
    }
    if (p === '/api/quran/locate' && method === 'POST') {
      const a2 = ayah(112, 2);
      const a3 = ayah(112, 3);
      return json({ heard_text: 'الله الصمد', candidates: [{ surah: 112, ayah: 2, word_index: 0, match_word_index: 0, score: 1.0, display_preview: a2.display_words.concat(a3.display_words).slice(0, 8).join(' ') }] });
    }
    return json({ error: 'not_found', message: 'no fake for ' + p }, 400);
  }

  return {
    calls,
    handler,
    queueRecite: (r) => reciteQueue.push(r),
    queueDictation: (r) => dictationQueue.push(r),
    setHealthDown: (v) => {
      healthDown = v;
    },
    /** Make an endpoint answer 422 quran_text (or stop doing so). */
    refuse: (p, on) => (on ? refused.add(p) : refused.delete(p)),
    /** Make requests to an endpoint fail as a network error (or stop doing so). */
    unreachable: (p, on) => (on ? unreachable.add(p) : unreachable.delete(p)),
    /** {delay(json) -> ms, check(json) -> X-Speech-Check value}; missing parts keep the default. */
    setTts: (t) => {
      tts = { delay: (t && t.delay) || (() => 0), check: (t && t.check) || ((j) => (j.slow ? 'passed' : 'skipped')) };
    },
    setPageRead: (r) => {
      pageRead = r;
    },
    callsTo: (p) => calls.filter((c) => c.path === p),
    ttsFor: (text) => calls.filter((c) => c.path === '/api/tts' && c.json && c.json.text === text),
  };
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** Logs every media play() with what the page was doing at that moment. */
function mediaHook() {
  window.__plays = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.__plays.push({ t: Date.now(), screen: location.hash, recording: !!document.querySelector('[data-state="recording"]') });
    return play.call(this);
  };
}

async function newPage(browser, base, viewport, fakeOpts, pageOpts) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US', colorScheme: 'light' });
  await context.grantPermissions(['microphone'], { origin: base });
  const page = await context.newPage();
  await page.addInitScript(mediaHook);
  if (pageOpts && pageOpts.initScript) await page.addInitScript(pageOpts.initScript);
  page.setDefaultTimeout(10000);
  const fake = makeFakeApi(fakeOpts);
  const problems = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push('console error: ' + msg.text());
  });
  page.on('pageerror', (err) => problems.push('page error: ' + err.message));
  page.on('request', (req) => {
    const u = req.url();
    if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push('external request: ' + u);
  });
  await page.route('**/api/**', fake.handler);
  return { context, page, fake, problems };
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  // Sticky bars land mid-page in a full-page capture taken while scrolled.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

/** Screenshot of one element (useful where a sticky bar covers part of a full page). */
async function shotEl(page, selector, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.locator(selector).first().screenshot({ path: path.join(SHOTS, name + '.png') });
}

async function noHorizontalScroll(page) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(sw <= iw, `page is wider than the viewport: ${sw} > ${iw}`);
}

async function startSession(page, { consent, nickname }) {
  if (nickname !== undefined) await page.fill('#nickname', nickname);
  const box = page.locator('#consent');
  if (consent) await box.check();
  else await box.uncheck();
  await page.click('#btn-start');
}

async function confirmPageText(page, text) {
  await page.click('#nav [data-go="prepare"]');
  await page.fill('#page-text', text);
  await page.click('#btn-confirm');
  await page.waitForSelector('#prep-next:not([hidden])');
}

async function record(page, buttonSel, ms) {
  await page.click(buttonSel);
  await page.waitForSelector(`${buttonSel}[data-state="recording"]`);
  await sleep(ms);
  await page.click(buttonSel);
}

async function waitForCall(fake, p, count) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fake.callsTo(p).length >= count) return fake.callsTo(p)[count - 1];
    await sleep(25);
  }
  throw new Error(`no call #${count} to ${p}`);
}

/** Wait until `count` /api/tts requests asked for `text`. */
async function waitForTts(fake, text, count) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fake.ttsFor(text).length >= (count || 1)) return;
    await sleep(25);
  }
  throw new Error(`no /api/tts call #${count || 1} for "${text}"`);
}

/** Press "Confirm text" and wait until the server check of the text is over. */
async function pressConfirm(page) {
  await page.click('#btn-confirm');
  await page.waitForSelector('#btn-confirm:not([disabled])');
}

/** Change a Quran range field the way a person does (type, then leave the field). */
async function setRangeField(page, fake, sel, value) {
  const before = fake.callsTo('/api/quran/ayat').length;
  const same = (await page.inputValue(sel)) === value;
  await page.fill(sel, value);
  // Leaving the field fires "change", as for a person; an unchanged value does not.
  if (same) await page.dispatchEvent(sel, 'change');
  else await page.press(sel, 'Tab');
  return waitForCall(fake, '/api/quran/ayat', before + 1);
}

/** Chromium logs every 4xx answer as a console error; these flows provoke 400 and 422. */
const expected4xx = (problems) => problems.filter((p) => !/Failed to load resource: the server responded with a status of (400|422)/.test(p));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function checkSyntax() {
  for (const f of fs.readdirSync(WEB).filter((n) => n.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(WEB, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `node --check ${f} failed:\n${r.stderr}`);
  }
}

function rms(a, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
}

function zeroCrossings(a, from, to) {
  let n = 0;
  for (let i = from + 1; i < to; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) n++;
  return n;
}

function tone(rate, freq, seconds, amp) {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

async function recorderUnitTests() {
  const R = require(path.join(WEB, 'recorder.js'));

  await check('recorder.encodeWav writes a 16 kHz mono PCM16 header and clipped samples', () => {
    const buf = Buffer.from(R.encodeWav(new Float32Array([0, 1, -1, 0.5, 2, -2, NaN]), 16000));
    const h = parseWav(buf);
    assert.deepEqual(h, { riffSize: 36 + 14, format: 1, channels: 1, rate: 16000, byteRate: 32000, blockAlign: 2, bits: 16, dataBytes: 14 });
    const samples = [];
    for (let i = 0; i < 7; i++) samples.push(buf.readInt16LE(44 + 2 * i));
    assert.deepEqual(samples, [0, 32767, -32768, 16384, 32767, -32768, 0]);
  });

  await check('recorder.downsample 48 kHz -> 16 kHz keeps a 1 kHz tone', () => {
    const out = R.downsample(tone(48000, 1000, 1, 0.5), 48000, 16000);
    assert.equal(out.length, 16000);
    const level = rms(out, 200, 15800);
    assert.ok(Math.abs(level - 0.5 / Math.SQRT2) < 0.01, 'rms ' + level);
    const hz = zeroCrossings(out, 0, 16000) / 2;
    assert.ok(Math.abs(hz - 1000) <= 2, 'frequency ' + hz);
  });

  await check('recorder.downsample removes tones above 8 kHz instead of aliasing them', () => {
    for (const f of [9000, 12000, 20000]) {
      const out = R.downsample(tone(48000, f, 0.5, 0.5), 48000, 16000);
      const level = rms(out, 200, out.length - 200);
      assert.ok(level < 0.5 / Math.SQRT2 * 0.03, `${f} Hz leaks through: rms ${level}`);
    }
  });

  await check('recorder.downsample handles 44.1 kHz, equal rates, upsampling and empty input', () => {
    const out = R.downsample(tone(44100, 440, 1, 0.4), 44100, 16000);
    assert.equal(out.length, 16000);
    assert.ok(Math.abs(rms(out, 200, 15800) - 0.4 / Math.SQRT2) < 0.01);
    assert.ok(Math.abs(zeroCrossings(out, 0, 16000) / 2 - 440) <= 2);
    const same = R.downsample(new Float32Array([0.1, 0.2]), 16000, 16000);
    assert.deepEqual(Array.from(same).map((x) => Math.round(x * 10)), [1, 2]);
    assert.equal(R.downsample(new Float32Array(8000), 8000, 16000).length, 16000);
    assert.equal(R.downsample(new Float32Array(0), 48000).length, 0);
    assert.throws(() => R.downsample(new Float32Array(4), 0, 16000), RangeError);
  });

  await check('recorder.levelOf maps silence, -30 dBFS and full scale onto 0..1', () => {
    assert.equal(R.levelOf(new Float32Array(256)), 0);
    const mid = R.levelOf(new Float32Array(256).fill(10 ** (-30 / 20)));
    assert.ok(Math.abs(mid - 0.5) < 0.01, String(mid));
    assert.equal(R.levelOf(new Float32Array(256).fill(1)), 1);
  });
}

async function mainFlow(browser, base) {
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 });

  await check('loads with the AI badge, the disclosure and a health check', async () => {
    await page.goto(base + '/');
    await waitForCall(fake, '/api/health', 1);
    assert.ok(await page.isVisible('#screen-start'));
    assert.equal((await page.textContent('#ai-badge')).trim(), 'AI tutor — not a person');
    assert.ok(await page.isVisible('#ai-disclosure'));
    assert.equal(await page.getAttribute('html', 'dir'), 'ltr');
    assert.ok(await page.isHidden('#nav'));
    await page.waitForSelector('#consent-extra:not([hidden])');
    assert.match(await page.textContent('#consent-extra'), /Claude/);
    await shot(page, 'start-360');
    await noHorizontalScroll(page);
  });

  await check('switching the language to Arabic sets dir="rtl" and translates the UI', async () => {
    await page.selectOption('#ui-lang', 'ar');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.equal(await page.getAttribute('html', 'lang'), 'ar');
    assert.match(await page.textContent('#ai-badge'), /ليس إنسانًا/);
    assert.match(await page.textContent('#btn-start'), /لنبدأ/);
    await shot(page, 'start-360-ar');
    await noHorizontalScroll(page);
    await page.selectOption('#ui-lang', 'fr');
    assert.equal(await page.getAttribute('html', 'dir'), 'ltr');
    assert.match(await page.textContent('#ai-badge'), /pas une personne/);
    await page.selectOption('#ui-lang', 'en');
    assert.equal(await page.getAttribute('html', 'dir'), 'ltr');
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mommy.profile.v1')));
    assert.equal(stored.lang, 'en');
  });

  await check('without consent the microphone and camera stay disabled, with an explanation', async () => {
    await startSession(page, { consent: false, nickname: 'Sami' });
    await page.waitForSelector('#screen-prepare:not([hidden])');
    assert.ok(await page.isVisible('#nav'));
    assert.ok(await page.isDisabled('#prep-take'));
    assert.ok(await page.isDisabled('#prep-choose'));
    assert.match(await page.textContent('#why-prep-photo'), /consent/);
    await page.fill('#page-text', PAGE_TEXT);
    await pressConfirm(page);
    assert.match(await page.textContent('#prep-confirm-status'), /Text confirmed/);
    await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
    assert.match(await page.textContent('#recite-hello'), /Hi Sami!/);
    assert.ok(await page.isDisabled('#recite-rec'));
    assert.ok(await page.isVisible('#why-recite-rec'));
    assert.match(await page.textContent('#why-recite-rec'), /consent/);
    const profile = await page.evaluate(() => JSON.parse(localStorage.getItem('mommy.profile.v1')));
    assert.equal(profile.nickname, 'Sami');
    assert.equal(profile.consent, undefined, 'consent must not be stored');
  });

  await check('ticking consent enables the microphone and camera', async () => {
    await page.click('#btn-profile');
    await page.waitForSelector('#screen-start:not([hidden])');
    await page.check('#consent');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-recite:not([hidden])'); // the text is already confirmed
    assert.ok(await page.isEnabled('#recite-rec'));
    assert.ok(await page.isHidden('#why-recite-rec'));
    await page.click('#nav [data-go="prepare"]');
    assert.ok(await page.isEnabled('#prep-take'));
    assert.ok(await page.isHidden('#why-prep-photo'));
  });

  await check('a page photo is resized to <= 2000 px JPEG without EXIF, then read into the textarea', async () => {
    const b64 = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 3000;
      c.height = 1500;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 3000, 1500);
      g.fillStyle = '#123';
      g.font = '200px sans-serif';
      g.fillText('The cat sat on the mat.', 100, 700);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    const original = withExif(Buffer.from(b64, 'base64'));
    assert.ok(original.includes(Buffer.from('Exif')));
    await page.fill('#page-text', '');
    await page.setInputFiles('#prep-choose', { name: 'page.jpg', mimeType: 'image/jpeg', buffer: original });
    const call = await waitForCall(fake, '/api/page/read', 1);
    const img = call.form.image;
    assert.equal(img.type, 'image/jpeg');
    const size = jpegSize(img.data);
    assert.equal(Math.max(size.width, size.height), 2000);
    assert.equal(size.width, 2000);
    assert.equal(size.height, 1000);
    assert.ok(!img.data.includes(Buffer.from('Exif')), 'EXIF must be dropped');
    assert.equal(call.form.lang.text, 'en');
    await page.waitForFunction((t) => document.querySelector('#page-text').value === t, PAGE_TEXT);
    assert.equal(await page.inputValue('#prep-choose'), '', 'the file input is cleared');
    await pressConfirm(page);
    assert.match(await page.textContent('#prep-confirm-status'), /Text confirmed/);
  });

  await check('recite: records a 16 kHz mono PCM16 WAV and releases the microphone', async () => {
    await page.click('#nav [data-go="recite"]');
    await page.waitForSelector('#recite-text');
    assert.equal((await page.textContent('#recite-text')).trim(), PAGE_TEXT);
    await page.click('#recite-rec');
    await page.waitForSelector('#recite-rec[data-state="recording"]');
    const open = await page.evaluate(() => MommyRecorder.openStreams());
    // The fake microphone beeps about once a second, so watch the meter for a while.
    let maxLevel = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(50);
      const v = await page.evaluate(() => getComputedStyle(document.querySelector('#recite-meter')).getPropertyValue('--level'));
      maxLevel = Math.max(maxLevel, Number(v) || 0);
    }
    const meterOn = await page.isVisible('#recite-meter.is-on');
    await page.click('#recite-rec');
    assert.equal(open, 1);
    assert.ok(meterOn);
    assert.ok(maxLevel > 0, 'the level meter moves: ' + maxLevel);
    const call = await waitForCall(fake, '/api/recite/check', 1);
    const f = call.form;
    assert.equal(f.audio.filename, 'recitation.wav');
    assert.equal(f.audio.type, 'audio/wav');
    const h = parseWav(f.audio.data);
    assert.equal(h.format, 1);
    assert.equal(h.channels, 1);
    assert.equal(h.rate, 16000);
    assert.equal(h.bits, 16);
    assert.equal(h.dataBytes, f.audio.data.length - 44);
    const seconds = h.dataBytes / 32000;
    assert.ok(seconds > 1.2 && seconds < 3, 'duration ' + seconds);
    assert.equal(f.expected_text.text, PAGE_TEXT);
    assert.equal(f.lang.text, 'en');
    assert.equal(f.mode.text, 'strict');
    assert.equal(f.age.text, '6-9');
    assert.equal(await page.evaluate(() => MommyRecorder.openStreams()), 0, 'microphone released');
    if (fs.existsSync(PYTHON)) {
      // Cross-check with the backend's own WAV decoder (audio passed on stdin, never saved).
      const code = [
        'import sys, json',
        "sys.path.insert(0, sys.argv[1])",
        'from mommy.asr import decode_wav, audio_quality',
        'pcm = decode_wav(sys.stdin.buffer.read())',
        'print(json.dumps(audio_quality(pcm)))',
      ].join('\n');
      const r = spawnSync(PYTHON, ['-c', code, path.join(ROOT, 'backend')], { input: f.audio.data });
      assert.equal(r.status, 0, String(r.stderr));
      const q = JSON.parse(String(r.stdout));
      assert.ok(Math.abs(q.seconds - seconds) < 0.01, JSON.stringify(q));
    }
  });

  await check('recite: a strict result shows match, sub (with the heard word), del and ins in colour and shape', async () => {
    await page.waitForSelector('#recite-result:not([hidden])');
    assert.equal(await page.locator('#recite-text .w-match').count(), 4);
    assert.equal(await page.locator('#recite-text .w-sub').count(), 1);
    assert.equal((await page.textContent('#recite-text .w-sub .w-exp')).trim(), 'cat');
    assert.equal((await page.textContent('#recite-text .w-sub .w-heard')).trim(), 'hat');
    assert.equal(await page.locator('#recite-text del.w-del').count(), 1);
    assert.match(await page.textContent('#recite-text del.w-del'), /^on/);
    assert.equal(await page.locator('#recite-text ins.w-ins').count(), 1);
    assert.match(await page.textContent('#recite-text ins.w-ins'), /\[today\]/);
    const styles = await page.evaluate(() => {
      const cs = (sel) => getComputedStyle(document.querySelector(sel));
      return {
        match: cs('#recite-text .w-match').color,
        sub: cs('#recite-text .w-sub').color,
        subBorder: cs('#recite-text .w-sub').borderTopStyle,
        subLine: cs('#recite-text .w-sub .w-exp').textDecorationStyle,
        del: cs('#recite-text .w-del').textDecorationLine,
        delColor: cs('#recite-text .w-del').color,
        insSize: parseFloat(cs('#recite-text .w-ins').fontSize),
        matchSize: parseFloat(cs('#recite-text .w-match').fontSize),
      };
    });
    assert.notEqual(styles.match, styles.sub);
    assert.notEqual(styles.match, styles.delColor);
    assert.equal(styles.subBorder, 'dashed');
    assert.equal(styles.subLine, 'wavy');
    assert.match(styles.del, /line-through/);
    assert.ok(styles.insSize < styles.matchSize * 0.8, 'inserted words are small');
    assert.equal((await page.textContent('#recite-score')).trim(), 'Words right: 4 of 6');
    assert.equal((await page.textContent('#recite-feedback')).trim(), STRICT_RESULT.feedback);
    assert.ok(await page.isHidden('#recite-say-again'));
    assert.ok(await page.isVisible('#recite-legend'));
    const tts = await waitForCall(fake, '/api/tts', 1);
    assert.deepEqual(tts.json, { text: STRICT_RESULT.feedback, lang: 'en', slow: false });
    await shot(page, 'recite-360');
    await noHorizontalScroll(page);
  });

  await check('recite: say_again offers "Say that again" and does not mark the words', async () => {
    fake.queueRecite(SAY_AGAIN_RESULT);
    await record(page, '#recite-rec', 700);
    await waitForCall(fake, '/api/recite/check', 2);
    await page.waitForSelector('#recite-say-again:not([hidden])');
    assert.equal(await page.locator('#recite-text .w').count(), 0);
    // A clip that is too short is also "too quiet" (nobody had started speaking): the
    // hint names the real problem, a stop pressed too early.
    assert.equal((await page.textContent('#recite-quality')).trim(), 'That was very short. Press the button, read the whole text, then press it again.');
    // "Say that again" starts a new recording straight away.
    await page.click('#recite-say-again');
    await page.waitForSelector('#recite-rec[data-state="recording"]');
    await sleep(600);
    await page.click('#recite-rec');
    await waitForCall(fake, '/api/recite/check', 3);
    await page.waitForSelector('#recite-text .w-sub');
  });

  await check('recite: leaving the screen mid-recording releases the microphone', async () => {
    await page.click('#recite-rec');
    await page.waitForSelector('#recite-rec[data-state="recording"]');
    await page.click('#nav [data-go="dictation"]');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    await page.waitForFunction(() => MommyRecorder.openStreams() === 0);
    assert.equal(fake.callsTo('/api/recite/check').length, 3, 'a cancelled recording is not uploaded');
  });

  await check('recite: contextual mode shows the meaning verdict and missing ideas', async () => {
    await page.click('#nav [data-go="prepare"]');
    await page.check('input[name="mode"][value="contextual"]');
    await pressConfirm(page);
    await page.click('#prep-next [data-go="recite"]');
    assert.match(await page.textContent('#recite-mode-label'), /The meaning/);
    await record(page, '#recite-rec', 700);
    const call = await waitForCall(fake, '/api/recite/check', 4);
    assert.equal(call.form.mode.text, 'contextual');
    await page.waitForSelector('#recite-verdict:not([hidden])');
    assert.match(await page.textContent('#recite-verdict'), /Partly right/);
    assert.match(await page.textContent('#recite-missing'), /on the mat/);
    assert.ok(await page.isVisible('#recite-approx'));
    assert.equal((await page.textContent('#recite-feedback')).trim(), CONTEXTUAL_RESULT.feedback);
    await page.click('#nav [data-go="prepare"]');
    await page.check('input[name="mode"][value="strict"]');
    await pressConfirm(page);
  });

  await check('dictation: phrases are spoken slowly with Repeat and Next', async () => {
    await page.click('#nav [data-go="dictation"]');
    await page.click('#btn-dict-start');
    const ph = await waitForCall(fake, '/api/dictation/phrases', 1);
    assert.deepEqual(ph.json, { text: PAGE_TEXT, lang: 'en' });
    await page.waitForSelector('#dict-counter');
    assert.match(await page.textContent('#dict-counter'), /Part 1 of 2/);
    await waitForTts(fake, 'The cat sat');
    assert.deepEqual(fake.ttsFor('The cat sat')[0].json, { text: 'The cat sat', lang: 'en', slow: true });
    // While the first phrase plays, the next one is fetched ahead.
    await waitForTts(fake, 'on the mat.');
    assert.deepEqual(fake.ttsFor('on the mat.')[0].json, { text: 'on the mat.', lang: 'en', slow: true });
    const n = fake.callsTo('/api/tts').length;
    await page.click('#dict-repeat');
    await sleep(200);
    assert.equal(fake.callsTo('/api/tts').length, n, 'Repeat reuses the audio already fetched');
    assert.ok(await page.isHidden('#dict-unclear'), 'the speech check passed: no note');
    assert.ok(await page.isHidden('#dict-phrase'));
    await page.click('#dict-show');
    assert.equal((await page.textContent('#dict-phrase')).trim(), 'The cat sat');
    await page.click('#dict-next');
    assert.match(await page.textContent('#dict-counter'), /Part 2 of 2/);
    assert.match(await page.textContent('#dict-next'), /I've finished/);
    await sleep(200);
    assert.equal(fake.callsTo('/api/tts').length, n, 'the second phrase was already fetched');
    await shot(page, 'dictation-360');
    await page.click('#dict-next');
    await page.waitForSelector('[data-stage="check"]:not([hidden])');
  });

  await check('dictation: the parent confirms the result before the child sees it', async () => {
    const ttsBefore = fake.callsTo('/api/tts').length;
    await page.click('#btn-dict-check');
    assert.match(await page.textContent('#dict-check-status'), /type what your child wrote/);
    await page.fill('#dict-written', 'The cat sat on the matt');
    await page.click('#btn-dict-check');
    const call = await waitForCall(fake, '/api/dictation/check', 1);
    assert.equal(call.form.written_text.text, 'The cat sat on the matt');
    assert.equal(call.form.expected_text.text, PAGE_TEXT);
    assert.equal(call.form.lang.text, 'en');
    assert.equal(call.form.age.text, '6-9');
    assert.equal(call.form.image, undefined);
    await page.waitForSelector('[data-stage="review"]:not([hidden])');
    assert.ok(await page.isHidden('[data-stage="child"]'));
    assert.equal(await page.inputValue('#dict-read-text'), DICTATION_RESULT.read_text);
    assert.equal((await page.textContent('#dict-review-words .w-sub .w-heard')).trim(), 'matt');
    assert.equal(fake.callsTo('/api/tts').length, ttsBefore, 'nothing is spoken before the parent confirms');
    await shot(page, 'dictation-review-360');
    // The parent can correct what was read and check again (sent as typed text).
    await page.fill('#dict-read-text', 'The cat sat on the mat');
    await page.click('#btn-dict-recheck');
    const again = await waitForCall(fake, '/api/dictation/check', 2);
    assert.equal(again.form.written_text.text, 'The cat sat on the mat');
    await page.click('#btn-dict-confirm');
    await page.waitForSelector('[data-stage="child"]:not([hidden])');
    assert.ok(await page.isHidden('[data-stage="review"]'));
    assert.equal(await page.locator('#dict-child-words .w-match').count(), 5);
    assert.equal((await page.textContent('#dict-child-feedback')).trim(), DICTATION_RESULT.feedback);
    const spoken = await waitForCall(fake, '/api/tts', ttsBefore + 1);
    assert.deepEqual(spoken.json, { text: DICTATION_RESULT.feedback, lang: 'en', slow: false });
    await noHorizontalScroll(page);
  });

  await check('dictation: a photo of the paper is sent as a resized JPEG, then reviewed by the parent', async () => {
    await page.click('#btn-dict-new');
    await page.click('#btn-dict-start');
    await waitForCall(fake, '/api/dictation/phrases', 2);
    await page.click('#dict-next');
    await page.click('#dict-next');
    await page.waitForSelector('[data-stage="check"]:not([hidden])');
    const b64 = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 2400;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 1200, 2400);
      return c.toDataURL('image/png').split(',')[1];
    });
    await page.setInputFiles('#dict-choose', { name: 'paper.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
    const call = await waitForCall(fake, '/api/dictation/check', 3);
    assert.equal(call.form.image.type, 'image/jpeg');
    assert.deepEqual(jpegSize(call.form.image.data), { width: 1000, height: 2000 });
    assert.equal(call.form.written_text, undefined);
    assert.equal(call.form.expected_text.text, PAGE_TEXT);
    await page.waitForSelector('[data-stage="review"]:not([hidden])');
    assert.ok(await page.isHidden('[data-stage="child"]'));
  });

  await check('quran: Juz Amma by default, verbatim Uthmani text in RTL, Hafs – Tanzil attribution', async () => {
    await page.click('#nav [data-go="quran"]');
    await waitForCall(fake, '/api/quran/surahs', 1);
    const ayatCall = await waitForCall(fake, '/api/quran/ayat', 1);
    assert.equal(ayatCall.query.get('surah'), '78');
    assert.equal(ayatCall.query.get('from'), '1');
    assert.equal(ayatCall.query.get('to'), '10');
    const options = await page.$$eval('#quran-surah option', (os) => os.map((o) => Number(o.value)));
    assert.equal(options.length, 37);
    assert.equal(options[0], 78);
    assert.equal(options[36], 114);
    assert.equal((await page.textContent('#quran-riwaya')).trim(), 'Hafs – Tanzil');
    assert.equal((await page.textContent('#quran-attribution')).trim(), ATTRIBUTION);
    assert.equal(await page.getAttribute('#quran-link', 'href'), 'https://tanzil.net');
    // The English attribution and its link form one LTR run, so a wrapped line stays in
    // reading order in the Arabic UI.
    assert.equal(await page.$eval('#quran-link', (a) => a.closest('[dir]').getAttribute('dir')), 'ltr');
    assert.equal(await page.$eval('#quran-attribution', (s) => s.closest('[dir]').getAttribute('dir')), 'ltr');
    assert.equal(await page.getAttribute('#quran-text', 'dir'), 'rtl');
    assert.equal(await page.getAttribute('#quran-text', 'lang'), 'ar');
    assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('#quran-text')).fontFamily), /Amiri Quran/);
    await page.waitForSelector('#quran-text .ayah[data-ayah="10"]');
    for (let a = 1; a <= 10; a++) {
      const text = await page.textContent(`#quran-text .ayah[data-ayah="${a}"]`);
      assert.equal(text, ayah(78, a).display, `78:${a} is shown verbatim`);
    }
    await page.selectOption('#quran-surah', '112');
    await waitForCall(fake, '/api/quran/ayat', 2);
    await page.waitForSelector('#quran-text .ayah[data-ayah="4"]');
    assert.equal(await page.locator('#quran-text .ayah').count(), 4);
    for (let a = 1; a <= 4; a++) {
      assert.equal(await page.textContent(`#quran-text .ayah[data-ayah="${a}"]`), ayah(112, a).display);
    }
    assert.equal(await page.inputValue('#quran-to'), '4');
    await noHorizontalScroll(page);
  });

  await check('quran: a recitation is marked word by word with template feedback, never spoken', async () => {
    const ttsBefore = fake.callsTo('/api/tts').length;
    await record(page, '#quran-rec', 800);
    const call = await waitForCall(fake, '/api/quran/check', 1);
    assert.equal(call.form.surah.text, '112');
    assert.equal(call.form.from.text, '1');
    assert.equal(call.form.to.text, '4');
    assert.equal(parseWav(call.form.audio.data).rate, 16000);
    await page.waitForSelector('#quran-result:not([hidden])');
    assert.equal(await page.locator('#quran-text .qw.w-sub').count(), 1);
    assert.equal(await page.locator('#quran-text .qw.w-del').count(), 1);
    assert.equal(await page.locator('#quran-text ins.w-ins').count(), 1);
    const total = ayah(112, 1).display_words.length + ayah(112, 2).display_words.length + ayah(112, 3).display_words.length + ayah(112, 4).display_words.length;
    assert.equal(await page.locator('#quran-text .qw.w-match').count(), total - 2);
    const expectedSub = ayah(112, 1).display_words[1];
    assert.equal((await page.textContent('#quran-text .qw.w-sub .w-exp')).trim(), expectedSub);
    assert.equal((await page.textContent('#quran-text .qw.w-sub .w-heard')).trim(), 'هم');
    assert.equal((await page.textContent('#quran-text .qw.w-del')).replace(/\s*\(.*\)$/, ''), ayah(112, 2).display_words[1]);
    assert.ok(await page.isVisible('#quran-text .qw.w-first'));
    assert.equal((await page.textContent('#quran-feedback')).trim(), 'تنبيه: «' + expectedSub + '»');
    assert.equal(await page.getAttribute('#quran-feedback', 'dir'), 'rtl');
    assert.match(await page.textContent('#quran-first-error'), /ayah 1/);
    // The feedback is brought into view: on a phone the result card starts below the fold.
    await page.waitForFunction(() => {
      const r = document.querySelector('#quran-feedback').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    }, null, { timeout: 3000 });
    await sleep(300);
    assert.equal(fake.callsTo('/api/tts').length, ttsBefore, 'Quran feedback is never sent to TTS');
    assert.equal(await page.locator('#screen-quran button:has-text("Listen")').count(), 0);
    await shot(page, 'quran-360');
    await shotEl(page, '.quran-card', 'quran-card-360');
    await shotEl(page, '#quran-result', 'quran-result-360');
    await noHorizontalScroll(page);
  });

  await check('quran: from memory hides the text and reveals the next word on request', async () => {
    await page.check('input[name="qmode"][value="memory"]');
    assert.ok(await page.isHidden('#quran-text'));
    assert.ok(await page.isVisible('#quran-memory'));
    assert.ok(await page.isHidden('#quran-hint'));
    const words = ayah(112, 1).display_words;
    await page.click('#btn-quran-hint');
    assert.equal((await page.textContent('#quran-hint')).trim(), words[0]);
    await page.click('#btn-quran-hint');
    assert.equal((await page.textContent('#quran-hint')).trim(), words[0] + ' ' + words[1]);
    // After a check the marked text is shown; it can be hidden again.
    await record(page, '#quran-rec', 600);
    await waitForCall(fake, '/api/quran/check', 2);
    await page.waitForSelector('#quran-text:not([hidden]) .w-sub');
    await page.click('#btn-quran-rehide');
    assert.ok(await page.isHidden('#quran-text'));
    // The text itself is restored verbatim once the marks are cleared.
    const restored = await page.$$eval('#quran-text .ayah', (els) => els.map((e) => e.textContent));
    assert.deepEqual(restored, [1, 2, 3, 4].map((a) => ayah(112, a).display));
    await shot(page, 'quran-memory-360');
  });

  await check('quran: "Where am I?" records, calls /api/quran/locate and can jump there', async () => {
    await record(page, '#btn-quran-where', 700);
    const call = await waitForCall(fake, '/api/quran/locate', 1);
    assert.ok(call.form.audio && call.form.audio.data.length > 44);
    assert.equal(call.form.surah.text, '112');
    await page.waitForSelector('#quran-where-list:not([hidden]) .candidate');
    assert.match(await page.textContent('#quran-where-list .cand-title'), /ayah 2/);
    assert.equal(await page.getAttribute('#quran-where-list .cand-preview', 'dir'), 'rtl');
    await page.click('#quran-where-list .candidate button');
    const ayatCall = await waitForCall(fake, '/api/quran/ayat', 3);
    assert.equal(ayatCall.query.get('surah'), '112');
    assert.equal(ayatCall.query.get('from'), '2');
    await page.check('input[name="qmode"][value="looking"]');
    await page.waitForSelector('#quran-text .ayah[data-ayah="2"]');
    assert.equal(await page.evaluate(() => MommyRecorder.openStreams()), 0);
  });

  await check('quran screen in Arabic stays RTL and readable at 360 px', async () => {
    await page.click('#btn-profile');
    await page.selectOption('#ui-lang', 'ar');
    await page.click('#btn-start');
    await page.click('#nav [data-go="quran"]');
    await page.waitForSelector('#quran-text .ayah');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.match(await page.textContent('#quran-title'), /القرآن/);
    await shot(page, 'quran-360-ar');
    await noHorizontalScroll(page);
    await page.click('#nav [data-go="recite"]');
    await page.waitForSelector('#recite-main:not([hidden])');
    assert.equal(await page.getAttribute('#recite-text', 'dir'), 'ltr', 'an English text stays LTR in the Arabic UI');
    await shot(page, 'recite-360-ar');
    await noHorizontalScroll(page);
  });

  await check('recorder: the length limit stops capture and the ScriptProcessor fallback works', async () => {
    const r = await page.evaluate(async () => {
      const out = {};
      const limited = new MommyRecorder.Recorder({ maxSeconds: 1 });
      const hit = new Promise((resolve) => {
        limited.onLimit = resolve;
      });
      await limited.start();
      out.engine = limited.engine;
      await hit;
      const blob = await limited.stop();
      out.limitedBytes = blob.size;
      const saved = window.AudioWorkletNode;
      window.AudioWorkletNode = undefined;
      try {
        const fallback = new MommyRecorder.Recorder();
        await fallback.start();
        out.fallbackEngine = fallback.engine;
        await new Promise((res) => setTimeout(res, 500));
        const b = await fallback.stop();
        out.fallbackBytes = b.size;
      } finally {
        window.AudioWorkletNode = saved;
      }
      out.open = MommyRecorder.openStreams();
      return out;
    });
    assert.equal(r.engine, 'worklet');
    assert.ok(r.limitedBytes >= 44 + 31900 && r.limitedBytes <= 44 + 32000, 'one second at most: ' + r.limitedBytes);
    assert.equal(r.fallbackEngine, 'script-processor');
    assert.ok(r.fallbackBytes > 44 + 8000, String(r.fallbackBytes));
    assert.equal(r.open, 0);
    assert.equal(await page.evaluate(() => MommyRecorder.MAX_SECONDS), 120);
  });

  await check('main flow: no console errors, page errors or external requests', async () => {
    assert.deepEqual(problems, []);
  });

  await context.close();
}

async function desktopShots(browser, base) {
  const { context, page, problems } = await newPage(browser, base, { width: 1280, height: 900 });
  await check('desktop layout renders start, recite and Quran screens', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('#consent-extra:not([hidden])');
    await shot(page, 'start-desktop');
    await startSession(page, { consent: true, nickname: 'Lina' });
    await confirmPageText(page, PAGE_TEXT);
    await page.click('#prep-next [data-go="recite"]');
    await record(page, '#recite-rec', 600);
    await page.waitForSelector('#recite-text .w-sub');
    await shot(page, 'recite-desktop');
    await page.click('#nav [data-go="quran"]');
    await page.waitForSelector('#quran-text .ayah[data-ayah="10"]');
    await record(page, '#quran-rec', 600);
    await page.waitForSelector('#quran-text .w-sub');
    await shot(page, 'quran-desktop');
    await shotEl(page, '.quran-card', 'quran-card-desktop');
    await noHorizontalScroll(page);
    assert.deepEqual(problems, []);
  });
  await context.close();
}

/**
 * Every word of every label shown inside a round record button (idle, waiting and
 * recording, in en/fr/ar, read from app.js itself) fits inside the button, so no word is
 * ever split. "Commencer" used to break as "Commenc/er".
 */
async function recordLabelsFit(browser, base) {
  const source = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const labels = { en: [], fr: [], ar: [] };
  const order = ['en', 'fr', 'ar'];
  for (const key of ['rec_start', 'rec_stop', 'rec_wait', 'quran_rec']) {
    const re = new RegExp('^\\s*' + key + ": (['\"])(.*?)\\1,$", 'gm');
    const found = [...source.matchAll(re)].map((m) => m[2].replace(/\\'/g, "'"));
    assert.equal(found.length, 3, key + ' should exist once per language');
    found.forEach((text, i) => labels[order[i]].push(text));
  }
  for (const width of [360, 1280]) {
    const { context, page } = await newPage(browser, base, { width, height: 800 });
    await check(`record buttons: every label word fits inside the round button at ${width} px (en/fr/ar)`, async () => {
      await page.goto(base + '/');
      const tooWide = await page.evaluate((all) => {
        document.querySelector('#screen-recite').hidden = false;
        document.querySelector('#recite-main').hidden = false;
        const btn = document.querySelector('#recite-rec');
        const label = btn.querySelector('.rec-label');
        const saved = label.textContent;
        const cs = getComputedStyle(btn);
        const inner = btn.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const out = [];
        for (const [lang, texts] of Object.entries(all)) {
          for (const text of texts) {
            for (const word of text.split(/\s+/)) {
              const probe = document.createElement('span');
              probe.lang = lang;
              probe.style.whiteSpace = 'nowrap';
              probe.textContent = word;
              label.replaceChildren(probe);
              const w = probe.getBoundingClientRect().width;
              if (w > inner) out.push(`${lang} "${word}": ${Math.ceil(w)} px > ${Math.floor(inner)} px`);
            }
          }
        }
        label.textContent = saved;
        return out;
      }, labels);
      assert.deepEqual(tooWide, []);
      // The label itself never splits words.
      assert.equal(await page.$eval('#recite-rec .rec-label', (n) => getComputedStyle(n).overflowWrap), 'normal');
    });
    await context.close();
  }
}

async function darkMode(browser, base) {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await context.grantPermissions(['microphone'], { origin: base });
  const page = await context.newPage();
  const fake = makeFakeApi();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));
  await page.route('**/api/**', fake.handler);
  await check('dark mode follows prefers-color-scheme', async () => {
    await page.goto(base + '/');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(18, 20, 23)');
    await startSession(page, { consent: true, nickname: 'Sami' });
    await confirmPageText(page, PAGE_TEXT);
    await page.click('#prep-next [data-go="recite"]');
    await record(page, '#recite-rec', 600);
    await page.waitForSelector('#recite-text .w-sub');
    await shot(page, 'recite-dark-360');
    assert.deepEqual(problems, []);
  });
  await context.close();
}

async function unavailableFeatures(browser, base) {
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 }, {
    health: { asr: false, tts: false, brain: 'offline', quran: false, languages: ['ar', 'en', 'fr'] },
  });
  await check('missing ASR, TTS, Claude and Quran: buttons disabled with explanations', async () => {
    await page.goto(base + '/');
    await waitForCall(fake, '/api/health', 1);
    await page.waitForSelector('#consent-extra:not([hidden])');
    assert.match(await page.textContent('#consent-extra'), /Offline mode/);
    await startSession(page, { consent: true, nickname: '' });
    await page.waitForSelector('#screen-prepare:not([hidden])');
    assert.ok(await page.isDisabled('#prep-take'));
    assert.match(await page.textContent('#why-prep-photo'), /type or paste/);
    assert.ok(await page.isVisible('#mode-offline-note'));
    assert.ok(await page.isEditable('#page-text'), 'typing is always possible');
    await page.fill('#page-text', PAGE_TEXT);
    await page.click('#btn-confirm');
    await page.click('#prep-next [data-go="recite"]');
    assert.match(await page.textContent('#recite-hello'), /Hi there!/);
    assert.ok(await page.isDisabled('#recite-rec'));
    assert.match(await page.textContent('#why-recite-rec'), /speech recognition model is not installed/);
    await page.click('#nav [data-go="dictation"]');
    await page.click('#btn-dict-start');
    await page.waitForSelector('[data-stage="speak"]:not([hidden])');
    assert.ok(await page.isDisabled('#dict-repeat'));
    assert.match(await page.textContent('[data-why="dict-play"]'), /voice is not available/);
    await page.click('#dict-show');
    assert.equal((await page.textContent('#dict-phrase')).trim(), 'The cat sat', 'a grown-up can read the phrase');
    await page.click('#dict-next');
    await page.click('#dict-next');
    assert.ok(await page.isDisabled('#dict-take'));
    await page.click('#nav [data-go="quran"]');
    await page.waitForSelector('#screen-quran:not([hidden])');
    assert.ok(await page.isVisible('[data-why="quran"]'));
    assert.match(await page.textContent('[data-why="quran"]'), /Quran text is not available/);
    assert.ok(await page.isDisabled('#quran-surah'));
    assert.ok(await page.isDisabled('#quran-rec'));
    assert.equal(fake.callsTo('/api/quran/surahs').length, 0);
    assert.equal(fake.callsTo('/api/tts').length, 0);
    await shot(page, 'unavailable-360');
    assert.deepEqual(problems, []);
  });
  await context.close();
}

async function serverDown(browser, base) {
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 }, { healthDown: true });
  await check('server down: banner with retry, features disabled until the server answers', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('#server-banner:not([hidden])');
    await startSession(page, { consent: true, nickname: 'Sami' });
    await page.fill('#page-text', PAGE_TEXT);
    await page.click('#btn-confirm');
    await page.click('#prep-next [data-go="recite"]');
    assert.ok(await page.isDisabled('#recite-rec'));
    fake.setHealthDown(false);
    await page.click('#btn-retry');
    await page.waitForSelector('#server-banner', { state: 'hidden' });
    await page.waitForSelector('#recite-rec:not([disabled])');
    // The aborted health request is logged by the browser as a failed load; nothing else.
    const others = problems.filter((p) => !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(p));
    assert.deepEqual(others, []);
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// Regression checks for the review findings (each one failed before its fix)
// ---------------------------------------------------------------------------

const AR_TEXT = 'ذَهَبَ الْوَلَدُ إِلَى الْمَدْرَسَةِ مَعَ أَخِيهِ.';
const AR_QURAN_MSG = 'هذا النص من القرآن الكريم. يُرجى التدرّب عليه في قسم القرآن الكريم.';
const EN_QURAN_MSG = 'This text is from the Quran. Please practise it in the Quran section.';
const EN_PHRASE_MSG = 'Part of this text is an ayah of the Quran (for example the basmala), and the app never reads the Quran aloud, so this text cannot be used for dictation. It can still be recited.';
const AR_PHRASE_MSG = 'جزء من هذا النص آية من القرآن الكريم (مثل البسملة)، والتطبيق لا يقرأ القرآن الكريم بصوت مسموع أبدًا، لذلك لا يمكن استخدام هذا النص في الإملاء، ولكن يمكن تسميعه.';
const DICT_START_WHY = '[data-stage="intro"] [data-why="dict-start"]';
const WESTERN_DIGIT = /[0-9]/;

/**
 * Runs in the page: is every ayah number on the line of the last word of its ayah, and
 * every standalone pause or sajdah mark on the line of the word before it?
 */
function quranWrapReport() {
  const mid = (r) => r.top + r.height / 2;
  const lastRect = (node) => {
    const rects = node.getClientRects();
    return rects[rects.length - 1];
  };
  const bad = [];
  let markers = 0;
  let marks = 0;
  for (const num of document.querySelectorAll('#quran-text .ayah-num')) {
    markers++;
    const ayahEl = num.previousElementSibling;
    const words = ayahEl.querySelectorAll('.qw');
    const last = lastRect(words[words.length - 1]);
    if (Math.abs(mid(last) - mid(num.getBoundingClientRect())) > last.height / 2) bad.push('number of ayah ' + ayahEl.dataset.ayah);
  }
  for (const ayahEl of document.querySelectorAll('#quran-text .ayah')) {
    const words = [...ayahEl.querySelectorAll('.qw')];
    const walker = document.createTreeWalker(ayahEl, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement.closest('.qw')) continue; // marks inside a word belong to it
      for (let i = 0; i < node.data.length; i++) {
        const c = node.data.charCodeAt(i);
        if (c < 0x06d6 || c > 0x06ed) continue;
        marks++;
        const before = words.filter((w) => w.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (!before.length) continue;
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const p = lastRect(before[before.length - 1]);
        if (Math.abs(mid(range.getBoundingClientRect()) - mid(p)) > p.height / 2) bad.push(`mark U+${c.toString(16)} in ayah ${ayahEl.dataset.ayah}`);
      }
    }
  }
  return { markers, marks, bad };
}

async function arabicFlow(browser, base) {
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 });

  await check('ar: the consent sentence suits a mother as well as a father (UX-13); the text language follows the UI language (UX-1)', async () => {
    await page.goto(base + '/');
    await waitForCall(fake, '/api/health', 1);
    await page.selectOption('#ui-lang', 'ar');
    assert.equal((await page.textContent('label[for="consent"]')).trim(), 'أنا أحد والدَي هذا الطفل أو وليّ أمره، وأسمح لـ Mommy باستخدام الميكروفون والكاميرا.');
    assert.match(await page.textContent('#consent-extra'), /نسخة مكتوبة مما يقوله طفلك/);
    await startSession(page, { consent: true, nickname: 'سامي' });
    await page.waitForSelector('#screen-prepare:not([hidden])');
    assert.equal(await page.inputValue('#page-lang'), 'ar', 'the browser is en-US, but the parent picked Arabic');
    assert.equal(await page.getAttribute('#page-text', 'dir'), 'rtl');
  });

  await check('ar: Quran text is refused at "Confirm text", in Arabic, with a button to the Quran section (W1, UX-2)', async () => {
    await page.fill('#page-text', QURAN_SAMPLE);
    await page.click('#btn-confirm');
    await page.waitForSelector('#prep-confirm-status.is-error');
    assert.equal((await page.textContent('#prep-confirm-status')).trim(), AR_QURAN_MSG);
    assert.ok(await page.isHidden('#prep-next'), 'the text is not confirmed');
    const call = fake.callsTo('/api/dictation/phrases').at(-1);
    assert.deepEqual(call.json, { text: QURAN_SAMPLE, lang: 'ar' });
    const go = page.locator('#prep-confirm-status + .status-action');
    assert.equal((await go.textContent()).trim(), 'الانتقال إلى قسم القرآن الكريم');
    await go.click();
    await page.waitForSelector('#screen-quran:not([hidden])');
    await page.waitForSelector('#quran-text .ayah[data-ayah="10"]');
  });

  await check('ar: score, timer and dictation counter use Arabic-Indic digits; the score line is grammatical (W4, QUR-7, UX-12)', async () => {
    await page.click('#nav [data-go="prepare"]');
    await page.fill('#page-text', AR_TEXT);
    await pressConfirm(page);
    await page.waitForSelector('#prep-next:not([hidden])');
    assert.ok(await page.isHidden('#prep-confirm-status + .status-action'), 'the Quran button went away');
    await page.click('#prep-next [data-go="recite"]');
    await page.click('#recite-rec');
    await page.waitForSelector('#recite-rec[data-state="recording"]');
    await page.waitForFunction(() => document.querySelector('#recite-timer').textContent.trim() !== '');
    const timer = (await page.textContent('#recite-timer')).trim();
    await sleep(400);
    await page.click('#recite-rec');
    assert.match(timer, /^[٠-٩]+ ث$/);
    await page.waitForSelector('#recite-result:not([hidden])');
    assert.equal((await page.textContent('#recite-score')).trim(), 'الكلمات الصحيحة: ٤ من ٦');
    await page.click('#nav [data-go="dictation"]');
    await page.click('#btn-dict-start');
    await page.waitForSelector('[data-stage="speak"]:not([hidden])');
    assert.equal((await page.textContent('#dict-counter')).trim(), 'الجزء ١ من ٢');
    // Numbers stored with a status are formatted again when the UI language changes.
    await page.click('#btn-profile');
    await page.selectOption('#ui-lang', 'en');
    assert.equal((await page.textContent('#dict-counter')).trim(), 'Part 1 of 2');
    assert.equal((await page.textContent('#recite-score')).trim(), 'Words right: 4 of 6');
    await page.selectOption('#ui-lang', 'ar');
    assert.equal((await page.textContent('#recite-score')).trim(), 'الكلمات الصحيحة: ٤ من ٦');
    await page.click('#btn-start');
  });

  await check('ar: Quran refusals after reciting and from the dictation voice are localized, without the English server text (W1, UX-2)', async () => {
    fake.refuse('/api/recite/check', true);
    await page.click('#nav [data-go="recite"]');
    await record(page, '#recite-rec', 600);
    await page.waitForSelector('#recite-status.is-error');
    assert.equal((await page.textContent('#recite-status')).trim(), AR_QURAN_MSG);
    assert.ok(await page.isVisible('#recite-status + .status-action'));
    fake.refuse('/api/recite/check', false);
    // The voice refuses a phrase of a confirmed text (an ayah inside a school text): the
    // text is not "from the Quran", so the child is not sent to the Quran section; the
    // dictation goes back to its start, where the disabled button says why (R1).
    fake.refuse('/api/tts', true);
    await page.click('#nav [data-go="prepare"]');
    await pressConfirm(page); // a new confirmation starts a new dictation
    await page.click('#nav [data-go="dictation"]');
    const before = fake.callsTo('/api/tts').length;
    await page.click('#btn-dict-start');
    await waitForCall(fake, '/api/tts', before + 1);
    await page.waitForSelector('#btn-dict-start[disabled]:not([data-busy])');
    assert.ok(await page.isVisible('[data-stage="intro"]'));
    assert.ok(await page.isVisible(DICT_START_WHY));
    assert.equal((await page.textContent(DICT_START_WHY)).trim(), AR_PHRASE_MSG);
    assert.equal((await page.textContent('#dict-intro-status')).trim(), '');
    assert.equal(await page.locator('#dict-speak-status + .status-action, #dict-intro-status + .status-action').count(), 0);
    await shot(page, 'dictation-voice-refused-ar-360');
    fake.refuse('/api/tts', false);
    await page.click('#nav [data-go="quran"]');
    await page.waitForSelector('#screen-quran:not([hidden])');
  });

  await check('ar: the Quran screen names the riwaya in Arabic, keeps the English attribution verbatim, and the two modes read as a pair (R4, R10)', async () => {
    await page.waitForSelector('#quran-text .ayah[data-ayah="10"]');
    assert.equal((await page.textContent('#quran-riwaya')).trim(), 'رواية حفص عن عاصم (Tanzil)');
    assert.equal((await page.textContent('#quran-attribution')).trim(), ATTRIBUTION);
    const modes = await page.$$eval('#screen-quran .seg-title', (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(modes, ['مع رؤية النص', 'من الحفظ']);
    for (const box of await page.$$('#screen-quran .seg-title')) {
      const fits = await box.evaluate((e) => e.scrollWidth <= e.clientWidth + 1);
      assert.ok(fits, 'a mode label overflows at 360 px');
    }
    await noHorizontalScroll(page);
  });

  await check('ar: ayah range fields show Arabic-Indic digits and accept both digit systems; "look again at ayah" too (W4)', async () => {
    await page.waitForSelector('#quran-text .ayah[data-ayah="10"]');
    assert.equal(await page.inputValue('#quran-from'), '١');
    assert.equal(await page.inputValue('#quran-to'), '١٠');
    let call = await setRangeField(page, fake, '#quran-from', '٢'); // Arabic-Indic, as typed on an Arabic keyboard
    assert.equal(call.query.get('from'), '2');
    call = await setRangeField(page, fake, '#quran-to', '5'); // Western digits
    assert.equal(call.query.get('to'), '5');
    await page.waitForSelector('#quran-text .ayah[data-ayah="5"]');
    assert.equal(await page.inputValue('#quran-from'), '٢');
    assert.equal(await page.inputValue('#quran-to'), '٥');
    await record(page, '#quran-rec', 600);
    await page.waitForSelector('#quran-result:not([hidden])');
    assert.equal((await page.textContent('#quran-first-error')).trim(), 'هيا نراجع الآية ٢.');
    assert.equal(await page.getAttribute('#quran-text .ayah-num', 'aria-label'), 'الآية ٢');
  });

  await check('ar: at 360 px no ayah number is cut off from its ayah, and pause marks stay with their word (QUR-4)', async () => {
    await page.uncheck('#quran-juz');
    for (const [s, to] of [[78, 40], [96, 19], [2, 50], [36, 50]]) {
      if ((await page.inputValue('#quran-surah')) !== String(s)) {
        const before = fake.callsTo('/api/quran/ayat').length;
        await page.selectOption('#quran-surah', String(s));
        await waitForCall(fake, '/api/quran/ayat', before + 1);
      }
      await setRangeField(page, fake, '#quran-from', '1');
      await setRangeField(page, fake, '#quran-to', String(to));
      await page.waitForFunction((n) => document.querySelectorAll('#quran-text .ayah').length === n && document.querySelector('#quran-text .ayah').dataset.ayah === '1', to);
      const shown = await page.$$eval('#quran-text .ayah', (els) => els.map((e) => e.textContent));
      for (let a = 1; a <= to; a++) assert.equal(shown[a - 1], ayah(s, a).display, `${s}:${a} is still shown verbatim`);
      const r = await page.evaluate(quranWrapReport);
      assert.equal(r.markers, to);
      assert.deepEqual(r.bad, [], `${s}:1-${to}: ${r.bad.length} of ${r.markers} numbers / ${r.marks} marks wrapped away`);
      await noHorizontalScroll(page);
    }
    await shot(page, 'quran-wrap-ar-360');
    // Back to Juz' Amma while surah 36 is shown: the first surah of the Juz is loaded.
    const before = fake.callsTo('/api/quran/ayat').length;
    await page.check('#quran-juz');
    const call = await waitForCall(fake, '/api/quran/ayat', before + 1);
    assert.deepEqual([call.query.get('surah'), call.query.get('from'), call.query.get('to')], ['78', '1', '10']);
    await page.waitForFunction(() => document.querySelectorAll('#quran-text .ayah').length === 10);
  });

  await check('ar flow: no console errors (besides the refusals asked for), page errors or external requests', async () => {
    assert.deepEqual(expected4xx(problems), []);
  });
  await context.close();
}

async function fixesFlow(browser, base) {
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 }, { phrases: ['Phrase one', 'Phrase two', 'Phrase three'] });
  await page.goto(base + '/');
  await startSession(page, { consent: true, nickname: 'Sami' });
  await page.waitForSelector('#screen-prepare:not([hidden])');

  const tinyPng = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 30;
    return c.toDataURL('image/png').split(',')[1];
  });

  await check('prepare: a page read with Quran text suggests the Quran section (W3)', async () => {
    fake.setPageRead({ text: 'A page.', lang: 'en', notes: '', source: 'claude', needs_manual: false, contains_quran: true });
    await page.setInputFiles('#prep-choose', { name: 'p.png', mimeType: 'image/png', buffer: Buffer.from(tinyPng, 'base64') });
    await page.waitForSelector('#prep-quran-note:not(:empty)');
    assert.equal((await page.textContent('#prep-quran-note')).trim(), 'This page seems to contain Quran text. Please practise the Quran in the Quran section.');
    assert.equal((await page.textContent('#prep-quran-note + .status-action')).trim(), 'Go to the Quran section');
    fake.setPageRead(null);
    const before = fake.callsTo('/api/page/read').length;
    await page.setInputFiles('#prep-choose', { name: 'p.png', mimeType: 'image/png', buffer: Buffer.from(tinyPng, 'base64') });
    await waitForCall(fake, '/api/page/read', before + 1);
    await page.waitForFunction((t) => document.querySelector('#page-text').value === t, PAGE_TEXT);
    assert.ok(await page.isHidden('#prep-quran-note'));
    assert.equal(await page.locator('#prep-quran-note + .status-action').count(), 0);
  });

  await check('prepare: Arabic text with "English" selected is set to Arabic; Latin text with "Arabic" is refused (UX-1)', async () => {
    await page.selectOption('#page-lang', 'en');
    await page.fill('#page-text', AR_TEXT);
    await pressConfirm(page);
    await page.waitForSelector('#prep-next:not([hidden])');
    assert.equal(await page.inputValue('#page-lang'), 'ar');
    assert.equal(await page.getAttribute('#page-text', 'dir'), 'rtl');
    assert.equal(fake.callsTo('/api/dictation/phrases').at(-1).json.lang, 'ar');
    assert.match(await page.textContent('#prep-confirm-status'), /set to Arabic/);
    await page.fill('#page-text', PAGE_TEXT);
    await page.click('#btn-confirm');
    assert.equal((await page.textContent('#prep-confirm-status')).trim(), 'This text is not written in Arabic. Please choose the language of the text.');
    assert.ok(await page.isHidden('#prep-next'));
  });

  await check('prepare: a text that is too long is refused at "Confirm text" (UX-2)', async () => {
    await page.selectOption('#page-lang', 'en');
    await page.fill('#page-text', 'word '.repeat(4001));
    await page.click('#btn-confirm');
    await page.waitForSelector('#prep-confirm-status.is-error');
    assert.equal((await page.textContent('#prep-confirm-status')).trim(), 'This text is too long. Please use a shorter text.');
    assert.ok(await page.isHidden('#prep-next'));
    await page.fill('#page-text', PAGE_TEXT);
    await pressConfirm(page);
    await page.waitForSelector('#prep-next:not([hidden])');
  });

  await check('recite: changing the reciting mode clears the old result (UX-11)', async () => {
    await page.click('#prep-next [data-go="recite"]');
    await record(page, '#recite-rec', 600);
    await page.waitForSelector('#recite-text .w-sub');
    await page.click('#nav [data-go="prepare"]');
    await page.check('input[name="mode"][value="contextual"]');
    await page.click('#nav [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
    assert.match(await page.textContent('#recite-mode-label'), /The meaning/);
    assert.ok(await page.isHidden('#recite-result'));
    assert.equal(await page.locator('#recite-text .w').count(), 0);
    assert.equal((await page.textContent('#recite-text')).trim(), PAGE_TEXT);
  });

  await check('recite: "same meaning" with missing ideas reads "Nearly the same meaning" (W5)', async () => {
    const base = { mode: 'contextual', heard_text: 'the cat sat', feedback: 'Good!', quality: STRICT_RESULT.quality };
    fake.queueRecite(Object.assign({}, base, { judgement: { verdict: 'same_meaning', missing_ideas: ['on the mat'], wrong_ideas: [] } }));
    await record(page, '#recite-rec', 600);
    await page.waitForSelector('#recite-verdict:not([hidden])');
    assert.equal((await page.textContent('#recite-verdict')).trim(), 'Nearly the same meaning');
    assert.match(await page.getAttribute('#recite-verdict', 'class'), /verdict-nearly/);
    assert.match(await page.textContent('#recite-missing'), /on the mat/);
    fake.queueRecite(Object.assign({}, base, { judgement: { verdict: 'same_meaning', missing_ideas: [], wrong_ideas: [] } }));
    await record(page, '#recite-rec', 600);
    await page.waitForFunction(() => document.querySelector('#recite-verdict').textContent.trim() === 'Same meaning');
    assert.match(await page.getAttribute('#recite-verdict', 'class'), /verdict-same_meaning/);
  });

  await check('recite: spoken feedback that arrives late never plays during a recording or on another screen (UX-7)', async () => {
    fake.setTts({ delay: (j) => (j.slow ? 0 : 900) });
    const before = fake.callsTo('/api/recite/check').length;
    await record(page, '#recite-rec', 600);
    await waitForCall(fake, '/api/recite/check', before + 1);
    await page.waitForSelector('#recite-result:not([hidden])');
    // The child taps the record button again before the voice has arrived.
    await page.click('#recite-rec');
    await page.waitForSelector('#recite-rec[data-state="recording"]');
    await sleep(1400);
    await page.click('#recite-rec');
    await waitForCall(fake, '/api/recite/check', before + 2);
    await page.waitForSelector('#recite-result:not([hidden])');
    // ... and opens the Quran section right after the next result.
    await page.click('#nav [data-go="quran"]');
    await sleep(1400);
    const plays = await page.evaluate(() => window.__plays);
    assert.deepEqual(plays.filter((p) => p.recording), [], 'nothing is played while the child is recording');
    assert.deepEqual(plays.filter((p) => p.screen === '#quran'), [], 'no synthetic voice on the Quran screen');
    fake.setTts(null);
  });

  await check('dictation: Next and Repeat wait while a phrase is prepared, and a double tap cannot skip a phrase (UX-4)', async () => {
    fake.setTts({ delay: (j) => (j.slow ? 600 : 0), check: (j) => (j.text === 'Phrase two' ? 'failed' : j.slow ? 'passed' : 'skipped') });
    await page.click('#nav [data-go="dictation"]');
    await page.click('#btn-dict-start');
    await page.waitForSelector('[data-stage="speak"]:not([hidden])');
    assert.ok(await page.isDisabled('#dict-next'), 'Next waits for the voice');
    assert.ok(await page.isDisabled('#dict-repeat'), 'Repeat waits for the voice');
    assert.equal((await page.textContent('#dict-speak-status')).trim(), 'Getting ready…');
    await page.$eval('#dict-next', (b) => {
      b.click();
      b.click();
    });
    assert.equal((await page.textContent('#dict-counter')).trim(), 'Part 1 of 3');
    await page.waitForSelector('#dict-next:not([disabled])');
    assert.equal((await page.textContent('#dict-speak-status')).trim(), '');
    await waitForTts(fake, 'Phrase two'); // fetched ahead while phrase one plays
    await page.$eval('#dict-next', (b) => {
      b.click();
      b.click(); // a double tap
    });
    assert.equal((await page.textContent('#dict-counter')).trim(), 'Part 2 of 3');
    await page.waitForSelector('#dict-next:not([disabled])');
    assert.equal((await page.textContent('#dict-counter')).trim(), 'Part 2 of 3', 'phrase two was heard before Next opened again');
  });

  await check('dictation: a failed speech check shows a note, and Repeat fetches a fresh take (W2)', async () => {
    await page.waitForSelector('#dict-unclear:not([hidden])');
    assert.equal((await page.textContent('#dict-unclear')).trim(), 'The voice may be unclear in this part. Press “Repeat” to hear a new take, or show the words.');
    assert.equal(fake.ttsFor('Phrase two').length, 1);
    await page.click('#dict-repeat');
    await waitForTts(fake, 'Phrase two', 2);
    await page.waitForSelector('#dict-next:not([disabled])');
    await page.click('#dict-next');
    assert.equal((await page.textContent('#dict-counter')).trim(), 'Part 3 of 3');
    await page.waitForSelector('#dict-next:not([disabled])');
    assert.ok(await page.isHidden('#dict-unclear'), 'phrase three passed its check');
    const n = fake.callsTo('/api/tts').length;
    await page.click('#dict-repeat');
    await page.waitForSelector('#dict-next:not([disabled])');
    assert.equal(fake.callsTo('/api/tts').length, n, 'a phrase that passed is repeated from memory');
    await page.click('#dict-next');
    await page.waitForSelector('[data-stage="check"]:not([hidden])');
    fake.setTts(null);
  });

  await check('dictation: a Quran refusal of the check is localized, with a button to the Quran section (W1)', async () => {
    fake.refuse('/api/dictation/check', true);
    await page.fill('#dict-written', 'The cat sat on the matt');
    await page.click('#btn-dict-check');
    await page.waitForSelector('#dict-check-status.is-error');
    assert.equal((await page.textContent('#dict-check-status')).trim(), EN_QURAN_MSG);
    assert.ok(await page.isVisible('#dict-check-status + .status-action'));
    fake.refuse('/api/dictation/check', false);
  });

  await check('dictation: after the parent edits "What was read", the result must be checked again before the child sees it (UX-3)', async () => {
    await page.click('#btn-dict-check');
    await page.waitForSelector('[data-stage="review"]:not([hidden])');
    assert.ok(await page.isHidden('#dict-check-status + .status-action'), 'the Quran button went away');
    assert.ok(await page.isEnabled('#btn-dict-confirm'));
    assert.ok(await page.isHidden('#dict-stale'));
    await page.fill('#dict-read-text', 'The cat sat on the mat');
    assert.ok(await page.isDisabled('#btn-dict-confirm'), 'the shown marks no longer match the text');
    assert.equal((await page.textContent('#dict-stale')).trim(), 'You changed the text. Press “Check again with this text” before you confirm.');
    const corrected = JSON.parse(JSON.stringify(DICTATION_RESULT));
    corrected.read_text = 'The cat sat on the mat';
    corrected.result.ops[5] = { kind: 'match', exp_index: 5, heard_index: 5, expected: 'mat', heard: 'mat' };
    corrected.result.n_errors = 0;
    corrected.result.verdict = 'correct';
    corrected.feedback = 'Perfect!';
    fake.queueDictation(corrected);
    await page.click('#btn-dict-recheck');
    await page.waitForSelector('#btn-dict-confirm:not([disabled])');
    assert.ok(await page.isHidden('#dict-stale'));
    fake.refuse('/api/tts', true); // for the "Listen" check below
    await page.click('#btn-dict-confirm');
    await page.waitForSelector('[data-stage="child"]:not([hidden])');
    assert.equal(await page.locator('#dict-child-words .w-match').count(), 6);
    assert.equal(await page.locator('#dict-child-words .w-sub').count(), 0);
    // An error from "Listen" is shown on the child's card, not on the hidden review card.
    await page.click('#dict-listen');
    await page.waitForSelector('#dict-child-status.is-error');
    assert.equal((await page.textContent('#dict-child-status')).trim(), EN_QURAN_MSG);
    fake.refuse('/api/tts', false);
  });

  await check('prepare: a basmala on its own line is confirmed for reciting, and dictation says why it cannot read it; [?] marks are explained (final verification)', async () => {
    await page.click('#nav [data-go="prepare"]');
    await page.waitForSelector('#screen-prepare:not([hidden])');
    // A page read with [?] marks: Confirm explains them instead of "Something went wrong".
    await page.selectOption('#page-lang', 'en');
    await page.fill('#page-text', 'The [?] sat on the mat.');
    await page.click('#btn-confirm');
    await page.waitForSelector('#prep-confirm-status.is-error');
    assert.equal((await page.textContent('#prep-confirm-status')).trim(), 'Some words could not be read and are marked [?]. Please type them in place of [?] first.');
    assert.ok(await page.isHidden('#prep-next'));
    // The basmala as a phrase of its own: confirmed (it can be recited), with a note.
    await page.selectOption('#page-lang', 'ar');
    await page.fill('#page-text', BASMALA_TEXT);
    await pressConfirm(page);
    await page.waitForSelector('#prep-next:not([hidden])');
    const note = (await page.textContent('#prep-confirm-status')).trim();
    assert.equal(note, 'Text confirmed for reciting. It cannot be used for dictation: part of it is an ayah of the Quran (for example the basmala), and the app never reads the Quran aloud.');
    assert.ok(!note.includes(QURAN_PHRASE_MESSAGE));
    assert.equal(await page.locator('#prep-confirm-status + .status-action').count(), 0);
    await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
    assert.equal((await page.textContent('#recite-text')).trim(), BASMALA_TEXT);
    assert.ok(await page.isEnabled('#recite-rec'));
    // Dictation: the refusal is already known, so "Start the dictation" is disabled and
    // the specific, localized reason is shown next to it (no English server text).
    const before = fake.callsTo('/api/dictation/phrases').length;
    await page.click('#nav [data-go="dictation"]');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    assert.ok(await page.isDisabled('#btn-dict-start'));
    assert.ok(await page.isVisible(DICT_START_WHY));
    assert.equal((await page.textContent(DICT_START_WHY)).trim(), EN_PHRASE_MSG);
    assert.equal(fake.callsTo('/api/dictation/phrases').length, before, 'nothing is asked again');
    assert.equal(fake.callsTo('/api/tts').filter((c) => c.json.text.includes('بسم')).length, 0);
    await page.click('#nav [data-go="prepare"]');
    await page.selectOption('#page-lang', 'en');
    await page.fill('#page-text', PAGE_TEXT);
    await pressConfirm(page);
    await page.waitForSelector('#prep-next:not([hidden])');
  });

  await check('fixes flow: no console errors (besides the refusals asked for), page errors or external requests', async () => {
    assert.deepEqual(expected4xx(problems), []);
  });
  await context.close();
}

/**
 * A text with a phrase that is a whole ayah (often the basmala on its own line) can be
 * recited but not dictated. Once the server has said so, "Start the dictation" stays
 * disabled with the reason next to it, until the text is changed or confirmed again.
 */
async function dictationPhraseFlow(browser, base) {
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 });
  await page.goto(base + '/');
  await startSession(page, { consent: true, nickname: 'Lina' });
  await page.waitForSelector('#screen-prepare:not([hidden])');
  const phraseCalls = () => fake.callsTo('/api/dictation/phrases').length;
  const NO_DICTATION_NOTE = 'Text confirmed for reciting. It cannot be used for dictation: part of it is an ayah of the Quran (for example the basmala), and the app never reads the Quran aloud.';

  /** Confirm the text while the server cannot be reached: it is confirmed anyway. */
  async function confirmOffline() {
    fake.unreachable('/api/dictation/phrases', true);
    const before = phraseCalls();
    await pressConfirm(page);
    await waitForCall(fake, '/api/dictation/phrases', before + 1);
    await page.waitForSelector('#prep-next:not([hidden])');
    fake.unreachable('/api/dictation/phrases', false);
  }

  /** Press "Start the dictation": the server refuses the text (scope "phrase"). */
  async function startRefused() {
    await page.click('#nav [data-go="dictation"]');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    assert.ok(await page.isEnabled('#btn-dict-start'), 'the refusal is not known yet');
    assert.ok(await page.isHidden(DICT_START_WHY));
    const before = phraseCalls();
    await page.click('#btn-dict-start');
    await waitForCall(fake, '/api/dictation/phrases', before + 1);
    // Disabled for the refusal, not only busy while the request runs.
    await page.waitForSelector('#btn-dict-start[disabled]:not([data-busy])');
  }

  await check('dictation: after a whole-ayah phrase refusal, "Start the dictation" is disabled with the reason shown once, and a press sends nothing (W3)', async () => {
    await page.selectOption('#page-lang', 'ar');
    await page.fill('#page-text', BASMALA_TEXT);
    await confirmOffline();
    await startRefused();
    assert.ok(await page.isVisible(DICT_START_WHY));
    assert.equal((await page.textContent(DICT_START_WHY)).trim(), EN_PHRASE_MSG);
    assert.equal(await page.getAttribute('#btn-dict-start', 'aria-describedby'), await page.getAttribute(DICT_START_WHY, 'id'));
    assert.equal((await page.textContent('#dict-intro-status')).trim(), '', 'the reason is not repeated in the status line');
    const n = phraseCalls();
    await page.$eval('#btn-dict-start', (b) => b.click()); // a disabled button ignores it
    await sleep(300);
    assert.equal(phraseCalls(), n, 'nothing is asked again');
    assert.ok(await page.isVisible('[data-stage="intro"]'));
    // The reason follows the interface language.
    await page.click('#btn-profile');
    await page.selectOption('#ui-lang', 'ar');
    await page.click('#btn-start');
    await page.click('#nav [data-go="dictation"]');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    assert.ok(await page.isDisabled('#btn-dict-start'));
    assert.ok(await page.isVisible(DICT_START_WHY));
    assert.equal((await page.textContent(DICT_START_WHY)).trim(), AR_PHRASE_MSG);
    await shot(page, 'dictation-phrase-refused-ar-360');
    await noHorizontalScroll(page);
    await page.click('#btn-profile');
    await page.selectOption('#ui-lang', 'en');
    await page.click('#btn-start');
  });

  await check('dictation: with dictation ruled out, reciting the same text stays available (W3)', async () => {
    await page.click('#nav [data-go="recite"]');
    await page.waitForSelector('#recite-main:not([hidden])');
    assert.equal((await page.textContent('#recite-text')).trim(), BASMALA_TEXT);
    assert.ok(await page.isEnabled('#recite-rec'));
    const before = fake.callsTo('/api/recite/check').length;
    await record(page, '#recite-rec', 600);
    const call = await waitForCall(fake, '/api/recite/check', before + 1);
    assert.equal(call.form.expected_text.text, BASMALA_TEXT);
    await page.waitForSelector('#recite-result:not([hidden])');
  });

  await check('dictation: confirming the text again asks again (still refused: still disabled); a changed text can be dictated (W3)', async () => {
    // Confirmed again while the server is unreachable: the old refusal no longer counts.
    await page.click('#nav [data-go="prepare"]');
    await confirmOffline();
    await startRefused();
    // Confirmed again with the server answering: refused at "Confirm text", so the
    // button is disabled before anyone presses it.
    await page.click('#nav [data-go="prepare"]');
    const before = phraseCalls();
    await pressConfirm(page);
    await waitForCall(fake, '/api/dictation/phrases', before + 1);
    assert.equal((await page.textContent('#prep-confirm-status')).trim(), NO_DICTATION_NOTE);
    await page.click('#prep-next [data-go="dictation"]');
    assert.ok(await page.isDisabled('#btn-dict-start'));
    assert.equal((await page.textContent(DICT_START_WHY)).trim(), EN_PHRASE_MSG);
    // The parent takes the basmala line out: the changed text must be confirmed first...
    await page.click('#nav [data-go="prepare"]');
    await page.fill('#page-text', AR_TEXT);
    await page.click('#nav [data-go="dictation"]');
    await page.waitForSelector('#dict-empty:not([hidden])');
    // ... and then it can be dictated.
    await page.click('#nav [data-go="prepare"]');
    await pressConfirm(page);
    await page.waitForSelector('#prep-next:not([hidden])');
    await page.click('#prep-next [data-go="dictation"]');
    assert.ok(await page.isEnabled('#btn-dict-start'));
    assert.ok(await page.isHidden(DICT_START_WHY));
    await page.click('#btn-dict-start');
    await page.waitForSelector('[data-stage="speak"]:not([hidden])');
  });

  await check('dictation: a basmala on a line of its own, without a full stop, rules out dictation at "Confirm text": a text with line breaks is also checked line by line (R1)', async () => {
    await page.click('#nav [data-go="prepare"]');
    await page.waitForSelector('#screen-prepare:not([hidden])');
    // An ordinary text on two lines: asked about as typed, then with each line as a
    // paragraph; it is confirmed for dictation as before.
    const lines = 'ذهب الولد إلى المدرسة\nمع أخيه صباحا.';
    let before = phraseCalls();
    await page.fill('#page-text', lines);
    await pressConfirm(page);
    await page.waitForSelector('#prep-next:not([hidden])');
    assert.equal(phraseCalls(), before + 2);
    assert.deepEqual(fake.callsTo('/api/dictation/phrases').slice(before).map((c) => c.json.text), [lines, 'ذهب الولد إلى المدرسة\n\nمع أخيه صباحا.']);
    assert.notEqual((await page.textContent('#prep-confirm-status')).trim(), NO_DICTATION_NOTE);
    // A text without line breaks is asked about once.
    before = phraseCalls();
    await page.fill('#page-text', AR_TEXT);
    await pressConfirm(page);
    assert.equal(phraseCalls(), before + 1);
    // The basmala on a line of its own: the text as typed is accepted, line by line it
    // is refused, so dictation is ruled out before anyone presses "Start the dictation".
    before = phraseCalls();
    await page.fill('#page-text', BASMALA_LINE_TEXT);
    await pressConfirm(page);
    await page.waitForSelector('#prep-next:not([hidden])');
    assert.equal(phraseCalls(), before + 2);
    assert.equal(fake.callsTo('/api/dictation/phrases')[before].json.text, BASMALA_LINE_TEXT);
    assert.equal((await page.textContent('#prep-confirm-status')).trim(), NO_DICTATION_NOTE);
    await page.click('#prep-next [data-go="dictation"]');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    assert.ok(await page.isDisabled('#btn-dict-start'));
    assert.equal((await page.textContent(DICT_START_WHY)).trim(), EN_PHRASE_MSG);
    assert.equal(fake.callsTo('/api/tts').filter((c) => c.json.text.includes('بسم')).length, 0, 'the voice never got the basmala');
    // Reciting the same text stays available.
    await page.click('#nav [data-go="recite"]');
    await page.waitForSelector('#recite-main:not([hidden])');
    assert.ok(await page.isEnabled('#recite-rec'));
  });

  await check('whole-ayah phrase flow: no console errors (besides the refusals and the unreachable server asked for), page errors or external requests', async () => {
    assert.deepEqual(expected4xx(problems).filter((p) => !/Failed to load resource: net::ERR_CONNECTION_REFUSED/.test(p)), []);
  });
  await context.close();
}

/** The `key: 'text'` entries of one language block of STRINGS in app.js. */
function uiStrings(lang) {
  const source = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const start = source.indexOf('\n    ' + lang + ': {\n');
  assert.ok(start > 0, 'no ' + lang + ' block');
  const end = source.indexOf('\n    },', start);
  const out = {};
  for (const m of source.slice(start, end).matchAll(/^ {6}(\w+): (['"])(.*)\2,$/gm)) out[m[1]] = m[3].replace(/\\(['"])/g, '$1');
  return out;
}

/**
 * Parents are most often mothers, and children are girls and boys: the Arabic UI uses
 * يُرجى + a verbal noun for the parent, "هيا + we" for the child and verbal nouns on
 * buttons, never a singular imperative or a visibly gendered "you". A quoted button label
 * is the label itself (in every language).
 */
function arabicWording() {
  const ar = uiStrings('ar');
  assert.ok(Object.keys(ar).length > 150, 'the Arabic block was read');
  // Harakat are dropped (the shadda stays), so أعِد and أعد are the same token.
  const norm = (w) => w.replace(/[ً-ِْ]/g, '');
  const BANNED = new Set([
    // singular masculine imperatives
    'اضغط', 'اضغطه', 'اكتب', 'الصقه', 'ابدأ', 'انتظر', 'اذهب', 'انتقل', 'حاول', 'أعد', 'راجع', 'صوّر',
    'استمع', 'جرّب', 'استخدم', 'اقرأ', 'أحضر', 'دعني', 'اقترب', 'ارفع', 'أخف', 'اتل', 'ابحث', 'صحّح',
    'أكّد', 'اطلب', 'أظهر', 'التقط', 'اختر', 'انظر',
    // singular feminine imperatives
    'اضغطي', 'اكتبي', 'ابدئي', 'انتظري', 'حاولي', 'أعيدي', 'استمعي', 'اقرئي',
    // a gendered "you" (masculine and feminine present forms)
    // (not تكتب: undiacritized it is also the passive "is written")
    'تريد', 'تريدين', 'تعرف', 'تعرفين', 'تكتبين', 'تنتهي', 'تنتهين', 'لتبدأ', 'لتبدئي', 'لتسمعه', 'لتسمعيه',
    'أنتَ', 'أنتِ',
  ].map(norm));
  const bad = [];
  const texts = Object.entries(ar);
  // Static Arabic text in index.html (the page is translated from app.js, but a fallback
  // written there would be seen before the script runs).
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').replace(/<[^>]*>/g, ' ');
  texts.push(['index.html', html.split(/\s+/).filter((w) => /\p{Script=Arabic}/u.test(w)).join(' ')]);
  for (const [key, text] of texts) {
    for (const raw of text.split(/[\s«»"“”()،؛؟.,:!…—–\[\]{}]+/u)) {
      const w = norm(raw);
      if (!w) continue;
      const bare = /^[وف]/.test(w) && BANNED.has(w.slice(1)) ? w.slice(1) : w;
      if (BANNED.has(bare)) bad.push(`${key}: ${raw}`);
    }
  }
  assert.deepEqual(bad, []);
  // «label» quotes name a label that exists.
  const QUOTES = { ar: /«\s*([^»]+?)\s*»/g, fr: /«\s*([^»]+?)\s*»/g, en: /“([^”]+)”/g };
  for (const [lang, re] of Object.entries(QUOTES)) {
    const table = lang === 'ar' ? ar : uiStrings(lang);
    const labels = new Set(Object.values(table));
    const missing = [];
    for (const [key, text] of Object.entries(table)) {
      for (const m of text.matchAll(re)) if (!labels.has(m[1])) missing.push(`${lang}.${key}: ${m[1]}`);
    }
    assert.deepEqual(missing, [], 'quoted labels that are not a label');
  }
}

async function consentFlow(browser, base) {
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 });
  await check('consent: the Claude notice names every kind of data sent to it (PRV-2)', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('#consent-extra:not([hidden])');
    const en = await page.textContent('#consent-extra');
    assert.match(en, /photos of pages and of handwriting/);
    assert.match(en, /the page text and a transcript of what your child says/);
    assert.match(en, /the words your child got wrong/);
    await page.selectOption('#ui-lang', 'fr');
    assert.match(await page.textContent('#consent-extra'), /une transcription de ce que dit votre enfant/);
    await page.selectOption('#ui-lang', 'en');
  });

  await check('consent: with Claude configured, a typed dictation check waits for consent (PRV-1)', async () => {
    await startSession(page, { consent: false, nickname: '' });
    await page.fill('#page-text', PAGE_TEXT);
    await pressConfirm(page);
    await page.click('#prep-next [data-go="dictation"]');
    await page.click('#btn-dict-start');
    await page.click('#dict-next');
    await page.click('#dict-next');
    await page.waitForSelector('[data-stage="check"]:not([hidden])');
    await page.fill('#dict-written', 'The cat sat on the matt');
    assert.ok(await page.isDisabled('#btn-dict-check'));
    assert.match(await page.textContent('[data-stage="check"] [data-why="dict-check"]'), /consent box/);
    assert.ok(await page.isVisible('[data-stage="check"] [data-why="dict-check"]'));
    assert.equal(fake.callsTo('/api/dictation/check').length, 0, 'nothing went to the server');
    await page.click('#btn-profile');
    await page.check('#consent');
    await page.click('#btn-start');
    await page.click('#nav [data-go="dictation"]');
    assert.ok(await page.isEnabled('#btn-dict-check'));
    await page.click('#btn-dict-check');
    await waitForCall(fake, '/api/dictation/check', 1);
    assert.deepEqual(problems, []);
  });
  await context.close();

  const offline = await newPage(browser, base, { width: 360, height: 780 }, { health: { asr: true, tts: true, brain: 'offline', quran: true, languages: ['ar', 'en', 'fr'] } });
  await check('consent: offline, a typed dictation check needs no consent (nothing leaves the computer)', async () => {
    const p = offline.page;
    await p.goto(base + '/');
    await p.waitForSelector('#consent-extra:not([hidden])');
    await startSession(p, { consent: false, nickname: '' });
    await p.fill('#page-text', PAGE_TEXT);
    await pressConfirm(p);
    await p.click('#prep-next [data-go="dictation"]');
    await p.click('#btn-dict-start');
    await p.click('#dict-next');
    await p.click('#dict-next');
    await p.waitForSelector('[data-stage="check"]:not([hidden])');
    assert.ok(await p.isEnabled('#btn-dict-check'));
    assert.deepEqual(offline.problems, []);
  });
  await offline.context.close();
}

/** recorder.js with a 1 s limit instead of 120 s, so the limit can be reached in a test. */
function shortLimit() {
  let api;
  Object.defineProperty(window, 'MommyRecorder', {
    configurable: true,
    get: () => api,
    set: (v) => {
      api = Object.assign({}, v, { MAX_SECONDS: 1 });
    },
  });
}

async function limitFlow(browser, base) {
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 }, null, { initScript: shortLimit });
  await check('recite and Quran: when the length limit stops a recording, the result says so (UX-10)', async () => {
    await page.goto(base + '/');
    await startSession(page, { consent: true, nickname: '' });
    await confirmPageText(page, PAGE_TEXT);
    await page.click('#prep-next [data-go="recite"]');
    await page.click('#recite-rec'); // and never pressed again: the limit stops it
    await waitForCall(fake, '/api/recite/check', 1);
    await page.waitForSelector('#recite-result:not([hidden])');
    assert.ok(await page.isVisible('#recite-limit'));
    assert.equal((await page.textContent('#recite-limit')).trim(), "That's the longest I can listen to (2 minutes).");
    await record(page, '#recite-rec', 300); // stopped by the child: no note
    await waitForCall(fake, '/api/recite/check', 2);
    await page.waitForSelector('#recite-limit', { state: 'hidden' });
    await page.click('#nav [data-go="quran"]');
    await page.waitForSelector('#quran-text .ayah[data-ayah="10"]');
    await page.click('#quran-rec');
    await waitForCall(fake, '/api/quran/check', 1);
    await page.waitForSelector('#quran-result:not([hidden])');
    assert.ok(await page.isVisible('#quran-limit'));
    assert.deepEqual(problems, []);
  });
  await context.close();
}

async function main() {
  console.log('# syntax');
  await check('node --check web/*.js', checkSyntax);
  console.log('# recorder helpers (Node)');
  await recorderUnitTests();
  console.log('# Arabic UI wording (Node)');
  await check('ar: UI strings use no singular imperative or visibly gendered second-person form', arabicWording);

  TANZIL.uthmani = readTanzil('quran-uthmani.txt');
  TANZIL.clean = readTanzil('quran-simple-clean.txt');
  TANZIL.surahs = readSurahs();
  assert.equal(TANZIL.surahs.length, 114);
  assert.equal(TANZIL.uthmani.size, 6236);

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    console.log('# browser: 360 px main flow');
    await mainFlow(browser, base);
    console.log('# browser: desktop');
    await desktopShots(browser, base);
    console.log('# browser: record button labels');
    await recordLabelsFit(browser, base);
    console.log('# browser: dark mode');
    await darkMode(browser, base);
    console.log('# browser: unavailable features');
    await unavailableFeatures(browser, base);
    console.log('# browser: server down');
    await serverDown(browser, base);
    console.log('# browser: Arabic UI (review fixes)');
    await arabicFlow(browser, base);
    console.log('# browser: review fixes');
    await fixesFlow(browser, base);
    console.log('# browser: dictation of a text with a whole-ayah phrase');
    await dictationPhraseFlow(browser, base);
    console.log('# browser: consent and Claude');
    await consentFlow(browser, base);
    console.log('# browser: length limit');
    await limitFlow(browser, base);
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (SHOTS) console.log('screenshots: ' + SHOTS);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

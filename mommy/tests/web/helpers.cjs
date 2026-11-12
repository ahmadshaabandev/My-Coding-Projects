/*
 * Shared helpers of the browser tests (smoke.cjs, family.cjs): a tiny test harness, a
 * static server for web/, binary helpers (multipart, WAV, JPEG), the verbatim Tanzil
 * data for the fake Quran endpoints (data/quran/, read only), a contract-shaped fake
 * API (docs/CONTRACT.md, "HTTP API"; /api/text/check included) with a fake finder of
 * the Quran parts of a school text (hard rule 4, Q1 and Q2), page helpers, and the
 * family helpers (setup, picking a child, the PIN, the parent area).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

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

/** Print the summary and exit with 1 when a check failed. */
function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (SHOTS) console.log('screenshots: ' + SHOTS);
  process.exit(failed.length ? 1 : 0);
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

function loadTanzil() {
  if (TANZIL.uthmani) return;
  TANZIL.uthmani = readTanzil('quran-uthmani.txt');
  TANZIL.clean = readTanzil('quran-simple-clean.txt');
  TANZIL.surahs = readSurahs();
  assert.equal(TANZIL.surahs.length, 114);
  assert.equal(TANZIL.uthmani.size, 6236);
}

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

/** A strict recitation of `text` (whitespace words) with the words at `wrong` heard differently. */
function strictResult(text, wrong, feedback) {
  const words = text.split(/\s+/).filter(Boolean);
  const bad = new Set(wrong || []);
  const ops = words.map((w, i) => (bad.has(i)
    ? { kind: 'sub', exp_index: i, heard_index: i, expected: w, heard: 'misheardword' }
    : { kind: 'match', exp_index: i, heard_index: i, expected: w, heard: w }));
  const nErr = bad.size;
  return {
    mode: 'strict',
    heard_text: ops.map((o) => o.heard).join(' '),
    result: {
      ops,
      n_expected: words.length,
      n_errors: nErr,
      first_error_exp_index: nErr ? Math.min(...bad) : null,
      verdict: nErr ? 'mistakes' : 'correct',
      say_again: false,
      word_accuracy: (words.length - nErr) / words.length,
    },
    feedback: feedback || (nErr ? 'Almost! Listen again.' : 'Wonderful! Every word was right.'),
    quality: { seconds: 2, rms: 0.08, too_quiet: false, too_short: false },
  };
}

/**
 * Fake Quran check of the range: by default one substitution, one skipped word and one
 * added word; `perfect` gives every word right. The extra fields of the real response
 * (n_expected, n_errors, word_accuracy, words) are there, as rewards.js needs them.
 */
function fakeQuranCheck(surah, from, to, perfect) {
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
    if (!perfect && g === 6) ops.push({ kind: 'ins', exp_index: null, heard_index: heardIndex++, expected: null, heard: 'و', surah: null, ayah: null, word_index: null, word_index_display: null, expected_display: null });
    if (!perfect && g === 1) ops.push(Object.assign({ kind: 'sub', heard_index: heardIndex++, heard: 'هم' }, base));
    else if (!perfect && g === 5) ops.push(Object.assign({ kind: 'del', heard_index: null, heard: null }, base));
    else ops.push(Object.assign({ kind: 'match', heard_index: heardIndex++, heard: w.clean }, base));
  });
  const nErrors = perfect ? 0 : 3;
  const matched = ops.filter((o) => o.kind === 'match').length;
  const first = words[1];
  return {
    heard_text: ops.filter((o) => o.heard).map((o) => o.heard).join(' '),
    ops,
    verdict: perfect ? 'correct' : 'mistakes',
    say_again: false,
    first_error: perfect ? null : { surah, ayah: first.ayah, word_index_display: first.dj, expected_display_word: first.display, kind: 'sub' },
    feedback: perfect ? 'أحسنت، بارك الله في هذه التلاوة.' : 'تنبيه: «' + first.display + '»', // as feedback.quran_feedback words it
    n_expected: words.length,
    n_errors: nErrors,
    word_accuracy: matched / words.length,
  };
}

/** A Quran text (112:1-4, Simple-Clean words) that the general endpoints refuse (Q1). */
const QURAN_SAMPLE = 'قل هو الله أحد الله الصمد لم يلد ولم يولد ولم يكن له كفوا أحد';
/** The server's English refusal messages: they must never reach a child-facing status. */
const QURAN_MESSAGE = 'This text is from the Quran. Please use the Quran section: it checks recitation against the verbatim Tanzil text, without AI and without a synthetic voice.';
const QURAN_MEANING_MESSAGE = 'This text has words of the Quran, which are recited word by word only: their meaning is never judged by an AI model. Please choose word by word.';
/** A school text that starts with the basmala as a sentence of its own (Q2): one Quran
 * part, read by a grown-up in a dictation; recited word by word only. */
const BASMALA_TEXT = 'بسم الله الرحمن الرحيم. ذهب الولد إلى المدرسة مع أخيه.';
/** The same with the basmala on a line of its own, without a full stop (Q2 too). */
const BASMALA_LINE = 'بسم الله الرحمن الرحيم';
const BASMALA_LINE_TEXT = BASMALA_LINE + '\nذهب الولد إلى المدرسة مع أخيه.';

/** The words of a text, roughly as textnorm.tokenize counts them. */
function fakeWords(text) {
  return text.split(/[\s.,;:!?،؛؟«»"()]+/u).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

// ---------------------------------------------------------------------------
// Fake finder of the Quran parts of a school text (docs/CONTRACT.md, "Quran part").
// It knows a few references (FAKE_QURAN_REFS) and finds them, from the verbatim Tanzil
// words, as the server's guard.find_quran_parts would: verbatim, or with one letter
// changed or one word dropped (a "near" match, with its difference). Its answers have
// the server's shape; smoke.cjs compares them with the real finder on the fixtures
// (quranFixtures) when the backend's Python is there.
// ---------------------------------------------------------------------------

/** The references the fake finds, the longest first. */
const FAKE_QURAN_REFS = [
  { surah: 112, from: 1, to: 4 },
  { surah: 2, from: 153, to: 153 },
  { surah: 1, from: 1, to: 1 },
];
const CHUNK_MAX_WORDS = 6;
const TASHKEEL = /[ً-ٰٟۖ-ۭـ]/gu;
/** Diacritics, Quranic marks and tatweel left out (a word as the comparisons see it). */
const bareWord = (w) => String(w).normalize('NFC').replace(TASHKEEL, '');
/** The letters that tell two spellings of one word apart (alef, hamza and ta marbuta forms left out). */
const skeleton = (w) => bareWord(w).replace(/[اأإآٱىءئؤ]/gu, '').replace(/ة/gu, 'ه');
/** Framing formulas: left out when deciding whether a text is Quran (Q1). */
const FRAMING = [['قال', 'تعالى'], ['صدق', 'الله', 'العظيم'], ['أعوذ', 'بالله', 'من', 'الشيطان', 'الرجيم']];

/**
 * The tokens of a text with their UTF-16 spans, roughly as textnorm.token_spans cuts
 * them: a [?] mark (a word a page reader could not read) is no token.
 */
function tokenSpans(text) {
  const out = [];
  for (const m of text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    if (!/[\p{L}\p{N}]/u.test(m[0])) continue; // a pause mark alone
    out.push({ s: m.index, e: m.index + m[0].length, tok: m[0], key: bareWord(m[0]) });
  }
  return out;
}

/** Display words first..last of an ayah, cut verbatim from its line (as Quran.display_slice). */
function displaySlice(ay, first, last) {
  const spans = [...ay.display.matchAll(/\S+/gu)].filter((m) => !isPauseMark(m[0])).map((m) => [m.index, m.index + m[0].length]);
  return ay.display.slice(spans[first][0], spans[last][1]);
}

/**
 * The mushaf words of a reference: per ayah, the groups of display words that spell its
 * Simple-Clean words (يا أيها is one display word), and the grown-up's reading chunks
 * (at most 6 display words, near-equal, never across an ayah).
 */
const refCache = new Map();
function refData(ref) {
  const id = `${ref.surah}:${ref.from}-${ref.to}`;
  if (refCache.has(id)) return refCache.get(id);
  const out = { ref, clean: [], cleanDisplay: [], uthmani: [], chunks: [], wordTo: 0 };
  for (let a = ref.from; a <= ref.to; a++) {
    const ay = ayah(ref.surah, a);
    const groups = [];
    let c = 0;
    ay.display_words.forEach((d, i) => {
      const two = c + 1 < ay.match_words.length && ay.display_words.length - i < ay.match_words.length - c && skeleton(d) === skeleton(ay.match_words[c] + ay.match_words[c + 1]);
      const words = ay.match_words.slice(c, c + (two ? 2 : 1));
      groups.push({ d0: i, d1: i, words });
      c += words.length;
    });
    for (const g of groups) {
      for (const w of g.words) {
        out.clean.push(w);
        out.cleanDisplay.push(ay.display_words.slice(g.d0, g.d1 + 1).join(' '));
      }
    }
    out.uthmani.push(...ay.display_words);
    const sizes = groups.map((g) => g.d1 - g.d0 + 1);
    const sum = (a0, b0) => sizes.slice(a0, b0).reduce((x, y) => x + y, 0);
    let pieces = Math.max(1, Math.ceil(sum(0, groups.length) / CHUNK_MAX_WORDS));
    let bounds;
    for (;;) {
      const base = Math.floor(groups.length / pieces);
      const extra = groups.length % pieces;
      bounds = [];
      let pos = 0;
      for (let k = 0; k < pieces; k++) {
        const size = k < extra ? base + 1 : base;
        bounds.push([pos, pos + size]);
        pos += size;
      }
      if (bounds.every(([x, y]) => sum(x, y) <= CHUNK_MAX_WORDS) || pieces >= groups.length) break;
      pieces++;
    }
    for (const [x, y] of bounds) {
      if (x === y) continue;
      out.chunks.push({
        uthmani: displaySlice(ay, groups[x].d0, groups[y - 1].d1),
        clean: groups.slice(x, y).flatMap((g) => g.words).join(' '),
      });
    }
    out.wordTo = ay.match_words.length;
  }
  refCache.set(id, out);
  return out;
}

/** Two words one letter apart (one letter changed). */
function oneLetterApart(a, b) {
  const x = [...a];
  const y = [...b];
  if (x.length !== y.length) return false;
  return x.filter((ch, i) => ch !== y[i]).length === 1;
}

/** Every part the fakes have answered with: no /api/tts request may contain one. */
const QURAN_PARTS_SEEN = [];
const FAKES = [];

/**
 * The fake analysis of a text (as guard.find_quran_parts): {parts (the API's JSON),
 * refused (Q1), range, mushafText, plan(phrases)}. `opts.unmarked`: the server's safety
 * net fires (a phrase the voice would refuse, outside every part): voiceSafe false.
 */
function fakeQuranAnalysis(rawText, lang, opts) {
  const text = typeof rawText === 'string' ? rawText : '';
  const lead = text.length - text.trimStart().length;
  const spans = tokenSpans(text);
  const found = [];
  if (TANZIL.uthmani && /\p{Script=Arabic}/u.test(text)) {
    const used = new Array(spans.length).fill(false);
    const free = (i, n) => i + n <= spans.length && !used.slice(i, i + n).some(Boolean);
    for (const ref of FAKE_QURAN_REFS) {
      const R = refData(ref);
      const n = R.clean.length;
      const keys = R.clean.map(bareWord);
      for (let i = 0; i < spans.length; i++) {
        let hit = null;
        // Verbatim, or one letter changed (an OCR-like misreading) in an ayah of 5+ words.
        if (free(i, n)) {
          const diff = [];
          for (let k = 0; k < n && diff.length < 2; k++) if (spans[i + k].key !== keys[k]) diff.push(k);
          if (!diff.length) hit = { start: i, end: i + n, differences: [] };
          else if (diff.length === 1 && n >= 5 && oneLetterApart(spans[i + diff[0]].key, keys[diff[0]])) {
            const k = diff[0];
            hit = { start: i, end: i + n, differences: [{ op: 'sub', typed: spans[i + k].tok, mushaf: R.cleanDisplay[k], mushaf_clean: R.clean[k], index: k, token: i + k }] };
          }
        }
        // One word dropped inside an ayah of 5+ words.
        if (!hit && n >= 5 && free(i, n - 1)) {
          for (let k = 1; k < n - 1 && !hit; k++) {
            const rest = keys.filter((_, j) => j !== k);
            if (rest.every((w, j) => spans[i + j].key === w)) {
              hit = { start: i, end: i + n - 1, differences: [{ op: 'del', typed: null, mushaf: R.cleanDisplay[k], mushaf_clean: R.clean[k], index: k, token: null }] };
            }
          }
        }
        if (!hit) continue;
        for (let j = hit.start; j < hit.end; j++) used[j] = true;
        found.push(Object.assign(hit, { R }));
        i = hit.end - 1;
      }
    }
  }
  found.sort((a, b) => a.start - b.start);
  // The rule the server would name: a near match, a run of 5+, a text, line or sentence
  // that is exactly the ayah, or a short ayah inside a sentence.
  const bounded = (p) => {
    const before = text.slice(0, spans[p.start].s);
    const after = text.slice(spans[p.end - 1].e);
    return /(^|[\n.!?؟:؛])\s*$/u.test(before) && /^\s*([\n.!?؟:؛]|$)/u.test(after);
  };
  let expShift = 0;
  const parts = found.map((p) => {
    const R = p.R;
    const s0 = spans[p.start].s;
    const e1 = spans[p.end - 1].e;
    // A changed word is replaced; a dropped word takes the place of a [?] mark in its gap
    // (a word the page reader could not read), or is put back before the next word.
    const edits = p.differences.map((d) => {
      if (d.op === 'sub') return [spans[d.token].s, spans[d.token].e, d.mushaf_clean];
      const next = spans[p.start + d.index].s;
      const gap = text.slice(spans[p.start + d.index - 1].e, next);
      const mark = gap.indexOf('[?]');
      if (mark >= 0) {
        const at = spans[p.start + d.index - 1].e + mark;
        return [at, at + 3, d.mushaf_clean];
      }
      return [next, next, d.mushaf_clean + ' '];
    });
    const applied = (from, to) => {
      let out = text.slice(from, to);
      for (const [a, b, w] of [...edits].sort((x, y) => y[0] - x[0])) out = out.slice(0, a - from) + w + out.slice(b - from);
      return out;
    };
    const expStart = p.start + expShift;
    expShift += R.clean.length - (p.end - p.start);
    return {
      start: p.start,
      end: p.end,
      chars: [[...text.slice(0, s0)].length, [...text.slice(0, e1)].length],
      utf16: [s0, e1],
      surah: R.ref.surah,
      ayah_from: R.ref.from,
      ayah_to: R.ref.to,
      word_from: 0,
      word_to: R.wordTo,
      whole: true,
      rule: p.differences.length ? 'near' : R.clean.length >= 5 ? 'run' : bounded(p) ? 'ayah' : 'contained',
      uthmani: R.uthmani.slice(),
      clean: R.clean.slice(),
      clean_display: R.cleanDisplay.slice(),
      differences: p.differences,
      replacement: applied(s0, e1),
      chunks: R.chunks.map((c) => c.uthmani),
      exp_start: expStart,
      exp_end: expStart + R.clean.length,
      _edits: edits,
      _R: R,
    };
  });
  // Q1: with the framing formulas and digits left out, every word is inside a part.
  const framing = new Set();
  for (const f of FRAMING) {
    for (let i = 0; i + f.length <= spans.length; i++) {
      if (f.every((w, k) => spans[i + k].key === bareWord(w))) for (let k = 0; k < f.length; k++) framing.add(i + k);
    }
  }
  const inPart = (i) => parts.some((p) => i >= p.start && i < p.end);
  const refused = parts.length > 0 && spans.every((t, i) => inPart(i) || framing.has(i) || /^[\p{N}]+$/u.test(t.tok));
  let range = null;
  if (refused) {
    const refs = parts.filter((p) => !(p.surah === 1 && p.ayah_from === 1 && p.ayah_to === 1));
    const use = refs.length ? refs : parts;
    if (use.every((p) => p.surah === use[0].surah) && use.every((p, k) => k === 0 || p.ayah_from === use[k - 1].ayah_to + 1)) {
      range = { surah: use[0].surah, from: use[0].ayah_from, to: use[use.length - 1].ayah_to };
    }
  }
  let mushafText = text;
  for (const [a, b, w] of parts.flatMap((p) => p._edits).sort((x, y) => y[0] - x[0])) mushafText = mushafText.slice(0, a) + w + mushafText.slice(b);
  const json = parts.map((p) => {
    const out = Object.assign({}, p);
    delete out._edits;
    delete out._R;
    return out;
  });
  for (const p of json) QURAN_PARTS_SEEN.push({ text: text.slice(p.utf16[0], p.utf16[1]), clean: p.clean.join(' '), chunks: p.chunks, cleanChunks: parts[json.indexOf(p)]._R.chunks.map((c) => c.clean) });
  /** The dictation plan: the voice's phrases between the parts, a grown-up's chunks for each part. */
  function plan(voiceDefault) {
    if (!parts.length) {
      const phrases = voiceDefault;
      return { phrases, readers: phrases.map(() => 'voice'), read_text: phrases.map(() => null), parts: phrases.map(() => null), quran_parts: [] };
    }
    const out = { phrases: [], readers: [], read_text: [], parts: [], quran_parts: json };
    const voice = (s) => {
      for (const piece of s.split(/(?<=[.!?؟:؛])\s+|\n+/u)) {
        const ph = piece.trim();
        if (!/[\p{L}\p{N}]/u.test(ph)) continue;
        out.phrases.push(ph);
        out.readers.push('voice');
        out.read_text.push(null);
        out.parts.push(null);
      }
    };
    let pos = 0;
    parts.forEach((p, index) => {
      voice(text.slice(pos, p.utf16[0]));
      for (const c of p._R.chunks) {
        out.phrases.push(c.clean);
        out.readers.push('grown_up');
        out.read_text.push(c.uthmani);
        out.parts.push(index);
      }
      pos = p.utf16[1];
    });
    voice(text.slice(pos));
    return out;
  }
  // The expected words of a check (as guard.QuranAnalysis.expected): the typed words
  // outside the parts, the Simple-Clean mushaf words inside them.
  const expected = [];
  let ti = 0;
  for (const p of parts) {
    while (ti < p.start) expected.push(spans[ti++].tok);
    expected.push(...p.clean);
    ti = p.end;
  }
  while (ti < spans.length) expected.push(spans[ti++].tok);
  return { parts: json, refused, range, mushafText, voiceSafe: !(opts && opts.unmarked), plan, lead, expected };
}

/**
 * A word-by-word result for a text with Quran parts: the expected words are the server's
 * (the mushaf words inside a part); the words at `wrong` (indexes into them) are heard
 * or written differently. `quran`: the feedback is the fixed Quran-part template
 * (feedback_is_quran), shown and never spoken. `kind` 'recite' (a /api/recite/check
 * strict answer, the default) or 'dictation' (a /api/dictation/check answer, typed).
 */
function quranStrictResult(text, wrong, feedback, quran, kind) {
  const an = fakeQuranAnalysis(text, 'ar');
  const r = strictResult(an.expected.join(' '), wrong, feedback);
  const extra = { feedback_is_quran: !!quran, quran_parts: an.parts };
  if (kind !== 'dictation') return Object.assign(r, extra);
  const written = r.result.ops.map((op) => op.heard).join(' ');
  return Object.assign({ read_text: written, source: 'typed', uncertain_words: [], legible: true, result: r.result, feedback: r.feedback, needs_parent_confirmation: true }, extra);
}

/** True when `text` holds a Quran part any fake has answered with (verbatim or as a chunk). */
function holdsQuranPart(rawText) {
  const norm = (s) => bareWord(s).replace(/\s+/gu, ' ').trim();
  const t = norm(rawText);
  if (!t) return false;
  return QURAN_PARTS_SEEN.some((p) => [p.text, p.clean, ...p.chunks, ...p.cleanChunks].some((q) => q && t.includes(norm(q))));
}

/** The /api/tts requests, over every fake of this process, that hold a Quran part. */
function ttsQuranLeaks() {
  const out = [];
  for (const fake of FAKES) for (const c of fake.callsTo('/api/tts')) if (c.json && holdsQuranPart(c.json.text)) out.push(c.json.text);
  return out;
}

/**
 * The texts the Quran-part checks use, built from the verbatim Tanzil words (call
 * loadTanzil() first): a lesson quoting 2:153 after قال تعالى (two grown-up chunks in
 * the middle), the same with one letter changed (ص typed ض: a "sub" difference), with a
 * word dropped (a "del" difference) and with a word a page reader marked [?] (a "del"
 * that takes the place of the mark), the basmala as a sentence and on a line of
 * its own (a grown-up step at the start), 112:1-4 framed (a text that is Quran, Q1), and
 * an ordinary sentence.
 */
function quranFixtures() {
  const words = (s, a) => ayah(s, a).match_words;
  const w153 = words(2, 153);
  const lesson = (ws) => 'الصبر مفتاح الفرج. قال تعالى: ' + ws.join(' ') + ' ثم شرح المعلم الآية.';
  const misread = w153.slice();
  misread[6] = misread[6].replace('ص', 'ض');
  const ikhlas = [1, 2, 3, 4].map((a) => words(112, a).join(' ')).join(' ');
  return {
    LESSON: lesson(w153),
    LESSON_MISREAD: lesson(misread),
    LESSON_DROPPED: lesson(w153.filter((_, i) => i !== 3)),
    LESSON_UNREAD: lesson(w153.map((w, i) => (i === 3 ? '[?]' : w))),
    MISREAD_TYPED: misread[6],
    BASMALA_TEXT,
    BASMALA_LINE_TEXT,
    Q1_FRAMED: 'قال تعالى: ' + ikhlas + ' صدق الله العظيم',
    Q1_SAMPLE: QURAN_SAMPLE,
    ORDINARY: 'ذهب الولد إلى المدرسة مع أخيه.',
  };
}

/**
 * The checks of /api/text/check and the other text endpoints, in their order: [status,
 * body] of a refusal, or null. mode: 'strict', 'contextual' or 'dictation'. A text that
 * is Quran (Q1) is refused in every mode (with quran_range when its ayat are one range);
 * mode contextual also refuses a text with Quran parts (Q2); mode dictation refuses only
 * the safety net (`an.voiceSafe` false).
 */
function textRefusal(rawText, lang, mode, an) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!['ar', 'en', 'fr'].includes(lang)) return [422, { error: 'validation_error', message: 'lang' }];
  if (!text.isWellFormed()) return [400, { error: 'bad_text', message: 'The text contains characters that are not valid text.' }];
  if (text.length > 20000) return [400, { error: 'text_too_long', message: 'The text is longer than 20000 characters.' }];
  const words = fakeWords(text);
  if (!words.length) return [400, { error: 'empty_text', message: 'The text has no words.' }];
  if (words.length > 3000) return [400, { error: 'text_too_long', message: 'The text is longer than 3000 words.' }];
  if (text.includes('[?]')) return [400, { error: 'unreadable_text', message: 'The text has [?] where a word could not be read. Please type the missing words first.' }];
  const q = an || fakeQuranAnalysis(text, lang);
  if (q.refused) return [422, Object.assign({ error: 'quran_text', message: QURAN_MESSAGE }, q.range ? { quran_range: q.range } : {})];
  if (mode === 'contextual' && q.parts.length) return [422, { error: 'quran_text', message: QURAN_MEANING_MESSAGE }];
  if (mode === 'dictation' && !q.voiceSafe) return [422, { error: 'quran_text', message: QURAN_MESSAGE }];
  const arabic = (text.match(/\p{Script=Arabic}/gu) || []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
  if ((arabic > latin && lang !== 'ar') || (lang === 'ar' && arabic === 0)) return [422, { error: 'lang_mismatch', message: 'The text is not in the language chosen.' }];
  return null;
}

function makeFakeApi(opts) {
  const o = Object.assign({ health: { asr: true, tts: true, brain: 'claude', quran: true, languages: ['ar', 'en', 'fr'] }, phrases: ['The cat sat', 'on the mat.'] }, opts || {});
  const calls = [];
  const reciteQueue = [];
  const dictationQueue = [];
  const quranQueue = [];
  const refused = new Set(); // endpoints that answer 422 quran_text whatever the text
  const unreachable = new Set(); // endpoints whose requests fail as if the server were down
  let tts = { delay: () => 0, check: (j) => (j.slow ? 'passed' : 'skipped'), refuse: () => false };
  let pageRead = null;
  let unmarked = () => false; // texts for which the server's dictation safety net fires
  let healthDown = !!o.healthDown;
  const analyse = (text, lang) => fakeQuranAnalysis(text, lang, { unmarked: unmarked(String(text || '').trim()) });

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
      const page = pageRead || { text: PAGE_TEXT, lang: 'en', notes: '', source: 'claude', needs_manual: false, contains_quran: false };
      const text = typeof page.text === 'string' ? page.text : '';
      // The server decides from the text read when it has Arabic: a page that is Quran
      // (Q1) keeps contains_quran; a school page that includes Quran is read as usual.
      let fields = { quran_parts: [], mushaf_text: text, quran_range: null };
      let containsQuran = !!page.contains_quran;
      if (/\p{Script=Arabic}/u.test(text)) {
        const an = analyse(text.trim(), page.lang || 'ar');
        const lead = text.length - text.trimStart().length;
        const parts = an.parts.map((x) => Object.assign({}, x, { chars: x.chars.map((v) => v + lead), utf16: x.utf16.map((v) => v + lead) }));
        fields = { quran_parts: parts, mushaf_text: text.slice(0, lead) + an.mushafText + text.slice(lead + text.trim().length), quran_range: an.range };
        containsQuran = an.refused;
      }
      return json(Object.assign({}, page, fields, { contains_quran: containsQuran }));
    }
    if (p === '/api/text/check' && method === 'POST') {
      const j = call.json || {};
      const mode = j.mode === undefined || j.mode === null ? 'strict' : j.mode;
      if (!['strict', 'contextual', 'dictation'].includes(mode)) return json({ error: 'validation_error', message: 'mode' }, 422);
      if (refused.has(p)) return quranRefusal();
      const text = typeof j.text === 'string' ? j.text.trim() : '';
      const an = analyse(text, j.lang);
      const refusal = textRefusal(j.text, j.lang, mode, an);
      if (refusal) return json(refusal[1], refusal[0]);
      const lead = j.text.length - j.text.trimStart().length;
      return json({
        ok: true,
        words: fakeWords(text).length,
        dictation: an.voiceSafe,
        contextual: mode === 'contextual' || an.parts.length === 0,
        quran_parts: an.parts.map((x) => Object.assign({}, x, { chars: x.chars.map((v) => v + lead), utf16: x.utf16.map((v) => v + lead) })),
        mushaf_text: j.text.slice(0, lead) + an.mushafText + j.text.slice(lead + text.length),
      });
    }
    if (p === '/api/recite/check' && method === 'POST') {
      const expected = call.form.expected_text.text;
      const mode = call.form && call.form.mode ? call.form.mode.text : 'strict';
      const an = analyse(expected.trim(), call.form.lang ? call.form.lang.text : 'en');
      if (refused.has(p)) return quranRefusal();
      if (an.refused) return json(Object.assign({ error: 'quran_text', message: QURAN_MESSAGE }, an.range ? { quran_range: an.range } : {}), 422);
      if (mode === 'contextual' && an.parts.length) return json({ error: 'quran_text', message: QURAN_MEANING_MESSAGE }, 422);
      const next = reciteQueue.length ? reciteQueue.shift() : mode === 'contextual' ? CONTEXTUAL_RESULT : STRICT_RESULT;
      // Strict answers always carry feedback_is_quran and the Quran parts of the text.
      if (next.mode === 'strict') return json(Object.assign({ feedback_is_quran: false, quran_parts: an.parts }, next));
      return json(next);
    }
    if (p === '/api/tts' && method === 'POST') {
      if (!o.health.tts) return json({ error: 'tts_unavailable', message: 'TTS models are missing' }, 503);
      // The voice guard as built: any phrase that holds Quran (a part, a whole ayah) is refused.
      const t = call.json.text;
      if (refused.has(p) || tts.refuse(call.json) || holdsQuranPart(t) || fakeQuranAnalysis(t, call.json.lang).parts.length) return quranRefusal();
      const delay = tts.delay(call.json);
      if (delay) await sleep(delay);
      return route.fulfill({ status: 200, contentType: 'audio/wav', headers: { 'X-Speech-Check': tts.check(call.json) }, body: silentWav(0.2) });
    }
    if (p === '/api/dictation/phrases' && method === 'POST') {
      if (refused.has(p)) return quranRefusal();
      // The rule of /api/text/check in mode "dictation"; the Quran parts are cut apart,
      // in chunks a grown-up reads (readers "grown_up").
      const an = analyse(String(call.json.text || '').trim(), call.json.lang);
      const refusal = textRefusal(call.json.text, call.json.lang, 'dictation', an);
      if (refusal && refusal[1].error !== 'empty_text') return json(refusal[1], refusal[0]);
      if (refusal) return json({ phrases: [], readers: [], read_text: [], parts: [], quran_parts: [] });
      return json(an.plan(o.phrases));
    }
    if (p === '/api/dictation/check' && method === 'POST') {
      const expected = call.form.expected_text.text;
      const an = analyse(expected.trim(), call.form.lang ? call.form.lang.text : 'en');
      if (refused.has(p)) return quranRefusal();
      if (an.refused) return json(Object.assign({ error: 'quran_text', message: QURAN_MESSAGE }, an.range ? { quran_range: an.range } : {}), 422);
      const queued = dictationQueue.length ? dictationQueue.shift() : DICTATION_RESULT;
      const next = typeof queued === 'function' ? queued(call) : queued;
      return json(Object.assign({ feedback_is_quran: false, quran_parts: an.parts }, next));
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
      const perfect = quranQueue.length ? quranQueue.shift() === 'perfect' : false;
      return json(fakeQuranCheck(Number(f.surah.text), Number(f.from.text), Number(f.to.text), perfect));
    }
    if (p === '/api/quran/locate' && method === 'POST') {
      const a2 = ayah(112, 2);
      const a3 = ayah(112, 3);
      return json({ heard_text: 'الله الصمد', candidates: [{ surah: 112, ayah: 2, word_index: 0, match_word_index: 0, score: 1.0, display_preview: a2.display_words.concat(a3.display_words).slice(0, 8).join(' ') }] });
    }
    return json({ error: 'not_found', message: 'no fake for ' + p }, 400);
  }

  const fake = {
    calls,
    handler,
    queueRecite: (r) => reciteQueue.push(r),
    /** The next /api/dictation/check answer: an object, or a function of the request (call) that gives one. */
    queueDictation: (r) => dictationQueue.push(r),
    /** 'perfect' or 'mistakes' for the next /api/quran/check. */
    queueQuran: (kind) => quranQueue.push(kind),
    setHealthDown: (v) => {
      healthDown = v;
    },
    /** Make an endpoint answer 422 quran_text (or stop doing so). */
    refuse: (p, on) => (on ? refused.add(p) : refused.delete(p)),
    /** Make requests to an endpoint fail as a network error (or stop doing so). */
    unreachable: (p, on) => (on ? unreachable.add(p) : unreachable.delete(p)),
    /**
     * {delay(json) -> ms, check(json) -> X-Speech-Check value, refuse(json) -> bool (422
     * quran_text, as the voice guard would for Quran words the server did not mark)};
     * missing parts keep the default.
     */
    setTts: (t) => {
      tts = { delay: (t && t.delay) || (() => 0), check: (t && t.check) || ((j) => (j.slow ? 'passed' : 'skipped')), refuse: (t && t.refuse) || (() => false) };
    },
    setPageRead: (r) => {
      pageRead = r;
    },
    /** fn(text) -> bool: the server's dictation safety net fires for these texts. */
    setUnmarked: (fn) => {
      unmarked = fn || (() => false);
    },
    callsTo: (p) => calls.filter((c) => c.path === p),
    ttsFor: (text) => calls.filter((c) => c.path === '/api/tts' && c.json && c.json.text === text),
  };
  FAKES.push(fake);
  return fake;
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

/**
 * A new context and page with a fake microphone and the fake API. It records console
 * errors, page errors and every request to another host than the page's own.
 * pageOpts: {initScript, colorScheme}.
 */
async function newPage(browser, base, viewport, fakeOpts, pageOpts) {
  const po = pageOpts || {};
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'en-US', colorScheme: po.colorScheme || 'light' });
  await context.grantPermissions(['microphone'], { origin: base });
  const page = await context.newPage();
  await page.addInitScript(mediaHook);
  if (po.initScript) await page.addInitScript(po.initScript, po.initArg);
  page.setDefaultTimeout(10000);
  const fake = makeFakeApi(fakeOpts);
  const problems = [];
  watchPage(page, base, problems);
  await page.route('**/api/**', fake.handler);
  return { context, page, fake, problems };
}

/** Record console errors, page errors and requests to other hosts of a page. */
function watchPage(page, base, problems) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push('console error: ' + msg.text());
  });
  page.on('pageerror', (err) => problems.push('page error: ' + err.message));
  page.on('request', (req) => {
    const u = req.url();
    if (!u.startsWith(base) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push('external request: ' + u);
  });
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

/** Visible elements of the page that stick out of the viewport on the left or the right. */
async function overflowing(page) {
  return page.evaluate(() => {
    const out = [];
    const w = document.documentElement.clientWidth;
    for (const n of document.querySelectorAll('main *, header *, dialog[open] *')) {
      if (!n.getClientRects().length) continue;
      const r = n.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.left < -1 || r.right > w + 1) out.push(`${n.tagName.toLowerCase()}#${n.id}.${n.className}: ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return out.slice(0, 10);
  });
}

/**
 * Visible controls of the screen (and of an open dialog) smaller than 44 x 44 px. A
 * checkbox counts with its label; a radio drawn as a tile is as big as its tile.
 */
async function smallTargets(page) {
  return page.evaluate(() => {
    const out = [];
    const open = document.querySelector('dialog[open]');
    const scope = open || document.querySelector('main');
    for (const n of scope.querySelectorAll('button, select, a[href], input:not([type="hidden"]), textarea, .file-btn')) {
      if (!n.getClientRects().length || n.closest('[hidden]')) continue;
      if (n.type === 'checkbox' || n.type === 'file') continue;
      const r = n.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) out.push(`${n.tagName.toLowerCase()}#${n.id}.${n.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out.slice(0, 10);
  });
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

async function record(page, buttonSel, ms) {
  await page.click(buttonSel);
  await page.waitForSelector(`${buttonSel}[data-state="recording"]`);
  await sleep(ms);
  await page.click(buttonSel);
}

/** Chromium logs every 4xx answer as a console error; some flows provoke 400 and 422. */
const expected4xx = (problems) => problems.filter((p) => !/Failed to load resource: the server responded with a status of (400|422)/.test(p));

/** The `key: 'text'` entries of one language block of a STRINGS table (app.js, family.js). */
function uiStrings(lang, file) {
  const source = fs.readFileSync(path.join(WEB, file || 'app.js'), 'utf8');
  const start = source.indexOf('\n    ' + lang + ': {\n');
  assert.ok(start > 0, 'no ' + lang + ' block in ' + (file || 'app.js'));
  const end = source.indexOf('\n    },', start);
  const out = {};
  for (const m of source.slice(start, end).matchAll(/^ {6}(\w+): (['"])(.*)\2,$/gm)) out[m[1]] = m[3].replace(/\\(['"])/g, '$1');
  return out;
}

/** The strings of app.js and family.js together, for one language. */
function allStrings(lang) {
  return Object.assign({}, uiStrings(lang, 'app.js'), uiStrings(lang, 'family.js'));
}

// ---------------------------------------------------------------------------
// Family helpers (family.js): setup, child picker, PIN, parent area
// ---------------------------------------------------------------------------

const PIN = '2468';

/**
 * The first-run family setup: {lang (grown-ups), childLang, consent, nickname, age,
 * avatar (index in the fixed list), pin}. Ends on the child's home.
 */
async function setupFamily(page, o) {
  const opts = Object.assign({ consent: true, nickname: 'Sami', pin: PIN, avatar: 0 }, o || {});
  await page.waitForSelector('#setup-form:not([hidden])');
  if (opts.lang) await page.selectOption('#setup-lang', opts.lang);
  if (opts.consent) await page.check('#consent');
  else await page.uncheck('#consent');
  await page.fill('#setup-pin', opts.pin);
  await page.fill('#setup-pin2', opts.pin);
  await page.fill('#nickname', opts.nickname);
  if (opts.age) await page.selectOption('#age', opts.age);
  if (opts.childLang) await page.selectOption('#child-lang', opts.childLang);
  await page.check(`#setup-avatars input[name="setup-avatar"] >> nth=${opts.avatar}`);
  await page.click('#btn-start');
  await page.waitForSelector('#screen-home:not([hidden])');
}

/** Type the PIN into the open PIN dialog and wait until it closes. */
async function enterPin(page, pin) {
  await page.waitForSelector('#pin-dialog[open]');
  await page.fill('#pin-1', pin || PIN);
  await page.click('#pin-ok');
  await page.waitForSelector('#pin-dialog:not([open])', { state: 'attached' });
}

/** Open the parent area from the child's home or the picker, with the PIN. */
async function openParent(page, pin) {
  if (await page.isVisible('#btn-who-parents')) {
    await page.click('#btn-who-parents');
  } else {
    if (!(await page.isVisible('#btn-home-parents'))) {
      await page.click('#btn-home');
      await page.waitForSelector('#screen-home:not([hidden])');
    }
    await page.click('#btn-home-parents');
  }
  await enterPin(page, pin);
  await page.waitForSelector('#screen-parent:not([hidden])');
}

async function parentSection(page, name) {
  await page.click(`#psec-nav .psec-tab[data-psec="${name}"]`);
  await page.waitForSelector(`#screen-parent .psec[data-psec="${name}"]:not([hidden])`);
}

async function closeParent(page) {
  await page.click('#btn-parent-close');
  await page.waitForSelector('#screen-parent', { state: 'hidden' });
}

/** Change the language of the (only or first) child through the parent area. */
async function setChildLang(page, lang, childIndex) {
  await openParent(page);
  await parentSection(page, 'children');
  await page.click(`#pc-list .pchild >> nth=${childIndex || 0} >> [data-edit]`);
  await page.selectOption('#cf-lang', lang);
  await page.click('#cf-save');
  await page.waitForSelector('#cf', { state: 'hidden' });
  await closeParent(page);
  await page.waitForSelector('#screen-home:not([hidden])');
}

/** Tick or untick the consent box in the parent area (Settings). */
async function setConsent(page, on) {
  await openParent(page);
  await parentSection(page, 'settings');
  if (on) await page.check('#settings-consent');
  else await page.uncheck('#settings-consent');
  await closeParent(page);
  await page.waitForSelector('#screen-home:not([hidden])');
}

/** The family document as stored by the page (or null). */
function storedDoc(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('mommy.data.v2')));
}

module.exports = {
  ROOT,
  WEB,
  SHOTS,
  PYTHON,
  check,
  finish,
  results,
  sleep,
  startServer,
  parseMultipart,
  parseWav,
  silentWav,
  jpegSize,
  withExif,
  ATTRIBUTION,
  TANZIL,
  loadTanzil,
  ayah,
  PAGE_TEXT,
  STRICT_RESULT,
  SAY_AGAIN_RESULT,
  CONTEXTUAL_RESULT,
  DICTATION_RESULT,
  strictResult,
  fakeQuranCheck,
  QURAN_SAMPLE,
  QURAN_MESSAGE,
  QURAN_MEANING_MESSAGE,
  BASMALA_TEXT,
  BASMALA_LINE,
  BASMALA_LINE_TEXT,
  FAKE_QURAN_REFS,
  fakeQuranAnalysis,
  quranFixtures,
  quranStrictResult,
  holdsQuranPart,
  ttsQuranLeaks,
  makeFakeApi,
  newPage,
  watchPage,
  shot,
  shotEl,
  noHorizontalScroll,
  overflowing,
  smallTargets,
  waitForCall,
  waitForTts,
  record,
  expected4xx,
  uiStrings,
  allStrings,
  PIN,
  setupFamily,
  enterPin,
  openParent,
  parentSection,
  closeParent,
  setChildLang,
  setConsent,
  storedDoc,
};

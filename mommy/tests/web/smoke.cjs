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
 *     note and the mode-change reset; a phrase the voice refuses becoming a grown-up
 *     step (not the Quran section); Arabic UI strings (app.js and family.js) without
 *     singular imperatives or visibly gendered second-person forms; the riwaya named in
 *     Arabic in the Arabic UI;
 *   - v2 (docs/REWARDS.md): a session starts with the family setup (helpers.cjs), the
 *     child's language and the consent box are changed in the parent area; "Confirm
 *     text" asks /api/text/check once (mode strict).
 *   - Quran in a school text (docs/CONTRACT.md, hard rule 4, Q1 and Q2): the fake's
 *     Quran parts are the server's on the fixtures (guard.find_quran_parts, through the
 *     backend's Python); "Confirm text" of a lesson quoting an ayah (the note with its
 *     reference, "The meaning" off with the reason, dictation on), with a changed or a
 *     dropped word (the differences, "Use the mushaf text" confirming the mushaf words),
 *     and from a page photo; Recite word by word with the note for the grown-up and
 *     feedback that quotes the mushaf shown but never spoken; the dictation with a
 *     grown-up step in the middle and at the start (show, "Done reading", the words out
 *     of the page, Repeat asking again, keyboard and focus), the voice-refusal safety
 *     net and "dictation": false; a text that is Quran opening the Quran section on its
 *     ayat; the screens in en, fr and ar at 360 px and in dark mode; and, over every
 *     flow, no /api/tts request holding a Quran part.
 *   - the live recitation (docs/CONTRACT.md, POST /api/recite/phrase): the phrase detector
 *     and the streaming resampler of recorder.js in Node; in Chromium with a fake
 *     microphone of tone bursts, the words coloured while recording, Stop sending only
 *     the tail with heard_before, one request at a time with queued phrases merged,
 *     answers of a recording that was left dropped, the silent fallback to the whole
 *     recording (500, 404, network), by meaning, Arabic at 360 px in light and dark mode;
 *   - the privacy texts in the four ways the app runs (local or online, with or without
 *     Claude: the fake /api/health "online" and "brain"): the setup's consent box and
 *     family data line in en, fr and ar, the photo note and the "approximate" label;
 *     online, never "nothing leaves this computer" (nor any other local-only sentence);
 *     a page from a host that is not a loopback one counts as online.
 *
 * Shared helpers (server, fake API, page helpers) are in helpers.cjs; the family UI
 * itself is tested by family.cjs.
 * Run:   node tests/web/smoke.cjs
 * Screenshots (optional): MOMMY_SHOTS_DIR=/some/dir node tests/web/smoke.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const H = require('./helpers.cjs');

const {
  ROOT, WEB, PYTHON, check, sleep, startServer, parseWav, jpegSize, withExif, ATTRIBUTION, ayah,
  PAGE_TEXT, STRICT_RESULT, SAY_AGAIN_RESULT, CONTEXTUAL_RESULT, DICTATION_RESULT,
  QURAN_SAMPLE, BASMALA_TEXT, BASMALA_LINE_TEXT, QURAN_MESSAGE, QURAN_MEANING_MESSAGE,
  makeFakeApi, newPage, shot, shotEl, noHorizontalScroll, waitForCall, waitForTts, record, expected4xx,
} = H;

// ---------------------------------------------------------------------------
// Smoke-specific page helpers
// ---------------------------------------------------------------------------

/**
 * Start a session the v2 way: the family setup (first run) with one child, then the
 * Prepare screen of free practice (where the v1 start screen used to lead).
 */
async function startSession(page, { consent, nickname }) {
  await H.setupFamily(page, { consent: !!consent, nickname: nickname || 'Sami' });
  await H.openEditor(page);
  await page.waitForSelector('#screen-prepare:not([hidden])');
}

/** Change the child's language (parent area, Children), then come back to `screen`. */
async function switchLang(page, lang, screen) {
  await H.setChildLang(page, lang);
  if (screen && screen !== 'home') {
    await H.goTab(page, screen);
    await page.waitForSelector(`#screen-${screen}:not([hidden])`);
  }
}

async function confirmPageText(page, text) {
  await H.openEditor(page);
  await page.fill('#page-text', text);
  await page.click('#btn-confirm');
  await page.waitForSelector('#prep-next:not([hidden])');
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

  await phraseSegmenterTests(R);
}

/*
 * Live recitation: the streaming resampler and the phrase detector (recorder.js), in
 * Node. A "phrase" here is a voiced sound: a 180 Hz tone in syllables of 190 ms with
 * 60 ms dips between them, like speech for an energy detector.
 */
function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296 - 0.5;
  };
}

function speechLike(rate, seconds, amp) {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const on = t % 0.25 < 0.19 ? 1 : 0.02;
    out[i] = (amp || 0.2) * on * Math.sin(2 * Math.PI * 180 * t) * (1 + 0.3 * Math.sin(2 * Math.PI * 3 * t));
  }
  return out;
}

/** parts: [['s', seconds] | ['v', seconds, amp?] | ['n', seconds]] -> {pcm, voiced: [[start, end]]}. */
function scene(R, rate, parts, noise) {
  const pieces = [];
  const voiced = [];
  let t = 0;
  for (const [kind, sec, amp] of parts) {
    pieces.push(kind === 'v' ? speechLike(rate, sec, amp) : new Float32Array(Math.round(rate * sec)));
    if (kind === 'v') voiced.push([t, t + sec]);
    t += sec;
  }
  const pcm = R.concatSamples(pieces);
  if (noise) {
    const rnd = lcg(7);
    for (let i = 0; i < pcm.length; i++) pcm[i] += noise * 2 * rnd();
  }
  return { pcm, voiced };
}

/** Run a segmenter over pcm in chunks of random sizes; {phrases, tail}. */
function segmentAll(R, pcm, options, seed) {
  const seg = new R.PhraseSegmenter(options);
  const rnd = lcg(seed || 1);
  const phrases = [];
  let i = 0;
  while (i < pcm.length) {
    const n = 200 + Math.floor((rnd() + 0.5) * 3000);
    for (const p of seg.push(pcm.subarray(i, i + n))) phrases.push(p);
    i += n;
  }
  return { phrases, tail: seg.finish() };
}

async function phraseSegmenterTests(R) {
  await check('recorder.StreamResampler in chunks of any size gives exactly downsample() of the whole', () => {
    for (const [rate, seconds] of [[48000, 2.3], [44100, 1.7], [16000, 0.5], [8000, 0.4]]) {
      const input = speechLike(rate, seconds, 0.5);
      const whole = R.downsample(input, rate, 16000);
      const rs = new R.StreamResampler(rate, 16000);
      const rnd = lcg(rate);
      const out = [];
      for (let i = 0; i < input.length;) {
        const n = 1 + Math.floor((rnd() + 0.5) * 5000);
        out.push(rs.push(input.subarray(i, i + n)));
        i += n;
      }
      out.push(rs.flush());
      const streamed = R.concatSamples(out);
      assert.equal(streamed.length, whole.length, rate + ' Hz length');
      let diff = 0;
      for (let k = 0; k < whole.length; k++) diff = Math.max(diff, Math.abs(streamed[k] - whole[k]));
      assert.ok(diff < 1e-6, rate + ' Hz differs by ' + diff);
      assert.ok(rs._buf.length < 200, 'the resampler keeps only a short history: ' + rs._buf.length);
    }
  });

  await check('recorder.PhraseSegmenter cuts at pauses of 0.8 s, with 0.2 s of padding, in order and without overlap', () => {
    const rate = 16000;
    const { pcm, voiced } = scene(R, rate, [['s', 0.6], ['v', 2.0], ['s', 0.8], ['v', 1.5], ['s', 0.8], ['v', 2.2], ['s', 1.5]], 0.0005);
    const { phrases, tail } = segmentAll(R, pcm);
    assert.equal(phrases.length, 3, JSON.stringify(phrases.map((p) => [p.start, p.end])));
    phrases.forEach((p, k) => {
      const [a, b] = voiced[k];
      assert.ok(Math.abs(p.start - (a - 0.2)) <= 0.03, `phrase ${k} starts at ${p.start}, speech at ${a}`);
      assert.ok(p.end >= b - 0.07 + 0.2 - 0.03 && p.end <= b + 0.2 + 0.03, `phrase ${k} ends at ${p.end}, speech at ${b}`);
      assert.equal(p.forced, false);
      assert.ok(p.speech >= 0.4);
      assert.equal(p.samples.length, Math.round((p.end - p.start) * rate));
      // The samples are the signal itself.
      const from = Math.round(p.start * rate);
      for (const k2 of [0, 100, p.samples.length - 1]) assert.equal(p.samples[k2], pcm[from + k2]);
      if (k) assert.ok(p.start >= phrases[k - 1].end, 'no overlap');
    });
    assert.equal(tail.samples.length, 0, 'nothing after the last phrase');
    assert.equal(tail.speech, 0);
  });

  await check('recorder.PhraseSegmenter: a pause under 0.65 s does not cut, a short sound waits for the next phrase, a click is dropped', () => {
    // 0.5 s pause inside a sentence: one phrase.
    let r = segmentAll(R, scene(R, 16000, [['s', 0.5], ['v', 1.2], ['s', 0.5], ['v', 1.2], ['s', 1.0]]).pcm);
    assert.equal(r.phrases.length, 1);
    assert.ok(r.phrases[0].speech > 1.5);
    // 0.25 s of sound then 0.9 s of silence: not sent alone, it starts the next phrase.
    r = segmentAll(R, scene(R, 16000, [['s', 0.5], ['v', 0.25], ['s', 0.9], ['v', 1.2], ['s', 1.0]]).pcm);
    assert.equal(r.phrases.length, 1);
    assert.ok(Math.abs(r.phrases[0].start - 0.3) < 0.03, 'starts with the short sound: ' + r.phrases[0].start);
    // 0.1 s click then 1.2 s of silence: dropped; the phrase starts at the speech.
    r = segmentAll(R, scene(R, 16000, [['s', 0.5], ['v', 0.1], ['s', 1.2], ['v', 1.2], ['s', 1.0]]).pcm);
    assert.equal(r.phrases.length, 1);
    assert.ok(Math.abs(r.phrases[0].start - 1.6) < 0.03, 'the click is left out: ' + r.phrases[0].start);
    // A short sound at the very end stays in the tail (with up to 1 s of lead-in).
    r = segmentAll(R, scene(R, 16000, [['s', 0.5], ['v', 1.2], ['s', 1.0], ['v', 0.3], ['s', 0.3]]).pcm);
    assert.equal(r.phrases.length, 1);
    assert.ok(r.tail.speech >= 0.15 && r.tail.samples.length > 0);
    assert.ok(r.tail.start >= r.phrases[0].end && r.tail.start <= 2.7 - 0.6, 'tail from ' + r.tail.start);
    assert.equal(r.tail.end, 3.3);
  });

  await check('recorder.PhraseSegmenter: silence or a steady noise alone gives no phrase and an empty tail', () => {
    for (const noise of [0, 0.0005, 0.02]) {
      const { pcm } = scene(R, 16000, [['s', 12]], noise);
      const r = segmentAll(R, pcm);
      assert.equal(r.phrases.length, 0, 'noise ' + noise);
      assert.equal(r.tail.samples.length, 0);
      assert.equal(r.tail.speech, 0);
    }
  });

  await check('recorder.PhraseSegmenter follows the noise floor: phrases in a noisy room, and after the noise gets louder', () => {
    // A room at about -37 dBFS (white noise), the voice at about -17 dBFS.
    let { pcm, voiced } = scene(R, 16000, [['s', 1.0], ['v', 1.5], ['s', 0.9], ['v', 1.5], ['s', 1.0]], 0.025);
    let r = segmentAll(R, pcm);
    assert.equal(r.phrases.length, 2, JSON.stringify(r.phrases.map((p) => [p.start, p.end])));
    assert.ok(Math.abs(r.phrases[1].start - (voiced[1][0] - 0.2)) < 0.05);
    // Quiet (-66 dBFS), then a fan makes the room 20 dB louder for 7 s before the child goes on.
    const quiet = scene(R, 16000, [['s', 0.5], ['v', 1.2], ['s', 1.0]], 0.0005).pcm;
    const noisy = scene(R, 16000, [['s', 7], ['v', 1.2, 0.5], ['s', 1.0]], 0.005).pcm;
    r = segmentAll(R, R.concatSamples([quiet, noisy]));
    const starts = r.phrases.map((p) => p.start);
    assert.ok(r.phrases.length >= 2, JSON.stringify(starts));
    const last = r.phrases[r.phrases.length - 1];
    assert.ok(Math.abs(last.start - (2.7 + 7 - 0.2)) < 0.1, 'the phrase after the fan: ' + JSON.stringify(starts));
    assert.ok(last.end - last.start < 2.0, 'the fan is not part of it');
  });

  await check('recorder.PhraseSegmenter cuts 40 s of speech without a pause at the quietest moment, at most every 18 s, without padding', () => {
    const rate = 16000;
    const { pcm } = scene(R, rate, [['s', 0.5], ['v', 11.5], ['v', 0.12, 0.004], ['v', 3.5], ['v', 25], ['s', 1.0]]);
    const { phrases, tail } = segmentAll(R, pcm);
    assert.ok(phrases.length >= 3, String(phrases.length));
    assert.equal(phrases[0].forced, true);
    // The first cut is in the quiet 120 ms at 12 s (inside the 8 s searched before 18 s).
    assert.ok(Math.abs(phrases[0].end - 12.06) < 0.08, 'cut at ' + phrases[0].end);
    for (let k = 0; k < phrases.length; k++) {
      const p = phrases[k];
      assert.ok(p.end - p.start <= 18.25, 'phrase of ' + (p.end - p.start) + ' s');
      if (k) assert.equal(p.start, phrases[k - 1].end, 'a forced cut joins the next phrase exactly');
    }
    const covered = phrases.reduce((a, p) => a + p.samples.length, 0) + tail.samples.length;
    assert.ok(covered >= (40.12 - 0.3) * rate, 'every word is in a phrase or the tail');
  });

  await check('recorder.PhraseSegmenter keeps speech from the very first moment of a recording', () => {
    const { pcm } = scene(R, 16000, [['v', 1.5], ['s', 1.0], ['v', 1.0], ['s', 1.0]]);
    const { phrases } = segmentAll(R, pcm);
    assert.equal(phrases.length, 2);
    assert.ok(phrases[0].start <= 0.02, 'starts at ' + phrases[0].start);
  });

  await check('recorder.PhraseSegmenter keeps a bounded buffer during a long recording', () => {
    const seg = new R.PhraseSegmenter();
    const { pcm } = scene(R, 16000, [['s', 0.5], ['v', 1.5], ['s', 1.0]]);
    for (let k = 0; k < 40; k++) seg.push(pcm); // 2 minutes
    assert.equal(seg.phrases, 40);
    assert.ok(seg._samples.length <= 16000 * 2.5, 'samples kept: ' + seg._samples.length);
    assert.ok(seg._frames.length <= 130, 'frames kept: ' + seg._frames.length);
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
    await page.selectOption('#setup-lang', 'ar');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.equal(await page.getAttribute('html', 'lang'), 'ar');
    assert.match(await page.textContent('#ai-badge'), /ليس إنسانًا/);
    assert.match(await page.textContent('#btn-start'), /لنبدأ/);
    await shot(page, 'start-360-ar');
    await noHorizontalScroll(page);
    await page.selectOption('#setup-lang', 'fr');
    assert.equal(await page.getAttribute('html', 'dir'), 'ltr');
    assert.match(await page.textContent('#ai-badge'), /pas une personne/);
    await page.selectOption('#setup-lang', 'en');
    assert.equal(await page.getAttribute('html', 'dir'), 'ltr');
    // Nothing is stored before the parent finishes the setup.
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), []);
  });

  await check('without consent the microphone and camera stay disabled, with an explanation', async () => {
    await startSession(page, { consent: false, nickname: 'Sami' });
    await page.waitForSelector('#screen-prepare:not([hidden])');
    assert.ok(await page.isVisible('#nav'));
    assert.ok(await page.isDisabled('#prep-take'));
    assert.ok(await page.isDisabled('#prep-choose'));
    assert.match(await page.textContent('#why-prep-photo'), /give the OK in Settings/);
    await page.fill('#page-text', PAGE_TEXT);
    await pressConfirm(page);
    assert.match(await page.textContent('#prep-confirm-status'), /Saved in “My texts”/);
    await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
    assert.match(await page.textContent('#recite-hello'), /Hi Sami!/);
    assert.ok(await page.isDisabled('#recite-rec'));
    assert.ok(await page.isVisible('#why-recite-rec'));
    assert.match(await page.textContent('#why-recite-rec'), /Ask a parent to give the OK in Settings/);
    // The child's profile is in the family document; the box was not ticked, so no consent.
    const doc = await H.storedDoc(page);
    assert.equal(doc.children[0].nickname, 'Sami');
    assert.equal(doc.parent.consentAt, null);
    assert.equal(await page.evaluate(() => localStorage.getItem('mommy.profile.v1')), null);
  });

  await check('ticking consent (parent area, Settings) enables the microphone and camera', async () => {
    await H.setConsent(page, true);
    await H.goTab(page, 'recite');
    await page.waitForSelector('#screen-recite:not([hidden])'); // the text is already confirmed
    assert.ok(await page.isEnabled('#recite-rec'));
    assert.ok(await page.isHidden('#why-recite-rec'));
    await H.openEditor(page);
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
    assert.deepEqual(call.aiConsent, ['1'], 'the AI consent counts: sent once, as "1"');
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
    assert.match(await page.textContent('#prep-confirm-status'), /Saved in “My texts”/);
  });

  await check('recite: records a 16 kHz mono PCM16 WAV and releases the microphone', async () => {
    await H.goTab(page, 'recite');
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
    await H.goTab(page, 'dictation');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    await page.waitForFunction(() => MommyRecorder.openStreams() === 0);
    assert.equal(fake.callsTo('/api/recite/check').length, 3, 'a cancelled recording is not uploaded');
  });

  await check('recite: contextual mode shows the meaning verdict and missing ideas', async () => {
    await H.openEditor(page);
    await page.check('input[name="mode"][value="contextual"]');
    await pressConfirm(page);
    await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
    assert.match(await page.textContent('#recite-mode-label'), /The meaning/);
    await record(page, '#recite-rec', 700);
    const call = await waitForCall(fake, '/api/recite/check', 4);
    assert.equal(call.form.mode.text, 'contextual');
    assert.deepEqual(call.aiConsent, ['1']);
    await page.waitForSelector('#recite-verdict:not([hidden])');
    assert.match(await page.textContent('#recite-verdict'), /Partly right/);
    assert.match(await page.textContent('#recite-missing'), /on the mat/);
    // Claude judged the meaning (the AI consent was sent): no "approximate" label.
    assert.ok(await page.isHidden('#recite-approx'));
    assert.equal((await page.textContent('#recite-feedback')).trim(), CONTEXTUAL_RESULT.feedback);
    await H.openEditor(page);
    await page.check('input[name="mode"][value="strict"]');
    await pressConfirm(page);
  });

  await check('dictation (owner\'s decision): each sentence is said once at normal speed, then word by word slowly with a pause to write; Repeat replays it from the cache; Next', async () => {
    await H.goTab(page, 'dictation');
    await page.click('#btn-dict-start');
    const ph = await waitForCall(fake, '/api/dictation/phrases', 1);
    assert.deepEqual(ph.json, { text: PAGE_TEXT, lang: 'en' });
    await page.waitForSelector('#dict-counter');
    assert.match(await page.textContent('#dict-counter'), /Part 1 of 2/);
    await waitForTts(fake, 'The cat sat');
    assert.deepEqual(fake.ttsFor('The cat sat')[0].json, { text: 'The cat sat', lang: 'en', slow: false }, 'the sentence at normal speed');
    // Then each word, slowly (the punctuation left out), fetched once.
    for (const w of ['The', 'cat', 'sat']) {
      await waitForTts(fake, w);
      assert.deepEqual(fake.ttsFor(w)[0].json, { text: w, lang: 'en', slow: true, check: false }, 'single words: no speech check');
    }
    // While the child writes, the next sentence and its words are fetched ahead.
    await waitForTts(fake, 'on the mat.');
    await waitForTts(fake, 'mat');
    assert.deepEqual(fake.ttsFor('mat')[0].json, { text: 'mat', lang: 'en', slow: true, check: false });
    await page.waitForSelector('#dict-next:not([disabled])');
    const n = fake.callsTo('/api/tts').length;
    await page.click('#dict-repeat');
    await sleep(400);
    assert.equal(fake.callsTo('/api/tts').length, n, 'Repeat reuses the sentence and the words already fetched');
    assert.ok(await page.isHidden('#dict-unclear'), 'the speech check passed: no note');
    assert.ok(await page.isHidden('#dict-phrase'));
    await page.click('#dict-show');
    assert.equal((await page.textContent('#dict-phrase')).trim(), 'The cat sat');
    assert.equal((await page.textContent('#dict-show')).trim(), 'Hide the words');
    await page.waitForSelector('#dict-next:not([disabled])');
    await page.click('#dict-next');
    assert.match(await page.textContent('#dict-counter'), /Part 2 of 2/);
    assert.match(await page.textContent('#dict-next'), /I've finished/);
    await sleep(300);
    assert.equal(fake.callsTo('/api/tts').length, n, 'the second sentence and its words were already fetched');
    await shot(page, 'dictation-360');
    await page.waitForSelector('#dict-next:not([disabled])');
    await page.click('#dict-next');
    await page.waitForSelector('[data-stage="mom"]:not([hidden])');
  });

  await check('dictation (owner\'s decision): "Mom\'s check" shows the text, a grown-up taps the words that are not right (again to undo), and the child sees the score and the right spellings; nothing is sent to be checked', async () => {
    const ttsBefore = fake.callsTo('/api/tts').length;
    assert.deepEqual(await page.$$eval('#dict-mom-words .mom-word', (b) => b.map((x) => x.textContent)), ['The', 'cat', 'sat', 'on', 'the', 'mat.']);
    assert.equal(await page.getAttribute('#dict-mom-words', 'dir'), 'ltr');
    assert.match(await page.textContent('[data-stage="mom"]'), /show the paper to Mom/);
    // Tap, tap again (undo), tap another.
    await page.click('#dict-mom-words .mom-word >> nth=1');
    assert.equal(await page.getAttribute('#dict-mom-words .mom-word >> nth=1', 'aria-pressed'), 'true');
    await page.click('#dict-mom-words .mom-word >> nth=1');
    assert.equal(await page.getAttribute('#dict-mom-words .mom-word >> nth=1', 'aria-pressed'), 'false');
    await page.click('#dict-mom-words .mom-word >> nth=5');
    assert.equal((await page.textContent('#dict-mom-count')).trim(), 'Words to look at again: 1');
    await shot(page, 'dictation-mom-360');
    assert.deepEqual(await H.smallTargets(page), []);
    await page.click('#dict-mom-done');
    await page.waitForSelector('[data-stage="child"]:not([hidden])');
    assert.equal((await page.textContent('#dict-child-feedback')).trim(), '5 of 6 words right. Well done for writing it all!');
    assert.equal(await page.locator('#dict-child-words .w-match').count(), 5);
    assert.equal((await page.textContent('#dict-child-words .w-fix .w-exp')).trim(), 'mat.');
    assert.ok(await page.isVisible('#dict-fix-hint'));
    // Only the score line is said (no word of the text).
    const spoken = await waitForCall(fake, '/api/tts', ttsBefore + 1);
    assert.deepEqual(spoken.json, { text: '5 of 6 words right. Well done for writing it all!', lang: 'en', slow: false });
    assert.equal(fake.callsTo('/api/dictation/check').length, 0, 'the paper is checked by a grown-up: nothing is sent');
    // Free practice of a saved text: not all right, so no star; the child tries again.
    assert.match(await page.textContent('#task-outcome-dictation'), /Try again whenever you are ready/);
    await shot(page, 'dictation-result-360');
    await noHorizontalScroll(page);
  });

  await check('dictation (owner\'s decision): "All correct" gives a star of free practice for the saved text; no photo or typed check in the dictation', async () => {
    await page.click('#btn-dict-new');
    await page.click('#btn-dict-start');
    await waitForCall(fake, '/api/dictation/phrases', 2);
    await H.dictateAll(page);
    await H.momCheck(page, []);
    assert.equal((await page.textContent('#dict-child-feedback')).trim(), 'All 6 words right. Wonderful!');
    assert.ok(await page.isHidden('#dict-fix-hint'));
    await page.waitForSelector('#task-outcome-dictation:not([hidden])');
    assert.match(await page.textContent('#task-outcome-dictation'), /A star for the jar/);
    const doc = await H.storedDoc(page);
    const led = doc.jar[doc.children[0].id].ledger.filter((e) => e.reason === 'practice');
    assert.deepEqual(led.map((e) => [e.act, e.delta]), [['dictation', 1]]);
    assert.equal(await page.locator('#screen-dictation input[type="file"], #dict-written, #btn-dict-check').count(), 0);
    assert.equal(fake.callsTo('/api/dictation/check').length, 0);
  });

  await check('quran: Juz Amma by default, verbatim Uthmani text in RTL, Hafs – Tanzil attribution', async () => {
    await H.goTab(page, 'quran');
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
    await switchLang(page, 'ar', 'quran');
    await page.waitForSelector('#quran-text .ayah');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.match(await page.textContent('#quran-title'), /القرآن/);
    await shot(page, 'quran-360-ar');
    await noHorizontalScroll(page);
    await H.goTab(page, 'recite');
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
    await page.waitForSelector('#screen-recite:not([hidden])');
    await record(page, '#recite-rec', 600);
    await page.waitForSelector('#recite-text .w-sub');
    await shot(page, 'recite-desktop');
    await H.goTab(page, 'quran');
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

/**
 * Phones only let a sound start without a new tap on an element a tap has started, and
 * only shortly after a tap on a fresh one (Chromium's user-gesture-required policy acts
 * the same). The owner heard only the first word of the word-by-word part: the app made
 * a fresh element per sound, so the words after a writing pause were refused. Here the
 * words arrive more than 5 s after the tap, as on a slow server, and must still play.
 */
async function strictAutoplayFlow(base) {
  const strict = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=user-gesture-required'],
  });
  try {
    const { context, page, fake, problems } = await newPage(strict, base, { width: 360, height: 780 });
    await page.addInitScript(() => {
      window.__strictPlays = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        const at = Date.now();
        const p = play.call(this);
        p.then(() => window.__strictPlays.push({ ok: true, at }), (e) => window.__strictPlays.push({ ok: false, name: e.name, at }));
        return p;
      };
      window.__mommyPauseScale = 0.05;
    });
    await check('dictation on a phone-like autoplay policy: the sentence AND the words play, even when the words come more than 5 s after the tap', async () => {
      await page.goto(base + '/');
      await startSession(page, { consent: true, nickname: 'Lina' });
      await page.waitForSelector('#screen-prepare:not([hidden])');
      await page.fill('#page-text', PAGE_TEXT);
      await pressConfirm(page);
      fake.setTts({ delay: (j) => (j.slow ? 6000 : 0) });
      await H.goTab(page, 'dictation');
      await page.click('#btn-dict-start');
      try {
        await page.waitForFunction(() => window.__strictPlays.filter((p) => p.ok).length >= 2, null, { timeout: 40000 });
      } catch (e) {
        throw new Error('plays: ' + JSON.stringify(await page.evaluate(() => window.__strictPlays)) + ' status: ' + (await page.textContent('#dict-speak-status')) + ' tts: ' + JSON.stringify(fake.callsTo('/api/tts').map((c) => c.json)) + ' errors: ' + JSON.stringify(problems));
      }
      const plays = await page.evaluate(() => window.__strictPlays);
      // The tap's moment of silence may be cut short by the sentence (AbortError): fine.
      assert.deepEqual(plays.filter((p) => !p.ok && p.name !== 'AbortError'), [], 'no sound was refused');
      const ok = plays.filter((p) => p.ok);
      assert.ok(ok[1].at - plays[0].at > 5000, 'the words (one sound) started more than 5 s after the tap, and played');
      // The tap's moment of silence, the sentence, then all its words as one sound.
      assert.equal(await page.locator('audio').count(), 0, 'one shared element, not in the page');
      fake.setTts(null);
    });
    await context.close();
  } finally {
    await strict.close();
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
    await page.waitForSelector('#screen-recite:not([hidden])');
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
    await page.waitForSelector('#screen-recite:not([hidden])');
    assert.match(await page.textContent('#recite-hello'), /Hi Sami!/);
    assert.ok(await page.isDisabled('#recite-rec'));
    assert.match(await page.textContent('#why-recite-rec'), /speech recognition model is not installed/);
    await H.goTab(page, 'dictation');
    await page.click('#btn-dict-start');
    await page.waitForSelector('[data-stage="speak"]:not([hidden])');
    assert.ok(await page.isDisabled('#dict-repeat'));
    assert.match(await page.textContent('[data-why="dict-play"]'), /voice is not available/);
    await page.click('#dict-show');
    assert.equal((await page.textContent('#dict-phrase')).trim(), 'The cat sat', 'a grown-up can read the phrase');
    await page.click('#dict-next');
    await page.click('#dict-next');
    // "Mom's check" needs no server part at all.
    await H.momCheck(page, [0]);
    assert.match(await page.textContent('#dict-child-feedback'), /5 of 6 words right/);
    await H.goTab(page, 'quran');
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
    await page.waitForSelector('#screen-recite:not([hidden])');
    assert.ok(await page.isDisabled('#recite-rec'));
    fake.setHealthDown(false);
    await page.click('#btn-retry');
    await page.waitForSelector('#server-banner', { state: 'hidden' });
    // The setup was made while the server could not say that Claude is set up, so the
    // Claude notice and its box were not shown: the general consent does not cover Claude.
    // Recite works all the same: it is sent without the AI consent, and the server's
    // offline brain answers.
    await page.waitForSelector('#recite-rec:not([disabled])');
    assert.ok(await page.isHidden('#why-recite-rec'));
    await record(page, '#recite-rec', 300);
    assert.deepEqual((await waitForCall(fake, '/api/recite/check', 1)).aiConsent, [], 'no AI consent: no field');
    await page.waitForSelector('#recite-result:not([hidden])');
    await H.setConsent(page, true); // the AI box stands under the Claude notice now
    await H.goTab(page, 'recite');
    await page.waitForSelector('#recite-rec:not([disabled])');
    await record(page, '#recite-rec', 300);
    assert.deepEqual((await waitForCall(fake, '/api/recite/check', 2)).aiConsent, ['1']);
    // The aborted health request is logged by the browser as a failed load; nothing else.
    const others = problems.filter((p) => !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(p));
    assert.deepEqual(others, []);
  });
  await context.close();
}

/**
 * Online, the owner sets a new access code while the app is open: every API call then
 * answers 401 access_required. The app reloads (OPS-4), and the server answers that
 * navigation with its code page; it never shows "server down" with a retry that cannot
 * work. Here a route plays the server's part for the navigation.
 */
async function accessRevoked(browser, base) {
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 });
  await check('online, the cookie no longer opens the app: the app reloads to the code page', async () => {
    await page.goto(base + '/');
    await H.setupFamily(page, { consent: true, nickname: 'Sami' });
    await page.waitForSelector('#server-banner', { state: 'hidden' });
    const before = new URL(page.url());
    const navigations = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    fake.setAccessRequired(true);
    await page.route(base + '/**', (route, request) =>
      request.isNavigationRequest()
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>code page</title><p id="code-page">code page</p>' })
        : route.fallback(),
    );
    const healthCalls = fake.callsTo('/api/health').length;
    await page.evaluate(() => document.getElementById('btn-retry').click()); // any API call
    await page.waitForSelector('#code-page');
    assert.equal(fake.callsTo('/api/health').length, healthCalls + 1);
    assert.equal(new URL(page.url()).pathname, before.pathname); // the same page, reloaded
    await sleep(500);
    assert.equal(navigations.length, 1, navigations.join(', ')); // once, no loop
    // Chromium logs the 401 as a failed load; nothing else.
    assert.deepEqual(problems.filter((p) => !/status of 401/.test(p)), []);
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// Regression checks for the review findings (each one failed before its fix)
// ---------------------------------------------------------------------------

const AR_TEXT = 'ذَهَبَ الْوَلَدُ إِلَى الْمَدْرَسَةِ مَعَ أَخِيهِ.';
const AR_QURAN_MSG = 'هذا النص من القرآن الكريم. يُرجى التدرّب عليه في قسم القرآن الكريم.';
const EN_QURAN_MSG = 'This text is from the Quran. Please practise it in the Quran section.';
// The server's safety net ("dictation": false, or 422 quran_text from the phrases of a
// checked text): Quran words the voice would meet outside the Quran parts.
const EN_UNMARKED_MSG = 'This text cannot be used for dictation: the voice found words of the Quran in it that the app could not mark for a grown-up to read. It can still be recited word by word.';
const AR_UNMARKED_MSG = 'لا يمكن استخدام هذا النص في الإملاء: وجد الصوت فيه كلمات من القرآن الكريم تعذّر تحديدها ليقرأها أحد الكبار. ولكن يمكن تسميعه كلمةً بكلمة.';
const EN_MEANING_OFF = '“The meaning” is not available for this text: it has words of the Quran, and the app never judges the meaning of the Quran. They are checked word by word.';
const EN_CONFIRMED_QURAN = 'Saved. It has words of the Quran: see the note under the text.';
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

// ---------------------------------------------------------------------------
// Live recitation (docs/CONTRACT.md, POST /api/recite/phrase)
// ---------------------------------------------------------------------------

const LIVE_TEXT = 'The cat sat on the mat. It was a sunny day. The dog came to play.';
const LIVE_TEXT_AR = 'ذهب الولد إلى المدرسة في الصباح. جلس في الصف وفتح كتابه. شرح المعلم الدرس بصوت واضح.';
const LIVE_HEALTH = { asr: true, tts: true, brain: 'claude', quran: true, languages: ['ar', 'en', 'fr'], live_recite: true };

/** Seconds of audio in a WAV upload of the fake API. */
function wavSeconds(part) {
  const h = parseWav(part.data);
  assert.equal(h.rate, 16000);
  assert.equal(h.channels, 1);
  assert.equal(h.bits, 16);
  return h.dataBytes / 32000;
}

/** Seconds since the fake microphone started. */
function micTime(page) {
  return page.evaluate(() => (performance.now() - window.__micStarted) / 1000);
}

async function waitMic(page, seconds) {
  for (;;) {
    const t = await micTime(page);
    if (t >= seconds) return;
    await sleep(Math.min(100, (seconds - t) * 1000));
  }
}

/** A page with the live recitation on, a session started and `text` confirmed, on Recite. */
async function livePage(browser, base, { lang, text, mode, colorScheme, viewport } = {}) {
  const ctx = await newPage(browser, base, viewport || { width: 360, height: 780 }, { health: LIVE_HEALTH }, { colorScheme });
  const { page } = ctx;
  await page.goto(base + '/');
  await startSession(page, { consent: true });
  if (lang && lang !== 'en') await switchLang(page, lang);
  await H.openEditor(page);
  if (mode === 'contextual') await page.check('input[name="mode"][value="contextual"]');
  await confirmPageText(page, text || LIVE_TEXT);
  await H.goTab(page, 'recite');
  await page.waitForSelector('#recite-main:not([hidden])');
  return ctx;
}

async function startLiveRecording(page, pattern) {
  await page.evaluate((p) => {
    window.__micPattern = p;
  }, pattern);
  await page.click('#recite-rec');
  await page.waitForSelector('#recite-rec[data-state="recording"]');
}

async function liveFlow(browser, base) {
  const words = LIVE_TEXT.split(' ');
  // (Redesign) A long text at 360 px: the line being read stays in view, above the sticky
  // record bar (the page scrolls to it), and without motion with prefers-reduced-motion.
  for (const reduce of [false, true]) {
    const LONG = Array.from({ length: 24 }, (_, i) => `Line ${i + 1} of the long story goes on here.`).join(' ');
    const ctx = await livePage(browser, base, { text: LONG, viewport: { width: 360, height: 640 } });
    const { page, fake, problems } = ctx;
    await check(`live (redesign): on a long text at 360 px the line being read is scrolled into view above the record bar${reduce ? ', with no smooth motion under prefers-reduced-motion' : ''}`, async () => {
      if (reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
      fake.setLive({ words: 60 });
      fake.queueRecite(H.strictResult(LONG, []));
      await page.evaluate(() => window.scrollTo(0, 0));
      const behaviors = [];
      await page.exposeFunction('__scrollSeen', (b) => behaviors.push(b));
      await page.evaluate(() => {
        const orig = window.scrollBy.bind(window);
        window.scrollBy = (o) => {
          window.__scrollSeen(o && o.behavior);
          return orig(Object.assign({}, o, { behavior: 'auto' }));
        };
      });
      await startLiveRecording(page, [[0.4, 1.0], [2.2, 1.0]]);
      await page.waitForFunction(() => document.querySelectorAll('#recite-text .w-match').length >= 60);
      await page.waitForFunction(() => {
        const w = document.querySelector('#recite-text .w-pending');
        const bar = document.querySelector('#screen-recite .rec-bar').getBoundingClientRect();
        const r = w.getBoundingClientRect();
        return r.bottom <= bar.top && r.top >= document.querySelector('.topbar').getBoundingClientRect().bottom;
      });
      assert.ok(behaviors.length > 0, 'the page scrolled to the line');
      assert.ok(behaviors.every((b) => b === (reduce ? 'auto' : 'smooth')), JSON.stringify(behaviors));
      await shot(page, `live-scroll-360${reduce ? '-reduced' : ''}`);
      await page.click('#recite-rec');
      await page.waitForSelector('#recite-result:not([hidden])');
      assert.deepEqual(problems, []);
    });
    await ctx.context.close();
  }
  {
    const { context, page, fake, problems } = await livePage(browser, base);

    await check('live: while recording, each phrase colours the words read so far and leaves the rest pending', async () => {
      fake.setLive({ words: 4 });
      fake.queueRecite(H.strictResult(LIVE_TEXT, []));
      await startLiveRecording(page, [[0.4, 1.0], [2.2, 1.0], [4.0, 1.0]]);
      assert.equal((await page.textContent('#recite-status')).trim(), H.uiStrings('en').live_listening);
      const first = await waitForCall(fake, '/api/recite/phrase', 1);
      const f = first.form;
      assert.equal(f.heard_before.text, '');
      assert.equal(f.expected_text.text, LIVE_TEXT);
      assert.equal(f.lang.text, 'en');
      assert.equal(f.mode.text, 'strict');
      assert.ok(!f.age && !f.ai_consent, 'a phrase carries no age and no AI consent');
      const sec = wavSeconds(f.audio);
      assert.ok(sec > 1.2 && sec < 1.7, 'the first phrase with its padding: ' + sec);
      await page.waitForFunction(() => document.querySelectorAll('#recite-text .w-match').length === 4);
      assert.equal(await page.locator('#recite-text .w-pending').count(), words.length - 4);
      assert.equal(await page.getAttribute('#recite-rec', 'data-state'), 'recording', 'coloured during the recording');
      assert.ok(await page.isHidden('#recite-legend'));
      const styles = await page.evaluate(() => {
        const cs = (sel) => getComputedStyle(document.querySelector(sel));
        return { match: cs('#recite-text .w-match').color, pending: cs('#recite-text .w-pending').color, pendingBg: cs('#recite-text .w-pending').backgroundColor };
      });
      assert.notEqual(styles.pending, styles.match);
      assert.equal(styles.pendingBg, 'rgba(0, 0, 0, 0)', 'a pending word has no colour of a result');
      await shot(page, 'live-en-360');
      const second = await waitForCall(fake, '/api/recite/phrase', 2);
      assert.equal(second.form.heard_before.text, words.slice(0, 4).join(' '));
      await page.waitForFunction(() => document.querySelectorAll('#recite-text .w-match').length === 8);
    });

    await check('live: Stop sends only the tail with heard_before, and the result follows', async () => {
      await waitMic(page, 5.3); // inside the pause after the third phrase: not cut yet
      const stopAt = await micTime(page);
      await page.click('#recite-rec');
      const call = await waitForCall(fake, '/api/recite/check', 1);
      assert.equal(fake.callsTo('/api/recite/phrase').length, 2);
      assert.equal(call.form.heard_before.text, words.slice(0, 8).join(' '));
      const tail = wavSeconds(call.form.audio);
      assert.ok(tail > 1.0 && tail < 2.6 && tail < stopAt - 2.5, `the tail only: ${tail} s of ${stopAt} s`);
      assert.equal(call.form.mode.text, 'strict');
      assert.equal(call.form.age.text, '6-9');
      await page.waitForSelector('#recite-result:not([hidden])');
      assert.equal(await page.locator('#recite-text .w-pending').count(), 0);
      assert.equal(await page.locator('#recite-text .w-match').count(), words.length);
      assert.ok(await page.isVisible('#recite-legend'));
      assert.equal(fake.callsTo('/api/recite/check').length, 1, 'no second upload of the whole recording');
      assert.equal(await page.evaluate(() => MommyRecorder.openStreams()), 0, 'microphone released');
    });

    await check('live: phrases go one at a time, in order; those that queued up go together', async () => {
      const before = fake.callsTo('/api/recite/phrase').length;
      fake.setLive({ words: 3, delay: () => 3000 });
      fake.queueRecite(H.strictResult(LIVE_TEXT, []));
      await startLiveRecording(page, [[0.3, 0.6], [1.6, 0.6], [2.9, 0.6], [4.2, 0.6]]);
      const second = await waitForCall(fake, '/api/recite/phrase', before + 2);
      assert.equal(second.form.heard_before.text, words.slice(0, 3).join(' '), 'sent after the first answer');
      const merged = wavSeconds(second.form.audio);
      assert.ok(merged > 1.6 && merged < 2.4, 'phrases 2 and 3 in one request: ' + merged);
      await waitMic(page, 6.0);
      await page.click('#recite-rec');
      const call = await waitForCall(fake, '/api/recite/check', 2);
      assert.equal(fake.callsTo('/api/recite/phrase').length, before + 2);
      assert.equal(fake.liveMaxInFlight(), 1, 'never two phrase requests at once');
      assert.equal(call.form.heard_before.text, words.slice(0, 6).join(' '), 'the final waited for the request in flight');
      assert.ok(wavSeconds(call.form.audio) > 0.9, 'the queued fourth phrase goes with the tail');
      await page.waitForSelector('#recite-result:not([hidden])');
    });

    await check('live: an answer for a recording that was left is dropped', async () => {
      fake.setLive({ words: 5, delay: () => 2500 });
      const before = fake.callsTo('/api/recite/phrase').length;
      await startLiveRecording(page, [[0.3, 0.8]]);
      await waitForCall(fake, '/api/recite/phrase', before + 1);
      await H.openEditor(page); // leaves the screen: the recording is dropped
      await H.goTab(page, 'recite');
      await startLiveRecording(page, []);
      await sleep(3000); // the old answer has arrived meanwhile
      assert.equal(await page.locator('#recite-text .w').count(), 0, 'the new recording shows the plain text');
      assert.equal(fake.callsTo('/api/recite/phrase').length, before + 1);
      await H.openEditor(page);
      await H.goTab(page, 'recite');
    });

    for (const [fail, label] of [[500, 'a phrase request fails'], [404, 'an older server (404)'], ['network', 'the network fails']]) {
      await check(`live: when ${label}, Stop sends the whole recording as before, silently`, async () => {
        fake.setLive({ fail: () => fail });
        fake.queueRecite(H.strictResult(LIVE_TEXT, [1]));
        const phrases = fake.callsTo('/api/recite/phrase').length;
        const checks = fake.callsTo('/api/recite/check').length;
        await startLiveRecording(page, [[0.3, 0.8], [1.8, 0.8], [3.3, 0.8]]);
        await waitForCall(fake, '/api/recite/phrase', phrases + 1);
        await waitMic(page, 4.6);
        assert.ok(await page.isHidden('#recite-status.is-error'), 'no error shown');
        const stopAt = await micTime(page);
        await page.click('#recite-rec');
        const call = await waitForCall(fake, '/api/recite/check', checks + 1);
        assert.equal(fake.callsTo('/api/recite/phrase').length, phrases + 1, 'no phrase after a failure');
        assert.ok(!call.form.heard_before, 'no heard_before: the whole recording');
        const sec = wavSeconds(call.form.audio);
        assert.ok(Math.abs(sec - stopAt) < 0.5, `the whole recording: ${sec} s of ${stopAt} s`);
        await page.waitForSelector('#recite-result:not([hidden])');
        assert.equal(await page.locator('#recite-text .w-sub').count(), 1);
      });
    }

    await check('live: no console errors (besides the failures asked for), page errors or external requests', () => {
      const left = problems.filter((p) => !/status of (404|500)|ERR_CONNECTION_REFUSED|net::ERR_FAILED/.test(p));
      assert.deepEqual(left, []);
    });
    await context.close();
  }

  {
    const { context, page, fake, problems } = await livePage(browser, base, { mode: 'contextual' });
    await check('live: by meaning, the phrases are decoded but no word is coloured; Stop sends the tail', async () => {
      fake.setLive({ words: 4 });
      await startLiveRecording(page, [[0.3, 0.8], [1.8, 0.8]]);
      const first = await waitForCall(fake, '/api/recite/phrase', 1);
      assert.equal(first.form.mode.text, 'contextual');
      await waitForCall(fake, '/api/recite/phrase', 2);
      await sleep(300);
      assert.equal(await page.locator('#recite-text .w').count(), 0);
      await page.click('#recite-rec');
      const call = await waitForCall(fake, '/api/recite/check', 1);
      assert.equal(call.form.mode.text, 'contextual');
      assert.equal(call.form.heard_before.text, words.slice(0, 8).join(' '));
      await page.waitForSelector('#recite-result:not([hidden])');
      assert.ok(await page.isVisible('#recite-verdict'));
    });
    assert.deepEqual(problems, []);
    await context.close();
  }

  for (const colorScheme of ['light', 'dark']) {
    const { context, page, fake, problems } = await livePage(browser, base, { lang: 'ar', text: LIVE_TEXT_AR, colorScheme });
    await check(`live: Arabic at 360 px (${colorScheme}): right to left, coloured as the child reads, no horizontal scroll`, async () => {
      fake.setLive({ words: 5 });
      await startLiveRecording(page, [[0.3, 1.0], [2.0, 1.0]]);
      assert.equal((await page.textContent('#recite-status')).trim(), H.uiStrings('ar').live_listening);
      await waitForCall(fake, '/api/recite/phrase', 2);
      await page.waitForFunction(() => document.querySelectorAll('#recite-text .w-match').length === 10);
      assert.equal(await page.getAttribute('#recite-text', 'dir'), 'rtl');
      assert.equal(await page.getAttribute('#recite-text', 'lang'), 'ar');
      const pending = await page.locator('#recite-text .w-pending').count();
      assert.equal(pending, LIVE_TEXT_AR.split(' ').length - 10);
      // The first word read is on the right.
      const [a, b] = await page.evaluate(() => [...document.querySelectorAll('#recite-text .w')].slice(0, 2).map((n) => n.getBoundingClientRect().left));
      assert.ok(a > b, 'right to left');
      const colours = await page.evaluate(() => {
        const cs = (sel) => getComputedStyle(document.querySelector(sel)).color;
        return { match: cs('#recite-text .w-match'), pending: cs('#recite-text .w-pending'), text: getComputedStyle(document.body).color };
      });
      assert.notEqual(colours.pending, colours.match);
      assert.notEqual(colours.pending, colours.text);
      await noHorizontalScroll(page);
      assert.deepEqual(await H.overflowing(page), []);
      await shot(page, `live-ar-360-${colorScheme}`);
      await page.click('#recite-rec');
      await waitForCall(fake, '/api/recite/check', 1);
      await page.waitForSelector('#recite-result:not([hidden])');
    });
    assert.deepEqual(problems, []);
    await context.close();
  }

  {
    const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 });
    await check('live: a server that does not offer it (no live_recite in /api/health) gets the whole recording only', async () => {
      await page.goto(base + '/');
      await startSession(page, { consent: true });
      await confirmPageText(page, LIVE_TEXT);
      await H.goTab(page, 'recite');
      await startLiveRecording(page, [[0.3, 0.8], [1.8, 0.8]]);
      assert.equal((await page.textContent('#recite-status')).trim(), H.uiStrings('en').listening);
      await waitMic(page, 3.4);
      await page.click('#recite-rec');
      const call = await waitForCall(fake, '/api/recite/check', 1);
      assert.equal(fake.callsTo('/api/recite/phrase').length, 0);
      assert.ok(!call.form.heard_before);
    });
    assert.deepEqual(problems, []);
    await context.close();
  }
}

async function arabicFlow(browser, base) {
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 });

  await check('ar: the consent sentence suits a mother as well as a father (UX-13); the text language follows the UI language (UX-1)', async () => {
    await page.goto(base + '/');
    await waitForCall(fake, '/api/health', 1);
    await page.selectOption('#setup-lang', 'ar');
    assert.equal((await page.textContent('label[for="consent"]')).trim(), 'أنا أحد والدَي الأطفال الذين يستخدمون Mommy على هذا الجهاز أو وليّ أمرهم، وأسمح لـ Mommy باستخدام الميكروفون والكاميرا.');
    assert.match(await page.textContent('#consent-extra'), /نسخة مكتوبة مما يقوله الطفل/);
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
    // "Confirm text" asks /api/text/check (mode strict), not /api/dictation/phrases.
    const call = fake.callsTo('/api/text/check').at(-1);
    assert.deepEqual(call.json, { text: QURAN_SAMPLE, lang: 'ar', mode: 'strict' });
    assert.equal(fake.callsTo('/api/dictation/phrases').length, 0);
    const go = page.locator('#prep-confirm-status + .status-action');
    assert.equal((await go.textContent()).trim(), 'الانتقال إلى قسم القرآن الكريم');
    await go.click();
    await page.waitForSelector('#screen-quran:not([hidden])');
    // The Quran section opens on the ayat of the text (quran_range 112:1-4).
    await page.waitForSelector('#quran-text .ayah[data-ayah="4"]');
    assert.equal(await page.inputValue('#quran-surah'), '112');
    assert.deepEqual([await page.inputValue('#quran-from'), await page.inputValue('#quran-to')], ['١', '٤']);
    // Back to the first surah of Juz' Amma (its first ten ayat) for the checks below.
    await page.selectOption('#quran-surah', '78');
    await page.waitForSelector('#quran-text .ayah[data-ayah="10"]');
  });

  await check('ar: score, timer and dictation counter use Arabic-Indic digits; the score line is grammatical (W4, QUR-7, UX-12)', async () => {
    await H.openEditor(page);
    await page.fill('#page-text', AR_TEXT);
    await pressConfirm(page);
    await page.waitForSelector('#prep-next:not([hidden])');
    assert.ok(await page.isHidden('#prep-confirm-status + .status-action'), 'the Quran button went away');
    await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
    await page.click('#recite-rec');
    await page.waitForSelector('#recite-rec[data-state="recording"]');
    await page.waitForFunction(() => document.querySelector('#recite-timer').textContent.trim() !== '');
    const timer = (await page.textContent('#recite-timer')).trim();
    await sleep(400);
    await page.click('#recite-rec');
    assert.match(timer, /^[٠-٩]+ ث$/);
    await page.waitForSelector('#recite-result:not([hidden])');
    assert.equal((await page.textContent('#recite-score')).trim(), 'الكلمات الصحيحة: ٤ من ٦');
    await H.goTab(page, 'dictation');
    await page.click('#btn-dict-start');
    await page.waitForSelector('[data-stage="speak"]:not([hidden])');
    assert.equal((await page.textContent('#dict-counter')).trim(), 'الجزء ١ من ٢');
    // Numbers stored with a status are formatted again when the UI language changes
    // (here the child's language, changed in the parent area).
    await switchLang(page, 'en');
    assert.equal((await page.textContent('#dict-counter')).trim(), 'Part 1 of 2');
    assert.equal((await page.textContent('#recite-score')).trim(), 'Words right: 4 of 6');
    await switchLang(page, 'ar');
    assert.equal((await page.textContent('#recite-score')).trim(), 'الكلمات الصحيحة: ٤ من ٦');
  });

  await check('ar: Quran refusals after reciting and from the dictation voice are localized, without the English server text (W1, UX-2)', async () => {
    fake.refuse('/api/recite/check', true);
    await H.goTab(page, 'recite');
    await record(page, '#recite-rec', 600);
    await page.waitForSelector('#recite-status.is-error');
    assert.equal((await page.textContent('#recite-status')).trim(), AR_QURAN_MSG);
    assert.ok(await page.isVisible('#recite-status + .status-action'));
    fake.refuse('/api/recite/check', false);
    // The voice refuses a phrase of a confirmed text (Quran words the server did not mark
    // as a Quran part): the text is not "from the Quran", so the child is not sent to the
    // Quran section, and the dictation goes on: a grown-up reads that phrase (the safety
    // net), worded in Arabic.
    fake.refuse('/api/tts', true);
    await H.openEditor(page);
    await pressConfirm(page); // a new confirmation starts a new dictation
    await H.goTab(page, 'dictation');
    const before = fake.callsTo('/api/tts').length;
    await page.click('#btn-dict-start');
    await waitForCall(fake, '/api/tts', before + 1);
    await page.waitForSelector('#dict-gu:not([hidden])');
    assert.ok(await page.isVisible('[data-stage="speak"]'));
    assert.equal((await page.textContent('#dict-gu-ask-text')).trim(), 'هيا نطلب من أحد قراءة هذا الجزء بصوت مسموع.');
    assert.equal((await page.textContent('#dict-gu-why')).trim(), 'لا يستطيع الصوت قراءة هذا الجزء. يُرجى إظهار الكلمات وقراءتها بصوت مسموع كما هي مكتوبة، ثم الضغط على «انتهاء القراءة».');
    assert.equal((await page.textContent('#dict-speak-status')).trim(), '');
    assert.equal(await page.locator('#dict-speak-status + .status-action, #dict-intro-status + .status-action').count(), 0);
    await shot(page, 'dictation-voice-refused-ar-360');
    fake.refuse('/api/tts', false);
    await H.goTab(page, 'quran');
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
    assert.equal((await page.textContent('#prep-quran-note')).trim(), 'This page seems to be ayat of the Quran only. Please practise them in the Quran section.');
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
    assert.equal(fake.callsTo('/api/text/check').at(-1).json.lang, 'ar');
    assert.match(await page.textContent('#prep-confirm-status'), /set to Arabic/);
    await page.fill('#page-text', PAGE_TEXT);
    await page.click('#btn-confirm');
    assert.equal((await page.textContent('#prep-confirm-status')).trim(), 'This text is not written in Arabic. Let’s choose the language of the text.');
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
    await page.waitForSelector('#screen-recite:not([hidden])');
    await record(page, '#recite-rec', 600);
    await page.waitForSelector('#recite-text .w-sub');
    await H.openEditor(page);
    await page.check('input[name="mode"][value="contextual"]');
    await H.goTab(page, 'recite');
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
    await H.goTab(page, 'quran');
    await sleep(1400);
    const plays = await page.evaluate(() => window.__plays);
    assert.deepEqual(plays.filter((p) => p.recording), [], 'nothing is played while the child is recording');
    assert.deepEqual(plays.filter((p) => p.screen === '#quran'), [], 'no synthetic voice on the Quran screen');
    fake.setTts(null);
  });

  await check('dictation: Next and Repeat wait while a phrase is prepared, and a double tap cannot skip a phrase (UX-4)', async () => {
    // The sentence (at normal speed) takes a moment to arrive; its words come after it.
    fake.setTts({ delay: (j) => (!j.slow ? 600 : 0), check: (j) => (j.text === 'Phrase two' ? 'failed' : !j.slow ? 'passed' : 'skipped') });
    await H.goTab(page, 'dictation');
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
    // Heard once: Next is free while the words come, slowly, one by one.
    assert.equal((await page.textContent('#dict-speak-status')).trim(), 'Now word by word, slowly…');
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
    await page.waitForSelector('[data-stage="mom"]:not([hidden])');
    fake.setTts(null);
  });

  await check('dictation: an error of "Listen" is shown on the child\'s result card', async () => {
    fake.refuse('/api/tts', true); // the score line cannot be said
    await H.momCheck(page, []);
    await page.click('#dict-listen');
    await page.waitForSelector('#dict-child-status.is-error');
    assert.equal((await page.textContent('#dict-child-status')).trim(), EN_QURAN_MSG);
    fake.refuse('/api/tts', false);
  });

  await check('prepare: a text that starts with the basmala is confirmed with its Quran part, recited word by word and dictated with a grown-up; [?] marks are explained (final verification, Q2)', async () => {
    await H.openEditor(page);
    await page.waitForSelector('#screen-prepare:not([hidden])');
    // A page read with [?] marks: Confirm explains them instead of "Something went wrong".
    await page.selectOption('#page-lang', 'en');
    await page.fill('#page-text', 'The [?] sat on the mat.');
    await page.click('#btn-confirm');
    await page.waitForSelector('#prep-confirm-status.is-error');
    assert.equal((await page.textContent('#prep-confirm-status')).trim(), 'Some words could not be read and are marked [?]. Please type them in place of [?] first.');
    assert.ok(await page.isHidden('#prep-next'));
    // The basmala as a sentence of its own: a Quran part (Q2). The text is confirmed with
    // the note about its Quran words; no English server text, no button to the Quran section.
    await page.selectOption('#page-lang', 'ar');
    await page.fill('#page-text', BASMALA_TEXT);
    await pressConfirm(page);
    await page.waitForSelector('#prep-next:not([hidden])');
    const note = (await page.textContent('#prep-confirm-status')).trim();
    assert.equal(note, EN_CONFIRMED_QURAN);
    assert.ok(!note.includes(QURAN_MESSAGE) && !note.includes(QURAN_MEANING_MESSAGE));
    assert.equal(await page.locator('#prep-confirm-status + .status-action').count(), 0);
    await page.waitForFunction(() => /Surah Al-Faatiha, ayah 1/.test(document.querySelector('#prep-quran').textContent));
    assert.ok(await page.isDisabled('input[name="mode"][value="contextual"]'));
    await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
    assert.equal((await page.textContent('#recite-text')).trim(), BASMALA_TEXT);
    assert.ok(await page.isEnabled('#recite-rec'));
    assert.ok(await page.isVisible('#recite-quran-note'));
    // Dictation is possible: a grown-up reads the basmala (no request before "Start").
    const before = fake.callsTo('/api/dictation/phrases').length;
    await H.goTab(page, 'dictation');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    assert.ok(await page.isEnabled('#btn-dict-start'));
    assert.ok(await page.isHidden(DICT_START_WHY));
    assert.ok(await page.isVisible('#dict-quran-intro'));
    assert.equal(fake.callsTo('/api/dictation/phrases').length, before, 'nothing is asked before "Start the dictation"');
    assert.equal(fake.callsTo('/api/tts').filter((c) => c.json.text.includes('بسم')).length, 0);
    await H.openEditor(page);
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
 * Quran in a school text (docs/CONTRACT.md, hard rule 4: Q1 and Q2), on the fixtures of
 * helpers.quranFixtures (built from the verbatim Tanzil words): "Confirm text" with and
 * without differences from the mushaf and "Use the mushaf text"; Recite word by word
 * only, with feedback that quotes the mushaf shown and never spoken; the dictation with
 * a grown-up step in the middle (a quoted ayah) and at the start (the basmala on its own
 * line), Repeat, keyboard and focus; the voice-refusal safety net; "dictation": false; a
 * text that is Quran (Q1) opening the Quran section on its ayat; the page reader.
 */
async function quranPartsFlow(browser, base) {
  const FX = H.quranFixtures();
  const LESSON = H.fakeQuranAnalysis(FX.LESSON, 'ar');
  const PLAN = LESSON.plan([]);
  const DIFF = H.fakeQuranAnalysis(FX.LESSON_MISREAD, 'ar').parts[0].differences[0];
  const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 });
  await page.goto(base + '/');
  await startSession(page, { consent: true, nickname: 'Lina' });
  const checks = () => fake.callsTo('/api/text/check');
  const ttsTexts = () => fake.callsTo('/api/tts').map((c) => c.json.text);
  const focused = () => page.evaluate(() => document.activeElement && document.activeElement.id);
  const txt = async (sel) => (await page.textContent(sel)).trim();

  /** Type `text` (Arabic) on Prepare and press "Confirm text". */
  async function confirmArabic(t) {
    await H.openEditor(page);
    await page.waitForSelector('#screen-prepare:not([hidden])');
    await page.selectOption('#page-lang', 'ar');
    await page.fill('#page-text', t);
    await pressConfirm(page);
  }

  /** Start the dictation and go to phrase `index` (0-based), answering the grown-up steps on the way. */
  async function dictateTo(index) {
    await H.goTab(page, 'dictation');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    await page.click('#btn-dict-start');
    await page.waitForSelector('[data-stage="speak"]:not([hidden])');
    for (let i = 0; i < index; i++) {
      if (await page.isVisible('#dict-gu')) {
        await page.click('#dict-gu-show');
        await page.click('#dict-gu-done');
      }
      await page.waitForSelector('#dict-next:not([disabled])');
      await page.click('#dict-next');
      await page.waitForFunction((n) => document.querySelector('#dict-counter').textContent.startsWith('Part ' + n + ' '), i + 2);
    }
  }

  await check('Q2: "Confirm text" of a lesson quoting an ayah shows the note and its reference, turns "The meaning" off with the reason and keeps dictation (one /api/text/check)', async () => {
    const n = checks().length;
    await confirmArabic(FX.LESSON);
    await page.waitForSelector('#prep-next:not([hidden])');
    assert.equal(checks().length, n + 1, 'one request answers for every use');
    assert.deepEqual(checks().at(-1).json, { text: FX.LESSON, lang: 'ar', mode: 'strict' });
    assert.equal(fake.callsTo('/api/dictation/phrases').length, 0);
    assert.equal(await txt('#prep-confirm-status'), EN_CONFIRMED_QURAN);
    await page.waitForSelector('#prep-quran:not([hidden])');
    assert.equal(await txt('#prep-quran .qp-title'), 'Words of the Quran in this text');
    await page.waitForFunction(() => document.querySelector('#prep-quran .qp-refs').textContent.trim().startsWith('Surah Al-Baqara, ayah 153 “'));
    // UX-05: which words were taken: the part's first two and last two mushaf words.
    const lessonPart = H.fakeQuranAnalysis(FX.LESSON, 'ar').parts[0];
    assert.equal(await txt('#prep-quran .qp-snippet'), `${lessonPart.uthmani.slice(0, 2).join(' ')} … ${lessonPart.uthmani.slice(-2).join(' ')}`);
    assert.equal(await txt('#prep-quran .qp-note'), 'They are checked word by word against the mushaf, and “The meaning” is not available for this text. In a dictation, the app stops at them and asks a grown-up to read them aloud: its voice never reads the Quran.');
    assert.equal(await page.locator('#prep-quran .qp-diff-list, #prep-quran .qp-use').count(), 0, 'nothing differs from the mushaf');
    assert.ok(await page.isDisabled('input[name="mode"][value="contextual"]'), '"The meaning" is off');
    assert.ok(await page.isChecked('input[name="mode"][value="strict"]'));
    assert.equal(await txt('#mode-meaning-why'), EN_MEANING_OFF);
    await page.click('#prep-next [data-go="dictation"]');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    assert.ok(await page.isEnabled('#btn-dict-start'), 'a text that includes Quran can be dictated');
    assert.ok(await page.isHidden(DICT_START_WHY));
    // (Redesign) Worded for the child: someone reads the Quran words; the rest goes on.
    assert.equal(await txt('#dict-quran-child'), 'This text has words of the Quran: when we reach them, let’s ask someone to read them aloud.');
    assert.equal(await txt('#dict-quran-intro'), 'The app’s voice never reads the Quran: someone reads those words, the whole part first, then word by word. The rest goes on as usual.');
  });

  await check('Q2: a misread ayah lists the typed word and the mushaf word; "Use the mushaf text" puts the mushaf words in and confirms again', async () => {
    await confirmArabic(FX.LESSON_MISREAD);
    await page.waitForSelector('#prep-quran .qp-diff-list');
    assert.equal(await txt('#prep-confirm-status'), EN_CONFIRMED_QURAN, 'the text is confirmed; the checks use the mushaf words');
    assert.equal(await txt('#prep-quran .qp-diff-title'), 'Typed differently from the mushaf:');
    assert.equal(await txt('#prep-quran .qp-diff-list'), `typed “${FX.MISREAD_TYPED}”, in the mushaf “${DIFF.mushaf_clean}” (${DIFF.mushaf})`);
    // UX-05: the changed letter is marked in the typed word and in the mushaf word.
    assert.deepEqual(await page.$$eval('#prep-quran .qp-diff-list mark', (ms) => ms.map((m) => m.textContent)), ['ض', 'ص']);
    assert.equal(await page.getAttribute('#prep-quran .qp-mushaf', 'lang'), 'ar');
    assert.match(await txt('#prep-quran .qp-diffs .hint'), /^Vowel marks and the spelling of the mushaf do not count as differences\./);
    assert.equal(await txt('#prep-quran .qp-use'), 'Use the mushaf text');
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.smallTargets(page), []);
    const n = checks().length;
    await page.click('#prep-quran .qp-use');
    await waitForCall(fake, '/api/text/check', n + 1);
    await page.waitForSelector('#prep-quran .qp-done');
    assert.equal(await page.inputValue('#page-text'), FX.LESSON, 'the mushaf words are in the text, nothing else changed');
    assert.deepEqual(checks().at(-1).json, { text: FX.LESSON, lang: 'ar', mode: 'strict' }, 'checked again');
    assert.equal(await txt('#prep-quran .qp-done'), 'The words of the mushaf were put into the text.');
    assert.equal(await page.locator('#prep-quran .qp-diff-list').count(), 0);
    assert.equal(await focused(), 'prep-quran');
    assert.ok(await page.isVisible('#prep-next'));
  });

  await check('UX-03: a text confirmed with a misquote is shown to the child with the mushaf words (the check expects them)', async () => {
    await confirmArabic(FX.LESSON_MISREAD);
    await page.waitForSelector('#prep-quran .qp-diff-list');
    await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
    await page.waitForSelector('#recite-main:not([hidden])');
    assert.equal(await page.textContent('#recite-text'), FX.LESSON, 'the reading card shows the mushaf words');
    assert.ok(!(await page.textContent('#recite-text')).includes(FX.MISREAD_TYPED));
    await H.openEditor(page);
    assert.equal(await page.inputValue('#page-text'), FX.LESSON_MISREAD, 'the typed text stays in the grown-up\'s box');
  });

  await check('Q2: a dropped word is listed as missing, and the mushaf text puts it back', async () => {
    await confirmArabic(FX.LESSON_DROPPED);
    await page.waitForSelector('#prep-quran .qp-diff-list');
    const del = H.fakeQuranAnalysis(FX.LESSON_DROPPED, 'ar').parts[0].differences[0];
    assert.equal(del.op, 'del');
    const delPart = H.fakeQuranAnalysis(FX.LESSON_DROPPED, 'ar').parts[0];
    assert.equal(await txt('#prep-quran .qp-diff-list'), del.index > 0 ? `missing word after “${delPart.clean[del.index - 1]}”: “${del.mushaf}”` : `missing word: “${del.mushaf}”`);
    await page.click('#prep-quran .qp-use');
    await page.waitForSelector('#prep-quran .qp-done');
    assert.equal(await page.inputValue('#page-text'), FX.LESSON);
  });

  await check('Q2 recite: word by word only, the note for the grown-up, and feedback quoting the mushaf is shown but never spoken', async () => {
    await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
    await page.waitForSelector('#recite-main:not([hidden])');
    assert.match(await txt('#recite-mode-label'), /Word by word/);
    assert.ok(await page.isVisible('#recite-quran-note'));
    assert.equal(await txt('#recite-quran-note'), 'Some words here are from the Quran: they are checked word by word, as they are written in the Quran.');
    // A mistake in the Quran part: the fixed template, quoting the mushaf word.
    const part = LESSON.parts[0];
    const quoting = `في الآية الكريمة كلمة تحتاج إلى انتباه: «${part.clean_display[6]}». هيا نقرؤها مرة أخرى.`;
    fake.queueRecite(H.quranStrictResult(FX.LESSON, [part.exp_start + 6], quoting, true));
    const tts0 = fake.callsTo('/api/tts').length;
    const plays0 = (await page.evaluate(() => window.__plays.length));
    let before = fake.callsTo('/api/recite/check').length;
    await record(page, '#recite-rec', 500);
    const call = await waitForCall(fake, '/api/recite/check', before + 1);
    assert.equal(call.form.mode.text, 'strict');
    assert.equal(call.form.expected_text.text, FX.LESSON, 'the text as typed: the server finds the parts itself');
    await page.waitForSelector('#recite-result:not([hidden])');
    assert.equal(await txt('#recite-feedback'), quoting);
    assert.ok(await page.isHidden('#recite-listen'), 'no "Listen" for feedback that quotes the Quran');
    assert.equal(await txt('#recite-fb-quran'), 'This message quotes the Quran, so it is shown and not spoken.');
    await sleep(400);
    assert.equal(fake.callsTo('/api/tts').length, tts0, 'the feedback was not sent to the voice');
    assert.equal(await page.evaluate(() => window.__plays.length), plays0, 'nothing was played');
    // A mistake outside the parts: ordinary feedback, spoken as usual.
    fake.queueRecite(H.quranStrictResult(FX.LESSON, [1], 'Almost! Look again at the second word.', false));
    before = fake.callsTo('/api/recite/check').length;
    await record(page, '#recite-rec', 500);
    await waitForCall(fake, '/api/recite/check', before + 1);
    await waitForTts(fake, 'Almost! Look again at the second word.');
    assert.ok(await page.isVisible('#recite-listen'));
    assert.ok(await page.isHidden('#recite-fb-quran'));
    // "The meaning" stays off on Prepare for this text.
    await H.openEditor(page);
    assert.ok(await page.isDisabled('input[name="mode"][value="contextual"]'));
  });

  await check('Q2 dictation: the voice reads the phrases around the quote; a grown-up shows, reads and hides each chunk; Repeat asks the grown-up again; /api/tts never gets a chunk', async () => {
    assert.deepEqual(PLAN.readers, ['voice', 'voice', 'grown_up', 'grown_up', 'voice']);
    const n0 = fake.callsTo('/api/dictation/phrases').length;
    await dictateTo(0);
    const ph = await waitForCall(fake, '/api/dictation/phrases', n0 + 1);
    assert.deepEqual(ph.json, { text: FX.LESSON, lang: 'ar' });
    assert.equal(await txt('#dict-counter'), 'Part 1 of 5');
    assert.ok(await page.isHidden('#dict-gu'));
    await waitForTts(fake, PLAN.phrases[0]);
    await page.waitForSelector('#dict-next:not([disabled])');
    await page.click('#dict-next');
    await waitForTts(fake, PLAN.phrases[1]);
    await page.waitForSelector('#dict-next:not([disabled])');
    // Phrase 3: a chunk of the ayah. No voice: a grown-up is asked.
    const ttsBefore = ttsTexts().length;
    await page.click('#dict-next');
    await page.waitForSelector('#dict-gu:not([hidden])');
    assert.equal(await txt('#dict-counter'), 'Part 3 of 5');
    assert.equal(await txt('#dict-gu-ask-text'), 'Let’s ask someone to read this part aloud.');
    assert.equal(await txt('#dict-gu-why'), 'This part is from the Quran, and the app’s voice never reads the Quran. Please show the words where only you can see them, read the whole part aloud once, then word by word, slowly, with time to write each word; then press “Done reading”: the words are hidden again. If nobody can read it now, “Next” goes on.');
    assert.equal(await txt('#dict-gu-show'), 'Show the words of the Quran');
    assert.doesNotMatch(await page.getAttribute('#dict-gu-show', 'class'), /btn-primary/, 'an outline button: the child\'s eye goes to the ask line');
    // UX-04: a child who cannot read yet hears the ask line once (no Quran word in it).
    await waitForTts(fake, 'Let’s ask someone to read this part aloud.');
    assert.deepEqual(fake.ttsFor('Let’s ask someone to read this part aloud.')[0].json, { text: 'Let’s ask someone to read this part aloud.', lang: 'en', slow: false });
    assert.equal(await focused(), 'dict-gu-show', 'focus goes to the grown-up\'s button');
    assert.equal(await page.getAttribute('#dict-gu-show', 'aria-expanded'), 'false');
    assert.equal(await page.getAttribute('#dict-gu-ask-text', 'aria-live'), 'polite');
    assert.ok(await page.isHidden('#dict-gu-reveal'));
    assert.equal(await page.textContent('#dict-gu-text'), '', 'the words are not in the page before the tap');
    assert.ok(await page.isEnabled('#dict-next'), '(redesign) the app asks, and never blocks the rest');
    assert.ok(await page.isEnabled('#dict-repeat'));
    assert.ok(await page.isHidden('#dict-show'), 'no "Show the words" for the voice here');
    // Keyboard: Enter on the focused button shows the vowelled mushaf text, large.
    await page.keyboard.press('Enter');
    await page.waitForSelector('#dict-gu-reveal:not([hidden])');
    assert.equal(await page.textContent('#dict-gu-text'), PLAN.read_text[2], 'verbatim Uthmani text from the server');
    assert.match(await page.getAttribute('#dict-gu-text', 'class'), /quran-text/);
    assert.equal(await page.getAttribute('#dict-gu-text', 'lang'), 'ar');
    assert.equal(await page.getAttribute('#dict-gu-text', 'dir'), 'rtl');
    assert.equal(await txt('#dict-gu-source'), 'Hafs – Tanzil');
    assert.equal(await page.getAttribute('#dict-gu-show', 'aria-expanded'), 'true');
    assert.equal(await focused(), 'dict-gu-done');
    const size = await page.$eval('#dict-gu-text', (n) => parseFloat(getComputedStyle(n).fontSize));
    assert.ok(size >= 28, 'large text: ' + size);
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.overflowing(page), []);
    // "Done reading": hidden again (and out of the page), Next is free and focused.
    await page.keyboard.press('Enter');
    await page.waitForSelector('#dict-gu-reveal', { state: 'hidden' });
    assert.equal(await page.textContent('#dict-gu-text'), '');
    assert.equal(await txt('#dict-gu-ask-text'), 'Now let’s write it, then press “Next”.');
    assert.ok(await page.isEnabled('#dict-next'));
    assert.equal(await focused(), 'dict-next');
    // Repeat on a Quran chunk asks the grown-up again; it never calls the voice.
    const ttsAtRepeat = ttsTexts().length;
    await page.click('#dict-repeat');
    assert.equal(ttsTexts().length, ttsAtRepeat, 'Repeat never calls the voice');
    assert.equal(await txt('#dict-gu-ask-text'), 'Let’s ask them to read it again.');
    assert.ok(await page.isVisible('#dict-gu-show'));
    assert.ok(await page.isEnabled('#dict-next'));
    assert.equal(await focused(), 'dict-gu-show');
    await page.click('#dict-gu-show');
    await page.click('#dict-gu-done');
    // Phrase 4: the second chunk; then phrase 5: the voice again.
    await page.click('#dict-next');
    await page.waitForFunction(() => document.querySelector('#dict-counter').textContent.trim() === 'Part 4 of 5');
    assert.ok(await page.isVisible('#dict-gu'));
    assert.equal(await txt('#dict-gu-ask-text'), 'Let’s ask someone to read this part aloud.');
    await page.click('#dict-gu-show');
    assert.equal(await page.textContent('#dict-gu-text'), PLAN.read_text[3]);
    await page.click('#dict-gu-done');
    await page.click('#dict-next');
    await page.waitForFunction(() => document.querySelector('#dict-counter').textContent.trim() === 'Part 5 of 5');
    assert.ok(await page.isHidden('#dict-gu'));
    await waitForTts(fake, PLAN.phrases[4]);
    for (const i of [2, 3]) {
      assert.equal(fake.ttsFor(PLAN.phrases[i]).length, 0, 'never sent to the voice: ' + PLAN.phrases[i]);
      assert.equal(fake.ttsFor(PLAN.read_text[i]).length, 0);
    }
    const lastWords = PLAN.phrases[4].split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
    assert.ok(ttsTexts().slice(ttsBefore).every((t) => t === PLAN.phrases[4] || lastWords.includes(t) || t === 'Let’s ask someone to read this part aloud.'), 'only the last phrase, its words (and the ask line) were asked of the voice meanwhile');
    assert.equal(fake.ttsFor('Let’s ask someone to read this part aloud.').length, 1, 'the ask line is fetched once, then said from memory');
    await page.waitForSelector('#dict-next:not([disabled])');
    await page.click('#dict-next');
    await page.waitForSelector('[data-stage="mom"]:not([hidden])');
  });

  await check('Q2 dictation (owner\'s decision): "Mom\'s check" shows the Quran part in its mushaf form (verbatim, RTL, the Quran font); a word marked there is shown with its mushaf spelling, and only the score is spoken', async () => {
    const quranWords = PLAN.read_text[2].split(/\s+/).concat(PLAN.read_text[3].split(/\s+/)).filter(Boolean);
    const shown = await page.$$eval('#dict-mom-words .mom-word.is-quran', (b) => b.map((x) => x.textContent));
    assert.equal(shown.join(' ').replace(/\s+/g, ' '), quranWords.join(' '), 'the vowelled mushaf words, verbatim (a pause mark with its word)');
    assert.equal(await page.getAttribute('#dict-mom-words .mom-word.is-quran >> nth=0', 'dir'), 'rtl');
    assert.equal(await page.getAttribute('#dict-mom-words', 'dir'), 'rtl');
    await page.click('#dict-mom-words .mom-word.is-quran >> nth=1');
    const tts0 = fake.callsTo('/api/tts').length;
    await page.click('#dict-mom-done');
    await page.waitForSelector('[data-stage="child"]:not([hidden])');
    assert.equal(await page.locator('#dict-child-words .w-fix.is-quran').count(), 1);
    assert.equal(await txt('#dict-child-words .w-fix .w-exp'), shown[1]);
    const n = await page.locator('#dict-child-words .w').count();
    assert.equal(await txt('#dict-child-feedback'), `${n - 1} of ${n} words right. Well done for writing it all!`);
    const spoken = await waitForCall(fake, '/api/tts', tts0 + 1);
    assert.equal(spoken.json.text, `${n - 1} of ${n} words right. Well done for writing it all!`, 'only the score line, no word of the Quran');
    assert.equal(fake.callsTo('/api/dictation/check').length, 0);
  });

  await check('Q2 dictation: the basmala on a line of its own starts with the grown-up step (no voice for it)', async () => {
    await confirmArabic(BASMALA_LINE_TEXT);
    await page.waitForSelector('#prep-next:not([hidden])');
    assert.equal(await txt('#prep-confirm-status'), EN_CONFIRMED_QURAN);
    const plan = H.fakeQuranAnalysis(BASMALA_LINE_TEXT, 'ar').plan([]);
    assert.deepEqual(plan.readers, ['grown_up', 'voice']);
    // (Redesign) For a child of 6 to 9, a sentence for the voice has at most 4 words: the
    // six words of the second line are said as two short sentences of three.
    const halves = plan.phrases[1].split(/\s+/);
    const short = [halves.slice(0, 3).join(' '), halves.slice(3).join(' ')];
    await dictateTo(0);
    await page.waitForSelector('#dict-gu:not([hidden])');
    assert.equal(await txt('#dict-counter'), 'Part 1 of 3');
    assert.equal(await focused(), 'dict-gu-show');
    assert.ok(await page.isEnabled('#dict-next'));
    await page.keyboard.press('Enter');
    assert.equal(await page.textContent('#dict-gu-text'), plan.read_text[0]);
    await page.keyboard.press('Enter');
    assert.equal(fake.ttsFor(plan.phrases[0]).length, 0, 'the basmala never reached the voice');
    assert.equal(fake.callsTo('/api/tts').filter((c) => c.json.text.includes('بسم')).length, 0);
    await page.click('#dict-next');
    await waitForTts(fake, short[0]);
    assert.equal(fake.ttsFor(plan.phrases[1]).length, 0, 'never the long sentence');
    await page.waitForSelector('#dict-next:not([disabled])');
    await page.click('#dict-next');
    await waitForTts(fake, short[1]);
    assert.equal(await txt('#dict-next-label'), "I've finished");
    await page.waitForSelector('#dict-next:not([disabled])');
    await page.click('#dict-next');
    await page.waitForSelector('[data-stage="mom"]:not([hidden])');
    // The basmala is in the check in its mushaf form.
    assert.equal(await txt('#dict-mom-words .mom-word.is-quran >> nth=0'), plan.read_text[0].split(/\s+/)[0]);
  });

  await check('safety net: a phrase the voice refuses as Quran becomes a grown-up step (the words as written), and the dictation goes on', async () => {
    const refusedPhrase = PLAN.phrases[4];
    const asked = fake.ttsFor(refusedPhrase).length; // the voice read it in the dictation above
    fake.setTts({ refuse: (j) => j.text === refusedPhrase });
    await confirmArabic(FX.LESSON);
    await dictateTo(4);
    await page.waitForSelector('#dict-gu:not([hidden])');
    assert.equal(await txt('#dict-counter'), 'Part 5 of 5');
    assert.equal(await txt('#dict-gu-why'), 'The voice cannot read this part. Please show the words, read them aloud as they are written, then press “Done reading”.');
    assert.equal(await txt('#dict-gu-show'), 'Show the words');
    await page.click('#dict-gu-show');
    assert.equal(await txt('#dict-gu-text'), refusedPhrase, 'the phrase as written (there is no mushaf text for it)');
    assert.doesNotMatch(await page.getAttribute('#dict-gu-text', 'class'), /quran-text/);
    assert.ok(await page.isHidden('#dict-gu-source'));
    assert.equal(fake.ttsFor(refusedPhrase).length, asked + 1, 'asked of the voice once (while it was fetched ahead)');
    await page.click('#dict-gu-done');
    assert.equal(await txt('#dict-gu-ask-text'), "Now let’s write it, then press “I've finished”.");
    await page.click('#dict-repeat');
    assert.equal(fake.ttsFor(refusedPhrase).length, asked + 1, 'Repeat does not ask the voice again');
    await page.click('#dict-gu-show');
    await page.click('#dict-gu-done');
    await page.click('#dict-next');
    await page.waitForSelector('[data-stage="mom"]:not([hidden])');
    assert.ok(await page.isHidden(DICT_START_WHY));
    fake.setTts(null);
  });

  await check('safety net: "dictation": false at "Confirm text" rules out the dictation, with the reason next to the disabled button', async () => {
    fake.setUnmarked((t) => t === FX.LESSON);
    await confirmArabic(FX.LESSON);
    await page.waitForSelector('#prep-next:not([hidden])');
    assert.equal(await txt('#prep-confirm-status'), 'Saved for reading aloud. It cannot be used for a dictation: the voice found words of the Quran in it that the app could not mark.');
    await page.click('#prep-next [data-go="dictation"]');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    assert.ok(await page.isDisabled('#btn-dict-start'));
    assert.equal(await txt(DICT_START_WHY), EN_UNMARKED_MSG);
    // The same answer from /api/dictation/phrases for a text confirmed while the server
    // was out of reach is a Quran refusal (the text was never checked).
    fake.setUnmarked(null);
    await confirmArabic(FX.LESSON);
    await page.click('#prep-next [data-go="dictation"]');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    assert.ok(await page.isEnabled('#btn-dict-start'));
    fake.setUnmarked((t) => t === FX.LESSON);
    await page.click('#btn-dict-start');
    await page.waitForSelector('#btn-dict-start[disabled]:not([data-busy])');
    assert.equal(await txt(DICT_START_WHY), EN_UNMARKED_MSG, 'a checked text: the safety net, not "this text is from the Quran"');
    assert.equal(await txt('#dict-intro-status'), '');
    fake.setUnmarked(null);
  });

  await check('Q1: a text that is Quran is refused at "Confirm text"; its button opens the Quran section on its ayat (quran_range)', async () => {
    await confirmArabic(FX.Q1_FRAMED);
    await page.waitForSelector('#prep-confirm-status.is-error');
    assert.equal(await txt('#prep-confirm-status'), EN_QURAN_MSG);
    assert.ok(await page.isHidden('#prep-next'));
    assert.ok(await page.isHidden('#prep-quran'));
    const n = fake.callsTo('/api/quran/ayat').length;
    await page.click('#prep-confirm-status + .status-action');
    await page.waitForSelector('#screen-quran:not([hidden])');
    const call = await waitForCall(fake, '/api/quran/ayat', n + 1);
    assert.deepEqual([call.query.get('surah'), call.query.get('from'), call.query.get('to')], ['112', '1', '4']);
    await page.waitForSelector('#quran-text .ayah[data-ayah="4"]');
    assert.equal(await page.inputValue('#quran-surah'), '112');
    assert.deepEqual([await page.inputValue('#quran-from'), await page.inputValue('#quran-to')], ['1', '4']);
  });

  await check('page reader: a school page that includes Quran is read as usual, with its parts and differences ("Use the mushaf text", also for a [?] in an ayah); a page that is Quran keeps "page_has_quran" with its range', async () => {
    const tinyPng = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 30;
      return c.toDataURL('image/png').split(',')[1];
    });
    await H.openEditor(page);
    fake.setPageRead({ text: FX.LESSON_MISREAD, lang: 'ar', notes: '', source: 'claude', needs_manual: false, contains_quran: true });
    await page.setInputFiles('#prep-choose', { name: 'p.png', mimeType: 'image/png', buffer: Buffer.from(tinyPng, 'base64') });
    await page.waitForFunction((t) => document.querySelector('#page-text').value === t, FX.LESSON_MISREAD);
    assert.equal(await txt('#prep-quran-note'), '', 'the server decides: a school page, not a Quran page');
    await page.waitForSelector('#prep-quran .qp-diff-list');
    assert.equal(await txt('#prep-quran .qp-diff-list'), `typed “${FX.MISREAD_TYPED}”, in the mushaf “${DIFF.mushaf_clean}” (${DIFF.mushaf})`);
    await page.click('#prep-quran .qp-use');
    await page.waitForSelector('#prep-quran .qp-done');
    assert.equal(await page.inputValue('#page-text'), FX.LESSON);
    assert.equal(await txt('#prep-confirm-status'), EN_CONFIRMED_QURAN);
    // A word the reader could not read inside the ayah ([?]): "Confirm text" asks for
    // it first, and "Use the mushaf text" puts the mushaf word in place of the mark.
    fake.setPageRead({ text: FX.LESSON_UNREAD, lang: 'ar', notes: '', source: 'claude', needs_manual: false, contains_quran: false });
    await page.setInputFiles('#prep-choose', { name: 'p.png', mimeType: 'image/png', buffer: Buffer.from(tinyPng, 'base64') });
    await page.waitForFunction((t) => document.querySelector('#page-text').value === t, FX.LESSON_UNREAD);
    await page.waitForSelector('#prep-quran .qp-diff-list');
    const unread = H.fakeQuranAnalysis(FX.LESSON_UNREAD, 'ar').parts[0].differences[0];
    const unreadPart = H.fakeQuranAnalysis(FX.LESSON_UNREAD, 'ar').parts[0];
    assert.equal(await txt('#prep-quran .qp-diff-list'), unread.index > 0 ? `missing word after “${unreadPart.clean[unread.index - 1]}”: “${unread.mushaf}”` : `missing word: “${unread.mushaf}”`);
    await page.click('#btn-confirm');
    await page.waitForSelector('#prep-confirm-status.is-error');
    assert.equal(await txt('#prep-confirm-status'), 'Some words could not be read and are marked [?]. Please type them in place of [?] first.');
    assert.ok(await page.isVisible('#prep-quran .qp-use'), 'the mushaf text can still fill the mark');
    await page.click('#prep-quran .qp-use');
    await page.waitForSelector('#prep-quran .qp-done');
    assert.equal(await page.inputValue('#page-text'), FX.LESSON);
    assert.equal(await txt('#prep-confirm-status'), EN_CONFIRMED_QURAN);
    // A page that is Quran (Q1), even when the reader did not say so.
    fake.setPageRead({ text: FX.Q1_SAMPLE, lang: 'ar', notes: '', source: 'claude', needs_manual: false, contains_quran: false });
    await page.setInputFiles('#prep-choose', { name: 'p.png', mimeType: 'image/png', buffer: Buffer.from(tinyPng, 'base64') });
    await page.waitForSelector('#prep-quran-note:not(:empty)');
    assert.equal(await txt('#prep-quran-note'), 'This page seems to be ayat of the Quran only. Please practise them in the Quran section.');
    assert.ok(await page.isHidden('#prep-quran'));
    fake.setPageRead(null);
    const n = fake.callsTo('/api/quran/ayat').length;
    await page.click('#prep-quran-note + .status-action');
    const call = await waitForCall(fake, '/api/quran/ayat', n + 1);
    assert.deepEqual([call.query.get('surah'), call.query.get('from'), call.query.get('to')], ['112', '1', '4']);
  });

  await check('Q1/Q2 flow: no console errors (besides the refusals asked for), page errors or external requests', async () => {
    assert.deepEqual(expected4xx(problems), []);
  });
  await context.close();
}

/**
 * The Q2 screens in English, French and Arabic at 360 px (and Arabic in dark mode): the
 * note of "Confirm text" with a difference, and the grown-up step of the dictation
 * (asked, then the words shown). Each is checked for its wording, overflow and touch
 * targets, and saved as a screenshot with MOMMY_SHOTS_DIR.
 */
async function quranPartsLanguages(browser, base) {
  const FX = H.quranFixtures();
  const PLAN = H.fakeQuranAnalysis(FX.LESSON, 'ar').plan([]);
  const WORDS = {
    en: { ask: 'Let’s ask someone to read this part aloud.', title: 'Words of the Quran in this text', counter: 'Part 3 of 5', show: 'Show the words of the Quran', done: 'Done reading' },
    fr: { ask: 'Demandons à quelqu’un de lire ce morceau à voix haute.', title: 'Des mots du Coran dans ce texte', counter: 'Morceau 3 sur 5', show: 'Montrer les mots du Coran', done: 'Lecture terminée' },
    ar: { ask: 'هيا نطلب من أحد قراءة هذا الجزء بصوت مسموع.', title: 'كلمات من القرآن الكريم في هذا النص', counter: 'الجزء ٣ من ٥', show: 'إظهار كلمات القرآن الكريم', done: 'انتهاء القراءة' },
  };
  for (const [lang, scheme] of [['en', 'light'], ['fr', 'light'], ['ar', 'light'], ['ar', 'dark']]) {
    const w = WORDS[lang];
    const tag = lang + (scheme === 'dark' ? '-dark' : '') + '-360';
    const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 }, null, { colorScheme: scheme });
    await check(`${tag}: the Q2 note of "Confirm text" and the grown-up step of the dictation, worded in the language, without overflow`, async () => {
      await page.goto(base + '/');
      await H.setupFamily(page, { lang, childLang: lang, consent: true, nickname: lang === 'ar' ? 'سلمى' : 'Lina' });
      assert.equal(await page.getAttribute('html', 'dir'), lang === 'ar' ? 'rtl' : 'ltr');
      await H.openEditor(page);
      await page.selectOption('#page-lang', 'ar');
      await page.fill('#page-text', FX.LESSON_MISREAD);
      await pressConfirm(page);
      await page.waitForSelector('#prep-quran .qp-diff-list');
      if (lang !== 'ar') await page.waitForFunction(() => document.querySelector('#prep-quran .qp-refs').textContent.includes('Al-Baqara'));
      assert.equal((await page.textContent('#prep-quran .qp-title')).trim(), w.title);
      if (lang === 'ar') {
        await page.waitForFunction(() => document.querySelector('#prep-quran .qp-refs').textContent.trim().startsWith('سورة البقرة، الآية ١٥٣ «'));
        assert.doesNotMatch(await page.textContent('#prep-quran .qp-refs'), /[0-9]/, 'Arabic-Indic digits');
      }
      await H.noHorizontalScroll(page);
      assert.deepEqual(await H.overflowing(page), []);
      assert.deepEqual(await H.smallTargets(page), []);
      await H.shot(page, `quran-confirm-note-${tag}`);
      await page.click('#prep-next [data-go="dictation"]');
      await page.waitForSelector('#screen-dictation:not([hidden])');
      assert.ok(await page.isVisible('#dict-quran-intro'));
      await page.click('#btn-dict-start');
      await page.waitForSelector('[data-stage="speak"]:not([hidden])');
      for (let i = 0; i < 2; i++) {
        await page.waitForSelector('#dict-next:not([disabled])');
        await page.click('#dict-next');
      }
      await page.waitForSelector('#dict-gu:not([hidden])');
      assert.equal((await page.textContent('#dict-counter')).trim(), w.counter);
      assert.equal((await page.textContent('#dict-gu-ask-text')).trim(), w.ask);
      assert.equal((await page.textContent('#dict-gu-show')).trim(), w.show);
      await H.noHorizontalScroll(page);
      assert.deepEqual(await H.overflowing(page), []);
      assert.deepEqual(await H.smallTargets(page), []);
      await H.shot(page, `quran-grownup-ask-${tag}`);
      await page.click('#dict-gu-show');
      assert.equal(await page.textContent('#dict-gu-text'), PLAN.read_text[2]);
      assert.equal((await page.textContent('#dict-gu-done')).trim(), w.done);
      await H.noHorizontalScroll(page);
      assert.deepEqual(await H.overflowing(page), []);
      assert.deepEqual(await H.smallTargets(page), []);
      await H.shot(page, `quran-grownup-show-${tag}`);
      // (Owner's decision) Then "Mom's check" and the child's result, in the language.
      await page.click('#dict-gu-done');
      await H.dictateAll(page);
      assert.equal(await page.getAttribute('#dict-mom-words', 'dir'), 'rtl', 'the Arabic text, right to left');
      await page.click('#dict-mom-words .mom-word >> nth=1');
      await H.noHorizontalScroll(page);
      assert.deepEqual(await H.overflowing(page), []);
      assert.deepEqual(await H.smallTargets(page), []);
      await H.shot(page, `dictation-mom-${tag}`);
      await page.click('#dict-mom-done');
      await page.waitForSelector('[data-stage="child"]:not([hidden])');
      if (lang === 'ar') assert.doesNotMatch(await page.textContent('#dict-child-feedback'), /[0-9]/, 'Arabic-Indic digits');
      await H.noHorizontalScroll(page);
      assert.deepEqual(await H.overflowing(page), []);
      await H.shot(page, `dictation-result-${tag}`);
      for (const i of [2, 3]) assert.equal(fake.ttsFor(PLAN.phrases[i]).length, 0);
      assert.deepEqual(problems, []);
    });
    await context.close();
  }
}

/**
 * The fake's Quran parts (helpers.fakeQuranAnalysis) against the server's own finder
 * (backend guard.find_quran_parts), on every fixture: the same parts (offsets, references,
 * mushaf words, differences, replacement, chunks, expected range), the same mushaf
 * text, the same decision for a text that is Quran with its range, and the same
 * dictation plan. Skipped when the backend's Python is not there.
 */
function fakeMatchesServer() {
  if (!fs.existsSync(PYTHON)) {
    console.log('       (skipped: no backend Python)');
    return;
  }
  const fixtures = H.quranFixtures();
  delete fixtures.MISREAD_TYPED;
  const code = [
    'import sys, json',
    'sys.path.insert(0, sys.argv[1])',
    'from pathlib import Path',
    'from mommy.quran import Quran',
    'from mommy.guard import find_quran_parts',
    'q = Quran(Path(sys.argv[2]))',
    'out = {}',
    'for k, t in json.load(sys.stdin).items():',
    "    an = find_quran_parts(t, 'ar', q)",
    '    plan = None if an.refused else an.dictation_plan()',
    "    out[k] = {'refused': an.refused, 'range': an.quran_range(), 'parts': an.parts_json(t), 'mushaf_text': an.mushaf_text() if an.parts else t,",
    "              'voice_safe': an.voice_safe, 'plan': None if plan is None or not an.parts else {'phrases': [p['phrase'] for p in plan], 'readers': [p['reader'] for p in plan], 'read_text': [p['read_text'] for p in plan], 'parts': [p['part'] for p in plan]}}",
    'print(json.dumps(out, ensure_ascii=False))',
  ].join('\n');
  const r = spawnSync(PYTHON, ['-c', code, path.join(ROOT, 'backend'), path.join(ROOT, 'data', 'quran')], { input: JSON.stringify(fixtures), encoding: 'utf8' });
  assert.equal(r.status, 0, String(r.stderr));
  const real = JSON.parse(r.stdout);
  for (const [k, t] of Object.entries(fixtures)) {
    const an = H.fakeQuranAnalysis(t, 'ar');
    const plan = an.refused || !an.parts.length ? null : an.plan([]);
    if (plan) delete plan.quran_parts;
    const fake = { refused: an.refused, range: an.range, parts: an.parts, mushaf_text: an.mushafText, voice_safe: an.voiceSafe, plan };
    assert.deepEqual(fake, real[k], 'fixture ' + k);
  }
}

const uiStrings = H.allStrings; // app.js and family.js

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
    assert.match(en, /the words your child got wrong, with the score/);
    // V1: also what goes with them (llm.py: "Language: ... Age band: ...").
    assert.match(en, /The language is sent with each of them, and your child’s age group with the meaning check and the feedback\./);
    await page.selectOption('#setup-lang', 'fr');
    const fr = await page.textContent('#consent-extra');
    assert.match(fr, /une transcription de ce que dit votre enfant/);
    assert.match(fr, /la tranche d'âge de votre enfant/);
    await page.selectOption('#setup-lang', 'ar');
    assert.match(await page.textContent('#consent-extra'), /والفئة العمرية للطفل/);
    await page.selectOption('#setup-lang', 'en');
  });

  await check('consent (owner\'s decision): a dictation needs neither consent: the voice reads it, a grown-up checks the paper in the app, and nothing is sent to be checked or to Claude', async () => {
    await startSession(page, { consent: false, nickname: '' });
    await page.fill('#page-text', PAGE_TEXT);
    await pressConfirm(page);
    await page.click('#prep-next [data-go="dictation"]');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    await page.click('#btn-dict-start');
    await H.dictateAll(page);
    await H.momCheck(page, [5]);
    assert.match(await page.textContent('#dict-child-feedback'), /5 of 6 words right/);
    assert.equal(fake.callsTo('/api/dictation/check').length, 0);
    assert.equal(fake.callsTo('/api/page/read').length, 0);
    assert.deepEqual(problems, []);
  });
  await context.close();
}

/**
 * The privacy texts in the four ways the app runs (local or online, with or without
 * Claude), from the fake /api/health: the consent box of the family setup in en, fr and
 * ar, the family data line next to it, the photo note of Prepare and the "approximate"
 * label of Recite. Online, "nothing leaves this computer" (and every local-only
 * sentence) is never on the page.
 */
async function privacyFlow(browser, base) {
  const LANGS = ['en', 'fr', 'ar'];
  for (const mode of H.PRIVACY_MODES) {
    const { context, page, problems } = await newPage(browser, base, { width: 360, height: 780 }, { health: H.privacyHealth(mode) });
    await check(`privacy, ${mode.name}: the setup's consent box and family data line, in en, fr and ar`, async () => {
      await page.goto(base + '/');
      await page.waitForSelector('#consent-extra:not([hidden])');
      for (const lang of LANGS) {
        const S = H.allStrings(lang);
        await page.selectOption('#setup-lang', lang);
        assert.equal((await page.textContent('#consent-privacy')).trim(), S[mode.privacy], lang);
        assert.equal((await page.textContent('#consent-extra')).trim(), S[mode.extra], lang);
        // (Redesign) A short line, and the whole family data line behind "More".
        assert.equal((await page.textContent('#setup-form .privacy-short')).trim(), S.fam_privacy_short, lang);
        assert.equal((await page.textContent('#setup-more [data-i18n="fam_privacy_line"]')).trim(), S.fam_privacy_line, lang);
        if (mode.online) {
          assert.deepEqual(await H.localSentencesShown(page), [], lang + ': a local-only sentence online');
          assert.match(S[mode.privacy], /Mommy/);
        }
        await H.noHorizontalScroll(page);
      }
      await page.selectOption('#setup-lang', 'en');
    });
    await check(`privacy, ${mode.name}: the photo note of Prepare and the "approximate" label of Recite`, async () => {
      await startSession(page, { consent: true, nickname: 'Sami' });
      const S = H.allStrings('en');
      assert.equal((await page.textContent('#screen-prepare .photo-privacy')).trim(), S[mode.photo]);
      // Without Claude no photo can be sent: the buttons are off, as the consent box says.
      assert.equal(await page.isDisabled('#prep-take'), mode.brain !== 'claude');
      assert.equal((await page.textContent('#recite-approx')).trim(), S[mode.approx]);
      if (mode.online) assert.deepEqual(await H.localSentencesShown(page), []);
      assert.deepEqual(problems, []);
    });
    await context.close();
  }

  // A page that did not come from a loopback host (behind a tunnel that rewrites the
  // Host header, the server cannot tell): online texts, whatever /api/health says.
  const remote = 'http://mommy-test.example';
  const local = H.PRIVACY_MODES[0];
  const { context, page, problems } = await newPage(browser, base, { width: 360, height: 780 }, { health: H.privacyHealth(local) });
  await page.route(remote + '/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/api/')) return route.fallback();
    return route.fulfill({ response: await route.fetch({ url: base + u.pathname + u.search }) });
  });
  await check('privacy: a page loaded from a host that is not a loopback one says the data goes to the server, even if /api/health says "online": false', async () => {
    await page.goto(remote + '/');
    await page.waitForSelector('#consent-extra:not([hidden])');
    for (const lang of LANGS) {
      const S = H.allStrings(lang);
      await page.selectOption('#setup-lang', lang);
      assert.equal((await page.textContent('#consent-privacy')).trim(), S.consent_online_no_photos, lang);
      assert.equal((await page.textContent('#consent-extra')).trim(), S.consent_online_no_ai, lang);
      assert.deepEqual(await H.localSentencesShown(page), [], lang);
    }
    assert.deepEqual(problems.filter((p) => !p.startsWith('external request: ' + remote)), []);
  });
  await context.close();
}

/** The text of a node, trimmed. */
async function textOf(page, sel) {
  return ((await page.textContent(sel)) || '').trim();
}


/**
 * The AI consent (privacy audit P1; the server's part, V6) in the four ways the app runs.
 * The setup's AI box is there only under the Claude notice and needs the general box; the
 * general consent alone never covers Claude. With Claude set up and no AI consent, the
 * photos stay off (reading them needs Claude), with the grown-up's line, while Recite (word
 * by word and by meaning) and the typed dictation check work: they are sent without the
 * field ai_consent, so the server answers with its offline brain (the meaning check is
 * "approximate"). "Confirm text", the dictation's voice and the Quran section work too;
 * without Claude the general consent is enough. The parent's prompt (behind the PIN) then
 * gives the AI consent, and each check carries ai_consent=1.
 */
async function aiConsentFlow(browser, base) {
  const S = H.allStrings('en');
  for (const mode of H.PRIVACY_MODES) {
    const claude = mode.brain === 'claude';
    const where = mode.online ? 'online' : 'local';
    const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 }, { health: H.privacyHealth(mode) });
    await check(`AI consent, ${mode.name}: ${claude ? 'the general consent alone keeps the photos off and sends no check with the AI consent (the server answers offline); Recite, Confirm text, the dictation (voice and Mom\'s check) and the Quran work' : 'the general consent is enough, and no AI box is shown'}`, async () => {
      await page.goto(base + '/');
      await page.waitForSelector('#consent-extra:not([hidden])');
      assert.equal(await page.isVisible('#ai-consent'), claude, 'the AI box stands only under the Claude notice');
      await H.setupFamily(page, { consent: true, aiConsent: false });
      const doc = await H.storedDoc(page);
      assert.ok(doc.parent.consentAt);
      assert.deepEqual([doc.parent.aiConsentAt, doc.parent.aiConsentVersion], [null, null], 'the general consent never sets the AI one');
      await confirmPageText(page, PAGE_TEXT);
      assert.ok(await page.isDisabled('#prep-take'));
      // (Redesign) The editor is the child's: a short line asks for a grown-up's OK.
      assert.equal(await textOf(page, '#why-prep-photo'), claude ? S.consent_needed_ai : S.no_brain);
      // The photo would not go to Claude without the AI consent: the note does not name it.
      assert.equal(await textOf(page, '#screen-prepare .photo-privacy'), S[mode.online ? 'photo_privacy_online' : 'photo_privacy']);
      // The meaning check will be approximate (no Claude for it): said under the mode choice.
      assert.ok(await page.isVisible('#mode-offline-note'));
      await page.click('#prep-next [data-go="recite"]');
      await page.waitForSelector('#screen-recite:not([hidden])');
      assert.ok(await page.isEnabled('#recite-rec'), 'Recite never waits for the AI consent');
      assert.ok(await page.isHidden('#why-recite-rec'));
      await record(page, '#recite-rec', 300);
      const strict = await waitForCall(fake, '/api/recite/check', 1);
      assert.deepEqual(strict.aiConsent, [], 'no AI consent: the field is not sent');
      await page.waitForSelector('#recite-result:not([hidden])');
      // By meaning: the server's offline heuristic, and the "approximate" label says so.
      await H.openEditor(page);
      await page.check('input[name="mode"][value="contextual"]');
      await pressConfirm(page);
      await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
      await page.waitForSelector('#recite-rec:not([disabled])');
      await record(page, '#recite-rec', 300);
      const meaning = await waitForCall(fake, '/api/recite/check', 2);
      assert.equal(meaning.form.mode.text, 'contextual');
      assert.deepEqual(meaning.aiConsent, []);
      await page.waitForSelector('#recite-verdict:not([hidden])');
      assert.ok(await page.isVisible('#recite-approx'));
      assert.equal(await textOf(page, '#recite-approx'), S[mode.approx]);
      if (claude) await H.shot(page, 'ai-consent-recite-offline-360-' + where);
      await H.openEditor(page);
      await page.check('input[name="mode"][value="strict"]');
      await pressConfirm(page);
      // (Owner's decision) The dictation: the voice, then "Mom's check" in the app.
      await H.goTab(page, 'dictation');
      await page.click('#btn-dict-start');
      await H.dictateAll(page);
      await H.momCheck(page, []);
      await H.goTab(page, 'quran');
      await page.waitForSelector('#quran-text .ayah');
      assert.ok(await page.isEnabled('#quran-rec'), 'the Quran section never uses Claude');      await H.goTab(page, 'quran');
      await page.waitForSelector('#quran-text .ayah');
      assert.ok(await page.isEnabled('#quran-rec'), 'the Quran section never uses Claude');
      await record(page, '#quran-rec', 300);
      await waitForCall(fake, '/api/quran/check', 1);
      assert.ok(fake.callsTo('/api/tts').length > 0, 'the dictation voice was used');
      // "Save" checks the text; a saved text opened again is checked in the background too.
      assert.ok(fake.callsTo('/api/text/check').length >= 3, '"Save" checked the text');
      assert.equal(fake.callsTo('/api/recite/check').length, 2);
      assert.equal(fake.callsTo('/api/dictation/check').length, 0);
      assert.equal(fake.callsTo('/api/page/read').length, 0);
      assert.deepEqual(problems, []);
    });
    if (claude) {
      await check(`AI consent, ${mode.name}: (redesign) given once in Settings, under the Claude notice: the photos open, and each check carries ai_consent=1`, async () => {
        await H.openParent(page);
        assert.equal(await page.locator('#ai-prompt').count(), 0, 'no prompt of its own: the consent is in Settings (and the setup) only');
        await H.parentSection(page, 'settings');
        assert.equal(await textOf(page, '#settings-consent-extra'), S.consent_claude);
        assert.equal(await textOf(page, 'label[for="settings-ai-consent"]'), S.consent_ai_label);
        assert.ok(!(await page.isChecked('#settings-ai-consent')));
        await page.check('#settings-ai-consent');
        const d = await H.storedDoc(page);
        assert.ok(d.parent.aiConsentAt);
        assert.equal(d.parent.aiConsentVersion, require(path.join(WEB, 'rewards.js')).AI_CONSENT_VERSION);
        await H.closeParent(page);
        await H.goTab(page, 'recite');
        await page.waitForSelector('#recite-rec:not([disabled])');
        await record(page, '#recite-rec', 300);
        assert.deepEqual((await waitForCall(fake, '/api/recite/check', 3)).aiConsent, ['1']);
        await H.openEditor(page);
        assert.ok(await page.isEnabled('#prep-take'));
        assert.ok(await page.isHidden('#mode-offline-note'), 'Claude judges the meaning now');
        await page.setInputFiles('#prep-choose', { name: 'page.png', mimeType: 'image/png', buffer: tinyPng() });
        assert.deepEqual((await waitForCall(fake, '/api/page/read', 1)).aiConsent, ['1']);
        await page.waitForFunction((t) => document.querySelector('#page-text').value === t, PAGE_TEXT);
        assert.deepEqual(problems, []);
      });
      await check(`AI consent, ${mode.name}: withdrawn in Settings, the next check goes without it at once`, async () => {
        await H.openParent(page);
        await H.parentSection(page, 'settings');
        await page.uncheck('#settings-ai-consent');
        await H.closeParent(page);
        await confirmPageText(page, PAGE_TEXT); // the photo's text, confirmed
        await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
        await page.waitForSelector('#recite-rec:not([disabled])');
        await record(page, '#recite-rec', 300);
        assert.deepEqual((await waitForCall(fake, '/api/recite/check', 4)).aiConsent, []);
        await H.openEditor(page);
        assert.ok(await page.isDisabled('#prep-take'));
        assert.equal(fake.callsTo('/api/page/read').length, 1);
        assert.deepEqual(problems, []);
      });
    }
    await context.close();
  }

  // The owner sets up Claude while the page is open (the server is started again): the
  // page still thinks the brain is offline. Its checks carry no AI consent (none was given
  // under the Claude notice), so the server answers them with its offline brain and nothing
  // goes to Claude; the texts the page shows stay true. After a reload, the Claude notice,
  // its box and the parent's prompt are there, and the checks still go without the field.
  for (const mode of H.PRIVACY_MODES.filter((m) => m.brain !== 'claude')) {
    const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 }, { health: H.privacyHealth(mode) });
    await check(`AI consent, Claude added later while the page is open (${mode.name} at first): the checks go without the AI consent, the server answers offline, and after a reload the consent texts follow`, async () => {
      await page.goto(base + '/');
      await H.setupFamily(page, { consent: true });
      await confirmPageText(page, PAGE_TEXT);
      await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
      await record(page, '#recite-rec', 300);
      await waitForCall(fake, '/api/recite/check', 1);
      await page.waitForSelector('#recite-result:not([hidden])');
      fake.setHealth({ brain: 'claude' });
      await record(page, '#recite-rec', 300);
      const second = await waitForCall(fake, '/api/recite/check', 2);
      assert.deepEqual(second.aiConsent, [], 'no AI consent was ever given: the field is not sent');
      await page.waitForSelector('#recite-result:not([hidden])');
      assert.notEqual(await textOf(page, '#recite-status'), S.ai_not_sent);
      assert.deepEqual(fake.callsTo('/api/recite/check').map((c) => c.aiConsent), [[], []]);
      // A reload reads /api/health again: the Claude notice and its box (unticked), the prompt.
      await page.reload();
      await page.waitForSelector('#screen-who:not([hidden])');
      await H.openParent(page);
      await H.parentSection(page, 'settings');
      assert.equal(await textOf(page, '#settings-consent-extra'), S.consent_claude);
      assert.ok(await page.isVisible('#settings-ai-consent'));
      assert.ok(!(await page.isChecked('#settings-ai-consent')));
      if (mode.online) assert.deepEqual(await H.localSentencesShown(page), []);
      await H.closeParent(page);
      if (await page.isVisible('#screen-who')) await page.click('#who-list .who-btn');
      await page.waitForSelector('#screen-home:not([hidden])');
      await confirmPageText(page, PAGE_TEXT);
      assert.ok(await page.isDisabled('#prep-take'), 'the photos wait for the AI consent');
      await page.click('#prep-next [data-go="recite"]');
    await page.waitForSelector('#screen-recite:not([hidden])');
      await page.waitForSelector('#recite-rec:not([disabled])');
      await record(page, '#recite-rec', 300);
      assert.deepEqual((await waitForCall(fake, '/api/recite/check', 3)).aiConsent, []);
      assert.equal(fake.callsTo('/api/page/read').length, 0);
      assert.deepEqual(problems, []);
    });
    await context.close();
  }
}

/** A small white PNG (a page photo for the fake reader). */
function tinyPng() {
  // 1x1 white pixel.
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
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
    await page.waitForSelector('#screen-recite:not([hidden])');
    await page.click('#recite-rec'); // and never pressed again: the limit stops it
    await waitForCall(fake, '/api/recite/check', 1);
    await page.waitForSelector('#recite-result:not([hidden])');
    assert.ok(await page.isVisible('#recite-limit'));
    assert.equal((await page.textContent('#recite-limit')).trim(), "That's the longest I can listen to (2 minutes).");
    await record(page, '#recite-rec', 300); // stopped by the child: no note
    await waitForCall(fake, '/api/recite/check', 2);
    await page.waitForSelector('#recite-limit', { state: 'hidden' });
    await H.goTab(page, 'quran');
    await page.waitForSelector('#quran-text .ayah[data-ayah="10"]');
    await page.click('#quran-rec');
    await waitForCall(fake, '/api/quran/check', 1);
    await page.waitForSelector('#quran-result:not([hidden])');
    assert.ok(await page.isVisible('#quran-limit'));
    assert.deepEqual(problems, []);
  });
  await context.close();
}

/**
 * French typography (UX-12): a no-break space, never a plain one, before : ; ! ? and
 * inside « », so that no ":" or "«" is left alone at the start or end of a line.
 */
/** The privacy strings: every mode's keys in en, fr and ar, and what each one says. */
function privacyStrings() {
  const KEYS = ['consent_privacy', 'consent_offline', 'consent_claude', 'consent_online', 'consent_online_no_photos', 'consent_online_no_ai', 'photo_privacy', 'photo_privacy_online', 'photo_privacy_claude', 'photo_privacy_online_claude', 'approximate', 'approximate_online', 'fam_privacy_line'];
  for (const lang of ['en', 'fr', 'ar']) {
    const S = H.allStrings(lang);
    for (const key of KEYS) assert.ok(S[key], `${lang}.${key}`);
    for (const mode of H.PRIVACY_MODES) for (const k of ['privacy', 'extra', 'photo', 'approx']) assert.ok(S[mode[k]], `${lang}.${mode[k]}`);
    // Online, the server is named, and no line says that the data stays here.
    for (const key of ['consent_online', 'consent_online_no_photos', 'photo_privacy_online', 'photo_privacy_online_claude']) {
      assert.match(S[key], /Mommy/, `${lang}.${key}`);
      for (const local of H.localOnlySentences()) assert.ok(!S[key].includes(local), `${lang}.${key} holds "${local}"`);
    }
    // Arabic: no word ending in the suffix ـك (it addresses the parent as a man or a woman).
    if (lang === 'ar') {
      for (const key of ['consent_claude', 'consent_online', 'consent_online_no_photos', 'consent_online_no_ai', 'photo_privacy_online', 'photo_privacy_claude', 'photo_privacy_online_claude', 'approximate_online', 'fam_privacy_line']) {
        const words = S[key].replace(/[ً-ْ]/g, '').split(/[\s«»()،؛؟.,:!…]+/u);
        assert.deepEqual(words.filter((w) => /ك$/.test(w)), [], 'ar.' + key);
      }
    }
  }
  const en = H.allStrings('en');
  assert.match(en.consent_online, /voice recordings, the photos and the texts are sent over a secure connection to the Mommy server that runs the app, where they are checked in memory and not kept/);
  assert.doesNotMatch(en.consent_online_no_photos, /photo/, 'without Claude no photo is ever sent');
  assert.match(en.consent_online_no_photos, /voice recordings and the texts are sent over a secure connection/);
  // P3: the family line says what is saved (and where) and what travels with each check.
  // (Redesign) The children's saved texts are part of the list.
  assert.match(en.fam_privacy_line, /^Your family’s list \(children, their texts, tasks, stars, rewards and the PIN\) is saved only in this browser, on this device, /);
  assert.equal(en.fam_privacy_short, 'The family list (children, texts, stars, rewards and the PIN) stays in this browser, on this device.');
  // B-R5: "Save a copy" puts the list in a file (without the PIN), where the browser saves
  // downloads (on an iPhone that may be iCloud Drive): the line says so in each language,
  // naming the button as it is labelled.
  const COPY_IN_LINE = {
    en: / unless a copy is saved with “Save a copy”: the copy is a file, without the PIN, where the browser saves downloads\. /,
    fr: / sauf si une copie est enregistrée avec «\u00a0Enregistrer une copie\u00a0»\u00a0: la copie est alors un fichier, sans le code parent, là où le navigateur enregistre les téléchargements\. /,
    ar: /، ما لم تُحفظ نسخة منها بزرّ «حفظ نسخة»: فتكون النسخة ملفًا، من دون رمز الكبار، في المكان الذي يحفظ فيه المتصفح التنزيلات\. /,
  };
  for (const lang of ['en', 'fr', 'ar']) {
    const S = H.allStrings(lang);
    assert.match(S.fam_privacy_line, COPY_IN_LINE[lang], `${lang}.fam_privacy_line names the copy`);
    assert.ok(S.fam_privacy_line.includes(S.fam_copy_save), `${lang}: the button's own label`);
  }
  // V3: the language and the age group go with a school text, numbers with the Quran.
  assert.match(en.fam_privacy_line, / the Mommy server gets the text and its language, and for a recitation or dictation check also the child’s age group; a Quran check sends the surah and ayat numbers instead\. /);
  // V2: what the server keeps out of its log, and what it notes there (backend/mommy/app.py).
  assert.match(en.fam_privacy_line, /The server does not keep the texts or the age group; its log notes the language, the kind of check and the ayat numbers\.$/);
  for (const lang of ['en', 'fr', 'ar']) {
    assert.doesNotMatch(H.allStrings(lang).fam_privacy_line, /does not keep them|keeps none|ne les conserve pas|لا يحفظها/, `${lang}: no blanket "not kept" (the log notes the language)`);
  }
  assert.match(H.allStrings('fr').fam_privacy_line, /son journal note la langue, le type de vérification et les numéros des versets\.$/);
  assert.match(H.allStrings('ar').fam_privacy_line, /ويُدوَّن في سجلّه اللغة ونوع التحقّق وأرقام الآيات\.$/);
  // V5: with Claude, the photo notes name where the photos go, and whose storage "not kept" is.
  assert.equal(en.photo_privacy_claude, 'Photos are made smaller on this device, then sent to Claude to be read. Mommy does not keep them.');
  assert.equal(en.photo_privacy_online_claude, 'Photos are made smaller on this device, then sent over a secure connection to the Mommy server, which does not keep them and passes them on to Claude to be read.');
  // P4: online without Claude, no OUTSIDE AI service (the server's recogniser is an AI).
  assert.equal(en.consent_online_no_ai, 'Nothing is sent to an outside AI service such as Claude.');
}

/**
 * The strings of the AI consent and of the storage sentences (privacy audit P1, P3, P4,
 * P5), in en, fr and ar: each says whose storage it means (Mommy's), none claims anything
 * about Claude's; online without Claude, "no outside AI service such as Claude"; the
 * child's line asks for a grown-up; the Arabic is neutral (no ـك, يُرجى for the parent,
 * هيا for the child).
 */
function aiConsentStrings() {
  const KEYS = ['consent_ai_label', 'consent_needed_ai', 'consent_needed_ai_parent', 'consent_needed_ai_grownup', 'ai_not_sent'];
  const GROWNUP = { en: /parent area \(Settings\)/, fr: /espace parents \(Réglages\)/, ar: /قسم الكبار \(الإعدادات\)/ };
  const PHOTOS_FIRST = { en: /^Reading photos uses Claude: /, fr: /^La lecture des photos utilise Claude\u00a0: /, ar: /^قراءة الصور تستخدم Claude: / };
  const MOMMY_STORAGE = ['consent_privacy', 'photo_privacy', 'fam_privacy_line'];
  const CLAUDE = { en: /such as Claude/, fr: /extérieur comme Claude/, ar: /خارجية مثل Claude/ };
  const ASK = { en: /^Let’s ask a grown-up/, fr: /^Demandons d’abord à un adulte/, ar: /^هيا نطلب من أحد الكبار/ };
  for (const lang of ['en', 'fr', 'ar']) {
    const S = H.allStrings(lang);
    for (const key of KEYS) assert.ok(S[key], `${lang}.${key}`);
    // P5: "never saved" and "not kept" are Mommy's, and say nothing of Claude's retention.
    for (const key of MOMMY_STORAGE) {
      assert.match(S[key], /Mommy/, `${lang}.${key} says whose storage`);
      assert.doesNotMatch(S[key], /Claude|Anthropic/, `${lang}.${key} claims nothing about Claude`);
    }
    assert.match(S.consent_online_no_ai, CLAUDE[lang], `${lang}.consent_online_no_ai`);
    assert.match(S.consent_needed_ai, ASK[lang], `${lang}.consent_needed_ai`);
    assert.doesNotMatch(S.consent_needed_ai, /Claude|consent|accord d|موافقة في خانة/, 'the child line names no service and no box');
    assert.match(S.consent_ai_label, /Claude/, `${lang}.consent_ai_label`);
    // V4: on a grown-up card, the line names Claude and where the OK is given.
    assert.match(S.consent_needed_ai_grownup, /Claude/, `${lang}.consent_needed_ai_grownup`);
    assert.match(S.consent_needed_ai_grownup, GROWNUP[lang], `${lang}.consent_needed_ai_grownup`);
    // RA-3: only the photos wait for the OK (V6), so the grown-up's line, which stands
    // beside the typed check of a dictation, names them as the parent area's line does.
    for (const key of ['consent_needed_ai_grownup', 'consent_needed_ai_parent']) {
      assert.match(S[key], PHOTOS_FIRST[lang], `${lang}.${key} says that reading photos needs Claude`);
      assert.doesNotMatch(S[key], /^(This|Cela)|هنا/, `${lang}.${key}: no "this" or "here" that could cover the typed check`);
    }
    // V5: the photo notes with Claude name it, and "not kept" is Mommy's, never Claude's.
    for (const key of ['photo_privacy_claude', 'photo_privacy_online_claude']) {
      assert.match(S[key], /Claude/, `${lang}.${key} says where the photos go`);
      assert.match(S[key], /Mommy/, `${lang}.${key} says whose storage`);
      assert.doesNotMatch(S[key], /Claude (does not|ne les|لا)|Anthropic/, `${lang}.${key} claims nothing about Claude's`);
    }
    // The AI box agrees to the Claude notice: no retention promise was added to it.
    assert.doesNotMatch(S.consent_claude, /not kept|never saved|pas conserv|jamais enregistr|لا تُحفظ/, `${lang}.consent_claude`);
    if (lang === 'ar') {
      for (const key of KEYS.concat(MOMMY_STORAGE, ['consent_online_no_ai', 'photo_privacy_claude', 'photo_privacy_online_claude'])) {
        const words = S[key].replace(/[ً-ْ]/g, '').split(/[\s«»()،؛؟.,:!…]+/u);
        assert.deepEqual(words.filter((w) => /ك$/.test(w)), [], 'ar.' + key);
      }
      for (const key of ['consent_needed_ai_parent', 'consent_needed_ai_grownup']) assert.match(S[key], /يُرجى/, 'ar.' + key);
    }
  }
}

/**
 * The Claude notice (consent_claude) names everything the server sends to Claude (audit
 * V1): every value that backend/mommy/llm.py puts into a Claude request is one of the
 * known fields below, and each field is named in the notice in en, fr and ar. A new value
 * in a prompt (a nickname, say) fails here until the notice names it.
 */
function claudeNoticeCoversPrompts() {
  const src = fs.readFileSync(path.join(ROOT, 'backend', 'mommy', 'llm.py'), 'utf8');
  const cls = src.slice(src.indexOf('class ClaudeBrain'), src.indexOf('# Factory'));
  assert.ok(cls.length > 1000, 'the ClaudeBrain class was found');
  // Each value put into a request, with the words that name it in the notice.
  const FIELDS = {
    image: { en: /photos of pages and of handwriting/, fr: /photos de pages et d'écriture/, ar: /صور الصفحات والكتابة/ },
    lang: { en: /The language is sent with each of them/, fr: /La langue est envoyée avec chacun d'eux/, ar: /وتُرسَل اللغة مع كلٍّ منها/ },
    age: { en: /your child’s age group with the meaning check and the feedback/, fr: /la tranche d'âge de votre enfant avec le jugement du sens et le message/, ar: /والفئة العمرية للطفل مع الحكم على المعنى والملاحظات/ },
    expected_text: { en: /the page text/, fr: /le texte de la page/, ar: /ونص الصفحة/ },
    heard_text: { en: /a transcript of what your child says/, fr: /une transcription de ce que dit votre enfant/, ar: /ونسخة مكتوبة مما يقوله الطفل/ },
    summary: { en: /the words your child got wrong, with the score/, fr: /les mots où votre enfant a fait une erreur, avec le score/, ar: /والكلمات التي أخطأ فيها الطفل مع النتيجة/ },
  };
  // Interpolations of the request texts ("Language: {...}", "<heard_text>\n{...}"), and
  // the image blocks: what each one carries.
  const VALUE = {
    'LANG_NAMES[lang_hint]': 'lang', lang_hint: 'lang', 'LANG_NAMES[lang]': 'lang', lang: 'lang', age: 'age',
    'expected_text.strip()': 'expected_text', 'heard_text.strip()': 'heard_text',
    'json.dumps(summary, ensure_ascii=False)': 'summary', hint: 'lang',
  };
  const seen = new Set();
  for (const m of cls.matchAll(/\bf"([^"]*)"/g)) {
    // An error message or a log line is not sent anywhere.
    const line = cls.slice(cls.lastIndexOf('\n', m.index) + 1, m.index);
    if (/\braise\b|\blog\./.test(line)) continue;
    for (const v of m[1].matchAll(/\{([^}]+)\}/g)) {
      assert.ok(VALUE[v[1]], `llm.py sends {${v[1]}} to Claude: name it in consent_claude and raise AI_CONSENT_VERSION`);
      seen.add(VALUE[v[1]]);
    }
  }
  if (/_image_block\(/.test(cls)) seen.add('image');
  if (/compact_summary\(/.test(cls)) seen.add('summary');
  assert.deepEqual([...seen].sort(), Object.keys(FIELDS).sort(), 'every known field is still sent (else the notice says too much)');
  for (const lang of ['en', 'fr', 'ar']) {
    const notice = H.allStrings(lang).consent_claude;
    for (const [field, words] of Object.entries(FIELDS)) assert.match(notice, words[lang], `${lang}.consent_claude names ${field}`);
  }
}

/**
 * The AI consent is given to one text of the Claude notice (rewards.js AI_CONSENT_VERSION):
 * its fingerprint in en, fr and ar (consent_claude and the box's label) is recorded here
 * for the current version. Changing the notice without raising the version would let a
 * consent given to the old text cover the new one; raise the version (every family is
 * asked again) and record the new fingerprint.
 */
function claudeNoticeVersion() {
  const R = require(path.join(WEB, 'rewards.js'));
  const NOTICE = { 2: 'cf276ec2d2ec6daf5c3374414d316183ff8e074759b8fd7a37db47cdf9be9bee' };
  const text = JSON.stringify(['en', 'fr', 'ar'].map((lang) => {
    const S = H.allStrings(lang);
    return [S.consent_claude, S.consent_ai_label];
  }));
  const hash = require('node:crypto').createHash('sha256').update(text).digest('hex');
  assert.equal(hash, NOTICE[R.AI_CONSENT_VERSION], `the Claude notice of version ${R.AI_CONSENT_VERSION} changed: raise AI_CONSENT_VERSION and record ${hash}`);
}

function frenchTypography() {
  const bad = [];
  for (const file of ['app.js', 'family.js']) {
    for (const [key, value] of Object.entries(H.uiStrings('fr', file))) {
      if (/ [:;!?»]/.test(value) || /« /.test(value)) bad.push(file + ' ' + key + ': ' + value);
    }
  }
  assert.deepEqual(bad, []);
}

/**
 * (Extra) The local page reader on the server (/api/health "ocr"): a page photo is read
 * without Claude and without the AI consent (sent without ai_consent, "reader": "local"),
 * the child is asked to check it word by word, and the privacy texts stay true in each way
 * the app runs. With Claude and the AI consent, Claude reads it as before.
 */
async function localReaderFlow(browser, base) {
  const S = H.allStrings('en');
  const MODES = [
    { name: 'local, no Claude, ocr', online: false, brain: 'offline', ocr: true, privacy: 'consent_privacy', extra: 'consent_offline', photo: 'photo_privacy' },
    { name: 'online, no Claude, ocr', online: true, brain: 'offline', ocr: true, privacy: 'consent_online', extra: 'consent_online_no_ai', photo: 'photo_privacy_online' },
    { name: 'online, Claude, ocr', online: true, brain: 'claude', ocr: true, privacy: 'consent_online', extra: 'consent_claude', photo: 'photo_privacy_online' },
  ];
  for (const mode of MODES) {
    const { context, page, fake, problems } = await newPage(browser, base, { width: 360, height: 780 }, { health: H.privacyHealth(mode) });
    await check(`local page reader, ${mode.name}: the photo needs no AI consent, goes without it, is read on the server and is to be checked word by word; the privacy texts stay true`, async () => {
      await page.goto(base + '/');
      await page.waitForSelector('#consent-extra:not([hidden])');
      for (const lang of ['en', 'fr', 'ar']) {
        const L = H.allStrings(lang);
        await page.selectOption('#setup-lang', lang);
        assert.equal((await page.textContent('#consent-privacy')).trim(), L[mode.privacy], lang);
        assert.equal((await page.textContent('#consent-extra')).trim(), L[mode.extra], lang);
        assert.doesNotMatch(L[mode.extra], /type the texts|tapez les textes|تُكتب النصوص يدويًا/, 'a photo can be read now');
        if (mode.online) assert.deepEqual(await H.localSentencesShown(page), [], lang);
      }
      await page.selectOption('#setup-lang', 'en');
      await H.setupFamily(page, { consent: true, aiConsent: false });
      await H.openEditor(page);
      assert.ok(await page.isEnabled('#prep-choose'), 'the photo works without the AI consent');
      assert.ok(await page.isHidden('#why-prep-photo'));
      assert.equal((await page.textContent('#screen-prepare .photo-privacy')).trim(), S[mode.photo], 'never a Claude text: the photo does not go to Claude');
      fake.setPageRead({ text: 'Le chat dort.', lang: 'fr', notes: 'Une ligne était floue.' });
      await page.setInputFiles('#prep-choose', { name: 'page.png', mimeType: 'image/png', buffer: tinyPng() });
      const call = await waitForCall(fake, '/api/page/read', 1);
      assert.deepEqual(call.aiConsent, [], 'no AI consent: no field');
      await page.waitForFunction(() => document.querySelector('#page-text').value === 'Le chat dort.');
      assert.equal((await page.textContent('#prep-status')).trim(), S.page_read_local + ' (Une ligne était floue.)');
      assert.notEqual((await page.textContent('#prep-status')).trim(), S.ai_not_sent);
      assert.equal(await page.inputValue('#page-lang'), 'fr');
      await pressConfirm(page);
      assert.match(await page.textContent('#prep-confirm-status'), /Saved in “My texts”/);
      if (mode.brain === 'claude') {
        // Given in Settings, the consent counts: Claude reads the next photo.
        await H.setConsent(page, true);
        await H.openEditor(page, { fresh: true });
        assert.equal((await page.textContent('#screen-prepare .photo-privacy')).trim(), S.photo_privacy_online_claude);
        fake.setPageRead(null);
        await page.setInputFiles('#prep-choose', { name: 'page.png', mimeType: 'image/png', buffer: tinyPng() });
        assert.deepEqual((await waitForCall(fake, '/api/page/read', 2)).aiConsent, ['1']);
        await page.waitForFunction((t) => document.querySelector('#page-text').value === t, PAGE_TEXT);
        assert.equal((await page.textContent('#prep-status')).trim(), S.page_read_ok);
      }
      assert.deepEqual(problems, []);
    });
    await context.close();
  }
  // Without the local reader and without Claude, the photo still waits (typing works).
  const none = await newPage(browser, base, { width: 360, height: 780 }, { health: H.privacyHealth(H.PRIVACY_MODES[0]) });
  await check('local page reader: without it (and without Claude) the photo stays off with its reason, and the texts keep saying so', async () => {
    await none.page.goto(base + '/');
    await H.setupFamily(none.page, { consent: true });
    await H.openEditor(none.page);
    assert.ok(await none.page.isDisabled('#prep-choose'));
    assert.equal((await none.page.textContent('#why-prep-photo')).trim(), S.no_brain);
    assert.deepEqual(none.problems, []);
  });
  await none.context.close();
}

/** MOMMY_ONLY=quranPartsFlow,liveFlow runs only those browser flows (to work on one). */
const wanted = (name) => !process.env.MOMMY_ONLY || process.env.MOMMY_ONLY.split(',').includes(name);

async function main() {
  console.log('# syntax');
  await check('node --check web/*.js', checkSyntax);
  console.log('# recorder helpers (Node)');
  await recorderUnitTests();
  console.log('# Arabic UI wording (Node)');
  await check('ar: UI strings use no singular imperative or visibly gendered second-person form', arabicWording);
  await check('fr: a no-break space before : ; ! ? and inside « » (no plain space)', frenchTypography);
  await check('privacy strings: each way the app runs has its sentences in en, fr and ar; online ones name the server and never say the data stays here', privacyStrings);
  await check('AI consent strings in en, fr and ar: Mommy\'s storage named, nothing claimed about Claude\'s, no outside AI service online, a neutral line for the child', aiConsentStrings);
  await check('the Claude notice names every value llm.py sends to Claude (the language, the age group, the score...) in en, fr and ar', claudeNoticeCoversPrompts);
  await check('the Claude notice has the fingerprint recorded for AI_CONSENT_VERSION (a change asks every family again)', claudeNoticeVersion);

  H.loadTanzil();
  console.log('# the fake Quran parts against the server\'s finder (Python)');
  await check('fake API: its Quran parts, mushaf text, Q1 decision and dictation plan are the server\'s on every fixture', fakeMatchesServer);

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    console.log('# browser: 360 px main flow');
    if (wanted('mainFlow')) await mainFlow(browser, base);
    console.log('# browser: desktop');
    if (wanted('desktopShots')) await desktopShots(browser, base);
    console.log('# browser: record button labels');
    if (wanted('recordLabelsFit')) await recordLabelsFit(browser, base);
    console.log('# browser: phone-like autoplay policy');
    if (wanted('strictAutoplayFlow')) await strictAutoplayFlow(base);
    console.log('# browser: dark mode');
    if (wanted('darkMode')) await darkMode(browser, base);
    console.log('# browser: unavailable features');
    if (wanted('unavailableFeatures')) await unavailableFeatures(browser, base);
    console.log('# browser: server down');
    if (wanted('serverDown')) await serverDown(browser, base);
    console.log('# browser: online, access revoked');
    if (wanted('accessRevoked')) await accessRevoked(browser, base);
    console.log('# browser: Arabic UI (review fixes)');
    if (wanted('arabicFlow')) await arabicFlow(browser, base);
    console.log('# browser: review fixes');
    if (wanted('fixesFlow')) await fixesFlow(browser, base);
    console.log('# browser: Quran in a school text (Q1, Q2)');
    if (wanted('quranPartsFlow')) await quranPartsFlow(browser, base);
    console.log('# browser: Quran in a school text, in en, fr and ar at 360 px; dark mode');
    if (wanted('quranPartsLanguages')) await quranPartsLanguages(browser, base);
    console.log('# browser: consent and Claude');
    if (wanted('consentFlow')) await consentFlow(browser, base);
    console.log('# browser: privacy texts, local or online, with or without Claude');
    if (wanted('privacyFlow')) await privacyFlow(browser, base);
    console.log('# browser: the AI consent, local or online, with or without Claude; Claude added later');
    if (wanted('aiConsentFlow')) await aiConsentFlow(browser, base);
    console.log('# browser: length limit');
    if (wanted('limitFlow')) await limitFlow(browser, base);
    console.log('# browser: live recitation (phrase by phrase)');
    if (wanted('liveFlow')) await liveFlow(browser, base);
    console.log('# browser: the local page reader (ocr)');
    if (wanted('localReaderFlow')) await localReaderFlow(browser, base);
  } finally {
    await browser.close();
    server.close();
  }
  console.log('# every flow');
  await check('no /api/tts request of any flow held a Quran part (the fake API\'s own list of the parts it answered with)', () => {
    assert.deepEqual(H.ttsQuranLeaks(), []);
  });

  H.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

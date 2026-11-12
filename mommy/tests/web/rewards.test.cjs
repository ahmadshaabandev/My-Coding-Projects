#!/usr/bin/env node
/*
 * Unit tests of web/rewards.js, the pure logic of tasks, stars and rewards
 * (docs/REWARDS.md, "Tests"). Node only, no browser: node:test and node:assert/strict.
 *
 * Covered: the module loads in Node and as a browser script; every state transition;
 * pass rules per kind (Quran tasks never carry a mode, and pass only on the strict Quran
 * check result); star arithmetic and the ledger (cap with a carry entry); goals;
 * surprises; removal cascades; migration from v1; validation and repair of corrupt
 * documents (a fixed point); PIN hashing (PBKDF2, checked against node:crypto) and the
 * backoff; a seeded random sequence of more than 3000 operations over 3 children with
 * the invariants checked after every operation; and a copy of the family list (the
 * round trip, no PIN or consent in it, every refusal, prototype keys, repairs).
 *
 * Run:  node --test tests/web/rewards.test.cjs     or     node tests/web/rewards.test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const FILE = path.join(__dirname, '..', '..', 'web', 'rewards.js');
const R = require(FILE);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 10, 11, 9, 0, 0);
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const SECRET = 'HEARD-TEXT-THAT-MUST-NEVER-BE-STORED';

function ids(prefix) {
  let n = 0;
  return { newId: () => `${prefix}${++n}` };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

function isCode(code, field) {
  return (e) => {
    assert.ok(e instanceof R.RewardsError, `expected a RewardsError, got ${e && e.stack}`);
    assert.equal(e.name, 'RewardsError');
    assert.equal(e.code, code, `code (message: ${e.message})`);
    if (field !== undefined) assert.equal(e.field, field, `field (message: ${e.message})`);
    return true;
  };
}

function throwsCode(fn, code, field) {
  assert.throws(fn, isCode(code, field));
}

async function rejectsCode(promise, code, field) {
  await assert.rejects(promise, isCode(code, field));
}

const sum = (ledger) => ledger.reduce((s, e) => s + e.delta, 0);

/** validateDoc repairs nothing and returns the same document (the API made it). */
function assertClean(doc) {
  const v = R.validateDoc(doc);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.repaired, []);
  assert.deepEqual(v.doc, doc);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
}

/** validateDoc of a corrupt document: ok, a fixed point, round trip, and its repairs. */
function repairs(x) {
  const v = R.validateDoc(x);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const again = R.validateDoc(v.doc);
  assert.equal(again.ok, true);
  assert.deepEqual(again.repaired, [], 'second pass repairs nothing');
  assert.deepEqual(again.doc, v.doc, 'fixed point');
  assert.deepEqual(JSON.parse(JSON.stringify(v.doc)), v.doc, 'JSON round trip');
  return v;
}

function hasRepair(v, re) {
  assert.ok(v.repaired.some((r) => re.test(r)), `no repair matching ${re} in ${JSON.stringify(v.repaired, null, 1)}`);
}

// API responses (docs/CONTRACT.md, "HTTP API"), with a transcript that must not be stored.
function wordsResult(nExpected, matched, inserted = 0, sayAgain = false) {
  const nErrors = nExpected - matched + inserted;
  return {
    ops: [],
    n_expected: nExpected,
    n_errors: nErrors,
    first_error_exp_index: nErrors ? 0 : null,
    verdict: sayAgain ? 'unclear' : nErrors ? 'mistakes' : 'correct',
    say_again: sayAgain,
    word_accuracy: matched / nExpected,
    say_again_reason: sayAgain ? 'error_rate' : null,
    stopped_at_exp_index: null,
    n_unreadable: 0,
  };
}
const reciteStrict = (n, m, ins = 0, sayAgain = false) => ({
  mode: 'strict', heard_text: SECRET, result: wordsResult(n, m, ins, sayAgain), feedback: SECRET, quality: { rms: 0.1 }, say_again: sayAgain,
});
const reciteMeaning = (verdict, missing = [], sayAgain = false) => ({
  mode: 'contextual', heard_text: SECRET,
  judgement: { verdict, missing_ideas: missing, wrong_ideas: [], say_again: sayAgain }, feedback: SECRET, quality: {}, say_again: sayAgain,
});
const dictationRes = (n, m, ins = 0) => ({
  read_text: SECRET, source: 'typed', uncertain_words: [], result: wordsResult(n, m, ins), feedback: SECRET, needs_parent_confirmation: true, legible: true,
});
function quranRes(n, m, ins = 0, sayAgain = false) {
  const r = wordsResult(n, m, ins, sayAgain);
  return {
    heard_text: SECRET, ops: [], verdict: r.verdict, say_again: sayAgain,
    first_error: r.n_errors ? { surah: 112, ayah: 1, word_index_display: 0, expected_display_word: 'x', kind: 'sub' } : null,
    feedback: SECRET, words: [], tolerated: [], stopped_at: null,
    n_expected: n, n_errors: r.n_errors, word_accuracy: r.word_accuracy, quality: {}, riwaya: 'hafs',
  };
}

const TEXT_EN = 'The little cat sat on the warm mat and looked at the birds in the old green tree';
const TEXT_AR = 'ذهب الولد إلى المدرسة صباحا';

/** Two children (a: Sara, b: Omar) with deterministic ids. */
function family(prefix = 'id') {
  const o = ids(prefix);
  let d = R.emptyDoc(at(0));
  let r = R.addChild(d, { nickname: 'Sara', age: '6-9', lang: 'ar' }, at(1), o);
  d = r.doc;
  const a = r.child.id;
  r = R.addChild(d, { nickname: 'Omar', age: '10-13', lang: 'fr' }, at(2), o);
  return { d: r.doc, a, b: r.child.id, o };
}

function addTask(d, input, now, o, extra) {
  const r = R.createTask(d, input, now, Object.assign({}, o, extra));
  return [r.doc, r.task.id, r.task];
}

const task = (d, id) => d.tasks.find((t) => t.id === id);

// ---------------------------------------------------------------------------
// The module itself
// ---------------------------------------------------------------------------

test('module: passes node --check, loads in Node and as a browser script, no DOM or storage', () => {
  const r = spawnSync(process.execPath, ['--check', FILE], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Object.isFrozen(R));
  for (const f of ['emptyDoc', 'migrateV1', 'validateDoc', 'addChild', 'createTask', 'recordAttempt', 'confirmTask', 'verifyPin']) {
    assert.equal(typeof R[f], 'function', f);
  }
  // As a classic script in a page: window.MommyRewards, no module object.
  const src = fs.readFileSync(FILE, 'utf8');
  const sandbox = { window: {}, crypto: globalThis.crypto, btoa, atob };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'rewards.js' });
  const W = sandbox.window.MommyRewards;
  assert.equal(typeof W.createTask, 'function');
  const d = W.addChild(W.emptyDoc(at(0)), { nickname: 'Sara' }, at(1)).doc;
  assert.match(d.children[0].id, /^[0-9a-z]{16}$/);
  // Code (comments removed) touches no DOM, storage, network or eval.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\b(?:document|localStorage|sessionStorage|indexedDB|navigator)\s*\.|\bfetch\s*\(|XMLHttpRequest|\beval\s*\(|new Function/);
  assert.doesNotMatch(code, /Math\.random|Date\.now\(|new Date\(\)/, 'deterministic: time and randomness come from the caller');
});

test('emptyDoc: shape, now is required, and validateDoc repairs nothing', () => {
  const d = R.emptyDoc(at(0), { uiLang: 'fr' });
  assert.deepEqual(d, {
    version: 2, createdAt: at(0), updatedAt: at(0),
    parent: { pin: null, failedAttempts: 0, lockedUntil: null, pinResetAt: null, consentAt: null, aiConsentAt: null, aiConsentVersion: null, uiLang: 'fr' },
    children: [], activeChildId: null, tasks: [], jar: {}, surprises: [],
  });
  assertClean(d);
  assert.equal(R.emptyDoc(at(0)).parent.uiLang, 'en');
  for (const bad of [undefined, null, '', 'yesterday', 12, '2026-02-30T10:00:00Z', '2026-11-11 10:00:00', '2026-11-11T24:00:00Z']) {
    throwsCode(() => R.emptyDoc(bad), 'bad_input', 'now');
  }
  assert.equal(R.STORAGE_KEY, 'mommy.data.v2');
  assert.equal(R.V1_KEY, 'mommy.profile.v1');
  assert.equal(R.CORRUPT_KEY_PREFIX, 'mommy.data.v2.corrupt.');
});

test('ids: random base36 from getRandomValues, unique; opts.newId overrides; bad or taken ids refused', () => {
  let d = R.emptyDoc(at(0));
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const r = R.addChild(d, { nickname: `Kid ${i}` }, at(i));
    d = r.doc;
    assert.match(r.child.id, /^[0-9a-z]{16}$/);
    seen.add(r.child.id);
  }
  assert.equal(seen.size, 40);
  const r = R.addChild(R.emptyDoc(at(0)), { nickname: 'Sara' }, at(1), { newId: () => 'child-1' });
  assert.equal(r.child.id, 'child-1');
  throwsCode(() => R.addChild(r.doc, { nickname: 'X' }, at(2), { newId: () => 'bad id!' }), 'bad_input', 'newId');
  throwsCode(() => R.addChild(r.doc, { nickname: 'X' }, at(2), { newId: () => '__proto__' }), 'bad_input', 'newId');
  // A taken id is retried, then refused.
  const seq = ['child-1', 'child-2'];
  assert.equal(R.addChild(r.doc, { nickname: 'X' }, at(2), { newId: () => seq.shift() }).child.id, 'child-2');
  throwsCode(() => R.addChild(r.doc, { nickname: 'X' }, at(2), { newId: () => 'child-1' }), 'bad_state');
});

test('no operation mutates its input document (deep-frozen inputs all the way)', async () => {
  const { a, o } = family('f');
  let d = deepFreeze(family('f').d);
  const step = (fn) => {
    const out = fn(d);
    d = deepFreeze(out && out.doc ? out.doc : out);
    return out;
  };
  const t1 = step((x) => R.createTask(x, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', reward: { text: 'Ice cream', emoji: '🍦' } }, at(10), o)).task.id;
  const t2 = step((x) => R.createTask(x, { childId: a, kind: 'quran', quran: { surah: 112, from: 1, to: 4 } }, at(11), o)).task.id;
  step((x) => R.updateTask(x, t1, { stars: 3 }, at(12)));
  step((x) => R.recordAttempt(x, t1, reciteStrict(10, 10), at(13)));
  step((x) => R.recordAttempt(x, t2, quranRes(10, 9), at(14)));
  step((x) => R.confirmTask(x, t1, 'app_pass', at(15)));
  step((x) => R.markRewardGiven(x, t1, at(16)));
  step((x) => R.sendBack(x, t2, 'Again', at(17)));
  step((x) => R.confirmTask(x, t2, 'parent_override', at(18)));
  const g = step((x) => R.addGoal(x, a, { cost: 3, reward: { text: 'Park', emoji: '🌳' } }, at(19), o)).goal.id;
  step((x) => R.giveGoal(x, a, g, at(20)));
  step((x) => R.adjustStars(x, a, 4, at(21), 'Helped'));
  step((x) => R.removeGoal(x, a, g, at(22)));
  const s = step((x) => R.addSurprise(x, a, { text: 'Stickers', emoji: '🎁' }, at(23), o)).surprise.id;
  step((x) => R.markSurpriseSeen(x, s, at(24)));
  step((x) => R.updateChild(x, a, { nickname: 'Sarah', quran: { surah: 1 } }, at(25)));
  step((x) => R.setActiveChild(x, null, at(26)));
  step((x) => R.updateParent(x, { uiLang: 'ar', consent: true }, at(27)));
  step((x) => R.archiveTask(x, t1, at(28)));
  R.childSummary(d, a, at(29));
  R.reviewQueue(d);
  R.validateDoc(d);
  d = deepFreeze(await R.setPin(d, '2468', at(30)));
  d = deepFreeze((await R.verifyPin(d, '1111', at(31))).doc);
  d = deepFreeze((await R.verifyPin(d, '2468', at(32))).doc);
  step((x) => R.clearPin(x, at(33)));
  step((x) => R.removeChild(x, a, at(34)));
  assertClean(d);
});

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

test('children: add with defaults and validation; the first child becomes active', () => {
  const { d, a, b } = family();
  assert.equal(d.activeChildId, a, 'the first child is active');
  const sara = d.children[0];
  assert.deepEqual(sara, {
    id: a, nickname: 'Sara', age: '6-9', lang: 'ar', avatar: R.AVATARS[0], createdAt: at(1),
    quran: { surah: 78, from: 1, to: 10, juzAmma: true },
  });
  assert.equal(d.children[1].avatar, R.AVATARS[1], 'the default avatar is one nobody has');
  assert.deepEqual(d.jar[a], { balance: 0, earned: 0, goals: [], ledger: [] });
  assert.deepEqual(d.jar[b], { balance: 0, earned: 0, goals: [], ledger: [] });
  assertClean(d);
  // lang defaults to the parent's language
  assert.equal(R.addChild(R.emptyDoc(at(0), { uiLang: 'fr' }), { nickname: 'Lea' }, at(1)).child.lang, 'fr');
  // nickname: trimmed, 1-24 code points (24 emoji are fine)
  assert.equal(R.addChild(d, { nickname: '  Lina  ' }, at(3)).child.nickname, 'Lina');
  assert.equal(R.addChild(d, { nickname: '⭐'.repeat(24) }, at(3)).child.nickname, '⭐'.repeat(24));
  assert.equal(R.addChild(d, { nickname: 'Zed', avatar: '🦊️' }, at(3)).child.avatar, '🦊');
  const bad = [
    [{}, 'nickname'], [{ nickname: '' }, 'nickname'], [{ nickname: '   ' }, 'nickname'], [{ nickname: 'x'.repeat(25) }, 'nickname'],
    [{ nickname: 7 }, 'nickname'], [{ nickname: 'a\uD800b' }, 'nickname'], [{ nickname: 'A', age: '5-6' }, 'age'],
    [{ nickname: 'A', lang: 'de' }, 'lang'], [{ nickname: 'A', avatar: 'X' }, 'avatar'], [{ nickname: 'A', nick: 'B' }, 'nick'],
    [{ nickname: 'A', quran: { surah: 115 } }, 'quran.surah'], [{ nickname: 'A', quran: { juzAmma: 'yes' } }, 'quran.juzAmma'],
  ];
  for (const [input, field] of bad) throwsCode(() => R.addChild(d, input, at(3)), 'bad_input', field);
  throwsCode(() => R.addChild(d, null, at(3)), 'bad_input', 'input');
  throwsCode(() => R.addChild({ version: 1 }, { nickname: 'A' }, at(3)), 'bad_input', 'doc');
});

test('children: update, setActiveChild and errors', () => {
  const { d, a, b } = family();
  const d2 = R.updateChild(d, b, { nickname: 'Omar K', age: '14-18', lang: 'en', avatar: '🦉', quran: { surah: 2, from: 255, to: 257 } }, at(5));
  const omar = d2.children[1];
  assert.equal(omar.nickname, 'Omar K');
  assert.equal(omar.age, '14-18');
  assert.equal(omar.avatar, '🦉');
  assert.deepEqual(omar.quran, { surah: 2, from: 255, to: 257, juzAmma: true }, 'partial Quran state is merged');
  assert.equal(d2.updatedAt, at(5));
  assertClean(d2);
  throwsCode(() => R.updateChild(d, 'nobody', { nickname: 'X' }, at(5)), 'not_found', 'childId');
  throwsCode(() => R.updateChild(d, a, { nickname: '' }, at(5)), 'bad_input', 'nickname');
  throwsCode(() => R.updateChild(d, a, { id: 'x' }, at(5)), 'bad_input', 'id');
  assert.equal(R.setActiveChild(d, b, at(6)).activeChildId, b);
  assert.equal(R.setActiveChild(d, null, at(6)).activeChildId, null);
  throwsCode(() => R.setActiveChild(d, 'nobody', at(6)), 'not_found');
  const p = R.updateParent(d, { uiLang: 'ar', consent: true, aiConsent: true }, at(7));
  assert.deepEqual([p.parent.uiLang, p.parent.consentAt, p.parent.aiConsentAt, p.parent.aiConsentVersion], ['ar', at(7), at(7), R.AI_CONSENT_VERSION]);
  assert.equal(R.updateParent(p, { consent: true }, at(8)).parent.consentAt, at(7), 'the first consent time is kept');
  assert.deepEqual(pick(R.updateParent(p, { aiConsent: false }, at(8)).parent), [at(7), null, null]);
  throwsCode(() => R.updateParent(d, { uiLang: 'de' }, at(8)), 'bad_input', 'uiLang');
  throwsCode(() => R.updateParent(d, { pin: null }, at(8)), 'bad_input', 'pin');
  assertClean(p);
});

const pick = (p) => [p.consentAt, p.aiConsentAt, p.aiConsentVersion];
const V = R.AI_CONSENT_VERSION;

test('AI consent: its own box, with a version; the general consent alone never covers Claude', () => {
  const d = R.emptyDoc(at(0));
  // 2: the Claude notice names the score, the language and the age group (version 1 did not).
  assert.equal(R.AI_CONSENT_VERSION, 2);
  // The general consent (microphone and camera) sets no AI consent.
  const c = R.updateParent(d, { consent: true }, at(1));
  assert.deepEqual(pick(c.parent), [at(1), null, null]);
  assert.equal(R.hasAiConsent(c), false);
  assertClean(c);
  // The AI box: the time and the version; ticked again, the first time is kept.
  const a = R.updateParent(c, { aiConsent: true }, at(2));
  assert.deepEqual(pick(a.parent), [at(1), at(2), V]);
  assert.equal(R.hasAiConsent(a), true);
  assert.deepEqual(pick(R.updateParent(a, { aiConsent: true }, at(3)).parent), [at(1), at(2), V]);
  assertClean(a);
  // Both in one patch (the setup with Claude set up and both boxes ticked).
  assert.deepEqual(pick(R.updateParent(d, { consent: true, aiConsent: true }, at(4)).parent), [at(4), at(4), V]);
  // No AI consent without the general one.
  throwsCode(() => R.updateParent(d, { aiConsent: true }, at(5)), 'bad_state', 'aiConsent');
  throwsCode(() => R.updateParent(a, { consent: false, aiConsent: true }, at(5)), 'bad_state', 'aiConsent');
  // Withdrawing the general consent withdraws both (Settings); the AI one alone, only it.
  assert.deepEqual(pick(R.updateParent(a, { consent: false }, at(6)).parent), [null, null, null]);
  assert.deepEqual(pick(R.updateParent(a, { consent: false, aiConsent: false }, at(6)).parent), [null, null, null]);
  assert.deepEqual(pick(R.updateParent(a, { aiConsent: false }, at(6)).parent), [at(1), null, null]);
  assert.equal(R.hasAiConsent(R.updateParent(a, { aiConsent: false }, at(6))), false);
  // The language alone changes no consent.
  assert.deepEqual(pick(R.updateParent(a, { uiLang: 'fr' }, at(7)).parent), [at(1), at(2), V]);
  throwsCode(() => R.updateParent(a, { aiConsent: 'yes' }, at(7)), 'bad_input', 'aiConsent');
  // hasAiConsent never throws on anything.
  for (const x of [undefined, null, 1, 'doc', [], {}, { parent: null }, { parent: [] }]) assert.equal(R.hasAiConsent(x), false);
});

test('AI consent: an old document (aiConsentAt set with the general consent, no version) is asked again once', () => {
  // What the app saved before the version existed: one box set both, whatever the brain.
  const old = R.updateParent(R.emptyDoc(at(0)), { consent: true }, at(1));
  old.parent.aiConsentAt = at(1);
  delete old.parent.aiConsentVersion;
  const v = R.validateDoc(old);
  assert.equal(v.ok, true);
  assert.deepEqual(v.repaired, [], 'read as it is: no repair, so no notice for the parent');
  assert.deepEqual(pick(v.doc.parent), [at(1), at(1), null]);
  assert.equal(R.hasAiConsent(old), false);
  assert.equal(R.hasAiConsent(v.doc), false);
  // Asked again: the AI box gives a new time and the version.
  const again = R.updateParent(v.doc, { aiConsent: true }, at(9));
  assert.deepEqual(pick(again.parent), [at(1), at(9), V]);
  assert.equal(R.hasAiConsent(again), true);
  assertClean(again);
  // Every other way of carrying an aiConsentAt without the version never counts either.
  for (const version of [null, 0, -1, 1.5, '2', true]) {
    const x = JSON.parse(JSON.stringify(again));
    x.parent.aiConsentVersion = version;
    assert.equal(R.hasAiConsent(x), false, String(version));
  }
  // A version without the general consent or without its time does not count.
  const noConsent = JSON.parse(JSON.stringify(again));
  noConsent.parent.consentAt = null;
  assert.equal(R.hasAiConsent(noConsent), false);
  // Repairs: an invalid version, and a version without a time, are cleared (a fixed point).
  const bad = JSON.parse(JSON.stringify(again));
  bad.parent.aiConsentVersion = 'one';
  let r = repairs(bad);
  hasRepair(r, /parent\.aiConsentVersion: invalid, cleared/);
  assert.deepEqual(pick(r.doc.parent), [at(1), at(9), null]);
  assert.equal(R.hasAiConsent(r.doc), false);
  const noTime = JSON.parse(JSON.stringify(again));
  noTime.parent.aiConsentAt = null;
  r = repairs(noTime);
  hasRepair(r, /parent\.aiConsentVersion: no AI consent time, cleared/);
  assert.deepEqual(pick(r.doc.parent), [at(1), null, null]);
  // A later version (a newer app) still counts and is kept.
  const later = JSON.parse(JSON.stringify(again));
  later.parent.aiConsentVersion = V + 1;
  assertClean(later);
  assert.equal(R.hasAiConsent(later), true);
});

test('AI consent: a consent of version 1 (the Claude notice without the score, language and age group) no longer counts, and is asked again', () => {
  // Saved by the app while the notice was version 1: valid, kept as it is, but not enough.
  const v1 = R.updateParent(R.emptyDoc(at(0)), { consent: true }, at(1));
  v1.parent.aiConsentAt = at(2);
  v1.parent.aiConsentVersion = 1;
  const v = R.validateDoc(v1);
  assert.equal(v.ok, true);
  assert.deepEqual(v.repaired, [], 'an older version is read without a repair (no notice for the parent)');
  assert.deepEqual(pick(v.doc.parent), [at(1), at(2), 1]);
  assert.equal(R.hasAiConsent(v.doc), false, 'given to a notice that left out the age group');
  // Ticked again under the current notice: a new time and the current version.
  const again = R.updateParent(v.doc, { aiConsent: true }, at(5));
  assert.deepEqual(pick(again.parent), [at(1), at(5), V]);
  assert.equal(R.hasAiConsent(again), true);
  assertClean(again);
  // Withdrawn: both fields go, whatever the version was.
  assert.deepEqual(pick(R.updateParent(v.doc, { aiConsent: false }, at(6)).parent), [at(1), null, null]);
  assert.deepEqual(pick(R.updateParent(v.doc, { consent: false }, at(6)).parent), [null, null, null]);
  // Every version below the current one is refused; the current one and later ones count.
  for (let version = 1; version <= V + 2; version++) {
    const x = JSON.parse(JSON.stringify(again));
    x.parent.aiConsentVersion = version;
    assert.equal(R.hasAiConsent(x), version >= V, String(version));
  }
});

test('removeChild: cascades to tasks, jar, goals, ledger and surprises; other children untouched', () => {
  let { d, a, b, o } = family();
  let ta;
  let tb;
  [d, ta] = addTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en' }, at(10), o);
  [d, tb] = addTask(d, { childId: b, kind: 'dictation', text: 'Le chat dort', lang: 'fr' }, at(11), o);
  d = R.recordAttempt(d, ta, reciteStrict(10, 10), at(12)).doc;
  d = R.confirmTask(d, ta, 'app_pass', at(13));
  d = R.addGoal(d, a, { cost: 5, reward: { text: 'Cinema', emoji: '🎬' } }, at(14), o).doc;
  d = R.addSurprise(d, a, { text: 'Stickers' }, at(15), o).doc;
  d = R.addSurprise(d, b, { text: 'Book', emoji: '📚' }, at(16), o).doc;
  assert.equal(d.activeChildId, a);
  const before = JSON.stringify([d.children[1], d.jar[b], d.tasks.filter((t) => t.childId === b), d.surprises.filter((s) => s.childId === b)]);
  const d2 = R.removeChild(d, a, at(20));
  assert.deepEqual(d2.children.map((c) => c.id), [b]);
  assert.equal(d2.tasks.some((t) => t.childId === a), false);
  assert.equal(task(d2, tb).id, tb);
  assert.equal(Object.prototype.hasOwnProperty.call(d2.jar, a), false);
  assert.equal(d2.surprises.some((s) => s.childId === a), false);
  assert.equal(d2.activeChildId, null, 'the removed child was active');
  assert.equal(JSON.stringify([d2.children[0], d2.jar[b], d2.tasks, d2.surprises]), before);
  assertClean(d2);
  assert.equal(R.removeChild(d, b, at(20)).activeChildId, a, 'another active child stays active');
  throwsCode(() => R.removeChild(d2, a, at(21)), 'not_found');
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

test('createTask: recite and dictation defaults, the default title, and field validation', () => {
  const { d, a, o } = family();
  const r = R.createTask(d, { childId: a, kind: 'recite', text: `  ${TEXT_EN}\n`, lang: 'en' }, at(10), o);
  const t = r.task;
  assert.deepEqual(t, {
    id: t.id, childId: a, createdAt: at(10), updatedAt: at(10), kind: 'recite',
    title: 'The little cat sat on the warm mat and looked at the birds', text: TEXT_EN, lang: 'en', mode: 'strict',
    pass: { minAccuracy: 1 }, stars: 2, reward: null, due: null, status: 'assigned', attempts: [],
    readyAt: null, doneAt: null, confirmedBy: null, sentBackAt: null, sentBackNote: null, rewardStatus: 'none', rewardGivenAt: null,
  });
  assert.ok(t.title.length <= 60);
  assert.deepEqual(r.doc.tasks[0], t);
  assertClean(r.doc);
  const dict = R.createTask(d, {
    childId: a, kind: 'dictation', text: TEXT_AR, lang: 'ar', title: 'Dictée 1', stars: 5,
    pass: { minAccuracy: 0.8 }, reward: { text: 'Ice cream', emoji: '🍦' }, due: '2026-11-20',
  }, at(10), o).task;
  assert.equal('mode' in dict, false, 'a dictation task has no mode');
  assert.equal(dict.title, 'Dictée 1');
  assert.deepEqual([dict.stars, dict.pass.minAccuracy, dict.rewardStatus, dict.due], [5, 0.8, 'locked', '2026-11-20']);
  assert.equal(R.createTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', mode: 'contextual' }, at(10)).task.mode, 'contextual');
  assert.equal(R.createTask(d, { childId: a, kind: 'recite', text: 'x'.repeat(70), lang: 'en' }, at(10)).task.title, 'x'.repeat(60));
  assert.equal(R.createTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', title: '  ' }, at(10)).task.title.startsWith('The little'), true);
  assert.equal(R.createTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', reward: { text: 'Cake', emoji: '⭐️' } }, at(10)).task.reward.emoji, '⭐');
  assert.equal(R.createTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', reward: { text: 'Cake' } }, at(10)).task.reward.emoji, '🎁');
  assert.equal(R.createTask(d, { childId: a, kind: 'recite', text: 'é'.repeat(20000), lang: 'fr' }, at(10)).task.text.length, 20000);
  const base = { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en' };
  const bad = [
    [{ kind: 'essay' }, 'kind'], [{ text: '' }, 'text'], [{ text: '  \n ' }, 'text'], [{ text: 5 }, 'text'], [{ text: 'é'.repeat(20001) }, 'text'],
    [{ text: 'word '.repeat(3001) }, 'text'], [{ text: 'bad \uDC00 text' }, 'text'], [{ lang: 'de' }, 'lang'], [{ lang: undefined }, 'lang'],
    [{ mode: 'meaning' }, 'mode'], [{ stars: 0 }, 'stars'], [{ stars: 6 }, 'stars'], [{ stars: 2.5 }, 'stars'], [{ stars: '2' }, 'stars'],
    [{ pass: { minAccuracy: 0.7 } }, 'pass.minAccuracy'], [{ pass: { minAccuracy: 0.9, x: 1 } }, 'x'], [{ pass: 0.9 }, 'pass'],
    [{ reward: { text: '' } }, 'reward.text'], [{ reward: { text: 'x'.repeat(81) } }, 'reward.text'], [{ reward: { text: 'A', emoji: '🐷' } }, 'reward.emoji'],
    [{ reward: 'cake' }, 'reward'], [{ due: '2026-02-30' }, 'due'], [{ due: '20/11/2026' }, 'due'], [{ title: 'x'.repeat(61) }, 'title'],
    [{ quran: { surah: 1, from: 1, to: 7 } }, 'quran'], [{ heard_text: 'x' }, 'heard_text'],
  ];
  for (const [patch, field] of bad) throwsCode(() => R.createTask(d, Object.assign({}, base, patch), at(10)), 'bad_input', field);
  throwsCode(() => R.createTask(d, Object.assign({}, base, { childId: 'nobody' }), at(10)), 'not_found', 'childId');
  throwsCode(() => R.createTask(d, Object.assign({}, base, { kind: 'dictation', mode: 'strict' }), at(10)), 'bad_input', 'mode');
});

test('Quran tasks never carry a mode: createTask and updateTask refuse it, validateDoc removes it', () => {
  const { d, a, o } = family();
  const q = { surah: 112, from: 1, to: 4 };
  let [d1, id, t] = addTask(d, { childId: a, kind: 'quran', quran: q }, at(10), o);
  assert.equal('mode' in t, false);
  assert.equal('text' in t, false);
  assert.equal('lang' in t, false);
  assert.deepEqual(t.quran, { surah: 112, from: 1, to: 4, memory: false });
  assert.equal(t.title, '112:1-4', 'without a surah name the title is the range');
  assert.equal(R.passRule(t), 'all_words');
  assertClean(d1);
  for (const mode of ['strict', 'contextual', null, '', 'meaning']) {
    throwsCode(() => R.createTask(d, { childId: a, kind: 'quran', quran: q, mode }, at(10)), 'bad_input', 'mode');
    throwsCode(() => R.updateTask(d1, id, { mode }, at(11)), 'bad_input', 'mode');
  }
  throwsCode(() => R.createTask(d, { childId: a, kind: 'quran', quran: q, text: 'قل هو الله أحد' }, at(10)), 'bad_input', 'text');
  throwsCode(() => R.createTask(d, { childId: a, kind: 'quran', quran: q, lang: 'ar' }, at(10)), 'bad_input', 'lang');
  throwsCode(() => R.updateTask(d1, id, { text: 'x' }, at(11)), 'bad_input', 'text');
  // Even a done Quran task refuses a mode with bad_input.
  const done = R.confirmTask(d1, id, 'parent_override', at(12));
  throwsCode(() => R.updateTask(done, id, { mode: 'strict' }, at(13)), 'bad_input', 'mode');
  // Options: surah, range, looking or from memory; the title from the surah name.
  const t2 = R.createTask(d, { childId: a, kind: 'quran', quran: { surah: 1, from: 1, to: 1, memory: true }, stars: 3 }, at(10), { surahName: 'الفاتحة' }).task;
  assert.deepEqual([t2.title, t2.quran.memory], ['الفاتحة', true]);
  assert.equal(R.createTask(d, { childId: a, kind: 'quran', quran: { surah: 1, from: 2, to: 2 } }, at(10)).task.title, '1:2');
  const badRanges = [
    [{ surah: 0, from: 1, to: 1 }, 'quran.surah'], [{ surah: 115, from: 1, to: 1 }, 'quran.surah'], [{ surah: 2, from: 0, to: 1 }, 'quran.from'],
    [{ surah: 2, from: 5, to: 4 }, 'quran.to'], [{ surah: 2, from: 1, to: 51 }, 'quran.to'], [{ surah: 2, from: 1, to: 3, memory: 'yes' }, 'quran.memory'],
    [{ surah: 2, from: 1, to: 3, juz: 30 }, 'juz'], [null, 'quran'],
  ];
  for (const [range, field] of badRanges) throwsCode(() => R.createTask(d, { childId: a, kind: 'quran', quran: range }, at(10)), 'bad_input', field);
  assert.equal(R.createTask(d, { childId: a, kind: 'quran', quran: { surah: 2, from: 1, to: 50 } }, at(10)).task.quran.to, 50);
  throwsCode(() => R.createTask(d, { childId: a, kind: 'quran', quran: { surah: 112, from: 1, to: 5 } }, at(10), { ayahCount: 4 }), 'bad_input', 'quran.to');
  // validateDoc removes a mode from a stored Quran task.
  const corrupt = JSON.parse(JSON.stringify(d1));
  corrupt.tasks[0].mode = 'contextual';
  const v = repairs(corrupt);
  assert.equal('mode' in v.doc.tasks[0], false);
  hasRepair(v, /tasks\[0\]\.mode: a Quran task never carries a mode/);
  assert.deepEqual(v.doc, d1);
});

test('updateTask: edits, content changes send a ready task back to "to do", done and archived refuse', () => {
  let { d, a, o } = family();
  let id;
  [d, id] = addTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', reward: { text: 'Ice cream', emoji: '🍦' } }, at(10), o);
  d = R.recordAttempt(d, id, reciteStrict(10, 10), at(11)).doc;
  assert.equal(task(d, id).status, 'ready');
  // Stars, title, reward, due: still ready.
  let d2 = R.updateTask(d, id, { stars: 4, title: 'Cat poem', due: '2026-12-01', reward: { text: 'Cake', emoji: '🍰' } }, at(12));
  let t = task(d2, id);
  assert.deepEqual([t.status, t.stars, t.title, t.due, t.reward.text, t.rewardStatus, t.updatedAt], ['ready', 4, 'Cat poem', '2026-12-01', 'Cake', 'locked', at(12)]);
  assertClean(d2);
  // Undefined fields change nothing; null clears the reward and the date; '' resets the title.
  d2 = R.updateTask(d2, id, { reward: undefined, due: undefined, title: undefined }, at(13));
  assert.equal(task(d2, id).reward.text, 'Cake');
  d2 = R.updateTask(d2, id, { reward: null, due: null, title: '' }, at(13));
  t = task(d2, id);
  assert.deepEqual([t.reward, t.rewardStatus, t.due, t.title], [null, 'none', null, 'The little cat sat on the warm mat and looked at the birds']);
  // Text, mode or pass level changes: back to assigned.
  for (const patch of [{ text: 'A new text' }, { mode: 'contextual' }, { pass: { minAccuracy: 0.9 } }, { lang: 'fr' }]) {
    const t3 = task(R.updateTask(d, id, patch, at(14)), id);
    assert.deepEqual([t3.status, t3.readyAt], ['assigned', null], JSON.stringify(patch));
  }
  assert.equal(task(R.updateTask(d, id, { text: TEXT_EN, pass: { minAccuracy: 1 } }, at(14)), id).status, 'ready', 'same content stays ready');
  throwsCode(() => R.updateTask(d, id, { kind: 'dictation' }, at(14)), 'bad_input', 'kind');
  throwsCode(() => R.updateTask(d, id, { childId: 'x' }, at(14)), 'bad_input', 'childId');
  throwsCode(() => R.updateTask(d, id, { status: 'done' }, at(14)), 'bad_input', 'status');
  throwsCode(() => R.updateTask(d, id, { quran: { surah: 1 } }, at(14)), 'bad_input', 'quran');
  throwsCode(() => R.updateTask(d, id, { stars: 9 }, at(14)), 'bad_input', 'stars');
  throwsCode(() => R.updateTask(d, 'nope', { stars: 1 }, at(14)), 'not_found', 'taskId');
  const done = R.confirmTask(d, id, 'app_pass', at(15));
  throwsCode(() => R.updateTask(done, id, { stars: 1 }, at(16)), 'bad_state');
  throwsCode(() => R.updateTask(R.archiveTask(d, id, at(15)), id, { stars: 1 }, at(16)), 'bad_state');
  // A Quran range is merged; a dictation task refuses a mode.
  let qid;
  let did;
  [d, qid] = addTask(d, { childId: a, kind: 'quran', quran: { surah: 78, from: 1, to: 10 } }, at(17), o);
  assert.deepEqual(task(R.updateTask(d, qid, { quran: { memory: true, to: 5 } }, at(18)), qid).quran, { surah: 78, from: 1, to: 5, memory: true });
  [d, did] = addTask(d, { childId: a, kind: 'dictation', text: TEXT_EN, lang: 'en' }, at(19), o);
  throwsCode(() => R.updateTask(d, did, { mode: 'strict' }, at(20)), 'bad_input', 'mode');
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

test('transitions: assigned -> ready on a passing attempt -> done (app_pass); reward locked -> unlocked -> given', () => {
  let { d, a, o } = family();
  let id;
  [d, id] = addTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', stars: 3, reward: { text: 'Ice cream', emoji: '🍦' } }, at(10), o);
  assert.equal(task(d, id).rewardStatus, 'locked');
  // A failing attempt: still to do, nothing lost.
  let r = R.recordAttempt(d, id, reciteStrict(10, 7), at(11));
  assert.deepEqual([r.passed, r.becameReady, task(r.doc, id).status], [false, false, 'assigned']);
  assert.deepEqual(r.attempt, { at: at(11), accuracy: 0.7, verdict: 'mistakes', nErrors: 3, nExpected: 10, passed: false });
  d = r.doc;
  r = R.recordAttempt(d, id, reciteStrict(10, 10), at(12));
  assert.deepEqual([r.passed, r.becameReady, r.task.status, r.task.readyAt], [true, true, 'ready', at(12)]);
  d = r.doc;
  assert.equal(JSON.stringify(d).includes(SECRET), false, 'no transcript or feedback text is stored');
  assert.deepEqual(Object.keys(task(d, id).attempts[0]).sort(), ['accuracy', 'at', 'nErrors', 'nExpected', 'passed', 'verdict']);
  // More attempts while ready: recorded, no status change.
  r = R.recordAttempt(d, id, reciteStrict(10, 4), at(13));
  assert.deepEqual([r.becameReady, r.task.status, r.task.readyAt, r.task.attempts.length], [false, 'ready', at(12), 3]);
  d = r.doc;
  assert.equal(d.jar[a].balance, 0, 'nothing is credited before the parent confirms');
  d = R.confirmTask(d, id, 'app_pass', at(14));
  const t = task(d, id);
  assert.deepEqual([t.status, t.doneAt, t.confirmedBy, t.rewardStatus], ['done', at(14), 'app_pass', 'unlocked']);
  assert.deepEqual(d.jar[a], { balance: 3, earned: 3, goals: [], ledger: [{ at: at(14), delta: 3, reason: 'task', ref: id, note: null }] });
  assertClean(d);
  // Confirming again credits nothing and throws bad_state (both ways).
  throwsCode(() => R.confirmTask(d, id, 'app_pass', at(15)), 'bad_state');
  throwsCode(() => R.confirmTask(d, id, 'parent_override', at(15)), 'bad_state');
  // Attempts after done are recorded, the status stays done, no stars.
  r = R.recordAttempt(d, id, reciteStrict(10, 10), at(16));
  assert.deepEqual([r.task.status, r.becameReady, r.doc.jar[a].balance], ['done', false, 3]);
  // The reward: unlocked -> given, once.
  throwsCode(() => R.markRewardGiven(R.archiveTask(d, id, at(16)), 'nope', at(17)), 'not_found');
  const g = R.markRewardGiven(d, id, at(17));
  assert.deepEqual([task(g, id).rewardStatus, task(g, id).rewardGivenAt], ['given', at(17)]);
  throwsCode(() => R.markRewardGiven(g, id, at(18)), 'bad_state');
  assertClean(g);
  throwsCode(() => R.confirmTask(d, id, 'maybe', at(15)), 'bad_input', 'how');
  throwsCode(() => R.confirmTask(d, 'nope', 'app_pass', at(15)), 'not_found');
});

test('transitions: confirm anyway (parent_override) from assigned only; app_pass from ready only', () => {
  let { d, a, o } = family();
  let id;
  [d, id] = addTask(d, { childId: a, kind: 'dictation', text: TEXT_EN, lang: 'en', stars: 4 }, at(10), o);
  throwsCode(() => R.confirmTask(d, id, 'app_pass', at(11)), 'bad_state');
  d = R.recordAttempt(d, id, dictationRes(10, 6), at(11)).doc;
  const over = R.confirmTask(d, id, 'parent_override', at(12));
  const t = task(over, id);
  assert.deepEqual([t.status, t.confirmedBy, t.readyAt, t.rewardStatus, over.jar[a].balance], ['done', 'parent_override', null, 'none', 4]);
  assertClean(over);
  const ready = R.recordAttempt(d, id, dictationRes(10, 10), at(13)).doc;
  throwsCode(() => R.confirmTask(ready, id, 'parent_override', at(14)), 'bad_state');
  assert.equal(task(R.confirmTask(ready, id, 'app_pass', at(14)), id).confirmedBy, 'app_pass');
});

test('transitions: send back (ready or assigned -> assigned) with an optional note', () => {
  let { d, a, o } = family();
  let id;
  [d, id] = addTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en' }, at(10), o);
  d = R.recordAttempt(d, id, reciteStrict(10, 10), at(11)).doc;
  let s = R.sendBack(d, id, '  Read the last line slowly  ', at(12));
  let t = task(s, id);
  assert.deepEqual([t.status, t.readyAt, t.sentBackAt, t.sentBackNote], ['assigned', null, at(12), 'Read the last line slowly']);
  assertClean(s);
  // A later pass makes it ready again; nothing was credited.
  s = R.recordAttempt(s, id, reciteStrict(10, 10), at(13)).doc;
  assert.deepEqual([task(s, id).status, task(s, id).readyAt, s.jar[a].balance], ['ready', at(13), 0]);
  // From assigned, without a note.
  t = task(R.sendBack(R.sendBack(d, id, null, at(12)), id, '', at(13)), id);
  assert.deepEqual([t.status, t.sentBackNote, t.sentBackAt], ['assigned', null, at(13)]);
  assert.equal(task(R.sendBack(d, id, undefined, at(12)), id).sentBackNote, null);
  assert.equal(task(R.sendBack(d, id, 'x'.repeat(120), at(12)), id).sentBackNote.length, 120);
  throwsCode(() => R.sendBack(d, id, 'x'.repeat(121), at(12)), 'bad_input', 'note');
  throwsCode(() => R.sendBack(d, id, 5, at(12)), 'bad_input', 'note');
  const done = R.confirmTask(d, id, 'app_pass', at(14));
  throwsCode(() => R.sendBack(done, id, null, at(15)), 'bad_state');
  throwsCode(() => R.sendBack(R.archiveTask(d, id, at(14)), id, null, at(15)), 'bad_state');
});

test('transitions: any state -> archived; archived cannot be confirmed; an unlocked reward can still be given', () => {
  let { d, a, o } = family();
  const mk = (status) => {
    let x;
    let id;
    [x, id] = addTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', reward: { text: 'Park', emoji: '🌳' } }, at(10), o);
    if (status !== 'assigned') x = R.recordAttempt(x, id, reciteStrict(10, 10), at(11)).doc;
    if (status === 'done') x = R.confirmTask(x, id, 'app_pass', at(12));
    return [x, id];
  };
  for (const status of ['assigned', 'ready', 'done']) {
    const [x, id] = mk(status);
    const arch = R.archiveTask(x, id, at(20));
    const t = task(arch, id);
    assert.equal(t.status, 'archived');
    assert.equal(t.rewardStatus, status === 'done' ? 'unlocked' : 'locked');
    assertClean(arch);
    throwsCode(() => R.archiveTask(arch, id, at(21)), 'bad_state');
    throwsCode(() => R.confirmTask(arch, id, 'app_pass', at(21)), 'bad_state');
    throwsCode(() => R.confirmTask(arch, id, 'parent_override', at(21)), 'bad_state');
    // Attempts on an archived task change no status and credit nothing.
    const r = R.recordAttempt(arch, id, reciteStrict(10, 10), at(22));
    assert.deepEqual([r.task.status, r.becameReady, r.doc.jar[a].balance], ['archived', false, status === 'done' ? 2 : 0]);
    if (status === 'done') assert.equal(task(R.markRewardGiven(arch, id, at(23)), id).rewardStatus, 'given');
    else throwsCode(() => R.markRewardGiven(arch, id, at(23)), 'bad_state');
  }
});

test('attempts: at most 20 are kept (the newest), with scores only', () => {
  let { d, a, o } = family();
  let id;
  [d, id] = addTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en' }, at(10), o);
  for (let i = 0; i < 25; i++) d = R.recordAttempt(d, id, reciteStrict(20, i % 20), at(11 + i)).doc;
  const attempts = task(d, id).attempts;
  assert.equal(attempts.length, 20);
  assert.equal(attempts[0].at, at(16));
  assert.equal(attempts[19].at, at(35));
  assertClean(d);
  throwsCode(() => R.recordAttempt(d, 'nope', reciteStrict(1, 1), at(40)), 'not_found');
  throwsCode(() => R.recordAttempt(d, id, null, at(40)), 'bad_input', 'result');
  throwsCode(() => R.recordAttempt(d, id, { mode: 'strict' }, at(40)), 'bad_input', 'result');
});

// ---------------------------------------------------------------------------
// Pass rules per kind
// ---------------------------------------------------------------------------

test('pass rules: strict recite and dictation use word_accuracy (or 1 - n_errors/n_expected)', () => {
  const t = (kind, minAccuracy) => ({ kind, mode: kind === 'recite' ? 'strict' : undefined, pass: { minAccuracy } });
  for (const kind of ['recite', 'dictation']) {
    const res = kind === 'recite' ? reciteStrict : dictationRes;
    assert.equal(R.passes(t(kind, 1), res(10, 10)), true);
    assert.equal(R.passes(t(kind, 1), res(10, 9)), false);
    assert.equal(R.passes(t(kind, 0.9), res(10, 9)), true);
    assert.equal(R.passes(t(kind, 0.9), res(20, 18)), true);
    assert.equal(R.passes(t(kind, 0.9), res(10, 8)), false);
    assert.equal(R.passes(t(kind, 0.8), res(10, 8)), true);
    assert.equal(R.passes(t(kind, 0.8), res(30, 23)), false);
    assert.equal(R.passes(t(kind, 0.8), res(10, 7)), false);
    // word_accuracy counts matched words: an added word does not lower it.
    assert.equal(R.passes(t(kind, 1), res(10, 10, 1)), true);
  }
  // Without word_accuracy: 1 - n_errors / n_expected.
  const noAcc = reciteStrict(10, 9);
  delete noAcc.result.word_accuracy;
  assert.equal(R.passes(t('recite', 0.9), noAcc), true);
  assert.equal(R.readResult(t('recite', 0.9), noAcc).accuracy, 0.9);
  // A bare CheckResult works too; a say-again (unclear) result never passes.
  assert.equal(R.passes(t('recite', 0.8), wordsResult(10, 10)), true);
  assert.equal(R.passes(t('recite', 0.8), reciteStrict(10, 10, 0, true)), false);
  const top = reciteStrict(10, 10);
  top.say_again = true;
  assert.equal(R.passes(t('recite', 0.8), top), false);
  // A meaning result does not fit a strict task; recite and dictation responses do not mix.
  assert.equal(R.passes(t('recite', 0.8), reciteMeaning('same_meaning')), false);
  assert.equal(R.readResult(t('recite', 0.8), dictationRes(10, 10)), null);
  assert.equal(R.readResult(t('dictation', 0.8), reciteStrict(10, 10)), null);
  assert.equal(R.passes(t('dictation', 0.8), wordsResult(10, 10)), true, 'a bare CheckResult fits both');
  assert.equal(R.readResult(t('recite', 0.8), reciteMeaning('same_meaning')), null);
  // Never throws on garbage.
  for (const [task0, res] of [[null, reciteStrict(1, 1)], [t('recite', 1), null], [{}, {}], [t('essay', 1), wordsResult(1, 1)], [t('recite', 1), { result: 'x' }]]) {
    assert.equal(R.passes(task0, res), false);
  }
});

test('pass rules: contextual recite passes on verdict same_meaning with no missing ideas', () => {
  const t = { kind: 'recite', mode: 'contextual', pass: { minAccuracy: 1 } };
  assert.equal(R.passRule(t), 'same_meaning');
  assert.equal(R.passes(t, reciteMeaning('same_meaning', [])), true);
  assert.equal(R.passes(t, reciteMeaning('same_meaning', ['the birds'])), false);
  assert.equal(R.passes(t, reciteMeaning('partly', [])), false);
  assert.equal(R.passes(t, reciteMeaning('different', [])), false);
  assert.equal(R.passes(t, reciteMeaning('unclear', [])), false);
  assert.equal(R.passes(t, reciteMeaning('same_meaning', [], true)), false);
  const noList = reciteMeaning('same_meaning');
  delete noList.judgement.missing_ideas;
  assert.equal(R.passes(t, noList), false);
  assert.equal(R.passes(t, { verdict: 'same_meaning', missing_ideas: [] }), true, 'a bare judgement');
  assert.equal(R.passes(t, reciteStrict(10, 10)), false, 'a strict result does not fit');
  const r = R.readResult(t, reciteMeaning('partly', ['x']));
  assert.deepEqual(r, { accuracy: null, verdict: 'partly', nErrors: null, nExpected: null, passed: false });
  // Through recordAttempt.
  let { d, a, o } = family();
  let id;
  [d, id] = addTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', mode: 'contextual' }, at(10), o);
  throwsCode(() => R.recordAttempt(d, id, reciteStrict(10, 10), at(11)), 'bad_input', 'result');
  const rr = R.recordAttempt(d, id, reciteMeaning('same_meaning'), at(11));
  assert.deepEqual([rr.passed, rr.task.status], [true, 'ready']);
  assert.equal(R.improvement(R.recordAttempt(rr.doc, id, reciteMeaning('partly', ['x']), at(12)).task), null);
});

test('pass rules: a Quran task passes only on the strict Quran check; minAccuracy 1 means n_errors === 0', () => {
  const t = (minAccuracy) => ({ kind: 'quran', quran: { surah: 112, from: 1, to: 4, memory: false }, pass: { minAccuracy } });
  assert.equal(R.passes(t(1), quranRes(15, 15)), true);
  assert.equal(R.passes(t(1), quranRes(15, 14)), false);
  assert.equal(R.passes(t(1), quranRes(15, 15, 1)), false, 'an added word is a mistake: n_errors 1 though word_accuracy is 1');
  assert.equal(R.passes(t(0.9), quranRes(10, 9)), true);
  assert.equal(R.passes(t(0.9), quranRes(10, 8)), false);
  assert.equal(R.passes(t(0.8), quranRes(10, 8)), true);
  assert.equal(R.passes(t(0.8), quranRes(10, 10, 0, true)), false, 'say again');
  // Anything but the Quran check result does not fit: recite (strict or meaning), dictation, a bare CheckResult.
  for (const other of [reciteStrict(10, 10), reciteMeaning('same_meaning'), dictationRes(10, 10), wordsResult(10, 10), { judgement: { verdict: 'same_meaning', missing_ideas: [] } }]) {
    assert.equal(R.passes(t(0.8), other), false);
    assert.equal(R.readResult(t(0.8), other), null);
  }
  const noErrors = quranRes(10, 10);
  delete noErrors.n_errors;
  assert.equal(R.readResult(t(1), noErrors), null, 'n_errors is required');
  // Through recordAttempt: other results are refused, no transcript is stored.
  let { d, a, o } = family();
  let id;
  [d, id] = addTask(d, { childId: a, kind: 'quran', quran: { surah: 112, from: 1, to: 4 } }, at(10), o);
  for (const other of [reciteStrict(10, 10), reciteMeaning('same_meaning'), dictationRes(10, 10), wordsResult(10, 10)]) {
    throwsCode(() => R.recordAttempt(d, id, other, at(11)), 'bad_input', 'result');
  }
  const r1 = R.recordAttempt(d, id, quranRes(15, 15, 1), at(11));
  assert.deepEqual([r1.passed, r1.task.status, r1.attempt.nErrors, r1.attempt.accuracy], [false, 'assigned', 1, 1]);
  const r2 = R.recordAttempt(r1.doc, id, quranRes(15, 15), at(12));
  assert.deepEqual([r2.passed, r2.becameReady, r2.task.status], [true, true, 'ready']);
  assert.equal(JSON.stringify(r2.doc).includes(SECRET), false);
  assertClean(r2.doc);
});

// ---------------------------------------------------------------------------
// Star arithmetic and ledger
// ---------------------------------------------------------------------------

test('stars: credited once per task, every balance change has a ledger entry, adjust never below 0', () => {
  let { d, a, b, o } = family();
  const check = () => {
    for (const c of d.children) {
      assert.equal(d.jar[c.id].balance, sum(d.jar[c.id].ledger));
      assert.ok(d.jar[c.id].balance >= 0);
      assert.ok(d.jar[c.id].earned >= d.jar[c.id].balance);
    }
    assertClean(d);
  };
  let t1;
  let t2;
  let t3;
  [d, t1] = addTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', stars: 3 }, at(10), o);
  [d, t2] = addTask(d, { childId: a, kind: 'dictation', text: TEXT_EN, lang: 'en', stars: 5 }, at(11), o);
  [d, t3] = addTask(d, { childId: b, kind: 'quran', quran: { surah: 114, from: 1, to: 6 }, stars: 1 }, at(12), o);
  d = R.recordAttempt(d, t1, reciteStrict(10, 10), at(13)).doc;
  d = R.confirmTask(d, t1, 'app_pass', at(14));
  d = R.confirmTask(d, t2, 'parent_override', at(15));
  d = R.confirmTask(d, t3, 'parent_override', at(16));
  check();
  assert.deepEqual([d.jar[a].balance, d.jar[a].earned, d.jar[b].balance], [8, 8, 1]);
  assert.deepEqual(d.jar[a].ledger.map((e) => [e.delta, e.reason, e.ref]), [[3, 'task', t1], [5, 'task', t2]]);
  d = R.adjustStars(d, a, 2, at(17), '  Helped at home ');
  assert.deepEqual(d.jar[a].ledger[2], { at: at(17), delta: 2, reason: 'adjust', ref: null, note: 'Helped at home' });
  assert.deepEqual([d.jar[a].balance, d.jar[a].earned], [10, 10]);
  d = R.adjustStars(d, a, -4, at(18));
  assert.deepEqual([d.jar[a].balance, d.jar[a].earned, d.jar[a].ledger[3].note], [6, 6, null]);
  check();
  // Never below 0: a larger correction is limited to the balance; at 0 there is nothing to take.
  d = R.adjustStars(d, b, -50, at(19), 'Counted twice');
  assert.deepEqual([d.jar[b].balance, d.jar[b].ledger[1].delta, d.jar[b].earned], [0, -1, 0]);
  throwsCode(() => R.adjustStars(d, b, -1, at(20)), 'insufficient_stars');
  for (const bad of [0, 1.5, 501, -501, '3', NaN, null]) throwsCode(() => R.adjustStars(d, a, bad, at(20)), 'bad_input', 'delta');
  throwsCode(() => R.adjustStars(d, a, 1, at(20), 'x'.repeat(81)), 'bad_input', 'note');
  throwsCode(() => R.adjustStars(d, 'nobody', 1, at(20)), 'not_found');
  check();
  // earned falls with a correction but never below the balance; goals do not lower it.
  let g;
  ({ doc: d, goal: { id: g } } = R.addGoal(d, a, { cost: 6, reward: { text: 'Zoo', emoji: '🎡' } }, at(21), o));
  d = R.giveGoal(d, a, g, at(22));
  assert.deepEqual([d.jar[a].balance, d.jar[a].earned], [0, 6]);
  check();
});

test('ledger: at most 200 entries; the oldest fold into one carry entry so the balance still equals the sum', () => {
  let { d, a } = family();
  for (let i = 1; i <= 260; i++) d = R.adjustStars(d, a, 1, at(10 + i));
  const j = d.jar[a];
  assert.equal(j.ledger.length, 200);
  assert.deepEqual(j.ledger[0], { at: at(10 + 61), delta: 61, reason: 'carry', ref: null, note: null });
  assert.equal(j.ledger[199].at, at(270));
  assert.deepEqual([j.balance, sum(j.ledger), j.earned], [260, 260, 260]);
  assertClean(d);
  d = R.adjustStars(d, a, -500, at(400));
  assert.deepEqual([d.jar[a].balance, sum(d.jar[a].ledger), d.jar[a].ledger.length, d.jar[a].ledger[0].delta], [0, 0, 200, 62]);
  assertClean(d);
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

test('goals: add, give only when the balance covers the cost, give once, remove', () => {
  let { d, a, b, o } = family();
  let r = R.addGoal(d, a, { cost: 5, reward: { text: '  Ice cream ', emoji: '🍦' } }, at(10), o);
  const g1 = r.goal.id;
  assert.deepEqual(r.goal, { id: g1, cost: 5, reward: { text: 'Ice cream', emoji: '🍦' }, status: 'open', givenAt: null, createdAt: at(10) });
  d = r.doc;
  d = R.addGoal(d, a, { cost: 12, reward: { text: 'Cinema', emoji: '🎬' } }, at(11), o).doc;
  for (const [input, field] of [[{ cost: 0, reward: { text: 'x' } }, 'cost'], [{ cost: 501, reward: { text: 'x' } }, 'cost'], [{ cost: 2.5, reward: { text: 'x' } }, 'cost'],
    [{ cost: 3 }, 'reward'], [{ cost: 3, reward: { text: '' } }, 'reward.text'], [{ cost: 3, reward: { text: 'x', emoji: 'no' } }, 'reward.emoji'], [{ cost: 3, reward: { text: 'x' }, status: 'given' }, 'status']]) {
    throwsCode(() => R.addGoal(d, a, input, at(12)), 'bad_input', field);
  }
  throwsCode(() => R.addGoal(d, 'nobody', { cost: 3, reward: { text: 'x' } }, at(12)), 'not_found');
  throwsCode(() => R.giveGoal(d, a, g1, at(12)), 'insufficient_stars');
  d = R.adjustStars(d, a, 4, at(13));
  let s = R.childSummary(d, a, at(13));
  assert.deepEqual([s.nextGoal.id, s.starsMissing, s.goalProgress, s.affordableGoals.length], [g1, 1, 0.8, 0]);
  throwsCode(() => R.giveGoal(d, a, g1, at(14)), 'insufficient_stars');
  d = R.adjustStars(d, a, 3, at(15));
  s = R.childSummary(d, a, at(15));
  assert.deepEqual([s.starsMissing, s.affordableGoals.map((g) => g.id)], [0, [g1]]);
  d = R.giveGoal(d, a, g1, at(16));
  const goal = d.jar[a].goals.find((g) => g.id === g1);
  assert.deepEqual([goal.status, goal.givenAt, d.jar[a].balance, d.jar[a].earned], ['given', at(16), 2, 7]);
  assert.deepEqual(d.jar[a].ledger[2], { at: at(16), delta: -5, reason: 'goal', ref: g1, note: null });
  assertClean(d);
  throwsCode(() => R.giveGoal(R.adjustStars(d, a, 10, at(17)), a, g1, at(18)), 'bad_state');
  throwsCode(() => R.giveGoal(d, b, g1, at(18)), 'not_found', 'goalId');
  throwsCode(() => R.giveGoal(d, a, 'nope', at(18)), 'not_found', 'goalId');
  s = R.childSummary(d, a, at(18));
  assert.equal(s.nextGoal.cost, 12, 'the next goal is the cheapest open one');
  // Removing a given goal keeps the ledger amount and clears the reference.
  const d2 = R.removeGoal(d, a, g1, at(19));
  assert.equal(d2.jar[a].goals.length, 1);
  assert.deepEqual([d2.jar[a].ledger[2].ref, d2.jar[a].balance], [null, 2]);
  assertClean(d2);
  throwsCode(() => R.removeGoal(d2, a, g1, at(20)), 'not_found');
});

// ---------------------------------------------------------------------------
// Surprises
// ---------------------------------------------------------------------------

test('surprises: add at any time, shown once (seen), idempotent, removed with the child', () => {
  let { d, a, b, o } = family();
  let r = R.addSurprise(d, a, { text: 'A trip to the park', emoji: '🌳' }, at(10), o);
  const s1 = r.surprise.id;
  assert.deepEqual(r.surprise, { id: s1, childId: a, reward: { text: 'A trip to the park', emoji: '🌳' }, at: at(10), seenAt: null });
  d = r.doc;
  d = R.addSurprise(d, a, { text: 'Stickers' }, at(11), o).doc;
  d = R.addSurprise(d, b, { text: 'Book', emoji: '📚' }, at(12), o).doc;
  assert.deepEqual(R.childSummary(d, a, at(13)).unseenSurprises.map((s) => s.reward.text), ['A trip to the park', 'Stickers']);
  d = R.markSurpriseSeen(d, s1, at(14));
  assert.equal(d.surprises[0].seenAt, at(14));
  const again = R.markSurpriseSeen(d, s1, at(15));
  assert.deepEqual(again, d, 'seeing it again changes nothing');
  assert.equal(R.childSummary(d, a, at(15)).counts.unseenSurprises, 1);
  assert.equal(d.jar[a].balance, 0, 'a surprise is not paid in stars');
  assertClean(d);
  throwsCode(() => R.markSurpriseSeen(d, 'nope', at(16)), 'not_found');
  throwsCode(() => R.addSurprise(d, a, { text: '' }, at(16)), 'bad_input', 'reward.text');
  throwsCode(() => R.addSurprise(d, 'nobody', { text: 'x' }, at(16)), 'not_found');
  assert.equal(R.removeChild(d, a, at(17)).surprises.length, 1);
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

test('childSummary and reviewQueue: sections, order, counts, rewards to give', () => {
  let { d, a, b, o } = family();
  const ids2 = {};
  const mk = (name, child, extra, sec) => {
    let id;
    [d, id] = addTask(d, Object.assign({ childId: child, kind: 'recite', text: `${name} text`, lang: 'en', title: name }, extra), at(sec), o);
    ids2[name] = id;
  };
  mk('late', a, {}, 10);
  mk('due-dec', a, { due: '2026-12-10' }, 11);
  mk('due-nov', a, { due: '2026-11-20' }, 12);
  mk('ready-1', a, { reward: { text: 'Cake', emoji: '🍰' } }, 13);
  mk('ready-2', b, {}, 14);
  mk('ready-3', a, {}, 15);
  mk('done-1', a, { reward: { text: 'Park', emoji: '🌳' }, stars: 1 }, 16);
  mk('done-2', a, { stars: 1 }, 17);
  mk('old', a, {}, 18);
  d = R.recordAttempt(d, ids2['ready-3'], reciteStrict(4, 4), at(20)).doc;
  d = R.recordAttempt(d, ids2['ready-2'], reciteStrict(4, 2), at(21)).doc;
  d = R.recordAttempt(d, ids2['ready-2'], reciteStrict(4, 4), at(22)).doc;
  d = R.recordAttempt(d, ids2['ready-1'], reciteStrict(4, 4), at(23)).doc;
  d = R.confirmTask(d, ids2['done-1'], 'parent_override', at(24));
  d = R.confirmTask(d, ids2['done-2'], 'parent_override', at(25));
  d = R.archiveTask(d, ids2.old, at(26));
  const s = R.childSummary(d, a, at(30));
  const titles = (list) => list.map((t) => t.title);
  assert.deepEqual(titles(s.todo), ['due-nov', 'due-dec', 'late'], 'due first, then oldest');
  assert.deepEqual(titles(s.waiting), ['ready-3', 'ready-1'], 'oldest ready first');
  assert.deepEqual(titles(s.done), ['done-2', 'done-1'], 'newest first');
  assert.deepEqual(titles(s.rewardsToGive), ['done-1']);
  assert.deepEqual(s.counts, { todo: 3, waiting: 2, done: 2, archived: 1, goals: 0, rewardsToGive: 1, unseenSurprises: 0 });
  assert.deepEqual([s.child.nickname, s.balance, s.earned, s.nextGoal, s.starsMissing, s.goalProgress], ['Sara', 2, 2, null, null, null]);
  throwsCode(() => R.childSummary(d, 'nobody', at(30)), 'not_found');
  // The summary is a copy.
  s.todo[0].title = 'changed';
  assert.equal(task(d, ids2['due-nov']).title, 'due-nov');
  const q = R.reviewQueue(d);
  assert.deepEqual(q.map((e) => [e.task.title, e.child.nickname, e.readyAt]), [['ready-3', 'Sara', at(20)], ['ready-2', 'Omar', at(22)], ['ready-1', 'Sara', at(23)]]);
  const omar = q[1];
  assert.deepEqual([omar.attemptCount, omar.passedCount, omar.bestAccuracy, omar.lastAccuracy, omar.lastPassed, omar.improvement], [2, 1, 1, 1, true, 2]);
  assert.deepEqual(omar.child, { id: b, nickname: 'Omar', avatar: R.AVATARS[1] });
  assert.deepEqual(R.taskActions(task(d, ids2['ready-1'])), { edit: true, confirm: true, confirmAnyway: false, sendBack: true, archive: true, markRewardGiven: false });
  assert.deepEqual(R.taskActions(task(d, ids2['done-1'])), { edit: false, confirm: false, confirmAnyway: false, sendBack: false, archive: true, markRewardGiven: true });
  assert.deepEqual(R.taskActions(task(d, ids2.late)), { edit: true, confirm: false, confirmAnyway: true, sendBack: true, archive: true, markRewardGiven: false });
  // Lookups return copies.
  const c = R.getChild(d, a);
  c.nickname = 'X';
  assert.equal(d.children[0].nickname, 'Sara');
  assert.equal(R.getTask(d, 'nope'), null);
  assert.equal(R.getJar(d, b).balance, 0);
  assert.equal(R.getJar(d, 'nope'), null);
});

test('improvement: words right in the last attempt minus the best earlier one on the same text', () => {
  const mkTask = (scores) => ({
    kind: 'recite', mode: 'strict', pass: { minAccuracy: 1 },
    attempts: scores.map(([n, m], i) => ({ at: at(i), accuracy: m / n, verdict: 'mistakes', nErrors: n - m, nExpected: n, passed: m === n })),
  });
  assert.equal(R.improvement(mkTask([])), null);
  assert.equal(R.improvement(mkTask([[10, 5]])), null);
  assert.equal(R.improvement(mkTask([[10, 5], [10, 8]])), 3);
  assert.equal(R.improvement(mkTask([[10, 9], [10, 6], [10, 8]])), -1, 'against the best, not only the previous attempt');
  assert.equal(R.improvement(mkTask([[10, 5], [12, 9]])), null, 'another text length is not compared');
  assert.equal(R.improvement(mkTask([[12, 4], [10, 5], [12, 9]])), 5);
  assert.equal(R.improvement(null), null);
  assert.equal(R.passRule({ kind: 'dictation', pass: { minAccuracy: 0.9 } }), 'nine_in_ten');
  assert.equal(R.passRule({ kind: 'quran', pass: { minAccuracy: 0.8 } }), 'eight_in_ten');
});

// ---------------------------------------------------------------------------
// Migration from v1
// ---------------------------------------------------------------------------

test('migrateV1: the v1 profile becomes a v2 document with one child', () => {
  const v1 = { nickname: 'Lina', age: '10-13', lang: 'fr', quran: { surah: 2, from: 255, to: 257, juzAmma: false } };
  const d = R.migrateV1(v1, at(0), { newId: () => 'kid1' });
  assert.deepEqual(d, {
    version: 2, createdAt: at(0), updatedAt: at(0),
    parent: { pin: null, failedAttempts: 0, lockedUntil: null, pinResetAt: null, consentAt: null, aiConsentAt: null, aiConsentVersion: null, uiLang: 'fr' },
    children: [{ id: 'kid1', nickname: 'Lina', age: '10-13', lang: 'fr', avatar: R.AVATARS[0], createdAt: at(0), quran: { surah: 2, from: 255, to: 257, juzAmma: false } }],
    activeChildId: 'kid1', tasks: [], jar: { kid1: { balance: 0, earned: 0, goals: [], ledger: [] } }, surprises: [],
  });
  assertClean(d);
  // From the JSON string stored under the v1 key.
  assert.deepEqual(R.migrateV1(JSON.stringify(v1), at(0), { newId: () => 'kid1' }), d);
  // The v1 defaults for invalid fields (the same clamping as loadProfile in app.js).
  const m = R.migrateV1({ nickname: '   ', age: '99', lang: 'de', quran: { surah: 500, from: '3', to: -2, juzAmma: 'no' } }, at(0), { lang: 'ar', defaultNickname: 'Child' });
  assert.deepEqual([m.children[0].nickname, m.children[0].age, m.children[0].lang, m.parent.uiLang], ['Child', '6-9', 'ar', 'ar']);
  assert.deepEqual(m.children[0].quran, { surah: 114, from: 3, to: 1, juzAmma: true });
  assertClean(m);
  // A corrupt or empty profile still gives one child (named after the avatar if nothing else).
  for (const p of ['{not json', null, 42, [], {}]) {
    const x = R.migrateV1(p, at(0));
    assert.equal(x.children.length, 1);
    assert.equal(x.children[0].nickname, R.AVATARS[0]);
    assert.deepEqual(x.children[0].quran, { surah: 78, from: 1, to: 10, juzAmma: true });
    assertClean(x);
  }
  assert.equal(R.migrateV1({ nickname: 'x'.repeat(40) }, at(0)).children[0].nickname.length, 24);
  // Consent is carried over only when it was stored.
  assert.equal(R.migrateV1({ consentAt: at(-100), aiConsent: true }, at(0)).parent.consentAt, at(-100));
  assert.equal(R.migrateV1({ consentAt: at(-100), aiConsent: true }, at(0)).parent.aiConsentAt, at(0));
  // A v1 AI consent has no version: it never covers Claude, the parent is asked.
  assert.equal(R.migrateV1({ consentAt: at(-100), aiConsent: true }, at(0)).parent.aiConsentVersion, null);
  assert.equal(R.hasAiConsent(R.migrateV1({ consentAt: at(-100), aiConsentAt: at(-90) }, at(0))), false);
  assert.equal(R.migrateV1({ consent: 'yes' }, at(0)).parent.consentAt, null);
  throwsCode(() => R.migrateV1(v1, 'now'), 'bad_input', 'now');
});

// ---------------------------------------------------------------------------
// validateDoc
// ---------------------------------------------------------------------------

/** A rich valid document made through the API. */
function richDoc() {
  let { d, a, b, o } = family('r');
  let t1;
  let t2;
  let t3;
  let t4;
  [d, t1] = addTask(d, { childId: a, kind: 'recite', text: TEXT_EN, lang: 'en', reward: { text: 'Cake', emoji: '🍰' }, due: '2026-12-01' }, at(10), o);
  [d, t2] = addTask(d, { childId: a, kind: 'quran', quran: { surah: 112, from: 1, to: 4 } }, at(11), o);
  [d, t3] = addTask(d, { childId: b, kind: 'dictation', text: TEXT_AR, lang: 'ar', stars: 4 }, at(12), o);
  [d, t4] = addTask(d, { childId: b, kind: 'recite', text: TEXT_AR, lang: 'ar', mode: 'contextual' }, at(13), o);
  d = R.recordAttempt(d, t1, reciteStrict(10, 10), at(14)).doc;
  d = R.confirmTask(d, t1, 'app_pass', at(15));
  d = R.recordAttempt(d, t2, quranRes(15, 13), at(16)).doc;
  d = R.recordAttempt(d, t3, dictationRes(5, 5), at(17)).doc;
  d = R.confirmTask(d, t3, 'app_pass', at(18));
  d = R.recordAttempt(d, t4, reciteMeaning('same_meaning'), at(19)).doc;
  const ga = R.addGoal(d, a, { cost: 2, reward: { text: 'Park', emoji: '🌳' } }, at(20), o);
  d = R.giveGoal(ga.doc, a, ga.goal.id, at(21));
  d = R.addGoal(d, b, { cost: 10, reward: { text: 'Zoo', emoji: '🎡' } }, at(22), o).doc;
  d = R.adjustStars(d, b, 3, at(23), 'Kind');
  d = R.addSurprise(d, a, { text: 'Stickers' }, at(24), o).doc;
  d = R.sendBack(d, t2, 'Slowly', at(25));
  return { d, a, b, t1, t2, t3, t4, goalA: ga.goal.id };
}

test('validateDoc: rejects what is not a version 2 document, never throws', () => {
  const cyclic = { version: 2 };
  cyclic.self = cyclic;
  cyclic.children = [cyclic];
  const getter = { version: 2 };
  Object.defineProperty(getter, 'children', { enumerable: true, get() { throw new Error('boom'); } });
  const proxy = new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
  for (const [i, [x, err]] of [[undefined, 'not_object'], [null, 'not_object'], [42, 'not_object'], [[], 'not_object'], ['{bad json', 'not_json'],
    ['[1,2]', 'not_object'], [{}, 'unknown_version'], [{ version: 1 }, 'unknown_version'], [{ version: '2' }, 'unknown_version'],
    [{ version: 3, children: [] }, 'unknown_version'], [getter, 'unreadable'], [proxy, 'unreadable']].entries()) {
    const v = R.validateDoc(x);
    assert.deepEqual([v.ok, v.doc, v.errors], [false, null, [err]], `case ${i}`);
    assert.deepEqual(R.validateDoc(v.doc).doc, v.doc, 'fixed point of a rejection');
  }
  const c = repairs(cyclic);
  assert.deepEqual(c.doc.children, []);
  // The JSON string as stored works like the object.
  const { d } = richDoc();
  assert.deepEqual(R.validateDoc(JSON.stringify(d)).doc, d);
  assertClean(d);
  // A minimal document is completed.
  const m = repairs({ version: 2 });
  assert.deepEqual(m.doc, Object.assign(R.emptyDoc('1970-01-01T00:00:00.000Z'), {}));
});

test('validateDoc: drops unknown fields, clamps numbers, makes status fields consistent', () => {
  const { d, a, b, t1, t2, t3 } = richDoc();
  const x = JSON.parse(JSON.stringify(d));
  x.extra = 1;
  x.parent.password = 'x';
  x.children[0].heardText = SECRET;
  x.tasks[0].transcript = SECRET;
  x.tasks[0].attempts[0].heard_text = SECRET;
  x.jar[a].ledger[0].why = 'x';
  x.surprises[0].extra = true;
  x.tasks[0].stars = 9;
  x.tasks[1].stars = 0;
  x.tasks[2].stars = 2.6;
  x.tasks[1].pass.minAccuracy = 0.95;
  x.tasks[2].pass.minAccuracy = 0.86;
  x.tasks[3].pass.minAccuracy = 0.5;
  x.jar[b].goals[0].cost = 900;
  x.jar[a].goals[0].cost = 0;
  x.parent.failedAttempts = -3;
  x.tasks[0].attempts[0].accuracy = 1.5;
  x.tasks[1].attempts[0].accuracy = -0.2;
  x.children[0].nickname = 'N'.repeat(30);
  x.children[1].quran.surah = 200;
  x.children[1].avatar = '🐷';
  x.tasks[1].quran.to = 99;
  x.tasks[0].reward.emoji = '🍰️';
  x.tasks[0].due = '2026-02-31';
  x.tasks[3].mode = 'meaning';
  x.tasks[2].mode = 'strict';
  const v = repairs(x);
  assert.equal(JSON.stringify(v.doc).includes(SECRET), false, 'unknown fields (and any transcript in them) are dropped');
  assert.equal('extra' in v.doc, false);
  assert.equal('password' in v.doc.parent, false);
  assert.equal('why' in v.doc.jar[a].ledger[0], false);
  const T = (id) => task(v.doc, id);
  assert.deepEqual([T(t1).stars, T(t2).stars, T(t3).stars], [5, 1, 3]);
  assert.deepEqual([T(t2).pass.minAccuracy, T(t3).pass.minAccuracy, v.doc.tasks[3].pass.minAccuracy], [1, 0.9, 0.8]);
  assert.deepEqual([v.doc.jar[b].goals[0].cost, v.doc.jar[a].goals[0].cost], [500, 1]);
  assert.equal(v.doc.parent.failedAttempts, 0);
  assert.deepEqual([T(t1).attempts[0].accuracy, T(t2).attempts[0].accuracy], [1, 0]);
  assert.equal(Object.is(T(t2).attempts[0].accuracy, 0), true);
  assert.equal(v.doc.children[0].nickname, 'N'.repeat(24));
  assert.equal(v.doc.children[1].quran.surah, 114);
  assert.equal(v.doc.children[1].avatar, R.AVATARS[0]);
  assert.equal(T(t2).quran.to, 50, 'at most 50 ayat');
  assert.equal(T(t1).reward.emoji, '🍰');
  assert.equal(T(t1).due, null);
  assert.equal(v.doc.tasks[3].mode, 'strict');
  assert.equal('mode' in T(t3), false, 'a dictation task has no mode');
  hasRepair(v, /^doc\.extra: unknown field, dropped$/);
  hasRepair(v, /tasks\[2\]\.mode: a dictation task has no mode/);
  // Status fields.
  const y = JSON.parse(JSON.stringify(d));
  y.tasks[0].doneAt = null; // done without doneAt
  y.tasks[0].confirmedBy = 'mother';
  y.tasks[0].rewardStatus = 'given'; // given without rewardGivenAt
  y.tasks[1].readyAt = at(5); // assigned with readyAt
  y.tasks[1].doneAt = at(5);
  y.tasks[3].readyAt = null; // ready without readyAt
  y.tasks[3].rewardStatus = 'unlocked'; // no reward
  y.tasks[2].status = 'finished';
  const w = repairs(y);
  const U = (id) => task(w.doc, id);
  assert.deepEqual([U(t1).status, U(t1).doneAt, U(t1).confirmedBy, U(t1).rewardStatus, U(t1).rewardGivenAt], ['done', U(t1).updatedAt, 'parent_override', 'given', U(t1).updatedAt]);
  assert.deepEqual([U(t2).readyAt, U(t2).doneAt], [null, null]);
  assert.deepEqual([w.doc.tasks[3].readyAt, w.doc.tasks[3].rewardStatus], [w.doc.tasks[3].updatedAt, 'none']);
  assert.equal(U(t3).status, 'assigned');
  assert.equal(U(t3).doneAt, null);
  // Its 'task' ledger entry no longer points to a confirmed task: the reference is cleared, the stars stay.
  assert.deepEqual([w.doc.jar[b].ledger[0].ref, w.doc.jar[b].balance], [null, 7]);
});

test('validateDoc: caps attempts at 20 and the ledger at 200, keeps the balance equal to the ledger', () => {
  const { d, a, b, t1 } = richDoc();
  const x = JSON.parse(JSON.stringify(d));
  const base = x.tasks[0].attempts[0];
  x.tasks[0].attempts = Array.from({ length: 30 }, (_, i) => Object.assign({}, base, { at: at(100 + i) }));
  x.jar[b].ledger = Array.from({ length: 250 }, (_, i) => ({ at: at(200 + i), delta: i % 3 === 0 ? 2 : -1, reason: 'adjust', ref: null, note: null }));
  x.jar[b].balance = 999;
  x.jar[b].earned = 1;
  const v = repairs(x);
  assert.equal(task(v.doc, t1).attempts.length, 20);
  assert.equal(task(v.doc, t1).attempts[0].at, at(110), 'the newest are kept');
  const lb = v.doc.jar[b].ledger;
  assert.equal(lb.length, 200);
  assert.equal(lb[0].reason, 'carry');
  const total = x.jar[b].ledger.reduce((s, e) => s + e.delta, 0);
  assert.deepEqual([sum(lb), v.doc.jar[b].balance, v.doc.jar[b].earned], [total, total, total]);
  hasRepair(v, /jar\.\w+\.balance: set to/);
  hasRepair(v, /earned: below the balance, raised/);
  // A negative total is corrected with an adjustment entry.
  const y = JSON.parse(JSON.stringify(d));
  y.jar[a].ledger.push({ at: at(300), delta: -50, reason: 'adjust', ref: null, note: null });
  const w = repairs(y);
  assert.deepEqual([w.doc.jar[a].balance, sum(w.doc.jar[a].ledger)], [0, 0]);
  assert.deepEqual(w.doc.jar[a].ledger.slice(-1)[0], { at: at(300), delta: 50 - d.jar[a].balance, reason: 'adjust', ref: null, note: null });
  hasRepair(w, /negative total/);
  // Bad entries.
  const z = JSON.parse(JSON.stringify(d));
  z.jar[a].ledger.push({ at: 'never', delta: 2.4, reason: 'gift', ref: 'x y' }, { delta: 'many' }, 'junk', { at: at(301), delta: 1, reason: 'goal', ref: 'nope', note: 'x' });
  const zz = repairs(z);
  assert.deepEqual(zz.doc.jar[a].ledger.slice(-2), [
    { at: d.createdAt, delta: 2, reason: 'adjust', ref: null, note: null },
    { at: at(301), delta: 1, reason: 'goal', ref: null, note: null },
  ]);
  assert.equal(zz.doc.jar[a].balance, sum(zz.doc.jar[a].ledger));
});

test('validateDoc: makes ids unique and removes dangling references', () => {
  const { d, a, b, t1, t3, goalA } = richDoc();
  const x = JSON.parse(JSON.stringify(d));
  x.children.push(Object.assign({}, x.children[0], { nickname: 'Copy' })); // duplicate child id
  x.children.push({ nickname: 'No id' });
  x.tasks.push(Object.assign({}, x.tasks[0], { title: 'Copy' })); // duplicate task id
  x.tasks.push(Object.assign({}, x.tasks[1], { id: 'orphan', childId: 'gone' })); // dangling child
  x.tasks.push(Object.assign({}, x.tasks[1], { id: 'bad id!' }));
  x.tasks.push({ id: 'nokind', childId: a, kind: 'essay' });
  x.tasks.push(Object.assign({}, x.tasks[2], { id: 'notext', text: '   ' }));
  x.jar.gone = { balance: 1, earned: 1, goals: [], ledger: [] }; // jar of no child
  delete x.jar[b]; // missing jar
  x.jar[a].goals.push(Object.assign({}, x.jar[a].goals[0])); // duplicate goal id
  x.surprises.push(Object.assign({}, x.surprises[0])); // duplicate surprise id
  x.surprises.push(Object.assign({}, x.surprises[0], { id: 's-gone', childId: 'gone' }));
  x.activeChildId = 'gone';
  x.jar[a].ledger.push({ at: at(400), delta: 2, reason: 'task', ref: t1, note: null }); // credited twice
  x.jar[a].ledger.push({ at: at(401), delta: 3, reason: 'task', ref: t3, note: null }); // a task of another child
  x.jar[a].ledger.push({ at: at(402), delta: -2, reason: 'goal', ref: goalA, note: null }); // a goal paid twice
  x.jar[a].ledger.push({ at: at(403), delta: 1, reason: 'adjust', ref: t1, note: null });
  const v = repairs(x);
  const doc = v.doc;
  assert.deepEqual(doc.children.map((c) => c.nickname), ['Sara', 'Omar']);
  assert.deepEqual(doc.tasks.map((t) => t.id), d.tasks.map((t) => t.id));
  assert.equal(task(doc, t1).title, d.tasks[0].title, 'the first of two duplicates is kept');
  assert.deepEqual(Object.keys(doc.jar).sort(), [a, b].sort());
  assert.deepEqual(doc.jar[b], { balance: 0, earned: 0, goals: [], ledger: [] }, 'a missing jar is created empty');
  assert.equal(doc.jar[a].goals.length, 1);
  assert.equal(doc.surprises.length, 1);
  assert.equal(doc.activeChildId, null);
  const tail = doc.jar[a].ledger.slice(-2);
  assert.deepEqual(tail, [
    { at: at(401), delta: 3, reason: 'task', ref: null, note: null },
    { at: at(403), delta: 1, reason: 'adjust', ref: null, note: null },
  ]);
  assert.equal(doc.jar[a].balance, sum(doc.jar[a].ledger));
  hasRepair(v, /credited twice, dropped/);
  hasRepair(v, /goal paid twice, dropped/);
  hasRepair(v, /^children\[2\]: duplicate id, dropped$/);
  hasRepair(v, /^tasks\[\d+\]: its child does not exist, dropped$/);
  hasRepair(v, /^jar\.gone: its child does not exist, dropped$/);
  // The PIN record: an invalid one is removed with its backoff.
  const y = JSON.parse(JSON.stringify(d));
  y.parent.pin = { salt: 'short', hash: 'x', iterations: 5 };
  y.parent.failedAttempts = 7;
  y.parent.lockedUntil = at(1000);
  const w = repairs(y);
  assert.deepEqual([w.doc.parent.pin, w.doc.parent.failedAttempts, w.doc.parent.lockedUntil], [null, 0, null]);
});

test('validateDoc: random corruption of a valid document is repaired to a fixed point', () => {
  const { d } = richDoc();
  const rand = mulberry32(20261111);
  const junk = [null, undefined, -1, 0, 1, 2.5, 1e12, NaN, '', 'x', 'é'.repeat(300), true, false, [], {}, [1, 2], { a: 1 }, at(5), '2026-13-01', '__proto__', '\uD800'];
  const paths = [];
  const walk = (o, p) => {
    if (o && typeof o === 'object') for (const k of Object.keys(o)) { paths.push(p.concat(k)); walk(o[k], p.concat(k)); }
  };
  walk(d, []);
  for (let i = 0; i < 600; i++) {
    const x = JSON.parse(JSON.stringify(d));
    const n = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const p = paths[Math.floor(rand() * paths.length)];
      let o = x;
      for (let j = 0; j < p.length - 1 && o && typeof o === 'object'; j++) o = o[p[j]];
      if (o && typeof o === 'object') {
        if (rand() < 0.15) delete o[p[p.length - 1]];
        else o[p[p.length - 1]] = junk[Math.floor(rand() * junk.length)];
      }
    }
    if (x.version !== 2) continue;
    const v = repairs(x);
    for (const c of v.doc.children) {
      const j = v.doc.jar[c.id];
      assert.equal(j.balance, sum(j.ledger));
      assert.ok(j.balance >= 0 && j.earned >= j.balance);
    }
  }
});

// ---------------------------------------------------------------------------
// PIN
// ---------------------------------------------------------------------------

function spySubtle() {
  const s = globalThis.crypto.subtle;
  const calls = { importKey: 0, deriveBits: 0 };
  const oi = s.importKey;
  const od = s.deriveBits;
  s.importKey = function (...args) { calls.importKey++; return oi.apply(this, args); };
  s.deriveBits = function (...args) { calls.deriveBits++; return od.apply(this, args); };
  return { calls, restore() { delete s.importKey; delete s.deriveBits; } };
}

test('PIN: 4 to 6 digits; Arabic-Indic and Eastern Arabic-Indic digits are normalised', () => {
  const ok = [['1234', '1234'], ['٠١٢٣', '0123'], ['۱۲۳۴۵۶', '123456'], [' 12 34 ', '1234'], ['‏١٢٣٤‏', '1234'], ['12٣4', '1234']];
  for (const [pin, want] of ok) assert.equal(R.normalizePin(pin), want, pin);
  for (const bad of ['123', '1234567', 'abcd', '12a4', '', 1234, null, undefined, '１２３４', '12.34']) {
    assert.equal(R.normalizePin(bad), null, String(bad));
    assert.equal(R.isValidPin(bad), false);
  }
});

test('PIN: hashPin is PBKDF2-SHA-256 with 150000 iterations and a 16-byte random salt', async () => {
  const salt = Buffer.alloc(16, 7).toString('base64');
  const h = await R.hashPin('١٢٣٤', salt);
  const want = nodeCrypto.pbkdf2Sync('1234', Buffer.from(salt, 'base64'), 150000, 32, 'sha256').toString('base64');
  assert.deepEqual(h, { salt, hash: want, iterations: 150000 });
  assert.deepEqual(await R.hashPin('1234', new Uint8Array(16).fill(7)), h);
  const r1 = await R.hashPin('1234');
  const r2 = await R.hashPin('1234');
  assert.equal(Buffer.from(r1.salt, 'base64').length, 16);
  assert.notEqual(r1.salt, r2.salt);
  assert.notEqual(r1.hash, r2.hash);
  await rejectsCode(R.hashPin('12'), 'bad_input', 'pin');
  await rejectsCode(R.hashPin('1234', 'c2hvcnQ='), 'bad_input', 'salt');
});

test('PIN: setPin and verifyPin, with Arabic digits; no PIN or a malformed one is refused', async () => {
  const { d } = family();
  await rejectsCode(R.verifyPin(d, '1234', at(10)), 'bad_state', 'pin');
  await rejectsCode(R.setPin(d, '12', at(10)), 'bad_input', 'pin');
  const p = await R.setPin(d, '۲۴۶۸', at(10));
  assert.equal(p.parent.pin.iterations, 150000);
  assert.equal(p.updatedAt, at(10));
  assertClean(p);
  for (const pin of ['2468', '٢٤٦٨', '۲۴۶۸']) {
    const r = await R.verifyPin(p, pin, at(11));
    assert.equal(r.ok, true, pin);
    assert.deepEqual(r.doc, p, 'a first success changes nothing');
  }
  const wrong = await R.verifyPin(p, '1357', at(12));
  assert.deepEqual([wrong.ok, wrong.code, wrong.attemptsLeft, wrong.doc.parent.failedAttempts, wrong.lockedUntil], [false, 'wrong_pin', 4, 1, undefined]);
  await rejectsCode(R.verifyPin(wrong.doc, '12', at(13)), 'bad_input', 'pin');
  const good = await R.verifyPin(wrong.doc, '2468', at(13));
  assert.deepEqual([good.ok, good.doc.parent.failedAttempts, good.doc.parent.lockedUntil], [true, 0, null]);
  // Forgot PIN: cleared after the parental gate, all data kept.
  const c = R.clearPin(wrong.doc, at(14));
  assert.deepEqual(c.parent, Object.assign({}, d.parent, { pin: null, failedAttempts: 0, lockedUntil: null }));
  assert.deepEqual(c.children, d.children);
  assertClean(c);
  assert.deepEqual(R.pinStatus(c, at(14)), { hasPin: false, failedAttempts: 0, locked: false, lockedUntil: null, retryInMs: 0, attemptsLeft: 5 });
});

test('PIN backoff: after 5 failures lock 30 s, doubling to 15 min; no hashing while locked; survives a reload', async () => {
  const { d } = family();
  let doc = await R.setPin(d, '2468', at(0));
  let r;
  for (let i = 1; i <= 4; i++) {
    r = await R.verifyPin(doc, '0000', at(i));
    assert.deepEqual([r.code, r.attemptsLeft, r.lockedUntil, r.doc.parent.lockedUntil], ['wrong_pin', 5 - i, undefined, null]);
    doc = r.doc;
  }
  r = await R.verifyPin(doc, '0000', at(10));
  assert.deepEqual([r.code, r.retryInMs, r.lockedUntil, r.doc.parent.failedAttempts], ['wrong_pin', 30000, at(40), 5]);
  doc = r.doc;
  assertClean(doc);
  // While locked: refused at once, even the right PIN, without hashing; the state survives a reload.
  const spy = spySubtle();
  try {
    const reloaded = R.validateDoc(JSON.parse(JSON.stringify(doc))).doc;
    for (const pin of ['2468', '0000', 'garbage']) {
      const l = await R.verifyPin(reloaded, pin, at(25));
      assert.deepEqual([l.ok, l.code, l.retryInMs, l.lockedUntil], [false, 'locked', 15000, at(40)]);
      assert.deepEqual(l.doc, reloaded);
    }
    assert.deepEqual(spy.calls, { importKey: 0, deriveBits: 0 }, 'no hashing while locked');
    assert.deepEqual(R.pinStatus(reloaded, at(25)), { hasPin: true, failedAttempts: 5, locked: true, lockedUntil: at(40), retryInMs: 15000, attemptsLeft: 0 });
  } finally {
    spy.restore();
  }
  // Each further failure doubles the lock, up to 15 minutes.
  let t = 40;
  for (const want of [60, 120, 240, 480, 900, 900, 900]) {
    r = await R.verifyPin(doc, '0000', at(t));
    assert.equal(r.code, 'wrong_pin');
    assert.equal(r.retryInMs, want * 1000);
    doc = r.doc;
    const l = await R.verifyPin(doc, '2468', at(t + want - 1));
    assert.equal(l.code, 'locked');
    t += want;
  }
  assert.equal(doc.parent.failedAttempts, 12);
  // After the lock the right PIN works and clears the backoff.
  r = await R.verifyPin(doc, '٢٤٦٨', at(t));
  assert.deepEqual([r.ok, r.doc.parent.failedAttempts, r.doc.parent.lockedUntil, r.doc.updatedAt], [true, 0, null, at(t)]);
  assertClean(r.doc);
  // A lock further away than 15 min (the clock went back) counts as 15 min.
  const back = JSON.parse(JSON.stringify(doc));
  back.parent.lockedUntil = at(t + 86400);
  const l = await R.verifyPin(back, '2468', at(t));
  assert.deepEqual([l.code, l.retryInMs, l.doc.parent.lockedUntil], ['locked', 900000, at(t + 900)]);
  assert.equal(R.pinStatus(back, at(t)).retryInMs, 900000);
});

// ---------------------------------------------------------------------------
// Seeded random sequence: invariants after every operation
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('random sequence: 3500 seeded operations over 3 children keep every invariant', () => {
  const rand = mulberry32(0x5eed2026);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  let idN = 0;
  const opts = { newId: () => `x${(++idN).toString(36)}` };
  let clock = 0;
  const now = () => at((clock += int(1, 400)));
  const model = { balance: new Map(), earned: new Map(), credited: new Set() };
  const stats = {};
  const count = (k) => { stats[k] = (stats[k] || 0) + 1; };

  let doc = R.emptyDoc(at(0));
  const addKid = () => {
    const r = R.addChild(doc, { nickname: pick(['Sara', 'Omar', 'Lina', 'Adam', 'سارة', 'Léa']), age: pick(R.AGE_BANDS), lang: pick(R.LANGS) }, now(), opts);
    model.balance.set(r.child.id, 0);
    model.earned.set(r.child.id, 0);
    return r.doc;
  };
  for (let i = 0; i < 3; i++) doc = addKid();
  const permanent = doc.children[0].id;

  const kid = () => (rand() < 0.5 ? permanent : pick(doc.children).id);
  // Mostly a task still in play (to do or waiting), sometimes any task (done, archived).
  const anyTask = () => {
    const live = doc.tasks.filter((t) => t.status === 'assigned' || t.status === 'ready');
    if (live.length && rand() < 0.7) return pick(live);
    return doc.tasks.length ? pick(doc.tasks) : null;
  };
  const reward = () => ({ text: pick(['Ice cream', 'Park', 'Book', 'Cake', 'نزهة']), emoji: pick(R.REWARD_EMOJIS) });
  const expectErr = (fn, code) => {
    throwsCode(fn, code);
    count('error:' + code);
  };
  const credit = (cid, stars) => {
    model.balance.set(cid, model.balance.get(cid) + stars);
    model.earned.set(cid, model.earned.get(cid) + stars);
  };

  function randomResult(t) {
    const n = int(1, 30);
    const m = int(Math.max(0, n - 4), n);
    const ins = rand() < 0.2 ? 1 : 0;
    const sayAgain = rand() < 0.05;
    const min = t.pass.minAccuracy;
    // Exact integer arithmetic: m/n >= 0.9 is 10m >= 9n. word_accuracy counts matched words only.
    const wordsPass = !sayAgain && (min === 1 ? m === n : m * 10 >= Math.round(min * 10) * n);
    if (t.kind === 'quran') {
      if (rand() < 0.08) return { res: reciteStrict(n, m), fits: false };
      const quranPass = !sayAgain && (min === 1 ? m === n && ins === 0 : m * 10 >= Math.round(min * 10) * n);
      return { res: quranRes(n, m, ins, sayAgain), fits: true, passed: quranPass };
    }
    if (t.kind === 'recite' && t.mode === 'contextual') {
      if (rand() < 0.08) return { res: reciteStrict(n, m), fits: false };
      const verdict = sayAgain ? 'unclear' : pick(['same_meaning', 'same_meaning', 'partly', 'different']);
      const missing = rand() < 0.3 ? ['an idea'] : [];
      return { res: reciteMeaning(verdict, missing, sayAgain), fits: true, passed: verdict === 'same_meaning' && missing.length === 0 && !sayAgain };
    }
    if (rand() < 0.08) return { res: pick([reciteMeaning('same_meaning'), t.kind === 'recite' ? dictationRes(n, m) : reciteStrict(n, m)]), fits: false };
    const res = t.kind === 'recite' ? reciteStrict(n, m, ins, sayAgain) : dictationRes(n, m, ins);
    if (t.kind === 'dictation' && sayAgain) {
      res.result.say_again = true;
      res.result.verdict = 'unclear';
    }
    return { res, fits: true, passed: wordsPass };
  }

  const OPS = [
    [6, 'createTask'], [24, 'recordAttempt'], [11, 'confirmTask'], [4, 'sendBack'], [3, 'archiveTask'], [4, 'updateTask'],
    [4, 'markRewardGiven'], [4, 'addGoal'], [6, 'giveGoal'], [2, 'removeGoal'], [16, 'adjustStars'], [3, 'addSurprise'],
    [3, 'markSurpriseSeen'], [2, 'setActiveChild'], [2, 'updateChild'], [0.4, 'replaceChild'], [2, 'badInput'],
  ];
  const totalW = OPS.reduce((s, [w]) => s + w, 0);
  const chooseOp = () => {
    let x = rand() * totalW;
    for (const [w, name] of OPS) if ((x -= w) < 0) return name;
    return OPS[0][1];
  };

  const N = 3500;
  for (let step = 0; step < N; step++) {
    deepFreeze(doc);
    const op = chooseOp();
    count(op);
    switch (op) {
      case 'createTask': {
        const kind = pick(R.KINDS);
        const input = { childId: kid(), kind, stars: int(1, 5), pass: { minAccuracy: pick(R.MIN_ACCURACIES) } };
        if (kind === 'quran') {
          const from = int(1, 20);
          input.quran = { surah: int(78, 114), from, to: from + int(0, 5), memory: rand() < 0.5 };
          if (rand() < 0.1) {
            input.mode = pick(['strict', 'contextual']);
            expectErr(() => R.createTask(doc, input, now(), opts), 'bad_input');
            break;
          }
        } else {
          input.text = pick([TEXT_EN, TEXT_AR, 'Le petit chat dort sur le tapis']);
          input.lang = pick(R.LANGS);
          if (kind === 'recite' && rand() < 0.5) input.mode = pick(R.MODES);
        }
        if (rand() < 0.5) input.reward = reward();
        if (rand() < 0.3) input.due = '2026-12-0' + int(1, 9);
        const r = R.createTask(doc, input, now(), opts);
        assert.equal(r.task.status, 'assigned');
        doc = r.doc;
        break;
      }
      case 'recordAttempt': {
        const t = anyTask();
        if (!t) break;
        const { res, fits, passed } = randomResult(t);
        if (!fits) {
          expectErr(() => R.recordAttempt(doc, t.id, res, now()), 'bad_input');
          break;
        }
        const r = R.recordAttempt(doc, t.id, res, now());
        assert.equal(r.passed, passed, JSON.stringify({ t: t.kind, mode: t.mode, min: t.pass.minAccuracy, res: res.result || res.judgement || res }));
        assert.equal(r.becameReady, t.status === 'assigned' && passed);
        assert.equal(r.task.status, r.becameReady ? 'ready' : t.status);
        assert.equal(r.task.attempts.length, Math.min(20, t.attempts.length + 1));
        doc = r.doc;
        break;
      }
      case 'confirmTask': {
        const t = anyTask();
        if (!t) break;
        const how = pick(['app_pass', 'parent_override']);
        const ok = (how === 'app_pass' && t.status === 'ready') || (how === 'parent_override' && t.status === 'assigned');
        if (!ok) {
          expectErr(() => R.confirmTask(doc, t.id, how, now()), 'bad_state');
          break;
        }
        assert.equal(model.credited.has(t.id), false, 'a task is credited only once');
        model.credited.add(t.id);
        doc = R.confirmTask(doc, t.id, how, now());
        credit(t.childId, t.stars);
        const after = task(doc, t.id);
        assert.deepEqual([after.status, after.confirmedBy, after.rewardStatus], ['done', how, t.reward ? 'unlocked' : 'none']);
        count('confirmed');
        break;
      }
      case 'sendBack': {
        const t = anyTask();
        if (!t) break;
        if (t.status !== 'ready' && t.status !== 'assigned') {
          expectErr(() => R.sendBack(doc, t.id, null, now()), 'bad_state');
          break;
        }
        doc = R.sendBack(doc, t.id, rand() < 0.5 ? 'Try the last line again' : null, now());
        assert.equal(task(doc, t.id).status, 'assigned');
        break;
      }
      case 'archiveTask': {
        const t = anyTask();
        if (!t) break;
        if (t.status === 'archived') {
          expectErr(() => R.archiveTask(doc, t.id, now()), 'bad_state');
          break;
        }
        doc = R.archiveTask(doc, t.id, now());
        break;
      }
      case 'updateTask': {
        const t = anyTask();
        if (!t) break;
        if (t.kind === 'quran' && rand() < 0.2) {
          expectErr(() => R.updateTask(doc, t.id, { mode: 'strict' }, now()), 'bad_input');
          break;
        }
        const patch = pick([{ stars: int(1, 5) }, { title: 'Renamed' }, { reward: rand() < 0.5 ? null : reward() }, { due: null }, { pass: { minAccuracy: pick(R.MIN_ACCURACIES) } }]);
        if (t.status !== 'assigned' && t.status !== 'ready') {
          expectErr(() => R.updateTask(doc, t.id, patch, now()), 'bad_state');
          break;
        }
        doc = R.updateTask(doc, t.id, patch, now());
        const after = task(doc, t.id);
        if (!patch.pass) assert.equal(after.status, t.status, 'a change of stars, title, reward or due keeps the status');
        break;
      }
      case 'markRewardGiven': {
        const t = anyTask();
        if (!t) break;
        if (t.rewardStatus !== 'unlocked') {
          expectErr(() => R.markRewardGiven(doc, t.id, now()), 'bad_state');
          break;
        }
        doc = R.markRewardGiven(doc, t.id, now());
        count('rewardGiven');
        break;
      }
      case 'addGoal':
        doc = R.addGoal(doc, kid(), { cost: int(1, 25), reward: reward() }, now(), opts).doc;
        break;
      case 'giveGoal': {
        const cid = kid();
        const goals = doc.jar[cid].goals;
        if (!goals.length) break;
        const g = pick(goals);
        const bal = doc.jar[cid].balance;
        if (g.status !== 'open') expectErr(() => R.giveGoal(doc, cid, g.id, now()), 'bad_state');
        else if (bal < g.cost) expectErr(() => R.giveGoal(doc, cid, g.id, now()), 'insufficient_stars');
        else {
          doc = R.giveGoal(doc, cid, g.id, now());
          model.balance.set(cid, bal - g.cost);
          count('goalGiven');
        }
        break;
      }
      case 'removeGoal': {
        const cid = kid();
        const goals = doc.jar[cid].goals;
        if (!goals.length) break;
        doc = R.removeGoal(doc, cid, pick(goals).id, now());
        break;
      }
      case 'adjustStars': {
        const cid = kid();
        let delta = int(-15, 20);
        if (delta === 0) delta = 1;
        const bal = model.balance.get(cid);
        const eff = delta < 0 ? Math.max(delta, -bal) : delta;
        if (eff === 0) {
          expectErr(() => R.adjustStars(doc, cid, delta, now()), 'insufficient_stars');
          break;
        }
        doc = R.adjustStars(doc, cid, delta, now(), rand() < 0.3 ? 'Correction' : null);
        model.balance.set(cid, bal + eff);
        model.earned.set(cid, eff > 0 ? model.earned.get(cid) + eff : Math.max(bal + eff, model.earned.get(cid) + eff));
        break;
      }
      case 'addSurprise':
        doc = R.addSurprise(doc, kid(), reward(), now(), opts).doc;
        break;
      case 'markSurpriseSeen':
        if (doc.surprises.length) doc = R.markSurpriseSeen(doc, pick(doc.surprises).id, now());
        break;
      case 'setActiveChild':
        doc = R.setActiveChild(doc, rand() < 0.2 ? null : pick(doc.children).id, now());
        break;
      case 'updateChild':
        doc = R.updateChild(doc, pick(doc.children).id, { quran: { surah: int(1, 114), from: 1, to: int(1, 7) }, avatar: pick(R.AVATARS) }, now());
        break;
      case 'replaceChild': {
        const others = doc.children.filter((c) => c.id !== permanent);
        const victim = pick(others);
        doc = R.removeChild(doc, victim.id, now());
        assert.equal(doc.tasks.some((t) => t.childId === victim.id) || doc.surprises.some((s) => s.childId === victim.id) || victim.id in doc.jar, false);
        model.balance.delete(victim.id);
        model.earned.delete(victim.id);
        doc = addKid();
        break;
      }
      case 'badInput': {
        const t = anyTask();
        const cases = [
          () => expectErr(() => R.confirmTask(doc, 'missing', 'app_pass', now()), 'not_found'),
          () => expectErr(() => R.giveGoal(doc, kid(), 'missing', now()), 'not_found'),
          () => expectErr(() => R.adjustStars(doc, kid(), 0, now()), 'bad_input'),
          () => expectErr(() => R.createTask(doc, { childId: kid(), kind: 'recite', text: '', lang: 'en' }, now()), 'bad_input'),
          () => t && expectErr(() => R.confirmTask(doc, t.id, 'sure', now()), 'bad_input'),
        ];
        pick(cases)();
        break;
      }
      default:
        throw new Error(op);
    }

    // Invariants after every operation.
    assert.equal(doc.children.length, 3);
    for (const c of doc.children) {
      const j = doc.jar[c.id];
      assert.equal(j.balance, sum(j.ledger), 'balance === sum of ledger deltas');
      assert.ok(j.balance >= 0, 'balance >= 0');
      assert.ok(j.earned >= j.balance, 'earned >= balance');
      assert.equal(j.balance, model.balance.get(c.id), 'balance follows the operations');
      assert.equal(j.earned, model.earned.get(c.id), 'earned follows the operations');
      assert.ok(j.ledger.length <= 200);
      const refs = j.ledger.filter((e) => e.reason === 'task' && e.ref !== null).map((e) => e.ref);
      assert.equal(new Set(refs).size, refs.length, "no task's stars are credited twice");
      for (const ref of refs) assert.ok(model.credited.has(ref));
    }
    for (const t of doc.tasks) {
      assert.ok(t.attempts.length <= 20);
      assert.equal(t.doneAt !== null, model.credited.has(t.id), 'a task is done (or archived after done) exactly when it was credited');
      if (t.kind === 'quran') assert.equal('mode' in t, false);
    }
    const v = R.validateDoc(doc);
    assert.equal(v.ok, true);
    assert.deepEqual(v.repaired, [], 'validateDoc repairs nothing in a document the API made');
    assert.deepEqual(v.doc, doc, 'validateDoc is a fixed point');
    const round = JSON.parse(JSON.stringify(doc));
    assert.deepEqual(round, doc, 'JSON round trip');
    doc = round; // as if saved and loaded again
  }
  // The sequence really exercised the interesting paths.
  assert.ok(N >= 3000);
  assert.ok(stats.confirmed >= 50, JSON.stringify(stats));
  assert.ok(stats.goalGiven >= 10, JSON.stringify(stats));
  assert.ok(stats.rewardGiven >= 5, JSON.stringify(stats));
  assert.ok(stats['error:bad_state'] >= 50 && stats['error:bad_input'] >= 20 && stats['error:insufficient_stars'] >= 5, JSON.stringify(stats));
  assert.ok(doc.jar[permanent].ledger[0].reason === 'carry', 'the ledger cap was reached');
  assert.equal(JSON.stringify(doc).includes(SECRET), false, 'no transcript or feedback was stored');
});

// ---------------------------------------------------------------------------
// Review fixes: the PIN check apart from the document (RL-3), "Forgot PIN" that never
// leaves the family without a PIN (UX-01, RL-4), Quran results on school tasks (RL-8)
// and repair notes of inherited keys (RL-9).
// ---------------------------------------------------------------------------

test('PIN: checkPin hashes without the document; applyPinCheck counts on the document as it is now', async () => {
  const { d } = family();
  const p = deepFreeze(await R.setPin(d, '2468', at(10)));
  const right = await R.checkPin(p, '2468', at(11));
  const wrong = await R.checkPin(p, '1357', at(11));
  assert.deepEqual([right.locked, right.match, wrong.locked, wrong.match], [false, true, false, false]);
  assert.equal(right.hash, p.parent.pin.hash);
  // Meanwhile another tab added a child: applying the outcome keeps it.
  const other = deepFreeze(R.addChild(p, { nickname: 'Other tab' }, at(12), { newId: () => 'tab2' }).doc);
  const ok = R.applyPinCheck(other, right, at(13));
  assert.equal(ok.ok, true);
  assert.ok(ok.doc.children.some((c) => c.nickname === 'Other tab'));
  // Three tabs at 4 failures each fail at the same moment: every failure counts.
  let doc = p;
  for (let i = 0; i < 4; i++) doc = R.applyPinCheck(doc, wrong, at(14)).doc;
  const checks = await Promise.all([1, 2, 3].map(() => R.checkPin(doc, '0000', at(15))));
  for (const c of checks) doc = R.applyPinCheck(doc, c, at(15)).doc;
  assert.equal(doc.parent.failedAttempts, 7);
  assert.equal(R.pinStatus(doc, at(15)).retryInMs, 120000, 'the 7th failure locks for 2 min');
  // While locked, checkPin answers at once and never hashes.
  const locked = await R.checkPin(doc, '2468', at(16));
  assert.deepEqual([locked.locked, typeof locked.retryInMs], [true, 'number']);
  // A PIN changed since the check: the outcome does not apply.
  const changed = R.setPinRecord(p, await R.hashPin('9999'), at(17));
  const stale = R.applyPinCheck(changed, right, at(18));
  assert.deepEqual([stale.ok, stale.code], [false, 'stale']);
  throwsCode(() => R.applyPinCheck(p, { match: 'yes' }, at(18)), 'bad_input', 'check');
  assertClean(ok.doc);
  assertClean(doc);
});

test('PIN: a forgotten PIN is replaced in one step, marked, and gate answers count', async () => {
  const { d } = family();
  const p = deepFreeze(await R.setPin(d, '2468', at(10)));
  const rec = await R.hashPin('1111');
  // Until the new PIN is set, the old one stays (no clearPin before it).
  const reset = R.setPinRecord(p, rec, at(20), { reset: true });
  assert.deepEqual([reset.parent.pinResetAt, reset.parent.failedAttempts, reset.parent.lockedUntil], [at(20), 0, null]);
  assert.equal((await R.verifyPin(reset, '1111', at(21))).ok, true);
  assert.equal((await R.verifyPin(reset, '2468', at(21))).ok, false);
  assertClean(reset);
  const changed = R.setPinRecord(reset, await R.hashPin('2222'), at(22));
  assert.equal(changed.parent.pinResetAt, at(20), 'a change in Settings keeps the notice');
  assert.equal(R.dismissPinReset(changed, at(23)).parent.pinResetAt, null);
  for (const bad of [null, {}, { salt: rec.salt, hash: rec.hash }, { ...rec, extra: 1 }, { ...rec, hash: 'c2hvcnQ=' }]) {
    throwsCode(() => R.setPinRecord(p, bad, at(24)), 'bad_input', 'record');
  }
  // Wrong gate answers use the same backoff, with or without a PIN (a migrated family
  // answers the gate before its first PIN); validateDoc keeps that backoff.
  for (const start of [p, d]) {
    let doc = start;
    let r;
    for (let i = 0; i < 5; i++) r = R.applyPinCheck(doc, { match: false }, at(30)), doc = r.doc;
    assert.deepEqual([r.code, r.retryInMs, R.pinStatus(doc, at(31)).locked], ['wrong_pin', 30000, true]);
    assertClean(doc);
  }
  // A document saved before pinResetAt existed reads as null, with no repair.
  const old = JSON.parse(JSON.stringify(p));
  delete old.parent.pinResetAt;
  const v = R.validateDoc(old);
  assert.deepEqual([v.ok, v.repaired, v.doc.parent.pinResetAt], [true, [], null]);
  // An invalid PIN record still takes its backoff along.
  const broken = JSON.parse(JSON.stringify(p));
  broken.parent.pin = { salt: 'x', hash: 'y', iterations: 1 };
  broken.parent.failedAttempts = 3;
  assert.deepEqual([R.validateDoc(broken).doc.parent.failedAttempts, R.validateDoc(broken).doc.parent.pin], [0, null]);
});

test('pass rules: a Quran check result never counts for a recite or dictation task', () => {
  const { d, a } = family();
  for (const kind of ['recite', 'dictation']) {
    const { doc, task } = R.createTask(d, { childId: a, kind, text: TEXT_AR, lang: 'ar' }, at(1), { newId: ids('t' + kind) });
    const quranBody = { first_error: null, n_errors: 0, n_expected: 4, word_accuracy: 1, verdict: 'correct' };
    assert.equal(R.passes(task, quranBody), false, kind);
    assert.equal(R.readResult(task, quranBody), null, kind);
    throwsCode(() => R.recordAttempt(doc, task.id, quranBody, at(2)), 'bad_input', 'result');
    assert.equal(R.passes(task, { tolerated: [], n_errors: 0, n_expected: 4, word_accuracy: 1 }), false);
  }
});

test('validateDoc: repair notes never read inherited values', () => {
  const { d } = family();
  const x = JSON.parse(JSON.stringify(d));
  x.parent = JSON.parse(JSON.stringify(x.parent).replace(/^\{/, '{"__proto__":{"a":1},"toString":1,"constructor":2,'));
  const v = R.validateDoc(x);
  assert.equal(v.ok, true);
  for (const r of v.repaired) assert.match(r, /: unknown field, dropped$/, r);
  assert.equal(v.repaired.length, 3);
});

// ---------------------------------------------------------------------------
// A copy of the family list ("Save a copy", "Load a copy")
// ---------------------------------------------------------------------------

/** richDoc with a PIN, a pause in progress, a PIN reset and both consents (this device's). */
async function deviceDoc() {
  const r = richDoc();
  let d = R.updateParent(r.d, { consent: true, aiConsent: true, uiLang: 'fr' }, at(30));
  d = await R.setPin(d, '2468', at(31));
  d = R.applyPinCheck(d, { match: false }, at(32)).doc;
  return Object.assign(r, { d });
}

const copyText = (copy) => JSON.stringify(copy);
const familyPart = (d) => {
  const f = Object.assign({}, d);
  delete f.parent;
  return f;
};

test('family copy: the format, and the round trip (save, load, use) keeps the whole family', async () => {
  const { d } = await deviceDoc();
  const frozen = deepFreeze(JSON.parse(JSON.stringify(d)));
  const copy = R.makeFamilyCopy(frozen, at(40));
  assert.deepEqual(Object.keys(copy), ['app', 'kind', 'version', 'savedAt', 'family']);
  assert.deepEqual([copy.app, copy.kind, copy.version, copy.savedAt], ['mommy', 'family-copy', 1, at(40)]);
  assert.deepEqual(R.FAMILY_COPY, { app: 'mommy', kind: 'family-copy', version: 1, maxBytes: 2 * 1024 * 1024 });
  assert.ok(Object.isFrozen(R.FAMILY_COPY));
  assert.deepEqual(copy.family, familyPart(d));
  const text = copyText(copy);
  assert.match(text, /^\{"app":"mommy","kind":"family-copy","version":1,"savedAt":"/);
  const r = R.readFamilyCopy(text);
  assert.deepEqual([r.ok, r.error, r.savedAt, r.repairs], [true, null, at(40), []]);
  assert.deepEqual(r.family, familyPart(d));
  // Another device (a new address): its own parent, the family of the copy.
  let other = R.updateParent(R.emptyDoc(at(50), { uiLang: 'ar' }), { consent: true }, at(51));
  other = deepFreeze(await R.setPin(other, '1357', at(52)));
  const used = R.useFamilyCopy(other, deepFreeze(r.family), at(60));
  assertClean(used);
  assert.deepEqual(used.parent, other.parent, 'the PIN, the backoff, the consents and the language of this device stay');
  assert.deepEqual(familyPart(used), Object.assign(familyPart(d), { updatedAt: at(60) }));
  // Saving the device that used it gives the same family again.
  assert.deepEqual(R.makeFamilyCopy(used, at(61)).family, familyPart(used));
  // makeFamilyCopy checks its arguments.
  throwsCode(() => R.makeFamilyCopy(d, 'now'), 'bad_input', 'now');
  for (const bad of [null, {}, { version: 1 }, []]) throwsCode(() => R.makeFamilyCopy(bad, at(40)), 'bad_input', 'doc');
  // useFamilyCopy refuses what is not a family, and changes nothing.
  for (const bad of [null, 'x', [], { version: 3 }, { version: '2' }]) throwsCode(() => R.useFamilyCopy(other, bad, at(60)), 'bad_input', 'family');
  throwsCode(() => R.useFamilyCopy(other, r.family, 'later'), 'bad_input', 'now');
});

test('family copy: the PIN record, its backoff and reset, the consents and the parent\'s language are left out', async () => {
  const { d } = await deviceDoc();
  const reset = R.applyPinCheck(R.setPinRecord(d, await R.hashPin('9753'), at(41), { reset: true }), { match: false }, at(41)).doc;
  for (const doc of [d, reset]) {
    assert.ok(doc.parent.pin && doc.parent.consentAt && doc.parent.aiConsentAt && doc.parent.aiConsentVersion && doc.parent.failedAttempts);
    const copy = R.makeFamilyCopy(doc, at(42));
    assert.equal('parent' in copy.family, false);
    const text = copyText(copy);
    for (const secret of [doc.parent.pin.salt, doc.parent.pin.hash]) assert.ok(!text.includes(secret), 'no salt or hash in the file');
    for (const word of ['"pin"', 'salt', 'hash', 'iterations', 'consent', 'Consent', 'failedAttempts', 'lockedUntil', 'pinResetAt', 'uiLang', '"parent"']) {
      assert.ok(!text.includes(word), `${word} is not in the file`);
    }
  }
  assert.ok(reset.parent.pinResetAt);
  // A file that holds a parent anyway (written by hand) never gives it to this device.
  const copy = R.makeFamilyCopy(d, at(42));
  copy.family.parent = d.parent;
  const r = R.readFamilyCopy(copyText(copy));
  assert.equal(r.ok, true);
  assert.deepEqual(r.repairs, ['family.parent: never read from a copy, dropped']);
  assert.equal('parent' in r.family, false);
  const fresh = R.emptyDoc(at(50));
  const used = R.useFamilyCopy(fresh, Object.assign({}, r.family, { parent: d.parent }), at(51));
  assert.deepEqual(used.parent, fresh.parent, 'useFamilyCopy takes no parent from the family either');
});

test('family copy: every refusal (too big, not a copy, newer version, damaged), and readFamilyCopy never throws', () => {
  const { d } = richDoc();
  const copy = R.makeFamilyCopy(d, at(40));
  const text = copyText(copy);
  const MAX = R.FAMILY_COPY.maxBytes;
  const with_ = (patch) => copyText(Object.assign({}, copy, patch));
  const famWith = (patch) => with_({ family: Object.assign({}, copy.family, patch) });
  const refuse = (input, error, label) => {
    const r = R.readFamilyCopy(input);
    assert.deepEqual(r, { ok: false, error, family: null, savedAt: null, repairs: [] }, label);
  };
  // Size: 2 MB of UTF-8 is the limit (JSON allows white space at the end).
  const pad = (s, bytes) => s + ' '.repeat(bytes - Buffer.byteLength(s, 'utf8'));
  assert.equal(R.readFamilyCopy(pad(text, MAX)).ok, true, 'exactly 2 MB is read');
  refuse(pad(text, MAX + 1), 'too_big', 'one byte more');
  // Bytes are counted, not characters: 1.1 million Arabic letters are 2.2 MB.
  const arabic = text.slice(0, -1) + ',"pad":"' + 'ب'.repeat(1100000) + '"}';
  assert.ok(arabic.length < MAX && Buffer.byteLength(arabic, 'utf8') > MAX);
  refuse(arabic, 'too_big', 'Arabic letters');
  const emoji = text.slice(0, -1) + ',"pad":"' + '⭐'.repeat(700000) + '"}';
  assert.ok(emoji.length < MAX && Buffer.byteLength(emoji, 'utf8') > MAX);
  refuse(emoji, 'too_big', 'three-byte characters');
  const astral = text.slice(0, -1) + ',"pad":"' + '🐱'.repeat(530000) + '"}';
  assert.ok(astral.length > MAX / 2 && Buffer.byteLength(astral, 'utf8') > MAX && astral.length < MAX);
  refuse(astral, 'too_big', 'four-byte characters');
  // Not a copy: another file, other JSON, another app or kind (the stored document itself too).
  for (const [i, x] of [undefined, null, 42, {}, '', 'hello', '\x89PNG\r\n\x1a\n', '<html></html>', '[]', '[1,2]', '"text"', '12', 'null', '{}',
    JSON.stringify(d), with_({ app: 'other' }), with_({ app: 'Mommy' }), with_({ kind: 'family' }), with_({ kind: undefined }),
    copyText({ kind: 'family-copy', version: 1, family: copy.family })].entries()) refuse(x, 'not_copy', `not a copy ${i}`);
  // A newer version: of the copy, or of the family document in it.
  refuse(with_({ version: 2 }), 'newer_version', 'copy version 2');
  refuse(with_({ version: 17 }), 'newer_version', 'copy version 17');
  refuse(famWith({ version: 3 }), 'newer_version', 'family version 3');
  // Damaged: cut short, another version that is not a newer one, no family, a family that
  // validateDoc rejects.
  for (const cut of [14, 20, 50, 200, text.length - 1]) refuse(text.slice(0, cut), 'damaged', `cut at ${cut}`);
  refuse(text.slice(0, 10), 'not_copy', 'too short to tell');
  refuse('  \n' + JSON.stringify(copy, null, 2).slice(0, 300), 'damaged', 'a pretty-printed copy cut short');
  for (const [i, v] of [0, -1, 1.5, '1', null, undefined, true].entries()) refuse(with_({ version: v }), 'damaged', `version ${i}`);
  for (const [i, f] of [undefined, null, 'x', 1, [], [copy.family]].entries()) refuse(with_({ family: f }), 'damaged', `family ${i}`);
  for (const [i, v] of [1, 0, '2', null, 2.5].entries()) refuse(famWith({ version: v }), 'damaged', `family version ${i}`);
  refuse(copyText(Object.assign({}, copy, { family: (() => { const f = Object.assign({}, copy.family); delete f.version; return f; })() })), 'damaged', 'no family version');
  // Never throws, whatever it is given.
  const proxy = new Proxy({}, { get() { throw new Error('boom'); } });
  for (const x of [proxy, Symbol('s'), () => 1, new String(text)]) assert.equal(R.readFamilyCopy(x).ok, false);
  // A byte-order mark is allowed; white space around the JSON too.
  assert.equal(R.readFamilyCopy('﻿' + text).ok, true);
  assert.equal(R.readFamilyCopy('\n ' + JSON.stringify(copy, null, 2) + '\n').ok, true);
});

test('family copy: "__proto__" and "constructor" keys anywhere pollute nothing and stay data', () => {
  const { d, a } = richDoc();
  const copy = R.makeFamilyCopy(d, at(40));
  // JSON.parse makes an own "__proto__" property; here it is written into the text.
  const evil = '{"polluted":"yes","toString":"no","hasOwnProperty":"no"}';
  let text = copyText(copy);
  text = text.replace(/^\{/, `{"__proto__":${evil},"constructor":{"prototype":${evil}},`);
  text = text.replace('"family":{', `"family":{"__proto__":${evil},"constructor":${evil},`);
  text = text.replace('"children":[{', `"children":[{"__proto__":${evil},`);
  text = text.replace('"jar":{', `"jar":{"__proto__":{"balance":500},"constructor":{"balance":400},`);
  text = text.replace('"tasks":[{', `"tasks":[{"__proto__":${evil},`);
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const r = R.readFamilyCopy(text);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  assert.equal({}.polluted, undefined);
  assert.equal(typeof {}.toString, 'function');
  const objects = [r, r.family, r.family.jar, ...r.family.children, ...r.family.tasks, ...Object.values(r.family.jar)];
  for (const o of objects) {
    assert.equal(Object.getPrototypeOf(o), Object.prototype);
    assert.equal(o.polluted, undefined);
  }
  assert.deepEqual(Object.keys(r.family.jar).sort(), d.children.map((c) => c.id).sort(), 'no jar of a child that does not exist');
  assert.deepEqual(r.family.jar, d.jar);
  for (const re of [/^copy\.__proto__: unknown field, dropped$/, /^copy\.constructor: unknown field, dropped$/, /^family\.__proto__: unknown field, dropped$/,
    /^family\.constructor: unknown field, dropped$/, /^children\[0\]\.__proto__: unknown field, dropped$/, /^jar\.__proto__: its child does not exist, dropped$/,
    /^jar\.constructor: its child does not exist, dropped$/, /^tasks\[0\]\.__proto__: unknown field, dropped$/]) {
    assert.ok(r.repairs.some((x) => re.test(x)), `${re} in ${JSON.stringify(r.repairs)}`);
  }
  // A child whose id is "constructor" is an ordinary child (its jar is its own).
  const x = JSON.parse(JSON.stringify(copy));
  x.family.children[0].id = 'constructor';
  x.family.tasks = x.family.tasks.map((t) => (t.childId === a ? Object.assign(t, { childId: 'constructor' }) : t));
  x.family.jar = { constructor: x.family.jar[a], [d.children[1].id]: x.family.jar[d.children[1].id] };
  x.family.surprises = x.family.surprises.map((s) => Object.assign(s, { childId: 'constructor' }));
  x.family.activeChildId = 'constructor';
  const c = R.readFamilyCopy(JSON.stringify(x));
  assert.deepEqual([c.ok, c.repairs], [true, []]);
  assert.equal(c.family.jar.constructor.balance, d.jar[a].balance);
  assert.equal(R.familySummary(c.family).children[0].stars, d.jar[a].balance);
  // A child with the id "__proto__" is dropped like any invalid id (and its tasks with it).
  const y = JSON.parse(JSON.stringify(copy));
  y.family.children[0].id = '__proto__';
  const p = R.readFamilyCopy(JSON.stringify(y));
  assert.equal(p.ok, true);
  assert.deepEqual(p.family.children.map((k) => k.id), [d.children[1].id]);
  assert.ok(p.family.tasks.every((t) => t.childId === d.children[1].id));
  assert.equal({}.polluted, undefined);
});

test('family copy: a loaded copy is checked by validateDoc exactly like stored data, and its repairs are reported', () => {
  const { d, a, t1 } = richDoc();
  const copy = JSON.parse(copyText(R.makeFamilyCopy(d, at(40))));
  const f = copy.family;
  f.children[0].nickname = '  ' + 'N'.repeat(40) + '  ';
  f.children[0].shoeSize = 31;
  f.tasks.find((t) => t.id === t1).stars = 9;
  f.tasks.push({ id: 'orphan', childId: 'nobody', kind: 'recite', text: 'x' });
  f.jar[a].balance = 999;
  f.extra = true;
  copy.note = 'hand-made';
  copy.savedAt = 'yesterday';
  const r = R.readFamilyCopy(JSON.stringify(copy));
  assert.equal(r.ok, true);
  assert.equal(r.savedAt, null);
  // The same repairs as validateDoc on the family with an empty parent.
  const stored = Object.assign({}, f, { parent: R.emptyDoc('1970-01-01T00:00:00.000Z').parent });
  delete stored.extra;
  const v = repairs(stored);
  assert.deepEqual(r.family, familyPart(v.doc));
  assert.deepEqual(r.repairs, ['copy.note: unknown field, dropped', 'copy.savedAt: invalid time, cleared', 'family.extra: unknown field, dropped'].concat(v.repaired));
  for (const re of [/^children\[0\]\.nickname: text cleaned or shortened$/, /^children\[0\]\.shoeSize: unknown field, dropped$/, /^tasks\[\d+\]\.stars: /, /^tasks\[\d+\]: its child does not exist, dropped$/, /^jar\./]) {
    assert.ok(r.repairs.some((x) => re.test(x)), `${re} in ${JSON.stringify(r.repairs)}`);
  }
  assert.equal(r.family.children[0].nickname, 'N'.repeat(24));
  assert.equal(r.family.jar[a].balance, d.jar[a].balance, 'the balance is the sum of the ledger, as in stored data');
  // The repaired family is canonical: used on a device, nothing more is repaired.
  assertClean(R.useFamilyCopy(R.emptyDoc(at(50)), r.family, at(51)));
  // A missing savedAt is null without a repair; the rest of a copy is enough.
  delete copy.savedAt;
  delete copy.note;
  assert.deepEqual(R.readFamilyCopy(JSON.stringify(copy)).repairs.slice(0, 1), ['family.extra: unknown field, dropped']);
});

test('family copy: a family without the lists of a copy, or whose children all had to be dropped, is damaged; a family with no child is refused as empty (B-R3)', () => {
  const { d } = richDoc();
  const copy = R.makeFamilyCopy(d, at(40));
  const refuse = (family, error, label) => {
    const r = R.readFamilyCopy(JSON.stringify(Object.assign({}, copy, { family })));
    assert.deepEqual(r, { ok: false, error, family: null, savedAt: null, repairs: [] }, label);
  };
  // validateDoc would read each of these as an empty list, and the copy as a family with
  // no child: "Replace" would then empty this device's list.
  refuse({ version: 2 }, 'damaged', 'no lists at all');
  refuse(Object.assign({}, copy.family, { children: 'oops', tasks: {}, jar: [] }), 'damaged', 'lists of the wrong type');
  for (const k of ['children', 'tasks', 'surprises', 'jar']) {
    const f = Object.assign({}, copy.family);
    delete f[k];
    refuse(f, 'damaged', `no ${k}`);
    refuse(Object.assign({}, copy.family, { [k]: k === 'jar' ? [] : {} }), 'damaged', `${k} of the wrong type`);
    refuse(Object.assign({}, copy.family, { [k]: null }), 'damaged', `${k} null`);
  }
  // Children that are all invalid (dropped by validateDoc), however deep.
  let deep = [];
  for (let i = 0; i < 1000; i++) deep = [deep];
  refuse(Object.assign({}, copy.family, { children: [deep] }), 'damaged', 'a nested array as the only child');
  refuse(Object.assign({}, copy.family, { children: [1, 'x', null, { id: '__proto__' }] }), 'damaged', 'no valid child');
  const deepText = '{"app":"mommy","kind":"family-copy","version":1,"family":{"version":2,"children":' + '['.repeat(200000) + ']'.repeat(200000) + ',"tasks":[],"jar":{},"surprises":[]}}';
  assert.equal(R.readFamilyCopy(deepText).error, 'damaged', 'a 200,000-deep array (never throws)');
  // A copy of a family with no child (possible: every child removed) holds nothing to use.
  const none = R.makeFamilyCopy(R.emptyDoc(at(1)), at(2));
  assert.deepEqual(R.readFamilyCopy(JSON.stringify(none)), { ok: false, error: 'empty', family: null, savedAt: null, repairs: [] });
  // One valid child among invalid ones is a repaired copy, as before.
  const one = R.readFamilyCopy(JSON.stringify(Object.assign({}, copy, { family: Object.assign({}, copy.family, { children: [1].concat(copy.family.children.slice(0, 1)) }) })));
  assert.equal(one.ok, true);
  assert.deepEqual(one.family.children.map((c) => c.id), [d.children[0].id]);
  assert.ok(one.repairs.length > 0);
});

test('family copy: a copy that grows past 2 MB once checked is refused as damaged (the file is not too big), so a loaded copy can always be saved again (B-R2)', () => {
  const { d } = richDoc();
  const MAX = R.FAMILY_COPY.maxBytes;
  const copy = JSON.parse(JSON.stringify(R.makeFamilyCopy(d, at(40))));
  // Minimal children, which validateDoc completes (age group, language, Quran range...).
  const small = { app: 'mommy', kind: 'family-copy', version: 1, family: { version: 2, children: [], tasks: [], jar: {}, surprises: [] } };
  for (let i = 0; i < 20000; i++) small.family.children.push({ id: 'c' + i, avatar: '🐱' });
  const text = JSON.stringify(small);
  assert.ok(Buffer.byteLength(text, 'utf8') < MAX, 'the file itself is under 2 MB');
  const started = Date.now();
  assert.deepEqual(R.readFamilyCopy(text), { ok: false, error: 'damaged', family: null, savedAt: null, repairs: [] });
  assert.ok(Date.now() - started < 5000, 'refused in reasonable time');
  // Just under the limit once checked: read, used, and saved again within 2 MB.
  const base = Buffer.byteLength(JSON.stringify(Object.assign({}, copy, { savedAt: '1970-01-01T00:00:00.000Z' })), 'utf8');
  const near = JSON.parse(JSON.stringify(copy));
  near.family.tasks[0].text = near.family.tasks[0].text + ' ' + 'a'.repeat(Math.min(19000, MAX - base - 100));
  const r = R.readFamilyCopy(JSON.stringify(near));
  assert.equal(r.ok, true, r.error);
  const used = R.useFamilyCopy(R.emptyDoc(at(50)), r.family, at(51));
  assert.ok(Buffer.byteLength(JSON.stringify(R.makeFamilyCopy(used, at(52))), 'utf8') <= MAX, 'saved again within 2 MB');
  // Every copy that is read fits in a copy again, whatever validateDoc added; one that
  // would not (12,000 minimal children: 600 KB as a file, over 2 MB once completed) is
  // refused. A copy made here never grows when it is checked: one that does was changed.
  for (const [n, ok] of [[1000, true], [9000, true], [12000, false]]) {
    const many = JSON.parse(JSON.stringify(copy));
    for (let i = 0; i < n; i++) many.family.children.push({ id: 'k' + i, nickname: 'K' + i, avatar: '🦊' });
    const m = R.readFamilyCopy(JSON.stringify(many));
    assert.equal(m.ok, ok, `${n} children`);
    if (!ok) {
      assert.equal(m.error, 'damaged', `${n} children`);
      continue;
    }
    const again = JSON.stringify(R.makeFamilyCopy(R.useFamilyCopy(R.emptyDoc(at(50)), m.family, at(51)), at(52)));
    assert.ok(Buffer.byteLength(again, 'utf8') <= MAX, `${n} children: saved again within 2 MB`);
    assert.equal(R.readFamilyCopy(again).ok, true, `${n} children: read again`);
  }
});

test('family copy: a file that is no JSON object is "not a copy" before its size is counted, so a photo chosen by mistake is never "too big" (B-R4)', () => {
  const MAX = R.FAMILY_COPY.maxBytes;
  // A JPEG of 1.5 MB read as UTF-8: each invalid byte is a U+FFFD of 3 bytes.
  const bytes = Buffer.alloc(1536 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919 + 13) & 0xff;
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  const photo = new TextDecoder('utf-8').decode(bytes);
  assert.ok(Buffer.byteLength(photo, 'utf8') > MAX, 'decoded, it counts more than 2 MB');
  assert.equal(R.readFamilyCopy(photo).error, 'not_copy');
  for (const start of ['\x89PNG\r\n', 'GIF89a', '%PDF-1.7', 'PK\x03\x04', '[', '  \n"', '\ufeff ['] ) {
    assert.equal(R.readFamilyCopy(start + 'x'.repeat(MAX + 10)).error, 'not_copy', JSON.stringify(start.slice(0, 6)));
  }
  // A text that starts like JSON is measured as before.
  assert.equal(R.readFamilyCopy('{' + ' '.repeat(MAX + 10) + '}').error, 'too_big');
  assert.equal(R.readFamilyCopy('\ufeff \n {' + 'x'.repeat(MAX)).error, 'too_big');
});

test('family copy: familySummary counts the children, their tasks (not archived) and the stars in the jar', () => {
  const { d, a, b, t2 } = richDoc();
  const archived = R.archiveTask(d, t2, at(30));
  const s = R.familySummary(R.makeFamilyCopy(archived, at(40)).family);
  assert.deepEqual(s.children.map((c) => [c.id, c.nickname, c.avatar]), archived.children.map((c) => [c.id, c.nickname, c.avatar]));
  const own = (id) => archived.tasks.filter((t) => t.childId === id && t.status !== 'archived').length;
  assert.deepEqual(s.children.map((c) => [c.tasks, c.stars]), [[own(a), archived.jar[a].balance], [own(b), archived.jar[b].balance]]);
  assert.equal(s.tasks, archived.tasks.length - 1);
  assert.equal(s.stars, archived.jar[a].balance + archived.jar[b].balance);
  assert.deepEqual(R.familySummary(null), { children: [], tasks: 0, stars: 0 });
  assert.deepEqual(R.familySummary({ children: [{ id: 'x', nickname: 'X', avatar: '🐱' }] }).children, [{ id: 'x', nickname: 'X', avatar: '🐱', tasks: 0, stars: 0 }]);
});

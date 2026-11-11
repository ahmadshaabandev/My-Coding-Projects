/*
 * rewards.js: the pure logic of Mommy's tasks, stars and rewards (docs/REWARDS.md,
 * sections "Data model" and "Pure logic module").
 *
 * One plain script, no dependencies, no DOM, no storage. In the browser it sets
 * window.MommyRewards; in Node the same file is module.exports (tests/web/rewards.test.cjs).
 *
 * How to use it:
 *   - The whole family state is ONE versioned JSON document (localStorage key
 *     'mommy.data.v2'). Load it, pass it through validateDoc(), and keep the result.
 *   - NO FUNCTION EVER MUTATES THE DOCUMENT IT IS GIVEN. Every operation returns a NEW
 *     document (or an object holding one, such as {doc, task}); the UI saves what is
 *     returned and drops the old one. When a function throws, nothing changed: the UI
 *     keeps its current document.
 *   - Deterministic: every function that stamps a time takes `now`, an ISO 8601 string
 *     (new Date().toISOString() in the UI). Ids come from crypto.getRandomValues through
 *     one internal function, which a caller (a test) can replace with opts.newId.
 *   - Errors are RewardsError with a stable `code` ('not_found', 'bad_state',
 *     'bad_input', 'insufficient_stars', 'locked', 'unavailable') and, for bad input,
 *     the `field`. The UI maps codes to its own strings: this module holds no UI strings.
 *
 * Rules kept here:
 *   - No transcript, heard text, audio or image is ever stored: an attempt keeps only
 *     scores (accuracy, verdict, word counts, passed).
 *   - Quran tasks are always checked word by word: they never carry a mode, and a Quran
 *     attempt passes only on the strict Quran check (/api/quran/check) result.
 *   - Stars are credited exactly once per task, when the parent confirms it. A balance
 *     never goes below 0 and every change of it has a ledger entry.
 *   - The PIN is a child lock, not security: PBKDF2-SHA-256 through SubtleCrypto, with a
 *     backoff whose state lives in the document (a reload does not reset it).
 */
(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module !== null && typeof module.exports === 'object') {
    module.exports = api;
  }
  if (typeof window === 'object' && window !== null) {
    window.MommyRewards = api;
  }
})(function () {
  'use strict';

  // ===========================================================================
  // Constants
  // ===========================================================================

  const VERSION = 2;
  const STORAGE_KEY = 'mommy.data.v2';
  const V1_KEY = 'mommy.profile.v1';
  const CORRUPT_KEY_PREFIX = 'mommy.data.v2.corrupt.';

  const LANGS = ['ar', 'en', 'fr'];
  const AGE_BANDS = ['6-9', '10-13', '14-18'];
  const KINDS = ['recite', 'dictation', 'quran'];
  const MODES = ['strict', 'contextual'];
  const MIN_ACCURACIES = [1, 0.9, 0.8];
  const STATUSES = ['assigned', 'ready', 'done', 'archived'];
  const CONFIRMED_BY = ['app_pass', 'parent_override'];
  const REWARD_STATUSES = ['none', 'locked', 'unlocked', 'given'];
  const GOAL_STATUSES = ['open', 'given'];
  // 'carry' (extra): the oldest entries folded into one when the ledger is capped, so that
  // the balance always equals the sum of the ledger.
  const LEDGER_REASONS = ['task', 'goal', 'adjust', 'carry'];
  const WORD_VERDICTS = ['correct', 'mistakes', 'unclear'];
  const MEANING_VERDICTS = ['same_meaning', 'partly', 'different', 'unclear'];
  const VERDICTS = ['correct', 'mistakes', 'unclear', 'same_meaning', 'partly', 'different'];
  const ERROR_CODES = ['not_found', 'bad_state', 'bad_input', 'insufficient_stars', 'locked', 'unavailable'];

  // Fixed lists (stored without U+FE0F; input with it is accepted).
  const AVATARS = ['🐱', '🐰', '🦊', '🐻', '🐼', '🐨', '🦁', '🐯', '🐸', '🦉', '🐢', '🐬', '🦋', '🐝', '🦄', '🚀'];
  const REWARD_EMOJIS = ['🎁', '🍦', '🍫', '🍰', '🍕', '🍓', '📚', '🎨', '🧩', '🧸', '⚽', '🚲', '🎮', '🎬', '🎡', '🌳', '🎈', '🏆', '⭐', '💖'];

  const LIMITS = Object.freeze({
    nickname: 24,
    title: 60,
    text: 20000, // characters (code points), as the server
    textWords: 3000,
    rewardText: 80,
    sentBackNote: 120,
    adjustNote: 80,
    starsMin: 1,
    starsMax: 5,
    starsDefault: 2,
    goalCostMin: 1,
    goalCostMax: 500,
    adjustMax: 500, // |delta| of one adjustStars call
    attempts: 20,
    ledger: 200,
    surahs: 114,
    ayahMax: 286,
    ayatPerTask: 50,
    pinMinDigits: 4,
    pinMaxDigits: 6,
    pinIterations: 150000,
    pinSaltBytes: 16,
    pinHashBytes: 32,
    pinFreeFailures: 5,
    pinLockBaseMs: 30 * 1000,
    pinLockMaxMs: 15 * 60 * 1000,
  });

  const CHILD_QURAN_DEFAULT = Object.freeze({ surah: 78, from: 1, to: 10, juzAmma: true });
  const DEFAULT_REWARD_EMOJI = REWARD_EMOJIS[0];
  const EPOCH = '1970-01-01T00:00:00.000Z';
  const ID_LENGTH = 16;
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
  const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  const ARABIC_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
  const EPS = 1e-9;

  // Allowed keys of each stored object (anything else is dropped by validateDoc).
  const DOC_KEYS = ['version', 'createdAt', 'updatedAt', 'parent', 'children', 'activeChildId', 'tasks', 'jar', 'surprises'];
  const PARENT_KEYS = ['pin', 'failedAttempts', 'lockedUntil', 'consentAt', 'aiConsentAt', 'uiLang'];
  const PIN_KEYS = ['salt', 'hash', 'iterations'];
  const CHILD_KEYS = ['id', 'nickname', 'age', 'lang', 'avatar', 'createdAt', 'quran'];
  const CHILD_QURAN_KEYS = ['surah', 'from', 'to', 'juzAmma'];
  const TASK_COMMON_KEYS = ['id', 'childId', 'createdAt', 'updatedAt', 'kind', 'title', 'pass', 'stars', 'reward', 'due',
    'status', 'attempts', 'readyAt', 'doneAt', 'confirmedBy', 'sentBackAt', 'sentBackNote', 'rewardStatus', 'rewardGivenAt'];
  const TASK_KIND_KEYS = { recite: ['text', 'lang', 'mode'], dictation: ['text', 'lang'], quran: ['quran'] };
  const TASK_QURAN_KEYS = ['surah', 'from', 'to', 'memory'];
  const ATTEMPT_KEYS = ['at', 'accuracy', 'verdict', 'nErrors', 'nExpected', 'passed'];
  const REWARD_KEYS = ['text', 'emoji'];
  const JAR_KEYS = ['balance', 'earned', 'goals', 'ledger'];
  const GOAL_KEYS = ['id', 'cost', 'reward', 'status', 'givenAt', 'createdAt'];
  const LEDGER_KEYS = ['at', 'delta', 'reason', 'ref', 'note'];
  const SURPRISE_KEYS = ['id', 'childId', 'reward', 'at', 'seenAt'];

  // Input keys accepted by the API functions (anything else is 'bad_input').
  const CHILD_INPUT_KEYS = ['nickname', 'age', 'lang', 'avatar', 'quran'];
  const TASK_INPUT_KEYS = ['childId', 'kind', 'title', 'text', 'lang', 'mode', 'quran', 'pass', 'stars', 'reward', 'due'];
  const TASK_PATCH_KEYS = ['title', 'text', 'lang', 'mode', 'quran', 'pass', 'stars', 'reward', 'due'];
  const GOAL_INPUT_KEYS = ['cost', 'reward'];
  const PARENT_PATCH_KEYS = ['uiLang', 'consent', 'aiConsent'];

  // ===========================================================================
  // Errors
  // ===========================================================================

  class RewardsError extends Error {
    constructor(code, message, field) {
      super(message || code);
      this.name = 'RewardsError';
      this.code = code;
      if (field !== undefined) this.field = field;
    }
  }

  function fail(code, message, field) {
    throw new RewardsError(code, message, field);
  }

  // ===========================================================================
  // Small helpers
  // ===========================================================================

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function noNegZero(n) {
    return n === 0 ? 0 : n;
  }

  function isId(v) {
    return typeof v === 'string' && ID_RE.test(v) && v !== '__proto__';
  }

  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  function daysIn(y, m) {
    if (m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) return 29;
    return MONTH_DAYS[m - 1];
  }

  /** Milliseconds of an ISO 8601 time, parsed the same way in every engine, or NaN. */
  function isoMs(s) {
    if (typeof s !== 'string') return NaN;
    const m = ISO_RE.exec(s);
    if (!m) return NaN;
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    const h = +m[4];
    const mi = +m[5];
    const se = m[6] ? +m[6] : 0;
    if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || se > 59) return NaN;
    const frac = m[7] ? Math.floor(Number('0.' + m[7]) * 1000) : 0;
    let off = 0;
    if (m[8] !== 'Z') {
      const oh = +m[10];
      const om = +m[11];
      if (oh > 23 || om > 59) return NaN;
      off = (oh * 60 + om) * 60000 * (m[9] === '+' ? 1 : -1);
    }
    return Date.UTC(y, mo - 1, d, h, mi, se, frac) - off;
  }

  function isIso(s) {
    return Number.isFinite(isoMs(s));
  }

  function isDay(s) {
    if (typeof s !== 'string') return false;
    const m = DAY_RE.exec(s);
    if (!m) return false;
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    return y >= 1970 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
  }

  function cmpTime(a, b) {
    const x = isoMs(a);
    const y = isoMs(b);
    const xa = Number.isFinite(x) ? x : Infinity;
    const ya = Number.isFinite(y) ? y : Infinity;
    return xa < ya ? -1 : xa > ya ? 1 : 0;
  }

  function cmpStr(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function checkNow(now) {
    if (!isIso(now)) fail('bad_input', 'now must be an ISO 8601 time', 'now');
  }

  function hasLoneSurrogate(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          i++;
          continue;
        }
        return true;
      }
      if (c >= 0xdc00 && c <= 0xdfff) return true;
    }
    return false;
  }

  function fixSurrogates(s) {
    if (!hasLoneSurrogate(s)) return s;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          out += s[i] + s[i + 1];
          i++;
          continue;
        }
        out += '�';
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        out += '�';
      } else {
        out += s[i];
      }
    }
    return out;
  }

  function cpLength(s) {
    let n = 0;
    for (const _ of s) n++; // eslint-disable-line no-unused-vars
    return n;
  }

  /** A stored text: lone surrogates replaced, trimmed, cut to `max` code points. */
  function cleanText(v, max) {
    if (typeof v !== 'string') return '';
    let s = fixSurrogates(v).trim();
    if (s.length > max) {
      const a = Array.from(s);
      if (a.length > max) s = a.slice(0, max).join('').trim();
    }
    return s;
  }

  function normEmoji(v) {
    return typeof v === 'string' ? v.replace(/️/g, '').trim() : '';
  }

  function clamp01(x) {
    return noNegZero(Math.min(1, Math.max(0, x)));
  }

  // ===========================================================================
  // Input checks (API functions: throw 'bad_input')
  // ===========================================================================

  function checkKeys(obj, allowed, where) {
    for (const k of Object.keys(obj)) {
      if (!allowed.includes(k)) fail('bad_input', `unknown field "${k}"` + (where ? ` in ${where}` : ''), k);
    }
  }

  function reqObject(v, field) {
    if (!isPlainObject(v)) fail('bad_input', `${field} must be an object`, field);
    return v;
  }

  function reqText(v, field, min, max) {
    if (typeof v !== 'string') fail('bad_input', `${field} must be a string`, field);
    if (hasLoneSurrogate(v)) fail('bad_input', `${field} is not well-formed text`, field);
    const s = v.trim();
    const n = cpLength(s);
    if (n < min || n > max) fail('bad_input', `${field} must have ${min} to ${max} characters`, field);
    return s;
  }

  function optNote(v, field, max) {
    if (v === undefined || v === null) return null;
    const s = reqText(v, field, 0, max);
    return s === '' ? null : s;
  }

  function reqInt(v, field, lo, hi) {
    if (!Number.isInteger(v) || Object.is(v, -0) || v < lo || v > hi) fail('bad_input', `${field} must be an integer from ${lo} to ${hi}`, field);
    return v;
  }

  function reqEnum(v, field, list) {
    if (!list.includes(v)) fail('bad_input', `${field} must be one of ${list.join(', ')}`, field);
    return v;
  }

  function reqBool(v, field) {
    if (typeof v !== 'boolean') fail('bad_input', `${field} must be true or false`, field);
    return v;
  }

  function reqEmoji(v, field, list, dflt) {
    if (v === undefined && dflt !== undefined) return dflt;
    const e = normEmoji(v);
    if (!list.includes(e)) fail('bad_input', `${field} must be one of the fixed emoji`, field);
    return e;
  }

  function reqReward(v, field) {
    reqObject(v, field);
    checkKeys(v, REWARD_KEYS, field);
    return {
      text: reqText(v.text, field + '.text', 1, LIMITS.rewardText),
      emoji: reqEmoji(v.emoji, field + '.emoji', REWARD_EMOJIS, DEFAULT_REWARD_EMOJI),
    };
  }

  function optReward(v, field) {
    return v === undefined || v === null ? null : reqReward(v, field);
  }

  function reqDue(v) {
    if (v === undefined || v === null || v === '') return null;
    if (!isDay(v)) fail('bad_input', 'due must be a date YYYY-MM-DD', 'due');
    return v;
  }

  function reqPass(v) {
    if (v === undefined || v === null) return { minAccuracy: 1 };
    reqObject(v, 'pass');
    checkKeys(v, ['minAccuracy'], 'pass');
    return { minAccuracy: reqEnum(v.minAccuracy, 'pass.minAccuracy', MIN_ACCURACIES) };
  }

  function assertDoc(doc) {
    if (
      !isPlainObject(doc) || doc.version !== VERSION || !isPlainObject(doc.parent) || !Array.isArray(doc.children) ||
      !Array.isArray(doc.tasks) || !isPlainObject(doc.jar) || !Array.isArray(doc.surprises)
    ) {
      fail('bad_input', 'not a version 2 document (pass it through validateDoc first)', 'doc');
    }
  }

  /** Start an operation: check the arguments and return a deep copy stamped with `now`. */
  function begin(doc, now) {
    assertDoc(doc);
    checkNow(now);
    const d = clone(doc);
    d.updatedAt = now;
    return d;
  }

  // ===========================================================================
  // Ids (crypto.getRandomValues; tests may pass opts.newId)
  // ===========================================================================

  function randomBytes(n) {
    const c = typeof globalThis === 'object' ? globalThis.crypto : undefined;
    if (!c || typeof c.getRandomValues !== 'function') fail('unavailable', 'crypto.getRandomValues is not available');
    return c.getRandomValues(new Uint8Array(n));
  }

  function randomId() {
    let out = '';
    while (out.length < ID_LENGTH) {
      const bytes = randomBytes(ID_LENGTH * 2);
      for (let i = 0; i < bytes.length && out.length < ID_LENGTH; i++) {
        if (bytes[i] < 252) out += (bytes[i] % 36).toString(36); // 252 = 7 * 36: no modulo bias
      }
    }
    return out;
  }

  function allIds(d) {
    const ids = new Set();
    for (const c of d.children) ids.add(c.id);
    for (const t of d.tasks) ids.add(t.id);
    for (const s of d.surprises) ids.add(s.id);
    for (const k of Object.keys(d.jar)) {
      const j = d.jar[k];
      if (j && Array.isArray(j.goals)) for (const g of j.goals) ids.add(g.id);
    }
    return ids;
  }

  /** The one place where ids are made. */
  function newId(opts, taken) {
    for (let i = 0; i < 8; i++) {
      const id = opts && typeof opts.newId === 'function' ? opts.newId() : randomId();
      if (!isId(id)) fail('bad_input', 'opts.newId must return an id ([A-Za-z0-9_-], 1 to 64 characters)', 'newId');
      if (!taken.has(id)) return id;
    }
    return fail('bad_state', 'could not make a unique id');
  }

  // ===========================================================================
  // Lookups
  // ===========================================================================

  function findChild(d, id) {
    const c = d.children.find((x) => x.id === id);
    if (!c) fail('not_found', 'no such child', 'childId');
    return c;
  }

  function findTask(d, id) {
    const t = d.tasks.find((x) => x.id === id);
    if (!t) fail('not_found', 'no such task', 'taskId');
    return t;
  }

  function emptyJar() {
    return { balance: 0, earned: 0, goals: [], ledger: [] };
  }

  function jarOf(d, childId) {
    if (!hasOwn(d.jar, childId) || !isPlainObject(d.jar[childId])) d.jar[childId] = emptyJar();
    return d.jar[childId];
  }

  // ===========================================================================
  // Document
  // ===========================================================================

  /** A new, empty version 2 document. */
  function emptyDoc(now, opts) {
    checkNow(now);
    const o = opts || {};
    return {
      version: VERSION,
      createdAt: now,
      updatedAt: now,
      parent: {
        pin: null,
        failedAttempts: 0,
        lockedUntil: null,
        consentAt: null,
        aiConsentAt: null,
        uiLang: LANGS.includes(o.uiLang) ? o.uiLang : 'en',
      },
      children: [],
      activeChildId: null,
      tasks: [],
      jar: {},
      surprises: [],
    };
  }

  /** The parent's settings: {uiLang?, consent?: boolean, aiConsent?: boolean}. */
  function updateParent(doc, patch, now) {
    const d = begin(doc, now);
    reqObject(patch, 'patch');
    checkKeys(patch, PARENT_PATCH_KEYS, 'patch');
    const p = d.parent;
    if (patch.uiLang !== undefined) p.uiLang = reqEnum(patch.uiLang, 'uiLang', LANGS);
    if (patch.consent !== undefined) p.consentAt = reqBool(patch.consent, 'consent') ? p.consentAt || now : null;
    if (patch.aiConsent !== undefined) p.aiConsentAt = reqBool(patch.aiConsent, 'aiConsent') ? p.aiConsentAt || now : null;
    return d;
  }

  // ===========================================================================
  // Migration from v1 (key 'mommy.profile.v1', see defaultProfile/loadProfile in app.js)
  // ===========================================================================

  function clampLoose(v, lo, hi, fallback) {
    // The same rule as clampInt in app.js (strings of digits are accepted).
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, n));
  }

  /**
   * A v2 document with one child made from the v1 profile {nickname, age, lang, quran:
   * {surah, from, to, juzAmma}} (an object or its JSON string). Invalid fields get the
   * v1 defaults; a missing nickname becomes opts.defaultNickname or the avatar. Consent
   * is carried over only if it was stored (v1 does not store it).
   */
  function migrateV1(profileV1, now, opts) {
    checkNow(now);
    const o = opts || {};
    let p = profileV1;
    if (typeof p === 'string') {
      try {
        p = JSON.parse(p);
      } catch (e) {
        p = null;
      }
    }
    if (!isPlainObject(p)) p = {};
    const lang = LANGS.includes(p.lang) ? p.lang : LANGS.includes(o.lang) ? o.lang : 'en';
    const age = AGE_BANDS.includes(p.age) ? p.age : '6-9';
    const avatar = AVATARS[0];
    let nickname = cleanText(p.nickname, LIMITS.nickname);
    if (!nickname) nickname = cleanText(o.defaultNickname, LIMITS.nickname) || avatar;
    const q = isPlainObject(p.quran) ? p.quran : {};
    const quran = {
      surah: clampLoose(q.surah, 1, LIMITS.surahs, CHILD_QURAN_DEFAULT.surah),
      from: clampLoose(q.from, 1, LIMITS.ayahMax, CHILD_QURAN_DEFAULT.from),
      to: clampLoose(q.to, 1, LIMITS.ayahMax, CHILD_QURAN_DEFAULT.to),
      juzAmma: q.juzAmma !== false,
    };
    const d = emptyDoc(now, { uiLang: lang });
    const id = newId(o, new Set());
    d.children.push({ id, nickname, age, lang, avatar, createdAt: now, quran });
    d.jar[id] = emptyJar();
    d.activeChildId = id;
    if (isIso(p.consentAt)) d.parent.consentAt = p.consentAt;
    else if (p.consent === true) d.parent.consentAt = now;
    if (isIso(p.aiConsentAt)) d.parent.aiConsentAt = p.aiConsentAt;
    else if (p.aiConsent === true) d.parent.aiConsentAt = now;
    return d;
  }

  // ===========================================================================
  // Children
  // ===========================================================================

  function reqChildQuran(q, base) {
    reqObject(q, 'quran');
    checkKeys(q, CHILD_QURAN_KEYS, 'quran');
    const out = Object.assign({}, base);
    if (q.surah !== undefined) out.surah = reqInt(q.surah, 'quran.surah', 1, LIMITS.surahs);
    if (q.from !== undefined) out.from = reqInt(q.from, 'quran.from', 1, LIMITS.ayahMax);
    if (q.to !== undefined) out.to = reqInt(q.to, 'quran.to', 1, LIMITS.ayahMax);
    if (q.juzAmma !== undefined) out.juzAmma = reqBool(q.juzAmma, 'quran.juzAmma');
    return out;
  }

  /**
   * Adds a child {nickname (1-24), age?, lang?, avatar?, quran?}. Defaults: age '6-9',
   * lang = the parent's uiLang, avatar = the first one no other child has. The first
   * child becomes the active child. Returns {doc, child}.
   */
  function addChild(doc, input, now, opts) {
    const d = begin(doc, now);
    reqObject(input, 'input');
    checkKeys(input, CHILD_INPUT_KEYS, 'input');
    const nickname = reqText(input.nickname, 'nickname', 1, LIMITS.nickname);
    const age = input.age === undefined ? '6-9' : reqEnum(input.age, 'age', AGE_BANDS);
    const lang = input.lang === undefined ? d.parent.uiLang : reqEnum(input.lang, 'lang', LANGS);
    const used = new Set(d.children.map((c) => c.avatar));
    const avatar = input.avatar === undefined ? AVATARS.find((a) => !used.has(a)) || AVATARS[0] : reqEmoji(input.avatar, 'avatar', AVATARS);
    const quran = input.quran === undefined ? Object.assign({}, CHILD_QURAN_DEFAULT) : reqChildQuran(input.quran, CHILD_QURAN_DEFAULT);
    const id = newId(opts, allIds(d));
    const child = { id, nickname, age, lang, avatar, createdAt: now, quran };
    d.children.push(child);
    d.jar[id] = emptyJar();
    if (d.activeChildId === null) d.activeChildId = id;
    return { doc: d, child: clone(child) };
  }

  /** Changes a child: patch {nickname?, age?, lang?, avatar?, quran?: partial}. */
  function updateChild(doc, childId, patch, now) {
    const d = begin(doc, now);
    const c = findChild(d, childId);
    reqObject(patch, 'patch');
    checkKeys(patch, CHILD_INPUT_KEYS, 'patch');
    if (patch.nickname !== undefined) c.nickname = reqText(patch.nickname, 'nickname', 1, LIMITS.nickname);
    if (patch.age !== undefined) c.age = reqEnum(patch.age, 'age', AGE_BANDS);
    if (patch.lang !== undefined) c.lang = reqEnum(patch.lang, 'lang', LANGS);
    if (patch.avatar !== undefined) c.avatar = reqEmoji(patch.avatar, 'avatar', AVATARS);
    if (patch.quran !== undefined) c.quran = reqChildQuran(patch.quran, c.quran);
    return d;
  }

  /** Removes a child with all of their tasks, jar (goals, ledger) and surprises. */
  function removeChild(doc, childId, now) {
    const d = begin(doc, now);
    findChild(d, childId);
    d.children = d.children.filter((c) => c.id !== childId);
    d.tasks = d.tasks.filter((t) => t.childId !== childId);
    d.surprises = d.surprises.filter((s) => s.childId !== childId);
    delete d.jar[childId];
    if (d.activeChildId === childId) d.activeChildId = null;
    return d;
  }

  /** Sets the active child (null: nobody, back to "Who is learning?"). */
  function setActiveChild(doc, childId, now) {
    const d = begin(doc, now);
    if (childId !== null) findChild(d, childId);
    d.activeChildId = childId;
    return d;
  }

  // ===========================================================================
  // Tasks
  // ===========================================================================

  function buildTask(o) {
    const t = {
      id: o.id,
      childId: o.childId,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      kind: o.kind,
      title: o.title,
    };
    if (o.kind === 'quran') {
      t.quran = o.quran;
    } else {
      t.text = o.text;
      t.lang = o.lang;
      if (o.kind === 'recite') t.mode = o.mode;
    }
    t.pass = o.pass;
    t.stars = o.stars;
    t.reward = o.reward;
    t.due = o.due;
    t.status = o.status;
    t.attempts = o.attempts;
    t.readyAt = o.readyAt;
    t.doneAt = o.doneAt;
    t.confirmedBy = o.confirmedBy;
    t.sentBackAt = o.sentBackAt;
    t.sentBackNote = o.sentBackNote;
    t.rewardStatus = o.rewardStatus;
    t.rewardGivenAt = o.rewardGivenAt;
    return t;
  }

  /** The default title: the text's first words (at most 60 characters), or the surah. */
  function defaultTitle(kind, content, surahName) {
    if (kind === 'quran') {
      const name = cleanText(surahName, LIMITS.title);
      if (name) return name;
      const q = content.quran;
      return q.from === q.to ? `${q.surah}:${q.from}` : `${q.surah}:${q.from}-${q.to}`;
    }
    const words = String(content.text || '').split(/\s+/).filter(Boolean);
    let out = '';
    for (const w of words) {
      const next = out ? out + ' ' + w : w;
      if (cpLength(next) > LIMITS.title) break;
      out = next;
    }
    if (!out && words.length) out = Array.from(words[0]).slice(0, LIMITS.title).join('');
    return out;
  }

  function reqTaskQuran(q, ayahCount) {
    reqObject(q, 'quran');
    checkKeys(q, TASK_QURAN_KEYS, 'quran');
    const surah = reqInt(q.surah, 'quran.surah', 1, LIMITS.surahs);
    const from = reqInt(q.from, 'quran.from', 1, LIMITS.ayahMax);
    const to = reqInt(q.to, 'quran.to', from, Math.min(LIMITS.ayahMax, from + LIMITS.ayatPerTask - 1));
    if (ayahCount !== undefined) {
      reqInt(ayahCount, 'ayahCount', 1, LIMITS.ayahMax);
      if (to > ayahCount) fail('bad_input', 'the range goes past the end of the surah', 'quran.to');
    }
    const memory = q.memory === undefined ? false : reqBool(q.memory, 'quran.memory');
    return { surah, from, to, memory };
  }

  /** The kind-specific fields of a task: {text, lang, mode?} or {quran}. */
  function taskContent(kind, src, opts) {
    const o = opts || {};
    if (kind === 'quran') {
      if (src.mode !== undefined) fail('bad_input', 'a Quran task is always checked word by word: it never carries a mode', 'mode');
      if (src.text !== undefined) fail('bad_input', 'a Quran task has no text: the text comes from the Quran section', 'text');
      if (src.lang !== undefined) fail('bad_input', 'a Quran task has no language', 'lang');
      return { quran: reqTaskQuran(src.quran, o.ayahCount) };
    }
    if (src.quran !== undefined) fail('bad_input', 'only a Quran task has a Quran range', 'quran');
    const text = reqText(src.text, 'text', 1, LIMITS.text);
    if (text.split(/\s+/).length > LIMITS.textWords) fail('bad_input', `text must have at most ${LIMITS.textWords} words`, 'text');
    const lang = reqEnum(src.lang, 'lang', LANGS);
    if (kind === 'dictation') {
      if (src.mode !== undefined) fail('bad_input', 'a dictation task has no mode', 'mode');
      return { text, lang };
    }
    const mode = src.mode === undefined ? 'strict' : reqEnum(src.mode, 'mode', MODES);
    return { text, lang, mode };
  }

  function titleOf(v, kind, content, opts) {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      return defaultTitle(kind, content, opts && opts.surahName);
    }
    return reqText(v, 'title', 1, LIMITS.title);
  }

  /**
   * Creates a task (status 'assigned'). input: {childId, kind, title?, text, lang, mode?
   * (recite only, default 'strict'), quran: {surah, from, to, memory?} (quran only),
   * pass?: {minAccuracy: 1 | 0.9 | 0.8} (default 1), stars? (1-5, default 2), reward?:
   * {text, emoji?} | null, due?: 'YYYY-MM-DD' | null}. A Quran task never carries a mode
   * (nor text or lang). opts: {newId?, ayahCount? (of the chosen surah, checked when
   * given), surahName? (default title of a Quran task)}. Returns {doc, task}.
   */
  function createTask(doc, input, now, opts) {
    const d = begin(doc, now);
    reqObject(input, 'input');
    checkKeys(input, TASK_INPUT_KEYS, 'input');
    findChild(d, input.childId);
    const kind = reqEnum(input.kind, 'kind', KINDS);
    const content = taskContent(kind, input, opts);
    const title = titleOf(input.title, kind, content, opts);
    const pass = reqPass(input.pass);
    const stars = input.stars === undefined ? LIMITS.starsDefault : reqInt(input.stars, 'stars', LIMITS.starsMin, LIMITS.starsMax);
    const reward = optReward(input.reward, 'reward');
    const due = reqDue(input.due);
    const task = buildTask(Object.assign({
      id: newId(opts, allIds(d)),
      childId: input.childId,
      createdAt: now,
      updatedAt: now,
      kind,
      title,
      pass,
      stars,
      reward,
      due,
      status: 'assigned',
      attempts: [],
      readyAt: null,
      doneAt: null,
      confirmedBy: null,
      sentBackAt: null,
      sentBackNote: null,
      rewardStatus: reward ? 'locked' : 'none',
      rewardGivenAt: null,
    }, content));
    d.tasks.push(task);
    return { doc: d, task: clone(task) };
  }

  /**
   * Edits a task that is 'assigned' or 'ready' (else 'bad_state'). patch: any of title,
   * text, lang, mode, quran (partial), pass, stars, reward, due; kind and childId cannot
   * change. A Quran task refuses mode, text and lang ('bad_input'). If what the child must
   * do changes (text, lang, mode, quran, pass) on a 'ready' task, it goes back to
   * 'assigned'. A field left undefined is unchanged; title null or '' gets the default
   * title again, reward null removes the reward, due null clears the date. Returns doc.
   */
  function updateTask(doc, taskId, patch, now, opts) {
    const d = begin(doc, now);
    const t = findTask(d, taskId);
    reqObject(patch, 'patch');
    if (patch.kind !== undefined || patch.childId !== undefined) fail('bad_input', 'the kind and the child of a task cannot change', patch.kind !== undefined ? 'kind' : 'childId');
    checkKeys(patch, TASK_PATCH_KEYS, 'patch');
    if (t.kind === 'quran' && patch.mode !== undefined) fail('bad_input', 'a Quran task is always checked word by word: it never carries a mode', 'mode');
    if (t.status !== 'assigned' && t.status !== 'ready') fail('bad_state', 'only a task that is to do or waiting can be edited');
    const src = {};
    for (const k of ['text', 'lang', 'mode', 'quran']) if (t[k] !== undefined) src[k] = t[k];
    for (const k of ['text', 'lang', 'mode']) if (patch[k] !== undefined) src[k] = patch[k];
    if (patch.quran !== undefined) src.quran = isPlainObject(patch.quran) && t.quran ? Object.assign({}, t.quran, patch.quran) : patch.quran;
    const content = taskContent(t.kind, src, opts);
    const pass = patch.pass === undefined ? t.pass : reqPass(patch.pass);
    const before = JSON.stringify([t.text, t.lang, t.mode, t.quran, t.pass]);
    const after = JSON.stringify([content.text, content.lang, content.mode, content.quran, pass]);
    if (patch.title !== undefined) t.title = titleOf(patch.title, t.kind, content, opts);
    Object.assign(t, content);
    t.pass = pass;
    if (patch.stars !== undefined) t.stars = reqInt(patch.stars, 'stars', LIMITS.starsMin, LIMITS.starsMax);
    if (patch.reward !== undefined) t.reward = optReward(patch.reward, 'reward');
    if (patch.due !== undefined) t.due = reqDue(patch.due);
    t.rewardStatus = t.reward ? 'locked' : 'none';
    if (t.status === 'ready' && before !== after) {
      t.status = 'assigned';
      t.readyAt = null;
    }
    t.updatedAt = now;
    return d;
  }

  /** Archives a task from any state ('bad_state' if it already is). Returns doc. */
  function archiveTask(doc, taskId, now) {
    const d = begin(doc, now);
    const t = findTask(d, taskId);
    if (t.status === 'archived') fail('bad_state', 'the task is already archived');
    t.status = 'archived';
    t.updatedAt = now;
    return d;
  }

  // ---------------------------------------------------------------------------
  // Pass rules
  // ---------------------------------------------------------------------------

  function readWordResult(r, sayAgain, minAccuracy, quran) {
    const nExpected = Number.isInteger(r.n_expected) && r.n_expected >= 0 ? noNegZero(r.n_expected) : null;
    const nErrors = Number.isInteger(r.n_errors) && r.n_errors >= 0 ? noNegZero(r.n_errors) : null;
    if (quran && (nExpected === null || nErrors === null)) return null;
    let accuracy = null;
    if (typeof r.word_accuracy === 'number' && Number.isFinite(r.word_accuracy)) accuracy = clamp01(r.word_accuracy);
    else if (nExpected !== null && nExpected > 0 && nErrors !== null) accuracy = clamp01(1 - nErrors / nExpected);
    if (accuracy === null) return null;
    const verdict = WORD_VERDICTS.includes(r.verdict) ? r.verdict : null;
    let passed = !sayAgain && verdict !== 'unclear' && nExpected !== 0;
    if (passed) {
      // Quran: "all words right" means no error at all (an added word is a mistake too).
      if (quran && minAccuracy === 1) passed = nErrors === 0;
      else passed = accuracy >= minAccuracy - EPS;
    }
    return { accuracy, verdict, nErrors, nExpected, passed };
  }

  /**
   * Reads an API response for a task: {accuracy, verdict, nErrors, nExpected, passed},
   * or null when the response does not fit the task's kind.
   *   - strict recite: /api/recite/check (mode 'strict') or its `result` CheckResult;
   *   - dictation: /api/dictation/check or its `result` CheckResult (never a recite response);
   *   - contextual recite: /api/recite/check (mode 'contextual') or its `judgement`;
   *   - quran: /api/quran/check only (it has first_error; never a recite, dictation or
   *     meaning response).
   */
  function readResult(task, result) {
    if (!isPlainObject(task) || !isPlainObject(result) || !isPlainObject(task.pass)) return null;
    const min = task.pass.minAccuracy;
    if (task.kind === 'quran') {
      if (!hasOwn(result, 'first_error') || 'judgement' in result || 'mode' in result || 'result' in result || 'read_text' in result) return null;
      return readWordResult(result, result.say_again === true, min, true);
    }
    if (task.kind === 'recite' && task.mode === 'contextual') {
      if (result.mode === 'strict' || isPlainObject(result.result)) return null;
      const j = isPlainObject(result.judgement) ? result.judgement : result;
      if (!MEANING_VERDICTS.includes(j.verdict)) return null;
      const sayAgain = result.say_again === true || j.say_again === true;
      const passed = j.verdict === 'same_meaning' && Array.isArray(j.missing_ideas) && j.missing_ideas.length === 0 && !sayAgain;
      return { accuracy: null, verdict: j.verdict, nErrors: null, nExpected: null, passed };
    }
    if (task.kind !== 'recite' && task.kind !== 'dictation') return null;
    if (result.mode === 'contextual' || 'judgement' in result) return null;
    // A recite response (it has mode) is not a dictation result, nor the reverse (read_text).
    if (task.kind === 'dictation' ? 'mode' in result : 'read_text' in result) return null;
    const core = isPlainObject(result.result) ? result.result : result;
    return readWordResult(core, result.say_again === true || core.say_again === true, min, false);
  }

  /**
   * Whether an API response passes the task: strict recite and dictation use
   * word_accuracy (or 1 - n_errors/n_expected) >= pass.minAccuracy; contextual recite
   * needs verdict 'same_meaning' with no missing ideas; Quran uses the Quran check's
   * word_accuracy, and minAccuracy 1 means n_errors === 0. A say-again (unclear) result
   * never passes. A response that does not fit the kind does not pass.
   */
  function passes(task, result) {
    const r = readResult(task, result);
    return Boolean(r && r.passed);
  }

  /**
   * Records an attempt from an API response (only scores are kept, newest last, at most
   * 20). On the first pass while 'assigned' the task becomes 'ready'; attempts on a
   * 'ready', 'done' or 'archived' task change no status. Throws 'bad_input' when the
   * response does not fit the task. Returns {doc, task, attempt, passed, becameReady}.
   */
  function recordAttempt(doc, taskId, result, now) {
    const d = begin(doc, now);
    const t = findTask(d, taskId);
    const r = readResult(t, result);
    if (!r) fail('bad_input', t.kind === 'quran' ? 'a Quran task takes only a Quran check result' : 'the result does not fit this task', 'result');
    const attempt = { at: now, accuracy: r.accuracy, verdict: r.verdict, nErrors: r.nErrors, nExpected: r.nExpected, passed: r.passed };
    t.attempts.push(attempt);
    if (t.attempts.length > LIMITS.attempts) t.attempts = t.attempts.slice(-LIMITS.attempts);
    t.updatedAt = now;
    let becameReady = false;
    if (t.status === 'assigned' && r.passed) {
      t.status = 'ready';
      t.readyAt = now;
      becameReady = true;
    }
    return { doc: d, task: clone(t), attempt: clone(attempt), passed: r.passed, becameReady };
  }

  // ---------------------------------------------------------------------------
  // Review
  // ---------------------------------------------------------------------------

  /** Folds the oldest entries into one 'carry' entry when there are more than 200. */
  function foldLedger(ledger) {
    if (ledger.length <= LIMITS.ledger) return ledger;
    const k = ledger.length - (LIMITS.ledger - 1);
    const folded = ledger.slice(0, k);
    let sum = 0;
    for (const e of folded) sum += e.delta;
    const carry = { at: folded[folded.length - 1].at, delta: noNegZero(sum), reason: 'carry', ref: null, note: null };
    return [carry].concat(ledger.slice(k));
  }

  function addToJar(jar, delta, reason, ref, note, at) {
    jar.ledger.push({ at, delta, reason, ref, note });
    jar.ledger = foldLedger(jar.ledger);
    jar.balance += delta;
  }

  /**
   * The parent confirms a task: how 'app_pass' needs status 'ready'; 'parent_override'
   * ("confirm anyway") needs 'assigned'. The task becomes 'done', its stars go into the
   * jar once (ledger reason 'task'), and its reward, if any, becomes 'unlocked'.
   * Confirming twice, or an archived task, throws 'bad_state' and credits nothing.
   */
  function confirmTask(doc, taskId, how, now) {
    const d = begin(doc, now);
    reqEnum(how, 'how', CONFIRMED_BY);
    const t = findTask(d, taskId);
    if (how === 'app_pass' && t.status !== 'ready') fail('bad_state', 'only a task waiting for the parent can be confirmed');
    if (how === 'parent_override' && t.status !== 'assigned') fail('bad_state', 'only a task still to do can be confirmed anyway');
    const jar = jarOf(d, t.childId);
    if (jar.ledger.some((e) => e.reason === 'task' && e.ref === t.id)) fail('bad_state', 'the stars of this task were already given');
    t.status = 'done';
    t.doneAt = now;
    t.confirmedBy = how;
    t.rewardStatus = t.reward ? 'unlocked' : 'none';
    t.updatedAt = now;
    addToJar(jar, t.stars, 'task', t.id, null, now);
    jar.earned += t.stars;
    return d;
  }

  /** "Not yet: try again": 'ready' or 'assigned' goes (back) to 'assigned', with an optional note (0-120). */
  function sendBack(doc, taskId, note, now) {
    const d = begin(doc, now);
    const t = findTask(d, taskId);
    const n = optNote(note, 'note', LIMITS.sentBackNote);
    if (t.status !== 'ready' && t.status !== 'assigned') fail('bad_state', 'only a task to do or waiting can be sent back');
    t.status = 'assigned';
    t.readyAt = null;
    t.sentBackAt = now;
    t.sentBackNote = n;
    t.updatedAt = now;
    return d;
  }

  /** The task's unlocked reward was given to the child: 'unlocked' -> 'given'. */
  function markRewardGiven(doc, taskId, now) {
    const d = begin(doc, now);
    const t = findTask(d, taskId);
    if (t.rewardStatus !== 'unlocked') fail('bad_state', 'the reward is not unlocked');
    t.rewardStatus = 'given';
    t.rewardGivenAt = now;
    t.updatedAt = now;
    return d;
  }

  // ===========================================================================
  // Star jar
  // ===========================================================================

  /** Adds a goal {cost: 1-500, reward: {text, emoji?}} to a child's jar. Returns {doc, goal}. */
  function addGoal(doc, childId, input, now, opts) {
    const d = begin(doc, now);
    findChild(d, childId);
    reqObject(input, 'input');
    checkKeys(input, GOAL_INPUT_KEYS, 'input');
    const cost = reqInt(input.cost, 'cost', LIMITS.goalCostMin, LIMITS.goalCostMax);
    const reward = reqReward(input.reward, 'reward');
    const goal = { id: newId(opts, allIds(d)), cost, reward, status: 'open', givenAt: null, createdAt: now };
    jarOf(d, childId).goals.push(goal);
    return { doc: d, goal: clone(goal) };
  }

  function findGoal(d, childId, goalId) {
    findChild(d, childId);
    const jar = jarOf(d, childId);
    const g = jar.goals.find((x) => x.id === goalId);
    if (!g) fail('not_found', 'no such goal', 'goalId');
    return { jar, goal: g };
  }

  /** Removes a goal (open or given); ledger entries that pointed to it keep their amount, with ref null. */
  function removeGoal(doc, childId, goalId, now) {
    const d = begin(doc, now);
    const { jar } = findGoal(d, childId, goalId);
    jar.goals = jar.goals.filter((g) => g.id !== goalId);
    for (const e of jar.ledger) if (e.reason === 'goal' && e.ref === goalId) e.ref = null;
    return d;
  }

  /** Gives an open goal: only when balance >= cost ('insufficient_stars'); deducts the cost with a ledger entry. */
  function giveGoal(doc, childId, goalId, now) {
    const d = begin(doc, now);
    const { jar, goal } = findGoal(d, childId, goalId);
    if (goal.status !== 'open') fail('bad_state', 'the goal was already given');
    if (jar.balance < goal.cost) fail('insufficient_stars', 'not enough stars for this goal');
    goal.status = 'given';
    goal.givenAt = now;
    addToJar(jar, -goal.cost, 'goal', goal.id, null, now);
    return d;
  }

  /**
   * A parent correction of a child's stars: delta is a non-zero integer, |delta| <= 500,
   * with an optional note (0-80). A negative delta is limited to the balance (never below
   * 0); with a balance of 0 it throws 'insufficient_stars'. earned (the lifetime total)
   * grows with a positive delta and shrinks with a negative one, never below the balance.
   */
  function adjustStars(doc, childId, delta, now, note) {
    const d = begin(doc, now);
    findChild(d, childId);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > LIMITS.adjustMax) {
      fail('bad_input', `delta must be a non-zero integer from -${LIMITS.adjustMax} to ${LIMITS.adjustMax}`, 'delta');
    }
    const n = optNote(note, 'note', LIMITS.adjustNote);
    const jar = jarOf(d, childId);
    const eff = delta < 0 ? Math.max(delta, -jar.balance) : delta;
    if (eff === 0) fail('insufficient_stars', 'there are no stars to take away');
    addToJar(jar, eff, 'adjust', null, n, now);
    jar.earned = eff > 0 ? jar.earned + eff : Math.max(jar.balance, jar.earned + eff);
    return d;
  }

  // ===========================================================================
  // Surprises
  // ===========================================================================

  /** A surprise reward {text, emoji?} for a child, at any time. Returns {doc, surprise}. */
  function addSurprise(doc, childId, reward, now, opts) {
    const d = begin(doc, now);
    findChild(d, childId);
    const r = reqReward(reward, 'reward');
    const surprise = { id: newId(opts, allIds(d)), childId, reward: r, at: now, seenAt: null };
    d.surprises.push(surprise);
    return { doc: d, surprise: clone(surprise) };
  }

  /** The child has seen the surprise (shown once). Seeing it again changes nothing. */
  function markSurpriseSeen(doc, surpriseId, now) {
    assertDoc(doc);
    checkNow(now);
    const s0 = doc.surprises.find((x) => x.id === surpriseId);
    if (!s0) fail('not_found', 'no such surprise', 'surpriseId');
    if (s0.seenAt !== null) return clone(doc);
    const d = begin(doc, now);
    d.surprises.find((x) => x.id === surpriseId).seenAt = now;
    return d;
  }

  // ===========================================================================
  // Views (read only; they return copies)
  // ===========================================================================

  function correctWords(a) {
    if (!a || typeof a.accuracy !== 'number' || !Number.isInteger(a.nExpected) || a.nExpected <= 0) return null;
    return Math.round(a.accuracy * a.nExpected);
  }

  /**
   * Words right in the last attempt minus the best of the earlier attempts on the same
   * text (same number of expected words); null when there is nothing to compare (fewer
   * than two scored attempts, or a meaning check). Positive: "N more words right".
   */
  function improvement(task) {
    if (!isPlainObject(task) || !Array.isArray(task.attempts) || task.attempts.length < 2) return null;
    const last = task.attempts[task.attempts.length - 1];
    const now = correctWords(last);
    if (now === null) return null;
    let best = null;
    for (const a of task.attempts.slice(0, -1)) {
      if (!a || a.nExpected !== last.nExpected) continue;
      const c = correctWords(a);
      if (c !== null && (best === null || c > best)) best = c;
    }
    return best === null ? null : now - best;
  }

  /** Attempt figures for the parent: {attemptCount, passedCount, bestAccuracy, lastAccuracy, lastPassed, improvement}. */
  function taskStats(task) {
    const attempts = isPlainObject(task) && Array.isArray(task.attempts) ? task.attempts : [];
    let best = null;
    let passedCount = 0;
    for (const a of attempts) {
      if (typeof a.accuracy === 'number' && (best === null || a.accuracy > best)) best = a.accuracy;
      if (a.passed) passedCount++;
    }
    const last = attempts.length ? attempts[attempts.length - 1] : null;
    return {
      attemptCount: attempts.length,
      passedCount,
      bestAccuracy: best,
      lastAccuracy: last && typeof last.accuracy === 'number' ? last.accuracy : null,
      lastPassed: last ? Boolean(last.passed) : null,
      improvement: improvement(task),
    };
  }

  /** The pass level as a key for the UI: 'all_words' | 'nine_in_ten' | 'eight_in_ten' | 'same_meaning'. */
  function passRule(task) {
    if (task.kind === 'recite' && task.mode === 'contextual') return 'same_meaning';
    const m = task.pass && task.pass.minAccuracy;
    return m === 0.9 ? 'nine_in_ten' : m === 0.8 ? 'eight_in_ten' : 'all_words';
  }

  /** Which actions a task allows now: {edit, confirm, confirmAnyway, sendBack, archive, markRewardGiven}. */
  function taskActions(task) {
    const s = task.status;
    return {
      edit: s === 'assigned' || s === 'ready',
      confirm: s === 'ready',
      confirmAnyway: s === 'assigned',
      sendBack: s === 'assigned' || s === 'ready',
      archive: s !== 'archived',
      markRewardGiven: task.rewardStatus === 'unlocked',
    };
  }

  function byTimeThenId(field) {
    return (a, b) => cmpTime(a[field], b[field]) || cmpTime(a.createdAt, b.createdAt) || cmpStr(a.id, b.id);
  }

  /**
   * The child's home: {child, balance, earned, nextGoal, starsMissing, goalProgress (0..1),
   * goals (open, cheapest first), affordableGoals, todo (due first, then oldest), waiting
   * (oldest ready first), done (newest first), rewardsToGive (unlocked, not given yet),
   * unseenSurprises (oldest first), counts: {todo, waiting, done, archived, goals,
   * rewardsToGive, unseenSurprises}}. `now` is accepted for symmetry; no countdowns.
   */
  function childSummary(doc, childId, now) { // eslint-disable-line no-unused-vars
    assertDoc(doc);
    const child = doc.children.find((c) => c.id === childId);
    if (!child) fail('not_found', 'no such child', 'childId');
    const jar = hasOwn(doc.jar, childId) && isPlainObject(doc.jar[childId]) ? doc.jar[childId] : emptyJar();
    const tasks = doc.tasks.filter((t) => t.childId === childId);
    const todo = tasks.filter((t) => t.status === 'assigned').sort((a, b) => {
      if (a.due !== b.due) {
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return cmpStr(a.due, b.due);
      }
      return cmpTime(a.createdAt, b.createdAt) || cmpStr(a.id, b.id);
    });
    const waiting = tasks.filter((t) => t.status === 'ready').sort(byTimeThenId('readyAt'));
    const done = tasks.filter((t) => t.status === 'done').sort((a, b) => -byTimeThenId('doneAt')(a, b));
    const rewardsToGive = tasks.filter((t) => t.rewardStatus === 'unlocked').sort(byTimeThenId('doneAt'));
    const goals = jar.goals.filter((g) => g.status === 'open')
      .sort((a, b) => a.cost - b.cost || cmpTime(a.createdAt, b.createdAt) || cmpStr(a.id, b.id));
    const nextGoal = goals.length ? goals[0] : null;
    const unseenSurprises = doc.surprises.filter((s) => s.childId === childId && s.seenAt === null).sort(byTimeThenId('at'));
    return clone({
      child,
      balance: jar.balance,
      earned: jar.earned,
      nextGoal,
      starsMissing: nextGoal ? Math.max(0, nextGoal.cost - jar.balance) : null,
      goalProgress: nextGoal ? Math.min(1, jar.balance / nextGoal.cost) : null,
      goals,
      affordableGoals: goals.filter((g) => g.cost <= jar.balance),
      todo,
      waiting,
      done,
      rewardsToGive,
      unseenSurprises,
      counts: {
        todo: todo.length,
        waiting: waiting.length,
        done: done.length,
        archived: tasks.filter((t) => t.status === 'archived').length,
        goals: goals.length,
        rewardsToGive: rewardsToGive.length,
        unseenSurprises: unseenSurprises.length,
      },
    });
  }

  /**
   * Tasks waiting for the parent, across children, oldest ready first:
   * [{task, child: {id, nickname, avatar}, readyAt, attemptCount, passedCount,
   *   bestAccuracy, lastAccuracy, lastPassed, improvement}].
   */
  function reviewQueue(doc) {
    assertDoc(doc);
    const kids = new Map(doc.children.map((c) => [c.id, c]));
    return clone(doc.tasks
      .filter((t) => t.status === 'ready' && kids.has(t.childId))
      .sort(byTimeThenId('readyAt'))
      .map((t) => {
        const c = kids.get(t.childId);
        return Object.assign({ task: t, child: { id: c.id, nickname: c.nickname, avatar: c.avatar }, readyAt: t.readyAt }, taskStats(t));
      }));
  }

  function getChild(doc, childId) {
    assertDoc(doc);
    const c = doc.children.find((x) => x.id === childId);
    return c ? clone(c) : null;
  }

  function getTask(doc, taskId) {
    assertDoc(doc);
    const t = doc.tasks.find((x) => x.id === taskId);
    return t ? clone(t) : null;
  }

  function getJar(doc, childId) {
    assertDoc(doc);
    return hasOwn(doc.jar, childId) && isPlainObject(doc.jar[childId]) ? clone(doc.jar[childId]) : null;
  }

  // ===========================================================================
  // PIN (a child lock, not security)
  // ===========================================================================

  /** '1234', '١٢٣٤' and '۱۲۳۴' -> '1234'; null unless 4 to 6 digits. */
  function normalizePin(pin) {
    if (typeof pin !== 'string') return null;
    const s = pin
      .replace(/[\s‎‏؜⁦-⁩]/g, '')
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
    return /^[0-9]{4,6}$/.test(s) ? s : null;
  }

  function isValidPin(pin) {
    return normalizePin(pin) !== null;
  }

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64ToBytes(s) {
    if (typeof s !== 'string' || s === '' || s.length % 4 !== 0 || !B64_RE.test(s)) return null;
    try {
      const bin = atob(s);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (e) {
      return null;
    }
  }

  function saltBytes(salt) {
    if (salt === undefined || salt === null) return randomBytes(LIMITS.pinSaltBytes);
    let b = null;
    if (typeof salt === 'string') b = b64ToBytes(salt);
    else if (salt instanceof Uint8Array) b = new Uint8Array(salt);
    else if (salt instanceof ArrayBuffer) b = new Uint8Array(salt.slice(0));
    if (!b || b.length < LIMITS.pinSaltBytes || b.length > 64) fail('bad_input', 'the salt must be 16 to 64 bytes (base64 or bytes)', 'salt');
    return b;
  }

  function getSubtle() {
    const c = typeof globalThis === 'object' ? globalThis.crypto : undefined;
    if (!c || !c.subtle || typeof c.subtle.deriveBits !== 'function') {
      fail('unavailable', 'SubtleCrypto is not available (the page needs a secure context such as localhost)');
    }
    return c.subtle;
  }

  async function pbkdf2(digits, salt, iterations) {
    const subtle = getSubtle();
    const raw = new Uint8Array(digits.length);
    for (let i = 0; i < digits.length; i++) raw[i] = digits.charCodeAt(i);
    const key = await subtle.importKey('raw', raw, { name: 'PBKDF2' }, false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, LIMITS.pinHashBytes * 8);
    return new Uint8Array(bits);
  }

  /** Compares two byte arrays in time that depends only on their lengths. */
  function sameBytes(a, b) {
    const n = Math.max(a.length, b.length);
    let diff = a.length ^ b.length;
    for (let i = 0; i < n; i++) diff |= (a[i] | 0) ^ (b[i] | 0);
    return diff === 0;
  }

  /**
   * PBKDF2-SHA-256 (150000 iterations) of a 4-6 digit PIN. salt: base64 or bytes (16-64);
   * a new random 16-byte salt when omitted. Resolves to {salt, hash, iterations} (base64);
   * rejects with 'bad_input' for a malformed PIN or salt.
   */
  async function hashPin(pin, salt) {
    const digits = normalizePin(pin);
    if (!digits) fail('bad_input', 'a PIN is 4 to 6 digits', 'pin');
    const s = saltBytes(salt);
    const hash = await pbkdf2(digits, s, LIMITS.pinIterations);
    return { salt: bytesToB64(s), hash: bytesToB64(hash), iterations: LIMITS.pinIterations };
  }

  /** Sets (or changes) the parent PIN and clears the backoff. opts.salt for tests. Resolves to doc. */
  async function setPin(doc, pin, now, opts) {
    assertDoc(doc);
    checkNow(now);
    const record = await hashPin(pin, opts && opts.salt);
    const d = begin(doc, now);
    d.parent.pin = record;
    d.parent.failedAttempts = 0;
    d.parent.lockedUntil = null;
    return d;
  }

  /** Removes the PIN ("Forgot PIN" after the parental gate); all other data stays. */
  function clearPin(doc, now) {
    const d = begin(doc, now);
    d.parent.pin = null;
    d.parent.failedAttempts = 0;
    d.parent.lockedUntil = null;
    return d;
  }

  function lockMsFor(failedAttempts) {
    const n = failedAttempts - LIMITS.pinFreeFailures;
    if (n < 0) return 0;
    return Math.min(LIMITS.pinLockMaxMs, LIMITS.pinLockBaseMs * Math.pow(2, Math.min(n, 20)));
  }

  /** The lock as of `now`; a lock further away than 15 min (the clock went back) counts as 15 min. */
  function lockState(p, nowMs) {
    if (p.lockedUntil === null) return { until: null, ms: 0, repaired: false };
    let until = isoMs(p.lockedUntil);
    let repaired = false;
    if (!Number.isFinite(until) || until - nowMs > LIMITS.pinLockMaxMs) {
      until = nowMs + LIMITS.pinLockMaxMs;
      repaired = true;
    }
    return { until, ms: Math.max(0, until - nowMs), repaired };
  }

  /** {hasPin, failedAttempts, locked, lockedUntil, retryInMs, attemptsLeft} as of `now`. */
  function pinStatus(doc, now) {
    assertDoc(doc);
    checkNow(now);
    const p = doc.parent;
    const ls = lockState(p, isoMs(now));
    const locked = ls.ms > 0;
    return {
      hasPin: p.pin !== null,
      failedAttempts: p.failedAttempts,
      locked,
      lockedUntil: locked ? (ls.repaired ? new Date(ls.until).toISOString() : p.lockedUntil) : null,
      retryInMs: locked ? ls.ms : 0,
      attemptsLeft: Math.max(0, LIMITS.pinFreeFailures - p.failedAttempts),
    };
  }

  /**
   * Checks the parent PIN. Resolves to {ok: true, doc} or {ok: false, code: 'wrong_pin'
   * | 'locked', doc, lockedUntil?, retryInMs?, attemptsLeft?}; save the returned doc.
   * After 5 failures each failure locks for 30 s, doubling up to 15 min; the state is in
   * the document. While locked it resolves at once with code 'locked' and never hashes.
   * Rejects with 'bad_state' when no PIN is set, 'bad_input' for a malformed PIN.
   */
  async function verifyPin(doc, pin, now) {
    assertDoc(doc);
    checkNow(now);
    if (!doc.parent.pin) fail('bad_state', 'no PIN is set', 'pin');
    const nowMs = isoMs(now);
    const ls = lockState(doc.parent, nowMs);
    if (ls.ms > 0) {
      const d = ls.repaired ? begin(doc, now) : clone(doc);
      if (ls.repaired) d.parent.lockedUntil = new Date(ls.until).toISOString();
      return { ok: false, code: 'locked', doc: d, lockedUntil: d.parent.lockedUntil, retryInMs: ls.ms };
    }
    const digits = normalizePin(pin);
    if (!digits) fail('bad_input', 'a PIN is 4 to 6 digits', 'pin');
    const rec = doc.parent.pin;
    const salt = b64ToBytes(rec.salt);
    const want = b64ToBytes(rec.hash);
    if (!salt || !want || !Number.isInteger(rec.iterations)) fail('bad_state', 'the stored PIN is damaged', 'pin');
    const got = await pbkdf2(digits, salt, rec.iterations);
    if (sameBytes(got, want)) {
      if (doc.parent.failedAttempts === 0 && doc.parent.lockedUntil === null) return { ok: true, doc: clone(doc) };
      const d = begin(doc, now);
      d.parent.failedAttempts = 0;
      d.parent.lockedUntil = null;
      return { ok: true, doc: d };
    }
    const d = begin(doc, now);
    const p = d.parent;
    p.failedAttempts = Math.min(1000, p.failedAttempts + 1);
    const lockMs = lockMsFor(p.failedAttempts);
    const out = { ok: false, code: 'wrong_pin', doc: d, attemptsLeft: Math.max(0, LIMITS.pinFreeFailures - p.failedAttempts) };
    if (lockMs > 0) {
      p.lockedUntil = new Date(nowMs + lockMs).toISOString();
      out.lockedUntil = p.lockedUntil;
      out.retryInMs = lockMs;
    } else {
      p.lockedUntil = null;
    }
    return out;
  }

  // ===========================================================================
  // validateDoc: repair or reject a stored document (never throws)
  // ===========================================================================

  function vKeys(obj, allowed, path, note, special) {
    for (const k of Object.keys(obj)) {
      if (allowed.includes(k)) continue;
      note(`${path}.${k}`, (special && special[k]) || 'unknown field, dropped');
    }
  }

  function vInt(v, lo, hi, dflt, path, note) {
    if (Number.isInteger(v) && !Object.is(v, -0) && v >= lo && v <= hi) return v;
    const out = typeof v === 'number' && Number.isFinite(v) ? noNegZero(Math.min(hi, Math.max(lo, Math.round(v)))) : dflt;
    note(path, `invalid or out of range, set to ${out}`);
    return out;
  }

  function vEnum(v, list, dflt, path, note) {
    if (list.includes(v)) return v;
    note(path, `invalid, set to ${dflt}`);
    return dflt;
  }

  function vBool(v, dflt, path, note) {
    if (typeof v === 'boolean') return v;
    note(path, `invalid, set to ${dflt}`);
    return dflt;
  }

  function vIso(v, dflt, path, note) {
    if (isIso(v)) return v;
    note(path, 'invalid time, replaced');
    return dflt;
  }

  function vNullableIso(v, path, note) {
    if (v === null || isIso(v)) return v;
    note(path, 'invalid time, cleared');
    return null;
  }

  function vText(v, max, path, note) {
    const s = cleanText(v, max);
    if (s !== v && v !== undefined) note(path, typeof v === 'string' ? 'text cleaned or shortened' : 'not a text, cleared');
    return s;
  }

  function vOptText(v, max, path, note) {
    if (v === null || v === undefined) return null;
    const s = cleanText(v, max);
    if (s !== v) note(path, typeof v === 'string' ? (s ? 'text cleaned or shortened' : 'empty, cleared') : 'not a text, cleared');
    return s || null;
  }

  function vEmoji(v, list, dflt, path, note) {
    const e = normEmoji(v);
    const out = list.includes(e) ? e : dflt;
    if (out !== v) note(path, list.includes(e) ? 'emoji normalised' : `invalid emoji, set to ${dflt}`);
    return out;
  }

  function vReward(r, path, note) {
    if (r === null) return null;
    if (!isPlainObject(r)) {
      note(path, 'invalid reward, removed');
      return null;
    }
    vKeys(r, REWARD_KEYS, path, note);
    const text = cleanText(r.text, LIMITS.rewardText);
    if (!text) {
      note(path, 'reward without text, removed');
      return null;
    }
    if (text !== r.text) note(path + '.text', 'text cleaned or shortened');
    return { text, emoji: vEmoji(r.emoji, REWARD_EMOJIS, DEFAULT_REWARD_EMOJI, path + '.emoji', note) };
  }

  function vPin(p, note) {
    if (p === null) return null;
    const bad = () => {
      note('parent.pin', 'invalid PIN record, removed (a new PIN must be set)');
      return null;
    };
    if (!isPlainObject(p)) return bad();
    const salt = b64ToBytes(p.salt);
    const hash = b64ToBytes(p.hash);
    if (!salt || salt.length < LIMITS.pinSaltBytes || salt.length > 64) return bad();
    if (!hash || hash.length !== LIMITS.pinHashBytes) return bad();
    if (!Number.isInteger(p.iterations) || p.iterations < 100000 || p.iterations > 10000000) return bad();
    vKeys(p, PIN_KEYS, 'parent.pin', note);
    return { salt: p.salt, hash: p.hash, iterations: p.iterations };
  }

  function vParent(raw, note) {
    let p = raw;
    if (!isPlainObject(p)) {
      note('parent', 'missing, reset');
      p = {};
    }
    vKeys(p, PARENT_KEYS, 'parent', note);
    const pin = vPin(p.pin === undefined ? null : p.pin, note);
    let failedAttempts = vInt(p.failedAttempts, 0, 1000, 0, 'parent.failedAttempts', note);
    let lockedUntil = vNullableIso(p.lockedUntil === undefined ? null : p.lockedUntil, 'parent.lockedUntil', note);
    if (!pin && (failedAttempts !== 0 || lockedUntil !== null)) {
      note('parent', 'no PIN: backoff cleared');
      failedAttempts = 0;
      lockedUntil = null;
    }
    return {
      pin,
      failedAttempts,
      lockedUntil,
      consentAt: vNullableIso(p.consentAt === undefined ? null : p.consentAt, 'parent.consentAt', note),
      aiConsentAt: vNullableIso(p.aiConsentAt === undefined ? null : p.aiConsentAt, 'parent.aiConsentAt', note),
      uiLang: vEnum(p.uiLang, LANGS, 'en', 'parent.uiLang', note),
    };
  }

  function vChildQuran(raw, path, note) {
    let q = raw;
    if (!isPlainObject(q)) {
      note(path, 'missing, set to the default');
      q = {};
    }
    vKeys(q, CHILD_QURAN_KEYS, path, note);
    return {
      surah: vInt(q.surah, 1, LIMITS.surahs, CHILD_QURAN_DEFAULT.surah, path + '.surah', note),
      from: vInt(q.from, 1, LIMITS.ayahMax, CHILD_QURAN_DEFAULT.from, path + '.from', note),
      to: vInt(q.to, 1, LIMITS.ayahMax, CHILD_QURAN_DEFAULT.to, path + '.to', note),
      juzAmma: vBool(q.juzAmma, true, path + '.juzAmma', note),
    };
  }

  function vChildren(list, docCreatedAt, note) {
    if (!Array.isArray(list)) {
      note('children', 'not a list, reset');
      return [];
    }
    const out = [];
    const seen = new Set();
    list.forEach((c, i) => {
      const path = `children[${i}]`;
      if (!isPlainObject(c)) return note(path, 'not an object, dropped');
      if (!isId(c.id)) return note(path, 'no valid id, dropped');
      if (seen.has(c.id)) return note(path, 'duplicate id, dropped');
      seen.add(c.id);
      vKeys(c, CHILD_KEYS, path, note);
      const avatar = vEmoji(c.avatar, AVATARS, AVATARS[0], path + '.avatar', note);
      let nickname = vText(c.nickname, LIMITS.nickname, path + '.nickname', note);
      if (!nickname) {
        note(path + '.nickname', 'empty, set to the avatar');
        nickname = avatar;
      }
      out.push({
        id: c.id,
        nickname,
        age: vEnum(c.age, AGE_BANDS, '6-9', path + '.age', note),
        lang: vEnum(c.lang, LANGS, 'en', path + '.lang', note),
        avatar,
        createdAt: vIso(c.createdAt, docCreatedAt, path + '.createdAt', note),
        quran: vChildQuran(c.quran, path + '.quran', note),
      });
    });
    return out;
  }

  function vAttempts(list, path, note) {
    if (!Array.isArray(list)) {
      note(path, 'not a list, reset');
      return [];
    }
    let src = list;
    if (src.length > 1000) src = src.slice(-1000);
    const out = [];
    src.forEach((a, i) => {
      const p = `${path}[${i}]`;
      if (!isPlainObject(a)) return note(p, 'not an object, dropped');
      if (!isIso(a.at)) return note(p, 'no valid time, dropped');
      vKeys(a, ATTEMPT_KEYS, p, note);
      let accuracy = null;
      if (typeof a.accuracy === 'number' && Number.isFinite(a.accuracy)) {
        accuracy = clamp01(a.accuracy);
        if (!Object.is(accuracy, a.accuracy)) note(p + '.accuracy', 'clamped to 0..1');
      } else if (a.accuracy !== null) {
        note(p + '.accuracy', 'invalid, cleared');
      }
      const count = (v, f) => {
        if (v === null) return null;
        if (typeof v === 'number' && Number.isFinite(v)) return vInt(v, 0, 1000000, 0, `${p}.${f}`, note);
        note(`${p}.${f}`, 'invalid, cleared');
        return null;
      };
      let verdict = a.verdict;
      if (verdict !== null && !VERDICTS.includes(verdict)) {
        note(p + '.verdict', 'invalid, cleared');
        verdict = null;
      }
      out.push({
        at: a.at,
        accuracy,
        verdict,
        nErrors: count(a.nErrors, 'nErrors'),
        nExpected: count(a.nExpected, 'nExpected'),
        passed: vBool(a.passed, false, p + '.passed', note),
      });
    });
    if (out.length > LIMITS.attempts) {
      note(path, `more than ${LIMITS.attempts} attempts, kept the newest`);
      return out.slice(-LIMITS.attempts);
    }
    return out;
  }

  function vTaskQuran(raw, path, note) {
    if (!isPlainObject(raw) || typeof raw.surah !== 'number' || !Number.isFinite(raw.surah)) return null;
    vKeys(raw, TASK_QURAN_KEYS, path, note);
    const surah = vInt(raw.surah, 1, LIMITS.surahs, 1, path + '.surah', note);
    const from = vInt(raw.from, 1, LIMITS.ayahMax, 1, path + '.from', note);
    const to = vInt(raw.to, from, Math.min(LIMITS.ayahMax, from + LIMITS.ayatPerTask - 1), from, path + '.to', note);
    return { surah, from, to, memory: vBool(raw.memory, false, path + '.memory', note) };
  }

  function snapAccuracy(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
    return v >= 0.95 ? 1 : v >= 0.85 ? 0.9 : 0.8;
  }

  function vTask(t, i, childIds, seen, docCreatedAt, note) {
    const path = `tasks[${i}]`;
    if (!isPlainObject(t)) return note(path, 'not an object, dropped');
    if (!isId(t.id)) return note(path, 'no valid id, dropped');
    if (seen.has(t.id)) return note(path, 'duplicate id, dropped');
    if (!childIds.has(t.childId)) return note(path, 'its child does not exist, dropped');
    if (!KINDS.includes(t.kind)) return note(path, 'unknown kind, dropped');
    const kind = t.kind;
    const content = {};
    if (kind === 'quran') {
      content.quran = vTaskQuran(t.quran, path + '.quran', note);
      if (!content.quran) return note(path, 'no valid Quran range, dropped');
    } else {
      content.text = vText(t.text, LIMITS.text, path + '.text', note);
      if (!content.text) return note(path, 'no text, dropped');
      content.lang = LANGS.includes(t.lang) ? t.lang : ARABIC_RE.test(content.text) ? 'ar' : 'en';
      if (content.lang !== t.lang) note(path + '.lang', `invalid, set to ${content.lang}`);
      if (kind === 'recite') content.mode = vEnum(t.mode, MODES, 'strict', path + '.mode', note);
    }
    seen.add(t.id);
    const special = { mode: kind === 'quran' ? 'a Quran task never carries a mode, removed' : 'a dictation task has no mode, removed' };
    vKeys(t, TASK_COMMON_KEYS.concat(TASK_KIND_KEYS[kind]), path, note, special);
    const createdAt = vIso(t.createdAt, docCreatedAt, path + '.createdAt', note);
    const updatedAt = vIso(t.updatedAt, createdAt, path + '.updatedAt', note);
    let title = vText(t.title, LIMITS.title, path + '.title', note);
    if (!title) {
      title = defaultTitle(kind, content);
      note(path + '.title', 'empty, set to the default');
    }
    let minAccuracy = 1;
    if (isPlainObject(t.pass)) {
      vKeys(t.pass, ['minAccuracy'], path + '.pass', note);
      minAccuracy = snapAccuracy(t.pass.minAccuracy);
      if (minAccuracy !== t.pass.minAccuracy) note(path + '.pass.minAccuracy', `set to ${minAccuracy}`);
    } else {
      note(path + '.pass', 'missing, set to all words');
    }
    const stars = vInt(t.stars, LIMITS.starsMin, LIMITS.starsMax, LIMITS.starsDefault, path + '.stars', note);
    const reward = vReward(t.reward === undefined ? null : t.reward, path + '.reward', note);
    let due = t.due === undefined ? null : t.due;
    if (due !== null && !isDay(due)) {
      note(path + '.due', 'invalid date, cleared');
      due = null;
    }
    const status = vEnum(t.status, STATUSES, 'assigned', path + '.status', note);
    const attempts = vAttempts(t.attempts, path + '.attempts', note);
    let readyAt = vNullableIso(t.readyAt === undefined ? null : t.readyAt, path + '.readyAt', note);
    let doneAt = vNullableIso(t.doneAt === undefined ? null : t.doneAt, path + '.doneAt', note);
    let confirmedBy = t.confirmedBy === undefined ? null : t.confirmedBy;
    if (confirmedBy !== null && !CONFIRMED_BY.includes(confirmedBy)) {
      note(path + '.confirmedBy', 'invalid, cleared');
      confirmedBy = null;
    }
    const sentBackAt = vNullableIso(t.sentBackAt === undefined ? null : t.sentBackAt, path + '.sentBackAt', note);
    const sentBackNote = vOptText(t.sentBackNote, LIMITS.sentBackNote, path + '.sentBackNote', note);
    let rewardGivenAt = vNullableIso(t.rewardGivenAt === undefined ? null : t.rewardGivenAt, path + '.rewardGivenAt', note);

    // Make the status fields agree with each other.
    const fix = (what) => note(path, what);
    if (status === 'assigned' && readyAt !== null) {
      fix('to do: readyAt cleared');
      readyAt = null;
    }
    if (status === 'ready' && readyAt === null) {
      fix('waiting: readyAt set');
      readyAt = updatedAt;
    }
    if (status === 'assigned' || status === 'ready') {
      if (doneAt !== null || confirmedBy !== null) fix('not done: doneAt and confirmedBy cleared');
      doneAt = null;
      confirmedBy = null;
    } else if (status === 'done') {
      if (doneAt === null) {
        fix('done: doneAt set');
        doneAt = updatedAt;
      }
      if (confirmedBy === null) {
        fix('done: confirmedBy set');
        confirmedBy = 'parent_override';
      }
    } else if ((doneAt === null) !== (confirmedBy === null)) {
      fix('archived: doneAt and confirmedBy cleared');
      doneAt = null;
      confirmedBy = null;
    }
    const wasDone = doneAt !== null;
    let rewardStatus;
    if (!reward) rewardStatus = 'none';
    else if (!wasDone) rewardStatus = 'locked';
    else rewardStatus = t.rewardStatus === 'given' ? 'given' : 'unlocked';
    if (rewardStatus !== t.rewardStatus) note(path + '.rewardStatus', `set to ${rewardStatus}`);
    if (rewardStatus === 'given' && rewardGivenAt === null) {
      fix('reward given: rewardGivenAt set');
      rewardGivenAt = doneAt;
    } else if (rewardStatus !== 'given' && rewardGivenAt !== null) {
      fix('reward not given: rewardGivenAt cleared');
      rewardGivenAt = null;
    }
    return buildTask(Object.assign({
      id: t.id,
      childId: t.childId,
      createdAt,
      updatedAt,
      kind,
      title,
      pass: { minAccuracy },
      stars,
      reward,
      due,
      status,
      attempts,
      readyAt,
      doneAt,
      confirmedBy,
      sentBackAt,
      sentBackNote,
      rewardStatus,
      rewardGivenAt,
    }, content));
  }

  function vGoals(list, goalIds, docCreatedAt, path, note) {
    if (!Array.isArray(list)) {
      note(path, 'not a list, reset');
      return [];
    }
    const out = [];
    list.forEach((g, i) => {
      const p = `${path}[${i}]`;
      if (!isPlainObject(g)) return note(p, 'not an object, dropped');
      if (!isId(g.id)) return note(p, 'no valid id, dropped');
      if (goalIds.has(g.id)) return note(p, 'duplicate id, dropped');
      if (typeof g.cost !== 'number' || !Number.isFinite(g.cost)) return note(p, 'no cost, dropped');
      const reward = vReward(g.reward === undefined ? null : g.reward, p + '.reward', note);
      if (!reward) return note(p, 'no reward, dropped');
      goalIds.add(g.id);
      vKeys(g, GOAL_KEYS, p, note);
      const status = vEnum(g.status, GOAL_STATUSES, 'open', p + '.status', note);
      const createdAt = vIso(g.createdAt, docCreatedAt, p + '.createdAt', note);
      let givenAt = vNullableIso(g.givenAt === undefined ? null : g.givenAt, p + '.givenAt', note);
      if (status === 'given' && givenAt === null) {
        note(p, 'given: givenAt set');
        givenAt = createdAt;
      } else if (status === 'open' && givenAt !== null) {
        note(p, 'open: givenAt cleared');
        givenAt = null;
      }
      out.push({ id: g.id, cost: vInt(g.cost, LIMITS.goalCostMin, LIMITS.goalCostMax, 1, p + '.cost', note), reward, status, givenAt, createdAt });
    });
    return out;
  }

  function vLedger(list, doneTaskIds, givenGoalIds, docCreatedAt, path, note) {
    if (!Array.isArray(list)) {
      note(path, 'not a list, reset');
      return [];
    }
    let out = [];
    const seenTask = new Set();
    const seenGoal = new Set();
    list.forEach((e, i) => {
      const p = `${path}[${i}]`;
      if (!isPlainObject(e)) return note(p, 'not an object, dropped');
      if (typeof e.delta !== 'number' || !Number.isFinite(e.delta)) return note(p, 'no amount, dropped');
      vKeys(e, LEDGER_KEYS, p, note);
      const delta = vInt(e.delta, -1000000, 1000000, 0, p + '.delta', note);
      const at = vIso(e.at, docCreatedAt, p + '.at', note);
      const reason = vEnum(e.reason, LEDGER_REASONS, 'adjust', p + '.reason', note);
      let ref = e.ref === undefined ? null : e.ref;
      if (ref !== null && !isId(ref)) {
        note(p + '.ref', 'invalid, cleared');
        ref = null;
      }
      if (reason === 'task' && ref !== null) {
        if (!doneTaskIds.has(ref)) {
          note(p + '.ref', 'no such confirmed task, cleared');
          ref = null;
        } else if (seenTask.has(ref)) {
          return note(p, 'stars of a task credited twice, dropped');
        } else {
          seenTask.add(ref);
        }
      } else if (reason === 'goal' && ref !== null) {
        if (!givenGoalIds.has(ref)) {
          note(p + '.ref', 'no such given goal, cleared');
          ref = null;
        } else if (seenGoal.has(ref)) {
          return note(p, 'goal paid twice, dropped');
        } else {
          seenGoal.add(ref);
        }
      } else if ((reason === 'adjust' || reason === 'carry') && ref !== null) {
        note(p + '.ref', 'cleared');
        ref = null;
      }
      let n = null;
      if (reason === 'adjust') n = vOptText(e.note, LIMITS.adjustNote, p + '.note', note);
      else if (e.note !== undefined && e.note !== null) note(p + '.note', 'only an adjustment has a note, cleared');
      out.push({ at, delta, reason, ref, note: n });
    });
    if (out.length > LIMITS.ledger) {
      note(path, `more than ${LIMITS.ledger} entries, the oldest folded into one carry entry`);
      out = foldLedger(out);
    }
    return out;
  }

  function vJar(raw, childId, tasks, goalIds, docCreatedAt, docUpdatedAt, note) {
    const path = `jar.${childId}`;
    let j = raw;
    if (!isPlainObject(j)) {
      note(path, j === undefined ? 'missing, created empty' : 'invalid, reset');
      j = {};
    }
    vKeys(j, JAR_KEYS, path, note);
    const goals = vGoals(j.goals, goalIds, docCreatedAt, path + '.goals', note);
    const doneTaskIds = new Set(tasks.filter((t) => t.childId === childId && t.doneAt !== null).map((t) => t.id));
    const givenGoalIds = new Set(goals.filter((g) => g.status === 'given').map((g) => g.id));
    let ledger = vLedger(j.ledger, doneTaskIds, givenGoalIds, docCreatedAt, path + '.ledger', note);
    let sum = 0;
    for (const e of ledger) sum += e.delta;
    if (sum < 0) {
      note(path + '.ledger', 'negative total, corrected with an adjustment');
      const at = ledger.length ? ledger[ledger.length - 1].at : docUpdatedAt;
      ledger = foldLedger(ledger.concat([{ at, delta: -sum, reason: 'adjust', ref: null, note: null }]));
      sum = 0;
    }
    if (j.balance !== sum) note(path + '.balance', `set to ${sum} to match the ledger`);
    let earned = vInt(j.earned, 0, 1000000000, 0, path + '.earned', note);
    if (earned < sum) {
      note(path + '.earned', 'below the balance, raised');
      earned = sum;
    }
    return { balance: sum, earned, goals, ledger };
  }

  function vSurprises(list, childIds, docCreatedAt, note) {
    if (!Array.isArray(list)) {
      note('surprises', 'not a list, reset');
      return [];
    }
    const out = [];
    const seen = new Set();
    list.forEach((s, i) => {
      const p = `surprises[${i}]`;
      if (!isPlainObject(s)) return note(p, 'not an object, dropped');
      if (!isId(s.id)) return note(p, 'no valid id, dropped');
      if (seen.has(s.id)) return note(p, 'duplicate id, dropped');
      if (!childIds.has(s.childId)) return note(p, 'its child does not exist, dropped');
      const reward = vReward(s.reward === undefined ? null : s.reward, p + '.reward', note);
      if (!reward) return note(p, 'no reward, dropped');
      seen.add(s.id);
      vKeys(s, SURPRISE_KEYS, p, note);
      out.push({
        id: s.id,
        childId: s.childId,
        reward,
        at: vIso(s.at, docCreatedAt, p + '.at', note),
        seenAt: vNullableIso(s.seenAt === undefined ? null : s.seenAt, p + '.seenAt', note),
      });
    });
    return out;
  }

  function validateInner(input) {
    let raw = input;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch (e) {
        return { ok: false, doc: null, repaired: [], errors: ['not_json'] };
      }
    }
    if (!isPlainObject(raw)) return { ok: false, doc: null, repaired: [], errors: ['not_object'] };
    if (raw.version !== VERSION) return { ok: false, doc: null, repaired: [], errors: ['unknown_version'] };
    const repaired = [];
    const note = (path, what) => {
      repaired.push(`${path}: ${what}`);
    };
    vKeys(raw, DOC_KEYS, 'doc', note);
    const createdAt = vIso(raw.createdAt, isIso(raw.updatedAt) ? raw.updatedAt : EPOCH, 'createdAt', note);
    const updatedAt = vIso(raw.updatedAt, createdAt, 'updatedAt', note);
    const parent = vParent(raw.parent, note);
    const children = vChildren(raw.children, createdAt, note);
    const childIds = new Set(children.map((c) => c.id));
    const tasks = [];
    if (Array.isArray(raw.tasks)) {
      const seen = new Set();
      raw.tasks.forEach((t, i) => {
        const v = vTask(t, i, childIds, seen, createdAt, note);
        if (v) tasks.push(v);
      });
    } else {
      note('tasks', 'not a list, reset');
    }
    let rawJar = raw.jar;
    if (!isPlainObject(rawJar)) {
      note('jar', 'not an object, reset');
      rawJar = {};
    }
    for (const k of Object.keys(rawJar)) if (!childIds.has(k)) note(`jar.${k}`, 'its child does not exist, dropped');
    const jar = {};
    const goalIds = new Set();
    for (const c of children) {
      jar[c.id] = vJar(hasOwn(rawJar, c.id) ? rawJar[c.id] : undefined, c.id, tasks, goalIds, createdAt, updatedAt, note);
    }
    const surprises = vSurprises(raw.surprises, childIds, createdAt, note);
    let activeChildId = raw.activeChildId === undefined ? null : raw.activeChildId;
    if (activeChildId !== null && !childIds.has(activeChildId)) {
      note('activeChildId', 'no such child, cleared');
      activeChildId = null;
    }
    const doc = { version: VERSION, createdAt, updatedAt, parent, children, activeChildId, tasks, jar, surprises };
    return { ok: true, doc, repaired, errors: [] };
  }

  /**
   * Repairs or rejects a stored document (an object or its JSON string); never throws.
   * Returns {ok, doc, repaired, errors}:
   *   - ok false (doc null, errors ['not_json' | 'not_object' | 'unknown_version' | ...]):
   *     keep the raw value under CORRUPT_KEY_PREFIX + timestamp and start fresh;
   *   - ok true: doc is canonical. repaired lists what was changed ("path: what"): unknown
   *     fields dropped, numbers clamped, attempts capped at 20 and the ledger at 200 (the
   *     oldest entries folded into a 'carry' entry), duplicate ids dropped (first kept),
   *     dangling references removed, status fields made consistent, a Quran task's mode
   *     removed, the balance set to the sum of the ledger (never below 0) and earned to at
   *     least the balance. validateDoc(validateDoc(x).doc).doc deep-equals validateDoc(x).doc,
   *     and a document made by this module's functions is returned with nothing repaired.
   */
  function validateDoc(input) {
    try {
      return validateInner(input);
    } catch (e) {
      return { ok: false, doc: null, repaired: [], errors: ['unreadable'] };
    }
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  return Object.freeze({
    // constants
    VERSION,
    STORAGE_KEY,
    V1_KEY,
    CORRUPT_KEY_PREFIX,
    LANGS: Object.freeze(LANGS.slice()),
    AGE_BANDS: Object.freeze(AGE_BANDS.slice()),
    KINDS: Object.freeze(KINDS.slice()),
    MODES: Object.freeze(MODES.slice()),
    MIN_ACCURACIES: Object.freeze(MIN_ACCURACIES.slice()),
    STATUSES: Object.freeze(STATUSES.slice()),
    REWARD_STATUSES: Object.freeze(REWARD_STATUSES.slice()),
    LEDGER_REASONS: Object.freeze(LEDGER_REASONS.slice()),
    ERROR_CODES: Object.freeze(ERROR_CODES.slice()),
    AVATARS: Object.freeze(AVATARS.slice()),
    REWARD_EMOJIS: Object.freeze(REWARD_EMOJIS.slice()),
    LIMITS,
    CHILD_QURAN_DEFAULT,
    RewardsError,
    // document
    emptyDoc,
    migrateV1,
    validateDoc,
    updateParent,
    // children
    addChild,
    updateChild,
    removeChild,
    setActiveChild,
    // tasks
    createTask,
    updateTask,
    archiveTask,
    recordAttempt,
    passes,
    readResult: (task, result) => {
      const r = readResult(task, result);
      return r ? Object.assign({}, r) : null;
    },
    defaultTitle: (kind, content, surahName) => {
      const c = isPlainObject(content) ? content : {};
      if (kind === 'quran' && !isPlainObject(c.quran)) return cleanText(surahName, LIMITS.title);
      return defaultTitle(kind, c, surahName);
    },
    // review
    confirmTask,
    sendBack,
    markRewardGiven,
    // jar
    addGoal,
    removeGoal,
    giveGoal,
    adjustStars,
    // surprises
    addSurprise,
    markSurpriseSeen,
    // views
    childSummary,
    reviewQueue,
    improvement,
    taskStats,
    passRule,
    taskActions,
    getChild,
    getTask,
    getJar,
    // PIN
    normalizePin,
    isValidPin,
    hashPin,
    setPin,
    clearPin,
    verifyPin,
    pinStatus,
  });
});

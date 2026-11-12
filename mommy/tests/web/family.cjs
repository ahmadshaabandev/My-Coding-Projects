#!/usr/bin/env node
/*
 * Browser test of the family UI (web/family.js on web/rewards.js and web/app.js),
 * docs/REWARDS.md "Web client". Like smoke.cjs it runs without the Python
 * backend: web/ is served by a tiny Node server and every /api/* request is answered by
 * the contract-shaped fake API of helpers.cjs (/api/text/check included).
 *
 * What is checked:
 *   - first run: the family setup (AI disclosure, consent, a PIN typed twice, the first
 *     child with nickname, age, language and an avatar from the fixed list); the PIN is
 *     stored hashed;
 *   - later runs: "Who is learning?" with big targets, the AI disclosure and "For
 *     parents"; the AI badge on every screen;
 *   - the parent area behind the PIN: sections and their empty states, children (add, edit, remove
 *     with a confirmation), tasks of each kind for two children with the server checks of
 *     the text in the mode of the task (empty, Quran text, language, [?], by meaning,
 *     offline keeps the form), a page photo read into the text, edit without a new
 *     check, archive;
 *   - tasks with Quran in a school text (docs/REWARDS.md, decision 5): a recite task word
 *     by word only ("The meaning" disabled with the reason), a dictation task with the
 *     basmala on its own line, the differences from the mushaf before saving ("Use the
 *     mushaf text", or a second "Save"), a text that is Quran becoming a Quran task on
 *     its ayat, a page photo with a misread ayah, the task runner with the grown-up step
 *     and Quran feedback never spoken, the form in Arabic at 360 px;
 *   - the task runner: a recite task (mode locked) that fails then passes (try again,
 *     celebration with stars and reward, the improvement line, only scores stored); a
 *     dictation task with "Confirm the task now" (PIN) after the parent's review; a Quran
 *     task with no mode selector and its range and from-memory fixed;
 *   - To review: the queue across children (child, task, best and last result, tries,
 *     when it became ready, the improvement, the two notes), Confirm (stars in the jar,
 *     reward unlocked), "Not yet: try again" with a note the child then sees; the details
 *     of a task with "Confirm anyway" for a task never passed;
 *   - Rewards: task rewards marked "Given" (the Done shelf says "Received"), goals (add,
 *     "Give" only when the jar covers it, remove), a surprise shown once on the child's
 *     home, "Adjust stars" with a reason and never below zero, the history of the stars;
 *   - Settings: change the PIN, the parent's language (the children keep theirs), delete
 *     all data on this device (two confirmations; v1 and the copies kept aside go too);
 *   - two tabs: a surprise appears live on the other tab's home; deleting all data sends
 *     the other tab to the setup;
 *   - the motivation rules: the child-facing strings never shame, count down or take
 *     stars away, and the child's home shows no loss after a correction or a goal given;
 *   - the PIN backoff with the remaining time (a controlled clock), kept in the document;
 *     "Forgot PIN" behind a multiplication in words, which keeps all the data;
 *   - v1 migration; a corrupt document kept aside; a repaired one; a full storage shown;
 *     another tab's change reloaded;
 *   - the privacy texts of the parent area in the four ways the app runs (local or
 *     online, with or without Claude): Settings' family data line and consent box, the
 *     task form's photo note, in en, fr and ar; online, no local-only sentence;
 *   - the Arabic UI at 360 px (the setup, the child's home, every parent section): RTL,
 *     Arabic-Indic digits, no overflow, touch targets of at least 44 px; dark mode; the
 *     app.js/family.js handshake in either script order;
 *   - no console errors (besides the 4xx answers the checks ask for), no request to any
 *     other host than the page's own, and no /api/tts request holding a Quran part.
 *
 * Run:   node tests/web/family.cjs
 * Screenshots (optional): MOMMY_SHOTS_DIR=/some/dir node tests/web/family.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');
const H = require('./helpers.cjs');
const R = require(path.join(H.WEB, 'rewards.js'));

const { check, sleep, PIN, PAGE_TEXT, QURAN_SAMPLE, BASMALA_TEXT, BASMALA_LINE_TEXT, DICTATION_RESULT } = H;

const AR_TEXT = 'ذَهَبَ الْوَلَدُ إِلَى الْمَدْرَسَةِ مَعَ أَخِيهِ.';
const NOTE_AR = 'هيا نقرأ الآية الثانية ببطء.';
const SUN_TEXT = 'The sun is hot today.';
const FR_TEXT = 'Le chat dort sur le tapis.';
const VIEW = { width: 360, height: 780 };

/** Seed localStorage once per tab (the first load), before the page's scripts run. */
function seedScript(entries) {
  if (sessionStorage.getItem('__seeded')) return;
  for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  sessionStorage.setItem('__seeded', '1');
}

/** Wait until the page's animations (the surprise card) have finished, for steady screenshots. */
async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));
}

/**
 * The motivation rules of docs/REWARDS.md on the child's side: specific praise, the
 * improvement line, and never a countdown, a lost star, a penalty or shame. These are the
 * family strings a child sees (home, task cards, the task runner, surprises).
 */
const CHILD_KEYS = [
  'fam_jar', 'fam_goal_missing', 'fam_goal_missing_one', 'fam_goal_reached', 'fam_todo', 'fam_waiting', 'fam_done',
  'fam_todo_empty', 'fam_waiting_empty', 'fam_done_empty', 'fam_due', 'fam_note_label', 'fam_pass_line',
  'fam_reward_unlocked', 'fam_reward_given', 'fam_surprise_title', 'fam_surprise_ok', 'fam_task_leave',
  'fam_celebrate', 'fam_celebrate_reward', 'fam_improve', 'fam_improve_one', 'fam_improve_two', 'fam_improve_few',
  'fam_improve_many', 'fam_try_again',
];
const SHAME = {
  en: /\b(wrong|fail\w*|bad|lost|lose|penalt\w*|late|overdue|left|hurry|only|deadline|minus)\b/i,
  fr: /\b(faux|fausse|rat[ée]e?|échec|perdu\w*|pénalit\w*|retard|reste\w*|vite|seulement|dépêche)\b/i,
  ar: /(خطأ|خاطئ|فشل|رسوب|خسر|خسارة|عقوبة|تأخ|متأخر|بسرعة|فقط|متبق)/,
};

function motivationRules() {
  for (const lang of ['en', 'fr', 'ar']) {
    const table = H.uiStrings(lang, 'family.js');
    const bad = [];
    for (const key of CHILD_KEYS) {
      assert.ok(table[key], `${lang}.${key} exists`);
      if (SHAME[lang].test(table[key])) bad.push(`${lang}.${key}: ${table[key]}`);
    }
    assert.deepEqual(bad, [], 'child-facing wording that shames, counts down or takes away');
  }
  // The improvement line and the praise are there in every language.
  assert.match(H.uiStrings('en', 'family.js').fam_improve, /more words right than last time/);
  assert.match(H.uiStrings('en', 'family.js').fam_try_again, /whenever you are ready/);
}

/** Status lines and texts, trimmed. */
async function text(page, sel) {
  return (await page.textContent(sel)).trim();
}

/** The visible text of a node without the text typed by people (<bdi>), for digit checks. */
function ownText(sel) {
  const root = document.querySelector(sel);
  const out = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    const p = n.parentElement;
    if (p.closest('bdi, [hidden], .sr-only') || !p.getClientRects().length) continue;
    out.push(n.data);
  }
  return out.join(' ');
}

/** A dictation result with every word right, for the text `t`. */
function perfectDictation(t) {
  const words = t.split(/\s+/);
  return Object.assign({}, DICTATION_RESULT, {
    read_text: t,
    result: {
      ops: words.map((w, i) => ({ kind: 'match', exp_index: i, heard_index: i, expected: w, heard: w })),
      n_expected: words.length,
      n_errors: 0,
      first_error_exp_index: null,
      verdict: 'correct',
      say_again: false,
      word_accuracy: 1,
    },
    feedback: 'Parfait ! Tous les mots sont justes.',
  });
}

/** Open the task form of the parent area for a child (by nickname) and a kind. */
async function newTask(page, nickname, kind) {
  await H.parentSection(page, 'tasks');
  const value = await page.$eval('#pt-child', (s, name) => [...s.options].find((o) => o.textContent.includes(name)).value, nickname);
  await page.selectOption('#pt-child', value);
  await page.click('#pt-new');
  await page.waitForSelector('#tf:not([hidden])');
  await page.check(`input[name="tf-kind"][value="${kind}"]`);
}

/** Save the task form and wait for the answer (an error, or the form closed). */
async function saveTask(page) {
  await page.click('#tf-save');
  await page.waitForFunction(() => document.querySelector('#tf').hidden || document.querySelector('#tf-status').classList.contains('is-error'));
}

async function tfError(page) {
  return text(page, '#tf-status');
}

/** A family document built with rewards.js: an Arabic child with a goal, stars, tasks and a surprise. */
async function arabicDoc() {
  const now = '2026-11-10T10:00:00.000Z';
  let d = R.emptyDoc(now, { uiLang: 'ar' });
  d = R.updateParent(d, { consent: true, aiConsent: true }, now);
  d = await R.setPin(d, PIN, now);
  let r = R.addChild(d, { nickname: 'سلمى', age: '6-9', lang: 'ar', avatar: '🦊' }, now);
  d = r.doc;
  const c = r.child.id;
  d = R.addGoal(d, c, { cost: 10, reward: { text: 'بوظة', emoji: '🍦' } }, now).doc;
  d = R.adjustStars(d, c, 3, now, 'بداية');
  d = R.createTask(d, { childId: c, kind: 'recite', text: AR_TEXT, lang: 'ar', stars: 3, reward: { text: 'قصة', emoji: '📚' }, due: '2026-12-05' }, now).doc;
  r = R.createTask(d, { childId: c, kind: 'dictation', text: 'ذهب الولد إلى المدرسة.', lang: 'ar', stars: 2, reward: { text: 'لعبة', emoji: '🧸' } }, now);
  d = R.confirmTask(r.doc, r.task.id, 'parent_override', now);
  d = R.addSurprise(d, c, { text: 'نزهة في الحديقة', emoji: '🌳' }, now).doc;
  assert.deepEqual(R.validateDoc(d).repaired, []);
  return d;
}

// ---------------------------------------------------------------------------
// Tasks with Quran in a school text (docs/REWARDS.md, decision 5; docs/CONTRACT.md,
// hard rule 4, Q1 and Q2)
// ---------------------------------------------------------------------------

const EN_TASK_SAVED_QURAN = 'The task was saved. Its text has words of the Quran: they are checked word by word, and in a dictation a grown-up reads them aloud.';

async function quranTasksFlow(browser, base) {
  const FX = H.quranFixtures();
  const LESSON = H.fakeQuranAnalysis(FX.LESSON, 'ar');
  const DIFF = H.fakeQuranAnalysis(FX.LESSON_MISREAD, 'ar').parts[0].differences[0];
  const BASMALA_PLAN = H.fakeQuranAnalysis(BASMALA_LINE_TEXT, 'ar').plan([]);
  const { context, page, fake, problems } = await H.newPage(browser, base, VIEW);
  const textChecks = () => fake.callsTo('/api/text/check');
  const storedTask = async (pred) => (await H.storedDoc(page)).tasks.find(pred);

  await check('Q2 tasks: a recite task whose text quotes an ayah is saved word by word, with the note about its Quran words', async () => {
    await page.goto(base + '/');
    await H.setupFamily(page, { nickname: 'Salma', childLang: 'ar' });
    await H.openParent(page);
    await newTask(page, 'Salma', 'recite');
    await page.fill('#tf-text', FX.LESSON);
    await page.selectOption('#tf-lang', 'ar');
    await page.fill('#tf-title', 'Patience');
    await saveTask(page);
    assert.ok(await page.isHidden('#tf'));
    assert.deepEqual(textChecks().at(-1).json, { text: FX.LESSON, lang: 'ar', mode: 'strict' });
    assert.equal(await text(page, '#pt-status'), EN_TASK_SAVED_QURAN);
    const task = await storedTask((x) => x.title === 'Patience');
    assert.deepEqual([task.kind, task.mode, task.text], ['recite', 'strict', FX.LESSON]);
  });

  await check('Q2 tasks: by meaning, the text with Quran words is refused with the reason; "The meaning" is disabled and "Word by word" chosen; saved on the second press', async () => {
    await newTask(page, 'Salma', 'recite');
    await page.check('input[name="tf-mode"][value="contextual"]');
    await page.fill('#tf-text', FX.LESSON);
    await page.selectOption('#tf-lang', 'ar');
    await page.fill('#tf-title', 'Patience by meaning');
    const n0 = textChecks().length;
    await saveTask(page);
    assert.equal(await tfError(page), 'This text has words of the Quran, and the app never judges the meaning of the Quran, so “The meaning” is not available for it. “Word by word” is now chosen: please check the task and save it again.');
    assert.deepEqual(textChecks().slice(n0).map((c) => c.json.mode), ['contextual', 'strict']);
    assert.ok(await page.isChecked('input[name="tf-mode"][value="strict"]'));
    assert.ok(await page.isDisabled('input[name="tf-mode"][value="contextual"]'));
    assert.equal(await text(page, '#tf-mode-why'), '“The meaning” is not available for this text: it has words of the Quran, and the app never judges the meaning of the Quran. They are checked word by word.');
    assert.ok(await page.isVisible('#tf-quran'));
    await page.waitForFunction(() => document.querySelector('#tf-quran .qp-refs').textContent.trim().startsWith('Surah Al-Baqara, ayah 153 “'));
    assert.ok(await page.isVisible('#tf-pass'), 'word by word has its pass level again');
    // Another text gives "The meaning" back.
    await page.fill('#tf-text', AR_TEXT);
    assert.ok(await page.isEnabled('input[name="tf-mode"][value="contextual"]'));
    assert.ok(await page.isHidden('#tf-mode-why'));
    assert.ok(await page.isHidden('#tf-quran'));
    await page.fill('#tf-text', FX.LESSON);
    await saveTask(page);
    assert.ok(await page.isHidden('#tf'));
    assert.equal((await storedTask((x) => x.title === 'Patience by meaning')).mode, 'strict');
  });

  await check('Q2 tasks: the differences from the mushaf are shown before saving; "Use the mushaf text" puts the mushaf words in and saves', async () => {
    await newTask(page, 'Salma', 'recite');
    await page.fill('#tf-text', FX.LESSON_MISREAD);
    await page.selectOption('#tf-lang', 'ar');
    await page.fill('#tf-title', 'Misread');
    await saveTask(page);
    assert.equal(await tfError(page), 'Some words of the Quran in this text are not as in the mushaf: see the note under the text. Please use the mushaf text before saving.');
    assert.ok(await page.isVisible('#tf'), 'not saved yet');
    // UX-03: a recite task is never saved with a misquote (the child would read it).
    await saveTask(page);
    assert.match(await tfError(page), /Please use the mushaf text before saving\.$/);
    assert.ok(await page.isVisible('#tf'), 'a second Save does not keep the misquote of a recite task');
    assert.equal(await text(page, '#tf-quran .qp-diff-list'), `typed “${FX.MISREAD_TYPED}”, in the mushaf “${DIFF.mushaf_clean}” (${DIFF.mushaf})`);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tf-quran');
    assert.equal(await storedTask((x) => x.title === 'Misread'), undefined);
    const n0 = textChecks().length;
    await page.click('#tf-quran .qp-use');
    await page.waitForSelector('#tf', { state: 'hidden' });
    assert.deepEqual(textChecks().slice(n0).map((c) => c.json.text), [FX.LESSON], 'the mushaf text is checked, then saved');
    assert.equal((await storedTask((x) => x.title === 'Misread')).text, FX.LESSON);
    assert.equal(await text(page, '#pt-status'), EN_TASK_SAVED_QURAN);
  });

  await check('Q2 tasks: a dictation task with the basmala on a line of its own is allowed (a grown-up reads it); a misread text can be kept as typed with a second "Save"', async () => {
    await newTask(page, 'Salma', 'dictation');
    await page.fill('#tf-text', BASMALA_LINE_TEXT);
    await page.selectOption('#tf-lang', 'ar');
    await page.fill('#tf-title', 'Basmala dictation');
    await saveTask(page);
    assert.ok(await page.isHidden('#tf'));
    assert.deepEqual(textChecks().at(-1).json, { text: BASMALA_LINE_TEXT, lang: 'ar', mode: 'dictation' });
    assert.equal(await text(page, '#pt-status'), EN_TASK_SAVED_QURAN);
    const task = await storedTask((x) => x.title === 'Basmala dictation');
    assert.equal(task.kind, 'dictation');
    assert.ok(!('mode' in task));
    // Kept as typed: the checks use the mushaf words anyway.
    await newTask(page, 'Salma', 'dictation');
    await page.fill('#tf-text', FX.LESSON_MISREAD);
    await page.selectOption('#tf-lang', 'ar');
    await page.fill('#tf-title', 'Kept as typed');
    await saveTask(page);
    assert.match(await tfError(page), /^Some words of the Quran in this text are not as in the mushaf/);
    await saveTask(page);
    assert.ok(await page.isHidden('#tf'));
    assert.equal((await storedTask((x) => x.title === 'Kept as typed')).text, FX.LESSON_MISREAD);
    await page.click('#pt-list .ptask:has-text("Kept as typed") [data-archive-task]');
    await page.click('#pt-list .ptask:has-text("Kept as typed") [data-archive-yes]');
  });

  await check('Q1 tasks: a text that is Quran points to a Quran task, and "Create a Quran task with these ayat" fills the surah and the range (quran_range)', async () => {
    await newTask(page, 'Salma', 'dictation');
    await page.fill('#tf-text', FX.Q1_FRAMED);
    await page.selectOption('#tf-lang', 'ar');
    await saveTask(page);
    assert.equal(await tfError(page), 'This text is from the Quran. Please create a task of the kind “Quran” instead.');
    assert.equal(textChecks().at(-1).json.mode, 'dictation');
    assert.ok(await page.isVisible('#tf-to-quran'));
    assert.equal(await text(page, '#tf-to-quran'), 'Create a Quran task with these ayat');
    await page.click('#tf-to-quran');
    assert.ok(await page.isChecked('input[name="tf-kind"][value="quran"]'));
    assert.ok(await page.isVisible('#tf-quran-group'));
    await page.waitForFunction(() => document.querySelector('#tf-surah').value === '112');
    assert.deepEqual([await page.inputValue('#tf-from'), await page.inputValue('#tf-to')], ['1', '4']);
    assert.equal(await text(page, '#tf-status'), '');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tf-surah');
    const n0 = textChecks().length;
    await saveTask(page);
    assert.ok(await page.isHidden('#tf'));
    assert.equal(textChecks().length, n0, 'a Quran task sends no text to the check');
    const task = await storedTask((x) => x.kind === 'quran');
    assert.deepEqual(task.quran, { surah: 112, from: 1, to: 4, memory: false });
    assert.equal(task.title, 'سورة الإخلاص ١–٤');
  });

  await check('Q2 tasks: a page photo of a school text with a misread ayah shows the parts and differences in the form; "Use the mushaf text" fixes the text and keeps the form open', async () => {
    await newTask(page, 'Salma', 'recite');
    fake.setPageRead({ text: FX.LESSON_MISREAD, lang: 'ar', notes: '', source: 'claude', needs_manual: false, contains_quran: false });
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 30;
      return c.toDataURL('image/png').split(',')[1];
    });
    await page.setInputFiles('#tf-choose', { name: 'page.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.waitForFunction((t) => document.querySelector('#tf-text').value === t, FX.LESSON_MISREAD);
    assert.equal(await page.inputValue('#tf-lang'), 'ar');
    await page.waitForSelector('#tf-quran .qp-diff-list');
    assert.equal(await text(page, '#tf-quran-note'), '', 'a school page, not a Quran page');
    assert.ok(await page.isDisabled('input[name="tf-mode"][value="contextual"]'), 'word by word only');
    await page.click('#tf-quran .qp-use');
    assert.equal(await page.inputValue('#tf-text'), FX.LESSON);
    assert.ok(await page.isVisible('#tf'), 'nothing is saved before "Save"');
    assert.equal(await text(page, '#tf-quran .qp-done'), 'The words of the mushaf were put into the text.');
    assert.equal(await page.locator('#tf-quran .qp-diff-list').count(), 0);
    // A page that is Quran: the Quran-task button, next to the note.
    fake.setPageRead({ text: FX.Q1_SAMPLE, lang: 'ar', notes: '', source: 'claude', needs_manual: false, contains_quran: false });
    await page.setInputFiles('#tf-choose', { name: 'page.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.waitForSelector('#tf-quran-note:not(:empty)');
    assert.equal(await text(page, '#tf-quran-note'), 'This page seems to be ayat of the Quran only. Please create a task of the kind “Quran” for them.');
    assert.ok(await page.isVisible('#tf-quran-note + #tf-to-quran'));
    assert.ok(await page.isHidden('#tf-quran'));
    fake.setPageRead(null);
    await page.click('#tf-cancel');
    await H.closeParent(page);
  });

  await check('Q2 task runner: a dictation task starts with the grown-up step for the basmala (no voice), and the result counts as usual', async () => {
    await page.waitForSelector('#screen-home:not([hidden])');
    await page.click('#home-todo .task-card:has-text("Basmala dictation") .task-start');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    // The task's text is checked when it starts: the note for the grown-up shows.
    await page.waitForSelector('#dict-quran-intro:not([hidden])');
    assert.equal(textChecks().at(-1).json.text, BASMALA_LINE_TEXT);
    await page.click('#btn-dict-start');
    await page.waitForSelector('#dict-gu:not([hidden])');
    assert.equal(await text(page, '#dict-gu-ask-text'), 'هيا نطلب من أحد الكبار قراءة هذا الجزء.');
    assert.equal(await text(page, '#dict-counter'), 'الجزء ١ من ٢');
    await page.click('#dict-gu-show');
    assert.equal(await page.textContent('#dict-gu-text'), BASMALA_PLAN.read_text[0]);
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.overflowing(page), []);
    await H.shot(page, 'family-task-grownup-ar-360');
    await page.click('#dict-gu-done');
    await page.click('#dict-next');
    await H.waitForTts(fake, BASMALA_PLAN.phrases[1]);
    assert.equal(fake.ttsFor(BASMALA_PLAN.phrases[0]).length, 0, 'the basmala never reached the voice');
    await page.waitForSelector('#dict-next:not([disabled])');
    await page.click('#dict-next');
    await page.waitForSelector('[data-stage="check"]:not([hidden])');
    const res = H.quranStrictResult(BASMALA_LINE_TEXT, [], 'أحسنت! كل الكلمات صحيحة.', false, 'dictation');
    const written = res.read_text;
    fake.queueDictation(res);
    await page.fill('#dict-written', written);
    await page.click('#btn-dict-check');
    await page.waitForSelector('[data-stage="review"]:not([hidden])');
    await page.click('#btn-dict-confirm');
    await page.waitForSelector('#task-outcome-dictation .celebrate');
    const task = await storedTask((x) => x.title === 'Basmala dictation');
    assert.deepEqual([task.status, task.attempts.length, task.attempts[0].passed], ['ready', 1, true]);
    await page.click('#task-leave');
    await page.waitForSelector('#screen-home:not([hidden])');
  });

  await check('Q2 task runner: a recite task quoting an ayah is word by word (locked), with the note, and its Quran feedback is shown but never spoken', async () => {
    await page.click('#home-todo .task-card:has-text("Patience by meaning") .task-start');
    await page.waitForSelector('#screen-recite:not([hidden])');
    for (const v of ['strict', 'contextual']) assert.ok(await page.isDisabled(`input[name="mode"][value="${v}"]`));
    assert.match(await text(page, '#recite-mode-label'), /كلمة بكلمة/);
    await page.waitForSelector('#recite-quran-note:not([hidden])');
    const part = LESSON.parts[0];
    const quoting = `في الآية الكريمة كلمة تحتاج إلى انتباه: «${part.clean_display[6]}». هيا نقرؤها مرة أخرى.`;
    fake.queueRecite(H.quranStrictResult(FX.LESSON, [part.exp_start + 6], quoting, true));
    const tts0 = fake.callsTo('/api/tts').length;
    await H.record(page, '#recite-rec', 500);
    await page.waitForSelector('#task-outcome-recite:not([hidden])');
    assert.equal(await text(page, '#recite-feedback'), quoting);
    assert.ok(await page.isHidden('#recite-listen'));
    assert.ok(await page.isVisible('#recite-fb-quran'));
    await sleep(400);
    assert.equal(fake.callsTo('/api/tts').length, tts0, 'the Quran feedback is never sent to the voice');
    const task = await storedTask((x) => x.title === 'Patience by meaning');
    assert.equal(task.attempts.length, 1);
    await page.click('#task-leave');
    await page.waitForSelector('#screen-home:not([hidden])');
  });

  await check('Q2 tasks in Arabic at 360 px: the task form with its Quran parts and a difference, RTL, no overflow', async () => {
    await H.openParent(page);
    await H.parentSection(page, 'settings');
    await page.selectOption('#ps-lang', 'ar');
    await newTask(page, 'Salma', 'recite');
    await page.fill('#tf-text', FX.LESSON_MISREAD);
    await page.selectOption('#tf-lang', 'ar');
    await saveTask(page);
    assert.equal(await tfError(page), 'بعض كلمات القرآن الكريم في هذا النص ليست كما في المصحف، كما هو مبيَّن تحت النص. يُرجى استخدام نص المصحف قبل الحفظ.');
    await page.waitForFunction(() => document.querySelector('#tf-quran .qp-refs').textContent.trim().startsWith('سورة البقرة، الآية ١٥٣ «'));
    assert.equal(await text(page, '#tf-quran .qp-use'), 'استخدام نص المصحف');
    assert.equal(await text(page, '#tf-mode-why'), '«المعنى» غير متاح لهذا النص: فيه كلمات من القرآن الكريم، والتطبيق لا يحكم أبدًا على معاني القرآن الكريم، فتُراجَع كلمةً بكلمة.');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.overflowing(page), []);
    assert.deepEqual(await H.smallTargets(page), []);
    await H.shot(page, 'family-task-quran-ar-360');
    await page.click('#tf-cancel');
  });

  await check('Q2 tasks flow: no console errors (besides the refusals asked for), page errors or external requests', async () => {
    assert.deepEqual(problems.filter((p) => !/Failed to load resource: the server responded with a status of (400|422)/.test(p)), []);
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// The main family flow (English parent; an English and an Arabic child)
// ---------------------------------------------------------------------------

async function familyFlow(browser, base) {
  const { context, page, fake, problems } = await H.newPage(browser, base, VIEW);
  const textChecks = () => fake.callsTo('/api/text/check');

  await check('first run: the family setup has the AI disclosure, the consent box, a PIN typed twice and the first child', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('#setup-form:not([hidden])');
    assert.ok(await page.isVisible('#ai-disclosure'));
    assert.ok(await page.isVisible('#ai-badge'));
    assert.ok(await page.isHidden('#nav'));
    assert.ok(await page.isHidden('#btn-home'));
    assert.match(await text(page, '#setup-form'), /child lock/);
    assert.doesNotMatch(await text(page, '#setup-form'), /secur/i, 'the PIN is a child lock, never "secure"');
    assert.equal(await page.locator('#setup-avatars input[type="radio"]').count(), 16);
    // The PIN: 4 to 6 digits, typed twice the same.
    await page.fill('#setup-pin', '12');
    await page.click('#btn-start');
    // UX-08: the error stands under the field that needs it, which is focused and points to it.
    assert.equal(await text(page, '#setup-pin-err'), 'A PIN has 4 to 6 digits.');
    assert.equal(await text(page, '#setup-status'), '');
    assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute('aria-invalid'), document.activeElement.getAttribute('aria-describedby')]), ['setup-pin', 'true', 'setup-pin-err']);
    const gap = await page.evaluate(() => document.querySelector('#setup-pin-err').getBoundingClientRect().top - document.querySelector('#setup-pin').getBoundingClientRect().bottom);
    assert.ok(gap >= 0 && gap < 40, 'right under the field: ' + gap);
    await page.fill('#setup-pin', PIN);
    await page.fill('#setup-pin2', '1357');
    await page.click('#btn-start');
    assert.equal(await text(page, '#setup-pin2-err'), 'The two PINs are not the same. Please type them again.');
    assert.equal(await text(page, '#setup-pin-err'), '', 'the old error goes');
    assert.equal(await page.getAttribute('#setup-pin', 'aria-invalid'), null);
    assert.equal(await page.inputValue('#setup-pin2'), '');
    await page.fill('#setup-pin2', PIN);
    await page.click('#btn-start');
    assert.equal(await text(page, '#nickname-err'), 'Please type a nickname.');
    assert.equal(await page.evaluate(() => localStorage.getItem('mommy.data.v2')), null, 'nothing saved before the setup is complete');
    await page.check('#consent');
    await page.fill('#nickname', 'Salma');
    await page.selectOption('#age', '10-13');
    await page.check('#setup-avatars input >> nth=2');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await text(page, '#home-title'), 'Hi Salma!');
    assert.equal(await text(page, '#home-avatar'), '🦊');
    assert.equal(await text(page, '#home-jar'), 'Stars in the jar: 0');
    assert.ok(await page.isVisible('#nav'));
    assert.ok(await page.isVisible('#home-todo-empty'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'home-title', 'focus on the new screen\'s heading');
    const raw = await page.evaluate(() => localStorage.getItem('mommy.data.v2'));
    assert.ok(!raw.includes(PIN), 'the PIN is not stored as typed');
    const doc = JSON.parse(raw);
    assert.equal(doc.version, 2);
    assert.equal(doc.parent.pin.iterations, 150000);
    assert.ok(doc.parent.consentAt && doc.parent.aiConsentAt);
    assert.equal(doc.parent.uiLang, 'en');
    assert.deepEqual([doc.children.length, doc.children[0].nickname, doc.children[0].age, doc.children[0].lang, doc.children[0].avatar], [1, 'Salma', '10-13', 'en', '🦊']);
    assert.deepEqual(R.validateDoc(doc).repaired, []);
    await H.shot(page, 'family-home-360');
    await H.noHorizontalScroll(page);
  });

  await check('later runs: "Who is learning?" with big targets, the AI disclosure and a small "For parents" button', async () => {
    await page.reload();
    await page.waitForSelector('#screen-who:not([hidden])');
    assert.equal(await text(page, '#who-title'), 'Who is learning?');
    assert.ok(await page.isVisible('#screen-who .card-notice'), 'the AI disclosure at the start of the session');
    assert.ok(await page.isVisible('#ai-badge'));
    assert.ok(await page.isHidden('#nav'));
    assert.ok(await page.isVisible('#btn-who-parents'));
    const box = await page.locator('#who-list .who-btn').first().boundingBox();
    assert.ok(box.height >= 96 && box.width >= 120, 'a big target: ' + JSON.stringify(box));
    assert.equal(await text(page, '#who-list .who-btn .who-name'), 'Salma');
    await page.click('#who-list .who-btn');
    await page.waitForSelector('#screen-home:not([hidden])');
    await H.shot(page, 'family-who-360');
  });

  await check('parent area: behind the PIN, with the five sections; To review, Rewards and Settings start with their empty states', async () => {
    await page.click('#btn-home-parents');
    await page.waitForSelector('#pin-dialog[open]');
    assert.match(await text(page, '#pin-intro'), /child lock/);
    await page.click('#pin-cancel');
    await page.waitForSelector('#pin-dialog:not([open])', { state: 'attached' });
    assert.ok(await page.isVisible('#screen-home'), 'cancel stays on the child\'s home');
    // The address alone does not open it.
    await page.evaluate(() => {
      location.hash = 'parent';
    });
    await sleep(200);
    assert.ok(await page.isHidden('#screen-parent'));
    await H.openParent(page);
    assert.equal(await page.getAttribute('#psec-nav [data-psec="tasks"]', 'aria-current'), 'true', 'nothing to review: the parent area opens on Tasks');
    assert.equal(await page.locator('#screen-parent .placeholder').count(), 0, 'no placeholder is left');
    await H.parentSection(page, 'review');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'psec-review-h', 'focus on the section\'s heading');
    assert.match(await text(page, '#pr-empty'), /^Nothing to review right now\. A task shows here when a child reaches its pass level\./);
    assert.ok(await page.isHidden('#pr-notes'), 'the notes come with tasks to review');
    assert.ok(await page.isHidden('#psec-count-review'));
    assert.equal(await page.locator('#pr-list li').count(), 0);
    await H.parentSection(page, 'rewards');
    assert.equal(await text(page, '#screen-parent .psec[data-psec="rewards"] .help-line'), 'Praise and surprises keep children wanting to learn; rewards work best for effort the child can see.');
    assert.equal(await text(page, '#prw-balance'), 'Stars in the jar: 0');
    assert.ok(await page.isVisible('#prw-give-empty'));
    assert.ok(await page.isVisible('#prw-goals-empty'));
    assert.ok(await page.isVisible('#prw-ledger-empty'));
    await H.parentSection(page, 'settings');
    assert.ok(await page.isChecked('#settings-consent'));
    assert.equal(await text(page, '#screen-parent .psec[data-psec="settings"] .hint'), 'The family data (children, tasks, stars, rewards and the PIN) stays in this browser, on this device.');
    assert.equal(await page.inputValue('#ps-lang'), 'en');
    for (const sel of ['#ps-pin-change', '#ps-delete']) assert.ok(await page.isVisible(sel), sel);
    assert.ok(await page.isHidden('#ps-delete-1'));
    await H.shot(page, 'family-parent-360');
  });

  await check('children: add a child (nickname, age, language, avatar), edit one, and a removal asks first and deletes that child\'s data', async () => {
    await H.parentSection(page, 'children');
    assert.equal(await page.locator('#pc-list .pchild').count(), 1);
    // Add Omar (Arabic) and Temp.
    for (const [nick, lang, avatar] of [['Omar', 'ar', 4], ['Temp', 'fr', 7]]) {
      await page.click('#pc-add');
      await page.waitForSelector('#cf:not([hidden])');
      assert.equal(await text(page, '#cf-h'), 'New child');
      await page.click('#cf-save');
      assert.equal(await text(page, '#cf-status'), 'Please type a nickname.');
      await page.fill('#cf-nick', nick);
      await page.selectOption('#cf-age', '6-9');
      await page.selectOption('#cf-lang', lang);
      await page.check(`#cf-avatars input >> nth=${avatar}`);
      await page.click('#cf-save');
      await page.waitForSelector('#cf', { state: 'hidden' });
    }
    assert.equal(await page.locator('#pc-list .pchild').count(), 3);
    assert.match(await text(page, '#pc-list .pchild >> nth=1'), /Omar.*6–9 years · العربية/);
    // Edit Temp.
    await page.click('#pc-list .pchild >> nth=2 >> [data-edit]');
    assert.equal(await text(page, '#cf-h'), 'Edit the profile');
    assert.equal(await page.inputValue('#cf-nick'), 'Temp');
    await page.fill('#cf-nick', 'Temp 2');
    await page.click('#cf-save');
    await page.waitForSelector('#cf', { state: 'hidden' });
    assert.match(await text(page, '#pc-list .pchild >> nth=2'), /Temp 2/);
    // Remove Temp 2: asked first; Cancel keeps it.
    let doc = await H.storedDoc(page);
    const tempId = doc.children[2].id;
    await page.click('#pc-list .pchild >> nth=2 >> [data-remove]');
    await page.waitForSelector('#pc-remove:not([hidden])');
    assert.match(await text(page, '#pc-remove-text'), /^Remove the profile of Temp 2\? All the tasks, stars and rewards of this profile/);
    await page.click('#pc-remove-no');
    assert.equal(await page.locator('#pc-list .pchild').count(), 3);
    await page.click('#pc-list .pchild >> nth=2 >> [data-remove]');
    await page.click('#pc-remove-yes');
    await page.waitForFunction(() => document.querySelectorAll('#pc-list .pchild').length === 2);
    assert.equal(await text(page, '#pc-status'), 'The profile was removed, with all its data.');
    doc = await H.storedDoc(page);
    assert.deepEqual(doc.children.map((c) => c.nickname), ['Salma', 'Omar']);
    assert.equal(doc.jar[tempId], undefined, 'the jar of the removed child is gone');
  });

  await check('tasks: a recite task\'s text is checked by the server first: empty, no words, Quran text, [?], language, offline (the form is kept)', async () => {
    await newTask(page, 'Salma', 'recite');
    assert.equal(await text(page, '#tf-h'), 'New task');
    assert.ok(await page.isVisible('#tf-mode'), 'recite has the mode');
    assert.ok(await page.isHidden('#tf-quran-group'));
    assert.ok(await page.isHidden('#tf-mode-offline-note'), 'with the online AI, no "approximate" note');
    const n0 = textChecks().length;
    await saveTask(page);
    assert.equal(await tfError(page), 'Please type or paste some text first.');
    assert.equal(textChecks().length, n0, 'an empty text is not sent');
    const cases = [
      ['…!!', 'en', 'There are no words to check in this text.'],
      [QURAN_SAMPLE, 'ar', 'This text is from the Quran. Please create a task of the kind “Quran” instead.'],
      ['The [?] sat on the mat.', 'en', 'Some words could not be read and are marked [?]. Please type them in place of [?] first.'],
      [AR_TEXT, 'en', 'This text is not in the language chosen. Please choose the language of the text.'],
    ];
    for (const [t, lang, msg] of cases) {
      await page.fill('#tf-text', t);
      await page.selectOption('#tf-lang', lang);
      await saveTask(page);
      assert.equal(await tfError(page), msg);
      assert.deepEqual(textChecks().at(-1).json, { text: t, lang, mode: 'strict' }, 'checked in the mode of the task');
    }
    // Offline: said so, and the form is kept.
    fake.unreachable('/api/text/check', true);
    await page.fill('#tf-text', PAGE_TEXT);
    await page.selectOption('#tf-lang', 'en');
    await saveTask(page);
    assert.equal(await tfError(page), 'The text could not be checked: the server cannot be reached. The form is kept; please try again when the server is back.');
    assert.ok(await page.isVisible('#tf'));
    assert.equal(await page.inputValue('#tf-text'), PAGE_TEXT);
    fake.unreachable('/api/text/check', false);
    assert.equal((await H.storedDoc(page)).tasks.length, 0, 'nothing saved without a successful check');
  });

  await check('tasks: a recite task is saved with every field (title by default, pass, stars, reward, due date)', async () => {
    await page.check('input[name="tf-pass"][value="1"]');
    await page.selectOption('#tf-stars', '3');
    await page.fill('#tf-reward-text', 'an ice cream');
    await page.check('#tf-emojis input[value="🍦"]');
    await page.fill('#tf-due', '2026-11-20');
    await saveTask(page);
    assert.ok(await page.isHidden('#tf'));
    assert.equal(await text(page, '#pt-status'), 'The task was saved.');
    assert.match(await text(page, '#pt-list .ptask'), /The cat sat on the mat\.Recite · To do · ⭐⭐⭐/);
    const task = (await H.storedDoc(page)).tasks[0];
    assert.deepEqual(
      [task.kind, task.title, task.text, task.lang, task.mode, task.pass.minAccuracy, task.stars, task.reward, task.due, task.status],
      ['recite', 'The cat sat on the mat.', PAGE_TEXT, 'en', 'strict', 1, 3, { text: 'an ice cream', emoji: '🍦' }, '2026-11-20', 'assigned'],
    );
  });

  await check('tasks: by meaning, a text with the basmala is refused with the reason (recited word by word only: "The meaning" off, "Word by word" chosen)', async () => {
    await newTask(page, 'Salma', 'recite');
    await page.check('input[name="tf-mode"][value="contextual"]');
    assert.ok(await page.isHidden('#tf-pass'), 'by meaning, no word level');
    assert.ok(await page.isVisible('#tf-pass-meaning'));
    await page.fill('#tf-text', BASMALA_TEXT);
    await page.selectOption('#tf-lang', 'ar');
    const n0 = textChecks().length;
    await saveTask(page);
    assert.equal(await tfError(page), 'This text has words of the Quran, and the app never judges the meaning of the Quran, so “The meaning” is not available for it. “Word by word” is now chosen: please check the task and save it again.');
    assert.deepEqual(textChecks().slice(n0).map((c) => c.json.mode), ['contextual', 'strict']);
    assert.ok(await page.isChecked('input[name="tf-mode"][value="strict"]'));
    assert.ok(await page.isDisabled('input[name="tf-mode"][value="contextual"]'));
    await page.click('#tf-cancel');
    await page.waitForSelector('#tf', { state: 'hidden' });
  });

  await check('tasks: a dictation task has no mode, and is checked in mode dictation', async () => {
    await newTask(page, 'Salma', 'dictation');
    assert.ok(await page.isHidden('#tf-mode'), 'no mode for dictation');
    await page.fill('#tf-text', FR_TEXT);
    await page.selectOption('#tf-lang', 'fr');
    await page.selectOption('#tf-stars', '2');
    await page.fill('#tf-reward-text', 'a sticker');
    await page.check('#tf-emojis input[value="🎈"]');
    await saveTask(page);
    assert.ok(await page.isHidden('#tf'));
    assert.deepEqual(textChecks().at(-1).json, { text: FR_TEXT, lang: 'fr', mode: 'dictation' });
    const task = (await H.storedDoc(page)).tasks.find((x) => x.kind === 'dictation');
    assert.equal(task.text, FR_TEXT);
    assert.ok(!('mode' in task), 'a dictation task carries no mode');
  });

  await check('task form: a page photo is read into the text, with the review and the Quran hint (no button to the child\'s Quran screen)', async () => {
    await newTask(page, 'Salma', 'recite');
    fake.setPageRead({ text: 'A page read from a photo.', lang: 'en', notes: 'one line was blurry', source: 'claude', needs_manual: false, contains_quran: true });
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 2400;
      c.height = 1200;
      return c.toDataURL('image/png').split(',')[1];
    });
    assert.ok(await page.isEnabled('#tf-choose'));
    await page.setInputFiles('#tf-choose', { name: 'page.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const call = await H.waitForCall(fake, '/api/page/read', 1);
    assert.equal(call.form.image.type, 'image/jpeg');
    assert.deepEqual(H.jpegSize(call.form.image.data), { width: 2000, height: 1000 });
    await page.waitForFunction(() => document.querySelector('#tf-text').value === 'A page read from a photo.');
    assert.match(await text(page, '#tf-photo-status'), /^Done\. Please check the text carefully and correct it if needed\. \(one line was blurry\)$/);
    assert.equal(await text(page, '#tf-quran-note'), 'This page seems to be ayat of the Quran only. Please create a task of the kind “Quran” for them.');
    assert.equal(await page.locator('#tf .status-action').count(), 0);
    fake.setPageRead(null);
    await page.click('#tf-cancel');
  });

  await check('tasks: a Quran task for the second child has a surah, a range and looking/from memory, and never a mode', async () => {
    await newTask(page, 'Omar', 'quran');
    assert.ok(await page.isHidden('#tf-text-group'));
    assert.ok(await page.isHidden('#tf-mode'), 'no mode selector for the Quran');
    assert.ok(await page.isVisible('#tf-quran-group'));
    await page.waitForFunction(() => document.querySelectorAll('#tf-surah option').length === 114);
    assert.equal(await page.inputValue('#tf-surah'), '78', 'the child\'s Quran surah to start with');
    await page.selectOption('#tf-surah', '112');
    assert.equal(await page.inputValue('#tf-to'), '4');
    await page.fill('#tf-to', '60');
    const n0 = textChecks().length;
    await saveTask(page);
    assert.equal(await tfError(page), 'Please choose valid ayat: at most 50, inside the surah.');
    await page.fill('#tf-to', '4');
    await page.check('input[name="tf-qmode"][value="memory"]');
    await saveTask(page);
    assert.ok(await page.isHidden('#tf'));
    assert.equal(textChecks().length, n0, 'the Quran text is never sent to the text check');
    const doc = await H.storedDoc(page);
    const task = doc.tasks.find((x) => x.kind === 'quran');
    assert.equal(task.childId, doc.children[1].id);
    assert.deepEqual(task.quran, { surah: 112, from: 1, to: 4, memory: true });
    assert.ok(!('mode' in task) && !('text' in task) && !('lang' in task));
    assert.equal(task.title, 'سورة الإخلاص ١–٤', 'the default title is in the child\'s language');
  });

  await check('tasks: a by-meaning task is checked in mode contextual; an edit that keeps the text needs no new check; archive', async () => {
    await newTask(page, 'Omar', 'recite');
    await page.check('input[name="tf-mode"][value="contextual"]');
    await page.fill('#tf-text', AR_TEXT);
    await page.selectOption('#tf-lang', 'ar');
    await page.fill('#tf-title', 'A walk to school');
    await saveTask(page);
    assert.ok(await page.isHidden('#tf'));
    assert.deepEqual(textChecks().at(-1).json, { text: AR_TEXT, lang: 'ar', mode: 'contextual' });
    // Edit: the stars only.
    const n0 = textChecks().length;
    await page.click('#pt-list .ptask:has-text("A walk to school") [data-edit-task]');
    assert.equal(await text(page, '#tf-h'), 'Edit the task');
    assert.ok(await page.isDisabled('input[name="tf-kind"][value="quran"]'), 'the kind cannot change');
    assert.equal(await page.inputValue('#tf-text'), AR_TEXT);
    assert.ok(await page.isChecked('input[name="tf-mode"][value="contextual"]'));
    await page.selectOption('#tf-stars', '4');
    await saveTask(page);
    assert.ok(await page.isHidden('#tf'));
    assert.equal(textChecks().length, n0);
    let task = (await H.storedDoc(page)).tasks.find((x) => x.title === 'A walk to school');
    assert.equal(task.stars, 4);
    // Archive it.
    await page.click('#pt-list .ptask:has-text("A walk to school") [data-archive-task]');
    // UX-09: asked in place first (an archive cannot be undone); "Keep it" keeps it.
    assert.equal(await text(page, '#pt-list .ptask:has-text("A walk to school") .inline-confirm p'), 'Archive this task? It leaves the lists, and it cannot be brought back.');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.archiveYes !== undefined), true);
    await page.click('#pt-list .ptask:has-text("A walk to school") [data-archive-no]');
    assert.equal((await H.storedDoc(page)).tasks.find((x) => x.title === 'A walk to school').status, 'assigned');
    await page.click('#pt-list .ptask:has-text("A walk to school") [data-archive-task]');
    await page.click('#pt-list .ptask:has-text("A walk to school") [data-archive-yes]');
    assert.equal(await text(page, '#pt-status'), 'The task was archived.');
    assert.equal(await text(page, '#pt-archived'), 'Archived tasks: 1');
    assert.equal(await page.locator('#pt-list .ptask').count(), 1);
    task = (await H.storedDoc(page)).tasks.find((x) => x.title === 'A walk to school');
    assert.equal(task.status, 'archived');
    await H.closeParent(page);
    await page.waitForSelector('#screen-home:not([hidden])');
  });

  await check('child home: To do cards show the kind, stars, reward, pass level and due date', async () => {
    assert.equal(await page.locator('#home-todo .task-card').count(), 2);
    const card = page.locator('#home-todo .task-card', { hasText: 'The cat sat' });
    const t = await card.textContent();
    assert.match(t, /Recite · ⭐⭐⭐/);
    assert.match(t, /🍦 an ice cream/);
    assert.match(t, /Pass: All words right/);
    assert.match(t, /For November 20/);
    assert.ok(await card.locator('.task-start').isVisible());
    assert.ok(await page.isVisible('#home-wait-empty'));
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.smallTargets(page), [], 'touch targets of at least 44 px');
  });

  await check('recite task: Start opens Recite preloaded with the mode locked; a failed attempt says "Try again whenever you are ready"', async () => {
    await page.click('#home-todo .task-card:has-text("The cat sat") .task-start');
    await page.waitForSelector('#screen-recite:not([hidden])');
    assert.ok(await page.isVisible('#task-banner'));
    assert.equal(await text(page, '#task-banner-title'), 'The cat sat on the mat.');
    assert.equal(await text(page, '#task-banner-pass'), 'Pass: All words right');
    assert.ok(await page.isHidden('#nav'), 'no tabs to other activities during a task');
    assert.ok(await page.isVisible('#ai-badge'));
    assert.equal(await text(page, '#recite-text'), PAGE_TEXT);
    assert.match(await text(page, '#recite-mode-label'), /Word by word/);
    for (const v of ['strict', 'contextual']) assert.ok(await page.isDisabled(`input[name="mode"][value="${v}"]`), 'the mode is locked');
    assert.ok(await page.isChecked('input[name="mode"][value="strict"]'));
    fake.queueRecite(H.strictResult(PAGE_TEXT, [1, 3], 'Almost! Two words were not right.'));
    await H.record(page, '#recite-rec', 500);
    await page.waitForSelector('#task-outcome-recite:not([hidden])');
    assert.equal(await text(page, '#recite-feedback'), 'Almost! Two words were not right.', 'the usual feedback stays');
    assert.equal(await text(page, '#task-outcome-recite'), 'Try again whenever you are ready.');
    assert.equal(await page.locator('#task-outcome-recite .celebrate').count(), 0);
    const raw = await page.evaluate(() => localStorage.getItem('mommy.data.v2'));
    const task = JSON.parse(raw).tasks.find((x) => x.text === PAGE_TEXT);
    assert.equal(task.status, 'assigned');
    assert.deepEqual(Object.keys(task.attempts[0]).sort(), ['accuracy', 'at', 'nErrors', 'nExpected', 'passed', 'verdict']);
    assert.deepEqual([task.attempts[0].accuracy, task.attempts[0].nErrors, task.attempts[0].passed], [4 / 6, 2, false]);
    assert.ok(!raw.includes('misheardword') && !raw.includes('heard'), 'no heard text is stored');
  });

  await check('recite task: a pass shows the celebration (stars and reward) with the usual praise and the improvement line', async () => {
    fake.queueRecite(H.strictResult(PAGE_TEXT, [], 'Wonderful! Every word was right.'));
    await H.record(page, '#recite-rec', 500);
    await page.waitForSelector('#task-outcome-recite .celebrate');
    assert.equal(await text(page, '#recite-feedback'), 'Wonderful! Every word was right.');
    assert.equal(await text(page, '#task-outcome-recite .improve'), '2 more words right than last time!');
    assert.equal(await text(page, '#task-outcome-recite .celebrate'), 'Well done! Your parent will check it, then you get your stars ⭐⭐⭐ and 🍦 an ice cream.');
    assert.equal(await page.getAttribute('#task-outcome-recite', 'aria-live'), 'polite');
    const task = (await H.storedDoc(page)).tasks.find((x) => x.text === PAGE_TEXT);
    assert.equal(task.status, 'ready');
    await H.shot(page, 'family-recite-pass-360');
    await H.noHorizontalScroll(page);
    // Leaving the task: back to the home, the task waits for the parent.
    await page.click('#task-leave');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.ok(await page.isHidden('#task-banner'));
    assert.equal(await page.locator('#home-wait .task-card').count(), 1);
    assert.match(await text(page, '#home-wait'), /The cat sat on the mat\./);
    assert.equal(await page.locator('#home-wait .task-start').count(), 0);
    for (const v of ['strict', 'contextual']) assert.ok(await page.isEnabled(`input[name="mode"][value="${v}"]`), 'free practice: the mode is free again');
  });

  await check('dictation task: preloaded text; after the parent\'s review a pass offers "Confirm the task now" (PIN), and the stars go to the jar', async () => {
    await page.click('#home-todo .task-card:has-text("Le chat") .task-start');
    await page.waitForSelector('#screen-dictation:not([hidden])');
    assert.equal(await text(page, '#task-banner-title'), FR_TEXT);
    const n0 = fake.callsTo('/api/dictation/phrases').length;
    await page.click('#btn-dict-start');
    const ph = await H.waitForCall(fake, '/api/dictation/phrases', n0 + 1);
    assert.deepEqual(ph.json, { text: FR_TEXT, lang: 'fr' });
    await page.waitForSelector('[data-stage="speak"]:not([hidden])');
    await page.waitForSelector('#dict-next:not([disabled])');
    await page.click('#dict-next');
    await page.waitForSelector('#dict-next:not([disabled])');
    await page.click('#dict-next');
    await page.waitForSelector('[data-stage="check"]:not([hidden])');
    await page.fill('#dict-written', FR_TEXT);
    fake.queueDictation(perfectDictation(FR_TEXT));
    await page.click('#btn-dict-check');
    const call = await H.waitForCall(fake, '/api/dictation/check', 1);
    assert.equal(call.form.expected_text.text, FR_TEXT);
    assert.equal(call.form.lang.text, 'fr');
    assert.equal(call.form.age.text, '10-13', 'the age band of the active child');
    await page.waitForSelector('[data-stage="review"]:not([hidden])');
    assert.equal((await H.storedDoc(page)).tasks.find((x) => x.kind === 'dictation').attempts.length, 0, 'nothing counts before the parent confirms the result');
    await page.click('#btn-dict-confirm');
    await page.waitForSelector('#task-outcome-dictation .celebrate');
    assert.match(await text(page, '#task-outcome-dictation .celebrate-title'), /^Well done! .* ⭐⭐ and 🎈 a sticker\.$/);
    await page.click('#btn-confirm-task-now');
    await page.waitForSelector('#pin-dialog[open]');
    assert.equal(await text(page, '#pin-title'), 'Confirm the task');
    await H.enterPin(page);
    await page.waitForSelector('#task-outcome-dictation .confirmed');
    assert.equal(await text(page, '#task-outcome-dictation .confirmed >> nth=0'), 'Task confirmed: the stars ⭐⭐ are in the jar.');
    assert.equal(await text(page, '#task-outcome-dictation .confirmed >> nth=1'), 'Reward unlocked: 🎈 a sticker');
    const doc = await H.storedDoc(page);
    const task = doc.tasks.find((x) => x.kind === 'dictation');
    assert.deepEqual([task.status, task.confirmedBy, task.rewardStatus], ['done', 'app_pass', 'unlocked']);
    assert.equal(doc.jar[task.childId].balance, 2);
    await page.click('#btn-home'); // the home button also leaves the task
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.ok(await page.isHidden('#task-banner'));
    assert.equal(await text(page, '#home-jar'), 'Stars in the jar: 2');
    assert.match(await text(page, '#home-done'), /🏆 Le chat dort sur le tapis\..*Unlocked: ask your parent/s);
    assert.ok(await page.isVisible('#home-todo-empty'));
  });

  await check('switching child: the Arabic child\'s home is in Arabic, RTL, with Arabic-Indic digits', async () => {
    await page.click('#btn-switch-child');
    await page.waitForSelector('#screen-who:not([hidden])');
    assert.equal(await page.locator('#who-list .who-btn').count(), 2);
    await page.click('#who-list .who-btn:has-text("Omar")');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.equal(await text(page, '#home-title'), 'أهلًا يا Omar!');
    assert.equal(await text(page, '#home-jar'), 'النجوم في الجرّة: ٠');
    assert.equal(await page.locator('#home-todo .task-card').count(), 1);
    assert.match(await text(page, '#home-todo .task-pass'), /^شرط النجاح: كل الكلمات صحيحة$/);
    assert.doesNotMatch(await page.evaluate(ownText, '#screen-home'), /[0-9]/);
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.overflowing(page), []);
  });

  await check('Quran task: no mode selector; the surah, the range and "from memory" are fixed; a perfect recitation passes, never spoken', async () => {
    await page.click('#home-todo .task-start');
    await page.waitForSelector('#screen-quran:not([hidden])');
    await page.waitForSelector('#quran-memory:not([hidden])');
    assert.equal(await page.locator('#screen-quran input[name="mode"]').count(), 0, 'no strict/meaning selector on the Quran screen');
    assert.equal(await page.inputValue('#quran-surah'), '112');
    assert.equal(await page.inputValue('#quran-from'), '١');
    assert.equal(await page.inputValue('#quran-to'), '٤');
    for (const sel of ['#quran-surah', '#quran-from', '#quran-to', '#quran-juz', 'input[name="qmode"][value="looking"]', 'input[name="qmode"][value="memory"]']) {
      assert.ok(await page.isDisabled(sel), sel + ' is fixed by the task');
    }
    assert.ok(await page.isChecked('input[name="qmode"][value="memory"]'));
    assert.ok(await page.isHidden('#quran-text'), 'from memory: the text is hidden');
    assert.equal(await text(page, '#task-banner-pass'), 'شرط النجاح: كل الكلمات صحيحة');
    const tts0 = fake.callsTo('/api/tts').length;
    fake.queueQuran('perfect');
    await H.record(page, '#quran-rec', 500);
    const qc = await H.waitForCall(fake, '/api/quran/check', 1);
    assert.deepEqual([qc.form.surah.text, qc.form.from.text, qc.form.to.text], ['112', '1', '4']);
    await page.waitForSelector('#task-outcome-quran .celebrate');
    assert.equal(await text(page, '#task-outcome-quran .celebrate'), 'أحسنت! سيراجع أحد الوالدين المهمة، ثم تُضاف النجوم ⭐⭐ إلى الجرّة.');
    await sleep(300);
    assert.equal(fake.callsTo('/api/tts').length, tts0, 'nothing on the Quran screen is spoken');
    // "Where am I?" does not jump away from the task's range.
    await H.record(page, '#btn-quran-where', 500);
    await page.waitForSelector('#quran-where-list:not([hidden]) .candidate');
    assert.equal(await page.locator('#quran-where-list button').count(), 0);
    const doc = await H.storedDoc(page);
    const task = doc.tasks.find((x) => x.kind === 'quran');
    assert.deepEqual([task.status, task.attempts[0].accuracy, task.attempts[0].nErrors, task.attempts[0].passed], ['ready', 1, 0, true]);
    assert.equal(doc.children[1].quran.surah, 78, 'the task does not change the child\'s own Quran range');
    await H.shot(page, 'family-quran-task-ar-360');
    await H.noHorizontalScroll(page);
    await page.click('#task-leave');
    await page.waitForSelector('#screen-home:not([hidden])');
    await page.click('#nav [data-go="quran"]');
    await page.waitForSelector('#quran-text .ayah[data-ayah="10"]');
    assert.equal(await page.inputValue('#quran-surah'), '78', 'free practice: the child\'s own range');
    assert.ok(await page.isEnabled('#quran-surah'));
    assert.ok(await page.isEnabled('input[name="qmode"][value="memory"]'));
  });

  await check('to review: the queue across children, oldest first: the child, the task, best and last result, tries, when it became ready, and the two notes', async () => {
    await H.openParent(page);
    assert.equal(await page.getAttribute('#psec-nav [data-psec="review"]', 'aria-current'), 'true', 'the parent area opens on what waits');
    assert.equal(await text(page, '#psec-count-review'), '2');
    const items = page.locator('#pr-list .review-item');
    assert.equal(await items.count(), 2);
    const first = await items.nth(0).textContent();
    for (const re of [/Salma/, /The cat sat on the mat\./, /Recite · Pass: All words right/, /Best: 100%/, /Last: 100%/, /Tries: 2/, /Ready since: \S/]) assert.match(first, re);
    assert.equal(await items.nth(0).locator('.improve').textContent(), '2 more words right in the last try than before.');
    const second = await items.nth(1).textContent();
    for (const re of [/Omar/, /سورة الإخلاص ١–٤/, /Quran · Pass: All words right/, /Best: 100%/, /Tries: 1/]) assert.match(second, re);
    assert.equal(await items.nth(1).locator('.improve').count(), 0, 'no improvement line when nothing compares');
    assert.ok(await page.isVisible('#pr-notes'));
    assert.match(await text(page, '#pr-notes'), /^The app can mishear\. If you heard your child do it, you can confirm anyway/);
    assert.match(await text(page, '#pr-notes'), /The app keeps no recordings, .* To hear it, ask your child to show you\.$/);
    assert.ok(await page.isHidden('#pr-empty'));
    await H.shot(page, 'family-review-360');
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.overflowing(page), []);
    assert.deepEqual(await H.smallTargets(page), [], 'touch targets of at least 44 px');
  });

  await check('to review: Confirm puts the task\'s stars in the jar and unlocks its reward', async () => {
    const salma = (await H.storedDoc(page)).children[0].id;
    await page.click('#pr-list .review-item:has-text("Salma") [data-confirm]');
    await page.waitForFunction(() => document.querySelectorAll('#pr-list .review-item').length === 1);
    assert.equal(await text(page, '#pr-status'), 'Confirmed: ⭐⭐⭐ for Salma. The reward 🍦 an ice cream is unlocked. Once it is given, please mark it under “Rewards”.');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'psec-review-h');
    assert.equal(await text(page, '#psec-count-review'), '1');
    assert.equal(await text(page, '#psec-count-rewards'), '2', 'the sticker and the ice cream wait to be given');
    const doc = await H.storedDoc(page);
    const task = doc.tasks.find((x) => x.text === PAGE_TEXT);
    assert.deepEqual([task.status, task.confirmedBy, task.rewardStatus], ['done', 'app_pass', 'unlocked']);
    assert.deepEqual([doc.jar[salma].balance, doc.jar[salma].earned], [5, 5]);
    assert.deepEqual(doc.jar[salma].ledger.at(-1), { at: task.doneAt, delta: 3, reason: 'task', ref: task.id, note: null });
  });

  await check('to review: "Not yet: try again" takes an optional note for the child and sends the task back; then the empty state', async () => {
    await page.click('#pr-list .review-item:has-text("Omar") [data-not-yet]');
    await page.waitForSelector('#pr-list .send-back input');
    assert.equal(await page.getAttribute('#pr-list [data-not-yet]', 'aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'INPUT', 'focus in the note');
    assert.match(await text(page, '#pr-list .send-back'), /^A note for the child \(optional\)It is shown on the task card\./);
    assert.equal(await page.getAttribute('#pr-list .send-back input', 'maxlength'), '120');
    await page.fill('#pr-list .send-back input', NOTE_AR);
    await page.click('#pr-list [data-send-back]');
    await page.waitForSelector('#pr-empty:not([hidden])');
    assert.equal(await text(page, '#pr-status'), 'Sent back to Omar: the task is in “To do” again.');
    assert.ok(await page.isHidden('#pr-notes'));
    assert.ok(await page.isHidden('#psec-count-review'));
    const task = (await H.storedDoc(page)).tasks.find((x) => x.kind === 'quran');
    assert.deepEqual([task.status, task.readyAt, task.sentBackNote, task.attempts.length], ['assigned', null, NOTE_AR, 1], 'the attempt stays: nothing is taken away');
    assert.ok(task.sentBackAt);
  });

  await check('rewards: the unlocked task rewards wait with "Given", oldest first; the history of the stars, newest first', async () => {
    await H.parentSection(page, 'rewards');
    const value = await page.$eval('#prw-child', (s) => [...s.options].find((o) => o.textContent.includes('Salma')).value);
    await page.selectOption('#prw-child', value);
    assert.equal(await text(page, '#prw-balance'), 'Stars in the jar: 5');
    assert.equal(await text(page, '#prw-earned'), 'Earned in all: 5');
    const items = page.locator('#prw-give-list .reward-item');
    assert.equal(await items.count(), 2);
    assert.match(await items.nth(0).textContent(), /🎈a sticker.*For the task: Le chat dort sur le tapis\./s);
    assert.match(await items.nth(1).textContent(), /🍦an ice cream.*For the task: The cat sat on the mat\./s);
    const ledger = page.locator('#prw-ledger li');
    assert.equal(await ledger.count(), 2);
    assert.match(await ledger.nth(0).textContent(), /^\+3 ⭐Task: The cat sat on the mat\./);
    assert.match(await ledger.nth(1).textContent(), /^\+2 ⭐Task: Le chat dort sur le tapis\./);
    await page.click('#prw-give-list .reward-item:has-text("an ice cream") [data-given]');
    await page.waitForFunction(() => document.querySelectorAll('#prw-give-list .reward-item').length === 1);
    assert.equal(await text(page, '#prw-status'), 'Marked as given: 🍦 an ice cream.');
    assert.equal(await text(page, '#psec-count-rewards'), '1');
    const task = (await H.storedDoc(page)).tasks.find((x) => x.text === PAGE_TEXT);
    assert.equal(task.rewardStatus, 'given');
    assert.ok(task.rewardGivenAt);
    await H.closeParent(page);
  });

  await check('child home: the task sent back is in To do with the note, kindly; the Done shelf says "Received" or "Unlocked: ask your parent"', async () => {
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await text(page, '#home-title'), 'أهلًا يا Omar!');
    const card = page.locator('#home-todo .task-card', { hasText: 'سورة الإخلاص' });
    assert.equal(await card.locator('.task-note').textContent(), '💬 ملاحظة: ' + NOTE_AR);
    assert.ok(await card.locator('.task-start').isVisible());
    assert.equal(await page.locator('#home-wait .task-card').count(), 0);
    assert.equal(await text(page, '#home-jar'), 'النجوم في الجرّة: ٠');
    await H.shot(page, 'family-home-sent-back-ar-360');
    await page.click('#btn-switch-child');
    await page.click('#who-list .who-btn:has-text("Salma")');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await text(page, '#home-jar'), 'Stars in the jar: 5');
    const done = page.locator('#home-done .task-card');
    assert.equal(await done.count(), 2);
    assert.match(await done.nth(0).textContent(), /🏆 The cat sat on the mat\..*🍦 an ice cream.*Received/s, 'newest first');
    assert.match(await done.nth(1).textContent(), /🏆 Le chat dort sur le tapis\..*Unlocked: ask your parent/s);
    await H.shot(page, 'family-home-done-360');
  });

  await check('another tab: a change there reloads the document here and draws the screen again', async () => {
    if (await page.isVisible('#btn-home')) await page.click('#btn-home');
    await page.click('#btn-switch-child');
    await page.waitForSelector('#screen-who:not([hidden])');
    const other = await context.newPage();
    H.watchPage(other, base, problems);
    await other.route('**/api/**', fake.handler);
    await other.goto(base + '/');
    await other.waitForSelector('#screen-who:not([hidden])');
    await other.click('#who-list .who-btn:has-text("Salma")');
    await other.waitForSelector('#screen-home:not([hidden])');
    await H.openParent(other);
    await H.parentSection(other, 'children');
    await other.click('#pc-add');
    await other.fill('#cf-nick', 'Nour');
    await other.click('#cf-save');
    await other.waitForSelector('#cf', { state: 'hidden' });
    await page.waitForSelector('#who-list .who-btn:has-text("Nour")');
    assert.equal(await page.locator('#who-list .who-btn').count(), 3);
    assert.ok(await page.isVisible('#screen-who'), 'the other tab\'s choice of child does not move this one');
    await other.close();
  });

  await check('storage: a full storage is shown to the parent, never silent', async () => {
    await page.evaluate(() => {
      window.__setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function () {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      };
    });
    await page.click('#who-list .who-btn:has-text("Salma")');
    await page.waitForSelector('#data-notice:not([hidden])');
    assert.equal(await text(page, '#data-notice-text'), 'The storage of this browser is full, so the last change could not be saved. Please free some space (for example old site data), then try again.');
    await page.evaluate(() => {
      Storage.prototype.setItem = window.__setItem;
    });
    await page.click('#data-notice-close');
    assert.ok(await page.isHidden('#data-notice'));
  });

  await check('family flow: no console errors (besides the 4xx answers asked for), page errors or external requests', async () => {
    assert.deepEqual(H.expected4xx(problems).filter((p) => !/net::ERR_CONNECTION_REFUSED/.test(p)), []);
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// The PIN: backoff with the remaining time, "Forgot PIN" behind a parental gate
// ---------------------------------------------------------------------------

const NUMBER_WORDS = { three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TENS_WORDS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60 };

/** The gate's question ("How much is forty-seven times eight?"), answered. */
async function gateAnswer(page) {
  const q = await text(page, '#pin-1-label');
  const m = /^How much is (\w+)-(\w+) times (\w+)\? Please type the answer in digits\.$/.exec(q);
  assert.ok(m && TENS_WORDS[m[1]] && NUMBER_WORDS[m[2]] && NUMBER_WORDS[m[3]], 'a question in words: ' + q);
  return (TENS_WORDS[m[1]] + NUMBER_WORDS[m[2]]) * NUMBER_WORDS[m[3]];
}

async function pinFlow(browser, base) {
  const { context, page, problems } = await H.newPage(browser, base, VIEW);
  await page.clock.install();

  await check('PIN: after 5 wrong tries a pause, with the remaining time; it survives a reload; then the right PIN opens', async () => {
    await page.goto(base + '/');
    await H.setupFamily(page, { nickname: 'Lina' });
    await page.click('#btn-home-parents');
    await page.waitForSelector('#pin-dialog[open]');
    for (let i = 1; i <= 5; i++) {
      await page.fill('#pin-1', '1111');
      await page.click('#pin-ok');
      await page.waitForFunction((n) => JSON.parse(localStorage.getItem('mommy.data.v2')).parent.failedAttempts === n && /PIN|tries/.test(document.querySelector('#pin-status').textContent), i);
      if (i === 4) assert.equal(await text(page, '#pin-status'), 'Wrong PIN. Tries left before a pause: 1.');
    }
    assert.equal(await text(page, '#pin-status'), 'Too many tries. Please wait 0:30 before trying again.');
    assert.ok(await page.isDisabled('#pin-1'));
    assert.ok(await page.isDisabled('#pin-ok'));
    // UX-01, RL-4: "Forgot the PIN?" waits for the pause too.
    assert.ok(await page.isHidden('#pin-forgot'), 'no way around the pause while locked');
    await page.clock.fastForward(10000);
    assert.equal(await text(page, '#pin-status'), 'Too many tries. Please wait 0:20 before trying again.');
    // The lock is in the document: a reload does not lift it.
    await page.reload();
    await page.waitForSelector('#screen-who:not([hidden])');
    await page.click('#btn-who-parents');
    await page.waitForSelector('#pin-dialog[open]');
    assert.match(await text(page, '#pin-status'), /^Too many tries\. Please wait 0:(19|20) before trying again\.$/);
    assert.ok(await page.isDisabled('#pin-1'));
    assert.doesNotMatch(await text(page, '#pin-dialog'), /secur/i);
    await page.clock.fastForward(21000);
    await page.waitForSelector('#pin-1:not([disabled])');
    assert.equal(await text(page, '#pin-status'), '');
    assert.ok(await page.isVisible('#pin-forgot'));
    await H.enterPin(page);
    await page.waitForSelector('#screen-parent:not([hidden])');
    const doc = await H.storedDoc(page);
    assert.deepEqual([doc.parent.failedAttempts, doc.parent.lockedUntil], [0, null]);
    await H.closeParent(page);
  });

  await check('PIN: "Forgot PIN" asks a multiplication written in words (answered in digits), then a new PIN; all the data is kept', async () => {
    const before = await H.storedDoc(page);
    await page.click('#btn-who-parents');
    await page.waitForSelector('#pin-dialog[open]');
    await page.click('#pin-forgot');
    assert.equal(await text(page, '#pin-title'), 'Forgot the PIN');
    const answer = await gateAnswer(page);
    assert.ok(answer >= 23 * 3, 'a two-digit number times a one-digit number');
    await page.fill('#pin-1', String(answer + 1));
    await page.click('#pin-ok');
    assert.equal(await text(page, '#pin-status'), 'That is not the answer. Here is another question.');
    assert.equal((await H.storedDoc(page)).parent.failedAttempts, 1, 'a wrong answer counts toward the pause');
    const again = await gateAnswer(page);
    // Typed with Arabic-Indic digits: accepted too.
    await page.fill('#pin-1', String(again).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]));
    await page.click('#pin-ok');
    await page.waitForFunction(() => document.querySelector('#pin-title').textContent === 'Create the parent PIN');
    assert.equal(await text(page, '#pin-intro'), 'All the data is kept. Please choose a new PIN and type it twice; the old PIN works until the new one is saved.');
    // The old PIN stays until the new one is saved: Cancel keeps it (UX-01, RL-4).
    assert.deepEqual((await H.storedDoc(page)).parent.pin, before.parent.pin);
    await page.click('#pin-cancel');
    await page.click('#btn-who-parents');
    await page.waitForSelector('#pin-dialog[open]');
    assert.equal(await text(page, '#pin-title'), 'Parent area', 'still asks for the old PIN, never "create"');
    assert.ok(await page.isHidden('#pin-f2'));
    await page.click('#pin-forgot');
    await page.fill('#pin-1', String(await gateAnswer(page)));
    await page.click('#pin-ok');
    await page.waitForFunction(() => document.querySelector('#pin-title').textContent === 'Create the parent PIN');
    await page.fill('#pin-1', '97531');
    await page.fill('#pin-2', '97531');
    await page.click('#pin-ok');
    await page.waitForSelector('#screen-parent:not([hidden])');
    const after = await H.storedDoc(page);
    assert.deepEqual(after.children, before.children);
    assert.deepEqual(after.tasks, before.tasks);
    assert.notDeepEqual(after.parent.pin, before.parent.pin);
    assert.ok(after.parent.pinResetAt, 'the reset is recorded');
    // The parent area says so until a grown-up hides the notice.
    assert.match(await text(page, '#parent-reset-text'), /^The PIN was reset on .+\. If it was not you, please choose a new PIN in Settings\.$/);
    await page.click('#parent-reset-ok');
    assert.ok(await page.isHidden('#parent-reset-notice'));
    assert.equal((await H.storedDoc(page)).parent.pinResetAt, null);
    await H.closeParent(page);
    await page.click('#btn-who-parents');
    await H.enterPin(page, '97531');
    await page.waitForSelector('#screen-parent:not([hidden])');
    assert.ok(await page.isHidden('#parent-reset-notice'));
    await H.closeParent(page);
  });

  await check('PIN: wrong answers to the gate pause it like wrong PINs, and "Forgot" waits for the pause', async () => {
    await page.click('#btn-who-parents');
    await page.waitForSelector('#pin-dialog[open]');
    await page.click('#pin-forgot');
    for (let i = 1; i <= 5; i++) {
      await page.fill('#pin-1', String((await gateAnswer(page)) + 1));
      await page.click('#pin-ok');
      await page.waitForFunction((n) => JSON.parse(localStorage.getItem('mommy.data.v2')).parent.failedAttempts === n, i);
    }
    assert.equal(await text(page, '#pin-status'), 'Too many tries. Please wait 0:30 before trying again.');
    assert.ok(await page.isDisabled('#pin-1'));
    await page.click('#pin-cancel');
    await page.click('#btn-who-parents');
    await page.waitForSelector('#pin-dialog[open]');
    assert.ok(await page.isHidden('#pin-forgot'));
    await page.clock.fastForward(31000);
    await page.waitForSelector('#pin-1:not([disabled])');
    await H.enterPin(page, '97531');
    await page.waitForSelector('#screen-parent:not([hidden])');
  });

  await check('Parent area: it locks after 3 minutes without use, and when the page is hidden (UX-02)', async () => {
    assert.equal(await text(page, '#parent-autolock'), 'It locks after 3 minutes without use, and when the app is left.');
    await page.clock.fastForward(2 * 60 * 1000);
    await page.click('#psec-nav [data-psec="children"]'); // a tap: the 3 minutes start again
    await page.clock.fastForward(2 * 60 * 1000);
    assert.ok(await page.isVisible('#screen-parent'), 'still open: used a minute ago');
    await page.clock.fastForward(61 * 1000);
    await page.waitForSelector('#screen-who:not([hidden])');
    assert.ok(await page.isHidden('#screen-parent'));
    // A typed address does not open it again.
    await page.evaluate(() => { location.hash = '#parent'; });
    assert.ok(await page.isHidden('#screen-parent'));
    await page.click('#btn-who-parents');
    await H.enterPin(page, '97531');
    await page.waitForSelector('#screen-parent:not([hidden])');
    // The phone goes to sleep or another app comes in front.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    });
    await page.waitForSelector('#screen-who:not([hidden])');
    assert.ok(await page.isHidden('#screen-parent'));
  });

  await check('PIN flow: no console errors, page errors or external requests', async () => {
    assert.deepEqual(problems, []);
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// Review fixes on seeded tasks with Quran in a school text (RL-6, UX-03, UX-04, UX-13,
// UX-15, UX-17)
// ---------------------------------------------------------------------------

async function quranSeededFlow(browser, base) {
  const FX = H.quranFixtures();
  const now = '2026-11-10T10:00:00.000Z';
  let d = R.emptyDoc(now, { uiLang: 'en' });
  d = R.updateParent(d, { consent: true, aiConsent: true }, now);
  d = await R.setPin(d, H.PIN, now);
  let r = R.addChild(d, { nickname: 'Huda', lang: 'ar' }, now);
  d = r.doc;
  const huda = r.child.id;
  // A task by meaning with Quran words: saved before the rule (RL-6).
  r = R.createTask(d, { childId: huda, kind: 'recite', text: FX.LESSON, lang: 'ar', mode: 'contextual', title: 'By meaning' }, now);
  d = r.doc;
  const meaning = r.task.id;
  // A recite task saved with a misquote kept as typed, before UX-03.
  r = R.createTask(d, { childId: huda, kind: 'recite', text: FX.LESSON_MISREAD, lang: 'ar', title: 'Misquote kept' }, now);
  d = r.doc;
  // A dictation with Quran parts, never passed; and one waiting for review.
  r = R.createTask(d, { childId: huda, kind: 'dictation', text: FX.LESSON, lang: 'ar', title: 'Patience dictation' }, now);
  d = r.doc;
  r = R.createTask(d, { childId: huda, kind: 'dictation', text: 'ذهب الولد إلى المدرسة', lang: 'ar', title: 'Ready dictation' }, now);
  d = r.doc;
  d = R.recordAttempt(d, r.task.id, H.strictResult('ذهب الولد إلى المدرسة', []).result, now).doc;
  const { context, page, problems } = await H.newPage(browser, base, VIEW, null, { initScript: seedScript, initArg: { 'mommy.data.v2': JSON.stringify(d) } });

  await check('RL-6: a task by meaning whose text has Quran words cannot be recorded; the child is told a grown-up changes it; Details make it word by word', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('#screen-who:not([hidden])');
    await page.click('#who-list .who-btn');
    await page.waitForSelector('#screen-home:not([hidden])');
    // UX-04: the dictation with Quran parts says so on its card, to the child.
    await page.waitForFunction(() => {
      const n = document.querySelector('#home-todo .task-card:has(.task-quran-line:not([hidden]))');
      return n && n.textContent.includes('Patience dictation');
    });
    assert.equal(await text(page, '#home-todo .task-card:has-text("Patience dictation") .task-quran-line'), 'هيا ننجز هذه المهمة مع أحد الكبار.');
    assert.ok(await page.isHidden('#home-todo .task-card:has-text("Ready dictation") .task-quran-line'), 'only a text with Quran parts');
    await page.click('#home-todo .task-card:has-text("By meaning") .task-start');
    await page.waitForSelector('#screen-recite:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#recite-rec').disabled);
    assert.equal(await text(page, '#why-recite-rec'), 'هيا نطلب من أحد الكبار تعديل هذه المهمة: فيها كلمات من القرآن الكريم تُسمَّع كلمةً بكلمة.');
    await page.click('#task-leave');
    await page.waitForSelector('#screen-home:not([hidden])');
    await H.openParent(page);
    await H.parentSection(page, 'tasks');
    // UX-17: the edit form knows the Quran words of the saved text from the start.
    await page.click('#pt-list .ptask:has-text("By meaning") [data-edit-task]');
    await page.waitForFunction(() => document.querySelector('input[name="tf-mode"][value="contextual"]').disabled);
    assert.ok(await page.isChecked('input[name="tf-mode"][value="strict"]'));
    assert.ok(await page.isVisible('#tf-quran'));
    await page.click('#tf-cancel');
    // Details: the Quran parts of the text, and one tap to make it word by word.
    await page.click('#pt-list .ptask:has-text("By meaning") [data-details]');
    await page.waitForSelector('#pt-list [data-word-by-word]');
    assert.match(await text(page, '#pt-list .ptask-detail .quran-parts .qp-refs'), /^Surah Al-Baqara, ayah 153/);
    assert.match(await text(page, '#pt-list .ptask-detail .hint-parent'), /^This task is by meaning, but its text has words of the Quran/);
    await page.click('#pt-list [data-word-by-word]');
    assert.equal(await text(page, '#pt-status'), 'The task is now recited word by word.');
    assert.equal((await H.storedDoc(page)).tasks.find((x) => x.id === meaning).mode, 'strict');
    assert.equal(await page.locator('#pt-list [data-word-by-word]').count(), 0);
  });

  await check('UX-06: by meaning, with a word not as in the mushaf: one message says both, and the focus goes to the note', async () => {
    await page.click('#pt-new');
    await page.check('input[name="tf-kind"][value="recite"]', { force: true });
    await page.check('input[name="tf-mode"][value="contextual"]', { force: true });
    await page.fill('#tf-text', FX.LESSON_MISREAD);
    await page.selectOption('#tf-lang', 'ar');
    await page.fill('#tf-title', 'Both at once');
    await page.click('#tf-save');
    await page.waitForFunction(() => /mushaf/.test(document.querySelector('#tf-status').textContent));
    assert.equal(await text(page, '#tf-status'), 'This text has words of the Quran, recited word by word only: “Word by word” is now chosen. Some of them are not as in the mushaf (see the note under the text). Please use the mushaf text before saving.');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tf-quran');
    assert.ok(await page.isChecked('input[name="tf-mode"][value="strict"]'));
    await page.click('#tf-quran .qp-use');
    await page.waitForSelector('#tf', { state: 'hidden' });
    const saved = (await H.storedDoc(page)).tasks.find((x) => x.title === 'Both at once');
    assert.deepEqual([saved.text, saved.mode], [FX.LESSON, 'strict']);
  });

  await check('UX-13: a dictation is confirmed on the paper: the details and the review say so', async () => {
    await page.click('#pt-list .ptask:has-text("Patience dictation") [data-details]');
    await page.waitForSelector('#pt-list .ptask-detail [data-confirm-anyway]');
    assert.equal(await text(page, '#pt-list .ptask-detail .hint-parent >> nth=-1'), 'The app has not passed this dictation. If you have checked your child’s paper yourself and it is right, you can confirm it anyway.');
    // The difference kept as typed is not in this text; the parts are listed.
    assert.match(await text(page, '#pt-list .ptask-detail .quran-parts'), /Surah Al-Baqara, ayah 153/);
    await H.parentSection(page, 'review');
    assert.equal(await text(page, '#pr-list .review-item:has-text("Ready dictation") .hint-parent'), 'Please look at the paper before confirming.');
    await H.closeParent(page);
  });

  await check('UX-03: a recite task saved with a misquote shows the child the mushaf words; the check expects them', async () => {
    await page.waitForSelector('#screen-home:not([hidden]), #screen-who:not([hidden])');
    if (await page.isVisible('#screen-who')) await page.click('#who-list .who-btn');
    await page.waitForSelector('#screen-home:not([hidden])');
    await page.click('#home-todo .task-card:has-text("Misquote kept") .task-start');
    await page.waitForSelector('#screen-recite:not([hidden])');
    await page.waitForFunction((t) => document.querySelector('#recite-text').textContent === t, FX.LESSON);
    assert.ok(!(await text(page, '#recite-text')).includes(FX.MISREAD_TYPED), 'the misquote is never shown to the child');
    await page.click('#task-leave');
    await page.waitForSelector('#screen-home:not([hidden])');
  });

  await check('UX-15: the Arabic praise line has the number forms of Arabic (one, two, 3-10, 11+)', () => {
    const ar = H.uiStrings('ar', 'family.js');
    assert.equal(ar.fam_improve_one, 'كلمة صحيحة واحدة أكثر من المرة السابقة!');
    assert.equal(ar.fam_improve_two, 'كلمتان صحيحتان أكثر من المرة السابقة!');
    assert.equal(ar.fam_improve_few, '{n} كلمات صحيحة أكثر من المرة السابقة!');
    assert.equal(ar.fam_improve_many, '{n} كلمة صحيحة أكثر من المرة السابقة!');
    assert.equal([ar.fam_review_best, ar.fam_review_last].join(' / '), 'أفضل نتيجة: {pct} / آخر نتيجة: {pct}');
  });

  await check('seeded Quran tasks flow: no console errors (besides the refusals asked for), page errors or external requests', async () => {
    assert.deepEqual(problems.filter((p) => !/Failed to load resource: the server responded with a status of 422/.test(p)), []);
  });
  await context.close();
}


// ---------------------------------------------------------------------------
// Two tabs during a slow PIN check (RL-3): nothing another tab saved is lost
// ---------------------------------------------------------------------------

function slowHash() {
  const orig = crypto.subtle.deriveBits.bind(crypto.subtle);
  crypto.subtle.deriveBits = async (...args) => {
    const bits = await orig(...args);
    await new Promise((r) => setTimeout(r, 1200)); // a slow phone
    return bits;
  };
}

async function pinTabsFlow(browser, base) {
  await check('PIN: a child added in another tab while this tab checks the PIN is kept, after a wrong and a right PIN (RL-3)', async () => {
    for (const typed of ['1111', H.PIN]) {
      const now = new Date().toISOString();
      let d = R.emptyDoc(now, { uiLang: 'en' });
      d = R.updateParent(d, { consent: true, aiConsent: true }, now);
      d = await R.setPin(d, H.PIN, now);
      d = R.addChild(d, { nickname: 'Sami' }, now).doc;
      const context = await browser.newContext({ viewport: VIEW });
      await context.addInitScript(seedScript, { 'mommy.data.v2': JSON.stringify(d) });
      const fake = H.makeFakeApi();
      const a = await context.newPage();
      await a.addInitScript(slowHash);
      const b = await context.newPage();
      for (const pg of [a, b]) {
        await pg.route('**/api/**', fake.handler);
        await pg.goto(base + '/');
        await pg.waitForSelector('#screen-who:not([hidden])');
      }
      await a.click('#btn-who-parents');
      await a.waitForSelector('#pin-dialog[open]');
      await a.fill('#pin-1', typed);
      await a.click('#pin-ok');
      await a.waitForFunction(() => /Checking/.test(document.querySelector('#pin-status').textContent));
      // Tab B adds a child through its own UI while tab A is hashing.
      await b.click('#btn-who-parents');
      await H.enterPin(b);
      await b.waitForSelector('#screen-parent:not([hidden])');
      await H.parentSection(b, 'children');
      await b.click('#pc-add');
      await b.fill('#cf-nick', 'Added in tab B');
      await b.click('#cf-save');
      await b.waitForFunction(() => JSON.parse(localStorage.getItem('mommy.data.v2')).children.length === 2);
      if (typed === H.PIN) await a.waitForSelector('#screen-parent:not([hidden])', { timeout: 10000 });
      else await a.waitForFunction(() => /Wrong PIN/.test(document.querySelector('#pin-status').textContent), null, { timeout: 10000 });
      const stored = await H.storedDoc(a);
      assert.deepEqual(stored.children.map((c) => c.nickname), ['Sami', 'Added in tab B'], typed);
      assert.equal(stored.parent.failedAttempts, typed === H.PIN ? 0 : 1);
      await context.close();
    }
  });
}

// ---------------------------------------------------------------------------
// Stored data: v1 migration, a corrupt document, a repaired document
// ---------------------------------------------------------------------------

async function storageFlows(browser, base) {
  const v1 = JSON.stringify({ nickname: 'Lina', age: '10-13', lang: 'fr', quran: { surah: 100, from: 2, to: 6, juzAmma: true } });
  const mig = await H.newPage(browser, base, VIEW, null, { initScript: seedScript, initArg: { 'mommy.profile.v1': v1 } });
  await check('v1 migration: the old profile becomes the first child; the v1 key goes once v2 is saved; a PIN is created when the parent area first opens', async () => {
    const page = mig.page;
    await page.goto(base + '/');
    await page.waitForSelector('#screen-who:not([hidden])');
    assert.equal(await text(page, '#who-title'), 'Qui apprend aujourd’hui\u00a0?');
    assert.equal(await text(page, '#who-list .who-name'), 'Lina');
    assert.equal(await page.evaluate(() => localStorage.getItem('mommy.profile.v1')), null);
    const doc = await H.storedDoc(page);
    assert.deepEqual([doc.children[0].nickname, doc.children[0].age, doc.children[0].lang], ['Lina', '10-13', 'fr']);
    assert.deepEqual(doc.children[0].quran, { surah: 100, from: 2, to: 6, juzAmma: true });
    assert.deepEqual([doc.parent.pin, doc.parent.consentAt], [null, null]);
    await page.click('#who-list .who-btn');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await text(page, '#home-title'), 'Coucou Lina\u00a0!');
    await page.click('#nav [data-go="quran"]');
    await page.waitForSelector('#quran-text .ayah');
    assert.equal(await page.inputValue('#quran-surah'), '100', 'the old Quran range is kept');
    assert.match(await text(page, '#screen-quran [data-why="quran-rec"]'), /espace parents \(Réglages\)/);
    await page.click('#btn-home');
    await page.click('#btn-home-parents');
    await page.waitForSelector('#pin-dialog[open]');
    assert.equal(await text(page, '#pin-title'), 'Créer le code parent');
    assert.ok(await page.isHidden('#pin-forgot'));
    // UX-01: whoever creates the first PIN of a migrated family answers the gate first.
    assert.equal(await text(page, '#pin-intro'), 'Avant le premier code parent, répondez à cette question pour les adultes.');
    assert.ok(await page.isHidden('#pin-f2'));
    const q = /^Combien font (\w+)-(\w+) fois (\w+)\s\? Tapez la réponse en chiffres\.$/.exec(await text(page, '#pin-1-label'));
    const FR = { vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9 };
    assert.ok(q && FR[q[1]] >= 20 && FR[q[2]] < 10 && FR[q[3]] < 10, 'a question in French words');
    await page.fill('#pin-1', String((FR[q[1]] + FR[q[2]]) * FR[q[3]]));
    await page.click('#pin-ok');
    await page.waitForSelector('#pin-f2:not([hidden])');
    assert.equal((await H.storedDoc(page)).parent.pinResetAt, null, 'a first PIN is not a reset');
    await page.fill('#pin-1', PIN);
    await page.fill('#pin-2', '1111');
    await page.click('#pin-ok');
    assert.equal(await text(page, '#pin-status'), 'Les deux codes ne sont pas pareils. Tapez-les de nouveau.');
    await page.fill('#pin-2', PIN);
    await page.click('#pin-ok');
    await page.waitForSelector('#screen-parent:not([hidden])');
    // Without consent the parent area opens on Settings, where the box is.
    assert.ok(await page.isVisible('#settings-consent'));
    await page.check('#settings-consent');
    const after = await H.storedDoc(page);
    assert.ok(after.parent.pin && after.parent.consentAt);
    await H.closeParent(page);
    await page.click('#nav [data-go="quran"]');
    await page.waitForSelector('#quran-rec:not([disabled])');
    assert.deepEqual(mig.problems, []);
  });
  await mig.context.close();

  const corrupt = await H.newPage(browser, base, VIEW, null, { initScript: seedScript, initArg: { 'mommy.data.v2': '{"version": 2, "children": [' } });
  await check('storage: a document that cannot be read is kept aside under mommy.data.v2.corrupt.<time>, with a notice, and a fresh start', async () => {
    const page = corrupt.page;
    await page.goto(base + '/');
    await page.waitForSelector('#setup-form:not([hidden])');
    await page.waitForSelector('#data-notice:not([hidden])');
    assert.equal(await text(page, '#data-notice-text'), 'The family data saved on this device could not be read. It was kept aside on this device, and a fresh start was made.');
    const keys = await page.evaluate(() => Object.keys(localStorage));
    const kept = keys.filter((k) => k.startsWith('mommy.data.v2.corrupt.'));
    assert.equal(kept.length, 1);
    assert.match(kept[0], /^mommy\.data\.v2\.corrupt\.\d{4}-\d\d-\d\dT/);
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), kept[0]), '{"version": 2, "children": [');
    assert.ok(!keys.includes('mommy.data.v2'));
    await H.setupFamily(page, { nickname: 'Sami' });
    assert.ok(await page.evaluate(() => localStorage.getItem('mommy.data.v2') !== null));
    assert.deepEqual(corrupt.problems, []);
  });
  await corrupt.context.close();

  const damaged = await arabicDoc();
  damaged.unknownField = 1;
  damaged.children[0].nickname = '  سلمى  ';
  const rep = await H.newPage(browser, base, VIEW, null, { initScript: seedScript, initArg: { 'mommy.data.v2': JSON.stringify(damaged) } });
  await check('storage: a document that needed repairs is used repaired, the old one is kept aside, and the parent is told', async () => {
    const page = rep.page;
    await page.goto(base + '/');
    await page.waitForSelector('#screen-who:not([hidden])');
    await page.waitForSelector('#data-notice:not([hidden])');
    assert.equal(await text(page, '#data-notice-text'), 'كان جزء من بيانات العائلة على هذا الجهاز تالفًا وتمّ إصلاحه. حُفظت نسخة من البيانات القديمة على هذا الجهاز.');
    const keys = await page.evaluate(() => Object.keys(localStorage));
    assert.equal(keys.filter((k) => k.startsWith('mommy.data.v2.corrupt.')).length, 1);
    const doc = await H.storedDoc(page);
    assert.equal(doc.unknownField, undefined);
    assert.equal(doc.children[0].nickname, 'سلمى');
    assert.deepEqual(rep.problems, []);
  });
  await rep.context.close();
}

// ---------------------------------------------------------------------------
// The Arabic UI at 360 px (setup through the UI; a seeded family with goals)
// ---------------------------------------------------------------------------

async function arabicFlow(browser, base) {
  const ui = await H.newPage(browser, base, VIEW);
  await check('ar: the setup in Arabic is RTL and uses the Arabic wording; no overflow at 360 px', async () => {
    const page = ui.page;
    await page.goto(base + '/');
    await page.waitForSelector('#setup-form:not([hidden])');
    await page.selectOption('#setup-lang', 'ar');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.equal(await page.inputValue('#child-lang'), 'ar', 'the child\'s language follows until it is chosen');
    assert.equal(await text(page, '#screen-start .lead'), 'يُعِدّ أحد الكبار التطبيق مرة واحدة للعائلة كلها.');
    assert.match(await text(page, '#setup-form'), /هذا الرمز قفل للأطفال/);
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.overflowing(page), []);
    await H.shot(page, 'family-setup-ar-360');
    await page.fill('#setup-pin', '٢٤٦٨'); // Arabic-Indic digits are accepted
    await page.fill('#setup-pin2', PIN);
    await page.fill('#nickname', 'سلمى');
    await page.check('#consent');
    await page.click('#btn-start');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await text(page, '#home-jar'), 'النجوم في الجرّة: ٠');
    await H.openParent(page, '٢٤٦٨');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.equal(await text(page, '#parent-title'), 'قسم الكبار');
    await H.parentSection(page, 'tasks');
    await page.click('#pt-new');
    await page.waitForSelector('#tf:not([hidden])');
    await page.fill('#tf-text', AR_TEXT);
    await page.selectOption('#tf-lang', 'en');
    await saveTask(page);
    assert.equal(await tfError(page), 'هذا النص ليس باللغة المختارة. يُرجى اختيار لغة النص.');
    assert.match(await page.$eval('#tf-stars', (s) => s.options[2].textContent), /^٣ /);
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.overflowing(page), []);
    assert.deepEqual(await H.smallTargets(page), [], 'touch targets of at least 44 px');
    await H.shot(page, 'family-task-form-ar-360');
    assert.deepEqual(H.expected4xx(ui.problems), []);
  });
  await ui.context.close();

  const doc = await arabicDoc();
  const seeded = await H.newPage(browser, base, VIEW, null, { initScript: seedScript, initArg: { 'mommy.data.v2': JSON.stringify(doc) } });
  await check('ar: the child\'s home at 360 px: jar, progress to the next goal, a surprise shown once, due date and counts in Arabic-Indic digits', async () => {
    const page = seeded.page;
    await page.goto(base + '/');
    await page.waitForSelector('#screen-who:not([hidden])');
    assert.equal(await text(page, '#who-title'), 'مَن معنا اليوم؟');
    await page.click('#who-list .who-btn');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
    assert.equal(await text(page, '#home-jar'), 'النجوم في الجرّة: ٥');
    assert.equal(await text(page, '#home-goal'), 'النجوم الباقية حتى 🍦 بوظة: ٥');
    assert.ok(await page.isVisible('#home-goal-bar'));
    assert.equal(await page.$eval('#home-goal-fill', (n) => n.style.getPropertyValue('--progress')), '0.5');
    assert.equal(await text(page, '#home-surprises .celebrate-title'), '🎉 مفاجأة جميلة!');
    assert.match(await text(page, '#home-surprises'), /نزهة في الحديقة/);
    const card = await text(page, '#home-todo .task-card');
    assert.match(card, /الموعد: ٥ ديسمبر/);
    assert.match(card, /📚 قصة/);
    assert.match(await text(page, '#home-done'), /مفتوحة: هيا نطلبها من أحد الوالدين/);
    assert.doesNotMatch(await page.evaluate(ownText, '#screen-home'), /[0-9]/, 'no Western digit in the Arabic UI');
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.overflowing(page), []);
    assert.deepEqual(await H.smallTargets(page), [], 'touch targets of at least 44 px');
    await H.shot(page, 'family-home-ar-360');
    // The surprise is shown once.
    await page.click('#home-surprises button');
    await page.waitForFunction(() => !document.querySelector('#home-surprises').children.length);
    const after = await H.storedDoc(page);
    assert.ok(after.surprises[0].seenAt);
    await page.reload();
    await page.waitForSelector('#screen-who:not([hidden])');
    await page.click('#who-list .who-btn');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await page.locator('#home-surprises .celebrate').count(), 0);
  });

  await check('ar: the PIN dialog and the parent area are in Arabic, RTL, without overflow at 360 px', async () => {
    const page = seeded.page;
    await page.click('#btn-home-parents');
    await page.waitForSelector('#pin-dialog[open]');
    assert.equal(await page.getAttribute('#pin-dialog', 'dir'), 'rtl');
    assert.equal(await text(page, '#pin-title'), 'قسم الكبار');
    assert.equal(await text(page, '#pin-forgot'), 'نسيان الرمز؟');
    assert.deepEqual(await H.overflowing(page), []);
    assert.deepEqual(await H.smallTargets(page), [], 'touch targets of at least 44 px');
    await page.fill('#pin-1', '0000');
    await page.click('#pin-ok');
    await page.waitForFunction(() => document.querySelector('#pin-status').textContent.includes('٤'));
    assert.equal(await text(page, '#pin-status'), 'الرمز غير صحيح. المحاولات الباقية قبل التوقف: ٤.');
    await H.shotEl(page, '#pin-dialog', 'family-pin-ar-360');
    await H.enterPin(page);
    await page.waitForSelector('#screen-parent:not([hidden])');
    await H.parentSection(page, 'tasks');
    assert.match(await text(page, '#pt-list'), /مطلوبة/);
    assert.equal(await text(page, '#pt-list .ptask.status-done .ptask-meta'), 'إملاء · منجزة · ⭐⭐النجوم: ٢ · 🧸 لعبة');
    await H.parentSection(page, 'children');
    assert.match(await text(page, '#pc-list'), /٦–٩ سنوات · العربية/);
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.overflowing(page), []);
    assert.deepEqual(seeded.problems, []);
  });
  await seeded.context.close();

  const dark = await H.newPage(browser, base, VIEW, null, { colorScheme: 'dark', initScript: seedScript, initArg: { 'mommy.data.v2': JSON.stringify(doc) } });
  await check('dark mode: the family screens follow prefers-color-scheme', async () => {
    const page = dark.page;
    await page.goto(base + '/');
    await page.waitForSelector('#screen-who:not([hidden])');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(18, 20, 23)');
    await page.click('#who-list .who-btn');
    await page.waitForSelector('#screen-home:not([hidden])');
    const bg = await page.$eval('#home-done .task-card', (n) => getComputedStyle(n).backgroundColor);
    assert.equal(bg, 'rgb(45, 38, 16)');
    await H.shot(page, 'family-home-dark-360');
    assert.deepEqual(dark.problems, []);
  });
  await dark.context.close();
}

// ---------------------------------------------------------------------------
// The parent area, second half: task details ("Confirm anyway"), Rewards (goals,
// surprises, corrections, history), Settings (PIN, language, delete all data), two tabs
// ---------------------------------------------------------------------------

/**
 * An English family built with rewards.js: Maya (a task never passed, a dictation done
 * with its pizza unlocked, two goals, stars from corrections) and Adam (a recite task
 * waiting for the parent, an empty jar).
 */
async function rewardsDoc() {
  const now = '2026-11-10T10:00:00.000Z';
  let d = R.emptyDoc(now, { uiLang: 'en' });
  d = R.updateParent(d, { consent: true, aiConsent: true }, now);
  d = await R.setPin(d, PIN, now);
  let r = R.addChild(d, { nickname: 'Maya', age: '6-9', lang: 'en', avatar: '🐰' }, now);
  d = r.doc;
  const maya = r.child.id;
  r = R.addChild(d, { nickname: 'Adam', age: '10-13', lang: 'fr', avatar: '🐻' }, now);
  d = r.doc;
  const adam = r.child.id;
  r = R.createTask(d, { childId: maya, kind: 'dictation', text: 'Le chat dort.', lang: 'fr', stars: 3, reward: { text: 'a pizza', emoji: '🍕' } }, now);
  d = R.confirmTask(r.doc, r.task.id, 'parent_override', '2026-11-10T10:05:00.000Z');
  d = R.adjustStars(d, maya, 4, '2026-11-10T10:06:00.000Z', 'stars from the old chart');
  for (let i = 0; i < 6; i++) d = R.adjustStars(d, maya, 1, `2026-11-10T10:1${i}:00.000Z`, 'a page read aloud');
  r = R.createTask(d, { childId: maya, kind: 'recite', text: SUN_TEXT, lang: 'en', stars: 2 }, now);
  d = R.recordAttempt(r.doc, r.task.id, H.strictResult(SUN_TEXT, [1, 3]), '2026-11-10T11:00:00.000Z').doc;
  d = R.addGoal(d, maya, { cost: 5, reward: { text: 'a new book', emoji: '📚' } }, now).doc;
  d = R.addGoal(d, maya, { cost: 20, reward: { text: 'a bike ride', emoji: '🚲' } }, now).doc;
  r = R.createTask(d, { childId: adam, kind: 'recite', text: 'Bonjour mes amis.', lang: 'fr', stars: 1 }, now);
  d = R.recordAttempt(r.doc, r.task.id, H.strictResult('Bonjour mes amis.', []), '2026-11-10T12:00:00.000Z').doc;
  assert.deepEqual(R.validateDoc(d).repaired, []);
  return d;
}

async function pickParentChild(page, select, name) {
  const value = await page.$eval(select, (s, n) => [...s.options].find((o) => o.textContent.includes(n)).value, name);
  await page.selectOption(select, value);
}

async function rewardsFlow(browser, base) {
  const seed = {
    'mommy.data.v2': JSON.stringify(await rewardsDoc()),
    'mommy.profile.v1': JSON.stringify({ nickname: 'Old', age: '6-9', lang: 'en' }),
    'mommy.data.v2.corrupt.2026-11-01T00:00:00.000Z': '{"version": 2',
    'other.site.key': 'kept',
  };
  const { context, page, problems } = await H.newPage(browser, base, VIEW, null, { initScript: seedScript, initArg: seed });
  const doc = () => H.storedDoc(page);
  const maya = () => doc().then((d) => d.children.find((c) => c.nickname === 'Maya').id);
  let other = null; // a second tab of the same browser (the storage event)

  await check('task details: the figures, the text, and "Confirm anyway" for a task the app never passed', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('#screen-who:not([hidden])');
    await H.openParent(page);
    assert.equal(await page.getAttribute('#psec-nav [data-psec="review"]', 'aria-current'), 'true');
    await H.parentSection(page, 'tasks');
    await pickParentChild(page, '#pt-child', 'Maya');
    const item = page.locator('#pt-list .ptask', { hasText: SUN_TEXT });
    assert.equal(await item.locator('[data-details]').getAttribute('aria-expanded'), 'false');
    assert.equal(await item.locator('[data-confirm-anyway]').count(), 0, 'in the details only');
    await item.locator('[data-details]').click();
    await page.waitForSelector('#pt-list .ptask-detail');
    assert.equal(await item.locator('[data-details]').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.details !== undefined), true, 'focus stays on Details');
    const detail = item.locator('.ptask-detail');
    const tx = await detail.textContent();
    for (const re of [/Created: November 10/, /Reciting mode: Word by word/, /Best: 60%/, /Last: 60%/, /Tries: 1/]) assert.match(tx, re);
    assert.equal(await detail.locator('.detail-text').textContent(), SUN_TEXT);
    assert.equal(await detail.locator('.detail-text').getAttribute('lang'), 'en');
    assert.doesNotMatch(tx, /Passed:/, 'never passed');
    assert.equal(await detail.locator('.hint-parent').textContent(), 'The app has not passed this task. If you heard your child do it, you can confirm it anyway.');
    await H.shot(page, 'family-task-detail-360');
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.smallTargets(page), []);
    await detail.locator('[data-confirm-anyway]').click();
    await page.waitForFunction(() => /Confirmed:/.test(document.querySelector('#pt-status').textContent));
    assert.equal(await text(page, '#pt-status'), 'Confirmed: ⭐⭐ for Maya.');
    const d = await doc();
    const task = d.tasks.find((x) => x.text === SUN_TEXT);
    assert.deepEqual([task.status, task.confirmedBy, task.rewardStatus], ['done', 'parent_override', 'none']);
    assert.equal(d.jar[await maya()].balance, 15);
    assert.match(await text(page, '#pt-list .ptask-detail'), /Confirmed anyway by a grown-up\./);
    assert.equal(await page.locator('#pt-list [data-confirm-anyway]').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.details), task.id);
    // A done task with an unlocked reward: "Given" in its details too.
    await page.click('#pt-list .ptask:has-text("Le chat dort.") [data-details]');
    assert.match(await text(page, '#pt-list .ptask-detail'), /The reward is unlocked and waits to be given\./);
    assert.equal(await page.locator('#pt-list .ptask-detail [data-given]').count(), 1);
    assert.equal(await page.locator('#pt-list .ptask-detail').count(), 1, 'one task\'s details at a time');
  });

  await check('rewards: goals: add one (picture, text, stars), "Give" only when the jar covers it, remove', async () => {
    await H.parentSection(page, 'rewards');
    assert.equal(await page.inputValue('#prw-child'), await maya(), 'the same child as in Tasks');
    assert.equal(await text(page, '#prw-balance'), 'Stars in the jar: 15');
    assert.equal(await text(page, '#prw-earned'), 'Earned in all: 15');
    const goals = page.locator('#prw-goals .goal-item');
    assert.equal(await goals.count(), 2);
    assert.match(await goals.nth(0).textContent(), /📚a new book.*Stars needed: 5.*Enough stars!/s);
    assert.equal(await goals.nth(0).locator('[data-give-goal]').count(), 1);
    assert.match(await goals.nth(1).textContent(), /🚲a bike ride.*Stars needed: 20.*Still needed: 5/s);
    assert.equal(await goals.nth(1).locator('[data-give-goal]').count(), 0, 'no "Give" before the jar covers it');
    // Add a goal.
    await page.click('#prw-goal-add');
    await page.waitForSelector('#gf:not([hidden])');
    assert.ok(await page.isHidden('#prw-goal-add'));
    assert.equal(await page.locator('#gf-emojis input[type="radio"]').count(), 20);
    await page.fill('#gf-cost', '8');
    await page.click('#gf-save');
    assert.equal(await text(page, '#gf-status'), 'Please type the reward.');
    await page.fill('#gf-text', 'a trip to the zoo');
    await page.fill('#gf-cost', '600');
    await page.click('#gf-save');
    assert.equal(await text(page, '#gf-status'), 'Please type a number of stars from 1 to 500.');
    await page.fill('#gf-cost', '٨'); // Arabic-Indic digits are accepted
    await page.check('#gf-emojis input[value="🎡"]');
    await H.shot(page, 'family-goal-form-360');
    await page.click('#gf-save');
    await page.waitForSelector('#gf', { state: 'hidden' });
    assert.equal(await text(page, '#prw-status'), 'The goal was added.');
    let jar = (await doc()).jar[await maya()];
    assert.deepEqual(jar.goals.at(-1).reward, { text: 'a trip to the zoo', emoji: '🎡' });
    assert.equal(jar.goals.at(-1).cost, 8);
    assert.deepEqual(await goals.evaluateAll((ns) => ns.map((n) => n.querySelector('.goal-name').textContent)), ['a new book', 'a trip to the zoo', 'a bike ride'], 'cheapest first');
    // Give the book: the cost leaves the jar; the lifetime total stays.
    await page.click('#prw-goals .goal-item:has-text("a new book") [data-give-goal]');
    await page.waitForFunction(() => /Given:/.test(document.querySelector('#prw-status').textContent));
    assert.equal(await text(page, '#prw-status'), 'Given: 📚 a new book. Stars in the jar: 10.');
    jar = (await doc()).jar[await maya()];
    assert.deepEqual([jar.balance, jar.earned], [10, 15]);
    assert.deepEqual([jar.ledger.at(-1).delta, jar.ledger.at(-1).reason], [-5, 'goal']);
    assert.equal(jar.goals.find((g) => g.reward.text === 'a new book').status, 'given');
    assert.match(await text(page, '#prw-goals .goal-item.is-given'), /a new book.*Stars needed: 5 · Given: \S/s);
    assert.match(await text(page, '#prw-ledger li >> nth=0'), /^−5 ⭐Goal given: 📚 a new book/);
    // Remove the bike ride.
    await page.click('#prw-goals .goal-item:has-text("a bike ride") [data-remove-goal]');
    // UX-09: asked in place first; "Keep it" keeps it.
    assert.equal(await text(page, '#prw-goals .goal-item:has-text("a bike ride") .inline-confirm p'), 'Remove this goal? The stars in the jar stay as they are.');
    await page.click('#prw-goals .goal-item:has-text("a bike ride") [data-remove-goal-no]');
    assert.ok(await page.isVisible('#prw-goals .goal-item:has-text("a bike ride") [data-remove-goal]'));
    await page.click('#prw-goals .goal-item:has-text("a bike ride") [data-remove-goal]');
    await page.click('#prw-goals .goal-item:has-text("a bike ride") [data-remove-goal-yes]');
    await page.waitForFunction(() => !document.querySelector('#prw-goals').textContent.includes('a bike ride'));
    assert.equal(await text(page, '#prw-status'), 'The goal was removed.');
    assert.equal((await doc()).jar[await maya()].goals.length, 2);
  });

  await check('rewards: "Give a surprise" (picture and text) for any time; it waits to be seen', async () => {
    await page.click('#prw-surprise-open');
    await page.waitForSelector('#sf:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sf-text');
    await page.click('#sf-save');
    assert.equal(await text(page, '#sf-status'), 'Please type the surprise.');
    await page.fill('#sf-text', 'a picnic in the park');
    await page.check('#sf-emojis input[value="🌳"]');
    await page.click('#sf-save');
    await page.waitForSelector('#sf', { state: 'hidden' });
    assert.equal(await text(page, '#prw-status'), 'The surprise is ready: Maya sees it on the home screen.');
    assert.equal(await text(page, '#prw-unseen'), 'Not seen yet: 🌳 a picnic in the park');
    const s = (await doc()).surprises;
    assert.equal(s.length, 1);
    assert.deepEqual([s[0].reward, s[0].seenAt], [{ text: 'a picnic in the park', emoji: '🌳' }, null]);
  });

  await check('rewards: "Adjust stars" needs a reason and never takes the jar below zero', async () => {
    await page.click('#prw-adjust-open');
    await page.waitForSelector('#af:not([hidden])');
    assert.match(await text(page, '#screen-parent .psec[data-psec="rewards"]'), /stars are never taken away for a try that did not work, and the jar never goes below zero/);
    await page.fill('#af-n', '3');
    await page.click('#af-save');
    assert.equal(await text(page, '#af-status'), 'Please type a reason.');
    await page.fill('#af-note', 'a reading at grandma’s');
    await page.click('#af-save');
    await page.waitForSelector('#af', { state: 'hidden' });
    assert.equal(await text(page, '#prw-status'), 'Saved. Stars in the jar: 13.');
    // The history: the newest ten, then all of them.
    assert.equal(await page.locator('#prw-ledger li').count(), 10);
    assert.match(await text(page, '#prw-ledger li >> nth=0'), /^\+3 ⭐Correction: a reading at grandma’s/);
    assert.equal(await text(page, '#prw-ledger-more'), 'Show all (11)');
    await page.click('#prw-ledger-more');
    assert.equal(await page.locator('#prw-ledger li').count(), 11);
    assert.equal(await text(page, '#prw-ledger-more'), 'Show fewer');
    assert.match(await text(page, '#prw-ledger li >> nth=10'), /^\+3 ⭐Task: Le chat dort\./);
    await H.shot(page, 'family-rewards-360');
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.overflowing(page), []);
    assert.deepEqual(await H.smallTargets(page), []);
    // Adam: an empty jar has nothing to take away; then a correction is limited to the jar.
    await pickParentChild(page, '#prw-child', 'Adam');
    assert.equal(await text(page, '#prw-balance'), 'Stars in the jar: 0');
    const adjust = async (way, n, note) => {
      await page.click('#prw-adjust-open');
      await page.check(`input[name="af-way"][value="${way}"]`);
      await page.fill('#af-n', n);
      await page.fill('#af-note', note);
      await page.click('#af-save');
    };
    await adjust('take', '1', 'counted twice');
    assert.equal(await text(page, '#af-status'), 'There are no stars to take away.');
    await page.click('#af-cancel');
    await adjust('add', '2', 'a story read together');
    await page.waitForSelector('#af', { state: 'hidden' });
    await adjust('take', '5', 'counted twice');
    await page.waitForSelector('#af', { state: 'hidden' });
    assert.equal(await text(page, '#prw-status'), 'Only the stars in the jar were taken away: it is at zero now. Saved. Stars in the jar: 0.');
    const jar = (await doc()).jar[(await doc()).children[1].id];
    assert.deepEqual([jar.balance, jar.ledger.at(-1).delta, jar.ledger.at(-1).note], [0, -2, 'counted twice']);
    assert.match(await text(page, '#prw-ledger li >> nth=0'), /^−2 ⭐Correction: counted twice/);
    assert.equal(await page.locator('#prw-ledger .is-minus').evaluate((n) => getComputedStyle(n).color === getComputedStyle(document.querySelector('#prw-ledger .ledger-what')).color), true, 'a correction down is not shown in red');
    await H.closeParent(page);
  });

  await check('child home: the surprise shows once as a celebration; the jar and the next goal follow the parent area', async () => {
    await page.waitForSelector('#screen-who:not([hidden])');
    await page.click('#who-list .who-btn:has-text("Maya")');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await text(page, '#home-jar'), 'Stars in the jar: 13');
    assert.equal(await text(page, '#home-goal'), 'Enough stars for: 🎡 a trip to the zoo! Tell your parent.');
    const card = page.locator('#home-surprises .surprise');
    assert.equal(await card.count(), 1);
    assert.equal(await card.locator('.celebrate-title').textContent(), '🎉 A surprise for you!');
    assert.match(await card.textContent(), /🌳.*a picnic in the park/s);
    // Corrections down and a goal given leave no trace of loss on the child's side.
    assert.doesNotMatch(await text(page, '#screen-home'), /−|-\s?\d|lost|taken|correction/i);
    await settle(page);
    await H.shot(page, 'family-home-surprise-360');
    assert.match(await text(page, '#home-done'), /🏆 The sun is hot today\..*🏆 Le chat dort\..*Unlocked: ask your parent/s);
    await page.click('#home-surprises button');
    await page.waitForFunction(() => !document.querySelector('#home-surprises').children.length);
    assert.ok((await doc()).surprises[0].seenAt);
    await page.click('#btn-switch-child');
    await page.click('#who-list .who-btn:has-text("Maya")');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await page.locator('#home-surprises .surprise').count(), 0, 'shown once');
  });

  await check('settings: change the PIN (the current one, then the new one twice)', async () => {
    await H.openParent(page);
    await H.parentSection(page, 'settings');
    await page.click('#ps-pin-change');
    await page.waitForSelector('#pin-dialog[open]');
    assert.equal(await text(page, '#pin-title'), 'Change the PIN');
    assert.equal(await text(page, '#pin-intro'), 'Please type the current PIN first.');
    assert.ok(await page.isHidden('#pin-f2'));
    await page.fill('#pin-1', '1111');
    await page.click('#pin-ok');
    await page.waitForFunction(() => /Wrong PIN/.test(document.querySelector('#pin-status').textContent));
    assert.equal(await text(page, '#pin-status'), 'Wrong PIN. Tries left before a pause: 4.');
    await page.fill('#pin-1', PIN);
    await page.click('#pin-ok');
    await page.waitForFunction(() => !document.querySelector('#pin-f2').hidden);
    assert.equal(await text(page, '#pin-intro'), 'Please choose the new PIN (4 to 6 digits) and type it twice.');
    assert.equal(await text(page, '#pin-ok'), 'Save');
    await page.fill('#pin-1', '13579');
    await page.fill('#pin-2', '13570');
    await page.click('#pin-ok');
    assert.equal(await text(page, '#pin-status'), 'The two PINs are not the same. Please type them again.');
    await page.fill('#pin-2', '13579');
    await page.click('#pin-ok');
    await page.waitForSelector('#pin-dialog:not([open])', { state: 'attached' });
    assert.equal(await text(page, '#ps-pin-status'), 'The PIN was changed.');
    const d = await doc();
    assert.equal(d.parent.failedAttempts, 0);
    assert.ok(!JSON.stringify(d).includes('13579'), 'the PIN is not stored as typed');
    assert.ok(await R.verifyPin(d, '13579', new Date().toISOString()).then((r) => r.ok));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ps-pin-change');
    await H.closeParent(page);
    await H.openParent(page, '13579');
  });

  await check('settings: the parent language changes the parent area and the PIN dialog, never a child\'s language', async () => {
    await H.parentSection(page, 'settings');
    await page.selectOption('#ps-lang', 'fr');
    await page.waitForFunction(() => document.documentElement.lang === 'fr');
    assert.equal(await text(page, '#parent-title'), 'Espace parents');
    assert.equal(await text(page, '#ps-lang-status'), 'C’est enregistré.');
    assert.equal(await text(page, '#psec-nav [data-psec="rewards"] [data-i18n]'), 'Récompenses');
    assert.equal((await doc()).parent.uiLang, 'fr');
    assert.deepEqual((await doc()).children.map((c) => c.lang), ['en', 'fr']);
    await H.closeParent(page);
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await text(page, '#home-title'), 'Hi Maya!', 'the child keeps their own language');
    await page.click('#btn-home-parents');
    await page.waitForSelector('#pin-dialog[open]');
    assert.equal(await text(page, '#pin-title'), 'Espace parents');
    await H.enterPin(page, '13579');
    await H.parentSection(page, 'settings');
    await page.selectOption('#ps-lang', 'en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await text(page, '#parent-title'), 'Parent area');
  });

  await check('two tabs: a surprise given in one tab shows at once on the child\'s home in the other', async () => {
    other = await context.newPage();
    H.watchPage(other, base, problems);
    await other.route('**/api/**', H.makeFakeApi().handler);
    await other.goto(base + '/');
    await other.waitForSelector('#screen-who:not([hidden])');
    await other.click('#who-list .who-btn:has-text("Maya")');
    await other.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await other.locator('#home-surprises .surprise').count(), 0);
    await H.parentSection(page, 'rewards');
    await pickParentChild(page, '#prw-child', 'Maya');
    await page.click('#prw-surprise-open');
    await page.fill('#sf-text', 'a song together');
    await page.click('#sf-save');
    await other.waitForSelector('#home-surprises .surprise');
    assert.match(await other.textContent('#home-surprises'), /a song together/);
  });

  await check('settings: "delete all data on this device" asks twice, removes the family data, v1 and the copies kept aside, and starts again', async () => {
    assert.ok(other, 'the second tab is open');
    await H.parentSection(page, 'settings');
    await page.click('#ps-delete');
    await page.waitForSelector('#ps-delete-1:not([hidden])');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ps-delete-1');
    assert.equal(await text(page, '#ps-delete-1 p'), 'Delete all the family data on this device? This cannot be undone.');
    assert.ok(await page.isHidden('#ps-delete'));
    await page.click('#ps-delete-no1');
    assert.ok(await page.isHidden('#ps-delete-1'));
    assert.equal(await page.evaluate(() => document.activeElement.id), 'ps-delete');
    await page.click('#ps-delete');
    await page.click('#ps-delete-next');
    await page.waitForSelector('#ps-delete-2:not([hidden])');
    assert.ok(await page.isHidden('#ps-delete-1'));
    assert.equal(await text(page, '#ps-delete-2 p'), 'Last check: every child, task, star and reward, and the PIN, will be deleted.');
    await H.shot(page, 'family-settings-delete-360');
    await H.noHorizontalScroll(page);
    assert.deepEqual(await H.smallTargets(page), []);
    assert.ok((await doc()) !== null, 'nothing deleted before the second confirmation');
    await page.click('#ps-delete-yes');
    await page.waitForSelector('#setup-form:not([hidden])');
    assert.equal(await text(page, '#data-notice-text'), 'All the family data on this device was deleted.');
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).sort()), ['other.site.key'], 'only another site\'s key is left');
    assert.ok(await page.isVisible('#ai-disclosure'));
    assert.ok(await page.isHidden('#nav'));
    assert.deepEqual(
      await page.evaluate(() => ['#nickname', '#setup-pin', '#setup-pin2'].map((s) => document.querySelector(s).value).concat([document.querySelector('#consent').checked, document.querySelector('#setup-lang').value])),
      ['', '', '', false, 'en'],
      'the setup is empty, in the grown-ups\' language',
    );
    // The other tab goes back to the setup too.
    await other.waitForSelector('#setup-form:not([hidden])');
    assert.equal(await other.textContent('#data-notice-text'), 'All the family data on this device was deleted.');
    await other.close();
    // A new start.
    await page.click('#data-notice-close');
    await H.setupFamily(page, { nickname: 'Nina' });
    const d = await doc();
    assert.deepEqual([d.children.length, d.tasks.length, d.surprises.length], [1, 0, 0]);
    assert.equal(await text(page, '#home-jar'), 'Stars in the jar: 0');
  });

  await check('parent area, second half: no console errors, page errors or external requests', async () => {
    assert.deepEqual(problems, []);
  });
  await context.close();
}

// ---------------------------------------------------------------------------
// The second half in Arabic at 360 px (RTL, Arabic-Indic digits), and dark mode
// ---------------------------------------------------------------------------

/** The Arabic family (arabicDoc) with a second child whose Quran task waits for the parent. */
async function arabicParentDoc() {
  let d = await arabicDoc();
  const now = '2026-11-10T15:00:00.000Z';
  const r = R.addChild(d, { nickname: 'يوسف', age: '10-13', lang: 'ar', avatar: '🦁' }, now);
  d = r.doc;
  const t = R.createTask(d, { childId: r.child.id, kind: 'quran', quran: { surah: 112, from: 1, to: 4, memory: true }, stars: 3 }, now, { surahName: 'سورة الإخلاص ١–٤' });
  d = R.recordAttempt(t.doc, t.task.id, H.fakeQuranCheck(112, 1, 4, false), '2026-11-10T15:10:00.000Z').doc;
  d = R.recordAttempt(d, t.task.id, H.fakeQuranCheck(112, 1, 4, true), '2026-11-10T15:20:00.000Z').doc;
  assert.deepEqual(R.validateDoc(d).repaired, []);
  return d;
}

/** Arabic screens: RTL, no Western digit outside text typed by people, no overflow, big targets. */
async function arabicScreenOk(page) {
  assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
  assert.doesNotMatch(await page.evaluate(ownText, '#screen-parent'), /[0-9]/, 'no Western digit in the Arabic UI');
  await H.noHorizontalScroll(page);
  assert.deepEqual(await H.overflowing(page), []);
  assert.deepEqual(await H.smallTargets(page), [], 'touch targets of at least 44 px');
}

async function arabicParentFlow(browser, base) {
  const seeded = await H.newPage(browser, base, VIEW, null, { initScript: seedScript, initArg: { 'mommy.data.v2': JSON.stringify(await arabicParentDoc()) } });
  const page = seeded.page;

  await check('ar: To review in Arabic at 360 px: the child, the task, the results in Arabic-Indic digits, the notes; send back with a note', async () => {
    await page.goto(base + '/');
    await page.waitForSelector('#screen-who:not([hidden])');
    await H.openParent(page);
    await page.waitForSelector('#pr-list .review-item');
    assert.equal(await text(page, '#psec-count-review'), '١');
    const item = await text(page, '#pr-list .review-item');
    for (const re of [/يوسف/, /سورة الإخلاص ١–٤/, /القرآن الكريم · شرط النجاح: كل الكلمات صحيحة/, /أفضل نتيجة: ١٠٠٪/, /آخر نتيجة: ١٠٠٪/, /المحاولات: ٢/, /جاهزة منذ: /]) assert.match(item, re);
    assert.equal(await text(page, '#pr-list .improve'), 'كلمات صحيحة إضافية في المحاولة الأخيرة: ٢');
    assert.match(await text(page, '#pr-notes'), /^قد يُخطئ التطبيق في السماع\./);
    assert.match(await text(page, '#pr-notes'), /لا يحتفظ التطبيق بأي تسجيل/);
    await arabicScreenOk(page);
    await H.shot(page, 'family-review-ar-360');
    await page.click('#pr-list [data-not-yet]');
    await page.fill('#pr-list .send-back input', NOTE_AR);
    await H.shot(page, 'family-review-send-back-ar-360');
    await arabicScreenOk(page);
    await page.click('#pr-list [data-send-back]');
    await page.waitForSelector('#pr-empty:not([hidden])');
    assert.equal(await text(page, '#pr-status'), 'أُعيدت المهمة إلى يوسف، وهي الآن في «المهام المطلوبة».');
    assert.match(await text(page, '#pr-empty'), /^لا شيء للمراجعة الآن\./);
    await arabicScreenOk(page);
  });

  await check('ar: task details and "Confirm anyway" in Arabic', async () => {
    await H.parentSection(page, 'tasks');
    await pickParentChild(page, '#pt-child', 'سلمى');
    await page.click('#pt-list .ptask.status-assigned [data-details]');
    const detail = await text(page, '#pt-list .ptask-detail');
    assert.match(detail, /أُنشئت: ١٠ نوفمبر/);
    assert.match(detail, /الموعد: ٥ ديسمبر/);
    assert.match(detail, /لا توجد محاولة بعد\./);
    assert.match(detail, /لم يحتسب التطبيق هذه المهمة ناجحة\./);
    await arabicScreenOk(page);
    await H.shot(page, 'family-task-detail-ar-360');
    await page.click('#pt-list [data-confirm-anyway]');
    await page.waitForFunction(() => document.querySelector('#pt-status').textContent.includes('تمّ التأكيد'));
    assert.equal(await text(page, '#pt-status'), 'تمّ التأكيد: ⭐⭐⭐ لـ سلمى. فُتحت المكافأة 📚 قصة. بعد تقديمها، يُرجى تسجيل ذلك في «المكافآت».');
    assert.match(await text(page, '#pt-list .ptask-detail'), /أكّدها أحد الكبار على أي حال\./);
  });

  await check('ar: Rewards in Arabic: jar, rewards to give, goals, a surprise, a correction, the history', async () => {
    await H.parentSection(page, 'rewards');
    assert.equal(await text(page, '#prw-balance'), 'النجوم في الجرّة: ٨');
    assert.equal(await text(page, '#psec-count-rewards'), '٢');
    assert.match(await text(page, '#prw-goals'), /بوظة.*النجوم المطلوبة: ١٠.*النجوم الناقصة: ٢/s);
    assert.equal(await page.locator('#prw-give-list .reward-item').count(), 2);
    await page.click('#prw-give-list .reward-item:has-text("لعبة") [data-given]');
    await page.waitForFunction(() => document.querySelectorAll('#prw-give-list .reward-item').length === 1);
    assert.equal(await text(page, '#prw-status'), 'سُجّل تقديم المكافأة: 🧸 لعبة.');
    assert.match(await text(page, '#prw-ledger li >> nth=0'), /^\+٣ ⭐مهمة: /);
    await arabicScreenOk(page);
    await H.shot(page, 'family-rewards-ar-360');
    await page.click('#prw-goal-add');
    await page.fill('#gf-text', 'دراجة');
    await page.fill('#gf-cost', '٣٠');
    await arabicScreenOk(page);
    await H.shot(page, 'family-goal-form-ar-360');
    await page.click('#gf-save');
    await page.waitForSelector('#gf', { state: 'hidden' });
    assert.equal(await text(page, '#prw-status'), 'تمّت إضافة الهدف.');
    await page.click('#prw-surprise-open');
    await page.fill('#sf-text', 'نزهة على الشاطئ');
    await arabicScreenOk(page);
    await H.shot(page, 'family-surprise-form-ar-360');
    await page.click('#sf-save');
    await page.waitForSelector('#sf', { state: 'hidden' });
    assert.equal(await text(page, '#prw-status'), 'المفاجأة جاهزة، وستظهر لـ سلمى في الصفحة الرئيسية.');
    await page.click('#prw-adjust-open');
    await page.check('input[name="af-way"][value="take"]');
    await page.fill('#af-n', '١');
    await page.fill('#af-note', 'خطأ في العدّ');
    await arabicScreenOk(page);
    await H.shot(page, 'family-adjust-form-ar-360');
    await page.click('#af-save');
    await page.waitForSelector('#af', { state: 'hidden' });
    assert.equal(await text(page, '#prw-status'), 'تمّ الحفظ. النجوم في الجرّة: ٧.');
    assert.match(await text(page, '#prw-ledger li >> nth=0'), /^−١ ⭐تعديل: خطأ في العدّ/);
    await arabicScreenOk(page);
  });

  await check('ar: Settings in Arabic: PIN, language, delete all data (two confirmations)', async () => {
    await H.parentSection(page, 'settings');
    assert.equal(await text(page, '#ps-pin-change'), 'تغيير الرمز');
    assert.equal(await text(page, '#ps-lang-h'), 'لغة قسم الكبار');
    assert.equal(await page.inputValue('#ps-lang'), 'ar');
    await arabicScreenOk(page);
    await H.shot(page, 'family-settings-ar-360');
    await page.click('#ps-delete');
    assert.equal(await text(page, '#ps-delete-1 p'), 'حذف كل بيانات العائلة من هذا الجهاز؟ لا يمكن التراجع عن ذلك.');
    await page.click('#ps-delete-next');
    assert.equal(await text(page, '#ps-delete-yes'), 'حذف كل شيء');
    await arabicScreenOk(page);
    await H.shot(page, 'family-settings-delete-ar-360');
    await page.click('#ps-delete-no2');
    assert.ok(await page.isHidden('#ps-delete-2'));
    await page.click('#ps-pin-change');
    await page.waitForSelector('#pin-dialog[open]');
    assert.equal(await text(page, '#pin-title'), 'تغيير الرمز');
    assert.equal(await text(page, '#pin-ok'), 'متابعة');
    await H.shotEl(page, '#pin-dialog', 'family-pin-change-ar-360');
    await page.click('#pin-cancel');
    await H.closeParent(page);
  });

  await check('ar: the child\'s home shows the surprise once, the note of the task sent back, and the Done shelf', async () => {
    await page.click('#who-list .who-btn:has-text("سلمى")');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await page.locator('#home-surprises .surprise').count(), 2, 'the two unseen surprises, oldest first');
    assert.match(await text(page, '#home-surprises .surprise >> nth=1'), /نزهة على الشاطئ/);
    assert.match(await text(page, '#home-done'), /تمّ استلامها/);
    assert.doesNotMatch(await page.evaluate(ownText, '#screen-home'), /[0-9]/);
    await H.noHorizontalScroll(page);
    await settle(page);
    await H.shot(page, 'family-home-surprise-ar-360');
    await page.click('#btn-switch-child');
    await page.click('#who-list .who-btn:has-text("يوسف")');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await text(page, '#home-todo .task-note'), '💬 ملاحظة: ' + NOTE_AR);
    assert.deepEqual(seeded.problems, []);
  });
  await seeded.context.close();

  const dark = await H.newPage(browser, base, VIEW, null, { colorScheme: 'dark', initScript: seedScript, initArg: { 'mommy.data.v2': JSON.stringify(await rewardsDoc()) } });
  await check('dark mode: To review, task details, Rewards and Settings follow prefers-color-scheme', async () => {
    const p = dark.page;
    await p.goto(base + '/');
    await p.waitForSelector('#screen-who:not([hidden])');
    await H.openParent(p);
    assert.equal(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(18, 20, 23)');
    assert.equal(await p.$eval('#pr-list .review-item', (n) => getComputedStyle(n).backgroundColor), 'rgb(35, 40, 48)');
    await H.shot(p, 'family-review-dark-360');
    await H.parentSection(p, 'tasks');
    await pickParentChild(p, '#pt-child', 'Maya');
    await p.click(`#pt-list .ptask:has-text("${SUN_TEXT}") [data-details]`);
    await H.shot(p, 'family-task-detail-dark-360');
    await H.parentSection(p, 'rewards');
    assert.equal(await p.$eval('.jar-box', (n) => getComputedStyle(n).backgroundColor), 'rgb(45, 38, 16)');
    await H.shot(p, 'family-rewards-dark-360');
    await H.parentSection(p, 'settings');
    await p.click('#ps-delete');
    await H.shot(p, 'family-settings-dark-360');
    assert.deepEqual(dark.problems, []);
  });
  await dark.context.close();
}

/**
 * Without the online AI (brain offline), the meaning check is only approximate: the task
 * form says so under the mode choice, as Prepare does, while "The meaning" can be chosen
 * (final verification, P3).
 */
async function offlineTaskFormFlow(browser, base) {
  const FX = H.quranFixtures();
  const offline = { health: { asr: true, tts: true, brain: 'offline', quran: true, languages: ['ar', 'en', 'fr'] } };
  const { context, page, problems } = await H.newPage(browser, base, VIEW, offline);
  const NOTE = 'Without the online AI, the meaning check is only approximate.';
  await check('offline: the task form says that a recite task by meaning is checked only approximately (not for dictation, Quran, or a text with Quran words)', async () => {
    await page.goto(base + '/');
    await H.setupFamily(page, { nickname: 'Sami' });
    await H.openParent(page);
    await newTask(page, 'Sami', 'recite');
    await page.waitForSelector('#tf-mode-offline-note:not([hidden])');
    assert.equal(await text(page, '#tf-mode-offline-note'), NOTE);
    await page.check('input[name="tf-mode"][value="contextual"]');
    assert.ok(await page.isVisible('#tf-mode-offline-note'));
    for (const kind of ['dictation', 'quran']) {
      await page.check(`input[name="tf-kind"][value="${kind}"]`);
      assert.ok(await page.isHidden('#tf-mode-offline-note'), kind + ' has no meaning check');
    }
    await page.check('input[name="tf-kind"][value="recite"]');
    assert.ok(await page.isVisible('#tf-mode-offline-note'));
    // A text with Quran words is recited word by word only: no note about the meaning.
    await page.fill('#tf-text', FX.LESSON);
    await page.selectOption('#tf-lang', 'ar');
    await saveTask(page);
    assert.ok(await page.isDisabled('input[name="tf-mode"][value="contextual"]'));
    assert.ok(await page.isHidden('#tf-mode-offline-note'));
    await page.fill('#tf-text', AR_TEXT);
    assert.ok(await page.isEnabled('input[name="tf-mode"][value="contextual"]'));
    assert.ok(await page.isVisible('#tf-mode-offline-note'));
    await page.click('#tf-cancel');
    await H.closeParent(page);
  });
  await check('offline: Prepare keeps its note, but not while "The meaning" is ruled out for a text with Quran words', async () => {
    await page.click('#nav [data-go="prepare"]');
    await page.waitForSelector('#screen-prepare:not([hidden])');
    assert.ok(await page.isVisible('#mode-offline-note'));
    await page.selectOption('#page-lang', 'ar');
    await page.fill('#page-text', FX.LESSON);
    await page.click('#btn-confirm');
    await page.waitForSelector('#prep-next:not([hidden])');
    assert.ok(await page.isDisabled('input[name="mode"][value="contextual"]'));
    assert.ok(await page.isHidden('#mode-offline-note'));
    await page.fill('#page-text', AR_TEXT);
    await page.click('#btn-confirm');
    await page.waitForFunction(() => !document.querySelector('input[name="mode"][value="contextual"]').disabled);
    assert.ok(await page.isVisible('#mode-offline-note'));
  });
  await check('offline task form flow: no console errors (besides the refusals asked for), page errors or external requests', async () => {
    assert.deepEqual(problems.filter((p) => !/Failed to load resource: the server responded with a status of (400|422)/.test(p)), []);
  });
  await context.close();
}

/**
 * The parent area's privacy texts in the four ways the app runs (local or online, with
 * or without Claude; the fake /api/health): in Settings the family data line and the
 * consent box, and the task form's photo note, in en, fr and ar (the parent's language).
 * Online, no local-only sentence ("nothing leaves this computer", ...) is on the page.
 */
async function privacySettingsFlow(browser, base) {
  for (const mode of H.PRIVACY_MODES) {
    const { context, page, problems } = await H.newPage(browser, base, VIEW, { health: H.privacyHealth(mode) });
    await check(`privacy, ${mode.name}: Settings (the family data line, the consent box) and the task form's photo note, in en, fr and ar`, async () => {
      await page.goto(base + '/');
      await H.setupFamily(page, { nickname: 'Sami' });
      await H.openParent(page);
      const settings = '#screen-parent .psec[data-psec="settings"]';
      for (const lang of ['en', 'fr', 'ar']) {
        const S = H.allStrings(lang);
        await H.parentSection(page, 'settings');
        if ((await page.inputValue('#ps-lang')) !== lang) {
          await page.selectOption('#ps-lang', lang);
          await page.waitForSelector(`html[lang="${lang}"]`);
        }
        assert.equal(await text(page, `${settings} > .hint`), S.fam_privacy_line, lang);
        assert.equal(await text(page, `${settings} .consent-privacy`), S[mode.privacy], lang);
        assert.ok(await page.isVisible(`${settings} .consent-extra`));
        assert.equal(await text(page, `${settings} .consent-extra`), S[mode.extra], lang);
        if (mode.online) assert.deepEqual(await H.localSentencesShown(page), [], lang + ': a local-only sentence online');
        await H.noHorizontalScroll(page);
        // The photo note of the task form (the photo buttons need Claude).
        await H.parentSection(page, 'tasks');
        await page.click('#pt-new');
        await page.waitForSelector('#tf:not([hidden])');
        assert.equal(await text(page, '#tf .photo-privacy'), S[mode.photo], lang);
        assert.equal(await page.isDisabled('#tf-take'), mode.brain !== 'claude');
        if (mode.online) assert.deepEqual(await H.localSentencesShown(page), [], lang);
        await page.click('#tf-cancel');
        await page.waitForSelector('#tf', { state: 'hidden' });
      }
      // The consent stays what it was: the data line covers the family document only.
      const doc = await H.storedDoc(page);
      assert.ok(doc.parent.consentAt && doc.children.length === 1);
      assert.deepEqual(problems, []);
    });
    await context.close();
  }
}

/** app.js and family.js find each other whatever the order of the script tags. */
async function handshakeFlow(browser, base) {
  const { context, page, problems } = await H.newPage(browser, base, VIEW);
  await check('handshake: with app.js loaded before family.js, the family screens still work', async () => {
    const html = require('node:fs').readFileSync(path.join(H.WEB, 'index.html'), 'utf8');
    const swapped = html.replace(/(<script src="family\.js" defer><\/script>)\s*(<script src="app\.js" defer><\/script>)/, '$2\n  $1');
    assert.notEqual(swapped, html, 'the script tags were swapped');
    await page.route(base + '/', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: swapped }));
    await page.goto(base + '/');
    assert.ok(await page.evaluate(() => [...document.scripts].map((s) => s.getAttribute('src')).join(',').includes('app.js,family.js')));
    await H.setupFamily(page, { nickname: 'Sami' });
    assert.equal(await text(page, '#home-title'), 'Hi Sami!');
    await H.openParent(page);
    await H.closeParent(page);
    assert.deepEqual(problems, []);
  });
  await context.close();
}

async function main() {
  H.loadTanzil();
  const server = await H.startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    console.log('# motivation rules (Node)');
    await check('motivation: the child-facing family strings never shame, count down or take stars away', motivationRules);
    console.log('# browser: family flow (setup, picker, parent area, tasks, task runner)');
    await familyFlow(browser, base);
    console.log('# browser: PIN backoff and "Forgot PIN"');
    await pinFlow(browser, base);
    console.log('# browser: seeded tasks with Quran in a school text (review fixes)');
    await quranSeededFlow(browser, base);
    console.log('# browser: two tabs during a slow PIN check');
    await pinTabsFlow(browser, base);
    console.log('# browser: stored data (v1 migration, corrupt, repaired)');
    await storageFlows(browser, base);
    console.log('# browser: Arabic UI at 360 px, dark mode');
    await arabicFlow(browser, base);
    console.log('# browser: parent area, second half (review details, rewards, settings, two tabs)');
    await rewardsFlow(browser, base);
    console.log('# browser: parent area, second half, in Arabic at 360 px; dark mode');
    await arabicParentFlow(browser, base);
    console.log('# browser: tasks with Quran in a school text (Q1, Q2)');
    await quranTasksFlow(browser, base);
    console.log('# browser: the task form without the online AI');
    await offlineTaskFormFlow(browser, base);
    console.log('# browser: privacy texts in Settings and the task form, local or online, with or without Claude');
    await privacySettingsFlow(browser, base);
    console.log('# browser: script order');
    await handshakeFlow(browser, base);
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

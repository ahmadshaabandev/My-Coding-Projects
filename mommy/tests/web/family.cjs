#!/usr/bin/env node
/*
 * Browser test of the family UI (web/family.js on web/rewards.js and web/app.js),
 * docs/REWARDS.md "Web client", first half. Like smoke.cjs it runs without the Python
 * backend: web/ is served by a tiny Node server and every /api/* request is answered by
 * the contract-shaped fake API of helpers.cjs (/api/text/check included).
 *
 * What is checked:
 *   - first run: the family setup (AI disclosure, consent, a PIN typed twice, the first
 *     child with nickname, age, language and an avatar from the fixed list); the PIN is
 *     stored hashed;
 *   - later runs: "Who is learning?" with big targets, the AI disclosure and "For
 *     parents"; the AI badge on every screen;
 *   - the parent area behind the PIN: sections, placeholders, children (add, edit, remove
 *     with a confirmation), tasks of each kind for two children with the server checks of
 *     the text in the mode of the task (empty, Quran text, language, [?], by meaning, a
 *     basmala line for dictation, offline keeps the form), a page photo read into the text,
 *     edit without a new check, archive;
 *   - the task runner: a recite task (mode locked) that fails then passes (try again,
 *     celebration with stars and reward, the improvement line, only scores stored); a
 *     dictation task with "Confirm the task now" (PIN) after the parent's review; a Quran
 *     task with no mode selector and its range and from-memory fixed;
 *   - the PIN backoff with the remaining time (a controlled clock), kept in the document;
 *     "Forgot PIN" behind a multiplication in words, which keeps all the data;
 *   - v1 migration; a corrupt document kept aside; a repaired one; a full storage shown;
 *     another tab's change reloaded;
 *   - the Arabic UI at 360 px: RTL, Arabic-Indic digits, no overflow, touch targets of
 *     at least 44 px; dark mode; the app.js/family.js handshake in either script order;
 *   - no console errors (besides the 4xx answers the checks ask for) and no request to
 *     any other host than the page's own.
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
const FR_TEXT = 'Le chat dort sur le tapis.';
const VIEW = { width: 360, height: 780 };

/** Seed localStorage once per tab (the first load), before the page's scripts run. */
function seedScript(entries) {
  if (sessionStorage.getItem('__seeded')) return;
  for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
  sessionStorage.setItem('__seeded', '1');
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
    assert.equal(await text(page, '#setup-status'), 'A PIN has 4 to 6 digits.');
    await page.fill('#setup-pin', PIN);
    await page.fill('#setup-pin2', '1357');
    await page.click('#btn-start');
    assert.equal(await text(page, '#setup-status'), 'The two PINs are not the same. Please type them again.');
    assert.equal(await page.inputValue('#setup-pin2'), '');
    await page.fill('#setup-pin2', PIN);
    await page.click('#btn-start');
    assert.equal(await text(page, '#setup-status'), 'Please type a nickname.');
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

  await check('parent area: behind the PIN, with the five sections; the placeholders are real sections without dead buttons', async () => {
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
    assert.equal(await page.getAttribute('#psec-nav [data-psec="tasks"]', 'aria-current'), 'true');
    assert.match(await text(page, '#screen-parent'), /rewards work best for effort the child can see/);
    for (const name of ['review', 'rewards']) {
      await H.parentSection(page, name);
      const sec = `#screen-parent .psec[data-psec="${name}"]`;
      assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H2');
      assert.equal(await text(page, sec + ' .placeholder'), 'This section is being built.');
      assert.equal(await page.locator(sec + ' button').count(), 0);
    }
    await H.parentSection(page, 'settings');
    assert.ok(await page.isChecked('#settings-consent'));
    assert.equal(await text(page, '#screen-parent .psec[data-psec="settings"] .hint'), 'Everything here stays on this device.');
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

  await check('tasks: by meaning, a text with the basmala is refused with the reason (recited word by word only)', async () => {
    await newTask(page, 'Salma', 'recite');
    await page.check('input[name="tf-mode"][value="contextual"]');
    assert.ok(await page.isHidden('#tf-pass'), 'by meaning, no word level');
    assert.ok(await page.isVisible('#tf-pass-meaning'));
    await page.fill('#tf-text', BASMALA_TEXT);
    await page.selectOption('#tf-lang', 'ar');
    const n0 = textChecks().length;
    await saveTask(page);
    assert.equal(await tfError(page), 'This text has words of the Quran (for example the basmala), so it is recited word by word only. Please choose “Word by word”.');
    assert.deepEqual(textChecks().slice(n0).map((c) => c.json.mode), ['contextual', 'strict']);
    await page.click('#tf-cancel');
    await page.waitForSelector('#tf', { state: 'hidden' });
  });

  await check('tasks: a dictation task refuses a text with the basmala on a line of its own (phrase scope), and has no mode', async () => {
    await newTask(page, 'Salma', 'dictation');
    assert.ok(await page.isHidden('#tf-mode'), 'no mode for dictation');
    await page.fill('#tf-text', BASMALA_LINE_TEXT);
    await page.selectOption('#tf-lang', 'ar');
    await saveTask(page);
    assert.equal(await tfError(page), 'Part of this text is an ayah of the Quran (for example the basmala), and the app never reads the Quran aloud, so this text cannot be a dictation task. It can be a recite task, word by word.');
    assert.deepEqual(textChecks().at(-1).json, { text: BASMALA_LINE_TEXT, lang: 'ar', mode: 'dictation' });
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
    assert.equal(await text(page, '#tf-quran-note'), 'This page seems to contain Quran text. For the Quran, please create a task of the kind “Quran”.');
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

  await check('another tab: a change there reloads the document here and draws the screen again', async () => {
    await page.click('#btn-home');
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
    const ask = async () => {
      const q = await text(page, '#pin-1-label');
      const m = /^How much is (\w+) times (\w+)\? Please type the answer in digits\.$/.exec(q);
      assert.ok(m && NUMBER_WORDS[m[1]] && NUMBER_WORDS[m[2]], 'a question in words: ' + q);
      return NUMBER_WORDS[m[1]] * NUMBER_WORDS[m[2]];
    };
    const answer = await ask();
    await page.fill('#pin-1', String(answer + 1));
    await page.click('#pin-ok');
    assert.equal(await text(page, '#pin-status'), 'That is not the answer. Here is another question.');
    const again = await ask();
    // Typed with Arabic-Indic digits: accepted too.
    await page.fill('#pin-1', String(again).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]));
    await page.click('#pin-ok');
    await page.waitForFunction(() => document.querySelector('#pin-title').textContent === 'Create the parent PIN');
    assert.equal(await text(page, '#pin-intro'), 'The PIN was removed and all the data is kept. Please choose a new PIN and type it twice.');
    assert.equal((await H.storedDoc(page)).parent.pin, null);
    await page.fill('#pin-1', '97531');
    await page.fill('#pin-2', '97531');
    await page.click('#pin-ok');
    await page.waitForSelector('#screen-parent:not([hidden])');
    const after = await H.storedDoc(page);
    assert.deepEqual(after.children, before.children);
    assert.deepEqual(after.tasks, before.tasks);
    assert.notDeepEqual(after.parent.pin, before.parent.pin);
    await H.closeParent(page);
    await page.click('#btn-who-parents');
    await H.enterPin(page, '97531');
    await page.waitForSelector('#screen-parent:not([hidden])');
  });

  await check('PIN flow: no console errors, page errors or external requests', async () => {
    assert.deepEqual(problems, []);
  });
  await context.close();
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
    assert.equal(await text(page, '#who-title'), 'Qui apprend aujourd’hui ?');
    assert.equal(await text(page, '#who-list .who-name'), 'Lina');
    assert.equal(await page.evaluate(() => localStorage.getItem('mommy.profile.v1')), null);
    const doc = await H.storedDoc(page);
    assert.deepEqual([doc.children[0].nickname, doc.children[0].age, doc.children[0].lang], ['Lina', '10-13', 'fr']);
    assert.deepEqual(doc.children[0].quran, { surah: 100, from: 2, to: 6, juzAmma: true });
    assert.deepEqual([doc.parent.pin, doc.parent.consentAt], [null, null]);
    await page.click('#who-list .who-btn');
    await page.waitForSelector('#screen-home:not([hidden])');
    assert.equal(await text(page, '#home-title'), 'Coucou Lina !');
    await page.click('#nav [data-go="quran"]');
    await page.waitForSelector('#quran-text .ayah');
    assert.equal(await page.inputValue('#quran-surah'), '100', 'the old Quran range is kept');
    assert.match(await text(page, '#screen-quran [data-why="quran-rec"]'), /espace parents \(Réglages\)/);
    await page.click('#btn-home');
    await page.click('#btn-home-parents');
    await page.waitForSelector('#pin-dialog[open]');
    assert.equal(await text(page, '#pin-title'), 'Créer le code parent');
    assert.ok(await page.isHidden('#pin-forgot'));
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
    assert.equal(await text(page, '#home-surprises .celebrate-title'), 'مفاجأة جميلة!');
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
    console.log('# browser: family flow (setup, picker, parent area, tasks, task runner)');
    await familyFlow(browser, base);
    console.log('# browser: PIN backoff and "Forgot PIN"');
    await pinFlow(browser, base);
    console.log('# browser: stored data (v1 migration, corrupt, repaired)');
    await storageFlows(browser, base);
    console.log('# browser: Arabic UI at 360 px, dark mode');
    await arabicFlow(browser, base);
    console.log('# browser: script order');
    await handshakeFlow(browser, base);
  } finally {
    await browser.close();
    server.close();
  }
  H.finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

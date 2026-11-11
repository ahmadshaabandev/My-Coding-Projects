# Mommy: tasks and rewards (spec)

The parent (most often the mother) gives each child study tasks and attaches rewards. The
child does the task in the app; the app checks it as usual; when the child reaches the
pass level the app marks the task **ready for the parent**; the parent confirms; then the
task's stars go into the child's star jar and the task's reward (if any) unlocks. The
parent marks a reward as given when the child has actually received it.

This spec adds to `docs/CONTRACT.md`. Every hard rule there still applies.

## Decisions (made by the product owner)

1. **One shared device.** The parent and the children use the same phone, tablet or
   computer. All task, reward and child data stays in the browser's `localStorage` on
   that device. No accounts, no server storage. The data model must be easy to sync to
   accounts later (stable ids, timestamps, one versioned document).
2. **Both reward types.** A reward per task (written by the parent) and a star jar per
   child with parent-defined goals. The parent can also give a surprise reward at any time.
3. **The app suggests, the parent confirms.** Passing the level makes a task "ready for
   the parent"; nothing unlocks until the parent confirms behind the parent PIN. The
   parent may also confirm a task the app did not pass (she listened herself), or send it
   back ("try again").
4. **Several children per device**, each with their own nickname, age band, language,
   avatar, tasks, star jar and rewards.

## Product rules

- **Quran tasks are always word by word.** A Quran task has no mode choice: it uses the
  Quran section's strict check (`/api/quran/check`) only. Its options are surah, ayah
  range and looking/from memory. Never offer "the meaning" for Quran anywhere.
- A recite or dictation task's text is validated when the parent creates it, with the
  same server checks as Prepare's "Confirm text" (`quran_text`, `lang_mismatch`,
  `unreadable_text`, `text_too_long`, empty text). Quran text cannot become a recite or
  dictation task; the parent is told to create a Quran task instead.
- **Rewards and motivation** (research basis: Deci, Koestner & Ryan, 1999, *Psychological
  Bulletin* 125(6): promised rewards for doing or finishing a task lower children's later
  free-choice motivation; specific positive feedback raises it; unexpected rewards do not
  lower it):
  - Every result keeps the specific, informational praise the app already gives (what
    was right, how many words, improvement since the last attempt). The reward is never
    the only feedback.
  - Show improvement: "3 more words right than last time" when it is true.
  - Surprise rewards are a first-class action for the parent.
  - The parent-area help text says, in one short line, that praise and surprises keep
    children wanting to learn, and that rewards work best for effort the child can see.
  - Never shame: a task that is not passed gets the normal encouraging feedback and
    "Try again whenever you are ready". No countdowns, no lost stars, no penalties.
- Speech recognition can be wrong, especially in Arabic and for children. The parent
  confirmation step is the safeguard; the UI says so to the parent in the review queue
  ("The app can mishear. If you heard your child do it, you can confirm anyway.").
- The app keeps no recordings, so the parent cannot listen afterwards. The review queue
  says so ("To hear it, ask your child to show you").

## Data model (localStorage, one key)

Key `mommy.data.v2`, one JSON document. Every id is a random string from
`crypto.getRandomValues` (base36, 12+ chars). Times are ISO 8601 strings.

```js
{
  version: 2,
  createdAt, updatedAt,
  parent: {
    pin: null | { salt: base64, hash: base64, iterations: 150000 },  // PBKDF2-SHA-256 via SubtleCrypto
    failedAttempts: 0, lockedUntil: null | iso,
    consentAt: null | iso,          // parent consent (existing consent box), moved here
    aiConsentAt: null | iso,        // existing Claude consent, moved here
    uiLang: 'ar' | 'en' | 'fr',     // the parent area language
  },
  children: [{
    id, nickname (1-24 chars), age: '6-9' | '10-13' | '14-18', lang: 'ar' | 'en' | 'fr',
    avatar: one emoji from a fixed list of 16, createdAt,
    quran: { surah, from, to, juzAmma },   // per-child Quran screen state (was in the old profile)
  }],
  activeChildId: null | id,
  tasks: [{
    id, childId, createdAt, updatedAt,
    kind: 'recite' | 'dictation' | 'quran',
    title: string (1-60 chars; default from the text's first words or the surah name),
    // recite and dictation:
    text?: string, lang?: 'ar' | 'en' | 'fr',
    mode?: 'strict' | 'contextual',          // recite only; absent for dictation and quran
    // quran:
    quran?: { surah, from, to, memory: boolean },
    pass: { minAccuracy: 1 | 0.9 | 0.8 },    // strict recite, dictation, quran
                                             // contextual recite passes on verdict 'same_meaning' with no missing ideas
    stars: 1..5 (default 2),
    reward: null | { text: 1-80 chars, emoji: one emoji from a fixed list },
    due: null | 'YYYY-MM-DD',
    status: 'assigned' | 'ready' | 'done' | 'archived',
    attempts: [{ at, accuracy: 0..1 | null, verdict, nErrors, nExpected, passed: boolean }],  // newest last, keep at most 20
    readyAt: null | iso, doneAt: null | iso, confirmedBy: null | 'app_pass' | 'parent_override',
    sentBackAt: null | iso, sentBackNote: null | string (0-120 chars),
    rewardStatus: 'none' | 'locked' | 'unlocked' | 'given', rewardGivenAt: null | iso,
  }],
  jar: { [childId]: {
    balance: integer >= 0, earned: integer >= 0,   // earned = lifetime total
    goals: [{ id, cost: 1..500, reward: { text, emoji }, status: 'open' | 'given', givenAt: null | iso, createdAt }],
    ledger: [{ at, delta, reason: 'task' | 'goal' | 'adjust', ref: id | null }],  // keep at most 200
  } },
  surprises: [{ id, childId, reward: { text, emoji }, at, seenAt: null | iso }],
}
```

- **No content about the child's performance beyond scores** is stored: no transcripts, no
  heard text, no audio, no images, no OCR of the child's handwriting. Lesson texts (typed
  or read from a book page by the parent) are stored because the task needs them.
- **Migration** from v1: if `mommy.profile.v1` exists and `mommy.data.v2` does not, create
  v2 with one child from the old profile (nickname, age, lang, quran) and carry over the
  consent state if it was stored; keep the v1 key until v2 is saved successfully, then
  remove it. A corrupt or unknown-version document is never overwritten silently: keep it
  under `mommy.data.v2.corrupt.<timestamp>` and start fresh with a visible notice.
- **Writes**: one `save()` that serialises the whole document; catch `QuotaExceededError`
  and show a parent-visible message; private mode must still work for the session (memory
  only) with a notice. Saving happens after every state change.
- **Multi-tab**: listen to the `storage` event and reload the document when another tab
  changed it.

## Pure logic module (`web/rewards.js`)

A plain script (no build step, no modules needed by the page; also loadable in Node for
tests through `module.exports` when present) exposing `window.MommyRewards` with pure
functions over the document (each returns a new document or a result; no DOM, no
storage, `now` passed in):

- `emptyDoc(now)`, `migrateV1(profileV1, now)`, `validateDoc(doc) -> {ok, doc, errors}`
  (clamps and drops invalid fields; never throws on bad input).
- Children: `addChild`, `updateChild`, `removeChild` (removes the child's tasks, jar and
  surprises), `setActiveChild`.
- Tasks: `createTask(doc, input, now)` (validates every field; Quran tasks never carry a
  mode; returns `{doc, task}` or `{error}`), `updateTask`, `archiveTask`,
  `recordAttempt(doc, taskId, result, now)` where `result` is the API response; it
  computes `accuracy`, `passed` and, on the first pass while `assigned`, moves the task to
  `ready`; attempts after `done` or `archived` are ignored for status.
  `passes(task, result)`: strict recite and dictation use `result.word_accuracy` (or
  `1 - n_errors/n_expected`); contextual uses the judgement; Quran uses the Quran check's
  `word_accuracy`/`n_errors`, and `minAccuracy: 1` means `n_errors === 0`.
- Review: `confirmTask(doc, taskId, how, now)` (`how` = 'app_pass' | 'parent_override';
  adds the stars to the jar with a ledger entry, sets `rewardStatus` 'unlocked' if there is
  a reward), `sendBack(doc, taskId, note, now)` (status back to `assigned`),
  `markRewardGiven(doc, taskId, now)`.
- Jar: `addGoal`, `removeGoal`, `giveGoal(doc, childId, goalId, now)` (only when
  `balance >= cost`; deducts, ledger entry), `adjustStars(doc, childId, delta, now)`
  (parent correction; never below 0).
- Surprises: `addSurprise`, `markSurpriseSeen`.
- Views: `childSummary(doc, childId, now)` -> tasks grouped (to do, waiting for parent,
  done), jar balance, next goal and stars missing, unlocked-not-given rewards, unseen
  surprises; `reviewQueue(doc)` -> ready tasks of all children, oldest first;
  `improvement(task)` -> words gained versus the previous attempt, or null.
- PIN helpers (async, SubtleCrypto): `hashPin(pin, salt?)`, `verifyPin(doc, pin, now)`
  (backoff: after 5 failures lock for 30 s, doubling to at most 15 min). A PIN is 4 to 6
  digits; Arabic-Indic digits typed are accepted. This is a child lock, not security: the
  UI never claims more. "Forgot PIN" resets the PIN after a parental gate (a multiplication
  question written in words in the parent's language) and keeps all data.

## Web client

New files `web/rewards.js` (logic above) and `web/family.js` (the family UI: parent area,
child home, task runner glue), loaded before `app.js` with `defer`; `app.js` keeps the
existing screens and exposes the small hooks `family.js` needs (open a screen preloaded
with a text, range and mode; lock the mode; a callback with each check result). Keep the
CSP unchanged. No external requests. All strings in en, fr and ar (Arabic: follow the
wording policy in the latest Arabic polish: gender-neutral; parent-facing with يُرجى +
verbal noun; child-facing with هيا + first person plural; short noun button labels;
Arabic-Indic digits in the Arabic UI).

### First run and start

- First run (no v2 document): the existing start screen becomes **parent setup**: AI
  disclosure, consent box, create the parent PIN (twice), add the first child (nickname,
  age, language, avatar). Existing v1 users are migrated and asked only to create a PIN
  the first time they open the parent area.
- Later runs: **"Who is learning?"** child picker (avatars and nicknames, big targets) plus
  a small "For parents" button (PIN). The AI badge stays visible on every screen.

### Child home ("My tasks")

- Header: avatar, nickname, star jar (balance, progress bar to the next goal: "4 more
  stars to: 🍦 ice cream").
- Sections: **To do** (cards: kind icon, title, stars, reward emoji and text, due date if
  any, "Start"), **Waiting for your parent** (natural wording in each language that does
  not assume which parent), **Done** (trophy shelf, newest first, rewards marked
  "Unlocked: ask your parent" or "Received").
- Unseen surprises show once as a celebratory card ("A surprise for you! 🎁 ...").
- Free practice stays available (Prepare, Recite, Dictation, Quran) as today, for the
  active child.

### Doing a task

- "Start" opens the right screen preloaded: recite (text, lang, mode locked; the mode
  selector is hidden or disabled for a task), dictation (text, lang), Quran (surah, range,
  looking or memory; no mode selector exists for Quran and none is added).
- A banner shows the task title and "Pass: all words right" / "9 of 10 words" /
  "8 of 10 words" / "Same meaning" (contextual).
- Every check result is passed to `recordAttempt`. If it passes: a celebration card
  ("Well done! Your parent will check it, then you get your stars ⭐⭐ and 🍦"), with the
  usual specific praise and the improvement line. If not: the usual feedback plus "Try
  again whenever you are ready." The child can keep trying; attempts never reduce
  anything.
- Dictation: the existing parent review of the written text stays. When the parent
  confirms the dictation result and the task passes, offer the parent "Confirm the task
  now" (asks for the PIN) as a shortcut to the review-queue action.

### Parent area (PIN)

Tabs or sections:
1. **To review**: the review queue across children: child, task, best and last accuracy,
   attempts, when it became ready; actions "Confirm", "Not yet: try again" (optional
   note shown to the child), and for tasks never passed, "Confirm anyway" from the task
   detail. Shows the two notes about mishearing and no recordings.
2. **Tasks**: per child, create / edit / archive. Create form: kind (Recite, Dictation,
   Quran); text (typed, or photo through the existing page reader when Claude is set up,
   with the existing parent review of what was read); language; for recite only the mode
   (word by word / the meaning); for Quran: surah, from, to (existing limits), looking or
   from memory; pass level; stars; reward (emoji picker + text, optional); due date
   (optional). Validate the text with the server before saving.
3. **Rewards**: per child: star balance and history, goals (add, remove, "Give" when the
   balance covers it), unlocked task rewards with "Given", "Give a surprise" (emoji +
   text), "Adjust stars" (with a reason).
4. **Children**: add, edit, remove (confirm; removing deletes that child's data).
5. **Settings**: change PIN, parent language, delete all data on this device (confirm
   twice), a short privacy line ("Everything here stays on this device").

## Server

- The rewards feature needs no server storage.
- Close the meaning-mode Quran gap: in **contextual** mode, `/api/recite/check` refuses
  a text that contains a run of at least 4 consecutive Quran words (strict keeps 5), in
  addition to the existing rules. Measure false positives on ordinary Arabic text before
  choosing 4: build a set of at least 200 ordinary Arabic school sentences that are not
  Quran quotations (e.g. from the existing tests and the app's own strings, plus common
  religious-formula sentences such as "إن شاء الله سنذهب غدًا", "الحمد لله على السلامة")
  and report how many each threshold would refuse; if 4 refuses ordinary formula
  sentences, exclude the common formulas from runs (as `strip_framing` does) rather than
  raising the threshold.
- Add `POST /api/text/check` with JSON `{text, lang, mode?: 'strict' | 'contextual' |
  'dictation'}` returning `{ok: true, words: n}` or the same error codes and shapes as the
  other endpoints (`quran_text` with `scope` where it applies, `lang_mismatch`,
  `unreadable_text`, `text_too_long`, `empty_text`, `bad_text`). Prepare's "Confirm
  text" and task creation use it (instead of borrowing `/api/dictation/phrases`).

## Tests

- `tests/web/rewards.test.cjs`: Node unit tests of `web/rewards.js` (no browser): every
  state transition, pass rules per kind, Quran tasks never carry a mode, star arithmetic
  and ledger, goals, surprises, removal cascades, migration from v1, validation of
  corrupt documents, PIN hashing and backoff (Node has `crypto.webcrypto`).
- `tests/web/family.cjs`: headless Chromium with a fake API (as `smoke.cjs` does): first
  run setup, child picker, create tasks of each kind for two children, do a recite task
  that passes and one that fails, review queue confirm / send back / confirm anyway,
  stars and goals, surprise, reward given, PIN backoff, delete all data, v1 migration,
  Arabic UI (RTL, digits) at 360 px, no console errors, no external requests.
- Backend: tests for `/api/text/check` and the contextual Quran threshold.
- The existing `smoke.cjs` keeps passing (update it where the start screen changed).

## Decisions and deviations recorded while building the web client (first half)

The first half of "Web client" is built: loading and hooks, Prepare's "Confirm text" on
`/api/text/check`, first run and start, the PIN dialog, the child's home, the task
runner, the dictation shortcut, and the parent area's Children and Tasks sections. To
review, Rewards and most of Settings are real sections with a placeholder, for the next
step. Where this differs from the text above, or the text left a choice open:

- **Consent is stored** (`parent.consentAt`, `parent.aiConsentAt`), as the data model
  says, instead of being asked again each session. One consent box sets both (its notice
  names what goes to Claude when Claude is configured). It is in the family setup and in
  the parent area under Settings (the only live control there for now). The AI
  disclosure is still shown at the start of every session: on the setup or on "Who is
  learning?", which every session starts with (never straight on a child's screen).
- **Languages.** The child's screens (home, Prepare, Recite, Dictation, Quran) are in
  the child's language; the setup, "Who is learning?", the parent area and the PIN
  dialog are in the parent's (`parent.uiLang`). The PIN dialog stays in the parent's
  language on top of a child's screen (dictation shortcut).
- **The active child is per tab.** `activeChildId` is written as the last choice, but a
  tab keeps its own child: another tab picking a child does not move this one. The
  `storage` event reloads the document; a removed child, or a task that went away,
  sends this tab back to "Who is learning?" or the home.
- **The parent area locks when it is left** (any navigation), and a typed `#parent`
  address does not open it. Without consent it opens on Settings, where the box is.
- **Migration.** A v1 user lands on "Who is learning?" with one child; the first opening
  of the parent area asks for a new PIN (twice); consent is ticked in Settings (v1 never
  stored it).
- **Prepare.** "Confirm text" sends `{text, lang, mode: "strict"}` once. `dictation:
  false` rules out dictation (the existing reason, `error_quran_phrase`); `contextual:
  false` disables "The meaning", selects "Word by word" and shows why. The second,
  line-by-line `/api/dictation/phrases` request is gone. `words: 0` is "no words".
- **Task form.** The text is checked in the mode of the task: `strict` or `contextual`
  for recite, `dictation` for dictation. When `contextual` refuses with `quran_text`, one
  more check in `strict` tells "Quran text: create a Quran task" from "Quran words (the
  basmala): word by word only". An edit that keeps the text, language and mode is not
  checked again (it was checked when saved). Offline (no answer) says so and keeps the
  form; nothing is saved without a successful check. A page photo goes through the same
  reader as Prepare, with its review notes; a page with Quran text points to a Quran
  task (no button to the child's Quran screen from the parent area).
- **Quran task title.** The default title is the surah name and range in the child's
  language ("سورة الإخلاص ١–٤", "Al-Ikhlaas 1–4"), since the child reads it.
- **Task runner.** Only To do tasks have "Start". The free-practice page is kept aside
  during a task and comes back after it. The nav tabs are hidden during a task; the
  banner ("Back to my tasks") or the home button leaves it, and so does any other way of
  leaving its screen. Recite: the mode radios are set to the task's mode and disabled.
  Quran: the surah, the range, Juz' Amma and looking/from memory are disabled, and "Where
  am I?" shows no "Go there" (the task's range never changes); a check counts only for
  exactly the task's range. Dictation: the result counted is the one the parent
  confirms ("Confirm result"), not the checks made before a correction of the reading.
- **Outcome.** Under the usual feedback: the improvement line (`improvement(task) > 0`),
  then the celebration card (stars and reward) on a pass, or "Try again whenever you are
  ready". Nothing is spoken by the voice for it (and never on the Quran screen).
- **Child's home.** Unseen surprises are already shown once as a card ("Thank you" marks
  them seen); giving one is the Rewards section's job. Star counts use "label: number"
  wording in Arabic so that number agreement is never wrong.
- **Storage.** A document that cannot be read is copied to
  `mommy.data.v2.corrupt.<ISO time>`, the main key is removed and the setup starts, with
  a notice; a document that needed repairs is copied there too and used repaired, with a
  notice. A full storage (`QuotaExceededError`) and blocked storage (private mode) are
  shown in a notice; the session goes on in memory.

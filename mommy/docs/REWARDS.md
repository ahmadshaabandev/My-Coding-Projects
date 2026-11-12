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
5. **Quran in school texts (2026-11-11).** A text that *is* Quran (Q1: once the framing
   formulas, a basmala at the start and the surah and ayah labels are left out, what
   remains is whole ayat in mushaf order) belongs to the Quran section and to Quran
   tasks: recitation only, word by word against the Tanzil text. A school text that
   *includes* Quran (Q2: a lesson quoting an ayah or part of one, a text starting with
   the basmala, a short ayah inside a sentence) is a normal school text with **Quran
   parts**, which the server finds itself (`docs/CONTRACT.md`, hard rule 4):
   - it can be recited **word by word only** (never by meaning), its Quran parts checked
     against the mushaf words;
   - it can be **dictated**: the synthetic voice never reads a Quran part; the dictation
     stops at each one and **a grown-up reads it aloud** from the vowelled mushaf text,
     shown after a tap and hidden again before the child writes;
   - where the typed text differs from the mushaf, the parent sees the differences and
     can put the mushaf words in with one tap;
   - feedback about a mistake in a Quran part comes from fixed templates, quotes the
     mushaf word, and is shown, never spoken.

## Product rules

- **Quran tasks are always word by word.** A Quran task has no mode choice: it uses the
  Quran section's strict check (`/api/quran/check`) only. Its options are surah, ayah
  range and looking/from memory. Never offer "the meaning" for Quran anywhere.
- A recite or dictation task's text is validated when the parent creates it, with the
  same server checks as Prepare's "Confirm text" (`quran_text`, `lang_mismatch`,
  `unreadable_text`, `text_too_long`, empty text). A text that is Quran (Q1) cannot
  become a recite or dictation task; the parent is told to create a Quran task instead,
  and is offered one on the ayat of the text when they are one range. A school text that
  includes Quran (Q2, decision 5) can: a recite task with it is word by word only ("the
  meaning" is disabled, with the reason), and a dictation task with it is allowed and
  runs with the grown-up step for its Quran parts.
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
    aiConsentVersion: null | int,   // (2026-11-12) the text of the Claude notice it was given to; counts from 2: see the AI consent sections below
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
- **A copy of the family list** (added 2026-11-12, see the last section): a JSON file
  the parent saves and loads, `{"app": "mommy", "kind": "family-copy", "version": 1,
  "savedAt": iso, "family": {...}}`, where `family` is the document without `parent`
  (`version`, `createdAt`, `updatedAt`, `children`, `activeChildId`, `tasks`, `jar`,
  `surprises`): no PIN record, PIN backoff or reset, consent or parent's language.

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
  question written in words in the parent's language) and keeps all data. (As built: the
  old PIN stays until the new one is saved, wrong gate answers count toward the same
  pause, and the reset is shown in the parent area; see the last section.)

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
runner, the dictation shortcut, and the parent area's Children and Tasks sections (To
review, Rewards and the rest of Settings came in the second half, below). Where this
differs from the text above, or the text left a choice open:

- **Consent is stored** (`parent.consentAt`, `parent.aiConsentAt`), as the data model
  says, instead of being asked again each session. One consent box sets both (its notice
  names what goes to Claude when Claude is configured). It is in the family setup and in
  the parent area under Settings. The AI
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
  false` rules out dictation (since decision 5 only the server's safety net, with the
  reason `error_quran_unmarked`); `contextual: false` disables "The meaning", selects
  "Word by word" and shows why. The second, line-by-line `/api/dictation/phrases`
  request is gone. `words: 0` is "no words".
- **Task form.** The text is checked in the mode of the task: `strict` or `contextual`
  for recite, `dictation` for dictation. When `contextual` refuses with `quran_text`, one
  more check in `strict` tells "Quran text: create a Quran task" from "Quran words (the
  basmala): word by word only" (`dictation` likewise tells it from the server's safety
  net; see the last section for decision 5). An edit that keeps the text, language and mode is not
  checked again (it was checked when saved). Offline (no answer) says so and keeps the
  form; nothing is saved without a successful check. A page photo goes through the same
  reader as Prepare, with its review notes; a page with Quran text points to a Quran
  task (no button to the child's Quran screen from the parent area; since decision 5, a
  button that turns the form into a Quran task on the page's ayat). Without the online
  AI (`brain: "offline"`), a recite task shows "Without the online AI, the meaning check
  is only approximate." under the mode choice, as Prepare does, while "The meaning" can
  be chosen (not for a text with Quran words).
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

## Decisions and deviations recorded while building the web client (second half)

The second half is built: To review, the details of a task with "Confirm anyway",
Rewards and the rest of Settings, with the child's home showing what they change. Where
this differs from the text above, or the text left a choice open:

- **The parent area opens where something waits**: on To review when a task waits for a
  grown-up, else on Tasks (on Settings without consent, as before). The labels of To
  review and Rewards carry a count: tasks waiting, and task rewards to give.
- **To review.** Each task shows the child (avatar and nickname), the task (kind, title,
  pass level), the best and the last result, the number of tries, when it became ready,
  and the improvement line when it is greater than 0. A result is the share of words
  right as a percentage, which never rounds up to 100 below a perfect score; for "the
  meaning" it is the last verdict in words. The two notes (the app can mishear; no
  recordings, so ask the child to show you) stand above the queue while it has tasks;
  the empty state says that a task the app has not passed can still be confirmed in its
  details. "Not yet: try again" opens an optional note in place (at most 120
  characters); the child sees it on the task card ("💬 Note: …") and the attempts stay.
- **"Confirm anyway" is in the details of a task** (Tasks, "Details"), for any task to
  do: one the app never passed (with the mishearing note), or one to do again after "Not
  yet" or an edit (worded so). The details also show the dates, the text (or the surah,
  the ayat and looking/from memory), the reciting mode, the figures, the note, how the
  task was confirmed and the state of its reward, with Confirm and "Not yet" for a task
  waiting and "Given" for an unlocked reward. One task's details are open at a time.
- **Tasks and Rewards show the same child**: choosing a child in one chooses it in the
  other.
- **Rewards.** The one-line help about praise and surprises moved from the top of the
  parent area into Rewards, where rewards are given. Goals: the open ones cheapest first,
  then the given ones with their date; "Give" appears only when the jar covers the cost
  (otherwise "Still needed: N"); a goal can be removed, given or not (the history keeps
  its amounts). The stars of a goal start at 10 and accept Arabic-Indic digits. A
  surprise is a picture and a text, at any time; "Not seen yet" lists the surprises the
  child has not opened. "Adjust stars" asks for a reason (the text above says "with a
  reason"; rewards.js would accept none), offers "Add stars" or "Take stars away", and a
  correction larger than the jar stops at zero and says so; its hint says that stars are
  never taken away for a try that did not work. The history shows the newest ten entries
  and "Show all (N)"; a correction down is written in the normal text colour, never red.
- **The child's side shows no loss.** The jar shows its new number after a correction or
  a goal given; the reasons are only in the parent's history. (A later step could show
  the goals received on the Done shelf.) The surprise card fades in with a small slide
  (its size never changes; no motion with reduced motion) and is shown once.
- **Settings.** "Change the PIN" uses the PIN dialog: the current PIN (a wrong one counts
  toward the pause, like any PIN entry), then the new one twice; "Forgot the PIN?" works
  there too. The parent's language switches the parent area and the PIN dialog at once;
  status lines written in the old language are cleared; each child keeps their own
  language. "Delete all data on this device" asks twice in place ("Continue", then
  "Delete everything"), then removes `mommy.data.v2`, `mommy.profile.v1` and every
  `mommy.data.v2.corrupt.*` copy (no other key), forgets the session, empties the setup
  form (in the grown-ups' language) and starts the first-run setup with a notice. Another
  tab gets the `storage` event and does the same. If the browser refuses the removal,
  nothing is forgotten and the parent is told.
- **Status lines that hold a name or a reward** are built with `<bdi>` for the text people
  typed, so a French title or an Arabic name keeps its direction in any language.

## Decisions and deviations recorded while building Quran in school texts (web client)

Decision 5 is built in the web client on the server's answers (`quran_parts`,
`mushaf_text`, `quran_range`, `readers`, `read_text`, `feedback_is_quran`); the browser
never looks for Quran words itself. Where this differs from the text above, or the text
left a choice open:

- **Prepare, "Confirm text".** One `/api/text/check` request (mode strict), as before.
  A text with Quran parts is confirmed with "It includes words of the Quran", and a note
  under the text lists each part's reference (surah and ayah, "part of it" for a partial
  ayah; Arabic-Indic digits in the Arabic UI) and says what that means: checked word by
  word against the mushaf, "The meaning" not available, and in a dictation a grown-up
  reads them aloud because the voice never reads the Quran. "The meaning" is disabled
  with the reason and "Word by word" chosen; dictation stays available. The note comes
  from the server's answer for the text in the box, and goes away when the text changes.
- **Differences from the mushaf.** Each one is listed as the typed word and the mushaf
  word (a changed word), a missing word, or an extra word; vowel marks and the Uthmani or
  standard spelling never count. One button, "Use the mushaf text", puts the server's
  `mushaf_text` in the box (only the differing words change) and confirms it again at
  once; the note then says the mushaf words were put in. A text with differences is
  still confirmed as typed: the checks use the mushaf words anyway, and (since the
  review fixes) the child's Recite card shows the mushaf words. A page photo shows
  the same note right after it is read (its `mushaf_text` also fills a `[?]` where the
  reader dropped a word of an ayah). A page that is Quran keeps its "page is Quran"
  message, and its button opens the Quran section on its ayat.
- **A text that is Quran (Q1)** is refused as before; with `quran_range` the "Go to the
  Quran section" button opens the Quran section on that surah and range (saved as the
  child's Quran choice, as when the child picks it).
- **Recite.** For a text with Quran parts the mode is word by word (the selector is on
  Prepare, and a task's mode is locked as before), and a note for the grown-up says that
  the Quran words are checked as written in the mushaf and that the app's voice never
  reads them, so a grown-up can read the text aloud first. The app has no "read the text
  aloud as a model" button: the recite screen's "Listen" only speaks the feedback, so Q2g
  holds by construction. Feedback with `feedback_is_quran` (it quotes a mushaf word) is
  shown as text, never played and never sent to `/api/tts`: "Listen" is hidden and a line
  says so. The same holds for the dictation result.
- **Dictation, the grown-up step.** For a `grown_up` phrase the app never calls
  `/api/tts`. The card shows the part number as usual and, in large type for the child,
  "Let's ask a grown-up to read this part" (هيا نطلب من أحد الكبار قراءة هذا الجزء), with
  a box "For the grown-up" that explains why and has one big button, "Show the Quran
  words". The vowelled Uthmani chunk then appears, verbatim, in the Quran screen's font
  and size and with its line breaks (a pause mark stays with its word), with "Hafs –
  Tanzil" under it and "Done reading". "Done reading" removes the words from the page,
  frees "Next" and says "Now let's write it, then press Next". "Next" waits for "Done
  reading", as it waits for the voice. "Repeat" asks the grown-up again (the words hidden,
  the button back) and never calls the voice. Focus moves to "Show the Quran words" when
  the step starts, to "Done reading" when the words show and to "Next" afterwards; the
  child's line is a polite live region; everything works with the keyboard. Leaving the
  screen hides the words. The dictation's start screen says, before it starts, that a
  grown-up will be asked to read the Quran parts.
- **The voice's safety net.** If `/api/tts` ever refuses a phrase as `quran_text` (Quran
  words the server did not mark as a part), that phrase becomes a grown-up step (also
  when it was being fetched ahead) and the dictation goes on; the grown-up is shown the
  phrase as written (there is no mushaf text for it), with wording that does not call it
  the mushaf. The old "back to the start of the dictation" is gone. The server's other
  safety net, `"dictation": false` at "Confirm text" or a `quran_text` refusal from
  `/api/dictation/phrases` for a text the server checked, still rules out the dictation
  with the reason next to the disabled button; the `"scope": "phrase"` paths are removed
  (the server no longer sends them).
- **Tasks.** The text is checked in the mode of the task, as before. A recite task by
  meaning whose text has Quran parts is refused once with the reason; "The meaning" is
  then disabled and "Word by word" chosen, and the next "Save" saves it. A dictation
  task with Quran parts is saved, and the saved message says that a grown-up reads them.
  Differences from the mushaf are shown in the form before the first save (the form does
  not close on them): "Use the mushaf text" puts the mushaf words in and saves (the new
  text is checked first), or, for a dictation task only since the review fixes, a second
  "Save" keeps the text as typed (a recite task needs the mushaf text). A text that is
  Quran gets "Create a Quran task with these ayat" when the server gave its range (new
  tasks only; the kind of a task never changes): the form becomes a Quran task on that
  surah and range. A page photo in the form shows the same note and differences ("Use
  the mushaf text" then only fixes the text: nothing is saved before "Save").
- **The task runner** asks `/api/text/check` for the text of a recite or dictation task
  when it starts (a task keeps only its text), so the notes for the grown-up show before
  the first result; the dictation's phrases and every check result carry the parts too,
  so a failed request changes nothing else.

## Decisions and deviations recorded while building the logic (`web/rewards.js`)

Where `web/rewards.js` differs from the text above, or the text left a choice open:

- **Errors are thrown.** `createTask` returns `{doc, task}` or throws
  `RewardsError('bad_input', …)` with `field` set to the form field, rather than
  returning `{error}`; every mutator throws a `RewardsError` with a stable code
  (`not_found`, `bad_state`, `bad_input`, `insufficient_stars`, `locked`,
  `unavailable`) and changes nothing when it throws. `validateDoc` never throws and
  returns `{ok, doc, repaired, errors}` (`repaired` lists each repair; `errors` only the
  reasons a document is rejected).
- **Two additions to the data model.** A ledger reason `'carry'`: with the 200-entry
  cap, the oldest entries are folded into one `carry` entry at the start whose delta is
  their sum, so the balance always equals the sum of the ledger. A ledger `note` (null,
  or 1 to 80 characters on `adjust` entries only) holds the reason given under "Adjust
  stars".
- **`'unavailable'`** is the code when SubtleCrypto or `getRandomValues` is missing (a
  page that is not a secure context, such as a LAN address over http). `verifyPin`
  resolves with code `'locked'` instead of throwing while the PIN pauses.
- **Pass rules, read literally.** For strict recite and dictation, "all words right"
  (`minAccuracy: 1`) is met when `word_accuracy` is 1, so an extra (inserted) word still
  passes; for Quran, `minAccuracy: 1` means `n_errors === 0`, so an insertion fails. A
  Quran attempt is accepted only from `/api/quran/check` (it has `first_error`), and a
  Quran check result never counts for a recite or dictation task (review fix RL-8).
- **Choices.** Ids are 16 base36 characters from `crypto.getRandomValues`. The default
  pass level is all words right and the default stars 2; the avatars are a fixed list of
  16 and the reward pictures of 20. Every mutator takes `now`. `updateTask` works only on
  tasks to do or waiting; archiving an archived task is `bad_state`; marking a surprise
  seen twice changes nothing. `childSummary` does not use `now` (no countdowns). A v1
  profile without a nickname is named after its avatar.

## Decisions and deviations recorded while fixing the review findings (2026-11-12)

Two reviews (UX and logic) of the tasks and rewards and of Quran in school texts were
resolved. Where the result differs from the text above, or the text left a choice open:

- **"Forgot the PIN?" never leaves the family without a PIN** (UX-01, RL-4). The gate is
  a two-digit number times a one-digit number, still written in words ("forty-seven times
  eight"; in Arabic "سبعة وأربعين في ثمانية") and answered in digits. A wrong answer
  counts toward the same pause as a wrong PIN, and "Forgot the PIN?" is hidden while the
  PIN pauses. A right answer does not remove the PIN: the old PIN works until the new
  one is saved, so Cancel keeps it (`setPinRecord` replaces it in one step; `clearPin`
  is no longer used by the app). The document records `parent.pinResetAt` (a new field;
  a document saved before it reads as null), and the parent area shows "The PIN was
  reset on <date>. If it was not you, please choose a new PIN in Settings." until a
  grown-up hides it (`dismissPinReset`). A migrated v1 family, which has no PIN yet,
  answers the same gate before creating its first PIN (the text above says it is only
  asked to create one); `validateDoc` therefore keeps a pause on a document without a
  PIN, and still clears it with an invalid PIN record.
- **The parent area locks by itself** (UX-02): when the page is hidden (another app, the
  screen off) and after 3 minutes without a tap or a key, it closes on "Who is learning?";
  a line under its title says so.
- **Two tabs never overwrite each other** (RL-3). Saving is compare-and-swap: before an
  operation, a tab takes the stored document when another tab saved since it last read
  or wrote, runs the operation on it, then draws the screen again. The PIN check is split
  (`checkPin` hashes, `applyPinCheck` records the outcome on the document as it is after
  the hash), so a slow phone's check keeps what another tab saved, and failures made at
  the same time in several tabs all count.
- **Irreversible actions ask in place first** (UX-09): "Archive" and a goal's "Remove"
  show a question with the action and "Keep it" (no undo, which could restore an older
  document over another tab's change). The button that marks a reward given reads "Mark
  as given" (تسجيل التقديم), not "Given" (UX-10).
- **The child never reads a misquoted ayah** (UX-03). A recite task whose Quran words
  differ from the mushaf is saved only with the mushaf text ("Use the mushaf text"); a
  second "Save" no longer keeps the typed words for a recite task (it still does for a
  dictation, whose Quran words the child never sees: a grown-up reads the mushaf text).
  The default title of such a dictation is made from the mushaf words. In free practice,
  and for a task saved earlier with a misquote, the Recite card shows the server's
  `mushaf_text`; the typed text stays in the grown-up's box.
- **One message for two problems** (UX-06): a recite task by meaning whose Quran words
  also differ from the mushaf gets one message that says both, and the focus goes to the
  note under the text.
- **The saved text's Quran parts are known when it is edited or looked at** (UX-17). The
  edit form and the task's details show the parts of the saved text ("The meaning" is off
  from the start); the server's answer is kept for the session (filled when a task is
  saved, else asked once).
- **A task by meaning whose text has Quran words** (RL-6; saved before the rule, or
  before a finder improvement) cannot be recorded: the child is told "Let's ask a
  grown-up to change this task", and its details offer "Recite word by word" (the task's
  mode becomes word by word, its pass level stays). The server marks a refusal by meaning
  with `"reason": "meaning"`, so the client never words it as "this text is from the
  Quran" with the Quran-section button.
- **The grown-up step for a child who cannot read yet** (UX-04). The voice says the
  child's line ("Let's ask a grown-up to read this part") once when the step starts, in
  the child's language; it holds no Quran word, and the Quran words never go to the voice.
  Repeat asks the grown-up again without the voice: the product owner's rule says Repeat
  on a Quran part never calls the voice, so the reviewer's "speak the ask line again on
  Repeat" was not followed. "Show the words of the Quran" is an outline button, so the
  child's eye goes to the ask line (a press-and-hold was not added: it is harder for a
  grown-up with a screen reader). The grown-up text asks to show the words "where only
  you can see them". A dictation task whose text has Quran parts says "Let's do this one
  with a grown-up" on the child's To-do card and on the dictation's start.
- **Differences from the mushaf** (UX-05) are shown against the standard spelling with
  the changed letters marked, then the Uthmani form; a missing word says after which
  word; each reference shows the part's first two and last two mushaf words.
- **A dictation is checked on paper** (UX-13): the details of a dictation the app has not
  passed say "If you have checked your child's paper yourself…", and a dictation waiting
  for review says "Please look at the paper before confirming".
- **Wording.** "The meaning" off now gives the reason: the app never judges the meaning
  of the Quran (UX-11). The page message fires only for a page that is ayat of the Quran
  only, and says so (UX-14). The child's praise line has the Arabic number forms (one,
  two, 3 to 10, 11 or more) and the review labels agree ("أفضل نتيجة"، "آخر نتيجة")
  (UX-15). Older strings shown on every session were brought to the wording policy: the
  Arabic disclosure and consent texts (no ـك ending, no naming of which parent), and a
  consent sentence that fits a family with several children (UX-16). French uses
  no-break spaces before : ; ! ? and inside « » (a smoke check keeps it so), and the
  child-facing French is "nous" throughout (UX-12). The Arabic feedback about a word of a
  Quran part says what to do ("… هيا نقرؤها مرة أخرى") (UX-18).
- **Layout** (UX-07, UX-08, UX-19): a word in a segmented choice never breaks in the
  middle and the pass levels go to one column below 380 px; a setup error stands under
  its field, which points to it (`aria-invalid`, `aria-describedby`); the tanzil.net
  link is a full touch target.
- **Quran in school texts, on the server** (RL-1, RL-2, RL-5, RL-7; see
  `docs/CONTRACT.md`, guard.py). A short ayah with one misread or dropped word is found
  framed or not; Quran words joined by a hyphen, an apostrophe or the Arabic letter mark
  are separate words, and the voice also refuses words joined by a tatweel or an
  invisible character and a short ayah after و/ف. The everyday formulas stay ordinary
  words whatever the commas: a dictation joins a formula the voice refuses on its own
  with a neighbouring phrase (only a text that is nothing but a formula has it read by a
  grown-up), so the `[split]` sentences can again be recited by meaning. A word the child
  adds past a text with Quran parts, or a word of a part said elsewhere, never reaches
  Claude.
- **Not done:** a Q1 text that lost its last word to OCR, framed and alone, stays a Q2
  text (a partial ayah on its own is Q2 by the product owner's decision, and the two
  cannot be told apart); a three-word ayah with a dropped word or a two-letter changed
  word outside a framing formula, and a misquote with two errors, are not found
  (measured in `docs/CONTRACT.md`).

## Decisions and deviations recorded while making the privacy texts true online (2026-11-12)

- **The privacy line of Settings** (and of the family setup, which said "Saved only on
  this device") now names the data it covers: "The family data (children, tasks, stars,
  rewards and the PIN) stays in this browser, on this device." It is true in every way
  the app runs; online, the recordings, photos and texts go to the Mommy server, as the
  consent box under it says (`docs/CONTRACT.md`, "Start screen").

## Decisions and deviations recorded while separating the AI consent (2026-11-12)

The privacy audit after the online-privacy fix found that one checkbox set both
`consentAt` and `aiConsentAt` whatever the brain was, so a parent could agree while the
box said that nothing goes to an AI service, and that consent then covered Claude once
the owner set it up (P1). Its three smaller findings were about wording (P3, P4, P5).

- **The AI consent is a box of its own.** In the setup and in Settings, the general box
  (microphone and camera) is followed by the lines of where the data goes and, only
  while `/api/health` says `"brain": "claude"`, by the Claude notice (`consent_claude`)
  and the AI box under it ("I agree that these things are sent to Claude."). The AI box
  can be ticked only with the general one; unticking the general box in Settings
  withdraws both, as before; the AI box alone withdraws only Claude. Ticking the general
  box never gives the AI consent. Both boxes stay optional in the setup.
- **Migration: old documents are asked again once.** A document saved before this change
  cannot say whether its `aiConsentAt` was given under the Claude notice or while the
  box said "Offline mode: nothing leaves this computer", so the safe reading was chosen:
  the AI consent counts only with `parent.aiConsentVersion` set to 1 or more
  (`AI_CONSENT_VERSION`, `hasAiConsent(doc)` in `rewards.js`; it also needs
  `consentAt`). `updateParent(doc, {aiConsent: true})` records the time and the version
  (a consent that already counts keeps its time; an old one gets a new time), refuses
  without the general consent (`bad_state`), and `{consent: false}` or
  `{aiConsent: false}` clears both fields. `validateDoc` reads a missing
  `aiConsentVersion` as null without a repair (no notice for the parent) and keeps the
  old `aiConsentAt`, which simply does not count; an invalid version, or a version
  without a time, is cleared as a repair. A v1 profile's AI consent never counts either.
  Version 1 means "ticked in its own box while its text was the Claude notice"; a later
  change of what goes to Claude can raise the version, and every family is then asked
  again.
- **What waits for the AI consent.** While Claude is set up and the consent does not
  count, every call whose server path can use Claude is gated in `app.js` (gate need
  `ai-consent`): reading a page photo (Prepare and the task form), Recite in both modes
  (Claude judges the meaning, and words the feedback of a word-by-word check from the
  words the child got wrong), and the dictation check, typed or photographed (Claude
  reads the handwriting and words the feedback). "Confirm text" (`/api/text/check`), the
  dictation's voice, the grown-up step and the whole Quran section never use Claude and
  keep working; so does the task runner (a task waits on its screen, with its banner).
  Without Claude the general consent is enough, as before.
- **Claude added while the page is open.** The page reads `/api/health` once at the
  start; the owner may start the server again with Claude meanwhile. So, without the AI
  consent, the client asks `/api/health` again right before each of those calls and
  sends nothing if Claude is now set up: the status says "Nothing was sent.", the gate
  closes with its reason and the consent texts change to the Claude notice. A recording
  made in that moment is dropped.
- **What the child and the parent see** (superseded in part by V6, see below: no child's
  screen waits for the AI consent now, so none shows the child's line; the prompt says
  that only the photos stay off). The child's screens (in the child's language)
  say "Let's ask a grown-up to open the parent area and give their OK first." (هيا نطلب
  من أحد الكبار فتح قسم الكبار والموافقة أولًا.), which names no service and no box. In the
  parent area, behind the PIN, a prompt at the top ("Your OK for Claude") says what stays
  off until the parent agrees, shows the Claude notice and a box of its own, and has
  "Save" (which asks for the tick first) and "Not now" (hidden until the parent area is
  opened again; never shown on Settings, which has the box). The task form's photo says
  "Reading photos uses Claude: please give your OK for Claude in Settings first." The
  parent area still opens on Settings when the general consent is missing.
- **Wording (P3, P4, P5).** The family data line now says what is saved where and what
  travels with each check, true in all four modes: "Your family's list (children, tasks,
  stars, rewards and the PIN) is saved only in this browser, on this device. Each check
  sends the text or the ayat to practise, the language and the child's age group to the
  Mommy server, which does not keep them." (it replaces the line recorded in the
  previous section; with Claude, the consent box says what also goes to Claude). Online
  without Claude: "Nothing is sent to an outside AI service such as Claude, and you type
  the texts yourself." (the server's own recogniser is not an outside service). Locally,
  "never saved" and "not kept" now say whose storage they mean, and nothing about
  Claude's: "Mommy handles the recordings and photos in memory and never saves them."
  and "Photos are made smaller on this device, and Mommy does not keep them."; the
  Claude notice itself is unchanged. The same in French and Arabic (Arabic: passive
  forms, يُرجى + a verbal noun for the parent, هيا + "we" for the child, no ـك ending).
- **Not done then:** the server cannot be told to leave Claude out of one request, so with
  Claude set up and no AI consent, Recite and the dictation check stay off rather than
  falling back to the offline templates (that would need a change to `app.py`, which
  this step did not own). Done since: see "Decisions recorded while the server took part
  in the AI consent (V6)" below, which also replaces "What waits for the AI consent" and
  "Claude added while the page is open" above, and the child's line and "what stays off"
  in "What the child and the parent see".

## Decisions recorded at the second check of the AI consent (2026-11-12)

The independent check of the separate AI consent found the gate itself sound, and six
problems in what the texts say (V1 to V5) and in where the gate is enforced (V6).

- **V1, the Claude notice names everything Claude gets.** The notice the parent agrees to
  left out the language and the child's age group, which `llm.py` sends with each
  meaning check and each feedback ("Language: ... Age band: ..."), and the score that
  comes with the words the child got wrong. It now ends: "...and the words your child
  got wrong, with the score, so that it can word the feedback. The language is sent
  with each of them, and your child's age group with the meaning check and the
  feedback. The recordings themselves are not sent." (the same in French and Arabic).
  `AI_CONSENT_VERSION` is now 2: a consent of version 1 was given to the shorter text,
  so it no longer counts and the family is asked again (read without a repair, so no
  notice; the AI box gives a new time and version 2). Two checks keep it so:
  `tests/web/smoke.cjs` reads every value that `ClaudeBrain` puts into a request and
  fails on one the notice does not name, and it keeps a fingerprint of the notice (en,
  fr, ar, with the box's label) for the current version, so a change to the notice
  fails until the version is raised.
- **V2 and V3, the family data line.** "Each check sends the text or the ayat ..., the
  language and the child's age group to the Mommy server, which does not keep them" was
  not true: a Quran check sends only the surah and ayat numbers (and the recording), and
  the server's log notes the language of each check and the ayat numbers of a Quran
  check (a `docker compose` install keeps up to 30 MB of it). The line is now: "Your
  family's list (children, tasks, stars, rewards and the PIN) is saved only in this
  browser, on this device. To check a text or read it out, the Mommy server gets the
  text and its language, and for a recitation or dictation check also the child's age
  group; a Quran check sends the surah and ayat numbers instead. The server does not
  keep the texts or the age group; its log notes the language, the kind of check and
  the ayat numbers." `tests/web/access.cjs` checks the log claim against the real app
  (a text check and a typed dictation check: the language and the kind of check are in
  the log, the words of the text and the age group are not). The log itself was left as
  it is (`app.py` is the self-hosting kit's).
- **V4, the cards for the grown-up.** Prepare and the check stage of a dictation are
  headed "For the grown-up", yet showed the child's line. A `[data-why]` line in a part
  of a screen headed by a `.tag-parent` (`forGrownUp` in `app.js`) now says "This uses
  Claude: please give your OK for Claude in the parent area (Settings) first."
  (`consent_needed_ai_grownup`); the child's screens (Recite) keep the child's line, and
  the parent area its own. (Superseded by V6 and its review: Recite no longer waits, so no
  child's screen shows the child's line, and the grown-up's line, now shown for the
  photos only, says "Reading photos uses Claude: ...", as the parent area's does.)
- **V5, the photo note with Claude.** The photo buttons work only with Claude, so the
  note under them now says where the photos go: "Photos are made smaller on this
  device, then sent to Claude to be read. Mommy does not keep them." locally, and
  "...then sent over a secure connection to the Mommy server, which does not keep them
  and passes them on to Claude to be read." online. Nothing is said about what Claude
  keeps; without Claude the notes are as before.
- **V6, not done then (done since: see the next section): the gate is the web client's
  only.** Three gaps remain, all of which need the server to take part: a server started again with Claude between the client's
  quiet `/api/health` check and its request; a tab still running an older `app.js`
  after an update; and any client other than this page. The fix that would close the
  first two is an opt-in field on `/api/page/read`, `/api/recite/check` and
  `/api/dictation/check` (for example `ai_consent=1`, sent by the client only with a
  consent that counts), without which the server uses the offline brain for that one
  request; it would also let Recite and the dictation check fall back to the offline
  templates instead of staying off. It changes the HTTP API and the server's tests, and
  `app.py` belonged to the self-hosting kit while this was done, so it is left for a
  step that owns the server. The third gap is the access code's to close.

## Decisions recorded while the server took part in the AI consent (V6, 2026-11-12)

- **V6 is done: the server decides, for each request.** `/api/page/read`,
  `/api/recite/check` and `/api/dictation/check`, whose handling is every use of the
  Claude brain in `app.py` (`read_page`, `read_handwriting`, `judge_meaning`,
  `word_feedback`), take an opt-in form field `ai_consent` (`app.ai_consent_given`). Only
  the exact value `"1"` in the form body counts. No field, an empty value, `"0"`,
  `"true"`, `" 1 "`, a file part and a field in the query string (never read) mean no
  consent: that request is answered by the offline brain exactly as by a server without
  Claude, and Claude is not called at all. This closes the first two gaps: a server
  started again with Claude after the page last asked `/api/health`, and a tab still
  running an older `app.js` (it sends no field). Any other client likewise gets no
  Claude without the field; who may use the server at all is still the access code's.
- **A field sent twice counts only when every copy is `"1"`** (`"1"` beside `"0"` or an
  empty value is no consent). This was chosen over a 422: nothing ambiguous reaches
  Claude, and an odd client still gets its check.
- **The answer says which brain had it.** Every answer of the three endpoints has
  `"brain": "claude" | "offline"` (`docs/CONTRACT.md`, "AI consent" under HTTP API);
  `"offline"` means that nothing of the request went to Claude. The server's log line of
  each names the brain too, never a text, the age group or the code.
- **The client sends the field** (`addAiConsent` in `app.js`) only when, as the request
  is built, the consent counts (`state.aiConsent`, which `family.js` sets from
  `hasAiConsent(doc)`) and `/api/health` says `"brain": "claude"`, so the page shows the
  Claude notice the consent was given to. A page that still believes the brain is
  offline sends no field, so what it says ("Nothing is sent to an outside AI service
  such as Claude") stays true if Claude is set up meanwhile; a reload shows the Claude
  notice, its box and the prompt. A request sent with the field and answered
  `"brain": "offline"` (the server was started again without Claude) makes the client
  ask `/api/health` again, so the texts and the gates follow.
- **Recite and the typed dictation check no longer wait for the AI consent.** With
  Claude set up and no consent that counts, they are sent without the field: word by
  word with the offline feedback templates, by meaning with the offline heuristic, whose
  answer is `approximate` (the result's "approximate" label, and `mode_contextual_offline`
  under the mode choice of Prepare, which now also shows while the consent does not
  count). The photos (Prepare, the task form, the dictation's paper) still need Claude
  and keep their gate with the grown-up's and the parent's lines; right before a photo
  is sent the consent is read again, and if it no longer counts nothing is sent
  ("Nothing was sent.") and `/api/health` is asked again for the gates. The quiet
  `/api/health` check before Recite and the dictation check is gone: the privacy
  guarantee is the server's now.
- **Texts.** The parent's prompt now says: "Mommy is set up to use Claude. Until you
  agree, reading photos stays off, and recitations and dictations are checked without
  Claude (by meaning, only approximately); the Quran section works without it." (French
  with "vous"; Arabic with passive forms: "...تبقى قراءة الصور متوقّفة، ويُتحقَّق من التسميع
  والإملاء من دون Claude (ويكون التحقّق من المعنى تقريبيًا فقط)..."). The child's line
  (`consent_needed_ai`) is kept for a gate on a child's screen, but no child's screen
  has one now. The Claude notice is unchanged, so `AI_CONSENT_VERSION` stays 2.
- **Tests.** `tests/test_api.py` (`TestAiConsent`): every way of not giving the consent,
  on each of the five requests that can reach Claude, gets the exact answer of a server
  without Claude and never calls the fake Claude brain; `"1"`, also sent twice, lets it
  answer; the field changes nothing on a server without Claude; urlencoded and multipart
  bodies; the log. `tests/web/smoke.cjs` and `tests/web/family.cjs` record the field the
  client sends (none without a consent that counts, `["1"]` with it); the fake API
  answers as the server does. `tests/web/access.cjs` sends requests built as an older
  client builds them to the real app with a fake Claude brain.
- **Done at the review (RA-1):** the task form's note about an approximate meaning check
  (`family.js`, `updateTaskOfflineNote`) now shows whenever a check built then would go
  without the field (`app.aiConsentNow()`, the test of every request), so also with
  Claude set up while the AI consent does not count, and it follows the consent at once
  (`syncApp`).

## Decisions recorded while adding a copy of the family list (2026-11-12)

The self-hosting review's R1 (d): the family document is per browser and per address,
and a Cloudflare quick tunnel gets a new address after each restart, so a friend's
family list was empty at the new link. The parent can now move it with a file.

- **"Save a copy"** (Settings, behind the PIN) downloads `mommy-family-YYYY-MM-DD.json`
  (the date of the day on the device) through a Blob URL and an `<a download>` element:
  the file is made in the browser, no request is sent, and the page's CSP is unchanged
  (checked in Chromium by `tests/web/family.cjs`). The note next to the buttons says what
  it holds and that it is not encrypted: "The file holds the children’s names and age
  groups, their tasks, stars and rewards, but not the PIN. It is not encrypted: please
  keep it private." It is true in every way the app runs (the copy never reaches the
  server, and holds nothing of Claude). "Delete all data on this device" now says that
  it does not delete a copy saved as a file.
- **What a copy leaves out.** The whole `parent` part of the document: the PIN's hash
  and salt (a 4- to 6-digit PIN's PBKDF2 hash is quickly brute-forced from a file), its
  backoff and reset, every consent (`consentAt`, `aiConsentAt`, `aiConsentVersion`: a
  consent belongs to the address and the mode, with or without Claude, where it was
  given) and the parent's language. `parent` is left out as a whole rather than field
  by field, so a field added to it later is left out too until someone decides otherwise.
- **Pure functions in `rewards.js`.** `makeFamilyCopy(doc, now)` returns the copy
  object; `readFamilyCopy(text)` returns `{ok, error, family, savedAt, repairs}` and
  never throws; `useFamilyCopy(doc, family, now)` returns this device's document with
  the family of the copy and this device's `parent` unchanged; `familySummary(family)`
  counts the children, their tasks (not archived) and the stars in their jars;
  `FAMILY_COPY` holds the app, kind, version and size limit. The suggested
  `readFamilyCopy(text, now)` lost its `now`: nothing in reading a copy depends on the
  time.
- **Refusals** (`error`): `too_big` (more than 2 MB of UTF-8; the page checks the
  file's size before reading it), `not_copy` (not JSON, or no `app` "mommy" and `kind`
  "family-copy"), `newer_version` (a copy of a later version, or a family document of a
  version above 2) and `damaged` (cut short: not JSON but starting like a copy; another
  version; no family; a family that `validateDoc` rejects). The page also says when the
  browser cannot read the file. Each has its message in en, fr and ar. (Made stricter at
  the review, see the next section: a file that is no JSON object is `not_copy` before
  its size is counted; `damaged` also for a family without the lists of a copy, children
  all invalid, or over 2 MB once checked; `empty` for a family with no child.)
- **Checked like stored data.** The family goes through `validateDoc` with an empty
  parent, exactly as a stored document does; its repairs are returned (with any unknown
  field of the copy, and a `parent` found in a hand-made file, which is never read), and
  the summary says "Part of this copy was damaged: it has been repaired as far as
  possible." Every value is read as an own property and `validateDoc` builds new
  objects, so `__proto__` and `constructor` keys stay plain data (unit-tested at every
  level of the file). A copy is the family's: its ids and times are kept, `updatedAt`
  becomes the time it is used.
- **"Load a copy" in Settings.** After the file is read, the confirmation shows when
  the copy was saved, the number of children and each child (picture, name, tasks,
  stars), asks "Replace this device’s family list with the copy? …" (the PIN and the
  consents of this device stay) and suggests "Save a copy" first; "Replace" or
  "Cancel". It is a danger-bordered box like "Delete all data". Another tab follows
  through the `storage` event.
- **"Load a copy" at the first-run setup.** A small link-styled file button under the
  language. A copy replaces the fieldset of the first child (no nickname is asked) with
  its summary and "Do not use this copy"; the consent boxes and the PIN (twice) are given
  as for a new family, then "Let's start" ends on "Who is learning?" (a copy can hold
  several children). The setup also takes a copy saved on another device.
- **The file input** accepts `.json` and `application/json`, so a phone's picker shows
  the copy; another file chosen anyway gets "This file is not a copy of a Mommy family
  list.".
- **The parent area stays open while a file is chosen.** It locks when the page is hidden
  (UX-02), and a phone's file picker hides the page (Android opens it as another app), so
  "Load a copy" in Settings would have locked the area before the file came back. The
  first hiding within 10 seconds of a tap on a file input of the parent area ("Load a
  copy", and the task form's photo buttons, which had the same problem) no longer locks
  it; the 3-minute timer still runs, and any other hiding locks it as before. (At the
  review the exemption also ends when the picker is done without hiding the page, see
  the next section.)
- **Not done:** a copy is not encrypted (a passphrase would be one more secret for a
  non-expert family to lose, and the file holds no PIN); a copy cannot be merged into
  an existing list (it replaces it); and the copy must be saved while the old address
  still works, which the self-hosting guides say (`SELF_HOST.md`,
  `deploy/oracle/ORACLE.md`).

## Decisions recorded while fixing the reviews of V6 and of the copy (2026-11-12)

The independent reviews of the server's part in the AI consent (RA-1 to RA-6) and of
the copy of the family list (B-R1 to B-R6) found no privacy breach; these are their
fixes.

- **RA-1, the task form's "approximate" note** shows whenever a check by meaning built
  then would go without `ai_consent=1` (`app.aiConsentNow()`, exported to `family.js`),
  so also with Claude set up and no AI consent that counts; `syncApp` redraws it after
  every change of the consent (the prompt's OK hides it at once, the form still open).
- **RA-2, the label of an approximate result.** "Approximate check (offline)" now shows
  only locally without Claude. Wherever Claude is set up (locally too, where the setup
  names Claude) a check it did not judge (no AI consent, or an error of Claude) says
  "Approximate check (without the online AI)" (`approximate_online`), which was already
  the online label. No new string.
- **RA-3, the grown-up's line of the photo gates** names the photos, as the parent
  area's line does, since it stands beside the typed check, which does not wait: "Reading
  photos uses Claude: please give your OK for Claude in the parent area (Settings)
  first." (fr "La lecture des photos utilise Claude : veuillez d’abord donner votre accord
  pour Claude dans l’espace parents (Réglages).", ar "قراءة الصور تستخدم Claude: يُرجى
  أولًا تسجيل الموافقة على Claude في قسم الكبار (الإعدادات).").
- **RA-4:** the passages of this file that V6 superseded say so, and the comment of
  `onHealth` in `family.js` says when `/api/health` is asked again (before a photo, or
  after a request sent with the consent that the offline brain answered).
- **RA-5, the published schema** (`/api/openapi.json`) lists the optional form field
  `ai_consent` on the three endpoints and `brain` (`"claude"` or `"offline"`, required)
  in their answers (`app.document_ai_consent`, for every route that depends on
  `ai_consent_given`). Only the description changes: `ai_consent_given` still reads the
  field itself, so a field sent twice counts only when every copy is `"1"`, and a file
  part or any other value is no consent rather than a 422.
- **RA-6, the web client's files are revalidated.** Every response outside `/api/*`
  that sets no `Cache-Control` gets `Cache-Control: no-cache` (`STATIC_CACHE_CONTROL`):
  the browser asks again before it reuses `app.js` (a 304 with the `ETag`), so after an
  update an older client, which sends no `ai_consent` and so gets offline answers, does
  not keep running across ordinary reloads. With the access gate its own
  `private, no-cache` is kept. A tab left open across an update still runs the old
  script until it is loaded again; privacy holds, as V6 made sure.
- **B-R1, the file-picker exemption ends with the picker.** It is armed by a tap on a
  parent-area file input and ends at the first hiding within 10 s, as before, and now
  also as soon as the picker is done without hiding the page: the input's `change` (a
  file chosen) or `cancel`, or the window's `focus`. On a computer or an iPhone's sheet,
  the next hiding (another tab, the power button right after "Replace") locks the area
  again. On Android the picker's hiding comes before `change`, so it still uses the
  exemption.
- **B-R2, a copy's size is bounded once checked, and "Done" means stored.** A copy made
  here is already in the form `validateDoc` gives, so it never grows when it is read; a
  changed file can (62,000 children of two fields took 1.97 MB, and much more once
  completed). `readFamilyCopy` now refuses, as `damaged`, a family that would not fit in
  a copy of 2 MB again (the file itself is not too big, so "more than 2 MB" would not be
  true of it): a loaded copy can always be saved again, the stored document stays
  bounded, and the page no longer draws tens of thousands of lines. "Replace" and "Let's
  start" with a copy now look at whether the document was stored: when the storage is
  full, this tab keeps the list that is stored, the question (or the setup with its
  copy and fields) stays open, and the status says "The storage of this browser is full,
  so the copy could not be used. Please free some space (for example old site data),
  then try again." (`fam_copy_err_full`, en/fr/ar). Without any storage (private mode
  in some browsers) the whole session runs in memory with its notice, and a copy is used
  like any other change.
- **B-R3, a family without the lists of a copy is damaged; one with no child is
  refused.** `makeFamilyCopy` always writes `children`, `tasks` and `surprises` arrays
  and a `jar` object; a family without them (`{version: 2}`, a string as the children,
  an array as the jar, a 200,000-deep array), or whose children all had to be dropped, is
  `damaged`, where `validateDoc` would have read it as an empty family that "Replace"
  would then use to empty the list. A real copy of a family with no child (every child
  removed) is refused as `empty`: "This copy holds no children, so there is nothing in
  it to use." (`fam_copy_err_empty`); "Save a copy" of such a family says "There is no
  child in the family list yet, so there is nothing to save." (`fam_copy_err_save_empty`)
  instead of making a file that could not be loaded.
- **B-R4, a photo chosen by mistake is "not a copy".** A text that, after a byte-order
  mark and white space, does not start with `{` is `not_copy` before its size is
  counted: a binary file read as text has a U+FFFD (3 bytes) for each invalid byte, so a
  1.5 MB photo was called "more than 2 MB". A file over 2 MB is still `too_big` from its
  size, before it is read.
- **B-R5, the family data line names the copy.** It said the list "is saved only in this
  browser, on this device", next to a button that writes it to a file. It now reads
  "Your family’s list (children, tasks, stars, rewards and the PIN) is saved only in this
  browser, on this device, unless a copy is saved with “Save a copy”: the copy is a
  file, without the PIN, where the browser saves downloads. ..." (fr "... sauf si une
  copie est enregistrée avec « Enregistrer une copie » : la copie est alors un fichier,
  sans le code parent, là où le navigateur enregistre les téléchargements. ...", ar
  "... ما لم تُحفظ نسخة منها بزرّ «حفظ نسخة»: فتكون النسخة ملفًا، من دون رمز الكبار، في
  المكان الذي يحفظ فيه المتصفح التنزيلات. ..."). It is true in every mode (the copy is
  made in the browser and never sent). "Where the browser saves downloads", not "on
  this device": Safari on an iPhone saves to the Files app, which may be iCloud Drive;
  the guides (`SELF_HOST.md`, `deploy/oracle/ORACLE.md`, `README.md`) say so.
- **B-R6:** `docs/CONTRACT.md` now describes Save and Load a copy under the parent
  area's Settings, the file-picker exception to the lock, the copy in hard rule 5 and the
  family data line as it is now.

# Web client tests

Run from `mommy/`. The browser tests need Node.js and Playwright with Chromium (already
installed here: `require('playwright')` works). `rewards.test.cjs`, `smoke.cjs` and
`family.cjs` start no backend; `access.cjs` starts the real app (with fake speech
components) through `.venv/bin/python` on a free loopback port and stops it. Each file
exits with 0 when every check passes and prints one line per check.

```sh
node tests/web/rewards.test.cjs   # about 20 s; also runs with: node --test tests/web/rewards.test.cjs
node tests/web/smoke.cjs          # about 1 to 2 min
node tests/web/family.cjs         # about 1 min
node tests/web/access.cjs         # about 15 s: the access gate of an online deployment
```

| Command | What it checks |
|---|---|
| `node tests/web/rewards.test.cjs` | `web/rewards.js` in Node, no browser: every state transition, the pass rules (a Quran check result never counts for a school task), stars and ledger, goals, surprises, migration, `validateDoc` (repair notes of inherited keys), the PIN: hashing, the pause, `checkPin`/`applyPinCheck` apart from the document (failures in several tabs all count, a stale check does not apply), `setPinRecord` with `pinResetAt`, gate answers in the pause, the AI consent (`aiConsentVersion`, `hasAiConsent`: the general consent never sets it, it needs the general one, withdrawing the general one withdraws both, an old document's `aiConsentAt` without a version is read without a repair and never counts until the parent ticks the AI box again) (also runs with `node --test`). |
| `node tests/web/smoke.cjs` | The existing screens (Prepare, Recite, Dictation, Quran) through the v2 start (family setup), "Confirm text" with `/api/text/check`, Quran in a school text (Q1 and Q2: the note and the differences from the mushaf at "Confirm text" and from a page photo, "Use the mushaf text", Recite word by word only with Quran feedback never spoken, the dictation's grown-up step in the middle and at the start, Repeat, keyboard and focus, the voice-refusal safety net, a text that is Quran opening the Quran section on its ayat; en, fr and ar at 360 px and dark mode), the fake's Quran parts against the server's finder, the Arabic wording of `app.js` and `family.js`, French typography (a no-break space before : ; ! ? and inside « »), 360 px, dark mode, no external requests, and no `/api/tts` request holding a Quran part. Since the review fixes also: the differences against the standard spelling with the changed letter marked, the part's first and last words, the Recite card with the mushaf words for a misquote, the grown-up step's ask line said once by the voice (never on Repeat) and its outline "Show" button. Online: when the API answers `401 access_required` (a new access code), the app reloads once to the server's code page instead of showing "server down". Privacy texts: in each of the four ways the app runs (`PRIVACY_MODES`: local or online, with or without Claude, from the fake `/api/health` `online` and `brain`), the setup's consent box (its two lines) and family data line in en, fr and ar, the photo note of Prepare and the "approximate" label of Recite; online, no local-only sentence ("nothing leaves this computer", ...) anywhere on the page; a page loaded from a host that is not a loopback one counts as online even when `/api/health` says `"online": false`; the privacy strings in en, fr and ar (online ones name the server; no Arabic word ending in ـك). The AI consent (privacy audit P1, P3-P5): its strings in en, fr and ar (the storage sentences name Mommy and claim nothing about Claude, online without Claude "no outside AI service such as Claude", the child's line asks for a grown-up); in each of the four ways the app runs, the setup's AI box only under the Claude notice, the general consent alone never covering Claude (with Claude: the page photo, Recite and the typed dictation check stay off with the child's line, nothing sent; "Confirm text", the voice and the Quran section work; without Claude everything works), the parent's prompt behind the PIN opening them; Claude added while the page is open (the check of `/api/health` before a Claude call sends nothing, "Nothing was sent.", the texts and Settings follow, a reload keeps it). |
| `node tests/web/family.cjs` | The family UI (`web/family.js`): setup, "Who is learning?", the parent area (children; tasks of each kind with the server checks of the text; tasks with Quran in a school text: word by word only, dictation with the grown-up step, the differences from the mushaf before saving, "Create a Quran task with these ayat"; To review with Confirm, "Not yet: try again" and its note, and "Confirm anyway" in a task's details; Rewards with goals, "Give", a surprise, rewards marked "Given", "Adjust stars" and the history; Settings with the PIN change, the parent's language and "delete all data"), the task runner (recite, dictation with "Confirm the task now", Quran), the child's home (surprise once, the note of a task sent back, the Done shelf), the motivation rules, the PIN backoff and "Forgot PIN" (a two-digit multiplication in words; wrong answers pause it; hidden while the PIN pauses; Cancel keeps the old PIN; the reset notice), the parent area locking after 3 minutes and when the page is hidden, a second tab saving during a slow PIN check, seeded tasks with Quran in a school text (a task by meaning that cannot be done and "Recite word by word", the edit form and details with the parts, a misquote shown with the mushaf words, the dictation's paper notes, the grown-up line on a To-do card, one message for meaning and differences), archive and goal removal asked in place, setup errors under their field, v1 migration (the gate before the first PIN), corrupt and repaired documents, a full storage, two tabs, the Arabic UI at 360 px, dark mode, the script-order handshake, the privacy texts of the parent area in the four ways the app runs (`PRIVACY_MODES`: Settings' family data line and consent box, the task form's photo note, in en, fr and ar; online, no local-only sentence on the page), the AI consent (a document saved before the AI box in each of the four ways: with Claude its recite task waits for a grown-up while its Quran task works, the parent is asked once and the Settings box counts at once; without Claude nothing changes; Settings: the AI box needs the general one, unticking the general one withdraws both, the AI box alone only Claude, the task form's photo says why, "Not now"; Claude added later, local and online, with a reload: the prompt opens the recite task and its attempt counts; the prompt in English and Arabic at 360 px with its screenshots), and no `/api/tts` request holding a Quran part. |
| `node tests/web/access.cjs` | The access gate (`web/access.html`, `web/access.js`, `backend/mommy/access.py`) in Chromium against the real `create_app` with `MOMMY_ACCESS_CODE` set, under uvicorn with proxy headers (each context its own `X-Forwarded-For`): the link `/#code=` lands in the app with the fragment gone and an HttpOnly, Lax, 180-day cookie; a reload and a new tab stay in; the link pasted into a tab that shows the code page (`hashchange`); a wrong code from the link and typed, in en, fr and ar at 360 px (RTL, focus, no overflow, no small targets); typing the code with Enter and with Arabic-Indic digits; the 11th try asks to wait (ar, fr); a starting app (503: the link's code is tried again after 20 s, on a fake clock) and a refused connection ("Enter" with an empty field tries the link's code), in ar, fr and en; in the app, the consent box from the real `/api/health` (`"online": true` with the gate on, the offline brain: the recordings and texts go to this server, nothing to an AI service, never "nothing leaves this computer") in en, fr and ar; the statuses without the cookie; no external request; the server log never holds the code, a typed code or the cookie. |

Screenshots (optional): `MOMMY_SHOTS_DIR=/some/dir node tests/web/smoke.cjs` (or
`family.cjs`).

## Shared helpers (`helpers.cjs`)

- Harness: `check(name, fn)`, `finish()` (summary and exit code), `sleep`.
- `startServer()`: a static server for `web/` on a free port.
- Binary helpers: `parseMultipart`, `parseWav`, `silentWav`, `jpegSize`, `withExif`.
- Quran data: `loadTanzil()` then `ayah(surah, a)` (verbatim Tanzil files, read only).
- `makeFakeApi(opts)`: every `/api/*` endpoint, contract-shaped. `/api/text/check` and
  `/api/dictation/phrases` run the checks of the contract in their order (`empty_text`,
  `bad_text`, `text_too_long`, `unreadable_text`, `quran_text`, `lang_mismatch`).
  Controls: `queueRecite`, `queueDictation` (an answer, or a function of the request,
  for example to echo `written_text` exactly as the browser sent it, with `\r\n`),
  `queueQuran('perfect')`, `refuse(path, on)`,
  `unreachable(path, on)`, `setTts({delay, check, refuse})` (`refuse(json)`: the voice
  refuses that phrase as Quran), `setPageRead`, `setUnmarked(fn)` (the server's dictation
  safety net fires for those texts: `"dictation": false`), `setHealthDown`, `setHealth`
  (merged into the `/api/health` answer, e.g. `{brain: 'claude'}`: Claude set up later),
  `setAccessRequired(on)` (every call answers `401 access_required`, as the access gate
  does for an old cookie), `callsTo(path)`, `ttsFor(text)`. The Quran check carries `first_error`, `n_errors`,
  `n_expected` and `word_accuracy` (rewards.js needs them).
- Quran in a school text (`docs/CONTRACT.md`, hard rule 4): `fakeQuranAnalysis(text,
  lang)` finds the references of `FAKE_QURAN_REFS` (the basmala, 2:153, 112:1-4) from the
  verbatim Tanzil words, verbatim or with one letter changed or one word dropped, and
  answers with the server's shapes: `quran_parts` (every field of a part), `mushaf_text`,
  a text that is Quran (Q1) with `quran_range`, the dictation plan (`readers`,
  `read_text`, `parts`) and the expected words of a check. Every endpoint uses it: Q1 is
  refused everywhere, mode `contextual` refuses Q2, `/api/tts` refuses any phrase that
  holds Quran, `/api/page/read` decides `contains_quran` from the text read, and strict
  recite and dictation answers carry `feedback_is_quran` and `quran_parts`.
  `quranFixtures()` builds the texts (a lesson quoting 2:153, the same misread and with a
  word dropped, the basmala as a sentence and on a line of its own, 112:1-4 framed and
  bare, an ordinary sentence); smoke.cjs checks that the fake's answers are exactly the
  server's (`guard.find_quran_parts`) on them when the backend's Python is there.
  `quranStrictResult(text, wrong, feedback, quran, kind)` builds a recite or dictation
  result for such a text. Every part a fake answers with is remembered:
  `holdsQuranPart(text)` and `ttsQuranLeaks()` (the `/api/tts` requests of every fake
  that held one; both suites assert it is empty at the end).
- Results: `strictResult(text, wrongIndexes, feedback)`, `STRICT_RESULT`,
  `CONTEXTUAL_RESULT`, `SAY_AGAIN_RESULT`, `DICTATION_RESULT`, `fakeQuranCheck`.
- Pages: `newPage(browser, base, viewport, fakeOpts, {initScript, initArg, colorScheme})`
  returns `{context, page, fake, problems}`; `problems` collects console errors, page
  errors and requests to any other host. `watchPage` does the same for a second tab.
  `noHorizontalScroll`, `overflowing` (elements out of the viewport), `smallTargets`
  (controls under 44 x 44 px), `shot`, `shotEl`, `record`, `waitForCall`, `waitForTts`,
  `expected4xx`.
- Privacy texts: `PRIVACY_MODES` (local or online, with or without Claude, and the
  string keys each one shows), `privacyHealth(mode)` (the fake's `/api/health`),
  `localOnlySentences()` (sentences that are false online, in every language) and
  `localSentencesShown(page)` (those found anywhere on the page, hidden nodes included).
- Strings: `uiStrings(lang, file)` and `allStrings(lang)` (app.js and family.js) for the
  wording checks.
- Family: `PIN`, `setupFamily(page, {lang, childLang, consent, aiConsent, nickname, age,
  avatar, pin})` (`aiConsent`, by default as `consent`, ticks the AI box when Claude is
  set up) (setup errors now stand under their field: `#setup-pin-err`, `#setup-pin2-err`,
  `#nickname-err`), `enterPin`, `openParent` (the parent area opens on To review when a task
  waits there, else on Tasks; on Settings without consent), `parentSection`,
  `closeParent`, `setChildLang`, `setConsent(page, on, {ai})` (ticked: also the AI box
  when it shows, unless `ai: false`; unticked: both consents go), `storedDoc`.

## Inside `family.cjs`

- Seeded documents are built with `web/rewards.js` in Node and written to
  `localStorage` once per tab by `seedScript` (an init script): `arabicDoc()` (an Arabic
  child with a goal, stars, tasks and a surprise), `arabicParentDoc()` (the same plus a
  second child whose Quran task waits for review) and `rewardsDoc()` (an English family:
  a task never passed, a reward to give, goals, corrections, a task to review).
- `quranSeededFlow` seeds an Arabic child's tasks with Quran in a school text (a task by
  meaning saved before the rule, a recite task with a misquote, dictations with and
  without Quran parts); `pinTabsFlow` slows the PIN hashing in one tab (`slowHash`) while
  another tab adds a child; `gateAnswer(page)` answers the "Forgot PIN" question in words.
- `settle(page)` waits for the page's animations (the surprise card) before a
  screenshot; `ownText(sel)` is the visible text without what people typed (`<bdi>`),
  for the "no Western digit in the Arabic UI" checks.
- Screenshots (with `MOMMY_SHOTS_DIR`): every parent section and the child's home at
  360 px in English and Arabic, and the parent sections in dark mode; the AI consent
  prompt (`ai-prompt-{en,ar}-360`) and the child's line (`ai-consent-child-{en,ar}-360`).

# Web client tests

Run from `mommy/`. The browser tests need Node.js and Playwright with Chromium (already
installed here: `require('playwright')` works). `rewards.test.cjs`, `smoke.cjs` and
`family.cjs` start no backend; `access.cjs` starts the real app (with fake speech
components) through `.venv/bin/python` on a free loopback port and stops it, then once
more with a fake Claude brain for the server's part in the AI consent. Each file
exits with 0 when every check passes and prints one line per check.

```sh
node tests/web/rewards.test.cjs   # about 20 s; also runs with: node --test tests/web/rewards.test.cjs
node tests/web/smoke.cjs          # about 1 to 2 min
node tests/web/family.cjs         # about 1 min
node tests/web/access.cjs         # about 15 s: the access gate of an online deployment
```

| Command | What it checks |
|---|---|
| `node tests/web/rewards.test.cjs` | `web/rewards.js` in Node, no browser: every state transition, the pass rules (a Quran check result never counts for a school task), stars and ledger, goals, surprises, migration, `validateDoc` (repair notes of inherited keys), the PIN: hashing, the pause, `checkPin`/`applyPinCheck` apart from the document (failures in several tabs all count, a stale check does not apply), `setPinRecord` with `pinResetAt`, gate answers in the pause, the AI consent (`aiConsentVersion`, `hasAiConsent`: the general consent never sets it, it needs the general one, withdrawing the general one withdraws both, an old document's `aiConsentAt` without a version is read without a repair and never counts until the parent ticks the AI box again; a consent of version 1, given to the notice without the score, the language and the age group, no longer counts and is replaced by the current version when ticked again), and a copy of the family list (`makeFamilyCopy`, `readFamilyCopy`, `useFamilyCopy`, `familySummary`: the round trip keeps the whole family and this device's parent; the file holds no PIN salt or hash, backoff, reset, consent or language; every refusal, `too_big` at 2 MB of UTF-8 bytes (not characters), `not_copy` (also a photo of 1.5 MB, decided before the size is counted), `newer_version`, `damaged` (also a family without the lists a copy always has, children all invalid, or over 2 MB once checked, so a loaded copy can always be saved again), `empty` (a family with no child), and never a throw; `__proto__` and `constructor` keys at every level pollute nothing; the family is repaired exactly as `validateDoc` repairs stored data, with the repairs reported) (also runs with `node --test`). |
| `node tests/web/smoke.cjs` | The existing screens (Prepare, Recite, Dictation, Quran) through the v2 start (family setup), "Confirm text" with `/api/text/check`, Quran in a school text (Q1 and Q2: the note and the differences from the mushaf at "Confirm text" and from a page photo, "Use the mushaf text", Recite word by word only with Quran feedback never spoken, the dictation's grown-up step in the middle and at the start, Repeat, keyboard and focus, the voice-refusal safety net, a text that is Quran opening the Quran section on its ayat; en, fr and ar at 360 px and dark mode), the fake's Quran parts against the server's finder, the Arabic wording of `app.js` and `family.js`, French typography (a no-break space before : ; ! ? and inside « »), 360 px, dark mode, no external requests, and no `/api/tts` request holding a Quran part. Since the review fixes also: the differences against the standard spelling with the changed letter marked, the part's first and last words, the Recite card with the mushaf words for a misquote, the grown-up step's ask line said once by the voice (never on Repeat) and its outline "Show" button. Online: when the API answers `401 access_required` (a new access code), the app reloads once to the server's code page instead of showing "server down". Privacy texts: in each of the four ways the app runs (`PRIVACY_MODES`: local or online, with or without Claude, from the fake `/api/health` `online` and `brain`), the setup's consent box (its two lines) and family data line in en, fr and ar, the photo note of Prepare and the "approximate" label of Recite; online, no local-only sentence ("nothing leaves this computer", ...) anywhere on the page; a page loaded from a host that is not a loopback one counts as online even when `/api/health` says `"online": false`; the privacy strings in en, fr and ar (online ones name the server; no Arabic word ending in ـك). The AI consent (privacy audit P1, P3-P5): its strings in en, fr and ar (the storage sentences name Mommy and claim nothing about Claude, online without Claude "no outside AI service such as Claude", the child's line asks for a grown-up); in each of the four ways the app runs, the setup's AI box only under the Claude notice, the general consent alone never covering Claude (with Claude: the page photo stays off with the grown-up's line; Recite word by word and by meaning, with the "approximate" label and the note under the mode choice, and the typed dictation check work, sent without `ai_consent`, and the fake answers with its offline brain; "Confirm text", the voice and the Quran section work; without Claude everything works), the parent's prompt behind the PIN giving it (each check and the page photo then carry `ai_consent=1`, once; withdrawn in Settings, the next check goes without it); Claude added while the page is open (the checks still go without the field and get the offline answer, nothing reaches Claude; after a reload the texts and Settings show the Claude notice and its box). The server's part (V6): the fake API reads `ai_consent` as the server does (`call.aiConsent`: the values sent; the main flow's page photo, meaning check and paper photo carry `["1"]`), and the server-down flow's Recite goes without it until the AI consent is given. The second check of the AI consent (V1-V5): every value that `backend/mommy/llm.py` puts into a Claude request is named in the Claude notice in en, fr and ar (a new one fails), and the notice's fingerprint is recorded for the current `AI_CONSENT_VERSION` (a changed notice fails until the version is raised); the family data line says what a Quran check sends and what the server log notes; the cards for the grown-up (Prepare, the dictation's check stage) say `consent_needed_ai_grownup` (only their photos wait for the OK); with Claude, the photo note says where the photos go (`photo_privacy_claude`, `photo_privacy_online_claude`). |
| `node tests/web/family.cjs` | The family UI (`web/family.js`): setup, "Who is learning?", the parent area (children; tasks of each kind with the server checks of the text; tasks with Quran in a school text: word by word only, dictation with the grown-up step, the differences from the mushaf before saving, "Create a Quran task with these ayat"; To review with Confirm, "Not yet: try again" and its note, and "Confirm anyway" in a task's details; Rewards with goals, "Give", a surprise, rewards marked "Given", "Adjust stars" and the history; Settings with the PIN change, the parent's language and "delete all data"), the task runner (recite, dictation with "Confirm the task now", Quran), the child's home (surprise once, the note of a task sent back, the Done shelf), the motivation rules, the PIN backoff and "Forgot PIN" (a two-digit multiplication in words; wrong answers pause it; hidden while the PIN pauses; Cancel keeps the old PIN; the reset notice), the parent area locking after 3 minutes and when the page is hidden, a second tab saving during a slow PIN check, seeded tasks with Quran in a school text (a task by meaning that cannot be done and "Recite word by word", the edit form and details with the parts, a misquote shown with the mushaf words, the dictation's paper notes, the grown-up line on a To-do card, one message for meaning and differences), archive and goal removal asked in place, setup errors under their field, v1 migration (the gate before the first PIN), corrupt and repaired documents, a full storage, two tabs, the Arabic UI at 360 px, dark mode, the script-order handshake, the privacy texts of the parent area in the four ways the app runs (`PRIVACY_MODES`: Settings' family data line and consent box, the task form's photo note, in en, fr and ar; online, no local-only sentence on the page), the AI consent (a document saved before the AI box in each of the four ways: with Claude its recite task is sent without `ai_consent` while its Quran task works, the parent is asked once and the Settings box counts at once; without Claude nothing changes; Settings: the AI box needs the general one, unticking the general one withdraws both, the AI box alone only Claude, the task form's photo says why, "Not now"; Claude added later, local and online, with a reload: the recite task does not wait, the prompt gives the AI consent and the next attempt carries it and counts; with Claude, local and online, and no AI consent, the task form's "approximate" note for a check by meaning, hidden at once by the prompt's OK and back after the AI box is unticked; a consent of version 1 with Claude, local and online: the recite task and the typed check do not wait for it, the dictation task's photo shows the grown-up's line, and the prompt asks again under the full notice; the prompt in English and Arabic at 360 px with its screenshots), a copy of the family list ("Save a copy" in Settings: a download through a Blob URL under the page's CSP, named `mommy-family-YYYY-MM-DD.json` with the device's date, the family without the PIN or the consents, no request; "Load a copy" in Settings: the summary, Cancel, a repaired copy said, "Replace" with the PIN, the consents and the language unchanged, another tab following; the refusals in en, fr and ar; its file picker hiding the page does not lock the parent area, any other hiding does, and so does the next hiding after a picker that did not hide the page (a file chosen, `cancel`, the window's `focus`); with a full storage "Replace" keeps the question open and the list as stored, and "Let's start" with a copy keeps the setup; "Save a copy" of a family with no child says there is nothing to save (fr, ar, en); at the setup of a second address (another port in the same browser): the refusals, the summary in Arabic and English, "Do not use this copy", the PIN still asked, the copy's family with the consent and a PIN of the new address; dark mode; the copy's note in the four ways the app runs), and no `/api/tts` request holding a Quran part. |
| `node tests/web/access.cjs` | The access gate (`web/access.html`, `web/access.js`, `backend/mommy/access.py`) in Chromium against the real `create_app` with `MOMMY_ACCESS_CODE` set, under uvicorn with proxy headers (each context its own `X-Forwarded-For`): the link `/#code=` lands in the app with the fragment gone and an HttpOnly, Lax, 180-day cookie; a reload and a new tab stay in; the link pasted into a tab that shows the code page (`hashchange`); a wrong code from the link and typed, in en, fr and ar at 360 px (RTL, focus, no overflow, no small targets); typing the code with Enter and with Arabic-Indic digits; the 11th try asks to wait (ar, fr); a starting app (503: the link's code is tried again after 20 s, on a fake clock) and a refused connection ("Enter" with an empty field tries the link's code), in ar, fr and en; in the app, the consent box from the real `/api/health` (`"online": true` with the gate on, the offline brain: the recordings and texts go to this server, nothing to an AI service, never "nothing leaves this computer") in en, fr and ar; the statuses without the cookie; no external request; the server log never holds the code, a typed code or the cookie; after a text check and a typed dictation check, the log notes the language and the kind of check but never the words of the text or the age group (what `fam_privacy_line` says). The server's part in the AI consent (V6), against a second real app whose brain is a fake Claude brain (it logs only the name of each method called): requests built as an older client builds them (no `ai_consent`), and with `ai_consent=0`, with the field in the query string only, and with `1` beside `0`, are answered by the offline brain for all five requests that can reach it (typed dictation check, paper photo `501 needs_manual`, page photo, recitation word by word and by meaning, approximate), and the fake is never called; with `ai_consent=1` it answers each of them; that app's log names the brain of each check, never the text, the age group or the code. |

Screenshots (optional): `MOMMY_SHOTS_DIR=/some/dir node tests/web/smoke.cjs` (or
`family.cjs`).

## Shared helpers (`helpers.cjs`)

- Harness: `check(name, fn)`, `finish()` (summary and exit code), `sleep`.
- `startServer()`: a static server for `web/` on a free port.
- Binary helpers: `parseMultipart`, `parseWav`, `silentWav`, `jpegSize`, `withExif`.
- Quran data: `loadTanzil()` then `ayah(surah, a)` (verbatim Tanzil files, read only).
- `makeFakeApi(opts)`: every `/api/*` endpoint, contract-shaped. `/api/text/check` and
  `/api/dictation/phrases` run the checks of the contract in their order (`empty_text`,
  `bad_text`, `text_too_long`, `unreadable_text`, `quran_text`, `lang_mismatch`). The
  AI consent as the server reads it: each call has `aiConsent`, the values of the form
  field `ai_consent` sent (`parseMultipart(...).all` keeps a name sent twice); only
  `["1"]` (every copy `"1"`) with `/api/health` `"brain": "claude"` lets "Claude" answer,
  else the answers are the offline brain's (`"brain": "offline"`, an approximate meaning
  check, a page photo with no text, `501 needs_manual` for a paper photo).
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
  prompt (`ai-prompt-{en,ar}-360`), Recite without the AI consent (`ai-consent-child-{en,ar}-360`) and
  the dictation's check stage of a consent of version 1 (`ai-consent-v1-dict-check-en-360-{local,online}`);
  a copy of the family list (`family-copy-settings-{en,ar}-360`, `family-copy-confirm-{en,ar}-360`,
  `family-copy-error-ar-360`, `family-copy-setup-{en,ar}-360`, `family-copy-setup-dark-360`).

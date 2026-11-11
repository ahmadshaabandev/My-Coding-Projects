# Web client tests

Run from `mommy/`. The browser tests need Node.js and Playwright with Chromium (already
installed here: `require('playwright')` works); they start no backend.

| Command | What it checks |
|---|---|
| `node tests/web/rewards.test.cjs` | `web/rewards.js` in Node, no browser: every state transition, the pass rules, stars and ledger, goals, surprises, migration, `validateDoc`, the PIN (also runs with `node --test`). |
| `node tests/web/smoke.cjs` | The existing screens (Prepare, Recite, Dictation, Quran) through the v2 start (family setup), "Confirm text" with `/api/text/check`, the Arabic wording of `app.js` and `family.js`, 360 px, dark mode, no external requests. |
| `node tests/web/family.cjs` | The family UI (`web/family.js`): setup, "Who is learning?", the parent area (children, tasks of each kind with the server checks of the text), the task runner (recite, dictation with "Confirm the task now", Quran), the PIN backoff and "Forgot PIN", v1 migration, corrupt and repaired documents, a full storage, another tab, the Arabic UI at 360 px, the script-order handshake. |

Screenshots (optional): `MOMMY_SHOTS_DIR=/some/dir node tests/web/smoke.cjs` (or
`family.cjs`).

## Shared helpers (`helpers.cjs`)

- Harness: `check(name, fn)`, `finish()` (summary and exit code), `sleep`.
- `startServer()`: a static server for `web/` on a free port.
- Binary helpers: `parseMultipart`, `parseWav`, `silentWav`, `jpegSize`, `withExif`.
- Quran data: `loadTanzil()` then `ayah(surah, a)` (verbatim Tanzil files, read only).
- `makeFakeApi(opts)`: every `/api/*` endpoint, contract-shaped. `/api/text/check` and
  `/api/dictation/phrases` run the checks of the contract in their order (`empty_text`,
  `bad_text`, `text_too_long`, `unreadable_text`, `quran_text`, `lang_mismatch`); the
  basmala as a phrase or as a line of its own gives `"dictation": false` and
  `"contextual": false`, `422 quran_text` in mode `contextual`, and `scope: "phrase"` in
  mode `dictation` (as the real server does). Controls: `queueRecite`, `queueDictation`,
  `queueQuran('perfect')`, `refuse(path, on)`, `unreachable(path, on)`, `setTts`,
  `setPageRead`, `setHealthDown`, `callsTo(path)`, `ttsFor(text)`. The Quran check carries
  `first_error`, `n_errors`, `n_expected` and `word_accuracy` (rewards.js needs them).
- Results: `strictResult(text, wrongIndexes, feedback)`, `STRICT_RESULT`,
  `CONTEXTUAL_RESULT`, `SAY_AGAIN_RESULT`, `DICTATION_RESULT`, `fakeQuranCheck`.
- Pages: `newPage(browser, base, viewport, fakeOpts, {initScript, initArg, colorScheme})`
  returns `{context, page, fake, problems}`; `problems` collects console errors, page
  errors and requests to any other host. `watchPage` does the same for a second tab.
  `noHorizontalScroll`, `overflowing` (elements out of the viewport), `smallTargets`
  (controls under 44 x 44 px), `shot`, `shotEl`, `record`, `waitForCall`, `waitForTts`,
  `expected4xx`.
- Strings: `uiStrings(lang, file)` and `allStrings(lang)` (app.js and family.js) for the
  wording checks.
- Family: `PIN`, `setupFamily(page, {lang, childLang, consent, nickname, age, avatar,
  pin})`, `enterPin`, `openParent`, `parentSection`, `closeParent`, `setChildLang`,
  `setConsent`, `storedDoc`.

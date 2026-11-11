# Mommy: a recitation and dictation tutor (prototype)

Mommy is a web prototype of a tutor that stands in for a parent while a child (6 to 18
years old) practises school lessons in **Arabic, English or French**:

- **Prepare a page.** The parent photographs a textbook page (read by Claude when it is
  configured) or types or pastes the text, then confirms it.
- **Recite.** The child reads the text aloud. *Strict* mode checks it word by word;
  *contextual* mode checks that the meaning is right. Mistakes are highlighted and the
  feedback can be spoken.
- **Dictation.** The app reads the text out slowly, one phrase at a time, and the child
  writes on paper. The parent then photographs the page or types what the child wrote.
  The result goes to the parent to confirm before the child sees it.
- **Quran.** A separate section for Quran recitation (Hafs), checked strictly against
  the verbatim Tanzil text, with a "where am I?" search for recitation from memory.
  It uses no AI model and no synthetic voice.

It is an AI, not a person, and the app says so at the start of each session.

How it works, in one paragraph: the browser records 16 kHz WAV and resizes photos; the
FastAPI backend (`backend/mommy`) runs speech recognition locally (Whisper through
sherpa-onnx), compares words with deterministic code (`align.py`), and speaks with local
Piper voices. Claude, when configured, only reads images, judges meaning in contextual
mode and words the feedback. Module boundaries, the HTTP API and the hard rules are in
[`docs/CONTRACT.md`](docs/CONTRACT.md).

## Privacy rules

- **The recogniser is never given the expected text** (no prompt, no hotwords). Whether
  a word is wrong is decided by code, never by an AI model.
- **Handwriting is read blind.** The model that reads the child's paper is never shown
  the expected text; code compares, and the parent confirms.
- **Audio and photos stay in memory.** Uploads are never written to disk: request bodies
  are size-limited before they are parsed, and the upload parser's spill-to-disk
  threshold is raised above that limit (checked by `tests/test_api.py`). They are never
  logged; logs carry only sizes, durations and timings.
- **Photos are cleaned.** The browser resizes them (long edge at most 2000 px) and
  re-encodes them as JPEG, which drops EXIF data such as a GPS position. The server
  decodes and re-encodes every image again, in memory, as a new JPEG of at most 2000 px
  with no metadata at all (EXIF, XMP, IPTC, ICC profile, comments, PNG text, data after
  the image), so a client that bypasses the web page cannot pass any on either.
- **Local by default.** The server listens on `127.0.0.1` only, answers only to its own
  host names (`MOMMY_ALLOWED_HOSTS`, default `127.0.0.1,localhost,::1`, which blocks
  DNS-rebinding pages) and refuses cross-origin writes to the API and framing by other
  sites. The web client makes no external requests: no analytics, no third-party
  scripts, no web fonts from CDNs.
- **Claude is optional.** Only when it is configured are page photos, handwriting photos
  and texts sent to the Claude API, and only after the parent ticks the consent box. The
  Batch and Files APIs are never used.
- **Consent first.** A parent must tick a consent box before the camera or microphone is
  used. The child profile (nickname, age band, language) is kept in the browser's
  `localStorage` only; there are no accounts.
- **Quran.** Text comes only from the verbatim Tanzil files in `data/quran/`. No AI
  model and no synthetic voice is used on any Quran path, and feedback uses fixed
  templates. The general endpoints refuse Quran text (`422 quran_text`) and point to the
  Quran section.

## Quick start

Requirements: Python 3.13, `curl`, `tar` with bzip2, about 1 GB of disk for the models,
about 6 GB of RAM with the three recognisers loaded, and a recent browser.

```sh
cd mommy
python3 -m venv .venv
.venv/bin/pip install --require-hashes -r requirements.lock   # every package pinned and hashed
scripts/download_models.sh     # Whisper turbo (537 MB) + Piper voices ar/en/fr (64 MB each)
./run.sh                       # serves the API and the web client
```

Then open <http://127.0.0.1:8080>. Browsers allow the microphone on `127.0.0.1` and
`localhost` without HTTPS.

- `PORT=9000 ./run.sh` uses another port.
- `scripts/download_models.sh --small` also fetches Whisper small (609 MB); select it
  with `MOMMY_ASR_MODEL=small`. `--check` only checks that the download URLs answer.
  The script skips models that are already in `models/` (a symlink is fine).
- Turbo is the default recogniser: on a 4-core CPU it is as fast as small once loaded
  (about 1.5 s for a 5 s clip), and markedly better on Arabic and on French homophones
  (small heard "dort" as "d'or"); it needs about 1 GB more RAM per loaded language
  (server RSS about 5.0 GB with turbo, 3.2 GB with small). If the configured model's
  files are missing but the other model is present, the other one is used, logged, and
  reported by `/api/health` as `asr_model`.
- `requirements.txt` lists the direct dependencies; `requirements.lock` pins and hashes
  every package. After changing `requirements.txt`, install it and run
  `.venv/bin/python scripts/lock_requirements.py` (it reads the hashes from PyPI;
  `--check` only compares).
- `GET /api/health` shows which parts are available.

### Speech synthesis needs espeak-ng

sherpa-onnx 2.x no longer bundles the espeak-ng phonemizer that the Piper voices need.
Without one, `/api/health` reports `"tts": false`, and the UI disables the spoken
dictation and spoken feedback. `requirements.txt` therefore installs
`espeakng-loader==0.2.4`, a wheel that bundles libespeak-ng 1.52 (GPL-3.0-or-later). It
was tested end to end here: all three voices speak, slow dictation phrases pass the
recogniser check, and `tests/test_speech.py` runs the espeak-ng back end. The system
library works too:

```sh
sudo apt install libespeak-ng1          # instead of the wheel
```

## Offline mode

With no Claude configuration the app runs fully offline:

- the parent types the page text and what the child wrote (a photo of the child's
  writing gets `501 needs_manual`);
- contextual mode uses a content-word overlap heuristic, marked `"approximate": true`;
- feedback comes from fixed, age-adapted templates in each language.

If the Whisper or Piper files are missing, `/api/health` says so and the UI hides those
features; the server still starts.

## Enabling Claude

```sh
export ANTHROPIC_API_KEY=...       # your API key; never commit it
export MOMMY_VISION_MODEL=<a vision-capable Claude model id from the Claude docs>
export MOMMY_TEXT_MODEL=<a Claude model id from the Claude docs>
export MOMMY_EFFORT=low            # low (default), medium, high, xhigh or max
./run.sh
```

All three of the key and the two model variables must be set; otherwise the app stays
offline. Model ids are never written in this repository: pick current ones from the
Claude documentation. If a Claude call fails, the app falls back to the offline
behaviour for that request.

Output ceilings: `max_tokens` is 16000 for reading images and 4000 for text calls. On
current models adaptive thinking is on by default and its tokens count toward
`max_tokens` even when they are not returned, so lower caps could cut off a dense page
and force the offline fallback; the ceiling is not a cost (billing is for tokens used).
No `thinking` parameter is sent.

Other settings: `MOMMY_ASR_MODEL` (`turbo`, default, or `small`), `MOMMY_ASR_THREADS`
(default 4), `MOMMY_ALLOWED_HOSTS` (default `127.0.0.1,localhost,::1`),
`MOMMY_LOG_LEVEL` (default `INFO`), `PORT` (default 8080).

## API notes

The endpoints are listed in [`docs/CONTRACT.md`](docs/CONTRACT.md). Errors are
`{"error": <code>, "message": <text>}`; every `/api/*` response has
`Cache-Control: no-store`. Limits: audio 10 MB and 120 s at 8-96 kHz, images 8 MB (JPEG
or PNG, at most 4096 x 4096 pixels, 50 MP for a JPEG), text fields 20 000 characters
and 3 000 words, `/api/tts` 400 characters, 50 ayat per Quran request. At most two image
or audio decodes run at once (`503 busy` after 30 s). Beyond the contract:

- `/api/health` also returns `tts_languages`, `asr_model` (the Whisper model in use)
  and `reasons` (why the recogniser or the voices are unavailable).
- `/api/recite/check` returns a top-level `say_again`; results carry
  `say_again_reason` (`empty` or `error_rate`), `stopped_at_exp_index` (where the child
  stopped early) and `n_unreadable`. `/api/page/read` returns `contains_quran`,
  `unreadable_marks` (`[?]` where a word could not be read) and, when Claude failed,
  `brain_error`; `/api/dictation/check` returns `legible`, accepts an optional
  `strict_tashkeel` field, and lists `[?]` in `uncertain_words` when a written word
  could not be read (it is shown as a substitution, never as a skipped word).
- Text refused on the general endpoints: `400 unreadable_text` (the text still has `[?]`
  marks), `400 bad_text` (a lone UTF-16 surrogate), `422 lang_mismatch` (an Arabic text
  with `lang` en/fr, or a text without Arabic letters with `lang` ar: the recogniser
  would translate the speech).
- `400 bad_host` for an unknown `Host` header, `403 bad_origin` for a cross-origin
  write; responses carry `X-Frame-Options: DENY` and `Content-Security-Policy:
  frame-ancestors 'none'`.
- `/api/quran/check` returns the extra fields of `Quran.check` (`words` for
  highlighting, `tolerated`, `n_expected`, `n_errors`, `word_accuracy`), plus
  `quality`, `riwaya`, `attribution` and `source_url`; `/api/quran/surahs` includes the
  Tanzil `licence` text.
- Slow `/api/tts` speech (dictation) is transcribed back, unprompted, to check that it
  says exactly the phrase (up to two takes); the `X-Speech-Check` header says `passed`,
  `failed` or `skipped`.
- Quran text sent to a general endpoint (recite, dictation, TTS) is refused with
  `422 quran_text`. Framing formulas (قال تعالى, صدق الله العظيم, ...) are left out, then
  the text is refused when it is in Uthmani script, holds a run of 5 consecutive words
  found consecutively in the Quran (3 next to a framing formula, so a quoted ayah inside
  a school text is caught), or has at least 4 words found almost entirely (90%) in order
  at one place. A TTS phrase or dictation phrase that is a whole ayah of 2 words or more
  is refused too; `/api/dictation/phrases` then adds `"scope": "phrase"`, and the web
  client confirms such a text (for example a school text with the basmala on a line of
  its own) for reciting only.

What counts as the same word:

- Speech (recitation and the slow-dictation audio check): a number in digits matches
  the same number in words, 0 to 100 (`12` / twelve / douze / اثنا عشر, `21` / vingt et
  un / واحد وعشرون, `1er` / premier); British spellings match American ones (colour /
  color, centre / center, realise / realize) and contractions match their full form
  (they're / they are); same-sound Arabic hamza spellings match (رءوف / رؤوف, مسئول /
  مسؤول, مائة / مئة). Among alignments of equal cost, the one that keeps the most words
  matched is reported.
- Dictation: spelling counts, so all of these are differences (only Arabic-Indic and
  Western digits are the same).
- Feedback follows the result: one mistake or several ("a few words were not right, the
  first one is ..."), where the child stopped early, and "say it louder" only when
  nothing usable was heard (a clear recording far from the text is asked to read again
  from the start; a misspelled dictation is never "unclear").

## Tests

```sh
.venv/bin/python -m pytest -q
```

The suite covers every module and every endpoint (fakes for speech and Claude, the real
Quran text). Integration tests with the real Whisper and Piper models skip cleanly when
the models are missing. The web client has a separate smoke test that needs Node.js and
Playwright with Chromium: `node tests/web/smoke.cjs` (see `tests/web/README.md`).

## Limitations

- **Arabic speech recognition is weak.** Whisper turbo has a word error rate of about
  40% on public Arabic benchmarks, and small is worse. Expect words reported as wrong
  that the child said correctly, and treat Arabic word-level results as hints for the
  parent. Clips with more than 60% errors (not counting the words after the point
  where the child stopped) are answered with "read it again from the start".
- **Not tested on children.** The recognisers were trained mostly on adult speech; no
  evaluation with children's voices has been done.
- **Voice licences.** The Arabic Piper voice (`ar_JO-kareem-medium`) gives its dataset
  licence only as "See URL" (<https://github.com/AliMokhammad/arabicttstrain/>): check it
  before any public use. The English voice (`en_US-lessac-medium`) uses the Blizzard 2013
  Lessac data under its own licence
  (<https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html>);
  the French voice (`fr_FR-siwis-medium`) data is CC BY 4.0. See each `MODEL_CARD` in
  `models/`.
- **Quran.**
  - Hafs only (Tanzil Uthmani and Simple-Clean text, version 1.1). The check is word by
    word: it does not judge tajwid or pronunciation beyond what the recogniser writes.
  - The Quran module needs review by qualified religious scholars before any public
    release.
  - The Quran-text guard on the general endpoints is a heuristic.
- **Speech synthesis** needs an espeak-ng phonemizer (see above). The voice output is
  random, so a take can be unclear; slow dictation speech is checked by the recogniser
  for that reason.
- **One user at a time.** The models run on the CPU, one recognition at a time, and at
  most two image or audio decodes at once; this is a single-machine prototype, not a
  hosted service.
- **Quran.** The disjoined letters that open 29 surahs (الم, يس, ...) are accepted when
  recited by their letter names (ألف لام ميم), joined or apart; this was checked with
  typed text only, not with recordings of real recitations.

## Credits and licences

- **Quran text:** Tanzil Project (<https://tanzil.net>), Hafs, Uthmani v1.1 and
  Simple-Clean v1.1, CC BY 3.0, used verbatim. Surah names and ayah counts come from the
  Tanzil metadata file `data/quran/quran-data.js` ("Quran Metadata (ver 1.0), Copyright
  (C) 2008-2009 Tanzil.info", CC BY 3.0). The app shows "Hafs (Tanzil)" with the
  attribution and a link to tanzil.net. The copyright block of `quran-uthmani.txt`,
  verbatim (`quran-simple-clean.txt` carries the same block with its own title line):

  ```text
  # PLEASE DO NOT REMOVE OR CHANGE THIS COPYRIGHT BLOCK
  #====================================================================
  #
  #  Tanzil Quran Text (Uthmani, Version 1.1)
  #  Copyright (C) 2007-2026 Tanzil Project
  #  License: Creative Commons Attribution 3.0
  #
  #  This copy of the Quran text is carefully produced, highly 
  #  verified and continuously monitored by a group of specialists 
  #  at Tanzil Project.
  #
  #  TERMS OF USE:
  #
  #  - Permission is granted to copy and distribute verbatim copies 
  #    of this text, but CHANGING IT IS NOT ALLOWED.
  #
  #  - This Quran text can be used in any website or application, 
  #    provided that its source (Tanzil Project) is clearly indicated, 
  #    and a link is made to tanzil.net to enable users to keep
  #    track of changes.
  #
  #  - This copyright notice shall be included in all verbatim copies 
  #    of the text, and shall be reproduced appropriately in all files 
  #    derived from or containing substantial portion of this text.
  #
  #  Please check updates at: http://tanzil.net/updates/
  #
  #====================================================================
  ```

- **Speech:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache 2.0), OpenAI
  Whisper models (MIT) as exported by sherpa-onnx, Piper voices (licences above), and
  the espeak-ng phonemizer (GPL-3.0-or-later; bundled by `espeakng-loader`).

## Layout

```text
mommy/
  README.md  requirements.txt  requirements.lock  run.sh
  scripts/download_models.sh   fetches the Whisper model(s) and Piper voices into models/
  scripts/lock_requirements.py regenerates requirements.lock (development only)
  docs/CONTRACT.md             module boundaries, HTTP API, hard rules
  data/quran/                  verbatim Tanzil text and metadata (read-only)
  models/                      git-ignored: downloaded models
  backend/mommy/               config, textnorm, align, phrases, feedback, quran, asr, tts, llm, app
  web/                         index.html, app.js, recorder.js, styles.css
  tests/                       pytest suite; tests/web/ has the browser smoke test
```

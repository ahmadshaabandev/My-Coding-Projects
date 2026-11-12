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
  used. The family document (the children's nicknames, age bands and languages, their
  tasks, stars and rewards, the consent and the hashed parent PIN) is kept in the
  browser's `localStorage` (`mommy.data.v2`) on this device only; there are no accounts.
  It holds scores, never recordings, photos or what the child said.
- **Quran.** Text comes only from the verbatim Tanzil files in `data/quran/`. No AI
  model and no synthetic voice is used on any Quran path, and feedback uses fixed
  templates. A text that *is* Quran (whole ayat, framing formulas and labels left out)
  is refused by the general endpoints (`422 quran_text`) and belongs to the Quran
  section. A school text that *includes* Quran keeps its **Quran parts**, which the
  server finds itself: they are checked word by word against the mushaf, read by a
  grown-up (never the voice) in a dictation, never judged by meaning, and their mistakes
  get fixed template feedback that is never written by Claude.

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

## Tasks and rewards

A parent gives each child study tasks and rewards (the full spec and every decision made
while building it are in [`docs/REWARDS.md`](docs/REWARDS.md)):

- **Setting it up.** On the first run the start screen is the family setup: the AI
  disclosure, the consent box, the parent PIN (typed twice) and the first child
  (nickname, age band, language, avatar). After that, every session starts on "Who is
  learning?", with a small "For parents" button. In the parent area (behind the PIN) a
  parent adds children, creates tasks (recite, dictation or Quran, with a pass level,
  stars and an optional reward), reviews the tasks a child passed ("Confirm", or "Not
  yet" with a note), sets star goals, gives surprises, and changes the settings. A task
  is only marked done, and its stars and reward unlocked, when a grown-up confirms it.
- **The PIN is a child lock, not security.** It keeps the parent area for the grown-ups
  on a shared device: after 5 wrong tries it pauses (30 seconds, doubling up to 15
  minutes), "Forgot the PIN?" asks a multiplication question for grown-ups (wrong
  answers count toward the same pause) and keeps the old PIN until a new one is saved,
  and the parent area then shows that the PIN was reset. The parent area locks again
  when it is left, when the app goes to the background and after 3 minutes without use.
  Anyone who can open the browser's developer tools can read or change the data.
- **The data stays in this browser on this device.** Everything is one document in
  `localStorage`; nothing about tasks or rewards is sent to the server. Another browser,
  another device or a private window has its own (empty) data. **Clearing the browser's
  data for this site deletes it** (the children, tasks, stars and rewards), and so does
  "Delete all data on this device" in the parent area's Settings.

## Offline mode

With no Claude configuration the app runs fully offline:

- the parent types the page text and what the child wrote (a photo of the child's
  writing gets `501 needs_manual`);
- contextual mode uses a content-word overlap heuristic, marked `"approximate": true`;
  Prepare and the task form say so under the mode choice ("Without the online AI, the
  meaning check is only approximate."), except for a text with Quran words, which is
  recited word by word only;
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
  stopped early) and `n_unreadable`. `/api/page/read` returns `contains_quran`
  (decided by the server from the text read: true for a page that is Quran, false for a
  school page that quotes ayat), `quran_parts`, `mushaf_text`, `quran_range`,
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
- `POST /api/text/check` (`{"text", "lang", "mode"?}`, mode `strict` by default,
  `contextual` or `dictation`) runs the text checks of the recite and dictation
  endpoints, in their order and with their error codes, without audio, voice or AI, and
  answers `{"ok": true, "words": n, "dictation": bool, "contextual": bool,
  "quran_parts": [...], "mushaf_text": str}`: one call tells "Confirm text" and task
  creation whether the text can be recited word by word, by meaning, and dictated, and
  where its Quran parts are. It answers `503 quran_unavailable` only when the Tanzil
  text is missing and the text is Arabic.
- Quran in school texts (`backend/mommy/guard.py`, numbers in `docs/CONTRACT.md`):
  - A text that **is** Quran: once the framing formulas (قال تعالى, صدق الله العظيم, the
    isti'adha, a basmala at the start) and the surah and ayah labels (سورة الإخلاص, (1),
    [البقرة: 255]) are left out, what remains is whole ayat in mushaf order. Every
    general endpoint refuses it with `422 quran_text`, with `quran_range` (`{surah, from,
    to}`) when it is one range of one surah. So does a word in the Uthmani script that
    cannot be placed in the mushaf.
  - A school text that **includes** Quran (a lesson quoting an ayah or part of one, a
    text starting with the basmala, a short ayah inside a sentence, a partial ayah on
    its own) is accepted. `/api/text/check`, `/api/page/read`, `/api/dictation/phrases`,
    `/api/recite/check` (strict) and `/api/dictation/check` return its `quran_parts`:
    token span, character offsets (also in UTF-16 units), reference, mushaf words in
    Uthmani and Simple-Clean, differences from the mushaf, reading chunks. The server
    recomputes them from the text every time; a client's list is never used.
  - The parts are found with the guard rules (runs of 5 Quran words, runs of 3 next to a
    framing formula, whole ayat, whole short ayat of 3-4 words inside a sentence, the
    90% `locate` rule on the text, its lines and its sentences) and a near match for an
    ayah with a changed, dropped or misread word (one-letter OCR errors, a missing
    hamza). The parent sees the differences, and `mushaf_text` (or a part's
    `replacement`) puts the mushaf words back in one tap; diacritics and the Uthmani or
    standard spelling are not differences.
  - Recitation compares a Quran part with the mushaf words exactly as `/api/quran/check`
    does (no numbers by value, no joined words, letters of the disjoined openings by
    name), and the rest of the text with the usual speech tolerances. Recitation by
    meaning is refused for such a text (`contextual: false`).
  - Dictation: `/api/dictation/phrases` also returns `readers` (`voice` or `grown_up`),
    `read_text` (the vowelled Uthmani chunk a grown-up reads aloud) and `parts`; a Quran
    part is cut into its own chunks of at most six words, never across an ayah. The
    child's writing of a Quran word is accepted in its Uthmani or Simple-Clean spelling
    only. The checks always use the mushaf words, so a child is never corrected towards
    a misquoted ayah. The `"scope": "phrase"` refusal is gone.
  - Feedback about a mistake inside a Quran part comes from fixed, respectful templates
    that quote the mushaf word (`feedback_is_quran: true`: shown, never spoken). When a
    result has any mistake in a Quran part, Claude is not called for its feedback at
    all, so it never receives a Quran word to write about.
  - `/api/tts` still refuses Quran (a whole ayah, a contained short ayah, a run of Quran
    words) and now also a short ayah with one misread or dropped word, a short ayah whose
    first word carries و or ف, and Quran words joined by a hyphen, an apostrophe, a
    tatweel or an invisible character. A refusal by meaning says so (`"reason":
    "meaning"`): the text can be recited word by word. The framed-run rule now counts only next to its formula
    (it starts at most four words after قال تعالى or ends at most four before صدق الله
    العظيم) and leaves the everyday formulas out there: a sentence with the isti'adha no
    longer makes إن شاء الله elsewhere count as Quran.
- Contained-ayah rule: the voice also refuses a phrase that holds a whole ayah of 3 or
  4 words among other words (`قل هو الله أحد` followed by a name, a sentence ending
  with `مالك يوم الدين`), so a short ayah is never spoken inside a sentence. Two-word
  ayat such as `ثم نظر` are ordinary Arabic and count only as a phrase of their own, and
  8 three-word ayat that are everyday Arabic (`فيها كتب قيمة`) are listed by number in
  `quran.EVERYDAY_AYAT`. K = 3 was chosen on 324 ordinary sentences in
  `tests/arabic_school_sentences.txt`: K = 2 refuses 32 of them, K = 3 none (11 without
  the list), and K = 4 lets 1:4 through (numbers in `docs/CONTRACT.md`).
- Recitation by meaning (contextual mode) also refuses a run of 4 consecutive Quran
  words (word by word keeps 5) that does not pass through an everyday formula (بسم
  الله, إن شاء الله, لا إله إلا الله, ...), and a whole ayah of 3 or 4 words anywhere in
  the text, because the meaning of Quran text is never judged by AI. On the 324
  sentences, runs of 3, 4 and 5 refuse 35, 8 and 0 (22, 2 and 0 with the formulas left
  out).

What counts as the same word:

- Speech (recitation and the slow-dictation audio check): a number in digits matches
  the same number in words, 0 to 100 (`12` / twelve / douze / اثنا عشر, `21` / vingt et
  un / واحد وعشرون / إحدى وعشرين, `1er` / premier); British spellings match American ones
  (colour / color, centre / center, realise / realize) and contractions match their full
  form (they're / they are); same-sound Arabic hamza spellings match (رءوف / رؤوف, مسئول /
  مسؤول, مائة / مئة). Among alignments of equal cost, the one that keeps the most words
  matched is reported.
- Speech, Arabic numbers in words: they are compared by value on both sides, so the
  gender and case variants of one number match each other (اثنتا عشرة / اثنا عشر / إثنى
  عشر / اثني عشر, ثلاثة / ثلاث, عشرون / عشرين, واحد وعشرون / إحدى وعشرين, the accusative
  واحدًا / واحد and أربعًا / أربعة, also with و: وأربع / وأربعة). The speech key already
  ignores case endings (tashkeel is dropped), and Whisper writes numbers in the gender it
  prefers, so these differences cannot be put down to the child. Different values still
  differ (ثلاثة / أربعة), and a number of two or three words is matched as a whole (اثنتا
  عشرة never matches اثنا alone); a shorter number inside it is a number of its own
  (ثلاثة عشر heard as ثلاث: عشر is reported as skipped). Some number words are also
  other words: سبع (a beast of prey), خمس (a fifth), تسع (the verb "holds"), عشر (a
  tenth), صفر (the month). On a page with vowel marks that rule the number out (سَبُع,
  خُمُس, تَسَعُ, عُشْر, صَفَر) the word is compared like any other, so سَبُع read as سبعة
  is a mistake; without vowel marks the page cannot tell, the word is taken as the
  number, and such a misreading is accepted. Only number words are affected: measured
  on the Tanzil text, no speech key of its 14,868 distinct Simple-Clean (and 18,994
  Uthmani) words changed, and of 31,179 pairs of ayat (each against itself, the next
  ayah and three random one-word edits) none changed its result. The Quran check does
  not use this: an ayah's number said in another gender stays a mistake.
- Dictation: spelling counts, so all of these are differences (only Arabic-Indic and
  Western digits are the same).
- Feedback follows the result: one mistake or several ("a few words were not right, the
  first one is ..."), where the child stopped early, and "say it louder" only when
  nothing usable was heard (a clear recording far from the text is asked to read again
  from the start; a misspelled dictation is never "unclear").
- Arabic feedback suits a girl or a boy: no imperatives, encouragement as "هيا" with a
  "we" verb (هيا نُحاوِل مِن جَدِيد!), past-tense praise whose last letter carries no vowel
  (أَحْسَنْت). The words the Arabic voice misreads without vowel marks carry them inside
  the word (never on the last letter, where the gender would show), and no spoken message
  ends a word with the suffix ـك, which the voice reads as masculine.

## Tests

```sh
.venv/bin/python -m pytest -q
```

The suite covers every module and every endpoint (fakes for speech and Claude, the real
Quran text). Integration tests with the real Whisper and Piper models skip cleanly when
the models are missing. The Quran guards and the Quran parts are measured on two
fixtures, `tests/arabic_school_sentences.txt` and `tests/quran_parts_texts.txt`, whose
Quran words all come from Tanzil placeholders filled by `tests/quran_fixtures.py` (no
Quran word is typed in them; misquotes are made by code). The web client has three
test files of its own, which need Node.js (the browser ones also Playwright with
Chromium) and start no backend (see `tests/web/README.md`):

```sh
node tests/web/rewards.test.cjs   # web/rewards.js in Node: tasks, stars, goals, PIN, validation
node tests/web/smoke.cjs          # the screens through a fake API, Quran in school texts, wording checks
node tests/web/family.cjs         # the family UI: setup, parent area, tasks, rewards, PIN, storage
```

`smoke.cjs` also compares the fake API's Quran parts with the server's
`guard.find_quran_parts` through `.venv/bin/python` when it is there.

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
  - The Quran parts of a school text are found by measured rules, not by reading the
    text. A short ayah (3 to 7 words) with one changed letter or one dropped inner word is
    found framed or not (measured on every such ayah of Juz' Amma at every word position:
    99.7% framed and 98.3% unframed with a changed letter, 99.0% and 99.5% with a dropped
    word; no hit on the ordinary sentences, 5,000 random pairs of them or the app's Arabic
    strings). Not found: a three-word ayah whose changed word has two letters, outside a
    framing formula or quotation marks; a three-word ayah with a dropped word; two errors
    in one short ayah; a two-word ayah inside a sentence. Such a text is used as ordinary
    text, and only the voice guard (which refuses a misquoted short ayah on its own)
    stands between it and the voice. Everyday formulas (لا إله إلا الله, حسبنا الله ونعم
    الوكيل, ...) stay ordinary words: a dictation joins a formula the voice refuses on its
    own with a neighbouring phrase; only a text that is nothing but a formula has it read
    by a grown-up. On 3,000 random pairs of ordinary sentences, 1 gained a part (a run of
    5 Quran words across the sentence end). Texts with Quran are measured on
    `tests/quran_parts_texts.txt` (102 quotations and 28 misquotes, all found).
  - The Quran-text guard on the general endpoints is a heuristic. Its thresholds and
    the everyday formulas and ayat it leaves out were measured on a fixture of 341
    sentences (`tests/arabic_school_sentences.txt`); an ordinary sentence that uses
    another short ayah as everyday Arabic can still be refused for dictation or for
    recitation by meaning; word-by-word recitation keeps its earlier guard.
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
  backend/mommy/               config, textnorm, align, phrases, feedback, quran, guard, asr, tts, llm, app
  web/                         index.html, app.js, recorder.js, styles.css, rewards.js (tasks and
                               rewards logic), family.js (the family UI)
  tests/                       pytest suite; tests/web/ has the web client's tests
```

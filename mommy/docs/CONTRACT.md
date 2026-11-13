# Mommy prototype: architecture contract

This file is the single source of truth for module boundaries. Every module and the web
client must follow it exactly. If a module needs something the contract does not give it,
change this file first.

It describes the system as implemented. Names and fields marked *extra* were added
beyond the first version of the contract; they are additive (no field of the first
version was removed or changed in meaning), and other modules may rely on them.

## Goal

A web prototype of "Mommy", a tutor that stands in for a parent:

- The parent photographs a textbook page, or types or pastes it.
- The child recites it aloud (reciting), or writes it on paper while the app reads it out
  phrase by phrase (dictation).
- Reciting has two modes:
  - strict: word by word;
  - contextual: is the meaning right?
- The Quran has its own module. It is always strict, and it uses no LLM and no synthetic voice.
  A school text that quotes the Quran keeps its Quran parts under the same rules (hard
  rule 4).
- Languages: Arabic (`ar`), English (`en`), French (`fr`). Children are 6-18 years old.

## Hard rules (apply to every file)

1. Speech recognition is never given the expected text. No prompt, no hotwords, no
   context. A model that is given the expected text hides the child's mistakes; this was
   measured in our own lab.
2. Deciding whether a word is wrong is done by deterministic code (`align.py`), never by an
   LLM. The LLM only reads images, judges meaning in contextual mode, and words feedback.
3. Handwriting is read blind. The LLM is never shown the expected text when it reads a
   child's handwriting. Code then compares, and the parent confirms. (Redesign, owner's
   decision: the web client no longer sends the dictation paper at all; a grown-up checks
   it in the app, "Mom's check". The server endpoint and this rule stay for any client.)
4. Quran (revised 2026-11-11 for Quran in school texts; the numbering of the rules is
   unchanged, and the sub-rules below replace the earlier rule that a school text quoting
   an ayah is refused):
   - The text comes only from the verbatim Tanzil files in `data/quran/`. Never generate,
     complete or "fix" ayat from a model or from memory.
   - Quran checking is strict only (word by word). No LLM is involved in any Quran path or
     with any Quran part of a school text (it never judges its meaning and never writes
     feedback about it), and Quran text is never synthesised to speech.
   - Feedback for the Quran, and for a mistake in a Quran part of a school text, uses
     fixed templates only, quotes the word as it is in the mushaf, and is never spoken.
   - Show "Hafs (Tanzil)" and the Tanzil attribution and link.
   - **Q1, a text that is Quran.** Leave out the framing formulas (قال تعالى, the
     isti'adha, a basmala at the start or between two surahs, صدق الله العظيم) and the
     surah and ayah labels (سورة الإخلاص, (1), [البقرة: 255]). If what remains is one or
     more whole ayat in mushaf order, the text is Quran: the general endpoints refuse it
     (`422 quran_text`) and the client sends the child to the Quran section (the parent
     to a Quran task).
   - **Q2, a school text that includes Quran** (a lesson quoting an ayah or part of one,
     a text starting with the basmala, a sentence with a short ayah inside, a partial
     ayah on its own) is a school text with **Quran parts**. The server finds the parts
     from the text in every endpoint and never takes them from a client
     (`guard.find_quran_parts`). A Quran part is recited and written against the mushaf
     words (never the typed ones), is never read by the synthetic voice (in a dictation
     a grown-up reads it from the mushaf text), and makes the text word-by-word only (no
     recitation by meaning).
5. Privacy (children's data):
   - Audio and images are processed in memory and never written to disk. They are never
     logged; log only sizes and timings. (extra) This holds for the local page reader
     (`ocr.py`) too: it reads the cleaned JPEG in memory and logs sizes, counts and
     timings, never text or pixels.
   - No analytics and no third-party scripts in the web client.
   - Images are resized in the browser (long edge at most 2000 px, re-encoded to JPEG,
     which drops EXIF) before upload.
   - The UI shows that this is an AI, not a person, at the start of each session.
   - A parent must tick a consent box before the camera or microphone is used.
   - (extra) Nothing goes to Claude before the parent ticks the AI consent box, which is
     shown under the notice of what goes to Claude only while Claude is configured; a
     consent given without that notice, or to an earlier text of it, never covers Claude
     (see "Start screen"). The server decides it for each request: it uses the Claude
     brain only for a request whose form body carries `ai_consent=1`, an opt-in field that
     the web client sends only with a consent that counts (see "AI consent" under HTTP
     API). Any other request is answered by the offline brain and Claude is not called
     for it at all, so neither a server started again with Claude after the page last
     asked `/api/health`, nor a tab still running an older `app.js`, nor any other client
     reaches Claude without the consent.
   - (extra) Every sentence of the UI about where the data goes is true in each way the
     app runs: local or online (`/api/health` `online`), with or without Claude. Online,
     the consent box says that the child's voice recordings, the photos and the texts go
     over a secure connection to the Mommy server, which checks them in memory and keeps
     none of them, and never says that nothing leaves this computer. The family data
     (children, tasks, stars, rewards, the PIN) stays in the browser on this device in
     every mode, and leaves it only as a file the parent saves with "Save a copy" (made
     in the browser, without the PIN or the consents, never sent to the server; see
     "Start screen" under Web client).
   - Online (extra, `MOMMY_ACCESS_CODE` set, or `MOMMY_ACCESS_CODE_FILE` for one's own
     computer): nothing answers without the access cookie, so only people given the code
     can send audio or photos or use the server (see "Access gate" under HTTP API). The
     code is never logged and never put in the image, in git or in a URL query: the link
     carries it in the fragment (`/#code=...`), which browsers never send to a server,
     and the gate page POSTs it. It is written to disk in one place only: the code file
     of a self-hosted deployment (`MOMMY_ACCESS_CODE_FILE`, mode 0600, in the data volume
     of `compose.yaml`), so that the code survives restarts. Without either variable
     there is no gate at all and local use is unchanged.
6. No Claude model identifiers or Claude model version names appear anywhere in the
   repository: no code strings, comments, docs or tests. Claude models are configured only
   through the environment variables `MOMMY_VISION_MODEL` and `MOMMY_TEXT_MODEL`. Tests use
   obviously fake names such as `"test-vision-model"`. This rule does not cover open-source
   speech model names such as the Whisper or Piper files.
7. Claude API calls:
   - Use the official `anthropic` Python SDK (installed: anthropic 2.8.0).
   - Never send `temperature`, `top_p`, `top_k`, `budget_tokens` or a `thinking` block;
     current models reject some of these with HTTP 400, and thinking behaviour differs
     by model (the model is chosen by environment variable).
   - Control cost with `output_config={"effort": <MOMMY_EFFORT, default "low">}`.
   - Get structured JSON with `output_config={"format": {"type": "json_schema", "schema": ...}}`,
     merged with effort into one `output_config` dict. Parse the first text block with
     `json.loads`.
   - Check `stop_reason == "refusal"` and `"max_tokens"` before parsing.
   - `max_tokens` is 16000 for vision calls (page and handwriting reading) and 4000 for
     text calls (meaning and feedback). On current models adaptive thinking is on by
     default (on some it cannot be turned off) and thinking tokens count toward
     `max_tokens` even when they are not returned, so lower caps can cut off a dense
     Arabic page or a feedback reply and force the offline fallback. `max_tokens` is only
     a ceiling (billing is for tokens used). Keep it below about 21,000, above which the
     SDK refuses a non-streaming request for its expected duration.
   - Never use the Batch or Files APIs for children's data.
8. Offline mode:
   - If `ANTHROPIC_API_KEY` or either model variable is missing, the app still runs with
     `OfflineBrain`. Handwriting then needs the parent to type the text; a printed page
     is read by the local page reader (extra, `ocr.py`, `MOMMY_OCR`, default on) when its
     models are present, else the parent types it too. The same holds for a request
     without the AI consent (hard rule 5).
   - If the ASR or TTS model files are missing, `/api/health` says so and the UI hides
     those features. It does not crash.
9. No network calls at runtime except to the Claude API, and only when it is configured.

## Layout

```
mommy/
  README.md                 how to install, download models, run, and test
  requirements.txt          direct dependencies, pinned
  requirements.lock         every package, pinned and hashed (pip install --require-hashes -r requirements.lock)
  requirements-runtime.lock the same pins and hashes without the "# tests only" requirements (extra; what the image installs)
  run.sh                    starts uvicorn on 127.0.0.1:8080 (PORT to change), serving the API and web/
  scripts/download_models.sh  fetches the sherpa-onnx Whisper turbo model (small with --small) and the Piper voices into models/,
                            each archive checked against its pinned sha256 before it is unpacked, and the OCR models
                            (extra) into models/ppocr-onnx/, each file checked against its pinned sha256
  scripts/lock_requirements.py  regenerates both lock files (development only: the one script that uses the network)
  scripts/refresh_pins.py   shows or moves the image pins (cloudflared, Caddy, the Python base) to a tag's current
                            digest, checking linux/amd64 and linux/arm64 (development only; extra)
  Dockerfile .dockerignore scripts/space_start.sh deploy/huggingface/   the online deployment (extra; README.md, "Run it online")
  compose.yaml compose.test.yaml .gitattributes   self-hosting on one's own computer behind a Cloudflare quick tunnel
                            (extra; SELF_HOST.md; compose.test.yaml is for testing the kit only)
  deploy/oracle/            the same on an Oracle Cloud Always Free VM (extra; ORACLE.md): setup.sh,
                            compose.oracle.yaml, compose.stable.yaml and Caddyfile (the permanent link)
  docs/CONTRACT.md          this file
  data/quran/quran-uthmani.txt, quran-simple-clean.txt   verbatim Tanzil text (txt-2: sura|aya|text; licence block at end)
  data/quran/quran-data.js  verbatim Tanzil metadata (surah names, ayah counts; CC BY 3.0)
  models/                   git-ignored; see the model paths below
  backend/mommy/
    __init__.py
    config.py   textnorm.py   align.py   phrases.py   feedback.py
    quran.py    guard.py      asr.py     tts.py       llm.py       app.py
    ocr.py      the local page reader (extra; MOMMY_OCR): PP-OCR models through onnxruntime
    access.py   the access gate of an online deployment (extra; MOMMY_ACCESS_CODE), allowed host names, the code file
    share_link.py  python -m mommy.share_link: the link to share a self-hosted Mommy (extra)
    proxies.py     python -m mommy.proxies: the proxies trusted for X-Forwarded-For with
                   MOMMY_FORWARDED_ALLOW_IPS=container-networks (extra)
  web/
    index.html  app.js  recorder.js  styles.css
    rewards.js  family.js     the tasks and rewards (docs/REWARDS.md): pure logic, and the family UI
    access.html access.js     the access gate page (extra; served only online, to a browser without the cookie)
  tests/        pytest; run with:  cd mommy && .venv/bin/python -m pytest -q
  tests/arabic_school_sentences.txt   ordinary Arabic sentences that measure the Quran guards (tests/test_quran_guard.py)
  tests/quran_parts_texts.txt         lessons, Quran texts, partial ayat and misquotes that measure the Quran parts (tests/test_quran_parts.py)
  tests/quran_fixtures.py             fills the placeholders of both fixtures from Tanzil (no Quran word is typed in them)
  tests/web/    Node.js tests of the web client (see tests/web/README.md): rewards.test.cjs (web/rewards.js in
                Node), smoke.cjs and family.cjs (headless Chromium through Playwright, fake API),
                access.cjs (extra: the access gate in Chromium against the real app under uvicorn,
                with MOMMY_ACCESS_CODE set and fake speech components; then the server's part in
                the AI consent against the same app with a fake Claude brain)
  tests/test_access.py                the access gate (extra)
  tests/test_ocr.py                   the local page reader: reading order, limits, privacy, the real models (extra)
  tests/test_selfhost.py              suffix host entries, the code file and share_link against a fake
                                      cloudflared metrics server (extra)
  tests/test_space_image.py           the image's start script, model checksums and Dockerfile (extra)
  tests/test_compose_kit.py           compose.yaml, the start script as compose runs it, proxies.py, the pins (extra)
  tests/test_oracle_kit.py            deploy/oracle: setup.sh's helpers and dry runs, the compose files, Caddyfile (extra)
  tests/test_deploy.py                deploy/huggingface/deploy.py against a fake Hub (extra)
```

`tests/conftest.py` puts `mommy/backend` on `sys.path`. Imports look like
`from mommy.align import align`. The files in `data/quran/` are never modified.

## Python modules

All public functions have type hints and docstrings. Use Python 3.13 and the standard
library plus numpy, sherpa_onnx, anthropic, fastapi, pydantic, and pillow. Speech
synthesis with sherpa-onnx 2.x also needs an espeak-ng phonemizer (see tts.py). (extra)
The local page reader (`ocr.py`) also uses onnxruntime and OpenCV
(`opencv-python-headless`), imported only by it.

### config.py

```python
ASR_MODELS = ("small", "turbo"); EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")
DEFAULT_ALLOWED_HOSTS = ("127.0.0.1", "localhost", "::1")
@dataclass(frozen=True)
class Settings:
    root: Path                 # the mommy/ directory
    models_dir: Path           # root/"models"
    quran_dir: Path            # root/"data"/"quran"
    web_dir: Path              # root/"web"
    asr_model: str             # "small" or "turbo"; env MOMMY_ASR_MODEL, default "turbo"
    asr_threads: int           # env MOMMY_ASR_THREADS, default 4
    anthropic_api_key_set: bool
    vision_model: str | None   # env MOMMY_VISION_MODEL
    text_model: str | None     # env MOMMY_TEXT_MODEL
    effort: str                # env MOMMY_EFFORT, default "low"
    allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS   # extra; env MOMMY_ALLOWED_HOSTS (comma-separated)
    access_code: str | None = field(default=None, repr=False)   # extra; env MOMMY_ACCESS_CODE (None: no gate)
    access_code_file: Path | None = None   # extra; env MOMMY_ACCESS_CODE_FILE, when the code came from it
    live_recite: bool = True   # extra; env MOMMY_LIVE_RECITE (on/off, 1/0, true/false, yes/no; default on)
    ocr: bool = True           # extra; env MOMMY_OCR (on/off as MOMMY_LIVE_RECITE; default on): the local page reader
    ocr_threads: int           # extra; env MOMMY_OCR_THREADS, default asr_threads
    claude_configured: bool    # property (extra): key and both models set
MIN_ACCESS_CODE_CHARS = 8      # extra
def load_settings(root: Path | None = None) -> Settings
# Blank variables count as unset. ValueError for an unknown ASR model or effort, a
# thread count that is not a positive integer, an allowed-hosts list with no host, an
# access code shorter than MIN_ACCESS_CODE_CHARS (the message never quotes the code), or
# (extra) no access code while MOMMY_REQUIRE_ACCESS_CODE is set (any non-blank value; the
# container image sets it, run.sh does not), or (extra) a MOMMY_LIVE_RECITE or MOMMY_OCR
# that is neither on nor off (parse_switch), or a MOMMY_OCR_THREADS that is not a positive
# integer (parse_threads, which also reads MOMMY_ASR_THREADS). "Blank" is str.strip()'s: any Unicode white
# space, so a no-break space is no code; this is the only place that decides it.
# The access code is stripped; it is kept out of repr(Settings), so it cannot reach a log.
def parse_allowed_hosts(value: str) -> tuple[str, ...]   # extra
# The entries of MOMMY_ALLOWED_HOSTS, each normalized by access.host_entry, without
# repeats, in order. An entry that starts with a dot is a suffix entry (".trycloudflare.com",
# see access.HostMatcher). ValueError for no entry and for a suffix host_entry refuses
# (".com", ".", ".co.uk", "*.example.com"...): the app does not start.
def access_code_from(env: Mapping[str, str], *, create: bool = True) -> tuple[str | None, Path | None]   # extra
# (code, file): MOMMY_ACCESS_CODE when set (file None; it wins, and the file is then
# neither read nor made); else the code of MOMMY_ACCESS_CODE_FILE (code_from_file); else
# (None, None).
def code_from_file(path: Path, *, create: bool = True) -> str   # extra
# The code in the file (access.read_code_file). A missing file, with create, first gets a
# new code (access.create_code_file: 12 characters of CODE_ALPHABET from secrets, written
# atomically, mode 0600; when two processes make it at once, both end with the code that
# won, the one in the file); without create, FileNotFoundError. ValueError (naming the
# file, never the code) for a file that cannot be read or made (a directory, no
# permission, a missing directory, not UTF-8, more than one line, over 1024 bytes) or that
# holds fewer than MIN_ACCESS_CODE_CHARS characters, an empty file included: a bad file is
# never replaced behind the owner's back. Logs "made a new access code in <path>" (the
# path, never the code). Leading and trailing white space, a UTF-8 byte-order mark and a
# CRLF are dropped (a file edited on Windows).
```

Whisper turbo is the default: on the 4-core test machine it has the same warm latency as
small (about 1.5 s for a 5 s clip), fixes French homophone errors small makes ("dort"
heard as "d'or") and is markedly better on Arabic, at the cost of about 1 GB more RAM per
loaded language.

### textnorm.py

```python
Lang = Literal["ar", "en", "fr"]; LANGUAGES = ("ar", "en", "fr")
def strip_tashkeel(s: str) -> str
# Removes Arabic harakat, tanwin, shadda, sukun, superscript alef U+0670, tatweel U+0640,
# and Quranic annotation marks U+06D6-U+06ED (after NFC, so a decomposed أ stays a letter).
def normalize_word(w: str, lang: Lang, *, keep_tashkeel: bool = False, keep_accents: bool = True) -> str
# Speech key.
# - Arabic: unify alef forms أ إ آ ٱ -> ا; ى -> ي; ة -> ه; ؤ -> و; ئ -> ي; drop ء only if
#   the word has other letters; strip tashkeel unless keep_tashkeel; drop tatweel.
#   Extra: the regular Uthmani spellings are rewritten in standard spelling (superscript
#   alef, small waw/yeh, small high yeh/noon, hamza on a tatweel, the doubled-lam
#   article; they fire only on Uthmani-only characters). Same-sound spellings are
#   unified: a hamza (ء ؤ ئ) before a waw is dropped (رءوف/رؤوف, مسئول/مسؤول,
#   جاءوا/جاؤوا), مائة/مائتين -> مئة/مئتين, داوود -> داود.
# - en/fr: casefold; fold œ/æ to oe/ae; remove punctuation except intra-word apostrophes
#   and hyphens. keep_accents=False also removes diacritics (é -> e). For speech matching
#   use keep_accents=False; for dictation spelling use normalize_dictation_word.
# - All languages: map Arabic-Indic and Persian digits to ASCII; strip punctuation,
#   including ، ؛ ؟; Persian keyboard letters ی ک ہ become Arabic. Arabic rules apply to
#   Arabic letters and Latin rules to Latin letters, whatever lang is.
def normalize_dictation_word(w: str, lang: Lang, *, keep_tashkeel: bool = False) -> str   # extra
# Dictation key: أ إ آ ء ؤ ئ ة ى stay distinct, accents are kept, only ٱ -> ا.
def tokenize(text: str, lang: Lang) -> list[str]
# Splits on whitespace and punctuation. Keeps the original surface forms (unnormalised),
# drops tokens that normalise to nothing (standalone pause marks). For French, keeps
# elisions as one token ("l'école"); keeps . , : and the Arabic decimal and thousands
# separators inside numbers ("3,5", "12:30"). Extra: an apostrophe, a hyphen (- U+2010
# U+2011 U+2212) or the Arabic letter mark U+061C between two Arabic letters splits the
# token (Arabic has no elision: "قل-هو" is two words, as the reader hears them).
def token_spans(text: str, lang: Lang) -> list[tuple[int, int]]   # extra: character spans of tokenize()
def has_arabic(text: str) -> bool; def is_arabic_char(c: str) -> bool   # extra
# Speech only (extra), used by align.speech_joins and recitation_key:
def digit_number(token: str, lang: Lang) -> str | None      # "12"/"١٢" -> "c12"; "21st", "1er", "2e" -> "o21", "o1", "o2"
def spoken_number(tokens: Sequence[str], lang: Lang, *, conjunction: bool = False) -> str | None
# number words 0..100 -> the same values as digit_number
def is_number_word(token: str, lang: Lang) -> bool
# en: zero..one hundred, "twenty five"/"twenty-five", ordinals (third, twenty-first);
# fr: zéro..cent with "et", hyphens, soixante-dix, quatre-vingt(s), the Belgian/Swiss
# septante/huitante/octante/nonante, ordinals (premier/première, deuxième, ...);
# ar: both genders and cases give one value (ثلاثة/ثلاث, عشرون/عشرين, اثنا عشر/اثنتي
# عشرة/إثنى عشر, واحد وعشرون/إحدى وعشرين/أحد وعشرين with و joined or apart, مائة/مئة/مية,
# the accusative with tanwin on an added alef: واحدًا, أربعًا, عشرًا, ثلاثًا وعشرين). A
# word whose vowel marks rule the number out is not one (سَبُع a beast of prey, خُمُس a
# fifth, تَسَعُ "holds", عُشْر a tenth, صَفَر the month); without marks سبع is seven.
# conjunction=True (Arabic, used by speech_joins): a number led by و (وثلاث, و ثلاثة)
# keeps it in the value ("وc3"), which equals no number without it and no digit value.
def fold_english_spelling(key: str) -> str   # colour -> color, centre -> center, realise -> realize, ...
def english_expansions(token: str) -> tuple[tuple[str, ...], ...]   # "they're" -> (("they", "are"),)
```

### align.py

```python
@dataclass
class Op:
    kind: Literal["match", "sub", "del", "ins"]   # del = child skipped an expected word; ins = child added a word
    exp_index: int | None    # index into expected tokens (None for ins)
    heard_index: int | None  # index into heard tokens (None for del)
    expected: str | None     # surface form of the expected token
    heard: str | None        # surface form of the heard token (joined pieces separated by a space)

@dataclass
class CheckResult:
    ops: list[Op]
    n_expected: int
    n_errors: int            # sub + del + ins
    first_error_exp_index: int | None
    verdict: Literal["correct", "mistakes", "unclear"]
    say_again: bool          # True when the input looks unreliable (see below)
    word_accuracy: float     # matched / n_expected (0..1)
    say_again_reason: Literal["empty", "error_rate"] | None = None   # extra
    stopped_at_exp_index: int | None = None   # extra: first word of a final run of >= 2 skipped words
    n_unreadable: int = 0                     # extra: written words read as [?] (counted in n_errors)

def align(expected: list[str], heard: list[str], key: Callable[[str], str]) -> list[Op]
# Word-level Levenshtein (sub=del=ins=1). Among the minimum-cost alignments, the one with
# the most matched expected words wins ("the skipped, cat matched, now added" beats "the
# heard as cat, cat heard as now"); remaining ties are broken from the start of the text,
# preferring match, then sub, then del, then ins. key() normalises a token for comparison.
def align_with_joins(expected, heard, key, *, max_pieces=3, extra_joins=None, rigid=None) -> list[Op]   # extra
# Speech only: an expected word equal to 2..3 heard tokens joined (or the reverse) is a
# match at no cost; extra_joins = (join_heard, join_exp) adds caller equivalences
# {(i, j): [k, ...]} (expected[i] ~ heard[j:j+k], expected[i:i+k] ~ heard[j]), and
# extra_joins = (join_heard, join_exp, blocks) also blocks {(i, j): [(a, b), ...]}
# (expected[i:i+a] ~ heard[j:j+b]): one move, matched as a whole or not at all, whose
# ops pair the words in order (the last expected word takes the remaining heard words,
# or the remaining expected words share the last heard word).
# rigid (extra): expected indices in no split or joined word (the Quran words of a school
# text); they match one heard token by key, or through the caller's extra_joins.
def without_rigid(joins, rigid) -> (join_heard, join_exp, blocks)   # extra: speech_joins minus every entry touching rigid
Joins = Mapping[tuple[int, int], Sequence[int]]; Blocks = Mapping[tuple[int, int], Sequence[tuple[int, int]]]   # extra
def speech_joins(expected, heard, lang) -> tuple[dict, dict, dict]   # extra: (join_heard, join_exp, blocks)
# A number in digits matches the same number in 1..3 words on the other side (0..100,
# en/fr/ar, see textnorm); Arabic numbers in 1..3 words match by value on both sides, in
# any gender or case (اثنتا عشرة = اثنا عشر = إثنى عشر, ثلاثة = ثلاث, عشرون = عشرين,
# واحد وعشرون = إحدى وعشرين, وأربع = وأربعة, أربعًا = أربعة; ثلاثة != أربعة; سَبُع !=
# سبعة); an English contraction matches its full form.
def check_recitation(expected_text: str, heard_text: str, lang: Lang) -> CheckResult
# Speech: recitation_key (normalize_word without tashkeel and accents, no hyphens or
# apostrophes; English British spellings folded onto American), align_with_joins with
# speech_joins. Quran.check uses recitation_key but not speech_joins: there, a number
# word said in another gender or case is a mistake.
def check_writing(expected_text: str, written_text: str, lang: Lang, *, strict_tashkeel: bool = False) -> CheckResult
# Dictation: writing_key (normalize_dictation_word; tashkeel compared only with
# strict_tashkeel), plain align: a split word, a number in digits for words, a British or
# American spelling are differences. Arabic-Indic and Western digits are equal in both
# modes. "[?]" (UNREADABLE) in the writing is a token of its own: a sub whose heard is
# "[?]", never a del.
def build_result(ops, n_expected, n_heard, *, unreliable_error_rate=SAY_AGAIN_ERROR_RATE) -> CheckResult   # extra
def recitation_key(token, lang) -> str; def writing_key(token, lang, *, strict_tashkeel=False) -> str   # extra
def reading_progress(result) -> dict   # extra: where a child still reading has got to (/api/recite/phrase)
# {"ops": [{kind, exp_index, heard_index, expected, heard}], "n_expected", "n_read",
#  "n_matched", "n_errors"}: the del ops after the last op with a heard word become
#  "pending" (not read yet); the ops up to there keep match/sub/del/ins. n_read counts the
#  expected words reached, n_errors the non-matching ops among them.
def result_summary(result, *, max_errors=5) -> dict   # extra: compact summary for feedback writers
# {"verdict", "say_again", "say_again_reason", "n_expected", "n_errors", "n_unreadable",
#  "word_accuracy", "stopped_at", "stopped_at_exp_index", "errors": [{kind, expected, heard, exp_index}]}
# (unreadable words are not listed as errors)
UNREADABLE = "[?]"; def tokenize_written(text, lang) -> list[str]; def has_unreadable(text) -> bool   # extra
SAY_AGAIN_ERROR_RATE = 0.6; STOPPED_MIN_WORDS = 2; MAX_JOINED_PIECES = 3   # extra
```

`say_again` and the verdict:

- `say_again_reason "empty"`: nothing usable was heard or written (no tokens).
- `say_again_reason "error_rate"` (speech only): the error rate is above 0.6. A final run
  of skipped words after the child stopped early (`stopped_at_exp_index`) is left out of
  that rate: a child who reads the first sentence of a page well is told where they
  stopped, not that the recording was unclear.
- Dictation never gives `"error_rate"`: a page full of misspellings is a result for the
  parent to confirm.
- `say_again` makes the verdict `"unclear"`; otherwise `"correct"` with no errors and
  `"mistakes"` with at least one.

### phrases.py

```python
def split_phrases(text: str, lang: Lang, max_words: int = 6) -> list[str]
def split_phrase_spans(text, lang, max_words=6) -> list[tuple[str, tuple[int, int]]]   # extra: each phrase and the characters it came from
# Dictation chunks: split on sentence punctuation (. ! ? ؟ ، ؛ , ; : … ۔) and blank lines,
# then cap each chunk at max_words in pieces of near-equal length (13 words -> 5+4+4).
# Never splits inside a word or a number (3,5), nor after a common abbreviation or a
# capital initial; keeps punctuation (closing quotes stay with their phrase); drops
# empty chunks.
```

### feedback.py (offline templates, also the fallback when Claude fails)

```python
AgeBand = Literal["6-9", "10-13", "14-18"]; AGE_BANDS; ERROR_KINDS = ("sub", "del", "ins")
def praise(lang: Lang, age: AgeBand, seed: int = 0) -> str          # strict results only
def point_out(lang: Lang, age: AgeBand, expected_word: str, kind: str, n_errors: int = 1) -> str
# For example: "Almost! Listen again: <word>". kind is one of sub/del/ins; an insertion
# quotes no word. With n_errors > 1 the wording is plural and names the first mistake
# ("A few words were not right. The first one is <word>").
def stopped(lang, age, next_word) -> str      # extra: "Good start! You stopped at <word>. ..."
def unreadable(lang, age) -> str              # extra: only [?] words differ: "Some words could not be read ..."
def say_again(lang: Lang, age: AgeBand, reason: str | None = None) -> str
# None/"empty": "that was hard to hear, a little louder"; "error_rate": "that sounded
# quite different from the text, read it again from the start" (never "louder");
# "nothing_written": no words in a dictation.
def for_result(result, lang, age, seed=0, *, activity=None) -> str   # extra
# CheckResult, its asdict form or result_summary -> say_again (by reason) / praise /
# stopped (first mistake is where the child stopped) / point_out (plural when several) /
# unreadable. Unreadable words are never pointed out.
def quran_feedback(kind: str, expected_word: str | None) -> str
# Arabic only, fixed respectful wording, never quoting beyond the given word, neutral for
# a boy or a girl (no imperative, no ـك ending). kind: correct, mistakes/mistake (= sub),
# sub, del, ins, stopped, unclear. For example: "أحسنت، بارك الله في هذه التلاوة." when
# correct; "تنبيه: «<word>»" for a mistake; "تنبيه: سقطت من التلاوة كلمة «<word>»." for
# a skipped word; "أحسنت فيما تلوت، وتوقفت التلاوة قبل «<word>»." when
# the child stopped early; "لم تتّضح التلاوة جيدًا. هيا نعيدها مرة أخرى." when unclear
# (too quiet, too short or far from the ayat: the Quran screen shows no other hint, so it
# says the recitation did not come through, not that it was wrong). Shown as text only,
# never spoken.
QURAN_CORRECT; QURAN_UNCLEAR   # extra
def quran_part_feedback(kind, mushaf_word, lang, activity="recitation") -> str   # extra
# A mistake inside a Quran part of a school text (Q2), in ar/en/fr, for "recitation" or
# "dictation": kind sub (mistakes), del, ins, stopped. Fixed, respectful wording that
# quotes only the given word, the word as it is in the mushaf (the Uthmani display
# word); neutral for a girl or a boy (no imperative, no ـك, هيا + "we"; French without
# "tu"). For example "في الآية الكريمة كلمة تحتاج إلى انتباه: «<word>». هيا نقرؤها مرة أخرى." and, in a dictation, "تنبيه في
# كتابة الآية الكريمة: نقصت كلمة «<word>»."; 'A word of the noble ayah was left out:
# "<word>".' Never written by Claude, never spoken (the API marks it feedback_is_quran).
```

Use a warm parent-like tone with short sentences, adapted to age: playful for 6-9, plain for
14-18. Messages must never suggest that a person is speaking (no "I", no parent words).
Arabic messages are for girls and boys alike:

- no imperative and no visibly gendered second-person form; instructions and
  encouragement use the inclusive "هيا" + first-person plural verb (هيا نُحاوِل مِن
  جَدِيد!, هيا نُعِيد التَّسْمِيع) or a verbal noun; a past-tense form whose last letter
  carries no vowel (أَحْسَنْت, اِقْتَرَبْت, نَسِيت) is fine;
- every message except the Quran ones may be read aloud by the Arabic voice, whose
  espeak-ng phonemizer gives a word without vowel marks no vowels unless it knows it,
  and reads a bare final ك as masculine: the words it misreads carry their vowel marks
  inside the word, never on the last letter, and no spoken message uses the suffix ـك;
- terminology: التسميع (reciting a text), الإملاء (dictation), التلاوة (Quran
  recitation), القرآن الكريم.

Contextual-mode wording lives in `llm.meaning_feedback` and follows the same rules; the
Claude prompts give the same Arabic rules.

### quran.py

```python
@dataclass(frozen=True)
class Ayah:
    surah: int
    ayah: int
    display: str               # verbatim Uthmani line (with the basmala prefix removed for ayah 1, except surah 1)
    match: str                 # verbatim Simple-Clean line (with the same basmala handling)
    display_words: list[str]   # whitespace split, standalone pause-mark tokens left out
    match_words: list[str]
    word_map: list[int]        # for each match word index, the display word index (handles يا أيها vs يَـٰٓأَيُّهَا)

class Quran:
    def __init__(self, quran_dir: Path)    # parses both text files and quran-data.js, ignores '#' licence lines,
                                           # validates 6236 ayat and the 114 ayah counts; ValueError/FileNotFoundError otherwise
    attribution: str           # "Quran text: Tanzil Project (tanzil.net), Hafs, Uthmani v1.1, CC BY 3.0, verbatim"
    licence: str               # extra: the Tanzil copyright block, verbatim
    def surahs(self) -> list[dict]
    # [{number, name_ar, ayah_count, name_translit, name_en}]: names read from the verbatim
    # Tanzil metadata data/quran/quran-data.js (CC BY 3.0), counts checked against the text
    def ayah_count(self, surah) -> int; def ayat(self, surah, start, end) -> list[Ayah]
    def raw_lines(self, surah, ayah) -> tuple[str, str]   # extra: full verbatim lines, basmala included
    def check(self, surah: int, start: int, end: int, heard_text: str) -> dict
    # {ops, verdict, say_again, first_error: {surah, ayah, word_index_display, expected_display_word, kind} | None,
    #  extra: n_expected, n_errors, word_accuracy, tolerated: ["istiadha", "basmala"],
    #  stopped_at: {surah, ayah, word_index_display, expected_display_word} | None,
    #  words: [{surah, ayah, word_index_display, display, status: match|sub|del, heard}, {status: "ins", ...}]}
    # ops are JSON-ready dicts: the Op fields plus surah, ayah, word_index,
    # word_index_display, expected_display (None for an insertion).
    def locate(self, heard_text: str, top_k: int = 5, within_surah: int | None = None) -> list[dict]
    # Hifz search: n-gram index (3..7 words) over normalised match words. Returns
    # [{surah, ayah, word_index (display), match_word_index, score (0..1), display_preview}]
    # sorted by score. Only the first 40 heard words are used.
    # display_preview: up to 8 display words from that word, cut verbatim from the
    # Uthmani line (pause marks between the words kept), ending with the ayah.
    def strip_framing(self, text) -> tuple[list[str], bool]   # extra: tokens without قال تعالى, صدق الله العظيم, ...
    def quran_runs(self, tokens, min_words, *, exclude_formulas=False) -> list[tuple[int, int]]   # extra: spans that are Quran text
    # exclude_formulas: the words of an EVERYDAY_FORMULAS formula count as non-Quran words (no run passes through one)
    def whole_ayah(self, tokens) -> tuple[int, int] | None    # extra: the tokens are one whole ayah (>= 2 words)
    def contained_ayat(self, tokens, min_words) -> list[tuple[int, int, int, int]]   # extra
    # [(start, end, surah, ayah)]: whole ayat of min_words (>= 2) to SHORT_AYAH_MAX_WORDS words found as
    # consecutive tokens (speech keys), EVERYDAY_AYAT left out
    # locate(..., *, min_score=None) (extra): a word sequence whose share of words found in the Quran at all is
    # below min_score is not searched (no candidate of it could reach that score); the candidates that do are unchanged
    # extra, the primitives of guard.find_quran_parts:
    def framing_spans(self, tokens) -> list[tuple[int, int, bool]]   # framing formulas: (start, end, closing); strip_framing uses it
    def exact_matches(self, tokens, min_words, *, exclude_formulas=False) -> list[tuple[int, int, int]]
    # every place of a run of >= min_words (3+) consecutive Quran words: (start, end, g), maximal at its place;
    # quran_runs is the union of these spans (same result as before, measured on 641 texts)
    def global_position(self, surah, ayah, word=0) -> int; def location(self, g) -> (surah, ayah, match word)
    # g: the Simple-Clean words of the whole Quran in one sequence, one unused position after each surah
    def ayah_bounds(self, g) -> (first, end); def surah_bounds(self, g) -> (first, end)
    def words_at(self, g_lo, g_hi) -> list[str]; def keys_at(self, g_lo, g_hi) -> list[str]   # verbatim words / speech keys
    def word_groups(self, g_lo, g_hi) -> list[dict]   # {g: (first, end), surah, ayah, display: (first, last), complete}
    # the display (Uthmani) words that spell the match words (one-to-one, يا أيها -> one word, or one -> several)
    def display_slice(self, surah, ayah, first, last) -> str   # display words cut verbatim from the line (pause marks kept)
    def surah_name_at(self, tokens, i) -> int   # tokens from i that spell a surah's Arabic name (Tanzil metadata), or 0
    def muqattaat_joins(self, g_lo, n, heard_keys) -> {(i, j): [k]}   # the disjoined letters said by name, as check accepts them
CLOSING_FRAMING_FORMULAS = ("صدق الله العظيم",)   # extra: closes a quotation; the other framing formulas open one
EVERYDAY_FORMULAS   # extra: بسم الله, الحمد لله, سبحان الله, إن شاء الله, ما شاء الله, لا إله إلا الله, لا حول ولا قوة إلا بالله,
                    # لا قوة إلا بالله, حسبنا الله ونعم الوكيل, توكلت على الله, الله أكبر, أستغفر الله
EVERYDAY_AYAT       # extra: (surah, ayah) of 8 three-word ayat that are everyday Arabic: 15:93, 26:101, 74:18, 74:30,
                    # 82:12, 86:14, 88:12, 98:3 (given by number; ValueError at load if one is not three words)
SHORT_AYAH_MAX_WORDS = 4   # extra: a longer ayah is a run of 5 Quran words
```

The basmala and Tanzil:

- The txt-2 files prefix ayah 1 of every surah except 1 and 9 with "بسم الله الرحمن الرحيم".
  Remove exactly that prefix: 4 words in Simple-Clean, the corresponding Uthmani words in
  display (found by comparing speech keys with 1:1, so the extra shadda of 95:1 and 97:1
  is handled). This is display handling of the same verbatim line, not an edit.
- In surah 1 the basmala is ayah 1. A range that starts at 1:1 expects it; a range of
  surah 1 that starts later ignores a basmala said first, as in every other surah.

Checking (`check`):

- Words are compared with `align.recitation_key`. A leading isti'adha and/or basmala in
  the heard text is ignored: heard exactly, always; with up to 2 (isti'adha) or 1
  (basmala) wrong, missing or extra words, or as the short forms "أعوذ بالله" / "بسم الله",
  only when that strictly lowers the errors. The number of heard words a formula takes is
  chosen by the result (the missing and extra words of the rest against the start of the
  range), so a formula missing its last word never takes the ayah's first word.
- The disjoined letters (muqatta'at) that open 29 surahs (and 42:2) match their spoken
  letter names, joined or apart ("الم" = "ألف لام ميم", "يس" = "يا سين" or "ياسين"), at
  those positions only. The letters are read from the Tanzil word; only the letter names
  are in the code.
- A child who stops early gets `stopped_at` and the "stopped" feedback.

### guard.py (extra: Quran in the texts of the general endpoints)

The guards moved here from `app.py` (which re-exports them, with their constants), and the
Quran parts of a school text (hard rule 4, Q1 and Q2).

```python
QURAN_GUARD_MIN_WORDS = 4; QURAN_GUARD_MIN_SCORE = 0.9; QURAN_GUARD_RUN_WORDS = 5
QURAN_GUARD_FRAMED_RUN_WORDS = 3; QURAN_GUARD_FRAMED_GAP_WORDS = 4   # framed runs: the formula's neighbourhood
QURAN_GUARD_CONTEXTUAL_RUN_WORDS = 4; QURAN_GUARD_CONTAINED_AYAH_WORDS = 3
NEAR_EXTEND_MAX_WORDS = 8; NEAR_GAP_WORDS = 3; NEAR_MIN_MATCHED = 4; NEAR_MAX_SCOPE_WORDS = 60
SHORT_MISREAD_WORDS = 4; FIT_BAND = 6; CHUNK_MAX_WORDS = 6
GuardMode = Literal["strict", "contextual", "dictation"]
QURAN_TEXT_MESSAGE; QURAN_MEANING_MESSAGE
def looks_like_quran(text, quran) -> bool            # building block of the voice and meaning guards
def is_whole_ayah(text, quran) -> bool; def contains_short_ayah(text, quran) -> bool
def is_quran_phrase(text, quran) -> bool             # the voice (/api/tts): also near_short_ayat, clitic_ayat and joined words
def looks_like_quran_for_meaning(text, quran) -> bool   # contextual mode (plus: any Quran part), with the same additions
def near_short_ayat(quran, keys, context=None) -> list[tuple[int, int, int, int]]   # extra: a short ayah with one OCR-like error
def clitic_ayat(quran, tokens) -> list[tuple[int, int, int, int]]   # extra: a short ayah whose first word carries و/ف
def is_everyday_formula(text, quran) -> bool        # extra: the words are exactly one of EVERYDAY_FORMULAS
SOFT_JOIN_MAX_WORDS = 8                              # extra: a voice phrase joined with its neighbour (step 4)
# The voice and meaning guards also test the text with every character that is not a
# letter, a mark or a digit, and every tatweel, turned into a space (words joined by a
# tatweel or a zero-width character).
def dictation_speaks_quran(text, lang, quran) -> bool   # the earlier phrase guard, kept for the measured tables
def framed_runs(quran, tokens, anchors) -> list[tuple[int, int, int]]
def is_misread(typed_key, mushaf_key) -> bool         # one letter changed, dropped or added (two from six letters), not a clitic
def find_quran_parts(text, lang, quran) -> QuranAnalysis   # THE function: deterministic, from the text alone
def quran_writing_ops(expected, alternatives, written, lang, *, strict_tashkeel=False) -> list[Op]
@dataclass(frozen=True)
class QuranPart: start: int; end: int; g_lo: int; g_hi: int; rule: str
# tokens start..end-1 (textnorm.tokenize) stand for the Quran words g_lo..g_hi-1 (one surah);
# rule: ayah | run | framed | contained | located | near
@dataclass
class QuranAnalysis:
    text; lang; spans; parts: list[QuranPart]; is_quran: bool (Q1); uthmani_outside: bool; voice_safe: bool
    refused -> bool                         # is_quran or uthmani_outside: the general endpoints answer 422 quran_text
    quran_range() -> {"surah", "from", "to"} | None   # Q1 ayat that are one range of one surah
    mushaf_words(part) -> (uthmani, clean, clean_display); chunks(part) -> [(uthmani, clean)]
    differences(part) -> [Op]; replacement(part) -> str; mushaf_text() -> str
    dictation_plan() -> [{"phrase", "reader": "voice" | "grown_up", "read_text", "part"}]
    expected() -> ExpectedWords             # tokens, quran {exp index: (part, g)}, display, ranges, alternatives
    check_recitation(heard_text) -> (CheckResult, ExpectedWords)
    check_writing(written_text, *, strict_tashkeel=False) -> (CheckResult, ExpectedWords)
    parts_json(submitted=None, *, lead=0) -> list[dict]   # the API form (see the HTTP API)
```

How `find_quran_parts` finds the parts (all on speech keys, with the framing formulas and
the ayah numbers between words left out, as `strip_framing` does for the guards):

1. The rules already built, with their place in the Quran: runs of 5 Quran words
   (`exact_matches`), framed runs of 3 in the formula's neighbourhood (`framed_runs`),
   whole short ayat of 3 or 4 words inside the text (`contained_ayat`, without
   `EVERYDAY_AYAT`), the text or a line that is exactly a whole ayah (`whole_ayah`), and
   the 90% rule of `locate` on the text, each line and each sentence. `EVERYDAY_FORMULAS`
   stay ordinary words in the framed and contained rules, and under the 90% rule: words
   that are exactly an everyday formula (`لا إله إلا الله`, `حسبنا الله ونعم الوكيل`) are not
   placed by it (the decision of 2026-11-11).
2. Overlapping candidates: the longest wins; candidates on the same diagonal (the same
   Quran words) are merged.
3. Near match, for an ayah with a changed, dropped or misread word: a part is completed to
   the start or end of an ayah it covers in part when at most 8 ayah words are missing
   and the typed words there differ from them by one edit (two from six words on; a
   changed word must be a misread, `is_misread`; the last ayah word must be matched or
   misread, so a partial quote is not "completed" with words the text does not have);
   two parts of one surah are joined across at most 3 words on each side with one edit
   (or as many misread words as the gap); a whole ayah is located (`locate`, top 3) in a
   sentence or line of at most 60 words holding a run of 3 not yet inside a part of whole
   ayat, with at least 4 words found and one changed, dropped or misread word (two from
   ten words on); and a whole ayah of 4 words is found with 3 of them in a row and the
   first or last one misread.
   *Extra* (`near_short_ayat`, `Quran.near_ayat`): a whole ayah of 3 to 7 words with one
   word misread (`is_misread`; in an ayah of 3 words, a mushaf word of 2 letters only
   counts next to a framing formula or inside quotation marks or brackets) or one inner
   word dropped (ayat of 4 words or more), every other word exact, the everyday ayat left
   out; it is a `near` part, so its difference is reported and fixed. *Extra*
   (`clitic_ayat`): a whole short ayah (3 or 4 words, or the phrase exactly an ayah) whose
   first word carries a leading و or ف (`وقل هو الله أحد`): the part is the ayah's other
   words, the first word stays with the sentence whose conjunction it carries.
4. The dictation phrases of the text around the parts (`split_phrase_spans`) are checked
   with `is_quran_phrase`. *Extra:* a phrase the voice refuses only softly (it is exactly
   an everyday formula, or it is refused only by the 90% rule or as exactly an everyday
   or two-word ayah, while its sentence as a whole is not refused: the cut isolated an
   everyday phrase such as `هذا من فضل ربي،` or `ونراه قريبا`) is joined with the phrase
   before it, else the one after it, or takes 1 to 3 words from it, when the joined
   phrase has at most `SOFT_JOIN_MAX_WORDS` (8) words and the voice guard accepts every
   phrase that results; only a formula may join another sentence. Every phrase still
   refused is searched with the rules of steps 1 and 3 until none is left (`voice_safe`
   stays True on the fixtures and on random mixes; words joined only by a tatweel or a
   zero-width character, which the voice refuses through the joined-words test and the
   finder cannot place, give False, and dictation is refused). A text that is nothing but
   an everyday formula has no neighbour, so that formula is a part.
5. Q1: without framing formulas, ayah numbers and labels (سورة + a surah name from the
   Tanzil metadata, with في or من before it; a surah name followed by a number; الآية +
   a number), every word is inside a part, every such part is whole ayat, and the parts
   other than a basmala follow each other in mushaf order.
6. A word in the Uthmani script outside every part (it cannot be placed in the mushaf)
   makes the text refused as Quran text, as before.

Comparisons inside a part:

- **Differences from the mushaf** (`differences`, `quran_writing_ops`): the dictation key
  (`writing_key`), with the Uthmani spelling of each complete display group as an
  alternative. Diacritics and the Uthmani or standard spelling do not count; a changed
  letter, a missing hamza (أ/ا, ؤ/و), ة/ه, ى/ي and a missing or extra word do.
- **The mushaf text** (`replacement`, `mushaf_text`): word-level edits that put the mushaf
  word in place of each difference, in the script closest to what was typed (Uthmani when
  the typed part uses the Uthmani script, else the Simple-Clean spelling); a dropped word
  replaces a `[?]` mark at its place. Words that already agree, labels and punctuation are
  kept, so the result equals the text when nothing differs, and analysing it again finds
  no difference.
- **Recitation** (`check_recitation`): the expected words are the typed words outside the
  parts and the mushaf (Simple-Clean) words of each part. Outside, every speech tolerance
  of `check_recitation`; inside (`rigid`), what `Quran.check` accepts: speech keys, no
  split or joined words, no numbers by value, the disjoined letters said by name.
- **Dictation** (`check_writing`): the same expected words; a Quran word is accepted in
  its Simple-Clean spelling or its Uthmani spelling (through the dictation key, with
  `strict_tashkeel` as asked), and in nothing else; every other word as before.
- **Reading chunks** (`chunks`): per ayah, at most 6 display words, near-equal, cut
  verbatim from the Uthmani line (pause marks between words kept); never across an ayah.

### asr.py

```python
class Transcriber(Protocol):
    available: bool
    def transcribe(self, pcm16k: np.ndarray, lang: Lang) -> str    # float32 mono at 16 kHz, -1..1
class SherpaWhisper:   # sherpa_onnx.OfflineRecognizer.from_whisper(encoder=..., decoder=..., tokens=..., language=lang, task="transcribe", num_threads=..., decoding_method="greedy_search")
    # SherpaWhisper(models_dir, model="turbo", num_threads=4); from_settings(settings); preload(langs);
    # model (the model in use), requested_model (the configured one), unavailable_reason.
    # Model dir: models/sherpa-onnx-whisper-{small|turbo}/{name}-encoder.int8.onnx, {name}-decoder.int8.onnx, {name}-tokens.txt.
    # from_settings uses the other model when the configured one's files are missing (logged).
    # Build one recognizer per language lazily and cache it. Never pass a prompt or hotwords.
    # Thread-safe: a lock around decoding. Clips over 28 s are cut at quiet points; clips
    # under 0.1 s are not decoded; Whisper's bracketed sound descriptions are removed.
class FakeTranscriber:  # for tests: returns a preset string; records (lang, n_samples)
class ASRUnavailable(RuntimeError)
def decode_wav(data: bytes) -> np.ndarray
# Parses RIFF/WAV integer PCM (8/16/24/32-bit) and float (32/64-bit), also EXTENSIBLE,
# mono or multi-channel (averaged), at 8 to 96 kHz, and resamples to 16 kHz (band-limited,
# FFT). Raises ValueError on a non-WAV, empty or unsupported file.
def wav_duration(data: bytes) -> float   # extra: length from the header, without decoding (the app refuses > 120 s first)
def is_empty_wav(data: bytes) -> bool    # extra: a well-formed WAV with no frame (the empty tail of a live recitation)
def audio_quality(pcm: np.ndarray) -> dict
# {"seconds": float, "rms": float, "too_quiet": bool, "too_short": bool}; too_quiet is
# decided on the speech level (RMS of the loudest 10% of 25 ms frames, at most 0.5 s of
# them) below 0.005; too_short is under 0.5 s.
```

### tts.py

```python
class Synthesizer(Protocol):
    available: bool
    def synthesize(self, text: str, lang: Lang, *, slow: bool = False) -> bytes   # WAV bytes (PCM16 mono)
class PiperTTS:   # sherpa_onnx.OfflineTts with OfflineTtsVitsModelConfig per language:
    # ar: models/vits-piper-ar_JO-kareem-medium, en: vits-piper-en_US-lessac-medium, fr: vits-piper-fr_FR-siwis-medium
    # (model .onnx, tokens.txt, data_dir=espeak-ng-data). Lazy load, cache, and lock.
    # slow=True for dictation: speed 0.7 (length_scale 1/0.7). Noise scales 0.333 (clearer speech).
    # PiperTTS(models_dir, *, num_threads=2, phonemizer=None, ...); from_settings; languages; unavailable_reason.
    # sherpa-onnx 2.x no longer runs espeak-ng: the phonemes come from an espeak-ng
    # phonemizer (piper_phonemize, or libespeak-ng through espeakng_loader or the system
    # library). Without one, available is False with a reason.
    # Refuses text in Uthmani Quranic script (QuranTextRefused, a ValueError).
    # preload(langs=LANGUAGES) (extra): loads those voices now, one lock hold per voice.
class FakeTTS
class TTSUnavailable(RuntimeError); class QuranTextRefused(ValueError); def is_quranic_script(text) -> bool
def roundtrip_ok(tts: Synthesizer, asr: Transcriber, text: str, lang: Lang, *, slow: bool = False) -> bool
# Synthesise, transcribe unprompted, and check_recitation; True when there are no errors.
def synthesize_verified(tts, asr, text, lang, *, slow, attempts) -> VerifiedSpeech(wav, ok, heard, attempts)   # extra
# Re-synthesises until the recogniser hears exactly the phrase; /api/tts serves its wav.
```

### ocr.py (extra: reading printed pages on the server, without Claude)

```python
MODEL_DIR_NAME = "ppocr-onnx"   # under models/
MODEL_FILES = {"det": "PP-OCRv6_small_det.onnx", "rec_ar": "arabic_PP-OCRv5_mobile_rec.onnx",
               "dict_ar": "ppocrv5_arabic_dict.txt", "rec_latin": "latin_PP-OCRv5_mobile_rec.onnx",
               "dict_latin": "ppocrv5_latin_dict.txt", "doc_ori": "PP-LCNet_x1_0_doc_ori.onnx"}
class PageReader(Protocol):
    available: bool
    def read_page(self, image_jpeg: bytes, lang_hint: Lang | None, *, timeout: float | None = None) -> dict
    # {"text", "lang", "notes", "contains_quran": False, "needs_manual"}: the shape of
    # Brain.read_page (the server decides about the Quran from the text).
class PPOCRReader:   # PPOCRReader(models_dir, num_threads=2); from_settings (ocr_threads); preload();
    # available / unavailable_reason (a model file, onnxruntime or cv2 missing).
    # Lazy: the onnxruntime sessions (CPU, intra-op threads = num_threads, no memory arena)
    # are made at the first page. One lock: one page at a time; read_page waits at most
    # `timeout` s for it (OCRBusy), the app passes BUSY_TIMEOUT_S (503 busy).
class FakePageReader   # for tests
class OCRUnavailable(RuntimeError); class OCRBusy(RuntimeError)
def decode_image(data) -> np.ndarray   # BGR, at most MAX_IMAGE_EDGE (2000) px, at most 4096 x 4096 px decoded
def reading_order(visual) / arabic_reading_order(text)   # an Arabic line read left to right, in reading order
def order_lines(boxes) -> list[Line]; def join_lines(lines) -> str; def tidy(read) -> str
```

Pipeline, in memory, on the JPEG `clean_image` made (upright from EXIF, at most 2000 px,
no metadata): the PP-LCNet page orientation classifier turns a page photographed
sideways or upside down (only at 0.8 confidence or more); text detection (PP-OCRv6
small det, DB) on the page reduced to 1536 px; each box cut out straight (perspective
warp) and recognised by CTC: Arabic (the hint, or most letters Arabic in the widest
boxes) by PP-OCRv5 mobile Arabic, French and English by PP-OCRv5 mobile Latin. The
Arabic recogniser reads left to right: each line is reversed into reading order, runs
of digits and Latin letters (with the signs inside numbers) kept in their own order and
each mark after its letter; a line with many marks (more than 0.25 per letter, Arabic
with tashkeel) is read again stretched 2x horizontally (the recogniser writes at most
one symbol per 8 px of input, too few for letters and marks), a mark read with
confidence under 0.6 is left out (a missing mark is easier to see than a wrong one), and
a line with Latin letters only is read by the Latin model. Boxes under 0.5 mean
confidence are dropped; a word with a letter under 0.35 is written `[?]` (the parent
types it, as for Claude's `[?]`). Lines are grouped along the page's own slope, run top
to bottom, their boxes right to left when most letters are Arabic; a paragraph's lines
are joined by spaces, and a short line or a wider space (over 1.35 times the median line
pitch) starts a new paragraph (`\n`); a first or last line that is only a number (a page
number) is left out. `lang` is "ar" for Arabic script, else the hint, else "fr" or "en"
from accents and common words. `notes` says, in the page's language, that the page was
read without AI and must be checked (the Arabic note names the tashkeel).

Models (`scripts/download_models.sh`, 31 MB, each file sha256-pinned): from the releases
of oar-ocr (Apache-2.0), PP-OCR models of PaddleOCR (Apache-2.0) in ONNX. The detector is
byte for byte PaddlePaddle's own ONNX file (Hugging Face `PaddlePaddle/PP-OCRv6_small_det_onnx`,
same sha256); the recognisers and the orientation classifier are oar-ocr's conversions of
PaddlePaddle's models (their dictionaries equal the official ones). PP-OCRv6 has no Arabic
recogniser; PP-OCRv6 small rec was as accurate as PP-OCRv5 Latin on French and English
here, at three times the size.

Measured (2026-11-13, 2 cores with `taskset -c 0,1`, onnxruntime 1.31.1, x86-64; the six
generated lesson pages of the OCR lab, Arabic in two fonts with and without tashkeel,
French and English, each as a clean 1240 x 1754 render, a phone-like photo (4 deg tilt,
keystone, uneven light, 1200 px, blur, noise, JPEG 60) and a harder one (8-9 deg, a
shadow band, 1000 px, more blur, JPEG 50); every image through `clean_image`; word
accuracy = 1 - WER, words split on spaces and punctuation, a `[?]` counted as wrong):

| page | clean | photo | harder photo | time per page (warm) |
|---|---|---|---|---|
| English | 100% | 100% | 100% | 0.9-1.2 s |
| French | 100% | 100% | 100% | 0.9-1.3 s |
| Arabic, no tashkeel (2 fonts) | 87%, 92% | 90%, 90% | 68% | 1.0-1.7 s |
| Arabic with tashkeel, marks ignored (2 fonts) | 37%, 53% | 15%, 48% | 21% | 1.0-3.4 s |
| Arabic with tashkeel, marks counted | 0%, 18% | 2%, 11% | 0% | |
| tashkeel kept (recall / precision) | 29% / 87%, 54% / 88% | 16% / 70%, 50% / 87% | 0% | |

A photo turned by 90 degrees was read upright in French (100%); in Arabic the classifier
was not sure and the page was not read (0%). The first page of a process also loads the
models (0.2-0.5 s). Memory (one process, 1414 x 2000 pages): onnxruntime and OpenCV
+64 MB when imported, the models +69 MB, about 190 MB in all after reading and a peak
of +458 MB while a page is read (the detector's activations). For comparison, the same
lab pages earlier (photo, no preprocessing; best preprocessing in brackets): EasyOCR
French 46% (95%), English 48% (95%), Arabic without tashkeel 61-68% (84-94%), with
tashkeel, marks ignored, 71-73% (82%), about 1% of the marks kept; Tesseract (best)
French 94% (99%), English 84% (100%), Arabic without tashkeel 81-87% (86-97%), with
tashkeel on the Noto font 15% (37%), 39% (71%) of the marks kept (on the other font
Tesseract failed). So: French and
English are read best by this reader, without any preprocessing; Arabic without
tashkeel about as well as the best lab setups; Arabic with tashkeel clearly worse than
EasyOCR without the marks and than Tesseract with them. A page with tashkeel should be
read by Claude (with the consent) or typed, and the parent always checks the text.

### llm.py

```python
class Brain(Protocol):
    name: Literal["claude", "offline"]
    def read_page(self, image_jpeg: bytes, lang_hint: Lang | None) -> dict
    # Printed page OCR: {"text": str, "lang": Lang, "notes": str, extra: "contains_quran": bool,
    # "needs_manual": bool}. Preserve tashkeel exactly as printed. Do not correct anything.
    # An unreadable word is written [?].
    def read_handwriting(self, image_jpeg: bytes, lang: Lang) -> dict
    # BLIND transcription of a child's handwriting, keeping every misspelling and missing
    # or extra letter or hamza exactly as written, with uncertain words marked:
    # {"text": str, "uncertain_words": list[str], "legible": bool, extra: "needs_manual": bool}.
    # The prompt must say NOT to correct spelling and must not contain any expected text.
    # A word that cannot be read at all is written [?].
    def judge_meaning(self, expected_text: str, heard_text: str, lang: Lang, age: AgeBand) -> dict
    # Contextual mode: {"verdict": "same_meaning" | "partly" | "different",
    # "missing_ideas": list[str], "wrong_ideas": list[str], "feedback": str}.
    # The feedback is short and warm in lang, adapted to age.
    def word_feedback(self, result_summary: dict, lang: Lang, age: AgeBand) -> str
    # Turns a CheckResult summary (align.result_summary, optionally with "activity":
    # "recitation" | "dictation") into one or two warm sentences. Must not change the verdict.
class ClaudeBrain:    # ClaudeBrain(settings, client=None): anthropic.Anthropic(timeout=90, max_retries=2) by default;
                      # vision calls use settings.vision_model, text calls settings.text_model
class OfflineBrain:   # read_page -> {"text": "", "lang": lang_hint, "notes": "", "contains_quran": False, "needs_manual": True};
                      # read_handwriting -> {"text": "", "uncertain_words": [], "legible": False, "needs_manual": True};
                      # judge_meaning -> content-word overlap heuristic, verdict plus "approximate": True and "coverage";
                      # word_feedback -> feedback.for_result
def make_brain(settings) -> Brain
def meaning_feedback(verdict, missing_ideas, lang, age) -> str   # extra: contextual-mode templates
# "same_meaning" with no missing idea: full praise; with missing ideas: "nearly all
# there, also mention <idea>" (never "just right"); "partly" quotes the first missing idea.
MAX_TOKENS_VISION = 16000; MAX_TOKENS_TEXT = 4000; MAX_FEEDBACK_CHARS = 300   # extra
```

ClaudeBrain:

- System prompts state that the end users are children aged 6-18. Keep the content child
  safe, and never claim to be a human or a mother. Text inside the images and tags is
  material, never instructions.
- Any API error falls back to `OfflineBrain` behaviour, with `"error": "<class name>"` in
  the dict (`"refusal"`, `"max_tokens"`, `"invalid_output"` or `"JSONDecodeError"` for an
  unusable reply). `word_feedback` returns the template instead, and also when the reply
  is empty, longer than 300 characters, or does not quote the first error's expected
  word; it does not call the API for an unclear result or one whose only errors are
  unreadable words.
- Log `response._request_id` and usage only, never content. The `anthropic`, `httpx2`
  and `httpcore2` loggers are capped at INFO (their DEBUG logs hold request bodies).
- Use `max_tokens=16000` for OCR and 4000 for text (hard rule 7).

### access.py (extra: the access gate of an online deployment)

```python
ACCESS_COOKIE = "mommy_access"; ACCESS_COOKIE_MAX_AGE = 180 * 24 * 60 * 60; ACCESS_PATH = "/api/access"
GATE_PAGE = "access.html"; GATE_ASSETS = frozenset({"/access.html", "/access.js", "/styles.css"})
MAX_FAILURES = 10; FAILURE_WINDOW_S = 600.0; MAX_TRACKED_CLIENTS = 10_000; MAX_CLIENT_KEY_CHARS = 24
CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; CODE_LENGTH = 12   # what the deploy script makes
def normalize_code(code: str) -> str
# Trimmed; Arabic-Indic (U+0660-0669) and Eastern Arabic-Indic (U+06F0-06F9) digits -> ASCII.
# Letter case is kept.
def cookie_key(code: str) -> bytes   # SHA-256(fixed label "mommy access cookie v2\0" + normalize_code(code))
def host_key(host: str) -> str       # a Host value as a cookie names it: lower case, no port, brackets or trailing dot
def cookie_value(code: str, host: str) -> str
# HMAC-SHA256(cookie_key(code), "mommy_access" + NUL + host_key(host)), base64url without
# padding (43 characters). Depends on the code and the host name only: a restart keeps
# people in, a new code invalidates every cookie, and a cookie given for one host opens
# no other (browsers send a localhost cookie to every port of localhost over plain http,
# so a local server could read it: it must not open the tunnel's or a Space's host).
# No session list is kept.
def client_key(host: str | None) -> str
# The key a client's wrong codes are counted under, for request.client.host: an IPv4
# address (also written IPv4-mapped), any other IPv6 address as its /64 network
# ("2001:db8::/64": one line has a whole /64, and other spellings are the same client),
# "unknown" without an address, "other" for anything that is not an IP address. At most
# MAX_CLIENT_KEY_CHARS characters, whatever X-Forwarded-For held.
def is_public_client(key: str) -> bool   # a globally routed address or network
class FailureLimiter(*, max_failures=10, window_s=600.0, max_clients=10_000, clock=time.monotonic)
    def retry_after(self, client: str) -> int | None   # seconds (>= 1) while blocked, else None
    def record_failure(self, client: str) -> int       # failures of the client in the window
    def clear(self, client: str) -> None
# A sliding window per client; an LRU of the clients that failed most recently, at most
# max_failures timestamps each: the memory is bounded whatever the number of clients.
class AccessGate(code: str, web_dir: Path | None, *, limiter: FailureLimiter | None = None)
    limiter: FailureLimiter; page: bytes | None    # the code itself is not kept, only cookie_key(code)
    def code_matches(self, candidate: str) -> bool   # constant time (compares the two keys)
    def cookie_for(self, host: str) -> str           # cookie_value(code, host)
    def has_access(self, headers) -> bool            # the mommy_access cookie for the request's Host, constant time
    # Every Cookie header and every mommy_access value in them is a candidate
    # (access_cookie_values): split cookie fields and a same-named cookie do not hide it.
def access_cookie_values(headers) -> list[str]
class AccessGateMiddleware(app, gate: AccessGate)    # pure ASGI, see "Access gate" below
def is_navigation(headers) -> bool
# Sec-Fetch-Mode: navigate; for a client without fetch metadata, an Accept with text/html.

# Allowed host names (MOMMY_ALLOWED_HOSTS), used by app.HostOriginMiddleware:
MIN_SUFFIX_LABELS = 2; MAX_HOST_NAME_CHARS = 253
SUFFIX_PORTS = frozenset({None, "80", "443"})   # the ports a Host may name for a suffix entry
def host_entry(entry: str) -> str
# One entry, normalized. An exact entry: trimmed, lower case, IPv6 brackets removed
# ("[::1]" -> "::1"), as before suffix entries existed. A suffix entry starts with a dot
# and keeps it (" .TryCloudflare.com. " -> ".trycloudflare.com": lower case, no trailing
# dot). ValueError for a suffix of fewer than MIN_SUFFIX_LABELS labels (".com", ".", ".."),
# a country's public second level (".co.uk", ".com.au": two labels, a two-letter last
# one, a first one of ac co com edu go gob gov gv ne net or org), one that is not a host
# name (an empty label, "_", a hyphen at a label's edge), non-ASCII (write the xn-- form),
# one that ends in a number (".0.1"), and for a "*" wildcard anywhere.
def split_host(value: str) -> tuple[str, str | None]
# (name, port or None) of a Host value or an origin's host part; "[::1]:8080" ->
# ("::1", "8080"); more than one colon without brackets is a bare IPv6 address.
def is_dns_name(name: str) -> bool   # lower-case ASCII labels [a-z0-9-], 1-63 each, no edge hyphen, at most 253
class HostMatcher(entries: Iterable[str])     # ValueError for an entry host_entry refuses
    exact: frozenset[str]; suffixes: tuple[str, ...]
    def allows_name(self, name: str) -> bool  # a name without the port
    def allows_host(self, host: str) -> bool  # a Host value: any port for an exact entry, SUFFIX_PORTS for a suffix one
    def matches_suffix(self, host: str) -> bool   # allowed through a suffix entry only (a quick tunnel's name)
    def same_origin(self, origin: str, host: str, *, https_only: bool = False) -> bool
# allows_name: a name that is not ASCII never matches (so no Unicode case folding, such
# as the Kelvin sign or a fullwidth dot, can make an allowed name). An exact entry
# matches the name in lower case, exactly as before (no trailing-dot folding: the
# decisions for exact entries are those of the old check, tests/test_selfhost.py). A
# suffix entry matches a name, in any case and with one trailing dot dropped, whose labels
# are all valid (is_dns_name) and that ends with the entry and has at least one more
# label: "abc.trycloudflare.com", "a.b.trycloudflare.com", "ABC.TryCloudflare.COM:443",
# "abc.trycloudflare.com."; never "trycloudflare.com" itself, "evil-trycloudflare.com",
# "trycloudflare.com.evil.com", "a..trycloudflare.com", "abc_x.trycloudflare.com" or a
# name with a Cyrillic look-alike letter.
# allows_host: for a suffix entry the Host must name no port or a default one
# (SUFFIX_PORTS; "abc.trycloudflare.com:8080" is refused). A tunnel's requests never name
# another; a page under the suffix whose name a hostile resolver points at 127.0.0.1
# (DNS rebinding) would name the local port. An exact entry ignores the port, as before.
# same_origin: origin is "http://" or "https://" followed by an allowed host (allows_host)
# and the same host as the request's Host value (lower case, a trailing dot on the name
# dropped on both sides, the same port or none on both). "null", a path (even "/"), user
# information, another scheme, another port and another name under the same suffix
# entry (someone else's tunnel) are not the same origin. With https_only (the gate is
# on), an "http://" origin is the same origin only for a loopback host.

# The access code file (MOMMY_ACCESS_CODE_FILE; config.code_from_file decides when):
CODE_FILE_MAX_BYTES = 1024; CODE_FILE_MODE = 0o600; CODE_FILE_SETTLE_S = 1.0
def generate_code() -> str
# CODE_LENGTH (12) characters of CODE_ALPHABET, each from secrets.choice (about 59 bits).
def read_code_file(path: Path, *, settle_s: float | None = None) -> str
# The file's text, trimmed (str.strip; a UTF-8 BOM dropped); may be short or empty: the
# caller checks. FileNotFoundError when missing; ValueError (naming the file, never its
# content) for a file that cannot be read, is over CODE_FILE_MAX_BYTES, is not UTF-8 or
# holds more than one line. An empty file is read again for up to settle_s seconds
# (default CODE_FILE_SETTLE_S): a writer without hard links creates it, then writes it.
def create_code_file(path: Path) -> str | None
# A new code in path unless it exists; returns it, or None when the file already existed
# (another process made it first: read that one). The code is written to a temporary
# file of mode 0600 in the same directory (fsync'ed), then hard-linked to path (a link
# never replaces a file), so no reader sees a partial file and two processes that start
# together end with one code; the temporary file is always removed. Without hard links
# (some FUSE or network file systems), O_CREAT | O_EXCL with mode 0600, then the write.
# OSError when the directory is missing or not writable.
def replace_code_file(path: Path, code: str) -> None
# The code (mode 0600) put in place of the file's, atomically (a temporary file renamed
# over it: a reader sees the old code or the new one). share_link --new-code uses it.
```

### share_link.py (extra: the link to share a self-hosted Mommy)

Run inside the app's container, from the `mommy/` directory:
`docker compose exec mommy python -m mommy.share_link` (`--new-code` for a new code).

```python
DEFAULT_METRICS_URL = "http://tunnel:2000"   # env MOMMY_TUNNEL_METRICS_URL replaces it
QUICKTUNNEL_PATH = "/quicktunnel"; READY_PATH = "/ready"
DEFAULT_WAIT_S = 60.0; POLL_INTERVAL_S = 1.0; REQUEST_TIMEOUT_S = 3.0; MAX_ANSWER_BYTES = 4096
SHARE_COMMAND = "docker compose exec mommy python -m mommy.share_link"
RESTART_COMMAND = "docker compose restart mommy"
REPAIR_COMMAND = "docker compose run --rm mommy python -m mommy.share_link --new-code"
REMINDER = "Reminder: this link changes when the tunnel restarts (after a reboot, for example), but the code stays the same: run this command again to get the new link."
EXIT_OK = 0; EXIT_NO_CODE = 1; EXIT_USAGE = 2; EXIT_NO_TUNNEL = 3
class TunnelError(Exception)              # the message says why, for the owner
@dataclass(frozen=True)
class Tunnel:
    hostname: str        # lower case
    ready: bool | None   # connected to Cloudflare; False: not when the wait ended; None: no /ready
def share_link(hostname: str, code: str) -> str   # "https://<hostname>/#code=<code>", the code percent-encoded
def parse_hostname(body: bytes) -> str
# The name in a /quicktunnel answer ({"hostname": "..."}), lower case, without an
# "https://" prefix or a trailing dot; "" for an empty name. ValueError for anything else
# (not JSON or UTF-8, no "hostname" string, not a host name with a dot in it).
def wait_for_tunnel(metrics_url=DEFAULT_METRICS_URL, *, wait_s=60.0, interval_s=1.0,
                    request_timeout_s=3.0, clock=time.monotonic, sleep=time.sleep,
                    on_wait=None) -> Tunnel
METRICS_PATH = "/metrics"; MAX_METRICS_BYTES = 1 << 20; OLD_TUNNEL_MONTHS = 9
def tunnel_version(metrics_text: str) -> tuple[str, int, int] | None   # (version, year, month) of build_info
def old_tunnel_note(metrics_text: str, today: datetime.date) -> str | None
def read_metrics(metrics_url: str, *, request_timeout_s=3.0) -> str     # "" unless 200
def main(argv=None, *, env=None, stdout=None, stderr=None, interval_s=POLL_INTERVAL_S, today=None) -> int
```

- The code: as the app reads it (`config.access_code_from(env, create=False)`):
  `MOMMY_ACCESS_CODE` if set, else the file `MOMMY_ACCESS_CODE_FILE`. This command never
  makes the file (a code the running app does not have would open nothing): when it is
  missing it says the app makes it at its start (exit 1); a bad file is reported with
  `REPAIR_COMMAND` (exit 1), or, when the code comes from `MOMMY_ACCESS_CODE`, with
  "Change MOMMY_ACCESS_CODE where it is set"; with neither variable it says so (exit 1).
  The tunnel is asked only once the code is good.
- The tunnel: cloudflared's metrics server (`compose.yaml`: `--metrics 0.0.0.0:2000`, the
  port not published). `GET /quicktunnel` answers `{"hostname":"<name>.trycloudflare.com"}`
  (as `text/plain`); then `GET /ready` answers 200 once the tunnel is connected to
  Cloudflare and 503 before. No answer (refused, unknown name, timeout, a dropped
  connection) and an HTTP status other than 200 and 404 are retried every second for up
  to 60 s (`--wait SECONDS` changes it; one "Waiting for the tunnel to start" line on
  standard error the first time). A 404 for `/quicktunnel` (not cloudflared, or a version
  without it), a malformed answer or an empty name (cloudflared runs without a quick
  tunnel) stop at once. No name in time: exit 3. A name but `/ready` still 503 at the end:
  the link is printed with a warning that the tunnel is not connected yet; a `/ready`
  that answers anything else (404) is not waited for. The requests ignore `HTTP_PROXY`
  and the like (the metrics server is on the compose network).
  Checked on cloudflared 2026.10.7, the version `compose.yaml` pins: the binary started
  against a fake quick-tunnel service (its hidden `--quick-service` flag) answered
  `/quicktunnel` with `{"hostname":"fancy-words-here-test.trycloudflare.com"}`, `/ready`
  with `503 {"status":503,"readyConnections":0,...}` while it had no edge connection,
  and any other path with `404 page not found`; the fake server of the tests answers the
  same way. The metrics server also answers `/metrics`, `/healthcheck`, `/config` (the
  ingress rules), `/diag/*` (tunnel and connector ids, every flag) and Go's `/debug/vars`
  and `/debug/pprof/` (profiles on demand); no tunnel secret was among them. Its port is
  not published, so other devices cannot reach it; the app's container can, and on a
  Linux host so can local programs (Docker's bridge, even an `internal` network's, has
  an address on the host: checked on Engine 29.9, where the host reached a container on
  an internal network). With Docker Engine 28 or later (SELF_HOST.md's Linux note),
  devices of the local network cannot route to it.
- Output: standard output gets the link `https://<name>/#code=<code>` and `REMINDER` on
  the next line (`--link-only`: the link alone); waiting notes, warnings and errors go to
  standard error. Once the tunnel has a name, `GET /metrics` gives cloudflared's
  `build_info` (`version="2026.10.7"`: its release's year and month); when that is more
  than `OLD_TUNNEL_MONTHS` (9) months before today, a note on standard error says that
  Cloudflare supports a release for about a year and to take the latest Mommy files (the
  pin moves with `scripts/refresh_pins.py`). No answer or no `build_info`: no note. When `MOMMY_ALLOWED_HOSTS` would refuse the name (the app would answer
  `400 bad_host`), a warning says to add `.trycloudflare.com`. Exit 0 with a link, 1
  without a usable code, 2 for a wrong option, 3 when the tunnel gave no name. Nothing is
  logged; the code appears only in the link's fragment.
- `--new-code`: writes a new code (`generate_code`, `replace_code_file`: atomic, mode
  0600) to `MOMMY_ACCESS_CODE_FILE` (made if missing), prints "A new access code is saved
  in <file>.", "Restart the app so that it uses the new code (the old link then stops
  working):", `    docker compose restart mommy`, "Then share the new link:", then the new
  link and `REMINDER` as above. The app reads the code at its start, so the old code and
  every cookie given for it stop working at the restart; the tunnel, and so its name,
  keeps running. Refused (exit 1, the file untouched) when `MOMMY_ACCESS_CODE` is set (it
  would win over the file), when `MOMMY_ACCESS_CODE_FILE` is not set, and when the file
  cannot be written. When the tunnel does not answer, the new code is still saved and the
  error says to run the command again (without `--new-code`) for the link.

## HTTP API (FastAPI, `app.py`: `create_app(settings, transcriber, tts, brain, quran) -> FastAPI`)

- All JSON responses use UTF-8 (`application/json; charset=utf-8`).
- Errors return `{"error": "<code>", "message": "<human text>"}` with status 400, 403,
  413, 422, 501 or 503 (online also 401 `access_required` and 429 `too_many_attempts`,
  see "Access gate"); unknown paths and methods get 404 and 405, an internal error a
  JSON 500 (logged as a class name and code location only). Error messages never quote
  the text that was sent.
- Upload limits: audio at most 10 MB and 120 s (read from the WAV header before
  decoding; extra: one phrase of `/api/recite/phrase` at most 4 MB and 30 s), images at
  most 8 MB (JPEG or PNG), text fields at most 20,000 characters and 3,000 words
  (`heard_before` too), `/api/tts` text at most 400 characters, Quran ranges at most 50
  ayat. Request bodies are bounded before parsing (audio routes 10 MB + 256 KB,
  `/api/recite/phrase` 4 MB + 256 KB, image routes 8 MB + 256 KB, JSON 256 KB).
- Uploads are read into memory and never saved: Starlette's spool-to-disk threshold is
  raised above the largest body accepted.
- Line breaks: a browser sends the line breaks of a form field as `\r\n`, while a
  textarea's value holds `\n`. Every multipart text field (`expected_text`,
  `written_text`, `heard_text`) and every text a reader returns (`/api/page/read` `text`
  and `notes`, the `read_text` of a photo) has its line breaks turned into `\n` first, so
  `read_text` and the offsets of `quran_parts` refer to the text the client holds. (A
  dictation typed on two lines could never be confirmed: its `read_text` came back with
  `\r\n` and always looked edited.) JSON bodies are taken as sent.
- Every image is decoded and re-encoded server-side as a new JPEG: turned upright from
  its EXIF orientation, reduced to 2000 px on the long edge, without any metadata (EXIF,
  XMP, IPTC, ICC, comments, PNG text, trailing data). At most 4096 x 4096 pixels (50 MP
  for a JPEG, decoded at a reduced scale). At most two image or audio decodes run at
  once (503 `busy` after 30 s).
- The server answers only to `Settings.allowed_hosts` (400 `bad_host` otherwise), and a
  non-GET `/api/*` request with an `Origin` header other than the server itself gets 403
  `bad_origin`. Both decisions are `access.HostMatcher`'s (`HostOriginMiddleware`): an
  exact entry decides as before; a suffix entry (extra, a leading dot, such as
  `.trycloudflare.com` in `compose.yaml`) lets in any name under it, never the domain
  itself, and only with no port or a default one in `Host` (DNS rebinding to the local
  port is refused), and the `Origin` of a write must still be the request's own `Host`
  (another quick tunnel under the same suffix is another site). With the access gate on,
  an `http://` `Origin` is accepted only for a loopback host (online every page is
  HTTPS), and a request for a suffix-entry name that the proxy received over plain http
  (`X-Forwarded-Proto: http`, which cloudflared passes on from Cloudflare's edge) is not
  served: a `GET`/`HEAD` that is not `/api/*` gets `308` to `https://<name><path>` (the
  name as matched, no port), anything else `400 https_required`. Exact entries are not
  redirected (Caddy redirects its own port 80; a Space is HTTPS). An entry the matcher
  refuses stops the app at its start. Every response has `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors
  'none'`; every `/api/*` response has `Cache-Control: no-store`, and every other
  response that sets none (the web client's files) `Cache-Control: no-cache`
  (`STATIC_CACHE_CONTROL`): a browser asks again (a 304 with the `ETag`) before it reuses
  a file, so after an update an older `app.js`, which sends no `ai_consent`, does not keep
  running across reloads (with the gate, its own `private, no-cache` is kept).
- **Access gate (extra, online only; `access.py`).** With no access code (`MOMMY_ACCESS_CODE`
  unset or blank, and `MOMMY_ACCESS_CODE_FILE` unset or blank) there is no gate, no
  `/api/access` (404) and nothing below applies. With a code (the variable, or else the
  code file, `config.access_code_from`):
  - Every request needs the cookie `mommy_access` for its `Host` (`cookie_value(code, host)`), except `GET`
    and `HEAD` of the gate's own files (`/access.html`, `/access.js`, `/styles.css`,
    exact paths) and `POST /api/access`.
  - Without it: an `/api/*` request gets `401 {"error": "access_required", "message"}`
    (the usual error shape, `Cache-Control: no-store`); an HTML navigation (`GET`/`HEAD`,
    `Sec-Fetch-Mode: navigate`, or an `Accept` with `text/html` from a client without
    fetch metadata) gets the gate page `web/access.html` with status 200 at whatever path
    it asked for (no redirect, so the `#code=...` fragment stays in the browser) and
    `Cache-Control: no-store`; any other request gets 401 `access_required`. No endpoint
    and no static file runs, and the request body is never read.
  - With it, every response that is not `/api/*` and sets no `Cache-Control` gets
    `Cache-Control: private, no-cache`: a browser asks again (through the gate) before
    reusing a cached page, so a changed code shows the gate page, never a stale app.
  - Middleware order (`create_app`; Starlette runs the last added first): ResponseHeaders
    -> HostOrigin -> AccessGate -> RequestGuard -> routes. The security headers are on the
    gate's answers too; an unknown `Host` is refused before the gate, and `POST
    /api/access` is a write like any other (403 `bad_origin` from another site's page);
    RequestGuard bounds its body (256 KB) and answers its errors.
  - `POST /api/access`, JSON `{"code": str}`: the code is compared in constant time after
    `normalize_code` (trimmed; Arabic-Indic and Eastern Arabic-Indic digits as ASCII).
    Right: `204` with `Set-Cookie: mommy_access=<tag>; HttpOnly; Max-Age=15552000;
    Path=/; SameSite=lax`, plus `Secure` (see below), and the
    client's failures are cleared. Wrong: `403 {"error": "bad_access_code", "message"}`.
    Missing or invalid body: 422 as everywhere (not counted). A client with 10 wrong codes
    in the last 10 minutes gets `429 {"error": "too_many_attempts", "message"}` with
    `Retry-After` (seconds until its oldest failure is 10 minutes old), even for the right
    code; at most 10,000 clients are remembered (LRU).
  - The cookie is `Secure` unless the request's host is a loopback one (`localhost`,
    `*.localhost`, `127.0.0.0/8`, `::1`; `is_loopback_host`), and also then over https:
    online the page is HTTPS whatever `X-Forwarded-Proto` the proxy sends (uvicorn takes
    only an exact `https`), so the cookie never goes over plain http; over plain http the
    gate works on a loopback host only (the local test of the image). Online, every
    response for a host that is not a loopback one also has `Strict-Transport-Security:
    max-age=31536000` (`ResponseHeadersMiddleware(hsts=True)`; never without the gate).
  - Self-hosted (`compose.yaml`): the code comes from `MOMMY_ACCESS_CODE_FILE`
    (`/data/access-code`, made at the first start, kept in the volume), and the link is
    printed by `python -m mommy.share_link` (see share_link.py). Requests from the
    computer itself (`http://localhost:8080`, published on 127.0.0.1 only) get no
    exemption: they pass the gate like any other, with the same code (the share link
    opened on that computer, or the same `#code=...` fragment after
    `http://localhost:8080/`); there the cookie is not `Secure` and there is no HSTS,
    since the host is a loopback one.
  - The client is `client_key(request.client.host)`, as uvicorn's `--proxy-headers` set
    it from `X-Forwarded-For` for a trusted proxy (`--forwarded-allow-ips`). The image
    (`scripts/space_start.sh`) trusts the private and shared networks (10/8, 172.16/12,
    192.168/16, 100.64/10, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10; the Space
    variable `MOMMY_FORWARDED_ALLOW_IPS` replaces the list): uvicorn then takes the
    right-most address that is not one of them, the one the proxy appended, so what a
    visitor writes to its left neither gives it a fresh count nor uses up another
    visitor's. Never `'*'` by default: uvicorn would take the left-most entry, which the
    visitor writes. `compose.yaml` sets `MOMMY_FORWARDED_ALLOW_IPS=container-networks`
    instead: `space_start.sh` runs `python -m mommy.proxies`, which trusts only the networks
    the container is attached to (the project's own compose network, read from the
    routing tables at start) without their gateways (the default route's gateway and each
    network's first address, where Docker puts it): the network's other member is the
    tunnel, while the gateway is the computer's side, from which Docker's forwarding of
    the published port and any local program connect. Their `X-Forwarded-For` is not
    believed, so a local program can neither pick a fresh failure count nor use up a
    visitor's. Behind a proxy
    whose address is not trusted, every visitor is the proxy (one shared failure limit):
    the first wrong or right code from a private or unknown address, for a host that is
    not a loopback one, logs one warning that says so (no address). The limit is defence in depth; the protection is the code (12
    characters out of 31, about 59 bits).
  - Logs: "access code accepted", "refused a wrong access code (n of 10 in the window)",
    "access code attempts paused for a client", and once the private-address warning;
    these lines never carry the code, the cookie or the client's address. (A refused
    `Host` is logged by HostOriginMiddleware with the name received, quoted and cut to
    80 characters: it tells the owner what `MOMMY_ALLOWED_HOSTS` lacks.) The code never appears in a URL the server sees, so
    uvicorn's access log cannot show it either (`tests/web/access.cjs` checks the log).
- **AI consent (extra; hard rule 5).** The endpoints whose handling can reach the Claude
  brain, `/api/page/read`, `/api/recite/check` and `/api/dictation/check` (every call of
  `read_page`, `read_handwriting`, `judge_meaning` and `word_feedback`), take an optional
  form field `ai_consent` (`app.ai_consent_given`, a dependency of the three). Only the
  exact value `"1"` in the form body (multipart or urlencoded) counts; a field sent more
  than once counts only when every copy is `"1"`. Everything else is no consent: no field
  (a client that does not know it, such as a tab still running an older `app.js`), an
  empty value, `"0"`, `"true"`, `" 1 "`, a file part, `"1"` beside any other value, and
  `ai_consent=1` in the query string, which is never read. Without the consent the request
  is answered by `OfflineBrain` exactly as by a server without Claude, and the Claude
  brain is not called at all: a page photo is read by the local page reader on the
  server (extra, `ocr.py`: `"reader": "local"`, `"source": "offline"`; see "Local page
  reading" below), or, without it (`MOMMY_OCR=off`, no OCR models), comes back with
  `"source": "offline"`, `"reader": "none"`, `"needs_manual": true` and no text; a photo
  of handwriting gets `501 needs_manual`; a
  typed dictation check and a recitation word by word get the offline templates
  (`feedback.for_result`); a recitation by meaning gets the offline heuristic, with
  `judgement.approximate: true`. With the consent, on a server without Claude, nothing
  changes either. Every answer of the three endpoints has `"brain": "claude" | "offline"`,
  the brain that had the request: `"offline"` means that nothing of it went to Claude (no
  consent, or no Claude on the server); `"claude"` means the Claude brain had it (it may
  still fall back to the offline answer after an error, see `brain_error`, `source` and
  `judgement.approximate`, and it is not called for a result that needs no wording from
  it, such as a mistake in a Quran part or an unclear recording). Error answers have no
  `brain`. `/api/health` `brain` still says what the server has. The log line of each of
  these requests names its brain ("recite/check strict en: brain offline, ...",
  "dictation/check fr: brain claude, ...", "page/read: image ... bytes, brain claude, source
  claude, reader claude, ..."), never a text, the age group or the code.
- **Local page reading (extra; `ocr.py`, `MOMMY_OCR`, default on; `/api/health` `ocr`).**
  `/api/page/read` decides who reads the photo, for each request: Claude when the
  request carries the AI consent and the server has Claude (as before); otherwise, and
  also when a Claude call failed (`brain_error`), the local reader on this server when
  `/api/health` says `"ocr": true`; otherwise nobody (the parent types the text). The
  answer has the same fields whoever read it, plus `"reader": "claude" | "local" |
  "none"`; `brain` keeps its meaning (`"offline"`: nothing of the request went to
  Claude), and `source` too (`"claude"` only for a text Claude read; a local reading is
  `"offline"`, the server's own). The text a local reading returns goes through exactly
  the same steps as Claude's: line breaks as `\n`, `[?]` counted (`unreadable_marks`),
  and, with Arabic and the Tanzil text, `guard.find_quran_parts` decides
  `contains_quran`, `quran_parts`, `mushaf_text` and `quran_range` (the reader's own
  `contains_quran` is always false). The local reader reads one page at a time; a request
  that waits more than 30 s for it gets `503 busy`; a failure of the reader (a class name
  in `reader_error`) gives the "type the text" answer. The image is the cleaned JPEG
  (`clean_image`), read in memory and never written or logged; the log line names the
  reader ("..., reader local, ...") and `ocr.py` logs sizes, counts and timings only
  ("ocr: image N bytes, B boxes, L lines, C chars, turned D, wait, read"). With Claude
  and the consent, Claude stays first: it reads Arabic with tashkeel far better than the
  local reader (see ocr.py), and the parent chose it; for French and English the local
  reader was as accurate on the measured pages, so a later version may prefer it for
  them. `MOMMY_OCR=off`: the reader is never made (no models loaded), `"ocr": false`,
  `reasons.ocr` = "MOMMY_OCR is off", and a photo without Claude needs typing as before.
- **Live recitation (extra; `MOMMY_LIVE_RECITE`, default on; `/api/health`
  `live_recite`).** While the child reads, the web client cuts the recording into phrases
  at the pauses (`recorder.js`, `PhraseSegmenter`) and sends each one to `POST
  /api/recite/phrase` with `heard_before`, the transcripts of the phrases before it, which
  the client holds (the server keeps nothing between requests). The recogniser decodes
  that phrase only and is given its audio and the language, nothing else (hard rule 1:
  never the expected text, never `heard_before`, never a prompt). In strict mode the
  answer's `progress` is the word-by-word check of `heard_before` + the phrase against the
  whole text, by the same analysis as `/api/recite/check` strict (`QuranAnalysis.check_recitation`:
  the Quran parts against the mushaf words), turned by `align.reading_progress` into the
  words read so far (`match`, `sub`, `del`, `ins`) and the words after the last one the
  child reached, `"pending"`. No brain is used (`"brain": "offline"`, no AI consent read,
  no feedback), and nothing is logged but sizes and timings ("recite/phrase strict en:
  audio N bytes, S s, after N words, decode, asr, check, total"). At Stop the client sends
  only the tail (the phrases still queued and what came after the last phrase) to
  `/api/recite/check` with `heard_before`: the server decodes the tail alone and checks
  `heard_before` + the tail exactly as a whole recording (feedback, Claude only with
  `ai_consent=1`, `quran_parts`, `say_again`, meaning judged on the joined text). The
  field is told apart by its presence in the form (`app.heard_before_sent`), so an empty
  `heard_before` (the earlier phrases were heard as nothing) is still a tail, while an
  older client, which never sends it, is answered exactly as before. A tail with nothing
  said after the last phrase is a WAV with no samples (accepted only with `heard_before`;
  without it, `400 bad_audio` as before). Quality (`app.live_quality`): `seconds` and
  `rms` are the tail's and the tail alone decides whether it is decoded (too quiet or
  under 0.5 s: not decoded), but `too_quiet` and `too_short` say whether the recitation
  could be heard: false whenever `heard_before` has a word (those phrases were loud and
  long enough to be recognised, while a child who stops just after the last pause sends
  a tail of a fraction of a second, or none); with nothing heard before, the tail's own
  flags stand (no samples at all: both true, verdict `"unclear"`). Off
  (`MOMMY_LIVE_RECITE=off`), `/api/recite/phrase` does not exist (`404 not_found`), and
  the client sends the whole recording; `heard_before` is still accepted by
  `/api/recite/check`.

  Measured (2026-11-13, Whisper turbo int8, `MOMMY_ASR_THREADS=2` pinned to 2 cores with
  `taskset`, Piper-spoken texts of 4 sentences with 0.8 s pauses, the web client's own
  `PhraseSegmenter` run on the audio, the real app): the segmenter cut every text into its
  4 sentences. Errors of `check_recitation` (sub + del + ins), whole clip / phrase by
  phrase, on 4 texts per language: en 0 / 1 of 125 words, fr 2 / 2 of 130, ar 29 / 31 of
  99 (the Arabic voice itself is
  hard to recognise; the differences are recogniser noise on the same unclear words, the
  phrase decode loses the context of the sentence before). Decode time: a whole 13-19 s
  recording 5.1 s (en), 6.0 s (fr), 7.9 s (ar) on average; one phrase of 2.4-4.2 s 1.6 s,
  1.8 s, 2.2 s (at most 2.5 s). From the end of a phrase to its words coloured: 1.9-3.1 s
  (0.65 s of silence to detect the end, then the decode). From Stop to the result: old
  way 5.2-8.5 s; live, Stop 1 s after the last word 1.3-2.0 s (the last phrase was already
  being decoded, the tail is empty), Stop 0.3 s after it 1.8-2.3 s (the tail, the last
  phrase, is decoded). End to end in Chromium with a fake microphone (the real server,
  warm, Stop 1 s after the last word): en 5.4 s -> 1.9 s, ar 9.4 s -> 1.9 s. On one core
  with one thread: a whole 18.9 s Arabic recording 14.6 s, its last phrase (4.2 s) 4.1 s.
  Whisper writes words on silence and noise when it is given them ("Thank you.", "Sous-titrage
  ST' 501", "ترجمة نانسي قنقر", "اشتركوا في القناة"): the segmenter sends no phrase for
  silence, room noise or steady noise at -40 dBFS, and the server's quality gate does not
  decode silence or room noise (too quiet) or a clip under 0.5 s; a louder noise that
  passes both would still reach the recogniser, as in a whole recording.
- Text checks on the general endpoints (recite, dictation, phrases, TTS, text check), in
  this order: 400 `bad_text` (a lone UTF-16 surrogate), 400 `text_too_long` (over
  20,000 characters; checked before the words, so a text that is too long and has no
  word is `text_too_long`), 400 `empty_text`, 400 `text_too_long` (over 3,000 words),
  400 `unreadable_text` (the text has `[?]` marks: the parent types the
  missing words first), 422 `quran_text` (the Quran guard of the use, below), 422
  `lang_mismatch` (most letters Arabic and `lang` is not `ar`, or `lang` is `ar` and
  there is no Arabic letter: the recogniser would translate the speech, and a voice
  cannot read the other script).
- Quran in the texts of the general endpoints (hard rule 4; `guard.py`). Every endpoint
  that takes a text runs `guard.find_quran_parts` on it (the client's view of the parts
  is never used), then:
  - **A text that is Quran (Q1)**, or one with a word in the Uthmani script outside its
    Quran parts, gets `422 {"error": "quran_text", "message", "quran_range"?}` in every
    mode of every general endpoint. `quran_range` (`{"surah", "from", "to"}`) is there
    when the ayat are one range of one surah, for opening the Quran section or a Quran
    task on it. Without the Tanzil text only the script test is possible (a text in the
    Uthmani script is refused).
  - **A school text with Quran parts (Q2)** is accepted word by word (`/api/recite/check`
    strict, `/api/dictation/check`) and for dictation (`/api/dictation/phrases`, a
    grown-up reads each part); refused by meaning (`/api/recite/check` contextual, and
    `/api/text/check` mode `contextual`: `422 {"error": "quran_text", "message":
    QURAN_MEANING_MESSAGE, "reason": "meaning"}`, no scope; extra: the `reason` tells it
    from a text that is Quran, so a client says "word by word only", never "the Quran
    section"). `/api/text/check` and `/api/page/read` list its parts.
  - **The voice** (`/api/tts`; `is_quran_phrase`, as built, plus the review fixes: a
    short ayah with one misread or dropped word, `near_short_ayat`; a short ayah after a
    leading و/ف, `clitic_ayat`; and words joined by a hyphen, an apostrophe, the Arabic
    letter mark, a tatweel or a zero-width character, tested apart): `looks_like_quran` (the
    Uthmani script; a run of 5 consecutive Quran words; a run of 3 in a framing
    formula's neighbourhood: it starts at most 4 words after an opening formula or ends
    at most 4 words before صدق الله العظيم, and does not pass through an everyday
    formula; at least 4 words of which 90% are found in order at one place), a phrase
    that is exactly a whole ayah of 2 words or more, or the **contained-ayah rule** (a
    whole ayah of K = 3 or 4 words among the phrase's words; the 8 `EVERYDAY_AYAT` do not
    count inside a longer phrase, and two-word ayat such as ثم نظر count only as a phrase
    of their own). The dictation client never sends a Quran part to `/api/tts`; a client
    bug still cannot make the voice read one.
  - **By meaning** (`looks_like_quran_for_meaning`, unchanged, plus any Quran part): the
    voice's `looks_like_quran`, a run of 4 consecutive Quran words that does not pass
    through an everyday formula, the contained-ayah rule on the whole text, or a Quran
    part. The brain never receives a text with Quran words to judge.
  - The **framed rule** used to fire on a run of 3 anywhere once a framing formula was
    anywhere in the text (a sentence holding the isti'adha made إن شاء الله elsewhere
    "Quran"); it now counts only in the formula's neighbourhood, with the everyday
    formulas left out there. On the measured fixture this changes no count.
  - The **`"scope": "phrase"` refusal is gone.** A text whose phrase or line is, or holds,
    a whole ayah (the basmala on a line of its own, a short ayah inside a sentence) is a
    Q2 text: that phrase is a Quran part, read by a grown-up. The safety net
    `QuranAnalysis.voice_safe` (a phrase the voice would refuse and no part found in it)
    would give a plain `422 quran_text` in mode `dictation`; it never fires on the
    fixtures or on random mixes (`tests/test_quran_parts.py`).
- The thresholds were measured on `tests/arabic_school_sentences.txt`: 324 ordinary
  Arabic sentences that are not quotations (sentences of the other tests, the app's own
  feedback, meaning and UI strings, everyday religious formulas in sentences, ordinary
  school sentences, and sentences that use the words of short ayat in ordinary ways) and
  17 sentences that quote a whole ayah (asserted by `tests/test_quran_guard.py`).
  Four of those 17 were first written as ordinary uses of a recognisable Quranic phrase
  (على صراط مستقيم 36:4, سلام على إبراهيم 37:109, بلسان عربي مبين 26:195, the question of
  37:92) and are counted apart; a sentence that holds a whole ayah verbatim is meant to
  be refused at phrase scope, so the quotations are intended refusals, not false
  positives.

  | Contained-ayah rule, phrase scope (sentence, phrases, lines), without `EVERYDAY_AYAT` | K = 2 | K = 3 | K = 4 |
  |---|---|---|---|
  | ordinary sentences refused (of 324) | 32 | 11 | 0 |
  | first written as ordinary, recognisable phrase (of 4) | 4 | 4 | 1 |
  | quotations refused (of 13) | 13 | 13 | 10 |

  K = 2 refuses ثم نظر إلى السماء and 31 other ordinary sentences with a two-word ayah
  (وفاكهة كثيرة, هارون أخي, وأمه وأبيه, ...). K = 4 lets 1:4, 1:6 and 108:1 through
  ("ذهبت سلمى مالك يوم الدين" would be spoken). K = 3 refuses 11 ordinary sentences,
  all through 8 three-word ayat that are everyday Arabic (عما كانوا يعملون, فيها كتب قيمة,
  ولا صديق حميم, ...): those 8 are `EVERYDAY_AYAT` (a measured list, like the formulas,
  rather than a higher threshold). With the list, K = 3 refuses 0 ordinary sentences
  and all 17 quotations. The list was built from this fixture: an ordinary sentence
  with another three-word ayah can still be refused for dictation (it can be recited).

  | Contextual mode, run of consecutive Quran words | 3 | 4 | 5 |
  |---|---|---|---|
  | ordinary sentences refused (of 324) | 35 | 8 | 0 |
  | ... with the everyday formulas left out | 22 | 2 | 0 |
  | quotations refused (of 13), formulas left out | 9 | 6 | 0 |

  At 4, the 6 refusals that leaving the formulas out removes are all formula sentences
  (the shahada, حسبنا الله ونعم الوكيل, الحمد لله الذي ...); the 2 left use four Quran words
  that are not a formula (خلق الله السماوات والأرض والجبال والبحار.) and are refused by
  meaning only, so the threshold stays at 4. The contained-ayah rule adds no false
  positive in contextual mode (0 of 324) and refuses the 10 quotations of 17 that the
  runs of 4 miss, so it applies there too.

  The earlier dictation guard (`dictation_speaks_quran`) refuses 6 ordinary sentences
  (the `[split]` section): the plain splitter makes one of their phrases exactly a whole
  ayah (ونراه قريبا., فيها كتب قيمة.), an everyday formula or four Quran words in order
  (لا إله إلا الله), which `/api/tts` refuses on its own. Since the review fixes (RL-5) the
  dictation joins such a phrase with a neighbouring one that the voice accepts (step 4 of
  `find_quran_parts`), so these 6 sentences have no Quran part, are dictated by the voice
  and can be recited by meaning: contextual mode refuses 2 of the 324 (the 2
  `[quranic]` ones). The word-by-word guard refuses none of the 341 sentences.
- **The Quran parts, measured** (Q3; `tests/test_quran_parts.py` on
  `tests/arabic_school_sentences.txt` and `tests/quran_parts_texts.txt`, where every
  Quran word comes from a Tanzil placeholder and every misquote is made by code):

  | Fixture | Texts | found ordinary | found Q2 | found Q1 |
  |---|---|---|---|---|
  | ordinary sentences (`[ordinary]`, `[quranic]`) | 318 | 318 | 0 | 0 |
  | ordinary sentences with a phrase the voice refuses alone (`[split]`) | 6 | 6 | 0 | 0 |
  | sentences quoting a short ayah (`[quotes]`) | 17 | 0 | 17 | 0 |
  | lessons quoting ayat (framed or not, basmala, ranges, «» and ﴿﴾, Uthmani, numbered) | 35 | 0 | 35 | 0 |
  | partial ayat on their own | 12 | 0 | 12 | 0 |
  | lessons with one misquoted ayah | 20 | 0 | 20 | 0 |
  | misquoted short ayat in unframed sentences, and a two-word ayah (`[hard]`) | 6 | 1 | 5 | 0 |
  | whole ayat and ranges, with framing, labels, numbers, Uthmani (Q1) | 22 | 0 | 0 | 22 |
  | whole ayat with one misquote (Q1) | 8 | 0 | 0 | 8 |

  - All 102 placeholders of the lessons, Q1, partial and misquote sections are found
    with their exact reference (surah, ayah range, and word range for partial ayat), as
    one part each; no text has a part that is not a placeholder.
  - Near match: of the 28 misquotes (15 changed letters, 7 dropped words, 6 missing
    hamzas), 28 are found with exactly their difference reported (recall 28/28). The 92
    texts that quote correctly report no difference, and each misquote reports only its
    own (precision 28/28). The `[hard]` section is found 5 times in 6, each with exactly
    its edit (a changed letter in 112:1, 96:1, 103:2 and 1:5, a dropped word in 114:1, all
    unframed); the two-word ayah inside a sentence stays ordinary text, by design.
  - Short ayat with one OCR-like error (`near_short_ayat`, measured on Juz' Amma: every
    ayah of 3 or more words, at every word position, in "درسنا اليوم آية جديدة. … ثم
    شرحها المعلم."; an identical ayah elsewhere counts as found). Before the review fixes
    (RL-1) 57% were found framed with a changed letter, 4 of 426 three-word ayat.

    | Juz' Amma sweep | framed (قال تعالى:) | unframed |
    |---|---|---|
    | one changed letter (1,773 texts) | 1,767 (99.7%) | 1,742 (98.3%) |
    | one dropped inner word (1,031 texts) | 1,021 (99.0%) | 1,026 (99.5%) |

    The misses are a 3-word ayah whose changed word has 2 letters (ثم, إن, عن) outside a
    framing formula or quotation marks, and a few where an overlapping exact run with the
    next word of the sentence wins. Precision: `near_short_ayat` finds nothing in the 324
    ordinary sentences, in 5,000 random pairs of them, or in the 1,096 Arabic strings of
    the app and its tests; `clitic_ayat` (a short ayah after و/ف) likewise. Two words left
    of a three-word ayah (a dropped word) and a misquote with two errors are not found.
    `tests/test_quran_parts.py` (`TestShortAyatWithOneError`) asserts at least 97% on a
    sweep with one word position per ayah, framed and unframed.
  - No ordinary sentence gains a part beyond the earlier guards: the 324 have none. Of
    3,000 random pairs of ordinary sentences, 1 gains a part, already flagged before by
    the word-by-word guard, whose run of 5 crosses the sentence end and is 14:38-39
    verbatim (2 more had a part before RL-5: a phrase cut that isolated an everyday ayah).
  - The dictation invariant (every phrase `is_quran_phrase` refuses is read by a
    grown-up; the voice phrases and the grown-up chunks give the expected words of the
    check in order) holds on every fixture text and on 150 random mixes of ordinary
    sentences with whole ayat, ranges and partial ayat, framed or not; 120 random whole
    ayat of 3 words or more (not an everyday ayah) put between two ordinary sentences
    are all inside a part.
- Speed (4 CPUs, measured again after the review fixes, 2026-11-12; median of 7 after
  one warm-up). The review fixes (short ayat with one error, ayat after و/ف, joined
  words, soft joins of the voice phrases) had made the search slower than first
  measured; a profile showed half of the voice-phrase tests and a quarter of the
  `locate` calls were repeats within one analysis, so `find_quran_parts` now keeps
  those answers for the length of one call (`_PHRASE_MEMO`, `_Finder.locate`; the parts
  are unchanged on the 847 texts of the fixtures and random mixes, and
  `test_one_analysis_tests_each_phrase_and_scope_once` holds it).

  | text (Arabic) | `find_quran_parts` in-process | `/api/text/check` strict / contextual / dictation | `/api/dictation/phrases` |
  |---|---|---|---|
  | 1000 words of `[ordinary]` sentences, no part | about 78 ms (117 ms without the memo) | 125 / 125 / 133 ms | 129 ms |
  | 1001 words: the same with 21 quoted ayat (`قال تعالى:`) | about 170 ms (234 ms) | 208 / 201 (422) / 214 ms | 218 ms |
  | the 35 `[lessons]`, 863 words, 36 parts | about 155 ms (175 ms) | 189 / 165 (422) / 202 ms | 230 ms |

  The real server is `run.sh` with Whisper, Piper and the Tanzil text loaded, idle (load
  0.3-0.7). Beyond `find_quran_parts`, `/api/text/check` runs the by-meaning guard
  (`looks_like_quran_for_meaning`) on the whole text for its `contextual` answer, about
  33 ms on 1000 words. Before Quran parts the same requests took about 60-75 ms; the
  strict word-by-word guard alone takes about 6-8 ms. An English text of 1000 words
  takes about 13 ms (no Arabic: no Quran search).

| Method & path | Request | Response |
|---|---|---|
| POST `/api/access` (extra, online only) | JSON `{"code": str}` | `204` with the `mommy_access` cookie; `403 bad_access_code`; `429 too_many_attempts` with `Retry-After`; see "Access gate". Absent (404) when no code is set. |
| GET `/api/health` | – | `{"asr": bool, "tts": bool, "brain": "claude"\|"offline", "quran": bool, "languages": ["ar","en","fr"]}`; extra: `tts_languages` (voices that work), `asr_model` (the Whisper model actually in use), `reasons: {asr, tts, ocr}` (why unavailable), `ocr` (bool: a page photo can be read on the server without Claude, see "Local page reading"; false with `MOMMY_OCR=off` or without the OCR models or packages), `live_recite` (bool, `Settings.live_recite`: the server checks a recitation phrase by phrase, `/api/recite/phrase`), `online` (bool, `app.is_online(settings)`: true when the access gate is on (`MOMMY_ACCESS_CODE` set, or `MOMMY_ACCESS_CODE_FILE`) or when any of `MOMMY_ALLOWED_HOSTS` is not a loopback name or address (`is_loopback_host`: `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), so the app may be used from another device; false for the default local run, `./run.sh` with loopback names only; the web client's privacy texts follow it, see "Start screen") |
| POST `/api/page/read` | multipart: `image` (jpeg/png), `lang` (optional); extra: `ai_consent` (optional, `"1"`: see "AI consent"; without it the offline brain answers) | `{"text","lang","notes","source":"claude"\|"offline","needs_manual":bool}`; extra: `brain` (`"claude"`\|`"offline"`, see "AI consent"), `contains_quran` (decided by the server from the text read when it has Arabic and the Tanzil text is loaded: true only for a page that is Quran (Q1) or has Uthmani script outside its Quran parts, so the client keeps its "page is Quran" message for it; a school page that quotes ayat (Q2) is false and read as usual; without Arabic or without the Tanzil text, the reader's own flag), `quran_parts` (the Quran parts of the text read, see below; `[]` when none or not decided), `mushaf_text` (the text with every differing Quran part replaced by the mushaf words; equal to `text` when nothing differs, for example after an OCR misread of an ayah the parent sees the difference and can take the mushaf text in one tap), `quran_range` (`{surah, from, to}` for a Q1 page whose ayat are one range of one surah, else null), `unreadable_marks` (number of `[?]` in the text), `brain_error` (when Claude failed; source is then offline), `reader` (`"claude"`\|`"local"`\|`"none"`: who read the photo, see "Local page reading"), `reader_error` (the class name, when the local reader failed) |
| POST `/api/recite/check` | multipart: `audio` (wav), `expected_text`, `lang`, `mode` (`strict`\|`contextual`), `age` (`6-9`\|`10-13`\|`14-18`); extra: `ai_consent` (optional, `"1"`: Claude words the feedback and judges the meaning; without it the offline templates and heuristic answer, see "AI consent"), `heard_before` (optional, a live recitation: the transcripts of the phrases `/api/recite/phrase` decoded, joined by spaces, may be empty; `audio` is then only the tail after them, a WAV with no samples when nothing came after; see "Live recitation") | strict: `{"mode":"strict","heard_text","result":{ops,n_expected,n_errors,first_error_exp_index,verdict,say_again,word_accuracy, extra: say_again_reason, stopped_at_exp_index, n_unreadable},"feedback","quality"}`; contextual: `{"mode":"contextual","heard_text","judgement":{verdict,missing_ideas,wrong_ideas,approximate?, extra: say_again},"feedback","quality"}`; extra: top-level `say_again` and `brain` (`"claude"`\|`"offline"`, see "AI consent"); strict also `feedback_is_quran` (bool: the feedback is the fixed Quran-part template, quoting a mushaf word; show it as text, never send it to `/api/tts`) and `quran_parts` (see below; with `exp_start`/`exp_end`, the range of `result.ops` `exp_index` that holds the part's mushaf words). Q1 gives `422 quran_text` (with `quran_range` when one range) in both modes; a Q2 text is recited in strict mode with its Quran parts compared against the mushaf (Simple-Clean) words as `/api/quran/check` compares them, and the rest with the speech tolerances (the ops' `expected` is then the mushaf word inside a part); contextual mode refuses Q2 (`422 quran_text`, `QURAN_MEANING_MESSAGE`). Example: a lesson quoting 2:153 with the child saying another word for its 7th word gives one `sub` whose `expected` is that mushaf word, `feedback_is_quran: true` and `feedback` = `quran_part_feedback("sub", <Uthmani word>, "ar", "recitation")` ("في الآية الكريمة كلمة تحتاج إلى انتباه: «…». هيا نقرؤها مرة أخرى."); the brain is not called. If audio quality is too quiet or too short: the ASR is not run; strict gives verdict `"unclear"`, say_again true (reason `"empty"`); contextual gives judgement verdict `"unclear"` (a fourth value, only for unusable audio or nothing heard) and say_again true. |
| POST `/api/recite/phrase` (extra, absent with `MOMMY_LIVE_RECITE=off`) | multipart: `audio` (wav, one phrase: at most 4 MB and 30 s; `413 audio_too_large`/`audio_too_long`), `expected_text`, `lang`, `mode` (`strict`\|`contextual`), `heard_before` (optional, default empty: the transcripts of the earlier phrases, as this endpoint returned them, joined by spaces) | `{"mode", "heard_text" (this phrase only, `""` when its audio is too quiet or under 0.5 s, which is not decoded), "quality" (this phrase's), "progress", "brain": "offline"}`; `progress` is null in contextual mode, and in strict mode `{"ops": [{kind: match\|sub\|del\|ins\|pending, exp_index, heard_index, expected, heard}], "n_expected", "n_read", "n_matched", "n_errors"}` (`align.reading_progress` of the strict check of `heard_before` + `heard_text`, see "Live recitation"). The text checks and refusals of `/api/recite/check` in the same mode (`empty_text`, `text_too_long`, `unreadable_text`, `quran_text` with `quran_range` or `"reason": "meaning"`, `lang_mismatch`), and for `heard_before` `bad_text` and `text_too_long`; `503 asr_unavailable`; never a brain, the voice or the AI consent. Example: `expected_text` "The cat sat on the mat.", `heard_before` "the cat", a phrase heard as "sad" -> ops match, match, sub (heard "sad"), pending, pending, pending; `n_read` 3, `n_errors` 1. |
| POST `/api/dictation/phrases` | JSON `{"text","lang"}` | `{"phrases": [str], "readers": ["voice"\|"grown_up"], "read_text": [null\|str], "parts": [null\|int], "quran_parts": [part]}` (extra: all but `phrases`; the four lists have one entry per phrase). The voice reads a `voice` phrase (`/api/tts`, slow). A `grown_up` phrase is a chunk of a Quran part (at most 6 display words, never across an ayah): `read_text` is its fully vowelled Uthmani text (verbatim Tanzil) for a grown-up to read aloud, `phrase` the same words in Simple-Clean spelling (what the child writes; never sent to `/api/tts`), `parts` the index of its part in `quran_parts`. A text with no Arabic or no Quran part gives `split_phrases` with every reader `voice`. Q1 gives `422 quran_text` with no scope (and `quran_range` when one range). The `"scope": "phrase"` refusal is gone. A text of punctuation only gives `{"phrases": [], ...}` with empty lists. Example: `"الصبر مفتاح الفرج. قال تعالى: " + 2:153 + " ثم شرح المعلم الآية."` -> phrases `["الصبر مفتاح الفرج.", "قال تعالى:", <2:153 display words 1-5, in Simple-Clean words (6 words: يا أيها is one Uthmani word)>, <display words 6-10>, "ثم شرح المعلم الآية."]`, readers `["voice", "voice", "grown_up", "grown_up", "voice"]`, read_text `[null, null, <Uthmani display words 1-5>, <Uthmani display words 6-10>, null]`, parts `[null, null, 0, 0, null]`. |
| POST `/api/text/check` (extra) | JSON `{"text", "lang": "ar"\|"en"\|"fr", "mode"?: "strict"\|"contextual"\|"dictation"}` (`mode` defaults to `strict`; any other field is ignored, the parts are never taken from the client) | `{"ok": true, "words": n, "dictation": bool, "contextual": bool, "quran_parts": [part], "mushaf_text": str}`. The checks of `/api/recite/check` in its order (`bad_text`, `text_too_long` by characters, `empty_text`, `text_too_long` by words, `unreadable_text`, `quran_text`, `lang_mismatch`, same bodies; a body that is not JSON gives `422 invalid_field` "The body is not valid JSON."). A text that is Quran (Q1) gives `422 quran_text` in every mode (with `quran_range` when one range of one surah); mode `contextual` also refuses a Q2 text and the by-meaning guard (`QURAN_MEANING_MESSAGE`); mode `dictation` refuses nothing more (no `scope` any more). `words`: the words of the cleaned text (`textnorm.tokenize`). `dictation`: true (a grown-up reads the Quran parts; false only from the never-seen safety net). `contextual`: false when the text has a Quran part or the by-meaning guard refuses it (true in its own mode). `quran_parts`: see below. `mushaf_text`: the submitted text with every Quran part that differs from the mushaf replaced by the mushaf words, in the script closest to what was typed; equal to the submitted text when nothing differs. No recogniser, voice or brain is used. `503 quran_unavailable` when the Tanzil text is missing and the text has Arabic letters. Body limit 256 KB, Host and Origin checks as everywhere. Examples: `{"text": "ذهب الولد إلى المدرسة", "lang": "ar"}` -> `{"ok": true, "words": 4, "dictation": true, "contextual": true, "quran_parts": [], "mushaf_text": "ذهب الولد إلى المدرسة"}`; the basmala on a line of its own followed by a sentence -> `dictation: true, contextual: false`, one part (1:1, rule `ayah`); 112:1-4 with or without قال تعالى / صدق الله العظيم -> `422 {"error": "quran_text", "message", "quran_range": {"surah": 112, "from": 1, "to": 4}}`; a lesson quoting 2:153 whose 7th word was typed with ض for ص -> one part with `differences: [{"op": "sub", "typed": <typed word>, "mushaf": <Uthmani word>, "mushaf_clean": <Simple-Clean word>, "index": 6, "token": <token index>}]`, `rule: "near"`, and a `mushaf_text` with the Simple-Clean word in its place. |
| POST `/api/tts` | JSON `{"text","lang","slow":bool,"check":bool}` (`check` defaults to true; false skips the speech check below, for the single words of a dictation) | `audio/wav`. 503 if TTS unavailable. 400 if text is empty or longer than 400 characters, or has nothing to pronounce. Extra: header `X-Speech-Check: passed\|failed\|skipped`: slow speech (unless `check` is false) is transcribed back, unprompted, up to 2 takes, and must say exactly the phrase (`check_recitation`: numbers in digits match words, Arabic number words match by value). |
| POST `/api/dictation/check` | multipart: `expected_text`, `lang`, `age`, and either `image` (photo of the child's paper) or `written_text` (parent typed it); extra: optional `strict_tashkeel` (bool), optional `ai_consent` (`"1"`: Claude reads the photo and words the feedback; see "AI consent") | `{"read_text","source":"claude"\|"typed","uncertain_words","result":CheckResult,"feedback","needs_parent_confirmation":true}`; extra: `brain` (`"claude"`\|`"offline"`, see "AI consent"), `legible`, `feedback_is_quran` and `quran_parts` (as for `/api/recite/check` strict); in a Q2 text a Quran part is checked against its mushaf words (not the typed ones), and a Quran word is accepted in its Simple-Clean or its Uthmani spelling (through the dictation key: diacritics only with `strict_tashkeel`) and in nothing else (a missing hamza is a mistake); every other word is checked as before; Q1 gives `422 quran_text`; `uncertain_words` includes `"[?]"` when a word could not be read. With an image and an offline brain (no Claude on the server, or no `ai_consent=1`), or when Claude reads nothing: 501 `needs_manual`. |
| GET `/api/quran/surahs` | – | `{"surahs":[{number,name_ar,ayah_count, extra: name_translit, name_en}],"riwaya":"hafs","attribution","source_url":"https://tanzil.net"}`; extra: `licence` |
| GET `/api/quran/ayat?surah=&from=&to=` | – | `{"ayat":[{surah,ayah,display,display_words}],"attribution"}`; extra: `riwaya`, `source_url`. At most 50 ayat per request. |
| POST `/api/quran/check` | multipart: `audio`, `surah`, `from`, `to` | `{"heard_text","ops","verdict","say_again","first_error","feedback"}`; extra: the other keys of `Quran.check` (`words`, `tolerated`, `stopped_at`, `n_expected`, `n_errors`, `word_accuracy`), `quality`, `riwaya`, `attribution`, `source_url`. The feedback comes from `feedback.quran_feedback` only. |
| POST `/api/quran/locate` | multipart: `audio` or `heard_text`, optional `surah` | `{"heard_text","candidates":[{surah,ayah,word_index,score,display_preview, extra: match_word_index}]}`; extra: `say_again`, `quality` |

A **Quran part** (`quran_parts` of `/api/text/check`, `/api/page/read`,
`/api/dictation/phrases`, `/api/recite/check` strict and `/api/dictation/check`) is:

```js
{
  "start": 5, "end": 15,                 // token span in textnorm.tokenize(text, lang)
  "chars": [31, 79], "utf16": [31, 79],  // offsets in the text as sent: code points, and UTF-16 units for JavaScript's slice
  "surah": 2, "ayah_from": 153, "ayah_to": 153,
  "word_from": 0, "word_to": 10,         // Simple-Clean words of ayah_from .. of ayah_to (word_to exclusive)
  "whole": true,                         // the part is whole ayat
  "rule": "near",                        // ayah | run | framed | contained | located | near
  "uthmani": ["…"],                      // the mushaf words: display (Uthmani) ...
  "clean": ["…"],                        // ... Simple-Clean ...
  "clean_display": ["…"],                // ... and, for each Simple-Clean word, the display word(s) that spell it
  "differences": [                       // sub | del (typed and token null) | ins (mushaf null; index: the mushaf word after it)
    {"op": "sub", "typed": "…", "mushaf": "…", "mushaf_clean": "…", "index": 6, "token": 11}
  ],
  "replacement": "…",                    // text[chars] with the differences replaced by the mushaf words
  "chunks": ["…", "…"],                  // the grown-up's reading chunks: vowelled Uthmani, verbatim
  "exp_start": 5, "exp_end": 15          // where the mushaf words sit among a check's expected words (result.ops exp_index)
}
```

Differences ignore diacritics and the
Uthmani or standard spelling; a changed letter, a missing hamza and a missing or extra
word count. A check always uses the mushaf words of a part, so a child is never
corrected towards a misquoted ayah. The feedback about a mistake in a part is
`feedback.quran_part_feedback` (fixed templates, quoting the mushaf word): when any
mistake of a result lies in a Quran part, the brain is not called for that result at all
(a first mistake outside the parts gets the ordinary template), so Claude never receives
a Quran word to write about.

Serialise `CheckResult` and `Op` with `dataclasses.asdict`. Static files: mount `web/` at
`/`, with `index.html` as the default (the mount leaves `/api/*` to the API, so a wrong
method gets 405). `/docs` and `/redoc` are disabled (they load scripts from a CDN); the
schema is at `/api/openapi.json`. `app.py` also exposes `def build_default_app() ->
FastAPI` (real components, for uvicorn: `uvicorn mommy.app:build_default_app --factory`),
which configures the `mommy` loggers (level `MOMMY_LOG_LEVEL`, default INFO). Extra:
online (an access code set) it also calls `start_preload(transcriber, tts) ->
threading.Thread`, a daemon thread that loads the recognisers, then the voices, one
language at a time (the locks are released in between; a failure is logged by its class
name), so the first recording after a cold start does not wait for its model; locally
each language is still loaded on first use.

## Web client (vanilla HTML/CSS/JS, no frameworks, no CDN)

- **The access gate page (extra, online only).** `access.html` loads `/styles.css` and
  `/access.js` (absolute URLs: the page is served at any path), a CSP meta tag with
  `'self'` only and `form-action 'none'`, no inline script or style. `access.js` picks
  en, fr or ar from `navigator.language` (`dir="rtl"` for ar) and says in one line that
  this is a private test of Mommy. With `#code=...` in `location.hash` it removes the
  fragment at once (`history.replaceState`), POSTs the code to `/api/access` and goes to
  `/` (`location.replace`) on 204 (and on 404: that server has no gate). Otherwise, or
  when the code is refused, it shows a form (the field has no `name`, so a form sent
  without the script carries nothing) with a translated error: wrong code, too many
  tries (with the wait in minutes from `Retry-After`; Arabic-Indic digits and the Arabic
  dual and plural), empty field, server unreachable, other error. Its strings follow the
  rules of `app.js` (يُرجى + a verbal noun, verbal-noun buttons, French no-break spaces).
  It stores nothing and never reads the cookie (it is HttpOnly). Extra: the link pasted
  into a tab that already shows the page (only the fragment changes) is handled the same
  way (`hashchange`); while the app is starting (502, 503 or 504 from the proxy:
  "The app is starting...") or cannot be reached, a link's code is kept in memory, tried
  once more by itself after 20 s, and "Enter" with an empty field tries it. The comment
  says it plainly: `replaceState` clears the address bar and this tab's history entry,
  not the browser's history list.
- **A cookie that no longer opens the app (extra, online only).** `app.js`'s `api()`
  reloads the page on `401 access_required` (the owner set a new code): the server
  answers that navigation with the code page, so it cannot loop, and the call never
  settles. Without the gate no endpoint answers 401.

- Classic scripts loaded with `defer` in this order: `recorder.js` (`window.MommyRecorder`),
  `rewards.js` (`window.MommyRewards`, the pure logic of tasks and rewards),
  `family.js` (`window.MommyFamily`, the family UI) and `app.js` (one IIFE,
  `window.MommyApp`; see `docs/REWARDS.md` for the hooks between the last two), a
  CSP meta tag (`default-src 'self'`; the AudioWorklet is loaded from a `blob:` URL), and
  relative API URLs (`api/health`, ...). It special-cases the error codes `needs_manual`
  and `quran_text` (a text that is Quran: the Quran section, or a Quran task, preset to
  `quran_range` when the body has one), and shows its own localized message for
  `text_too_long`, `empty_text`, `bad_text`, `unreadable_text` and `lang_mismatch`,
  never the server's English message. The server no longer sends `scope: "phrase"`.
  Extra: a `quran_text` with `"reason": "meaning"` (contextual mode refused a school
  text with Quran words) is "recited word by word only", never "this text is from the
  Quran" with the Quran-section button; a task by meaning with such a text cannot be
  recorded, the child is told a grown-up changes it, and the task's details offer
  "Recite word by word".
- **Quran parts of a school text (Q2; built from the server's answers, never computed
  in the browser).** Prepare's "Confirm text", task creation and the page reader show
  the parts (`quran_parts`) to the parent with their reference; where a part has
  `differences`, the parent sees them (the typed word against the mushaf word in its
  standard spelling, the changed letters marked, then its Uthmani form; a missing word
  after the word before it; each reference with the part's first two and last two
  mushaf words) and can take the mushaf text in one tap (`mushaf_text` for all parts, or `replacement` at `utf16` for one).
  `contextual: false` disables "The meaning" with a localized reason (Quran words are
  recited word by word only); a recite task with such a text is word by word only (and
  is saved only with the mushaf words where the typed ones differ: the child reads the
  text); a dictation task with it is allowed and uses the grown-up step. The child's
  Recite card shows `mushaf_text` where it differs from the typed text (the check
  expects the mushaf words); the typed text stays in the grown-up's box.
  - Dictation: for a `voice` phrase the app calls `/api/tts` as before (redesign: the
    sentence at normal speed, then each word slowly, with `"check": false`; see "Child:
    Dictation"). The words and their writing pauses are joined into ONE WAV and played
    at once, on the page's single shared audio element, which each tap on Start, Repeat
    or Next unlocks: phones refuse a sound started without a new tap on a fresh element,
    so a sound per word after a pause was refused (only the first word was heard). For a
    `grown_up` phrase it never calls `/api/tts`, for the sentence or for any of its
    words: it asks someone to read it (wording that fits a mother, a father or another
    grown-up), shows `read_text` (vowelled Uthmani, in the Quran font) after a tap, and
    asks the reader to say the whole part once, then word by word, slowly, with time to
    write each word; "Done reading" hides the words again before the child writes.
    (Redesign) The app asks and never blocks: "Next" goes on even when nobody can read
    the part now. Repeat on such a phrase asks again and never calls the voice. The
    child's line ("Let's ask someone to read this part aloud", no Quran word in it) is
    also said once by the voice, in the child's language, when the step starts (fetched
    once per dictation). In "Mom's check" the words of a Quran part are shown in their
    mushaf form (`read_text`, the Quran font, RTL).
  - The voice never reads the text as a model (Recite has no such button; its "Listen"
    only speaks the feedback). For a text with Quran parts a note tells the grown-up to
    read it aloud, and feedback with `feedback_is_quran` is never spoken ("Listen" is
    hidden).
  - Results: `quran_parts[].exp_start`/`exp_end` say which `result.ops` are Quran words
    (their `expected` is the Simple-Clean mushaf word; `clean_display` gives the Uthmani
    word to show). Feedback with `feedback_is_quran: true` is shown as text only and
    never sent to `/api/tts`.
- `split_phrases` joins the lines of a paragraph, so a line that is a whole ayah (the
  basmala on a line of its own, without a full stop) would reach the voice glued to the
  next word. The server finds such a line as a Quran part (a grown-up reads it), so
  `/api/text/check` and `/api/dictation/phrases` answer for the lines too: the client
  does not send the lines again as paragraphs. `/api/tts` still refuses every Quran
  phrase (`422 quran_text`); if that ever happens during a dictation, that phrase becomes
  a grown-up step showing the phrase as written (there is no mushaf text for it) and the
  dictation goes on; never "this text is from the Quran" with a button to the Quran
  section. "Confirm text" and the task form keep a page read's Quran parts after an
  `unreadable_text` refusal, so "Use the mushaf text" fills a `[?]` inside an ayah.
- **Start screen** (the family setup on a first run, then "Who is learning?"; see
  `docs/REWARDS.md`):
  - the AI disclosure, at the start of every session;
  - a parent consent checkbox (camera and microphone), stored in the family document
    (`parent.consentAt`) and changed in the parent area (Settings); unticking it there
    also withdraws the AI consent;
  - (extra) while `/api/health` says `"brain": "claude"`, the AI consent: a box of its own
    (`consent_ai_label`, "I agree that these things are sent to Claude.") right under the
    Claude notice (`consent_claude`), which can be ticked only with the first box. The
    notice names every value `llm.py` puts into a Claude request: the photos, the page
    text and a transcript (meaning mode), the words the child got wrong with the score,
    and with them the language and the child's age group (checked against `llm.py` by
    `tests/web/smoke.cjs`). Stored as `parent.aiConsentAt` with `parent.aiConsentVersion`
    (`rewards.js` `hasAiConsent`): the consent counts only with `AI_CONSENT_VERSION` (2,
    the notice with the score, the language and the age group) or later, so a change to
    the notice raises the version and every family is asked again; a consent saved before
    the version existed never counts (see `docs/REWARDS.md`). The client adds
    `ai_consent=1` to a call whose server path can use Claude (`/api/page/read`,
    `/api/recite/check`, `/api/dictation/check` (no longer sent by the web client); `addAiConsent` in `app.js`) only when,
    as the request is built, the consent counts (`state.aiConsent`, which `family.js`
    sets from `hasAiConsent(doc)` after every change of the document) and `/api/health`
    says `"brain": "claude"` (the page shows the Claude notice it was given to); without
    the field the server answers with its offline brain (see "AI consent" under HTTP API),
    so the server, not this page, keeps Claude out. Until the consent is given, the page
    photo waits only when the server has no local page reader (`/api/health` `ocr`
    false): the child's editor ("New text") then says `consent_needed_ai` ("Let's ask a
    grown-up to give the OK in Settings to read photos. Typing works now.") and the
    parent area's task form `consent_needed_ai_parent`. (Redesign) The consent is asked
    in two places only, the setup and Settings: the prompt at the top of the parent area
    is gone, and `consent_needed_ai_grownup` is no longer shown (no card for the grown-up
    outside the parent area). Recite, word by word and by meaning, and the typed
    dictation check work without it: the server answers them with the offline templates
    and, by meaning, the approximate heuristic (the "approximate" label of the result and,
    under the mode choice, `mode_contextual_offline`). Before a photo is sent the
    consent is read again; if it no longer counts nothing is sent ("Nothing was sent.")
    and `/api/health` is asked again for the gates. A check sent with the consent that the
    offline brain answered (`"brain": "offline"`: the server was started again without
    Claude) also makes the client ask `/api/health` again, so the gates and the texts
    follow. The Quran section, the dictation's voice and `/api/text/check` never need
    it;
  - under the box, in the setup and in Settings (extra, `updatePrivacyTexts` in
    `app.js`, from `/api/health`), where the data goes, true in each way the app runs.
    The first line: local, `consent_privacy` ("Mommy handles the recordings and photos
    in memory and never saves them.": Mommy's storage, nothing said of Claude's); online,
    `consent_online` ("Online: your child's voice recordings, the photos and the texts
    are sent over a secure connection to the Mommy server that runs the app, where they
    are checked in memory and not kept."), or, without Claude and without the local page
    reader (`ocr`), `consent_online_no_photos` (the same without the photos: no photo can
    be read then). The second line: with
    Claude, `consent_claude` (what goes to Claude, local or online), followed by the AI
    consent box; without it, `consent_offline` locally ("Offline mode: nothing leaves
    this computer.") and `consent_online_no_ai` online ("Nothing is sent to an outside AI
    service such as Claude.": the server's own recogniser and page reader are not an
    outside service; neither line says any more that the parent types every text). The page counts
    as online when `/api/health` says `online`, and also when it was not loaded from a
    loopback host (a tunnel that rewrites the `Host` header, or the server not reached
    yet). The photo note of the editor and of the task form is, unless a photo goes to
    Claude (the photo is read by the local reader, or cannot be sent), `photo_privacy`
    locally ("Photos are made smaller on this device, and Mommy does not keep them.") and
    `photo_privacy_online` online (sent to the Mommy server, which does not keep them);
    when a photo goes to Claude (Claude set up and the AI consent counting) it names where
    the photos go:
    `photo_privacy_claude` locally ("Photos are made smaller on this device, then sent to
    Claude to be read. Mommy does not keep them.") and `photo_privacy_online_claude`
    online (to the Mommy server, "which does not keep them and passes them on to Claude to
    be read"), never a word about what Claude keeps;
    the label of an approximate meaning check is `approximate_online` ("without the
    online AI", never "offline") online, and locally while Claude is set up (a check
    sent without the AI consent, or after an error of Claude: the setup names Claude
    there, so "offline" would mislead); `approximate` ("(offline)") only locally without
    Claude;
  - the family data line, in the setup and in Settings, the same in every mode
    (redesign: a short line, `fam_privacy_short`, "The family list (children, texts,
    stars, rewards and the PIN) stays in this browser, on this device.", with the whole
    line behind "More"; `fam_privacy_line`: "Your family's list (children, their texts,
    tasks, stars, rewards and the PIN) is saved only in this browser, on this device, unless a copy is saved with “Save
    a copy”: the copy is a file, without the PIN, where the browser saves downloads. To
    check a text or read it out,
    the Mommy server gets the text and its language, and for a recitation or dictation
    check also the child's age group; a Quran check sends the surah and ayat numbers
    instead. The server does not keep the texts or the age group; its log notes the
    language, the kind of check and the ayat numbers."), true of the fields the client
    sends and of what `app.py` logs (`tests/web/access.cjs` reads the real server's
    log);
  - the parent PIN (a child lock) and the children (nickname, age band, language,
    avatar), in one family document kept in `localStorage` (`mommy.data.v2`) on this
    device only, and in a file only when the parent saves a copy (below).
- **Parent area** (behind the PIN; redesign: it stays open while the grown-up moves around
  the app, and locks when the page is hidden, after 3 minutes without use in it, or with
  "Close"; use on a child's screen does not keep it open): Rewards (the jar and its
  history, with "Take the stars back" on a task's stars, rewards to give, goals,
  surprises, corrections), Tasks (optional suggestions; Details, "Mark as done", "Take the
  stars back"; the optional fields under "More options"), Children (add, edit, remove),
  and Settings (consent, PIN change, parent language, a copy of the family list, delete
  all data). There is no queue to review: the app gives the stars of a task when it is
  passed (`rewards.js` `recordAttempt`). One exception to the
  lock when the page is hidden: a parent-area file input ("Load a copy", the task
  form's two photo inputs) opens a picker that some phones show as another app, so the
  first hiding within 10 s of a tap on one does not lock the area; the exemption ends
  as soon as the picker is done without hiding the page (the input's `change` or
  `cancel`, or the window's `focus`), and every other hiding locks
  (`initAutoLock` in `family.js`).
- **A copy of the family list** (Settings; `rewards.js` `makeFamilyCopy`,
  `readFamilyCopy`, `useFamilyCopy`). "Save a copy" makes, in the browser, a JSON file
  `mommy-family-YYYY-MM-DD.json` (`{"app": "mommy", "kind": "family-copy", "version": 1,
  "savedAt", "family"}`, the document without its `parent` part: no PIN record, no
  backoff or reset, no consent, no parent language) and hands it to the browser through
  a Blob URL and `<a download>` (no request, no other origin); a family with no child has
  nothing to save. "Load a copy" reads a chosen file in the browser (never sent), checks
  it like stored data (`validateDoc`), and refuses a file that is not a JSON object or
  not a copy, one over 2 MB as read, one of a newer version, a damaged one (cut short,
  without the lists a copy always has, children all invalid, rejected by `validateDoc`,
  or over 2 MB once checked, so a loaded copy can always be saved again) and a copy with
  no child. It then shows a summary and asks before it replaces this device's family;
  the PIN, consents and parent language of the device stay. A copy that the storage
  refuses (full) is not used: the question stays open and says so. At the setup of a new
  address, "Load a copy" takes the place of the first child; the consent boxes and a new
  PIN are still given there.
- **Child: "My texts" (redesign; was the parent's "Prepare a page").** The child's saved
  texts (`rewards.js` `addText`, `updateText`, `removeText`; at most 30 per child, 5000
  characters each, in the family document and in a copy of it). "New text" opens the
  editor: a name (optional), the language, a photo (resized in the browser to a 2000 px
  JPEG, then `/api/page/read`) or the text typed or pasted, the reciting mode, and
  "Save", which checks the text (`/api/text/check`, as "Confirm text" did) and saves it;
  "Read aloud" and "Dictation" then open it. Each saved text has "Read aloud",
  "Dictation", "Change" (the editor; its name and mode are saved as soon as they change)
  and "Delete" (asked in place; the stars it earned stay). Read aloud and Dictation
  without a text list the child's texts to pick. A saved text opened again is checked in
  the background for its Quran parts (as a task's text is).
  - (extra, done) With `/api/health` `"ocr": true`, the page photo (of the editor and of
    the task form) no longer waits for the AI consent or for Claude: without them it is
    sent without `ai_consent` and read on the server (`"reader": "local"`); with the
    consent and Claude, Claude reads it as before (`ai_consent=1`). "Nothing was sent" is
    never shown then. Every privacy sentence stays true (see "Start screen"). With
    `"reader": "local"` the status says that the text was read without AI and should be
    checked word by word, the vowel marks above all, before saving (`page_read_local`),
    followed by the reader's `notes` when there are some; `"reader": "none"` (or no text)
    asks for typing as before; `[?]` marks and the Quran parts work as before.
- **Child: "Recite".**
  - Show the text (redesign: "Read aloud"; the child's saved text, or a task's); the mode
    (word by word or by meaning) is saved with the text, or fixed by a task.
  - (Redesign) During a live recitation the page follows the reading: the first word not
    reached yet stays in view above the sticky record bar and below the top bar
    (`followReading`; `window.scrollBy`, smooth, or instant with
    `prefers-reduced-motion`).
  - Big record/stop button; record WAV in the browser (16 kHz mono PCM16 via Web Audio,
    `recorder.js`), then `/api/recite/check`.
  - Extra, live recitation (when `/api/health` `live_recite` and `asr`): while recording,
    `recorder.js` cuts the 16 kHz signal into phrases (`onPhrase`; `PhraseSegmenter`, an
    energy voice activity detector in 20 ms frames: speech is 10 dB above a noise floor
    (the lowest 60 ms level of the last 3 s, rising at most 4 dB/s) and above -50 dBFS; a
    phrase ends after 0.65 s of silence once it holds 0.4 s of speech, with 0.2 s of
    padding on each side and no overlap; a shorter sound waits for the next phrase, a
    burst under 0.15 s followed by 1 s of silence is dropped; after 18 s without a pause
    the phrase is cut at the quietest 100 ms of its last 8 s, without padding; the
    `StreamResampler` gives exactly the samples of the final recording). The status says
    "I'm listening and checking as you read…" (`live_listening`). `app.js` sends the phrases to
    `/api/recite/phrase` one at a time, in order, with `heard_before`; phrases that queued
    up while a request ran go together in the next one (at most 28 s). In strict mode
    each answer's `progress` is drawn on the Recite card with `renderOps` (match, sub,
    del, ins as in a result; `pending` words in the muted text colour, no background);
    by meaning nothing is coloured. At Stop the client waits for the request in flight
    (at most 15 s), then sends the queued phrases and the tail (`recorder.tail`) with
    `heard_before` to `/api/recite/check`; the result then shows as before (feedback,
    "Listen", Quran notes, `notifyTask`). Any failure of a phrase request (an older
    server's 404, a 500, the network, a refusal) or of that final check turns the live
    check off for that recording, silently: Stop sends the whole recording as before (and
    shows that request's own errors). Answers of a recording that was cancelled or
    replaced, of a task that was left, or after the screen was left are dropped (a
    session object per recording, with the task it belongs to). The microphone, consent
    and task gates are those of the recording.
  - Highlight the words: matched green, substitution orange (showing what was heard),
    deleted grey with a strike, inserted in small brackets.
  - Speak the feedback with TTS if available. Offer "say that again" when `say_again`.
- **Child: "Dictation"** (owner's decisions, redesign).
  - Short sentences: the server's phrases (`/api/dictation/phrases`, at most 6 words) are
    cut again in the browser to at most 4 words for ages 6-9 (`MAX_SENTENCE_WORDS`; 6 for
    10-13 and 14-18), never splitting a word; a Quran chunk is never cut.
  - For each sentence the voice says it once at normal speed (`/api/tts`, `slow: false`),
    then each of its words slowly (`slow: true`, the punctuation left out), with a pause
    after each word to write it: `base + perLetter × letters`, by age group (6-9: 1.5 s
    + 0.6 s a letter; 10-13: 1.0 s + 0.35 s; 14-18: 0.8 s + 0.22 s; at most 9 s;
    `writePauseMs`). Next is free once the sentence has been heard (it stops the words
    still to come); Repeat replays the sentence, then the words. The audio of every
    sentence and word is fetched once and kept in memory for the dictation; the next
    sentence and its words are fetched while the child writes. A word the voice cannot
    say is skipped (the sentence was heard).
  - At the end, "Mom's check": the text as the child heard it, large (Arabic RTL; a Quran
    part in its mushaf form, `read_text`), each word a button; a grown-up taps each word
    that is not right (tap again to undo), then "Done" or "All correct". Nothing is
    sent to the server (`/api/dictation/check` stays for other clients). The result is
    built in the browser in the shape of a dictation result (`n_expected`, `n_errors`,
    `word_accuracy`, `ops` with `match` and `fix`), shown to the child (words right out
    of the total, each word to look at again with its correct spelling) and counted by
    the existing star rules (a task's pass level; free practice: all words right). Only
    the score line is said by the voice (it holds no word of the text). No PIN for this
    step (see `docs/REWARDS.md`, "Redesign").
- **Quran.**
  - Pick a surah and ayah range (default Juz' Amma: surahs 78-114). Display the verbatim
    Uthmani text in an Arabic Quran-friendly font stack (no web fonts from CDNs). Show
    "Hafs – Tanzil" ("رواية حفص عن عاصم (Tanzil)" in the Arabic UI) and the attribution
    line (English, verbatim) with its link.
  - Modes:
    - "Recite looking": text shown.
    - "From memory": text hidden, first word shown as a hint on request. A
      `/api/quran/locate` button answers "where am I?".
  - Results are highlighted the same way (from the `words` array of `/api/quran/check`,
    one entry per display word), with template feedback, never spoken by TTS.
- **General UI:**
  - The UI switches `dir="rtl"` for Arabic. The interface language follows the child
    profile (ar/en/fr strings in `app.js`).
  - Large touch targets; works at 360 px wide. If `/api/health` says ASR, TTS or Claude is
    unavailable, the matching buttons are disabled with an explanation.
  - No external requests.

# Mommy prototype: architecture contract

This file is the single source of truth for module boundaries. Every module and the web
client must follow it exactly. If a module needs something the contract does not give it,
change this file first.

## Goal

A web prototype of "Mommy", a tutor that stands in for a parent:

- The parent photographs a textbook page, or types or pastes it.
- The child recites it aloud (reciting), or writes it on paper while the app reads it out
  phrase by phrase (dictation).
- Reciting has two modes:
  - strict: word by word;
  - contextual: is the meaning right?
- The Quran has its own module. It is always strict, and it uses no LLM and no synthetic voice.
- Languages: Arabic (`ar`), English (`en`), French (`fr`). Children are 6-18 years old.

## Hard rules (apply to every file)

1. Speech recognition is never given the expected text. No prompt, no hotwords, no
   context. A model that is given the expected text hides the child's mistakes; this was
   measured in our own lab.
2. Deciding whether a word is wrong is done by deterministic code (`align.py`), never by an
   LLM. The LLM only reads images, judges meaning in contextual mode, and words feedback.
3. Handwriting is read blind. The LLM is never shown the expected text when it reads a
   child's handwriting. Code then compares, and the parent confirms.
4. Quran:
   - The text comes only from the verbatim Tanzil files in `data/quran/`. Never generate,
     complete or "fix" ayat from a model or from memory.
   - Quran checking is strict only. No LLM is involved in any Quran path, and Quran text
     is never synthesised to speech.
   - Feedback for the Quran uses fixed templates only.
   - Show "Hafs (Tanzil)" and the Tanzil attribution and link.
5. Privacy (children's data):
   - Audio and images are processed in memory and never written to disk. They are never
     logged; log only sizes and timings.
   - No analytics and no third-party scripts in the web client.
   - Images are resized in the browser (long edge at most 2000 px, re-encoded to JPEG,
     which drops EXIF) before upload.
   - The UI shows that this is an AI, not a person, at the start of each session.
   - A parent must tick a consent box before the camera or microphone is used.
6. No Claude model identifiers or Claude model version names appear anywhere in the
   repository: no code strings, comments, docs or tests. Claude models are configured only
   through the environment variables `MOMMY_VISION_MODEL` and `MOMMY_TEXT_MODEL`. Tests use
   obviously fake names such as `"test-vision-model"`. This rule does not cover open-source
   speech model names such as the Whisper or Piper files.
7. Claude API calls:
   - Use the official `anthropic` Python SDK (installed: anthropic 2.8.0).
   - Never send `temperature`, `top_p`, `top_k`, `budget_tokens` or a `thinking` block;
     current models reject some of these with HTTP 400.
   - Control cost with `output_config={"effort": <MOMMY_EFFORT, default "low">}`.
   - Get structured JSON with `output_config={"format": {"type": "json_schema", "schema": ...}}`,
     merged with effort into one `output_config` dict. Parse the first text block with
     `json.loads`.
   - Check `stop_reason == "refusal"` and `"max_tokens"` before parsing.
   - Never use the Batch or Files APIs for children's data.
8. Offline mode:
   - If `ANTHROPIC_API_KEY` or either model variable is missing, the app still runs with
     `OfflineBrain`. Page reading and handwriting then need the parent to type the text.
   - If the ASR or TTS model files are missing, `/api/health` says so and the UI hides
     those features. It does not crash.
9. No network calls at runtime except to the Claude API, and only when it is configured.

## Layout

```
mommy/
  README.md                 how to install, download models, run, and test
  requirements.txt
  run.sh                    starts uvicorn on 127.0.0.1:8080, serving the API and web/
  scripts/download_models.sh  fetches the sherpa-onnx Whisper and Piper voices into models/
  docs/CONTRACT.md          this file
  data/quran/quran-uthmani.txt, quran-simple-clean.txt   verbatim Tanzil text (txt-2: sura|aya|text; licence block at end)
  models/                   git-ignored; see the model paths below
  backend/mommy/
    __init__.py
    config.py   textnorm.py   align.py   phrases.py   feedback.py
    quran.py    asr.py        tts.py     llm.py       app.py
  web/
    index.html  app.js  recorder.js  styles.css
  tests/        pytest; run with:  cd mommy && .venv/bin/python -m pytest -q
```

`tests/conftest.py` puts `mommy/backend` on `sys.path`. Imports look like
`from mommy.align import align`.

## Python modules

All public functions have type hints and docstrings. Use Python 3.13 and the standard
library plus numpy, sherpa_onnx, anthropic, fastapi, pydantic, and pillow (only if needed).

### config.py

```python
@dataclass(frozen=True)
class Settings:
    root: Path                 # the mommy/ directory
    models_dir: Path           # root/"models"
    quran_dir: Path            # root/"data"/"quran"
    web_dir: Path              # root/"web"
    asr_model: str             # "small" or "turbo"; env MOMMY_ASR_MODEL, default "small"
    asr_threads: int           # env MOMMY_ASR_THREADS, default 4
    anthropic_api_key_set: bool
    vision_model: str | None   # env MOMMY_VISION_MODEL
    text_model: str | None     # env MOMMY_TEXT_MODEL
    effort: str                # env MOMMY_EFFORT, default "low"
def load_settings(root: Path | None = None) -> Settings
```

### textnorm.py

```python
Lang = Literal["ar", "en", "fr"]
def strip_tashkeel(s: str) -> str
# Removes Arabic harakat, tanwin, shadda, sukun, superscript alef U+0670, tatweel U+0640,
# and Quranic annotation marks U+06D6-U+06ED.
def normalize_word(w: str, lang: Lang, *, keep_tashkeel: bool = False, keep_accents: bool = True) -> str
# - Arabic: unify alef forms أ إ آ ٱ -> ا; ى -> ي; ة -> ه; ؤ -> و; ئ -> ي; drop ء only if
#   the word has other letters; strip tashkeel unless keep_tashkeel; drop tatweel.
# - en/fr: casefold; remove punctuation except intra-word apostrophes and hyphens.
#   keep_accents=False also removes diacritics (é -> e). For speech matching use
#   keep_accents=False; for dictation spelling use True.
# - All languages: map Arabic-Indic and Persian digits to ASCII; strip punctuation, including ، ؛ ؟.
def tokenize(text: str, lang: Lang) -> list[str]
# Splits on whitespace and punctuation. Keeps the original surface forms (unnormalised),
# drops empty tokens. For French, keeps elisions as one token ("l'école").
```

### align.py

```python
@dataclass
class Op:
    kind: Literal["match", "sub", "del", "ins"]   # del = child skipped an expected word; ins = child added a word
    exp_index: int | None    # index into expected tokens (None for ins)
    heard_index: int | None  # index into heard tokens (None for del)
    expected: str | None     # surface form of the expected token
    heard: str | None        # surface form of the heard token

@dataclass
class CheckResult:
    ops: list[Op]
    n_expected: int
    n_errors: int            # sub + del + ins
    first_error_exp_index: int | None
    verdict: Literal["correct", "mistakes", "unclear"]
    say_again: bool          # True when the input looks unreliable: empty, or error rate above 0.6
    word_accuracy: float     # matched / n_expected (0..1)

def align(expected: list[str], heard: list[str], key: Callable[[str], str]) -> list[Op]
# Word-level Levenshtein (sub=del=ins=1), deterministic tie-break preferring match,
# then sub, then del, then ins. key() normalises a token for comparison.
def check_recitation(expected_text: str, heard_text: str, lang: Lang) -> CheckResult
# Speech: normalize_word(keep_tashkeel=False, keep_accents=False).
def check_writing(expected_text: str, written_text: str, lang: Lang, *, strict_tashkeel: bool = False) -> CheckResult
# Dictation: keep_accents=True; Arabic hamza forms are significant here, so use a
# lighter normaliser that keeps أ/إ/آ/ة/ى distinct and strips tashkeel unless
# strict_tashkeel.
```

### phrases.py

```python
def split_phrases(text: str, lang: Lang, max_words: int = 6) -> list[str]
# Dictation chunks: split on sentence punctuation (. ! ? ؟ ، ؛ , ; :), then cap each
# chunk at max_words, splitting at the nearest word boundary. Never splits inside a word,
# and drops empty chunks.
```

### feedback.py (offline templates, also the fallback when Claude fails)

```python
AgeBand = Literal["6-9", "10-13", "14-18"]
def praise(lang: Lang, age: AgeBand, seed: int = 0) -> str
def point_out(lang: Lang, age: AgeBand, expected_word: str, kind: str) -> str
# For example: "Almost! Listen again: <word>". kind is one of sub/del/ins.
def say_again(lang: Lang, age: AgeBand) -> str
def quran_feedback(kind: str, expected_word: str | None) -> str
# Arabic only, fixed respectful wording, never quoting beyond the given word. For
# example: "أحسنت" when correct; "انتبه: «<word>»" for a mistake;
# "أعد التلاوة من فضلك" when unclear.
```

Use a warm parent-like tone with short sentences, adapted to age: playful for 6-9, plain for
14-18. Messages must never say a person is speaking.

### quran.py

```python
@dataclass(frozen=True)
class Ayah:
    surah: int
    ayah: int
    display: str               # verbatim Uthmani line (with the basmala prefix removed for ayah 1, except surah 1)
    match: str                 # verbatim Simple-Clean line (with the same basmala handling)
    display_words: list[str]
    match_words: list[str]
    word_map: list[int]        # for each match word index, the display word index (handles يا أيها vs يَـٰٓأَيُّهَا)

class Quran:
    def __init__(self, quran_dir: Path)    # parses both files, ignores '#' licence lines, validates 6236 ayat
    attribution: str           # "Quran text: Tanzil Project (tanzil.net), Hafs, Uthmani v1.1, CC BY 3.0, verbatim"
    def surahs(self) -> list[dict]   # [{number, name_ar, ayah_count}]; Arabic surah names hard-coded (114), verified against the count
    def ayat(self, surah: int, start: int, end: int) -> list[Ayah]
    def check(self, surah: int, start: int, end: int, heard_text: str) -> dict
    # Strict word-level check of the heard text against the match words of the range:
    # {ops, verdict, say_again, first_error: {surah, ayah, word_index_display, expected_display_word} | None}
    # The basmala and isti'adha spoken at the start are tolerated: a leading
    # "اعوذ بالله من الشيطان الرجيم" and/or "بسم الله الرحمن الرحيم" in the heard text is
    # ignored, except in surah 1, where the basmala IS ayah 1.
    def locate(self, heard_text: str, top_k: int = 5, within_surah: int | None = None) -> list[dict]
    # Hifz search: n-gram index over normalised match words. Returns
    # [{surah, ayah, word_index, score}] sorted by score.
```

The basmala and Tanzil:

- The txt-2 files prefix ayah 1 of every surah except 1 and 9 with "بسم الله الرحمن الرحيم".
  Remove exactly that prefix: 4 words in Simple-Clean, the corresponding Uthmani words in
  display. This is display handling of the same verbatim line, not an edit.
- Keep the full raw line too, in `Ayah`-adjacent data, if useful.

### asr.py

```python
class Transcriber(Protocol):
    available: bool
    def transcribe(self, pcm16k: np.ndarray, lang: Lang) -> str    # float32 mono at 16 kHz, -1..1
class SherpaWhisper:   # sherpa_onnx.OfflineRecognizer.from_whisper(encoder=..., decoder=..., tokens=..., language=lang, task="transcribe", num_threads=...)
    # Model dir: models/sherpa-onnx-whisper-{small|turbo}/{name}-encoder.int8.onnx, {name}-decoder.int8.onnx, {name}-tokens.txt.
    # Build one recognizer per language lazily and cache it. Never pass a prompt or hotwords.
    # Thread-safe: a lock around decoding.
class FakeTranscriber:  # for tests: returns a preset string
def decode_wav(data: bytes) -> np.ndarray
# Parses RIFF/WAV PCM16 (mono or stereo -> mono) at any rate and resamples to 16 kHz
# (linear interpolation is fine). Raises ValueError on a non-WAV or empty file.
def audio_quality(pcm: np.ndarray) -> dict
# {"seconds": float, "rms": float, "too_quiet": bool, "too_short": bool}
```

### tts.py

```python
class Synthesizer(Protocol):
    available: bool
    def synthesize(self, text: str, lang: Lang) -> bytes   # WAV bytes (PCM16 mono)
class PiperTTS:   # sherpa_onnx.OfflineTts with OfflineTtsVitsModelConfig per language:
    # ar: models/vits-piper-ar_JO-kareem-medium, en: vits-piper-en_US-lessac-medium, fr: vits-piper-fr_FR-siwis-medium
    # (model .onnx, tokens.txt, data_dir=espeak-ng-data). Lazy load, cache, and lock.
    # speed: a "slow" option for dictation (length_scale > 1).
class FakeTTS
def roundtrip_ok(tts: Synthesizer, asr: Transcriber, text: str, lang: Lang) -> bool
# Synthesise, transcribe unprompted, and check_recitation; True when there are no errors.
# Used to verify that dictation audio says exactly the phrase.
```

### llm.py

```python
class Brain(Protocol):
    name: Literal["claude", "offline"]
    def read_page(self, image_jpeg: bytes, lang_hint: Lang | None) -> dict
    # Printed page OCR: {"text": str, "lang": Lang, "notes": str}. Preserve tashkeel exactly
    # as printed. Do not correct anything.
    def read_handwriting(self, image_jpeg: bytes, lang: Lang) -> dict
    # BLIND transcription of a child's handwriting, keeping every misspelling and missing
    # or extra letter or hamza exactly as written, with uncertain words marked:
    # {"text": str, "uncertain_words": list[str], "legible": bool}. The prompt must say NOT
    # to correct spelling and must not contain any expected text.
    def judge_meaning(self, expected_text: str, heard_text: str, lang: Lang, age: AgeBand) -> dict
    # Contextual mode: {"verdict": "same_meaning" | "partly" | "different",
    # "missing_ideas": list[str], "wrong_ideas": list[str], "feedback": str}.
    # The feedback is short and warm in lang, adapted to age.
    def word_feedback(self, result_summary: dict, lang: Lang, age: AgeBand) -> str
    # Turns a CheckResult summary into one or two warm sentences. Must not change the verdict.
class ClaudeBrain:    # anthropic.Anthropic(); vision calls use settings.vision_model, text calls settings.text_model
class OfflineBrain:   # read_page / read_handwriting -> {"text": "", "needs_manual": True, ...};
                      # judge_meaning -> content-word overlap heuristic, verdict plus "approximate": True;
                      # word_feedback -> feedback.py templates
def make_brain(settings) -> Brain
```

ClaudeBrain:

- System prompts state that the end users are children aged 6-18. Keep the content child
  safe, and never claim to be a human or a mother.
- Any API error falls back to `OfflineBrain` behaviour, with `"error": "<class name>"` in
  the dict.
- Log `response._request_id` and usage only, never content.
- Use `max_tokens=4000` for OCR and 800 for text.

## HTTP API (FastAPI, `app.py`: `create_app(settings, transcriber, tts, brain, quran) -> FastAPI`)

- All JSON responses use UTF-8.
- Errors return `{"error": "<code>", "message": "<human text>"}` with status 400, 413, 422,
  501 or 503.
- Upload limits: audio at most 10 MB and 120 s; images at most 8 MB.
- Uploads are read into memory and never saved.

| Method & path | Request | Response |
|---|---|---|
| GET `/api/health` | – | `{"asr": bool, "tts": bool, "brain": "claude"\|"offline", "quran": bool, "languages": ["ar","en","fr"]}` |
| POST `/api/page/read` | multipart: `image` (jpeg/png), `lang` (optional) | `{"text","lang","notes","source":"claude"\|"offline","needs_manual":bool}` |
| POST `/api/recite/check` | multipart: `audio` (wav), `expected_text`, `lang`, `mode` (`strict`\|`contextual`), `age` (`6-9`\|`10-13`\|`14-18`) | strict: `{"mode":"strict","heard_text","result":{ops,n_expected,n_errors,first_error_exp_index,verdict,say_again,word_accuracy},"feedback","quality"}`; contextual: `{"mode":"contextual","heard_text","judgement":{verdict,missing_ideas,wrong_ideas,approximate?},"feedback","quality"}`. If audio quality is too quiet or too short: `verdict "unclear"`, `say_again true`. The ASR is not run, or its result is ignored. |
| POST `/api/dictation/phrases` | JSON `{"text","lang"}` | `{"phrases": [str]}` |
| POST `/api/tts` | JSON `{"text","lang","slow":bool}` | `audio/wav`. 503 if TTS unavailable. 400 if text is empty or longer than 400 characters. |
| POST `/api/dictation/check` | multipart: `expected_text`, `lang`, `age`, and either `image` (photo of the child's paper) or `written_text` (parent typed it) | `{"read_text","source":"claude"\|"typed","uncertain_words","result":CheckResult,"feedback","needs_parent_confirmation":true}`. With an image and an offline brain: 501 `needs_manual`. |
| GET `/api/quran/surahs` | – | `{"surahs":[{number,name_ar,ayah_count}],"riwaya":"hafs","attribution","source_url":"https://tanzil.net"}` |
| GET `/api/quran/ayat?surah=&from=&to=` | – | `{"ayat":[{surah,ayah,display,display_words}],"attribution"}`. At most 50 ayat per request. |
| POST `/api/quran/check` | multipart: `audio`, `surah`, `from`, `to` | `{"heard_text","ops","verdict","say_again","first_error","feedback"}`. The feedback comes from `feedback.quran_feedback` only. |
| POST `/api/quran/locate` | multipart: `audio` or `heard_text`, optional `surah` | `{"heard_text","candidates":[{surah,ayah,word_index,score,display_preview}]}` |

Serialise `CheckResult` and `Op` with `dataclasses.asdict`. Static files: mount `web/` at
`/`, with `index.html` as the default. Add `Cache-Control: no-store` on `/api/*`.
`app.py` also exposes `def build_default_app() -> FastAPI` (real components, for uvicorn:
`uvicorn mommy.app:build_default_app --factory`).

## Web client (vanilla HTML/CSS/JS, no frameworks, no CDN)

- **Start screen:**
  - the AI disclosure;
  - a parent consent checkbox (camera and microphone; images sent to Claude when it is
    configured);
  - a child profile with nickname, age band and language, kept in `localStorage` only.
- **Parent: "Prepare a page".** Take a photo or upload one (resized in the browser to
  2000 px JPEG), then `/api/page/read`. The parent sees an editable textarea with the
  result, or an empty one in offline mode, and must press "Confirm text". Pasting or
  typing text is always possible.
- **Child: "Recite".**
  - Show the page text; strict or contextual mode is set by the parent.
  - Big record/stop button; record WAV in the browser (16 kHz mono PCM16 via Web Audio,
    `recorder.js`), then `/api/recite/check`.
  - Highlight the words: matched green, substitution orange (showing what was heard),
    deleted grey with a strike, inserted in small brackets.
  - Speak the feedback with TTS if available. Offer "say that again" when `say_again`.
- **Child: "Dictation".**
  - The app speaks one phrase at a time (`/api/tts`, slow), with Repeat and Next buttons.
    The child writes on paper.
  - At the end the parent photographs the page, or types what the child wrote, then
    `/api/dictation/check`.
  - The result is shown to the PARENT first with a "Confirm result" button before the
    child sees it.
- **Quran.**
  - Pick a surah and ayah range (default Juz' Amma: surahs 78-114). Display the verbatim
    Uthmani text in an Arabic Quran-friendly font stack (no web fonts from CDNs). Show
    "Hafs – Tanzil" and the attribution link.
  - Modes:
    - "Recite looking": text shown.
    - "From memory": text hidden, first word shown as a hint on request. A
      `/api/quran/locate` button answers "where am I?".
  - Results are highlighted the same way, with template feedback, never spoken by TTS.
- **General UI:**
  - The UI switches `dir="rtl"` for Arabic. The interface language follows the child
    profile (ar/en/fr strings in `app.js`).
  - Large touch targets; works at 360 px wide. If `/api/health` says ASR, TTS or Claude is
    unavailable, the matching buttons are disabled with an explanation.
  - No external requests.

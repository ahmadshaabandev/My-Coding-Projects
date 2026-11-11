"""Speech synthesis: local Piper (VITS) voices through sherpa-onnx.

Used to read dictation phrases aloud (slowly) and to speak feedback. Never used for the
Quran (hard rule 4): the Quran paths of the app do not call this module, and as a second
line of defence :meth:`PiperTTS.synthesize` refuses text written in the Uthmani Quranic
script (:func:`is_quranic_script`).

Phonemes
--------
A Piper voice does not read letters: it reads IPA phonemes in the style of espeak-ng,
the phonemizer it was trained with. sherpa-onnx up to 1.x ran espeak-ng internally;
**sherpa-onnx 2.0 removed it** ("espeak-ng is no longer used", the ``data_dir`` option is
now ignored) and expects the caller to pass the phonemes, as Unicode code points, in
``GenerationConfig.phoneme_codepoints``. This module therefore has a small
:class:`Phonemizer` interface with two espeak-ng back ends, tried in this order by
:func:`find_phonemizer`:

1. :class:`PiperPhonemizer`, the ``piper_phonemize`` package, the reference phonemizer
   of Piper voices (the one sherpa-onnx's own example uses);
2. :class:`EspeakNgPhonemizer`, a ctypes binding to the espeak-ng C library, found via
   the ``espeakng_loader`` package or a system ``libespeak-ng`` (``apt install
   libespeak-ng1``).

Both read the voice's own ``espeak-ng-data`` directory (the same data the voice was
packaged with). When neither is installed, :class:`PiperTTS` reports
``available = False`` with a reason, and the app hides its speech features (hard rule
8). Tests inject a word-table phonemizer instead.

Speed
-----
``slow=True`` (dictation) passes ``speed = SLOW_SPEED`` (0.7) to ``generate()``; for a
VITS voice sherpa-onnx turns that into ``length_scale = 1 / 0.7``. Durations are rounded
to whole frames and pauses are not stretched, so the measured effect is smaller than the
nominal 1.43: phrases come out about 20-25% longer than at normal speed.

Clarity
-------
VITS adds random noise to the voice (``noise_scale``) and to phoneme durations
(``noise_scale_w``); Piper's defaults are 0.667 and 0.8, tuned for natural, varied
speech. A dictation needs clear speech more than varied speech, so :class:`PiperTTS`
uses :data:`DEFAULT_NOISE_SCALE` and :data:`DEFAULT_NOISE_SCALE_W` (0.333 each).
Measured with Whisper small listening (10 syntheses each, normal and slow speed), the
share of syntheses heard exactly right went from 12/20 to 18/20 for a French sentence
and from 18/20 to 20/20 for an English one. The output is still random, so a bad take
remains possible: :func:`synthesize_verified` re-synthesises until the recogniser hears
exactly the phrase. Noise 0 makes the output deterministic but flatter, and is not
clearer (the same French sentence was then misheard every time at normal speed).

Output: WAV bytes, PCM16 mono at the voice's sample rate (22 050 Hz for the three
voices), built in memory.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import io
import logging
import re
import threading
import time
import unicodedata
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Protocol, runtime_checkable

import numpy as np

from .align import check_recitation
from .asr import Transcriber, decode_wav
from .textnorm import LANGUAGES, Lang

try:  # The app still starts (without speech) when sherpa-onnx is missing.
    import sherpa_onnx
except ImportError:  # pragma: no cover - sherpa-onnx is installed in the project venv
    sherpa_onnx = None  # type: ignore[assignment]

if TYPE_CHECKING:  # pragma: no cover
    from .config import Settings

log = logging.getLogger(__name__)

#: Voice directory under ``models/`` for each language.
VOICE_DIRS: dict[str, str] = {
    "ar": "vits-piper-ar_JO-kareem-medium",
    "en": "vits-piper-en_US-lessac-medium",
    "fr": "vits-piper-fr_FR-siwis-medium",
}

#: espeak-ng voice of each Piper voice (the ``espeak.voice`` field of its ``.onnx.json``).
ESPEAK_VOICES: dict[str, str] = {"ar": "ar", "en": "en-us", "fr": "fr"}

#: ``speed`` passed to sherpa-onnx for slow (dictation) speech; see the module docstring.
SLOW_SPEED = 0.7

#: Default CPU threads per voice. Synthesis is fast (about 0.1 s per second of speech).
DEFAULT_TTS_THREADS = 2

#: VITS voice noise and duration noise used by default (see "Clarity" above).
DEFAULT_NOISE_SCALE = 0.333
DEFAULT_NOISE_SCALE_W = 0.333

#: Syntheses tried by :func:`synthesize_verified` before giving up.
DEFAULT_VERIFY_ATTEMPTS = 3


class TTSUnavailable(RuntimeError):
    """Raised by :meth:`Synthesizer.synthesize` when speech cannot be synthesised."""


class QuranTextRefused(ValueError):
    """Raised when asked to synthesise Quran text (hard rule 4)."""


#: Characters used only in Quranic script: alef wasla and the Quranic annotation marks
#: (small high letters, pause marks, end of ayah, rub el hizb, sajdah).
_QURANIC_CHARS = frozenset(["\u0671", *map(chr, range(0x06D6, 0x06EE))])


def is_quranic_script(text: str) -> bool:
    """True when ``text`` contains characters used only in Quranic (Uthmani) script.

    This only catches Uthmani text, the form the app displays. Quran text pasted in
    plain spelling looks like any Arabic sentence; refusing it is the caller's job.
    """
    return any(c in _QURANIC_CHARS for c in text)


@runtime_checkable
class Synthesizer(Protocol):
    """Turns text into speech."""

    available: bool

    def synthesize(self, text: str, lang: Lang, *, slow: bool = False) -> bytes:
        """WAV bytes (PCM16 mono) saying ``text`` in ``lang``; ``slow`` for dictation."""
        ...


# ---------------------------------------------------------------------------
# WAV encoding
# ---------------------------------------------------------------------------


def encode_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode float samples in -1..1 as a PCM16 mono WAV file, in memory."""
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    x = np.nan_to_num(np.asarray(samples, dtype=np.float64).ravel())
    pcm = np.round(np.clip(x, -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sample_rate))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Phonemizers
# ---------------------------------------------------------------------------


@runtime_checkable
class Phonemizer(Protocol):
    """Text -> espeak-style IPA phonemes, one string per sentence, as Piper voices expect."""

    name: str

    def phonemize(self, text: str, voice: str, data_dir: Path) -> list[str]:
        """Phonemes of ``text`` for espeak-ng ``voice`` using the data in ``data_dir``."""
        ...


#: Clause punctuation, ASCII and Arabic (، ؛ ؟), plus the ellipsis.
CLAUSE_PUNCTUATION = ".!?…,;:،؛؟"

_SENTENCE_END = {".", "?", "!"}


def split_clauses(text: str) -> list[tuple[str, str]]:
    """Split text into ``(clause, punctuation)`` pairs, the way Piper groups phonemes.

    A clause ends at a run of :data:`CLAUSE_PUNCTUATION`; the run is returned as typed
    (possibly ``""`` for the last clause). A ``.``, ``,`` or ``:`` between two digits
    (``3.5``, ``3,5``, ``12:30``) belongs to the number and does not end a clause.
    """
    pairs: list[tuple[str, str]] = []
    current: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        in_number = c in ".,:" and 0 < i < n - 1 and text[i - 1].isdigit() and text[i + 1].isdigit()
        if c in CLAUSE_PUNCTUATION and not in_number:
            j = i
            while j < n and text[j] in CLAUSE_PUNCTUATION:
                j += 1
            pairs.append(("".join(current).strip(), text[i:j]))
            current = []
            i = j
        else:
            current.append(c)
            i += 1
    tail = "".join(current).strip()
    if tail:
        pairs.append((tail, ""))
    return pairs


def punctuation_mark(run: str) -> str:
    """The single Piper punctuation phoneme for a run of punctuation (``""`` if none).

    Question beats exclamation beats full stop beats ``;`` beats ``:`` beats ``,``, so
    ``"?!"`` is a question and ``"..."`` a full stop. Arabic marks map to their ASCII
    phonemes (the voices' symbol tables only have ASCII punctuation).
    """
    if any(c in "?؟" for c in run):
        return "?"
    if "!" in run:
        return "!"
    if any(c in ".…" for c in run):
        return "."
    if any(c in ";؛" for c in run):
        return ";"
    if ":" in run:
        return ":"
    if any(c in ",،" for c in run):
        return ","
    return ""


def assemble_sentences(text: str, clause_phonemes: Callable[[str], str]) -> list[str]:
    """Phonemize ``text`` clause by clause, adding punctuation as Piper does.

    ``clause_phonemes`` turns one clause (no clause punctuation) into IPA. As in
    ``piper_phonemize``, each clause is followed by its punctuation phoneme (and a space
    after ``,``, ``;`` and ``:``), and ``.``, ``?`` and ``!`` end a sentence. Returns the
    non-empty sentences.
    """
    sentences: list[str] = []
    current = ""
    for clause, run in split_clauses(text):
        phonemes = clause_phonemes(clause).strip() if clause else ""
        mark = punctuation_mark(run)
        if phonemes:  # a punctuation run with no words before it adds nothing
            joined = f"{current} {phonemes}" if current and not current.endswith(" ") else current + phonemes
            current = joined + mark
            if mark in (",", ";", ":"):
                current += " "
        if mark in _SENTENCE_END and current.strip():
            sentences.append(current.strip())
            current = ""
    if current.strip():
        sentences.append(current.strip())
    return sentences


_LANG_SWITCH_RE = re.compile(r"\([a-z]{2,3}(?:-[a-z0-9]+)*\)")


class PiperPhonemizer:
    """espeak-ng phonemes through the ``piper_phonemize`` package (reference back end)."""

    name = "piper_phonemize"

    _lock = threading.Lock()  # espeak-ng keeps process-wide state: one call at a time

    def __init__(self) -> None:
        from piper_phonemize import phonemize_espeak  # raises ImportError when missing

        self._phonemize = phonemize_espeak

    def phonemize(self, text: str, voice: str, data_dir: Path) -> list[str]:
        """``piper_phonemize.phonemize_espeak`` (one phoneme list per sentence), joined."""
        with PiperPhonemizer._lock:
            sentences = self._phonemize(text, voice, str(data_dir))
        return [s for s in ("".join(p) for p in sentences) if s.strip()]


class EspeakNgPhonemizer:
    """espeak-ng phonemes through a ctypes binding to ``libespeak-ng``.

    Uses the public C API of ``speak_lib.h``: ``espeak_Initialize`` (no audio output),
    ``espeak_SetVoiceByName`` and ``espeak_TextToPhonemes`` in IPA mode, which returns one
    clause at a time without its punctuation. Clauses and punctuation are therefore
    handled by :func:`assemble_sentences`, which reproduces what ``piper_phonemize`` does
    with the clause terminators of its patched espeak-ng. espeak-ng's language-switch
    markers such as ``(en)`` are removed.

    espeak-ng is a process-wide singleton, so every call goes through one class lock and
    the library is initialised once per data directory.
    """

    name = "espeak-ng"

    _AUDIO_OUTPUT_SYNCHRONOUS = 2
    _INITIALIZE_DONT_EXIT = 0x8000
    _CHARS_UTF8 = 1
    _PHONEMES_IPA = 0x02

    _lock = threading.Lock()
    _initialised_with: str | None = None

    def __init__(self, library: str) -> None:
        self.library = library
        lib = ctypes.CDLL(library)
        lib.espeak_Initialize.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        lib.espeak_Initialize.restype = ctypes.c_int
        lib.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
        lib.espeak_SetVoiceByName.restype = ctypes.c_int
        lib.espeak_TextToPhonemes.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int, ctypes.c_int]
        lib.espeak_TextToPhonemes.restype = ctypes.c_char_p
        lib.espeak_Terminate.argtypes = []
        lib.espeak_Terminate.restype = ctypes.c_int
        self._lib = lib

    def _ensure_initialised(self, data_dir: Path) -> None:
        path = str(data_dir)
        if EspeakNgPhonemizer._initialised_with == path:
            return
        if EspeakNgPhonemizer._initialised_with is not None:
            self._lib.espeak_Terminate()
            EspeakNgPhonemizer._initialised_with = None
        rate = self._lib.espeak_Initialize(
            self._AUDIO_OUTPUT_SYNCHRONOUS, 0, path.encode("utf-8"), self._INITIALIZE_DONT_EXIT
        )
        if rate <= 0:
            raise RuntimeError(f"espeak-ng could not load its data from {path}")
        EspeakNgPhonemizer._initialised_with = path

    def _clause(self, clause: str) -> str:
        """IPA for text without clause punctuation (espeak may still split it further)."""
        buf = ctypes.create_string_buffer(clause.encode("utf-8"))
        ptr = ctypes.c_void_p(ctypes.addressof(buf))
        parts: list[str] = []
        for _ in range(len(buf) + 1):  # each call consumes at least one character
            if not ptr.value:
                break
            before = ptr.value
            out = self._lib.espeak_TextToPhonemes(ctypes.byref(ptr), self._CHARS_UTF8, self._PHONEMES_IPA)
            if out:
                parts.append(out.decode("utf-8", errors="ignore"))
            if ptr.value == before:
                break
        return _LANG_SWITCH_RE.sub("", " ".join(p.strip() for p in parts if p.strip()))

    def phonemize(self, text: str, voice: str, data_dir: Path) -> list[str]:
        """Phonemes of ``text`` with espeak-ng ``voice`` and the data in ``data_dir``."""
        with EspeakNgPhonemizer._lock:
            self._ensure_initialised(data_dir)
            if self._lib.espeak_SetVoiceByName(voice.encode("ascii")) != 0:
                raise RuntimeError(f"espeak-ng has no voice {voice!r}")
            return assemble_sentences(text, self._clause)


def find_espeak_library() -> str | None:
    """Path of an espeak-ng shared library: ``espeakng_loader``'s, else the system's."""
    try:
        import espeakng_loader  # type: ignore[import-not-found]

        path = espeakng_loader.get_library_path()
        if Path(path).is_file():
            return str(path)
    except Exception:  # not installed, or a broken install
        pass
    return ctypes.util.find_library("espeak-ng")


def find_phonemizer() -> Phonemizer | None:
    """The first espeak-ng back end that is installed (see the module docstring), or None."""
    try:
        return PiperPhonemizer()
    except Exception:
        pass
    library = find_espeak_library()
    if library:
        try:
            return EspeakNgPhonemizer(library)
        except (OSError, AttributeError) as exc:  # not loadable, or not espeak-ng
            log.warning("cannot use espeak-ng library %s: %s", library, type(exc).__name__)
    return None


# ---------------------------------------------------------------------------
# Piper voices
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VoiceFiles:
    """Paths of one sherpa-onnx Piper voice."""

    directory: Path
    model: Path  # <voice>.onnx
    tokens: Path  # tokens.txt: one "symbol id" per line
    data_dir: Path  # espeak-ng-data, read by the phonemizer
    espeak_voice: str

    @classmethod
    def for_lang(cls, models_dir: Path, lang: Lang) -> VoiceFiles:
        """``models/vits-piper-<voice>/<voice>.onnx``, ``tokens.txt``, ``espeak-ng-data``."""
        name = VOICE_DIRS[lang]
        directory = Path(models_dir) / name
        return cls(
            directory=directory,
            model=directory / f"{name.removeprefix('vits-piper-')}.onnx",
            tokens=directory / "tokens.txt",
            data_dir=directory / "espeak-ng-data",
            espeak_voice=ESPEAK_VOICES[lang],
        )

    def missing(self) -> list[Path]:
        """The files and directories that do not exist."""
        out = [p for p in (self.model, self.tokens) if not p.is_file()]
        if not self.data_dir.is_dir():
            out.append(self.data_dir)
        return out


def read_symbols(tokens_file: Path) -> frozenset[str]:
    """The phoneme symbols of a voice (``tokens.txt``: ``symbol id`` per line; the
    symbol may be a space)."""
    symbols: set[str] = set()
    for line in Path(tokens_file).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        symbol, _, ident = line.rpartition(" ")
        if ident.isdigit() and len(symbol) == 1:
            symbols.add(symbol)
    return frozenset(symbols)


@dataclass
class _Voice:
    engine: Any  # sherpa_onnx.OfflineTts
    symbols: frozenset[str]
    sample_rate: int


class PiperTTS:
    """Piper voices for ar/en/fr through ``sherpa_onnx.OfflineTts``.

    Each voice is loaded on first use and cached. One lock serialises loading and
    synthesis, so the object can be shared between request threads.

    ``available`` is True when sherpa-onnx, a phonemizer (see :func:`find_phonemizer`)
    and all three voices are present; ``languages`` lists the languages that can be
    spoken (a subset when some voices are missing) and ``unavailable_reason`` explains
    what is missing. Nothing is raised at construction for missing files.

    ``phonemizer`` overrides the automatic choice (tests use a word table).
    ``noise_scale`` and ``noise_scale_w`` are the VITS noise settings (see "Clarity" in
    the module docstring); 0 for both gives deterministic output.
    """

    def __init__(
        self,
        models_dir: Path,
        *,
        num_threads: int = DEFAULT_TTS_THREADS,
        phonemizer: Phonemizer | None = None,
        noise_scale: float = DEFAULT_NOISE_SCALE,
        noise_scale_w: float = DEFAULT_NOISE_SCALE_W,
    ) -> None:
        if num_threads < 1:
            raise ValueError("num_threads must be at least 1")
        if not (0.0 <= noise_scale <= 2.0 and 0.0 <= noise_scale_w <= 2.0):
            raise ValueError("noise scales must be between 0 and 2")
        self.num_threads = int(num_threads)
        self.noise_scale = float(noise_scale)
        self.noise_scale_w = float(noise_scale_w)
        self.files = {lang: VoiceFiles.for_lang(Path(models_dir), lang) for lang in LANGUAGES}
        self._voices: dict[str, _Voice] = {}
        self._lock = threading.Lock()

        problems: list[str] = []
        if sherpa_onnx is None:
            problems.append("the sherpa_onnx package is not installed")
        elif not hasattr(sherpa_onnx, "GenerationConfig"):
            problems.append("sherpa_onnx is too old (GenerationConfig is missing)")
        self.phonemizer = phonemizer if phonemizer is not None else find_phonemizer()
        if self.phonemizer is None:
            problems.append(
                "no espeak-ng phonemizer: sherpa-onnx 2.0 no longer bundles espeak-ng; "
                "install piper_phonemize, espeakng_loader or libespeak-ng"
            )
        missing_langs = []
        for lang, files in self.files.items():
            if files.missing():
                missing_langs.append(lang)
                names = ", ".join(p.name for p in files.missing())
                problems.append(f"{lang} voice files missing in {files.directory}: {names}")

        engine_ok = sherpa_onnx is not None and hasattr(sherpa_onnx, "GenerationConfig")
        usable = engine_ok and self.phonemizer is not None
        self.languages: tuple[Lang, ...] = (
            tuple(lang for lang in LANGUAGES if lang not in missing_langs) if usable else ()
        )
        self.unavailable_reason: str | None = "; ".join(problems) or None
        self.available: bool = usable and not missing_langs
        if problems:
            log.warning("speech synthesis limited: %s", self.unavailable_reason)

    @classmethod
    def from_settings(cls, settings: Settings, *, phonemizer: Phonemizer | None = None) -> PiperTTS:
        """Build from :class:`~mommy.config.Settings` (its models directory)."""
        return cls(settings.models_dir, phonemizer=phonemizer)

    def _voice(self, lang: Lang) -> _Voice:
        """The cached voice for ``lang`` (call with the lock held)."""
        voice = self._voices.get(lang)
        if voice is None:
            files = self.files[lang]
            started = time.perf_counter()
            config = sherpa_onnx.OfflineTtsConfig(
                model=sherpa_onnx.OfflineTtsModelConfig(
                    vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                        model=str(files.model),
                        tokens=str(files.tokens),
                        # Ignored by sherpa-onnx >= 2.0 (the phonemizer reads it instead),
                        # used by older versions.
                        data_dir=str(files.data_dir),
                        noise_scale=self.noise_scale,
                        noise_scale_w=self.noise_scale_w,
                    ),
                    num_threads=self.num_threads,
                ),
                max_num_sentences=1,
            )
            engine = sherpa_onnx.OfflineTts(config)
            voice = _Voice(engine=engine, symbols=read_symbols(files.tokens), sample_rate=int(engine.sample_rate))
            self._voices[lang] = voice
            log.info("loaded %s voice in %.1f s", lang, time.perf_counter() - started)
        return voice

    def phoneme_codepoints(self, text: str, lang: Lang) -> list[list[int]]:
        """The phoneme code points sent to the voice: one list per sentence, NFD (as
        ``piper_phonemize`` produces them), keeping only symbols the voice knows."""
        _check_lang(lang)
        if self.phonemizer is None:
            raise TTSUnavailable(self.unavailable_reason or "no phonemizer")
        files = self.files[lang]
        with self._lock:
            symbols = self._voice(lang).symbols
        sentences = self.phonemizer.phonemize(text, files.espeak_voice, files.data_dir)
        out: list[list[int]] = []
        for sentence in sentences:
            points = [ord(c) for c in unicodedata.normalize("NFD", sentence) if c in symbols]
            if any(chr(p) != " " for p in points):
                out.append(points)
        return out

    def synthesize(self, text: str, lang: Lang, *, slow: bool = False) -> bytes:
        """WAV bytes (PCM16 mono, the voice's sample rate) saying ``text`` in ``lang``.

        ``slow`` uses :data:`SLOW_SPEED` (dictation). Raises ValueError for an unknown
        language or a text with nothing to say, :class:`QuranTextRefused` (a ValueError)
        for Uthmani Quran text, and :class:`TTSUnavailable` when the voice or the
        phonemizer is missing.
        """
        _check_lang(lang)
        if lang not in self.languages:
            raise TTSUnavailable(self.unavailable_reason or f"no {lang} voice")
        if not text or not text.strip():
            raise ValueError("text is empty")
        if is_quranic_script(text):
            raise QuranTextRefused("Quran text is never synthesised")
        codepoints = self.phoneme_codepoints(text, lang)
        if not codepoints:
            raise ValueError("text has nothing to pronounce")
        started = time.perf_counter()
        with self._lock:
            voice = self._voice(lang)
            gen = sherpa_onnx.GenerationConfig()
            gen.sid = 0
            gen.speed = SLOW_SPEED if slow else 1.0
            gen.phoneme_codepoints = codepoints
            audio = voice.engine.generate("", gen)
        samples = np.asarray(audio.samples, dtype=np.float32)
        if samples.size == 0:
            raise RuntimeError("the voice produced no audio")
        rate = int(audio.sample_rate) or voice.sample_rate
        # Sizes and timings only (hard rule 5 asks this for children's data; the same
        # habit is kept here).
        log.info(
            "synthesised %d chars of %s%s: %.2f s of audio in %.2f s",
            len(text), lang, " (slow)" if slow else "", samples.size / rate, time.perf_counter() - started,
        )
        return encode_wav(samples, rate)


class FakeTTS:
    """A :class:`Synthesizer` for tests: a quiet 220 Hz tone, 60 ms per character.

    ``calls`` records ``(text, lang, slow)``. ``slow`` makes the tone 40% longer. With
    ``available=False`` it raises :class:`TTSUnavailable` like a missing voice.
    """

    def __init__(self, *, available: bool = True, sample_rate: int = 16_000) -> None:
        self.available = available
        self.sample_rate = sample_rate
        self.calls: list[tuple[str, str, bool]] = []

    def synthesize(self, text: str, lang: Lang, *, slow: bool = False) -> bytes:
        """WAV bytes of a tone whose length follows the text length."""
        _check_lang(lang)
        if not self.available:
            raise TTSUnavailable("fake synthesizer is unavailable")
        if not text or not text.strip():
            raise ValueError("text is empty")
        self.calls.append((text, lang, slow))
        seconds = max(0.3, 0.06 * len(text)) * (1.4 if slow else 1.0)
        t = np.arange(int(seconds * self.sample_rate)) / self.sample_rate
        return encode_wav(0.1 * np.sin(2 * np.pi * 220.0 * t), self.sample_rate)


# ---------------------------------------------------------------------------
# Round trip
# ---------------------------------------------------------------------------


def _check_heard(wav: bytes, asr: Transcriber, text: str, lang: Lang) -> tuple[bool, str]:
    """Transcribe ``wav`` unprompted; (heard exactly ``text``?, what was heard)."""
    heard = asr.transcribe(decode_wav(wav), lang)
    result = check_recitation(text, heard, lang)
    return result.n_errors == 0 and not result.say_again, heard


def audio_says(wav: bytes, asr: Transcriber, text: str, lang: Lang) -> bool:
    """True when ``asr``, transcribing ``wav`` unprompted, hears exactly ``text``.

    "Exactly" is :func:`~mommy.align.check_recitation`: no substituted, missing or added
    word, and a usable result (not ``say_again``). Use this to check the very bytes that
    will be played: Piper output is random, so two syntheses differ.
    """
    return _check_heard(wav, asr, text, lang)[0]


def roundtrip_ok(tts: Synthesizer, asr: Transcriber, text: str, lang: Lang, *, slow: bool = False) -> bool:
    """Synthesise ``text``, transcribe it unprompted and check it word by word.

    True when there are no errors (see :func:`audio_says`): the audio says exactly the
    phrase. False when either side is unavailable.
    """
    if not getattr(tts, "available", False) or not getattr(asr, "available", False):
        return False
    return audio_says(tts.synthesize(text, lang, slow=slow), asr, text, lang)


@dataclass(frozen=True)
class VerifiedSpeech:
    """The result of :func:`synthesize_verified`."""

    wav: bytes  # the audio to play
    ok: bool  # True when the recogniser heard exactly the phrase in ``wav``
    heard: str  # what the recogniser heard in ``wav`` ("" when it was not run)
    attempts: int  # syntheses made


def synthesize_verified(
    tts: Synthesizer,
    asr: Transcriber,
    text: str,
    lang: Lang,
    *,
    slow: bool = False,
    attempts: int = DEFAULT_VERIFY_ATTEMPTS,
) -> VerifiedSpeech:
    """Synthesise ``text`` until an unprompted transcription of it matches exactly.

    Each attempt is a fresh synthesis (Piper output is random) checked with
    :func:`audio_says`. Returns the first take that passes, or the last take with
    ``ok=False`` after ``attempts`` takes. When the recogniser is unavailable, the first
    take is returned unchecked (``ok=False``, ``heard=""``). Errors from ``tts`` (an
    unavailable voice, an empty text) are raised as they are.
    """
    if attempts < 1:
        raise ValueError("attempts must be at least 1")
    wav = tts.synthesize(text, lang, slow=slow)
    if not getattr(asr, "available", False):
        return VerifiedSpeech(wav=wav, ok=False, heard="", attempts=1)
    for attempt in range(1, attempts + 1):
        if attempt > 1:
            wav = tts.synthesize(text, lang, slow=slow)
        ok, heard = _check_heard(wav, asr, text, lang)
        if ok:
            break
    log.info("verified %s speech: %s after %d attempt(s)", lang, "ok" if ok else "not ok", attempt)
    return VerifiedSpeech(wav=wav, ok=ok, heard=heard, attempts=attempt)


def _check_lang(lang: str) -> None:
    if lang not in LANGUAGES:
        raise ValueError(f"unsupported language {lang!r}; expected one of {LANGUAGES}")


__all__ = [
    "CLAUSE_PUNCTUATION",
    "DEFAULT_NOISE_SCALE",
    "DEFAULT_NOISE_SCALE_W",
    "DEFAULT_TTS_THREADS",
    "DEFAULT_VERIFY_ATTEMPTS",
    "ESPEAK_VOICES",
    "EspeakNgPhonemizer",
    "FakeTTS",
    "Phonemizer",
    "PiperPhonemizer",
    "PiperTTS",
    "QuranTextRefused",
    "SLOW_SPEED",
    "Synthesizer",
    "TTSUnavailable",
    "VOICE_DIRS",
    "VerifiedSpeech",
    "VoiceFiles",
    "assemble_sentences",
    "audio_says",
    "encode_wav",
    "find_espeak_library",
    "find_phonemizer",
    "is_quranic_script",
    "punctuation_mark",
    "read_symbols",
    "roundtrip_ok",
    "split_clauses",
    "synthesize_verified",
]

"""Speech recognition: local Whisper models through sherpa-onnx, never told what to expect.

Hard rule 1 of the contract: the recogniser is never given the expected text. No prompt,
no hotwords, no context. A recogniser that knows the expected text "hears" it and hides
the child's mistakes. :class:`SherpaWhisper` therefore only ever receives audio and a
language code, and ``sherpa_onnx.OfflineRecognizer.from_whisper`` (sherpa-onnx 2.0) has no
prompt or hotword parameter at all. The deterministic comparison is done afterwards, by
:func:`mommy.align.check_recitation`.

Privacy (hard rule 5): audio is handled in memory only. This module never writes audio
to disk and never logs audio or transcripts; it logs sizes and timings only.

Pieces
------
* :func:`decode_wav` parses an uploaded RIFF/WAV file and returns float32 mono samples at
  16 kHz in -1..1 (the input format of every :class:`Transcriber`).
* :func:`wav_duration` reads the length from the header only, so an over-long upload can
  be refused before it is decoded.
* :func:`audio_quality` measures length and loudness, so that a clip that is too short or
  too quiet is answered with "say it again" instead of a guess.
* :class:`SherpaWhisper` is the real recogniser; :class:`FakeTranscriber` is for tests.

Whisper details (measured on sherpa-onnx 2.0.1)
-----------------------------------------------
* A Whisper model reads windows of at most 30 seconds; sherpa-onnx keeps the first 30 s
  and drops the rest. Longer clips (the API accepts up to 120 s) are therefore cut into
  pieces of at most :data:`MAX_CHUNK_SECONDS`, each cut placed at the quietest moment of
  the last :data:`CUT_SEARCH_SECONDS` before the limit (see :func:`split_for_whisper`),
  and the pieces' transcripts are joined.
* Decoding zero or one sample crashes the native library (segmentation fault), so clips
  shorter than :data:`MIN_DECODE_SAMPLES` are never decoded: there is no word in them.
* On silence or noise Whisper writes sound descriptions such as ``(upbeat music)`` or
  ``[Music]``. They are not words the child said, so :func:`clean_transcript` removes
  text in round or square brackets and music notes.
* ``tail_paddings`` is left at the library default (-1): the features are padded to the
  full 30 s window, which is what the models were trained on. ``decoding_method`` is the
  only one sherpa-onnx offers for Whisper, ``"greedy_search"``.
* Speed with 4 threads on a 4-core CPU (int8 models): a real-time factor of about 0.3
  for both small and turbo (1.5 s for a 5 s clip, 5 s for 17 s, 11 s for 33 s in two
  pieces). The first decode after loading is slower. Loading takes 2-4 s per language
  from a warm disk cache (40 s for turbo from a cold one).
* One recogniser is built per language, as the contract asks; each holds its own copy
  of the weights (small: about 0.4 GB on disk, turbo: about 1 GB).
"""

from __future__ import annotations

import logging
import math
import re
import struct
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

import numpy as np

from .config import ASR_MODELS
from .textnorm import LANGUAGES, Lang

try:  # The app still starts (offline, without speech) when sherpa-onnx is missing.
    import sherpa_onnx
except ImportError:  # pragma: no cover - sherpa-onnx is installed in the project venv
    sherpa_onnx = None  # type: ignore[assignment]

if TYPE_CHECKING:  # pragma: no cover
    from .config import Settings

log = logging.getLogger(__name__)

#: Sample rate of every array handed to a :class:`Transcriber`.
SAMPLE_RATE = 16_000

#: A clip shorter than this (seconds) is ``too_short``: no word fits in it.
MIN_SECONDS = 0.5

#: A clip whose speech level (see :func:`audio_quality`) is below this is ``too_quiet``.
#: 0.005 is about -46 dBFS: a room with nobody speaking, or a muted microphone.
QUIET_LEVEL = 0.005

#: Frame length (seconds) used to measure the speech level.
LEVEL_FRAME_SECONDS = 0.025

#: Share of the loudest frames whose RMS is the speech level...
LEVEL_TOP_FRACTION = 0.10

#: ...but never more than this many seconds of them.
LEVEL_TOP_MAX_SECONDS = 0.5

#: Longest piece decoded in one Whisper call (the model window is 30 s; sherpa-onnx
#: refuses features within 0.5 s of it).
MAX_CHUNK_SECONDS = 28.0

#: A long clip is cut at the quietest point of this many seconds before the limit.
CUT_SEARCH_SECONDS = 8.0

#: Clips (and pieces) shorter than this many samples are not decoded (0.1 s).
MIN_DECODE_SAMPLES = 1_600

# WAV format tags (WAVEFORMATEX.wFormatTag).
_WAVE_FORMAT_PCM = 0x0001
_WAVE_FORMAT_IEEE_FLOAT = 0x0003
_WAVE_FORMAT_EXTENSIBLE = 0xFFFE

# Plausible limits for a WAV header; anything else is treated as garbage.
_MIN_RATE, _MAX_RATE = 1_000, 768_000
_MAX_CHANNELS = 16


class ASRUnavailable(RuntimeError):
    """Raised by :meth:`Transcriber.transcribe` when the recogniser cannot run."""


@runtime_checkable
class Transcriber(Protocol):
    """Turns a child's speech into text, without knowing what the child should say."""

    available: bool

    def transcribe(self, pcm16k: np.ndarray, lang: Lang) -> str:
        """Transcribe float32 mono audio at 16 kHz in -1..1, spoken in ``lang``."""
        ...


# ---------------------------------------------------------------------------
# WAV decoding
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _WavFormat:
    tag: int  # _WAVE_FORMAT_PCM or _WAVE_FORMAT_IEEE_FLOAT (after resolving EXTENSIBLE)
    channels: int
    rate: int
    bits: int


def _parse_fmt(body: bytes) -> _WavFormat:
    """Parse the body of a ``fmt `` chunk."""
    if len(body) < 16:
        raise ValueError("WAV fmt chunk is too short")
    tag, channels, rate, _byte_rate, _block_align, bits = struct.unpack_from("<HHIIHH", body, 0)
    if tag == _WAVE_FORMAT_EXTENSIBLE:
        # WAVEFORMATEXTENSIBLE: cbSize, wValidBitsPerSample, dwChannelMask, SubFormat GUID.
        # The first two bytes of the GUID are the real format tag.
        if len(body) < 40:
            raise ValueError("WAV extensible fmt chunk is too short")
        (tag,) = struct.unpack_from("<H", body, 24)
    if tag not in (_WAVE_FORMAT_PCM, _WAVE_FORMAT_IEEE_FLOAT):
        raise ValueError(f"unsupported WAV encoding (format tag {tag:#06x}); use PCM or float")
    if not 1 <= channels <= _MAX_CHANNELS:
        raise ValueError(f"unsupported WAV channel count {channels}")
    if not _MIN_RATE <= rate <= _MAX_RATE:
        raise ValueError(f"unsupported WAV sample rate {rate}")
    supported = {8, 16, 24, 32} if tag == _WAVE_FORMAT_PCM else {32, 64}
    if bits not in supported:
        raise ValueError(f"unsupported WAV sample size {bits} bits")
    return _WavFormat(tag=tag, channels=channels, rate=rate, bits=bits)


def _read_chunks(data: bytes) -> tuple[_WavFormat, bytes]:
    """Find the ``fmt `` and ``data`` chunks of a RIFF/WAVE file."""
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    fmt: _WavFormat | None = None
    samples: bytes | None = None
    pos = 12
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        (size,) = struct.unpack_from("<I", data, pos + 4)
        start = pos + 8
        # Streaming writers may leave the size at 0xFFFFFFFF; a truncated upload may
        # announce more than it holds. Either way, read what is there.
        end = len(data) if size == 0xFFFFFFFF else min(start + size, len(data))
        if chunk_id == b"fmt ":
            fmt = _parse_fmt(data[start:end])
        elif chunk_id == b"data":
            samples = data[start:end]
        if fmt is not None and samples is not None:
            break
        pos = start + size + (size & 1)  # chunks are padded to an even size
    if fmt is None:
        raise ValueError("WAV file has no fmt chunk")
    if samples is None:
        raise ValueError("WAV file has no data chunk")
    return fmt, samples


def _to_float(raw: bytes, fmt: _WavFormat) -> np.ndarray:
    """Interleaved sample bytes -> float64 array of shape (frames, channels) in -1..1."""
    width = fmt.bits // 8
    frame_bytes = width * fmt.channels
    n_frames = len(raw) // frame_bytes  # a trailing partial frame is dropped
    if n_frames == 0:
        raise ValueError("WAV file has no audio")
    raw = raw[: n_frames * frame_bytes]
    if fmt.tag == _WAVE_FORMAT_IEEE_FLOAT:
        x = np.frombuffer(raw, dtype="<f4" if fmt.bits == 32 else "<f8").astype(np.float64)
    elif fmt.bits == 8:  # 8-bit PCM is unsigned, centred on 128
        x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif fmt.bits == 16:
        x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif fmt.bits == 24:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= 1 << 23, v - (1 << 24), v)  # sign-extend
        x = v.astype(np.float64) / float(1 << 23)
    else:  # 32-bit integer PCM
        x = np.frombuffer(raw, dtype="<i4").astype(np.float64) / float(1 << 31)
    return x.reshape(n_frames, fmt.channels)


def resample_to_16k(x: np.ndarray, rate: int) -> np.ndarray:
    """Resample a mono float signal from ``rate`` Hz to 16 kHz.

    Band-limited resampling in the frequency domain (numpy FFT): the spectrum is cut (or
    zero-extended) at the lower of the two Nyquist frequencies, which is an ideal
    anti-aliasing filter when going down (44.1 kHz -> 16 kHz) and an ideal anti-imaging
    filter when going up (8 kHz -> 16 kHz). Linear interpolation would fold everything
    above 8 kHz back into the speech band. 50 ms of silence is added at both ends
    before the transform and removed after, so the end of the clip does not wrap around
    into its start. Cost: two real FFTs of the clip, well under a second for 120 s.
    """
    x = np.asarray(x, dtype=np.float64)
    if rate == SAMPLE_RATE or x.size == 0:
        return x
    n_out = max(1, int(round(x.size * SAMPLE_RATE / rate)))
    # Lengths are whole multiples of ``step`` input samples (``step_out`` output samples),
    # so the padding and the total length are exact at both rates: no fractional shift and
    # no drift. The number of steps is 5-smooth so the FFTs stay fast.
    g = math.gcd(rate, SAMPLE_RATE)
    step, step_out = rate // g, SAMPLE_RATE // g
    pad_steps = max(1, math.ceil((rate // 20) / step))
    n_steps = _next_smooth(math.ceil(x.size / step) + 2 * pad_steps)
    pad = pad_steps * step
    n_in_p = n_steps * step
    n_out_p = n_steps * step_out
    padded = np.zeros(n_in_p)
    padded[pad : pad + x.size] = x
    spectrum = np.fft.rfft(padded)
    out = np.zeros(n_out_p // 2 + 1, dtype=np.complex128)
    keep = min(spectrum.size, out.size)
    out[:keep] = spectrum[:keep]
    if n_out_p < n_in_p and n_out_p % 2 == 0:
        out[-1] = 0.0  # the new Nyquist bin cannot hold a phase; drop it
    y = np.fft.irfft(out, n_out_p) * (n_out_p / n_in_p)
    start = pad_steps * step_out
    return y[start : start + n_out]


def _next_smooth(n: int) -> int:
    """The smallest integer >= n whose only prime factors are 2, 3 and 5."""
    best = 1 << max(0, (n - 1).bit_length())  # a power of two >= n
    p5 = 1
    while p5 < best:
        p35 = p5
        while p35 < best:
            # Smallest power of two that brings p35 up to at least n.
            p = p35
            while p < n:
                p *= 2
            best = min(best, p)
            p35 *= 3
        p5 *= 5
    return max(best, 1)


def decode_wav(data: bytes) -> np.ndarray:
    """Decode a RIFF/WAV file into float32 mono samples at 16 kHz in -1..1.

    Accepts integer PCM (8-bit unsigned, 16, 24 and 32-bit signed) and IEEE float (32 and
    64-bit), also inside WAVE_FORMAT_EXTENSIBLE headers, with any number of channels
    (averaged to mono) and any sample rate from 1 kHz to 768 kHz (resampled with
    :func:`resample_to_16k`). Values outside -1..1 are clipped and NaN or infinite
    floats become 0.

    Raises ValueError for anything that is not a usable WAV file: not RIFF/WAVE, missing
    chunks, an unsupported encoding (A-law, ADPCM, ...), or no audio frames at all.
    """
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise ValueError("WAV data must be bytes")
    data = bytes(data)
    if not data:
        raise ValueError("empty audio file")
    fmt, raw = _read_chunks(data)
    frames = _to_float(raw, fmt)
    mono = frames.mean(axis=1) if fmt.channels > 1 else frames[:, 0]
    pcm = resample_to_16k(mono, fmt.rate)
    pcm = np.nan_to_num(pcm, nan=0.0, posinf=0.0, neginf=0.0)
    return np.ascontiguousarray(np.clip(pcm, -1.0, 1.0), dtype=np.float32)


def wav_duration(data: bytes) -> float:
    """Length in seconds of a RIFF/WAV file, read from its header without decoding it.

    Lets a caller refuse an over-long upload before :func:`decode_wav` spends memory and
    time on it: 10 MB of 8-bit audio at 1 kHz is almost three hours, which would be about
    160 million samples once resampled to 16 kHz. The length counts the complete frames
    present in the ``data`` chunk (a truncated upload counts what it holds), exactly as
    :func:`decode_wav` would decode them.

    Raises ValueError, like :func:`decode_wav`, for anything that is not a usable WAV file.
    """
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise ValueError("WAV data must be bytes")
    data = bytes(data)
    if not data:
        raise ValueError("empty audio file")
    fmt, raw = _read_chunks(data)
    n_frames = len(raw) // (fmt.bits // 8 * fmt.channels)
    if n_frames == 0:
        raise ValueError("WAV file has no audio")
    return n_frames / fmt.rate


# ---------------------------------------------------------------------------
# Audio quality
# ---------------------------------------------------------------------------


def audio_quality(pcm: np.ndarray) -> dict:
    """Length and loudness of a 16 kHz clip: ``{"seconds", "rms", "too_quiet", "too_short"}``.

    * ``seconds``: the clip length at 16 kHz;
    * ``rms``: the RMS of the whole clip after removing any DC offset (for display and
      logs);
    * ``too_short``: ``seconds < MIN_SECONDS`` (0.5 s);
    * ``too_quiet``: the *speech level* is below ``QUIET_LEVEL`` (0.005, about -46 dBFS).
      The speech level is the RMS of the loudest 10% of 25 ms frames (at most the
      loudest 0.5 s of them), so that a short sentence followed by a long pause still
      counts as audible: the whole-clip RMS of one second of speech in a two-minute
      recording is eleven times lower than the speech itself.

    An empty clip is both too short and too quiet.
    """
    x = np.asarray(pcm, dtype=np.float64).ravel()
    seconds = x.size / SAMPLE_RATE
    if x.size == 0:
        return {"seconds": 0.0, "rms": 0.0, "too_quiet": True, "too_short": True}
    x = np.nan_to_num(x - x.mean())
    rms = float(np.sqrt(np.mean(x * x)))
    frame = int(SAMPLE_RATE * LEVEL_FRAME_SECONDS)
    n_frames = x.size // frame
    if n_frames == 0:
        level = rms
    else:
        energies = np.mean(x[: n_frames * frame].reshape(n_frames, frame) ** 2, axis=1)
        cap = int(LEVEL_TOP_MAX_SECONDS / LEVEL_FRAME_SECONDS)
        top = max(1, min(cap, int(np.ceil(n_frames * LEVEL_TOP_FRACTION))))
        level = float(np.sqrt(np.mean(np.sort(energies)[-top:])))
    return {
        "seconds": float(seconds),
        "rms": rms,
        "too_quiet": bool(level < QUIET_LEVEL),
        "too_short": bool(seconds < MIN_SECONDS),
    }


# ---------------------------------------------------------------------------
# Whisper helpers
# ---------------------------------------------------------------------------


def _as_pcm(pcm16k: np.ndarray) -> np.ndarray:
    """A contiguous 1-D float32 copy-or-view in -1..1 with no NaN or infinity."""
    x = np.asarray(pcm16k, dtype=np.float32).ravel()
    if not np.all(np.isfinite(x)):
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    return np.ascontiguousarray(np.clip(x, -1.0, 1.0), dtype=np.float32)


def split_for_whisper(
    pcm: np.ndarray,
    *,
    max_seconds: float = MAX_CHUNK_SECONDS,
    search_seconds: float = CUT_SEARCH_SECONDS,
) -> list[np.ndarray]:
    """Cut a 16 kHz clip into pieces Whisper can decode (at most ``max_seconds`` each).

    A clip that fits is returned whole. Otherwise each cut is placed at the quietest
    100 ms of the ``search_seconds`` before the limit, so words are not cut in half when
    the child pauses. Pieces shorter than :data:`MIN_DECODE_SAMPLES` are dropped. The
    returned pieces are views of ``pcm`` and, before dropping, cover it exactly.
    """
    limit = int(max_seconds * SAMPLE_RATE)
    if limit <= 0:
        raise ValueError("max_seconds must be positive")
    search = min(int(search_seconds * SAMPLE_RATE), limit - 1)
    window = SAMPLE_RATE // 10  # 100 ms
    pieces: list[np.ndarray] = []
    start = 0
    n = pcm.size
    while n - start > limit:
        lo, hi = start + limit - search, start + limit
        seg = pcm[lo:hi].astype(np.float64)
        if seg.size > window:
            energy = np.convolve(seg * seg, np.ones(window), mode="valid")
            cut = lo + int(np.argmin(energy)) + window // 2
        else:
            cut = hi
        pieces.append(pcm[start:cut])
        start = cut
    pieces.append(pcm[start:])
    return [p for p in pieces if p.size >= MIN_DECODE_SAMPLES]


_ANNOTATION_RE = re.compile(r"\([^()]*\)|\[[^\[\]]*\]|[♪♫♬]")


def clean_transcript(text: str) -> str:
    """Remove Whisper's sound descriptions and tidy spaces.

    Whisper writes non-speech sounds in brackets (``(upbeat music)``, ``[Music]``,
    ``(sighs)``) or as music notes. A child does not say brackets aloud, so any text in
    round or square brackets is a description, not speech, and is removed.
    """
    return " ".join(_ANNOTATION_RE.sub(" ", text).split())


# ---------------------------------------------------------------------------
# Recognisers
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WhisperFiles:
    """Paths of one sherpa-onnx Whisper model (int8 weights)."""

    directory: Path
    encoder: Path
    decoder: Path
    tokens: Path

    @classmethod
    def for_model(cls, models_dir: Path, model: str) -> WhisperFiles:
        """``models/sherpa-onnx-whisper-{model}/{model}-encoder.int8.onnx`` and friends."""
        directory = Path(models_dir) / f"sherpa-onnx-whisper-{model}"
        return cls(
            directory=directory,
            encoder=directory / f"{model}-encoder.int8.onnx",
            decoder=directory / f"{model}-decoder.int8.onnx",
            tokens=directory / f"{model}-tokens.txt",
        )

    def missing(self) -> list[Path]:
        """The files that do not exist."""
        return [p for p in (self.encoder, self.decoder, self.tokens) if not p.is_file()]


class SherpaWhisper:
    """Local Whisper (small or turbo, int8) through ``sherpa_onnx``.

    One recogniser is built per language, lazily on first use, and cached. Building and
    decoding happen under one lock, so the object can be shared between request threads
    (decodes run one at a time and each uses ``num_threads`` CPU threads).

    ``available`` is False, and :meth:`transcribe` raises :class:`ASRUnavailable`, when
    the model files or the ``sherpa_onnx`` package are missing; ``unavailable_reason``
    then says why. Nothing is raised at construction for missing files.

    The recogniser is never given a prompt, hotwords or the expected text (hard rule 1).
    """

    def __init__(self, models_dir: Path, model: str = "small", num_threads: int = 4) -> None:
        if model not in ASR_MODELS:
            raise ValueError(f"unknown Whisper model {model!r}; expected one of {ASR_MODELS}")
        if num_threads < 1:
            raise ValueError("num_threads must be at least 1")
        self.model = model
        self.num_threads = int(num_threads)
        self.files = WhisperFiles.for_model(Path(models_dir), model)
        self._recognizers: dict[str, Any] = {}
        self._lock = threading.Lock()

        missing = self.files.missing()
        if sherpa_onnx is None:
            self.unavailable_reason: str | None = "the sherpa_onnx package is not installed"
        elif missing:
            names = ", ".join(p.name for p in missing)
            self.unavailable_reason = f"Whisper {model} model files missing in {self.files.directory}: {names}"
        else:
            self.unavailable_reason = None
        self.available: bool = self.unavailable_reason is None
        if not self.available:
            log.warning("speech recognition unavailable: %s", self.unavailable_reason)

    @classmethod
    def from_settings(cls, settings: Settings) -> SherpaWhisper:
        """Build from :class:`~mommy.config.Settings` (models dir, model name, threads)."""
        return cls(settings.models_dir, settings.asr_model, settings.asr_threads)

    def _recognizer(self, lang: Lang) -> Any:
        """The cached recogniser for ``lang`` (call with the lock held)."""
        rec = self._recognizers.get(lang)
        if rec is None:
            started = time.perf_counter()
            # The complete argument list. There is deliberately no prompt and no hotword
            # option: the recogniser must not know what the child is expected to say.
            rec = sherpa_onnx.OfflineRecognizer.from_whisper(
                encoder=str(self.files.encoder),
                decoder=str(self.files.decoder),
                tokens=str(self.files.tokens),
                language=lang,
                task="transcribe",
                num_threads=self.num_threads,
                decoding_method="greedy_search",
            )
            self._recognizers[lang] = rec
            log.info(
                "loaded Whisper %s for %s in %.1f s", self.model, lang, time.perf_counter() - started
            )
        return rec

    def preload(self, langs: tuple[Lang, ...] = LANGUAGES) -> None:
        """Build the recognisers for ``langs`` now instead of on first use."""
        if not self.available:
            raise ASRUnavailable(self.unavailable_reason or "speech recognition unavailable")
        with self._lock:
            for lang in langs:
                _check_lang(lang)
                self._recognizer(lang)

    def transcribe(self, pcm16k: np.ndarray, lang: Lang) -> str:
        """Transcribe float32 mono 16 kHz audio spoken in ``lang`` (no prompt, no hotwords).

        Returns the cleaned transcript (:func:`clean_transcript`), or ``""`` for a clip
        shorter than 0.1 s. Clips longer than :data:`MAX_CHUNK_SECONDS` are decoded in
        pieces (:func:`split_for_whisper`). Raises :class:`ASRUnavailable` when the model
        cannot run and ValueError for an unknown language.
        """
        _check_lang(lang)
        if not self.available:
            raise ASRUnavailable(self.unavailable_reason or "speech recognition unavailable")
        pcm = _as_pcm(pcm16k)
        pieces = split_for_whisper(pcm)
        if not pieces:
            return ""
        started = time.perf_counter()
        texts: list[str] = []
        with self._lock:
            rec = self._recognizer(lang)
            for piece in pieces:
                stream = rec.create_stream()
                stream.accept_waveform(SAMPLE_RATE, piece)
                rec.decode_stream(stream)
                texts.append(stream.result.text)
        elapsed = time.perf_counter() - started
        seconds = pcm.size / SAMPLE_RATE
        # Sizes and timings only: never the audio or the words (hard rule 5).
        log.info(
            "transcribed %.2f s of %s audio in %d piece(s) in %.2f s (RTF %.2f)",
            seconds, lang, len(pieces), elapsed, elapsed / seconds if seconds else 0.0,
        )
        return clean_transcript(" ".join(texts))


class FakeTranscriber:
    """A :class:`Transcriber` for tests: returns a preset transcript.

    ``calls`` records ``(lang, n_samples)`` for each call (never the audio itself).
    With ``available=False`` it behaves like a recogniser whose models are missing.
    """

    def __init__(self, text: str = "", *, available: bool = True) -> None:
        self.text = text
        self.available = available
        self.calls: list[tuple[str, int]] = []

    def transcribe(self, pcm16k: np.ndarray, lang: Lang) -> str:
        """Return the preset text (raises like the real one when unavailable)."""
        _check_lang(lang)
        if not self.available:
            raise ASRUnavailable("fake transcriber is unavailable")
        self.calls.append((lang, int(np.asarray(pcm16k).size)))
        return self.text


def _check_lang(lang: str) -> None:
    if lang not in LANGUAGES:
        raise ValueError(f"unsupported language {lang!r}; expected one of {LANGUAGES}")


__all__ = [
    "ASRUnavailable",
    "CUT_SEARCH_SECONDS",
    "FakeTranscriber",
    "MAX_CHUNK_SECONDS",
    "MIN_DECODE_SAMPLES",
    "MIN_SECONDS",
    "QUIET_LEVEL",
    "SAMPLE_RATE",
    "SherpaWhisper",
    "Transcriber",
    "WhisperFiles",
    "audio_quality",
    "clean_transcript",
    "decode_wav",
    "resample_to_16k",
    "split_for_whisper",
    "wav_duration",
]

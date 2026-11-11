"""Tests for speech in and out: ``mommy.asr`` (Whisper) and ``mommy.tts`` (Piper).

Unit tests (always run) cover WAV decoding and resampling, the audio quality gate, long
clip splitting, transcript cleaning, the recogniser wrapper (with a fake sherpa-onnx, to
prove it is never given a prompt or hotwords), phoneme assembly, and the fakes.

Integration tests use the real local models and skip cleanly when they are missing:

* recorded human speech from the Whisper test clips (8 kHz and 16 kHz files);
* Piper voices -> WAV -> ``decode_wav`` -> Whisper -> ``check_recitation`` round trips in
  English, French and Arabic, and end-to-end error detection (a skipped word, a
  substituted word) where the recogniser never sees the expected text;
* real-time factor of Whisper small and turbo with 4 threads.

sherpa-onnx 2.0 no longer bundles the espeak-ng phonemizer, so the Piper tests use
:class:`TablePhonemizer`: hand-written espeak-style IPA for the few words of the test
sentences, standing in for espeak-ng. Everything after the phonemes is the real path.
The real espeak-ng back end is tested only when a library is installed.
"""

from __future__ import annotations

import inspect
import io
import math
import struct
import threading
import time
import wave
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from mommy import asr as asr_mod
from mommy import tts as tts_mod
from mommy.align import check_recitation
from mommy.asr import (
    ASRUnavailable,
    FakeTranscriber,
    MIN_DECODE_SAMPLES,
    SAMPLE_RATE,
    SherpaWhisper,
    Transcriber,
    audio_quality,
    clean_transcript,
    decode_wav,
    resample_to_16k,
    split_for_whisper,
)
from mommy.config import load_settings
from mommy.tts import (
    FakeTTS,
    Phonemizer,
    PiperTTS,
    QuranTextRefused,
    Synthesizer,
    TTSUnavailable,
    VoiceFiles,
    assemble_sentences,
    audio_says,
    encode_wav,
    find_espeak_library,
    is_quranic_script,
    punctuation_mark,
    read_symbols,
    roundtrip_ok,
    split_clauses,
    synthesize_verified,
)

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"
WHISPER_TEST_WAVS = MODELS_DIR / "sherpa-onnx-whisper-small" / "test_wavs"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def tone(freq: float, seconds: float, rate: int, amp: float = 0.5) -> np.ndarray:
    """A sine tone."""
    t = np.arange(int(round(seconds * rate))) / rate
    return amp * np.sin(2 * np.pi * freq * t)


def wav_bytes(
    samples: np.ndarray,
    rate: int,
    *,
    bits: int = 16,
    fmt_tag: int = 1,
    extensible: bool = False,
    extra_chunks: bytes = b"",
    data_size: int | None = None,
) -> bytes:
    """Build a WAV file by hand. ``samples`` is (frames,) or (frames, channels) in -1..1."""
    x = np.asarray(samples, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    channels = x.shape[1]
    inter = x.reshape(-1)
    if fmt_tag == 3:
        raw = inter.astype("<f4" if bits == 32 else "<f8").tobytes()
    elif bits == 8:
        raw = np.clip(np.round(inter * 128 + 128), 0, 255).astype(np.uint8).tobytes()
    elif bits == 16:
        raw = np.clip(np.round(inter * 32767), -32768, 32767).astype("<i2").tobytes()
    elif bits == 24:
        v = np.clip(np.round(inter * 8388607), -8388608, 8388607).astype(np.int32)
        b = v.astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3]
        raw = b.tobytes()
    elif bits == 32:
        raw = np.clip(np.round(inter * 2147483647), -2147483648, 2147483647).astype("<i4").tobytes()
    else:
        raise AssertionError(bits)
    block = channels * bits // 8
    if extensible:
        guid_tail = b"\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71"
        fmt = struct.pack("<HHIIHH", 0xFFFE, channels, rate, rate * block, block, bits)
        fmt += struct.pack("<HHI", 22, bits, 0) + struct.pack("<H", fmt_tag) + guid_tail
    else:
        fmt = struct.pack("<HHIIHH", fmt_tag, channels, rate, rate * block, block, bits)
    body = b"WAVE" + extra_chunks + b"fmt " + struct.pack("<I", len(fmt)) + fmt
    body += b"data" + struct.pack("<I", len(raw) if data_size is None else data_size) + raw
    return b"RIFF" + struct.pack("<I", len(body)) + body


def dominant_freq(x: np.ndarray, rate: int = SAMPLE_RATE) -> float:
    spectrum = np.abs(np.fft.rfft(x * np.hanning(x.size)))
    return float(np.argmax(spectrum) * rate / x.size)


def wav_info(data: bytes) -> tuple[int, int, int, float]:
    """(channels, sample width, rate, seconds) via the stdlib reader."""
    with wave.open(io.BytesIO(data)) as w:
        return w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes() / w.getframerate()


# ---------------------------------------------------------------------------
# decode_wav
# ---------------------------------------------------------------------------


class TestDecodeWav:
    def test_pcm16_mono_16k_is_exact(self) -> None:
        x = tone(440, 0.5, 16000)
        out = decode_wav(wav_bytes(x, 16000))
        assert out.dtype == np.float32 and out.ndim == 1 and out.flags["C_CONTIGUOUS"]
        assert out.size == x.size
        assert np.max(np.abs(out - x)) < 1e-4  # PCM16 quantisation only

    @pytest.mark.parametrize("rate", [8000, 16000, 22050, 44100, 48000])
    def test_any_rate_becomes_16k(self, rate: int) -> None:
        x = tone(1000, 1.5, rate, amp=0.5)
        out = decode_wav(wav_bytes(x, rate))
        assert out.size == round(x.size * 16000 / rate)
        assert abs(dominant_freq(out) - 1000) < 2
        mid = out[1600:-1600]  # away from the edges
        assert abs(np.sqrt(np.mean(mid**2)) - 0.5 / math.sqrt(2)) < 0.005
        ref = tone(1000, out.size / 16000, 16000)[1600:-1600]
        assert np.max(np.abs(mid - ref)) < 2e-3  # same phase: no time shift

    def test_downsampling_removes_aliases(self) -> None:
        # 10 kHz cannot exist at 16 kHz; linear interpolation would fold it to 6 kHz.
        out = decode_wav(wav_bytes(tone(10000, 1.0, 44100, amp=0.5), 44100))
        assert np.sqrt(np.mean(out[800:-800] ** 2)) < 1e-3

    def test_upsampling_8k_keeps_band_clean(self) -> None:
        out = decode_wav(wav_bytes(tone(3000, 1.0, 8000), 8000))
        spectrum = np.abs(np.fft.rfft(out[800:-800] * np.hanning(out.size - 1600)))
        freqs = np.fft.rfftfreq(out.size - 1600, 1 / 16000)
        assert spectrum[freqs > 4100].max() < 1e-3 * spectrum.max()  # no image at 5 kHz

    def test_stereo_is_averaged(self) -> None:
        left, right = tone(440, 0.5, 16000), 0.2 * np.ones(8000)
        out = decode_wav(wav_bytes(np.stack([left, right], axis=1), 16000))
        assert np.max(np.abs(out - (left + right) / 2)) < 1e-4
        opposite = decode_wav(wav_bytes(np.stack([left, -left], axis=1), 16000))
        assert np.max(np.abs(opposite)) < 1e-4

    def test_stereo_44k(self) -> None:
        x = tone(500, 1.0, 44100)
        out = decode_wav(wav_bytes(np.stack([x, x], axis=1), 44100))
        assert out.size == 16000 and abs(dominant_freq(out) - 500) < 2

    @pytest.mark.parametrize(
        ("bits", "fmt_tag", "tol"),
        [(8, 1, 1e-2), (16, 1, 1e-4), (24, 1, 1e-6), (32, 1, 1e-8), (32, 3, 1e-7), (64, 3, 1e-12)],
    )
    def test_sample_formats(self, bits: int, fmt_tag: int, tol: float) -> None:
        x = tone(300, 0.25, 16000, amp=0.8)
        out = decode_wav(wav_bytes(x, 16000, bits=bits, fmt_tag=fmt_tag))
        assert np.max(np.abs(out - x)) < max(tol, 1e-6)

    def test_extensible_header(self) -> None:
        x = tone(300, 0.25, 16000)
        for tag in (1, 3):
            bits = 16 if tag == 1 else 32
            out = decode_wav(wav_bytes(x, 16000, bits=bits, fmt_tag=tag, extensible=True))
            assert np.max(np.abs(out - x)) < 1e-4

    def test_float_out_of_range_and_nan(self) -> None:
        x = np.array([0.5, 2.0, -3.0, np.nan, np.inf, -0.25])
        out = decode_wav(wav_bytes(x, 16000, bits=32, fmt_tag=3))
        assert out.tolist() == pytest.approx([0.5, 1.0, -1.0, 0.0, 0.0, -0.25])

    def test_extra_and_odd_sized_chunks_are_skipped(self) -> None:
        odd = b"LIST" + struct.pack("<I", 3) + b"abc" + b"\x00"  # padded to even
        x = tone(440, 0.1, 16000)
        out = decode_wav(wav_bytes(x, 16000, extra_chunks=odd))
        assert out.size == x.size

    def test_tolerates_wrong_data_size(self) -> None:
        x = tone(440, 0.1, 16000)
        for size in (10**9, 0xFFFFFFFF):  # announces more than the file holds
            assert decode_wav(wav_bytes(x, 16000, data_size=size)).size == x.size

    def test_trailing_partial_frame_dropped(self) -> None:
        data = wav_bytes(tone(440, 0.1, 16000), 16000) + b"\x01"
        assert decode_wav(data).size == 1600

    def test_accepts_bytearray_and_memoryview(self) -> None:
        data = wav_bytes(tone(440, 0.1, 16000), 16000)
        assert decode_wav(bytearray(data)).size == decode_wav(memoryview(data)).size == 1600

    def test_matches_stdlib_wave_writer(self) -> None:
        x = tone(440, 0.2, 22050)
        out = decode_wav(encode_wav(x, 22050))
        assert out.size == round(x.size * 16000 / 22050)

    @pytest.mark.parametrize(
        "data",
        [
            b"",
            b"hello",
            b"RIFF\x00\x00\x00\x00WAVE",  # no chunks
            b"RIFF\x24\x00\x00\x00AVI LIST",  # not WAVE
            b"\x00" * 64,
            bytes(np.random.default_rng(1).integers(0, 256, 4096, dtype=np.uint8)),
            b"ID3\x03\x00" + b"\x00" * 100,  # an MP3
            b"OggS" + b"\x00" * 100,
        ],
    )
    def test_garbage_raises(self, data: bytes) -> None:
        with pytest.raises(ValueError):
            decode_wav(data)

    def test_header_problems_raise(self) -> None:
        x = tone(440, 0.1, 16000)
        no_data = wav_bytes(x, 16000)
        no_data = no_data[: no_data.index(b"data")]
        cases = {
            "no data chunk": no_data,
            "empty data": wav_bytes(np.zeros(0), 16000),
            "mu-law": wav_bytes(x, 16000, bits=8, fmt_tag=7),
            "12-bit": wav_bytes(x, 16000, bits=16)[:34] + struct.pack("<H", 12) + wav_bytes(x, 16000)[36:],
            "zero rate": wav_bytes(x, 16000)[:24] + struct.pack("<I", 0) + wav_bytes(x, 16000)[28:],
            "zero channels": wav_bytes(x, 16000)[:22] + struct.pack("<H", 0) + wav_bytes(x, 16000)[24:],
            "no fmt": b"RIFF" + struct.pack("<I", 12) + b"WAVEdata" + struct.pack("<I", 4) + b"\x00" * 4,
        }
        for name, data in cases.items():
            with pytest.raises(ValueError):
                decode_wav(data)
            assert name  # for a readable failure

    def test_not_bytes_raises(self) -> None:
        with pytest.raises(ValueError):
            decode_wav("RIFF....WAVE")  # type: ignore[arg-type]

    def test_resample_identity_and_empty(self) -> None:
        x = np.linspace(-1, 1, 100)
        assert np.array_equal(resample_to_16k(x, 16000), x)
        assert resample_to_16k(np.zeros(0), 44100).size == 0


class TestWavDuration:
    """``wav_duration`` reads the length from the header, without decoding."""

    @pytest.mark.parametrize(
        ("rate", "channels", "bits", "fmt_tag"),
        [(16000, 1, 16, 1), (44100, 2, 16, 1), (8000, 1, 8, 1), (48000, 2, 24, 1), (22050, 1, 32, 3)],
    )
    def test_matches_decoded_length(self, rate: int, channels: int, bits: int, fmt_tag: int) -> None:
        x = tone(440, 1.25, rate)
        if channels == 2:
            x = np.stack([x, x], axis=1)
        data = wav_bytes(x, rate, bits=bits, fmt_tag=fmt_tag)
        seconds = asr_mod.wav_duration(data)
        assert seconds == pytest.approx(1.25, abs=1 / rate)
        assert decode_wav(data).size == pytest.approx(seconds * SAMPLE_RATE, abs=1)

    def test_counts_only_what_a_truncated_file_holds(self) -> None:
        data = wav_bytes(tone(440, 0.5, 16000), 16000, data_size=10**9)
        assert asr_mod.wav_duration(data) == pytest.approx(0.5)
        assert asr_mod.wav_duration(data + b"\x01") == pytest.approx(0.5)  # partial frame

    def test_long_low_rate_file_is_measured_without_decoding(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # 3 hours at 1 kHz, 8-bit: what decode_wav would turn into 173 million samples.
        data = wav_bytes(np.zeros(1000), 1000, bits=8) + b"\x80" * (3 * 3600 * 1000 - 1000)
        data = data[:4] + struct.pack("<I", len(data) - 8) + data[8:40] + struct.pack("<I", 3 * 3600 * 1000) + data[44:]
        monkeypatch.setattr(asr_mod, "resample_to_16k", lambda *a: pytest.fail("decoded"))
        assert asr_mod.wav_duration(data) == pytest.approx(3 * 3600)

    @pytest.mark.parametrize("data", [b"", b"hello", b"RIFF\x00\x00\x00\x00WAVE", wav_bytes(np.zeros(0), 16000)])
    def test_garbage_raises(self, data: bytes) -> None:
        with pytest.raises(ValueError):
            asr_mod.wav_duration(data)

    def test_not_bytes_raises(self) -> None:
        with pytest.raises(ValueError):
            asr_mod.wav_duration("RIFF....WAVE")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# audio_quality
# ---------------------------------------------------------------------------


class TestAudioQuality:
    def test_keys_and_json_types(self) -> None:
        q = audio_quality(tone(200, 1.0, 16000, amp=0.1).astype(np.float32))
        assert set(q) == {"seconds", "rms", "too_quiet", "too_short"}
        assert type(q["seconds"]) is float and type(q["rms"]) is float
        assert type(q["too_quiet"]) is bool and type(q["too_short"]) is bool

    def test_empty(self) -> None:
        assert audio_quality(np.zeros(0, dtype=np.float32)) == {
            "seconds": 0.0, "rms": 0.0, "too_quiet": True, "too_short": True,
        }

    def test_normal_speech_level(self) -> None:
        q = audio_quality(tone(200, 2.0, 16000, amp=0.1))
        assert q["seconds"] == pytest.approx(2.0)
        assert q["rms"] == pytest.approx(0.1 / math.sqrt(2), rel=1e-3)
        assert not q["too_quiet"] and not q["too_short"]

    def test_too_short_threshold(self) -> None:
        assert audio_quality(tone(200, 0.49, 16000, amp=0.3))["too_short"]
        assert not audio_quality(tone(200, 0.5, 16000, amp=0.3))["too_short"]

    def test_silence_and_room_noise_are_too_quiet(self) -> None:
        assert audio_quality(np.zeros(32000))["too_quiet"]
        noise = np.random.default_rng(0).normal(0, 0.001, 32000)  # about -60 dBFS
        assert audio_quality(noise)["too_quiet"]

    def test_quiet_threshold(self) -> None:
        # Speech level = RMS of the loudest frames; a steady tone's level is its RMS.
        just_below = tone(200, 2.0, 16000, amp=0.0049 * math.sqrt(2))
        just_above = tone(200, 2.0, 16000, amp=0.0051 * math.sqrt(2))
        assert audio_quality(just_below)["too_quiet"]
        assert not audio_quality(just_above)["too_quiet"]

    def test_short_speech_in_long_pause_is_not_quiet(self) -> None:
        x = np.concatenate([tone(200, 1.0, 16000, amp=0.05), np.zeros(16000 * 59)])
        q = audio_quality(x)
        assert q["rms"] < 0.005  # the whole-clip RMS alone would call this too quiet
        assert not q["too_quiet"]

    def test_dc_offset_is_not_loudness(self) -> None:
        assert audio_quality(np.full(32000, 0.3))["too_quiet"]

    def test_tiny_clip(self) -> None:
        q = audio_quality(np.full(100, 0.5) * np.sign(np.sin(np.arange(100))))
        assert q["too_short"] and not q["too_quiet"]


# ---------------------------------------------------------------------------
# Splitting long clips, cleaning transcripts
# ---------------------------------------------------------------------------


class TestSplitForWhisper:
    def test_short_clip_is_one_piece(self) -> None:
        x = np.ones(16000 * 10, dtype=np.float32)
        (piece,) = split_for_whisper(x)
        assert piece.size == x.size

    def test_too_tiny_clip_is_dropped(self) -> None:
        assert split_for_whisper(np.ones(MIN_DECODE_SAMPLES - 1, dtype=np.float32)) == []
        assert len(split_for_whisper(np.ones(MIN_DECODE_SAMPLES, dtype=np.float32))) == 1

    def test_long_clip_is_cut_at_pauses(self) -> None:
        rng = np.random.default_rng(0)
        x = rng.normal(0, 0.1, 16000 * 70).astype(np.float32)
        for pause in (24.0, 50.0):  # one pause inside each search window
            s = int(pause * 16000)
            x[s : s + 4000] = 0.0
        pieces = split_for_whisper(x)
        assert len(pieces) == 3
        assert all(p.size <= 28 * 16000 for p in pieces)
        assert sum(p.size for p in pieces) == x.size
        assert np.array_equal(np.concatenate(pieces), x)
        cut1 = pieces[0].size / 16000
        cut2 = (pieces[0].size + pieces[1].size) / 16000
        assert 24.0 <= cut1 <= 24.25 and 50.0 <= cut2 <= 50.25

    def test_no_pause_still_respects_limit(self) -> None:
        x = np.random.default_rng(1).normal(0, 0.1, 16000 * 120).astype(np.float32)
        pieces = split_for_whisper(x)
        assert all(p.size <= 28 * 16000 for p in pieces) and len(pieces) >= 5
        assert sum(p.size for p in pieces) == x.size

    def test_bad_limit(self) -> None:
        with pytest.raises(ValueError):
            split_for_whisper(np.zeros(10, dtype=np.float32), max_seconds=0)


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("(upbeat music)", ""),
        ("[Music]", ""),
        (" Hello [BLANK_AUDIO] world ♪ ", "Hello world"),
        ("The cat (laughs) sat.", "The cat sat."),
        ("Le chat mange une pomme rouge.", "Le chat mange une pomme rouge."),
        ("ذهب الولد إلى المدرسة", "ذهب الولد إلى المدرسة"),
        ("", ""),
    ],
)
def test_clean_transcript(raw: str, clean: str) -> None:
    assert clean_transcript(raw) == clean


# ---------------------------------------------------------------------------
# SherpaWhisper with a fake sherpa-onnx
# ---------------------------------------------------------------------------


class _FakeStream:
    def __init__(self) -> None:
        self.samples: np.ndarray | None = None
        self.result = SimpleNamespace(text="")

    def accept_waveform(self, rate: int, samples: np.ndarray) -> None:
        assert rate == 16000
        self.samples = samples


class _FakeRecognizer:
    def __init__(self, kwargs: dict, log: list) -> None:
        self.kwargs = kwargs
        self.log = log

    def create_stream(self) -> _FakeStream:
        return _FakeStream()

    def decode_stream(self, stream: _FakeStream) -> None:
        assert stream.samples is not None and stream.samples.size >= MIN_DECODE_SAMPLES
        self.log.append(stream.samples.size)
        stream.result.text = f" piece{len(self.log)} [Music]"


@pytest.fixture
def fake_sherpa(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> SimpleNamespace:
    """Replace sherpa_onnx in mommy.asr with a recorder; create empty model files."""
    builds: list[dict] = []
    decodes: list[int] = []

    def from_whisper(**kwargs):  # keyword-only, like the real call
        time.sleep(0.05)  # widen the race window for the concurrency test
        builds.append(kwargs)
        return _FakeRecognizer(kwargs, decodes)

    monkeypatch.setattr(
        asr_mod, "sherpa_onnx", SimpleNamespace(OfflineRecognizer=SimpleNamespace(from_whisper=from_whisper))
    )
    model_dir = tmp_path / "sherpa-onnx-whisper-small"
    model_dir.mkdir()
    for name in ("small-encoder.int8.onnx", "small-decoder.int8.onnx", "small-tokens.txt"):
        (model_dir / name).write_bytes(b"")
    return SimpleNamespace(models_dir=tmp_path, builds=builds, decodes=decodes)


class TestSherpaWhisperWrapper:
    def test_missing_files_means_unavailable(self, tmp_path: Path) -> None:
        w = SherpaWhisper(tmp_path, "small")
        assert w.available is False
        assert "small-encoder.int8.onnx" in (w.unavailable_reason or "")
        assert isinstance(w, Transcriber)
        with pytest.raises(ASRUnavailable):
            w.transcribe(np.zeros(16000, dtype=np.float32), "en")
        with pytest.raises(ASRUnavailable):
            w.preload()

    def test_bad_arguments(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError):
            SherpaWhisper(tmp_path, "large")
        with pytest.raises(ValueError):
            SherpaWhisper(tmp_path, "small", num_threads=0)

    def test_signature_cannot_take_expected_text(self) -> None:
        params = list(inspect.signature(SherpaWhisper.transcribe).parameters)
        assert params == ["self", "pcm16k", "lang"]

    def test_never_given_prompt_or_hotwords(self, fake_sherpa: SimpleNamespace) -> None:
        w = SherpaWhisper(fake_sherpa.models_dir, "small", num_threads=3)
        assert w.available and not fake_sherpa.builds  # lazy: nothing built yet
        w.transcribe(np.ones(16000, dtype=np.float32) * 0.1, "fr")
        (kwargs,) = fake_sherpa.builds
        assert set(kwargs) == {"encoder", "decoder", "tokens", "language", "task", "num_threads", "decoding_method"}
        assert kwargs["language"] == "fr" and kwargs["task"] == "transcribe" and kwargs["num_threads"] == 3
        assert kwargs["encoder"].endswith("small-encoder.int8.onnx")
        assert kwargs["decoder"].endswith("small-decoder.int8.onnx")
        assert kwargs["tokens"].endswith("small-tokens.txt")
        assert not any(k in kwargs for k in ("prompt", "hotwords", "hotwords_file", "context", "initial_prompt"))

    def test_one_recognizer_per_language_cached(self, fake_sherpa: SimpleNamespace) -> None:
        w = SherpaWhisper(fake_sherpa.models_dir, "small")
        x = np.ones(16000, dtype=np.float32) * 0.1
        for lang in ("en", "en", "fr", "ar", "en", "fr"):
            w.transcribe(x, lang)
        assert [b["language"] for b in fake_sherpa.builds] == ["en", "fr", "ar"]

    def test_thread_safe_lazy_build(self, fake_sherpa: SimpleNamespace) -> None:
        w = SherpaWhisper(fake_sherpa.models_dir, "small")
        x = np.ones(16000, dtype=np.float32) * 0.1
        errors: list[BaseException] = []

        def work() -> None:
            try:
                w.transcribe(x, "en")
            except BaseException as exc:  # pragma: no cover - reported below
                errors.append(exc)

        threads = [threading.Thread(target=work) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert not errors
        assert len(fake_sherpa.builds) == 1 and len(fake_sherpa.decodes) == 8

    def test_long_audio_is_decoded_in_pieces(self, fake_sherpa: SimpleNamespace) -> None:
        w = SherpaWhisper(fake_sherpa.models_dir, "small")
        x = np.random.default_rng(0).normal(0, 0.1, 16000 * 65).astype(np.float32)
        text = w.transcribe(x, "en")
        assert len(fake_sherpa.decodes) == 3 and max(fake_sherpa.decodes) <= 28 * 16000
        assert text == "piece1 piece2 piece3"  # joined and cleaned

    def test_tiny_audio_is_not_decoded(self, fake_sherpa: SimpleNamespace) -> None:
        # Decoding 0 or 1 samples crashes the native library: never do it.
        w = SherpaWhisper(fake_sherpa.models_dir, "small")
        assert w.transcribe(np.zeros(1, dtype=np.float32), "en") == ""
        assert w.transcribe(np.zeros(0, dtype=np.float32), "en") == ""
        assert fake_sherpa.decodes == []

    def test_input_is_sanitised(self, fake_sherpa: SimpleNamespace) -> None:
        w = SherpaWhisper(fake_sherpa.models_dir, "small")
        x = np.full((2, 8000), np.nan)  # 2-D float64 with NaN
        w.transcribe(x, "en")
        assert fake_sherpa.decodes == [16000]

    def test_unknown_language(self, fake_sherpa: SimpleNamespace) -> None:
        w = SherpaWhisper(fake_sherpa.models_dir, "small")
        with pytest.raises(ValueError):
            w.transcribe(np.zeros(16000, dtype=np.float32), "de")  # type: ignore[arg-type]

    def test_from_settings(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        monkeypatch.setenv("MOMMY_ASR_MODEL", "turbo")
        monkeypatch.setenv("MOMMY_ASR_THREADS", "2")
        w = SherpaWhisper.from_settings(load_settings(tmp_path))
        assert w.model == "turbo" and w.num_threads == 2
        assert w.files.encoder == tmp_path / "models" / "sherpa-onnx-whisper-turbo" / "turbo-encoder.int8.onnx"
        assert w.available is False


def test_fake_transcriber() -> None:
    fake = FakeTranscriber("le chat")
    assert isinstance(fake, Transcriber)
    assert fake.transcribe(np.zeros(320, dtype=np.float32), "fr") == "le chat"
    assert fake.calls == [("fr", 320)]
    with pytest.raises(ValueError):
        fake.transcribe(np.zeros(1), "xx")  # type: ignore[arg-type]
    off = FakeTranscriber(available=False)
    with pytest.raises(ASRUnavailable):
        off.transcribe(np.zeros(1), "en")


# ---------------------------------------------------------------------------
# TTS units
# ---------------------------------------------------------------------------


def test_encode_wav_round_trip() -> None:
    x = tone(440, 0.3, 16000, amp=0.5)
    data = encode_wav(x, 16000)
    assert wav_info(data) == (1, 2, 16000, pytest.approx(0.3))
    assert np.max(np.abs(decode_wav(data) - x)) < 1e-4
    clipped = decode_wav(encode_wav(np.array([2.0, -2.0, np.nan]), 16000))
    assert clipped.tolist() == pytest.approx([32767 / 32768, -32767 / 32768, 0.0])
    with pytest.raises(ValueError):
        encode_wav(x, 0)


class TestClauses:
    def test_split_clauses(self) -> None:
        assert split_clauses("Hello, world. How are you?") == [
            ("Hello", ","), ("world", "."), ("How are you", "?"),
        ]
        assert split_clauses("No punctuation") == [("No punctuation", "")]
        assert split_clauses("Wait... what?!") == [("Wait", "..."), ("what", "?!")]
        assert split_clauses("") == []

    def test_numbers_are_not_split(self) -> None:
        assert split_clauses("It costs 3.5 euros, at 12:30.") == [("It costs 3.5 euros", ","), ("at 12:30", ".")]
        assert split_clauses("3,5 kg") == [("3,5 kg", "")]

    def test_arabic_punctuation(self) -> None:
        assert split_clauses("مرحبا، كيف حالك؟") == [("مرحبا", "،"), ("كيف حالك", "؟")]

    @pytest.mark.parametrize(
        ("run", "mark"),
        [("?!", "?"), ("؟", "?"), ("!", "!"), ("...", "."), ("…", "."), ("؛", ";"), (":", ":"), ("،", ","), ("", "")],
    )
    def test_punctuation_mark(self, run: str, mark: str) -> None:
        assert punctuation_mark(run) == mark

    def test_assemble_sentences_like_piper(self) -> None:
        up = lambda clause: clause.upper()  # noqa: E731
        assert assemble_sentences("Hello, world. How are you?", up) == ["HELLO, WORLD.", "HOW ARE YOU?"]
        assert assemble_sentences("one; two: three", up) == ["ONE; TWO: THREE"]
        assert assemble_sentences("...", up) == []
        assert assemble_sentences("a , , b", up) == ["A, B"]  # no doubled mark
        assert assemble_sentences("Hi ! ?", up) == ["HI!"]
        assert assemble_sentences("Hello , . World", up) == ["HELLO,", "WORLD"]
        assert assemble_sentences("مرحبا، كيف حالك؟", lambda c: c) == ["مرحبا, كيف حالك?"]


def test_voice_files_and_symbols(tmp_path: Path) -> None:
    vf = VoiceFiles.for_lang(MODELS_DIR, "en")
    assert vf.model.name == "en_US-lessac-medium.onnx" and vf.espeak_voice == "en-us"
    assert vf.data_dir.name == "espeak-ng-data"
    assert VoiceFiles.for_lang(MODELS_DIR, "ar").model.name == "ar_JO-kareem-medium.onnx"
    tokens = tmp_path / "tokens.txt"
    tokens.write_text("_ 0\n^ 1\n  3\nˈ 120\nə 59\n\n", encoding="utf-8")
    assert read_symbols(tokens) == frozenset({"_", "^", " ", "ˈ", "ə"})


def test_piper_unavailable_without_files(tmp_path: Path) -> None:
    t = PiperTTS(tmp_path, phonemizer=TablePhonemizer())
    assert t.available is False and t.languages == ()
    assert "en voice files missing" in (t.unavailable_reason or "")
    assert isinstance(t, Synthesizer)
    with pytest.raises(TTSUnavailable):
        t.synthesize("hello", "en")


def test_piper_unavailable_without_phonemizer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tts_mod, "find_phonemizer", lambda: None)
    t = PiperTTS(MODELS_DIR)
    assert t.available is False and t.languages == ()
    assert "espeak-ng" in (t.unavailable_reason or "")
    with pytest.raises(TTSUnavailable):
        t.synthesize("hello", "en")


def test_piper_partial_voices(tmp_path: Path) -> None:
    # Only the English voice is present (symlinked): English works, the rest does not.
    src = MODELS_DIR / tts_mod.VOICE_DIRS["en"]
    if not src.is_dir():
        pytest.skip("English Piper voice not downloaded")
    (tmp_path / src.name).symlink_to(src)
    t = PiperTTS(tmp_path, phonemizer=TablePhonemizer())
    assert t.available is False and t.languages == ("en",)
    with pytest.raises(TTSUnavailable):
        t.synthesize("bonjour", "fr")


def test_fake_tts() -> None:
    fake = FakeTTS()
    assert isinstance(fake, Synthesizer)
    normal, slow = fake.synthesize("Le chat dort.", "fr"), fake.synthesize("Le chat dort.", "fr", slow=True)
    assert wav_info(normal)[:3] == (1, 2, 16000)
    assert wav_info(slow)[3] > wav_info(normal)[3]
    assert fake.calls == [("Le chat dort.", "fr", False), ("Le chat dort.", "fr", True)]
    with pytest.raises(ValueError):
        fake.synthesize("   ", "fr")
    with pytest.raises(TTSUnavailable):
        FakeTTS(available=False).synthesize("x", "en")


class TestRoundtripWithFakes:
    def test_same_words_pass(self) -> None:
        asr = FakeTranscriber("the cat sat on the mat today")
        assert roundtrip_ok(FakeTTS(), asr, "The cat sat on the mat today.", "en")
        assert len(asr.calls) == 1 and asr.calls[0][0] == "en" and asr.calls[0][1] > 0

    def test_different_words_fail(self) -> None:
        assert not roundtrip_ok(FakeTTS(), FakeTranscriber("the cat sat on a mat"), "The cat sat on the mat", "en")
        assert not roundtrip_ok(FakeTTS(), FakeTranscriber(""), "Le chat", "fr")

    def test_unavailable_sides_fail(self) -> None:
        asr = FakeTranscriber("hello")
        assert not roundtrip_ok(FakeTTS(available=False), asr, "hello", "en")
        assert not roundtrip_ok(FakeTTS(), FakeTranscriber("hello", available=False), "hello", "en")
        assert asr.calls == []

    def test_slow_is_passed_through(self) -> None:
        tts = FakeTTS()
        roundtrip_ok(tts, FakeTranscriber("hi"), "hi", "en", slow=True)
        assert tts.calls == [("hi", "en", True)]

    def test_audio_says(self) -> None:
        wav = FakeTTS().synthesize("مرحبا", "ar")
        assert audio_says(wav, FakeTranscriber("مرحبا"), "مَرْحَبًا", "ar")


class SequenceTranscriber(FakeTranscriber):
    """Returns the given transcripts one after the other (the last one repeats)."""

    def __init__(self, *texts: str) -> None:
        super().__init__(texts[0])
        self.texts = list(texts)

    def transcribe(self, pcm16k: np.ndarray, lang: str) -> str:
        super().transcribe(pcm16k, lang)
        return self.texts.pop(0) if len(self.texts) > 1 else self.texts[0]


class TestSynthesizeVerified:
    def test_first_take_ok(self) -> None:
        tts, asr = FakeTTS(), FakeTranscriber("le chat dort")
        v = synthesize_verified(tts, asr, "Le chat dort.", "fr", slow=True)
        assert v.ok and v.attempts == 1 and v.heard == "le chat dort"
        assert wav_info(v.wav)[0] == 1 and tts.calls == [("Le chat dort.", "fr", True)]

    def test_retries_until_heard(self) -> None:
        tts, asr = FakeTTS(), SequenceTranscriber("le sable dort", "le chat mort", "le chat dort")
        v = synthesize_verified(tts, asr, "Le chat dort.", "fr", attempts=5)
        assert v.ok and v.attempts == 3 and len(tts.calls) == 3 and len(asr.calls) == 3

    def test_gives_up(self) -> None:
        tts, asr = FakeTTS(), FakeTranscriber("something else")
        v = synthesize_verified(tts, asr, "Le chat dort.", "fr", attempts=2)
        assert not v.ok and v.attempts == 2 and v.heard == "something else" and len(tts.calls) == 2

    def test_without_recogniser(self) -> None:
        tts = FakeTTS()
        v = synthesize_verified(tts, FakeTranscriber(available=False), "hello", "en")
        assert not v.ok and v.attempts == 1 and v.heard == "" and len(tts.calls) == 1

    def test_errors(self) -> None:
        with pytest.raises(ValueError):
            synthesize_verified(FakeTTS(), FakeTranscriber(), "hello", "en", attempts=0)
        with pytest.raises(TTSUnavailable):
            synthesize_verified(FakeTTS(available=False), FakeTranscriber(), "hello", "en")


# ---------------------------------------------------------------------------
# Integration: models
# ---------------------------------------------------------------------------


class TablePhonemizer:
    """Hand-written espeak-ng-style IPA for the test sentences (stands in for espeak-ng).

    Stress marks follow espeak-ng (French stresses the last syllable of each word, so
    ``chat`` is ``ʃˈa``). The Arabic entries are the in-sentence forms (hamzat al-wasl
    elided after a vowel), as espeak-ng would produce them for this sentence.
    """

    name = "test-table"

    TABLE: dict[str, dict[str, str]] = {
        "en-us": {
            "the": "ðə", "cat": "kˈæt", "sat": "sˈæt", "on": "ˌɑːn", "mat": "mˈæt", "today": "tədˈeɪ",
            "and": "ænd", "dog": "dˈɑːɡ", "slept": "slˈɛpt", "under": "ˈʌndɚ", "table": "tˈeɪbəl",
        },
        "fr": {"le": "lə", "chat": "ʃˈa", "mange": "mˈɑ̃ʒ", "une": "yn", "pomme": "pˈɔm", "rouge": "ʁˈuʒ"},
        "ar": {
            "ذَهَبَ": "ðˈahaba", "الْوَلَدُ": "lwˈaladu", "إِلَى": "ʔˈila", "الْمَدْرَسَةِ": "lmˈadrasati",
        },
    }

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Path]] = []

    def phonemize(self, text: str, voice: str, data_dir: Path) -> list[str]:
        self.calls.append((text, voice, data_dir))
        table = self.TABLE[voice]
        return assemble_sentences(text, lambda clause: " ".join(table[w.casefold()] for w in clause.split()))


EN_SAID = "The cat sat on the mat today."
FR_SAID = "Le chat mange une pomme rouge."
AR_SAID = "ذَهَبَ الْوَلَدُ إِلَى الْمَدْرَسَةِ"

#: Takes allowed when a test needs audio that verifiably says the phrase. Measured
#: single-take success with the default noise (10 takes each, normal and slow): English
#: 18/20, French 17/20, Arabic 20/20.
VERIFY_ATTEMPTS = 5


def _whisper(model: str) -> SherpaWhisper:
    w = SherpaWhisper(MODELS_DIR, model, num_threads=4)
    if not w.available:
        pytest.skip(f"Whisper {model} not downloaded: {w.unavailable_reason}")
    return w


def _piper(**kwargs) -> PiperTTS:
    t = PiperTTS(MODELS_DIR, phonemizer=TablePhonemizer(), **kwargs)
    if not t.available:
        pytest.skip(f"Piper voices not downloaded: {t.unavailable_reason}")
    return t


@pytest.fixture(scope="session")
def whisper_small() -> SherpaWhisper:
    return _whisper("small")


@pytest.fixture(scope="session")
def piper() -> PiperTTS:
    """The voices with their default (random) noise, as the app uses them."""
    return _piper()


@pytest.fixture(scope="session")
def piper_exact() -> PiperTTS:
    """The voices with noise 0: the same text always gives the same audio."""
    return _piper(noise_scale=0.0, noise_scale_w=0.0)


class RecordingTranscriber:
    """Wraps a transcriber and records exactly what it was given."""

    def __init__(self, inner: Transcriber) -> None:
        self.inner = inner
        self.available = inner.available
        self.calls: list[tuple] = []

    def transcribe(self, pcm16k: np.ndarray, lang: str) -> str:
        self.calls.append((type(pcm16k), pcm16k.dtype, lang))
        return self.inner.transcribe(pcm16k, lang)


def speak_and_check(piper: PiperTTS, asr: Transcriber, said: str, expected: str, lang: str, *, slow: bool = False):
    """One take of the whole pipeline: synthesise ``said``, decode, transcribe unprompted,
    check against ``expected``. Returns (heard text, CheckResult)."""
    wav = piper.synthesize(said, lang, slow=slow)
    pcm = decode_wav(wav)
    assert not audio_quality(pcm)["too_quiet"]
    heard = asr.transcribe(pcm, lang)  # audio and language only: no expected text
    return heard, check_recitation(expected, heard, lang)


def verified(piper: PiperTTS, asr: Transcriber, said: str, lang: str, *, slow: bool = False):
    """Audio that the recogniser verifiably hears as ``said`` (a few takes allowed)."""
    v = synthesize_verified(piper, asr, said, lang, slow=slow, attempts=VERIFY_ATTEMPTS)
    assert v.ok, f"not heard exactly in {v.attempts} takes; last heard {v.heard!r}"
    return v


class TestPiperVoices:
    @pytest.mark.parametrize(("lang", "text", "low", "high"), [
        ("en", EN_SAID, 1.0, 4.0), ("fr", FR_SAID, 1.0, 4.0), ("ar", AR_SAID, 1.2, 5.0),
    ])
    def test_wav_of_plausible_duration(self, piper: PiperTTS, lang: str, text: str, low: float, high: float) -> None:
        data = piper.synthesize(text, lang)
        channels, width, rate, seconds = wav_info(data)
        assert (channels, width, rate) == (1, 2, 22050)
        assert low < seconds < high, seconds
        pcm = decode_wav(data)
        q = audio_quality(pcm)
        assert not q["too_quiet"] and not q["too_short"] and 0.02 < q["rms"] < 0.5

    def test_phonemizer_gets_voice_and_data_dir(self, piper: PiperTTS) -> None:
        piper.synthesize("le chat", "fr")
        text, voice, data_dir = piper.phonemizer.calls[-1]
        assert (text, voice) == ("le chat", "fr")
        assert data_dir == MODELS_DIR / "vits-piper-fr_FR-siwis-medium" / "espeak-ng-data"

    def test_phoneme_codepoints_are_nfd_and_known(self, piper: PiperTTS) -> None:
        (points,) = piper.phoneme_codepoints("Le chat mange.", "fr")
        assert "".join(map(chr, points)) == "lə ʃˈa mˈɑ̃ʒ."
        assert 0x0303 in points  # the nasal tilde is a separate (combining) symbol

    def test_slow_is_longer(self, piper: PiperTTS) -> None:
        text = "The cat sat on the mat today, and the dog slept under the table."
        normal = np.mean([wav_info(piper.synthesize(text, "en"))[3] for _ in range(2)])
        slow = np.mean([wav_info(piper.synthesize(text, "en", slow=True))[3] for _ in range(2)])
        assert slow > 1.1 * normal, (normal, slow)

    def test_noise_zero_is_deterministic(self, piper_exact: PiperTTS) -> None:
        assert piper_exact.synthesize(EN_SAID, "en") == piper_exact.synthesize(EN_SAID, "en")

    def test_bad_input(self, piper: PiperTTS) -> None:
        with pytest.raises(ValueError):
            piper.synthesize("  ", "en")
        with pytest.raises(ValueError):
            piper.synthesize("...", "en")
        with pytest.raises(ValueError):
            piper.synthesize("hello", "de")  # type: ignore[arg-type]
        with pytest.raises(ValueError):
            PiperTTS(MODELS_DIR, phonemizer=TablePhonemizer(), noise_scale=-0.1)

    def test_refuses_quran_text(self, piper: PiperTTS, quran_dir: Path) -> None:
        # Hard rule 4: the verbatim Uthmani text (al-Fatiha 1:2) is never synthesised.
        line = next(
            l for l in (quran_dir / "quran-uthmani.txt").read_text(encoding="utf-8").splitlines()
            if l.startswith("1|2|")
        )
        ayah = line.split("|", 2)[2]
        assert is_quranic_script(ayah)
        with pytest.raises(QuranTextRefused):
            piper.synthesize(ayah, "ar")
        assert not is_quranic_script(AR_SAID)  # school Arabic with full tashkeel is fine
        assert not is_quranic_script("هٰذَا كِتَابٌ")  # a superscript alef alone is not Quranic

    def test_concurrent_synthesis(self, piper: PiperTTS) -> None:
        results: list[bytes] = []
        threads = [threading.Thread(target=lambda: results.append(piper.synthesize(EN_SAID, "en"))) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert len(results) == 4 and all(wav_info(r)[3] > 1.0 for r in results)


# Recorded human speech shipped with the Whisper models.


def _trans() -> dict[str, str]:
    path = WHISPER_TEST_WAVS / "trans.txt"
    if not path.is_file():
        pytest.skip("Whisper test clips not downloaded")
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            name, text = line.split(" ", 1)
            out[name] = text
    return out


@pytest.fixture(scope="module")
def clip_8k() -> tuple[np.ndarray, str]:
    """A real 8 kHz recording (decoded to 16 kHz) and its reference transcript."""
    return decode_wav((WHISPER_TEST_WAVS / "8k.wav").read_bytes()), _trans()["8k.wav"]


@pytest.fixture(scope="module")
def heard_8k(whisper_small: SherpaWhisper, clip_8k: tuple[np.ndarray, str]) -> str:
    return whisper_small.transcribe(clip_8k[0], "en")


class TestRealSpeech:
    def test_8k_recording_is_transcribed(self, clip_8k, heard_8k: str) -> None:
        pcm, expected = clip_8k
        assert pcm.size == pytest.approx(4.825 * 16000, abs=2)  # 8 kHz -> 16 kHz
        result = check_recitation(expected, heard_8k, "en")
        assert result.verdict == "correct", (heard_8k, result)

    def test_skipped_word_in_real_speech(self, clip_8k, heard_8k: str) -> None:
        # The speaker did not say "great": the deterministic checker must notice.
        expected = clip_8k[1].replace("WITH HOPE", "WITH GREAT HOPE")
        result = check_recitation(expected, heard_8k, "en")
        errors = [op for op in result.ops if op.kind != "match"]
        assert [(op.kind, op.expected) for op in errors] == [("del", "GREAT")]

    def test_substituted_word_in_real_speech(self, clip_8k, heard_8k: str) -> None:
        expected = clip_8k[1].replace("HOPE", "JOY")
        result = check_recitation(expected, heard_8k, "en")
        errors = [op for op in result.ops if op.kind != "match"]
        assert [(op.kind, op.expected, op.heard) for op in errors] == [("sub", "JOY", "hope")]

    def test_longer_than_30_seconds(self, whisper_small: SherpaWhisper) -> None:
        text = _trans()["1.wav"]
        pcm = decode_wav((WHISPER_TEST_WAVS / "1.wav").read_bytes())
        twice = np.concatenate([pcm, pcm])  # 33 s: past Whisper's 30 s window
        heard = whisper_small.transcribe(twice, "en")
        result = check_recitation(f"{text} {text}", heard, "en")
        # Nothing is lost at the cut (sherpa-onnx alone would drop everything after 30 s).
        # The only expected differences are British vs American spellings (dishonoured).
        assert result.word_accuracy > 0.95, (heard, result.n_errors)
        assert not any(op.kind == "del" for op in result.ops[-10:])

    def test_silence_gives_no_words(self, whisper_small: SherpaWhisper) -> None:
        # Whisper writes "(upbeat music)" here; the cleaner removes it.
        assert whisper_small.transcribe(np.zeros(32000, dtype=np.float32), "en") == ""


class TestRoundTrips:
    """Piper -> WAV -> decode_wav -> Whisper (unprompted) -> check_recitation."""

    @pytest.mark.parametrize(("lang", "text"), [("en", EN_SAID), ("fr", FR_SAID), ("ar", AR_SAID)])
    @pytest.mark.parametrize("slow", [False, True], ids=["normal", "slow"])
    def test_verified_round_trip(self, piper: PiperTTS, whisper_small: SherpaWhisper, lang: str, text: str, slow: bool) -> None:
        v = verified(piper, whisper_small, text, lang, slow=slow)
        assert check_recitation(text, v.heard, lang).verdict == "correct"
        assert audio_says(v.wav, whisper_small, text, lang)  # the returned bytes themselves

    def test_single_take_english(self, piper_exact: PiperTTS, whisper_small: SherpaWhisper) -> None:
        # Deterministic audio, one take, no retry.
        assert roundtrip_ok(piper_exact, whisper_small, EN_SAID, "en")
        assert roundtrip_ok(piper_exact, whisper_small, EN_SAID, "en", slow=True)

    def test_single_take_french_slow(self, piper_exact: PiperTTS, whisper_small: SherpaWhisper) -> None:
        # Dictation speed. (At normal speed and noise 0 Whisper small hears "chat" as
        # "sable" every time; that is what synthesize_verified is for.)
        assert roundtrip_ok(piper_exact, whisper_small, FR_SAID, "fr", slow=True)

    def test_single_take_arabic(self, piper_exact: PiperTTS, whisper_small: SherpaWhisper) -> None:
        heard, result = speak_and_check(piper_exact, whisper_small, AR_SAID, AR_SAID, "ar")
        assert result.verdict == "correct", heard


class TestErrorDetectionEndToEnd:
    """The recogniser hears what was said, never what was expected; code finds the error."""

    def test_skipped_word_is_a_deletion(self, piper: PiperTTS, whisper_small: SherpaWhisper) -> None:
        asr = RecordingTranscriber(whisper_small)
        v = verified(piper, asr, EN_SAID, "en")  # the audio says EN_SAID, checked unprompted
        result = check_recitation("The cat sat on the red mat today", v.heard, "en")
        errors = [op for op in result.ops if op.kind != "match"]
        assert [(op.kind, op.expected, op.exp_index) for op in errors] == [("del", "red", 5)], v.heard
        assert result.verdict == "mistakes" and result.first_error_exp_index == 5
        assert not result.say_again
        # The recogniser only ever received a float32 array and a language code.
        assert asr.calls and set(asr.calls) == {(np.ndarray, np.dtype(np.float32), "en")}

    def test_skipped_word_single_take(self, piper_exact: PiperTTS, whisper_small: SherpaWhisper) -> None:
        heard, result = speak_and_check(piper_exact, whisper_small, EN_SAID, "The cat sat on the red mat today", "en")
        errors = [op for op in result.ops if op.kind != "match"]
        assert [(op.kind, op.expected) for op in errors] == [("del", "red")], heard

    def test_wrong_word_is_a_substitution_fr(self, piper: PiperTTS, whisper_small: SherpaWhisper) -> None:
        v = verified(piper, whisper_small, FR_SAID, "fr")
        result = check_recitation("Le chat mange une pomme verte.", v.heard, "fr")
        errors = [op for op in result.ops if op.kind != "match"]
        assert [(op.kind, op.expected, op.heard) for op in errors] == [("sub", "verte", "rouge")], v.heard
        assert result.verdict == "mistakes" and result.first_error_exp_index == 5

    def test_wrong_word_single_take_fr_slow(self, piper_exact: PiperTTS, whisper_small: SherpaWhisper) -> None:
        heard, result = speak_and_check(
            piper_exact, whisper_small, FR_SAID, "Le chat mange une pomme verte.", "fr", slow=True
        )
        errors = [op for op in result.ops if op.kind != "match"]
        assert [(op.kind, op.expected, op.heard) for op in errors] == [("sub", "verte", "rouge")], heard

    def test_audio_says_rejects_other_text(self, piper: PiperTTS, whisper_small: SherpaWhisper) -> None:
        v = verified(piper, whisper_small, EN_SAID, "en")
        assert not audio_says(v.wav, whisper_small, "The cat sat on the red mat today.", "en")
        assert not audio_says(v.wav, whisper_small, "The dog sat on the mat today.", "en")


# ---------------------------------------------------------------------------
# Real-time factor
# ---------------------------------------------------------------------------


def _five_second_clip() -> np.ndarray:
    path = WHISPER_TEST_WAVS / "1.wav"
    if not path.is_file():
        pytest.skip("Whisper test clips not downloaded")
    return decode_wav(path.read_bytes())[: 5 * 16000]


@pytest.mark.parametrize("model", ["small", "turbo"])
def test_real_time_factor(model: str, whisper_small: SherpaWhisper, capsys: pytest.CaptureFixture) -> None:
    clip = _five_second_clip()
    started = time.perf_counter()
    w = whisper_small if model == "small" else _whisper(model)
    w.preload(("en",))
    load = time.perf_counter() - started
    times = []
    for _ in range(2):
        t0 = time.perf_counter()
        text = w.transcribe(clip, "en")
        times.append(time.perf_counter() - t0)
    rtf = min(times) / 5.0
    with capsys.disabled():
        print(f"\n[RTF] whisper-{model} int8, 4 threads, 5 s clip: decode {min(times):.2f} s "
              f"(RTF {rtf:.2f}), load {load:.1f} s, text {len(text.split())} words")
    assert len(text.split()) >= 8
    assert rtf < 1.0  # faster than real time on 4 CPU threads


# ---------------------------------------------------------------------------
# Real espeak-ng (only when a library is installed)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(find_espeak_library() is None, reason="no espeak-ng library installed")
def test_espeak_ng_phonemizer() -> None:
    lib = find_espeak_library()
    ph: Phonemizer = tts_mod.EspeakNgPhonemizer(lib)
    data = MODELS_DIR / "vits-piper-en_US-lessac-medium" / "espeak-ng-data"
    if not data.is_dir():
        pytest.skip("voice data not downloaded")
    out = ph.phonemize("Hello, world. How are you?", "en-us", data)
    assert len(out) == 2 and out[0].endswith(".") and out[1].endswith("?")
    assert "h" in out[0] and "w" in out[0] and "," in out[0]


def test_requirements_install_a_phonemizer() -> None:
    """A fresh ``pip install -r requirements.txt`` must be able to speak.

    sherpa-onnx 2.x has no built-in phonemizer, so without one of these back ends TTS is
    unavailable and dictation cannot be read aloud (found in the integration run: the
    package was only listed as a comment).
    """
    requirements = (MODELS_DIR.parent / "requirements.txt").read_text(encoding="utf-8")
    installed = {
        line.split("==")[0].split("[")[0].strip().lower().replace("_", "-")
        for line in requirements.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    assert installed & {"espeakng-loader", "piper-phonemize"}

"""Tests for the HTTP API (``mommy.app``) with fake speech, fake brains and the real Quran.

Every endpoint is exercised on its success and error paths. The hard rules get their own
tests:

* the recogniser is only ever called with ``(pcm, lang)``: a spy checks every call's
  arguments, and also looks for the expected text in every place a component could read
  it without being handed it (module globals of ``mommy.*``, context variables, the
  environment), across several requests (hard rule 1);
* ``brain.read_handwriting`` gets the image and the language only (hard rule 3);
* the Quran endpoints never call the brain or the synthesizer, and the general endpoints
  refuse Quran text (hard rule 4);
* uploads never roll over to a temporary file on disk, request bodies are bounded, and
  logs never carry what a child said or wrote (hard rule 5).

No Quran words are typed here: Quran text is taken from the Tanzil files through the
:class:`~mommy.quran.Quran` object.
"""

from __future__ import annotations

import contextvars
import dataclasses
import inspect
import io
import json
import logging
import os
import struct
import sys
import tempfile
import threading
import wave
from pathlib import Path
from typing import Any, Callable, Iterator, Sequence

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin
from starlette.formparsers import MultiPartParser

from mommy import app as app_mod
from mommy import feedback
from mommy.align import CheckResult, Op, check_recitation, check_writing
from mommy.app import (
    BODY_LIMITS,
    MAX_AUDIO_BYTES,
    MAX_BODY_BYTES,
    MAX_IMAGE_BYTES,
    MAX_JSON_BYTES,
    MAX_TEXT_CHARS,
    MAX_TTS_CHARS,
    body_limit,
    build_default_app,
    clean_image,
    create_app,
    keep_uploads_in_memory,
    looks_like_quran,
)
from mommy.asr import ASRUnavailable, FakeTranscriber, SherpaWhisper, Transcriber
from mommy.config import Settings
from mommy.llm import Brain, ClaudeBrain, OfflineBrain
from mommy.phrases import split_phrases
from mommy.quran import Quran
from mommy.tts import FakeTTS, QuranTextRefused, TTSUnavailable

ROOT = Path(__file__).resolve().parent.parent

EN_TEXT = "The cat sat on the mat."
FR_TEXT = "Le chat dort sur le tapis."
AR_TEXT = "ذهب الولد إلى المدرسة صباحا مع أخيه الصغير"  # an ordinary sentence, not Quran

OP_KEYS = {f.name for f in dataclasses.fields(Op)}
RESULT_KEYS = {f.name for f in dataclasses.fields(CheckResult)}
QUALITY_KEYS = {"seconds", "rms", "too_quiet", "too_short"}


# ---------------------------------------------------------------------------
# Helpers and fakes
# ---------------------------------------------------------------------------


def wav(seconds: float = 1.0, *, rate: int = 16_000, channels: int = 1, amp: float = 0.3) -> bytes:
    """A PCM16 WAV of a 220 Hz tone (loud enough to pass the quality gate)."""
    n = int(round(seconds * rate))
    x = amp * np.sin(2 * np.pi * 220.0 * np.arange(n) / rate)
    pcm = np.round(x * 32767).astype("<i2")
    if channels > 1:
        pcm = np.repeat(pcm[:, None], channels, axis=1)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def silent_wav(seconds: float = 1.0) -> bytes:
    return wav(seconds, amp=0.0)


def jpeg(size: tuple[int, int] = (40, 20), *, exif: dict[int, Any] | None = None) -> bytes:
    img = Image.new("RGB", size, (200, 30, 30))
    out = io.BytesIO()
    if exif:
        tags = Image.Exif()
        for tag, value in exif.items():
            tags[tag] = value
        img.save(out, "JPEG", exif=tags.tobytes())
    else:
        img.save(out, "JPEG")
    return out.getvalue()


def png(*, text: str | None = None) -> bytes:
    img = Image.new("RGB", (30, 10), (10, 120, 30))
    out = io.BytesIO()
    info = None
    if text is not None:
        info = PngImagePlugin.PngInfo()
        info.add_text("Comment", text)
    img.save(out, "PNG", pnginfo=info)
    return out.getvalue()


def make_settings(**overrides: Any) -> Settings:
    base = dict(
        root=ROOT,
        models_dir=ROOT / "models",
        quran_dir=ROOT / "data" / "quran",
        web_dir=ROOT / "web",
        asr_model="small",
        asr_threads=1,
        anthropic_api_key_set=False,
        vision_model=None,
        text_model=None,
        effort="low",
    )
    base.update(overrides)
    return Settings(**base)


class FakeBrain:
    """A brain that answers like ClaudeBrain (fixed answers); every call is recorded with its arguments."""

    name = "claude"

    def __init__(
        self,
        *,
        page: dict | None = None,
        handwriting: dict | None = None,
        judgement: dict | None = None,
        feedback_text: str = "Lovely effort, keep going!",
    ) -> None:
        self.page = page if page is not None else {
            "text": FR_TEXT, "lang": "fr", "notes": "", "contains_quran": False, "needs_manual": False,
        }
        self.handwriting = handwriting if handwriting is not None else {
            "text": "Le chat dor sur le tapis.", "uncertain_words": ["dor"], "legible": True, "needs_manual": False,
        }
        self.judgement = judgement if judgement is not None else {
            "verdict": "partly", "missing_ideas": ["mat"], "wrong_ideas": [], "feedback": "Good! Where did the cat sit?",
        }
        self.feedback_text = feedback_text
        self.calls: list[tuple[str, tuple, dict]] = []

    def _record(self, method: str, args: tuple, kwargs: dict) -> None:
        self.calls.append((method, args, kwargs))

    def called(self, method: str) -> list[tuple[tuple, dict]]:
        return [(a, k) for m, a, k in self.calls if m == method]

    def read_page(self, *args: Any, **kwargs: Any) -> dict:
        self._record("read_page", args, kwargs)
        return dict(self.page)

    def read_handwriting(self, *args: Any, **kwargs: Any) -> dict:
        self._record("read_handwriting", args, kwargs)
        return dict(self.handwriting)

    def judge_meaning(self, *args: Any, **kwargs: Any) -> dict:
        self._record("judge_meaning", args, kwargs)
        return dict(self.judgement)

    def word_feedback(self, *args: Any, **kwargs: Any) -> str:
        self._record("word_feedback", args, kwargs)
        return self.feedback_text


class RaisingBrain(FakeBrain):
    """Every method fails (like a broken SDK or an outage)."""

    def _record(self, method: str, args: tuple, kwargs: dict) -> None:
        super()._record(method, args, kwargs)
        raise RuntimeError("brain is down")


class ExplodingBrain(FakeBrain):
    """For paths that must never reach a brain at all."""

    def _record(self, method: str, args: tuple, kwargs: dict) -> None:
        super()._record(method, args, kwargs)
        raise AssertionError(f"brain.{method} must not be called here")


class ExplodingTTS:
    """For paths that must never reach the synthesizer."""

    available = True

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def synthesize(self, *args: Any, **kwargs: Any) -> bytes:
        self.calls.append((args, kwargs))
        raise AssertionError("the synthesizer must not be called here")


class RecordingTranscriber:
    """Returns a preset text and records exactly what it was called with."""

    available = True

    def __init__(self, heard: str = "", *, error: BaseException | None = None) -> None:
        self.heard = heard
        self.error = error
        self.calls: list[tuple[tuple, dict]] = []

    def transcribe(self, *args: Any, **kwargs: Any) -> str:
        self.calls.append((args, kwargs))
        if self.error is not None:
            raise self.error
        return self.heard


def _strings_in(value: Any, depth: int = 0) -> Iterator[str]:
    """The strings inside a value (shallow containers, bytes decoded leniently)."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, (bytes, bytearray, memoryview)):
        yield bytes(value).decode("utf-8", "ignore")
    elif depth < 3 and isinstance(value, dict):
        for k, v in list(value.items()):
            yield from _strings_in(k, depth + 1)
            yield from _strings_in(v, depth + 1)
    elif depth < 3 and isinstance(value, (list, tuple, set, frozenset)):
        for v in list(value):
            yield from _strings_in(v, depth + 1)


def shared_state() -> Iterator[tuple[str, Any]]:
    """Places a component could read text from without being handed it."""
    for name, module in list(sys.modules.items()):
        if name == "mommy" or name.startswith("mommy."):
            for key, value in list(vars(module).items()):
                if not key.startswith("__"):  # docstrings and file names are source, not state
                    yield f"{name}.{key}", value
    for var, value in contextvars.copy_context().items():
        yield f"contextvar {var.name}", value
    yield "os.environ", dict(os.environ)


def find_leaks(secrets: Sequence[str], *values: Any) -> list[str]:
    """Where any of ``secrets`` can be seen: in ``values`` or in :func:`shared_state`."""
    found = []
    for label, value in [*((f"argument {i}", v) for i, v in enumerate(values)), *shared_state()]:
        for s in _strings_in(value):
            for secret in secrets:
                if secret and secret in s:
                    found.append(f"{label} holds {secret!r}")
    return found


class SpyTranscriber:
    """Checks, during every call, that the expected text is nowhere it could see."""

    available = True

    def __init__(self, heard: str) -> None:
        self.heard = heard
        self.secrets: list[str] = []
        self.calls: list[tuple[tuple, dict]] = []
        self.leaks: list[str] = []

    def transcribe(self, *args: Any, **kwargs: Any) -> str:
        self.calls.append((args, kwargs))
        self.leaks.extend(find_leaks(self.secrets, args, kwargs))
        return self.heard


_REAL = object()


@pytest.fixture(scope="session")
def quran(quran_dir: Path) -> Quran:
    return Quran(quran_dir)


@pytest.fixture
def make_client(quran: Quran) -> Callable[..., TestClient]:
    def make(
        *,
        transcriber: Any = None,
        tts: Any = None,
        brain: Any = None,
        quran_obj: Any = _REAL,
        settings: Settings | None = None,
    ) -> TestClient:
        app = create_app(
            settings or make_settings(),
            transcriber if transcriber is not None else FakeTranscriber("hello"),
            tts if tts is not None else FakeTTS(),
            brain if brain is not None else FakeBrain(),
            quran if quran_obj is _REAL else quran_obj,
        )
        return TestClient(app)

    return make


def recite(
    client: TestClient,
    *,
    audio: bytes | None = None,
    expected_text: str | None = EN_TEXT,
    lang: str | None = "en",
    mode: str | None = "strict",
    age: str | None = "6-9",
) -> Any:
    data = {k: v for k, v in dict(expected_text=expected_text, lang=lang, mode=mode, age=age).items() if v is not None}
    files = {"audio": ("child.wav", audio if audio is not None else wav(), "audio/wav")} if audio != b"-" else None
    return client.post("/api/recite/check", data=data, files=files)


def quran_words(quran: Quran, surah: int, start: int, end: int) -> list[str]:
    """The Simple-Clean (match) words of a range, as a recogniser would write them."""
    return [w for a in quran.ayat(surah, start, end) for w in a.match_words]


def assert_error(response: Any, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error", "message"}
    assert body["error"] == code
    assert isinstance(body["message"], str) and body["message"]
    assert response.headers["cache-control"] == "no-store"
    return body


# ---------------------------------------------------------------------------
# Health, headers, static files
# ---------------------------------------------------------------------------


class TestHealth:
    def test_all_available(self, make_client: Callable[..., TestClient]) -> None:
        r = make_client().get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert {k: body[k] for k in ("asr", "tts", "brain", "quran", "languages")} == {
            "asr": True, "tts": True, "brain": "claude", "quran": True, "languages": ["ar", "en", "fr"],
        }
        assert body["tts_languages"] == ["ar", "en", "fr"]

    def test_offline_and_missing_components(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client(
            transcriber=FakeTranscriber(available=False), tts=FakeTTS(available=False), brain=OfflineBrain(),
            quran_obj=None,
        )
        body = client.get("/api/health").json()
        assert {k: body[k] for k in ("asr", "tts", "brain", "quran")} == {
            "asr": False, "tts": False, "brain": "offline", "quran": False,
        }
        assert body["tts_languages"] == []

    def test_partial_voices_and_reasons(self, make_client: Callable[..., TestClient]) -> None:
        class PartialTTS(FakeTTS):
            languages = ("en", "fr")
            unavailable_reason = "ar voice files missing"

        tts = PartialTTS(available=False)
        body = make_client(tts=tts).get("/api/health").json()
        assert body["tts"] is False and body["tts_languages"] == ["en", "fr"]
        assert body["reasons"]["tts"] == "ar voice files missing"


class TestHeadersAndStatic:
    def test_every_api_response_is_no_store(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        responses = [
            client.get("/api/health"),
            client.get("/api/quran/surahs"),
            client.get("/api/quran/ayat", params={"surah": 0, "from": 1, "to": 1}),  # 422
            client.get("/api/nope"),  # 404
            client.get("/api/tts"),  # 405
            client.post("/api/tts", json={"text": "", "lang": "en"}),  # 400
            client.post("/api/tts", json={"text": "Hi", "lang": "en"}),  # audio
            client.post("/api/tts", content=b"x" * (MAX_JSON_BYTES + 1)),  # 413 by the guard
            recite(client, audio=b"not a wav"),  # 400
        ]
        for r in responses:
            assert r.headers["cache-control"] == "no-store", (r.request.url, r.status_code)
            assert r.headers["x-content-type-options"] == "nosniff"
            assert r.headers["referrer-policy"] == "no-referrer"

    def test_index_served_at_root(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        r = client.get("/")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/html")
        assert r.content == (ROOT / "web" / "index.html").read_bytes()
        assert "no-store" not in r.headers.get("cache-control", "")
        assert r.headers["x-content-type-options"] == "nosniff"
        for name in ("app.js", "recorder.js", "styles.css"):
            assert client.get("/" + name).content == (ROOT / "web" / name).read_bytes()

    def test_unknown_api_path_and_wrong_method(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        assert_error(client.get("/api/nope"), 404, "not_found")
        assert_error(client.post("/api/health"), 405, "method_not_allowed")
        r = client.get("/api/tts")
        assert_error(r, 405, "method_not_allowed")
        assert "POST" in r.headers["allow"]

    def test_json_is_utf8_without_escapes(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        r = make_client().get("/api/quran/surahs")
        assert r.headers["content-type"] == "application/json; charset=utf-8"
        name = quran.surahs()[0]["name_ar"]
        assert name.encode("utf-8") in r.content

    def test_no_cdn_docs_pages(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        for path in ("/docs", "/redoc"):
            assert client.get(path).status_code == 404
        spec = client.get("/api/openapi.json")
        assert spec.status_code == 200 and "/api/recite/check" in spec.json()["paths"]

    def test_runs_without_web_dir(self, make_client: Callable[..., TestClient], tmp_path: Path) -> None:
        client = make_client(settings=make_settings(web_dir=tmp_path / "missing"))
        assert client.get("/").status_code == 404
        assert client.get("/api/health").status_code == 200

    def test_heavy_endpoints_run_in_the_thread_pool(self, make_client: Callable[..., TestClient]) -> None:
        heavy = {
            "/api/recite/check", "/api/quran/check", "/api/quran/locate", "/api/tts",
            "/api/page/read", "/api/dictation/check",
        }
        routes = {r.path: r for r in make_client().app.routes if getattr(r, "path", None) in heavy}
        assert set(routes) == heavy
        for path, route in routes.items():
            assert not inspect.iscoroutinefunction(route.endpoint), path

    def test_slow_recognition_does_not_block_the_event_loop(self, quran: Quran) -> None:
        started, release = threading.Event(), threading.Event()

        class BlockingTranscriber:
            available = True

            def transcribe(self, pcm16k: np.ndarray, lang: str) -> str:
                started.set()
                release.wait(10)
                return "the cat sat on the mat"

        app = create_app(make_settings(), BlockingTranscriber(), FakeTTS(), FakeBrain(), quran)
        watchdog = threading.Timer(8, release.set)  # unblocks the test if the loop is stuck
        watchdog.start()
        try:
            with TestClient(app) as client:
                results: dict[str, Any] = {}
                worker = threading.Thread(target=lambda: results.setdefault("r", recite(client)))
                worker.start()
                assert started.wait(10)
                health = client.get("/api/health")
                answered_while_busy = not release.is_set()
                release.set()
                worker.join(10)
        finally:
            watchdog.cancel()
        assert health.status_code == 200 and answered_while_busy
        assert results["r"].status_code == 200


# ---------------------------------------------------------------------------
# Body limits and in-memory uploads
# ---------------------------------------------------------------------------


class TestLimitsAndMemory:
    def test_body_limits(self) -> None:
        assert body_limit("/api/recite/check") == MAX_AUDIO_BYTES + app_mod.FORM_OVERHEAD_BYTES
        assert body_limit("/api/recite/check/") == body_limit("/api/recite/check")
        assert body_limit("/api/dictation/check") == MAX_IMAGE_BYTES + app_mod.FORM_OVERHEAD_BYTES
        assert body_limit("/api/tts") == MAX_JSON_BYTES
        assert MAX_BODY_BYTES == max(BODY_LIMITS.values())

    def test_declared_body_over_limit_is_refused_unread(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("x")
        client = make_client(transcriber=transcriber)
        big = b"\x00" * (body_limit("/api/recite/check") + 1)
        r = recite(client, audio=big)
        assert_error(r, 413, "too_large")
        assert transcriber.calls == []

    def test_streamed_body_over_limit_is_refused(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("x")
        client = make_client(transcriber=transcriber)
        head = (
            b'--b0\r\nContent-Disposition: form-data; name="audio"; filename="a.wav"\r\n'
            b"Content-Type: audio/wav\r\n\r\n"
        )
        chunk = b"\x00" * 65536
        n_chunks = body_limit("/api/recite/check") // len(chunk) + 4

        def body() -> Iterator[bytes]:
            yield head
            for _ in range(n_chunks):
                yield chunk

        r = client.post(
            "/api/recite/check", content=body(), headers={"content-type": "multipart/form-data; boundary=b0"}
        )
        assert "content-length" not in {k.lower() for k in r.request.headers}
        assert_error(r, 413, "too_large")
        assert transcriber.calls == []

    def test_streamed_json_over_limit_is_refused(self, make_client: Callable[..., TestClient]) -> None:
        tts = FakeTTS()

        def body() -> Iterator[bytes]:
            for _ in range(MAX_JSON_BYTES // 1000 + 2):
                yield b" " * 1000

        r = make_client(tts=tts).post("/api/tts", content=body(), headers={"content-type": "application/json"})
        assert_error(r, 413, "too_large")
        assert tts.calls == []

    @pytest.fixture
    def no_disk(self, monkeypatch: pytest.MonkeyPatch) -> list[str]:
        """Record (and block) every way a temporary file could reach the disk."""
        attempts: list[str] = []

        def blocked(name: str) -> Callable[..., Any]:
            def refuse(*args: Any, **kwargs: Any) -> Any:
                attempts.append(name)
                raise AssertionError(f"{name} called: an upload would be written to disk")

            return refuse

        monkeypatch.setattr(tempfile.SpooledTemporaryFile, "rollover", blocked("rollover"))
        for name in ("TemporaryFile", "NamedTemporaryFile", "mkstemp", "mkdtemp"):
            monkeypatch.setattr(tempfile, name, blocked(name))
        return attempts

    def test_large_uploads_stay_in_memory(self, make_client: Callable[..., TestClient], no_disk: list[str]) -> None:
        transcriber = RecordingTranscriber("the cat sat on the mat")
        brain = FakeBrain()
        client = make_client(transcriber=transcriber, brain=brain)
        audio = wav(55.0, rate=44_100, channels=2)  # 9.7 MB, under 120 s
        assert 9 * 1024 * 1024 < len(audio) <= MAX_AUDIO_BYTES
        r = recite(client, audio=audio)
        assert r.status_code == 200, r.text
        (args, _), = transcriber.calls
        assert args[0].size == pytest.approx(55.0 * 16_000, abs=2)

        image = jpeg() + b"\x00" * (MAX_IMAGE_BYTES - 50_000)  # 7.95 MB
        r = client.post("/api/page/read", files={"image": ("p.jpg", image, "image/jpeg")})
        assert r.status_code == 200, r.text
        (sent, _), _ = brain.called("read_page")[0]
        assert len(sent) == len(image)
        assert no_disk == []

    def test_default_spool_size_would_have_used_the_disk(
        self, make_client: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The control for the test above: with Starlette's default threshold (1 MB) the
        # same upload does roll over, so the absence of rollovers there is meaningful.
        rollovers: list[int] = []
        client = make_client(transcriber=RecordingTranscriber("x"))
        monkeypatch.setattr(MultiPartParser, "spool_max_size", 1024 * 1024)
        monkeypatch.setattr(tempfile.SpooledTemporaryFile, "rollover", lambda self: rollovers.append(1))
        recite(client, audio=wav(55.0, rate=44_100, channels=2))
        assert rollovers

    def test_keep_uploads_in_memory(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(MultiPartParser, "spool_max_size", 1024)
        keep_uploads_in_memory(5000)
        assert MultiPartParser.spool_max_size == 5000
        keep_uploads_in_memory(10)  # never lowered
        assert MultiPartParser.spool_max_size == 5000

    def test_refuses_to_start_when_the_spool_setting_is_gone(
        self, monkeypatch: pytest.MonkeyPatch, quran: Quran
    ) -> None:
        monkeypatch.delattr(MultiPartParser, "spool_max_size")
        with pytest.raises(RuntimeError, match="spool_max_size"):
            create_app(make_settings(), FakeTranscriber(), FakeTTS(), FakeBrain(), quran)


# ---------------------------------------------------------------------------
# /api/page/read
# ---------------------------------------------------------------------------


class TestPageRead:
    def post(self, client: TestClient, image: bytes | None, lang: str | None = "fr") -> Any:
        files = {"image": ("page.jpg", image, "image/jpeg")} if image is not None else None
        data = {"lang": lang} if lang is not None else {}
        return client.post("/api/page/read", files=files, data=data)

    def test_claude_reads_the_page(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        image = jpeg()
        r = self.post(make_client(brain=brain), image)
        assert r.status_code == 200
        assert r.json() == {
            "text": FR_TEXT, "lang": "fr", "notes": "", "source": "claude", "needs_manual": False,
            "contains_quran": False,
        }
        assert brain.called("read_page") == [((image, "fr"), {})]

    def test_no_language_hint(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        assert self.post(make_client(brain=brain), jpeg(), lang=None).status_code == 200
        assert brain.called("read_page")[0][0][1] is None

    def test_offline_needs_manual(self, make_client: Callable[..., TestClient]) -> None:
        r = self.post(make_client(brain=OfflineBrain()), jpeg(), lang="ar")
        assert r.status_code == 200
        body = r.json()
        assert body["text"] == "" and body["needs_manual"] is True and body["source"] == "offline"
        assert body["lang"] == "ar"

    def test_brain_failure_falls_back(self, make_client: Callable[..., TestClient]) -> None:
        body = self.post(make_client(brain=RaisingBrain()), jpeg()).json()
        assert body["needs_manual"] is True and body["source"] == "offline"
        assert body["brain_error"] == "RuntimeError"

    def test_claude_fallback_result_is_reported_offline(self, make_client: Callable[..., TestClient]) -> None:
        # ClaudeBrain returns the offline result plus "error" when the API fails.
        brain = FakeBrain(page={"text": "", "lang": None, "notes": "", "needs_manual": True, "error": "RateLimitError"})
        body = self.post(make_client(brain=brain), jpeg()).json()
        assert body["source"] == "offline" and body["needs_manual"] is True
        assert body["brain_error"] == "RateLimitError" and body["lang"] == "fr"

    def test_errors(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        client = make_client(brain=brain)
        assert_error(self.post(client, None), 422, "missing_field")
        assert_error(self.post(client, b""), 400, "bad_image")
        assert_error(self.post(client, b"GIF89a....."), 400, "bad_image")
        assert_error(self.post(client, jpeg(), lang="de"), 422, "invalid_field")
        assert_error(self.post(client, jpeg() + b"\x00" * MAX_IMAGE_BYTES), 413, "image_too_large")
        assert brain.calls == []

    def test_exif_is_removed_and_the_photo_turned_upright(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        image = jpeg((40, 20), exif={0x010F: "PhoneMaker", 0x0112: 6})  # Make, Orientation: 90 degrees
        assert b"Exif\x00\x00" in image and b"PhoneMaker" in image
        assert self.post(make_client(brain=brain), image).status_code == 200
        (sent, _), _ = brain.called("read_page")[0]
        assert b"Exif" not in sent and b"PhoneMaker" not in sent
        with Image.open(io.BytesIO(sent)) as img:
            assert img.format == "JPEG" and img.size == (20, 40)
            assert not img.getexif()

    def test_png_text_chunks_are_removed(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        client = make_client(brain=brain)
        self.post(client, png(text="home address"))
        (sent, _), _ = brain.called("read_page")[0]
        assert sent.startswith(b"\x89PNG") and b"home address" not in sent and b"tEXt" not in sent

    def test_clean_images_pass_byte_for_byte(self) -> None:
        for image in (jpeg(), png()):
            assert clean_image(image) == image

    def test_broken_image_with_metadata_is_refused(self, make_client: Callable[..., TestClient]) -> None:
        broken = b"\xff\xd8\xff\xe1\x00\x10Exif\x00\x00" + b"\x00" * 64
        assert_error(self.post(make_client(), broken), 400, "bad_image")


# ---------------------------------------------------------------------------
# /api/recite/check (strict)
# ---------------------------------------------------------------------------


class TestReciteStrict:
    def test_mistakes(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("the cat sat on mat")
        brain = FakeBrain()
        r = recite(make_client(transcriber=transcriber, brain=brain))
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {"mode", "heard_text", "result", "feedback", "quality", "say_again"}
        assert body["mode"] == "strict" and body["heard_text"] == "the cat sat on mat"
        assert body["result"] == json.loads(json.dumps(dataclasses.asdict(check_recitation(EN_TEXT, "the cat sat on mat", "en"))))
        assert set(body["result"]) == RESULT_KEYS and all(set(op) == OP_KEYS for op in body["result"]["ops"])
        assert body["result"]["verdict"] == "mistakes" and body["result"]["first_error_exp_index"] == 4
        assert body["say_again"] is False and set(body["quality"]) == QUALITY_KEYS
        assert body["feedback"] == "Lovely effort, keep going!"
        (summary, lang, age), kwargs = brain.called("word_feedback")[0]
        assert kwargs == {} and (lang, age) == ("en", "6-9")
        assert summary["activity"] == "recitation" and summary["verdict"] == "mistakes"
        assert summary["errors"][0] == {"kind": "del", "expected": "the", "heard": None, "exp_index": 4}

    def test_correct_with_offline_templates(self, make_client: Callable[..., TestClient]) -> None:
        r = recite(make_client(transcriber=RecordingTranscriber("the cat sat on the mat"), brain=OfflineBrain()))
        body = r.json()
        assert body["result"]["verdict"] == "correct" and body["result"]["word_accuracy"] == 1.0
        assert body["feedback"] == feedback.praise("en", "6-9")

    def test_transcriber_gets_float32_mono_16k(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("the cat sat on the mat")
        recite(make_client(transcriber=transcriber), audio=wav(2.0, rate=44_100, channels=2), lang="en")
        (args, kwargs), = transcriber.calls
        pcm, lang = args
        assert kwargs == {} and lang == "en"
        assert isinstance(pcm, np.ndarray) and pcm.dtype == np.float32 and pcm.ndim == 1
        assert pcm.size == 32_000

    @pytest.mark.parametrize("audio", [silent_wav(2.0), wav(0.3)], ids=["too quiet", "too short"])
    def test_unclear_audio_skips_recognition(self, make_client: Callable[..., TestClient], audio: bytes) -> None:
        transcriber = RecordingTranscriber("the cat sat on the mat")
        body = recite(make_client(transcriber=transcriber, brain=OfflineBrain()), audio=audio).json()
        assert transcriber.calls == []
        assert body["heard_text"] == "" and body["say_again"] is True
        assert body["result"]["verdict"] == "unclear" and body["result"]["say_again"] is True
        assert body["quality"]["too_quiet"] or body["quality"]["too_short"]
        assert body["feedback"] == feedback.say_again("en", "6-9")

    def test_nothing_heard_is_unclear(self, make_client: Callable[..., TestClient]) -> None:
        body = recite(make_client(transcriber=RecordingTranscriber(""))).json()
        assert body["result"]["verdict"] == "unclear" and body["say_again"] is True

    def test_audio_errors(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("x")
        client = make_client(transcriber=transcriber)
        assert_error(recite(client, audio=b"not a wav at all"), 400, "bad_audio")
        assert_error(recite(client, audio=b""), 400, "bad_audio")
        assert_error(recite(client, audio=wav(121.0)), 413, "audio_too_long")
        too_big = wav(1.0) + b"\x00" * MAX_AUDIO_BYTES
        assert_error(recite(client, audio=too_big), 413, "audio_too_large")
        assert transcriber.calls == []

    def test_long_low_rate_file_is_refused_before_decoding(
        self, make_client: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # 2.5 hours of 8-bit audio at 1 kHz fits in 9 MB; decoding it would make 144 M samples.
        frames = 9_000_000
        header = (
            b"RIFF" + struct.pack("<I", 36 + frames) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 1000, 1000, 1, 8)
            + b"data" + struct.pack("<I", frames)
        )
        assert len(header) == 44
        monkeypatch.setattr(app_mod, "decode_wav", lambda data: pytest.fail("decoded an over-long file"))
        assert_error(recite(make_client(), audio=header + b"\x80" * frames), 413, "audio_too_long")

    def test_two_minutes_is_accepted(self, make_client: Callable[..., TestClient]) -> None:
        r = recite(make_client(transcriber=RecordingTranscriber("the cat sat on the mat")), audio=wav(120.0))
        assert r.status_code == 200 and r.json()["quality"]["seconds"] == pytest.approx(120.0)

    @pytest.mark.parametrize("missing", ["audio", "expected_text", "lang", "mode", "age"])
    def test_missing_fields(self, make_client: Callable[..., TestClient], missing: str) -> None:
        kwargs: dict[str, Any] = {missing: b"-" if missing == "audio" else None}
        body = assert_error(recite(make_client(), **kwargs), 422, "missing_field")
        assert missing in body["message"]

    @pytest.mark.parametrize(("field", "value"), [("lang", "de"), ("mode", "loose"), ("age", "5")])
    def test_invalid_fields(self, make_client: Callable[..., TestClient], field: str, value: str) -> None:
        body = assert_error(recite(make_client(), **{field: value}), 422, "invalid_field")
        assert field in body["message"] and value not in body["message"].replace(field, "")

    def test_bad_expected_text(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("x")
        client = make_client(transcriber=transcriber)
        assert_error(recite(client, expected_text="   "), 400, "empty_text")
        assert_error(recite(client, expected_text="!!! ..."), 400, "empty_text")
        assert_error(recite(client, expected_text="word " * (MAX_TEXT_CHARS // 5 + 1)), 400, "text_too_long")
        assert transcriber.calls == []

    def test_recogniser_unavailable(self, make_client: Callable[..., TestClient]) -> None:
        body = assert_error(recite(make_client(transcriber=FakeTranscriber(available=False))), 503, "asr_unavailable")
        assert "not available" in body["message"]
        failing = RecordingTranscriber(error=ASRUnavailable("model vanished"))
        assert_error(recite(make_client(transcriber=failing)), 503, "asr_unavailable")

    def test_feedback_falls_back_to_templates(self, make_client: Callable[..., TestClient]) -> None:
        heard = "the cat sat on mat"
        template = feedback.for_result(check_recitation(EN_TEXT, heard, "en"), "en", "6-9")
        for brain in (RaisingBrain(), FakeBrain(feedback_text="   ")):
            body = recite(make_client(transcriber=RecordingTranscriber(heard), brain=brain)).json()
            assert body["feedback"] == template

    def test_internal_error_is_json_and_not_logged(
        self, make_client: Callable[..., TestClient], caplog: pytest.LogCaptureFixture
    ) -> None:
        secret = "Zanzibar zebras zigzag"
        failing = RecordingTranscriber(error=RuntimeError(f"native crash near {secret}"))
        with caplog.at_level(logging.DEBUG):
            r = recite(make_client(transcriber=failing), expected_text=secret)
        assert_error(r, 500, "internal_error")
        assert "RuntimeError" in caplog.text
        assert "Zanzibar" not in caplog.text and "zigzag" not in caplog.text


# ---------------------------------------------------------------------------
# /api/recite/check (contextual)
# ---------------------------------------------------------------------------


class TestReciteContextual:
    def test_claude_judges_meaning(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        transcriber = RecordingTranscriber("a cat was sitting")
        r = recite(make_client(transcriber=transcriber, brain=brain), mode="contextual", age="10-13")
        body = r.json()
        assert set(body) == {"mode", "heard_text", "judgement", "feedback", "quality", "say_again"}
        assert body["mode"] == "contextual" and body["heard_text"] == "a cat was sitting"
        assert body["judgement"] == {"verdict": "partly", "missing_ideas": ["mat"], "wrong_ideas": [], "say_again": False}
        assert body["feedback"] == "Good! Where did the cat sit?"
        assert brain.called("judge_meaning") == [((EN_TEXT, "a cat was sitting", "en", "10-13"), {})]
        assert brain.called("word_feedback") == []

    def test_offline_is_approximate(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client(transcriber=RecordingTranscriber("the cat sat on the mat"), brain=OfflineBrain())
        body = recite(client, mode="contextual").json()
        assert body["judgement"]["verdict"] == "same_meaning" and body["judgement"]["approximate"] is True
        assert body["feedback"]

    @pytest.mark.parametrize("brain", [RaisingBrain(), FakeBrain(judgement={"verdict": "maybe"})], ids=["raises", "junk"])
    def test_brain_failure_uses_the_heuristic(self, make_client: Callable[..., TestClient], brain: FakeBrain) -> None:
        client = make_client(transcriber=RecordingTranscriber("the cat sat on the mat"), brain=brain)
        body = recite(client, mode="contextual").json()
        assert body["judgement"]["verdict"] == "same_meaning" and body["judgement"]["approximate"] is True

    def test_missing_feedback_uses_the_template(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain(judgement={"verdict": "different", "missing_ideas": [], "wrong_ideas": []})
        body = recite(make_client(transcriber=RecordingTranscriber("dogs bark"), brain=brain), mode="contextual").json()
        assert body["feedback"] and body["judgement"]["verdict"] == "different"

    @pytest.mark.parametrize(("audio", "heard"), [(silent_wav(), "words"), (wav(), "")], ids=["quiet", "nothing heard"])
    def test_unclear(self, make_client: Callable[..., TestClient], audio: bytes, heard: str) -> None:
        brain = FakeBrain()
        body = recite(make_client(transcriber=RecordingTranscriber(heard), brain=brain), audio=audio, mode="contextual").json()
        assert body["judgement"]["verdict"] == "unclear" and body["say_again"] is True
        assert body["feedback"] == feedback.say_again("en", "6-9")
        assert brain.calls == []


# ---------------------------------------------------------------------------
# Dictation
# ---------------------------------------------------------------------------


class TestDictationPhrases:
    def test_phrases(self, make_client: Callable[..., TestClient]) -> None:
        text = "Le chat dort. Le chien court vite dans le grand jardin vert ce matin."
        r = make_client().post("/api/dictation/phrases", json={"text": text, "lang": "fr"})
        assert r.status_code == 200 and r.json() == {"phrases": split_phrases(text, "fr")}

    def test_errors(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        assert_error(client.post("/api/dictation/phrases", json={"text": "  ", "lang": "fr"}), 400, "empty_text")
        long_text = "mot " * (MAX_TEXT_CHARS // 4 + 1)
        assert_error(client.post("/api/dictation/phrases", json={"text": long_text, "lang": "fr"}), 400, "text_too_long")
        assert_error(client.post("/api/dictation/phrases", json={"lang": "fr"}), 422, "missing_field")
        assert_error(client.post("/api/dictation/phrases", json={"text": "a", "lang": "es"}), 422, "invalid_field")
        assert_error(
            client.post("/api/dictation/phrases", content=b"{not json", headers={"content-type": "application/json"}),
            422, "invalid_field",
        )


class TestTTS:
    def test_speaks(self, make_client: Callable[..., TestClient]) -> None:
        tts = FakeTTS()
        r = make_client(tts=tts).post("/api/tts", json={"text": "Well done!", "lang": "en"})
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        assert r.content[:4] == b"RIFF" and r.content[8:12] == b"WAVE"
        assert tts.calls == [("Well done!", "en", False)]
        assert r.headers["x-speech-check"] == "skipped"

    def test_slow_speech_is_checked_unprompted(self, make_client: Callable[..., TestClient]) -> None:
        tts = FakeTTS()
        transcriber = RecordingTranscriber("Le chat dort.")
        r = make_client(tts=tts, transcriber=transcriber).post(
            "/api/tts", json={"text": "Le chat dort.", "lang": "fr", "slow": True}
        )
        assert r.status_code == 200 and r.headers["x-speech-check"] == "passed"
        assert tts.calls == [("Le chat dort.", "fr", True)]
        (args, kwargs), = transcriber.calls
        assert kwargs == {} and len(args) == 2 and isinstance(args[0], np.ndarray) and args[1] == "fr"

    def test_slow_speech_that_says_something_else(self, make_client: Callable[..., TestClient]) -> None:
        tts = FakeTTS()
        client = make_client(tts=tts, transcriber=RecordingTranscriber("le chien court"))
        r = client.post("/api/tts", json={"text": "Le chat dort.", "lang": "fr", "slow": True})
        assert r.status_code == 200 and r.headers["x-speech-check"] == "failed"
        assert len(tts.calls) == app_mod.SPEECH_CHECK_ATTEMPTS

    def test_slow_speech_without_recogniser(self, make_client: Callable[..., TestClient]) -> None:
        tts = FakeTTS()
        client = make_client(tts=tts, transcriber=FakeTranscriber(available=False))
        r = client.post("/api/tts", json={"text": "Le chat dort.", "lang": "fr", "slow": True})
        assert r.headers["x-speech-check"] == "skipped" and tts.calls == [("Le chat dort.", "fr", True)]

    def test_text_limits(self, make_client: Callable[..., TestClient]) -> None:
        tts = FakeTTS()
        client = make_client(tts=tts)
        assert_error(client.post("/api/tts", json={"text": "", "lang": "en"}), 400, "empty_text")
        assert_error(client.post("/api/tts", json={"text": " \n ", "lang": "en"}), 400, "empty_text")
        too_long = "a" * (MAX_TTS_CHARS + 1)
        assert_error(client.post("/api/tts", json={"text": too_long, "lang": "en"}), 400, "text_too_long")
        assert client.post("/api/tts", json={"text": "a" * MAX_TTS_CHARS, "lang": "en"}).status_code == 200
        assert_error(client.post("/api/tts", json={"lang": "en"}), 422, "missing_field")
        assert_error(client.post("/api/tts", json={"text": "hi", "lang": "it"}), 422, "invalid_field")
        assert len(tts.calls) == 1

    def test_unavailable(self, make_client: Callable[..., TestClient]) -> None:
        r = make_client(tts=FakeTTS(available=False)).post("/api/tts", json={"text": "Hello", "lang": "en"})
        assert_error(r, 503, "tts_unavailable")

    @pytest.mark.parametrize(
        ("error", "status", "code"),
        [
            (TTSUnavailable("no ar voice"), 503, "tts_unavailable"),
            (QuranTextRefused("refused"), 422, "quran_text"),
            (ValueError("text has nothing to pronounce"), 400, "bad_text"),
        ],
    )
    def test_synthesizer_errors(
        self, make_client: Callable[..., TestClient], error: Exception, status: int, code: str
    ) -> None:
        class FailingTTS:
            available = True

            def synthesize(self, text: str, lang: str, *, slow: bool = False) -> bytes:
                raise error

        assert_error(make_client(tts=FailingTTS()).post("/api/tts", json={"text": "…", "lang": "ar"}), status, code)


def check_dictation(client: TestClient, *, image: bytes | None = None, **fields: Any) -> Any:
    """POST /api/dictation/check (French defaults; a None field is left out)."""
    data = {"expected_text": FR_TEXT, "lang": "fr", "age": "10-13", **fields}
    data = {k: v for k, v in data.items() if v is not None}
    files = {"image": ("writing.jpg", image, "image/jpeg")} if image is not None else None
    return client.post("/api/dictation/check", data=data, files=files)


class TestDictationCheck:
    def post(self, client: TestClient, *, image: bytes | None = None, **fields: Any) -> Any:
        return check_dictation(client, image=image, **fields)

    def test_typed_by_the_parent(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        written = "Le chat dor sur le tapis."
        r = self.post(make_client(brain=brain), written_text=written)
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {
            "read_text", "source", "uncertain_words", "legible", "result", "feedback", "needs_parent_confirmation",
        }
        assert body["read_text"] == written and body["source"] == "typed"
        assert body["needs_parent_confirmation"] is True and body["uncertain_words"] == []
        assert body["result"] == json.loads(json.dumps(dataclasses.asdict(check_writing(FR_TEXT, written, "fr"))))
        assert body["result"]["verdict"] == "mistakes"
        (summary, lang, age), _ = brain.called("word_feedback")[0]
        assert summary["activity"] == "dictation" and (lang, age) == ("fr", "10-13")
        assert brain.called("read_handwriting") == []

    def test_photo_read_by_claude(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        image = jpeg()
        body = self.post(make_client(brain=brain), image=image).json()
        assert body["read_text"] == "Le chat dor sur le tapis." and body["source"] == "claude"
        assert body["uncertain_words"] == ["dor"] and body["legible"] is True
        assert body["needs_parent_confirmation"] is True and body["result"]["verdict"] == "mistakes"
        assert brain.called("read_handwriting") == [((image, "fr"), {})]

    def test_photo_offline_needs_manual(self, make_client: Callable[..., TestClient]) -> None:
        assert_error(self.post(make_client(brain=OfflineBrain()), image=jpeg()), 501, "needs_manual")

    @pytest.mark.parametrize(
        "brain",
        [RaisingBrain(), FakeBrain(handwriting={"text": "", "needs_manual": True, "error": "APIConnectionError"}),
         FakeBrain(handwriting={"text": "   ", "uncertain_words": [], "legible": False})],
        ids=["raises", "fallback", "nothing read"],
    )
    def test_photo_not_read_needs_manual(self, make_client: Callable[..., TestClient], brain: FakeBrain) -> None:
        assert_error(self.post(make_client(brain=brain), image=jpeg()), 501, "needs_manual")

    def test_input_errors(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        client = make_client(brain=brain)
        assert_error(self.post(client), 422, "missing_field")
        assert_error(self.post(client, image=jpeg(), written_text="Le chat"), 422, "invalid_request")
        assert_error(self.post(client, image=b"%PDF-1.4"), 400, "bad_image")
        assert_error(self.post(client, image=jpeg() + b"\x00" * MAX_IMAGE_BYTES), 413, "image_too_large")
        assert_error(self.post(client, written_text="x", expected_text=None), 422, "missing_field")
        assert_error(self.post(client, written_text="x", age="adult"), 422, "invalid_field")
        assert_error(self.post(client, written_text="x" * (MAX_TEXT_CHARS + 1)), 400, "text_too_long")
        assert brain.called("read_handwriting") == []

    def test_strict_tashkeel(self, make_client: Callable[..., TestClient]) -> None:
        expected, written = "كَتَبَ الوَلَدُ الدَّرْسَ", "كتب الولد الدرس"
        lenient = check_writing(expected, written, "ar")
        strict = check_writing(expected, written, "ar", strict_tashkeel=True)
        assert lenient.verdict == "correct" and strict.verdict != "correct"
        client = make_client()
        for flag, want in ((None, lenient), ("false", lenient), ("true", strict)):
            body = self.post(client, expected_text=expected, lang="ar", written_text=written, strict_tashkeel=flag).json()
            assert body["result"]["verdict"] == want.verdict


# ---------------------------------------------------------------------------
# Quran
# ---------------------------------------------------------------------------


class TestQuranText:
    def test_surahs(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        body = make_client().get("/api/quran/surahs").json()
        assert len(body["surahs"]) == 114 and body["surahs"] == quran.surahs()
        assert {"number", "name_ar", "ayah_count"} <= set(body["surahs"][0])
        assert body["riwaya"] == "hafs" and body["source_url"] == "https://tanzil.net"
        assert body["attribution"] == quran.attribution and "Tanzil" in body["licence"]

    def test_ayat(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        r = make_client().get("/api/quran/ayat", params={"surah": 112, "from": 1, "to": 4})
        assert r.status_code == 200
        body = r.json()
        assert body["attribution"] == quran.attribution and body["riwaya"] == "hafs"
        assert body["ayat"] == [
            {"surah": a.surah, "ayah": a.ayah, "display": a.display, "display_words": a.display_words}
            for a in quran.ayat(112, 1, 4)
        ]

    def test_fifty_ayat_allowed(self, make_client: Callable[..., TestClient]) -> None:
        r = make_client().get("/api/quran/ayat", params={"surah": 2, "from": 1, "to": 50})
        assert r.status_code == 200 and len(r.json()["ayat"]) == 50

    @pytest.mark.parametrize(
        ("params", "code"),
        [
            ({"surah": 0, "from": 1, "to": 1}, "invalid_surah"),
            ({"surah": 115, "from": 1, "to": 1}, "invalid_surah"),
            ({"surah": 112, "from": 0, "to": 1}, "invalid_range"),
            ({"surah": 112, "from": 3, "to": 2}, "invalid_range"),
            ({"surah": 112, "from": 1, "to": 5}, "invalid_range"),
            ({"surah": 2, "from": 1, "to": 51}, "range_too_long"),
            ({"surah": "al-ikhlas", "from": 1, "to": 1}, "invalid_field"),
            ({"surah": 112, "from": 1}, "missing_field"),
        ],
    )
    def test_ayat_errors(self, make_client: Callable[..., TestClient], params: dict, code: str) -> None:
        assert_error(make_client().get("/api/quran/ayat", params=params), 422, code)

    def test_unavailable(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client(quran_obj=None)
        assert_error(client.get("/api/quran/surahs"), 503, "quran_unavailable")
        assert_error(client.get("/api/quran/ayat", params={"surah": 1, "from": 1, "to": 1}), 503, "quran_unavailable")
        r = client.post("/api/quran/check", data={"surah": 1, "from": 1, "to": 1}, files={"audio": ("a.wav", wav())})
        assert_error(r, 503, "quran_unavailable")
        assert_error(client.post("/api/quran/locate", data={"heard_text": "x"}), 503, "quran_unavailable")


class TestQuranCheck:
    def post(self, client: TestClient, surah: Any = 112, start: Any = 1, end: Any = 4, audio: bytes | None = None) -> Any:
        data = {k: v for k, v in {"surah": surah, "from": start, "to": end}.items() if v is not None}
        return client.post("/api/quran/check", data=data, files={"audio": ("q.wav", audio or wav(3.0), "audio/wav")})

    def test_correct(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        heard = " ".join(quran_words(quran, 112, 1, 4))
        transcriber = RecordingTranscriber(heard)
        r = self.post(make_client(transcriber=transcriber))
        assert r.status_code == 200
        body = r.json()
        assert {"heard_text", "ops", "verdict", "say_again", "first_error", "feedback"} <= set(body)
        assert body["heard_text"] == heard and body["verdict"] == "correct" and body["first_error"] is None
        assert body["feedback"] == feedback.quran_feedback("correct", None)
        assert body["riwaya"] == "hafs" and body["attribution"] == quran.attribution
        assert body["words"] and all(w["status"] == "match" for w in body["words"])
        (args, kwargs), = transcriber.calls
        assert kwargs == {} and args[1] == "ar"

    def test_skipped_word(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        words = quran_words(quran, 112, 1, 4)
        heard = " ".join(words[:5] + words[6:])
        body = self.post(make_client(transcriber=RecordingTranscriber(heard))).json()
        expected = quran.check(112, 1, 4, heard)
        assert body["verdict"] == "mistakes" == expected["verdict"]
        assert body["ops"] == expected["ops"] and body["first_error"] == expected["first_error"]
        first = body["first_error"]
        assert first["kind"] == "del"
        assert body["feedback"] == feedback.quran_feedback("del", first["expected_display_word"])

    def test_unclear_audio(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("x")
        body = self.post(make_client(transcriber=transcriber), audio=silent_wav(2.0)).json()
        assert transcriber.calls == []
        assert body["verdict"] == "unclear" and body["say_again"] is True and body["heard_text"] == ""
        assert body["feedback"] == feedback.quran_feedback("unclear", None)

    @pytest.mark.parametrize(
        ("surah", "start", "end", "code"),
        [(0, 1, 1, "invalid_surah"), (115, 1, 1, "invalid_surah"), (112, 2, 1, "invalid_range"),
         (112, 1, 9, "invalid_range"), (2, 10, 60, "range_too_long"), ("x", 1, 1, "invalid_field"),
         (112, None, 2, "missing_field")],
    )
    def test_range_errors(self, make_client: Callable[..., TestClient], surah: Any, start: Any, end: Any, code: str) -> None:
        transcriber = RecordingTranscriber("x")
        body = assert_error(self.post(make_client(transcriber=transcriber), surah, start, end), 422, code)
        if code == "missing_field":
            assert "from" in body["message"]
        assert transcriber.calls == []

    def test_errors(self, make_client: Callable[..., TestClient]) -> None:
        assert_error(self.post(make_client(transcriber=FakeTranscriber(available=False))), 503, "asr_unavailable")
        assert_error(self.post(make_client(), audio=b"RIFF0000WAVEjunk"), 400, "bad_audio")
        r = make_client().post("/api/quran/check", data={"surah": 112, "from": 1, "to": 4})
        assert_error(r, 422, "missing_field")


class TestQuranLocate:
    def test_from_text(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        heard = " ".join(quran_words(quran, 112, 1, 2))
        r = make_client().post("/api/quran/locate", data={"heard_text": heard})
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {"heard_text", "candidates", "say_again", "quality"}
        assert body["say_again"] is False and body["quality"] is None
        top = body["candidates"][0]
        assert {"surah", "ayah", "word_index", "score", "display_preview"} <= set(top)
        assert (top["surah"], top["ayah"], top["word_index"]) == (112, 1, 0) and top["score"] == 1.0
        assert body["candidates"] == quran.locate(heard, top_k=5)

    def test_within_surah(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        heard = " ".join(quran_words(quran, 112, 1, 2))
        body = make_client().post("/api/quran/locate", data={"heard_text": heard, "surah": 2}).json()
        assert all(c["surah"] == 2 for c in body["candidates"])

    def test_from_audio(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        heard = " ".join(quran_words(quran, 114, 1, 2))
        transcriber = RecordingTranscriber(heard)
        body = make_client(transcriber=transcriber).post(
            "/api/quran/locate", files={"audio": ("q.wav", wav(2.0), "audio/wav")}, data={"surah": "114"}
        ).json()
        assert body["heard_text"] == heard and body["candidates"][0]["surah"] == 114
        assert set(body["quality"]) == QUALITY_KEYS
        (args, kwargs), = transcriber.calls
        assert kwargs == {} and args[1] == "ar"

    def test_nothing_heard(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("x")
        client = make_client(transcriber=transcriber)
        body = client.post("/api/quran/locate", files={"audio": ("q.wav", silent_wav(), "audio/wav")}).json()
        assert body == {"heard_text": "", "candidates": [], "say_again": True, "quality": body["quality"]}
        assert transcriber.calls == []
        assert client.post("/api/quran/locate", data={"heard_text": " . "}).json()["say_again"] is True

    def test_errors(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        assert_error(client.post("/api/quran/locate"), 422, "missing_field")
        r = client.post("/api/quran/locate", data={"heard_text": "x"}, files={"audio": ("q.wav", wav(), "audio/wav")})
        assert_error(r, 422, "invalid_request")
        assert_error(client.post("/api/quran/locate", data={"heard_text": "x", "surah": 200}), 422, "invalid_surah")
        assert_error(client.post("/api/quran/locate", data={"heard_text": "x" * (MAX_TEXT_CHARS + 1)}), 400, "text_too_long")
        no_asr = make_client(transcriber=FakeTranscriber(available=False))
        assert_error(no_asr.post("/api/quran/locate", files={"audio": ("q.wav", wav(), "audio/wav")}), 503, "asr_unavailable")
        assert no_asr.post("/api/quran/locate", data={"heard_text": "x"}).status_code == 200


# ---------------------------------------------------------------------------
# Hard rules
# ---------------------------------------------------------------------------


class TestRecogniserIsNeverToldTheText:
    """Hard rule 1: the recogniser gets audio and a language, nothing else."""

    def test_signatures_have_no_text_parameter(self) -> None:
        for transcribe in (Transcriber.transcribe, SherpaWhisper.transcribe, FakeTranscriber.transcribe):
            assert list(inspect.signature(transcribe).parameters) == ["self", "pcm16k", "lang"]

    def test_spy_across_requests(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        spy = SpyTranscriber("hello")
        brain = FakeBrain()
        client = make_client(transcriber=spy, brain=brain, tts=FakeTTS())
        requests = [  # (lang, mode, expected text, its distinctive words)
            ("en", "strict", "Zebras zigzag quickly across Zanzibar", ["Zebras", "zigzag", "Zanzibar"]),
            ("fr", "contextual", "Les zèbres zigzaguent joyeusement à Zanzibar", ["zèbres", "zigzaguent"]),
            ("ar", "strict", AR_TEXT, []),
        ]
        for lang, mode, expected, words in requests:
            # Every expected text so far must stay invisible, not only the current one.
            spy.secrets += [expected, *words]
            r = recite(client, expected_text=expected, lang=lang, mode=mode)
            assert r.status_code == 200, r.text

        # Dictation speech is checked by transcribing it: still without the phrase.
        phrase = "Zanzibar quokkas yodel"
        spy.heard = phrase
        spy.secrets += [phrase, "quokkas", "yodel"]
        assert client.post("/api/tts", json={"text": phrase, "lang": "en", "slow": True}).status_code == 200

        # The Quran check: the ayat of the range must not reach the recogniser either.
        ayat = quran.ayat(112, 1, 4)
        spy.heard = "hello"
        spy.secrets += [" ".join(quran_words(quran, 112, 1, 4)), *(a.display for a in ayat), *(a.match for a in ayat)]
        r = client.post("/api/quran/check", data={"surah": 112, "from": 1, "to": 4}, files={"audio": ("q.wav", wav())})
        assert r.status_code == 200

        assert len(spy.calls) == 5
        for (args, kwargs), lang in zip(spy.calls, ["en", "fr", "ar", "en", "ar"]):
            assert kwargs == {}
            assert len(args) == 2 and args[1] == lang
            assert isinstance(args[0], np.ndarray) and args[0].dtype == np.float32 and args[0].ndim == 1
        assert spy.leaks == []

    def test_spy_detects_a_leak(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # The leak finder works: a module-level copy of the text would be found.
        spy = SpyTranscriber("x")
        spy.secrets = ["Zanzibar zebras"]
        monkeypatch.setattr(app_mod, "_LAST_TEXT", "the Zanzibar zebras text", raising=False)
        spy.transcribe(np.zeros(10, dtype=np.float32), "en")
        assert spy.leaks and "mommy.app._LAST_TEXT" in spy.leaks[0]


class TestHandwritingIsReadBlind:
    """Hard rule 3: the brain sees the photo and the language, never the expected text."""

    def test_signatures_have_no_text_parameter(self) -> None:
        for method in (Brain.read_handwriting, ClaudeBrain.read_handwriting, OfflineBrain.read_handwriting):
            assert list(inspect.signature(method).parameters) == ["self", "image_jpeg", "lang"]

    def test_spy(self, make_client: Callable[..., TestClient]) -> None:
        expected = "Les zèbres zigzaguent joyeusement à Zanzibar"
        secrets = [expected, "zèbres", "zigzaguent", "joyeusement", "Zanzibar"]
        seen: list[str] = []

        class SpyBrain(FakeBrain):
            def read_handwriting(self, *args: Any, **kwargs: Any) -> dict:
                seen.extend(find_leaks(secrets, args, kwargs))
                return super().read_handwriting(*args, **kwargs)

        brain = SpyBrain(handwriting={"text": "Les zèbre zigzag", "uncertain_words": [], "legible": True})
        image = jpeg()
        r = check_dictation(make_client(brain=brain), image=image, expected_text=expected)
        assert r.status_code == 200
        assert brain.called("read_handwriting") == [((image, "fr"), {})]
        assert seen == []


class TestQuranPathsUseNoBrainAndNoVoice:
    """Hard rule 4: no LLM and no synthetic speech on any Quran path."""

    def test_quran_endpoints(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        brain, tts = ExplodingBrain(), ExplodingTTS()
        words = quran_words(quran, 112, 1, 4)
        transcriber = RecordingTranscriber(" ".join(words[:3] + words[4:]))
        client = make_client(transcriber=transcriber, brain=brain, tts=tts)
        audio = {"audio": ("q.wav", wav(2.0), "audio/wav")}
        responses = [
            client.get("/api/quran/surahs"),
            client.get("/api/quran/ayat", params={"surah": 112, "from": 1, "to": 4}),
            client.post("/api/quran/check", data={"surah": 112, "from": 1, "to": 4}, files=audio),
            client.post("/api/quran/check", data={"surah": 112, "from": 1, "to": 4}, files={"audio": ("q.wav", silent_wav())}),
            client.post("/api/quran/locate", files=audio),
            client.post("/api/quran/locate", data={"heard_text": " ".join(words)}),
        ]
        assert [r.status_code for r in responses] == [200] * len(responses)
        assert responses[2].json()["verdict"] == "mistakes"
        assert brain.calls == [] and tts.calls == []

    def test_quran_text_is_refused_elsewhere(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        brain, tts = ExplodingBrain(), ExplodingTTS()
        transcriber = RecordingTranscriber("x")
        client = make_client(transcriber=transcriber, brain=brain, tts=tts)
        plain = " ".join(quran_words(quran, 112, 1, 2))
        uthmani = quran.ayat(112, 1, 1)[0].display
        for text in (plain, uthmani):
            assert_error(recite(client, expected_text=text, lang="ar"), 422, "quran_text")
            assert_error(recite(client, expected_text=text, lang="ar", mode="contextual"), 422, "quran_text")
            assert_error(client.post("/api/tts", json={"text": text, "lang": "ar"}), 422, "quran_text")
            assert_error(client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"}), 422, "quran_text")
            r = client.post("/api/dictation/check", data={"expected_text": text, "lang": "ar", "age": "6-9", "written_text": text})
            assert_error(r, 422, "quran_text")
        assert transcriber.calls == [] and brain.calls == [] and tts.calls == []

    def test_looks_like_quran(self, quran: Quran) -> None:
        plain = quran_words(quran, 2, 255, 255)
        assert looks_like_quran(" ".join(plain), quran)
        assert looks_like_quran(" ".join(plain[:4]), quran)
        assert looks_like_quran(quran.ayat(114, 1, 1)[0].display, None)  # Uthmani script, even without data
        assert not looks_like_quran(" ".join(plain[:3]), quran)  # too short to tell
        assert not looks_like_quran(" ".join(plain), None)
        assert not looks_like_quran(AR_TEXT, quran)
        assert not looks_like_quran(EN_TEXT, quran)
        quoting = f"{AR_TEXT} {' '.join(plain[:4])} {AR_TEXT}"  # a lesson quoting a few words
        assert not looks_like_quran(quoting, quran)

    def test_ordinary_arabic_is_accepted(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client(transcriber=RecordingTranscriber(AR_TEXT))
        assert recite(client, expected_text=AR_TEXT, lang="ar").json()["result"]["verdict"] == "correct"
        assert client.post("/api/tts", json={"text": AR_TEXT, "lang": "ar"}).status_code == 200


class TestNothingSensitiveIsLogged:
    """Hard rule 5: logs carry sizes and timings, never what a child said or wrote."""

    def test_logs(self, make_client: Callable[..., TestClient], quran: Quran, caplog: pytest.LogCaptureFixture) -> None:
        said = "Quixotic zebras zigzag"
        written = "Quixotik zebrass"
        client = make_client(transcriber=RecordingTranscriber(said), brain=FakeBrain(feedback_text="Nice try zebras"))
        with caplog.at_level(logging.DEBUG):
            for mode in ("strict", "contextual"):
                assert recite(client, expected_text="Quixotic zebras zigzag wildly", mode=mode).status_code == 200
            r = client.post(
                "/api/dictation/check",
                data={"expected_text": "Quixotic zebras", "lang": "en", "age": "6-9", "written_text": written},
            )
            assert r.status_code == 200
            assert client.post("/api/tts", json={"text": "Quixotic zebras", "lang": "en", "slow": True}).status_code == 200
            assert client.post("/api/page/read", files={"image": ("p.jpg", jpeg())}).status_code == 200
        assert "recite/check" in caplog.text  # something was logged...
        for word in ("Quixotic", "Quixotik", "zebras", "zigzag", "wildly", FR_TEXT):
            assert word not in caplog.text  # ...but no content


# ---------------------------------------------------------------------------
# build_default_app
# ---------------------------------------------------------------------------


@pytest.fixture
def restore_mommy_logger() -> Iterator[None]:
    """build_default_app configures the ``mommy`` logger; put it back for other tests."""
    logger = logging.getLogger("mommy")
    saved = (list(logger.handlers), logger.level, logger.propagate)
    yield
    logger.handlers[:] = saved[0]
    logger.setLevel(saved[1])
    logger.propagate = saved[2]


class TestBuildDefaultApp:
    def test_starts_without_models_quran_or_claude(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, restore_mommy_logger: None
    ) -> None:
        for name in ("ANTHROPIC_API_KEY", "MOMMY_VISION_MODEL", "MOMMY_TEXT_MODEL", "MOMMY_ASR_MODEL", "MOMMY_EFFORT"):
            monkeypatch.delenv(name, raising=False)
        settings = make_settings(
            root=tmp_path, models_dir=tmp_path / "models", quran_dir=tmp_path / "data" / "quran", web_dir=tmp_path / "web"
        )
        monkeypatch.setattr(app_mod, "load_settings", lambda: settings)
        client = TestClient(build_default_app())
        body = client.get("/api/health").json()
        assert {k: body[k] for k in ("asr", "tts", "brain", "quran")} == {
            "asr": False, "tts": False, "brain": "offline", "quran": False,
        }
        assert "missing" in body["reasons"]["asr"]
        assert_error(client.get("/api/quran/surahs"), 503, "quran_unavailable")
        assert_error(recite(client), 503, "asr_unavailable")

    def test_real_components(self, monkeypatch: pytest.MonkeyPatch, restore_mommy_logger: None) -> None:
        for name in ("ANTHROPIC_API_KEY", "MOMMY_VISION_MODEL", "MOMMY_TEXT_MODEL", "MOMMY_ASR_MODEL"):
            monkeypatch.delenv(name, raising=False)
        client = TestClient(build_default_app())
        body = client.get("/api/health").json()
        assert body["quran"] is True and body["brain"] == "offline"
        assert body["asr"] is (ROOT / "models" / "sherpa-onnx-whisper-small" / "small-encoder.int8.onnx").is_file()
        assert client.get("/").status_code == 200
        # Logging is configured once, however many apps are built.
        build_default_app()
        assert len(logging.getLogger("mommy").handlers) == 1

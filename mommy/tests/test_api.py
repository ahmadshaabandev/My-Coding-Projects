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
    MAX_TEXT_WORDS,
    MAX_TTS_CHARS,
    ApiError,
    body_limit,
    build_default_app,
    clean_image,
    create_app,
    is_quran_phrase,
    keep_uploads_in_memory,
    looks_like_quran,
)
from mommy.asr import ASRUnavailable, FakeTranscriber, SherpaWhisper, Transcriber
from mommy.config import Settings, load_settings
from mommy.llm import Brain, ClaudeBrain, OfflineBrain
from mommy.phrases import split_phrases
from mommy.quran import Quran
from mommy.tts import FakeTTS, QuranTextRefused, TTSUnavailable

ROOT = Path(__file__).resolve().parent.parent

EN_TEXT = "The cat sat on the mat."
FR_TEXT = "Le chat dort sur le tapis."
AR_TEXT = "ذهب الولد إلى المدرسة صباحا مع أخيه الصغير"  # an ordinary sentence, not Quran
#: The server answers only to its own host names (HostOriginMiddleware).
BASE_URL = "http://127.0.0.1:8080"

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
        return TestClient(app, base_url=BASE_URL)

    return make


#: The parent's AI consent as the web client sends it with a consent that counts. The
#: helpers below send it by default, so that the fake Claude brain answers; None leaves
#: the field out (TestAiConsent: the offline brain answers then).
CONSENT = "1"


def recite(
    client: TestClient,
    *,
    audio: bytes | None = None,
    expected_text: str | None = EN_TEXT,
    lang: str | None = "en",
    mode: str | None = "strict",
    age: str | None = "6-9",
    ai_consent: str | None = CONSENT,
    heard_before: str | None = None,
) -> Any:
    fields = dict(expected_text=expected_text, lang=lang, mode=mode, age=age, ai_consent=ai_consent, heard_before=heard_before)
    data = {k: v for k, v in fields.items() if v is not None}
    files = {"audio": ("child.wav", audio if audio is not None else wav(), "audio/wav")} if audio != b"-" else None
    return client.post("/api/recite/check", data=data, files=files)


def quran_words(quran: Quran, surah: int, start: int, end: int) -> list[str]:
    """The Simple-Clean (match) words of a range, as a recogniser would write them."""
    return [w for a in quran.ayat(surah, start, end) for w in a.match_words]


def assert_error(response: Any, status: int, code: str) -> dict:
    """The error body of the contract; a ``quran_text`` refusal of a text that is Quran
    may also name its range (``quran_range``), and a refusal by meaning says so
    (``"reason": "meaning"``, with ``QURAN_MEANING_MESSAGE``, never with a range)."""
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) - ({"quran_range", "reason"} if code == "quran_text" else set()) == {"error", "message"}
    if "reason" in body:
        assert body["reason"] == "meaning" and body["message"] == app_mod.QURAN_MEANING_MESSAGE
        assert "quran_range" not in body
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

    def test_local_run_is_not_online(self, make_client: Callable[..., TestClient]) -> None:
        # ./run.sh: the default loopback names and no access gate, with or without Claude.
        for brain in (FakeBrain(), OfflineBrain()):
            body = make_client(brain=brain).get("/api/health").json()
            assert body["online"] is False
        # Every loopback spelling stays local.
        for hosts, host in (
            (("127.0.0.1", "localhost", "::1"), "127.0.0.1:8080"),
            (("127.0.0.2", "app.localhost"), "app.localhost:8080"),
            (("::1",), "[::1]:8080"),
            (("LOCALHOST",), "localhost"),
        ):
            r = make_client(settings=make_settings(allowed_hosts=hosts)).get("/api/health", headers={"Host": host})
            assert r.status_code == 200 and r.json()["online"] is False, hosts
        assert app_mod.is_online(make_settings(allowed_hosts=("[::1]", " Localhost "))) is False

    @pytest.mark.parametrize(
        "hosts",
        [
            ("127.0.0.1", "localhost", "someone-mommy.hf.space"),  # a Space's host name next to the loopback ones
            ("tutor.example.org",),  # a tunnel's host name
            ("192.168.1.20",),  # a LAN address
            ("10.0.0.5", "127.0.0.1"),
            ("0.0.0.0",),
            ("fe80::1",),
            ("tutor.local",),
        ],
    )
    def test_a_host_that_is_not_loopback_is_online(
        self, make_client: Callable[..., TestClient], hosts: tuple[str, ...]
    ) -> None:
        client = make_client(settings=make_settings(allowed_hosts=hosts), brain=OfflineBrain())
        host = f"[{hosts[0]}]" if ":" in hosts[0] else hosts[0]
        r = client.get("/api/health", headers={"Host": host})
        assert r.status_code == 200, r.text
        assert r.json()["online"] is True and r.json()["brain"] == "offline"
        assert app_mod.is_online(make_settings(allowed_hosts=hosts)) is True

    def test_online_follows_the_settings_from_the_environment(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in ("MOMMY_ALLOWED_HOSTS", "MOMMY_ACCESS_CODE", "MOMMY_REQUIRE_ACCESS_CODE"):
            monkeypatch.delenv(name, raising=False)
        assert app_mod.is_online(load_settings()) is False  # run.sh
        monkeypatch.setenv("MOMMY_ALLOWED_HOSTS", " [::1] , LocalHost ")
        assert app_mod.is_online(load_settings()) is False
        monkeypatch.setenv("MOMMY_ALLOWED_HOSTS", "127.0.0.1,mommy.example.net")
        assert app_mod.is_online(load_settings()) is True
        monkeypatch.setenv("MOMMY_ALLOWED_HOSTS", "localhost")
        monkeypatch.setenv("MOMMY_ACCESS_CODE", "k7m2p9q4r8s3")  # the gate on a loopback name: the image tested locally
        assert app_mod.is_online(load_settings()) is True


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

    def test_the_web_client_is_asked_again_before_reuse(self, make_client: Callable[..., TestClient]) -> None:
        """RA-6: the files of the web client say "no-cache", so a browser revalidates them
        (a 304 with the ETag) and an updated app.js is used at the next load; an older one,
        which sends no ai_consent, does not keep running across reloads."""
        client = make_client()
        for path in ("/", "/index.html", "/app.js", "/family.js", "/rewards.js", "/recorder.js", "/styles.css", "/access.html", "/nope.js"):
            r = client.get(path)
            assert r.headers["cache-control"] == "no-cache", path
        r = client.get("/app.js")
        assert r.headers.get("etag") and r.headers.get("last-modified")
        again = client.get("/app.js", headers={"If-None-Match": r.headers["etag"]})
        assert again.status_code == 304 and again.headers["cache-control"] == "no-cache"
        assert client.get("/api/health").headers["cache-control"] == "no-store"  # the API keeps its own

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
            "/api/page/read", "/api/dictation/check", "/api/recite/phrase",
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
            with TestClient(app, base_url=BASE_URL) as client:
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
        r = client.post("/api/page/read", files={"image": ("p.jpg", image, "image/jpeg")}, data={"ai_consent": CONSENT})
        assert r.status_code == 200, r.text
        (sent, _), _ = brain.called("read_page")[0]
        # The whole upload was read (in memory) and re-encoded: the bytes after the
        # image are not passed on.
        assert sent.startswith(b"\xff\xd8") and len(sent) < 10_000
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
    def post(
        self, client: TestClient, image: bytes | None, lang: str | None = "fr", ai_consent: str | None = CONSENT
    ) -> Any:
        files = {"image": ("page.jpg", image, "image/jpeg")} if image is not None else None
        data = {k: v for k, v in {"lang": lang, "ai_consent": ai_consent}.items() if v is not None}
        return client.post("/api/page/read", files=files, data=data)

    def test_claude_reads_the_page(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        image = jpeg()
        r = self.post(make_client(brain=brain), image)
        assert r.status_code == 200
        assert r.json() == {
            "text": FR_TEXT, "lang": "fr", "notes": "", "source": "claude", "needs_manual": False,
            "contains_quran": False, "unreadable_marks": 0,
            "quran_parts": [], "mushaf_text": FR_TEXT, "quran_range": None, "brain": "claude",
        }
        assert brain.called("read_page") == [((clean_image(image), "fr"), {})]

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
        assert sent.startswith(b"\xff\xd8") and b"home address" not in sent and b"tEXt" not in sent

    def test_every_image_is_re_encoded_without_metadata(self) -> None:
        # Regression: EXIF after 128 KB of APP2 segments, a COM comment, an IPTC APP13
        # block and bytes after the end of the image were all passed on unchanged.
        secret = b"Sami Haddad, 12 rue des Lilas"
        base = jpeg((64, 48))
        def segment(marker: int, payload: bytes) -> bytes:
            return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload

        app2 = segment(0xE2, b"ICC_PROFILE\x00" + b"\x01" * 65000)
        variants = {
            "exif after 128 KB": base[:2] + app2 + app2 + segment(0xE1, b"Exif\x00\x00" + secret) + base[2:],
            "comment": base[:2] + segment(0xFE, secret) + base[2:],
            "iptc": base[:2] + segment(0xED, b"Photoshop 3.0\x00" + secret) + base[2:],
            "trailing data": base + secret * 1000,
            "png text": png(text=secret.decode()),
        }
        for name, image in variants.items():
            out = clean_image(image)
            assert secret not in out, name
            assert b"Exif" not in out and b"ICC_PROFILE" not in out and b"Photoshop" not in out, name
            with Image.open(io.BytesIO(out)) as img:
                assert img.format == "JPEG" and not img.getexif() and "icc_profile" not in img.info, name
                assert "comment" not in img.info, name
        assert clean_image(base) == clean_image(base)  # deterministic

    def test_large_images_are_downscaled_and_huge_ones_refused(self, make_client: Callable[..., TestClient]) -> None:
        for size, want in (((4000, 3000), (2000, 1500)), ((6000, 4500), (2000, 1500)), ((1200, 900), (1200, 900))):
            # Regression: a 6000x4500 JPEG went to the vision model as it was.
            with Image.open(io.BytesIO(clean_image(jpeg(size)))) as img:
                assert img.size == want
        rgba = Image.new("RGBA", (2500, 1000), (0, 0, 0, 0))
        out = io.BytesIO()
        rgba.save(out, "PNG")
        with Image.open(io.BytesIO(clean_image(out.getvalue()))) as img:
            assert img.size == (2000, 800) and img.mode == "RGB"
            assert img.getpixel((10, 10)) == (255, 255, 255)  # transparent becomes white paper
        # Regression: a 190 KB 7000x7000 PNG cost +375 MB to decode. Over 4096 x 4096
        # pixels an image is refused from its header, before decoding.
        bomb = Image.new("L", (5000, 4000))
        out = io.BytesIO()
        bomb.save(out, "PNG")
        assert len(out.getvalue()) < 200_000
        with pytest.raises(ApiError) as caught:
            clean_image(out.getvalue())
        assert caught.value.status_code == 400 and caught.value.code == "bad_image"
        assert_error(self.post(make_client(), out.getvalue()), 400, "bad_image")

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
        assert set(body) == {
            "mode", "heard_text", "result", "feedback", "quality", "say_again", "feedback_is_quran", "quran_parts",
            "brain",
        }
        assert body["feedback_is_quran"] is False and body["quran_parts"] == [] and body["brain"] == "claude"
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
        # 19 minutes of 8-bit audio at 8 kHz fits in 9 MB; decoding it would make 18 M samples.
        frames = 9_000_000
        header = (
            b"RIFF" + struct.pack("<I", 36 + frames) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 8000, 1, 8)
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
        assert set(body) == {"mode", "heard_text", "judgement", "feedback", "quality", "say_again", "brain"}
        assert body["mode"] == "contextual" and body["heard_text"] == "a cat was sitting" and body["brain"] == "claude"
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
        phrases = split_phrases(text, "fr")
        assert r.status_code == 200 and r.json() == {
            "phrases": phrases, "readers": ["voice"] * len(phrases), "read_text": [None] * len(phrases),
            "parts": [None] * len(phrases), "quran_parts": [],
        }

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

    def test_slow_speech_heard_with_digits_passes(self, make_client: Callable[..., TestClient]) -> None:
        # Regression: "twelve" heard as "12" failed the check after two syntheses.
        tts = FakeTTS()
        client = make_client(tts=tts, transcriber=RecordingTranscriber("The year has 12 months."))
        r = client.post("/api/tts", json={"text": "The year has twelve months.", "lang": "en", "slow": True})
        assert r.status_code == 200 and r.headers["x-speech-check"] == "passed" and len(tts.calls) == 1

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
    """POST /api/dictation/check (French defaults, with the AI consent; a None field is left out)."""
    data = {"expected_text": FR_TEXT, "lang": "fr", "age": "10-13", "ai_consent": CONSENT, **fields}
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
            "feedback_is_quran", "quran_parts", "brain",
        }
        assert body["brain"] == "claude"
        assert body["feedback_is_quran"] is False and body["quran_parts"] == []
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
        assert brain.called("read_handwriting") == [((clean_image(image), "fr"), {})]

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

    @pytest.mark.parametrize("multipart", [False, True], ids=["urlencoded", "multipart"])
    def test_line_breaks_come_back_as_a_textarea_holds_them(
        self, make_client: Callable[..., TestClient], quran: Quran, multipart: bool
    ) -> None:
        # Regression (final verification, P1): a browser sends the line breaks of a form
        # field as CRLF, while a textarea's value holds LF. read_text came back with CRLF,
        # so the client always saw an edited text and the result could not be confirmed.
        # The line breaks of every form text field are now LF, and so are read_text and
        # the offsets of the Quran parts (into the text the client holds).
        basmala = " ".join(quran_words(quran, 1, 1, 1))
        ayah = " ".join(quran_words(quran, 2, 153, 153))
        client = make_client()
        for text, lang in ((basmala + "\n" + lesson(quran), "ar"), ("The cat sat.\nIt was a sunny day.", "en")):
            for sent in (text.replace("\n", "\r\n"), text.replace("\n", "\r"), text):
                fields = {"expected_text": sent, "lang": lang, "age": "6-9", "written_text": sent}
                if multipart:
                    r = client.post("/api/dictation/check", files={k: (None, v) for k, v in fields.items()})
                else:
                    r = client.post("/api/dictation/check", data=fields)
                assert r.status_code == 200, r.text
                body = r.json()
                assert body["read_text"] == text and body["result"]["verdict"] == "correct"
                if lang == "ar":
                    assert [text[slice(*p["chars"])] for p in body["quran_parts"]] == [basmala, ayah]
                    assert [text[slice(*p["utf16"])] for p in body["quran_parts"]] == [basmala, ayah]  # no astral char
                else:
                    assert body["quran_parts"] == []
        # What a reader writes (a photo of the paper, a page) has LF line breaks too.
        brain = FakeBrain(handwriting={"text": "Le chat\r\ndort.", "uncertain_words": [], "legible": True})
        assert self.post(make_client(brain=brain), image=jpeg()).json()["read_text"] == "Le chat\ndort."
        brain = FakeBrain(page={"text": "Le chat\r\ndort.", "lang": "fr", "notes": "a\rb"})
        page = make_client(brain=brain).post(
            "/api/page/read", files={"image": ("p.jpg", jpeg(), "image/jpeg")}, data={"ai_consent": CONSENT}
        ).json()
        assert (page["text"], page["notes"]) == ("Le chat\ndort.", "a\nb")

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
        assert brain.called("read_handwriting") == [((clean_image(image), "fr"), {})]
        assert seen == []


# ---------------------------------------------------------------------------
# The AI consent (hard rule 5; docs/REWARDS.md, V6): the server takes part
# ---------------------------------------------------------------------------

#: Every endpoint whose handling can reach the Claude brain: (path, form fields, uploads, the
#: brain methods it calls with the consent).
CLAUDE_REQUESTS: dict[str, tuple[str, dict[str, str], Callable[[], dict], set[str]]] = {
    "recite strict": (
        "/api/recite/check",
        {"expected_text": EN_TEXT, "lang": "en", "mode": "strict", "age": "6-9"},
        lambda: {"audio": ("child.wav", wav(), "audio/wav")},
        {"word_feedback"},
    ),
    "recite by meaning": (
        "/api/recite/check",
        {"expected_text": EN_TEXT, "lang": "en", "mode": "contextual", "age": "10-13"},
        lambda: {"audio": ("child.wav", wav(), "audio/wav")},
        {"judge_meaning"},
    ),
    "dictation typed": (
        "/api/dictation/check",
        {"expected_text": FR_TEXT, "lang": "fr", "age": "10-13", "written_text": "Le chat dor sur le tapis."},
        lambda: {},
        {"word_feedback"},
    ),
    "dictation photo": (
        "/api/dictation/check",
        {"expected_text": FR_TEXT, "lang": "fr", "age": "10-13"},
        lambda: {"image": ("writing.jpg", jpeg(), "image/jpeg")},
        {"read_handwriting", "word_feedback"},
    ),
    "page photo": ("/api/page/read", {"lang": "fr"}, lambda: {"image": ("page.jpg", jpeg(), "image/jpeg")}, {"read_page"}),
}

#: Requests that do not carry the consent: (extra form fields, extra uploads, query string).
#: Only a form field ai_consent whose every copy is exactly "1" is the consent.
NO_CONSENT: dict[str, tuple[dict[str, Any], dict[str, Any], str]] = {
    "no field (an older client)": ({}, {}, ""),
    "0": ({"ai_consent": "0"}, {}, ""),
    "true": ({"ai_consent": "true"}, {}, ""),
    "empty": ({"ai_consent": ""}, {}, ""),
    "1 with spaces": ({"ai_consent": " 1 "}, {}, ""),
    "query string only": ({}, {}, "?ai_consent=1"),
    "1 then 0": ({"ai_consent": ["1", "0"]}, {}, ""),
    "0 then 1": ({"ai_consent": ["0", "1"]}, {}, ""),
    "1 then empty": ({"ai_consent": ["1", ""]}, {}, ""),
    "a file part": ({}, {"ai_consent": ("consent.txt", b"1", "text/plain")}, ""),
}


def claude_request(
    client: TestClient, kind: str, data: dict[str, Any] | None = None, files: dict[str, Any] | None = None, query: str = ""
) -> Any:
    """One of :data:`CLAUDE_REQUESTS`, with extra form fields, uploads or a query string."""
    path, fields, uploads, _ = CLAUDE_REQUESTS[kind]
    all_files = {**uploads(), **(files or {})}
    return client.post(path + query, data={**fields, **(data or {})}, files=all_files or None)


class TestAiConsent:
    """Claude is used for a request only when the request says that the parent agreed:
    the form field ``ai_consent=1`` (``app.ai_consent_given``). Without it the request is
    answered exactly as by a server without Claude, and the Claude brain is never called,
    whatever the web client did (a server started again with Claude after the page's last
    /api/health, a tab with an older app.js, any other client)."""

    @staticmethod
    def offline_answer(make_client: Callable[..., TestClient], kind: str) -> tuple[int, Any]:
        client = make_client(transcriber=RecordingTranscriber("the cat sat on mat"), brain=OfflineBrain())
        r = claude_request(client, kind)
        return r.status_code, r.json()

    @pytest.mark.parametrize("how", list(NO_CONSENT))
    @pytest.mark.parametrize("kind", list(CLAUDE_REQUESTS))
    def test_without_the_consent_claude_is_never_called(
        self, make_client: Callable[..., TestClient], kind: str, how: str
    ) -> None:
        brain = FakeBrain()
        client = make_client(transcriber=RecordingTranscriber("the cat sat on mat"), brain=brain)
        data, files, query = NO_CONSENT[how]
        r = claude_request(client, kind, data, files, query)
        assert brain.calls == []
        assert (r.status_code, r.json()) == self.offline_answer(make_client, kind)
        if r.status_code == 200:
            assert r.json()["brain"] == "offline"
        assert client.get("/api/health").json()["brain"] == "claude"  # the server has Claude all the same

    @pytest.mark.parametrize("consent", ["1", ["1", "1"]], ids=["1", "1 twice"])
    @pytest.mark.parametrize("kind", list(CLAUDE_REQUESTS))
    def test_the_consent_lets_claude_answer(self, make_client: Callable[..., TestClient], kind: str, consent: Any) -> None:
        brain = FakeBrain()
        client = make_client(transcriber=RecordingTranscriber("the cat sat on mat"), brain=brain)
        r = claude_request(client, kind, {"ai_consent": consent})
        assert r.status_code == 200, r.text
        assert r.json()["brain"] == "claude"
        assert {m for m, _, _ in brain.calls} == CLAUDE_REQUESTS[kind][3]
        assert (r.status_code, r.json()) != self.offline_answer(make_client, kind)

    def test_what_claude_answered_and_what_the_offline_brain_did(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client(transcriber=RecordingTranscriber("the cat sat on mat"), brain=FakeBrain())
        strict = claude_request(client, "recite strict", {"ai_consent": "1"}).json()
        assert strict["feedback"] == "Lovely effort, keep going!"
        offline = claude_request(client, "recite strict").json()
        assert offline["result"] == strict["result"]  # the words are decided by code (hard rule 2)
        assert offline["feedback"] == feedback.for_result(CheckResult(**{
            **offline["result"], "ops": [Op(**op) for op in offline["result"]["ops"]],
        }), "en", "6-9", activity="recitation")
        # By meaning without Claude: the offline heuristic, marked approximate for the "approximate" note.
        meaning = claude_request(client, "recite by meaning").json()
        assert meaning["brain"] == "offline" and meaning["judgement"]["approximate"] is True
        assert "approximate" not in claude_request(client, "recite by meaning", {"ai_consent": "1"}).json()["judgement"]
        page = claude_request(client, "page photo").json()
        assert (page["source"], page["needs_manual"], page["text"], page["brain"]) == ("offline", True, "", "offline")
        assert_error(claude_request(client, "dictation photo"), 501, "needs_manual")

    @pytest.mark.parametrize("kind", list(CLAUDE_REQUESTS))
    def test_a_server_without_claude_ignores_the_field(self, make_client: Callable[..., TestClient], kind: str) -> None:
        client = make_client(transcriber=RecordingTranscriber("the cat sat on mat"), brain=OfflineBrain())
        r = claude_request(client, kind, {"ai_consent": "1"})
        assert (r.status_code, r.json()) == self.offline_answer(make_client, kind)

    def test_multipart_and_urlencoded_bodies(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        client = make_client(brain=brain)
        _, fields, _, _ = CLAUDE_REQUESTS["dictation typed"]
        for consent, want in (("1", "claude"), ("0", "offline")):
            sent = {**fields, "ai_consent": consent}
            for body in ({"data": sent}, {"files": {k: (None, v) for k, v in sent.items()}}):  # urlencoded, multipart
                assert client.post("/api/dictation/check", **body).json()["brain"] == want
        assert len(brain.called("word_feedback")) == 2

    def test_the_log_names_the_brain_never_the_text_or_the_age_group(
        self, make_client: Callable[..., TestClient], caplog: pytest.LogCaptureFixture
    ) -> None:
        client = make_client(transcriber=RecordingTranscriber("the cat sat on mat"), brain=FakeBrain())
        with caplog.at_level(logging.DEBUG):
            for kind in CLAUDE_REQUESTS:
                for consent in ("1", None):
                    claude_request(client, kind, {"ai_consent": consent, "age": "14-18"} if consent else {"age": "14-18"})
        for line in ("recite/check strict en: brain claude", "recite/check contextual en: brain offline",
                     "dictation/check fr: brain claude", "dictation/check fr: brain offline",
                     "page/read: image", "brain claude, source claude", "brain offline, source offline"):
            assert line in caplog.text, line
        for secret in ("14-18", "cat", "chat", "tapis", "Lovely effort"):
            assert secret not in caplog.text, secret

    def test_the_published_schema_lists_the_field_and_the_brain(self, make_client: Callable[..., TestClient]) -> None:
        """RA-5: a client built from /api/openapi.json learns of the opt-in field and of
        the answer's "brain", on exactly the endpoints that can reach Claude, and the
        field is optional there (the schema only describes it: requests are read as
        before, by ai_consent_given)."""
        brain = FakeBrain()
        client = make_client(brain=brain)
        spec = client.get("/api/openapi.json").json()
        schemas = spec["components"]["schemas"]
        with_field, with_brain = set(), set()
        for path, operations in spec["paths"].items():
            for method, operation in operations.items():
                for media in operation.get("requestBody", {}).get("content", {}).values():
                    body = media["schema"]
                    if "$ref" in body:
                        body = schemas[body["$ref"].rsplit("/", 1)[1]]
                    field = body.get("properties", {}).get("ai_consent")
                    if field is not None:
                        with_field.add(path)
                        assert field["type"] == "string"
                        assert '"1"' in field["description"] and "query string" in field["description"]
                        assert "ai_consent" not in body.get("required", [])
                for media in operation.get("responses", {}).get("200", {}).get("content", {}).values():
                    answer = media["schema"].get("properties", {}).get("brain")
                    if answer is not None:
                        with_brain.add(path)
                        assert answer["enum"] == ["claude", "offline"]
                        assert "brain" in media["schema"]["required"]
        claude_paths = {path for path, _, _, _ in CLAUDE_REQUESTS.values()}
        assert with_field == with_brain == claude_paths == {"/api/page/read", "/api/recite/check", "/api/dictation/check"}
        # Asking twice gives the same schema (it is made once), and the requests still read
        # the field as before: "1" twice is the consent, "1" beside "0" is not.
        assert client.get("/api/openapi.json").json() == spec
        assert claude_request(client, "dictation typed", {"ai_consent": ["1", "1"]}).json()["brain"] == "claude"
        assert claude_request(client, "dictation typed", {"ai_consent": ["1", "0"]}).json()["brain"] == "offline"
        assert len(brain.called("word_feedback")) == 1


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
            fields = {"expected_text": text, "lang": "ar", "age": "6-9", "written_text": text, "ai_consent": CONSENT}
            assert_error(client.post("/api/dictation/check", data=fields), 422, "quran_text")
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
            fields = {"expected_text": "Quixotic zebras", "lang": "en", "age": "6-9", "written_text": written}
            for consent in (CONSENT, None):  # the fake Claude brain, then the offline one
                data = {**fields, "ai_consent": consent} if consent else fields
                assert client.post("/api/dictation/check", data=data).status_code == 200
            assert client.post("/api/tts", json={"text": "Quixotic zebras", "lang": "en", "slow": True}).status_code == 200
            page = {"image": ("p.jpg", jpeg())}
            assert client.post("/api/page/read", files=page, data={"ai_consent": CONSENT}).status_code == 200
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
        client = TestClient(build_default_app(), base_url=BASE_URL)
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
        client = TestClient(build_default_app(), base_url=BASE_URL)
        body = client.get("/api/health").json()
        assert body["quran"] is True and body["brain"] == "offline"
        assert body["asr"] is (ROOT / "models" / "sherpa-onnx-whisper-small" / "small-encoder.int8.onnx").is_file()
        assert client.get("/").status_code == 200
        # Logging is configured once, however many apps are built.
        build_default_app()
        assert len(logging.getLogger("mommy").handlers) == 1


# ---------------------------------------------------------------------------
# Review fixes: host and origin, wrong language, [?], limits, Quran guard, feedback
# ---------------------------------------------------------------------------


class TestHostAndOrigin:
    def test_unknown_host_is_refused(self, make_client: Callable[..., TestClient]) -> None:
        # Regression: a DNS-rebinding page (any Host header) reached the API that holds the Claude key.
        client = make_client(brain=FakeBrain())
        for path in ("/api/health", "/"):
            r = client.get(path, headers={"Host": "rebind.attacker.example:8080"})
            assert r.status_code == 400 and r.json()["error"] == "bad_host"
        r = client.post("/api/page/read", files={"image": ("p.jpg", jpeg())}, headers={"Host": "evil.example"})
        assert r.status_code == 400
        for host in ("127.0.0.1:8080", "localhost:8095", "[::1]:8080", "LOCALHOST"):
            assert client.get("/api/health", headers={"Host": host}).status_code == 200, host

    def test_cross_origin_writes_are_refused(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        client = make_client(brain=brain)
        r = client.post("/api/page/read", files={"image": ("p.jpg", jpeg())}, headers={"Origin": "http://evil.example"})
        assert_error(r, 403, "bad_origin")
        r = client.post("/api/tts", json={"text": "hello", "lang": "en"}, headers={"Origin": "null"})
        assert_error(r, 403, "bad_origin")
        assert brain.calls == []
        # The page itself (same origin), and clients that send no Origin, are accepted.
        same = client.post("/api/page/read", files={"image": ("p.jpg", jpeg())}, headers={"Origin": BASE_URL})
        assert same.status_code == 200
        assert client.post("/api/tts", json={"text": "hello", "lang": "en"}).status_code == 200
        # Reads are not writes.
        assert client.get("/api/health", headers={"Origin": "http://evil.example"}).status_code == 200

    def test_allowed_hosts_come_from_the_settings(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client(settings=make_settings(allowed_hosts=("tutor.local",)))
        assert client.get("/api/health", headers={"Host": "tutor.local:8080"}).status_code == 200
        assert client.get("/api/health").status_code == 400  # 127.0.0.1 is not listed here

    def test_pages_cannot_be_framed(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        for path in ("/", "/api/health"):
            r = client.get(path)
            assert r.headers["x-frame-options"] == "DENY"
            assert r.headers["content-security-policy"] == "frame-ancestors 'none'"


class TestLanguageMismatch:
    AR = "ذهب الولد إلى المدرسة"

    def test_arabic_text_with_another_language_is_refused(self, make_client: Callable[..., TestClient]) -> None:
        # Regression: with lang=en the recogniser translated Arabic speech into English,
        # and the child was told the recording was unclear.
        transcriber, tts, brain = RecordingTranscriber("The boy went to school."), FakeTTS(), FakeBrain()
        client = make_client(transcriber=transcriber, tts=tts, brain=brain)
        for lang in ("en", "fr"):
            assert_error(recite(client, expected_text=self.AR, lang=lang), 422, "lang_mismatch")
            assert_error(client.post("/api/dictation/phrases", json={"text": self.AR, "lang": lang}), 422, "lang_mismatch")
            assert_error(client.post("/api/tts", json={"text": "مرحبا", "lang": lang}), 422, "lang_mismatch")
            r = check_dictation(client, expected_text=self.AR, lang=lang, written_text=self.AR)
            assert_error(r, 422, "lang_mismatch")
        assert transcriber.calls == [] and tts.calls == [] and brain.calls == []

    def test_latin_text_with_arabic_is_refused(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        assert_error(recite(client, expected_text=EN_TEXT, lang="ar"), 422, "lang_mismatch")
        assert_error(client.post("/api/tts", json={"text": "Hello", "lang": "ar"}), 422, "lang_mismatch")

    def test_matching_and_mixed_texts_are_accepted(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client(transcriber=RecordingTranscriber("the word salam means peace"))
        assert recite(client, expected_text="The word سلام means peace", lang="en").status_code == 200
        assert client.post("/api/tts", json={"text": "١٢", "lang": "en"}).status_code == 200  # digits only
        assert client.post("/api/tts", json={"text": "مرحبا Ali", "lang": "ar"}).status_code == 200


class TestUnreadableWords:
    def test_unreadable_handwriting_is_not_a_skipped_word(self, make_client: Callable[..., TestClient]) -> None:
        # Regression: "[?]" was dropped, so the child was told they forgot "dort".
        brain = FakeBrain(handwriting={"text": "Le chat [?] sur le tapis.", "uncertain_words": [], "legible": True})
        body = check_dictation(make_client(brain=brain), image=jpeg(), expected_text=FR_TEXT, age="6-9").json()
        ops = [(op["kind"], op["expected"], op["heard"]) for op in body["result"]["ops"] if op["kind"] != "match"]
        assert ops == [("sub", "dort", "[?]")]
        assert body["result"]["n_unreadable"] == 1 and body["uncertain_words"] == ["[?]"]
        assert body["feedback"] == feedback.unreadable("fr", "6-9")
        assert "dort" not in body["feedback"] and "oublié" not in body["feedback"]
        assert brain.called("word_feedback") == []  # nothing for the model to word

    def test_text_with_unreadable_marks_is_refused_until_typed(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        text = "Le chat [?] sur le tapis."
        assert_error(recite(client, expected_text=text, lang="fr"), 400, "unreadable_text")
        assert_error(client.post("/api/dictation/phrases", json={"text": text, "lang": "fr"}), 400, "unreadable_text")
        assert_error(client.post("/api/tts", json={"text": text, "lang": "fr"}), 400, "unreadable_text")
        assert_error(check_dictation(client, expected_text=text, written_text="Le chat"), 400, "unreadable_text")

    def test_page_read_counts_the_marks(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain(page={"text": "Le chat [?] sur le [ ? ].", "lang": "fr", "notes": "", "contains_quran": False})
        r = make_client(brain=brain).post("/api/page/read", files={"image": ("p.jpg", jpeg())}, data={"ai_consent": CONSENT})
        assert r.json()["unreadable_marks"] == 2 and r.json()["text"] == "Le chat [?] sur le [ ? ]."


class TestTextLimits:
    def test_too_many_words_are_refused(self, make_client: Callable[..., TestClient]) -> None:
        # Regression: 10,000 one-letter words on each side cost about 0.9 GB to align.
        client = make_client()
        many = " ".join("a" for _ in range(MAX_TEXT_WORDS + 1))
        assert len(many) < MAX_TEXT_CHARS
        assert_error(check_dictation(client, expected_text=many, lang="en", written_text="a"), 400, "text_too_long")
        assert_error(check_dictation(client, expected_text="a b", lang="en", written_text=many), 400, "text_too_long")
        assert_error(recite(client, expected_text=many), 400, "text_too_long")
        ok = " ".join("a" for _ in range(MAX_TEXT_WORDS))
        assert check_dictation(client, expected_text=ok, lang="en", written_text=ok).status_code == 200

    @pytest.mark.parametrize("bad", ["Le chat \ud83d dort.", "\udc00"])
    def test_lone_surrogates_are_bad_text(self, make_client: Callable[..., TestClient], bad: str) -> None:
        # Regression: a lone UTF-16 surrogate in JSON gave a 500 on /api/dictation/phrases.
        client = make_client()
        body = json.dumps({"text": bad, "lang": "fr"})  # ensure_ascii keeps "\ud83d" as an escape
        headers = {"content-type": "application/json"}
        assert_error(client.post("/api/dictation/phrases", content=body, headers=headers), 400, "bad_text")
        assert_error(client.post("/api/tts", content=body, headers=headers), 400, "bad_text")

    def test_model_output_with_a_surrogate_does_not_fail(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain(page={"text": "Le chat \ud83d dort.", "lang": "fr", "notes": "", "contains_quran": False})
        r = make_client(brain=brain).post("/api/page/read", files={"image": ("p.jpg", jpeg())}, data={"ai_consent": CONSENT})
        assert r.status_code == 200 and r.json()["text"] == "Le chat � dort."

    def test_concurrent_decodes_are_bounded(
        self, make_client: Callable[..., TestClient], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Regression: six 190 KB image bombs at once took the server from 0.9 to 3.2 GB.
        import threading as _threading

        monkeypatch.setattr(app_mod, "MAX_CONCURRENT_DECODES", 1)
        monkeypatch.setattr(app_mod, "BUSY_TIMEOUT_S", 0.05)
        entered, release = _threading.Event(), _threading.Event()
        real = app_mod.clean_image

        def slow_clean(data: bytes) -> bytes:
            entered.set()
            release.wait(5)
            return real(data)

        monkeypatch.setattr(app_mod, "clean_image", slow_clean)
        client = make_client(brain=FakeBrain())
        results: list[int] = []
        first = _threading.Thread(
            target=lambda: results.append(client.post("/api/page/read", files={"image": ("p.jpg", jpeg())}).status_code)
        )
        first.start()
        assert entered.wait(5)
        busy = client.post("/api/page/read", files={"image": ("p.jpg", jpeg())})
        release.set()
        first.join(5)
        assert_error(busy, 503, "busy")
        assert results == [200]


class TestQuranGuardCannotBeBypassed:
    def test_closing_formula_or_framing_does_not_hide_an_ayah(
        self, make_client: Callable[..., TestClient], quran: Quran
    ) -> None:
        # Regression: Surah 112 + "صدق الله العظيم" scored 15/18 = 0.83 < 0.9 and was
        # accepted, so its phrases were spoken and the whole surah reached judge_meaning.
        # A text that is Quran with its framing (Q1) is refused everywhere.
        surah = " ".join(quran_words(quran, 112, 1, 4))
        brain, tts = ExplodingBrain(), ExplodingTTS()
        client = make_client(brain=brain, tts=tts, transcriber=RecordingTranscriber(surah))
        texts = [
            surah + " صدق الله العظيم",
            "قال الله تعالى في سورة الإخلاص: " + surah,
            "أعوذ بالله من الشيطان الرجيم " + surah,
            "سورة الإخلاص\n" + " ".join(f"{w} ({i})" for i, w in enumerate(surah.split(), 1)),
        ]
        for text in texts:
            body = assert_error(client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"}), 422, "quran_text")
            if "(" not in text:
                assert body["quran_range"] == {"surah": 112, "from": 1, "to": 4}
            for mode in ("strict", "contextual"):
                assert_error(recite(client, expected_text=text, lang="ar", mode=mode), 422, "quran_text")
            assert_error(check_dictation(client, expected_text=text, lang="ar", written_text=text), 422, "quran_text")
            for mode in ("strict", "contextual", "dictation"):
                assert_error(text_check(client, text, "ar", mode), 422, "quran_text")
        assert brain.calls == [] and tts.calls == []

    def test_a_lesson_that_quotes_a_surah_is_a_school_text(
        self, make_client: Callable[..., TestClient], quran: Quran
    ) -> None:
        # Q2: the quoted surah is a Quran part. Recited word by word, dictated with a
        # grown-up reading it, never judged by meaning and never given to the voice.
        surah = " ".join(quran_words(quran, 112, 1, 4))
        tts = ExplodingTTS()
        client = make_client(tts=tts, brain=ExplodingBrain())
        lessons = [
            "قال الله تعالى في سورة الإخلاص: " + surah + ". تعلمنا هذه السورة في المدرسة.",
            "تعلمنا في المدرسة اليوم: " + surah + " ثم عدنا إلى البيت.",
        ]
        for text in lessons:
            assert looks_like_quran(text, quran)  # the voice's guard sees the surah, as before
            body = client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"}).json()
            assert body["readers"].count("grown_up") == 4  # one chunk per ayah
            for phrase, reader, read in zip(body["phrases"], body["readers"], body["read_text"]):
                assert (reader == "grown_up") == is_quran_phrase(phrase, quran), phrase
                assert (read is not None) == (reader == "grown_up")
            [part] = body["quran_parts"]
            assert (part["surah"], part["ayah_from"], part["ayah_to"], part["whole"]) == (112, 1, 4, True)
            assert_error(recite(client, expected_text=text, lang="ar", mode="contextual"), 422, "quran_text")
            checked = text_check(client, text, "ar").json()
            assert checked["dictation"] is True and checked["contextual"] is False
        assert tts.calls == []

    def test_short_quran_phrases_are_not_spoken(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        tts = ExplodingTTS()
        client = make_client(tts=tts)
        last = quran_words(quran, 112, 4, 4)
        phrases = [
            " ".join(quran_words(quran, 112, 2, 2)),  # a whole two-word ayah
            " ".join(last[2:]) + " صدق الله العظيم",  # an ayah's end with the closing formula
            "قال تعالى: " + " ".join(last[2:]),
        ]
        for phrase in phrases:
            assert is_quran_phrase(phrase, quran), phrase
            assert_error(client.post("/api/tts", json={"text": phrase, "lang": "ar", "slow": True}), 422, "quran_text")
        assert tts.calls == []

    def test_ordinary_school_arabic_is_still_accepted(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        texts = [
            AR_TEXT,
            "قال المعلم للتلاميذ إن العلم نور والجهل ظلام",
            "في يوم من الأيام خرج الأطفال إلى الحديقة ليلعبوا",
            "السلام عليكم ورحمة الله وبركاته",
        ]
        client = make_client(tts=FakeTTS())
        for text in texts:
            assert not looks_like_quran(text, quran), text
            assert client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"}).status_code == 200, text
            for phrase in split_phrases(text, "ar"):
                assert client.post("/api/tts", json={"text": phrase, "lang": "ar"}).status_code == 200, phrase

    def test_a_whole_ayah_inside_a_sentence_is_recited_but_not_spoken(
        self, make_client: Callable[..., TestClient], quran: Quran
    ) -> None:
        # These two were accepted for dictation until the contained-ayah rule: the
        # voice spoke the basmala (1:1) and 1:2 as part of a longer phrase. Now the ayah
        # is a Quran part that a grown-up reads; the voice still refuses it.
        texts = [
            " ".join(quran_words(quran, 1, 1, 1)) + " ذهبت مع أبي إلى السوق واشترينا الخبز",
            " ".join(quran_words(quran, 1, 2, 2)) + " والصلاة والسلام على رسول الله",
        ]
        tts = ExplodingTTS()
        client = make_client(tts=tts, transcriber=RecordingTranscriber(texts[0]))
        for text, ayah in zip(texts, (1, 2)):
            assert not app_mod.find_quran_parts(text, "ar", quran).is_quran, text
            assert recite(client, expected_text=text, lang="ar").status_code == 200
            body = client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"}).json()
            assert body["readers"][0] == "grown_up" and body["phrases"][0] == " ".join(quran_words(quran, 1, ayah, ayah))
            assert body["read_text"][0] == quran.ayat(1, ayah, ayah)[0].display
            assert set(body["readers"][1:]) == {"voice"}
            assert_error(client.post("/api/tts", json={"text": split_phrases(text, "ar")[0], "lang": "ar"}), 422, "quran_text")
        assert tts.calls == []

    def test_a_basmala_on_its_own_line_is_read_by_a_grown_up(
        self, make_client: Callable[..., TestClient], quran: Quran
    ) -> None:
        # Regression (final verification): a school text whose basmala is a phrase of its
        # own was refused by /api/dictation/phrases with the same answer as a Quran text.
        # It was then refused with scope "phrase" (reciting only); now it is dictated, with
        # a grown-up reading the basmala from the mushaf text.
        story = "ذهب الولد إلى المدرسة مع أخيه صباحا."
        texts = [
            "بسم الله الرحمن الرحيم. " + story,
            "بسم الله الرحمن الرحيم\n\n" + story,
            "بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ، " + story,
        ]
        tts = ExplodingTTS()
        client = make_client(tts=tts, transcriber=RecordingTranscriber(story))
        for text in texts:
            res = client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"})
            assert res.status_code == 200, text
            body = res.json()
            assert body["readers"] == ["grown_up", "voice", "voice"]
            assert body["phrases"][0] == quran.basmala_match and body["read_text"][0] == quran.basmala_display
            assert body["parts"] == [0, None, None] and len(body["quran_parts"]) == 1
            assert recite(client, expected_text=text, lang="ar").status_code == 200
            written = check_dictation(client, expected_text=text, lang="ar", written_text=story)
            assert written.status_code == 200
        # A Quran text keeps the plain refusal (no scope): it may not be recited either.
        surah = " ".join(quran_words(quran, 112, 1, 4))
        body = assert_error(client.post("/api/dictation/phrases", json={"text": surah, "lang": "ar"}), 422, "quran_text")
        assert "scope" not in body
        assert tts.calls == []


class TestFeedbackMatchesTheResult:
    def test_misspelled_dictation_is_not_told_to_speak_louder(self, make_client: Callable[..., TestClient]) -> None:
        # Regression: "Le cha dor." gave verdict unclear and "say it again, louder".
        client = make_client(brain=OfflineBrain())
        body = check_dictation(client, expected_text="Le chat dort.", age="6-9", written_text="Le cha dor.").json()
        assert body["result"]["verdict"] == "mistakes" and body["result"]["say_again"] is False
        assert body["feedback"] == feedback.point_out("fr", "6-9", "chat", "sub", n_errors=2)
        assert "fort" not in body["feedback"]

    def test_partial_recitation_is_told_where_it_stopped(self, make_client: Callable[..., TestClient]) -> None:
        text = "The little cat sat on the warm mat near the door."
        client = make_client(transcriber=RecordingTranscriber("The little cat"), brain=OfflineBrain())
        body = recite(client, expected_text=text).json()
        assert body["say_again"] is False and body["result"]["verdict"] == "mistakes"
        assert body["result"]["stopped_at_exp_index"] == 3
        assert body["feedback"] == feedback.stopped("en", "6-9", "sat")

    def test_clear_but_different_speech_is_not_told_to_speak_louder(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client(transcriber=RecordingTranscriber("alpha beta gamma delta epsilon"), brain=OfflineBrain())
        body = recite(client, expected_text="one two three four five").json()
        assert body["say_again"] is True and body["result"]["say_again_reason"] == "error_rate"
        assert body["feedback"] == feedback.say_again("en", "6-9", "error_rate")

    def test_quran_partial_recitation_is_told_where_it_stopped(
        self, make_client: Callable[..., TestClient], quran: Quran
    ) -> None:
        heard = " ".join(quran_words(quran, 78, 1, 3))
        client = make_client(transcriber=RecordingTranscriber(heard))
        body = client.post("/api/quran/check", data={"surah": 78, "from": 1, "to": 10}, files={"audio": ("q.wav", wav())}).json()
        word = quran.ayat(78, 4, 4)[0].display_words[0]
        assert body["verdict"] == "mistakes" and body["stopped_at"]["expected_display_word"] == word
        assert body["feedback"] == feedback.quran_feedback("stopped", word)

    def test_contextual_mode_never_uses_strict_praise(self, make_client: Callable[..., TestClient]) -> None:
        praise = {feedback.praise(lang, age, k) for lang in ("ar", "en", "fr") for age in feedback.AGE_BANDS for k in range(3)}
        cases = [
            ("en", "Plants need sunlight to grow. The sun gives us light and heat.",
             "The sun gives light and warmth, and plants need it to grow."),
            ("fr", "Le petit chat joue dans le jardin.", "Le petit chat joue dans le jardin."),
            ("ar", "ذهب الولد إلى المدرسة", "ذهب الولد إلى المدرسة"),
        ]
        for lang, expected, heard in cases:
            client = make_client(transcriber=RecordingTranscriber(heard), brain=OfflineBrain())
            for age in feedback.AGE_BANDS:
                body = recite(client, expected_text=expected, lang=lang, mode="contextual", age=age).json()
                assert body["feedback"] not in praise
                if body["judgement"]["missing_ideas"]:
                    assert body["judgement"]["missing_ideas"][0] in body["feedback"]


class TestHealthReportsTheModelInUse:
    def test_asr_model_is_the_one_loaded(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("x")
        transcriber.model = "small"  # type: ignore[attr-defined]
        r = make_client(transcriber=transcriber, settings=make_settings(asr_model="turbo")).get("/api/health")
        assert r.json()["asr_model"] == "small"
        assert make_client(settings=make_settings(asr_model="turbo")).get("/api/health").json()["asr_model"] == "turbo"


# ---------------------------------------------------------------------------
# The voice guard: a whole short ayah inside a phrase (contained-ayah rule)
# ---------------------------------------------------------------------------


def contained_examples(quran: Quran) -> list[str]:
    """Phrases that hold a whole short ayah plus other words (112:1, 1:2, 1:4), which
    the voice spoke before the contained-ayah rule."""
    return [
        " ".join(quran_words(quran, 112, 1, 1)) + " يا أحمد",
        "أخيها " + " ".join(quran_words(quran, 1, 2, 2)),
        "ذهبت سلمى " + " ".join(quran_words(quran, 1, 4, 4)),
    ]


class TestContainedAyahIsNotSpoken:
    def test_the_examples_were_accepted_before(self, quran: Quran) -> None:
        for text in contained_examples(quran):
            assert not looks_like_quran(text, quran) and not app_mod.is_whole_ayah(text, quran), text
            assert app_mod.contains_short_ayah(text, quran) and is_quran_phrase(text, quran), text

    def test_tts_refuses_them(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        tts = ExplodingTTS()
        client = make_client(tts=tts)
        for text in contained_examples(quran):
            for slow in (False, True):
                assert_error(client.post("/api/tts", json={"text": text, "lang": "ar", "slow": slow}), 422, "quran_text")
        assert tts.calls == []

    def test_an_ordinary_two_word_ayah_is_still_spoken(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        text = " ".join(quran_words(quran, 74, 21, 21)) + " إلى السماء"
        assert text == "ثم نظر إلى السماء"
        tts = FakeTTS()
        assert make_client(tts=tts).post("/api/tts", json={"text": text, "lang": "ar"}).status_code == 200
        assert tts.calls == [(text, "ar", False)]

    def test_dictation_has_a_grown_up_read_them(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        client = make_client(tts=ExplodingTTS())
        for text, (surah, ayah) in zip(contained_examples(quran), ((112, 1), (1, 2), (1, 4))):
            r = client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"})
            assert r.status_code == 200, text
            body = r.json()
            grown = [i for i, reader in enumerate(body["readers"]) if reader == "grown_up"]
            assert [body["phrases"][i] for i in grown] == [" ".join(quran_words(quran, surah, ayah, ayah))]
            assert [body["read_text"][i] for i in grown] == [quran.ayat(surah, ayah, ayah)[0].display]
            checked = client.post("/api/text/check", json={"text": text, "lang": "ar"}).json()
            assert {k: checked[k] for k in ("ok", "words", "dictation", "contextual")} == {
                "ok": True, "words": len(text.split()), "dictation": True, "contextual": False,
            }
            assert [(p["surah"], p["ayah_from"], p["rule"]) for p in checked["quran_parts"]] == [(surah, ayah, "contained")]

    def test_recitation_is_word_by_word_only(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        # Word by word, a sentence with a short ayah is recited and checked as before. By
        # meaning it is refused (the brain never judges an ayah).
        brain = FakeBrain()
        for text in contained_examples(quran):
            client = make_client(transcriber=RecordingTranscriber(text), brain=brain)
            body = recite(client, expected_text=text, lang="ar").json()
            assert body["result"]["verdict"] == "correct"
            assert app_mod.looks_like_quran_for_meaning(text, quran)
            assert_error(recite(client, expected_text=text, lang="ar", mode="contextual"), 422, "quran_text")
        assert brain.called("judge_meaning") == []
        # A two-word ayah that the comma cut into a phrase of its own stays ordinary words
        # (the decision of 2026-11-11, RL-5): the dictation joins it with the phrase before
        # it, which the voice accepts, and the sentence is recited either way.
        text = "الصيف بعيد، " + " ".join(quran_words(quran, 70, 7, 7)) + "."
        client = make_client(transcriber=RecordingTranscriber(text), brain=FakeBrain())
        body = client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"}).json()
        assert body["readers"] == ["voice"] and body["phrases"] == [text]
        assert not app_mod.is_quran_phrase(body["phrases"][0], quran)
        assert client.post("/api/tts", json={"text": body["phrases"][0], "lang": "ar"}).status_code == 200
        assert recite(client, expected_text=text, lang="ar").status_code == 200
        assert recite(client, expected_text=text, lang="ar", mode="contextual").status_code == 200

    def test_a_basmala_line_without_a_full_stop(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        # Regression: the splitter joins the lines of a paragraph, so the basmala on a
        # line of its own reached the phrases glued to the next word. It is a Quran part,
        # cut apart from the next line and read by a grown-up.
        basmala = " ".join(quran_words(quran, 1, 1, 1))
        story = "ذهب الولد إلى المدرسة مع أخيه صباحا"
        text = basmala + "\n" + story
        assert split_phrases(text, "ar")[0].startswith(basmala + " ")
        client = make_client(tts=ExplodingTTS(), transcriber=RecordingTranscriber(story))
        r = client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"})
        assert r.status_code == 200
        assert r.json()["phrases"] == [basmala, *split_phrases(story, "ar")]
        assert r.json()["readers"] == ["grown_up", "voice", "voice"]
        assert client.post("/api/text/check", json={"text": text, "lang": "ar"}).json()["dictation"] is True
        assert recite(client, expected_text=text, lang="ar").status_code == 200

    def test_an_ayah_cut_between_two_phrases(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        # The splitter caps phrases at six words; a short ayah cut in two would still be
        # read out in full, one phrase after the other. It is one Quran part.
        ayah = quran_words(quran, 1, 4, 4)
        text = "ذهبنا إلى السوق " + ayah[0] + "\n" + " ".join(ayah[1:]) + " ثم عدنا"
        phrases = split_phrases(text, "ar")
        assert not any(is_quran_phrase(p, quran) for p in phrases)
        r = make_client().post("/api/dictation/phrases", json={"text": text, "lang": "ar"})
        assert r.status_code == 200
        body = r.json()
        assert body["phrases"] == ["ذهبنا إلى السوق", " ".join(ayah), "ثم عدنا"]
        assert body["readers"] == ["voice", "grown_up", "voice"]


# ---------------------------------------------------------------------------
# POST /api/text/check
# ---------------------------------------------------------------------------


def text_check(client: TestClient, text: Any = AR_TEXT, lang: Any = "ar", mode: Any = "-", **kwargs: Any) -> Any:
    body: dict[str, Any] = {"text": text, "lang": lang}
    if mode != "-":
        body["mode"] = mode
    return client.post("/api/text/check", json={k: v for k, v in body.items() if v is not ...}, **kwargs)


class TestTextCheck:
    KEYS = {"ok", "words", "dictation", "contextual", "quran_parts", "mushaf_text"}

    def test_ordinary_texts(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        for text, lang in ((EN_TEXT, "en"), (FR_TEXT, "fr"), (AR_TEXT, "ar"), ("Le chat dort.\nIl fait beau.", "fr")):
            for mode in ("-", None, "strict", "contextual", "dictation"):
                r = text_check(client, text, lang, mode)
                assert r.status_code == 200, (text, mode)
                assert r.headers["content-type"] == "application/json; charset=utf-8"
                assert r.headers["cache-control"] == "no-store"
                assert r.json() == {
                    "ok": True, "words": len(app_mod.tokenize(text, lang)), "dictation": True, "contextual": True,
                    "quran_parts": [], "mushaf_text": text,
                }

    def test_words_count_the_cleaned_text(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        assert text_check(client, "  Le chat dort, l'école est fermée.  \n", "fr").json()["words"] == 6
        assert text_check(client, "عندي ٣٫٥ كتب", "ar").json()["words"] == 3

    def test_needs_no_recogniser_voice_or_brain(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        transcriber, tts, brain = RecordingTranscriber("x"), ExplodingTTS(), ExplodingBrain()
        client = make_client(transcriber=FakeTranscriber(available=False), tts=FakeTTS(available=False), brain=brain)
        assert text_check(client).status_code == 200
        client = make_client(transcriber=transcriber, tts=tts, brain=brain)
        texts = [AR_TEXT, *contained_examples(quran), " ".join(quran_words(quran, 112, 1, 4))]
        for text in texts:
            for mode in ("strict", "contextual", "dictation"):
                assert text_check(client, text, "ar", mode).status_code in (200, 422)
        assert transcriber.calls == [] and tts.calls == [] and brain.calls == []

    @pytest.mark.parametrize(
        ("text", "lang", "status", "code"),
        [
            ("", "en", 400, "empty_text"),
            (" \n\t ", "en", 400, "empty_text"),
            ("!!! ... ؟؟", "ar", 400, "empty_text"),
            ("mot " * (MAX_TEXT_CHARS // 4 + 1), "fr", 400, "text_too_long"),
            (" ".join("a" for _ in range(MAX_TEXT_WORDS + 1)), "en", 400, "text_too_long"),
            ("Le chat [?] sur le tapis.", "fr", 400, "unreadable_text"),
            ("ذهب الولد [ ؟ ] المدرسة", "ar", 400, "unreadable_text"),
            ("ذهب الولد إلى المدرسة", "en", 422, "lang_mismatch"),
            ("The cat sat on the mat.", "ar", 422, "lang_mismatch"),
        ],
    )
    def test_errors(self, make_client: Callable[..., TestClient], text: str, lang: str, status: int, code: str) -> None:
        for mode in ("strict", "contextual", "dictation"):
            assert_error(text_check(make_client(), text, lang, mode), status, code)

    def test_bad_text(self, make_client: Callable[..., TestClient]) -> None:
        body = json.dumps({"text": "Le chat \ud83d dort.", "lang": "fr"})  # a lone surrogate, escaped
        r = make_client().post("/api/text/check", content=body, headers={"content-type": "application/json"})
        assert_error(r, 400, "bad_text")

    def test_the_largest_text_is_accepted(self, make_client: Callable[..., TestClient]) -> None:
        words = ["مدرستنا"] * (MAX_TEXT_CHARS // 8)
        text = " ".join(words)
        assert len(text) <= MAX_TEXT_CHARS and len(words) <= MAX_TEXT_WORDS
        body = json.dumps({"text": text, "lang": "ar"})  # ensure_ascii: six bytes per letter
        assert len(body) <= MAX_JSON_BYTES
        r = make_client().post("/api/text/check", content=body, headers={"content-type": "application/json"})
        assert r.status_code == 200 and r.json()["words"] == len(words)

    def test_invalid_requests(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        assert_error(client.post("/api/text/check", json={"lang": "en"}), 422, "missing_field")
        assert_error(client.post("/api/text/check", json={"text": "hi"}), 422, "missing_field")
        assert_error(text_check(client, "hi", "es"), 422, "invalid_field")
        assert_error(text_check(client, "hi", "en", "meaning"), 422, "invalid_field")
        assert_error(text_check(client, 12, "en"), 422, "invalid_field")
        r = client.post("/api/text/check", content=b"{not json", headers={"content-type": "application/json"})
        assert_error(r, 422, "invalid_field")
        assert client.get("/api/text/check").status_code == 405

    def test_the_order_of_the_checks(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        client = make_client()
        surah = " ".join(quran_words(quran, 112, 1, 4))
        assert_error(text_check(client, surah + " [?]", "ar"), 400, "unreadable_text")  # before the Quran guard
        assert_error(text_check(client, surah, "en"), 422, "quran_text")  # before the language
        basmala_line = " ".join(quran_words(quran, 1, 1, 1)) + "\n" + AR_TEXT
        for mode in ("strict", "dictation"):  # a school text with a Quran part: the language decides
            assert_error(text_check(client, basmala_line, "fr", mode), 422, "lang_mismatch")
        assert_error(text_check(client, basmala_line, "fr", "contextual"), 422, "quran_text")

    def test_quran_text_in_every_mode(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        client = make_client()
        texts = {
            " ".join(quran_words(quran, 112, 1, 4)): (112, 1, 4),
            quran.ayat(114, 1, 1)[0].display: (114, 1, 1),  # Uthmani script
            "قال الله تعالى: " + " ".join(quran_words(quran, 112, 4, 4)): (112, 4, 4),
            " ".join(quran_words(quran, 113, 1, 5) + quran_words(quran, 1, 1, 1) + quran_words(quran, 114, 1, 6)): None,
        }
        for text, ref in texts.items():
            for mode in ("strict", "contextual", "dictation"):
                body = assert_error(text_check(client, text, "ar", mode), 422, "quran_text")
                assert body["message"] == app_mod.QURAN_TEXT_MESSAGE and "scope" not in body
                want = {"surah": ref[0], "from": ref[1], "to": ref[2]} if ref else None
                assert body.get("quran_range") == want

    def test_flags(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        """One strict call says whether recitation by meaning and dictation are possible,
        and where the Quran parts are."""
        client = make_client()
        basmala = " ".join(quran_words(quran, 1, 1, 1))
        cases = {
            # text: (contextual, number of Quran parts); dictation is always possible
            AR_TEXT: (True, 0),
            basmala + "\n" + AR_TEXT: (False, 1),  # a whole ayah: never spoken, never judged
            basmala + ". " + AR_TEXT: (False, 1),
            "خلق الله السماوات والأرض والجبال والبحار.": (False, 0),  # four Quran words in a row
            "إن شاء الله سنذهب غدًا إلى البحر.": (True, 0),  # an everyday formula
            # a two-word ayah the comma made a phrase of its own: joined back (RL-5), ordinary
            "الصيف بعيد، " + " ".join(quran_words(quran, 70, 7, 7)) + ".": (True, 0),
            "قال أبي: لا إله إلا الله، ثم خرجنا إلى المسجد.": (True, 0),  # an everyday formula
            " ".join(quran_words(quran, 74, 21, 21)) + " إلى السماء.": (True, 0),
            **{text: (False, 1) for text in contained_examples(quran)},
        }
        for text, (contextual, n_parts) in cases.items():
            body = text_check(client, text, "ar").json()
            assert set(body) == self.KEYS, text
            assert {k: body[k] for k in ("ok", "words", "dictation", "contextual")} == {
                "ok": True, "words": len(app_mod.tokenize(text, "ar")), "dictation": True, "contextual": contextual,
            }, text
            assert len(body["quran_parts"]) == n_parts and body["mushaf_text"] == text
            r = text_check(client, text, "ar", "contextual")
            if contextual:
                assert r.json() == {**body, "contextual": True}
            else:
                assert "scope" not in assert_error(r, 422, "quran_text")
            assert text_check(client, text, "ar", "dictation").json() == body  # no "scope: phrase" refusal any more

    def test_agrees_with_the_endpoints_that_use_the_text(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        """Confirming a text and then reciting or dictating it always agree."""
        basmala = " ".join(quran_words(quran, 1, 1, 1))
        texts = [
            AR_TEXT,
            basmala + "\n" + AR_TEXT,
            basmala + "\n\n" + AR_TEXT + ".",
            "بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ، " + AR_TEXT,
            "خلق الله السماوات والأرض والجبال والبحار.",
            "لا إله إلا الله محمد رسول الله.",
            "نحب الله الرحمن الرحيم.",
            " ".join(quran_words(quran, 112, 1, 4)),
            *contained_examples(quran),
        ]
        client = make_client(transcriber=RecordingTranscriber(AR_TEXT), brain=FakeBrain())
        for text in texts:
            checked = text_check(client, text, "ar")
            phrases = client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"})
            dictation = text_check(client, text, "ar", "dictation")
            assert phrases.status_code == dictation.status_code, text
            if phrases.status_code == 422:
                assert phrases.json() == dictation.json(), text
            strict = recite(client, expected_text=text, lang="ar")
            contextual = recite(client, expected_text=text, lang="ar", mode="contextual")
            assert (checked.status_code == 200) == (strict.status_code == 200), text
            if checked.status_code == 200:
                assert checked.json()["dictation"] == (phrases.status_code == 200), text
                assert checked.json()["contextual"] == (contextual.status_code == 200), text
                if not checked.json()["contextual"]:
                    assert_error(contextual, 422, "quran_text")

    def test_without_the_quran_text(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        client = make_client(quran_obj=None)
        assert_error(text_check(client, AR_TEXT, "ar"), 503, "quran_unavailable")
        assert_error(text_check(client, quran.ayat(114, 1, 1)[0].display, "ar"), 503, "quran_unavailable")
        assert_error(text_check(client, "", "ar"), 400, "empty_text")  # the text checks come first
        assert_error(text_check(client, "ذهب [?]", "ar"), 400, "unreadable_text")
        assert text_check(client, FR_TEXT, "fr", "dictation").json() == {
            "ok": True, "words": 6, "dictation": True, "contextual": True, "quran_parts": [], "mushaf_text": FR_TEXT,
        }

    def test_host_and_origin(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client()
        assert text_check(client, headers={"Host": "rebind.attacker.example"}).json()["error"] == "bad_host"
        assert_error(text_check(client, headers={"Origin": "http://evil.example"}), 403, "bad_origin")
        assert text_check(client, headers={"Origin": BASE_URL}).status_code == 200
        assert text_check(client, headers={"Origin": "null"}).status_code == 403

    def test_body_size_limit(self, make_client: Callable[..., TestClient]) -> None:
        assert body_limit("/api/text/check") == MAX_JSON_BYTES
        client = make_client()
        big = json.dumps({"text": "a " * (MAX_JSON_BYTES // 2), "lang": "en"}).encode()
        assert len(big) > MAX_JSON_BYTES
        assert_error(client.post("/api/text/check", content=big, headers={"content-type": "application/json"}), 413, "too_large")

        def chunks() -> Iterator[bytes]:  # no Content-Length: refused while it streams in
            yield b'{"lang": "en", "text": "'
            for _ in range(MAX_JSON_BYTES // 1024 + 1):
                yield b"a " * 512
            yield b'"}'

        r = client.post("/api/text/check", content=chunks(), headers={"content-type": "application/json"})
        assert_error(r, 413, "too_large")

    def test_logs_carry_no_content(self, make_client: Callable[..., TestClient], caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.DEBUG):
            assert text_check(make_client(), "Quixotic zebras zigzag", "en").status_code == 200
        assert "text/check" in caplog.text
        assert "Quixotic" not in caplog.text and "zebras" not in caplog.text

    def test_a_long_text_is_checked_quickly(self, make_client: Callable[..., TestClient]) -> None:
        import time

        sentences = [
            "ذهب الولد إلى المدرسة صباحا مع أخيه الصغير.", "تعلمنا اليوم جدول الضرب.",
            "يحب سامي اللعب بالكرة مع أصدقائه بعد المدرسة.", "إن شاء الله سنذهب غدًا إلى البحر.",
            "في السوق خضار وفاكهة كثيرة.", "ثم نظر إلى السماء.",
        ]
        lines, words = [], 0
        while words < 1000:
            lines.append(sentences[len(lines) % len(sentences)])
            words += len(lines[-1].split())
        client = make_client()
        started = time.perf_counter()
        body = text_check(client, "\n".join(lines), "ar").json()
        assert body["dictation"] and body["contextual"] and body["words"] >= 1000
        assert time.perf_counter() - started < 2.0


# ---------------------------------------------------------------------------
# School texts with Quran parts (Q2) and texts that are Quran (Q1)
# ---------------------------------------------------------------------------


def lesson(quran: Quran, surah: int = 2, ayah: int = 153) -> str:
    """A lesson that quotes one ayah, framed."""
    return "الصبر مفتاح الفرج. قال تعالى: " + " ".join(quran_words(quran, surah, ayah, ayah)) + " ثم شرح المعلم الآية."


class TestQuranPartsInTheApi:
    def test_a_refusal_by_meaning_says_so(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        # RL-6: the client must tell "recite it word by word" (a school text with Quran
        # words) from "this is Quran: the Quran section" (Q1).
        client = make_client()
        body = assert_error(text_check(client, lesson(quran), "ar", "contextual"), 422, "quran_text")
        assert body["reason"] == "meaning" and "quran_range" not in body
        body = assert_error(recite(client, expected_text=lesson(quran), lang="ar", mode="contextual"), 422, "quran_text")
        assert body["reason"] == "meaning"
        q1 = " ".join(quran_words(quran, 112, 1, 4))
        body = assert_error(text_check(client, q1, "ar", "contextual"), 422, "quran_text")
        assert "reason" not in body and body["quran_range"] == {"surah": 112, "from": 1, "to": 4}

    def test_a_body_that_is_not_json(self, make_client: Callable[..., TestClient]) -> None:
        r = make_client().post("/api/text/check", content=b"{not json", headers={"Content-Type": "application/json"})
        assert r.status_code == 422 and r.json() == {"error": "invalid_field", "message": "The body is not valid JSON."}

    def test_text_check_lists_the_parts(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        ayah = quran.ayat(2, 153, 153)[0]
        typed = list(ayah.match_words)
        typed[6] = typed[6].replace("ص", "ض")  # a misread word in the parent's text
        submitted = "  الصبر مفتاح الفرج. قال تعالى: " + " ".join(typed) + " ثم شرح المعلم الآية.\n"
        body = text_check(make_client(brain=ExplodingBrain(), tts=ExplodingTTS()), submitted, "ar").json()
        assert body["dictation"] is True and body["contextual"] is False
        [part] = body["quran_parts"]
        c0, c1 = part["chars"]
        assert submitted[c0:c1] == " ".join(typed) and part["utf16"] == [c0, c1]
        assert (part["surah"], part["ayah_from"], part["ayah_to"], part["whole"]) == (2, 153, 153, True)
        assert (part["word_from"], part["word_to"]) == (0, len(ayah.match_words))
        assert part["clean"] == ayah.match_words and part["uthmani"] == ayah.display_words
        assert len(part["clean_display"]) == len(part["clean"])
        assert part["differences"] == [{
            "op": "sub", "typed": typed[6], "mushaf": part["clean_display"][6], "mushaf_clean": ayah.match_words[6],
            "index": 6, "token": part["start"] + 6,
        }]
        assert part["replacement"] == ayah.match and part["chunks"] == [
            quran.display_slice(2, 153, 0, 4), quran.display_slice(2, 153, 5, 9),
        ]
        assert part["rule"] == "near" and part["exp_start"] == 5 and part["exp_end"] == 5 + len(ayah.match_words)
        assert body["mushaf_text"] == submitted.replace(" ".join(typed), ayah.match)
        fixed = text_check(make_client(), body["mushaf_text"], "ar").json()
        assert fixed["quran_parts"][0]["differences"] == [] and fixed["mushaf_text"] == body["mushaf_text"]

    def test_a_text_that_is_quran_names_its_range(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        client = make_client()
        text = "قال تعالى: " + " ".join(quran_words(quran, 2, 153, 153))
        for mode in ("strict", "contextual", "dictation"):
            body = assert_error(text_check(client, text, "ar", mode), 422, "quran_text")
            assert body["quran_range"] == {"surah": 2, "from": 153, "to": 153}
        body = assert_error(client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"}), 422, "quran_text")
        assert body["quran_range"] == {"surah": 2, "from": 153, "to": 153}

    def test_page_reader_decides_from_the_text(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        surah = " ".join(quran_words(quran, 112, 1, 4))
        # A page that is Quran keeps the "page is Quran" answer, whatever the reader said.
        page = {"text": surah, "lang": "ar", "notes": "", "contains_quran": False, "needs_manual": False}
        body = TestPageRead().post(make_client(brain=FakeBrain(page=page)), jpeg(), lang="ar").json()
        assert body["contains_quran"] is True and body["quran_range"] == {"surah": 112, "from": 1, "to": 4}
        assert len(body["quran_parts"]) == 1
        # A school page with a quoted ayah is read as usual, with its parts marked.
        text = lesson(quran)
        page = {"text": text, "lang": "ar", "notes": "", "contains_quran": True, "needs_manual": False}
        body = TestPageRead().post(make_client(brain=FakeBrain(page=page)), jpeg(), lang="ar").json()
        assert body["contains_quran"] is False and body["quran_range"] is None
        assert [(p["surah"], p["ayah_from"]) for p in body["quran_parts"]] == [(2, 153)]
        assert body["mushaf_text"] == text and body["text"] == text
        # An unreadable word inside the ayah: the parent sees the difference.
        missing = text.replace(quran_words(quran, 2, 153, 153)[6], "[?]")
        page = {"text": missing, "lang": "ar", "notes": "", "contains_quran": True, "needs_manual": False}
        body = TestPageRead().post(make_client(brain=FakeBrain(page=page)), jpeg(), lang="ar").json()
        assert body["unreadable_marks"] == 1 and body["mushaf_text"] == text
        # Offline: no text, no parts.
        body = TestPageRead().post(make_client(brain=OfflineBrain()), jpeg(), lang="ar").json()
        assert body["quran_parts"] == [] and body["mushaf_text"] == "" and body["contains_quran"] is False

    def test_dictation_phrases_and_the_voice(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        text = lesson(quran)
        tts = FakeTTS()
        client = make_client(tts=tts)
        body = client.post("/api/dictation/phrases", json={"text": text, "lang": "ar"}).json()
        assert set(body) == {"phrases", "readers", "read_text", "parts", "quran_parts"}
        assert body["readers"] == ["voice", "voice", "grown_up", "grown_up", "voice"]
        assert body["read_text"][2:4] == body["quran_parts"][0]["chunks"]
        assert body["parts"] == [None, None, 0, 0, None]
        for phrase, reader in zip(body["phrases"], body["readers"]):
            r = client.post("/api/tts", json={"text": phrase, "lang": "ar", "slow": True})
            assert r.status_code == (200 if reader == "voice" else 422), phrase
        for read in body["read_text"][2:4]:  # the grown-up's text is never spoken either
            assert_error(client.post("/api/tts", json={"text": read, "lang": "ar"}), 422, "quran_text")
        spoken = list(dict.fromkeys(c[0] for c in tts.calls))  # slow speech may be made twice (speech check)
        assert spoken == [p for p, r in zip(body["phrases"], body["readers"]) if r == "voice"]

    def test_recitation_by_meaning_is_refused(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        brain = FakeBrain()
        client = make_client(brain=brain, transcriber=RecordingTranscriber(lesson(quran)))
        body = assert_error(recite(client, expected_text=lesson(quran), lang="ar", mode="contextual"), 422, "quran_text")
        assert body["message"] == app_mod.QURAN_MEANING_MESSAGE
        assert brain.calls == []

    def test_a_quran_mistake_gets_the_quran_template(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        ayah = quran.ayat(2, 153, 153)[0]
        heard_words = list(ayah.match_words)
        heard_words[6] = "والصلوات"
        heard = "الصبر مفتاح الفرج قال تعالى " + " ".join(heard_words) + " ثم شرح المعلم الآية"
        brain = FakeBrain()
        client = make_client(brain=brain, transcriber=RecordingTranscriber(heard))
        body = recite(client, expected_text=lesson(quran), lang="ar").json()
        assert [(op["kind"], op["expected"]) for op in body["result"]["ops"] if op["kind"] != "match"] == [
            ("sub", ayah.match_words[6])
        ]
        display = ayah.display_words[ayah.word_map[6]]
        assert body["feedback"] == feedback.quran_part_feedback("sub", display, "ar", "recitation")
        assert body["feedback_is_quran"] is True
        assert brain.called("word_feedback") == []  # Claude never receives a Quran word
        [part] = body["quran_parts"]
        assert part["exp_start"] == 5 and body["result"]["ops"][5]["expected"] == ayah.match_words[0]

    def test_a_mistake_outside_the_parts_may_be_worded_by_claude(
        self, make_client: Callable[..., TestClient], quran: Quran
    ) -> None:
        ayah = quran_words(quran, 2, 153, 153)
        heard = "الصبر مفتاح النجاح قال تعالى " + " ".join(ayah) + " ثم شرح المعلم الآية"
        brain = FakeBrain(feedback_text="اِقْتَرَبْت!")
        client = make_client(brain=brain, transcriber=RecordingTranscriber(heard))
        body = recite(client, expected_text=lesson(quran), lang="ar").json()
        assert body["feedback"] == "اِقْتَرَبْت!" and body["feedback_is_quran"] is False
        [(args, kwargs)] = brain.called("word_feedback")
        quran_only = set(ayah) - set(tokenize_ar("الصبر مفتاح الفرج قال تعالى ثم شرح المعلم الآية"))
        sent = json.dumps([args, kwargs], ensure_ascii=False)
        assert not any(w in sent.split('"') for w in quran_only), sent
        assert args[0]["errors"] == [{"kind": "sub", "expected": "الفرج", "heard": "النجاح", "exp_index": 2}]

    def test_quran_words_said_past_the_text_never_reach_claude(
        self, make_client: Callable[..., TestClient], quran: Quran
    ) -> None:
        # RL-7: the child recites the lesson, then says words of its ayah again at the end.
        # Those extra words lie outside the part (the text ends with ordinary words), but
        # they are Quran words: the brain gets the mistake without them.
        ayah = list(quran_words(quran, 2, 153, 153))
        heard = "الصبر مفتاح الفرج قال تعالى " + " ".join(ayah) + " ثم شرح المعلم الآية " + " ".join(ayah[:2])
        brain = FakeBrain()
        client = make_client(brain=brain, transcriber=RecordingTranscriber(heard))
        body = recite(client, expected_text=lesson(quran), lang="ar").json()
        assert [op["kind"] for op in body["result"]["ops"] if op["kind"] != "match"] == ["ins", "ins"]
        [(args, kwargs)] = brain.called("word_feedback")
        sent = json.dumps([args, kwargs], ensure_ascii=False)
        assert not any(w in sent.split('"') for w in ayah[:2]), sent
        assert [e["heard"] for e in args[0]["errors"]] == [None, None]
        # And a child who says an ayah of a short surah instead of the text: the template.
        client = make_client(brain=(brain := FakeBrain()), transcriber=RecordingTranscriber(" ".join(quran_words(quran, 112, 1, 1))))
        recite(client, expected_text=lesson(quran), lang="ar")
        assert brain.called("word_feedback") == []

    def test_mistakes_in_and_out_of_the_part_skip_claude(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        ayah = list(quran_words(quran, 2, 153, 153))
        heard_ayah = ayah[:-1]  # a word of the ayah left out, and a word of the lesson misread before it
        heard = "الصبر مفتاح النجاح قال تعالى " + " ".join(heard_ayah) + " ثم شرح المعلم الآية"
        brain = FakeBrain()
        client = make_client(brain=brain, transcriber=RecordingTranscriber(heard))
        body = recite(client, expected_text=lesson(quran), lang="ar").json()
        assert body["feedback_is_quran"] is False  # the first mistake is outside: the ordinary template
        assert body["feedback"] == feedback.for_result(check_like(body), "ar", "6-9", activity="recitation")
        assert brain.called("word_feedback") == []

    def test_the_child_stopped_in_the_ayah(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        ayah = quran.ayat(2, 153, 153)[0]
        text = "قال تعالى: " + ayah.match + " وفي الصبر خير كثير."
        heard = "قال تعالى " + " ".join(ayah.match_words[:7])
        brain = FakeBrain()
        body = recite(make_client(brain=brain, transcriber=RecordingTranscriber(heard)), expected_text=text, lang="ar").json()
        display = ayah.display_words[ayah.word_map[7]]
        assert body["feedback"] == feedback.quran_part_feedback("stopped", display, "ar", "recitation")
        assert body["feedback_is_quran"] is True and brain.calls == []

    def test_dictation_check_with_a_quran_part(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        ayah = quran.ayat(2, 153, 153)[0]
        text = lesson(quran)
        brain = FakeBrain()
        client = make_client(brain=brain)
        uthmani = text.replace(ayah.match, " ".join(ayah.display_words))
        body = check_dictation(client, expected_text=text, lang="ar", written_text=uthmani).json()
        assert body["result"]["verdict"] == "correct" and body["feedback_is_quran"] is False
        wrong = text.replace(ayah.match_words[1], ayah.match_words[1].replace("أ", "ا"))  # no hamza
        body = check_dictation(client, expected_text=text, lang="ar", written_text=wrong).json()
        assert body["result"]["n_errors"] == 1 and body["feedback_is_quran"] is True
        display = ayah.display_words[ayah.word_map[1]]
        assert body["feedback"] == feedback.quran_part_feedback("sub", display, "ar", "dictation")
        # Only the first (correct) check reached the brain, with no word in it at all.
        [(args, _)] = brain.called("word_feedback")
        assert args[0]["errors"] == [] and args[0]["verdict"] == "correct"
        [part] = body["quran_parts"]
        assert body["result"]["ops"][part["exp_start"] + 1]["expected"] == ayah.match_words[1]

    def test_recite_offsets_are_into_the_text_with_lf_line_breaks(
        self, make_client: Callable[..., TestClient], quran: Quran
    ) -> None:
        # P1: the browser sends expected_text with CRLF; the offsets of the parts are into
        # the text the client holds (LF), as for the JSON endpoints.
        basmala = " ".join(quran_words(quran, 1, 1, 1))
        text = basmala + "\n" + lesson(quran)
        client = make_client(transcriber=FakeTranscriber(text.replace("\n", " ")))
        for sent in (text.replace("\n", "\r\n"), text):
            body = recite(client, expected_text=sent, lang="ar").json()
            assert body["result"]["verdict"] == "correct"
            assert [text[slice(*p["chars"])] for p in body["quran_parts"]] == [basmala, " ".join(quran_words(quran, 2, 153, 153))]

    def test_the_parts_are_never_taken_from_the_client(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        # Whatever extra fields a client sends, the server recomputes the parts from the text.
        client = make_client()
        body = client.post(
            "/api/text/check", json={"text": lesson(quran), "lang": "ar", "quran_parts": [], "mushaf_text": "x"}
        ).json()
        assert len(body["quran_parts"]) == 1


def tokenize_ar(text: str) -> list[str]:
    return app_mod.tokenize(text, "ar")


def check_like(body: dict) -> dict:
    """The result of a response, in the form feedback.for_result reads."""
    return body["result"]


# ---------------------------------------------------------------------------
# Live recitation: /api/recite/phrase and the tail of /api/recite/check (extra)
# ---------------------------------------------------------------------------


def phrase(
    client: TestClient,
    *,
    audio: bytes | None = None,
    expected_text: str | None = EN_TEXT,
    lang: str | None = "en",
    mode: str | None = "strict",
    heard_before: str | None = None,
    **extra: str,
) -> Any:
    fields = dict(expected_text=expected_text, lang=lang, mode=mode, heard_before=heard_before, **extra)
    data = {k: v for k, v in fields.items() if v is not None}
    files = {"audio": ("phrase.wav", audio if audio is not None else wav(), "audio/wav")} if audio != b"-" else None
    return client.post("/api/recite/phrase", data=data, files=files)


def empty_wav() -> bytes:
    """A WAV file with no samples (the tail of a live recitation when nothing came after the last phrase)."""
    return wav(0.0)


def kinds(ops: list[dict]) -> list[str]:
    return [op["kind"] for op in ops]


PHRASE_KEYS = {"mode", "heard_text", "quality", "progress", "brain"}
PROGRESS_KEYS = {"ops", "n_expected", "n_read", "n_matched", "n_errors"}


class TestLivePhrase:
    def test_health_and_the_switch(self, make_client: Callable[..., TestClient]) -> None:
        assert make_client().get("/api/health").json()["live_recite"] is True
        client = make_client(settings=make_settings(live_recite=False), transcriber=RecordingTranscriber("x"))
        assert client.get("/api/health").json()["live_recite"] is False
        # Off, the endpoint does not exist: an older or switched-off server answers 404 and
        # the web client sends the whole recording.
        assert_error(phrase(client), 404, "not_found")
        assert "/api/recite/phrase" not in client.get("/api/openapi.json").json()["paths"]

    def test_first_phrase_colours_the_words_read_and_leaves_the_rest_pending(
        self, make_client: Callable[..., TestClient]
    ) -> None:
        transcriber = RecordingTranscriber("the cat sat")
        r = phrase(make_client(transcriber=transcriber, brain=ExplodingBrain(), tts=ExplodingTTS()), audio=wav(1.5))
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body) == PHRASE_KEYS and set(body["progress"]) == PROGRESS_KEYS
        assert body["mode"] == "strict" and body["heard_text"] == "the cat sat" and body["brain"] == "offline"
        assert set(body["quality"]) == QUALITY_KEYS and body["quality"]["seconds"] == pytest.approx(1.5)
        progress = body["progress"]
        assert kinds(progress["ops"]) == ["match"] * 3 + ["pending"] * 3
        assert [op["expected"] for op in progress["ops"]] == ["The", "cat", "sat", "on", "the", "mat"]
        assert all(set(op) == OP_KEYS for op in progress["ops"])
        assert (progress["n_expected"], progress["n_read"], progress["n_matched"], progress["n_errors"]) == (6, 3, 3, 0)
        # Only this phrase is decoded: its samples and the language, nothing else (hard rule 1).
        (args, kwargs), = transcriber.calls
        assert kwargs == {} and args[1] == "en" and args[0].size == 24_000 and args[0].dtype == np.float32

    def test_the_words_heard_before_are_checked_with_the_phrase(self, make_client: Callable[..., TestClient]) -> None:
        client = make_client(transcriber=RecordingTranscriber("sat on mat"), brain=ExplodingBrain())
        body = phrase(client, heard_before="the cat").json()
        assert body["heard_text"] == "sat on mat"  # this phrase only; the client joins
        ops = body["progress"]["ops"]
        assert kinds(ops) == ["match", "match", "match", "match", "del", "match"]  # a skipped word stays missing
        assert body["progress"]["n_read"] == 6 and body["progress"]["n_errors"] == 1
        body = phrase(make_client(transcriber=RecordingTranscriber("sat")), heard_before="the dog").json()
        assert kinds(body["progress"]["ops"]) == ["match", "sub", "match", "pending", "pending", "pending"]
        assert body["progress"]["ops"][1]["heard"] == "dog" and body["progress"]["n_errors"] == 1

    @pytest.mark.parametrize(
        ("before", "heard"),
        [("", "the cat"), ("the cat", "sat on the"), ("a cat", "sit on the mat"), ("the", "mat"), ("", "")],
    )
    def test_progress_is_the_strict_check_of_the_words_so_far(
        self, make_client: Callable[..., TestClient], before: str, heard: str
    ) -> None:
        # The same analysis as /api/recite/check strict, with the words not reached pending.
        body = phrase(make_client(transcriber=RecordingTranscriber(heard)), heard_before=before).json()
        joined = " ".join(t for t in (before, heard) if t)
        result = check_recitation(EN_TEXT, joined, "en")
        ops = [dataclasses.asdict(op) for op in result.ops]
        last = max((k for k, op in enumerate(ops) if op["heard_index"] is not None), default=-1)
        for k, op in enumerate(ops):
            if k > last:
                assert op["kind"] == "del"
                op["kind"] = "pending"
        assert body["progress"]["ops"] == ops

    def test_a_quran_part_follows_the_mushaf_rules(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        text = lesson(quran)
        ayah = quran.ayat(2, 153, 153)[0]
        words = list(ayah.match_words)
        before = "الصبر مفتاح الفرج قال تعالى " + " ".join(words[:3])
        said = list(words[3:8])
        said[3] = "والصلوات"  # the 7th word of the ayah said wrongly
        client = make_client(transcriber=RecordingTranscriber(" ".join(said)), brain=ExplodingBrain(), tts=ExplodingTTS())
        body = phrase(client, expected_text=text, lang="ar", heard_before=before).json()
        ops = body["progress"]["ops"]
        # The check of /api/recite/check strict on the same words, mushaf words inside the part.
        check = recite(make_client(transcriber=RecordingTranscriber(before + " " + " ".join(said)), brain=OfflineBrain()),
                       expected_text=text, lang="ar").json()
        [part] = check["quran_parts"]
        expected_kinds = ["match"] * (part["exp_start"] + 6) + ["sub", "match"]
        assert kinds(ops)[: len(expected_kinds)] == expected_kinds
        assert ops[part["exp_start"] + 6]["expected"] == ayah.match_words[6]
        assert set(kinds(ops)[len(expected_kinds):]) == {"pending"}
        assert [op for op in ops if op["kind"] != "pending"] == check["result"]["ops"][: len(expected_kinds)]

    def test_meaning_mode_gives_the_transcript_only(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        client = make_client(transcriber=RecordingTranscriber("a cat was sitting"), brain=ExplodingBrain())
        body = phrase(client, mode="contextual", heard_before="so").json()
        assert body == {**body, "mode": "contextual", "heard_text": "a cat was sitting", "progress": None, "brain": "offline"}
        # The refusals of /api/recite/check by meaning, for the same texts.
        body = assert_error(phrase(client, expected_text=lesson(quran), lang="ar", mode="contextual"), 422, "quran_text")
        assert body["reason"] == "meaning"
        q1 = " ".join(quran_words(quran, 112, 1, 4))
        body = assert_error(phrase(client, expected_text=q1, lang="ar"), 422, "quran_text")
        assert body["quran_range"] == {"surah": 112, "from": 1, "to": 4}

    def test_never_calls_a_brain_even_with_the_ai_consent(self, make_client: Callable[..., TestClient]) -> None:
        brain = ExplodingBrain()
        client = make_client(transcriber=RecordingTranscriber("the cat"), brain=brain, tts=ExplodingTTS())
        for mode in ("strict", "contextual"):
            r = phrase(client, mode=mode, ai_consent="1", age="6-9")
            assert r.status_code == 200 and r.json()["brain"] == "offline"
        assert brain.calls == []

    def test_unclear_audio_is_not_decoded(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("thank you")
        client = make_client(transcriber=transcriber)
        for audio in (silent_wav(2.0), wav(0.3)):
            body = phrase(client, audio=audio, heard_before="the cat").json()
            assert body["heard_text"] == "" and (body["quality"]["too_quiet"] or body["quality"]["too_short"])
            assert kinds(body["progress"]["ops"]) == ["match", "match"] + ["pending"] * 4
        assert transcriber.calls == []

    def test_limits(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("x")
        client = make_client(transcriber=transcriber)
        assert body_limit("/api/recite/phrase") == app_mod.MAX_PHRASE_BYTES + app_mod.FORM_OVERHEAD_BYTES
        assert app_mod.MAX_PHRASE_BYTES <= MAX_AUDIO_BYTES
        assert phrase(client, audio=wav(30.0)).status_code == 200
        assert_error(phrase(client, audio=wav(31.0)), 413, "audio_too_long")
        assert_error(phrase(client, audio=wav(1.0) + b"\x00" * app_mod.MAX_PHRASE_BYTES), 413, "audio_too_large")
        assert_error(phrase(client, audio=b"not a wav"), 400, "bad_audio")
        assert_error(phrase(client, audio=empty_wav()), 400, "bad_audio")  # a phrase has samples
        assert_error(phrase(client, heard_before="word " * (MAX_TEXT_CHARS // 5 + 1)), 400, "text_too_long")
        assert_error(phrase(client, heard_before="w " * (MAX_TEXT_WORDS + 1)), 400, "text_too_long")
        assert_error(phrase(client, expected_text="  "), 400, "empty_text")
        assert_error(phrase(client, expected_text="Le chat [?] sur le tapis.", lang="fr"), 400, "unreadable_text")
        assert_error(phrase(client, expected_text=AR_TEXT), 422, "lang_mismatch")
        assert transcriber.calls == [(tuple(transcriber.calls[0][0]), {})]  # only the 30 s phrase
        too_big = b"\x00" * (body_limit("/api/recite/phrase") + 1)
        r = client.post("/api/recite/phrase", content=too_big, headers={"content-type": "multipart/form-data; boundary=b0"})
        assert r.status_code == 413
        assert_error(phrase(make_client(transcriber=FakeTranscriber(available=False))), 503, "asr_unavailable")

    @pytest.mark.parametrize("missing", ["audio", "expected_text", "lang", "mode"])
    def test_missing_fields(self, make_client: Callable[..., TestClient], missing: str) -> None:
        kwargs: dict[str, Any] = {missing: b"-" if missing == "audio" else None}
        body = assert_error(phrase(make_client(), **kwargs), 422, "missing_field")
        assert missing in body["message"]
        assert_error(phrase(make_client(), mode="dictation"), 422, "invalid_field")

    def test_behind_the_access_gate(self, quran: Quran) -> None:
        app = create_app(make_settings(access_code="phrase-gate-code"), RecordingTranscriber("x"), FakeTTS(), OfflineBrain(), quran)
        client = TestClient(app, base_url=BASE_URL)
        assert_error(phrase(client), 401, "access_required")
        assert client.post("/api/access", json={"code": "phrase-gate-code"}).status_code == 204
        assert phrase(client).status_code == 200

    def test_recogniser_never_sees_the_text_or_the_words_before(self, make_client: Callable[..., TestClient]) -> None:
        spy = SpyTranscriber("sat on")
        client = make_client(transcriber=spy)
        expected = "Zebras zigzag quickly across Zanzibar"
        spy.secrets += [expected, "Zanzibar", "Quokkas yodel"]
        assert phrase(client, expected_text=expected, heard_before="Quokkas yodel").status_code == 200
        assert recite(client, expected_text=expected, heard_before="Quokkas yodel").status_code == 200
        assert len(spy.calls) == 2 and spy.leaks == []
        for args, kwargs in spy.calls:
            assert kwargs == {} and len(args) == 2 and args[1] == "en"

    def test_logs_hold_sizes_and_timings_only(
        self, make_client: Callable[..., TestClient], caplog: pytest.LogCaptureFixture
    ) -> None:
        client = make_client(transcriber=RecordingTranscriber("Quixotic zebras"))
        with caplog.at_level(logging.DEBUG):
            for mode in ("strict", "contextual"):
                r = phrase(client, expected_text="Quixotic zebras zigzag wildly", mode=mode, heard_before="Yodelling quokkas")
                assert r.status_code == 200
            r = recite(client, expected_text="Quixotic zebras zigzag wildly", heard_before="Yodelling quokkas", age="10-13")
            assert r.status_code == 200
        assert "recite/phrase strict en: audio" in caplog.text and "after 2 words" in caplog.text
        assert "tail after 2 words" in caplog.text
        for word in ("Quixotic", "zebras", "zigzag", "wildly", "Yodelling", "quokkas", "10-13"):
            assert word not in caplog.text

    def test_openapi_lists_the_endpoint_without_the_ai_consent(self, make_client: Callable[..., TestClient]) -> None:
        spec = make_client().get("/api/openapi.json").json()
        op = spec["paths"]["/api/recite/phrase"]["post"]
        ref = op["requestBody"]["content"]["multipart/form-data"]["schema"]["$ref"].rsplit("/", 1)[1]
        body = spec["components"]["schemas"][ref]
        assert set(body["properties"]) == {"audio", "expected_text", "lang", "mode", "heard_before"}
        assert set(body["required"]) == {"audio", "expected_text", "lang", "mode"}
        assert "ai_consent" not in body["properties"]
        check = spec["paths"]["/api/recite/check"]["post"]
        ref = check["requestBody"]["content"]["multipart/form-data"]["schema"]["$ref"].rsplit("/", 1)[1]
        body = spec["components"]["schemas"][ref]
        assert "heard_before" in body["properties"] and "heard_before" not in body["required"]
        assert "audio" in body["required"] and "ai_consent" in body["properties"]


class TestLiveTail:
    """/api/recite/check with heard_before: only the tail is decoded."""

    def test_strict_checks_the_words_before_and_the_tail(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("on the mat")
        brain = FakeBrain()
        body = recite(make_client(transcriber=transcriber, brain=brain), audio=wav(1.2), heard_before="the cat sit").json()
        assert body["heard_text"] == "the cat sit on the mat"
        assert body["result"] == json.loads(json.dumps(dataclasses.asdict(check_recitation(EN_TEXT, "the cat sit on the mat", "en"))))
        assert body["feedback"] == "Lovely effort, keep going!" and body["brain"] == "claude"
        assert set(body["quality"]) == QUALITY_KEYS and body["quality"]["seconds"] == pytest.approx(1.2)
        (args, _), = transcriber.calls
        assert args[0].size == 19_200  # the tail only
        (summary, lang, age), _ = brain.called("word_feedback")[0]
        assert summary["errors"][0]["heard"] == "sit"

    def test_an_empty_tail_is_not_decoded(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("thank you")
        client = make_client(transcriber=transcriber, brain=OfflineBrain())
        body = recite(client, audio=empty_wav(), heard_before="the cat sat on the mat").json()
        assert transcriber.calls == []
        assert body["heard_text"] == "the cat sat on the mat" and body["result"]["verdict"] == "correct"
        assert body["quality"] == {"seconds": 0.0, "rms": 0.0, "too_quiet": False, "too_short": False}
        assert body["say_again"] is False

    def test_quality_reflects_the_whole_recitation(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("mat")
        client = make_client(transcriber=transcriber, brain=OfflineBrain())
        # A tail too short to decode after words heard before: neither too short nor too quiet.
        body = recite(client, audio=wav(0.3), heard_before="the cat sat on the").json()
        assert transcriber.calls == [] and body["quality"]["too_short"] is False and body["quality"]["too_quiet"] is False
        assert body["result"]["ops"][-1]["kind"] == "del"  # the last word was not heard
        # Nothing heard before: the tail is all there is, its own flags stand.
        for audio, flag in ((wav(0.3), "too_short"), (silent_wav(2.0), "too_quiet")):
            body = recite(client, audio=audio, heard_before="").json()
            assert body["quality"][flag] is True and body["result"]["verdict"] == "unclear" and body["say_again"]
        body = recite(client, audio=empty_wav(), heard_before="  ").json()
        assert body["quality"]["too_quiet"] and body["quality"]["too_short"] and body["say_again"]
        # A tail with words after silence before (the earlier phrases heard nothing).
        body = recite(make_client(transcriber=RecordingTranscriber("the cat sat on the mat")), heard_before="").json()
        assert body["heard_text"] == "the cat sat on the mat" and body["result"]["verdict"] == "correct"

    def test_an_older_client_is_answered_as_before(self, make_client: Callable[..., TestClient]) -> None:
        # No heard_before: the audio is the whole recording, an empty WAV is refused as before.
        transcriber = RecordingTranscriber("the cat sat on the mat")
        client = make_client(transcriber=transcriber)
        assert_error(recite(client, audio=empty_wav()), 400, "bad_audio")
        body = recite(client, audio=wav(2.0)).json()
        assert body["heard_text"] == "the cat sat on the mat" and transcriber.calls[-1][0][0].size == 32_000
        assert body["quality"]["seconds"] == pytest.approx(2.0)
        assert_error(recite(client, audio=b"-", heard_before="the cat"), 422, "missing_field")

    def test_meaning_is_judged_on_the_joined_text(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        client = make_client(transcriber=RecordingTranscriber("was sitting"), brain=brain)
        body = recite(client, mode="contextual", heard_before="a cat", age="10-13").json()
        assert body["heard_text"] == "a cat was sitting" and body["brain"] == "claude"
        assert brain.called("judge_meaning") == [((EN_TEXT, "a cat was sitting", "en", "10-13"), {})]
        # Without the AI consent the offline heuristic answers and Claude is not called.
        brain = FakeBrain()
        client = make_client(transcriber=RecordingTranscriber("was sitting"), brain=brain)
        body = recite(client, mode="contextual", heard_before="a cat", ai_consent=None).json()
        assert body["brain"] == "offline" and body["judgement"]["approximate"] is True and brain.calls == []
        # Nothing heard in all: unclear.
        body = recite(make_client(transcriber=RecordingTranscriber("")), mode="contextual", audio=empty_wav(),
                      heard_before="").json()
        assert body["judgement"]["verdict"] == "unclear" and body["say_again"] is True

    def test_strict_without_consent_uses_the_templates(self, make_client: Callable[..., TestClient]) -> None:
        brain = FakeBrain()
        client = make_client(transcriber=RecordingTranscriber("on mat"), brain=brain)
        body = recite(client, heard_before="the cat sat", ai_consent=None).json()
        assert body["brain"] == "offline" and brain.calls == []
        assert body["feedback"] == feedback.for_result(check_recitation(EN_TEXT, "the cat sat on mat", "en"), "en", "6-9")

    def test_a_quran_mistake_in_the_tail(self, make_client: Callable[..., TestClient], quran: Quran) -> None:
        ayah = quran.ayat(2, 153, 153)[0]
        words = list(ayah.match_words)
        words[6] = "والصلوات"
        before = "الصبر مفتاح الفرج قال تعالى " + " ".join(words[:4])
        tail = " ".join(words[4:]) + " ثم شرح المعلم الآية"
        brain = FakeBrain()
        client = make_client(brain=brain, transcriber=RecordingTranscriber(tail), tts=ExplodingTTS())
        body = recite(client, expected_text=lesson(quran), lang="ar", heard_before=before).json()
        assert [(op["kind"], op["expected"]) for op in body["result"]["ops"] if op["kind"] != "match"] == [
            ("sub", ayah.match_words[6])
        ]
        assert body["feedback_is_quran"] is True and len(body["quran_parts"]) == 1 and brain.calls == []

    def test_heard_before_limits(self, make_client: Callable[..., TestClient]) -> None:
        transcriber = RecordingTranscriber("x")
        client = make_client(transcriber=transcriber)
        assert_error(recite(client, heard_before="word " * (MAX_TEXT_CHARS // 5 + 1)), 400, "text_too_long")
        assert_error(recite(client, heard_before="the cat", audio=wav(121.0)), 413, "audio_too_long")
        assert transcriber.calls == []

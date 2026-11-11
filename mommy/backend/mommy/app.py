"""The HTTP API of Mommy (FastAPI) and the static web client.

:func:`create_app` wires the components given to it (a :class:`~mommy.asr.Transcriber`, a
:class:`~mommy.tts.Synthesizer`, a :class:`~mommy.llm.Brain` and the
:class:`~mommy.quran.Quran`, or None when its files could not be loaded) into the API
of ``docs/CONTRACT.md``. :func:`build_default_app` builds the real components, for
``uvicorn mommy.app:build_default_app --factory`` (see ``run.sh``).

Flows
-----
* Strict recitation: ``decode_wav`` -> ``audio_quality`` (a clip that is too quiet or
  too short is answered with "say it again" and the recogniser is not run) ->
  ``transcribe(pcm, lang)``, which is never given the expected text (hard rule 1) ->
  ``check_recitation`` (deterministic, hard rule 2) -> ``brain.word_feedback``, which
  only words the result (the templates of :mod:`mommy.feedback` when it fails).
* Contextual recitation: the same audio steps, then ``brain.judge_meaning``.
* Dictation: ``brain.read_handwriting(image, lang)`` reads the child's paper *blind*
  (hard rule 3; the expected text is not an argument), or the parent types it; then
  ``check_writing`` and feedback. The result always needs the parent's confirmation.
* Quran: ``transcribe(pcm, "ar")`` -> ``Quran.check`` / ``Quran.locate`` ->
  ``feedback.quran_feedback``. No Quran endpoint touches the brain or the synthesizer
  (hard rule 4).

The general endpoints also refuse Quran text (``422 quran_text``, see
:func:`looks_like_quran`): a passage of the Quran is checked only by the Quran section,
against the verbatim Tanzil text, and is never given to the LLM or spoken by the voice.

Privacy (hard rule 5)
---------------------
* Request bodies on ``/api/*`` are bounded (:class:`RequestGuardMiddleware`): a body
  over the route's limit is refused with 413, from its ``Content-Length`` or while it
  streams in, before it is parsed.
* Uploads stay in memory. Starlette keeps an uploaded file in a
  ``SpooledTemporaryFile`` that moves to a temporary file on disk past
  ``MultiPartParser.spool_max_size`` (1 MB by default, less than one recording).
  :func:`keep_uploads_in_memory` raises that threshold above the largest body the guard
  lets through, so no upload can reach the disk; ``tests/test_api.py`` checks this by
  making ``SpooledTemporaryFile.rollover`` fail during a 9.7 MB upload (and that the
  same upload does roll over with the default threshold).
* Nothing a child said, wrote or photographed is logged: logs carry sizes, durations,
  timings and error class names only. Unexpected errors on ``/api/*`` are answered with a
  JSON 500 and logged as a class name and code location, because exception messages and
  tracebacks can quote content.
* Every ``/api/*`` response has ``Cache-Control: no-store``.

Errors are ``{"error": <code>, "message": <text>}`` with status 400 (bad input), 413 (too
large or too long), 422 (missing or invalid fields, Quran text), 501 (the handwriting
needs to be typed) or 503 (a component is unavailable); unknown paths and methods get
404 and 405 in the same shape, and an internal error 500.

CPU-heavy and blocking work (speech recognition, synthesis, Claude calls) runs in plain
``def`` endpoints, which FastAPI runs in its thread pool, so the event loop stays free.
"""

from __future__ import annotations

import dataclasses
import io
import logging
import os
import time
import traceback
from http import HTTPStatus
from typing import Annotated, Any, Literal

import numpy as np
from fastapi import FastAPI, File, Form, Query, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.formparsers import MultiPartParser
from starlette.requests import Request
from starlette.routing import Match, Mount
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import __version__, feedback
from .align import CheckResult, check_recitation, check_writing, result_summary
from .asr import ASRUnavailable, SherpaWhisper, Transcriber, audio_quality, decode_wav, wav_duration
from .config import Settings, load_settings
from .feedback import AgeBand
from .llm import VERDICTS, Brain, OfflineBrain, make_brain, meaning_feedback
from .phrases import split_phrases
from .quran import N_SURAHS, RIWAYA, SOURCE_URL, Quran
from .textnorm import LANGUAGES, Lang, has_arabic, tokenize
from .tts import PiperTTS, QuranTextRefused, Synthesizer, TTSUnavailable, is_quranic_script, synthesize_verified

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

MB = 1024 * 1024

#: Largest audio upload (bytes) and recording (seconds), from the contract.
MAX_AUDIO_BYTES = 10 * MB
MAX_AUDIO_SECONDS = 120.0
#: Rounding allowance on the length of a recording made right up to the limit.
AUDIO_SECONDS_TOLERANCE = 0.1

#: Largest image upload (bytes), from the contract.
MAX_IMAGE_BYTES = 8 * MB
#: Images that carry metadata are decoded and re-encoded; refuse decoding more pixels.
MAX_IMAGE_PIXELS = 50_000_000

#: Largest text field (expected text, typed writing, heard text), in characters.
MAX_TEXT_CHARS = 20_000
#: Largest text for ``/api/tts``, from the contract.
MAX_TTS_CHARS = 400
#: Most ayat in one Quran request, from the contract.
MAX_AYAT = 50
#: Candidates returned by ``/api/quran/locate``.
LOCATE_TOP_K = 5

#: Room for the multipart boundaries, part headers and text fields around an upload.
FORM_OVERHEAD_BYTES = 256 * 1024
#: Largest body of every other ``/api/*`` request (JSON).
MAX_JSON_BYTES = 256 * 1024

#: Body limits of the upload routes; every other ``/api/*`` route gets MAX_JSON_BYTES.
BODY_LIMITS: dict[str, int] = {
    "/api/recite/check": MAX_AUDIO_BYTES + FORM_OVERHEAD_BYTES,
    "/api/quran/check": MAX_AUDIO_BYTES + FORM_OVERHEAD_BYTES,
    "/api/quran/locate": MAX_AUDIO_BYTES + FORM_OVERHEAD_BYTES,
    "/api/page/read": MAX_IMAGE_BYTES + FORM_OVERHEAD_BYTES,
    "/api/dictation/check": MAX_IMAGE_BYTES + FORM_OVERHEAD_BYTES,
}
#: The largest body any route accepts: uploads up to this size stay in memory.
MAX_BODY_BYTES = max(BODY_LIMITS.values())

#: Syntheses tried for slow (dictation) speech until the recogniser hears the phrase.
SPEECH_CHECK_ATTEMPTS = 2

#: :func:`looks_like_quran`: a text of at least this many words...
QURAN_GUARD_MIN_WORDS = 4
#: ...whose words are found, in order, at one place of the Quran at least this share.
QURAN_GUARD_MIN_SCORE = 0.9

LangField = Literal["ar", "en", "fr"]
AgeField = Literal["6-9", "10-13", "14-18"]

# ---------------------------------------------------------------------------
# Errors and responses
# ---------------------------------------------------------------------------


class UTF8JSONResponse(JSONResponse):
    """JSON (UTF-8, non-ASCII kept as is) with the charset stated in the header."""

    media_type = "application/json; charset=utf-8"


class ApiError(StarletteHTTPException):
    """An error answered as ``{"error": code, "message": message}``.

    It is an ``HTTPException`` so that it passes through FastAPI unchanged even when it is
    raised while the request body is being read (see :class:`RequestGuardMiddleware`).
    """

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(status_code=status_code, detail=message)
        self.code = code


_DEFAULT_CODES: dict[int, str] = {
    400: "bad_request",
    404: "not_found",
    405: "method_not_allowed",
    413: "too_large",
    415: "unsupported_media_type",
    422: "invalid_request",
    500: "internal_error",
    501: "not_implemented",
    503: "unavailable",
}


def error_response(status_code: int, code: str, message: str, headers: dict[str, str] | None = None) -> JSONResponse:
    """The JSON error body of the contract."""
    return UTF8JSONResponse({"error": code, "message": message}, status_code=status_code, headers=headers)


async def _http_error(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, StarletteHTTPException)
    code = getattr(exc, "code", None) or _DEFAULT_CODES.get(exc.status_code, "error")
    message = exc.detail if isinstance(exc.detail, str) and exc.detail else HTTPStatus(exc.status_code).phrase
    return error_response(exc.status_code, code, message, headers=getattr(exc, "headers", None))


async def _validation_error(request: Request, exc: Exception) -> Response:
    """422 for missing or invalid fields. The message names the fields and the rule they
    broke, never the value that was sent (it can be a child's text)."""
    assert isinstance(exc, RequestValidationError)
    missing: list[str] = []
    invalid: list[str] = []
    for err in exc.errors():
        loc = [str(p) for p in err.get("loc", ()) if p not in ("body", "query", "path", "header", "cookie")]
        name = ".".join(loc) or "body"
        if err.get("type") == "missing":
            missing.append(name)
        else:
            invalid.append(f"{name} ({err.get('msg', 'invalid')})")
    if missing and not invalid:
        return error_response(422, "missing_field", "Missing field: " + ", ".join(dict.fromkeys(missing)) + ".")
    problems = list(dict.fromkeys(invalid + [f"{m} (missing)" for m in missing]))
    return error_response(422, "invalid_field", "Invalid field: " + "; ".join(problems) + ".")


# ---------------------------------------------------------------------------
# Middleware (pure ASGI, so nothing is buffered or re-ordered)
# ---------------------------------------------------------------------------


def _is_api(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


def body_limit(path: str) -> int:
    """The largest request body (bytes) accepted on ``path``."""
    return BODY_LIMITS.get(path.rstrip("/") or "/", MAX_JSON_BYTES)


class ResponseHeadersMiddleware:
    """``Cache-Control: no-store`` on every ``/api/*`` response; ``nosniff`` and
    ``Referrer-Policy: no-referrer`` on every response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        api = _is_api(scope["path"])

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if api:
                    headers["Cache-Control"] = "no-store"
                headers.setdefault("X-Content-Type-Options", "nosniff")
                headers.setdefault("Referrer-Policy", "no-referrer")
            await send(message)

        await self.app(scope, receive, send_with_headers)


class RequestGuardMiddleware:
    """Bounds ``/api/*`` request bodies and answers unexpected errors without logging content.

    A body larger than :func:`body_limit` is refused with 413: at once when its
    ``Content-Length`` says so, otherwise as soon as the bytes received pass the limit
    (the error is raised from ``receive``, inside FastAPI's body parsing, so nothing
    larger is ever parsed). An exception that escapes the app is answered with a JSON 500
    and logged as its class name and the code location that raised it, never its message
    or arguments.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not _is_api(scope["path"]):
            await self.app(scope, receive, send)
            return
        path = scope["path"]
        limit = body_limit(path)
        too_large = f"The request is larger than the {limit / MB:.2f} MB this endpoint accepts."
        declared = Headers(scope=scope).get("content-length")
        if declared is not None and declared.strip().isdigit() and int(declared) > limit:
            log.info("refused %s: declared body of %s bytes, limit %d", path, declared, limit)
            await error_response(413, "too_large", too_large)(scope, receive, send)
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    log.info("refused %s: body passed the %d-byte limit while streaming", path, limit)
                    raise ApiError(413, "too_large", too_large)
            return message

        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except Exception as exc:
            where = "?"
            if exc.__traceback__ is not None:
                frame = traceback.extract_tb(exc.__traceback__)[-1]
                where = f"{os.path.basename(frame.filename)}:{frame.lineno} in {frame.name}"
            log.error("internal error on %s %s: %s at %s", scope.get("method"), path, type(exc).__name__, where)
            if started:
                raise RuntimeError("internal error (details withheld from the log)") from None
            await error_response(500, "internal_error", "Something went wrong on the server.")(scope, receive, send)


class WebMount(Mount):
    """The static web client at ``/``, which leaves ``/api/*`` to the API routes.

    A plain mount at ``/`` matches every path, so a wrong method on an API route (``GET
    /api/tts``) would be served as a missing static file (404) instead of 405.
    """

    def matches(self, scope: Scope) -> tuple[Match, Scope]:
        if scope["type"] == "http" and _is_api(scope["path"]):
            return Match.NONE, {}
        return super().matches(scope)


def keep_uploads_in_memory(max_bytes: int = MAX_BODY_BYTES) -> None:
    """Make Starlette keep uploaded files in memory up to ``max_bytes``.

    Starlette's ``MultiPartParser`` writes each uploaded file into a
    ``SpooledTemporaryFile(max_size=MultiPartParser.spool_max_size)``, which moves to a
    real temporary file on disk once it grows past that size (1 MB by default). With the
    threshold at least as large as any body :class:`RequestGuardMiddleware` lets through,
    an upload can never be written to disk. Raises RuntimeError when the installed
    Starlette has no such setting, rather than silently letting uploads reach the disk.
    """
    if not isinstance(getattr(MultiPartParser, "spool_max_size", None), int):
        raise RuntimeError(
            "starlette.formparsers.MultiPartParser.spool_max_size is missing: cannot keep uploads in memory "
            "with this Starlette version (see requirements.txt)"
        )
    if MultiPartParser.spool_max_size < max_bytes:
        MultiPartParser.spool_max_size = max_bytes


# ---------------------------------------------------------------------------
# Request models and helpers
# ---------------------------------------------------------------------------


class TTSRequest(BaseModel):
    """Body of ``POST /api/tts``."""

    text: str
    lang: LangField
    slow: bool = False


class PhrasesRequest(BaseModel):
    """Body of ``POST /api/dictation/phrases``."""

    text: str
    lang: LangField


def _clean_text(value: str, field: str, lang: Lang | None = None) -> str:
    """A required text field, stripped: 400 when empty (or without a word), or too long."""
    text = value.strip()
    if not text or (lang is not None and not tokenize(text, lang)):
        raise ApiError(400, "empty_text", f"The {field} has no words.")
    if len(text) > MAX_TEXT_CHARS:
        raise ApiError(400, "text_too_long", f"The {field} is longer than {MAX_TEXT_CHARS} characters.")
    return text


def _read_upload(upload: UploadFile, limit: int, what: str) -> bytes:
    """The bytes of an upload (already in memory, see :func:`keep_uploads_in_memory`)."""
    data = upload.file.read(limit + 1)
    if len(data) > limit:
        raise ApiError(413, f"{what}_too_large", f"The {what} is larger than {limit // MB} MB.")
    return data


def _decode_audio(data: bytes) -> np.ndarray:
    """WAV bytes -> 16 kHz PCM, refusing a recording over the length limit unread."""
    try:
        seconds = wav_duration(data)
        if seconds > MAX_AUDIO_SECONDS + AUDIO_SECONDS_TOLERANCE:
            raise ApiError(413, "audio_too_long", f"The recording is longer than {MAX_AUDIO_SECONDS:.0f} seconds.")
        return decode_wav(data)
    except ValueError as exc:  # the messages describe the file format, never its content
        raise ApiError(400, "bad_audio", f"The audio is not a usable WAV file: {exc}.") from None


_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_PNG_METADATA_CHUNKS = (b"eXIf", b"tEXt", b"iTXt", b"zTXt")


def _image_format(data: bytes) -> str | None:
    if data.startswith(_JPEG_MAGIC):
        return "JPEG"
    if data.startswith(_PNG_MAGIC):
        return "PNG"
    return None


def _has_metadata(data: bytes, fmt: str) -> bool:
    """True when the image carries EXIF/XMP (JPEG) or EXIF/text chunks (PNG)."""
    if fmt == "JPEG":
        # APP1 segments (EXIF, XMP) sit before the image data; scan the start of the file.
        head = data[: 2 * 65536]
        return b"Exif\x00\x00" in head or b"http://ns.adobe.com/xap/1.0/" in head
    pos = len(_PNG_MAGIC)
    while pos + 8 <= len(data):
        length = int.from_bytes(data[pos : pos + 4], "big")
        kind = data[pos + 4 : pos + 8]
        if kind in _PNG_METADATA_CHUNKS:
            return True
        if kind == b"IEND":
            break
        pos += 12 + length
    return False


def clean_image(data: bytes) -> bytes:
    """Check an uploaded image and drop its metadata before it goes anywhere.

    Accepts JPEG and PNG (400 ``bad_image`` otherwise). The web client already re-encodes
    photos (which drops EXIF, including a GPS position); an image that still carries EXIF,
    XMP or PNG text chunks is decoded, turned upright from its EXIF orientation, and
    re-encoded without them, in memory. Other images are passed on byte for byte.
    """
    fmt = _image_format(data)
    if fmt is None:
        raise ApiError(400, "bad_image", "The image must be a JPEG or PNG file.")
    if not _has_metadata(data, fmt):
        return data
    try:
        with Image.open(io.BytesIO(data)) as img:
            if img.width * img.height > MAX_IMAGE_PIXELS:
                raise ApiError(400, "bad_image", "The image has too many pixels.")
            upright = ImageOps.exif_transpose(img)
            out = io.BytesIO()
            # Pillow writes metadata only when asked; exif=b"" makes that explicit.
            if fmt == "JPEG":
                if upright.mode not in ("RGB", "L"):
                    upright = upright.convert("RGB")
                upright.save(out, format="JPEG", quality=92, exif=b"")
            else:
                upright.save(out, format="PNG", exif=b"")
    except ApiError:
        raise
    except Exception as exc:  # a broken or hostile file: Pillow raises many kinds
        log.info("image refused: %s", type(exc).__name__)
        raise ApiError(400, "bad_image", "The image could not be read.") from None
    return out.getvalue()


def _quality_unclear(quality: dict) -> bool:
    return bool(quality.get("too_quiet") or quality.get("too_short"))


def looks_like_quran(text: str, quran: Quran | None) -> bool:
    """True when ``text`` is a passage of the Quran.

    Either it is written in the Uthmani Quranic script (:func:`mommy.tts.is_quranic_script`),
    or it has at least :data:`QURAN_GUARD_MIN_WORDS` words and at least
    :data:`QURAN_GUARD_MIN_SCORE` of them are found, in order, at one place of the Quran
    (:meth:`mommy.quran.Quran.locate`, which reads the first 40 words). An ordinary
    sentence that only quotes a few words of an ayah is not refused. Without the Quran
    data only the script test is possible.
    """
    if is_quranic_script(text):
        return True
    if quran is None or not has_arabic(text) or len(tokenize(text, "ar")) < QURAN_GUARD_MIN_WORDS:
        return False
    best = quran.locate(text, top_k=1)
    return bool(best) and best[0]["score"] >= QURAN_GUARD_MIN_SCORE


# ---------------------------------------------------------------------------
# The application
# ---------------------------------------------------------------------------


def create_app(
    settings: Settings,
    transcriber: Transcriber,
    tts: Synthesizer,
    brain: Brain,
    quran: Quran | None,
) -> FastAPI:
    """The Mommy API (see the module docstring) serving ``settings.web_dir`` at ``/``.

    ``quran`` is None when the Tanzil files could not be loaded: ``/api/health`` then
    says ``"quran": false`` and the Quran endpoints answer 503.
    """
    keep_uploads_in_memory(MAX_BODY_BYTES)
    offline = OfflineBrain()

    app = FastAPI(
        title="Mommy",
        version=__version__,
        description="Recitation and dictation tutor prototype (ar, en, fr). See docs/CONTRACT.md.",
        default_response_class=UTF8JSONResponse,
        docs_url=None,  # the interactive docs pages load scripts from a CDN
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.settings = settings
    app.add_exception_handler(StarletteHTTPException, _http_error)
    app.add_exception_handler(RequestValidationError, _validation_error)
    app.add_middleware(RequestGuardMiddleware)
    app.add_middleware(ResponseHeadersMiddleware)

    # -- component helpers -------------------------------------------------------

    def require_asr() -> None:
        if not getattr(transcriber, "available", False):
            reason = getattr(transcriber, "unavailable_reason", None) or "the Whisper model files are missing"
            raise ApiError(503, "asr_unavailable", f"Speech recognition is not available: {reason}.")

    def require_quran() -> Quran:
        if quran is None:
            raise ApiError(503, "quran_unavailable", "The Quran text could not be loaded on this server.")
        return quran

    def refuse_quran(text: str) -> None:
        if looks_like_quran(text, quran):
            raise ApiError(
                422,
                "quran_text",
                "This text is from the Quran. Please use the Quran section: it checks recitation "
                "against the verbatim Tanzil text, without AI and without a synthetic voice.",
            )

    def listen(upload: UploadFile, lang: Lang) -> tuple[str, dict, dict[str, float]]:
        """Audio upload -> (heard text, quality, timings). The recogniser gets the audio
        and the language only, and is not run on an unclear clip."""
        started = time.perf_counter()
        data = _read_upload(upload, MAX_AUDIO_BYTES, "audio")
        n_bytes = len(data)
        pcm = _decode_audio(data)
        del data
        quality = audio_quality(pcm)
        decoded = time.perf_counter()
        heard = ""
        if not _quality_unclear(quality):
            try:
                heard = transcriber.transcribe(pcm, lang)
            except ASRUnavailable as exc:
                raise ApiError(503, "asr_unavailable", "Speech recognition is not available.") from exc
        timings = {"bytes": n_bytes, "decode_s": decoded - started, "asr_s": time.perf_counter() - decoded}
        return heard, quality, timings

    def word_feedback(result: CheckResult, lang: Lang, age: AgeBand, activity: str) -> str:
        """Feedback worded by the brain, or the template when it fails or says nothing."""
        template = feedback.for_result(result, lang, age)
        summary = result_summary(result)
        summary["activity"] = activity
        try:
            text = brain.word_feedback(summary, lang, age)
        except Exception as exc:
            log.warning("word_feedback failed (%s); using the template", type(exc).__name__)
            return template
        text = " ".join(text.split()) if isinstance(text, str) else ""
        return text or template

    def judge(expected: str, heard: str, lang: Lang, age: AgeBand) -> dict:
        """The brain's meaning judgement, or the offline heuristic when it fails."""
        try:
            judged = brain.judge_meaning(expected, heard, lang, age)
            if not isinstance(judged, dict) or judged.get("verdict") not in VERDICTS:
                raise ValueError("unusable judgement")
        except Exception as exc:
            log.warning("judge_meaning failed (%s); using the offline heuristic", type(exc).__name__)
            judged = {**offline.judge_meaning(expected, heard, lang, age), "error": type(exc).__name__}
        return judged

    def quran_feedback_for(checked: dict) -> str:
        if checked["say_again"] or checked["verdict"] == "unclear":
            return feedback.quran_feedback("unclear", None)
        if checked["verdict"] == "correct":
            return feedback.quran_feedback("correct", None)
        first = checked.get("first_error") or {}
        return feedback.quran_feedback(first.get("kind") or "mistakes", first.get("expected_display_word"))

    def quran_range(q: Quran, surah: int, start: int, end: int) -> None:
        if not 1 <= surah <= N_SURAHS:
            raise ApiError(422, "invalid_surah", f"The surah number must be from 1 to {N_SURAHS}.")
        count = q.ayah_count(surah)
        if not 1 <= start <= end <= count:
            raise ApiError(
                422, "invalid_range", f"Surah {surah} has {count} ayat: choose 1 <= from <= to <= {count}."
            )
        if end - start + 1 > MAX_AYAT:
            raise ApiError(422, "range_too_long", f"At most {MAX_AYAT} ayat can be requested at once.")

    # -- general ---------------------------------------------------------------

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        """Which components are available, so the UI can hide what cannot work."""
        tts_ok = bool(getattr(tts, "available", False))
        tts_langs = getattr(tts, "languages", None)
        return {
            "asr": bool(getattr(transcriber, "available", False)),
            "tts": tts_ok,
            "brain": "claude" if getattr(brain, "name", None) == "claude" else "offline",
            "quran": quran is not None,
            "languages": list(LANGUAGES),
            "tts_languages": list(tts_langs) if tts_langs is not None else (list(LANGUAGES) if tts_ok else []),
            "asr_model": settings.asr_model,
            "reasons": {
                "asr": getattr(transcriber, "unavailable_reason", None),
                "tts": getattr(tts, "unavailable_reason", None),
            },
        }

    @app.post("/api/page/read")
    def page_read(
        image: Annotated[UploadFile, File()],
        lang: Annotated[LangField | None, Form()] = None,
    ) -> dict[str, Any]:
        """Read a printed textbook page. Offline, the parent types the text instead."""
        started = time.perf_counter()
        data = _read_upload(image, MAX_IMAGE_BYTES, "image")
        if not data:
            raise ApiError(400, "bad_image", "The image file is empty.")
        data = clean_image(data)
        try:
            page = brain.read_page(data, lang)
        except Exception as exc:
            log.warning("read_page failed (%s); asking the parent to type the text", type(exc).__name__)
            page = {**offline.read_page(data, lang), "error": type(exc).__name__}
        text = page.get("text") if isinstance(page.get("text"), str) else ""
        read_lang = page.get("lang") if page.get("lang") in LANGUAGES else lang
        failed = "error" in page or getattr(brain, "name", None) != "claude"
        out: dict[str, Any] = {
            "text": text,
            "lang": read_lang,
            "notes": page.get("notes") if isinstance(page.get("notes"), str) else "",
            "source": "offline" if failed else "claude",
            "needs_manual": bool(page.get("needs_manual")) or not text.strip(),
            "contains_quran": bool(page.get("contains_quran", False)),
        }
        if "error" in page:
            out["brain_error"] = str(page["error"])
        log.info("page/read: image %d bytes, source %s, %.2f s", len(data), out["source"], time.perf_counter() - started)
        return out

    # -- recitation --------------------------------------------------------------

    @app.post("/api/recite/check")
    def recite_check(
        audio: Annotated[UploadFile, File()],
        expected_text: Annotated[str, Form()],
        lang: Annotated[LangField, Form()],
        mode: Annotated[Literal["strict", "contextual"], Form()],
        age: Annotated[AgeField, Form()],
    ) -> dict[str, Any]:
        """Check a recitation: word by word (strict) or by meaning (contextual)."""
        started = time.perf_counter()
        expected = _clean_text(expected_text, "expected_text", lang)
        refuse_quran(expected)
        require_asr()
        heard, quality, timings = listen(audio, lang)

        if mode == "strict":
            result = check_recitation(expected, heard, lang)
            out: dict[str, Any] = {
                "mode": "strict",
                "heard_text": heard,
                "result": dataclasses.asdict(result),
                "feedback": word_feedback(result, lang, age, "recitation"),
                "quality": quality,
                "say_again": result.say_again,
            }
        else:
            if _quality_unclear(quality) or not tokenize(heard, lang):
                judgement: dict[str, Any] = {
                    "verdict": "unclear", "missing_ideas": [], "wrong_ideas": [], "say_again": True,
                }
                text = feedback.say_again(lang, age)
            else:
                judged = judge(expected, heard, lang, age)
                judgement = {
                    "verdict": judged["verdict"],
                    "missing_ideas": [str(x) for x in judged.get("missing_ideas") or []],
                    "wrong_ideas": [str(x) for x in judged.get("wrong_ideas") or []],
                    "say_again": False,
                }
                if "approximate" in judged:
                    judgement["approximate"] = bool(judged["approximate"])
                text = judged.get("feedback") if isinstance(judged.get("feedback"), str) else ""
                text = " ".join(text.split()) or meaning_feedback(
                    judgement["verdict"], judgement["missing_ideas"], lang, age
                )
            out = {
                "mode": "contextual",
                "heard_text": heard,
                "judgement": judgement,
                "feedback": text,
                "quality": quality,
                "say_again": judgement["say_again"],
            }
        log.info(
            "recite/check %s %s: audio %d bytes, %.1f s, decode %.2f s, asr %.2f s, total %.2f s",
            mode, lang, timings["bytes"], quality["seconds"], timings["decode_s"], timings["asr_s"],
            time.perf_counter() - started,
        )
        return out

    # -- dictation ---------------------------------------------------------------

    @app.post("/api/dictation/phrases")
    def dictation_phrases(body: PhrasesRequest) -> dict[str, Any]:
        """Cut the text into the phrases read out one at a time."""
        text = _clean_text(body.text, "text")
        refuse_quran(text)
        return {"phrases": split_phrases(text, body.lang)}

    @app.post("/api/tts")
    def speak(body: TTSRequest) -> Response:
        """WAV speech for a phrase or a feedback message (never Quran text).

        Slow (dictation) speech is checked by transcribing it unprompted; the
        ``X-Speech-Check`` header says ``passed``, ``failed`` (after
        :data:`SPEECH_CHECK_ATTEMPTS` takes) or ``skipped`` (normal speed, or no
        recogniser).
        """
        started = time.perf_counter()
        text = body.text
        if not text.strip():
            raise ApiError(400, "empty_text", "The text is empty.")
        if len(text) > MAX_TTS_CHARS:
            raise ApiError(400, "text_too_long", f"The text is longer than {MAX_TTS_CHARS} characters.")
        refuse_quran(text)
        check = "skipped"
        try:
            if body.slow and getattr(transcriber, "available", False):
                try:
                    spoken = synthesize_verified(
                        tts, transcriber, text, body.lang, slow=True, attempts=SPEECH_CHECK_ATTEMPTS
                    )
                    wav, check = spoken.wav, ("passed" if spoken.ok else "failed")
                except ASRUnavailable:
                    wav = tts.synthesize(text, body.lang, slow=True)
            else:
                wav = tts.synthesize(text, body.lang, slow=body.slow)
        except QuranTextRefused:
            raise ApiError(422, "quran_text", "Quran text is never spoken by the synthetic voice.") from None
        except TTSUnavailable:
            reason = getattr(tts, "unavailable_reason", None)
            raise ApiError(
                503, "tts_unavailable", "Speech synthesis is not available" + (f": {reason}." if reason else ".")
            ) from None
        except ValueError:
            raise ApiError(400, "bad_text", "The text has nothing to pronounce.") from None
        log.info(
            "tts %s%s: %d chars -> %d bytes, check %s, %.2f s",
            body.lang, " slow" if body.slow else "", len(text), len(wav), check, time.perf_counter() - started,
        )
        return Response(content=wav, media_type="audio/wav", headers={"X-Speech-Check": check})

    @app.post("/api/dictation/check")
    def dictation_check(
        expected_text: Annotated[str, Form()],
        lang: Annotated[LangField, Form()],
        age: Annotated[AgeField, Form()],
        image: Annotated[UploadFile | None, File()] = None,
        written_text: Annotated[str | None, Form()] = None,
        strict_tashkeel: Annotated[bool, Form()] = False,
    ) -> dict[str, Any]:
        """Check what the child wrote, from a photo (read blind) or typed by the parent."""
        started = time.perf_counter()
        expected = _clean_text(expected_text, "expected_text", lang)
        refuse_quran(expected)
        data = _read_upload(image, MAX_IMAGE_BYTES, "image") if image is not None else b""
        if data and written_text is not None:
            raise ApiError(422, "invalid_request", "Send either image or written_text, not both.")
        if not data and written_text is None:
            raise ApiError(422, "missing_field", "Missing field: image or written_text.")

        uncertain: list[str] = []
        legible = True
        if data:
            data = clean_image(data)
            if getattr(brain, "name", None) != "claude":
                raise ApiError(
                    501, "needs_manual", "Reading handwriting needs Claude. Please type what the child wrote."
                )
            try:
                # Blind: the image and the language only, never the expected text (hard rule 3).
                written = brain.read_handwriting(data, lang)
            except Exception as exc:
                log.warning("read_handwriting failed (%s)", type(exc).__name__)
                written = {"needs_manual": True}
            read_text = written.get("text") if isinstance(written.get("text"), str) else ""
            if written.get("needs_manual") or not read_text.strip():
                raise ApiError(
                    501, "needs_manual", "The handwriting could not be read. Please type what the child wrote."
                )
            if len(read_text) > MAX_TEXT_CHARS:
                raise ApiError(400, "text_too_long", f"The writing is longer than {MAX_TEXT_CHARS} characters.")
            uncertain = [str(w) for w in written.get("uncertain_words") or [] if isinstance(w, str) and w]
            legible = bool(written.get("legible", True))
            source = "claude"
        else:
            assert written_text is not None
            read_text = written_text
            if len(read_text) > MAX_TEXT_CHARS:
                raise ApiError(400, "text_too_long", f"The written_text is longer than {MAX_TEXT_CHARS} characters.")
            source = "typed"

        result = check_writing(expected, read_text, lang, strict_tashkeel=strict_tashkeel)
        out = {
            "read_text": read_text,
            "source": source,
            "uncertain_words": uncertain,
            "legible": legible,
            "result": dataclasses.asdict(result),
            "feedback": word_feedback(result, lang, age, "dictation"),
            "needs_parent_confirmation": True,
        }
        log.info(
            "dictation/check %s: source %s, image %d bytes, %.2f s", lang, source, len(data), time.perf_counter() - started
        )
        return out

    # -- Quran (no brain, no synthesizer) ----------------------------------------

    @app.get("/api/quran/surahs")
    def quran_surahs() -> dict[str, Any]:
        """The 114 surahs with their Arabic names and ayah counts (Tanzil metadata)."""
        q = require_quran()
        return {
            "surahs": q.surahs(),
            "riwaya": RIWAYA,
            "attribution": q.attribution,
            "source_url": SOURCE_URL,
            "licence": getattr(q, "licence", ""),
        }

    @app.get("/api/quran/ayat")
    def quran_ayat(
        surah: Annotated[int, Query()],
        start: Annotated[int, Query(alias="from")],
        end: Annotated[int, Query(alias="to")],
    ) -> dict[str, Any]:
        """Verbatim Uthmani ayat ``from..to`` of a surah (at most 50)."""
        q = require_quran()
        quran_range(q, surah, start, end)
        ayat = [
            {"surah": a.surah, "ayah": a.ayah, "display": a.display, "display_words": list(a.display_words)}
            for a in q.ayat(surah, start, end)
        ]
        return {"ayat": ayat, "attribution": q.attribution, "riwaya": RIWAYA, "source_url": SOURCE_URL}

    @app.post("/api/quran/check")
    def quran_check(
        audio: Annotated[UploadFile, File()],
        surah: Annotated[int, Form()],
        start: Annotated[int, Form(alias="from")],
        end: Annotated[int, Form(alias="to")],
    ) -> dict[str, Any]:
        """Strict check of a recitation of ayat ``from..to`` against the Tanzil text."""
        started = time.perf_counter()
        q = require_quran()
        quran_range(q, surah, start, end)
        require_asr()
        heard, quality, timings = listen(audio, "ar")
        checked = q.check(surah, start, end, heard)
        out = {
            "heard_text": heard,
            **checked,
            "feedback": quran_feedback_for(checked),
            "quality": quality,
            "riwaya": RIWAYA,
            "attribution": q.attribution,
            "source_url": SOURCE_URL,
        }
        log.info(
            "quran/check %d:%d-%d: audio %d bytes, %.1f s, asr %.2f s, total %.2f s",
            surah, start, end, timings["bytes"], quality["seconds"], timings["asr_s"], time.perf_counter() - started,
        )
        return out

    @app.post("/api/quran/locate")
    def quran_locate(
        audio: Annotated[UploadFile | None, File()] = None,
        heard_text: Annotated[str | None, Form()] = None,
        surah: Annotated[int | None, Form()] = None,
    ) -> dict[str, Any]:
        """"Where am I?": find the recited words in the Quran (or in one surah)."""
        q = require_quran()
        if surah is not None and not 1 <= surah <= N_SURAHS:
            raise ApiError(422, "invalid_surah", f"The surah number must be from 1 to {N_SURAHS}.")
        if audio is not None and heard_text is not None:
            raise ApiError(422, "invalid_request", "Send either audio or heard_text, not both.")
        quality: dict | None = None
        if audio is not None:
            require_asr()
            heard, quality, _ = listen(audio, "ar")
        elif heard_text is not None:
            heard = heard_text.strip()
            if len(heard) > MAX_TEXT_CHARS:
                raise ApiError(400, "text_too_long", f"The heard_text is longer than {MAX_TEXT_CHARS} characters.")
        else:
            raise ApiError(422, "missing_field", "Missing field: audio or heard_text.")
        found = bool(tokenize(heard, "ar"))
        candidates = q.locate(heard, top_k=LOCATE_TOP_K, within_surah=surah) if found else []
        return {"heard_text": heard, "candidates": candidates, "say_again": not found, "quality": quality}

    # -- the web client ------------------------------------------------------------

    if settings.web_dir.is_dir():
        app.router.routes.append(WebMount("/", app=StaticFiles(directory=settings.web_dir, html=True), name="web"))
    else:
        log.warning("web client directory missing (%s); serving the API only", settings.web_dir)
    return app


# ---------------------------------------------------------------------------
# Default application (uvicorn mommy.app:build_default_app --factory)
# ---------------------------------------------------------------------------


def _configure_logging() -> None:
    """Send the ``mommy`` loggers to stderr (uvicorn configures only its own loggers).

    The level comes from ``MOMMY_LOG_LEVEL`` (default INFO).
    """
    logger = logging.getLogger("mommy")
    level = (os.environ.get("MOMMY_LOG_LEVEL") or "INFO").strip().upper()
    logger.setLevel(level if level in logging.getLevelNamesMapping() else logging.INFO)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        logger.addHandler(handler)
        logger.propagate = False


def build_default_app() -> FastAPI:
    """The app with the real components: local Whisper and Piper, Claude when configured
    (otherwise offline), and the Tanzil Quran. A component that cannot run is reported
    by ``/api/health`` instead of stopping the server (hard rule 8)."""
    _configure_logging()
    settings = load_settings()
    transcriber = SherpaWhisper.from_settings(settings)
    tts = PiperTTS.from_settings(settings)
    brain = make_brain(settings)
    quran: Quran | None
    started = time.perf_counter()
    try:
        quran = Quran(settings.quran_dir)
    except (OSError, ValueError) as exc:
        log.warning("Quran unavailable (%s: %s)", type(exc).__name__, exc)
        quran = None
    else:
        log.info("Quran text loaded in %.1f s", time.perf_counter() - started)
    log.info(
        "starting: asr=%s (%s) tts=%s brain=%s quran=%s",
        transcriber.available, settings.asr_model, tts.available, brain.name, quran is not None,
    )
    return create_app(settings, transcriber, tts, brain, quran)


__all__ = [
    "BODY_LIMITS",
    "MAX_AUDIO_BYTES",
    "MAX_AUDIO_SECONDS",
    "MAX_AYAT",
    "MAX_BODY_BYTES",
    "MAX_IMAGE_BYTES",
    "MAX_TEXT_CHARS",
    "MAX_TTS_CHARS",
    "ApiError",
    "RequestGuardMiddleware",
    "ResponseHeadersMiddleware",
    "WebMount",
    "body_limit",
    "build_default_app",
    "clean_image",
    "create_app",
    "error_response",
    "keep_uploads_in_memory",
    "looks_like_quran",
]

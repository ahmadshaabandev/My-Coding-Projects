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

The general endpoints also refuse Quran text (``422 quran_text``): a passage of the
Quran is checked only by the Quran section, against the verbatim Tanzil text, and is
never given to the LLM or spoken by the voice. Each use of a text has its guard:
:func:`looks_like_quran` word by word, :func:`looks_like_quran_for_meaning` when the
brain judges the meaning, :func:`is_quran_phrase` for what the voice speaks, and
:func:`dictation_speaks_quran` for a dictation (``scope: "phrase"``). They refuse a text
whose script does not match the chosen language (``422 lang_mismatch``) and a text with
``[?]`` marks where a page reader could not read a word (``400 unreadable_text``).
``POST /api/text/check`` runs those checks alone (no audio, voice or brain) and says
which uses of the text are possible.

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
* Every uploaded image is decoded and re-encoded as a new JPEG of at most 2000 px
  (:func:`clean_image`): no metadata of the upload (EXIF with a GPS position, XMP,
  IPTC, comments, PNG text) reaches the brain. Image and audio decodes run at most two
  at a time.
* The server answers only to its own host names and refuses cross-origin writes to
  the API (:class:`HostOriginMiddleware`); pages may not be framed by other sites.
* Nothing a child said, wrote or photographed is logged: logs carry sizes, durations,
  timings and error class names only. Unexpected errors on ``/api/*`` are answered with a
  JSON 500 and logged as a class name and code location, because exception messages and
  tracebacks can quote content.
* Every ``/api/*`` response has ``Cache-Control: no-store``.

Errors are ``{"error": <code>, "message": <text>}`` with status 400 (bad input, or an
unknown host name), 403 (a cross-origin write), 413 (too large or too long), 422
(missing or invalid fields, Quran text, a language that does not match the text), 501
(the handwriting needs to be typed) or 503 (a component is unavailable, or the server
is busy); unknown paths and methods get 404 and 405 in the same shape, and an internal
error 500.

CPU-heavy and blocking work (speech recognition, synthesis, Claude calls) runs in plain
``def`` endpoints, which FastAPI runs in its thread pool, so the event loop stays free.
"""

from __future__ import annotations

import dataclasses
import io
import json
import logging
import os
import threading
import time
import traceback
import unicodedata
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
from .align import (
    UNREADABLE,
    CheckResult,
    check_recitation,
    check_writing,
    has_unreadable,
    result_summary,
    tokenize_written,
)
from .asr import ASRUnavailable, SherpaWhisper, Transcriber, audio_quality, decode_wav, wav_duration
from .config import DEFAULT_ALLOWED_HOSTS, Settings, load_settings
from .feedback import AgeBand
from .llm import VERDICTS, Brain, OfflineBrain, make_brain, meaning_feedback
from .phrases import split_phrases
from .quran import N_SURAHS, RIWAYA, SOURCE_URL, Quran
from .textnorm import LANGUAGES, Lang, has_arabic, is_arabic_char, tokenize
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
#: Every image is decoded and re-encoded; refuse decoding more pixels than this (the web
#: client sends at most 2000 px on the long edge, about 4 MP). A JPEG is decoded at a
#: reduced scale (1/2, 1/4 or 1/8), so a phone photo of up to 50 MP costs no more.
MAX_IMAGE_PIXELS = 4096 * 4096
MAX_JPEG_PIXELS = 50_000_000
#: Long edge (pixels) of the image passed on to the brain, as the web client resizes.
MAX_IMAGE_EDGE = 2000
#: JPEG quality of the re-encoded image.
IMAGE_QUALITY = 90

#: Image and audio decodes that may run at once (each can take a few hundred MB); a
#: request that waits longer than BUSY_TIMEOUT_S for a slot gets 503 busy.
MAX_CONCURRENT_DECODES = 2
BUSY_TIMEOUT_S = 30.0

#: Largest text field (expected text, typed writing, heard text), in characters.
MAX_TEXT_CHARS = 20_000
#: Largest text field in words: the word alignment needs memory for words x words.
MAX_TEXT_WORDS = 3_000
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
#: ...whose words are found, in order, at one place of the Quran at least this share;
QURAN_GUARD_MIN_SCORE = 0.9
#: or that holds this many consecutive words found consecutively in the Quran;
QURAN_GUARD_RUN_WORDS = 5
#: or, next to a framing formula (قال تعالى, صدق الله العظيم), this many.
QURAN_GUARD_FRAMED_RUN_WORDS = 3
#: Contextual mode (the meaning is judged by the brain): also a run of this many
#: consecutive Quran words, everyday formulas left out (:data:`mommy.quran.EVERYDAY_FORMULAS`).
QURAN_GUARD_CONTEXTUAL_RUN_WORDS = 4
#: A phrase the voice would speak, and a text judged by meaning, may not contain a whole
#: ayah of this many words or more (up to :data:`mommy.quran.SHORT_AYAH_MAX_WORDS`;
#: longer ayat are runs of QURAN_GUARD_RUN_WORDS). Two-word ayat such as ثم نظر are
#: ordinary Arabic and are refused only as a phrase of their own.
QURAN_GUARD_CONTAINED_AYAH_WORDS = 3

#: The Quran guard of a text check: word-by-word recitation (and the dictation check),
#: recitation judged by meaning, or dictation (the voice reads the text out).
GuardMode = Literal["strict", "contextual", "dictation"]

QURAN_TEXT_MESSAGE = (
    "This text is from the Quran. Please use the Quran section: it checks recitation "
    "against the verbatim Tanzil text, without AI and without a synthetic voice."
)
#: The dictation guard, ``scope: "phrase"``: the text may be recited word by word, but a
#: phrase or line of it is or holds a whole ayah (often the basmala on a line of its own),
#: which is never spoken.
QURAN_PHRASE_MESSAGE = (
    "A phrase of this text is or holds a whole ayah of the Quran, which is never read out by "
    "the synthetic voice, so the text cannot be used for dictation. It can still be recited."
)

LangField = Literal["ar", "en", "fr"]
AgeField = Literal["6-9", "10-13", "14-18"]

# ---------------------------------------------------------------------------
# Errors and responses
# ---------------------------------------------------------------------------


class UTF8JSONResponse(JSONResponse):
    """JSON (UTF-8, non-ASCII kept as is) with the charset stated in the header.

    A character that UTF-8 cannot encode (a lone surrogate that slipped through) becomes
    ``?`` instead of failing the whole response; text fields refuse such characters on
    the way in (400 ``bad_text``).
    """

    media_type = "application/json; charset=utf-8"

    def render(self, content: Any) -> bytes:
        return json.dumps(content, ensure_ascii=False, allow_nan=False, indent=None, separators=(",", ":")).encode(
            "utf-8", "replace"
        )


class ApiError(StarletteHTTPException):
    """An error answered as ``{"error": code, "message": message}``.

    It is an ``HTTPException`` so that it passes through FastAPI unchanged even when it is
    raised while the request body is being read (see :class:`RequestGuardMiddleware`).
    """

    def __init__(self, status_code: int, code: str, message: str, *, extra: dict[str, str] | None = None) -> None:
        super().__init__(status_code=status_code, detail=message)
        self.code = code
        #: Extra fields of the error body (``scope`` of a ``quran_text`` refusal).
        self.extra = dict(extra or {})


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


def error_response(
    status_code: int, code: str, message: str, headers: dict[str, str] | None = None, extra: dict[str, str] | None = None
) -> JSONResponse:
    """The JSON error body of the contract (plus any ``extra`` fields)."""
    return UTF8JSONResponse({**(extra or {}), "error": code, "message": message}, status_code=status_code, headers=headers)


async def _http_error(request: Request, exc: Exception) -> Response:
    assert isinstance(exc, StarletteHTTPException)
    code = getattr(exc, "code", None) or _DEFAULT_CODES.get(exc.status_code, "error")
    message = exc.detail if isinstance(exc.detail, str) and exc.detail else HTTPStatus(exc.status_code).phrase
    return error_response(exc.status_code, code, message, headers=getattr(exc, "headers", None), extra=getattr(exc, "extra", None))


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
    """``Cache-Control: no-store`` on every ``/api/*`` response; ``nosniff``,
    ``Referrer-Policy: no-referrer``, ``X-Frame-Options: DENY`` and
    ``Content-Security-Policy: frame-ancestors 'none'`` on every response (a page in
    another site's frame could otherwise drive the app; a CSP meta tag cannot set
    ``frame-ancestors``)."""

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
                headers.setdefault("X-Frame-Options", "DENY")
                headers.setdefault("Content-Security-Policy", "frame-ancestors 'none'")
            await send(message)

        await self.app(scope, receive, send_with_headers)


def _host_name(host: str) -> str:
    """The host name of a ``Host`` header value, lower case, without the port
    (``127.0.0.1:8080`` -> ``127.0.0.1``, ``[::1]:8080`` -> ``::1``)."""
    host = host.strip().lower()
    if host.startswith("["):
        return host[1 : host.find("]")] if "]" in host else host[1:]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


class HostOriginMiddleware:
    """Answers only to the allowed host names, and only same-origin writes to the API.

    * A request whose ``Host`` header names another host gets 400 ``bad_host``: a page
      on another site that re-points its own domain name at 127.0.0.1 (DNS rebinding)
      cannot reach the server, which holds the Claude key and the children's data.
    * A ``/api/*`` request other than GET, HEAD or OPTIONS that carries an ``Origin``
      header gets 403 ``bad_origin`` unless the origin is this server itself
      (``http://<Host>``). A form or ``fetch`` from another site's page is a simple
      request that browsers send without asking first; this refuses it. Clients that
      send no ``Origin`` (curl, tests) are not browsers acting for a third party.
    """

    def __init__(self, app: ASGIApp, allowed_hosts: tuple[str, ...]) -> None:
        self.app = app
        self.allowed = frozenset(h.lower() for h in allowed_hosts)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        host = headers.get("host", "")
        if _host_name(host) not in self.allowed:
            log.info("refused a request for an unknown host")
            await error_response(400, "bad_host", "This server does not answer to that host name.")(scope, receive, send)
            return
        origin = headers.get("origin")
        if (
            origin is not None
            and _is_api(scope["path"])
            and scope.get("method") not in ("GET", "HEAD", "OPTIONS")
            and origin.strip().lower() not in (f"http://{host.strip().lower()}", f"https://{host.strip().lower()}")
        ):
            log.info("refused a cross-origin %s on %s", scope.get("method"), scope["path"])
            await error_response(403, "bad_origin", "Requests from another site are not accepted.")(scope, receive, send)
            return
        await self.app(scope, receive, send)


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


class TextCheckRequest(BaseModel):
    """Body of ``POST /api/text/check``. ``text`` has the limits of every text field
    (checked by the endpoint, which answers ``text_too_long``); ``mode`` defaults to
    ``"strict"``."""

    text: str
    lang: LangField
    mode: GuardMode | None = "strict"


def _check_chars(text: str, field: str) -> None:
    """400 ``bad_text`` for text that cannot be encoded (a lone UTF-16 surrogate, which
    JSON can carry but UTF-8 cannot), and 400 ``text_too_long`` past the size limits."""
    if any("\ud800" <= c <= "\udfff" for c in text):
        raise ApiError(400, "bad_text", f"The {field} contains characters that are not valid text.")
    if len(text) > MAX_TEXT_CHARS:
        raise ApiError(400, "text_too_long", f"The {field} is longer than {MAX_TEXT_CHARS} characters.")


def _check_words(text: str, field: str, lang: Lang) -> None:
    if len(tokenize_written(text, lang)) > MAX_TEXT_WORDS:
        raise ApiError(400, "text_too_long", f"The {field} is longer than {MAX_TEXT_WORDS} words.")


def _clean_text(value: str, field: str, lang: Lang | None = None) -> str:
    """A required text field, stripped: 400 when empty (or without a word), not valid
    text, or too long (characters, or words when ``lang`` is given)."""
    text = value.strip()
    _check_chars(text, field)
    if not text or (lang is not None and not tokenize(text, lang)):
        raise ApiError(400, "empty_text", f"The {field} has no words.")
    if lang is not None:
        _check_words(text, field, lang)
    return text


def _scrub(text: str) -> str:
    """Model output with any lone surrogate replaced by U+FFFD (it cannot be encoded)."""
    if any("\ud800" <= c <= "\udfff" for c in text):
        return "".join("\ufffd" if "\ud800" <= c <= "\udfff" else c for c in text)
    return text


def _refuse_unreadable(text: str, field: str) -> None:
    """400 ``unreadable_text`` for a text with ``[?]`` marks, which a page reader writes
    where it could not read a word: the parent types the missing words first."""
    if has_unreadable(text):
        raise ApiError(
            400, "unreadable_text",
            f"The {field} has [?] where a word could not be read. Please type the missing words first.",
        )


def text_script(text: str) -> Literal["arabic", "latin"] | None:
    """``"arabic"`` when most letters of ``text`` are Arabic, ``"latin"`` when it has
    letters and none of them is Arabic, None otherwise (no letters, or mixed with an
    Arabic minority, such as an English text quoting one Arabic word)."""
    letters = [c for c in text if unicodedata.category(c).startswith("L")]
    if not letters:
        return None
    arabic = sum(1 for c in letters if is_arabic_char(c))
    if arabic * 2 > len(letters):
        return "arabic"
    return "latin" if arabic == 0 else None


def _refuse_lang_mismatch(text: str, lang: Lang, field: str) -> None:
    """422 ``lang_mismatch`` when the text is Arabic and ``lang`` is not, or the reverse.

    The recogniser is built for the chosen language: given Arabic speech with ``lang``
    en it translates it into English, and the child would be told the recording was
    unclear. The voice of one language cannot read the other's script either.
    """
    script = text_script(text)
    if (script == "arabic" and lang != "ar") or (script == "latin" and lang == "ar"):
        written = "Arabic" if script == "arabic" else "not Arabic"
        raise ApiError(
            422, "lang_mismatch",
            f"The {field} is {written}, but the language chosen is {lang}. Please choose the language of the text.",
        )


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


def _image_format(data: bytes) -> str | None:
    if data.startswith(_JPEG_MAGIC):
        return "JPEG"
    if data.startswith(_PNG_MAGIC):
        return "PNG"
    return None


def clean_image(data: bytes) -> bytes:
    """Check an uploaded image and re-encode it, in memory, before it goes anywhere.

    Accepts JPEG and PNG (400 ``bad_image`` otherwise, or for more than
    :data:`MAX_IMAGE_PIXELS` pixels, :data:`MAX_JPEG_PIXELS` for a JPEG, read from the
    header before anything is decoded). Every image is decoded, turned upright from its
    EXIF orientation, reduced to :data:`MAX_IMAGE_EDGE` pixels on the long edge (as the
    web client does) and saved as a new JPEG without any metadata. Nothing of the
    upload's own bytes is passed on: no EXIF (GPS position), XMP, IPTC, ICC, comment or
    PNG text chunk, wherever it sits in the file, and no data after the image. JPEGs are
    decoded at a reduced scale when they are larger than needed, which bounds memory.
    """
    if _image_format(data) is None:
        raise ApiError(400, "bad_image", "The image must be a JPEG or PNG file.")
    try:
        with Image.open(io.BytesIO(data)) as img:
            limit = MAX_JPEG_PIXELS if img.format == "JPEG" else MAX_IMAGE_PIXELS
            if img.width * img.height > limit:
                raise ApiError(400, "bad_image", f"The image has too many pixels (at most {limit // 1_000_000} million).")
            if img.format == "JPEG":
                img.draft("RGB", (MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))  # decode at 1/2, 1/4 or 1/8 scale
            img.load()
            ImageOps.exif_transpose(img, in_place=True)  # no second full-size copy
            upright = img
            if max(upright.size) > MAX_IMAGE_EDGE:
                upright.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
            if upright.mode in ("RGBA", "LA", "PA") or (upright.mode == "P" and "transparency" in upright.info):
                rgba = upright.convert("RGBA")
                flat = Image.new("RGB", rgba.size, (255, 255, 255))  # paper is white
                flat.paste(rgba, mask=rgba.getchannel("A"))
                upright = flat
            elif upright.mode not in ("RGB", "L"):
                upright = upright.convert("RGB")
            out = io.BytesIO()
            # A new file without metadata: Pillow copies the source's JPEG comment unless
            # told otherwise, so the image info is emptied and EXIF set to nothing.
            upright.info = {}
            upright.save(out, format="JPEG", quality=IMAGE_QUALITY, exif=b"", comment=b"")
    except ApiError:
        raise
    except Exception as exc:  # a broken or hostile file: Pillow raises many kinds
        log.info("image refused: %s", type(exc).__name__)
        raise ApiError(400, "bad_image", "The image could not be read.") from None
    return out.getvalue()


def _quality_unclear(quality: dict) -> bool:
    return bool(quality.get("too_quiet") or quality.get("too_short"))


def _guard_tokens(text: str, quran: Quran | None) -> tuple[Quran, list[str], bool] | None:
    """``(quran, tokens, framed)`` for the data-based Quran tests: the words of ``text``
    without framing formulas (:meth:`mommy.quran.Quran.strip_framing`), or None when there
    is nothing to test (no Tanzil text, or no Arabic letter)."""
    if quran is None or not has_arabic(text):
        return None
    tokens, framed = quran.strip_framing(text)
    return quran, tokens, framed


def _quran_passage(quran: Quran, tokens: list[str], framed: bool) -> bool:
    """The data-based part of :func:`looks_like_quran`, on the words without framing."""
    if quran.quran_runs(tokens, QURAN_GUARD_RUN_WORDS):
        return True
    if framed and quran.quran_runs(tokens, QURAN_GUARD_FRAMED_RUN_WORDS):
        return True
    if len(tokens) < QURAN_GUARD_MIN_WORDS:
        return False
    best = quran.locate(" ".join(tokens), top_k=1, min_score=QURAN_GUARD_MIN_SCORE)
    return bool(best) and best[0]["score"] >= QURAN_GUARD_MIN_SCORE


def looks_like_quran(text: str, quran: Quran | None) -> bool:
    """True when ``text`` is, or contains, a passage of the Quran.

    Framing formulas (``قال تعالى``, ``صدق الله العظيم``, the isti'adha, ...; see
    :data:`mommy.quran.FRAMING_FORMULAS`) are left out first. Then the text is Quran when:

    * it is written in the Uthmani Quranic script (:func:`mommy.tts.is_quranic_script`);
    * it holds a run of :data:`QURAN_GUARD_RUN_WORDS` (5) consecutive words found
      consecutively in the Quran (:meth:`mommy.quran.Quran.quran_runs`), wherever it
      sits: a school text that quotes an ayah is refused;
    * next to a framing formula, such a run of :data:`QURAN_GUARD_FRAMED_RUN_WORDS` (3);
    * it has at least :data:`QURAN_GUARD_MIN_WORDS` words and at least
      :data:`QURAN_GUARD_MIN_SCORE` of them are found, in order, at one place
      (:meth:`mommy.quran.Quran.locate`, first 40 words): an ayah with a word changed.

    An ordinary sentence that shares a few words with an ayah is not refused, and nor
    is a text that starts with the basmala. Without the Quran data only the script test
    is possible. This is the guard of word-by-word recitation (strict mode).
    """
    if is_quranic_script(text):
        return True
    found = _guard_tokens(text, quran)
    return found is not None and _quran_passage(*found)


def is_whole_ayah(text: str, quran: Quran | None) -> bool:
    """True when ``text`` (framing formulas left out) is exactly one ayah of two words or
    more (``الله الصمد``)."""
    found = _guard_tokens(text, quran)
    return found is not None and found[0].whole_ayah(found[1]) is not None


def contains_short_ayah(text: str, quran: Quran | None) -> bool:
    """True when the words of ``text`` (framing formulas left out) hold, one after the
    other, a whole ayah of :data:`QURAN_GUARD_CONTAINED_AYAH_WORDS` (3) or 4 words
    (:meth:`mommy.quran.Quran.contained_ayat`), wherever it sits: ``قل هو الله أحد``
    followed by a name, a sentence ending with a three-word ayah. The everyday ayat of
    :data:`mommy.quran.EVERYDAY_AYAT` do not count, and nor do two-word ayat (ثم نظر)."""
    found = _guard_tokens(text, quran)
    return found is not None and bool(found[0].contained_ayat(found[1], QURAN_GUARD_CONTAINED_AYAH_WORDS))


def is_quran_phrase(text: str, quran: Quran | None) -> bool:
    """True when the voice may not speak ``text`` (``/api/tts``, a dictation phrase):
    :func:`looks_like_quran`, a phrase that is exactly a whole ayah of two words or more
    (:func:`is_whole_ayah`), or a phrase that contains a whole short ayah
    (:func:`contains_short_ayah`)."""
    if is_quranic_script(text):
        return True
    found = _guard_tokens(text, quran)
    if found is None:
        return False
    q, tokens, _ = found
    return (
        q.whole_ayah(tokens) is not None
        or bool(q.contained_ayat(tokens, QURAN_GUARD_CONTAINED_AYAH_WORDS))
        or _quran_passage(*found)
    )


def looks_like_quran_for_meaning(text: str, quran: Quran | None) -> bool:
    """The Quran guard of contextual mode, where the brain judges the meaning of the text:
    :func:`looks_like_quran`, or a run of :data:`QURAN_GUARD_CONTEXTUAL_RUN_WORDS` (4)
    consecutive Quran words that does not pass through an everyday formula
    (:data:`mommy.quran.EVERYDAY_FORMULAS`), or a whole short ayah inside the text
    (:func:`contains_short_ayah`)."""
    if is_quranic_script(text):
        return True
    found = _guard_tokens(text, quran)
    if found is None:
        return False
    q, tokens, _ = found
    return (
        bool(q.quran_runs(tokens, QURAN_GUARD_CONTEXTUAL_RUN_WORDS, exclude_formulas=True))
        or bool(q.contained_ayat(tokens, QURAN_GUARD_CONTAINED_AYAH_WORDS))
        or _quran_passage(*found)
    )


def dictation_speaks_quran(text: str, lang: Lang, quran: Quran | None) -> bool:
    """True when a dictation of ``text`` would make the voice speak Quran text, although
    the whole text passed :func:`looks_like_quran` (the ``scope: "phrase"`` refusal).

    Checked with :func:`is_quran_phrase`: every phrase of :func:`split_phrases` and every
    non-empty line of the text (the splitter joins the lines of a paragraph, so the
    basmala on a line of its own without a full stop is glued to the next words), and
    the text's words as a whole for a whole short ayah (:func:`contains_short_ayah`),
    which the splitter may cut between two phrases that are each spoken.
    """
    if contains_short_ayah(text, quran):
        return True
    whole = text.strip()
    if is_whole_ayah(whole, quran):
        return True
    seen = {whole}  # the whole text already passed looks_like_quran and the two tests above
    for part in [*split_phrases(text, lang), *(line.strip() for line in text.splitlines())]:
        if part and part not in seen:
            seen.add(part)
            if is_quran_phrase(part, quran):
                return True
    return False


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
    app.add_middleware(HostOriginMiddleware, allowed_hosts=tuple(getattr(settings, "allowed_hosts", DEFAULT_ALLOWED_HOSTS)))
    app.add_middleware(ResponseHeadersMiddleware)
    decode_slots = threading.BoundedSemaphore(MAX_CONCURRENT_DECODES)

    # -- component helpers -------------------------------------------------------

    def require_asr() -> None:
        if not getattr(transcriber, "available", False):
            reason = getattr(transcriber, "unavailable_reason", None) or "the Whisper model files are missing"
            raise ApiError(503, "asr_unavailable", f"Speech recognition is not available: {reason}.")

    def require_quran() -> Quran:
        if quran is None:
            raise ApiError(503, "quran_unavailable", "The Quran text could not be loaded on this server.")
        return quran

    def quran_guard(text: str, lang: Lang, mode: GuardMode) -> None:
        """422 ``quran_text`` when the text may not be used in ``mode``.

        strict: :func:`looks_like_quran`; contextual: :func:`looks_like_quran_for_meaning`;
        dictation: :func:`looks_like_quran` on the whole text, then
        :func:`dictation_speaks_quran`, which is refused with ``scope: "phrase"`` (the text
        may still be recited word by word).
        """
        if (looks_like_quran_for_meaning if mode == "contextual" else looks_like_quran)(text, quran):
            raise ApiError(422, "quran_text", QURAN_TEXT_MESSAGE)
        if mode == "dictation" and dictation_speaks_quran(text, lang, quran):
            raise ApiError(422, "quran_text", QURAN_PHRASE_MESSAGE, extra={"scope": "phrase"})

    def check_expected(text: str, lang: Lang, field: str, mode: GuardMode = "strict") -> None:
        """The checks of a text a child is to say, write or hear (after :func:`_clean_text`):
        ``[?]`` marks, the Quran guard of ``mode``, then the language."""
        _refuse_unreadable(text, field)
        quran_guard(text, lang, mode)
        _refuse_lang_mismatch(text, lang, field)

    class decoding:
        """One of the :data:`MAX_CONCURRENT_DECODES` slots for a big decode (503 when
        none frees up within :data:`BUSY_TIMEOUT_S`)."""

        def __enter__(self) -> None:
            if not decode_slots.acquire(timeout=BUSY_TIMEOUT_S):
                raise ApiError(503, "busy", "The server is busy. Please try again in a moment.")

        def __exit__(self, *exc: object) -> None:
            decode_slots.release()

    def listen(upload: UploadFile, lang: Lang) -> tuple[str, dict, dict[str, float]]:
        """Audio upload -> (heard text, quality, timings). The recogniser gets the audio
        and the language only, and is not run on an unclear clip."""
        started = time.perf_counter()
        data = _read_upload(upload, MAX_AUDIO_BYTES, "audio")
        n_bytes = len(data)
        with decoding():
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
        template = feedback.for_result(result, lang, age, activity=activity)
        if result.n_unreadable and result.n_errors == result.n_unreadable:
            return template  # only words the reader could not read: not the child's mistakes
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
        stopped = checked.get("stopped_at")
        if stopped and first.get("kind") == "del" and {k: first.get(k) for k in stopped} == stopped:
            return feedback.quran_feedback("stopped", stopped.get("expected_display_word"))
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
            "asr_model": model if isinstance(model := getattr(transcriber, "model", None), str) else settings.asr_model,
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
        with decoding():
            data = clean_image(data)
        try:
            page = brain.read_page(data, lang)
        except Exception as exc:
            log.warning("read_page failed (%s); asking the parent to type the text", type(exc).__name__)
            page = {**offline.read_page(data, lang), "error": type(exc).__name__}
        text = _scrub(page.get("text")) if isinstance(page.get("text"), str) else ""
        read_lang = page.get("lang") if page.get("lang") in LANGUAGES else lang
        failed = "error" in page or getattr(brain, "name", None) != "claude"
        out: dict[str, Any] = {
            "text": text,
            "lang": read_lang,
            "notes": _scrub(page.get("notes")) if isinstance(page.get("notes"), str) else "",
            "source": "offline" if failed else "claude",
            "needs_manual": bool(page.get("needs_manual")) or not text.strip(),
            "contains_quran": bool(page.get("contains_quran", False)),
            # [?] marks where the reader could not read a word; the parent types them.
            "unreadable_marks": sum(1 for t in tokenize_written(text, read_lang or "en") if t == UNREADABLE),
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
        check_expected(expected, lang, "expected_text", mode)
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
        """Cut the text into the phrases read out one at a time.

        The Quran guard is that of ``/api/text/check`` in mode ``dictation``: a text that
        passed :func:`looks_like_quran` (it can be recited and checked) can still hold a
        phrase the voice may not speak, such as the basmala on its own line; that gives
        ``scope: "phrase"``, which tells the client that only dictation is refused.
        """
        text = _clean_text(body.text, "text")  # punctuation only still gives {"phrases": []}
        _check_words(text, "text", body.lang)
        check_expected(text, body.lang, "text", "dictation")
        return {"phrases": split_phrases(text, body.lang)}

    @app.post("/api/text/check")
    def text_check(body: TextCheckRequest) -> dict[str, Any]:
        """Check a text before it is used (Prepare's "Confirm text", a new task).

        The checks of the recite and dictation endpoints, in their order, with no audio,
        voice or brain: the text limits, ``[?]`` marks, the Quran guard of ``mode``, the
        language. The answer also says whether the other uses are possible:
        ``contextual`` (recitation judged by meaning) and ``dictation`` (the voice reads
        it out), so one call in mode ``strict`` answers for all three.
        """
        started = time.perf_counter()
        mode: GuardMode = body.mode or "strict"
        text = _clean_text(body.text, "text", body.lang)
        _refuse_unreadable(text, "text")
        if quran is None and has_arabic(text):
            # The general endpoints fall back to the script test without the Tanzil text;
            # this answer vouches for every mode, which needs the text itself.
            raise ApiError(503, "quran_unavailable", "The Quran text could not be loaded, so the text cannot be checked.")
        quran_guard(text, body.lang, mode)
        _refuse_lang_mismatch(text, body.lang, "text")
        out = {
            "ok": True,
            "words": len(tokenize(text, body.lang)),
            "dictation": mode == "dictation" or not dictation_speaks_quran(text, body.lang, quran),
            "contextual": mode == "contextual" or not looks_like_quran_for_meaning(text, quran),
        }
        log.info(
            "text/check %s %s: %d chars, %d words, %.3f s",
            mode, body.lang, len(text), out["words"], time.perf_counter() - started,
        )
        return out

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
        _check_chars(text, "text")
        _refuse_unreadable(text, "text")
        if is_quran_phrase(text, quran):
            raise ApiError(422, "quran_text", QURAN_TEXT_MESSAGE)
        _refuse_lang_mismatch(text, body.lang, "text")
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
        check_expected(expected, lang, "expected_text")
        data = _read_upload(image, MAX_IMAGE_BYTES, "image") if image is not None else b""
        if data and written_text is not None:
            raise ApiError(422, "invalid_request", "Send either image or written_text, not both.")
        if not data and written_text is None:
            raise ApiError(422, "missing_field", "Missing field: image or written_text.")

        uncertain: list[str] = []
        legible = True
        if data:
            with decoding():
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
            read_text = _scrub(read_text)
            if len(read_text) > MAX_TEXT_CHARS:
                raise ApiError(400, "text_too_long", f"The writing is longer than {MAX_TEXT_CHARS} characters.")
            _check_words(read_text, "writing", lang)
            uncertain = [_scrub(str(w)) for w in written.get("uncertain_words") or [] if isinstance(w, str) and w]
            legible = bool(written.get("legible", True))
            source = "claude"
        else:
            assert written_text is not None
            read_text = written_text
            _check_chars(read_text, "written_text")
            _check_words(read_text, "written_text", lang)
            source = "typed"
        if has_unreadable(read_text) and UNREADABLE not in uncertain:
            uncertain.append(UNREADABLE)  # a word the reader could not read: the parent checks it

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
            _check_chars(heard, "heard_text")
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
        transcriber.available, transcriber.model, tts.available, brain.name, quran is not None,
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
    "MAX_TEXT_WORDS",
    "ApiError",
    "HostOriginMiddleware",
    "RequestGuardMiddleware",
    "ResponseHeadersMiddleware",
    "WebMount",
    "body_limit",
    "build_default_app",
    "clean_image",
    "contains_short_ayah",
    "create_app",
    "dictation_speaks_quran",
    "error_response",
    "is_quran_phrase",
    "is_whole_ayah",
    "keep_uploads_in_memory",
    "looks_like_quran",
    "looks_like_quran_for_meaning",
    "text_script",
]

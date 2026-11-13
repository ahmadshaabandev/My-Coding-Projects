"""The HTTP API of Mommy (FastAPI) and the static web client.

:func:`create_app` wires the components given to it (a :class:`~mommy.asr.Transcriber`, a
:class:`~mommy.tts.Synthesizer`, a :class:`~mommy.llm.Brain` and the
:class:`~mommy.quran.Quran`, or None when its files could not be loaded, and optionally
the local page reader of :mod:`mommy.ocr`) into the API of ``docs/CONTRACT.md``. :func:`build_default_app` builds the real components, for
``uvicorn mommy.app:build_default_app --factory`` (see ``run.sh``).

Flows
-----
* Strict recitation: ``decode_wav`` -> ``audio_quality`` (a clip that is too quiet or
  too short is answered with "say it again" and the recogniser is not run) ->
  ``transcribe(pcm, lang)``, which is never given the expected text (hard rule 1) ->
  ``check_recitation`` (deterministic, hard rule 2) -> ``brain.word_feedback``, which
  only words the result (the templates of :mod:`mommy.feedback` when it fails).
* Contextual recitation: the same audio steps, then ``brain.judge_meaning``.
* Live recitation (``MOMMY_LIVE_RECITE``, default on): ``POST /api/recite/phrase``
  decodes one phrase (the same audio steps, the recogniser still given only the audio and
  the language) and, word by word, checks the words heard so far (``heard_before``, held
  by the client, + the phrase) against the whole text, the words not reached yet
  ``"pending"``; no brain, nothing kept. At the end ``/api/recite/check`` gets only the
  tail with ``heard_before`` and checks the joined text as a whole recording.
* Dictation: ``brain.read_handwriting(image, lang)`` reads the child's paper *blind*
  (hard rule 3; the expected text is not an argument), or the parent types it; then
  ``check_writing`` and feedback. The result always needs the parent's confirmation.
* Page photo (``/api/page/read``): read by Claude with the AI consent, else by the local
  reader (:mod:`mommy.ocr`, PP-OCR on this server; ``MOMMY_OCR``), else typed by the
  parent. Whoever read it, the server then finds the Quran parts in the text.
* Quran: ``transcribe(pcm, "ar")`` -> ``Quran.check`` / ``Quran.locate`` ->
  ``feedback.quran_feedback``. No Quran endpoint touches the brain or the synthesizer
  (hard rule 4).

Quran in the texts of the general endpoints (:mod:`mommy.guard`): a text that *is*
Quran (Q1) is refused (``422 quran_text``) and belongs to the Quran section; a school
text that *includes* Quran (Q2) is used with its Quran parts, which the server finds
from the text in every endpoint (:func:`mommy.guard.find_quran_parts`): recited word by
word against the mushaf words, dictated with a grown-up reading each part, never judged
by meaning (contextual mode refuses it), never spoken by the voice (``/api/tts`` keeps
:func:`is_quran_phrase`), and a mistake in a part gets fixed template feedback without
the brain. The endpoints also refuse a text whose script does not match the chosen
language (``422 lang_mismatch``) and a text with ``[?]`` marks where a page reader could
not read a word (``400 unreadable_text``). ``POST /api/text/check`` runs those checks
alone (no audio, voice or brain), says which uses of the text are possible and lists the
Quran parts.

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
* Every ``/api/*`` response has ``Cache-Control: no-store``; every other one that sets
  none has ``Cache-Control: no-cache``, so a browser asks again before it reuses a file
  of the web client (an updated ``app.js`` is used at the next load).
* Online, with ``MOMMY_ACCESS_CODE`` set, nothing answers without the access cookie
  (:mod:`mommy.access`): ``POST /api/access`` trades the code for it, an HTML
  navigation without it gets the gate page, and every other request a 401. Without the
  variable there is no gate at all.
* The Claude brain is used for a request only with the parent's AI consent, which the
  request carries in its form body as ``ai_consent=1`` (:func:`ai_consent_given`; the
  web client sends it only with a consent that counts). Without it, ``/api/page/read``,
  ``/api/recite/check`` and ``/api/dictation/check`` use the offline brain for that one
  request and Claude is not called at all; each of their answers says which brain
  answered (``"brain"``). The log may name that brain, never a text or the age group.
  A page photo is then read by the local reader on this server (``"reader": "local"``),
  in memory, where nothing leaves the server.

Errors are ``{"error": <code>, "message": <text>}`` with status 400 (bad input, or an
unknown host name), 401 (no access cookie, online only), 403 (a cross-origin write, a
wrong access code), 413 (too large or too long), 422 (missing or invalid fields, Quran
text, a language that does not match the text), 429 (too many wrong access codes), 501
(the handwriting needs to be typed) or 503 (a component is unavailable, or the server
is busy); unknown paths and methods get 404 and 405 in the same shape, and an internal
error 500.

CPU-heavy and blocking work (speech recognition, synthesis, Claude calls) runs in plain
``def`` endpoints, which FastAPI runs in its thread pool, so the event loop stays free.
"""

from __future__ import annotations

import dataclasses
import io
import ipaddress
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
from fastapi import Depends, FastAPI, File, Form, Query, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
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
from .access import (
    ACCESS_COOKIE,
    ACCESS_COOKIE_MAX_AGE,
    ACCESS_PATH,
    BAD_CODE_MESSAGE,
    TOO_MANY_MESSAGE,
    AccessGate,
    AccessGateMiddleware,
    HostMatcher,
    client_key,
    host_key,
    is_public_client,
)
from .align import (
    UNREADABLE,
    CheckResult,
    has_unreadable,
    reading_progress,
    recitation_key,
    result_summary,
    tokenize_written,
)
from .asr import ASRUnavailable, SherpaWhisper, Transcriber, audio_quality, decode_wav, is_empty_wav, wav_duration
from .config import DEFAULT_ALLOWED_HOSTS, Settings, load_settings
from .feedback import AgeBand
from .llm import VERDICTS, Brain, OfflineBrain, make_brain, meaning_feedback
from .ocr import OCRBusy, PageReader, PPOCRReader
from .guard import (
    QURAN_GUARD_CONTAINED_AYAH_WORDS,
    QURAN_GUARD_CONTEXTUAL_RUN_WORDS,
    QURAN_GUARD_FRAMED_GAP_WORDS,
    QURAN_GUARD_FRAMED_RUN_WORDS,
    QURAN_GUARD_MIN_SCORE,
    QURAN_GUARD_MIN_WORDS,
    QURAN_GUARD_RUN_WORDS,
    QURAN_MEANING_MESSAGE,
    QURAN_TEXT_MESSAGE,
    ExpectedWords,
    GuardMode,
    QuranAnalysis,
    contains_short_ayah,
    dictation_speaks_quran,
    find_quran_parts,
    is_quran_phrase,
    is_whole_ayah,
    looks_like_quran,
    looks_like_quran_for_meaning,
)
from .quran import N_SURAHS, RIWAYA, SOURCE_URL, Quran
from .textnorm import LANGUAGES, Lang, has_arabic, is_arabic_char, tokenize
from .tts import PiperTTS, QuranTextRefused, Synthesizer, TTSUnavailable, synthesize_verified

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

#: Largest phrase of a live recitation (``/api/recite/phrase``), in seconds and bytes. The
#: web client cuts a phrase at a pause and at the latest after about 18 s of speech, and
#: merges phrases that queued up while the server was busy into at most 28 s, so 30 s is
#: one Whisper window. 4 MB holds 30 s of 16-bit audio at up to 48 kHz mono (the web
#: client sends 16 kHz: about 1 MB).
MAX_PHRASE_SECONDS = 30.0
MAX_PHRASE_BYTES = 4 * MB

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
    "/api/recite/phrase": MAX_PHRASE_BYTES + FORM_OVERHEAD_BYTES,
    "/api/quran/check": MAX_AUDIO_BYTES + FORM_OVERHEAD_BYTES,
    "/api/quran/locate": MAX_AUDIO_BYTES + FORM_OVERHEAD_BYTES,
    "/api/page/read": MAX_IMAGE_BYTES + FORM_OVERHEAD_BYTES,
    "/api/dictation/check": MAX_IMAGE_BYTES + FORM_OVERHEAD_BYTES,
}
#: The largest body any route accepts: uploads up to this size stay in memory.
MAX_BODY_BYTES = max(BODY_LIMITS.values())

#: Syntheses tried for slow (dictation) speech until the recogniser hears the phrase.
SPEECH_CHECK_ATTEMPTS = 2

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

    def __init__(self, status_code: int, code: str, message: str, *, extra: dict[str, Any] | None = None) -> None:
        super().__init__(status_code=status_code, detail=message)
        self.code = code
        #: Extra fields of the error body (``quran_range`` of a ``quran_text`` refusal).
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
    status_code: int, code: str, message: str, headers: dict[str, str] | None = None, extra: dict[str, Any] | None = None
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
    if any(err.get("type") == "json_invalid" for err in exc.errors()):
        return error_response(422, "invalid_field", "The body is not valid JSON.")
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


#: Sent online (access gate on) to every host but a loopback one: browsers then only ever
#: reach the app over HTTPS, so the access cookie cannot go out in clear text (they
#: ignore the header on a plain-http answer).
HSTS_VALUE = "max-age=31536000"


#: ``Cache-Control`` of a response outside ``/api/*`` that sets none (the web client's
#: files): a browser asks again before it reuses its copy (a cheap 304 with the ETag), so
#: after an update no older ``app.js`` keeps running across reloads (an older client sends
#: no ``ai_consent`` and gets offline answers, RA-6). The access gate sets its own,
#: ``private, no-cache``, which is kept.
STATIC_CACHE_CONTROL = "no-cache"


class ResponseHeadersMiddleware:
    """``Cache-Control: no-store`` on every ``/api/*`` response, and
    :data:`STATIC_CACHE_CONTROL` on any other response that sets none; ``nosniff``,
    ``Referrer-Policy: no-referrer``, ``X-Frame-Options: DENY`` and
    ``Content-Security-Policy: frame-ancestors 'none'`` on every response (a page in
    another site's frame could otherwise drive the app; a CSP meta tag cannot set
    ``frame-ancestors``). With ``hsts`` (online only), also
    ``Strict-Transport-Security`` (:data:`HSTS_VALUE`) on every response for a host that
    is not a loopback one (:func:`is_loopback_host`)."""

    def __init__(self, app: ASGIApp, hsts: bool = False) -> None:
        self.app = app
        self.hsts = hsts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        api = _is_api(scope["path"])
        hsts = self.hsts and not is_loopback_host(_host_name(Headers(scope=scope).get("host", "")))

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if api:
                    headers["Cache-Control"] = "no-store"
                else:
                    headers.setdefault("Cache-Control", STATIC_CACHE_CONTROL)
                if hsts:
                    headers.setdefault("Strict-Transport-Security", HSTS_VALUE)
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


def is_loopback_host(name: str) -> bool:
    """True for a host name that only reaches this machine: ``localhost`` (and
    ``*.localhost``) or a loopback address (``127.0.0.0/8``, ``::1``). ``name`` is a
    :func:`_host_name` (lower case, no port)."""
    if name == "localhost" or name.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


def is_online(settings: Settings) -> bool:
    """True when the app may be used from another device (``/api/health`` ``online``):
    the access gate is on (``settings.access_code``), or an allowed host is not a
    loopback name or address (:func:`is_loopback_host`). False for the default local
    run (``./run.sh``: loopback names only, no gate). The web client's privacy texts
    follow it: online, recordings, photos and texts leave the device for this server."""
    if getattr(settings, "access_code", None):
        return True
    hosts = getattr(settings, "allowed_hosts", DEFAULT_ALLOWED_HOSTS)
    return any(not is_loopback_host(h.strip().lower().strip("[]")) for h in hosts)


class HostOriginMiddleware:
    """Answers only to the allowed host names, and only same-origin writes to the API.

    * A request whose ``Host`` header names another host gets 400 ``bad_host``: a page
      on another site that re-points its own domain name at 127.0.0.1 (DNS rebinding)
      cannot reach the server, which holds the Claude key and the children's data. The
      names are matched by :class:`~mommy.access.HostMatcher`: exact names, and suffix
      entries such as ``.trycloudflare.com`` (any name under it, never the domain itself).
    * A ``/api/*`` request other than GET, HEAD or OPTIONS that carries an ``Origin``
      header gets 403 ``bad_origin`` unless the origin is this server itself
      (``http(s)://<Host>``, :meth:`~mommy.access.HostMatcher.same_origin`, with the
      same matcher): another name under the same suffix (someone else's tunnel) is
      another site. A form or ``fetch`` from another site's page is a simple
      request that browsers send without asking first; this refuses it. Clients that
      send no ``Origin`` (curl, tests) are not browsers acting for a third party.
    * With ``https_only`` (the access gate is on), an ``http://`` origin is this server
      only for a loopback host; and a request for a quick-tunnel name (a suffix entry)
      that the tunnel received over plain http (``X-Forwarded-Proto: http``) is not
      served: a page navigation gets a 308 to the same URL in ``https``, anything else
      400 ``https_required``, so the gate page never takes a code over plain http.
      (Caddy redirects its port 80 itself; the header only comes from the proxy, and a
      client that writes it itself only redirects itself.)

    Raises ValueError for an entry the matcher refuses (a suffix such as ``.com``).
    """

    def __init__(self, app: ASGIApp, allowed_hosts: tuple[str, ...], https_only: bool = False) -> None:
        self.app = app
        self.hosts = HostMatcher(allowed_hosts)
        self.https_only = https_only

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        host = headers.get("host", "")
        if not self.hosts.allows_host(host):
            # The name received (a host name, not personal data; repr and cut, so a forged
            # header cannot forge log lines): it says what MOMMY_ALLOWED_HOSTS lacks.
            log.info("refused a request for an unknown host %r", _host_name(host)[:80])
            await error_response(400, "bad_host", "This server does not answer to that host name.")(scope, receive, send)
            return
        if (
            self.https_only
            and headers.get("x-forwarded-proto", "").strip().lower() == "http"
            and self.hosts.matches_suffix(host)
        ):
            if scope.get("method") in ("GET", "HEAD") and not _is_api(scope["path"]):
                # The name as matched (no port: https's default), the path as received.
                raw_path = scope.get("raw_path") or scope["path"].encode("utf-8")
                query = scope.get("query_string") or b""
                location = "https://" + host_key(host) + raw_path.decode("latin-1")
                if query:
                    location += "?" + query.decode("latin-1")
                await Response(status_code=308, headers={"Location": location, "Cache-Control": "no-store"})(scope, receive, send)
            else:
                await error_response(400, "https_required", "Use the https:// address of this server.")(scope, receive, send)
            return
        origin = headers.get("origin")
        if (
            origin is not None
            and _is_api(scope["path"])
            and scope.get("method") not in ("GET", "HEAD", "OPTIONS")
            and not self.hosts.same_origin(origin, host, https_only=self.https_only)
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


class AccessRequest(BaseModel):
    """Body of ``POST /api/access`` (online only, see :mod:`mommy.access`)."""

    code: str


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


def _lead(value: str) -> int:
    """The characters :func:`_clean_text` strips from the start of a field."""
    return len(value) - len(value.lstrip())


def _quran_fields(analysis: QuranAnalysis, submitted: str) -> dict[str, Any]:
    """``quran_parts`` and ``mushaf_text`` of a response, with offsets into the text as the
    client sent it (``submitted``, of which the analysis saw the stripped text)."""
    lead = _lead(submitted)
    mushaf = analysis.mushaf_text() if analysis.parts else analysis.text
    return {
        "quran_parts": analysis.parts_json(submitted, lead=lead),
        "mushaf_text": submitted[:lead] + mushaf + submitted[lead + len(analysis.text) :],
    }


def _lines(text: str) -> str:
    """``text`` with every line break as ``\\n``. A browser sends the line breaks of a form
    field as ``\\r\\n`` while a textarea's value holds ``\\n``: with this, what a form
    endpoint echoes (``read_text``) and the offsets of its Quran parts refer to the text
    the client holds, as for the JSON endpoints."""
    return text.replace("\r\n", "\n").replace("\r", "\n") if "\r" in text else text


def _scrub(text: str) -> str:
    """Model output with any lone surrogate replaced by U+FFFD (it cannot be encoded), and
    its line breaks as ``\\n`` (:func:`_lines`)."""
    text = _lines(text)
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


def _decode_audio(data: bytes, max_seconds: float = MAX_AUDIO_SECONDS, *, allow_empty: bool = False) -> np.ndarray:
    """WAV bytes -> 16 kHz PCM, refusing a recording over the length limit unread. With
    ``allow_empty`` (the tail of a live recitation), a WAV file with no samples gives an
    empty clip instead of 400 ``bad_audio``."""
    if allow_empty and is_empty_wav(data):
        return np.zeros(0, dtype=np.float32)
    try:
        seconds = wav_duration(data)
        if seconds > max_seconds + AUDIO_SECONDS_TOLERANCE:
            raise ApiError(413, "audio_too_long", f"The recording is longer than {max_seconds:.0f} seconds.")
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


# -- live recitation (extra: /api/recite/phrase and the tail of /api/recite/check) ----------

HEARD_BEFORE_PHRASE_DOC = (
    "Optional: the transcripts (heard_text) of the earlier phrases of this recitation, joined "
    "by spaces, in order, as this endpoint returned them; empty for the first phrase. Held by "
    "the client: the server keeps nothing between requests. At most 20,000 characters and "
    "3,000 words."
)
HEARD_BEFORE_CHECK_DOC = (
    "Optional (a live recitation): the transcripts of the phrases already decoded by "
    "/api/recite/phrase, joined by spaces, in order (may be empty). With it, audio is only "
    "the tail of the recording after those phrases (a WAV with no samples when nothing was "
    "said after them): only the tail is decoded, and the recitation is checked as "
    "heard_before + the tail. quality then describes the tail, except that too_quiet and "
    "too_short are false when heard_before has a word. Without it (older clients), audio is "
    "the whole recording, as before."
)
PHRASE_AUDIO_DOC = "One phrase of the recitation as a WAV file: at most 30 seconds and 4 MB."


async def heard_before_sent(request: Request) -> bool:
    """True when the form body has a ``heard_before`` field, empty or not: a live
    recitation whose earlier phrases were heard as nothing still sends only its tail.
    (FastAPI reads an empty form field as a missing one, so the parameter alone cannot
    tell an empty ``heard_before`` from an older client that does not send it.)"""
    form = await request.form()
    return any(isinstance(v, str) for v in form.getlist("heard_before"))


#: The dependency of /api/recite/check that tells a live tail from a whole recording.
HeardBeforeSent = Annotated[bool, Depends(heard_before_sent)]


def _heard_before(value: str, lang: Lang) -> str:
    """The ``heard_before`` field of a live recitation, stripped, with ``\\n`` line breaks:
    400 ``bad_text`` or ``text_too_long`` (characters, then words) as for a text field;
    empty is allowed (nothing heard yet)."""
    text = _lines(value).strip()
    _check_chars(text, "heard_before")
    _check_words(text, "heard_before", lang)
    return text


def join_heard(before: str, heard: str) -> str:
    """What was heard of a whole recitation: the earlier phrases' transcripts, then this
    one (a space between, none around an empty one)."""
    return " ".join(t for t in (before, heard) if t)


def live_quality(tail: dict, before: str, lang: Lang) -> dict:
    """The quality of a live recitation checked from its tail (``/api/recite/check`` with
    ``heard_before``).

    ``seconds`` and ``rms`` are the tail's, and the tail alone decides whether it is
    decoded. But ``too_quiet`` and ``too_short`` say whether the *recitation* could be
    heard: when ``heard_before`` has a word, the earlier phrases were long and loud enough
    to be recognised, so both are False, whatever the tail (a child who stops right after
    the last pause sends a tail of a fraction of a second, or none). With nothing heard
    before, the tail is all there is to judge, and its own flags stand (no samples at all:
    both True, and the check asks to say it again).
    """
    if tokenize(before, lang):
        return {**tail, "too_quiet": False, "too_short": False}
    return dict(tail)


#: The form field by which a request carries the parent's AI consent (hard rule 5).
AI_CONSENT_FIELD = "ai_consent"
#: The only value of :data:`AI_CONSENT_FIELD` that counts as the consent.
AI_CONSENT_VALUE = "1"


async def ai_consent_given(request: Request) -> bool:
    """True only when the request's form body has :data:`AI_CONSENT_FIELD`, and every
    copy of it is exactly ``"1"``.

    The field is opt-in, so anything else means no consent and the request is answered
    without Claude: no field (a client that does not know it, such as a tab still running
    an older ``app.js``), an empty value, ``"0"``, ``"true"``, ``" 1"``, a file part, and a
    field sent twice with any other value beside ``"1"``. The query string is never read:
    a field there does not count. The form is the one FastAPI has already parsed for the
    endpoint's other fields (Starlette keeps it), so nothing is read twice.
    """
    form = await request.form()
    values = form.getlist(AI_CONSENT_FIELD)
    return bool(values) and all(isinstance(v, str) and v == AI_CONSENT_VALUE for v in values)


#: The dependency of every endpoint whose handling can reach the Claude brain.
AiConsent = Annotated[bool, Depends(ai_consent_given)]

#: How /api/openapi.json describes :data:`AI_CONSENT_FIELD` (:func:`document_ai_consent`).
AI_CONSENT_SCHEMA: dict[str, Any] = {
    "type": "string",
    "title": "Ai Consent",
    "description": (
        "Optional, opt-in: the parent's AI consent. Only the exact value \"1\" in the form body "
        "counts, and a field sent more than once counts only when every copy is \"1\". No field, "
        "any other value, a file part, and the field in the query string mean no consent: the "
        "request is then answered by the offline brain and Claude is not called for it."
    ),
}
#: How /api/openapi.json describes the ``brain`` of an answer (:func:`document_ai_consent`).
BRAIN_SCHEMA: dict[str, Any] = {
    "type": "string",
    "enum": ["claude", "offline"],
    "title": "Brain",
    "description": (
        "The brain that had the request: \"offline\" means that nothing of it went to Claude "
        "(no AI consent, or no Claude on the server); \"claude\" means the Claude brain had it "
        "(it may still have fallen back to the offline answer after an error)."
    ),
}


def _uses_ai_consent(dependant: Any) -> bool:
    """True when :func:`ai_consent_given` is one of the dependencies, at any depth."""
    return any(dep.call is ai_consent_given or _uses_ai_consent(dep) for dep in dependant.dependencies)


def document_ai_consent(schema: dict[str, Any], routes: Any) -> dict[str, Any]:
    """Adds the AI consent to an OpenAPI ``schema`` (in place, and returns it): the form
    field :data:`AI_CONSENT_FIELD` to the request body, and ``brain`` to the success
    answer, of every route that depends on :func:`ai_consent_given`.

    :func:`ai_consent_given` reads the field from the parsed form itself (so that a field
    sent twice counts only when every copy is ``"1"``, and a file part or any other value
    is no consent rather than a 422), so the field is no parameter of the endpoints and
    FastAPI would not list it. Only the published description changes here; how a request
    is read does not.
    """
    components = schema.get("components", {}).get("schemas", {})
    for route in routes:
        if not isinstance(route, APIRoute) or not _uses_ai_consent(route.dependant):
            continue
        for method in route.methods:
            operation = schema.get("paths", {}).get(route.path_format, {}).get(method.lower())
            if operation is None:
                continue
            for media in operation.get("requestBody", {}).get("content", {}).values():
                body = media.setdefault("schema", {})
                ref = body.get("$ref", "")
                if ref.startswith("#/components/schemas/"):
                    body = components[ref.rsplit("/", 1)[1]]
                body.setdefault("properties", {})[AI_CONSENT_FIELD] = dict(AI_CONSENT_SCHEMA)
            for media in operation.get("responses", {}).get("200", {}).get("content", {}).values():
                answer = media.setdefault("schema", {})
                answer.setdefault("properties", {})["brain"] = dict(BRAIN_SCHEMA)
                required = answer.setdefault("required", [])
                if "brain" not in required:
                    required.append("brain")
    return schema


def brain_name(brain: Any) -> Literal["claude", "offline"]:
    """``"claude"`` for the Claude brain, ``"offline"`` for anything else."""
    return "claude" if getattr(brain, "name", None) == "claude" else "offline"


# ---------------------------------------------------------------------------
# The application
# ---------------------------------------------------------------------------


def create_app(
    settings: Settings,
    transcriber: Transcriber,
    tts: Synthesizer,
    brain: Brain,
    quran: Quran | None,
    reader: PageReader | None = None,
) -> FastAPI:
    """The Mommy API (see the module docstring) serving ``settings.web_dir`` at ``/``.

    ``quran`` is None when the Tanzil files could not be loaded: ``/api/health`` then
    says ``"quran": false`` and the Quran endpoints answer 503.

    ``reader`` is the local page reader (:class:`mommy.ocr.PPOCRReader`), used by
    ``/api/page/read`` when Claude may not read the photo; None (``MOMMY_OCR=off``, or
    a caller that has none) or one that is not ``available``: ``/api/health`` says
    ``"ocr": false`` and such a photo needs the parent to type the text.

    With ``settings.access_code`` set, the access gate of :mod:`mommy.access` guards
    every request and ``POST /api/access`` is added; without it, neither exists.
    """
    keep_uploads_in_memory(MAX_BODY_BYTES)
    offline = OfflineBrain()

    def brain_for(consent: bool) -> Brain:
        """The brain of one request: ``brain`` when it is the Claude brain and the request
        carries the parent's AI consent (:func:`ai_consent_given`), else the offline
        brain, so that Claude is not called at all for it."""
        return brain if consent and brain_name(brain) == "claude" else offline

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
    access_code = getattr(settings, "access_code", None)
    gate = AccessGate(access_code, settings.web_dir) if access_code else None
    app.state.access_gate = gate
    # Middleware order. Starlette runs the middleware added LAST first, so a request goes
    #   ResponseHeaders -> HostOrigin -> AccessGate (online only) -> RequestGuard -> routes
    # * ResponseHeaders is outermost, so every answer, the gate's own included (its page
    #   and its 401s), gets nosniff, no-referrer, the anti-framing headers and, on
    #   /api/*, Cache-Control: no-store.
    # * HostOrigin comes before the gate: an unknown Host is refused before anything else
    #   (DNS rebinding), and POST /api/access is a write like any other, so a page on
    #   another site cannot post a code with its Origin (403 bad_origin).
    # * The gate comes before RequestGuard and the routes: without the cookie no endpoint
    #   and no static file runs, and no request body is even read (a large upload is
    #   answered 401 at once). Only POST /api/access and the gate page's own files pass,
    #   and RequestGuard still bounds that POST's body and answers its errors.
    app.add_middleware(RequestGuardMiddleware)
    if gate is not None:
        app.add_middleware(AccessGateMiddleware, gate=gate)
    app.add_middleware(
        HostOriginMiddleware,
        allowed_hosts=tuple(getattr(settings, "allowed_hosts", DEFAULT_ALLOWED_HOSTS)),
        https_only=gate is not None,
    )
    app.add_middleware(ResponseHeadersMiddleware, hsts=gate is not None)
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

    def quran_guard(analysis: QuranAnalysis, text: str, mode: GuardMode) -> None:
        """422 ``quran_text`` when the text may not be used in ``mode``.

        Every mode refuses a text that is Quran (Q1, :func:`mommy.guard.find_quran_parts`),
        with ``quran_range`` when its ayat are one range of one surah, and a text with
        Uthmani script outside its Quran parts. Contextual mode also refuses a school text
        with Quran parts (Q2) and the by-meaning guard (:func:`looks_like_quran_for_meaning`):
        the brain never judges the meaning of Quran words. A dictation of a Q2 text has a
        grown-up read its Quran parts, so mode ``dictation`` refuses nothing more, unless
        the safety net :attr:`mommy.guard.QuranAnalysis.voice_safe` is False.
        """
        if analysis.refused:
            ref = analysis.quran_range()
            raise ApiError(422, "quran_text", QURAN_TEXT_MESSAGE, extra={"quran_range": ref} if ref else None)
        if mode == "contextual" and (analysis.parts or looks_like_quran_for_meaning(text, quran)):
            # "reason": "meaning" tells this refusal (a school text with Quran words, which
            # can be recited word by word) from a text that is Quran (Q1).
            raise ApiError(422, "quran_text", QURAN_MEANING_MESSAGE, extra={"reason": "meaning"})
        if mode == "dictation" and not analysis.voice_safe:
            raise ApiError(422, "quran_text", QURAN_TEXT_MESSAGE)

    def check_expected(text: str, lang: Lang, field: str, mode: GuardMode = "strict") -> QuranAnalysis:
        """The checks of a text a child is to say, write or hear (after :func:`_clean_text`):
        ``[?]`` marks, the Quran guard of ``mode``, then the language. Returns the text's
        Quran analysis, recomputed from the text itself."""
        _refuse_unreadable(text, field)
        analysis = find_quran_parts(text, lang, quran)
        quran_guard(analysis, text, mode)
        _refuse_lang_mismatch(text, lang, field)
        return analysis

    class decoding:
        """One of the :data:`MAX_CONCURRENT_DECODES` slots for a big decode (503 when
        none frees up within :data:`BUSY_TIMEOUT_S`)."""

        def __enter__(self) -> None:
            if not decode_slots.acquire(timeout=BUSY_TIMEOUT_S):
                raise ApiError(503, "busy", "The server is busy. Please try again in a moment.")

        def __exit__(self, *exc: object) -> None:
            decode_slots.release()

    def listen(
        upload: UploadFile,
        lang: Lang,
        *,
        max_bytes: int = MAX_AUDIO_BYTES,
        max_seconds: float = MAX_AUDIO_SECONDS,
        allow_empty: bool = False,
    ) -> tuple[str, dict, dict[str, float]]:
        """Audio upload -> (heard text, quality, timings). The recogniser gets the audio
        and the language only, and is not run on an unclear clip (an empty one included,
        see ``allow_empty`` of :func:`_decode_audio`)."""
        started = time.perf_counter()
        data = _read_upload(upload, max_bytes, "audio")
        n_bytes = len(data)
        with decoding():
            pcm = _decode_audio(data, max_seconds, allow_empty=allow_empty)
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

    def word_feedback(
        used: Brain,
        result: CheckResult,
        lang: Lang,
        age: AgeBand,
        activity: str,
        expected: ExpectedWords | None = None,
    ) -> tuple[str, bool]:
        """``(feedback, is_quran)``: the wording of ``used`` (the request's brain,
        :func:`brain_for`), or the template when it fails or says nothing. When a mistake
        lies in a Quran part (``expected.quran``), the brain is not called at all, so it
        never receives a Quran word: a first mistake there gets the fixed Quran-part
        template quoting the mushaf word (``is_quran`` True: shown, never spoken), any
        other first mistake the ordinary template."""
        template = feedback.for_result(result, lang, age, activity=activity)
        if result.n_unreadable and result.n_errors == result.n_unreadable:
            return template, False  # only words the reader could not read: not the child's mistakes
        if expected is not None and expected.quran:
            errors = [(k, op) for k, op in enumerate(result.ops) if op.kind != "match" and op.heard != UNREADABLE]

            def where(k: int, op: Any) -> int | None:
                if op.exp_index is not None:
                    return op.exp_index
                later = next((o.exp_index for o in result.ops[k + 1 :] if o.exp_index is not None), None)
                if later is not None:
                    return later
                return next((o.exp_index for o in reversed(result.ops[:k]) if o.exp_index is not None), None)

            if any(where(k, op) in expected.quran for k, op in errors):
                if result.say_again or not errors:
                    return template, False
                k, first = errors[0]
                index = where(k, first)
                if index not in expected.quran:
                    return template, False
                kind = "stopped" if first.kind == "del" and index == result.stopped_at_exp_index else first.kind
                return feedback.quran_part_feedback(kind, expected.display[index], lang, activity), True
        summary = result_summary(result)
        summary["activity"] = activity
        heard = [e["heard"] for e in summary["errors"] if e.get("heard")]
        if heard and is_quran_phrase(" ".join(heard), quran):
            return template, False  # the child said Quran words: the brain never gets them
        if expected is not None and expected.quran:
            # A text with Quran parts: a word the child added (an ayah said on past the end
            # of the text) or a word of a part said elsewhere is a Quran word, so the brain
            # never gets it; a mistake outside the parts keeps the word heard.
            part_keys = {recitation_key(expected.tokens[i], lang) for i in expected.quran}
            summary["errors"] = [
                {**e, "heard": None}
                if e.get("heard") and (e["kind"] == "ins" or recitation_key(e["heard"], lang) in part_keys)
                else e
                for e in summary["errors"]
            ]
        try:
            text = used.word_feedback(summary, lang, age)
        except Exception as exc:
            log.warning("word_feedback failed (%s); using the template", type(exc).__name__)
            return template, False
        text = " ".join(text.split()) if isinstance(text, str) else ""
        return text or template, False

    def judge(used: Brain, expected: str, heard: str, lang: Lang, age: AgeBand) -> dict:
        """The meaning judgement of ``used`` (the request's brain), or the offline
        heuristic when it fails."""
        try:
            judged = used.judge_meaning(expected, heard, lang, age)
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

    online = is_online(settings)
    live = bool(getattr(settings, "live_recite", True))
    if reader is not None and not getattr(settings, "ocr", True):
        reader = None  # MOMMY_OCR=off: never used, whatever the caller passed

    def local_reader() -> PageReader | None:
        return reader if reader is not None and getattr(reader, "available", False) else None

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        """Which components are available, so the UI can hide what cannot work, and
        whether the app is online (so the UI says where the children's data goes)."""
        tts_ok = bool(getattr(tts, "available", False))
        tts_langs = getattr(tts, "languages", None)
        return {
            "asr": bool(getattr(transcriber, "available", False)),
            "tts": tts_ok,
            "brain": brain_name(brain),
            "quran": quran is not None,
            "online": online,
            "languages": list(LANGUAGES),
            "tts_languages": list(tts_langs) if tts_langs is not None else (list(LANGUAGES) if tts_ok else []),
            "live_recite": live,
            "ocr": local_reader() is not None,
            "asr_model": model if isinstance(model := getattr(transcriber, "model", None), str) else settings.asr_model,
            "reasons": {
                "asr": getattr(transcriber, "unavailable_reason", None),
                "tts": getattr(tts, "unavailable_reason", None),
                "ocr": (
                    "MOMMY_OCR is off"
                    if reader is None
                    else None if local_reader() is not None else getattr(reader, "unavailable_reason", None)
                ),
            },
        }

    @app.post("/api/page/read")
    def page_read(
        image: Annotated[UploadFile, File()],
        consent: AiConsent,
        lang: Annotated[LangField | None, Form()] = None,
    ) -> dict[str, Any]:
        """Read a printed textbook page: with Claude when the request carries the AI
        consent (``ai_consent=1``) and the server has Claude; otherwise (or when Claude
        fails) with the local reader on this server (``"reader": "local"``, when
        ``/api/health`` says ``"ocr": true``); otherwise the parent types the text."""
        started = time.perf_counter()
        used = brain_for(consent)
        data = _read_upload(image, MAX_IMAGE_BYTES, "image")
        if not data:
            raise ApiError(400, "bad_image", "The image file is empty.")
        with decoding():
            data = clean_image(data)
        page: dict[str, Any] = {}
        who = "none"
        if brain_name(used) == "claude":
            who = "claude"
            try:
                page = used.read_page(data, lang)
            except Exception as exc:
                log.warning("read_page failed (%s)", type(exc).__name__)
                page = {**offline.read_page(data, lang), "error": type(exc).__name__}
        local = local_reader()
        if local is not None and (who == "none" or "error" in page):
            # No Claude for this request, or Claude failed: read it here.
            brain_error = page.get("error")
            who = "local"
            try:
                page = local.read_page(data, lang, timeout=BUSY_TIMEOUT_S)
            except OCRBusy:
                raise ApiError(503, "busy", "The server is busy. Please try again in a moment.") from None
            except Exception as exc:
                log.warning("local page reading failed (%s); asking the parent to type the text", type(exc).__name__)
                page = {**offline.read_page(data, lang), "reader_error": type(exc).__name__}
            if brain_error is not None:
                page["error"] = brain_error
        elif who == "none":
            page = offline.read_page(data, lang)
        text = _scrub(page.get("text")) if isinstance(page.get("text"), str) else ""
        read_lang = page.get("lang") if page.get("lang") in LANGUAGES else lang
        failed = "error" in page or brain_name(used) != "claude"
        written = tokenize_written(text, read_lang or "en")
        contains_quran = bool(page.get("contains_quran", False))
        quran_fields: dict[str, Any] = {"quran_parts": [], "mushaf_text": text, "quran_range": None}
        if quran is not None and has_arabic(text) and len(text) <= MAX_TEXT_CHARS and len(written) <= MAX_TEXT_WORDS:
            # The server decides, from the text read: a page that is Quran (Q1) keeps the
            # "page is Quran" answer; a school page with Quran parts (Q2) is read as usual.
            analysis = find_quran_parts(text.strip(), read_lang or "ar", quran)
            contains_quran = analysis.refused
            quran_fields = {**_quran_fields(analysis, text), "quran_range": analysis.quran_range()}
        out: dict[str, Any] = {
            "text": text,
            "lang": read_lang,
            "notes": _scrub(page.get("notes")) if isinstance(page.get("notes"), str) else "",
            "source": "offline" if failed else "claude",
            "needs_manual": bool(page.get("needs_manual")) or not text.strip(),
            "contains_quran": contains_quran,
            # [?] marks where the reader could not read a word; the parent types them.
            "unreadable_marks": sum(1 for t in written if t == UNREADABLE),
            **quran_fields,
            "brain": brain_name(used),
            # Who read the photo: "claude", "local" (this server, no AI) or "none" (the
            # parent types the text).
            "reader": who,
        }
        if "error" in page:
            out["brain_error"] = str(page["error"])
        if "reader_error" in page:
            out["reader_error"] = str(page["reader_error"])
        log.info(
            "page/read: image %d bytes, brain %s, source %s, reader %s, %.2f s",
            len(data), out["brain"], out["source"], who, time.perf_counter() - started,
        )
        return out

    # -- recitation --------------------------------------------------------------

    @app.post("/api/recite/check")
    def recite_check(
        audio: Annotated[UploadFile, File()],
        expected_text: Annotated[str, Form()],
        lang: Annotated[LangField, Form()],
        mode: Annotated[Literal["strict", "contextual"], Form()],
        age: Annotated[AgeField, Form()],
        consent: AiConsent,
        live_tail: HeardBeforeSent,
        heard_before: Annotated[str | None, Form(description=HEARD_BEFORE_CHECK_DOC)] = None,
    ) -> dict[str, Any]:
        """Check a recitation: word by word (strict) or by meaning (contextual). Claude
        words the feedback and judges the meaning only with the AI consent; without it the
        offline templates and the offline meaning heuristic answer.

        With ``heard_before`` (a live recitation: what ``/api/recite/phrase`` heard of the
        phrases before), ``audio`` is only the tail after them: the recogniser decodes the
        tail alone, and the check runs on ``heard_before`` + the tail exactly as on a whole
        recording. See :func:`live_quality` for the quality of such a check."""
        started = time.perf_counter()
        used = brain_for(consent)
        expected_text = _lines(expected_text)
        expected = _clean_text(expected_text, "expected_text", lang)
        analysis = check_expected(expected, lang, "expected_text", mode)
        before = _heard_before(heard_before or "", lang) if live_tail else None
        require_asr()
        if before is None:
            heard, quality, timings = listen(audio, lang)
        else:
            tail, tail_quality, timings = listen(audio, lang, allow_empty=True)
            heard = join_heard(before, tail)
            quality = live_quality(tail_quality, before, lang)

        if mode == "strict":
            # A Quran part is compared with its mushaf words as the Quran check does; the
            # rest of the text keeps the speech tolerances (mommy.guard).
            result, words = analysis.check_recitation(heard)
            text, is_quran = word_feedback(used, result, lang, age, "recitation", words)
            out: dict[str, Any] = {
                "mode": "strict",
                "heard_text": heard,
                "result": dataclasses.asdict(result),
                "feedback": text,
                "quality": quality,
                "say_again": result.say_again,
                "feedback_is_quran": is_quran,
                "quran_parts": analysis.parts_json(expected_text, lead=_lead(expected_text)),
            }
        else:
            if _quality_unclear(quality) or not tokenize(heard, lang):
                judgement: dict[str, Any] = {
                    "verdict": "unclear", "missing_ideas": [], "wrong_ideas": [], "say_again": True,
                }
                text = feedback.say_again(lang, age)
            else:
                judged = judge(used, expected, heard, lang, age)
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
        out["brain"] = brain_name(used)
        # Sizes and timings only: the number of words heard before, never the words.
        live_note = "" if before is None else f", tail after {len(tokenize(before, lang))} words"
        log.info(
            "recite/check %s %s: brain %s, audio %d bytes, %.1f s, decode %.2f s, asr %.2f s, total %.2f s%s",
            mode, lang, out["brain"], timings["bytes"], quality["seconds"], timings["decode_s"], timings["asr_s"],
            time.perf_counter() - started, live_note,
        )
        return out

    if live:

        @app.post("/api/recite/phrase")
        def recite_phrase(
            audio: Annotated[UploadFile, File(description=PHRASE_AUDIO_DOC)],
            expected_text: Annotated[str, Form()],
            lang: Annotated[LangField, Form()],
            mode: Annotated[Literal["strict", "contextual"], Form()],
            heard_before: Annotated[str, Form(description=HEARD_BEFORE_PHRASE_DOC)] = "",
        ) -> dict[str, Any]:
            """One phrase of a live recitation: the recogniser decodes this phrase only
            (the audio and the language, nothing else), and in strict mode the words heard
            so far (``heard_before`` + this phrase) are checked against the whole text by
            the same word-by-word analysis as ``/api/recite/check`` (Quran parts against
            the mushaf), with the words not reached yet ``"pending"``
            (:func:`mommy.align.reading_progress`). No brain is ever used (no AI consent
            needed; ``"brain": "offline"``), no feedback is written and nothing is kept:
            the client holds the transcripts and sends them back."""
            started = time.perf_counter()
            expected_text = _lines(expected_text)
            expected = _clean_text(expected_text, "expected_text", lang)
            analysis = check_expected(expected, lang, "expected_text", mode)
            before = _heard_before(heard_before, lang)
            require_asr()
            heard, quality, timings = listen(
                audio, lang, max_bytes=MAX_PHRASE_BYTES, max_seconds=MAX_PHRASE_SECONDS
            )
            progress: dict[str, Any] | None = None
            if mode == "strict":
                result, _words = analysis.check_recitation(join_heard(before, heard))
                progress = reading_progress(result)
            checked = time.perf_counter()
            out = {"mode": mode, "heard_text": heard, "quality": quality, "progress": progress, "brain": "offline"}
            log.info(
                "recite/phrase %s %s: audio %d bytes, %.1f s, after %d words, decode %.2f s, asr %.2f s, "
                "check %.3f s, total %.2f s",
                mode, lang, timings["bytes"], quality["seconds"], len(tokenize(before, lang)), timings["decode_s"],
                timings["asr_s"], checked - started - timings["decode_s"] - timings["asr_s"],
                time.perf_counter() - started,
            )
            return out

    # -- dictation ---------------------------------------------------------------

    @app.post("/api/dictation/phrases")
    def dictation_phrases(body: PhrasesRequest) -> dict[str, Any]:
        """Cut the text into the phrases read out one at a time.

        A text that is Quran (Q1) is refused (``422 quran_text``). In a school text with
        Quran parts (Q2) every part is cut apart, in chunks like the other phrases, and is
        read by a grown-up (``readers``), from the vowelled mushaf text (``read_text``);
        the voice reads only the other phrases. The parts are found from the text here.
        """
        text = _clean_text(body.text, "text")  # punctuation only still gives {"phrases": []}
        _check_words(text, "text", body.lang)
        analysis = check_expected(text, body.lang, "text", "dictation")
        plan = analysis.dictation_plan()
        return {
            "phrases": [p["phrase"] for p in plan],
            "readers": [p["reader"] for p in plan],
            "read_text": [p["read_text"] for p in plan],
            "parts": [p["part"] for p in plan],
            "quran_parts": analysis.parts_json(body.text, lead=_lead(body.text)),
        }

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
        analysis = find_quran_parts(text, body.lang, quran)
        quran_guard(analysis, text, mode)
        _refuse_lang_mismatch(text, body.lang, "text")
        out = {
            "ok": True,
            "words": len(tokenize(text, body.lang)),
            "dictation": analysis.voice_safe,
            "contextual": mode == "contextual" or not (analysis.parts or looks_like_quran_for_meaning(text, quran)),
            **_quran_fields(analysis, body.text),
        }
        log.info(
            "text/check %s %s: %d chars, %d words, %d Quran parts, %.3f s",
            mode, body.lang, len(text), out["words"], len(analysis.parts), time.perf_counter() - started,
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
        consent: AiConsent,
        image: Annotated[UploadFile | None, File()] = None,
        written_text: Annotated[str | None, Form()] = None,
        strict_tashkeel: Annotated[bool, Form()] = False,
    ) -> dict[str, Any]:
        """Check what the child wrote, from a photo (read blind by Claude, which needs the
        AI consent) or typed by the parent (worded by Claude with the consent, else by the
        offline templates)."""
        started = time.perf_counter()
        used = brain_for(consent)
        expected_text = _lines(expected_text)
        written_text = _lines(written_text) if written_text is not None else None
        expected = _clean_text(expected_text, "expected_text", lang)
        analysis = check_expected(expected, lang, "expected_text")
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
            if brain_name(used) != "claude":
                # No Claude on this server, or no AI consent with this request.
                raise ApiError(
                    501, "needs_manual", "Reading handwriting needs Claude. Please type what the child wrote."
                )
            try:
                # Blind: the image and the language only, never the expected text (hard rule 3).
                written = used.read_handwriting(data, lang)
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

        # A Quran word is accepted in its mushaf spellings only (mommy.guard).
        result, words = analysis.check_writing(read_text, strict_tashkeel=strict_tashkeel)
        text, is_quran = word_feedback(used, result, lang, age, "dictation", words)
        out = {
            "read_text": read_text,
            "source": source,
            "uncertain_words": uncertain,
            "legible": legible,
            "result": dataclasses.asdict(result),
            "feedback": text,
            "needs_parent_confirmation": True,
            "feedback_is_quran": is_quran,
            "quran_parts": analysis.parts_json(expected_text, lead=_lead(expected_text)),
            "brain": brain_name(used),
        }
        log.info(
            "dictation/check %s: brain %s, source %s, image %d bytes, %.2f s",
            lang, out["brain"], source, len(data), time.perf_counter() - started,
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
            heard = _lines(heard_text).strip()
            _check_chars(heard, "heard_text")
        else:
            raise ApiError(422, "missing_field", "Missing field: audio or heard_text.")
        found = bool(tokenize(heard, "ar"))
        candidates = q.locate(heard, top_k=LOCATE_TOP_K, within_surah=surah) if found else []
        return {"heard_text": heard, "candidates": candidates, "say_again": not found, "quality": quality}

    # -- the web client ------------------------------------------------------------

    if gate is not None:
        proxy_warned = False

        @app.post(ACCESS_PATH, status_code=204, response_class=Response)
        async def access(body: AccessRequest, request: Request) -> Response:
            """Trade the access code for the access cookie (see :mod:`mommy.access`).

            The client is ``request.client.host``, which uvicorn's ``--proxy-headers`` set
            from ``X-Forwarded-For``; behind a proxy that is the proxy's own address
            otherwise. It is counted under :func:`~mommy.access.client_key`. Neither the
            code, the cookie nor the address is ever logged.

            The cookie is ``Secure`` unless the request is for a loopback host: online the
            page is HTTPS, whatever ``X-Forwarded-Proto`` the proxy sends (uvicorn takes
            only an exact ``https``), and a cookie that opens the app for 180 days must
            never go over plain http. Over plain http only ``localhost`` (a local test of
            the image) can keep it.
            """
            nonlocal proxy_warned
            client = client_key(request.client.host if request.client is not None else None)
            loopback = is_loopback_host(_host_name(request.headers.get("host", "")))
            if not loopback and not proxy_warned and not is_public_client(client):
                proxy_warned = True
                log.warning(
                    "an access code came from a private or unknown client address: if every visitor "
                    "does, the proxy's X-Forwarded-For is not used (MOMMY_FORWARDED_ALLOW_IPS, "
                    "scripts/space_start.sh) and all of them share one failure limit"
                )
            wait = gate.limiter.retry_after(client)
            if wait is not None:
                log.info("access code attempts paused for a client (%d s left)", wait)
                return error_response(429, "too_many_attempts", TOO_MANY_MESSAGE, headers={"Retry-After": str(wait)})
            if not gate.code_matches(body.code):
                failures = gate.limiter.record_failure(client)
                log.info("refused a wrong access code (%d of %d in the window)", failures, gate.limiter.max_failures)
                return error_response(403, "bad_access_code", BAD_CODE_MESSAGE)
            gate.limiter.clear(client)
            log.info("access code accepted")
            response = Response(status_code=204)
            response.set_cookie(
                ACCESS_COOKIE,
                gate.cookie_for(request.headers.get("host", "")),
                max_age=ACCESS_COOKIE_MAX_AGE,
                path="/",
                secure=request.url.scheme == "https" or not loopback,
                httponly=True,
                samesite="lax",
            )
            return response

    # The published schema (/api/openapi.json) lists the opt-in field of the AI consent and
    # the answer's "brain" (document_ai_consent); the requests are read as before.
    default_openapi = app.openapi

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is None:
            app.openapi_schema = document_ai_consent(default_openapi(), app.routes)
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]

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


def start_preload(transcriber: Transcriber, tts: Synthesizer) -> threading.Thread:
    """Load the recognisers, then the voices, in a background thread, one language at a
    time (the components' locks are released in between, so a request is never kept
    waiting for more than one load). Online only (``build_default_app``): after a cold
    start the first recording would otherwise wait for its recogniser (7 to 40 s on 2
    vCPU), while a visitor spends that time on the code page and the family setup. A
    failure is logged by its class name and skipped."""

    def run() -> None:
        started = time.perf_counter()
        for kind, component in (("recogniser", transcriber), ("voice", tts)):
            preload = getattr(component, "preload", None)
            if preload is None or not getattr(component, "available", False):
                continue
            for lang in LANGUAGES:
                try:
                    preload((lang,))
                except Exception as exc:  # noqa: BLE001 - a background warm-up must not stop
                    log.warning("preloading the %s %s failed (%s)", lang, kind, type(exc).__name__)
        log.info("preloaded the recognisers and voices in %.1f s", time.perf_counter() - started)

    thread = threading.Thread(target=run, name="mommy-preload", daemon=True)
    thread.start()
    return thread


def build_default_app() -> FastAPI:
    """The app with the real components: local Whisper and Piper, Claude when configured
    (otherwise offline), and the Tanzil Quran. A component that cannot run is reported
    by ``/api/health`` instead of stopping the server (hard rule 8)."""
    _configure_logging()
    settings = load_settings()
    transcriber = SherpaWhisper.from_settings(settings)
    tts = PiperTTS.from_settings(settings)
    brain = make_brain(settings)
    # The local page reader loads its models at the first page (about 0.5 s).
    reader = PPOCRReader.from_settings(settings) if settings.ocr else None
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
        "starting: asr=%s (%s) tts=%s brain=%s quran=%s ocr=%s",
        transcriber.available, transcriber.model, tts.available, brain.name, quran is not None,
        bool(reader and reader.available),
    )
    app = create_app(settings, transcriber, tts, brain, quran, reader)
    if settings.access_code is not None:
        # Online only: local use keeps loading each language on first use.
        start_preload(transcriber, tts)
    return app


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
    "HSTS_VALUE",
    "AccessGateMiddleware",
    "AccessRequest",
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
    "find_quran_parts",
    "dictation_speaks_quran",
    "error_response",
    "is_loopback_host",
    "is_online",
    "is_quran_phrase",
    "is_whole_ayah",
    "keep_uploads_in_memory",
    "looks_like_quran",
    "looks_like_quran_for_meaning",
    "start_preload",
    "text_script",
    "QURAN_GUARD_CONTAINED_AYAH_WORDS",
    "QURAN_GUARD_CONTEXTUAL_RUN_WORDS",
    "QURAN_GUARD_FRAMED_GAP_WORDS",
    "QURAN_GUARD_FRAMED_RUN_WORDS",
    "QURAN_GUARD_MIN_SCORE",
    "QURAN_GUARD_MIN_WORDS",
    "QURAN_GUARD_RUN_WORDS",
    "QURAN_MEANING_MESSAGE",
    "QURAN_TEXT_MESSAGE",
    "GuardMode",
]

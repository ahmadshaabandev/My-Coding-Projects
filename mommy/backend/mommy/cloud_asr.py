"""An optional, paid recogniser in the cloud: Google Cloud Speech-to-Text V2 (extra).

Off unless ``MOMMY_CLOUD_ASR=google`` (see :mod:`mommy.config`). The local recognisers
stay: in the live cascade the quick local model still goes first, then this recogniser
instead of Whisper, and Whisper answers whenever this one cannot (a failure, a timeout,
an empty answer, the monthly cap, a language it is not set up for, or a request without
the family's consent, see ``app.cloud_consent_given``).

Hard rule 1: the recogniser is never given the expected text. :meth:`GoogleSpeech.transcribe`
takes the audio and the app language and nothing else, and the request body it builds
(:func:`recognize_body`) holds the decoding config, the model, the language code and the
audio: no ``adaptation`` (phrase hints), no ``customPromptConfig``, no prompt.

Privacy (hard rule 5): the audio stays in memory (16-bit PCM in base64 inside the JSON
body, sent over HTTPS); this module logs sizes, timings and short reasons only, never
audio, transcripts, texts, the key, the access token or Google's error messages (only
their status names, such as ``PERMISSION_DENIED``).

The API (checked against Google's own sources, 2026-11-14)
----------------------------------------------------------
* ``POST https://{region}-speech.googleapis.com/v2/projects/{project}/locations/{region}/recognizers/_:recognize``
  (``Speech.Recognize`` in googleapis ``google/cloud/speech/v2/cloud_speech.proto``: ``post:
  "/v2/{recognizer=projects/*/locations/*/recognizers/*}:recognize"``, ``body: "*"``; the
  recognizer ``_`` is "an empty implicit Recognizer"). The body, in the proto's JSON
  names (the discovery document ``speech.googleapis.com/$discovery/rest?version=v2``)::

      {"config": {"explicitDecodingConfig": {"encoding": "LINEAR16", "sampleRateHertz": 16000,
                                             "audioChannelCount": 1},
                  "model": "chirp_3", "languageCodes": ["ar-SA"]},
       "content": "<base64 of the 16-bit little-endian samples>"}

  The answer: ``{"results": [{"alternatives": [{"transcript": ...}], ...}], "metadata":
  {"totalBilledDuration": "3s", ...}}``. ``StreamingRecognize`` is gRPC only ("This method
  is only available via the gRPC API (not REST)"), so this module uses ``Recognize``.
* Authentication: an OAuth 2.0 access token (scope ``cloud-platform``). V2 does not
  accept API keys: a request with one is answered ``401 "API keys are not supported by
  this API. Expected OAuth2 access token..."`` (tried against ``eu-speech.googleapis.com``
  and ``speech.googleapis.com`` with a made-up key, while V1 answers "API key not
  valid"). The token is minted from a service-account key as google-auth does
  (``google/oauth2/service_account.py`` and ``_client.py``): a JWT signed with RS256
  whose claims are ``iss`` (the account's e-mail), ``scope``, ``aud`` (the key's
  ``token_uri``, ``https://oauth2.googleapis.com/token``), ``iat`` and ``exp`` (one
  hour), posted form-encoded as ``grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer``
  and ``assertion=<jwt>``. The signature is made here (:func:`rs256_sign`, PKCS#1 v1.5
  over SHA-256 with the standard library's integers) rather than with google-auth,
  which would add ``cryptography``, ``cffi``, ``pycparser``, ``pyasn1`` and
  ``pyasn1-modules`` to the image for one signature an hour; ``tests/test_cloud_asr.py``
  checks it byte for byte against OpenSSL.
* Billing: per request, rounded up to whole seconds (Google's price list, "Each request
  is rounded up to the nearest increment of 1 seconds"), so :class:`UsageMeter` counts
  ``ceil(seconds)`` per request against the monthly cap.
* Synchronous recognition is meant for short audio (Google documents about one minute
  per request; its documentation site could not be reached to check the exact limit),
  so a longer recording is sent in pieces of at most :data:`MAX_PIECE_SECONDS`, cut at
  quiet points (:func:`mommy.asr.split_for_whisper`), one request each.
"""

from __future__ import annotations

import base64
import binascii
import datetime as _dt
import hashlib
import json
import logging
import math
import os
import re
import secrets
import socket
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Protocol

import numpy as np

from .asr import MIN_DECODE_SAMPLES, SAMPLE_RATE, _as_pcm, split_for_whisper
from .textnorm import Lang

if TYPE_CHECKING:  # pragma: no cover
    from .config import Settings

log = logging.getLogger(__name__)

#: The OAuth scope of every Speech-to-Text method (speech_v2.yaml).
SCOPE = "https://www.googleapis.com/auth/cloud-platform"
#: The token endpoint of a service-account key (``token_uri``).
TOKEN_URI = "https://oauth2.googleapis.com/token"
JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer"
#: Lifetime asked for a token's assertion, and how long before expiry a token is renewed.
TOKEN_LIFETIME_S = 3600
TOKEN_MARGIN_S = 300
#: Longest piece of audio in one request (a synchronous request takes about 60 s).
MAX_PIECE_SECONDS = 55.0


class CloudASRError(RuntimeError):
    """The cloud recogniser could not answer; ``reason`` is short and holds no secret,
    audio or text (``"timeout"``, ``"http 403 PERMISSION_DENIED"``, ``"cap"``...).
    The caller then has Whisper decode the clip."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


# ---------------------------------------------------------------------------
# HTTP (urllib from the standard library; tests pass a fake transport)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes


#: ``transport(url, headers, body, timeout) -> HttpResponse``; raises TimeoutError for a
#: timeout and OSError for a network failure.
Transport = Callable[[str, dict[str, str], bytes, float], HttpResponse]


def urllib_transport(url: str, headers: dict[str, str], body: bytes, timeout: float) -> HttpResponse:
    """POST ``body`` to ``url`` (HTTPS, the system's certificates; the proxy of
    ``HTTPS_PROXY`` when set). Any HTTP status comes back as a response."""
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    context = ssl.create_default_context()
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as answer:  # noqa: S310 - https only
            return HttpResponse(answer.status, answer.read())
    except urllib.error.HTTPError as exc:
        try:
            data = exc.read()
        finally:
            exc.close()
        return HttpResponse(exc.code, data)
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise TimeoutError("timed out") from None
        raise OSError(type(exc.reason).__name__) from None


def _net_name(exc: OSError) -> str:
    """A short name for a network failure (a class name, never an address or a message)."""
    first = exc.args[0] if exc.args else None
    if type(exc) is OSError and isinstance(first, str) and re.fullmatch(r"[A-Za-z]{1,60}", first):
        return first  # urllib_transport's own: the class name of the underlying reason
    return type(exc).__name__


def _status_name(body: bytes) -> str:
    """Google's error status name (``PERMISSION_DENIED``) or OAuth error code
    (``invalid_grant``) from an error body, else ``""``. Only such a name is ever logged:
    the messages may quote the project or the account."""
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return ""
    if not isinstance(data, dict):
        return ""
    err = data.get("error")
    name = err.get("status") if isinstance(err, dict) else err
    return name if isinstance(name, str) and re.fullmatch(r"[A-Za-z_]{1,40}", name) else ""


# ---------------------------------------------------------------------------
# RS256 (RSASSA-PKCS1-v1_5 with SHA-256) for the service account's JWT
# ---------------------------------------------------------------------------


@dataclass(frozen=True, repr=False)
class RSAPrivateKey:
    """An RSA private key (PKCS#1 fields). Never printed: its repr names nothing."""

    n: int
    e: int
    d: int
    p: int
    q: int
    dp: int
    dq: int
    qinv: int

    def __repr__(self) -> str:
        return "RSAPrivateKey(...)"

    @property
    def size(self) -> int:
        return (self.n.bit_length() + 7) // 8


def _der(data: bytes, pos: int) -> tuple[int, bytes, int]:
    """One DER element at ``pos``: (tag, content, position after it)."""
    if pos + 2 > len(data):
        raise ValueError("truncated key")
    tag, length = data[pos], data[pos + 1]
    pos += 2
    if length & 0x80:
        count = length & 0x7F
        if count == 0 or count > 4 or pos + count > len(data):
            raise ValueError("bad key length")
        length = int.from_bytes(data[pos:pos + count], "big")
        pos += count
    if pos + length > len(data):
        raise ValueError("truncated key")
    return tag, data[pos:pos + length], pos + length


def _der_sequence(content: bytes) -> list[tuple[int, bytes]]:
    items, pos = [], 0
    while pos < len(content):
        tag, value, pos = _der(content, pos)
        items.append((tag, value))
    return items


_RSA_OID = bytes.fromhex("2a864886f70d010101")  # 1.2.840.113549.1.1.1 rsaEncryption


def load_rsa_private_key(pem: str) -> RSAPrivateKey:
    """The key of a PEM block: PKCS#8 (``BEGIN PRIVATE KEY``, as in Google's key files)
    or PKCS#1 (``BEGIN RSA PRIVATE KEY``). ValueError (naming no part of the key) for
    anything else."""
    m = re.search(r"-----BEGIN (RSA )?PRIVATE KEY-----(.+?)-----END (RSA )?PRIVATE KEY-----", pem, re.S)
    if m is None:
        raise ValueError("no PEM private key")
    try:
        der = base64.b64decode("".join(m.group(2).split()), validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("the private key is not base64") from None
    tag, content, _ = _der(der, 0)
    if tag != 0x30:
        raise ValueError("the private key is not a DER sequence")
    items = _der_sequence(content)
    if m.group(1) is None:  # PKCS#8: version, AlgorithmIdentifier, OCTET STRING (PKCS#1)
        if len(items) < 3 or items[1][0] != 0x30 or items[2][0] != 0x04:
            raise ValueError("not a PKCS#8 private key")
        alg = _der_sequence(items[1][1])
        if not alg or alg[0] != (0x06, _RSA_OID):
            raise ValueError("not an RSA key")
        tag, content, _ = _der(items[2][1], 0)
        if tag != 0x30:
            raise ValueError("not a PKCS#1 private key")
        items = _der_sequence(content)
    if len(items) < 9 or any(t != 0x02 for t, _ in items[:9]):
        raise ValueError("not a PKCS#1 private key")
    n, e, d, p, q, dp, dq, qinv = (int.from_bytes(v, "big") for _, v in items[1:9])
    if p * q != n or n.bit_length() < 2048 - 8 or e < 3:
        raise ValueError("an inconsistent or short RSA key")
    return RSAPrivateKey(n, e, d, p, q, dp, dq, qinv)


#: DigestInfo prefix of SHA-256 (RFC 8017, 9.2, note 1).
_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


def rs256_sign(key: RSAPrivateKey, message: bytes) -> bytes:
    """RSASSA-PKCS1-v1_5 signature of ``message`` with SHA-256 (RFC 8017, 8.2.1): the
    same bytes as ``openssl dgst -sha256 -sign``. The private operation is blinded with
    a random factor (the timing of Python's integers then does not follow the key) and
    uses the CRT; the result is checked with the public key before it is returned."""
    k = key.size
    t = _SHA256_PREFIX + hashlib.sha256(message).digest()
    if k < len(t) + 11:
        raise ValueError("key too short")
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    m = int.from_bytes(em, "big")
    while True:
        r = secrets.randbelow(key.n - 2) + 2
        if math.gcd(r, key.n) == 1:
            break
    c = (m * pow(r, key.e, key.n)) % key.n
    m1, m2 = pow(c, key.dp, key.p), pow(c, key.dq, key.q)
    s = (m2 + ((key.qinv * (m1 - m2)) % key.p) * key.q) * pow(r, -1, key.n) % key.n
    if pow(s, key.e, key.n) != m:
        raise ValueError("RSA signature check failed")
    return s.to_bytes(k, "big")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


# ---------------------------------------------------------------------------
# Service-account credentials and access tokens
# ---------------------------------------------------------------------------


@dataclass(frozen=True, repr=False)
class ServiceAccount:
    """The parts of a service-account key file that are used. Never printed."""

    client_email: str
    private_key: RSAPrivateKey
    private_key_id: str
    token_uri: str
    project_id: str | None

    def __repr__(self) -> str:
        return "ServiceAccount(...)"

    @classmethod
    def from_info(cls, info: Any) -> ServiceAccount:
        """From the parsed key file. ValueError naming the field, never its value."""
        if not isinstance(info, dict) or info.get("type") != "service_account":
            raise ValueError('not a service-account key file (its "type" must be "service_account")')
        for name in ("client_email", "private_key", "token_uri"):
            if not isinstance(info.get(name), str) or not info[name].strip():
                raise ValueError(f'the key file has no "{name}"')
        token_uri = info["token_uri"].strip()
        parsed = urllib.parse.urlsplit(token_uri)
        if parsed.scheme != "https" or not (parsed.hostname or "").endswith(".googleapis.com"):
            # The signed assertion goes only to Google.
            raise ValueError('the key file\'s "token_uri" is not a googleapis.com https address')
        project = info.get("project_id")
        return cls(
            client_email=info["client_email"].strip(),
            private_key=load_rsa_private_key(info["private_key"]),
            private_key_id=str(info.get("private_key_id") or ""),
            token_uri=token_uri,
            project_id=project.strip() if isinstance(project, str) and project.strip() else None,
        )

    @classmethod
    def from_settings(cls, settings: Settings) -> ServiceAccount:
        """From ``MOMMY_GOOGLE_CREDENTIALS_B64`` or else ``MOMMY_GOOGLE_CREDENTIALS``.
        ValueError (naming the variable or the file, never the key) when neither is set or
        the key cannot be read."""
        b64 = getattr(settings, "google_credentials_b64", None)
        path = getattr(settings, "google_credentials_file", None)
        if b64:
            try:
                raw = base64.b64decode("".join(b64.split()), validate=True)
                info = json.loads(raw)
            except (binascii.Error, ValueError, UnicodeDecodeError):
                raise ValueError("MOMMY_GOOGLE_CREDENTIALS_B64 is not a key file in base64") from None
            return cls.from_info(info)
        if path:
            try:
                raw = Path(path).read_bytes()
            except OSError as exc:
                raise ValueError(f"cannot read MOMMY_GOOGLE_CREDENTIALS ({path}): {type(exc).__name__}") from None
            try:
                info = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                raise ValueError(f"MOMMY_GOOGLE_CREDENTIALS ({path}) is not a JSON key file") from None
            return cls.from_info(info)
        raise ValueError("no Google credentials: set MOMMY_GOOGLE_CREDENTIALS (a service-account key file)")

    def assertion(self, now: float) -> str:
        """The signed JWT of the token request (as google-auth makes it)."""
        header = {"alg": "RS256", "typ": "JWT"}
        if self.private_key_id:
            header["kid"] = self.private_key_id
        iat = int(now)
        claims = {"iat": iat, "exp": iat + TOKEN_LIFETIME_S, "iss": self.client_email, "aud": self.token_uri, "scope": SCOPE}
        signing_input = (
            _b64url(json.dumps(header, separators=(",", ":")).encode())
            + "."
            + _b64url(json.dumps(claims, separators=(",", ":")).encode())
        )
        signature = rs256_sign(self.private_key, signing_input.encode("ascii"))
        return signing_input + "." + _b64url(signature)


class TokenSource:
    """Access tokens of a service account, minted when needed and kept until
    :data:`TOKEN_MARGIN_S` before they expire. Thread-safe."""

    def __init__(self, account: ServiceAccount, transport: Transport, *, timeout: float, clock: Callable[[], float] = time.time) -> None:
        self._account = account
        self._transport = transport
        self._timeout = timeout
        self._clock = clock
        self._lock = threading.Lock()
        self._token: str | None = None
        self._expires = 0.0

    def __repr__(self) -> str:
        return "TokenSource(...)"

    def token(self) -> str:
        """A valid access token. CloudASRError (``"auth ..."``, ``"timeout"``) otherwise."""
        with self._lock:
            now = self._clock()
            if self._token is not None and now < self._expires - TOKEN_MARGIN_S:
                return self._token
            body = urllib.parse.urlencode({"grant_type": JWT_GRANT_TYPE, "assertion": self._account.assertion(now)}).encode()
            headers = {"Content-Type": "application/x-www-form-urlencoded"}
            try:
                answer = self._transport(self._account.token_uri, headers, body, self._timeout)
            except TimeoutError:
                raise CloudASRError("auth timeout") from None
            except OSError as exc:
                raise CloudASRError(f"auth network {_net_name(exc)}") from None
            if answer.status != 200:
                name = _status_name(answer.body)
                raise CloudASRError(f"auth http {answer.status}" + (f" {name}" if name else ""))
            try:
                data = json.loads(answer.body)
                token = data["access_token"]
                expires_in = float(data.get("expires_in", TOKEN_LIFETIME_S))
            except (ValueError, KeyError, TypeError, UnicodeDecodeError):
                raise CloudASRError("auth bad answer") from None
            if not isinstance(token, str) or not token:
                raise CloudASRError("auth bad answer")
            self._token, self._expires = token, now + expires_in
            return token

    def forget(self) -> None:
        """Drop the kept token (after a 401: it was revoked or the clock is off)."""
        with self._lock:
            self._token, self._expires = None, 0.0


# ---------------------------------------------------------------------------
# The monthly cap
# ---------------------------------------------------------------------------


def _month(now: float) -> str:
    return _dt.datetime.fromtimestamp(now, _dt.timezone.utc).strftime("%Y-%m")


class UsageMeter:
    """The seconds of audio sent to the cloud this calendar month (UTC), against a cap.

    Kept in ``path`` (``MOMMY_GOOGLE_USAGE_FILE``), a small JSON file ``{"month":
    "2026-11", "seconds": 1234}`` with nothing else in it (no family data), written
    atomically after each request, so a restart does not start the count again; without
    a path (or when the file cannot be written: a warning, once) the count is kept in
    memory. A new month starts again from 0. When the cap is reached, one line is logged
    for that month and every request goes to Whisper. Thread-safe."""

    def __init__(self, path: Path | None, max_minutes: int, *, clock: Callable[[], float] = time.time) -> None:
        self.path = Path(path) if path is not None else None
        self.max_seconds = max(0, int(max_minutes)) * 60
        self._clock = clock
        self._lock = threading.Lock()
        self._month = _month(clock())
        self._seconds = 0
        self._capped_month: str | None = None
        self._write_failed = False
        if self.path is None:
            log.warning("MOMMY_GOOGLE_USAGE_FILE is not set: the monthly cap is counted in memory (a restart starts it again)")
        else:
            self._load()

    def _load(self) -> None:
        assert self.path is not None
        try:
            data = json.loads(self.path.read_text("utf-8"))
        except FileNotFoundError:
            return
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            log.warning("the Google usage file %s cannot be read (%s): counting from 0", self.path, type(exc).__name__)
            return
        if (
            isinstance(data, dict) and data.get("month") == self._month
            and isinstance(data.get("seconds"), int) and not isinstance(data.get("seconds"), bool) and data["seconds"] >= 0
        ):
            self._seconds = data["seconds"]

    def _roll(self) -> None:
        month = _month(self._clock())
        if month != self._month:
            self._month, self._seconds, self._capped_month = month, 0, None

    def _save(self) -> None:
        if self.path is None:
            return
        data = json.dumps({"month": self._month, "seconds": self._seconds}).encode()
        try:
            fd, tmp = tempfile.mkstemp(prefix=".google-usage.", dir=str(self.path.parent))
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                os.replace(tmp, self.path)
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        except OSError as exc:
            if not self._write_failed:
                self._write_failed = True
                log.warning("cannot write the Google usage file %s (%s): the cap is counted in memory", self.path, type(exc).__name__)

    def allows(self, seconds: int) -> bool:
        """True when ``seconds`` more stay within the cap (one line logged per month when not)."""
        with self._lock:
            self._roll()
            if self._seconds + seconds <= self.max_seconds:
                return True
            if self._capped_month != self._month:
                self._capped_month = self._month
                log.warning(
                    "Google speech: the monthly cap of %d minutes is reached (%d s used in %s); Whisper "
                    "decodes until the first day of next month (UTC)",
                    self.max_seconds // 60, self._seconds, self._month,
                )
            return False

    def add(self, seconds: int) -> None:
        """Count ``seconds`` (whole seconds, as billed) for this month and save."""
        with self._lock:
            self._roll()
            self._seconds += max(0, int(seconds))
            self._save()

    def used(self) -> tuple[str, int]:
        """(month, seconds used)."""
        with self._lock:
            self._roll()
            return self._month, self._seconds


# ---------------------------------------------------------------------------
# The recogniser
# ---------------------------------------------------------------------------


class CloudRecognizer(Protocol):
    name: str
    languages: tuple[str, ...]

    def available_for(self, lang: str) -> bool: ...
    def transcribe(self, pcm16k: np.ndarray, lang: Lang) -> str: ...


def billed_seconds(n_samples: int) -> int:
    """Whole seconds billed for one request of ``n_samples`` at 16 kHz (rounded up)."""
    return max(1, math.ceil(n_samples / SAMPLE_RATE))


def to_linear16(pcm: np.ndarray) -> bytes:
    """Float samples in -1..1 as 16-bit little-endian PCM (LINEAR16)."""
    clipped = np.clip(np.asarray(pcm, dtype=np.float32), -1.0, 1.0)
    return np.round(clipped * 32767.0).astype("<i2").tobytes()


def recognize_body(pcm: np.ndarray, language_code: str, model: str) -> bytes:
    """The JSON body of one ``recognize`` request: the decoding config, the model, the
    language code and the audio, nothing else (hard rule 1: no text, no phrase hints, no
    prompt)."""
    body = {
        "config": {
            "explicitDecodingConfig": {"encoding": "LINEAR16", "sampleRateHertz": SAMPLE_RATE, "audioChannelCount": 1},
            "model": model,
            "languageCodes": [language_code],
        },
        "content": base64.b64encode(to_linear16(pcm)).decode("ascii"),
    }
    return json.dumps(body, separators=(",", ":")).encode("ascii")


def parse_transcript(body: bytes) -> str:
    """The words of a ``RecognizeResponse``: the first alternative of each result,
    joined. ValueError for an answer that is not one."""
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError("not an object")
    words: list[str] = []
    for result in data.get("results") or []:
        alternatives = result.get("alternatives") if isinstance(result, dict) else None
        if alternatives and isinstance(alternatives[0], dict):
            text = alternatives[0].get("transcript")
            if isinstance(text, str) and text.strip():
                words.append(text.strip())
    return " ".join(" ".join(words).split())


class GoogleSpeech:
    """Google Cloud Speech-to-Text V2, synchronous ``recognize`` over REST.

    ``transcribe(pcm, lang)`` returns the words, or raises :class:`CloudASRError` with a
    short reason (the caller has Whisper decode the clip then). It is given the audio and
    the language only."""

    name = "google"

    def __init__(
        self,
        account: ServiceAccount,
        *,
        project: str,
        region: str,
        model: str,
        locales: dict[str, str],
        languages: tuple[str, ...],
        meter: UsageMeter,
        timeout: float,
        transport: Transport = urllib_transport,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._tokens = TokenSource(account, transport, timeout=timeout, clock=clock)
        self.project = project
        self.region = region
        self.model = model
        self.locales = dict(locales)
        self.languages = tuple(lang for lang in languages if lang in self.locales)
        self.meter = meter
        self.timeout = timeout
        self._transport = transport
        host = "speech.googleapis.com" if region == "global" else f"{region}-speech.googleapis.com"
        self.url = f"https://{host}/v2/projects/{project}/locations/{region}/recognizers/_:recognize"
        self.available = bool(self.languages)

    def __repr__(self) -> str:
        return f"GoogleSpeech(region={self.region!r}, model={self.model!r}, languages={self.languages!r})"

    @classmethod
    def from_settings(cls, settings: Settings, *, transport: Transport = urllib_transport, clock: Callable[[], float] = time.time) -> GoogleSpeech:
        """From the ``MOMMY_GOOGLE_*`` settings. ValueError (no secret in it) when the key
        cannot be loaded or there is no project id."""
        account = ServiceAccount.from_settings(settings)
        project = settings.google_project or account.project_id
        if not project:
            raise ValueError("no Google Cloud project: set MOMMY_GOOGLE_PROJECT")
        meter = UsageMeter(settings.google_usage_file, settings.google_max_minutes, clock=clock)
        return cls(
            account, project=project, region=settings.google_region, model=settings.google_model,
            locales=settings.google_locales, languages=tuple(settings.cloud_asr_langs), meter=meter,
            timeout=settings.google_timeout, transport=transport, clock=clock,
        )

    def available_for(self, lang: str) -> bool:
        return lang in self.languages

    def warm(self) -> None:
        """Mint the first access token now (at start, so the first reading does not wait)."""
        try:
            self._tokens.token()
        except CloudASRError as exc:
            log.warning("Google speech: no access token yet (%s)", exc.reason)

    def _recognize(self, piece: np.ndarray, language_code: str) -> str:
        body = recognize_body(piece, language_code, self.model)
        for attempt in (1, 2):
            headers = {
                "Authorization": "Bearer " + self._tokens.token(),
                "Content-Type": "application/json; charset=utf-8",
            }
            try:
                answer = self._transport(self.url, headers, body, self.timeout)
            except TimeoutError:
                # Google may have heard (and billed) it: counted.
                self.meter.add(billed_seconds(piece.size))
                raise CloudASRError("timeout") from None
            except OSError as exc:
                raise CloudASRError(f"network {_net_name(exc)}") from None
            if answer.status == 401 and attempt == 1:
                self._tokens.forget()  # revoked or expired early: one new token
                continue
            if answer.status != 200:
                name = _status_name(answer.body)
                raise CloudASRError(f"http {answer.status}" + (f" {name}" if name else ""))
            self.meter.add(billed_seconds(piece.size))
            try:
                return parse_transcript(answer.body)
            except (ValueError, TypeError, AttributeError, UnicodeDecodeError):
                raise CloudASRError("bad answer") from None
        raise CloudASRError("http 401")  # pragma: no cover - the loop returns or raises

    def transcribe(self, pcm16k: np.ndarray, lang: Lang) -> str:
        """The words heard in float32 mono 16 kHz audio spoken in ``lang`` (never the
        expected text). CloudASRError when there is no answer to use: ``"lang"``,
        ``"cap"``, ``"timeout"``, ``"http <status>[ <name>]"``, ``"network ..."``,
        ``"auth ..."``, ``"bad answer"`` or ``"empty"``."""
        if not self.available_for(lang):
            raise CloudASRError("lang")
        pcm = _as_pcm(pcm16k)
        pieces = [p for p in split_for_whisper(pcm, max_seconds=MAX_PIECE_SECONDS) if p.size >= MIN_DECODE_SAMPLES]
        if not pieces:
            raise CloudASRError("empty")
        if not self.meter.allows(sum(billed_seconds(p.size) for p in pieces)):
            raise CloudASRError("cap")
        started = time.perf_counter()
        texts = [self._recognize(p, self.locales[lang]) for p in pieces]
        text = " ".join(t for t in texts if t)
        # Sizes and timings only (hard rule 5).
        log.info(
            "google %s: %.2f s of audio in %d request(s) in %.2f s",
            lang, pcm.size / SAMPLE_RATE, len(pieces), time.perf_counter() - started,
        )
        if not text:
            raise CloudASRError("empty")
        return text


def make_cloud_recognizer(settings: Settings, **kwargs: Any) -> tuple[GoogleSpeech | None, str | None]:
    """(recogniser, None) when ``MOMMY_CLOUD_ASR`` names one and it can be set up, else
    (None, reason). The reason (for ``/api/health`` ``reasons.cloud_asr`` and the log)
    names variables or files, never a key."""
    provider = getattr(settings, "cloud_asr", None)
    if provider is None:
        return None, "MOMMY_CLOUD_ASR is off"
    if provider != "google":  # pragma: no cover - config refuses other values
        return None, f"unknown cloud recogniser {provider!r}"
    try:
        rec = GoogleSpeech.from_settings(settings, **kwargs)
    except ValueError as exc:
        log.warning("Google speech is off: %s", exc)
        return None, str(exc)
    if settings.google_max_minutes == 0:
        log.warning("Google speech: MOMMY_GOOGLE_MAX_MINUTES is 0, so nothing is sent")
    log.info(
        "Google speech: model %s in %s for %s (cap %d minutes a month)",
        rec.model, rec.region, ",".join(rec.languages), settings.google_max_minutes,
    )
    return rec, None


__all__ = [
    "CloudASRError",
    "CloudRecognizer",
    "GoogleSpeech",
    "HttpResponse",
    "MAX_PIECE_SECONDS",
    "RSAPrivateKey",
    "ServiceAccount",
    "TokenSource",
    "UsageMeter",
    "billed_seconds",
    "load_rsa_private_key",
    "make_cloud_recognizer",
    "parse_transcript",
    "recognize_body",
    "rs256_sign",
    "to_linear16",
    "urllib_transport",
]

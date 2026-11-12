"""The access gate of an online deployment (``MOMMY_ACCESS_CODE``).

Locally (no code set) there is no gate and nothing here runs. When the app is put
online with a code, only people who have the code can use it, so nobody else can send a
child's audio or photos to it or use its resources:

* ``POST /api/access`` with ``{"code": str}`` gives the cookie ``mommy_access``
  (``HttpOnly``, ``SameSite=Lax``, ``Path=/``, 180 days, and ``Secure`` except for a
  loopback host over plain http: see ``mommy.app``). The code is compared in constant time after trimming it and turning Arabic-Indic and
  Eastern Arabic-Indic digits into ASCII digits.
* :class:`AccessGateMiddleware` lets a request through only with that cookie, except
  the gate page's own files (:data:`GATE_ASSETS`) and ``POST /api/access``. Without it,
  an HTML navigation gets the gate page (``web/access.html``, status 200 at the URL
  asked for, so its ``#code=...`` fragment stays in the browser), an ``/api/*`` request
  gets ``401 {"error": "access_required", "message"}``, and any other file gets 401.
* The cookie value is an HMAC-SHA256 tag derived from the code alone
  (:func:`cookie_value`), so a new code invalidates every cookie given for the old one;
  the server keeps no session list. The code itself is not kept by the gate (only the
  tag), never logged and never written anywhere.
* Wrong codes are limited per client (``request.client.host``, after uvicorn's proxy
  headers, reduced by :func:`client_key`): at most :data:`MAX_FAILURES` in
  :data:`FAILURE_WINDOW_S` seconds, then ``429 too_many_attempts`` with ``Retry-After``.
  The memory is bounded: the :data:`MAX_TRACKED_CLIENTS` clients that failed most
  recently, at most :data:`MAX_FAILURES` timestamps each (:class:`FailureLimiter`), each
  under a key of at most :data:`MAX_CLIENT_KEY_CHARS` characters. The limit is defence
  in depth: the protection is the code itself (12 characters out of 31, about 59 bits).

The link a deploy script hands out is ``https://<host>/#code=<code>``: a URL fragment
is never sent to the server, so the code reaches no access log; ``web/access.js``
removes it from the address bar at once and POSTs it.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import math
import threading
import time
from collections import OrderedDict, deque
from pathlib import Path
from typing import Callable

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

#: The cookie that opens the app, and its lifetime (180 days, in seconds).
ACCESS_COOKIE = "mommy_access"
ACCESS_COOKIE_MAX_AGE = 180 * 24 * 60 * 60
#: The gate's endpoint: ``POST`` with ``{"code": str}``.
ACCESS_PATH = "/api/access"
#: The gate page, in ``Settings.web_dir``.
GATE_PAGE = "access.html"
#: Files served without the cookie: the gate page, its script and the shared styles.
GATE_ASSETS: frozenset[str] = frozenset({"/access.html", "/access.js", "/styles.css"})
#: Wrong codes allowed per client in the sliding window, before ``429``.
MAX_FAILURES = 10
FAILURE_WINDOW_S = 600.0
#: Clients whose failures are remembered (least recently failed forgotten first).
MAX_TRACKED_CLIENTS = 10_000
#: The longest key :func:`client_key` returns (``ffff:ffff:ffff:ffff::/64``).
MAX_CLIENT_KEY_CHARS = 24
#: The keys of clients whose address is missing, or is not an IP address.
UNKNOWN_CLIENT = "unknown"
OTHER_CLIENT = "other"
#: The characters of a code made by the deploy script (no 0/o, 1/l/i look-alikes).
CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
#: Length of a code made by the deploy script.
CODE_LENGTH = 12

#: Messages of the gate's errors (they never quote what was sent).
ACCESS_REQUIRED_MESSAGE = "This is a private test of Mommy: an access code is needed."
BAD_CODE_MESSAGE = "This access code is not right."
TOO_MANY_MESSAGE = "Too many wrong access codes. Try again later."

#: A fixed label: the cookie key is SHA-256(label + code), the cookie HMAC(key, name).
_KEY_LABEL = b"mommy access cookie v1\x00"
#: Arabic-Indic (U+0660-0669) and Eastern Arabic-Indic (U+06F0-06F9) digits -> ASCII.
_DIGITS = str.maketrans({**{chr(0x0660 + i): str(i) for i in range(10)}, **{chr(0x06F0 + i): str(i) for i in range(10)}})


def normalize_code(code: str) -> str:
    """``code`` trimmed, with Arabic-Indic and Eastern Arabic-Indic digits as ASCII digits
    (a phone set to Arabic or Persian types ``٢`` or ``۲`` for ``2``)."""
    return code.strip().translate(_DIGITS)


def cookie_value(code: str) -> str:
    """The ``mommy_access`` cookie value for ``code``: an HMAC-SHA256 tag, base64url
    without padding (43 characters). The same code always gives the same value; any other
    code gives another one, so changing the code invalidates every cookie."""
    key = hashlib.sha256(_KEY_LABEL + normalize_code(code).encode("utf-8", "surrogatepass")).digest()
    tag = hmac.new(key, ACCESS_COOKIE.encode("ascii"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(tag).rstrip(b"=").decode("ascii")


def client_key(host: str | None) -> str:
    """The key under which a client's wrong codes are counted, for ``request.client.host``.

    One key per client, whatever the spelling of its address, and never longer than
    :data:`MAX_CLIENT_KEY_CHARS` characters (the address comes from ``X-Forwarded-For``,
    which a visitor can fill with anything):

    * an IPv4 address in its usual form (``203.0.113.7``), also when it is written as an
      IPv4-mapped IPv6 address (``::ffff:203.0.113.7``);
    * any other IPv6 address as its /64 network (``2001:db8:1:2::/64``): one subscriber
      line gets a whole /64, so counting single addresses would give each visitor 2**64
      fresh tries, and ``2001:DB8::9`` and ``2001:db8:0::9`` are the same client;
    * :data:`UNKNOWN_CLIENT` without an address, :data:`OTHER_CLIENT` for anything that is
      not an IP address (they then share one count).
    """
    if not host:
        return UNKNOWN_CLIENT
    text = host.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    if len(text) > 64:  # longer than any IP address, scope included
        return OTHER_CLIENT
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return OTHER_CLIENT
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        # Built from the integer, so a zone (fe80::1%eth0) is dropped too.
        return str(ipaddress.IPv6Network((int(ip) >> 64 << 64, 64)))
    return str(ip)


def is_public_client(key: str) -> bool:
    """True when a :func:`client_key` names a public (globally routed) address or network.

    Behind a proxy whose ``X-Forwarded-For`` is not taken, every visitor has the proxy's
    own private address, and all of them share one failure count."""
    try:
        return ipaddress.ip_network(key).is_global
    except ValueError:
        return False


class FailureLimiter:
    """Wrong codes per client in a sliding window, with bounded memory.

    A client that has :data:`MAX_FAILURES` failures younger than the window is refused
    until the oldest of them is ``window_s`` old (:meth:`retry_after`). At most
    ``max_clients`` clients are remembered, in least-recently-failed order (an LRU), and
    at most ``max_failures`` timestamps for each, so the memory stays bounded whatever
    the number of clients. Thread-safe.
    """

    def __init__(
        self,
        *,
        max_failures: int = MAX_FAILURES,
        window_s: float = FAILURE_WINDOW_S,
        max_clients: int = MAX_TRACKED_CLIENTS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_failures = max_failures
        self.window_s = window_s
        self.max_clients = max_clients
        self.clock = clock
        self._failures: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def _recent(self, client: str, now: float) -> deque[float] | None:
        """The client's failures inside the window (older ones dropped); None if none."""
        times = self._failures.get(client)
        if times is None:
            return None
        while times and times[0] <= now - self.window_s:
            times.popleft()
        if not times:
            del self._failures[client]
            return None
        return times

    def retry_after(self, client: str) -> int | None:
        """Seconds (at least 1) until ``client`` may try again, or None if it may now."""
        with self._lock:
            now = self.clock()
            times = self._recent(client, now)
            if times is None or len(times) < self.max_failures:
                return None
            return max(1, math.ceil(times[0] + self.window_s - now))

    def record_failure(self, client: str) -> int:
        """Count a wrong code for ``client``; returns its failures in the window."""
        with self._lock:
            now = self.clock()
            times = self._recent(client, now)
            if times is None:
                times = self._failures[client] = deque(maxlen=self.max_failures)
            times.append(now)
            self._failures.move_to_end(client)
            while len(self._failures) > self.max_clients:
                self._failures.popitem(last=False)
            return len(times)

    def clear(self, client: str) -> None:
        """Forget ``client``'s failures (it gave the right code)."""
        with self._lock:
            self._failures.pop(client, None)

    def __len__(self) -> int:
        """The number of clients remembered."""
        return len(self._failures)

    def stored_timestamps(self) -> int:
        """The number of failure timestamps held, for all clients (for tests)."""
        with self._lock:
            return sum(len(t) for t in self._failures.values())


class AccessGate:
    """The state of the gate for one code: the expected cookie value, the failure limiter
    and the gate page. The code itself is not kept, only its cookie tag."""

    def __init__(self, code: str, web_dir: Path | None, *, limiter: FailureLimiter | None = None) -> None:
        if not normalize_code(code):
            raise ValueError("the access code is empty")
        self.cookie = cookie_value(code)
        self.limiter = limiter if limiter is not None else FailureLimiter()
        page = Path(web_dir) / GATE_PAGE if web_dir is not None else None
        #: The gate page (bytes), or None when ``web/access.html`` is missing.
        self.page: bytes | None = page.read_bytes() if page is not None and page.is_file() else None

    def code_matches(self, candidate: str) -> bool:
        """True when ``candidate`` is the code (after :func:`normalize_code`); constant time
        (two 43-character tags are compared, whatever the lengths of the codes)."""
        return hmac.compare_digest(cookie_value(candidate), self.cookie)

    def has_access(self, headers: Headers) -> bool:
        """True when the request carries the right ``mommy_access`` cookie.

        Every ``Cookie`` header is read (an HTTP/2 client may split its cookies over
        several, and a proxy may pass them on unjoined), and every ``mommy_access`` value
        in them is a candidate: another cookie of the same name (from a path or an older
        visit) does not hide the right one. Each is compared in constant time."""
        tag = self.cookie.encode("ascii")
        found = False
        for value in access_cookie_values(headers):
            if hmac.compare_digest(value.encode("utf-8", "surrogatepass"), tag):
                found = True
        return found


def access_cookie_values(headers: Headers) -> list[str]:
    """The values of every ``mommy_access`` cookie of the request, in the order sent
    (surrounding double quotes removed, as some clients send them)."""
    values: list[str] = []
    for raw in headers.getlist("cookie"):
        for part in raw.split(";"):
            name, sep, value = part.partition("=")
            if not sep or name.strip() != ACCESS_COOKIE:
                continue
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] == '"':
                value = value[1:-1]
            if value:
                values.append(value)
    return values


def _is_api(path: str) -> bool:
    return path == "/api" or path.startswith("/api/")


def is_navigation(headers: Headers) -> bool:
    """True for a browser loading a page (``Sec-Fetch-Mode: navigate``; for a client that
    sends no fetch metadata, an ``Accept`` header that asks for HTML)."""
    mode = headers.get("sec-fetch-mode")
    if mode is not None:
        return mode.strip().lower() == "navigate"
    return "text/html" in headers.get("accept", "").lower()


async def _send_json(send: Send, status: int, body: dict[str, str]) -> None:
    data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json; charset=utf-8"),
                (b"content-length", str(len(data)).encode("ascii")),
                (b"cache-control", b"no-store"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": data})


class AccessGateMiddleware:
    """Lets a request through only with the access cookie (see the module docstring).

    Passed without the cookie: ``POST /api/access`` and ``GET``/``HEAD`` of
    :data:`GATE_ASSETS` (exact paths). Refused without it, before any endpoint or static
    file runs and before the body is read: an ``/api/*`` request with ``401
    access_required`` (JSON), an HTML navigation (``GET``/``HEAD``) with the gate page
    (200, ``Cache-Control: no-store``) at whatever path it asked for, anything else with
    ``401 access_required``. Responses that pass through and are not ``/api/*`` get
    ``Cache-Control: private, no-cache`` when they set none, so a browser asks again
    (through the gate) before it reuses a cached page after the code has changed.
    """

    def __init__(self, app: ASGIApp, gate: AccessGate) -> None:
        self.app = app
        self.gate = gate

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        path: str = scope["path"]
        method: str = scope.get("method", "GET")
        if scope["type"] != "http":
            if self.gate.has_access(headers):
                await self.app(scope, receive, send)
            else:
                await send({"type": "websocket.close", "code": 1008})
            return

        if (
            self.gate.has_access(headers)
            or (path == ACCESS_PATH and method == "POST")
            or (path in GATE_ASSETS and method in ("GET", "HEAD"))
        ):
            if _is_api(path):
                await self.app(scope, receive, send)
                return

            async def send_revalidated(message: Message) -> None:
                if message["type"] == "http.response.start":
                    MutableHeaders(scope=message).setdefault("Cache-Control", "private, no-cache")
                await send(message)

            await self.app(scope, receive, send_revalidated)
            return

        if not _is_api(path) and method in ("GET", "HEAD") and self.gate.page is not None and is_navigation(headers):
            page = self.gate.page
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", b"text/html; charset=utf-8"),
                        (b"content-length", str(len(page)).encode("ascii")),
                        (b"cache-control", b"no-store"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": b"" if method == "HEAD" else page})
            return
        await _send_json(send, 401, {"error": "access_required", "message": ACCESS_REQUIRED_MESSAGE})


__all__ = [
    "ACCESS_COOKIE",
    "ACCESS_COOKIE_MAX_AGE",
    "ACCESS_PATH",
    "ACCESS_REQUIRED_MESSAGE",
    "BAD_CODE_MESSAGE",
    "CODE_ALPHABET",
    "CODE_LENGTH",
    "FAILURE_WINDOW_S",
    "GATE_ASSETS",
    "GATE_PAGE",
    "MAX_CLIENT_KEY_CHARS",
    "MAX_FAILURES",
    "MAX_TRACKED_CLIENTS",
    "OTHER_CLIENT",
    "TOO_MANY_MESSAGE",
    "UNKNOWN_CLIENT",
    "AccessGate",
    "AccessGateMiddleware",
    "FailureLimiter",
    "access_cookie_values",
    "client_key",
    "cookie_value",
    "is_navigation",
    "is_public_client",
    "normalize_code",
]

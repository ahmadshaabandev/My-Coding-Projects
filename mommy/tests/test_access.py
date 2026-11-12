"""The access gate of an online deployment (``MOMMY_ACCESS_CODE``, :mod:`mommy.access`).

Without the variable nothing changes (no gate, no ``/api/access``). With it, every
request needs the ``mommy_access`` cookie that ``POST /api/access`` gives for the code,
except the gate page's own files; the code is never logged.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from mommy import access as access_mod
from mommy.access import (
    ACCESS_COOKIE,
    ACCESS_COOKIE_MAX_AGE,
    CODE_ALPHABET,
    CODE_LENGTH,
    FAILURE_WINDOW_S,
    GATE_ASSETS,
    MAX_FAILURES,
    MAX_TRACKED_CLIENTS,
    AccessGate,
    AccessGateMiddleware,
    FailureLimiter,
    cookie_value,
    normalize_code,
)
from mommy.app import (
    MAX_BODY_BYTES,
    MAX_JSON_BYTES,
    HostOriginMiddleware,
    RequestGuardMiddleware,
    ResponseHeadersMiddleware,
    create_app,
)
from mommy.asr import FakeTranscriber
from mommy.config import Settings, load_settings
from mommy.llm import OfflineBrain
from mommy.tts import FakeTTS

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
BASE_URL = "http://127.0.0.1:8080"
#: A code as the deploy script makes them (12 characters of CODE_ALPHABET).
CODE = "k7m2p9q4r8s3"
OTHER_CODE = "x4h8n2w6t9b3"
#: The headers of a browser loading a page.
NAV = {"accept": "text/html,application/xhtml+xml,*/*;q=0.8", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document"}
#: The headers of a script or a fetch from a page.
SUBRESOURCE = {"accept": "*/*", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script"}
FETCH = {"accept": "*/*", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty"}
GATE_PAGE_BYTES = (WEB / "access.html").read_bytes()
INDEX_BYTES = (WEB / "index.html").read_bytes()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = dict(
        root=ROOT,
        models_dir=ROOT / "models",
        quran_dir=ROOT / "data" / "quran",
        web_dir=WEB,
        asr_model="small",
        asr_threads=1,
        anthropic_api_key_set=False,
        vision_model=None,
        text_model=None,
        effort="low",
    )
    base.update(overrides)
    return Settings(**base)


def make_app(code: str | None = CODE, *, tts: FakeTTS | None = None, **settings: Any) -> Any:
    return create_app(
        make_settings(access_code=code, **settings), FakeTranscriber("hello"), tts or FakeTTS(), OfflineBrain(), None
    )


def client_for(app: Any, **kwargs: Any) -> TestClient:
    return TestClient(app, base_url=BASE_URL, **kwargs)


def assert_access_required(response: Any) -> None:
    assert response.status_code == 401, (response.request.url, response.status_code, response.text[:200])
    assert response.headers["content-type"] == "application/json; charset=utf-8"
    assert response.json() == {"error": "access_required", "message": access_mod.ACCESS_REQUIRED_MESSAGE}
    assert response.headers["cache-control"] == "no-store"
    assert "set-cookie" not in response.headers
    assert_security_headers(response)


def assert_security_headers(response: Any) -> None:
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["content-security-policy"] == "frame-ancestors 'none'"


def assert_error(response: Any, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error", "message"} and body["error"] == code and body["message"]
    if response.request.url.path.startswith("/api/"):
        assert response.headers["cache-control"] == "no-store"
    return body


def cookie_attributes(set_cookie: str) -> tuple[str, str, dict[str, str]]:
    """(name, value, {attribute (lower case): value}) of one Set-Cookie header."""
    first, *rest = [part.strip() for part in set_cookie.split(";")]
    name, value = first.split("=", 1)
    attrs: dict[str, str] = {}
    for part in rest:
        key, _, val = part.partition("=")
        attrs[key.lower()] = val
    return name, value, attrs


def login(client: TestClient, code: str = CODE, **headers: str) -> Any:
    return client.post("/api/access", json={"code": code}, headers=headers or None)


class Clock:
    """A clock for the failure limiter that only moves when told to."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def no_code_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.delenv("MOMMY_ACCESS_CODE", raising=False)
    yield


# ---------------------------------------------------------------------------
# No code: nothing changes
# ---------------------------------------------------------------------------


class TestWithoutCode:
    def test_settings_have_no_code(self, no_code_env: None, monkeypatch: pytest.MonkeyPatch) -> None:
        assert load_settings().access_code is None
        monkeypatch.setenv("MOMMY_ACCESS_CODE", "   ")
        assert load_settings().access_code is None  # blank counts as unset

    def test_existing_app_without_the_env_var(self, no_code_env: None) -> None:
        """The app as run.sh builds it (settings from the environment), with no code set:
        the middleware, the pages, the API and the headers are exactly as before."""
        settings = load_settings()
        app = create_app(settings, FakeTranscriber("hello"), FakeTTS(), OfflineBrain(), None)
        assert [m.cls for m in app.user_middleware] == [ResponseHeadersMiddleware, HostOriginMiddleware, RequestGuardMiddleware]
        assert app.state.access_gate is None
        assert "/api/access" not in {getattr(r, "path", None) for r in app.routes}
        client = client_for(app)
        responses = []
        r = client.get("/", headers=NAV)
        responses.append(r)
        assert r.status_code == 200 and r.content == INDEX_BYTES
        assert "cache-control" not in r.headers
        for name in ("app.js", "recorder.js", "rewards.js", "family.js", "styles.css"):
            r = client.get("/" + name, headers=SUBRESOURCE)
            responses.append(r)
            assert r.status_code == 200 and r.content == (WEB / name).read_bytes()
            assert "cache-control" not in r.headers
        r = client.get("/api/health")
        responses.append(r)
        assert r.status_code == 200 and r.json()["asr"] is True
        r = client.post("/api/tts", json={"text": "Hello", "lang": "en"})
        responses.append(r)
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        r = client.post("/api/access", json={"code": CODE})
        responses.append(r)
        assert_error(r, 404, "not_found")
        r = client.get("/some/page", headers=NAV)
        responses.append(r)
        assert r.status_code == 404  # no gate page at other paths
        for r in responses:
            assert "set-cookie" not in r.headers
            assert r.headers["x-frame-options"] == "DENY"
        assert client.cookies.get(ACCESS_COOKIE) is None

    def test_gate_files_are_plain_static_files(self, no_code_env: None) -> None:
        client = client_for(make_app(None))
        r = client.get("/access.html", headers=NAV)
        assert r.status_code == 200 and r.content == GATE_PAGE_BYTES


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


class TestSettings:
    def test_code_from_the_environment(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("MOMMY_ACCESS_CODE", "  " + CODE + "\n")
        settings = load_settings()
        assert settings.access_code == CODE
        assert CODE not in repr(settings) and CODE not in str(settings)

    def test_short_code_is_refused_without_quoting_it(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("MOMMY_ACCESS_CODE", "abc12")
        with pytest.raises(ValueError) as info:
            load_settings()
        assert "abc12" not in str(info.value)

    def test_alphabet_has_no_look_alikes(self) -> None:
        assert CODE_LENGTH == 12 and len(set(CODE_ALPHABET)) == len(CODE_ALPHABET) == 31
        assert not set("01ilo") & set(CODE_ALPHABET)


# ---------------------------------------------------------------------------
# The gate refuses everything without the cookie
# ---------------------------------------------------------------------------


class TestGateWithoutCookie:
    def test_middleware_order(self) -> None:
        app = make_app()
        assert [m.cls for m in app.user_middleware] == [
            ResponseHeadersMiddleware,
            HostOriginMiddleware,
            AccessGateMiddleware,
            RequestGuardMiddleware,
        ]

    @pytest.mark.parametrize("path", ["/", "/index.html", "/recite", "/a/b/c?x=1", "/app.js", "/nope.png", "/access"])
    def test_navigation_gets_the_gate_page(self, path: str) -> None:
        r = client_for(make_app()).get(path, headers=NAV)
        assert r.status_code == 200
        assert r.content == GATE_PAGE_BYTES
        assert r.headers["content-type"] == "text/html; charset=utf-8"
        assert r.headers["cache-control"] == "no-store"
        assert "set-cookie" not in r.headers
        assert_security_headers(r)

    def test_navigation_without_fetch_metadata(self) -> None:
        client = client_for(make_app())
        r = client.get("/", headers={"accept": "text/html"})
        assert r.status_code == 200 and r.content == GATE_PAGE_BYTES
        assert_access_required(client.get("/", headers={"accept": "*/*"}))

    def test_head_navigation(self) -> None:
        r = client_for(make_app()).head("/", headers=NAV)
        assert r.status_code == 200 and r.content == b""
        assert int(r.headers["content-length"]) == len(GATE_PAGE_BYTES)

    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("GET", "/api/health"),
            ("GET", "/api/quran/surahs"),
            ("GET", "/api/openapi.json"),
            ("GET", "/api/nope"),
            ("GET", "/api/access"),
            ("OPTIONS", "/api/health"),
            ("POST", "/api/tts"),
            ("POST", "/api/text/check"),
            ("POST", "/api/access/"),
        ],
    )
    def test_api_gets_401(self, method: str, path: str) -> None:
        client = client_for(make_app())
        assert_access_required(client.request(method, path, json={"text": "Hello", "lang": "en"}))
        # A navigation to the API is not given the page either.
        assert_access_required(client.request(method, path, headers=NAV))

    @pytest.mark.parametrize("path", ["/app.js", "/recorder.js", "/rewards.js", "/family.js", "/index.html", "/", "/missing.png", "/styles.css/", "/access.js/"])
    def test_other_files_get_401(self, path: str) -> None:
        client = client_for(make_app())
        assert_access_required(client.get(path, headers=SUBRESOURCE))
        assert_access_required(client.get(path, headers=FETCH))

    def test_writes_outside_the_api_get_401(self) -> None:
        client = client_for(make_app())
        for path in ("/", "/access.html", "/styles.css"):
            assert_access_required(client.post(path, content=b"code=" + CODE.encode(), headers={"content-type": "application/x-www-form-urlencoded"}))

    @pytest.mark.parametrize("path", sorted(GATE_ASSETS))
    def test_gate_files_are_served_without_the_cookie(self, path: str) -> None:
        client = client_for(make_app())
        for headers in (SUBRESOURCE, NAV):
            r = client.get(path, headers=headers)
            assert r.status_code == 200 and r.content == (WEB / path.lstrip("/")).read_bytes()
            assert r.headers["cache-control"] == "private, no-cache"
            assert_security_headers(r)
        assert client.head(path).status_code == 200

    def test_no_endpoint_runs_and_no_body_is_read(self) -> None:
        tts = FakeTTS()
        client = client_for(make_app(tts=tts))
        assert_access_required(client.post("/api/tts", json={"text": "Hello", "lang": "en"}))
        assert tts.calls == []
        # Larger than any body limit: refused by the gate (401) before RequestGuard (413).
        assert_access_required(client.post("/api/recite/check", content=b"x" * (MAX_BODY_BYTES + 10)))

    def test_body_is_never_received(self) -> None:
        """At the ASGI level: the gate answers without calling ``receive`` once."""
        app = make_app()
        received: list[str] = []
        sent: list[dict] = []

        async def receive() -> dict:
            received.append("receive")
            return {"type": "http.request", "body": b"x" * 1000, "more_body": False}

        async def send(message: dict) -> None:
            sent.append(message)

        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST", "scheme": "http",
            "path": "/api/recite/check", "raw_path": b"/api/recite/check", "query_string": b"", "root_path": "",
            "headers": [(b"host", b"127.0.0.1:8080"), (b"content-type", b"multipart/form-data; boundary=x")],
            "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8080),
        }
        asyncio.run(app(scope, receive, send))
        assert sent[0]["type"] == "http.response.start" and sent[0]["status"] == 401
        assert received == []

    def test_unknown_host_is_refused_before_the_gate(self) -> None:
        client = TestClient(make_app(), base_url="http://evil.example")
        assert_error(client.get("/", headers=NAV), 400, "bad_host")
        assert_error(client.post("/api/access", json={"code": CODE}), 400, "bad_host")

    def test_cross_origin_code_post_is_refused(self) -> None:
        client = client_for(make_app())
        r = client.post("/api/access", json={"code": CODE}, headers={"origin": "https://evil.example"})
        assert_error(r, 403, "bad_origin")
        assert "set-cookie" not in r.headers
        r = client.post("/api/access", json={"code": CODE}, headers={"origin": BASE_URL})
        assert r.status_code == 204

    def test_without_web_dir_navigation_gets_401(self, tmp_path: Path) -> None:
        client = client_for(make_app(web_dir=tmp_path / "missing"))
        assert_access_required(client.get("/", headers=NAV))
        assert login(client).status_code == 204


# ---------------------------------------------------------------------------
# The code, the cookie and the failure limit
# ---------------------------------------------------------------------------


class TestCodeAndCookie:
    def test_right_code_sets_the_cookie_and_opens_everything(self) -> None:
        client = client_for(make_app())
        r = login(client)
        assert r.status_code == 204 and r.content == b""
        assert r.headers["cache-control"] == "no-store"
        name, value, attrs = cookie_attributes(r.headers["set-cookie"])
        assert name == ACCESS_COOKIE
        assert value == cookie_value(CODE) and CODE not in value
        assert attrs.keys() == {"httponly", "max-age", "path", "samesite"}  # no Secure over http
        assert attrs["max-age"] == str(ACCESS_COOKIE_MAX_AGE) == str(180 * 24 * 3600)
        assert attrs["path"] == "/" and attrs["samesite"].lower() == "lax"
        # The client keeps the cookie: everything opens.
        r = client.get("/", headers=NAV)
        assert r.status_code == 200 and r.content == INDEX_BYTES
        assert r.headers["cache-control"] == "private, no-cache"
        for name in ("app.js", "recorder.js", "rewards.js", "family.js", "styles.css", "index.html"):
            r = client.get("/" + name, headers=SUBRESOURCE)
            assert r.status_code == 200 and r.content == (WEB / name).read_bytes()
        assert client.get("/api/health").status_code == 200
        r = client.post("/api/tts", json={"text": "Hello", "lang": "en"})
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        assert r.headers["cache-control"] == "no-store"
        assert_error(client.get("/api/nope"), 404, "not_found")
        assert_error(client.get("/api/access"), 405, "method_not_allowed")
        r = client.get("/missing-page", headers=NAV)
        assert r.status_code == 404

    def test_cookie_value(self) -> None:
        value = cookie_value(CODE)
        assert re.fullmatch(r"[A-Za-z0-9_-]{43}", value)
        assert base64.urlsafe_b64decode(value + "=") and len(base64.urlsafe_b64decode(value + "=")) == 32
        assert cookie_value(CODE) == value  # the same code, the same cookie (a restart keeps people in)
        assert cookie_value(OTHER_CODE) != value
        assert cookie_value(" k٧m٢p٩q٤r٨s٣ ") == value

    @pytest.mark.parametrize(
        "typed",
        [
            "k٧m٢p٩q٤r٨s٣",  # Arabic-Indic digits
            "k۷m۲p۹q۴r۸s۳",  # Eastern Arabic-Indic (Persian) digits
            "k7m٢p۹q4r٨s۳",  # mixed
            "  k7m2p9q4r8s3\n",  # surrounding white space
            " k٧m٢p٩q٤r٨s٣\t",
        ],
    )
    def test_arabic_indic_digits_are_accepted(self, typed: str) -> None:
        client = client_for(make_app())
        r = login(client, typed)
        assert r.status_code == 204
        assert cookie_attributes(r.headers["set-cookie"])[1] == cookie_value(CODE)
        assert client.get("/api/health").status_code == 200

    def test_configured_code_with_arabic_digits(self) -> None:
        client = client_for(make_app("k٧m٢p٩q٤r٨s٣"))
        assert login(client, CODE).status_code == 204

    def test_wrong_code_then_too_many_attempts(self) -> None:
        app = make_app()
        clock = Clock()
        app.state.access_gate.limiter.clock = clock
        client = client_for(app)
        for i in range(MAX_FAILURES):
            r = login(client, OTHER_CODE if i % 2 else CODE + "x")
            assert_error(r, 403, "bad_access_code")
            assert "set-cookie" not in r.headers
            clock.now += 1
        # The 11th failure is refused without being checked, with Retry-After.
        r = login(client, OTHER_CODE)
        assert_error(r, 429, "too_many_attempts")
        retry = int(r.headers["retry-after"])
        assert retry == int(FAILURE_WINDOW_S) - MAX_FAILURES  # the oldest failure is 10 s old
        assert 1 <= retry <= 600
        # Even the right code waits.
        assert_error(login(client), 429, "too_many_attempts")
        assert_access_required(client.get("/api/health"))
        # Once the oldest failure is 10 minutes old, one more try is allowed.
        clock.now += retry
        assert_error(login(client, OTHER_CODE), 403, "bad_access_code")
        assert_error(login(client, OTHER_CODE), 429, "too_many_attempts")
        clock.now += FAILURE_WINDOW_S
        assert login(client).status_code == 204
        assert client.get("/api/health").status_code == 200

    def test_right_code_clears_the_failures(self) -> None:
        client = client_for(make_app())
        for _ in range(MAX_FAILURES - 1):
            assert_error(login(client, OTHER_CODE), 403, "bad_access_code")
        assert login(client).status_code == 204
        for _ in range(MAX_FAILURES):
            assert_error(login(client, OTHER_CODE), 403, "bad_access_code")
        assert_error(login(client, OTHER_CODE), 429, "too_many_attempts")

    def test_bad_bodies_are_422_and_not_failures(self) -> None:
        client = client_for(make_app())
        assert_error(client.post("/api/access", json={}), 422, "missing_field")
        assert_error(client.post("/api/access", content=b"code=" + CODE.encode(), headers={"content-type": "application/json"}), 422, "invalid_field")
        assert_error(client.post("/api/access", json={"code": 5}), 422, "invalid_field")
        for _ in range(MAX_FAILURES):
            assert_error(login(client, OTHER_CODE), 403, "bad_access_code")
        assert_error(login(client, OTHER_CODE), 429, "too_many_attempts")

    def test_body_limit_applies(self) -> None:
        client = client_for(make_app())
        body = b'{"code": "' + b"a" * (MAX_JSON_BYTES + 1) + b'"}'
        assert_error(client.post("/api/access", content=body, headers={"content-type": "application/json"}), 413, "too_large")

    def test_changing_the_code_invalidates_old_cookies(self) -> None:
        old = client_for(make_app(CODE))
        assert login(old).status_code == 204
        cookie = old.cookies.get(ACCESS_COOKIE)
        assert cookie == cookie_value(CODE)
        # The same code after a restart: still in.
        again = client_for(make_app(CODE), cookies={ACCESS_COOKIE: cookie})
        assert again.get("/api/health").status_code == 200
        # A new code: the old cookie opens nothing.
        new = client_for(make_app(OTHER_CODE), cookies={ACCESS_COOKIE: cookie})
        assert_access_required(new.get("/api/health"))
        assert_access_required(new.get("/app.js", headers=SUBRESOURCE))
        assert new.get("/", headers=NAV).content == GATE_PAGE_BYTES
        assert login(new, CODE).status_code == 403
        assert login(new, OTHER_CODE).status_code == 204
        assert new.get("/api/health").status_code == 200

    def test_forged_or_truncated_cookie_is_refused(self) -> None:
        app = make_app()
        good = cookie_value(CODE)
        flipped = good[:10] + ("A" if good[10] != "A" else "B") + good[11:]
        forged = [
            good[:-1], good[:20], good[:1], good + "A", good + "=", good.swapcase(), flipped, " " + good + "x",
            "", CODE, cookie_value(OTHER_CODE), base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode(),
            '"' + good[:-1] + '"', good.encode().hex(),
        ]
        for value in forged:
            client = client_for(app)
            r = client.get("/api/health", headers={"cookie": f"{ACCESS_COOKIE}={value}"})
            assert_access_required(r)
            assert client.get("/", headers={**NAV, "cookie": f"{ACCESS_COOKIE}={value}"}).content == GATE_PAGE_BYTES
        client = client_for(app)
        # The right value under another name, or as another cookie's value, opens nothing.
        assert_access_required(client.get("/api/health", headers={"cookie": f"mommy_access2={good}; other={good}"}))
        # The right cookie among others opens it (also quoted, as some clients send it).
        assert client.get("/api/health", headers={"cookie": f"a=1; {ACCESS_COOKIE}={good}; b=2"}).status_code == 200
        assert client.get("/api/health", headers={"cookie": f'{ACCESS_COOKIE}="{good}"'}).status_code == 200


# ---------------------------------------------------------------------------
# Behind a proxy (uvicorn --proxy-headers)
# ---------------------------------------------------------------------------


class TestBehindProxy:
    HOST = "someone-mommy.hf.space"

    def proxied(self, **settings: Any) -> TestClient:
        app = make_app(allowed_hosts=(self.HOST,), **settings)
        # What uvicorn --proxy-headers wraps the app in (trusting the test client).
        return TestClient(ProxyHeadersMiddleware(app, trusted_hosts="*"), base_url=f"http://{self.HOST}")

    def test_secure_when_the_proxy_says_https(self) -> None:
        client = self.proxied()
        origin = {"origin": f"https://{self.HOST}"}
        r = login(client, **origin, **{"x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7"})
        assert r.status_code == 204
        _, value, attrs = cookie_attributes(r.headers["set-cookie"])
        assert value == cookie_value(CODE)
        assert "secure" in attrs and "httponly" in attrs and attrs["samesite"].lower() == "lax"
        # Plain http (no X-Forwarded-Proto): no Secure.
        r = login(client, **{"x-forwarded-for": "203.0.113.7"})
        assert r.status_code == 204 and "secure" not in cookie_attributes(r.headers["set-cookie"])[2]

    def test_failures_are_counted_per_forwarded_client(self) -> None:
        client = self.proxied()
        first = {"x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7"}
        second = {"x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.9"}
        for _ in range(MAX_FAILURES):
            assert_error(login(client, OTHER_CODE, **first), 403, "bad_access_code")
        assert_error(login(client, OTHER_CODE, **first), 429, "too_many_attempts")
        assert_error(login(client, OTHER_CODE, **second), 403, "bad_access_code")
        assert login(client, **second).status_code == 204

    def test_cross_origin_still_refused_behind_the_proxy(self) -> None:
        client = self.proxied()
        r = login(client, **{"origin": "https://evil.example", "x-forwarded-proto": "https"})
        assert_error(r, 403, "bad_origin")


# ---------------------------------------------------------------------------
# The failure limiter's memory
# ---------------------------------------------------------------------------


class TestFailureLimiter:
    def test_defaults(self) -> None:
        limiter = make_app().state.access_gate.limiter
        assert (limiter.max_failures, limiter.window_s, limiter.max_clients) == (10, 600.0, 10_000)
        assert MAX_TRACKED_CLIENTS == 10_000

    def test_memory_stays_bounded(self) -> None:
        clock = Clock()
        limiter = FailureLimiter(clock=clock)
        for i in range(25_000):
            limiter.record_failure(f"10.{i // 65536}.{i // 256 % 256}.{i % 256}")
        assert len(limiter) == MAX_TRACKED_CLIENTS
        assert limiter.stored_timestamps() == MAX_TRACKED_CLIENTS
        # The least recently failed are forgotten first; the latest are kept.
        assert "10.0.0.0" not in limiter._failures
        assert "10.0.97.167" in limiter._failures  # client 24,999
        # One client cannot grow its own entry either.
        for _ in range(1000):
            limiter.record_failure("203.0.113.7")
        assert len(limiter._failures["203.0.113.7"]) == MAX_FAILURES
        assert len(limiter) == MAX_TRACKED_CLIENTS
        assert limiter.stored_timestamps() <= MAX_TRACKED_CLIENTS * MAX_FAILURES

    def test_old_failures_expire_and_are_dropped(self) -> None:
        clock = Clock()
        limiter = FailureLimiter(clock=clock)
        for _ in range(MAX_FAILURES):
            limiter.record_failure("a")
        assert limiter.retry_after("a") == 600
        clock.now += 599.5
        assert limiter.retry_after("a") == 1
        clock.now += 0.5
        assert limiter.retry_after("a") is None
        assert len(limiter) == 0  # an expired entry is removed when it is looked at
        limiter.record_failure("b")
        limiter.clear("b")
        assert len(limiter) == 0


# ---------------------------------------------------------------------------
# Logs
# ---------------------------------------------------------------------------


def test_no_log_record_contains_the_code(caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    secrets = [CODE, "k٧m٢p٩q٤r٨s٣", OTHER_CODE, cookie_value(CODE), cookie_value(OTHER_CODE)]
    logger = logging.getLogger("mommy")
    logger.addHandler(caplog.handler)  # also when another test turned propagation off
    try:
        with caplog.at_level(logging.DEBUG):
            monkeypatch.setenv("MOMMY_ACCESS_CODE", CODE)
            settings = load_settings()
            logging.getLogger("mommy.test").info("settings: %r", settings)
            app = create_app(settings, FakeTranscriber("hello"), FakeTTS(), OfflineBrain(), None)
            client = client_for(app)
            client.get("/", headers=NAV)
            client.get("/api/health")
            client.get("/api/health", headers={"cookie": f"{ACCESS_COOKIE}={cookie_value(OTHER_CODE)}"})
            for _ in range(MAX_FAILURES + 1):
                login(client, OTHER_CODE)
            login(client, "k٧m٢p٩q٤r٨s٣")
            app.state.access_gate.limiter.clear("testclient")
            login(client, "k٧m٢p٩q٤r٨s٣")
            client.get("/api/health")
            client.post("/api/access", json={"code": CODE, "extra": CODE})
            client.post("/api/access", content=b'{"code": "' + CODE.encode() + b'"', headers={"content-type": "application/json"})
    finally:
        logger.removeHandler(caplog.handler)
    text = caplog.text
    assert "refused a wrong access code" in text and "access code accepted" in text and "paused" in text
    for record in caplog.records:
        message = record.getMessage() + repr(record.args) + repr(getattr(record, "exc_text", ""))
        for secret in secrets:
            assert secret not in message, record.getMessage()


# ---------------------------------------------------------------------------
# The gate page follows the CSP
# ---------------------------------------------------------------------------


class TestGatePage:
    def test_no_inline_script_or_style_and_self_only(self) -> None:
        html = GATE_PAGE_BYTES.decode("utf-8")
        scripts = re.findall(r"<script\b[^>]*>(.*?)</script>", html, flags=re.S)
        assert scripts == [""]  # one script, with src and no content
        assert re.findall(r'<script\b[^>]*\bsrc="([^"]+)"', html) == ["/access.js"]
        assert re.findall(r'<link rel="stylesheet" href="([^"]+)"', html) == ["/styles.css"]
        assert not re.search(r"<style\b|\sstyle=|\son[a-z]+=", html, flags=re.I)
        csp = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', html).group(1)
        assert "unsafe" not in csp and "http" not in csp and "*" not in csp
        assert "script-src 'self';" in csp and "connect-src 'self';" in csp and "form-action 'none'" in csp
        assert "http://" not in html and "https://" not in html
        # The code field has no name, so a form submitted without JavaScript carries nothing.
        field = re.search(r'<input[^>]*id="access-code"[^>]*>', html, flags=re.S).group(0)
        assert " name=" not in field and 'autocomplete="off"' in field
        assert 'method="post"' in html

    def test_script_makes_no_other_request_and_keeps_nothing(self) -> None:
        js = (WEB / "access.js").read_text("utf-8")
        assert not re.search(r"""['"`]\s*(https?:)?//""", js)  # no absolute or protocol-relative URL string
        assert re.findall(r"fetch\('([^']+)'", js) == ["/api/access"]
        for word in ("localStorage", "sessionStorage", "document.cookie", "indexedDB", "?code", "console."):
            assert word not in js
        assert "history.replaceState" in js

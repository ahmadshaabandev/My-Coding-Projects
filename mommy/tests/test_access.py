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
from mommy import app as app_mod
from mommy.access import (
    ACCESS_COOKIE,
    ACCESS_COOKIE_MAX_AGE,
    CODE_ALPHABET,
    CODE_LENGTH,
    FAILURE_WINDOW_S,
    GATE_ASSETS,
    MAX_CLIENT_KEY_CHARS,
    MAX_FAILURES,
    MAX_TRACKED_CLIENTS,
    AccessGate,
    AccessGateMiddleware,
    FailureLimiter,
    access_cookie_values,
    client_key,
    cookie_value,
    is_public_client,
    normalize_code,
)
from mommy.app import (
    HSTS_VALUE,
    MAX_BODY_BYTES,
    MAX_JSON_BYTES,
    HostOriginMiddleware,
    RequestGuardMiddleware,
    ResponseHeadersMiddleware,
    create_app,
    is_loopback_host,
    start_preload,
)
from mommy.asr import FakeTranscriber
from mommy.config import Settings, load_settings
from mommy.llm import OfflineBrain
from mommy.tts import FakeTTS

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
BASE_URL = "http://127.0.0.1:8080"
#: The Host of BASE_URL: the host the cookies of client_for are given for.
LOCAL = "127.0.0.1:8080"
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
#: The proxy networks scripts/space_start.sh gives uvicorn's --forwarded-allow-ips.
SPACE_TRUSTED_PROXIES = re.search(
    r"^TRUSTED_PROXIES='([^']+)'$", (ROOT / "scripts" / "space_start.sh").read_text("utf-8"), flags=re.M
).group(1)
#: Blank to Python's str.strip(), though not to a shell's ' \t\r\n' (SEC-1).
UNICODE_BLANKS = ["", " ", "\t\n", "\u00a0", "\x0b", "\x0c", "\x1f", "\u2003", "\u3000", " \u00a0\u3000 "]


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
    monkeypatch.delenv("MOMMY_REQUIRE_ACCESS_CODE", raising=False)
    yield


@pytest.fixture
def restore_mommy_logger() -> Iterator[None]:
    """build_default_app configures the ``mommy`` logger; put it back for other tests."""
    logger = logging.getLogger("mommy")
    saved = (list(logger.handlers), logger.level, logger.propagate)
    yield
    logger.handlers[:] = saved[0]
    logger.setLevel(saved[1])
    logger.propagate = saved[2]


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
        assert r.json()["online"] is False  # local: the client says that nothing leaves this computer
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
            assert "strict-transport-security" not in r.headers
            assert r.headers["x-frame-options"] == "DENY"
        assert client.cookies.get(ACCESS_COOKIE) is None

    def test_no_preload_without_code(
        self, no_code_env: None, monkeypatch: pytest.MonkeyPatch, restore_mommy_logger: None
    ) -> None:
        """Local use keeps loading each language on first use."""
        started = fake_default_components(monkeypatch)
        app_mod.build_default_app()
        assert started == []

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

    @pytest.mark.parametrize("blank", UNICODE_BLANKS)
    def test_unicode_blank_code_means_no_gate(self, blank: str, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("MOMMY_REQUIRE_ACCESS_CODE", raising=False)
        monkeypatch.setenv("MOMMY_ACCESS_CODE", blank)
        settings = load_settings()
        assert settings.access_code is None
        assert create_app(settings, FakeTranscriber("hello"), FakeTTS(), OfflineBrain(), None).state.access_gate is None

    @pytest.mark.parametrize("blank", [None, *UNICODE_BLANKS])
    def test_required_code_cannot_be_blank(self, blank: str | None, monkeypatch: pytest.MonkeyPatch) -> None:
        """SEC-1: the image sets MOMMY_REQUIRE_ACCESS_CODE; a code that is blank to Python
        (a no-break or ideographic space, \\v, \\x1f...) then stops the server instead of
        giving an app with no gate."""
        monkeypatch.setenv("MOMMY_REQUIRE_ACCESS_CODE", "1")
        if blank is None:
            monkeypatch.delenv("MOMMY_ACCESS_CODE", raising=False)
        else:
            monkeypatch.setenv("MOMMY_ACCESS_CODE", blank)
        with pytest.raises(ValueError, match="MOMMY_ACCESS_CODE is not set"):
            load_settings()

    def test_required_code_is_accepted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("MOMMY_REQUIRE_ACCESS_CODE", "1")
        monkeypatch.setenv("MOMMY_ACCESS_CODE", "\u00a0" + CODE + "\u3000")
        settings = load_settings()
        assert settings.access_code == CODE
        app = create_app(settings, FakeTranscriber("hello"), FakeTTS(), OfflineBrain(), None)
        assert app.state.access_gate is not None and app.state.access_gate.cookie_for(LOCAL) == cookie_value(CODE, LOCAL)
        monkeypatch.setenv("MOMMY_REQUIRE_ACCESS_CODE", "   ")  # blank: not required
        monkeypatch.delenv("MOMMY_ACCESS_CODE")
        assert load_settings().access_code is None

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

    def test_refused_host_name_is_logged(self, caplog: pytest.LogCaptureFixture) -> None:
        """OPS-9: the log names the host that was refused (what MOMMY_ALLOWED_HOSTS lacks),
        quoted and cut, so a forged Host header cannot write log lines of its own."""
        logger = logging.getLogger("mommy")
        logger.addHandler(caplog.handler)
        try:
            with caplog.at_level(logging.INFO):
                TestClient(make_app(), base_url="http://Other-Mommy.hf.space:443").get("/", headers=NAV)
                TestClient(make_app(), base_url="http://127.0.0.1").get("/", headers={"host": "a\nb" + "x" * 200})
        finally:
            logger.removeHandler(caplog.handler)
        lines = list(dict.fromkeys(r.getMessage() for r in caplog.records if "unknown host" in r.getMessage()))
        assert lines[0] == "refused a request for an unknown host 'other-mommy.hf.space'"
        assert "\n" not in lines[1] and lines[1].endswith("x'") and len(lines[1]) < 140

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
        assert value == cookie_value(CODE, LOCAL) and CODE not in value
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
        r = client.get("/api/health")
        # The gate is on: the app is online (here on a loopback name, as the image tested
        # locally), so the client says that the data goes to this server.
        assert r.status_code == 200 and r.json()["online"] is True
        r = client.post("/api/tts", json={"text": "Hello", "lang": "en"})
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        assert r.headers["cache-control"] == "no-store"
        assert_error(client.get("/api/nope"), 404, "not_found")
        assert_error(client.get("/api/access"), 405, "method_not_allowed")
        r = client.get("/missing-page", headers=NAV)
        assert r.status_code == 404

    def test_cookie_value(self) -> None:
        value = cookie_value(CODE, LOCAL)
        assert re.fullmatch(r"[A-Za-z0-9_-]{43}", value)
        assert base64.urlsafe_b64decode(value + "=") and len(base64.urlsafe_b64decode(value + "=")) == 32
        assert cookie_value(CODE, LOCAL) == value  # the same code, the same cookie (a restart keeps people in)
        assert cookie_value(OTHER_CODE, LOCAL) != value
        assert cookie_value(" k٧m٢p٩q٤r٨s٣ ", LOCAL) == value
        # Bound to the host name (case, port and a trailing dot aside): a cookie given for
        # one host opens no other (SEC-4).
        for same in ("127.0.0.1", "127.0.0.1:9000", " 127.0.0.1. "):
            assert cookie_value(CODE, same) == value, same
        for other in ("localhost", "localhost:8080", "abc.trycloudflare.com", "someone-mommy.hf.space", ""):
            assert cookie_value(CODE, other) != value, other
        assert cookie_value(CODE, "Abc.TryCloudflare.com.:443") == cookie_value(CODE, "abc.trycloudflare.com")
        assert cookie_value(CODE, "[::1]:8080") == cookie_value(CODE, "::1")

    def test_a_cookie_opens_only_the_host_it_was_given_for(self) -> None:
        """SEC-4: browsers send a cookie of http://localhost to every port of localhost
        (a local dev server sees it): it must not open the app under its public name."""
        app = make_app(allowed_hosts=("localhost", "127.0.0.1", "someone-mommy.hf.space"))
        local = TestClient(app, base_url="http://localhost:8080")
        assert login(local, origin="http://localhost:8080").status_code == 204
        leaked = local.cookies.get(ACCESS_COOKIE)
        assert leaked == cookie_value(CODE, "localhost")
        assert local.get("/api/health").status_code == 200
        public = TestClient(app, base_url="http://someone-mommy.hf.space")
        assert_access_required(public.get("/api/health", headers={"cookie": f"{ACCESS_COOKIE}={leaked}"}))
        loopback_ip = TestClient(app, base_url="http://127.0.0.1:8080")
        assert_access_required(loopback_ip.get("/api/health", headers={"cookie": f"{ACCESS_COOKIE}={leaked}"}))
        good = cookie_value(CODE, "someone-mommy.hf.space")
        assert public.get("/api/health", headers={"cookie": f"{ACCESS_COOKIE}={good}"}).status_code == 200

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
        assert cookie_attributes(r.headers["set-cookie"])[1] == cookie_value(CODE, LOCAL)
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
        assert cookie == cookie_value(CODE, LOCAL)
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
        good = cookie_value(CODE, LOCAL)
        flipped = good[:10] + ("A" if good[10] != "A" else "B") + good[11:]
        forged = [
            good[:-1], good[:20], good[:1], good + "A", good + "=", good.swapcase(), flipped, " " + good + "x",
            "", CODE, cookie_value(OTHER_CODE, LOCAL), base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode(),
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
    #: The address of the proxy as the container sees it (a private network).
    PROXY = ("10.20.30.40", 41000)

    def proxied(self, trusted: str = SPACE_TRUSTED_PROXIES, **settings: Any) -> TestClient:
        """The app as scripts/space_start.sh runs it (uvicorn --proxy-headers with its
        --forwarded-allow-ips), the test client connecting from the proxy's address."""
        app = make_app(allowed_hosts=(self.HOST,), **settings)
        self.app = app
        return TestClient(ProxyHeadersMiddleware(app, trusted_hosts=trusted), base_url=f"http://{self.HOST}", client=self.PROXY)

    @pytest.mark.parametrize(
        "proto",
        [["https"], ["HTTPS"], ["https, http"], ["https,https"], ["https", "http"], [], ["http"], ["ftp"]],
    )
    def test_cookie_is_secure_whatever_the_proxy_sends(self, proto: list[str]) -> None:
        """SEC-3: online the cookie is Secure even when uvicorn does not take the proxy's
        X-Forwarded-Proto (upper case, a list, repeated, missing): only an exact https
        makes the scheme https."""
        client = self.proxied()
        headers = [("x-forwarded-for", "203.0.113.7")] + [("x-forwarded-proto", p) for p in proto]
        r = client.post("/api/access", json={"code": CODE}, headers=headers)
        assert r.status_code == 204
        _, value, attrs = cookie_attributes(r.headers["set-cookie"])
        assert value == cookie_value(CODE, self.HOST)
        assert "secure" in attrs and "httponly" in attrs and attrs["samesite"].lower() == "lax"
        assert r.headers["strict-transport-security"] == HSTS_VALUE

    @pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "[::1]", "127.0.0.2", "app.localhost"])
    def test_no_secure_on_a_loopback_host_over_http(self, host: str) -> None:
        """The local test of the image (http://localhost:7860) keeps working: over plain
        http only a loopback host gets a cookie without Secure, and no HSTS."""
        name = host.strip("[]")
        app = make_app(allowed_hosts=(name,))
        client = TestClient(app, base_url=f"http://{host}:7860")
        r = login(client)
        assert r.status_code == 204
        assert "secure" not in cookie_attributes(r.headers["set-cookie"])[2]
        assert "strict-transport-security" not in r.headers
        assert client.get("/api/health").status_code == 200
        assert "strict-transport-security" not in client.get("/", headers=NAV).headers
        # Over https a loopback host gets Secure too.
        secure = TestClient(ProxyHeadersMiddleware(app, trusted_hosts="127.0.0.1"), base_url=f"http://{host}:7860", client=("127.0.0.1", 5))
        r = login(secure, **{"x-forwarded-proto": "https"})
        assert "secure" in cookie_attributes(r.headers["set-cookie"])[2]

    def test_hsts_on_every_answer_online(self) -> None:
        client = self.proxied()
        nav = client.get("/", headers=NAV)
        assert nav.content == GATE_PAGE_BYTES
        answers = [nav, client.get("/api/health"), client.get("/app.js", headers=SUBRESOURCE), client.get("/access.js")]
        answers.append(login(client, OTHER_CODE, **{"x-forwarded-for": "203.0.113.8"}))
        answers.append(login(client, **{"x-forwarded-for": "203.0.113.8"}))
        answers.append(client.get("/", headers=NAV))
        for r in answers:
            assert r.headers["strict-transport-security"] == HSTS_VALUE, r.request.url
            assert_security_headers(r)

    def test_loopback_hosts(self) -> None:
        for name in ("localhost", "127.0.0.1", "127.1.2.3", "::1", "a.localhost"):
            assert is_loopback_host(name), name
        for name in ("someone-mommy.hf.space", "10.0.0.5", "0.0.0.0", "", "localhost.example", "::"):
            assert not is_loopback_host(name), name

    def test_failures_are_counted_per_client_the_proxy_saw(self) -> None:
        """SEC-2: with the proxy networks of space_start.sh, uvicorn takes the right-most
        address that is not a proxy, the one the proxy appended; what the visitor wrote
        to the left of it does not change its count."""
        client = self.proxied()
        visitor = "198.51.100.7"
        for _ in range(MAX_FAILURES):
            assert_error(login(client, OTHER_CODE, **{"x-forwarded-for": visitor}), 403, "bad_access_code")
        assert_error(login(client, OTHER_CODE, **{"x-forwarded-for": visitor}), 429, "too_many_attempts")
        # The same visitor with made-up addresses in front of its own, or behind a second
        # proxy hop: still the same count.
        for i in range(1, 31):
            assert_error(login(client, OTHER_CODE, **{"x-forwarded-for": f"192.0.2.{i}, {visitor}"}), 429, "too_many_attempts")
        assert_error(login(client, OTHER_CODE, **{"x-forwarded-for": f"10.9.9.9, {visitor}, 172.16.0.3"}), 429, "too_many_attempts")
        assert_error(login(client, **{"x-forwarded-for": f"{visitor}, 10.0.0.7"}), 429, "too_many_attempts")
        # Another visitor has a count of its own, also when it claims the first one's address.
        assert_error(login(client, OTHER_CODE, **{"x-forwarded-for": f"{visitor}, 203.0.113.9"}), 403, "bad_access_code")
        assert login(client, **{"x-forwarded-for": "203.0.113.9"}).status_code == 204

    def test_nobody_can_lock_out_another_visitor(self) -> None:
        """SEC-2: ten wrong codes sent with the friend's address written in X-Forwarded-For
        count against the sender, not the friend."""
        client = self.proxied()
        friend = "198.51.100.50"
        for _ in range(MAX_FAILURES + 2):
            login(client, OTHER_CODE, **{"x-forwarded-for": f"{friend}, 203.0.113.66"})
        assert_error(login(client, OTHER_CODE, **{"x-forwarded-for": "203.0.113.66"}), 429, "too_many_attempts")
        assert login(client, **{"x-forwarded-for": friend}).status_code == 204

    def test_ipv6_clients_are_counted_per_64(self) -> None:
        """SEC-2: other spellings of an address, and the other addresses of its /64, share
        its count; an IPv4-mapped address is the IPv4 address."""
        client = self.proxied()
        for _ in range(MAX_FAILURES):
            assert_error(login(client, OTHER_CODE, **{"x-forwarded-for": "2001:db8::9"}), 403, "bad_access_code")
        for same in ("2001:DB8::9", "2001:db8:0::9", "2001:db8::a", "2001:db8:0:0:ffff::1", "[2001:db8::9]"):
            assert_error(login(client, OTHER_CODE, **{"x-forwarded-for": same}), 429, "too_many_attempts")
        assert_error(login(client, OTHER_CODE, **{"x-forwarded-for": "2001:db8:0:1::9"}), 403, "bad_access_code")
        for _ in range(MAX_FAILURES):
            login(client, OTHER_CODE, **{"x-forwarded-for": "203.0.113.20"})
        assert_error(login(client, **{"x-forwarded-for": "::ffff:203.0.113.20"}), 429, "too_many_attempts")

    def test_keys_stay_small_whatever_the_header(self) -> None:
        """SEC-5: the limiter keeps a short key, never the raw X-Forwarded-For text. Even
        with every forwarded address trusted ('*', the left-most entry), 10,000 distinct
        10 KB values hold one key."""
        client = self.proxied(trusted="*")
        limiter = self.app.state.access_gate.limiter
        for i in range(300):
            login(client, OTHER_CODE, **{"x-forwarded-for": f"{'x' * 10_000}{i}"})
        assert len(limiter) == 1 and all(len(k) <= MAX_CLIENT_KEY_CHARS for k in limiter._failures)
        # The limiter itself, with the keys client_key gives for 10,000 distinct long values.
        mem = FailureLimiter(clock=Clock())
        for i in range(10_000):
            mem.record_failure(client_key(f"{i:x}" + "a" * 10_000))
        assert list(mem._failures) == ["other"]
        for i in range(10_000):
            mem.record_failure(client_key(f"2001:db8:{i // 65536:x}:{i % 65536:x}::1"))
        assert len(mem) == 10_000 and max(len(k) for k in mem._failures) <= MAX_CLIENT_KEY_CHARS

    def test_cross_origin_still_refused_behind_the_proxy(self) -> None:
        client = self.proxied()
        r = login(client, **{"origin": "https://evil.example", "x-forwarded-proto": "https"})
        assert_error(r, 403, "bad_origin")

    def test_private_client_address_is_reported_once(self, caplog: pytest.LogCaptureFixture) -> None:
        """When the proxy's X-Forwarded-For is not taken (its address is not trusted),
        every visitor has the proxy's own private address: the log says so, once, and
        names no address."""
        logger = logging.getLogger("mommy")
        logger.addHandler(caplog.handler)
        try:
            with caplog.at_level(logging.INFO):
                client = self.proxied(trusted="192.0.2.1")  # not the proxy
                for _ in range(3):
                    login(client, OTHER_CODE, **{"x-forwarded-for": "8.8.4.4"})
                public = self.proxied()
                login(public, OTHER_CODE, **{"x-forwarded-for": "8.8.4.4"})
        finally:
            logger.removeHandler(caplog.handler)
        warnings = list({id(r): r for r in caplog.records if "private or unknown client address" in r.getMessage()}.values())
        assert len(warnings) == 1 and warnings[0].levelno == logging.WARNING
        assert not any(addr in caplog.text for addr in ("10.20.30.40", "8.8.4.4"))


class TestClientKey:
    @pytest.mark.parametrize(
        ("host", "key"),
        [
            ("203.0.113.7", "203.0.113.7"),
            (" 203.0.113.7 ", "203.0.113.7"),
            ("::ffff:203.0.113.7", "203.0.113.7"),
            ("2001:DB8::9", "2001:db8::/64"),
            ("[2001:db8:0:0:1::9]", "2001:db8::/64"),
            ("fe80::1%eth0", "fe80::/64"),
            ("ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ffff:ffff:ffff:ffff::/64"),
            ("testclient", "other"),
            ("203.0.113.7:443", "other"),
            ("x" * 15_000, "other"),
            ("", "unknown"),
            (None, "unknown"),
        ],
    )
    def test_keys(self, host: str | None, key: str) -> None:
        assert client_key(host) == key
        assert len(client_key(host)) <= MAX_CLIENT_KEY_CHARS

    def test_public(self) -> None:
        assert is_public_client("8.8.4.4") and is_public_client("2a00:1450:4001:80b::/64")
        for key in ("10.1.2.3", "192.168.1.1", "100.64.0.1", "127.0.0.1", "fd00::/64", "other", "unknown"):
            assert not is_public_client(key), key


class TestCookieHeaders:
    def test_split_cookie_headers(self) -> None:
        """SEC-8: an HTTP/2 client may send its cookies in several Cookie fields."""
        client = client_for(make_app())
        good = cookie_value(CODE, LOCAL)
        r = client.get("/api/health", headers=[("cookie", "a=1"), ("cookie", f"{ACCESS_COOKIE}={good}")])
        assert r.status_code == 200
        r = client.get("/api/health", headers=[("cookie", f"{ACCESS_COOKIE}={good}"), ("cookie", "b=2")])
        assert r.status_code == 200

    def test_a_cookie_of_the_same_name_does_not_hide_the_right_one(self) -> None:
        client = client_for(make_app())
        good = cookie_value(CODE, LOCAL)
        for header in (f"{ACCESS_COOKIE}={good}; {ACCESS_COOKIE}=AAAA", f"{ACCESS_COOKIE}=AAAA; {ACCESS_COOKIE}={good}"):
            assert client.get("/api/health", headers={"cookie": header}).status_code == 200, header
        r = client.get("/api/health", headers=[("cookie", f"{ACCESS_COOKIE}=AAAA"), ("cookie", f"{ACCESS_COOKIE}={good}")])
        assert r.status_code == 200
        # Only wrong values: still refused.
        assert_access_required(client.get("/api/health", headers=[("cookie", f"{ACCESS_COOKIE}=AAAA"), ("cookie", f"{ACCESS_COOKIE}={good[:-1]}")]))

    def test_values(self) -> None:
        from starlette.datastructures import Headers

        headers = Headers(raw=[(b"cookie", b'a=1; mommy_access="x"; mommy_access = y ;mommy_access='), (b"cookie", b"mommy_access=z; mommy_access2=w")])
        assert access_cookie_values(headers) == ["x", "y", "z"]


# ---------------------------------------------------------------------------
# Preloading the models online (OPS-7)
# ---------------------------------------------------------------------------


class PreloadingTranscriber(FakeTranscriber):
    def __init__(self, fail: str | None = None) -> None:
        super().__init__("hello")
        self.loaded: list[tuple[str, ...]] = []
        self.model = "fake"
        self.fail = fail

    def preload(self, langs: tuple[str, ...]) -> None:
        if self.fail in langs:
            raise RuntimeError("secret detail that must not be logged")
        self.loaded.append(langs)


class PreloadingTTS(FakeTTS):
    def __init__(self) -> None:
        super().__init__()
        self.loaded: list[tuple[str, ...]] = []

    def preload(self, langs: tuple[str, ...]) -> None:
        self.loaded.append(langs)


def fake_default_components(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """Make build_default_app() use fakes; returns the list of preload threads started."""
    monkeypatch.setattr(app_mod.SherpaWhisper, "from_settings", classmethod(lambda cls, settings: PreloadingTranscriber()))
    monkeypatch.setattr(app_mod.PiperTTS, "from_settings", classmethod(lambda cls, settings: PreloadingTTS()))
    monkeypatch.setattr(app_mod, "Quran", lambda directory: None)
    started: list[Any] = []
    real = app_mod.start_preload

    def recording(transcriber: Any, tts: Any) -> Any:
        thread = real(transcriber, tts)
        started.append((thread, transcriber, tts))
        return thread

    monkeypatch.setattr(app_mod, "start_preload", recording)
    return started


class TestPreload:
    def test_one_language_at_a_time(self, caplog: pytest.LogCaptureFixture) -> None:
        transcriber, tts = PreloadingTranscriber(fail="en"), PreloadingTTS()
        logger = logging.getLogger("mommy")
        logger.addHandler(caplog.handler)
        try:
            with caplog.at_level(logging.INFO):
                start_preload(transcriber, tts).join(10)
        finally:
            logger.removeHandler(caplog.handler)
        assert transcriber.loaded == [("ar",), ("fr",)]
        assert tts.loaded == [("ar",), ("en",), ("fr",)]
        assert "preloading the en recogniser failed (RuntimeError)" in caplog.text
        assert "secret detail" not in caplog.text
        assert "preloaded the recognisers and voices" in caplog.text

    def test_components_without_preload_are_skipped(self) -> None:
        start_preload(FakeTranscriber("x"), FakeTTS()).join(10)
        unavailable = PreloadingTranscriber()
        unavailable.available = False
        start_preload(unavailable, PreloadingTTS()).join(10)
        assert unavailable.loaded == []

    def test_online_app_preloads(self, monkeypatch: pytest.MonkeyPatch, restore_mommy_logger: None) -> None:
        monkeypatch.setenv("MOMMY_ACCESS_CODE", CODE)
        started = fake_default_components(monkeypatch)
        app = app_mod.build_default_app()
        assert app.state.access_gate is not None
        [(thread, transcriber, tts)] = started
        thread.join(10)
        assert transcriber.loaded == [("ar",), ("en",), ("fr",)] and tts.loaded == [("ar",), ("en",), ("fr",)]


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
    secrets = [CODE, "k٧m٢p٩q٤r٨s٣", OTHER_CODE, cookie_value(CODE, LOCAL), cookie_value(OTHER_CODE, LOCAL)]
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
            client.get("/api/health", headers={"cookie": f"{ACCESS_COOKIE}={cookie_value(OTHER_CODE, LOCAL)}"})
            for _ in range(MAX_FAILURES + 1):
                login(client, OTHER_CODE)
            login(client, "k٧m٢p٩q٤r٨s٣")
            app.state.access_gate.limiter.clear(client_key("testclient"))
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

"""Self-hosting with a Cloudflare quick tunnel (``compose.yaml``): suffix entries of
``MOMMY_ALLOWED_HOSTS`` (:class:`mommy.access.HostMatcher`), the access code file
(``MOMMY_ACCESS_CODE_FILE``) and ``python -m mommy.share_link``.

Nothing here reaches the network: ``share_link`` is run against a fake cloudflared
metrics server on 127.0.0.1 that answers as cloudflared 2026.10.7 does
(``GET /quicktunnel`` -> ``{"hostname":"<name>.trycloudflare.com"}`` as ``text/plain``,
``GET /ready`` -> 200 once connected, 503 before).
"""

from __future__ import annotations

import datetime
import errno
import io
import json
import logging
import multiprocessing
import os
import socket
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from mommy import access as access_mod
from mommy import share_link as share_mod
from mommy.access import (
    CODE_ALPHABET,
    CODE_FILE_MAX_BYTES,
    CODE_LENGTH,
    MAX_FAILURES,
    HostMatcher,
    cookie_value,
    create_code_file,
    generate_code,
    host_entry,
    read_code_file,
    replace_code_file,
    split_host,
)
from mommy.app import HostOriginMiddleware, RequestGuardMiddleware, ResponseHeadersMiddleware, create_app
from mommy.asr import FakeTranscriber
from mommy.config import DEFAULT_ALLOWED_HOSTS, Settings, code_from_file, load_settings, parse_allowed_hosts
from mommy.llm import OfflineBrain
from mommy.share_link import REMINDER, RESTART_COMMAND, main, parse_hostname, wait_for_tunnel
from mommy.tts import FakeTTS

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
CODE = "k7m2p9q4r8s3"
OTHER_CODE = "x4h8n2w6t9b3"
TUNNEL_HOST = "fancy-words-here-test.trycloudflare.com"
#: The answer of cloudflared 2026.10.7's /quicktunnel, byte for byte (captured from the
#: real binary, started against a fake quick-tunnel service).
CLOUDFLARED_ANSWER = b'{"hostname":"fancy-words-here-test.trycloudflare.com"}'
#: compose.yaml's host list.
COMPOSE_HOSTS = "localhost,127.0.0.1,.trycloudflare.com"
NAV = {"accept": "text/html,application/xhtml+xml,*/*;q=0.8", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document"}
GATE_PAGE_BYTES = (WEB / "access.html").read_bytes()
#: Every variable this file is about; a test starts without any of them.
ENV_VARS = (
    "MOMMY_ALLOWED_HOSTS",
    "MOMMY_ACCESS_CODE",
    "MOMMY_ACCESS_CODE_FILE",
    "MOMMY_REQUIRE_ACCESS_CODE",
    "MOMMY_TUNNEL_METRICS_URL",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


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


def make_app(settings: Settings) -> Any:
    return create_app(settings, FakeTranscriber("hello"), FakeTTS(), OfflineBrain(), None)


def assert_error(response: Any, status: int, code: str) -> None:
    assert response.status_code == status, (response.status_code, response.text)
    assert response.json()["error"] == code


def mode_of(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


# ---------------------------------------------------------------------------
# Suffix entries: the matcher
# ---------------------------------------------------------------------------


class TestSuffixMatcher:
    MATCHER = HostMatcher(["localhost", "127.0.0.1", ".trycloudflare.com"])

    @pytest.mark.parametrize(
        "host",
        [
            "abc.trycloudflare.com",
            TUNNEL_HOST,
            "a.b.trycloudflare.com",
            "123.trycloudflare.com",
            "a-1.trycloudflare.com",
            "xn--80ak6aa92e.trycloudflare.com",  # an IDNA (punycode) label is an ordinary label
            "ABC.TryCloudflare.COM",  # case
            "abc.trycloudflare.com:443",  # a default port, spelled out
            "abc.trycloudflare.com:80",
            "abc.trycloudflare.com.",  # trailing dot
            "abc.trycloudflare.com.:443",
            " abc.trycloudflare.com ",
            "a" * 63 + ".trycloudflare.com",  # the longest label
        ],
    )
    def test_names_under_the_suffix_match(self, host: str) -> None:
        assert self.MATCHER.allows_host(host), host

    @pytest.mark.parametrize(
        "host",
        [
            "trycloudflare.com",  # the bare domain
            "trycloudflare.com.",
            "TRYCLOUDFLARE.COM:443",
            ".trycloudflare.com",  # no label before the suffix
            "evil-trycloudflare.com",  # a longer label, not a sub-domain
            "eviltrycloudflare.com",
            "trycloudflare.com.evil.com",  # contains the suffix, ends elsewhere
            "abc.trycloudflare.com.evil.com",
            "abc.trycloudflare.co",
            "abc.trycloudflare.comx",
            "abc.trycloudflare.com..",  # two trailing dots: an empty label
            "a..trycloudflare.com",  # an empty label
            "-abc.trycloudflare.com",  # a hyphen at a label's edge
            "abc-.trycloudflare.com",
            "abc_x.trycloudflare.com",  # not a host name character
            "abc%2etrycloudflare.com",
            "abc trycloudflare.com",
            "abc.trycloudflare.com/x",
            "abc\\.trycloudflare.com",
            "a" * 64 + ".trycloudflare.com",  # a label of 64 characters
            ".".join(["a"] * 120) + ".trycloudflare.com",  # longer than 253 characters
            # IDNA and Unicode tricks: a browser sends the ASCII (xn--) form, so any other
            # character is refused, also when Unicode case folding would make it ASCII.
            "abc.trycloudflаre.com",  # a Cyrillic a
            "abc．trycloudflare.com",  # a fullwidth full stop
            "abc。trycloudflare.com",  # an ideographic full stop
            "abc｡trycloudflare.com",  # a halfwidth ideographic full stop
            "abc.trycloudflare.com​",  # a zero-width space
            "abc.trycloudflare.com\x00",
            "K.trycloudflare.com",  # the Kelvin sign, which lower() turns into "k"
            "",
            "localhost.trycloudflare",
            # Another port: a tunnel's requests never name one, a DNS-rebinding page under
            # the suffix pointed at 127.0.0.1 names the local port (SEC-6).
            "abc.trycloudflare.com:8080",
            "abc.trycloudflare.com.:8080",
            "abc.trycloudflare.com:7860",
            "abc.trycloudflare.com:",
            "abc.trycloudflare.com:0443",
            "abc.trycloudflare.com:/@evil.example",
        ],
    )
    def test_other_names_do_not_match(self, host: str) -> None:
        assert not self.MATCHER.allows_host(host), host

    def test_only_suffix_names_are_tied_to_the_default_ports(self) -> None:
        """Exact entries ignore the port as before; allows_name (no port) is unchanged."""
        assert self.MATCHER.allows_name("abc.trycloudflare.com")
        assert self.MATCHER.allows_host("localhost:8080") and self.MATCHER.allows_host("127.0.0.1:1234")
        matcher = HostMatcher(["abc.trycloudflare.com", ".trycloudflare.com"])
        assert matcher.allows_host("abc.trycloudflare.com:8080")  # the exact entry
        assert not matcher.allows_host("xyz.trycloudflare.com:8080")
        assert not matcher.matches_suffix("abc.trycloudflare.com") and matcher.matches_suffix("xyz.trycloudflare.com")
        assert not matcher.matches_suffix("xyz.trycloudflare.com:8080")

    def test_unicode_case_folding_cannot_forge_a_name(self) -> None:
        matcher = HostMatcher([".kids.example.org", "kids.example.net"])
        assert "a.Kids.example.org".lower() == "a.kids.example.org"  # what a lax check would see
        assert matcher.allows_host("a.kids.example.org") and matcher.allows_host("A.KIDS.EXAMPLE.ORG")
        assert not matcher.allows_host("a.Kids.example.org")
        assert matcher.allows_host("kids.example.net")
        assert not matcher.allows_host("Kids.example.net")  # exact entries too

    def test_suffix_entries_do_not_widen_the_exact_ones(self) -> None:
        for host in ("x.localhost", "x.127.0.0.1", "localhost.", "127.0.0.2"):
            assert not self.MATCHER.allows_host(host), host
        for host in ("localhost", "localhost:8080", "LOCALHOST", "127.0.0.1:8080"):
            assert self.MATCHER.allows_host(host), host

    def test_several_suffixes(self) -> None:
        matcher = HostMatcher([".trycloudflare.com", ".example.org", ".trycloudflare.com"])
        assert matcher.suffixes == (".trycloudflare.com", ".example.org")
        assert matcher.allows_host("a.example.org") and matcher.allows_host("a.trycloudflare.com")
        assert not matcher.allows_host("example.org") and not matcher.allows_host("a.example.com")

    @pytest.mark.parametrize(
        "entry,normalized",
        [
            (".trycloudflare.com", ".trycloudflare.com"),
            (" .TryCloudflare.COM. ", ".trycloudflare.com"),
            (".xn--80ak6aa92e.com", ".xn--80ak6aa92e.com"),
            (".a.b.example", ".a.b.example"),
            ("LocalHost", "localhost"),  # exact entries as before
            (" [::1] ", "::1"),
            ("127.0.0.1", "127.0.0.1"),
        ],
    )
    def test_entries_are_normalized(self, entry: str, normalized: str) -> None:
        assert host_entry(entry) == normalized

    @pytest.mark.parametrize(
        "entry,reason",
        [
            (".com", "too broad"),
            (".COM.", "too broad"),
            (".", "too broad"),
            ("..", "too broad"),
            (". ", "too broad"),
            (".co.uk", "too broad"),  # a public second level: anyone can register under it
            (".com.au", "too broad"),
            (".a..b", "not a host name"),
            (".-a.example", "not a host name"),
            (".a_b.example", "not a host name"),
            (".0.1", "ends in a number"),
            (".1.2.3.4", "ends in a number"),
            ("*.trycloudflare.com", "wildcards"),
            ("*", "wildcards"),
            (".trycloudflаre.com", "not ASCII"),
            (".Kids.example", "not ASCII"),
        ],
    )
    def test_broad_or_wrong_suffixes_are_refused(self, entry: str, reason: str) -> None:
        with pytest.raises(ValueError, match=reason):
            host_entry(entry)
        with pytest.raises(ValueError, match=reason):
            HostMatcher(["localhost", entry])

    def test_split_host(self) -> None:
        assert split_host("abc.trycloudflare.com:443") == ("abc.trycloudflare.com", "443")
        assert split_host("[::1]:8080") == ("::1", "8080")
        assert split_host("::1") == ("::1", None)
        assert split_host(" Example.org ") == ("Example.org", None)


class TestOrigin:
    MATCHER = HostMatcher(["localhost", "127.0.0.1", "::1", ".trycloudflare.com"])
    HOST = "abc.trycloudflare.com"

    @pytest.mark.parametrize(
        "origin,host",
        [
            ("https://abc.trycloudflare.com", HOST),
            ("http://abc.trycloudflare.com", HOST),
            ("HTTPS://ABC.TRYCLOUDFLARE.COM", HOST),
            ("https://abc.trycloudflare.com", "ABC.trycloudflare.com"),
            ("https://abc.trycloudflare.com.", HOST),  # a trailing dot on either side
            ("https://abc.trycloudflare.com", HOST + "."),
            ("https://abc.trycloudflare.com:443", HOST + ":443"),
            ("http://localhost:8080", "localhost:8080"),
            ("http://127.0.0.1:8080", "127.0.0.1:8080"),
            ("http://[::1]:8080", "[::1]:8080"),
        ],
    )
    def test_same_origin(self, origin: str, host: str) -> None:
        assert self.MATCHER.same_origin(origin, host)

    @pytest.mark.parametrize(
        "origin,host",
        [
            ("https://evil.trycloudflare.com", HOST),  # someone else's tunnel is another site
            ("https://trycloudflare.com", HOST),
            ("https://abc.trycloudflare.com.evil.com", HOST),
            ("https://evil-trycloudflare.com", HOST),
            ("https://abc.trycloudflare.com:8443", HOST),  # another port
            ("https://abc.trycloudflare.com", HOST + ":8443"),
            ("https://abc.trycloudflare.com:8443", HOST + ":8443"),  # a suffix name on another port
            ("https://abc.trycloudflare.com/", HOST),  # an origin has no path
            ("https://abc.trycloudflare.com/x", HOST),
            ("https://user@abc.trycloudflare.com", HOST),
            ("https://abc.trycloudflаre.com", HOST),
            ("https://abc．trycloudflare.com", HOST),
            ("ftp://abc.trycloudflare.com", HOST),
            ("abc.trycloudflare.com", HOST),
            ("null", HOST),
            ("", HOST),
            ("http://localhost:8080", "127.0.0.1:8080"),
            ("http://localhost:3000", "localhost:8080"),
            ("http://localhost", "localhost:8080"),
            ("http://localhost:8080", "[localhost]:8080"),
        ],
    )
    def test_not_same_origin(self, origin: str, host: str) -> None:
        assert not self.MATCHER.same_origin(origin, host)
        assert not self.MATCHER.same_origin(origin, host, https_only=True)

    def test_https_only(self) -> None:
        """SEC-5: with the gate on, a page loaded over plain http may post only on a
        loopback host (the local port); online every page is https."""
        assert self.MATCHER.same_origin("https://abc.trycloudflare.com", self.HOST, https_only=True)
        assert not self.MATCHER.same_origin("http://abc.trycloudflare.com", self.HOST, https_only=True)
        assert self.MATCHER.same_origin("http://abc.trycloudflare.com", self.HOST)  # the default: as before
        for origin, host in (("http://localhost:8080", "localhost:8080"), ("http://127.0.0.1:8080", "127.0.0.1:8080"),
                             ("http://[::1]:8080", "[::1]:8080")):
            assert self.MATCHER.same_origin(origin, host, https_only=True), origin
        exact = HostMatcher(["someone-mommy.hf.space"])
        assert exact.same_origin("https://someone-mommy.hf.space", "someone-mommy.hf.space", https_only=True)
        assert not exact.same_origin("http://someone-mommy.hf.space", "someone-mommy.hf.space", https_only=True)


# ---------------------------------------------------------------------------
# Suffix entries: the settings and the app
# ---------------------------------------------------------------------------


class TestSuffixSettings:
    def test_compose_host_list(self, clean_env: pytest.MonkeyPatch) -> None:
        clean_env.setenv("MOMMY_ALLOWED_HOSTS", COMPOSE_HOSTS)
        assert load_settings().allowed_hosts == ("localhost", "127.0.0.1", ".trycloudflare.com")
        clean_env.setenv("MOMMY_ALLOWED_HOSTS", " LocalHost , .TryCloudflare.com., .trycloudflare.com ,,")
        assert load_settings().allowed_hosts == ("localhost", ".trycloudflare.com")

    @pytest.mark.parametrize("value", ["localhost,.com", ".", "localhost, .co.uk", "*.trycloudflare.com", ". com"])
    def test_broad_suffix_stops_the_start(self, clean_env: pytest.MonkeyPatch, value: str) -> None:
        clean_env.setenv("MOMMY_ALLOWED_HOSTS", value)
        with pytest.raises(ValueError, match="MOMMY_ALLOWED_HOSTS"):
            load_settings()

    def test_parse_allowed_hosts(self) -> None:
        assert parse_allowed_hosts("a.example, .b.example") == ("a.example", ".b.example")
        with pytest.raises(ValueError, match="at least one host"):
            parse_allowed_hosts(" , ")

    def test_settings_given_directly_are_checked_too(self) -> None:
        """Settings built in code (tests) are not parsed by load_settings: the middleware
        refuses the entry when the app is first called (uvicorn: at its startup)."""
        app = make_app(make_settings(allowed_hosts=("localhost", ".com")))
        with pytest.raises(ValueError, match="too broad"):
            TestClient(app, base_url="http://localhost").get("/api/health")


class TestSuffixThroughTheApp:
    """The app as compose.yaml runs it: the gate on, MOMMY_ALLOWED_HOSTS with
    .trycloudflare.com, behind cloudflared (uvicorn --proxy-headers, cloudflared on a
    private compose network)."""

    HOSTS = ("localhost", "127.0.0.1", ".trycloudflare.com")
    #: cloudflared's address on the compose network, and the image's trusted networks.
    PROXY = ("172.18.0.3", 41000)
    TRUSTED = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

    def app(self) -> Any:
        return make_app(make_settings(allowed_hosts=self.HOSTS, access_code=CODE))

    def tunnel_client(self, host: str = TUNNEL_HOST) -> TestClient:
        return TestClient(
            ProxyHeadersMiddleware(self.app(), trusted_hosts=self.TRUSTED), base_url=f"http://{host}", client=self.PROXY
        )

    def test_a_tunnel_name_reaches_the_gate(self) -> None:
        client = self.tunnel_client()
        r = client.get("/", headers=NAV)
        assert r.status_code == 200 and r.content == GATE_PAGE_BYTES
        assert_error(client.get("/api/health"), 401, "access_required")

    @pytest.mark.parametrize(
        "host", ["trycloudflare.com", "evil-trycloudflare.com", "trycloudflare.com.evil.com", "abc.trycloudflаre.com"]
    )
    def test_other_names_get_bad_host(self, host: str) -> None:
        client = self.tunnel_client()
        raw = host.encode("utf-8")  # as a raw client would send a non-ASCII name
        assert_error(client.get("/", headers={**NAV, "host": raw}), 400, "bad_host")
        assert_error(client.post("/api/access", json={"code": CODE}, headers={"host": raw}), 400, "bad_host")

    def test_code_through_the_tunnel(self) -> None:
        client = self.tunnel_client()
        headers = {"origin": f"https://{TUNNEL_HOST}", "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https"}
        r = client.post("/api/access", json={"code": CODE}, headers=headers)
        assert r.status_code == 204
        cookie = r.headers["set-cookie"]
        assert cookie.startswith(f"mommy_access={cookie_value(CODE, TUNNEL_HOST)};") and "Secure" in cookie
        assert r.headers["strict-transport-security"]
        # The browser sends the (Secure) cookie back over https.
        tag = cookie_value(CODE, TUNNEL_HOST)
        assert client.get("/api/health", headers={"cookie": f"mommy_access={tag}"}).status_code == 200
        # A cookie given for localhost (which every local port receives) opens no tunnel (SEC-4).
        local = cookie_value(CODE, "localhost")
        assert_error(client.get("/api/health", headers={"cookie": f"mommy_access={local}"}), 401, "access_required")

    def test_plain_http_through_the_tunnel_is_sent_to_https(self) -> None:
        """SEC-5: a visit the tunnel received over http never shows the code page there:
        a navigation goes to the same URL in https, anything else gets https_required."""
        client = self.tunnel_client()
        http = {"x-forwarded-proto": "http", "x-forwarded-for": "203.0.113.7"}
        r = client.get("/some/page?x=1&y=%2F", headers={**NAV, **http}, follow_redirects=False)
        assert r.status_code == 308 and r.headers["location"] == f"https://{TUNNEL_HOST}/some/page?x=1&y=%2F"
        assert r.headers["cache-control"] == "no-store"
        r = client.get("/", headers={**NAV, **http, "host": "Fancy-Words-Here-Test.TryCloudflare.com.:80"},
                       follow_redirects=False)
        assert r.status_code == 308 and r.headers["location"] == f"https://{TUNNEL_HOST}/"
        r = client.post("/api/access", json={"code": CODE}, headers={**http, "origin": f"http://{TUNNEL_HOST}"})
        assert_error(r, 400, "https_required")
        assert "set-cookie" not in r.headers
        assert_error(client.get("/api/health", headers=http), 400, "https_required")
        # A page loaded over http (no header): its Origin is refused as another site.
        r = client.post("/api/access", json={"code": CODE}, headers={"origin": f"http://{TUNNEL_HOST}"})
        assert_error(r, 403, "bad_origin")
        # https, or no header (the default of a direct client): served.
        for headers in ({"x-forwarded-proto": "https"}, {}):
            assert client.get("/", headers={**NAV, **headers}, follow_redirects=False).status_code == 200
        # The local port and exact entries are not touched by the header.
        local = TestClient(ProxyHeadersMiddleware(self.app(), trusted_hosts=self.TRUSTED),
                           base_url="http://localhost:8080", client=("172.18.0.1", 50000))
        assert local.get("/", headers={**NAV, **http}, follow_redirects=False).status_code == 200
        r = local.post("/api/access", json={"code": CODE}, headers={**http, "origin": "http://localhost:8080"})
        assert r.status_code == 204

    def test_a_rebinding_page_on_the_local_port_gets_bad_host(self) -> None:
        """SEC-6: a page under .trycloudflare.com whose name a hostile resolver points at
        127.0.0.1 sends Host: <name>:8080 to the local port: refused before the gate."""
        local = TestClient(self.app(), base_url="http://localhost:8080", client=("172.18.0.1", 50000))
        rebound = "attacker-words.trycloudflare.com:8080"
        headers = {"host": rebound, "origin": f"http://{rebound}"}
        assert_error(local.post("/api/access", json={"code": OTHER_CODE}, headers=headers), 400, "bad_host")
        assert_error(local.get("/", headers={**NAV, "host": rebound}), 400, "bad_host")

    @pytest.mark.parametrize(
        "origin",
        [
            "https://evil.trycloudflare.com",
            "https://trycloudflare.com",
            f"https://{TUNNEL_HOST}.evil.com",
            f"https://{TUNNEL_HOST}:8443",
            "null",
        ],
    )
    def test_another_origin_cannot_post(self, origin: str) -> None:
        client = self.tunnel_client()
        r = client.post("/api/access", json={"code": CODE}, headers={"origin": origin, "x-forwarded-proto": "https"})
        assert_error(r, 403, "bad_origin")
        assert "set-cookie" not in r.headers

    def test_wrong_codes_count_per_visitor(self) -> None:
        client = self.tunnel_client()
        for _ in range(MAX_FAILURES):
            r = client.post("/api/access", json={"code": OTHER_CODE}, headers={"x-forwarded-for": "198.51.100.7"})
            assert_error(r, 403, "bad_access_code")
        r = client.post("/api/access", json={"code": OTHER_CODE}, headers={"x-forwarded-for": "198.51.100.7"})
        assert_error(r, 429, "too_many_attempts")
        r = client.post("/api/access", json={"code": CODE}, headers={"x-forwarded-for": "203.0.113.9"})
        assert r.status_code == 204

    def test_localhost_port_goes_through_the_gate_too(self) -> None:
        """http://localhost:8080 (compose's port on 127.0.0.1): no exemption for local
        requests; the same code opens it, with a cookie that is not Secure over http."""
        # Docker's port mapping: the peer is the compose network's gateway.
        client = TestClient(
            ProxyHeadersMiddleware(self.app(), trusted_hosts=self.TRUSTED),
            base_url="http://localhost:8080",
            client=("172.18.0.1", 50000),
        )
        assert client.get("/", headers=NAV).content == GATE_PAGE_BYTES
        assert_error(client.get("/api/health"), 401, "access_required")
        r = client.post("/api/access", json={"code": CODE}, headers={"origin": "http://localhost:8080"})
        assert r.status_code == 204 and "Secure" not in r.headers["set-cookie"]
        assert "strict-transport-security" not in r.headers
        assert client.get("/api/health").status_code == 200


# ---------------------------------------------------------------------------
# The default behaviour does not change
# ---------------------------------------------------------------------------


def _old_host_name(host: str) -> str:
    """The host check before suffix entries (app._host_name at the time)."""
    host = host.strip().lower()
    if host.startswith("["):
        return host[1 : host.find("]")] if "]" in host else host[1:]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def _old_decision(allowed: tuple[str, ...], host: str, origin: str | None) -> str:
    """What HostOriginMiddleware answered before suffix entries, for a POST /api/*."""
    if _old_host_name(host) not in frozenset(h.lower() for h in allowed):
        return "bad_host"
    if origin is not None and origin.strip().lower() not in (
        f"http://{host.strip().lower()}",
        f"https://{host.strip().lower()}",
    ):
        return "bad_origin"
    return "ok"


def _new_decision(allowed: tuple[str, ...], host: str, origin: str | None) -> str:
    matcher = HostMatcher(allowed)
    if not matcher.allows_host(host):
        return "bad_host"
    if origin is not None and not matcher.same_origin(origin, host):
        return "bad_origin"
    return "ok"


HOST_CORPUS = [
    "127.0.0.1", "127.0.0.1:8080", "localhost", "localhost:8080", "LOCALHOST:8080", " localhost ", "[::1]",
    "[::1]:8080", "::1", "[::1", "[::1]x", "localhost.", "localhost.:8080", "127.0.0.2", "0.0.0.0", "evil.example",
    "localhost.evil.example", "x.localhost", "", ":8080", "localhost:abc", "localhost:8080:1", "127.0.0.1:8080:9",
    "tutor.local", "tutor.local:8080", "Tutor.Local", "tutor.local.", "someone-mommy.hf.space",
    "other-mommy.hf.space", "a\nb", "locałhost", "localhost​", "[localhost]:8080",
]
ORIGIN_CORPUS = [
    None, "http://127.0.0.1:8080", "http://localhost:8080", "HTTP://LOCALHOST:8080", "https://localhost:8080",
    "http://localhost:8080/", "http://localhost", "http://localhost:3000", "http://[::1]:8080", "null", "",
    "http://evil.example", "https://someone-mommy.hf.space", "http://tutor.local:8080", "http://localhost.:8080",
    "http://localhost:8080 ", "ftp://localhost:8080", "http://user@localhost:8080", "http://localhost:08080",
]


@pytest.mark.parametrize(
    "allowed",
    [DEFAULT_ALLOWED_HOSTS, ("tutor.local",), ("someone-mommy.hf.space",), ("localhost", "LOCALHOST", "::1")],
)
def test_exact_entries_decide_as_before(allowed: tuple[str, ...]) -> None:
    """Without a suffix entry, every Host and Origin of the corpus gets the same answer
    as before (the run.sh defaults, a Space's host name, a LAN name)."""
    for host in HOST_CORPUS:
        for origin in ORIGIN_CORPUS:
            assert _new_decision(allowed, host, origin) == _old_decision(allowed, host, origin), (allowed, host, origin)


def test_nothing_changes_without_the_new_variables(tmp_path: Path) -> None:
    """None of MOMMY_ALLOWED_HOSTS, MOMMY_ACCESS_CODE(_FILE), MOMMY_TUNNEL_METRICS_URL set
    (./run.sh): the defaults, no gate, no file anywhere, the same middleware."""
    settings = load_settings(tmp_path)
    assert settings.allowed_hosts == DEFAULT_ALLOWED_HOSTS
    assert settings.access_code is None and settings.access_code_file is None
    assert list(tmp_path.iterdir()) == []
    app = make_app(load_settings())
    assert [m.cls for m in app.user_middleware] == [ResponseHeadersMiddleware, HostOriginMiddleware, RequestGuardMiddleware]
    assert app.state.access_gate is None
    client = TestClient(app, base_url="http://127.0.0.1:8080")
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/health", headers={"host": "localhost:8080"}).status_code == 200
    assert client.get("/api/health", headers={"host": "[::1]:8080"}).status_code == 200
    for host in ("x.trycloudflare.com", "trycloudflare.com", "localhost.", "evil.example"):
        assert_error(client.get("/api/health", headers={"host": host}), 400, "bad_host")
    r = client.post("/api/tts", json={"text": "Hello", "lang": "en"}, headers={"origin": "http://127.0.0.1:8080"})
    assert r.status_code == 200
    r = client.post("/api/tts", json={"text": "Hello", "lang": "en"}, headers={"origin": "http://localhost:8080"})
    assert_error(r, 403, "bad_origin")
    assert_error(client.post("/api/access", json={"code": CODE}), 404, "not_found")


def test_default_space_start_settings_are_unchanged(clean_env: pytest.MonkeyPatch) -> None:
    """The Hugging Face image: MOMMY_ACCESS_CODE and the Space's host name; no file."""
    clean_env.setenv("MOMMY_REQUIRE_ACCESS_CODE", "1")
    clean_env.setenv("MOMMY_ACCESS_CODE", CODE)
    clean_env.setenv("MOMMY_ALLOWED_HOSTS", "someone-mommy.hf.space")
    settings = load_settings()
    assert settings.access_code == CODE and settings.access_code_file is None
    assert settings.allowed_hosts == ("someone-mommy.hf.space",)
    clean_env.delenv("MOMMY_ACCESS_CODE")
    with pytest.raises(ValueError, match="MOMMY_ACCESS_CODE is not set"):
        load_settings()


# ---------------------------------------------------------------------------
# The access code file
# ---------------------------------------------------------------------------


class TestCodeFile:
    @pytest.mark.parametrize("umask", [0o000, 0o022, 0o077])
    def test_created_when_missing_with_mode_0600(
        self, clean_env: pytest.MonkeyPatch, tmp_path: Path, umask: int
    ) -> None:
        path = tmp_path / "access-code"
        clean_env.setenv("MOMMY_ACCESS_CODE_FILE", str(path))
        clean_env.setenv("MOMMY_REQUIRE_ACCESS_CODE", "1")  # the image's setting
        old = os.umask(umask)
        try:
            settings = load_settings()
        finally:
            os.umask(old)
        code = settings.access_code
        assert code is not None and len(code) == CODE_LENGTH and set(code) <= set(CODE_ALPHABET)
        assert settings.access_code_file == path
        assert path.read_text("utf-8") == code + "\n"
        assert mode_of(path) == 0o600
        assert sorted(p.name for p in tmp_path.iterdir()) == ["access-code"]  # no temporary file left
        assert code not in repr(settings)
        # The gate takes it.
        app = make_app(settings)
        client = TestClient(app, base_url="http://127.0.0.1:8080")
        assert client.post("/api/access", json={"code": code}).status_code == 204

    def test_existing_file_is_reused(self, clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
        path = tmp_path / "access-code"
        path.write_text("﻿  " + CODE + "  \r\n", encoding="utf-8")  # a BOM and CRLF from an editor
        before = path.stat()
        clean_env.setenv("MOMMY_ACCESS_CODE_FILE", str(path))
        assert load_settings().access_code == CODE
        assert load_settings().access_code == CODE
        after = path.stat()
        assert (after.st_ino, after.st_mtime_ns, after.st_size) == (before.st_ino, before.st_mtime_ns, before.st_size)

    def test_made_once_then_kept(self, clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
        clean_env.setenv("MOMMY_ACCESS_CODE_FILE", str(tmp_path / "access-code"))
        first = load_settings().access_code
        assert [load_settings().access_code for _ in range(3)] == [first] * 3

    def test_env_wins(self, clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
        missing = tmp_path / "missing-code"
        clean_env.setenv("MOMMY_ACCESS_CODE_FILE", str(missing))
        clean_env.setenv("MOMMY_ACCESS_CODE", " " + CODE + " ")
        settings = load_settings()
        assert settings.access_code == CODE and settings.access_code_file is None
        assert not missing.exists()  # the file is not even made
        bad = tmp_path / "bad"
        bad.write_text("x7q", encoding="utf-8")
        clean_env.setenv("MOMMY_ACCESS_CODE_FILE", str(bad))
        assert load_settings().access_code == CODE  # nor read
        clean_env.setenv("MOMMY_ACCESS_CODE", "   ")  # blank: the file is used
        with pytest.raises(ValueError):
            load_settings()

    def test_blank_file_variable_means_unset(self, clean_env: pytest.MonkeyPatch) -> None:
        clean_env.setenv("MOMMY_ACCESS_CODE_FILE", "   ")
        settings = load_settings()
        assert settings.access_code is None and settings.access_code_file is None

    @pytest.mark.parametrize("content", [b"x7q", b"x7qz9\n", b"  \n", b""])
    def test_too_short_code_is_refused_without_quoting_it(
        self, clean_env: pytest.MonkeyPatch, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, content: bytes
    ) -> None:
        monkeypatch.setattr(access_mod, "CODE_FILE_SETTLE_S", 0.05)
        path = tmp_path / "access-code"
        path.write_bytes(content)
        clean_env.setenv("MOMMY_ACCESS_CODE_FILE", str(path))
        with pytest.raises(ValueError, match="at least 8 characters") as info:
            load_settings()
        assert str(path) in str(info.value)
        if content.strip():
            assert content.strip().decode() not in str(info.value).replace(str(path), "")
        assert path.read_bytes() == content  # never replaced behind the owner's back

    @pytest.mark.parametrize(
        "make,reason",
        [
            (lambda p: p.mkdir(), "cannot be read"),
            (lambda p: p.write_bytes(b"\xff\xfe\x00\x01 not text"), "not UTF-8"),
            (lambda p: p.write_bytes(b"k" * (CODE_FILE_MAX_BYTES + 1)), "larger than"),
            (lambda p: p.write_text(CODE + "\n" + OTHER_CODE + "\n", encoding="utf-8"), "more than one line"),
        ],
    )
    def test_unreadable_file_is_refused(
        self, clean_env: pytest.MonkeyPatch, tmp_path: Path, make: Any, reason: str
    ) -> None:
        path = tmp_path / "access-code"
        make(path)
        clean_env.setenv("MOMMY_ACCESS_CODE_FILE", str(path))
        with pytest.raises(ValueError, match=reason) as info:
            load_settings()
        assert CODE not in str(info.value) and OTHER_CODE not in str(info.value)

    @pytest.mark.skipif(not hasattr(os, "geteuid") or os.geteuid() == 0, reason="root reads any file")
    def test_file_without_permission_is_refused(self, clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
        path = tmp_path / "access-code"
        path.write_text(CODE, encoding="utf-8")
        path.chmod(0)
        clean_env.setenv("MOMMY_ACCESS_CODE_FILE", str(path))
        with pytest.raises(ValueError, match="cannot be read"):
            load_settings()

    def test_missing_directory_is_refused(self, clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
        clean_env.setenv("MOMMY_ACCESS_CODE_FILE", str(tmp_path / "no-such-dir" / "access-code"))
        with pytest.raises(ValueError, match="directory must exist and be writable"):
            load_settings()

    def test_without_create_a_missing_file_is_reported(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            code_from_file(tmp_path / "access-code", create=False)
        assert list(tmp_path.iterdir()) == []

    def test_generated_codes_come_from_secrets(self, monkeypatch: pytest.MonkeyPatch) -> None:
        codes = {generate_code() for _ in range(200)}
        assert len(codes) == 200
        assert all(len(c) == CODE_LENGTH and set(c) <= set(CODE_ALPHABET) for c in codes)
        seen: list[str] = []

        def choice(seq: str) -> str:
            seen.append(seq)
            return seq[0]

        monkeypatch.setattr(access_mod.secrets, "choice", choice)
        assert generate_code() == CODE_ALPHABET[0] * CODE_LENGTH and seen == [CODE_ALPHABET] * CODE_LENGTH

    def test_another_process_wins_the_race(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Between "the file is missing" and the link, another process made it: its code
        is the one used, and nothing of ours is left."""
        path = tmp_path / "access-code"
        real_link = os.link

        def link(src: str, dst: Any) -> None:
            Path(dst).write_text(OTHER_CODE + "\n", encoding="utf-8")
            real_link(src, dst)  # raises FileExistsError, as the real race would

        monkeypatch.setattr(access_mod.os, "link", link)
        assert create_code_file(path) is None
        assert code_from_file(path) == OTHER_CODE
        assert sorted(p.name for p in tmp_path.iterdir()) == ["access-code"]

    def test_file_system_without_hard_links(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        def no_link(src: str, dst: Any) -> None:
            raise OSError(errno.EPERM, "Operation not permitted")

        monkeypatch.setattr(access_mod.os, "link", no_link)
        path = tmp_path / "access-code"
        code = code_from_file(path)
        assert path.read_text("utf-8") == code + "\n" and mode_of(path) == 0o600
        assert sorted(p.name for p in tmp_path.iterdir()) == ["access-code"]
        assert code_from_file(path) == code
        # There too, a file made by another process first is kept.
        other = tmp_path / "other-code"
        real_open = os.open

        def racing_open(name: Any, flags: int, mode: int = 0o777) -> int:
            if Path(name) == other and flags & os.O_EXCL:
                other.write_text(OTHER_CODE + "\n", encoding="utf-8")
            return real_open(name, flags, mode)

        monkeypatch.setattr(access_mod.os, "open", racing_open)
        assert create_code_file(other) is None and code_from_file(other) == OTHER_CODE

    def test_empty_file_being_written_is_waited_for(self, tmp_path: Path) -> None:
        """Without hard links the file exists, empty, before its code is written: a reader
        waits a moment for it."""
        path = tmp_path / "access-code"
        path.write_bytes(b"")
        timer = threading.Timer(0.2, lambda: path.write_text(CODE + "\n", encoding="utf-8"))
        timer.start()
        try:
            assert read_code_file(path, settle_s=5.0) == CODE
        finally:
            timer.cancel()

    def test_replace_code_file(self, tmp_path: Path) -> None:
        path = tmp_path / "access-code"
        path.write_text(OTHER_CODE + "\n", encoding="utf-8")
        path.chmod(0o644)
        inode = path.stat().st_ino
        replace_code_file(path, CODE)
        assert path.read_text("utf-8") == CODE + "\n" and mode_of(path) == 0o600
        assert path.stat().st_ino != inode  # renamed over, not rewritten in place
        assert sorted(p.name for p in tmp_path.iterdir()) == ["access-code"]

    def test_concurrent_creation_ends_with_one_code(self, tmp_path: Path) -> None:
        """Two processes start at the same moment on a missing file, 25 times: each time
        both get the same code, the one in the file."""
        rounds = [tmp_path / f"round-{i}" for i in range(25)]
        for d in rounds:
            d.mkdir()
        ctx = multiprocessing.get_context("spawn")
        barrier = ctx.Barrier(2)
        results = ctx.Queue()
        procs = [
            ctx.Process(target=_race_worker, args=(str(ROOT / "backend"), [str(d) for d in rounds], barrier, results))
            for _ in range(2)
        ]
        for p in procs:
            p.start()
        got: dict[int, list[str]] = {}
        try:
            for _ in range(2 * len(rounds)):
                i, code = results.get(timeout=120)
                got.setdefault(i, []).append(code)
        finally:
            for p in procs:
                p.join(timeout=60)
                if p.is_alive():
                    p.kill()
        assert all(p.exitcode == 0 for p in procs)
        for i, d in enumerate(rounds):
            codes = got[i]
            assert len(codes) == 2 and codes[0] == codes[1], (i, codes)
            assert (d / "access-code").read_text("utf-8") == codes[0] + "\n"
            assert sorted(p.name for p in d.iterdir()) == ["access-code"]
            assert mode_of(d / "access-code") == 0o600


def _race_worker(backend: str, dirs: list[str], barrier: Any, results: Any) -> None:
    """One of two processes making the same code files (spawned: a fresh interpreter)."""
    sys.path.insert(0, backend)
    from mommy.config import code_from_file as load

    for i, d in enumerate(dirs):
        barrier.wait(timeout=60)
        results.put((i, load(Path(d) / "access-code")))


def test_code_is_never_logged(clean_env: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    """Making, reading and replacing the code file, building the app and printing the
    link log the path at most, never the code."""
    path = tmp_path / "access-code"
    clean_env.setenv("MOMMY_ACCESS_CODE_FILE", str(path))
    clean_env.setenv("MOMMY_ALLOWED_HOSTS", COMPOSE_HOSTS)
    logger = logging.getLogger("mommy")
    saved_level = logger.level
    logger.setLevel(logging.DEBUG)
    logger.addHandler(caplog.handler)  # also when another test turned propagation off
    codes: list[str] = []
    try:
        with caplog.at_level(logging.DEBUG):
            settings = load_settings()
            codes.append(settings.access_code or "")
            logging.getLogger("mommy.test").info("settings: %r", settings)
            load_settings()
            client = TestClient(make_app(settings), base_url=f"http://{TUNNEL_HOST}")
            client.post("/api/access", json={"code": codes[0]})
            client.post("/api/access", json={"code": OTHER_CODE})
            with FakeMetrics() as metrics:
                out = io.StringIO()
                env = {"MOMMY_ACCESS_CODE_FILE": str(path), "MOMMY_TUNNEL_METRICS_URL": metrics.url}
                assert main(["--new-code"], env=env, stdout=out, stderr=io.StringIO()) == 0
                codes.append(path.read_text("utf-8").strip())
                assert main([], env=env, stdout=io.StringIO(), stderr=io.StringIO()) == 0
            load_settings()
    finally:
        logger.removeHandler(caplog.handler)
        logger.setLevel(saved_level)
    assert "made a new access code in" in caplog.text and str(path) in caplog.text
    assert codes[0] and codes[1] and codes[0] != codes[1]
    for record in caplog.records:
        message = record.getMessage() + repr(record.args)
        for code in codes:
            assert code not in message, record.getMessage()


# ---------------------------------------------------------------------------
# share_link against a fake cloudflared metrics server
# ---------------------------------------------------------------------------


class FakeMetrics:
    """A stand-in for cloudflared's metrics server on 127.0.0.1.

    ``answers[path]`` is a list of answers given in turn (the last one is repeated):
    ``(status, body)``, or ``"drop"`` to close the connection without answering. By
    default ``/quicktunnel`` gives cloudflared's own answer and ``/ready`` 200."""

    def __init__(self, answers: dict[str, list[Any]] | None = None, *, port: int = 0) -> None:
        self.answers: dict[str, list[Any]] = {"/quicktunnel": [(200, CLOUDFLARED_ANSWER)], "/ready": [(200, b"{}")]}
        self.answers.update(answers or {})
        self.requests: list[str] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802 - http.server's name
                fake.requests.append(self.path)
                script = fake.answers.get(self.path, [(404, b"404 page not found\n")])
                answer = script.pop(0) if len(script) > 1 else script[0]
                if answer == "drop":
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                status, body = answer
                self.send_response(status)
                self.send_header("Content-Type", "text/plain; charset=utf-8")  # as cloudflared
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "FakeMetrics":
        self.thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.server.shutdown()
        self.server.server_close()

    def count(self, path: str) -> int:
        return self.requests.count(path)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def code_file(tmp_path: Path) -> Path:
    path = tmp_path / "access-code"
    path.write_text(CODE + "\n", encoding="utf-8")
    path.chmod(0o600)
    return path


def run(argv: list[str], env: dict[str, str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    status = main(argv, env=env, stdout=out, stderr=err, interval_s=0.05)
    return status, out.getvalue(), err.getvalue()


class TestShareLink:
    def env(self, metrics: FakeMetrics | str, code_file: Path, **extra: str) -> dict[str, str]:
        url = metrics if isinstance(metrics, str) else metrics.url
        env = {
            "MOMMY_ACCESS_CODE_FILE": str(code_file),
            "MOMMY_TUNNEL_METRICS_URL": url,
            "MOMMY_ALLOWED_HOSTS": COMPOSE_HOSTS,
        }
        env.update(extra)
        return env

    def test_success(self, code_file: Path) -> None:
        with FakeMetrics() as metrics:
            status, out, err = run([], self.env(metrics, code_file))
        assert status == 0 and err == ""
        assert out.splitlines() == [f"https://{TUNNEL_HOST}/#code={CODE}", REMINDER]
        assert "reboot" in REMINDER and "code stays the same" in REMINDER and "\n" not in REMINDER
        assert metrics.requests == ["/quicktunnel", "/ready", "/metrics"]

    #: cloudflared 2026.10.7's build_info line, as its /metrics serves it.
    BUILD_INFO = (b'# HELP build_info Build and version information\n# TYPE build_info gauge\n'
                  b'build_info{goversion="go1.27.3",revision="2026-10-30-17:17 UTC",type="",version="2026.10.7"} 1\n')

    @pytest.mark.parametrize(
        "today,noted",
        [(datetime.date(2026, 11, 12), False), (datetime.date(2027, 7, 31), False), (datetime.date(2027, 8, 1), True),
         (datetime.date(2028, 1, 1), True)],
    )
    def test_an_old_cloudflared_gets_a_note(self, code_file: Path, today: datetime.date, noted: bool) -> None:
        """SEC-10: the pinned cloudflared is frozen; once it is more than 9 months old the
        owner is told to update (the link is still printed)."""
        with FakeMetrics({"/metrics": [(200, b"# other metrics\nfoo 1\n" + self.BUILD_INFO)]}) as metrics:
            out, err = io.StringIO(), io.StringIO()
            status = main([], env=self.env(metrics, code_file), stdout=out, stderr=err, interval_s=0.05, today=today)
        assert status == 0 and out.getvalue().splitlines()[0] == f"https://{TUNNEL_HOST}/#code={CODE}"
        assert ("cloudflared 2026.10.7, from 2026-10" in err.getvalue()) is noted
        assert ("To update Mommy" in err.getvalue()) is noted

    def test_tunnel_version(self) -> None:
        assert share_mod.tunnel_version(self.BUILD_INFO.decode()) == ("2026.10.7", 2026, 10)
        for text in ("", "build_info 1", 'build_info{version="dev"} 1', 'build_info{version="2026.13.1"} 1',
                     'xbuild_info{version="2020.1.1"} 1'):
            assert share_mod.tunnel_version(text) is None, text
        assert share_mod.old_tunnel_note("", datetime.date(2030, 1, 1)) is None

    def test_link_only(self, code_file: Path) -> None:
        with FakeMetrics() as metrics:
            status, out, err = run(["--link-only"], self.env(metrics, code_file))
        assert status == 0 and err == "" and out == f"https://{TUNNEL_HOST}/#code={CODE}\n"

    def test_the_link_keeps_the_code_in_the_fragment(self, code_file: Path) -> None:
        with FakeMetrics() as metrics:
            _, out, _ = run(["--link-only"], self.env(metrics, code_file))
        link = urllib.parse.urlsplit(out.strip())
        assert (link.scheme, link.netloc, link.path, link.query) == ("https", TUNNEL_HOST, "/", "")
        assert link.fragment == f"code={CODE}"

    def test_an_odd_code_from_the_environment_is_encoded(self, code_file: Path) -> None:
        odd = "ab+c d#e&f=g٢"
        with FakeMetrics() as metrics:
            status, out, _ = run(["--link-only"], self.env(metrics, code_file, MOMMY_ACCESS_CODE=odd))
        assert status == 0
        fragment = urllib.parse.urlsplit(out.strip()).fragment
        # URLSearchParams (web/access.js) decodes as parse_qs does ("+" is a space).
        assert urllib.parse.parse_qs(fragment) == {"code": [odd]}

    def test_env_code_wins(self, code_file: Path) -> None:
        with FakeMetrics() as metrics:
            _, out, _ = run(["--link-only"], self.env(metrics, code_file, MOMMY_ACCESS_CODE=OTHER_CODE))
        assert out.strip().endswith(f"#code={OTHER_CODE}")

    def test_retry_while_the_tunnel_starts(self, code_file: Path) -> None:
        answers = {"/quicktunnel": ["drop", (502, b"starting"), (200, CLOUDFLARED_ANSWER)], "/ready": [(503, b"{}"), (503, b"{}"), (200, b"{}")]}
        with FakeMetrics(answers) as metrics:
            status, out, err = run([], self.env(metrics, code_file))
        assert status == 0
        assert out.splitlines()[0] == f"https://{TUNNEL_HOST}/#code={CODE}"
        assert err.count("Waiting for the tunnel") == 1 and "Warning" not in err
        assert metrics.count("/quicktunnel") == 3 and metrics.count("/ready") == 3

    def test_retry_until_the_metrics_server_listens(self, code_file: Path) -> None:
        """Connection refused at first (cloudflared starts its metrics server only once it
        has the tunnel's name)."""
        port = free_port()
        holder: list[FakeMetrics] = []

        def start() -> None:
            holder.append(FakeMetrics(port=port).__enter__())

        timer = threading.Timer(0.4, start)
        timer.start()
        try:
            started = time.monotonic()
            status, out, err = run(["--wait", "10"], self.env(f"http://127.0.0.1:{port}", code_file))
        finally:
            timer.join()
            for m in holder:
                m.__exit__(None, None, None)
        assert status == 0 and out.startswith(f"https://{TUNNEL_HOST}/#code={CODE}\n")
        assert "Waiting for the tunnel to start (up to 10 s)" in err
        assert 0.3 < time.monotonic() - started < 5

    def test_timeout(self, code_file: Path) -> None:
        url = f"http://127.0.0.1:{free_port()}"
        started = time.monotonic()
        status, out, err = run(["--wait", "0.5"], self.env(url, code_file))
        elapsed = time.monotonic() - started
        assert status == 3 and out == ""
        assert f"No link: the tunnel did not answer at {url} within 0.5 s (no answer: ConnectionRefusedError)" in err
        assert "docker compose logs tunnel" in err and "docker compose exec mommy python -m mommy.share_link" in err
        assert CODE not in err
        assert 0.4 < elapsed < 5

    def test_unknown_tunnel_name_times_out(self, code_file: Path) -> None:
        """The default address (http://tunnel:2000) outside compose: the name does not resolve."""
        env = self.env("http://tunnel.invalid:2000", code_file)
        status, out, err = run(["--wait", "0.2"], env)
        assert status == 3 and out == "" and "did not answer at http://tunnel.invalid:2000" in err

    def test_not_connected_yet_still_prints_the_link(self, code_file: Path) -> None:
        with FakeMetrics({"/ready": [(503, b'{"status":503,"readyConnections":0}')]}) as metrics:
            status, out, err = run(["--wait", "0.3"], self.env(metrics, code_file))
        assert status == 0 and out.splitlines() == [f"https://{TUNNEL_HOST}/#code={CODE}", REMINDER]
        assert "Warning: the tunnel is not connected to Cloudflare yet (after 0.3 s)" in err

    def test_no_ready_endpoint(self, code_file: Path) -> None:
        with FakeMetrics({"/ready": [(404, b"404 page not found\n")]}) as metrics:
            status, out, err = run([], self.env(metrics, code_file))
        assert status == 0 and err == "" and out.splitlines()[0].endswith(CODE)

    @pytest.mark.parametrize(
        "body",
        [
            b"not json",
            b"",
            b"[]",
            b'{"host": "abc.trycloudflare.com"}',
            b'{"hostname": 5}',
            b'{"hostname": "a b.trycloudflare.com"}',
            b'{"hostname": "<script>.trycloudflare.com"}',
            b'{"hostname": "abc.trycloudflare.com/#x"}',
            b'{"hostname": "localhost"}',
            b"\xff\xfe",
        ],
    )
    def test_malformed_answer(self, code_file: Path, body: bytes) -> None:
        with FakeMetrics({"/quicktunnel": [(200, body)]}) as metrics:
            started = time.monotonic()
            status, out, err = run(["--wait", "30"], self.env(metrics, code_file))
        assert status == 3 and out == ""
        assert "is not understood" in err and CODE not in err
        assert time.monotonic() - started < 5  # not retried: it will not get better

    def test_empty_name_is_not_a_quick_tunnel(self, code_file: Path) -> None:
        with FakeMetrics({"/quicktunnel": [(200, b'{"hostname":""}')]}) as metrics:
            status, out, err = run(["--wait", "30"], self.env(metrics, code_file))
        assert status == 3 and out == "" and "without a quick tunnel" in err

    def test_no_quicktunnel_endpoint(self, code_file: Path) -> None:
        with FakeMetrics({"/quicktunnel": [(404, b"404 page not found\n")]}) as metrics:
            status, out, err = run(["--wait", "30"], self.env(metrics, code_file))
        assert status == 3 and out == "" and "does not exist" in err

    def test_proxy_variables_are_ignored(self, code_file: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in ("HTTP_PROXY", "http_proxy", "ALL_PROXY"):
            monkeypatch.setenv(name, "http://127.0.0.1:9")  # nothing listens there
        for name in ("NO_PROXY", "no_proxy"):
            monkeypatch.delenv(name, raising=False)
        with FakeMetrics() as metrics:
            status, out, _ = run(["--wait", "2"], self.env(metrics, code_file))
        assert status == 0 and metrics.requests

    def test_host_not_allowed_is_warned(self, code_file: Path) -> None:
        with FakeMetrics() as metrics:
            status, out, err = run([], self.env(metrics, code_file, MOMMY_ALLOWED_HOSTS="localhost,127.0.0.1"))
        assert status == 0 and out.startswith("https://")
        assert f"Warning: the app does not answer to {TUNNEL_HOST}" in err and ".trycloudflare.com" in err
        with FakeMetrics() as metrics:
            env = self.env(metrics, code_file)
            del env["MOMMY_ALLOWED_HOSTS"]  # the defaults: loopback names only
            assert "does not answer to" in run([], env)[2]

    def test_no_code_configured(self, tmp_path: Path) -> None:
        with FakeMetrics() as metrics:
            status, out, err = run([], {"MOMMY_TUNNEL_METRICS_URL": metrics.url})
        assert status == 1 and out == "" and "No access code is set" in err
        assert metrics.requests == []

    def test_code_file_missing(self, tmp_path: Path) -> None:
        path = tmp_path / "access-code"
        with FakeMetrics() as metrics:
            status, out, err = run([], self.env(metrics, path))
        assert status == 1 and out == ""
        assert f"No access code yet: {path} does not exist" in err and RESTART_COMMAND in err
        assert not path.exists()  # the app makes it, never this command

    def test_bad_code_file(self, tmp_path: Path) -> None:
        path = tmp_path / "access-code"
        path.write_text("x7q\n", encoding="utf-8")
        with FakeMetrics() as metrics:
            status, out, err = run([], self.env(metrics, path))
        assert status == 1 and out == ""
        assert "at least 8 characters" in err and share_mod.REPAIR_COMMAND in err
        assert "x7q" not in err.replace(str(path), "")

    def test_short_code_in_the_variable(self, code_file: Path) -> None:
        """A too-short MOMMY_ACCESS_CODE: --new-code would not help (the variable wins), so
        it is not suggested."""
        with FakeMetrics() as metrics:
            status, out, err = run([], self.env(metrics, code_file, MOMMY_ACCESS_CODE="x7q2"))
        assert status == 1 and out == "" and metrics.requests == []
        assert "MOMMY_ACCESS_CODE must have at least 8 characters" in err and "x7q2" not in err
        assert "Change MOMMY_ACCESS_CODE where it is set" in err and "--new-code" not in err

    def test_new_code(self, code_file: Path) -> None:
        with FakeMetrics() as metrics:
            status, out, err = run(["--new-code"], self.env(metrics, code_file))
        assert status == 0 and err == ""
        new = code_file.read_text("utf-8").strip()
        assert new != CODE and len(new) == CODE_LENGTH and set(new) <= set(CODE_ALPHABET)
        assert mode_of(code_file) == 0o600
        assert out.splitlines() == [
            f"A new access code is saved in {code_file}.",
            "Restart the app so that it uses the new code (the old link then stops working):",
            f"    {RESTART_COMMAND}",
            "Then share the new link:",
            f"https://{TUNNEL_HOST}/#code={new}",
            REMINDER,
        ]
        assert CODE not in out
        assert RESTART_COMMAND == "docker compose restart mommy"
        # What the app reads at its restart.
        assert code_from_file(code_file, create=False) == new

    def test_new_code_makes_a_missing_file(self, tmp_path: Path) -> None:
        path = tmp_path / "access-code"
        with FakeMetrics() as metrics:
            status, out, _ = run(["--new-code", "--link-only"], self.env(metrics, path))
        assert status == 0 and path.read_text("utf-8").strip() in out.splitlines()[-1]

    def test_new_code_without_the_tunnel_still_saves_it(self, code_file: Path) -> None:
        status, out, err = run(["--new-code", "--wait", "0.2"], self.env(f"http://127.0.0.1:{free_port()}", code_file))
        assert status == 3
        new = code_file.read_text("utf-8").strip()
        assert new != CODE and RESTART_COMMAND in out and new not in out + err
        assert "No link" in err

    def test_new_code_refused_when_the_variable_wins(self, code_file: Path) -> None:
        with FakeMetrics() as metrics:
            status, out, err = run(["--new-code"], self.env(metrics, code_file, MOMMY_ACCESS_CODE=OTHER_CODE))
        assert status == 1 and out == "" and "MOMMY_ACCESS_CODE is set" in err
        assert code_file.read_text("utf-8") == CODE + "\n" and OTHER_CODE not in err

    def test_new_code_without_a_file_variable(self) -> None:
        status, out, err = run(["--new-code"], {})
        assert status == 1 and out == "" and "MOMMY_ACCESS_CODE_FILE is not set" in err

    def test_new_code_into_a_missing_directory(self, tmp_path: Path) -> None:
        path = tmp_path / "no-such-dir" / "access-code"
        status, out, err = run(["--new-code"], {"MOMMY_ACCESS_CODE_FILE": str(path)})
        assert status == 1 and out == "" and f"Cannot write the new access code to {path}" in err

    def test_bad_options(self) -> None:
        assert run(["--wait", "-1"], {})[0] == 2
        assert run(["--no-such-option"], {})[0] == 2

    def test_parse_hostname(self) -> None:
        assert parse_hostname(CLOUDFLARED_ANSWER) == TUNNEL_HOST
        assert parse_hostname(b'{"hostname":"https://ABC.trycloudflare.com."}') == "abc.trycloudflare.com"
        assert parse_hostname(b'{"hostname":""}') == ""
        for bad in (b"{}", b'{"hostname":null}', b'{"hostname":"a..b"}', b'"x"'):
            with pytest.raises(ValueError):
                parse_hostname(bad)

    def test_wait_for_tunnel_function(self) -> None:
        with FakeMetrics() as metrics:
            tunnel = wait_for_tunnel(metrics.url + "/", wait_s=1)
        assert (tunnel.hostname, tunnel.ready) == (TUNNEL_HOST, True)
        with pytest.raises(share_mod.TunnelError, match="not a usable"):
            wait_for_tunnel("tunnel:2000", wait_s=1)

    def test_command_line(self, code_file: Path) -> None:
        """``python -m mommy.share_link`` as compose runs it (the module's own main)."""
        with FakeMetrics() as metrics:
            env = {
                **{k: v for k, v in os.environ.items() if k not in ENV_VARS},
                **self.env(metrics, code_file),
                "PYTHONPATH": str(ROOT / "backend"),
            }
            r = subprocess.run(
                [sys.executable, "-m", "mommy.share_link"], env=env, capture_output=True, text=True, timeout=60, check=False
            )
            assert r.returncode == 0, r.stderr
            assert r.stdout.splitlines() == [f"https://{TUNNEL_HOST}/#code={CODE}", REMINDER] and r.stderr == ""
            r = subprocess.run(
                [sys.executable, "-m", "mommy.share_link", "--help"], env=env, capture_output=True, text=True, timeout=60, check=False
            )
            assert r.returncode == 0 and "--new-code" in r.stdout and CODE not in r.stdout


def test_cloudflared_answer_shape_is_json() -> None:
    """The captured answer is what parse_hostname reads (a sanity check of the fixture)."""
    assert json.loads(CLOUDFLARED_ANSWER) == {"hostname": TUNNEL_HOST}

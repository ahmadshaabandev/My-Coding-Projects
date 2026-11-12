"""The self-hosting kit (SELF_HOST.md): ``compose.yaml``, ``compose.test.yaml``,
``.gitattributes``, and what the image does with Windows line endings.

The compose files are read through ``docker compose config`` (no daemon needed; skipped
where Docker Compose is not installed), so the checks see what Compose itself makes of
them. ``scripts/space_start.sh`` runs here with a stand-in ``uvicorn``, as in
``tests/test_space_image.py``. Nothing here builds an image or uses the network: the
build, the containers and the tunnel were tested with Docker itself (README.md, "Run it
on your own computer").
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import urllib.parse
from pathlib import Path
from typing import Any

import pytest
from uvicorn.middleware.proxy_headers import _TrustedHosts

from mommy.access import CODE_ALPHABET, CODE_LENGTH, GATE_ASSETS, HostMatcher
from mommy.config import parse_allowed_hosts
from mommy.proxies import container_networks, read_routes, trusted_networks
from mommy.proxies import main as proxies_main
from mommy.share_link import DEFAULT_METRICS_URL, QUICKTUNNEL_PATH, REMINDER, RESTART_COMMAND, SHARE_COMMAND

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = ROOT / "compose.yaml"
COMPOSE_TEST = ROOT / "compose.test.yaml"
DOCKERFILE = ROOT / "Dockerfile"
START = ROOT / "scripts" / "space_start.sh"
DOWNLOAD = ROOT / "scripts" / "download_models.sh"
SELF_HOST = ROOT / "SELF_HOST.md"
ARCHIVE_URL = (
    "https://github.com/ahmadshaabandev/My-Coding-Projects/archive/refs/heads/claude/laughing-goodall-h48bdw.zip"
)
#: The Dockerfile's command that removes a Windows CR from a script before it is used.
STRIP_CR = "sed -i 's/\\r$//'"


def _compose_config(*files: Path) -> dict[str, Any]:
    if shutil.which("docker") is None:
        pytest.skip("no docker")
    probe = subprocess.run(["docker", "compose", "version"], capture_output=True, text=True, timeout=60, check=False)
    if probe.returncode != 0:
        pytest.skip("no docker compose")
    args = ["docker", "compose"]
    for f in files:
        args += ["-f", str(f)]
    # A placeholder for the test override's optional CA bundle; never read here.
    env = {**os.environ, "MOMMY_BUILD_CA": os.devnull}
    r = subprocess.run([*args, "config", "--format", "json"], cwd=ROOT, env=env, capture_output=True, text=True,
                       timeout=60, check=False)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.fixture(scope="module")
def config() -> dict[str, Any]:
    return _compose_config(COMPOSE)


@pytest.fixture(scope="module")
def test_config() -> dict[str, Any]:
    return _compose_config(COMPOSE, COMPOSE_TEST)


# ---------------------------------------------------------------------------
# compose.yaml
# ---------------------------------------------------------------------------


def test_project_and_services(config: dict[str, Any]) -> None:
    # A fixed project name: the volume (the code) is the same from any folder the files
    # are unzipped to, so an update in a new folder keeps the code.
    assert config["name"] == "mommy"
    assert set(config["services"]) == {"mommy", "tunnel"}
    assert config["volumes"]["mommy-data"]["name"] == "mommy_mommy-data"


def test_app_service(config: dict[str, Any]) -> None:
    app = config["services"]["mommy"]
    assert app["build"]["dockerfile"] == "Dockerfile" and Path(app["build"]["context"]) == ROOT
    assert "args" not in app["build"]  # the full build: the models are downloaded into the image
    env = app["environment"]
    assert env["MOMMY_ACCESS_CODE_FILE"] == "/data/access-code"
    assert "MOMMY_ACCESS_CODE" not in env  # the code is never in a file of the repository
    assert env["MOMMY_ALLOWED_HOSTS"] == "localhost,127.0.0.1,.trycloudflare.com"
    assert env["MOMMY_FORWARDED_ALLOW_IPS"] == "container-networks"
    assert env["MOMMY_TUNNEL_METRICS_URL"] == DEFAULT_METRICS_URL
    assert int(env["MOMMY_ASR_THREADS"]) >= 1
    assert app["volumes"] == [{"type": "volume", "source": "mommy-data", "target": "/data", "volume": {}}]
    # Only this computer: no other device on the home network reaches the port.
    assert [(p["host_ip"], p["published"], p["target"]) for p in app["ports"]] == [("127.0.0.1", "8080", 7860)]
    assert app["restart"] == "unless-stopped"
    assert app["read_only"] is True and app["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in app["security_opt"]
    assert "user" not in app  # the image's USER 1000:1000, which owns /data


def test_allowed_hosts_take_every_quick_tunnel_name(config: dict[str, Any]) -> None:
    matcher = HostMatcher(parse_allowed_hosts(config["services"]["mommy"]["environment"]["MOMMY_ALLOWED_HOSTS"]))
    for name in ("some-random-words.trycloudflare.com", "localhost", "127.0.0.1"):
        assert matcher.allows_name(name), name
    for name in ("trycloudflare.com", "eviltrycloudflare.com", "x.trycloudflare.com.evil.example", "evil.example"):
        assert not matcher.allows_name(name), name


def test_healthcheck_asks_for_a_page_served_without_the_code(config: dict[str, Any]) -> None:
    app = config["services"]["mommy"]
    test = app["healthcheck"]["test"]
    assert test[:3] == ["CMD", "python", "-c"]
    url = urllib.parse.urlsplit(re.search(r"'(http://[^']+)'", test[3]).group(1))
    assert url.path in GATE_ASSETS  # answers 200 without the cookie
    assert url.port == 7860 and url.hostname in app["environment"]["MOMMY_ALLOWED_HOSTS"].split(",")


def test_tunnel_service(config: dict[str, Any]) -> None:
    tunnel = config["services"]["tunnel"]
    assert re.fullmatch(r"cloudflare/cloudflared:\d{4}\.\d+\.\d+@sha256:[0-9a-f]{64}", tunnel["image"])
    assert tunnel["command"] == ["tunnel", "--no-autoupdate", "--url", "http://mommy:7860", "--metrics", "0.0.0.0:2000"]
    assert "ports" not in tunnel  # the metrics server is reachable from the app only
    assert "build" not in tunnel and "environment" not in tunnel  # no token, no named tunnel
    assert tunnel["depends_on"]["mommy"]["condition"] == "service_healthy"
    assert tunnel["restart"] == "unless-stopped"
    assert tunnel["read_only"] is True and tunnel["cap_drop"] == ["ALL"]
    # share_link asks the service this command starts.
    metrics = urllib.parse.urlsplit(DEFAULT_METRICS_URL)
    assert metrics.hostname == "tunnel" and f"0.0.0.0:{metrics.port}" in tunnel["command"]
    assert QUICKTUNNEL_PATH == "/quicktunnel"


def test_compose_text_has_no_code_and_a_pinned_tunnel() -> None:
    """The same, without Docker: the file itself."""
    text = COMPOSE.read_text("utf-8")
    assert not re.search(r"^\s*-?\s*MOMMY_ACCESS_CODE\s*[:=]", text, flags=re.M)
    assert re.search(r"^\s*image: cloudflare/cloudflared:[0-9.]+@sha256:[0-9a-f]{64}$", text, flags=re.M)
    assert '"127.0.0.1:8080:7860"' in text


# ---------------------------------------------------------------------------
# compose.test.yaml
# ---------------------------------------------------------------------------


def test_the_test_override_is_marked_and_mounts_the_models(test_config: dict[str, Any]) -> None:
    assert COMPOSE_TEST.read_text("utf-8").startswith("# FOR TESTING THE KIT ONLY.")
    app = test_config["services"]["mommy"]
    assert app["build"]["args"] == {"SKIP_MODELS": "1"}
    mounts = {Path(v["target"]).name: v for v in app["volumes"] if v["type"] == "bind"}
    assert set(mounts) == {
        "sherpa-onnx-whisper-turbo", "vits-piper-ar_JO-kareem-medium", "vits-piper-en_US-lessac-medium",
        "vits-piper-fr_FR-siwis-medium",
    }
    for name, mount in mounts.items():
        assert mount["read_only"] is True and mount["target"] == f"/home/user/app/models/{name}"
    # Everything else is compose.yaml's.
    assert app["environment"]["MOMMY_ACCESS_CODE_FILE"] == "/data/access-code"
    assert test_config["services"]["tunnel"]["image"].startswith("cloudflare/cloudflared:")


# ---------------------------------------------------------------------------
# Line endings (a Windows clone with core.autocrlf, or a ZIP converted on the way)
# ---------------------------------------------------------------------------


def test_gitattributes_keep_lf_for_what_the_container_runs() -> None:
    if shutil.which("git") is None:
        pytest.skip("no git")
    paths = ["run.sh", "scripts/space_start.sh", "scripts/download_models.sh", "Dockerfile", ".dockerignore",
             "compose.yaml", "compose.test.yaml", "requirements-runtime.lock", "data/quran/quran-uthmani.txt"]
    r = subprocess.run(["git", "check-attr", "text", "eol", "--", *paths], cwd=ROOT, capture_output=True, text=True,
                       timeout=60, check=False)
    if r.returncode != 0:
        pytest.skip("not a git checkout")
    attrs: dict[tuple[str, str], str] = {}
    for line in r.stdout.splitlines():
        path, attr, value = line.rsplit(": ", 2)
        attrs[(path, attr)] = value
    for path in paths[:-1]:
        assert attrs[(path, "eol")] == "lf", path
    assert attrs[("data/quran/quran-uthmani.txt", "text")] == "unset"  # byte for byte, never converted


def test_dockerfile_strips_cr_before_running_a_script() -> None:
    text = DOCKERFILE.read_text("utf-8")
    models, runtime = text.split("FROM ${PYTHON_IMAGE}\n", 1)
    assert models.index(f"{STRIP_CR} scripts/download_models.sh") < models.index("bash scripts/download_models.sh")
    assert runtime.index("COPY scripts/space_start.sh") < runtime.index(f"{STRIP_CR} scripts/space_start.sh")
    assert runtime.index(f"{STRIP_CR} scripts/space_start.sh") < runtime.index("CMD [")


@pytest.mark.parametrize("script", [START, DOWNLOAD], ids=["space_start.sh", "download_models.sh"])
def test_the_strip_restores_a_crlf_script(tmp_path: Path, script: Path) -> None:
    """The Dockerfile's own command, on a copy with CRLF endings, gives back the file."""
    if shutil.which("sed") is None:
        pytest.skip("no sed")
    copy = tmp_path / script.name
    original = script.read_bytes()
    assert b"\r" not in original
    copy.write_bytes(original.replace(b"\n", b"\r\n"))
    subprocess.run(["sh", "-c", f'{STRIP_CR} "$1"', "sh", str(copy)], check=True, timeout=60)
    assert copy.read_bytes() == original


# ---------------------------------------------------------------------------
# scripts/space_start.sh as compose.yaml runs it
# ---------------------------------------------------------------------------


@pytest.fixture
def start_env(tmp_path: Path) -> dict[str, str]:
    """PATH with this Python as ``python`` and a stand-in ``uvicorn`` that prints its
    arguments; the variables compose.yaml sets, with the code file in tmp_path."""
    if shutil.which("sh") is None:
        pytest.skip("no sh")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "python").symlink_to(sys.executable)
    fake = bin_dir / "uvicorn"
    fake.write_text('#!/bin/sh\necho "UVICORN $*"\n', encoding="utf-8")
    fake.chmod(0o755)
    data = tmp_path / "data"
    data.mkdir(mode=0o700)
    return {
        "PATH": f"{bin_dir}{os.pathsep}/usr/bin{os.pathsep}/bin",
        "PYTHONPATH": str(ROOT / "backend"),
        "HOME": str(tmp_path),
        "MOMMY_ACCESS_CODE_FILE": str(data / "access-code"),
        "MOMMY_ALLOWED_HOSTS": "localhost,127.0.0.1,.trycloudflare.com",
        "MOMMY_FORWARDED_ALLOW_IPS": "container-networks",
    }


def _run(script: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["sh", str(script)], env=env, capture_output=True, text=True, timeout=60, check=False)


def _trusted(stdout: str) -> list[str]:
    args = re.search(r"^UVICORN (.*)$", stdout, flags=re.M).group(1).split()
    return args[args.index("--forwarded-allow-ips") + 1].split(",")


def test_start_makes_the_code_file_once_and_never_prints_it(start_env: dict[str, str]) -> None:
    path = Path(start_env["MOMMY_ACCESS_CODE_FILE"])
    r = _run(START, start_env)
    assert r.returncode == 0, r.stderr
    code = path.read_text("utf-8").strip()
    assert len(code) == CODE_LENGTH and set(code) <= set(CODE_ALPHABET)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert code not in r.stdout + r.stderr
    assert "access gate on; answering to localhost, 127.0.0.1, .trycloudflare.com" in r.stderr
    again = _run(START, start_env)
    assert again.returncode == 0 and path.read_text("utf-8").strip() == code  # kept across restarts
    # MOMMY_ACCESS_CODE wins over the file (and the file is left as it is).
    other = _run(START, {**start_env, "MOMMY_ACCESS_CODE": "k7m2p9q4r8s3"})
    assert other.returncode == 0 and path.read_text("utf-8").strip() == code


def test_start_refuses_a_code_file_it_cannot_make(start_env: dict[str, str], tmp_path: Path) -> None:
    r = _run(START, {**start_env, "MOMMY_ACCESS_CODE_FILE": str(tmp_path / "missing-dir" / "access-code")})
    assert r.returncode == 1 and "UVICORN" not in r.stdout
    assert "refusing to serve" in r.stderr


def test_start_trusts_only_its_own_networks(start_env: dict[str, str]) -> None:
    """container-networks: the directly connected networks of the container (the compose
    network) without their gateways, never '*' or a default route; without any, the
    private-network list."""
    r = _run(START, start_env)
    assert r.returncode == 0, r.stderr
    trusted = _trusted(r.stdout)
    assert trusted and "*" not in trusted and "container-networks" not in trusted
    for entry in trusted:
        net = ipaddress.ip_network(entry, strict=False)
        assert net.prefixlen > 0, entry
    nets, gateways = read_routes(_read_text("/proc/net/route"), _read_text("/proc/net/ipv6_route"))
    if nets:
        assert trusted == trusted_networks(nets, gateways)[0]
        assert "X-Forwarded-For is taken from the container's networks " in r.stderr
        for gateway in gateways:
            assert not any(gateway in ipaddress.ip_network(t) for t in trusted), gateway
    else:
        assert f"X-Forwarded-For is taken from {','.join(trusted)}" in r.stderr


def _read_text(path: str) -> str | None:
    try:
        return Path(path).read_text("ascii")
    except OSError:
        return None


def _le(address: str) -> str:
    """An IPv4 address as /proc/net/route writes it (hex, in this machine's byte order)."""
    return int.from_bytes(ipaddress.IPv4Address(address).packed, sys.byteorder).to_bytes(4, "big").hex().upper()


#: /proc/net/route and /proc/net/ipv6_route of a compose container (eth0 172.20.0.3/16,
#: default route through the gateway 172.20.0.1; IPv6 fd00:dead::3/64 through fd00:dead::1).
FAKE_ROUTE = (
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
    f"eth0\t00000000\t{_le('172.20.0.1')}\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"
    f"eth0\t{_le('172.20.0.0')}\t00000000\t0001\t0\t0\t0\t{_le('255.255.0.0')}\t0\t0\t0\n"
    f"lo\t{_le('127.0.0.0')}\t00000000\t0001\t0\t0\t0\t{_le('255.0.0.0')}\t0\t0\t0\n"
)
FAKE_IPV6_ROUTE = (
    "fd00dead000000000000000000000000 40 00000000000000000000000000000000 00 "
    "00000000000000000000000000000000 00000100 00000001 00000000 00000001     eth0\n"
    "00000000000000000000000000000000 00 00000000000000000000000000000000 00 "
    "fd00dead000000000000000000000001 00000400 00000001 00000000 00000003     eth0\n"
    "fe800000000000000000000000000000 40 00000000000000000000000000000000 00 "
    "00000000000000000000000000000000 00000100 00000001 00000000 00000001     eth0\n"
    "00000000000000000000000000000001 80 00000000000000000000000000000000 00 "
    "00000000000000000000000000000000 00000000 00000002 00000000 80200001       lo\n"
)


def test_the_gateway_is_never_trusted() -> None:
    """SEC-2: Docker's forwarding of the published port (127.0.0.1:8080) reaches the app
    from the network's gateway, as does any program on the computer: its X-Forwarded-For
    is not believed. The tunnel (another address of the network) still is."""
    nets, gateways = read_routes(FAKE_ROUTE, FAKE_IPV6_ROUTE)
    assert [str(n) for n in nets] == ["172.20.0.0/16", "fd00:dead::/64"]
    assert [str(g) for g in gateways] == ["172.20.0.1", "fd00:dead::1"]
    blocks, left_out = container_networks(FAKE_ROUTE, FAKE_IPV6_ROUTE)
    assert left_out == ["172.20.0.1", "fd00:dead::1"]
    trusted = _TrustedHosts(",".join(blocks))  # uvicorn's own check
    for address in ("172.20.0.1", "fd00:dead::1", "127.0.0.1", "10.0.0.1", "203.0.113.7", "fe80::1"):
        assert address not in trusted, address
    for address in ("172.20.0.3", "172.20.0.2", "172.20.255.254", "fd00:dead::3"):
        assert address in trusted, address
    # Without a default route, the first address of each network is still left out
    # (where Docker puts a network's gateway).
    only_nets = "".join(FAKE_ROUTE.splitlines(keepends=True)[i] for i in (0, 2))
    blocks, left_out = container_networks(only_nets, None)
    assert left_out == ["172.20.0.1"] and "172.20.0.1" not in _TrustedHosts(",".join(blocks))
    assert container_networks(None, None) == ([], [])
    assert container_networks("garbage\nnot a route table at all\n", "x y z") == ([], [])


def test_start_uses_the_routing_tables(start_env: dict[str, str], tmp_path: Path) -> None:
    """space_start.sh runs python -m mommy.proxies; it falls back to the private networks
    when that finds none (exit 1)."""
    text = START.read_text("utf-8")
    assert "python -m mommy.proxies container-networks" in text
    assert proxies_main(["bogus"]) == 2


def test_a_crlf_start_script_runs_once_stripped(start_env: dict[str, str], tmp_path: Path) -> None:
    if shutil.which("sed") is None:
        pytest.skip("no sed")
    script = tmp_path / "space_start.sh"
    script.write_bytes(START.read_bytes().replace(b"\n", b"\r\n"))
    broken = _run(script, start_env)
    assert broken.returncode != 0 and "UVICORN" not in broken.stdout  # why the image strips it
    subprocess.run(["sh", "-c", f'{STRIP_CR} "$1"', "sh", str(script)], check=True, timeout=60)
    r = _run(script, start_env)
    assert r.returncode == 0, r.stderr
    assert "UVICORN mommy.app:build_default_app --factory --host 0.0.0.0 --port 7860" in r.stdout


# ---------------------------------------------------------------------------
# SELF_HOST.md and README.md
# ---------------------------------------------------------------------------


def test_self_host_guide_has_the_exact_commands() -> None:
    text = SELF_HOST.read_text("utf-8")
    for command in (
        "docker compose up -d --build",
        "docker compose up -d\n",
        SHARE_COMMAND,
        f"{SHARE_COMMAND} --new-code",
        # From any folder: the container's name is the fixed project name, the service, 1.
        "docker exec mommy-mommy-1 python -m mommy.share_link",
        RESTART_COMMAND,
        "docker compose down\n",
        "docker compose logs mommy",
        "docker compose logs tunnel",
        "docker compose ps",
        ARCHIVE_URL,
        "git clone --branch claude/laughing-goodall-h48bdw https://github.com/ahmadshaabandev/My-Coding-Projects.git",
        "http://localhost:8080",
        "https://www.docker.com/products/docker-desktop/",
    ):
        assert command in text, command
    assert REMINDER in text  # the example output is what share_link prints
    for system in ("Windows", "Mac", "Linux", "WSL 2", "Apple Silicon"):
        assert system in text, system


def test_readme_links_the_guide() -> None:
    text = (ROOT / "README.md").read_text("utf-8")
    assert "](SELF_HOST.md)" in text and SHARE_COMMAND in text


# Hard rule 6 for the kit's files. The family names are spelled backwards so that this
# file does not contain them either.
_FAMILIES = [name[::-1] for name in ("supo", "tennos", "ukiah", "elbaf", "sohtym")]


@pytest.mark.parametrize("path", [COMPOSE, COMPOSE_TEST, SELF_HOST, DOCKERFILE, START, ROOT / ".gitattributes",
                                  ROOT / "scripts" / "refresh_pins.py", ROOT / "backend" / "mommy" / "proxies.py",
                                  Path(__file__)], ids=lambda p: p.name)
def test_no_model_identifiers(path: Path) -> None:
    # The branch name (claude/... and, in the ZIP's folder name, claude-...) is no model.
    text = re.sub(r"claude[/-]laughing-goodall", "", path.read_text(encoding="utf-8").lower())
    assert not re.search(r"claude[\s_-]*\d", text)
    assert not re.search(r"claude-[a-z]", text)
    for family in _FAMILIES:
        assert family not in text


# ---------------------------------------------------------------------------
# scripts/refresh_pins.py: the image pins can move (SEC-10)
# ---------------------------------------------------------------------------


def _refresh_pins() -> Any:
    import importlib.util

    spec = importlib.util.spec_from_file_location("refresh_pins", ROOT / "scripts" / "refresh_pins.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["refresh_pins"] = module  # dataclasses look their module up there
    spec.loader.exec_module(module)
    return module


def test_every_image_is_pinned_once_by_digest() -> None:
    pins = _refresh_pins()
    seen = {}
    for pin in pins.PINS:
        match = pins.find_pin((ROOT / pin.file).read_text("utf-8"), pin)
        seen[pin.key] = match.group("tag")
    assert seen == {"cloudflared": "2026.10.7", "caddy": "2.11.9", "python": "3.13-slim"}
    # Both Caddy services use the one pin (a YAML anchor), so they never drift apart.
    stable = (ROOT / "deploy" / "oracle" / "compose.stable.yaml").read_text("utf-8")
    assert stable.count("image: *caddy-image") == 2 and stable.count("@sha256:") == 1


def test_refresh_pins_moves_a_pin_and_checks_both_platforms(tmp_path: Path) -> None:
    pins = _refresh_pins()
    for pin in pins.PINS:
        target = tmp_path / pin.file
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / pin.file, target)
    new = "a" * 64
    both = {"linux/amd64", "linux/arm64", "linux/arm/v7"}
    answers = {
        "cloudflare/cloudflared:2026.12.1": (new, both),
        "caddy:2.11.9": (pins.find_pin((ROOT / "deploy/oracle/compose.stable.yaml").read_text("utf-8"),
                                       pins.PINS[1]).group("digest"), both),
        "python:3.13-slim": ("b" * 64, {"linux/amd64"}),  # no arm64: refused
    }
    lines: list[str] = []
    status = pins.refresh(tmp_path, {"cloudflared": "2026.12.1"}, write=True, inspector=answers.__getitem__,
                          out=lines.append)
    assert status == 1
    compose = (tmp_path / "compose.yaml").read_text("utf-8")
    assert f"cloudflare/cloudflared:2026.12.1@sha256:{new}" in compose and "2026.10.7" not in compose
    assert (tmp_path / "Dockerfile").read_text("utf-8") == DOCKERFILE.read_text("utf-8")  # not moved
    assert any("lacks linux/arm64" in line for line in lines) and any("caddy" in l and "current" in l for l in lines)
    # Without --write nothing changes.
    before = (tmp_path / "compose.yaml").read_text("utf-8")
    pins.refresh(tmp_path, {"cloudflared": "2026.12.2"}, write=False,
                 inspector=lambda ref: ("c" * 64, both), out=lines.append)
    assert (tmp_path / "compose.yaml").read_text("utf-8") == before
    assert pins.platforms_of({"manifests": [{"platform": {"os": "linux", "architecture": "amd64"}},
                                            {"platform": {"os": "unknown", "architecture": "unknown"}}]}) == {"linux/amd64"}

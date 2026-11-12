"""The Oracle Cloud kit (deploy/oracle/ORACLE.md): ``setup.sh``, ``compose.oracle.yaml``,
``compose.stable.yaml`` and the ``Caddyfile``.

``setup.sh`` is sourced in bash (its ``main`` runs only when it is executed), so that its
helpers are tested one by one: version checks, public addresses, host names, and the
change it makes to Oracle's saved iptables rules. A ``--dry-run`` runs end to end with
stand-ins for sudo, curl and docker, and must change nothing. The compose files are read
through ``docker compose config`` (skipped without Docker Compose). Nothing here uses
the network or a Docker daemon: the real runs (apt, Docker's repository, the build, the
firewall in a container with NET_ADMIN, Caddy and Chromium) were done by hand and are
described in ORACLE.md's sources and the task report.
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
from pathlib import Path
from typing import Any

import pytest

from mommy.access import CODE_ALPHABET, CODE_LENGTH, HostMatcher
from mommy.config import parse_allowed_hosts
from mommy.share_link import share_link

ROOT = Path(__file__).resolve().parent.parent
ORACLE = ROOT / "deploy" / "oracle"
SETUP = ORACLE / "setup.sh"
GUIDE = ORACLE / "ORACLE.md"
COMPOSE = ROOT / "compose.yaml"
COMPOSE_ORACLE = ORACLE / "compose.oracle.yaml"
COMPOSE_STABLE = ORACLE / "compose.stable.yaml"
CADDYFILE = ORACLE / "Caddyfile"
START = ROOT / "scripts" / "space_start.sh"
HOST = "129-146-10-20.sslip.io"

#: The layout of /etc/iptables/rules.v4 on Oracle's Canonical Ubuntu images (the rules
#: that reject every new connection but SSH, and the InstanceServices chain).
_NOTE = ("See the Oracle-Provided Images section in the Oracle Cloud Infrastructure documentation for "
         "security impact of modifying or removing this rule")
ORACLE_RULES = f"""# CLOUD_IMG: This file was created/modified by the Cloud Image build process
# iptables configuration for Oracle Cloud Infrastructure

*filter
:INPUT ACCEPT [0:0]
:FORWARD ACCEPT [0:0]
:OUTPUT ACCEPT [463:49013]
:InstanceServices - [0:0]
-A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT
-A INPUT -p icmp -j ACCEPT
-A INPUT -i lo -j ACCEPT
-A INPUT -p udp --sport 123 -j ACCEPT
-A INPUT -p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT
-A INPUT -j REJECT --reject-with icmp-host-prohibited
-A FORWARD -j REJECT --reject-with icmp-host-prohibited
-A OUTPUT -d 169.254.0.0/16 -j InstanceServices
-A InstanceServices -d 169.254.0.2/32 -p tcp -m owner --uid-owner 0 -m tcp --dport 3260 -m comment --comment "{_NOTE}" -j ACCEPT
-A InstanceServices -d 169.254.169.254/32 -p tcp -m tcp --dport 80 -m comment --comment "{_NOTE}" -j ACCEPT
-A InstanceServices -d 169.254.0.0/16 -p tcp -m tcp -m comment --comment "{_NOTE}" -j REJECT --reject-with tcp-reset
COMMIT
"""
ACCEPT_80 = "-A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT"
ACCEPT_443 = "-A INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT"
REJECT = "-A INPUT -j REJECT --reject-with icmp-host-prohibited"


def _bash(code: str, *, stdin: str = "", env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """``code`` run in bash after sourcing setup.sh (its strict mode and trap undone)."""
    script = f'source "{SETUP}"; set +eE; trap - ERR\n{code}'
    return subprocess.run(["bash", "-c", script], input=stdin, capture_output=True, text=True, timeout=60,
                          env={**os.environ, **(env or {})}, check=False)


def _rules(text: str) -> str:
    r = _bash("rules_with_ports", stdin=text)
    assert r.returncode == 0, r.stderr
    return r.stdout


# ---------------------------------------------------------------------------
# setup.sh: the script itself
# ---------------------------------------------------------------------------


def test_syntax_and_no_trace() -> None:
    assert subprocess.run(["bash", "-n", str(SETUP)], capture_output=True, timeout=30).returncode == 0
    text = SETUP.read_text("utf-8")
    # A trace would print the commands, the link among them.
    assert not re.search(r"^\s*set -[a-zA-Z]*x", text, re.M) and "xtrace" not in text
    assert text.startswith("#!/usr/bin/env bash\n") and "\r" not in text
    # main only when run, so that sourcing it (here) runs nothing.
    assert text.rstrip().endswith('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then\n  main "$@"\nfi')


def test_shellcheck() -> None:
    if shutil.which("shellcheck") is None:
        pytest.skip("no shellcheck (pip install shellcheck-py)")
    r = subprocess.run(["shellcheck", "-s", "bash", str(SETUP)], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout


@pytest.mark.parametrize(("a", "b", "expected"), [
    ("29.1.3-0ubuntu3~24.04.2", "25.0", True),   # Ubuntu's docker.io in noble-updates
    ("24.0.7-0ubuntu4", "25.0", False),          # noble's first docker.io: no healthcheck start_interval
    ("2.40.3+ds1-0ubuntu1~24.04.1", "2.20", True),
    ("v5.7.1", "2.20", True),
    ("2.19.9", "2.20", False),
    ("25.0", "25.0", True),
])
def test_version_ge(a: str, b: str, expected: bool) -> None:
    assert (_bash(f'version_ge "{a}" "{b}"').returncode == 0) is expected


@pytest.mark.parametrize(("ip", "public"), [
    ("129.146.10.20", True), ("8.8.8.8", True), ("10.0.0.5", False), ("100.64.1.1", False),
    ("127.0.0.1", False), ("169.254.169.254", False), ("203.0.113.10", False), ("1.2.3", False),
    ("1.2.3.4.5", False), ("", False), ("abc", False),
])
def test_is_public_ipv4(ip: str, public: bool) -> None:
    assert (_bash(f'is_public_ipv4 "{ip}"').returncode == 0) is public


@pytest.mark.parametrize(("name", "ok"), [
    ("1-2-3-4.sslip.io", True), ("test-1-2-3-4.sslip.io", True), ("mommy.example.com", True),
    ("localhost", False), ("-bad.sslip.io", False), ("a..b.io", False), ("1.2.3.4", False),
    ("UPPER.example.com", False), ("x.trycloudflare.com/", False), ("a b.io", False),
])
def test_is_host_name(name: str, ok: bool) -> None:
    assert (_bash(f'is_host_name "{name}"').returncode == 0) is ok


def test_host_for_ip_and_the_app_answers_to_it_alone() -> None:
    r = _bash('host_for_ip 129.146.10.20')
    assert r.stdout.strip() == HOST
    matcher = HostMatcher(parse_allowed_hosts(f"localhost,127.0.0.1,{HOST}"))
    assert matcher.allows_name(HOST)
    for other in ("x.sslip.io", "a.trycloudflare.com", f"x.{HOST}", "sslip.io"):
        assert not matcher.allows_name(other)


# ---------------------------------------------------------------------------
# setup.sh: Oracle's saved firewall rules
# ---------------------------------------------------------------------------


def test_rules_get_the_two_ports_before_the_reject_rule() -> None:
    once = _rules(ORACLE_RULES)
    lines = once.splitlines()
    assert lines.index(ACCEPT_80) + 1 == lines.index(ACCEPT_443) == lines.index(REJECT) - 1
    # Nothing else changed: the same lines, in the same order, but the two new ones.
    assert [x for x in lines if x not in (ACCEPT_80, ACCEPT_443)] == ORACLE_RULES.splitlines()
    assert _rules(once) == once  # a second run changes nothing


def test_rules_a_copy_after_the_reject_rule_is_moved_before_it() -> None:
    late = ORACLE_RULES.replace(REJECT + "\n", REJECT + "\n" + ACCEPT_443 + "\n")
    lines = _rules(late).splitlines()
    assert lines.count(ACCEPT_443) == 1 and lines.index(ACCEPT_443) < lines.index(REJECT)


def test_rules_other_shapes() -> None:
    dropped = _rules("*filter\n:INPUT DROP [0:0]\n-A INPUT -i lo -j ACCEPT\nCOMMIT\n").splitlines()
    assert dropped[-3:] == [ACCEPT_80, ACCEPT_443, "COMMIT"]
    open_input = "*filter\n:INPUT ACCEPT [0:0]\nCOMMIT\n"
    assert _rules(open_input) == open_input
    # An INPUT chain of another table is not the firewall: left alone.
    nat = f"*nat\n:INPUT ACCEPT [0:0]\n{ACCEPT_80}\nCOMMIT\n*filter\n:INPUT ACCEPT [0:0]\n{REJECT}\nCOMMIT\n"
    out = _rules(nat).splitlines()
    assert out[2] == ACCEPT_80 and out[6:9] == [ACCEPT_80, ACCEPT_443, REJECT]


# ---------------------------------------------------------------------------
# setup.sh: a dry run changes nothing
# ---------------------------------------------------------------------------


def _ubuntu() -> bool:
    try:
        text = Path("/etc/os-release").read_text("utf-8")
    except OSError:
        return False
    return 'ID=ubuntu' in text and re.search(r'^VERSION_ID="(22|24)\.04"', text, re.M) is not None


@pytest.fixture
def dry_env(tmp_path: Path) -> dict[str, str]:
    """A home of its own, and stand-ins that fail for sudo, curl, docker and snap: the dry
    run may only read, and here it can read nothing that needs root or the network."""
    if not _ubuntu():
        pytest.skip("setup.sh runs on Ubuntu 22.04 or 24.04 only")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for tool in ("sudo", "curl", "docker", "snap", "apt-get", "git"):
        stub = bin_dir / tool
        stub.write_text(f'#!/bin/sh\necho "{tool} $*" >> "{tmp_path}/called"\nexit 1\n', "utf-8")
        stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
    home = tmp_path / "home"
    home.mkdir()
    (tmp_path / "tmp").mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith("MOMMY_") and k != "SUDO_USER"}
    env.update(PATH=f"{bin_dir}:{os.environ['PATH']}", HOME=str(home), TMPDIR=str(tmp_path / "tmp"),
               MOMMY_MIN_FREE_GB="0", MOMMY_PUBLIC_IP="129.146.10.20")
    return env


@pytest.mark.parametrize("mode", ["", "--stable"])
def test_dry_run_shows_every_step_and_changes_nothing(dry_env: dict[str, str], tmp_path: Path, mode: str) -> None:
    args = ["bash", str(SETUP), "--dry-run"] + ([mode] if mode else [])
    r = subprocess.run(args, env=dry_env, capture_output=True, text=True, timeout=120, check=False)
    out = r.stdout + r.stderr
    assert r.returncode == 0, out
    assert "setup.sh stopped" not in out and "ERROR" not in out
    for n in range(1, 10):
        assert f"==> [{n}/9] " in out
    # "sudo" in front unless this test runs as root.
    assert re.search(r"would run: (sudo )?apt-get install docker-ce docker-ce-cli containerd.io "
                     r"docker-buildx-plugin docker-compose-plugin\n", out)
    assert "would run: git clone --quiet --branch claude/laughing-goodall-h48bdw" in out
    assert re.search(r"\): (sudo )?docker compose up -d --build --remove-orphans\n", out)
    files = "compose.yaml:deploy/oracle/compose.oracle.yaml"
    if mode:
        assert f"COMPOSE_FILE={files}:deploy/oracle/compose.stable.yaml" in out
        assert f"MOMMY_PUBLIC_HOST={HOST}" in out and f"https://{HOST}/#code=<the code>" in out
    else:
        assert f"COMPOSE_FILE={files}\n" in out and "MOMMY_MODE=tunnel" in out
    # Nothing was written in the home, nothing ran for real (the stand-ins were only
    # asked to read: sudo -n, curl and docker, never apt-get or git).
    assert list((tmp_path / "home").iterdir()) == []
    called = (tmp_path / "called").read_text("utf-8").splitlines() if (tmp_path / "called").exists() else []
    assert not any(c.startswith(("apt-get", "git")) for c in called)
    assert all(c.startswith("sudo -n ") or not c.startswith("sudo") for c in called)


@pytest.mark.parametrize(("args", "message"), [
    (["--stable", "--tunnel"], "Choose --stable or --tunnel, not both."),
    (["--link", "--new-code"], "Choose one of --link and --new-code."),
    (["--link", "--stable"], "--stable goes with a full run"),
    (["--bogus"], "Unknown option: --bogus"),
])
def test_wrong_options(dry_env: dict[str, str], args: list[str], message: str) -> None:
    r = subprocess.run(["bash", str(SETUP), *args], env=dry_env, capture_output=True, text=True, timeout=60,
                       check=False)
    assert r.returncode == 1 and message in r.stderr


def test_refuses_sudo(dry_env: dict[str, str]) -> None:
    if os.geteuid() != 0:
        pytest.skip("needs to run as root")
    r = subprocess.run(["bash", str(SETUP), "--dry-run"], env={**dry_env, "SUDO_USER": "ubuntu"},
                       capture_output=True, text=True, timeout=60, check=False)
    assert r.returncode == 1 and "Run it without sudo, as ubuntu" in r.stderr


def test_link_before_setup_says_what_to_run(dry_env: dict[str, str]) -> None:
    r = subprocess.run(["bash", str(SETUP), "--link"], env=dry_env, capture_output=True, text=True, timeout=60,
                       check=False)
    assert r.returncode == 1
    assert "Mommy is not set up on this VM yet" in r.stderr and "bash ~/mommy-app/mommy/deploy/oracle/setup.sh" in r.stderr


# ---------------------------------------------------------------------------
# setup.sh: mommy/.env and the Python it runs in the app's container
# ---------------------------------------------------------------------------


def _write_env(compose_dir: Path, mode: str, host: str = "") -> str:
    r = _bash(f'COMPOSE_DIR="{compose_dir}"; ENV_FILE="$COMPOSE_DIR/.env"; MODE={mode}; PUBLIC_HOST="{host}"; '
              'DRY_RUN=0; write_env', env={"MOMMY_COMPOSE_EXTRA": ""})
    assert r.returncode == 0, r.stderr
    return (compose_dir / ".env").read_text("utf-8")


def test_env_file_keeps_other_lines_and_is_rewritten_in_place(tmp_path: Path) -> None:
    (tmp_path / ".env").write_text("# mine\nMY_SETTING=1\nMOMMY_MODE=stale\n", "utf-8")
    first = _write_env(tmp_path, "stable", HOST)
    assert first.startswith("# mine\nMY_SETTING=1\n# --- written by deploy/oracle/setup.sh: begin")
    assert "MOMMY_MODE=stale" not in first and first.count("MOMMY_MODE=") == 1
    assert f"MOMMY_PUBLIC_HOST={HOST}\n" in first
    assert _write_env(tmp_path, "stable", HOST) == first
    tunnel = _write_env(tmp_path, "tunnel")
    assert "MOMMY_PUBLIC_HOST" not in tunnel and "MOMMY_MODE=tunnel" in tunnel and "MY_SETTING=1" in tunnel
    threads = int(re.search(r"^MOMMY_ASR_THREADS=(\d+)$", tunnel, re.M).group(1))
    assert threads == min(os.cpu_count() or 1, 4)
    assert stat.S_IMODE((tmp_path / ".env").stat().st_mode) == 0o644


def _snippet(name: str) -> str:
    r = _bash(f'printf "%s" "${name}"')
    assert r.returncode == 0 and "import" in r.stdout
    return r.stdout


def _python(code: str, *args: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    base = {k: v for k, v in os.environ.items() if not k.startswith("MOMMY_")}
    return subprocess.run([sys.executable, "-c", code, *args], cwd=ROOT, capture_output=True, text=True, timeout=60,
                          env={**base, "PYTHONPATH": str(ROOT / "backend"), **env}, check=False)


def test_new_code_and_stable_link_snippets(tmp_path: Path) -> None:
    code_file = tmp_path / "access-code"
    env = {"MOMMY_ACCESS_CODE_FILE": str(code_file)}
    r = _python(_snippet("STABLE_LINK_PY"), HOST, env=env)
    assert r.returncode == 1 and "No access code yet" in r.stderr and not code_file.exists()
    r = _python(_snippet("NEW_CODE_PY"), env=env)
    assert r.returncode == 0, r.stderr
    code = code_file.read_text("ascii").strip()
    assert len(code) == CODE_LENGTH and set(code) <= set(CODE_ALPHABET)
    assert stat.S_IMODE(code_file.stat().st_mode) == 0o600
    assert code not in r.stdout + r.stderr  # the new code is only ever in the link
    r = _python(_snippet("STABLE_LINK_PY"), HOST, env=env)
    assert r.returncode == 0 and r.stdout == share_link(HOST, code) + "\n" and r.stderr == ""
    r = _python(_snippet("NEW_CODE_PY"), env={**env, "MOMMY_ACCESS_CODE": "set-elsewhere-123"})
    assert r.returncode == 1 and "MOMMY_ACCESS_CODE is set" in r.stderr
    assert code_file.read_text("ascii").strip() == code


# ---------------------------------------------------------------------------
# The compose files
# ---------------------------------------------------------------------------


def _compose(*files: Path, cwd: Path = ROOT, env: dict[str, str] | None = None,
             profiles: tuple[str, ...] = ()) -> dict[str, Any]:
    if shutil.which("docker") is None:
        pytest.skip("no docker")
    if subprocess.run(["docker", "compose", "version"], capture_output=True, timeout=60).returncode != 0:
        pytest.skip("no docker compose")
    args = ["docker", "compose"]
    for f in files:
        args += ["-f", str(f)]
    for p in profiles:
        args += ["--profile", p]
    base = {k: v for k, v in os.environ.items() if not k.startswith(("MOMMY_", "COMPOSE_"))}
    r = subprocess.run([*args, "config", "--format", "json"], cwd=cwd, env={**base, **(env or {})},
                       capture_output=True, text=True, timeout=60, check=False)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.fixture(scope="module")
def stable() -> dict[str, Any]:
    return _compose(COMPOSE, COMPOSE_ORACLE, COMPOSE_STABLE, env={"MOMMY_PUBLIC_HOST": HOST})


def test_tunnel_mode_on_oracle_differs_only_by_threads() -> None:
    laptop = _compose(COMPOSE)
    oracle = _compose(COMPOSE, COMPOSE_ORACLE)
    assert oracle["services"]["mommy"]["environment"].pop("MOMMY_ASR_THREADS") == "2"
    laptop["services"]["mommy"]["environment"].pop("MOMMY_ASR_THREADS")
    assert oracle == laptop
    threads = _compose(COMPOSE, COMPOSE_ORACLE, env={"MOMMY_ASR_THREADS": "1"})
    assert threads["services"]["mommy"]["environment"]["MOMMY_ASR_THREADS"] == "1"


def test_stable_mode_services(stable: dict[str, Any]) -> None:
    assert set(stable["services"]) == {"mommy", "caddy"}  # no quick tunnel
    with_tunnel = _compose(COMPOSE, COMPOSE_ORACLE, COMPOSE_STABLE, env={"MOMMY_PUBLIC_HOST": HOST},
                           profiles=("quick-tunnel",))
    assert set(with_tunnel["services"]) == {"mommy", "caddy", "tunnel"}


def test_stable_mode_trusts_caddy_alone(stable: dict[str, Any]) -> None:
    app, caddy = stable["services"]["mommy"], stable["services"]["caddy"]
    env = app["environment"]
    assert env["MOMMY_ALLOWED_HOSTS"] == f"localhost,127.0.0.1,{HOST}"  # an exact entry, no suffix
    assert not any(h.startswith(".") for h in parse_allowed_hosts(env["MOMMY_ALLOWED_HOSTS"]))
    caddy_ip = ipaddress.ip_address(caddy["networks"]["edge"]["ipv4_address"])
    assert env["MOMMY_FORWARDED_ALLOW_IPS"] == str(caddy_ip)
    ipam = stable["networks"]["edge"]["ipam"]["config"][0]
    subnet, dynamic = ipaddress.ip_network(ipam["subnet"]), ipaddress.ip_network(ipam["ip_range"])
    # Caddy's address is in the subnet, not the gateway's, and never given to another container.
    assert caddy_ip in subnet and caddy_ip != next(subnet.hosts()) and caddy_ip not in dynamic
    assert dynamic.subnet_of(subnet) and set(app["networks"]) == {"default", "edge"}
    assert set(caddy["networks"]) == {"edge"}
    # The rest of the app's settings are compose.yaml's.
    assert env["MOMMY_ACCESS_CODE_FILE"] == "/data/access-code"
    assert [(p["host_ip"], p["published"], p["target"]) for p in app["ports"]] == [("127.0.0.1", "8080", 7860)]


def test_caddy_service(stable: dict[str, Any]) -> None:
    caddy = stable["services"]["caddy"]
    assert re.fullmatch(r"caddy:2\.\d+\.\d+@sha256:[0-9a-f]{64}", caddy["image"])
    assert caddy["environment"]["MOMMY_PUBLIC_HOST"] == HOST
    assert sorted((p["published"], p["target"]) for p in caddy["ports"]) == [("443", 443), ("80", 80)]
    assert all("host_ip" not in p for p in caddy["ports"])  # reachable from the internet
    mounts = {m["target"]: m for m in caddy["volumes"]}
    assert mounts["/etc/caddy/Caddyfile"]["source"] == str(CADDYFILE) and mounts["/etc/caddy/Caddyfile"]["read_only"]
    assert mounts["/data"]["source"] == "caddy-data" and mounts["/config"]["source"] == "caddy-config"
    assert caddy["depends_on"] == {"mommy": {"condition": "service_healthy", "required": True, "restart": False}} \
        or caddy["depends_on"]["mommy"]["condition"] == "service_healthy"
    assert caddy["restart"] == "unless-stopped" and caddy["read_only"] is True
    assert caddy["cap_drop"] == ["ALL"] and "no-new-privileges:true" in caddy["security_opt"]
    assert caddy["logging"]["options"]["max-size"] == "10m"


def test_env_file_selects_the_files(tmp_path: Path) -> None:
    # As on the VM: mommy/.env written by setup.sh, then a plain "docker compose" in mommy/.
    shutil.copy(COMPOSE, tmp_path / "compose.yaml")
    shutil.copytree(ORACLE, tmp_path / "deploy" / "oracle")
    _write_env(tmp_path, "stable", HOST)
    assert set(_compose(cwd=tmp_path)["services"]) == {"mommy", "caddy"}
    _write_env(tmp_path, "tunnel")
    assert set(_compose(cwd=tmp_path)["services"]) == {"mommy", "tunnel"}


# ---------------------------------------------------------------------------
# The Caddyfile
# ---------------------------------------------------------------------------


def test_caddyfile() -> None:
    text = CADDYFILE.read_text("utf-8")
    body = "\n".join(line.split("#", 1)[0].rstrip() for line in text.splitlines())
    assert "\n{$MOMMY_PUBLIC_HOST} {\n" in body and "reverse_proxy mommy:7860 {" in body
    assert "protocols h1 h2" in body  # no HTTP/3: UDP 443 is not opened
    # Caddy closes an idle connection to the app before uvicorn's --timeout-keep-alive does.
    keepalive = int(re.search(r"keepalive (\d+)s", body).group(1))
    uvicorn = int(re.search(r"--timeout-keep-alive (\d+)", START.read_text("utf-8")).group(1))
    assert keepalive < uvicorn
    # No access log, and Caddy's own messages leave the visitor out.
    site = body.split("{$MOMMY_PUBLIC_HOST} {", 1)[1]
    assert not re.search(r"^\s*log\b", site, re.M)
    for field in ("request>remote_ip", "request>client_ip", "request>headers"):
        assert re.search(rf"^\s*{re.escape(field)} delete$", body, re.M)
    # The production file: Let's Encrypt, never a test CA.
    assert "local_certs" not in body and "tls internal" not in body and "acme_ca" not in body


# ---------------------------------------------------------------------------
# The guide
# ---------------------------------------------------------------------------


def _setup_defaults() -> tuple[str, str]:
    text = SETUP.read_text("utf-8")
    url = re.search(r'^readonly DEFAULT_REPO_URL="([^"]+)"', text, re.M).group(1)
    branch = re.search(r'^readonly DEFAULT_BRANCH="([^"]+)"', text, re.M).group(1)
    return url, branch


def test_guide_has_the_exact_commands() -> None:
    guide = GUIDE.read_text("utf-8")
    url, branch = _setup_defaults()
    assert f"git clone --branch {branch} {url} ~/mommy-app\n" in guide
    assert 'APP_DIR="${MOMMY_APP_DIR:-$HOME/mommy-app}"' in SETUP.read_text("utf-8")
    run = "bash ~/mommy-app/mommy/deploy/oracle/setup.sh"
    options = set(re.findall(re.escape(run) + r"( --[a-z-]+)?", guide))
    assert options == {"", " --stable", " --tunnel", " --link", " --new-code"}
    # Every option the guide shows is one setup.sh takes.
    for option in options - {""}:
        assert f"{option.strip()})" in SETUP.read_text("utf-8") or f"{option.strip()} |" in SETUP.read_text("utf-8")
    # The VM's user is not in the docker group: every docker command in a code block has sudo.
    blocks = "\n".join(re.findall(r"```(?:sh|powershell|text)?\n(.*?)```", guide, re.S))
    assert "docker" not in blocks or all("sudo docker" in line for line in blocks.splitlines() if "docker" in line)
    for inline in re.findall(r"`([^`]*docker compose[^`]*)`", guide):
        assert inline.startswith(("sudo docker compose", "cd ~/mommy-app/mommy && sudo docker compose")) \
            or inline in ("docker compose", "docker compose restart mommy",
                          "docker compose exec mommy python -m mommy.share_link --new-code"), inline
    # Connecting from Windows and from a Mac, and the two ports of the permanent link.
    for needle in ('ssh -i "$HOME\\.ssh\\mommy-oracle.key" ubuntu@', "icacls", "chmod 600 ~/.ssh/mommy-oracle.key",
                   "VM.Standard.A1.Flex", "Canonical Ubuntu 24.04", "Generate a key pair for me", "0.0.0.0/0",
                   "Destination Port Range:** `80`", "`443`", "Out of capacity"):
        assert needle in guide, needle


def test_readme_and_self_host_link_the_guide() -> None:
    for doc in (ROOT / "README.md", ROOT / "SELF_HOST.md"):
        assert "](deploy/oracle/ORACLE.md)" in doc.read_text("utf-8")
    assert "](../../SELF_HOST.md)" in GUIDE.read_text("utf-8")


def test_line_endings() -> None:
    for path in (SETUP, CADDYFILE, COMPOSE_ORACLE, COMPOSE_STABLE):
        assert b"\r" not in path.read_bytes()
    if shutil.which("git") is None:
        pytest.skip("no git")
    r = subprocess.run(["git", "check-attr", "eol", "--", *(str(p.relative_to(ROOT)) for p in
                        (SETUP, CADDYFILE, COMPOSE_ORACLE, COMPOSE_STABLE))], cwd=ROOT, capture_output=True,
                       text=True, timeout=30, check=False)
    if r.returncode != 0:
        pytest.skip("not a git checkout")
    assert r.stdout.count(": eol: lf") == 4, r.stdout


# Hard rule 6 for the kit's files (the family names spelled backwards, so that this file
# does not contain them either).
_FAMILIES = [name[::-1] for name in ("supo", "tennos", "ukiah", "elbaf", "sohtym")]


@pytest.mark.parametrize("path", [SETUP, GUIDE, COMPOSE_ORACLE, COMPOSE_STABLE, CADDYFILE, ORACLE / ".gitattributes",
                                  Path(__file__)], ids=lambda p: p.name)
def test_no_model_identifiers(path: Path) -> None:
    # The branch name (claude/laughing-goodall-...) is no model.
    text = re.sub(r"claude[/-]laughing-goodall", "", path.read_text(encoding="utf-8").lower())
    assert not re.search(r"claude[\s_-]*\d", text)
    assert not re.search(r"claude-[a-z]", text)
    for family in _FAMILIES:
        assert family not in text

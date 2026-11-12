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


def test_rules_without_ports_undoes_rules_with_ports() -> None:
    """SEC-13: --tunnel takes the two rules out of rules.v4 again, and nothing else."""
    opened = _rules(ORACLE_RULES)
    r = _bash("rules_without_ports", stdin=opened)
    assert r.returncode == 0 and r.stdout == ORACLE_RULES
    # A rule of the same text in another table is not ours.
    nat = f"*nat\n{ACCEPT_80}\nCOMMIT\n*filter\n{ACCEPT_80}\n{REJECT}\nCOMMIT\n"
    r = _bash("rules_without_ports", stdin=nat)
    assert r.stdout == f"*nat\n{ACCEPT_80}\nCOMMIT\n*filter\n{REJECT}\nCOMMIT\n"


def _stub(bin_dir: Path, name: str, body: str) -> None:
    path = bin_dir / name
    path.write_text("#!/bin/bash\n" + body + "\n", "utf-8")
    path.chmod(0o755)


# ---------------------------------------------------------------------------
# setup.sh: updates are shown and asked for (SEC-1)
# ---------------------------------------------------------------------------


def _git(cwd: Path, *args: str) -> str:
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}
    r = subprocess.run(["git", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false", *args], cwd=cwd,
                       env=env, capture_output=True, text=True, timeout=60, check=True)
    return r.stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> dict[str, Path]:
    """An "upstream" repository with the branch, and the VM's clone of it (ORACLE.md,
    step 4)."""
    if shutil.which("git") is None:
        pytest.skip("no git")
    upstream = tmp_path / "upstream"
    (upstream / "mommy" / "deploy" / "oracle").mkdir(parents=True)
    _git(tmp_path, "init", "-q", str(upstream))
    _git(upstream, "checkout", "-q", "-b", "the-branch")
    (upstream / "mommy" / "compose.yaml").write_text("services: {}\n", "utf-8")
    (upstream / "mommy" / "deploy" / "oracle" / "setup.sh").write_text("# v1\n", "utf-8")
    _git(upstream, "add", "-A")
    _git(upstream, "commit", "-q", "-m", "first version")
    app = tmp_path / "mommy-app"
    _git(tmp_path, "clone", "-q", "--branch", "the-branch", str(upstream), str(app))
    return {"upstream": upstream, "app": app}


def _push(upstream: Path, text: str, message: str, *, rewrite: bool = False) -> str:
    if rewrite:  # the fixture's branch has one commit: replaced by another one
        _git(upstream, "commit", "-q", "--amend", "-m", "rewritten first version")
    (upstream / "mommy" / "deploy" / "oracle" / "setup.sh").write_text(text, "utf-8")
    _git(upstream, "commit", "-q", "-am", message)
    return _git(upstream, "rev-parse", "HEAD")


def _update(repo: dict[str, Path], *, yes: bool = False, ref: str = "", stdin: Any = subprocess.DEVNULL,
            ) -> subprocess.CompletedProcess[str]:
    code = (f'APP_DIR="{repo["app"]}"; COMPOSE_DIR="$APP_DIR/mommy"; REPO_URL="{repo["upstream"]}"; '
            f'BRANCH=the-branch; REF="{ref}"; DRY_RUN=0; ASSUME_YES={int(yes)}; update_code; echo "UPDATED=$UPDATED"')
    script = f'source "{SETUP}"; set +eE; trap - ERR\n{code}'
    return subprocess.run(["bash", "-c", script], stdin=stdin, capture_output=True, text=True, timeout=60,
                          check=False)


def test_an_update_is_not_installed_without_asking(repo: dict[str, Path]) -> None:
    before = _git(repo["app"], "rev-parse", "HEAD")
    r = _update(repo)
    assert r.returncode == 0 and "Up to date: " in r.stdout and "UPDATED=0" in r.stdout
    new = _push(repo["upstream"], "# v2\nsudo something\n", "a new version")
    r = _update(repo)  # no terminal, no --yes
    assert r.returncode == 0, r.stderr
    assert "An update is available:" in r.stdout and '"a new version"' in r.stdout
    assert "among them some that run with full rights on this VM: deploy/oracle/setup.sh" in r.stdout
    assert "no terminal to ask in" in r.stdout and "UPDATED=0" in r.stdout
    assert _git(repo["app"], "rev-parse", "HEAD") == before
    r = _update(repo, yes=True)
    assert "Install this update? [y/N] yes (--yes)" in r.stdout and "UPDATED=1" in r.stdout
    assert _git(repo["app"], "rev-parse", "HEAD") == new
    assert _git(repo["app"], "rev-parse", "--abbrev-ref", "HEAD") == "the-branch"


def test_an_update_asks_in_a_terminal(repo: dict[str, Path]) -> None:
    import pty

    before = _git(repo["app"], "rev-parse", "HEAD")
    new = _push(repo["upstream"], "# v2\n", "a new version")
    for answer, installed in (("n\n", False), ("y\n", True)):
        master, slave = pty.openpty()
        try:
            os.write(master, answer.encode())
            r = _update(repo, stdin=slave)
        finally:
            os.close(slave)
            os.close(master)
        assert r.returncode == 0, r.stderr
        assert ("UPDATED=1" in r.stdout) is installed
        assert _git(repo["app"], "rev-parse", "HEAD") == (new if installed else before)


def test_a_rewritten_history_needs_the_word_yes(repo: dict[str, Path]) -> None:
    import pty

    before = _git(repo["app"], "rev-parse", "HEAD")
    new = _push(repo["upstream"], "# replaced\n", "replaced history", rewrite=True)
    r = _update(repo, yes=True)  # --yes does not answer this one
    assert "the branch's history was rewritten (a force-push)" in r.stderr
    assert "UPDATED=0" in r.stdout and _git(repo["app"], "rev-parse", "HEAD") == before
    master, slave = pty.openpty()
    try:
        os.write(master, b"y\n")  # not "yes"
        r = _update(repo, stdin=slave)
    finally:
        os.close(slave)
        os.close(master)
    assert "UPDATED=0" in r.stdout and _git(repo["app"], "rev-parse", "HEAD") == before
    master, slave = pty.openpty()
    try:
        os.write(master, b"yes\n")
        r = _update(repo, stdin=slave)
    finally:
        os.close(slave)
        os.close(master)
    assert "UPDATED=1" in r.stdout and _git(repo["app"], "rev-parse", "HEAD") == new


def test_a_pinned_commit_is_used_exactly(repo: dict[str, Path]) -> None:
    first = _git(repo["app"], "rev-parse", "HEAD")
    _push(repo["upstream"], "# v2\n", "a new version")
    r = _update(repo, yes=True, ref=first)
    assert "Up to date" in r.stdout and _git(repo["app"], "rev-parse", "HEAD") == first
    _git(repo["upstream"], "tag", "v-test")
    tagged = _git(repo["upstream"], "rev-parse", "HEAD")
    r = _update(repo, yes=True, ref="v-test")
    assert "UPDATED=1" in r.stdout and _git(repo["app"], "rev-parse", "HEAD") == tagged


def test_the_new_script_runs_only_after_an_installed_update() -> None:
    text = SETUP.read_text("utf-8")
    assert "(( DRY_RUN || NO_UPDATE || ! UPDATED )) && return 0" in text
    # The update is fetched into FETCH_HEAD, never forced over a branch.
    assert "+refs/heads/" not in text


# ---------------------------------------------------------------------------
# setup.sh: the permanent link's host (SEC-3, SEC-11)
# ---------------------------------------------------------------------------


def _with_curl(tmp_path: Path, answers: dict[str, str]) -> dict[str, str]:
    """PATH with a curl that answers the echo services from ``answers`` (others fail)."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    cases = "".join(f'    *"{url}"*) echo "{ip}"; exit 0 ;;\n' for url, ip in answers.items())
    _stub(bin_dir, "curl", f'case "$*" in\n{cases}    *) exit 7 ;;\nesac')
    return {"PATH": f"{bin_dir}:{os.environ['PATH']}"}


@pytest.mark.parametrize(("answers", "expected"), [
    ({"checkip.amazonaws.com": "129.146.10.20", "api.ipify.org": "129.146.10.20"}, "129.146.10.20"),
    ({"checkip.amazonaws.com": "198.51.100.77", "api.ipify.org": "129.146.10.20",
      "ipv4.icanhazip.com": "129.146.10.20"}, "129.146.10.20"),
    ({"checkip.amazonaws.com": "129.146.10.20"}, None),  # one answer is not enough
    ({"checkip.amazonaws.com": "129.146.10.20", "api.ipify.org": "129.146.10.21"}, None),
    ({}, None),
])
def test_the_public_address_needs_two_sources(tmp_path: Path, answers: dict[str, str], expected: str | None) -> None:
    env = _with_curl(tmp_path, {f"https://{k}": v for k, v in answers.items()})
    r = _bash('unset MOMMY_PUBLIC_IP; find_public_ip; echo "IP=$PUBLIC_IP FROM=$PUBLIC_IP_SOURCE"', env=env)
    if expected is None:
        assert r.returncode == 1 and "IP=" not in r.stdout
        assert "MOMMY_PUBLIC_IP=203.0.113.10" in r.stderr
        if len(answers) > 1:
            assert "did not agree" in r.stderr
        if len(answers) == 1:
            assert "Only one of the services" in r.stderr and "did not agree" not in r.stderr
    else:
        assert r.returncode == 0 and f"IP={expected} FROM=" in r.stdout and " and " in r.stdout


def _configure(tmp_path: Path, env_lines: str, host: str) -> subprocess.CompletedProcess[str]:
    compose_dir = tmp_path / "mommy"
    compose_dir.mkdir(exist_ok=True)
    (compose_dir / ".env").write_text(env_lines, "utf-8")
    code = (f'COMPOSE_DIR="{compose_dir}"; ENV_FILE="$COMPOSE_DIR/.env"; DRY_RUN=0; OPT_MODE=stable; '
            'open_web_ports() { :; }; close_web_ports() { :; }; configure; echo "ROTATE_CODE=$ROTATE_CODE"')
    return _bash(code, env={"MOMMY_PUBLIC_HOST": host, "MOMMY_COMPOSE_EXTRA": ""})


def test_a_new_permanent_host_changes_the_code(tmp_path: Path) -> None:
    """SEC-3: the old link holds the code and leads to an address Oracle may give to
    someone else: the code changes with the host."""
    r = _configure(tmp_path, "", HOST)
    assert "ROTATE_CODE=0" in r.stdout  # the first --stable
    r = _configure(tmp_path, (tmp_path / "mommy" / ".env").read_text("utf-8"), HOST)
    assert "ROTATE_CODE=0" in r.stdout  # the same host again
    r = _configure(tmp_path, (tmp_path / "mommy" / ".env").read_text("utf-8"), "129-146-10-21.sslip.io")
    assert "ROTATE_CODE=1" in r.stdout and "the access code changes too" in r.stderr
    # Through the tunnel mode in between: the last permanent host is remembered.
    tunnel = _write_env(tmp_path / "mommy", "tunnel")
    assert "MOMMY_LAST_PUBLIC_HOST=129-146-10-21.sslip.io" in tunnel and "MOMMY_PUBLIC_HOST=" not in tunnel
    r = _configure(tmp_path, tunnel, "129-146-10-22.sslip.io")
    assert "ROTATE_CODE=1" in r.stdout
    assert "do_setup" in SETUP.read_text("utf-8") and "if (( ROTATE_CODE )); then" in SETUP.read_text("utf-8")


def test_the_link_is_held_back_without_https(tmp_path: Path) -> None:
    """SEC-11: the code is printed in a permanent link only once that address answers
    HTTPS from this VM with a valid certificate."""
    def link(https_ok: int, answers: dict[str, str]) -> subprocess.CompletedProcess[str]:
        return _bash(f'DRY_RUN=0; MODE=stable; PUBLIC_HOST={HOST}; HTTPS_OK={https_ok}; '
                     'dc() { echo "DC $*"; }; print_link; echo "STATUS=$?"', env=_with_curl(tmp_path, answers))

    for https_ok in (0, 1):
        r = link(https_ok, {})
        assert "STATUS=4" in r.stdout and "The link is not shown yet" in r.stdout
        assert "DC " not in r.stdout and "#code=" not in r.stdout
    works = {f"https://{HOST}/access.html": ""}  # the check from the VM succeeds
    r = link(0, works)  # but the setup's own check failed a moment ago: still held back
    assert "STATUS=4" in r.stdout and "DC " not in r.stdout
    r = link(1, works)
    assert "STATUS=0" in r.stdout and "Your link to share" in r.stdout and "DC exec -T mommy python -c" in r.stdout


# ---------------------------------------------------------------------------
# setup.sh: the swap file (SEC-12) and apt's locks (R5)
# ---------------------------------------------------------------------------


@pytest.fixture
def swap_env(tmp_path: Path) -> dict[str, str]:
    """Stand-ins for swapon, mkswap and blkid: a file is a swap area when it starts with
    SWAP; everything they are asked is written to tmp_path/called."""
    if os.geteuid() != 0:
        pytest.skip("runs as root (as_root without sudo)")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "called"
    _stub(bin_dir, "swapon", f'echo "swapon $*" >> "{log}"; [[ "$1" == --show* ]] && exit 0; '
                             '[[ "$(head -c 4 "$1")" == SWAP ]]')
    _stub(bin_dir, "mkswap", f'echo "mkswap $*" >> "{log}"; printf SWAP > "$1"')
    _stub(bin_dir, "blkid", f'echo "blkid $*" >> "{log}"; f="${{@: -1}}"; [[ "$(head -c 4 "$f")" == SWAP ]] && echo swap')
    _stub(bin_dir, "fallocate", f'echo "fallocate $*" >> "{log}"')
    return {"PATH": f"{bin_dir}:{os.environ['PATH']}"}


def _swap(tmp_path: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    code = (f'SWAP_FILE="{tmp_path}/swapfile"; STATE_DIR="{tmp_path}/state"; SUDO=""; DRY_RUN=0; SWAP_GB=0; '
            f'MIN_FREE_GB=0; grep() {{ [[ "$*" == *fstab* ]] && return 0; command grep "$@"; }}; ensure_swap')
    return _bash(code, env=env)


def test_a_swap_file_that_is_not_ours_is_left_alone(tmp_path: Path, swap_env: dict[str, str]) -> None:
    data = tmp_path / "swapfile"
    data.write_text("someone's data\n", "utf-8")
    data.chmod(0o644)
    r = _swap(tmp_path, swap_env)
    assert r.returncode == 0 and "this setup did not make it: left as it is" in r.stderr
    assert data.read_text("utf-8") == "someone's data\n" and stat.S_IMODE(data.stat().st_mode) == 0o644
    called = (tmp_path / "called").read_text("utf-8")
    assert "mkswap" not in called and "swapon " + str(data) not in called
    # A symbolic link is never followed.
    data.unlink()
    target = tmp_path / "elsewhere"
    target.write_text("x", "utf-8")
    data.symlink_to(target)
    r = _swap(tmp_path, swap_env)
    assert "is not a plain file" in r.stderr and target.read_text("utf-8") == "x"


def test_an_existing_swap_area_or_our_own_file_is_used(tmp_path: Path, swap_env: dict[str, str]) -> None:
    swap = tmp_path / "swapfile"
    swap.write_text("SWAP-ready", "utf-8")
    swap.chmod(0o666)
    r = _swap(tmp_path, swap_env)
    assert r.returncode == 0 and "Turning on the existing" in r.stdout
    assert stat.S_IMODE(swap.stat().st_mode) == 0o600 and swap.stat().st_uid == 0
    assert "mkswap" not in (tmp_path / "called").read_text("utf-8")
    # One this setup made and could not finish (its marker is there): finished.
    swap.write_text("half made", "utf-8")
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "swapfile-made").touch()
    r = _swap(tmp_path, swap_env)
    assert r.returncode == 0 and "Finishing the swap file" in r.stdout and swap.read_text("utf-8") == "SWAP"
    # A new one: made, with the marker first.
    swap.unlink()
    (tmp_path / "state" / "swapfile-made").unlink()
    r = _swap(tmp_path, swap_env)
    assert r.returncode == 0 and "Making a 0 GB swap file" in r.stdout
    assert (tmp_path / "state" / "swapfile-made").exists() and swap.read_text("utf-8") == "SWAP"


def test_apt_waits_for_the_package_lists_lock(tmp_path: Path) -> None:
    """R5: apt-get update fails at once while another apt holds the lists' lock
    (DPkg::Lock::Timeout covers dpkg's locks only): setup.sh waits and tries again."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    count = tmp_path / "count"
    _stub(bin_dir, "apt-get", f'n=$(cat "{count}" 2>/dev/null || echo 0); echo $((n + 1)) > "{count}"; '
                              'if (( n < 2 )); then echo "E: Could not get lock /var/lib/apt/lists/lock. It is held by '
                              'process 7 (python3)" >&2; exit 100; fi; echo "Reading package lists..."')
    env = {"PATH": f"{bin_dir}:{os.environ['PATH']}"}
    r = _bash('SUDO=""; DRY_RUN=0; APT_LOCK_SLEEP=0; apt_get update; echo "STATUS=$?"', env=env)
    assert "STATUS=0" in r.stdout and count.read_text("utf-8").strip() == "3", r.stdout + r.stderr
    assert r.stdout.count("Ubuntu is updating its package lists") == 1
    # Another failure is not waited for.
    count.write_text("5", "utf-8")
    _stub(bin_dir, "apt-get", 'echo "E: Unable to locate package nothing" >&2; exit 100')
    r = _bash('SUDO=""; DRY_RUN=0; APT_LOCK_SLEEP=0; apt_get install nothing; echo "STATUS=$?"', env=env)
    assert r.returncode == 1 and "Unable to locate package" in r.stderr and "updating its package lists" not in r.stdout


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
    assert set(stable["services"]) == {"mommy", "caddy", "caddy-volumes"}  # no quick tunnel
    with_tunnel = _compose(COMPOSE, COMPOSE_ORACLE, COMPOSE_STABLE, env={"MOMMY_PUBLIC_HOST": HOST},
                           profiles=("quick-tunnel",))
    assert set(with_tunnel["services"]) == {"mommy", "caddy", "caddy-volumes", "tunnel"}


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
    # Not root (SEC-9); its volumes are given to that user first, by a one-shot service.
    assert caddy["user"] == "65532:65532"
    assert caddy["depends_on"]["caddy-volumes"]["condition"] == "service_completed_successfully"
    init = stable["services"]["caddy-volumes"]
    assert init["image"] == caddy["image"] and init["user"] == "0:0" and init["network_mode"] == "none"
    assert init["cap_drop"] == ["ALL"] and init["cap_add"] == ["CHOWN"] and init["read_only"] is True
    assert init["restart"] == "no" and "no-new-privileges:true" in init["security_opt"]
    assert {m["target"]: m["source"] for m in init["volumes"]} == {"/data": "caddy-data", "/config": "caddy-config"}
    script = init["command"][-1].replace("$$", "$")
    assert init["command"][:2] == ["sh", "-c"] and "chown -R -h 65532:65532" in script
    assert '[ "$(stat -c %u:%g "$d")" = 65532:65532 ] ||' in script  # nothing to do the second time


def test_env_file_selects_the_files(tmp_path: Path) -> None:
    # As on the VM: mommy/.env written by setup.sh, then a plain "docker compose" in mommy/.
    shutil.copy(COMPOSE, tmp_path / "compose.yaml")
    shutil.copytree(ORACLE, tmp_path / "deploy" / "oracle")
    _write_env(tmp_path, "stable", HOST)
    assert set(_compose(cwd=tmp_path)["services"]) == {"mommy", "caddy", "caddy-volumes"}
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
    assert re.search(r"^\tadmin off$", body, re.M)  # no admin API (SEC-9)
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

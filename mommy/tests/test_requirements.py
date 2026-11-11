"""The dependency pins: requirements.txt (direct) and requirements.lock (all, hashed).

Offline: the lock is compared with what is installed in this environment (the versions
the suite runs on); scripts/lock_requirements.py --check also compares the hashes with
PyPI, which needs the network.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parent.parent


def _lock_tool():
    spec = importlib.util.spec_from_file_location("lock_requirements", ROOT / "scripts" / "lock_requirements.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _lock_entries() -> dict[str, tuple[str, list[str]]]:
    text = (ROOT / "requirements.lock").read_text(encoding="utf-8")
    entries: dict[str, tuple[str, list[str]]] = {}
    for block in re.split(r"\n(?=[a-z0-9])", text.split("\n\n", 1)[1].strip()):
        name, version = block.split(" ", 1)[0].split("==")
        entries[name] = (version, re.findall(r"--hash=sha256:([0-9a-f]{64})", block))
    return entries


def test_every_package_is_pinned_and_hashed() -> None:
    # Regression: only the 12 direct dependencies were pinned, none hashed, so a fresh
    # install could resolve the TLS and audio-decoding stack to untested versions.
    entries = _lock_entries()
    assert len(entries) >= 30
    for name, (version, digests) in entries.items():
        assert re.fullmatch(r"[0-9][0-9A-Za-z.+!-]*", version), name
        assert digests, f"{name} has no hash"


def test_lock_matches_the_installed_closure_of_requirements_txt() -> None:
    tool = _lock_tool()
    direct = tool.direct_requirements()
    installed = tool.closure(direct)
    entries = _lock_entries()
    assert {n: v for n, (v, _) in entries.items()} == installed
    for req in direct:
        assert entries[canonicalize_name(req.name)][0] in req.specifier


def test_uvicorn_extras_are_not_installed_by_the_lock() -> None:
    names = {Requirement(line.split("#")[0]).name for line in (ROOT / "requirements.txt").read_text().splitlines()
             if line.split("#")[0].strip()}
    assert "uvicorn" in names
    assert "[" not in (ROOT / "requirements.txt").read_text().split("uvicorn", 1)[1].split("\n", 1)[0]
    assert not {"uvloop", "httptools", "websockets", "watchfiles", "pyyaml", "python-dotenv"} & set(_lock_entries())

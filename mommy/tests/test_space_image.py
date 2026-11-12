"""The files of the container image (README.md, "Run it online"): the start script, the
model download and the Dockerfile.

``scripts/space_start.sh`` runs here with a stand-in ``uvicorn`` on ``PATH`` that only
prints what it was given; ``scripts/download_models.sh`` runs on a copy whose download
address is a local directory of made-up archives (``file://``), so nothing goes to the
network.
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
START = ROOT / "scripts" / "space_start.sh"
DOWNLOAD = ROOT / "scripts" / "download_models.sh"
DOCKERFILE = ROOT / "Dockerfile"
CODE = "k7m2p9q4r8s3"
#: Blank to Python's str.strip(), though not to a shell's ' \t\r\n' (SEC-1).
BLANKS = ["", " ", "\t\n", " ", "\x0b", "\x0c", "\x1f", " ", "　"]


# ---------------------------------------------------------------------------
# scripts/space_start.sh
# ---------------------------------------------------------------------------


@pytest.fixture
def start_env(tmp_path: Path) -> dict[str, str]:
    """An environment whose PATH has this Python as ``python`` and a stand-in ``uvicorn``."""
    if shutil.which("sh") is None:
        pytest.skip("no sh")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "python").symlink_to(sys.executable)
    fake = bin_dir / "uvicorn"
    fake.write_text('#!/bin/sh\necho "UVICORN $*"\necho "HOSTS=$MOMMY_ALLOWED_HOSTS"\n', encoding="utf-8")
    fake.chmod(0o755)
    env = {
        "PATH": f"{bin_dir}{os.pathsep}/usr/bin{os.pathsep}/bin",
        "PYTHONPATH": str(ROOT / "backend"),
        "HOME": str(tmp_path),
    }
    return env


def run_start(env: dict[str, str], **extra: str) -> subprocess.CompletedProcess[str]:
    full = dict(env)
    full.update(extra)
    return subprocess.run(["sh", str(START)], env=full, capture_output=True, text=True, timeout=60, check=False)


@pytest.mark.parametrize("blank", [None, *BLANKS])
def test_start_refuses_without_a_usable_code(start_env: dict[str, str], blank: str | None) -> None:
    """SEC-1: the image never serves the app on all interfaces without the gate, also when
    the secret holds only white space a shell would not strip (a no-break space...)."""
    extra = {"SPACE_HOST": "someone-mommy.hf.space"}
    if blank is not None:
        extra["MOMMY_ACCESS_CODE"] = blank
    r = run_start(start_env, **extra)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "UVICORN" not in r.stdout
    assert "MOMMY_ACCESS_CODE is not set" in r.stderr and "refusing to serve" in r.stderr


def test_start_cannot_be_talked_out_of_the_requirement(start_env: dict[str, str]) -> None:
    for value in ("", " ", "0"):
        r = run_start(start_env, MOMMY_REQUIRE_ACCESS_CODE=value, MOMMY_ACCESS_CODE=" ")
        assert r.returncode == 1 and "UVICORN" not in r.stdout


def test_start_refuses_a_short_code_without_printing_it(start_env: dict[str, str]) -> None:
    r = run_start(start_env, MOMMY_ACCESS_CODE="abc12")
    assert r.returncode == 1 and "UVICORN" not in r.stdout
    assert "at least 8 characters" in r.stderr and "abc12" not in r.stdout + r.stderr


def test_start_runs_uvicorn_behind_the_proxy(start_env: dict[str, str]) -> None:
    r = run_start(start_env, MOMMY_ACCESS_CODE=CODE, SPACE_HOST="Someone-Mommy.hf.space",
                  MOMMY_ALLOWED_HOSTS="someone-mommy.hf.space")
    assert r.returncode == 0, r.stderr
    assert CODE not in r.stdout + r.stderr
    args = re.search(r"^UVICORN (.*)$", r.stdout, flags=re.M).group(1).split()
    assert args[:3] == ["mommy.app:build_default_app", "--factory", "--host"]
    assert args[args.index("--port") + 1] == "7860" and args[args.index("--host") + 1] == "0.0.0.0"
    assert "--proxy-headers" in args and "--no-access-log" in args
    assert args[args.index("--timeout-keep-alive") + 1] == "75"  # OPS-13
    # SEC-2: only the proxy's private networks are trusted, never '*'.
    trusted = args[args.index("--forwarded-allow-ips") + 1].split(",")
    assert "*" not in trusted and "10.0.0.0/8" in trusted and "fc00::/7" in trusted
    assert trusted == re.search(r"^TRUSTED_PROXIES='([^']+)'$", START.read_text("utf-8"), flags=re.M).group(1).split(",")
    # OPS-9: SPACE_HOST is always one of the allowed hosts.
    assert "HOSTS=someone-mommy.hf.space,Someone-Mommy.hf.space" in r.stdout
    assert "access gate on; answering to someone-mommy.hf.space" in r.stderr


def test_start_space_host_is_added_to_another_host(start_env: dict[str, str]) -> None:
    r = run_start(start_env, MOMMY_ACCESS_CODE=CODE, SPACE_HOST="new-name.hf.space", MOMMY_ALLOWED_HOSTS="old-name.hf.space")
    assert r.returncode == 0
    assert "answering to old-name.hf.space, new-name.hf.space" in r.stderr
    r = run_start(start_env, MOMMY_ACCESS_CODE=CODE)  # a local docker run: the default hosts
    assert r.returncode == 0 and "answering to 127.0.0.1, localhost, ::1" in r.stderr


def test_start_proxy_networks_can_be_replaced(start_env: dict[str, str]) -> None:
    r = run_start(start_env, MOMMY_ACCESS_CODE=CODE, MOMMY_FORWARDED_ALLOW_IPS="192.0.2.0/24")
    assert r.returncode == 0
    assert "--forwarded-allow-ips 192.0.2.0/24 " in r.stdout


# ---------------------------------------------------------------------------
# scripts/download_models.sh
# ---------------------------------------------------------------------------


def _model_table() -> list[tuple[str, str, str, list[str]]]:
    text = DOWNLOAD.read_text("utf-8")
    rows = re.findall(r'^\s*(?:models\+=\()?"([^"|]+)\|([^"|]+)\|([^"|]*)\|([^"]+)"\)?$', text, flags=re.M)
    return [(name, tag, sha, files.split()) for name, tag, sha, files in rows]


def test_every_model_archive_has_a_pinned_sha256() -> None:
    """SEC-4: the archives are checked before they are unpacked."""
    rows = _model_table()
    assert {name for name, *_ in rows} == {
        "sherpa-onnx-whisper-turbo", "sherpa-onnx-whisper-small", "vits-piper-ar_JO-kareem-medium",
        "vits-piper-en_US-lessac-medium", "vits-piper-fr_FR-siwis-medium",
    }
    for name, _tag, sha, files in rows:
        assert re.fullmatch(r"[0-9a-f]{64}", sha), name
        assert files, name
    text = DOWNLOAD.read_text("utf-8")
    assert text.index('if [[ "$actual" != "$sha" ]]') < text.index("tar -xjf")


def _fake_archive(directory: Path, name: str, files: list[str], payload: bytes) -> Path:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tar:
        for rel in files:
            data = payload + rel.encode()
            info = tarfile.TarInfo(f"{name}/{rel}/x" if rel == "espeak-ng-data" else f"{name}/{rel}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    path = directory / f"{name}.tar.bz2"
    path.write_bytes(buf.getvalue())
    return path


@pytest.fixture
def download_copy(tmp_path: Path) -> tuple[Path, Path, list[tuple[str, str, str, list[str]]]]:
    """A copy of the script in tmp/scripts/ whose BASE is a local directory holding a
    made-up archive for every model; returns (script, archive directory, table)."""
    for tool in ("bash", "curl", "tar", "bzip2"):
        if shutil.which(tool) is None:
            pytest.skip(f"no {tool}")
    if shutil.which("sha256sum") is None and shutil.which("shasum") is None:
        pytest.skip("no sha256sum")
    served = tmp_path / "served"
    rows = _model_table()
    for name, tag, _sha, files in rows:
        (served / tag).mkdir(parents=True, exist_ok=True)
        _fake_archive(served / tag, name, files, b"not the real model ")
    (tmp_path / "root" / "scripts").mkdir(parents=True)
    script = tmp_path / "root" / "scripts" / "download_models.sh"
    text = DOWNLOAD.read_text("utf-8")
    text = text.replace('BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download"', f'BASE="file://{served}"')
    assert f"file://{served}" in text
    script.write_text(text, encoding="utf-8")
    return script, served, rows


def test_download_refuses_an_archive_that_differs(download_copy: tuple[Path, Path, list]) -> None:
    """SEC-4: a replaced release file is not unpacked, and nothing of it is kept."""
    script, _served, rows = download_copy
    r = subprocess.run(["bash", str(script), "--small"], capture_output=True, text=True, timeout=120, check=False)
    assert r.returncode == 1, r.stdout + r.stderr
    models = script.parent.parent / "models"
    assert sorted(p.name for p in models.iterdir()) == []  # no model, no partial download
    for name, _tag, sha, _files in rows:
        assert f"checksum mismatch for {name}: expected sha256 {sha}" in r.stderr


def test_download_installs_an_archive_that_matches(download_copy: tuple[Path, Path, list]) -> None:
    script, served, rows = download_copy
    import hashlib

    text = script.read_text("utf-8")
    for name, tag, sha, _files in rows:
        real = hashlib.sha256((served / tag / f"{name}.tar.bz2").read_bytes()).hexdigest()
        text = text.replace(sha, real)
    script.write_text(text, encoding="utf-8")
    r = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=120, check=False)
    assert r.returncode == 0, r.stdout + r.stderr
    models = script.parent.parent / "models"
    assert sorted(p.name for p in models.iterdir()) == sorted(n for n, *_ in rows if n != "sherpa-onnx-whisper-small")
    r = subprocess.run(["bash", str(script)], capture_output=True, text=True, timeout=120, check=False)
    assert r.returncode == 0 and r.stdout.count("skip  ") == 4


# ---------------------------------------------------------------------------
# Dockerfile
# ---------------------------------------------------------------------------


def test_dockerfile_pins_the_base_and_requires_the_code() -> None:
    text = DOCKERFILE.read_text("utf-8")
    assert re.search(r"^ARG PYTHON_IMAGE=python:3\.13-slim@sha256:[0-9a-f]{64}$", text, flags=re.M)  # SEC-4
    env = re.search(r"^ENV (.*?)\n(?!    )", text, flags=re.M | re.S).group(1)
    assert "MOMMY_REQUIRE_ACCESS_CODE=1" in env  # SEC-1
    assert "MOMMY_ACCESS_CODE=" not in env.replace("MOMMY_REQUIRE_ACCESS_CODE=", "")
    runtime = text.split("FROM ${PYTHON_IMAGE}\n", 1)[1]
    assert "download_models.sh" not in re.sub(r"#.*", "", runtime)  # SEC-10: only the start script
    assert 'CMD ["sh", "/home/user/app/scripts/space_start.sh"]' in runtime
    assert "USER 1000:1000" in runtime

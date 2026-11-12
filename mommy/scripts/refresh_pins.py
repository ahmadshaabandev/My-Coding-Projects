#!/usr/bin/env python3
"""Show, or move, the container images Mommy pins by digest.

    python3 scripts/refresh_pins.py                 # each pin, and what its tag is now
    python3 scripts/refresh_pins.py --write         # move each pin to its tag's digest now
    python3 scripts/refresh_pins.py --write cloudflared=2026.12.0 caddy=2.12.0
                                                    # move to newer tags (then build, test)

The images are pinned as ``<name>:<tag>@sha256:<digest>`` (the digest of the tag's
multi-platform index), so every install gets the same bytes; but a pin never moves by
itself, so the internet-facing programs (cloudflared, Caddy) would never get a security
fix. This script is how they move: for each pin it asks the registry
(``docker buildx imagetools inspect``) for the tag's index, checks that it lists both
``linux/amd64`` and ``linux/arm64`` (Windows and Intel Macs, Apple Silicon and Oracle's
Ampere VMs), and with ``--write`` puts the new tag and digest in the file. Then build
and test again (README.md), and publish the new files: an owner gets them with an update
(SELF_HOST.md, ORACLE.md). ``share_link`` notes a cloudflared more than nine months old.

The pins (one each, in one file each):

* ``cloudflared``: ``compose.yaml`` (the quick tunnel);
* ``caddy``: ``deploy/oracle/compose.stable.yaml`` (the Oracle VM's permanent link; one
  YAML anchor that both of its Caddy services use);
* ``python``: the ``Dockerfile``'s ``PYTHON_IMAGE`` (the app's base image).

A development tool (it needs Docker with buildx and the network); the app never runs it.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
#: The platforms every pinned index must list.
REQUIRED_PLATFORMS = ("linux/amd64", "linux/arm64")


@dataclass(frozen=True)
class Pin:
    key: str  # the name on the command line
    file: str  # relative to the repository root
    image: str  # the image's name, as written before ":<tag>"


PINS = (
    Pin("cloudflared", "compose.yaml", "cloudflare/cloudflared"),
    Pin("caddy", "deploy/oracle/compose.stable.yaml", "caddy"),
    Pin("python", "Dockerfile", "python"),
)


def pin_pattern(image: str) -> re.Pattern[str]:
    """``<image>:<tag>@sha256:<digest>``, not preceded by another name's characters
    (``caddy`` is not ``library/caddy`` or ``mycaddy``)."""
    return re.compile(
        r"(?<![\w./-])" + re.escape(image) + r":(?P<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})@sha256:(?P<digest>[0-9a-f]{64})"
    )


def find_pin(text: str, pin: Pin) -> re.Match[str]:
    """The one pin of ``pin.image`` in ``text``; ValueError when there is none or more."""
    found = list(pin_pattern(pin.image).finditer(text))
    if len(found) != 1:
        raise ValueError(f"{pin.file}: {len(found)} pins of {pin.image} (one is expected)")
    return found[0]


def platforms_of(manifest: dict) -> set[str]:
    """``os/architecture`` of every image an index lists (attestations left out)."""
    found: set[str] = set()
    for entry in manifest.get("manifests") or []:
        platform = entry.get("platform") or {}
        os_name, arch = platform.get("os"), platform.get("architecture")
        if os_name and arch and os_name != "unknown":
            found.add(f"{os_name}/{arch}")
    return found


def inspect(reference: str) -> tuple[str, set[str]]:
    """(the index digest, its platforms) of ``reference`` (``name:tag``), from the registry."""
    r = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", reference, "--format", "{{json .Manifest}}"],
        capture_output=True, text=True, timeout=120, check=False,
    )
    if r.returncode != 0:
        raise RuntimeError(f"docker buildx imagetools inspect {reference}: {r.stderr.strip() or r.stdout.strip()}")
    manifest = json.loads(r.stdout)
    digest = str(manifest.get("digest", ""))
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise RuntimeError(f"{reference}: no index digest in the registry's answer")
    return digest.split(":", 1)[1], platforms_of(manifest)


def refresh(
    root: Path,
    tags: dict[str, str],
    *,
    write: bool,
    inspector: Callable[[str], tuple[str, set[str]]] = inspect,
    out: Callable[[str], None] = print,
) -> int:
    """Report (and with ``write``, apply) each pin's move; returns the exit status: 0, or
    1 when an image lacks a required platform or cannot be inspected (nothing is written
    for it)."""
    status = 0
    for pin in PINS:
        path = root / pin.file
        text = path.read_text("utf-8")
        match = find_pin(text, pin)
        old_tag, old_digest = match.group("tag"), match.group("digest")
        tag = tags.get(pin.key, old_tag)
        reference = f"{pin.image}:{tag}"
        try:
            digest, platforms = inspector(reference)
        except (RuntimeError, ValueError, OSError) as exc:
            out(f"{pin.key}: cannot inspect {reference}: {exc}")
            status = 1
            continue
        missing = [p for p in REQUIRED_PLATFORMS if p not in platforms]
        if missing:
            out(f"{pin.key}: {reference} lacks {', '.join(missing)}: not used")
            status = 1
            continue
        if (tag, digest) == (old_tag, old_digest):
            out(f"{pin.key}: {reference}@sha256:{digest[:12]}... is current ({pin.file})")
            continue
        new = f"{pin.image}:{tag}@sha256:{digest}"
        out(f"{pin.key}: {pin.image}:{old_tag}@sha256:{old_digest[:12]}... -> {tag}@sha256:{digest[:12]}... ({pin.file})")
        if write:
            text = text[: match.start()] + new + text[match.end() :]
            if old_tag != tag:
                # The version named in the comments next to the pin ("cloudflared 2026.10.7").
                text = re.sub(rf"(?<![\w.]){re.escape(old_tag)}(?![\w.])", tag, text)
            path.write_text(text, "utf-8")
    if not write:
        out("(nothing written: --write applies the moves above)")
    return status


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--write", action="store_true", help="write the new tags and digests")
    parser.add_argument("tags", nargs="*", metavar="NAME=TAG", help="a newer tag for a pin: " + ", ".join(p.key for p in PINS))
    args = parser.parse_args(argv)
    tags: dict[str, str] = {}
    for item in args.tags:
        key, sep, tag = item.partition("=")
        if not sep or key not in {p.key for p in PINS} or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", tag):
            parser.error(f"not NAME=TAG with NAME one of {', '.join(p.key for p in PINS)}: {item}")
        tags[key] = tag
    return refresh(ROOT, tags, write=args.write)


if __name__ == "__main__":  # pragma: no cover - the command line
    sys.exit(main())

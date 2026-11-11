"""Pytest configuration: make ``mommy/backend`` importable as the ``mommy`` package."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

MOMMY_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = MOMMY_ROOT / "backend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))


@pytest.fixture(scope="session")
def mommy_root() -> Path:
    """The ``mommy/`` project directory."""
    return MOMMY_ROOT


@pytest.fixture(scope="session")
def quran_dir() -> Path:
    """The directory holding the verbatim Tanzil files (read-only)."""
    return MOMMY_ROOT / "data" / "quran"

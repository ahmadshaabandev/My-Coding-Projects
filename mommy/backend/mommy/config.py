"""Application settings, read once from environment variables.

Environment variables:

* ``MOMMY_ASR_MODEL``: ``"small"`` (default) or ``"turbo"``, the local Whisper model;
* ``MOMMY_ASR_THREADS``: CPU threads for speech recognition (default 4);
* ``ANTHROPIC_API_KEY``: only its presence is recorded, the value never leaves the
  environment (the SDK reads it itself);
* ``MOMMY_VISION_MODEL`` / ``MOMMY_TEXT_MODEL``: the Claude models for reading images and
  for text. Model names are configured here only, never written in the repository;
* ``MOMMY_EFFORT``: the effort level sent with Claude requests (default ``"low"``).

When the key or either model is missing, the app runs offline (see ``Settings.claude_configured``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

ASR_MODELS: tuple[str, ...] = ("small", "turbo")
EFFORT_LEVELS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")

DEFAULT_ASR_MODEL = "small"
DEFAULT_ASR_THREADS = 4
DEFAULT_EFFORT = "low"

#: The ``mommy/`` directory: ``mommy/backend/mommy/config.py`` -> ``mommy/``.
DEFAULT_ROOT = Path(__file__).resolve().parent.parent.parent


@dataclass(frozen=True)
class Settings:
    """Paths and options of one running app (immutable)."""

    root: Path  # the mommy/ directory
    models_dir: Path  # root/"models"
    quran_dir: Path  # root/"data"/"quran"
    web_dir: Path  # root/"web"
    asr_model: str  # "small" or "turbo"; env MOMMY_ASR_MODEL, default "small"
    asr_threads: int  # env MOMMY_ASR_THREADS, default 4
    anthropic_api_key_set: bool
    vision_model: str | None  # env MOMMY_VISION_MODEL
    text_model: str | None  # env MOMMY_TEXT_MODEL
    effort: str  # env MOMMY_EFFORT, default "low"

    @property
    def claude_configured(self) -> bool:
        """True when the API key and both model names are set (otherwise run offline)."""
        return self.anthropic_api_key_set and bool(self.vision_model) and bool(self.text_model)


def _get(env: Mapping[str, str], name: str) -> str | None:
    """The stripped value of ``name``, or None when it is unset or blank."""
    value = env.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def load_settings(root: Path | None = None) -> Settings:
    """Build :class:`Settings` from the environment.

    ``root`` is the ``mommy/`` directory (default: the one this package lives in); the
    models, Quran data and web directories are derived from it. Variables are read from
    ``os.environ`` at call time.

    Blank variables count as unset. Raises ValueError for an unknown ASR model, a thread
    count that is not a positive integer, or an unknown effort level.
    """
    env = os.environ
    base = Path(root).resolve() if root is not None else DEFAULT_ROOT

    asr_model = (_get(env, "MOMMY_ASR_MODEL") or DEFAULT_ASR_MODEL).lower()
    if asr_model not in ASR_MODELS:
        raise ValueError(f"MOMMY_ASR_MODEL must be one of {', '.join(ASR_MODELS)}, got {asr_model!r}")

    threads_raw = _get(env, "MOMMY_ASR_THREADS")
    if threads_raw is None:
        asr_threads = DEFAULT_ASR_THREADS
    else:
        try:
            asr_threads = int(threads_raw)
        except ValueError:
            raise ValueError(f"MOMMY_ASR_THREADS must be an integer, got {threads_raw!r}") from None
        if asr_threads < 1:
            raise ValueError(f"MOMMY_ASR_THREADS must be at least 1, got {asr_threads}")

    effort = (_get(env, "MOMMY_EFFORT") or DEFAULT_EFFORT).lower()
    if effort not in EFFORT_LEVELS:
        raise ValueError(f"MOMMY_EFFORT must be one of {', '.join(EFFORT_LEVELS)}, got {effort!r}")

    return Settings(
        root=base,
        models_dir=base / "models",
        quran_dir=base / "data" / "quran",
        web_dir=base / "web",
        asr_model=asr_model,
        asr_threads=asr_threads,
        anthropic_api_key_set=_get(env, "ANTHROPIC_API_KEY") is not None,
        vision_model=_get(env, "MOMMY_VISION_MODEL"),
        text_model=_get(env, "MOMMY_TEXT_MODEL"),
        effort=effort,
    )


__all__ = ["ASR_MODELS", "EFFORT_LEVELS", "Settings", "load_settings"]

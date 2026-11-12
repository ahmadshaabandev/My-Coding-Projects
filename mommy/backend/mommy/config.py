"""Application settings, read once from environment variables.

Environment variables:

* ``MOMMY_ASR_MODEL``: ``"turbo"`` (default) or ``"small"``, the local Whisper model.
  Turbo has the same warm latency as small on a 4-core CPU (about 1.5 s for a 5 s clip),
  is markedly better on Arabic and on French homophones, and needs about 1 GB more RAM
  per loaded language. When its files are missing but the other model's are present,
  the other model is used (see ``mommy.asr.SherpaWhisper.from_settings``);
* ``MOMMY_ASR_THREADS``: CPU threads for speech recognition (default 4);
* ``ANTHROPIC_API_KEY``: only its presence is recorded, the value never leaves the
  environment (the SDK reads it itself);
* ``MOMMY_VISION_MODEL`` / ``MOMMY_TEXT_MODEL``: the Claude models for reading images and
  for text. Model names are configured here only, never written in the repository;
* ``MOMMY_EFFORT``: the effort level sent with Claude requests (default ``"low"``);
* ``MOMMY_ALLOWED_HOSTS``: comma-separated host names the server answers to (default
  ``127.0.0.1,localhost,::1``). Requests with any other ``Host`` header are refused,
  which blocks DNS-rebinding pages from reaching the API;
* ``MOMMY_ACCESS_CODE``: the access code of an online deployment (:mod:`mommy.access`).
  Unset or blank: no gate at all (local use). Set: every request needs the access
  cookie that ``POST /api/access`` gives for this code. The value is kept out of
  ``repr(Settings)`` and is never logged;
* ``MOMMY_REQUIRE_ACCESS_CODE``: any non-blank value makes a missing or blank access code
  an error instead of "no gate". The container image sets it (it listens on every
  interface, so it must never run without the gate); ``./run.sh`` does not.

When the key or either model is missing, the app runs offline (see ``Settings.claude_configured``).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

ASR_MODELS: tuple[str, ...] = ("small", "turbo")
EFFORT_LEVELS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")

DEFAULT_ASR_MODEL = "turbo"
DEFAULT_ASR_THREADS = 4
DEFAULT_EFFORT = "low"
DEFAULT_ALLOWED_HOSTS: tuple[str, ...] = ("127.0.0.1", "localhost", "::1")
#: Shortest accepted ``MOMMY_ACCESS_CODE`` (the deploy script makes 12 characters).
MIN_ACCESS_CODE_CHARS = 8

#: The ``mommy/`` directory: ``mommy/backend/mommy/config.py`` -> ``mommy/``.
DEFAULT_ROOT = Path(__file__).resolve().parent.parent.parent


@dataclass(frozen=True)
class Settings:
    """Paths and options of one running app (immutable)."""

    root: Path  # the mommy/ directory
    models_dir: Path  # root/"models"
    quran_dir: Path  # root/"data"/"quran"
    web_dir: Path  # root/"web"
    asr_model: str  # "small" or "turbo"; env MOMMY_ASR_MODEL, default "turbo"
    asr_threads: int  # env MOMMY_ASR_THREADS, default 4
    anthropic_api_key_set: bool
    vision_model: str | None  # env MOMMY_VISION_MODEL
    text_model: str | None  # env MOMMY_TEXT_MODEL
    effort: str  # env MOMMY_EFFORT, default "low"
    allowed_hosts: tuple[str, ...] = DEFAULT_ALLOWED_HOSTS  # env MOMMY_ALLOWED_HOSTS
    #: env MOMMY_ACCESS_CODE; None: no access gate. Never in repr (it would reach a log).
    access_code: str | None = field(default=None, repr=False)

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
    count that is not a positive integer, an unknown effort level, an allowed-hosts
    list with no host in it, an access code shorter than :data:`MIN_ACCESS_CODE_CHARS`
    (the message never quotes the code), or no access code while
    ``MOMMY_REQUIRE_ACCESS_CODE`` is set.
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

    hosts_raw = _get(env, "MOMMY_ALLOWED_HOSTS")
    if hosts_raw is None:
        allowed_hosts = DEFAULT_ALLOWED_HOSTS
    else:
        allowed_hosts = tuple(dict.fromkeys(h.strip().lower().strip("[]") for h in hosts_raw.split(",") if h.strip()))
        if not allowed_hosts:
            raise ValueError("MOMMY_ALLOWED_HOSTS must name at least one host")

    # Blank means unset here and in the gate alike (str.strip removes every Unicode white
    # space, a no-break space included), so this is the only place that decides.
    access_code = _get(env, "MOMMY_ACCESS_CODE")
    if access_code is None and _get(env, "MOMMY_REQUIRE_ACCESS_CODE") is not None:
        raise ValueError(
            "MOMMY_ACCESS_CODE is not set (or is blank), and MOMMY_REQUIRE_ACCESS_CODE says this "
            "server must not run without the access gate"
        )
    if access_code is not None and len(access_code) < MIN_ACCESS_CODE_CHARS:
        raise ValueError(f"MOMMY_ACCESS_CODE must have at least {MIN_ACCESS_CODE_CHARS} characters")

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
        allowed_hosts=allowed_hosts,
        access_code=access_code,
    )


__all__ = ["ASR_MODELS", "DEFAULT_ALLOWED_HOSTS", "EFFORT_LEVELS", "MIN_ACCESS_CODE_CHARS", "Settings", "load_settings"]

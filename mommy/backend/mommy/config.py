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
  which blocks DNS-rebinding pages from reaching the API. An entry that starts with a
  dot is a suffix entry (``.trycloudflare.com``: every name under that domain, never
  the domain itself; see :class:`mommy.access.HostMatcher`); a suffix of fewer than two
  labels (``.com``) is refused;
* ``MOMMY_ACCESS_CODE``: the access code of an online deployment (:mod:`mommy.access`).
  Unset or blank: no gate at all (local use). Set: every request needs the access
  cookie that ``POST /api/access`` gives for this code. The value is kept out of
  ``repr(Settings)`` and is never logged;
* ``MOMMY_ACCESS_CODE_FILE``: used only when ``MOMMY_ACCESS_CODE`` is unset or blank (the
  variable wins). The access code is read from this file; when the file does not
  exist, a new code (``mommy.access.generate_code``) is written to it first, atomically
  and with mode 0600 (``compose.yaml`` keeps it in a volume, so the code survives
  restarts; ``python -m mommy.share_link`` prints the link with it). The code is never
  logged; the path may be;
* ``MOMMY_REQUIRE_ACCESS_CODE``: any non-blank value makes a missing or blank access code
  an error instead of "no gate". The container image sets it (it listens on every
  interface, so it must never run without the gate); ``./run.sh`` does not;
* ``MOMMY_LIVE_RECITE``: ``on`` (default) or ``off`` (also ``1``/``0``, ``true``/``false``,
  ``yes``/``no``), the live check of a recitation, phrase by phrase while the child reads
  (``POST /api/recite/phrase``, and the tail of a recitation sent with ``heard_before`` to
  ``/api/recite/check``). Off, ``/api/recite/phrase`` does not exist (404), ``/api/health``
  says ``"live_recite": false`` and the web client sends each recording whole, as before.
  Nothing changes for the recogniser: it is still given the audio and the language only.
* ``MOMMY_LIVE_ASR_MODEL``: ``auto`` (default) or ``whisper``, the recogniser of the
  phrases of a live recitation in strict mode (``/api/recite/phrase`` and the tail of
  ``/api/recite/check`` with ``heard_before``). ``auto``: a quick recogniser decodes the
  phrase first where the language has one whose files are present (English: Moonshine
  base, French: Parakeet TDT 0.6B v3; ``mommy.asr.QUICK_MODELS``), and its words are kept
  when they add no mistake to the words read so far; otherwise Whisper decodes the phrase
  as before. Arabic, contextual mode and every other endpoint always use Whisper.
  Measured on 2 cores: a phrase read right is coloured 0.1-0.4 s after the end of
  speech is detected instead of 1.6-2.5 s, with the same word accuracy (docs/CONTRACT.md,
  "Live recitation"). ``whisper``: Whisper only, as before;
* ``MOMMY_OCR``: ``on`` (default) or ``off`` (the same values as ``MOMMY_LIVE_RECITE``), the
  local reading of printed pages (:mod:`mommy.ocr`): without Claude for a request,
  ``POST /api/page/read`` reads the photo on the server itself. Off, the models are not
  loaded, ``/api/health`` says ``"ocr": false`` and a page photo without Claude needs the
  parent to type the text, as before;
* ``MOMMY_OCR_THREADS``: CPU threads for the local page reader (default: the value of
  ``MOMMY_ASR_THREADS``).
* ``MOMMY_CLOUD_ASR``: ``off`` (default) or ``google``, an optional paid recogniser in the
  cloud (extra, :mod:`mommy.cloud_asr`): Google Cloud Speech-to-Text V2 (model
  ``MOMMY_GOOGLE_MODEL``, default ``chirp_3``). Used only for a request whose form says
  ``cloud=1``, which the web client sends only with the family's consent to it; Whisper
  stays the fallback for every failure, timeout and for the monthly cap. Like Whisper, it
  is given the audio and the language only (hard rule 1);
* ``MOMMY_CLOUD_ASR_LANGS``: the languages it is used for (default ``ar,en,fr``);
* ``MOMMY_GOOGLE_CREDENTIALS``: the path of a service-account JSON key file, or
  ``MOMMY_GOOGLE_CREDENTIALS_B64``: that file's content in base64 (an env file cannot
  hold the JSON's line breaks and quotes safely). Speech-to-Text V2 does not accept API
  keys (it answers 401 "API keys are not supported by this API"), so
  ``MOMMY_GOOGLE_API_KEY`` is not used: a warning says so. The key is never logged and
  never in ``repr(Settings)``;
* ``MOMMY_GOOGLE_PROJECT``: the Google Cloud project id (default: the key file's
  ``project_id``); ``MOMMY_GOOGLE_REGION``: ``eu`` (default), ``us`` or another
  Speech-to-Text location (``global`` is ``speech.googleapis.com``);
* ``MOMMY_GOOGLE_LOCALE_AR`` / ``_EN`` / ``_FR``: the language code sent for each app
  language (default ``ar-SA``, ``en-US``, ``fr-FR``);
* ``MOMMY_GOOGLE_MAX_MINUTES``: the monthly cap in minutes of audio (default 1000, about
  16 USD at 0.016 USD a minute; 0 sends nothing), counted per request in whole seconds
  rounded up as Google bills them, kept in ``MOMMY_GOOGLE_USAGE_FILE`` (compose.yaml:
  ``/data/google-usage.json``; unset: counted in memory, so a restart starts again
  from 0) and started again on the first day of each month (UTC);
* ``MOMMY_GOOGLE_TIMEOUT``: seconds to wait for one Google request (default 8).

When the key or either model is missing, the app runs offline (see ``Settings.claude_configured``).
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping

from .access import create_code_file, host_entry, read_code_file

log = logging.getLogger(__name__)

ASR_MODELS: tuple[str, ...] = ("small", "turbo")
#: The values of ``MOMMY_LIVE_ASR_MODEL``.
LIVE_ASR_MODELS: tuple[str, ...] = ("auto", "whisper")
EFFORT_LEVELS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")
#: The values of ``MOMMY_CLOUD_ASR`` that turn a cloud recogniser on (``off``: none).
CLOUD_ASR_PROVIDERS: tuple[str, ...] = ("google",)
#: The app languages (textnorm.LANGUAGES; repeated here, config imports no other module of ours but access).
_APP_LANGS: tuple[str, ...] = ("ar", "en", "fr")
DEFAULT_GOOGLE_LOCALES: dict[str, str] = {"ar": "ar-SA", "en": "en-US", "fr": "fr-FR"}
DEFAULT_GOOGLE_REGION = "eu"
DEFAULT_GOOGLE_MODEL = "chirp_3"
DEFAULT_GOOGLE_MAX_MINUTES = 1000
DEFAULT_GOOGLE_TIMEOUT = 8.0

DEFAULT_ASR_MODEL = "turbo"
DEFAULT_LIVE_ASR_MODEL = "auto"
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
    #: env MOMMY_ACCESS_CODE_FILE, when the code came from that file (None otherwise).
    access_code_file: Path | None = None
    live_recite: bool = True  # env MOMMY_LIVE_RECITE, default on
    live_asr_model: str = DEFAULT_LIVE_ASR_MODEL  # env MOMMY_LIVE_ASR_MODEL: "auto" or "whisper"
    ocr: bool = True  # env MOMMY_OCR, default on
    ocr_threads: int = DEFAULT_ASR_THREADS  # env MOMMY_OCR_THREADS, default asr_threads
    # -- the optional cloud recogniser (extra, mommy.cloud_asr) --
    cloud_asr: str | None = None  # env MOMMY_CLOUD_ASR: None (off) or "google"
    cloud_asr_langs: tuple[str, ...] = _APP_LANGS  # env MOMMY_CLOUD_ASR_LANGS
    google_credentials_file: Path | None = None  # env MOMMY_GOOGLE_CREDENTIALS
    #: env MOMMY_GOOGLE_CREDENTIALS_B64 (the key file in base64). Never in repr.
    google_credentials_b64: str | None = field(default=None, repr=False)
    google_project: str | None = None  # env MOMMY_GOOGLE_PROJECT (default: the key's project_id)
    google_region: str = DEFAULT_GOOGLE_REGION  # env MOMMY_GOOGLE_REGION
    google_model: str = DEFAULT_GOOGLE_MODEL  # env MOMMY_GOOGLE_MODEL
    google_locales: dict[str, str] = field(default_factory=lambda: dict(DEFAULT_GOOGLE_LOCALES))
    google_max_minutes: int = DEFAULT_GOOGLE_MAX_MINUTES  # env MOMMY_GOOGLE_MAX_MINUTES
    google_timeout: float = DEFAULT_GOOGLE_TIMEOUT  # env MOMMY_GOOGLE_TIMEOUT
    google_usage_file: Path | None = None  # env MOMMY_GOOGLE_USAGE_FILE

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


#: The values of an on/off variable (``MOMMY_LIVE_RECITE``, ``MOMMY_OCR``), compared case-insensitively.
TRUE_VALUES: tuple[str, ...] = ("1", "on", "true", "yes")
FALSE_VALUES: tuple[str, ...] = ("0", "off", "false", "no")


def parse_switch(env: Mapping[str, str], name: str, default: bool) -> bool:
    """An on/off variable: ``default`` when unset or blank, else one of
    :data:`TRUE_VALUES` or :data:`FALSE_VALUES` (ValueError for anything else)."""
    raw = _get(env, name)
    if raw is None:
        return default
    value = raw.lower()
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    raise ValueError(f"{name} must be on or off, got {raw!r}")


def parse_threads(env: Mapping[str, str], name: str, default: int) -> int:
    """A thread count: ``default`` when unset or blank, else a positive integer
    (ValueError for anything else)."""
    raw = _get(env, name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from None
    if value < 1:
        raise ValueError(f"{name} must be at least 1, got {value}")
    return value


_REGION_RE = re.compile(r"[a-z][a-z0-9-]{0,40}")
_LOCALE_RE = re.compile(r"[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}")
_MODEL_RE = re.compile(r"[a-z][a-z0-9_.-]{0,40}")
_PROJECT_RE = re.compile(r"[a-z][a-z0-9-]{4,61}[a-z0-9]|[a-z0-9.:-]{1,100}")


def parse_cloud_asr(env: Mapping[str, str]) -> dict[str, object]:
    """The settings of the optional cloud recogniser (``MOMMY_CLOUD_ASR`` and the
    ``MOMMY_GOOGLE_*`` variables), as keyword arguments of :class:`Settings`.

    ValueError (never quoting a credential) for an unknown provider or language, a bad
    region, locale, model or project id, a cap that is not a whole number of minutes at
    least 0, or a timeout that is not a number between 1 and 60. Whether the credentials
    work is not decided here: :mod:`mommy.cloud_asr` loads them when the app starts, and a
    key that cannot be used leaves the app running without the cloud recogniser."""
    out: dict[str, object] = {}
    raw = (_get(env, "MOMMY_CLOUD_ASR") or "off").lower()
    if raw in FALSE_VALUES or raw == "none":
        out["cloud_asr"] = None
    elif raw in CLOUD_ASR_PROVIDERS:
        out["cloud_asr"] = raw
    else:
        raise ValueError(f"MOMMY_CLOUD_ASR must be off or one of {', '.join(CLOUD_ASR_PROVIDERS)}, got {raw!r}")
    langs_raw = _get(env, "MOMMY_CLOUD_ASR_LANGS")
    if langs_raw is not None:
        langs = tuple(dict.fromkeys(x.strip().lower() for x in langs_raw.split(",") if x.strip()))
        bad = [x for x in langs if x not in _APP_LANGS]
        if bad or not langs:
            raise ValueError(f"MOMMY_CLOUD_ASR_LANGS must list some of {', '.join(_APP_LANGS)}, got {langs_raw!r}")
        out["cloud_asr_langs"] = tuple(x for x in _APP_LANGS if x in langs)
    if _get(env, "MOMMY_GOOGLE_API_KEY") is not None:
        # The value is never read further, printed or kept.
        log.warning(
            "MOMMY_GOOGLE_API_KEY is ignored: Speech-to-Text V2 does not accept API keys; "
            "set MOMMY_GOOGLE_CREDENTIALS (a service-account key file) instead"
        )
    cred = _get(env, "MOMMY_GOOGLE_CREDENTIALS")
    out["google_credentials_file"] = Path(cred) if cred is not None else None
    out["google_credentials_b64"] = _get(env, "MOMMY_GOOGLE_CREDENTIALS_B64")
    project = _get(env, "MOMMY_GOOGLE_PROJECT")
    if project is not None and not _PROJECT_RE.fullmatch(project):
        raise ValueError(f"MOMMY_GOOGLE_PROJECT is not a Google Cloud project id: {project!r}")
    out["google_project"] = project
    region = (_get(env, "MOMMY_GOOGLE_REGION") or DEFAULT_GOOGLE_REGION).lower()
    if not _REGION_RE.fullmatch(region):
        raise ValueError(f"MOMMY_GOOGLE_REGION must be a location such as eu or us, got {region!r}")
    out["google_region"] = region
    model = (_get(env, "MOMMY_GOOGLE_MODEL") or DEFAULT_GOOGLE_MODEL).lower()
    if not _MODEL_RE.fullmatch(model):
        raise ValueError(f"MOMMY_GOOGLE_MODEL is not a model name: {model!r}")
    out["google_model"] = model
    locales = dict(DEFAULT_GOOGLE_LOCALES)
    for lang in _APP_LANGS:
        name = f"MOMMY_GOOGLE_LOCALE_{lang.upper()}"
        value = _get(env, name)
        if value is not None:
            if not _LOCALE_RE.fullmatch(value):
                raise ValueError(f"{name} must be a language code such as {DEFAULT_GOOGLE_LOCALES[lang]}, got {value!r}")
            locales[lang] = value
    out["google_locales"] = locales
    minutes_raw = _get(env, "MOMMY_GOOGLE_MAX_MINUTES")
    if minutes_raw is not None:
        try:
            minutes = int(minutes_raw)
        except ValueError:
            raise ValueError(f"MOMMY_GOOGLE_MAX_MINUTES must be a whole number of minutes, got {minutes_raw!r}") from None
        if minutes < 0:
            raise ValueError(f"MOMMY_GOOGLE_MAX_MINUTES must be 0 or more, got {minutes}")
        out["google_max_minutes"] = minutes
    timeout_raw = _get(env, "MOMMY_GOOGLE_TIMEOUT")
    if timeout_raw is not None:
        try:
            timeout = float(timeout_raw)
        except ValueError:
            raise ValueError(f"MOMMY_GOOGLE_TIMEOUT must be a number of seconds, got {timeout_raw!r}") from None
        if not 1.0 <= timeout <= 60.0:
            raise ValueError(f"MOMMY_GOOGLE_TIMEOUT must be between 1 and 60 seconds, got {timeout_raw!r}")
        out["google_timeout"] = timeout
    usage = _get(env, "MOMMY_GOOGLE_USAGE_FILE")
    out["google_usage_file"] = Path(usage) if usage is not None else None
    return out


def parse_allowed_hosts(value: str) -> tuple[str, ...]:
    """The entries of a ``MOMMY_ALLOWED_HOSTS`` value, normalized
    (:func:`mommy.access.host_entry`), without repeats and in order. Raises ValueError for
    a list with no entry and for an entry ``host_entry`` refuses (a suffix such as
    ``.com``)."""
    hosts = tuple(dict.fromkeys(host_entry(h) for h in value.split(",") if h.strip()))
    if not hosts:
        raise ValueError("MOMMY_ALLOWED_HOSTS must name at least one host")
    return hosts


def check_access_code(code: str, source: str) -> str:
    """``code`` when it has at least :data:`MIN_ACCESS_CODE_CHARS` characters; else
    ValueError naming ``source`` (never the code)."""
    if len(code) < MIN_ACCESS_CODE_CHARS:
        raise ValueError(f"{source} must have at least {MIN_ACCESS_CODE_CHARS} characters")
    return code


def code_from_file(path: Path, *, create: bool = True) -> str:
    """The access code in ``path`` (``MOMMY_ACCESS_CODE_FILE``).

    When the file does not exist and ``create`` is true, a new code is written to it
    first (:func:`mommy.access.create_code_file`: atomic, mode 0600, and when another
    process makes it at the same moment, that code is the one read); with ``create``
    false, FileNotFoundError. Raises ValueError, whose message names the file and never
    the code, when the file cannot be read or written, or holds a code shorter than
    :data:`MIN_ACCESS_CODE_CHARS` (an empty file included)."""
    path = Path(path)
    source = f"the access code in MOMMY_ACCESS_CODE_FILE ({path})"
    for _ in range(3):
        try:
            return check_access_code(read_code_file(path), source)
        except FileNotFoundError:
            if not create:
                raise
        try:
            made = create_code_file(path)
        except OSError as exc:
            raise ValueError(
                f"cannot write a new access code to MOMMY_ACCESS_CODE_FILE ({path}): "
                f"{type(exc).__name__} ({exc.strerror or 'error'}); its directory must exist and be writable"
            ) from None
        if made is not None:
            log.info("made a new access code in %s", path)
            return made
        # Another process made the file first: read its code.
    raise ValueError(f"MOMMY_ACCESS_CODE_FILE ({path}) keeps disappearing")


def access_code_from(env: Mapping[str, str], *, create: bool = True) -> tuple[str | None, Path | None]:
    """(code, file) from ``env``: ``MOMMY_ACCESS_CODE`` when it is set (file None), else
    the code of ``MOMMY_ACCESS_CODE_FILE`` (:func:`code_from_file`), else (None, None).
    Blank counts as unset for both. Raises ValueError for a code that is too short."""
    code = _get(env, "MOMMY_ACCESS_CODE")
    if code is not None:
        return check_access_code(code, "MOMMY_ACCESS_CODE"), None
    file_raw = _get(env, "MOMMY_ACCESS_CODE_FILE")
    if file_raw is None:
        return None, None
    path = Path(file_raw)
    return code_from_file(path, create=create), path


def load_settings(root: Path | None = None) -> Settings:
    """Build :class:`Settings` from the environment.

    ``root`` is the ``mommy/`` directory (default: the one this package lives in); the
    models, Quran data and web directories are derived from it. Variables are read from
    ``os.environ`` at call time.

    Blank variables count as unset. Raises ValueError for an unknown ASR model, a thread
    count that is not a positive integer, an unknown effort level, an allowed-hosts
    list with no host in it or with a suffix entry that is too broad, an access code
    shorter than :data:`MIN_ACCESS_CODE_CHARS` (the message never quotes the code), a
    code file that cannot be read or made (:func:`code_from_file`), no access code
    while ``MOMMY_REQUIRE_ACCESS_CODE`` is set, a ``MOMMY_LIVE_RECITE`` or ``MOMMY_OCR``
    that is neither on nor off (:func:`parse_switch`), or a ``MOMMY_LIVE_ASR_MODEL`` that
    is not one of :data:`LIVE_ASR_MODELS`, or a cloud recogniser setting
    :func:`parse_cloud_asr` refuses.

    With ``MOMMY_ACCESS_CODE`` unset and ``MOMMY_ACCESS_CODE_FILE`` set, this reads that
    file, and writes a new code to it first when it does not exist.
    """
    env = os.environ
    base = Path(root).resolve() if root is not None else DEFAULT_ROOT

    asr_model = (_get(env, "MOMMY_ASR_MODEL") or DEFAULT_ASR_MODEL).lower()
    if asr_model not in ASR_MODELS:
        raise ValueError(f"MOMMY_ASR_MODEL must be one of {', '.join(ASR_MODELS)}, got {asr_model!r}")

    asr_threads = parse_threads(env, "MOMMY_ASR_THREADS", DEFAULT_ASR_THREADS)
    ocr_threads = parse_threads(env, "MOMMY_OCR_THREADS", asr_threads)

    effort = (_get(env, "MOMMY_EFFORT") or DEFAULT_EFFORT).lower()
    if effort not in EFFORT_LEVELS:
        raise ValueError(f"MOMMY_EFFORT must be one of {', '.join(EFFORT_LEVELS)}, got {effort!r}")

    live_recite = parse_switch(env, "MOMMY_LIVE_RECITE", True)
    live_asr_model = (_get(env, "MOMMY_LIVE_ASR_MODEL") or DEFAULT_LIVE_ASR_MODEL).lower()
    if live_asr_model not in LIVE_ASR_MODELS:
        raise ValueError(
            f"MOMMY_LIVE_ASR_MODEL must be one of {', '.join(LIVE_ASR_MODELS)}, got {live_asr_model!r}"
        )
    ocr = parse_switch(env, "MOMMY_OCR", True)

    hosts_raw = _get(env, "MOMMY_ALLOWED_HOSTS")
    allowed_hosts = DEFAULT_ALLOWED_HOSTS if hosts_raw is None else parse_allowed_hosts(hosts_raw)

    # Blank means unset here and in the gate alike (str.strip removes every Unicode white
    # space, a no-break space included), so this is the only place that decides.
    access_code, access_code_file = access_code_from(env)
    if access_code is None and _get(env, "MOMMY_REQUIRE_ACCESS_CODE") is not None:
        raise ValueError(
            "MOMMY_ACCESS_CODE is not set (or is blank), nor MOMMY_ACCESS_CODE_FILE, and "
            "MOMMY_REQUIRE_ACCESS_CODE says this server must not run without the access gate"
        )

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
        access_code_file=access_code_file,
        live_recite=live_recite,
        live_asr_model=live_asr_model,
        ocr=ocr,
        ocr_threads=ocr_threads,
        **parse_cloud_asr(env),  # type: ignore[arg-type]
    )


__all__ = [
    "ASR_MODELS",
    "CLOUD_ASR_PROVIDERS",
    "DEFAULT_ALLOWED_HOSTS",
    "EFFORT_LEVELS",
    "LIVE_ASR_MODELS",
    "MIN_ACCESS_CODE_CHARS",
    "Settings",
    "access_code_from",
    "check_access_code",
    "code_from_file",
    "load_settings",
    "parse_allowed_hosts",
    "parse_cloud_asr",
    "parse_switch",
    "parse_threads",
]

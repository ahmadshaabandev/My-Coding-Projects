#!/usr/bin/env python3
"""Put Mommy online as a Hugging Face Docker Space, behind an access code.

    python3 -m venv ~/.venvs/hf && ~/.venvs/hf/bin/pip install huggingface_hub
    export HF_TOKEN=...                                  # a token with write access
    ~/.venvs/hf/bin/python deploy/huggingface/deploy.py  # create or update the Space
    ~/.venvs/hf/bin/python deploy/huggingface/deploy.py --new-code   # rotate the code
    python3 deploy/huggingface/deploy.py --dry-run       # list the upload, no network

What it does (README.md, "Run it online", has the whole procedure):

1. Finds the account of HF_TOKEN (``whoami``) and creates the public Docker Space
   ``<user>/mommy`` if it does not exist yet. Hugging Face asks for a paid plan (PRO for
   a personal account) to create a Docker Space: without one, the script stops before
   creating anything (``--try-anyway`` tries all the same, in case that changes).
2. Sets the Space variable MOMMY_ALLOWED_HOSTS to the Space's host name
   (``<user>-mommy.hf.space``), and MOMMY_VISION_MODEL / MOMMY_TEXT_MODEL when
   --anthropic-model-vision / --anthropic-model-text are given; a variable that already
   has that value is left alone.
3. Sets the Space secret MOMMY_ACCESS_CODE to a new random code when the Space has none
   yet or when --new-code is given, and prints the share link
   ``https://<user>-mommy.hf.space/#code=<code>`` at once, before anything else can fail
   (the only time the code is shown; it is never written to a file). The Hub never
   returns a secret's value, but it lists the names of the secrets that are set, which is
   how "none yet" is decided.
4. Uploads the Space README (deploy/huggingface/README.md), the Dockerfile, the
   .dockerignore and the app files (backend/, web/, data/quran/,
   requirements-runtime.lock and the two scripts the image uses), and deletes every other
   file of the Space, in one commit. Never .venv, models, tests, docs or scratch files.
   The Space then builds the image (the models are downloaded during the build) and
   starts it. When nothing changed in the files (so no new build) but a secret or a
   variable did, it restarts the Space, so the running app takes the new values: a new
   code shuts out the old link only once the app has restarted with it.

The script never reads, sets or prints an Anthropic API key: the owner adds
ANTHROPIC_API_KEY as a Space secret in the Space's settings (optional; without it the
app runs offline). HF_TOKEN is passed to the Hub as it is (a placeholder works when a
network proxy adds the real token) and never printed.

The host name: Hugging Face serves the Space ``owner/name`` at
``https://<subdomain>.hf.space``. The subdomain is read from the Hub (``space_info``)
once the Space exists; :func:`space_subdomain` is the fallback, by the rule seen on
live Spaces: owner and name joined by "-", lower case, "." and "_" replaced by "-".
Subdomains longer than 56 characters are cut and given a hash suffix by the Hub, which
cannot be computed here (it never happens for "<user>-mommy" with a Hub user name).

Needs Python 3.10+ and huggingface_hub (in its own virtual environment: it is not a
dependency of the app). --dry-run needs neither the network nor huggingface_hub.
"""

from __future__ import annotations

import argparse
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # the mommy/ directory
SPACE_NAME = "mommy"

ACCESS_SECRET = "MOMMY_ACCESS_CODE"
HOSTS_VARIABLE = "MOMMY_ALLOWED_HOSTS"
VISION_VARIABLE = "MOMMY_VISION_MODEL"
TEXT_VARIABLE = "MOMMY_TEXT_MODEL"
ANTHROPIC_SECRET = "ANTHROPIC_API_KEY"

#: 31 letters and digits without the look-alikes i, l, o, 0 and 1. Twelve of them carry
#: 59 bits: the gate allows 10 wrong codes per client every 10 minutes, and guessing
#: one is out of reach even without that limit.
CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"
CODE_LENGTH = 12

#: (path in the repository, path in the Space)
SINGLE_FILES: tuple[tuple[str, str], ...] = (
    ("deploy/huggingface/README.md", "README.md"),
    ("Dockerfile", "Dockerfile"),
    (".dockerignore", ".dockerignore"),
    ("requirements-runtime.lock", "requirements-runtime.lock"),
    ("scripts/download_models.sh", "scripts/download_models.sh"),
    ("scripts/space_start.sh", "scripts/space_start.sh"),
)
#: Directories copied whole (same path in the Space), less the files _skipped() names.
TREES: tuple[str, ...] = ("backend", "web", "data/quran")

#: Files the access gate needs: without them the app would be open to anyone.
GATE_FILES: tuple[str, ...] = ("web/access.html", "web/access.js")


class DeployError(Exception):
    """A problem the operator has to fix; the message says what."""


def _skipped(name: str) -> bool:
    """Hidden files, caches and editor leftovers are never uploaded."""
    return (
        name.startswith(".")
        or name == "__pycache__"
        or name.endswith(("~", ".pyc", ".pyo", ".swp", ".orig", ".rej", ".bak"))
    )


def collect_files(root: Path = ROOT) -> tuple[dict[str, Path], list[str]]:
    """``({path in the Space: source file}, [notes])`` for the upload.

    Symbolic links are left out (and noted): one in web/ could point anywhere.
    """
    files: dict[str, Path] = {}
    notes: list[str] = []
    for source, dest in SINGLE_FILES:
        path = root / source
        if not path.is_file() or path.is_symlink():
            raise DeployError(f"{source} is missing (run the script from a complete checkout)")
        files[dest] = path
    for tree in TREES:
        base = root / tree
        if not base.is_dir():
            raise DeployError(f"{tree}/ is missing")
        for directory, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if not _skipped(d))
            for name in sorted(filenames):
                if _skipped(name):
                    continue
                path = Path(directory) / name
                rel = path.relative_to(root).as_posix()
                if path.is_symlink() or not path.is_file():
                    notes.append(f"left out {rel} (not a regular file)")
                    continue
                files[rel] = path
    return dict(sorted(files.items())), notes


def gate_problems(files: dict[str, Path]) -> list[str]:
    """Why these files would put the app online without the access gate (empty: fine)."""
    problems = [f"{name} is missing" for name in GATE_FILES if name not in files]
    config = files.get("backend/mommy/config.py")
    if config is None or ACCESS_SECRET not in config.read_text(encoding="utf-8"):
        problems.append(f"backend/mommy/config.py does not read {ACCESS_SECRET}")
    return problems


def assemble(files: dict[str, Path], dest: Path) -> int:
    """Copy ``files`` into ``dest`` byte for byte; returns the total size in bytes."""
    total = 0
    for rel, source in files.items():
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        total += target.stat().st_size
    return total


def _git(root: Path, *args: str) -> str | None:
    """The output of ``git -C root args``, or None without git or outside a checkout."""
    try:
        return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True,
                              timeout=30, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return None


def uncommitted(files: dict[str, Path], root: Path = ROOT) -> list[str]:
    """The upload's files that differ from the last commit (empty without git)."""
    top = _git(root, "rev-parse", "--show-toplevel")
    out = _git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", *TREES,
               *(source for source, _ in SINGLE_FILES))
    if not top or out is None:
        return []
    changed: set[Path] = set()
    records = iter(out.split("\0"))
    for record in records:
        if len(record) > 3:
            changed.add((Path(top.strip()) / record[3:]).resolve())
            if record[0] in "RC":
                next(records, None)  # the original path of a rename or copy
    return sorted(rel for rel, path in files.items() if path.resolve() in changed)


def commit_message(changed: list[str], root: Path = ROOT) -> str:
    """"Deploy Mommy <short commit>", plus "with local changes" when files differ from it."""
    head = (_git(root, "rev-parse", "--short", "HEAD") or "").strip()
    message = f"Deploy Mommy {head}".rstrip()
    return f"{message} with local changes" if changed else message


def new_access_code(length: int = CODE_LENGTH) -> str:
    """A random access code from :data:`CODE_ALPHABET` (the ``secrets`` module)."""
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(length))


def space_subdomain(owner: str, name: str = SPACE_NAME) -> str:
    """The subdomain of ``https://<subdomain>.hf.space`` for the Space ``owner/name``.

    Fallback only (the Hub's ``space_info().subdomain`` is used when it answers):
    ``owner-name``, lower case, with "." and "_" replaced by "-". Seen on live Spaces:
    ``hf-audio/open_asr_leaderboard`` -> ``hf-audio-open-asr-leaderboard``,
    ``ACE-Step/Ace-Step-v1.5`` -> ``ace-step-ace-step-v1-5``.
    """
    return re.sub(r"[._]", "-", f"{owner}-{name}").lower()


def share_link(host: str, code: str) -> str:
    """The link to send: the code is in the fragment, which browsers never send to a
    server, and the gate page removes it from the address bar at once."""
    return f"https://{host}/#code={code}"


# ---------------------------------------------------------------------------
# Hub calls
# ---------------------------------------------------------------------------


def _http_error_types() -> tuple[type[BaseException], ...]:
    try:
        from huggingface_hub.errors import HfHubHTTPError
    except ImportError:  # older huggingface_hub
        from huggingface_hub.utils import HfHubHTTPError  # type: ignore[no-redef]
    return (HfHubHTTPError,)


def _secret_names(api, repo_id: str) -> set[str] | None:
    """Names of the Space's secrets (never values), or None when the Hub cannot tell."""
    getter = getattr(api, "get_space_secrets", None)
    if getter is None:
        return None
    try:
        return set(getter(repo_id))
    except _http_error_types():
        return None


def _variables(api, repo_id: str) -> dict[str, str]:
    try:
        return {key: getattr(var, "value", "") for key, var in api.get_space_variables(repo_id).items()}
    except _http_error_types():
        return {}


def _hub_failure(exc: BaseException, http_errors: tuple[type[BaseException], ...]) -> str:
    """One line for an error of a Hub call: the Hub's own reason for an HTTP error, the
    exception's class and first line otherwise (a dropped connection, a timeout)."""
    if isinstance(exc, http_errors):
        return f"the Hub refused a request: {_reason(exc)}"
    first = (str(exc).splitlines() or [""])[0][:200]
    return f"a request to the Hub failed ({type(exc).__name__}{': ' + first if first else ''})"


def deploy(args: argparse.Namespace, files: dict[str, Path], folder: Path, changed: list[str]) -> None:
    """Create or update the Space from ``folder`` (assembled from ``files``; ``changed``
    lists those with uncommitted changes)."""
    try:
        from huggingface_hub import HfApi
    except ImportError:
        raise DeployError(
            "huggingface_hub is not installed: python3 -m venv ~/.venvs/hf && "
            "~/.venvs/hf/bin/pip install huggingface_hub, then run this script with ~/.venvs/hf/bin/python"
        ) from None
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise DeployError("set HF_TOKEN to a Hugging Face access token with write access "
                          "(https://huggingface.co/settings/tokens)")
    api = HfApi(token=token)
    http_errors = _http_error_types()

    try:
        me = api.whoami()
    except http_errors as exc:
        raise DeployError(f"the Hub refused HF_TOKEN ({_reason(exc)}): a token with write access is needed") from None
    except Exception as exc:  # noqa: BLE001 - network errors: one line, no traceback
        raise DeployError(_hub_failure(exc, http_errors)) from None
    user = me["name"]
    repo_id = f"{user}/{SPACE_NAME}"

    code = None  # set once the new code is in the Space's secret (the link is then printed)
    try:
        existed = api.repo_exists(repo_id, repo_type="space")
        if not existed and me.get("isPro") is False:
            if not args.try_anyway:
                raise DeployError(
                    "Hugging Face asks for a paid plan (PRO for a personal account) to create a Docker "
                    "Space, and this account has none, so nothing was created. The CPU basic hardware "
                    "itself is free. With a PRO plan, run this again; to try without one all the same "
                    "(in case that rule has changed), add --try-anyway."
                )
            print("note: this account has no PRO plan; trying all the same (--try-anyway)")
        names = _secret_names(api, repo_id) if existed else set()
        if names is None and not args.new_code:
            raise DeployError(
                f"cannot tell whether {repo_id} already has an access code (this huggingface_hub "
                "cannot list Space secrets, or the token may not read them): upgrade huggingface_hub, "
                "or run again with --new-code (the old link then stops working). Nothing was changed."
            )
        set_code = args.new_code or ACCESS_SECRET not in (names or set())

        api.create_repo(repo_id, repo_type="space", space_sdk="docker", private=False, exist_ok=True)
        print(f"{'updating' if existed else 'created'} the Space https://huggingface.co/spaces/{repo_id}")

        info = api.space_info(repo_id)
        before = getattr(info, "sha", None)
        subdomain = getattr(info, "subdomain", None)
        if not subdomain:
            subdomain = space_subdomain(user)
            print(f"note: the Hub gave no subdomain; using {subdomain} (see space_subdomain)")
        elif subdomain != space_subdomain(user):
            print(f"note: the Hub's subdomain is {subdomain}, not {space_subdomain(user)}; using the Hub's")
        host = f"{subdomain}.hf.space"

        # A variable is set only when its value changes (setting it again could restart
        # the Space for nothing).
        current = _variables(api, repo_id) if existed else {}
        wanted = {HOSTS_VARIABLE: (host, "The host name the app answers to (deploy.py)")}
        if args.anthropic_model_vision:
            wanted[VISION_VARIABLE] = (args.anthropic_model_vision, "Claude model that reads photos (deploy.py)")
        if args.anthropic_model_text:
            wanted[TEXT_VARIABLE] = (args.anthropic_model_text, "Claude model for meaning and feedback (deploy.py)")
        settings_changed = False
        for key, (value, description) in wanted.items():
            if current.get(key) != value:
                api.add_space_variable(repo_id, key, value, description=description)
                settings_changed = True

        if set_code:
            new_code = new_access_code()
            api.add_space_secret(repo_id, ACCESS_SECRET, new_code,
                                 description="Access code of the private test link (deploy.py)")
            code = new_code
            settings_changed = True
            # Printed now: the Hub never gives the code back, so if a later step fails,
            # this is still the code the Space has (a new run keeps it).
            print()
            print("Share link (send it privately: anyone who has it can use the app):")
            print(f"  {share_link(host, code)}")
            print("It is printed only now. If a step below fails, run deploy.py again: this link stays valid.")
            print()

        # delete_patterns="*": every file of the Space that is not in this upload goes
        # (the Hub always keeps .gitattributes).
        commit = api.upload_folder(
            repo_id=repo_id, repo_type="space", folder_path=str(folder),
            commit_message=commit_message(changed), delete_patterns="*",
        )
        print(f"uploaded {len(files)} files ({getattr(commit, 'commit_url', '') or 'one commit'})")
        after = getattr(commit, "oid", None)
        restarted = False
        if settings_changed and existed and before is not None and after == before:
            # No new commit, so no new build: the running app still has the old values.
            api.restart_space(repo_id)
            restarted = True
            print("no file changed, so the Space was restarted to take the new settings")
        elif settings_changed and existed and (before is None or after is None):
            print("note: if the Space does not rebuild, use Restart in its settings so the app takes the new settings")
        variables = _variables(api, repo_id)
        names = _secret_names(api, repo_id)
    except DeployError:
        raise
    except Exception as exc:  # noqa: BLE001 - Hub and network errors: one clear line
        message = _hub_failure(exc, http_errors)
        if code is not None:
            message += ". The share link printed above is valid (the Space has its code): run deploy.py again to finish"
        raise DeployError(message) from None

    if names is not None and ANTHROPIC_SECRET in names and variables.get(VISION_VARIABLE) and variables.get(TEXT_VARIABLE):
        print("Claude: configured")
    else:
        print(f"Claude: not configured, the app runs offline (it needs the secret {ANTHROPIC_SECRET}, "
              f"added in the Space settings, and both model variables)")
    print()
    action = "restarts" if restarted else "now builds the image (several minutes)"
    print(f"The Space {action}: https://huggingface.co/spaces/{repo_id} (Logs).")
    print(f"App: https://{host}/")
    if code is not None:
        if existed:
            print("The previous link, and every browser that used it, stop working once the Space shows "
                  "Running again with the new code.")
    else:
        print("The access code was kept (--new-code makes a new one; the old link then stops working).")


def _reason(exc: BaseException) -> str:
    """The Hub's own explanation of an HTTP error, on one line."""
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    message = getattr(exc, "server_message", None) or str(exc).splitlines()[0]
    return f"{status} {message}" if status else message


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Create or update the Hugging Face Space <user>/mommy (README.md, 'Run it online').")
    parser.add_argument("--new-code", action="store_true",
                        help="set a new access code (the old link stops working) and print the new link")
    parser.add_argument("--anthropic-model-vision", metavar="MODEL",
                        help=f"set the Space variable {VISION_VARIABLE} (a vision-capable Claude model id)")
    parser.add_argument("--anthropic-model-text", metavar="MODEL",
                        help=f"set the Space variable {TEXT_VARIABLE} (a Claude model id)")
    parser.add_argument("--try-anyway", action="store_true",
                        help="create the Space even though the account has no PRO plan (Hugging Face asks for one)")
    parser.add_argument("--dry-run", action="store_true",
                        help="assemble the upload and list it, with no network call")
    parser.add_argument("--out", metavar="DIR", type=Path,
                        help="with --dry-run: assemble into DIR (new or empty) and keep it, e.g. for docker build DIR")
    args = parser.parse_args(argv)
    if args.out is not None and not args.dry_run:
        parser.error("--out goes with --dry-run")

    try:
        files, notes = collect_files()
        problems = gate_problems(files)
        changed = uncommitted(files)
        with tempfile.TemporaryDirectory(prefix="mommy-space-") as tmp:
            folder = Path(tmp)
            if args.out is not None:
                folder = args.out.resolve()
                if folder.exists() and any(folder.iterdir()):
                    raise DeployError(f"{folder} is not empty")
                folder.mkdir(parents=True, exist_ok=True)
            total = assemble(files, folder)
            if args.dry_run:
                for rel in files:
                    print(f"{(folder / rel).stat().st_size:>10}  {rel}")
                print(f"{total:>10}  bytes in {len(files)} files, assembled in {folder}"
                      f"{'' if args.out else ' (removed on exit)'}")
            else:
                print(f"assembled {len(files)} files ({total / 1e6:.1f} MB)")
            for note in notes:
                print(f"note: {note}")
            if changed:
                print(f"note: {len(changed)} of these files have changes that are not committed: "
                      + ", ".join(changed[:8]) + (" ..." if len(changed) > 8 else ""))
            if problems:
                raise DeployError("the access gate is not in this checkout (" + "; ".join(problems)
                                  + "): refusing to put the app online without it")
            if args.dry_run:
                print(f"dry run: would create or update <user>/{SPACE_NAME}, set {HOSTS_VARIABLE}="
                      f"{space_subdomain('<user>')}.hf.space, set {ACCESS_SECRET} "
                      f"{'(new code)' if args.new_code else '(if the Space has none)'}"
                      + "".join(f", {var}={val}" for var, val in ((VISION_VARIABLE, args.anthropic_model_vision),
                                                                   (TEXT_VARIABLE, args.anthropic_model_text)) if val)
                      + ", and upload these files")
                return 0
            deploy(args, files, folder, changed)
    except DeployError as exc:
        print(f"deploy.py: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

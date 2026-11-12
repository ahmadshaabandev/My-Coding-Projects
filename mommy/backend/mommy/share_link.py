"""The link to share a self-hosted Mommy (``compose.yaml``: the app and a Cloudflare
quick tunnel), printed for the owner.

Run inside the app's container::

    docker compose exec mommy python -m mommy.share_link             # the link to send
    docker compose exec mommy python -m mommy.share_link --new-code  # a new access code

What it does:

1. Reads the access code as the app does (:func:`mommy.config.access_code_from`):
   ``MOMMY_ACCESS_CODE`` when it is set, else the file ``MOMMY_ACCESS_CODE_FILE``
   (``/data/access-code`` in ``compose.yaml``, made by the app at its first start). It
   never makes the file itself: a code the running app does not have would open nothing.
2. Asks cloudflared's metrics server (``MOMMY_TUNNEL_METRICS_URL``, default
   :data:`DEFAULT_METRICS_URL`, reachable only on the compose network) for the quick
   tunnel's host name: ``GET /quicktunnel`` answers ``{"hostname": "<name>.trycloudflare.com"}``
   (cloudflared starts that server once it has the name; an empty name means it runs
   without a quick tunnel). Then ``GET /ready`` says whether the tunnel is connected to
   Cloudflare (200) or not yet (503). Both are retried for up to :data:`DEFAULT_WAIT_S`
   seconds while the tunnel starts.
3. Prints the link ``https://<name>/#code=<code>`` (the code is in the fragment, which
   browsers never send to a server) and a one-line reminder (:data:`REMINDER`): the
   link changes when the tunnel restarts (a reboot, for example), the code does not.

``--new-code`` writes a new code to the code file (atomically, mode 0600), says to run
:data:`RESTART_COMMAND` (the app reads the code when it starts; the old link and every
cookie given for the old code then stop working) and prints the new link.

The link and the reminder go to standard output (``--link-only``: the link alone);
waiting notes, warnings and errors go to standard error. Exit status: 0 with a link, 1
without a usable code, 2 for a wrong option, 3 when the tunnel gave no name. Nothing is
logged; the code appears only in the link's fragment.
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, TextIO

from .access import HostMatcher, generate_code, is_dns_name, replace_code_file
from .config import DEFAULT_ALLOWED_HOSTS, access_code_from, parse_allowed_hosts

#: cloudflared's metrics server in ``compose.yaml`` (the ``tunnel`` service, ``--metrics
#: 0.0.0.0:2000``; the port is not published to the host).
DEFAULT_METRICS_URL = "http://tunnel:2000"
#: cloudflared's metrics endpoints: the quick tunnel's name, and whether it is connected.
QUICKTUNNEL_PATH = "/quicktunnel"
READY_PATH = "/ready"
#: How long the tunnel is waited for, in seconds, and how often it is asked.
DEFAULT_WAIT_S = 60.0
POLL_INTERVAL_S = 1.0
REQUEST_TIMEOUT_S = 3.0
#: The largest answer read from the metrics server.
MAX_ANSWER_BYTES = 4096

#: The commands the owner is told to run (from the ``mommy/`` directory).
SHARE_COMMAND = "docker compose exec mommy python -m mommy.share_link"
RESTART_COMMAND = "docker compose restart mommy"
#: For a code file the app cannot start with (``exec`` needs a running container).
REPAIR_COMMAND = "docker compose run --rm mommy python -m mommy.share_link --new-code"
REMINDER = (
    "Reminder: this link changes when the tunnel restarts (after a reboot, for example), "
    "but the code stays the same: run this command again to get the new link."
)

EXIT_OK = 0
EXIT_NO_CODE = 1
EXIT_USAGE = 2
EXIT_NO_TUNNEL = 3


class TunnelError(Exception):
    """The tunnel gave no host name; the message says why, for the owner."""


@dataclass(frozen=True)
class Tunnel:
    """What cloudflared's metrics server said."""

    hostname: str  # the quick tunnel's host name, lower case
    #: True: connected to Cloudflare; False: not yet when the wait ended; None: unknown
    #: (the server has no ``/ready``).
    ready: bool | None


def share_link(hostname: str, code: str) -> str:
    """``https://<hostname>/#code=<code>``, the code percent-encoded (a no-op for the
    codes the app makes; ``web/access.js`` decodes it with ``URLSearchParams``)."""
    return f"https://{hostname}/#code={urllib.parse.quote(code, safe='')}"


def parse_hostname(body: bytes) -> str:
    """The host name in a ``/quicktunnel`` answer (``{"hostname": "..."}``), lower case;
    ``""`` when the answer has an empty name. Raises ValueError for anything else (not
    JSON, no ``hostname`` string, not a host name)."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ValueError("it is not JSON") from None
    if not isinstance(data, dict) or not isinstance(data.get("hostname"), str):
        raise ValueError('it has no "hostname" string')
    name = data["hostname"].strip().lower()
    if name.startswith("https://"):
        name = name[len("https://") :]
    if name.endswith("."):
        name = name[:-1]
    if name and ("." not in name or not is_dns_name(name)):
        raise ValueError("its hostname is not a host name")
    return name


def _no_proxy_opener() -> urllib.request.OpenerDirector:
    """An opener that ignores ``HTTP_PROXY`` and the like: the metrics server is on the
    compose network, which a proxy set for the container could not reach."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _fetch(opener: urllib.request.OpenerDirector, url: str, timeout: float) -> tuple[int, bytes]:
    """(status, body) of ``GET url``; OSError (``URLError`` included) when there is no
    answer (refused, unknown name, timeout)."""
    try:
        with opener.open(url, timeout=timeout) as response:
            return response.status, response.read(MAX_ANSWER_BYTES + 1)
    except urllib.error.HTTPError as exc:
        with exc:
            return exc.code, exc.read(MAX_ANSWER_BYTES + 1)


def _reason(exc: Exception) -> str:
    """The kind of failure, without its message (``ConnectionRefusedError``, ``gaierror``)."""
    reason = getattr(exc, "reason", None)
    if isinstance(reason, BaseException):
        return type(reason).__name__
    return type(exc).__name__


def wait_for_tunnel(
    metrics_url: str = DEFAULT_METRICS_URL,
    *,
    wait_s: float = DEFAULT_WAIT_S,
    interval_s: float = POLL_INTERVAL_S,
    request_timeout_s: float = REQUEST_TIMEOUT_S,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    on_wait: Callable[[], None] | None = None,
) -> Tunnel:
    """The quick tunnel of the cloudflared metrics server at ``metrics_url``.

    Asks ``/quicktunnel`` until it answers (no answer or an HTTP error other than 404 is
    retried every ``interval_s`` seconds, for up to ``wait_s``), then ``/ready`` until it
    answers 200 (connected) within the same time. ``on_wait`` is called once, the first
    time it has to wait. Raises :class:`TunnelError` when no name came in time, at once
    for a 404 (not a cloudflared metrics server, or a version without ``/quicktunnel``),
    a malformed answer or an empty name (cloudflared runs without a quick tunnel). When
    the name came but the tunnel is not connected yet at the end, ``ready`` is False."""
    base = metrics_url.strip().rstrip("/")
    opener = _no_proxy_opener()
    deadline = clock() + wait_s
    hostname: str | None = None
    problem = "no answer"
    waited = False
    while True:
        if hostname is None:
            url = base + QUICKTUNNEL_PATH
            try:
                status, body = _fetch(opener, url, request_timeout_s)
            except ValueError:  # a URL urllib cannot use (http.client.InvalidURL included)
                raise TunnelError(f"MOMMY_TUNNEL_METRICS_URL ({base}) is not a usable http:// address") from None
            except (OSError, http.client.HTTPException) as exc:
                problem = f"no answer: {_reason(exc)}"
            else:
                if status == 404:
                    raise TunnelError(
                        f"{url} does not exist: this is not cloudflared's metrics server, or that "
                        "cloudflared is too old to tell its quick tunnel's name"
                    )
                if status != 200:
                    problem = f"HTTP {status}"
                else:
                    try:
                        name = parse_hostname(body[:MAX_ANSWER_BYTES])
                    except ValueError as exc:
                        raise TunnelError(f"the answer of {url} is not understood ({exc})") from None
                    if not name:
                        raise TunnelError(
                            "cloudflared runs without a quick tunnel (it has no trycloudflare.com name): "
                            "it must be started with --url and without a tunnel token or name"
                        )
                    hostname = name
        if hostname is not None:
            try:
                status, _ = _fetch(opener, base + READY_PATH, request_timeout_s)
            except (OSError, http.client.HTTPException):
                status = None
            if status == 200:
                return Tunnel(hostname, True)
            if status is not None and status != 503:
                return Tunnel(hostname, None)  # no readiness to wait for
        now = clock()
        if now >= deadline:
            break
        if not waited:
            waited = True
            if on_wait is not None:
                on_wait()
        sleep(max(0.0, min(interval_s, deadline - now)))
    if hostname is not None:
        return Tunnel(hostname, False)
    raise TunnelError(f"the tunnel did not answer at {base} within {wait_s:g} s ({problem})")


def _get(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name)
    if value is None:
        return None
    return value.strip() or None


def _allowed(env: Mapping[str, str], hostname: str) -> bool | None:
    """Whether the app answers to ``hostname`` (its ``MOMMY_ALLOWED_HOSTS``); None when
    that variable is not valid (the app then does not start, and says why)."""
    raw = _get(env, "MOMMY_ALLOWED_HOSTS")
    try:
        hosts = DEFAULT_ALLOWED_HOSTS if raw is None else parse_allowed_hosts(raw)
        return HostMatcher(hosts).allows_name(hostname)
    except ValueError:
        return None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m mommy.share_link",
        description=(
            "Print the link to share Mommy through its Cloudflare quick tunnel: "
            "https://<name>.trycloudflare.com/#code=<access code>."
        ),
    )
    parser.add_argument(
        "--new-code",
        action="store_true",
        help=f"write a new access code (then run: {RESTART_COMMAND}); the old link stops working",
    )
    parser.add_argument("--link-only", action="store_true", help="print the link alone, without the reminder")
    parser.add_argument(
        "--wait",
        type=float,
        default=DEFAULT_WAIT_S,
        metavar="SECONDS",
        help=f"how long to wait for the tunnel (default {DEFAULT_WAIT_S:g})",
    )
    return parser


def main(
    argv: list[str] | None = None,
    *,
    env: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    interval_s: float = POLL_INTERVAL_S,
) -> int:
    """The command line (see the module docstring); returns the exit status."""
    out = sys.stdout if stdout is None else stdout
    err = sys.stderr if stderr is None else stderr
    env = os.environ if env is None else env
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return EXIT_USAGE if exc.code else EXIT_OK
    if not args.wait >= 0:
        print("--wait must be 0 or more seconds", file=err)
        return EXIT_USAGE

    def say(*lines: str, to: TextIO = out) -> None:
        for line in lines:
            print(line, file=to)
        to.flush()

    file_raw = _get(env, "MOMMY_ACCESS_CODE_FILE")
    if args.new_code:
        if _get(env, "MOMMY_ACCESS_CODE") is not None:
            say(
                "MOMMY_ACCESS_CODE is set, and it wins over MOMMY_ACCESS_CODE_FILE: a new code in the file "
                "would change nothing. Change MOMMY_ACCESS_CODE where it is set instead.",
                to=err,
            )
            return EXIT_NO_CODE
        if file_raw is None:
            say("MOMMY_ACCESS_CODE_FILE is not set: there is no code file to write (compose.yaml sets it).", to=err)
            return EXIT_NO_CODE
        path = Path(file_raw)
        code = generate_code()
        try:
            replace_code_file(path, code)
        except OSError as exc:
            say(
                f"Cannot write the new access code to {path}: {type(exc).__name__} ({exc.strerror or 'error'}).",
                to=err,
            )
            return EXIT_NO_CODE
        say(
            f"A new access code is saved in {path}.",
            "Restart the app so that it uses the new code (the old link then stops working):",
            f"    {RESTART_COMMAND}",
            "Then share the new link:",
        )
    else:
        try:
            code, path_or_none = access_code_from(env, create=False)
        except FileNotFoundError:
            say(
                f"No access code yet: {file_raw} does not exist. The app makes it when it starts: "
                f"start it (docker compose up -d) or restart it ({RESTART_COMMAND}), then run this command again.",
                to=err,
            )
            return EXIT_NO_CODE
        except ValueError as exc:
            say(f"The access code cannot be used: {exc}.", f"Make a new one with: {REPAIR_COMMAND}", to=err)
            return EXIT_NO_CODE
        if code is None:
            say(
                "No access code is set: set MOMMY_ACCESS_CODE_FILE (compose.yaml sets it to /data/access-code) "
                "or MOMMY_ACCESS_CODE.",
                to=err,
            )
            return EXIT_NO_CODE

    metrics_url = _get(env, "MOMMY_TUNNEL_METRICS_URL") or DEFAULT_METRICS_URL
    try:
        tunnel = wait_for_tunnel(
            metrics_url,
            wait_s=args.wait,
            interval_s=interval_s,
            on_wait=lambda: say(f"Waiting for the tunnel to start (up to {args.wait:g} s)...", to=err),
        )
    except TunnelError as exc:
        say(
            f"No link: {exc}.",
            "Is the tunnel running? Check with: docker compose ps   and   docker compose logs tunnel",
            f"Then run this command again: {SHARE_COMMAND}",
            to=err,
        )
        return EXIT_NO_TUNNEL

    if tunnel.ready is False:
        say(
            f"Warning: the tunnel is not connected to Cloudflare yet (after {args.wait:g} s), so the link "
            "may not open until it is. See: docker compose logs tunnel",
            to=err,
        )
    if _allowed(env, tunnel.hostname) is False:
        say(
            f"Warning: the app does not answer to {tunnel.hostname} (MOMMY_ALLOWED_HOSTS): the link would get "
            '"400 bad_host". Add .trycloudflare.com to MOMMY_ALLOWED_HOSTS.',
            to=err,
        )
    say(share_link(tunnel.hostname, code))
    if not args.link_only:
        say(REMINDER)
    return EXIT_OK


if __name__ == "__main__":  # pragma: no cover - the command line
    sys.exit(main())

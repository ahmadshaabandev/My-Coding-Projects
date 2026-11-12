#!/bin/sh
# Start Mommy inside the container image (the Dockerfile's CMD), on 0.0.0.0:7860.
#
# The image listens on every interface, so it must never run without the access gate.
# MOMMY_REQUIRE_ACCESS_CODE=1 (also set by the Dockerfile) makes the app's own settings
# (mommy.config, the same code that decides whether the gate exists) refuse a missing or
# blank MOMMY_ACCESS_CODE; this script asks them first, so the container stops with one
# clear line before uvicorn starts. "Blank" is Python's meaning (any Unicode white space,
# a no-break space included), never a second, different test here. The code itself is
# never printed. Local use, without a gate, is ./run.sh, which listens on 127.0.0.1 only.
#
# On Hugging Face the code is the Space secret MOMMY_ACCESS_CODE. compose.yaml (one's own
# computer, SELF_HOST.md) sets MOMMY_ACCESS_CODE_FILE instead: the settings check below
# then reads the code from that file, or writes a new one to it on the first start.
set -eu

MOMMY_REQUIRE_ACCESS_CODE=1
export MOMMY_REQUIRE_ACCESS_CODE

# SPACE_HOST is the host name Hugging Face gives the Space: always answer to it, as well
# as to the names in MOMMY_ALLOWED_HOSTS (deploy/huggingface/deploy.py sets that one as
# a Space variable). A renamed Space still answers.
if [ -n "${SPACE_HOST:-}" ]; then
  MOMMY_ALLOWED_HOSTS="${MOMMY_ALLOWED_HOSTS:+$MOMMY_ALLOWED_HOSTS,}$SPACE_HOST"
  export MOMMY_ALLOWED_HOSTS
fi

python -c '
import logging
import sys
from mommy.config import load_settings
# Shows "made a new access code in <path>" (the path, never the code) when this check is
# the one that makes the code file, as on a first compose start.
logging.basicConfig(level=logging.INFO, format="space_start.sh: %(message)s")
try:
    settings = load_settings()
except ValueError as exc:
    sys.exit(f"space_start.sh: {exc}: refusing to serve the app on all interfaces. Set it as a "
             "Space secret (deploy/huggingface/deploy.py does), or set MOMMY_ACCESS_CODE_FILE "
             "(compose.yaml does), or use ./run.sh for local use.")
print("space_start.sh: access gate on; answering to " + ", ".join(settings.allowed_hosts), file=sys.stderr)
' || exit 1

# --proxy-headers: TLS ends at the Hugging Face proxy, so the client address the access
# gate counts wrong codes by comes from X-Forwarded-For, and the scheme from
# X-Forwarded-Proto. Uvicorn takes them only from a peer in --forwarded-allow-ips, and
# then reads X-Forwarded-For from the right: the first address that is not a trusted
# proxy is the client, the one the proxy itself appended. The proxy's own addresses are
# not published; these are the private and shared networks a cluster's proxies use.
# Not '*': uvicorn would then take the LEFT-most entry, which the visitor writes (a
# visitor could pick a fresh failure count for every try, or another person's address
# to lock them out). If the Space's log warns that access codes come from a private or
# unknown address, the proxy is not in these networks: the Space variable
# MOMMY_FORWARDED_ALLOW_IPS replaces the list (README.md, "Run it online").
TRUSTED_PROXIES='10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,::1,fc00::/7,fe80::/10'

# MOMMY_FORWARDED_ALLOW_IPS=container-networks (compose.yaml): trust only the networks
# this container is attached to, read from its routing table at start (the directly
# connected IPv4 and IPv6 networks, link-local and loopback left out), WITHOUT their
# gateways (backend/mommy/proxies.py). With Docker Compose that is the project's own network,
# whose subnet Docker chooses: its only other member is the tunnel, which forwards the
# visitors. The gateway is the computer's side of the network: Docker's forwarding of
# the port published on the computer's 127.0.0.1 arrives from it, so a program on the
# computer could otherwise write its own X-Forwarded-For. Without such a network, the
# list above.
if [ "${MOMMY_FORWARDED_ALLOW_IPS:-}" = "container-networks" ]; then
  MOMMY_FORWARDED_ALLOW_IPS=$(python -m mommy.proxies container-networks) || {
    MOMMY_FORWARDED_ALLOW_IPS=$TRUSTED_PROXIES
    echo "space_start.sh: X-Forwarded-For is taken from $MOMMY_FORWARDED_ALLOW_IPS" >&2
  }
fi

# --timeout-keep-alive 75: longer than a reverse proxy keeps an idle connection, so the
# proxy never reuses one that uvicorn has just closed (a rare 502 on an upload).
# --no-access-log: uvicorn's access log would print every client address and path; the
# app's own log has only sizes and timings (docs/CONTRACT.md, hard rule 5).
exec uvicorn mommy.app:build_default_app --factory --host 0.0.0.0 --port 7860 \
  --proxy-headers --forwarded-allow-ips "${MOMMY_FORWARDED_ALLOW_IPS:-$TRUSTED_PROXIES}" \
  --timeout-keep-alive 75 --no-access-log

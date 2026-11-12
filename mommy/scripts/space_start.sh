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
import sys
from mommy.config import load_settings
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
# connected IPv4 and IPv6 networks, link-local and loopback left out). With Docker
# Compose that is the project's own network, whose subnet Docker chooses: its only other
# members are the tunnel, which forwards the visitors, and Docker's forwarding of the
# port published on the computer's 127.0.0.1. Without such a network, the list above.
if [ "${MOMMY_FORWARDED_ALLOW_IPS:-}" = "container-networks" ]; then
  MOMMY_FORWARDED_ALLOW_IPS=$(python -c '
import ipaddress, sys
nets = []
try:
    with open("/proc/net/route", encoding="ascii") as f:
        for row in f.read().splitlines()[1:]:
            col = row.split()
            if len(col) < 8 or col[0] == "lo" or int(col[2], 16) != 0 or int(col[1], 16) == 0:
                continue  # loopback, a route through a router, or the default route
            prefix = bin(int(col[7], 16)).count("1")
            nets.append(ipaddress.IPv4Network((int(col[1], 16).to_bytes(4, sys.byteorder), prefix)))
except (OSError, ValueError):
    pass
try:
    with open("/proc/net/ipv6_route", encoding="ascii") as f:
        for row in f.read().splitlines():
            col = row.split()
            if len(col) < 10 or col[9] == "lo" or int(col[4], 16) != 0 or int(col[1], 16) == 0:
                continue
            net = ipaddress.IPv6Network((bytes.fromhex(col[0]), int(col[1], 16)), strict=False)
            if not (net.is_link_local or net.is_multicast or net.is_loopback):
                nets.append(net)
except (OSError, ValueError):
    pass
nets = list(dict.fromkeys(str(n) for n in nets))
if not nets:
    sys.exit("space_start.sh: no network found for MOMMY_FORWARDED_ALLOW_IPS=container-networks")
print(",".join(nets))
') || MOMMY_FORWARDED_ALLOW_IPS=$TRUSTED_PROXIES
  echo "space_start.sh: X-Forwarded-For is taken from $MOMMY_FORWARDED_ALLOW_IPS" >&2
fi

# --timeout-keep-alive 75: longer than a reverse proxy keeps an idle connection, so the
# proxy never reuses one that uvicorn has just closed (a rare 502 on an upload).
# --no-access-log: uvicorn's access log would print every client address and path; the
# app's own log has only sizes and timings (docs/CONTRACT.md, hard rule 5).
exec uvicorn mommy.app:build_default_app --factory --host 0.0.0.0 --port 7860 \
  --proxy-headers --forwarded-allow-ips "${MOMMY_FORWARDED_ALLOW_IPS:-$TRUSTED_PROXIES}" \
  --timeout-keep-alive 75 --no-access-log

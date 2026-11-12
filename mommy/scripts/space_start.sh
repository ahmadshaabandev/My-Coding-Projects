#!/bin/sh
# Start Mommy inside the container image (the Dockerfile's CMD), on 0.0.0.0:7860.
#
# The image listens on every interface, so it must never run without the access gate:
# when MOMMY_ACCESS_CODE is unset or blank this script refuses to start (local use,
# without a gate, is ./run.sh, which listens on 127.0.0.1 only). The code itself is never
# printed. MOMMY_ALLOWED_HOSTS defaults to SPACE_HOST, the host name Hugging Face sets
# in every Space (deploy/huggingface/deploy.py also sets it as a Space variable).
set -eu

if [ -z "$(printf '%s' "${MOMMY_ACCESS_CODE:-}" | tr -d ' \t\r\n')" ]; then
  echo "space_start.sh: MOMMY_ACCESS_CODE is not set: refusing to serve the app on all" \
    "interfaces without the access gate. Set it as a Space secret" \
    "(deploy/huggingface/deploy.py does), or use ./run.sh for local use." >&2
  exit 1
fi

if [ -z "${MOMMY_ALLOWED_HOSTS:-}" ] && [ -n "${SPACE_HOST:-}" ]; then
  MOMMY_ALLOWED_HOSTS=$SPACE_HOST
  export MOMMY_ALLOWED_HOSTS
  echo "space_start.sh: MOMMY_ALLOWED_HOSTS taken from SPACE_HOST ($SPACE_HOST)" >&2
fi
if [ -n "${SPACE_HOST:-}" ]; then
  # The Space answers to SPACE_HOST only if it is in the list (otherwise 400 bad_host).
  case ",$(printf '%s' "${MOMMY_ALLOWED_HOSTS:-}" | tr -d ' ' | tr 'A-Z' 'a-z')," in
    *,"$(printf '%s' "$SPACE_HOST" | tr 'A-Z' 'a-z')",*) ;;
    *) echo "space_start.sh: warning: MOMMY_ALLOWED_HOSTS does not contain $SPACE_HOST:" \
         "requests for it will get 400 bad_host" >&2 ;;
  esac
fi

# --proxy-headers --forwarded-allow-ips '*': TLS ends at the Hugging Face proxy, whose
# addresses are not published; the container is reachable only through it, so its
# X-Forwarded-Proto (https: the access cookie gets Secure) and X-Forwarded-For (the
# client address the access gate counts failed attempts by) are taken as sent.
# --no-access-log: uvicorn's access log would print every client address and path; the
# app's own log has only sizes and timings (docs/CONTRACT.md, hard rule 5).
exec uvicorn mommy.app:build_default_app --factory --host 0.0.0.0 --port 7860 \
  --proxy-headers --forwarded-allow-ips '*' --no-access-log

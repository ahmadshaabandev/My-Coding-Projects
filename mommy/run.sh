#!/usr/bin/env bash
# Start Mommy: the API and the web client on http://127.0.0.1:${PORT:-8080}.
#
#   ./run.sh               listen on 127.0.0.1:8080
#   PORT=9000 ./run.sh     another port
#
# The server listens on the loopback interface only: children's audio and photos never
# leave this machine except to the Claude API, and only when it is configured (README.md).
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/uvicorn ]]; then
  echo "run.sh: .venv/bin/uvicorn not found. Install first:" >&2
  echo "  python3 -m venv .venv && .venv/bin/pip install --require-hashes -r requirements.lock" >&2
  exit 1
fi

export PYTHONPATH="backend${PYTHONPATH:+:${PYTHONPATH}}"
exec .venv/bin/uvicorn mommy.app:build_default_app --factory --host 127.0.0.1 --port "${PORT:-8080}"

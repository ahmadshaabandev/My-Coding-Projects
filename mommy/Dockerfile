# Mommy as a Hugging Face Docker Space (README.md, "Run it online"): "CPU basic" hardware
# (2 vCPU, 16 GB RAM), container port 7860, run as uid 1000, HTTPS ended by the Hugging
# Face proxy. deploy/huggingface/deploy.py uploads this file with the app.
#
# MOMMY_ACCESS_CODE (a Space secret) and MOMMY_ALLOWED_HOSTS (a Space variable) are read
# at run time and never written into the image; without the code the container refuses
# to start (MOMMY_REQUIRE_ACCESS_CODE below, and scripts/space_start.sh).
#
# Local test without the 1.2 GB of models in the image (they are mounted read-only):
#   docker build --build-arg SKIP_MODELS=1 -t mommy-space .
#   read -rs MOMMY_ACCESS_CODE && export MOMMY_ACCESS_CODE    # not on the command line
#   docker run --rm -p 127.0.0.1:7860:7860 -e MOMMY_ACCESS_CODE \
#     -e MOMMY_ALLOWED_HOSTS=localhost \
#     -v "$(readlink -f models/sherpa-onnx-whisper-turbo)":/home/user/app/models/sherpa-onnx-whisper-turbo:ro \
#     ... (the same for the three vits-piper-* voices) mommy-space
# Behind a TLS-intercepting proxy, add --network host and
# --secret id=build_ca,src=<CA bundle> to the build (read by curl and pip only, never
# stored in a layer).
#
# compose.yaml builds this same image to run Mommy on one's own computer behind a
# Cloudflare quick tunnel (SELF_HOST.md). It sets MOMMY_ACCESS_CODE_FILE (the code is
# made once and kept in the /data volume, see below) instead of MOMMY_ACCESS_CODE.
# The image builds natively for linux/amd64 and linux/arm64 (Apple Silicon): the base
# index lists both, and the lock holds the hash of a manylinux aarch64 wheel of every
# package with native code. The scripts it runs may have Windows line endings (a clone
# with core.autocrlf): their CRs are stripped before use (.gitattributes keeps LF too).

# Python 3.13: the version requirements.lock was resolved and tested on. "slim" already
# has everything the wheels link to (the C++ runtime, zlib); nothing else is installed
# in the runtime image. Pinned by digest (the multi-platform index of python:3.13-slim
# that was built and tested), so every build starts from the same bytes; to take a newer
# base, run python3 scripts/refresh_pins.py --write (it checks the index still lists
# linux/amd64 and linux/arm64), then build and test again.
ARG PYTHON_IMAGE=python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90

# --- Stage 1: the speech models ------------------------------------------------------
# A separate stage, so curl, bzip2 and the archives never reach the runtime image.
FROM ${PYTHON_IMAGE} AS models
# SKIP_MODELS=1 leaves models/ empty (for a local test with the models mounted).
ARG SKIP_MODELS=0
WORKDIR /build
COPY scripts/download_models.sh scripts/download_models.sh
# Turbo and the three Piper voices (no --small: the app uses turbo). The script checks
# the sha256 of every archive before unpacking it, so a replaced release file stops the
# build. "bash script": a Space repository does not keep the executable bit. test_wavs/
# are sample clips.
RUN --mount=type=secret,id=build_ca \
    set -eu; \
    mkdir -p models; \
    if [ "$SKIP_MODELS" = "1" ]; then \
      echo "SKIP_MODELS=1: no models in the image"; \
    else \
      apt-get update; \
      apt-get install -y --no-install-recommends curl bzip2; \
      rm -rf /var/lib/apt/lists/*; \
      if [ -s /run/secrets/build_ca ]; then export CURL_CA_BUNDLE=/run/secrets/build_ca; fi; \
      sed -i 's/\r$//' scripts/download_models.sh; \
      bash scripts/download_models.sh; \
      rm -rf models/*/test_wavs; \
    fi

# --- Stage 2: the runtime image -------------------------------------------------------
FROM ${PYTHON_IMAGE}

# Hugging Face runs the container as uid 1000 and expects a writable HOME. The app files
# stay owned by root (read-only for the app, which writes nothing to disk).
RUN useradd --create-home --uid 1000 user
ENV HOME=/home/user \
    PYTHONPATH=/home/user/app/backend \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MOMMY_ASR_THREADS=2 \
    MOMMY_REQUIRE_ACCESS_CODE=1
# PYTHONPATH: the app package lives in backend/ (as in run.sh), absolute so it does not
# depend on the working directory. MOMMY_ASR_THREADS=2: CPU basic has 2 vCPU. Logs are
# unbuffered so the Space's log view shows them at once. MOMMY_REQUIRE_ACCESS_CODE=1:
# the app's settings refuse to start without a usable MOMMY_ACCESS_CODE, whatever the
# start command (the image listens on every interface; ./run.sh does not set it).
WORKDIR /home/user/app

# Every package pinned and hashed, wheels only (nothing is compiled, so no compiler in
# the image); dependencies first, so that a code change reuses this layer. The runtime
# lock is requirements.lock without the test tools (scripts/lock_requirements.py).
COPY requirements-runtime.lock ./
RUN --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
    pip install --no-cache-dir --disable-pip-version-check --root-user-action=ignore \
      --require-hashes --only-binary=:all: -r requirements-runtime.lock

# The models change least often, then the app: only the files it runs (no tests, docs,
# virtual environment or model symlinks; .dockerignore also keeps them out).
COPY --from=models /build/models/ models/
COPY scripts/space_start.sh scripts/
COPY backend/ backend/
COPY web/ web/
COPY data/quran/ data/quran/
# Byte-compile now: the code directory is read-only for uid 1000, and a cold start
# (after the Space slept) should not compile anything. The start script loses any CR
# (a Windows checkout). /data, owned by uid 1000 and private to it, is where
# compose.yaml mounts its volume: a new named volume takes this owner and mode, so the
# app can write its access code file there (nothing else is written; unused on Hugging
# Face).
RUN sed -i 's/\r$//' scripts/space_start.sh \
    && python -m compileall -q backend \
    && install -d -o 1000 -g 1000 -m 700 /data

USER 1000:1000
EXPOSE 7860
# scripts/space_start.sh checks the access code is set, then runs
#   uvicorn mommy.app:build_default_app --factory --host 0.0.0.0 --port 7860
#     --proxy-headers --forwarded-allow-ips <private networks> --timeout-keep-alive 75
#     --no-access-log
# (the reasons for each option are in the script). "sh script": no executable bit needed.
CMD ["sh", "/home/user/app/scripts/space_start.sh"]

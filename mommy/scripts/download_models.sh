#!/usr/bin/env bash
# Fetch the local speech models (sherpa-onnx release archives) into models/.
#
#   scripts/download_models.sh           Whisper turbo + the Piper voices for ar, en and fr
#   scripts/download_models.sh --small   also Whisper small (use it with MOMMY_ASR_MODEL=small)
#   scripts/download_models.sh --check   only check that the download URLs answer (nothing is saved)
#
# Turbo is the default recogniser: on a 4-core CPU it is as fast as small once loaded,
# and markedly better on Arabic and on French homophones; it needs about 1 GB more RAM
# per loaded language. --turbo is accepted for compatibility (turbo is always fetched).
#
# Idempotent: a model whose directory already exists in models/ (a symlink is fine) is
# skipped, and only its expected files are checked. Each archive is downloaded and
# unpacked in a fresh temporary directory inside models/, and moved into place only when
# it holds the files the app needs.
set -euo pipefail

BASE="https://github.com/k2-fsa/sherpa-onnx/releases/download"

small=0
check=0
for arg in "$@"; do
  case "$arg" in
    --small) small=1 ;;
    --turbo) ;;
    --check) check=1 ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "download_models.sh: unknown option '$arg' (try --help)" >&2; exit 2 ;;
  esac
done

# name|release tag|files the app needs inside the model directory
models=(
  "sherpa-onnx-whisper-turbo|asr-models|turbo-encoder.int8.onnx turbo-decoder.int8.onnx turbo-tokens.txt"
  "vits-piper-ar_JO-kareem-medium|tts-models|ar_JO-kareem-medium.onnx tokens.txt espeak-ng-data"
  "vits-piper-en_US-lessac-medium|tts-models|en_US-lessac-medium.onnx tokens.txt espeak-ng-data"
  "vits-piper-fr_FR-siwis-medium|tts-models|fr_FR-siwis-medium.onnx tokens.txt espeak-ng-data"
)
if ((small)); then
  models+=("sherpa-onnx-whisper-small|asr-models|small-encoder.int8.onnx small-decoder.int8.onnx small-tokens.txt")
fi

cd "$(dirname "$0")/.."
command -v curl >/dev/null || { echo "download_models.sh: curl is required" >&2; exit 1; }

# Ask for the first byte only: release downloads redirect to signed URLs that may refuse
# HEAD, and the Content-Range header gives the archive size.
check_url() {
  local url=$1 headers size
  if ! headers=$(curl -fsSL --retry 2 -r 0-0 -o /dev/null -D - "$url"); then
    echo "FAIL  $url" >&2
    return 1
  fi
  size=$(printf '%s\n' "$headers" | tr -d '\r' | sed -n 's#^[Cc]ontent-[Rr]ange: bytes 0-0/\([0-9]*\)$#\1#p' | tail -n 1)
  if [[ -n "$size" ]]; then
    echo "ok    $url ($((size / 1024 / 1024)) MB)"
  else
    echo "ok    $url"
  fi
}

missing_files() {  # missing_files <dir> <files...>: print the expected files that are absent
  local dir=$1 f
  shift
  for f in "$@"; do
    [[ -e "$dir/$f" ]] || printf ' %s' "$f"
  done
}

tmp=""  # the download directory in use, removed on failure and on exit
cleanup() {
  if [[ -n "$tmp" && -d "$tmp" ]]; then rm -rf "$tmp"; fi
  tmp=""
}
trap cleanup EXIT

fail() {  # fail <message>: report, remove the partial download, return non-zero
  echo "error $1" >&2
  cleanup
  return 1
}

# fetch <name> <url> <files...>. Runs inside "|| status=1", where set -e is off, so every
# step is checked explicitly.
fetch() {
  local name=$1 url=$2 dest="models/$1" absent
  shift 2
  if [[ -e "$dest" ]]; then
    absent=$(missing_files "$dest" "$@")
    if [[ -n "$absent" ]]; then
      echo "warn  $name is in models/ but lacks:$absent (remove models/$name and run again)" >&2
    else
      echo "skip  $name (already in models/)"
    fi
    return 0
  fi
  if [[ -L "$dest" ]]; then
    fail "models/$name is a broken symlink: remove it and run again"
    return 1
  fi
  tmp=$(mktemp -d "models/.download-$name.XXXXXX") || { fail "cannot create a directory in models/"; return 1; }
  echo "get   $name"
  curl -fL --retry 3 --progress-bar -o "$tmp/archive.tar.bz2" "$url" || { fail "download of $url failed"; return 1; }
  tar -xjf "$tmp/archive.tar.bz2" -C "$tmp" --no-same-owner --no-same-permissions \
    || { fail "cannot unpack the $name archive"; return 1; }
  [[ -d "$tmp/$name" ]] || { fail "the $name archive has no $name/ directory"; return 1; }
  absent=$(missing_files "$tmp/$name" "$@")
  [[ -z "$absent" ]] || { fail "the $name archive lacks:$absent"; return 1; }
  mv "$tmp/$name" "$dest" || { fail "cannot move $name into models/"; return 1; }
  cleanup
  echo "done  models/$name"
}

status=0
mkdir -p models
for entry in "${models[@]}"; do
  IFS='|' read -r name tag files <<<"$entry"
  url="$BASE/$tag/$name.tar.bz2"
  if ((check)); then
    check_url "$url" || status=1
  else
    # shellcheck disable=SC2086  # the file list is meant to be split
    fetch "$name" "$url" $files || status=1
  fi
done
exit "$status"

#!/usr/bin/env bash
# Mommy on an Oracle Cloud "Always Free" VM. The steps for a non-expert, from signing up
# to sharing the link, are in deploy/oracle/ORACLE.md.
#
# Run it on the VM as your normal user ("ubuntu"), not with sudo (it asks for sudo
# itself where it needs it):
#
#   bash setup.sh             install or update, start, and print the link to share
#   bash setup.sh --stable    the same with a permanent link https://<IP>.sslip.io (Caddy)
#   bash setup.sh --tunnel    back to the Cloudflare quick tunnel (the default mode)
#   bash setup.sh --link      only print the current link
#   bash setup.sh --new-code  make a new access code, restart the app, print the new link
#   bash setup.sh --dry-run   (with any of the above) show what it would do, change nothing
#   bash setup.sh --yes       install an update of Mommy's files without asking (shown first)
#
# What it does: checks that this is Ubuntu 22.04 or 24.04 (aarch64 or x86_64); installs
# Docker Engine and the Compose plugin from Docker's own apt repository; adds a 4 GB
# swap file if there is no swap; clones or updates the branch below into ~/mommy-app;
# writes mommy/.env (the mode and the compose files; no secrets); for --stable, opens
# ports 80 and 443 in the VM's firewall (and --tunnel closes them again); runs "docker
# compose up -d --build" in ~/mommy-app/mommy; waits until the app is healthy; prints
# the link with the code. Docker starts at boot and the containers restart by
# themselves, so everything comes back after a reboot. A second run updates the code
# and restarts cleanly; the access code (in the Docker volume mommy-data) is kept. The
# chosen mode is remembered.
#
# Updates: what runs on this VM with full rights (this script, the compose files, the
# Dockerfile) comes from the branch below. A run never installs a new version silently:
# it shows the update (from which commit to which, its date and title, and whether it
# changes those files) and asks first; without a terminal to ask in, it only installs it
# with --yes. An update that rewrites the history you have (a force-push) is never
# installed without typing "yes" at that question. MOMMY_REF installs one given commit
# or tag instead of the branch's latest commit.
#
# The access code is never printed except inside the link, the last thing printed, and
# is never written to a log or a file by this script.
#
# Settings from the environment, for testing or advanced use (none is needed):
#   MOMMY_APP_DIR        where the code goes (default ~/mommy-app)
#   MOMMY_REPO_URL       the git repository (default below)
#   MOMMY_BRANCH         its branch (default below)
#   MOMMY_REF            a tag or a full commit id to use instead of the branch's latest
#                        commit (for that run: without it, the latest is offered again)
#   MOMMY_PUBLIC_HOST    --stable: this host name instead of <IP>.sslip.io (a domain of
#                        your own whose DNS A record points to the VM)
#   MOMMY_PUBLIC_IP      --stable: this public IPv4 address instead of looking it up
#   MOMMY_COMPOSE_EXTRA  more compose files, ":"-separated, relative to mommy/ (tests)
#   MOMMY_MIN_FREE_GB    the free disk space required, in GB (default 8; tests)
#   MOMMY_SWAP_GB        the size of the swap file made when there is none (default 4)

set -Eeuo pipefail

readonly DEFAULT_REPO_URL="https://github.com/ahmadshaabandev/My-Coding-Projects.git"
readonly DEFAULT_BRANCH="claude/laughing-goodall-h48bdw"
# Docker's apt signing key (https://docs.docker.com/engine/install/ubuntu/).
readonly DOCKER_KEY_URL="https://download.docker.com/linux/ubuntu/gpg"
readonly DOCKER_KEY_FPR="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
readonly DOCKER_PACKAGES="docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
# Ubuntu's own packages that conflict with Docker's (Docker's install page lists them).
readonly DOCKER_CONFLICTS="docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc"
# The oldest Docker kept as it is: compose.yaml needs Engine 25 (healthcheck
# start_interval), and Engine 28 is the first to keep a container's ports from other
# machines of the network that route to Docker's own addresses.
readonly MIN_ENGINE="28.0"
readonly MIN_COMPOSE="2.20"
SWAP_FILE="/swapfile"
# What this script made, so that it only ever undoes or reuses its own changes: the swap
# file, the firewall rules of --stable (plain marker files, no secrets).
STATE_DIR="/var/lib/mommy-setup"
SWAP_GB="${MOMMY_SWAP_GB:-4}"
readonly MIN_MEM_KB=4718592      # 4.5 GiB: below it, Mommy cannot run (about 5 GB at most)
readonly LOW_MEM_KB=7340032      # 7 GiB: below it, warn
# Free disk space needed: the image (about 2 GB), its build, the logs.
MIN_FREE_GB="${MOMMY_MIN_FREE_GB:-8}"
readonly RULES_V4="/etc/iptables/rules.v4"

DRY_RUN=0
ACTION="setup"     # setup | link | new-code
OPT_MODE=""        # "" (remembered, else tunnel) | tunnel | stable
NO_UPDATE=0        # internal: set when the updated copy of this script is re-run
ASSUME_YES=0       # --yes: install an update without asking
ROTATE_CODE=0      # set when the permanent link's host changed: the code changes too
HTTPS_OK=1         # stable mode: 0 when the HTTPS check failed (the link is held back)
PORTS_OPENED=0     # set when this run opened port 80 or 443 somewhere
STEP=0
STEPS=9
SUDO=""
ORIG_ARGS=()

REPO_URL="${MOMMY_REPO_URL:-$DEFAULT_REPO_URL}"
BRANCH="${MOMMY_BRANCH:-$DEFAULT_BRANCH}"
REF="${MOMMY_REF:-}"
APP_DIR="${MOMMY_APP_DIR:-$HOME/mommy-app}"
COMPOSE_DIR="$APP_DIR/mommy"
ENV_FILE="$COMPOSE_DIR/.env"
# How to run this script again, as the owner types it (in messages).
SCRIPT_CMD="bash ${COMPOSE_DIR/#"$HOME"/\~}/deploy/oracle/setup.sh"
MODE=""
PUBLIC_HOST=""
PUBLIC_IP=""
PUBLIC_IP_SOURCE=""
DOCKER_ENGINE=""
DOCKER_COMPOSE=""

# --- output ---------------------------------------------------------------------------

say()  { printf '%s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
# A check a real run stops at; --dry-run says so and goes on, to show the rest.
fail_check() {
  if (( DRY_RUN )); then
    printf '    A REAL RUN WOULD STOP HERE: %s\n' "$*" >&2
  else
    die "$*"
  fi
}
step() {
  STEP=$((STEP + 1))
  printf '\n==> [%d/%d] %s\n' "$STEP" "$STEPS" "$*"
}

on_error() {
  local status=$1 line=$2
  # In a subshell (a $(...) that failed), only that subshell ends; the main shell
  # decides, and reports, what happens next.
  [[ "$BASHPID" == "$$" ]] || exit "$status"
  printf '\nERROR: setup.sh stopped (exit status %s, line %s): the step above failed.\n' "$status" "$line" >&2
  printf 'Nothing is lost. Fix what the messages above say, then run the same command again:\n' >&2
  printf 'it is safe to run it as many times as needed.\n' >&2
  exit "$status"
}

usage() {
  sed -n '2,/^# What it does/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
}

# --- running commands -----------------------------------------------------------------

# run CMD...: CMD, or with --dry-run only what it would be.
run() {
  if (( DRY_RUN )); then
    printf '    would run: %s\n' "$*"
  else
    "$@"
  fi
}

# as_root CMD...: CMD as root (through sudo unless this is root), or --dry-run's line.
as_root() {
  if [[ -n "$SUDO" ]]; then run sudo "$@"; else run "$@"; fi
}

# root_read CMD...: CMD as root now, even with --dry-run (where sudo must not ask for a
# password: it fails instead). With --dry-run it is used for reads only; the writes that
# go through it are all in branches that --dry-run never takes.
root_read() {
  if [[ -z "$SUDO" ]]; then
    "$@"
  elif (( DRY_RUN )); then
    sudo -n "$@"
  else
    sudo "$@"
  fi
}

# write_root_file PATH MODE: standard input into PATH (as root).
write_root_file() {
  local path=$1 mode=$2 content
  content=$(cat)
  if (( DRY_RUN )); then
    printf '    would write %s (mode %s):\n' "$path" "$mode"
    printf '%s\n' "$content" | sed 's/^/        | /'
    return 0
  fi
  printf '%s\n' "$content" | root_read tee "$path" >/dev/null
  root_read chmod "$mode" "$path"
}

# apt_get ARGS...: apt-get, non-interactive, waiting for another apt (cloud-init or the
# automatic updates, often busy right after the VM starts) instead of failing: up to 15
# minutes for dpkg's locks (DPkg::Lock::Timeout) and for the package lists' lock, which
# "apt-get update" takes and DPkg::Lock::Timeout does not cover. Its output is shown
# only when it fails.
APT_LOCK_TRIES=90      # 90 x 10 s: 15 minutes
APT_LOCK_SLEEP=10
apt_get() {
  local log status tries=0
  if (( DRY_RUN )); then
    printf '    would run: %sapt-get %s\n' "${SUDO:+sudo }" "$*"
    return 0
  fi
  log=$(mktemp)
  while :; do
    status=0
    root_read env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l \
      apt-get -y -q -o DPkg::Lock::Timeout=900 "$@" </dev/null >"$log" 2>&1 || status=$?
    if (( status != 0 && tries < APT_LOCK_TRIES )) && grep -q 'Could not get lock /var/lib/apt/lists/lock' "$log"; then
      (( tries == 0 )) && info "Ubuntu is updating its package lists (usual just after the VM starts): waiting for it, up to 15 minutes..."
      tries=$((tries + 1))
      sleep "$APT_LOCK_SLEEP"
      continue
    fi
    break
  done
  if (( status != 0 )); then
    tail -n 25 "$log" >&2
    rm -f "$log"
    die "apt-get $1 failed (the lines above say why). Check the VM's internet access, then run this again."
  fi
  rm -f "$log"
}

# dc ARGS...: docker compose in mommy/ (it reads mommy/.env there), changing things.
dc() {
  if (( DRY_RUN )); then
    printf '    would run (in %s): %sdocker compose %s\n' "$COMPOSE_DIR" "${SUDO:+sudo }" "$*"
    return 0
  fi
  (cd "$COMPOSE_DIR" && root_read docker compose "$@")
}

# dc_read ARGS...: docker compose that only reads, also with --dry-run.
dc_read() {
  (cd "$COMPOSE_DIR" && root_read docker compose "$@")
}

# --- small checks ---------------------------------------------------------------------

# version_ge A B: version A is B or later ("29.1.3-0ubuntu3" against "25.0").
version_ge() {
  local a=${1#v} b=${2#v}
  [[ "$(printf '%s\n%s\n' "$b" "$a" | sort -V | head -n 1)" == "$b" ]]
}

dpkg_installed() {
  [[ "$(dpkg-query -W -f '${Status}' "$1" 2>/dev/null || true)" == "install ok installed" ]]
}

# is_public_ipv4 TEXT: an IPv4 address on the public internet (not a private, shared,
# loopback or reserved one).
is_public_ipv4() {
  python3 -I -c '
import ipaddress, sys
try:
    address = ipaddress.IPv4Address(sys.argv[1])
except ValueError:
    sys.exit(1)
sys.exit(0 if address.is_global else 1)
' "$1" 2>/dev/null
}

# is_host_name TEXT: a lower-case DNS name with at least two labels.
is_host_name() {
  local name=$1
  (( ${#name} <= 253 )) && [[ "$name" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
}

# host_for_ip IP: the sslip.io name of a public IPv4 address (1.2.3.4 -> 1-2-3-4.sslip.io).
host_for_ip() {
  printf '%s.sslip.io\n' "${1//./-}"
}

os_field() {
  # shellcheck disable=SC1091  # /etc/os-release exists on every system this supports
  (. /etc/os-release && eval "printf '%s\n' \"\${$1:-}\"")
}

# --- step 1: this machine -------------------------------------------------------------

check_machine() {
  step "Checking this machine"
  local id version pretty arch mem_kb avail_gb

  [[ -r /etc/os-release ]] || die "This is not Ubuntu (no /etc/os-release). Create the VM with the image Canonical Ubuntu 24.04 (ORACLE.md, step 2)."
  id=$(os_field ID)
  version=$(os_field VERSION_ID)
  pretty=$(os_field PRETTY_NAME)
  if [[ "$id" != ubuntu || ( "$version" != 22.04 && "$version" != 24.04 ) ]]; then
    die "This script is for Ubuntu 22.04 or 24.04, and this is ${pretty:-an unknown system}: other systems install Docker and open their firewall differently. Create the VM with the image Canonical Ubuntu 24.04 (ORACLE.md, step 2)."
  fi
  arch=$(uname -m)
  case "$arch" in
    aarch64 | x86_64) ;;
    *) die "This script is for aarch64 (Ampere A1) or x86_64 machines, and this one is $arch." ;;
  esac
  info "System: $pretty, $arch"
  if [[ -n "$SUDO" ]] && ! command -v sudo >/dev/null; then
    die "sudo is missing: this script needs it to install Docker."
  fi

  mem_kb=$(awk '$1 == "MemTotal:" { print $2 }' /proc/meminfo)
  if (( mem_kb < MIN_MEM_KB )); then
    fail_check "This VM has $(( mem_kb / 1024 )) MB of memory; Mommy needs about 5 GB. Use the shape VM.Standard.A1.Flex with 12 GB (ORACLE.md, step 2)."
  fi
  if (( mem_kb < LOW_MEM_KB )); then
    warn "This VM has $(( mem_kb / 1024 )) MB of memory: Mommy needs up to about 5 GB, so it will be tight (the swap file helps)."
  fi
  info "Memory: $(( mem_kb / 1024 )) MB, $(nproc) CPU core(s)"

  local probe=$APP_DIR
  while [[ ! -d "$probe" ]]; do probe=$(dirname "$probe"); done
  avail_gb=$(( $(df -Pk "$probe" | awk 'NR == 2 { print $4 }') / 1048576 ))
  if (( avail_gb < MIN_FREE_GB )); then
    fail_check "Only $avail_gb GB of disk space is free; Mommy needs at least $MIN_FREE_GB GB (more for the swap file)."
  fi
  info "Free disk space: $avail_gb GB"

  check_oracle_shape

  if [[ -n "$SUDO" ]]; then
    if (( DRY_RUN )); then
      sudo -n true 2>/dev/null || info "(sudo asks for a password here: --dry-run skips the checks that need it)"
    else
      sudo true || die "sudo did not work: this script needs it to install Docker."
    fi
  fi
}

# On Oracle Cloud, the instance metadata service tells the shape; warn when this one VM
# alone is over the Always Free allowance for Ampere A1 (2 OCPUs, 12 GB in all).
check_oracle_shape() {
  local meta summary shape ocpus memory region over
  meta=$(curl -fsS --noproxy '*' -m 3 -H 'Authorization: Bearer Oracle' \
    http://169.254.169.254/opc/v2/instance/ 2>/dev/null) || {
    info "Not on Oracle Cloud, or its metadata service did not answer: shape not checked."
    return 0
  }
  summary=$(python3 -I -c '
import json, sys
try:
    data = json.loads(sys.stdin.read())
    shape = str(data.get("shape", "?"))
    config = data.get("shapeConfig") or {}
    ocpus = float(config.get("ocpus") or 0)
    memory = float(config.get("memoryInGBs") or 0)
    region = str(data.get("canonicalRegionName") or data.get("region") or "?")
except (ValueError, TypeError, AttributeError):
    sys.exit(1)
over = "A1" in shape and (ocpus > 2 or memory > 12)
print(f"{shape}|{ocpus:g}|{memory:g}|{region}|{int(over)}")
' <<<"$meta" 2>/dev/null) || return 0
  IFS='|' read -r shape ocpus memory region over <<<"$summary"
  info "Oracle Cloud VM: $shape, $ocpus OCPU(s), $memory GB, region $region"
  if [[ "$over" == 1 ]]; then
    warn "This VM alone is over the Always Free allowance for Ampere A1 (2 OCPUs and 12 GB in all, for every A1 VM of your account together). Oracle may disable or charge for it: change its shape to 2 OCPUs and 12 GB (ORACLE.md, \"Staying free\")."
  fi
}

# --- step 2: system packages ----------------------------------------------------------

install_base_packages() {
  step "System packages (git, curl, certificates)"
  # Right after the VM is made, cloud-init is still setting it up (and running apt).
  if ! (( DRY_RUN )) && command -v cloud-init >/dev/null 2>&1; then
    if ! cloud-init status 2>/dev/null | grep -q 'status: done'; then
      info "Waiting for the VM's first-boot setup (cloud-init) to finish..."
      root_read cloud-init status --wait >/dev/null 2>&1 || true
    fi
  fi
  apt_get update
  apt_get install --no-install-recommends ca-certificates curl gnupg git python3
  (( DRY_RUN )) || info "Up to date."
}

# --- step 3: Docker -------------------------------------------------------------------

# docker_versions: sets DOCKER_ENGINE and DOCKER_COMPOSE; fails when Docker or its
# Compose plugin does not answer.
docker_versions() {
  DOCKER_ENGINE=""
  DOCKER_COMPOSE=""
  command -v docker >/dev/null 2>&1 || return 1
  DOCKER_ENGINE=$(root_read docker version --format '{{.Server.Version}}' 2>/dev/null) || return 1
  DOCKER_COMPOSE=$(root_read docker compose version --short 2>/dev/null) || return 1
}

docker_good_enough() {
  docker_versions || return 1
  version_ge "$DOCKER_ENGINE" "$MIN_ENGINE" && version_ge "$DOCKER_COMPOSE" "$MIN_COMPOSE"
}

add_docker_repo() {
  local codename arch tmp fpr
  if grep -rqs --include='*.list' --include='*.sources' 'download.docker.com' /etc/apt/sources.list /etc/apt/sources.list.d/; then
    info "Docker's apt repository is already set up."
    return 0
  fi
  codename=$(os_field UBUNTU_CODENAME)
  [[ -n "$codename" ]] || codename=$(os_field VERSION_CODENAME)
  arch=$(dpkg --print-architecture)
  info "Adding Docker's apt repository (download.docker.com, $codename, $arch)."
  if (( DRY_RUN )); then
    info "would download $DOCKER_KEY_URL and check that its fingerprint is $DOCKER_KEY_FPR"
  else
    tmp=$(mktemp -d)
    mkdir -m 700 "$tmp/gnupg"
    curl -fsSL --proto '=https' --tlsv1.2 -m 60 -o "$tmp/docker.asc" "$DOCKER_KEY_URL" \
      || die "Could not download Docker's signing key from $DOCKER_KEY_URL."
    fpr=$(GNUPGHOME="$tmp/gnupg" gpg --batch --show-keys --with-colons "$tmp/docker.asc" 2>/dev/null \
      | awk -F: '$1 == "fpr" { print $10; exit }')
    if [[ "$fpr" != "$DOCKER_KEY_FPR" ]]; then
      rm -rf "$tmp"
      die "Docker's signing key has the fingerprint '${fpr:-none}', not $DOCKER_KEY_FPR: not installing it."
    fi
    info "Docker's signing key checked (fingerprint $DOCKER_KEY_FPR)."
  fi
  as_root install -m 0755 -d /etc/apt/keyrings
  if (( DRY_RUN )); then
    as_root install -m 0644 "<the key>" /etc/apt/keyrings/docker.asc
  else
    as_root install -m 0644 "$tmp/docker.asc" /etc/apt/keyrings/docker.asc
    rm -rf "$tmp"
  fi
  write_root_file /etc/apt/sources.list.d/docker.sources 0644 <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt_get update
}

install_docker() {
  step "Docker Engine and Docker Compose"
  local pkg conflicts=()

  if command -v snap >/dev/null 2>&1 && snap list docker >/dev/null 2>&1; then
    die "Docker is installed as a snap, which this setup does not support. Remove it (sudo snap remove docker), then run this again."
  fi

  if dpkg_installed docker-ce; then
    info "Docker from Docker's repository: updating it if a newer version is out."
    add_docker_repo
    # shellcheck disable=SC2086  # a list of package names
    apt_get install $DOCKER_PACKAGES
  elif docker_good_enough; then
    info "Docker is already installed (Engine $DOCKER_ENGINE, Compose $DOCKER_COMPOSE): kept as it is."
  else
    if docker_versions; then
      info "The installed Docker (Engine $DOCKER_ENGINE, Compose $DOCKER_COMPOSE) is too old (Engine $MIN_ENGINE and Compose $MIN_COMPOSE or later are needed): replacing it with Docker's own packages. Images and volumes are kept."
    else
      info "Installing Docker Engine and the Compose plugin from Docker's own apt repository."
    fi
    for pkg in $DOCKER_CONFLICTS; do
      if dpkg_installed "$pkg"; then conflicts+=("$pkg"); fi
    done
    if (( ${#conflicts[@]} )); then
      info "Removing Ubuntu's packages that conflict with Docker's: ${conflicts[*]}"
      apt_get remove "${conflicts[@]}"
    fi
    add_docker_repo
    # shellcheck disable=SC2086
    apt_get install $DOCKER_PACKAGES
  fi

  # Started now and at every boot (the containers then restart by themselves).
  as_root systemctl enable --now docker.service
  (( DRY_RUN )) && return 0
  local i
  for i in $(seq 1 30); do
    root_read docker info >/dev/null 2>&1 && break
    (( i == 30 )) && die "Docker does not answer (sudo docker info). See: sudo systemctl status docker"
    sleep 1
  done
  docker_good_enough || die "Docker is installed but does not work as needed (Engine '${DOCKER_ENGINE:-?}', Compose '${DOCKER_COMPOSE:-?}'; Engine $MIN_ENGINE and Compose $MIN_COMPOSE or later are needed)."
  info "Docker Engine $DOCKER_ENGINE, Docker Compose $DOCKER_COMPOSE; starts at boot."
}

# --- step 4: swap ---------------------------------------------------------------------

ensure_swap() {
  step "Swap file (room to spare while the image builds)"
  local active avail_gb
  active=$(swapon --show=NAME,SIZE --noheadings 2>/dev/null | awk '{ print $1 " (" $2 ")" }' | paste -sd ' ' -)
  if [[ -n "$active" ]]; then
    info "Swap is already on: $active"
    return 0
  fi
  if [[ -e "$SWAP_FILE" || -L "$SWAP_FILE" ]]; then
    # Only a plain file that is a swap area already, or the one this script made (an
    # earlier run that stopped half-way): anything else may be someone's data.
    if [[ -L "$SWAP_FILE" || ! -f "$SWAP_FILE" ]]; then
      warn "$SWAP_FILE is not a plain file: left as it is, and no swap file is used."
      return 0
    fi
    if [[ "$(root_read blkid -p -s TYPE -o value "$SWAP_FILE" 2>/dev/null || true)" == swap ]]; then
      info "Turning on the existing $SWAP_FILE (readable by root only)."
    elif root_read test -f "$STATE_DIR/swapfile-made" 2>/dev/null; then
      info "Finishing the swap file an earlier run started ($SWAP_FILE)."
      as_root mkswap "$SWAP_FILE"
    else
      warn "$SWAP_FILE exists but is not a swap area, and this setup did not make it: left as it is, and no swap file is used (move it away and run this again to get one)."
      return 0
    fi
    as_root chown root:root "$SWAP_FILE"
    as_root chmod 600 "$SWAP_FILE"
    as_root swapon "$SWAP_FILE"
  else
    avail_gb=$(( $(df -Pk / | awk 'NR == 2 { print $4 }') / 1048576 ))
    if (( avail_gb < SWAP_GB + MIN_FREE_GB )); then
      warn "Only $avail_gb GB free on /: no swap file made (it needs $SWAP_GB GB besides Mommy's $MIN_FREE_GB GB)."
      return 0
    fi
    info "Making a $SWAP_GB GB swap file, $SWAP_FILE (readable by root only)."
    as_root install -m 600 -o root -g root /dev/null "$SWAP_FILE"
    as_root install -d -m 755 "$STATE_DIR"
    as_root touch "$STATE_DIR/swapfile-made"
    if (( DRY_RUN )); then
      as_root fallocate -l "${SWAP_GB}G" "$SWAP_FILE"
    elif ! root_read fallocate -l "${SWAP_GB}G" "$SWAP_FILE" 2>/dev/null; then
      # A file system without fallocate: written out instead (slower).
      root_read dd if=/dev/zero of="$SWAP_FILE" bs=1M count=$(( SWAP_GB * 1024 )) status=none
    fi
    as_root mkswap "$SWAP_FILE"
    as_root swapon "$SWAP_FILE"
  fi
  if grep -Eqs "^[[:space:]]*${SWAP_FILE}[[:space:]]" /etc/fstab; then
    info "$SWAP_FILE is already in /etc/fstab (on at every boot)."
  else
    info "Adding $SWAP_FILE to /etc/fstab (on at every boot)."
    if (( DRY_RUN )); then
      info "would add the line: $SWAP_FILE none swap sw 0 0"
    else
      printf '%s none swap sw 0 0\n' "$SWAP_FILE" | root_read tee -a /etc/fstab >/dev/null
    fi
  fi
}

# --- step 5: the code -----------------------------------------------------------------

# The files whose change matters most: they run with full rights on this VM.
readonly POWERFUL_FILES="mommy/deploy/oracle/setup.sh mommy/compose.yaml mommy/deploy/oracle/compose.oracle.yaml mommy/deploy/oracle/compose.stable.yaml mommy/deploy/oracle/Caddyfile mommy/Dockerfile mommy/scripts/space_start.sh"
UPDATED=0

# confirm QUESTION: true when the owner answers yes. A question that matters more (a
# rewritten history) needs the word "yes" itself, and --yes does not answer it.
confirm() {
  local question=$1 strict=${2:-} answer=""
  if [[ -z "$strict" ]] && (( ASSUME_YES )); then
    info "$question yes (--yes)"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    return 1
  fi
  printf '    %s ' "$question"
  read -r answer || answer=""
  if [[ -n "$strict" ]]; then
    [[ "$answer" == yes ]]
  else
    [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
  fi
}

# describe_commit REV: "<short id> of <date>, \"<title>\"".
describe_commit() {
  git -C "$APP_DIR" log -1 --format='%h of %cd, "%s"' --date=short "$1"
}

# fetch_target: the commit to run (FETCH_HEAD): the branch's latest commit, or MOMMY_REF.
fetch_target() {
  if [[ -z "$REF" ]]; then
    git -C "$APP_DIR" fetch --quiet --no-tags "$REPO_URL" "refs/heads/$BRANCH"
  elif [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
    git -C "$APP_DIR" fetch --quiet --no-tags "$REPO_URL" "$REF"
  else
    git -C "$APP_DIR" fetch --quiet --no-tags "$REPO_URL" "refs/tags/$REF"
  fi
}

update_code() {
  local target="branch $BRANCH" new old changed powerful
  [[ -n "$REF" ]] && target="version $REF"
  step "Mommy's files ($APP_DIR, $target)"
  if [[ -d "$APP_DIR/.git" ]]; then
    info "Looking for an update at $REPO_URL"
    if (( DRY_RUN )); then
      info "would run: git -C $APP_DIR fetch $REPO_URL, then show any update and ask before installing it"
      return 0
    fi
    fetch_target || die "Could not get Mommy's files from $REPO_URL ($target). Check the VM's internet access, then run this again."
    new=$(git -C "$APP_DIR" rev-parse --verify --quiet 'FETCH_HEAD^{commit}') || die "No commit at $target."
    if [[ "$REF" =~ ^[0-9a-f]{40}$ && "$new" != "$REF" ]]; then
      die "The repository gave commit $new for $REF."
    fi
    old=$(git -C "$APP_DIR" rev-parse --verify --quiet 'HEAD^{commit}' || true)
    if [[ "$new" == "$old" ]]; then
      info "Up to date: $(describe_commit "$new")."
    else
      info "An update is available:"
      info "  now:  ${old:+$(describe_commit "$old")}"
      info "  new:  $(describe_commit "$new")"
      changed=$(git -C "$APP_DIR" diff --name-only "${old:-$new}" "$new" -- 2>/dev/null | wc -l | tr -d ' ')
      # shellcheck disable=SC2086  # a list of paths
      powerful=$(git -C "$APP_DIR" diff --name-only "${old:-$new}" "$new" -- $POWERFUL_FILES 2>/dev/null | sed 's|^mommy/||' | paste -sd ' ' -)
      info "  it changes $changed file(s)${powerful:+, among them some that run with full rights on this VM: $powerful}"
      if [[ -n "$old" ]] && ! git -C "$APP_DIR" merge-base --is-ancestor "$old" "$new"; then
        warn "This update does not continue the version you have: the branch's history was rewritten (a force-push). Install it only if you expected that."
        if ! confirm 'Install it anyway? Type "yes" to install it:' strict; then
          info "Not updated: going on with the version you have. (To install it, run this again in a terminal and type yes.)"
          return 0
        fi
      elif ! confirm "Install this update? [y/N]"; then
        if [[ -t 0 ]]; then
          info "Not updated: going on with the version you have."
        else
          info "Not updated: no terminal to ask in. Run this again in a terminal, or with --yes to install updates without asking."
        fi
        return 0
      fi
      if [[ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no)" ]]; then
        warn "Some files in $APP_DIR were changed by hand: they are put aside (git -C $APP_DIR stash list shows them) so that the update can go on."
        git -C "$APP_DIR" stash push --quiet -m "put aside by setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      fi
      if [[ -z "$REF" ]]; then
        git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "$new"
      else
        git -C "$APP_DIR" checkout --quiet --detach "$new"
      fi
      UPDATED=1
    fi
  elif [[ -e "$APP_DIR" && -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]]; then
    die "$APP_DIR exists but is not a git checkout: move it away (mv $APP_DIR $APP_DIR.old), then run this again."
  else
    info "Downloading from $REPO_URL"
    run git clone --quiet --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
    (( DRY_RUN )) && return 0
    if [[ -n "$REF" ]]; then
      fetch_target || die "Could not get $target from $REPO_URL."
      git -C "$APP_DIR" checkout --quiet --detach FETCH_HEAD
    fi
  fi
  (( DRY_RUN )) && return 0
  [[ -f "$COMPOSE_DIR/compose.yaml" ]] || die "$COMPOSE_DIR/compose.yaml is missing: is $BRANCH the right branch?"
  # mommy/.env holds this VM's settings: never part of the checkout (git status stays clean).
  if ! grep -qsx '/mommy/.env' "$APP_DIR/.git/info/exclude"; then
    printf '/mommy/.env\n' >>"$APP_DIR/.git/info/exclude"
  fi
  info "Now at $(git -C "$APP_DIR" log -1 --format='commit %h of %cd' --date=short)."
}

# The updated copy of this script runs the rest, when the update (that the owner just
# agreed to) changed it.
rerun_if_updated() {
  local new="$COMPOSE_DIR/deploy/oracle/setup.sh"
  (( DRY_RUN || NO_UPDATE || ! UPDATED )) && return 0
  [[ -f "$new" ]] || return 0
  if [[ "$(sha256sum <"$new")" != "$SELF_SUM" ]]; then
    info "This script itself was updated: going on with the new version."
    exec bash "$new" --no-update "${ORIG_ARGS[@]}"
  fi
}

# --- step 6: settings -----------------------------------------------------------------

env_value() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

# The lines setup.sh owns in mommy/.env, between two markers; other lines are kept.
write_env() {
  local files="compose.yaml:deploy/oracle/compose.oracle.yaml" threads tmp
  [[ "$MODE" == stable ]] && files="$files:deploy/oracle/compose.stable.yaml"
  [[ -n "${MOMMY_COMPOSE_EXTRA:-}" ]] && files="$files:$MOMMY_COMPOSE_EXTRA"
  threads=$(nproc)
  (( threads > 4 )) && threads=4
  local block
  block="# --- written by deploy/oracle/setup.sh: begin (no secrets; rewritten on each run) ---
COMPOSE_FILE=$files
MOMMY_MODE=$MODE
MOMMY_ASR_THREADS=$threads"
  [[ "$MODE" == stable ]] && block="$block
MOMMY_PUBLIC_HOST=$PUBLIC_HOST"
  # The last permanent link's host, also in the tunnel mode: a later --stable on another
  # address then knows that the old link (with the code) exists.
  local last=${PUBLIC_HOST:-$(env_value MOMMY_LAST_PUBLIC_HOST)}
  [[ -n "$last" ]] && block="$block
MOMMY_LAST_PUBLIC_HOST=$last"
  block="$block
# --- written by deploy/oracle/setup.sh: end ---"
  if (( DRY_RUN )); then
    info "would write these lines to $ENV_FILE (docker compose reads it in mommy/):"
    printf '%s\n' "$block" | sed 's/^/        | /'
    return 0
  fi
  tmp=$(mktemp "$COMPOSE_DIR/.env.XXXXXX")
  {
    if [[ -f "$ENV_FILE" ]]; then
      awk '
        /^# --- written by deploy\/oracle\/setup.sh: begin/ { skip = 1; next }
        /^# --- written by deploy\/oracle\/setup.sh: end/ { skip = 0; next }
        skip { next }
        /^(COMPOSE_FILE|MOMMY_MODE|MOMMY_ASR_THREADS|MOMMY_PUBLIC_HOST|MOMMY_LAST_PUBLIC_HOST)=/ { next }
        { print }
      ' "$ENV_FILE"
    fi
    printf '%s\n' "$block"
  } >"$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$ENV_FILE"
  info "Settings saved in $ENV_FILE: mode $MODE, $threads recognition thread(s)."
}

# The public "what is my address" services asked (over HTTPS) when Oracle's metadata
# does not say. Two of them must give the same address: one wrong answer must not decide
# the host of the link that carries the code.
ECHO_SERVICES="https://checkip.amazonaws.com https://api.ipify.org https://ipv4.icanhazip.com"

find_public_ip() {
  local ip="" source="" service answer answers=() sources=() i j
  if [[ -n "${MOMMY_PUBLIC_IP:-}" ]]; then
    ip=$MOMMY_PUBLIC_IP
    source="MOMMY_PUBLIC_IP"
  else
    # Oracle's instance metadata service, in case it lists the address (it usually lists
    # only the private one), then a public "what is my address" service over HTTPS.
    ip=$(curl -fsS --noproxy '*' -m 3 -H 'Authorization: Bearer Oracle' \
      http://169.254.169.254/opc/v2/vnics/ 2>/dev/null | python3 -I -c '
import json, sys
try:
    vnics = json.loads(sys.stdin.read())
    print(next(v["publicIp"] for v in vnics if isinstance(v, dict) and v.get("publicIp")))
except (ValueError, StopIteration, TypeError, KeyError):
    pass
' 2>/dev/null || true)
    if [[ -n "$ip" ]] && is_public_ipv4 "$ip"; then
      source="Oracle's instance metadata"
    else
      ip=""
      for service in $ECHO_SERVICES; do
        answer=$(curl -4 -fsS --proto '=https' -m 10 "$service" 2>/dev/null | tr -d '[:space:]' || true)
        if [[ -n "$answer" ]] && is_public_ipv4 "$answer"; then
          answers+=("$answer")
          sources+=("${service#https://}")
        fi
      done
      for (( i = 0; i < ${#answers[@]}; i++ )); do
        for (( j = i + 1; j < ${#answers[@]}; j++ )); do
          if [[ "${answers[i]}" == "${answers[j]}" ]]; then
            ip=${answers[i]}
            source="${sources[i]} and ${sources[j]}"
            break 2
          fi
        done
      done
      if [[ -z "$ip" && ${#answers[@]} -eq 1 ]]; then
        die "Only one of the services that tell an address answered (${sources[0]}: ${answers[0]}), and two must agree. In the Oracle console, the instance's page shows the address under \"Public IP address\": run again with it, for example: MOMMY_PUBLIC_IP=203.0.113.10 $SCRIPT_CMD --stable"
      fi
      if [[ -z "$ip" && ${#answers[@]} -gt 1 ]]; then
        die "The services that tell an address did not agree on this VM's public IPv4 address (${answers[*]}). In the Oracle console, the instance's page shows it under \"Public IP address\": run again with it, for example: MOMMY_PUBLIC_IP=203.0.113.10 $SCRIPT_CMD --stable"
      fi
    fi
  fi
  if [[ -z "$ip" ]] || ! is_public_ipv4 "$ip"; then
    die "Could not find this VM's public IPv4 address${ip:+ ($ip is not a public address)}. In the Oracle console, the instance's page shows it under \"Public IP address\": run again with it, for example: MOMMY_PUBLIC_IP=203.0.113.10 $SCRIPT_CMD --stable"
  fi
  PUBLIC_IP=$ip
  PUBLIC_IP_SOURCE=$source
}

configure() {
  step "Settings"
  local previous
  previous=$(env_value MOMMY_MODE)
  MODE=${OPT_MODE:-${previous:-tunnel}}
  if [[ -n "$previous" && "$previous" != "$MODE" ]]; then
    info "Switching from the $previous mode to the $MODE mode."
  fi
  if [[ "$MODE" == stable ]]; then
    if [[ -n "${MOMMY_PUBLIC_HOST:-}" ]]; then
      PUBLIC_HOST=${MOMMY_PUBLIC_HOST,,}
      PUBLIC_HOST=${PUBLIC_HOST%.}
      is_host_name "$PUBLIC_HOST" || die "MOMMY_PUBLIC_HOST ($MOMMY_PUBLIC_HOST) is not a host name."
      info "Permanent link host: $PUBLIC_HOST (from MOMMY_PUBLIC_HOST)"
    else
      find_public_ip
      PUBLIC_HOST=$(host_for_ip "$PUBLIC_IP")
      info "Public IPv4 address: $PUBLIC_IP (from $PUBLIC_IP_SOURCE)"
      info "Permanent link host: $PUBLIC_HOST"
    fi
    local old_host
    old_host=$(env_value MOMMY_PUBLIC_HOST)
    [[ -n "$old_host" ]] || old_host=$(env_value MOMMY_LAST_PUBLIC_HOST)
    if [[ -n "$old_host" && "$old_host" != "$PUBLIC_HOST" ]]; then
      warn "The permanent link's host changes from $old_host to $PUBLIC_HOST (the VM's address changed). The old link leads to an address Oracle may give to someone else, and it holds the code: so the access code changes too, and the old link and code stop working. Send the new link."
      ROTATE_CODE=1
    fi
    open_web_ports
  else
    info "Link mode: Cloudflare quick tunnel (no port to open; the link changes when the tunnel restarts)."
    close_web_ports
  fi
  write_env
}

# --- the VM's firewall (stable mode) --------------------------------------------------
#
# Oracle's Ubuntu images come with iptables rules that reject every new connection but
# SSH: "-A INPUT -j REJECT --reject-with icmp-host-prohibited" ends the INPUT chain.
# Ports 80 and 443 are let in by two ACCEPT rules just before that REJECT rule, live and
# in /etc/iptables/rules.v4, the file netfilter-persistent loads at boot. The rest of
# that file is kept as it is. (Not "netfilter-persistent save": it would also write
# Docker's own rules, which Docker makes again each time it starts, into that file.)

accept_rule() { printf -- '-p tcp -m state --state NEW -m tcp --dport %s -j ACCEPT' "$1"; }

# open_port PORT: the live ACCEPT rule for PORT, before the first REJECT or DROP rule.
open_port() {
  local port=$1 spec rules line n=0 ours=0 reject=0 policy
  spec=$(accept_rule "$port")
  rules=$(root_read iptables -S INPUT 2>/dev/null) || {
    if (( DRY_RUN )); then
      info "Port $port: not checked (sudo iptables -S INPUT did not answer; with --dry-run, sudo is never asked for a password)."
    else
      warn "Port $port: cannot read the VM's firewall (sudo iptables -S INPUT failed), so it is not opened there."
    fi
    return 0
  }
  policy=$(awk '$1 == "-P" && $2 == "INPUT" { print $3 }' <<<"$rules")
  while IFS= read -r line; do
    [[ "$line" == "-A INPUT "* ]] || continue
    n=$((n + 1))
    if (( ours == 0 )) && [[ "$line" == "-A INPUT $spec" ]]; then ours=$n; fi
    if (( reject == 0 )) && [[ "$line" == *" -j REJECT"* || "$line" == *" -j DROP" ]]; then reject=$n; fi
  done <<<"$rules"
  if (( ours > 0 )) && (( reject == 0 || ours < reject )); then
    info "Port $port: already open in the VM's firewall."
    return 0
  fi
  if (( reject > 0 )); then
    if (( ours > 0 )); then
      # shellcheck disable=SC2086  # the rule's words
      as_root iptables -D INPUT $spec
    fi
    info "Port $port: opening it in the VM's firewall (before its REJECT rule)."
    # shellcheck disable=SC2086
    as_root iptables -I INPUT "$reject" $spec
    PORTS_OPENED=1
  elif [[ "$policy" == DROP || "$policy" == REJECT ]]; then
    info "Port $port: opening it in the VM's firewall."
    # shellcheck disable=SC2086
    as_root iptables -A INPUT $spec
    PORTS_OPENED=1
  else
    info "Port $port: the VM's firewall does not block it."
  fi
}

# rules_with_ports: rules.v4 (standard input) with the two ACCEPT rules before the first
# REJECT or DROP rule of the filter table's INPUT chain (standard output).
rules_with_ports() {
  awk -v r80="-A INPUT $(accept_rule 80)" -v r443="-A INPUT $(accept_rule 443)" '
    { line[NR] = $0 }
    /^\*/ { table = substr($0, 2) }
    { tab[NR] = table }
    table == "filter" && $0 == "COMMIT" && !commit { commit = NR }
    table == "filter" && $0 ~ /^:INPUT (DROP|REJECT) / { closed = 1 }
    table == "filter" && !reject && $0 ~ /^-A INPUT / && ($0 ~ / -j REJECT/ || $0 ~ / -j DROP$/) { reject = NR }
    END {
      at = reject ? reject : (closed ? commit : 0)
      for (i = 1; i < at; i++) if (tab[i] == "filter") have[line[i]] = 1
      for (i = 1; i <= NR; i++) {
        if (i == at) {
          if (!(r80 in have)) print r80
          if (!(r443 in have)) print r443
        }
        # A copy after the REJECT rule would never be reached: dropped.
        if (at && i > at && tab[i] == "filter" && (line[i] == r80 || line[i] == r443)) continue
        print line[i]
      }
    }
  '
}

# rules_without_ports: rules.v4 (standard input) without the two ACCEPT rules of
# rules_with_ports in the filter table (standard output); the rest as it is.
rules_without_ports() {
  awk -v r80="-A INPUT $(accept_rule 80)" -v r443="-A INPUT $(accept_rule 443)" '
    /^\*/ { table = substr($0, 2) }
    table == "filter" && ($0 == r80 || $0 == r443) { next }
    { print }
  '
}

# close_web_ports: undoes open_web_ports, when this script opened the ports (its marker,
# or the copy of rules.v4 it made first): the live rules, rules.v4 and ufw's rules.
close_web_ports() {
  local marker="$STATE_DIR/ports-opened" port spec current updated used_ufw=0 left=0
  if ! root_read test -e "$marker" 2>/dev/null; then
    # No marker: an older setup.sh may still have opened them (it kept a copy of rules.v4
    # first); then only rules of exactly this script's text are taken out.
    [[ -e "$RULES_V4.before-mommy" ]] || return 0
    for port in 80 443; do
      # shellcheck disable=SC2046  # the rule's words
      root_read iptables -C INPUT $(accept_rule "$port") 2>/dev/null && left=1
      root_read grep -qxF -- "-A INPUT $(accept_rule "$port")" "$RULES_V4" 2>/dev/null && left=1
    done
    (( left )) || return 0
  fi
  info "Closing ports 80 and 443 again in the VM's firewall (the permanent link opened them; nothing uses them now)."
  root_read grep -qsx ufw "$marker" 2>/dev/null && used_ufw=1
  if command -v iptables >/dev/null 2>&1; then
    for port in 80 443; do
      spec=$(accept_rule "$port")
      # shellcheck disable=SC2086  # the rule's words
      while root_read iptables -C INPUT $spec 2>/dev/null; do
        as_root iptables -D INPUT $spec
        (( DRY_RUN )) && break
      done
    done
    if [[ -f "$RULES_V4" ]] && current=$(root_read cat "$RULES_V4" 2>/dev/null); then
      updated=$(rules_without_ports <<<"$current")
      if [[ "$updated" != "$current" ]]; then
        info "Removing the two rules from $RULES_V4 (loaded at boot)."
        if (( DRY_RUN )); then
          diff <(printf '%s\n' "$current") <(printf '%s\n' "$updated") | sed 's/^/        | /' || true
        else
          printf '%s\n' "$updated" | root_read iptables-restore --test \
            || die "The updated $RULES_V4 would not load: left unchanged."
          printf '%s\n' "$updated" | root_read tee "$RULES_V4" >/dev/null
        fi
      fi
    fi
  fi
  if (( used_ufw )) && command -v ufw >/dev/null 2>&1; then
    as_root ufw delete allow 80/tcp
    as_root ufw delete allow 443/tcp
  fi
  as_root rm -f "$marker"
  info "In Oracle's console you can also delete the two ingress rules for ports 80 and 443 (ORACLE.md, step 6, part A)."
}

persist_ports() {
  local current updated backup="$RULES_V4.before-mommy"
  if [[ ! -f "$RULES_V4" ]]; then
    info "No $RULES_V4: the firewall has no saved rules to change (nothing blocks these ports at boot)."
    return 0
  fi
  current=$(root_read cat "$RULES_V4" 2>/dev/null) || {
    if (( DRY_RUN )); then
      info "$RULES_V4: not checked (sudo cat $RULES_V4 did not answer; with --dry-run, sudo is never asked for a password)."
    else
      warn "Cannot read $RULES_V4: ports 80 and 443 are not saved for the next boot."
    fi
    return 0
  }
  updated=$(rules_with_ports <<<"$current")
  if [[ "$updated" == "$current" ]]; then
    info "Ports 80 and 443 are already open in $RULES_V4 (loaded at boot)."
  else
    info "Saving the two rules in $RULES_V4, loaded at boot (a copy of the old file: $backup)."
    if (( DRY_RUN )); then
      diff <(printf '%s\n' "$current") <(printf '%s\n' "$updated") | sed 's/^/        | /' || true
    else
      root_read test -e "$backup" || root_read cp -p "$RULES_V4" "$backup"
      printf '%s\n' "$updated" | root_read iptables-restore --test \
        || die "The updated $RULES_V4 would not load: left unchanged."
      printf '%s\n' "$updated" | root_read tee "$RULES_V4" >/dev/null
    fi
    PORTS_OPENED=1
  fi
  if command -v systemctl >/dev/null 2>&1 && systemctl cat netfilter-persistent.service >/dev/null 2>&1; then
    if [[ "$(systemctl is-enabled netfilter-persistent.service 2>/dev/null || true)" != enabled ]]; then
      as_root systemctl enable netfilter-persistent.service
    fi
  fi
}

open_web_ports() {
  local marks="iptables"
  info "Opening ports 80 and 443 (HTTP, HTTPS) in the VM's firewall."
  if command -v iptables >/dev/null 2>&1; then
    open_port 80
    open_port 443
    persist_ports
  else
    info "iptables is not installed: no firewall rules to change."
  fi
  if command -v ufw >/dev/null 2>&1 && root_read ufw status 2>/dev/null | grep -q '^Status: active'; then
    info "ufw is on: allowing 80/tcp and 443/tcp."
    as_root ufw allow 80/tcp
    as_root ufw allow 443/tcp
    marks="$marks
ufw"
    PORTS_OPENED=1
  fi
  # What --tunnel undoes later (close_web_ports): only what this script opened.
  if (( PORTS_OPENED )); then
    as_root install -d -m 755 "$STATE_DIR"
    printf '%s\n' "$marks" | write_root_file "$STATE_DIR/ports-opened" 0644
  fi
  info "They must also be open in Oracle's VCN security list (ORACLE.md, step 6), outside this VM."
}

# --- step 7: build and start ----------------------------------------------------------

show_problem() {
  say "" >&2
  say "What Docker says (docker compose ps, then the end of the app's log):" >&2
  dc_read ps -a >&2 || true
  dc_read logs --tail 30 mommy >&2 || true
}

start_app() {
  step "Building and starting Mommy (the first time: 10 to 20 minutes, about 1 GB to download)"
  local ids
  if [[ "$MODE" == stable ]]; then
    # The quick tunnel is not part of this mode (compose.stable.yaml): its container goes.
    ids=$(root_read docker ps -aq --filter label=com.docker.compose.project=mommy \
      --filter label=com.docker.compose.service=tunnel 2>/dev/null || true)
    if [[ -n "$ids" ]]; then
      info "Removing the quick tunnel's container (the permanent link replaces it)."
      # shellcheck disable=SC2086  # container ids
      if (( DRY_RUN )); then as_root docker rm -f $ids; else root_read docker rm -f $ids >/dev/null; fi
    fi
  fi
  if ! dc up -d --build --remove-orphans; then
    show_problem
    die "docker compose up failed (see above)."
  fi
  # Old images left by an update (only the unused, untagged ones).
  if (( DRY_RUN )); then as_root docker image prune -f; else root_read docker image prune -f >/dev/null; fi
}

# --- step 8: ready --------------------------------------------------------------------

wait_healthy() {
  local id state started=$SECONDS last=0
  (( DRY_RUN )) && { info "would wait until the app's healthcheck says healthy"; return 0; }
  id=$(dc_read ps -q mommy)
  [[ -n "$id" ]] || { show_problem; die "The app's container is not there."; }
  while :; do
    state=$(root_read docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || echo gone/)
    case "$state" in
      running/healthy)
        info "Mommy is up (it loads its speech models in the background, about a minute)."
        return 0 ;;
      */unhealthy | exited/* | dead/* | gone/)
        show_problem
        die "The app did not start ($state). The log above says why." ;;
    esac
    if (( SECONDS - started > 600 )); then
      show_problem
      die "The app is still not ready after 10 minutes ($state)."
    fi
    if (( SECONDS - last >= 15 )); then
      info "Waiting for Mommy to start... ($(( SECONDS - started )) s)"
      last=$SECONDS
    fi
    sleep 2
  done
}

# https_ok: the permanent link answers with a valid certificate, asked from the VM.
https_ok() {
  curl -fsS --noproxy '*' -o /dev/null -m 10 --resolve "$PUBLIC_HOST:443:127.0.0.1" \
    "https://$PUBLIC_HOST/access.html" 2>/dev/null
}

wait_https() {
  local i
  (( DRY_RUN )) && { info "would check https://$PUBLIC_HOST/ for a valid certificate"; return 0; }
  info "Checking https://$PUBLIC_HOST/ (Caddy gets its certificate from Let's Encrypt; up to 2 minutes)..."
  if ! https_ok; then
    # A Caddy that has failed before waits longer and longer between tries: a restart
    # makes it try again now (the ports may have been opened since).
    dc restart caddy >/dev/null 2>&1 || true
    for i in $(seq 1 40); do
      https_ok && break
      if (( i == 40 )); then
        warn "https://$PUBLIC_HOST/ does not answer with a valid certificate yet. Most often ports 80 and 443 are not open in the VCN security list (ORACLE.md, step 6). What Caddy says: cd $COMPOSE_DIR && sudo docker compose logs caddy. Once fixed, run: $SCRIPT_CMD --stable"
        return 1
      fi
      sleep 3
    done
  fi
  info "https://$PUBLIC_HOST/ works, with a valid certificate."
}

# --- step 9: the link -----------------------------------------------------------------

# The link of the permanent mode: https://<host>/#code=<code>, the code read by the app's
# own code (mommy.config) inside its container, printed by mommy.share_link's helper.
readonly STABLE_LINK_PY='
import os, sys
from mommy.config import access_code_from
from mommy.share_link import share_link
try:
    code, _ = access_code_from(os.environ, create=False)
except FileNotFoundError:
    sys.exit("No access code yet: the app makes it when it starts. Run setup.sh again.")
except ValueError as exc:
    sys.exit(f"The access code cannot be used: {exc}. Make a new one: bash setup.sh --new-code")
if code is None:
    sys.exit("No access code is set (compose.yaml sets MOMMY_ACCESS_CODE_FILE).")
print(share_link(sys.argv[1], code))
'

# A new code in the code file, as "python -m mommy.share_link --new-code" writes it.
readonly NEW_CODE_PY='
import os, sys
from pathlib import Path
from mommy.access import generate_code, replace_code_file
if os.environ.get("MOMMY_ACCESS_CODE", "").strip():
    sys.exit("MOMMY_ACCESS_CODE is set and wins over the code file: change it where it is set instead.")
path = os.environ.get("MOMMY_ACCESS_CODE_FILE", "").strip()
if not path:
    sys.exit("MOMMY_ACCESS_CODE_FILE is not set (compose.yaml sets it).")
replace_code_file(Path(path), generate_code())
print(f"    A new access code is saved in {path}: the old link and the browsers that used it are shut out.")
'

# hold_back_link: in the permanent mode, the link is printed only once its address
# answers HTTPS from this VM with a valid certificate: Let's Encrypt gave it, so the name
# leads here. Otherwise the code would be sent to an address that may be someone else's.
hold_back_link() {
  say ""
  say "The link is not shown yet: https://$PUBLIC_HOST/ does not answer from this VM with a valid certificate, so"
  say "that address may not lead here (or the certificate is not there yet). Fix what the warning above says,"
  say "then get the link with: $SCRIPT_CMD --link"
}

print_link() {
  local status=0
  if (( DRY_RUN )); then
    if [[ "$MODE" == stable ]]; then
      info "would print the link: https://$PUBLIC_HOST/#code=<the code>"
    else
      info "would print the link: docker compose exec mommy python -m mommy.share_link"
    fi
    return 0
  fi
  if [[ "$MODE" == stable ]] && { (( ! HTTPS_OK )) || ! https_ok; }; then
    hold_back_link
    return 4
  fi
  say ""
  say "Your link to share (it contains the access code: send it in a private message):"
  say ""
  if [[ "$MODE" == stable ]]; then
    dc exec -T mommy python -c "$STABLE_LINK_PY" "$PUBLIC_HOST" || status=$?
    (( status == 0 )) && say "This link stays the same (also after a reboot) as long as the VM keeps its public IP address, and the code stays the same until you make a new one ($SCRIPT_CMD --new-code)."
  else
    dc exec -T mommy python -m mommy.share_link || status=$?
    if (( status == 0 )); then
      say "On this VM, get the current link with: $SCRIPT_CMD --link"
    elif (( status == 3 )); then
      say ""
      say "Mommy runs, but the tunnel has no address yet. Try again in a few minutes: $SCRIPT_CMD --link"
    fi
  fi
  return "$status"
}

# --- the actions ----------------------------------------------------------------------

load_mode() {
  [[ -f "$ENV_FILE" ]] || die "Mommy is not set up on this VM yet ($ENV_FILE is missing): run $SCRIPT_CMD first."
  MODE=$(env_value MOMMY_MODE)
  MODE=${MODE:-tunnel}
  PUBLIC_HOST=$(env_value MOMMY_PUBLIC_HOST)
  if [[ "$MODE" == stable && -z "$PUBLIC_HOST" ]]; then
    die "$ENV_FILE has no MOMMY_PUBLIC_HOST: run $SCRIPT_CMD --stable"
  fi
}

require_running() {
  if [[ -z "$(dc_read ps -q --status running mommy 2>/dev/null)" ]]; then
    die "Mommy is not running. Start it (and update it) with: $SCRIPT_CMD"
  fi
}

do_link() {
  STEPS=1
  load_mode
  require_running
  step "Your link"
  print_link || exit $?
}

# new_code: a new code in the code file (the app's container, not running it), then the
# app restarted with it.
new_code() {
  dc run --rm --no-deps -T mommy python -c "$NEW_CODE_PY"
  info "Restarting Mommy with the new code."
  dc restart mommy
  wait_healthy
}

do_new_code() {
  STEPS=2
  load_mode
  step "A new access code"
  new_code
  step "Your new link"
  print_link || exit $?
}

do_setup() {
  check_machine
  install_base_packages
  install_docker
  ensure_swap
  if (( NO_UPDATE )); then
    step "Mommy's files ($APP_DIR, branch $BRANCH)"
    info "Updated just before (this is the new version of setup.sh)."
  else
    update_code
    rerun_if_updated
  fi
  configure
  start_app
  step "Waiting for Mommy"
  wait_healthy
  if (( ROTATE_CODE )); then
    info "A new access code, since the permanent link's address changed (see the warning above)."
    new_code
  fi
  if [[ "$MODE" == stable ]] && ! wait_https; then HTTPS_OK=0; fi
  step "Your link"
  print_link || exit $?
}

parse_args() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --stable | --tunnel)
        [[ -z "$OPT_MODE" || "$OPT_MODE" == "${arg#--}" ]] || die "Choose --stable or --tunnel, not both."
        OPT_MODE=${arg#--} ;;
      --link) [[ "$ACTION" == setup || "$ACTION" == link ]] || die "Choose one of --link and --new-code."; ACTION="link" ;;
      --new-code) [[ "$ACTION" == setup || "$ACTION" == new-code ]] || die "Choose one of --link and --new-code."; ACTION="new-code" ;;
      --dry-run) DRY_RUN=1 ;;
      --yes) ASSUME_YES=1 ;;
      --no-update) NO_UPDATE=1 ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; die "Unknown option: $arg" ;;
    esac
  done
  if [[ "$ACTION" != setup && -n "$OPT_MODE" ]]; then
    die "--$OPT_MODE goes with a full run ($SCRIPT_CMD --$OPT_MODE), not with --$ACTION."
  fi
}

main() {
  ORIG_ARGS=("$@")
  parse_args "$@"
  trap 'on_error $? $LINENO' ERR
  SELF_SUM=$(sha256sum <"${BASH_SOURCE[0]}")
  if (( EUID == 0 )) && [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
    die "Run it without sudo, as $SUDO_USER: $SCRIPT_CMD ${ORIG_ARGS[*]} (it uses sudo itself where it needs it, and keeps Mommy in that user's ~/mommy-app)."
  fi
  if (( EUID != 0 )); then SUDO=sudo; fi
  (( DRY_RUN )) && say "Dry run: nothing is changed; the lines \"would run\" show what a real run does."
  # One run at a time.
  exec 9>"${TMPDIR:-/tmp}/mommy-setup-$(id -u).lock"
  flock -n 9 || die "setup.sh is already running in another window: wait for it to finish."
  case "$ACTION" in
    setup) do_setup ;;
    link) do_link ;;
    new-code) do_new_code ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

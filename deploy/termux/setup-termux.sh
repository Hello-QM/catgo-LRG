#!/data/data/com.termux/files/usr/bin/bash
#
# setup-termux.sh — Model A: run the THIN CatGo backend self-contained in Termux
# on an Android phone. The backend serves the prebuilt SPA and you open
# http://localhost:8000 in the phone's browser.
#
# This script is idempotent and re-runnable. It:
#   1. installs system packages (python, openssh, git, tmux) via pkg,
#   2. installs python-numpy + python-cryptography via pkg FIRST (prebuilt
#      aarch64 packages) so pip reuses them instead of building from source,
#   3. pip-installs the THIN backend deps only,
#   4. locates a PREBUILT build-desktop/ frontend (it does NOT build the SPA
#      on the phone — too heavy),
#   5. launches the backend with CATGO_THIN=1 + termux-wake-lock.
#
# Usage:
#   ./setup-termux.sh [FRONTEND_DIR] [--repo /path/to/catgo-repo] [--no-run]
#
#   FRONTEND_DIR   path to a prebuilt build-desktop/ (positional $1).
#                  Also honoured via $CATGO_FRONTEND_DIR. Default: ./build-desktop
#   --repo PATH    path to the CatGo repo (must contain server/main.py).
#                  Default: auto-detected from this script's location, else $PWD.
#   --no-run       do setup only; do not launch the backend.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
log()  { printf '\033[1;36m[catgo]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[catgo][warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[catgo][error]\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# environment sanity
# ---------------------------------------------------------------------------
if [ ! -d /data/data/com.termux/files/usr ]; then
  warn "This does not look like a Termux environment."
  warn "This script is intended to run inside Termux on Android."
fi

have pkg || die "'pkg' not found. Install the Termux app from F-Droid (NOT the Play Store build)."

# ---------------------------------------------------------------------------
# argument parsing
# ---------------------------------------------------------------------------
FRONTEND_DIR_ARG="${1:-}"
# Strip the positional arg off if it actually starts with '--' (i.e. omitted).
case "${FRONTEND_DIR_ARG}" in
  --*) FRONTEND_DIR_ARG="" ;;
  *)   [ -n "${FRONTEND_DIR_ARG}" ] && shift || true ;;
esac

REPO_DIR=""
DO_RUN=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO_DIR="${2:-}"; shift 2 ;;
    --no-run) DO_RUN=0; shift ;;
    *) warn "ignoring unknown argument: $1"; shift ;;
  esac
done

# ---------------------------------------------------------------------------
# resolve repo dir (must contain server/main.py)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${REPO_DIR}" ]; then
  # deploy/termux/setup-termux.sh  ->  repo root is two levels up.
  CANDIDATE="$(cd "${SCRIPT_DIR}/../.." && pwd)"
  if [ -f "${CANDIDATE}/server/main.py" ]; then
    REPO_DIR="${CANDIDATE}"
  else
    REPO_DIR="$(pwd)"
  fi
fi
[ -f "${REPO_DIR}/server/main.py" ] || die \
  "Could not find server/main.py under repo dir '${REPO_DIR}'. Pass --repo /path/to/catgo-repo."
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
log "Using CatGo repo: ${REPO_DIR}"

# ---------------------------------------------------------------------------
# 1. system packages via pkg (prebuilt aarch64 — no source builds)
# ---------------------------------------------------------------------------
log "Updating Termux package index..."
pkg update -y || warn "pkg update reported issues; continuing."

# python-numpy + python-cryptography FIRST: these ship as prebuilt aarch64
# Termux packages. Installing them via pkg lets the later pip step reuse them
# instead of compiling numpy/cffi from source (which is slow and often fails).
SYS_PKGS="python python-numpy python-cryptography openssh git tmux"
log "Installing system packages: ${SYS_PKGS}"
# shellcheck disable=SC2086
pkg install -y ${SYS_PKGS} || die "pkg install failed. Re-run after 'pkg update', or check storage/network."

have python || die "python not available after install."
have pip || have python -m pip || die "pip not available after installing python."

# termux-api is optional; only the CLI 'termux-wake-lock' is needed and it is
# provided by the termux-api package + the separate 'Termux:API' app.
if ! have termux-wake-lock; then
  log "Installing termux-api (provides termux-wake-lock CLI)..."
  pkg install -y termux-api || warn \
    "Could not install termux-api package. Wake-lock will be skipped at launch."
fi

# ---------------------------------------------------------------------------
# 2. pip: THIN backend deps only
# ---------------------------------------------------------------------------
# NOTE: 'uvicorn' WITHOUT [standard]. uvloop + httptools (pulled in by
# uvicorn[standard]) require C compilation on ARM and frequently fail in Termux.
# Plain uvicorn uses the pure-Python asyncio loop, which is fine for this use.
#
# pymatgen + ase are the heavy deps (needed by structure_ops / trajectory);
# they have aarch64 wheels. numpy/cryptography were already provided by pkg
# above so pip will not rebuild them.
PIP_PKGS=(
  fastapi
  uvicorn
  pydantic
  python-multipart
  httpx
  asyncssh
  pymatgen
  ase
)
log "Installing THIN backend Python deps via pip (this can take a while for pymatgen/ase)..."
python -m pip install --upgrade pip || warn "pip self-upgrade failed; continuing."
python -m pip install "${PIP_PKGS[@]}" \
  || die "pip install failed. Common fix: re-run; for build errors ensure python-numpy/python-cryptography came from pkg."

# ---------------------------------------------------------------------------
# 3. locate the prebuilt frontend (build-desktop/)
# ---------------------------------------------------------------------------
# Precedence: positional $1 > $CATGO_FRONTEND_DIR > <repo>/build-desktop > ./build-desktop
FRONTEND_DIR=""
for cand in \
  "${FRONTEND_DIR_ARG}" \
  "${CATGO_FRONTEND_DIR:-}" \
  "${REPO_DIR}/build-desktop" \
  "$(pwd)/build-desktop"; do
  if [ -n "${cand}" ] && [ -f "${cand}/index.html" ]; then
    FRONTEND_DIR="$(cd "${cand}" && pwd)"
    break
  fi
done

if [ -z "${FRONTEND_DIR}" ]; then
  warn "No prebuilt SPA (build-desktop/index.html) found."
  warn "The phone does NOT build the frontend (too heavy). On a real machine run:"
  warn "    pnpm build:connect        # NON-static build that talks to a real backend"
  warn "then copy the resulting  build-desktop/  to the phone, e.g.:"
  warn "    scp -r build-desktop/  <phone>:${REPO_DIR}/"
  warn "or pass its path:  ./setup-termux.sh /path/to/build-desktop"
  warn ""
  warn "Setup of dependencies is complete; the backend can still start but will"
  warn "have no UI to serve until build-desktop/ is present."
else
  log "Using prebuilt frontend: ${FRONTEND_DIR}"
  export CATGO_FRONTEND_DIR="${FRONTEND_DIR}"
fi

# ---------------------------------------------------------------------------
# HPC-from-phone note
# ---------------------------------------------------------------------------
cat <<'EOF'

[catgo] HPC from the phone:
  - In the cluster profile, set  auth_method = ssh_config  and point it at a
    Host alias defined in  ~/.ssh/config  (e.g. Host expanse / HostName ...).
    This uses the subprocess `ssh` runner (system openssh, installed above)
    instead of asyncssh, which avoids asyncssh quirks on Termux.
  - The phone needs network route to the login node: connect VPN / Tailscale
    (or be on the same network) before submitting jobs.

EOF

if [ "${DO_RUN}" -eq 0 ]; then
  log "Setup complete (--no-run). To launch later:"
  log "    export CATGO_THIN=1 CATGO_FRONTEND_DIR='${FRONTEND_DIR:-<path>}'"
  log "    python '${REPO_DIR}/server/main.py'"
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. launch the THIN backend
# ---------------------------------------------------------------------------
export CATGO_THIN=1

# Wake-lock keeps Android from suspending the process / network while running.
# Requires the separate 'Termux:API' app installed (from F-Droid). Guard if absent.
if have termux-wake-lock; then
  log "Acquiring wake-lock (termux-wake-lock)..."
  termux-wake-lock || warn "termux-wake-lock failed (is the 'Termux:API' app installed?). Continuing without it."
else
  warn "termux-wake-lock not available; Android may suspend the backend. Install the 'Termux:API' app + 'pkg install termux-api'."
fi

log "Starting THIN CatGo backend on 0.0.0.0:8000 ..."
log "Open  http://localhost:8000  in the phone's browser."
log "Tip: run inside 'tmux' (tmux new -s catgo) so it survives if this shell closes."
log "Press Ctrl-C to stop (this also releases the wake-lock via the trap below)."

# Release the wake-lock when the backend exits.
trap 'have termux-wake-unlock && termux-wake-unlock >/dev/null 2>&1 || true' EXIT

# Foreground exec so Android is less likely to reap a backgrounded process.
cd "${REPO_DIR}"
exec python "${REPO_DIR}/server/main.py"

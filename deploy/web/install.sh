#!/usr/bin/env bash
#
# CatGo backend one-line installer (Linux + macOS)
# ============================================================================
#
# Usage:
#   curl -sSL https://app.catgo-ucsd.org/install.sh | bash
#
# What this does:
#   1. Detects your OS and a Python 3.10+ interpreter (errors with guidance
#      if either is missing).
#   2. Gets the CatGo backend source. If you run this from inside an existing
#      CatGo checkout (it walks up the tree looking for server/main.py) it
#      reuses that checkout. Otherwise it `git clone`s CATGO_REPO (see below)
#      into ~/.catgo-app.
#   3. Creates an isolated Python environment (uv if available, else a stdlib
#      venv) and installs the THIN backend dependencies only.
#   4. Launches the backend with CATGO_THIN=1, binding 0.0.0.0:8000.
#
# After it starts, open the hosted UI at:
#       https://app.catgo-ucsd.org
# and point it at your local backend:
#       http://localhost:8000   (or just "localhost" — the wizard auto-detects)
#
# ---------------------------------------------------------------------------
# SECURITY NOTE
# ---------------------------------------------------------------------------
# The backend binds 0.0.0.0:8000 so the hosted UI in your browser can reach it
# over localhost. Keep this OFF the public internet — do not expose port 8000
# through a firewall/router/tunnel. CORS is restricted to the hosted origin
# (https://app.catgo-ucsd.org) via CATGO_ALLOWED_ORIGINS, so a random website
# cannot drive your backend, but anything that can reach the port directly
# (other machines on your LAN) still can. Run it on a machine you trust.
#
# ---------------------------------------------------------------------------
# Customization (edit the variables below, or set them in your environment)
# ---------------------------------------------------------------------------
#   CATGO_REPO     - git URL to clone when not inside a checkout.
#                    >>> EDIT THIS to your real repository URL. <<<
#   CATGO_APP_DIR  - where to clone (default: ~/.catgo-app).
#   CATGO_ORIGIN   - allowed browser origin for CORS
#                    (default: https://app.catgo-ucsd.org).
#   CATGO_PORT     - port to bind (default: 8000).
#
# This script is idempotent and safe to re-run: an existing checkout is
# `git pull`ed, an existing venv is reused, deps are re-checked.
# ============================================================================

set -euo pipefail

# --------------------------------------------------------------------------
# Configuration (override via environment, or edit defaults here)
# --------------------------------------------------------------------------
# >>> EDIT CATGO_REPO to point at your real CatGo repository. <<<
CATGO_REPO="${CATGO_REPO:-https://github.com/your-org/catgo.git}"
CATGO_APP_DIR="${CATGO_APP_DIR:-$HOME/.catgo-app}"
CATGO_ORIGIN="${CATGO_ORIGIN:-https://app.catgo-ucsd.org}"
CATGO_PORT="${CATGO_PORT:-8000}"

# Thin backend dependency set (no heavy ML / torch / numpy-stack extras).
# plain 'uvicorn' on purpose (not uvicorn[standard]) to stay lightweight.
THIN_DEPS=(
  "fastapi"
  "uvicorn"
  "pydantic"
  "python-multipart"
  "httpx"
  "asyncssh"
  "pymatgen"
  "ase"
)

# --------------------------------------------------------------------------
# Pretty output + error trap
# --------------------------------------------------------------------------
info()  { printf '\033[1;34m[catgo]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[catgo]\033[0m %s\n' "$*" >&2; }
err()   { printf '\033[1;31m[catgo]\033[0m %s\n' "$*" >&2; }

on_error() {
  local exit_code=$?
  local line=${1:-?}
  err "Installation failed (exit ${exit_code}) at line ${line}."
  err "Common fixes:"
  err "  - Ensure 'git' and a Python 3.10+ 'python3' are installed."
  err "  - Re-run the command; this script is safe to re-run."
  err "  - To use a different source repo:  CATGO_REPO=<url> bash install.sh"
  err "  - Report the full output above if it persists."
  exit "${exit_code}"
}
trap 'on_error ${LINENO}' ERR

# --------------------------------------------------------------------------
# 1. Detect OS
# --------------------------------------------------------------------------
OS_NAME="$(uname -s)"
case "${OS_NAME}" in
  Linux)   PLATFORM="Linux" ;;
  Darwin)  PLATFORM="macOS" ;;
  *)
    err "Unsupported OS: ${OS_NAME}. This installer supports Linux and macOS."
    err "On Windows, use WSL2 or run the backend manually (see deploy/web/INSTALL.md)."
    exit 1
    ;;
esac
info "Detected platform: ${PLATFORM}"

# --------------------------------------------------------------------------
# 2. Detect git
# --------------------------------------------------------------------------
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command '$1' not found. $2"
    exit 1
  fi
}

# --------------------------------------------------------------------------
# 3. Detect Python 3.10+
# --------------------------------------------------------------------------
find_python() {
  local candidate
  for candidate in python3 python3.13 python3.12 python3.11 python3.10 python; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      if "${candidate}" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)' >/dev/null 2>&1; then
        printf '%s' "${candidate}"
        return 0
      fi
    fi
  done
  return 1
}

if ! PYTHON_BIN="$(find_python)"; then
  err "No Python 3.10+ interpreter found (looked for python3 / python3.1x / python)."
  case "${PLATFORM}" in
    macOS)
      err "Install one with:  brew install python@3.12"
      err "  (or download from https://www.python.org/downloads/macos/)"
      ;;
    Linux)
      err "Install one with your package manager, e.g.:"
      err "  Debian/Ubuntu:  sudo apt-get install -y python3 python3-venv python3-pip"
      err "  Fedora/RHEL:    sudo dnf install -y python3 python3-pip"
      ;;
  esac
  exit 1
fi
PY_VERSION="$("${PYTHON_BIN}" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
info "Using Python ${PY_VERSION} (${PYTHON_BIN})"

# --------------------------------------------------------------------------
# 4. Locate the CatGo backend source
#    - If we are inside an existing checkout (server/main.py up the tree), use it.
#    - Otherwise git clone CATGO_REPO into CATGO_APP_DIR.
# --------------------------------------------------------------------------
find_existing_checkout() {
  local dir
  dir="$(pwd)"
  while [ "${dir}" != "/" ]; do
    if [ -f "${dir}/server/main.py" ]; then
      printf '%s' "${dir}"
      return 0
    fi
    dir="$(dirname "${dir}")"
  done
  return 1
}

if REPO_ROOT="$(find_existing_checkout)"; then
  info "Found existing CatGo checkout at: ${REPO_ROOT}"
else
  require_cmd git "Install git first (e.g. 'sudo apt-get install -y git' or 'brew install git')."
  if [ -f "${CATGO_APP_DIR}/server/main.py" ]; then
    info "Reusing existing clone at ${CATGO_APP_DIR} (git pull)..."
    git -C "${CATGO_APP_DIR}" pull --ff-only || warn "git pull failed; using existing checkout as-is."
    REPO_ROOT="${CATGO_APP_DIR}"
  else
    if [ "${CATGO_REPO}" = "https://github.com/your-org/catgo.git" ]; then
      warn "CATGO_REPO is still the placeholder default."
      warn "Edit CATGO_REPO in this script (or pass CATGO_REPO=<url>) to your real repo."
    fi
    info "Cloning ${CATGO_REPO} into ${CATGO_APP_DIR}..."
    git clone --depth 1 "${CATGO_REPO}" "${CATGO_APP_DIR}"
    REPO_ROOT="${CATGO_APP_DIR}"
  fi
fi

if [ ! -f "${REPO_ROOT}/server/main.py" ]; then
  err "Could not locate server/main.py under ${REPO_ROOT}."
  err "The clone/checkout looks incomplete. Check CATGO_REPO and re-run."
  exit 1
fi
info "Backend source: ${REPO_ROOT}"

# --------------------------------------------------------------------------
# 5. Create environment + install thin deps (uv if present, else venv+pip)
# --------------------------------------------------------------------------
VENV_DIR="${REPO_ROOT}/.catgo-venv"

if command -v uv >/dev/null 2>&1; then
  info "Found 'uv' — using it for a fast install."
  if [ ! -d "${VENV_DIR}" ]; then
    uv venv --python "${PYTHON_BIN}" "${VENV_DIR}"
  else
    info "Reusing existing venv at ${VENV_DIR}"
  fi
  # shellcheck disable=SC1091
  source "${VENV_DIR}/bin/activate"
  info "Installing thin backend dependencies with 'uv pip install'..."
  uv pip install --python "${VENV_DIR}/bin/python" "${THIN_DEPS[@]}"
else
  info "'uv' not found — using stdlib venv + pip."
  if [ ! -d "${VENV_DIR}" ]; then
    "${PYTHON_BIN}" -m venv "${VENV_DIR}"
  else
    info "Reusing existing venv at ${VENV_DIR}"
  fi
  # shellcheck disable=SC1091
  source "${VENV_DIR}/bin/activate"
  info "Upgrading pip..."
  python -m pip install --quiet --upgrade pip
  info "Installing thin backend dependencies with pip..."
  python -m pip install "${THIN_DEPS[@]}"
fi
info "Dependencies installed."

# --------------------------------------------------------------------------
# 6. Launch the thin backend
# --------------------------------------------------------------------------
export CATGO_THIN=1
export CATGO_ALLOWED_ORIGINS="${CATGO_ORIGIN}"
export SERVER_PORT="${CATGO_PORT}"

info "----------------------------------------------------------------"
info "Starting CatGo THIN backend"
info "  CATGO_THIN=1"
info "  CATGO_ALLOWED_ORIGINS=${CATGO_ALLOWED_ORIGINS}"
info "  binding 0.0.0.0:${CATGO_PORT}"
info ""
info "Next steps:"
info "  1. Open ${CATGO_ORIGIN} in your browser."
info "  2. When prompted for a backend, enter:"
info "       http://localhost:${CATGO_PORT}"
info "     (or just 'localhost' — the wizard auto-detects the port)."
info ""
info "  Press Ctrl+C to stop the backend."
info "----------------------------------------------------------------"

cd "${REPO_ROOT}"
exec python server/main.py

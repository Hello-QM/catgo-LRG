#!/bin/bash
#===============================================================================
# CatGO One-Command Installer for SDSC Expanse
#
# Works for ANY Expanse user with ANY allocation.
# Run on a login node (which has internet access).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Hello-QM/CatGO/dev/deploy/hpc/install-catgo.sh | bash
#
# Or download and run:
#   wget https://raw.githubusercontent.com/Hello-QM/CatGO/dev/deploy/hpc/install-catgo.sh
#   bash install-catgo.sh
#
# What this does:
#   1. Installs Miniforge3 (if no conda found)
#   2. Creates 'catgo' conda environment with all dependencies
#   3. Downloads CatGO server + frontend from GitHub
#   4. Auto-detects your SLURM allocation account(s)
#   5. Generates a personalized job script at ~/catgo/catgo-job.sh
#
# After install:
#   cd ~/catgo && sbatch catgo-job.sh
#===============================================================================

set -euo pipefail

CATGO_VERSION="latest"
CATGO_DIR="$HOME/catgo"
ENV_NAME="catgo"
PYTHON_VERSION="3.11"
REPO_URL="https://github.com/Hello-QM/CatGO"
PORT=8000

# ─── Colors (if terminal supports them) ───
if [[ -t 1 ]]; then
    BOLD='\033[1m'
    GREEN='\033[0;32m'
    YELLOW='\033[0;33m'
    RED='\033[0;31m'
    CYAN='\033[0;36m'
    RESET='\033[0m'
else
    BOLD='' GREEN='' YELLOW='' RED='' CYAN='' RESET=''
fi

info()  { echo -e "${GREEN}[INFO]${RESET}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error() { echo -e "${RED}[ERROR]${RESET} $*"; }
step()  { echo -e "\n${BOLD}${CYAN}=== $* ===${RESET}"; }

# ─── Banner ───
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║          CatGO — Materials Science Toolkit              ║${RESET}"
echo -e "${BOLD}║          One-Command Installer for HPC                  ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "  User:     $USER"
echo "  Host:     $(hostname -s)"
echo "  Time:     $(date)"
echo "  Target:   $CATGO_DIR"
echo ""

# ═══════════════════════════════════════════════════════════
# Step 1: Ensure conda is available
# ═══════════════════════════════════════════════════════════
step "Step 1/6: Checking for conda"

CONDA_BASE=""
for candidate in "$HOME/miniforge3" "$HOME/miniconda3" "$HOME/anaconda3"; do
    if [[ -d "$candidate" ]]; then
        CONDA_BASE="$candidate"
        break
    fi
done

if [[ -z "$CONDA_BASE" ]]; then
    info "No conda installation found. Installing Miniforge3..."
    INSTALLER="/tmp/Miniforge3-installer-$$.sh"
    curl -fsSL "https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh" -o "$INSTALLER"
    bash "$INSTALLER" -b -p "$HOME/miniforge3"
    rm -f "$INSTALLER"
    CONDA_BASE="$HOME/miniforge3"
    info "Miniforge3 installed at $CONDA_BASE"
else
    info "Found conda at $CONDA_BASE"
fi

# Initialize conda for this shell session
source "$CONDA_BASE/etc/profile.d/conda.sh"
info "conda $(conda --version 2>&1 | awk '{print $2}')"

# ═══════════════════════════════════════════════════════════
# Step 2: Create conda environment
# ═══════════════════════════════════════════════════════════
step "Step 2/6: Setting up Python environment"

if conda env list 2>/dev/null | grep -q "^${ENV_NAME} "; then
    info "Environment '$ENV_NAME' already exists. Updating..."
    conda activate "$ENV_NAME"
else
    info "Creating environment '$ENV_NAME' (Python $PYTHON_VERSION)..."
    conda create -n "$ENV_NAME" python="$PYTHON_VERSION" -y -q
    conda activate "$ENV_NAME"
fi
info "Python $(python --version 2>&1 | awk '{print $2}')"

# ─── Install Python dependencies ───
info "Installing core dependencies (FastAPI, ASE, pymatgen, etc.)..."
pip install -q --no-cache-dir \
    "fastapi>=0.109.0" \
    "uvicorn[standard]>=0.27.0" \
    "pydantic>=2.0.0" \
    "python-multipart>=0.0.6" \
    "httpx>=0.27.0" \
    "asyncssh>=2.14.0" \
    "numpy>=1.24.0" \
    "scipy>=1.10.0" \
    "ase>=3.22.0" \
    "pymatgen>=2024.1.0" \
    "mdtraj>=1.9.9" \
    "scikit-learn>=1.3.0" \
    "umap-learn>=0.5.0"

info "Installing PyTorch (CPU)..."
pip install -q --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

info "Installing ML potentials (MACE, CHGNet, M3GNet)..."
pip install -q --no-cache-dir "mace-torch>=0.3.0"
pip install -q --no-cache-dir "chgnet>=0.3.0"
pip install -q --no-cache-dir "matgl>=1.0.0"

info "Installing xTB..."
pip install -q --no-cache-dir "tblite[ase]>=0.3.0" 2>/dev/null || warn "tblite install failed (optional — xTB won't be available)"

info "Installing Sella (transition state search)..."
pip install -q --no-cache-dir setuptools-scm
pip install -q --no-cache-dir --no-build-isolation "sella>=2.3.0" 2>/dev/null || warn "Sella install failed (optional — TS search won't be available)"

# ═══════════════════════════════════════════════════════════
# Step 3: Download CatGO server + frontend
# ═══════════════════════════════════════════════════════════
step "Step 3/6: Downloading CatGO"

mkdir -p "$CATGO_DIR"

DOWNLOAD_SUCCESS=0

# Method 1: GitHub Release bundle (tagged versions)
RELEASE_URL="${REPO_URL}/releases/latest/download/catgo-hpc-bundle.tar.gz"
if [[ $DOWNLOAD_SUCCESS -eq 0 ]]; then
    info "Checking for release bundle..."
    if curl -fsSL --head "$RELEASE_URL" >/dev/null 2>&1; then
        info "Downloading pre-built bundle from latest release..."
        curl -fsSL "$RELEASE_URL" | tar xz -C "$CATGO_DIR"
        DOWNLOAD_SUCCESS=1
    fi
fi

# Method 2: Git clone (server is pure Python, always works)
if [[ $DOWNLOAD_SUCCESS -eq 0 ]]; then
    info "Cloning from GitHub..."
    CLONE_DIR="/tmp/catgo-clone-$$"
    rm -rf "$CLONE_DIR"

    if git clone --depth 1 --branch dev "${REPO_URL}.git" "$CLONE_DIR" 2>/dev/null || \
       git clone --depth 1 "${REPO_URL}.git" "$CLONE_DIR" 2>/dev/null; then

        # Server: pure Python, just copy
        rm -rf "$CATGO_DIR/server"
        cp -r "$CLONE_DIR/server" "$CATGO_DIR/server"
        find "$CATGO_DIR/server" -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
        info "Server files copied"

        # Frontend: needs pre-built files (SvelteKit build output)
        # HPC login nodes typically don't have Node.js, so we can't build here.
        # Check if an existing frontend deployment is already present.
        if [[ -f "$CATGO_DIR/frontend/index.html" ]]; then
            info "Existing frontend found — keeping it"
        else
            warn "Frontend needs to be deployed separately."
            warn ""
            warn "The frontend is a pre-built web app. Build it on your local machine:"
            warn "  git clone ${REPO_URL}.git && cd CatGO"
            warn "  pnpm install && pnpm build"
            warn "  scp -r build/ ${USER}@$(hostname -f):~/catgo/frontend/"
            warn ""
            warn "Or download a pre-built bundle from:"
            warn "  ${REPO_URL}/releases"
        fi

        rm -rf "$CLONE_DIR"
        DOWNLOAD_SUCCESS=1
    else
        error "Failed to clone repository. Check your internet connection."
        error "You can also manually copy the files:"
        error "  scp -r server/ ${USER}@<login-node>:~/catgo/server/"
        error "  scp -r build/ ${USER}@<login-node>:~/catgo/frontend/"
    fi
fi

mkdir -p "$CATGO_DIR/data"

# Download the launch script
LAUNCH_SCRIPT_URL="https://raw.githubusercontent.com/Hello-QM/CatGO/dev/deploy/hpc/catgo-launch.sh"
info "Downloading launch script..."
if curl -fsSL "$LAUNCH_SCRIPT_URL" -o "$CATGO_DIR/catgo-launch.sh" 2>/dev/null; then
    chmod +x "$CATGO_DIR/catgo-launch.sh"
    info "Launch script saved to $CATGO_DIR/catgo-launch.sh"
elif [[ -n "$CLONE_DIR" ]] && [[ -f "$CLONE_DIR/deploy/hpc/catgo-launch.sh" ]]; then
    cp "$CLONE_DIR/deploy/hpc/catgo-launch.sh" "$CATGO_DIR/catgo-launch.sh"
    chmod +x "$CATGO_DIR/catgo-launch.sh"
    info "Launch script copied from clone"
else
    warn "Could not download launch script (optional — you can submit jobs manually)"
fi

# ═══════════════════════════════════════════════════════════
# Step 4: Auto-detect SLURM allocation accounts
# ═══════════════════════════════════════════════════════════
step "Step 4/6: Detecting your SLURM allocations"

ACCOUNTS=()

# Method 1: sacctmgr (most reliable)
if command -v sacctmgr >/dev/null 2>&1; then
    while IFS= read -r acct; do
        acct=$(echo "$acct" | xargs | tr -d '|')  # trim whitespace and parsable delimiters
        [[ -n "$acct" ]] && ACCOUNTS+=("$acct")
    done < <(sacctmgr show associations user="$USER" format=account%30 --noheader --parsable 2>/dev/null | sort -u)
fi

# Method 2: sshare fallback
if [[ ${#ACCOUNTS[@]} -eq 0 ]] && command -v sshare >/dev/null 2>&1; then
    while IFS= read -r acct; do
        acct=$(echo "$acct" | xargs)
        [[ -n "$acct" && "$acct" != "Account" ]] && ACCOUNTS+=("$acct")
    done < <(sshare -U -u "$USER" --format=Account%30 --noheader 2>/dev/null | sort -u)
fi

# Method 3: check environment
if [[ ${#ACCOUNTS[@]} -eq 0 && -n "${SLURM_ACCOUNT:-}" ]]; then
    ACCOUNTS+=("$SLURM_ACCOUNT")
fi

SELECTED_ACCOUNT=""

if [[ ${#ACCOUNTS[@]} -eq 0 ]]; then
    warn "Could not auto-detect your SLURM allocation account."
    echo ""
    echo -n "  Enter your allocation account (e.g., abc123): "
    read -r SELECTED_ACCOUNT
    if [[ -z "$SELECTED_ACCOUNT" ]]; then
        error "No account provided. You can edit ~/catgo/catgo-job.sh later."
        SELECTED_ACCOUNT="YOUR_ACCOUNT_HERE"
    fi
elif [[ ${#ACCOUNTS[@]} -eq 1 ]]; then
    SELECTED_ACCOUNT="${ACCOUNTS[0]}"
    info "Found allocation: $SELECTED_ACCOUNT"
else
    info "Found ${#ACCOUNTS[@]} allocations:"
    for i in "${!ACCOUNTS[@]}"; do
        echo "    $((i+1)). ${ACCOUNTS[$i]}"
    done
    echo ""
    echo -n "  Select account [1-${#ACCOUNTS[@]}] (default: 1): "
    read -r choice
    choice=${choice:-1}
    if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#ACCOUNTS[@]} )); then
        SELECTED_ACCOUNT="${ACCOUNTS[$((choice-1))]}"
    else
        SELECTED_ACCOUNT="${ACCOUNTS[0]}"
    fi
    info "Selected: $SELECTED_ACCOUNT"
fi

# ═══════════════════════════════════════════════════════════
# Step 5: Generate personalized job script
# ═══════════════════════════════════════════════════════════
step "Step 5/6: Generating job script"

# Detect the HPC system for SSH instructions
LOGIN_HOST="localhost"
if [[ "$(hostname -f 2>/dev/null)" == *expanse* ]]; then
    LOGIN_HOST="login.expanse.sdsc.edu"
elif [[ "$(hostname -f 2>/dev/null)" == *stampede* ]]; then
    LOGIN_HOST="stampede2.tacc.utexas.edu"
elif [[ "$(hostname -f 2>/dev/null)" == *frontera* ]]; then
    LOGIN_HOST="frontera.tacc.utexas.edu"
elif [[ "$(hostname -f 2>/dev/null)" == *perlmutter* || "$(hostname -f 2>/dev/null)" == *nid* ]]; then
    LOGIN_HOST="perlmutter-p1.nersc.gov"
fi

cat > "$CATGO_DIR/catgo-job.sh" << 'JOBEOF'
#!/bin/bash
#===============================================================================
# CatGO Slurm Job Script — Auto-generated by install-catgo.sh
#
# Usage:
#   sbatch catgo-job.sh                    # use defaults
#   sbatch catgo-job.sh --time=02:00:00    # override walltime
#   CATGO_PORT=9000 sbatch catgo-job.sh    # use different port
#===============================================================================

#SBATCH --job-name=catgo
#SBATCH --account=__ACCOUNT__
#SBATCH --partition=shared
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=01:00:00
#SBATCH --output=catgo-%j.out
#SBATCH --error=catgo-%j.err

# ─── Configuration (override via environment variables) ───
CATGO_DIR="${CATGO_DIR:-__HOME__/catgo}"
PORT="${CATGO_PORT:-8000}"
CONDA_ENV="${CATGO_CONDA_ENV:-catgo}"

# ─── Activate conda ───
CONDA_BASE=""
for candidate in "$HOME/miniforge3" "$HOME/miniconda3" "$HOME/anaconda3"; do
    [[ -d "$candidate" ]] && CONDA_BASE="$candidate" && break
done
if [[ -z "$CONDA_BASE" ]]; then
    echo "ERROR: conda not found"; exit 1
fi
source "$CONDA_BASE/etc/profile.d/conda.sh"
conda activate "$CONDA_ENV"

# ─── Environment variables ───
export SERVER_PORT="$PORT"
export MACE_DEVICE="cpu"
export CATGO_FRONTEND_DIR="$CATGO_DIR/frontend"

# ─── Print connection instructions ───
NODE=$(hostname -s)
echo "============================================================"
echo " CatGO — Materials Science Visualization Toolkit"
echo "============================================================"
echo ""
echo " Node:     $NODE"
echo " Job ID:   $SLURM_JOB_ID"
echo " Account:  $SLURM_JOB_ACCOUNT"
echo " Python:   $(python --version 2>&1)"
echo ""
echo " To connect, run this on your LOCAL machine:"
echo ""
echo "   ssh -L ${PORT}:${NODE}:${PORT} __USER__@__LOGIN_HOST__"
echo ""
echo " Then open:  http://localhost:${PORT}"
echo " API docs:   http://localhost:${PORT}/docs"
echo ""
echo " To stop:    scancel $SLURM_JOB_ID"
echo "============================================================"

# ─── Verify deployment ───
if [[ ! -f "$CATGO_DIR/frontend/index.html" ]]; then
    echo "ERROR: Frontend not found at $CATGO_DIR/frontend/"
    echo "Run install-catgo.sh again or upload the frontend manually."
    exit 1
fi
if [[ ! -f "$CATGO_DIR/server/main.py" ]]; then
    echo "ERROR: Server not found at $CATGO_DIR/server/"
    echo "Run install-catgo.sh again."
    exit 1
fi

# ─── Launch (single process: FastAPI + static frontend) ───
echo ""
echo "Starting CatGO on port $PORT..."
cd "$CATGO_DIR"

python -c "
import uvicorn, sys, os
sys.path.insert(0, '$CATGO_DIR/server')

from main import app
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

frontend_dir = os.environ.get('CATGO_FRONTEND_DIR', '$CATGO_DIR/frontend')
index_html = os.path.join(frontend_dir, 'index.html')

@app.api_route('/{path:path}', methods=['GET'], include_in_schema=False)
async def spa_fallback(path: str):
    file_path = os.path.join(frontend_dir, path)
    if os.path.isfile(file_path):
        return FileResponse(file_path)
    return FileResponse(index_html)

app.mount('/', StaticFiles(directory=frontend_dir, html=True), name='frontend')

print(f'CatGO serving frontend from {frontend_dir}')
print(f'Starting on port {os.environ[\"SERVER_PORT\"]}...')
uvicorn.run(app, host='0.0.0.0', port=int(os.environ['SERVER_PORT']), workers=1, log_level='info')
"

echo ""
echo "CatGO stopped."
JOBEOF

# Substitute placeholders
sed -i "s|__ACCOUNT__|${SELECTED_ACCOUNT}|g" "$CATGO_DIR/catgo-job.sh"
sed -i "s|__HOME__|${HOME}|g" "$CATGO_DIR/catgo-job.sh"
sed -i "s|__USER__|${USER}|g" "$CATGO_DIR/catgo-job.sh"
sed -i "s|__LOGIN_HOST__|${LOGIN_HOST}|g" "$CATGO_DIR/catgo-job.sh"
chmod +x "$CATGO_DIR/catgo-job.sh"

info "Job script written to $CATGO_DIR/catgo-job.sh"

# ═══════════════════════════════════════════════════════════
# Step 6: Verify installation
# ═══════════════════════════════════════════════════════════
step "Step 6/6: Verifying installation"

VERIFY_OK=0
VERIFY_TOTAL=0

verify() {
    local label="$1"; shift
    VERIFY_TOTAL=$((VERIFY_TOTAL + 1))
    if python -c "$@" 2>/dev/null; then
        VERIFY_OK=$((VERIFY_OK + 1))
    else
        warn "$label: FAILED"
    fi
}

verify "FastAPI"    "import fastapi; print(f'  FastAPI {fastapi.__version__}')"
verify "ASE"        "import ase; print(f'  ASE {ase.__version__}')"
verify "pymatgen"   "from importlib.metadata import version; print(f'  pymatgen {version(\"pymatgen\")}')"
verify "PyTorch"    "import torch; print(f'  PyTorch {torch.__version__} (CPU)')"
verify "MACE"       "from mace.calculators import mace_mp; print('  MACE: OK')"
verify "CHGNet"     "from chgnet.model import CHGNet; print('  CHGNet: OK')"
verify "M3GNet"     "import matgl; print(f'  MatGL {matgl.__version__} (M3GNet): OK')"
verify "tblite"     "from tblite.ase import TBLite; print('  tblite (xTB): OK')"
verify "Sella"      "from sella import Sella, IRC; print('  Sella: OK')"

info "$VERIFY_OK/$VERIFY_TOTAL packages verified"

# ═══════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  CatGO installation complete!                           ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "  Environment:  conda activate $ENV_NAME"
echo "  Install dir:  $CATGO_DIR/"
echo "  Account:      $SELECTED_ACCOUNT"
echo "  Job script:   $CATGO_DIR/catgo-job.sh"
echo ""
if [[ -f "$CATGO_DIR/frontend/index.html" ]]; then
    echo -e "  ${GREEN}Frontend: OK${RESET} ($(du -sh "$CATGO_DIR/frontend" 2>/dev/null | cut -f1))"
else
    echo -e "  ${YELLOW}Frontend: MISSING${RESET}"
    echo "    Build on your local machine and upload:"
    echo "    pnpm build && scp -r build/ ${USER}@${LOGIN_HOST}:~/catgo/frontend/"
fi
if [[ -f "$CATGO_DIR/server/main.py" ]]; then
    echo -e "  ${GREEN}Server:   OK${RESET}"
else
    echo -e "  ${RED}Server:   MISSING${RESET}"
fi
echo ""
echo "  Next steps:"
echo ""
echo "    ${BOLD}One-click launch (recommended):${RESET}"
echo "       bash ~/catgo/catgo-launch.sh"
echo ""
echo "    Or manual steps:"
echo "    1. Submit a job:"
echo "       cd ~/catgo && sbatch catgo-job.sh"
echo ""
echo "    2. Check the output file for the compute node name:"
echo "       cat catgo-*.out"
echo ""
echo "    3. On your LOCAL machine, create an SSH tunnel:"
echo "       ssh -L ${PORT}:<NODE>:${PORT} ${USER}@${LOGIN_HOST}"
echo ""
echo "    4. Open in browser:"
echo "       http://localhost:${PORT}"
echo ""
echo "  Share this installer with colleagues:"
echo "    curl -fsSL https://raw.githubusercontent.com/Hello-QM/CatGO/dev/deploy/hpc/install-catgo.sh | bash"
echo ""

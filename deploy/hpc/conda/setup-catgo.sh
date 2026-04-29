#!/bin/bash
#===============================================================================
# CatGO Conda Environment Setup for SDSC Expanse
#
# Run this on the login node (which has internet access).
# The conda env lives on the shared filesystem, so compute nodes can use it.
#
# Prerequisites:
#   - miniforge3 installed (e.g. at ~/miniforge3)
#   - This script + the CatGO bundle (frontend/ and server/ directories)
#
# Usage:
#   bash setup-catgo.sh
#
# After setup:
#   sbatch catgo-job.sh
#===============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_NAME="catgo"
PYTHON_VERSION="3.11"

echo "=== CatGO Conda Environment Setup ==="
echo "  Node: $(hostname -s)"
echo "  Time: $(date)"
echo ""

# ─── Locate and initialize conda ───
CONDA_BASE=""
if [[ -d "$HOME/miniforge3" ]]; then
    CONDA_BASE="$HOME/miniforge3"
elif [[ -d "$HOME/miniconda3" ]]; then
    CONDA_BASE="$HOME/miniconda3"
elif [[ -d "$HOME/anaconda3" ]]; then
    CONDA_BASE="$HOME/anaconda3"
else
    echo "ERROR: conda not found. Install miniforge3 first:"
    echo "  curl -L -O https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh"
    echo "  bash Miniforge3-Linux-x86_64.sh -b -p ~/miniforge3"
    exit 1
fi

# Initialize conda for this shell session
source "$CONDA_BASE/etc/profile.d/conda.sh"

echo "Using conda: $(conda --version) from $CONDA_BASE"
echo ""

# ─── Create or update environment ───
if conda env list | grep -q "^${ENV_NAME} "; then
    echo "Environment '$ENV_NAME' already exists. Activating..."
    conda activate "$ENV_NAME"
else
    echo "Creating conda environment '$ENV_NAME' with Python $PYTHON_VERSION..."
    conda create -n "$ENV_NAME" python="$PYTHON_VERSION" -y
    conda activate "$ENV_NAME"
fi

echo "Python: $(python --version)"
echo ""

# ─── Install core dependencies ───
echo "=== Installing core dependencies ==="
pip install --no-cache-dir \
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
echo ""

# ─── Install PyTorch (CPU) ───
echo "=== Installing PyTorch (CPU) ==="
pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
echo ""

# ─── Install ML potentials ───
echo "=== Installing ML potentials ==="
pip install --no-cache-dir "mace-torch>=0.3.0"
pip install --no-cache-dir "chgnet>=0.3.0"
pip install --no-cache-dir "matgl>=1.0.0"
echo ""

# ─── Install xTB (semi-empirical) ───
echo "=== Installing tblite (xTB) ==="
pip install --no-cache-dir "tblite[ase]>=0.3.0"
echo ""

# ─── Install Sella (TS search) ───
echo "=== Installing Sella ==="
pip install --no-cache-dir setuptools-scm
pip install --no-cache-dir --no-build-isolation "sella>=2.3.0"
echo ""

# ─── Deploy frontend and server ───
DEPLOY_DIR="$HOME/catgo"
echo "=== Deploying CatGO to $DEPLOY_DIR ==="
mkdir -p "$DEPLOY_DIR"

if [[ -d "$SCRIPT_DIR/frontend" ]]; then
    echo "  Copying frontend..."
    rm -rf "$DEPLOY_DIR/frontend"
    cp -r "$SCRIPT_DIR/frontend" "$DEPLOY_DIR/frontend"
    echo "  Frontend: $(du -sh "$DEPLOY_DIR/frontend" | cut -f1)"
else
    echo "  WARNING: frontend/ not found in $SCRIPT_DIR"
    echo "  You'll need to copy the pre-built frontend manually:"
    echo "    scp -r deploy/hpc/bundle/frontend jpascasio@login.expanse.sdsc.edu:~/catgo/"
fi

if [[ -d "$SCRIPT_DIR/server" ]]; then
    echo "  Copying server..."
    rm -rf "$DEPLOY_DIR/server"
    cp -r "$SCRIPT_DIR/server" "$DEPLOY_DIR/server"
    echo "  Server: OK"
else
    echo "  WARNING: server/ not found in $SCRIPT_DIR"
    echo "  You'll need to copy the server manually:"
    echo "    scp -r server jpascasio@login.expanse.sdsc.edu:~/catgo/"
fi

mkdir -p "$DEPLOY_DIR/data"

# ─── Verify all imports ───
echo ""
echo "=== Verifying imports ==="
python -c "import fastapi; print(f'  FastAPI {fastapi.__version__}')"
python -c "import ase; print(f'  ASE {ase.__version__}')"
python -c "from importlib.metadata import version; print(f'  pymatgen {version(\"pymatgen\")}')"
python -c "import torch; print(f'  PyTorch {torch.__version__} (CPU)')"
python -c "from mace.calculators import mace_mp; print('  MACE: OK')"
python -c "from chgnet.model import CHGNet; print('  CHGNet: OK')"
python -c "import matgl; print(f'  MatGL {matgl.__version__} (M3GNet): OK')"
python -c "from tblite.ase import TBLite; print('  tblite (xTB): OK')"
python -c "from sella import Sella, IRC; print('  Sella: OK')"
echo "=== All imports verified ==="

# ─── Print summary ───
echo ""
echo "============================================================"
echo " CatGO setup complete!"
echo ""
echo "  Environment: conda activate $ENV_NAME"
echo "  Frontend:    $DEPLOY_DIR/frontend/"
echo "  Server:      $DEPLOY_DIR/server/"
echo "  Data:        $DEPLOY_DIR/data/"
echo ""
echo " To run on a compute node:"
echo "   sbatch $SCRIPT_DIR/catgo-job.sh"
echo ""
echo " Or interactively:"
echo "   srun --account=sdp116 --partition=shared --cpus-per-task=4 --mem=16G --time=00:30:00 --pty /bin/bash"
echo "   conda activate $ENV_NAME"
echo "   cd ~/catgo && python server/main.py"
echo "============================================================"

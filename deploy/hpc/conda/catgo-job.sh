#!/bin/bash
#===============================================================================
# CatGO Slurm Job Script for SDSC Expanse (Conda version)
#
# Serves both frontend + backend through a single uvicorn process on port 8000.
# Access via SSH tunnel from your local machine.
#
# Usage:
#   sbatch catgo-job.sh
#
# Prerequisites:
#   Run setup-catgo.sh first (creates conda env + deploys files)
#===============================================================================

#SBATCH --job-name=catgo
#SBATCH --account=sdp116
#SBATCH --partition=shared
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=00:30:00
#SBATCH --output=catgo-%j.out
#SBATCH --error=catgo-%j.err

# ─── Configuration ───
CATGO_DIR="${HOME}/catgo"
PORT=8000
CONDA_ENV="catgo"

# ─── Activate conda ───
CONDA_BASE=""
if [[ -d "$HOME/miniforge3" ]]; then
    CONDA_BASE="$HOME/miniforge3"
elif [[ -d "$HOME/miniconda3" ]]; then
    CONDA_BASE="$HOME/miniconda3"
elif [[ -d "$HOME/anaconda3" ]]; then
    CONDA_BASE="$HOME/anaconda3"
else
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
echo " Python:   $(python --version 2>&1)"
echo ""
echo " To connect, run this on your LOCAL machine:"
echo ""
echo "   ssh -L ${PORT}:${NODE}:${PORT} ${USER}@login.expanse.sdsc.edu"
echo ""
echo " Then open:  http://localhost:${PORT}"
echo " API docs:   http://localhost:${PORT}/docs"
echo ""
echo " To stop:    scancel $SLURM_JOB_ID"
echo "============================================================"

# ─── Verify deployment ───
if [[ ! -f "$CATGO_DIR/frontend/index.html" ]]; then
    echo "ERROR: Frontend not found at $CATGO_DIR/frontend/"
    echo "Run setup-catgo.sh first."
    exit 1
fi
if [[ ! -f "$CATGO_DIR/server/main.py" ]]; then
    echo "ERROR: Server not found at $CATGO_DIR/server/"
    echo "Run setup-catgo.sh first."
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

# SPA catch-all: any non-API, non-file route serves index.html
@app.api_route('/{path:path}', methods=['GET'], include_in_schema=False)
async def spa_fallback(path: str):
    file_path = os.path.join(frontend_dir, path)
    if os.path.isfile(file_path):
        # Serve static file with correct content type
        return FileResponse(file_path)
    return FileResponse(index_html)

# Mount static files at root (lower priority than API routes)
app.mount('/', StaticFiles(directory=frontend_dir, html=True), name='frontend')

print(f'CatGO serving frontend from {frontend_dir}')
print(f'Starting on port $PORT...')
uvicorn.run(app, host='0.0.0.0', port=$PORT, workers=1, log_level='info')
"

echo ""
echo "CatGO stopped."

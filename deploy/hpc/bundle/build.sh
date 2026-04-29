#!/bin/bash
#===============================================================================
# CatGO Container Build for Expanse — Fully Offline
#
# Everything is pre-staged: base image tar, pip wheels, frontend, server.
# No internet access needed. Run on a compute node.
#
# Usage (interactive):
#   srun --account=sdp116 --partition=shared --cpus-per-task=8 --mem=32G --time=01:00:00 --pty /bin/bash
#   cd ~/catgo-build && bash build.sh
#
# Usage (batch):
#   sbatch build.sh
#===============================================================================

#SBATCH --job-name=catgo-build
#SBATCH --account=sdp116
#SBATCH --partition=shared
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --time=01:00:00
#SBATCH --output=catgo-build-%j.out
#SBATCH --error=catgo-build-%j.err

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== CatGO Container Build (Fully Offline) ==="
echo "  Node: $(hostname -s)"
echo "  Time: $(date)"
echo ""

module load singularitypro

# Singularity temp on local scratch (not Lustre)
if [[ -n "${SLURM_JOB_ID:-}" ]]; then
    export SINGULARITY_TMPDIR="/scratch/$USER/job_$SLURM_JOB_ID"
else
    export SINGULARITY_TMPDIR="/tmp/catgo-build-$$"
fi
mkdir -p "$SINGULARITY_TMPDIR"
export TMPDIR="$SINGULARITY_TMPDIR"

# Verify prerequisites
echo "Checking prerequisites..."
FAIL=0
for f in catgo-base-amd64.tar catgo-expanse.def; do
    if [[ ! -f "$f" ]]; then
        echo "  MISSING: $f"
        FAIL=1
    fi
done
for d in frontend server wheels; do
    if [[ ! -d "$d" ]]; then
        echo "  MISSING: $d/"
        FAIL=1
    fi
done
if [[ $FAIL -eq 1 ]]; then
    echo "ERROR: Missing files. Make sure you unpacked the bundle correctly."
    exit 1
fi

WHEEL_COUNT=$(ls -1 wheels/ | wc -l)
echo "  catgo-base-amd64.tar: $(du -h catgo-base-amd64.tar | cut -f1)"
echo "  frontend/: $(du -sh frontend | cut -f1)"
echo "  server/: OK"
echo "  wheels/: $WHEEL_COUNT packages ($(du -sh wheels | cut -f1))"
echo ""

# Remove old .sif
OUTPUT="catgo.sif"
rm -f "$OUTPUT"

# Build
echo "Building $OUTPUT ..."
echo "  (this may take 10-20 minutes)"
echo ""

singularity build --fakeroot "$OUTPUT" catgo-expanse.def

if [[ -f "$OUTPUT" ]]; then
    SIZE=$(du -h "$OUTPUT" | cut -f1)
    echo ""
    echo "============================================================"
    echo " Build complete!"
    echo "  Image: $OUTPUT ($SIZE)"
    echo ""
    echo " Deploy:"
    echo "   cp $OUTPUT ~/containers/catgo.sif"
    echo "   sbatch catgo-job.sh"
    echo "============================================================"
else
    echo ""
    echo "ERROR: Build failed."
    exit 1
fi

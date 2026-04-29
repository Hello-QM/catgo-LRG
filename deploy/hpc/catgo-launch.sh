#!/bin/bash
#===============================================================================
# CatGO One-Click Launch Script
#
# Automates: sbatch → wait for allocation → print SSH tunnel command
#
# Usage:
#   bash ~/catgo/catgo-launch.sh             # submit + wait + print tunnel
#   bash ~/catgo/catgo-launch.sh --tail      # also tail job output
#   bash ~/catgo/catgo-launch.sh --no-wait   # submit only, don't wait
#
# Requires: install-catgo.sh to have been run first
#===============================================================================

set -euo pipefail

# ─── Defaults ───
CATGO_DIR="${CATGO_DIR:-$HOME/catgo}"
JOB_SCRIPT="$CATGO_DIR/catgo-job.sh"
POLL_INTERVAL=5
POLL_TIMEOUT=600  # 10 minutes
DO_WAIT=true
DO_TAIL=false

# ─── Parse arguments ───
for arg in "$@"; do
    case "$arg" in
        --no-wait) DO_WAIT=false ;;
        --tail)    DO_TAIL=true ;;
        --help|-h)
            echo "Usage: bash catgo-launch.sh [--no-wait] [--tail]"
            echo ""
            echo "  --no-wait   Submit the job and exit without waiting"
            echo "  --tail      Tail the job output after it starts running"
            echo "  --help      Show this help"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

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

# ─── Banner ───
echo ""
echo -e "${BOLD}CatGO Launcher${RESET}"
echo ""

# ─── Verify job script exists ───
if [[ ! -f "$JOB_SCRIPT" ]]; then
    error "Job script not found: $JOB_SCRIPT"
    error "Run install-catgo.sh first."
    exit 1
fi

# ─── Activate conda ───
CONDA_BASE=""
for candidate in "$HOME/miniforge3" "$HOME/miniconda3" "$HOME/anaconda3"; do
    [[ -d "$candidate" ]] && CONDA_BASE="$candidate" && break
done
if [[ -n "$CONDA_BASE" ]]; then
    source "$CONDA_BASE/etc/profile.d/conda.sh"
    conda activate catgo 2>/dev/null || true
fi

# ─── Submit job ───
info "Submitting job..."
SBATCH_OUTPUT=$(sbatch "$JOB_SCRIPT" 2>&1)
SBATCH_EXIT=$?

if [[ $SBATCH_EXIT -ne 0 ]]; then
    error "sbatch failed: $SBATCH_OUTPUT"
    exit 1
fi

# Parse job ID from "Submitted batch job 12345"
JOB_ID=""
for word in $SBATCH_OUTPUT; do
    if [[ "$word" =~ ^[0-9]+$ ]]; then
        JOB_ID="$word"
        break
    fi
done

if [[ -z "$JOB_ID" ]]; then
    error "Could not parse job ID from: $SBATCH_OUTPUT"
    exit 1
fi

info "Job submitted: ${BOLD}$JOB_ID${RESET}"

if [[ "$DO_WAIT" == false ]]; then
    echo ""
    echo "  Check status:  squeue -j $JOB_ID"
    echo "  Cancel:         scancel $JOB_ID"
    exit 0
fi

# ─── Wait for job to start running ───
info "Waiting for allocation..."
SPINNER=('|' '/' '-' '\')
ELAPSED=0
STATE=""
NODE=""
idx=0

while [[ $ELAPSED -lt $POLL_TIMEOUT ]]; do
    # Get job state
    STATE=$(squeue -j "$JOB_ID" -h -o '%T' 2>/dev/null || echo "")

    if [[ "$STATE" == "RUNNING" ]]; then
        # Get assigned node
        NODE=$(scontrol show job "$JOB_ID" 2>/dev/null | grep -oP 'NodeList=\K[^ ]+' || echo "")
        break
    elif [[ -z "$STATE" ]]; then
        # Job no longer in queue — check if it completed/failed
        SACCT_STATE=$(sacct -j "$JOB_ID" -n -o State --parsable2 2>/dev/null | head -1 || echo "UNKNOWN")
        error "Job $JOB_ID is no longer queued (state: $SACCT_STATE)"
        exit 1
    fi

    # Show spinner
    printf "\r  ${SPINNER[$idx]} Waiting... (${STATE:-UNKNOWN}, ${ELAPSED}s)  "
    idx=$(( (idx + 1) % 4 ))
    sleep "$POLL_INTERVAL"
    ELAPSED=$((ELAPSED + POLL_INTERVAL))
done

# Clear spinner line
printf "\r                                              \r"

if [[ "$STATE" != "RUNNING" ]]; then
    error "Timed out after ${POLL_TIMEOUT}s waiting for job $JOB_ID to start"
    echo "  Current state: $STATE"
    echo "  Cancel with:   scancel $JOB_ID"
    exit 1
fi

info "Job $JOB_ID is ${GREEN}RUNNING${RESET} on node ${BOLD}$NODE${RESET}"

# ─── Detect login host for SSH tunnel ───
LOGIN_HOST="localhost"
HOSTNAME_F=$(hostname -f 2>/dev/null || hostname)
if [[ "$HOSTNAME_F" == *expanse* ]]; then
    LOGIN_HOST="login.expanse.sdsc.edu"
elif [[ "$HOSTNAME_F" == *stampede* ]]; then
    LOGIN_HOST="stampede2.tacc.utexas.edu"
elif [[ "$HOSTNAME_F" == *frontera* ]]; then
    LOGIN_HOST="frontera.tacc.utexas.edu"
elif [[ "$HOSTNAME_F" == *perlmutter* || "$HOSTNAME_F" == *nid* ]]; then
    LOGIN_HOST="perlmutter-p1.nersc.gov"
fi

# ─── Read port from job script ───
PORT="${CATGO_PORT:-8000}"

# ─── Print connection instructions ───
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  CatGO is ready!                                        ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "  On your LOCAL machine, run:"
echo ""
echo -e "    ${CYAN}ssh -L ${PORT}:${NODE}:${PORT} ${USER}@${LOGIN_HOST}${RESET}"
echo ""
echo "  Then open in browser:"
echo ""
echo -e "    ${CYAN}http://localhost:${PORT}${RESET}"
echo ""
echo "  To stop:  scancel $JOB_ID"
echo ""

# ─── Optional: tail job output ───
if [[ "$DO_TAIL" == true ]]; then
    # Find the output file
    OUT_FILE="$CATGO_DIR/catgo-${JOB_ID}.out"
    if [[ ! -f "$OUT_FILE" ]]; then
        # Wait a moment for the file to appear
        sleep 2
    fi
    if [[ -f "$OUT_FILE" ]]; then
        info "Tailing output (Ctrl+C to stop)..."
        echo ""
        tail -f "$OUT_FILE"
    else
        warn "Output file not found: $OUT_FILE"
    fi
fi

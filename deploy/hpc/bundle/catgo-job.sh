#!/bin/bash
#===============================================================================
# CatGO Slurm Job Script for SDSC Expanse
#
# Launches the CatGO container as a web service on a compute node.
# Access via SSH tunnel from your local machine.
#
# Usage:
#   sbatch catgo-job.sh
#
# Prerequisites:
#   ~/containers/catgo.sif must exist
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

# ---- Configuration ----
SIF_PATH="${HOME}/containers/catgo.sif"
FRONTEND_PORT=8080
BACKEND_PORT=8000

DATA_DIR="${HOME}/catgo-data"
mkdir -p "$DATA_DIR"

# ---- Environment setup ----
module load singularitypro

# Apptainer cache/tmp must NOT be on Lustre
export SINGULARITY_CACHEDIR="/expanse/lustre/scratch/$USER/temp_project/.singularity_cache"
mkdir -p "$SINGULARITY_CACHEDIR"

if [[ -n "$SLURM_JOB_ID" ]]; then
    export SINGULARITY_TMPDIR="/scratch/$USER/job_$SLURM_JOB_ID"
    mkdir -p "$SINGULARITY_TMPDIR"
fi

# Pass config into the container
export SINGULARITYENV_CATGO_FRONTEND_PORT="$FRONTEND_PORT"
export SINGULARITYENV_CATGO_BACKEND_PORT="$BACKEND_PORT"
export SINGULARITYENV_SERVER_PORT="$BACKEND_PORT"
export SINGULARITYENV_MACE_DEVICE="cpu"

# ---- Print connection instructions ----
NODE=$(hostname -s)
echo "============================================================"
echo " CatGO - Materials Science Visualization Toolkit"
echo "============================================================"
echo ""
echo " Node:     $NODE"
echo " Job ID:   $SLURM_JOB_ID"
echo ""
echo " To connect, run this on your LOCAL machine:"
echo ""
echo "   ssh -L ${FRONTEND_PORT}:${NODE}:${FRONTEND_PORT} ${USER}@login.expanse.sdsc.edu"
echo ""
echo " Then open:  http://localhost:${FRONTEND_PORT}"
echo ""
echo " To stop:    scancel $SLURM_JOB_ID"
echo "============================================================"

# ---- Generate nginx config ----
NGINX_CONF="${SINGULARITY_TMPDIR:-/tmp}/nginx-catgo.conf"
cat > "$NGINX_CONF" <<NGINX_EOF
worker_processes 1;
error_log /tmp/nginx-error.log warn;
pid /tmp/nginx.pid;

events {
    worker_connections 128;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    access_log /tmp/nginx-access.log;
    sendfile on;

    client_body_temp_path /tmp/nginx_client_body;
    proxy_temp_path /tmp/nginx_proxy;
    fastcgi_temp_path /tmp/nginx_fastcgi;
    uwsgi_temp_path /tmp/nginx_uwsgi;
    scgi_temp_path /tmp/nginx_scgi;

    server {
        listen ${FRONTEND_PORT};
        root /opt/catgo/frontend;
        index index.html;

        location / {
            try_files \$uri \$uri/ /index.html;
        }

        location /api/ {
            proxy_pass http://127.0.0.1:${BACKEND_PORT};
            proxy_http_version 1.1;
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_read_timeout 600s;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection "upgrade";
        }

        location ~* \.wasm\$ {
            types { application/wasm wasm; }
            add_header Cross-Origin-Opener-Policy same-origin;
            add_header Cross-Origin-Embedder-Policy require-corp;
        }

        location ~* \.(js|css|png|jpg|svg|ico|woff2?)$ {
            expires 7d;
            add_header Cache-Control "public, immutable";
        }
    }
}
NGINX_EOF

# ---- Launch backend inside container ----
echo "Starting CatGO backend on port $BACKEND_PORT..."
singularity exec \
    --bind "${DATA_DIR}:/opt/catgo/data" \
    --bind "${SINGULARITY_TMPDIR:-/tmp}:/tmp" \
    "$SIF_PATH" \
    python -c "
import uvicorn, sys
sys.path.insert(0, '/opt/catgo/server')
uvicorn.run('main:app', host='127.0.0.1', port=${BACKEND_PORT}, workers=1, log_level='info')
" &
BACKEND_PID=$!

sleep 3

# ---- Launch nginx inside container ----
echo "Starting nginx on port $FRONTEND_PORT..."
singularity exec \
    --bind "${DATA_DIR}:/opt/catgo/data" \
    --bind "${SINGULARITY_TMPDIR:-/tmp}:/tmp" \
    --bind "${NGINX_CONF}:${NGINX_CONF}:ro" \
    "$SIF_PATH" \
    nginx -c "$NGINX_CONF" -g "daemon off;" &
NGINX_PID=$!

sleep 1
echo ""
echo "CatGO is running!"
echo "  Frontend: http://${NODE}:${FRONTEND_PORT}"
echo "  Backend:  http://${NODE}:${BACKEND_PORT}"
echo ""

# ---- Cleanup on exit ----
cleanup() {
    echo "Shutting down CatGO..."
    kill $NGINX_PID 2>/dev/null
    kill $BACKEND_PID 2>/dev/null
    wait $NGINX_PID 2>/dev/null
    wait $BACKEND_PID 2>/dev/null
    echo "CatGO stopped."
}
trap cleanup SIGTERM SIGINT EXIT

# Keep alive until walltime or scancel
wait $BACKEND_PID $NGINX_PID

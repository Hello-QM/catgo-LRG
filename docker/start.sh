#!/usr/bin/env bash
# Entry point: launch FastAPI backend + Caddy static server, forward signals.
set -euo pipefail

BACKEND_PORT="${CATGO_BACKEND_PORT:-8000}"
FRONTEND_PORT="${CATGO_FRONTEND_PORT:-3100}"

echo "[start.sh] catgo-LRG container: backend=:${BACKEND_PORT}, frontend=:${FRONTEND_PORT}"

pids=()

cleanup() {
        echo "[start.sh] stopping…"
        for pid in "${pids[@]}"; do
                kill -TERM "$pid" 2>/dev/null || true
        done
        wait || true
}
trap cleanup TERM INT

cd /app/server
python main.py &
pids+=($!)

cd /app
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
pids+=($!)

# Exit when any child exits (so docker restart policies trigger correctly).
wait -n "${pids[@]}"
echo "[start.sh] a child process exited; shutting down the rest."
cleanup
exit 1

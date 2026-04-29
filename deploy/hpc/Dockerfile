# Docker equivalent of catgo.def for building/testing on macOS.
# Mirrors the Apptainer definition exactly so we can validate all installs.
#
# Build:   docker build -t catgo -f deploy/hpc/Dockerfile .
# Test:    docker run --rm catgo python -c "from mace.calculators import mace_mp; print('OK')"
# Export:  docker save catgo -o deploy/hpc/catgo-docker.tar
# Convert: apptainer build catgo.sif docker-archive://catgo-docker.tar  (on Linux)

# ================================================================
# Stage 1: Build the SvelteKit static frontend
# ================================================================
FROM node:20-bookworm-slim AS frontend-build

RUN npm install -g pnpm@9

WORKDIR /build

# Copy dependency manifests first (cache-friendly ordering)
COPY package.json pnpm-lock.yaml ./
# Pre-compiled WASM package (link: dependency in package.json)
COPY extensions/rust-wasm/ extensions/rust-wasm/

RUN pnpm install --frozen-lockfile

# Copy source after install so node_modules layer is cached
COPY src/ src/
COPY static/ static/
COPY svelte.config.js vite.config.ts tsconfig.json contributing.md ./
# vite.config.ts imports this mock (only used in test mode, but import must resolve)
COPY extensions/vscode/tests/vscode-mock.js extensions/vscode/tests/vscode-mock.js

# Build with SERVER_PORT=8080 so the frontend API URL matches the nginx proxy port
ENV SERVER_PORT=8080
# Increase Node.js heap for large Vite/Svelte builds
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN pnpm build \
    && test -f build/index.html || (echo "ERROR: SvelteKit build failed" && exit 1)


# ================================================================
# Stage 2: Runtime image (Python + nginx, no Node.js)
# ================================================================
FROM python:3.11-slim-bookworm AS runtime

LABEL author="CatGO Team"
LABEL description="CatGO materials science visualization toolkit for HPC"
LABEL version="0.3.0"

# Copy built frontend from stage 1
COPY --from=frontend-build /build/build /opt/catgo/frontend

# Copy Python server
COPY server/ /opt/catgo/server/

# System dependencies (gcc/g++/gfortran needed to compile CHGNet, tblite, etc.)
# liblapack-dev + libopenblas-dev needed by tblite (xTB)
RUN apt-get update && apt-get install -y --no-install-recommends \
        nginx \
        gcc \
        g++ \
        gfortran \
        python3-dev \
        cmake \
        pkg-config \
        liblapack-dev \
        libopenblas-dev \
        git \
    && rm -rf /var/lib/apt/lists/*

# --- Python dependencies (all 5 calculators + Sella) ---

# PyTorch CPU-only (smaller than full CUDA build)
RUN pip install --no-cache-dir \
    torch --index-url https://download.pytorch.org/whl/cpu

# Core server dependencies
RUN pip install --no-cache-dir \
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

# ML potentials
RUN pip install --no-cache-dir "mace-torch>=0.3.0"
RUN pip install --no-cache-dir "chgnet>=0.3.0"
RUN pip install --no-cache-dir "matgl>=1.0.0"

# Semi-empirical (xTB)
RUN pip install --no-cache-dir "tblite[ase]>=0.3.0"

# Sella (transition state search + IRC)
RUN pip install --no-cache-dir setuptools-scm \
    && pip install --no-cache-dir --no-build-isolation "sella>=2.3.0"

# Create runtime directories
RUN mkdir -p /var/log/catgo /run/nginx /opt/catgo/data

# --- Verify ALL critical imports (fail build if any missing) ---
RUN python -c "import fastapi; print(f'FastAPI {fastapi.__version__}')" \
    && python -c "import ase; print(f'ASE {ase.__version__}')" \
    && python -c "from importlib.metadata import version; print(f'pymatgen {version(\"pymatgen\")}')" \
    && python -c "from mace.calculators import mace_mp; print('MACE: OK')" \
    && python -c "from chgnet.model import CHGNet; print('CHGNet: OK')" \
    && python -c "import matgl; print(f'MatGL {matgl.__version__} (M3GNet): OK')" \
    && python -c "from tblite.ase import TBLite; print('tblite (xTB): OK')" \
    && python -c "from sella import Sella, IRC; print('Sella: OK')" \
    && echo "=== All imports verified ==="

ENV CATGO_FRONTEND_DIR=/opt/catgo/frontend \
    CATGO_DATA_DIR=/opt/catgo/data \
    LC_ALL=C.UTF-8 \
    LANG=C.UTF-8 \
    CATGO_FRONTEND_PORT=8080 \
    CATGO_BACKEND_PORT=8000 \
    MACE_DEVICE=cpu

EXPOSE 8080 8000

CMD ["python", "/opt/catgo/server/main.py"]

# syntax=docker/dockerfile:1.7
# catgo-LRG — Docker image (web mode, Linux x86_64 / arm64).
#
# Runs the Python backend + the built SvelteKit frontend (no Tauri shell).
# Cross-platform usage: any host with Docker Desktop (Windows / Linux / macOS)
# can pull and run this image; the user opens http://localhost:3100 in a browser.
#
# NOT a Tauri native installer. Native .msi / .exe / .AppImage / .deb / .dmg
# must be built per-OS via `pnpm tauri:build:<target>` on the matching OS
# runner (see .github/workflows or the README). Docker cannot cross-build to
# Windows/macOS native binaries.

# ---------- Stage 1: builder ------------------------------------------------
FROM node:22-bookworm-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:/root/.cargo/bin:$PATH \
    CARGO_NET_GIT_FETCH_WITH_CLI=true

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git build-essential pkg-config libssl-dev python3 \
    && rm -rf /var/lib/apt/lists/*

# pnpm pinned to packageManager field
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# Rust + wasm-pack (for extensions/rust-wasm)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain stable --profile minimal \
    && cargo install wasm-pack --locked

WORKDIR /app

# Manifest layer for cache
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc .nvmrc ./
COPY patches ./patches
COPY extensions/rust-wasm/package.json ./extensions/rust-wasm/
# Workspace child manifests (any others auto-handled by pnpm-workspace.yaml)
RUN --mount=type=cache,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline || pnpm install --frozen-lockfile

# Full source (after manifests for cache reuse)
COPY . .

# Build all WASM extensions and place where frontend expects them.
# 1) ferrox (extensions/rust-wasm) → frontend expects "chgdiff_wasm"
RUN cd extensions/rust-wasm && pnpm build \
    && cp -r pkg /app/src/lib/electronic/chgdiff-wasm-pkg \
    && cd /app/src/lib/electronic/chgdiff-wasm-pkg \
    && mv ferrox.js chgdiff_wasm.js \
    && mv ferrox_bg.wasm chgdiff_wasm_bg.wasm \
    && mv ferrox.d.ts chgdiff_wasm.d.ts 2>/dev/null || true \
    && sed -i 's/ferrox_bg\.wasm/chgdiff_wasm_bg.wasm/g' chgdiff_wasm.js

# 2) catrender-wasm → frontend expects "catrender_wasm"
RUN cd extensions/catrender-wasm \
    && wasm-pack build --target web --out-dir /app/src/lib/structure/catrender/catrender-wasm-pkg \
    && cd /app/src/lib/structure/catrender/catrender-wasm-pkg \
    && mv catrender_wasm.js catrender_wasm.js 2>/dev/null || true

# Generate docs-chunks.json for RAG
RUN pnpm build:doc-chunks

# Build static frontend → ./build-desktop
ENV VITE_STATIC_ONLY=true
RUN pnpm desktop:build

# ---------- Stage 2: runtime ------------------------------------------------
FROM python:3.11-slim-bookworm AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CATGO_BACKEND_PORT=8000 \
    CATGO_FRONTEND_PORT=3100 \
    CATGO_INSTALL_HEAVY=1

# System deps:
#   libgomp1, libopenblas0, libstdc++6 — numpy / scipy / pymatgen / mace-torch
#   curl, ca-certificates — downloads + caddy install
#   tini — proper PID-1 reaping
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl tini libgomp1 libopenblas0 libstdc++6 gnupg \
        python3-openbabel libopenbabel7 \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | tee /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update && apt-get install -y --no-install-recommends caddy \
    && apt-get purge -y --auto-remove gnupg \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/lib/python3/dist-packages/openbabel /usr/local/lib/python3.11/site-packages/openbabel

WORKDIR /app

# Python deps — install CPU-only torch first so mace-torch reuses it
# (avoids pulling the multi-GB CUDA wheel inside the container).
# openbabel is provided by system python3-openbabel above (skip from pip).
COPY server/requirements.txt /tmp/requirements.txt
RUN grep -v "^openbabel" /tmp/requirements.txt > /tmp/requirements_filtered.txt \
    && pip install --extra-index-url https://download.pytorch.org/whl/cpu \
        "torch>=2.2,<2.8" \
    && pip install -r /tmp/requirements_filtered.txt

# Backend code
COPY server ./server

# Built frontend + Caddy config
COPY --from=builder /app/build-desktop ./build-desktop
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 3100 8000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]

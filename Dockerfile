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

# Pinned nightly for the THREADED ferrox WASM artifact (std is rebuilt with
# atomics, which needs nightly + rust-src). One knob: consumed by BOTH the
# rustup install below and scripts/build-wasm.mjs, so the installed toolchain
# and the one the build selects can never diverge. Keep in sync with
# CATGO_WASM_NIGHTLY_TOOLCHAIN in .github/workflows/*.yml (bump procedure
# documented there).
ENV CATGO_WASM_NIGHTLY_TOOLCHAIN=nightly-2026-07-16

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git build-essential pkg-config libssl-dev python3 \
    && rm -rf /var/lib/apt/lists/*

# pnpm pinned to packageManager field
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# Rust + wasm-pack (all WASM extensions — scripts/build-wasm.mjs).
# Stable stays the default toolchain (scalar ferrox / chgdiff / catrender);
# the pinned nightly (with rust-src) is ONLY used by build-wasm.mjs for the
# THREADED ferrox artifact, which the deployed web version needs for
# large-system bonding (COI headers permitting).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --default-toolchain stable --profile minimal \
    && rustup target add wasm32-unknown-unknown \
    && rustup toolchain install "$CATGO_WASM_NIGHTLY_TOOLCHAIN" --profile minimal \
        --component rust-src --target wasm32-unknown-unknown \
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

# Build ALL WASM extensions via the unified script (design §8.3 — every
# production wasm build uses the same explicit feature set). Outputs land
# where the frontend imports them: ferrox scalar + threaded (+ pkg/ bridge)
# in extensions/rust-wasm/, chgdiff in src/lib/electronic/chgdiff-wasm-pkg/,
# catrender in src/lib/structure/catrender/catrender-wasm-pkg/. (The old
# ferrox→chgdiff rename hack here predates the dedicated
# extensions/chgdiff-wasm crate, which build-wasm.mjs builds directly.)
RUN pnpm build:wasm && pnpm verify:wasm

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
COPY --from=builder /app/build/legal-bundle /usr/share/doc/catgo
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY docker/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 3100 8000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/start.sh"]

# `src/lib/structure/workers/` Guide

This directory contains the async worker path for bond-related computations.

## Current Design

The runtime tries to keep bond computation off the main thread when possible:

1. Worker + WASM
2. Main-thread WASM fallback
3. Main-thread JS fallback

The public entry point is `bond-worker-api.ts`.

## Important Facts

- worker initialization is lazy
- the worker receives a compiled `WebAssembly.Module`
- worker startup can fail in restrictive environments, so fallback behavior matters
- `compute_bonds_async()` is the main async path
- `compute_bonds_sync()` is still used for small structures as a low-latency fallback

## What This Layer Does Not Solve

Status note:

- these are current scope boundaries and recurring pitfalls
- they should not be read as “all of these are active regressions”

- coordination-color calculation in `atom-properties.ts` still uses synchronous bonding logic
- worker availability does not remove all UI stalls if the caller later falls back to main-thread WASM or JS
- this layer only computes bonding data; rendering and bond visibility live elsewhere

## Safe Assumptions

- do not assume the worker path is always active
- do not assume a specific bonding strategy is worker-only or JS-only unless the code currently proves it
- if debugging performance, inspect both the caller and the fallback chain

## Main Files

- `bond-worker-api.ts`
  - worker lifecycle
  - fallback ordering
  - request / response handling
- `bond-worker.ts`
  - worker runtime entry
  - WASM initialization in worker context

Related reading:

- `src/lib/structure/CLAUDE.md`
- `reports/bug-followup-2026-03-13.md`

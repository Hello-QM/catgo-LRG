# `src/lib/api/` Guide

This directory is the frontend data-access layer. The same exported API functions try to work across three runtime modes.

## Routing Model

The effective route is selected at runtime:

- Tauri desktop
  - `db-local.ts`
  - calls Rust commands through `invoke()`
- standalone desktop frontend
  - `db-wasm.ts`
  - uses sql.js plus Vite middleware for persistence / file access
- browser / web
  - direct `fetch()` to the Python backend

The switching logic lives in functions like `getLocal()` and uses Tauri detection plus `__CATGO_DESKTOP__`.

## Main Files

- `project.ts`
  - project CRUD
  - result CRUD
  - result structure loading
  - database file management helpers
- `workflow.ts`
  - workflow CRUD
  - run / pause / resume
  - templates
  - step files / step output / convergence
  - workflow monitor connection
- `db-local.ts`
  - thin wrapper over Rust Tauri commands
- `db-wasm.ts`
  - standalone desktop local database implementation
- `workflow-folder.ts`
  - legacy compatibility layer
  - still present in codebase, but not the preferred workflow ownership model

## Important Current Facts

- Workflows are primarily associated with projects.
- `workflow-folder.ts` and workflow-folder commands still exist, but current UI logic prefers project association.
- `workflow.ts` has server-only behaviors in some functions:
  - templates
  - run / pause / resume
  - monitor / step files / step output / convergence
- `EnrichedResult.id` is `number | null`, not guaranteed non-null.

Status note:

- this file records runtime routing facts and API-shape caveats
- if a caveat becomes a confirmed user-facing bug, its tracked status should live in `reports/bug-*.md` or `WORKFLOW_BUGS.md`, not only here

## `db-wasm.ts` Note

The sql.js implementation has repo-specific persistence helpers and workarounds. If behavior differs between browser and standalone desktop, check:

- `run_stmt(...)`
- persistence debounce / writeback logic
- Vite middleware endpoints used by the standalone desktop build

## Good Source of Truth

When in doubt, prefer:
- exported TypeScript interfaces in `project.ts` / `workflow.ts`
- Rust command names in `src-tauri/src/lib.rs`
- backend routes in `server/routers/workflow.py`

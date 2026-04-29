# `src-tauri/` Guide

This directory is the Rust backend for the Tauri desktop application.

## What Lives Here

- local SQLite database commands
- PTY / terminal commands
- opened-file integration
- backend process startup / shutdown for the packaged desktop app

## Main Files

- `src/lib.rs`
  - Tauri app entrypoint
  - command registration
  - backend child-process management
- `src/db.rs`
  - local SQLite implementation used by Tauri
- `src/pty.rs`
  - shell / PTY lifecycle and IO

## Important Current Facts

- The Rust DB layer mirrors the same broad schema families used by `db-wasm.ts`:
  - projects
  - workflows
  - workflow steps / edges
  - ASE-like system storage
- Workflow-folder tables and commands still exist for compatibility.
- Current UI logic prefers project-linked workflows over workflow folders.
- The Rust side now includes workflow CRUD and step-list commands expected by `db-local.ts`.

Status note:

- this file is a capability snapshot, not a current bug register
- any Tauri-specific confirmed bug should be tracked in a report or dedicated incident note with explicit status

## Do Not Rely On

Avoid relying on exact command counts in documentation. They change over time as Tauri commands are added or kept for compatibility.

Instead, inspect:
- `src/lib.rs` for the actual `generate_handler!` list
- `src/db.rs` for the actual command implementations

## Naming Mismatch Reminder

Frontend wrappers often expose snake_case TypeScript helpers, while Tauri invoke payloads use camelCase keys expected by Rust command parameters.

Examples:
- `parent_id` -> `parentId`
- `project_id` -> `projectId`
- `workflow_id` -> `workflowId`
- `row_id` -> `rowId`

## Good Source of Truth

- `src/lib.rs`
- `src/db.rs`
- `src/pty.rs`
- `src/lib/api/db-local.ts`

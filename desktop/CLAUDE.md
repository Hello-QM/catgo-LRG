# `desktop/` Guide

This directory is the standalone desktop frontend shell used outside full Tauri packaging.

## What It Does

- hosts the multi-pane desktop UI
- provides the desktop sidebar, tab shell, and workflow container views
- uses frontend mocks for `$app/*` so it can run without SvelteKit routing

## Main Files

- `App.svelte`
  - top-level desktop shell
  - tabs
  - pane layout
  - file-open / editor / export dialogs
- `Sidebar.svelte`
  - project tree
  - local DB browser
  - HPC file browser
  - drag/drop and context menus
- `WorkflowView.svelte`
  - switches between project list, project dashboard, workflow list, workflow editor

## Important Current Facts

- The standalone desktop shell is not the full Tauri app.
  - it works together with Vite middleware and `db-wasm.ts`
- The full packaged desktop app additionally uses `src-tauri/`.
- Workflow ownership is project-based in current UI flows.
- Legacy workflow-folder compatibility code still exists, but project association is the main path.

## HPC / File Browser Notes

- Sidebar HPC browsing reuses the `FileTree` interaction model.
- Desktop UI also coordinates with terminal state so current working directory and remote file browsing stay aligned.

## Svelte 5 `$state` Reactivity Pitfall

When updating deeply nested `$state` objects (e.g. `tab_states[key].panes[idx]`), always **mutate properties in-place** instead of spread-replacing the parent object.

```javascript
// WRONG — breaks @const reactivity in {#each} blocks
tab_states[key] = { ...ts, panes: new_panes }

// RIGHT — Svelte 5 deep proxy tracks in-place mutations
ts.panes[target].structure = imported
ts.panes[target].modified = false
```

Spreading a `$state` proxy creates a plain object. Reassigning the key wraps it in a new proxy, but `@const` bindings inside `{#each}` blocks that referenced the old proxy may not re-evaluate, causing the UI to silently fail to update. This caused a real bug where database imports on the landing page didn't switch the view.

## Good Source of Truth

- `App.svelte`
- `Sidebar.svelte`
- `WorkflowView.svelte`
- `vite.desktop.config.ts`

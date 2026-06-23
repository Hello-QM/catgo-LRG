# Fix multi-pane trajectory isolation and pane binding

## Suggested title

`fix(viewer): isolate multi-pane trajectories and bind library entries to exact panes`

## Summary

This PR fixes several related multi-pane viewer issues:

- Trajectories could share mutable state, causing structures to jump between panes or panes to become blank.
- Viewer communication was partly tab-scoped, preventing CatBot from reliably targeting a specific pane.
- Sidebar library entries were not linked to the exact panes displaying them.
- Svelte proxy metadata could cause `structuredClone()` to throw `DataCloneError`.

Each pane now has independent trajectory state, a stable `viewer_id`, and an exact `LibraryEntry.id` association.

## Main changes

### Independent trajectory panes

- Deep-clone trajectory frames, structures, coordinates, and metadata when loading them into a pane.
- Fork streaming loaders and keep caches, in-flight requests, and transformations pane-local.
- Add a proxy-safe clone fallback for reactive Svelte metadata.
- Ensure playback, scrubbing, editing, and closing one trajectory do not affect other panes.

### Stable viewer routing

- Identify every viewer as `<tab_id>:<leaf_id>`.
- Maintain a manifest containing each pane's position, filename, formula, frame information, and active state.
- Store backend viewer state per pane rather than per tab.
- Reset only the viewer belonging to the pane being closed.
- Allow CatBot to inspect and target panes by `viewer_id` or positions such as `top-left` and `bottom-right`.

### Exact library-to-pane binding

- Add `library_entry_id` to `PaneState`.
- Use entry IDs rather than filenames to associate panes with sidebar items.
- Treat repeated openings of the same file as separate instances.
- Selecting an already displayed entry focuses its existing pane.

Sidebar removal now follows a safe two-phase close flow:

1. Locate the pane bound to the selected entry.
2. Run the existing save/close confirmation.
3. Remove the entry only after that exact pane closes successfully.

This preserves the intended behavior:

| Action | Result |
|---|---|
| Close a pane from its header | Pane closes; sidebar entry remains |
| Remove a sidebar entry | Only its bound pane closes; entry is removed afterward |
| Cancel the close | Pane and entry both remain |
| Remove one of two same-name entries | Only the matching pane closes |
| Clear the sidebar list | Open panes remain unchanged |

## Scope

CatBot changes are limited to pane discovery and routing. This PR does not change unrelated agent tools, workflow behavior, terminal/HPC logic, or original trajectory files.

## Testing

Automated coverage includes:

- identical and different trajectories in multiple panes
- independent frames, loaders, transformations, and playback state
- Svelte proxy metadata cloning
- exact routing by viewer ID and pane position
- same-name static structures and trajectories
- direct pane closure versus sidebar removal
- cancel and delayed-save safety
- rejection of ambiguous legacy bindings

Relevant frontend regression results:

```text
Test Files  4 passed
Tests       26 passed
```

Backend tests cover pane-specific viewer state, commands, manifests, and legacy tab-ID compatibility.

Manual desktop verification confirmed:

- two instances of `ase-LiMnO2-chgnet-relax.traj` remain independent
- removing one same-name entry closes only its pane
- the other trajectory keeps its state
- direct pane closure keeps the sidebar entry
- static structure removal and cancellation behave correctly
- no runtime errors appear in the browser console

## Type-check note

No new type errors were found in the modified files. The repository still contains unrelated pre-existing `bond_scale` and `polyhedra_bond_scale` type errors.

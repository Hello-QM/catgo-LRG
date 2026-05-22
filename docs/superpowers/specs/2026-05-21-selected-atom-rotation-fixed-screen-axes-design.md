# Selected-Atom Rotation — Fixed Screen-Aligned Axes

**Date:** 2026-05-21
**Status:** Design approved, pending spec review
**Area:** Structure viewer — interactive rotation of selected atoms (frontend only)

## Problem

Rotating selected atoms today feels "weird." The current implementation
(`src/lib/structure/controllers/interaction.svelte.ts`) accumulates an
incremental quaternion every frame from camera-derived axes, and a single
left-button drag mixes pitch and yaw simultaneously (2 DOF). The compounding
quaternion product produces a tumbling, gimbal-like feel that is hard to
control and not reproducible.

## Goal

Replace the free-tumble behavior with a predictable, single-axis-at-a-time
rotation about a coordinate frame anchored to the selection's geometric center
and aligned to the screen.

## Coordinate Frame

Established **once at gesture start** and held fixed for the entire drag
(camera does not move while dragging atoms, so the frame is stable):

- **Origin** = geometric centroid of the selected *original* atoms (image /
  periodic-copy atoms excluded). Identical to current `atom_rotation_center`
  computation (`interaction.svelte.ts:487-495`).
- **Axes** = world axes transformed by the current camera quaternion, then
  locked:
  - `X` = screen normal, toward the viewer (`-forward`, i.e.
    `Vector3(0,0,-1).applyQuaternion(cam_quat)` negated to point at viewer — see Note)
  - `Y` = screen right (`Vector3(1,0,0).applyQuaternion(cam_quat)`)
  - `Z` = screen up (`Vector3(0,1,0).applyQuaternion(cam_quat)`)

Screen plane = `YZ` plane; `X` is its normal.

> **Note on X sign:** define `X` so that a positive roll angle reads as a
> natural counter-clockwise spin from the viewer's perspective. Final sign to
> be confirmed empirically during implementation; it only affects roll
> direction, not correctness.

## Input → Axis Mapping

**Left-button drag — direction-locked, one axis per drag:**
- A dead zone applies at drag start: the axis is **not** locked until the
  pointer has moved more than a small threshold (`AXIS_LOCK_DEADZONE_PX`,
  e.g. 4 px) from the mousedown point. This avoids jitter mis-locking.
- Once the threshold is crossed, the dominant component of the initial
  displacement picks the axis:
  - horizontal-dominant → rotate about `Z` (screen vertical axis; yaw)
  - vertical-dominant → rotate about `Y` (screen horizontal axis; pitch)
- The locked axis is held for the **entire drag until mouse release**. No
  mid-drag axis switching. The orthogonal pointer component is ignored.

**Right-button drag — roll:**
- Rotate about `X` (screen normal), driven by `delta_x`. No dead-zone axis
  selection needed (axis is always `X`).

## Angle Application

Single scalar angle accumulated about the locked axis:

```
angle += drag_delta_along_locked_direction * sensitivity
quat = new Quaternion().setFromAxisAngle(locked_axis, angle)
```

- `drag_delta_along_locked_direction` is `delta_x` for `Z`/`X` axes and
  `delta_y` for the `Y` axis (i.e. the dominant pointer component).
- This **replaces** the per-frame incremental-quaternion accumulation
  (`interaction.svelte.ts:1377-1396`) — the source of the tumbling feel.
- Per-atom application is unchanged: translate to centroid-relative, apply
  the single quaternion, translate back (`interaction.svelte.ts:1410-1424`).
- Visual feedback (`atom_rotation_axis`, `atom_rotation_angle_deg`) reads
  directly from the locked axis and scalar angle — no quaternion decomposition
  needed.

## Keyboard Path

`rotate_selected_atoms_keyboard()` (`interaction.svelte.ts:671-733`) adopts the
same fixed screen-aligned frame (centroid origin; X/Y/Z = screen
normal/right/up). Each key rotates a fixed `KEYBOARD_ROTATION_STEP` about one
fixed axis:
- Shift+Left/Right → about `Z`
- Shift+Up/Down → about `Y`
- W/S → about `X` (roll)

Discrete steps; consistent with the drag frame.

## Out of Scope / Unchanged

- All math stays in **Cartesian** (`xyz`, Å). Fractional `abc` recomputed only
  at commit by `move_atom` (`src/lib/structure/atom-manipulation.ts:385`).
- Commit path unchanged: `realtime_position_overrides` Map + `requestAnimationFrame`
  batching → `finish_rotation` → `commit_rotation_to_structure` →
  `apply_overrides_to_structure`.
- Fully client-side; no backend / HTTP request.
- Camera/view rotation (`interaction-handlers.ts`) untouched.

## Testing

- Unit-test the axis-lock decision: given an initial displacement vector and
  dead-zone threshold, asserts the chosen axis (none below threshold;
  Z for horizontal-dominant; Y for vertical-dominant).
- Unit-test scalar-angle → quaternion → per-atom position for a known
  centroid and axis (e.g. 90° about Z maps a known atom to expected xyz).
- Manual: drag locks one axis until release; right-drag rolls; keyboard steps
  match drag-frame axes; fractional coords correct after commit on a lattice.

## Key Files

- `src/lib/structure/controllers/interaction.svelte.ts`
  - `start_atom_rotation` `:466`, centroid `:487-495`
  - drag math to rewrite `:1352-1431` (esp. `:1377-1396`)
  - `rotate_selected_atoms_keyboard` `:671-733`
  - commit chain `:584` / `:557` / `:524` / `:416`
- `src/lib/structure/atom-manipulation.ts:385` — `move_atom` (Cart→frac)
- `src/lib/i18n/en/structure.ts:613-614` — UI hint strings (update wording)

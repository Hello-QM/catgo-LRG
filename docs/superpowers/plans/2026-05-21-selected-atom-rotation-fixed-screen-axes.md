# Selected-Atom Rotation — Fixed Screen-Aligned Axes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-tumbling quaternion-accumulation rotation of selected atoms with predictable single-axis rotation about a screen-aligned frame anchored at the selection centroid.

**Architecture:** Extract the rotation math into a pure, framework-free module (`rotation-math.ts`) that is unit-tested in isolation, then wire the drag and keyboard paths in `interaction.svelte.ts` to call it. The drag path locks one axis at gesture start (after a dead zone) and recomputes the rotation from the stored initial positions every frame, so no incremental quaternion product is accumulated.

**Tech Stack:** TypeScript, Three.js (`Quaternion`, `Vector3`), Svelte 5 runes (`$state`), Vitest (happy-dom), spec at `docs/superpowers/specs/2026-05-21-selected-atom-rotation-fixed-screen-axes-design.md`.

---

## File Structure

- **Create** `src/lib/structure/rotation-math.ts` — pure rotation helpers (screen frame, axis lock decision, point rotation, drag-delta-to-angle). No Svelte, no DOM. Importable by the controller and by tests.
- **Create** `tests/vitest/rotation-math.test.ts` — unit tests for every exported helper.
- **Modify** `src/lib/structure/controllers/interaction.svelte.ts` — add locked-axis + start-anchor state, rewrite the drag mousemove rotation block, refactor `rotate_selected_atoms_keyboard` to use the shared frame, reset new state in `finish_rotation`.
- **Modify** `src/lib/i18n/en/structure.ts` and `src/lib/i18n/zh/structure.ts` — update the rotate-atoms hint text.

Coordinate frame (origin = centroid; screen = YZ plane):
- `x` = screen normal toward viewer
- `y` = screen right
- `z` = screen up

Input → axis: left-drag horizontal-dominant → `z` (yaw); left-drag vertical-dominant → `y` (pitch); right-drag → `x` (roll). One axis per drag, locked at start after a dead zone.

---

### Task 1: Screen frame from camera quaternion

**Files:**
- Create: `src/lib/structure/rotation-math.ts`
- Test: `tests/vitest/rotation-math.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/vitest/rotation-math.test.ts
import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { screen_frame_from_camera } from '$lib/structure/rotation-math'

describe('screen_frame_from_camera', () => {
  it('identity camera: x toward viewer, y right, z up', () => {
    const frame = screen_frame_from_camera(new Quaternion())
    // identity: world right=(1,0,0), up=(0,1,0), forward=(0,0,-1)
    // x = -forward = (0,0,1) toward viewer; y = right; z = up
    expect(frame.x.toArray()).toEqual([0, 0, 1])
    expect(frame.y.toArray()).toEqual([1, 0, 0])
    expect(frame.z.toArray()).toEqual([0, 1, 0])
  })

  it('all axes are unit length and mutually orthogonal', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7)
    const f = screen_frame_from_camera(q)
    for (const v of [f.x, f.y, f.z]) expect(v.length()).toBeCloseTo(1, 6)
    expect(f.x.dot(f.y)).toBeCloseTo(0, 6)
    expect(f.y.dot(f.z)).toBeCloseTo(0, 6)
    expect(f.x.dot(f.z)).toBeCloseTo(0, 6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/rotation-math.test.ts`
Expected: FAIL — `screen_frame_from_camera` not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/structure/rotation-math.ts
import { Quaternion, Vector3 } from 'three'

/** Screen-aligned orthonormal frame. Origin is the selection centroid
 *  (supplied separately). x = screen normal toward viewer, y = screen
 *  right, z = screen up. Screen plane = YZ plane. */
export interface ScreenFrame {
  x: Vector3
  y: Vector3
  z: Vector3
}

/** Build the fixed screen frame from the camera quaternion captured at
 *  gesture start. */
export function screen_frame_from_camera(cam_quat: Quaternion): ScreenFrame {
  const right = new Vector3(1, 0, 0).applyQuaternion(cam_quat).normalize()
  const up = new Vector3(0, 1, 0).applyQuaternion(cam_quat).normalize()
  const forward = new Vector3(0, 0, -1).applyQuaternion(cam_quat).normalize()
  return { x: forward.clone().negate(), y: right, z: up }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/rotation-math.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/rotation-math.ts tests/vitest/rotation-math.test.ts
git commit -m "feat(rotation): screen_frame_from_camera pure helper"
```

---

### Task 2: Axis-lock decision with dead zone

**Files:**
- Modify: `src/lib/structure/rotation-math.ts`
- Test: `tests/vitest/rotation-math.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/vitest/rotation-math.test.ts
import { pick_locked_axis } from '$lib/structure/rotation-math'

describe('pick_locked_axis', () => {
  const dz = 4
  it('returns null inside the dead zone', () => {
    expect(pick_locked_axis(2, 2, dz)).toBeNull() // hypot ~2.83 < 4
  })
  it('horizontal-dominant drag locks z (yaw)', () => {
    expect(pick_locked_axis(10, 1, dz)).toBe('z')
  })
  it('vertical-dominant drag locks y (pitch)', () => {
    expect(pick_locked_axis(1, 10, dz)).toBe('y')
  })
  it('ties favor horizontal (z)', () => {
    expect(pick_locked_axis(5, 5, dz)).toBe('z') // hypot ~7.07 > 4
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/rotation-math.test.ts`
Expected: FAIL — `pick_locked_axis` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/lib/structure/rotation-math.ts

export type LockAxis = 'x' | 'y' | 'z'

/** Decide which axis a left-button drag locks onto, from the total
 *  displacement since mousedown. Returns null until the dead zone is
 *  exceeded. Horizontal-dominant → z (yaw); vertical-dominant → y (pitch).
 *  Ties favor horizontal. */
export function pick_locked_axis(
  total_dx: number,
  total_dy: number,
  deadzone_px: number,
): 'y' | 'z' | null {
  if (Math.hypot(total_dx, total_dy) < deadzone_px) return null
  return Math.abs(total_dx) >= Math.abs(total_dy) ? 'z' : 'y'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/rotation-math.test.ts`
Expected: PASS (6 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/rotation-math.ts tests/vitest/rotation-math.test.ts
git commit -m "feat(rotation): pick_locked_axis with dead zone"
```

---

### Task 3: Point rotation about center + drag-delta-to-angle

**Files:**
- Modify: `src/lib/structure/rotation-math.ts`
- Test: `tests/vitest/rotation-math.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/vitest/rotation-math.test.ts
import { rotate_points, drag_delta_for_axis } from '$lib/structure/rotation-math'

describe('rotate_points', () => {
  it('90° about z maps (1,0,0)+center back to center+(0,1,0)', () => {
    const center: [number, number, number] = [5, 5, 5]
    const pts: Array<[number, number, number]> = [[6, 5, 5]] // center + x_hat
    const out = rotate_points(pts, center, new Vector3(0, 0, 1), Math.PI / 2)
    expect(out[0][0]).toBeCloseTo(5, 6)
    expect(out[0][1]).toBeCloseTo(6, 6)
    expect(out[0][2]).toBeCloseTo(5, 6)
  })
  it('zero angle is identity', () => {
    const out = rotate_points([[1, 2, 3]], [0, 0, 0], new Vector3(0, 1, 0), 0)
    expect(out[0][0]).toBeCloseTo(1, 6)
    expect(out[0][1]).toBeCloseTo(2, 6)
    expect(out[0][2]).toBeCloseTo(3, 6)
  })
})

describe('drag_delta_for_axis', () => {
  it('pitch (y) reads vertical delta', () => {
    expect(drag_delta_for_axis('y', 3, 9)).toBe(9)
  })
  it('yaw (z) and roll (x) read horizontal delta', () => {
    expect(drag_delta_for_axis('z', 3, 9)).toBe(3)
    expect(drag_delta_for_axis('x', 3, 9)).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/vitest/rotation-math.test.ts`
Expected: FAIL — `rotate_points` / `drag_delta_for_axis` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to src/lib/structure/rotation-math.ts

/** Rotate each point about `center` by `angle` radians around `axis`.
 *  Pure: inputs are tuples, output is fresh tuples. */
export function rotate_points(
  points: ReadonlyArray<readonly [number, number, number]>,
  center: readonly [number, number, number],
  axis: Vector3,
  angle: number,
): Array<[number, number, number]> {
  const quat = new Quaternion().setFromAxisAngle(axis.clone().normalize(), angle)
  const c = new Vector3(center[0], center[1], center[2])
  return points.map((p) => {
    const v = new Vector3(p[0], p[1], p[2]).sub(c).applyQuaternion(quat).add(c)
    return [v.x, v.y, v.z] as [number, number, number]
  })
}

/** Map the locked axis to the relevant pointer-displacement component.
 *  Pitch (y) uses vertical drag; yaw (z) and roll (x) use horizontal drag. */
export function drag_delta_for_axis(
  axis: LockAxis,
  total_dx: number,
  total_dy: number,
): number {
  return axis === 'y' ? total_dy : total_dx
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/vitest/rotation-math.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/rotation-math.ts tests/vitest/rotation-math.test.ts
git commit -m "feat(rotation): rotate_points + drag_delta_for_axis helpers"
```

---

### Task 4: Add locked-axis + start-anchor state and a dead-zone constant

**Files:**
- Modify: `src/lib/structure/controllers/interaction.svelte.ts` (state block near `:222-231`, constant near `:264`, import block)

- [ ] **Step 1: Add the import**

At the top of `interaction.svelte.ts`, alongside the existing `three` import, add:

```ts
import {
  screen_frame_from_camera,
  pick_locked_axis,
  rotate_points,
  drag_delta_for_axis,
  type LockAxis,
} from '$lib/structure/rotation-math'
```

(If `Quaternion`/`Vector3` are imported from `three` already, leave that import as-is.)

- [ ] **Step 2: Add new state next to the existing rotation state**

After the existing line `let atom_rotation_angle_deg = $state<number>(0)` (`:231`), add:

```ts
let atom_rotation_start_x = $state(0)
let atom_rotation_start_y = $state(0)
let atom_rotation_locked_axis = $state<LockAxis | null>(null)
```

- [ ] **Step 3: Add the dead-zone constant**

After `const KEYBOARD_ROTATION_STEP = 0.05 // ~3 degrees per key press` (`:264`), add:

```ts
const AXIS_LOCK_DEADZONE_PX = 4 // left-drag must exceed this before an axis locks
```

- [ ] **Step 4: Verify it compiles**

Run: `pnpm vitest run tests/vitest/rotation-math.test.ts`
Expected: PASS (no behavior change yet; this confirms the import path resolves).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/controllers/interaction.svelte.ts
git commit -m "feat(rotation): add locked-axis state and dead-zone constant"
```

---

### Task 5: Initialize the start anchor and reset locked axis

**Files:**
- Modify: `src/lib/structure/controllers/interaction.svelte.ts` (`start_atom_rotation` `:478-484`, `finish_rotation` `:588-595`)

- [ ] **Step 1: Set the fixed anchor + clear lock in `start_atom_rotation`**

In `start_atom_rotation`, the lines (`:478-484`) currently read:

```ts
    is_rotating_atoms = true
    atom_rotation_prev_x = event.clientX
    atom_rotation_prev_y = event.clientY
    atom_rotation_cumulative_quat = new Quaternion()
    atom_rotation_camera_quat = camera.quaternion.clone()
    atom_rotation_axis = null
    atom_rotation_angle_deg = 0
```

Replace with:

```ts
    is_rotating_atoms = true
    atom_rotation_prev_x = event.clientX
    atom_rotation_prev_y = event.clientY
    atom_rotation_start_x = event.clientX
    atom_rotation_start_y = event.clientY
    atom_rotation_locked_axis = atom_rotation_roll_mode ? 'x' : null
    atom_rotation_cumulative_quat = new Quaternion()
    atom_rotation_camera_quat = camera.quaternion.clone()
    atom_rotation_axis = null
    atom_rotation_angle_deg = 0
```

Note: `atom_rotation_roll_mode` is set by the mousedown handlers (right button) *before* `start_atom_rotation` runs in the existing code; if a worker finds it is set *after*, move the `atom_rotation_locked_axis` assignment to just after the roll-mode assignment in the mousedown handler instead. Roll always locks to `x` immediately (no dead zone).

- [ ] **Step 2: Reset the new state in `finish_rotation`**

In `finish_rotation`, after `atom_rotation_angle_deg = 0` (`:595`), add:

```ts
    atom_rotation_locked_axis = null
    atom_rotation_start_x = 0
    atom_rotation_start_y = 0
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm vitest run tests/vitest/rotation-math.test.ts`
Expected: PASS (still no behavior change in tests; confirms no type errors).

- [ ] **Step 4: Commit**

```bash
git add src/lib/structure/controllers/interaction.svelte.ts
git commit -m "feat(rotation): init start anchor + reset locked axis on finish"
```

---

### Task 6: Rewrite the drag mousemove rotation block

**Files:**
- Modify: `src/lib/structure/controllers/interaction.svelte.ts` (`:1352-1431`)

- [ ] **Step 1: Replace the rotation block**

The block from `if (is_rotating_atoms && atom_rotation_center && deps.get_structure()) {` (`:1352`) through its closing brace (`:1431`) currently accumulates an incremental quaternion. Replace the entire block with:

```ts
    // 原子旋转中 — 固定屏幕坐标系，单轴锁定
    if (is_rotating_atoms && atom_rotation_center && deps.get_structure()) {
      if (!event.shiftKey || event.altKey) {
        finish_rotation()
        return
      }

      atom_rotation_prev_x = event.clientX
      atom_rotation_prev_y = event.clientY

      // Total displacement from the fixed mousedown anchor (not per-frame).
      const total_dx = event.clientX - atom_rotation_start_x
      const total_dy = event.clientY - atom_rotation_start_y

      // Lock the axis once for left-drag (roll already locked to 'x').
      if (atom_rotation_locked_axis === null) {
        atom_rotation_locked_axis = pick_locked_axis(total_dx, total_dy, AXIS_LOCK_DEADZONE_PX)
        if (atom_rotation_locked_axis === null) return // still inside dead zone
      }
      const axis = atom_rotation_locked_axis

      const sensitivity = 0.01
      const cam_quat = atom_rotation_camera_quat
        || (deps.get_camera() ? deps.get_camera().quaternion : new Quaternion())
      const frame = screen_frame_from_camera(cam_quat)
      const axis_vec = frame[axis]

      const angle = drag_delta_for_axis(axis, total_dx, total_dy) * sensitivity

      // Visual feedback.
      atom_rotation_axis = [axis_vec.x, axis_vec.y, axis_vec.z]
      atom_rotation_angle_deg = Math.abs(angle) * 180 / Math.PI

      // Recompute every frame from the stored initial positions — idempotent,
      // no incremental quaternion product.
      const indices = [...atom_rotation_initial_positions.keys()]
      const initial = indices.map((idx) => atom_rotation_initial_positions.get(idx)!)
      const rotated = rotate_points(initial, atom_rotation_center, axis_vec, angle)
      for (let i = 0; i < indices.length; i++) {
        pending_rotation_positions.set(indices[i], rotated[i])
      }

      if (!pending_rotation_update && pending_rotation_positions.size > 0) {
        pending_rotation_update = true
        pending_rotation_raf_id = requestAnimationFrame(apply_pending_rotation)
      }
    }
```

- [ ] **Step 2: Confirm `atom_rotation_cumulative_quat` is now unused in the drag path**

Run: `rg -n "atom_rotation_cumulative_quat" src/lib/structure/controllers/interaction.svelte.ts`
Expected: only the declaration (`:226`) and the resets in `start_atom_rotation`/`finish_rotation` remain — no read in the mousemove block. Leave the declaration and resets (harmless); do not remove in this task.

- [ ] **Step 3: Type-check + run helper tests**

Run: `pnpm vitest run tests/vitest/rotation-math.test.ts`
Expected: PASS. (Controller logic is verified manually in Task 9.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/structure/controllers/interaction.svelte.ts
git commit -m "feat(rotation): single-axis screen-locked drag, drop quat accumulation"
```

---

### Task 7: Refactor keyboard rotation onto the shared screen frame

**Files:**
- Modify: `src/lib/structure/controllers/interaction.svelte.ts` (`rotate_selected_atoms_keyboard` `:701-712`)

- [ ] **Step 1: Replace the camera-axis block with the shared frame**

Inside `rotate_selected_atoms_keyboard`, the lines (`:701-712`):

```ts
    const camera_right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize()
    const camera_up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize()
    const camera_forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize()

    let rotation_axis: Vector3
    let angle = KEYBOARD_ROTATION_STEP
    if (direction === 'ArrowLeft') { rotation_axis = camera_up; angle = KEYBOARD_ROTATION_STEP }
    else if (direction === 'ArrowRight') { rotation_axis = camera_up; angle = -KEYBOARD_ROTATION_STEP }
    else if (direction === 'ArrowUp') { rotation_axis = camera_right; angle = KEYBOARD_ROTATION_STEP }
    else if (direction === 'ArrowDown') { rotation_axis = camera_right; angle = -KEYBOARD_ROTATION_STEP }
    else if (direction === 'Forward') { rotation_axis = camera_forward; angle = KEYBOARD_ROTATION_STEP }
    else { rotation_axis = camera_forward; angle = -KEYBOARD_ROTATION_STEP }
```

Replace with:

```ts
    // Same fixed screen frame as the drag path: x = screen normal toward
    // viewer, y = screen right, z = screen up.
    const frame = screen_frame_from_camera(camera.quaternion)

    let rotation_axis: Vector3
    let angle = KEYBOARD_ROTATION_STEP
    // Left/Right = yaw about screen-up (z); Up/Down = pitch about screen-right
    // (y); Forward/Backward = roll about screen-normal (x).
    if (direction === 'ArrowLeft') { rotation_axis = frame.z; angle = KEYBOARD_ROTATION_STEP }
    else if (direction === 'ArrowRight') { rotation_axis = frame.z; angle = -KEYBOARD_ROTATION_STEP }
    else if (direction === 'ArrowUp') { rotation_axis = frame.y; angle = KEYBOARD_ROTATION_STEP }
    else if (direction === 'ArrowDown') { rotation_axis = frame.y; angle = -KEYBOARD_ROTATION_STEP }
    else if (direction === 'Forward') { rotation_axis = frame.x; angle = KEYBOARD_ROTATION_STEP }
    else { rotation_axis = frame.x; angle = -KEYBOARD_ROTATION_STEP }
```

Note: `frame.z` equals the old `camera_up`, `frame.y` equals `camera_right`, and `frame.x` equals `-camera_forward`. The Forward/Backward roll direction is therefore sign-flipped versus the old code; this matches the drag roll convention. Confirm direction feels natural in Task 9 and flip the two `Forward`/`Backward` signs if not.

- [ ] **Step 2: Type-check + run helper tests**

Run: `pnpm vitest run tests/vitest/rotation-math.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/structure/controllers/interaction.svelte.ts
git commit -m "refactor(rotation): keyboard rotation uses shared screen frame"
```

---

### Task 8: Update the rotate-atoms hint strings

**Files:**
- Modify: `src/lib/i18n/en/structure.ts:614`, `src/lib/i18n/zh/structure.ts:614`

- [ ] **Step 1: Update the English hint**

In `src/lib/i18n/en/structure.ts`, replace:

```ts
  tip_rotate_atoms_desc: `Shift+drag selected atoms to rotate (left=pitch/yaw, right=roll)`,
```

with:

```ts
  tip_rotate_atoms_desc: `Shift+drag to rotate selected atoms — drag horizontally for yaw, vertically for pitch (one axis locks per drag); right-drag for roll`,
```

- [ ] **Step 2: Update the Chinese hint**

In `src/lib/i18n/zh/structure.ts`, replace:

```ts
`Shift+拖拽选中的原子进行旋转 (左键=俯仰/偏航，右键=滚动)`,
```

with:

```ts
`Shift+拖拽旋转选中原子 — 水平拖拽偏航、垂直拖拽俯仰（每次拖拽锁定一个轴），右键拖拽滚动`,
```

- [ ] **Step 3: Verify**

Run: `rg -n "tip_rotate_atoms_desc|拖拽旋转选中原子" src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts`
Expected: both updated strings present.

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/en/structure.ts src/lib/i18n/zh/structure.ts
git commit -m "docs(i18n): update rotate-atoms hint for single-axis rotation"
```

---

### Task 9: Manual verification in the running app

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm test`
Expected: all tests pass, including `tests/vitest/rotation-math.test.ts` (10 tests).

- [ ] **Step 2: Launch the app and verify drag behavior**

Start CatGO (`pnpm desktop:serve` or the user's usual command). Load any structure, select ≥1 atom, then:
- Shift + left-drag horizontally → atoms yaw about the screen-vertical axis; small vertical wobble does NOT add pitch (axis is locked).
- Shift + left-drag vertically → atoms pitch about the screen-horizontal axis.
- A tiny shift+click-drag under ~4 px → no rotation (dead zone).
- Shift + right-drag → atoms roll about the screen normal.
- Release and re-drag → a fresh axis can be chosen.

Expected: rotation is about the selection centroid, one axis per drag, no tumbling.

- [ ] **Step 3: Verify keyboard behavior**

Select atoms, then Shift+Arrow keys and W/S:
- Shift+Left/Right → yaw; Shift+Up/Down → pitch; W/S → roll.
- Confirm roll direction (W vs S) feels natural; if reversed, flip the `Forward`/`Backward` signs in `rotate_selected_atoms_keyboard` (Task 7) and re-commit.

- [ ] **Step 4: Verify commit correctness on a periodic structure**

Load a structure with a lattice, rotate a selection, release. Open the atom panel / export and confirm fractional `abc` updated consistently with the new Cartesian `xyz` (handled by `move_atom`).

- [ ] **Step 5: Commit any sign fix from Step 3 (if needed)**

```bash
git add src/lib/structure/controllers/interaction.svelte.ts
git commit -m "fix(rotation): correct roll sign for keyboard W/S"
```

---

## Self-Review Notes

- **Spec coverage:** centroid origin (Tasks 5/6), screen=YZ frame (Task 1), left-drag direction lock + dead zone (Tasks 2/5/6), right-drag roll about X (Tasks 5/6), scalar-angle single quaternion replacing accumulation (Task 6), keyboard same frame (Task 7), Cartesian math + unchanged commit path (Task 6 reuses `pending_rotation_positions` → `apply_pending_rotation` → `finish_rotation`), hint text (Task 8). All covered.
- **X-sign open item** from the spec is resolved to `-forward` (toward viewer) and verified empirically in Task 9.
- **Type consistency:** `LockAxis = 'x'|'y'|'z'`; `pick_locked_axis` returns `'y'|'z'|null` (roll never goes through it); `screen_frame_from_camera` returns `ScreenFrame{x,y,z}`; indexed as `frame[axis]`. Consistent across tasks.

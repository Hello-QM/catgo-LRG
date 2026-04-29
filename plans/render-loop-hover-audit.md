# Render-Loop Hover Audit (Phase R8)

Per-pointermove cost-path snapshot at `atom-soa-refactor` HEAD. R1–R4 killed
all idle pumping. User reports 68 % CPU during interaction; 12 s timeline:
2171 pointermove, 249 `handlePointerMove` (~21/s), 509 onAnimationFrame
(~42/s). 878 atoms.

---

## 1. Pointermove call chain (legacy + new atom paths are identical)

Listener registered once: `canvas.addEventListener('pointermove', handle_hover)`
at `gpu-picker-integration.svelte.ts:189`, from `StructureScene.svelte:1263`
(`$effect(() => setup_hover_detection())`).

`handle_hover` (`gpu-picker-integration.svelte.ts:114`):
1. Bail: `external_dragging | is_rotating_atoms | is_box_selecting` (L115).
2. `!show_bulk_atoms` bail (L117).
3. Read `atom_data` $derived (L125).
4. Branch on `is_large_structure` (>2000; 878 → FALSE → ray-sphere).
5. `find_hit_atom_from_event` (L201–280): `getBoundingClientRect()`; NDC +
   ray (3 Vector3); inverse rotation (1 Euler + 2 Quat + 4 Vector3); loop
   over `atom_data` (878) — `cutting_visibility_map.get`,
   `realtime_position_overrides?.get`, ALU on reused tmp.
6. On change: `set_hovered_idx` + `set_active_tooltip` → local $state (L152, 154).

Cascade: `$effect.pre` at L1264 re-derives `hovered_site`; `<T.Mesh>` hover
highlight L3309–3324 → `<T.>` props auto-invalidate (one paint/change);
tooltip L3411. `hovered_idx`/`hovered_site` are `$bindable` (L369–370) but
`Structure.svelte` does not `bind:` → no upward cascade.

---

## 2. Per-pointermove work units

| Work unit | Frequency | Cost | O(N=878)? |
| --- | --- | --- | --- |
| 3 bool gets + atom_data getter | every move | O(1) | no |
| `getBoundingClientRect()` | every move | forced layout | no |
| Ray construction (3 `new Vector3`) | every move | small alloc | no |
| Rotation transform (7 allocs) | every move | ~150 allocs/s | no |
| Ray-sphere loop body | every move | ALU | **YES** |
| `cutting_visibility_map.get` per atom | every move | O(1)×N | YES |
| `realtime_position_overrides?.get` per atom | every move | O(1)×N | YES |
| `set_hovered_idx` write | on change only | $state → 1 paint | no |

**No throttling.** No rAF, no distance threshold, no debounce. The 21/s
handler rate vs 277/s raw rate is browser-level coalescing only; every
delivered event runs the full O(N) loop.

---

## 3. Legacy AtomImpostors vs new AtomManagerInstances hover path

**Identical.** Both `AtomImpostors.svelte:547,556` and
`AtomManagerInstances.svelte:471` set `raycast={null}`. Atom render meshes are
not in the hover loop; hover is canvas-level ray-sphere against `atom_data`
(StructureScene.svelte:1754), which exists regardless of the active renderer.
The atom SoA refactor neither helped nor hurt hover.

---

## 4. Optimization candidates

### 4.1 Throttle hover detection to one rAF (BIGGEST WIN)

**What:** Store latest event in a `pending_event` slot + `rAF_id`; run the
ray-sphere body inside the rAF. Coalesces handler invocations to ≤ 60/s.

**Where:** `gpu-picker-integration.svelte.ts:114–180`.

**Risk:** Hover lags one frame (~16 ms). Click latency unaffected — clicks
use the Threlte interaction mesh at `StructureScene.svelte:246–304`.

**Estimated reduction:** Big drop during fast moves where the browser
delivered bursts; modest drop on slow moves.

### 4.2 Skip detection during `camera_is_moving`

**What:** L115 bails on `external_dragging`, `is_rotating_atoms`,
`is_box_selecting` — but not `camera_is_moving`. During orbit, the loop
runs every move though the tooltip is already hidden by the
`!camera_is_moving` guard at L3411.

**Where:** Add `camera_is_moving` getter to `GpuPickerDeps` (L28–53), bail at L115.

**Risk:** Hover-highlight mesh sticks on last atom during orbit (acceptable).

**Estimated reduction:** ~−20 % of hover cost (orbit dominates fast pointer moves).

### 4.3 Skip identity-rotation allocation

**What:** In `find_hit_atom_from_event` L244–251, check
`if (rotation[0]===0 && rotation[1]===0 && rotation[2]===0)` and skip
Euler/Quat/4-Vector3 allocs; pass camera ray straight to the loop.

**Where:** `gpu-picker-integration.svelte.ts:244–251`.

**Risk:** None — pure rewrite for the identity case (default).

**Estimated reduction:** ~150 fewer allocs/s. GC win.

### 4.4 Pointer-distance dead-zone

**What:** Track `last_x/y`, skip when `|dx|+|dy| < 2 px`.

**Where:** Top of `handle_hover` L114.

**Risk:** Sub-pixel jitter never picks; sticky boundary transition. Negligible.

**Estimated reduction:** −10–30 % on trackpad input.

### 4.5 Cache `getBoundingClientRect`

**What:** Store canvas rect, invalidate via ResizeObserver. Forced layout
read at L148/L216 interleaves with DOM writes (label overlay useTask L2699)
→ layout thrashing.

**Where:** `gpu-picker-integration.svelte.ts:148, 216`.

**Risk:** Stale rect after non-resize shifts; ResizeObserver mitigates.

**Estimated reduction:** One forced layout per move eliminated.

---

## 5. Verdict

**Hover is expensive enough to matter, but NOT the only remaining cost.**
Two co-conspirators outside the trace:

- **509 onAnimationFrame / 12 s ≈ 42 fps sustained paint.** The per-frame
  near/far + scale-bar useTask at `StructureScene.svelte:1296–1333` fires
  whenever the loop runs; `pixels_per_angstrom` write L1330 feeds
  `<ScaleBar>` props → auto-invalidate. L1329 equality guard helps at idle,
  but during continuous orbit the value changes every frame — self-pumping.
- **`handlePointerMove` (249) ≪ pointermove (2171)** = 9× browser coalescing
  — but each invocation still runs the O(878) ray-sphere loop + 7 allocs.

**R8 should proceed**, scoped to (4.1) + (4.2) + (4.3). Estimated hover-cost
reduction: 50–70 %.

**Side-check first:** with `__invalidate_count`, do a "mouse-jiggle WITHOUT
orbit" recording. If invalidate stays bounded, the near/far useTask is fine
— proceed with hover work. If it climbs to 60/s during jiggle, the
bottleneck is L1296, not hover, and R8 must address that first.

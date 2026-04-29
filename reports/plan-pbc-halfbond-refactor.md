# Plan: PBC Half-Bond Refactor (Bond-jimage + Mid-Cylinder + Optional Stub)

**Audience:** another Claude session executing this plan end-to-end.

---

## 0. Why this refactor exists

Today, periodic bonds are implemented by injecting **ghost atoms** into the displayed `sites` array (via `get_pbc_image_sites` in `pbc.ts`), and then drawing **whole** bonds between original sites and ghosts. Bond detection is forced into a Cartesian-only mode by stripping the `pbc` flags off the structure passed to WASM (`bond-computation-controller.svelte.ts:107-111`), because the WASM bonders would otherwise find their own periodic bonds — duplicating what ghosts already give us.

This double representation is fragile. The crystaltoolkit / Materials Project model is cleaner: each bond carries a `jimage` lattice translation, and the renderer paints **two half-cylinders** meeting at the bond midpoint. Outside the bond layer, ghost atoms can still exist for charge labels, polyhedra, and user-visible cell-edge completion — but they are no longer the basis of bond endpoints.

The Rust side is already 95% there: `bonding::Bond` (`extensions/rust/src/bonding.rs:17-30`) already carries `image: [i32; 3]`. It is propagated through serde JSON in every WASM entry point. The remaining work is on the TypeScript side: thread that field through, draw half-cylinders, kill the hack.

---

## 1. Investigation findings (anchors for executor)

### 1.1 Rust bond entry points (already image-aware)

| Function | File:line | Returns |
|---|---|---|
| `detect_bonds_atom_radii` | `extensions/rust/src/bonding.rs:164` | `Vec<Bond>` with `image: [i32;3]` |
| `detect_bonds_electroneg` | `extensions/rust/src/bonding.rs:238` | `Vec<Bond>` |
| `detect_bonds_solid_angle` | `extensions/rust/src/bonding.rs:403` | `Vec<Bond>` |

WASM bindings (all serde-JSON, image already in payload):

| WASM export | File:line |
|---|---|
| `detect_bonds_radii` | `extensions/rust/src/wasm.rs:5266` |
| `detect_bonds_electronegativity` | `extensions/rust/src/wasm.rs:5286` |
| `detect_bonds_solid_angle` | `extensions/rust/src/wasm.rs:5306` |
| `detect_hydrogen_bonds` | `extensions/rust/src/wasm.rs:5367` |

Image direction convention is fixed by `minimum_image_distance_squared` (`extensions/rust/src/pbc.rs:132-185`) and `get_neighbor_list` (`extensions/rust/src/structure.rs:834`):

```
displacement_vec = pos_b - pos_a + image[0]*a + image[1]*b + image[2]*c
```

i.e. **partner B in image `image` lives at `pos_b + lattice·image`** (lattice rows are vectors `a`, `b`, `c`). The renderer must use the **same** sign.

### 1.2 TypeScript bond entry points (drop image today)

- `compute_bonds_async`, `compute_bonds_sync` in `src/lib/structure/bonding/workers/bond-worker-api.ts` — confirm JSON parsing strips `image`.
- `bond-computation-controller.svelte.ts:118-122` and `:151-155` map Rust `{site_idx_1, site_idx_2, strength}` into `bond_connectivity` — **explicitly dropping `image`**. This is the throwaway point.
- The TS-only `BONDING_STRATEGIES` in `src/lib/structure/bonding.ts` (JS fallback / coordination color path) does **not** produce `image` — it walks Cartesian distances over an already-expanded structure. Preserve as `image=[0,0,0]` only.

### 1.3 BondManager storage (`src/lib/structure/bonding/bond-manager.svelte.ts`)

Structure-of-Arrays, typed-array backing, no `$state` proxy on bulk buffers. Per-slot data:

| Buffer | Layout | Purpose |
|---|---|---|
| `#pairs` | `Uint32Array`, 2 × capacity | `[a0, b0, a1, b1, ...]` |
| `#kinds` | `Uint8Array`, capacity | `BOND_KIND` byte (AUTO/MANUAL/HBOND/HALO) |
| `#colors_start` / `#colors_end` | `Float32Array`, 3 × capacity (lazy) | per-bond gradient endpoints |
| `#opacity_buffer` | `Float32Array`, capacity (lazy) | per-bond opacity |

Single reactive surface is `#version: $state(number)`. `dirty_slots` / `dirty_all` drive incremental GPU writes. All allocators (`#ensure_capacity`, `shrink_to_fit`, `remove_bond`, `remove_bonds`, `remove_where`) hand-copy each per-slot column — adding a column means touching every one.

### 1.4 GPU instance buffer layout (`src/lib/structure/bonding/bond-instanced-renderer.ts`)

- One `THREE.InstancedMesh` per bond layer. `instanceMatrix` (16 floats per instance) = compose(midpoint, rotation_to_dir, scale_y_to_length). Custom attrs: `bond_kind` (Uint8), `instance_color_start/end` (vec3), `instance_opacity` (float).
- Capacity set at construction; renderer throws when `manager.count > capacity`, parent (`BondManagerInstances.svelte`) rebuilds at larger size. `max_capacity` default **200_000** (`BondManagerInstances.svelte:52`). After half-bond, **a non-PBC structure costs 2× instances**, periodic structures may grow further.
- `#write_slot` (`bond-instanced-renderer.ts:268`) computes `v_mid` and `v_dir` directly from atom positions — **this is where jimage must enter**.

### 1.5 GPU picker encoding (`src/lib/structure/gpu-picker.ts`)

- Each instance encoded as RGB `id = index + 1`; `index < atom_count` = atoms, otherwise bonds (`gpu-picker.ts:152-158`).
- Bond instance index = BondManager slot today. After half-bond, instance index = `slot * 2 + half`. Decode: `slot = index >>> 1`, `half = index & 1`.
- Picker scene rebuilt from `filtered_bond_pairs` in `update_gpu_picker` (`gpu-picker-integration.svelte.ts:79`). After half-bond, that array doubles, **but a single bond_key must still map back to one logical bond** for selection / hover.

### 1.6 The hack to delete

`src/lib/structure/bond-computation-controller.svelte.ts:96-111`:

```ts
const has_images = (structure as any).num_original_sites !== undefined
let bond_structure = structure
if (has_images && 'lattice' in structure && structure.lattice) {
  bond_structure = { ...structure, lattice: { ...structure.lattice, pbc: [false, false, false] } } as typeof structure
}
```

Reason: with ghost atoms in the array AND PBC enabled in WASM, you get duplicate bonds (one through ghosts, one through MIC). Killing ghosts from the bond-input path lets us turn PBC back on and get clean Rust output with `image` set. **Phase 5 deletes this block.**

### 1.7 Ghost atom dependencies that **must stay** (non-bond paths)

`grep` for `num_original_sites` / `image_to_original_map`:

- `Structure.svelte:3386-3387` — passes them to StructureScene.
- `StructureScene.svelte:488,489,707,708,1301,2473-2475,2576,2578,2703` — display label "site #N" reverse-mapping, charge-label index resolution.
- `controllers/context-menu-actions.ts:124-143` — right-clicking a ghost resolves to underlying original index.
- `controllers/transform-controller.ts:24-50` — atom-drag/rotate maps ghosts back.
- `controllers/viewer-controller.ts:57-59` — focus-on-atom maps ghosts back.
- `BondManagerInstances.svelte:39,55,284` — `image_atom_opacity` multiplier when **either endpoint** is `>= num_original_sites`. **After refactor**, no bond endpoint is ever a ghost (endpoints are always original site indices), so this multiplier becomes dead. Repurpose: apply when `jimage != [0,0,0]` (rename to `periodic_bond_opacity`).
- `AdsorbatePlacementPane.svelte:359` — `show_image_atoms` is purely a display toggle; keep.
- `charge-label-rendering.svelte.ts:24-36` — relies on `num_original_sites` + `image_to_original_map`. **Keep unchanged.**

### 1.8 PBC ghost generators (`pbc.ts`)

- `find_image_atoms` (line 24): edge-detect-based, used by `atom-properties.ts` for property color expansion.
- `find_translational_images` (line 135): VESTA-mode 1, used inside `get_pbc_image_sites`.
- `get_pbc_image_sites` (line 232): the bond-completion ghost generator that puts `num_original_sites`/`image_to_original_map` on the structure. Today this is consumed by both display **and** the bond pipeline. After refactor, **bonds don't need this at all** — bonds use original cell + jimage. The ghost path becomes purely a display toggle.

---

## 2. Target data model and contracts

### 2.1 New `Bond` (TypeScript)

```ts
// src/lib/structure/index.ts — new field on BondPair
type BondPair = {
  pos_1: Vec3                       // origin atom (same as today)
  pos_2: Vec3                       // BASE position in original cell (NOT shifted by jimage)
  site_idx_1: number                // original site index
  site_idx_2: number                // original site index
  jimage: [number, number, number]  // NEW — [0,0,0] for intra-cell bonds
  bond_length: number
  strength: number
  transform_matrix: Float32Array
  bond_type?: 'covalent' | 'hydrogen'
}
```

**Convention (matches Rust):** partner B sits at `pos_2 + lattice·jimage`. Min-image displacement = `pos_2 + lattice·jimage − pos_1`.

**Why store base `pos_2`?** Positions are reactive to drag; storing pre-shifted forces recompute on every lattice/B move. Base + jimage makes the dependency explicit.

### 2.2 New `BondManager` columns

```
#jimages: Int8Array, length 3 × capacity
```

`Int8Array` rationale: jimage entries nearly always in `[-2, 2]`. 3 × cap × 1 byte ≈ 3 MB at 1M bonds (vs 12 MB Int32). Promote to `Int32Array` only if a fixture proves we need it (`compute_search_range` in pbc.rs can emit up to ±5).

Buffer must be allocated/copied in:
- `#ensure_capacity` (line 118)
- `shrink_to_fit` (line 156)
- `remove_bond` (line 276) — swap-and-pop
- `remove_bonds` (line 303)
- `remove_where` (line 350)

…just like `#kinds`.

New methods:
- `get_jimage(slot) → [number, number, number]`
- `set_jimage(slot, dx, dy, dz)`
- `add_bond(a, b, kind, jimage = [0,0,0])`
- `add_bonds(pairs_src, kinds_src, jimages_src?)`
- `find_slot_by_pair(a, b, jimage?)` — when omitted, match any (back-compat for pencil); when given, exact match including jimage.

### 2.3 `BondConnectivity` ingestion

`bond-computation-controller.svelte.ts` mapping:

```ts
type BondConnectivity = {
  site_idx_1: number
  site_idx_2: number
  strength: number
  jimage: [number, number, number]
}
```

`build_bond_pairs` (lines 173-215) and `build_trajectory_bond_pairs` (lines 221-243) propagate jimage.

### 2.4 Renderer math (half-bond)

For bond `(a, b)` with `jimage = (dx, dy, dz)`:

```
b_eff = pos_b + dx*a_vec + dy*b_vec + dz*c_vec
delta = b_eff − pos_a
mid   = pos_a + 0.5 * delta

half_a:  endpoint = pos_a, head = mid, length = ||delta|| / 2, color = atom_a's
half_b:  endpoint = b_eff, head = mid, length = ||delta|| / 2, color = atom_b's
```

Non-periodic bond (jimage zero) collapses to two halves meeting at geometric midpoint — visual equivalent to today.

Incomplete-edge mode (Phase 6):
```
if jimage != [0,0,0] AND incomplete_edge_mode:
  half_a only: length = ||delta||/2 * incomplete_edge_length_scale (default 0.5)
  half_b skipped
```

### 2.5 Cylinder transform per half

Today's `#write_slot` emits one matrix at midpoint with scale-y = full length. Half-bond emits **two**:

```
half_a: midpoint = (pos_a + mid) / 2, scale_y = length/2, rotation: pos_a → mid
half_b: midpoint = (b_eff + mid) / 2, scale_y = length/2, rotation: b_eff → mid
```

If jimage zero, both halves collapse correctly to halves of the same line.

---

## 3. Phase plan

Each phase independently shippable, ends with green CI and working app.

### Phase 1 — TS ingests the `image` field Rust already emits
Goal: TypeScript reads `image`, threads into `bond_connectivity`. Renderer ignores. Behaviour identical.

**Files:**
- `src/lib/structure/bond-computation-controller.svelte.ts:118-122,151-155` — add `jimage: b.image ?? [0,0,0]` to mapping (sync + async paths).
- `src/lib/structure/bonding/workers/bond-worker-api.ts` — confirm worker exposes `image`. Widen type if needed.
- `src/lib/structure/bonding.ts` (TS fallback) — add `image: [0,0,0]` to every emitted `BondPair`. TS fallback never finds cross-cell bonds; always-zero correct.
- `src/lib/structure/index.ts` — add `jimage?: [number, number, number]` to `BondPair`. Optional this phase.

**Verify:**
- `pnpm test src/lib/structure/bonding/` passes.
- Add unit test: feed Rust JSON with non-zero `image` through controller mapping, assert `jimage` survives.
- Visual: nothing changes.
- Type: `pnpm check` no new errors.

**Revert:** remove the field; pure additive.

---

### Phase 2 — `BondPair.jimage` becomes required; default `[0,0,0]` everywhere

**Files:**
- `src/lib/structure/index.ts` — make `jimage` required.
- Every `BondPair` constructor site (search `pos_1:.*pos_2:` in `bonding.ts`, `bond-computation-controller.svelte.ts`, `mof-analysis.ts`, `bonding/*.ts`) — set `jimage: [0,0,0]` if missing.
- `bonding.ts` H-bond detector (line 422-475) — `[0,0,0]`.

**Verify:** `pnpm check` clean. Bond tests pass.

---

### Phase 3 — `BondManager` stores `jimage`

**Files:**
- `bond-manager.svelte.ts`:
  - Add `#jimages: Int8Array`.
  - Update `#ensure_capacity`, `shrink_to_fit`, `remove_bond`, `remove_bonds`, `remove_where`, `add_bond`, `add_bonds` — mirror `#kinds` patterns.
  - Add `get_jimage`, `set_jimage`, `jimages_buffer`.
  - Bump `BOND_MANAGER_SCHEMA_VERSION = 2`.
- `bond-undo-stack.ts`:
  - `RestoreOp`/`DeletePairsOp` carry `jimages: Int8Array`. `add_bond` records jimage; `remove_bond/remove_bonds` capture/restore jimage. `pair_kind_key` becomes `pair_kind_jimage_key` (avoid collapsing two distinct bonds — same atoms, different image — into one undo entry).
- Callers of `add_bond` / `add_bonds`:
  - `pencil-mode.svelte.ts` — pencil bonds intra-cell ⇒ `[0,0,0]`.
  - `bond-computation-controller.svelte.ts` — pass connectivity's jimage.
  - `mof-analysis.ts` — already has `image`, pass through.
- `bond-instanced-renderer.ts:268` (`#write_slot`) — receive `jimages` buffer (still ignores it; Phase 4 uses).

**Tests:**
- Extend `bond-manager.svelte.test.ts`: jimage round-trips through add/remove/swap-pop; capacity grow preserves jimage; `find_slot_by_pair(a, b, jimage)` distinguishes (3,7,[0,0,0]) from (3,7,[1,0,0]).
- Extend `bond-undo-stack.test.ts`: undo/redo on periodic bond restores correct jimage; two periodic bonds same atoms / different jimages not collapsed.

**Verify:** all BondManager / undo tests green. Visual unchanged.

---

### Phase 4 — Renderer paints two halves per bond (the big one)

**4a. Capacity doubling**
- `bond-instanced-renderer.ts`: split per-bond instance count from per-slot count.
  - `instance_count = manager.count * 2`
  - `mesh.count = instance_count`
  - capacity check: `instance_count > capacity` ⇒ throw same "rebuild at larger size".
- `BondManagerInstances.svelte:52` — bump `max_capacity` default from `200_000` to `1_000_000`, **or** make it dynamic: `Math.max(2 * estimated_bonds, INITIAL_CAPACITY)`.
- All `addUpdateRange(slot * 16, len * 16)` → `addUpdateRange(slot * 32, len * 32)`. Same doubling for color and opacity buffers.

**4b. Transform**
```ts
function write_slot(slot, ...) {
  const a = pairs[slot*2], b = pairs[slot*2+1];
  const dx = jimages[slot*3], dy = jimages[slot*3+1], dz = jimages[slot*3+2];
  // pos_a from positions; b_eff = pos_b + dx*a_vec + dy*b_vec + dz*c_vec
  const mid = (pos_a + b_eff) * 0.5;
  // half A at slot*2: midpoint = (pos_a+mid)/2, scale_y = ||delta||/2, rot = pos_a→mid
  // half B at slot*2+1: midpoint = (b_eff+mid)/2, scale_y = ||delta||/2, rot = b_eff→mid
}
```

**4c. Plumbing the lattice into the renderer**
- Renderer needs `lattice 3×3` (rows-as-vectors). Add constructor arg `get_lattice: () => Float64Array | null`. When `null` (molecule), assert `jimage === [0,0,0]` in dev.
- `BondManagerInstances.svelte` props: add `lattice_matrix?: Float64Array` (3×3 row-major, 9 floats). Caller (`StructureScene`) passes `displayed_structure.lattice?.matrix` flat.

**4d. Color semantics**
- Today's gradient endpoints become per-half:
  - Half A: `(c_a, c_a)`
  - Half B: `(c_b, c_b)`
- Solid per half — matches MP/VESTA. Hard color step at midpoint is intentional (cleaner than blended; see 4.6).
- Shader unchanged: `mix(vColorStart, vColorEnd, vYPosition + 0.5)` renders solid because endpoints equal.

**4e. Opacity**
- Both halves share opacity. Mirror the value to both instances.
- `BondManagerInstances.svelte:284-300` image-atom-opacity branch obsolete (no endpoint is ghost). Repurpose: apply when `jimage != [0,0,0]`. Rename prop `image_atom_opacity` → `periodic_bond_opacity`.

**4f. Picker decode**
- `gpu-picker.ts:158`: when bond, `slot = (id - atom_count - 1) >>> 1`. Optionally expose `half = (id - atom_count - 1) & 1`.
- `gpu-picker-integration.svelte.ts:79-97` `update_gpu_picker`: push 2 transforms per BondPair, mirror renderer math.
- Hover highlight: hover on either half ⇒ whole bond hovered (existing slot-based path).

**4g. Force update on lattice change**
- Renderer's `force_full_resync` already triggered on `mesh.count > capacity` and bond-radius rebuild. Add: lattice-matrix change ⇒ force resync. Threlte invalidate after buffer rewrite.

**Verify:**
- Unit tests on `#write_slot`: synthetic structure with `jimage=[1,0,0]`, assert two cylinder midpoints + lengths match math.
- Visual: cubic SrTiO3, IrO2 slab, monoclinic VO2, triclinic — no ghosts involved. PBC bonds appear as paired stubs at cell edges.
- Performance: 4×4×4 SiC supercell (~2k atoms), check draw calls + memory. ~2× shader invocations expected, no measurable wall time on dGPU.

**Revert:** localized to `#write_slot`, `mesh.count` math, capacity. Halve all `* 2` factors and restore single-write_slot. Picker decode is a single line. **Phase 3 schema stays — leaving jimage column is harmless.**

---

### Phase 5 — Kill ghost-driven bond pipeline

**Files:**
- `src/lib/structure/bond-computation-controller.svelte.ts:96-111` — **delete** `has_images` block. Pass structure straight to WASM with PBC enabled. WASM produces `Bond[]` with `image` already.
- Trace caller: `StructureScene.svelte:2453` passes `displayed_structure` (which is `supercell_structure` after PBC-image expansion). For Phase 5: bonds computed on **pre-ghost** layer. Add `bond_input_structure = supercell_structure ?? cell_transformed_structure` and feed controller from that.
- Update `Structure.svelte` reactive chain to expose `bond_input_structure` separately from `displayed_structure`.
- **Do not** modify `pbc.ts:get_pbc_image_sites` — still produces ghosts for display, charge labels, polyhedra.
- `atom-properties.ts:143,160` — image_sites here is for **coordination color** (CN counting needs cross-boundary neighbors); independent path; leave alone.
- `BondManagerInstances.svelte:284` repurposed per Phase 4d-e.

**Visual contract:**
- "Show image atoms" OFF: only original sites; periodic bonds appear as paired stubs across cell edges.
- "Show image atoms" ON: original + ghosts (charge labels, polyhedra still work). PBC bonds **still go between original sites**, not ghosts.

**Verify:**
- Per cell type (cubic, tetragonal, ortho, mono, tri, slab pbc=110, molecule), bond count from Rust matches expected:
  - cubic SrTiO3: 6 Ti-O per Ti octahedral; each shared between 2 octahedra → 3 unique bonds with non-zero jimage per Ti.
  - water: 2 O-H, jimage=[0,0,0].
- "Spider web" failure mode (ghosts duplicating bonds) impossible.
- Charge label test: SrTiO3 supercell, ghosts visible, labels still resolve correctly via `image_to_original_map`.
- Polyhedra fill on IrO2 slab: octahedra still draw correctly.

**Risk specific to Phase 5:** polyhedra builder might depend on bonds-to-ghosts. After this phase, must consume bonds-with-jimage and synthesize partner position itself. **Investigate before merging.** (search `polyhedra` under `src/lib/structure/`).

**Revert:** restore `has_images` block. Revert `bond_input_structure` plumbing. Phases 1-4 still work; PBC bonds detected via the old "strip lattice" workaround.

---

### Phase 6 — Incomplete-edge stub mode (optional UX)

Goal: when user hides image atoms, optionally show only the A half of periodic bonds.

**Files:**
- `src/lib/settings.ts` (or wherever bond-render settings live): add `incomplete_periodic_edge_mode: boolean` (default false), `incomplete_edge_length_scale: number` (default 0.5).
- `BondManagerInstances.svelte` props: pass through.
- `bond-instanced-renderer.ts:#write_slot`: when mode on AND `jimage != [0,0,0]`:
  - Emit half A only with length × scale. Hide half B via zero-scale matrix at slot*2+1 (or shader discard via `instance_visibility` attr).
- UI: checkbox "Show only stub for cross-cell bonds" in bond pane / Structure controls.
- Picker: if zero-scale, won't pick. If shader-discard, picker still picks — render picker scene with same incomplete-mode flag.

**Verify:** toggle on SrTiO3 supercell — visual difference matches VESTA Mode 1 vs Mode 2. Selection on stub still selects underlying bond_key.

---

## 4. Risk & gotchas

### 4.1 Math: jimage sign convention
**Rule:** `b_eff = pos_b + dx*a_vec + dy*b_vec + dz*c_vec` where `a_vec, b_vec, c_vec` are **rows** of `lattice.matrix`. From `pbc.rs:132`: `image_offset = sum(shift_i * lattice_vecs[i])` and `vec = (pos_b - pos_a) + offset = b_eff - pos_a`. So **add the lattice translation to B, not subtract from A**.

**Failure mode if reversed:** every periodic bond points wrong way. On cubic, both halves end up on same side of cell. Caught instantly by SrTiO3 visual regression.

**Verify:** unit test — cubic 5Å lattice, atom at `(0.5, 0.5, 0.5)`, partner at same with jimage `[1,0,0]`, displacement = `(5, 0, 0)`, midpoint at `(3, 2.5, 2.5)`.

### 4.2 Math: row-vs-column lattice matrix
pymatgen-style: `lattice.matrix[i] = a_i` (rows). Three.js `Matrix3.elements` is column-major. When renderer accepts `Float64Array(9)`, **document layout** in JSDoc and assert in dev.

**Failure mode:** silent transposition; all jimage offsets wrong direction.

### 4.3 Slab PBC `[true, true, false]`
Vacuum direction must never produce non-zero jimage. Rust `get_neighbor_list` enforces (`neighbors.rs:1037`). On TS: after Phase 1, verify `jimage[2] === 0` for all bonds when `pbc[2] === false`. Add dev assertion in `bond-computation-controller.svelte.ts` mapping.

### 4.4 Capacity ceiling
Default `max_capacity = 200_000` halves to 100k logical bonds. 5×5×5 IrO2 supercell ~2,250 bonds — comfortable. 100k-atom MOF at 2 bonds/atom = 200k bonds = 400k instances — **breaks**. Bump to `1_000_000` (16 MB instanceMatrix per layer; OK on dGPU). Or structure-driven: parent passes `Math.max(2 * estimated_bonds, INITIAL_CAPACITY)`.

### 4.5 GPU instance count overflow
WebGL InstancedMesh max ~16M+. Nowhere near. Each cylinder small → fragment-shader cost grows linearly. Profile 1M-bond pathological MOF — expect 5-10 ms/frame dGPU, 30+ ms integrated. Acceptable.

### 4.6 Color discontinuity at midpoint
Per-atom solid-half coloring → midpoint has hard color step on heteroatomic bonds. **Matches** crystaltoolkit / VESTA / MP. For homoatomic bonds, no step. Don't try to "fix" — would break per-half identity, complicate picking.

**Failure mode if hand-blend:** bond appears to come from wrong direction when one endpoint hidden (incomplete mode).

### 4.7 Opacity per half
Both halves of one logical bond MUST share opacity, kind byte, selection state. Selection set keys on slot, not instance. Picker decode (`>>> 1`) handles for hover/click.

### 4.8 Pencil mode and manual bonds
`pencil-mode.svelte.ts` creates manual bonds via `add_bond(a, b, MANUAL)`. After refactor: pass `jimage = [0,0,0]` (manual bonds intra-cell by definition). Manual cross-cell not a current feature.

`deleted_bond_keys` (line 124) currently uses `get_bond_key(a, b)` (atom-pair string). After refactor, key should optionally include jimage — don't suppress (3,7,[0,0,0]) when user only meant to delete (3,7,[1,0,0]). Migrate `get_bond_key` to optional jimage param; old keys (jimage absent) match any jimage for backward compat.

### 4.9 Undo stack schema
`bond-undo-stack.ts` stores `(pair, kind)` typed-array tuples in `RestoreOp`/`DeletePairsOp`. Adding jimage breaks deserialization of any persisted undo. **Practical impact**: undo lives only in-memory (no localStorage). Failure mode: "after upgrade, redoing a mid-session action". One-time clear of `#undo_stack`/`#redo_stack` on app startup is sufficient. Bump `BOND_MANAGER_SCHEMA_VERSION` and `clear()` undo on mismatch.

### 4.10 Trajectory frames
`build_trajectory_bond_pairs` (controller line 221) uses pre-computed `bond_connectivity` and current frame's flat positions. Bonds computed once on frame 0 (or reference) and reused. **Critical:** jimage is per-bond, computed at detection time. If atoms wander across boundaries between frames, stored jimage becomes stale. Acceptable for short MD; for long trajectories, existing recompute-on-strategy-change path handles it. **Document** in controller: "jimage computed against reference frame; long trajectories with boundary-crossing atoms should trigger re-detection."

### 4.11 Workflow-saved structures
Old saved `.json` may carry `image_sites`. Loading: `get_pbc_image_sites` is deterministic recompute → loading old states still produces valid ghost layer. Bonds recomputed from **original** sites + lattice → no migration. **Verify** by loading 3-5 historical workflow JSONs from `Structures/`.

### 4.12 Coordination coloring
`atom-properties.ts:get_coordination_colors` uses `expand_structure_for_pbc` + JS `BONDING_STRATEGIES` over expanded structure. Bonds it produces never carry meaningful `image` — flat Cartesian by construction. **Leave alone.** Coloring computation, not render path.

### 4.13 Selection state and bond-keys
`controllers/...` reference bonds via `BondKey` (atom-pair canonical). After half-bond, key must include jimage to disambiguate (3,7,[0,0,0]) and (3,7,[1,0,0]) — otherwise toggle each other on click. Update `get_bond_key` (`bonding.ts`):

```
get_bond_key(a, b, jimage = [0,0,0]) =>
  `${min(a,b)}-${max(a,b)}-${jimage_canonical(a, b, jimage)}`
```

`jimage_canonical` flips sign if `b < a` (canonicalizing endpoint order requires flipping partner-image direction — one bond, two equivalent representations).

### 4.14 Hidden-bug magnet: index-canonicalization
When `b < a`, canonicalize to `(b, a)`. With jimage, `(a, b, [+1,0,0])` ≡ `(b, a, [-1,0,0])`. Wrong canonicalization will:
- duplicate bonds (same physical bond stored twice)
- silently mismatch in `find_slot_by_pair` → dead bonds in GPU buffer

**Bullet-proof:** in `add_bonds` from connectivity, dedupe by canonical-key. Add fixture test: `(3, 7, [1,0,0])` deduplicates against `(7, 3, [-1,0,0])`.

### 4.15 GPU picker render of half-bonds
Picker renders own scene (`gpu-picker.ts:74`) with own InstancedMesh per type. Today bond mesh = one cylinder per `filtered_bond_pairs`. After refactor: 2 instances per BondPair. Atom_count basis (line 158) still works; emit 2 cylinders per bond and decode `>>> 1`.

**Failure mode if missed:** picker decodes wrong slot; hover highlights wrong bond.

### 4.16 `BondManagerInstances` / legacy `Bond.svelte` split
`BondManagerInstances.svelte` is the new SoA path. Legacy `Bond.svelte` (`StructureScene.svelte` ~2051 area) may still wire some bonds. Verify which is active. If both: only new path needs half-bond logic; legacy can be removed (out of scope unless blocking — check on entry).

---

## 5. Acceptance checklist (gate to main)

- [ ] All Rust tests pass (`cargo test` under `extensions/rust`).
- [ ] All TS tests pass (`pnpm test`).
- [ ] `pnpm check` reports no new type errors over baseline (~229 pre-existing).
- [ ] WASM rebuilt (`wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm`) and committed.
- [ ] `bond-computation-controller.svelte.ts:96-111` hack **deleted**.
- [ ] Bond input path no longer reads `num_original_sites` / `image_to_original_map` (grep confirms).
- [ ] Visual regression on:
  - cubic SrTiO3 unit cell (octahedral PBC bonds visible at all 6 faces)
  - tetragonal IrO2 slab `pbc=[true,true,false]` (no z-direction PBC bonds; xy clean)
  - monoclinic VO2 (oblique cell — search range > 1 still works)
  - triclinic from `test_triclinic.py`
  - water molecule (no lattice — fallback path: all jimage=[0,0,0])
  - 4×4×4 SiC supercell (~2k atoms) — performance regression < 10% vs main
- [ ] Charge label test: SrTiO3 supercell, charge labels persist through ghost-on/off toggle.
- [ ] Polyhedra fill on IrO2 slab still draws octahedra correctly.
- [ ] Adsorbate placement on Pt slab: place CO via AdsorbatePlacementPane, bonds appear correctly.
- [ ] MOF analysis on ZIF-8 fixture: SBU detection still works (already pipes `image`).
- [ ] Pencil mode: add manual bond between two atoms; undo restores; cross-cell pencil bond not supported (documented).
- [ ] Trajectory playback on small AIMD: bonds don't flicker frame-to-frame.
- [ ] Incomplete-edge mode toggle works (visual: stubs vs paired stubs).
- [ ] Picker: hover and click work for both halves of periodic bond.
- [ ] Selection: clicking either half of periodic bond highlights whole bond pair.

---

## 6. Non-goals (out of scope)

- Charge labels, Bader analysis, PDOS, DOS pane logic.
- Trajectory engine, frame interpolation, MD-specific paths.
- Workflow node graph definitions, server-side Python in `server/`.
- Polyhedra fill builder (verify it still works; do not refactor).
- Pure-Python pymatgen replacement (Rust ferrox-wasm stays the backend).
- Migration of historical user data outside test fixture set.
- Cross-cell **manual** bond creation (pencil mode stays intra-cell).
- Tube/halo/hbond rendering (orthogonal — half-bond logic applies same way; verify but no new feature work).

---

## Critical files for implementation

- `src/lib/structure/bonding/bond-manager.svelte.ts`
- `src/lib/structure/bonding/bond-instanced-renderer.ts`
- `src/lib/structure/bond-computation-controller.svelte.ts`
- `src/lib/structure/bonding/BondManagerInstances.svelte`
- `src/lib/structure/bonding/bond-undo-stack.ts`

Supporting (read-only context, likely touched):
- `src/lib/structure/index.ts` (BondPair type)
- `src/lib/structure/gpu-picker.ts` and `gpu-picker-integration.svelte.ts`
- `src/lib/structure/controllers/pencil-mode.svelte.ts`
- `extensions/rust/src/bonding.rs` (already image-aware; reference)

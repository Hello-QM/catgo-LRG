# Rendering & Shader Code Review — March 2026

Comprehensive review of the 3D rendering pipeline in `src/lib/structure/`.
~5,800 lines across 7 core files.

## Files Reviewed

| File | Lines | Role |
|------|-------|------|
| `AtomImpostors.svelte` | 555 | GPU impostor atom rendering (billboard quads + ray-sphere shader) |
| `StructureScene.svelte` | 3530 | Three.js scene orchestrator, all rendering effects |
| `Bond.svelte` | 258 | Instanced bond cylinder rendering |
| `DashedBond.svelte` | 238 | Dashed bond rendering (hydrogen bonds) |
| `bonding.ts` | 556 | JS bond computation algorithms (fallback path) |
| `atom-properties.ts` | 385 | Property color computation, coordination numbers |
| `pbc.ts` | 278 | Periodic boundary condition image atom generation |

---

## HIGH Severity Issues

### 1. AtomImpostors: Position override bug in full buffer rebuild
**File**: `AtomImpostors.svelte` ~L418 (position fast-path)
**Problem**: The "position fast-path" updates only positions during drag via `realtime_position_overrides`. But when the full buffer rebuild path runs (e.g., atom count changes during drag), it does NOT apply the position overrides — atoms snap to original positions mid-drag, then jump back when drag ends.
**Impact**: Visual glitch during atom manipulation on structures that cross buffer capacity thresholds.
**Fix**: In the full rebuild path, check `realtime_position_overrides` and apply them before writing position attributes.

### 2. StructureScene: H-bond position update infinite loop risk
**File**: `StructureScene.svelte` ~L1820 (documented in CLAUDE.md L576)
**Problem**: The H-bond drag position update effect reads AND writes `h_bond_pairs` (`$state`). `realtime_position_overrides` is initialized as `new Map()` (truthy even when empty), so the `!position_overrides` early-return never fires. The effect does `h_bond_pairs = h_bond_pairs.map(...).filter(...)` → new array reference → Svelte detects change → re-triggers effect → potential infinite loop.
**Impact**: Potential infinite loop causing UI freeze during atom drag with H-bonds visible.
**Status**: Partially mitigated — a `position_overrides.size === 0` check was added, but the read-write-on-same-$state pattern remains fragile.
**Fix**: Separate H-bond position update into a non-reactive function called explicitly from the drag handler, not an `$effect`.

### 3. Bond computation state machine needs extraction
**File**: `StructureScene.svelte` — bond computation section (~100 lines)
**Problem**: Bond computation orchestration (Worker WASM → main-thread WASM → JS fallback) is a ~100-line inline state machine with multiple `$effect` blocks, `pending` flags, and error recovery paths. Hardest code to read in the entire rendering pipeline.
**Impact**: Any modification to bond computation risks breaking the fallback cascade. New contributors cannot understand the flow.
**Fix**: Extract into a dedicated `bond-computation.svelte.ts` controller with explicit states (idle → computing_worker → computing_main → computing_js → done/error).

### 4. `get_coordination_colors` synchronous main-thread blocking
**File**: `atom-properties.ts:186`
**Problem**: `get_coordination_colors()` runs synchronous JS bonding inside a `$derived.by()`. For 1000+ atoms with `solid_angle` strategy, this blocks the main thread for 3-15 seconds.
**Impact**: Complete UI freeze when switching to coordination coloring on large structures.
**Fix**: Move to async Worker path. The bond Worker already exists — add a coordination-specific message type returning CN values, then make `property_colors` an async `$effect` instead of `$derived`.

---

## MEDIUM Severity Issues

### 5. Bond.svelte: Missing `needsUpdate` on material property changes
**File**: `Bond.svelte` — currently has `needsUpdate` at lines 230, 240 (for instanceMatrix) but not for material/color changes
**Problem**: When bond colors change (e.g., switching color scheme), the instanced color attribute is updated but `material.needsUpdate` may not always be set. Three.js can skip re-rendering if it thinks the material hasn't changed.
**Impact**: Stale bond colors after theme/color scheme changes until user orbits the camera.
**Fix**: Ensure `material.needsUpdate = true` after color buffer updates.

### 6. Unbounded color caches in 3 files
**Files**:
- `AtomImpostors.svelte:315` — `color_cache = new Map<string, [number, number, number]>()`
- `Bond.svelte:33` — same
- `DashedBond.svelte:33` — same
**Problem**: Every unique hex color string is cached forever. In long sessions with many structure loads (different elements, color schemes), maps grow without bound.
**Impact**: Memory leak — minor for typical use, significant for long-running sessions with many structures.
**Fix**: Either (a) clear cache when structure changes (simplest), (b) LRU with max ~256 entries, or (c) just inline the hex→RGB conversion (it's trivial math, caching may be premature).

### 7. Shader magic numbers without documentation
**File**: `AtomImpostors.svelte` fragment shader
**Lines**: 129-131, 174
**Problem**: Undocumented constants in the shader:
- `0.0031308`, `12.92`, `1.055`, `2.4` — sRGB linear→gamma conversion (IEC 61966-2-1)
- `0.299, 0.587, 0.114` — BT.601 luminance weights
These are well-known constants but completely unexplained.
**Impact**: Maintainability — anyone modifying the shader must look these up.
**Fix**: Add one-line comments: `// sRGB linear→gamma (IEC 61966-2-1)` and `// BT.601 luminance`.

### 8. Code duplication: `color_cache` + `parse_hex_color` across 3 files
**Files**: `AtomImpostors.svelte`, `Bond.svelte`, `DashedBond.svelte`
**Problem**: Identical `color_cache` Map + hex parsing logic copy-pasted in all three.
**Fix**: Extract to shared `color-utils.ts` with `parse_hex_color(hex: string): [number, number, number]`.

### 9. PBC utility code duplication
**Files**: `pbc.ts` vs `atom-properties.ts`
**Problem**: `expand_structure_for_pbc` in `atom-properties.ts` (used by coordination coloring) duplicates logic in `pbc.ts` (used by display). Slightly different behaviors around expansion directions and original-index tagging.
**Fix**: Consolidate into one canonical PBC expansion in `pbc.ts`, parameterized for both use cases.

### 10. Bonding strategy duplication
**File**: `bonding.ts`
**Problem**: `atom_radii`, `electroneg_ratio`, and `solid_angle` strategies share significant boilerplate (neighbor iteration, distance computation, PBC handling). Only the acceptance criterion differs between strategies.
**Fix**: Extract `for_each_neighbor_pair(structure, cutoff, callback)` utility; each strategy implements only its acceptance logic.

---

## LOW Severity / Cleanup

### 11. DashedBond.svelte / Bond.svelte shared logic
Both components have similar instanced mesh setup, buffer management, color handling, and grow-buffer patterns. Consider shared base or composition.

### 12. Console warning in atom-properties.ts
**Line 37**: `console.warn(\`Unknown D3 scale: ${scale}\`)` — acceptable as one-time warning, but verify it doesn't fire repeatedly in reactive recomputation loops.

### 13. Dead code audit needed in bonding.ts
Audit for unused helper functions or commented-out code from earlier iterations of bonding algorithms.

---

## Prioritized Fix Plan

### Week 1 — Critical Bugs
1. **AtomImpostors position override bug** (#1) — Apply overrides in full rebuild path
2. **H-bond infinite loop** (#2) — Refactor to non-reactive explicit function call
3. **Bond.svelte needsUpdate** (#5) — One-line fix

### Week 2-3 — Architecture
4. **Extract bond computation state machine** (#3) — New `bond-computation.svelte.ts`
5. **Async coordination coloring** (#4) — Worker message type for CN computation
6. **Shared color utilities** (#8) — Extract `color-utils.ts`, replace in 3 files
7. **Shader documentation** (#7) — Comment magic numbers

### Month 1 — Tech Debt
8. **PBC consolidation** (#9) — Unify `expand_structure_for_pbc`
9. **Bonding strategy refactor** (#10) — Common neighbor iteration utility
10. **Color cache bounds** (#6) — Clear on structure change or remove caching
11. **DashedBond/Bond shared logic** (#11) — Evaluate composition pattern
12. **Dead code audit** (#13) — Remove unused functions

---

## Testing Notes

- **AtomImpostors fix**: Drag atoms on structures near buffer capacity (e.g., 99 atoms with max=100, add one mid-drag)
- **H-bond fix**: Enable H-bond display, drag an atom that participates in an H-bond
- **Bond needsUpdate**: Switch color schemes with bonds visible, verify immediate update without camera orbit
- **Coordination async**: Time `solid_angle` on 500+ atom structure, verify no UI freeze
- **Color cache**: Load 100+ different structures in sequence, monitor memory

---

*Generated: 2026-03-12 | Branch: CatBot | Reviewer: Claude Code*

# src/lib/structure/ — Structure Visualization & Manipulation

## Why This Module is Complex

This is the largest module (~15k lines total) because 3D crystal structure visualization has inherent complexity:
- **Reactive chain depth**: Base structure → cell transform → supercell → PBC images → displayed structure, with property colors computed independently on the base structure
- **Index mapping**: Supercell and PBC image atoms must map back to base structure indices for coloring. Three different index spaces (base, supercell, displayed) coexist
- **GPU buffer management**: Three.js InstancedMesh allocates fixed-size buffers — must grow manually when atom count increases
- **Multi-backend computation**: Bond detection runs on Worker WASM → main-thread WASM → JS, each with different async/sync patterns
- **Structure.svelte (~9100 lines)** is the main pain point — it's the orchestrator that holds ALL state. Decomposition is planned but requires careful extraction of the reactive chain

## File Overview (by importance)

### Core Orchestrator
- **Structure.svelte** (~9100 lines) — Main component. Manages reactive chain from base structure → displayed atoms. Contains ALL state: structure, supercell, symmetry, property colors, displayed_structure.
- **StructureScene.svelte** (~3300 lines) — 3D rendering via Threlte/Three.js. Receives `displayed_structure` + `property_colors` as props. Contains atom_data, bond rendering, interaction handling.

### Rendering Components
- **AtomImpostors.svelte** (~555 lines) — GPU impostor-based atom rendering. Two InstancedMeshes (opaque + transparent). Custom shader with ray-sphere intersection. **Does NOT use instanceMatrix** — uses custom `instancePosition` attribute instead.
- **Bond.svelte** (~230 lines) — Instanced bond (cylinder) rendering. **DOES use instanceMatrix** in its shader for positioning.
- **Lattice.svelte** — Lattice vector rendering. INDEPENDENT of atom_data/property_colors.

### Data Layer
- **atom-properties.ts** (~342 lines) — Property color computation (coordination, wyckoff, charge, custom). Contains `get_orig_site_idx`, `expand_structure_for_pbc`, `get_coordination_colors`.
- **bonding.ts** (~553 lines) — JS bond computation. Exports `BONDING_STRATEGIES = { electroneg_ratio, solid_angle, atom_radii }`. Synchronous functions returning `Bond[]`.
- **ferrox-wasm.ts** (~1257 lines) — WASM bridge. `pymatgen_to_jscrystal` / `jscrystal_to_pymatgen` conversion. Async wrappers for Rust WASM functions.
- **supercell.ts** (~188 lines) — TypeScript supercell fallback. `make_supercell()` for diagonal scaling.
- **pbc.ts** (~278 lines) — PBC image atom generation for display. `get_pbc_image_sites()`.
- **index.ts** — Re-exports types (`PymatgenStructure`, `Site`, `Bond`, etc.)

### HPC/File UI 组件
- **ServerPane.svelte** (~2227 行) — HPC 连接管理 + 作业监控 + 文件浏览（Connection/Jobs/Files 三个 tab）
- **FileTree.svelte** (~830 行) — 可复用的远程/本地文件树浏览器。Props: `session_id`, `root_path`, `on_load_structure`, `on_open_editor`, `on_load_trajectory`, `on_navigate`, `on_download`, `on_copy_path`, `merging_dir`, `merge_status`
- **MonacoEditorPanel.svelte** (~270 行) — Monaco 编辑器面板，支持远程文件保存（`writeRemoteFile`）。注意首次打开需 force layout
- **TerminalPanel.svelte** (~400 行) — xterm.js 终端。通过 OSC 7 检测 CWD 变化，广播到 BroadcastChannel `catgo-terminal-cwd`
- **TerminalWindow.svelte** (~600 行) — 多标签终端容器（支持分屏）

### Build Tools (modify base structure)
- **LatticePane.svelte** — Build Lattice Transform (matrix supercell via WASM)
- **MillerSlabCutterPane.svelte** — Miller index slab cutting
- **MoirePane.svelte** — Moiré pattern generation
- **NanotubePane.svelte** — Nanotube construction
- **HeterostructurePane.svelte** — Heterostructure stacking
- **AdsorbatePlacementPane.svelte** — Adsorbate placement (doesn't reset supercell)
- **WaterLayerPane.svelte** — Water layer addition (doesn't reset supercell)
- **PseudoHydrogenPane.svelte** — Pseudo-hydrogen passivation (doesn't reset supercell)

---

## Structure.svelte — Reactive Chain (CRITICAL)

```
structure (bindable prop, ~line 1064)
  → unique_elements ($derived, ~1440)
  → property_colors ($derived, ~1453) — try-catch protected!
  → symmetry cleanup $effect (~1468) — clears symmetry_data when structure changes
  → cell_transformed_structure ($derived, ~2281) — depends on cell_type + symmetry_data
    → supercell $effect (~2300) — async WASM, depends on supercell_scaling
      → supercell_structure ($state, ~2296)
        → PBC image $effect (~2453) — get_pbc_image_sites()
          → displayed_structure ($state, ~1120)
            → <StructureScene structure={displayed_structure} {property_colors}> (~7030, ~7102)
```

### Key Line References
| What | Line | Notes |
|------|------|-------|
| `show_image_atoms` state | ~1103 | Controls PBC image display |
| `displayed_structure` state | ~1120 | Final structure passed to StructureScene |
| `symmetry_data` state | ~1142 | MoyoDataset or null |
| `unique_elements` derived | ~1440 | Set of element symbols |
| `property_colors` derived | ~1453 | try-catch → null on error |
| symmetry cleanup effect | ~1468 | Clears symmetry_data on structure change |
| `cell_transformed_structure` derived | ~2281 | Depends on cell_type + symmetry_data |
| `supercell_structure` state | ~2296 | Set by supercell $effect |
| supercell $effect | ~2300 | Async WASM, tracks supercell_scaling |
| `orig_unit_cell_idx` tagging | ~2331 | `i % orig_n` after WASM supercell |
| PBC image $effect | ~2453 | Caches by lattice+topology+reference |
| `displayed_structure =` assignment | ~2469 | In PBC $effect |
| LatticePane on_structure_change | ~6372 | Resets supercell_scaling to '1x1x1' |
| supercell_scaling reset | ~6377 | `supercell_scaling = '1x1x1'` |
| `<StructureScene>` tag | ~7030 | `structure={displayed_structure}` |
| `{property_colors}` to Scene | ~7102 | Passed as prop |

### Build Tool Callbacks
Tools that REPLACE structure must reset supercell_scaling:
- LatticePane (~6372): `supercell_scaling = '1x1x1'`
- MillerSlabCutterPane: `supercell_scaling = '1x1x1'`
- MoirePane, NanotubePane, HeterostructurePane: same

Tools that ADD atoms (don't reset):
- AdsorbatePlacement, WaterLayer, PseudoH

---

## StructureScene.svelte — Rendering

### Key Line References
| What | Line | Notes |
|------|------|-------|
| `ensure_instance_capacity()` | ~232 | Grows instanceMatrix buffer |
| atom interaction mesh $effect | ~248 | Sets mesh.count, uses ensure_instance_capacity |
| `LARGE_STRUCTURE_THRESHOLD` | ~335 | = 2000, switches hover to GPU picker |
| `show_bulk_atoms` derived | ~1865 | `show_atoms && !(cutting_active && ...)` |
| `atom_data` derived | ~1920 | Core atom rendering data |
| `get_orig_site_idx` in atom_data | ~1939 | Maps supercell/image → base index |
| `hidden_prop_vals.has` | ~1943 | Hides atoms by property value |
| `property_colors?.colors[orig_idx]` | ~1946 | Property color lookup |
| color priority | ~1959 | `site_color_override ?? site_property_color ?? colors.element[el]` |
| `filtered_bond_pairs` derived | ~1982 | Bond filtering + visibility |
| bond hitbox $effect | ~2051 | ensure_instance_capacity for bonds |
| lattice rendering | ~2919 | INDEPENDENT of atom_data |

### atom_data Flow
```
for each site in displayed_structure.sites:
  orig_idx = get_orig_site_idx(site, site_idx)
    → site.properties.orig_unit_cell_idx (supercell atoms)
    → site.properties.orig_site_idx (PBC image atoms)
    → site_idx (base atoms)
  if hidden_prop_vals.has(property_colors.values[orig_idx]): SKIP
  color = site_color_override ?? property_colors.colors[orig_idx] ?? element_color
```

### Rendering Independence
```
atom_data ← structure, property_colors, hidden_elements  → atom rendering (AtomImpostors)
lattice   ← structure.lattice.matrix, show_cell, show_bulk_atoms → lattice rendering (INDEPENDENT)
bonds     ← bond_pairs, property_colors                   → bond rendering (Bond.svelte)
```

---

## AtomImpostors.svelte — Atom GPU Rendering

### Architecture
- Two `InstancedMesh`: opaque (depthWrite on) + transparent (depthWrite off, renderOrder=1)
- Custom ShaderMaterial with ray-sphere intersection in fragment shader
- Does NOT use Three.js `instanceMatrix` — uses custom attributes:
  - `instancePosition` (vec3), `instanceRadius` (float), `instanceAtomColor` (vec3)
  - `instanceOpacity` (float), `instanceSaturation` (float)
- Buffers managed by `ensure_buffer()` — grow-only pattern (never shrink)

### Key Effects
| Effect | Purpose |
|--------|---------|
| Full buffer update (~336) | Writes all 5 attributes when atom_data/colors/opacity change |
| Position fast-path (~418) | Updates only positions during drag (realtime_position_overrides) |
| Trajectory fast-path (~460) | Updates positions from Float32Array during playback |

### InstancedMesh Buffer Overflow Fix
`update_mesh_attributes()` (~487) checks if `count > instanceMatrix capacity` and grows the buffer:
```typescript
const current_capacity = mesh.instanceMatrix.array.length / 16
if (count > current_capacity) {
  const new_capacity = Math.max(count, Math.ceil(current_capacity * 2))
  // ... allocate new Float32Array, fill with identity matrices
  mesh.instanceMatrix = new InstancedBufferAttribute(new_array, 16)
}
```
Without this: WebGL silently fails draw call when reading out-of-bounds.

---

## Bond.svelte — Bond GPU Rendering

- Single InstancedMesh with gradient color shader
- **DOES use instanceMatrix** — shader: `modelViewMatrix * instanceMatrix * vec4(position, 1.0)`
- Same buffer overflow fix as AtomImpostors (grow instanceMatrix on demand)
- Custom attributes: `instanceColorStart` (vec3), `instanceColorEnd` (vec3)

---

## Charge Labels System (电荷标签系统)

在 3D 原子上显示电荷值的 HTML 浮层标签。

### 数据流

```
visible_charge_labels (Set<number>)     ← Structure.svelte $state (line 1018)
    ↓ 作为 prop 传递
charge_label_entries ($derived)          ← StructureScene.svelte (line 1364)
    ↓ 过滤 structure.sites，只保留在 Set 中的
{#each charge_label_entries} → <extras.HTML> → <span class="charge-label">
```

### 状态变量 (Structure.svelte ~line 1018)

```typescript
let visible_charge_labels = $state(new Set<number>())
// 哪些原子索引显示标签

let charge_label_offsets = $state(new SvelteMap<number, [number, number]>())
// 每个标签的拖拽偏移量 [dx, dy]

let charge_label_colors = $state(new Map<number, { text?: string; bg?: string }>())
// 自定义文字/背景颜色

let charge_color_menu = $state<{ idx: number; x: number; y: number } | null>(null)
// 右键颜色弹窗状态
```

### StructureScene Props (~line 541)

```typescript
visible_charge_labels = new Set<number>()
show_charge_labels = true
charge_label_offsets = new SvelteMap<number, [number, number]>()
charge_label_colors = new Map<number, { text?: string; bg?: string }>()
on_charge_label_offset_change: (idx, offset) => void   // 拖动标签
on_charge_value_edit: (idx, value) => void              // 双击编辑值
on_charge_label_remove: (idx) => void                   // 删除标签
on_charge_label_contextmenu: (idx, x, y) => void       // 右键菜单
```

### 标签渲染 (StructureScene.svelte ~line 2907)

```svelte
{#each charge_label_entries as entry (entry.site_idx)}
  <extras.HTML center position={entry.position}>
    {#if editing_charge_site_idx === entry.original_idx}
      <input class="charge-label-input" />     <!-- 双击编辑模式 -->
    {:else}
      <span class="charge-label"
        style:color={custom_color?.text}       <!-- 自定义文字色 -->
        style:background={custom_color?.bg}    <!-- 自定义背景色 -->
        ondblclick → 进入编辑模式
        oncontextmenu → 打开颜色弹窗
      >
        {charge} e
      </span>
    {/if}
  </extras.HTML>
{/each}
```

### 标签拖拽 (StructureScene.svelte ~line 341)

- Document 级别 `pointerdown` 监听器（**capture 阶段**）
- 查找 `.charge-label[data-charge-site-idx]` 确定拖拽目标
- 3px 死区：移动 < 3px 不触发拖拽
- `setPointerCapture` 确保拖拽期间鼠标跟踪
- 拖拽期间调用 `on_charge_label_offset_change`

### 右键颜色弹窗 (Structure.svelte ~line 7449)

```svelte
{#if charge_color_menu}
  <div class="charge-color-overlay" onclick={关闭}>
    <div class="charge-color-popup" style:left/top={右键坐标}>
      Text 颜色选择器 (input type="color")
      Background 颜色选择器
      "Reset colors" 按钮 — 重置为默认
      "Remove label" 按钮 (红色) — 删除标签
    </div>
  </div>
{/if}
```

**注意：** `{@const}` 不能放在 `<div>` 内部（Svelte 5 限制），必须用内联表达式。

### 电荷标签操作汇总

| 操作 | 位置 | 实现 |
|------|------|------|
| 切换单个标签 | Structure.svelte 原子右键菜单 | `set.add(idx)` / `set.delete(idx)` |
| 显示全部 | Structure.svelte 右键菜单 | 遍历所有有 bader_charge 的 site |
| 隐藏全部 | Structure.svelte 右键菜单 | `new Set()` |
| 删除 (右键弹窗) | Structure.svelte 颜色弹窗 | `filter(i => i !== idx)` |
| 结构变化清理 | Structure.svelte `$effect` ~line 1341 | 移除无效索引 |

---

## CSS pointer-events 白名单 (重要！)

Threlte 的 `extras.HTML` 将内容渲染到 portal（脱离 Svelte 组件 DOM 树）。

```css
/* 阻止所有 Threlte HTML 浮层的鼠标事件 */
:global(.structure canvas + div *)  { pointer-events: none !important; }

/* 白名单：需要交互的元素必须单独恢复 */
:global(.structure .charge-label)       { pointer-events: auto !important; }
:global(.structure .charge-label-input) { pointer-events: auto !important; }
:global(.structure .measure-label)      { pointer-events: auto !important; }
:global(.structure .responsive-gizmo)   { pointer-events: auto !important; }
:global(.structure .responsive-gizmo *) { pointer-events: auto !important; }
```

**如果在 `extras.HTML` 内添加新的交互元素，必须在此白名单中添加对应的 `:global()` 规则，否则点击事件无法到达！**

---

## atom-properties.ts — Property Color Computation

### Exports
| Function | Purpose |
|----------|---------|
| `get_orig_site_idx(site, idx)` | Maps displayed atom → base structure index |
| `get_property_colors(structure, config, strategy, sym_data)` | Main entry → AtomPropertyColors or null |
| `get_coordination_colors(structure, strategy, scale, type)` | CN computation with PBC expansion |
| `get_wyckoff_colors(structure, sym_data, scale)` | Orbit-based coloring (uses moyo orbits) |
| `get_charge_colors(structure, scale, type)` | Oxidation state coloring |
| `get_custom_colors(structure, fn, scale, type)` | User-defined color function |

### get_orig_site_idx Priority Chain
```
1. site.properties.orig_unit_cell_idx → supercell atoms map to base cell
2. site.properties.orig_site_idx     → PBC image atoms map to parent
3. site_idx                          → base structure atoms (fallback)
```
PBC images INHERIT `orig_unit_cell_idx` from supercell parent via `...orig_site.properties` spread.

### get_coordination_colors Flow
```
structure (N atoms)
  → expand_structure_for_pbc(structure) → expanded (N + images)
    < 20 atoms: full 26-neighbor expansion
    >= 20 atoms: boundary-only (5Å cutoff in fractional coords)
  → BONDING_STRATEGIES[strategy](expanded) → bonds (synchronous JS!)
  → deduplicate neighbors via orig_site_idx mapping
  → coordination numbers [0..N-1]
  → apply_color_scale → colors
```

### PBC Image Direction (CRITICAL — was buggy)
```
dx=-1 image: atom near boundary 1 (norm >= 1-cutoff) → shifted to near 0
dx=+1 image: atom near boundary 0 (norm <= cutoff)   → shifted to near 1
```
WRONG (old): `dx === -1 ? norm <= cutoff : norm >= 1 - cutoff` (REVERSED!)

---

## ferrox-wasm.ts — WASM Bridge

### Key Functions
| Function | Line | Notes |
|----------|------|-------|
| `pymatgen_to_jscrystal()` | ~77 | PymatgenStructure → JsCrystal for WASM |
| `jscrystal_to_pymatgen()` | ~163 | JsCrystal → PymatgenStructure (sets abc, xyz, properties) |
| `FerroxWasmModule` interface | ~234 | All WASM function signatures |
| `compile_wasm_module()` | ~335 | Fetches + compiles .wasm file |
| `ensure_ferrox_wasm_ready()` | ~361 | Lazy init, returns module |
| `create_supercell()` | ~521 | Diagonal supercell (nx, ny, nz) |
| `get_neighbor_list()` | ~615 | Distance-based neighbor search |
| `create_supercell_matrix()` | ~699 | Full 3x3 matrix supercell (Build Lattice) |
| `detect_bonds_radii()` | ~1059 | WASM bonding: atom_radii strategy |
| `detect_bonds_electronegativity()` | ~1073 | WASM bonding: electroneg_ratio strategy |
| `detect_bonds_solid_angle()` | ~1087 | WASM bonding: solid_angle strategy |

### jscrystal_to_pymatgen Output
Sites have: `{ species, abc, xyz, label, properties: site.properties ?? {} }`
WASM supercell output does NOT set `orig_unit_cell_idx` — must tag manually after.

### Deep Copy Pattern
`create_supercell_matrix` uses `JSON.parse(JSON.stringify(jsCrystal))` to avoid Svelte proxy issues.

---

## bonding.ts — JS Bond Computation

### Strategies
```typescript
export const BONDING_STRATEGIES = { electroneg_ratio, solid_angle, atom_radii }
```
All are synchronous functions: `(structure: AnyStructure, options?) => Bond[]`

### Import Safety
- `atom-properties.ts` imports `BONDING_STRATEGIES` from `./bonding` — NO circular dependency
- `bonding.ts` only imports types from `$lib` (erased at compile), values from `$lib/element` and `$lib/math`
- `$lib/structure/index.ts` re-exports from `atom-properties.ts` — safe because bonding.ts doesn't import from it

### Performance Note
JS `solid_angle` for ~2000 atoms: ~3-15 seconds synchronous. WASM Worker is ~10-50x faster.
~~`get_coordination_colors` uses SYNCHRONOUS JS bonding in a `$derived` — can freeze UI for large structures.~~
**[2026-03-01 已修复]** coordination coloring 现在通过异步 Worker 计算键，不再阻塞主线程。详见 Learned Patterns 部分。

---

## supercell.ts — TypeScript Supercell (Fallback)

- `parse_supercell_scaling(input)` → `[nx, ny, nz]`
- `make_supercell(structure, scaling)` → new structure with scaled lattice
- Site loop order: kk(z) → jj(y) → ii(x) → sites (inner)
- `properties: site.properties` — shares reference (NOT deep copy)
- Does NOT set `orig_unit_cell_idx` — that's done by Structure.svelte's supercell $effect

---

## pbc.ts — PBC Image Atoms for Display

- `get_pbc_image_sites(structure)` → structure with added image atoms
- Image atoms get `properties: { ...orig_site.properties, orig_site_idx: site_idx }`
- PBC images inherit `orig_unit_cell_idx` from supercell parent via spread
- Used by the PBC $effect in Structure.svelte for displayed_structure

---

## Svelte 5 注意事项

- 使用 `$state`, `$derived`, `$effect` runes（不是旧的 Store API）
- `{@const}` 必须是 `{#if}`, `{#each}`, `{#snippet}` 的直接子元素，不能在 `<div>` 内
- Threlte portal 内的 scoped CSS 不生效，必须用 `:global()` 包裹
- `SvelteMap` 用于需要触发响应式更新的 Map 类型（如 charge_label_offsets）

---

## Common Pitfalls

1. **InstancedMesh buffer overflow**: Three.js allocates instanceMatrix at construction. When atom count grows, must manually grow the buffer. WebGL silently fails otherwise — no console errors, just invisible geometry. Symptom: atoms appear after toggling Atoms checkbox off→on (forces mesh recreation).

2. **`$derived` error propagation**: `$derived.by()` does NOT catch errors. Wrap error-prone computations (bonding, WASM) in try-catch to prevent cascade failures. Without try-catch, a bonding error in property_colors crashes atom_data, which crashes AtomImpostors.

3. **PBC image direction**: `dx=-1` images need atoms near boundary 1 (high frac coord), NOT boundary 0. Getting this backwards: coordination numbers near boundaries are wrong (typically too low).

4. **Neighbor deduplication**: Image atom B' and original B must be deduplicated via `orig_site_idx` before counting coordination neighbors. Without this: atoms near cell boundaries get inflated CN (e.g., 12 instead of 6).

5. **Supercell scaling compound bug**: Build tools that replace structure MUST reset `supercell_scaling = '1x1x1'` to prevent old scaling from compounding with new structure. Symptom: after Build Lattice 2x2x2, atoms are arranged as if 4x4x4.

6. **property_colors index space**: Computed on BASE structure (not supercell). StructureScene maps displayed atoms back via `get_orig_site_idx`. If you accidentally use displayed index, you get wrong colors or out-of-bounds access.

7. **Synchronous WASM on main thread**: `analyze_cell()` (moyo) blocks for seconds on large structures. Gate behind user action, not auto-compute. Also affects `get_coordination_colors` which uses sync JS bonding.

8. **CSS pointer-events in Threlte HTML**: `extras.HTML` 内的元素默认被 `pointer-events: none` 阻断。新增交互元素必须在 CSS 白名单中添加 `:global()` 规则。

---

## Debugging Guide

### Atoms Invisible After Operation
1. Check browser console — no errors means likely InstancedMesh buffer overflow
2. Toggle Atoms checkbox off→on — if atoms reappear, it's buffer overflow
3. Fix: ensure `ensure_instance_capacity()` is called before setting `mesh.count`
4. All three components must handle this: AtomImpostors, StructureScene (interaction mesh), Bond

### Wrong Colors on Atoms
1. Check if `property_colors` is null in console — try-catch may have caught an error silently
2. Verify `get_orig_site_idx` returns correct base index — print `site.properties.orig_unit_cell_idx` and `site.properties.orig_site_idx`
3. Check color priority: `site_color_override > property_color > element_color`
4. For coordination: verify `expand_structure_for_pbc` places images correctly

### Bonds Not Showing
1. Check `bond_pairs` in console — empty means bond computation failed
2. Check if WASM loaded: `console.log(await ensure_ferrox_wasm_ready())`
3. Bond Worker may have failed silently — check main-thread fallback path
4. For hydrogen bonds: they default to hidden, check `show_hydrogen_bonds` setting

### Performance Debugging
- **Coordination coloring freeze**: `get_coordination_colors` runs sync JS. Profile with `console.time()`. For 1000+ atoms with `solid_angle`: expect 3-15s freeze. Workaround: use `atom_radii` strategy (faster) or reduce atom count
- **Supercell expansion lag**: WASM supercell is fast (<100ms for 2x2x2). If slow, check if it's falling back to TS supercell. Look for `[ferrox] wasm module not ready` in console
- **Rendering stutter**: Check if atom_data $derived is recomputing unnecessarily. It depends on `displayed_structure`, `property_colors`, `hidden_elements`, `selected_atoms` — any change triggers full recompute

### How the Reactive Chain Breaks
The most fragile point is the async supercell $effect (~2300):
```
structure changes → cell_transformed_structure updates (sync $derived)
  → supercell $effect triggers (async — WASM)
    → awaits create_supercell() or make_supercell()
    → sets supercell_structure ($state)
      → PBC $effect triggers
        → sets displayed_structure ($state)
```
If WASM fails, supercell_structure doesn't update → PBC $effect doesn't trigger → displayed_structure becomes stale. The $effect has a generation counter to discard stale results from previous async calls.

## Known Issues

- ~229 个预存在的 TypeScript 错误，与新代码无关
- `extras.HTML` 内的元素受 `pointer-events: none` 影响，新增交互元素必须加白名单
- **[2026-03-07] 不要在子组件 CSS 中设 `visibility: visible`**：App.svelte 用 `visibility:hidden` 隐藏非活跃 tab。AtomLegend/StructureLegend 曾设 `visibility: visible` 覆盖父级，导致隐藏 tab 的图例透过来显示在活跃 tab 上。已删除这些 override

### [2026-03-06] `toggle_unit_cell` 工具无效 — `show_cell` prop 从未接入渲染

**现象:** AI Chat 调用 `toggle_unit_cell` 工具后，晶胞边框不显示/不隐藏。

**根因:** `tool-handler.ts` 中 `toggle_unit_cell` 设置 `scene_props.show_cell`，但 `StructureScene.svelte` 没有声明 `show_cell` prop，渲染条件 `{#if lattice && show_bulk_atoms}` 完全不检查此值。settings.ts 默认值 `show_cell: false` 也从未生效——晶胞总是无条件显示。

**修复:**
1. StructureScene 新增 `show_cell` prop（默认 `DEFAULTS.structure.show_cell`）
2. 渲染条件改为 `{#if lattice && show_cell && show_bulk_atoms}`
3. settings 默认值改为 `true`（保持现有行为：晶胞默认可见）
4. StructureControls 新增 "Unit Cell" checkbox

### [2026-03-01] BuildPane max-width 遮挡内部 UI

**问题:** `BuildPane.svelte` 硬编码 `max_width="24em"`，传递给 `DraggablePane` 的 `style:max-width`。当 Build Tools 内容（如 Slab Cutter 的多个 section、Lattice 的矩阵输入）超过 24em 宽度时，内容被裁剪不可见。

**修复:** `max_width="24em"` → `max_width="none"`，取消宽度限制。DraggablePane 本身有 CSS `max-width: var(--pane-max-width, 80cqw)` 兜底，不会无限扩展。

### [2026-03-01] Slab Cut Apply 按钮无反应 — WASM 与 JS glue 不匹配 + 错误静默吞没

**现象:** 点击 Apply Cut 后无任何反应。按钮可能处于 disabled 状态（preview 为 null），或点击后 WASM 调用失败但错误被 try-catch 静默吞没。

**根因 1: ferrox WASM 与 JS glue 不同步**

Rust 源码更新后未重新执行 `wasm-pack build`，导致 `ferrox_bg.wasm` 引用了 JS glue (`ferrox.js`) 中不存在的 wasm-bindgen 导入函数（如 `_wbg_new_8a6f238a6ece86ea`）。`WebAssembly.instantiate()` 抛出 `LinkError`，被 `wasm_generate_slab` 的 catch 捕获。

```bash
# 验证: 检查 .wasm 需要的函数是否在 .js 中存在
grep -c "_wbg_new_8a6f238a6ece86ea" extensions/rust-wasm/pkg/ferrox.js
# 0 = 不匹配，需要重编译

# 修复:
cd extensions/rust && wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm
# 重启前端 dev server（Vite 缓存旧 .wasm）
```

**根因 2: apply_cut() 错误静默吞没**

原代码 `apply_cut()` 在两处静默失败：
1. 开头 `if (!source || !is_valid) return` — 无任何用户反馈
2. catch block 只 `console.error` — 用户看不到

**修复:** 添加 `error_message` state，所有失败路径都设置可见的错误消息，在 Apply 按钮下方显示红色提示。disabled 按钮添加 title tooltip 说明原因。

**教训:** 切换分支或 pull 代码后，如果 Rust 源码有变更，必须重新 `wasm-pack build`。WASM 不匹配的报错被层层 catch 吞没，表现为"什么都没发生"。

---

### [2026-03-12] Headlamp (camera-fixed) lighting restored

**Before (2026-03-11):** World-space light `(-0.7, -0.5, 1.0)` transformed via `mat3(viewMatrix)` — atoms facing away from the fixed light became very dark when orbiting.

**After:** Light direction `(-0.7, -0.5, 1.0)` used directly in view space (headlamp). `uLightDirWorld` → `uLightDir`, removed `mat3(viewMatrix)` transform. Lighting is now consistent regardless of camera angle.

**Shader (both AtomImpostors + Bond):**
- Uniform: `uLightDir` (view-space, normalized)
- No `viewMatrix` transform — light direction is fixed relative to camera
- Specular power 60, specular intensity × 0.6, rim smoothstep 0.45 (atoms) / 0.25 (bonds) — unchanged from 2026-03-11

**Pitfall:** `projectionMatrix` is NOT auto-injected by Three.js into fragment shaders and must be declared explicitly. `viewMatrix` IS auto-injected — do NOT re-declare.

### [2026-03-11] Background color picker didn't update canvas clear color

**Problem:** Changing background color in Appearance settings changed atom/bond depth-cue tint but not the actual canvas background.

**Root cause:** `sync_clear_color()` walked the DOM looking for computed `backgroundColor` with `alpha >= 0.5`. The `--struct-bg-override` CSS variable was set with very low alpha (opacity default 0.1 → `#rrggbb1a`), so it was always skipped. The walk fell through to a parent `.pane` element.

**Fix:** `sync_clear_color()` now checks the `background_color` prop directly first. If the user explicitly picked a color, it's used for the renderer clear color without the DOM walk. A separate `$effect` tracks `background_color` changes.

---

## Learned Patterns

### [2026-03-14] Rotation center: lattice center vs atom centroid (`get_rotation_center` vs `get_center_of_mass`)

**Problem:** Structures imported from Materials Project (e.g., Cu FCC mp-30) rotated around the origin instead of the visual center of the unit cell. The orbit controls target was set to the atom centroid, but for primitive cells with atoms at (0,0,0), the centroid IS the origin — the corner of the lattice box.

**Root cause (two parts):**

1. **`get_center_of_mass()` used atom centroid for all structures.** For periodic structures, this gives a corner-biased pivot when atoms sit near the origin. Crystallographic viewers (VESTA, Avogadro) use the lattice center instead.

2. **MCP push path missing `center_camera_trigger`.** When CatBot/MCP tools pushed structures via `POST /view/structure/pending-update`, the frontend polling loop (`tool-handler.ts:poll_structure_updates`) called `set_structure()` but never incremented `center_camera_trigger`. The orbit target stayed at the previous structure's center. All other import paths (OPTIMADE modal, file drag-drop, paste) correctly incremented it.

**Fix (three changes):**

1. **Split functions** (`index.ts`):
   - `get_center_of_mass(structure, max_sites)` — pure atom centroid. Used by inertia tensor, merge positioning, context menu fallback.
   - `get_rotation_center(structure)` — lattice center `0.5*(a+b+c)` for periodic structures, atom centroid for molecules. Used by `rotation_target` in StructureScene and raycasting plane in interaction controller.

2. **Added `inc_center_camera`** to `McpBridgeDeps` and `ToolHandlerDeps` interfaces (`tool-handler.ts`). Called after `set_structure()` in:
   - MCP polling loop (`poll_structure_updates` / `handle_pending_update`)
   - AI tool handler: `set_lattice`, `create_supercell`, `cut_slab`
   - Visibility restore path

3. **Extracted `handle_pending_update()` helper** (`tool-handler.ts`) — shared by the polling loop and visibility-restore one-shot, eliminating duplicated logic that had already drifted (`workflow_id` handling was missing from the one-shot).

**Why NOT recenter on add_atom/delete_atoms/move_atom/replace_atom/place_adsorbate/dope_structure?** These are incremental edits — the center barely shifts, and recentering would be disorienting mid-edit. Only operations that fundamentally change the geometry (new structure from MCP, lattice change, supercell, slab) recenter.

**Key files:**
- `src/lib/structure/index.ts` — `get_center_of_mass()`, `get_rotation_center()`
- `src/lib/structure/StructureScene.svelte:1391` — `rotation_target` uses `get_rotation_center`
- `src/lib/structure/controllers/tool-handler.ts` — MCP polling + AI tool centering
- `src/lib/structure/controllers/interaction.svelte.ts:351` — raycasting plane uses `get_rotation_center`

**Rule:** For the camera orbit pivot, always use `get_rotation_center()`. For physics/positioning calculations that need the actual atom center, use `get_center_of_mass()`. Never mix them — the lattice center can be far from atoms (e.g., slabs with vacuum).

### [2026-02-27] Split-view 坐标系 bug: `wrapper` vs `canvas` rect

**问题**: `project_to_screen()` 和 box selection 坐标计算使用 `wrapper.getBoundingClientRect()`。Three.js 相机投影基于 **canvas** 尺寸。当打开分屏面板（chat/DOS/side panel）时，wrapper 包含面板区域，比 canvas 宽。导致 `(ndc * 0.5 + 0.5) * rect.width` 产生错误的屏幕坐标，box selection 的 `is_in_rect` 永远匹配不到原子。

**根因**: Chat 关闭时 `.structure-main` 是 `display: contents`，wrapper 宽 = canvas 宽，无问题。Chat 打开时 wrapper 变成 grid（`1fr 5px 28%`），wrapper 宽 > canvas 宽。

**修复**: 所有涉及 3D→2D 坐标转换的地方，用 `wrapper.querySelector('canvas')?.getBoundingClientRect()` 替代 `wrapper.getBoundingClientRect()`（带 wrapper 兜底）。影响的函数：
- `project_to_screen()` (~line 4360)
- `handleShiftClickCapture()` box selection 起点 (~line 4104)
- `onmousedown()` box selection 备用路径 (~line 4172)
- `onmousemove()` box selection 拖拽 (~line 4250)

**规则**: 凡是需要和 Three.js 相机投影对齐的屏幕坐标，必须用 canvas rect，不能用 wrapper rect。Wrapper rect 只适用于 UI 布局相关的坐标（如 resize handle）。

### [2026-03-01] coordination coloring 不再阻塞主线程

**之前**: `property_colors` 是 `$derived.by()`（同步），coordination 模式调用 `get_coordination_colors()` 在主线程同步运行 JS bonding，1000+ 原子时冻结 UI 3-15 秒。

**修复**: `property_colors` 从 `$derived.by()` (同步) 改为 `$effect` + `$state` (异步)。coordination 模式通过 `compute_bonds_async()` 在 Worker 中计算键，然后用 `coordination_colors_from_bonds()` 映射颜色。其他模式 (wyckoff, charge, custom) 仍同步计算（很快不需要异步）。

**规则**: 任何需要 bond 计算的 property coloring 都应该走异步 Worker 路径，不能在 `$derived` 中同步阻塞主线程。

### [2026-03-01] H-bond drag effect 无限循环: `$effect.pre` 读写同一 `$state`

**问题**: 点击 "Show H-bonds" checkbox 后触发 `effect_update_depth_exceeded`，UI 卡死。

**根因**: H-bond drag position update effect（StructureScene.svelte ~L1820）同时读写 `h_bond_pairs`（`$state`）。`realtime_position_overrides` 在父组件 Structure.svelte 中初始化为 `new Map()`（truthy，即使是空 Map），所以 `!position_overrides` 为 false，不会 early return。Effect 执行 `h_bond_pairs = h_bond_pairs.map(...).filter(...)` → 新数组引用 → Svelte 检测到变化 → 重新触发 effect → 无限循环。

**对比**: 普通 bond 的 position update effect（~L1666）读 `bond_connectivity` 写 `bond_pairs`——不同变量，无自引用。

**修复 (v1, 2026-03-01)**:
1. 添加 `position_overrides.size === 0` 检查——空 Map 直接 return
2. 用 `untrack(() => h_bond_pairs)` 读取——不建立依赖，避免写入后触发自身

**修复 (v2, 2026-03-16) — 根本性修复，删除了 v1 的 workaround**:
将 `h_bond_pairs` 从 `$state`（被 `$effect.pre` 读写）拆分为：
- `h_bond_connectivity`（`$state`）— 仅拓扑数据（site indices + strength），由检测 effect 写入
- `h_bond_pairs`（`$derived.by()`）— 从 connectivity + `realtime_position_overrides` + 结构位置派生完整 `BondPair[]`

`$derived` 不能写回自身输入，从根本上消除了无限循环。同时删除了 Block 5（旧的 `$effect.pre`），添加了 try-catch 防止错误传播（CLAUDE.md Pitfall #2），并在检测 effect 的所有 early-return 路径递增 `hbond_computation_gen` 防止异步 WASM 写回过期数据。

**规则**: `$effect` / `$effect.pre` 中如果需要读写同一个 `$state` 变量，最佳方案是拆分为 connectivity（`$state`）+ pairs（`$derived`）模式。`$derived` 从结构上不可能触发自身。次选方案是 `untrack()` 包裹读取。

### [2026-03-02] saveable_structure bindable prop — 保存实际修改后的结构

**问题:** 父组件（App.svelte）保存结构时读 `pane.structure`，但用户看到的是经过超胞变换后的 `supercell_structure`。保存基础结构而非可见结构。

**修复:** 新增 `saveable_structure = $bindable<AnyStructure | undefined>(undefined)` prop，通过 `$effect` 同步：
```typescript
$effect(() => {
  saveable_structure = supercell_structure ?? structure
})
```

父组件绑定后可直接读取 `pane.saveable_structure` 获得用户当前看到的实际结构。

### [2026-03-02] oxidation_state 从 Species 类型中改为可选

**问题:** `Species` 类型中 `oxidation_state: number` 是必填字段。前端 20+ 处创建 species 时设置 `oxidation_state: 0`。pymatgen `Structure.from_dict()` 将 `{element: "C", oxidation_state: 0}` 反序列化为 `Species("C", 0)`，其 `species_string` 为 `"C0+"`。导致 XYZ/CIF 输出中元素名变成 `C0+`。

**修复:**
- `index.ts`: `oxidation_state?: number`（改为可选）
- `atom-manipulation.ts`: `add_atom`/`add_atoms` 不再设置 `oxidation_state`
- 后端 `workflow.py`: 改用 ASE 序列化（通过 `converter.py` 的 `_clean_element_symbol` 自动清理）

**注意:** `replace_atom`（line ~363）和其他 20+ 处仍有 `oxidation_state: 0`，后端 ASE 路径已做防御性处理。前端逐步清理中。

### [2026-03-04] `$derived.by()` 不追踪 Set/Map 类型 prop 变化

**问题:** StructureScene 的 `atom_data` (`$derived.by()`) 读取 `hidden_elements` prop（Set 类型），但只在第一次变化时重新计算，后续变化被忽略。`$effect` 能正确追踪同一个 prop。

**根因:** Svelte 5 的 `$derived.by()` 对 Set/Map 类型的 prop 依赖追踪不可靠。即使在 derived 中读取 `.size` 和 `.has()`，仍无法触发重新计算。`$effect` 使用不同的追踪机制，能正确追踪。

**修复:** 用 `$effect` + `$state` 桥接 prop 到本地状态：
```javascript
let _hidden_elements = $state(new Set<ElementSymbol>())
$effect(() => {
  _hidden_elements = new Set(hidden_elements ?? [])
})
// atom_data $derived.by() 中使用 _hidden_elements 而非 hidden_elements
```

同时将 AtomLegend 的 `bind:hidden_elements` 改为回调模式 `on_hidden_elements_change`，避免多级 `$bindable` 链。

**规则:** 当 `$derived.by()` 需要依赖 Set/Map 类型的 prop 时，用 `$effect` + `$state` 桥接。不要依赖 `$derived` 直接追踪 Set/Map prop。

### [2026-03-25] OPTIMADE API 返回非标准晶格轴序 — 导致 Miller 指标指向错误方向

**问题:** 从 OPTIMADE (Materials Project) 导入 mp-825 (RuO2 金红石) 后，晶格为 a=3.11, b=4.48, c=4.48。但金红石标准设置应为 a=b=4.48, c=3.11（四方晶系 c 是短轴）。导致 (001) 切面实际切的是 (100) 方向。

**根因:** MP 网站下载的 CIF/POSCAR 经过 pymatgen `SpacegroupAnalyzer` 标准化，轴序正确。但 MP 的 OPTIMADE API (`optimade.materialsproject.org`) 返回的是 DFT 松弛后的**原始计算晶胞**，没有做对称性标准化。VASP 优化器不管晶体学约定，松弛完什么方向就存什么方向。OPTIMADE 规范本身不要求返回标准化晶胞。

**这不是 CatGo 解析 bug，是数据源问题。** 同一个 mp-825，MP 网站和 OPTIMADE API 给出不同的轴序。其他 OPTIMADE provider（Alexandria、MC3D）也可能有同样的问题。

**修复 (`OptimadeSearchModal.svelte:handle_import`):** OPTIMADE 导入后自动调用 `analyze_structure_symmetry` + `get_conventional_cell`，标准化到常规胞设置。如果对称性分析失败，fallback 到原始结构并打印警告。

**规则:** 从任何外部数据库导入的结构，不能假设晶格轴序符合晶体学标准。必须经过对称性分析+常规胞变换后再用于 Miller 指标相关操作。

### [2026-03-25] DraggablePane 高度溢出 — `style:max-height` 未考虑面板实际位置

**问题:** Build Tools / Slab Cutter 面板内容超出视口底部被截断，看不到 "Apply Cut" 按钮。在 Workflow 的 "Open in new window" 场景尤为严重。

**根因 (三层):**
1. CSS `max-height: calc(100vh - 40px)` 不考虑面板的 `top` 位置。面板在 top=200px 时，底部延伸到 200px + (100vh-40px) = 100vh+160px，超出视口。
2. `calculate_position()` 的 fallback 路径（`toggle_pane_btn` 为空时，如 BuildPane 的 `show_toggle={false}`）返回空 `maxHeight`，依赖 CSS fallback。
3. Svelte 的 `style:max-height={initial_position.maxHeight || null}` 绑定会覆盖 `$effect` 中直接设置的 `pane_div.style.maxHeight`，必须通过更新 `initial_position`（响应式状态）来生效。

**修复 (`DraggablePane.svelte`):**
1. `calculate_position()` 的两个有 toggle button 的路径：基于 `top_val` + 容器高度计算 `maxHeight`
2. 新增通用 `$effect`：面板显示后，用 `requestAnimationFrame` 读取面板实际 `getBoundingClientRect().top`，计算 `maxHeight = vh - top - margin`，更新 `initial_position`（不直接操作 DOM）

**规则:** 设置 DraggablePane 的 maxHeight 必须通过更新 `initial_position` 状态，不能直接操作 `pane_div.style`。Svelte 的 `style:` 绑定会覆盖 DOM 直接修改。

### [2026-03-25] Slab 原胞约化改变面内矢量方向 — 切面和晶胞线框不一致

**问题:** `reduce_in_plane_primitive` 对金红石 (001) 找到了旋转 45° 的原胞（面积减半），导致 preview 的晶胞线框和切面带方向不一致。

**根因:** 原胞约化算法从同层原子间距搜索最短平移矢量。金红石的体心原子提供了 [a/2+b/2] 方向的平移矢量，面积是常规胞的一半，晶体学上合法但旋转了 45°。

**修复 (`miller-slab.ts` + `slab.rs`):** 原胞约化后检查新矢量是否与原始 `surf_a`, `surf_b` 方向平行（夹角 < 15°）。不平行则放弃约化，保持原始方向。

**规则:** 面内原胞约化必须保持与原始面内矢量一致的方向。约化后检查 `cos_angle(reduced_a, orig_a) > cos(15°)` && `cos_angle(reduced_b, orig_b) > cos(15°)`，否则跳过。

---

## Additional Stable Gotchas (from Rust-DAG branch)

- Be careful about reactivity when a rendering primitive is initialized from a prop only once.
- **Svelte 5 `$derived.by` does NOT reliably track deep mutations in array/object props passed through multiple component layers** (e.g. Structure -> StructureScene -> child). Inner objects lose their reactive proxy, so changing a property inside an array item won't trigger re-computation. Use `$effect` + `$state` with `JSON.stringify(prop)` to force deep tracking instead. See `SlabPreview.svelte` bond distance rules filtering for the canonical pattern.
- Large-file complexity is a real maintenance problem here: `Structure.svelte`, `StructureScene.svelte`, `ExportPane.svelte`, `parse.ts`

See also:
- `reports/bug-followup-2026-03-13.md`
- `reports/refactor-hotspots-2026-03-13.md`

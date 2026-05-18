# catrender — Publication-Quality Molecular Render Plugin (Design)

Date: 2026-05-18
Status: Approved (brainstorming) — pending spec review

## Goal

Integrate the rendering aesthetic of [aligfellow/xyzrender](https://github.com/aligfellow/xyzrender)
into CatGo as a first-party plugin named **catrender**. CatGo's main viewer is
interactive 3D WebGL; it does not produce the clean publication-grade 2D vector
illustrations (flat / paton / skeletal / bubble / tube / wire / graph presets)
that xyzrender is known for. catrender fills exactly that gap.

The render pane mirrors the active panel's structure in real time: editing the
structure in the main viewer updates the rendered SVG live, with no server
round-trip. The user adjusts render parameters (preset, view angle, H toggle,
labels, cell/supercell) inside the pane, and may apply a render-only bond
override layer. AI can trigger an export of the current structure through an
MCP tool.

## Non-Goals (v1)

- QM isosurfaces (orbitals / electron density / ESP) and cube files. CatGo
  already renders these via `extensions/chgdiff-wasm/` + `src/lib/electronic/`;
  not duplicated here.
- Transition-state bond analysis (xyzrender's graphRC / imaginary-freq path).
- GIF and PDF output. (SVG + PNG only in v1.)
- Editing the structure itself from inside the render pane (mirror is
  read-only; bond overrides are render-only and do not write back).
- QM file parsing (Gaussian/ORCA/etc.) — CatGo's existing parsers feed the pane.

In scope v1: molecular appearance (11 presets, depth-cue/fog, ball-stick,
H toggle, rotation/view, distance/angle labels, SVG/PNG export) **plus the
crystal package** (unit cell box, supercell, periodic-boundary wrap rendering).

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Approach | Pure Rust → WASM render core | True real-time, no server round-trip; reuses CatGo's existing connectivity |
| Pane ↔ viewer | Mirror mode (read-only) | Pane derives active-panel structure; only render params editable in pane |
| Bond editing | Render-layer override | Pane add/remove/set-order is an overlay; never writes back to main viewer |
| AI export | Bridge to frontend render | One render core for both live preview and AI export; no second drawing codebase |
| Name | `catrender` | "render" too generic / collides with existing render code |

## Architecture

```
┌─ Main viewer (active panel) ────────────┐
│  structure + bond_connectivity (exists) │
└──────────────┬──────────────────────────┘
               │ $derived mirror (read-only)
               ▼
┌─ CatRenderPane.svelte (new, plugin pane)┐
│  ├ render-param UI: preset / H / view   │
│  │   / rotation / labels / cell·super   │
│  ├ bond-override UI (add/del/set-order) │
│  ├ calls wasm render(...) → SVG string  │
│  │   ($effect, debounced ~16ms)         │
│  └ {@html svg} live preview             │
│     + Export SVG / PNG buttons          │
└──────────────┬──────────────────────────┘
               │ same wasm core reused
┌─ extensions/catrender-wasm/ (new Rust) ─┐
│  crate-type=cdylib, wasm-bindgen        │
│  render(input_json) -> SVG string       │
│    project / depth-sort / radial-grad / │
│    preset → SVG                         │
└──────────────────────────────────────────┘
               ▲ AI export path
┌─ MCP plugin catgo_catrender_export ─────┐
│  POST style → /api/view/catrender/      │
│    pending ; frontend pane renders ;    │
│  POST result bytes → server saves →     │
│  returns file path to AI                │
└──────────────────────────────────────────┘
```

One Rust render core. Live preview and AI export share it. No forked drawing
code.

## Component: Rust render core (`extensions/catrender-wasm/`)

Follows the `extensions/chgdiff-wasm/` pattern: `crate-type = ["cdylib"]`,
`wasm-bindgen`, `console_error_panic_hook`, `opt-level = "z"`, `lto = true`.

Single pure entry (no internal state — safe to call every frame):

```rust
#[wasm_bindgen]
pub fn render(input_json: &str) -> String   // returns SVG string
```

`input_json` schema:

```jsonc
{
  "atoms":  [{"el":"C","xyz":[x,y,z]}, ...],   // from mirrored structure
  "bonds":  [{"i":0,"j":1,"order":2}, ...],     // main connectivity ⊕ overrides (merged in frontend)
  "lattice": [[..],[..],[..]] | null,           // crystal package
  "style": {
    "preset": "paton",                          // enum of 11
    "show_h": true,
    "rotation": [rx,ry,rz],
    "scale": 1.0,
    "depth_cue": true, "fog": 0.3,
    "labels": { "distances": [[i,j]], "angles": [[i,j,k]] },
    "cell": { "show": true, "supercell": [2,2,1], "pbc_wrap": true }
  }
}
```

Preset is a style table, not 11 if-branches:

```rust
struct Preset {
  atom_radius_scale: f32, bond_width: f32, bond_style: BondStyle,
  gradient: GradientMode, outline: f32, palette: Palette, depth_strength: f32,
}
static PRESETS: Map<&str, Preset>  // default/flat/paton/skeletal/bubble/tube/wire/graph/...
```

Preset numeric constants are ported verbatim from xyzrender's Python source
(do not re-design the aesthetic).

Render pipeline (pure geometry): apply rotation matrix → project 3D→2D →
depth-sort → per preset emit `<circle>` (radial-gradient spheres) /
`<line>`/`<path>` (bonds: single/double/triple, aromatic dashed) / cell box
lines → depth-cue brightness/blur → assemble SVG.

## Component: bond-override merge (frontend, before calling core)

```
effective_bonds = main_viewer_connectivity ⊕ pane_overrides
  add:      add edge (i,j) with order
  remove:   drop edge (i,j)
  setorder: change order of edge (i,j)
```

Overrides stored in pane-local `$state`, keyed by `(i,j)` (i<j normalized).
Atom-index invalidation: if an atom is deleted upstream, overrides referencing
it are discarded. Overrides never propagate to the main viewer.

## Component: CatRenderPane.svelte

`src/lib/.../CatRenderPane.svelte`, registered into the existing plugin pane
host (`src/lib/plugins/PluginPanelHost.svelte` / `manager.svelte.ts`).

```
$derived mirror of active panel: { atoms, lattice, main_bonds }  // read-only
$state local: style{}, bond_overrides{}
$effect (debounced ~16ms):
   merged = merge_bonds(main_bonds, bond_overrides)
   svg = catrender_wasm.render(JSON{atoms, merged, lattice, style})
{@html svg}   // live preview
Export buttons: SVG (direct) | PNG (rasterize svg → canvas → toBlob)
```

WASM wrapper `src/lib/.../catrender-wasm.ts` + `catrender-wasm-pkg/`,
following the `src/lib/electronic/chgdiff-wasm.ts` lazy-init pattern.

## Component: AI export bridge

Reuses the existing screenshot-pending pattern in
`server/catgo/routers/view_capture.py`:

```
POST /api/view/catrender/pending   {style, format}   ← MCP writes
GET  /api/view/catrender/pending                     ← frontend polls/SSE
POST /api/view/catrender/result    {bytes}           ← frontend posts back
```

Frontend `CatRenderPane` watches pending → wasm-renders the current mirrored
structure with the requested style → posts result bytes.

MCP plugin `~/.catgo/plugins/catrender.py` (hot-reload pattern, `TOOL_DEF` +
`async def handle`):

```
catgo_catrender_export(preset, format, show_h, rotation, labels, cell, ...)
  → POST pending → poll result → save to disk → return file path to AI
```

AI cannot change the structure (read-only mirror); it selects
preset/view/format and exports the current structure.

## Build chain

- `extensions/catrender-wasm/` Cargo crate (cdylib, wasm-bindgen,
  opt-level=z, lto).
- Build script `scripts/build-catrender-wasm.*`, mirroring the existing wasm
  build script; `wasm-bindgen` output → `src/lib/.../catrender-wasm-pkg/`.
- Vite already configured for wasm (same as chgdiff); no config change.

## Testing strategy

- Rust unit tests: rotation/projection matrix, depth-sort ordering, bond
  merge (add/remove/setorder + atom-deletion invalidation), each preset emits
  non-empty well-formed SVG.
- Frontend: `merge_bonds` override logic unit tests; pane mirror + debounce
  behaviour.
- Integration: `pending → result` bridge round-trip; MCP tool returns a valid
  saved file path.

## Risks / Open Items

- Preset fidelity: matching xyzrender's look depends on faithfully porting its
  numeric constants. Mitigation: port constants verbatim, visual-diff a small
  reference set against xyzrender output.
- PNG rasterization of `{@html svg}` must capture external gradients/filters;
  validate `svg → canvas → toBlob` retains radial gradients and blur.
- Crystal-package PBC wrap: clarify whether wrap operates on fractional coords
  before projection (assumed yes) for non-orthogonal cells.

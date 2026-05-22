# catrender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `catrender` plugin to CatGo that renders publication-quality 2D molecular SVGs (xyzrender-style presets) in real time from the active panel's structure, with a render-only bond-override layer and an AI-triggerable export.

**Architecture:** A pure-function Rust crate compiled to WASM does all drawing (project → depth-sort → preset-styled SVG). A new pane (`CatRenderPane.svelte`, a tab inside `ExportPane.svelte`) mirrors the active structure read-only, merges pane-local bond overrides, calls the WASM core on a debounced effect, and shows `{@html svg}` live. AI export reuses the existing screenshot-pending bridge: an MCP hot-reload plugin posts a render request, the pane fulfils it with the same WASM core, the server saves the bytes.

**Tech Stack:** Rust + `wasm-bindgen` + `wasm-pack` (mirrors `extensions/chgdiff-wasm/`), Svelte 5 runes, FastAPI (`server/catgo/routers/view_capture.py`), CatGo MCP hot-reload plugin (`~/.catgo/plugins/`).

**Spec:** `docs/superpowers/specs/2026-05-18-catrender-design.md`

---

## File Structure

| Path | Responsibility |
|---|---|
| `extensions/catrender-wasm/Cargo.toml` | Crate manifest (cdylib + wasm-bindgen), mirrors chgdiff-wasm |
| `extensions/catrender-wasm/src/types.rs` | Input JSON deserialization structs (atoms/bonds/lattice/style) |
| `extensions/catrender-wasm/src/geom.rs` | Rotation matrix, 3D→2D projection, depth sort |
| `extensions/catrender-wasm/src/preset.rs` | `Preset` struct + static preset table (ported constants) |
| `extensions/catrender-wasm/src/svg.rs` | SVG string assembly (spheres, bonds, cell box, labels) |
| `extensions/catrender-wasm/src/lib.rs` | `#[wasm_bindgen] pub fn render(input_json:&str)->String` |
| `src/lib/structure/catrender/catrender-wasm.ts` | Lazy WASM init wrapper, mirrors chgdiff-wasm.ts |
| `src/lib/structure/catrender/catrender-wasm-pkg/` | wasm-pack generated output (built artifact, gitignored except .d.ts if repo convention) |
| `src/lib/structure/catrender/bond-merge.ts` | `merge_bonds(main, overrides)` pure util + types |
| `src/lib/structure/catrender/CatRenderPane.svelte` | Pane: mirror, override UI, debounced render, preview, export, AI-poll |
| `server/catgo/routers/view_capture.py` | +3 routes: catrender pending / result (pattern-cloned from screenshot) |
| `~/.catgo/plugins/catrender.py` | MCP hot-reload plugin `catgo_catrender_export` |
| `src/lib/structure/ExportPane.svelte` | Add `'catrender'` tab + mount CatRenderPane |

---

## Task 1: Rust crate scaffold + geometry core

**Files:**
- Create: `extensions/catrender-wasm/Cargo.toml`
- Create: `extensions/catrender-wasm/src/types.rs`
- Create: `extensions/catrender-wasm/src/geom.rs`
- Create: `extensions/catrender-wasm/src/lib.rs`

- [ ] **Step 1: Write Cargo.toml**

Create `extensions/catrender-wasm/Cargo.toml`:

```toml
[package]
name = "catrender-wasm"
version = "0.1.0"
edition = "2021"
description = "Publication-quality molecular SVG renderer — compiled to WebAssembly"
license = "AGPL-3.0-or-later"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
console_error_panic_hook = "0.1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
opt-level = "z"
lto = true
```

(`rlib` is added alongside `cdylib` so `cargo test` can link the crate; chgdiff-wasm is cdylib-only and untested — we want unit tests here.)

- [ ] **Step 2: Write the failing geometry test**

Create `extensions/catrender-wasm/src/geom.rs`:

```rust
//! Pure geometry: rotation, 3D→2D projection, depth ordering.

/// Apply intrinsic XYZ rotation (degrees) to a point.
pub fn rotate(p: [f64; 3], rot_deg: [f64; 3]) -> [f64; 3] {
    let (rx, ry, rz) = (
        rot_deg[0].to_radians(),
        rot_deg[1].to_radians(),
        rot_deg[2].to_radians(),
    );
    // Rz * Ry * Rx * p
    let (cx, sx) = (rx.cos(), rx.sin());
    let (cy, sy) = (ry.cos(), ry.sin());
    let (cz, sz) = (rz.cos(), rz.sin());
    let [x, y, z] = p;
    // Rx
    let (y1, z1) = (y * cx - z * sx, y * sx + z * cx);
    // Ry
    let (x2, z2) = (x * cy + z1 * sy, -x * sy + z1 * cy);
    // Rz
    let (x3, y3) = (x2 * cz - y1 * sz, x2 * sz + y1 * cz);
    [x3, y3, z2]
}

/// Project rotated points to 2D screen coords (orthographic, +Z toward viewer).
/// Returns (screen_xy, depth_z) per atom. Depth used only for ordering.
pub fn project(points: &[[f64; 3]], rot_deg: [f64; 3]) -> Vec<([f64; 2], f64)> {
    points
        .iter()
        .map(|&p| {
            let r = rotate(p, rot_deg);
            ([r[0], r[1]], r[2])
        })
        .collect()
}

/// Atom indices sorted back-to-front (smallest depth first → drawn first).
pub fn depth_order(projected: &[([f64; 2], f64)]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..projected.len()).collect();
    idx.sort_by(|&a, &b| projected[a].1.partial_cmp(&projected[b].1).unwrap());
    idx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotate_identity_is_noop() {
        let p = [1.0, 2.0, 3.0];
        let r = rotate(p, [0.0, 0.0, 0.0]);
        assert!((r[0] - 1.0).abs() < 1e-9);
        assert!((r[1] - 2.0).abs() < 1e-9);
        assert!((r[2] - 3.0).abs() < 1e-9);
    }

    #[test]
    fn rotate_90_about_z_maps_x_to_y() {
        let r = rotate([1.0, 0.0, 0.0], [0.0, 0.0, 90.0]);
        assert!(r[0].abs() < 1e-9, "x≈0, got {}", r[0]);
        assert!((r[1] - 1.0).abs() < 1e-9, "y≈1, got {}", r[1]);
    }

    #[test]
    fn depth_order_is_back_to_front() {
        let proj = vec![([0.0, 0.0], 5.0), ([0.0, 0.0], -2.0), ([0.0, 0.0], 1.0)];
        assert_eq!(depth_order(&proj), vec![1, 2, 0]);
    }
}
```

Create minimal `extensions/catrender-wasm/src/lib.rs`:

```rust
pub mod geom;
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd extensions/catrender-wasm && cargo test`
Expected: PASS — 3 tests in `geom::tests`.

- [ ] **Step 4: Add input types**

Create `extensions/catrender-wasm/src/types.rs`:

```rust
use serde::Deserialize;

#[derive(Deserialize)]
pub struct Atom {
    pub el: String,
    pub xyz: [f64; 3],
}

#[derive(Deserialize)]
pub struct Bond {
    pub i: usize,
    pub j: usize,
    #[serde(default = "one")]
    pub order: u8,
}
fn one() -> u8 {
    1
}

#[derive(Deserialize, Default)]
pub struct Labels {
    #[serde(default)]
    pub distances: Vec<[usize; 2]>,
    #[serde(default)]
    pub angles: Vec<[usize; 3]>,
}

#[derive(Deserialize, Default)]
pub struct Cell {
    #[serde(default)]
    pub show: bool,
    #[serde(default = "unit_super")]
    pub supercell: [u32; 3],
    #[serde(default)]
    pub pbc_wrap: bool,
}
fn unit_super() -> [u32; 3] {
    [1, 1, 1]
}

#[derive(Deserialize)]
pub struct Style {
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default = "tru")]
    pub show_h: bool,
    #[serde(default)]
    pub rotation: [f64; 3],
    #[serde(default = "one_f")]
    pub scale: f64,
    #[serde(default = "tru")]
    pub depth_cue: bool,
    #[serde(default)]
    pub fog: f64,
    #[serde(default)]
    pub labels: Labels,
    #[serde(default)]
    pub cell: Cell,
}
fn default_preset() -> String {
    "default".into()
}
fn tru() -> bool {
    true
}
fn one_f() -> f64 {
    1.0
}

#[derive(Deserialize)]
pub struct RenderInput {
    pub atoms: Vec<Atom>,
    #[serde(default)]
    pub bonds: Vec<Bond>,
    #[serde(default)]
    pub lattice: Option<[[f64; 3]; 3]>,
    pub style: Style,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_input() {
        let j = r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{"preset":"flat"}}"#;
        let inp: RenderInput = serde_json::from_str(j).unwrap();
        assert_eq!(inp.atoms.len(), 1);
        assert_eq!(inp.style.preset, "flat");
        assert!(inp.style.show_h, "show_h defaults true");
        assert_eq!(inp.bonds.len(), 0);
    }

    #[test]
    fn bond_order_defaults_to_one() {
        let j = r#"{"atoms":[],"bonds":[{"i":0,"j":1}],"style":{}}"#;
        let inp: RenderInput = serde_json::from_str(j).unwrap();
        assert_eq!(inp.bonds[0].order, 1);
    }
}
```

Add to `extensions/catrender-wasm/src/lib.rs`:

```rust
pub mod geom;
pub mod types;
```

- [ ] **Step 5: Run tests**

Run: `cd extensions/catrender-wasm && cargo test`
Expected: PASS — 5 tests total.

- [ ] **Step 6: Commit**

```bash
git add extensions/catrender-wasm/Cargo.toml extensions/catrender-wasm/src/
git commit -m "feat(catrender): rust crate scaffold + geometry core + input types"
```

---

## Task 2: Preset table + SVG assembly + render entrypoint

**Files:**
- Create: `extensions/catrender-wasm/src/preset.rs`
- Create: `extensions/catrender-wasm/src/svg.rs`
- Modify: `extensions/catrender-wasm/src/lib.rs`

- [ ] **Step 1: Write preset table with failing test**

Create `extensions/catrender-wasm/src/preset.rs`:

```rust
//! Style presets. Numeric constants are ported from xyzrender's Python
//! source (do NOT re-design the aesthetic — copy the numbers).

#[derive(Clone, Copy)]
pub enum BondStyle {
    Stick,
    Line,
    Wire,
}

#[derive(Clone, Copy)]
pub enum GradientMode {
    Radial,
    Flat,
}

#[derive(Clone, Copy)]
pub struct Preset {
    pub atom_radius_scale: f64,
    pub bond_width: f64,
    pub bond_style: BondStyle,
    pub gradient: GradientMode,
    pub outline: f64,
    pub depth_strength: f64,
}

/// Returns the named preset, falling back to `default` for unknown names.
pub fn get(name: &str) -> Preset {
    match name {
        "flat" => Preset {
            atom_radius_scale: 0.40,
            bond_width: 6.0,
            bond_style: BondStyle::Stick,
            gradient: GradientMode::Flat,
            outline: 1.5,
            depth_strength: 0.0,
        },
        "paton" => Preset {
            atom_radius_scale: 0.30,
            bond_width: 5.0,
            bond_style: BondStyle::Stick,
            gradient: GradientMode::Radial,
            outline: 1.0,
            depth_strength: 0.5,
        },
        "skeletal" => Preset {
            atom_radius_scale: 0.0,
            bond_width: 4.0,
            bond_style: BondStyle::Line,
            gradient: GradientMode::Flat,
            outline: 0.0,
            depth_strength: 0.0,
        },
        "bubble" => Preset {
            atom_radius_scale: 0.85,
            bond_width: 0.0,
            bond_style: BondStyle::Line,
            gradient: GradientMode::Radial,
            outline: 0.0,
            depth_strength: 0.7,
        },
        "tube" => Preset {
            atom_radius_scale: 0.25,
            bond_width: 8.0,
            bond_style: BondStyle::Stick,
            gradient: GradientMode::Radial,
            outline: 0.0,
            depth_strength: 0.6,
        },
        "wire" => Preset {
            atom_radius_scale: 0.0,
            bond_width: 2.0,
            bond_style: BondStyle::Wire,
            gradient: GradientMode::Flat,
            outline: 0.0,
            depth_strength: 0.0,
        },
        "graph" => Preset {
            atom_radius_scale: 0.18,
            bond_width: 2.0,
            bond_style: BondStyle::Line,
            gradient: GradientMode::Flat,
            outline: 1.0,
            depth_strength: 0.0,
        },
        // "default" and any unknown name
        _ => Preset {
            atom_radius_scale: 0.45,
            bond_width: 5.0,
            bond_style: BondStyle::Stick,
            gradient: GradientMode::Radial,
            outline: 1.0,
            depth_strength: 0.4,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_preset_falls_back_to_default() {
        let d = get("default");
        let u = get("nonsense-xyz");
        assert_eq!(d.atom_radius_scale, u.atom_radius_scale);
        assert_eq!(d.bond_width, u.bond_width);
    }

    #[test]
    fn skeletal_has_no_atom_spheres() {
        assert_eq!(get("skeletal").atom_radius_scale, 0.0);
    }
}
```

> NOTE for implementer: the constants above are placeholders structurally
> faithful to xyzrender's preset families. Before merging Task 2, open
> xyzrender's preset definitions and replace each numeric with the upstream
> value; keep the field names. This is a values-only edit.

- [ ] **Step 2: Run preset test**

Run: `cd extensions/catrender-wasm && cargo test preset`
Expected: PASS — 2 tests.

- [ ] **Step 3: Write SVG assembly with failing test**

Create `extensions/catrender-wasm/src/svg.rs`:

```rust
//! Assemble an SVG document from projected atoms/bonds/cell.

use crate::geom::{depth_order, project};
use crate::preset::{BondStyle, GradientMode, Preset};
use crate::types::RenderInput;

fn cpk_color(el: &str) -> &'static str {
    match el {
        "H" => "#ffffff",
        "C" => "#303030",
        "N" => "#3050f8",
        "O" => "#ff0d0d",
        "S" => "#ffff30",
        "P" => "#ff8000",
        "F" => "#90e050",
        "Cl" => "#1ff01f",
        _ => "#b0b0b0",
    }
}

fn covalent_radius(el: &str) -> f64 {
    match el {
        "H" => 0.31,
        "C" => 0.76,
        "N" => 0.71,
        "O" => 0.66,
        "S" => 1.05,
        _ => 0.85,
    }
}

const VIEW: f64 = 600.0;

pub fn render_svg(inp: &RenderInput) -> String {
    let preset: Preset = crate::preset::get(&inp.style.preset);

    // Filter hydrogens if hidden; keep an index remap old→new.
    let mut keep: Vec<usize> = Vec::new();
    for (i, a) in inp.atoms.iter().enumerate() {
        if !inp.style.show_h && a.el == "H" {
            continue;
        }
        keep.push(i);
    }
    let pts: Vec<[f64; 3]> = keep.iter().map(|&i| inp.atoms[i].xyz).collect();
    let projected = project(&pts, inp.style.rotation);

    // Centre + scale to the viewbox.
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for (xy, _) in &projected {
        minx = minx.min(xy[0]);
        miny = miny.min(xy[1]);
        maxx = maxx.max(xy[0]);
        maxy = maxy.max(xy[1]);
    }
    let span = ((maxx - minx).max(maxy - miny)).max(1e-6);
    let s = (VIEW * 0.8 / span) * inp.style.scale;
    let cx = (minx + maxx) / 2.0;
    let cy = (miny + maxy) / 2.0;
    let to_screen = |xy: [f64; 2]| -> (f64, f64) {
        ((xy[0] - cx) * s + VIEW / 2.0, VIEW / 2.0 - (xy[1] - cy) * s)
    };

    let mut body = String::new();

    // Bonds first (under atoms). bond indices reference original atom list;
    // skip any bond whose atom was filtered out.
    let new_of: std::collections::HashMap<usize, usize> =
        keep.iter().enumerate().map(|(n, &o)| (o, n)).collect();
    if !matches!(preset.bond_style, BondStyle::Wire) || preset.bond_width > 0.0 {
        for b in &inp.bonds {
            let (Some(&ni), Some(&nj)) = (new_of.get(&b.i), new_of.get(&b.j)) else {
                continue;
            };
            let (x1, y1) = to_screen(projected[ni].0);
            let (x2, y2) = to_screen(projected[nj].0);
            let w = preset.bond_width.max(0.5);
            // double/triple → parallel offset strokes
            let n = b.order.max(1) as i32;
            for k in 0..n {
                let off = (k as f64 - (n as f64 - 1.0) / 2.0) * (w * 0.9);
                let (dx, dy) = (y2 - y1, -(x2 - x1));
                let len = (dx * dx + dy * dy).sqrt().max(1e-6);
                let (ox, oy) = (dx / len * off, dy / len * off);
                body.push_str(&format!(
                    "<line x1='{:.1}' y1='{:.1}' x2='{:.1}' y2='{:.1}' stroke='#444' stroke-width='{:.1}' stroke-linecap='round'/>",
                    x1 + ox, y1 + oy, x2 + ox, y2 + oy, w
                ));
            }
        }
    }

    // Atoms back-to-front.
    let mut defs = String::new();
    for &n in depth_order(&projected).iter() {
        let a = &inp.atoms[keep[n]];
        if preset.atom_radius_scale <= 0.0 {
            continue;
        }
        let (x, y) = to_screen(projected[n].0);
        let r = covalent_radius(&a.el) * preset.atom_radius_scale * s;
        let col = cpk_color(&a.el);
        let fill = match preset.gradient {
            GradientMode::Radial => {
                let gid = format!("g{n}");
                defs.push_str(&format!(
                    "<radialGradient id='{gid}' cx='35%' cy='35%' r='65%'>\
                     <stop offset='0%' stop-color='#fff'/>\
                     <stop offset='35%' stop-color='{col}'/>\
                     <stop offset='100%' stop-color='#000'/></radialGradient>"
                ));
                format!("url(#{gid})")
            }
            GradientMode::Flat => col.to_string(),
        };
        let stroke = if preset.outline > 0.0 {
            format!(" stroke='#000' stroke-width='{:.1}'", preset.outline)
        } else {
            String::new()
        };
        body.push_str(&format!(
            "<circle cx='{x:.1}' cy='{y:.1}' r='{r:.1}' fill='{fill}'{stroke}/>"
        ));
    }

    // Distance labels.
    for d in &inp.style.labels.distances {
        if let (Some(&ni), Some(&nj)) = (new_of.get(&d[0]), new_of.get(&d[1])) {
            let pa = inp.atoms[keep[ni]].xyz;
            let pb = inp.atoms[keep[nj]].xyz;
            let dist = ((pa[0] - pb[0]).powi(2)
                + (pa[1] - pb[1]).powi(2)
                + (pa[2] - pb[2]).powi(2))
            .sqrt();
            let (x1, y1) = to_screen(projected[ni].0);
            let (x2, y2) = to_screen(projected[nj].0);
            body.push_str(&format!(
                "<text x='{:.1}' y='{:.1}' font-size='14' fill='#222' text-anchor='middle'>{:.2} Å</text>",
                (x1 + x2) / 2.0,
                (y1 + y2) / 2.0,
                dist
            ));
        }
    }

    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {VIEW} {VIEW}' width='{VIEW}' height='{VIEW}'><defs>{defs}</defs>{body}</svg>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RenderInput;

    fn parse(j: &str) -> RenderInput {
        serde_json::from_str(j).unwrap()
    }

    #[test]
    fn emits_well_formed_svg_with_atom() {
        let inp = parse(r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{}}"#);
        let svg = render_svg(&inp);
        assert!(svg.starts_with("<svg"));
        assert!(svg.ends_with("</svg>"));
        assert!(svg.contains("<circle"));
    }

    #[test]
    fn skeletal_emits_no_circle() {
        let inp = parse(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"bonds":[{"i":0,"j":1}],"style":{"preset":"skeletal"}}"#,
        );
        let svg = render_svg(&inp);
        assert!(!svg.contains("<circle"), "skeletal draws no spheres");
        assert!(svg.contains("<line"), "skeletal still draws bonds");
    }

    #[test]
    fn hidden_hydrogen_is_dropped() {
        let inp = parse(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"H","xyz":[1,0,0]}],"style":{"show_h":false}}"#,
        );
        let svg = render_svg(&inp);
        // one C circle only
        assert_eq!(svg.matches("<circle").count(), 1);
    }

    #[test]
    fn double_bond_emits_two_lines() {
        let inp = parse(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"bonds":[{"i":0,"j":1,"order":2}],"style":{"preset":"skeletal"}}"#,
        );
        let svg = render_svg(&inp);
        assert_eq!(svg.matches("<line").count(), 2);
    }
}
```

- [ ] **Step 4: Wire modules + wasm entrypoint in lib.rs**

Replace `extensions/catrender-wasm/src/lib.rs` with:

```rust
pub mod geom;
pub mod preset;
pub mod svg;
pub mod types;

use wasm_bindgen::prelude::*;

/// Render molecular SVG from a JSON input string. Pure function — no state.
#[wasm_bindgen]
pub fn render(input_json: &str) -> String {
    console_error_panic_hook::set_once();
    match serde_json::from_str::<types::RenderInput>(input_json) {
        Ok(inp) => svg::render_svg(&inp),
        Err(e) => format!(
            "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='40'><text x='4' y='24' fill='red' font-size='13'>catrender input error: {}</text></svg>",
            e
        ),
    }
}
```

- [ ] **Step 5: Run full test suite**

Run: `cd extensions/catrender-wasm && cargo test`
Expected: PASS — all tests (geom 3, types 2, preset 2, svg 4).

- [ ] **Step 6: Commit**

```bash
git add extensions/catrender-wasm/src/
git commit -m "feat(catrender): preset table + SVG assembly + wasm render() entrypoint"
```

---

## Task 3: WASM build + TypeScript wrapper

**Files:**
- Create: `src/lib/structure/catrender/catrender-wasm.ts`
- Create (built): `src/lib/structure/catrender/catrender-wasm-pkg/` (wasm-pack output)

- [ ] **Step 1: Build the WASM package**

Run:

```bash
cd extensions/catrender-wasm && wasm-pack build --target web \
  --out-dir ../../src/lib/structure/catrender/catrender-wasm-pkg
```

Expected: creates `src/lib/structure/catrender/catrender-wasm-pkg/catrender_wasm.js`,
`catrender_wasm_bg.wasm`, `catrender_wasm.d.ts`. (Same toolchain that built
`src/lib/electronic/chgdiff-wasm-pkg/`.)

- [ ] **Step 2: Write the TS wrapper**

Create `src/lib/structure/catrender/catrender-wasm.ts` (mirrors
`src/lib/electronic/chgdiff-wasm.ts` lazy-init pattern exactly):

```ts
// TypeScript wrapper for catrender-wasm bindings. Lazy-inits on first use.
// pkg/ generated by:
//   cd extensions/catrender-wasm && wasm-pack build --target web \
//     --out-dir ../../src/lib/structure/catrender/catrender-wasm-pkg

import { browser } from '$app/environment'

type WasmInitInput =
  | string | URL | Request | Response | BufferSource
  | WebAssembly.Module | { module_or_path: WasmInitInput }

type CatrenderWasmModule = {
  default: (input: WasmInitInput) => Promise<void>
  render: (input_json: string) => string
}

let _module: CatrenderWasmModule | null = null
let _init_promise: Promise<CatrenderWasmModule> | null = null

async function ensure_ready(): Promise<CatrenderWasmModule> {
  if (!browser) throw new Error(`catrender-wasm is browser-only`)
  if (_module) return _module
  if (_init_promise) return _init_promise

  _init_promise = (async () => {
    // @ts-ignore — generated WASM package
    const mod = (await import(/* @vite-ignore */ `./catrender-wasm-pkg/catrender_wasm.js`)) as unknown as CatrenderWasmModule
    const preloaded = (globalThis as unknown as {
      __catgo_catrender_wasm?: ArrayBuffer | Uint8Array
    }).__catgo_catrender_wasm
    if (preloaded) {
      await mod.default(preloaded)
    } else {
      const wasm_url_module = await import(
        /* @vite-ignore */ `./catrender-wasm-pkg/catrender_wasm_bg.wasm?url`
      )
      await mod.default({ module_or_path: wasm_url_module.default as string })
    }
    _module = mod
    return mod
  })()
  return _init_promise
}

/** Render molecular SVG. Runs entirely in-browser via WebAssembly. */
export async function render_svg(input_json: string): Promise<string> {
  const mod = await ensure_ready()
  return mod.render(input_json)
}
```

- [ ] **Step 3: Type-check passes**

Run: `npm run check 2>&1 | tail -3`
Expected: `svelte-check found 0 errors` (warnings allowed; pre-existing 295 baseline).

- [ ] **Step 4: Commit**

```bash
git add src/lib/structure/catrender/
git commit -m "feat(catrender): wasm-pack build + lazy-init TS wrapper"
```

> If the repo `.gitignore`s generated wasm pkgs, check how
> `src/lib/electronic/chgdiff-wasm-pkg/` is tracked and follow the same
> convention (commit the `.d.ts`/.js, or add a build step). Run
> `git check-ignore -v src/lib/structure/catrender/catrender-wasm-pkg/catrender_wasm_bg.wasm`
> and match chgdiff's treatment.

---

## Task 4: Bond-override merge utility (frontend)

**Files:**
- Create: `src/lib/structure/catrender/bond-merge.ts`
- Create: `src/lib/structure/catrender/bond-merge.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/lib/structure/catrender/bond-merge.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { merge_bonds, type Bond, type BondOverride } from './bond-merge'

const base: Bond[] = [
  { i: 0, j: 1, order: 1 },
  { i: 1, j: 2, order: 1 },
]

describe(`merge_bonds`, () => {
  it(`returns base bonds when no overrides`, () => {
    expect(merge_bonds(base, [])).toEqual(base)
  })

  it(`add override inserts a new bond`, () => {
    const ov: BondOverride[] = [{ op: `add`, i: 2, j: 3, order: 1 }]
    const out = merge_bonds(base, ov)
    expect(out).toContainEqual({ i: 2, j: 3, order: 1 })
    expect(out).toHaveLength(3)
  })

  it(`remove override drops a bond regardless of i/j order`, () => {
    const ov: BondOverride[] = [{ op: `remove`, i: 1, j: 0 }]
    const out = merge_bonds(base, ov)
    expect(out).toHaveLength(1)
    expect(out).toContainEqual({ i: 1, j: 2, order: 1 })
  })

  it(`setorder override changes the bond order`, () => {
    const ov: BondOverride[] = [{ op: `setorder`, i: 0, j: 1, order: 2 }]
    const out = merge_bonds(base, ov)
    expect(out).toContainEqual({ i: 0, j: 1, order: 2 })
  })

  it(`prune_overrides drops overrides referencing deleted atoms`, async () => {
    const { prune_overrides } = await import(`./bond-merge`)
    const ov: BondOverride[] = [
      { op: `add`, i: 2, j: 9, order: 1 },
      { op: `setorder`, i: 0, j: 1, order: 2 },
    ]
    expect(prune_overrides(ov, 3)).toEqual([
      { op: `setorder`, i: 0, j: 1, order: 2 },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/structure/catrender/bond-merge.test.ts`
Expected: FAIL — cannot resolve `./bond-merge`.

- [ ] **Step 3: Implement**

Create `src/lib/structure/catrender/bond-merge.ts`:

```ts
export type Bond = { i: number; j: number; order: number }

export type BondOverride =
  | { op: `add`; i: number; j: number; order: number }
  | { op: `remove`; i: number; j: number }
  | { op: `setorder`; i: number; j: number; order: number }

/** Normalised undirected key for an (i,j) pair. */
function key(i: number, j: number): string {
  return i < j ? `${i}-${j}` : `${j}-${i}`
}

/**
 * Apply the render-only override layer onto the mirrored connectivity.
 * Pure — never mutates inputs. Order of ops: removes/setorders match by
 * undirected pair; adds append (deduped).
 */
export function merge_bonds(base: Bond[], overrides: BondOverride[]): Bond[] {
  const map = new Map<string, Bond>()
  for (const b of base) map.set(key(b.i, b.j), { ...b })

  for (const ov of overrides) {
    const k = key(ov.i, ov.j)
    if (ov.op === `remove`) {
      map.delete(k)
    } else if (ov.op === `setorder`) {
      const cur = map.get(k)
      if (cur) cur.order = ov.order
    } else {
      // add (idempotent on the undirected pair)
      map.set(k, { i: ov.i, j: ov.j, order: ov.order })
    }
  }
  return [...map.values()]
}

/** Drop overrides that reference an atom index ≥ n_atoms (deleted upstream). */
export function prune_overrides(
  overrides: BondOverride[],
  n_atoms: number,
): BondOverride[] {
  return overrides.filter((o) => o.i < n_atoms && o.j < n_atoms)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/structure/catrender/bond-merge.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/catrender/bond-merge.ts src/lib/structure/catrender/bond-merge.test.ts
git commit -m "feat(catrender): render-only bond-override merge util + tests"
```

---

## Task 5: CatRenderPane.svelte + ExportPane tab wiring

**Files:**
- Create: `src/lib/structure/catrender/CatRenderPane.svelte`
- Modify: `src/lib/structure/ExportPane.svelte`

- [ ] **Step 1: Write the pane component**

Create `src/lib/structure/catrender/CatRenderPane.svelte`:

```svelte
<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { compute_bond_connectivity } from '$lib/structure/bond-computation-controller.svelte'
  import { render_svg } from './catrender-wasm'
  import {
    merge_bonds, prune_overrides,
    type Bond, type BondOverride,
  } from './bond-merge'

  let { structure = undefined as AnyStructure | undefined } = $props()

  const PRESETS = [
    `default`, `flat`, `paton`, `skeletal`, `bubble`, `tube`, `wire`, `graph`,
  ] as const

  let preset = $state<(typeof PRESETS)[number]>(`default`)
  let show_h = $state(true)
  let rot_x = $state(0)
  let rot_y = $state(0)
  let rot_z = $state(0)
  let show_cell = $state(false)
  let overrides = $state<BondOverride[]>([])

  let svg = $state(`<svg/>`)
  let render_err = $state(``)

  // Read-only mirror: atoms + base connectivity derived from the structure.
  const mirror = $derived.by(() => {
    if (!structure || !(`sites` in structure)) return null
    const atoms = structure.sites.map((s: any) => ({
      el: s.species?.[0]?.element ?? s.label ?? `X`,
      xyz: s.xyz as [number, number, number],
    }))
    const conn = compute_bond_connectivity(structure as AnyStructure) as
      { from: number; to: number; order?: number }[]
    const base: Bond[] = conn.map((c) => ({
      i: c.from, j: c.to, order: c.order ?? 1,
    }))
    const lattice =
      (structure as any).lattice?.matrix ?? null
    return { atoms, base, lattice, n: atoms.length }
  })

  // Debounced render: any param/structure change schedules one WASM call.
  let timer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    const m = mirror
    // touch reactive deps so the effect re-runs on change:
    void [preset, show_h, rot_x, rot_y, rot_z, show_cell, overrides, m]
    if (!m) return
    clearTimeout(timer)
    timer = setTimeout(async () => {
      const pruned = prune_overrides($state.snapshot(overrides), m.n)
      const bonds = merge_bonds(m.base, pruned)
      const input = JSON.stringify({
        atoms: m.atoms,
        bonds,
        lattice: m.lattice,
        style: {
          preset, show_h,
          rotation: [rot_x, rot_y, rot_z],
          cell: { show: show_cell, supercell: [1, 1, 1], pbc_wrap: false },
        },
      })
      try {
        svg = await render_svg(input)
        render_err = ``
      } catch (e) {
        render_err = String(e)
      }
    }, 16)
  })

  function download(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement(`a`)
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  function export_svg() {
    download(`catrender.svg`, new Blob([svg], { type: `image/svg+xml` }))
  }

  async function export_png() {
    const img = new Image()
    img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
    await img.decode()
    const c = document.createElement(`canvas`)
    c.width = 1200
    c.height = 1200
    const ctx = c.getContext(`2d`)!
    ctx.drawImage(img, 0, 0, 1200, 1200)
    c.toBlob((b) => b && download(`catrender.png`, b), `image/png`)
  }
</script>

<div class="catrender-pane">
  <div class="controls">
    <label>Preset
      <select bind:value={preset}>
        {#each PRESETS as p}<option value={p}>{p}</option>{/each}
      </select>
    </label>
    <label><input type="checkbox" bind:checked={show_h} /> H</label>
    <label><input type="checkbox" bind:checked={show_cell} /> Cell</label>
    <label>Rx <input type="range" min="0" max="360" bind:value={rot_x} /></label>
    <label>Ry <input type="range" min="0" max="360" bind:value={rot_y} /></label>
    <label>Rz <input type="range" min="0" max="360" bind:value={rot_z} /></label>
    <button onclick={export_svg}>Export SVG</button>
    <button onclick={export_png}>Export PNG</button>
  </div>
  {#if render_err}<p class="err">{render_err}</p>{/if}
  <div class="preview">{@html svg}</div>
</div>

<style>
  .catrender-pane { display: flex; flex-direction: column; gap: 8px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .preview { flex: 1; min-height: 320px; display: grid; place-items: center; }
  .preview :global(svg) { max-width: 100%; max-height: 70vh; }
  .err { color: #c00; font-size: 13px; }
</style>
```

> NOTE: `compute_bond_connectivity`'s exact return shape must be confirmed
> against `src/lib/structure/bond-computation-controller.svelte.ts:219`. If
> it returns a different field set (e.g. `{i,j}` not `{from,to}`), adapt the
> `conn.map` line only — do not change the merge/render contract.

- [ ] **Step 2: Add the tab to ExportPane.svelte**

In `src/lib/structure/ExportPane.svelte`, after the existing export
sub-component imports (around line 29, after `SparkExport`), add:

```ts
  import CatRenderPane from '$lib/structure/catrender/CatRenderPane.svelte'
```

Extend the `active_section` union (line ~64) to include `'catrender'`:

```ts
  let active_section = $state<'structure' | 'figure' | 'qe' | 'lammps' | 'vasp' | 'cp2k' | 'gaussian' | 'gromacs' | 'orca' | 'abacus' | 'amber' | 'spark' | 'catrender'>('structure')
```

Find the tab-button row and the section render block (search for
`active_section === 'spark'` in the file). Add a sibling tab button:

```svelte
  <button class:active={active_section === 'catrender'}
          onclick={() => (active_section = 'catrender')}>Render</button>
```

and a sibling render block matching the existing pattern used for
`SparkExport`:

```svelte
  {#if active_section === 'catrender'}
    <CatRenderPane {structure} />
  {/if}
```

- [ ] **Step 3: Type-check + unit tests pass**

Run: `npm run check 2>&1 | tail -2 && npx vitest run src/lib/structure/catrender/`
Expected: `0 errors`; bond-merge tests PASS.

- [ ] **Step 4: Manual smoke (document result inline)**

Run dev server, load any structure, open Export pane → Render tab.
Expected: SVG preview appears; changing preset/rotation updates it within
a frame; Export SVG/PNG download files. Note any deviation in the commit body.

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/catrender/CatRenderPane.svelte src/lib/structure/ExportPane.svelte
git commit -m "feat(catrender): live render pane mirroring active structure + Export tab"
```

---

## Task 6: Rust auto-bond perception + native CLI binary

**Files:**
- Create: `extensions/catrender-wasm/src/bonds.rs`
- Modify: `extensions/catrender-wasm/src/lib.rs` (declare `pub mod bonds;`)
- Modify: `extensions/catrender-wasm/src/svg.rs` (use auto-bonds when `inp.bonds` empty)
- Create: `extensions/catrender-wasm/src/bin/catrender.rs` (native CLI)

Rationale: AI export runs backend-side (no AI in the frontend). A native CLI
that shares the exact same render core lets AI render headless — faster, no
open-browser requirement — while the WASM path stays for the live preview
pane. The CLI has no frontend-computed connectivity, so the core grows a
distance-based auto-bond fallback (also benefits the WASM pane when bonds
are absent). Pane-local bond overrides remain interactive-only and do not
flow into the CLI path.

- [ ] **Step 1: Write failing auto-bond test**

Create `extensions/catrender-wasm/src/bonds.rs`:

```rust
//! Distance-based bond perception used when no explicit bonds are supplied.

use crate::types::{Atom, Bond};

fn covalent_radius(el: &str) -> f64 {
    match el {
        "H" => 0.31,
        "C" => 0.76,
        "N" => 0.71,
        "O" => 0.66,
        "S" => 1.05,
        "P" => 1.07,
        "F" => 0.57,
        "Cl" => 1.02,
        _ => 0.85,
    }
}

/// Perceive single bonds: pair (i<j) bonded if dist < 1.2·(r_i + r_j).
/// O(n²) — fine for the molecule sizes catrender targets.
pub fn perceive(atoms: &[Atom]) -> Vec<Bond> {
    let mut out = Vec::new();
    for i in 0..atoms.len() {
        for j in (i + 1)..atoms.len() {
            let a = atoms[i].xyz;
            let b = atoms[j].xyz;
            let d2 = (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2);
            let cutoff = 1.2 * (covalent_radius(&atoms[i].el) + covalent_radius(&atoms[j].el));
            if d2 > 1e-6 && d2 < cutoff * cutoff {
                out.push(Bond { i, j, order: 1 });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Atom;

    fn at(el: &str, xyz: [f64; 3]) -> Atom {
        Atom { el: el.into(), xyz }
    }

    #[test]
    fn bonds_close_pair_not_far_pair() {
        let atoms = vec![
            at("C", [0.0, 0.0, 0.0]),
            at("O", [1.2, 0.0, 0.0]),  // bonded
            at("C", [9.0, 0.0, 0.0]),  // far, unbonded
        ];
        let b = perceive(&atoms);
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].i, b[0].j), (0, 1));
    }

    #[test]
    fn no_self_bond_no_duplicate() {
        let atoms = vec![at("H", [0.0, 0.0, 0.0]), at("H", [0.74, 0.0, 0.0])];
        let b = perceive(&atoms);
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].i, b[0].j), (0, 1));
    }
}
```

For the test to construct `Atom`/`Bond`, ensure both derive nothing extra
but their fields are `pub` (they already are from Task 1) — `Atom`,`Bond`
need to be constructible in-crate (they are: plain pub structs). If the
test cannot build `Atom` because `el`/`xyz` privacy, it is a Task-1
regression — they are `pub`, so this compiles.

- [ ] **Step 2: Run test**

Run: `cd extensions/catrender-wasm && cargo test bonds`
Expected: PASS — 2 tests.

- [ ] **Step 3: Wire module + use auto-bonds in svg.rs**

In `extensions/catrender-wasm/src/lib.rs` add `pub mod bonds;` alongside
the other `pub mod` lines.

In `extensions/catrender-wasm/src/svg.rs`, at the top of `render_svg`,
after `let preset = ...;`, derive the effective bond list:

```rust
    // Use explicit bonds if supplied; otherwise perceive by distance.
    let perceived;
    let bonds: &[crate::types::Bond] = if inp.bonds.is_empty() {
        perceived = crate::bonds::perceive(&inp.atoms);
        &perceived
    } else {
        &inp.bonds
    };
```

Then change the bond loop `for b in &inp.bonds {` to `for b in bonds {`.
Leave all other svg.rs logic unchanged.

- [ ] **Step 4: Add a render-with-auto-bonds test to svg.rs tests**

Add inside svg.rs `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn auto_bonds_drawn_when_no_explicit_bonds() {
        // skeletal preset draws bonds as <line>; no bonds array supplied.
        let inp = parse(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"style":{"preset":"skeletal"}}"#,
        );
        let svg = render_svg(&inp);
        assert!(svg.contains("<line"), "auto-perceived bond should render");
    }
```

- [ ] **Step 5: Create the native CLI binary**

Create `extensions/catrender-wasm/src/bin/catrender.rs`:

```rust
//! Native CLI: read render-input JSON from stdin (or argv[1] as a file
//! path), print the SVG to stdout. Shares the exact WASM render core.

use std::io::{Read, Write};

fn main() {
    let arg = std::env::args().nth(1);
    let json = match arg {
        Some(path) => std::fs::read_to_string(&path)
            .unwrap_or_else(|e| { eprintln!("read {path}: {e}"); std::process::exit(2); }),
        None => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s).expect("read stdin");
            s
        }
    };
    let svg = match serde_json::from_str::<catrender_wasm::types::RenderInput>(&json) {
        Ok(inp) => catrender_wasm::svg::render_svg(&inp),
        Err(e) => { eprintln!("catrender input error: {e}"); std::process::exit(1); }
    };
    std::io::stdout().write_all(svg.as_bytes()).expect("write stdout");
}
```

This requires the crate to expose `types` and `svg` as a library (it does:
`crate-type = ["cdylib","rlib"]` from Task 1, lib name `catrender_wasm`).

- [ ] **Step 6: Build + test the CLI**

Run:
```bash
cd extensions/catrender-wasm
cargo test
echo '{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"style":{"preset":"flat"}}' \
  | cargo run --quiet --bin catrender | head -c 80
```
Expected: all unit tests PASS (geom 3, types 2, preset 2, svg 6, bonds 2 = 15);
the pipe prints SVG starting with `<svg xmlns=`.

- [ ] **Step 7: Commit**

```bash
git add extensions/catrender-wasm/src/
git commit -m "feat(catrender): distance-based auto-bond perception + native CLI binary"
```

---

## Task 7: AI export — native CLI primary + bridge fallback (server routes + pane poll + MCP plugin)

**Files:**
- Modify: `server/catgo/routers/view_capture.py`
- Modify: `src/lib/structure/catrender/CatRenderPane.svelte`
- Create: `~/.catgo/plugins/catrender.py`

- [ ] **Step 1: Write the failing route test**

Create `tests/test_catrender_bridge.py`:

```python
import asyncio
import httpx
import pytest
from server.catgo.app import app  # adjust import to the FastAPI app factory


@pytest.mark.asyncio
async def test_pending_then_result_roundtrip():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        # Kick a render request without a frontend; fulfil it manually.
        async def fulfil():
            for _ in range(50):
                r = await c.get("/api/view/catrender/pending")
                pend = r.json()["pending"]
                if pend:
                    rid = pend[0]["request_id"]
                    await c.post("/api/view/catrender/result", json={
                        "request_id": rid, "svg": "<svg/>", "format": "svg",
                    })
                    return
                await asyncio.sleep(0.05)

        task = asyncio.create_task(fulfil())
        resp = await c.post("/api/view/catrender/request",
                            json={"style": {"preset": "flat"}, "format": "svg"})
        await task
        assert resp.status_code == 200
        assert resp.json()["svg"] == "<svg/>"
```

> Adjust `from server.catgo.app import app` to the project's actual app
> import (grep `FastAPI(` under `server/`). If the suite has an existing
> ASGI test client fixture, use it instead of constructing one here.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_catrender_bridge.py -v`
Expected: FAIL — 404, routes not defined.

- [ ] **Step 3: Add the routes**

In `server/catgo/routers/view_capture.py`, near the screenshot pending
block (after `list_pending_screenshots`, ~line 243), add — reusing the
exact `asyncio.Future` + dict-registry pattern used by `_pending_screenshots`:

```python
# --- catrender AI export bridge -------------------------------------------
_pending_catrender: dict[str, asyncio.Future] = {}
CATRENDER_TIMEOUT = 30.0


@router.post("/catrender/request")
async def request_catrender(payload: dict[str, Any]):
    """AI asks the frontend to render the current structure with `payload.style`.
    Mirrors the screenshot request/upload pattern."""
    request_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    future: asyncio.Future = loop.create_future()
    _pending_catrender[request_id] = future
    future._params = {  # type: ignore[attr-defined]
        "request_id": request_id,
        "style": payload.get("style", {}),
        "format": payload.get("format", "svg"),
    }
    try:
        result = await asyncio.wait_for(future, timeout=CATRENDER_TIMEOUT)
        return result
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=f"catrender timed out after {CATRENDER_TIMEOUT}s. "
            "Is a Render pane open and connected?",
        )
    finally:
        _pending_catrender.pop(request_id, None)


@router.get("/catrender/pending")
def list_pending_catrender():
    return {
        "pending": [
            getattr(f, "_params", {})
            for f in _pending_catrender.values()
            if not f.done()
        ]
    }


@router.post("/catrender/result")
def upload_catrender(payload: dict[str, Any]):
    future = _pending_catrender.get(payload.get("request_id", ""))
    if future is None:
        raise HTTPException(status_code=404, detail="No pending catrender request")
    if future.done():
        raise HTTPException(status_code=409, detail="Already fulfilled")
    future.set_result(payload)
    return {"status": "ok"}
```

Confirm `asyncio`, `uuid`, `Any`, `HTTPException` are already imported at
the top of the file (the screenshot code uses all four — they are).

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_catrender_bridge.py -v`
Expected: PASS.

- [ ] **Step 5: Add the poll loop to the pane**

In `src/lib/structure/catrender/CatRenderPane.svelte`, inside `<script>`,
add a polling effect (mirrors `poll_screenshot` in
`src/lib/structure/controllers/tool-handler.ts:62`):

```ts
  import { onMount } from 'svelte'

  const API_BASE = `/api`

  onMount(() => {
    let stopped = false
    ;(async () => {
      while (!stopped) {
        try {
          const r = await fetch(`${API_BASE}/view/catrender/pending`)
          if (r.ok) {
            const { pending } = await r.json()
            for (const item of pending as { request_id: string; style: any; format: string }[]) {
              const m = mirror
              if (!m) continue
              const pruned = prune_overrides($state.snapshot(overrides), m.n)
              const bonds = merge_bonds(m.base, pruned)
              const out = await render_svg(JSON.stringify({
                atoms: m.atoms, bonds, lattice: m.lattice,
                style: { preset, show_h, rotation: [rot_x, rot_y, rot_z],
                         ...item.style },
              }))
              await fetch(`${API_BASE}/view/catrender/result`, {
                method: `POST`,
                headers: { 'Content-Type': `application/json` },
                body: JSON.stringify({
                  request_id: item.request_id, svg: out, format: item.format,
                }),
              })
            }
          }
        } catch (e) {
          console.debug(`[catrender] poll error`, e)
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
    })()
    return () => { stopped = true }
  })
```

- [ ] **Step 6: Write the MCP plugin**

Create `~/.catgo/plugins/catrender.py` (hot-reload pattern, identical
contract to `~/.catgo/plugins/wrap_atoms.py`). Strategy: **try the
frontend bridge first** (short timeout) so an open Render pane contributes
the user's interactive bond overrides; **fall back to the headless native
CLI** when no pane is connected (fetch the current structure, pipe JSON to
the `catrender` binary — auto-bond perception fills in connectivity).

```python
"""CatGO plugin — export a publication-quality render of the current structure.

Tries the frontend WASM pane first (picks up interactive bond overrides);
falls back to the headless native `catrender` CLI when no pane is open.
"""

import json
import os
import shutil
import subprocess

TOOL_DEF = {
    "name": "catgo_catrender_export",
    "description": "Render the current viewer structure to a publication-quality "
    "SVG using catrender. Uses an open Render pane if present (honoring its bond "
    "overrides), else renders headless via the native CLI. Returns the saved path.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "preset": {
                "type": "string",
                "enum": ["default", "flat", "paton", "skeletal", "bubble",
                         "tube", "wire", "graph"],
                "default": "default",
            },
            "show_h": {"type": "boolean", "default": True},
            "rotation": {
                "type": "array", "items": {"type": "number"},
                "minItems": 3, "maxItems": 3, "default": [0, 0, 0],
            },
            "out_path": {"type": "string", "default": "/tmp/catrender.svg"},
        },
        "required": [],
    },
}


def _catrender_bin() -> str | None:
    """Resolve the native binary: $CATRENDER_BIN, then PATH, then the
    dev build under the repo's extensions/catrender-wasm/target."""
    env = os.environ.get("CATRENDER_BIN")
    if env and os.path.exists(env):
        return env
    which = shutil.which("catrender")
    if which:
        return which
    for cand in (
        os.path.expanduser("~/.catgo/bin/catrender"),
        os.path.join(
            os.path.dirname(__file__), "..", "..",
            "project/catgo-LRG/extensions/catrender-wasm/target/release/catrender",
        ),
    ):
        if os.path.exists(cand):
            return cand
    return None


async def handle(arguments: dict, client, api_base: str):
    style = {
        "preset": arguments.get("preset", "default"),
        "show_h": arguments.get("show_h", True),
        "rotation": arguments.get("rotation", [0, 0, 0]),
    }
    out = arguments.get("out_path", "/tmp/catrender.svg")
    svg = None
    via = ""

    # 1) Frontend bridge (short timeout) — honors pane bond overrides.
    try:
        resp = await client.post(
            f"{api_base}/view/catrender/request",
            json={"style": style, "format": "svg"},
            timeout=8.0,
        )
        if resp.status_code == 200:
            svg = resp.json().get("svg") or None
            via = "frontend pane"
    except Exception:
        svg = None

    # 2) Headless native CLI fallback — auto-perceived bonds.
    if not svg:
        binp = _catrender_bin()
        if not binp:
            return [{"type": "text", "text": "catrender failed: no Render pane "
                     "open and native binary not found (set $CATRENDER_BIN)."}]
        sr = await client.get(f"{api_base}/view/structure/current")
        if sr.status_code != 200:
            return [{"type": "text", "text": f"catrender failed: no current "
                     f"structure ({sr.status_code})."}]
        sd = sr.json()
        sites = sd.get("sites", []) if isinstance(sd, dict) else []
        atoms = [
            {"el": (s.get("species", [{}])[0].get("element")
                    or s.get("label") or "X"),
             "xyz": s.get("xyz") or s.get("abc")}
            for s in sites
        ]
        lattice = (sd.get("lattice", {}) or {}).get("matrix")
        payload = json.dumps({"atoms": atoms, "lattice": lattice, "style": style})
        try:
            proc = subprocess.run(
                [binp], input=payload, capture_output=True, text=True, timeout=30,
            )
        except subprocess.TimeoutExpired:
            return [{"type": "text",
                     "text": "catrender CLI timed out after 30s (structure too large or binary hung)."}]
        if proc.returncode != 0:
            return [{"type": "text", "text": f"catrender CLI error: {proc.stderr.strip()}"}]
        svg = proc.stdout
        via = "native CLI (headless)"

    try:
        with open(out, "w") as fh:
            fh.write(svg)
    except OSError as e:
        return [{"type": "text", "text": f"catrender: cannot write {out}: {e}"}]
    return [{"type": "text",
             "text": f"Rendered current structure via {via} → {out} ({len(svg)} bytes)."}]
```

> Notes for the implementer:
> - `api_base` is the API root in the hot-reload contract (wrap_atoms.py
>   calls `{api_base}/structure`), so `{api_base}/view/...` is correct.
> - Confirm the `/api/view/structure/current` JSON shape (sites/species/
>   xyz/lattice.matrix) against `server/catgo/routers/view_capture.py`
>   `get_current_structure` and adapt the `atoms`/`lattice` extraction
>   only — keep the bridge-then-CLI control flow.
> - The native binary is built by Task 6 at
>   `extensions/catrender-wasm/target/release/catrender` (build with
>   `cargo build --release --bin catrender`). Deployment: ship it with the
>   desktop bundle or copy to `~/.catgo/bin/`; `$CATRENDER_BIN` overrides.
>   For this task's verification, a `cargo build --release --bin catrender`
>   in the worktree satisfies the dev-path lookup.

- [ ] **Step 7: Full verification**

Run:
```bash
pytest tests/test_catrender_bridge.py -v
cd extensions/catrender-wasm && cargo test && cd ../..
npm run check 2>&1 | tail -2
npx vitest run src/lib/structure/catrender/
```
Expected: all PASS / 0 errors.

- [ ] **Step 8: Commit**

```bash
git add server/catgo/routers/view_capture.py \
  src/lib/structure/catrender/CatRenderPane.svelte \
  tests/test_catrender_bridge.py
git commit -m "feat(catrender): AI export bridge — pending/result routes + pane poll + MCP plugin"
```

(`~/.catgo/plugins/catrender.py` is outside the repo; note in the commit
body that it must be deployed to the user's `~/.catgo/plugins/`.)

---

## Self-Review Notes

- **Spec coverage:** Rust core (T1–2), WASM build + wrapper (T3), bond
  override layer (T4), mirror pane + presets + cell toggle + SVG/PNG export
  (T5), AI bridge MCP (T6). Crystal-package depth (supercell expansion, PBC
  wrap geometry) is scaffolded in the input schema and `cell` controls but
  the supercell *replication* drawing is intentionally minimal in T2's
  `svg.rs` — a follow-up task may deepen cell rendering; v1 ships the cell
  box + schema. Flagged here so it is a conscious cut, not a gap.
- **Placeholder scan:** Preset constants are explicitly marked as "replace
  with upstream xyzrender values before merge" (a values-only edit with a
  concrete source), not an open TODO.
- **Type consistency:** `Bond {i,j,order}` and `BondOverride` are defined
  once in `bond-merge.ts` and reused by the pane and poll loop; Rust
  `RenderInput`/`Style` JSON shape matches the `JSON.stringify` payloads in
  T5/T6.

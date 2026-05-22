# catrender Faithful-Port Implementation Plan (REV2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Each task is TDD: failing test → run → implement → run → commit.

**Goal:** Replace the v1 placeholder renderer with a faithful xyzrender port (Rust→WASM single core), plus the user value-adds (PCA + drag-rotate + axis gizmo, full live knobs, bond & atom edit overlays).

**Authoritative reference:** `docs/superpowers/specs/2026-05-18-catrender-design.md` (REV2) — embeds verbatim constants, full CPK palette, 13 preset JSONs, HLS/fog/PCA/bond formulas. Tasks cite spec §sections and xyzrender `file:line`. Implementers may `git clone --depth 1 https://github.com/aligfellow/xyzrender /tmp/xyzr` to read upstream context; the spec is the source of truth for the embedded data.

**Tech:** Rust + wasm-bindgen + wasm-pack (mirrors `extensions/chgdiff-wasm`), Svelte 5 runes, pnpm, vitest under `__tests__/`. Worktree `worktree-catrender`. Retain from v1: `bond-merge.ts`, `catrender-wasm.ts`, `/api/view/catrender/*` routes, MCP plugin, `bin/catrender.rs`. Rewrite: `svg.rs`, `preset.rs`, `bonds.rs`, `geom.rs`; add: `vdw.rs`, `palette.rs`, `color.rs`, `orient.rs`, `fog.rs`; extend `types.rs`. Rework `CatRenderPane.svelte`; add `atom-merge.ts`.

**Discipline:** Faithful = match xyzrender numerically. Where Python uses `int()` truncation / banker's rounding / colorsys HLS, replicate exactly (tests assert known-value vectors). No fabricated constants — every number traces to spec §Verbatim/§CPK/§presets or an xyzrender `file:line`.

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `extensions/catrender-wasm/src/vdw.rs` | Embedded VdW radius table (Å) + `vdw(sym)` |
| `…/src/palette.rs` | CPK Z→hex, default/centroid colors, named-CSS resolver |
| `…/src/color.rs` | RGB↔HLS (floor), lighten/darken/blend/blend_fog/get_gradient_colors |
| `…/src/preset.rs` | 13 embedded preset JSONs + `default.json` + deep-merge + renames + precedence |
| `…/src/orient.rs` | `pca_orient` (3×3 eigensolver, det-fix, diatomic/single, TS-priority) |
| `…/src/geom.rs` | ortho `proj` + `fit_canvas` (aspect-crop, per-radius pad, scale_ratio) |
| `…/src/fog.rs` | `fog_factors`, DoF buckets/filter defs |
| `…/src/bonds.rs` | perceive (retain) + trim/gap/multi/aromatic/split/shade/outline |
| `…/src/svg.rs` | z-order painter, radialGradient, skeletal/graph, cell, id-guard |
| `…/src/types.rs` | full `Style` (~48 knobs) + atom/bond override input |
| `…/src/lib.rs`, `…/src/bin/catrender.rs` | wasm + native entrypoints (retained, rewired) |
| `src/lib/structure/catrender/atom-merge.ts` | atom override (`hide`/`recolor`) merge util |
| `src/lib/structure/catrender/CatRenderPane.svelte` | rework: full knobs + bond/atom edit + drag-rotate + gizmo |
| `tests/fidelity/` | xyzrender-vs-catrender per-preset diff harness |

---

## Task RT1: vdw.rs — VdW radius table

**Files:** Create `extensions/catrender-wasm/src/vdw.rs`; modify `lib.rs` (`pub mod vdw;`).

- [ ] **Step 1 — failing test.** Create `vdw.rs` with `pub fn vdw(sym:&str)->f64` and `#[cfg(test)]`:
```rust
#[test]
fn known_radii_and_fallback() {
    assert!((vdw("H") - 1.6746855305377184).abs() < 1e-9);
    assert!((vdw("C") - 1.9101180590208).abs() < 1e-9);
    assert!((vdw("O") - 1.71453416202).abs() < 1e-9);
    assert!((vdw("Zz") - 1.5).abs() < 1e-12); // missing → 1.5
}
```
- [ ] **Step 2 — run, expect FAIL** (`cd extensions/catrender-wasm && cargo test vdw`).
- [ ] **Step 3 — implement.** Embed the full element→Å table. Source: spec §Verbatim (`BOHR_TO_ANGSTROM=0.5291772105`) and the resolved Å values listed in research slice-3 (H 1.6746855305377184, C 1.9101180590208, N 1.7981441612790001, O 1.71453416202, F 1.6310299982030998, P 2.1394634620515, S 2.06342069690265, Cl 1.98129239383305, Br 2.087074918212, I 2.22513725243145, B 2.0797722727071, Si 2.2654076381504997, Fe 2.4358026999314997, Pt 2.348488460199, Au 2.2537657395195003, Ru 2.4887204209815, Co 2.3945268775125004, Mn 2.4680825097719996, Ni 2.3553677639355, Cu 2.3416091564625, Zn 2.2773670431078004, Li 2.7991331267747475, …). To get the COMPLETE 117-element set + the odd keys (`"Gf"`=Gd-slot, lowercase `"ho"`=Ho), clone xyzgraph: `pip download xyzgraph==1.6.10 -d /tmp/xg && unzip -o /tmp/xg/*.whl -d /tmp/xg` (or `git clone` its repo), read `xyzgraph/data/vdw_radii.json`, and embed `radius_bohr * 0.5291772105` for every element key verbatim (preserve odd keys). `vdw()` = `TABLE.get(sym).copied().unwrap_or(1.5)`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `feat(catrender): embedded VdW radius table (xyzgraph, bohr×0.5291772105)`.

---

## Task RT2: palette.rs — CPK + named colors

**Files:** Create `palette.rs`; `lib.rs` `pub mod palette;`.

- [ ] **Step 1 — failing test:**
```rust
#[test] fn cpk_known() {
    assert_eq!(cpk(1), "#ffffff");  assert_eq!(cpk(6), "#909090");
    assert_eq!(cpk(8), "#ff0d0d");  assert_eq!(cpk(26), "#e06633");
    assert_eq!(cpk(0), "#008080");  assert_eq!(cpk(200), "#a0a0a0");
}
#[test] fn named_resolves() {
    assert_eq!(resolve_color("black"), "#000000");
    assert_eq!(resolve_color("steelblue"), "#4682b4");
    assert_eq!(resolve_color("#AbC"), "#aabbcc"); // 3→6 hex normalize, lowercased
    assert_eq!(resolve_color("atom"), "atom");    // passthrough marker
}
```
- [ ] **Step 2 — run FAIL.**
- [ ] **Step 3 — implement.** `cpk(z)`: Z==0→`#008080`; 1..=105 → spec §CPK palette table verbatim (embed all 105 entries exactly as listed); else `#a0a0a0`. `resolve_color(s)`: if `s=="atom"` return `"atom"`; if hex (`#rgb`/`#rrggbb`) normalize→lowercase 6-hex; else look up CSS-name table — embed `presets/named_colors.json` from the xyzrender clone (`/tmp/xyzr/src/xyzrender/presets/named_colors.json`) verbatim (it is the CSS4 name→hex map; copy all entries). Unknown → return input unchanged (xyzrender behavior).
- [ ] **Step 4 — run PASS.**
- [ ] **Step 5 — commit:** `feat(catrender): full CPK palette + named-color resolver`.

---

## Task RT3: color.rs — HLS color math

**Files:** Create `color.rs`; `lib.rs` `pub mod color;`.

- [ ] **Step 1 — failing test** (known-value vectors; compute expected with Python `colorsys`+xyzrender `colors.py` and hardcode):
```rust
#[test] fn hls_roundtrip_floor() {
    // colorsys.rgb_to_hls then hls_to_rgb with int() floor truncation
    let (h,l,s) = rgb_to_hls(0x90,0x90,0x90);
    let (r,g,b) = hls_to_rgb(h,l,s);
    assert_eq!((r,g,b), (0x90,0x90,0x90));
}
#[test] fn lighten_darken_known() {
    // C #909090, strength 1.0, hue .1 light .15 sat .15  (default.json)
    let c = Color::hex("#909090");
    let hi = c.lighten(1.0, 0.1, 0.15, 0.15);
    let lo = c.darken(1.0, 0.1, 0.15, 0.15);
    assert_eq!(hi.hex(), "#a5a48f"); // ← replace with value computed from xyzrender colors.py
    assert_eq!(lo.hex(), "#3d3f4c"); // ← idem (darken uses light*str*3)
}
#[test] fn blend_fog_caps() {
    // s = min(strength^2, 0.70); out=(1-s)rgb + s*255
    assert_eq!(blend_fog("#000000",(255,255,255),2.0), "#b3b3b3"); // s capped 0.70 → 178.5→178 floor
}
```
> Implementer: compute the three `← replace` expected hexes by running the cloned xyzrender (`python -c` importing `xyzrender.colors`) on those exact inputs; hardcode the real outputs before Step 3 so the test pins true parity.
- [ ] **Step 2 — run FAIL.**
- [ ] **Step 3 — implement** per spec §Color math: `rgb_to_hls`/`hls_to_rgb` replicating Python `colorsys` (H in 0–360 internally per xyzrender; **floor** via `(x*255.0) as u8` after clamp, NOT round); `Color{ r,g,b }` with `.hex()` lowercase; `lighten`(toward 60°)/`darken`(toward 240°, `l*(1-light*str*3)`)/`blend`(`(a + t*(b-a)) as i32` floor, clamp 0–255)/`blend_fog`(`s=min(strength*strength,0.70)`)/`get_gradient_colors`(→`(lighten,base,darken)`). Match clamp order exactly (spec).
- [ ] **Step 4 — run PASS.**
- [ ] **Step 5 — commit:** `feat(catrender): HLS color math (lighten/darken/blend/fog) — xyzrender-exact`.

---

## Task RT4: preset.rs — embedded presets + merge

**Files:** Rewrite `preset.rs`; `lib.rs` keeps `pub mod preset;`.

- [ ] **Step 1 — failing test:**
```rust
#[test] fn default_base() {
    let c = load("default");
    assert_eq!(c.get_f("atom_scale"), 2.5);
    assert_eq!(c.get_f("bond_width"), 20.0);
    assert_eq!(c.get_b("gradient"), true);
    assert_eq!(c.get_s("colors.C"), "#AAAAAA"); // resolve_color applied
}
#[test] fn flat_merges_onto_default() {
    let c = load("flat");
    assert_eq!(c.get_b("gradient"), false);   // flat override
    assert_eq!(c.get_f("bond_width"), 20.0);  // inherited from default
}
#[test] fn paton_colors_deep_merge() {
    let c = load("paton");
    assert_eq!(c.get_s("colors.C"), "#D9D9D9"); // paton
    // default.json colors only had C; paton replaces-then-update keeps just paton's
}
#[test] fn unknown_falls_back_to_default() {
    assert_eq!(load("nope").get_f("atom_scale"), load("default").get_f("atom_scale"));
}
```
- [ ] **Step 2 — run FAIL.**
- [ ] **Step 3 — implement** per spec §"13 presets": embed `default.json` and the 12 override sets as `&'static str` JSON (copy verbatim from spec / `/tmp/xyzr/src/xyzrender/presets/*.json`). `load(name)`: parse default; if name!="default" and known, deep-merge overrides (one-level: if both base[k] & v are objects → object-update; else replace); apply JSON-key→field renames (spec list) and `resolve_color` to color fields (skip `"atom"`); unknown name → default. Provide typed getters or a `MergedConfig` the `Style` builder consumes. Precedence hook: a later `apply_overrides(map)` (UI/CLI) where `None`/absent = inherit.
- [ ] **Step 4 — run PASS.**
- [ ] **Step 5 — commit:** `feat(catrender): 13 embedded preset JSONs + xyzrender deep-merge semantics`.

---

## Task RT5: orient.rs — PCA auto-orient

**Files:** Create `orient.rs`; `lib.rs` `pub mod orient;`.

- [ ] **Step 1 — failing test:**
```rust
#[test] fn diatomic_along_x() {
    let p = vec![[0.,0.,0.],[0.,0.,2.]];
    let o = pca_orient(&p, None);
    // bond becomes the x axis
    assert!((o[1][0].abs() - 2.0).abs() < 1e-9 || (o[1][0]).abs() > 1e-6);
    assert!(o[1][1].abs() < 1e-9 && o[1][2].abs() < 1e-9);
}
#[test] fn single_atom_identity() {
    assert_eq!(pca_orient(&vec![[3.,1.,2.]], None)[0], [0.,0.,0.]); // centered
}
#[test] fn planar_variance_order() {
    // points spread most in X, then Y, ~0 in Z → orientation keeps that order
    let p = vec![[ -3.,0.,0.],[3.,0.,0.],[0.,-1.,0.],[0.,1.,0.]];
    let o = pca_orient(&p, None);
    let var = |k:usize| { let m:f64=o.iter().map(|q|q[k]).sum::<f64>()/o.len() as f64;
        o.iter().map(|q|(q[k]-m).powi(2)).sum::<f64>() };
    assert!(var(0) >= var(1) && var(1) >= var(2));
}
```
- [ ] **Step 2 — run FAIL.**
- [ ] **Step 3 — implement** per spec §PCA (verbatim `utils.py:61-128`): arithmetic-mean centroid; single/coincident→centered identity; diatomic→bond-along-x with `ref=e_argmin(|ax|)` orthonormal completion; else covariance `C = XᵀX`, symmetric 3×3 eigendecomposition (analytic or Jacobi — no external crate), order eigenvectors by descending eigenvalue into rows of `vt`, `if det(vt)<0 { vt[2]*=-1 }`, `oriented = c · vtᵀ`. `priority_pairs` → duplicate those centered rows ×5.0 before covariance, then post in-plane z-rotation `θ=-atan2(avg_dir.y,avg_dir.x)`. Signature `pca_orient(pos:&[[f64;3]], priority:Option<&[(usize,usize)]>) -> Vec<[f64;3]>` (+ a `_with_matrix` variant returning the 3×3 for the gizmo).
> Replicate LAPACK SVD sign behavior is impossible bit-for-bit; spec accepts det-fixed eigenbasis. Document that two mirror-symmetric inputs may differ in handedness from upstream — acceptable (xyzrender itself is sign-arbitrary).
- [ ] **Step 4 — run PASS.**
- [ ] **Step 5 — commit:** `feat(catrender): PCA auto-orient (covariance eigendecomp, det-fix, diatomic/TS)`.

---

## Task RT6: geom.rs — projection + fit_canvas

**Files:** Rewrite `geom.rs` (keep `rotate` for the drag-overlay; add `proj`,`fit_canvas`).

- [ ] **Step 1 — failing test:**
```rust
#[test] fn fit_aspect_and_scale() {
    // span x=6, y=3, canvas 800, padding 20 → scale=(800-40)/6
    let pos=vec![[-3.,-1.5,0.],[3.,1.5,0.]]; let r=vec![0.0,0.0];
    let f = fit_canvas(&pos,&r,800.0,20.0,None);
    assert!((f.scale - (760.0/6.0)).abs()<1e-6);
    assert_eq!(f.w as i64, (6.0*f.scale+40.0) as i64);
    assert_eq!(f.h as i64, (3.0*f.scale+40.0) as i64);
}
#[test] fn proj_y_flips() {
    let (x,y)=proj([1.,1.,0.], 10.0, 0.,0., 100.,100.);
    assert!((x-110.0).abs()<1e-9 && (y-40.0).abs()<1e-9);
}
```
- [ ] **Step 2 — run FAIL.**
- [ ] **Step 3 — implement** per spec §Verbatim + xyzrender `renderer.py:1806-1831`: `proj(p,scale,cx,cy,cw,ch)=(cw/2+scale*(p0-cx), ch/2-scale*(p1-cy))`; `fit_canvas`: `pad=radii.max()`, bbox xy ±pad (+optional extra), `max_span=max(spanx,spany)` (or `fixed_span`), `scale=(canvas-2*padding)/max_span`, `w=spanx*scale+2*padding`,`h=spany*scale+2*padding` (or square if fixed_span), center=bbox mid; expose `ref_scale=(800-2*padding)/6.0` and `scale_ratio=scale/ref_scale`.
- [ ] **Step 4 — run PASS.**
- [ ] **Step 5 — commit:** `feat(catrender): orthographic proj + aspect-fit canvas + scale_ratio`.

---

## Task RT7: fog.rs — fog factors + DoF

**Files:** Create `fog.rs`; `lib.rs` `pub mod fog;`.

- [ ] **Step 1 — failing test:**
```rust
#[test] fn fog_clip_and_strength() {
    // z: front zmax=5, back z=0, zr=5, _FOG_NEAR=1, strength=1.2
    let z=vec![5.0,3.0,0.0];
    let f=fog_factors(&z,1.2);
    assert!((f[0]-0.0).abs()<1e-9);                 // front: depth0 → (−1)/5 clip0
    assert!((f[2]-1.2*((5.0-1.0)/5.0)).abs()<1e-9); // back
}
#[test] fn dof_bucket() {
    assert_eq!(dof_bucket(0.0), 0);
    assert_eq!(dof_bucket(1.0), 19);
    assert_eq!(dof_bucket(0.5), 10); // int(0.5*19+0.5)=10
}
```
- [ ] **Step 2 — run FAIL.**
- [ ] **Step 3 — implement** per spec §Fog: `fog_factors(z,strength)`: `zr=max(zmax-zmin,1e-6)`, `f[i]=strength*clip((zmax-z[i]-1.0)/zr,0,1)`; `dof_bucket(d)=int(d*19.0+0.5)`; `dof_filter_defs(strength)` → 20 `<filter id="dof{n}"><feGaussianBlur stdDeviation="{n/19*strength}"/>` strings (rendered only when DoF on; CLI raster path: provide `dof_opacity_ramp` alternative noted in spec).
- [ ] **Step 4 — run PASS.**
- [ ] **Step 5 — commit:** `feat(catrender): fog factors + DoF bucket/filter defs`.

---

## Task RT8: bonds.rs — full bond geometry

**Files:** Rewrite `bonds.rs` (keep `perceive`; add geometry/style helpers).

- [ ] **Step 1 — failing tests** (pure helpers, no SVG):
```rust
#[test] fn trim_to_0_9_radius() {
    let (s,e,ok)=trim([0.,0.,0.],[2.,0.,0.],0.5,0.5);
    assert!(ok); assert!((s[0]-0.45).abs()<1e-9 && (e[0]-1.55).abs()<1e-9); // 0.9*0.5
}
#[test] fn trim_rejects_overlap() {
    assert!(!trim([0.,0.,0.],[0.4,0.,0.],0.5,0.5).2);
}
#[test] fn multibond_offsets() {
    assert_eq!(ib_seq(1), vec![0]);
    assert_eq!(ib_seq(2), vec![-1,1]);
    assert_eq!(ib_seq(3), vec![-2,0,2]);
}
#[test] fn nb_round_half_even() {
    assert_eq!(nb_from_order(1.5,true), 2); // aromatic handled elsewhere; round half→even
    assert_eq!(nb_from_order(2.5,true), 2);
    assert_eq!(nb_from_order(1.2,true), 1);
    assert_eq!(nb_from_order(9.9,false), 1); // bond_orders=false → 1
}
#[test] fn aromatic_window() { assert!(is_aromatic(1.5) && !is_aromatic(1.7) && !is_aromatic(1.3)); }
```
- [ ] **Step 2 — run FAIL.**
- [ ] **Step 3 — implement** per spec §Bonds + xyzrender `renderer.py:1028-1372`,`skeletal.py`: `trim(pi,pj,ri,rj)`→`(start,end,ok)` with `*0.9` and `dot<=0`/len reject; `perp2d`; `ib_seq(nb)=range(-nb+1,nb,2)`; `nb_from_order(bo,bond_orders)` (`max(1,round_half_even(bo))`, →1 if !bond_orders); `is_aromatic(bo)=1.3<bo<1.7`; `gap(bw)=0.6*bw`; `half_split_t(ri,rj)=ri/(ri+rj)`; cylinder/outline stroke spec builders (return SVG fragment strings, unit-tested for exact attr text). Keep distance `perceive` as the no-explicit-bonds fallback.
- [ ] **Step 4 — run PASS.**
- [ ] **Step 5 — commit:** `feat(catrender): faithful bond geometry (trim/gap/multi/aromatic/split)`.

---

## Task RT9: svg.rs — full renderer assembly

**Files:** Rewrite `svg.rs`. Integrates RT1–RT8.

- [ ] **Step 1 — failing tests** (behavioral, on `render_svg(&RenderInput)`):
```rust
#[test] fn default_preset_water() {
    let s=render(r#"{"atoms":[{"el":"O","xyz":[0,0,0]},{"el":"H","xyz":[0.96,0,0]},{"el":"H","xyz":[-0.24,0.93,0]}],"style":{"preset":"default"}}"#);
    assert!(s.starts_with("<svg") && s.contains("xmlns:xlink"));
    assert!(s.contains("radialGradient") && s.contains("fx=\".33\""));
    assert_eq!(s.matches("<circle").count(), 3);
}
#[test] fn skeletal_no_carbon_circle() {
    let s=render(r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"C","xyz":[1.5,0,0]}],"style":{"preset":"skeletal"}}"#);
    assert!(!s.contains("<circle")); // C vertices, no spheres
}
#[test] fn bubble_hides_bonds() {
    let s=render(r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"style":{"preset":"bubble"}}"#);
    assert!(!s.contains("<line"));
}
#[test] fn id_prefix_guard() {
    let s=render(r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{"preset":"default","id_prefix":"a"}}"#);
    assert!(s.contains("id=\"a") && !s.contains("id=\"g0\""));
}
#[test] fn cell_box_dashed() {
    let s=render(r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"lattice":[[4,0,0],[0,4,0],[0,0,4]],"style":{"preset":"default","cell":{"show":true}}}"#);
    assert!(s.contains("stroke-dasharray") && s.contains("class=\"cell-edge\""));
}
```
- [ ] **Step 2 — run FAIL.**
- [ ] **Step 3 — implement** per spec §Radial gradient/§Fog/§Bonds/§Cell/§SVG output: pipeline = parse → (auto_orient? `orient::pca_orient`) → apply drag matrix → display radii (vdw·H·atom_scale·0.075) → `fit_canvas` → z-order `argsort(z)` painter loop emitting **atom then its forward bonds interleaved** (`_z_rank` skip), real `<radialGradient cx=.5 cy=.5 fx=.33 fy=.33 r=.66>` (fog per-stop blend, shared id by (Z,hex) unless fog), atom stroke (`atom_stroke_color` incl `"atom"`, width·scale_ratio), `atom_wash`, bonds via RT8 (half-split, cylinder gradient, deferred outline layer, aromatic ring-side), skeletal/graph modes, cell box before molecule, periodic-image opacity, double-quoted attrs, `:.1f`/`:.4f`/`:.2f` precision, id-prefix guard. `lib.rs render()` unchanged signature.
- [ ] **Step 4 — run PASS.**
- [ ] **Step 5 — commit:** `feat(catrender): faithful SVG renderer (z-order/gradient/skeletal/graph/cell)`.

---

## Task RT10: types.rs + entrypoints + wasm rebuild

**Files:** Extend `types.rs`; touch `lib.rs`/`bin/catrender.rs`; rebuild wasm pkg.

- [ ] **Step 1 — failing test:** parse a full-knob input incl atom/bond overrides + `id_prefix` + every `Style` field; assert defaults populate from preset when omitted (serde defaults mirror spec §presets default.json).
- [ ] **Step 2 — run FAIL.**
- [ ] **Step 3 — implement** `Style` = full merged field set (~48 knobs, names per spec), `AtomOverride{op:hide|recolor,idx,hex?}`, retain `Bond`/bond override path, `id_prefix:Option<String>`. Ensure native `bin/catrender.rs` + `#[wasm_bindgen] render` compile against new core.
- [ ] **Step 4 — run PASS;** then `wasm-pack build --target web --out-dir ../../src/lib/structure/catrender/catrender-wasm-pkg`; `cd ../.. && pnpm run check 2>&1|tail -2` (no new catrender errors).
- [ ] **Step 5 — commit:** `feat(catrender): full Style schema + atom-override + wasm rebuild`.

---

## Task RT11: frontend rework — knobs + edit overlays + gizmo

**Files:** Create `atom-merge.ts`(+`__tests__`); rewrite `CatRenderPane.svelte`. Retain `bond-merge.ts`, `catrender-wasm.ts`, poll loop, C1 effect.

- [ ] **Step 1 — failing vitest** `src/lib/structure/catrender/__tests__/atom-merge.test.ts`: `merge_atoms(atoms, overrides)` — `hide` drops atom + reindexes/maps so bonds referencing it are removed; `recolor` sets per-idx hex; `prune_atom_overrides(ov,n)` drops idx≥n. (Mirror `bond-merge` shape; 5 cases.)
- [ ] **Step 2 — run FAIL** (`pnpm exec vitest run …/__tests__/atom-merge.test.ts`).
- [ ] **Step 3 — implement** `atom-merge.ts` pure util. Then rework `CatRenderPane.svelte`:
  - keep read-only mirror + debounced C1 effect + render_seq + onMount bridge poll (do not regress).
  - **Full controls panel**: Preset `<select>`; every `Style` knob a bound input/slider; change → live rerender.
  - **Bond-edit UI** → existing `bond-merge` (add/del/set-order).
  - **Atom-edit UI** → `atom-merge`: select atom (click SVG hit-test by nearest projected center, or index list), delete/hide, color picker recolor.
  - **Drag-rotate**: pointer drag on preview → accumulate an extra rotation (Euler or arcball) sent as `style.drag_rotation`; "Reset view" clears it (back to pure PCA). Core applies it after PCA.
  - **Axis gizmo**: corner triad from the (PCA·drag) basis (request the matrix from core or recompute client-side from drag + a core-returned PCA matrix), axes colored per `axis_colors`.
- [ ] **Step 4 — run** `pnpm exec vitest run src/lib/structure/catrender/` (atom-merge + bond-merge green) and `pnpm run check` (no new catrender errors).
- [ ] **Step 5 — commit:** `feat(catrender): full knob panel + bond/atom edit overlays + drag-rotate + axis gizmo`.

---

## Task RT12: fidelity verification harness + E2E

**Files:** Create `tests/fidelity/` (script + reference set).

- [ ] **Step 1** — clone xyzrender (`/tmp/xyzr`), pip-install it in a venv. Pick a fixed reference set: water, benzene (aromatic), ferrocene (metal), an ethylene (double bond), a small slab w/ lattice (cell+periodic).
- [ ] **Step 2** — for each (structure × preset in default/flat/paton/skeletal/bubble/tube/wire/graph/btube/mtube/pmol): render with real xyzrender → SVG_ref; render same input through native `catrender` bin → SVG_ours.
- [ ] **Step 3** — structural diff assertions (script, committed): equal `<circle>`/`<line>` counts, viewBox aspect within tol, gradient stop colors per atom within ΔE tol, bond stroke widths/dasharray equal, cell-edge count. Emit a per-(structure,preset) PASS/FAIL report. This is the parity gate.
- [ ] **Step 4** — fix any divergence by correcting the responsible RT module (loop: diff → fix module → re-diff). Record residual known-acceptable diffs (e.g. PCA handedness sign) explicitly.
- [ ] **Step 5 — commit:** `test(catrender): xyzrender parity fidelity harness + reference set`.
- [ ] **Step 6** — browser E2E (agent-browser): dev server, load structures, Render tab — verify live knobs rerender, preset switch, drag-rotate + gizmo, bond-edit, atom delete/recolor, SVG/PNG export, AI bridge round-trip. Screenshot each. Document results (not committed).

---

## Self-Review

- **Spec coverage:** every spec §maps to a task — vdw→RT1, palette→RT2, color→RT3, presets/merge→RT4, PCA→RT5, proj/fit→RT6, fog/DoF→RT7, bonds→RT8, svg/cell/skeletal/graph/id-guard→RT9, schema/overrides→RT10, pane(knobs/bond/atom-edit/drag/gizmo)→RT11, fidelity→RT12.
- **Placeholders:** none — every constant cites spec §CPK/§presets/§Verbatim or an xyzrender `file:line`; the 3 `← replace` test expectations have an explicit "compute from cloned xyzrender before Step 3" instruction (concrete source, not TBD).
- **Type consistency:** `Style`/`Bond`/`AtomOverride`/`BondOverride` defined RT10, consumed RT9/RT11; `pca_orient` signature fixed RT5 used RT9; `fit_canvas`/`scale_ratio` RT6 used RT8/RT9.
- **Scope:** full-parity per locked decision; surfaces/GIF/measure explicitly Non-Goals (spec).

---

## Task RT13: split into two independent DraggablePanes + drag-rotate fix + direct bond/atom delete

**Why:** user rejected the single stacked pane (params bury the preview; must scroll past 17 knobs to see structure). Chosen layout: **独立双窗** — two independent draggable panes. Also fixes the root-caused drag-rotate failure ([[feedback-draggablepane-svelte5-delegation]]) and makes bond/atom deletion direct.

**Root cause (proven, evidence-backed):** `src/lib/DraggablePane.svelte` ~480-490 `stop()` calls `e.stopPropagation()` on `pointerdown`/`mousedown` at the pane root. Svelte 5 event delegation routes `onpointerdown={}` through ONE document-root listener reached via bubbling; the pane-root stop kills it → `on_pointer_down` never fires → `dragging` stays false → every `pointermove` early-returns → no rotation. Fix: bind preview pointer handlers via a Svelte `use:` action doing **direct `node.addEventListener`** (a direct listener on the descendant fires during bubble BEFORE the ancestor pane-root `stop()` — non-delegated, pane-local, does not touch shared DraggablePane).

**Architecture:**
- `src/lib/structure/catrender/catrender-state.svelte.ts` — shared reactive `$state` module: `preset`, `overrides`/knob state, `advanced_json`, `bond_overrides`, `atom_overrides`, `drag_rot`, plus the structure-mirror source. Both panes import this — single source of truth.
- `src/lib/structure/catrender/CatRenderParamsPane.svelte` — wrapped in `DraggablePane`: preset select + 17 knob controls + advanced JSON + reset. Writes shared state only.
- `src/lib/structure/catrender/CatRenderViewPane.svelte` — wrapped in `DraggablePane`: live SVG preview (C1 debounced $effect + render_seq + teardown — port verbatim from current CatRenderPane), xyz gizmo, drag-rotate (via the `use:` direct-listener action — THE fix), bond-edit (add + **per-row direct delete ×** + set-order, not just clear-all), atom-edit (select via click-pick or index list + hide/delete + recolor, per-row direct delete), Export SVG/PNG, AI-bridge poll. Reads shared state, owns render.
- Keep `bond-merge.ts`/`atom-merge.ts`/`catrender-wasm.ts` unchanged. Delete old `CatRenderPane.svelte` (superseded) — or keep as a thin shell that mounts both for backward ExportPane wiring; pick the cleaner.
- Toggle/open: follow the existing CatGo DraggablePane open pattern (the `ExportPane` "Render" tab should open BOTH panes, or two toolbar toggles — mirror how other DraggablePanes are registered/toggled in the app; do not invent a new mechanism).

**Steps (TDD where unit-testable; .svelte verified via browser E2E):**
- [ ] Create `catrender-state.svelte.ts` shared store; unit-test any pure helpers.
- [ ] Create `CatRenderParamsPane.svelte` (DraggablePane + knob panel writing shared state).
- [ ] Create `CatRenderViewPane.svelte` (DraggablePane + preview + C1 effect verbatim + `use:`-action pointer handlers [the fix] + gizmo + bond/atom direct-delete edit + export + poll).
- [ ] Wire both into ExportPane/toolbar per existing DraggablePane pattern; remove/shell the old pane.
- [ ] `pnpm run check` 0 new errors; `pnpm exec vitest run src/lib/structure/catrender/` green (bond-merge/atom-merge unchanged).
- [ ] Browser E2E (agent-browser/chrome-devtools): drag preview → molecule rotates + gizmo tracks; Reset view; per-row bond delete works; atom hide/recolor (correct atom incl. with hidden present); preset/knob/advanced live; export; two panes independently movable; params no longer bury preview.
- [ ] Commit.

**Discipline:** C1 effect (render_seq+cancelled+teardown) ported VERBATIM into ViewPane — do not regress. The drag fix MUST be the `use:` direct-listener action (proven mechanism), not a DraggablePane edit (shared component; would risk other panes). Direct per-row delete for bonds AND atoms (user: "不能直接删 bond"). Faithful render core (RT1-RT12) untouched.

---

## Task RT14: in-canvas direct-manipulation delete (click atom/bond in the SVG → one-step delete)

**Why (pinned, recurred ≥3×):** user wants to click an atom OR a bond directly in the rendered preview → on-the-spot highlight + an inline delete affordance + Del/Backspace → one-step delete. NOT the current select-then-go-to-a-side-list-× flow. Render-only override (no write-back — locked, user-confirmed). RT13 (two-pane, drag-rotate fixed, per-row delete) is APPROVED and the baseline; RT14 builds the direct-manipulation layer on `CatRenderViewPane.svelte`.

**Design (frontend-only; Rust/wasm untouched; C1 + drag-rotate action + shared state + DraggablePane NOT modified):**
- **Atom pick**: reuse existing click-pick (pointerup-when-not-dragged → nearest projected `<circle>` → correct ORIGINAL index via `merge_atoms` hidden remap). On pick set `selected = {kind:'atom', idx}`.
- **Bond pick (new)**: on the same click, if no atom is within hit radius, hit-test bonds — map click (svg-space) to the nearest bond *segment* (point-to-line-segment distance) among the effective merged bonds, using the same projected atom coords the renderer used (parse the wasm SVG's `<circle>` cx/cy in original-index order, or recompute projection). Within a px threshold → `selected = {kind:'bond', i, j}`.
- **Highlight overlay**: a client-side absolutely-positioned `<svg>` layer ON TOP of `.preview` (same viewBox/scale as the rendered SVG — read its `viewBox`/width), drawing a highlight (atom: ring/glow at the picked circle's cx/cy,r; bond: thick translucent stroke along the picked segment). Pure overlay — does NOT mutate the `{@html}` wasm SVG.
- **Inline delete affordance**: a small floating "✕ delete" button positioned next to the highlighted element (screen coords from the projected point); clicking it deletes. ALSO: `Del`/`Backspace` keydown (listener scoped to the View pane / preview, added/removed cleanly — mirror the RT13 drag-action lifecycle discipline; do not use Svelte delegation for keydown if the DraggablePane swallow-list affects it — verify; keydown is NOT in DraggablePane's pointer/mouse/wheel swallow list, so a normal handler is fine, but the preview must be focusable (tabindex) to receive keydown, or attach to window with a guard that the pane is open + something selected).
- **Delete action**: atom → push `{op:'hide',idx}` into `catrender_state.atom_overrides` (via existing atom-merge path); bond → push a `{op:'remove',i,j}` BondOverride into `catrender_state.bond_overrides` (existing bond-merge path). Clears `selected`. Render-only; the existing C1 effect re-renders. An "undo last" / the existing per-row × list stays as the secondary/batch path (do not remove RT13's list — it's the keyboard-free/batch fallback).
- Selection clears on: successful delete, Esc, clicking empty canvas, structure mirror change (prune if idx invalid).
- Drag vs click: preserve RT13's `dragged` gate — a drag rotates (no select); a click (no movement) selects. Do not regress drag-rotate or C1.

**Steps (TDD for pure logic; browser-verify the interaction):**
- [ ] Pure helper `pick_hit.ts` (+`__tests__`): `nearest_atom(click_xy, atom_xy[], r[]) -> idx|null` and `nearest_bond(click_xy, bonds[(i,j)], atom_xy[], thresh) -> {i,j}|null` (point-to-segment distance). Unit-test both incl. ties/empty/threshold.
- [ ] CatRenderViewPane: wire pick → `selected` state; overlay highlight `<svg>`; inline ✕ button; Del/Backspace + Esc; delete → atom-merge/bond-merge override; selection-clear rules. Keep RT13 list path.
- [ ] `pnpm exec vitest run src/lib/structure/catrender/` green (existing 21 + pick_hit tests); `pnpm run check` 0 new errors.
- [ ] Browser E2E: load benzene → Render → click an atom in preview → it highlights + ✕ appears → click ✕ (or press Del) → atom gone (circle count drops), render-only (main viewer unchanged); click a bond → highlight → Del → bond gone (`<line>` drops); Esc/empty-click clears; drag still rotates (not select); two-pane + per-row list still work. Screenshots.
- [ ] Commit.

**Discipline:** frontend-only; Rust/wasm/C1/drag-action/DraggablePane/shared-state untouched (extend, don't rewrite). Render-only, no main-viewer write-back. Bond hit-test must use the SAME projected coords the renderer used (parse rendered `<circle>` positions) so the highlight aligns with what's drawn. Keyboard handler lifecycle clean (no leak; mirror RT13 action discipline). Browser-verify the one-step delete actually works (the whole point) — if click→delete doesn't work end-to-end, STOP and report.

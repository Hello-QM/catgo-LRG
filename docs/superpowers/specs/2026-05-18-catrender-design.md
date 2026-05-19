# catrender — Faithful xyzrender Port (Design, REV2)

Date: 2026-05-18 (REV2 — supersedes the placeholder-renderer v1)
Status: Approved decisions; spec for the faithful re-port.

## Why REV2

v1 (branch `worktree-catrender`, T1–T7) shipped a crude approximation with
**fabricated placeholder constants** — it looks nothing like xyzrender and was
rejected. REV2 is a faithful port: reproduce xyzrender's actual algorithm and
constants verbatim, keep Rust/WASM real-time + native CLI single core, and add
the user-required value-adds. This spec embeds the load-bearing verbatim data
extracted from xyzrender source (5-agent reverse-engineering) so the port has
no guesswork. Upstream: `github.com/aligfellow/xyzrender` (built on
`github.com/briling/xyz2svg`), radius table from `xyzgraph`.

## Locked Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Orientation | **Faithful PCA auto-orient (default)** + interactive drag-rotate overlay + xyz axis gizmo (our value-add; xyzrender has neither) |
| 2 | v1 scope | **Full parity** — incl. skeletal/graph modes, aromatic ring-side dashed, periodic images, TS-priority weighting |
| 3 | Params | All knobs **live-tunable, not hardcoded**: embed xyzrender's 13 preset JSONs as data + `default.json` base; Rust `Style` = full merged field set; pane = full controls panel, every knob a live slider overriding the preset |

Single render core (Rust→WASM for the live pane; same crate→native bin for
headless AI export). Bond-merge override layer, catrender-wasm.ts wrapper, the
`/api/view/catrender/*` bridge routes, and the MCP plugin scaffolding from v1
are **retained**; the renderer internals are rewritten.

## Module Map (Rust crate `extensions/catrender-wasm`)

| Module | Responsibility |
|--------|----------------|
| `vdw.rs` | Embedded `xyzgraph/data/vdw_radii.json` values ×`BOHR_TO_ANGSTROM`; `vdw(sym)->Å`, missing→1.5 |
| `palette.rs` | Full `_CPK` (Z 1–105) + `_DEFAULT_COLOR 0xA0A0A0` + `_CENTROID 0x008080`; named-CSS-color resolver (`presets/named_colors.json`) |
| `color.rs` | RGB↔HLS (Python `colorsys`, **floor** truncation), `lighten`/`darken`/`blend`/`blend_fog`, `get_gradient_colors` |
| `preset.rs` | 13 preset JSONs embedded as data; deep-merge-onto-`default.json` (one-level `dict.update`); `None`=inherit precedence; JSON-key→field renames |
| `types.rs` | `Style` = full merged field set (~48 knobs); `RenderInput{atoms,bonds,lattice,style}` |
| `orient.rs` | `pca_orient` (covariance SVD/Jacobi 3×3, det-fix, diatomic & single-atom special cases, TS-priority weighting + in-plane z-rotation) |
| `geom.rs` | orthographic `_proj`; `_fit_canvas` (aspect-crop, per-radius pad, `scale_ratio`) |
| `fog.rs` | `fog_f` per atom; DoF 20-bucket `feGaussianBlur` defs |
| `bonds.rs` | distance perceive (retain) **+** trim 0.9·r, `gap=0.6·bw`, multi-bond `ib` loop, aromatic ring-side dashed, half-bond element split, cylinder linearGradient, deferred outline layer |
| `svg.rs` | z-order painter (atom/bond interleaved), radialGradient real geometry, cell box, skeletal & graph modes, periodic-image opacity, **SVG id prefix guard**, double-quoted attrs |
| `lib.rs` | `#[wasm_bindgen] render(json)->String` |
| `bin/catrender.rs` | native CLI (retained) |

## Verbatim Constants (port these exactly)

```
_RADIUS_SCALE = 0.075      _REF_SPAN = 6.0       _REF_CANVAS = 800
_H_ATOM_SCALE = 0.6        _H_VDW_SCALE = 0.65   _CENTROID_VDW = 0.5
_FOG_NEAR = 1.0            _MAX_FOG = 0.70       _BOND_DARKEN_T = 0.3
BOHR_TO_ANGSTROM = 0.5291772105
padding default = 20.0  → ref_scale = (800 - 2*20)/6.0 = 126.6667
bond_gap default = 0.6     atom_gradient_strength default = 1.0
RoundΔ: nb = max(1, round_half_to_even(bond_order))
```

Display radius: `radius_Å = vdw_Å * (0.6 if H else 1.0) * atom_scale * 0.075 * per_atom_mult`
(`*`-centroid uses 0.5 not vdw).
Projection: `sx = cw/2 + scale*(X-cx)`, `sy = ch/2 - scale*(Y-cy)`.
`scale = (canvas_size - 2*padding)/max(x_span,y_span)`; `scale_ratio = scale/ref_scale`.
Fit bbox = projected XY ± `radii.max()`; canvas cropped to molecule aspect; center = bbox midpoint.

## CPK palette (Z→hex, `colors.py:191-206`; pad Z 106–119 = `#a0a0a0`)

```
1 H #ffffff  2 He #d9ffff  3 Li #cc80ff  4 Be #c2ff00  5 B #ffb5b5
6 C #909090  7 N #3050f8  8 O #ff0d0d  9 F #90e050  10 Ne #b3e3f5
11 Na #ab5cf2 12 Mg #8aff00 13 Al #bfa6a6 14 Si #f0c8a0 15 P #ff8000
16 S #ffff30 17 Cl #1ff01f 18 Ar #80d1e3 19 K #8f40d4 20 Ca #3dff00
21 Sc #e6e6e6 22 Ti #bfc2c7 23 V #a6a6ab 24 Cr #8a99c7 25 Mn #9c7ac7
26 Fe #e06633 27 Co #f090a0 28 Ni #50d050 29 Cu #c88033 30 Zn #7d80b0
31 Ga #c28f8f 32 Ge #668f8f 33 As #bd80e3 34 Se #ffa100 35 Br #a62929
36 Kr #5cb8d1 37 Rb #702eb0 38 Sr #00ff00 39 Y #94ffff 40 Zr #94e0e0
41 Nb #73c2c9 42 Mo #54b5b5 43 Tc #3b9e9e 44 Ru #248f8f 45 Rh #0a7d8c
46 Pd #006985 47 Ag #c0c0c0 48 Cd #ffd98f 49 In #a67573 50 Sn #668080
51 Sb #9e63b5 52 Te #d47a00 53 I #940094 54 Xe #429eb0 55 Cs #57178f
56 Ba #00c900 57 La #70d4ff 58 Ce #ffffc7 59 Pr #d9ffc7 60 Nd #c7ffc7
61 Pm #a3ffc7 62 Sm #8fffc7 63 Eu #61ffc7 64 Gd #45ffc7 65 Tb #30ffc7
66 Dy #1fffc7 67 Ho #00ff9c 68 Er #00e675 69 Tm #00d452 70 Yb #00bf38
71 Lu #00ab24 72 Hf #4dc2ff 73 Ta #4da6ff 74 W #2194d6 75 Re #267dab
76 Os #266696 77 Ir #175487 78 Pt #d0d0e0 79 Au #ffd123 80 Hg #b8b8d0
81 Tl #a6544d 82 Pb #575961 83 Bi #9e4fb5 84 Po #ab5c00 85 At #754f45
86 Rn #428296 87 Fr #420066 88 Ra #007d00 89 Ac #70abfa 90 Th #00baff
91 Pa #00a1ff 92 U #008fff 93 Np #0080ff 94 Pu #006bff 95 Am #545cf2
96 Cm #785ce3 97 Bk #8a4fe3 98 Cf #a136d4 99 Es #b31fd4 100 Fm #b31fba
101 Md #b30da6 102 No #bd0d87 103 Lr #c70066 104 Rf #cc0059 105 Db #a0a0a0
```
`get_color`: Z==0→`#008080`; else `_CPK[Z]`; OOB→`#a0a0a0`. `cfg.colors` (element→hex) overrides per-element (default.json forces `C→#AAAAAA`). Preset string colors (`"black"`,`"steelblue"`,`"firebrick"`,`"gray"`,`"teal"`…) resolve via `presets/named_colors.json`.

## Color math (verbatim, HLS — Python colorsys order H,L,S; floor truncation)

`lighten` (toward 60°): `nl = l + light_shift*str*(1-l)` clamp01; `d=((60-h+180)%360)-180`; `nh=(h + d*hue_shift*str)%360`; `ns = s*(1-sat_shift*str)` clamp01.
`darken` (toward 240°): `nl = l*(1 - light_shift*str*3)` clamp01 (**×3**); `d=((240-h+180)%360)-180`; `nh=(h + d*hue_shift*str)%360`; `ns = s + (1-s)*sat_shift*str` clamp01.
`get_gradient_colors(c,cfg,str)` → `(c.lighten(str), c, c.darken(str))`.
`blend(a,b,t)` per channel `int(a + t*(b-a))` clamp 0–255 (floor).
`blend_fog(hex,fog_rgb,strength)`: `s=min(strength**2, 0.70)`; `out=(1-s)*rgb + s*fog_rgb`.

## Radial gradient (atoms)

`<radialGradient id="g.." cx=".5" cy=".5" fx=".33" fy=".33" r=".66">` stops:
`0%`=hi(lighten), `40%`=me(base), `100%`=lo(darken). Gradient enabled by
`cfg.gradient` (default.json `true`) and `not skeletal_style`. Off → flat fill.
ID shared by `(Z,hex)` unless fog (then per-atom `g{ai}`). VdW-sphere variant
= 2-stop (true→darken). **SVG id prefix-guard** when multiple SVGs in one DOM
(prefix `id=`/`url(#`/`href=#` with `x{n}`) — fixes the multi-pane collision bug.

## Fog & DoF

`fog_f[i] = fog_strength * clip((zmax - z[i] - 1.0)/zrange, 0, 1)`, fog→white.
Atom fill (gradient): each stop `.blend(WHITE, min(fog_f**2*0.7, 0.70))`.
Atom flat/stroke: `blend_fog(color, white, fog_f)`.
**Bonds: `blend_fog(color, white, (fog_i+fog_j)/2 * 0.75)`** (bonds fogged ~25% less; outline blended per-endpoint, no 0.75).
DoF: `dof_depth` normalized; bucket `int(d*19+0.5)`; `<filter id="dof{lvl}"><feGaussianBlur stdDeviation="{lvl/19*dof_strength}"/>` (default 3.0). Browser pane uses real filter; native/raster CLI approximates DoF via opacity+desat ramp (same fog machinery, stronger curve).

## PCA auto-orient (`utils.py:61-128`, verbatim semantics)

Centroid = arithmetic mean (NOT mass-weighted) of fit atoms; center all. ≥2
non-coincident → SVD of centered (`np.linalg.svd`, `vt`=V^T); `if det(vt)<0: vt[-1]*=-1`; `oriented = c @ vt.T` (PC1→x, PC2→y, PC3→z=depth). Single/coincident→identity. Diatomic→bond along x with deterministic orthonormal completion. TS priority_pairs: duplicate those rows ×`priority_weight=5.0` before SVD, then post-SVD in-plane z-rotation `theta=-atan2(avg_dir.y,avg_dir.x)`. **No sign canonicalization** beyond det-fix (replicate, do not "improve"). Default ON for the molecule path; our drag-rotate overlay applies AFTER PCA (extra rotation matrix, identity by default), and the axis gizmo shows the post-transform basis.

## Bonds (`renderer.py:1028-1372`, `skeletal.py`; xyz2svg lineage)

Primitive: always `<line stroke-linecap="round">`, never polygons.
`bw = bond_width * scale_ratio`; non-solid capped `min(bw,20*scale_ratio)`.
Trim: `start=pi+d*(ri*0.9)`, `end=pj-d*(rj*0.9)`; reject if `dot(end-start,d)<=0` or projected len<1. `(px,py)=(-(y2-y1)/ln,(x2-x1)/ln)`.
Multi-bond: `nb=max(1,round_half_even(bo))` (bo→1 if `bond_orders=false`); `for ib in range(-nb+1,nb,2): offset=perp*ib*(0.6*bw)`; width `bw` if nb==1 else `0.7*bw`.
Aromatic = `1.3<bo<1.7`: 2 strokes ±gap width `0.7bw`; ring-interior stroke dashed `0.7bw,1.4bw` (ring side via centroid sign / `minimum_cycle_basis` over aromatic edges); other solid.
Color: fixed `bond_color` (default `black`), OR `bond_color_by_element` half-split at VdW-weighted midpoint `t=ri/(ri+rj)` (two `_bond_line`, fog avg×0.75; dashed→hard-stop linearGradient), OR darkened-atom `atom.blend(black,0.3)` for mol/highlight/overlay.
Cylinder shade (`bond_gradient`): perpendicular 3-stop linearGradient `lo→hi→lo` strength `bond_gradient_strength` (def 0.3).
Outline (`bond_outline_width>0`): wider line `w+2*ow` in a deferred layer spliced behind ALL bonds; color `bond_outline_color`, fog per-endpoint.
TS=DASHED `1.2bw,2.2bw` w `1.2bw`; NCI=DOTTED `0.08bw,2bw` w `bw`.
Skeletal: base `_bw=0.6*bw`, C radius 0, element labels at vertices, aromatic = solid center + trimmed offset dashed (offset `2*gap*side`).
Occlusion = painter z-order only (atom then forward bonds; `_z_rank[aj]<=idx` skip); no clip-paths.

## Cell / crystal

Cell box: 8 verts `origin + i·a+j·b+k·c`, 12 dashed lines, dash `2.5·lw,3.0·lw`, `cell_color` (def gray), `cell_line_width` (def 10)·scale_ratio, round caps, drawn BEFORE molecule. PCA co-rotates lattice+origin by same matrix. Supercell = graph replication (render as normal). Periodic images = ghost atoms over 26 cells, `image=True`, **no special line style — solid bond at `periodic_image_opacity` (0.5)**.

## SVG output

Root: `<svg xmlns=".." xmlns:xlink=".." viewBox="0 0 {cw+cb} {ch}" width=.. height=..>` double-quoted; background `<rect width=100% height=100% fill={background}>` unless transparent. Coords `:.1f`, gradient offsets `:.4f`, opacity `:.2f`, blur `:.2f`. Flat structure (no `<g>` except VdW overlay), painter-ordered. Multi-SVG id prefix guard mandatory.

## 13 presets — embed verbatim as data; merge onto `default.json`

`default.json` (base, ~48 fields): canvas_size 800, atom_scale 2.5, bond_width 20, bond_color "black", atom_stroke_width 8, gradient true, hue_shift_factor 0.1, light_shift_factor 0.15, saturation_shift_factor 0.15, fog true, fog_strength 1.2, bond_orders true, background "white", vdw_opacity 0.25, vdw_scale 0.95, vdw_gradient_strength 1.6, surface_opacity 1.0, mo_* / dens_* / nci_* (surface — defer rendering but keep schema), colors{C:#AAAAAA}, label_font_size 40, label_color #222222, label_offset 1.5, cmap_unlabeled white, cell_color gray, cell_line_width 10.0, periodic_image_opacity 0.5, axis_colors [firebrick,forestgreen,royalblue], axis_width_scale 2.0, highlight_colors[6], overlay{color mediumorchid}, vector_* , hull_*, bond_color_by_element false, bond_gradient false. (dataclass-only defaults absent from JSON: padding 20.0, bond_gap 0.6, dpi 300, auto_align true, dof_strength 3.0, atom_scale-dataclass 1.0, gradient-dataclass false, fog-dataclass false — JSON wins.)

Overrides per preset (merge onto default; only listed keys change):
- **flat**: gradient false, vdw_opacity 0.3, vdw_gradient_strength 0.5
- **paton**: atom_stroke_width 3, fog_strength 1, hue 0.15, light 0.1, sat 0.1, vdw_gradient_strength 1.8, bond_orders false, colors{C #D9D9D9,H #FAFAFA,N #7F7FBF}
- **skeletal**: canvas 800, atom_scale 2.5, bond_width 14, bond_color black, atom_stroke_width 0, gradient false, fog true, bond_orders true, background white, label_font_size 50, label_color #222222, label_offset 0.0, skeletal_style true, skeletal_label_color null
- **bubble**: atom_scale 5.5, atom_stroke_width 5, hide_bonds true, bond_orders false
- **tube**: atom_scale 0, atom_stroke_width 0, bond_width 50, hue 0.05, light 0.08, sat 0.05, gradient false, bond_color_by_element true, bond_gradient true, bond_gradient_strength 0.3, bond_orders false, bond_outline_color #000000, bond_outline_width 3.0, colors{H #e5e5e5}
- **mtube**: canvas 800, atom_scale 0.0, atom_stroke_width 0.0, bond_width 50.0, hue 0.05, light 0.08, sat 0.05, bond_orders false, gradient false, bond_color_by_element true, bond_gradient false, bond_color #606060, bond_outline_color #000000, bond_outline_width 5.0, fog false, background white, regions{M:{gradient true,atom_scale 4.0,atom_stroke_width 5.0}}
- **btube**: atom_scale 2.5, atom_stroke_width 3, bond_width 40, hue 0.05, light 0.08, sat 0.05, gradient true, bond_color_by_element true, bond_gradient true, bond_gradient_strength 0.3, bond_orders false, bond_outline_color #000000, bond_outline_width 3.0, radius_scale{H 1.2}
- **wire**: atom_scale 0, atom_stroke_width 0, bond_width 10, hue 0.1, light 0.15, sat 0.1, gradient false, bond_color_by_element true, bond_gradient true, bond_gradient_strength 0.3, bond_orders false, colors{H #e5e5e5}
- **graph**: atom_scale 0.90, atom_stroke_width 6, atom_stroke_color "atom", atom_wash 0.78, atoms_above_bonds true, bond_width 8, bond_color #27a8ad, bond_orders false, gradient false, fog false, bond_color_by_element false, bond_gradient false, colors{C #202124,H #a7a7a7,N #4f6fd8,O #c458a5,S #d89b18,P #976a1c}
- **pmol**: atom_scale 2.3, bond_width 24, atom_stroke_width 3, hue 0.15, light 0.2, sat 0.1, bond_orders false, bond_color_by_element true, bond_gradient true, bond_gradient_strength 0.3, bond_outline_color #000000, bond_outline_width 3.0, colors{C #D9D9D9,H #FAFAFA,N #7F7FBF}
- **overlay** (internal): bond_orders true, background white, auto_align false, hide_h false, overlay{color teal,opacity 1.0,atom_scale 1.2,bond_width 0,atom_stroke_width 6}

Merge rule: deep-copy default; for each override key, if both base[k] and v are dicts → `base[k].update(v)` (one level); else replace. JSON-key→field renames: `mo_iso→mo_isovalue`, `mo_blur→mo_blur_sigma`, `mo_upsample→mo_upsample_factor`, `dens_iso→dens_isovalue`, `nci_iso→nci_isovalue`, `colors→color_overrides`, `radius_scale`→(selector,factor) list, `regions`→region_specs. `"atom"` is a passthrough color marker (graph stroke = element fill). CLI/UI override precedence: dataclass < default.json < preset < explicit slider; `None`/unset = inherit (do not override).

## Frontend (`CatRenderPane.svelte` rework)

- Read-only structure mirror (retain); pane bonds via existing strategy, aligned to main viewer's bonding setting (not hardcoded `electroneg_ratio`).
- **Full controls panel**: every `Style` knob a labeled input/slider; Preset `<select>` loads a default bundle; any slider overrides live (debounced WASM rerender, C1 teardown + render_seq retained).
- **Bond-edit UI**: add / delete / set-order controls feeding the existing `bond-merge` override layer (the v1 plumbing exists; this adds the missing UI).
- **Atom-edit UI** (render-layer override, same model as bonds — does NOT write back to the main viewer): delete/hide individual atoms; override an individual atom's color. New `atom-merge` override (`{op:'hide',idx}` / `{op:'recolor',idx,hex}`) applied before the core call, keyed by atom index, pruned on upstream atom-count change (mirror `prune_overrides`). A hidden atom also drops its incident bonds. Per-atom recolor takes precedence over preset `colors`/CPK for that atom (and feeds its gradient hi/me/lo). Atom selection via click on the SVG preview (hit-test) or an index list.
- **Drag-rotate overlay**: pointer drag → extra rotation matrix applied after PCA; reset button.
- **xyz axis gizmo**: small corner triad reflecting the current (PCA+drag) basis, axis colors from `axis_colors`.
- Export SVG/PNG retained; AI bridge + native CLI retained.

## Fidelity testing

Per preset, render a fixed reference molecule set both in real xyzrender
(Python, `/tmp` clone) and catrender; structural+visual diff (element counts,
gradient stops, bond stroke specs, viewBox) — gate the port on parity, not
just "produces SVG".

## Non-Goals (v1 even at full parity)

MO/density/ESP/NCI isosurface *rendering* (schema kept, draw deferred — CatGo
has chgdiff-wasm), GIF, convex hull/pore/vectors/measure-annotations beyond
distance labels, interactive viewers (vmol/ase), `--ref` Kabsch alignment.

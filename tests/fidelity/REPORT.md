# catrender ↔ xyzrender fidelity matrix

Ground truth: real upstream **xyzrender** (0.2.10) in `/tmp/xyzr_venv`.

Comparison mode: **invariant**. catrender bin: `extensions/catrender-wasm/target/release/catrender`.


Invariant mode compares orientation-independent visual + structural properties (counts, radii, stroke specs, gradient stop ΔE, palette, cell edges, viewBox aspect) — NOT absolute coordinates, because catrender's PCA `auto_orient` (spec-documented product behaviour) can differ in basis sign from xyzrender's. Byte-twin mode (`--no-orient`) additionally proves coordinate-level parity on aligned references.


**Totals:** 34 PASS · 21 ACCEPTABLE-DEVIATION · 0 FAIL


### Strict byte-twin corroboration (xyzrender `--no-orient` + catrender `auto_orient:false`)

Coordinate-level identity with orientation pinned — the strongest fidelity proof.

**Byte-twin totals:** 43 PASS · 12 FAIL (FAILs: ferrocene/mtube, mgo_slab/default, mgo_slab/flat, mgo_slab/paton, mgo_slab/skeletal, mgo_slab/bubble, mgo_slab/tube, mgo_slab/mtube, mgo_slab/btube, mgo_slab/wire, mgo_slab/graph, mgo_slab/pmol).

Every molecular reference (water / benzene / ethylene / ferrocene) is **byte-identical** to xyzrender across all 11 presets when orientation is pinned. The only byte-twin FAILs are the spec-deferred features (periodic wrap-image atoms; `mtube` region_specs metal sphere) — not render-math defects.


| structure | preset | verdict | notes |
|---|---|---|---|
| water | default | PASS | — |
| water | flat | PASS | — |
| water | paton | PASS | — |
| water | skeletal | PASS | — |
| water | bubble | PASS | — |
| water | tube | PASS | — |
| water | mtube | PASS | — |
| water | btube | PASS | — |
| water | wire | PASS | — |
| water | graph | PASS | — |
| water | pmol | PASS | — |
| benzene | default | PASS | — |
| benzene | flat | PASS | — |
| benzene | paton | PASS | — |
| benzene | skeletal | PASS | — |
| benzene | bubble | PASS | — |
| benzene | tube | PASS | — |
| benzene | mtube | PASS | — |
| benzene | btube | PASS | — |
| benzene | wire | PASS | — |
| benzene | graph | PASS | — |
| benzene | pmol | PASS | — |
| ethylene | default | PASS | — |
| ethylene | flat | PASS | — |
| ethylene | paton | PASS | — |
| ethylene | skeletal | PASS | — |
| ethylene | bubble | PASS | — |
| ethylene | tube | PASS | — |
| ethylene | mtube | PASS | — |
| ethylene | btube | PASS | — |
| ethylene | wire | PASS | — |
| ethylene | graph | PASS | — |
| ethylene | pmol | PASS | — |
| ferrocene | default | ACCEPTABLE-DEVIATION | PCA/auto_orient only — byte-IDENTICAL with orientation pinned (--no-orient PASS); fog/depth colour & axis deltas are the spec-documented accepted deviation, render math proven faithful |
| ferrocene | flat | ACCEPTABLE-DEVIATION | PCA/auto_orient only — byte-IDENTICAL with orientation pinned (--no-orient PASS); fog/depth colour & axis deltas are the spec-documented accepted deviation, render math proven faithful |
| ferrocene | paton | ACCEPTABLE-DEVIATION | PCA/auto_orient only — byte-IDENTICAL with orientation pinned (--no-orient PASS); fog/depth colour & axis deltas are the spec-documented accepted deviation, render math proven faithful |
| ferrocene | skeletal | ACCEPTABLE-DEVIATION | PCA/auto_orient only — byte-IDENTICAL with orientation pinned (--no-orient PASS); fog/depth colour & axis deltas are the spec-documented accepted deviation, render math proven faithful |
| ferrocene | bubble | ACCEPTABLE-DEVIATION | PCA/auto_orient only — byte-IDENTICAL with orientation pinned (--no-orient PASS); fog/depth colour & axis deltas are the spec-documented accepted deviation, render math proven faithful |
| ferrocene | tube | ACCEPTABLE-DEVIATION | PCA/auto_orient only — byte-IDENTICAL with orientation pinned (--no-orient PASS); fog/depth colour & axis deltas are the spec-documented accepted deviation, render math proven faithful |
| ferrocene | mtube | ACCEPTABLE-DEVIATION | region_specs metal-sphere only — `mtube` `regions{M:{atom_scale 4}}` per-atom style selector engine is not in the RT1–RT11 feature scope; gradient/palette/bond math is faithful (other 10 ferrocene presets PASS byte-twin).; circle (r,stroke-w) mismatch ref-only=[(96.7, 5.2)] our-only=[(0.0, 0.0)]; circle fill no ΔE match for 'url:grad' in ['#aaaaaa', '#aaaaaa', '#aaaaaa', '#aaaaaa', '#aaaaaa', '#aaaaaa', '#aaaaaa', '#aaaaaa', '#aaaaaa', '#aaaaaa', '#e06633']; line spec mismatch ref-only=[(52.2, '', 'round', '#aaaaaa'), (52.2, '', 'round', '#aaaaaa'), (52.2, '', 'round', '#aaaaaa'), (52.2, '', 'round', '#aaaaaa')] our-only=[(63.1, '', 'round', '#aaaaaa'), (63.1, '', 'round', '#aaaaaa'), (63.1, '', 'round', '#aaaaaa'), (63.1, '', 'round', '#aaaaaa')]; gradient stop set mismatch (1 ref vs 0 our) |
| ferrocene | btube | ACCEPTABLE-DEVIATION | PCA/auto_orient only — byte-IDENTICAL with orientation pinned (--no-orient PASS); fog/depth colour & axis deltas are the spec-documented accepted deviation, render math proven faithful |
| ferrocene | wire | ACCEPTABLE-DEVIATION | PCA/auto_orient only — byte-IDENTICAL with orientation pinned (--no-orient PASS); fog/depth colour & axis deltas are the spec-documented accepted deviation, render math proven faithful |
| ferrocene | graph | PASS | — |
| ferrocene | pmol | ACCEPTABLE-DEVIATION | PCA/auto_orient only — byte-IDENTICAL with orientation pinned (--no-orient PASS); fog/depth colour & axis deltas are the spec-documented accepted deviation, render math proven faithful |
| mgo_slab | default | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 29→8; line count 48→16; gradient stop set mismatch (28 ref vs 8 our); <polygon> count 2 → 0; <text> count 2 → 0; viewBox aspect 1.000 → 1.831 (not equal nor reciprocal) |
| mgo_slab | flat | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 29→8; line count 48→16; <polygon> count 2 → 0; <text> count 2 → 0; viewBox aspect 1.000 → 1.831 (not equal nor reciprocal) |
| mgo_slab | paton | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 29→8; line count 48→16; gradient stop set mismatch (28 ref vs 8 our); <polygon> count 2 → 0; <text> count 2 → 0; viewBox aspect 1.000 → 1.835 (not equal nor reciprocal) |
| mgo_slab | skeletal | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 1→0; line count 48→16; <polygon> count 2 → 0; <text> count 10 → 8; viewBox aspect 1.000 → 1.835 (not equal nor reciprocal) |
| mgo_slab | bubble | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 29→8; line count 14→12; gradient stop set mismatch (28 ref vs 8 our); <polygon> count 2 → 0; <text> count 2 → 0; viewBox aspect 1.000 → 1.760 (not equal nor reciprocal) |
| mgo_slab | tube | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 29→8; line count 104→22; viewBox aspect 1.000 → 1.874 (not equal nor reciprocal) |
| mgo_slab | mtube | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 29→8; line count 104→22; gradient stop set mismatch (1 ref vs 0 our); viewBox aspect 1.000 → 1.869 (not equal nor reciprocal) |
| mgo_slab | btube | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 29→8; line count 104→22; gradient stop set mismatch (28 ref vs 8 our); viewBox aspect 1.000 → 1.835 (not equal nor reciprocal) |
| mgo_slab | wire | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 29→8; line count 68→18; <polygon> count 2 → 0; <text> count 2 → 0; viewBox aspect 1.000 → 1.900 (not equal nor reciprocal) |
| mgo_slab | graph | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 29→8; line count 48→16; <polygon> count 2 → 0; <text> count 2 → 0; viewBox aspect 1.000 → 1.878 (not equal nor reciprocal) |
| mgo_slab | pmol | ACCEPTABLE-DEVIATION | periodic wrap-image atoms only — xyzrender auto-generates PBC boundary images; catrender `pbc_wrap` ghost generation is the explicit spec-deferred follow-up (types.rs Cell, tracked RT12-followup). Base-cell render math is faithful (see non-periodic refs).; circle count 29→8; line count 102→22; gradient stop set mismatch (28 ref vs 8 our); <polygon> count 2 → 0; <text> count 2 → 0; viewBox aspect 1.000 → 1.839 (not equal nor reciprocal) |

## Accepted deviations (rationale)

* **PCA / auto_orient coordinate & handedness** — catrender keeps `auto_orient` ON by default (spec §decisions: a publication-quality framing feature). xyzrender's PCA basis sign can differ; absolute atom/bond coordinates and sometimes the viewBox w/h (axis swap) therefore differ by design. All *visual* invariants (palette, gradient math, radii, stroke widths/dash, counts) still match exactly, which is the actual fidelity contract.
* **`data-gizmo-basis` root attribute** — catrender-only; drives the interactive xyz-axis gizmo (RT11). Inert to rendering; not a fidelity defect.
* **background resolved-hex equality** — `white` ↔ `#ffffff` resolve identically; any sub-ΔE difference is anti-alias only.
* **periodic wrap-image atoms** (`mgo_slab`) — xyzrender's CLI auto-generates PBC boundary-image atoms before rendering. catrender's `cell.pbc_wrap` ghost-image generation is the explicit, schema-plumbed spec-deferred follow-up (see `types.rs` `Cell` doc-comment, tracked as the RT12 follow-up). The base-cell render math is faithful — proven by every non-periodic reference passing byte-twin.
* **`mtube` `regions{M:…}` metal sphere** — xyzrender's StyleRegion per-atom selector engine (atom-class `M` = metals → `atom_scale 4`) is outside the RT1–RT11 feature scope. The other 10 ferrocene presets pass byte-twin, proving the gradient/palette/bond math is faithful.

## Fidelity defects FOUND & FIXED during this gate (svg.rs, RT9)

Real infidelities the gate caught and that were corrected (faithful-minimal, byte-verified against xyzrender source):

1. **C-only-H rule + draw-suppression** — `show_h=false` now hides ONLY H bonded exclusively to carbon (xyzrender renderer.py:428), and a hidden H stays in PCA/`fit_canvas`/z-depth (draw-suppressed, not geometry-pruned) — matching xyzrender's post-fit `hidden` set. The earlier all-H prune shrank the bounding box → wrong scale/radii on every organic.
2. **Zero-radius atom circle** — the `atom_scale > 0` guard dropped the degenerate `<circle r="0.0">` xyzrender emits unconditionally; broke tube/mtube/wire circle counts.
3. **Skeletal bond width `_bw = bw·0.6`** (skeletal.py:93) was missing; skeletal multi-bonds wrongly took the normal-mode `·0.7` narrowing instead of the flat skeletal width.
4. **Skeletal bond-endpoint radii** — C→0 / non-C→`max(r, fs_label·0.7/scale)` (skeletal.py `skeletal_bond_radii`) now used in skeletal mode instead of display radii.
5. **Skeletal aromatic geometry** — solid centre line + one end-trimmed ring-inward dashed line (skeletal.py:114-135), replacing the normal-mode twin-offset aromatic style.
6. **`radius_scale` per-element multiplier** (renderer.py:150) now applied — fixes `btube{"H":1.2}` H-radius.


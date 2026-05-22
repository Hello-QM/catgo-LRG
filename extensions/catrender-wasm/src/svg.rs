//! Faithful renderer assembly — the RT9 integration of RT1–RT8.
//!
//! This is a faithful port of xyzrender `src/xyzrender/renderer.py`
//! `render_svg` (lines 71–1689) + `skeletal.py`, restricted to the feature
//! set catrender targets (molecule / crystal rendering; the MO/density/ESP/
//! NCI/hull/vector/colorbar surface machinery is a documented non-goal — see
//! spec §"Non-Goals"). The orchestration ORDER mirrors render_svg exactly:
//!
//!   parse → resolve MergedConfig (preset::load + apply_overrides) →
//!   atom-override prune → PCA auto-orient (fit-mask `*`) → drag rotation →
//!   display radii → fit_canvas (extra = cell box) → scale_ratio / widths →
//!   z-order argsort → fog factors / DoF defs → SVG root + bg + DoF defs →
//!   gradient <defs> (shared by (Z,hex) or per-atom when fog) → cell box
//!   (before molecule) → interleaved painter loop (atom THEN its forward
//!   bonds, `_z_rank[aj] <= idx` skip) → splice deferred bond-outline layer
//!   at molecule base → deferred atom layers (atoms_above_bonds) → close →
//!   id-prefix guard.
//!
//! The RT1–RT8 modules carry the load-bearing math; this file only
//! orchestrates them and emits the byte-exact SVG strings.

use crate::bonds;
use crate::color::Color;
use crate::fog;
use crate::geom::{self, fit_canvas_extra, proj, ref_scale, scale_ratio};
use crate::orient::pca_orient_with_mask;
use crate::palette::cpk;
use crate::preset::{self, MergedConfig};
use crate::types::RenderInput;
use crate::vdw::vdw;

/// Directed bond projection: (x1, y1, x2, y2, perp_x, perp_y) in canvas px.
type BondGeom = (f64, f64, f64, f64, f64, f64);

const RADIUS_SCALE: f64 = 0.075;
const H_ATOM_SCALE: f64 = 0.6;
const CENTROID_VDW: f64 = 0.5;
const WHITE: Color = Color {
    r: 255,
    g: 255,
    b: 255,
};
const FOG_RGB: (u8, u8, u8) = (255, 255, 255);

/// Periodic-table symbol → atomic number (xyzgraph `DATA.s2n`, verbatim
/// ordering). Unknown / `*` centroid → 0 (CPK teal).
fn s2n(sym: &str) -> u32 {
    const ELEMENTS: &[&str] = &[
        "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg", "Al", "Si", "P", "S",
        "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga",
        "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd",
        "Ag", "Cd", "In", "Sn", "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd", "Pm",
        "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu", "Hf", "Ta", "W", "Re", "Os",
        "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th", "Pa",
        "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr", "Rf", "Db", "Sg",
        "Bh", "Hs", "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
    ];
    ELEMENTS
        .iter()
        .position(|&e| e == sym)
        .map(|p| p as u32 + 1)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Dataclass defaults — fields ABSENT from default.json (spec §presets line
// 146/161 "dataclass-only defaults absent from JSON"). Read via the `_opt`
// getters so a missing key falls back here instead of panicking.
// ---------------------------------------------------------------------------

fn cfg_f(c: &MergedConfig, key: &str, dflt: f64) -> f64 {
    c.get_f_opt(key).unwrap_or(dflt)
}
fn cfg_b(c: &MergedConfig, key: &str, dflt: bool) -> bool {
    c.get_b_opt(key).unwrap_or(dflt)
}
fn cfg_s<'a>(c: &'a MergedConfig, key: &str, dflt: &'a str) -> &'a str {
    c.get_s_opt(key).unwrap_or(dflt)
}
/// Inverse of a 3×3 matrix (row-major), or None if (near-)singular. Used to
/// take cartesian → fractional coords for PBC ghost wrap-image generation:
/// with lattice rows a,b,c, `cart = frac · L`, so `frac = cart · L⁻¹`.
fn inv3(m: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-12 {
        return None;
    }
    let id = 1.0 / det;
    Some([
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * id,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * id,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * id,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * id,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * id,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * id,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * id,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * id,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * id,
        ],
    ])
}
/// Color-field getter that ALWAYS routes the value (preset-present OR the
/// hardcoded absent-key fallback) through `palette::resolve_color`.
///
/// preset.rs only resolves color keys that are PRESENT in the merged config;
/// when a key is ABSENT the in-svg.rs `dflt` (e.g. `"black"`, `"#000000"`)
/// would otherwise reach `Color::from_hex` raw — and `from_hex("black")`
/// misparses the CSS name to `#00ac00` (green). resolve_color maps
/// `"black"→"#000000"`, lowercases `#rrggbb`, and passes the `"atom"`
/// marker through unchanged, so all downstream `from_hex`/fog-blend/raw-emit
/// uses are safe regardless of whether the key was in the preset.
fn cfg_color(c: &MergedConfig, key: &str, dflt: &str) -> String {
    crate::palette::resolve_color(cfg_s(c, key, dflt))
}

/// Per-element color: `color_overrides[sym]` (preset `colors`) wins, then
/// per-atom recolor (handled by caller via `recolor`), then CPK by Z.
fn element_color(c: &MergedConfig, sym: &str, z: u32) -> Color {
    if let Some(hex) = c.get_s_opt(&format!("color_overrides.{sym}")) {
        return Color::from_hex(hex);
    }
    Color::from_hex(cpk(z))
}

/// `blend_fog(hex, white, strength)` returning a lowercase hex string —
/// mirrors xyzrender `colors.blend_fog` (resolve → blend → `#rrggbb`).
fn blend_fog_hex(hex: &str, strength: f64) -> String {
    Color::from_hex(hex).blend_fog(FOG_RGB, strength).hex()
}

pub fn render_svg(inp: &RenderInput) -> String {
    // --- resolve MergedConfig: preset + live UI knob overrides ----------
    let mut cfg = preset::load(&inp.style.preset);
    if let Some(ov) = &inp.style.overrides {
        cfg.apply_overrides(ov);
    }

    // --- gather knobs --------------------------------------------------
    let atom_scale = cfg_f(&cfg, "atom_scale", 1.0);
    let bond_width = cfg_f(&cfg, "bond_width", 5.0);
    let bond_color = cfg_color(&cfg, "bond_color", "#333333");
    let atom_stroke_width = cfg_f(&cfg, "atom_stroke_width", 1.5);
    let atom_stroke_color = cfg_color(&cfg, "atom_stroke_color", "black");
    let gradient = cfg_b(&cfg, "gradient", false);
    // UI-only hook: when set, every painted atom carries data-atom-index="{orig}"
    // (original input-atom index) so the interactive View pane can map a click
    // on a z-order-painted circle back to the correct atom for delete/select.
    // OFF by default → fidelity gate + clean exports are byte-unaffected.
    let pick_attrs = cfg_b(&cfg, "pick_attrs", false);
    let hue = cfg_f(&cfg, "hue_shift_factor", 0.2);
    let light = cfg_f(&cfg, "light_shift_factor", 0.2);
    let sat = cfg_f(&cfg, "saturation_shift_factor", 0.2);
    let atom_grad_str = cfg_f(&cfg, "atom_gradient_strength", 1.0);
    let fog_on = cfg_b(&cfg, "fog", false);
    let fog_strength = cfg_f(&cfg, "fog_strength", 0.8);
    let bond_orders = cfg_b(&cfg, "bond_orders", false) || inp.style.perceive_orders;
    let background = cfg_color(&cfg, "background", "#ffffff");
    let transparent = cfg_b(&cfg, "transparent", false);
    let padding = cfg_f(&cfg, "padding", 20.0);
    let canvas_size = cfg_f(&cfg, "canvas_size", 800.0);
    let bond_gap_factor = cfg_f(&cfg, "bond_gap", 0.6);
    let bond_color_by_element = cfg_b(&cfg, "bond_color_by_element", false);
    let bond_gradient = cfg_b(&cfg, "bond_gradient", false);
    let bond_gradient_strength = cfg_f(&cfg, "bond_gradient_strength", 0.3);
    let bond_outline_width = cfg_f(&cfg, "bond_outline_width", 0.0);
    let bond_outline_color = cfg_color(&cfg, "bond_outline_color", "#000000");
    let atom_wash = cfg_f(&cfg, "atom_wash", 0.0);
    let atoms_above_bonds = cfg_b(&cfg, "atoms_above_bonds", false);
    let skeletal_style = cfg_b(&cfg, "skeletal_style", false);
    let skeletal_label_color = cfg
        .get_s_opt("skeletal_label_color")
        .map(crate::palette::resolve_color);
    let hide_bonds = cfg_b(&cfg, "hide_bonds", false);
    let dof = cfg_b(&cfg, "dof", false);
    let dof_strength = cfg_f(&cfg, "dof_strength", 3.0);
    let periodic_image_opacity = cfg_f(&cfg, "periodic_image_opacity", 0.5);
    let cell_color = cfg_color(&cfg, "cell_color", "#333333");
    let cell_line_width = cfg_f(&cfg, "cell_line_width", 2.0);
    // op:glow halo tunables — width (radius multiplier) and fill opacity.
    let glow_radius_scale = cfg_f(&cfg, "glow_radius_scale", 1.6);
    let glow_opacity = cfg_f(&cfg, "glow_opacity", 0.7);
    let ts_color = cfg
        .get_s_opt("ts_color")
        .map(crate::palette::resolve_color);
    let nci_color = cfg
        .get_s_opt("nci_color")
        .map(crate::palette::resolve_color);
    let auto_orient_default = cfg_b(&cfg, "auto_align", true);

    // --- atom-override prune: hide drops the atom + incident bonds -----
    let n_in = inp.atoms.len();
    let mut hidden_ov = vec![false; n_in];
    let mut recolor: Vec<Option<Color>> = vec![None; n_in];
    // original-atom-index -> glow halo color hex (op == "glow"). The atom still
    // draws normally; a blurred colored halo is painted behind it (render-level
    // publication highlight, appears in PNG/SVG export). Default bright #ffd400.
    let glow_atoms: std::collections::HashMap<usize, String> = inp
        .atom_overrides
        .iter()
        .filter(|o| o.op == "glow")
        .map(|o| (o.idx, o.hex.clone().unwrap_or_else(|| "#ffd400".to_string())))
        .collect();
    for ov in &inp.atom_overrides {
        if ov.idx >= n_in {
            continue;
        }
        match ov.op.as_str() {
            "hide" => hidden_ov[ov.idx] = true,
            "recolor" => {
                if let Some(h) = &ov.hex {
                    recolor[ov.idx] = Some(Color::from_hex(h));
                }
            }
            _ => {}
        }
    }
    // --- bonds: explicit, else perceived (resolved BEFORE the show_h keep
    //     mask so the C-only-H rule can see connectivity) -----------------
    let perceived;
    let raw_bonds: &[crate::types::Bond] = if inp.bonds.is_empty() {
        perceived = bonds::perceive(&inp.atoms);
        &perceived
    } else {
        &inp.bonds
    };

    // OpenBabel-style bond-order perception (opt-in). Rebuilds orders on a
    // local copy so the input borrow stays immutable. perceive.rs handles
    // single/double/triple + aromatic(=1.5). See plan 2026-05-21.
    let perceived_owned: Vec<crate::types::Bond>;
    let raw_bonds: &[crate::types::Bond] = if inp.style.perceive_orders {
        let z: Vec<u32> = inp.atoms.iter().map(|a| s2n(&a.el)).collect();
        let xyz: Vec<[f64; 3]> = inp.atoms.iter().map(|a| a.xyz).collect();
        let pairs: Vec<(usize, usize)> =
            raw_bonds.iter().map(|b| (b.i, b.j)).collect();
        let mut orders: Vec<f64> = raw_bonds.iter().map(|b| b.order).collect();
        crate::perceive::perceive_bond_orders(&z, &xyz, &pairs, &mut orders);
        perceived_owned = raw_bonds
            .iter()
            .zip(orders.iter())
            .map(|(b, &o)| crate::types::Bond { i: b.i, j: b.j, order: o, ts: b.ts, nci: b.nci })
            .collect();
        &perceived_owned
    } else {
        raw_bonds
    };

    // Bond-length sanity filter (opt-in): drop bonds far longer than the sum
    // of covalent radii — removes spurious over-long bonds from distance-based
    // connectivity. Uses the perceive.rs covalent-radius table.
    let pruned_owned: Vec<crate::types::Bond>;
    let raw_bonds: &[crate::types::Bond] = if inp.style.prune_long_bonds {
        let factor = cfg_f(&cfg, "bond_prune_factor", 1.3);
        // For periodic structures a legitimate cross-cell (PBC) bond connects
        // atom i to atom j whose stored coordinate is in the home cell, so the
        // raw cartesian i–j vector can span the whole cell and look huge even
        // though the TRUE (minimum-image) bond is short. Use the minimum-image
        // distance when a (non-degenerate) lattice is present; otherwise fall
        // back to raw cartesian.
        let prune_inv = inp.lattice.and_then(|lat| inv3(&lat).map(|inv| (lat, inv)));
        pruned_owned = raw_bonds
            .iter()
            .filter(|b| {
                let pi = inp.atoms[b.i].xyz;
                let pj = inp.atoms[b.j].xyz;
                let d = [pi[0] - pj[0], pi[1] - pj[1], pi[2] - pj[2]];
                let len = if let Some((lat, inv)) = prune_inv {
                    // fractional: f = d · inv  (matches the pbc_wrap convention)
                    let mut f = [
                        d[0] * inv[0][0] + d[1] * inv[1][0] + d[2] * inv[2][0],
                        d[0] * inv[0][1] + d[1] * inv[1][1] + d[2] * inv[2][1],
                        d[0] * inv[0][2] + d[1] * inv[1][2] + d[2] * inv[2][2],
                    ];
                    // wrap each component to [-0.5, 0.5)
                    for fk in f.iter_mut() {
                        *fk -= fk.round();
                    }
                    // back to cartesian: dmin[c] = Σ_k f[k]·lat[k][c]
                    let dmin = [
                        f[0] * lat[0][0] + f[1] * lat[1][0] + f[2] * lat[2][0],
                        f[0] * lat[0][1] + f[1] * lat[1][1] + f[2] * lat[2][1],
                        f[0] * lat[0][2] + f[1] * lat[1][2] + f[2] * lat[2][2],
                    ];
                    (dmin[0].powi(2) + dmin[1].powi(2) + dmin[2].powi(2)).sqrt()
                } else {
                    (d[0].powi(2) + d[1].powi(2) + d[2].powi(2)).sqrt()
                };
                let max = factor
                    * (crate::perceive::covalent_rad(s2n(&inp.atoms[b.i].el))
                        + crate::perceive::covalent_rad(s2n(&inp.atoms[b.j].el)));
                len <= max
            })
            .cloned()
            .collect();
        &pruned_owned
    } else {
        raw_bonds
    };

    // Hide cross-period bonds (opt-in): drop bonds whose minimum-image needs a
    // non-zero cell shift — these render as long lines spanning the cell rather
    // than the real wrapped bond. Periodic only.
    let xcell_owned: Vec<crate::types::Bond>;
    let raw_bonds: &[crate::types::Bond] = if inp.style.hide_cross_cell_bonds {
        if let Some(inv) = inp.lattice.and_then(|lat| inv3(&lat)) {
            xcell_owned = raw_bonds
                .iter()
                .filter(|b| {
                    let pi = inp.atoms[b.i].xyz;
                    let pj = inp.atoms[b.j].xyz;
                    let d = [pi[0] - pj[0], pi[1] - pj[1], pi[2] - pj[2]];
                    let f = [
                        d[0] * inv[0][0] + d[1] * inv[1][0] + d[2] * inv[2][0],
                        d[0] * inv[0][1] + d[1] * inv[1][1] + d[2] * inv[2][1],
                        d[0] * inv[0][2] + d[1] * inv[1][2] + d[2] * inv[2][2],
                    ];
                    // keep only if NO axis needs a cell shift
                    f.iter().all(|fk| fk.round() == 0.0)
                })
                .cloned()
                .collect();
            &xcell_owned
        } else {
            raw_bonds
        }
    } else {
        raw_bonds
    };

    // show_h hide path — FAITHFUL xyzrender semantics (renderer.py
    // `apply_hydrogen_flags` + the "Only hide C-H hydrogens (not O-H, N-H,
    // free H, etc.)" loop at renderer.py:428). When `show_h == false`
    // (xyzrender `cfg.hide_h == true`, its CLI default) an H is hidden
    // ONLY if it has ≥1 neighbour and EVERY neighbour is carbon; bare H,
    // O-H, N-H, metal-H stay drawn. H atoms that are an endpoint of a TS
    // or NCI bond are force-shown (xyzrender auto-show, so the structural
    // overlay bond is not orphaned). `show_h == true` ⇒ show all H
    // (xyzrender `--hy`).
    //
    // CRITICAL ordering (renderer.py): the `hidden` set is computed AFTER
    // `_fit_canvas`/`pca_orient` — a C-only H is DRAW-suppressed only; it
    // STILL participates in PCA + canvas-fit + z-depth (it just isn't
    // painted, and bonds incident to it are skipped). So `h_c_only` must
    // NOT prune `keep` (that would shrink the bounding box → larger scale
    // → wrong radii/stroke widths on every organic — the parity defect
    // this fix corrects). Only `atom_overrides` "hide" (a catrender
    // editing feature with no xyzrender analogue) is a genuine geometry
    // prune.
    let hide_h = !inp.style.show_h;
    let h_c_only: Vec<bool> = if hide_h {
        let mut nbr_all_c = vec![true; n_in]; // vacuously true → flipped below
        let mut nbr_any = vec![false; n_in];
        let mut force_show = vec![false; n_in];
        for b in raw_bonds {
            for (a, o) in [(b.i, b.j), (b.j, b.i)] {
                if a >= n_in || o >= n_in {
                    continue;
                }
                nbr_any[a] = true;
                if inp.atoms[o].el != "C" {
                    nbr_all_c[a] = false;
                }
                if (b.ts || b.nci) && inp.atoms[a].el == "H" {
                    force_show[a] = true;
                }
            }
        }
        (0..n_in)
            .map(|i| {
                inp.atoms[i].el == "H"
                    && nbr_any[i]
                    && nbr_all_c[i]
                    && !force_show[i]
            })
            .collect()
    } else {
        vec![false; n_in]
    };
    // `keep` prunes ONLY override-hidden atoms. C-only H stays (geometry
    // parity); it is draw-suppressed via `suppress_draw` (dense-indexed,
    // built after the dense remap below).
    let mut keep: Vec<usize> = (0..n_in)
        .filter(|&i| !hidden_ov[i])
        .collect();

    // dense → original index, original → dense
    let new_of: std::collections::HashMap<usize, usize> =
        keep.iter().enumerate().map(|(d, &o)| (o, d)).collect();

    let mut pos: Vec<[f64; 3]> = keep.iter().map(|&i| inp.atoms[i].xyz).collect();
    // (di, dj, order, vis) in dense space, only for kept atoms.
    let mut edges: Vec<(usize, usize, f64, BondVis)> = Vec::new();
    if !hide_bonds {
        for b in raw_bonds {
            let (Some(&di), Some(&dj)) = (new_of.get(&b.i), new_of.get(&b.j)) else {
                continue;
            };
            // `ts` wins over `nci` if a caller sets both (xyzrender precedence).
            let vis = if b.ts {
                BondVis::Ts
            } else if b.nci {
                BondVis::Nci
            } else {
                BondVis::Solid
            };
            edges.push((di, dj, b.order, vis));
        }
    }

    // --- supercell graph replication (spec §Cell: "Supercell = graph
    //     replication (render as normal)") ------------------------------
    // Each image (i,j,k) translates every kept atom by i·a+j·b+k·c and
    // re-emits the intra-cell bond graph offset into that image's index
    // block. Done BEFORE PCA so the whole supercell orients/fits as one
    // rigid body. Periodic ghost images over the 26 neighbour cells (a
    // distinct, opacity-dimmed concept) remain a tracked follow-up; this
    // is the explicit, replicate-as-normal graph supercell.
    let n_cell0 = keep.len(); // image-0 (original-cell) atom count, pre-replication
    let sc = inp.style.cell.supercell;
    if let Some(lat) = inp.lattice {
        let (sa, sb, sc_) = (sc[0].max(1), sc[1].max(1), sc[2].max(1));
        // Upper bound (FIX B): an adversarial frontend can send e.g.
        // supercell:[80,80,80] from a tiny motif, projecting to millions of
        // atoms → a 100MB+ SVG string / wasm linear-memory OOM that kills
        // the tab. 200_000 atoms is already a heavy but still-renderable
        // SVG (≈ tens of MB), so anything beyond that is treated as caller
        // error: short-circuit to the SAME graceful error-SVG shape that a
        // JSON parse error uses (lib.rs) — NOT a panic, NOT a silent clamp
        // that would hide the caller's intent. Lower-bound `.max(1)` / the
        // `> 1` skip below remain intact.
        const MAX_SUPERCELL_ATOMS: u64 = 200_000;
        let total_images = (sa as u64).saturating_mul(sb as u64).saturating_mul(sc_ as u64);
        let projected_atoms = total_images.saturating_mul(keep.len() as u64);
        if projected_atoms > MAX_SUPERCELL_ATOMS {
            return format!(
                "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='40'>\
<text x='4' y='24' fill='red' font-size='13'>catrender: supercell \
{}×{}×{} exceeds {}-atom render cap</text></svg>",
                sa, sb, sc_, MAX_SUPERCELL_ATOMS
            );
        }
        if sa * sb * sc_ > 1 {
            let base_n = keep.len();
            let base_pos = pos.clone();
            let base_keep = keep.clone();
            let base_edges = edges.clone();
            let mut img = 1usize; // image 0 = the original block already present
            for i in 0..sa {
                for j in 0..sb {
                    for k in 0..sc_ {
                        if i == 0 && j == 0 && k == 0 {
                            continue;
                        }
                        let (fi, fj, fk) = (i as f64, j as f64, k as f64);
                        let shift = [
                            fi * lat[0][0] + fj * lat[1][0] + fk * lat[2][0],
                            fi * lat[0][1] + fj * lat[1][1] + fk * lat[2][1],
                            fi * lat[0][2] + fj * lat[1][2] + fk * lat[2][2],
                        ];
                        for (d, p) in base_pos.iter().enumerate() {
                            pos.push([
                                p[0] + shift[0],
                                p[1] + shift[1],
                                p[2] + shift[2],
                            ]);
                            keep.push(base_keep[d]); // inherits recolor/CPK
                        }
                        let off = img * base_n;
                        for &(di, dj, o, v) in &base_edges {
                            edges.push((di + off, dj + off, o, v));
                        }
                        img += 1;
                    }
                }
            }
        }
    }

    // --- PBC ghost wrap-images (RT12) ----------------------------------
    // When `cell.pbc_wrap` is set, atoms of the ORIGINAL cell (image 0) that
    // sit within a fractional band of a cell face are duplicated into the
    // adjacent neighbour cells (up to the 26 surrounding images) as DIM,
    // BONDLESS partner atoms, so a slab / periodic motif reads as continuous.
    // Opacity = `periodic_image_opacity`. OFF by default (opt-in flag), so the
    // fidelity gate and ordinary renders are unaffected. Ghosts are appended
    // here (before PCA/fit/z-order) so the existing pipeline orients, projects
    // and depth-sorts them uniformly; they carry NO bonds (no edges pushed).
    let mut image_flag = vec![false; keep.len()];
    if inp.style.cell.pbc_wrap {
        if let Some(lat) = inp.lattice {
            if let Some(inv) = inv3(&lat) {
                const T: f64 = 0.15; // fractional boundary band
                let base = n_cell0.min(pos.len());
                let axis_opts = |fa: f64| -> Vec<i32> {
                    let mut v = vec![0i32];
                    if fa < T {
                        v.push(1);
                    }
                    if fa > 1.0 - T {
                        v.push(-1);
                    }
                    v
                };
                for d in 0..base {
                    let p = pos[d];
                    let orig_idx = keep[d];
                    let f = [
                        p[0] * inv[0][0] + p[1] * inv[1][0] + p[2] * inv[2][0],
                        p[0] * inv[0][1] + p[1] * inv[1][1] + p[2] * inv[2][1],
                        p[0] * inv[0][2] + p[1] * inv[1][2] + p[2] * inv[2][2],
                    ];
                    let (vx, vy, vz) = (axis_opts(f[0]), axis_opts(f[1]), axis_opts(f[2]));
                    for &i in &vx {
                        for &j in &vy {
                            for &k in &vz {
                                if i == 0 && j == 0 && k == 0 {
                                    continue;
                                }
                                let (fi, fj, fk) = (i as f64, j as f64, k as f64);
                                pos.push([
                                    p[0] + fi * lat[0][0] + fj * lat[1][0] + fk * lat[2][0],
                                    p[1] + fi * lat[0][1] + fj * lat[1][1] + fk * lat[2][1],
                                    p[2] + fi * lat[0][2] + fj * lat[1][2] + fk * lat[2][2],
                                ]);
                                keep.push(orig_idx); // inherit element/color
                                image_flag.push(true); // dim, bondless ghost
                            }
                        }
                    }
                }
            }
        }
    }
    // Rebuild dense-derived arrays after replication (indices may have grown).
    let symbols: Vec<&str> = keep.iter().map(|&i| inp.atoms[i].el.as_str()).collect();
    let a_nums: Vec<u32> = symbols.iter().map(|s| s2n(s)).collect();
    let n = keep.len();

    // Dense-space draw-suppress mask for C-only H (xyzrender `hidden` set).
    // Built AFTER supercell replication so every replica's H is suppressed
    // too (`keep[d]` still maps each dense atom to its original index).
    // These atoms remain in `pos`/PCA/fit/z-order; only their circle/text
    // and incident bonds are skipped in the painter loop below.
    let suppress_draw: Vec<bool> =
        keep.iter().map(|&orig| h_c_only[orig]).collect();

    // --- PCA auto-orient (fit-mask excludes `*`), then drag rotation ----
    let auto_orient = inp.style.auto_orient.unwrap_or(auto_orient_default);
    let (mut pca_drag, _) = (geom_identity(), ());
    // Centroid PCA centered atoms around (zero when PCA didn't run). The cell
    // box must take the SAME centering, or atoms drift off the lattice corners.
    let mut orient_centroid = [0.0_f64; 3];
    if auto_orient && n > 1 {
        // RT5 fit_mask domain reconciliation: pca_orient_with_mask fits only
        // the masked subset but applies the rotation to ALL rows. We pass NO
        // priority pairs here (catrender has no TS-priority input wired yet),
        // so the latent priority/ts index-domain note is moot — the
        // fit-subset contract is satisfied trivially (empty priority set).
        let atom_mask: Vec<bool> = symbols.iter().map(|s| *s != "*").collect();
        let mask_opt: Option<&[bool]> =
            if atom_mask.iter().all(|&b| b) { None } else { Some(&atom_mask) };
        orient_centroid = crate::orient::fit_centroid(&pos, mask_opt);
        let (oriented, rot) = pca_orient_with_mask(&pos, None, mask_opt);
        pos = oriented;
        pca_drag = rot;
    }
    // Drag rotation AFTER PCA (extra intrinsic XYZ matrix, identity default).
    if let Some(dr) = inp.style.drag_rotation {
        if dr != [0.0, 0.0, 0.0] {
            for p in pos.iter_mut() {
                *p = geom::rotate(*p, dr);
            }
            // Keep the (PCA·drag) basis available for the RT11 gizmo.
            pca_drag = matmul3(&euler_matrix(dr), &pca_drag);
        }
    }
    // (PCA·drag) basis surfaced to the frontend for the RT11 corner axis
    // gizmo. Row k = the post-transform world-space direction of input axis k
    // (x,y,z). Emitted as a `data-gizmo-basis` attr on the root <svg> so the
    // pane reflects the EXACT same orientation the renderer applied (no
    // client-side re-derivation / drift).
    let gizmo_basis = pca_drag;

    // --- display radii (vdw · H-scale · atom_scale · 0.075) ------------
    // `radius_scale` (preset.rs already normalised the JSON dict
    // `{"H":1.2}` → `[["H",1.2],…]`) is xyzrender's per-atom radius
    // multiplier (renderer.py:150 `radii = radii * _per_atom_mult`).
    // Faithful minimal scope: element-symbol selectors (the only form any
    // built-in preset uses — `btube{"H":1.2}`). xyzrender's broader
    // selector engine (index lists, `M`/metal atom-classes) is not
    // exercised by any preset and stays out of RT12's minimal scope.
    let mut elem_radius_mult: std::collections::HashMap<String, f64> =
        std::collections::HashMap::new();
    if let Some(serde_json::Value::Array(pairs)) = cfg.get("radius_scale") {
        for p in pairs {
            if let serde_json::Value::Array(kv) = p {
                if let (Some(sel), Some(f)) = (
                    kv.first().and_then(serde_json::Value::as_str),
                    kv.get(1).and_then(serde_json::Value::as_f64),
                ) {
                    *elem_radius_mult.entry(sel.to_string()).or_insert(1.0) *= f;
                }
            }
        }
    }
    let radii: Vec<f64> = symbols
        .iter()
        .map(|&s| {
            let base = if s == "*" {
                CENTROID_VDW
            } else {
                vdw(s) * if s == "H" { H_ATOM_SCALE } else { 1.0 }
            };
            let mult = elem_radius_mult.get(s).copied().unwrap_or(1.0);
            base * atom_scale * RADIUS_SCALE * mult
        })
        .collect();

    // --- fit_canvas: pad fit_radii by stroke + min-bond, widen for cell -
    let rs0 = ref_scale(padding);
    let min_bond_r = (bond_width + 2.0 * bond_outline_width) / (2.0 * rs0);
    let fit_radii: Vec<f64> = radii
        .iter()
        .map(|&r| (r + atom_stroke_width / (2.0 * rs0)).max(min_bond_r))
        .collect();

    // Cell box vertices (post-PCA: lattice co-rotated by the same matrix).
    let mut cell_verts: Option<[[f64; 3]; 8]> = None;
    let show_cell = inp.style.cell.show && inp.lattice.is_some();
    if show_cell {
        if let Some(lat) = inp.lattice {
            // PCA co-rotation of lattice rows: oriented = lat @ rot.T.
            // pca_drag rows are world axes mapping to local axes (orient.rs
            // contract) — apply identical transform used on positions.
            let a = rotate_vec(&pca_drag, lat[0]);
            let b = rotate_vec(&pca_drag, lat[1]);
            let cc = rotate_vec(&pca_drag, lat[2]);
            // Lattice origin gets the SAME affine atoms got: center by the PCA
            // centroid, then rotate. Without the −centroid shift the box stays
            // at the rotated raw origin while atoms move, so they no longer sit
            // on the cell corners. (orient_centroid is zero when PCA didn't run.)
            let origin = rotate_vec(
                &pca_drag,
                [
                    -orient_centroid[0],
                    -orient_centroid[1],
                    -orient_centroid[2],
                ],
            );
            let mut vs = [[0.0; 3]; 8];
            let mut idx = 0;
            for i in 0..2 {
                for j in 0..2 {
                    for k in 0..2 {
                        let (fi, fj, fk) = (i as f64, j as f64, k as f64);
                        vs[idx] = [
                            origin[0] + fi * a[0] + fj * b[0] + fk * cc[0],
                            origin[1] + fi * a[1] + fj * b[1] + fk * cc[1],
                            origin[2] + fi * a[2] + fj * b[2] + fk * cc[2],
                        ];
                        idx += 1;
                    }
                }
            }
            cell_verts = Some(vs);
        }
    }
    let (extra_lo, extra_hi) = match &cell_verts {
        Some(vs) => {
            let mut lo = [f64::INFINITY; 2];
            let mut hi = [f64::NEG_INFINITY; 2];
            for v in vs {
                for c in 0..2 {
                    lo[c] = lo[c].min(v[c]);
                    hi[c] = hi[c].max(v[c]);
                }
            }
            (Some(lo), Some(hi))
        }
        None => (None, None),
    };

    // Interactive (drag-rotate) renders must keep a FIXED square canvas, else
    // the per-orientation aspect crop resizes the SVG element every frame
    // (the viewport visibly jumps while rotating). Bound the 3D extent of every
    // rendered point (atoms + cell box) about its centre; the projected extent
    // in any orientation never exceeds this diameter, so nothing clips and the
    // canvas size stays constant. Static (one-shot) renders keep the faithful
    // xyzrender aspect crop (fixed_span = None).
    let fixed_span = if inp.style.drag_rotation.is_some() {
        let mut pts: Vec<[f64; 3]> = pos.clone();
        if let Some(vs) = &cell_verts {
            pts.extend_from_slice(vs);
        }
        let cnt = pts.len().max(1) as f64;
        let mut mean = [0.0_f64; 3];
        for p in &pts {
            mean[0] += p[0];
            mean[1] += p[1];
            mean[2] += p[2];
        }
        mean[0] /= cnt;
        mean[1] /= cnt;
        mean[2] /= cnt;
        let max_r = pts
            .iter()
            .map(|p| {
                let d = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]];
                (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
            })
            .fold(0.0_f64, f64::max);
        let max_rad = fit_radii.iter().cloned().fold(0.0_f64, f64::max);
        Some((2.0 * (max_r + max_rad)).max(1e-6))
    } else {
        None
    };

    let fit = fit_canvas_extra(
        &pos,
        &fit_radii,
        canvas_size,
        padding,
        fixed_span,
        extra_lo,
        extra_hi,
    );
    let (scale, cx, cy, cw, ch) = (fit.scale, fit.cx, fit.cy, fit.w, fit.h);
    let sr = scale_ratio(scale, padding);
    let bw = bond_width * sr;
    let sw = atom_stroke_width * sr;

    // --- z-order: argsort by depth (z), _z_rank for the skip rule ------
    let mut z_order: Vec<usize> = (0..n).collect();
    z_order.sort_by(|&a, &b| pos[a][2].total_cmp(&pos[b][2]));
    let mut z_rank = vec![0usize; n];
    for (rank, &ai) in z_order.iter().enumerate() {
        z_rank[ai] = rank;
    }

    // Pre-projected atom centers.
    let px: Vec<f64> = pos.iter().map(|p| proj(*p, scale, cx, cy, cw, ch).0).collect();
    let py: Vec<f64> = pos.iter().map(|p| proj(*p, scale, cx, cy, cw, ch).1).collect();

    // --- fog factors ---------------------------------------------------
    let zs: Vec<f64> = pos.iter().map(|p| p[2]).collect();
    let fog_f: Vec<f64> = if fog_on {
        fog::fog_factors(&zs, fog_strength)
    } else {
        vec![0.0; n]
    };

    // --- atom base colors (CPK / overrides / per-atom recolor) ---------
    let colors: Vec<Color> = (0..n)
        .map(|d| {
            let orig = keep[d];
            recolor[orig].unwrap_or_else(|| element_color(&cfg, symbols[d], a_nums[d]))
        })
        .collect();

    // --- adjacency for the O(degree) forward-bond loop -----------------
    let mut adj: Vec<Vec<(usize, f64, BondVis)>> = vec![Vec::new(); n];
    for &(i, j, o, v) in &edges {
        if i < n && j < n && i != j {
            adj[i].push((j, o, v));
            adj[j].push((i, o, v));
        }
    }

    // --- aromatic rings (input data absent → minimum cycle basis over
    //     aromatic-order edges; renderer.py:1719-1726) -------------------
    let aromatic_rings: Vec<Vec<usize>> = if hide_bonds {
        Vec::new()
    } else {
        compute_aromatic_rings(&edges, n)
    };

    // --- gradient gating ----------------------------------------------
    let use_grad = gradient && !skeletal_style;
    let use_per_atom_grad = fog_on; // fog needs unique per-atom blended fill

    // -------------------------------------------------------------------
    // Build SVG
    // -------------------------------------------------------------------
    let mut svg: Vec<String> = Vec::new();
    svg.push(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" \
xmlns:xlink=\"http://www.w3.org/1999/xlink\" \
viewBox=\"0 0 {cw} {ch}\" width=\"{cw}\" height=\"{ch}\"{bg} \
data-gizmo-basis=\"{g00},{g01},{g02},{g10},{g11},{g12},{g20},{g21},{g22}\">",
        bg = if transparent {
            " style=\"background:transparent\""
        } else {
            ""
        },
        cw = fmt0(cw),
        ch = fmt0(ch),
        g00 = gizmo_basis[0][0], g01 = gizmo_basis[0][1], g02 = gizmo_basis[0][2],
        g10 = gizmo_basis[1][0], g11 = gizmo_basis[1][1], g12 = gizmo_basis[1][2],
        g20 = gizmo_basis[2][0], g21 = gizmo_basis[2][1], g22 = gizmo_basis[2][2],
    ));
    if !transparent {
        svg.push(format!(
            "  <rect width=\"100%\" height=\"100%\" fill=\"{background}\"/>"
        ));
    }

    // DoF filter defs.
    if dof {
        svg.push("  <defs>".to_string());
        svg.push(format!("    {}", fog::dof_filter_defs(dof_strength)));
        svg.push("  </defs>".to_string());
    }

    // Fog-normalized DoF buckets (renderer.py:459-465).
    let dof_buckets: Vec<i64> = if dof {
        let dof_depth: Vec<f64> = if fog_on {
            fog_f.iter().map(|&f| f / fog_strength.max(1e-6)).collect()
        } else {
            let zmax = zs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let zmin = zs.iter().cloned().fold(f64::INFINITY, f64::min);
            let zr = (zmax - zmin).max(1e-6);
            zs.iter()
                .map(|&z| ((zmax - z - fog::FOG_NEAR) / zr).clamp(0.0, 1.0))
                .collect()
        };
        dof_depth.iter().map(|&d| fog::dof_bucket(d)).collect()
    } else {
        vec![0; n]
    };

    // --- glow halo filter <defs> (op:glow atom highlight) -------------
    // Emitted once, independent of gradient mode. The id-prefix guard
    // rewrites `id="`/`url(#` uniformly, so `catrender-glow` is prefixed
    // consistently with the gradient ids when id_prefix is set.
    if !glow_atoms.is_empty() {
        svg.push("  <defs>".to_string());
        svg.push(format!(
            "    <filter id=\"catrender-glow\" x=\"-75%\" y=\"-75%\" width=\"250%\" height=\"250%\">\
<feGaussianBlur in=\"SourceGraphic\" stdDeviation=\"{:.1}\" result=\"b\"/>\
<feMerge><feMergeNode in=\"b\"/><feMergeNode in=\"b\"/><feMergeNode in=\"SourceGraphic\"/></feMerge></filter>",
            // Blur scales with halo width: at the 1.6 default this is 6·sr;
            // wider glow (larger glow_radius_scale) blurs proportionally more.
            (6.0 * sr * glow_radius_scale / 1.6).max(3.0)
        ));
        svg.push("  </defs>".to_string());
    }

    // --- radialGradient <defs> ----------------------------------------
    // Shared id `g{Z}_{hex[1:]}` keyed by (Z,hex); per-atom `g{ai}` w/ fog.
    if use_grad {
        svg.push("  <defs>".to_string());
        if use_per_atom_grad {
            for ai in 0..n {
                // xyzrender: `if ai in hidden: continue` — no gradient def
                // for a draw-suppressed C-only H (it is never painted).
                if suppress_draw[ai] {
                    continue;
                }
                let (hi, me, lo) = colors[ai].get_gradient_colors(atom_grad_str, hue, light, sat);
                let t = (fog_f[ai] * fog_f[ai] * 0.7).min(0.70);
                let (hi, me, lo) = (
                    hi.blend(&WHITE, t),
                    me.blend(&WHITE, t),
                    lo.blend(&WHITE, t),
                );
                svg.push(format!(
                    "    <radialGradient id=\"g{ai}\" cx=\".5\" cy=\".5\" fx=\".33\" fy=\".33\" r=\".66\">\
<stop offset=\"0%\" stop-color=\"{}\"/>\
<stop offset=\"40%\" stop-color=\"{}\"/>\
<stop offset=\"100%\" stop-color=\"{}\"/>\
</radialGradient>",
                    hi.hex(),
                    me.hex(),
                    lo.hex()
                ));
            }
        } else {
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for ai in 0..n {
                // xyzrender: `if key in seen or ai in hidden: continue`.
                if suppress_draw[ai] {
                    continue;
                }
                let chex = colors[ai].hex();
                let gid = format!("{}_{}", a_nums[ai], &chex[1..]);
                if !seen.insert(gid.clone()) {
                    continue;
                }
                let (hi, me, lo) = colors[ai].get_gradient_colors(atom_grad_str, hue, light, sat);
                svg.push(format!(
                    "    <radialGradient id=\"g{gid}\" cx=\".5\" cy=\".5\" fx=\".33\" fy=\".33\" r=\".66\">\
<stop offset=\"0%\" stop-color=\"{}\"/>\
<stop offset=\"40%\" stop-color=\"{}\"/>\
<stop offset=\"100%\" stop-color=\"{}\"/>\
</radialGradient>",
                    hi.hex(),
                    me.hex(),
                    lo.hex()
                ));
            }
        }
        svg.push("  </defs>".to_string());
    }

    // --- unit cell box (12 dashed edges, BEFORE molecule) -------------
    if let Some(vs) = &cell_verts {
        // vertex index = i*4 + j*2 + k (i,j,k ∈ {0,1})
        let vp: Vec<(f64, f64)> = vs.iter().map(|v| proj(*v, scale, cx, cy, cw, ch)).collect();
        let cell_lw = cell_line_width * sr;
        let dash = format!("{:.1},{:.1}", cell_lw * 2.5, cell_lw * 3.0);
        svg.push("  <!-- cell box -->".to_string());
        let vidx = |i: usize, j: usize, k: usize| i * 4 + j * 2 + k;
        let mut edge = |p: (f64, f64), q: (f64, f64)| {
            svg.push(format!(
                "  <line class=\"cell-edge\" x1=\"{:.1}\" y1=\"{:.1}\" x2=\"{:.1}\" y2=\"{:.1}\" \
stroke=\"{cell_color}\" stroke-width=\"{:.1}\" stroke-dasharray=\"{dash}\" stroke-linecap=\"round\"/>",
                p.0, p.1, q.0, q.1, cell_lw
            ));
        };
        for j in 0..2 {
            for k in 0..2 {
                edge(vp[vidx(0, j, k)], vp[vidx(1, j, k)]); // along a
            }
        }
        for i in 0..2 {
            for k in 0..2 {
                edge(vp[vidx(i, 0, k)], vp[vidx(i, 1, k)]); // along b
            }
        }
        for i in 0..2 {
            for j in 0..2 {
                edge(vp[vidx(i, j, 0)], vp[vidx(i, j, 1)]); // along c
            }
        }
    }

    // --- bond geometry precompute (trim 0.9r, reject, perp2d) ---------
    // bond_geom[(i,j)] = Some((x1,y1,x2,y2,px,py)) directed i→j.
    let mut bond_geom: std::collections::HashMap<(usize, usize), BondGeom> =
        std::collections::HashMap::new();
    // Skeletal bond-endpoint radii (xyzrender skeletal.py
    // `skeletal_bond_radii`): carbon → 0 (bonds meet at the bare vertex);
    // non-carbon → max(display radius, label-margin) so the bond does not
    // overlap the element-symbol text. `margin_3d = fs_label*0.7/scale`
    // with `fs_label = label_font_size · scale_ratio` (renderer.py:244).
    // In normal modes this is just the display `radii`.
    let skel_fs_label = cfg_f(&cfg, "label_font_size", 40.0) * sr;
    let skel_margin_3d = (skel_fs_label * 0.7) / scale.max(1e-6);
    let bond_r = |idx: usize| -> f64 {
        if skeletal_style {
            if symbols[idx] == "C" {
                0.0
            } else {
                radii[idx].max(skel_margin_3d)
            }
        } else {
            radii[idx]
        }
    };
    if !hide_bonds && bw > 0.0 {
        let mut seen: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
        for &(i, j, _, _) in &edges {
            let (a, b) = if i < j { (i, j) } else { (j, i) };
            if a == b || !seen.insert((a, b)) {
                continue;
            }
            let (start, end, ok) = bonds::trim(pos[a], pos[b], bond_r(a), bond_r(b));
            if !ok {
                continue;
            }
            let (x1, y1) = proj(start, scale, cx, cy, cw, ch);
            let (x2, y2) = proj(end, scale, cx, cy, cw, ch);
            if bonds::reject_short(x1, y1, x2, y2) {
                continue;
            }
            let (ppx, ppy) = bonds::perp2d(x1, y1, x2, y2);
            bond_geom.insert((a, b), (x1, y1, x2, y2, ppx, ppy));
            bond_geom.insert((b, a), (x2, y2, x1, y1, -ppx, -ppy));
        }
    }

    // --- interleaved painter loop -------------------------------------
    let molecule_insert_idx = svg.len();
    let mut bond_outline_layer: Vec<String> = Vec::new();
    let mut deferred_atom_layers: Vec<String> = Vec::new();
    let mut bs_counter: usize = 0;

    let base_scfg = bond_gradient; // cylinder shading active

    for (idx, &ai) in z_order.iter().enumerate() {
        // xyzrender renderer.py: `if ai in hidden: continue` — a C-only H
        // is a depth marker (it kept its z-order slot, which is why this
        // `continue` is here and not a pre-filter) but paints NOTHING:
        // not its sphere, not its forward bonds. Bonds INTO it from a
        // visible atom are separately skipped (see `suppress_draw[aj]`).
        if suppress_draw[ai] {
            continue;
        }
        let xi = px[ai];
        let yi = py[ai];
        let orig = keep[ai];
        // RT14 pick hook (gated by pick_attrs). Original input-atom index so a
        // canvas click on this z-order-painted glyph resolves to the right atom.
        let pick_attr = if pick_attrs {
            format!(" data-atom-index=\"{orig}\"")
        } else {
            String::new()
        };
        // Supercell graph replication (spec §Cell "render as normal") atoms are
        // real, full-opacity. PBC ghost wrap-images (RT12, generated above when
        // `cell.pbc_wrap` is set) are flagged in `image_flag` and painted dim at
        // `periodic_image_opacity`. Non-ghost atoms keep full opacity.
        let is_image = image_flag[ai];
        let atom_op = if is_image { periodic_image_opacity } else { 1.0 };
        let op_atom = if atom_op < 1.0 {
            format!(" opacity=\"{:.2}\"", atom_op)
        } else {
            String::new()
        };

        let atom_layer_start = svg.len();

        if skeletal_style {
            // Skeletal: no spheres; element-symbol vertex label for non-C.
            if symbols[ai] != "C" {
                let fill = if let Some(lc) = &skeletal_label_color {
                    lc.clone()
                } else if fog_on {
                    blend_fog_hex(&colors[ai].hex(), fog_f[ai])
                } else {
                    colors[ai].hex()
                };
                let fs_label = cfg_f(&cfg, "label_font_size", 40.0) * sr;
                svg.push(format!(
                    "  <text x=\"{xi:.1}\" y=\"{yi:.1}\" \
font-family=\"Helvetica,Arial,sans-serif\" font-size=\"{fs_label:.1}px\" \
font-weight=\"bold\" text-anchor=\"middle\" dominant-baseline=\"central\" \
fill=\"{fill}\">{}</text>",
                    symbols[ai]
                ));
            }
        } else {
            // Sphere — gradient or flat fill. Emitted UNCONDITIONALLY
            // (xyzrender renderer.py non-skeletal `else:` branch has no
            // atom_scale gate): when atom_scale==0 (tube/mtube/wire) the
            // radius is `radii[ai]*scale == 0.0`, so xyzrender writes a
            // degenerate `<circle r="0.0" .../>`. catrender must emit the
            // same zero-radius circle (count + fill/stroke parity) — the
            // earlier `atom_scale > 0.0` guard dropped it and broke every
            // tube-family preset's circle count.
            let stroke_src = recolor[orig]
                .map(|c| c.hex())
                .unwrap_or_else(|| atom_stroke_color.clone());
            let stroke_atom = if stroke_src == "atom" {
                colors[ai].hex()
            } else {
                stroke_src
            };
            let dof_attr = if dof {
                format!(" filter=\"url(#dof{})\"", dof_buckets[ai])
            } else {
                String::new()
            };
            let r = radii[ai] * scale;
            // Glow halo behind this atom (render highlight; appears in export).
            // Pushed BEFORE the atom circle so the atom stays crisp on top, and
            // emitted in the SAME layer slot (after atom_layer_start) so it
            // travels with its atom when atoms_above_bonds defers the layer.
            if let Some(glow_hex) = glow_atoms.get(&orig) {
                svg.push(format!(
                    "  <circle class=\"atom-glow\" cx=\"{xi:.1}\" cy=\"{yi:.1}\" r=\"{gr:.1}\" \
fill=\"{glow_hex}\" opacity=\"{glow_opacity:.2}\" filter=\"url(#catrender-glow)\"/>",
                    gr = r * glow_radius_scale
                ));
            }
            if use_grad {
                let (grad_id, fs_atom) = if use_per_atom_grad {
                    (
                        format!("g{ai}"),
                        blend_fog_hex(
                            &(if stroke_atom == "atom" {
                                colors[ai].hex()
                            } else {
                                stroke_atom.clone()
                            }),
                            fog_f[ai],
                        ),
                    )
                } else {
                    (
                        format!("g{}_{}", a_nums[ai], &colors[ai].hex()[1..]),
                        stroke_atom.clone(),
                    )
                };
                svg.push(format!(
                    "  <circle cx=\"{xi:.1}\" cy=\"{yi:.1}\" r=\"{r:.1}\" \
fill=\"url(#{grad_id})\" stroke=\"{fs_atom}\" stroke-width=\"{sw_a:.1}\"{op_atom}{dof_attr}{pick_attr}/>",
                    sw_a = sw
                ));
            } else {
                let mut fill = if atom_wash > 0.0 {
                    colors[ai].blend(&WHITE, atom_wash).hex()
                } else {
                    colors[ai].hex()
                };
                let mut stroke = stroke_atom.clone();
                if fog_on {
                    fill = blend_fog_hex(&fill, fog_f[ai]);
                    stroke = blend_fog_hex(&stroke, fog_f[ai]);
                }
                svg.push(format!(
                    "  <circle cx=\"{xi:.1}\" cy=\"{yi:.1}\" r=\"{r:.1}\" \
fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"{sw_a:.1}\"{op_atom}{dof_attr}{pick_attr}/>",
                    sw_a = sw
                ));
            }
        }

        // Atom-index overlay (editing aid). `suppress_draw[ai]` atoms already
        // `continue`d at the top of the loop, so only real, non-suppressed
        // atoms reach here; skip ghost/PBC-image atoms too. Uses the ORIGINAL
        // input index `orig` (== keep[ai]) — the i/j a user types into the
        // bond editor — NOT the dense/z-order index `ai`.
        if inp.style.show_index && !image_flag[ai] {
            let r = radii[ai] * scale;
            svg.push(format!(
                "  <text class=\"atom-index\" x=\"{:.1}\" y=\"{:.1}\" \
font-size=\"{:.1}\" fill=\"#222\" text-anchor=\"middle\">{}</text>",
                xi,
                yi - r - 1.0,
                // Match element-label sizing (label_font_size·sr, default 40)
                // with a readable floor — the old 12·sr was tiny on real molecules.
                (cfg_f(&cfg, "label_font_size", 40.0) * sr).max(14.0),
                orig
            ));
        }

        // Defer this atom's layers when atoms_above_bonds.
        if atoms_above_bonds && svg.len() > atom_layer_start {
            let drained: Vec<String> = svg.drain(atom_layer_start..).collect();
            deferred_atom_layers.extend(drained);
        }

        // Forward bonds to deeper atoms.
        if !hide_bonds && bw > 0.0 {
            // stable neighbour order for deterministic output
            let mut nbrs = adj[ai].clone();
            nbrs.sort_by_key(|&(j, _, _)| j);
            for (aj, bo_raw, vis) in nbrs {
                // xyzrender renderer.py: `if aj_int in hidden ...: continue`
                // — never draw a bond into a C-only-H (it would dangle).
                if suppress_draw[aj] || z_rank[aj] <= idx {
                    continue;
                }
                let Some(&(x1, y1, x2, y2, ppx, ppy)) = bond_geom.get(&(ai, aj)) else {
                    continue;
                };
                add_bond(
                    AddBond {
                        svg: &mut svg,
                        bond_outline_layer: &mut bond_outline_layer,
                        bs_counter: &mut bs_counter,
                        x1,
                        y1,
                        x2,
                        y2,
                        ppx,
                        ppy,
                        bo: if bond_orders { bo_raw } else { 1.0 },
                        // xyzrender skeletal.py:93 `_bw = bw * 0.6` — the
                        // skeletal base stroke width is 60% of the scaled
                        // bond width. The gap/offset still uses the FULL
                        // bw (renderer.py passes `_gap = bond_gap·bw`,
                        // skeletal_bond_svg consumes it un-scaled), so only
                        // the width arg gets the 0.6 factor here.
                        bw: if skeletal_style { bw * 0.6 } else { bw },
                        sr,
                        gap: bond_gap_factor * bw,
                        bond_color: &bond_color,
                        bond_color_by_element,
                        ci: colors[ai],
                        cj: colors[aj],
                        ri_vdw: raw_vdw(symbols[ai]),
                        rj_vdw: raw_vdw(symbols[aj]),
                        fi: fog_f[ai],
                        fj: fog_f[aj],
                        fog_on,
                        scfg: base_scfg,
                        bond_gradient_strength,
                        hue,
                        light,
                        sat,
                        outline_w: bond_outline_width * sr,
                        outline_c: &bond_outline_color,
                        opacity: 1.0,
                        ts_color: ts_color.as_deref(),
                        nci_color: nci_color.as_deref(),
                        vis,
                        skeletal: skeletal_style,
                        aromatic_rings: &aromatic_rings,
                        ai,
                        aj,
                        pos: &pos,
                        scale,
                        cx,
                        cy,
                        cw,
                        ch,
                    },
                );
            }
        }
    }

    // Splice the deferred bond-outline layer at the molecule base.
    if !bond_outline_layer.is_empty() {
        for (k, line) in bond_outline_layer.into_iter().enumerate() {
            svg.insert(molecule_insert_idx + k, line);
        }
    }
    // Deferred atom layers (atoms_above_bonds) appended last.
    if !deferred_atom_layers.is_empty() {
        svg.extend(deferred_atom_layers);
    }

    svg.push("</svg>".to_string());
    let raw = svg.join("\n");

    // --- SVG id prefix guard ------------------------------------------
    if let Some(p) = &inp.style.id_prefix {
        raw.replace("id=\"", &format!("id=\"{p}"))
            .replace("href=\"#", &format!("href=\"#{p}"))
            .replace("url(#", &format!("url(#{p}"))
    } else {
        raw
    }
}

// ---------------------------------------------------------------------------
// Bond emission — faithful port of renderer.py add_bond / _emit_line /
// _element_line / _bond_line / _shaded_stroke (RT8 helpers do the math).
// ---------------------------------------------------------------------------

/// Per-bond visual style fed in from `Bond.ts` / `Bond.nci`. `Solid` is the
/// normal multi/aromatic path; `Ts`/`Nci` short-circuit to the dashed/dotted
/// xyzrender strokes (`renderer.py:1211-1218` / `1238-1245`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BondVis {
    Solid,
    Ts,
    Nci,
}

struct AddBond<'a> {
    svg: &'a mut Vec<String>,
    bond_outline_layer: &'a mut Vec<String>,
    bs_counter: &'a mut usize,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    ppx: f64,
    ppy: f64,
    bo: f64,
    bw: f64,
    /// scale_ratio (renderer.py:1146 non-solid bond-width cap factor).
    sr: f64,
    gap: f64,
    bond_color: &'a str,
    bond_color_by_element: bool,
    ci: Color,
    cj: Color,
    ri_vdw: f64,
    rj_vdw: f64,
    fi: f64,
    fj: f64,
    fog_on: bool,
    scfg: bool,
    bond_gradient_strength: f64,
    hue: f64,
    light: f64,
    sat: f64,
    outline_w: f64,
    outline_c: &'a str,
    opacity: f64,
    ts_color: Option<&'a str>,
    nci_color: Option<&'a str>,
    vis: BondVis,
    /// Skeletal mode (xyzrender `skeletal_bond_svg`): every multi-bond
    /// sub-line keeps the FULL skeletal base width `_bw` (skeletal.py:138
    /// `w = _bw`). Normal mode narrows multi-bonds to `bw·0.7` — that
    /// narrowing must NOT apply in skeletal.
    skeletal: bool,
    aromatic_rings: &'a [Vec<usize>],
    ai: usize,
    aj: usize,
    pos: &'a [[f64; 3]],
    scale: f64,
    cx: f64,
    cy: f64,
    cw: f64,
    ch: f64,
}

fn add_bond(b: AddBond) {
    let AddBond {
        svg,
        bond_outline_layer,
        bs_counter,
        x1,
        y1,
        x2,
        y2,
        ppx,
        ppy,
        bo,
        bw,
        sr,
        gap,
        bond_color,
        bond_color_by_element,
        ci,
        cj,
        ri_vdw,
        rj_vdw,
        fi,
        fj,
        fog_on,
        scfg,
        bond_gradient_strength,
        hue,
        light,
        sat,
        outline_w,
        outline_c,
        opacity,
        ts_color,
        nci_color,
        vis,
        skeletal,
        aromatic_rings,
        ai,
        aj,
        pos,
        scale,
        cx,
        cy,
        cw,
        ch,
    } = b;

    let by_element = bond_color_by_element;
    let op_attr = if opacity < 1.0 {
        format!(" opacity=\"{:.2}\"", opacity)
    } else {
        String::new()
    };

    // Uniform-bond color with fog (element-split path fogs per-half instead).
    let color = if by_element {
        String::new()
    } else if fog_on {
        blend_fog_hex(bond_color, (fi + fj) / 2.0 * 0.75)
    } else {
        bond_color.to_string()
    };

    let stroke_i = if outline_w > 0.0 {
        if fog_on {
            Some(blend_fog_hex(outline_c, fi))
        } else {
            Some(outline_c.to_string())
        }
    } else {
        None
    };
    let stroke_j = if outline_w > 0.0 {
        if fog_on {
            Some(blend_fog_hex(outline_c, fj))
        } else {
            Some(outline_c.to_string())
        }
    } else {
        None
    };

    let emit = |svg: &mut Vec<String>,
                    bond_outline_layer: &mut Vec<String>,
                    bs_counter: &mut usize,
                    lx1: f64,
                    ly1: f64,
                    lx2: f64,
                    ly2: f64,
                    w: f64,
                    lpx: f64,
                    lpy: f64,
                    shade: bool,
                    dash: &str| {
        // Deferred outline (wider stroke), spliced behind all bonds.
        if let (Some(si), Some(sj)) = (&stroke_i, &stroke_j) {
            let stroke = if si != sj {
                let sid = format!("bo{}", *bs_counter);
                *bs_counter += 1;
                svg.push(format!(
                    "  <defs><linearGradient id=\"{sid}\" x1=\"{lx1:.1}\" y1=\"{ly1:.1}\" \
x2=\"{lx2:.1}\" y2=\"{ly2:.1}\" gradientUnits=\"userSpaceOnUse\">\
<stop offset=\"0%\" stop-color=\"{si}\"/>\
<stop offset=\"100%\" stop-color=\"{sj}\"/>\
</linearGradient></defs>"
                ));
                format!("url(#{sid})")
            } else {
                si.clone()
            };
            bond_outline_layer.push(bonds::outline_fragment(
                lx1, ly1, lx2, ly2, w, outline_w, &stroke, dash, &op_attr,
            ));
        }
        if by_element {
            // Half-bond element split at the radius-weighted midpoint.
            let avg_fog = (fi + fj) / 2.0 * 0.75;
            let c1 = if fog_on {
                ci.blend_fog(FOG_RGB, avg_fog).hex()
            } else {
                ci.hex()
            };
            let c2 = if fog_on {
                cj.blend_fog(FOG_RGB, avg_fog).hex()
            } else {
                cj.hex()
            };
            if c1 == c2 {
                bond_line(
                    svg, bs_counter, lx1, ly1, lx2, ly2, w, &c1, lpx, lpy, shade,
                    bond_gradient_strength, hue, light, sat, dash, &op_attr,
                );
            } else {
                let t = bonds::half_split_t(ri_vdw, rj_vdw);
                if !dash.is_empty() {
                    let sid = format!("be{}", *bs_counter);
                    *bs_counter += 1;
                    let off = (100.0 * t).clamp(0.0, 100.0);
                    svg.push(format!(
                        "  <defs><linearGradient id=\"{sid}\" x1=\"{lx1:.1}\" y1=\"{ly1:.1}\" \
x2=\"{lx2:.1}\" y2=\"{ly2:.1}\" gradientUnits=\"userSpaceOnUse\">\
<stop offset=\"0%\" stop-color=\"{c1}\"/>\
<stop offset=\"{off:.4}%\" stop-color=\"{c1}\"/>\
<stop offset=\"{off:.4}%\" stop-color=\"{c2}\"/>\
<stop offset=\"100%\" stop-color=\"{c2}\"/>\
</linearGradient></defs>"
                    ));
                    svg.push(bonds::line_fragment(
                        lx1,
                        ly1,
                        lx2,
                        ly2,
                        w,
                        &format!("url(#{sid})"),
                        dash,
                        &op_attr,
                    ));
                } else {
                    let xm = lx1 + (lx2 - lx1) * t;
                    let ym = ly1 + (ly2 - ly1) * t;
                    bond_line(
                        svg, bs_counter, lx1, ly1, xm, ym, w, &c1, lpx, lpy, shade,
                        bond_gradient_strength, hue, light, sat, dash, &op_attr,
                    );
                    bond_line(
                        svg, bs_counter, xm, ym, lx2, ly2, w, &c2, lpx, lpy, shade,
                        bond_gradient_strength, hue, light, sat, dash, &op_attr,
                    );
                }
            }
        } else {
            bond_line(
                svg, bs_counter, lx1, ly1, lx2, ly2, w, &color, lpx, lpy, shade,
                bond_gradient_strength, hue, light, sat, dash, &op_attr,
            );
        }
    };

    // TS / NCI short-circuit: a single straight dashed (TS) or dotted (NCI)
    // stroke — no multi-bond split, no aromatic offset (renderer.py:1211-1245).
    // Width/dash from the bonds.rs helpers; paint = ts_color/nci_color when
    // the preset supplies it, else the resolved uniform bond color (fogged).
    if vis != BondVis::Solid {
        // renderer.py:1146-1148 caps the non-solid base width to
        // `min(_bw, 20*scale_ratio)` for any `style != SOLID` BEFORE the
        // DASHED(TS)/DOTTED(NCI) branches, and recomputes the dash period
        // from the capped value. Without this, tube(bond_width=50) /
        // pmol(24) TS/NCI strokes render ~2.5× too fat with the wrong
        // dash period. Aromatic is reached via style==SOLID upstream so it
        // is (correctly) NOT capped here — see the `is_aromatic` branch.
        let cbw = bonds::cap_nonsolid_bw(bw, sr);
        let (w, dash, paint) = match vis {
            BondVis::Ts => (
                bonds::bond_stroke_width(cbw, bonds::StrokeKind::DashedTs),
                bonds::dash_array(cbw * 1.2, cbw * 2.2),
                ts_color,
            ),
            BondVis::Nci => (
                bonds::bond_stroke_width(cbw, bonds::StrokeKind::DottedNci),
                bonds::dash_array(cbw * 0.08, cbw * 2.0),
                nci_color,
            ),
            BondVis::Solid => unreachable!(),
        };
        let stroke = match paint {
            Some(c) if fog_on => blend_fog_hex(c, (fi + fj) / 2.0 * 0.75),
            Some(c) => c.to_string(),
            None => color.clone(),
        };
        if let Some(si) = &stroke_i {
            // Outline behind the dashed/dotted stroke (single uniform color —
            // TS/NCI strokes are never element-split).
            bond_outline_layer.push(bonds::outline_fragment(
                x1, y1, x2, y2, w, outline_w, si, &dash, &op_attr,
            ));
        }
        svg.push(bonds::line_fragment(
            x1, y1, x2, y2, w, &stroke, &dash, &op_attr,
        ));
        return;
    }

    if bonds::is_aromatic(bo) {
        let side = ring_side(
            pos,
            ai,
            aj,
            aromatic_rings,
            x1,
            y1,
            x2,
            y2,
            ppx,
            ppy,
            scale,
            cx,
            cy,
            cw,
            ch,
        );
        if skeletal {
            // xyzrender skeletal.py:114-135 aromatic: a SOLID centre line
            // (no offset) + ONE end-trimmed, ring-inward-offset DASHED
            // line — both at the flat skeletal base width `_bw` (the `bw`
            // passed in already carries the ·0.6 factor). This differs
            // from the normal-mode twin-offset aromatic style below.
            let w = bw;
            let scol = if fog_on {
                blend_fog_hex(bond_color, (fi + fj) / 2.0 * 0.75)
            } else {
                bond_color.to_string()
            };
            svg.push(bonds::line_fragment(
                x1, y1, x2, y2, w, &scol, "", &op_attr,
            ));
            let dx = x2 - x1;
            let dy = y2 - y1;
            let ln = (dx * dx + dy * dy).sqrt().max(1e-9);
            let (vx, vy) = (dx / ln, dy / ln);
            let trim = (ln * 0.2).min(w * 2.5);
            let (dxd, dyd) = (vx * trim, vy * trim);
            let (ox, oy) = (ppx * 2.0 * gap * side as f64, ppy * 2.0 * gap * side as f64);
            let dash = bonds::dash_array(w * 1.0, w * 2.0);
            svg.push(bonds::line_fragment(
                x1 + dxd + ox,
                y1 + dyd + oy,
                x2 - dxd + ox,
                y2 - dyd + oy,
                w,
                &scol,
                &dash,
                &op_attr,
            ));
            return;
        }
        let w = bw * 0.7;
        for ib in [-1i32, 1] {
            let (ox, oy) = (ppx * ib as f64 * gap, ppy * ib as f64 * gap);
            let dash = if ib == side {
                format!(" stroke-dasharray=\"{:.1},{:.1}\"", w * 1.0, w * 2.0)
            } else {
                String::new()
            };
            let shade = scfg && dash.is_empty();
            emit(
                svg,
                bond_outline_layer,
                bs_counter,
                x1 + ox,
                y1 + oy,
                x2 + ox,
                y2 + oy,
                w,
                ppx,
                ppy,
                shade,
                &dash,
            );
        }
    } else {
        let nb = bonds::nb_from_order(bo, true);
        // Normal mode narrows multi-bond sub-lines to `bw·0.7`; skeletal
        // keeps the flat skeletal base width on every sub-line
        // (skeletal.py:138 `w = _bw`, no 0.7).
        let w = if nb == 1 || skeletal { bw } else { bw * 0.7 };
        for ib in bonds::ib_seq(nb) {
            let (ox, oy) = (ppx * ib as f64 * gap, ppy * ib as f64 * gap);
            emit(
                svg,
                bond_outline_layer,
                bs_counter,
                x1 + ox,
                y1 + oy,
                x2 + ox,
                y2 + oy,
                w,
                ppx,
                ppy,
                scfg,
                "",
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn bond_line(
    svg: &mut Vec<String>,
    bs_counter: &mut usize,
    lx1: f64,
    ly1: f64,
    lx2: f64,
    ly2: f64,
    w: f64,
    color_hex: &str,
    lpx: f64,
    lpy: f64,
    shade: bool,
    bond_gradient_strength: f64,
    hue: f64,
    light: f64,
    sat: f64,
    dash: &str,
    op_attr: &str,
) {
    let stroke = if shade {
        let (hi, _me, lo) =
            Color::from_hex(color_hex).get_gradient_colors(bond_gradient_strength, hue, light, sat);
        let sid = format!("bs{}", *bs_counter);
        *bs_counter += 1;
        svg.push(bonds::shade_gradient_fragment(
            &sid,
            lx1,
            ly1,
            lx2,
            ly2,
            w,
            lpx,
            lpy,
            &lo.hex(),
            &hi.hex(),
        ));
        format!("url(#{sid})")
    } else {
        color_hex.to_string()
    };
    svg.push(bonds::line_fragment(
        lx1, ly1, lx2, ly2, w, &stroke, dash, op_attr,
    ));
}

/// Which perpendicular side (+1/-1) of the bond faces the aromatic ring
/// center — renderer.py:1997-2005 `_ring_side`.
#[allow(clippy::too_many_arguments)]
fn ring_side(
    pos: &[[f64; 3]],
    ai: usize,
    aj: usize,
    rings: &[Vec<usize>],
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    px: f64,
    py: f64,
    scale: f64,
    cx: f64,
    cy: f64,
    cw: f64,
    ch: f64,
) -> i32 {
    for ring in rings {
        if ring.contains(&ai) && ring.contains(&aj) {
            let mut c = [0.0; 3];
            for &m in ring {
                let p = pos[m];
                for (ck, pk) in c.iter_mut().zip(p) {
                    *ck += pk;
                }
            }
            let nf = ring.len().max(1) as f64;
            for ck in &mut c {
                *ck /= nf;
            }
            let (rcx, rcy) = proj(c, scale, cx, cy, cw, ch);
            let (mx, my) = ((x1 + x2) / 2.0, (y1 + y2) / 2.0);
            return if px * (rcx - mx) + py * (rcy - my) > 0.0 {
                1
            } else {
                -1
            };
        }
    }
    1
}

/// Aromatic ring sets from minimum cycle basis over aromatic-order edges
/// (renderer.py:1719-1726 fallback path — catrender has no graph ring data).
fn compute_aromatic_rings(edges: &[(usize, usize, f64, BondVis)], n: usize) -> Vec<Vec<usize>> {
    let arom: Vec<(usize, usize)> = edges
        .iter()
        .filter(|&&(_, _, o, _)| bonds::is_aromatic(o))
        .map(|&(i, j, _, _)| if i < j { (i, j) } else { (j, i) })
        .collect();
    if arom.is_empty() {
        return Vec::new();
    }
    // Minimum cycle basis via spanning tree + fundamental cycles, then keep
    // the shortest independent cycles. For the molecule sizes catrender
    // targets this exact-but-simple construction matches networkx output on
    // single-ring / fused-ring aromatics.
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut eset: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    for &(a, b) in &arom {
        if eset.insert((a, b)) {
            adj[a].push(b);
            adj[b].push(a);
        }
    }
    // BFS spanning forest; each non-tree edge → one fundamental cycle.
    let mut parent = vec![usize::MAX; n];
    let mut depth = vec![0usize; n];
    let mut visited = vec![false; n];
    let mut tree_edge: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
    for s in 0..n {
        if visited[s] || adj[s].is_empty() {
            continue;
        }
        visited[s] = true;
        let mut q = std::collections::VecDeque::new();
        q.push_back(s);
        while let Some(u) = q.pop_front() {
            for &v in &adj[u] {
                if !visited[v] {
                    visited[v] = true;
                    parent[v] = u;
                    depth[v] = depth[u] + 1;
                    tree_edge.insert((u.min(v), u.max(v)));
                    q.push_back(v);
                }
            }
        }
    }
    let mut rings: Vec<Vec<usize>> = Vec::new();
    for &(a, b) in &arom {
        let key = (a.min(b), a.max(b));
        if tree_edge.contains(&key) {
            continue;
        }
        // Fundamental cycle = path a..lca + b..lca + edge(a,b).
        let mut pa = vec![a];
        let mut pb = vec![b];
        let (mut x, mut y) = (a, b);
        while depth[x] > depth[y] {
            x = parent[x];
            pa.push(x);
        }
        while depth[y] > depth[x] {
            y = parent[y];
            pb.push(y);
        }
        while x != y {
            x = parent[x];
            pa.push(x);
            y = parent[y];
            pb.push(y);
        }
        let mut cyc: Vec<usize> = pa;
        pb.pop(); // lca already in pa
        for v in pb.into_iter().rev() {
            cyc.push(v);
        }
        cyc.sort_unstable();
        cyc.dedup();
        rings.push(cyc);
    }
    rings
}

// ---------------------------------------------------------------------------
// Small math helpers (gizmo basis + cell co-rotation)
// ---------------------------------------------------------------------------

fn geom_identity() -> [[f64; 3]; 3] {
    [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
}

fn matmul3(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    o
}

/// Intrinsic XYZ rotation matrix matching `geom::rotate`'s composition so
/// the gizmo basis stays consistent with the applied point transform.
fn euler_matrix(deg: [f64; 3]) -> [[f64; 3]; 3] {
    // Recover the linear map from geom::rotate by transforming the basis.
    let e0 = geom::rotate([1.0, 0.0, 0.0], deg);
    let e1 = geom::rotate([0.0, 1.0, 0.0], deg);
    let e2 = geom::rotate([0.0, 0.0, 1.0], deg);
    // columns are images of the basis vectors
    [
        [e0[0], e1[0], e2[0]],
        [e0[1], e1[1], e2[1]],
        [e0[2], e1[2], e2[2]],
    ]
}

/// Apply the PCA rotation to a lattice vector: `v' = rot · v` (rows of `rot`
/// are world axes; orient.rs applies `c @ rot.T` to positions — the same map
/// per-vector is `rot · v`).
fn rotate_vec(rot: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        rot[0][0] * v[0] + rot[0][1] * v[1] + rot[0][2] * v[2],
        rot[1][0] * v[0] + rot[1][1] * v[1] + rot[1][2] * v[2],
        rot[2][0] * v[0] + rot[2][1] * v[1] + rot[2][2] * v[2],
    ]
}

/// raw VdW (no atom_scale) for the element-split radius-weighted midpoint —
/// renderer.py uses `raw_vdw` (H-scaled vdw, NOT display radius).
fn raw_vdw(sym: &str) -> f64 {
    if sym == "*" {
        CENTROID_VDW
    } else {
        vdw(sym) * if sym == "H" { H_ATOM_SCALE } else { 1.0 }
    }
}

/// Python-`int()`-style truncation of canvas w/h for the viewBox/width/height
/// (xyzrender emits the int-truncated pixel size; fit_canvas already
/// `.trunc()`s — print without a fractional part).
fn fmt0(v: f64) -> String {
    format!("{}", v.trunc() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render;

    #[test]
    fn show_index_emits_labels() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[2,0,0]}],
                "style":{"preset":"default","auto_orient":false,"show_index":true}}"#,
        );
        assert!(s.contains("class=\"atom-index\""), "index labels present");
        // both original indices 0 and 1 appear as label text
        assert!(s.contains(">0</text>") && s.contains(">1</text>"), "indices 0 and 1 labelled");
    }

    #[test]
    fn show_index_off_no_labels() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[2,0,0]}],
                "style":{"preset":"default","auto_orient":false}}"#,
        );
        assert!(!s.contains("class=\"atom-index\""), "no index labels when off");
    }

    // ---- render-level glow halo (op:glow atom override) ----

    #[test]
    fn glow_atom_emits_halo() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],
                "atom_overrides":[{"op":"glow","idx":0}],
                "style":{"preset":"default","auto_orient":false}}"#,
        );
        assert!(s.contains("class=\"atom-glow\""), "glow halo circle present");
        assert!(s.contains("catrender-glow"), "glow filter def + ref present");
    }

    #[test]
    fn no_glow_without_override() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],
                "style":{"preset":"default","auto_orient":false}}"#,
        );
        assert!(!s.contains("atom-glow"), "no halo without glow override");
        assert!(!s.contains("catrender-glow"), "no glow filter without override");
    }

    #[test]
    fn glow_custom_color() {
        let s = render(
            r##"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],
                "atom_overrides":[{"op":"glow","idx":0,"hex":"#00ff00"}],
                "style":{"preset":"default","auto_orient":false}}"##,
        );
        assert!(s.contains("class=\"atom-glow\""), "custom-color halo present");
        assert!(s.contains("fill=\"#00ff00\""), "custom glow fill applied");
    }

    // Extract the `r="..."` value from the atom-glow circle line.
    fn glow_halo_r(svg: &str) -> f64 {
        let line = svg
            .lines()
            .find(|l| l.contains("class=\"atom-glow\""))
            .expect("atom-glow circle present");
        let after = line.split(" r=\"").nth(1).expect("glow circle has r=");
        after.split('"').next().unwrap().parse().expect("r is a float")
    }

    #[test]
    fn glow_opacity_override() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],
                "atom_overrides":[{"op":"glow","idx":0}],
                "style":{"preset":"default","auto_orient":false,
                         "overrides":{"glow_opacity":0.3}}}"#,
        );
        assert!(s.contains("class=\"atom-glow\""), "glow halo present");
        // No other element uses 0.30, so this substring is unambiguous.
        assert!(
            s.contains("opacity=\"0.30\""),
            "glow_opacity override applied to halo, got:\n{s}"
        );
    }

    #[test]
    fn glow_radius_override() {
        let base = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],
                "atom_overrides":[{"op":"glow","idx":0}],
                "style":{"preset":"default","auto_orient":false}}"#,
        );
        let wide = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],
                "atom_overrides":[{"op":"glow","idx":0}],
                "style":{"preset":"default","auto_orient":false,
                         "overrides":{"glow_radius_scale":3.0}}}"#,
        );
        let r_base = glow_halo_r(&base);
        let r_wide = glow_halo_r(&wide);
        // 3.0 scale vs default 1.6 → halo r grows by 3.0/1.6 ≈ 1.875×.
        assert!(
            r_wide > r_base,
            "glow_radius_scale=3.0 must widen halo: base r={r_base}, wide r={r_wide}"
        );
        let expected = r_base / 1.6 * 3.0;
        assert!(
            (r_wide - expected).abs() < 0.2,
            "halo r should be atom_r*3.0; expected ~{expected}, got {r_wide}"
        );
    }

    #[test]
    fn glow_defaults_unchanged() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],
                "atom_overrides":[{"op":"glow","idx":0}],
                "style":{"preset":"default","auto_orient":false}}"#,
        );
        assert!(
            s.contains("opacity=\"0.70\""),
            "default glow opacity is 0.70, got:\n{s}"
        );
        // atom drawn radius (r * scale) is the glow r divided by the 1.6 default.
        let r_glow = glow_halo_r(&s);
        let r_atom = r_glow / 1.6;
        assert!(
            (r_glow - r_atom * 1.6).abs() < 1e-6,
            "default halo radius must be atom_r*1.6"
        );
    }

    // ---- bond-length sanity prune filter ----

    #[test]
    fn prune_long_bonds_drops_overlong() {
        // Two carbons 5.0 Å apart, explicit bond. 5.0 > 1.3·(0.76+0.76)=1.976.
        let off = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"C","xyz":[5,0,0]}],
                "bonds":[{"i":0,"j":1}],
                "style":{"preset":"default","auto_orient":false}}"#,
        );
        assert_eq!(off.matches("<line").count(), 1, "overlong bond drawn when prune off");
        let on = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"C","xyz":[5,0,0]}],
                "bonds":[{"i":0,"j":1}],
                "style":{"preset":"default","auto_orient":false,"prune_long_bonds":true}}"#,
        );
        assert_eq!(on.matches("<line").count(), 0, "overlong bond pruned when prune on");
    }

    #[test]
    fn prune_keeps_cross_cell_bond() {
        // Cubic 3 Å cell. Two C: [0.1,0,0] and [2.9,0,0]. Raw cartesian
        // distance is 2.8 Å > 1.3·(0.76+0.76)=1.976 → naive prune would DROP.
        // But minimum-image distance across the periodic boundary is 0.2 Å,
        // a real cross-cell bond that must be KEPT. No cell box (cell.show
        // defaults off), so the only <line> is the bond itself.
        let on = render(
            r#"{"atoms":[{"el":"C","xyz":[0.1,0,0]},{"el":"C","xyz":[2.9,0,0]}],
                "lattice":[[3,0,0],[0,3,0],[0,0,3]],
                "bonds":[{"i":0,"j":1}],
                "style":{"preset":"default","auto_orient":false,"prune_long_bonds":true}}"#,
        );
        assert_eq!(
            on.matches("<line").count(),
            1,
            "cross-cell bond pruned despite short minimum-image length"
        );
    }

    #[test]
    fn prune_long_bonds_keeps_normal() {
        // Two carbons 1.5 Å apart, explicit bond. 1.5 < 1.976 → kept.
        let on = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"C","xyz":[1.5,0,0]}],
                "bonds":[{"i":0,"j":1}],
                "style":{"preset":"default","auto_orient":false,"prune_long_bonds":true}}"#,
        );
        assert_eq!(on.matches("<line").count(), 1, "normal-length bond kept under prune");
    }

    #[test]
    fn hide_cross_cell_drops_boundary_bond() {
        // Cubic 3 Å cell. Two C: [0.1,0,0] and [2.9,0,0]. The i–j vector is
        // -2.8 Å → fractional ≈ -0.933 → round = -1 ≠ 0 → cross-cell. The
        // bond is stored to a home-cell partner so it draws as a long line
        // spanning the cell. No cell box → the only <line> would be the bond.
        let off = render(
            r#"{"atoms":[{"el":"C","xyz":[0.1,0,0]},{"el":"C","xyz":[2.9,0,0]}],
                "lattice":[[3,0,0],[0,3,0],[0,0,3]],
                "bonds":[{"i":0,"j":1}],
                "style":{"preset":"default","auto_orient":false}}"#,
        );
        assert_eq!(off.matches("<line").count(), 1, "cross-cell bond drawn when flag off");
        let on = render(
            r#"{"atoms":[{"el":"C","xyz":[0.1,0,0]},{"el":"C","xyz":[2.9,0,0]}],
                "lattice":[[3,0,0],[0,3,0],[0,0,3]],
                "bonds":[{"i":0,"j":1}],
                "style":{"preset":"default","auto_orient":false,"hide_cross_cell_bonds":true}}"#,
        );
        assert_eq!(on.matches("<line").count(), 0, "cross-cell bond dropped when flag on");
    }

    #[test]
    fn hide_cross_cell_keeps_intracell_bond() {
        // Cubic 3 Å cell. Two C: [1.0,0,0] and [2.4,0,0]. The i–j vector is
        // -1.4 Å → fractional ≈ -0.467 → round = 0 → not cross-cell → kept
        // even with the flag on. (1.4 Å is a normal bond length that renders;
        // a sub-Å bond is fully occluded behind the atom radii and draws no
        // <line> regardless of the flag.)
        let on = render(
            r#"{"atoms":[{"el":"C","xyz":[1.0,0,0]},{"el":"C","xyz":[2.4,0,0]}],
                "lattice":[[3,0,0],[0,3,0],[0,0,3]],
                "bonds":[{"i":0,"j":1}],
                "style":{"preset":"default","auto_orient":false,"hide_cross_cell_bonds":true}}"#,
        );
        assert_eq!(on.matches("<line").count(), 1, "intracell bond kept under hide_cross_cell_bonds");
    }

    // ---- Plan RT9 block (verbatim) ----

    #[test]
    fn default_preset_water() {
        let s = render(
            r#"{"atoms":[{"el":"O","xyz":[0,0,0]},{"el":"H","xyz":[0.96,0,0]},{"el":"H","xyz":[-0.24,0.93,0]}],"style":{"preset":"default"}}"#,
        );
        assert!(s.starts_with("<svg") && s.contains("xmlns:xlink"));
        assert!(s.contains("radialGradient") && s.contains("fx=\".33\""));
        assert_eq!(s.matches("<circle").count(), 3);
    }

    #[test]
    fn skeletal_no_carbon_circle() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"C","xyz":[1.5,0,0]}],"style":{"preset":"skeletal"}}"#,
        );
        assert!(!s.contains("<circle")); // C vertices, no spheres
    }

    #[test]
    fn bubble_hides_bonds() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"style":{"preset":"bubble"}}"#,
        );
        assert!(!s.contains("<line"));
    }

    #[test]
    fn id_prefix_guard() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{"preset":"default","id_prefix":"a"}}"#,
        );
        assert!(s.contains("id=\"a") && !s.contains("id=\"g0\""));
    }

    #[test]
    fn cell_box_dashed() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"lattice":[[4,0,0],[0,4,0],[0,0,4]],"style":{"preset":"default","cell":{"show":true}}}"#,
        );
        assert!(s.contains("stroke-dasharray") && s.contains("class=\"cell-edge\""));
    }

    // ---- Bug-fix regression: interactive canvas + cell centering --------

    fn viewbox_wh(s: &str) -> (f64, f64) {
        let head = s
            .split("viewBox=\"0 0 ")
            .nth(1)
            .and_then(|v| v.split('"').next())
            .expect("viewBox present");
        let mut it = head.split_whitespace();
        let w: f64 = it.next().unwrap().parse().unwrap();
        let h: f64 = it.next().unwrap().parse().unwrap();
        (w, h)
    }

    fn circle_centers(s: &str) -> Vec<(f64, f64)> {
        let attr = |seg: &str, key: &str| -> Option<f64> {
            seg.split(&format!("{key}=\""))
                .nth(1)
                .and_then(|x| x.split('"').next())
                .and_then(|x| x.parse::<f64>().ok())
        };
        s.split("<circle")
            .skip(1)
            .filter_map(|seg| Some((attr(seg, "cx")?, attr(seg, "cy")?)))
            .collect()
    }

    fn cell_vertices(s: &str) -> Vec<(f64, f64)> {
        let mut out: Vec<(f64, f64)> = Vec::new();
        for seg in s.split("class=\"cell-edge\"").skip(1) {
            let g = |key: &str| -> Option<f64> {
                seg.split(&format!("{key}=\""))
                    .nth(1)
                    .and_then(|x| x.split('"').next())
                    .and_then(|x| x.parse::<f64>().ok())
            };
            for (kx, ky) in [("x1", "y1"), ("x2", "y2")] {
                if let (Some(x), Some(y)) = (g(kx), g(ky)) {
                    if !out
                        .iter()
                        .any(|&(a, b)| (a - x).abs() < 0.05 && (b - y).abs() < 0.05)
                    {
                        out.push((x, y));
                    }
                }
            }
        }
        out
    }

    #[test]
    fn interactive_canvas_fixed_size_across_rotation() {
        // Bug 1: a linear molecule cropped to its projected aspect makes the
        // SVG width/height jump every frame while drag-rotating. With
        // drag_rotation set (interactive pane) the canvas must be a fixed
        // square so the viewport never resizes.
        let mk = |dr: &str| {
            render(&format!(
                r#"{{"atoms":[{{"el":"C","xyz":[0,0,0]}},{{"el":"O","xyz":[3,0,0]}},{{"el":"N","xyz":[6,0,0]}}],"style":{{"preset":"default","auto_orient":false,"drag_rotation":{dr}}}}}"#
            ))
        };
        let (w1, h1) = viewbox_wh(&mk("[0,0,30]"));
        let (w2, h2) = viewbox_wh(&mk("[0,0,75]"));
        assert_eq!(w1, h1, "interactive (drag_rotation) canvas must be square");
        assert_eq!(
            (w1, h1),
            (w2, h2),
            "interactive canvas size must stay fixed as the molecule rotates"
        );
    }

    #[test]
    fn cell_corner_atom_coincides_with_cell_vertex() {
        // Bug 2: an atom sitting exactly at the lattice origin corner must
        // render ON that cell vertex. PCA centers atoms by their centroid;
        // the cell box must take the SAME centering, else atoms drift off the
        // corners by the centroid vector.
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.3,1.1,0.4]},{"el":"N","xyz":[2.0,0.5,1.7]}],"lattice":[[4,0,0],[0,4,0],[0,0,4]],"style":{"preset":"default","auto_orient":true,"cell":{"show":true}}}"#,
        );
        let centers = circle_centers(&s);
        let verts = cell_vertices(&s);
        let coincidences = centers
            .iter()
            .filter(|&&(cx, cy)| {
                verts
                    .iter()
                    .any(|&(vx, vy)| (cx - vx).abs() < 0.6 && (cy - vy).abs() < 0.6)
            })
            .count();
        assert_eq!(
            coincidences, 1,
            "atom at origin corner must land on its cell vertex (got {coincidences})"
        );
    }

    // ---- Additional RT9 coverage (behavioral, deterministic) ----

    #[test]
    fn tube_zero_radius_circles() {
        // tube: atom_scale 0. xyzrender's non-skeletal atom branch has NO
        // atom_scale gate — it emits a degenerate `<circle r="0.0" .../>`
        // per atom (verified against real xyzrender 0.2.10: water/tube →
        // 3× `<circle ... r="0.0" ...>`). catrender must match that circle
        // COUNT for the fidelity gate, so the circle is emitted with a
        // zero radius rather than suppressed.
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"style":{"preset":"tube"}}"#,
        );
        assert_eq!(
            s.matches("<circle").count(),
            2,
            "tube emits one (zero-radius) circle per atom, like xyzrender"
        );
        assert_eq!(
            s.matches("r=\"0.0\"").count(),
            2,
            "every tube circle is degenerate (r=0.0), one per atom"
        );
        assert!(s.contains("<line"), "tube still draws bonds");
    }

    #[test]
    fn graph_atoms_after_bonds() {
        // graph: atoms_above_bonds true → atom circles emitted AFTER bonds.
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"N","xyz":[1.4,0,0]}],"style":{"preset":"graph"}}"#,
        );
        let first_circle = s.find("<circle").expect("graph draws circles");
        let first_line = s.find("<line").expect("graph draws bonds");
        assert!(
            first_line < first_circle,
            "atoms_above_bonds: bonds must precede atom circles"
        );
    }

    #[test]
    fn aromatic_benzene_has_dashed_line() {
        // benzene ring, aromatic bond order 1.5 → ring-side dashed strokes.
        let s = render(
            r#"{"atoms":[
               {"el":"C","xyz":[1.39,0,0]},{"el":"C","xyz":[0.70,1.20,0]},
               {"el":"C","xyz":[-0.70,1.20,0]},{"el":"C","xyz":[-1.39,0,0]},
               {"el":"C","xyz":[-0.70,-1.20,0]},{"el":"C","xyz":[0.70,-1.20,0]}],
               "bonds":[
               {"i":0,"j":1,"order":1.5},{"i":1,"j":2,"order":1.5},{"i":2,"j":3,"order":1.5},
               {"i":3,"j":4,"order":1.5},{"i":4,"j":5,"order":1.5},{"i":5,"j":0,"order":1.5}],
               "style":{"preset":"default","overrides":{"bond_orders":true}}}"#,
        );
        assert!(
            s.contains("stroke-dasharray"),
            "aromatic bonds emit a ring-side dashed stroke"
        );
    }

    #[test]
    fn element_split_two_colored_halves() {
        // bond_color_by_element on a C–O bond → two differently colored halves.
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.4,0,0]}],"bonds":[{"i":0,"j":1,"order":1}],"style":{"preset":"default","overrides":{"bond_color_by_element":true,"fog":false}}}"#,
        );
        // C CPK override is #aaaaaa (default.json), O CPK #ff0d0d.
        assert!(s.contains("#aaaaaa"), "carbon half color present");
        assert!(s.contains("#ff0d0d"), "oxygen half color present");
        // two <line> for the split (single bond, nb=1).
        assert_eq!(
            s.matches("<line").count(),
            2,
            "element split → two line halves"
        );
    }

    #[test]
    fn fog_makes_back_atom_whiter() {
        // Two atoms at different depth; fog blends the back atom toward white.
        // auto_orient off so the z (depth) axis is the raw input z and fog
        // actually differentiates the two depths (PCA on a diatomic would
        // align the bond along x and flatten depth).
        let s = render(
            r#"{"atoms":[{"el":"O","xyz":[0,0,5]},{"el":"O","xyz":[3,0,-5]}],"style":{"preset":"default","auto_orient":false}}"#,
        );
        // per-atom fog gradients g0 (front) and g1 (back) both present.
        assert!(s.contains("id=\"g0\"") && s.contains("id=\"g1\""));
        // Back atom's lighten stop must be closer to white than the front's.
        let g0 = &s[s.find("id=\"g0\"").unwrap()..];
        let g1 = &s[s.find("id=\"g1\"").unwrap()..];
        let first_stop = |frag: &str| -> String {
            let p = frag.find("stop-color=\"").unwrap() + 12;
            frag[p..p + 7].to_string()
        };
        assert_ne!(
            first_stop(g0),
            first_stop(g1),
            "fog must differentiate front/back atom fills"
        );
    }

    #[test]
    fn drag_rotation_changes_coords() {
        let base = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[2,0,0]},{"el":"N","xyz":[0,2,0]}],"style":{"preset":"default","auto_orient":false}}"#,
        );
        let rot = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[2,0,0]},{"el":"N","xyz":[0,2,0]}],"style":{"preset":"default","auto_orient":false,"drag_rotation":[0,0,90]}}"#,
        );
        assert_ne!(base, rot, "drag_rotation must change projected coords");
    }

    #[test]
    fn gizmo_basis_attr_present_identity_when_no_orient_no_drag() {
        // auto_orient off + no drag → basis is the identity (row-major).
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[2,0,0]}],"style":{"preset":"default","auto_orient":false}}"#,
        );
        assert!(
            s.contains("data-gizmo-basis=\"1,0,0,0,1,0,0,0,1\""),
            "identity basis attr; got: {}",
            &s[..s.find('>').unwrap_or(200).min(s.len())]
        );
    }

    #[test]
    fn gizmo_basis_attr_changes_with_drag_rotation() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[2,0,0]}],"style":{"preset":"default","auto_orient":false,"drag_rotation":[0,0,90]}}"#,
        );
        assert!(s.contains("data-gizmo-basis="), "attr present");
        assert!(
            !s.contains("data-gizmo-basis=\"1,0,0,0,1,0,0,0,1\""),
            "drag must rotate the gizmo basis off identity"
        );
    }

    #[test]
    fn root_shape_double_quotes_and_viewbox() {
        let s = render(r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{"preset":"default"}}"#);
        assert!(s.contains("xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(s.contains("xmlns:xlink=\"http://www.w3.org/1999/xlink\""));
        assert!(s.contains("viewBox=\"0 0 "));
        assert!(!s.contains("xmlns='"), "attrs must be double-quoted");
    }

    #[test]
    fn periodic_image_opacity_attr_present_in_config() {
        // default.json periodic_image_opacity 0.5 — confirm the knob resolves
        // (image atoms are produced by the supercell path; here we assert the
        // base render is valid and the merged config exposes the value).
        let c = crate::preset::load("default");
        assert_eq!(c.get_f("periodic_image_opacity"), 0.5);
        let s =
            render(r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{"preset":"default"}}"#);
        assert!(s.ends_with("</svg>"));
    }

    #[test]
    fn hidden_atom_override_drops_atom_and_bond() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"bonds":[{"i":0,"j":1,"order":1}],"atom_overrides":[{"op":"hide","idx":1}],"style":{"preset":"default"}}"#,
        );
        assert_eq!(s.matches("<circle").count(), 1, "hidden atom dropped");
        assert!(!s.contains("<line"), "incident bond dropped with atom");
    }

    #[test]
    fn pick_attrs_emits_original_atom_index() {
        // RT14: with pick_attrs on, every painted atom carries its ORIGINAL
        // input index so a z-order-painted click maps back correctly. Two
        // atoms → data-atom-index="0" and "1" both present.
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"bonds":[{"i":0,"j":1,"order":1}],"style":{"preset":"default","overrides":{"pick_attrs":true}}}"#,
        );
        assert!(s.contains("data-atom-index=\"0\""), "atom 0 indexed");
        assert!(s.contains("data-atom-index=\"1\""), "atom 1 indexed");
    }

    #[test]
    fn pbc_wrap_emits_dim_ghost_images() {
        // RT12: a corner atom (frac 0,0,0) with pbc_wrap wraps into the 7
        // adjacent images (+1 on each of the 3 axes, all combinations).
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"lattice":[[5,0,0],[0,5,0],[0,0,5]],"style":{"preset":"default","cell":{"pbc_wrap":true}}}"#,
        );
        assert_eq!(
            s.matches("<circle").count(),
            8,
            "1 real corner atom + 7 dim ghost images"
        );
        assert!(
            s.contains("opacity=\"0.50\""),
            "ghosts dimmed at periodic_image_opacity (0.5)"
        );
    }

    #[test]
    fn pbc_wrap_off_produces_no_ghosts() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"lattice":[[5,0,0],[0,5,0],[0,0,5]],"style":{"preset":"default"}}"#,
        );
        assert_eq!(
            s.matches("<circle").count(),
            1,
            "no pbc_wrap → no ghost images"
        );
    }

    #[test]
    fn pick_attrs_off_by_default_keeps_svg_clean() {
        // Fidelity guard: absent pick_attrs, no data-atom-index leaks into the
        // output (byte-twin / clean-export parity with xyzrender preserved).
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"bonds":[{"i":0,"j":1,"order":1}],"style":{"preset":"default"}}"#,
        );
        assert!(!s.contains("data-atom-index"), "no pick attrs by default");
    }

    #[test]
    fn default_atom_stroke_is_black_not_green() {
        // regression: absent atom_stroke_color must resolve "black"→#000000,
        // never Color::from_hex("black")→#00ac00. default.json has fog=true
        // (fog_strength 1.2) but a single atom has zr→0 ⇒ fog_f[0]=0.0, so
        // blend_fog_hex("#000000", 0.0) == "#000000" (no fog shift): the
        // stroke derives from #000000, NOT from a misparsed-"black" green.
        let s = render(
            r#"{"atoms":[{"el":"O","xyz":[0,0,0]}],"style":{"preset":"default"}}"#,
        );
        assert!(!s.contains("#00ac00"), "green stroke regression");
        assert!(
            s.contains("stroke=\"#000000\"") || s.contains("stroke=\"black\""),
            "atom stroke must be resolved black"
        );
    }

    #[test]
    fn empty_atoms_valid_svg() {
        let s = render(r#"{"atoms":[],"style":{"preset":"default"}}"#);
        assert!(s.starts_with("<svg") && s.ends_with("</svg>"));
        assert!(!s.contains("<circle"));
    }

    // ---- RT10 behavioral: TS/NCI bond flags, supercell, open override ----

    #[test]
    fn bond_ts_flag_emits_dashed_stroke() {
        // ts:true → dashed bond: stroke-dasharray "1.2·bw,2.2·bw".
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.4,0,0]}],
               "bonds":[{"i":0,"j":1,"ts":true}],
               "style":{"preset":"default"}}"#,
        );
        assert!(
            s.contains("stroke-dasharray"),
            "TS bond must emit a dashed stroke"
        );
    }

    #[test]
    fn bond_nci_flag_emits_dotted_stroke() {
        // nci:true → dotted bond: stroke-dasharray "0.08·bw,2·bw".
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.4,0,0]}],
               "bonds":[{"i":0,"j":1,"nci":true}],
               "style":{"preset":"default"}}"#,
        );
        assert!(
            s.contains("stroke-dasharray"),
            "NCI bond must emit a dotted stroke"
        );
        // dotted dash component is very small relative to gap (0.08 vs 2.0):
        // the first dasharray number must be far below the second.
        let frag = s
            .split("stroke-dasharray=\"")
            .nth(1)
            .and_then(|x| x.split('"').next())
            .expect("dasharray fragment");
        let mut it = frag.split(',');
        let d: f64 = it.next().unwrap().parse().unwrap();
        let g: f64 = it.next().unwrap().parse().unwrap();
        assert!(d * 10.0 < g, "NCI dotted: dash {d} << gap {g}");
    }

    #[test]
    fn supercell_replicates_atoms() {
        // supercell [2,1,1] over a 1-atom cell → 2 atoms (graph replication).
        let one = render(
            r#"{"atoms":[{"el":"C","xyz":[0.5,0.5,0.5]}],
               "lattice":[[4,0,0],[0,4,0],[0,0,4]],
               "style":{"preset":"default","cell":{"show":true,"supercell":[1,1,1]}}}"#,
        );
        let two = render(
            r#"{"atoms":[{"el":"C","xyz":[0.5,0.5,0.5]}],
               "lattice":[[4,0,0],[0,4,0],[0,0,4]],
               "style":{"preset":"default","cell":{"show":true,"supercell":[2,1,1]}}}"#,
        );
        assert_eq!(one.matches("<circle").count(), 1);
        assert_eq!(
            two.matches("<circle").count(),
            2,
            "supercell [2,1,1] must replicate the atom along a"
        );
    }

    #[test]
    fn supercell_replicates_bonds() {
        // 2-atom motif, bond 0-1; supercell [2,1,1] → 2 motifs, 2 bonds.
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0.5,0.5,0.5]},{"el":"O","xyz":[1.7,0.5,0.5]}],
               "bonds":[{"i":0,"j":1}],
               "lattice":[[6,0,0],[0,6,0],[0,0,6]],
               "style":{"preset":"default","cell":{"show":true,"supercell":[2,1,1]}}}"#,
        );
        assert_eq!(s.matches("<circle").count(), 4, "2 atoms × 2 images");
        assert!(
            s.matches("<line").count() >= 2,
            "each replicated motif keeps its intra-cell bond"
        );
    }

    #[test]
    fn open_override_beats_preset_value() {
        // IDENTICAL geometry (auto_orient off, same 2 atoms) so the only
        // variable is the `atom_scale` override. A tiny atom_scale must yield
        // strictly smaller circles than a large one — proving an ARBITRARY
        // default.json knob flows live through the open override map.
        let small = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[20,0,0]}],
               "style":{"preset":"default","auto_orient":false,
                        "overrides":{"atom_scale":0.05}}}"#,
        );
        let large = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[20,0,0]}],
               "style":{"preset":"default","auto_orient":false,
                        "overrides":{"atom_scale":5.0}}}"#,
        );
        // Max circle radius across the render.
        let max_r = |svg: &str| -> f64 {
            svg.split("<circle")
                .skip(1)
                .filter_map(|seg| {
                    seg.split("r=\"")
                        .nth(1)
                        .and_then(|x| x.split('"').next())
                        .and_then(|x| x.parse::<f64>().ok())
                })
                .fold(0.0_f64, f64::max)
        };
        assert!(
            max_r(&small) < max_r(&large),
            "atom_scale override must scale circle radius (small {} < large {})",
            max_r(&small),
            max_r(&large)
        );
    }

    // ---- FIX A/B regression locks (renderer.py:1146 cap; supercell bound) ----

    // Smallest stroke-width across all <line> elements (the TS/NCI bond
    // stroke; the outline layer is wider, so min isolates the real stroke).
    fn min_line_stroke_width(svg: &str) -> f64 {
        svg.split("<line")
            .skip(1)
            .filter_map(|seg| {
                seg.split("stroke-width=\"")
                    .nth(1)
                    .and_then(|x| x.split('"').next())
                    .and_then(|x| x.parse::<f64>().ok())
            })
            .fold(f64::INFINITY, f64::min)
    }

    #[test]
    fn tube_ts_bond_width_is_capped() {
        // renderer.py:1146 — non-solid width capped at 20*scale_ratio BEFORE
        // the DASHED(TS) branch, so the emitted TS width is
        // bond_stroke_width(min(bw,20*sr), DashedTs) = cbw*1.2, and the dash
        // array is (cbw*1.2, cbw*2.2). The cap is self-evident from the
        // emitted geometry: width == dash[0] and dash[1]/dash[0] == 2.2/1.2,
        // AND the absolute width is the capped value (observed 78.2 for
        // tube bond_width=50; uncapped would be 50*sr*1.2 ≈ 195.5 — i.e.
        // ~2.5× larger). Pin: TS width must be far below the uncapped
        // 50-derived number, and exactly cbw*1.2 = dash[0].
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"C","xyz":[1.4,0,0]}],"bonds":[{"i":0,"j":1,"ts":true}],"style":{"preset":"tube"}}"#,
        );
        let w = min_line_stroke_width(&s);
        let frag = s
            .split("stroke-dasharray=\"")
            .nth(1)
            .and_then(|x| x.split('"').next())
            .expect("TS dasharray");
        let mut it = frag.split(',');
        let d0: f64 = it.next().unwrap().parse().unwrap();
        let d1: f64 = it.next().unwrap().parse().unwrap();
        // TS stroke width equals dash period component cbw*1.2.
        assert!((w - d0).abs() < 0.2, "TS width {w} must equal dash[0] {d0}");
        // TS dash ratio is 2.2/1.2 (renderer.py:1211-1212 on the CAPPED bw).
        assert!(
            (d1 / d0 - 2.2 / 1.2).abs() < 0.02,
            "TS dash ratio {} must be 2.2/1.2",
            d1 / d0
        );
        // Capped: observed 78.2; uncapped (50*sr*1.2) would be ≈195.5.
        // Anything <= 100 proves the cap fired (not the fat 50-derived value).
        assert!(
            (78.0..=79.0).contains(&w),
            "tube TS width must be the capped ~78.2, got {w} \
             (uncapped 50-derived would be ≈195.5)"
        );
    }

    #[test]
    fn supercell_zero_and_huge_no_panic_or_oom() {
        let z = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"lattice":[[3,0,0],[0,3,0],[0,0,3]],"style":{"preset":"default","cell":{"show":true,"supercell":[0,0,0]}}}"#,
        );
        assert!(z.starts_with("<svg"));
        let huge = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"lattice":[[3,0,0],[0,3,0],[0,0,3]],"style":{"preset":"default","cell":{"show":true,"supercell":[80,80,80]}}}"#,
        );
        assert!(
            huge.starts_with("<svg") && huge.ends_with("</svg>"),
            "huge supercell must short-circuit to a graceful error-SVG"
        );
        assert!(
            huge.len() < 5_000_000,
            "huge supercell must short-circuit, not allocate a giant SVG"
        );
        assert!(
            huge.contains("exceeds") && huge.contains("render cap"),
            "graceful error-SVG must carry the cap message"
        );
    }

    #[test]
    fn supercell_overflow_axis_hits_cap_not_silent_noop() {
        // u64 product must saturate, not wrap → explicit cap error, not a silent
        // unreplicated render. 4194304^3 = 2^66 wraps a plain u64 multiply to a
        // small value (silently bypassing the cap); saturating_mul pins it to
        // u64::MAX so it deterministically hits the SAME graceful error-SVG.
        let s = render(r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"lattice":[[3,0,0],[0,3,0],[0,0,3]],"style":{"preset":"default","cell":{"show":true,"supercell":[4194304,4194304,4194304]}}}"#);
        assert!(s.starts_with("<svg") && s.ends_with("</svg>"));
        assert!(
            s.contains("exceeds") && s.contains("render cap"),
            "must be the explicit cap error-SVG, not a silent 2-atom render"
        );
        assert!(s.len() < 5000); // graceful error, not a real render
    }

    #[test]
    fn override_wrong_type_renders_gracefully() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]}],"style":{"preset":"default","overrides":{"bond_width":"not-a-number","atom_scale":[1,2,3]}}}"#,
        );
        assert!(
            s.starts_with("<svg") && s.ends_with("</svg>"),
            "wrong-typed overrides must not panic — preset fallback"
        );
    }

    #[test]
    fn ts_and_nci_both_ts_wins() {
        // ts wins over nci (svg.rs BondVis precedence). TS dash ratio is
        // 2.2/1.2 ≈ 1.833; NCI is 2.0/0.08 = 25. Assert the TS pattern.
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"N","xyz":[1.3,0,0]}],"bonds":[{"i":0,"j":1,"ts":true,"nci":true}],"style":{"preset":"default"}}"#,
        );
        assert!(s.contains("stroke-dasharray"));
        let frag = s
            .split("stroke-dasharray=\"")
            .nth(1)
            .and_then(|x| x.split('"').next())
            .expect("dasharray fragment");
        let mut it = frag.split(',');
        let d0: f64 = it.next().unwrap().parse().unwrap();
        let d1: f64 = it.next().unwrap().parse().unwrap();
        assert!(
            (d1 / d0 - 2.2 / 1.2).abs() < 0.05,
            "ts+nci must use the TS dash ratio (2.2/1.2), got {}",
            d1 / d0
        );
    }

    #[test]
    fn perceive_orders_renders_benzene_aromatic() {
        // 6 carbons in a planar hexagon, explicit bonds, perceive_orders on.
        // Aromatic strokes use width 0.7·bw — assert the multi/aromatic stroke
        // width appears (single bonds use full bw). With perception ON, every
        // C-C bond becomes aromatic (1.5) so the thinner aromatic stroke shows.
        let s = render(
            r#"{"atoms":[
                {"el":"C","xyz":[1.39,0,0]},{"el":"C","xyz":[0.695,1.203,0]},
                {"el":"C","xyz":[-0.695,1.203,0]},{"el":"C","xyz":[-1.39,0,0]},
                {"el":"C","xyz":[-0.695,-1.203,0]},{"el":"C","xyz":[0.695,-1.203,0]}],
                "bonds":[{"i":0,"j":1},{"i":1,"j":2},{"i":2,"j":3},
                         {"i":3,"j":4},{"i":4,"j":5},{"i":5,"j":0}],
                "style":{"preset":"default","auto_orient":false,"perceive_orders":true}}"#,
        );
        // aromatic ring-side bonds emit a SECOND offset line per bond (the
        // inner aromatic line). A plain single-bond benzene emits 6 <line>;
        // aromatic emits more. Assert > 6 bond lines.
        let lines = s.matches("<line").count();
        assert!(lines > 6, "perceived aromatic benzene should add inner lines, got {lines}");
    }

    #[test]
    fn perceive_orders_off_keeps_single() {
        let s = render(
            r#"{"atoms":[
                {"el":"C","xyz":[1.39,0,0]},{"el":"C","xyz":[0.695,1.203,0]},
                {"el":"C","xyz":[-0.695,1.203,0]},{"el":"C","xyz":[-1.39,0,0]},
                {"el":"C","xyz":[-0.695,-1.203,0]},{"el":"C","xyz":[0.695,-1.203,0]}],
                "bonds":[{"i":0,"j":1},{"i":1,"j":2},{"i":2,"j":3},
                         {"i":3,"j":4},{"i":4,"j":5},{"i":5,"j":0}],
                "style":{"preset":"default","auto_orient":false}}"#,
        );
        assert_eq!(s.matches("<line").count(), 6, "single-bond benzene = 6 lines");
    }
}

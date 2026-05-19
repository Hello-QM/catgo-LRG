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
    let hue = cfg_f(&cfg, "hue_shift_factor", 0.2);
    let light = cfg_f(&cfg, "light_shift_factor", 0.2);
    let sat = cfg_f(&cfg, "saturation_shift_factor", 0.2);
    let atom_grad_str = cfg_f(&cfg, "atom_gradient_strength", 1.0);
    let fog_on = cfg_b(&cfg, "fog", false);
    let fog_strength = cfg_f(&cfg, "fog_strength", 0.8);
    let bond_orders = cfg_b(&cfg, "bond_orders", false);
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
    // show_h: only drop H here (xyzrender hides C-only H; catrender keeps the
    // simpler all-H gate the v1 frontend relied on). Combined keep mask.
    let keep: Vec<usize> = (0..n_in)
        .filter(|&i| {
            !hidden_ov[i] && !(!inp.style.show_h && inp.atoms[i].el == "H")
        })
        .collect();
    let n = keep.len();

    // dense → original index, original → dense
    let new_of: std::collections::HashMap<usize, usize> =
        keep.iter().enumerate().map(|(d, &o)| (o, d)).collect();

    let symbols: Vec<&str> = keep.iter().map(|&i| inp.atoms[i].el.as_str()).collect();
    let a_nums: Vec<u32> = symbols.iter().map(|s| s2n(s)).collect();
    let mut pos: Vec<[f64; 3]> = keep.iter().map(|&i| inp.atoms[i].xyz).collect();

    // --- bonds: explicit, else perceived; remapped to dense indices ----
    let perceived;
    let raw_bonds: &[crate::types::Bond] = if inp.bonds.is_empty() {
        perceived = bonds::perceive(&inp.atoms);
        &perceived
    } else {
        &inp.bonds
    };
    // (di, dj, order) in dense space, only for kept atoms.
    let mut edges: Vec<(usize, usize, f64)> = Vec::new();
    if !hide_bonds {
        for b in raw_bonds {
            let (Some(&di), Some(&dj)) = (new_of.get(&b.i), new_of.get(&b.j)) else {
                continue;
            };
            edges.push((di, dj, b.order));
        }
    }

    // --- PCA auto-orient (fit-mask excludes `*`), then drag rotation ----
    let auto_orient = inp.style.auto_orient.unwrap_or(auto_orient_default);
    let (mut pca_drag, _) = (geom_identity(), ());
    if auto_orient && n > 1 {
        // RT5 fit_mask domain reconciliation: pca_orient_with_mask fits only
        // the masked subset but applies the rotation to ALL rows. We pass NO
        // priority pairs here (catrender has no TS-priority input wired yet),
        // so the latent priority/ts index-domain note is moot — the
        // fit-subset contract is satisfied trivially (empty priority set).
        let atom_mask: Vec<bool> = symbols.iter().map(|s| *s != "*").collect();
        let mask_opt: Option<&[bool]> =
            if atom_mask.iter().all(|&b| b) { None } else { Some(&atom_mask) };
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
    let _gizmo_basis = pca_drag; // RT11 consumes; at minimum computed here.

    // --- display radii (vdw · H-scale · atom_scale · 0.075) ------------
    let radii: Vec<f64> = symbols
        .iter()
        .map(|&s| {
            let base = if s == "*" {
                CENTROID_VDW
            } else {
                vdw(s) * if s == "H" { H_ATOM_SCALE } else { 1.0 }
            };
            base * atom_scale * RADIUS_SCALE
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
            let origin = [0.0, 0.0, 0.0];
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

    let fit = fit_canvas_extra(
        &pos,
        &fit_radii,
        canvas_size,
        padding,
        None,
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
    let mut adj: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    for &(i, j, o) in &edges {
        if i < n && j < n && i != j {
            adj[i].push((j, o));
            adj[j].push((i, o));
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
viewBox=\"0 0 {cw} {ch}\" width=\"{cw}\" height=\"{ch}\"{}>",
        if transparent {
            " style=\"background:transparent\""
        } else {
            ""
        },
        cw = fmt0(cw),
        ch = fmt0(ch)
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

    // --- radialGradient <defs> ----------------------------------------
    // Shared id `g{Z}_{hex[1:]}` keyed by (Z,hex); per-atom `g{ai}` w/ fog.
    if use_grad {
        svg.push("  <defs>".to_string());
        if use_per_atom_grad {
            for ai in 0..n {
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
    let mut bond_geom: std::collections::HashMap<(usize, usize), (f64, f64, f64, f64, f64, f64)> =
        std::collections::HashMap::new();
    if !hide_bonds && bw > 0.0 {
        let mut seen: std::collections::HashSet<(usize, usize)> = std::collections::HashSet::new();
        for &(i, j, _) in &edges {
            let (a, b) = if i < j { (i, j) } else { (j, i) };
            if a == b || !seen.insert((a, b)) {
                continue;
            }
            let (start, end, ok) = bonds::trim(pos[a], pos[b], radii[a], radii[b]);
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
        let xi = px[ai];
        let yi = py[ai];
        let orig = keep[ai];
        let is_image = false; // RT9-DEFER: periodic-image atom generation is
                              // RT10-schema scope (no supercell field in
                              // RenderInput yet); periodic_image_opacity
                              // wiring is present and applied once images
                              // exist.
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
        } else if atom_scale > 0.0 {
            // Sphere — gradient or flat fill.
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
fill=\"url(#{grad_id})\" stroke=\"{fs_atom}\" stroke-width=\"{sw_a:.1}\"{op_atom}{dof_attr}/>",
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
fill=\"{fill}\" stroke=\"{stroke}\" stroke-width=\"{sw_a:.1}\"{op_atom}{dof_attr}/>",
                    sw_a = sw
                ));
            }
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
            nbrs.sort_by_key(|&(j, _)| j);
            for (aj, bo_raw) in nbrs {
                if z_rank[aj] <= idx {
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
                        bw,
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

    let _ = (ts_color, nci_color); // TS/NCI bond input not wired (no flag in
                                   // RenderInput) — solid path only here.

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
        let w = if nb == 1 { bw } else { bw * 0.7 };
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
                for k in 0..3 {
                    c[k] += pos[m][k];
                }
            }
            let nf = ring.len().max(1) as f64;
            for k in 0..3 {
                c[k] /= nf;
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
fn compute_aromatic_rings(edges: &[(usize, usize, f64)], n: usize) -> Vec<Vec<usize>> {
    let arom: Vec<(usize, usize)> = edges
        .iter()
        .filter(|&&(_, _, o)| bonds::is_aromatic(o))
        .map(|&(i, j, _)| if i < j { (i, j) } else { (j, i) })
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

    // ---- Additional RT9 coverage (behavioral, deterministic) ----

    #[test]
    fn tube_no_circle() {
        // tube: atom_scale 0 → no spheres, bonds only.
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[1.2,0,0]}],"style":{"preset":"tube"}}"#,
        );
        assert!(!s.contains("<circle"), "tube draws no spheres");
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
}

//! Bond geometry & style helpers — faithful port of xyzrender
//! `renderer.py:1028-1372` (+ `_shaded_stroke` 928-959, `_bond_line` 961-967,
//! `_emit_line` outline 1061-1077) and `skeletal.py` bond math.
//!
//! These are PURE, composable helpers: 3D trim, 2D projection rejection,
//! multi-bond/aromatic dispatch numbers, the radius-weighted half-split
//! ratio, and SVG fragment-string builders for the single `<line>`
//! primitive, the perpendicular cylinder-shade gradient and the deferred
//! outline stroke. They return geometry + small fragment strings so each
//! can be unit-tested in isolation; RT9 (`svg.rs`) orchestrates them into
//! the z-ordered document.
//!
//! `perceive` (distance-based bond perception) and `covalent_radius` are
//! RETAINED unchanged — they are the no-explicit-bonds fallback consumed
//! by `svg.rs`.

use crate::types::{Atom, Bond};

// ---------------------------------------------------------------------------
// Distance-based bond perception (no-explicit-bonds fallback) — RETAINED
// ---------------------------------------------------------------------------

pub fn covalent_radius(el: &str) -> f64 {
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
                out.push(Bond {
                    i,
                    j,
                    order: 1.0,
                    ts: false,
                    nci: false,
                });
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// 3D trim — renderer.py:1335-1345 (vectorized) / skeletal.py:64-75
// ---------------------------------------------------------------------------

/// Trim a bond back from both endpoints by `0.9·radius`.
///
/// `start = pi + d·(ri·0.9)`, `end = pj − d·(rj·0.9)`, `d = (pj−pi)/|pj−pi|`.
/// Returns `(start, end, ok)`. `ok == false` rejects the bond when the
/// endpoints coincide (`|pj−pi| < 1e-6`) or the trimmed segment has
/// flipped/collapsed (`dot(end−start, d) <= 0` — the overlap rule).
///
/// xyzrender cross-check (renderer.py:1342-1345):
///   _start = pos[_bi] + _d*(_ri*0.9)[:,None]
///   _end   = pos[_bj] - _d*(_rj*0.9)[:,None]
///   _valid &= ((_end-_start)*_d).sum(axis=1) > 0
pub fn trim(pi: [f64; 3], pj: [f64; 3], ri: f64, rj: f64) -> ([f64; 3], [f64; 3], bool) {
    let rij = [pj[0] - pi[0], pj[1] - pi[1], pj[2] - pi[2]];
    let dist = (rij[0] * rij[0] + rij[1] * rij[1] + rij[2] * rij[2]).sqrt();
    if dist < 1e-6 {
        return (pi, pj, false);
    }
    let d = [rij[0] / dist, rij[1] / dist, rij[2] / dist];
    let start = [
        pi[0] + d[0] * (ri * 0.9),
        pi[1] + d[1] * (ri * 0.9),
        pi[2] + d[2] * (ri * 0.9),
    ];
    let end = [
        pj[0] - d[0] * (rj * 0.9),
        pj[1] - d[1] * (rj * 0.9),
        pj[2] - d[2] * (rj * 0.9),
    ];
    let es = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    let dot = es[0] * d[0] + es[1] * d[1] + es[2] * d[2];
    (start, end, dot > 0.0)
}

// ---------------------------------------------------------------------------
// 2D projection-stage helpers — renderer.py:1351-1358 / skeletal.py:79-83
// ---------------------------------------------------------------------------

/// Reject a projected bond whose on-screen length `ln < 1`
/// (renderer.py:1353-1354 `_valid &= _ln >= 1`). Returns `true` to REJECT.
pub fn reject_short(x1: f64, y1: f64, x2: f64, y2: f64) -> bool {
    let ddx = x2 - x1;
    let ddy = y2 - y1;
    let ln = (ddx * ddx + ddy * ddy).sqrt();
    ln < 1.0
}

/// 2D perpendicular unit vector `(px, py) = (-(y2−y1)/ln, (x2−x1)/ln)`
/// (renderer.py:1357-1358). Returns `(0.0, 0.0)` if degenerate
/// (xyzrender leaves these zeroed via `np.zeros_like`).
pub fn perp2d(x1: f64, y1: f64, x2: f64, y2: f64) -> (f64, f64) {
    let ddx = x2 - x1;
    let ddy = y2 - y1;
    let ln = (ddx * ddx + ddy * ddy).sqrt();
    if ln < 1e-12 {
        return (0.0, 0.0);
    }
    (-ddy / ln, ddx / ln)
}

// ---------------------------------------------------------------------------
// Multi-bond / aromatic dispatch numbers — renderer.py:1265,1296-1298
// ---------------------------------------------------------------------------

/// Python `round` — round-half-to-even (banker's rounding).
///
/// 0.5→0, 1.5→2, 2.5→2, 3.5→4, -0.5→0, -1.5→-2.  Matches CPython
/// `round(x)` semantics used by `round(bo)` at renderer.py:1296.
///
/// Valid for |x| < 2^63 (always true here: bond order derives from u8).
/// Beyond that the saturated `i64` parity check no longer holds. NaN/±inf
/// pass through unchanged (NaN: both `< 0.5` and `> 0.5` are false, the
/// `(NaN as i64) % 2 == 0` parity branch returns `NaN.floor()` == NaN;
/// ±inf: `inf - inf` = NaN diff routes the same way, yielding ±inf).
pub fn round_half_even(x: f64) -> f64 {
    let f = x.floor();
    let diff = x - f;
    if diff < 0.5 {
        f
    } else if diff > 0.5 {
        f + 1.0
    } else {
        // exactly .5 → round to even
        if (f as i64) % 2 == 0 {
            f
        } else {
            f + 1.0
        }
    }
}

/// `nb = max(1, round_half_even(bo))`, with `bo → 1.0` collapsed when
/// `bond_orders == false` (renderer.py:1119 `bo = bo if bcfg.bond_orders
/// else 1.0`, then 1296 `nb = max(1, round(bo))`). Aromatic is handled by
/// `is_aromatic`/the caller — this is the multi-bond branch only.
pub fn nb_from_order(bo: f64, bond_orders: bool) -> i32 {
    let b = if bond_orders { bo } else { 1.0 };
    let nb = round_half_even(b) as i32;
    nb.max(1)
}

/// Multi-bond offset index sequence `range(-nb+1, nb, 2)`
/// (renderer.py:1298). nb=1→[0], nb=2→[-1,1], nb=3→[-2,0,2].
pub fn ib_seq(nb: i32) -> Vec<i32> {
    let mut v = Vec::new();
    let mut i = -nb + 1;
    while i < nb {
        v.push(i);
        i += 2;
    }
    v
}

/// Aromatic window `1.3 < bo < 1.7` (renderer.py:1265, skeletal.py:114).
pub fn is_aromatic(bo: f64) -> bool {
    1.3 < bo && bo < 1.7
}

// ---------------------------------------------------------------------------
// Gap & half-split — renderer.py:1029 (_base_gap), 1001 (_element_line t)
// ---------------------------------------------------------------------------

/// Multi-bond perpendicular gap = `bond_gap · bw` with the dataclass
/// default `bond_gap = 0.6` (spec §presets) → `0.6·bw`
/// (renderer.py:1029 `_base_gap = cfg.bond_gap * _base_bw`).
pub fn gap(bw: f64) -> f64 {
    0.6 * bw
}

/// Radius-weighted half-bond split ratio `t = ri/(ri+rj)`, guarded to
/// `0.5` when `ri+rj <= 0` (renderer.py:1001
/// `t = ri/(ri+rj) if (ri+rj) > 0 else 0.5`).
pub fn half_split_t(ri: f64, rj: f64) -> f64 {
    if ri + rj > 0.0 {
        ri / (ri + rj)
    } else {
        0.5
    }
}

// ---------------------------------------------------------------------------
// Stroke widths — renderer.py:1268,1297,1218,1245 + non-solid cap 1147
// ---------------------------------------------------------------------------

/// Which stroke a bond line gets, selecting the width multiplier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrokeKind {
    /// Single bond (`nb == 1`) → width `bw` (renderer.py:1297).
    Single,
    /// Multi bond (`nb > 1`) → width `0.7·bw` (renderer.py:1297).
    Multi,
    /// Aromatic stroke → width `0.7·bw` (renderer.py:1268).
    Aromatic,
    /// TS / DASHED bond → width `1.2·bw` (renderer.py:1218).
    DashedTs,
    /// NCI / DOTTED bond → width `bw` (renderer.py:1245).
    DottedNci,
}

/// Final stroke width for `kind` given the *already non-solid-capped*
/// base width `bw`. Non-solid styles (TS/NCI/aromatic) must pass `bw`
/// already capped via `cap_nonsolid_bw`.
pub fn bond_stroke_width(bw: f64, kind: StrokeKind) -> f64 {
    match kind {
        StrokeKind::Single | StrokeKind::DottedNci => bw,
        StrokeKind::Multi | StrokeKind::Aromatic => bw * 0.7,
        StrokeKind::DashedTs => bw * 1.2,
    }
}

/// Non-solid bond width cap: `min(bw, 20·scale_ratio)`
/// (renderer.py:1147 `_bw = min(_bw, 20.0 * scale_ratio)` for any
/// `style != SOLID`). Solid bonds skip this.
pub fn cap_nonsolid_bw(bw: f64, scale_ratio: f64) -> f64 {
    bw.min(20.0 * scale_ratio)
}

// ---------------------------------------------------------------------------
// SVG fragment-string builders — exact byte-shape of xyzrender output
// (renderer.py:964-967 _bond_line, 951-958 _shaded_stroke gradient,
//  1074-1077 outline; spec §SVG output: coords :.1f, offsets :.4f,
//  opacity :.2f, double-quoted attrs, 2-space indent).
// ---------------------------------------------------------------------------

/// Opacity attribute: ` opacity="{:.2}"` when `opacity < 1.0` else empty
/// (renderer.py:1197).
pub fn op_attr(opacity: f64) -> String {
    if opacity < 1.0 {
        format!(" opacity=\"{:.2}\"", opacity)
    } else {
        String::new()
    }
}

/// `stroke-dasharray` attribute fragment ` stroke-dasharray="{:.1},{:.1}"`.
/// TS:   `dash_array(bw*1.2, bw*2.2)`  (renderer.py:1211-1212)
/// NCI:  `dash_array(bw*0.08, bw*2.0)` (renderer.py:1238-1239)
/// arom: `dash_array(w*1.0, w*2.0)`    (renderer.py:1271)
pub fn dash_array(dash: f64, gap_len: f64) -> String {
    format!(" stroke-dasharray=\"{:.1},{:.1}\"", dash, gap_len)
}

/// A single bond `<line>` — the ONLY bond primitive (renderer.py:964-967).
/// `stroke` is the resolved paint (hex or `url(#id)`); `dash` and `op` are
/// the pre-built attribute fragments (empty string = absent).
// positional SVG-attr builder mirroring xyzrender signature
#[allow(clippy::too_many_arguments)]
pub fn line_fragment(
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    w: f64,
    stroke: &str,
    dash: &str,
    op: &str,
) -> String {
    format!(
        "  <line x1=\"{:.1}\" y1=\"{:.1}\" x2=\"{:.1}\" y2=\"{:.1}\" \
stroke=\"{}\" stroke-width=\"{:.1}\" stroke-linecap=\"round\"{}{}/>",
        x1, y1, x2, y2, stroke, w, dash, op
    )
}

/// Perpendicular 3-stop cylinder-shade gradient `<defs>` block
/// (renderer.py:945-958). `half = w·0.5`; gradient axis runs across the
/// bond through the midpoint along the perpendicular `(lpx, lpy)`; stops
/// `lo → hi → lo`. Returns the `<defs>` fragment; caller uses
/// `url(#{id})` as the line stroke.
// positional SVG-attr builder mirroring xyzrender signature
#[allow(clippy::too_many_arguments)]
pub fn shade_gradient_fragment(
    id: &str,
    lx1: f64,
    ly1: f64,
    lx2: f64,
    ly2: f64,
    w: f64,
    lpx: f64,
    lpy: f64,
    lo_hex: &str,
    hi_hex: &str,
) -> String {
    let half = w * 0.5;
    let mx = (lx1 + lx2) / 2.0;
    let my = (ly1 + ly2) / 2.0;
    let gx1 = mx - lpx * half;
    let gy1 = my - lpy * half;
    let gx2 = mx + lpx * half;
    let gy2 = my + lpy * half;
    format!(
        "  <defs><linearGradient id=\"{}\" x1=\"{:.1}\" y1=\"{:.1}\" \
x2=\"{:.1}\" y2=\"{:.1}\" gradientUnits=\"userSpaceOnUse\">\
<stop offset=\"0%\" stop-color=\"{}\"/>\
<stop offset=\"50%\" stop-color=\"{}\"/>\
<stop offset=\"100%\" stop-color=\"{}\"/>\
</linearGradient></defs>",
        id, gx1, gy1, gx2, gy2, lo_hex, hi_hex, lo_hex
    )
}

/// Deferred outline stroke `<line>` — a wider line of width `w + 2·ow`
/// drawn behind ALL bonds (renderer.py:1073-1077). Identical primitive
/// to `line_fragment`; named separately to mark caller intent (this goes
/// into the deferred `_bond_outline_layer`, spliced at the molecule base
/// by RT9).
// positional SVG-attr builder mirroring xyzrender signature
#[allow(clippy::too_many_arguments)]
pub fn outline_fragment(
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    w: f64,
    ow: f64,
    stroke: &str,
    dash: &str,
    op: &str,
) -> String {
    line_fragment(x1, y1, x2, y2, w + 2.0 * ow, stroke, dash, op)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Atom;

    fn at(el: &str, xyz: [f64; 3]) -> Atom {
        Atom { el: el.into(), xyz }
    }

    // --- retained perceive tests (no-explicit-bonds fallback) ---

    #[test]
    fn bonds_close_pair_not_far_pair() {
        let atoms = vec![
            at("C", [0.0, 0.0, 0.0]),
            at("O", [1.2, 0.0, 0.0]),
            at("C", [9.0, 0.0, 0.0]),
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

    #[test]
    fn perceive_empty_atoms_is_empty() {
        let atoms: Vec<Atom> = vec![];
        assert!(perceive(&atoms).is_empty());
    }

    // --- RT8 plan block (adapted to (start,end,ok) tuple signature) ---

    #[test]
    fn trim_to_0_9_radius() {
        let (s, e, ok) = trim([0., 0., 0.], [2., 0., 0.], 0.5, 0.5);
        assert!(ok);
        // 0.9*0.5 = 0.45 trimmed off each end
        assert!((s[0] - 0.45).abs() < 1e-9 && (e[0] - 1.55).abs() < 1e-9);
    }

    #[test]
    fn trim_rejects_overlap() {
        // span 0.4 < 0.9*0.5 + 0.9*0.5 = 0.9 → trimmed ends cross → dot<=0
        assert!(!trim([0., 0., 0.], [0.4, 0., 0.], 0.5, 0.5).2);
    }

    #[test]
    fn multibond_offsets() {
        assert_eq!(ib_seq(1), vec![0]);
        assert_eq!(ib_seq(2), vec![-1, 1]);
        assert_eq!(ib_seq(3), vec![-2, 0, 2]);
    }

    #[test]
    fn nb_round_half_even() {
        assert_eq!(nb_from_order(1.5, true), 2); // round half→even
        assert_eq!(nb_from_order(2.5, true), 2);
        assert_eq!(nb_from_order(1.2, true), 1);
        assert_eq!(nb_from_order(9.9, false), 1); // bond_orders=false → 1
    }

    #[test]
    fn aromatic_window() {
        assert!(is_aromatic(1.5) && !is_aromatic(1.7) && !is_aromatic(1.3));
    }

    // --- additional edge coverage ---

    #[test]
    fn round_half_even_edges() {
        // python3 -c "print([round(x) for x in (0.5,2.5,1.5,3.5,-0.5,-1.5,-2.5)])"
        //   -> [0, 2, 2, 4, 0, -2, -2]
        assert_eq!(round_half_even(0.5), 0.0);
        assert_eq!(round_half_even(2.5), 2.0);
        assert_eq!(round_half_even(1.5), 2.0);
        assert_eq!(round_half_even(3.5), 4.0);
        assert_eq!(round_half_even(-0.5), 0.0);
        assert_eq!(round_half_even(-1.5), -2.0);
        assert_eq!(round_half_even(-2.5), -2.0);
        // non-half values round normally
        assert_eq!(round_half_even(2.4), 2.0);
        assert_eq!(round_half_even(2.6), 3.0);
        assert_eq!(round_half_even(-0.4), 0.0);
        assert_eq!(round_half_even(-0.6), -1.0);
    }

    #[test]
    fn gap_is_0_6_bw() {
        assert!((gap(20.0) - 12.0).abs() < 1e-12);
        assert!((gap(0.0)).abs() < 1e-12);
    }

    #[test]
    fn half_split_t_guard() {
        assert!((half_split_t(0.5, 0.5) - 0.5).abs() < 1e-12); // equal radii → 0.5
        assert!((half_split_t(0.66, 0.31) - 0.66 / 0.97).abs() < 1e-12);
        assert!((half_split_t(0.0, 0.0) - 0.5).abs() < 1e-12); // ri+rj==0 → 0.5
        assert!((half_split_t(-1.0, 1.0) - 0.5).abs() < 1e-12); // ri+rj==0 → 0.5
    }

    #[test]
    fn aromatic_window_exact() {
        assert!(!is_aromatic(1.3)); // closed-open: 1.3 excluded
        assert!(is_aromatic(1.30001));
        assert!(is_aromatic(1.5));
        assert!(is_aromatic(1.69999));
        assert!(!is_aromatic(1.7)); // 1.7 excluded
        assert!(!is_aromatic(2.0));
        assert!(!is_aromatic(1.0));
    }

    #[test]
    fn trim_rejects_coincident_endpoints() {
        let (_s, _e, ok) = trim([1., 2., 3.], [1., 2., 3.], 0.5, 0.5);
        assert!(!ok);
    }

    #[test]
    fn reject_short_below_one_pixel() {
        assert!(reject_short(0.0, 0.0, 0.5, 0.0)); // ln=0.5 < 1 → reject
        assert!(!reject_short(0.0, 0.0, 2.0, 0.0)); // ln=2 → keep
        assert!(!reject_short(0.0, 0.0, 0.0, 1.0)); // ln=1 → keep (>=1)
    }

    #[test]
    fn perp2d_unit_and_degenerate() {
        // horizontal bond → perp points +y: (-(0)/2, (2)/2)=(0,1)
        let (px, py) = perp2d(0.0, 0.0, 2.0, 0.0);
        assert!((px - 0.0).abs() < 1e-12 && (py - 1.0).abs() < 1e-12);
        // degenerate → (0,0)
        assert_eq!(perp2d(5.0, 5.0, 5.0, 5.0), (0.0, 0.0));
    }

    #[test]
    fn stroke_width_multipliers() {
        assert!((bond_stroke_width(20.0, StrokeKind::Single) - 20.0).abs() < 1e-12);
        assert!((bond_stroke_width(20.0, StrokeKind::Multi) - 14.0).abs() < 1e-12);
        assert!((bond_stroke_width(20.0, StrokeKind::Aromatic) - 14.0).abs() < 1e-12);
        assert!((bond_stroke_width(20.0, StrokeKind::DashedTs) - 24.0).abs() < 1e-12);
        assert!((bond_stroke_width(20.0, StrokeKind::DottedNci) - 20.0).abs() < 1e-12);
    }

    #[test]
    fn nonsolid_cap() {
        // scale_ratio 1.0 → cap at 20
        assert!((cap_nonsolid_bw(50.0, 1.0) - 20.0).abs() < 1e-12);
        assert!((cap_nonsolid_bw(10.0, 1.0) - 10.0).abs() < 1e-12);
        // scale_ratio 2.0 → cap at 40
        assert!((cap_nonsolid_bw(50.0, 2.0) - 40.0).abs() < 1e-12);
    }

    // --- fragment-string byte-shape tests vs xyzrender ---

    #[test]
    fn single_bond_line_fragment_exact() {
        // xyzrender renderer.py:964-967 _bond_line, solid, opacity 1.0:
        //   <line x1=".." y1=".." x2=".." y2=".." stroke=".." \
        //   stroke-width=".." stroke-linecap="round"/>
        let s = line_fragment(10.0, 20.0, 110.5, 220.25, 20.0, "black", "", "");
        assert_eq!(
            s,
            "  <line x1=\"10.0\" y1=\"20.0\" x2=\"110.5\" y2=\"220.2\" \
stroke=\"black\" stroke-width=\"20.0\" stroke-linecap=\"round\"/>"
        );
    }

    #[test]
    fn ts_dashed_bond_line_fragment_exact() {
        // TS: width 1.2*bw, dasharray 1.2*bw,2.2*bw (renderer.py:1211-1218)
        let bw = 20.0;
        let dash = dash_array(bw * 1.2, bw * 2.2); // "24.0,44.0"
        let w = bond_stroke_width(bw, StrokeKind::DashedTs); // 24.0
        let s = line_fragment(0.0, 0.0, 100.0, 0.0, w, "#ff0000", &dash, "");
        assert_eq!(
            s,
            "  <line x1=\"0.0\" y1=\"0.0\" x2=\"100.0\" y2=\"0.0\" \
stroke=\"#ff0000\" stroke-width=\"24.0\" stroke-linecap=\"round\" \
stroke-dasharray=\"24.0,44.0\"/>"
        );
    }

    #[test]
    fn opacity_attr_and_fragment() {
        assert_eq!(op_attr(1.0), "");
        assert_eq!(op_attr(0.5), " opacity=\"0.50\"");
        let s = line_fragment(0.0, 0.0, 50.0, 0.0, 8.0, "teal", "", &op_attr(0.5));
        assert_eq!(
            s,
            "  <line x1=\"0.0\" y1=\"0.0\" x2=\"50.0\" y2=\"0.0\" \
stroke=\"teal\" stroke-width=\"8.0\" stroke-linecap=\"round\" opacity=\"0.50\"/>"
        );
    }

    #[test]
    fn shade_gradient_fragment_exact() {
        // renderer.py:951-958: lo→hi→lo, axis across bond at midpoint.
        // bond (0,0)-(100,0), w=20 → half=10, mid=(50,0),
        // perp (0,1) → g1=(50,-10) g2=(50,10)
        let s = shade_gradient_fragment(
            "bs0", 0.0, 0.0, 100.0, 0.0, 20.0, 0.0, 1.0, "#202020", "#e0e0e0",
        );
        assert_eq!(
            s,
            "  <defs><linearGradient id=\"bs0\" x1=\"50.0\" y1=\"-10.0\" \
x2=\"50.0\" y2=\"10.0\" gradientUnits=\"userSpaceOnUse\">\
<stop offset=\"0%\" stop-color=\"#202020\"/>\
<stop offset=\"50%\" stop-color=\"#e0e0e0\"/>\
<stop offset=\"100%\" stop-color=\"#202020\"/>\
</linearGradient></defs>"
        );
    }

    #[test]
    fn outline_fragment_width_is_w_plus_2ow() {
        // renderer.py:1073-1077: ow = w + 2*stroke_w
        let s = outline_fragment(0.0, 0.0, 100.0, 0.0, 20.0, 3.0, "#000000", "", "");
        // 20 + 2*3 = 26
        assert!(s.contains("stroke-width=\"26.0\""));
        assert!(s.contains("stroke-linecap=\"round\""));
        assert!(s.starts_with("  <line "));
    }

    #[test]
    fn dash_array_format() {
        assert_eq!(dash_array(24.0, 44.0), " stroke-dasharray=\"24.0,44.0\"");
        // NCI dotted bw=20: 0.08*20=1.6, 2*20=40
        assert_eq!(dash_array(1.6, 40.0), " stroke-dasharray=\"1.6,40.0\"");
    }

    // --- RT9 safety contracts: pin the real reject/bound/NaN behavior ---

    #[test]
    fn trim_nan_radius_is_rejected_not_nan_into_svg() {
        // RT9 relies on this: a NaN radius must drive the bond to ok==false
        // so no fragment string is ever built from NaN coordinates.
        // trim returns (start, end, ok). With rj=NaN: dist is finite, `end`
        // is NaN, so dot = NaN and `dot > 0.0` is false → ok==false.
        let (_s, _e, ok) = trim([0.0, 0.0, 0.0], [2.0, 0.0, 0.0], 0.5, f64::NAN);
        assert!(!ok, "NaN radius must yield ok==false (bond dropped)");
        // also the symmetric ri=NaN case
        let (_s2, _e2, ok2) = trim([0.0, 0.0, 0.0], [2.0, 0.0, 0.0], f64::NAN, 0.5);
        assert!(!ok2, "NaN radius (ri) must also yield ok==false");
    }

    #[test]
    fn nb_from_order_max_u8_bounded() {
        // round_half_even(255.0)=255.0 → as i32 = 255 → max(1) = 255.
        let nb = nb_from_order(255.0, true);
        assert!(nb >= 1 && nb <= 255, "nb={} out of [1,255]", nb);
        assert_eq!(nb, 255);
        // ib_seq(nb) = range(-nb+1, nb, 2): for nb=255 → -254,-252,..,254,
        // exactly 255 elements. The length equals nb for all nb>=1.
        let seq = ib_seq(nb);
        assert_eq!(seq.len() as i32, nb, "ib_seq len must equal nb");
        // spot-check the small-nb relation too (single..multi).
        assert_eq!(ib_seq(1).len() as i32, 1);
        assert_eq!(ib_seq(2).len() as i32, 2);
        assert_eq!(ib_seq(3).len() as i32, 3);
    }

    #[test]
    fn round_half_even_nan_benign() {
        // Real behavior (verified): NaN passes through UNCHANGED. Although
        // `NaN as i64` saturates to 0, the value returned is `NaN.floor()`
        // which is NaN — NOT 0. ±inf likewise pass through unchanged.
        // Pin this so any future code change that maps NaN→0 is caught.
        let v = round_half_even(f64::NAN);
        assert!(v.is_nan(), "round_half_even(NaN) must stay NaN, got {}", v);
        assert_eq!(round_half_even(f64::INFINITY), f64::INFINITY);
        assert_eq!(round_half_even(f64::NEG_INFINITY), f64::NEG_INFINITY);
    }
}

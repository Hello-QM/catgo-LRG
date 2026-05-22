//! Pure geometry: rotation, orthographic 3D→2D projection, aspect-fit canvas.
//!
//! `proj` / `fit_canvas` are faithful ports of xyzrender
//! `renderer.py:1834-1836` (`_proj`) and `:1806-1831` (`_fit_canvas`),
//! including the Python `int()` truncation of canvas w/h, the `1e-6`
//! `max_span` floor, and the single-scalar `radii.max()` bbox pad.
//!
//! `rotate` is retained — the drag-overlay (RT9/RT11) applies it after PCA.

/// Apply intrinsic XYZ rotation (degrees) to a point.
pub fn rotate(p: [f64; 3], rot_deg: [f64; 3]) -> [f64; 3] {
    let (rx, ry, rz) = (
        rot_deg[0].to_radians(),
        rot_deg[1].to_radians(),
        rot_deg[2].to_radians(),
    );
    let (cx, sx) = (rx.cos(), rx.sin());
    let (cy, sy) = (ry.cos(), ry.sin());
    let (cz, sz) = (rz.cos(), rz.sin());
    let [x, y, z] = p;
    let (y1, z1) = (y * cx - z * sx, y * sx + z * cx);
    let (x2, z2) = (x * cy + z1 * sy, -x * sy + z1 * cy);
    let (x3, y3) = (x2 * cz - y1 * sz, x2 * sz + y1 * cz);
    [x3, y3, z2]
}

/// Orthographic 3D→2D pixel projection — verbatim xyzrender `_proj`
/// (`renderer.py:1834-1836`):
///
/// ```text
/// return cw / 2 + scale * (p[0] - cx), ch / 2 - scale * (p[1] - cy)
/// ```
///
/// Y is flipped for SVG (screen-down) coordinates.
pub fn proj(p: [f64; 3], scale: f64, cx: f64, cy: f64, cw: f64, ch: f64) -> (f64, f64) {
    (
        cw / 2.0 + scale * (p[0] - cx),
        ch / 2.0 - scale * (p[1] - cy),
    )
}

/// Result of [`fit_canvas`]: scale + center + cropped canvas dimensions.
///
/// `w`/`h` hold the Python-`int()`-truncated pixel size (truncate toward
/// zero) so callers compare exactly against `int(span*scale+2*pad)`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit {
    pub scale: f64,
    pub cx: f64,
    pub cy: f64,
    pub w: f64,
    pub h: f64,
}

/// Scale + center so the molecule fits the canvas with a tight aspect
/// ratio — verbatim port of xyzrender `_fit_canvas`
/// (`renderer.py:1806-1831`):
///
/// ```python
/// pad = radii.max() if len(radii) else 0
/// lo = pos[:, :2].min(axis=0) - pad
/// hi = pos[:, :2].max(axis=0) + pad
/// # (extra_lo/extra_hi widen via np.minimum/np.maximum)
/// spans = hi - lo
/// max_span = fixed_span if fixed_span is not None else max(spans.max(), 1e-6)
/// scale = (canvas_size - 2*padding) / max_span
/// if fixed_span is not None: w = h = canvas_size          # square
/// else: w = int(spans[0]*scale + 2*padding); h = int(spans[1]*scale + 2*padding)
/// center = (lo + hi) / 2
/// ```
///
/// `fixed_span = Some(s)` reproduces GIF mode (square canvas, fixed span).
/// Use [`fit_canvas_extra`] when the cell box / overlays must widen the bbox.
///
/// Empty `pos` returns a sentinel empty canvas (scale=ref_scale, center 0,
/// w=h=2·padding or canvas_size if fixed_span) — does not panic or emit NaN.
pub fn fit_canvas(
    pos: &[[f64; 3]],
    radii: &[f64],
    canvas_size: f64,
    padding: f64,
    fixed_span: Option<f64>,
) -> Fit {
    fit_canvas_extra(pos, radii, canvas_size, padding, fixed_span, None, None)
}

/// [`fit_canvas`] with the optional `extra_lo`/`extra_hi` bbox-widening
/// args from xyzrender (cell box, NCI, annotations).
///
/// `extra_lo`/`extra_hi` are `[x, y]` and widen the bbox via
/// element-wise min / max, matching `np.minimum(lo, extra_lo)` /
/// `np.maximum(hi, extra_hi)`.
pub fn fit_canvas_extra(
    pos: &[[f64; 3]],
    radii: &[f64],
    canvas_size: f64,
    padding: f64,
    fixed_span: Option<f64>,
    extra_lo: Option<[f64; 2]>,
    extra_hi: Option<[f64; 2]>,
) -> Fit {
    if pos.is_empty() {
        // xyzrender raises on empty coords; catrender fails safe instead so an
        // all-atoms-hidden render yields a valid (empty) canvas, not NaN coords.
        let s = ref_scale(padding);
        let side = fixed_span.map(|_| canvas_size).unwrap_or(2.0 * padding);
        return Fit {
            scale: s,
            cx: 0.0,
            cy: 0.0,
            w: side,
            h: side,
        };
    }

    // pad = radii.max() if len(radii) else 0  (single scalar)
    let pad = if radii.is_empty() {
        0.0
    } else {
        radii.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
    };

    // lo/hi over the XY columns only, then ± pad.
    let mut lo = [f64::INFINITY, f64::INFINITY];
    let mut hi = [f64::NEG_INFINITY, f64::NEG_INFINITY];
    for p in pos {
        for k in 0..2 {
            if p[k] < lo[k] {
                lo[k] = p[k];
            }
            if p[k] > hi[k] {
                hi[k] = p[k];
            }
        }
    }
    for k in 0..2 {
        lo[k] -= pad;
        hi[k] += pad;
    }

    // extra_lo / extra_hi widen via element-wise min / max.
    if let Some(el) = extra_lo {
        for k in 0..2 {
            lo[k] = lo[k].min(el[k]);
        }
    }
    if let Some(eh) = extra_hi {
        for k in 0..2 {
            hi[k] = hi[k].max(eh[k]);
        }
    }

    let spans = [hi[0] - lo[0], hi[1] - lo[1]];

    let max_span = match fixed_span {
        Some(fs) => fs,
        None => spans[0].max(spans[1]).max(1e-6),
    };

    let scale = (canvas_size - 2.0 * padding) / max_span;

    let (w, h) = match fixed_span {
        // GIF mode: keep canvas square for consistent framing.
        Some(_) => (canvas_size, canvas_size),
        // Static: crop to molecule aspect ratio. Python int() truncates
        // toward zero.
        None => (
            (spans[0] * scale + 2.0 * padding).trunc(),
            (spans[1] * scale + 2.0 * padding).trunc(),
        ),
    };

    let center = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0];

    Fit {
        scale,
        cx: center[0],
        cy: center[1],
        w,
        h,
    }
}

/// Reference scale — xyzrender `renderer.py:179`:
/// `ref_scale = (_REF_CANVAS - 2*cfg.padding) / _REF_SPAN`
/// with `_REF_CANVAS = 800`, `_REF_SPAN = 6.0`.
pub fn ref_scale(padding: f64) -> f64 {
    (800.0 - 2.0 * padding) / 6.0
}

/// Proportional-width factor: `scale / ref_scale(padding)`.
/// Bond / label widths defined at the reference canvas grow by this.
pub fn scale_ratio(scale: f64, padding: f64) -> f64 {
    scale / ref_scale(padding)
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

    // ---- RT6 plan block (verbatim) ----

    #[test]
    fn fit_aspect_and_scale() {
        // span x=6, y=3, canvas 800, padding 20 → scale=(800-40)/6
        let pos = vec![[-3., -1.5, 0.], [3., 1.5, 0.]];
        let r = vec![0.0, 0.0];
        let f = fit_canvas(&pos, &r, 800.0, 20.0, None);
        assert!((f.scale - (760.0 / 6.0)).abs() < 1e-6);
        assert_eq!(f.w as i64, (6.0 * f.scale + 40.0) as i64);
        assert_eq!(f.h as i64, (3.0 * f.scale + 40.0) as i64);
    }

    #[test]
    fn proj_y_flips() {
        // Verbatim xyzrender `_proj` (renderer.py:1836), cross-checked vs spec
        // §Verbatim line 61 (`sx = cw/2 + scale*(X-cx)`):
        //   x = cw/2 + scale*(p0-cx) = 100/2 + 10*(1-0) = 60
        //   y = ch/2 - scale*(p1-cy) = 100/2 - 10*(1-0) = 40   (y-flip)
        // NOTE: the RT6 plan block transcribed x as 110, which is
        // arithmetically impossible under the authoritative formula
        // (would need cw=200). The hard rule "match xyzrender _proj
        // EXACTLY" governs; corrected to 60. The test's intent — the SVG
        // y-flip — is exercised and passes verbatim.
        let (x, y) = proj([1., 1., 0.], 10.0, 0., 0., 100., 100.);
        assert!((x - 60.0).abs() < 1e-9 && (y - 40.0).abs() < 1e-9);
    }

    // ---- Additional RT6 coverage ----

    /// `fixed_span` → square canvas (xyzrender GIF mode, `w = h = canvas_size`).
    #[test]
    fn fixed_span_square_canvas() {
        let pos = vec![[-3., -1.5, 0.], [3., 1.5, 0.]];
        let r = vec![0.0, 0.0];
        // fixed_span = 8 → scale = (800-40)/8 = 95.0
        let f = fit_canvas(&pos, &r, 800.0, 20.0, Some(8.0));
        assert!((f.scale - (760.0 / 8.0)).abs() < 1e-9, "scale {}", f.scale);
        assert_eq!(f.w as i64, 800);
        assert_eq!(f.h as i64, 800);
        assert_eq!(f.w, f.h, "fixed_span must be square");
    }

    /// `pad = radii.max()` widens the bbox by the single largest radius.
    /// span becomes (hi+pad)-(lo-pad) = base_span + 2*max_radius.
    #[test]
    fn per_radius_pad_widens_bbox() {
        let pos = vec![[-3., -1.5, 0.], [3., 1.5, 0.]];
        // max radius 0.5 → x span = 6 + 2*0.5 = 7, y span = 3 + 1 = 4
        let r = vec![0.2, 0.5];
        let f = fit_canvas(&pos, &r, 800.0, 20.0, None);
        // max_span = max(7, 4) = 7 → scale = 760/7
        assert!((f.scale - (760.0 / 7.0)).abs() < 1e-6, "scale {}", f.scale);
        // center unchanged (symmetric ± pad), still origin.
        assert!(f.cx.abs() < 1e-12 && f.cy.abs() < 1e-12);
        assert_eq!(f.w as i64, (7.0 * f.scale + 40.0) as i64);
        assert_eq!(f.h as i64, (4.0 * f.scale + 40.0) as i64);
    }

    /// `scale_ratio == 1.0` exactly when `scale == ref_scale(padding)`.
    #[test]
    fn scale_ratio_identity() {
        let pad = 20.0;
        let rs = ref_scale(pad);
        assert!((rs - (800.0 - 40.0) / 6.0).abs() < 1e-12);
        assert!((scale_ratio(rs, pad) - 1.0).abs() < 1e-12);
        // half the ref scale → ratio 0.5
        assert!((scale_ratio(rs / 2.0, pad) - 0.5).abs() < 1e-12);
    }

    /// `extra_lo`/`extra_hi` widen the bbox via element-wise min/max
    /// (xyzrender `np.minimum`/`np.maximum`) and shift the center.
    #[test]
    fn extra_lo_hi_widen_and_shift_center() {
        let pos = vec![[-1., -1., 0.], [1., 1., 0.]];
        let r = vec![0.0, 0.0];
        // base bbox lo=[-1,-1] hi=[1,1]; widen lo to [-5,-1], hi to [1,3]
        let f = fit_canvas_extra(
            &pos,
            &r,
            800.0,
            20.0,
            None,
            Some([-5.0, -1.0]),
            Some([1.0, 3.0]),
        );
        // x span = 1-(-5) = 6, y span = 3-(-1) = 4 → max_span 6
        assert!((f.scale - (760.0 / 6.0)).abs() < 1e-6, "scale {}", f.scale);
        // center = ((-5+1)/2, (-1+3)/2) = (-2, 1)
        assert!((f.cx + 2.0).abs() < 1e-12, "cx {}", f.cx);
        assert!((f.cy - 1.0).abs() < 1e-12, "cy {}", f.cy);
    }

    /// Empty-radii degenerate point → `1e-6` max_span floor (no div-by-0).
    #[test]
    fn degenerate_span_uses_floor() {
        let pos = vec![[2.0, 2.0, 0.0]];
        let r: Vec<f64> = vec![]; // pad = 0 → zero span
        let f = fit_canvas(&pos, &r, 800.0, 20.0, None);
        // max_span floored at 1e-6 → scale = 760 / 1e-6
        assert!((f.scale - 760.0 / 1e-6).abs() / f.scale < 1e-9, "scale {}", f.scale);
        assert!(f.scale.is_finite());
    }

    #[test]
    fn empty_pos_is_sentinel_not_nan() {
        let f = fit_canvas(&[], &[], 800.0, 20.0, None);
        assert!(f.scale.is_finite() && f.cx.is_finite() && f.cy.is_finite());
        assert!(f.w.is_finite() && f.h.is_finite());
        assert_eq!(f.cx, 0.0);
        assert_eq!(f.cy, 0.0);
        assert_eq!(f.w, 40.0); // 2*padding
        assert_eq!(f.h, 40.0);
        // fixed_span variant → square canvas_size
        let g = fit_canvas(&[], &[], 800.0, 20.0, Some(8.0));
        assert_eq!(g.w, 800.0);
        assert_eq!(g.h, 800.0);
    }

    // xyzrender cross-check (run on the clone to confirm semantics):
    //   python -c "import numpy as np; \
    //     pos=np.array([[-3,-1.5,0.],[3,1.5,0.]]); pad=0.0; \
    //     lo=pos[:,:2].min(0)-pad; hi=pos[:,:2].max(0)+pad; sp=hi-lo; \
    //     ms=max(sp.max(),1e-6); sc=(800-40)/ms; \
    //     print(sc, int(sp[0]*sc+40), int(sp[1]*sc+40), (lo+hi)/2)"
    //   → 126.6667 800 420 [0. 0.]   (matches fit_aspect_and_scale)
}

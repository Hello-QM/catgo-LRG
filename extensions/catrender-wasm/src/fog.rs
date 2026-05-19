//! Fog factors + depth-of-field (DoF) buckets / SVG filter defs.
//!
//! Verbatim port of xyzrender `src/xyzrender/renderer.py` fog block
//! (~lines 448–465) and DoF filter emission (~lines 480–488), plus the
//! constants in `src/xyzrender/colors.py:256-257`.
//!
//! Reference (renderer.py, fog):
//! ```text
//! zr = max(pos[:,2].max() - pos[:,2].min(), 1e-6)
//! depth = pos[:,2].max() - pos[:,2]
//! fog_f = cfg.fog_strength * np.clip((depth - _FOG_NEAR) / zr, 0.0, 1.0)
//! ```
//! Reference (renderer.py, DoF bucket): `int(d * (n_dof_levels - 1) + 0.5)`
//! with `n_dof_levels = 20` → factor `(n-1) = 19`.
//! Reference (renderer.py, DoF filter, per lvl in range(20)):
//! ```text
//! blur = lvl / max(n_dof_levels - 1, 1) * cfg.dof_strength
//! '    <filter id="dof{lvl}" x="-50%" y="-50%" width="200%" height="200%">'
//! '<feGaussianBlur stdDeviation="{blur:.2f}"/></filter>'
//! ```

/// Å of depth before fog kicks in. `colors.py:256` `_FOG_NEAR = 1.0`.
pub const FOG_NEAR: f64 = 1.0;
/// Deepest atoms retain at least 30% of their color.
/// `colors.py:257` `_MAX_FOG = 0.70`.
pub const MAX_FOG: f64 = 0.70;

/// Number of DoF blur levels. renderer.py `n_dof_levels = 20`.
pub const N_DOF_LEVELS: usize = 20;

/// Per-atom fog factor across the depth range, with a dead-zone near
/// the front (renderer.py:451-454).
///
/// `zr = max(zmax - zmin, 1e-6)`; `f[i] = strength * clip((zmax - z[i] - 1.0)/zr, 0, 1)`.
///
/// Empty input → empty vec (no panic). Single / coincident z → `zr` floors
/// at `1e-6`, every `depth` is 0 so `(0 - 1.0)/1e-6` clips to 0.0 (finite,
/// never NaN/inf).
pub fn fog_factors(z: &[f64], fog_strength: f64) -> Vec<f64> {
    if z.is_empty() {
        return Vec::new();
    }
    let zmax = z.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let zmin = z.iter().cloned().fold(f64::INFINITY, f64::min);
    let zr = (zmax - zmin).max(1e-6);
    z.iter()
        .map(|&zi| {
            let depth = zmax - zi; // distance from front atom
            fog_strength * ((depth - FOG_NEAR) / zr).clamp(0.0, 1.0)
        })
        .collect()
}

/// DoF blur bucket for a normalized depth `d ∈ [0, 1]`.
///
/// renderer.py: `int(d * (n_dof_levels - 1) + 0.5)` with `n_dof_levels = 20`.
/// Python `int()` truncates toward zero; `.trunc() as i64` replicates that
/// (for non-negative `d` this equals `floor`, matching the cross-check
/// `python3 -c "print(int(0.5*19+0.5))"` → 10).
///
/// Precondition: `d` ∈ [0,1] (caller contract — both xyzrender producers
/// `renderer.py:461,464` clip/construct into this range; out-of-range `d`
/// is faithful-port UB, not validated here — matches xyzrender, which also
/// does not clamp at the `int()` site).
pub fn dof_bucket(d: f64) -> i64 {
    (d * (N_DOF_LEVELS as f64 - 1.0) + 0.5).trunc() as i64
}

/// The 20 `<filter>` definitions for DoF, one per level (renderer.py:482-487).
///
/// `blur = lvl / max(n_dof_levels - 1, 1) * dof_strength`; emitted with
/// `:.2` precision to match xyzrender's `{blur:.2f}`. Attribute string is
/// byte-identical to xyzrender (double-quoted, `x="-50%" y="-50%"
/// width="200%" height="200%"`).
pub fn dof_filter_defs(dof_strength: f64) -> String {
    let mut s = String::new();
    for lvl in 0..N_DOF_LEVELS {
        let blur = lvl as f64 / (N_DOF_LEVELS as f64 - 1.0).max(1.0) * dof_strength;
        s.push_str(&format!(
            "<filter id=\"dof{lvl}\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"{blur:.2}\"/></filter>"
        ));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Plan RT7 block (verbatim) ----

    #[test]
    fn fog_clip_and_strength() {
        // z: front zmax=5, back z=0, zr=5, _FOG_NEAR=1, strength=1.2
        let z = vec![5.0, 3.0, 0.0];
        let f = fog_factors(&z, 1.2);
        assert!((f[0] - 0.0).abs() < 1e-9); // front: depth0 → (−1)/5 clip0
        assert!((f[2] - 1.2 * ((5.0 - 1.0) / 5.0)).abs() < 1e-9); // back
    }

    #[test]
    fn dof_bucket() {
        assert_eq!(super::dof_bucket(0.0), 0);
        assert_eq!(super::dof_bucket(1.0), 19);
        assert_eq!(super::dof_bucket(0.5), 10); // int(0.5*19+0.5)=10
    }

    // ---- Added robustness / fidelity tests ----

    #[test]
    fn empty_z_no_panic() {
        let f = fog_factors(&[], 1.2);
        assert!(f.is_empty());
    }

    #[test]
    fn single_z_finite_no_nan() {
        // zr floors at 1e-6; depth=0 → (0-1.0)/1e-6 = -1e6 → clamp 0.0
        let f = fog_factors(&[2.7], 1.2);
        assert_eq!(f.len(), 1);
        assert!(f[0].is_finite(), "got {}", f[0]);
        assert!(!f[0].is_nan());
        assert!((f[0] - 0.0).abs() < 1e-12);
    }

    #[test]
    fn coincident_z_no_nan() {
        let f = fog_factors(&[1.0, 1.0, 1.0], 0.7);
        assert!(f.iter().all(|v| v.is_finite() && !v.is_nan()));
        assert!(f.iter().all(|&v| (v - 0.0).abs() < 1e-12));
    }

    #[test]
    fn dof_bucket_intermediate() {
        // python3 -c "print(int(0.3*19+0.5))"  -> 6
        assert_eq!(super::dof_bucket(0.3), 6);
        // python3 -c "print(int(0.999*19+0.5))" -> 19
        assert_eq!(super::dof_bucket(0.999), 19);
    }

    #[test]
    fn filter_defs_count_and_ids() {
        let s = dof_filter_defs(3.0);
        assert_eq!(s.matches("<filter").count(), 20);
        for n in 0..20 {
            assert!(
                s.contains(&format!("id=\"dof{n}\"")),
                "missing dof{n}"
            );
        }
        // dof19 is the last id; dof20 must not exist
        assert!(!s.contains("id=\"dof20\""));
    }

    #[test]
    fn filter_defs_blur_endpoints_and_precision() {
        // dof_strength 3.0 → n=0 blur 0/19*3 = 0.00; n=19 blur 19/19*3 = 3.00
        // python3 -c "print(f'{0/19*3.0:.2f}', f'{19/19*3.0:.2f}')" -> 0.00 3.00
        let s = dof_filter_defs(3.0);
        assert!(
            s.contains("id=\"dof0\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"0.00\"/>"),
            "dof0 shape/precision mismatch:\n{s}"
        );
        assert!(
            s.contains("id=\"dof19\" x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\"><feGaussianBlur stdDeviation=\"3.00\"/>"),
            "dof19 (==dof_strength, 19/19*s) shape/precision mismatch:\n{s}"
        );
        // mid-level cross-check: python3 -c "print(f'{10/19*3.0:.2f}')" -> 1.58
        assert!(s.contains("id=\"dof10\""));
        assert!(s.contains("stdDeviation=\"1.58\""));
    }
}

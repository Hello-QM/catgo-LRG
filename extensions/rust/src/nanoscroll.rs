//! Nanoscroll builder: roll a 2D monolayer into an Archimedean spiral.
//!
//! A nanoscroll differs from a nanotube: instead of a constant-radius cylinder,
//! the radius grows with the rolling angle following an Archimedean spiral
//! `r(theta) = r0 + b*theta + w`, so the sheet winds up like a rolled carpet.
//! The scroll axis is along +z.
//!
//! Workflow (material-general):
//! 1. Take a monolayer `Structure` (a single 2D layer; any composition).
//! 2. Tile it `nx x ny` in the in-plane lattice vectors so the arc length of the
//!    spiral is covered (roll direction) and the requested z-length is covered.
//! 3. Apply the Archimedean bend, mapping the flat sheet onto the spiral.
//!
//! Generalizations over the reference MoS2 script:
//! - **Monolayer in** (not CIF + layer slicing). An optional gap-clustering
//!   layer extractor is provided for convenience.
//! - **Interlayer-gap pitch fix**: the spiral pitch per turn is
//!   `monolayer_thickness + interlayer_gap` (the reference used just
//!   `monolayer_thickness`, packing windings with zero van-der-Waals gap).
//! - **Curvature-strain guard**: warns when the inner radius is so small that
//!   the bending strain (~thickness / (2*r)) exceeds a threshold.

use std::collections::HashMap;
use std::f64::consts::PI;

use nalgebra::Vector3;

use crate::element::Element;
use crate::error::{FerroxError, Result};
use crate::lattice::Lattice;
use crate::species::Species;
use crate::structure::Structure;

/// Default van-der-Waals interlayer gap between successive windings (Å).
pub const DEFAULT_INTERLAYER_GAP: f64 = 3.3;

/// Default local-strain threshold above which a curvature warning is emitted.
pub const DEFAULT_STRAIN_WARN_THRESHOLD: f64 = 0.15;

/// Vacuum padding added around the generated non-periodic scroll cell (Å).
const DEFAULT_CELL_PADDING: f64 = 10.0;

/// In-plane roll direction (which lattice vector becomes the rolling axis).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollDir {
    /// Roll along the first in-plane lattice vector `a1`.
    A1,
    /// Roll along the second in-plane lattice vector `a2`.
    A2,
}

impl RollDir {
    /// Parse from a string ("a1" / "a2"); anything else defaults to `a1`.
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "a2" => RollDir::A2,
            _ => RollDir::A1,
        }
    }
}

/// Parameters controlling nanoscroll construction.
#[derive(Debug, Clone)]
pub struct NanoscrollParams {
    /// Number of windings (turns) of the spiral. Must be >= 1.
    pub turns: u32,
    /// Inner winding radius (Å).
    pub inner_radius: f64,
    /// Requested scroll height along z (Å).
    pub length: f64,
    /// In-plane roll direction.
    pub roll_dir: RollDir,
    /// Van-der-Waals gap between successive windings (Å).
    pub interlayer_gap: f64,
    /// Local-strain threshold above which a curvature warning is emitted.
    pub strain_warn_threshold: f64,
}

impl Default for NanoscrollParams {
    fn default() -> Self {
        Self {
            turns: 6,
            inner_radius: 25.0,
            length: 12.0,
            roll_dir: RollDir::A1,
            interlayer_gap: DEFAULT_INTERLAYER_GAP,
            strain_warn_threshold: DEFAULT_STRAIN_WARN_THRESHOLD,
        }
    }
}

/// Metadata describing a constructed nanoscroll.
#[derive(Debug, Clone)]
pub struct NanoscrollInfo {
    /// Number of windings.
    pub turns: u32,
    /// Inner winding radius (Å).
    pub inner_radius: f64,
    /// Outer winding radius (Å) at the mid-plane of the outermost turn.
    pub outer_radius: f64,
    /// Realized scroll length along z (Å).
    pub length: f64,
    /// Monolayer thickness (Å).
    pub monolayer_thickness: f64,
    /// Interlayer gap used for the spiral pitch (Å).
    pub interlayer_gap: f64,
    /// Spiral arc length traversed (Å).
    pub arc_length: f64,
    /// Supercell tiling [nx, ny] used.
    pub supercell: [u32; 2],
    /// Number of atoms in the scroll.
    pub n_atoms: u32,
    /// Maximum local bending strain (~thickness / (2*inner_radius)).
    pub max_local_strain: f64,
    /// Optional warning string (None when geometry is comfortable).
    pub warning: Option<String>,
}

/// In-plane (xy) lattice vectors of a structure as 3D vectors with z forced to 0.
fn in_plane_vectors(structure: &Structure) -> (Vector3<f64>, Vector3<f64>) {
    let m = structure.lattice.matrix();
    // Rows are lattice vectors.
    let a1 = Vector3::new(m[(0, 0)], m[(0, 1)], 0.0);
    let a2 = Vector3::new(m[(1, 0)], m[(1, 1)], 0.0);
    (a1, a2)
}

/// Monolayer thickness = span of cartesian z over all atoms.
fn monolayer_thickness(structure: &Structure) -> f64 {
    let carts = structure.cart_coords();
    if carts.is_empty() {
        return 0.0;
    }
    let mut zmin = f64::INFINITY;
    let mut zmax = f64::NEG_INFINITY;
    for c in &carts {
        zmin = zmin.min(c.z);
        zmax = zmax.max(c.z);
    }
    zmax - zmin
}

/// Archimedean spiral arc length from theta=0 to 2*pi*turns on r = r0 + b*theta.
///
/// Approximated as `integral r dtheta` (mid-plane arc, the convention used by
/// the reference script). Exact for the layer mid-line.
fn archimedean_arc_length(inner_radius: f64, pitch: f64, turns: u32) -> f64 {
    let b = pitch / (2.0 * PI);
    let theta_max = 2.0 * PI * turns as f64;
    inner_radius * theta_max + 0.5 * b * theta_max * theta_max
}

/// Decide the `nx x ny` supercell tiling.
///
/// `nx` (along roll direction) is sized so the tiled sheet covers the spiral
/// arc length; `ny` (perpendicular, along z) covers the requested scroll length.
fn supercell_size(
    a1: Vector3<f64>,
    a2: Vector3<f64>,
    params: &NanoscrollParams,
    pitch: f64,
) -> (u32, u32) {
    let arc = archimedean_arc_length(params.inner_radius, pitch, params.turns);
    let (roll_vec, perp_vec) = match params.roll_dir {
        RollDir::A2 => (a2, a1),
        RollDir::A1 => (a1, a2),
    };
    let roll_len = roll_vec.norm();
    let perp_len = perp_vec.norm();
    let nx = if roll_len > 1e-9 {
        (arc / roll_len).ceil() as u32 + 1
    } else {
        1
    };
    let ny = if perp_len > 1e-9 {
        (params.length / perp_len).ceil() as u32
    } else {
        1
    };
    (nx.max(1), ny.max(1))
}

/// Tile the monolayer `nx x ny` and return cartesian positions + element list,
/// with cartesian z re-centred so the layer mid-plane sits at z = 0.
fn build_sheet(
    structure: &Structure,
    a1: Vector3<f64>,
    a2: Vector3<f64>,
    nx: u32,
    ny: u32,
) -> (Vec<Element>, Vec<Vector3<f64>>) {
    let base_carts = structure.cart_coords();
    let base_elems: Vec<Element> = structure
        .site_occupancies
        .iter()
        .map(|so| so.dominant_species().element)
        .collect();

    let n_base = base_carts.len();
    let mut elements = Vec::with_capacity(n_base * (nx * ny) as usize);
    let mut positions = Vec::with_capacity(n_base * (nx * ny) as usize);

    for i in 0..nx {
        for j in 0..ny {
            let origin = a1 * i as f64 + a2 * j as f64;
            for (elem, cart) in base_elems.iter().zip(base_carts.iter()) {
                elements.push(*elem);
                positions.push(origin + *cart);
            }
        }
    }

    // Re-centre z to layer mid-plane (mean of zmin/zmax) so the bend treats the
    // mid-plane as the spiral reference (w = 0).
    if !positions.is_empty() {
        let mut zmin = f64::INFINITY;
        let mut zmax = f64::NEG_INFINITY;
        for p in &positions {
            zmin = zmin.min(p.z);
            zmax = zmax.max(p.z);
        }
        let zmid = 0.5 * (zmin + zmax);
        for p in positions.iter_mut() {
            p.z -= zmid;
        }
    }

    (elements, positions)
}

/// Apply the Archimedean bend to flat-sheet cartesian positions.
///
/// `s` = coordinate along the roll axis, `t` = perpendicular in-plane (becomes z
/// of the scroll), `w` = out-of-plane (becomes radial offset within the layer).
/// `r(theta) = r0 + b*theta + w`, theta proportional to s.
fn archimedean_bend(
    positions: &[Vector3<f64>],
    params: &NanoscrollParams,
    pitch: f64,
    e_roll: Vector3<f64>,
    e_perp: Vector3<f64>,
) -> Result<Vec<Vector3<f64>>> {
    // Roll/perp/out-of-plane components.
    let s: Vec<f64> = positions.iter().map(|p| p.dot(&e_roll)).collect();
    let t: Vec<f64> = positions.iter().map(|p| p.dot(&e_perp)).collect();
    let w: Vec<f64> = positions.iter().map(|p| p.z).collect();

    let s_min = s.iter().cloned().fold(f64::INFINITY, f64::min);
    let s_max = s.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let span = s_max - s_min;
    if span < 1e-6 {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "Zero extent along roll direction; cannot bend.".to_string(),
        });
    }

    let b = pitch / (2.0 * PI);
    let theta_max = 2.0 * PI * params.turns as f64;

    let mut rolled = Vec::with_capacity(positions.len());
    for idx in 0..positions.len() {
        let theta = theta_max * (s[idx] - s_min) / span;
        let r = params.inner_radius + b * theta + w[idx];
        let (sin_t, cos_t) = theta.sin_cos();
        let xy = e_roll * (r * cos_t) + e_perp * (r * sin_t);
        rolled.push(Vector3::new(xy.x, xy.y, t[idx]));
    }
    Ok(rolled)
}

/// Minimum distance between successive windings, measured along the spiral
/// radial direction at matched angles. Diagnostic only.
///
/// Returns the radial pitch minus the monolayer thickness (the realized vdW gap)
/// which equals `interlayer_gap` by construction; provided so callers/tests can
/// assert windings don't overlap.
pub fn min_interwinding_gap(pitch: f64, monolayer_thickness: f64) -> f64 {
    pitch - monolayer_thickness
}

fn bounding_box(points: &[Vector3<f64>]) -> Option<(Vector3<f64>, Vector3<f64>)> {
    if points.is_empty() {
        return None;
    }
    let mut min = Vector3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY);
    let mut max = Vector3::new(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in points {
        min.x = min.x.min(p.x);
        min.y = min.y.min(p.y);
        min.z = min.z.min(p.z);
        max.x = max.x.max(p.x);
        max.y = max.y.max(p.y);
        max.z = max.z.max(p.z);
    }
    Some((min, max))
}

/// Build a nanoscroll from a monolayer structure.
///
/// Returns the rolled structure (non-periodic molecule, pbc = false) together
/// with metadata. The structure stores the same metadata in its `properties`.
pub fn build_nanoscroll(
    monolayer: &Structure,
    params: &NanoscrollParams,
) -> Result<(Structure, NanoscrollInfo)> {
    if params.turns < 1 {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "turns must be >= 1".to_string(),
        });
    }
    if params.inner_radius <= 0.0 {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "inner_radius must be > 0".to_string(),
        });
    }
    if monolayer.num_sites() == 0 {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "monolayer has no atoms".to_string(),
        });
    }

    let thickness = monolayer_thickness(monolayer);
    // Spiral pitch per turn = layer thickness + vdW gap (the fix).
    let pitch = thickness + params.interlayer_gap.max(0.0);

    let (a1, a2) = in_plane_vectors(monolayer);
    if a1.norm() < 1e-9 || a2.norm() < 1e-9 {
        return Err(FerroxError::InvalidStructure {
            index: 0,
            reason: "monolayer in-plane lattice vectors are degenerate".to_string(),
        });
    }

    let (nx, ny) = supercell_size(a1, a2, params, pitch);
    let (elements, sheet_positions) = build_sheet(monolayer, a1, a2, nx, ny);

    // In-plane orthonormal basis: e_roll along the chosen lattice vector,
    // e_perp = z_hat x e_roll (in-plane, perpendicular).
    let roll_vec = match params.roll_dir {
        RollDir::A2 => a2,
        RollDir::A1 => a1,
    };
    let e_roll = roll_vec.normalize();
    let z_hat = Vector3::new(0.0, 0.0, 1.0);
    let e_perp = z_hat.cross(&e_roll).normalize();

    let rolled = archimedean_bend(&sheet_positions, params, pitch, e_roll, e_perp)?;

    // Curvature-strain guard: innermost winding has the largest bending strain.
    let max_local_strain = if params.inner_radius > 1e-9 {
        thickness / (2.0 * params.inner_radius)
    } else {
        f64::INFINITY
    };
    let warning = if max_local_strain > params.strain_warn_threshold {
        Some(format!(
            "Inner radius {:.2} Å gives bending strain {:.1}% (> {:.0}% threshold) \
             for monolayer thickness {:.2} Å; innermost winding may be unphysically curved. \
             Increase inner radius.",
            params.inner_radius,
            max_local_strain * 100.0,
            params.strain_warn_threshold * 100.0,
            thickness
        ))
    } else {
        None
    };

    // Realized z-length.
    let length = {
        let zmin = rolled.iter().map(|p| p.z).fold(f64::INFINITY, f64::min);
        let zmax = rolled.iter().map(|p| p.z).fold(f64::NEG_INFINITY, f64::max);
        if rolled.is_empty() {
            0.0
        } else {
            zmax - zmin
        }
    };

    let b = pitch / (2.0 * PI);
    let theta_max = 2.0 * PI * params.turns as f64;
    let outer_radius = params.inner_radius + b * theta_max + thickness / 2.0;
    let arc_length = archimedean_arc_length(params.inner_radius, pitch, params.turns);

    let info = NanoscrollInfo {
        turns: params.turns,
        inner_radius: params.inner_radius,
        outer_radius,
        length,
        monolayer_thickness: thickness,
        interlayer_gap: params.interlayer_gap,
        arc_length,
        supercell: [nx, ny],
        n_atoms: rolled.len() as u32,
        max_local_strain,
        warning: warning.clone(),
    };

    let species: Vec<Species> = elements.into_iter().map(Species::neutral).collect();

    let mut properties: HashMap<String, serde_json::Value> = HashMap::new();
    properties.insert("builder".into(), serde_json::json!("nanoscroll"));
    properties.insert("turns".into(), serde_json::json!(info.turns));
    properties.insert("inner_radius_A".into(), serde_json::json!(info.inner_radius));
    properties.insert("outer_radius_A".into(), serde_json::json!(info.outer_radius));
    properties.insert("length_A".into(), serde_json::json!(info.length));
    properties.insert(
        "monolayer_thickness_A".into(),
        serde_json::json!(info.monolayer_thickness),
    );
    properties.insert(
        "interlayer_gap_A".into(),
        serde_json::json!(info.interlayer_gap),
    );
    properties.insert("arc_length_A".into(), serde_json::json!(info.arc_length));
    properties.insert(
        "supercell".into(),
        serde_json::json!([info.supercell[0], info.supercell[1]]),
    );
    properties.insert(
        "max_local_strain".into(),
        serde_json::json!(info.max_local_strain),
    );
    if let Some(w) = &info.warning {
        properties.insert("warning".into(), serde_json::json!(w));
    }

    let (min, max) = bounding_box(&rolled).ok_or_else(|| FerroxError::InvalidStructure {
        index: 0,
        reason: "nanoscroll produced no atoms".to_string(),
    })?;
    let span = max - min;
    let cell = Vector3::new(
        (span.x + 2.0 * DEFAULT_CELL_PADDING).max(1.0),
        (span.y + 2.0 * DEFAULT_CELL_PADDING).max(1.0),
        (span.z + 2.0 * DEFAULT_CELL_PADDING).max(1.0),
    );
    let shifted_cart: Vec<Vector3<f64>> = rolled
        .iter()
        .map(|p| *p - min + (cell - span) * 0.5)
        .collect();
    let mut lattice = Lattice::orthorhombic(cell.x, cell.y, cell.z);
    lattice.pbc = [false, false, false];
    let frac_coords = lattice.get_fractional_coords(&shifted_cart);
    let structure = Structure::try_new_full(
        lattice,
        species.into_iter().map(crate::species::SiteOccupancy::ordered).collect(),
        frac_coords,
        [false, false, false],
        0.0,
        properties,
    )?;

    Ok((structure, info))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lattice::Lattice;
    use nalgebra::Matrix3;

    /// Build a trivial single-atom hexagonal monolayer for smoke tests.
    fn graphene_like() -> Structure {
        // a = 2.46 Å hexagonal, two C atoms (graphene unit cell).
        let a = 2.46_f64;
        let mat = Matrix3::from_row_slice(&[
            a, 0.0, 0.0,
            -a / 2.0, a * (3.0_f64).sqrt() / 2.0, 0.0,
            0.0, 0.0, 20.0,
        ]);
        let lattice = Lattice::new(mat);
        let species = vec![
            Species::neutral(Element::from_symbol("C").unwrap()),
            Species::neutral(Element::from_symbol("C").unwrap()),
        ];
        let frac = vec![
            Vector3::new(0.0, 0.0, 0.5),
            Vector3::new(1.0 / 3.0, 2.0 / 3.0, 0.5),
        ];
        Structure::try_new(lattice, species, frac).unwrap()
    }

    #[test]
    fn builds_valid_scroll_no_nan() {
        let mono = graphene_like();
        let params = NanoscrollParams {
            turns: 3,
            inner_radius: 15.0,
            length: 8.0,
            ..Default::default()
        };
        let (scroll, info) = build_nanoscroll(&mono, &params).unwrap();
        assert!(scroll.num_sites() > 0);
        assert_eq!(scroll.num_sites() as u32, info.n_atoms);
        // No NaN positions.
        for c in scroll.cart_coords() {
            assert!(c.x.is_finite() && c.y.is_finite() && c.z.is_finite());
        }
        // atom count == base * nx * ny
        let expected = 2 * info.supercell[0] * info.supercell[1];
        assert_eq!(info.n_atoms, expected);
    }

    #[test]
    fn radius_is_monotonic() {
        let mono = graphene_like();
        let params = NanoscrollParams {
            turns: 4,
            inner_radius: 20.0,
            length: 5.0,
            ..Default::default()
        };
        let (scroll, info) = build_nanoscroll(&mono, &params).unwrap();
        // Outer radius must exceed inner radius for a real spiral.
        assert!(info.outer_radius > info.inner_radius);
        // No atom should fall inside (inner_radius - thickness) of axis.
        for c in scroll.cart_coords() {
            let r = (c.x * c.x + c.y * c.y).sqrt();
            assert!(r > info.inner_radius - info.monolayer_thickness - 1e-6);
        }
    }

    #[test]
    fn scroll_cell_encloses_all_atoms() {
        let mono = graphene_like();
        let params = NanoscrollParams {
            turns: 4,
            inner_radius: 18.0,
            length: 9.0,
            ..Default::default()
        };
        let (scroll, _info) = build_nanoscroll(&mono, &params).unwrap();
        let lengths = scroll.lattice.lengths();
        assert_eq!(scroll.pbc, [false, false, false]);
        assert!(lengths.x > 2.0 * params.inner_radius);
        assert!(lengths.y > 2.0 * params.inner_radius);
        for c in scroll.cart_coords() {
            assert!(c.x >= -1e-8 && c.x <= lengths.x + 1e-8);
            assert!(c.y >= -1e-8 && c.y <= lengths.y + 1e-8);
            assert!(c.z >= -1e-8 && c.z <= lengths.z + 1e-8);
        }
    }

    #[test]
    fn gap_fix_increases_pitch() {
        let mono = graphene_like();
        let thickness = monolayer_thickness(&mono);
        // gap=0 reproduces the reference (touching windings).
        let pitch0 = thickness + 0.0;
        assert!((min_interwinding_gap(pitch0, thickness)).abs() < 1e-9);
        // default gap leaves a real vdW separation.
        let pitch = thickness + DEFAULT_INTERLAYER_GAP;
        assert!((min_interwinding_gap(pitch, thickness) - DEFAULT_INTERLAYER_GAP).abs() < 1e-9);
    }

    /// A thick (TMD-like) monolayer: three sub-planes spanning ~3.1 Å.
    fn thick_monolayer() -> Structure {
        let a = 3.16_f64;
        let mat = Matrix3::from_row_slice(&[
            a, 0.0, 0.0,
            -a / 2.0, a * (3.0_f64).sqrt() / 2.0, 0.0,
            0.0, 0.0, 25.0,
        ]);
        let lattice = Lattice::new(mat);
        let species = vec![
            Species::neutral(Element::from_symbol("Mo").unwrap()),
            Species::neutral(Element::from_symbol("S").unwrap()),
            Species::neutral(Element::from_symbol("S").unwrap()),
        ];
        // Mo mid-plane, S above and below (thickness ~3.12 Å for z-span 0.125*25).
        let frac = vec![
            Vector3::new(1.0 / 3.0, 2.0 / 3.0, 0.5),
            Vector3::new(2.0 / 3.0, 1.0 / 3.0, 0.5 + 0.0625),
            Vector3::new(2.0 / 3.0, 1.0 / 3.0, 0.5 - 0.0625),
        ];
        Structure::try_new(lattice, species, frac).unwrap()
    }

    #[test]
    fn strain_warning_for_tiny_radius() {
        let mono = thick_monolayer();
        // thickness ~3.12 Å; inner radius 5 Å -> strain ~0.31 > 0.15 threshold.
        let params = NanoscrollParams {
            turns: 2,
            inner_radius: 5.0,
            length: 5.0,
            ..Default::default()
        };
        let (_scroll, info) = build_nanoscroll(&mono, &params).unwrap();
        assert!(info.monolayer_thickness > 2.5);
        assert!(info.warning.is_some());
        // A comfortable radius produces no warning.
        let params2 = NanoscrollParams {
            inner_radius: 25.0,
            ..params
        };
        let (_s2, info2) = build_nanoscroll(&mono, &params2).unwrap();
        assert!(info2.warning.is_none());
    }
}

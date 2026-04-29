//! Voronoi cell construction via half-space intersection.
//!
//! Builds the Voronoi cell of a single generator by iteratively clipping
//! an axis-aligned bounding box with perpendicular bisector planes.
//! Provides face vertex positions for computing solid angles, areas, and volumes.
//!
//! Pure Rust — compiles to `wasm32-unknown-unknown` without C FFI.

use nalgebra::Vector3;
use std::f64::consts::PI;

/// Tolerance for signed-distance classification during plane clipping.
const CLIP_EPS: f64 = 1e-10;
/// Tolerance for merging nearby vertices on a new clip face.
const MERGE_TOL: f64 = 1e-8;
/// Squared merge tolerance (avoids sqrt in hot path).
const MERGE_TOL_SQ: f64 = MERGE_TOL * MERGE_TOL;

// ── Public types ──────────────────────────────────────────────────

/// A face of the Voronoi cell.
#[derive(Debug, Clone)]
pub struct VoronoiFacet {
    /// Vertices of the face polygon, ordered around the perimeter.
    pub vertices: Vec<Vector3<f64>>,
    /// Index into the neighbor array whose bisector generated this face.
    /// `None` for initial bounding-box faces (stripped after construction).
    pub neighbor_idx: Option<usize>,
}

/// Computed properties of a Voronoi face relative to the cell center.
#[derive(Debug, Clone, Copy)]
pub struct FacetProps {
    /// Solid angle subtended by the face as seen from the cell center (steradians).
    pub solid_angle: f64,
    /// Area of the face (Å²).
    pub area: f64,
    /// Distance from center to the bisector plane (= half the center–neighbor distance) (Å).
    pub face_dist: f64,
    /// Volume of the pyramid from center to face (ų).
    pub volume: f64,
    /// Number of vertices on the face.
    pub n_verts: usize,
}

/// Voronoi cell represented as a convex polytope.
#[derive(Debug, Clone)]
pub struct VoronoiCell {
    /// Faces of the cell.
    pub facets: Vec<VoronoiFacet>,
}

// ── Construction ──────────────────────────────────────────────────

impl VoronoiCell {
    /// Create an axis-aligned bounding box centered at `c` with half-width `h`.
    ///
    /// Face vertices are ordered so the cross product of consecutive edges
    /// points outward (counterclockwise when viewed from outside).
    fn bbox(c: &Vector3<f64>, h: f64) -> Self {
        let (x, y, z) = (c.x, c.y, c.z);
        #[rustfmt::skip]
        let v = [
            Vector3::new(x - h, y - h, z - h), // 0
            Vector3::new(x + h, y - h, z - h), // 1
            Vector3::new(x + h, y + h, z - h), // 2
            Vector3::new(x - h, y + h, z - h), // 3
            Vector3::new(x - h, y - h, z + h), // 4
            Vector3::new(x + h, y - h, z + h), // 5
            Vector3::new(x + h, y + h, z + h), // 6
            Vector3::new(x - h, y + h, z + h), // 7
        ];
        Self {
            facets: vec![
                VoronoiFacet { vertices: vec![v[0], v[4], v[7], v[3]], neighbor_idx: None }, // −x
                VoronoiFacet { vertices: vec![v[1], v[2], v[6], v[5]], neighbor_idx: None }, // +x
                VoronoiFacet { vertices: vec![v[0], v[1], v[5], v[4]], neighbor_idx: None }, // −y
                VoronoiFacet { vertices: vec![v[3], v[7], v[6], v[2]], neighbor_idx: None }, // +y
                VoronoiFacet { vertices: vec![v[0], v[3], v[2], v[1]], neighbor_idx: None }, // −z
                VoronoiFacet { vertices: vec![v[4], v[5], v[6], v[7]], neighbor_idx: None }, // +z
            ],
        }
    }

    /// Clip by the perpendicular bisector of `center`–`neighbor`.
    /// Keeps the half-space containing `center`.
    fn clip(&mut self, center: &Vector3<f64>, neighbor: &Vector3<f64>, neighbor_idx: usize) {
        let mid = (center + neighbor) * 0.5;
        let dir = neighbor - center;
        let len = dir.norm();
        if len < 1e-15 {
            return; // degenerate: neighbor coincides with center
        }
        let normal = dir / len;
        // Plane: normal · x + d = 0.  Keep where normal · x + d ≤ 0 (center side).
        let d = -normal.dot(&mid);

        let mut kept = Vec::with_capacity(self.facets.len() + 1);
        let mut new_pts: Vec<Vector3<f64>> = Vec::new();

        for facet in &self.facets {
            let nv = facet.vertices.len();
            if nv < 3 {
                continue;
            }

            let sd: Vec<f64> = facet.vertices.iter().map(|v| normal.dot(v) + d).collect();

            if sd.iter().all(|&s| s <= CLIP_EPS) {
                // Entirely inside → keep unchanged.
                kept.push(facet.clone());
                continue;
            }
            if sd.iter().all(|&s| s > CLIP_EPS) {
                // Entirely outside → discard.
                continue;
            }

            // Mixed — Sutherland-Hodgman clip.
            let mut clipped = Vec::with_capacity(nv + 2);
            for i in 0..nv {
                let j = (i + 1) % nv;
                let (di, dj) = (sd[i], sd[j]);
                let (vi, vj) = (facet.vertices[i], facet.vertices[j]);

                if di <= CLIP_EPS {
                    clipped.push(vi);
                    if dj > CLIP_EPS {
                        let t = di / (di - dj);
                        let p = vi + t * (vj - vi);
                        clipped.push(p);
                        new_pts.push(p);
                    }
                } else if dj <= CLIP_EPS {
                    let t = di / (di - dj);
                    let p = vi + t * (vj - vi);
                    clipped.push(p);
                    new_pts.push(p);
                }
            }

            let clean = dedup_sequential(&clipped);
            if clean.len() >= 3 {
                kept.push(VoronoiFacet {
                    vertices: clean,
                    neighbor_idx: facet.neighbor_idx,
                });
            }
        }

        // Build a new face from the clip-plane intersection points.
        if new_pts.len() >= 3 {
            let deduped = dedup_vertices(&new_pts);
            if deduped.len() >= 3 {
                let ordered = order_planar_vertices(&deduped, &normal);
                if ordered.len() >= 3 {
                    kept.push(VoronoiFacet {
                        vertices: ordered,
                        neighbor_idx: Some(neighbor_idx),
                    });
                }
            }
        }

        self.facets = kept;
    }
}

/// Build the Voronoi cell of `center` among `neighbors`.
///
/// Returns only neighbor-generated faces (bounding-box faces are stripped).
/// Neighbors are clipped closest-first for efficiency.
pub fn build_voronoi_cell(
    center: &Vector3<f64>,
    neighbors: &[Vector3<f64>],
) -> VoronoiCell {
    if neighbors.is_empty() {
        return VoronoiCell { facets: vec![] };
    }

    let max_dist = neighbors
        .iter()
        .map(|n| (n - center).norm())
        .fold(0.0_f64, f64::max);

    let mut cell = VoronoiCell::bbox(center, max_dist * 2.0);

    // Sort by distance (closer neighbors trim more aggressively, reducing later work).
    let mut order: Vec<usize> = (0..neighbors.len()).collect();
    order.sort_by(|&a, &b| {
        let da = (neighbors[a] - center).norm_squared();
        let db = (neighbors[b] - center).norm_squared();
        da.total_cmp(&db)
    });

    for &i in &order {
        cell.clip(center, &neighbors[i], i);
    }

    // Strip bounding-box faces — only keep neighbor bisector faces.
    cell.facets.retain(|f| f.neighbor_idx.is_some());
    cell
}

/// Compute geometric properties of a facet as seen from `center`.
pub fn facet_props(
    center: &Vector3<f64>,
    neighbor: &Vector3<f64>,
    facet: &VoronoiFacet,
) -> FacetProps {
    FacetProps {
        solid_angle: solid_angle(center, &facet.vertices),
        area: polygon_area(&facet.vertices),
        face_dist: (neighbor - center).norm() * 0.5,
        volume: pyramid_volume(center, &facet.vertices),
        n_verts: facet.vertices.len(),
    }
}

// ── Geometry helpers ──────────────────────────────────────────────

/// Solid angle of a polygon seen from a point (spherical excess formula).
///
/// Matches pymatgen's `solid_angle()` implementation.
pub fn solid_angle(origin: &Vector3<f64>, poly: &[Vector3<f64>]) -> f64 {
    let n = poly.len();
    if n < 3 {
        return 0.0;
    }

    // Vectors from origin to each vertex.
    let r: Vec<Vector3<f64>> = poly.iter().map(|v| v - origin).collect();

    // Normal of each triangle fan edge pair: cross(r[i+1], r[i]).
    let normals: Vec<Vector3<f64>> = (0..n).map(|i| r[(i + 1) % n].cross(&r[i])).collect();

    // Sum dihedral angles between consecutive normals.
    let mut phi = 0.0;
    for i in 0..n {
        let (n1, n2) = (&normals[i], &normals[(i + 1) % n]);
        let (l1, l2) = (n1.norm(), n2.norm());
        if l1 < 1e-15 || l2 < 1e-15 {
            continue;
        }
        let cos_v = (-(n1.dot(n2)) / (l1 * l2)).clamp(-1.0, 1.0);
        phi += cos_v.acos();
    }

    // Ω = Σ(dihedral angles) + (2 − n)π.
    (phi + (2.0 - n as f64) * PI).abs()
}

/// Area of a 3D polygon (cross-product fan from vertex 0).
fn polygon_area(verts: &[Vector3<f64>]) -> f64 {
    if verts.len() < 3 {
        return 0.0;
    }
    let mut cross_sum = Vector3::zeros();
    for i in 1..verts.len() - 1 {
        cross_sum += (verts[i] - verts[0]).cross(&(verts[i + 1] - verts[0]));
    }
    cross_sum.norm() * 0.5
}

/// Volume of a pyramid from `apex` to a polygon base (sum of tetrahedra).
fn pyramid_volume(apex: &Vector3<f64>, base: &[Vector3<f64>]) -> f64 {
    if base.len() < 3 {
        return 0.0;
    }
    let mut vol = 0.0;
    for i in 1..base.len() - 1 {
        vol += (base[0] - apex)
            .dot(&(base[i] - apex).cross(&(base[i + 1] - apex)))
            .abs();
    }
    vol / 6.0
}

/// Deduplicate vertices within [`MERGE_TOL`] (unordered set — O(n²)).
fn dedup_vertices(pts: &[Vector3<f64>]) -> Vec<Vector3<f64>> {
    let mut out = Vec::with_capacity(pts.len());
    for p in pts {
        if !out
            .iter()
            .any(|q: &Vector3<f64>| (q - p).norm_squared() < MERGE_TOL_SQ)
        {
            out.push(*p);
        }
    }
    out
}

/// Remove consecutive-duplicate vertices from a polygon (preserves winding).
///
/// Duplicate vertices cause the solid-angle formula to miscount `n`,
/// producing wrong `(2−n)π` corrections.
fn dedup_sequential(poly: &[Vector3<f64>]) -> Vec<Vector3<f64>> {
    if poly.len() < 2 {
        return poly.to_vec();
    }
    let mut out = Vec::with_capacity(poly.len());
    out.push(poly[0]);
    for v in &poly[1..] {
        if (v - out.last().unwrap()).norm_squared() > MERGE_TOL_SQ {
            out.push(*v);
        }
    }
    // Check wrap-around: last vs first.
    if out.len() > 1 && (out.last().unwrap() - out[0]).norm_squared() < MERGE_TOL_SQ {
        out.pop();
    }
    out
}

/// Sort coplanar points into a convex polygon by angle around their centroid.
fn order_planar_vertices(pts: &[Vector3<f64>], normal: &Vector3<f64>) -> Vec<Vector3<f64>> {
    if pts.len() <= 2 {
        return pts.to_vec();
    }

    let centroid: Vector3<f64> = pts.iter().sum::<Vector3<f64>>() / pts.len() as f64;

    // Build an orthonormal basis in the plane.
    let u = {
        // Project the first non-degenerate point-to-centroid vector onto the plane.
        let mut basis = Vector3::zeros();
        for p in pts {
            let d = p - centroid;
            let proj = d - normal * d.dot(normal);
            if proj.norm() > 1e-12 {
                basis = proj.normalize();
                break;
            }
        }
        basis
    };
    if u.norm() < 0.5 {
        return pts.to_vec(); // degenerate — all points at centroid
    }
    let w = normal.cross(&u);

    let mut indexed: Vec<(f64, usize)> = pts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let d = p - centroid;
            (d.dot(&w).atan2(d.dot(&u)), i)
        })
        .collect();
    indexed.sort_by(|a, b| a.0.total_cmp(&b.0));
    indexed.iter().map(|&(_, i)| pts[i]).collect()
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solid_angle_cube_face() {
        // Each face of a cube centered at origin subtends 4π/6 ≈ 2.094 sr.
        let center = Vector3::zeros();
        let face = vec![
            Vector3::new(0.5, -0.5, -0.5),
            Vector3::new(0.5, 0.5, -0.5),
            Vector3::new(0.5, 0.5, 0.5),
            Vector3::new(0.5, -0.5, 0.5),
        ];
        let omega = solid_angle(&center, &face);
        let expected = 4.0 * PI / 6.0;
        assert!(
            (omega - expected).abs() < 0.02,
            "got {omega:.4}, expected {expected:.4}"
        );
    }

    #[test]
    fn polygon_area_square() {
        let verts = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(2.0, 0.0, 0.0),
            Vector3::new(2.0, 3.0, 0.0),
            Vector3::new(0.0, 3.0, 0.0),
        ];
        assert!((polygon_area(&verts) - 6.0).abs() < 1e-10);
    }

    #[test]
    fn voronoi_simple_cubic() {
        // 6 neighbors at ±a along axes → cube-shaped Voronoi cell with 6 faces.
        let center = Vector3::zeros();
        let a = 3.0;
        let neighbors = vec![
            Vector3::new(a, 0.0, 0.0),
            Vector3::new(-a, 0.0, 0.0),
            Vector3::new(0.0, a, 0.0),
            Vector3::new(0.0, -a, 0.0),
            Vector3::new(0.0, 0.0, a),
            Vector3::new(0.0, 0.0, -a),
        ];

        let cell = build_voronoi_cell(&center, &neighbors);
        assert_eq!(cell.facets.len(), 6, "cubic cell should have 6 faces");

        let expected_sa = 4.0 * PI / 6.0;
        for facet in &cell.facets {
            let idx = facet.neighbor_idx.unwrap();
            let props = facet_props(&center, &neighbors[idx], facet);
            assert!(
                (props.solid_angle - expected_sa).abs() < 0.05,
                "face {idx}: solid_angle={:.3}, expected {expected_sa:.3}",
                props.solid_angle
            );
            assert!(
                (props.face_dist - a / 2.0).abs() < 0.01,
                "face {idx}: face_dist={:.3}, expected {:.3}",
                props.face_dist,
                a / 2.0
            );
        }
    }

    #[test]
    fn voronoi_fcc_12_neighbors() {
        // 12 FCC nearest neighbors → rhombic dodecahedron with 12 faces.
        let center = Vector3::zeros();
        let h = 3.61 / 2.0;
        let neighbors = vec![
            Vector3::new(h, h, 0.0),
            Vector3::new(h, -h, 0.0),
            Vector3::new(-h, h, 0.0),
            Vector3::new(-h, -h, 0.0),
            Vector3::new(h, 0.0, h),
            Vector3::new(h, 0.0, -h),
            Vector3::new(-h, 0.0, h),
            Vector3::new(-h, 0.0, -h),
            Vector3::new(0.0, h, h),
            Vector3::new(0.0, h, -h),
            Vector3::new(0.0, -h, h),
            Vector3::new(0.0, -h, -h),
        ];

        let cell = build_voronoi_cell(&center, &neighbors);
        assert_eq!(cell.facets.len(), 12, "FCC should have 12 faces");

        // By symmetry all faces subtend equal solid angles = 4π/12.
        let expected_sa = 4.0 * PI / 12.0;
        for facet in &cell.facets {
            let idx = facet.neighbor_idx.unwrap();
            let props = facet_props(&center, &neighbors[idx], facet);
            assert!(
                (props.solid_angle - expected_sa).abs() < 0.1,
                "face {idx}: Ω={:.3}, expected {expected_sa:.3}",
                props.solid_angle
            );
        }

        // Total solid angle should be 4π.
        let total: f64 = cell
            .facets
            .iter()
            .map(|f| {
                let idx = f.neighbor_idx.unwrap();
                facet_props(&center, &neighbors[idx], f).solid_angle
            })
            .sum();
        assert!(
            (total - 4.0 * PI).abs() < 0.5,
            "total Ω={total:.3}, expected {:.3}",
            4.0 * PI
        );
    }

    #[test]
    fn voronoi_bcc_truncated_octahedron() {
        // BCC: 8 NN at (±a/2, ±a/2, ±a/2) + 6 2NN at (±a, 0, 0) etc.
        // The Wigner-Seitz cell is a truncated octahedron with 14 faces.
        let center = Vector3::zeros();
        let a = 2.87; // BCC Fe
        let h = a / 2.0;
        let mut neighbors: Vec<Vector3<f64>> = Vec::new();
        // 8 nearest neighbors
        for &sx in &[1.0, -1.0] {
            for &sy in &[1.0, -1.0] {
                for &sz in &[1.0, -1.0] {
                    neighbors.push(Vector3::new(sx * h, sy * h, sz * h));
                }
            }
        }
        // 6 second-nearest neighbors
        neighbors.push(Vector3::new(a, 0.0, 0.0));
        neighbors.push(Vector3::new(-a, 0.0, 0.0));
        neighbors.push(Vector3::new(0.0, a, 0.0));
        neighbors.push(Vector3::new(0.0, -a, 0.0));
        neighbors.push(Vector3::new(0.0, 0.0, a));
        neighbors.push(Vector3::new(0.0, 0.0, -a));

        let cell = build_voronoi_cell(&center, &neighbors);
        assert_eq!(
            cell.facets.len(),
            14,
            "BCC truncated octahedron should have 14 faces, got {}",
            cell.facets.len()
        );
    }

    #[test]
    fn pyramid_volume_unit_cube() {
        // Pyramid from origin to 1×1 square at z=1: volume = 1/3.
        let apex = Vector3::zeros();
        let base = vec![
            Vector3::new(0.0, 0.0, 1.0),
            Vector3::new(1.0, 0.0, 1.0),
            Vector3::new(1.0, 1.0, 1.0),
            Vector3::new(0.0, 1.0, 1.0),
        ];
        let vol = pyramid_volume(&apex, &base);
        assert!(
            (vol - 1.0 / 3.0).abs() < 1e-10,
            "volume={vol}, expected 0.333"
        );
    }
}

//! Pure geometry: rotation, 3D→2D projection, depth ordering.

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

/// Project rotated points to 2D screen coords (orthographic, +Z toward viewer).
pub fn project(points: &[[f64; 3]], rot_deg: [f64; 3]) -> Vec<([f64; 2], f64)> {
    points
        .iter()
        .map(|&p| {
            let r = rotate(p, rot_deg);
            ([r[0], r[1]], r[2])
        })
        .collect()
}

/// Atom indices sorted back-to-front (smallest depth first → drawn first).
pub fn depth_order(projected: &[([f64; 2], f64)]) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..projected.len()).collect();
    idx.sort_by(|&a, &b| projected[a].1.partial_cmp(&projected[b].1).unwrap());
    idx
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

    #[test]
    fn depth_order_is_back_to_front() {
        let proj = vec![([0.0, 0.0], 5.0), ([0.0, 0.0], -2.0), ([0.0, 0.0], 1.0)];
        assert_eq!(depth_order(&proj), vec![1, 2, 0]);
    }
}

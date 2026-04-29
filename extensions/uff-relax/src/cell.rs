use glam::DMat3;
use glam::DVec3;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CellType {
    None,
    Orthorhombic { size: DVec3 },
    Triclinic { matrix: DMat3 },
}

#[derive(Debug, Clone)]
pub struct UnitCell {
    pub cell_type: CellType,
    // Matrix where columns are cell vectors a, b, c
    matrix: DMat3,
    // Inverse matrix for fractional coordinate conversion
    inv_matrix: DMat3,
}

impl UnitCell {
    pub fn new_none() -> Self {
        Self {
            cell_type: CellType::None,
            matrix: DMat3::IDENTITY,
            inv_matrix: DMat3::IDENTITY,
        }
    }

    pub fn new_orthorhombic(size: DVec3) -> Self {
        let matrix = DMat3::from_cols(
            DVec3::new(size.x, 0.0, 0.0),
            DVec3::new(0.0, size.y, 0.0),
            DVec3::new(0.0, 0.0, size.z),
        );
        Self {
            cell_type: CellType::Orthorhombic { size },
            matrix,
            inv_matrix: matrix.inverse(),
        }
    }

    pub fn new_triclinic(matrix: DMat3) -> Self {
        Self {
            cell_type: CellType::Triclinic { matrix },
            matrix,
            inv_matrix: matrix.inverse(),
        }
    }

    /// Returns the shortest displacement vector from p2 to p1 considering PBC.
    pub fn distance_vector(&self, p1: DVec3, p2: DVec3) -> DVec3 {
        let mut diff = p1 - p2;
        match self.cell_type {
            CellType::None => diff,
            CellType::Orthorhombic { size } => {
                if diff.x > size.x * 0.5 { diff.x -= size.x; }
                else if diff.x < -size.x * 0.5 { diff.x += size.x; }
                
                if diff.y > size.y * 0.5 { diff.y -= size.y; }
                else if diff.y < -size.y * 0.5 { diff.y += size.y; }
                
                if diff.z > size.z * 0.5 { diff.z -= size.z; }
                else if diff.z < -size.z * 0.5 { diff.z += size.z; }
                diff
            }
            CellType::Triclinic { .. } => {
                // Convert to fractional coordinates
                let f_diff = self.inv_matrix * diff;
                // Apply PBC in fractional space [-0.5, 0.5]
                let f_diff_pbc = DVec3::new(
                    f_diff.x - f_diff.x.round(),
                    f_diff.y - f_diff.y.round(),
                    f_diff.z - f_diff.z.round(),
                );
                // Convert back to Cartesian
                self.matrix * f_diff_pbc
            }
        }
    }

    pub fn matrix(&self) -> DMat3 {
        self.matrix
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_orthorhombic_distance() {
        let size = DVec3::new(10.0, 10.0, 10.0);
        let cell = UnitCell::new_orthorhombic(size);
        
        let p1 = DVec3::new(1.0, 1.0, 1.0);
        let p2 = DVec3::new(9.0, 9.0, 9.0);
        
        let dist_vec = cell.distance_vector(p1, p2);
        // Minimum image convention: dist should be (-2, -2, -2) or (2, 2, 2) length-wise
        assert!((dist_vec.length() - (3.0 * 2.0f64.powi(2)).sqrt()).abs() < 1e-9);
    }

    #[test]
    fn test_none_distance() {
        let cell = UnitCell::new_none();
        let p1 = DVec3::new(1.0, 1.0, 1.0);
        let p2 = DVec3::new(9.0, 9.0, 9.0);
        let dist_vec = cell.distance_vector(p1, p2);
        assert!((dist_vec.length() - (3.0 * 8.0f64.powi(2)).sqrt()).abs() < 1e-9);
    }
}
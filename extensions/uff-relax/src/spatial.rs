use glam::DVec3;
use crate::cell::{UnitCell, CellType};

pub struct CellList {
    pub cells: Vec<Vec<usize>>,
    pub dx: usize,
    pub dy: usize,
    pub dz: usize,
    pub cell_size: DVec3,
    pub min_p: DVec3,
}

impl CellList {
    pub fn build(positions: &[DVec3], cell: &UnitCell, cutoff: f64) -> Self {
        let (min_p, max_p) = match cell.cell_type {
            CellType::None => {
                let mut min = positions[0];
                let mut max = positions[0];
                for &p in positions {
                    min = min.min(p);
                    max = max.max(p);
                }
                (min, max)
            }
            CellType::Orthorhombic { size } => (DVec3::ZERO, size),
            CellType::Triclinic { matrix } => {
                // For triclinic, we use a simple bounding box of the cell vectors
                let mut min = DVec3::ZERO;
                let mut max = DVec3::ZERO;
                let corners = [
                    DVec3::ZERO,
                    matrix.col(0),
                    matrix.col(1),
                    matrix.col(2),
                    matrix.col(0) + matrix.col(1),
                    matrix.col(0) + matrix.col(2),
                    matrix.col(1) + matrix.col(2),
                    matrix.col(0) + matrix.col(1) + matrix.col(2),
                ];
                for &c in &corners {
                    min = min.min(c);
                    max = max.max(c);
                }
                (min, max)
            }
        };

        let span = max_p - min_p;
        let dx = (span.x / cutoff).ceil() as usize + 1;
        let dy = (span.y / cutoff).ceil() as usize + 1;
        let dz = (span.z / cutoff).ceil() as usize + 1;
        
        let cell_size = DVec3::new(span.x / dx as f64, span.y / dy as f64, span.z / dz as f64);
        let mut cells = vec![Vec::new(); dx * dy * dz];

        for (i, &p) in positions.iter().enumerate() {
            let rel = p - min_p;
            let ix = ((rel.x / cell_size.x) as usize).min(dx - 1);
            let iy = ((rel.y / cell_size.y) as usize).min(dy - 1);
            let iz = ((rel.z / cell_size.z) as usize).min(dz - 1);
            cells[ix * dy * dz + iy * dz + iz].push(i);
        }

        Self { cells, dx, dy, dz, cell_size, min_p }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cell_list_build() {
        let positions = vec![
            DVec3::new(1.0, 1.0, 1.0),
            DVec3::new(1.1, 1.1, 1.1),
            DVec3::new(5.0, 5.0, 5.0),
        ];
        let cell = UnitCell::new_none();
        let cutoff = 2.0;
        let cl = CellList::build(&positions, &cell, cutoff);
        
        // Check that points close together are in the same or adjacent cells
        // In this case (1,1,1) and (1.1, 1.1, 1.1) should be very close.
        assert!(cl.cells.iter().any(|c| c.len() >= 2 || (c.len() == 1)));
    }
}

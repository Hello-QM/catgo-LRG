//! Gaussian cube file parser
//!
//! Format:
//!   Line 1: Comment
//!   Line 2: Comment
//!   Line 3: N_atoms  origin_x  origin_y  origin_z
//!   Line 4: N1  dv1_x  dv1_y  dv1_z   (voxel count + step vector for axis 1)
//!   Line 5: N2  dv2_x  dv2_y  dv2_z
//!   Line 6: N3  dv3_x  dv3_y  dv3_z
//!   Lines 7..7+N_atoms: Z  charge  x  y  z  (atom info)
//!   Remaining: volumetric data (N1*N2*N3 values, 6 per line)
//!
//! Coordinates are in Bohr (1 Bohr = 0.529177 Å)

use anyhow::{Context, Result};
use serde::Serialize;
use std::io::{BufRead, BufReader, Read};

pub const BOHR_TO_ANGSTROM: f64 = 0.529177210903;

#[derive(Debug, Clone, Serialize)]
pub struct Atom {
    pub atomic_number: i32,
    pub charge: f64,
    /// Position in Angstroms
    pub position: [f64; 3],
}

#[derive(Debug, Clone, Serialize)]
pub struct CubeHeader {
    pub comment1: String,
    pub comment2: String,
    pub n_atoms: usize,
    /// Origin in Angstroms
    pub origin: [f64; 3],
    /// Grid dimensions [nx, ny, nz]
    pub dims: [usize; 3],
    /// Voxel step vectors in Angstroms (3x3 matrix, row-major)
    pub voxel_axes: [[f64; 3]; 3],
    pub atoms: Vec<Atom>,
}

#[derive(Debug)]
pub struct CubeFile {
    pub header: CubeHeader,
    /// Volumetric data: flat array of shape [nx][ny][nz] in row-major order
    pub data: Vec<f32>,
    pub data_min: f32,
    pub data_max: f32,
}

impl CubeFile {
    /// Parse a cube file from a reader (supports streaming for large files)
    pub fn parse<R: Read>(reader: R) -> Result<Self> {
        let mut buf = BufReader::with_capacity(1 << 20, reader); // 1MB buffer
        let mut line = String::new();

        // Line 1-2: Comments
        buf.read_line(&mut line)?;
        let comment1 = line.trim().to_string();
        line.clear();
        buf.read_line(&mut line)?;
        let comment2 = line.trim().to_string();
        line.clear();

        // Line 3: N_atoms, origin
        // If N_atoms < 0, coordinates are already in Angstroms
        buf.read_line(&mut line)?;
        let parts: Vec<&str> = line.split_whitespace().collect();
        let n_atoms = parts[0].parse::<i32>().context("parsing n_atoms")?;
        let n_atoms_abs = n_atoms.unsigned_abs() as usize;
        let is_angstrom = n_atoms < 0;
        let scale = if is_angstrom { 1.0 } else { BOHR_TO_ANGSTROM };
        let origin = [
            parts[1].parse::<f64>()? * scale,
            parts[2].parse::<f64>()? * scale,
            parts[3].parse::<f64>()? * scale,
        ];
        line.clear();

        // Lines 4-6: Grid dimensions and step vectors
        let mut dims = [0usize; 3];
        let mut voxel_axes = [[0.0f64; 3]; 3];
        for i in 0..3 {
            buf.read_line(&mut line)?;
            let parts: Vec<&str> = line.split_whitespace().collect();
            dims[i] = parts[0].parse::<usize>().context("parsing grid dim")?;
            voxel_axes[i] = [
                parts[1].parse::<f64>()? * scale,
                parts[2].parse::<f64>()? * scale,
                parts[3].parse::<f64>()? * scale,
            ];
            line.clear();
        }

        // Lines 7..7+N_atoms: Atom data
        let mut atoms = Vec::with_capacity(n_atoms_abs);
        for _ in 0..n_atoms_abs {
            buf.read_line(&mut line)?;
            let parts: Vec<&str> = line.split_whitespace().collect();
            atoms.push(Atom {
                atomic_number: parts[0].parse()?,
                charge: parts[1].parse()?,
                position: [
                    parts[2].parse::<f64>()? * scale,
                    parts[3].parse::<f64>()? * scale,
                    parts[4].parse::<f64>()? * scale,
                ],
            });
            line.clear();
        }

        let header = CubeHeader {
            comment1,
            comment2,
            n_atoms: n_atoms_abs,
            origin,
            dims,
            voxel_axes,
            atoms,
        };

        // Volumetric data
        let total_voxels = dims[0] * dims[1] * dims[2];
        eprintln!(
            "Grid: {}x{}x{} = {} voxels ({:.1} MB as f32)",
            dims[0],
            dims[1],
            dims[2],
            total_voxels,
            total_voxels as f64 * 4.0 / 1e6
        );

        let mut data = Vec::with_capacity(total_voxels);
        let mut data_min = f32::MAX;
        let mut data_max = f32::MIN;

        // Read all remaining lines and parse float values
        for line_result in buf.lines() {
            let l = line_result?;
            for token in l.split_whitespace() {
                if data.len() >= total_voxels {
                    break;
                }
                let val: f32 = token.parse().context("parsing volumetric value")?;
                if val < data_min {
                    data_min = val;
                }
                if val > data_max {
                    data_max = val;
                }
                data.push(val);
            }
            if data.len() >= total_voxels {
                break;
            }
        }

        if data.len() != total_voxels {
            anyhow::bail!(
                "Expected {} voxels but got {}",
                total_voxels,
                data.len()
            );
        }

        eprintln!("Data range: [{:.6e}, {:.6e}]", data_min, data_max);

        Ok(CubeFile {
            header,
            data,
            data_min,
            data_max,
        })
    }

    /// Get voxel value at grid indices (ix, iy, iz)
    #[inline]
    pub fn get(&self, ix: usize, iy: usize, iz: usize) -> f32 {
        let [_, ny, nz] = self.header.dims;
        self.data[ix * ny * nz + iy * nz + iz]
    }

    /// Convert grid indices to Cartesian coordinates (Angstroms)
    #[inline]
    pub fn grid_to_cart(&self, ix: f64, iy: f64, iz: f64) -> [f64; 3] {
        let o = &self.header.origin;
        let v = &self.header.voxel_axes;
        [
            o[0] + ix * v[0][0] + iy * v[1][0] + iz * v[2][0],
            o[1] + ix * v[0][1] + iy * v[1][1] + iz * v[2][1],
            o[2] + ix * v[0][2] + iy * v[1][2] + iz * v[2][2],
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn test_parse_minimal() {
        let cube_text = "\
Comment 1
Comment 2
  1   0.000000   0.000000   0.000000
  2   1.000000   0.000000   0.000000
  2   0.000000   1.000000   0.000000
  2   0.000000   0.000000   1.000000
  6   6.000000   0.000000   0.000000   0.000000
 1.0 2.0 3.0 4.0 5.0 6.0
 7.0 8.0
";
        let cube = CubeFile::parse(Cursor::new(cube_text)).unwrap();
        assert_eq!(cube.header.dims, [2, 2, 2]);
        assert_eq!(cube.header.n_atoms, 1);
        assert_eq!(cube.data.len(), 8);
        assert!((cube.data[0] - 1.0).abs() < 1e-6);
        assert!((cube.data[7] - 8.0).abs() < 1e-6);
    }
}

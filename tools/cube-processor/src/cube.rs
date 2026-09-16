//! Gaussian cube file parser
//!
//! Format:
//!   Line 1: Comment
//!   Line 2: Comment
//!   Line 3: N_atoms  origin_x  origin_y  origin_z  [NVAL]
//!   Line 4: N1  dv1_x  dv1_y  dv1_z   (voxel count + step vector for axis 1)
//!   Line 5: N2  dv2_x  dv2_y  dv2_z
//!   Line 6: N3  dv3_x  dv3_y  dv3_z
//!   Lines 7..7+N_atoms: Z  charge  x  y  z  (atom info)
//!   If N_atoms < 0: number of orbitals followed by their IDs (may wrap lines)
//!   Remaining: volumetric data (N1*N2*N3 values, z varies fastest)
//!
//! Coordinates are in Bohr regardless of the sign of N_atoms. Only one
//! dataset is supported; negative/zero grid dimensions are rejected.

use anyhow::{ensure, Context, Result};
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

fn read_record(buf: &mut impl BufRead, line: &mut String, name: &str) -> Result<()> {
    line.clear();
    ensure!(buf.read_line(line)? != 0, "Missing {name}");
    Ok(())
}

fn finite_float(token: &str) -> Result<f64> {
    let value = if token.contains('D') || token.contains('d') {
        token.replace(['D', 'd'], "E").parse::<f64>()
    } else {
        token.parse::<f64>()
    }
    .with_context(|| format!("Invalid numeric value: {token}"))?;
    ensure!(value.is_finite(), "Non-finite numeric value: {token}");
    Ok(value)
}

fn checked_voxels(dims: [usize; 3]) -> Result<usize> {
    let total = dims.into_iter().try_fold(1usize, |total, dim| {
        ensure!(dim > 0, "Grid dimensions must be positive");
        total.checked_mul(dim).context("Grid dimensions overflow")
    })?;
    ensure!(
        total <= isize::MAX as usize / std::mem::size_of::<f32>(),
        "Grid data size exceeds the addressable buffer size"
    );
    Ok(total)
}

impl CubeFile {
    /// Parse a cube file from a reader (supports streaming for large files)
    pub fn parse<R: Read>(reader: R) -> Result<Self> {
        let mut buf = BufReader::with_capacity(1 << 20, reader); // 1MB buffer
        let mut line = String::new();

        // Line 1-2: Comments
        read_record(&mut buf, &mut line, "first comment")?;
        let comment1 = line.trim().to_string();
        read_record(&mut buf, &mut line, "second comment")?;
        let comment2 = line.trim().to_string();

        // NATOMS < 0 announces an orbital-ID record, not Angstrom coordinates.
        read_record(&mut buf, &mut line, "atom count and origin")?;
        let parts: Vec<&str> = line.split_whitespace().collect();
        ensure!(
            parts.len() == 4 || parts.len() == 5,
            "Expected NATOMS, origin and optional NVAL"
        );
        let n_atoms = parts[0].parse::<i64>().context("parsing NATOMS")?;
        let n_atoms_abs = usize::try_from(n_atoms.unsigned_abs()).context("Atom count overflow")?;
        if let Some(nval) = parts.get(4) {
            ensure!(
                nval.parse::<usize>().context("parsing NVAL")? == 1,
                "Only NVAL=1 is supported"
            );
        }
        let scale = BOHR_TO_ANGSTROM;
        let origin = [
            finite_float(parts[1])? * scale,
            finite_float(parts[2])? * scale,
            finite_float(parts[3])? * scale,
        ];

        // Lines 4-6: Grid dimensions and step vectors
        let mut dims = [0usize; 3];
        let mut voxel_axes = [[0.0f64; 3]; 3];
        for i in 0..3 {
            read_record(&mut buf, &mut line, "grid axis")?;
            let parts: Vec<&str> = line.split_whitespace().collect();
            ensure!(
                parts.len() == 4,
                "Expected grid dimension and three axis components"
            );
            dims[i] = parts[0].parse::<usize>().context("parsing grid dim")?;
            voxel_axes[i] = [
                finite_float(parts[1])? * scale,
                finite_float(parts[2])? * scale,
                finite_float(parts[3])? * scale,
            ];
        }
        let total_voxels = checked_voxels(dims)?;

        // Lines 7..7+N_atoms: Atom data
        let mut atoms = Vec::new();
        for _ in 0..n_atoms_abs {
            read_record(&mut buf, &mut line, "atom record")?;
            let parts: Vec<&str> = line.split_whitespace().collect();
            ensure!(
                parts.len() == 5,
                "Expected atomic number, charge and three coordinates"
            );
            atoms.try_reserve(1).context("Allocating atom records")?;
            atoms.push(Atom {
                atomic_number: parts[0].parse()?,
                charge: finite_float(parts[1])?,
                position: [
                    finite_float(parts[2])? * scale,
                    finite_float(parts[3])? * scale,
                    finite_float(parts[4])? * scale,
                ],
            });
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
        #[cfg(feature = "cli")]
        eprintln!(
            "Grid: {}x{}x{} = {} voxels ({:.1} MB as f32)",
            dims[0],
            dims[1],
            dims[2],
            total_voxels,
            total_voxels as f64 * 4.0 / 1e6
        );

        // Grow only as values arrive; a truncated file with huge declared
        // dimensions must not allocate its claimed volume up front.
        let mut data = Vec::new();
        let mut data_min = f32::MAX;
        let mut data_max = f32::MIN;
        let mut orbital_tokens = if n_atoms < 0 { 2 } else { 0 };

        // Read all remaining lines and parse float values
        for line_result in buf.lines() {
            let l = line_result?;
            for token in l.split_whitespace() {
                if orbital_tokens == 2 {
                    ensure!(
                        token.parse::<usize>().context("parsing orbital count")? == 1,
                        "Only single-orbital Cube files are supported"
                    );
                    orbital_tokens = 1;
                    continue;
                }
                if orbital_tokens == 1 {
                    token.parse::<i64>().context("parsing orbital ID")?;
                    orbital_tokens = 0;
                    continue;
                }
                ensure!(
                    data.len() < total_voxels,
                    "Unexpected extra volumetric values"
                );
                let val = finite_float(token)? as f32;
                ensure!(
                    val.is_finite(),
                    "Volumetric value exceeds the finite f32 range"
                );
                if val < data_min {
                    data_min = val;
                }
                if val > data_max {
                    data_max = val;
                }
                if data.len() == data.capacity() {
                    data.try_reserve(1).context("Allocating volumetric data")?;
                }
                data.push(val);
            }
        }
        ensure!(orbital_tokens == 0, "Missing single-orbital ID record");

        if data.len() != total_voxels {
            anyhow::bail!("Expected {} voxels but got {}", total_voxels, data.len());
        }

        #[cfg(feature = "cli")]
        eprintln!("Data range: [{:.6e}, {:.6e}]", data_min, data_max);

        Ok(CubeFile {
            header,
            data,
            data_min,
            data_max,
        })
    }

    /// Construct an atom-free grid. Coordinates are already in Angstroms.
    pub fn from_grid(
        dims: [usize; 3],
        origin: [f64; 3],
        voxel_axes: [[f64; 3]; 3],
        data: Vec<f32>,
    ) -> Result<Self> {
        let total = checked_voxels(dims)?;
        ensure!(
            data.len() == total,
            "Expected {total} voxels but got {}",
            data.len()
        );
        ensure!(
            origin
                .iter()
                .chain(voxel_axes.iter().flatten())
                .all(|v| v.is_finite()),
            "Grid coordinates must be finite"
        );
        ensure!(
            data.iter().all(|v| v.is_finite()),
            "Grid values must be finite"
        );
        let data_min = data.iter().copied().fold(f32::INFINITY, f32::min);
        let data_max = data.iter().copied().fold(f32::NEG_INFINITY, f32::max);
        Ok(Self {
            header: CubeHeader {
                comment1: String::new(),
                comment2: String::new(),
                n_atoms: 0,
                origin,
                dims,
                voxel_axes,
                atoms: Vec::new(),
            },
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

    fn fixture(atom_record: &str, orbital_record: &str) -> String {
        format!("comment 1\ncomment 2\n{atom_record}\n2 1.0 0 0\n2 0 1.0 0\n2 0 0 1.0\n6 6.0 3.0 4.0 5.0\n{orbital_record}1.0 2.0 3.0 4.0 5.0 6.0 7.0 8.0\n")
    }

    #[test]
    fn orbital_id_can_wrap_and_never_changes_bohr_units_or_voxel_offset() {
        let ordinary = CubeFile::parse(Cursor::new(fixture("1 1.0 2.0 3.0", ""))).unwrap();
        for record in ["1 17\n", "1\n17\n", "1\n17 "] {
            let orbital = CubeFile::parse(Cursor::new(fixture("-1 1.0 2.0 3.0", record))).unwrap();
            assert_eq!(orbital.header.origin, ordinary.header.origin);
            assert_eq!(orbital.header.voxel_axes, ordinary.header.voxel_axes);
            assert_eq!(
                orbital.header.atoms[0].position,
                ordinary.header.atoms[0].position
            );
            assert_eq!(orbital.header.origin[0], BOHR_TO_ANGSTROM);
            assert_eq!(orbital.data, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);
            assert_eq!((orbital.data_min, orbital.data_max), (1.0, 8.0));
        }
    }

    #[test]
    fn accepts_explicit_single_value_and_fortran_exponents() {
        let text = fixture("1 1.0 2.0 3.0 1", "")
            .replace("1.0", "1.0D+00")
            .replace("2.0", "2.0d+00");
        let cube = CubeFile::parse(Cursor::new(text)).unwrap();
        assert_eq!(cube.header.origin[0], BOHR_TO_ANGSTROM);
        assert_eq!(cube.header.origin[1], 2.0 * BOHR_TO_ANGSTROM);
        assert_eq!(cube.data[0..2], [1.0, 2.0]);
    }

    #[test]
    fn rejects_multiple_datasets_and_missing_orbital_records() {
        for text in [
            fixture("1 1.0 2.0 3.0 2", ""),
            fixture("1 1.0 2.0 3.0 0", ""),
            fixture("-1 1.0 2.0 3.0", "2 17 18\n"),
            fixture("-1 1.0 2.0 3.0", "0\n"),
            fixture("-1 1.0 2.0 3.0", ""),
            fixture("-1 1.0 2.0 3.0", "1 invalid\n"),
        ] {
            assert!(CubeFile::parse(Cursor::new(&text)).is_err(), "{text}");
        }
    }

    #[test]
    fn malformed_headers_and_payloads_return_errors_without_panicking() {
        let ordinary = fixture("1 1.0 2.0 3.0", "");
        let cases = [
            String::new(),
            "comment\n".into(),
            ordinary.replace("1 1.0 2.0 3.0", "1 1.0"),
            ordinary.replace("2 1.0 0 0", "2 1.0 0"),
            ordinary.replace("6 6.0 3.0 4.0 5.0", "6 6.0 3.0"),
            ordinary.replace("2 1.0 0 0", "0 1.0 0 0"),
            ordinary.replace("2 1.0 0 0", "-2 1.0 0 0"),
            ordinary.replace("2 1.0 0 0", &format!("{} 1.0 0 0", usize::MAX)),
            ordinary.replace("1 1.0 2.0 3.0", "1 NaN 2.0 3.0"),
            ordinary.replace("2 1.0 0 0", "2 inf 0 0"),
            ordinary.replace("6 6.0 3.0 4.0 5.0", "6 NaN 3.0 4.0 5.0"),
            ordinary.replace("6 6.0 3.0 4.0 5.0", "6 6.0 inf 4.0 5.0"),
            ordinary.replace("8.0", "NaN"),
            ordinary.replace("8.0", "1e100"),
            ordinary.replace("8.0", ""),
            format!("{ordinary}9.0\n"),
        ];
        for text in cases {
            assert!(CubeFile::parse(Cursor::new(&text)).is_err(), "{text}");
        }
    }

    #[test]
    fn grid_constructor_validates_shape_and_keeps_angstrom_coordinates() {
        let axes = [[1.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 3.0]];
        let cube = CubeFile::from_grid([1, 1, 2], [4.0, 5.0, 6.0], axes, vec![-2.0, 7.0]).unwrap();
        assert_eq!(cube.header.n_atoms, 0);
        assert!(cube.header.atoms.is_empty());
        assert_eq!(cube.grid_to_cart(0.0, 0.0, 1.0), [4.0, 5.0, 9.0]);
        assert_eq!((cube.data_min, cube.data_max), (-2.0, 7.0));
        assert!(CubeFile::from_grid([0, 1, 1], [0.0; 3], axes, vec![]).is_err());
        assert!(CubeFile::from_grid([usize::MAX, 2, 2], [0.0; 3], axes, vec![]).is_err());
        assert!(CubeFile::from_grid([2, 2, 2], [0.0; 3], axes, vec![0.0]).is_err());
        assert!(CubeFile::from_grid([1, 1, 1], [f64::NAN; 3], axes, vec![0.0]).is_err());
        assert!(
            CubeFile::from_grid([1, 1, 1], [0.0; 3], [[f64::INFINITY; 3]; 3], vec![0.0]).is_err()
        );
        assert!(CubeFile::from_grid([1, 1, 1], [0.0; 3], axes, vec![f32::NAN]).is_err());
    }

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

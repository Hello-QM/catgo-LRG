//! VASP CHGCAR / LOCPOT / ELFCAR parser
//!
//! Parses VASP volumetric data files and converts them to the internal
//! CubeFile format (Angstrom units, z-fastest axis order).
//!
//! Supported file types:
//!   - CHGCAR / CHG / PARCHG / AECCAR: rho * V_cell → divided by volume
//!   - LOCPOT: electrostatic potential in eV → used as-is
//!   - ELFCAR: electron localization function (0-1) → used as-is
//!
//! CHGCAR data is stored with x varying fastest (innermost), z slowest.
//! Cube format needs z-fastest, x-slowest. We transpose accordingly.

use anyhow::{bail, Context, Result};
use std::io::{BufRead, BufReader, Read};

use crate::cube::{Atom, CubeFile, CubeHeader, BOHR_TO_ANGSTROM};

const ANGSTROM_TO_BOHR: f64 = 1.0 / BOHR_TO_ANGSTROM;

/// VASP volumetric file type — determines normalization
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum VaspFileType {
    /// CHGCAR / CHG / PARCHG / AECCAR — stores rho * V_cell
    Chgcar,
    /// LOCPOT — stores electrostatic potential in eV
    Locpot,
    /// ELFCAR — stores dimensionless ELF (0-1)
    Elfcar,
}

impl VaspFileType {
    /// Detect file type from filename
    pub fn from_filename(filename: &str) -> Self {
        let upper = filename.to_uppercase();
        if upper.contains("LOCPOT") {
            VaspFileType::Locpot
        } else if upper.contains("ELFCAR") {
            VaspFileType::Elfcar
        } else {
            VaspFileType::Chgcar
        }
    }
}

/// Element symbol → atomic number
fn elem_to_z(symbol: &str) -> i32 {
    match symbol.trim() {
        "H" => 1, "He" => 2, "Li" => 3, "Be" => 4, "B" => 5,
        "C" => 6, "N" => 7, "O" => 8, "F" => 9, "Ne" => 10,
        "Na" => 11, "Mg" => 12, "Al" => 13, "Si" => 14, "P" => 15,
        "S" => 16, "Cl" => 17, "Ar" => 18, "K" => 19, "Ca" => 20,
        "Sc" => 21, "Ti" => 22, "V" => 23, "Cr" => 24, "Mn" => 25,
        "Fe" => 26, "Co" => 27, "Ni" => 28, "Cu" => 29, "Zn" => 30,
        "Ga" => 31, "Ge" => 32, "As" => 33, "Se" => 34, "Br" => 35,
        "Kr" => 36, "Rb" => 37, "Sr" => 38, "Y" => 39, "Zr" => 40,
        "Nb" => 41, "Mo" => 42, "Tc" => 43, "Ru" => 44, "Rh" => 45,
        "Pd" => 46, "Ag" => 47, "Cd" => 48, "In" => 49, "Sn" => 50,
        "Sb" => 51, "Te" => 52, "I" => 53, "Xe" => 54, "Cs" => 55,
        "Ba" => 56, "La" => 57, "Ce" => 58, "Pr" => 59, "Nd" => 60,
        "Pm" => 61, "Sm" => 62, "Eu" => 63, "Gd" => 64, "Tb" => 65,
        "Dy" => 66, "Ho" => 67, "Er" => 68, "Tm" => 69, "Yb" => 70,
        "Lu" => 71, "Hf" => 72, "Ta" => 73, "W" => 74, "Re" => 75,
        "Os" => 76, "Ir" => 77, "Pt" => 78, "Au" => 79, "Hg" => 80,
        "Tl" => 81, "Pb" => 82, "Bi" => 83, _ => 0,
    }
}

/// 3x3 matrix determinant
fn det3(m: &[[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/// Parse a VASP CHGCAR/LOCPOT/ELFCAR file and return a CubeFile.
///
/// The output CubeFile has:
/// - Coordinates in Angstroms (matching cube.rs convention)
/// - Voxel axes = lattice_vector / grid_points (in Angstroms)
/// - Data in cube order: z-fastest, x-slowest
/// - Normalization applied based on file type
pub fn parse_chgcar<R: Read>(reader: R, file_type: VaspFileType) -> Result<CubeFile> {
    let mut buf = BufReader::with_capacity(1 << 20, reader);
    let mut line = String::new();

    // Line 0: comment
    buf.read_line(&mut line)?;
    let comment = line.trim().to_string();
    line.clear();

    // Line 1: scale factor
    buf.read_line(&mut line)?;
    let scale: f64 = line.trim().parse().context("parsing scale factor")?;
    line.clear();

    // Lines 2-4: lattice vectors (Angstrom * scale)
    let mut lattice = [[0.0f64; 3]; 3];
    for row in &mut lattice {
        buf.read_line(&mut line)?;
        let parts: Vec<f64> = line
            .split_whitespace()
            .take(3)
            .map(|s| s.parse::<f64>())
            .collect::<std::result::Result<_, _>>()
            .context("parsing lattice")?;
        if parts.len() < 3 {
            bail!("Lattice row has fewer than 3 values");
        }
        *row = [parts[0] * scale, parts[1] * scale, parts[2] * scale];
        line.clear();
    }

    // Line 5: element symbols (new VASP) or ion counts (old VASP)
    buf.read_line(&mut line)?;
    let line5: Vec<&str> = line.split_whitespace().collect();
    if line5.is_empty() {
        bail!("Line 5 (elements/counts) is empty");
    }

    let (elements, counts) = if line5[0].parse::<u64>().is_ok() {
        // Old VASP: line 5 = counts
        let counts: Vec<usize> = line5
            .iter()
            .map(|s| s.parse::<usize>().context("parsing ion count"))
            .collect::<Result<_>>()?;
        (vec![], counts)
    } else {
        // New VASP: line 5 = symbols, line 6 = counts
        let elements: Vec<String> = line5.iter().map(|s| s.to_string()).collect();
        line.clear();
        buf.read_line(&mut line)?;
        let counts: Vec<usize> = line
            .split_whitespace()
            .map(|s| s.parse::<usize>().context("parsing ion count"))
            .collect::<Result<_>>()?;
        (elements, counts)
    };
    line.clear();

    let total_atoms: usize = counts.iter().sum();

    // Next line: coord type (Direct/Cartesian), or "Selective dynamics"
    buf.read_line(&mut line)?;
    let coord_type_line = line.trim().to_string();
    let is_selective = coord_type_line.to_ascii_lowercase().starts_with('s');
    if is_selective {
        line.clear();
        buf.read_line(&mut line)?;
        // This line is the actual coord type
    }
    let _is_cartesian = line.trim().to_ascii_lowercase().starts_with('c');
    line.clear();

    // Build atomic number list
    let mut atomic_numbers: Vec<i32> = Vec::with_capacity(total_atoms);
    if elements.is_empty() {
        atomic_numbers.extend(std::iter::repeat(0i32).take(total_atoms));
    } else {
        for (idx, &cnt) in counts.iter().enumerate() {
            let z = if idx < elements.len() {
                elem_to_z(&elements[idx])
            } else {
                0
            };
            atomic_numbers.extend(std::iter::repeat(z).take(cnt));
        }
    }

    // Read atom positions (fractional coords)
    let mut atoms = Vec::with_capacity(total_atoms);
    for i in 0..total_atoms {
        buf.read_line(&mut line)?;
        let parts: Vec<f64> = line
            .split_whitespace()
            .take(3)
            .map(|s| s.parse::<f64>())
            .collect::<std::result::Result<_, _>>()
            .with_context(|| format!("parsing atom position {}", i))?;
        if parts.len() < 3 {
            bail!("Atom position {} has fewer than 3 values", i);
        }

        // Fractional → Cartesian (Angstroms)
        let cart = [
            parts[0] * lattice[0][0] + parts[1] * lattice[1][0] + parts[2] * lattice[2][0],
            parts[0] * lattice[0][1] + parts[1] * lattice[1][1] + parts[2] * lattice[2][1],
            parts[0] * lattice[0][2] + parts[1] * lattice[1][2] + parts[2] * lattice[2][2],
        ];

        atoms.push(Atom {
            atomic_number: atomic_numbers[i],
            charge: atomic_numbers[i] as f64,
            position: cart, // already in Angstroms
        });
        line.clear();
    }

    // Skip blank lines to find the grid dimensions line
    loop {
        buf.read_line(&mut line)?;
        if !line.trim().is_empty() {
            break;
        }
        line.clear();
    }

    // Parse NGX NGY NGZ
    let grid_parts: Vec<usize> = line
        .split_whitespace()
        .take(3)
        .map(|s| s.parse::<usize>().context("parsing grid dim"))
        .collect::<Result<_>>()?;
    if grid_parts.len() < 3 {
        bail!("Grid dimensions line has fewer than 3 values");
    }
    let (ngx, ngy, ngz) = (grid_parts[0], grid_parts[1], grid_parts[2]);
    let total_points = ngx * ngy * ngz;
    line.clear();

    eprintln!(
        "CHGCAR grid: {}x{}x{} = {} voxels ({:.1} MB as f32)",
        ngx, ngy, ngz, total_points,
        total_points as f64 * 4.0 / 1e6,
    );

    // Read volumetric data (only first spin block)
    let mut raw_data: Vec<f64> = Vec::with_capacity(total_points);
    for line_result in buf.lines() {
        let l = line_result?;
        let trimmed = l.trim();
        if trimmed.is_empty() {
            if raw_data.len() >= total_points {
                break;
            }
            continue;
        }
        for token in trimmed.split_whitespace() {
            match token.parse::<f64>() {
                Ok(v) => {
                    raw_data.push(v);
                    if raw_data.len() >= total_points {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        if raw_data.len() >= total_points {
            break;
        }
    }

    if raw_data.len() < total_points {
        bail!(
            "Expected {} volumetric data points, got {}",
            total_points,
            raw_data.len(),
        );
    }
    raw_data.truncate(total_points);

    // Compute volume for normalization
    let volume_ang3 = det3(&lattice).abs();

    // Apply normalization based on file type:
    //   CHGCAR: rho*V_cell → rho (divide by volume)
    //   LOCPOT/ELFCAR: use as-is
    if file_type == VaspFileType::Chgcar && volume_ang3 > 1e-10 {
        let inv_vol = 1.0 / volume_ang3;
        for v in &mut raw_data {
            *v *= inv_vol;
        }
    }

    // Reorder from CHGCAR axis order (x-fastest, z-slowest) to cube order (z-fastest, x-slowest)
    //
    // CHGCAR flat index: iz * ngy * ngx + iy * ngx + ix
    // Cube flat index:   ix * ngy * ngz + iy * ngz + iz
    let mut cube_data = vec![0.0f32; total_points];
    let mut data_min = f32::MAX;
    let mut data_max = f32::MIN;

    for ix in 0..ngx {
        for iy in 0..ngy {
            for iz in 0..ngz {
                let chg_idx = iz * ngy * ngx + iy * ngx + ix;
                let cube_idx = ix * ngy * ngz + iy * ngz + iz;
                let val = raw_data[chg_idx] as f32;
                cube_data[cube_idx] = val;
                if val < data_min {
                    data_min = val;
                }
                if val > data_max {
                    data_max = val;
                }
            }
        }
    }

    eprintln!("Data range: [{:.6e}, {:.6e}]", data_min, data_max);

    // Voxel axes = lattice_vector / grid_points (in Angstroms, matching cube.rs)
    let voxel_axes = [
        [
            lattice[0][0] / ngx as f64,
            lattice[0][1] / ngx as f64,
            lattice[0][2] / ngx as f64,
        ],
        [
            lattice[1][0] / ngy as f64,
            lattice[1][1] / ngy as f64,
            lattice[1][2] / ngy as f64,
        ],
        [
            lattice[2][0] / ngz as f64,
            lattice[2][1] / ngz as f64,
            lattice[2][2] / ngz as f64,
        ],
    ];

    Ok(CubeFile {
        header: CubeHeader {
            comment1: comment,
            comment2: format!(
                "Converted from VASP {:?} by CatGO cube-processor",
                file_type
            ),
            n_atoms: total_atoms,
            origin: [0.0, 0.0, 0.0],
            dims: [ngx, ngy, ngz],
            voxel_axes,
            atoms,
        },
        data: cube_data,
        data_min,
        data_max,
    })
}

/// Write a CubeFile to Gaussian cube format text.
///
/// Coordinates are written in Bohr (cube convention).
pub fn write_cube_text(cube: &CubeFile) -> String {
    let h = &cube.header;
    let [nx, ny, nz] = h.dims;
    let total = nx * ny * nz;

    // Pre-allocate
    let cap = 300 + h.n_atoms * 65 + (total / 6 + 1) * 80;
    let mut out = String::with_capacity(cap);

    // Header: 2 comment lines
    out.push_str(&h.comment1);
    out.push('\n');
    out.push_str(&h.comment2);
    out.push('\n');

    // Atom count + origin (in Bohr)
    out.push_str(&format!(
        "{:5}  {:12.6}  {:12.6}  {:12.6}\n",
        h.n_atoms,
        h.origin[0] * ANGSTROM_TO_BOHR,
        h.origin[1] * ANGSTROM_TO_BOHR,
        h.origin[2] * ANGSTROM_TO_BOHR,
    ));

    // Grid dims + voxel axes (in Bohr)
    for i in 0..3 {
        out.push_str(&format!(
            "{:5}  {:12.6}  {:12.6}  {:12.6}\n",
            h.dims[i],
            h.voxel_axes[i][0] * ANGSTROM_TO_BOHR,
            h.voxel_axes[i][1] * ANGSTROM_TO_BOHR,
            h.voxel_axes[i][2] * ANGSTROM_TO_BOHR,
        ));
    }

    // Atom lines (in Bohr)
    for atom in &h.atoms {
        out.push_str(&format!(
            "{:5}  {:12.6}  {:12.6}  {:12.6}  {:12.6}\n",
            atom.atomic_number,
            atom.charge,
            atom.position[0] * ANGSTROM_TO_BOHR,
            atom.position[1] * ANGSTROM_TO_BOHR,
            atom.position[2] * ANGSTROM_TO_BOHR,
        ));
    }

    // Volumetric data: 6 values per line
    let mut col = 0;
    for &val in &cube.data {
        out.push_str(&format!("{:13.5E}", val));
        col += 1;
        if col == 6 {
            out.push('\n');
            col = 0;
        }
    }
    if col > 0 {
        out.push('\n');
    }

    out
}

/// Compute difference charge density from three parsed CubeFiles.
///
/// All three must have been parsed from CHGCAR files with the same grid.
/// Returns a new CubeFile with data = (AB - A - B).
pub fn compute_chgdiff(ab: &CubeFile, a: &CubeFile, b: &CubeFile) -> Result<CubeFile> {
    if ab.header.dims != a.header.dims {
        bail!(
            "Grid mismatch: AB={}x{}x{} vs A={}x{}x{}",
            ab.header.dims[0], ab.header.dims[1], ab.header.dims[2],
            a.header.dims[0], a.header.dims[1], a.header.dims[2],
        );
    }
    if ab.header.dims != b.header.dims {
        bail!(
            "Grid mismatch: AB={}x{}x{} vs B={}x{}x{}",
            ab.header.dims[0], ab.header.dims[1], ab.header.dims[2],
            b.header.dims[0], b.header.dims[1], b.header.dims[2],
        );
    }

    let mut data = Vec::with_capacity(ab.data.len());
    let mut data_min = f32::MAX;
    let mut data_max = f32::MIN;

    for i in 0..ab.data.len() {
        let val = ab.data[i] - a.data[i] - b.data[i];
        data.push(val);
        if val < data_min {
            data_min = val;
        }
        if val > data_max {
            data_max = val;
        }
    }

    Ok(CubeFile {
        header: CubeHeader {
            comment1: "CHGDIFF: difference charge density (AB - A - B)".to_string(),
            comment2: "Computed by CatGO cube-processor".to_string(),
            n_atoms: ab.header.n_atoms,
            origin: ab.header.origin,
            dims: ab.header.dims,
            voxel_axes: ab.header.voxel_axes,
            atoms: ab.header.atoms.clone(),
        },
        data,
        data_min,
        data_max,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn minimal_chgcar() -> &'static str {
        "Comment line\n\
         1.0\n\
         3.0 0.0 0.0\n\
         0.0 3.0 0.0\n\
         0.0 0.0 3.0\n\
         Si\n\
         1\n\
         Direct\n\
         0.0 0.0 0.0\n\
         \n\
         2 2 2\n\
         1.0 2.0 3.0 4.0 5.0 6.0\n\
         7.0 8.0\n"
    }

    #[test]
    fn test_parse_chgcar_basic() {
        let cube = parse_chgcar(Cursor::new(minimal_chgcar()), VaspFileType::Chgcar).unwrap();
        assert_eq!(cube.header.dims, [2, 2, 2]);
        assert_eq!(cube.header.n_atoms, 1);
        assert_eq!(cube.data.len(), 8);
        assert_eq!(cube.header.atoms[0].atomic_number, 14); // Si
    }

    #[test]
    fn test_axis_reorder() {
        // CHGCAR data: iz * ngy * ngx + iy * ngx + ix
        // Values 1-8 stored in CHGCAR order
        let cube = parse_chgcar(Cursor::new(minimal_chgcar()), VaspFileType::Locpot).unwrap();
        // Cube order: ix * ngy * ngz + iy * ngz + iz
        // After reorder, data[0] = CHGCAR[iz=0,iy=0,ix=0] = CHGCAR[0*2*2+0*2+0] = raw[0] = 1.0
        // (with Locpot, no volume normalization)
        assert!((cube.data[0] - 1.0).abs() < 1e-4, "data[0] = {}", cube.data[0]);
    }

    #[test]
    fn test_locpot_no_normalization() {
        let cube_chg = parse_chgcar(Cursor::new(minimal_chgcar()), VaspFileType::Chgcar).unwrap();
        let cube_loc = parse_chgcar(Cursor::new(minimal_chgcar()), VaspFileType::Locpot).unwrap();
        // CHGCAR divides by volume (27 Å³), LOCPOT does not
        // The actual values will differ by factor of volume
        let vol = 27.0f32; // 3x3x3
        assert!(
            (cube_loc.data[0] / cube_chg.data[0] - vol).abs() < 0.1,
            "ratio = {}",
            cube_loc.data[0] / cube_chg.data[0],
        );
    }

    #[test]
    fn test_write_cube_roundtrip() {
        let cube = parse_chgcar(Cursor::new(minimal_chgcar()), VaspFileType::Chgcar).unwrap();
        let text = write_cube_text(&cube);
        // Should be parseable as a cube file
        let reparsed = CubeFile::parse(Cursor::new(text)).unwrap();
        assert_eq!(reparsed.header.dims, [2, 2, 2]);
        assert_eq!(reparsed.header.n_atoms, 1);
    }
}

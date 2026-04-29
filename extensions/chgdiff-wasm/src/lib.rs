//! WASM module for computing VASP difference charge density.
//!
//! Parses three CHGCAR files (AB, A, B) and computes:
//!   CHGDIFF = (ρ_AB − ρ_A − ρ_B) / V_cell
//! Output is Gaussian cube format (Bohr units).

use wasm_bindgen::prelude::*;

const ANGSTROM_TO_BOHR: f64 = 1.0 / 0.529177210903;

#[wasm_bindgen(start)]
pub fn wasm_init() {
    console_error_panic_hook::set_once();
}

// ── Element symbol → atomic number ──────────────────────────────────────────

fn elem_to_z(symbol: &str) -> u32 {
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
        "Tl" => 81, "Pb" => 82, "Bi" => 83, "Po" => 84, "At" => 85,
        "Rn" => 86, "Fr" => 87, "Ra" => 88, "Ac" => 89, "Th" => 90,
        "Pa" => 91, "U" => 92, "Np" => 93, "Pu" => 94, "Am" => 95,
        "Cm" => 96, "Bk" => 97, "Cf" => 98, "Es" => 99, "Fm" => 100,
        "Md" => 101, "No" => 102, "Lr" => 103, "Rf" => 104, "Db" => 105,
        "Sg" => 106, "Bh" => 107, "Hs" => 108, "Mt" => 109, "Ds" => 110,
        "Rg" => 111, "Cn" => 112, "Nh" => 113, "Fl" => 114, "Mc" => 115,
        "Lv" => 116, "Ts" => 117, "Og" => 118,
        _ => 0,
    }
}

// ── CHGCAR parser ────────────────────────────────────────────────────────────

struct ParsedChgcar {
    comment: String,
    lattice: [[f64; 3]; 3],
    atomic_numbers: Vec<u32>,
    positions_cart: Vec<[f64; 3]>,
    ngx: usize,
    ngy: usize,
    ngz: usize,
    data: Vec<f64>,
}

fn parse_f64(s: &str, ctx: &str) -> Result<f64, String> {
    s.parse::<f64>().map_err(|_| format!("Invalid float {s:?} in {ctx}"))
}

fn parse_chgcar(content: &str) -> Result<ParsedChgcar, String> {
    // Collect non-empty line references for positional access.
    // NOTE: We keep a positional index into the original `lines()` iterator
    // so blank lines within the atom-coord block don't shift things.
    let all_lines: Vec<&str> = content.lines().collect();

    if all_lines.len() < 10 {
        return Err("Invalid CHGCAR: too few lines".to_string());
    }

    // Line 0: comment
    let comment = all_lines[0].trim().to_string();

    // Line 1: scale factor
    let scale = parse_f64(all_lines[1].trim(), "scale factor")?;

    // Lines 2–4: lattice vectors (Angstrom × scale)
    let mut lattice = [[0.0f64; 3]; 3];
    for (i, row) in lattice.iter_mut().enumerate() {
        let parts: Vec<f64> = all_lines[2 + i]
            .split_whitespace()
            .take(3)
            .map(|s| parse_f64(s, "lattice"))
            .collect::<Result<_, _>>()?;
        if parts.len() < 3 {
            return Err(format!("Lattice row {} has fewer than 3 values", i + 1));
        }
        *row = [parts[0] * scale, parts[1] * scale, parts[2] * scale];
    }

    // Line 5: element symbols (new VASP) or ion counts (old VASP)
    let line5: Vec<&str> = all_lines[5].split_whitespace().collect();
    if line5.is_empty() {
        return Err("Line 5 (elements/counts) is empty".to_string());
    }

    let (elements, counts, mut coord_start) = if line5[0].parse::<u64>().is_ok() {
        // Old VASP: no element symbols, line 5 = counts, coordinates start at line 7
        let counts: Vec<usize> = line5
            .iter()
            .map(|s| s.parse::<usize>().map_err(|_| format!("Invalid ion count: {s}")))
            .collect::<Result<_, _>>()?;
        (vec![], counts, 7usize)
    } else {
        // New VASP: line 5 = symbols, line 6 = counts, coordinates start at line 8
        let elements: Vec<String> = line5.iter().map(|s| s.to_string()).collect();
        let line6: Vec<&str> = all_lines[6].split_whitespace().collect();
        let counts: Vec<usize> = line6
            .iter()
            .map(|s| s.parse::<usize>().map_err(|_| format!("Invalid ion count: {s}")))
            .collect::<Result<_, _>>()?;
        (elements, counts, 8usize)
    };

    let total_atoms: usize = counts.iter().sum();

    // coord_start points to the coord-type line; check for Selective Dynamics
    let coord_type = all_lines[coord_start - 1].trim();
    if coord_type.to_ascii_lowercase().starts_with('s') {
        coord_start += 1;
    }

    // Build atomic number list
    let mut atomic_numbers: Vec<u32> = Vec::with_capacity(total_atoms);
    if elements.is_empty() {
        atomic_numbers.extend(std::iter::repeat(0u32).take(total_atoms));
    } else {
        for (idx, &cnt) in counts.iter().enumerate() {
            let z = elem_to_z(&elements[idx]);
            atomic_numbers.extend(std::iter::repeat(z).take(cnt));
        }
    }

    // Atom coordinates: fractional → Cartesian
    let mut positions_cart: Vec<[f64; 3]> = Vec::with_capacity(total_atoms);
    for i in 0..total_atoms {
        let li = coord_start + i;
        if li >= all_lines.len() {
            return Err(format!("Missing atom position at line {li}"));
        }
        let p: Vec<f64> = all_lines[li]
            .split_whitespace()
            .take(3)
            .map(|s| parse_f64(s, "atom position"))
            .collect::<Result<_, _>>()?;
        if p.len() < 3 {
            return Err(format!("Atom position line {li} has fewer than 3 values"));
        }
        // frac → cart: cart_j = sum_i p_i * lat_i_j
        let cart = [
            p[0] * lattice[0][0] + p[1] * lattice[1][0] + p[2] * lattice[2][0],
            p[0] * lattice[0][1] + p[1] * lattice[1][1] + p[2] * lattice[2][1],
            p[0] * lattice[0][2] + p[1] * lattice[1][2] + p[2] * lattice[2][2],
        ];
        positions_cart.push(cart);
    }

    // After atom block, skip blank lines to find the NGX NGY NGZ grid line
    let mut grid_li = coord_start + total_atoms;
    while grid_li < all_lines.len() && all_lines[grid_li].trim().is_empty() {
        grid_li += 1;
    }
    if grid_li >= all_lines.len() {
        return Err("No grid dimensions line found after atom positions".to_string());
    }

    let grid_parts: Vec<usize> = all_lines[grid_li]
        .split_whitespace()
        .take(3)
        .map(|s| s.parse::<usize>().map_err(|_| format!("Invalid grid dim: {s}")))
        .collect::<Result<_, _>>()?;
    if grid_parts.len() < 3 {
        return Err("Grid dimensions line has fewer than 3 values".to_string());
    }
    let (ngx, ngy, ngz) = (grid_parts[0], grid_parts[1], grid_parts[2]);
    let total_points = ngx * ngy * ngz;

    // Read volumetric data — only the first block (ignore spin / augmentation)
    let mut data: Vec<f64> = Vec::with_capacity(total_points);
    'read: for li in (grid_li + 1)..all_lines.len() {
        let line = all_lines[li].trim();
        if line.is_empty() {
            if data.len() >= total_points {
                break;
            }
            continue;
        }
        for token in line.split_whitespace() {
            match token.parse::<f64>() {
                Ok(v) => {
                    data.push(v);
                    if data.len() >= total_points {
                        break 'read;
                    }
                }
                Err(_) => break 'read,
            }
        }
    }

    if data.len() < total_points {
        return Err(format!(
            "Expected {total_points} volumetric data points, got {}",
            data.len()
        ));
    }
    data.truncate(total_points);

    Ok(ParsedChgcar {
        comment,
        lattice,
        atomic_numbers,
        positions_cart,
        ngx,
        ngy,
        ngz,
        data,
    })
}

// ── Cube output ──────────────────────────────────────────────────────────────

fn det3(m: &[[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/// Format a float like Python's `{:13.5E}` — 13-char-wide uppercase scientific notation.
/// Most cube readers accept any float format; we match the Python reference output.
fn fmt_e(v: f64) -> String {
    // Rust's {:E} uses 'E+X' (no leading zero on exponent on some platforms).
    // We normalise to at least 2-digit exponent to match Python / Gaussian convention.
    let raw = format!("{:13.5E}", v);
    // Example raw: " 1.23457E2"  →  we want " 1.23457E+02"
    // Find the 'E' and fix the exponent part.
    if let Some(e_pos) = raw.find('E') {
        let mantissa = &raw[..e_pos];
        let exp_str = &raw[e_pos + 1..];
        let sign = if exp_str.starts_with('-') { "-" } else { "+" };
        let digits: &str = exp_str.trim_start_matches(['+', '-'].as_ref());
        let exp_abs: i32 = digits.parse().unwrap_or(0);
        format!("{}E{}{:02}", mantissa, sign, exp_abs)
    } else {
        raw
    }
}

fn chgdiff_to_cube(
    ab: &ParsedChgcar,
    a: &ParsedChgcar,
    b: &ParsedChgcar,
) -> Result<String, String> {
    // Validate that all three grids are identical
    if ab.ngx != a.ngx || ab.ngy != a.ngy || ab.ngz != a.ngz {
        return Err(format!(
            "Grid mismatch: AB={}×{}×{} vs A={}×{}×{}",
            ab.ngx, ab.ngy, ab.ngz,
            a.ngx, a.ngy, a.ngz
        ));
    }
    if ab.ngx != b.ngx || ab.ngy != b.ngy || ab.ngz != b.ngz {
        return Err(format!(
            "Grid mismatch: AB={}×{}×{} vs B={}×{}×{}",
            ab.ngx, ab.ngy, ab.ngz,
            b.ngx, b.ngy, b.ngz
        ));
    }

    let lat = &ab.lattice;
    let volume_ang3 = det3(lat).abs();
    let volume_bohr3 = volume_ang3 * ANGSTROM_TO_BOHR.powi(3);

    let (ngx, ngy, ngz) = (ab.ngx, ab.ngy, ab.ngz);
    let n_atoms = ab.atomic_numbers.len();

    // Voxel vectors in Bohr (lattice_vector / n_grid * ANGSTROM_TO_BOHR)
    let vx = lat[0].map(|x| x / ngx as f64 * ANGSTROM_TO_BOHR);
    let vy = lat[1].map(|x| x / ngy as f64 * ANGSTROM_TO_BOHR);
    let vz = lat[2].map(|x| x / ngz as f64 * ANGSTROM_TO_BOHR);

    let total = ngx * ngy * ngz;
    // Pre-allocate: header ≈ 200 + n_atoms*60 bytes; data ≈ total/6 lines * 80 chars
    let cap = 300 + n_atoms * 65 + (total / 6 + 1) * 80;
    let mut out = String::with_capacity(cap);

    // ── Header ────────────────────────────────────────────────────────────────
    out.push_str(&format!("CHGDIFF: {}\n", ab.comment));
    out.push_str("Difference charge density (AB - A - B) computed by CatGO\n");

    // n_atoms and origin (Bohr)
    out.push_str(&format!("{:5}  {:12.6}  {:12.6}  {:12.6}\n", n_atoms, 0.0f64, 0.0f64, 0.0f64));

    // Grid size + voxel vectors (Bohr)
    out.push_str(&format!("{:5}  {:12.6}  {:12.6}  {:12.6}\n", ngx, vx[0], vx[1], vx[2]));
    out.push_str(&format!("{:5}  {:12.6}  {:12.6}  {:12.6}\n", ngy, vy[0], vy[1], vy[2]));
    out.push_str(&format!("{:5}  {:12.6}  {:12.6}  {:12.6}\n", ngz, vz[0], vz[1], vz[2]));

    // ── Atom lines: Z  Z_float  x  y  z  (Bohr) ──────────────────────────────
    for i in 0..n_atoms {
        let z = ab.atomic_numbers[i];
        let pos = ab.positions_cart[i];
        out.push_str(&format!(
            "{:5}  {:12.6}  {:12.6}  {:12.6}  {:12.6}\n",
            z,
            z as f64,
            pos[0] * ANGSTROM_TO_BOHR,
            pos[1] * ANGSTROM_TO_BOHR,
            pos[2] * ANGSTROM_TO_BOHR,
        ));
    }

    // ── Volumetric data: (ρ_AB − ρ_A − ρ_B) / V_cell ─────────────────────────
    //
    // CHGCAR stores ρ × V_cell (electrons in cell).
    // Cube format stores ρ (electrons per Bohr³).
    // Conversion: cube_val = chgcar_val / volume_bohr3
    //
    // CHGCAR data order: x varies fastest (innermost), z slowest (outermost):
    //   chgcar_index = iz * ngy * ngx + iy * ngx + ix
    // Cube format order: z varies fastest, x slowest:
    //   cube_index = ix * ngy * ngz + iy * ngz + iz
    // We iterate in cube order and look up the CHGCAR index.
    let mut col = 0usize;
    for ix in 0..ngx {
        for iy in 0..ngy {
            for iz in 0..ngz {
                let chg_idx = iz * ngy * ngx + iy * ngx + ix;
                let diff = (ab.data[chg_idx] - a.data[chg_idx] - b.data[chg_idx]) / volume_bohr3;
                out.push_str(&fmt_e(diff));
                col += 1;
                if col == 6 {
                    out.push('\n');
                    col = 0;
                }
            }
        }
    }
    if col > 0 {
        out.push('\n');
    }

    Ok(out)
}

// ── Public WASM API ──────────────────────────────────────────────────────────

/// Compute difference charge density from three CHGCAR file contents.
///
/// Reads CHGCAR_AB, CHGCAR_A, CHGCAR_B as plain text strings and returns
/// a Gaussian cube file string representing ρ_AB − ρ_A − ρ_B (in e/Bohr³).
///
/// Throws a JS error if any file cannot be parsed or if the grids don't match.
#[wasm_bindgen]
pub fn compute_chgdiff(
    content_ab: &str,
    content_a: &str,
    content_b: &str,
) -> Result<String, JsError> {
    let ab = parse_chgcar(content_ab).map_err(|e| JsError::new(&e))?;
    let a = parse_chgcar(content_a).map_err(|e| JsError::new(&e))?;
    let b = parse_chgcar(content_b).map_err(|e| JsError::new(&e))?;
    chgdiff_to_cube(&ab, &a, &b).map_err(|e| JsError::new(&e))
}

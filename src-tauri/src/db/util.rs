//! Utility helpers: element table, linear algebra, blob encoding, path expansion.

use rusqlite::{params, Connection};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Elements periodic table
// ---------------------------------------------------------------------------

pub const ELEMENTS: [&str; 119] = [
    "",   "H",  "He", "Li", "Be", "B",  "C",  "N",  "O",  "F",  "Ne",
    "Na", "Mg", "Al", "Si", "P",  "S",  "Cl", "Ar", "K",  "Ca",
    "Sc", "Ti", "V",  "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
    "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y",  "Zr",
    "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
    "Sb", "Te", "I",  "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
    "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb",
    "Lu", "Hf", "Ta", "W",  "Re", "Os", "Ir", "Pt", "Au", "Hg",
    "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th",
    "Pa", "U",  "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm",
    "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds",
    "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
];

pub fn element_to_z(symbol: &str) -> Option<i32> {
    ELEMENTS
        .iter()
        .position(|&e| e == symbol)
        .map(|i| i as i32)
}

/// Build a Hill-system formula from the species table for a given system id.
pub fn formula_from_species(conn: &Connection, sys_id: i64) -> String {
    let mut stmt = conn
        .prepare("SELECT Z, n FROM species WHERE id = ? ORDER BY Z")
        .unwrap();
    let rows: Vec<(i32, i32)> = stmt
        .query_map(params![sys_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        return String::new();
    }

    // Hill system: C first, H second, then alphabetical
    let mut parts: Vec<(String, i32)> = rows
        .iter()
        .map(|(z, n)| {
            let sym = if (*z as usize) < ELEMENTS.len() {
                ELEMENTS[*z as usize].to_string()
            } else {
                format!("X{z}")
            };
            (sym, *n)
        })
        .collect();

    // Sort Hill: C first, H second, rest alphabetical
    parts.sort_by(|a, b| {
        let order = |s: &str| -> u8 {
            match s {
                "C" => 0,
                "H" => 1,
                _ => 2,
            }
        };
        let oa = order(&a.0);
        let ob = order(&b.0);
        if oa != ob {
            oa.cmp(&ob)
        } else {
            a.0.cmp(&b.0)
        }
    });

    let mut formula = String::new();
    for (sym, n) in &parts {
        formula.push_str(sym);
        if *n > 1 {
            formula.push_str(&n.to_string());
        }
    }
    formula
}

// ---------------------------------------------------------------------------
// Linear algebra helpers (3x3 only)
// ---------------------------------------------------------------------------

pub type Mat3 = [[f64; 3]; 3];

pub fn invert_3x3(m: &Mat3) -> Option<Mat3> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-30 {
        return None;
    }
    let inv_det = 1.0 / det;
    Some([
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det,
        ],
    ])
}

pub fn mat_vec_mul(m: &Mat3, v: &[f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

pub fn cell_params(cell: &Mat3) -> (f64, f64, f64, f64, f64, f64, f64) {
    let a_vec = cell[0];
    let b_vec = cell[1];
    let c_vec = cell[2];
    let a = (a_vec[0] * a_vec[0] + a_vec[1] * a_vec[1] + a_vec[2] * a_vec[2]).sqrt();
    let b = (b_vec[0] * b_vec[0] + b_vec[1] * b_vec[1] + b_vec[2] * b_vec[2]).sqrt();
    let c = (c_vec[0] * c_vec[0] + c_vec[1] * c_vec[1] + c_vec[2] * c_vec[2]).sqrt();

    let dot = |u: &[f64; 3], v: &[f64; 3]| u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let alpha = (dot(&b_vec, &c_vec) / (b * c)).acos().to_degrees();
    let beta = (dot(&a_vec, &c_vec) / (a * c)).acos().to_degrees();
    let gamma = (dot(&a_vec, &b_vec) / (a * b)).acos().to_degrees();

    // Volume = |a . (b x c)|
    let cross = [
        b_vec[1] * c_vec[2] - b_vec[2] * c_vec[1],
        b_vec[2] * c_vec[0] - b_vec[0] * c_vec[2],
        b_vec[0] * c_vec[1] - b_vec[1] * c_vec[0],
    ];
    let volume = dot(&a_vec, &cross).abs();

    (a, b, c, alpha, beta, gamma, volume)
}

// ---------------------------------------------------------------------------
// ASE BLOB helpers
// ---------------------------------------------------------------------------

/// Parse a BLOB of i32 little-endian values (atomic numbers).
pub fn parse_numbers_blob(blob: &[u8]) -> Vec<i32> {
    blob.chunks_exact(4)
        .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Parse a BLOB of f64 little-endian values.
pub fn parse_f64_blob(blob: &[u8]) -> Vec<f64> {
    blob.chunks_exact(8)
        .map(|c| {
            f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])
        })
        .collect()
}

/// Pack a slice of i32 into little-endian bytes.
pub fn pack_i32_blob(vals: &[i32]) -> Vec<u8> {
    vals.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// Pack a slice of f64 into little-endian bytes.
pub fn pack_f64_blob(vals: &[f64]) -> Vec<u8> {
    vals.iter().flat_map(|v| v.to_le_bytes()).collect()
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

pub fn expand_tilde(dir: &str) -> PathBuf {
    if dir.starts_with('~') {
        if let Some(home) = dirs::home_dir() {
            return home.join(dir.strip_prefix("~/").unwrap_or(""));
        }
    }
    let normalized = normalize_windows_drive_path(dir);
    PathBuf::from(normalized)
}

fn normalize_windows_drive_path(path: &str) -> &str {
    if cfg!(windows) {
        let bytes = path.as_bytes();
        if bytes.len() >= 4
            && (bytes[0] == b'/' || bytes[0] == b'\\')
            && bytes[2] == b':'
            && (bytes[3] == b'/' || bytes[3] == b'\\')
            && bytes[1].is_ascii_alphabetic()
        {
            return &path[1..];
        }
    }
    path
}

/// Get a text_key_value for a system row.
pub fn get_text_kv(conn: &Connection, sys_id: i64, key: &str) -> String {
    conn.query_row(
        "SELECT value FROM text_key_values WHERE id = ?1 AND key = ?2",
        params![sys_id, key],
        |r| r.get::<_, String>(0),
    )
    .unwrap_or_default()
}

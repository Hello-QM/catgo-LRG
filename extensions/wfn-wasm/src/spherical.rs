//! Spherical-harmonic → Cartesian conversion of shell coefficients and the
//! Cartesian component orders of .fchk and .molden files.
//!
//! Ported from Multiwfn's gensphcartab (sub.f90), whose tables come from
//! Schlegel & Frisch, IJQC 54, 83 (1995). Spherical functions are ordered
//! 0, +1, -1, +2, -2, …; each table entry is (Cartesian row, spherical
//! column, factor), 1-based as in the Fortran source.

use crate::wavefunction::multiwfn_order;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Convention {
    Fchk,
    Molden,
}

/// Cartesian components of a shell in the order the file lists them.
pub fn cartesian_order(l: u32, conv: Convention) -> Vec<[u32; 3]> {
    match (l, conv) {
        // XXX,YYY,ZZZ,XYY,XXY,XXZ,XZZ,YZZ,YYZ,XYZ (Gaussian and Molden)
        (3, _) => vec![
            [3, 0, 0],
            [0, 3, 0],
            [0, 0, 3],
            [1, 2, 0],
            [2, 1, 0],
            [2, 0, 1],
            [1, 0, 2],
            [0, 1, 2],
            [0, 2, 1],
            [1, 1, 1],
        ],
        // xxxx yyyy zzzz xxxy xxxz yyyx yyyz zzzx zzzy xxyy xxzz yyzz xxyz yyxz zzxy
        (4, Convention::Molden) => vec![
            [4, 0, 0],
            [0, 4, 0],
            [0, 0, 4],
            [3, 1, 0],
            [3, 0, 1],
            [1, 3, 0],
            [0, 3, 1],
            [1, 0, 3],
            [0, 1, 3],
            [2, 2, 0],
            [2, 0, 2],
            [0, 2, 2],
            [2, 1, 1],
            [1, 2, 1],
            [1, 1, 2],
        ],
        _ => multiwfn_order(l),
    }
}

const D: &[(usize, usize, f64)] = &[
    (1, 1, -0.5),
    (2, 1, -0.5),
    (3, 1, 1.0),
    (5, 2, 1.0),
    (6, 3, 1.0),
    (1, 4, 0.866_025_403_784_438_6),
    (2, 4, -0.866_025_403_784_438_6),
    (4, 5, 1.0),
];

fn f_table() -> Vec<(usize, usize, f64)> {
    let s = f64::sqrt;
    vec![
        (3, 1, 1.0),
        (6, 1, -1.5 / s(5.0)),
        (9, 1, -1.5 / s(5.0)),
        (1, 2, -s(3.0 / 8.0)),
        (4, 2, -s(3.0 / 40.0)),
        (7, 2, s(6.0 / 5.0)),
        (2, 3, -s(3.0 / 8.0)),
        (5, 3, -s(3.0 / 40.0)),
        (8, 3, s(6.0 / 5.0)),
        (6, 4, s(3.0) / 2.0),
        (9, 4, -s(3.0) / 2.0),
        (10, 5, 1.0),
        (1, 6, s(5.0 / 8.0)),
        (4, 6, -3.0 / s(8.0)),
        (2, 7, -s(5.0 / 8.0)),
        (5, 7, 3.0 / s(8.0)),
    ]
}

fn g_table(conv: Convention) -> Vec<(usize, usize, f64)> {
    let s = f64::sqrt;
    match conv {
        Convention::Fchk => vec![
            (1, 1, 1.0),
            (3, 1, -3.0 * s(3.0 / 35.0)),
            (5, 1, 3.0 / 8.0),
            (10, 1, -3.0 * s(3.0 / 35.0)),
            (12, 1, 0.75 * s(3.0 / 35.0)),
            (15, 1, 3.0 / 8.0),
            (6, 2, 2.0 * s(5.0 / 14.0)),
            (8, 2, -1.5 / s(14.0)),
            (13, 2, -1.5 * s(5.0 / 14.0)),
            (2, 3, 2.0 * s(5.0 / 14.0)),
            (4, 3, -1.5 * s(5.0 / 14.0)),
            (11, 3, -1.5 / s(14.0)),
            (3, 4, -3.0 * s(3.0 / 28.0)),
            (5, 4, s(5.0) / 4.0),
            (10, 4, 3.0 * s(3.0 / 28.0)),
            (15, 4, -s(5.0) / 4.0),
            (7, 5, 3.0 / s(7.0)),
            (9, 5, -s(5.0 / 28.0)),
            (14, 5, -s(5.0 / 28.0)),
            (8, 6, -3.0 / s(8.0)),
            (13, 6, s(5.0 / 8.0)),
            (4, 7, -s(5.0 / 8.0)),
            (11, 7, 3.0 / s(8.0)),
            (5, 8, s(35.0) / 8.0),
            (12, 8, -0.75 * s(3.0)),
            (15, 8, s(35.0) / 8.0),
            (9, 9, -s(5.0) / 2.0),
            (14, 9, s(5.0) / 2.0),
        ],
        Convention::Molden => vec![
            (3, 1, 1.0),
            (1, 1, 3.0 / 8.0),
            (2, 1, 3.0 / 8.0),
            (11, 1, -3.0 * s(3.0 / 35.0)),
            (12, 1, -3.0 * s(3.0 / 35.0)),
            (10, 1, 0.75 * s(3.0 / 35.0)),
            (8, 2, 2.0 * s(5.0 / 14.0)),
            (5, 2, -1.5 * s(5.0 / 14.0)),
            (14, 2, -1.5 / s(14.0)),
            (9, 3, 2.0 * s(5.0 / 14.0)),
            (7, 3, -1.5 * s(5.0 / 14.0)),
            (13, 3, -1.5 / s(14.0)),
            (11, 4, 3.0 * s(3.0 / 28.0)),
            (12, 4, -3.0 * s(3.0 / 28.0)),
            (1, 4, -s(5.0) / 4.0),
            (2, 4, s(5.0) / 4.0),
            (15, 5, 3.0 / s(7.0)),
            (4, 5, -s(5.0 / 28.0)),
            (6, 5, -s(5.0 / 28.0)),
            (5, 6, s(5.0 / 8.0)),
            (14, 6, -3.0 / s(8.0)),
            (7, 7, -s(5.0 / 8.0)),
            (13, 7, 3.0 / s(8.0)),
            (1, 8, s(35.0) / 8.0),
            (2, 8, s(35.0) / 8.0),
            (10, 8, -0.75 * s(3.0)),
            (4, 9, s(5.0) / 2.0),
            (6, 9, -s(5.0) / 2.0),
        ],
    }
}

fn h_table() -> Vec<(usize, usize, f64)> {
    let s = f64::sqrt;
    vec![
        (1, 1, 1.0),
        (12, 1, -5.0 / s(21.0)),
        (3, 1, -5.0 / s(21.0)),
        (19, 1, 5.0 / 8.0),
        (5, 1, 5.0 / 8.0),
        (14, 1, s(15.0 / 7.0) / 4.0),
        (7, 2, s(5.0 / 3.0)),
        (16, 2, -3.0 * s(5.0 / 28.0)),
        (9, 2, -3.0 / s(28.0)),
        (21, 2, s(15.0) / 8.0),
        (11, 2, s(5.0 / 3.0) / 8.0),
        (18, 2, s(5.0 / 7.0) / 4.0),
        (2, 3, s(5.0 / 3.0)),
        (4, 3, -3.0 * s(5.0 / 28.0)),
        (13, 3, -3.0 / s(28.0)),
        (6, 3, s(15.0) / 8.0),
        (20, 3, s(5.0 / 3.0) / 8.0),
        (15, 3, s(5.0 / 7.0) / 4.0),
        (12, 4, s(5.0) / 2.0),
        (3, 4, -s(5.0) / 2.0),
        (19, 4, -s(35.0 / 3.0) / 4.0),
        (5, 4, s(35.0 / 3.0) / 4.0),
        (8, 5, s(5.0 / 3.0)),
        (17, 5, -s(5.0 / 12.0)),
        (10, 5, -s(5.0 / 12.0)),
        (16, 6, s(5.0 / 6.0)),
        (9, 6, -s(1.5)),
        (21, 6, -s(17.5) / 8.0),
        (11, 6, s(17.5) / 8.0),
        (18, 6, s(5.0 / 6.0) / 4.0),
        (4, 7, -s(5.0 / 6.0)),
        (13, 7, s(1.5)),
        (20, 7, -s(17.5) / 8.0),
        (6, 7, s(17.5) / 8.0),
        (15, 7, -s(5.0 / 6.0) / 4.0),
        (19, 8, s(35.0) / 8.0),
        (5, 8, s(35.0) / 8.0),
        (14, 8, -0.75 * s(3.0)),
        (17, 9, s(5.0) / 2.0),
        (10, 9, -s(5.0) / 2.0),
        (21, 10, 3.0 / 8.0 * s(3.5)),
        (11, 10, 5.0 / 8.0 * s(3.5)),
        (18, 10, -1.25 * s(1.5)),
        (6, 11, 3.0 / 8.0 * s(3.5)),
        (20, 11, 5.0 / 8.0 * s(3.5)),
        (15, 11, -1.25 * s(1.5)),
    ]
}

/// Dense (n_cart × n_sph) conversion matrix, row-major; None for l < 2.
pub fn sph_to_cart(l: u32, conv: Convention) -> Option<Vec<Vec<f64>>> {
    let table = match l {
        2 => D.to_vec(),
        3 => f_table(),
        4 => g_table(conv),
        5 => h_table(),
        _ => return None,
    };
    let n_cart = ((l + 1) * (l + 2) / 2) as usize;
    let n_sph = (2 * l + 1) as usize;
    let mut m = vec![vec![0.0; n_sph]; n_cart];
    for (r, c, v) in table {
        m[r - 1][c - 1] = v;
    }
    Some(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_shapes() {
        for l in 2..=5 {
            for conv in [Convention::Fchk, Convention::Molden] {
                let m = sph_to_cart(l, conv).unwrap();
                assert_eq!(m.len(), cartesian_order(l, conv).len());
                // every spherical function maps to something
                for c in 0..(2 * l + 1) as usize {
                    assert!(m.iter().any(|row| row[c] != 0.0), "l={l} col={c}");
                }
            }
        }
    }
}

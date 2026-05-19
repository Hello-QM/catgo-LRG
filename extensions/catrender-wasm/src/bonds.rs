//! Distance-based bond perception used when no explicit bonds are supplied.

use crate::types::{Atom, Bond};

fn covalent_radius(el: &str) -> f64 {
    match el {
        "H" => 0.31,
        "C" => 0.76,
        "N" => 0.71,
        "O" => 0.66,
        "S" => 1.05,
        "P" => 1.07,
        "F" => 0.57,
        "Cl" => 1.02,
        _ => 0.85,
    }
}

/// Perceive single bonds: pair (i<j) bonded if dist < 1.2·(r_i + r_j).
/// O(n²) — fine for the molecule sizes catrender targets.
pub fn perceive(atoms: &[Atom]) -> Vec<Bond> {
    let mut out = Vec::new();
    for i in 0..atoms.len() {
        for j in (i + 1)..atoms.len() {
            let a = atoms[i].xyz;
            let b = atoms[j].xyz;
            let d2 = (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2);
            let cutoff = 1.2 * (covalent_radius(&atoms[i].el) + covalent_radius(&atoms[j].el));
            if d2 > 1e-6 && d2 < cutoff * cutoff {
                out.push(Bond { i, j, order: 1 });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Atom;

    fn at(el: &str, xyz: [f64; 3]) -> Atom {
        Atom { el: el.into(), xyz }
    }

    #[test]
    fn bonds_close_pair_not_far_pair() {
        let atoms = vec![
            at("C", [0.0, 0.0, 0.0]),
            at("O", [1.2, 0.0, 0.0]),
            at("C", [9.0, 0.0, 0.0]),
        ];
        let b = perceive(&atoms);
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].i, b[0].j), (0, 1));
    }

    #[test]
    fn no_self_bond_no_duplicate() {
        let atoms = vec![at("H", [0.0, 0.0, 0.0]), at("H", [0.74, 0.0, 0.0])];
        let b = perceive(&atoms);
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].i, b[0].j), (0, 1));
    }
}

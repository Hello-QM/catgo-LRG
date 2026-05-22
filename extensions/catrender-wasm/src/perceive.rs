//! OpenBabel-style geometry bond-order perception — Rust port of
//! `OBMol::PerceiveBondOrders` (openbabel master src/mol.cpp:3222). See plan
//! 2026-05-21-catrender-ob-bond-perception.md for deviations (Pass 4 deferred,
//! aromatic→1.5 no-kekulize, smallest-ring SSSR).

/// Covalent radius (Å), max bond valence, and Pauling electronegativity,
/// indexed by atomic number. Verbatim from OpenBabel `src/elementtable.h`
/// columns RCov / MaxBnd / ElNeg. Index 0 is the dummy element.
/// Unknown/out-of-range fall back to OB's documented defaults:
/// covalent 1.6, maxbonds 6, electroneg 0.0.
struct ElemRow {
    cov: f64,
    maxb: u32,
    eneg: f64,
}

// Z = 0..=53 (H..I). Values copied from OB elementtable.h.
static ELEM: &[ElemRow] = &[
    ElemRow { cov: 0.00, maxb: 0, eneg: 0.00 }, // 0 dummy
    ElemRow { cov: 0.31, maxb: 1, eneg: 2.20 }, // 1  H
    ElemRow { cov: 0.28, maxb: 0, eneg: 0.00 }, // 2  He
    ElemRow { cov: 1.28, maxb: 1, eneg: 0.98 }, // 3  Li
    ElemRow { cov: 0.96, maxb: 2, eneg: 1.57 }, // 4  Be
    ElemRow { cov: 0.84, maxb: 4, eneg: 2.04 }, // 5  B
    ElemRow { cov: 0.76, maxb: 4, eneg: 2.55 }, // 6  C
    ElemRow { cov: 0.71, maxb: 4, eneg: 3.04 }, // 7  N
    ElemRow { cov: 0.66, maxb: 2, eneg: 3.44 }, // 8  O
    ElemRow { cov: 0.57, maxb: 1, eneg: 3.98 }, // 9  F
    ElemRow { cov: 0.58, maxb: 0, eneg: 0.00 }, // 10 Ne
    ElemRow { cov: 1.66, maxb: 1, eneg: 0.93 }, // 11 Na
    ElemRow { cov: 1.41, maxb: 2, eneg: 1.31 }, // 12 Mg
    ElemRow { cov: 1.21, maxb: 6, eneg: 1.61 }, // 13 Al
    ElemRow { cov: 1.11, maxb: 6, eneg: 1.90 }, // 14 Si
    ElemRow { cov: 1.07, maxb: 6, eneg: 2.19 }, // 15 P
    ElemRow { cov: 1.05, maxb: 6, eneg: 2.58 }, // 16 S
    ElemRow { cov: 1.02, maxb: 1, eneg: 3.16 }, // 17 Cl
    ElemRow { cov: 1.06, maxb: 0, eneg: 0.00 }, // 18 Ar
    ElemRow { cov: 2.03, maxb: 1, eneg: 0.82 }, // 19 K
    ElemRow { cov: 1.76, maxb: 2, eneg: 1.00 }, // 20 Ca
    ElemRow { cov: 1.70, maxb: 6, eneg: 1.36 }, // 21 Sc
    ElemRow { cov: 1.60, maxb: 6, eneg: 1.54 }, // 22 Ti
    ElemRow { cov: 1.53, maxb: 6, eneg: 1.63 }, // 23 V
    ElemRow { cov: 1.39, maxb: 6, eneg: 1.66 }, // 24 Cr
    ElemRow { cov: 1.39, maxb: 8, eneg: 1.55 }, // 25 Mn
    ElemRow { cov: 1.32, maxb: 6, eneg: 1.83 }, // 26 Fe
    ElemRow { cov: 1.26, maxb: 6, eneg: 1.88 }, // 27 Co
    ElemRow { cov: 1.24, maxb: 6, eneg: 1.91 }, // 28 Ni
    ElemRow { cov: 1.32, maxb: 6, eneg: 1.90 }, // 29 Cu
    ElemRow { cov: 1.22, maxb: 6, eneg: 1.65 }, // 30 Zn
    ElemRow { cov: 1.22, maxb: 3, eneg: 1.81 }, // 31 Ga
    ElemRow { cov: 1.20, maxb: 4, eneg: 2.01 }, // 32 Ge
    ElemRow { cov: 1.19, maxb: 3, eneg: 2.18 }, // 33 As
    ElemRow { cov: 1.20, maxb: 2, eneg: 2.55 }, // 34 Se
    ElemRow { cov: 1.20, maxb: 1, eneg: 2.96 }, // 35 Br
    ElemRow { cov: 1.16, maxb: 0, eneg: 3.00 }, // 36 Kr
    ElemRow { cov: 2.20, maxb: 1, eneg: 0.82 }, // 37 Rb
    ElemRow { cov: 1.95, maxb: 2, eneg: 0.95 }, // 38 Sr
    ElemRow { cov: 1.90, maxb: 6, eneg: 1.22 }, // 39 Y
    ElemRow { cov: 1.75, maxb: 6, eneg: 1.33 }, // 40 Zr
    ElemRow { cov: 1.64, maxb: 6, eneg: 1.60 }, // 41 Nb
    ElemRow { cov: 1.54, maxb: 6, eneg: 2.16 }, // 42 Mo
    ElemRow { cov: 1.47, maxb: 6, eneg: 1.90 }, // 43 Tc
    ElemRow { cov: 1.46, maxb: 6, eneg: 2.20 }, // 44 Ru
    ElemRow { cov: 1.42, maxb: 6, eneg: 2.28 }, // 45 Rh
    ElemRow { cov: 1.39, maxb: 6, eneg: 2.20 }, // 46 Pd
    ElemRow { cov: 1.45, maxb: 6, eneg: 1.93 }, // 47 Ag
    ElemRow { cov: 1.44, maxb: 6, eneg: 1.69 }, // 48 Cd
    ElemRow { cov: 1.42, maxb: 3, eneg: 1.78 }, // 49 In
    ElemRow { cov: 1.39, maxb: 4, eneg: 1.96 }, // 50 Sn
    ElemRow { cov: 1.39, maxb: 3, eneg: 2.05 }, // 51 Sb
    ElemRow { cov: 1.38, maxb: 2, eneg: 2.10 }, // 52 Te
    ElemRow { cov: 1.39, maxb: 1, eneg: 2.66 }, // 53 I
];

fn row(z: u32) -> &'static ElemRow {
    ELEM.get(z as usize).unwrap_or(&ElemRow { cov: 1.6, maxb: 6, eneg: 0.0 })
}

/// OB `OBElements::GetCovalentRad`.
pub(crate) fn covalent_rad(z: u32) -> f64 {
    row(z).cov
}

/// OB `OBElements::GetMaxBonds` (maximum bond valence).
pub(crate) fn max_bonds(z: u32) -> u32 {
    row(z).maxb
}

/// OB `OBElements::GetElectroNeg` (Pauling).
pub(crate) fn electroneg(z: u32) -> f64 {
    row(z).eneg
}

/// OB `CorrectedBondRad(elem, hyb)` — atom.cpp:1167.
pub(crate) fn corrected_bond_rad(z: u32, hyb: u32) -> f64 {
    let rad = covalent_rad(z);
    match hyb {
        2 => rad * 0.95,
        1 => rad * 0.90,
        _ => rad,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn element_table_known_values() {
        assert_eq!(covalent_rad(6), 0.76); // C
        assert_eq!(max_bonds(6), 4); // C
        assert_eq!(electroneg(6), 2.55); // C
        assert_eq!(max_bonds(8), 2); // O
        assert_eq!(electroneg(8), 3.44); // O
        assert_eq!(max_bonds(7), 4); // N
    }

    #[test]
    fn element_table_unknown_fallback() {
        assert_eq!(covalent_rad(200), 1.6);
        assert_eq!(max_bonds(200), 6);
        assert_eq!(electroneg(200), 0.0);
    }

    #[test]
    fn corrected_bond_rad_hyb_scaling() {
        assert_eq!(corrected_bond_rad(6, 3), 0.76);
        assert!((corrected_bond_rad(6, 2) - 0.76 * 0.95).abs() < 1e-12);
        assert!((corrected_bond_rad(6, 1) - 0.76 * 0.90).abs() < 1e-12);
    }
}

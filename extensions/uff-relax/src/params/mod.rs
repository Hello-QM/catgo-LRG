pub mod data;

use crate::atom::UffAtomType;
use data::UFF_DATA;

/// UFF Parameters for a specific atom type.
#[derive(Debug, Clone, Copy)]
pub struct UffParams {
    pub r1: f64,      // Valence bond radius (Angstroms)
    pub theta0: f64,  // Valence angle (Degrees)
    pub x1: f64,      // vdW distance (Angstroms)
    pub d1: f64,      // vdW energy (kcal/mol)
    pub zeta: f64,    // vdW scale term
    pub z_star: f64,  // Effective charge
    pub chi: f64,     // Electronegativity (Paulings)
    pub u_i: f64,     // Torsional barrier parameter (kcal/mol)
}

/// Returns UFF parameters for a given atom type label.
pub fn get_uff_params(atom_type: &UffAtomType) -> Option<UffParams> {
    let label = atom_type.as_str();
    
    UFF_DATA.iter()
        .find(|&&(id, ..)| id == label || (id.ends_with('_') && label.starts_with(id)))
        .map(|&(_, r1, theta0, x1, d1, zeta, z_star, chi, u_i)| UffParams {
            r1, theta0, x1, d1, zeta, z_star, chi, u_i,
        })
}

/// Helper to get the element symbol from atomic number (Z).
pub fn element_symbol(z: usize) -> &'static str {
    let symbols = [
        "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
        "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
        "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
        "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
        "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
        "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
        "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb",
        "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
        "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th",
        "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm",
        "Md", "No", "Lr",
    ];
    if z > 0 && z <= symbols.len() {
        symbols[z - 1]
    } else {
        "X"
    }
}

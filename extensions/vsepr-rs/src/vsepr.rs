use crate::traits::{get_valence_electrons, AtomTrait, BondTrait};

/// Standard VSEPR geometries based on Steric Numbers (SN).
#[derive(Debug, Clone, Copy)]
pub enum Geometry {
    Linear,                // SN=2
    TrigonalPlanar,        // SN=3
    Tetrahedral,           // SN=4
    TrigonalBipyramidal,   // SN=5
    Octahedral,            // SN=6
    PentagonalBipyramidal, // SN=7
}

impl Geometry {
    /// Determines the geometry based on the Steric Number.
    pub fn from_steric_number(sn: usize) -> Self {
        match sn {
            0..=2 => Geometry::Linear,
            3 => Geometry::TrigonalPlanar,
            4 => Geometry::Tetrahedral,
            5 => Geometry::TrigonalBipyramidal,
            6 => Geometry::Octahedral,
            _ => Geometry::PentagonalBipyramidal,
        }
    }

    /// Returns the ideal bond angle in radians.
    pub fn ideal_angle(&self) -> f64 {
        match self {
            Geometry::Linear => std::f64::consts::PI,
            Geometry::TrigonalPlanar => 2.0 * std::f64::consts::PI / 3.0,
            Geometry::Tetrahedral => (109.4712_f64).to_radians(),
            Geometry::TrigonalBipyramidal => (90.0_f64).to_radians(),
            Geometry::Octahedral => std::f64::consts::PI / 2.0,
            Geometry::PentagonalBipyramidal => (72.0_f64).to_radians(),
        }
    }
}

/// Calculates the Steric Number (SN) using valence electrons and bond topology.
/// SN = (Bonded Atoms) + (Lone Pairs)
pub fn calculate_steric_number<A: AtomTrait, B: BondTrait>(
    atom_idx: usize,
    atoms: &[A],
    bonds: &[B],
) -> usize {
    let atom = &atoms[atom_idx];
    let valence_electrons = get_valence_electrons(atom.atomic_number());
    let charge = atom.formal_charge();

    let mut bonded_atoms_count = 0;
    let mut electron_sum = 0.0;

    for bond in bonds {
        let (i, j) = bond.get_atom_indices();
        if i == atom_idx || j == atom_idx {
            bonded_atoms_count += 1;
            electron_sum += bond.get_bond_order() as f64;
        }
    }

    let lone_pairs = ((valence_electrons as i32 - charge) as f64 - electron_sum).max(0.0) / 2.0;
    bonded_atoms_count + (lone_pairs.round() as usize)
}

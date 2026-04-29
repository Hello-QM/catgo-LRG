use glam::DVec3;
use serde::{Deserialize, Serialize};

/// Represents an atom type label in UFF (e.g., "C_3", "N_R").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UffAtomType(pub String);

impl UffAtomType {
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn unknown() -> Self {
        Self("Unknown".to_string())
    }
}

/// Represents an individual atom in the system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Atom {
    /// Atomic number (e.g., 1 for H, 6 for C).
    pub element: usize,
    /// Position in Cartesian coordinates (Å).
    pub position: DVec3,
    /// Current force acting on the atom (kcal/mol/Å).
    pub force: DVec3,
    /// Internal UFF atom type label (assigned automatically).
    pub uff_type: UffAtomType,
}

impl Atom {
    /// Creates a new atom with the given atomic number and position.
    pub fn new(element: usize, position: DVec3) -> Self {
        Self {
            element,
            position,
            force: DVec3::ZERO,
            uff_type: UffAtomType::unknown(),
        }
    }
}

/// Represents a chemical bond between two atoms.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bond {
    /// Indices of the two atoms in the `System::atoms` vector.
    pub atom_indices: (usize, usize),
    /// Bond order (1.0 for single, 1.5 for aromatic, 2.0 for double).
    pub order: f32,
}
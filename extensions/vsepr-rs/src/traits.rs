/// Trait to interface with the user's atom data structure.
pub trait AtomTrait {
    /// Returns the current 3D coordinates [x, y, z].
    fn get_position(&self) -> [f64; 3];
    /// Updates the 3D coordinates [x, y, z].
    fn set_position(&mut self, pos: [f64; 3]);
    /// Returns the atomic number (e.g., H=1, C=6).
    fn atomic_number(&self) -> usize;
    /// Returns the formal charge (default is 0).
    fn formal_charge(&self) -> i32 {
        0
    }
}

/// Trait to interface with the user's bond data structure.
pub trait BondTrait {
    /// Returns the indices of the two atoms connected by this bond.
    fn get_atom_indices(&self) -> (usize, usize);
    /// Returns the bond order (1.0 for single, 2.0 for double, etc.).
    fn get_bond_order(&self) -> f32;
}

/// Estimates the number of valence electrons for main group elements.
pub fn get_valence_electrons(atomic_number: usize) -> usize {
    match atomic_number {
        1 => 1,     // H
        2 => 2,     // He
        3..=10 => { // Li - Ne
            let v = atomic_number - 2;
            if v > 8 { 8 } else { v }
        }
        11..=18 => { // Na - Ar
            let v = atomic_number - 10;
            if v > 8 { 8 } else { v }
        }
        19..=36 => { // K - Kr
            let v = atomic_number - 18;
            if v > 8 { 8 } else { v }
        }
        _ => 8, // Approximate 8 for heavier or unknown elements.
    }
}

/// Returns the standard covalent radius (pm) for an element.
pub fn get_covalent_radius(atomic_number: usize) -> f64 {
    match atomic_number {
        1 => 31.0,   // H
        2 => 28.0,   // He
        3 => 128.0,  // Li
        4 => 96.0,   // Be
        5 => 84.0,   // B
        6 => 76.0,   // C
        7 => 71.0,   // N
        8 => 66.0,   // O
        9 => 57.0,   // F
        14 => 111.0, // Si
        15 => 107.0, // P
        16 => 105.0, // S
        17 => 102.0, // Cl
        35 => 120.0, // Br
        50 => 140.0, // Sn
        53 => 139.0, // I
        82 => 146.0, // Pb
        _ => 150.0,  // Default for heavy elements.
    }
}
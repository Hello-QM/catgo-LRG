//! vsepr-rs: A lightweight, high-performance molecular geometry optimizer.
//!
//! This crate provides a generic engine to refine 3D molecular coordinates 
//! based on VSEPR (Valence Shell Electron Pair Repulsion) theory.
//! 
//! It is designed as a **scaffolder** or **pre-optimizer**: it quickly transforms
//! raw or overlapping coordinates into a chemically sensible 3D structure that can then
//! be passed to more rigorous force fields like UFF (Universal Force Field).
//!
//! # Example
//! ```
//! use vsepr_rs::{VseprOptimizer, AtomTrait, BondTrait};
//!
//! struct MyAtom { pos: [f64; 3], element: usize }
//! impl AtomTrait for MyAtom {
//!     fn get_position(&self) -> [f64; 3] { self.pos }
//!     fn set_position(&mut self, pos: [f64; 3]) { self.pos = pos; }
//!     fn atomic_number(&self) -> usize { self.element }
//! }
//!
//! struct MyBond { pair: (usize, usize) }
//! impl BondTrait for MyBond {
//!     fn get_atom_indices(&self) -> (usize, usize) { self.pair }
//!     fn get_bond_order(&self) -> f32 { 1.0 }
//! }
//!
//! let mut atoms = vec![
//!     MyAtom { pos: [0.0, 0.0, 0.0], element: 6 }, // C
//!     MyAtom { pos: [0.1, 0.0, 0.0], element: 1 }, // H
//!     MyAtom { pos: [0.0, 0.1, 0.0], element: 1 }, // H
//!     MyAtom { pos: [0.0, 0.0, 0.1], element: 1 }, // H
//!     MyAtom { pos: [-0.1, 0.0, 0.0], element: 1 }, // H
//! ];
//! let bonds = vec![
//!     MyBond { pair: (0, 1) }, MyBond { pair: (0, 2) },
//!     MyBond { pair: (0, 3) }, MyBond { pair: (0, 4) },
//! ];
//!
//! let optimizer = VseprOptimizer::default();
//! optimizer.optimize(&mut atoms, &bonds);
//! ```

pub mod forcefield;
pub mod math;
pub mod optimizer;
pub mod traits;
pub mod vsepr;

pub use math::Vec3;
pub use optimizer::VseprOptimizer;
pub use traits::{get_covalent_radius, AtomTrait, BondTrait};
pub use vsepr::{calculate_steric_number, Geometry};

#[cfg(test)]
mod tests {
    use super::*;

    struct MyAtom {
        pos: [f64; 3],
        element: usize,
    }

    impl AtomTrait for MyAtom {
        fn get_position(&self) -> [f64; 3] { self.pos }
        fn set_position(&mut self, pos: [f64; 3]) { self.pos = pos; }
        fn atomic_number(&self) -> usize { self.element }
    }

    struct MyBond {
        pair: (usize, usize),
        order: f32,
    }

    impl BondTrait for MyBond {
        fn get_atom_indices(&self) -> (usize, usize) { self.pair }
        fn get_bond_order(&self) -> f32 { self.order }
    }

    #[test]
    fn test_methane_tetrahedral() {
        let mut atoms = vec![
            MyAtom { pos: [0.0, 0.0, 0.0], element: 6 }, // C
            MyAtom { pos: [0.0, 0.0, 0.0], element: 1 }, // H
            MyAtom { pos: [0.0, 0.0, 0.0], element: 1 }, // H
            MyAtom { pos: [0.0, 0.0, 0.0], element: 1 }, // H
            MyAtom { pos: [0.0, 0.0, 0.0], element: 1 }, // H
        ];
        let bonds = vec![
            MyBond { pair: (0, 1), order: 1.0 },
            MyBond { pair: (0, 2), order: 1.0 },
            MyBond { pair: (0, 3), order: 1.0 },
            MyBond { pair: (0, 4), order: 1.0 },
        ];

        let optimizer = VseprOptimizer::default();
        optimizer.optimize(&mut atoms, &bonds);

        // Check C-H distance (~1.09 A)
        for i in 1..5 {
            let dist = Vec3::from(atoms[0].pos).dist(Vec3::from(atoms[i].pos));
            assert!((dist - 1.09).abs() < 0.1, "C-H bond length too far from ideal: {}", dist);
        }

        // Check H-C-H angle (ideal ~109.5 deg)
        let v1 = Vec3::from(atoms[1].pos).sub(Vec3::from(atoms[0].pos));
        let v2 = Vec3::from(atoms[2].pos).sub(Vec3::from(atoms[0].pos));
        let angle = v1.angle(v2).to_degrees();
        assert!((angle - 109.5).abs() < 5.0, "H-C-H angle too far from ideal: {}", angle);
    }

    #[test]
    fn test_water_bent() {
        let mut atoms = vec![
            MyAtom { pos: [0.0, 0.0, 0.0], element: 8 }, // O
            MyAtom { pos: [0.0, 0.0, 0.0], element: 1 }, // H
            MyAtom { pos: [0.0, 0.0, 0.0], element: 1 }, // H
        ];
        let bonds = vec![
            MyBond { pair: (0, 1), order: 1.0 },
            MyBond { pair: (0, 2), order: 1.0 },
        ];

        let optimizer = VseprOptimizer::default();
        optimizer.optimize(&mut atoms, &bonds);

        // O-H distance (~0.96 A)
        let dist = Vec3::from(atoms[0].pos).dist(Vec3::from(atoms[1].pos));
        assert!((dist - 0.96).abs() < 0.1);

        // H-O-H angle (VSEPR SN=4, ideal ~109.5, actual ~104.5)
        // Our simplified model targets the geometry's ideal angle (109.5 for SN=4).
        let v1 = Vec3::from(atoms[1].pos).sub(Vec3::from(atoms[0].pos));
        let v2 = Vec3::from(atoms[2].pos).sub(Vec3::from(atoms[0].pos));
        let angle = v1.angle(v2).to_degrees();
        assert!((angle - 109.5).abs() < 5.0, "H-O-H angle check failed: {}", angle);
    }

    #[test]
    fn test_benzene_from_origin() {
        let mut atoms = Vec::new();
        for _ in 0..6 {
            atoms.push(MyAtom { pos: [0.0, 0.0, 0.0], element: 6 });
        }
        for _ in 0..6 {
             atoms.push(MyAtom { pos: [0.0, 0.0, 0.0], element: 1 });
        }
        run_benzene_check(atoms, "Origin Initialization");
    }

    fn run_benzene_check(mut atoms: Vec<MyAtom>, test_name: &str) {
        let mut bonds = Vec::new();
        for i in 0..6 {
            bonds.push(MyBond { pair: (i, (i + 1) % 6), order: 1.5 });
        }
        for i in 0..6 {
            bonds.push(MyBond { pair: (i, 6 + i), order: 1.0 });
        }

        let optimizer = VseprOptimizer { iterations: 3000, force_constant: 0.1 };
        optimizer.optimize(&mut atoms, &bonds);

        println!("--- {} ---", test_name);
        let p1 = Vec3::from(atoms[0].pos);
        let p2 = Vec3::from(atoms[1].pos);
        let dist = p1.dist(p2);
        println!("C-C dist: {:.3}", dist);
        assert!((dist - 1.40).abs() < 0.15, "Bond length check failed");
    }
}

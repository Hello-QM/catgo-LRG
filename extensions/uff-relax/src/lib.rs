//! # uff-relax
//!
//! `uff-relax` is a fast, parallelized molecular structure optimizer using the 
//! Universal Force Field (UFF) and the FIRE (Fast Iterative Relaxation Engine) algorithm.
//!
//! ## Features
//! - **Fast**: Optimized force calculations with spatial partitioning (Cell Lists).
//! - **Parallel**: Automatic multi-threading using Rayon for large systems.
//! - **Flexible**: Supports periodic boundary conditions (Orthorhombic and Triclinic).
//! - **Easy to use**: Simple API for defining atoms, bonds, and running optimizations.
//!
//! ## Quick Start
//!
//! ```rust
//! use uff_relax::{System, Atom, Bond, UnitCell, UffOptimizer};
//! use glam::DVec3;
//!
//! // Define atoms
//! let atoms = vec![
//!     Atom::new(6, DVec3::new(0.0, 0.0, 0.0)),
//!     Atom::new(6, DVec3::new(1.5, 0.0, 0.0)),
//! ];
//! // Define bonds
//! let bonds = vec![Bond { atom_indices: (0, 1), order: 1.0 }];
//! // Setup system
//! let mut system = System::new(atoms, bonds, UnitCell::new_none());
//! // Optimize
//! UffOptimizer::new(100, 1e-2).optimize(&mut system);
//! ```

pub mod atom;
pub mod cell;
pub mod forcefield;
pub mod math;
pub mod optimizer;
pub mod params;
pub mod spatial;

pub use atom::{Atom, Bond, UffAtomType};
pub use cell::{UnitCell, CellType};
pub use forcefield::{System, EnergyTerms};
pub use optimizer::{UffOptimizer, OptimizeResult, StepRecord};
pub use params::{get_uff_params, element_symbol};

#[cfg(feature = "parallel")]
use std::sync::Once;
#[cfg(feature = "parallel")]
static START: Once = Once::new();

/// Initializes the Rayon thread pool.
/// If `num_threads` is Some(n), it sets that specific number.
/// If `num_threads` is None, it checks `RAYON_NUM_THREADS` env var or defaults to 4.
#[cfg(feature = "parallel")]
pub fn init_parallelism(num_threads: Option<usize>) {
    let threads = match num_threads {
        Some(n) => n,
        None => std::env::var("RAYON_NUM_THREADS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(4),
    };

    START.call_once(|| {
        let _ = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build_global();
    });
}
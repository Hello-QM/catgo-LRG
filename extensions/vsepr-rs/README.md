# vsepr-rs

A lightweight, high-performance molecular geometry optimizer based on **VSEPR (Valence Shell Electron Pair Repulsion)** theory.

`vsepr-rs` is designed as a **scaffolder** or **pre-optimizer**. It quickly transforms raw or overlapping coordinates into a chemically sensible 3D structure that can then be passed to more rigorous force fields like UFF (Universal Force Field) for final refinement.

## Features

- **VSEPR-Based Reasoning:** Automatically determines ideal bond angles and local geometries based on Steric Numbers (SN), considering valence electrons, bond orders, and formal charges.
- **Generic Interface:** Uses traits (`AtomTrait`, `BondTrait`) allowing you to optimize your own data structures directly without conversion.
- **Robust Initialization:** Includes deterministic jitter to break symmetry, enabling reliable convergence even from origin-stacked or perfectly linear starting coordinates.
- **Physics-Aware Refinement:**
    - Corrects bond lengths based on bond order and covalent radii.
    - Maintains local planarity for sp2 centers.
    - Includes dihedral (1-4 torsion) constraints for aromatic systems.
    - Prevents steric clashing with non-bonded repulsion.
- **Zero Dependency:** Built purely on the Rust standard library for maximum portability and fast compilation.

## Installation

```bash
cargo add vsepr-rs
```

Or add this to your `Cargo.toml`:

```toml
[dependencies]
vsepr-rs = "1.0.0"
```

## Quick Start

Implement `AtomTrait` and `BondTrait` for your structures and run the optimizer.

```rust
use vsepr_rs::{VseprOptimizer, AtomTrait, BondTrait};

#[derive(Debug)]
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

fn main() {
    // Water molecule: O-H, O-H
    let mut atoms = vec![
        MyAtom { pos: [0.0, 0.0, 0.0], element: 8 }, // Oxygen
        MyAtom { pos: [0.0, 0.0, 0.0], element: 1 }, // Hydrogen
        MyAtom { pos: [0.0, 0.0, 0.0], element: 1 }, // Hydrogen
    ];
    let bonds = vec![
        MyBond { pair: (0, 1), order: 1.0 },
        MyBond { pair: (0, 2), order: 1.0 },
    ];

    let optimizer = VseprOptimizer::new();
    optimizer.optimize(&mut atoms, &bonds);

    for (i, atom) in atoms.iter().enumerate() {
        println!("Atom {}: {:?} pos: {:?}", i, atom.element, atom.pos);
    }
}
```

## Testing Your Implementation

If you are implementing custom traits, you can verify your integration by checking if the distances between atoms after optimization approach their covalent sums. 

```rust
#[test]
fn test_integration() {
    // 1. Setup your atoms/bonds
    // 2. Run optimizer.optimize(&mut atoms, &bonds)
    // 3. Assert distance between atoms is reasonable
}
```

## How it Works

1. **Topology Analysis:** Builds an adjacency list and calculates VSEPR geometries for each center.
2. **Deterministic Jitter:** Adds a small, reproducible offset to coordinates to break symmetry traps.
3. **Iterative Relaxation:** Applies a lightweight force field including bond springs, VSEPR angle springs, planarity forces, and non-bonded repulsion until the structure settles.

## License

MIT or Apache-2.0

## Author

**Forblaze Project**  
Website: [https://forblaze-works.com/](https://forblaze-works.com/)
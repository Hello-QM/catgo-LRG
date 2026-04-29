use crate::forcefield::*;
use crate::math::Vec3;
use crate::traits::{AtomTrait, BondTrait};
use crate::vsepr::{calculate_steric_number, Geometry};

/// Main configuration for the molecular geometry optimizer.
pub struct VseprOptimizer {
    /// Number of optimization iterations. Default is 1500.
    pub iterations: usize,
    /// Movement scaling factor for each step. Default is 0.15.
    pub force_constant: f64,
}

impl Default for VseprOptimizer {
    fn default() -> Self {
        Self {
            iterations: 1500,
            force_constant: 0.15,
        }
    }
}

impl VseprOptimizer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Refines the molecular geometry based on VSEPR theory and basic force field constraints.
    pub fn optimize<A: AtomTrait, B: BondTrait>(&self, atoms: &mut [A], bonds: &[B]) {
        let n = atoms.len();
        if n == 0 { return; }

        // 1. Setup: Adjacency list for fast neighbor lookups.
        let mut adj = vec![Vec::new(); n];
        for (idx, bond) in bonds.iter().enumerate() {
            let (i, j) = bond.get_atom_indices();
            if i < n && j < n {
                adj[i].push((j, idx));
                adj[j].push((i, idx));
            }
        }

        // 2. Initialization: Extract coordinates and apply deterministic jitter.
        let mut positions: Vec<Vec3> = atoms
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let p = Vec3::from(a.get_position());
                // Deterministic jitter based on index to break perfect symmetry (e.g. linear chains).
                let noise_scale = 0.01;
                let dx = ((i * 1337) % 100) as f64 / 100.0 - 0.5;
                let dy = ((i * 7331) % 100) as f64 / 100.0 - 0.5;
                let dz = ((i * 9973) % 100) as f64 / 100.0 - 0.5;
                p.add(Vec3(dx, dy, dz).mul(noise_scale))
            })
            .collect();

        // 3. Topology Jitter: Extra spread for overlapping atoms at the origin.
        for i in 0..n {
            if positions[i].length_squared() < 0.001 {
                positions[i] = Vec3(
                    (i as f64 * 1.1).cos() * 1.0,
                    (i as f64 * 1.3).sin() * 1.0,
                    (i as f64 * 1.7).cos() * 1.0,
                );
            }
        }

        // 4. Pre-calculation: VSEPR geometries based on steric numbers.
        let geometries: Vec<Geometry> = (0..n)
            .map(|i| Geometry::from_steric_number(calculate_steric_number(i, atoms, bonds)))
            .collect();

        // 5. Optimization Loop: Iterative refinement of coordinates.
        for iter in 0..self.iterations {
            let mut forces = vec![Vec3::ZERO; n];
            // Exponential damping ensures smooth convergence.
            let damping = (-3.0 * (iter as f64 / self.iterations as f64)).exp();

            // Calculate and apply forces from various constraints.
            apply_bond_constraints(atoms, bonds, &positions, &mut forces);
            apply_angle_constraints(n, &adj, &geometries, &positions, &mut forces);
            apply_planarity_constraints(n, &adj, &geometries, &positions, &mut forces);
            apply_torsion_constraints(n, &adj, bonds, &geometries, &positions, &mut forces);
            apply_repulsion_constraints(n, &adj, &positions, &mut forces);

            // Update positions based on accumulated forces.
            for i in 0..n {
                positions[i] = positions[i].add(forces[i].mul(self.force_constant * damping));
            }
        }

        // 6. Output: Write back results to user-defined structures.
        for i in 0..n {
            atoms[i].set_position(positions[i].into());
        }
    }

    /// Like [`optimize`], but captures position snapshots at regular intervals.
    ///
    /// Returns a `Vec<Vec<[f64;3]>>` containing atom positions at each snapshot
    /// (including the final state). Snapshots are taken every `snapshot_interval`
    /// iterations.  The caller can map these back to structures.
    pub fn optimize_with_snapshots<A: AtomTrait, B: BondTrait>(
        &self,
        atoms: &mut [A],
        bonds: &[B],
        snapshot_interval: usize,
    ) -> Vec<Vec<[f64; 3]>> {
        let n = atoms.len();
        if n == 0 {
            return Vec::new();
        }

        let interval = snapshot_interval.max(1);
        let mut snapshots: Vec<Vec<[f64; 3]>> = Vec::new();

        // 1. Setup
        let mut adj = vec![Vec::new(); n];
        for (idx, bond) in bonds.iter().enumerate() {
            let (i, j) = bond.get_atom_indices();
            if i < n && j < n {
                adj[i].push((j, idx));
                adj[j].push((i, idx));
            }
        }

        // 2. Initialization
        let mut positions: Vec<Vec3> = atoms
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let p = Vec3::from(a.get_position());
                let noise_scale = 0.01;
                let dx = ((i * 1337) % 100) as f64 / 100.0 - 0.5;
                let dy = ((i * 7331) % 100) as f64 / 100.0 - 0.5;
                let dz = ((i * 9973) % 100) as f64 / 100.0 - 0.5;
                p.add(Vec3(dx, dy, dz).mul(noise_scale))
            })
            .collect();

        // 3. Topology Jitter
        for i in 0..n {
            if positions[i].length_squared() < 0.001 {
                positions[i] = Vec3(
                    (i as f64 * 1.1).cos() * 1.0,
                    (i as f64 * 1.3).sin() * 1.0,
                    (i as f64 * 1.7).cos() * 1.0,
                );
            }
        }

        // 4. Pre-calculation
        let geometries: Vec<Geometry> = (0..n)
            .map(|i| Geometry::from_steric_number(calculate_steric_number(i, atoms, bonds)))
            .collect();

        // 5. Optimization Loop with snapshots
        for iter in 0..self.iterations {
            let mut forces = vec![Vec3::ZERO; n];
            let damping = (-3.0 * (iter as f64 / self.iterations as f64)).exp();

            apply_bond_constraints(atoms, bonds, &positions, &mut forces);
            apply_angle_constraints(n, &adj, &geometries, &positions, &mut forces);
            apply_planarity_constraints(n, &adj, &geometries, &positions, &mut forces);
            apply_torsion_constraints(n, &adj, bonds, &geometries, &positions, &mut forces);
            apply_repulsion_constraints(n, &adj, &positions, &mut forces);

            for i in 0..n {
                positions[i] = positions[i].add(forces[i].mul(self.force_constant * damping));
            }

            if (iter + 1) % interval == 0 {
                snapshots.push(positions.iter().map(|p| [p.0, p.1, p.2]).collect());
            }
        }

        // Ensure final state is included
        let final_snap: Vec<[f64; 3]> = positions.iter().map(|p| [p.0, p.1, p.2]).collect();
        if snapshots.last().map_or(true, |s| *s != final_snap) {
            snapshots.push(final_snap);
        }

        // 6. Output
        for i in 0..n {
            atoms[i].set_position(positions[i].into());
        }

        snapshots
    }
}

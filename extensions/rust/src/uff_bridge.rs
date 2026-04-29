//! Bridge module between ferrox's Structure types and uff-relax/vsepr-rs optimizers.
//!
//! This module provides conversion functions and wrapper types to use the
//! `uff-relax` (full UFF force field with FIRE optimizer) and `vsepr-rs`
//! (VSEPR geometry optimizer) crates with ferrox's `Structure` type.

use crate::structure::Structure;
use serde::{Deserialize, Serialize};

// Re-import uff-relax's glam types (may differ from ferrox's glam version).
// These are used exclusively for constructing uff-relax types.
use uff_relax::math::{DMat3 as UffDMat3, DVec3 as UffDVec3};

// ============================================================================
// UFF-RELAX bridge
// ============================================================================

/// Configuration for the uff-relax optimizer.
#[derive(Debug, Clone, Deserialize)]
pub struct UffRelaxConfig {
    /// Maximum number of FIRE iterations.
    #[serde(default = "default_uff_max_steps")]
    pub max_steps: usize,
    /// Force convergence threshold (kcal/mol/Angstrom).
    #[serde(default = "default_uff_fmax")]
    pub fmax: f64,
    /// Cutoff distance for non-bonded interactions (Angstrom).
    #[serde(default = "default_uff_cutoff")]
    pub cutoff: f64,
    /// Bond detection tolerance factor for covalent radii sum.
    #[serde(default = "default_bond_tolerance")]
    pub bond_tolerance: f64,
    /// Indices of atoms allowed to move. If None/empty, all atoms move.
    #[serde(default)]
    pub mobile_indices: Option<Vec<usize>>,
    /// Interval at which to save position snapshots for trajectory export.
    /// 1 = every step (default), 10 = every 10th step, etc.
    #[serde(default = "default_snapshot_interval")]
    pub snapshot_interval: usize,
}

fn default_snapshot_interval() -> usize { 1 }
fn default_uff_max_steps() -> usize { 200 }
fn default_uff_fmax() -> f64 { 0.5 }
fn default_uff_cutoff() -> f64 { 6.0 }
fn default_bond_tolerance() -> f64 { 0.45 }

impl Default for UffRelaxConfig {
    fn default() -> Self {
        Self {
            max_steps: default_uff_max_steps(),
            fmax: default_uff_fmax(),
            cutoff: default_uff_cutoff(),
            bond_tolerance: default_bond_tolerance(),
            mobile_indices: None,
            snapshot_interval: default_snapshot_interval(),
        }
    }
}

/// Energy breakdown from the UFF force field.
#[derive(Debug, Clone, Serialize)]
pub struct EnergyBreakdown {
    /// Bond stretching energy (kcal/mol).
    pub bond: f64,
    /// Angle bending energy (kcal/mol).
    pub angle: f64,
    /// Torsion (dihedral) energy (kcal/mol).
    pub torsion: f64,
    /// Non-bonded (van der Waals) energy (kcal/mol).
    pub non_bonded: f64,
    /// Total energy (kcal/mol).
    pub total: f64,
}

/// Per-step info for history tracking.
#[derive(Debug, Clone, Serialize)]
pub struct StepInfo {
    pub step: usize,
    pub energy: f64,
    pub fmax: f64,
    pub converged: bool,
}

/// Result of a UFF-relax optimization.
#[derive(Debug, Clone, Serialize)]
pub struct UffRelaxResult {
    /// The optimized structure.
    pub structure: Structure,
    /// Whether the optimization converged.
    pub converged: bool,
    /// Final total energy (kcal/mol).
    pub final_energy: f64,
    /// Final maximum force (kcal/mol/Angstrom).
    pub final_fmax: f64,
    /// Energy breakdown at the final state.
    pub energy_terms: EnergyBreakdown,
    /// Number of iterations performed.
    pub iterations: usize,
    /// Per-step history.
    pub history: Vec<StepInfo>,
    /// Trajectory frames (structures at snapshot intervals) for export.
    pub trajectory: Vec<Structure>,
}

/// Convert a ferrox `Structure` into a `uff_relax::System`.
///
/// This converts atomic positions and lattice to uff-relax types, and
/// detects bonds using ferrox's covalent-radii-based bond detection.
fn structure_to_uff_system(
    structure: &Structure,
    bond_tolerance: f64,
) -> uff_relax::System {
    let cart_coords = structure.cart_coords();
    let species = structure.species();

    // Convert atoms to uff-relax Atom type.
    // uff_relax::Atom::new takes (element: usize, position: DVec3) where DVec3
    // is from uff-relax's glam version. We use the re-exported UffDVec3.
    let atoms: Vec<uff_relax::Atom> = species
        .iter()
        .zip(cart_coords.iter())
        .map(|(sp, coord)| {
            let z = sp.element.atomic_number() as usize;
            let pos = UffDVec3::new(coord.x, coord.y, coord.z);
            uff_relax::Atom::new(z, pos)
        })
        .collect();

    // Detect bonds using simple pairwise distances on Cartesian coordinates.
    // We avoid ferrox's periodic neighbor list (which can overflow for dense crystals)
    // since the UFF optimizer works on explicit atoms within the cell.
    let n = species.len();
    let mut bonds: Vec<uff_relax::Bond> = Vec::new();
    for i in 0..n {
        let ri = species[i].element.covalent_radius().unwrap_or(1.5);
        for j in (i + 1)..n {
            let rj = species[j].element.covalent_radius().unwrap_or(1.5);
            let max_dist = (ri + rj) * (1.0 + bond_tolerance);
            let dx = cart_coords[i].x - cart_coords[j].x;
            let dy = cart_coords[i].y - cart_coords[j].y;
            let dz = cart_coords[i].z - cart_coords[j].z;
            let dist_sq = dx * dx + dy * dy + dz * dz;
            if dist_sq < max_dist * max_dist && dist_sq > 0.16 { // min 0.4 Å
                let dist = dist_sq.sqrt();
                let ideal_dist = ri + rj;
                let strength = if dist < ideal_dist { 1.0 } else {
                    1.0 - (dist - ideal_dist) / (max_dist - ideal_dist)
                };
                bonds.push(uff_relax::Bond {
                    atom_indices: (i, j),
                    order: strength as f32,
                });
            }
        }
    }

    // Convert lattice to uff-relax UnitCell.
    // ferrox lattice.matrix() returns a nalgebra::Matrix3 (row-major).
    // uff-relax UnitCell::new_triclinic takes glam::DMat3::from_cols.
    // ferrox stores lattice vectors as rows, so row i of the matrix is vector i.
    let is_periodic = structure.pbc.iter().any(|&p| p);
    let cell = if is_periodic {
        let m = structure.lattice.matrix();
        // ferrox matrix rows = lattice vectors a, b, c.
        // uff-relax UnitCell::new_triclinic takes DMat3 where columns = cell vectors.
        // So we pass rows of ferrox matrix as columns of uff-relax DMat3.
        let col_a = UffDVec3::new(m[(0, 0)], m[(0, 1)], m[(0, 2)]);
        let col_b = UffDVec3::new(m[(1, 0)], m[(1, 1)], m[(1, 2)]);
        let col_c = UffDVec3::new(m[(2, 0)], m[(2, 1)], m[(2, 2)]);
        uff_relax::UnitCell::new_triclinic(UffDMat3::from_cols(col_a, col_b, col_c))
    } else {
        uff_relax::UnitCell::new_none()
    };

    uff_relax::System::new(atoms, bonds, cell)
}

/// Update a ferrox `Structure` with new Cartesian positions from a uff-relax `System`.
fn update_structure_from_uff_system(
    original: &Structure,
    system: &uff_relax::System,
) -> Structure {
    let new_cart_coords: Vec<nalgebra::Vector3<f64>> = system
        .atoms
        .iter()
        .map(|a| {
            // Access raw f64 fields from uff-relax's glam DVec3.
            // glam::DVec3 has public fields x, y, z in all versions.
            nalgebra::Vector3::new(a.position.x, a.position.y, a.position.z)
        })
        .collect();

    // Convert Cartesian back to fractional coordinates
    let frac_coords = original.lattice.get_fractional_coords(&new_cart_coords);
    let species_list: Vec<crate::species::Species> = original.species().into_iter().cloned().collect();
    Structure::new(original.lattice.clone(), species_list, frac_coords)
}

/// Run a full UFF-relax optimization on a structure.
///
/// This uses the uff-relax crate's FIRE optimizer with the full UFF force field
/// (bond stretching, angle bending, torsion, non-bonded interactions).
pub fn optimize_structure_uff_relax(
    structure: &Structure,
    config: &UffRelaxConfig,
) -> Result<UffRelaxResult, String> {
    let n_sites = structure.num_sites();
    if n_sites < 2 {
        return Ok(UffRelaxResult {
            structure: structure.clone(),
            converged: true,
            final_energy: 0.0,
            final_fmax: 0.0,
            energy_terms: EnergyBreakdown {
                bond: 0.0,
                angle: 0.0,
                torsion: 0.0,
                non_bonded: 0.0,
                total: 0.0,
            },
            iterations: 0,
            history: Vec::new(),
            trajectory: Vec::new(),
        });
    }

    let mut system = structure_to_uff_system(structure, config.bond_tolerance);

    // Configure the optimizer.
    // In WASM, we force single-threaded execution (num_threads=1).
    let optimizer = uff_relax::UffOptimizer::new(config.max_steps, config.fmax)
        .with_cutoff(config.cutoff)
        .with_num_threads(1) // Serial for WASM compatibility
        .with_mobile_indices(config.mobile_indices.clone())
        .with_snapshot_interval(config.snapshot_interval);

    // Run the optimization with per-step history.
    let opt_result = optimizer.optimize_with_history(&mut system);

    // Build result structure from optimized positions.
    let result_structure = update_structure_from_uff_system(structure, &system);

    // Convert history
    let history: Vec<StepInfo> = opt_result.history.iter().map(|s| StepInfo {
        step: s.step,
        energy: s.energy,
        fmax: s.fmax,
        converged: s.converged,
    }).collect();

    // Build trajectory from position snapshots
    let species_list: Vec<crate::species::Species> = structure.species().into_iter().cloned().collect();
    let trajectory: Vec<Structure> = opt_result.history.iter()
        .filter_map(|s| {
            s.positions.as_ref().map(|positions| {
                let cart_coords: Vec<nalgebra::Vector3<f64>> = positions.iter()
                    .map(|p| nalgebra::Vector3::new(p.x, p.y, p.z))
                    .collect();
                let frac_coords = structure.lattice.get_fractional_coords(&cart_coords);
                Structure::new(structure.lattice.clone(), species_list.clone(), frac_coords)
            })
        })
        .collect();

    Ok(UffRelaxResult {
        structure: result_structure,
        converged: opt_result.converged,
        final_energy: opt_result.final_energy.total,
        final_fmax: opt_result.final_fmax,
        energy_terms: EnergyBreakdown {
            bond: opt_result.final_energy.bond,
            angle: opt_result.final_energy.angle,
            torsion: opt_result.final_energy.torsion,
            non_bonded: opt_result.final_energy.non_bonded,
            total: opt_result.final_energy.total,
        },
        iterations: opt_result.iterations,
        history,
        trajectory,
    })
}

// ============================================================================
// VSEPR bridge
// ============================================================================

/// Configuration for the VSEPR optimizer.
#[derive(Debug, Clone, Deserialize)]
pub struct VseprConfig {
    /// Number of optimization iterations.
    #[serde(default = "default_vsepr_iterations")]
    pub iterations: usize,
    /// Force/movement scaling factor per step.
    #[serde(default = "default_vsepr_force_constant")]
    pub force_constant: f64,
    /// Bond detection tolerance factor for covalent radii sum.
    #[serde(default = "default_bond_tolerance")]
    pub bond_tolerance: f64,
    /// Indices of atoms allowed to move. If None/empty, all atoms move.
    #[serde(default)]
    pub mobile_indices: Option<Vec<usize>>,
    /// Capture a trajectory snapshot every N iterations. 0 = only initial+final.
    #[serde(default)]
    pub snapshot_interval: usize,
}

fn default_vsepr_iterations() -> usize { 1500 }
fn default_vsepr_force_constant() -> f64 { 0.15 }

impl Default for VseprConfig {
    fn default() -> Self {
        Self {
            iterations: default_vsepr_iterations(),
            force_constant: default_vsepr_force_constant(),
            bond_tolerance: default_bond_tolerance(),
            mobile_indices: None,
            snapshot_interval: 0,
        }
    }
}

/// Result of a VSEPR optimization.
#[derive(Debug, Clone, Serialize)]
pub struct VseprResult {
    /// The optimized structure.
    pub structure: Structure,
    /// Number of iterations performed.
    pub iterations: usize,
    /// Trajectory: initial + final structures.
    pub trajectory: Vec<Structure>,
}

// Concrete types implementing vsepr-rs traits.

/// Adapter atom type for vsepr-rs.
struct VseprAtom {
    position: [f64; 3],
    atomic_number: usize,
}

impl vsepr_rs::AtomTrait for VseprAtom {
    fn get_position(&self) -> [f64; 3] {
        self.position
    }
    fn set_position(&mut self, pos: [f64; 3]) {
        self.position = pos;
    }
    fn atomic_number(&self) -> usize {
        self.atomic_number
    }
}

/// Adapter bond type for vsepr-rs.
struct VseprBond {
    indices: (usize, usize),
    order: f32,
}

impl vsepr_rs::BondTrait for VseprBond {
    fn get_atom_indices(&self) -> (usize, usize) {
        self.indices
    }
    fn get_bond_order(&self) -> f32 {
        self.order
    }
}

/// Run VSEPR geometry optimization on a structure.
///
/// VSEPR is designed as a scaffolder/pre-optimizer: it quickly transforms
/// raw or overlapping coordinates into a chemically sensible 3D structure.
/// It works best for small molecules and is non-periodic.
pub fn optimize_structure_vsepr(
    structure: &Structure,
    config: &VseprConfig,
) -> Result<VseprResult, String> {
    let n_sites = structure.num_sites();
    if n_sites == 0 {
        return Ok(VseprResult {
            structure: structure.clone(),
            iterations: 0,
            trajectory: Vec::new(),
        });
    }

    let cart_coords = structure.cart_coords();
    let species = structure.species();

    // Convert to VSEPR atom types.
    let mut atoms: Vec<VseprAtom> = species
        .iter()
        .zip(cart_coords.iter())
        .map(|(sp, coord)| VseprAtom {
            position: [coord.x, coord.y, coord.z],
            atomic_number: sp.element.atomic_number() as usize,
        })
        .collect();

    // Detect bonds using simple pairwise distances on Cartesian coordinates.
    // We avoid ferrox's periodic neighbor list (which can overflow for dense crystals)
    // since VSEPR operates on explicit atoms only, not periodic images.
    let mut bonds: Vec<VseprBond> = Vec::new();
    for i in 0..n_sites {
        let ri = species[i].element.covalent_radius().unwrap_or(1.5);
        for j in (i + 1)..n_sites {
            let rj = species[j].element.covalent_radius().unwrap_or(1.5);
            let max_dist = (ri + rj) * (1.0 + config.bond_tolerance);
            let dx = cart_coords[i].x - cart_coords[j].x;
            let dy = cart_coords[i].y - cart_coords[j].y;
            let dz = cart_coords[i].z - cart_coords[j].z;
            let dist_sq = dx * dx + dy * dy + dz * dz;
            if dist_sq < max_dist * max_dist && dist_sq > 0.16 { // min 0.4 Å
                bonds.push(VseprBond {
                    indices: (i, j),
                    order: 1.0,
                });
            }
        }
    }

    // Save original positions of frozen atoms
    let frozen_positions: Vec<Option<[f64; 3]>> = match &config.mobile_indices {
        Some(indices) => {
            let mobile_set: std::collections::HashSet<usize> = indices.iter().copied().collect();
            atoms.iter().enumerate().map(|(i, a)| {
                if mobile_set.contains(&i) { None } else { Some(a.position) }
            }).collect()
        }
        None => vec![None; atoms.len()],
    };

    // Run VSEPR optimizer.
    let optimizer = vsepr_rs::VseprOptimizer {
        iterations: config.iterations,
        force_constant: config.force_constant,
    };

    // Collect trajectory snapshots if requested
    let snapshots = if config.snapshot_interval > 0 {
        optimizer.optimize_with_snapshots(&mut atoms, &bonds, config.snapshot_interval)
    } else {
        optimizer.optimize(&mut atoms, &bonds);
        Vec::new()
    };

    // Restore frozen atom positions
    for (i, saved) in frozen_positions.iter().enumerate() {
        if let Some(pos) = saved {
            atoms[i].position = *pos;
        }
    }

    // Convert back to ferrox Structure.
    let new_cart_coords: Vec<nalgebra::Vector3<f64>> = atoms
        .iter()
        .map(|a| nalgebra::Vector3::new(a.position[0], a.position[1], a.position[2]))
        .collect();

    let frac_coords = structure.lattice.get_fractional_coords(&new_cart_coords);
    let species_list: Vec<crate::species::Species> = structure.species().into_iter().cloned().collect();
    let result_structure = Structure::new(structure.lattice.clone(), species_list, frac_coords);

    // Build trajectory from snapshots
    let mut trajectory = vec![structure.clone()]; // initial
    if !snapshots.is_empty() {
        let species_for_traj = structure.species();
        for snap_positions in &snapshots {
            let cart: Vec<nalgebra::Vector3<f64>> = snap_positions
                .iter()
                .map(|p| nalgebra::Vector3::new(p[0], p[1], p[2]))
                .collect();
            let frac = structure.lattice.get_fractional_coords(&cart);
            let sp: Vec<crate::species::Species> = species_for_traj.iter().map(|s| (*s).clone()).collect();
            trajectory.push(Structure::new(structure.lattice.clone(), sp, frac));
        }
    } else {
        trajectory.push(result_structure.clone()); // only initial + final
    }

    Ok(VseprResult {
        structure: result_structure,
        iterations: config.iterations,
        trajectory,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::Element;
    use crate::lattice::Lattice;
    use crate::species::Species;
    use nalgebra::Vector3;

    fn h2o_molecule() -> Structure {
        // Water molecule in a large box
        let lattice = Lattice::cubic(20.0);
        let species = vec![
            Species::neutral(Element::O),
            Species::neutral(Element::H),
            Species::neutral(Element::H),
        ];
        // O at center, H atoms nearby
        let frac_coords = vec![
            Vector3::new(0.5, 0.5, 0.5),
            Vector3::new(0.548, 0.5, 0.5),   // ~0.96 A from O
            Vector3::new(0.5, 0.548, 0.5),   // ~0.96 A from O
        ];
        Structure::new(lattice, species, frac_coords)
    }

    #[test]
    fn test_vsepr_water() {
        let h2o = h2o_molecule();
        let config = VseprConfig::default();
        let result = optimize_structure_vsepr(&h2o, &config).unwrap();
        assert_eq!(result.structure.num_sites(), 3);
    }

    #[test]
    fn test_uff_relax_water() {
        let h2o = h2o_molecule();
        let config = UffRelaxConfig {
            max_steps: 50,
            fmax: 1.0,
            ..Default::default()
        };
        let result = optimize_structure_uff_relax(&h2o, &config).unwrap();
        assert_eq!(result.structure.num_sites(), 3);
    }
}

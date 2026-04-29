//! Simple molecular structure optimizer using UFF (Universal Force Field) and FIRE algorithm.
//!
//! This module provides a lightweight optimization method suitable for small molecules
//! that doesn't require a backend server. It uses:
//! - UFF (Universal Force Field) Lennard-Jones parameters for van der Waals interactions
//! - FIRE (Fast Inertial Relaxation Engine) algorithm for optimization
//!
//! UFF parameters from: Rappe et al., J. Am. Chem. Soc. 1992, 114, 10024-10035
//!
//! Note: This is a simplified optimizer for visualization/demo purposes.
//! For production calculations, use a proper DFT or ML potential backend.

use crate::element::Element;
use crate::species::Species;
use crate::structure::Structure;
use nalgebra::Vector3;
use serde::{Deserialize, Serialize};

/// Helper function to create a new structure with updated Cartesian coordinates.
/// Converts cart coords to fractional and creates a new structure.
fn structure_with_cart_coords(structure: &Structure, cart_coords: &[Vector3<f64>]) -> Structure {
    let frac_coords = structure.lattice.get_fractional_coords(cart_coords);
    let species: Vec<Species> = structure.species().into_iter().cloned().collect();
    Structure::new(structure.lattice.clone(), species, frac_coords)
}

/// UFF Lennard-Jones parameters
#[derive(Debug, Clone, Copy)]
struct UFFParams {
    /// van der Waals distance (Angstrom) - x_i in UFF paper
    r_vdw: f64,
    /// van der Waals well depth (kcal/mol) - D_i in UFF paper
    d_vdw: f64,
}

/// Get UFF parameters for an element
/// Data from Rappe et al., JACS 1992
fn get_uff_params(elem: Element) -> UFFParams {
    use Element::*;
    match elem {
        H => UFFParams { r_vdw: 2.886, d_vdw: 0.044 },
        He => UFFParams { r_vdw: 2.362, d_vdw: 0.056 },
        Li => UFFParams { r_vdw: 2.451, d_vdw: 0.025 },
        Be => UFFParams { r_vdw: 2.745, d_vdw: 0.085 },
        B => UFFParams { r_vdw: 4.083, d_vdw: 0.180 },
        C => UFFParams { r_vdw: 3.851, d_vdw: 0.105 },
        N => UFFParams { r_vdw: 3.660, d_vdw: 0.069 },
        O => UFFParams { r_vdw: 3.500, d_vdw: 0.060 },
        F => UFFParams { r_vdw: 3.364, d_vdw: 0.050 },
        Ne => UFFParams { r_vdw: 3.243, d_vdw: 0.042 },
        Na => UFFParams { r_vdw: 2.983, d_vdw: 0.030 },
        Mg => UFFParams { r_vdw: 3.021, d_vdw: 0.111 },
        Al => UFFParams { r_vdw: 4.499, d_vdw: 0.505 },
        Si => UFFParams { r_vdw: 4.295, d_vdw: 0.402 },
        P => UFFParams { r_vdw: 4.147, d_vdw: 0.305 },
        S => UFFParams { r_vdw: 4.035, d_vdw: 0.274 },
        Cl => UFFParams { r_vdw: 3.947, d_vdw: 0.227 },
        Ar => UFFParams { r_vdw: 3.868, d_vdw: 0.185 },
        K => UFFParams { r_vdw: 3.812, d_vdw: 0.035 },
        Ca => UFFParams { r_vdw: 3.399, d_vdw: 0.238 },
        Sc => UFFParams { r_vdw: 3.295, d_vdw: 0.019 },
        Ti => UFFParams { r_vdw: 3.175, d_vdw: 0.017 },
        V => UFFParams { r_vdw: 3.144, d_vdw: 0.016 },
        Cr => UFFParams { r_vdw: 3.023, d_vdw: 0.015 },
        Mn => UFFParams { r_vdw: 2.961, d_vdw: 0.013 },
        Fe => UFFParams { r_vdw: 2.912, d_vdw: 0.013 },
        Co => UFFParams { r_vdw: 2.872, d_vdw: 0.014 },
        Ni => UFFParams { r_vdw: 2.834, d_vdw: 0.015 },
        Cu => UFFParams { r_vdw: 3.495, d_vdw: 0.005 },
        Zn => UFFParams { r_vdw: 2.763, d_vdw: 0.124 },
        Ga => UFFParams { r_vdw: 4.383, d_vdw: 0.415 },
        Ge => UFFParams { r_vdw: 4.280, d_vdw: 0.379 },
        As => UFFParams { r_vdw: 4.230, d_vdw: 0.309 },
        Se => UFFParams { r_vdw: 4.205, d_vdw: 0.291 },
        Br => UFFParams { r_vdw: 4.189, d_vdw: 0.251 },
        Kr => UFFParams { r_vdw: 4.141, d_vdw: 0.220 },
        Rb => UFFParams { r_vdw: 4.114, d_vdw: 0.040 },
        Sr => UFFParams { r_vdw: 3.641, d_vdw: 0.235 },
        Y => UFFParams { r_vdw: 3.345, d_vdw: 0.072 },
        Zr => UFFParams { r_vdw: 3.124, d_vdw: 0.069 },
        Nb => UFFParams { r_vdw: 3.165, d_vdw: 0.059 },
        Mo => UFFParams { r_vdw: 3.052, d_vdw: 0.056 },
        Tc => UFFParams { r_vdw: 2.998, d_vdw: 0.048 },
        Ru => UFFParams { r_vdw: 2.963, d_vdw: 0.056 },
        Rh => UFFParams { r_vdw: 2.929, d_vdw: 0.053 },
        Pd => UFFParams { r_vdw: 2.899, d_vdw: 0.048 },
        Ag => UFFParams { r_vdw: 3.148, d_vdw: 0.036 },
        Cd => UFFParams { r_vdw: 2.848, d_vdw: 0.228 },
        In => UFFParams { r_vdw: 4.463, d_vdw: 0.599 },
        Sn => UFFParams { r_vdw: 4.392, d_vdw: 0.567 },
        Sb => UFFParams { r_vdw: 4.420, d_vdw: 0.449 },
        Te => UFFParams { r_vdw: 4.470, d_vdw: 0.398 },
        I => UFFParams { r_vdw: 4.500, d_vdw: 0.339 },
        Xe => UFFParams { r_vdw: 4.404, d_vdw: 0.332 },
        Cs => UFFParams { r_vdw: 4.517, d_vdw: 0.045 },
        Ba => UFFParams { r_vdw: 3.703, d_vdw: 0.364 },
        La => UFFParams { r_vdw: 3.522, d_vdw: 0.017 },
        Ce => UFFParams { r_vdw: 3.556, d_vdw: 0.013 },
        Pr => UFFParams { r_vdw: 3.606, d_vdw: 0.010 },
        Nd => UFFParams { r_vdw: 3.575, d_vdw: 0.010 },
        Pm => UFFParams { r_vdw: 3.547, d_vdw: 0.009 },
        Sm => UFFParams { r_vdw: 3.520, d_vdw: 0.008 },
        Eu => UFFParams { r_vdw: 3.493, d_vdw: 0.008 },
        Gd => UFFParams { r_vdw: 3.368, d_vdw: 0.009 },
        Tb => UFFParams { r_vdw: 3.451, d_vdw: 0.007 },
        Dy => UFFParams { r_vdw: 3.428, d_vdw: 0.007 },
        Ho => UFFParams { r_vdw: 3.409, d_vdw: 0.007 },
        Er => UFFParams { r_vdw: 3.391, d_vdw: 0.007 },
        Tm => UFFParams { r_vdw: 3.374, d_vdw: 0.006 },
        Yb => UFFParams { r_vdw: 3.355, d_vdw: 0.228 },
        Lu => UFFParams { r_vdw: 3.640, d_vdw: 0.041 },
        Hf => UFFParams { r_vdw: 3.141, d_vdw: 0.072 },
        Ta => UFFParams { r_vdw: 3.170, d_vdw: 0.081 },
        W => UFFParams { r_vdw: 3.069, d_vdw: 0.067 },
        Re => UFFParams { r_vdw: 2.954, d_vdw: 0.066 },
        Os => UFFParams { r_vdw: 3.120, d_vdw: 0.037 },
        Ir => UFFParams { r_vdw: 2.840, d_vdw: 0.073 },
        Pt => UFFParams { r_vdw: 2.754, d_vdw: 0.080 },
        Au => UFFParams { r_vdw: 3.293, d_vdw: 0.039 },
        Hg => UFFParams { r_vdw: 2.705, d_vdw: 0.385 },
        Tl => UFFParams { r_vdw: 4.347, d_vdw: 0.680 },
        Pb => UFFParams { r_vdw: 4.297, d_vdw: 0.663 },
        Bi => UFFParams { r_vdw: 4.370, d_vdw: 0.518 },
        Po => UFFParams { r_vdw: 4.709, d_vdw: 0.325 },
        At => UFFParams { r_vdw: 4.750, d_vdw: 0.284 },
        Rn => UFFParams { r_vdw: 4.765, d_vdw: 0.248 },
        Fr => UFFParams { r_vdw: 4.900, d_vdw: 0.050 },
        Ra => UFFParams { r_vdw: 3.677, d_vdw: 0.404 },
        Ac => UFFParams { r_vdw: 3.478, d_vdw: 0.033 },
        Th => UFFParams { r_vdw: 3.396, d_vdw: 0.026 },
        Pa => UFFParams { r_vdw: 3.424, d_vdw: 0.022 },
        U => UFFParams { r_vdw: 3.395, d_vdw: 0.022 },
        Np => UFFParams { r_vdw: 3.424, d_vdw: 0.019 },
        Pu => UFFParams { r_vdw: 3.424, d_vdw: 0.016 },
        Am => UFFParams { r_vdw: 3.381, d_vdw: 0.014 },
        Cm => UFFParams { r_vdw: 3.326, d_vdw: 0.013 },
        Bk => UFFParams { r_vdw: 3.339, d_vdw: 0.013 },
        Cf => UFFParams { r_vdw: 3.313, d_vdw: 0.013 },
        Es => UFFParams { r_vdw: 3.299, d_vdw: 0.012 },
        Fm => UFFParams { r_vdw: 3.286, d_vdw: 0.012 },
        Md => UFFParams { r_vdw: 3.274, d_vdw: 0.011 },
        No => UFFParams { r_vdw: 3.248, d_vdw: 0.011 },
        Lr => UFFParams { r_vdw: 3.236, d_vdw: 0.011 },
        // Default for any missing elements
        _ => UFFParams { r_vdw: 3.5, d_vdw: 0.1 },
    }
}

/// Calculate mixed LJ parameters using geometric mean (UFF convention)
fn mix_uff_params(a: UFFParams, b: UFFParams) -> (f64, f64) {
    // x_ij = sqrt(x_i * x_j)
    let r_ij = (a.r_vdw * b.r_vdw).sqrt();
    // D_ij = sqrt(D_i * D_j)
    let d_ij = (a.d_vdw * b.d_vdw).sqrt();
    // Convert kcal/mol to eV: 1 kcal/mol = 0.0433641 eV
    let d_ij_ev = d_ij * 0.0433641;
    (r_ij, d_ij_ev)
}

/// Configuration for the optimizer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizerConfig {
    /// Maximum number of optimization steps
    #[serde(default = "default_max_steps")]
    pub max_steps: usize,
    /// Force convergence threshold (eV/Angstrom)
    #[serde(default = "default_fmax")]
    pub fmax: f64,
    /// Time step for FIRE algorithm
    #[serde(default = "default_dt")]
    pub dt: f64,
    /// Maximum atomic displacement per step (Angstrom)
    #[serde(default = "default_max_move")]
    pub max_move: f64,
    /// Cutoff distance for LJ interactions (Angstrom)
    #[serde(default = "default_cutoff")]
    pub cutoff: f64,
    /// Indices of atoms that are allowed to move (if None or empty, all atoms move)
    #[serde(default)]
    pub mobile_indices: Option<Vec<usize>>,
}

fn default_max_steps() -> usize {
    100
}
fn default_fmax() -> f64 {
    0.05
}
fn default_dt() -> f64 {
    0.1
}
fn default_max_move() -> f64 {
    0.2
}
fn default_cutoff() -> f64 {
    8.0
}

impl Default for OptimizerConfig {
    fn default() -> Self {
        Self {
            max_steps: default_max_steps(),
            fmax: default_fmax(),
            dt: default_dt(),
            max_move: default_max_move(),
            cutoff: default_cutoff(),
            mobile_indices: None,
        }
    }
}

/// Result of a single optimization step
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizationStep {
    /// Current step number
    pub step: usize,
    /// Total energy (eV)
    pub energy: f64,
    /// Maximum force magnitude (eV/Angstrom)
    pub fmax: f64,
    /// Whether optimization has converged
    pub converged: bool,
}

/// Result of the full optimization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizationResult {
    /// Final optimized structure
    pub structure: Structure,
    /// History of optimization steps
    pub history: Vec<OptimizationStep>,
    /// Whether optimization converged
    pub converged: bool,
    /// Final energy (eV)
    pub final_energy: f64,
    /// Final maximum force (eV/Angstrom)
    pub final_fmax: f64,
}

/// FIRE optimizer state
struct FireState {
    velocities: Vec<Vector3<f64>>,
    dt: f64,
    alpha: f64,
    n_pos: usize,
}

impl FireState {
    fn new(n_atoms: usize, dt: f64) -> Self {
        Self {
            velocities: vec![Vector3::zeros(); n_atoms],
            dt,
            alpha: 0.1,
            n_pos: 0,
        }
    }

    /// FIRE algorithm parameters
    const ALPHA_START: f64 = 0.1;
    const F_ALPHA: f64 = 0.99;
    const F_INC: f64 = 1.1;
    const F_DEC: f64 = 0.5;
    const N_MIN: usize = 5;
    const DT_MAX: f64 = 1.0;
}

/// Calculate UFF Lennard-Jones energy and forces for the structure
fn calculate_uff_energy_forces(
    structure: &Structure,
    cutoff: f64,
) -> (f64, Vec<Vector3<f64>>) {
    let n_sites = structure.num_sites();
    let species = structure.species();
    let cart_coords = structure.cart_coords();
    let cutoff_sq = cutoff * cutoff;

    let mut energy = 0.0;
    let mut forces = vec![Vector3::zeros(); n_sites];

    // Get UFF parameters for all species
    let uff_params: Vec<UFFParams> = species
        .iter()
        .map(|sp| get_uff_params(sp.element))
        .collect();

    // Calculate pairwise interactions
    // Note: This optimizer is designed for isolated molecules (non-periodic)
    // For periodic systems, use a proper DFT/ML backend
    for i in 0..n_sites {
        for j in (i + 1)..n_sites {
            // Simple distance vector (no PBC - for molecules)
            let r_vec = cart_coords[j] - cart_coords[i];

            let r_sq = r_vec.norm_squared();
            if r_sq > cutoff_sq || r_sq < 0.01 {
                continue;
            }

            let r = r_sq.sqrt();
            let (r_ij, d_ij) = mix_uff_params(uff_params[i], uff_params[j]);

            // UFF uses LJ 12-6: E = D_ij * [( x_ij/r )^12 - 2*( x_ij/r )^6]
            // Note: UFF convention has factor of 2 on the attractive term
            let xr = r_ij / r;
            let xr6 = xr.powi(6);
            let xr12 = xr6 * xr6;

            let e_pair = d_ij * (xr12 - 2.0 * xr6);
            energy += e_pair;

            // Force: F = -dE/dr * r_hat = 12*D_ij/r * [( x_ij/r )^12 - ( x_ij/r )^6] * r_hat
            let f_mag = 12.0 * d_ij / r * (xr12 - xr6);
            let f_vec = f_mag * r_vec / r;

            forces[i] -= f_vec;
            forces[j] += f_vec;
        }
    }

    (energy, forces)
}

/// Get maximum force magnitude (optionally only for mobile atoms)
fn get_fmax(forces: &[Vector3<f64>], mobile_indices: Option<&[usize]>) -> f64 {
    match mobile_indices {
        Some(indices) if !indices.is_empty() => {
            indices
                .iter()
                .filter_map(|&i| forces.get(i))
                .map(|f| f.norm())
                .fold(0.0, f64::max)
        }
        _ => {
            forces
                .iter()
                .map(|f| f.norm())
                .fold(0.0, f64::max)
        }
    }
}

/// Check if an atom index is mobile
fn is_mobile(idx: usize, mobile_indices: Option<&[usize]>) -> bool {
    match mobile_indices {
        Some(indices) if !indices.is_empty() => indices.contains(&idx),
        _ => true,
    }
}

/// Optimize structure using FIRE algorithm with Lennard-Jones potential
pub fn optimize_uff(structure: &Structure, config: &OptimizerConfig) -> OptimizationResult {
    let n_sites = structure.num_sites();
    if n_sites < 2 {
        // Nothing to optimize
        return OptimizationResult {
            structure: structure.clone(),
            history: vec![],
            converged: true,
            final_energy: 0.0,
            final_fmax: 0.0,
        };
    }

    // Get mobile indices reference for convenience
    let mobile_ref = config.mobile_indices.as_deref();

    // Initialize positions from structure
    let mut positions: Vec<Vector3<f64>> = structure.cart_coords().to_vec();
    let mut state = FireState::new(n_sites, config.dt);
    let mut history = Vec::new();

    // Initial energy and forces
    let mut temp_structure = structure.clone();
    let (mut energy, mut forces) = calculate_uff_energy_forces(&temp_structure, config.cutoff);
    let mut fmax = get_fmax(&forces, mobile_ref);

    // Check initial convergence
    if fmax < config.fmax {
        return OptimizationResult {
            structure: structure.clone(),
            history: vec![OptimizationStep {
                step: 0,
                energy,
                fmax,
                converged: true,
            }],
            converged: true,
            final_energy: energy,
            final_fmax: fmax,
        };
    }

    // FIRE optimization loop
    for step in 0..config.max_steps {
        // Record step
        history.push(OptimizationStep {
            step,
            energy,
            fmax,
            converged: false,
        });

        // FIRE velocity update - only for mobile atoms
        let v_dot_f: f64 = state.velocities
            .iter()
            .enumerate()
            .filter(|(i, _)| is_mobile(*i, mobile_ref))
            .map(|(_, v)| v)
            .zip(forces.iter().enumerate().filter(|(i, _)| is_mobile(*i, mobile_ref)).map(|(_, f)| f))
            .map(|(v, f)| v.dot(f))
            .sum();

        let f_norm: f64 = forces.iter()
            .enumerate()
            .filter(|(i, _)| is_mobile(*i, mobile_ref))
            .map(|(_, f)| f.norm_squared())
            .sum::<f64>()
            .sqrt();
        let v_norm: f64 = state.velocities.iter()
            .enumerate()
            .filter(|(i, _)| is_mobile(*i, mobile_ref))
            .map(|(_, v)| v.norm_squared())
            .sum::<f64>()
            .sqrt();

        if f_norm > 1e-10 {
            // Mix velocity with force direction - only for mobile atoms
            for (i, (v, f)) in state.velocities.iter_mut().zip(forces.iter()).enumerate() {
                if is_mobile(i, mobile_ref) {
                    let f_hat = f / f_norm;
                    *v = (1.0 - state.alpha) * *v + state.alpha * v_norm * f_hat;
                }
            }
        }

        // Check if moving downhill
        if v_dot_f > 0.0 {
            state.n_pos += 1;
            if state.n_pos > FireState::N_MIN {
                state.dt = (state.dt * FireState::F_INC).min(FireState::DT_MAX);
                state.alpha *= FireState::F_ALPHA;
            }
        } else {
            // Reset if going uphill
            state.n_pos = 0;
            state.dt *= FireState::F_DEC;
            state.alpha = FireState::ALPHA_START;
            for (i, v) in state.velocities.iter_mut().enumerate() {
                if is_mobile(i, mobile_ref) {
                    *v = Vector3::zeros();
                }
            }
        }

        // Euler integration: v += dt * F, x += dt * v - only for mobile atoms
        for (i, (v, f)) in state.velocities.iter_mut().zip(forces.iter()).enumerate() {
            if is_mobile(i, mobile_ref) {
                *v += state.dt * f;
            }
        }

        // Update positions with max_move constraint - only for mobile atoms
        for (i, (pos, v)) in positions.iter_mut().zip(state.velocities.iter()).enumerate() {
            if is_mobile(i, mobile_ref) {
                let displacement = state.dt * v;
                let disp_mag = displacement.norm();
                if disp_mag > config.max_move {
                    *pos += displacement * (config.max_move / disp_mag);
                } else {
                    *pos += displacement;
                }
            }
        }

        // Update structure with new positions
        temp_structure = structure_with_cart_coords(structure, &positions);

        // Recalculate energy and forces
        let (new_energy, new_forces) = calculate_uff_energy_forces(&temp_structure, config.cutoff);
        energy = new_energy;
        forces = new_forces;
        fmax = get_fmax(&forces, mobile_ref);

        // Check convergence
        if fmax < config.fmax {
            history.push(OptimizationStep {
                step: step + 1,
                energy,
                fmax,
                converged: true,
            });
            return OptimizationResult {
                structure: temp_structure,
                history,
                converged: true,
                final_energy: energy,
                final_fmax: fmax,
            };
        }
    }

    // Did not converge
    OptimizationResult {
        structure: temp_structure,
        history,
        converged: false,
        final_energy: energy,
        final_fmax: fmax,
    }
}

/// Run a single optimization step (for interactive optimization)
pub fn optimize_step(
    structure: &Structure,
    velocities: &mut [Vector3<f64>],
    fire_state: &mut (f64, f64, usize), // (dt, alpha, n_pos)
    config: &OptimizerConfig,
) -> (Structure, f64, f64) {
    let mut positions: Vec<Vector3<f64>> = structure.cart_coords().to_vec();
    let mobile_ref = config.mobile_indices.as_deref();

    // Calculate forces
    let (energy, forces) = calculate_uff_energy_forces(structure, config.cutoff);
    let fmax = get_fmax(&forces, mobile_ref);

    if fmax < config.fmax {
        return (structure.clone(), energy, fmax);
    }

    let (dt, alpha, n_pos) = fire_state;

    // FIRE velocity update - only for mobile atoms
    let v_dot_f: f64 = velocities
        .iter()
        .enumerate()
        .filter(|(i, _)| is_mobile(*i, mobile_ref))
        .map(|(_, v)| v)
        .zip(forces.iter().enumerate().filter(|(i, _)| is_mobile(*i, mobile_ref)).map(|(_, f)| f))
        .map(|(v, f)| v.dot(f))
        .sum();

    let f_norm: f64 = forces.iter()
        .enumerate()
        .filter(|(i, _)| is_mobile(*i, mobile_ref))
        .map(|(_, f)| f.norm_squared())
        .sum::<f64>()
        .sqrt();
    let v_norm: f64 = velocities.iter()
        .enumerate()
        .filter(|(i, _)| is_mobile(*i, mobile_ref))
        .map(|(_, v)| v.norm_squared())
        .sum::<f64>()
        .sqrt();

    if f_norm > 1e-10 {
        for (i, (v, f)) in velocities.iter_mut().zip(forces.iter()).enumerate() {
            if is_mobile(i, mobile_ref) {
                let f_hat = f / f_norm;
                *v = (1.0 - *alpha) * *v + *alpha * v_norm * f_hat;
            }
        }
    }

    if v_dot_f > 0.0 {
        *n_pos += 1;
        if *n_pos > FireState::N_MIN {
            *dt = (*dt * FireState::F_INC).min(FireState::DT_MAX);
            *alpha *= FireState::F_ALPHA;
        }
    } else {
        *n_pos = 0;
        *dt *= FireState::F_DEC;
        *alpha = FireState::ALPHA_START;
        for (i, v) in velocities.iter_mut().enumerate() {
            if is_mobile(i, mobile_ref) {
                *v = Vector3::zeros();
            }
        }
    }

    // Euler integration - only for mobile atoms
    for (i, (v, f)) in velocities.iter_mut().zip(forces.iter()).enumerate() {
        if is_mobile(i, mobile_ref) {
            *v += *dt * f;
        }
    }

    for (i, (pos, v)) in positions.iter_mut().zip(velocities.iter()).enumerate() {
        if is_mobile(i, mobile_ref) {
            let displacement = *dt * *v;
            let disp_mag = displacement.norm();
            if disp_mag > config.max_move {
                *pos += displacement * (config.max_move / disp_mag);
            } else {
                *pos += displacement;
            }
        }
    }

    let new_structure = structure_with_cart_coords(structure, &positions);
    (new_structure, energy, fmax)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lattice::Lattice;
    use crate::species::Species;

    fn h2_molecule() -> Structure {
        // Two H atoms near the LJ equilibrium distance (~2.886 Å for H-H).
        // At 3.0 Å the LJ potential is slightly attractive (past the minimum).
        let lattice = Lattice::cubic(20.0); // Large box for molecule
        let species = vec![
            Species::neutral(Element::H),
            Species::neutral(Element::H),
        ];
        let frac_coords = vec![
            Vector3::new(0.5, 0.5, 0.425), // 3.0 Å apart (20*0.075*2)
            Vector3::new(0.5, 0.5, 0.575),
        ];
        Structure::new(lattice, species, frac_coords)
    }

    #[test]
    fn test_lj_energy_forces() {
        let h2 = h2_molecule();
        let (energy, forces) = calculate_uff_energy_forces(&h2, 10.0);

        // Energy should be negative (attractive) near the LJ equilibrium
        assert!(energy < 0.0, "LJ energy should be negative near equilibrium, got {energy}");

        // Forces should be opposite for two atoms
        let f_sum = forces[0] + forces[1];
        assert!(f_sum.norm() < 1e-10, "Forces should cancel out");
    }

    #[test]
    fn test_optimize_h2() {
        let h2 = h2_molecule();
        let config = OptimizerConfig {
            max_steps: 50,
            fmax: 0.01,
            ..Default::default()
        };

        let result = optimize_uff(&h2, &config);

        // Should converge
        assert!(result.converged, "H2 optimization should converge");
        assert!(result.final_fmax < 0.01, "Final fmax should be below threshold");
    }
}

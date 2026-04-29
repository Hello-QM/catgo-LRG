//! Ewald summation for electrostatic energy in periodic systems.
//!
//! This module implements the Ewald summation method to compute Coulomb
//! interactions in periodic crystals. The method splits the long-range
//! Coulomb potential into:
//!
//! 1. **Real-space sum**: Short-range interactions that converge quickly in real space
//! 2. **Reciprocal-space sum**: Long-range interactions that converge quickly in Fourier space
//! 3. **Self-energy correction**: Removes the spurious self-interaction
//!
//! The total electrostatic energy is: E = E_real + E_recip + E_self
//!
//! # Units
//!
//! - Distances in Angstroms (Å)
//! - Charges in elementary charges (e)
//! - Energy in eV

use crate::structure::Structure;
use nalgebra::Vector3;
use std::f64::consts::PI;

/// Conversion factor: e² / (4πε₀ Å) → eV
/// Coulomb's constant k = 1/(4πε₀) = 8.9875517923e9 N·m²/C²
/// 1 eV = 1.602176634e-19 J
/// 1 e = 1.602176634e-19 C
/// 1 Å = 1e-10 m
/// k * e² / Å / eV = 14.3996... eV·Å
const COULOMB_CONST: f64 = 14.3996;

/// Configuration for Ewald summation.
#[derive(Debug, Clone)]
pub struct EwaldConfig {
    /// Ewald screening parameter (η or alpha).
    /// Controls the real/reciprocal space split.
    /// Larger values shift more to reciprocal space.
    pub eta: f64,
    /// Cutoff for real-space sum in Angstroms.
    pub real_space_cutoff: f64,
    /// Cutoff for reciprocal-space sum in 1/Angstroms.
    pub recip_space_cutoff: f64,
}

impl Default for EwaldConfig {
    fn default() -> Self {
        Self {
            eta: 0.3,
            real_space_cutoff: 15.0,
            recip_space_cutoff: 2.0,
        }
    }
}

impl EwaldConfig {
    /// Create config with automatic parameter optimization.
    ///
    /// Balances real and reciprocal space sums for efficiency.
    pub fn auto_optimize(structure: &Structure, accuracy: f64) -> Self {
        let volume = structure.lattice.volume();
        let n_sites = structure.num_sites() as f64;

        // Optimal eta balances real and reciprocal space
        // η ≈ (n * π³ / V²)^(1/6) for equal convergence
        let eta = (n_sites * PI.powi(3) / volume.powi(2)).powf(1.0 / 6.0);

        // Cutoffs based on desired accuracy
        // Error in real space ~ erfc(η * r_cut) / r_cut
        // Error in reciprocal space ~ exp(-k_cut² / 4η²) / k_cut²
        let log_acc = (-accuracy.log10()).max(3.0);
        let real_space_cutoff = (log_acc / eta).sqrt() * 2.0;
        let recip_space_cutoff = 2.0 * eta * log_acc.sqrt();

        Self {
            eta,
            real_space_cutoff,
            recip_space_cutoff,
        }
    }
}

/// Result of Ewald summation.
#[derive(Debug, Clone)]
pub struct EwaldResult {
    /// Total electrostatic energy in eV.
    pub total_energy: f64,
    /// Real-space contribution in eV.
    pub real_energy: f64,
    /// Reciprocal-space contribution in eV.
    pub recip_energy: f64,
    /// Self-energy correction in eV.
    pub self_energy: f64,
    /// Point energy correction (for charged systems) in eV.
    pub point_energy: f64,
}

/// Compute the complementary error function erfc(x).
fn erfc(x: f64) -> f64 {
    // Using approximation from Abramowitz & Stegun (7.1.26)
    let t = 1.0 / (1.0 + 0.3275911 * x.abs());
    let tau = t
        * (0.254829592
            + t * (-0.284496736
                + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    let result = tau * (-x * x).exp();
    if x >= 0.0 {
        result
    } else {
        2.0 - result
    }
}

/// Compute Ewald summation for a structure with given charges.
///
/// # Arguments
///
/// * `structure` - The crystal structure
/// * `charges` - Charge for each site (in elementary charges)
/// * `config` - Ewald configuration parameters
///
/// # Returns
///
/// `EwaldResult` containing energy breakdown.
pub fn compute_ewald_energy(
    structure: &Structure,
    charges: &[f64],
    config: &EwaldConfig,
) -> EwaldResult {
    let n_sites = structure.num_sites();
    assert_eq!(
        charges.len(),
        n_sites,
        "Number of charges must match number of sites"
    );

    let lattice = &structure.lattice;
    let volume = lattice.volume();
    let cart_coords = structure.cart_coords();
    let eta = config.eta;

    // Get lattice vectors
    let m = lattice.matrix();
    let a = Vector3::new(m[(0, 0)], m[(0, 1)], m[(0, 2)]);
    let b = Vector3::new(m[(1, 0)], m[(1, 1)], m[(1, 2)]);
    let c = Vector3::new(m[(2, 0)], m[(2, 1)], m[(2, 2)]);

    // ==========================================================================
    // Real-space sum
    // ==========================================================================
    // E_real = (1/2) Σ_{i,j,L≠(0,i=j)} q_i q_j erfc(η|r_ij + L|) / |r_ij + L|

    let real_cutoff = config.real_space_cutoff;
    let mut real_energy = 0.0;

    // Determine search range for lattice translations
    let max_n = [
        (real_cutoff / a.norm()).ceil() as i32 + 1,
        (real_cutoff / b.norm()).ceil() as i32 + 1,
        (real_cutoff / c.norm()).ceil() as i32 + 1,
    ];

    for i in 0..n_sites {
        for j in 0..n_sites {
            let q_i = charges[i];
            let q_j = charges[j];
            let r_ij = cart_coords[j] - cart_coords[i];

            for nx in -max_n[0]..=max_n[0] {
                for ny in -max_n[1]..=max_n[1] {
                    for nz in -max_n[2]..=max_n[2] {
                        // Skip self-interaction at origin
                        if i == j && nx == 0 && ny == 0 && nz == 0 {
                            continue;
                        }

                        let l = (nx as f64) * a + (ny as f64) * b + (nz as f64) * c;
                        let r = r_ij + l;
                        let dist = r.norm();

                        if dist <= real_cutoff && dist > 1e-10 {
                            real_energy += q_i * q_j * erfc(eta * dist) / dist;
                        }
                    }
                }
            }
        }
    }
    real_energy *= 0.5 * COULOMB_CONST;

    // ==========================================================================
    // Reciprocal-space sum
    // ==========================================================================
    // E_recip = (2π/V) Σ_{G≠0} exp(-|G|²/4η²)/|G|² |S(G)|²
    // where S(G) = Σ_i q_i exp(-i G·r_i)

    // Get reciprocal lattice (with 2π factor)
    let recip_lattice = lattice.reciprocal();
    let rm = recip_lattice.matrix();
    let g1 = Vector3::new(rm[(0, 0)], rm[(0, 1)], rm[(0, 2)]);
    let g2 = Vector3::new(rm[(1, 0)], rm[(1, 1)], rm[(1, 2)]);
    let g3 = Vector3::new(rm[(2, 0)], rm[(2, 1)], rm[(2, 2)]);

    let recip_cutoff = config.recip_space_cutoff;
    let mut recip_energy = 0.0;

    // Determine search range for reciprocal lattice vectors
    let max_g = [
        (recip_cutoff / g1.norm()).ceil() as i32 + 1,
        (recip_cutoff / g2.norm()).ceil() as i32 + 1,
        (recip_cutoff / g3.norm()).ceil() as i32 + 1,
    ];

    for gx in -max_g[0]..=max_g[0] {
        for gy in -max_g[1]..=max_g[1] {
            for gz in -max_g[2]..=max_g[2] {
                // Skip G = 0
                if gx == 0 && gy == 0 && gz == 0 {
                    continue;
                }

                let g = (gx as f64) * g1 + (gy as f64) * g2 + (gz as f64) * g3;
                let g_norm_sq = g.norm_squared();
                let g_norm = g_norm_sq.sqrt();

                if g_norm <= recip_cutoff {
                    // Compute structure factor S(G) = Σ_i q_i exp(-i G·r_i)
                    let mut s_real = 0.0;
                    let mut s_imag = 0.0;

                    for (i, pos) in cart_coords.iter().enumerate() {
                        let g_dot_r = g.dot(pos);
                        s_real += charges[i] * g_dot_r.cos();
                        s_imag += charges[i] * g_dot_r.sin();
                    }

                    let s_norm_sq = s_real * s_real + s_imag * s_imag;

                    // Add contribution: exp(-|G|²/4η²)/|G|² |S(G)|²
                    let exp_factor = (-g_norm_sq / (4.0 * eta * eta)).exp();
                    recip_energy += exp_factor / g_norm_sq * s_norm_sq;
                }
            }
        }
    }
    recip_energy *= 2.0 * PI / volume * COULOMB_CONST;

    // ==========================================================================
    // Self-energy correction
    // ==========================================================================
    // E_self = -η/√π Σ_i q_i²

    let mut self_energy = 0.0;
    for &q in charges {
        self_energy += q * q;
    }
    self_energy *= -eta / PI.sqrt() * COULOMB_CONST;

    // ==========================================================================
    // Point energy (for charged systems)
    // ==========================================================================
    // E_point = -π/(2η²V) (Σ_i q_i)²

    let total_charge: f64 = charges.iter().sum();
    let point_energy = -PI / (2.0 * eta * eta * volume) * total_charge * total_charge * COULOMB_CONST;

    let total_energy = real_energy + recip_energy + self_energy + point_energy;

    EwaldResult {
        total_energy,
        real_energy,
        recip_energy,
        self_energy,
        point_energy,
    }
}

/// Compute Ewald energy using oxidation states as charges.
///
/// This is a convenience function that extracts charges from the
/// species oxidation states in the structure.
///
/// # Arguments
///
/// * `structure` - The crystal structure with oxidation states
/// * `config` - Ewald configuration parameters
///
/// # Returns
///
/// `EwaldResult` containing energy breakdown, or None if oxidation states are missing.
pub fn compute_ewald_from_oxidation_states(
    structure: &Structure,
    config: &EwaldConfig,
) -> Option<EwaldResult> {
    let charges: Vec<f64> = structure
        .site_occupancies
        .iter()
        .map(|so| {
            // Use dominant species oxidation state
            so.dominant_species()
                .oxidation_state
                .map(|ox| ox as f64)
                .unwrap_or(0.0)
        })
        .collect();

    // Check if all charges are zero (no oxidation states)
    if charges.iter().all(|&q| q.abs() < 1e-10) {
        return None;
    }

    Some(compute_ewald_energy(structure, &charges, config))
}

/// Compute Madelung constant for a crystal structure.
///
/// The Madelung constant M is defined such that:
/// E = M * q² / r₀
///
/// where q is the charge magnitude and r₀ is the nearest-neighbor distance.
///
/// # Arguments
///
/// * `structure` - The crystal structure
/// * `charges` - Charges for each site
/// * `reference_distance` - Reference distance r₀ (typically nearest-neighbor distance)
/// * `config` - Ewald configuration parameters
///
/// # Returns
///
/// The Madelung constant (dimensionless).
pub fn compute_madelung_constant(
    structure: &Structure,
    charges: &[f64],
    reference_distance: f64,
    config: &EwaldConfig,
) -> f64 {
    let result = compute_ewald_energy(structure, charges, config);

    // E = M * k * q² / r₀  where k = COULOMB_CONST
    // M = E * r₀ / (k * q²)
    // For structures with unit charges, q = 1
    let q_ref = charges.iter().map(|q| q.abs()).fold(0.0, f64::max);
    if q_ref.abs() < 1e-10 {
        return 0.0;
    }

    result.total_energy * reference_distance / (COULOMB_CONST * q_ref * q_ref)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lattice::Lattice;
    use crate::species::{SiteOccupancy, Species};

    fn make_nacl() -> Structure {
        // NaCl rock salt structure
        let lattice = Lattice::cubic(5.64);
        let na = Species::new(crate::element::Element::Na, Some(1));
        let cl = Species::new(crate::element::Element::Cl, Some(-1));

        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.5, 0.5, 0.5),
        ];
        let site_occupancies = vec![SiteOccupancy::ordered(na), SiteOccupancy::ordered(cl)];

        Structure::try_new_from_occupancies(lattice, site_occupancies, frac_coords).unwrap()
    }

    #[test]
    fn test_erfc() {
        // erfc(0) = 1
        assert!((erfc(0.0) - 1.0).abs() < 1e-6);

        // erfc(∞) → 0
        assert!(erfc(5.0) < 1e-10);

        // erfc(-x) = 2 - erfc(x)
        let x = 1.5;
        assert!((erfc(-x) - (2.0 - erfc(x))).abs() < 1e-6);
    }

    #[test]
    fn test_ewald_nacl() {
        let nacl = make_nacl();
        let charges = vec![1.0, -1.0];

        let config = EwaldConfig::default();
        let result = compute_ewald_energy(&nacl, &charges, &config);

        // NaCl Madelung constant is approximately 1.7476
        // The energy should be negative (attractive)
        assert!(result.total_energy < 0.0);

        // Check that all components are computed
        assert!(!result.real_energy.is_nan());
        assert!(!result.recip_energy.is_nan());
        assert!(!result.self_energy.is_nan());
    }

    #[test]
    fn test_ewald_neutral_system() {
        let nacl = make_nacl();
        let charges = vec![1.0, -1.0];

        let config = EwaldConfig::default();
        let result = compute_ewald_energy(&nacl, &charges, &config);

        // For a neutral system, point_energy should be zero
        assert!(result.point_energy.abs() < 1e-10);
    }

    #[test]
    fn test_auto_optimize() {
        let nacl = make_nacl();
        let config = EwaldConfig::auto_optimize(&nacl, 1e-6);

        // Check that parameters are reasonable
        assert!(config.eta > 0.0);
        assert!(config.real_space_cutoff > 0.0);
        assert!(config.recip_space_cutoff > 0.0);
    }
}

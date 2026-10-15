//! Independent gradient model based on Hirshfeld partition (IGMH;
//! Lu & Chen, J. Comput. Chem. 43, 539 (2022)). Port of Multiwfn's
//! IGMgrad_Hirsh / delta_g_inter_Hirsh / proatmgrad (function.f90) with the
//! built-in free-atom densities of atmraddens.f90 and the 4-point Lagrange
//! interpolation of lagintpol (util.f90).

use crate::atom_densities::{DENSITIES, RADIAL_POSITIONS};
use crate::wavefunction::Wavefunction;

/// Free-atom density and dρ/dr of element `z` at distance `r` (Bohr).
pub fn free_atom(z: u32, r: f64) -> (f64, f64) {
    let Some(vals) = DENSITIES.get(z as usize) else {
        return (0.0, 0.0);
    };
    let n = vals.len();
    if n < 4 {
        return (0.0, 0.0);
    }
    let pos = &RADIAL_POSITIONS[..n];
    if r <= pos[0] {
        let d = (vals[1] - vals[0]) / (pos[1] - pos[0]);
        return (vals[0] - (pos[0] - r) * d, d);
    }
    if r >= pos[n - 1] {
        return (0.0, 0.0);
    }
    // first point beyond r, then the four points around it
    let i = pos.partition_point(|&p| p <= r);
    let (mut start, mut end) = (i as isize - 2, i + 1);
    if start < 0 {
        start += 1;
        end += 1;
    } else if end >= n {
        start -= 1;
        end -= 1;
    }
    let start = start as usize;
    let mut val = 0.0;
    let mut der = 0.0;
    for m in start..=end {
        let mut poly = 1.0;
        for j in start..=end {
            if j != m {
                poly *= (r - pos[j]) / (pos[m] - pos[j]);
            }
        }
        val += vals[m] * poly;
        let mut sum = 0.0;
        for l in start..=end {
            if l == m {
                continue;
            }
            let mut p = 1.0;
            for j in start..=end {
                if j != m && j != l {
                    p *= (r - pos[j]) / (pos[m] - pos[j]);
                }
            }
            sum += p / (pos[m] - pos[l]);
        }
        der += vals[m] * sum;
    }
    (val, der)
}

/// Scratch for per-atom free densities and gradients.
pub struct IgmhScratch {
    rho: Vec<f64>,
    grad: Vec<[f64; 3]>,
}

impl IgmhScratch {
    pub fn new(n_atoms: usize) -> Self {
        Self {
            rho: vec![0.0; n_atoms],
            grad: vec![[0.0; 3]; n_atoms],
        }
    }
}

impl Wavefunction {
    /// δg_inter at `r` given the real density and gradient there:
    /// Σ_f |g_f| − |Σ_f g_f| with IGMH fragment gradients g_f.
    pub fn delta_g_inter(
        &self,
        r: [f64; 3],
        rho: f64,
        grad: &[f64; 3],
        fragments: &[Vec<usize>],
        s: &mut IgmhScratch,
    ) -> f64 {
        let mut prorho = 0.0;
        let mut prograd = [0.0; 3];
        for (k, a) in self.atoms.iter().enumerate() {
            let d = [r[0] - a.xyz[0], r[1] - a.xyz[1], r[2] - a.xyz[2]];
            let dist = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            let (v, dv) = free_atom(a.z, dist);
            s.rho[k] = v;
            s.grad[k] = if dist > 0.0 {
                [dv * d[0] / dist, dv * d[1] / dist, dv * d[2] / dist]
            } else {
                [0.0; 3]
            };
            prorho += v;
            for i in 0..3 {
                prograd[i] += s.grad[k][i];
            }
        }
        let mut total = [0.0; 3];
        let mut sum_norm = 0.0;
        for frag in fragments {
            let mut g = [0.0; 3];
            for &k in frag {
                if prorho == 0.0 {
                    continue;
                }
                let w = s.rho[k] / prorho;
                for i in 0..3 {
                    // IGMH "special free-state atomic gradient" (t1 − t2 − t3)
                    g[i] += w * grad[i] - rho / prorho * s.grad[k][i]
                        + rho * s.rho[k] / (prorho * prorho) * prograd[i];
                }
            }
            sum_norm += (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
            for i in 0..3 {
                total[i] += g[i];
            }
        }
        sum_norm - (total[0] * total[0] + total[1] * total[1] + total[2] * total[2]).sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_atoms_integrate_to_z() {
        // 4π ∫ r² ρ(r) dr on a fine radial grid
        for z in [1u32, 6, 8, 17, 26, 35, 53, 79, 92] {
            let mut n = 0.0;
            let h = 1e-4;
            let mut r = h / 2.0;
            while r < 20.0 {
                n += 4.0 * std::f64::consts::PI * r * r * free_atom(z, r).0 * h;
                r += h;
            }
            assert!((n - z as f64).abs() < 0.02 * z as f64, "Z={z}: {n}");
        }
    }

    #[test]
    fn derivative_matches_finite_difference() {
        for (z, r) in [(6u32, 0.8), (8, 1.7), (26, 0.3)] {
            let h = 1e-6;
            let fd = (free_atom(z, r + h).0 - free_atom(z, r - h).0) / (2.0 * h);
            let d = free_atom(z, r).1;
            assert!(
                (fd - d).abs() < 1e-4 * d.abs().max(1e-3),
                "Z={z} r={r}: {fd} vs {d}"
            );
        }
    }
}

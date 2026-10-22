//! Analytic overlap integrals, used for the load-time sanity check
//! Tr(P S) = N_electrons that Multiwfn also performs (genSbas_curr).

use crate::wavefunction::Wavefunction;

fn binom(n: u32, k: u32) -> f64 {
    (0..k).fold(1.0, |acc, i| acc * (n - i) as f64 / (i + 1) as f64)
}

fn double_factorial(n: i32) -> f64 {
    let mut r = 1.0;
    let mut k = n;
    while k > 1 {
        r *= k as f64;
        k -= 2;
    }
    r
}

/// ∫ (x-A)^i (x-B)^j e^{-p (x-P)²} dx without the Gaussian-product prefactor.
fn overlap_1d(i: u32, j: u32, pa: f64, pb: f64, p: f64) -> f64 {
    let mut s = 0.0;
    for k in 0..=i {
        for l in 0..=j {
            let n = k + l;
            if n % 2 == 1 {
                continue;
            }
            let moment = double_factorial(n as i32 - 1) / (2.0 * p).powi((n / 2) as i32)
                * (std::f64::consts::PI / p).sqrt();
            s += binom(i, k)
                * binom(j, l)
                * pa.powi((i - k) as i32)
                * pb.powi((j - l) as i32)
                * moment;
        }
    }
    s
}

impl Wavefunction {
    /// Overlap matrix of the Cartesian functions (n × n, row-major).
    pub fn overlap_matrix(&self) -> Vec<f64> {
        let n = self.n_functions;
        let mut s = vec![0.0; n * n];
        for sa in &self.shells {
            let a_xyz = self.atoms[sa.center].xyz;
            for sb in &self.shells {
                let b_xyz = self.atoms[sb.center].xyz;
                let ab2: f64 = (0..3).map(|k| (a_xyz[k] - b_xyz[k]).powi(2)).sum();
                for (&ea, &ca) in sa.exps.iter().zip(&sa.coefs) {
                    for (&eb, &cb) in sb.exps.iter().zip(&sb.coefs) {
                        let p = ea + eb;
                        let pre = ca * cb * (-ea * eb / p * ab2).exp();
                        let pp: [f64; 3] =
                            std::array::from_fn(|k| (ea * a_xyz[k] + eb * b_xyz[k]) / p);
                        for (ka, comp_a) in sa.comps.iter().enumerate() {
                            for (kb, comp_b) in sb.comps.iter().enumerate() {
                                let mut v = pre;
                                for k in 0..3 {
                                    v *= overlap_1d(
                                        comp_a[k],
                                        comp_b[k],
                                        pp[k] - a_xyz[k],
                                        pp[k] - b_xyz[k],
                                        p,
                                    );
                                }
                                s[(sa.first + ka) * n + sb.first + kb] += v;
                            }
                        }
                    }
                }
            }
        }
        s
    }

    /// Tr(P S): the number of electrons the orbitals describe (EDF excluded).
    pub fn trace_ps(&self) -> f64 {
        let n = self.n_functions;
        let s = self.overlap_matrix();
        let mut t = 0.0;
        for o in &self.orbitals {
            if o.occupation == 0.0 {
                continue;
            }
            let c = &o.coefs;
            let mut q = 0.0;
            for i in 0..n {
                if c[i] == 0.0 {
                    continue;
                }
                let row = &s[i * n..(i + 1) * n];
                q += c[i] * row.iter().zip(c).map(|(a, b)| a * b).sum::<f64>();
            }
            t += o.occupation * q;
        }
        t
    }

    /// Electrons the file actually describes: Tr(P S) plus EDF core electrons.
    /// Multiwfn warns when this differs from the electron count by > 0.01.
    pub fn described_electrons(&self) -> f64 {
        let edf = if self.edf.exps.is_empty() {
            0.0
        } else {
            self.atoms.iter().map(|a| a.z as f64 - a.charge).sum()
        };
        self.trace_ps() + edf
    }
}

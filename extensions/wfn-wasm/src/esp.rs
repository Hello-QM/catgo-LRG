//! Electrostatic potential V(r) = Σ_A Z_A/|r − R_A| − ∫ ρ(r')/|r − r'| dr'
//! (totesp in Multiwfn's function.f90).
//!
//! The electronic part uses McMurchie–Davidson nuclear-attraction integrals
//! written for CatGo (Multiwfn's own ESP code relies on the separate LIBRETA
//! library, which is not used here). The density matrix is folded into
//! Hermite coefficients once per primitive pair, so each point costs one
//! Hermite-integral table per pair.

use crate::wavefunction::Wavefunction;

/// Pairs whose prefactor × density weight falls below this are skipped.
const PAIR_CUTOFF: f64 = 1e-12;
const MAX_L: usize = 10;

struct PrimPair {
    p: f64,
    center: [f64; 3],
    l: usize,
    /// (t, u, v, coefficient) with 2π/p, the Gaussian-product prefactor,
    /// contraction coefficients and density matrix folded in
    terms: Vec<(u8, u8, u8, f64)>,
}

pub struct EspEngine {
    pairs: Vec<PrimPair>,
    nuclei: Vec<([f64; 3], f64)>,
    /// s-type EDF: (centre, exponent, coefficient)
    edf: Vec<([f64; 3], f64, f64)>,
}

/// Hermite expansion coefficients E_t^{ij} (t = 0..i+j) of a 1D Gaussian
/// product, without the exp(-μ X²) prefactor.
fn hermite_1d(la: usize, lb: usize, p: f64, pa: f64, pb: f64) -> Vec<Vec<Vec<f64>>> {
    // e[i][j][t]
    let mut e = vec![vec![vec![0.0; la + lb + 2]; lb + 1]; la + 1];
    e[0][0][0] = 1.0;
    let inv2p = 0.5 / p;
    for i in 0..=la {
        for j in 0..=lb {
            if i == 0 && j == 0 {
                continue;
            }
            let (prev, x) = if i > 0 {
                (&e[i - 1][j], pa)
            } else {
                (&e[i][j - 1], pb)
            };
            let prev = prev.clone();
            for t in 0..=(i + j) {
                let mut v = x * prev[t];
                if t > 0 {
                    v += inv2p * prev[t - 1];
                }
                if t + 1 < prev.len() {
                    v += (t + 1) as f64 * prev[t + 1];
                }
                e[i][j][t] = v;
            }
        }
    }
    e
}

// ── Boys function ──

const BOYS_STEP: f64 = 0.05;
const BOYS_TMAX: f64 = 36.0;
const BOYS_NMAX: usize = MAX_L + 7;

fn boys_series(n: usize, t: f64) -> f64 {
    // F_n(T) = e^{-T} Σ_k (2T)^k / ((2n+1)(2n+3)…(2n+2k+1))
    let mut term = 1.0 / (2 * n + 1) as f64;
    let mut sum = term;
    let mut k = 1;
    loop {
        term *= 2.0 * t / (2 * n + 2 * k + 1) as f64;
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
        k += 1;
    }
    sum * (-t).exp()
}

struct BoysTable {
    values: Vec<f64>, // [k * (BOYS_NMAX+1) + n]
}

impl BoysTable {
    fn new() -> Self {
        let nk = (BOYS_TMAX / BOYS_STEP) as usize + 2;
        let mut values = vec![0.0; nk * (BOYS_NMAX + 1)];
        for k in 0..nk {
            let t = k as f64 * BOYS_STEP;
            values[k * (BOYS_NMAX + 1) + BOYS_NMAX] = boys_series(BOYS_NMAX, t);
            let e = (-t).exp();
            for n in (0..BOYS_NMAX).rev() {
                let next = values[k * (BOYS_NMAX + 1) + n + 1];
                values[k * (BOYS_NMAX + 1) + n] = (2.0 * t * next + e) / (2 * n + 1) as f64;
            }
        }
        Self { values }
    }

    /// F_0..=F_m(T) into `out`.
    fn eval(&self, m: usize, t: f64, out: &mut [f64; MAX_L + 1]) {
        if t >= BOYS_TMAX {
            // asymptotic: F_0 = √(π/T)/2 and F_{n+1} = (2n+1) F_n / 2T; the
            // dropped e^{-T} terms are below 1e-15 relative here
            out[0] = 0.5 * (std::f64::consts::PI / t).sqrt();
            let inv = 0.5 / t;
            for n in 0..m {
                out[n + 1] = (2 * n + 1) as f64 * out[n] * inv;
            }
            return;
        }
        // 6-term Taylor expansion around the nearest tabulated point:
        // F_n(T) = Σ_j F_{n+j}(T_k) (T_k − T)^j / j!
        let k = (t / BOYS_STEP + 0.5) as usize;
        let dt = k as f64 * BOYS_STEP - t;
        let row = &self.values[k * (BOYS_NMAX + 1)..(k + 1) * (BOYS_NMAX + 1)];
        let c = [
            1.0,
            dt,
            dt * dt / 2.0,
            dt * dt * dt / 6.0,
            dt.powi(4) / 24.0,
            dt.powi(5) / 120.0,
        ];
        for n in 0..=m {
            let r = &row[n..n + 6];
            out[n] = r[0] + c[1] * r[1] + c[2] * r[2] + c[3] * r[3] + c[4] * r[4] + c[5] * r[5];
        }
    }
}

/// Scratch for Hermite integrals R_{tuv}^{(n)}.
pub struct EspScratch {
    boys: [f64; MAX_L + 1],
    /// r[n][t][u][v] flattened
    r: Vec<f64>,
}

const DIM: usize = MAX_L + 1;

impl EspScratch {
    pub fn new() -> Self {
        Self {
            boys: [0.0; MAX_L + 1],
            r: vec![0.0; DIM * DIM * DIM * DIM],
        }
    }
}

impl Default for EspScratch {
    fn default() -> Self {
        Self::new()
    }
}

/// Index into R^{(n)}_{tuv} for a pair of total angular momentum l (d = l + 1),
/// kept compact so the table stays in cache.
#[inline]
fn idx(d: usize, n: usize, t: usize, u: usize, v: usize) -> usize {
    ((n * d + t) * d + u) * d + v
}

fn boys_table() -> &'static BoysTable {
    use std::sync::OnceLock;
    static TABLE: OnceLock<BoysTable> = OnceLock::new();
    TABLE.get_or_init(BoysTable::new)
}

impl EspEngine {
    pub fn new(wf: &Wavefunction) -> Self {
        let n = wf.n_functions;
        // density matrix over Cartesian functions
        let mut dm = vec![0.0; n * n];
        for o in &wf.orbitals {
            if o.occupation == 0.0 {
                continue;
            }
            let c = &o.coefs;
            for i in 0..n {
                let ci = o.occupation * c[i];
                if ci == 0.0 {
                    continue;
                }
                let row = &mut dm[i * n..(i + 1) * n];
                for (d, &cj) in row.iter_mut().zip(c) {
                    *d += ci * cj;
                }
            }
        }

        let mut pairs = Vec::new();
        let shells = &wf.shells;
        for (ia, sa) in shells.iter().enumerate() {
            let a = wf.atoms[sa.center].xyz;
            for (ib, sb) in shells.iter().enumerate().skip(ia) {
                let b = wf.atoms[sb.center].xyz;
                let ab2: f64 = (0..3).map(|k| (a[k] - b[k]).powi(2)).sum();
                // density block and its largest element
                let block: Vec<f64> = sa
                    .comps
                    .iter()
                    .enumerate()
                    .flat_map(|(ka, _)| {
                        let row = (sa.first + ka) * n;
                        sb.comps
                            .iter()
                            .enumerate()
                            .map(move |(kb, _)| row + sb.first + kb)
                    })
                    .map(|k| dm[k])
                    .collect();
                let pmax = block.iter().fold(0.0f64, |m, v| m.max(v.abs()));
                if pmax == 0.0 {
                    continue;
                }
                let sym = if ia == ib { 1.0 } else { 2.0 };
                let (la, lb) = (sa.l as usize, sb.l as usize);
                for (&ea, &ca) in sa.exps.iter().zip(&sa.coefs) {
                    for (&eb, &cb) in sb.exps.iter().zip(&sb.coefs) {
                        let p = ea + eb;
                        let k_ab = (-ea * eb / p * ab2).exp();
                        let pref = sym * ca * cb * k_ab * 2.0 * std::f64::consts::PI / p;
                        if (pref * pmax).abs() < PAIR_CUTOFF {
                            continue;
                        }
                        let pc: [f64; 3] = std::array::from_fn(|k| (ea * a[k] + eb * b[k]) / p);
                        let e: Vec<Vec<Vec<Vec<f64>>>> = (0..3)
                            .map(|k| hermite_1d(la, lb, p, pc[k] - a[k], pc[k] - b[k]))
                            .collect();
                        let l = la + lb;
                        let mut d = vec![0.0; (l + 1) * (l + 1) * (l + 1)];
                        let mut q = 0;
                        for ca_ in &sa.comps {
                            for cb_ in &sb.comps {
                                let w = block[q] * pref;
                                q += 1;
                                if w == 0.0 {
                                    continue;
                                }
                                let ex = &e[0][ca_[0] as usize][cb_[0] as usize];
                                let ey = &e[1][ca_[1] as usize][cb_[1] as usize];
                                let ez = &e[2][ca_[2] as usize][cb_[2] as usize];
                                for (t, &xt) in ex.iter().enumerate().take(l + 1) {
                                    if xt == 0.0 {
                                        continue;
                                    }
                                    for (u, &yu) in ey.iter().enumerate().take(l + 1 - t) {
                                        if yu == 0.0 {
                                            continue;
                                        }
                                        for (v, &zv) in ez.iter().enumerate().take(l + 1 - t - u) {
                                            d[(t * (l + 1) + u) * (l + 1) + v] += w * xt * yu * zv;
                                        }
                                    }
                                }
                            }
                        }
                        let mut terms = Vec::new();
                        for t in 0..=l {
                            for u in 0..=(l - t) {
                                for v in 0..=(l - t - u) {
                                    let c = d[(t * (l + 1) + u) * (l + 1) + v];
                                    if c != 0.0 {
                                        terms.push((t as u8, u as u8, v as u8, c));
                                    }
                                }
                            }
                        }
                        if !terms.is_empty() {
                            pairs.push(PrimPair {
                                p,
                                center: pc,
                                l,
                                terms,
                            });
                        }
                    }
                }
            }
        }

        let edf = (0..wf.edf.exps.len())
            .map(|k| {
                (
                    wf.atoms[wf.edf.centers[k]].xyz,
                    wf.edf.exps[k],
                    wf.edf.coefs[k],
                )
            })
            .collect();
        Self {
            pairs,
            nuclei: wf.atoms.iter().map(|a| (a.xyz, a.charge)).collect(),
            edf,
        }
    }

    pub fn n_pairs(&self) -> usize {
        self.pairs.len()
    }

    /// Potential of the nuclei (Multiwfn's nucesp; 1000 on a nucleus).
    pub fn nuclear(&self, r: [f64; 3]) -> f64 {
        let mut v = 0.0;
        for (c, q) in &self.nuclei {
            let d2 = (r[0] - c[0]).powi(2) + (r[1] - c[1]).powi(2) + (r[2] - c[2]).powi(2);
            if d2 == 0.0 {
                return 1000.0;
            }
            v += q / d2.sqrt();
        }
        v
    }

    /// Potential of the electrons (negative).
    pub fn electronic(&self, r: [f64; 3], s: &mut EspScratch) -> f64 {
        let boys = boys_table();
        let mut v = 0.0;
        for pp in &self.pairs {
            let x = [
                pp.center[0] - r[0],
                pp.center[1] - r[1],
                pp.center[2] - r[2],
            ];
            let t_arg = pp.p * (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]);
            let l = pp.l;
            let d = l + 1;
            if l == 0 {
                boys.eval(0, t_arg, &mut s.boys);
                v += pp.terms[0].3 * s.boys[0];
                continue;
            }
            boys.eval(l, t_arg, &mut s.boys);
            // R^{(n)}_{000} = (-2p)^n F_n
            let mut f = 1.0;
            for n in 0..=l {
                s.r[idx(d, n, 0, 0, 0)] = f * s.boys[n];
                f *= -2.0 * pp.p;
            }
            // build R^{(n)}_{tuv} for t+u+v ≤ l-n, downward in n
            for n in (0..l).rev() {
                let m = l - n;
                for t in 0..=m {
                    for u in 0..=(m - t) {
                        for w in 0..=(m - t - u) {
                            if t + u + w == 0 {
                                continue;
                            }
                            let val = if t > 0 {
                                let mut a = x[0] * s.r[idx(d, n + 1, t - 1, u, w)];
                                if t > 1 {
                                    a += (t - 1) as f64 * s.r[idx(d, n + 1, t - 2, u, w)];
                                }
                                a
                            } else if u > 0 {
                                let mut a = x[1] * s.r[idx(d, n + 1, t, u - 1, w)];
                                if u > 1 {
                                    a += (u - 1) as f64 * s.r[idx(d, n + 1, t, u - 2, w)];
                                }
                                a
                            } else {
                                let mut a = x[2] * s.r[idx(d, n + 1, t, u, w - 1)];
                                if w > 1 {
                                    a += (w - 1) as f64 * s.r[idx(d, n + 1, t, u, w - 2)];
                                }
                                a
                            };
                            s.r[idx(d, n, t, u, w)] = val;
                        }
                    }
                }
            }
            for &(t, u, w, c) in &pp.terms {
                v += c * s.r[idx(d, 0, t as usize, u as usize, w as usize)];
            }
        }
        // EDF core density: c (π/α)^{3/2} erf(√α R)/R
        for (c, a, q) in &self.edf {
            let d = ((r[0] - c[0]).powi(2) + (r[1] - c[1]).powi(2) + (r[2] - c[2]).powi(2)).sqrt();
            let norm = q * (std::f64::consts::PI / a).powf(1.5);
            v += if d < 1e-10 {
                norm * 2.0 * (a / std::f64::consts::PI).sqrt()
            } else {
                norm * erf(a.sqrt() * d) / d
            };
        }
        -v
    }

    pub fn total(&self, r: [f64; 3], s: &mut EspScratch) -> f64 {
        self.nuclear(r) + self.electronic(r, s)
    }
}

/// erf via the Boys function: erf(x) = 2x/√π · F_0(x²).
fn erf(x: f64) -> f64 {
    let t = x * x;
    let mut f = [0.0; MAX_L + 1];
    boys_table().eval(0, t, &mut f);
    2.0 * x / std::f64::consts::PI.sqrt() * f[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boys_matches_series() {
        let table = boys_table();
        let mut out = [0.0; MAX_L + 1];
        for &t in &[0.0, 1e-6, 0.37, 2.5, 7.77, 18.3, 35.9, 36.0, 50.0, 400.0] {
            table.eval(MAX_L, t, &mut out);
            for n in 0..=MAX_L {
                let want = if t < 60.0 {
                    boys_series(n, t)
                } else {
                    // large T: (2n-1)!!/2^{n+1} √(π/T^{2n+1})
                    let mut df = 1.0;
                    let mut k = 2 * n as i64 - 1;
                    while k > 1 {
                        df *= k as f64;
                        k -= 2;
                    }
                    df / 2f64.powi(n as i32 + 1)
                        * (std::f64::consts::PI / t.powi(2 * n as i32 + 1)).sqrt()
                };
                assert!(
                    (out[n] - want).abs() <= 1e-13 * want.abs().max(1e-3),
                    "F_{n}({t}) {} vs {want}",
                    out[n]
                );
            }
        }
        assert!((erf(0.5) - 0.520_499_877_813_046_5).abs() < 1e-14);
    }
}

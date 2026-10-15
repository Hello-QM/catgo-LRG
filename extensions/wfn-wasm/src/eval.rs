//! Real-space evaluation of orbitals and the electron density.
//!
//! Same quantities as Multiwfn's orbderv / calchessmat_dens / IRI_s2lr
//! (function.f90): orbital values, ρ, ∇ρ and the Hessian of ρ, with
//! primitives skipped where α r² > 40 (Multiwfn's expcutoff = -40).
//!
//! Evaluation is organised per shell: for a primitive x^i e^{-α x²} every
//! derivative is a polynomial in α, so with E_n = Σ_k c_k α_k^n e^{-α_k r²}
//! the derivatives of a contracted function up to second order need only
//! E_0, E_1 and E_2, shared by all components of the shell.

use crate::wavefunction::Wavefunction;

const EXP_CUTOFF: f64 = 40.0;

/// Derivative order requested from the basis.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Order {
    Value = 0,
    Gradient = 1,
    Hessian = 2,
}

/// Per-point buffers for basis-function values and derivatives.
pub struct BasisValues {
    pub active: Vec<usize>,
    pub v: Vec<f64>,
    /// gradient: x, y, z
    pub g: [Vec<f64>; 3],
    /// Hessian: xx, yy, zz, xy, xz, yz
    pub h: [Vec<f64>; 6],
    /// Orbital values and derivatives (scratch for `density_at`)
    mo: Vec<f64>,
}

/// Occupied orbitals with coefficients transposed (function-major), so the
/// orbital sums run over contiguous memory.
pub struct Occupied {
    pub occ: Vec<f64>,
    ct: Vec<f64>,
}

impl BasisValues {
    pub fn new(n: usize) -> Self {
        Self {
            active: Vec::with_capacity(n),
            v: vec![0.0; n],
            g: std::array::from_fn(|_| vec![0.0; n]),
            h: std::array::from_fn(|_| vec![0.0; n]),
            mo: Vec::new(),
        }
    }
}

/// Polynomial factors of one Cartesian axis: value, first and second
/// derivative of x^i e^{-α x²} divided by e^{-α x²}, as coefficients of α^0..α^2.
#[derive(Clone, Copy, Default)]
struct Axis {
    v: f64,
    d1: [f64; 2],
    d2: [f64; 3],
}

fn axis(pw: &[f64; 9], i: u32) -> Axis {
    let i = i as usize;
    let p = |n: isize| if n < 0 { 0.0 } else { pw[n as usize] };
    let fi = i as f64;
    let ii = i as isize;
    Axis {
        v: pw[i],
        d1: [fi * p(ii - 1), -2.0 * p(ii + 1)],
        d2: [
            fi * (fi - 1.0) * p(ii - 2),
            -2.0 * (2.0 * fi + 1.0) * pw[i],
            4.0 * p(ii + 2),
        ],
    }
}

fn powers(x: f64) -> [f64; 9] {
    let mut p = [1.0; 9];
    for k in 1..9 {
        p[k] = p[k - 1] * x;
    }
    p
}

impl Wavefunction {
    /// Values (and derivatives up to `order`) of all Cartesian basis
    /// functions at `r` (Bohr). Only shells with an unscreened primitive are
    /// listed in `out.active`.
    pub fn basis_at(&self, r: [f64; 3], order: Order, out: &mut BasisValues) {
        out.active.clear();
        let mut last_center = usize::MAX;
        let mut r2 = 0.0;
        let (mut px, mut py, mut pz) = ([1.0; 9], [1.0; 9], [1.0; 9]);
        for sh in &self.shells {
            if sh.center != last_center {
                let c = self.atoms[sh.center].xyz;
                let d = [r[0] - c[0], r[1] - c[1], r[2] - c[2]];
                r2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
                px = powers(d[0]);
                py = powers(d[1]);
                pz = powers(d[2]);
                last_center = sh.center;
            }
            let mut e = [0.0f64; 3];
            let mut any = false;
            for (&a, &c) in sh.exps.iter().zip(&sh.coefs) {
                let t = a * r2;
                if t > EXP_CUTOFF {
                    continue;
                }
                any = true;
                let ce = c * (-t).exp();
                e[0] += ce;
                if order >= Order::Gradient {
                    e[1] += ce * a;
                    if order >= Order::Hessian {
                        e[2] += ce * a * a;
                    }
                }
            }
            if !any {
                continue;
            }
            for (k, comp) in sh.comps.iter().enumerate() {
                let f = sh.first + k;
                out.active.push(f);
                let (ax, ay, az) = (axis(&px, comp[0]), axis(&py, comp[1]), axis(&pz, comp[2]));
                out.v[f] = ax.v * ay.v * az.v * e[0];
                if order == Order::Value {
                    continue;
                }
                let lin = |p: [f64; 2]| p[0] * e[0] + p[1] * e[1];
                out.g[0][f] = ay.v * az.v * lin(ax.d1);
                out.g[1][f] = ax.v * az.v * lin(ay.d1);
                out.g[2][f] = ax.v * ay.v * lin(az.d1);
                if order == Order::Gradient {
                    continue;
                }
                let quad = |p: [f64; 3]| p[0] * e[0] + p[1] * e[1] + p[2] * e[2];
                let mixed = |a: [f64; 2], b: [f64; 2]| {
                    a[0] * b[0] * e[0] + (a[0] * b[1] + a[1] * b[0]) * e[1] + a[1] * b[1] * e[2]
                };
                out.h[0][f] = ay.v * az.v * quad(ax.d2);
                out.h[1][f] = ax.v * az.v * quad(ay.d2);
                out.h[2][f] = ax.v * ay.v * quad(az.d2);
                out.h[3][f] = az.v * mixed(ax.d1, ay.d1);
                out.h[4][f] = ay.v * mixed(ax.d1, az.d1);
                out.h[5][f] = ax.v * mixed(ay.d1, az.d1);
            }
        }
    }

    /// Value of orbital `mo` (0-based) at `r`.
    pub fn orbital_at(&self, mo: usize, r: [f64; 3], buf: &mut BasisValues) -> f64 {
        self.basis_at(r, Order::Value, buf);
        let c = &self.orbitals[mo].coefs;
        buf.active.iter().map(|&f| c[f] * buf.v[f]).sum()
    }

    /// Occupied orbitals prepared for density evaluation.
    pub fn occupied_set(&self) -> Occupied {
        let idx = self.occupied();
        let n = idx.len();
        let nf = self.n_functions;
        let mut ct = vec![0.0; nf * n];
        for (j, &i) in idx.iter().enumerate() {
            for (f, &c) in self.orbitals[i].coefs.iter().enumerate() {
                ct[f * n + j] = c;
            }
        }
        Occupied {
            occ: idx.iter().map(|&i| self.orbitals[i].occupation).collect(),
            ct,
        }
    }

    /// ρ, ∇ρ and (when `order` is Hessian) the Hessian of ρ at `r`.
    /// Hessian order: xx, yy, zz, xy, xz, yz.
    pub fn density_at(
        &self,
        r: [f64; 3],
        order: Order,
        occ: &Occupied,
        buf: &mut BasisValues,
    ) -> (f64, [f64; 3], [f64; 6]) {
        self.basis_at(r, order, buf);
        let n = occ.occ.len();
        let nd = match order {
            Order::Value => 1,
            Order::Gradient => 4,
            Order::Hessian => 10,
        };
        // mo[d * n + j]: derivative d (value, x, y, z, xx, yy, zz, xy, xz, yz) of orbital j
        buf.mo.clear();
        buf.mo.resize(nd * n, 0.0);
        for &f in &buf.active {
            let row = &occ.ct[f * n..(f + 1) * n];
            let mut basis = [0.0; 10];
            basis[0] = buf.v[f];
            if nd > 1 {
                for a in 0..3 {
                    basis[1 + a] = buf.g[a][f];
                }
            }
            if nd > 4 {
                for a in 0..6 {
                    basis[4 + a] = buf.h[a][f];
                }
            }
            for d in 0..nd {
                let b = basis[d];
                if b == 0.0 {
                    continue;
                }
                let out = &mut buf.mo[d * n..(d + 1) * n];
                for (o, c) in out.iter_mut().zip(row) {
                    *o += c * b;
                }
            }
        }
        let mo = &buf.mo;
        let (mut rho, mut g, mut h) = (0.0, [0.0; 3], [0.0; 6]);
        const PAIRS: [(usize, usize); 6] = [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)];
        for j in 0..n {
            let w = occ.occ[j];
            let v = mo[j];
            rho += w * v * v;
            if nd > 1 {
                let d = [mo[n + j], mo[2 * n + j], mo[3 * n + j]];
                for a in 0..3 {
                    g[a] += 2.0 * w * v * d[a];
                }
                if nd > 4 {
                    for (k, (a, b)) in PAIRS.iter().enumerate() {
                        h[k] += 2.0 * w * (d[*a] * d[*b] + v * mo[(4 + k) * n + j]);
                    }
                }
            }
        }
        self.add_edf(r, order, &mut rho, &mut g, &mut h);
        (rho, g, h)
    }

    /// Core density from s-type EDF primitives (EDFrho in function.f90).
    fn add_edf(
        &self,
        r: [f64; 3],
        order: Order,
        rho: &mut f64,
        g: &mut [f64; 3],
        h: &mut [f64; 6],
    ) {
        let edf = &self.edf;
        for k in 0..edf.exps.len() {
            let c = self.atoms[edf.centers[k]].xyz;
            let d = [r[0] - c[0], r[1] - c[1], r[2] - c[2]];
            let r2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
            let a = edf.exps[k];
            if a * r2 > EXP_CUTOFF {
                continue;
            }
            let ce = edf.coefs[k] * (-a * r2).exp();
            *rho += ce;
            if order >= Order::Gradient {
                for i in 0..3 {
                    g[i] -= 2.0 * a * ce * d[i];
                }
                if order >= Order::Hessian {
                    for i in 0..3 {
                        h[i] += 2.0 * a * ce * (2.0 * a * d[i] * d[i] - 1.0);
                    }
                    h[3] += 4.0 * a * a * ce * d[0] * d[1];
                    h[4] += 4.0 * a * a * ce * d[0] * d[2];
                    h[5] += 4.0 * a * a * ce * d[1] * d[2];
                }
            }
        }
    }
}

/// Eigenvalues (ascending) of a symmetric 3×3 matrix given as xx, yy, zz, xy, xz, yz.
pub fn sym3_eigenvalues(h: &[f64; 6]) -> [f64; 3] {
    let [a, b, c, d, e, f] = *h;
    let p1 = d * d + e * e + f * f;
    if p1 == 0.0 {
        let mut ev = [a, b, c];
        ev.sort_by(|x, y| x.total_cmp(y));
        return ev;
    }
    let q = (a + b + c) / 3.0;
    let p2 = (a - q).powi(2) + (b - q).powi(2) + (c - q).powi(2) + 2.0 * p1;
    let p = (p2 / 6.0).sqrt();
    // B = (A - qI) / p ; r = det(B) / 2
    let (ba, bb, bc, bd, be, bf) = ((a - q) / p, (b - q) / p, (c - q) / p, d / p, e / p, f / p);
    let det = ba * (bb * bc - bf * bf) - bd * (bd * bc - bf * be) + be * (bd * bf - bb * be);
    let r = (det / 2.0).clamp(-1.0, 1.0);
    let phi = r.acos() / 3.0;
    let l1 = q + 2.0 * p * phi.cos();
    let l3 = q + 2.0 * p * (phi + 2.0 * std::f64::consts::PI / 3.0).cos();
    let l2 = 3.0 * q - l1 - l3;
    [l3, l2, l1]
}

/// sign(λ2)ρ from ρ and its Hessian (signlambda2rho in function.f90).
pub fn sign_lambda2_rho(rho: f64, h: &[f64; 6]) -> f64 {
    let l2 = sym3_eigenvalues(h)[1];
    if l2 == 0.0 {
        rho
    } else {
        rho * l2.signum()
    }
}

/// Interaction region indicator IRI = |∇ρ| / ρ^1.1 (Lu & Chen, Chem.-Methods
/// 2021, 1, 231), with Multiwfn's IRI_rhocut: 5 where ρ ≤ 5×10⁻⁵.
pub fn iri(rho: f64, g: &[f64; 3]) -> f64 {
    let norm = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
    if rho <= 5e-5 || norm == 0.0 {
        5.0
    } else {
        norm / rho.powf(1.1)
    }
}

/// Reduced density gradient (fgrad 'r' in function.f90), capped like Multiwfn.
pub fn rdg(rho: f64, g: &[f64; 3]) -> f64 {
    let g2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
    if rho >= 0.05 {
        100.0
    } else if g2 == 0.0 || rho == 0.0 {
        999.0
    } else {
        0.161_620_459_673_995 * g2.sqrt() / rho.powf(4.0 / 3.0)
    }
}

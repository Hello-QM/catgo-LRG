//! QTAIM topology of the electron density — port of Multiwfn's topology
//! module (topology.f90: findcp, findpath and the nuclear / atom-pair /
//! triangle / tetrahedron starting-point searches) with its default
//! settings, plus the critical-point properties of its CP listing
//! (function.f90: Lagkin, ELF_LOL).

use serde::Serialize;

use crate::eval::{BasisValues, Order};
use crate::wavefunction::{Spin, Wavefunction, BOHR_TO_ANGSTROM};

// Multiwfn defaults (define.f90)
const MAX_CYCLES: usize = 120;
const GRAD_CONV: f64 = 1e-6;
const DISP_CONV: f64 = 1e-7;
const MIN_CP_DISTANCE: f64 = 0.03;
const SINGULAR: f64 = 5e-22;
const VDW_SUM_FACTOR: f64 = 1.5;
const PATH_STEP: f64 = 0.03;
const PATH_END: f64 = 0.05;
const PATH_MAX_POINTS: usize = 451;

/// Bondi vdW radii (Å) as in Multiwfn's define.f90 (2.0 where unknown).
fn vdw_radius(z: u32) -> f64 {
    const R: [f64; 55] = [
        0.3, 1.2, 1.4, 1.82, 1.77, 1.74, 1.7, 1.55, 1.52, 1.47, 1.54, 2.27, 1.73, 1.73, 2.1, 1.8,
        1.8, 1.75, 1.88, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 1.63, 1.4, 1.39, 1.87, 2.0,
        1.85, 1.9, 1.85, 2.02, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 1.63, 1.72, 1.58, 1.93,
        2.17, 2.0, 2.06, 1.98, 2.16,
    ];
    let a = match z {
        78 => 1.72,
        79 => 1.66,
        80 => 1.55,
        81 => 1.96,
        82 => 2.02,
        _ => R.get(z as usize).copied().unwrap_or(2.0),
    };
    a / BOHR_TO_ANGSTROM
}

/// Eigen-decomposition of a symmetric 3×3 matrix (cyclic Jacobi).
/// Returns eigenvalues ascending and eigenvectors as columns `vecs[k]`.
pub fn sym3_eigen(m: [[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut a = m;
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..50 {
        let off = a[0][1].abs() + a[0][2].abs() + a[1][2].abs();
        if off < 1e-300 {
            break;
        }
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            if a[p][q].abs() < 1e-300 {
                continue;
            }
            let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
            let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
            let t = if theta == 0.0 { 1.0 } else { t };
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            for k in 0..3 {
                let (akp, akq) = (a[k][p], a[k][q]);
                a[k][p] = c * akp - s * akq;
                a[k][q] = s * akp + c * akq;
            }
            for k in 0..3 {
                let (apk, aqk) = (a[p][k], a[q][k]);
                a[p][k] = c * apk - s * aqk;
                a[q][k] = s * apk + c * aqk;
            }
            for k in 0..3 {
                let (vkp, vkq) = (v[k][p], v[k][q]);
                v[k][p] = c * vkp - s * vkq;
                v[k][q] = s * vkp + c * vkq;
            }
        }
    }
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&i, &j| a[i][i].total_cmp(&a[j][j]));
    let vals = [a[idx[0]][idx[0]], a[idx[1]][idx[1]], a[idx[2]][idx[2]]];
    let vecs = idx.map(|i| [v[0][i], v[1][i], v[2][i]]);
    (vals, vecs)
}

fn hess_matrix(h: &[f64; 6]) -> [[f64; 3]; 3] {
    [[h[0], h[3], h[4]], [h[3], h[1], h[5]], [h[4], h[5], h[2]]]
}

fn det3(m: &[[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/// Solve m x = b by Cramer's rule.
fn solve3(m: &[[f64; 3]; 3], b: [f64; 3]) -> [f64; 3] {
    let d = det3(m);
    std::array::from_fn(|k| {
        let mut mk = *m;
        for r in 0..3 {
            mk[r][k] = b[r];
        }
        det3(&mk) / d
    })
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum CpKind {
    NCP,
    BCP,
    RCP,
    CCP,
}

#[derive(Serialize, Clone, Debug)]
pub struct CriticalPoint {
    pub index: usize,
    #[serde(rename = "type")]
    pub label: &'static str,
    pub kind: CpKind,
    /// Å
    pub position: [f64; 3],
    pub rho: f64,
    pub laplacian: f64,
    #[serde(rename = "G")]
    pub g: f64,
    #[serde(rename = "V")]
    pub v: f64,
    #[serde(rename = "H")]
    pub h: f64,
    #[serde(rename = "ELF")]
    pub elf: f64,
    pub ellipticity: f64,
    pub eta: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nucleus: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub element: Option<String>,
    /// 1-based atoms a BCP links (from its bond path)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub atoms: Option<[usize; 2]>,
    #[serde(skip)]
    bohr: [f64; 3],
}

#[derive(Serialize, Clone, Debug)]
pub struct BondPath {
    /// Index of the BCP
    pub cp: usize,
    pub atoms: [usize; 2],
    /// Å, from one nucleus through the BCP to the other
    pub points: Vec<[f64; 3]>,
}

#[derive(Serialize, Default, Debug)]
pub struct Counts {
    #[serde(rename = "NCP")]
    pub ncp: usize,
    #[serde(rename = "BCP")]
    pub bcp: usize,
    #[serde(rename = "RCP")]
    pub rcp: usize,
    #[serde(rename = "CCP")]
    pub ccp: usize,
}

#[derive(Serialize, Debug)]
pub struct AimResult {
    pub critical_points: Vec<CriticalPoint>,
    pub bond_paths: Vec<BondPath>,
    pub counts: Counts,
    /// n(NCP) − n(BCP) + n(RCP) − n(CCP); 1 for an isolated molecule when
    /// every CP was found
    pub poincare_hopf: i64,
}

struct Topology<'a> {
    wf: &'a Wavefunction,
    occ: crate::eval::Occupied,
    buf: BasisValues,
}

impl<'a> Topology<'a> {
    fn density(&mut self, r: [f64; 3], order: Order) -> (f64, [f64; 3], [f64; 6]) {
        self.wf.density_at(r, order, &self.occ, &mut self.buf)
    }

    /// Newton search from `start` (findcp). Returns position and Hessian.
    fn find_cp(&mut self, start: [f64; 3], grad_conv: f64) -> Option<([f64; 3], [f64; 6])> {
        let mut x = start;
        for _ in 0..MAX_CYCLES {
            let (_, g, h) = self.density(x, Order::Hessian);
            let m = hess_matrix(&h);
            if det3(&m).abs() < SINGULAR {
                return None;
            }
            let d = solve3(&m, [-g[0], -g[1], -g[2]]);
            for k in 0..3 {
                x[k] += d[k];
            }
            let dn = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            let gn = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
            if !x.iter().all(|v| v.is_finite()) {
                return None;
            }
            if dn < DISP_CONV && gn < grad_conv {
                let (_, _, h) = self.density(x, Order::Hessian);
                return Some((x, h));
            }
        }
        None
    }

    /// ρ, Laplacian, G (Lagrangian kinetic energy) and ELF at `r`.
    fn properties(&mut self, r: [f64; 3]) -> (f64, f64, f64, f64) {
        let wf = self.wf;
        wf.basis_at(r, Order::Gradient, &mut self.buf);
        let open = wf
            .orbitals
            .iter()
            .any(|o| o.spin != Spin::Restricted || o.occupation == 1.0);
        let (mut rho, mut g_kin) = (0.0, 0.0);
        let (mut ra, mut rb) = (0.0, 0.0);
        let (mut ga, mut gb) = ([0.0; 3], [0.0; 3]);
        for o in &wf.orbitals {
            if o.occupation == 0.0 {
                continue;
            }
            let (mut v, mut d) = (0.0, [0.0; 3]);
            for &f in &self.buf.active {
                let c = o.coefs[f];
                v += c * self.buf.v[f];
                for k in 0..3 {
                    d[k] += c * self.buf.g[k][f];
                }
            }
            let n = o.occupation;
            rho += n * v * v;
            g_kin += 0.5 * n * (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
            let (wa, wb) = match o.spin {
                Spin::Alpha => (n, 0.0),
                Spin::Beta => (0.0, n),
                Spin::Restricted if n == 1.0 => (1.0, 0.0),
                Spin::Restricted => (n / 2.0, n / 2.0),
            };
            ra += wa * v * v;
            rb += wb * v * v;
            for k in 0..3 {
                ga[k] += 2.0 * wa * v * d[k];
                gb[k] += 2.0 * wb * v * d[k];
            }
        }
        let n2 = |g: [f64; 3]| g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
        let (mut dd, dh) = if open {
            let mut dd = g_kin;
            if ra != 0.0 {
                dd -= n2(ga) / ra / 8.0;
            }
            if rb != 0.0 {
                dd -= n2(gb) / rb / 8.0;
            }
            (
                dd,
                4.557_799_872 * (ra.powf(5.0 / 3.0) + rb.powf(5.0 / 3.0)),
            )
        } else {
            let gt = [ga[0] + gb[0], ga[1] + gb[1], ga[2] + gb[2]];
            let mut dd = g_kin;
            if rho != 0.0 {
                dd -= n2(gt) / rho / 8.0;
            }
            (dd, 2.871_234 * rho.powf(5.0 / 3.0))
        };
        dd += 1e-5;
        let elf = 1.0 / (1.0 + (dd / dh).powi(2));
        let (rho_full, _, h) = self.density(r, Order::Hessian);
        (rho_full, h[0] + h[1] + h[2], g_kin, elf)
    }

    /// Gradient path from a BCP along ±`dir` uphill until it reaches an NCP
    /// (findpath with RK2 steps). Returns the points and the NCP reached.
    fn trace(
        &mut self,
        start: [f64; 3],
        dir: [f64; 3],
        ncps: &[(usize, [f64; 3])],
    ) -> Option<(Vec<[f64; 3]>, usize)> {
        let mut pts = vec![
            start,
            std::array::from_fn(|k| start[k] + PATH_STEP * dir[k]),
        ];
        let (mut value, _, _) = self.density(start, Order::Value);
        for _ in 1..PATH_MAX_POINTS {
            let x = *pts.last().unwrap();
            if let Some(&(atom, pos)) = ncps.iter().find(|(_, p)| dist(x, *p) < PATH_END) {
                pts.push(pos);
                return Some((pts, atom));
            }
            let (v, g, _) = self.density(x, Order::Gradient);
            if v < value {
                return None; // ρ must increase along a bond path
            }
            value = v;
            let gn = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt();
            if gn == 0.0 {
                return None;
            }
            let mid: [f64; 3] = std::array::from_fn(|k| x[k] + PATH_STEP / 2.0 * g[k] / gn);
            let (_, g2, _) = self.density(mid, Order::Gradient);
            let gn2 = (g2[0] * g2[0] + g2[1] * g2[1] + g2[2] * g2[2]).sqrt();
            if gn2 == 0.0 {
                return None;
            }
            pts.push(std::array::from_fn(|k| x[k] + PATH_STEP * g2[k] / gn2));
        }
        None
    }
}

impl Wavefunction {
    /// Locate the critical points of ρ, their properties and the bond paths.
    pub fn aim(&self) -> AimResult {
        let mut topo = Topology {
            wf: self,
            occ: self.occupied_set(),
            buf: BasisValues::new(self.n_functions),
        };
        let atoms = &self.atoms;
        let n = atoms.len();
        let close = |i: usize, j: usize| {
            dist(atoms[i].xyz, atoms[j].xyz)
                <= VDW_SUM_FACTOR * (vdw_radius(atoms[i].z) + vdw_radius(atoms[j].z))
        };

        // starting points: nuclei, then pair midpoints, triangle and tetrahedron centres
        let mut found: Vec<([f64; 3], [f64; 6])> = Vec::new();
        let add = |topo: &mut Topology,
                   start: [f64; 3],
                   grad_conv: f64,
                   found: &mut Vec<([f64; 3], [f64; 6])>| {
            if let Some((x, h)) = topo.find_cp(start, grad_conv) {
                if found.iter().all(|(p, _)| dist(*p, x) > MIN_CP_DISTANCE) {
                    let (vals, _) = sym3_eigen(hess_matrix(&h));
                    if vals.iter().any(|v| *v != 0.0) {
                        found.push((x, h));
                    }
                }
            }
        };
        let centre = |ids: &[usize]| -> [f64; 3] {
            std::array::from_fn(|k| {
                ids.iter().map(|&i| atoms[i].xyz[k]).sum::<f64>() / ids.len() as f64
            })
        };
        for i in 0..n {
            // nuclei: gradient criterion dropped, as Multiwfn does for sharp cusps
            add(&mut topo, atoms[i].xyz, 1.0, &mut found);
        }
        for i in 0..n {
            for j in i + 1..n {
                if close(i, j) {
                    add(&mut topo, centre(&[i, j]), GRAD_CONV, &mut found);
                }
            }
        }
        for i in 0..n {
            for j in i + 1..n {
                if !close(i, j) {
                    continue;
                }
                for k in j + 1..n {
                    if close(i, k) && close(j, k) {
                        add(&mut topo, centre(&[i, j, k]), GRAD_CONV, &mut found);
                    }
                }
            }
        }
        for i in 0..n {
            for j in i + 1..n {
                if !close(i, j) {
                    continue;
                }
                for k in j + 1..n {
                    if !close(j, k) {
                        continue;
                    }
                    for l in k + 1..n {
                        if close(l, k) && close(l, i) && close(l, j) && close(i, k) {
                            add(&mut topo, centre(&[i, j, k, l]), GRAD_CONV, &mut found);
                        }
                    }
                }
            }
        }

        // classify; NCPs first (in atom order where they sit on a nucleus), then BCP, RCP, CCP
        let mut cps: Vec<CriticalPoint> = found
            .iter()
            .map(|(x, h)| {
                let (vals, _) = sym3_eigen(hess_matrix(h));
                let n_pos = vals.iter().filter(|v| **v > 0.0).count();
                let (kind, label) = match n_pos {
                    0 => (CpKind::NCP, "(3,-3)"),
                    1 => (CpKind::BCP, "(3,-1)"),
                    2 => (CpKind::RCP, "(3,+1)"),
                    _ => (CpKind::CCP, "(3,+3)"),
                };
                let (rho, lap, g, elf) = topo.properties(*x);
                let v = 0.25 * lap - 2.0 * g;
                let nucleus = if kind == CpKind::NCP {
                    (0..n)
                        .min_by(|&a, &b| dist(atoms[a].xyz, *x).total_cmp(&dist(atoms[b].xyz, *x)))
                        .filter(|&a| dist(atoms[a].xyz, *x) < 0.5)
                } else {
                    None
                };
                CriticalPoint {
                    index: 0,
                    label,
                    kind,
                    position: x.map(|c| c * BOHR_TO_ANGSTROM),
                    rho,
                    laplacian: lap,
                    g,
                    v,
                    h: g + v,
                    elf,
                    ellipticity: vals[0] / vals[1] - 1.0,
                    eta: vals[0].abs() / vals[2],
                    nucleus: nucleus.map(|a| a + 1),
                    element: nucleus.map(|a| crate::elements::symbol(atoms[a].z).to_string()),
                    atoms: None,
                    bohr: *x,
                }
            })
            .collect();
        let code = |p: &[f64; 3]| p[0] * 0.234134 + p[1] * 1.9837322 - p[2] * 0.5413578924;
        cps.sort_by(|a, b| {
            (a.kind as u8)
                .cmp(&(b.kind as u8))
                .then(
                    a.nucleus
                        .unwrap_or(usize::MAX)
                        .cmp(&b.nucleus.unwrap_or(usize::MAX)),
                )
                .then(code(&a.bohr).total_cmp(&code(&b.bohr)))
        });
        for (k, cp) in cps.iter_mut().enumerate() {
            cp.index = k + 1;
        }

        // bond paths: from each BCP both ways along the eigenvector of λ3 > 0
        let ncps: Vec<(usize, [f64; 3])> = cps
            .iter()
            .filter(|c| c.kind == CpKind::NCP)
            .filter_map(|c| c.nucleus.map(|a| (a - 1, c.bohr)))
            .collect();
        let mut paths = Vec::new();
        for cp in cps.iter_mut().filter(|c| c.kind == CpKind::BCP) {
            let (_, _, h) = topo.density(cp.bohr, Order::Hessian);
            let (_, vecs) = sym3_eigen(hess_matrix(&h));
            let e = vecs[2];
            let fwd = topo.trace(cp.bohr, e, &ncps);
            let back = topo.trace(cp.bohr, e.map(|v| -v), &ncps);
            if let (Some((pf, af)), Some((pb, ab))) = (fwd, back) {
                if af == ab {
                    continue;
                }
                let atoms_pair = [af.min(ab) + 1, af.max(ab) + 1];
                // order the polyline from the lower-numbered atom to the other
                let (first, second) = if af < ab { (pf, pb) } else { (pb, pf) };
                let mut points: Vec<[f64; 3]> = first.into_iter().rev().collect();
                points.extend(second.into_iter().skip(1));
                cp.atoms = Some(atoms_pair);
                paths.push(BondPath {
                    cp: cp.index,
                    atoms: atoms_pair,
                    points: points
                        .iter()
                        .map(|p| p.map(|c| c * BOHR_TO_ANGSTROM))
                        .collect(),
                });
            }
        }

        let mut counts = Counts::default();
        for c in &cps {
            match c.kind {
                CpKind::NCP => counts.ncp += 1,
                CpKind::BCP => counts.bcp += 1,
                CpKind::RCP => counts.rcp += 1,
                CpKind::CCP => counts.ccp += 1,
            }
        }
        let poincare_hopf =
            counts.ncp as i64 - counts.bcp as i64 + counts.rcp as i64 - counts.ccp as i64;
        AimResult {
            critical_points: cps,
            bond_paths: paths,
            counts,
            poincare_hopf,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jacobi_eigen() {
        let (vals, vecs) = sym3_eigen([[2.0, 1.0, 0.0], [1.0, 2.0, 0.0], [0.0, 0.0, 5.0]]);
        for (a, b) in vals.iter().zip([1.0, 3.0, 5.0]) {
            assert!((a - b).abs() < 1e-12);
        }
        // eigenvector of 3 is (1,1,0)/√2
        let v = vecs[1];
        assert!((v[0].abs() - 0.5f64.sqrt()).abs() < 1e-12 && (v[0] - v[1]).abs() < 1e-12);
    }
}

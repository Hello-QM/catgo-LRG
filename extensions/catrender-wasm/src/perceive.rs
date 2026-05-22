//! OpenBabel-style geometry bond-order perception — Rust port of
//! `OBMol::PerceiveBondOrders` (openbabel master src/mol.cpp:3222). See plan
//! 2026-05-21-catrender-ob-bond-perception.md for deviations (Pass 4 deferred,
//! aromatic→1.5 no-kekulize, smallest-ring SSSR).

/// Covalent radius (Å), max bond valence, and Pauling electronegativity,
/// indexed by atomic number. Verbatim from OpenBabel `src/elementtable.h`
/// columns RCov / MaxBnd / ElNeg. Index 0 is the dummy element.
/// Unknown/out-of-range fall back to OB's documented defaults:
/// covalent 1.6, maxbonds 6, electroneg 0.0.
struct ElemRow {
    cov: f64,
    maxb: u32,
    eneg: f64,
}

// Z = 0..=53 (H..I). Values copied from OB elementtable.h.
static ELEM: &[ElemRow] = &[
    ElemRow { cov: 0.00, maxb: 0, eneg: 0.00 }, // 0 dummy
    ElemRow { cov: 0.31, maxb: 1, eneg: 2.20 }, // 1  H
    ElemRow { cov: 0.28, maxb: 0, eneg: 0.00 }, // 2  He
    ElemRow { cov: 1.28, maxb: 1, eneg: 0.98 }, // 3  Li
    ElemRow { cov: 0.96, maxb: 2, eneg: 1.57 }, // 4  Be
    ElemRow { cov: 0.84, maxb: 4, eneg: 2.04 }, // 5  B
    ElemRow { cov: 0.76, maxb: 4, eneg: 2.55 }, // 6  C
    ElemRow { cov: 0.71, maxb: 4, eneg: 3.04 }, // 7  N
    ElemRow { cov: 0.66, maxb: 2, eneg: 3.44 }, // 8  O
    ElemRow { cov: 0.57, maxb: 1, eneg: 3.98 }, // 9  F
    ElemRow { cov: 0.58, maxb: 0, eneg: 0.00 }, // 10 Ne
    ElemRow { cov: 1.66, maxb: 1, eneg: 0.93 }, // 11 Na
    ElemRow { cov: 1.41, maxb: 2, eneg: 1.31 }, // 12 Mg
    ElemRow { cov: 1.21, maxb: 6, eneg: 1.61 }, // 13 Al
    ElemRow { cov: 1.11, maxb: 6, eneg: 1.90 }, // 14 Si
    ElemRow { cov: 1.07, maxb: 6, eneg: 2.19 }, // 15 P
    ElemRow { cov: 1.05, maxb: 6, eneg: 2.58 }, // 16 S
    ElemRow { cov: 1.02, maxb: 1, eneg: 3.16 }, // 17 Cl
    ElemRow { cov: 1.06, maxb: 0, eneg: 0.00 }, // 18 Ar
    ElemRow { cov: 2.03, maxb: 1, eneg: 0.82 }, // 19 K
    ElemRow { cov: 1.76, maxb: 2, eneg: 1.00 }, // 20 Ca
    ElemRow { cov: 1.70, maxb: 6, eneg: 1.36 }, // 21 Sc
    ElemRow { cov: 1.60, maxb: 6, eneg: 1.54 }, // 22 Ti
    ElemRow { cov: 1.53, maxb: 6, eneg: 1.63 }, // 23 V
    ElemRow { cov: 1.39, maxb: 6, eneg: 1.66 }, // 24 Cr
    ElemRow { cov: 1.39, maxb: 8, eneg: 1.55 }, // 25 Mn
    ElemRow { cov: 1.32, maxb: 6, eneg: 1.83 }, // 26 Fe
    ElemRow { cov: 1.26, maxb: 6, eneg: 1.88 }, // 27 Co
    ElemRow { cov: 1.24, maxb: 6, eneg: 1.91 }, // 28 Ni
    ElemRow { cov: 1.32, maxb: 6, eneg: 1.90 }, // 29 Cu
    ElemRow { cov: 1.22, maxb: 6, eneg: 1.65 }, // 30 Zn
    ElemRow { cov: 1.22, maxb: 3, eneg: 1.81 }, // 31 Ga
    ElemRow { cov: 1.20, maxb: 4, eneg: 2.01 }, // 32 Ge
    ElemRow { cov: 1.19, maxb: 3, eneg: 2.18 }, // 33 As
    ElemRow { cov: 1.20, maxb: 2, eneg: 2.55 }, // 34 Se
    ElemRow { cov: 1.20, maxb: 1, eneg: 2.96 }, // 35 Br
    ElemRow { cov: 1.16, maxb: 0, eneg: 3.00 }, // 36 Kr
    ElemRow { cov: 2.20, maxb: 1, eneg: 0.82 }, // 37 Rb
    ElemRow { cov: 1.95, maxb: 2, eneg: 0.95 }, // 38 Sr
    ElemRow { cov: 1.90, maxb: 6, eneg: 1.22 }, // 39 Y
    ElemRow { cov: 1.75, maxb: 6, eneg: 1.33 }, // 40 Zr
    ElemRow { cov: 1.64, maxb: 6, eneg: 1.60 }, // 41 Nb
    ElemRow { cov: 1.54, maxb: 6, eneg: 2.16 }, // 42 Mo
    ElemRow { cov: 1.47, maxb: 6, eneg: 1.90 }, // 43 Tc
    ElemRow { cov: 1.46, maxb: 6, eneg: 2.20 }, // 44 Ru
    ElemRow { cov: 1.42, maxb: 6, eneg: 2.28 }, // 45 Rh
    ElemRow { cov: 1.39, maxb: 6, eneg: 2.20 }, // 46 Pd
    ElemRow { cov: 1.45, maxb: 6, eneg: 1.93 }, // 47 Ag
    ElemRow { cov: 1.44, maxb: 6, eneg: 1.69 }, // 48 Cd
    ElemRow { cov: 1.42, maxb: 3, eneg: 1.78 }, // 49 In
    ElemRow { cov: 1.39, maxb: 4, eneg: 1.96 }, // 50 Sn
    ElemRow { cov: 1.39, maxb: 3, eneg: 2.05 }, // 51 Sb
    ElemRow { cov: 1.38, maxb: 2, eneg: 2.10 }, // 52 Te
    ElemRow { cov: 1.39, maxb: 1, eneg: 2.66 }, // 53 I
];

fn row(z: u32) -> &'static ElemRow {
    ELEM.get(z as usize).unwrap_or(&ElemRow { cov: 1.6, maxb: 6, eneg: 0.0 })
}

/// OB `OBElements::GetCovalentRad`.
pub(crate) fn covalent_rad(z: u32) -> f64 {
    row(z).cov
}

/// OB `OBElements::GetMaxBonds` (maximum bond valence).
pub(crate) fn max_bonds(z: u32) -> u32 {
    row(z).maxb
}

/// OB `OBElements::GetElectroNeg` (Pauling).
pub(crate) fn electroneg(z: u32) -> f64 {
    row(z).eneg
}

/// OB `CorrectedBondRad(elem, hyb)` — atom.cpp:1167.
pub(crate) fn corrected_bond_rad(z: u32, hyb: u32) -> f64 {
    let rad = covalent_rad(z);
    match hyb {
        2 => rad * 0.95,
        1 => rad * 0.90,
        _ => rad,
    }
}

/// Angle (degrees) at vertex `c` between vectors c→a and c→b. OB `OBAtom::GetAngle`.
pub(crate) fn angle_deg(a: [f64; 3], c: [f64; 3], b: [f64; 3]) -> f64 {
    let v1 = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
    let v2 = [b[0] - c[0], b[1] - c[1], b[2] - c[2]];
    let dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2];
    let n1 = (v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2]).sqrt();
    let n2 = (v2[0] * v2[0] + v2[1] * v2[1] + v2[2] * v2[2]).sqrt();
    if n1 < 1e-9 || n2 < 1e-9 {
        return 0.0;
    }
    let c = (dot / (n1 * n2)).clamp(-1.0, 1.0);
    c.acos().to_degrees()
}

/// Signed torsion (degrees) for atoms a-b-c-d. OB `OBMol::GetTorsion`.
pub(crate) fn torsion_deg(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> f64 {
    let b1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let b2 = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    let b3 = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
    let cross = |u: [f64; 3], v: [f64; 3]| {
        [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ]
    };
    let n1 = cross(b1, b2);
    let n2 = cross(b2, b3);
    let dot = |u: [f64; 3], v: [f64; 3]| u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    let m1 = cross(n1, b2);
    let b2len = dot(b2, b2).sqrt();
    if b2len < 1e-9 {
        return 0.0;
    }
    let m1n = [m1[0] / b2len, m1[1] / b2len, m1[2] / b2len];
    let x = dot(n1, n2);
    let y = dot(m1n, n2);
    y.atan2(x).to_degrees()
}

/// Working molecule view for perception: atomic numbers, coords, adjacency,
/// and a mutable order per (undirected) bond. Bonds are indexed by their
/// position in the input bond list.
pub(crate) struct Graph {
    pub z: Vec<u32>,
    pub xyz: Vec<[f64; 3]>,
    /// adjacency: adj[i] = list of (neighbor_atom, bond_index)
    pub adj: Vec<Vec<(usize, usize)>>,
    /// per-bond endpoints
    pub bonds: Vec<(usize, usize)>,
    /// per-bond order (mutated during perception). 1.0 initially.
    pub order: Vec<f64>,
    /// per-atom perceived hybridization (1/2/3). 3 (sp3) default.
    pub hyb: Vec<u32>,
}

impl Graph {
    pub fn build(z: &[u32], xyz: &[[f64; 3]], bonds: &[(usize, usize)]) -> Self {
        let n = z.len();
        let mut adj = vec![Vec::new(); n];
        for (bi, &(i, j)) in bonds.iter().enumerate() {
            if i < n && j < n {
                adj[i].push((j, bi));
                adj[j].push((i, bi));
            }
        }
        Graph {
            z: z.to_vec(),
            xyz: xyz.to_vec(),
            adj,
            bonds: bonds.to_vec(),
            order: vec![1.0; bonds.len()],
            hyb: vec![3; n],
        }
    }

    /// Explicit degree = number of incident bonds (heavy + H, matching OB
    /// GetExplicitDegree on a graph with explicit atoms).
    pub fn degree(&self, a: usize) -> usize {
        self.adj[a].len()
    }

    /// Explicit valence = sum of incident bond orders (OB GetExplicitValence).
    pub fn valence(&self, a: usize) -> f64 {
        self.adj[a].iter().map(|&(_, bi)| self.order[bi]).sum()
    }

    pub fn has_nonsingle(&self, a: usize) -> bool {
        self.adj[a].iter().any(|&(_, bi)| self.order[bi] > 1.0 + 1e-9)
    }

    pub fn explicit_h_count(&self, a: usize) -> usize {
        self.adj[a].iter().filter(|&&(nb, _)| self.z[nb] == 1).count()
    }

    pub fn bond_between(&self, a: usize, b: usize) -> Option<usize> {
        self.adj[a].iter().find(|&&(nb, _)| nb == b).map(|&(_, bi)| bi)
    }
}

/// Smallest set of smallest rings, approximated as: for each bond, the
/// smallest cycle (size 3..=7) containing it; deduplicated by atom set.
/// Returns ring atom-index paths (ordered around the ring). Sufficient for
/// PerceiveBondOrders passes 2 & 5 which only inspect 5/6/7-membered rings.
pub(crate) fn find_rings(g: &Graph) -> Vec<Vec<usize>> {
    const MAX_RING: usize = 7;
    let n = g.z.len();
    let mut rings: Vec<Vec<usize>> = Vec::new();
    let mut seen: std::collections::HashSet<Vec<usize>> = std::collections::HashSet::new();

    // For each bond (u,v): find shortest path u→v NOT using that bond; the
    // path + the bond forms the smallest ring through it.
    for &(u, v) in &g.bonds {
        // BFS from u to v, forbidding the direct u-v edge.
        let mut prev = vec![usize::MAX; n];
        let mut dist = vec![usize::MAX; n];
        let mut queue = std::collections::VecDeque::new();
        dist[u] = 0;
        queue.push_back(u);
        while let Some(x) = queue.pop_front() {
            if dist[x] >= MAX_RING {
                continue;
            }
            for &(y, _) in &g.adj[x] {
                if x == u && y == v {
                    continue; // skip the closing bond itself
                }
                if y == u && x == v {
                    continue;
                }
                if dist[y] == usize::MAX {
                    dist[y] = dist[x] + 1;
                    prev[y] = x;
                    queue.push_back(y);
                }
            }
        }
        if dist[v] == usize::MAX || dist[v] + 1 > MAX_RING {
            continue;
        }
        // reconstruct v→u path
        let mut path = Vec::new();
        let mut cur = v;
        while cur != usize::MAX {
            path.push(cur);
            if cur == u {
                break;
            }
            cur = prev[cur];
        }
        if path.len() < 3 || path.first() != Some(&v) || path.last() != Some(&u) {
            continue;
        }
        let mut key = path.clone();
        key.sort_unstable();
        if seen.insert(key) {
            rings.push(path);
        }
    }
    rings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn element_table_known_values() {
        assert_eq!(covalent_rad(6), 0.76); // C
        assert_eq!(max_bonds(6), 4); // C
        assert_eq!(electroneg(6), 2.55); // C
        assert_eq!(max_bonds(8), 2); // O
        assert_eq!(electroneg(8), 3.44); // O
        assert_eq!(max_bonds(7), 4); // N
    }

    #[test]
    fn element_table_unknown_fallback() {
        assert_eq!(covalent_rad(200), 1.6);
        assert_eq!(max_bonds(200), 6);
        assert_eq!(electroneg(200), 0.0);
    }

    #[test]
    fn corrected_bond_rad_hyb_scaling() {
        assert_eq!(corrected_bond_rad(6, 3), 0.76);
        assert!((corrected_bond_rad(6, 2) - 0.76 * 0.95).abs() < 1e-12);
        assert!((corrected_bond_rad(6, 1) - 0.76 * 0.90).abs() < 1e-12);
    }

    #[test]
    fn angle_right_and_straight() {
        // 90°: vertex at origin, arms along +x and +y
        let a = angle_deg([1.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
        assert!((a - 90.0).abs() < 1e-6, "got {a}");
        // 180°: collinear
        let s = angle_deg([1.0, 0.0, 0.0], [0.0, 0.0, 0.0], [-1.0, 0.0, 0.0]);
        assert!((s - 180.0).abs() < 1e-6, "got {s}");
    }

    #[test]
    fn torsion_planar_cis_trans() {
        // trans (180°): a and d on opposite sides of the b-c axis
        let t = torsion_deg(
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, -1.0, 0.0],
        );
        assert!(t.abs() > 179.0, "expected ~180, got {t}");
        // cis (0°): a and d same side
        let c = torsion_deg(
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
        );
        assert!(c.abs() < 1.0, "expected ~0, got {c}");
    }

    fn benzene_graph() -> Graph {
        // planar hexagon, 1.39 Å C-C
        let r = 1.39;
        let mut xyz = Vec::new();
        for k in 0..6 {
            let a = (k as f64) * std::f64::consts::PI / 3.0;
            xyz.push([r * a.cos(), r * a.sin(), 0.0]);
        }
        let z = vec![6u32; 6];
        let bonds: Vec<(usize, usize)> =
            (0..6).map(|k| (k, (k + 1) % 6)).collect();
        Graph::build(&z, &xyz, &bonds)
    }

    #[test]
    fn graph_degree_valence() {
        let g = benzene_graph();
        assert_eq!(g.degree(0), 2);
        assert!((g.valence(0) - 2.0).abs() < 1e-9); // two single bonds
    }

    #[test]
    fn sssr_finds_benzene_ring() {
        let g = benzene_graph();
        let rings = find_rings(&g);
        assert_eq!(rings.len(), 1, "benzene has one ring");
        assert_eq!(rings[0].len(), 6, "6-membered");
    }
}

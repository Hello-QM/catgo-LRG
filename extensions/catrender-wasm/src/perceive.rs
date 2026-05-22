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

/// OB `OBAtom::AverageBondAngle` (atom.cpp:918) — mean over all neighbour pairs.
fn average_bond_angle(g: &Graph, a: usize) -> f64 {
    let nbrs: Vec<usize> = g.adj[a].iter().map(|&(nb, _)| nb).collect();
    let mut sum = 0.0;
    let mut n = 0;
    for x in 0..nbrs.len() {
        for y in (x + 1)..nbrs.len() {
            sum += angle_deg(g.xyz[nbrs[x]], g.xyz[a], g.xyz[nbrs[y]]);
            n += 1;
        }
    }
    if n >= 1 {
        sum / n as f64
    } else {
        0.0
    }
}

/// Passes 1-3 of PerceiveBondOrders: assign `g.hyb`.
pub(crate) fn assign_hybridization(g: &mut Graph, rings: &[Vec<usize>]) {
    let n = g.z.len();

    // Pass 1
    for a in 0..n {
        let angle = average_bond_angle(g, a);
        if angle > 155.0 {
            g.hyb[a] = 1;
        } else if angle <= 155.0 && angle > 115.0 {
            g.hyb[a] = 2;
        }
        let in_ring = rings.iter().any(|r| r.contains(&a));
        // imine N
        if g.z[a] == 7 && g.explicit_h_count(a) == 1 && g.degree(a) == 2 && angle > 109.5 {
            g.hyb[a] = 2;
        } else if g.z[a] == 7 && g.degree(a) == 2 && in_ring {
            g.hyb[a] = 2;
        }
    }

    // Pass 2: planar 5-/6-rings → ring atoms sp2
    for ring in rings {
        let p = ring;
        let sz = p.len();
        let tors = |q: &[usize]| {
            torsion_deg(g.xyz[q[0]], g.xyz[q[1]], g.xyz[q[2]], g.xyz[q[3]]).abs()
        };
        if sz == 5 {
            let t = (tors(&[p[0], p[1], p[2], p[3]])
                + tors(&[p[1], p[2], p[3], p[4]])
                + tors(&[p[2], p[3], p[4], p[0]])
                + tors(&[p[3], p[4], p[0], p[1]])
                + tors(&[p[4], p[0], p[1], p[2]]))
                / 5.0;
            if t <= 7.5 {
                for &b in p {
                    if g.degree(b) == 2 {
                        g.hyb[b] = 2;
                    }
                }
            }
        } else if sz == 6 {
            let t = (tors(&[p[0], p[1], p[2], p[3]])
                + tors(&[p[1], p[2], p[3], p[4]])
                + tors(&[p[2], p[3], p[4], p[5]])
                + tors(&[p[3], p[4], p[5], p[0]])
                + tors(&[p[4], p[5], p[0], p[1]])
                + tors(&[p[5], p[0], p[1], p[2]]))
                / 6.0;
            if t <= 12.0 {
                for &b in p {
                    if g.degree(b) == 2 || g.degree(b) == 3 {
                        g.hyb[b] = 2;
                    }
                }
            }
        }
    }

    // Pass 3: antialiasing — demote isolated sp/sp2
    for a in 0..n {
        if g.hyb[a] == 2 || g.hyb[a] == 1 {
            let open_nbr = g.adj[a]
                .iter()
                .any(|&(nb, _)| g.hyb[nb] < 3 || g.degree(nb) == 1);
            if !open_nbr && g.hyb[a] == 2 {
                g.hyb[a] = 3;
            } else if !open_nbr && g.hyb[a] == 1 {
                g.hyb[a] = 2;
            }
        }
    }
}

/// Pass 5: mark fully-sp2 unsaturated 5/6/7-rings as aromatic (order 1.5).
/// Returns true if any ring was marked (informational).
pub(crate) fn assign_aromatic(g: &mut Graph, rings: &[Vec<usize>]) -> bool {
    let mut any = false;
    for ring in rings {
        let sz = ring.len();
        if sz != 5 && sz != 6 && sz != 7 {
            continue;
        }
        let typed = ring.iter().any(|&a| g.has_nonsingle(a) || g.hyb[a] != 2);
        if typed {
            continue;
        }
        for k in 0..sz {
            let a = ring[k];
            let b = ring[(k + 1) % sz];
            if let Some(bi) = g.bond_between(a, b) {
                g.order[bi] = 1.5;
                any = true;
            }
        }
    }
    any
}

/// OB `OBBond::IsDoubleBondGeometry` (bond.cpp:481). True unless a neighbour
/// torsion across the bond falls in (15°,160°) — i.e. non-planar.
fn is_double_bond_geometry(g: &Graph, a: usize, b: usize) -> bool {
    if g.hyb[a] == 1 || g.degree(a) > 3 || g.hyb[b] == 1 || g.degree(b) > 3 {
        return true;
    }
    for &(ns, _) in &g.adj[a] {
        if ns == b {
            continue;
        }
        for &(ne, _) in &g.adj[b] {
            if ne == a {
                continue;
            }
            let t = torsion_deg(g.xyz[ns], g.xyz[a], g.xyz[b], g.xyz[ne]).abs();
            if t > 15.0 && t < 160.0 {
                return false;
            }
        }
    }
    true
}

fn bond_len(g: &Graph, a: usize, b: usize) -> f64 {
    let p = g.xyz[a];
    let q = g.xyz[b];
    ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt()
}

fn in_ring(rings: &[Vec<usize>], a: usize) -> bool {
    rings.iter().any(|r| r.contains(&a))
}

/// Pass 6: assign remaining double/triple bonds, ordered by electronegativity.
pub(crate) fn assign_multibonds(g: &mut Graph, rings: &[Vec<usize>]) {
    let n = g.z.len();

    // sort key: electroneg*1e6 + shortest heavy-atom bond length, ASC.
    // OB `SortAtomZ` (mol.cpp:206) sorts ascending and iterates 0→max, so the
    // least-electronegative atoms are processed first — load-bearing for the
    // conjugated single/double assignment (OB comment at mol.cpp:3440).
    let mut order_idx: Vec<usize> = (0..n).collect();
    let key = |g: &Graph, a: usize| -> f64 {
        let mut shortest = 1.0e5_f64;
        for &(nb, bi) in &g.adj[a] {
            if g.z[nb] != 1 {
                shortest = shortest.min(bond_len(g, a, g.bonds[bi].0 + g.bonds[bi].1 - a));
            }
        }
        electroneg(g.z[a]) * 1e6 + shortest
    };
    order_idx.sort_by(|&x, &y| {
        key(g, x).partial_cmp(&key(g, y)).unwrap_or(std::cmp::Ordering::Equal)
    });

    for &atom in &order_idx {
        let za = g.z[atom];
        let maxb = max_bonds(za) as f64;

        // sp candidate (triple)
        if (g.hyb[atom] == 1 || g.degree(atom) == 1) && g.valence(atom) + 2.0 <= maxb {
            if g.has_nonsingle(atom) || (za == 7 && g.valence(atom) + 2.0 > 3.0) {
                continue;
            }
            let mut max_eneg = 0.0;
            let mut shortest = 5000.0;
            let mut chosen: Option<usize> = None;
            for &(b, _) in &g.adj[atom].clone() {
                let eneg_b = electroneg(g.z[b]);
                let ok = (g.hyb[b] == 1 || g.degree(b) == 1)
                    && g.valence(b) + 2.0 <= max_bonds(g.z[b]) as f64
                    && (eneg_b > max_eneg
                        || ((eneg_b - max_eneg).abs() < 1e-6 && bond_len(g, atom, b) < shortest));
                if !ok {
                    continue;
                }
                if g.has_nonsingle(b) || (g.z[b] == 7 && g.valence(b) + 2.0 > 3.0) {
                    continue;
                }
                let bl = bond_len(g, atom, b);
                if g.degree(atom) == 1 || g.degree(b) == 1 {
                    let test = corrected_bond_rad(za, g.hyb[atom])
                        + corrected_bond_rad(g.z[b], g.hyb[b]);
                    if bl > 0.9 * test {
                        continue;
                    }
                }
                shortest = bl;
                max_eneg = eneg_b;
                chosen = Some(b);
            }
            if let Some(b) = chosen {
                if let Some(bi) = g.bond_between(atom, b) {
                    g.order[bi] = 3.0;
                }
            }
        }
        // sp2 candidate (double)
        else if (g.hyb[atom] == 2 || g.degree(atom) == 1) && g.valence(atom) + 1.0 <= maxb {
            if g.has_nonsingle(atom) || (za == 7 && g.valence(atom) + 1.0 > 3.0) {
                continue;
            }
            // ring sulfur: skip (thiopyrylium charge case not modelled)
            if in_ring(rings, atom) && za == 16 {
                continue;
            }
            let mut max_eneg = 0.0;
            let mut shortest = 5000.0_f64;
            let mut chosen: Option<usize> = None;
            for &(b, _) in &g.adj[atom].clone() {
                let eneg_b = electroneg(g.z[b]);
                let ok = (g.hyb[b] == 2 || g.degree(b) == 1)
                    && g.valence(b) + 1.0 <= max_bonds(g.z[b]) as f64
                    && is_double_bond_geometry(g, atom, b)
                    && (eneg_b > max_eneg || (eneg_b - max_eneg).abs() < 1e-6);
                if !ok {
                    continue;
                }
                if g.has_nonsingle(b) || (g.z[b] == 7 && g.valence(b) + 1.0 > 3.0) {
                    continue;
                }
                if in_ring(rings, b) && g.z[b] == 16 {
                    continue;
                }
                let bl = bond_len(g, atom, b);
                if g.degree(atom) == 1 || g.degree(b) == 1 {
                    let test = corrected_bond_rad(za, g.hyb[atom])
                        + corrected_bond_rad(g.z[b], g.hyb[b]);
                    if bl > 0.93 * test {
                        continue;
                    }
                }
                let difference = shortest - bl;
                let chosen_in_ring = chosen.map(|c| in_ring(rings, c)).unwrap_or(false);
                // Verbatim OB ring-preference tie-break (mol.cpp:3540). OB's
                // literal expression is logically redundant — the second
                // disjunct is subsumed by the first — so clippy's
                // `overly_complex_bool_expr` (deny-by-default) fires; keep the
                // OB-faithful form and allow the lint here.
                #[allow(clippy::overly_complex_bool_expr)]
                let prefer = (difference > 0.1)
                    || (difference > -0.01
                        && ((!in_ring(rings, atom) || !chosen_in_ring || in_ring(rings, b))
                            || (in_ring(rings, atom) && !chosen_in_ring && in_ring(rings, b))));
                if prefer {
                    shortest = bl;
                    max_eneg = eneg_b;
                    chosen = Some(b);
                }
            }
            if let Some(b) = chosen {
                if let Some(bi) = g.bond_between(atom, b) {
                    g.order[bi] = 2.0;
                }
            }
        }
    }
}

/// Public entry. Resolves orders for `bonds` (parallel to the input bond list)
/// from atom numbers `z` and coordinates `xyz`. Mutates `orders` in place.
/// `orders.len()` MUST equal `bonds.len()`.
pub fn perceive_bond_orders(
    z: &[u32],
    xyz: &[[f64; 3]],
    bonds: &[(usize, usize)],
    orders: &mut [f64],
) {
    if z.is_empty() || bonds.is_empty() {
        return;
    }
    let mut g = Graph::build(z, xyz, bonds);
    let rings = find_rings(&g);
    assign_hybridization(&mut g, &rings);
    assign_aromatic(&mut g, &rings);
    assign_multibonds(&mut g, &rings);
    let m = orders.len().min(g.order.len());
    orders[..m].copy_from_slice(&g.order[..m]);
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

    fn ethylene_graph() -> Graph {
        // C2H4 planar; C-C 1.33, C-H 1.08
        let z = vec![6, 6, 1, 1, 1, 1];
        let xyz = vec![
            [0.0, 0.0, 0.0],     // C0
            [1.33, 0.0, 0.0],    // C1
            [-0.5, 0.93, 0.0],   // H
            [-0.5, -0.93, 0.0],  // H
            [1.83, 0.93, 0.0],   // H
            [1.83, -0.93, 0.0],  // H
        ];
        let bonds = vec![(0, 1), (0, 2), (0, 3), (1, 4), (1, 5)];
        Graph::build(&z, &xyz, &bonds)
    }

    #[test]
    fn hyb_ethylene_carbons_sp2() {
        let mut g = ethylene_graph();
        let rings = find_rings(&g);
        assign_hybridization(&mut g, &rings);
        assert_eq!(g.hyb[0], 2, "C0 sp2");
        assert_eq!(g.hyb[1], 2, "C1 sp2");
    }

    #[test]
    fn hyb_benzene_all_sp2() {
        let mut g = benzene_graph();
        let rings = find_rings(&g);
        assign_hybridization(&mut g, &rings);
        for c in 0..6 {
            assert_eq!(g.hyb[c], 2, "benzene C{c} sp2");
        }
    }

    #[test]
    fn aromatic_benzene_all_1_5() {
        let mut g = benzene_graph();
        let rings = find_rings(&g);
        assign_hybridization(&mut g, &rings);
        let marked = assign_aromatic(&mut g, &rings);
        assert!(marked);
        for bi in 0..g.order.len() {
            assert!(
                (g.order[bi] - 1.5).abs() < 1e-9,
                "bond {bi} order {} not aromatic",
                g.order[bi]
            );
        }
    }

    #[test]
    fn multibond_ethylene_double() {
        let g0 = ethylene_graph();
        let mut orders = vec![1.0; g0.bonds.len()];
        perceive_bond_orders(&g0.z, &g0.xyz, &g0.bonds, &mut orders);
        // bond 0 is C0-C1
        assert!((orders[0] - 2.0).abs() < 1e-9, "C=C should be 2.0, got {}", orders[0]);
    }

    #[test]
    fn multibond_benzene_aromatic() {
        let g0 = benzene_graph();
        let mut orders = vec![1.0; g0.bonds.len()];
        perceive_bond_orders(&g0.z, &g0.xyz, &g0.bonds, &mut orders);
        for (bi, o) in orders.iter().enumerate() {
            assert!((o - 1.5).abs() < 1e-9, "benzene bond {bi} should be 1.5, got {o}");
        }
    }

    #[test]
    fn multibond_acetylene_triple() {
        // HC≡CH: C-C 1.20, C-H 1.06, linear
        let z = vec![6, 6, 1, 1];
        let xyz = vec![
            [0.0, 0.0, 0.0],
            [1.20, 0.0, 0.0],
            [-1.06, 0.0, 0.0],
            [2.26, 0.0, 0.0],
        ];
        let bonds = vec![(0, 1), (0, 2), (1, 3)];
        let mut orders = vec![1.0; bonds.len()];
        perceive_bond_orders(&z, &xyz, &bonds, &mut orders);
        assert!((orders[0] - 3.0).abs() < 1e-9, "C≡C should be 3.0, got {}", orders[0]);
    }

    #[test]
    fn multibond_butadiene_matches_openbabel() {
        // OB make3D + PerceiveBondOrders ground truth (C=C-C=C).
        let z = vec![6, 6, 6, 6, 1, 1, 1, 1, 1, 1];
        let xyz = vec![
            [0.9296, 0.0770, -0.0346],
            [0.2411, -0.9373, 0.5007],
            [-1.1998, -0.9795, 0.5229],
            [-1.8891, -1.9937, 1.0581],
            [0.4390, 0.9331, -0.4864],
            [2.0150, 0.0690, -0.0304],
            [0.7830, -1.7718, 0.9410],
            [-1.7417, -0.1449, 0.0825],
            [-2.9745, -1.9853, 1.0537],
            [-1.3988, -2.8499, 1.5100],
        ];
        let bonds = vec![
            (0, 1),
            (1, 2),
            (2, 3),
            (0, 4),
            (0, 5),
            (1, 6),
            (2, 7),
            (3, 8),
            (3, 9),
        ];
        let mut orders = vec![1.0; bonds.len()];
        perceive_bond_orders(&z, &xyz, &bonds, &mut orders);
        // C-C bonds are indices 0,1,2; OB gives 2,1,2.
        assert!(
            (orders[0] - 2.0).abs() < 1e-9
                && (orders[1] - 1.0).abs() < 1e-9
                && (orders[2] - 2.0).abs() < 1e-9,
            "butadiene C-C orders {:?} != OB [2.0, 1.0, 2.0]",
            &orders[0..3]
        );
    }

    #[test]
    fn multibond_formamide_matches_openbabel() {
        // OB ground truth for HC(=O)NH2.
        let z = vec![6, 8, 7, 1, 1, 1];
        let xyz = vec![
            [0.9213, 0.0733, 0.0856],
            [0.3261, -0.6932, -0.6552],
            [0.2922, 0.9393, 0.9226],
            [2.0199, 0.1348, 0.1451],
            [0.7918, 1.5703, 1.5325],
            [-0.7194, 0.9454, 0.9286],
        ];
        let bonds = vec![(0, 1), (0, 2), (0, 3), (2, 4), (2, 5)];
        let mut orders = vec![1.0; bonds.len()];
        perceive_bond_orders(&z, &xyz, &bonds, &mut orders);
        // C-O bond (index 0) double, C-N bond (index 1) single.
        assert!(
            (orders[0] - 2.0).abs() < 1e-9 && (orders[1] - 1.0).abs() < 1e-9,
            "formamide [C-O, C-N] orders {:?} != OB [2.0, 1.0]",
            &orders[0..2]
        );
    }
}

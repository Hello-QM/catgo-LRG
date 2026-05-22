# catrender OpenBabel-style Bond-Order Perception (Rust port) + Atom Index Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port OpenBabel's geometry-based `OBMol::PerceiveBondOrders()` to Rust inside the `catrender-wasm` render core so single/double/triple/aromatic bonds are perceived from 3D coordinates alone, plus add a toggleable atom-index overlay for manual bond editing.

**Architecture:** Perception runs **in-wasm** (no backend dependency) as a new `perceive.rs` module, gated by a new `perceive_orders` style flag. It consumes the existing connectivity (`inp.bonds` after `perceive()` fallback) and the atom coordinates, assigns hybridization + bond orders following OB passes 1,2,3,5,6, and writes `order` back onto the bond list before edges/rendering. Aromatic bonds are assigned **order 1.5** (catrender's aromatic window is `1.3 < bo < 1.7`, `bonds.rs:178`) so OB's Kekulization step is intentionally skipped. OB Pass 4 (SMARTS functional-group corrections) is intentionally deferred. The atom-index overlay is a second independent `show_index` style flag emitting `<text>` per atom in `svg.rs`.

**Tech Stack:** Rust (catrender-wasm crate, `cargo test`), serde, Svelte 5 (frontend toggles), wasm-pack.

**Faithfulness note / authoritative source:** This is a port of OpenBabel master `src/mol.cpp::PerceiveBondOrders` (lines 3222-3587), `src/atom.cpp::AverageBondAngle` (918) + `CorrectedBondRad` (1167), `src/bond.cpp::IsDoubleBondGeometry` (481), element data from `src/elementtable.h`. Columns: `Num, Symb, ARENeg, RCov, RBO, RVdW, MaxBnd, Mass, ElNeg(Pauling), ...`.

**Intentional deviations from OB (document in code comments):**
1. **Pass 4 deferred** — `bondtyper.AssignFunctionalGroupBonds` (SMARTS functional groups: nitro, carboxyl, amidinium…) is NOT ported. Those groups get approximate orders from Pass 6.
2. **Aromatic → 1.5, no Kekulize** — OB marks aromatic then kekulizes to alternating doubles. catrender renders aromatic as a dedicated stroke at `order ∈ (1.3,1.7)`, so we emit `1.5` and skip `OBKekulize`.
3. **SSSR** — we implement "smallest ring through each bond, sizes 3..=7" (sufficient for passes 2 & 5 which only inspect 5/6/7-rings), not OB's full `FindSSSR`.
4. **Element coverage** — tables cover Z=1..=53 commons with fallbacks (covalent 1.6, maxbonds 6, eneg 0.0) per OB's "if unknown" defaults.

---

## File Structure

- **Create** `extensions/catrender-wasm/src/perceive.rs` — element data accessors, geometry (bond angle, torsion), SSSR ring finder, hybridization passes 1-3, aromatic pass 5, multi-bond pass 6. Single public entry `perceive_bond_orders`.
- **Modify** `extensions/catrender-wasm/src/lib.rs` — add `mod perceive;`.
- **Modify** `extensions/catrender-wasm/src/types.rs` — add `perceive_orders: bool` and `show_index: bool` to `Style`.
- **Modify** `extensions/catrender-wasm/src/svg.rs` — (a) call `perceive::perceive_bond_orders` when `inp.style.perceive_orders`, before edges are built; (b) emit atom-index `<text>` when `inp.style.show_index`.
- **Modify** `src/lib/structure/catrender/catrender-state.svelte.ts` — add `perceive_orders` + `show_index` knobs to state + payload.
- **Modify** `src/lib/structure/catrender/CatRenderParamsPane.svelte` — "perceive bond orders" checkbox.
- **Modify** `src/lib/structure/catrender/CatRenderViewPane.svelte` — "show indices" checkbox.

The element symbol→atomic number map already exists as `s2n()` in `svg.rs`; perception takes pre-resolved `z: &[u32]`.

---

## Task 1: Element data tables (covalent radius, max bonds, Pauling electronegativity)

**Files:**
- Create: `extensions/catrender-wasm/src/perceive.rs`
- Modify: `extensions/catrender-wasm/src/lib.rs` (add `mod perceive;`)

- [ ] **Step 1: Register module**

In `extensions/catrender-wasm/src/lib.rs`, add alongside the other `mod` lines:

```rust
mod perceive;
```

- [ ] **Step 2: Write the failing test**

Create `extensions/catrender-wasm/src/perceive.rs` with ONLY the data accessors + tests below (no other code yet):

```rust
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
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib perceive::tests::element`
Expected: FAIL — module not yet wired / first compile run (if it errors on missing `mod perceive;`, fix Step 1 then re-run). Once compiling, the three tests should PASS (this task is pure data; the "failing" gate is the compile + value assertions catching a typo).

> Note: pure-data tables can't meaningfully fail-first beyond compile. The fail-first signal is: comment out one ELEM row value (e.g. C eneg → 9.9), run, watch `element_table_known_values` FAIL, then restore.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib perceive::tests`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/catrender-wasm/src/perceive.rs extensions/catrender-wasm/src/lib.rs
git commit -m "feat(catrender): perceive.rs element data (cov rad/maxbonds/eneg) [OB port P1]"
```

---

## Task 2: Geometry helpers — bond angle and torsion

**Files:**
- Modify: `extensions/catrender-wasm/src/perceive.rs`

- [ ] **Step 1: Write the failing test**

Add to `perceive.rs` (above the `#[cfg(test)]` block, append the test fns inside the existing `mod tests`):

```rust
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
```

Add tests to `mod tests`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib perceive::tests::angle perceive::tests::torsion`
Expected: FAIL (functions undefined) — wait, they're defined in Step 1. The fail-first protocol: write the TEST first with the fns absent. Practically: paste only the two `#[test]` fns, run → FAIL "cannot find function `angle_deg`". Then paste the two impl fns, re-run.

- [ ] **Step 3: (impl already shown in Step 1) ensure both fns present**

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib perceive::tests`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add extensions/catrender-wasm/src/perceive.rs
git commit -m "feat(catrender): perceive geometry (angle/torsion) [OB port P2]"
```

---

## Task 3: Molecule graph + smallest-ring SSSR (sizes 3..=7)

**Files:**
- Modify: `extensions/catrender-wasm/src/perceive.rs`

- [ ] **Step 1: Write the failing test**

Add the graph + ring finder to `perceive.rs`:

```rust
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
```

Add tests:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Paste tests first (without impl) → Run:
`cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib perceive::tests::sssr perceive::tests::graph`
Expected: FAIL — `Graph`/`find_rings` undefined. Then add impl, re-run.

- [ ] **Step 3: (impl in Step 1)**

- [ ] **Step 4: Run to verify pass**

Run: `cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib perceive::tests`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/catrender-wasm/src/perceive.rs
git commit -m "feat(catrender): perceive graph + smallest-ring SSSR [OB port P3]"
```

---

## Task 4: Hybridization passes 1-3

**Files:**
- Modify: `extensions/catrender-wasm/src/perceive.rs`

OB reference (mol.cpp:3239-3347): Pass 1 sets hyb from `AverageBondAngle` (`>155→1`, `115<a≤155→2`, default 3) with imine/azete N special cases. Pass 2 sets ring atoms to sp2 when 5-ring torsions ≤7.5° / 6-ring ≤12°. Pass 3 "antialiasing" demotes isolated sp/sp2.

- [ ] **Step 1: Write the failing test**

Add to `perceive.rs`:

```rust
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
```

Add tests:

```rust
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
```

- [ ] **Step 2: Run to verify FAIL** (tests first, impl absent):
`cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib perceive::tests::hyb`
Expected: FAIL — `assign_hybridization` undefined.

- [ ] **Step 3: (impl in Step 1)**

- [ ] **Step 4: Run to verify PASS**
Run: `cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib perceive::tests`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/catrender-wasm/src/perceive.rs
git commit -m "feat(catrender): perceive hybridization passes 1-3 [OB port P4]"
```

---

## Task 5: Aromatic pass (pass 5) → order 1.5

**Files:**
- Modify: `extensions/catrender-wasm/src/perceive.rs`

OB reference (mol.cpp:3368-3394): for each 5/6/7-ring, if NO atom already has a double/triple bond and ALL atoms are sp2 → mark every ring bond aromatic. We emit `order = 1.5` instead of `SetAromatic()+kekulize`.

- [ ] **Step 1: Write the failing test**

Add to `perceive.rs`:

```rust
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
```

Add test:

```rust
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
```

- [ ] **Step 2: Run FAIL** (test first): `cargo test ... --lib perceive::tests::aromatic`
Expected: FAIL — `assign_aromatic` undefined.

- [ ] **Step 3: (impl in Step 1)**

- [ ] **Step 4: Run PASS:** `cargo test ... --lib perceive::tests`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/catrender-wasm/src/perceive.rs
git commit -m "feat(catrender): perceive aromatic pass → order 1.5 [OB port P5]"
```

---

## Task 6: Multi-bond pass 6 + public entry `perceive_bond_orders`

**Files:**
- Modify: `extensions/catrender-wasm/src/perceive.rs`

OB reference (mol.cpp:3430-3575): sort atoms by `electroneg*1e6 + shortestBond` descending (`SortAtomZ`), then greedily assign triple bonds (sp atoms) and double bonds (sp2 atoms), respecting `valence+Δ ≤ max_bonds`, terminal-bond length tests vs `CorrectedBondRad`, `IsDoubleBondGeometry`, and ring-preference tie-breaks.

- [ ] **Step 1: Write the failing test**

Add `is_double_bond_geometry`, `assign_multibonds`, and the public `perceive_bond_orders` to `perceive.rs`:

```rust
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

    // sort key: electroneg*1e6 + shortest heavy-atom bond length, DESC
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
        key(g, y).partial_cmp(&key(g, x)).unwrap_or(std::cmp::Ordering::Equal)
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
```

Add tests:

```rust
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
```

- [ ] **Step 2: Run FAIL** (tests first): `cargo test ... --lib perceive::tests::multibond`
Expected: FAIL — `perceive_bond_orders` undefined.

- [ ] **Step 3: (impl in Step 1)**

- [ ] **Step 4: Run PASS:** `cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib`
Expected: PASS — all perceive tests + the existing 128 svg tests still green.

> If `multibond_acetylene_triple` fails because Pass 1 didn't set sp (the H makes avg angle 180 only over the C–C–H... acetylene C has 2 nbrs → one angle 180 → sp): verify `average_bond_angle` returns ~180 for the linear C. If a real edge case appears, capture the actual order array in the assert message and debug against OB semantics — do NOT weaken the assert.

- [ ] **Step 5: Commit**

```bash
git add extensions/catrender-wasm/src/perceive.rs
git commit -m "feat(catrender): perceive multibond pass 6 + public entry [OB port P6]"
```

---

## Task 7: Wire perception into the render pipeline (`perceive_orders` flag)

**Files:**
- Modify: `extensions/catrender-wasm/src/types.rs` (add `perceive_orders` to `Style`)
- Modify: `extensions/catrender-wasm/src/svg.rs` (call perception; auto-enable `bond_orders`)

- [ ] **Step 1: Write the failing test**

Add to `svg.rs` `mod tests`:

```rust
    #[test]
    fn perceive_orders_renders_benzene_aromatic() {
        // 6 carbons in a planar hexagon, explicit bonds, perceive_orders on.
        // Aromatic strokes use width 0.7·bw — assert the multi/aromatic stroke
        // width appears (single bonds use full bw). With perception ON, every
        // C-C bond becomes aromatic (1.5) so the thinner aromatic stroke shows.
        let s = render(
            r#"{"atoms":[
                {"el":"C","xyz":[1.39,0,0]},{"el":"C","xyz":[0.695,1.203,0]},
                {"el":"C","xyz":[-0.695,1.203,0]},{"el":"C","xyz":[-1.39,0,0]},
                {"el":"C","xyz":[-0.695,-1.203,0]},{"el":"C","xyz":[0.695,-1.203,0]}],
                "bonds":[{"i":0,"j":1},{"i":1,"j":2},{"i":2,"j":3},
                         {"i":3,"j":4},{"i":4,"j":5},{"i":5,"j":0}],
                "style":{"preset":"default","auto_orient":false,"perceive_orders":true}}"#,
        );
        // aromatic ring-side bonds emit a SECOND offset line per bond (the
        // inner aromatic line). A plain single-bond benzene emits 6 <line>;
        // aromatic emits more. Assert > 6 bond lines.
        let lines = s.matches("<line").count();
        assert!(lines > 6, "perceived aromatic benzene should add inner lines, got {lines}");
    }

    #[test]
    fn perceive_orders_off_keeps_single() {
        let s = render(
            r#"{"atoms":[
                {"el":"C","xyz":[1.39,0,0]},{"el":"C","xyz":[0.695,1.203,0]},
                {"el":"C","xyz":[-0.695,1.203,0]},{"el":"C","xyz":[-1.39,0,0]},
                {"el":"C","xyz":[-0.695,-1.203,0]},{"el":"C","xyz":[0.695,-1.203,0]}],
                "bonds":[{"i":0,"j":1},{"i":1,"j":2},{"i":2,"j":3},
                         {"i":3,"j":4},{"i":4,"j":5},{"i":5,"j":0}],
                "style":{"preset":"default","auto_orient":false}}"#,
        );
        assert_eq!(s.matches("<line").count(), 6, "single-bond benzene = 6 lines");
    }
```

- [ ] **Step 2: Run to verify FAIL**

Run: `cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib perceive_orders_renders`
Expected: FAIL — `perceive_orders` is an unknown field in JSON (serde ignores unknown by default, so the flag is silently false → still 6 lines → assert `>6` FAILS). Good fail-first.

- [ ] **Step 3: Add the Style field**

In `extensions/catrender-wasm/src/types.rs`, inside `struct Style`, after the `drag_rotation` field:

```rust
    /// Run OpenBabel-style geometry bond-order perception (perceive.rs) before
    /// rendering, overriding supplied single orders. Implies bond-order
    /// rendering. Default off (slabs/ionic crystals should NOT auto-perceive).
    #[serde(default)]
    pub perceive_orders: bool,
```

- [ ] **Step 4: Call perception in svg.rs**

In `extensions/catrender-wasm/src/svg.rs`, locate where bonds are resolved — the block around line 214:

```rust
    let perceived;
    let bonds_ref = if /* existing condition: inp.bonds empty */ {
        perceived = bonds::perceive(&inp.atoms);
        &perceived
    } else {
        &inp.bonds
    };
```

Replace that resolution so that, when `inp.style.perceive_orders` is set, we run perception on the resolved connectivity and use the re-ordered bonds. Add immediately AFTER the existing `bonds_ref` is determined (and BEFORE `edges`/`bond_orders` are consumed):

```rust
    // OpenBabel-style bond-order perception (opt-in). Rebuilds orders on a
    // local copy so the input borrow stays immutable. perceive.rs handles
    // single/double/triple + aromatic(=1.5). See plan 2026-05-21.
    let perceived_owned: Vec<types::Bond>;
    let bonds_ref: &[types::Bond] = if inp.style.perceive_orders {
        let z: Vec<u32> = inp.atoms.iter().map(|a| s2n(&a.el)).collect();
        let xyz: Vec<[f64; 3]> = inp.atoms.iter().map(|a| a.xyz).collect();
        let pairs: Vec<(usize, usize)> =
            bonds_ref.iter().map(|b| (b.i, b.j)).collect();
        let mut orders: Vec<f64> = bonds_ref.iter().map(|b| b.order).collect();
        perceive::perceive_bond_orders(&z, &xyz, &pairs, &mut orders);
        perceived_owned = bonds_ref
            .iter()
            .zip(orders.iter())
            .map(|(b, &o)| types::Bond { i: b.i, j: b.j, order: o, ts: b.ts, nci: b.nci })
            .collect();
        &perceived_owned
    } else {
        bonds_ref
    };
```

Then force `bond_orders` rendering on when perception ran. Locate `let bond_orders = cfg_b(&cfg, "bond_orders", false);` (svg.rs:163) and change to:

```rust
    let bond_orders = cfg_b(&cfg, "bond_orders", false) || inp.style.perceive_orders;
```

> Note: confirm the exact name of the pre-existing bond-resolution binding (it may not be literally `bonds_ref`). Rename the new block's source/target to match. The `perceive` module path is `crate::perceive` — `perceive::perceive_bond_orders` works because `mod perceive;` is in lib.rs; if `svg.rs` lacks a `use`, call `crate::perceive::perceive_bond_orders`.

- [ ] **Step 5: Run to verify PASS**

Run: `cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib`
Expected: PASS — both new tests + all prior tests (128 + perceive) green.

- [ ] **Step 6: Clippy**

Run: `cargo clippy --manifest-path extensions/catrender-wasm/Cargo.toml --lib 2>&1 | grep -E 'svg.rs|perceive.rs' || echo CLEAN`
Expected: no warnings in `svg.rs`/`perceive.rs` (fix any `needless_range_loop` by indexing explicitly, matching existing file style).

- [ ] **Step 7: Commit**

```bash
git add extensions/catrender-wasm/src/types.rs extensions/catrender-wasm/src/svg.rs
git commit -m "feat(catrender): wire perceive_orders flag into render pipeline [OB port P7]"
```

---

## Task 8: Atom index display (`show_index` flag)

**Files:**
- Modify: `extensions/catrender-wasm/src/types.rs`
- Modify: `extensions/catrender-wasm/src/svg.rs`

- [ ] **Step 1: Write the failing test**

Add to `svg.rs` `mod tests`:

```rust
    #[test]
    fn show_index_emits_labels() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[2,0,0]}],
                "style":{"preset":"default","auto_orient":false,"show_index":true}}"#,
        );
        assert!(s.contains("class=\"atom-index\""), "index labels present");
        // both original indices 0 and 1 appear as label text
        assert!(s.contains(">0</text>") && s.contains(">1</text>"), "indices 0 and 1 labelled");
    }

    #[test]
    fn show_index_off_no_labels() {
        let s = render(
            r#"{"atoms":[{"el":"C","xyz":[0,0,0]},{"el":"O","xyz":[2,0,0]}],
                "style":{"preset":"default","auto_orient":false}}"#,
        );
        assert!(!s.contains("class=\"atom-index\""), "no index labels when off");
    }
```

- [ ] **Step 2: Run FAIL:** `cargo test ... --lib show_index`
Expected: FAIL — unknown field → flag false → no `atom-index` class → first assert fails.

- [ ] **Step 3: Add Style field**

In `types.rs` `struct Style`, after `perceive_orders`:

```rust
    /// Overlay each atom's ORIGINAL index as a small label (editing aid for
    /// setting bond i/j). Default off; turn off for publication figures.
    #[serde(default)]
    pub show_index: bool,
```

- [ ] **Step 4: Emit labels in svg.rs**

In `svg.rs`, find the atom-drawing loop where each kept atom's projected centre `(xi, yi)` and its original index `keep[d]` are available (near the `<circle ... cx=...` emission, ~line 910). After the circle is pushed for a real (non-ghost, non-suppressed) atom, append:

```rust
            if inp.style.show_index && !image_flag[di] && !suppress_draw[di] {
                // ORIGINAL atom index (keep[di]) — the i/j a user types into
                // the bond editor. Small dark label, offset up-right of centre.
                svg.push(format!(
                    "  <text class=\"atom-index\" x=\"{:.1}\" y=\"{:.1}\" \
font-size=\"{:.1}\" fill=\"#222\" text-anchor=\"middle\">{}</text>",
                    xi,
                    yi - r - 1.0,
                    (12.0 * sr).max(8.0),
                    keep[di]
                ));
            }
```

> Note: confirm the loop variable names in the painter loop (`di` for dense index, `xi`/`yi` for projected px, `r` for radius, `sr` scale ratio, `keep`, `image_flag`, `suppress_draw`). Adapt names to the actual loop. The label must use the ORIGINAL index `keep[di]`, not the dense/z-order index.

- [ ] **Step 5: Run PASS:** `cargo test --manifest-path extensions/catrender-wasm/Cargo.toml --lib`
Expected: PASS — both new tests + all prior green.

- [ ] **Step 6: Commit**

```bash
git add extensions/catrender-wasm/src/types.rs extensions/catrender-wasm/src/svg.rs
git commit -m "feat(catrender): show_index atom-index overlay flag [index display]"
```

---

## Task 9: Rebuild wasm + sync to runtime path

**Files:** (build artifacts; pkg dir is gitignored)

- [ ] **Step 1: Rebuild + sync**

```bash
cd extensions/catrender-wasm && wasm-pack build . --target web --out-dir pkg && cd ../..
cp extensions/catrender-wasm/pkg/catrender_wasm.js      src/lib/structure/catrender/catrender-wasm-pkg/catrender_wasm.js
cp extensions/catrender-wasm/pkg/catrender_wasm_bg.wasm src/lib/structure/catrender/catrender-wasm-pkg/catrender_wasm_bg.wasm
cp extensions/catrender-wasm/pkg/catrender_wasm.d.ts    src/lib/structure/catrender/catrender-wasm-pkg/catrender_wasm.d.ts
```

Expected: `wasm-pack` reports "Done"; the `.wasm` size changes.

- [ ] **Step 2: Commit (none — pkg gitignored)**. Proceed.

---

## Task 10: Frontend toggles + wiring

**Files:**
- Modify: `src/lib/structure/catrender/catrender-state.svelte.ts`
- Modify: `src/lib/structure/catrender/CatRenderParamsPane.svelte`
- Modify: `src/lib/structure/catrender/CatRenderViewPane.svelte`

- [ ] **Step 1: Add state knobs**

In `catrender-state.svelte.ts`, alongside the other boolean knob state (e.g. near `k_atoms_above_bonds`):

```typescript
  perceive_orders = $state<boolean>(false)
  show_index = $state<boolean>(false)
```

And include them where the render payload's `style` object is assembled (find where `auto_orient`/`drag_rotation`/`cell` are placed onto the style sent to wasm) — add:

```typescript
        perceive_orders: this.perceive_orders,
        show_index: this.show_index,
```

> Note: confirm how the payload `style` object is built (the `to_payload`/render-input assembly). Mirror the existing field-passing pattern exactly.

- [ ] **Step 2: Add "perceive bond orders" checkbox (Params pane)**

In `CatRenderParamsPane.svelte`, near the boolean knobs / cell toggles, add:

```svelte
    <label title="OpenBabel-style auto bond-order perception (molecular only — not for slabs/ionic)">
      <input type="checkbox" bind:checked={S.perceive_orders} /> perceive bond orders
    </label>
```

- [ ] **Step 3: Add "show indices" checkbox (View pane)**

In `CatRenderViewPane.svelte`, near the Bond edit panel, add:

```svelte
    <label title="Overlay atom indices (i/j for bond editing) — turn off for figures">
      <input type="checkbox" bind:checked={S.show_index} /> show indices
    </label>
```

- [ ] **Step 4: Verify svelte-check**

Run: `pnpm run check 2>&1 | tail -5`
Expected: 0 new errors (pre-existing baseline warnings unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/lib/structure/catrender/
git commit -m "feat(catrender): perceive-orders + show-index UI toggles [frontend]"
```

---

## Task 11: Browser verification (manual)

- [ ] **Step 1:** Rebuild already done (Task 9). Start dev server: `pnpm desktop:serve`. Open `http://localhost:3125/`. Hard-refresh.
- [ ] **Step 2:** Load benzene into the viewer. Open catrender. Enable **perceive bond orders**. Expected: aromatic ring-side inner lines appear (Kekulé/aromatic visual).
- [ ] **Step 3:** Enable **show indices**. Expected: each atom labelled with its index; read i/j; turn off → labels gone, clean figure.
- [ ] **Step 4:** Load a metal slab. Confirm **perceive bond orders** OFF by default (no spurious doubles). Toggling it on may produce noise — expected, it's molecular-only (documented).

---

## Self-Review

**Spec coverage:**
- OB perception port → Tasks 1-7 (element data, geometry, SSSR, hyb passes 1-3, aromatic pass 5, multibond pass 6, pipeline wiring). ✓
- Atom index display → Task 8 + 10. ✓
- Opt-in, default off, molecular-only framing → Task 7 (`perceive_orders` default false, comment), Task 10 (tooltip). ✓
- Aromatic→1.5 / skip Kekulize → Task 5. ✓ Pass 4 deferred → header + Task 6 scope. ✓

**Placeholder scan:** Steps that say "confirm exact binding name" / "adapt loop variable names" are unavoidable integration notes against existing code (svg.rs bond-resolution + painter loop), each with the concrete code to insert and the fallback path (`crate::perceive::…`). No TODO/TBD in deliverable code.

**Type consistency:** `perceive_bond_orders(z:&[u32], xyz:&[[f64;3]], bonds:&[(usize,usize)], orders:&mut[f64])` used identically in Task 6 tests and Task 7 wiring. `Graph`, `find_rings`, `assign_hybridization`, `assign_aromatic`, `assign_multibonds` signatures consistent across tasks. Style fields `perceive_orders`/`show_index` named identically in types.rs, svg.rs, state, and UI.

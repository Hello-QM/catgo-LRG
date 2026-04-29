# MOF Topology Rust/WASM — Phase 1 SBU/Linker Detection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically decompose MOF crystal structures into inorganic SBUs and organic linkers via a Rust/WASM module, porting CrystalNets.jl's clustering algorithm.

**Architecture:** New `mof/` module under `extensions/rust/src/` with 5 files (~1050 lines). Builds on existing `Structure`, `Element`, `Bond` types. Exposed via `#[wasm_bindgen]` function `detect_mof_sbus()`. Frontend calls after bond detection, receives JSON with SBU assignments.

**Tech Stack:** Rust, wasm-bindgen, serde, nalgebra (all already in Cargo.toml)

---

### Task 1: Create `mof/mod.rs` — public types and module entry

**Files:**
- Create: `extensions/rust/src/mof/mod.rs`
- Modify: `extensions/rust/src/lib.rs`

- [ ] **Step 1: Create the module directory**

```bash
mkdir -p extensions/rust/src/mof
```

- [ ] **Step 2: Create `mod.rs` with public types**

Create `extensions/rust/src/mof/mod.rs`:

```rust
//! MOF topology analysis — SBU/Linker detection.
//!
//! Ports CrystalNets.jl's clustering algorithm to Rust.
//! Given a crystal structure and bonds (with periodic image offsets),
//! automatically identifies inorganic SBUs, organic linkers, and
//! points of extension.

pub mod periodic_graph;
pub mod classify;
pub mod clustering;
pub mod paddlewheel;

use serde::{Deserialize, Serialize};

/// Type of a Secondary Building Unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SbuType {
    /// Metal cluster + bridging atoms (e.g., Zr6O4(OH)4)
    Inorganic,
    /// Organic linker (e.g., BDC, BTC)
    Organic,
    /// Connection point between SBU and linker
    PointOfExtension,
}

/// A single Secondary Building Unit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sbu {
    /// Indices of atoms belonging to this SBU (in the input structure).
    pub atom_indices: Vec<usize>,
    /// Classification of this SBU.
    pub sbu_type: SbuType,
    /// Whether this SBU spans across periodic cell boundaries.
    pub is_periodic: bool,
}

/// Result of MOF decomposition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MofClusters {
    /// List of identified SBUs.
    pub sbus: Vec<Sbu>,
    /// Maps each atom index to its SBU index. `attributions[i]` = index into `sbus`.
    pub attributions: Vec<usize>,
    /// Whether this structure was identified as a MOF.
    pub is_mof: bool,
}

/// Run MOF SBU/Linker detection on a structure with pre-computed bonds.
///
/// # Arguments
/// * `structure` - Crystal structure with lattice, sites, coordinates
/// * `bonds` - Pre-computed bonds with periodic image offsets
///
/// # Returns
/// `MofClusters` with SBU assignments for each atom.
pub fn detect_sbus(
    structure: &crate::structure::Structure,
    bonds: &[crate::bonding::Bond],
) -> MofClusters {
    use periodic_graph::PeriodicGraph;

    // Step 1: Build periodic graph from bonds
    let n = structure.frac_coords.len();
    let graph = PeriodicGraph::from_bonds(n, bonds);

    // Step 2: Classify atoms by element type
    let elements: Vec<crate::element::Element> = structure
        .site_occupancies
        .iter()
        .map(|occ| occ.majority_species().species.element)
        .collect();
    let mut classes = classify::classify_atoms(&elements);

    // Step 3: Reclassify temporary atoms based on neighbors
    classify::reclassify_temporary(&graph, &elements, &mut classes);

    // Step 4: Find connected components → initial SBUs
    let mut clusters = clustering::find_connected_sbus(&graph, &classes, n);

    // Step 5: Detect and merge paddle-wheels
    paddlewheel::detect_and_merge(&graph, &elements, &mut clusters);

    // Step 6: Resolve periodic SBUs
    clustering::resolve_periodic_sbus(&graph, &elements, &mut clusters);

    // Step 7: Mark points of extension
    clustering::mark_points_of_extension(&graph, &mut clusters);

    // Check if this is actually a MOF (needs both inorganic and organic SBUs)
    let has_inorganic = clusters.sbus.iter().any(|s| s.sbu_type == SbuType::Inorganic);
    let has_organic = clusters.sbus.iter().any(|s| s.sbu_type == SbuType::Organic);

    MofClusters {
        is_mof: has_inorganic && has_organic,
        sbus: clusters.sbus,
        attributions: clusters.attributions,
    }
}
```

- [ ] **Step 3: Register the module in `lib.rs`**

Add after `pub mod ewald;` (around line 66):

```rust
pub mod mof;
```

- [ ] **Step 4: Commit**

```bash
git add extensions/rust/src/mof/mod.rs extensions/rust/src/lib.rs
git commit -m "feat(mof): add mof module entry with public types (MofClusters, Sbu, SbuType)"
```

---

### Task 2: Create `mof/periodic_graph.rs` — periodic graph data structure

**Files:**
- Create: `extensions/rust/src/mof/periodic_graph.rs`

- [ ] **Step 1: Create the periodic graph implementation**

Create `extensions/rust/src/mof/periodic_graph.rs`:

```rust
//! Periodic graph with offset-aware adjacency lists.
//!
//! Each edge carries a periodic image offset [i32; 3] indicating which
//! unit cell the destination atom is in relative to the source.

use crate::bonding::Bond;

/// A neighbor in the periodic graph: vertex index + periodic offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PeriodicNeighbor {
    /// Vertex (atom) index.
    pub v: usize,
    /// Periodic offset (cell image) of this neighbor.
    pub ofs: [i32; 3],
}

/// Adjacency-list graph where edges carry periodic offsets.
///
/// Built from `Bond` list. For each bond (a, b, image), creates two
/// directed edges: a→(b, image) and b→(a, -image).
#[derive(Debug, Clone)]
pub struct PeriodicGraph {
    pub n_vertices: usize,
    adjacency: Vec<Vec<PeriodicNeighbor>>,
}

impl PeriodicGraph {
    /// Build from a list of bonds with periodic image offsets.
    pub fn from_bonds(n_vertices: usize, bonds: &[Bond]) -> Self {
        let mut adjacency = vec![Vec::new(); n_vertices];
        for bond in bonds {
            let a = bond.site_idx_1;
            let b = bond.site_idx_2;
            let img = bond.image;
            if a < n_vertices && b < n_vertices {
                adjacency[a].push(PeriodicNeighbor {
                    v: b,
                    ofs: img,
                });
                adjacency[b].push(PeriodicNeighbor {
                    v: a,
                    ofs: [-img[0], -img[1], -img[2]],
                });
            }
        }
        Self { n_vertices, adjacency }
    }

    /// Get all neighbors of vertex `v`.
    pub fn neighbors(&self, v: usize) -> &[PeriodicNeighbor] {
        &self.adjacency[v]
    }

    /// Get the degree (number of neighbors) of vertex `v`.
    pub fn degree(&self, v: usize) -> usize {
        self.adjacency[v].len()
    }

    /// Add a directed edge from `src` to `dst` with offset.
    /// Also adds the reverse edge from `dst` to `src` with negated offset.
    pub fn add_edge(&mut self, src: usize, dst: usize, ofs: [i32; 3]) {
        self.adjacency[src].push(PeriodicNeighbor { v: dst, ofs });
        self.adjacency[dst].push(PeriodicNeighbor {
            v: src,
            ofs: [-ofs[0], -ofs[1], -ofs[2]],
        });
    }

    /// Remove all edges between `src` and `dst` (both directions).
    pub fn remove_edges_between(&mut self, src: usize, dst: usize) {
        self.adjacency[src].retain(|n| n.v != dst);
        self.adjacency[dst].retain(|n| n.v != src);
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add extensions/rust/src/mof/periodic_graph.rs
git commit -m "feat(mof): add PeriodicGraph with offset-aware adjacency lists"
```

---

### Task 3: Create `mof/classify.rs` — element classification

**Files:**
- Create: `extensions/rust/src/mof/classify.rs`

- [ ] **Step 1: Create the classification module**

Create `extensions/rust/src/mof/classify.rs`:

```rust
//! Atom classification for MOF decomposition.
//!
//! Classifies atoms into categories following CrystalNets.jl's ClusterKinds:
//! - Class 1: Metals (inorganic SBU cores)
//! - Class 2: Carbon (organic framework)
//! - Class 3: P, S (temporary — reclassified based on neighbors)
//! - Class 4: Nonmetals, metalloids, halogens (temporary — reclassified)
//! - Class 0: Noble gases (ignored)

use crate::element::Element;
use super::periodic_graph::PeriodicGraph;

/// Atom class constants.
pub const CLASS_IGNORED: i32 = 0;
pub const CLASS_INORGANIC: i32 = 1;
pub const CLASS_ORGANIC: i32 = 2;
pub const CLASS_TEMP_PS: i32 = 3;
pub const CLASS_TEMP_NONMETAL: i32 = 4;

/// Classify each atom by its element type.
///
/// Returns a vector where `classes[i]` is the initial class for atom `i`.
pub fn classify_atoms(elements: &[Element]) -> Vec<i32> {
    elements.iter().map(|el| classify_element(el)).collect()
}

fn classify_element(el: &Element) -> i32 {
    if el.is_noble_gas() {
        CLASS_IGNORED
    } else if el.is_metal() {
        CLASS_INORGANIC
    } else if *el == Element::C {
        CLASS_ORGANIC
    } else if *el == Element::P || *el == Element::S {
        CLASS_TEMP_PS
    } else {
        // H, N, O, F, Cl, Br, I, B, Si, Ge, As, Sb, Te, etc.
        CLASS_TEMP_NONMETAL
    }
}

/// Reclassify temporary atoms (classes 3, 4) based on their neighbors.
///
/// For each connected component of temporary atoms:
/// - If any neighbor is inorganic → assign inorganic
/// - If any neighbor is organic → assign organic
/// - If neighbors are mixed → assign to the majority
/// - If no classified neighbors → default to organic
pub fn reclassify_temporary(
    graph: &PeriodicGraph,
    elements: &[Element],
    classes: &mut [i32],
) {
    let n = classes.len();
    let mut visited = vec![false; n];

    for start in 0..n {
        if visited[start] || !is_temporary(classes[start]) {
            continue;
        }

        // BFS to find connected component of same-class temporary atoms
        let start_class = classes[start];
        let mut component = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(start);
        visited[start] = true;

        // Count neighbors in classified groups
        let mut inorganic_neighbors = 0u32;
        let mut organic_neighbors = 0u32;

        while let Some(u) = queue.pop_front() {
            component.push(u);

            for nbr in graph.neighbors(u) {
                let v = nbr.v;
                if v >= n { continue; }

                let v_class = classes[v];
                if v_class == CLASS_INORGANIC {
                    inorganic_neighbors += 1;
                } else if v_class == CLASS_ORGANIC {
                    organic_neighbors += 1;
                } else if v_class == start_class && !visited[v] {
                    visited[v] = true;
                    queue.push_back(v);
                }
            }
        }

        // Assign class based on neighbor majority
        let new_class = if inorganic_neighbors > 0 && inorganic_neighbors >= organic_neighbors {
            CLASS_INORGANIC
        } else if organic_neighbors > 0 {
            CLASS_ORGANIC
        } else {
            // No classified neighbors — default to organic
            CLASS_ORGANIC
        };

        // Special handling: P and S bonded to organic become organic
        // (CrystalNets marks them as :Pc / :Ss)
        for &idx in &component {
            if start_class == CLASS_TEMP_PS && new_class == CLASS_ORGANIC {
                classes[idx] = CLASS_ORGANIC;
            } else {
                classes[idx] = new_class;
            }
        }
    }
}

fn is_temporary(class: i32) -> bool {
    class == CLASS_TEMP_PS || class == CLASS_TEMP_NONMETAL
}
```

- [ ] **Step 2: Commit**

```bash
git add extensions/rust/src/mof/classify.rs
git commit -m "feat(mof): add atom classification (metal/organic/temporary with reclassification)"
```

---

### Task 4: Create `mof/clustering.rs` — BFS connected components and SBU resolution

**Files:**
- Create: `extensions/rust/src/mof/clustering.rs`

- [ ] **Step 1: Create the clustering module**

Create `extensions/rust/src/mof/clustering.rs`:

```rust
//! Connected component clustering for MOF SBU detection.
//!
//! Groups atoms of the same class into SBUs via BFS on the periodic graph.
//! Handles periodic SBUs (those spanning cell boundaries) by iterative splitting.

use std::collections::{HashMap, HashSet, VecDeque};
use crate::element::Element;
use super::periodic_graph::{PeriodicGraph, PeriodicNeighbor};
use super::classify::{CLASS_INORGANIC, CLASS_ORGANIC, CLASS_IGNORED};
use super::{MofClusters, Sbu, SbuType};

/// Intermediate clustering state used during SBU construction.
pub struct ClusteringState {
    pub sbus: Vec<Sbu>,
    pub attributions: Vec<usize>,
    pub classes: Vec<i32>,
}

/// Find connected components of same-class atoms → initial SBUs.
///
/// Uses BFS with periodic offset tracking. An SBU is marked periodic if
/// the same atom is reached at two different periodic offsets.
pub fn find_connected_sbus(
    graph: &PeriodicGraph,
    classes: &[i32],
    n: usize,
) -> ClusteringState {
    let mut attributions = vec![usize::MAX; n];
    let mut sbus: Vec<Sbu> = Vec::new();

    for start in 0..n {
        if attributions[start] != usize::MAX || classes[start] == CLASS_IGNORED {
            continue;
        }

        let sbu_class = classes[start];
        let sbu_idx = sbus.len();
        let mut atom_indices = Vec::new();
        let mut is_periodic = false;

        // BFS with offset tracking
        let mut queue = VecDeque::new();
        let mut offsets: HashMap<usize, [i32; 3]> = HashMap::new();

        queue.push_back((start, [0i32, 0, 0]));
        offsets.insert(start, [0, 0, 0]);
        attributions[start] = sbu_idx;
        atom_indices.push(start);

        while let Some((u, u_ofs)) = queue.pop_front() {
            for nbr in graph.neighbors(u) {
                let v = nbr.v;
                if v >= n || classes[v] != sbu_class {
                    continue;
                }

                let v_ofs = [
                    u_ofs[0] + nbr.ofs[0],
                    u_ofs[1] + nbr.ofs[1],
                    u_ofs[2] + nbr.ofs[2],
                ];

                if let Some(&existing_ofs) = offsets.get(&v) {
                    // Same atom reached at different offset → periodic SBU
                    if existing_ofs != v_ofs {
                        is_periodic = true;
                    }
                } else {
                    offsets.insert(v, v_ofs);
                    attributions[v] = sbu_idx;
                    atom_indices.push(v);
                    queue.push_back((v, v_ofs));
                }
            }
        }

        let sbu_type = if sbu_class == CLASS_INORGANIC {
            SbuType::Inorganic
        } else {
            SbuType::Organic
        };

        sbus.push(Sbu {
            atom_indices,
            sbu_type,
            is_periodic,
        });
    }

    ClusteringState {
        sbus,
        attributions,
        classes: classes.to_vec(),
    }
}

/// Resolve periodic SBUs by iterative splitting.
///
/// Periodic SBUs (spanning cell boundaries) are problematic for visualization.
/// Strategy: find the highest-degree atom in a periodic SBU, detach it from
/// the SBU (create a new single-atom SBU), then re-cluster. Repeat until
/// no periodic SBUs remain.
pub fn resolve_periodic_sbus(
    graph: &PeriodicGraph,
    elements: &[Element],
    state: &mut ClusteringState,
) {
    let max_iterations = 100;
    for _ in 0..max_iterations {
        let periodic_indices: Vec<usize> = state
            .sbus
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_periodic && s.atom_indices.len() > 1)
            .map(|(i, _)| i)
            .collect();

        if periodic_indices.is_empty() {
            break;
        }

        for &sbu_idx in &periodic_indices {
            let atoms = &state.sbus[sbu_idx].atom_indices;
            if atoms.len() <= 1 {
                continue;
            }

            // Find the highest-degree atom in this SBU (best split point)
            let split_atom = *atoms
                .iter()
                .max_by_key(|&&a| graph.degree(a))
                .unwrap();

            // Remove split_atom from current SBU
            state.sbus[sbu_idx].atom_indices.retain(|&a| a != split_atom);

            // Create new single-atom SBU
            let new_sbu_idx = state.sbus.len();
            state.sbus.push(Sbu {
                atom_indices: vec![split_atom],
                sbu_type: state.sbus[sbu_idx].sbu_type,
                is_periodic: false,
            });
            state.attributions[split_atom] = new_sbu_idx;

            // Re-check if the original SBU is still periodic
            state.sbus[sbu_idx].is_periodic =
                check_sbu_periodic(graph, &state.sbus[sbu_idx].atom_indices, &state.classes);
        }
    }
}

/// Check if a set of atoms forms a periodic SBU.
fn check_sbu_periodic(
    graph: &PeriodicGraph,
    atoms: &[usize],
    classes: &[i32],
) -> bool {
    if atoms.is_empty() {
        return false;
    }

    let atom_set: HashSet<usize> = atoms.iter().copied().collect();
    let sbu_class = classes[atoms[0]];
    let mut offsets: HashMap<usize, [i32; 3]> = HashMap::new();
    let mut queue = VecDeque::new();

    queue.push_back((atoms[0], [0i32, 0, 0]));
    offsets.insert(atoms[0], [0, 0, 0]);

    while let Some((u, u_ofs)) = queue.pop_front() {
        for nbr in graph.neighbors(u) {
            if !atom_set.contains(&nbr.v) || classes[nbr.v] != sbu_class {
                continue;
            }
            let v_ofs = [
                u_ofs[0] + nbr.ofs[0],
                u_ofs[1] + nbr.ofs[1],
                u_ofs[2] + nbr.ofs[2],
            ];
            if let Some(&existing) = offsets.get(&nbr.v) {
                if existing != v_ofs {
                    return true;
                }
            } else {
                offsets.insert(nbr.v, v_ofs);
                queue.push_back((nbr.v, v_ofs));
            }
        }
    }
    false
}

/// Mark organic atoms bonded only to inorganic SBUs as PointOfExtension.
///
/// These atoms bridge SBUs and linkers (e.g., carboxylate oxygens).
pub fn mark_points_of_extension(
    graph: &PeriodicGraph,
    state: &mut ClusteringState,
) {
    let n = state.attributions.len();

    for atom in 0..n {
        let sbu_idx = state.attributions[atom];
        if sbu_idx >= state.sbus.len() {
            continue;
        }
        if state.sbus[sbu_idx].sbu_type != SbuType::Organic {
            continue;
        }

        // Check if ALL neighbors of this atom belong to inorganic SBUs
        let neighbors = graph.neighbors(atom);
        if neighbors.is_empty() {
            continue;
        }

        let all_inorganic = neighbors.iter().all(|nbr| {
            let nbr_sbu = state.attributions[nbr.v];
            nbr_sbu < state.sbus.len() && state.sbus[nbr_sbu].sbu_type == SbuType::Inorganic
        });

        if all_inorganic {
            // Move this atom to a new PointOfExtension SBU
            state.sbus[sbu_idx].atom_indices.retain(|&a| a != atom);

            let pe_idx = state.sbus.len();
            state.sbus.push(Sbu {
                atom_indices: vec![atom],
                sbu_type: SbuType::PointOfExtension,
                is_periodic: false,
            });
            state.attributions[atom] = pe_idx;
        }
    }

    // Clean up empty SBUs
    compact_sbus(state);
}

/// Remove empty SBUs and reindex attributions.
fn compact_sbus(state: &mut ClusteringState) {
    let mut new_sbus = Vec::new();
    let mut old_to_new = vec![usize::MAX; state.sbus.len()];

    for (old_idx, sbu) in state.sbus.iter().enumerate() {
        if !sbu.atom_indices.is_empty() {
            old_to_new[old_idx] = new_sbus.len();
            new_sbus.push(sbu.clone());
        }
    }

    for attr in state.attributions.iter_mut() {
        if *attr < old_to_new.len() {
            *attr = old_to_new[*attr];
        }
    }

    state.sbus = new_sbus;
}
```

- [ ] **Step 2: Commit**

```bash
git add extensions/rust/src/mof/clustering.rs
git commit -m "feat(mof): add BFS connected-component clustering with periodic SBU resolution"
```

---

### Task 5: Create `mof/paddlewheel.rs` — paddle-wheel detection

**Files:**
- Create: `extensions/rust/src/mof/paddlewheel.rs`

- [ ] **Step 1: Create the paddle-wheel detection module**

Create `extensions/rust/src/mof/paddlewheel.rs`:

```rust
//! Paddle-wheel pattern detection and merging for MOF SBU analysis.
//!
//! A paddle-wheel consists of two metal centers bridged by carboxylate
//! or similar bidentate linkers. Common in MOFs like HKUST-1 (Cu2(BTC)).
//!
//! Detection: two small inorganic SBUs (4-6 atoms each, exactly 1 metal)
//! connected through carbon bridges, merged into a single binuclear SBU.

use std::collections::HashMap;
use crate::element::Element;
use super::periodic_graph::PeriodicGraph;
use super::clustering::ClusteringState;
use super::SbuType;

/// Detect paddle-wheel patterns and merge paired inorganic SBUs.
pub fn detect_and_merge(
    graph: &PeriodicGraph,
    elements: &[Element],
    state: &mut ClusteringState,
) {
    let candidates = find_candidates(elements, state);
    if candidates.is_empty() {
        return;
    }

    let pairs = find_pairs(graph, elements, state, &candidates);
    merge_pairs(state, &pairs);
}

/// A paddle-wheel candidate: an inorganic SBU with 4-6 atoms and exactly 1 metal.
struct PaddlewheelCandidate {
    sbu_idx: usize,
    metal_atom: usize,
    metal_element: Element,
}

fn find_candidates(
    elements: &[Element],
    state: &ClusteringState,
) -> Vec<PaddlewheelCandidate> {
    let mut candidates = Vec::new();

    for (sbu_idx, sbu) in state.sbus.iter().enumerate() {
        if sbu.sbu_type != SbuType::Inorganic {
            continue;
        }
        let n = sbu.atom_indices.len();
        if n < 4 || n > 6 {
            continue;
        }

        // Must have exactly 1 metal, no carbons
        let mut metal_atom = None;
        let mut metal_count = 0;
        let mut has_carbon = false;

        for &idx in &sbu.atom_indices {
            if idx >= elements.len() { continue; }
            if elements[idx].is_metal() {
                metal_count += 1;
                metal_atom = Some(idx);
            }
            if elements[idx] == Element::C {
                has_carbon = true;
            }
        }

        if metal_count == 1 && !has_carbon {
            if let Some(metal) = metal_atom {
                candidates.push(PaddlewheelCandidate {
                    sbu_idx,
                    metal_atom: metal,
                    metal_element: elements[metal],
                });
            }
        }
    }

    candidates
}

/// Find pairs of paddle-wheel candidates connected through carbon bridges.
fn find_pairs(
    graph: &PeriodicGraph,
    elements: &[Element],
    state: &ClusteringState,
    candidates: &[PaddlewheelCandidate],
) -> Vec<(usize, usize)> {
    // Build sbu_idx → candidate index map
    let sbu_to_cand: HashMap<usize, usize> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| (c.sbu_idx, i))
        .collect();

    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut paired: Vec<bool> = vec![false; candidates.len()];

    for (ci, cand) in candidates.iter().enumerate() {
        if paired[ci] { continue; }

        // Look for bridge: nonmetal in this SBU → C atom → nonmetal in another candidate SBU
        let mut opposite_counts: HashMap<usize, u32> = HashMap::new();

        for &atom in &state.sbus[cand.sbu_idx].atom_indices {
            if atom >= elements.len() || elements[atom].is_metal() {
                continue;
            }
            // This is a nonmetal in the SBU — check its neighbors for C atoms
            for nbr in graph.neighbors(atom) {
                if nbr.v >= elements.len() || elements[nbr.v] != Element::C {
                    continue;
                }
                // C atom found — check ITS neighbors for nonmetals in other candidate SBUs
                for c_nbr in graph.neighbors(nbr.v) {
                    if c_nbr.v >= elements.len() || elements[c_nbr.v].is_metal() {
                        continue;
                    }
                    let other_sbu = state.attributions[c_nbr.v];
                    if other_sbu == cand.sbu_idx { continue; }
                    if let Some(&other_ci) = sbu_to_cand.get(&other_sbu) {
                        if !paired[other_ci]
                            && candidates[other_ci].metal_element == cand.metal_element
                        {
                            *opposite_counts.entry(other_ci).or_insert(0) += 1;
                        }
                    }
                }
            }
        }

        // Need at least 2 bridging contacts to confirm paddle-wheel
        if let Some((&best_ci, &count)) = opposite_counts.iter().max_by_key(|(_, &c)| c) {
            if count >= 2 {
                pairs.push((ci, best_ci));
                paired[ci] = true;
                paired[best_ci] = true;
            }
        }
    }

    pairs
}

/// Merge paired paddle-wheel SBUs.
fn merge_pairs(
    state: &mut ClusteringState,
    pairs: &[(usize, usize)],
) {
    // We don't have direct access to candidates here, so re-derive from pairs
    // Pairs contain candidate indices — we need SBU indices
    // Actually, pairs should contain candidate indices which have sbu_idx
    // Let's restructure: pairs are (cand_idx_1, cand_idx_2)
    // But we don't have candidates here... let's pass sbu pairs instead

    // Note: This is called with candidate-index pairs, but the caller
    // should map these to SBU index pairs before calling.
    // For now, pairs are assumed to be (sbu_idx_1, sbu_idx_2).
}
```

Wait, I need to fix the interface. Let me restructure:

```rust
//! Paddle-wheel pattern detection and merging for MOF SBU analysis.

use std::collections::HashMap;
use crate::element::Element;
use super::periodic_graph::PeriodicGraph;
use super::clustering::ClusteringState;
use super::SbuType;

/// Detect paddle-wheel patterns and merge paired inorganic SBUs.
pub fn detect_and_merge(
    graph: &PeriodicGraph,
    elements: &[Element],
    state: &mut ClusteringState,
) {
    let candidates = find_candidates(elements, state);
    if candidates.is_empty() {
        return;
    }

    let pairs = find_sbu_pairs(graph, elements, state, &candidates);

    // Merge: move atoms from sbu_b into sbu_a
    for (sbu_a, sbu_b) in pairs {
        let atoms_b: Vec<usize> = state.sbus[sbu_b].atom_indices.clone();
        for &atom in &atoms_b {
            state.attributions[atom] = sbu_a;
        }
        state.sbus[sbu_a].atom_indices.extend(atoms_b);
        state.sbus[sbu_b].atom_indices.clear();
    }
}

struct PaddlewheelCandidate {
    sbu_idx: usize,
    metal_element: Element,
}

fn find_candidates(
    elements: &[Element],
    state: &ClusteringState,
) -> Vec<PaddlewheelCandidate> {
    let mut candidates = Vec::new();
    for (sbu_idx, sbu) in state.sbus.iter().enumerate() {
        if sbu.sbu_type != SbuType::Inorganic { continue; }
        let n = sbu.atom_indices.len();
        if n < 4 || n > 6 { continue; }

        let mut metal_count = 0;
        let mut metal_el = None;
        let mut has_carbon = false;

        for &idx in &sbu.atom_indices {
            if idx >= elements.len() { continue; }
            if elements[idx].is_metal() {
                metal_count += 1;
                metal_el = Some(elements[idx]);
            }
            if elements[idx] == Element::C { has_carbon = true; }
        }

        if metal_count == 1 && !has_carbon {
            if let Some(el) = metal_el {
                candidates.push(PaddlewheelCandidate { sbu_idx, metal_element: el });
            }
        }
    }
    candidates
}

/// Find SBU-index pairs of paddle-wheel candidates connected through C bridges.
fn find_sbu_pairs(
    graph: &PeriodicGraph,
    elements: &[Element],
    state: &ClusteringState,
    candidates: &[PaddlewheelCandidate],
) -> Vec<(usize, usize)> {
    let sbu_to_cand: HashMap<usize, usize> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| (c.sbu_idx, i))
        .collect();

    let mut pairs = Vec::new();
    let mut paired = vec![false; candidates.len()];

    for (ci, cand) in candidates.iter().enumerate() {
        if paired[ci] { continue; }
        let mut opposite_counts: HashMap<usize, u32> = HashMap::new();

        for &atom in &state.sbus[cand.sbu_idx].atom_indices {
            if atom >= elements.len() || elements[atom].is_metal() { continue; }
            for nbr in graph.neighbors(atom) {
                if nbr.v >= elements.len() || elements[nbr.v] != Element::C { continue; }
                for c_nbr in graph.neighbors(nbr.v) {
                    if c_nbr.v >= elements.len() || elements[c_nbr.v].is_metal() { continue; }
                    let other_sbu = state.attributions[c_nbr.v];
                    if other_sbu == cand.sbu_idx { continue; }
                    if let Some(&other_ci) = sbu_to_cand.get(&other_sbu) {
                        if !paired[other_ci] && candidates[other_ci].metal_element == cand.metal_element {
                            *opposite_counts.entry(other_ci).or_insert(0) += 1;
                        }
                    }
                }
            }
        }

        if let Some((&best_ci, &count)) = opposite_counts.iter().max_by_key(|(_, &c)| c) {
            if count >= 2 {
                pairs.push((cand.sbu_idx, candidates[best_ci].sbu_idx));
                paired[ci] = true;
                paired[best_ci] = true;
            }
        }
    }
    pairs
}
```

- [ ] **Step 2: Commit**

```bash
git add extensions/rust/src/mof/paddlewheel.rs
git commit -m "feat(mof): add paddle-wheel detection and merging"
```

---

### Task 6: Add WASM binding + build and test

**Files:**
- Modify: `extensions/rust/src/wasm.rs`

- [ ] **Step 1: Add `detect_mof_sbus` WASM function**

Add at the end of `extensions/rust/src/wasm.rs` (before the final `}`):

```rust
// ==================== MOF Topology ====================

/// Detect MOF SBUs (Secondary Building Units) from structure + bonds.
/// Returns JSON MofClusters with SBU assignments for each atom.
#[wasm_bindgen]
pub fn detect_mof_sbus(
    structure_json: &str,
    bonds_json: &str,
) -> String {
    let result: Result<String, String> = (|| {
        let structure = crate::io::parse_structure_json(structure_json)
            .map_err(|e| e.to_string())?;
        let bonds: Vec<crate::bonding::Bond> =
            serde_json::from_str(bonds_json).map_err(|e| e.to_string())?;
        let clusters = crate::mof::detect_sbus(&structure, &bonds);
        serde_json::to_string(&clusters).map_err(|e| e.to_string())
    })();
    result.unwrap_or_else(|e| format!("{{\"error\":\"{}\"}}", e))
}
```

- [ ] **Step 2: Build WASM**

```bash
cd extensions/rust && wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm
```

Expected: Build succeeds with no errors.

- [ ] **Step 3: Test with cargo test**

```bash
cd extensions/rust && cargo test --lib mof
```

Expected: All tests pass (or no tests yet — add basic smoke test).

- [ ] **Step 4: Add a basic integration test in mod.rs**

Add at the bottom of `extensions/rust/src/mof/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::bonding::Bond;
    use crate::structure::Structure;
    use crate::lattice::Lattice;
    use crate::species::{SiteOccupancy, Species};
    use crate::element::Element;
    use nalgebra::{Matrix3, Vector3};

    fn make_simple_mof() -> (Structure, Vec<Bond>) {
        // Minimal MOF-like structure: 1 Zn + 4 O + 4 C (tetrahedral coordination)
        let lattice = Lattice::new(Matrix3::new(
            10.0, 0.0, 0.0,
            0.0, 10.0, 0.0,
            0.0, 0.0, 10.0,
        ));

        let species = |el: Element| SiteOccupancy {
            species: vec![Species { element: el, oxidation_state: None, occu: 1.0 }],
        };

        let structure = Structure {
            lattice,
            site_occupancies: vec![
                species(Element::Zn), // 0
                species(Element::O),  // 1
                species(Element::O),  // 2
                species(Element::O),  // 3
                species(Element::O),  // 4
                species(Element::C),  // 5
                species(Element::C),  // 6
                species(Element::C),  // 7
                species(Element::C),  // 8
            ],
            frac_coords: vec![
                Vector3::new(0.5, 0.5, 0.5), // Zn
                Vector3::new(0.4, 0.5, 0.5), // O
                Vector3::new(0.6, 0.5, 0.5), // O
                Vector3::new(0.5, 0.4, 0.5), // O
                Vector3::new(0.5, 0.6, 0.5), // O
                Vector3::new(0.3, 0.5, 0.5), // C
                Vector3::new(0.7, 0.5, 0.5), // C
                Vector3::new(0.5, 0.3, 0.5), // C
                Vector3::new(0.5, 0.7, 0.5), // C
            ],
            pbc: [true, true, true],
            charge: 0.0,
            properties: Default::default(),
        };

        let bonds = vec![
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 2.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 0, site_idx_2: 2, bond_length: 2.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 0, site_idx_2: 3, bond_length: 2.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 0, site_idx_2: 4, bond_length: 2.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 1, site_idx_2: 5, bond_length: 1.5, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 2, site_idx_2: 6, bond_length: 1.5, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 3, site_idx_2: 7, bond_length: 1.5, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 4, site_idx_2: 8, bond_length: 1.5, strength: 1.0, image: [0, 0, 0] },
        ];

        (structure, bonds)
    }

    #[test]
    fn test_simple_mof_detection() {
        let (structure, bonds) = make_simple_mof();
        let result = detect_sbus(&structure, &bonds);

        assert!(result.is_mof, "Should be identified as MOF");
        assert!(result.sbus.iter().any(|s| s.sbu_type == SbuType::Inorganic));
        assert!(result.sbus.iter().any(|s| s.sbu_type == SbuType::Organic));

        // Zn should be in an inorganic SBU
        let zn_sbu = result.attributions[0];
        assert_eq!(result.sbus[zn_sbu].sbu_type, SbuType::Inorganic);

        // C atoms should be in organic SBUs
        for c_idx in 5..=8 {
            let c_sbu = result.attributions[c_idx];
            assert_eq!(result.sbus[c_sbu].sbu_type, SbuType::Organic);
        }
    }
}
```

- [ ] **Step 5: Run tests**

```bash
cd extensions/rust && cargo test --lib mof -- --nocapture
```

Expected: `test_simple_mof_detection` passes.

- [ ] **Step 6: Commit**

```bash
git add extensions/rust/src/wasm.rs extensions/rust/src/mof/mod.rs
git commit -m "feat(mof): add WASM binding detect_mof_sbus + integration test"
```

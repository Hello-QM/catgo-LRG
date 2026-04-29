//! RAC (Revised Autocorrelation) descriptor engine for MOFs.
//!
//! Reference: Janet & Kulik, J. Phys. Chem. A 2017, 121, 8939.
//! Ports the core algorithm from molSimplify's `graph_racs.py`.
//!
//! For each scope (set of starting atoms) and property function `prop`:
//!   P_d(prop) = Σ_i Σ_{j at depth d from i} prop(i) * prop(j)
//!   D_d(prop) = Σ_i Σ_{j at depth d from i} prop(i) - prop(j)
//!
//! Scopes: mc (metal-centered), lc (linker-coordinating), func (functional group),
//!         f-sbu (full SBU, split into f-node and f-linker).
//! Properties: Z, Chi, T, I, S
//! Depths: 0, 1, 2, 3

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::element::Element;

use super::periodic_graph::PeriodicGraph;
use super::{MofClusters, SbuType};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/// Which atomic property to correlate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RacProperty {
    /// Atomic number (Z).
    Z,
    /// Pauling electronegativity (chi).
    Chi,
    /// Graph degree — number of bonded neighbors (T).
    T,
    /// Identity (always 1.0) (I).
    I,
    /// Covalent radius in Angstroms (S).
    S,
}

impl RacProperty {
    fn label(self) -> &'static str {
        match self {
            RacProperty::Z => "Z",
            RacProperty::Chi => "chi",
            RacProperty::T => "T",
            RacProperty::I => "I",
            RacProperty::S => "S",
        }
    }
}

/// Autocorrelation operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RacOp {
    /// Product: prop(i) * prop(j)
    Product,
    /// Difference: prop(i) - prop(j)
    Difference,
}

impl RacOp {
    fn label(self) -> &'static str {
        match self {
            RacOp::Product => "P",
            RacOp::Difference => "D",
        }
    }
}

/// Which atoms to use as starting points.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RacScope {
    /// Metal atoms in Node/Rod SBUs.
    MetalCentered,
    /// Linker atoms that bond directly to Node/Rod atoms.
    LinkerCoord,
    /// Functional group atoms (from MofClusters.functional_groups).
    FuncGroup,
    /// All atoms in Node/Rod SBUs (f-node) + all Linker atoms (f-linker).
    FullSbu,
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/// A single computed RAC descriptor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RacDescriptor {
    pub scope: RacScope,
    pub property: RacProperty,
    pub depth: usize,
    pub op: RacOp,
    pub value: f64,
    /// Human-readable name, e.g. "mc-Z-0-P", "lc-chi-2-D", "f-node-T-1-P".
    pub name: String,
}

/// All RAC descriptors for a structure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RacResult {
    pub descriptors: Vec<RacDescriptor>,
}

// ---------------------------------------------------------------------------
// BFS helpers
// ---------------------------------------------------------------------------

/// Return the indices of atoms at exactly `depth` hops from `start` in the
/// simple (non-periodic) adjacency list `adj`.
///
/// Depth 0 returns `vec![start]`.
pub fn bfs_at_depth(adj: &[Vec<usize>], start: usize, depth: usize) -> Vec<usize> {
    if depth == 0 {
        return vec![start];
    }

    // Standard BFS — track visited set and collect only depth == target.
    let mut visited = vec![false; adj.len()];
    visited[start] = true;

    let mut queue: VecDeque<(usize, usize)> = VecDeque::new();
    queue.push_back((start, 0));

    let mut result = Vec::new();

    while let Some((node, d)) = queue.pop_front() {
        if d == depth {
            result.push(node);
            // No need to explore further from this node.
            continue;
        }
        if d > depth {
            break; // BFS is level-ordered; nothing deeper needed.
        }
        for &nb in &adj[node] {
            if !visited[nb] {
                visited[nb] = true;
                queue.push_back((nb, d + 1));
            }
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Adjacency and property maps
// ---------------------------------------------------------------------------

/// Build a simple (non-periodic) adjacency list from a `PeriodicGraph`.
/// Duplicate neighbor entries (different images, same vertex) are de-duplicated.
pub fn build_adjacency(graph: &PeriodicGraph, n: usize) -> Vec<Vec<usize>> {
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for v in 0..n {
        let mut seen: HashSet<usize> = HashSet::new();
        for nb in graph.neighbors(v) {
            if seen.insert(nb.v) {
                adj[v].push(nb.v);
            }
        }
    }
    adj
}

/// Compute property value for a single atom.
fn atom_property(prop: RacProperty, el: Element, degree: usize) -> f64 {
    match prop {
        RacProperty::Z => el.atomic_number() as f64,
        RacProperty::Chi => el.electronegativity().unwrap_or(0.0),
        RacProperty::T => degree as f64,
        RacProperty::I => 1.0,
        RacProperty::S => el.covalent_radius().unwrap_or(1.0),
    }
}

/// Build property value vectors (one entry per atom, one vec per RacProperty).
pub fn build_property_maps(
    elements: &[Element],
    adj: &[Vec<usize>],
) -> HashMap<RacProperty, Vec<f64>> {
    let n = elements.len();
    let props = [
        RacProperty::Z,
        RacProperty::Chi,
        RacProperty::T,
        RacProperty::I,
        RacProperty::S,
    ];
    let mut maps = HashMap::new();
    for prop in props {
        let vals: Vec<f64> = (0..n)
            .map(|i| atom_property(prop, elements[i], adj[i].len()))
            .collect();
        maps.insert(prop, vals);
    }
    maps
}

// ---------------------------------------------------------------------------
// Scope atom selection
// ---------------------------------------------------------------------------

/// Return indices of metal atoms in Node or Rod SBUs.
pub fn get_metal_centered_atoms(clusters: &MofClusters, elements: &[Element]) -> Vec<usize> {
    clusters
        .attributions
        .iter()
        .enumerate()
        .filter(|&(i, &sbu_idx)| {
            let sbu_type = clusters.sbus[sbu_idx].sbu_type;
            matches!(sbu_type, SbuType::Node | SbuType::Rod) && elements[i].is_metal()
        })
        .map(|(i, _)| i)
        .collect()
}

/// Return indices of Linker/Ligand atoms that are directly bonded to any
/// Node/Rod atom (i.e., the "coordinating" organic atoms).
pub fn get_linker_coordinating_atoms(
    clusters: &MofClusters,
    graph: &PeriodicGraph,
    elements: &[Element],
) -> Vec<usize> {
    // Build a quick lookup: is atom i in a Node/Rod SBU?
    let in_node: Vec<bool> = clusters
        .attributions
        .iter()
        .map(|&sbu_idx| {
            matches!(clusters.sbus[sbu_idx].sbu_type, SbuType::Node | SbuType::Rod)
        })
        .collect();

    let n = elements.len();
    let mut result = HashSet::new();

    for v in 0..n {
        let sbu_type = clusters.sbus[clusters.attributions[v]].sbu_type;
        if !matches!(sbu_type, SbuType::Linker | SbuType::Ligand | SbuType::PointOfExtension) {
            continue;
        }
        // Is any neighbor in a Node/Rod?
        for nb in graph.neighbors(v) {
            if nb.v < n && in_node[nb.v] {
                result.insert(v);
                break;
            }
        }
    }

    let mut out: Vec<usize> = result.into_iter().collect();
    out.sort_unstable();
    out
}

// ---------------------------------------------------------------------------
// Core RAC computation
// ---------------------------------------------------------------------------

/// Compute a single RAC scalar value.
///
/// * `adj`           — simple adjacency list
/// * `prop_vals`     — property vector (one value per atom)
/// * `depth`         — BFS depth
/// * `op`            — Product or Difference
/// * `starting_atoms`— set of origin atoms (scope)
pub fn compute_rac_single(
    adj: &[Vec<usize>],
    prop_vals: &[f64],
    depth: usize,
    op: RacOp,
    starting_atoms: &[usize],
) -> f64 {
    let mut sum = 0.0;
    for &i in starting_atoms {
        let pi = prop_vals[i];
        let targets = bfs_at_depth(adj, i, depth);
        for j in targets {
            let pj = prop_vals[j];
            sum += match op {
                RacOp::Product => pi * pj,
                RacOp::Difference => pi - pj,
            };
        }
    }
    sum
}

/// Compute all (property, depth, op) triples for one scope.
///
/// Returns a vec of `((RacProperty, depth, RacOp), value)` tuples.
pub fn compute_rac_scope(
    adj: &[Vec<usize>],
    props_map: &HashMap<RacProperty, Vec<f64>>,
    max_depth: usize,
    starting_atoms: &[usize],
) -> Vec<((RacProperty, usize, RacOp), f64)> {
    let props = [
        RacProperty::Z,
        RacProperty::Chi,
        RacProperty::T,
        RacProperty::I,
        RacProperty::S,
    ];
    let ops = [RacOp::Product, RacOp::Difference];

    let mut results = Vec::new();
    for prop in props {
        let prop_vals = &props_map[&prop];
        for depth in 0..=max_depth {
            for op in ops {
                let value = compute_rac_single(adj, prop_vals, depth, op, starting_atoms);
                results.push(((prop, depth, op), value));
            }
        }
    }
    results
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Compute all RAC descriptors for a MOF structure.
///
/// # Arguments
/// * `clusters`  — SBU assignments from `detect_sbus`
/// * `graph`     — Periodic graph (bonds)
/// * `elements`  — Element for each atom
///
/// # Returns
/// `RacResult` containing all descriptors across all scopes.
pub fn compute_rac(
    clusters: &MofClusters,
    graph: &PeriodicGraph,
    elements: &[Element],
) -> RacResult {
    let n = elements.len();
    let adj = build_adjacency(graph, n);
    let props_map = build_property_maps(elements, &adj);
    const MAX_DEPTH: usize = 3;

    let mut descriptors: Vec<RacDescriptor> = Vec::new();

    // Helper to push descriptors for a given scope prefix and starting atoms.
    let mut push_scope = |scope: RacScope,
                          prefix: &str,
                          starting_atoms: &[usize],
                          descriptors: &mut Vec<RacDescriptor>| {
        let raw = compute_rac_scope(&adj, &props_map, MAX_DEPTH, starting_atoms);
        for ((prop, depth, op), value) in raw {
            let name = format!("{}-{}-{}-{}", prefix, prop.label(), depth, op.label());
            descriptors.push(RacDescriptor {
                scope,
                property: prop,
                depth,
                op,
                value,
                name,
            });
        }
    };

    // --- mc scope (metal-centered) ---
    let mc_atoms = get_metal_centered_atoms(clusters, elements);
    push_scope(RacScope::MetalCentered, "mc", &mc_atoms, &mut descriptors);

    // --- lc scope (linker-coordinating) ---
    let lc_atoms = get_linker_coordinating_atoms(clusters, graph, elements);
    push_scope(RacScope::LinkerCoord, "lc", &lc_atoms, &mut descriptors);

    // --- func scope (functional group atoms) ---
    let func_atoms: Vec<usize> = clusters
        .functional_groups
        .iter()
        .flat_map(|fg| fg.atom_indices.iter().copied())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    // Sort for determinism.
    let mut func_atoms = func_atoms;
    func_atoms.sort_unstable();
    push_scope(RacScope::FuncGroup, "func", &func_atoms, &mut descriptors);

    // --- f-sbu scope: f-node (Node/Rod atoms) and f-linker (Linker atoms) ---
    let f_node_atoms: Vec<usize> = clusters
        .attributions
        .iter()
        .enumerate()
        .filter(|&(_, &sbu_idx)| {
            matches!(clusters.sbus[sbu_idx].sbu_type, SbuType::Node | SbuType::Rod)
        })
        .map(|(i, _)| i)
        .collect();

    let f_linker_atoms: Vec<usize> = clusters
        .attributions
        .iter()
        .enumerate()
        .filter(|&(_, &sbu_idx)| clusters.sbus[sbu_idx].sbu_type == SbuType::Linker)
        .map(|(i, _)| i)
        .collect();

    push_scope(RacScope::FullSbu, "f-node", &f_node_atoms, &mut descriptors);
    push_scope(RacScope::FullSbu, "f-linker", &f_linker_atoms, &mut descriptors);

    RacResult { descriptors }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bonding::Bond;
    use crate::species::{SiteOccupancy, Species};
    use crate::lattice::Lattice;
    use nalgebra::{Matrix3, Vector3};

    /// Build a tiny adjacency list for test purposes.
    fn make_adj(n: usize, edges: &[(usize, usize)]) -> Vec<Vec<usize>> {
        let mut adj = vec![Vec::new(); n];
        for &(a, b) in edges {
            adj[a].push(b);
            adj[b].push(a);
        }
        adj
    }

    // -----------------------------------------------------------------------
    // 1. Depth-0 product: Fe alone → P_0(Z) = Z(Fe)² = 26² = 676
    // -----------------------------------------------------------------------
    #[test]
    fn test_depth0_product_fe() {
        let adj = make_adj(1, &[]);
        let prop_vals = vec![26.0_f64]; // Z(Fe) = 26
        let starting = vec![0usize];

        let val = compute_rac_single(&adj, &prop_vals, 0, RacOp::Product, &starting);
        assert!((val - 676.0).abs() < 1e-10, "Expected 676.0, got {}", val);
    }

    // -----------------------------------------------------------------------
    // 2. Depth-1 product: Fe-O → P_1(Z) = Z(Fe)*Z(O) + Z(O)*Z(Fe) = 2*208 = 416
    //    (BFS is symmetric: Fe sees O at d=1, O sees Fe at d=1)
    //    BUT: starting_atoms = [Fe only] → P_1 = Z(Fe)*Z(O) = 208
    // -----------------------------------------------------------------------
    #[test]
    fn test_depth1_product_fe_o() {
        let adj = make_adj(2, &[(0, 1)]);
        let prop_vals = vec![26.0_f64, 8.0_f64]; // Fe=0, O=1
        let starting = vec![0usize]; // Only Fe as starting atom

        let val = compute_rac_single(&adj, &prop_vals, 1, RacOp::Product, &starting);
        assert!((val - 208.0).abs() < 1e-10, "Expected 208.0 (26*8), got {}", val);
    }

    // -----------------------------------------------------------------------
    // 3. Depth-1 difference: Fe-O → D_1(Z) = Z(Fe) - Z(O) = 26 - 8 = 18
    //    (starting from Fe only)
    // -----------------------------------------------------------------------
    #[test]
    fn test_depth1_difference_fe_o() {
        let adj = make_adj(2, &[(0, 1)]);
        let prop_vals = vec![26.0_f64, 8.0_f64]; // Fe=0, O=1
        let starting = vec![0usize]; // Only Fe

        let val = compute_rac_single(&adj, &prop_vals, 1, RacOp::Difference, &starting);
        assert!((val - 18.0).abs() < 1e-10, "Expected 18.0 (26-8), got {}", val);
    }

    // -----------------------------------------------------------------------
    // 4. Output structure: verify correct number of features for a scope
    //    5 properties × 4 depths (0–3) × 2 ops = 40 descriptors per scope
    // -----------------------------------------------------------------------
    #[test]
    fn test_scope_feature_count() {
        let adj = make_adj(2, &[(0, 1)]);
        let props_map = {
            let elements = vec![Element::Fe, Element::O];
            build_property_maps(&elements, &adj)
        };
        let starting = vec![0usize, 1usize];

        let results = compute_rac_scope(&adj, &props_map, 3, &starting);
        // 5 props × 4 depths × 2 ops = 40
        assert_eq!(results.len(), 40, "Expected 40 features, got {}", results.len());
    }

    // -----------------------------------------------------------------------
    // 5. bfs_at_depth: verify depth 0 returns only start node
    // -----------------------------------------------------------------------
    #[test]
    fn test_bfs_depth0() {
        let adj = make_adj(3, &[(0, 1), (1, 2)]);
        let result = bfs_at_depth(&adj, 0, 0);
        assert_eq!(result, vec![0]);
    }

    // -----------------------------------------------------------------------
    // 6. bfs_at_depth: linear chain 0-1-2, depth 2 from 0 → [2]
    // -----------------------------------------------------------------------
    #[test]
    fn test_bfs_depth2_chain() {
        let adj = make_adj(3, &[(0, 1), (1, 2)]);
        let result = bfs_at_depth(&adj, 0, 2);
        assert_eq!(result, vec![2]);
    }

    // -----------------------------------------------------------------------
    // 7. Integration: build_adjacency collapses periodic duplicates
    // -----------------------------------------------------------------------
    #[test]
    fn test_build_adjacency_dedup() {
        // Two bonds between same atoms (different images)
        let bonds = vec![
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 2.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 2.0, strength: 1.0, image: [1, 0, 0] },
        ];
        let graph = PeriodicGraph::from_bonds(2, &bonds);
        let adj = build_adjacency(&graph, 2);
        // Despite two bonds, only one unique neighbor index.
        assert_eq!(adj[0].len(), 1, "adj[0] should have 1 unique neighbor");
        assert_eq!(adj[1].len(), 1, "adj[1] should have 1 unique neighbor");
    }

    // -----------------------------------------------------------------------
    // 8. Full integration: run compute_rac on a simple MOF-like structure
    // -----------------------------------------------------------------------
    #[test]
    fn test_compute_rac_simple_mof() {
        use crate::mof::detect_sbus;

        let lattice = Lattice::new(Matrix3::new(
            10.0, 0.0, 0.0,
            0.0, 10.0, 0.0,
            0.0, 0.0, 10.0,
        ));

        let s = |el: Element| SiteOccupancy {
            species: vec![(Species::neutral(el), 1.0)],
            properties: Default::default(),
        };

        let structure = crate::structure::Structure {
            lattice,
            site_occupancies: vec![
                s(Element::Zn),
                s(Element::O),
                s(Element::O),
                s(Element::C),
                s(Element::C),
                s(Element::C),
                s(Element::C),
                s(Element::C),
            ],
            frac_coords: vec![
                Vector3::new(0.1, 0.5, 0.5),
                Vector3::new(0.2, 0.5, 0.5),
                Vector3::new(0.8, 0.5, 0.5),
                Vector3::new(0.3, 0.5, 0.5),
                Vector3::new(0.7, 0.5, 0.5),
                Vector3::new(0.4, 0.5, 0.5),
                Vector3::new(0.5, 0.5, 0.5),
                Vector3::new(0.6, 0.5, 0.5),
            ],
            pbc: [true, true, true],
            charge: 0.0,
            properties: Default::default(),
        };

        let bonds = vec![
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 2.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 0, site_idx_2: 2, bond_length: 2.0, strength: 1.0, image: [-1, 0, 0] },
            Bond { site_idx_1: 1, site_idx_2: 3, bond_length: 1.3, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 2, site_idx_2: 4, bond_length: 1.3, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 3, site_idx_2: 5, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 5, site_idx_2: 6, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 6, site_idx_2: 7, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 7, site_idx_2: 4, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
        ];

        let elements: Vec<Element> = structure
            .site_occupancies
            .iter()
            .map(|occ| occ.dominant_species().element)
            .collect();

        let clusters = detect_sbus(&structure, &bonds);
        assert!(clusters.is_mof, "Structure should be identified as MOF");

        let graph = PeriodicGraph::from_bonds(elements.len(), &bonds);
        let result = compute_rac(&clusters, &graph, &elements);

        // Should have descriptors (at minimum mc + lc + func + f-node + f-linker scopes)
        // mc, lc, func each have 40 descriptors; f-node and f-linker each have 40 → total ≥ 200
        assert!(
            result.descriptors.len() >= 200,
            "Expected ≥200 descriptors, got {}",
            result.descriptors.len()
        );

        // All descriptor names should be non-empty
        for d in &result.descriptors {
            assert!(!d.name.is_empty(), "Descriptor name should not be empty");
        }

        // Spot-check: there should be an mc-Z-0-P descriptor
        let mc_z_0_p = result
            .descriptors
            .iter()
            .find(|d| d.name == "mc-Z-0-P");
        assert!(mc_z_0_p.is_some(), "mc-Z-0-P descriptor should exist");

        // For a single Zn (Z=30) at depth 0 with Product: value = 30*30 = 900
        if let Some(desc) = mc_z_0_p {
            assert!(
                (desc.value - 900.0).abs() < 1e-6,
                "mc-Z-0-P should be 900.0 (Zn²), got {}",
                desc.value
            );
        }
    }
}

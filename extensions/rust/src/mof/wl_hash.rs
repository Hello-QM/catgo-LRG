//! Weisfeiler-Lehman graph hash for SBU deduplication.
//!
//! Iteratively relabels each node by hashing (node_label + sorted neighbor labels).
//! After k iterations the sorted multiset of all node labels gives a canonical hash.
//! Two isomorphic subgraphs (same topology + element labels) produce the same hash.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use serde::{Deserialize, Serialize};

use super::periodic_graph::PeriodicGraph;
use super::{MofClusters, Sbu};
use crate::element::Element;

// ─── Public types ────────────────────────────────────────────────────────────

/// WL hash result for one SBU.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WlHashResult {
    /// Index of the SBU in `MofClusters::sbus`.
    pub sbu_index: usize,
    /// Canonical WL hash of the SBU subgraph.
    pub hash: u64,
}

// ─── Core algorithm ──────────────────────────────────────────────────────────

/// Hash a single value with `DefaultHasher`.
#[inline]
fn hash_one<T: Hash>(v: &T) -> u64 {
    let mut h = DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

/// Hash a slice of u64 values (used after sorting neighbor labels).
#[inline]
fn hash_slice(vals: &[u64]) -> u64 {
    let mut h = DefaultHasher::new();
    vals.hash(&mut h);
    h.finish()
}

/// Compute a Weisfeiler-Lehman graph hash.
///
/// # Arguments
/// * `labels`     - String label for each node (e.g. element symbol).
/// * `adj`        - Local adjacency list: `adj[i]` lists neighbour indices for node `i`.
/// * `iterations` - Number of WL refinement rounds (3 is usually sufficient).
///
/// # Returns
/// A single `u64` canonical hash for the labelled graph.
pub fn wl_hash(labels: &[&str], adj: &[Vec<usize>], iterations: usize) -> u64 {
    let n = labels.len();
    if n == 0 {
        return 0;
    }

    // Step 1 — initialise labels from string hashes.
    let mut current: Vec<u64> = labels.iter().map(|s| hash_one(s)).collect();

    // Step 2 — WL refinement rounds.
    for _ in 0..iterations {
        let mut next = vec![0u64; n];
        for i in 0..n {
            // Collect + sort neighbour labels so the hash is order-independent.
            let mut nbr_labels: Vec<u64> = adj[i].iter().map(|&j| current[j]).collect();
            nbr_labels.sort_unstable();

            // New label = hash(own_label || sorted_neighbour_labels).
            let mut combined = vec![current[i]];
            combined.extend_from_slice(&nbr_labels);
            next[i] = hash_slice(&combined);
        }
        current = next;
    }

    // Step 3 — canonical hash = hash of the sorted multiset of all node labels.
    let mut sorted = current.clone();
    sorted.sort_unstable();
    hash_slice(&sorted)
}

// ─── Helper ──────────────────────────────────────────────────────────────────

/// Extract the subgraph for one SBU.
///
/// Maps global atom indices to local `[0..n)` indices.
/// Returns `(labels, adj)` where `labels[i]` is the element symbol and
/// `adj[i]` lists the local neighbour indices.
pub fn extract_sbu_subgraph(
    sbu: &Sbu,
    graph: &PeriodicGraph,
    elements: &[Element],
) -> (Vec<String>, Vec<Vec<usize>>) {
    let atom_indices = &sbu.atom_indices;
    let n = atom_indices.len();

    // Build a mapping global_index → local_index for fast lookup.
    let mut global_to_local = std::collections::HashMap::with_capacity(n);
    for (local, &global) in atom_indices.iter().enumerate() {
        global_to_local.insert(global, local);
    }

    // Labels from element symbols.
    let labels: Vec<String> = atom_indices
        .iter()
        .map(|&g| elements[g].symbol().to_string())
        .collect();

    // Local adjacency: only keep edges where both endpoints are in this SBU.
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (local_i, &global_i) in atom_indices.iter().enumerate() {
        for nbr in graph.neighbors(global_i) {
            if let Some(&local_j) = global_to_local.get(&nbr.v) {
                adj[local_i].push(local_j);
            }
        }
    }

    (labels, adj)
}

// ─── MOF-level function ───────────────────────────────────────────────────────

/// Compute WL hashes for all SBUs in a MOF decomposition.
///
/// # Arguments
/// * `clusters`   - Output of `detect_sbus`.
/// * `graph`      - Periodic graph built from the same bonds.
/// * `elements`   - Element for each atom (same order as the structure).
/// * `iterations` - WL refinement rounds (default 3 is sufficient for most SBUs).
///
/// # Returns
/// One `WlHashResult` per SBU, in the same order as `clusters.sbus`.
pub fn compute_sbu_hashes(
    clusters: &MofClusters,
    graph: &PeriodicGraph,
    elements: &[Element],
    iterations: usize,
) -> Vec<WlHashResult> {
    clusters
        .sbus
        .iter()
        .enumerate()
        .map(|(sbu_index, sbu)| {
            let (labels, adj) = extract_sbu_subgraph(sbu, graph, elements);
            let label_refs: Vec<&str> = labels.iter().map(String::as_str).collect();
            let hash = wl_hash(&label_refs, &adj, iterations);
            WlHashResult { sbu_index, hash }
        })
        .collect()
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a simple chain graph: 0-1-2 with given labels.
    fn chain_graph<'a>(labels: &'a [&'a str]) -> (Vec<&'a str>, Vec<Vec<usize>>) {
        let n = labels.len();
        let mut adj = vec![Vec::new(); n];
        for i in 0..n.saturating_sub(1) {
            adj[i].push(i + 1);
            adj[i + 1].push(i);
        }
        (labels.to_vec(), adj)
    }

    // Test 1: Two identical O-C-O subgraphs → same hash.
    #[test]
    fn test_identical_subgraphs_same_hash() {
        let labels = &["O", "C", "O"];
        let (l1, a1) = chain_graph(labels);
        let (l2, a2) = chain_graph(labels);

        let h1 = wl_hash(&l1, &a1, 3);
        let h2 = wl_hash(&l2, &a2, 3);
        assert_eq!(h1, h2, "Identical O-C-O subgraphs should have the same hash");
    }

    // Test 2: Different element labels (O-C-O vs N-C-N) → different hash.
    #[test]
    fn test_different_labels_different_hash() {
        let (l_oco, a_oco) = chain_graph(&["O", "C", "O"]);
        let (l_ncn, a_ncn) = chain_graph(&["N", "C", "N"]);

        let h_oco = wl_hash(&l_oco, &a_oco, 3);
        let h_ncn = wl_hash(&l_ncn, &a_ncn, 3);
        assert_ne!(h_oco, h_ncn, "O-C-O and N-C-N chains should have different hashes");
    }

    // Test 3: Different topology (chain vs branched/star) → different hash.
    // Chain: 0-1-2-3   (linear)
    // Star:  0-1, 0-2, 0-3  (center connected to three leaves)
    #[test]
    fn test_different_topology_different_hash() {
        // Linear chain C-C-C-C
        let chain_labels = vec!["C", "C", "C", "C"];
        let chain_adj = vec![
            vec![1],          // 0 → 1
            vec![0, 2],       // 1 → 0, 2
            vec![1, 3],       // 2 → 1, 3
            vec![2],          // 3 → 2
        ];

        // Star: center C(0) bonded to three C leaves
        let star_labels = vec!["C", "C", "C", "C"];
        let star_adj = vec![
            vec![1, 2, 3],    // 0 (center) → 1, 2, 3
            vec![0],          // 1 → 0
            vec![0],          // 2 → 0
            vec![0],          // 3 → 0
        ];

        let h_chain = wl_hash(&chain_labels, &chain_adj, 3);
        let h_star = wl_hash(&star_labels, &star_adj, 3);
        assert_ne!(h_chain, h_star, "Chain and star C4 graphs should have different hashes");
    }

    // Bonus: empty graph → hash 0.
    #[test]
    fn test_empty_graph() {
        let h = wl_hash(&[], &[], 3);
        assert_eq!(h, 0);
    }

    // Bonus: single node
    #[test]
    fn test_single_node() {
        let h1 = wl_hash(&["C"], &[vec![]], 3);
        let h2 = wl_hash(&["C"], &[vec![]], 3);
        assert_eq!(h1, h2);

        let h3 = wl_hash(&["N"], &[vec![]], 3);
        assert_ne!(h1, h3, "Single C and single N should differ");
    }
}

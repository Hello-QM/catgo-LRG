//! 1D Rod SBU detection.
//!
//! Rod SBUs are infinite 1D metal chains periodic in exactly one dimension
//! (e.g., MIL-53 Al chains, MOF-74 metal helices). They must be identified
//! BEFORE `resolve_periodic_sbus` splits them, because splitting destroys
//! the periodicity information.
//!
//! Detection algorithm:
//! 1. For each Node SBU marked `is_periodic`, BFS through its atoms while
//!    tracking all cumulative periodic offset differences encountered.
//! 2. Collect every non-zero offset vector that was actually traversed.
//! 3. If all such vectors are collinear (pairwise cross-product = [0,0,0]),
//!    the chain is periodic in exactly 1 direction → Rod.

use std::collections::{HashMap, VecDeque};
use super::periodic_graph::PeriodicGraph;
use super::clustering::ClusteringState;
use super::{Sbu, SbuType};

/// Cross product of two integer 3-vectors.
fn cross(a: [i32; 3], b: [i32; 3]) -> [i32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

/// Return `true` if all traversed offset differences in this SBU's atoms are
/// collinear (i.e., the SBU is periodic in exactly 1 dimension).
///
/// # Arguments
/// * `graph`  - The periodic graph (full structure).
/// * `atoms`  - Atom indices belonging to this SBU.
/// * `classes` - Per-atom class labels (used to stay within same class).
pub fn is_1d_periodic(graph: &PeriodicGraph, atoms: &[usize], classes: &[i32]) -> bool {
    if atoms.is_empty() {
        return false;
    }

    use std::collections::HashSet;
    let atom_set: HashSet<usize> = atoms.iter().copied().collect();
    let sbu_class = classes[atoms[0]];

    // BFS to collect all offset vectors traversed across periodic bonds.
    let mut offsets: HashMap<usize, [i32; 3]> = HashMap::new();
    let mut queue: VecDeque<(usize, [i32; 3])> = VecDeque::new();
    let start = atoms[0];

    offsets.insert(start, [0, 0, 0]);
    queue.push_back((start, [0, 0, 0]));

    // Collect every non-zero offset vector encountered during BFS.
    let mut offset_vectors: Vec<[i32; 3]> = Vec::new();

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
                // Already visited — record the difference if non-zero.
                let diff = [
                    v_ofs[0] - existing[0],
                    v_ofs[1] - existing[1],
                    v_ofs[2] - existing[2],
                ];
                if diff != [0, 0, 0] {
                    offset_vectors.push(diff);
                }
            } else {
                offsets.insert(nbr.v, v_ofs);
                queue.push_back((nbr.v, v_ofs));
            }
        }
    }

    // Also record the net offset for each atom relative to origin, to capture
    // chains where atoms are visited only once but offsets are non-zero.
    for &ofs in offsets.values() {
        if ofs != [0, 0, 0] {
            offset_vectors.push(ofs);
        }
    }

    if offset_vectors.is_empty() {
        // No periodic offsets at all → not periodic → not a rod.
        return false;
    }

    // Find the first non-zero vector to use as reference direction.
    let ref_dir = match offset_vectors.iter().find(|&&v| v != [0, 0, 0]) {
        Some(&v) => v,
        None => return false,
    };

    // All offset vectors must be collinear with ref_dir.
    // Two vectors a and b are collinear iff a × b = [0, 0, 0].
    offset_vectors
        .iter()
        .all(|&o| o == [0, 0, 0] || cross(ref_dir, o) == [0, 0, 0])
}

/// Scan all Node SBUs that are periodic and mark 1D chains as `SbuType::Rod`.
///
/// Must be called BEFORE `resolve_periodic_sbus` so the periodicity
/// information is still intact.
pub fn detect_and_mark_rods(graph: &PeriodicGraph, state: &mut ClusteringState) {
    let n = state.sbus.len();
    for i in 0..n {
        let sbu: &Sbu = &state.sbus[i];
        if sbu.sbu_type != SbuType::Node || !sbu.is_periodic {
            continue;
        }
        let atoms = sbu.atom_indices.clone();
        if is_1d_periodic(graph, &atoms, &state.classes) {
            state.sbus[i].sbu_type = SbuType::Rod;
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bonding::Bond;
    use crate::mof::classify;
    use crate::mof::clustering::find_connected_sbus;
    use crate::mof::periodic_graph::PeriodicGraph;

    fn al_class() -> i32 {
        classify::CLASS_INORGANIC
    }

    fn make_classes(n: usize, class: i32) -> Vec<i32> {
        vec![class; n]
    }

    // ── Test 1: minimal 1D Al–O–Al chain along x-axis ────────────────────────
    // Al(0) — O(1) — Al(2) — ... periodic in x
    // Bonds: Al0-O1 [0,0,0], O1-Al2 [0,0,0], Al2 periodic back to Al0 [1,0,0]
    // Only Al atoms form the "inorganic" SBU; O is organic class for this test.
    // Simpler: all 3 atoms same class, chain Al0-Al1 with a periodic bond back.
    #[test]
    fn test_1d_chain_detected_as_rod() {
        // Two Al atoms; bond Al0→Al1 with [0,0,0] AND a periodic self-returning
        // bond Al0→Al1 with [1,0,0] to simulate the infinite chain.
        let bonds = vec![
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 3.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 1, site_idx_2: 0, bond_length: 3.0, strength: 1.0, image: [1, 0, 0] },
        ];
        let n = 2;
        let graph = PeriodicGraph::from_bonds(n, &bonds);
        let classes = make_classes(n, al_class());

        assert!(
            is_1d_periodic(&graph, &[0, 1], &classes),
            "Al chain along x should be detected as 1D rod"
        );
    }

    // ── Test 2: 3D periodic node → NOT a rod ──────────────────────────────────
    // Simulate a node that has periodic images in multiple directions.
    #[test]
    fn test_3d_periodic_not_rod() {
        // 3 atoms; add periodic bonds in x, y, and z directions.
        // atom0 connects to atom1 with [1,0,0], [0,1,0], and [0,0,1] images.
        let bonds = vec![
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 3.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 1, site_idx_2: 0, bond_length: 3.0, strength: 1.0, image: [1, 0, 0] },
            Bond { site_idx_1: 0, site_idx_2: 2, bond_length: 3.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 2, site_idx_2: 0, bond_length: 3.0, strength: 1.0, image: [0, 1, 0] },
            Bond { site_idx_1: 1, site_idx_2: 2, bond_length: 3.0, strength: 1.0, image: [0, 0, 1] },
        ];
        let n = 3;
        let graph = PeriodicGraph::from_bonds(n, &bonds);
        let classes = make_classes(n, al_class());

        assert!(
            !is_1d_periodic(&graph, &[0, 1, 2], &classes),
            "Node with periodic images in x, y, z should NOT be a rod"
        );
    }

    // ── Test 3: non-periodic node → NOT a rod ────────────────────────────────
    #[test]
    fn test_non_periodic_not_rod() {
        // Two atoms connected by a plain bond (no periodic images).
        let bonds = vec![
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 2.5, strength: 1.0, image: [0, 0, 0] },
        ];
        let n = 2;
        let graph = PeriodicGraph::from_bonds(n, &bonds);
        let classes = make_classes(n, al_class());

        assert!(
            !is_1d_periodic(&graph, &[0, 1], &classes),
            "Non-periodic pair should NOT be detected as rod"
        );
    }

    // ── Test 4: detect_and_mark_rods integration ──────────────────────────────
    // Build a ClusteringState with one periodic Node SBU that is 1D, and one
    // that is non-periodic, and verify only the 1D one gets marked Rod.
    #[test]
    fn test_detect_and_mark_rods() {

        // 4 atoms: 0,1 form 1D chain; 2,3 form non-periodic pair.
        let bonds = vec![
            // 1D chain: periodic in x
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 3.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 1, site_idx_2: 0, bond_length: 3.0, strength: 1.0, image: [1, 0, 0] },
            // Non-periodic pair
            Bond { site_idx_1: 2, site_idx_2: 3, bond_length: 2.5, strength: 1.0, image: [0, 0, 0] },
        ];
        let n = 4;
        let graph = PeriodicGraph::from_bonds(n, &bonds);
        let classes = make_classes(n, al_class());

        let mut state = find_connected_sbus(&graph, &classes, n);

        // Verify initial state: two SBUs, one periodic, one not.
        assert_eq!(state.sbus.len(), 2);
        let periodic_idx = state.sbus.iter().position(|s| s.is_periodic).expect("should have a periodic SBU");
        let nonperiodic_idx = state.sbus.iter().position(|s| !s.is_periodic).expect("should have a non-periodic SBU");

        assert_eq!(state.sbus[periodic_idx].sbu_type, SbuType::Node);
        assert_eq!(state.sbus[nonperiodic_idx].sbu_type, SbuType::Node);

        detect_and_mark_rods(&graph, &mut state);

        assert_eq!(state.sbus[periodic_idx].sbu_type, SbuType::Rod,
            "Periodic 1D SBU should be marked Rod");
        assert_eq!(state.sbus[nonperiodic_idx].sbu_type, SbuType::Node,
            "Non-periodic SBU should remain Node");
    }
}

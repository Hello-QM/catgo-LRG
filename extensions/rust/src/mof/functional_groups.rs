//! Functional group detection on MOF linker/ligand SBUs.
//!
//! Identifies pendant non-C/H substituents (e.g. -NH2, -OH, -NO2, -F)
//! that are attached to the organic backbone but do not coordinate to any
//! metal node.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::element::Element;
use super::periodic_graph::PeriodicGraph;
use super::{MofClusters, SbuType};

/// A functional group detected on a linker or ligand SBU.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionalGroup {
    /// Atom indices that belong to this functional group.
    pub atom_indices: Vec<usize>,
    /// Human-readable name (e.g. "NH2", "OH", "NO2", "F").
    pub name: String,
    /// Index into `MofClusters::sbus` of the parent SBU.
    pub parent_sbu: usize,
    /// Atom index of the C atom in the linker backbone that the group is
    /// attached to.  `usize::MAX` if no such C neighbour is found.
    pub attachment_atom: usize,
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/// Name a functional group from its element composition.
///
/// `counts` maps `Element` → count for the non-H atoms in the group.
/// `h_count` is the total number of H atoms.
fn name_group(counts: &HashMap<Element, usize>, h_count: usize) -> String {
    // Sorted element symbols (deterministic output).
    let mut elems: Vec<(Element, usize)> = counts.iter().map(|(e, c)| (*e, *c)).collect();
    elems.sort_by_key(|(e, _)| e.symbol());

    // Build a simple composition key for pattern matching.
    // E.g. N1 H2, O1 H1, N1 O2, S1 O3 H1 …
    let total_n = counts.get(&Element::N).copied().unwrap_or(0);
    let total_o = counts.get(&Element::O).copied().unwrap_or(0);
    let total_s = counts.get(&Element::S).copied().unwrap_or(0);
    let total_f = counts.get(&Element::F).copied().unwrap_or(0);
    let total_cl = counts.get(&Element::Cl).copied().unwrap_or(0);
    let total_br = counts.get(&Element::Br).copied().unwrap_or(0);
    let total_i = counts.get(&Element::I).copied().unwrap_or(0);
    let n_heavy = elems.iter().map(|(_, c)| c).sum::<usize>();

    // Single heavy atom — halogens
    if n_heavy == 1 && h_count == 0 {
        if total_f == 1 { return "F".to_string(); }
        if total_cl == 1 { return "Cl".to_string(); }
        if total_br == 1 { return "Br".to_string(); }
        if total_i == 1 { return "I".to_string(); }
    }

    // -OH (one O, one H)
    if n_heavy == 1 && total_o == 1 && h_count == 1 {
        return "OH".to_string();
    }
    // -SH (one S, one H)
    if n_heavy == 1 && total_s == 1 && h_count == 1 {
        return "SH".to_string();
    }
    // -NH2 (one N, two H)
    if n_heavy == 1 && total_n == 1 && h_count == 2 {
        return "NH2".to_string();
    }
    // -NO2 (one N, two O, no H)
    if n_heavy == 2 && total_n == 1 && total_o == 2 && h_count == 0 {
        return "NO2".to_string();
    }
    // -SO3H (one S, three O, one H)
    if n_heavy == 4 && total_s == 1 && total_o == 3 && h_count == 1 {
        return "SO3H".to_string();
    }
    // -COOH (one C, two O, one H) — pendant acid not part of backbone
    // Note: carboxylates coordinating to nodes are excluded earlier.
    // We skip this here intentionally; any remaining pendant COO would
    // be named by the generic path below.

    // Generic: concatenate element symbols with counts (omit 1).
    let mut name = String::new();
    // Non-H first, sorted alphabetically
    for (el, cnt) in &elems {
        name.push_str(el.symbol());
        if *cnt > 1 {
            name.push_str(&cnt.to_string());
        }
    }
    // Then H
    if h_count > 0 {
        name.push('H');
        if h_count > 1 {
            name.push_str(&h_count.to_string());
        }
    }
    if name.is_empty() {
        name = "Unknown".to_string();
    }
    name
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Detect functional groups on all Linker and Ligand SBUs.
///
/// A functional group is a connected set of non-C/H atoms (and their H
/// neighbours) that:
/// 1. Belong to a Linker or Ligand SBU.
/// 2. Do not bond to any atom that belongs to a Node SBU.
pub fn detect_functional_groups(
    clusters: &MofClusters,
    graph: &PeriodicGraph,
    elements: &[Element],
) -> Vec<FunctionalGroup> {
    let mut result = Vec::new();

    // Build a fast set of node-owned atoms.
    let node_atoms: HashSet<usize> = clusters
        .sbus
        .iter()
        .enumerate()
        .filter(|(_, s)| s.sbu_type == SbuType::Node)
        .flat_map(|(_, s)| s.atom_indices.iter().copied())
        .collect();

    // For each atom, which SBU it belongs to.
    let attributions = &clusters.attributions;

    // Process each Linker / Ligand SBU independently.
    for (sbu_idx, sbu) in clusters.sbus.iter().enumerate() {
        if !matches!(sbu.sbu_type, SbuType::Linker | SbuType::Ligand) {
            continue;
        }

        let sbu_atom_set: HashSet<usize> = sbu.atom_indices.iter().copied().collect();

        // ----------------------------------------------------------------
        // Step 1: find "root" atoms — non-C/H atoms in this SBU that do
        //         NOT bond to any node atom.
        // ----------------------------------------------------------------
        let mut roots: Vec<usize> = Vec::new();
        for &atom in &sbu.atom_indices {
            let el = elements[atom];
            if el == Element::C || el == Element::H {
                continue;
            }
            // Check whether this atom has any neighbour in a Node SBU.
            let bonds_to_node = graph.neighbors(atom).iter().any(|n| node_atoms.contains(&n.v));
            if !bonds_to_node {
                roots.push(atom);
            }
        }

        if roots.is_empty() {
            continue;
        }

        // ----------------------------------------------------------------
        // Step 2: cluster roots into connected functional groups via BFS.
        //         We only cross non-C/H atoms that also pass the
        //         "does not bond to node" filter.
        // ----------------------------------------------------------------
        let mut visited: HashSet<usize> = HashSet::new();

        for root in roots {
            if visited.contains(&root) {
                continue;
            }

            let mut group_atoms: Vec<usize> = Vec::new();
            let mut h_atoms: Vec<usize> = Vec::new();
            let mut queue: VecDeque<usize> = VecDeque::new();
            let mut elem_counts: HashMap<Element, usize> = HashMap::new();

            visited.insert(root);
            queue.push_back(root);

            while let Some(u) = queue.pop_front() {
                let el_u = elements[u];
                group_atoms.push(u);
                *elem_counts.entry(el_u).or_insert(0) += 1;

                for nbr in graph.neighbors(u) {
                    let v = nbr.v;
                    if visited.contains(&v) {
                        continue;
                    }
                    // Collect H neighbours regardless of SBU membership
                    // (H is often attributed to the same SBU but check element).
                    let el_v = elements[v];
                    if el_v == Element::H {
                        // Include H that is in the same SBU.
                        if attributions.get(v).copied() == Some(sbu_idx) {
                            visited.insert(v);
                            h_atoms.push(v);
                        }
                        continue;
                    }
                    // Non-H: must be in the same SBU and must not bond to node.
                    if !sbu_atom_set.contains(&v) {
                        continue;
                    }
                    if el_v == Element::C {
                        // C atoms form the backbone — don't BFS through them,
                        // but we still want to record the attachment C.
                        continue;
                    }
                    if graph.neighbors(v).iter().any(|n| node_atoms.contains(&n.v)) {
                        continue;
                    }
                    visited.insert(v);
                    queue.push_back(v);
                }
            }

            // ----------------------------------------------------------------
            // Step 3: find attachment C atom (first C neighbour of any group
            //         atom that is in the same SBU).
            // ----------------------------------------------------------------
            let mut attachment_atom = usize::MAX;
            'outer: for &a in &group_atoms {
                for nbr in graph.neighbors(a) {
                    let v = nbr.v;
                    if elements[v] == Element::C && sbu_atom_set.contains(&v) {
                        attachment_atom = v;
                        break 'outer;
                    }
                }
            }

            let h_count = h_atoms.len();
            let name = name_group(&elem_counts, h_count);

            let mut all_atoms = group_atoms;
            all_atoms.extend(h_atoms);
            all_atoms.sort_unstable();

            result.push(FunctionalGroup {
                atom_indices: all_atoms,
                name,
                parent_sbu: sbu_idx,
                attachment_atom,
            });
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bonding::Bond;
    use crate::element::Element;
    use crate::lattice::Lattice;
    use crate::species::{SiteOccupancy, Species};
    use crate::mof::detect_sbus;
    use nalgebra::{Matrix3, Vector3};

    fn occ(el: Element) -> SiteOccupancy {
        SiteOccupancy {
            species: vec![(Species::neutral(el), 1.0)],
            properties: Default::default(),
        }
    }

    /// BDC-NH2 type structure:
    ///
    /// Zn(0) – O(1) – C(3) – C(5) – C(6) – C(7) – C(4) – O(2) – Zn(0, -x image)
    ///                                |
    ///                               C(8)
    ///                                |
    ///                               N(9) – H(10) – H(11)   ← the NH2 group
    ///
    /// Atom map:
    ///  0 Zn  metal node
    ///  1 O   carboxylate, bonded to Zn
    ///  2 O   carboxylate, bonded to Zn (periodic)
    ///  3 C   carboxylate C
    ///  4 C   carboxylate C (other end)
    ///  5 C   aromatic backbone
    ///  6 C   aromatic backbone
    ///  7 C   aromatic backbone
    ///  8 C   aromatic backbone bearing NH2
    ///  9 N   amine N
    /// 10 H   amine H
    /// 11 H   amine H
    #[test]
    fn test_bdc_nh2_functional_group() {
        let lattice = Lattice::new(Matrix3::new(
            20.0, 0.0, 0.0,
            0.0, 20.0, 0.0,
            0.0, 0.0, 20.0,
        ));

        let structure = crate::structure::Structure {
            lattice,
            site_occupancies: vec![
                occ(Element::Zn), // 0
                occ(Element::O),  // 1
                occ(Element::O),  // 2
                occ(Element::C),  // 3
                occ(Element::C),  // 4
                occ(Element::C),  // 5
                occ(Element::C),  // 6
                occ(Element::C),  // 7
                occ(Element::C),  // 8 — bears NH2
                occ(Element::N),  // 9
                occ(Element::H),  // 10
                occ(Element::H),  // 11
            ],
            frac_coords: vec![
                Vector3::new(0.05, 0.5, 0.5), // 0 Zn
                Vector3::new(0.10, 0.5, 0.5), // 1 O
                Vector3::new(0.90, 0.5, 0.5), // 2 O (periodic)
                Vector3::new(0.15, 0.5, 0.5), // 3 C-carboxylate
                Vector3::new(0.85, 0.5, 0.5), // 4 C-carboxylate
                Vector3::new(0.20, 0.5, 0.5), // 5 C-aromatic
                Vector3::new(0.50, 0.5, 0.5), // 6 C-aromatic (middle)
                Vector3::new(0.80, 0.5, 0.5), // 7 C-aromatic
                Vector3::new(0.50, 0.5, 0.6), // 8 C bearing NH2
                Vector3::new(0.50, 0.5, 0.7), // 9 N
                Vector3::new(0.48, 0.5, 0.75),// 10 H
                Vector3::new(0.52, 0.5, 0.75),// 11 H
            ],
            pbc: [true, true, true],
            charge: 0.0,
            properties: Default::default(),
        };

        let bonds = vec![
            // Zn–O coordination
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 2.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 0, site_idx_2: 2, bond_length: 2.0, strength: 1.0, image: [-1, 0, 0] },
            // O–C carboxylate
            Bond { site_idx_1: 1, site_idx_2: 3, bond_length: 1.3, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 2, site_idx_2: 4, bond_length: 1.3, strength: 1.0, image: [0, 0, 0] },
            // Aromatic backbone
            Bond { site_idx_1: 3, site_idx_2: 5, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 5, site_idx_2: 6, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 6, site_idx_2: 7, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 7, site_idx_2: 4, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            // C(6) bearing the NH2 substituent
            Bond { site_idx_1: 6, site_idx_2: 8, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            // NH2 group
            Bond { site_idx_1: 8, site_idx_2: 9, bond_length: 1.47, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 9, site_idx_2: 10, bond_length: 1.01, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 9, site_idx_2: 11, bond_length: 1.01, strength: 1.0, image: [0, 0, 0] },
        ];

        let clusters = detect_sbus(&structure, &bonds);
        assert!(clusters.is_mof, "Should be identified as a MOF");

        // The NH2 group should appear in functional_groups.
        assert!(
            !clusters.functional_groups.is_empty(),
            "Expected at least one functional group"
        );

        let nh2 = clusters
            .functional_groups
            .iter()
            .find(|fg| fg.name == "NH2");

        assert!(
            nh2.is_some(),
            "Expected an NH2 functional group; got: {:?}",
            clusters.functional_groups.iter().map(|fg| &fg.name).collect::<Vec<_>>()
        );

        let nh2 = nh2.unwrap();
        // The group should contain N(9), H(10), H(11).
        assert!(nh2.atom_indices.contains(&9), "NH2 should contain N (idx 9)");
        assert!(nh2.atom_indices.contains(&10), "NH2 should contain H (idx 10)");
        assert!(nh2.atom_indices.contains(&11), "NH2 should contain H (idx 11)");
    }

    #[test]
    fn test_name_group_halogens() {
        let mut counts = HashMap::new();
        counts.insert(Element::F, 1);
        assert_eq!(name_group(&counts, 0), "F");

        let mut counts = HashMap::new();
        counts.insert(Element::Cl, 1);
        assert_eq!(name_group(&counts, 0), "Cl");
    }

    #[test]
    fn test_name_group_oh() {
        let mut counts = HashMap::new();
        counts.insert(Element::O, 1);
        assert_eq!(name_group(&counts, 1), "OH");
    }

    #[test]
    fn test_name_group_no2() {
        let mut counts = HashMap::new();
        counts.insert(Element::N, 1);
        counts.insert(Element::O, 2);
        assert_eq!(name_group(&counts, 0), "NO2");
    }
}

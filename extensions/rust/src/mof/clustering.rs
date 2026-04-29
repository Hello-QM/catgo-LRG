//! Connected component clustering for MOF SBU detection.
//!
//! Groups atoms of the same class into SBUs via BFS on the periodic graph.
//! Handles periodic SBUs (those spanning cell boundaries) by iterative splitting.

use std::collections::{HashMap, HashSet, VecDeque};
use crate::element::Element;
use super::periodic_graph::PeriodicGraph;
use super::classify::{CLASS_INORGANIC, CLASS_IGNORED};
use super::{Sbu, SbuType};

/// Intermediate clustering state used during SBU construction.
pub struct ClusteringState {
    pub sbus: Vec<Sbu>,
    pub attributions: Vec<usize>,
    pub classes: Vec<i32>,
    /// Cumulative periodic offset for each atom relative to its SBU's BFS root.
    /// Used to detect PBC crossings in linker/cap classification.
    pub atom_offsets: Vec<[i32; 3]>,
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
    let mut atom_offsets = vec![[0i32, 0, 0]; n];
    let mut sbus: Vec<Sbu> = Vec::new();

    for start in 0..n {
        if attributions[start] != usize::MAX || classes[start] == CLASS_IGNORED {
            continue;
        }

        let sbu_class = classes[start];
        let sbu_idx = sbus.len();
        let mut atom_indices = Vec::new();
        let mut is_periodic = false;

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
                    if existing_ofs != v_ofs {
                        is_periodic = true;
                    }
                } else {
                    offsets.insert(v, v_ofs);
                    atom_offsets[v] = v_ofs;
                    attributions[v] = sbu_idx;
                    atom_indices.push(v);
                    queue.push_back((v, v_ofs));
                }
            }
        }

        let sbu_type = if sbu_class == CLASS_INORGANIC {
            SbuType::Node
        } else {
            SbuType::Linker
        };

        sbus.push(Sbu {
            atom_indices,
            sbu_type,
            is_periodic,
            formula: String::new(),
        });
    }

    ClusteringState {
        sbus,
        attributions,
        classes: classes.to_vec(),
        atom_offsets,
    }
}

/// Resolve periodic SBUs by iterative splitting.
pub fn resolve_periodic_sbus(
    graph: &PeriodicGraph,
    _elements: &[Element],
    state: &mut ClusteringState,
) {
    let max_iterations = 100;
    for _ in 0..max_iterations {
        let periodic_indices: Vec<usize> = state
            .sbus
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_periodic && s.atom_indices.len() > 1 && s.sbu_type != SbuType::Rod)
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

            let split_atom = *atoms
                .iter()
                .max_by_key(|&&a| graph.degree(a))
                .unwrap();

            state.sbus[sbu_idx].atom_indices.retain(|&a| a != split_atom);

            let new_sbu_idx = state.sbus.len();
            state.sbus.push(Sbu {
                atom_indices: vec![split_atom],
                sbu_type: state.sbus[sbu_idx].sbu_type,
                is_periodic: false,
                formula: String::new(),
            });
            state.attributions[split_atom] = new_sbu_idx;

            state.sbus[sbu_idx].is_periodic =
                check_sbu_periodic(graph, &state.sbus[sbu_idx].atom_indices, &state.classes);
        }
    }
}

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
        if state.sbus[sbu_idx].sbu_type != SbuType::Linker {
            continue;
        }

        let neighbors = graph.neighbors(atom);
        if neighbors.is_empty() {
            continue;
        }

        let all_inorganic = neighbors.iter().all(|nbr| {
            let nbr_sbu = state.attributions[nbr.v];
            nbr_sbu < state.sbus.len()
                && matches!(state.sbus[nbr_sbu].sbu_type, SbuType::Node | SbuType::Rod)
        });

        if all_inorganic {
            state.sbus[sbu_idx].atom_indices.retain(|&a| a != atom);

            let pe_idx = state.sbus.len();
            state.sbus.push(Sbu {
                atom_indices: vec![atom],
                sbu_type: SbuType::PointOfExtension,
                is_periodic: false,
                formula: String::new(),
            });
            state.attributions[atom] = pe_idx;
        }
    }

    compact_sbus(state);
}

/// Distinguish linkers (bridge ≥2 nodes) from ligands (terminal caps).
///
/// Uses periodic crossing detection (molSimplify approach):
/// For each pair of anchors in an organic SBU that connects to 1 node,
/// compute the net image offset through the organic chain. If non-zero,
/// the fragment bridges the node across PBC → linker. If zero → cap.
pub fn classify_linkers_vs_ligands(
    graph: &PeriodicGraph,
    state: &mut ClusteringState,
) {
    let n = state.attributions.len();

    for sbu_idx in 0..state.sbus.len() {
        if state.sbus[sbu_idx].sbu_type != SbuType::Linker {
            continue;
        }

        // Collect all node SBUs this organic fragment connects to.
        let mut node_sbus: HashSet<usize> = HashSet::new();
        // Collect anchor info: (organic_atom, node_atom, bond_image)
        let mut anchors: Vec<(usize, usize, [i32; 3])> = Vec::new();

        for &atom in &state.sbus[sbu_idx].atom_indices {
            for nbr in graph.neighbors(atom) {
                if nbr.v >= n { continue; }
                let nbr_sbu = state.attributions[nbr.v];
                if nbr_sbu < state.sbus.len()
                    && matches!(state.sbus[nbr_sbu].sbu_type, SbuType::Node | SbuType::Rod)
                {
                    node_sbus.insert(nbr_sbu);
                    anchors.push((atom, nbr.v, nbr.ofs));
                }
            }
        }

        if node_sbus.len() >= 2 {
            continue; // Bridges different clusters → Linker
        }

        if anchors.len() < 2 || node_sbus.is_empty() {
            state.sbus[sbu_idx].sbu_type = SbuType::Ligand;
            continue;
        }

        // Connected to exactly 1 node. Check if any pair of anchors has a
        // non-zero net PBC crossing through the organic chain.
        //
        // Net offset = (organic_offset[anchor2] - organic_offset[anchor1])
        //            + (bond_image2 - bond_image1)
        //
        // If non-zero → the organic chain bridges the node across PBC → Linker.
        // If zero for all pairs → terminal cap → Ligand.
        let is_bridging = anchors.windows(2).any(|pair| {
            let (org1, _node1, img1) = pair[0];
            let (org2, _node2, img2) = pair[1];
            let org_ofs1 = state.atom_offsets[org1];
            let org_ofs2 = state.atom_offsets[org2];
            // Net image offset through: node ← anchor1 — organic — anchor2 → node
            let net = [
                (org_ofs2[0] - org_ofs1[0]) + (img2[0] - img1[0]),
                (org_ofs2[1] - org_ofs1[1]) + (img2[1] - img1[1]),
                (org_ofs2[2] - org_ofs1[2]) + (img2[2] - img1[2]),
            ];
            net != [0, 0, 0]
        });

        if !is_bridging {
            state.sbus[sbu_idx].sbu_type = SbuType::Ligand;
        }
    }
}

/// Compute chemical composition formula for each SBU.
///
/// For Node SBUs, detects μ₃-O (bonded only to metals) vs μ₃-OH (bonded to metals + H).
pub fn compute_sbu_formulas(
    elements: &[Element],
    graph: &PeriodicGraph,
    state: &mut ClusteringState,
) {
    for sbu in &mut state.sbus {
        if sbu.atom_indices.is_empty() {
            continue;
        }

        // Count elements
        let mut counts: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
        // For Node SBUs, count OH groups separately
        let mut oh_count = 0usize;
        let mut bridging_o_count = 0usize;

        for &idx in &sbu.atom_indices {
            if idx >= elements.len() { continue; }
            let sym = elements[idx].symbol();
            *counts.entry(sym).or_insert(0) += 1;

            // Detect μ₃-O vs μ₃-OH in Node/Rod SBUs
            if matches!(sbu.sbu_type, SbuType::Node | SbuType::Rod) && elements[idx] == Element::O {
                let has_h_neighbor = graph.neighbors(idx).iter().any(|nbr| {
                    nbr.v < elements.len() && elements[nbr.v] == Element::H
                });
                if has_h_neighbor {
                    oh_count += 1;
                } else {
                    bridging_o_count += 1;
                }
            }
        }

        // Build formula string
        // Standard order: metals first (by atomic number), then C, then H, then others alphabetically
        let mut parts: Vec<String> = Vec::new();

        // Metals first
        let metals: Vec<(&str, usize)> = counts.iter()
            .filter(|(sym, _)| Element::from_symbol(sym).is_some_and(|e| e.is_metal()))
            .map(|(sym, &c)| (*sym, c))
            .collect();
        for (sym, c) in &metals {
            parts.push(format_element(sym, *c));
        }

        // For Node/Rod SBUs with OH groups, show them specially
        if matches!(sbu.sbu_type, SbuType::Node | SbuType::Rod) && (oh_count > 0 || bridging_o_count > 0) {
            if bridging_o_count > 0 {
                parts.push(format_element("O", bridging_o_count));
            }
            if oh_count > 0 {
                let oh_str = if oh_count > 1 { format!("(OH){}", subscript(oh_count)) } else { "OH".to_string() };
                parts.push(oh_str);
            }
            // Remaining H not accounted for by OH
            let total_h = *counts.get("H").unwrap_or(&0);
            let remaining_h = total_h.saturating_sub(oh_count);
            if remaining_h > 0 {
                parts.push(format_element("H", remaining_h));
            }
        } else {
            // Non-Node SBUs or Node without O: standard formula
            // C, then H, then alphabetical for the rest
            if let Some(&c) = counts.get("C") {
                parts.push(format_element("C", c));
            }
            if let Some(&c) = counts.get("H") {
                parts.push(format_element("H", c));
            }
            for (&sym, &c) in &counts {
                if sym == "C" || sym == "H" || metals.iter().any(|(m, _)| *m == sym) {
                    continue;
                }
                if matches!(sbu.sbu_type, SbuType::Node | SbuType::Rod) && sym == "O" {
                    continue; // already handled
                }
                parts.push(format_element(sym, c));
            }
        }

        sbu.formula = parts.join("");
    }
}

fn format_element(sym: &str, count: usize) -> String {
    if count == 1 {
        sym.to_string()
    } else {
        format!("{}{}", sym, subscript(count))
    }
}

fn subscript(n: usize) -> String {
    n.to_string().chars().map(|c| match c {
        '0' => '₀', '1' => '₁', '2' => '₂', '3' => '₃', '4' => '₄',
        '5' => '₅', '6' => '₆', '7' => '₇', '8' => '₈', '9' => '₉',
        _ => c,
    }).collect()
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

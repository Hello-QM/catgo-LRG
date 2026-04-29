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
        if sbu.sbu_type != SbuType::Node { continue; }
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
            // This is a nonmetal in the SBU — check neighbors for C atoms
            for nbr in graph.neighbors(atom) {
                if nbr.v >= elements.len() || elements[nbr.v] != Element::C { continue; }
                // C atom found — check ITS neighbors for nonmetals in other candidate SBUs
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

        if let Some((&best_ci, &count)) = opposite_counts.iter().max_by_key(|&(_, &c)| c) {
            if count >= 2 {
                pairs.push((cand.sbu_idx, candidates[best_ci].sbu_idx));
                paired[ci] = true;
                paired[best_ci] = true;
            }
        }
    }
    pairs
}

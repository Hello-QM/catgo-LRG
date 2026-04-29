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
use std::collections::VecDeque;

/// Atom class constants.
pub const CLASS_IGNORED: i32 = 0;
pub const CLASS_INORGANIC: i32 = 1;
pub const CLASS_ORGANIC: i32 = 2;
pub const CLASS_TEMP_PS: i32 = 3;
pub const CLASS_TEMP_NONMETAL: i32 = 4;

/// Classify each atom by its element type.
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
/// Key rule (follows CrystalNets.jl): atoms at the boundary between
/// inorganic and organic regions belong to the **organic** side.
///
/// - Bonded ONLY to inorganic → inorganic (e.g., μ₃-O bridging only metals)
/// - Bonded to ANY organic    → organic   (e.g., carboxylate O bonded to Zr AND C)
/// - No classified neighbors  → organic by default
///
/// This prevents the metal cluster from "eating" carboxylate oxygens and
/// fragmenting the organic linker.
pub fn reclassify_temporary(
    graph: &PeriodicGraph,
    _elements: &[Element],
    classes: &mut [i32],
) {
    let n = classes.len();
    let mut visited = vec![false; n];

    for start in 0..n {
        if visited[start] || !is_temporary(classes[start]) {
            continue;
        }

        let start_class = classes[start];
        let mut component = Vec::new();
        let mut queue = VecDeque::new();
        queue.push_back(start);
        visited[start] = true;

        let mut has_inorganic_neighbor = false;
        let mut has_organic_neighbor = false;

        while let Some(u) = queue.pop_front() {
            component.push(u);

            for nbr in graph.neighbors(u) {
                let v = nbr.v;
                if v >= n { continue; }

                let v_class = classes[v];
                if v_class == CLASS_INORGANIC {
                    has_inorganic_neighbor = true;
                } else if v_class == CLASS_ORGANIC {
                    has_organic_neighbor = true;
                } else if v_class == start_class && !visited[v] {
                    visited[v] = true;
                    queue.push_back(v);
                }
            }
        }

        // Boundary atoms (bonded to both sides) go to ORGANIC.
        // Only atoms bonded exclusively to inorganic become INORGANIC.
        let new_class = if has_inorganic_neighbor && !has_organic_neighbor {
            CLASS_INORGANIC
        } else {
            CLASS_ORGANIC
        };

        for &idx in &component {
            classes[idx] = new_class;
        }
    }
}

fn is_temporary(class: i32) -> bool {
    class == CLASS_TEMP_PS || class == CLASS_TEMP_NONMETAL
}

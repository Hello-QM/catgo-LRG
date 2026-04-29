//! MOF topology analysis — SBU/Linker detection.
//!
//! Ports CrystalNets.jl's clustering algorithm to Rust.
//! Given a crystal structure and bonds (with periodic image offsets),
//! automatically identifies inorganic SBUs, organic linkers, and
//! points of extension.

pub mod cap_replace;
pub mod classify;
pub mod clustering;
pub mod functional_groups;
pub mod paddlewheel;
pub mod periodic_graph;
pub mod rac;
pub mod rod;
pub mod wl_hash;

use serde::{Deserialize, Serialize};

/// Type of a Secondary Building Unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SbuType {
    /// Metal cluster + bridging atoms (e.g., Zr₆O₄(OH)₄)
    #[serde(alias = "Inorganic")]
    Node,
    /// Bridging organic — connects ≥2 different nodes (e.g., BDC, BTC)
    #[serde(alias = "Organic")]
    Linker,
    /// Terminal organic — connects to only 1 node (e.g., formate cap, phosphonate cap)
    Ligand,
    /// Connection point between node and linker (bridge atom)
    PointOfExtension,
    /// 1D infinite metal chain periodic in exactly one direction (e.g., MIL-53 Al chains).
    Rod,
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
    /// Chemical composition formula (e.g., "Zr₆O₄(OH)₄", "C₆H₃(COO)₃").
    #[serde(default)]
    pub formula: String,
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
    /// Functional groups found on Linker/Ligand SBUs (populated only when `is_mof` is true).
    #[serde(default)]
    pub functional_groups: Vec<functional_groups::FunctionalGroup>,
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

    let n = structure.frac_coords.len();
    if n == 0 {
        return MofClusters {
            sbus: Vec::new(),
            attributions: Vec::new(),
            is_mof: false,
            functional_groups: Vec::new(),
        };
    }

    // Step 1: Build periodic graph from bonds
    let graph = PeriodicGraph::from_bonds(n, bonds);

    // Step 2: Classify atoms by element type
    let elements: Vec<crate::element::Element> = structure
        .site_occupancies
        .iter()
        .map(|occ| occ.dominant_species().element)
        .collect();
    let mut classes = classify::classify_atoms(&elements);

    // Step 3: Reclassify temporary atoms based on neighbors
    classify::reclassify_temporary(&graph, &elements, &mut classes);

    // Step 4: Find connected components → initial SBUs
    let mut clusters = clustering::find_connected_sbus(&graph, &classes, n);

    // Step 5: Detect and merge paddle-wheels
    paddlewheel::detect_and_merge(&graph, &elements, &mut clusters);

    // Step 5.5: Detect 1D rod SBUs (before resolve_periodic_sbus splits them)
    rod::detect_and_mark_rods(&graph, &mut clusters);

    // Step 6: Resolve periodic SBUs (Rod SBUs are skipped — they are preserved intact)
    clustering::resolve_periodic_sbus(&graph, &elements, &mut clusters);

    // Step 7: Mark points of extension
    clustering::mark_points_of_extension(&graph, &mut clusters);

    // Step 8: Distinguish linkers from ligands (caps)
    // A Linker bridges ≥2 distinct Node SBUs; a Ligand connects to only 1.
    clustering::classify_linkers_vs_ligands(&graph, &mut clusters);

    // Step 9: Compute SBU composition formulas
    clustering::compute_sbu_formulas(&elements, &graph, &mut clusters);

    // Check if this is actually a MOF (needs both nodes/rods and linkers)
    let has_node = clusters
        .sbus
        .iter()
        .any(|s| matches!(s.sbu_type, SbuType::Node | SbuType::Rod));
    let has_linker = clusters.sbus.iter().any(|s| s.sbu_type == SbuType::Linker);
    let is_mof = has_node && has_linker;

    let mut result = MofClusters {
        is_mof,
        sbus: clusters.sbus,
        attributions: clusters.attributions,
        functional_groups: Vec::new(),
    };

    // Step 10: Detect functional groups on linkers/ligands (only for real MOFs).
    if is_mof {
        result.functional_groups =
            functional_groups::detect_functional_groups(&result, &graph, &elements);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bonding::Bond;
    use crate::element::Element;
    use crate::lattice::Lattice;
    use crate::species::{SiteOccupancy, Species};
    use nalgebra::{Matrix3, Vector3};

    fn make_simple_mof() -> (crate::structure::Structure, Vec<Bond>) {
        // Simplified MOF: Zn + 2 carboxylate (O-C-O) linkers with C-C backbone
        // Zn(0) -- O(1) -- C(3) -- C(5) -- C(4) -- O(2) -- Zn(0, image)
        //                   |                 |
        //                  O(6)             O(7)   (dangling O for asymmetry)
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
                s(Element::Zn), // 0: metal center
                s(Element::O),  // 1: carboxylate O (bridge to Zn)
                s(Element::O),  // 2: carboxylate O (bridge to Zn, other side)
                s(Element::C),  // 3: carboxylate C (bonded to O1, C5)
                s(Element::C),  // 4: carboxylate C (bonded to O2, C5)
                s(Element::C),  // 5: aromatic C (backbone, bonded to C3, C4)
                s(Element::C),  // 6: aromatic C (bonded to C5)
                s(Element::C),  // 7: aromatic C (bonded to C6)
            ],
            frac_coords: vec![
                Vector3::new(0.1, 0.5, 0.5), // Zn
                Vector3::new(0.2, 0.5, 0.5), // O
                Vector3::new(0.8, 0.5, 0.5), // O
                Vector3::new(0.3, 0.5, 0.5), // C-carboxylate
                Vector3::new(0.7, 0.5, 0.5), // C-carboxylate
                Vector3::new(0.4, 0.5, 0.5), // C-aromatic
                Vector3::new(0.5, 0.5, 0.5), // C-aromatic
                Vector3::new(0.6, 0.5, 0.5), // C-aromatic
            ],
            pbc: [true, true, true],
            charge: 0.0,
            properties: Default::default(),
        };

        let bonds = vec![
            // Zn-O coordination bonds (O2 at x=0.8 connects back to Zn at x=0.1 via periodic image)
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 2.0, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 0, site_idx_2: 2, bond_length: 2.0, strength: 1.0, image: [-1, 0, 0] },
            // O-C carboxylate bonds
            Bond { site_idx_1: 1, site_idx_2: 3, bond_length: 1.3, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 2, site_idx_2: 4, bond_length: 1.3, strength: 1.0, image: [0, 0, 0] },
            // C-C backbone (aromatic ring / linker body)
            Bond { site_idx_1: 3, site_idx_2: 5, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 5, site_idx_2: 6, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 6, site_idx_2: 7, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            Bond { site_idx_1: 7, site_idx_2: 4, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
        ];

        (structure, bonds)
    }

    #[test]
    fn test_simple_mof_detection() {
        let (structure, bonds) = make_simple_mof();
        let result = detect_sbus(&structure, &bonds);

        assert!(result.is_mof, "Should be identified as MOF");
        assert!(result.sbus.iter().any(|s| s.sbu_type == SbuType::Node));
        assert!(result.sbus.iter().any(|s| s.sbu_type == SbuType::Linker));

        // Zn should be in a Node SBU
        let zn_sbu = result.attributions[0];
        assert_eq!(result.sbus[zn_sbu].sbu_type, SbuType::Node);

        // Backbone C atoms (5, 6, 7) should be in Linker SBUs
        for c_idx in [5, 6, 7] {
            let c_sbu = result.attributions[c_idx];
            assert!(
                result.sbus[c_sbu].sbu_type == SbuType::Linker
                    || result.sbus[c_sbu].sbu_type == SbuType::PointOfExtension,
                "Backbone C atom {} should be Linker or PE, got {:?}",
                c_idx, result.sbus[c_sbu].sbu_type
            );
        }
    }

    #[test]
    fn test_empty_structure() {
        let lattice = Lattice::new(Matrix3::identity() * 10.0);
        let structure = crate::structure::Structure {
            lattice,
            site_occupancies: vec![],
            frac_coords: vec![],
            pbc: [true, true, true],
            charge: 0.0,
            properties: Default::default(),
        };
        let result = detect_sbus(&structure, &[]);
        assert!(!result.is_mof);
        assert!(result.sbus.is_empty());
    }

    #[test]
    fn test_pure_metal_not_mof() {
        let lattice = Lattice::new(Matrix3::identity() * 3.0);
        let species_of = |el: Element| SiteOccupancy {
            species: vec![(Species::neutral(el), 1.0)],
            properties: Default::default(),
        };
        let structure = crate::structure::Structure {
            lattice,
            site_occupancies: vec![species_of(Element::Fe), species_of(Element::Fe)],
            frac_coords: vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(0.5, 0.5, 0.5)],
            pbc: [true, true, true],
            charge: 0.0,
            properties: Default::default(),
        };
        let bonds = vec![
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 2.5, strength: 1.0, image: [0, 0, 0] },
        ];
        let result = detect_sbus(&structure, &bonds);
        assert!(!result.is_mof, "Pure metal should not be identified as MOF");
    }
}

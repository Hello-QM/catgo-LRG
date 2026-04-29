//! Cap replacement engine for MOF structures.
//!
//! Enables the user workflow: Load MOF → Analyse (detect Nodes, Linkers, Caps)
//! → Select new fragment → Replace all caps → Export.
//!
//! The key operation is:
//! 1. Find every Ligand SBU (cap) and the bond connecting it to the framework.
//! 2. Remove all cap atoms.
//! 3. For each cap attachment point, orient the replacement fragment along the
//!    node→cap bond direction and insert it into the structure.

use nalgebra::{Matrix3, Vector3};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use super::{MofClusters, SbuType};
use super::periodic_graph::PeriodicGraph;
use crate::bonding::Bond;
use crate::element::Element;
use crate::species::{SiteOccupancy, Species};
use crate::structure::Structure;

// ─────────────────────────────────────────────
// Public input/output types
// ─────────────────────────────────────────────

/// A molecular fragment supplied by the frontend for cap replacement.
///
/// Coordinates come as `[[x,y,z], ...]` (JSON arrays) and elements as symbol
/// strings like `["C", "H", "H"]`. Both use the `*_raw` fields for JSON I/O;
/// the Rust code works with the converted types.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MolecularFragment {
    /// Element symbols for each atom in the fragment.
    pub elements: Vec<Element>,
    /// Cartesian coordinates in Ångströms stored as `[x, y, z]` arrays so that
    /// serde can round-trip them without a custom nalgebra deserializer.
    #[serde(alias = "cart_coords")]
    pub cart_coords: Vec<[f64; 3]>,
    /// Index (0-based) of the fragment atom that bonds to the MOF attachment point.
    pub bonding_atom_idx: usize,
}

impl MolecularFragment {
    /// Convenience: get the bonding atom's Cartesian position as a `Vector3`.
    pub fn bonding_atom_pos(&self) -> Vector3<f64> {
        let c = self.cart_coords[self.bonding_atom_idx];
        Vector3::new(c[0], c[1], c[2])
    }

    /// Convenience: get atom `i` as a `Vector3`.
    pub fn atom_pos(&self, i: usize) -> Vector3<f64> {
        let c = self.cart_coords[i];
        Vector3::new(c[0], c[1], c[2])
    }

    /// Number of atoms in the fragment.
    pub fn len(&self) -> usize {
        self.elements.len()
    }
}

/// Result returned to the caller after cap replacement.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapReplacementResult {
    /// New structure with all caps replaced by the supplied fragment.
    pub structure: Structure,
    /// Number of cap SBUs that were replaced.
    pub caps_replaced: usize,
}

// ─────────────────────────────────────────────
// Internal types
// ─────────────────────────────────────────────

/// Describes one cap–framework attachment point.
pub struct CapAnchor {
    /// Index of the Ligand SBU this anchor belongs to.
    pub cap_sbu_idx: usize,
    /// Atom index on the node/framework side of the bond.
    pub node_attachment_atom: usize,
    /// Atom index on the cap side of the bond.
    pub cap_anchor_atom: usize,
    /// Unit vector from node attachment atom → cap anchor atom (Cartesian).
    pub bond_direction: Vector3<f64>,
    /// Periodic image offset: atom `node_attachment_atom` in cell `bond_image`
    /// is bonded to `cap_anchor_atom` in cell [0,0,0].
    pub bond_image: [i32; 3],
}

// ─────────────────────────────────────────────
// Core functions
// ─────────────────────────────────────────────

/// Find all cap anchors: for each Ligand SBU, find the bond(s) connecting it to
/// a Node / Rod / PointOfExtension atom.
///
/// Returns one `CapAnchor` per (cap SBU, bond) pair.  Use
/// `deduplicate_by_cap_sbu` to get at most one anchor per cap SBU.
pub fn find_cap_anchors(
    structure: &Structure,
    clusters: &MofClusters,
    graph: &PeriodicGraph,
) -> Vec<CapAnchor> {
    let lat = structure.lattice.matrix();
    let n = structure.frac_coords.len();
    let mut anchors = Vec::new();

    for (sbu_idx, sbu) in clusters.sbus.iter().enumerate() {
        if sbu.sbu_type != SbuType::Ligand {
            continue;
        }

        for &cap_atom in &sbu.atom_indices {
            for nbr in graph.neighbors(cap_atom) {
                if nbr.v >= n {
                    continue;
                }
                let nbr_sbu_idx = clusters.attributions[nbr.v];
                if nbr_sbu_idx >= clusters.sbus.len() {
                    continue;
                }
                let nbr_type = clusters.sbus[nbr_sbu_idx].sbu_type;
                if !matches!(
                    nbr_type,
                    SbuType::Node | SbuType::Rod | SbuType::PointOfExtension
                ) {
                    continue;
                }

                // nbr.ofs is the image of the neighbor (node atom) relative to
                // the cap atom's cell.
                // node position in cap's reference frame:
                //   cart(frac[node] + ofs)
                // cap position: cart(frac[cap])
                // direction from node → cap (unit vector)
                let node_frac = structure.frac_coords[nbr.v]
                    + Vector3::new(
                        nbr.ofs[0] as f64,
                        nbr.ofs[1] as f64,
                        nbr.ofs[2] as f64,
                    );
                let cap_frac = structure.frac_coords[cap_atom];

                let node_cart = lat * node_frac;
                let cap_cart = lat * cap_frac;

                let diff = cap_cart - node_cart;
                let len = diff.norm();
                let direction = if len > 1e-10 { diff / len } else { Vector3::z() };

                anchors.push(CapAnchor {
                    cap_sbu_idx: sbu_idx,
                    node_attachment_atom: nbr.v,
                    cap_anchor_atom: cap_atom,
                    bond_direction: direction,
                    bond_image: nbr.ofs,
                });
            }
        }
    }

    anchors
}

/// Keep at most one anchor per cap SBU (the first one found).
///
/// Multiple bonds between one cap and the framework would create multiple
/// anchors for the same SBU.  We only insert one fragment per cap site.
fn deduplicate_by_cap_sbu(anchors: Vec<CapAnchor>) -> Vec<CapAnchor> {
    let mut seen: HashSet<usize> = HashSet::new();
    anchors
        .into_iter()
        .filter(|a| seen.insert(a.cap_sbu_idx))
        .collect()
}

/// Rotate a molecular fragment so that its bonding atom aligns with
/// `attachment_point_cart + bond_direction * bond_length`, and all other
/// atoms maintain their relative geometry.
///
/// Steps:
/// 1. Translate fragment so bonding atom is at origin.
/// 2. Compute the rotation that maps the fragment's internal bond axis to
///    `bond_direction`.
/// 3. Translate to final position.
pub fn align_fragment(
    fragment: &MolecularFragment,
    attachment_point_cart: Vector3<f64>,
    bond_direction: Vector3<f64>,
    bond_length: f64,
) -> MolecularFragment {
    let bonding_pos = fragment.bonding_atom_pos();

    // Determine the fragment's own outward axis: from fragment centroid toward
    // the bonding atom.  If the fragment has only 1 atom, fall back to +z.
    let outward_axis = if fragment.len() > 1 {
        let centroid: Vector3<f64> = fragment
            .cart_coords
            .iter()
            .map(|c| Vector3::new(c[0], c[1], c[2]))
            .fold(Vector3::zeros(), |acc, p| acc + p)
            / fragment.len() as f64;
        let v = bonding_pos - centroid;
        let n = v.norm();
        if n > 1e-10 { v / n } else { Vector3::z() }
    } else {
        Vector3::z()
    };

    let rot = rotation_between(outward_axis, bond_direction);

    // Final position of the bonding atom: just beyond attachment point
    let target_bonding_pos = attachment_point_cart + bond_direction * bond_length;

    let new_coords: Vec<[f64; 3]> = fragment
        .cart_coords
        .iter()
        .map(|c| {
            let pos = Vector3::new(c[0], c[1], c[2]);
            let centered = pos - bonding_pos;
            let rotated = rot * centered;
            let final_pos = rotated + target_bonding_pos;
            [final_pos.x, final_pos.y, final_pos.z]
        })
        .collect();

    MolecularFragment {
        elements: fragment.elements.clone(),
        cart_coords: new_coords,
        bonding_atom_idx: fragment.bonding_atom_idx,
    }
}

/// Compute a rotation matrix that rotates unit vector `from` to unit vector `to`
/// using Rodrigues' rotation formula.
///
/// Special cases:
/// - Nearly parallel (dot > 0.9999): identity.
/// - Nearly antiparallel (dot < -0.9999): 180° rotation around a perpendicular axis.
pub fn rotation_between(from: Vector3<f64>, to: Vector3<f64>) -> Matrix3<f64> {
    let c = from.dot(&to);
    if c > 0.9999 {
        return Matrix3::identity();
    }
    if c < -0.9999 {
        // 180° rotation around any axis perpendicular to `from`
        let perp = perpendicular_to(from);
        let u = perp;
        // Rodrigues for θ=π: R = 2 u uᵀ - I
        let ux = u.x;
        let uy = u.y;
        let uz = u.z;
        return Matrix3::new(
            2.0 * ux * ux - 1.0, 2.0 * ux * uy,       2.0 * ux * uz,
            2.0 * uy * ux,       2.0 * uy * uy - 1.0, 2.0 * uy * uz,
            2.0 * uz * ux,       2.0 * uz * uy,       2.0 * uz * uz - 1.0,
        );
    }
    // Normal case: R = I + K + K²/(1+c)
    // where K is the skew-symmetric matrix of the cross product axis
    let axis = from.cross(&to); // not normalised — magnitude = sin(θ)
    let kx = axis.x;
    let ky = axis.y;
    let kz = axis.z;
    // K (skew-symmetric)
    let k = Matrix3::new(
         0.0, -kz,  ky,
         kz,  0.0, -kx,
        -ky,  kx,  0.0,
    );
    let k2 = k * k;
    Matrix3::identity() + k + k2 * (1.0 / (1.0 + c))
}

/// Find an arbitrary unit vector perpendicular to `v`.
fn perpendicular_to(v: Vector3<f64>) -> Vector3<f64> {
    let candidate = if v.x.abs() < 0.9 {
        Vector3::new(1.0, 0.0, 0.0)
    } else {
        Vector3::new(0.0, 1.0, 0.0)
    };
    let perp = v.cross(&candidate);
    perp.normalize()
}

/// Estimate a reasonable bond length for the new fragment–framework bond.
///
/// Uses covalent radii of the two elements involved.  Falls back to 1.5 Å.
fn estimate_bond_length(node_elem: Element, frag_elem: Element) -> f64 {
    let r1 = node_elem.covalent_radius().unwrap_or(0.75);
    let r2 = frag_elem.covalent_radius().unwrap_or(0.75);
    r1 + r2
}

/// Main entry point: replace all Ligand (cap) SBUs with `fragment`.
///
/// # Arguments
/// * `structure`  — original MOF structure
/// * `bonds`      — pre-computed bond list (with periodic images)
/// * `clusters`   — SBU assignments from `detect_sbus`
/// * `fragment`   — replacement fragment
///
/// # Returns
/// A `CapReplacementResult` with the modified structure and replacement count.
pub fn replace_caps(
    structure: &Structure,
    bonds: &[Bond],
    clusters: &MofClusters,
    fragment: &MolecularFragment,
) -> Result<CapReplacementResult, String> {
    if fragment.elements.is_empty() {
        return Err("Fragment has no atoms".to_string());
    }
    if fragment.bonding_atom_idx >= fragment.len() {
        return Err(format!(
            "bonding_atom_idx {} out of range (fragment has {} atoms)",
            fragment.bonding_atom_idx,
            fragment.len()
        ));
    }

    let n = structure.frac_coords.len();
    if n == 0 {
        return Ok(CapReplacementResult {
            structure: structure.clone(),
            caps_replaced: 0,
        });
    }

    let graph = PeriodicGraph::from_bonds(n, bonds);
    let lat = structure.lattice.matrix();
    let inv_lat = structure.lattice.inv_matrix();

    // Step 1: Find all cap anchors, one per cap SBU
    let all_anchors = find_cap_anchors(structure, clusters, &graph);
    let anchors = deduplicate_by_cap_sbu(all_anchors);

    // Step 2: Collect all cap atom indices to remove
    let cap_atoms_to_remove: HashSet<usize> = clusters
        .sbus
        .iter()
        .filter(|s| s.sbu_type == SbuType::Ligand)
        .flat_map(|s| s.atom_indices.iter().copied())
        .collect();

    let caps_replaced = anchors.len();

    // Step 3: Build the new structure — keep non-cap atoms
    let mut new_occupancies: Vec<SiteOccupancy> = Vec::new();
    let mut new_frac_coords: Vec<Vector3<f64>> = Vec::new();

    for i in 0..n {
        if !cap_atoms_to_remove.contains(&i) {
            new_occupancies.push(structure.site_occupancies[i].clone());
            new_frac_coords.push(structure.frac_coords[i]);
        }
    }

    // Step 4: For each anchor, align and insert the replacement fragment
    for anchor in &anchors {
        let node_elem = structure.site_occupancies[anchor.node_attachment_atom]
            .dominant_species()
            .element;
        let frag_bonding_elem = fragment.elements[fragment.bonding_atom_idx];
        let bond_len = estimate_bond_length(node_elem, frag_bonding_elem);

        // Node atom's Cartesian position in the cap's reference frame
        let node_frac = structure.frac_coords[anchor.node_attachment_atom]
            + Vector3::new(
                anchor.bond_image[0] as f64,
                anchor.bond_image[1] as f64,
                anchor.bond_image[2] as f64,
            );
        let node_cart = lat * node_frac;

        // Align the fragment along the bond direction
        let aligned = align_fragment(fragment, node_cart, anchor.bond_direction, bond_len);

        // Convert aligned fragment atoms to fractional coords and add to structure
        for (i, elem) in aligned.elements.iter().enumerate() {
            let cart = aligned.atom_pos(i);
            let frac = inv_lat * cart;

            new_occupancies.push(SiteOccupancy {
                species: vec![(Species::neutral(*elem), 1.0)],
                properties: Default::default(),
            });
            new_frac_coords.push(frac);
        }
    }

    let new_structure = Structure {
        lattice: structure.lattice.clone(),
        site_occupancies: new_occupancies,
        frac_coords: new_frac_coords,
        pbc: structure.pbc,
        charge: structure.charge,
        properties: HashMap::new(),
    };

    Ok(CapReplacementResult {
        structure: new_structure,
        caps_replaced,
    })
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bonding::Bond;
    use crate::element::Element;
    use crate::lattice::Lattice;
    use crate::species::{SiteOccupancy, Species};
    use nalgebra::{Matrix3, Vector3};

    /// Build a minimal MOF:
    ///
    /// ```text
    /// Zn(0) — O(1) — C(2) — C(3) — O(4) — Zn(0, image)    (linker)
    ///       \
    ///        F(5)                                             (cap / Ligand)
    /// ```
    ///
    /// Zn is the Node, O–C–C–O is the Linker, F is a Ligand cap bonded only to Zn.
    fn make_mof_with_cap() -> (Structure, Vec<Bond>, MofClusters) {
        let lattice = Lattice::new(Matrix3::new(
            10.0, 0.0, 0.0,
            0.0, 10.0, 0.0,
            0.0, 0.0, 10.0,
        ));

        let s = |el: Element| SiteOccupancy {
            species: vec![(Species::neutral(el), 1.0)],
            properties: Default::default(),
        };

        let structure = Structure {
            lattice,
            site_occupancies: vec![
                s(Element::Zn), // 0: metal node
                s(Element::O),  // 1: carboxylate O (linker side A)
                s(Element::C),  // 2: carboxylate C (linker)
                s(Element::C),  // 3: carboxylate C (linker, other end)
                s(Element::O),  // 4: carboxylate O (linker side B)
                s(Element::F),  // 5: cap fluoride (Ligand — bonds only to Zn)
            ],
            frac_coords: vec![
                Vector3::new(0.1, 0.5, 0.5), // Zn
                Vector3::new(0.2, 0.5, 0.5), // O linker
                Vector3::new(0.3, 0.5, 0.5), // C
                Vector3::new(0.7, 0.5, 0.5), // C
                Vector3::new(0.8, 0.5, 0.5), // O linker (other side, periodic)
                Vector3::new(0.1, 0.6, 0.5), // F cap (same x as Zn but y+1 Å)
            ],
            pbc: [true, true, true],
            charge: 0.0,
            properties: Default::default(),
        };

        let bonds = vec![
            // Zn – O (linker side A)
            Bond { site_idx_1: 0, site_idx_2: 1, bond_length: 2.0, strength: 1.0, image: [0, 0, 0] },
            // O – C
            Bond { site_idx_1: 1, site_idx_2: 2, bond_length: 1.3, strength: 1.0, image: [0, 0, 0] },
            // C – C
            Bond { site_idx_1: 2, site_idx_2: 3, bond_length: 1.4, strength: 1.0, image: [0, 0, 0] },
            // C – O (other side)
            Bond { site_idx_1: 3, site_idx_2: 4, bond_length: 1.3, strength: 1.0, image: [0, 0, 0] },
            // O – Zn (periodic: atom 4 at x=0.8 bonds to Zn at x=0.1 in next cell)
            Bond { site_idx_1: 4, site_idx_2: 0, bond_length: 2.0, strength: 1.0, image: [1, 0, 0] },
            // Zn – F (cap bond, Ligand)
            Bond { site_idx_1: 0, site_idx_2: 5, bond_length: 2.0, strength: 1.0, image: [0, 0, 0] },
        ];

        // Construct MofClusters manually to avoid running the full detector
        // SBU 0: Node  = [Zn(0)]
        // SBU 1: Linker = [O(1), C(2), C(3), O(4)]
        // SBU 2: Ligand = [F(5)]
        let sbus = vec![
            super::super::Sbu {
                atom_indices: vec![0],
                sbu_type: SbuType::Node,
                is_periodic: false,
                formula: "Zn".to_string(),
            },
            super::super::Sbu {
                atom_indices: vec![1, 2, 3, 4],
                sbu_type: SbuType::Linker,
                is_periodic: false,
                formula: "C2O2".to_string(),
            },
            super::super::Sbu {
                atom_indices: vec![5],
                sbu_type: SbuType::Ligand,
                is_periodic: false,
                formula: "F".to_string(),
            },
        ];
        // attributions: atom → SBU index
        let attributions = vec![0, 1, 1, 1, 1, 2];

        let clusters = MofClusters {
            sbus,
            attributions,
            is_mof: true,
            functional_groups: Vec::new(),
        };

        (structure, bonds, clusters)
    }

    #[test]
    fn test_find_cap_anchors() {
        let (structure, bonds, clusters) = make_mof_with_cap();
        let n = structure.frac_coords.len();
        let graph = PeriodicGraph::from_bonds(n, &bonds);

        let anchors = find_cap_anchors(&structure, &clusters, &graph);

        // Should find exactly one anchor: F(5) bonded to Zn(0)
        assert_eq!(anchors.len(), 1, "Expected 1 anchor, got {}", anchors.len());
        assert_eq!(anchors[0].cap_sbu_idx, 2, "Anchor should belong to cap SBU 2");
        assert_eq!(anchors[0].cap_anchor_atom, 5, "Cap anchor atom should be F (index 5)");
        assert_eq!(
            anchors[0].node_attachment_atom, 0,
            "Node attachment atom should be Zn (index 0)"
        );

        // The bond direction should be a unit vector
        let norm = anchors[0].bond_direction.norm();
        assert!((norm - 1.0).abs() < 1e-6, "Bond direction should be normalised");
    }

    #[test]
    fn test_replace_produces_valid_structure() {
        let (structure, bonds, clusters) = make_mof_with_cap();

        // Fragment: a simple Cl atom (replaces F cap)
        let fragment = MolecularFragment {
            elements: vec![Element::Cl],
            cart_coords: vec![[0.0, 0.0, 0.0]],
            bonding_atom_idx: 0,
        };

        let result = replace_caps(&structure, &bonds, &clusters, &fragment)
            .expect("replace_caps should succeed");

        // Original: 6 atoms (Zn, O, C, C, O, F)
        // Removed:  1 cap atom (F at index 5)
        // Added:    1 fragment atom (Cl)
        // Net:      6 - 1 + 1 = 6
        let expected_atoms = structure.frac_coords.len() - 1 + fragment.len();
        assert_eq!(
            result.structure.frac_coords.len(),
            expected_atoms,
            "Expected {} atoms, got {}",
            expected_atoms,
            result.structure.frac_coords.len()
        );
        assert_eq!(result.caps_replaced, 1, "Should have replaced 1 cap");

        // The new structure should contain Cl but not F
        let has_cl = result
            .structure
            .site_occupancies
            .iter()
            .any(|occ| occ.dominant_species().element == Element::Cl);
        let has_f = result
            .structure
            .site_occupancies
            .iter()
            .any(|occ| occ.dominant_species().element == Element::F);

        assert!(has_cl, "Replacement structure should contain Cl");
        assert!(!has_f, "Replacement structure should not contain F");
    }

    #[test]
    fn test_rotation_between_parallel() {
        let a = Vector3::new(0.0, 0.0, 1.0);
        let b = Vector3::new(0.0, 0.0, 1.0);
        let r = rotation_between(a, b);
        let result = r * a;
        assert!((result - b).norm() < 1e-10);
    }

    #[test]
    fn test_rotation_between_antiparallel() {
        let a = Vector3::new(0.0, 0.0, 1.0);
        let b = Vector3::new(0.0, 0.0, -1.0);
        let r = rotation_between(a, b);
        let result = r * a;
        assert!(
            (result - b).norm() < 1e-10,
            "After 180° rotation, result = {result:?}, expected {b:?}"
        );
    }

    #[test]
    fn test_rotation_between_orthogonal() {
        let a = Vector3::new(1.0, 0.0, 0.0);
        let b = Vector3::new(0.0, 1.0, 0.0);
        let r = rotation_between(a, b);
        let result = r * a;
        assert!(
            (result - b).norm() < 1e-10,
            "After 90° rotation, result = {result:?}, expected {b:?}"
        );
    }

    #[test]
    fn test_align_fragment_single_atom() {
        // Single-atom fragment: should end up at attachment_point + direction * bond_length
        let frag = MolecularFragment {
            elements: vec![Element::Cl],
            cart_coords: vec![[0.0, 0.0, 0.0]],
            bonding_atom_idx: 0,
        };

        let attachment = Vector3::new(1.0, 2.0, 3.0);
        let direction = Vector3::new(1.0, 0.0, 0.0);
        let bond_len = 2.0;

        let aligned = align_fragment(&frag, attachment, direction, bond_len);
        let pos = aligned.atom_pos(0);

        let expected = attachment + direction * bond_len;
        assert!(
            (pos - expected).norm() < 1e-10,
            "Aligned position {pos:?} should equal {expected:?}"
        );
    }

    #[test]
    fn test_fragment_serde_roundtrip() {
        let frag = MolecularFragment {
            elements: vec![Element::C, Element::H, Element::H, Element::H],
            cart_coords: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            bonding_atom_idx: 0,
        };
        let json = serde_json::to_string(&frag).expect("serialize");
        let back: MolecularFragment = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.elements.len(), 4);
        assert_eq!(back.elements[0], Element::C);
        assert_eq!(back.bonding_atom_idx, 0);
    }
}

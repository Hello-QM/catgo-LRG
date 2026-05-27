//! Pseudo-hydrogen passivation for slab surface dangling bonds.
//!
//! Faithful Rust port of `server/catgo/utils/pseudo_hydrogen.py` (ASE-based).
//!
//! # Theory
//!
//! In bulk, each A-B covalent bond shares 2 electrons:
//! `e_A = V_A / N_A`, `e_B = V_B / N_B`, with `e_A + e_B = 2`,
//! where `V` = bonding valence electrons and `N` = coordination number.
//!
//! When a slab is cut, surface atoms lose neighbors (dangling bonds). The
//! pseudo-hydrogen nuclear charge equals the electron contribution of the
//! **missing** neighbor: `Z_H = V_missing / N_missing`.
//!
//! This module mirrors the ASE `NeighborList` semantics: two atoms `i, j`
//! (across periodic images) are neighbors when `d_ij <= cutoff_i + cutoff_j`,
//! where `cutoff_k` is a per-atom radius. ASE `natural_cutoffs(mult)` returns
//! `covalent_radius(k) * mult` per atom.

use std::collections::HashMap;

use nalgebra::Vector3;

use crate::element::Element;
use crate::structure::Structure;

/// Chemical bonding valence electrons (NOT VASP POTCAR electron count).
///
/// For `Z_H = V_missing / N_missing`, each bulk A-B bond must satisfy
/// `V_A/N_A + V_B/N_B = 2`. Override via params for non-standard cases.
pub fn default_valence(symbol: &str) -> Option<f64> {
    let v = match symbol {
        // s block
        "H" | "Li" | "Na" | "K" | "Rb" | "Cs" => 1.0,
        "Be" | "Mg" | "Ca" | "Sr" | "Ba" => 2.0,
        // p block
        "B" | "Al" | "Ga" | "In" | "Tl" => 3.0,
        "C" | "Si" | "Ge" | "Sn" | "Pb" => 4.0,
        "N" | "P" | "As" | "Sb" | "Bi" => 5.0,
        "O" | "S" | "Se" | "Te" => 6.0,
        "F" | "Cl" | "Br" | "I" => 7.0,
        // d block
        "Sc" => 3.0,
        "Ti" => 4.0,
        "V" => 5.0,
        "Cr" => 6.0,
        "Mn" => 7.0,
        "Fe" => 3.0,
        "Co" => 3.0,
        "Ni" => 2.0,
        "Cu" => 1.0,
        "Zn" => 2.0,
        "Y" => 3.0,
        "Zr" => 4.0,
        "Nb" => 5.0,
        "Mo" => 6.0,
        "Tc" => 7.0,
        "Ru" => 4.0,
        "Rh" => 3.0,
        "Pd" => 2.0,
        "Ag" => 1.0,
        "Cd" => 2.0,
        "Hf" => 4.0,
        "Ta" => 5.0,
        "W" => 6.0,
        "Re" => 7.0,
        "Os" => 4.0,
        "Ir" => 4.0,
        "Pt" => 4.0,
        "Au" => 3.0,
        _ => return None,
    };
    Some(v)
}

/// Available VASP pseudo-H charges (snap target).
const VASP_PSEUDO_H_CHARGES: [f64; 14] = [
    0.25, 0.33, 0.42, 0.50, 0.58, 0.66, 0.75, 1.00, 1.25, 1.33, 1.50, 1.66, 1.75, 2.00,
];

/// Map a snapped VASP charge to its POTCAR filename. Matches the Python dict.
fn vasp_potcar_name(charge: f64) -> String {
    // Compare with small tolerance against known keys.
    let table: [(f64, &str); 14] = [
        (0.25, "H.25"),
        (0.33, "H.33"),
        (0.42, "H.42"),
        (0.50, "H.50"),
        (0.58, "H.58"),
        (0.66, "H.66"),
        (0.75, "H.75"),
        (1.00, "H"),
        (1.25, "H1.25"),
        (1.33, "H1.33"),
        (1.50, "H1.50"),
        (1.66, "H1.66"),
        (1.75, "H1.75"),
        (2.00, "H1.75"), // 2.00 approximated, matches Python
    ];
    for (k, name) in table.iter() {
        if (charge - k).abs() < 1e-6 {
            return name.to_string();
        }
    }
    format!("H{charge:.2}")
}

/// Information about a single placed pseudo-hydrogen atom.
#[derive(Debug, Clone)]
pub struct PseudoHInfo {
    /// Cartesian position (Angstrom).
    pub position: Vector3<f64>,
    /// Exact charge `V_missing / N_missing`.
    pub charge: f64,
    /// Nearest available VASP charge.
    pub vasp_charge: f64,
    /// POTCAR filename (e.g., "H.50").
    pub potcar_name: String,
    /// Index of the parent (surface) atom in the original slab.
    pub parent_index: usize,
    /// Element symbol of the parent atom.
    pub parent_symbol: String,
    /// Element that was cut away (the missing neighbor).
    pub missing_symbol: String,
    /// Normalized bond direction.
    pub bond_direction: Vector3<f64>,
}

/// Complete passivation result.
#[derive(Debug, Clone)]
pub struct PassivationResult {
    /// Slab with pseudo-H appended.
    pub slab: Structure,
    /// All pseudo-H placed.
    pub pseudo_h_list: Vec<PseudoHInfo>,
    /// Detected bulk coordination per element.
    pub bulk_coordination: HashMap<String, usize>,
    /// Sorted unique POTCAR names.
    pub unique_potcars: Vec<String>,
    /// Valence electrons used per element.
    pub valence_used: HashMap<String, f64>,
    /// Bond-electron validation warnings.
    pub bond_warnings: Vec<String>,
}

/// Parameters controlling passivation. Mirrors the Python `PseudoHydrogenParams`.
#[derive(Debug, Clone)]
pub struct PassivateParams {
    /// Passivate the top surface.
    pub passivate_top: bool,
    /// Passivate the bottom surface.
    pub passivate_bottom: bool,
    /// Surface-depth threshold (Angstrom).
    pub surface_depth: f64,
    /// Pseudo-H bond length scale: `(r_parent + r_H) * scale`.
    pub bond_length_scale: f64,
    /// Neighbor cutoff multiplier (currently unused, kept for parity).
    pub cutoff_mult: f64,
    /// Restrict passivation to these atom indices (auto-detect if None).
    pub selected_indices: Option<Vec<usize>>,
    /// Valence-electron overrides per element.
    pub valence_electrons: Option<HashMap<String, f64>>,
    /// Manual bulk coordination overrides per element.
    pub bulk_coordination: Option<HashMap<String, usize>>,
}

impl Default for PassivateParams {
    fn default() -> Self {
        Self {
            passivate_top: false,
            passivate_bottom: true,
            surface_depth: 1.5,
            bond_length_scale: 1.0,
            cutoff_mult: 1.15,
            selected_indices: None,
            valence_electrons: None,
            bulk_coordination: None,
        }
    }
}

/// A single neighbor of a central atom (within the search list).
#[derive(Debug, Clone)]
struct Neighbor {
    symbol: String,
    distance: f64,
    /// Vector from center to neighbor (Cartesian).
    vector: Vector3<f64>,
}

/// Per-element bulk coordination environment.
#[derive(Debug, Clone)]
struct BulkCoordInfo {
    coordination: usize,
    neighbor_types: HashMap<String, usize>,
    /// Sample first-shell directions `(neighbor_symbol, vector)` from one atom.
    neighbor_directions_sample: Vec<(String, Vector3<f64>)>,
    first_shell_cutoff: f64,
}

/// Element symbol of a site (dominant species).
fn site_symbol(structure: &Structure, idx: usize) -> String {
    structure.site_occupancies[idx]
        .dominant_species()
        .element
        .symbol()
        .to_string()
}

/// Covalent radius of an element symbol (matches ASE/pymatgen Cordero data).
fn covalent_radius(symbol: &str) -> f64 {
    Element::from_symbol(symbol)
        .and_then(|e| e.covalent_radius())
        .unwrap_or(0.31) // fallback ~ H
}

/// Enumerate all neighbors of every atom using ASE `NeighborList` semantics:
/// atoms `i, j` (over periodic images) are neighbors iff
/// `d_ij <= per_atom_cutoff[i] + per_atom_cutoff[j]`.
///
/// `bothways = true`, `self_interaction = false`. Returns, for each center
/// atom, the full list of neighbors sorted by distance.
fn build_neighbor_lists(
    structure: &Structure,
    per_atom_cutoffs: &[f64],
) -> Vec<Vec<Neighbor>> {
    let n = structure.num_sites();
    let cart = structure.cart_coords();
    let lattice = &structure.lattice;
    let pbc = lattice.pbc;
    let matrix = lattice.matrix();
    let a_vec = Vector3::new(matrix[(0, 0)], matrix[(0, 1)], matrix[(0, 2)]);
    let b_vec = Vector3::new(matrix[(1, 0)], matrix[(1, 1)], matrix[(1, 2)]);
    let c_vec = Vector3::new(matrix[(2, 0)], matrix[(2, 1)], matrix[(2, 2)]);
    let lat_vecs = [a_vec, b_vec, c_vec];

    let max_cutoff = per_atom_cutoffs.iter().cloned().fold(0.0_f64, f64::max);
    let max_pair = 2.0 * max_cutoff;

    // Number of periodic images to search along each axis.
    let volume = lattice.volume().abs();
    let max_images: [i32; 3] = std::array::from_fn(|idx| {
        if !pbc[idx] || volume < 1e-12 {
            0
        } else {
            let cross = lat_vecs[(idx + 1) % 3].cross(&lat_vecs[(idx + 2) % 3]);
            let height = volume / cross.norm();
            (max_pair / height).ceil() as i32 + 1
        }
    });

    let mut result: Vec<Vec<Neighbor>> = vec![Vec::new(); n];

    for i in 0..n {
        let ci = &cart[i];
        let cut_i = per_atom_cutoffs[i];
        for j in 0..n {
            let cut_j = per_atom_cutoffs[j];
            let pair_cut = cut_i + cut_j;
            let pair_cut_sq = pair_cut * pair_cut;
            for da in -max_images[0]..=max_images[0] {
                for db in -max_images[1]..=max_images[1] {
                    for dc in -max_images[2]..=max_images[2] {
                        if i == j && da == 0 && db == 0 && dc == 0 {
                            continue; // self_interaction = false
                        }
                        let offset = (da as f64) * a_vec
                            + (db as f64) * b_vec
                            + (dc as f64) * c_vec;
                        let nbr = cart[j] + offset;
                        let vec = nbr - ci;
                        let d2 = vec.norm_squared();
                        if d2 <= pair_cut_sq && d2 > 1e-12 {
                            result[i].push(Neighbor {
                                symbol: site_symbol(structure, j),
                                distance: d2.sqrt(),
                                vector: vec,
                            });
                        }
                    }
                }
            }
        }
        result[i].sort_by(|a, b| a.distance.total_cmp(&b.distance));
    }

    result
}

/// Auto-detect first-shell cutoff via gap analysis. Mirrors `_detect_first_shell`.
fn detect_first_shell(all_neighbors: &[Vec<Neighbor>], indices: &[usize], gap_ratio: f64) -> f64 {
    let mut all_distances: Vec<f64> = Vec::new();
    for &idx in indices {
        for nbr in &all_neighbors[idx] {
            all_distances.push(nbr.distance);
        }
    }
    if all_distances.is_empty() {
        return 3.0;
    }
    all_distances.sort_by(|a, b| a.total_cmp(b));

    let mut unique_dists: Vec<f64> = vec![all_distances[0]];
    for &d in &all_distances[1..] {
        if d - *unique_dists.last().unwrap() > 0.01 {
            unique_dists.push(d);
        }
    }

    if unique_dists.len() < 2 {
        return unique_dists[0] * 1.1;
    }

    for i in 0..unique_dists.len() - 1 {
        let gap = unique_dists[i + 1] - unique_dists[i];
        let relative_gap = gap / unique_dists[i];
        if relative_gap > gap_ratio {
            return (unique_dists[i] + unique_dists[i + 1]) / 2.0;
        }
    }
    // No clear gap: fall back. (Python warns; we silently use 1.15x.)
    unique_dists[0] * 1.15
}

/// Find a cutoff that yields `target_cn` for the first atom. Mirrors `_get_cutoff_for_cn`.
fn cutoff_for_cn(neighbors: &[Neighbor], target_cn: usize) -> f64 {
    if neighbors.len() <= target_cn {
        return neighbors.last().map(|n| n.distance * 1.1).unwrap_or(3.0);
    }
    let d_in = neighbors[target_cn - 1].distance;
    let d_out = neighbors[target_cn].distance;
    (d_in + d_out) / 2.0
}

/// Analyze the bulk coordination environment per element. Mirrors `_analyze_bulk`.
fn analyze_bulk(
    bulk: &Structure,
    manual_coordination: &Option<HashMap<String, usize>>,
) -> HashMap<String, BulkCoordInfo> {
    let n = bulk.num_sites();
    // natural_cutoffs(mult=1.5): per-atom radius = covalent_radius * 1.5
    let cutoffs: Vec<f64> = (0..n)
        .map(|i| covalent_radius(&site_symbol(bulk, i)) * 1.5)
        .collect();
    let all_neighbors = build_neighbor_lists(bulk, &cutoffs);

    // Group atom indices by symbol.
    let mut by_symbol: HashMap<String, Vec<usize>> = HashMap::new();
    for i in 0..n {
        by_symbol.entry(site_symbol(bulk, i)).or_default().push(i);
    }

    let mut result: HashMap<String, BulkCoordInfo> = HashMap::new();
    for (sym, indices) in &by_symbol {
        let first_shell_cutoff = if let Some(manual) = manual_coordination {
            if let Some(&target_cn) = manual.get(sym) {
                cutoff_for_cn(&all_neighbors[indices[0]], target_cn)
            } else {
                detect_first_shell(&all_neighbors, indices, 0.15)
            }
        } else {
            detect_first_shell(&all_neighbors, indices, 0.15)
        };

        let mut coordinations: Vec<usize> = Vec::new();
        let mut all_neighbor_types: HashMap<String, usize> = HashMap::new();
        let mut sample_directions: Vec<(String, Vector3<f64>)> = Vec::new();

        for &idx in indices {
            let first_shell: Vec<&Neighbor> = all_neighbors[idx]
                .iter()
                .filter(|nbr| nbr.distance <= first_shell_cutoff)
                .collect();
            coordinations.push(first_shell.len());
            for nbr in &first_shell {
                *all_neighbor_types.entry(nbr.symbol.clone()).or_insert(0) += 1;
            }
            if sample_directions.is_empty() && !first_shell.is_empty() {
                sample_directions = first_shell
                    .iter()
                    .map(|nbr| (nbr.symbol.clone(), nbr.vector))
                    .collect();
            }
        }

        let avg_coord = if coordinations.is_empty() {
            0
        } else {
            let mean: f64 =
                coordinations.iter().map(|&c| c as f64).sum::<f64>() / coordinations.len() as f64;
            mean.round() as usize
        };
        let n_atoms = indices.len() as f64;
        let neighbor_types_avg: HashMap<String, usize> = all_neighbor_types
            .iter()
            .map(|(k, &v)| (k.clone(), (v as f64 / n_atoms).round() as usize))
            .collect();

        result.insert(
            sym.clone(),
            BulkCoordInfo {
                coordination: avg_coord,
                neighbor_types: neighbor_types_avg,
                neighbor_directions_sample: sample_directions,
                first_shell_cutoff,
            },
        );
    }

    result
}

/// Build per-atom slab cutoffs from bulk first-shell cutoffs (/2). Mirrors
/// `_build_slab_neighborlist`. Returns the per-atom cutoff slice.
fn slab_per_atom_cutoffs(
    slab: &Structure,
    bulk_info: &HashMap<String, BulkCoordInfo>,
) -> Vec<f64> {
    let n = slab.num_sites();
    let max_cutoff = bulk_info
        .values()
        .map(|info| info.first_shell_cutoff)
        .fold(3.0_f64, f64::max);
    (0..n)
        .map(|i| {
            let sym = site_symbol(slab, i);
            match bulk_info.get(&sym) {
                Some(info) => info.first_shell_cutoff / 2.0,
                None => max_cutoff / 2.0,
            }
        })
        .collect()
}

/// Count first-shell neighbors for an atom, filtering by element type and
/// bulk first-shell cutoff. Mirrors `_count_first_shell_neighbors`.
fn count_first_shell_neighbors(
    slab: &Structure,
    atom_idx: usize,
    slab_neighbors: &[Vec<Neighbor>],
    bulk_info: &HashMap<String, BulkCoordInfo>,
) -> usize {
    let sym = site_symbol(slab, atom_idx);
    let info = match bulk_info.get(&sym) {
        Some(i) => i,
        None => return 0,
    };
    let cutoff = info.first_shell_cutoff;
    slab_neighbors[atom_idx]
        .iter()
        .filter(|nbr| info.neighbor_types.contains_key(&nbr.symbol) && nbr.distance <= cutoff)
        .count()
}

/// A unit vector perpendicular to `vec`. Mirrors `_get_perpendicular`.
fn perpendicular(vec: &Vector3<f64>) -> Vector3<f64> {
    let perp = if vec[0].abs() < 0.9 {
        vec.cross(&Vector3::new(1.0, 0.0, 0.0))
    } else {
        vec.cross(&Vector3::new(0.0, 1.0, 0.0))
    };
    perp / perp.norm()
}

/// Greedy generation of missing directions/elements. Mirrors
/// `_greedy_match_directions`.
fn greedy_match_directions(
    slab: &Structure,
    atom_idx: usize,
    side: &str,
    current_vecs: &[Vector3<f64>],
    slab_neighbors: &[Vec<Neighbor>],
    bulk_info: &HashMap<String, BulkCoordInfo>,
) -> Vec<(Vector3<f64>, String)> {
    let sym = site_symbol(slab, atom_idx);
    let info = &bulk_info[&sym];
    let expected_cn = info.coordination;
    let actual_cn = current_vecs.len();
    if actual_cn >= expected_cn {
        return Vec::new();
    }
    let n_missing = expected_cn - actual_cn;

    // Geometric inference from existing neighbors.
    let mut base_missing_dir;
    if !current_vecs.is_empty() {
        let mut avg = Vector3::zeros();
        for v in current_vecs {
            avg += *v;
        }
        avg /= current_vecs.len() as f64;
        let norm = avg.norm();
        if norm > 0.1 {
            avg /= norm;
            base_missing_dir = -avg;
        } else if side == "bottom" {
            base_missing_dir = Vector3::new(0.0, 0.0, -1.0);
        } else {
            base_missing_dir = Vector3::new(0.0, 0.0, 1.0);
        }
    } else if side == "bottom" {
        base_missing_dir = Vector3::new(0.0, 0.0, -1.0);
    } else {
        base_missing_dir = Vector3::new(0.0, 0.0, 1.0);
    }
    // Normalize for safety (Python uses it as-is; avg/-avg already unit).
    let bn = base_missing_dir.norm();
    if bn > 1e-12 {
        base_missing_dir /= bn;
    }

    // Determine missing element types from current vs expected neighbor counts.
    let mut current_neighbor_types: HashMap<String, usize> = HashMap::new();
    for nbr in &slab_neighbors[atom_idx] {
        *current_neighbor_types.entry(nbr.symbol.clone()).or_insert(0) += 1;
    }
    let expected_neighbor_types = &info.neighbor_types;

    let mut missing_elements: Vec<String> = Vec::new();
    // Iterate in a deterministic order matching dict insertion is not
    // guaranteed in Python, but the final placement only depends on the
    // multiset of missing elements for n_missing<=1 (single direction) and
    // on symmetric cones otherwise; we sort for determinism.
    let mut keys: Vec<&String> = expected_neighbor_types.keys().collect();
    keys.sort();
    for ns in &keys {
        let expected_count = expected_neighbor_types[*ns];
        let actual_count = *current_neighbor_types.get(*ns).unwrap_or(&0);
        if expected_count > actual_count {
            for _ in 0..(expected_count - actual_count) {
                missing_elements.push((*ns).clone());
            }
        }
    }
    // Pad with the most common expected type.
    while missing_elements.len() < n_missing {
        let most_common = expected_neighbor_types
            .iter()
            .max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0)))
            .map(|(k, _)| k.clone())
            .unwrap_or_else(|| "H".to_string());
        missing_elements.push(most_common);
    }

    let mut out: Vec<(Vector3<f64>, String)> = Vec::new();
    if n_missing == 1 {
        out.push((base_missing_dir, missing_elements[0].clone()));
    } else if n_missing == 2 {
        let perp = perpendicular(&base_missing_dir);
        let angle = (30.0_f64).to_radians();
        let d1 = base_missing_dir * angle.cos() + perp * angle.sin();
        let d2 = base_missing_dir * angle.cos() - perp * angle.sin();
        out.push((d1 / d1.norm(), missing_elements[0].clone()));
        out.push((d2 / d2.norm(), missing_elements[1].clone()));
    } else {
        let perp1 = perpendicular(&base_missing_dir);
        let mut perp2 = base_missing_dir.cross(&perp1);
        perp2 /= perp2.norm();
        let cone_angle = (30.0_f64).to_radians();
        for k in 0..n_missing {
            let phi = 2.0 * std::f64::consts::PI * (k as f64) / (n_missing as f64);
            let mut direction = base_missing_dir * cone_angle.cos()
                + perp1 * cone_angle.sin() * phi.cos()
                + perp2 * cone_angle.sin() * phi.sin();
            direction /= direction.norm();
            let elem = if k < missing_elements.len() {
                missing_elements[k].clone()
            } else {
                missing_elements.last().unwrap().clone()
            };
            out.push((direction, elem));
        }
    }
    out
}

/// Compute missing bond directions for a surface atom. Mirrors
/// `_compute_missing_directions`.
fn compute_missing_directions(
    slab: &Structure,
    atom_idx: usize,
    side: &str,
    slab_neighbors: &[Vec<Neighbor>],
    bulk_info: &HashMap<String, BulkCoordInfo>,
) -> Vec<(Vector3<f64>, String)> {
    let sym = site_symbol(slab, atom_idx);
    let info = &bulk_info[&sym];

    let current_vecs: Vec<Vector3<f64>> = slab_neighbors[atom_idx]
        .iter()
        .map(|nbr| nbr.vector / nbr.vector.norm())
        .collect();

    if current_vecs.is_empty() {
        // Use reference directions, flipping z by side.
        let mut missing = Vec::new();
        for (ns, ref_vec) in &info.neighbor_directions_sample {
            let mut direction = ref_vec / ref_vec.norm();
            if side == "bottom" {
                direction[2] = -direction[2].abs();
            } else if side == "top" {
                direction[2] = direction[2].abs();
            }
            missing.push((direction, ns.clone()));
        }
        return missing;
    }

    greedy_match_directions(slab, atom_idx, side, &current_vecs, slab_neighbors, bulk_info)
}

/// Validate `V_A/N_A + V_B/N_B ≈ 2`. Mirrors `_validate_bond_electrons`.
fn validate_bond_electrons(
    bulk_info: &HashMap<String, BulkCoordInfo>,
    valence: &HashMap<String, f64>,
) -> Vec<String> {
    let mut warnings = Vec::new();
    let mut checked: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    let mut syms: Vec<&String> = bulk_info.keys().collect();
    syms.sort();
    for sym_a in syms {
        let info_a = &bulk_info[sym_a];
        let v_a = match valence.get(sym_a) {
            Some(v) => *v,
            None => continue,
        };
        let n_a = info_a.coordination;
        if n_a == 0 {
            continue;
        }
        let mut nts: Vec<&String> = info_a.neighbor_types.keys().collect();
        nts.sort();
        for sym_b in nts {
            let mut pair = [sym_a.clone(), sym_b.clone()];
            pair.sort();
            let key = (pair[0].clone(), pair[1].clone());
            if checked.contains(&key) {
                continue;
            }
            checked.insert(key);
            let info_b = match bulk_info.get(sym_b) {
                Some(i) => i,
                None => continue,
            };
            let v_b = match valence.get(sym_b) {
                Some(v) => *v,
                None => continue,
            };
            let n_b = info_b.coordination;
            if n_b == 0 {
                continue;
            }
            let e_per_bond = v_a / n_a as f64 + v_b / n_b as f64;
            if (e_per_bond - 2.0).abs() > 0.15 {
                warnings.push(format!(
                    "{sym_a}(V={v_a},N={n_a})-{sym_b}(V={v_b},N={n_b}): e/bond={e_per_bond:.2} != 2.00. Check valence_electrons or bulk_coordination."
                ));
            }
        }
    }
    warnings
}

/// Compute pseudo-H charge `Z_H = V_missing / N_missing`. Mirrors
/// `_compute_pseudo_h_charge`. Returns (exact, vasp, potcar).
fn compute_pseudo_h_charge(
    missing_symbol: &str,
    bulk_info: &HashMap<String, BulkCoordInfo>,
    valence: &HashMap<String, f64>,
) -> (f64, f64, String) {
    let v = match valence.get(missing_symbol) {
        Some(v) => *v,
        None => return (1.0, 1.0, "H".to_string()),
    };
    let info = match bulk_info.get(missing_symbol) {
        Some(i) => i,
        None => return (1.0, 1.0, "H".to_string()),
    };
    let n = info.coordination;
    if n == 0 {
        return (1.0, 1.0, "H".to_string());
    }
    let exact = v / n as f64;
    let vasp = VASP_PSEUDO_H_CHARGES
        .iter()
        .cloned()
        .min_by(|a, b| (a - exact).abs().total_cmp(&(b - exact).abs()))
        .unwrap();
    let potcar = vasp_potcar_name(vasp);
    (exact, vasp, potcar)
}

/// Pseudo-H bond length = `(r_parent + r_H) * scale`. Mirrors `_get_bond_length`.
fn bond_length(parent_symbol: &str, scale: f64) -> f64 {
    let r_parent = covalent_radius(parent_symbol);
    let r_h = covalent_radius("H");
    (r_parent + r_h) * scale
}

/// Identify undercoordinated surface atoms. Mirrors `_identify_surface_atoms`.
fn identify_surface_atoms(
    slab: &Structure,
    slab_neighbors: &[Vec<Neighbor>],
    bulk_info: &HashMap<String, BulkCoordInfo>,
    params: &PassivateParams,
) -> Vec<(usize, String)> {
    let n = slab.num_sites();
    let cart = slab.cart_coords();
    let z_coords: Vec<f64> = cart.iter().map(|p| p[2]).collect();
    let z_min = z_coords.iter().cloned().fold(f64::INFINITY, f64::min);
    let z_max = z_coords.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

    let mut surface_atoms = Vec::new();
    for i in 0..n {
        let sym = site_symbol(slab, i);
        let info = match bulk_info.get(&sym) {
            Some(x) => x,
            None => continue,
        };
        let expected_cn = info.coordination;
        let actual_cn = count_first_shell_neighbors(slab, i, slab_neighbors, bulk_info);
        if actual_cn >= expected_cn {
            continue;
        }
        let z = z_coords[i];
        let is_bottom = (z - z_min) < params.surface_depth;
        let is_top = (z_max - z) < params.surface_depth;
        if is_bottom && params.passivate_bottom {
            surface_atoms.push((i, "bottom".to_string()));
        } else if is_top && params.passivate_top {
            surface_atoms.push((i, "top".to_string()));
        }
    }
    surface_atoms
}

/// Run pseudo-hydrogen passivation. Faithful port of `SlabPassivator.passivate`.
pub fn passivate(
    bulk: &Structure,
    slab: &Structure,
    params: &PassivateParams,
) -> Result<PassivationResult, String> {
    // Merge valence table.
    let mut valence: HashMap<String, f64> = HashMap::new();
    // Seed with defaults for all elements present in bulk & slab.
    for i in 0..bulk.num_sites() {
        let s = site_symbol(bulk, i);
        if let Some(v) = default_valence(&s) {
            valence.insert(s, v);
        }
    }
    for i in 0..slab.num_sites() {
        let s = site_symbol(slab, i);
        if let Some(v) = default_valence(&s) {
            valence.entry(s).or_insert(v);
        }
    }
    if let Some(overrides) = &params.valence_electrons {
        for (k, v) in overrides {
            valence.insert(k.clone(), *v);
        }
    }

    // 1. Analyze bulk.
    let bulk_info = analyze_bulk(bulk, &params.bulk_coordination);

    // 2. Validate bond electrons.
    let bond_warnings = validate_bond_electrons(&bulk_info, &valence);

    // 3. Build slab neighbor list (per-atom cutoffs from bulk).
    let slab_cutoffs = slab_per_atom_cutoffs(slab, &bulk_info);
    let slab_neighbors = build_neighbor_lists(slab, &slab_cutoffs);

    // 4. Determine atoms to passivate.
    let atoms_to_passivate: Vec<(usize, String)> = if let Some(selected) = &params.selected_indices
    {
        let cart = slab.cart_coords();
        let z_coords: Vec<f64> = cart.iter().map(|p| p[2]).collect();
        let z_min = z_coords.iter().cloned().fold(f64::INFINITY, f64::min);
        let z_max = z_coords.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let z_mid = (z_min + z_max) / 2.0;
        let mut out = Vec::new();
        for &idx in selected {
            if idx >= slab.num_sites() {
                continue;
            }
            let sym = site_symbol(slab, idx);
            let info = match bulk_info.get(&sym) {
                Some(x) => x,
                None => continue,
            };
            let expected_cn = info.coordination;
            let actual_cn = count_first_shell_neighbors(slab, idx, &slab_neighbors, &bulk_info);
            if actual_cn >= expected_cn {
                continue;
            }
            let side = if z_coords[idx] < z_mid { "bottom" } else { "top" };
            out.push((idx, side.to_string()));
        }
        out
    } else {
        identify_surface_atoms(slab, &slab_neighbors, &bulk_info, params)
    };

    // 5. Place pseudo-H for each undercoordinated atom.
    let slab_cart = slab.cart_coords();
    let mut pseudo_h_list: Vec<PseudoHInfo> = Vec::new();
    for (atom_idx, side) in &atoms_to_passivate {
        let sym = site_symbol(slab, *atom_idx);
        let missing_directions =
            compute_missing_directions(slab, *atom_idx, side, &slab_neighbors, &bulk_info);
        for (direction, missing_sym) in missing_directions {
            let (exact_charge, vasp_charge, potcar) =
                compute_pseudo_h_charge(&missing_sym, &bulk_info, &valence);
            let bl = bond_length(&sym, params.bond_length_scale);
            let h_pos = slab_cart[*atom_idx] + bl * direction;
            pseudo_h_list.push(PseudoHInfo {
                position: h_pos,
                charge: exact_charge,
                vasp_charge,
                potcar_name: potcar,
                parent_index: *atom_idx,
                parent_symbol: sym.clone(),
                missing_symbol: missing_sym,
                bond_direction: direction,
            });
        }
    }

    // 6. Build passivated slab: append H grouped by vasp_charge (sorted).
    let mut charge_groups: std::collections::BTreeMap<i64, Vec<usize>> =
        std::collections::BTreeMap::new();
    // Key by rounded charge*1e6 to preserve sort order deterministically.
    for (i, h) in pseudo_h_list.iter().enumerate() {
        let key = (h.vasp_charge * 1.0e6).round() as i64;
        charge_groups.entry(key).or_default().push(i);
    }

    let mut new_occupancies = slab.site_occupancies.clone();
    let mut new_frac = slab.frac_coords.clone();
    let h_element = Element::from_symbol("H").unwrap();

    for (_charge_key, h_indices) in &charge_groups {
        for &hi in h_indices {
            let h = &pseudo_h_list[hi];
            // Cartesian -> fractional via lattice.
            let frac = slab
                .lattice
                .get_fractional_coords(std::slice::from_ref(&h.position))[0];
            let mut props: HashMap<String, serde_json::Value> = HashMap::new();
            props.insert(
                "selective_dynamics".to_string(),
                serde_json::json!([false, false, false]),
            );
            props.insert(
                "pseudo_h_potcar".to_string(),
                serde_json::json!(h.potcar_name),
            );
            props.insert(
                "pseudo_h_charge".to_string(),
                serde_json::json!(h.vasp_charge),
            );
            let mut occ = crate::species::SiteOccupancy::ordered(crate::species::Species::neutral(
                h_element,
            ));
            occ.properties = props;
            new_occupancies.push(occ);
            new_frac.push(frac);
        }
    }

    let passivated = Structure::try_new_from_occupancies_with_properties(
        slab.lattice.clone(),
        new_occupancies,
        new_frac,
        slab.properties.clone(),
    )
    .map_err(|e| e.to_string())?;

    // 7. Build result fields.
    let bulk_coordination: HashMap<String, usize> = bulk_info
        .iter()
        .map(|(s, info)| (s.clone(), info.coordination))
        .collect();
    let mut unique_potcars: Vec<String> = pseudo_h_list
        .iter()
        .map(|h| h.potcar_name.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    unique_potcars.sort();
    let valence_used: HashMap<String, f64> = bulk_info
        .keys()
        .map(|s| (s.clone(), valence.get(s).cloned().unwrap_or(0.0)))
        .collect();

    Ok(PassivationResult {
        slab: passivated,
        pseudo_h_list,
        bulk_coordination,
        unique_potcars,
        valence_used,
        bond_warnings,
    })
}

//! CrystalNN — Voronoi-based near-neighbor analysis for crystal structures.
//!
//! A Rust port of pymatgen's `CrystalNN` class.  Uses solid-angle weights from
//! Voronoi tessellation combined with distance cutoffs, electronegativity
//! weighting, and porous-structure adjustment to determine coordination
//! environments.
//!
//! Works on all targets including `wasm32-unknown-unknown` (no C FFI).
//!
//! # Reference
//!
//! Zimmermann & Jain, *Acta Cryst.* (2020) **B76**, 7–10.
//! <https://doi.org/10.1107/S2052520619016044>

use crate::neighbors::{NeighborListConfig, build_neighbor_list};
use crate::species::Species;
use crate::structure::Structure;
use crate::voronoi_cell::{build_voronoi_cell, facet_props};
use nalgebra::Vector3;
use std::collections::BTreeMap;
use std::f64::consts::PI;

// ── Configuration ─────────────────────────────────────────────────

/// Configuration for CrystalNN analysis (matches pymatgen defaults).
#[derive(Debug, Clone)]
pub struct CrystalNNConfig {
    /// Return fractional weights for each neighbor instead of the most probable
    /// coordination shell with weight = 1.
    pub weighted_cn: bool,
    /// Restrict bonding targets to opposite-charge sites (requires oxidation states).
    pub cation_anion: bool,
    /// Smooth distance penalty relative to the sum of covalent/ionic radii.
    ///
    /// - `dist ≤ r₁+r₂ + low`  →  weight = 1
    /// - `dist ≥ r₁+r₂ + high` →  weight = 0
    /// - in between             →  cosine interpolation
    ///
    /// `None` disables the penalty.
    pub distance_cutoffs: Option<(f64, f64)>,
    /// Electronegativity-difference bonus factor.
    /// `weight *= 1 + x_diff_weight · √(|ΔX|/3.3)`
    pub x_diff_weight: f64,
    /// Multiply weight by `solid_angle / area` to down-weight large void-facing
    /// Voronoi faces in layered / porous structures.
    pub porous_adjustment: bool,
    /// Initial neighbor-search cutoff (Å).  Internally expanded if necessary.
    pub search_cutoff: f64,
    /// Pad the coordination-number fingerprint to this length if set.
    pub fingerprint_length: Option<usize>,
}

impl Default for CrystalNNConfig {
    fn default() -> Self {
        Self {
            weighted_cn: false,
            cation_anion: false,
            distance_cutoffs: Some((0.5, 1.0)),
            x_diff_weight: 3.0,
            porous_adjustment: true,
            search_cutoff: 7.0,
            fingerprint_length: None,
        }
    }
}

// ── Result types ──────────────────────────────────────────────────

/// Information about a near neighbor.
#[derive(Debug, Clone)]
pub struct NNInfo {
    /// Site index in the original structure.
    pub site_idx: usize,
    /// Species at the neighbor site.
    pub species: Species,
    /// Periodic image offset `[da, db, dc]`.
    pub image: [i32; 3],
    /// Weight (0–1).
    pub weight: f64,
    /// Distance from center to neighbor (Å).
    pub distance: f64,
}

/// Full CrystalNN result for one site.
#[derive(Debug, Clone)]
pub struct NNData {
    /// All neighbors with their weights (sorted descending).
    pub all_nninfo: Vec<NNInfo>,
    /// Coordination number → probability.
    pub cn_weights: BTreeMap<usize, f64>,
    /// Coordination number → neighbor list for that CN.
    pub cn_nninfo: BTreeMap<usize, Vec<NNInfo>>,
}

// ── Public API ────────────────────────────────────────────────────

/// Compute the full CrystalNN data for site `site_idx`.
///
/// This is the main entry point implementing the 7-step pymatgen pipeline:
///
/// 1. Voronoi tessellation → raw solid-angle weights
/// 2. Porous adjustment
/// 3. Electronegativity weighting
/// 4. Re-normalise to max = 1
/// 5. Smooth distance cutoff
/// 6. Identify distinct weight bins
/// 7. CN probability via semicircle integral
pub fn get_nn_data(
    structure: &Structure,
    site_idx: usize,
    config: &CrystalNNConfig,
) -> NNData {
    assert!(
        site_idx < structure.num_sites(),
        "site_idx {site_idx} out of bounds (num_sites={})",
        structure.num_sites()
    );

    // ── Step 0 : gather neighbours & build Voronoi cell ──────────

    let nl = build_neighbor_list(
        structure,
        &NeighborListConfig {
            cutoff: config.search_cutoff,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        },
    );

    // Collect all (site, image, cart_pos, distance) pairs for this center.
    struct Neighbor {
        site_idx: usize,
        species: Species,
        image: [i32; 3],
        distance: f64,
        cart: Vector3<f64>,
    }

    let center_frac = &structure.frac_coords[site_idx];
    let center_cart = structure.lattice.get_cartesian_coord(center_frac);

    let center_species = structure.site_occupancies[site_idx].dominant_species();

    let mut neighbors: Vec<Neighbor> = Vec::new();
    for (pair_idx, &center) in nl.center_indices.iter().enumerate() {
        if center != site_idx {
            continue;
        }
        let n_idx = nl.neighbor_indices[pair_idx];
        let image = nl.images[pair_idx];
        let species = *structure.site_occupancies[n_idx].dominant_species();

        // Cation-anion filter.
        if config.cation_anion {
            let c_oxi = center_species.oxidation_state.unwrap_or(0) as i16;
            let n_oxi = species.oxidation_state.unwrap_or(0) as i16;
            if c_oxi != 0 && n_oxi != 0 && c_oxi * n_oxi > 0 {
                continue;
            }
        }

        let n_frac = structure.frac_coords[n_idx]
            + Vector3::new(image[0] as f64, image[1] as f64, image[2] as f64);
        let n_cart = structure.lattice.get_cartesian_coord(&n_frac);

        neighbors.push(Neighbor {
            site_idx: n_idx,
            species,
            image,
            distance: nl.distances[pair_idx],
            cart: n_cart,
        });
    }

    if neighbors.is_empty() {
        return empty_nn_data();
    }

    // Build the Voronoi cell of the center atom.
    let neighbor_carts: Vec<Vector3<f64>> = neighbors.iter().map(|n| n.cart).collect();
    let voronoi = build_voronoi_cell(&center_cart, &neighbor_carts);

    // ── Step 1 : extract solid-angle weights ─────────────────────

    // Internal struct to carry weight + poly info through the pipeline.
    struct Weighted {
        info: NNInfo,
        solid_angle: f64,
        area: f64,
    }

    let mut nn: Vec<Weighted> = voronoi
        .facets
        .iter()
        .filter_map(|facet| {
            let idx = facet.neighbor_idx?;
            if idx >= neighbors.len() {
                return None;
            }
            let nb = &neighbors[idx];
            let props = facet_props(&center_cart, &nb.cart, facet);
            Some(Weighted {
                info: NNInfo {
                    site_idx: nb.site_idx,
                    species: nb.species,
                    image: nb.image,
                    weight: props.solid_angle,
                    distance: nb.distance,
                },
                solid_angle: props.solid_angle,
                area: props.area,
            })
        })
        .collect();

    if nn.is_empty() {
        return empty_nn_data();
    }

    // VoronoiNN normalization: divide by max solid angle.
    let max_sa = nn.iter().map(|w| w.info.weight).fold(0.0_f64, f64::max);
    if max_sa > 0.0 {
        for w in &mut nn {
            w.info.weight /= max_sa;
        }
    }

    // ── Step 2 : porous adjustment ───────────────────────────────
    if config.porous_adjustment {
        for w in &mut nn {
            if w.area > 1e-15 {
                w.info.weight *= w.solid_angle / w.area;
            }
        }
    }

    // ── Step 3 : electronegativity weighting ─────────────────────
    if config.x_diff_weight > 0.0 {
        let x1 = center_species.element.electronegativity();
        for w in &mut nn {
            let x2 = w.info.species.element.electronegativity();
            if let (Some(x1), Some(x2)) = (x1, x2) {
                if x1.is_finite() && x2.is_finite() {
                    let bonus = 1.0 + config.x_diff_weight * ((x1 - x2).abs() / 3.3).sqrt();
                    w.info.weight *= bonus;
                }
            }
        }
    }

    // Sort descending by weight.
    nn.sort_by(|a, b| b.info.weight.total_cmp(&a.info.weight));
    if nn[0].info.weight == 0.0 {
        return empty_nn_data();
    }

    // ── Step 4 : re-normalise so max = 1 ─────────────────────────
    let max_w = nn[0].info.weight;
    for w in &mut nn {
        w.info.weight /= max_w;
    }

    // ── Step 5 : smooth distance cutoff ──────────────────────────
    if let Some((low, high)) = config.distance_cutoffs {
        let r1 = get_radius(center_species);
        for w in &mut nn {
            let r2 = get_radius(&w.info.species);
            let diameter = if r1 > 0.0 && r2 > 0.0 {
                r1 + r2
            } else {
                default_radius(center_species) + default_radius(&w.info.species)
            };
            let lo = diameter + low;
            let hi = diameter + high;
            let dw = if w.info.distance <= lo {
                1.0
            } else if w.info.distance < hi {
                ((w.info.distance - lo) / (hi - lo) * PI).cos() * 0.5 + 0.5
            } else {
                0.0
            };
            w.info.weight *= dw;
        }
    }

    // Sort again, round to 3 decimals, drop zeros.
    nn.sort_by(|a, b| b.info.weight.total_cmp(&a.info.weight));
    if nn[0].info.weight == 0.0 {
        return empty_nn_data();
    }
    for w in &mut nn {
        w.info.weight = (w.info.weight * 1000.0).round() / 1000.0;
    }
    nn.retain(|w| w.info.weight > 0.0);

    // ── Step 6 : transition distances (distinct weight bins) ─────
    let mut dist_bins: Vec<f64> = Vec::new();
    for w in &nn {
        if dist_bins.last() != Some(&w.info.weight) {
            dist_bins.push(w.info.weight);
        }
    }
    dist_bins.push(0.0);

    // ── Step 7 : CN probability via semicircle integral ──────────
    let mut cn_weights = BTreeMap::new();
    let mut cn_nninfo: BTreeMap<usize, Vec<NNInfo>> = BTreeMap::new();

    for (idx, &val) in dist_bins.iter().enumerate() {
        if val == 0.0 {
            continue;
        }
        let above: Vec<NNInfo> = nn
            .iter()
            .filter(|w| w.info.weight >= val)
            .map(|w| w.info.clone())
            .collect();
        let cn = above.len();
        cn_nninfo.insert(cn, above);
        cn_weights.insert(cn, semicircle_integral(&dist_bins, idx));
    }

    // CN = 0 absorbs remaining probability.
    let total: f64 = cn_weights.values().sum();
    if total < 1.0 - 1e-12 {
        cn_weights.insert(0, 1.0 - total);
        cn_nninfo.entry(0).or_default();
    }

    // Optional fingerprint padding.
    if let Some(len) = config.fingerprint_length {
        for cn in 0..len {
            cn_weights.entry(cn).or_insert(0.0);
            cn_nninfo.entry(cn).or_default();
        }
    }

    let all_nninfo: Vec<NNInfo> = nn.into_iter().map(|w| w.info).collect();
    NNData {
        all_nninfo,
        cn_weights,
        cn_nninfo,
    }
}

/// Get the neighbor list for one site.
///
/// When `weighted_cn` is **false** (default): returns the most-probable
/// coordination shell with all weights set to 1.
///
/// When **true**: each neighbor's weight is the sum of CN probabilities
/// that include it.
pub fn get_nn_info(
    structure: &Structure,
    site_idx: usize,
    config: &CrystalNNConfig,
) -> Vec<NNInfo> {
    let data = get_nn_data(structure, site_idx, config);

    if !config.weighted_cn {
        let best_cn = data
            .cn_weights
            .iter()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(&cn, _)| cn)
            .unwrap_or(0);
        let mut result = data.cn_nninfo.get(&best_cn).cloned().unwrap_or_default();
        for info in &mut result {
            info.weight = 1.0;
        }
        return result;
    }

    // Weighted mode: weight = Σ P(CN) for every CN that includes this neighbor.
    let mut result = data.all_nninfo;
    for info in &mut result {
        let mut w = 0.0;
        for (&cn, &cn_w) in &data.cn_weights {
            if let Some(cn_nn) = data.cn_nninfo.get(&cn) {
                if cn_nn
                    .iter()
                    .any(|n| n.site_idx == info.site_idx && n.image == info.image)
                {
                    w += cn_w;
                }
            }
        }
        info.weight = w;
    }
    result
}

/// Get the coordination number for one site.
pub fn get_cn(structure: &Structure, site_idx: usize, config: &CrystalNNConfig) -> f64 {
    if config.weighted_cn {
        get_nn_info(structure, site_idx, config)
            .iter()
            .map(|n| n.weight)
            .sum()
    } else {
        get_nn_info(structure, site_idx, config).len() as f64
    }
}

/// Get near-neighbor info for every site.
///
/// Builds the neighbor list **once** and reuses it for all sites.
/// This is O(n² + n·k²) instead of O(n³) from calling `get_nn_info` per site.
pub fn get_all_nn_info(structure: &Structure, config: &CrystalNNConfig) -> Vec<Vec<NNInfo>> {
    let nl = build_neighbor_list(
        structure,
        &NeighborListConfig {
            cutoff: config.search_cutoff,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        },
    );
    (0..structure.num_sites())
        .map(|i| {
            let data = get_nn_data_with_nl(structure, i, config, &nl);
            extract_nn_info(data, config)
        })
        .collect()
}

/// Internal: run the CrystalNN pipeline for one site using a prebuilt neighbor list.
fn get_nn_data_with_nl(
    structure: &Structure,
    site_idx: usize,
    config: &CrystalNNConfig,
    nl: &crate::neighbors::NeighborList,
) -> NNData {
    if site_idx >= structure.num_sites() {
        return empty_nn_data();
    }

    struct Neighbor {
        site_idx: usize,
        species: Species,
        image: [i32; 3],
        distance: f64,
        cart: Vector3<f64>,
    }

    let center_frac = &structure.frac_coords[site_idx];
    let center_cart = structure.lattice.get_cartesian_coord(center_frac);
    let center_species = structure.site_occupancies[site_idx].dominant_species();

    let mut neighbors: Vec<Neighbor> = Vec::new();
    for (pair_idx, &center) in nl.center_indices.iter().enumerate() {
        if center != site_idx {
            continue;
        }
        let n_idx = nl.neighbor_indices[pair_idx];
        let image = nl.images[pair_idx];
        let species = *structure.site_occupancies[n_idx].dominant_species();

        if config.cation_anion {
            let c_oxi = center_species.oxidation_state.unwrap_or(0) as i16;
            let n_oxi = species.oxidation_state.unwrap_or(0) as i16;
            if c_oxi != 0 && n_oxi != 0 && c_oxi * n_oxi > 0 {
                continue;
            }
        }

        let n_frac = structure.frac_coords[n_idx]
            + Vector3::new(image[0] as f64, image[1] as f64, image[2] as f64);
        let n_cart = structure.lattice.get_cartesian_coord(&n_frac);

        neighbors.push(Neighbor {
            site_idx: n_idx,
            species,
            image,
            distance: nl.distances[pair_idx],
            cart: n_cart,
        });
    }

    if neighbors.is_empty() {
        return empty_nn_data();
    }

    // Build Voronoi cell + pipeline (steps 1-7) — same as get_nn_data
    let neighbor_carts: Vec<Vector3<f64>> = neighbors.iter().map(|n| n.cart).collect();
    let voronoi = build_voronoi_cell(&center_cart, &neighbor_carts);

    struct Weighted { info: NNInfo, solid_angle: f64, area: f64 }

    let mut nn: Vec<Weighted> = voronoi
        .facets
        .iter()
        .filter_map(|facet| {
            let idx = facet.neighbor_idx?;
            if idx >= neighbors.len() { return None; }
            let nb = &neighbors[idx];
            let props = facet_props(&center_cart, &nb.cart, facet);
            Some(Weighted {
                info: NNInfo {
                    site_idx: nb.site_idx, species: nb.species, image: nb.image,
                    weight: props.solid_angle, distance: nb.distance,
                },
                solid_angle: props.solid_angle, area: props.area,
            })
        })
        .collect();

    if nn.is_empty() { return empty_nn_data(); }

    // VoronoiNN normalization
    let max_sa = nn.iter().map(|w| w.info.weight).fold(0.0_f64, f64::max);
    if max_sa > 0.0 { for w in &mut nn { w.info.weight /= max_sa; } }

    // Step 2: porous adjustment
    if config.porous_adjustment {
        for w in &mut nn {
            if w.area > 1e-15 { w.info.weight *= w.solid_angle / w.area; }
        }
    }

    // Step 3: electronegativity weighting
    if config.x_diff_weight > 0.0 {
        let x1 = center_species.element.electronegativity();
        for w in &mut nn {
            let x2 = w.info.species.element.electronegativity();
            if let (Some(x1), Some(x2)) = (x1, x2) {
                if x1.is_finite() && x2.is_finite() {
                    let bonus = 1.0 + config.x_diff_weight * ((x1 - x2).abs() / 3.3).sqrt();
                    w.info.weight *= bonus;
                }
            }
        }
    }

    nn.sort_by(|a, b| b.info.weight.total_cmp(&a.info.weight));
    if nn[0].info.weight == 0.0 { return empty_nn_data(); }

    // Step 4: renormalize
    let max_w = nn[0].info.weight;
    for w in &mut nn { w.info.weight /= max_w; }

    // Step 5: distance cutoff
    if let Some((low, high)) = config.distance_cutoffs {
        let r1 = get_radius(center_species);
        for w in &mut nn {
            let r2 = get_radius(&w.info.species);
            let diameter = if r1 > 0.0 && r2 > 0.0 { r1 + r2 } else {
                default_radius(center_species) + default_radius(&w.info.species)
            };
            let lo = diameter + low;
            let hi = diameter + high;
            let dw = if w.info.distance <= lo { 1.0 }
                else if w.info.distance < hi { ((w.info.distance - lo) / (hi - lo) * PI).cos() * 0.5 + 0.5 }
                else { 0.0 };
            w.info.weight *= dw;
        }
    }

    nn.sort_by(|a, b| b.info.weight.total_cmp(&a.info.weight));
    if nn[0].info.weight == 0.0 { return empty_nn_data(); }
    for w in &mut nn { w.info.weight = (w.info.weight * 1000.0).round() / 1000.0; }
    nn.retain(|w| w.info.weight > 0.0);

    // Steps 6-7: weight bins + semicircle integral
    let mut dist_bins: Vec<f64> = Vec::new();
    for w in &nn { if dist_bins.last() != Some(&w.info.weight) { dist_bins.push(w.info.weight); } }
    dist_bins.push(0.0);

    let mut cn_weights = BTreeMap::new();
    let mut cn_nninfo: BTreeMap<usize, Vec<NNInfo>> = BTreeMap::new();
    for (idx, &val) in dist_bins.iter().enumerate() {
        if val == 0.0 { continue; }
        let above: Vec<NNInfo> = nn.iter().filter(|w| w.info.weight >= val).map(|w| w.info.clone()).collect();
        let cn = above.len();
        cn_nninfo.insert(cn, above);
        cn_weights.insert(cn, semicircle_integral(&dist_bins, idx));
    }
    let total: f64 = cn_weights.values().sum();
    if total < 1.0 - 1e-12 {
        cn_weights.insert(0, 1.0 - total);
        cn_nninfo.entry(0).or_default();
    }
    if let Some(len) = config.fingerprint_length {
        for cn in 0..len { cn_weights.entry(cn).or_insert(0.0); cn_nninfo.entry(cn).or_default(); }
    }

    NNData { all_nninfo: nn.into_iter().map(|w| w.info).collect(), cn_weights, cn_nninfo }
}

/// Extract nn_info from NNData (shared logic for get_nn_info and get_all_nn_info).
fn extract_nn_info(data: NNData, config: &CrystalNNConfig) -> Vec<NNInfo> {
    if !config.weighted_cn {
        let best_cn = data.cn_weights.iter().max_by(|a, b| a.1.total_cmp(b.1)).map(|(&cn, _)| cn).unwrap_or(0);
        let mut result = data.cn_nninfo.get(&best_cn).cloned().unwrap_or_default();
        for info in &mut result { info.weight = 1.0; }
        return result;
    }
    let mut result = data.all_nninfo;
    for info in &mut result {
        let mut w = 0.0;
        for (&cn, &cn_w) in &data.cn_weights {
            if let Some(cn_nn) = data.cn_nninfo.get(&cn) {
                if cn_nn.iter().any(|n| n.site_idx == info.site_idx && n.image == info.image) { w += cn_w; }
            }
        }
        info.weight = w;
    }
    result
}

// ── Helpers ───────────────────────────────────────────────────────

fn empty_nn_data() -> NNData {
    NNData {
        all_nninfo: vec![],
        cn_weights: BTreeMap::from([(0, 1.0)]),
        cn_nninfo: BTreeMap::from([(0, vec![])]),
    }
}

/// Semicircle integral for CN probability.
///
/// Returns the area under a unit semicircle `y = √(1−x²)` between
/// `dist_bins[idx]` and `dist_bins[idx+1]`, normalised by the total area `π/4`.
fn semicircle_integral(dist_bins: &[f64], idx: usize) -> f64 {
    fn antideriv(x: f64) -> f64 {
        if (x - 1.0).abs() < 1e-12 {
            return PI / 4.0;
        }
        if x.abs() < 1e-12 {
            return 0.0;
        }
        let s = (1.0 - x * x).max(0.0).sqrt();
        if s < 1e-15 {
            return PI / 4.0; // x ≈ ±1
        }
        0.5 * (x * s + (x / s).atan())
    }

    let x1 = dist_bins[idx];
    let x2 = dist_bins[idx + 1];
    (antideriv(x1) - antideriv(x2)) / (PI / 4.0)
}

/// Oxidation-state-aware radius: ionic → covalent → atomic → 0.
fn get_radius(species: &Species) -> f64 {
    if let Some(oxi) = species.oxidation_state {
        if oxi == 0 {
            return default_radius(species);
        }
        // Direct ionic radius for this oxidation state.
        if let Some(r) = species.element.ionic_radius(oxi) {
            return r;
        }
        // Average cationic or anionic radii from the full ionic-radii map.
        if let Some(radii) = species.element.ionic_radii() {
            let filtered: Vec<f64> = radii
                .iter()
                .filter_map(|(k, &v)| {
                    let ox: i32 = k.parse().ok()?;
                    if (oxi > 0 && ox > 0) || (oxi < 0 && ox < 0) {
                        Some(v)
                    } else {
                        None
                    }
                })
                .collect();
            if !filtered.is_empty() {
                return filtered.iter().sum::<f64>() / filtered.len() as f64;
            }
        }
    }
    0.0
}

/// Fallback radius: covalent → atomic → 1.5 Å.
fn default_radius(species: &Species) -> f64 {
    species
        .element
        .covalent_radius()
        .or_else(|| species.element.atomic_radius())
        .unwrap_or(1.5)
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::Element;
    use crate::lattice::Lattice;

    fn make_fcc(el: Element, a: f64) -> Structure {
        Structure::new(
            Lattice::cubic(a),
            vec![Species::neutral(el); 4],
            vec![
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(0.5, 0.5, 0.0),
                Vector3::new(0.5, 0.0, 0.5),
                Vector3::new(0.0, 0.5, 0.5),
            ],
        )
    }

    fn make_bcc(el: Element, a: f64) -> Structure {
        Structure::new(
            Lattice::cubic(a),
            vec![Species::neutral(el); 2],
            vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(0.5, 0.5, 0.5)],
        )
    }

    fn make_rocksalt(cat: Element, an: Element, a: f64) -> Structure {
        Structure::new(
            Lattice::cubic(a),
            [vec![Species::neutral(cat); 4], vec![Species::neutral(an); 4]].concat(),
            vec![
                Vector3::new(0.0, 0.0, 0.0),
                Vector3::new(0.5, 0.5, 0.0),
                Vector3::new(0.5, 0.0, 0.5),
                Vector3::new(0.0, 0.5, 0.5),
                Vector3::new(0.5, 0.0, 0.0),
                Vector3::new(0.0, 0.5, 0.0),
                Vector3::new(0.0, 0.0, 0.5),
                Vector3::new(0.5, 0.5, 0.5),
            ],
        )
    }

    fn make_perovskite(a_el: Element, b_el: Element, x_el: Element, a: f64) -> Structure {
        // ABX₃ perovskite: A at corner, B at body-center, X at face-centers.
        Structure::new(
            Lattice::cubic(a),
            vec![
                Species::neutral(a_el),
                Species::neutral(b_el),
                Species::neutral(x_el),
                Species::neutral(x_el),
                Species::neutral(x_el),
            ],
            vec![
                Vector3::new(0.0, 0.0, 0.0), // A
                Vector3::new(0.5, 0.5, 0.5), // B
                Vector3::new(0.5, 0.5, 0.0), // X
                Vector3::new(0.5, 0.0, 0.5), // X
                Vector3::new(0.0, 0.5, 0.5), // X
            ],
        )
    }

    #[test]
    fn fcc_cu_cn12() {
        let fcc = make_fcc(Element::Cu, 3.61);
        let cfg = CrystalNNConfig::default();
        for i in 0..4 {
            let cn = get_cn(&fcc, i, &cfg);
            assert_eq!(cn, 12.0, "FCC Cu site {i}: CN={cn}, expected 12");
        }
    }

    #[test]
    fn bcc_fe_cn() {
        let bcc = make_bcc(Element::Fe, 2.87);
        let cfg = CrystalNNConfig::default();
        for i in 0..2 {
            let cn = get_cn(&bcc, i, &cfg);
            assert!(
                (8.0..=14.0).contains(&cn),
                "BCC Fe site {i}: CN={cn}, expected 8–14"
            );
        }
    }

    #[test]
    fn rocksalt_nacl_cn6() {
        let nacl = make_rocksalt(Element::Na, Element::Cl, 5.64);
        let cfg = CrystalNNConfig::default();
        // Na sites (0–3) should have CN=6 with all-Cl neighbors.
        for i in 0..4 {
            let nn = get_nn_info(&nacl, i, &cfg);
            assert_eq!(nn.len(), 6, "NaCl Na site {i}: CN={}, expected 6", nn.len());
            assert!(
                nn.iter().all(|n| n.species.element == Element::Cl),
                "Na neighbors should all be Cl"
            );
        }
        // Cl sites (4–7) should have CN=6 with all-Na neighbors.
        for i in 4..8 {
            let nn = get_nn_info(&nacl, i, &cfg);
            assert_eq!(nn.len(), 6, "NaCl Cl site {i}: CN={}, expected 6", nn.len());
            assert!(
                nn.iter().all(|n| n.species.element == Element::Na),
                "Cl neighbors should all be Na"
            );
        }
    }

    #[test]
    fn perovskite_srtio3() {
        let perov = make_perovskite(Element::Sr, Element::Ti, Element::O, 3.905);
        let cfg = CrystalNNConfig::default();
        // Ti (site 1) should have CN=6 (octahedral coordination by O).
        let ti_nn = get_nn_info(&perov, 1, &cfg);
        assert_eq!(
            ti_nn.len(),
            6,
            "SrTiO₃ Ti: CN={}, expected 6",
            ti_nn.len()
        );
        assert!(
            ti_nn.iter().all(|n| n.species.element == Element::O),
            "Ti neighbors should all be O"
        );
    }

    #[test]
    fn cn_weights_sum_to_one() {
        let fcc = make_fcc(Element::Cu, 3.61);
        let data = get_nn_data(&fcc, 0, &CrystalNNConfig::default());
        let total: f64 = data.cn_weights.values().sum();
        assert!(
            (total - 1.0).abs() < 0.01,
            "CN weights sum = {total}, expected 1.0"
        );
    }

    #[test]
    fn most_probable_cn_fcc() {
        let fcc = make_fcc(Element::Cu, 3.61);
        let data = get_nn_data(&fcc, 0, &CrystalNNConfig::default());
        let best = data
            .cn_weights
            .iter()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(&cn, _)| cn)
            .unwrap();
        assert_eq!(best, 12, "Best CN={best}, expected 12");
    }

    #[test]
    fn semicircle_integral_sanity() {
        // Full range [1, 0] integrates to 1.
        let bins = vec![1.0, 0.0];
        let area = semicircle_integral(&bins, 0);
        assert!(
            (area - 1.0).abs() < 0.01,
            "full integral = {area}, expected 1.0"
        );

        // Two halves sum to 1.
        let bins2 = vec![1.0, 0.5, 0.0];
        let sum = semicircle_integral(&bins2, 0) + semicircle_integral(&bins2, 1);
        assert!((sum - 1.0).abs() < 0.01, "sum = {sum}, expected 1.0");
    }

    #[test]
    fn weighted_cn_mode() {
        let fcc = make_fcc(Element::Cu, 3.61);
        let cfg = CrystalNNConfig {
            weighted_cn: true,
            ..Default::default()
        };
        let nn = get_nn_info(&fcc, 0, &cfg);
        assert!(!nn.is_empty());
        // Total weighted CN should be close to 12.
        let wcn: f64 = nn.iter().map(|n| n.weight).sum();
        assert!(
            (wcn - 12.0).abs() < 1.0,
            "weighted CN = {wcn}, expected ~12"
        );
    }

    #[test]
    fn no_distance_cutoff() {
        let fcc = make_fcc(Element::Cu, 3.61);
        let cfg = CrystalNNConfig {
            distance_cutoffs: None,
            ..Default::default()
        };
        let cn = get_cn(&fcc, 0, &cfg);
        // Without distance cutoff, may include more distant neighbors.
        assert!(cn >= 12.0, "without distance cutoff: CN={cn}, expected ≥12");
    }
}

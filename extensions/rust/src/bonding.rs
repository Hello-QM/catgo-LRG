//! Bond detection algorithms for crystal structures.
//!
//! Provides multiple strategies for detecting chemical bonds:
//! - `atom_radii`: Based on sum of covalent radii
//! - `electroneg_ratio`: Based on electronegativity differences and chemical preferences
//! - `solid_angle`: Based on geometric solid angle subtended by atom pairs
//!
//! Also provides hydrogen bond detection using Baker-Hubbard criteria.
//!
//! All algorithms use spatial hashing for O(N) performance on typical structures.

use crate::element::Element;
use crate::structure::Structure;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ops::Range;

/// A detected bond between two atoms.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bond {
    /// Index of the first atom (center)
    pub site_idx_1: usize,
    /// Index of the second atom (neighbor)
    pub site_idx_2: usize,
    /// Bond length in Angstroms
    pub bond_length: f64,
    /// Bond strength/order estimate (0.0 to 1.0+)
    pub strength: f64,
    /// Image offset for periodic boundary conditions
    pub image: [i32; 3],
}

/// Options for atom_radii bonding algorithm.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AtomRadiiOptions {
    /// Multiplicative cutoff on the covalent radii sum (default: 1.2).
    /// Bond if: min_bond_dist <= distance <= scale * (r1 + r2).
    /// A proportional cutoff scales with atom size, unlike a fixed absolute
    /// pad which is too tight for large atoms / stretched metallic contacts.
    #[serde(default = "default_scale")]
    pub scale: f64,
    /// Minimum bond distance in Angstroms (default: 0.4)
    #[serde(default = "default_min_dist")]
    pub min_bond_dist: f64,
    /// Maximum bond distance in Angstroms (default: 5.0)
    #[serde(default = "default_max_dist")]
    pub max_bond_dist: f64,
    /// Include bonds across periodic boundaries (default: false).
    /// Essential for MOF analysis where PBC connectivity defines the topology.
    #[serde(default)]
    pub include_periodic_images: bool,
}

fn default_scale() -> f64 {
    1.2
}
fn default_min_dist() -> f64 {
    0.4
}
fn default_max_dist() -> f64 {
    5.0
}

impl Default for AtomRadiiOptions {
    fn default() -> Self {
        Self {
            scale: default_scale(),
            min_bond_dist: default_min_dist(),
            max_bond_dist: default_max_dist(),
            include_periodic_images: false,
        }
    }
}

/// Options for electroneg_ratio bonding algorithm.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ElectronegOptions {
    /// Max distance as multiple of sum of covalent radii (default: 2.0)
    #[serde(default = "default_max_ratio")]
    pub max_distance_ratio: f64,
    /// Minimum bond distance in Angstroms (default: 0.4)
    #[serde(default = "default_min_dist")]
    pub min_bond_dist: f64,
    /// Strength penalty for metal-metal bonds (default: 0.7)
    #[serde(default = "default_mm_penalty")]
    pub metal_metal_penalty: f64,
    /// Strength bonus for metal-nonmetal bonds (default: 1.5)
    #[serde(default = "default_mn_bonus")]
    pub metal_nonmetal_bonus: f64,
    /// Bonus for similar electronegativity (default: 1.2)
    #[serde(default = "default_sim_en_bonus")]
    pub similar_electronegativity_bonus: f64,
    /// Penalty for bonds between same element (default: 0.75)
    #[serde(default = "default_same_penalty")]
    pub same_species_penalty: f64,
    /// Minimum bond strength to include in results (default: 0.2)
    #[serde(default = "default_strength_threshold")]
    pub strength_threshold: f64,
}

fn default_max_ratio() -> f64 {
    2.0
}
fn default_mm_penalty() -> f64 {
    0.7
}
fn default_mn_bonus() -> f64 {
    1.5
}
fn default_sim_en_bonus() -> f64 {
    1.2
}
fn default_same_penalty() -> f64 {
    0.75
}
fn default_strength_threshold() -> f64 {
    0.2
}

impl Default for ElectronegOptions {
    fn default() -> Self {
        Self {
            max_distance_ratio: default_max_ratio(),
            min_bond_dist: default_min_dist(),
            metal_metal_penalty: default_mm_penalty(),
            metal_nonmetal_bonus: default_mn_bonus(),
            similar_electronegativity_bonus: default_sim_en_bonus(),
            same_species_penalty: default_same_penalty(),
            strength_threshold: default_strength_threshold(),
        }
    }
}

/// Cached element properties for fast lookup during bonding.
#[derive(Debug, Clone)]
struct ElementProps {
    element: Element,
    covalent_radius: f64,
    electronegativity: f64,
    is_metal: bool,
}

impl ElementProps {
    fn from_element(elem: Element) -> Self {
        Self {
            element: elem,
            covalent_radius: elem.covalent_radius().unwrap_or(1.5),
            electronegativity: elem.electronegativity().unwrap_or(2.0),
            is_metal: elem.is_metal(),
        }
    }
}

/// Below this many sites the bond-collection driver stays sequential even
/// when the `rayon` feature is on: thread-pool scheduling would cost more
/// than the evaluation itself (design §8.3 — small structures remain scalar).
#[cfg(feature = "rayon")]
const BOND_PARALLEL_MIN_SITES: usize = 128;

/// Owned prologue shared by the atom_radii drivers: cached element
/// properties, the neighbor search, and a CSR index over its centers.
/// `input()` borrows it as the [`BondEvalInput`] view the drivers consume.
struct BondEvalData {
    props: Vec<ElementProps>,
    center_indices: Vec<usize>,
    neighbor_indices: Vec<usize>,
    image_offsets: Vec<[i32; 3]>,
    distances: Vec<f64>,
    entry_offsets: Vec<usize>,
    scale: f64,
    min_dist_sq: f64,
}

impl BondEvalData {
    /// Cache element properties, run the neighbor search, and index it by
    /// center so drivers can slice deterministic contiguous center ranges.
    fn prepare(structure: &Structure, options: &AtomRadiiOptions) -> Self {
        let num_sites = structure.num_sites();

        // Cache element properties from species
        let species = structure.species();
        let props: Vec<ElementProps> = species
            .iter()
            .map(|sp| ElementProps::from_element(sp.element))
            .collect();

        // Use neighbor list for efficient spatial queries. The per-pair bond
        // bound is (r1 + r2) * scale ≤ 2 * r_max * scale, so the search cutoff
        // tightens below max_bond_dist without changing any result — at the
        // default 5 Å max on a typical oxide/metal system this trims the
        // candidate volume (and the distance evaluations) 3-4x.
        let max_radius = props.iter().map(|p| p.covalent_radius).fold(0.0, f64::max);
        let cutoff = options.max_bond_dist.min(2.0 * max_radius * options.scale);
        let (center_indices, neighbor_indices, image_offsets, distances) =
            structure.get_neighbor_list(cutoff, 1e-8, true);
        let entry_offsets = center_entry_offsets(&center_indices, num_sites);

        Self {
            props,
            center_indices,
            neighbor_indices,
            image_offsets,
            distances,
            entry_offsets,
            scale: options.scale,
            min_dist_sq: options.min_bond_dist * options.min_bond_dist,
        }
    }

    fn input(&self) -> BondEvalInput<'_> {
        BondEvalInput {
            props: &self.props,
            center_indices: &self.center_indices,
            neighbor_indices: &self.neighbor_indices,
            image_offsets: &self.image_offsets,
            distances: &self.distances,
            entry_offsets: &self.entry_offsets,
            scale: self.scale,
            min_dist_sq: self.min_dist_sq,
        }
    }
}

/// Everything the atom_radii bond predicate reads, borrowed once so the same
/// evaluation body can be driven sequentially or by Rayon over center ranges
/// (design §8.3: one predicate, two drivers).
struct BondEvalInput<'a> {
    /// Cached per-site element properties.
    props: &'a [ElementProps],
    /// Neighbor-list arrays, grouped by ascending center index.
    center_indices: &'a [usize],
    neighbor_indices: &'a [usize],
    image_offsets: &'a [[i32; 3]],
    distances: &'a [f64],
    /// CSR offsets into the neighbor arrays: entries whose center is `c`
    /// live at `entry_offsets[c]..entry_offsets[c + 1]`. Length is
    /// `num_sites + 1`.
    entry_offsets: &'a [usize],
    /// Multiplicative cutoff on the covalent radii sum.
    scale: f64,
    /// Squared minimum bond distance.
    min_dist_sq: f64,
}

/// CSR offsets over the neighbor list: entries whose center is `c` live at
/// `offsets[c]..offsets[c + 1]`. `build_neighbor_list` emits entries grouped
/// by ascending center index on both its serial and Rayon cell-list paths
/// (chunks merge in index order), which this construction relies on.
fn center_entry_offsets(center_indices: &[usize], num_sites: usize) -> Vec<usize> {
    debug_assert!(
        center_indices.windows(2).all(|pair| pair[0] <= pair[1]),
        "neighbor list must be grouped by ascending center index"
    );
    let mut offsets = vec![0usize; num_sites + 1];
    for &center in center_indices {
        offsets[center + 1] += 1;
    }
    for site in 0..num_sites {
        offsets[site + 1] += offsets[site];
    }
    offsets
}

/// Evaluate the atom_radii bond predicate over every neighbor-list entry
/// whose center index lies in `centers`, in ascending entry order.
///
/// This is the ONE predicate body shared by the sequential path and the
/// Rayon driver. Center ranges are contiguous and disjoint, so per-range
/// outputs flatten to exactly the sequential ordering — bond IDs, selection,
/// and snapshots stay deterministic across scalar and threaded builds.
fn evaluate_bond_center_range(input: &BondEvalInput<'_>, centers: Range<usize>) -> Vec<Bond> {
    let start = input.entry_offsets[centers.start];
    let end = input.entry_offsets[centers.end];
    let mut bonds = Vec::with_capacity((end - start) / 2);

    for idx in start..end {
        let center_idx = input.center_indices[idx];
        let neighbor_idx = input.neighbor_indices[idx];
        let image = input.image_offsets[idx];
        let dist = input.distances[idx];

        // Pair-level dedup with PBC awareness. `get_neighbor_list` emits
        // both directions of every neighbor pair — (a,b,image) and the
        // reverse (b,a,-image). We keep exactly one per logical bond:
        //   - intra-cell (image == 0): keep when a < b
        //   - cross-pair a != b: keep when a < b (each image is a distinct
        //     bond; the inverse direction has a > b and is dropped)
        //   - self-pair a == b crossing a boundary: dedup by lexicographic
        //     positivity of `image` (e.g. [+1,0,0] kept, [-1,0,0] dropped)
        if center_idx == neighbor_idx {
            // Self-pair under PBC: skip negative-direction duplicate.
            if image[0] < 0
                || (image[0] == 0 && image[1] < 0)
                || (image[0] == 0 && image[1] == 0 && image[2] <= 0)
            {
                continue;
            }
        } else if center_idx > neighbor_idx {
            continue;
        }

        let dist_sq = dist * dist;
        if dist_sq < input.min_dist_sq {
            continue;
        }

        let r1 = input.props[center_idx].covalent_radius;
        let r2 = input.props[neighbor_idx].covalent_radius;
        let upper_bound = (r1 + r2) * input.scale;

        // Only check upper bound: coordination bonds (M-O, M-N) are often
        // significantly shorter than the covalent radii sum. The lower bound
        // (min_bond_dist) already guards against unreasonably short distances.
        if dist <= upper_bound {
            bonds.push(Bond {
                site_idx_1: center_idx,
                site_idx_2: neighbor_idx,
                bond_length: dist,
                strength: 1.0,
                image,
            });
        }
    }

    bonds
}

/// Rayon driver: split center indices into deterministic contiguous ranges,
/// evaluate each range in parallel, and flatten the ordered chunks in
/// center-range order. Mirrors the chunking of `build_neighbor_list_celllist`
/// (neighbors.rs) so the merged output is byte-identical to the sequential
/// seam (design §8.3).
#[cfg(feature = "rayon")]
fn collect_bonds_over_centers_rayon(input: &BondEvalInput<'_>, num_sites: usize) -> Vec<Bond> {
    use rayon::prelude::*;

    let n_threads = rayon::current_num_threads().max(1);
    let chunk_size = num_sites.div_ceil(n_threads * 4).max(64);
    let chunk_starts: Vec<usize> = (0..num_sites).step_by(chunk_size).collect();
    let per_chunk: Vec<Vec<Bond>> = chunk_starts
        .into_par_iter()
        .map(|start| {
            evaluate_bond_center_range(input, start..(start + chunk_size).min(num_sites))
        })
        .collect();

    let mut bonds = Vec::with_capacity(per_chunk.iter().map(Vec::len).sum());
    for chunk in per_chunk {
        bonds.extend(chunk);
    }
    bonds
}

/// Bond-collection driver for the atom_radii predicate. Under the `rayon`
/// feature, large structures split into deterministic contiguous center
/// ranges evaluated in parallel; small structures stay on the sequential
/// path because thread scheduling would cost more than the evaluation.
fn collect_bonds_over_centers(input: &BondEvalInput<'_>, num_sites: usize) -> Vec<Bond> {
    #[cfg(feature = "rayon")]
    if num_sites > BOND_PARALLEL_MIN_SITES {
        return collect_bonds_over_centers_rayon(input, num_sites);
    }
    evaluate_bond_center_range(input, 0..num_sites)
}

/// Detect bonds using covalent radii sum.
///
/// A bond is detected if the distance between two atoms is at most
/// `scale` times the sum of their covalent radii.
///
/// This is the fastest algorithm, suitable for quick visualization.
pub fn detect_bonds_atom_radii(structure: &Structure, options: &AtomRadiiOptions) -> Vec<Bond> {
    let num_sites = structure.num_sites();
    if num_sites < 2 {
        return Vec::new();
    }

    let data = BondEvalData::prepare(structure, options);
    collect_bonds_over_centers(&data.input(), num_sites)
}

/// Detect bonds using electronegativity-based algorithm.
///
/// This algorithm considers:
/// - Electronegativity differences between atoms
/// - Metal/nonmetal properties
/// - Distance relative to covalent radii sum
///
/// Provides better chemical accuracy than pure distance-based methods.
pub fn detect_bonds_electroneg(structure: &Structure, options: &ElectronegOptions) -> Vec<Bond> {
    let num_sites = structure.num_sites();
    if num_sites < 2 {
        return Vec::new();
    }

    // Cache element properties from species
    let species = structure.species();
    let props: Vec<ElementProps> = species
        .iter()
        .map(|sp| ElementProps::from_element(sp.element))
        .collect();

    // Find maximum possible bond distance for neighbor search
    let max_radius = props.iter().map(|p| p.covalent_radius).fold(0.0, f64::max);
    let cutoff = max_radius * 2.0 * options.max_distance_ratio;

    let (center_indices, neighbor_indices, image_offsets, distances) =
        structure.get_neighbor_list(cutoff, 1e-8, true);

    let mut bonds = Vec::new();
    let min_dist_sq = options.min_bond_dist * options.min_bond_dist;

    // Pass 1: per-atom minimum NORMALIZED neighbour distance (dist / Σr) over
    // every geometric candidate (both directions, no pair dedup). Used below to
    // damp bonds that are long *relative to the atom's tightest contact* — this
    // is what stops a dense metal from bonding to its 2nd/3rd shell (matterviz's
    // closest-neighbour penalty). Precomputed so it is order-independent (the
    // neighbour list is not distance-sorted).
    let mut closest_norm: HashMap<usize, f64> = HashMap::new();
    for idx in 0..center_indices.len() {
        let dist = distances[idx];
        if dist * dist < min_dist_sq {
            continue;
        }
        let ci = center_indices[idx];
        let ni = neighbor_indices[idx];
        let sum_radii = props[ci].covalent_radius + props[ni].covalent_radius;
        if dist > sum_radii * options.max_distance_ratio {
            continue;
        }
        let norm = dist / sum_radii;
        closest_norm
            .entry(ci)
            .and_modify(|d| *d = d.min(norm))
            .or_insert(norm);
    }

    for idx in 0..center_indices.len() {
        let center_idx = center_indices[idx];
        let neighbor_idx = neighbor_indices[idx];
        let image = image_offsets[idx];
        let dist = distances[idx];

        // Pair-level dedup with PBC awareness (see detect_bonds_atom_radii).
        if center_idx == neighbor_idx {
            if image[0] < 0
                || (image[0] == 0 && image[1] < 0)
                || (image[0] == 0 && image[1] == 0 && image[2] <= 0)
            {
                continue;
            }
        } else if center_idx > neighbor_idx {
            continue;
        }

        let dist_sq = dist * dist;
        if dist_sq < min_dist_sq {
            continue;
        }

        let p1 = &props[center_idx];
        let p2 = &props[neighbor_idx];

        // Check distance constraint
        let sum_radii = p1.covalent_radius + p2.covalent_radius;
        let max_dist = sum_radii * options.max_distance_ratio;
        if dist > max_dist {
            continue;
        }

        // Electronegativity difference modulates strength (below) but never
        // rejects a bond: a large ΔEN is a strong ionic bond (Li-O, Na-Cl),
        // not a non-bond. (Earlier a hard `en_diff > threshold` cutoff here
        // dropped every ionic bond — chemically backwards.)
        let en_diff = (p1.electronegativity - p2.electronegativity).abs();

        // Calculate base strength from distance
        let dist_ratio = dist / sum_radii;
        let base_strength = if dist_ratio <= 1.0 {
            1.0
        } else {
            1.0 - (dist_ratio - 1.0) / (options.max_distance_ratio - 1.0)
        };

        // Apply chemical modifiers
        let mut strength = base_strength;

        // Metal-metal penalty
        if p1.is_metal && p2.is_metal {
            strength *= options.metal_metal_penalty;
        }

        // Metal-nonmetal bonus
        if (p1.is_metal && !p2.is_metal) || (!p1.is_metal && p2.is_metal) {
            strength *= options.metal_nonmetal_bonus;
        }

        // Similar electronegativity bonus (covalent character)
        if en_diff < 0.5 {
            strength *= options.similar_electronegativity_bonus;
        }

        // Same species penalty
        if p1.element == p2.element {
            strength *= options.same_species_penalty;
        }

        // Closest-neighbour penalty: damp bonds that are long relative to each
        // endpoint's tightest contact. A bond at an atom's own minimum has
        // ratio 1 (no penalty); longer ones decay as exp(-(ratio-1)/0.5),
        // pushing 2nd-shell metallic contacts below the strength threshold so
        // the viewer shows the coordination shell, not a hedgehog.
        for atom in [center_idx, neighbor_idx] {
            if let Some(&c) = closest_norm.get(&atom) {
                if c > 0.0 && dist_ratio > c {
                    strength *= (-(dist_ratio / c - 1.0) / 0.5).exp();
                }
            }
        }

        if strength >= options.strength_threshold {
            bonds.push(Bond {
                site_idx_1: center_idx,
                site_idx_2: neighbor_idx,
                bond_length: dist,
                strength,
                image,
            });
        }
    }

    bonds
}

/// Options for solid angle bonding algorithm.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolidAngleOptions {
    /// Minimum solid angle threshold (default: 0.01)
    #[serde(default = "default_min_solid_angle")]
    pub min_solid_angle: f64,
    /// Minimum face area in Å² (default: 0.05)
    #[serde(default = "default_min_face_area")]
    pub min_face_area: f64,
    /// Maximum search distance in Angstroms (default: 5.0)
    #[serde(default = "default_max_dist")]
    pub max_distance: f64,
    /// Minimum bond distance in Angstroms (default: 0.4)
    #[serde(default = "default_min_dist")]
    pub min_bond_dist: f64,
    /// Minimum bond strength to include (default: 0.05)
    #[serde(default = "default_sa_strength_threshold")]
    pub strength_threshold: f64,
    /// Distance sanity: drop a Voronoi contact whose length exceeds this
    /// multiple of the covalent-radii sum (default: 1.5). Suppresses
    /// anion-anion polyhedra edges (e.g. O-O) while keeping M-O and metal
    /// bonds. Set very large to keep pure radius-free Voronoi behaviour.
    #[serde(default = "default_sa_max_ratio")]
    pub max_distance_ratio: f64,
}

fn default_min_solid_angle() -> f64 {
    0.01
}
fn default_min_face_area() -> f64 {
    0.05
}
fn default_sa_strength_threshold() -> f64 {
    0.05
}
fn default_sa_max_ratio() -> f64 {
    1.5
}

impl Default for SolidAngleOptions {
    fn default() -> Self {
        Self {
            min_solid_angle: default_min_solid_angle(),
            min_face_area: default_min_face_area(),
            max_distance: default_max_dist(),
            min_bond_dist: default_min_dist(),
            strength_threshold: default_sa_strength_threshold(),
            max_distance_ratio: default_sa_max_ratio(),
        }
    }
}

/// Detect bonds using solid angle-based algorithm.
///
/// Inspired by Voronoi tessellation concepts. Bond strength is computed from
/// the solid angle subtended by the atom pair and a Gaussian distance penalty.
/// This is a geometry-only algorithm (no chemical preferences).
pub fn detect_bonds_solid_angle(structure: &Structure, options: &SolidAngleOptions) -> Vec<Bond> {
    use glam::DVec3;
    use meshless_voronoi::{Dimensionality, Voronoi};
    use std::collections::HashSet;

    let num_sites = structure.num_sites();
    if num_sites < 2 {
        return Vec::new();
    }

    // A bonded pair shares a Voronoi face. This is radius-free geometry, so it
    // gets octahedra (6) / tetrahedra (4) right and naturally excludes
    // cation-cation pairs an anion sits between (no shared face).
    //
    // meshless_voronoi's periodic box is axis-aligned, so it is only correct
    // for orthogonal cells (hexagonal/triclinic would tessellate wrongly).
    // Instead build a NON-periodic supercell of explicit image atoms around the
    // home cell and tessellate that: correct for ANY lattice, and each image
    // atom carries its exact Cartesian position → exact distance + jimage. A
    // slab's vacuum side simply yields unbounded (boundary) faces → no bond.
    // Covalent radii for the distance sanity that trims anion-anion edges.
    let radii: Vec<f64> = structure
        .species()
        .iter()
        .map(|sp| sp.element.covalent_radius().unwrap_or(1.5))
        .collect();

    let cart = structure.cart_coords();
    let m = structure.lattice.matrix();
    let avec = nalgebra::Vector3::new(m[(0, 0)], m[(0, 1)], m[(0, 2)]);
    let bvec = nalgebra::Vector3::new(m[(1, 0)], m[(1, 1)], m[(1, 2)]);
    let cvec = nalgebra::Vector3::new(m[(2, 0)], m[(2, 1)], m[(2, 2)]);

    // Replicate far enough that every home-cell atom is fully enclosed (≥ one
    // image past the search radius along each axis).
    let reps = |v: &nalgebra::Vector3<f64>| -> i32 {
        let len = v.norm();
        if len < 1e-6 {
            1
        } else {
            (options.max_distance / len).ceil().max(1.0) as i32
        }
    };
    let (na, nb, nc) = (reps(&avec), reps(&bvec), reps(&cvec));

    // A tiny deterministic jitter (≪ bond-length resolution) breaks the exact
    // coplanar/collinear degeneracies of symmetric crystals that otherwise make
    // meshless_voronoi's plane-intersection panic. Deterministic so results are
    // reproducible (no RNG, which is unavailable on wasm anyway).
    let jitter = |seed: u64| -> f64 {
        (seed.wrapping_mul(2_654_435_761) % 4001) as f64 / 4000.0 * 2e-6 - 1e-6
    };
    let mut sc_pos: Vec<DVec3> = Vec::new();
    let mut sc_map: Vec<(usize, [i32; 3])> = Vec::new(); // supercell idx -> (home idx, image)
    let mut central: Vec<usize> = Vec::new(); // supercell indices of the home (image 0) atoms
    for da in -na..=na {
        for db in -nb..=nb {
            for dc in -nc..=nc {
                let shift = avec * (da as f64) + bvec * (db as f64) + cvec * (dc as f64);
                for k in 0..num_sites {
                    if da == 0 && db == 0 && dc == 0 {
                        central.push(sc_pos.len());
                    }
                    let p = cart[k] + shift;
                    let s = sc_pos.len() as u64;
                    sc_map.push((k, [da, db, dc]));
                    sc_pos.push(DVec3::new(
                        p.x + jitter(3 * s),
                        p.y + jitter(3 * s + 1),
                        p.z + jitter(3 * s + 2),
                    ));
                }
            }
        }
    }

    // Bounding box for the non-periodic tessellation.
    let mut lo = sc_pos[0];
    let mut hi = sc_pos[0];
    for p in &sc_pos {
        lo = lo.min(*p);
        hi = hi.max(*p);
    }
    let margin = DVec3::splat(1.0);
    let anchor = lo - margin;
    let extent = (hi - lo) + margin * 2.0;
    let voronoi = Voronoi::build(&sc_pos, anchor, extent, Dimensionality::ThreeD, false);

    let min_dist = options.min_bond_dist;
    let mut bonds = Vec::new();
    let mut seen: HashSet<(usize, usize, [i32; 3])> = HashSet::new();

    for &sc_i in &central {
        let (i, _) = sc_map[sc_i];
        let center = sc_pos[sc_i];
        for face in voronoi.cells()[sc_i].faces(&voronoi) {
            let area = face.area();
            if area < 1e-9 {
                continue;
            }
            // Boundary faces (cluster surface / vacuum) have no neighbour.
            let raw = if face.left() == sc_i {
                match face.right() {
                    Some(r) => r,
                    None => continue,
                }
            } else {
                face.left()
            };
            let (j, image) = sc_map[raw];

            let dist = (sc_pos[raw] - center).length();
            if dist < min_dist {
                continue;
            }
            // Distance sanity: a shared Voronoi face that is far longer than the
            // covalent-radii sum is a polyhedra edge (anion-anion), not a bond.
            if dist > options.max_distance_ratio * (radii[i] + radii[j]) {
                continue;
            }
            // Solid-angle fraction Ω/4π ≈ A / (4π r²).
            let saf = area / (4.0 * std::f64::consts::PI * dist * dist);
            if saf < options.min_solid_angle {
                continue;
            }

            // Canonicalise (min, max, image-relative-to-min) so the same face
            // seen from both atoms dedupes to one bond.
            let key = if i < j {
                (i, j, image)
            } else if i > j {
                (j, i, [-image[0], -image[1], -image[2]])
            } else {
                if image[0] < 0
                    || (image[0] == 0 && image[1] < 0)
                    || (image[0] == 0 && image[1] == 0 && image[2] <= 0)
                {
                    continue;
                }
                (i, j, image)
            };
            if !seen.insert(key) {
                continue;
            }

            bonds.push(Bond {
                site_idx_1: key.0,
                site_idx_2: key.1,
                bond_length: dist,
                strength: saf.min(1.0),
                image: key.2,
            });
        }
    }

    bonds
}

// ==================== Hydrogen Bond Detection ====================

/// A detected hydrogen bond (D-H···A pattern).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HydrogenBond {
    /// Index of the hydrogen atom (H)
    pub h_idx: usize,
    /// Index of the donor atom (D)
    pub donor_idx: usize,
    /// Index of the acceptor atom (A)
    pub acceptor_idx: usize,
    /// D···A distance in Angstroms
    pub da_distance: f64,
    /// Bond strength estimate (0.0 to 1.0)
    pub strength: f64,
}

/// Options for hydrogen bond detection (Baker-Hubbard criteria).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HBondOptions {
    /// Maximum H···A distance in Angstroms (default: 2.5)
    #[serde(default = "default_max_ha_distance")]
    pub max_ha_distance: f64,
    /// Maximum D···A distance in Angstroms (default: 3.5)
    #[serde(default = "default_max_da_distance")]
    pub max_da_distance: f64,
    /// Minimum D-H···A angle in degrees (default: 120.0)
    #[serde(default = "default_min_angle")]
    pub min_angle: f64,
}

fn default_max_ha_distance() -> f64 {
    2.5
}
fn default_max_da_distance() -> f64 {
    3.5
}
fn default_min_angle() -> f64 {
    120.0
}

impl Default for HBondOptions {
    fn default() -> Self {
        Self {
            max_ha_distance: default_max_ha_distance(),
            max_da_distance: default_max_da_distance(),
            min_angle: default_min_angle(),
        }
    }
}

/// Check if element can be an H-bond donor or acceptor (N, O, F, S, Cl).
fn is_hbond_atom(elem: Element) -> bool {
    matches!(elem, Element::N | Element::O | Element::F | Element::S | Element::Cl)
}

/// Detect hydrogen bonds using Baker-Hubbard criteria.
///
/// D-H···A pattern where D and A are electronegative atoms (N, O, F, S, Cl).
/// Requires pre-computed covalent bonds to identify D-H pairs.
pub fn detect_hydrogen_bonds(
    structure: &Structure,
    covalent_bonds: &[Bond],
    options: &HBondOptions,
) -> Vec<HydrogenBond> {
    let num_sites = structure.num_sites();
    if num_sites < 3 {
        return Vec::new();
    }

    let species = structure.species();
    let elements: Vec<Element> = species.iter().map(|sp| sp.element).collect();
    let cart_coords = structure.cart_coords();

    // Build D-H pairs from covalent bonds: H_idx -> Vec<donor_idx>
    let mut h_donor_map: HashMap<usize, Vec<usize>> = HashMap::new();
    for bond in covalent_bonds {
        let e1 = elements[bond.site_idx_1];
        let e2 = elements[bond.site_idx_2];
        if e1 == Element::H && is_hbond_atom(e2) {
            h_donor_map
                .entry(bond.site_idx_1)
                .or_default()
                .push(bond.site_idx_2);
        } else if e2 == Element::H && is_hbond_atom(e1) {
            h_donor_map
                .entry(bond.site_idx_2)
                .or_default()
                .push(bond.site_idx_1);
        }
    }

    if h_donor_map.is_empty() {
        return Vec::new();
    }

    // Find acceptor atom indices (N, O, F, S, Cl)
    let acceptor_indices: Vec<usize> = (0..num_sites)
        .filter(|&i| is_hbond_atom(elements[i]))
        .collect();

    if acceptor_indices.is_empty() {
        return Vec::new();
    }

    // Build spatial grid for acceptor atoms
    let cell_size = options.max_da_distance;
    let inv_cell = 1.0 / cell_size;
    let mut grid: HashMap<(i32, i32, i32), Vec<usize>> = HashMap::new();
    for &a_idx in &acceptor_indices {
        let pos = &cart_coords[a_idx];
        let key = (
            (pos[0] * inv_cell).floor() as i32,
            (pos[1] * inv_cell).floor() as i32,
            (pos[2] * inv_cell).floor() as i32,
        );
        grid.entry(key).or_default().push(a_idx);
    }

    let max_ha_sq = options.max_ha_distance * options.max_ha_distance;
    let max_da_sq = options.max_da_distance * options.max_da_distance;
    let min_angle_rad = options.min_angle.to_radians();

    let mut hbonds = Vec::new();
    let mut seen = HashSet::new();

    for (&h_idx, donor_indices) in &h_donor_map {
        let h_pos = &cart_coords[h_idx];
        let cx = (h_pos[0] * inv_cell).floor() as i32;
        let cy = (h_pos[1] * inv_cell).floor() as i32;
        let cz = (h_pos[2] * inv_cell).floor() as i32;

        for di in -1..=1 {
            for dj in -1..=1 {
                for dk in -1..=1 {
                    if let Some(cell) = grid.get(&(cx + di, cy + dj, cz + dk)) {
                        for &a_idx in cell {
                            // Acceptor must not be the H or any of its donors
                            if a_idx == h_idx || donor_indices.contains(&a_idx) {
                                continue;
                            }
                            let a_pos = &cart_coords[a_idx];

                            // H···A distance check
                            let ha_dx = a_pos[0] - h_pos[0];
                            let ha_dy = a_pos[1] - h_pos[1];
                            let ha_dz = a_pos[2] - h_pos[2];
                            let ha_dist_sq =
                                ha_dx * ha_dx + ha_dy * ha_dy + ha_dz * ha_dz;
                            if ha_dist_sq > max_ha_sq {
                                continue;
                            }

                            for &d_idx in donor_indices {
                                let d_pos = &cart_coords[d_idx];

                                // D···A distance check
                                let da_dx = a_pos[0] - d_pos[0];
                                let da_dy = a_pos[1] - d_pos[1];
                                let da_dz = a_pos[2] - d_pos[2];
                                let da_dist_sq =
                                    da_dx * da_dx + da_dy * da_dy + da_dz * da_dz;
                                if da_dist_sq > max_da_sq {
                                    continue;
                                }

                                // D-H···A angle (at H): vectors H→D and H→A
                                let hd_x = d_pos[0] - h_pos[0];
                                let hd_y = d_pos[1] - h_pos[1];
                                let hd_z = d_pos[2] - h_pos[2];
                                let ha_len = ha_dist_sq.sqrt();
                                let hd_len =
                                    (hd_x * hd_x + hd_y * hd_y + hd_z * hd_z).sqrt();
                                if ha_len < 1e-8 || hd_len < 1e-8 {
                                    continue;
                                }

                                let cos_angle = (hd_x * ha_dx
                                    + hd_y * ha_dy
                                    + hd_z * ha_dz)
                                    / (hd_len * ha_len);
                                let angle = cos_angle.clamp(-1.0, 1.0).acos();

                                if angle < min_angle_rad {
                                    continue;
                                }

                                // Deduplicate by H-A pair (not D-A) so two H atoms
                                // on the same donor can each form H-bonds with the same acceptor
                                let pair_key = if h_idx < a_idx {
                                    (h_idx, a_idx)
                                } else {
                                    (a_idx, h_idx)
                                };
                                if seen.contains(&pair_key) {
                                    continue;
                                }
                                seen.insert(pair_key);

                                let da_dist = da_dist_sq.sqrt();
                                hbonds.push(HydrogenBond {
                                    h_idx,
                                    donor_idx: d_idx,
                                    acceptor_idx: a_idx,
                                    da_distance: da_dist,
                                    strength: 1.0
                                        - (da_dist / options.max_da_distance),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    hbonds
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lattice::Lattice;
    use crate::species::Species;
    use nalgebra::Vector3;

    fn nacl_structure() -> Structure {
        // Rock salt NaCl structure (Fm-3m)
        // Using conventional cell with 4 Na + 4 Cl atoms
        let lattice = Lattice::cubic(5.64);
        let species = vec![
            // Na atoms at FCC positions
            Species::neutral(Element::Na),
            Species::neutral(Element::Na),
            Species::neutral(Element::Na),
            Species::neutral(Element::Na),
            // Cl atoms at edge centers + body center
            Species::neutral(Element::Cl),
            Species::neutral(Element::Cl),
            Species::neutral(Element::Cl),
            Species::neutral(Element::Cl),
        ];
        let frac_coords = vec![
            // Na at FCC positions
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.5, 0.5, 0.0),
            Vector3::new(0.5, 0.0, 0.5),
            Vector3::new(0.0, 0.5, 0.5),
            // Cl at octahedral sites
            Vector3::new(0.5, 0.0, 0.0),
            Vector3::new(0.0, 0.5, 0.0),
            Vector3::new(0.0, 0.0, 0.5),
            Vector3::new(0.5, 0.5, 0.5),
        ];
        Structure::new(lattice, species, frac_coords)
    }

    #[test]
    fn test_atom_radii_nacl() {
        let structure = nacl_structure();
        let options = AtomRadiiOptions::default();
        let bonds = detect_bonds_atom_radii(&structure, &options);

        // NaCl should have bonds between Na and Cl
        assert!(!bonds.is_empty(), "Should detect Na-Cl bonds");

        // Check bond properties
        for bond in &bonds {
            assert!(bond.bond_length > 2.0 && bond.bond_length < 4.0);
            assert!(bond.strength > 0.0);
        }
    }

    #[test]
    fn test_electroneg_nacl() {
        let structure = nacl_structure();
        let options = ElectronegOptions::default();
        let bonds = detect_bonds_electroneg(&structure, &options);

        assert!(!bonds.is_empty(), "Should detect Na-Cl bonds");

        // The ionic Na-Cl bonds (idx 0-3 = Na, 4-7 = Cl) must be present and
        // strong — a large ΔEN is an ionic bond, not a rejected pair. The
        // metal-nonmetal bonus boosts them well above any same-species contact.
        let na_cl: Vec<_> = bonds
            .iter()
            .filter(|b| (b.site_idx_1 < 4) != (b.site_idx_2 < 4))
            .collect();
        assert!(
            !na_cl.is_empty(),
            "Should detect ionic Na-Cl bonds (large ΔEN must not be rejected)"
        );
        for b in &na_cl {
            assert!(b.strength > 0.5, "Na-Cl ionic bond should be strong, got {}", b.strength);
        }
    }

    #[test]
    fn test_no_self_bonds() {
        let lattice = Lattice::cubic(10.0);
        let species = vec![Species::neutral(Element::C)];
        let frac_coords = vec![Vector3::new(0.5, 0.5, 0.5)];
        let structure = Structure::new(lattice, species, frac_coords);

        let bonds = detect_bonds_atom_radii(&structure, &AtomRadiiOptions::default());
        assert!(bonds.is_empty(), "Single atom should have no bonds");
    }

    #[test]
    fn test_solid_angle_nacl() {
        let structure = nacl_structure();
        let options = SolidAngleOptions::default();
        let bonds = detect_bonds_solid_angle(&structure, &options);

        assert!(!bonds.is_empty(), "Should detect bonds via solid angle");
        for bond in &bonds {
            assert!(bond.bond_length > 0.4);
            assert!(bond.strength > 0.0);
            // Voronoi coordination: rock-salt cells are cubes → 6 faces toward
            // the opposite species only. No same-species (Na-Na / Cl-Cl) bonds.
            let cross = (bond.site_idx_1 < 4) != (bond.site_idx_2 < 4);
            assert!(
                cross,
                "solid_angle must not bond same species in NaCl: {}-{}",
                bond.site_idx_1, bond.site_idx_2
            );
        }
        // 6-fold coordination: 4 Na × 6 Cl = 24 unique Na-Cl bonds.
        assert_eq!(bonds.len(), 24, "rock-salt is 6-coordinate");
    }

    #[test]
    fn test_hydrogen_bonds_water() {
        // Two water molecules arranged for hydrogen bonding
        let lattice = Lattice::cubic(20.0);
        let species = vec![
            Species::neutral(Element::O),  // O of molecule 1
            Species::neutral(Element::H),  // H1 of molecule 1
            Species::neutral(Element::H),  // H2 of molecule 1 (donor H)
            Species::neutral(Element::O),  // O of molecule 2 (acceptor)
            Species::neutral(Element::H),  // H1 of molecule 2
            Species::neutral(Element::H),  // H2 of molecule 2
        ];
        // Place two water molecules with H-bond geometry
        // Molecule 1: O at (5,5,5), H at (5.76,5.59,5), H at (5,5.97,5) -- donor H points toward mol 2
        // Molecule 2: O at (5,7.8,5), H at (4.24,8.39,5), H at (5.76,8.39,5)
        let frac_coords = vec![
            Vector3::new(0.25, 0.25, 0.25),     // O1 at (5, 5, 5)
            Vector3::new(0.288, 0.2795, 0.25),   // H1 at (5.76, 5.59, 5)
            Vector3::new(0.25, 0.2985, 0.25),    // H2 at (5, 5.97, 5) -- donor
            Vector3::new(0.25, 0.39, 0.25),      // O2 at (5, 7.8, 5) -- acceptor
            Vector3::new(0.212, 0.4195, 0.25),   // H3 at (4.24, 8.39, 5)
            Vector3::new(0.288, 0.4195, 0.25),   // H4 at (5.76, 8.39, 5)
        ];
        let structure = Structure::new(lattice, species, frac_coords);

        // First detect covalent bonds
        let cov_bonds = detect_bonds_atom_radii(&structure, &AtomRadiiOptions::default());
        assert!(!cov_bonds.is_empty(), "Should have covalent O-H bonds");

        // Then detect hydrogen bonds
        let hbonds = detect_hydrogen_bonds(&structure, &cov_bonds, &HBondOptions::default());
        // Should find at least one H-bond between the two water molecules
        assert!(
            !hbonds.is_empty(),
            "Should detect H-bond between water molecules"
        );
        for hb in &hbonds {
            assert!(hb.da_distance < 3.5, "D···A distance should be < 3.5 Å");
            assert!(hb.strength > 0.0);
        }
    }

    #[test]
    fn test_atom_radii_metal_scale() {
        // Two Cu atoms 3.05 Å apart. The covalent-radii sum is 2.64 Å, so the
        // legacy absolute window (sum + 0.3 = 2.94 Å) drops this real metallic
        // contact. A multiplicative cutoff (1.2 * sum = 3.17 Å) keeps it.
        let lattice = Lattice::cubic(20.0);
        let species = vec![Species::neutral(Element::Cu), Species::neutral(Element::Cu)];
        let frac_coords = vec![
            Vector3::new(0.25, 0.25, 0.25),
            Vector3::new(0.25 + 3.05 / 20.0, 0.25, 0.25),
        ];
        let structure = Structure::new(lattice, species, frac_coords);

        let bonds = detect_bonds_atom_radii(&structure, &AtomRadiiOptions::default());
        assert_eq!(
            bonds.len(),
            1,
            "Cu-Cu at 3.05 Å is a metallic contact within 1.2*(r1+r2); must bond"
        );
    }

    #[test]
    fn test_atom_radii_scale_rejects_far() {
        // Two Cu atoms 3.30 Å apart sit beyond 1.2 * sum (3.17 Å) — no bond.
        let lattice = Lattice::cubic(20.0);
        let species = vec![Species::neutral(Element::Cu), Species::neutral(Element::Cu)];
        let frac_coords = vec![
            Vector3::new(0.25, 0.25, 0.25),
            Vector3::new(0.25 + 3.30 / 20.0, 0.25, 0.25),
        ];
        let structure = Structure::new(lattice, species, frac_coords);

        let bonds = detect_bonds_atom_radii(&structure, &AtomRadiiOptions::default());
        assert!(bonds.is_empty(), "Cu-Cu at 3.30 Å exceeds 1.2*(r1+r2); must not bond");
    }

    fn fcc_cu() -> Structure {
        // Conventional FCC Cu cell (a = 3.615 Å): 1st shell at a/√2 = 2.556 Å,
        // 2nd shell at a = 3.615 Å.
        let lattice = Lattice::cubic(3.615);
        let species = vec![Species::neutral(Element::Cu); 4];
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.5, 0.5, 0.0),
            Vector3::new(0.5, 0.0, 0.5),
            Vector3::new(0.0, 0.5, 0.5),
        ];
        Structure::new(lattice, species, frac_coords)
    }

    #[test]
    fn test_electroneg_no_second_shell_in_metal() {
        // electroneg must not paint a hedgehog: with the closest-neighbor
        // penalty, only the 1st coordination shell (~2.56 Å) survives; the
        // 2nd shell at 3.615 Å is suppressed below the strength threshold.
        let bonds = detect_bonds_electroneg(&fcc_cu(), &ElectronegOptions::default());
        assert!(!bonds.is_empty(), "FCC Cu must have 1st-shell metallic bonds");
        let max_len = bonds.iter().map(|b| b.bond_length).fold(0.0_f64, f64::max);
        assert!(
            max_len < 3.0,
            "longest electroneg bond should be 1st-shell (~2.56 Å), got {max_len:.3} Å \
             (2nd shell at 3.615 Å leaked in — closest-neighbor penalty missing)"
        );
    }

    #[test]
    fn test_solid_angle_drops_anion_edge() {
        // Two O atoms 2.6 Å apart share a Voronoi face, but 2.6 > 1.5·Σr(O,O)
        // (≈1.98 Å), so the distance sanity must drop this O-O polyhedra edge.
        let lattice = Lattice::cubic(12.0);
        let species = vec![Species::neutral(Element::O), Species::neutral(Element::O)];
        let frac_coords = vec![
            Vector3::new(0.4, 0.5, 0.5),
            Vector3::new(0.4 + 2.6 / 12.0, 0.5, 0.5),
        ];
        let structure = Structure::new(lattice, species, frac_coords);

        let bonds = detect_bonds_solid_angle(&structure, &SolidAngleOptions::default());
        assert!(bonds.is_empty(), "O-O at 2.6 Å exceeds 1.5·Σr; must not bond");
    }

    #[test]
    fn test_solid_angle_hcp_non_orthogonal() {
        // HCP (γ = 120°, non-orthogonal): every atom is 12-coordinate. An
        // axis-aligned periodic Voronoi gets this wrong (6); the non-periodic
        // supercell tessellation must recover the full 12.
        let lattice = Lattice::hexagonal(3.21, 5.21);
        let species = vec![Species::neutral(Element::Mg); 2];
        let frac_coords = vec![
            Vector3::new(1.0 / 3.0, 2.0 / 3.0, 0.25),
            Vector3::new(2.0 / 3.0, 1.0 / 3.0, 0.75),
        ];
        let structure = Structure::new(lattice, species, frac_coords);

        let bonds = detect_bonds_solid_angle(&structure, &SolidAngleOptions::default());
        // coordination = 2 * bonds / atoms
        let coordination = 2 * bonds.len() / 2;
        assert_eq!(
            coordination, 12,
            "HCP must be 12-coordinate via supercell Voronoi, got {coordination}"
        );
    }

    #[test]
    fn test_electroneg_bonds_ionic_lio() {
        // Li-O is a strong ionic bond (ΔEN ≈ 2.5). electroneg must NOT drop it
        // just because the electronegativity difference is large — a big ΔEN is
        // an ionic bond, not a non-bond.
        let lattice = Lattice::cubic(15.0);
        let species = vec![Species::neutral(Element::Li), Species::neutral(Element::O)];
        let frac_coords = vec![
            Vector3::new(0.3, 0.3, 0.3),
            Vector3::new(0.3 + 2.0 / 15.0, 0.3, 0.3),
        ];
        let structure = Structure::new(lattice, species, frac_coords);

        let bonds = detect_bonds_electroneg(&structure, &ElectronegOptions::default());
        assert_eq!(
            bonds.len(),
            1,
            "Li-O at 2.0 Å is a real ionic bond; electroneg must detect it"
        );
    }

    /// Exact byte serialization of the typed outputs (pairs, jimages,
    /// lengths, strengths) — bit-pattern identity, no tolerance.
    fn typed_bond_bytes(bonds: &[Bond]) -> Vec<u8> {
        let mut out = Vec::with_capacity(bonds.len() * 44);
        for bond in bonds {
            out.extend_from_slice(&(bond.site_idx_1 as u64).to_le_bytes());
            out.extend_from_slice(&(bond.site_idx_2 as u64).to_le_bytes());
            for component in bond.image {
                out.extend_from_slice(&component.to_le_bytes());
            }
            out.extend_from_slice(&bond.bond_length.to_bits().to_le_bytes());
            out.extend_from_slice(&bond.strength.to_bits().to_le_bytes());
        }
        out
    }

    /// n×n×n conventional FCC Cu cells (4n³ atoms), fully periodic — hundreds
    /// of centers so the Rayon driver splits the work across many chunks.
    fn fcc_cu_supercell(n: usize) -> Structure {
        let base = [
            [0.0, 0.0, 0.0],
            [0.5, 0.5, 0.0],
            [0.5, 0.0, 0.5],
            [0.0, 0.5, 0.5],
        ];
        let lattice = Lattice::cubic(3.615 * n as f64);
        let mut species = Vec::new();
        let mut frac_coords = Vec::new();
        for i in 0..n {
            for j in 0..n {
                for k in 0..n {
                    for b in &base {
                        species.push(Species::neutral(Element::Cu));
                        frac_coords.push(Vector3::new(
                            (i as f64 + b[0]) / n as f64,
                            (j as f64 + b[1]) / n as f64,
                            (k as f64 + b[2]) / n as f64,
                        ));
                    }
                }
            }
        }
        Structure::new(lattice, species, frac_coords)
    }

    #[test]
    fn typed_bonds_scalar_and_rayon_are_byte_identical() {
        // 500 centers → under `--features rayon` the public path takes the
        // chunked Rayon driver (well above the small-structure floor); the
        // scalar build takes the sequential driver. Both must be
        // byte-identical to the single-range sequential seam.
        let structure = fcc_cu_supercell(5);
        let options = AtomRadiiOptions::default();
        let num_sites = structure.num_sites();

        let data = BondEvalData::prepare(&structure, &options);
        let sequential = evaluate_bond_center_range(&data.input(), 0..num_sites);
        assert!(!sequential.is_empty(), "FCC Cu must have metallic bonds");

        let driven = detect_bonds_atom_radii(&structure, &options);
        assert_eq!(
            typed_bond_bytes(&sequential),
            typed_bond_bytes(&driven),
            "public driver output must be byte-identical to the sequential seam"
        );

        #[cfg(feature = "rayon")]
        {
            let parallel = collect_bonds_over_centers_rayon(&data.input(), num_sites);
            assert_eq!(
                typed_bond_bytes(&sequential),
                typed_bond_bytes(&parallel),
                "Rayon chunked driver must be byte-identical to the sequential seam"
            );
        }
    }

    #[test]
    fn rayon_bond_order_is_stable_across_runs() {
        // Non-trivial periodic structure spanning many chunks: repeated
        // detection must produce identical typed bytes on every run,
        // regardless of thread scheduling.
        let structure = fcc_cu_supercell(5);
        let options = AtomRadiiOptions::default();
        let reference = typed_bond_bytes(&detect_bonds_atom_radii(&structure, &options));
        assert!(!reference.is_empty(), "FCC Cu must have metallic bonds");
        for run in 1..=7 {
            let bytes = typed_bond_bytes(&detect_bonds_atom_radii(&structure, &options));
            assert_eq!(reference, bytes, "run {run} deviated from run 0");
        }
    }

    #[test]
    fn thin_cell_self_images_are_preserved() {
        // 2.5 Å-thin periodic cell: every valid bond is a self-image pair
        // (a == b, jimage != 0) — each Cu bonds to its own periodic image
        // along the short axis (2.5 Å < 1.2·Σr ≈ 3.17 Å) while the two atoms
        // sit ~8.5 Å apart. Pins design §7.2 at the Rust layer: periodic
        // self-image edges are valid bonds and must survive BOTH drivers.
        let lattice = Lattice::orthorhombic(2.5, 12.0, 12.0);
        let species = vec![Species::neutral(Element::Cu); 2];
        let frac_coords = vec![Vector3::new(0.5, 0.2, 0.2), Vector3::new(0.5, 0.7, 0.7)];
        let structure = Structure::new(lattice, species, frac_coords);
        let options = AtomRadiiOptions::default();

        let data = BondEvalData::prepare(&structure, &options);
        let sequential = evaluate_bond_center_range(&data.input(), 0..2);
        let driven = detect_bonds_atom_radii(&structure, &options);

        let mut outputs = vec![("sequential seam", &sequential), ("public driver", &driven)];
        #[cfg(feature = "rayon")]
        let parallel = collect_bonds_over_centers_rayon(&data.input(), 2);
        #[cfg(feature = "rayon")]
        outputs.push(("rayon driver", &parallel));

        for (driver, bonds) in &outputs {
            assert_eq!(bonds.len(), 2, "{driver}: expected one self-image bond per atom");
            for bond in bonds.iter() {
                assert_eq!(
                    bond.site_idx_1, bond.site_idx_2,
                    "{driver}: thin-cell bond must be a self-pair"
                );
                assert_ne!(bond.image, [0, 0, 0], "{driver}: self-pair jimage must be nonzero");
                assert!(
                    (bond.bond_length - 2.5).abs() < 1e-6,
                    "{driver}: self-image bond must span exactly one cell (2.5 Å), got {}",
                    bond.bond_length
                );
            }
        }
        for (driver, bonds) in &outputs[1..] {
            assert_eq!(
                typed_bond_bytes(&sequential),
                typed_bond_bytes(bonds),
                "{driver} must match the sequential seam byte for byte"
            );
        }
    }
}

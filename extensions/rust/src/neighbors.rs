//! Cell-list based neighbor finding for O(n) complexity.
//!
//! This module provides efficient neighbor list computation using spatial binning.
//! The cell-list algorithm partitions space into bins and only checks neighboring
//! bins, reducing complexity from O(n²) to O(n) for large systems.
//!
//! # Example
//!
//! ```rust,ignore
//! use ferrox::neighbors::{build_neighbor_list, NeighborListConfig};
//! use ferrox::Structure;
//!
//! let structure = Structure::from_json(json_str)?;
//! let config = NeighborListConfig {
//!     cutoff: 5.0,
//!     ..Default::default()
//! };
//! let nl = build_neighbor_list(&structure, &config);
//! ```

use crate::lattice::Lattice;
use crate::structure::Structure;
use nalgebra::Vector3;

#[cfg(feature = "rayon")]
use rayon::prelude::*;

/// Configuration for neighbor list computation.
#[derive(Debug, Clone)]
pub struct NeighborListConfig {
    /// Maximum distance to consider atoms as neighbors (Angstrom).
    pub cutoff: f64,
    /// Whether to include self-interactions (same atom, same image).
    pub self_interaction: bool,
    /// Numerical tolerance for distance comparisons.
    pub numerical_tol: f64,
    /// Minimum number of atoms to use cell-list algorithm instead of brute-force.
    /// Cell-list is O(n) but has setup overhead; brute-force is O(n²) but simpler.
    /// Default: 50 atoms.
    pub cell_list_threshold: usize,
}

impl Default for NeighborListConfig {
    fn default() -> Self {
        Self {
            cutoff: 5.0,
            self_interaction: false,
            numerical_tol: 1e-8,
            cell_list_threshold: 50,
        }
    }
}

/// Result of neighbor list computation.
#[derive(Debug, Clone, Default)]
pub struct NeighborList {
    /// Center atom indices (one entry per pair).
    pub center_indices: Vec<usize>,
    /// Neighbor atom indices (one entry per pair).
    pub neighbor_indices: Vec<usize>,
    /// Distance between center and neighbor (Angstrom).
    pub distances: Vec<f64>,
    /// Periodic image offset [da, db, dc] in lattice vector units.
    pub images: Vec<[i32; 3]>,
}

impl NeighborList {
    /// Create an empty neighbor list.
    pub fn new() -> Self {
        Self::default()
    }

    /// Create a neighbor list with pre-allocated capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            center_indices: Vec::with_capacity(capacity),
            neighbor_indices: Vec::with_capacity(capacity),
            distances: Vec::with_capacity(capacity),
            images: Vec::with_capacity(capacity),
        }
    }

    /// Number of neighbor pairs in the list.
    pub fn len(&self) -> usize {
        self.center_indices.len()
    }

    /// Check if the neighbor list is empty.
    pub fn is_empty(&self) -> bool {
        self.center_indices.is_empty()
    }

    /// Add a neighbor pair to the list.
    pub fn push(&mut self, center: usize, neighbor: usize, distance: f64, image: [i32; 3]) {
        self.center_indices.push(center);
        self.neighbor_indices.push(neighbor);
        self.distances.push(distance);
        self.images.push(image);
    }

    /// Merge another neighbor list into this one.
    pub fn extend(&mut self, other: NeighborList) {
        self.center_indices.extend(other.center_indices);
        self.neighbor_indices.extend(other.neighbor_indices);
        self.distances.extend(other.distances);
        self.images.extend(other.images);
    }

    fn clear(&mut self) {
        self.center_indices.clear();
        self.neighbor_indices.clear();
        self.distances.clear();
        self.images.clear();
    }

    fn extend_from(&mut self, other: &NeighborList) {
        self.center_indices.extend_from_slice(&other.center_indices);
        self.neighbor_indices
            .extend_from_slice(&other.neighbor_indices);
        self.distances.extend_from_slice(&other.distances);
        self.images.extend_from_slice(&other.images);
    }
}

/// Allocation and fixed-grid reuse counters for a neighbor-search workspace.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NeighborWorkspaceStats {
    /// Number of frames that reused an identical fully periodic grid plan.
    pub grid_cache_hits: u64,
    /// Number of grid plans built from lattice and/or coordinate geometry.
    pub grid_rebuilds: u64,
    /// Number of workspace vectors whose capacity grew.
    pub capacity_growths: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FixedPeriodicGridKey {
    atom_count: usize,
    cutoff_bits: u64,
    lattice_bits: [u64; 9],
    pbc: [bool; 3],
}

impl FixedPeriodicGridKey {
    fn new(atom_count: usize, lattice: &Lattice, cutoff: f64) -> Self {
        let matrix = lattice.matrix();
        let mut lattice_bits = [0u64; 9];
        for (bits, value) in lattice_bits.iter_mut().zip(matrix.iter()) {
            *bits = value.to_bits();
        }
        Self {
            atom_count,
            cutoff_bits: cutoff.to_bits(),
            lattice_bits,
            pbc: lattice.pbc,
        }
    }
}

struct CellGridPlan {
    n_bins: [usize; 3],
    origin_frac: [f64; 3],
    extent_frac: [f64; 3],
    bin_size_frac: [f64; 3],
    stencil: Vec<[i32; 3]>,
    pbc: [bool; 3],
}

impl CellGridPlan {
    fn build(frac_coords: &[Vector3<f64>], lattice: &Lattice, cutoff: f64) -> Self {
        let n_atoms = frac_coords.len();
        let pbc = lattice.pbc;
        let matrix = lattice.matrix();
        let lattice_vecs = [
            matrix.row(0).transpose(),
            matrix.row(1).transpose(),
            matrix.row(2).transpose(),
        ];
        let volume = lattice.volume();
        let heights: [f64; 3] = std::array::from_fn(|idx| {
            let cross = lattice_vecs[(idx + 1) % 3].cross(&lattice_vecs[(idx + 2) % 3]);
            volume / cross.norm()
        });

        let mut origin_frac = [0.0f64; 3];
        let mut extent_frac = [1.0f64; 3];
        for axis in 0..3 {
            if !pbc[axis] {
                let mut fmin = f64::MAX;
                let mut fmax = f64::MIN;
                for frac in frac_coords {
                    fmin = fmin.min(frac[axis]);
                    fmax = fmax.max(frac[axis]);
                }
                if n_atoms == 0 {
                    fmin = 0.0;
                    fmax = 1.0;
                }
                origin_frac[axis] = fmin;
                extent_frac[axis] = (fmax - fmin).max(1e-9);
            }
        }

        let axis_cap = (((n_atoms as f64).cbrt().ceil() as usize) * 2).max(1);
        let n_bins: [usize; 3] = std::array::from_fn(|axis| {
            let domain_cart = heights[axis] * extent_frac[axis];
            ((domain_cart / cutoff).floor() as usize).clamp(1, axis_cap)
        });
        let bin_size_frac: [f64; 3] =
            std::array::from_fn(|axis| extent_frac[axis] / n_bins[axis] as f64);
        let radius: [i32; 3] = std::array::from_fn(|axis| {
            let bin_cart = heights[axis] * bin_size_frac[axis];
            let radius = (cutoff / bin_cart).floor() as i32 + 1;
            if pbc[axis] {
                radius
            } else {
                radius.min(n_bins[axis] as i32 - 1).max(0)
            }
        });
        let mut stencil = Vec::with_capacity(
            ((2 * radius[0] + 1) * (2 * radius[1] + 1) * (2 * radius[2] + 1)) as usize,
        );
        for dx in -radius[0]..=radius[0] {
            for dy in -radius[1]..=radius[1] {
                for dz in -radius[2]..=radius[2] {
                    stencil.push([dx, dy, dz]);
                }
            }
        }

        Self {
            n_bins,
            origin_frac,
            extent_frac,
            bin_size_frac,
            stencil,
            pbc,
        }
    }
}

fn reserve_total_tracked<T>(
    values: &mut Vec<T>,
    needed: usize,
    stats: &mut NeighborWorkspaceStats,
) {
    if values.capacity() < needed {
        values.reserve(needed.saturating_sub(values.len()));
        stats.capacity_growths += 1;
    }
}

fn clear_and_reserve_tracked<T>(
    values: &mut Vec<T>,
    needed: usize,
    stats: &mut NeighborWorkspaceStats,
) {
    values.clear();
    reserve_total_tracked(values, needed, stats);
}

fn clear_and_resize_tracked<T: Clone>(
    values: &mut Vec<T>,
    needed: usize,
    value: T,
    stats: &mut NeighborWorkspaceStats,
) {
    clear_and_reserve_tracked(values, needed, stats);
    values.resize(needed, value);
}

fn neighbor_capacities(neighbors: &NeighborList) -> [usize; 4] {
    [
        neighbors.center_indices.capacity(),
        neighbors.neighbor_indices.capacity(),
        neighbors.distances.capacity(),
        neighbors.images.capacity(),
    ]
}

fn capacity_change_count(before: [usize; 4], after: [usize; 4]) -> u64 {
    before
        .into_iter()
        .zip(after)
        .filter(|(old, new)| new > old)
        .count() as u64
}

fn prepare_neighbor_list(
    neighbors: &mut NeighborList,
    estimated_pairs: usize,
    stats: &mut NeighborWorkspaceStats,
) {
    neighbors.clear();
    reserve_total_tracked(&mut neighbors.center_indices, estimated_pairs, stats);
    reserve_total_tracked(&mut neighbors.neighbor_indices, estimated_pairs, stats);
    reserve_total_tracked(&mut neighbors.distances, estimated_pairs, stats);
    reserve_total_tracked(&mut neighbors.images, estimated_pairs, stats);
}

/// Grow-only scratch and grid cache for repeated exact neighbor searches.
#[derive(Default)]
pub struct NeighborSearchWorkspace {
    fixed_periodic_key: Option<FixedPeriodicGridKey>,
    grid_plan: Option<CellGridPlan>,
    cell_list: CellList,
    neighbors: NeighborList,
    #[cfg_attr(not(feature = "rayon"), allow(dead_code))]
    rayon_partials: Vec<NeighborList>,
    stats: NeighborWorkspaceStats,
}

/// Internal cell-list structure for spatial binning.
///
/// Generalized over periodicity and cell thickness (OVITO
/// CutoffNeighborFinder approach) so every large system takes the O(n)
/// path — the previous implementation refused mixed/non-periodic pbc and
/// cells thinner than the cutoff, falling back to O(n²) brute force
/// (1.9s vs 33ms at ~20k atoms):
///
/// - Periodic axes bin the wrapped cell [0,1). Atoms are wrapped in and
///   their integer shift recorded; emitted images are corrected back so
///   results refer to the ORIGINAL (unwrapped) coordinates, matching the
///   brute-force path.
/// - Non-periodic axes bin the atoms' actual fractional extent; stencil
///   offsets that leave the grid are skipped ("clamp, no ghosts").
/// - The stencil spans ceil(cutoff / bin_height) bins per axis, so a
///   periodic axis thinner than the cutoff naturally yields multi-image
///   neighbors (|image| ≥ 2) instead of forcing brute force.
///
/// Storage is CSR-style: atoms are bucketed per bin with a stable counting
/// sort and their wrapped Cartesian coordinates are kept in bin-sorted SoA
/// arrays (`xs`/`ys`/`zs`), so the inner distance loop streams contiguous
/// memory — cache-friendly, bounds-check-free, and SIMD-vectorizable (see
/// `scan_bin_hits` for the wasm simd128 f64x2 path).
#[derive(Default)]
struct CellList {
    /// CSR bin offsets into `bin_atoms`/`xs`/`ys`/`zs`; length total_bins + 1.
    bin_start: Vec<u32>,
    /// Atom indices sorted by bin (ascending within each bin — the counting
    /// sort is stable, matching the previous `Vec<Vec<usize>>` push order).
    bin_atoms: Vec<u32>,
    /// Per-atom linear bin index used by the stable counting sort.
    atom_linear_bin: Vec<u32>,
    /// Counting-sort cursor scratch, one entry per bin.
    cursor: Vec<u32>,
    /// Per-atom 3D bin coordinates (original atom order).
    atom_bins: Vec<[usize; 3]>,
    /// Per-atom integer wrap shift on periodic axes (s = floor(frac)).
    wrap_shifts: Vec<[i32; 3]>,
    /// Wrapped Cartesian coordinates in bin-sorted slot order, SoA layout —
    /// the positions distances are evaluated against.
    xs: Vec<f64>,
    ys: Vec<f64>,
    zs: Vec<f64>,
    /// Wrapped Cartesian per original atom index (center-side lookups).
    wrapped_cart: Vec<Vector3<f64>>,
}

impl CellList {
    /// Rebuild frame occupancy while retaining all vector allocations.
    fn rebuild(
        &mut self,
        frac_coords: &[Vector3<f64>],
        lattice: &Lattice,
        plan: &CellGridPlan,
        stats: &mut NeighborWorkspaceStats,
    ) {
        let n_atoms = frac_coords.len();
        let matrix = lattice.matrix();
        let total_bins = plan.n_bins[0] * plan.n_bins[1] * plan.n_bins[2];
        clear_and_resize_tracked(&mut self.bin_start, total_bins + 1, 0, stats);
        clear_and_reserve_tracked(&mut self.atom_bins, n_atoms, stats);
        clear_and_reserve_tracked(&mut self.wrap_shifts, n_atoms, stats);
        clear_and_reserve_tracked(&mut self.wrapped_cart, n_atoms, stats);
        clear_and_reserve_tracked(&mut self.atom_linear_bin, n_atoms, stats);
        // bin_start doubles as the counting-sort histogram (offset by one).

        for frac in frac_coords {
            let mut wrapped = *frac;
            let mut shift = [0i32; 3];
            let mut bin = [0usize; 3];
            for axis in 0..3 {
                debug_assert!(
                    (plan.bin_size_frac[axis] * plan.n_bins[axis] as f64 - plan.extent_frac[axis])
                        .abs()
                        <= f64::EPSILON * plan.extent_frac[axis].abs().max(1.0)
                );
                if plan.pbc[axis] {
                    let s = frac[axis].floor();
                    shift[axis] = s as i32;
                    wrapped[axis] = frac[axis] - s;
                    bin[axis] = ((wrapped[axis] / plan.bin_size_frac[axis]).floor() as usize)
                        .min(plan.n_bins[axis] - 1);
                } else {
                    // Clamp instead of wrap — outliers land in edge bins.
                    let rel = frac[axis] - plan.origin_frac[axis];
                    bin[axis] = ((rel / plan.bin_size_frac[axis]).floor() as isize)
                        .clamp(0, plan.n_bins[axis] as isize - 1)
                        as usize;
                }
            }
            self.wrapped_cart.push(matrix.transpose() * wrapped);
            let bin_idx =
                bin[0] + bin[1] * plan.n_bins[0] + bin[2] * plan.n_bins[0] * plan.n_bins[1];
            self.atom_linear_bin.push(bin_idx as u32);
            self.bin_start[bin_idx + 1] += 1;
            self.atom_bins.push(bin);
            self.wrap_shifts.push(shift);
        }

        // CSR prefix sum, then a stable counting sort placing atom indices and
        // their wrapped coordinates (SoA) into bin-sorted slots.
        for b in 0..total_bins {
            self.bin_start[b + 1] += self.bin_start[b];
        }
        clear_and_reserve_tracked(&mut self.cursor, total_bins, stats);
        self.cursor.extend_from_slice(&self.bin_start[..total_bins]);
        clear_and_resize_tracked(&mut self.bin_atoms, n_atoms, 0, stats);
        clear_and_resize_tracked(&mut self.xs, n_atoms, 0.0, stats);
        clear_and_resize_tracked(&mut self.ys, n_atoms, 0.0, stats);
        clear_and_resize_tracked(&mut self.zs, n_atoms, 0.0, stats);
        for (atom_idx, &bin_idx) in self.atom_linear_bin.iter().enumerate() {
            let slot = self.cursor[bin_idx as usize] as usize;
            self.cursor[bin_idx as usize] += 1;
            self.bin_atoms[slot] = atom_idx as u32;
            let cart = self.wrapped_cart[atom_idx];
            self.xs[slot] = cart.x;
            self.ys[slot] = cart.y;
            self.zs[slot] = cart.z;
        }
    }

    /// Get the linear bin index from 3D bin coordinates.
    #[inline]
    fn bin_index(plan: &CellGridPlan, bin: [usize; 3]) -> usize {
        bin[0] + bin[1] * plan.n_bins[0] + bin[2] * plan.n_bins[0] * plan.n_bins[1]
    }

    /// Collect the neighbors of `center_idx` within `cutoff` into `out`.
    /// Emitted images refer to the original (unwrapped) input coordinates.
    fn neighbors_of(
        &self,
        center_idx: usize,
        plan: &CellGridPlan,
        lattice_vecs: &[Vector3<f64>; 3],
        config: &NeighborListConfig,
        out: &mut NeighborList,
    ) {
        let cutoff_sq = config.cutoff * config.cutoff;
        let tol_sq = config.numerical_tol * config.numerical_tol;
        let center_bin = self.atom_bins[center_idx];
        let center_cart = self.wrapped_cart[center_idx];
        let center_shift = self.wrap_shifts[center_idx];

        for offsets in &plan.stencil {
            let mut bin = [0usize; 3];
            let mut base_image = [0i32; 3];
            let mut in_range = true;
            for axis in 0..3 {
                let target = center_bin[axis] as i32 + offsets[axis];
                let n = plan.n_bins[axis] as i32;
                if plan.pbc[axis] {
                    // Each stencil offset maps to a unique (bin, image) pair,
                    // so multi-period stencils never emit duplicates.
                    base_image[axis] = target.div_euclid(n);
                    bin[axis] = target.rem_euclid(n) as usize;
                } else if target < 0 || target >= n {
                    in_range = false;
                    break;
                } else {
                    bin[axis] = target as usize;
                }
            }
            if !in_range {
                continue;
            }

            let offset_cart = (base_image[0] as f64) * lattice_vecs[0]
                + (base_image[1] as f64) * lattice_vecs[1]
                + (base_image[2] as f64) * lattice_vecs[2];
            // Fold the image shift into the center once:
            //   |neighbor + offset − center| == |neighbor − (center − offset)|
            let cx = center_cart.x - offset_cart.x;
            let cy = center_cart.y - offset_cart.y;
            let cz = center_cart.z - offset_cart.z;

            let b = Self::bin_index(plan, bin);
            let start = self.bin_start[b] as usize;
            let end = self.bin_start[b + 1] as usize;
            scan_bin_hits(
                &self.xs[start..end],
                &self.ys[start..end],
                &self.zs[start..end],
                [cx, cy, cz],
                cutoff_sq,
                |k, dist_sq| {
                    let neighbor_idx = self.bin_atoms[start + k] as usize;
                    // Express the image against the original coordinates:
                    // wrapped_j + L·m − wrapped_i  ==  orig_j + L·(m − s_j + s_i) − orig_i
                    let neighbor_shift = self.wrap_shifts[neighbor_idx];
                    let image = [
                        base_image[0] - neighbor_shift[0] + center_shift[0],
                        base_image[1] - neighbor_shift[1] + center_shift[1],
                        base_image[2] - neighbor_shift[2] + center_shift[2],
                    ];
                    let is_self =
                        center_idx == neighbor_idx && image == [0, 0, 0] && dist_sq < tol_sq;
                    if !is_self || config.self_interaction {
                        out.push(center_idx, neighbor_idx, dist_sq.sqrt(), image);
                    }
                },
            );
        }
    }
}

impl NeighborSearchWorkspace {
    /// Rebuild an exact neighbor list from fractional coordinates.
    ///
    /// Fully periodic frames reuse grid geometry only when atom count,
    /// cutoff bits, lattice bits, and PBC are all identical. Open axes
    /// always rebuild the plan because their extents depend on positions.
    pub fn rebuild_from_fractional<'a>(
        &'a mut self,
        frac_coords: &[Vector3<f64>],
        lattice: &Lattice,
        config: &NeighborListConfig,
    ) -> &'a NeighborList {
        self.neighbors.clear();
        if config.cutoff <= 0.0 {
            return &self.neighbors;
        }

        if lattice.pbc.iter().all(|&periodic| periodic) {
            let key = FixedPeriodicGridKey::new(frac_coords.len(), lattice, config.cutoff);
            if self.fixed_periodic_key.as_ref() == Some(&key) && self.grid_plan.is_some() {
                self.stats.grid_cache_hits += 1;
            } else {
                self.grid_plan = Some(CellGridPlan::build(frac_coords, lattice, config.cutoff));
                self.fixed_periodic_key = Some(key);
                self.stats.grid_rebuilds += 1;
            }
        } else {
            self.grid_plan = Some(CellGridPlan::build(frac_coords, lattice, config.cutoff));
            self.fixed_periodic_key = None;
            self.stats.grid_rebuilds += 1;
        }

        let plan = self
            .grid_plan
            .as_ref()
            .expect("positive-cutoff search must have a grid plan");
        self.cell_list
            .rebuild(frac_coords, lattice, plan, &mut self.stats);

        let matrix = lattice.matrix();
        let lattice_vecs = [
            matrix.row(0).transpose(),
            matrix.row(1).transpose(),
            matrix.row(2).transpose(),
        ];
        let n_atoms = frac_coords.len();
        let estimated_pairs = n_atoms.saturating_mul(12);

        #[cfg(feature = "rayon")]
        {
            let n_threads = rayon::current_num_threads().max(1);
            let chunk_size = n_atoms.div_ceil(n_threads * 4).max(64);
            let chunk_count = n_atoms.div_ceil(chunk_size);
            reserve_total_tracked(&mut self.rayon_partials, chunk_count, &mut self.stats);
            while self.rayon_partials.len() < chunk_count {
                self.rayon_partials.push(NeighborList::default());
            }
            for (chunk_idx, partial) in self.rayon_partials[..chunk_count].iter_mut().enumerate() {
                let chunk_start = chunk_idx * chunk_size;
                let chunk_end = (chunk_start + chunk_size).min(n_atoms);
                prepare_neighbor_list(
                    partial,
                    (chunk_end - chunk_start).saturating_mul(14),
                    &mut self.stats,
                );
            }

            let implicit_partial_growths: u64 = self.rayon_partials[..chunk_count]
                .par_iter_mut()
                .enumerate()
                .map(|(chunk_idx, partial)| {
                    let before = neighbor_capacities(partial);
                    let chunk_start = chunk_idx * chunk_size;
                    let chunk_end = (chunk_start + chunk_size).min(n_atoms);
                    for center_idx in chunk_start..chunk_end {
                        self.cell_list.neighbors_of(
                            center_idx,
                            plan,
                            &lattice_vecs,
                            config,
                            partial,
                        );
                    }
                    capacity_change_count(before, neighbor_capacities(partial))
                })
                .sum();
            self.stats.capacity_growths += implicit_partial_growths;

            prepare_neighbor_list(&mut self.neighbors, estimated_pairs, &mut self.stats);
            let before = neighbor_capacities(&self.neighbors);
            for partial in &self.rayon_partials[..chunk_count] {
                self.neighbors.extend_from(partial);
            }
            self.stats.capacity_growths +=
                capacity_change_count(before, neighbor_capacities(&self.neighbors));
        }

        #[cfg(not(feature = "rayon"))]
        {
            prepare_neighbor_list(&mut self.neighbors, estimated_pairs, &mut self.stats);
            let before = neighbor_capacities(&self.neighbors);
            for center_idx in 0..n_atoms {
                self.cell_list.neighbors_of(
                    center_idx,
                    plan,
                    &lattice_vecs,
                    config,
                    &mut self.neighbors,
                );
            }
            self.stats.capacity_growths +=
                capacity_change_count(before, neighbor_capacities(&self.neighbors));
        }

        &self.neighbors
    }

    /// Return current cache and capacity-growth counters.
    pub fn stats(&self) -> NeighborWorkspaceStats {
        self.stats
    }

    /// Consume the workspace and return its most recently rebuilt list.
    pub fn into_neighbor_list(self) -> NeighborList {
        self.neighbors
    }
}

/// Invoke `hit(k, dist_sq)` for every slot `k` whose point lies within
/// `cutoff_sq` of the (offset-folded) `center`, in ascending `k`.
///
/// On wasm32 builds compiled with `+simd128` an explicit `f64x2` path
/// evaluates two candidates per iteration and fast-rejects misses (the common
/// case) with a single vector compare; the scalar loop keeps no-SIMD wasm
/// builds and native builds (where rayon owns the parallelism) working
/// unchanged.
#[inline]
fn scan_bin_hits(
    xs: &[f64],
    ys: &[f64],
    zs: &[f64],
    center: [f64; 3],
    cutoff_sq: f64,
    mut hit: impl FnMut(usize, f64),
) {
    let [cx, cy, cz] = center;
    let n = xs.len();
    debug_assert!(ys.len() == n && zs.len() == n);

    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    {
        use core::arch::wasm32::*;
        let cxv = f64x2_splat(cx);
        let cyv = f64x2_splat(cy);
        let czv = f64x2_splat(cz);
        let cutv = f64x2_splat(cutoff_sq);
        let mut k = 0usize;
        while k + 2 <= n {
            // SAFETY: k + 1 < n bounds both lanes; wasm v128_load supports
            // unaligned addresses (alignment is only a hint in wasm).
            let d2 = unsafe {
                let xv = v128_load(xs.as_ptr().add(k) as *const v128);
                let yv = v128_load(ys.as_ptr().add(k) as *const v128);
                let zv = v128_load(zs.as_ptr().add(k) as *const v128);
                let dx = f64x2_sub(xv, cxv);
                let dy = f64x2_sub(yv, cyv);
                let dz = f64x2_sub(zv, czv);
                f64x2_add(
                    f64x2_add(f64x2_mul(dx, dx), f64x2_mul(dy, dy)),
                    f64x2_mul(dz, dz),
                )
            };
            if v128_any_true(f64x2_le(d2, cutv)) {
                let d2a = f64x2_extract_lane::<0>(d2);
                if d2a <= cutoff_sq {
                    hit(k, d2a);
                }
                let d2b = f64x2_extract_lane::<1>(d2);
                if d2b <= cutoff_sq {
                    hit(k + 1, d2b);
                }
            }
            k += 2;
        }
        if k < n {
            let dx = xs[k] - cx;
            let dy = ys[k] - cy;
            let dz = zs[k] - cz;
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 <= cutoff_sq {
                hit(k, d2);
            }
        }
    }

    #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
    for (k, ((&x, &y), &z)) in xs.iter().zip(ys).zip(zs).enumerate() {
        let dx = x - cx;
        let dy = y - cy;
        let dz = z - cz;
        let d2 = dx * dx + dy * dy + dz * dz;
        if d2 <= cutoff_sq {
            hit(k, d2);
        }
    }
}

/// Build a neighbor list using the cell-list algorithm.
///
/// This is the main entry point for neighbor finding. For systems with more than
/// ~100 atoms, this is significantly faster than brute-force O(n²) approaches.
///
/// # Arguments
///
/// * `structure` - The crystal structure to analyze
/// * `config` - Configuration for neighbor list computation
///
/// # Returns
///
/// A `NeighborList` containing all atom pairs within the cutoff distance.
pub fn build_neighbor_list(structure: &Structure, config: &NeighborListConfig) -> NeighborList {
    let n_atoms = structure.num_sites();
    let cutoff = config.cutoff;

    // Handle edge cases
    if n_atoms == 0 || cutoff <= 0.0 {
        return NeighborList::new();
    }

    let lattice = &structure.lattice;
    let pbc = lattice.pbc;
    let frac_coords = &structure.frac_coords;

    // Get Cartesian coordinates and lattice vectors
    let cart_coords = structure.cart_coords();
    let matrix = lattice.matrix();
    let lattice_vecs = [
        matrix.row(0).transpose(),
        matrix.row(1).transpose(),
        matrix.row(2).transpose(),
    ];

    // Compute the search range for periodic images (brute-force path only)
    // For each axis, determine how many periodic images we need to consider
    let volume = lattice.volume();
    let max_images: [i32; 3] = std::array::from_fn(|idx| {
        if !pbc[idx] {
            0
        } else {
            let cross = lattice_vecs[(idx + 1) % 3].cross(&lattice_vecs[(idx + 2) % 3]);
            let height = volume / cross.norm();
            (cutoff / height).ceil() as i32
        }
    });

    // The cell list handles every pbc combination and multi-image thin cells;
    // brute force remains only for small systems where grid setup overhead
    // isn't worth it.
    let use_cell_list = n_atoms > config.cell_list_threshold;

    if use_cell_list {
        let mut workspace = NeighborSearchWorkspace::default();
        workspace.rebuild_from_fractional(frac_coords, lattice, config);
        workspace.into_neighbor_list()
    } else {
        build_neighbor_list_bruteforce(&cart_coords, &lattice_vecs, pbc, &max_images, config)
    }
}

/// Build neighbor list using brute-force O(n²) algorithm.
///
/// Used only for small systems where cell-list setup overhead isn't worth
/// it. Note: assumes coordinates are inside (or near) the unit cell — its
/// ±max_images window is sized from the cutoff/cell ratio, so far-unwrapped
/// coordinates can fall outside the searched image range (the cell-list
/// path wraps and is exact for any input).
fn build_neighbor_list_bruteforce(
    cart_coords: &[Vector3<f64>],
    lattice_vecs: &[Vector3<f64>; 3],
    pbc: [bool; 3],
    max_images: &[i32; 3],
    config: &NeighborListConfig,
) -> NeighborList {
    let n_atoms = cart_coords.len();
    let cutoff = config.cutoff;
    let cutoff_sq = cutoff * cutoff;
    let tol_sq = config.numerical_tol * config.numerical_tol;

    // Estimate capacity
    let estimated_pairs = n_atoms * 12;
    let mut result = NeighborList::with_capacity(estimated_pairs);

    // Image ranges (only check non-negative for non-periodic)
    let x_range: Vec<i32> = if pbc[0] {
        (-max_images[0]..=max_images[0]).collect()
    } else {
        vec![0]
    };
    let y_range: Vec<i32> = if pbc[1] {
        (-max_images[1]..=max_images[1]).collect()
    } else {
        vec![0]
    };
    let z_range: Vec<i32> = if pbc[2] {
        (-max_images[2]..=max_images[2]).collect()
    } else {
        vec![0]
    };

    for (center_idx, center_cart) in cart_coords.iter().enumerate() {
        for (neighbor_idx, neighbor_cart) in cart_coords.iter().enumerate() {
            for &dx in &x_range {
                for &dy in &y_range {
                    for &dz in &z_range {
                        let offset = (dx as f64) * lattice_vecs[0]
                            + (dy as f64) * lattice_vecs[1]
                            + (dz as f64) * lattice_vecs[2];

                        let diff = neighbor_cart + offset - center_cart;
                        let dist_sq = diff.norm_squared();

                        if dist_sq <= cutoff_sq {
                            // Check self-interaction
                            let is_self = center_idx == neighbor_idx
                                && dx == 0
                                && dy == 0
                                && dz == 0
                                && dist_sq < tol_sq;

                            if !is_self || config.self_interaction {
                                result.push(center_idx, neighbor_idx, dist_sq.sqrt(), [dx, dy, dz]);
                            }
                        }
                    }
                }
            }
        }
    }

    result
}

/// Get neighbors for a single site.
///
/// This is a convenience function that returns only neighbors for one site.
///
/// # Arguments
///
/// * `structure` - The crystal structure
/// * `site_idx` - Index of the site to find neighbors for
/// * `cutoff` - Maximum distance in Angstroms
///
/// # Returns
///
/// A vector of `(neighbor_idx, distance, image)` tuples, sorted by distance.
pub fn get_site_neighbors(
    structure: &Structure,
    site_idx: usize,
    cutoff: f64,
) -> Vec<(usize, f64, [i32; 3])> {
    assert!(
        site_idx < structure.num_sites(),
        "site_idx {} out of bounds (num_sites={})",
        site_idx,
        structure.num_sites()
    );

    let config = NeighborListConfig {
        cutoff,
        ..Default::default()
    };

    let nl = build_neighbor_list(structure, &config);

    // Filter to only include neighbors of the specified site
    let mut neighbors: Vec<_> = nl
        .center_indices
        .iter()
        .enumerate()
        .filter(|&(_, c)| *c == site_idx)
        .map(|(idx, _)| (nl.neighbor_indices[idx], nl.distances[idx], nl.images[idx]))
        .collect();

    // Sort by distance
    neighbors.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    neighbors
}

// === Simple Pair Iterator for Potentials ===

use nalgebra::Matrix3;

/// Iterate over all unique pairs within cutoff distance.
///
/// This is a simpler interface for use with potential calculations
/// that don't need the full Structure object.
///
/// # Arguments
/// * `positions` - Cartesian positions in Angstrom
/// * `cell` - Optional 3x3 cell matrix (rows are lattice vectors)
/// * `pbc` - Periodic boundary conditions [x, y, z]
/// * `cutoff` - Cutoff distance in Angstrom
/// * `callback` - Called for each pair with (i, j, r_ij, distance)
///
/// # Minimum Image Convention
/// Uses minimum image convention: only considers the nearest periodic image
/// of each atom pair. For correct behavior, the cutoff should be less than
/// half the smallest cell dimension. Larger cutoffs may miss some pairs.
///
/// # Example
/// ```rust,ignore
/// for_each_pair(&positions, Some(&cell), [true; 3], 5.0, |i, j, r_ij, dist| {
///     // Compute pair interaction
/// });
/// ```
/// # Errors
/// Returns `FerroxError::PbcWithoutCell` if any PBC direction is enabled but cell is None.
/// Returns `FerroxError::SingularCell` if the cell matrix is non-invertible.
pub fn for_each_pair<F>(
    positions: &[Vector3<f64>],
    cell: Option<&Matrix3<f64>>,
    pbc: [bool; 3],
    cutoff: f64,
    mut callback: F,
) -> crate::error::Result<()>
where
    F: FnMut(usize, usize, Vector3<f64>, f64),
{
    use crate::error::FerroxError;
    use crate::potentials::minimum_image;

    // Guard: PBC requires a cell matrix
    if cell.is_none() && pbc.iter().any(|&enabled| enabled) {
        return Err(FerroxError::PbcWithoutCell);
    }

    let n_atoms = positions.len();
    let cutoff_sq = cutoff * cutoff;
    let inv_cell = cell
        .map(|mat| mat.try_inverse().ok_or(FerroxError::SingularCell))
        .transpose()?;

    // O(N²) iteration - for O(N) use build_neighbor_list() with CellList
    for idx_i in 0..n_atoms {
        for idx_j in (idx_i + 1)..n_atoms {
            let rij = minimum_image(
                positions[idx_j] - positions[idx_i],
                cell,
                inv_cell.as_ref(),
                pbc,
            );

            let dist_sq = rij.norm_squared();
            if dist_sq <= cutoff_sq {
                callback(idx_i, idx_j, rij, dist_sq.sqrt());
            }
        }
    }

    Ok(())
}

/// Count pairs within cutoff distance.
///
/// Useful for estimating memory requirements.
///
/// # Errors
/// Returns `FerroxError::PbcWithoutCell` if any PBC direction is enabled but cell is None.
/// Returns `FerroxError::SingularCell` if the cell matrix is non-invertible.
pub fn count_pairs(
    positions: &[Vector3<f64>],
    cell: Option<&Matrix3<f64>>,
    pbc: [bool; 3],
    cutoff: f64,
) -> crate::error::Result<usize> {
    let mut count = 0;
    for_each_pair(positions, cell, pbc, cutoff, |_, _, _, _| {
        count += 1;
    })?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::element::Element;
    use crate::species::Species;

    fn make_fcc(element: Element, a: f64) -> Structure {
        let lattice = Lattice::cubic(a);
        let species = vec![Species::neutral(element); 4];
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.5, 0.5, 0.0),
            Vector3::new(0.5, 0.0, 0.5),
            Vector3::new(0.0, 0.5, 0.5),
        ];
        Structure::new(lattice, species, frac_coords)
    }

    fn make_bcc(element: Element, a: f64) -> Structure {
        let lattice = Lattice::cubic(a);
        let species = vec![Species::neutral(element); 2];
        let frac_coords = vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(0.5, 0.5, 0.5)];
        Structure::new(lattice, species, frac_coords)
    }

    fn make_simple_cubic(element: Element, a: f64) -> Structure {
        let lattice = Lattice::cubic(a);
        let species = vec![Species::neutral(element)];
        let frac_coords = vec![Vector3::new(0.0, 0.0, 0.0)];
        Structure::new(lattice, species, frac_coords)
    }

    #[test]
    fn test_fcc_coordination() {
        // FCC Cu: each atom has 12 nearest neighbors at a/sqrt(2) ≈ 2.55 Å
        let fcc = make_fcc(Element::Cu, 3.61);
        let config = NeighborListConfig {
            cutoff: 3.0,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&fcc, &config);

        // Count neighbors per site
        let mut counts = [0usize; 4];
        for &center in &nl.center_indices {
            counts[center] += 1;
        }

        // Each site should have 12 neighbors
        for (idx, count) in counts.iter().enumerate() {
            assert_eq!(
                *count, 12,
                "FCC site {idx} has {count} neighbors, expected 12"
            );
        }

        // Check distance (should be a/sqrt(2) ≈ 2.552 Å)
        let expected_dist = 3.61 / 2.0_f64.sqrt();
        for dist in &nl.distances {
            assert!(
                (*dist - expected_dist).abs() < 0.1,
                "Distance {dist} doesn't match expected {expected_dist}"
            );
        }
    }

    #[test]
    fn test_bcc_coordination() {
        // BCC Fe: first shell has 8 neighbors at a*sqrt(3)/2 ≈ 2.48 Å
        let bcc = make_bcc(Element::Fe, 2.87);
        let config = NeighborListConfig {
            cutoff: 2.6,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&bcc, &config);

        // Count neighbors per site
        let mut counts = [0usize; 2];
        for &center in &nl.center_indices {
            counts[center] += 1;
        }

        // Each site should have 8 neighbors
        for (idx, count) in counts.iter().enumerate() {
            assert_eq!(
                *count, 8,
                "BCC site {idx} has {count} neighbors, expected 8"
            );
        }
    }

    #[test]
    fn test_simple_cubic_coordination() {
        // Simple cubic: 6 neighbors at distance a
        let sc = make_simple_cubic(Element::Cu, 3.0);
        let config = NeighborListConfig {
            cutoff: 3.5,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&sc, &config);

        // Should have 6 neighbors (nearest neighbors via PBC)
        assert_eq!(nl.len(), 6, "Simple cubic should have 6 neighbors");

        // All distances should be 3.0 Å
        for dist in &nl.distances {
            assert!(
                (*dist - 3.0).abs() < 0.01,
                "Distance {dist} doesn't match expected 3.0"
            );
        }
    }

    #[test]
    fn test_get_site_neighbors() {
        let fcc = make_fcc(Element::Cu, 3.61);
        let neighbors = get_site_neighbors(&fcc, 0, 3.0);

        assert_eq!(neighbors.len(), 12, "FCC site 0 should have 12 neighbors");

        // Check sorting by distance
        for window in neighbors.windows(2) {
            assert!(
                window[0].1 <= window[1].1,
                "Neighbors should be sorted by distance"
            );
        }
    }

    #[test]
    fn test_empty_structure() {
        let empty = Structure::new(Lattice::cubic(5.0), vec![], vec![]);
        let config = NeighborListConfig::default();
        let nl = build_neighbor_list(&empty, &config);

        assert!(nl.is_empty(), "Empty structure should have no neighbors");
    }

    #[test]
    fn test_zero_cutoff() {
        let fcc = make_fcc(Element::Cu, 3.61);
        let config = NeighborListConfig {
            cutoff: 0.0,
            ..Default::default()
        };
        let nl = build_neighbor_list(&fcc, &config);

        assert!(nl.is_empty(), "Zero cutoff should give no neighbors");
    }

    #[test]
    fn test_negative_cutoff() {
        let fcc = make_fcc(Element::Cu, 3.61);
        let config = NeighborListConfig {
            cutoff: -1.0,
            ..Default::default()
        };
        let nl = build_neighbor_list(&fcc, &config);

        assert!(nl.is_empty(), "Negative cutoff should give no neighbors");
    }

    #[test]
    fn test_self_interaction() {
        let sc = make_simple_cubic(Element::Cu, 3.0);

        // Without self-interaction (should only count periodic images)
        let config_no_self = NeighborListConfig {
            cutoff: 0.1,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };
        let nl_no_self = build_neighbor_list(&sc, &config_no_self);
        assert!(
            nl_no_self.is_empty(),
            "No neighbors within 0.1 Å without self"
        );

        // With self-interaction enabled
        let config_self = NeighborListConfig {
            cutoff: 0.1,
            self_interaction: true,
            numerical_tol: 1e-8,
            ..Default::default()
        };
        let nl_self = build_neighbor_list(&sc, &config_self);
        assert_eq!(nl_self.len(), 1, "Should have 1 self-interaction");
        assert_eq!(nl_self.center_indices[0], nl_self.neighbor_indices[0]);
        assert!(nl_self.distances[0] < 1e-8);
    }

    #[test]
    fn test_periodic_images() {
        // Single atom in a 3 Å cubic cell
        let sc = make_simple_cubic(Element::Cu, 3.0);
        let config = NeighborListConfig {
            cutoff: 5.0, // Should find neighbors at 3.0 Å and 3*sqrt(2) ≈ 4.24 Å
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&sc, &config);

        // Count neighbors by distance
        let first_shell: Vec<_> = nl.distances.iter().filter(|&&d| d < 3.5).collect();
        let second_shell: Vec<_> = nl
            .distances
            .iter()
            .filter(|&&d| (3.5..4.5).contains(&d))
            .collect();

        assert_eq!(first_shell.len(), 6, "6 first-shell neighbors at 3.0 Å");
        assert_eq!(
            second_shell.len(),
            12,
            "12 second-shell neighbors at ~4.24 Å"
        );
    }

    #[test]
    fn test_comparison_with_old_implementation() {
        // This test ensures the new implementation gives the same results as the old one
        let fcc = make_fcc(Element::Cu, 3.61);
        let cutoff = 3.0;

        // Use new implementation
        let config = NeighborListConfig {
            cutoff,
            ..Default::default()
        };
        let nl_new = build_neighbor_list(&fcc, &config);

        // Use old implementation from Structure
        let (old_centers, _old_neighbors, _old_images, old_distances) =
            fcc.get_neighbor_list(cutoff, 1e-8, true);

        // Should have same number of pairs
        assert_eq!(
            nl_new.len(),
            old_centers.len(),
            "New and old implementations should find same number of pairs"
        );

        // Check that all distances are found (order may differ)
        let mut new_dists: Vec<f64> = nl_new.distances.clone();
        let mut old_dists: Vec<f64> = old_distances.clone();
        new_dists.sort_by(|a, b| a.partial_cmp(b).unwrap());
        old_dists.sort_by(|a, b| a.partial_cmp(b).unwrap());

        for (new, old) in new_dists.iter().zip(old_dists.iter()) {
            assert!(
                (new - old).abs() < 1e-6,
                "Distance mismatch: new={new}, old={old}"
            );
        }
    }

    // === Additional comprehensive tests ===

    /// Helper to create a triclinic lattice structure.
    fn make_triclinic(element: Element) -> Structure {
        // Triclinic lattice: a=4.0, b=5.0, c=6.0, alpha=70°, beta=80°, gamma=85°
        let lattice = Lattice::from_parameters(4.0, 5.0, 6.0, 70.0, 80.0, 85.0);
        let species = vec![Species::neutral(element); 4];
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.25, 0.25, 0.25),
            Vector3::new(0.5, 0.5, 0.0),
            Vector3::new(0.75, 0.25, 0.5),
        ];
        Structure::new(lattice, species, frac_coords)
    }

    #[test]
    fn test_triclinic_cell() {
        // Triclinic cells have non-orthogonal lattice vectors
        // Verify correct neighbor finding with skewed coordinates
        let triclinic = make_triclinic(Element::Si);
        let config = NeighborListConfig {
            cutoff: 4.0,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&triclinic, &config);

        // Should find some neighbors
        assert!(!nl.is_empty(), "Triclinic cell should have neighbors");

        // Verify all distances are positive and within cutoff
        for dist in &nl.distances {
            assert!(*dist > 0.0, "Distance should be positive");
            assert!(
                *dist <= config.cutoff + config.numerical_tol,
                "Distance {dist} exceeds cutoff"
            );
        }

        // Verify center/neighbor indices are valid
        let n_sites = triclinic.num_sites();
        for (&center, &neighbor) in nl.center_indices.iter().zip(&nl.neighbor_indices) {
            assert!(center < n_sites, "Invalid center index");
            assert!(neighbor < n_sites, "Invalid neighbor index");
        }

        // Cross-check: manually compute distances for a few pairs
        let cart_coords = triclinic.cart_coords();
        let matrix = triclinic.lattice.matrix();
        let lattice_vecs = [
            matrix.row(0).transpose(),
            matrix.row(1).transpose(),
            matrix.row(2).transpose(),
        ];

        for idx in 0..nl.len().min(10) {
            let center_cart = &cart_coords[nl.center_indices[idx]];
            let neighbor_cart = &cart_coords[nl.neighbor_indices[idx]];
            let image = nl.images[idx];

            let offset = (image[0] as f64) * lattice_vecs[0]
                + (image[1] as f64) * lattice_vecs[1]
                + (image[2] as f64) * lattice_vecs[2];

            let expected_dist = (neighbor_cart + offset - center_cart).norm();
            assert!(
                (nl.distances[idx] - expected_dist).abs() < 1e-10,
                "Distance mismatch: got {}, expected {}",
                nl.distances[idx],
                expected_dist
            );
        }
    }

    #[test]
    fn test_mixed_pbc_xy_only() {
        // Test with PBC only in x and y directions (slab geometry)
        let mut lattice = Lattice::cubic(5.0);
        lattice.pbc = [true, true, false];

        let species = vec![Species::neutral(Element::Cu); 2];
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.1), // near bottom
            Vector3::new(0.0, 0.0, 0.9), // near top
        ];
        let slab = Structure::new(lattice, species, frac_coords);

        let config = NeighborListConfig {
            cutoff: 6.0, // larger than cell, should NOT wrap in z
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&slab, &config);

        // Atoms are 4.0 Å apart in z (0.8 * 5.0 = 4.0)
        // With no PBC in z, they should be found as neighbors at ~4.0 Å
        // But should NOT find neighbors via z-wrapping (which would be 1.0 Å)

        // Check that all z-image offsets are 0
        for image in &nl.images {
            assert_eq!(
                image[2], 0,
                "z-periodic image should be 0 when pbc[2]=false"
            );
        }

        // Verify we find the direct pair
        let found_direct = nl.distances.iter().any(|&d| (d - 4.0).abs() < 0.1);
        assert!(found_direct, "Should find direct neighbor at ~4.0 Å");

        // Should NOT find wrapped pair at ~1.0 Å
        let found_wrapped = nl.distances.iter().any(|&d| d < 2.0);
        assert!(
            !found_wrapped,
            "Should NOT find z-wrapped neighbor when pbc[2]=false"
        );
    }

    #[test]
    fn test_mixed_pbc_z_only() {
        // Test with PBC only in z direction (wire geometry)
        let mut lattice = Lattice::cubic(3.0);
        lattice.pbc = [false, false, true];

        let species = vec![Species::neutral(Element::Cu)];
        let frac_coords = vec![Vector3::new(0.5, 0.5, 0.0)];
        let wire = Structure::new(lattice, species, frac_coords);

        let config = NeighborListConfig {
            cutoff: 4.0,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&wire, &config);

        // Should find neighbors via z-periodic images only
        // Distance should be 3.0 Å (one cell in z)
        assert!(!nl.is_empty(), "Should find z-periodic neighbors");

        // All images should have x=0, y=0
        for image in &nl.images {
            assert_eq!(image[0], 0, "x-image should be 0 when pbc[0]=false");
            assert_eq!(image[1], 0, "y-image should be 0 when pbc[1]=false");
        }
    }

    #[test]
    fn test_cutoff_larger_than_cell() {
        // When cutoff > cell dimension, multiple periodic images are needed
        let small_cell = make_simple_cubic(Element::Cu, 2.0); // 2 Å cell
        let config = NeighborListConfig {
            cutoff: 5.0, // 2.5x the cell size
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&small_cell, &config);

        // Should find neighbors at 2.0 Å (1 cell), ~2.83 Å (face diagonal),
        // ~3.46 Å (body diagonal), 4.0 Å (2 cells), etc.

        // Count neighbors at different distance shells
        let shell_2: usize = nl.distances.iter().filter(|&&d| d < 2.5).count();
        let shell_3: usize = nl
            .distances
            .iter()
            .filter(|&&d| (2.5..3.1).contains(&d))
            .count();
        let shell_4: usize = nl
            .distances
            .iter()
            .filter(|&&d| (3.1..3.7).contains(&d))
            .count();

        assert_eq!(shell_2, 6, "First shell (2.0 Å): expected 6 neighbors");
        assert_eq!(shell_3, 12, "Second shell (~2.83 Å): expected 12 neighbors");
        assert_eq!(shell_4, 8, "Third shell (~3.46 Å): expected 8 neighbors");
        // Fourth shell includes neighbors at 4.0 Å and also via diagonal paths
        // so we just verify it's non-empty rather than exact count

        // Verify image magnitudes
        for image in &nl.images {
            // For cutoff=5.0 and cell=2.0, max image should be ceil(5/2)=3
            for &img_coord in image {
                assert!(img_coord.abs() <= 3, "Image offset too large: {:?}", image);
            }
        }
    }

    #[test]
    fn test_boundary_atoms() {
        // Test atoms at fractional coordinates 0.0 and 0.5
        // These are at cell boundaries and can have numerical issues
        let lattice = Lattice::cubic(4.0);
        let species = vec![Species::neutral(Element::Cu); 3];
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0), // corner
            Vector3::new(0.5, 0.5, 0.5), // body center
            Vector3::new(0.5, 0.0, 0.5), // face center
        ];
        let boundary = Structure::new(lattice, species, frac_coords);

        let config = NeighborListConfig {
            cutoff: 5.0,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&boundary, &config);

        // Check that all distances are valid (positive and within cutoff)
        for dist in &nl.distances {
            assert!(*dist > 1e-10, "Spurious zero distance found");
            assert!(*dist <= config.cutoff + 1e-8, "Distance exceeds cutoff");
        }

        // Verify we found some neighbors
        assert!(!nl.is_empty(), "Should find neighbors for boundary atoms");
    }

    #[test]
    fn test_atoms_at_exact_fractional_positions() {
        // Test atoms at exactly 0.0 and 1.0 - these should be equivalent
        let lattice = Lattice::cubic(3.0);
        let species = vec![Species::neutral(Element::Cu); 2];

        // Both atoms at the same position (0.0 = 1.0 due to PBC)
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 1.0, 1.0), // wraps to (0,0,0)
        ];
        let overlap = Structure::new(lattice, species, frac_coords);

        let config = NeighborListConfig {
            cutoff: 0.1,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&overlap, &config);

        // Atoms at same position should find each other at ~0 distance
        // But this is essentially self-interaction, depends on tolerance
        // With numerical_tol=1e-8, distances < 1e-8 are treated as self

        // The key check is no crashes or infinite loops
        assert!(
            nl.len() <= 2,
            "Should have at most 2 pairs (each direction)"
        );
    }

    #[test]
    fn test_large_system_scaling() {
        // Test with 1000+ atoms to verify O(n) scaling
        let lattice_const = 3.61;
        let supercell_size = 6; // 6x6x6 supercell = 6^3 * 4 = 864 atoms

        let supercell_lattice = Lattice::cubic(lattice_const * supercell_size as f64);
        let num_cells = supercell_size * supercell_size * supercell_size;
        let mut species = Vec::with_capacity(num_cells * 4);
        let mut frac_coords = Vec::with_capacity(num_cells * 4);

        let fcc_basis = [
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.5, 0.5, 0.0),
            Vector3::new(0.5, 0.0, 0.5),
            Vector3::new(0.0, 0.5, 0.5),
        ];

        for idx_a in 0..supercell_size {
            for idx_b in 0..supercell_size {
                for idx_c in 0..supercell_size {
                    for base in &fcc_basis {
                        let frac = Vector3::new(
                            (base.x + idx_a as f64) / supercell_size as f64,
                            (base.y + idx_b as f64) / supercell_size as f64,
                            (base.z + idx_c as f64) / supercell_size as f64,
                        );
                        frac_coords.push(frac);
                        species.push(Species::neutral(Element::Cu));
                    }
                }
            }
        }

        let large_system = Structure::new(supercell_lattice, species, frac_coords);
        let n_atoms = large_system.num_sites();
        assert!(
            n_atoms >= 800,
            "Should have at least 800 atoms, got {n_atoms}"
        );

        let config = NeighborListConfig {
            cutoff: 3.0,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        // Time the neighbor finding
        let start = std::time::Instant::now();
        let nl = build_neighbor_list(&large_system, &config);
        let elapsed = start.elapsed();

        // Should complete in reasonable time (< 2 seconds even without rayon)
        assert!(
            elapsed.as_secs_f64() < 2.0,
            "Neighbor finding took too long: {:.2}s for {} atoms",
            elapsed.as_secs_f64(),
            n_atoms
        );

        // Verify correctness: each atom should have ~12 neighbors (FCC first shell)
        let mut counts = vec![0usize; n_atoms];
        for &center in &nl.center_indices {
            counts[center] += 1;
        }

        // All atoms should have exactly 12 neighbors
        let all_have_12 = counts.iter().all(|&c| c == 12);
        assert!(
            all_have_12,
            "All FCC atoms should have 12 neighbors within 3.0 Å cutoff"
        );
    }

    #[test]
    fn test_numerical_tolerance_at_cutoff() {
        // Test atoms exactly at the cutoff distance
        // This verifies proper handling of floating-point edge cases
        let a = 3.0;
        let cutoff = 3.0; // Exactly equals lattice constant

        let sc = make_simple_cubic(Element::Cu, a);
        let config = NeighborListConfig {
            cutoff,
            ..Default::default()
        };

        let nl = build_neighbor_list(&sc, &config);

        // First shell neighbors are exactly at cutoff distance
        // Should include them (cutoff comparison is <=)
        assert_eq!(nl.len(), 6, "Should find 6 neighbors at exactly cutoff");

        for dist in &nl.distances {
            assert!(
                (*dist - cutoff).abs() < 1e-10,
                "All neighbors should be at exactly {cutoff} Å"
            );
        }
    }

    #[test]
    fn test_numerical_tolerance_just_inside_cutoff() {
        // Neighbors slightly inside the cutoff
        let a = 2.9999999;
        let cutoff = 3.0;

        let sc = make_simple_cubic(Element::Cu, a);
        let config = NeighborListConfig {
            cutoff,
            ..Default::default()
        };

        let nl = build_neighbor_list(&sc, &config);

        // Should find neighbors (distance < cutoff)
        assert_eq!(nl.len(), 6, "Should find 6 neighbors just inside cutoff");
    }

    #[test]
    fn test_numerical_tolerance_just_outside_cutoff() {
        // Neighbors slightly outside the cutoff
        let a = 3.0000001;
        let cutoff = 3.0;

        let sc = make_simple_cubic(Element::Cu, a);
        let config = NeighborListConfig {
            cutoff,
            ..Default::default()
        };

        let nl = build_neighbor_list(&sc, &config);

        // Should NOT find neighbors (distance > cutoff)
        assert!(
            nl.is_empty(),
            "Should not find neighbors just outside cutoff"
        );
    }

    #[test]
    fn test_very_small_cell() {
        // Test with cell smaller than typical interatomic distances
        let lattice = Lattice::cubic(1.5); // Very small cell
        let species = vec![Species::neutral(Element::H); 2];
        let frac_coords = vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(0.5, 0.5, 0.5)];
        let small = Structure::new(lattice, species, frac_coords);

        let config = NeighborListConfig {
            cutoff: 5.0, // Much larger than cell
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&small, &config);

        // 2-atom cell (a=1.5 Å) with cutoff=5.0 Å spans many periodic images
        // Each atom should have many neighbors due to the large cutoff/cell ratio
        // Key invariant: neighbor count should be symmetric (each atom has same count)
        let count_0 = nl.center_indices.iter().filter(|&&c| c == 0).count();
        let count_1 = nl.center_indices.iter().filter(|&&c| c == 1).count();
        assert_eq!(
            count_0, count_1,
            "Both atoms should have same neighbor count"
        );
        assert!(
            count_0 > 100,
            "Should have many neighbors with cutoff >> cell size"
        );

        // Verify no duplicates (same center-neighbor-image triple)
        let mut pairs: std::collections::HashSet<(usize, usize, [i32; 3])> =
            std::collections::HashSet::new();
        for idx in 0..nl.len() {
            let triple = (
                nl.center_indices[idx],
                nl.neighbor_indices[idx],
                nl.images[idx],
            );
            assert!(pairs.insert(triple), "Duplicate pair found: {:?}", triple);
        }
    }

    #[test]
    fn test_hexagonal_lattice() {
        // Test with hexagonal close-packed structure
        let lattice = Lattice::hexagonal(2.95, 4.68); // HCP Mg
        let species = vec![Species::neutral(Element::Mg); 2];
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0 / 3.0, 2.0 / 3.0, 0.5),
        ];
        let hcp = Structure::new(lattice, species, frac_coords);

        let config = NeighborListConfig {
            cutoff: 3.5,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&hcp, &config);

        // HCP should have CN=12 for first coordination shell
        // (6 in-plane + 3 above + 3 below)
        let mut counts = [0, 0];
        for &center in &nl.center_indices {
            counts[center] += 1;
        }

        // Both atoms should have 12 neighbors
        assert_eq!(counts[0], 12, "HCP site 0 should have CN=12");
        assert_eq!(counts[1], 12, "HCP site 1 should have CN=12");
    }

    #[test]
    fn test_monoclinic_lattice() {
        // Test with monoclinic lattice (one non-right angle)
        let lattice = Lattice::from_parameters(5.0, 4.0, 6.0, 90.0, 110.0, 90.0);
        let species = vec![Species::neutral(Element::Si); 2];
        let frac_coords = vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(0.5, 0.5, 0.5)];
        let monoclinic = Structure::new(lattice, species, frac_coords);

        let config = NeighborListConfig {
            cutoff: 4.0,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&monoclinic, &config);

        // Verify distances are correct
        let cart_coords = monoclinic.cart_coords();
        let matrix = monoclinic.lattice.matrix();
        let lattice_vecs = [
            matrix.row(0).transpose(),
            matrix.row(1).transpose(),
            matrix.row(2).transpose(),
        ];

        for idx in 0..nl.len() {
            let center_cart = &cart_coords[nl.center_indices[idx]];
            let neighbor_cart = &cart_coords[nl.neighbor_indices[idx]];
            let image = nl.images[idx];

            let offset = (image[0] as f64) * lattice_vecs[0]
                + (image[1] as f64) * lattice_vecs[1]
                + (image[2] as f64) * lattice_vecs[2];

            let expected_dist = (neighbor_cart + offset - center_cart).norm();
            assert!(
                (nl.distances[idx] - expected_dist).abs() < 1e-10,
                "Monoclinic distance mismatch"
            );
        }
    }

    #[test]
    fn test_neighbor_list_symmetry() {
        // For full PBC, if A neighbors B at distance d with image I,
        // then B should neighbor A at distance d with image -I
        let fcc = make_fcc(Element::Cu, 3.61);
        let config = NeighborListConfig {
            cutoff: 3.0,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&fcc, &config);

        // Build a set of all (center, neighbor, image) pairs
        let pairs: std::collections::HashSet<(usize, usize, [i32; 3])> = nl
            .center_indices
            .iter()
            .enumerate()
            .map(|(idx, &center)| (center, nl.neighbor_indices[idx], nl.images[idx]))
            .collect();

        // For each pair, check that the reverse exists
        for (center, neighbor, image) in &pairs {
            let reverse_image = [-image[0], -image[1], -image[2]];
            assert!(
                pairs.contains(&(*neighbor, *center, reverse_image)),
                "Missing reverse pair: ({neighbor}, {center}, {reverse_image:?})"
            );
        }
    }

    #[test]
    fn test_triclinic_cell_60_70_80() {
        // Triclinic with angles 60°, 70°, 80° as specified
        let lattice = Lattice::from_parameters(4.0, 4.5, 5.0, 60.0, 70.0, 80.0);
        let species = vec![Species::neutral(Element::Si); 4];
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.25, 0.25, 0.25),
            Vector3::new(0.5, 0.5, 0.0),
            Vector3::new(0.75, 0.25, 0.5),
        ];
        let triclinic = Structure::new(lattice, species, frac_coords);

        let config = NeighborListConfig {
            cutoff: 4.0,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&triclinic, &config);

        // Verify we find neighbors
        assert!(
            !nl.is_empty(),
            "Triclinic (60°, 70°, 80°) should have neighbors"
        );

        // Verify distances are within cutoff
        for dist in &nl.distances {
            assert!(*dist > 0.0 && *dist <= config.cutoff + 1e-8);
        }

        // Cross-validate distances by manual computation
        let cart_coords = triclinic.cart_coords();
        let matrix = triclinic.lattice.matrix();
        let lattice_vecs = [
            matrix.row(0).transpose(),
            matrix.row(1).transpose(),
            matrix.row(2).transpose(),
        ];

        for idx in 0..nl.len() {
            let center_cart = &cart_coords[nl.center_indices[idx]];
            let neighbor_cart = &cart_coords[nl.neighbor_indices[idx]];
            let image = nl.images[idx];

            let offset = (image[0] as f64) * lattice_vecs[0]
                + (image[1] as f64) * lattice_vecs[1]
                + (image[2] as f64) * lattice_vecs[2];

            let expected_dist = (neighbor_cart + offset - center_cart).norm();
            assert!(
                (nl.distances[idx] - expected_dist).abs() < 1e-10,
                "Distance mismatch in triclinic cell"
            );
        }
    }

    #[test]
    fn test_mixed_pbc_all_combinations() {
        // Test all 8 combinations of PBC settings
        let pbc_combos: [[bool; 3]; 8] = [
            [false, false, false],
            [true, false, false],
            [false, true, false],
            [false, false, true],
            [true, true, false],
            [true, false, true],
            [false, true, true],
            [true, true, true],
        ];

        for pbc in pbc_combos {
            let mut lattice = Lattice::cubic(4.0);
            lattice.pbc = pbc;

            let species = vec![Species::neutral(Element::Cu); 2];
            let frac_coords = vec![Vector3::new(0.1, 0.1, 0.1), Vector3::new(0.9, 0.9, 0.9)];
            let structure = Structure::new(lattice, species, frac_coords);

            let config = NeighborListConfig {
                cutoff: 5.0,
                self_interaction: false,
                numerical_tol: 1e-8,
                ..Default::default()
            };

            let nl = build_neighbor_list(&structure, &config);

            // Verify that periodic images only appear in periodic directions
            for image in &nl.images {
                for (axis, &is_periodic) in pbc.iter().enumerate() {
                    if !is_periodic {
                        assert_eq!(
                            image[axis], 0,
                            "Non-periodic axis {} has non-zero image {:?} for pbc={:?}",
                            axis, image, pbc
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn test_cutoff_multiple_cell_sizes() {
        // Test cutoffs that are 2x, 3x, and 4x the cell dimension
        let a = 2.0;
        let sc = make_simple_cubic(Element::Cu, a);

        for multiplier in [2.0, 3.0, 4.0] {
            let cutoff = a * multiplier;
            let config = NeighborListConfig {
                cutoff,
                ..Default::default()
            };

            let nl = build_neighbor_list(&sc, &config);

            // Count neighbors at exactly a distance
            for shell in 1..=(multiplier as i32) {
                let shell_dist = (shell as f64) * a;
                let count = nl
                    .distances
                    .iter()
                    .filter(|&&d| (d - shell_dist).abs() < 0.01)
                    .count();

                if shell == 1 {
                    assert_eq!(count, 6, "Shell {shell} should have 6 neighbors");
                }
            }

            // Verify max image magnitude
            let max_expected = (cutoff / a).ceil() as i32;
            for image in &nl.images {
                for &coord in image {
                    assert!(
                        coord.abs() <= max_expected,
                        "Image coord {} exceeds expected max {} for cutoff={}",
                        coord,
                        max_expected,
                        cutoff
                    );
                }
            }
        }
    }

    #[test]
    fn test_boundary_atoms_half_coords() {
        // Test atoms at exactly 0.5 fractional coordinates
        let lattice = Lattice::cubic(4.0);
        let species = vec![Species::neutral(Element::Cu); 4];
        let frac_coords = vec![
            Vector3::new(0.0, 0.5, 0.5),
            Vector3::new(0.5, 0.0, 0.5),
            Vector3::new(0.5, 0.5, 0.0),
            Vector3::new(0.5, 0.5, 0.5),
        ];
        let boundary = Structure::new(lattice, species, frac_coords);

        let config = NeighborListConfig {
            cutoff: 3.0,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        let nl = build_neighbor_list(&boundary, &config);

        // Verify correct handling of half-integer positions
        assert!(!nl.is_empty());

        // Verify all distances are positive and within cutoff
        for dist in &nl.distances {
            assert!(*dist > 0.0, "Distance should be positive");
            assert!(
                *dist <= config.cutoff + 1e-8,
                "Distance {} exceeds cutoff",
                dist
            );
        }

        // Expected distances: 2.0 Å (same plane) and sqrt(2)*2 ≈ 2.83 Å (diagonal)
        let has_2_angstrom = nl.distances.iter().any(|&d| (d - 2.0).abs() < 0.01);
        let has_diagonal = nl
            .distances
            .iter()
            .any(|&d| (d - 2.0_f64.sqrt() * 2.0).abs() < 0.01);
        assert!(has_2_angstrom, "Should find neighbors at 2.0 Å");
        assert!(
            has_diagonal,
            "Should find neighbors at ~2.83 Å (face diagonal)"
        );
    }

    #[test]
    fn test_exact_cutoff_boundary_precision() {
        // Test with distances very close to cutoff (within machine precision)
        let epsilon = 1e-14; // Machine epsilon level
        let cutoff = 3.0;

        // Create structure where neighbor is at exactly cutoff - epsilon
        let adjusted_a = cutoff - epsilon;
        let sc = make_simple_cubic(Element::Cu, adjusted_a);

        let config = NeighborListConfig {
            cutoff,
            ..Default::default()
        };

        let nl = build_neighbor_list(&sc, &config);

        // Should find neighbors (distance < cutoff)
        assert!(nl.len() >= 6, "Should find neighbors at cutoff - epsilon");

        // Now test at cutoff + epsilon
        let adjusted_a_plus = cutoff + epsilon;
        let sc_plus = make_simple_cubic(Element::Cu, adjusted_a_plus);
        let nl_plus = build_neighbor_list(&sc_plus, &config);

        // Atoms at distance > cutoff should be excluded
        // The neighbor distance is adjusted_a_plus = cutoff + epsilon > cutoff
        // So neighbors should NOT be included (strict < or <= cutoff policy)
        assert!(
            nl_plus.len() <= 6,
            "Neighbors at cutoff + epsilon should be excluded or at boundary, found {}",
            nl_plus.len()
        );
    }

    #[test]
    fn test_neighbor_counts_different_cutoffs() {
        // Verify neighbor counts increase appropriately with cutoff
        let fcc = make_fcc(Element::Cu, 3.61);
        let expected_dist = 3.61 / 2.0_f64.sqrt(); // ~2.55 Å

        let cutoffs_and_expected: [(f64, usize); 4] = [
            (2.0, 0),           // below first shell
            (3.0, 12),          // first shell (12 neighbors)
            (4.0, 12 + 6),      // first + second shell
            (5.0, 12 + 6 + 24), // first + second + third shell
        ];

        for (cutoff, expected_min) in cutoffs_and_expected {
            let config = NeighborListConfig {
                cutoff,
                ..Default::default()
            };

            let nl = build_neighbor_list(&fcc, &config);
            let total_pairs = nl.len();
            let pairs_per_atom = total_pairs / 4;

            if cutoff > expected_dist {
                assert!(
                    pairs_per_atom >= expected_min / 4,
                    "Cutoff {}: expected at least {} neighbors per atom, got {}",
                    cutoff,
                    expected_min / 4,
                    pairs_per_atom
                );
            }
        }
    }

    // === ASE/torch-sim Compatible Tests ===

    #[test]
    fn test_ase_compatible_neighbor_list_format() {
        // Tests that our neighbor list format matches ASE's NeighborList output:
        // - center_indices[i]: index of center atom for pair i
        // - neighbor_indices[i]: index of neighbor atom for pair i
        // - distances[i]: distance between center and neighbor
        // - images[i]: periodic image shift [n_a, n_b, n_c]
        //
        // This is the standard format used by ASE and torch-sim

        let sc = make_simple_cubic(Element::Cu, 4.0);
        let config = NeighborListConfig {
            cutoff: 5.0,
            ..Default::default()
        };

        let nl = build_neighbor_list(&sc, &config);

        // Verify format: all arrays same length
        assert_eq!(
            nl.center_indices.len(),
            nl.neighbor_indices.len(),
            "center and neighbor indices must have same length"
        );
        assert_eq!(
            nl.center_indices.len(),
            nl.distances.len(),
            "indices and distances must have same length"
        );
        assert_eq!(
            nl.center_indices.len(),
            nl.images.len(),
            "indices and images must have same length"
        );

        // Verify indices are valid
        let n_atoms = sc.num_sites();
        assert!(
            nl.center_indices.iter().all(|&idx| idx < n_atoms),
            "All center indices should be < n_atoms"
        );
        assert!(
            nl.neighbor_indices.iter().all(|&idx| idx < n_atoms),
            "All neighbor indices should be < n_atoms"
        );

        // Verify distances are consistent with positions + images
        let positions = sc.cart_coords();
        let lattice_matrix = sc.lattice.matrix();
        let lattice_vecs = [
            lattice_matrix.row(0).transpose(),
            lattice_matrix.row(1).transpose(),
            lattice_matrix.row(2).transpose(),
        ];

        for (idx, (&center, &neighbor)) in nl
            .center_indices
            .iter()
            .zip(&nl.neighbor_indices)
            .enumerate()
        {
            let image = nl.images[idx];
            let expected_dist = nl.distances[idx];

            let center_pos = &positions[center];
            let neighbor_pos = &positions[neighbor];

            // Apply periodic image
            let image_offset = (image[0] as f64) * lattice_vecs[0]
                + (image[1] as f64) * lattice_vecs[1]
                + (image[2] as f64) * lattice_vecs[2];

            let actual_dist = (neighbor_pos + image_offset - center_pos).norm();

            assert!(
                (actual_dist - expected_dist).abs() < 1e-10,
                "Distance mismatch: computed {}, stored {}",
                actual_dist,
                expected_dist
            );
        }
    }

    #[test]
    fn test_torch_sim_diamond_si_neighbor_count() {
        // Si diamond: 4 tetrahedral neighbors per atom at a*sqrt(3)/4 ≈ 2.35 Å
        let a = 5.431;
        let nn_dist = a * 3.0_f64.sqrt() / 4.0; // ~2.35 Å

        // Build Si diamond with 8-atom conventional cell (FCC + basis)
        let lattice = Lattice::cubic(a);
        let species = vec![Species::neutral(Element::Si); 8];
        // Diamond structure: FCC lattice with 2-atom basis at (0,0,0) and (1/4,1/4,1/4)
        // FCC positions: (0,0,0), (0.5,0.5,0), (0.5,0,0.5), (0,0.5,0.5)
        // Plus same shifted by (1/4,1/4,1/4)
        let frac_coords = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.5, 0.5, 0.0),
            Vector3::new(0.5, 0.0, 0.5),
            Vector3::new(0.0, 0.5, 0.5),
            Vector3::new(0.25, 0.25, 0.25),
            Vector3::new(0.75, 0.75, 0.25),
            Vector3::new(0.75, 0.25, 0.75),
            Vector3::new(0.25, 0.75, 0.75),
        ];
        let si_diamond = Structure::new(lattice, species, frac_coords);

        // Cutoff just above first shell
        let config = NeighborListConfig {
            cutoff: nn_dist * 1.1,
            ..Default::default()
        };

        let nl = build_neighbor_list(&si_diamond, &config);

        // Diamond has coordination number 4 (tetrahedral)
        let n_atoms = si_diamond.num_sites();
        let coordination = 4;
        let expected_pairs = n_atoms * coordination;
        assert_eq!(
            nl.len(),
            expected_pairs,
            "Si diamond: expected {} pairs ({} neighbors × {} atoms), got {}",
            expected_pairs,
            coordination,
            n_atoms,
            nl.len()
        );

        // All distances should be approximately nn_dist
        for &dist in &nl.distances {
            assert!(
                (dist - nn_dist).abs() < 0.05,
                "Si neighbor distance {} should be ~{} Å",
                dist,
                nn_dist
            );
        }
    }

    #[test]
    fn test_torch_sim_fcc_cu_neighbor_count() {
        // torch-sim tests FCC Cu structure
        // First shell: each atom has 12 nearest neighbors
        // Distance: a/sqrt(2) ≈ 2.55 Å for a=3.61 Å

        let a = 3.61; // Cu lattice constant
        let nn_dist = a / 2.0_f64.sqrt(); // ~2.55 Å

        let fcc_cu = make_fcc(Element::Cu, a);

        // Cutoff just above first shell
        let config = NeighborListConfig {
            cutoff: nn_dist * 1.1,
            ..Default::default()
        };

        let nl = build_neighbor_list(&fcc_cu, &config);

        // 4-atom FCC cell, 12 neighbors per atom = 48 pairs total
        assert_eq!(
            nl.len(),
            48,
            "FCC Cu: expected 48 pairs (12 neighbors × 4 atoms), got {}",
            nl.len()
        );

        // All distances should be approximately nn_dist
        for &dist in &nl.distances {
            assert!(
                (dist - nn_dist).abs() < 0.01,
                "Cu neighbor distance {} should be ~{} Å",
                dist,
                nn_dist
            );
        }
    }

    // === for_each_pair and count_pairs tests ===

    #[test]
    fn test_for_each_pair_basic_and_cutoff() {
        // At exactly cutoff: included (<=)
        let positions = vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(2.0, 0.0, 0.0)];
        let mut pairs = Vec::new();
        for_each_pair(
            &positions,
            None,
            [false; 3],
            2.0,
            |idx_i, idx_j, _rij, dist| {
                pairs.push((idx_i, idx_j, dist));
            },
        )
        .unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!((pairs[0].0, pairs[0].1), (0, 1));
        assert!((pairs[0].2 - 2.0).abs() < 1e-10);

        // Beyond cutoff: excluded
        let cutoff = 3.0;
        let positions3 = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(cutoff, 0.0, 0.0), // Exactly at cutoff - included
            Vector3::new(cutoff + 0.001, 0.0, 0.0), // Beyond - excluded from (0,2)
        ];
        // Pairs: (0,1) at cutoff, (1,2) at 0.001, (0,2) beyond → 2 pairs
        assert_eq!(
            count_pairs(&positions3, None, [false; 3], cutoff).unwrap(),
            2
        );
    }

    #[test]
    fn test_count_pairs_edge_cases() {
        // Empty and single-atom: 0 pairs
        assert_eq!(count_pairs(&[], None, [false; 3], 5.0).unwrap(), 0);
        assert_eq!(
            count_pairs(&[Vector3::new(0.0, 0.0, 0.0)], None, [false; 3], 5.0).unwrap(),
            0
        );
    }

    #[test]
    fn test_for_each_pair_periodic() {
        let cell = Matrix3::from_diagonal(&Vector3::new(5.0, 5.0, 5.0));
        let positions = vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(4.5, 0.0, 0.0)];
        // Minimum image distance is 0.5 via PBC
        assert_eq!(
            count_pairs(&positions, Some(&cell), [true; 3], 1.0).unwrap(),
            1
        );
        assert_eq!(
            count_pairs(&positions, Some(&cell), [false; 3], 1.0).unwrap(),
            0
        );
    }

    #[test]
    fn test_for_each_pair_vector_direction() {
        // rij should point from i to j
        let positions = vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(2.0, 1.0, 0.5)];
        let mut rij_captured = Vector3::zeros();
        for_each_pair(&positions, None, [false; 3], 5.0, |_, _, rij, _| {
            rij_captured = rij
        })
        .unwrap();
        assert!((rij_captured - (positions[1] - positions[0])).norm() < 1e-10);
    }

    #[test]
    fn test_count_pairs_fcc() {
        // FCC unit cell: 4 atoms → 6 unique pairs (4 choose 2)
        let a = 4.0;
        let positions = vec![
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.0, 0.5 * a, 0.5 * a),
            Vector3::new(0.5 * a, 0.0, 0.5 * a),
            Vector3::new(0.5 * a, 0.5 * a, 0.0),
        ];
        let cell = Matrix3::from_diagonal(&Vector3::new(a, a, a));
        let nn_dist = a / 2.0_f64.sqrt();
        assert_eq!(
            count_pairs(&positions, Some(&cell), [true; 3], nn_dist * 1.01).unwrap(),
            6
        );
    }

    #[test]
    fn test_for_each_pair_pbc_without_cell_error() {
        // Enabling PBC without a cell should return an error
        let positions = vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(1.0, 0.0, 0.0)];
        let result = for_each_pair(&positions, None, [true, false, false], 5.0, |_, _, _, _| {});
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            crate::error::FerroxError::PbcWithoutCell
        ));
    }

    #[test]
    fn test_for_each_pair_singular_cell_error() {
        // Singular (non-invertible) cell should return an error
        let positions = vec![Vector3::new(0.0, 0.0, 0.0), Vector3::new(1.0, 0.0, 0.0)];
        let singular_cell = Matrix3::zeros(); // All zeros = singular
        let result = for_each_pair(
            &positions,
            Some(&singular_cell),
            [true; 3],
            5.0,
            |_, _, _, _| {},
        );
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            crate::error::FerroxError::SingularCell
        ));
    }

    // === Cell-list vs brute-force parity (generalized cell list) ===
    //
    // The cell list now covers every pbc combination, cells thinner than the
    // cutoff (multi-image stencils), and unwrapped input coordinates. Each
    // parity test builds a structure large enough to take the cell-list path
    // and compares the exact (center, neighbor, image, distance) multiset
    // against the brute-force reference.

    /// Deterministic pseudo-random fraction in [0, 1) — keeps tests seedless.
    fn hash_frac(seed: usize) -> f64 {
        let mut x = seed as u64 * 2654435761 + 12345;
        x ^= x >> 16;
        x = x.wrapping_mul(2246822519);
        x ^= x >> 13;
        (x % 100_000) as f64 / 100_000.0
    }

    fn make_random_structure(
        n_atoms: usize,
        lattice: Lattice,
        frac_span: f64,
        frac_offset: f64,
    ) -> Structure {
        let species = vec![Species::neutral(Element::C); n_atoms];
        let frac_coords: Vec<Vector3<f64>> = (0..n_atoms)
            .map(|idx| {
                Vector3::new(
                    frac_offset + frac_span * hash_frac(idx * 3),
                    frac_offset + frac_span * hash_frac(idx * 3 + 1),
                    frac_offset + frac_span * hash_frac(idx * 3 + 2),
                )
            })
            .collect();
        Structure::new(lattice, species, frac_coords)
    }

    /// Canonical sorted multiset of (center, neighbor, image, quantized dist).
    fn canonical_pairs(nl: &NeighborList) -> Vec<(usize, usize, [i32; 3], i64)> {
        let mut pairs: Vec<(usize, usize, [i32; 3], i64)> = (0..nl.len())
            .map(|idx| {
                (
                    nl.center_indices[idx],
                    nl.neighbor_indices[idx],
                    nl.images[idx],
                    (nl.distances[idx] * 1e8).round() as i64,
                )
            })
            .collect();
        pairs.sort();
        pairs
    }

    fn assert_parity(structure: &Structure, cutoff: f64, label: &str) {
        let config = NeighborListConfig {
            cutoff,
            cell_list_threshold: 0, // force cell list
            ..Default::default()
        };
        let cell = build_neighbor_list(structure, &config);

        let config_bf = NeighborListConfig {
            cutoff,
            cell_list_threshold: usize::MAX, // force brute force
            ..Default::default()
        };
        let brute = build_neighbor_list(structure, &config_bf);

        let cell_pairs = canonical_pairs(&cell);
        let brute_pairs = canonical_pairs(&brute);
        assert_eq!(
            cell_pairs.len(),
            brute_pairs.len(),
            "{label}: pair count mismatch (cell {} vs brute {})",
            cell_pairs.len(),
            brute_pairs.len()
        );
        assert_eq!(cell_pairs, brute_pairs, "{label}: pair sets differ");
    }

    #[test]
    fn test_parity_non_periodic_molecule() {
        // Fully non-periodic system (the old dispatch fell back to O(n²)).
        let mut lattice = Lattice::cubic(30.0);
        lattice.pbc = [false, false, false];
        let s = make_random_structure(400, lattice, 0.9, 0.05);
        assert_parity(&s, 4.0, "FFF molecule");
    }

    #[test]
    fn test_parity_mixed_pbc_slab() {
        // Slab: periodic in a/b, open along c with vacuum — atoms occupy a
        // thin band so the non-periodic axis exercises extent binning.
        let mut lattice = Lattice::cubic(20.0);
        lattice.pbc = [true, true, false];
        let s = make_random_structure(300, lattice, 0.25, 0.4);
        assert_parity(&s, 4.5, "TTF slab");
    }

    #[test]
    fn test_parity_thin_cell_multi_image() {
        // Cell much thinner than the cutoff along every axis: neighbors need
        // |image| ≥ 2 — the old dispatch refused this outright.
        let lattice = Lattice::from_parameters(3.0, 3.5, 4.0, 90.0, 90.0, 90.0);
        let s = make_random_structure(60, lattice, 1.0, 0.0);
        assert_parity(&s, 7.5, "thin cell multi-image");
        // Prove multi-image pairs actually occur.
        let config = NeighborListConfig {
            cutoff: 7.5,
            cell_list_threshold: 0,
            ..Default::default()
        };
        let nl = build_neighbor_list(&s, &config);
        assert!(
            nl.images
                .iter()
                .any(|img| img.iter().any(|&v| v.abs() >= 2)),
            "expected |image| >= 2 pairs in a 3-4 Å cell with 7.5 Å cutoff"
        );
    }

    #[test]
    fn test_parity_unwrapped_coords() {
        // Fractional coordinates outside [0,1): the cell list wraps atoms in
        // and must correct emitted images back to the original coordinates.
        //
        // The brute-force path can NOT serve as the reference here — its
        // ±max_images window is sized from the cutoff/cell ratio and assumes
        // in-cell coordinates, so it misses pairs between atoms sitting
        // several cells apart (undercounts). Reference = brute force on a
        // manually wrapped twin structure, with images transformed back to
        // the unwrapped frame via I = m − s_j + s_i.
        let lattice = Lattice::cubic(12.0);
        let s = make_random_structure(200, Lattice::cubic(12.0), 2.4, -1.2);

        let shifts: Vec<[i32; 3]> = s
            .frac_coords
            .iter()
            .map(|f| [f.x.floor() as i32, f.y.floor() as i32, f.z.floor() as i32])
            .collect();
        let wrapped_frac: Vec<Vector3<f64>> = s
            .frac_coords
            .iter()
            .map(|f| Vector3::new(f.x - f.x.floor(), f.y - f.y.floor(), f.z - f.z.floor()))
            .collect();
        let wrapped_twin = Structure::new(
            lattice,
            vec![Species::neutral(Element::C); wrapped_frac.len()],
            wrapped_frac,
        );

        let config_cell = NeighborListConfig {
            cutoff: 4.0,
            cell_list_threshold: 0,
            ..Default::default()
        };
        let cell = build_neighbor_list(&s, &config_cell);

        let config_bf = NeighborListConfig {
            cutoff: 4.0,
            cell_list_threshold: usize::MAX,
            ..Default::default()
        };
        let brute_wrapped = build_neighbor_list(&wrapped_twin, &config_bf);
        // Transform wrapped-frame images into the unwrapped frame.
        let mut expected: Vec<(usize, usize, [i32; 3], i64)> = (0..brute_wrapped.len())
            .map(|idx| {
                let center = brute_wrapped.center_indices[idx];
                let neighbor = brute_wrapped.neighbor_indices[idx];
                let m = brute_wrapped.images[idx];
                let image = [
                    m[0] - shifts[neighbor][0] + shifts[center][0],
                    m[1] - shifts[neighbor][1] + shifts[center][1],
                    m[2] - shifts[neighbor][2] + shifts[center][2],
                ];
                (
                    center,
                    neighbor,
                    image,
                    (brute_wrapped.distances[idx] * 1e8).round() as i64,
                )
            })
            .collect();
        expected.sort();

        let got = canonical_pairs(&cell);
        assert_eq!(
            got.len(),
            expected.len(),
            "unwrapped coords: pair count mismatch (cell {} vs wrapped-brute {})",
            got.len(),
            expected.len()
        );
        assert_eq!(got, expected, "unwrapped coords: pair sets differ");
    }

    #[test]
    fn test_parity_triclinic_skewed() {
        let lattice = Lattice::from_parameters(11.0, 12.0, 13.0, 65.0, 75.0, 85.0);
        let s = make_random_structure(350, lattice, 1.0, 0.0);
        assert_parity(&s, 4.5, "triclinic");
    }

    #[test]
    fn test_parity_sparse_gas_capped_grid() {
        // Huge box, few atoms: exercises the per-axis bin-count cap.
        let mut lattice = Lattice::cubic(300.0);
        lattice.pbc = [false, false, false];
        let s = make_random_structure(120, lattice, 1.0, 0.0);
        assert_parity(&s, 6.0, "sparse gas");
    }

    fn neighbor_list_bytes(neighbors: &NeighborList) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(neighbors.len() * 36);
        for idx in 0..neighbors.len() {
            bytes.extend_from_slice(&(neighbors.center_indices[idx] as u64).to_le_bytes());
            bytes.extend_from_slice(&(neighbors.neighbor_indices[idx] as u64).to_le_bytes());
            bytes.extend_from_slice(&neighbors.distances[idx].to_bits().to_le_bytes());
            for image in neighbors.images[idx] {
                bytes.extend_from_slice(&image.to_le_bytes());
            }
        }
        bytes
    }

    fn neighbor_bytes_digest(bytes: &[u8]) -> [u64; 2] {
        let mut first = 0xcbf29ce484222325u64;
        let mut second = 0x9e3779b97f4a7c15u64;
        for &byte in bytes {
            first = (first ^ byte as u64).wrapping_mul(0x100000001b3);
            second ^= (byte as u64)
                .wrapping_add(0x9e3779b97f4a7c15)
                .wrapping_add(second << 6)
                .wrapping_add(second >> 2);
        }
        [first, second]
    }

    #[test]
    fn trajectory_workspace_periodic_crystal_matches_base_bytes_and_order() {
        let structure = make_random_structure(96, Lattice::cubic(18.0), 1.0, 0.0);
        let config = NeighborListConfig {
            cutoff: 4.0,
            cell_list_threshold: 0,
            ..Default::default()
        };
        let mut workspace = NeighborSearchWorkspace::default();
        let actual =
            workspace.rebuild_from_fractional(&structure.frac_coords, &structure.lattice, &config);
        let bytes = neighbor_list_bytes(actual);

        // Produced independently by the pre-refactor implementation at
        // f5a97cabdbb70ec5ac7e17e700ce25cca9b4ace4 in both feature modes.
        assert_eq!(actual.len(), 432);
        assert_eq!(bytes.len(), 15_552);
        assert_eq!(
            neighbor_bytes_digest(&bytes),
            [0xbc13c3dc9921c1c1, 0x2737ec52e96cd120]
        );
    }

    #[test]
    fn trajectory_workspace_fixed_periodic_grid_rebuild_then_hit() {
        let lattice = Lattice::cubic(18.0);
        let first = make_random_structure(96, lattice.clone(), 1.0, 0.0);
        let second = make_random_structure(96, lattice.clone(), 0.98, 0.01);
        let config = NeighborListConfig {
            cutoff: 4.0,
            cell_list_threshold: 0,
            ..Default::default()
        };
        let mut workspace = NeighborSearchWorkspace::default();

        workspace.rebuild_from_fractional(&first.frac_coords, &lattice, &config);
        assert_eq!(
            workspace.stats(),
            NeighborWorkspaceStats {
                grid_cache_hits: 0,
                grid_rebuilds: 1,
                capacity_growths: workspace.stats().capacity_growths,
            }
        );

        workspace.rebuild_from_fractional(&second.frac_coords, &lattice, &config);
        assert_eq!(workspace.stats().grid_cache_hits, 1);
        assert_eq!(workspace.stats().grid_rebuilds, 1);
    }

    #[test]
    fn trajectory_workspace_changed_lattice_rebuilds_grid() {
        let first_lattice = Lattice::cubic(18.0);
        let second_lattice = Lattice::cubic(18.5);
        let frame = make_random_structure(96, first_lattice.clone(), 1.0, 0.0);
        let config = NeighborListConfig {
            cutoff: 4.0,
            cell_list_threshold: 0,
            ..Default::default()
        };
        let mut workspace = NeighborSearchWorkspace::default();

        workspace.rebuild_from_fractional(&frame.frac_coords, &first_lattice, &config);
        workspace.rebuild_from_fractional(&frame.frac_coords, &second_lattice, &config);

        assert_eq!(workspace.stats().grid_cache_hits, 0);
        assert_eq!(workspace.stats().grid_rebuilds, 2);
    }

    #[test]
    fn trajectory_workspace_open_axes_rebuild_grid_every_frame() {
        let config = NeighborListConfig {
            cutoff: 4.0,
            cell_list_threshold: 0,
            ..Default::default()
        };

        for pbc in [[true, true, false], [false, false, false]] {
            let mut lattice = Lattice::cubic(18.0);
            lattice.pbc = pbc;
            let first = make_random_structure(96, lattice.clone(), 0.8, 0.1);
            let second = make_random_structure(96, lattice.clone(), 0.6, 0.2);
            let mut workspace = NeighborSearchWorkspace::default();

            workspace.rebuild_from_fractional(&first.frac_coords, &lattice, &config);
            workspace.rebuild_from_fractional(&second.frac_coords, &lattice, &config);

            assert_eq!(workspace.stats().grid_cache_hits, 0, "pbc={pbc:?}");
            assert_eq!(workspace.stats().grid_rebuilds, 2, "pbc={pbc:?}");
        }
    }

    #[test]
    fn trajectory_workspace_second_fixed_frame_has_stable_capacities() {
        let lattice = Lattice::cubic(18.0);
        let first = make_random_structure(96, lattice.clone(), 1.0, 0.0);
        let second = make_random_structure(96, lattice.clone(), 0.98, 0.01);
        let config = NeighborListConfig {
            cutoff: 4.0,
            cell_list_threshold: 0,
            ..Default::default()
        };
        let mut workspace = NeighborSearchWorkspace::default();

        workspace.rebuild_from_fractional(&first.frac_coords, &lattice, &config);
        let first_growths = workspace.stats().capacity_growths;
        assert!(first_growths > 0);

        workspace.rebuild_from_fractional(&second.frac_coords, &lattice, &config);
        assert_eq!(workspace.stats().capacity_growths, first_growths);
    }

    #[test]
    fn trajectory_workspace_handles_edge_geometries_and_unwrapped_coordinates() {
        let config = NeighborListConfig {
            cutoff: 4.1,
            cell_list_threshold: 0,
            ..Default::default()
        };
        let mut workspace = NeighborSearchWorkspace::default();

        assert!(
            workspace
                .rebuild_from_fractional(&[], &Lattice::cubic(10.0), &config)
                .is_empty()
        );

        let one_atom = [Vector3::new(0.0, 0.0, 0.0)];
        let thin = workspace.rebuild_from_fractional(&one_atom, &Lattice::cubic(2.0), &config);
        assert_eq!(thin.len(), 32);
        assert!(thin.images.iter().any(|image| image[0].abs() == 2));

        let mut mixed = Lattice::cubic(2.0);
        mixed.pbc = [true, false, false];
        let mixed_neighbors = workspace.rebuild_from_fractional(&one_atom, &mixed, &config);
        assert_eq!(mixed_neighbors.len(), 4);
        assert!(
            mixed_neighbors
                .images
                .iter()
                .all(|image| image[1] == 0 && image[2] == 0)
        );

        let unwrapped_config = NeighborListConfig {
            cutoff: 1.0,
            cell_list_threshold: 0,
            ..Default::default()
        };
        let unwrapped = [Vector3::new(2.0, 0.0, 0.0), Vector3::new(-1.95, 0.0, 0.0)];
        let unwrapped_neighbors =
            workspace.rebuild_from_fractional(&unwrapped, &Lattice::cubic(10.0), &unwrapped_config);
        assert_eq!(unwrapped_neighbors.center_indices, [0, 1]);
        assert_eq!(unwrapped_neighbors.neighbor_indices, [1, 0]);
        assert_eq!(unwrapped_neighbors.images, [[4, 0, 0], [-4, 0, 0]]);
        assert!(
            unwrapped_neighbors
                .distances
                .iter()
                .all(|distance| (*distance - 0.5).abs() < 1e-10)
        );
    }

    #[test]
    fn trajectory_workspace_scalar_and_rayon_match_fixture_bytes() {
        let lattice = Lattice::cubic(256.0);
        let mut frac_coords: Vec<Vector3<f64>> = (0..130)
            .map(|idx| {
                Vector3::new(
                    ((idx % 10) * 16 + 8) as f64 / 256.0,
                    (((idx / 10) % 10) * 16 + 8) as f64 / 256.0,
                    ((idx / 100) * 16 + 8) as f64 / 256.0,
                )
            })
            .collect();
        for (center, neighbor) in [(0, 1), (64, 65), (128, 129)] {
            frac_coords[neighbor] = frac_coords[center] + Vector3::new(0.5 / 256.0, 0.0, 0.0);
        }

        // 130 atoms force three chunks because the Rayon chunk-size floor is
        // 64. Each chunk has one directed pair in both center directions.
        assert_eq!(frac_coords.len().div_ceil(64), 3);

        let warmup_config = NeighborListConfig {
            cutoff: 20.1,
            cell_list_threshold: 0,
            ..Default::default()
        };
        let config = NeighborListConfig {
            cutoff: 1.0,
            cell_list_threshold: 0,
            ..Default::default()
        };
        let mut expected = Vec::new();
        for (center, neighbor) in [
            (0u64, 1u64),
            (1, 0),
            (64, 65),
            (65, 64),
            (128, 129),
            (129, 128),
        ] {
            expected.extend_from_slice(&center.to_le_bytes());
            expected.extend_from_slice(&neighbor.to_le_bytes());
            expected.extend_from_slice(&0.5f64.to_bits().to_le_bytes());
            for image in [0i32; 3] {
                expected.extend_from_slice(&image.to_le_bytes());
            }
        }
        let mut workspace = NeighborSearchWorkspace::default();

        let warmup = workspace.rebuild_from_fractional(&frac_coords, &lattice, &warmup_config);
        assert!(warmup.len() > 6);
        let actual = workspace.rebuild_from_fractional(&frac_coords, &lattice, &config);

        assert_eq!(neighbor_list_bytes(actual), expected);
        #[cfg(feature = "rayon")]
        assert_eq!(
            workspace.rayon_partials[..3]
                .iter()
                .map(NeighborList::len)
                .collect::<Vec<_>>(),
            [2, 2, 2]
        );
    }
}

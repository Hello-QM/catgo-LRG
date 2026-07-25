//! Persistent exact bond detection for typed trajectory frames.

use crate::bonding::{AtomRadiiOptions, Bond, collect_bonds_atom_radii_from_neighbor_list};
use crate::element::Element;
use crate::lattice::Lattice;
use crate::neighbors::{NeighborListConfig, NeighborSearchWorkspace};
use nalgebra::{Matrix3, Vector3};
use serde::Serialize;

/// Cumulative diagnostics for one trajectory bond session.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct TrajectoryBondSessionStats {
    /// Number of frames computed successfully.
    pub frame_count: u64,
    /// Number of fixed-periodic grid-plan cache hits.
    pub grid_cache_hits: u64,
    /// Number of grid-plan rebuilds.
    pub grid_rebuilds: u64,
    /// Number of grow-only workspace or session-buffer capacity increases.
    pub capacity_growths: u64,
}

/// Native validation failures for a trajectory bond session.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TrajectoryBondSessionError {
    /// A frame did not contain exactly three position values per session atom.
    #[error(
        "trajectory bond session {session_id} frame {frame_idx:?}: positions \
         length {actual_float_count} != expected {expected_float_count} \
         for {expected_atom_count} atoms"
    )]
    PositionLengthMismatch {
        /// Session identifier supplied at construction.
        session_id: u32,
        /// Immutable number of atoms in the session topology.
        expected_atom_count: usize,
        /// Required number of position floats.
        expected_float_count: usize,
        /// Number of position floats supplied by the frame.
        actual_float_count: usize,
        /// Optional trajectory frame index supplied by the caller.
        frame_idx: Option<u32>,
    },
    /// A lattice slice was neither empty nor a row-major 3×3 matrix.
    #[error("trajectory bond session {session_id}: lattice must have 0 or 9 values, got {actual}")]
    LatticeLengthMismatch {
        /// Session identifier supplied at construction.
        session_id: u32,
        /// Number of supplied lattice values.
        actual: usize,
    },
    /// A topology site used an atomic number unknown to the element table.
    #[error(
        "trajectory bond session {session_id}: site {site_idx} has unknown atomic number {atomic_number}"
    )]
    UnknownAtomicNumber {
        /// Session identifier supplied at construction.
        session_id: u32,
        /// Zero-based topology site index.
        site_idx: usize,
        /// Invalid atomic number supplied for the site.
        atomic_number: u8,
    },
}

/// Reusable exact bond detector for frames sharing one immutable topology.
pub struct TrajectoryBondSession {
    session_id: u32,
    atomic_numbers: Vec<u8>,
    effective_radii: Vec<f64>,
    pbc: [bool; 3],
    options: AtomRadiiOptions,
    cutoff: f64,
    cart_coords: Vec<Vector3<f64>>,
    frac_coords: Vec<Vector3<f64>>,
    neighbor_config: NeighborListConfig,
    neighbor_workspace: NeighborSearchWorkspace,
    bonds: Vec<Bond>,
    capacity_growths: u64,
    frame_count: u64,
}

impl TrajectoryBondSession {
    /// Create a session and cache the topology's effective covalent radii.
    pub fn new(
        session_id: u32,
        atomic_numbers: &[u8],
        pbc: [bool; 3],
        options: AtomRadiiOptions,
    ) -> Result<Self, TrajectoryBondSessionError> {
        let mut effective_radii = Vec::with_capacity(atomic_numbers.len());
        for (site_idx, &atomic_number) in atomic_numbers.iter().enumerate() {
            let element = Element::from_atomic_number(atomic_number).ok_or(
                TrajectoryBondSessionError::UnknownAtomicNumber {
                    session_id,
                    site_idx,
                    atomic_number,
                },
            )?;
            effective_radii.push(element.covalent_radius().unwrap_or(1.5));
        }
        let max_radius = effective_radii.iter().copied().fold(0.0, f64::max);
        let cutoff = options.max_bond_dist.min(2.0 * max_radius * options.scale);
        let neighbor_config = NeighborListConfig {
            cutoff,
            self_interaction: false,
            numerical_tol: 1e-8,
            ..Default::default()
        };

        Ok(Self {
            session_id,
            atomic_numbers: atomic_numbers.to_vec(),
            effective_radii,
            pbc,
            options,
            cutoff,
            cart_coords: Vec::with_capacity(atomic_numbers.len()),
            frac_coords: Vec::with_capacity(atomic_numbers.len()),
            neighbor_config,
            neighbor_workspace: NeighborSearchWorkspace::default(),
            bonds: Vec::new(),
            capacity_growths: 0,
            frame_count: 0,
        })
    }

    /// Compute exact current-frame bonds while retaining all session scratch.
    pub fn compute_frame(
        &mut self,
        positions: &[f32],
        lattice: &[f64],
        frame_idx: Option<u32>,
    ) -> Result<&[Bond], TrajectoryBondSessionError> {
        let expected_atom_count = self.atomic_numbers.len();
        let expected_float_count = expected_atom_count.saturating_mul(3);
        if positions.len() != expected_float_count {
            return Err(TrajectoryBondSessionError::PositionLengthMismatch {
                session_id: self.session_id,
                expected_atom_count,
                expected_float_count,
                actual_float_count: positions.len(),
                frame_idx,
            });
        }
        if !lattice.is_empty() && lattice.len() != 9 {
            return Err(TrajectoryBondSessionError::LatticeLengthMismatch {
                session_id: self.session_id,
                actual: lattice.len(),
            });
        }

        clear_and_reserve(
            &mut self.cart_coords,
            expected_atom_count,
            &mut self.capacity_growths,
        );
        self.cart_coords.extend(
            positions
                .chunks_exact(3)
                .map(|xyz| Vector3::new(xyz[0] as f64, xyz[1] as f64, xyz[2] as f64)),
        );
        clear_and_reserve(
            &mut self.frac_coords,
            expected_atom_count,
            &mut self.capacity_growths,
        );

        let current_lattice = if lattice.len() == 9 {
            let current_lattice =
                Lattice::from_matrix_with_pbc(Matrix3::from_row_slice(lattice), self.pbc);
            let inverse_transpose = current_lattice.inv_matrix().transpose();
            self.frac_coords.extend(
                self.cart_coords
                    .iter()
                    .map(|coord| inverse_transpose * coord),
            );
            current_lattice
        } else {
            let (current_lattice, min, size) = padded_non_periodic_lattice(&self.cart_coords);
            self.frac_coords
                .extend(self.cart_coords.iter().map(|coord| {
                    Vector3::new(
                        (coord[0] - min[0] + 10.0) / size[0],
                        (coord[1] - min[1] + 10.0) / size[1],
                        (coord[2] - min[2] + 10.0) / size[2],
                    )
                }));
            current_lattice
        };

        debug_assert_eq!(self.neighbor_config.cutoff.to_bits(), self.cutoff.to_bits());
        let neighbors = self.neighbor_workspace.rebuild_from_fractional(
            &self.frac_coords,
            &current_lattice,
            &self.neighbor_config,
        );
        let old_bond_capacity = self.bonds.capacity();
        collect_bonds_atom_radii_from_neighbor_list(
            &self.effective_radii,
            &self.options,
            neighbors,
            &mut self.bonds,
        );
        if self.bonds.capacity() > old_bond_capacity {
            self.capacity_growths += 1;
        }
        self.frame_count += 1;
        Ok(&self.bonds)
    }

    /// Return cumulative session and neighbor-workspace diagnostics.
    pub fn stats(&self) -> TrajectoryBondSessionStats {
        let workspace = self.neighbor_workspace.stats();
        TrajectoryBondSessionStats {
            frame_count: self.frame_count,
            grid_cache_hits: workspace.grid_cache_hits,
            grid_rebuilds: workspace.grid_rebuilds,
            capacity_growths: self.capacity_growths + workspace.capacity_growths,
        }
    }
}

fn clear_and_reserve<T>(values: &mut Vec<T>, needed: usize, capacity_growths: &mut u64) {
    values.clear();
    if values.capacity() < needed {
        values.reserve(needed);
        *capacity_growths += 1;
    }
}

fn padded_non_periodic_lattice(cart_coords: &[Vector3<f64>]) -> (Lattice, [f64; 3], [f64; 3]) {
    let mut min = [f64::MAX; 3];
    let mut max = [f64::MIN; 3];
    for coord in cart_coords {
        for axis in 0..3 {
            min[axis] = min[axis].min(coord[axis]);
            max[axis] = max[axis].max(coord[axis]);
        }
    }
    if cart_coords.is_empty() {
        min = [0.0; 3];
        max = [0.0; 3];
    }
    let size = std::array::from_fn(|axis| (max[axis] - min[axis] + 20.0).max(20.0));
    let matrix = Matrix3::new(size[0], 0.0, 0.0, 0.0, size[1], 0.0, 0.0, 0.0, size[2]);
    (Lattice::from_matrix_with_pbc(matrix, [false; 3]), min, size)
}

#[cfg(test)]
mod tests {
    use super::{TrajectoryBondSession, TrajectoryBondSessionError, TrajectoryBondSessionStats};
    use crate::bonding::{AtomRadiiOptions, Bond, detect_bonds_atom_radii};
    use crate::element::Element;
    use crate::lattice::Lattice;
    use crate::species::{SiteOccupancy, Species};
    use crate::structure::Structure;
    use nalgebra::{Matrix3, Vector3};
    use std::collections::HashMap;

    fn bond_bytes(bonds: &[Bond]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(bonds.len() * 44);
        for bond in bonds {
            bytes.extend_from_slice(&(bond.site_idx_1 as u64).to_le_bytes());
            bytes.extend_from_slice(&(bond.site_idx_2 as u64).to_le_bytes());
            for image in bond.image {
                bytes.extend_from_slice(&image.to_le_bytes());
            }
            bytes.extend_from_slice(&bond.bond_length.to_bits().to_le_bytes());
            bytes.extend_from_slice(&bond.strength.to_bits().to_le_bytes());
        }
        bytes
    }

    fn legacy_structure(
        atomic_numbers: &[u8],
        positions: &[f32],
        lattice: &[f64],
        pbc: [bool; 3],
    ) -> Structure {
        let cart_coords: Vec<Vector3<f64>> = positions
            .chunks_exact(3)
            .map(|xyz| Vector3::new(xyz[0] as f64, xyz[1] as f64, xyz[2] as f64))
            .collect();
        let (lattice, effective_pbc, frac_coords) = if lattice.len() == 9 {
            let lattice = Lattice::from_matrix_with_pbc(Matrix3::from_row_slice(lattice), pbc);
            let frac_coords = lattice.get_fractional_coords(&cart_coords);
            (lattice, pbc, frac_coords)
        } else {
            let mut min = [f64::MAX; 3];
            let mut max = [f64::MIN; 3];
            for coord in &cart_coords {
                for axis in 0..3 {
                    min[axis] = min[axis].min(coord[axis]);
                    max[axis] = max[axis].max(coord[axis]);
                }
            }
            if cart_coords.is_empty() {
                min = [0.0; 3];
                max = [0.0; 3];
            }
            let padding = 10.0;
            let size: [f64; 3] =
                std::array::from_fn(|axis| (max[axis] - min[axis] + 2.0 * padding).max(20.0));
            let lattice = Lattice::from_matrix_with_pbc(
                Matrix3::new(size[0], 0.0, 0.0, 0.0, size[1], 0.0, 0.0, 0.0, size[2]),
                [false; 3],
            );
            let frac_coords = cart_coords
                .iter()
                .map(|coord| {
                    Vector3::new(
                        (coord[0] - min[0] + padding) / size[0],
                        (coord[1] - min[1] + padding) / size[1],
                        (coord[2] - min[2] + padding) / size[2],
                    )
                })
                .collect();
            (lattice, [false; 3], frac_coords)
        };
        let occupancies = atomic_numbers
            .iter()
            .map(|&atomic_number| {
                SiteOccupancy::ordered(Species::neutral(
                    Element::from_atomic_number(atomic_number).unwrap(),
                ))
            })
            .collect();
        Structure::try_new_full(
            lattice,
            occupancies,
            frac_coords,
            effective_pbc,
            0.0,
            HashMap::new(),
        )
        .unwrap()
    }

    fn assert_legacy_parity(
        atomic_numbers: &[u8],
        positions: &[f32],
        lattice: &[f64],
        pbc: [bool; 3],
        options: AtomRadiiOptions,
    ) -> (Vec<u8>, TrajectoryBondSessionStats) {
        let expected = detect_bonds_atom_radii(
            &legacy_structure(atomic_numbers, positions, lattice, pbc),
            &options,
        );
        let mut session = TrajectoryBondSession::new(41, atomic_numbers, pbc, options).unwrap();
        let actual = session.compute_frame(positions, lattice, Some(7)).unwrap();
        assert_eq!(bond_bytes(actual), bond_bytes(&expected));
        (bond_bytes(actual), session.stats())
    }

    #[test]
    fn ordinary_periodic_frame_is_byte_identical_to_legacy() {
        let positions = [0.3, 3.0, 3.0, 5.7, 3.0, 3.0];
        let lattice = [6.0, 0.0, 0.0, 0.0, 6.0, 0.0, 0.0, 0.0, 6.0];
        let (bytes, stats) = assert_legacy_parity(
            &[29, 29],
            &positions,
            &lattice,
            [true; 3],
            AtomRadiiOptions::default(),
        );
        assert!(!bytes.is_empty());
        assert_eq!(stats.frame_count, 1);
        assert_eq!(stats.grid_rebuilds, 1);
    }

    #[test]
    fn zero_atom_frame_is_byte_identical_to_legacy() {
        let lattice = [8.0, 0.0, 0.0, 0.0, 8.0, 0.0, 0.0, 0.0, 8.0];
        let (bytes, stats) =
            assert_legacy_parity(&[], &[], &lattice, [true; 3], AtomRadiiOptions::default());
        assert!(bytes.is_empty());
        assert_eq!(stats.frame_count, 1);
    }

    #[test]
    fn one_non_periodic_atom_is_byte_identical_to_legacy() {
        let (bytes, _) = assert_legacy_parity(
            &[29],
            &[12.5, -4.0, 99.0],
            &[],
            [false; 3],
            AtomRadiiOptions::default(),
        );
        assert!(bytes.is_empty());
    }

    #[test]
    fn one_periodic_self_image_atom_is_byte_identical_to_legacy() {
        let half = 3.615 / 2.0;
        let lattice = [0.0, half, half, half, 0.0, half, half, half, 0.0];
        let (bytes, _) = assert_legacy_parity(
            &[29],
            &[0.0, 0.0, 0.0],
            &lattice,
            [true; 3],
            AtomRadiiOptions::default(),
        );
        assert_eq!(bytes.len(), 6 * 44);
    }

    #[test]
    fn thin_multi_image_periodic_cell_is_byte_identical_to_legacy() {
        let lattice = [1.0, 0.0, 0.0, 0.0, 12.0, 0.0, 0.0, 0.0, 12.0];
        let (bytes, _) = assert_legacy_parity(
            &[29],
            &[0.0, 3.0, 3.0],
            &lattice,
            [true; 3],
            AtomRadiiOptions::default(),
        );
        assert_eq!(bytes.len(), 3 * 44);
    }

    #[test]
    fn mixed_pbc_frame_is_byte_identical_to_legacy() {
        let lattice = [2.5, 0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 0.0, 5.0];
        let (bytes, stats) = assert_legacy_parity(
            &[29],
            &[0.3, 4.8, -1.2],
            &lattice,
            [true, false, false],
            AtomRadiiOptions::default(),
        );
        assert_eq!(bytes.len(), 44);
        assert_eq!(stats.grid_rebuilds, 1);
        assert_eq!(stats.grid_cache_hits, 0);
    }

    #[test]
    fn unwrapped_positions_are_byte_identical_to_legacy() {
        let lattice = [6.0, 0.0, 0.0, 0.0, 6.0, 0.0, 0.0, 0.0, 6.0];
        let (bytes, _) = assert_legacy_parity(
            &[29, 29],
            &[24.0, -12.0, 9.0, 29.5, -12.0, 9.0],
            &lattice,
            [true; 3],
            AtomRadiiOptions::default(),
        );
        assert!(!bytes.is_empty());
    }

    #[test]
    fn changed_lattice_rebuilds_grid_and_preserves_legacy_parity() {
        let positions = [0.0, 0.0, 0.0, 2.5, 0.0, 0.0];
        let lattice_a = [5.0, 0.0, 0.0, 0.0, 5.0, 0.0, 0.0, 0.0, 5.0];
        let lattice_b = [6.0, 0.0, 0.0, 0.0, 6.0, 0.0, 0.0, 0.0, 6.0];
        let options = AtomRadiiOptions::default();
        let mut session =
            TrajectoryBondSession::new(8, &[29, 29], [true; 3], options.clone()).unwrap();

        for (frame_idx, lattice) in [&lattice_a, &lattice_b].into_iter().enumerate() {
            let expected = detect_bonds_atom_radii(
                &legacy_structure(&[29, 29], &positions, lattice, [true; 3]),
                &options,
            );
            let actual = session
                .compute_frame(&positions, lattice, Some(frame_idx as u32))
                .unwrap();
            assert_eq!(bond_bytes(actual), bond_bytes(&expected));
        }

        assert_eq!(
            session.stats(),
            TrajectoryBondSessionStats {
                frame_count: 2,
                grid_cache_hits: 0,
                grid_rebuilds: 2,
                capacity_growths: session.stats().capacity_growths,
            }
        );
    }

    #[test]
    fn repeated_fixed_lattice_frame_hits_grid_cache_without_capacity_growth() {
        let positions_a = [0.0, 0.0, 0.0, 2.5, 0.0, 0.0];
        let positions_b = [0.1, 0.0, 0.0, 2.6, 0.0, 0.0];
        let lattice = [6.0, 0.0, 0.0, 0.0, 6.0, 0.0, 0.0, 0.0, 6.0];
        let options = AtomRadiiOptions::default();
        let mut session =
            TrajectoryBondSession::new(9, &[29, 29], [true; 3], options.clone()).unwrap();

        let expected_a = detect_bonds_atom_radii(
            &legacy_structure(&[29, 29], &positions_a, &lattice, [true; 3]),
            &options,
        );
        assert_eq!(
            bond_bytes(
                session
                    .compute_frame(&positions_a, &lattice, Some(0))
                    .unwrap()
            ),
            bond_bytes(&expected_a)
        );
        let after_first = session.stats();

        let expected_b = detect_bonds_atom_radii(
            &legacy_structure(&[29, 29], &positions_b, &lattice, [true; 3]),
            &options,
        );
        assert_eq!(
            bond_bytes(
                session
                    .compute_frame(&positions_b, &lattice, Some(1))
                    .unwrap()
            ),
            bond_bytes(&expected_b)
        );
        let after_second = session.stats();

        assert_eq!(after_second.frame_count, 2);
        assert_eq!(after_second.grid_rebuilds, 1);
        assert_eq!(after_second.grid_cache_hits, 1);
        assert_eq!(
            after_second.capacity_growths, after_first.capacity_growths,
            "fixed-shape second frame must reuse all grown capacity"
        );
    }

    #[test]
    fn malformed_frames_return_typed_errors_and_leave_session_recoverable() {
        let lattice = [8.0, 0.0, 0.0, 0.0, 8.0, 0.0, 0.0, 0.0, 8.0];
        let bonded = [0.0, 0.0, 0.0, 2.5, 0.0, 0.0];
        let separated = [0.0, 0.0, 0.0, 4.0, 4.0, 4.0];
        let options = AtomRadiiOptions::default();
        let mut session =
            TrajectoryBondSession::new(73, &[29, 29], [true; 3], options.clone()).unwrap();

        assert!(
            !session
                .compute_frame(&bonded, &lattice, Some(2))
                .unwrap()
                .is_empty()
        );
        let before_errors = session.stats();

        let position_error = match session.compute_frame(&bonded[..5], &lattice, Some(3)) {
            Ok(_) => panic!("malformed positions must fail"),
            Err(error) => error,
        };
        assert_eq!(
            position_error,
            TrajectoryBondSessionError::PositionLengthMismatch {
                session_id: 73,
                expected_atom_count: 2,
                expected_float_count: 6,
                actual_float_count: 5,
                frame_idx: Some(3),
            }
        );
        let lattice_error = match session.compute_frame(&bonded, &lattice[..8], Some(4)) {
            Ok(_) => panic!("malformed lattice must fail"),
            Err(error) => error,
        };
        assert_eq!(
            lattice_error,
            TrajectoryBondSessionError::LatticeLengthMismatch {
                session_id: 73,
                actual: 8,
            }
        );
        assert_eq!(session.stats(), before_errors);

        let expected = detect_bonds_atom_radii(
            &legacy_structure(&[29, 29], &separated, &lattice, [true; 3]),
            &options,
        );
        let recovered = session
            .compute_frame(&separated, &lattice, Some(5))
            .unwrap();
        assert_eq!(bond_bytes(recovered), bond_bytes(&expected));
        assert!(recovered.is_empty(), "prior valid graph must not leak");
        assert_eq!(session.stats().frame_count, 2);
    }

    #[test]
    fn unknown_atomic_number_is_rejected_with_site_context() {
        let error = match TrajectoryBondSession::new(
            91,
            &[29, 0, 8],
            [true; 3],
            AtomRadiiOptions::default(),
        ) {
            Ok(_) => panic!("unknown atomic number must fail"),
            Err(error) => error,
        };
        assert_eq!(
            error,
            TrajectoryBondSessionError::UnknownAtomicNumber {
                session_id: 91,
                site_idx: 1,
                atomic_number: 0,
            }
        );
    }
}

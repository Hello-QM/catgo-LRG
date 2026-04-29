use crate::math::Vec3;
use crate::traits::{get_covalent_radius, AtomTrait, BondTrait};
use crate::vsepr::Geometry;

/// Applies bond length constraints (1-2 interactions).
pub fn apply_bond_constraints<A: AtomTrait, B: BondTrait>(
    atoms: &[A],
    bonds: &[B],
    positions: &[Vec3],
    forces: &mut [Vec3],
) {
    for bond in bonds {
        let (i, j) = bond.get_atom_indices();
        let p1 = positions[i];
        let p2 = positions[j];
        let dist = p1.dist(p2);

        let r1 = get_covalent_radius(atoms[i].atomic_number());
        let r2 = get_covalent_radius(atoms[j].atomic_number());
        let raw_sum = (r1 + r2) / 100.0;

        let order = bond.get_bond_order();
        let scale_factor = if order >= 3.0 {
            0.82
        } else if order >= 2.0 {
            0.88
        } else if order >= 1.5 {
            0.92
        } else {
            1.00
        };

        let target = raw_sum * scale_factor;

        if dist > 0.001 {
            let diff = target - dist;
            let force = p1.sub(p2).normalize().mul(diff * 1.2);
            forces[i] = forces[i].add(force);
            forces[j] = forces[j].sub(force);
        }
    }
}

/// Applies bond angle constraints (1-3 interactions).
pub fn apply_angle_constraints(
    n: usize,
    adj: &[Vec<(usize, usize)>],
    geometries: &[Geometry],
    positions: &[Vec3],
    forces: &mut [Vec3],
) {
    for i in 0..n {
        let neighbors = &adj[i];
        if neighbors.len() < 2 {
            continue;
        }

        let ideal_angle = geometries[i].ideal_angle();
        let cos_theta = ideal_angle.cos();

        for a_idx in 0..neighbors.len() {
            for b_idx in (a_idx + 1)..neighbors.len() {
                let ni = neighbors[a_idx].0;
                let nj = neighbors[b_idx].0;
                let p_center = positions[i];

                let r1 = positions[ni].dist(p_center);
                let r2 = positions[nj].dist(p_center);

                let target_d = (r1 * r1 + r2 * r2 - 2.0 * r1 * r2 * cos_theta)
                    .max(0.0)
                    .sqrt();

                let current_d = positions[ni].dist(positions[nj]);
                if current_d > 0.001 {
                    let diff = target_d - current_d;
                    let force = positions[ni]
                        .sub(positions[nj])
                        .normalize()
                        .mul(diff * 0.2);
                    forces[ni] = forces[ni].add(force);
                    forces[nj] = forces[nj].sub(force);
                }
            }
        }
    }
}

/// Applies local planarity constraints for sp2 atoms.
pub fn apply_planarity_constraints(
    n: usize,
    adj: &[Vec<(usize, usize)>],
    geometries: &[Geometry],
    positions: &[Vec3],
    forces: &mut [Vec3],
) {
    for i in 0..n {
        if let Geometry::TrigonalPlanar = geometries[i] {
            let neighbors = &adj[i];
            if neighbors.len() == 3 {
                let p0 = positions[i];
                let p1 = positions[neighbors[0].0];
                let p2 = positions[neighbors[1].0];
                let p3 = positions[neighbors[2].0];

                let v12 = p2.sub(p1);
                let v13 = p3.sub(p1);
                let normal = v12.cross(v13).normalize();

                if normal.length_squared() < 1e-6 {
                    continue;
                }

                let v10 = p0.sub(p1);
                let dist_from_plane = v10.dot(normal);

                let correction = normal.mul(-dist_from_plane * 0.5);
                forces[i] = forces[i].add(correction);

                let recoil = correction.mul(-0.333);
                forces[neighbors[0].0] = forces[neighbors[0].0].add(recoil);
                forces[neighbors[1].0] = forces[neighbors[1].0].add(recoil);
                forces[neighbors[2].0] = forces[neighbors[2].0].add(recoil);
            }
        }
    }
}

/// Applies dihedral torsion constraints (1-4 interactions).
pub fn apply_torsion_constraints<B: BondTrait>(
    _n: usize,
    adj: &[Vec<(usize, usize)>],
    bonds: &[B],
    geometries: &[Geometry],
    positions: &[Vec3],
    forces: &mut [Vec3],
) {
    for bond in bonds {
        let (j, k) = bond.get_atom_indices();
        let order = bond.get_bond_order();

        if order < 1.5 {
            continue;
        }
        if !matches!(geometries[j], Geometry::TrigonalPlanar)
            || !matches!(geometries[k], Geometry::TrigonalPlanar)
        {
            continue;
        }

        let neighbors_j = &adj[j];
        let neighbors_k = &adj[k];

        for &(i, _) in neighbors_j {
            if i == k {
                continue;
            }
            for &(l, _) in neighbors_k {
                if l == j {
                    continue;
                }

                let p_i = positions[i];
                let p_j = positions[j];
                let p_k = positions[k];
                let p_l = positions[l];

                let b1 = p_j.sub(p_i);
                let b2 = p_k.sub(p_j);
                let b3 = p_l.sub(p_k);

                let n1 = b1.cross(b2);
                let n2 = b2.cross(b3);

                if n1.length_squared() < 1e-6 || n2.length_squared() < 1e-6 {
                    continue;
                }

                let n1_norm = n1.normalize();
                let n2_norm = n2.normalize();

                let sin_phi = n1_norm.cross(n2_norm).dot(b2.normalize());

                let strength = 0.05;
                let torque = sin_phi * strength;

                let f_i = n1_norm.mul(-torque);
                let f_l = n2_norm.mul(torque);

                forces[i] = forces[i].add(f_i);
                forces[l] = forces[l].add(f_l);
                forces[j] = forces[j].sub(f_i);
                forces[k] = forces[k].sub(f_l);
            }
        }
    }
}

/// Applies non-bonded repulsion forces.
pub fn apply_repulsion_constraints(
    n: usize,
    adj: &[Vec<(usize, usize)>],
    positions: &[Vec3],
    forces: &mut [Vec3],
) {
    let min_repulsion_d = 1.2;
    if n < 100 {
        for i in 0..n {
            for j in (i + 1)..n {
                // Skip 1-2 and 1-3 neighbors.
                if is_neighbor(i, j, adj) {
                    continue;
                }
                apply_repulsion(i, j, positions, forces, min_repulsion_d);
            }
        }
    } else {
        apply_spatial_repulsion(n, positions, adj, forces, min_repulsion_d);
    }
}

fn is_neighbor(i: usize, j: usize, adj: &[Vec<(usize, usize)>]) -> bool {
    // Check 1-2
    if adj[i].iter().any(|&(neighbor, _)| neighbor == j) {
        return true;
    }
    // Check 1-3
    for &(ni, _) in &adj[i] {
        if adj[ni].iter().any(|&(neighbor, _)| neighbor == j) {
            return true;
        }
    }
    false
}

#[inline]
fn apply_repulsion(i: usize, j: usize, positions: &[Vec3], forces: &mut [Vec3], min_d: f64) {
    let diff = positions[i].sub(positions[j]);
    let dist_sq = diff.length_squared();
    if dist_sq < min_d * min_d && dist_sq > 0.0001 {
        let dist = dist_sq.sqrt();
        let force = diff.normalize().mul((min_d - dist).powi(2) * 0.8);
        forces[i] = forces[i].add(force);
        forces[j] = forces[j].sub(force);
    }
}

fn apply_spatial_repulsion(
    _n: usize,
    positions: &[Vec3],
    adj: &[Vec<(usize, usize)>],
    forces: &mut [Vec3],
    min_d: f64,
) {
    let mut min_p = positions[0];
    let mut max_p = positions[0];
    for p in positions.iter().skip(1) {
        min_p = Vec3(min_p.0.min(p.0), min_p.1.min(p.1), min_p.2.min(p.2));
        max_p = Vec3(max_p.0.max(p.0), max_p.1.max(p.1), max_p.2.max(p.2));
    }

    let cell_size = min_d;
    let dx = ((max_p.0 - min_p.0) / min_d).ceil() as usize + 1;
    let dy = ((max_p.1 - min_p.1) / min_d).ceil() as usize + 1;
    let dz = ((max_p.2 - min_p.2) / min_d).ceil() as usize + 1;

    let mut cells = vec![Vec::new(); dx * dy * dz];
    for (i, &p) in positions.iter().enumerate() {
        let ix = ((p.0 - min_p.0) / cell_size) as usize;
        let iy = ((p.1 - min_p.1) / cell_size) as usize;
        let iz = ((p.2 - min_p.2) / cell_size) as usize;
        cells[ix * (dy * dz) + iy * dz + iz].push(i);
    }

    for ix in 0..dx {
        for iy in 0..dy {
            for iz in 0..dz {
                let c1 = ix * (dy * dz) + iy * dz + iz;
                for ox in -1..=1 {
                    for oy in -1..=1 {
                        for oz in -1..=1 {
                            let (nix, niy, niz) = (ix as i32 + ox, iy as i32 + oy, iz as i32 + oz);
                            if nix >= 0 && nix < dx as i32 && niy >= 0 && niy < dy as i32 && niz >= 0 && niz < dz as i32 {
                                let c2 = (nix as usize) * (dy * dz) + (niy as usize) * dz + (niz as usize);
                                for &i in &cells[c1] {
                                    for &j in &cells[c2] {
                                        if i < j && !is_neighbor(i, j, adj) {
                                            apply_repulsion(i, j, positions, forces, min_d);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
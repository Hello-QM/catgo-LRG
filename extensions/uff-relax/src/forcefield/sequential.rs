use crate::forcefield::System;
use glam::DVec3;
use crate::forcefield::interactions::*;

impl System {
    pub(crate) fn compute_bond_forces_sequential(&mut self) -> f64 {
        let mut energy = 0.0;
        for bond in &self.bonds {
            let (i, j) = bond.atom_indices;
            let diff = self.cell.distance_vector(self.atoms[i].position, self.atoms[j].position);
            if let Some((e, f_vec)) = calculate_bond(
                i, j, self.atoms[i].position, self.atoms[j].position, 
                bond.order, &self.atoms[i].uff_type, &self.atoms[j].uff_type, diff
            ) {
                energy += e;
                self.atoms[i].force += f_vec;
                self.atoms[j].force -= f_vec;
            }
        }
        energy
    }

    pub(crate) fn compute_angle_forces_sequential(&mut self) -> f64 {
        let mut energy = 0.0;
        let n = self.atoms.len();
        let mut adj_list = vec![Vec::new(); n];
        for bond in &self.bonds {
            adj_list[bond.atom_indices.0].push(bond.atom_indices.1);
            adj_list[bond.atom_indices.1].push(bond.atom_indices.0);
        }

        for j in 0..n {
            let neighbors = &adj_list[j];
            if neighbors.len() < 2 { continue; }
            for a_idx in 0..neighbors.len() {
                for b_idx in (a_idx + 1)..neighbors.len() {
                    let i = neighbors[a_idx];
                    let k = neighbors[b_idx];
                    let v_ji = self.cell.distance_vector(self.atoms[i].position, self.atoms[j].position);
                    let v_jk = self.cell.distance_vector(self.atoms[k].position, self.atoms[j].position);
                    
                    if let Some((e, fi, fj, fk)) = calculate_angle(
                        self.atoms[i].position, self.atoms[j].position, self.atoms[k].position,
                        &self.atoms[i].uff_type, &self.atoms[j].uff_type, &self.atoms[k].uff_type,
                        v_ji, v_jk
                    ) {
                        energy += e;
                        self.atoms[i].force += fi;
                        self.atoms[j].force += fj;
                        self.atoms[k].force += fk;
                    }
                }
            }
        }
        energy
    }

    pub(crate) fn compute_torsion_forces_sequential(&mut self) -> f64 {
        let mut energy = 0.0;
        let n = self.atoms.len();
        let mut adj_list = vec![Vec::new(); n];
        for bond in &self.bonds {
            adj_list[bond.atom_indices.0].push(bond.atom_indices.1);
            adj_list[bond.atom_indices.1].push(bond.atom_indices.0);
        }

        for bond in &self.bonds {
            let (j, k) = bond.atom_indices;
            for &i in &adj_list[j] {
                if i == k { continue; }
                for &l in &adj_list[k] {
                    if l == j || l == i { continue; }
                    let b1 = self.cell.distance_vector(self.atoms[j].position, self.atoms[i].position);
                    let b2 = self.cell.distance_vector(self.atoms[k].position, self.atoms[j].position);
                    let b3 = self.cell.distance_vector(self.atoms[l].position, self.atoms[k].position);
                    
                    if let Some((e, fi, fj, fk, fl)) = calculate_torsion(
                        b1, b2, b3, &self.atoms[j].uff_type, &self.atoms[k].uff_type, bond.order
                    ) {
                        energy += e;
                        self.atoms[i].force += fi; self.atoms[j].force += fj;
                        self.atoms[k].force += fk; self.atoms[l].force += fl;
                    }
                }
            }
        }

        // Inversion
        for j in 0..n {
            let label = self.atoms[j].uff_type.as_str();
            if label == "C_2" || label == "C_R" || label == "N_2" || label == "N_R" {
                let neighbors = &adj_list[j];
                if neighbors.len() == 3 {
                    let v01 = self.cell.distance_vector(self.atoms[neighbors[0]].position, self.atoms[j].position);
                    let v21 = self.cell.distance_vector(self.atoms[neighbors[1]].position, self.atoms[neighbors[0]].position);
                    let v31 = self.cell.distance_vector(self.atoms[neighbors[2]].position, self.atoms[neighbors[0]].position);
                    
                    if let Some((e, fj, fothers)) = calculate_inversion(
                        self.atoms[j].position, self.atoms[neighbors[0]].position, self.atoms[neighbors[1]].position, self.atoms[neighbors[2]].position,
                        v01, v21, v31
                    ) {
                        energy += e;
                        self.atoms[j].force += fj;
                        for (&ni, f) in neighbors.iter().zip(fothers.iter()) {
                            self.atoms[ni].force += *f;
                        }
                    }
                }
            }
        }
        energy
    }

    pub(crate) fn compute_non_bonded_forces_sequential_cell_list(&mut self, adj: &[Vec<usize>], cutoff: f64) -> f64 {
        let n = self.atoms.len();
        let cutoff_sq = cutoff * cutoff;
        let mut energy = 0.0;
        let positions: Vec<DVec3> = self.atoms.iter().map(|a| a.position).collect();
        let cl = crate::spatial::CellList::build(&positions, &self.cell, cutoff);

        for i in 0..n {
            let p_i = self.atoms[i].position;
            let neighbors = self.get_cell_neighbors(&cl, p_i, cutoff);
            for &j in &neighbors {
                if i >= j { continue; }
                let (is_excl, scale) = self.get_exclusion_scale(i, j, adj);
                if is_excl { continue; }
                let diff = self.cell.distance_vector(self.atoms[i].position, self.atoms[j].position);
                if let Some((e, f_vec)) = calculate_lj(diff, &self.atoms[i].uff_type, &self.atoms[j].uff_type, cutoff_sq, scale) {
                    energy += e;
                    self.atoms[i].force += f_vec;
                    self.atoms[j].force -= f_vec;
                }
            }
        }
        energy
    }
}

use crate::forcefield::System;
use glam::DVec3;
use rayon::prelude::*;
use crate::forcefield::interactions::*;

impl System {
    pub(crate) fn compute_bond_forces_parallel(&mut self) -> f64 {
        let n = self.atoms.len();
        let (total_energy, all_forces) = self.bonds.par_iter().fold(|| (0.0, vec![DVec3::ZERO; n]), |(mut acc_e, mut acc_f), bond| {
            let (i, j) = bond.atom_indices;
            let diff = self.cell.distance_vector(self.atoms[i].position, self.atoms[j].position);
            if let Some((e, f_vec)) = calculate_bond(
                i, j, self.atoms[i].position, self.atoms[j].position, 
                bond.order, &self.atoms[i].uff_type, &self.atoms[j].uff_type, diff
            ) {
                acc_e += e;
                acc_f[i] += f_vec;
                acc_f[j] -= f_vec;
            }
            (acc_e, acc_f)
        }).reduce(|| (0.0, vec![DVec3::ZERO; n]), |(e1, f1), (e2, f2)| {
            let mut f_sum = f1;
            for (a, b) in f_sum.iter_mut().zip(f2.iter()) { *a += *b; }
            (e1 + e2, f_sum)
        });

        for i in 0..n { self.atoms[i].force += all_forces[i]; }
        total_energy
    }

    pub(crate) fn compute_angle_forces_parallel(&mut self) -> f64 {
        let n = self.atoms.len();
        let mut adj_list = vec![Vec::new(); n];
        for bond in &self.bonds {
            adj_list[bond.atom_indices.0].push(bond.atom_indices.1);
            adj_list[bond.atom_indices.1].push(bond.atom_indices.0);
        }

        let (total_energy, all_forces) = (0..n).into_par_iter().fold(|| (0.0, vec![DVec3::ZERO; n]), |(mut acc_e, mut acc_f), j| {
            let neighbors = &adj_list[j];
            if neighbors.len() < 2 { return (acc_e, acc_f); }
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
                        acc_e += e;
                        acc_f[i] += fi;
                        acc_f[j] += fj;
                        acc_f[k] += fk;
                    }
                }
            }
            (acc_e, acc_f)
        }).reduce(|| (0.0, vec![DVec3::ZERO; n]), |(e1, f1), (e2, f2)| {
            let mut f_sum = f1;
            for (a, b) in f_sum.iter_mut().zip(f2.iter()) { *a += *b; }
            (e1 + e2, f_sum)
        });

        for i in 0..n { self.atoms[i].force += all_forces[i]; }
        total_energy
    }

    pub(crate) fn compute_torsion_forces_parallel(&mut self) -> f64 {
        let n = self.atoms.len();
        let mut adj_list = vec![Vec::new(); n];
        for bond in &self.bonds {
            adj_list[bond.atom_indices.0].push(bond.atom_indices.1);
            adj_list[bond.atom_indices.1].push(bond.atom_indices.0);
        }

        let (torsion_energy, torsion_forces) = self.bonds.par_iter().fold(|| (0.0, vec![DVec3::ZERO; n]), |(mut acc_e, mut acc_f), bond| {
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
                        acc_e += e;
                        acc_f[i] += fi; acc_f[j] += fj;
                        acc_f[k] += fk; acc_f[l] += fl;
                    }
                }
            }
            (acc_e, acc_f)
        }).reduce(|| (0.0, vec![DVec3::ZERO; n]), |(e1, f1), (e2, f2)| {
            let mut f_sum = f1;
            for (a, b) in f_sum.iter_mut().zip(f2.iter()) { *a += *b; }
            (e1 + e2, f_sum)
        });

        let (inv_energy, inv_forces) = (0..n).into_par_iter().fold(|| (0.0, vec![DVec3::ZERO; n]), |(mut acc_e, mut acc_f), j| {
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
                        acc_e += e;
                        acc_f[j] += fj;
                        for (&ni, f) in neighbors.iter().zip(fothers.iter()) {
                            acc_f[ni] += *f;
                        }
                    }
                }
            }
            (acc_e, acc_f)
        }).reduce(|| (0.0, vec![DVec3::ZERO; n]), |(e1, f1), (e2, f2)| {
            let mut f_sum = f1;
            for (a, b) in f_sum.iter_mut().zip(f2.iter()) { *a += *b; }
            (e1 + e2, f_sum)
        });

        for i in 0..n { self.atoms[i].force += torsion_forces[i] + inv_forces[i]; }
        torsion_energy + inv_energy
    }

    pub(crate) fn compute_non_bonded_forces_parallel_cell_list(&mut self, adj: &[Vec<usize>], cutoff: f64) -> f64 {
        let n = self.atoms.len();
        let cutoff_sq = cutoff * cutoff;
        let positions: Vec<DVec3> = self.atoms.iter().map(|a| a.position).collect();
        let cl = crate::spatial::CellList::build(&positions, &self.cell, cutoff);

        let (total_energy, all_forces) = (0..n).into_par_iter().fold(|| (0.0, vec![DVec3::ZERO; n]), |(mut acc_e, mut acc_f), i| {
            let p_i = self.atoms[i].position;
            let neighbors = self.get_cell_neighbors(&cl, p_i, cutoff);
            for &j in &neighbors {
                if i >= j { continue; }
                let (is_excl, scale) = self.get_exclusion_scale(i, j, adj);
                if is_excl { continue; }
                let diff = self.cell.distance_vector(self.atoms[i].position, self.atoms[j].position);
                if let Some((e, f_vec)) = calculate_lj(diff, &self.atoms[i].uff_type, &self.atoms[j].uff_type, cutoff_sq, scale) {
                    acc_e += e;
                    acc_f[i] += f_vec;
                    acc_f[j] -= f_vec;
                }
            }
            (acc_e, acc_f)
        }).reduce(|| (0.0, vec![DVec3::ZERO; n]), |(e1, f1), (e2, f2)| {
            let mut f_sum = f1;
            for (a, b) in f_sum.iter_mut().zip(f2.iter()) { *a += *b; }
            (e1 + e2, f_sum)
        });

        for i in 0..n { self.atoms[i].force += all_forces[i]; }
        total_energy
    }
}

use glam::DVec3;
use crate::params::get_uff_params;
use crate::atom::UffAtomType;

/// Result of a single interaction calculation
pub struct InteractionResult {
    pub energy: f64,
    pub forces: Vec<(usize, DVec3)>,
}

pub fn calculate_bond(
    _i: usize, 
    _j: usize, 
    _pos_i: DVec3, 
    _pos_j: DVec3, 
    order: f32, 
    type_i: &UffAtomType, 
    type_j: &UffAtomType,
    dist_vec: DVec3,
) -> Option<(f64, DVec3)> {
    let dist = dist_vec.length();
    if dist < 1e-6 { return None; }

    let pi = get_uff_params(type_i)?;
    let pj = get_uff_params(type_j)?;

    let r_bo = -0.1332 * (pi.r1 + pj.r1) * (order as f64).ln().max(0.0);
    let r_en = pi.r1 * pj.r1 * (pi.chi.sqrt() - pj.chi.sqrt()).powi(2) / (pi.chi * pi.r1 + pj.chi * pj.r1);
    let r0 = pi.r1 + pj.r1 + r_bo - r_en;

    let k = 664.12 * pi.z_star * pj.z_star / (r0.powi(3));
    let dr = dist - r0;
    let energy = 0.5 * k * dr * dr;
    
    let force_mag = -k * dr;
    let f_vec = dist_vec.normalize() * force_mag.clamp(-1000.0, 1000.0);
    
    Some((energy, f_vec))
}

pub fn calculate_lj(
    dist_vec: DVec3,
    type_i: &UffAtomType,
    type_j: &UffAtomType,
    cutoff_sq: f64,
    scale: f64,
) -> Option<(f64, DVec3)> {
    let dist_sq = dist_vec.length_squared();
    if dist_sq < cutoff_sq && dist_sq > 1e-6 {
        let dist = dist_sq.sqrt();
        let pi = get_uff_params(type_i)?;
        let pj = get_uff_params(type_j)?;
        let x_ij = (pi.x1 * pj.x1).sqrt();
        let d_ij = (pi.d1 * pj.d1).sqrt() * scale;
        
        let mut d = dist;
        let min_dist = x_ij * 0.4;
        if d < min_dist { d = min_dist; }
        
        let r_ratio = x_ij / d;
        let r_ratio_6 = r_ratio.powi(6);
        let r_ratio_12 = r_ratio_6 * r_ratio_6;
        
        let raw_energy = d_ij * (r_ratio_12 - 2.0 * r_ratio_6);
        let raw_f_mag = 12.0 * d_ij / d * (r_ratio_12 - r_ratio_6);
        
        // Switching function (5th order polynomial)
        // r_on = 0.9 * r_off
        let r_off = cutoff_sq.sqrt();
        let r_on = 0.9 * r_off;
        
        let (sw, dsw) = if d > r_on {
            let x = (d - r_on) / (r_off - r_on);
            let sw = 1.0 - 10.0*x.powi(3) + 15.0*x.powi(4) - 6.0*x.powi(5);
            let dsw = (-30.0*x.powi(2) + 60.0*x.powi(3) - 30.0*x.powi(4)) / (r_off - r_on);
            (sw, dsw)
        } else {
            (1.0, 0.0)
        };
        
        let energy = raw_energy * sw;
        // F = -dU/dr = -( (dE_raw/dr)*sw + E_raw*(dsw/dr) )
        // raw_f_mag is -dE_raw/dr
        let f_mag = raw_f_mag * sw - raw_energy * dsw;
        
        let f_vec = dist_vec.normalize() * f_mag.clamp(-500.0, 500.0);
        return Some((energy, f_vec));
    }
    None
}

pub fn calculate_angle(
    _pos_i: DVec3, _pos_j: DVec3, _pos_k: DVec3,
    type_i: &UffAtomType, type_j: &UffAtomType, type_k: &UffAtomType,
    v_ji: DVec3, v_jk: DVec3,
) -> Option<(f64, DVec3, DVec3, DVec3)> {
    let pi_param = get_uff_params(type_i)?;
    let pj_param = get_uff_params(type_j)?;
    let pk_param = get_uff_params(type_k)?;

    let r_ji = v_ji.length(); let r_jk = v_jk.length();
    if r_ji < 1e-6 || r_jk < 1e-6 { return None; }

    let cos_theta = (v_ji.dot(v_jk) / (r_ji * r_jk)).clamp(-1.0, 1.0);
    let theta0_rad = pj_param.theta0.to_radians();
    let cos_theta0 = theta0_rad.cos();

    let r0_ij = pi_param.r1 + pj_param.r1;
    let r0_jk = pk_param.r1 + pj_param.r1;
    let r0_ik_sq = (r0_ij*r0_ij + r0_jk*r0_jk - 2.0*r0_ij*r0_jk*cos_theta0).max(1e-6);
    let r0_ik = r0_ik_sq.sqrt();
    let k_ijk = 664.12 * pi_param.z_star * pk_param.z_star / (r0_ik.powi(5)) * 
                (3.0 * r0_ij * r0_jk * (1.0 - cos_theta0.powi(2)) - r0_ik_sq * cos_theta0);

    let theta = cos_theta.acos();
    let sin_theta = (1.0 - cos_theta * cos_theta).sqrt().max(1e-6);
    let d_e_d_theta = k_ijk * (theta - theta0_rad);
    let energy = 0.5 * k_ijk * (theta - theta0_rad).powi(2);

    let grad_theta_i = ((v_ji * cos_theta / (r_ji * r_ji)) - (v_jk / (r_ji * r_jk))) / sin_theta;
    let grad_theta_k = ((v_jk * cos_theta / (r_jk * r_jk)) - (v_ji / (r_ji * r_jk))) / sin_theta;

    let f_i = grad_theta_i * (-d_e_d_theta);
    let f_k = grad_theta_k * (-d_e_d_theta);
    let f_j = -(f_i + f_k);
    
    Some((energy, f_i, f_j, f_k))
}

pub fn calculate_torsion(
    b1: DVec3, b2: DVec3, b3: DVec3,
    type_j: &UffAtomType, type_k: &UffAtomType,
    order: f32,
) -> Option<(f64, DVec3, DVec3, DVec3, DVec3)> {
    let pj = get_uff_params(type_j)?;
    let pk = get_uff_params(type_k)?;

    let n1 = b1.cross(b2); let n2 = b2.cross(b3);
    let n1_mag_sq = n1.length_squared(); let n2_mag_sq = n2.length_squared();
    if n1_mag_sq < 1e-9 || n2_mag_sq < 1e-9 { return None; }

    let m1 = n1.cross(b2) / b2.length();
    let cos_phi = (n1.dot(n2) / (n1_mag_sq.sqrt() * n2_mag_sq.sqrt())).clamp(-1.0, 1.0);
    let sin_phi = (m1.dot(n2) / (m1.length() * n2_mag_sq.sqrt())).clamp(-1.0, 1.0);
    let phi = sin_phi.atan2(cos_phi);

    let mut v = 5.0 * (pj.u_i * pk.u_i).sqrt();
    let mut n_period = 3.0;
    let phi0 = 180.0f64.to_radians();

    if order > 1.2 {
        v = 5.0 * (pj.u_i * pk.u_i).sqrt() * (1.0 + 4.18 * (order as f64 - 1.0));
        n_period = 2.0;
    }

    let energy = 0.5 * v * (1.0 - (n_period * phi0).cos() * (n_period * phi).cos());
    let d_e_d_phi = 0.5 * v * n_period * (n_period * phi0).cos() * (n_period * phi).sin();
    
    let f_i = n1 * (-d_e_d_phi * b2.length() / n1_mag_sq);
    let f_l = n2 * (d_e_d_phi * b2.length() / n2_mag_sq);
    let f_j = f_i * (b1.dot(b2) / b2.length_squared() - 1.0) - f_l * (b3.dot(b2) / b2.length_squared());
    let f_k = -(f_i + f_l + f_j);
    
    Some((energy, f_i, f_j, f_k, f_l))
}

pub fn calculate_inversion(
    _p0: DVec3, _p1: DVec3, _p2: DVec3, _p3: DVec3,
    v01: DVec3, v21: DVec3, v31: DVec3,
) -> Option<(f64, DVec3, [DVec3; 3])> {
    let cross = v21.cross(v31);
    if cross.length_squared() < 1e-9 { return None; }
    let normal = cross.normalize();
    let h = v01.dot(normal); 
    
    let k_inv = 40.0;
    let energy = 0.5 * k_inv * h * h;
    let f_j = normal * (k_inv * h); 
    let f_others = [f_j * -0.333333, f_j * -0.333333, f_j * -0.333333];
    
    Some((energy, f_j, f_others))
}

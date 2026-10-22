//! Contracted basis sets (.fchk, .molden) → Cartesian shells.
//!
//! Follows readfch / readmolden in Multiwfn's fileIO.f90: spherical shells are
//! expanded to Cartesian ones with the gensphcartab tables, and each primitive
//! gets contraction coefficient × normgau(type, α).

use crate::spherical::{cartesian_order, sph_to_cart, Convention};
use crate::wavefunction::{angular_norm, radial_norm, Shell};

/// A shell as stored in the file.
pub struct RawShell {
    pub center: usize,
    pub l: u32,
    pub spherical: bool,
    pub exps: Vec<f64>,
    /// Contraction coefficients for normalised primitives
    pub coefs: Vec<f64>,
}

struct ShellMap {
    file_offset: usize,
    n_file: usize,
    cart_offset: usize,
    /// Spherical → Cartesian matrix (rows = Cartesian components)
    matrix: Option<Vec<Vec<f64>>>,
    /// Multiwfn's per-component normalisation folded into orbital coefficients
    norms: Vec<f64>,
}

pub struct ContractedBasis {
    pub shells: Vec<Shell>,
    /// Number of basis functions as the file counts them
    pub n_file: usize,
    /// Number of Cartesian functions
    pub n_cart: usize,
    maps: Vec<ShellMap>,
}

impl ContractedBasis {
    pub fn new(raw: &[RawShell], conv: Convention) -> Result<Self, String> {
        let mut shells = Vec::with_capacity(raw.len());
        let mut maps = Vec::with_capacity(raw.len());
        let (mut n_file, mut n_cart) = (0usize, 0usize);
        for s in raw {
            if s.l > 5 {
                return Err("basis functions above h (l > 5) are not supported".into());
            }
            let comps = cartesian_order(s.l, conv);
            let matrix = if s.spherical {
                sph_to_cart(s.l, conv)
            } else {
                None
            };
            let n_this = match &matrix {
                Some(m) => m[0].len(),
                None => comps.len(),
            };
            let coefs = s
                .exps
                .iter()
                .zip(&s.coefs)
                .map(|(&a, &c)| c * radial_norm(a, s.l))
                .collect();
            maps.push(ShellMap {
                file_offset: n_file,
                n_file: n_this,
                cart_offset: n_cart,
                matrix,
                norms: comps.iter().map(|&c| angular_norm(c)).collect(),
            });
            shells.push(Shell {
                center: s.center,
                l: s.l,
                exps: s.exps.clone(),
                coefs,
                first: n_cart,
                comps: comps.clone(),
            });
            n_file += n_this;
            n_cart += comps.len();
        }
        Ok(Self {
            shells,
            n_file,
            n_cart,
            maps,
        })
    }

    /// Orbital coefficients over file basis functions → over Cartesian
    /// functions (normalisation included).
    pub fn to_cartesian(&self, file_coefs: &[f64]) -> Vec<f64> {
        let mut out = vec![0.0; self.n_cart];
        for m in &self.maps {
            let src = &file_coefs[m.file_offset..m.file_offset + m.n_file];
            for (r, norm) in m.norms.iter().enumerate() {
                let v = match &m.matrix {
                    Some(mat) => mat[r].iter().zip(src).map(|(a, b)| a * b).sum(),
                    None => src[r],
                };
                out[m.cart_offset + r] = v * norm;
            }
        }
        out
    }
}

/// (2l-1)!!² etc. from Multiwfn's genn1n2nf: normalisation of an (l,0,0)
/// primitive is (2^n1 α^n2 / (π³ nf))^{1/4}.
fn n1n2nf(l: u32) -> (i32, i32, f64) {
    let nf = match l {
        0 | 1 => 1.0,
        2 => 9.0,
        3 => 225.0,
        4 => 11025.0,
        _ => 893025.0,
    };
    (3 + 4 * l as i32, 3 + 2 * l as i32, nf)
}

/// Normalisation factor of an (l,0,0) primitive (renormgau_ORCA in sub.f90).
pub fn norm_l00(alpha: f64, l: u32) -> f64 {
    let (n1, n2, nf) = n1n2nf(l);
    (2f64.powi(n1) * alpha.powi(n2) / (std::f64::consts::PI.powi(3) * nf))
        .sqrt()
        .sqrt()
}

/// Rescale contraction coefficients so the (l,0,0) contracted function is
/// normalised (renormmoldengau in sub.f90). Molden files from many programs
/// are only normalised up to such a factor.
pub fn renormalize_molden(l: u32, exps: &[f64], coefs: &mut [f64]) {
    let (n1, n2, nf) = n1n2nf(l);
    let fc = 2f64.powi(n1) / (std::f64::consts::PI.powi(3) * nf);
    let ctmp: Vec<f64> = exps
        .iter()
        .zip(coefs.iter())
        .map(|(&a, &c)| c * (fc * a.powi(n2)).sqrt().sqrt())
        .collect();
    let mut s = 0.0;
    for i in 0..exps.len() {
        for j in 0..=i {
            let avg = (exps[i] + exps[j]) / 2.0;
            let mut add = ctmp[i] * ctmp[j] / (fc * avg.powi(n2)).sqrt();
            if i != j {
                add *= 2.0;
            }
            s += add;
        }
    }
    if s > 1e-10 {
        let f = 1.0 / s.sqrt();
        for c in coefs.iter_mut() {
            *c *= f;
        }
    }
}

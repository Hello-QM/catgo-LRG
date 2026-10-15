//! In-memory wavefunction: atoms, Cartesian Gaussian shells and orbitals.
//!
//! Every loader reduces its file to the same picture Multiwfn uses internally
//! (fileIO.f90): Cartesian Gaussian-type functions centred on atoms, with
//! orbitals expanded over them. Spherical-harmonic shells are converted to
//! Cartesian ones on load, so evaluation never needs to know about them.
//!
//! A shell groups Cartesian components (x^i y^j z^k) that share one radial
//! part R(r) = Σ_k c_k exp(-α_k r²). Normalisation that depends on the
//! component is folded into the orbital coefficients, so the radial
//! coefficients are shared by all components of the shell.

use serde::Serialize;

use crate::elements::symbol;

pub const BOHR_TO_ANGSTROM: f64 = 0.529177210903;
pub const HARTREE_TO_EV: f64 = 27.211386245988;

#[derive(Clone, Debug)]
pub struct Atom {
    /// Atomic number (0 = ghost/Bq)
    pub z: u32,
    /// Nuclear charge; differs from `z` when an ECP is used
    pub charge: f64,
    /// Bohr
    pub xyz: [f64; 3],
}

#[derive(Clone, Debug)]
pub struct Shell {
    pub center: usize,
    /// Total angular momentum of the components (i + j + k)
    pub l: u32,
    pub exps: Vec<f64>,
    pub coefs: Vec<f64>,
    /// Cartesian exponents (i, j, k) of each component
    pub comps: Vec<[u32; 3]>,
    /// Index of this shell's first function in the orbital coefficient rows
    pub first: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Spin {
    Restricted,
    Alpha,
    Beta,
}

#[derive(Clone, Debug)]
pub struct Orbital {
    pub spin: Spin,
    /// Hartree; None when the file stores none
    pub energy: Option<f64>,
    pub occupation: f64,
    /// Coefficients over the Cartesian functions (len = `n_functions`)
    pub coefs: Vec<f64>,
}

/// s-type electron density functions (EDF) that represent ECP core density
/// in some .wfx files: ρ_EDF(r) = Σ c_k exp(-α_k |r - R_k|²).
#[derive(Clone, Debug, Default)]
pub struct Edf {
    pub centers: Vec<usize>,
    pub exps: Vec<f64>,
    pub coefs: Vec<f64>,
}

#[derive(Clone, Debug)]
pub struct Wavefunction {
    pub format: &'static str,
    pub title: String,
    pub atoms: Vec<Atom>,
    pub shells: Vec<Shell>,
    pub n_functions: usize,
    /// Alpha (or restricted) orbitals first, then beta
    pub orbitals: Vec<Orbital>,
    pub energy: Option<f64>,
    /// Charge and multiplicity stated by the file, when it has them
    pub stated_charge: Option<i64>,
    pub stated_multiplicity: Option<i64>,
    pub edf: Edf,
}

impl Wavefunction {
    pub fn unrestricted(&self) -> bool {
        self.orbitals.iter().any(|o| o.spin != Spin::Restricted)
    }

    /// (total, alpha, beta) electron counts from orbital occupations
    pub fn electrons(&self) -> (f64, f64, f64) {
        let mut a = 0.0;
        let mut b = 0.0;
        for o in &self.orbitals {
            match o.spin {
                // singly occupied restricted orbitals (ROHF) are alpha
                Spin::Restricted if o.occupation == 1.0 => a += 1.0,
                Spin::Restricted => {
                    a += o.occupation / 2.0;
                    b += o.occupation / 2.0;
                }
                Spin::Alpha => a += o.occupation,
                Spin::Beta => b += o.occupation,
            }
        }
        let edf_core = self
            .atoms
            .iter()
            .map(|at| at.z as f64 - at.charge)
            .sum::<f64>();
        let edf = if self.edf.exps.is_empty() {
            0.0
        } else {
            edf_core
        };
        (a + b + edf, a + edf / 2.0, b + edf / 2.0)
    }

    pub fn n_primitives(&self) -> usize {
        self.shells
            .iter()
            .map(|s| s.exps.len() * s.comps.len())
            .sum()
    }

    /// Indices of orbitals with nonzero occupation
    pub fn occupied(&self) -> Vec<usize> {
        (0..self.orbitals.len())
            .filter(|&i| self.orbitals[i].occupation != 0.0)
            .collect()
    }

    pub fn info(&self) -> Info {
        let atoms: Vec<InfoAtom> = self
            .atoms
            .iter()
            .map(|a| InfoAtom {
                z: a.z,
                symbol: symbol(a.z).to_string(),
                xyz: a.xyz.map(|c| c * BOHR_TO_ANGSTROM),
            })
            .collect();
        let mut xyz = format!("{}\n{}\n", atoms.len(), self.title.replace('\n', " "));
        for a in &atoms {
            xyz.push_str(&format!(
                "{} {:.8} {:.8} {:.8}\n",
                if a.z == 0 { "X" } else { &a.symbol },
                a.xyz[0],
                a.xyz[1],
                a.xyz[2]
            ));
        }

        let mut orbitals = Vec::with_capacity(self.orbitals.len());
        let mut counts = [0usize; 3];
        for (k, o) in self.orbitals.iter().enumerate() {
            let slot = o.spin as usize;
            counts[slot] += 1;
            orbitals.push(InfoOrbital {
                index: k + 1,
                number: counts[slot],
                spin: o.spin,
                energy: o.energy,
                energy_ev: o.energy.map(|e| e * HARTREE_TO_EV),
                occupation: o.occupation,
            });
        }
        let frontier = Frontier {
            restricted: frontier(&orbitals, Spin::Restricted),
            alpha: frontier(&orbitals, Spin::Alpha),
            beta: frontier(&orbitals, Spin::Beta),
        };

        let (n_elec, n_a, n_b) = self.electrons();
        let nuclear: f64 = self.atoms.iter().map(|a| a.charge).sum();
        let charge = self
            .stated_charge
            .unwrap_or((nuclear - n_elec).round() as i64);
        let multiplicity = self
            .stated_multiplicity
            .unwrap_or(((n_a - n_b).abs().round() as i64) + 1);

        Info {
            format: self.format,
            title: self.title.clone(),
            atoms,
            xyz,
            charge: Some(charge),
            multiplicity: Some(multiplicity),
            energy: self.energy,
            unrestricted: self.unrestricted(),
            orbitals,
            frontier,
            n_electrons: n_elec,
            n_functions: self.n_functions,
            n_primitives: self.n_primitives(),
        }
    }
}

#[derive(Serialize)]
pub struct InfoAtom {
    #[serde(rename = "Z")]
    pub z: u32,
    pub symbol: String,
    pub xyz: [f64; 3],
}

#[derive(Serialize, Clone)]
pub struct InfoOrbital {
    pub index: usize,
    pub number: usize,
    pub spin: Spin,
    pub energy: Option<f64>,
    pub energy_ev: Option<f64>,
    pub occupation: f64,
}

#[derive(Serialize)]
pub struct FrontierInfo {
    pub homo: Option<usize>,
    pub lumo: Option<usize>,
    pub gap: Option<f64>,
    pub gap_ev: Option<f64>,
}

#[derive(Serialize)]
pub struct Frontier {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restricted: Option<FrontierInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha: Option<FrontierInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beta: Option<FrontierInfo>,
}

/// Summary sent to the UI; same shape as the backend's WavefunctionInfo.
#[derive(Serialize)]
pub struct Info {
    pub format: &'static str,
    pub title: String,
    pub atoms: Vec<InfoAtom>,
    pub xyz: String,
    pub charge: Option<i64>,
    pub multiplicity: Option<i64>,
    pub energy: Option<f64>,
    pub unrestricted: bool,
    pub orbitals: Vec<InfoOrbital>,
    pub frontier: Frontier,
    pub n_electrons: f64,
    pub n_functions: usize,
    pub n_primitives: usize,
}

/// HOMO/LUMO of one spin set by occupation in file order.
fn frontier(orbitals: &[InfoOrbital], spin: Spin) -> Option<FrontierInfo> {
    let subset: Vec<&InfoOrbital> = orbitals.iter().filter(|o| o.spin == spin).collect();
    if subset.is_empty() {
        return None;
    }
    let homo = subset
        .iter()
        .filter(|o| o.occupation > 1e-6)
        .max_by_key(|o| o.number)
        .copied();
    let lumo = subset
        .iter()
        .find(|o| match homo {
            None => true,
            Some(h) => o.number == h.number + 1,
        })
        .copied()
        .filter(|o| o.occupation <= 1e-6);
    let gap = match (homo, lumo) {
        (Some(h), Some(l)) => match (h.energy, l.energy) {
            (Some(eh), Some(el)) => Some(el - eh),
            _ => None,
        },
        _ => None,
    };
    Some(FrontierInfo {
        homo: homo.map(|o| o.index),
        lumo: lumo.map(|o| o.index),
        gap,
        gap_ev: gap.map(|g| g * HARTREE_TO_EV),
    })
}

/// Cartesian components of angular momentum `l` in Multiwfn's internal order
/// (define.f90 type2ix/iy/iz). For g and h this is also the .fchk order; s, p,
/// d and f are listed explicitly because their file order differs.
pub fn multiwfn_order(l: u32) -> Vec<[u32; 3]> {
    match l {
        0 => vec![[0, 0, 0]],
        1 => vec![[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        2 => vec![
            [2, 0, 0],
            [0, 2, 0],
            [0, 0, 2],
            [1, 1, 0],
            [1, 0, 1],
            [0, 1, 1],
        ],
        3 => vec![
            [3, 0, 0],
            [0, 3, 0],
            [0, 0, 3],
            [2, 1, 0],
            [2, 0, 1],
            [0, 2, 1],
            [1, 2, 0],
            [1, 0, 2],
            [0, 1, 2],
            [1, 1, 1],
        ],
        _ => {
            let mut out = Vec::new();
            for i in 0..=l {
                for j in 0..=(l - i) {
                    out.push([i, j, l - i - j]);
                }
            }
            out
        }
    }
}

/// GTF type code (1–56, Multiwfn numbering) → Cartesian exponents.
pub fn type_to_comp(t: usize) -> Option<[u32; 3]> {
    let (l, offset) = match t {
        1 => (0, 1),
        2..=4 => (1, 2),
        5..=10 => (2, 5),
        11..=20 => (3, 11),
        21..=35 => (4, 21),
        36..=56 => (5, 36),
        _ => return None,
    };
    Some(multiwfn_order(l)[t - offset])
}

fn factorial(n: u32) -> f64 {
    (1..=n).map(|k| k as f64).product()
}

/// Radial normalisation of a primitive Cartesian Gaussian of total angular
/// momentum `l`: (2α/π)^{3/4} (8α)^{l/2}. Multiwfn's normgau (sub.f90) is this
/// times `angular_norm`.
pub fn radial_norm(alpha: f64, l: u32) -> f64 {
    (2.0 * alpha / std::f64::consts::PI).powf(0.75) * (8.0 * alpha).powf(l as f64 / 2.0)
}

/// Component part of Multiwfn's normgau: √(i! j! k! / ((2i)! (2j)! (2k)!)).
pub fn angular_norm(c: [u32; 3]) -> f64 {
    let num = factorial(c[0]) * factorial(c[1]) * factorial(c[2]);
    let den = factorial(2 * c[0]) * factorial(2 * c[1]) * factorial(2 * c[2]);
    (num / den).sqrt()
}

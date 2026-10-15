//! Rectangular grids and grid functions.
//!
//! Grid setup follows Multiwfn's setgrid (grid.f90) for its low / medium /
//! high quality options: the box spans the molecule plus 6 Bohr on each side
//! and holds about 125 000 / 512 000 / 1 728 000 points.

use serde::{Deserialize, Serialize};

use crate::eval::{iri, rdg, sign_lambda2_rho, BasisValues, Order};
use crate::wavefunction::Wavefunction;

const EXTENSION: f64 = 6.0;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct GridSpec {
    /// Bohr
    pub origin: [f64; 3],
    /// Bohr, along x, y and z
    pub spacing: [f64; 3],
    pub dims: [usize; 3],
}

impl GridSpec {
    pub fn n_points(&self) -> usize {
        self.dims.iter().product()
    }

    pub fn point(&self, i: usize, j: usize, k: usize) -> [f64; 3] {
        [
            self.origin[0] + i as f64 * self.spacing[0],
            self.origin[1] + j as f64 * self.spacing[1],
            self.origin[2] + k as f64 * self.spacing[2],
        ]
    }
}

pub fn quality_points(quality: &str) -> Result<f64, String> {
    match quality {
        "low" => Ok(125_000.0),
        "medium" => Ok(512_000.0),
        "high" => Ok(1_728_000.0),
        _ => Err(format!("unknown grid quality '{quality}'")),
    }
}

impl Wavefunction {
    pub fn grid(&self, quality: &str) -> Result<GridSpec, String> {
        let n_total = quality_points(quality)?;
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for a in &self.atoms {
            for k in 0..3 {
                lo[k] = lo[k].min(a.xyz[k]);
                hi[k] = hi[k].max(a.xyz[k]);
            }
        }
        let len: [f64; 3] = std::array::from_fn(|k| (hi[k] - lo[k] + 2.0 * EXTENSION).max(3.0));
        let dx = (len[0] * len[1] * len[2] / n_total).cbrt();
        Ok(GridSpec {
            origin: std::array::from_fn(|k| lo[k] - EXTENSION),
            spacing: [dx; 3],
            dims: std::array::from_fn(|k| (len[k] / dx).round() as usize + 1),
        })
    }
}

/// What to evaluate on a grid.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Function {
    /// Orbital wavefunction (0-based orbital index)
    Orbital(usize),
    Density,
    GradientNorm,
    Laplacian,
    SignLambda2Rho,
    Rdg,
    /// Two blocks: IRI, then sign(λ2)ρ
    IriSl2r,
}

impl Function {
    pub fn parse(kind: &str, orbital: usize) -> Result<Self, String> {
        Ok(match kind {
            "orbital" => Function::Orbital(orbital),
            "density" => Function::Density,
            "gradient" => Function::GradientNorm,
            "laplacian" => Function::Laplacian,
            "sl2r" => Function::SignLambda2Rho,
            "rdg" => Function::Rdg,
            "iri_sl2r" => Function::IriSl2r,
            _ => return Err(format!("unknown grid function '{kind}'")),
        })
    }

    pub fn n_blocks(self) -> usize {
        if self == Function::IriSl2r {
            2
        } else {
            1
        }
    }

    fn order(self) -> Order {
        match self {
            Function::Orbital(_) | Function::Density => Order::Value,
            Function::GradientNorm | Function::Rdg => Order::Gradient,
            _ => Order::Hessian,
        }
    }
}

impl Wavefunction {
    /// Evaluate `func` on x-slices `ix0..ix1` of `spec`, cube order (x slowest,
    /// z fastest). Multi-block functions return their blocks one after the other.
    pub fn evaluate_slab(
        &self,
        func: Function,
        spec: &GridSpec,
        ix0: usize,
        ix1: usize,
    ) -> Result<Vec<f64>, String> {
        let ix1 = ix1.min(spec.dims[0]);
        if ix0 > ix1 {
            return Err("empty slab".into());
        }
        if let Function::Orbital(mo) = func {
            if mo >= self.orbitals.len() {
                return Err(format!("orbital {} does not exist", mo + 1));
            }
        }
        let [_, ny, nz] = spec.dims;
        let n = (ix1 - ix0) * ny * nz;
        let blocks = func.n_blocks();
        let mut out = vec![0.0; n * blocks];
        let occupied = self.occupied_set();
        let mut buf = BasisValues::new(self.n_functions);
        let order = func.order();
        let mut p = 0;
        for i in ix0..ix1 {
            for j in 0..ny {
                for k in 0..nz {
                    let r = spec.point(i, j, k);
                    match func {
                        Function::Orbital(mo) => out[p] = self.orbital_at(mo, r, &mut buf),
                        _ => {
                            let (rho, g, h) = self.density_at(r, order, &occupied, &mut buf);
                            match func {
                                Function::Density => out[p] = rho,
                                Function::GradientNorm => {
                                    out[p] = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]).sqrt()
                                }
                                Function::Laplacian => out[p] = h[0] + h[1] + h[2],
                                Function::SignLambda2Rho => out[p] = sign_lambda2_rho(rho, &h),
                                Function::Rdg => out[p] = rdg(rho, &g),
                                Function::IriSl2r => {
                                    out[p] = iri(rho, &g);
                                    out[n + p] = sign_lambda2_rho(rho, &h);
                                }
                                Function::Orbital(_) => unreachable!(),
                            }
                        }
                    }
                    p += 1;
                }
            }
        }
        Ok(out)
    }
}

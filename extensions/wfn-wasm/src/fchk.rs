//! Gaussian formatted checkpoint (.fchk / .fch) loader — after Multiwfn's
//! readfch (fileIO.f90).

use std::collections::HashMap;

use crate::contracted::{ContractedBasis, RawShell};
use crate::spherical::Convention;
use crate::wavefunction::{Atom, Edf, Orbital, Spin, Wavefunction};

enum Value {
    Scalar(String),
    Array(Vec<String>),
}

fn sections(text: &str) -> (Vec<&str>, HashMap<String, Value>) {
    let lines: Vec<&str> = text.lines().collect();
    let mut map = HashMap::new();
    let mut i = 2.min(lines.len());
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if line.len() < 44 || line.starts_with(' ') {
            continue;
        }
        let label = line[..43].trim().to_string();
        let kind = line.as_bytes()[43] as char;
        let rest = &line[44..];
        if rest.contains("N=") {
            let mut vals = Vec::new();
            while i < lines.len() && lines[i].starts_with(' ') {
                if kind == 'C' || kind == 'H' {
                    vals.push(lines[i].to_string());
                } else {
                    vals.extend(lines[i].split_whitespace().map(str::to_string));
                }
                i += 1;
            }
            map.insert(label, Value::Array(vals));
        } else {
            map.insert(label, Value::Scalar(rest.trim().to_string()));
        }
    }
    (lines, map)
}

fn num(s: &str) -> Result<f64, String> {
    s.replace(['D', 'd'], "E")
        .parse::<f64>()
        .map_err(|_| format!("bad number '{s}'"))
}

struct Fields(HashMap<String, Value>);

impl Fields {
    fn scalar(&self, key: &str) -> Option<f64> {
        match self.0.get(key) {
            Some(Value::Scalar(s)) => num(s).ok(),
            _ => None,
        }
    }
    fn array(&self, key: &str) -> Result<Option<Vec<f64>>, String> {
        match self.0.get(key) {
            Some(Value::Array(v)) => v.iter().map(|s| num(s)).collect::<Result<_, _>>().map(Some),
            _ => Ok(None),
        }
    }
    fn need(&self, key: &str) -> Result<Vec<f64>, String> {
        self.array(key)?.ok_or_else(|| format!("missing '{key}'"))
    }
    /// First key that exists (PSI4 uses lower-case variants)
    fn first(&self, keys: &[&str]) -> Result<Option<Vec<f64>>, String> {
        for k in keys {
            if let Some(v) = self.array(k)? {
                return Ok(Some(v));
            }
        }
        Ok(None)
    }
}

pub fn parse(text: &str) -> Result<Wavefunction, String> {
    let (lines, map) = sections(text);
    let f = Fields(map);
    let title = lines
        .first()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    let numbers = f.need("Atomic numbers")?;
    let coords = f.need("Current cartesian coordinates")?;
    let charges = f
        .array("Nuclear charges")?
        .unwrap_or_else(|| numbers.clone());
    if coords.len() < 3 * numbers.len() {
        return Err("coordinate array too short".into());
    }
    let atoms: Vec<Atom> = numbers
        .iter()
        .enumerate()
        .map(|(k, &z)| Atom {
            z: z as u32,
            charge: charges[k],
            xyz: [coords[3 * k], coords[3 * k + 1], coords[3 * k + 2]],
        })
        .collect();

    let shell_types = f.need("Shell types")?;
    let prims_per_shell = f.need("Number of primitives per shell")?;
    let shell_atom = f.need("Shell to atom map")?;
    let exps = f.need("Primitive exponents")?;
    let coefs = f.need("Contraction coefficients")?;
    let sp_coefs = f.array("P(S=P) Contraction coefficients")?;

    let mut raw = Vec::new();
    let mut p = 0usize;
    for (k, &t) in shell_types.iter().enumerate() {
        let t = t as i32;
        let n = prims_per_shell[k] as usize;
        let center = shell_atom[k] as usize - 1;
        let e = exps[p..p + n].to_vec();
        if t == -1 {
            // SP shell → S shell + P shell sharing exponents
            let sp = sp_coefs
                .as_ref()
                .ok_or("SP shell without P(S=P) coefficients")?;
            raw.push(RawShell {
                center,
                l: 0,
                spherical: false,
                exps: e.clone(),
                coefs: coefs[p..p + n].to_vec(),
            });
            raw.push(RawShell {
                center,
                l: 1,
                spherical: false,
                exps: e,
                coefs: sp[p..p + n].to_vec(),
            });
        } else {
            raw.push(RawShell {
                center,
                l: t.unsigned_abs(),
                spherical: t <= -2,
                exps: e,
                coefs: coefs[p..p + n].to_vec(),
            });
        }
        p += n;
    }
    let basis = ContractedBasis::new(&raw, Convention::Fchk)?;
    let nbasis = f
        .scalar("Number of basis functions")
        .map(|v| v as usize)
        .unwrap_or(basis.n_file);
    if nbasis != basis.n_file {
        return Err(format!(
            "basis has {} functions but the file says {nbasis}",
            basis.n_file
        ));
    }

    let n_a = f.scalar("Number of alpha electrons").unwrap_or(0.0).round() as usize;
    let n_b = f.scalar("Number of beta electrons").unwrap_or(0.0).round() as usize;
    let save_no = ["saveNO", "SaveNO", "saveNBOocc", "SaveNBOocc"]
        .iter()
        .any(|k| title.contains(k));
    let save_nbo_ene = ["saveNBOene", "SaveNBOene"]
        .iter()
        .any(|k| title.contains(k));

    let mut orbitals = Vec::new();
    let mut add_set = |energies: Vec<f64>, mo: Vec<f64>, spin: Spin| -> Result<(), String> {
        let n_mo = energies.len();
        if mo.len() < n_mo * nbasis {
            return Err("MO coefficient array too short".into());
        }
        for (k, &e) in energies.iter().enumerate() {
            let e = if e == 1000.0 { 0.0 } else { e };
            let occupation = if save_no {
                e
            } else if save_nbo_ene {
                0.0
            } else {
                match spin {
                    Spin::Restricted if k < n_b => 2.0,
                    Spin::Restricted if k < n_a => 1.0,
                    Spin::Alpha if k < n_a => 1.0,
                    Spin::Beta if k < n_b => 1.0,
                    _ => 0.0,
                }
            };
            orbitals.push(Orbital {
                spin,
                energy: if save_no { None } else { Some(e) },
                occupation,
                coefs: basis.to_cartesian(&mo[k * nbasis..(k + 1) * nbasis]),
            });
        }
        Ok(())
    };

    let e_alpha = f
        .first(&[
            "Alpha Orbital Energies",
            "orbital energies",
            "alpha orbital energies",
        ])?
        .ok_or("no orbital energies in the file")?;
    let c_alpha = f
        .first(&[
            "Alpha MO coefficients",
            "MO coefficients",
            "alpha MO coefficients",
        ])?
        .ok_or("no MO coefficients in the file")?;
    let beta = f.first(&["Beta Orbital Energies", "beta orbital energies"])?;
    match beta {
        Some(e_beta) => {
            let c_beta = f
                .first(&["Beta MO coefficients", "beta MO coefficients"])?
                .ok_or("beta orbital energies without beta MO coefficients")?;
            add_set(e_alpha, c_alpha, Spin::Alpha)?;
            add_set(e_beta, c_beta, Spin::Beta)?;
        }
        None => add_set(e_alpha, c_alpha, Spin::Restricted)?,
    }

    Ok(Wavefunction {
        format: "fchk",
        title,
        atoms,
        n_functions: basis.n_cart,
        shells: basis.shells,
        orbitals,
        energy: f.scalar("Total Energy").or_else(|| f.scalar("SCF Energy")),
        stated_charge: f.scalar("Charge").map(|v| v.round() as i64),
        stated_multiplicity: f.scalar("Multiplicity").map(|v| v.round() as i64),
        edf: Edf::default(),
    })
}

//! AIMPAC .wfn and AIMAll .wfx loaders — after Multiwfn's readwfn / readwfx
//! (fileIO.f90). Both store uncontracted primitives with normalisation
//! already included in the orbital coefficients.

use crate::elements::atomic_number;
use crate::wavefunction::{type_to_comp, Atom, Edf, Orbital, Shell, Spin, Wavefunction};

fn num(s: &str) -> Result<f64, String> {
    s.trim()
        .replace(['D', 'd'], "E")
        .parse::<f64>()
        .map_err(|_| format!("bad number '{s}'"))
}

/// .wfn/.wfx g-function codes 21–35 (XXXX, YYYY, ZZZZ, XXXY, XXXZ, XYYY, YYYZ,
/// XZZZ, YZZZ, XXYY, XXZZ, YYZZ, XXYZ, XYYZ, XYZZ) → Multiwfn codes
/// (convGseq in readwfn).
fn wfn_type(t: usize) -> usize {
    const G: [usize; 15] = [35, 25, 21, 34, 33, 29, 24, 26, 22, 32, 30, 23, 31, 28, 27];
    if (21..=35).contains(&t) {
        G[t - 21]
    } else {
        t
    }
}

/// Group primitives into shells: consecutive primitives on the same centre
/// with the same exponent and angular momentum share one radial factor.
fn build_shells(
    centers: &[usize],
    types: &[usize],
    exps: &[f64],
) -> Result<(Vec<Shell>, Vec<Option<usize>>), String> {
    let mut shells: Vec<Shell> = Vec::new();
    // primitive → function index (None for unsupported types, dropped like Multiwfn does)
    let mut map = Vec::with_capacity(types.len());
    let mut n = 0usize;
    for k in 0..types.len() {
        let Some(comp) = type_to_comp(wfn_type(types[k])) else {
            map.push(None);
            continue;
        };
        let l = comp.iter().sum::<u32>();
        let extend = shells.last().is_some_and(|s| {
            s.center == centers[k] && s.exps[0] == exps[k] && s.l == l && !s.comps.contains(&comp)
        });
        if extend {
            shells.last_mut().unwrap().comps.push(comp);
        } else {
            shells.push(Shell {
                center: centers[k],
                l,
                exps: vec![exps[k]],
                coefs: vec![1.0],
                comps: vec![comp],
                first: n,
            });
        }
        map.push(Some(n));
        n += 1;
    }
    Ok((shells, map))
}

fn scatter(map: &[Option<usize>], n: usize, prim_coefs: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; n];
    for (k, slot) in map.iter().enumerate() {
        if let Some(f) = slot {
            out[*f] = prim_coefs[k];
        }
    }
    out
}

/// Spin of each orbital from occupations, energies and MO numbers, as
/// readwfn does when the file has no $MOSPIN block.
fn guess_spins(occ: &[f64], ene: &[f64], idx: &[usize]) -> Vec<Spin> {
    let n = occ.len();
    let integral = occ.iter().all(|o| o.fract() == 0.0);
    let total: f64 = occ.iter().sum();
    let split = |cond: &dyn Fn(usize) -> bool| -> Vec<Spin> {
        let first_beta = (1..n).find(|&i| cond(i)).unwrap_or(n);
        (0..n)
            .map(|i| {
                if i < first_beta {
                    Spin::Alpha
                } else {
                    Spin::Beta
                }
            })
            .collect()
    };
    if integral && total == 2.0 * n as f64 {
        vec![Spin::Restricted; n]
    } else if integral && total == n as f64 {
        split(&|i| ene[i] < ene[i - 1] || idx[i] > idx[i - 1] + 1)
    } else if !integral {
        let max = occ.iter().cloned().fold(0.0, f64::max);
        if max.round() == 2.0 {
            vec![Spin::Restricted; n]
        } else {
            split(&|i| occ[i] > occ[i - 1] || idx[i] > idx[i - 1] + 1)
        }
    } else if occ.iter().all(|&o| o <= 1.0) {
        // UHF with virtual orbitals: occupations are 1/0 and the beta set restarts
        split(&|i| ene[i] < ene[i - 1] || idx[i] > idx[i - 1] + 1)
    } else {
        // ROHF: doubly and singly occupied restricted orbitals
        vec![Spin::Restricted; n]
    }
}

/// Values in Fortran fixed-width fields: `skip` leading columns per line,
/// `width` columns per value, continuing over lines until `count` values.
fn fixed_fields(
    lines: &[&str],
    start: &mut usize,
    skip: usize,
    width: usize,
    count: usize,
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(count);
    while out.len() < count {
        let line = lines.get(*start).ok_or("unexpected end of file")?;
        *start += 1;
        let body = line.get(skip..).unwrap_or("");
        let mut pos = 0;
        while pos < body.len() && out.len() < count {
            let end = (pos + width).min(body.len());
            let field = body.get(pos..end).unwrap_or("").trim();
            if !field.is_empty() {
                out.push(field.to_string());
            }
            pos = end;
        }
    }
    Ok(out)
}

pub fn parse_wfn(text: &str) -> Result<Wavefunction, String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() < 3 {
        return Err("file too short".into());
    }
    let title = lines[0].trim().to_string();
    let head: Vec<&str> = lines[1].split_whitespace().collect();
    if head.len() < 7 {
        return Err("bad second line (expected orbital/primitive/nuclei counts)".into());
    }
    if lines[1].contains("SLATER") {
        return Err("Slater-type .wfn files are not supported".into());
    }
    let parse_n = |s: &str| s.parse::<usize>().map_err(|_| format!("bad count '{s}'"));
    let (n_mo, n_prim, n_atom) = (parse_n(head[1])?, parse_n(head[4])?, parse_n(head[6])?);

    let mut atoms = Vec::with_capacity(n_atom);
    for k in 0..n_atom {
        let line = lines.get(2 + k).ok_or("truncated atom block")?;
        let label = line.split_whitespace().next().unwrap_or("");
        // (a24, 3f12.8, 10x, f5.1); fall back to whitespace tokens for glued or shifted fields
        let fixed = (|| -> Result<([f64; 3], f64), String> {
            let f = |a: usize, b: usize| num(line.get(a..b).ok_or("short atom line")?);
            Ok((
                [f(24, 36)?, f(36, 48)?, f(48, 60)?],
                f(70, 75.min(line.len()))?,
            ))
        })();
        let (xyz, charge) = match fixed {
            Ok(v) => v,
            Err(_) => {
                let after = line.find(')').map(|p| &line[p + 1..]).unwrap_or(line);
                let t: Vec<&str> = after.split_whitespace().collect();
                let charge_pos = t
                    .iter()
                    .position(|s| s.starts_with("CHARGE"))
                    .ok_or("bad atom line")?;
                let v = t
                    .get(charge_pos + 2)
                    .or(t.get(charge_pos + 1))
                    .ok_or("bad atom line")?;
                (
                    [num(t[0])?, num(t[1])?, num(t[2])?],
                    num(v.trim_start_matches('='))?,
                )
            }
        };
        atoms.push(Atom {
            z: atomic_number(label),
            charge,
            xyz,
        });
    }

    let mut i = 2 + n_atom;
    let centers: Vec<usize> = fixed_fields(&lines, &mut i, 20, 3, n_prim)?
        .iter()
        .map(|s| {
            s.parse::<usize>()
                .map(|c| c.saturating_sub(1))
                .map_err(|_| format!("bad centre '{s}'"))
        })
        .collect::<Result<_, _>>()?;
    let types: Vec<usize> = fixed_fields(&lines, &mut i, 20, 3, n_prim)?
        .iter()
        .map(|s| s.parse::<usize>().map_err(|_| format!("bad type '{s}'")))
        .collect::<Result<_, _>>()?;
    let exps: Vec<f64> = fixed_fields(&lines, &mut i, 10, 14, n_prim)?
        .iter()
        .map(|s| num(s))
        .collect::<Result<_, _>>()?;
    if centers.iter().any(|&c| c >= n_atom) {
        return Err("primitive centre out of range".into());
    }

    // Gaussian ≥ G09 B.01 may add EDF CENTRE/TYPE/EXPONENTS blocks without coefficients; skip them
    while i < lines.len() && !lines[i].trim_start().starts_with("MO") {
        i += 1;
    }

    let (mut occ, mut ene, mut idx, mut coefs) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for _ in 0..n_mo {
        let h = lines.get(i).ok_or("truncated orbital block")?;
        i += 1;
        let after_mo = h.trim_start().trim_start_matches("MO");
        idx.push(
            after_mo
                .split_whitespace()
                .next()
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0),
        );
        let first_eq = h.find('=').ok_or("orbital header without '='")?;
        let last_eq = h.rfind('=').unwrap();
        occ.push(num(h[first_eq + 1..]
            .split_whitespace()
            .next()
            .unwrap_or("0"))?);
        ene.push(num(h[last_eq + 1..]
            .split_whitespace()
            .next()
            .unwrap_or("0"))?);
        let c: Vec<f64> = fixed_fields(&lines, &mut i, 0, 16, n_prim)?
            .iter()
            .map(|s| num(s))
            .collect::<Result<_, _>>()?;
        coefs.push(c);
    }

    let mut energy = None;
    if let Some(l) = lines[i..].iter().find(|l| l.contains("ENERGY")) {
        if let Some(p) = l.find('=') {
            energy = l[p + 1..]
                .split_whitespace()
                .next()
                .and_then(|s| num(s).ok());
        }
    }
    let mut spins = guess_spins(&occ, &ene, &idx);
    if let Some(p) = lines[i..]
        .iter()
        .position(|l| l.trim_start().starts_with("$MOSPIN"))
    {
        let vals: Vec<i64> = lines[i + p + 1..]
            .iter()
            .take_while(|l| !l.contains("$END"))
            .flat_map(|l| l.split_whitespace())
            .filter_map(|s| s.parse().ok())
            .collect();
        if vals.len() == n_mo {
            spins = vals
                .iter()
                .map(|v| match v {
                    1 => Spin::Alpha,
                    2 => Spin::Beta,
                    _ => Spin::Restricted,
                })
                .collect();
        }
    }

    finish(
        "wfn",
        title,
        atoms,
        &centers,
        &types,
        &exps,
        occ,
        ene,
        spins,
        coefs,
        energy,
        Edf::default(),
    )
}

#[allow(clippy::too_many_arguments)]
fn finish(
    format: &'static str,
    title: String,
    atoms: Vec<Atom>,
    centers: &[usize],
    types: &[usize],
    exps: &[f64],
    occ: Vec<f64>,
    ene: Vec<f64>,
    spins: Vec<Spin>,
    coefs: Vec<Vec<f64>>,
    energy: Option<f64>,
    edf: Edf,
) -> Result<Wavefunction, String> {
    let (shells, map) = build_shells(centers, types, exps)?;
    let n_functions = map.iter().flatten().count();
    // Without beta orbitals the set is restricted (ROHF singly occupied orbitals are tagged Alpha)
    let unrestricted = spins.iter().any(|s| *s == Spin::Beta);
    let mut orbitals: Vec<Orbital> = (0..occ.len())
        .map(|k| Orbital {
            spin: match (unrestricted, spins[k]) {
                (false, _) => Spin::Restricted,
                (true, Spin::Restricted) => Spin::Alpha,
                (true, s) => s,
            },
            energy: Some(ene[k]),
            occupation: occ[k],
            coefs: scatter(&map, n_functions, &coefs[k]),
        })
        .collect();
    // keep each spin set contiguous (Molden2AIM files may interleave them)
    orbitals.sort_by_key(|o| (o.spin == Spin::Beta) as u8);
    Ok(Wavefunction {
        format,
        title,
        atoms,
        shells,
        n_functions,
        orbitals,
        energy,
        stated_charge: None,
        stated_multiplicity: None,
        edf,
    })
}

// ── .wfx ──

fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let s = text.find(&open)? + open.len();
    let e = s + text[s..].find(&close)?;
    Some(&text[s..e])
}

fn tag_nums(text: &str, name: &str) -> Result<Option<Vec<f64>>, String> {
    match tag(text, name) {
        Some(body) => body
            .split_whitespace()
            .map(num)
            .collect::<Result<_, _>>()
            .map(Some),
        None => Ok(None),
    }
}

fn need(text: &str, name: &str) -> Result<Vec<f64>, String> {
    tag_nums(text, name)?.ok_or_else(|| format!("missing <{name}>"))
}

pub fn parse_wfx(text: &str) -> Result<Wavefunction, String> {
    let title = tag(text, "Title")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let n_atom = need(text, "Number of Nuclei")?[0] as usize;
    let n_prim = need(text, "Number of Primitives")?[0] as usize;
    let names: Vec<&str> = tag(text, "Nuclear Names")
        .unwrap_or("")
        .split_whitespace()
        .collect();
    let numbers = tag_nums(text, "Atomic Numbers")?;
    let charges = need(text, "Nuclear Charges")?;
    let coords = need(text, "Nuclear Cartesian Coordinates")?;
    if charges.len() < n_atom || coords.len() < 3 * n_atom {
        return Err("nuclear data shorter than the number of nuclei".into());
    }
    let atoms: Vec<Atom> = (0..n_atom)
        .map(|k| Atom {
            z: match &numbers {
                Some(z) => z[k] as u32,
                None => atomic_number(names.get(k).copied().unwrap_or("")),
            },
            charge: charges[k],
            xyz: [coords[3 * k], coords[3 * k + 1], coords[3 * k + 2]],
        })
        .collect();

    let centers: Vec<usize> = need(text, "Primitive Centers")?
        .iter()
        .map(|&c| c as usize - 1)
        .collect();
    let types: Vec<usize> = need(text, "Primitive Types")?
        .iter()
        .map(|&t| t as usize)
        .collect();
    let exps = need(text, "Primitive Exponents")?;
    if centers.len() != n_prim || types.len() != n_prim || exps.len() != n_prim {
        return Err("primitive arrays do not match <Number of Primitives>".into());
    }
    let occ = need(text, "Molecular Orbital Occupation Numbers")?;
    let ene = need(text, "Molecular Orbital Energies")?;
    let spins: Vec<Spin> = tag(text, "Molecular Orbital Spin Types")
        .unwrap_or("")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(|l| match l {
            "Alpha" => Spin::Alpha,
            "Beta" => Spin::Beta,
            _ => Spin::Restricted,
        })
        .collect();
    let n_mo = occ.len();
    if spins.len() != n_mo || ene.len() != n_mo {
        return Err("orbital arrays have different lengths".into());
    }

    let body = tag(text, "Molecular Orbital Primitive Coefficients")
        .ok_or("missing <Molecular Orbital Primitive Coefficients>")?;
    let mut coefs = Vec::with_capacity(n_mo);
    for chunk in body.split("</MO Number>").skip(1) {
        let data = chunk.split("<MO Number>").next().unwrap_or("");
        let v: Vec<f64> = data.split_whitespace().map(num).collect::<Result<_, _>>()?;
        if v.len() != n_prim {
            return Err(format!(
                "orbital has {} coefficients, expected {n_prim}",
                v.len()
            ));
        }
        coefs.push(v);
    }
    if coefs.len() != n_mo {
        return Err("number of orbital coefficient blocks does not match the occupations".into());
    }

    let mut edf = Edf::default();
    if let Some(n) = tag_nums(text, "Number of EDF Primitives")? {
        if n.first().copied().unwrap_or(0.0) > 0.0 {
            let et = need(text, "EDF Primitive Types")?;
            if et.iter().any(|&t| t != 1.0) {
                return Err("EDF primitives must be s type".into());
            }
            edf = Edf {
                centers: need(text, "EDF Primitive Centers")?
                    .iter()
                    .map(|&c| c as usize - 1)
                    .collect(),
                exps: need(text, "EDF Primitive Exponents")?,
                coefs: need(text, "EDF Primitive Coefficients")?,
            };
        }
    }

    let energy = tag_nums(text, "Energy = T + Vne + Vee + Vnn")?.and_then(|v| v.first().copied());
    finish(
        "wfx", title, atoms, &centers, &types, &exps, occ, ene, spins, coefs, energy, edf,
    )
}

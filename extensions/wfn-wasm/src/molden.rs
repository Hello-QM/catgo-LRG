//! Molden input (.molden / .molden.input) loader — after Multiwfn's
//! readmolden (fileIO.f90), including its fixes for ORCA, xtb and CFOUR files.

use crate::contracted::{norm_l00, renormalize_molden, ContractedBasis, RawShell};
use crate::elements::atomic_number;
use crate::spherical::Convention;
use crate::wavefunction::{Atom, Edf, Orbital, Spin, Wavefunction, BOHR_TO_ANGSTROM};

fn num(s: &str) -> Result<f64, String> {
    s.replace(['D', 'd'], "E")
        .parse::<f64>()
        .map_err(|_| format!("bad number '{s}'"))
}

fn is_section(line: &str) -> bool {
    line.trim_start().starts_with('[')
}

/// Line index of the first line whose lower-cased text starts with `tag`.
fn find_section(lines: &[&str], tag: &str) -> Option<usize> {
    lines
        .iter()
        .position(|l| l.trim_start().to_ascii_lowercase().starts_with(tag))
}

struct RawMo {
    energy: f64,
    spin: Spin,
    occupation: f64,
    coefs: Vec<(usize, f64)>,
}

pub fn parse(text: &str) -> Result<Wavefunction, String> {
    let lines: Vec<&str> = text.lines().collect();

    // ── program quirks ──
    let gto = find_section(&lines, "[gto]")
        .ok_or("no [GTO] section (STO basis sets are not supported)")?;
    let head = lines[..gto]
        .iter()
        .map(|l| l.to_ascii_lowercase())
        .collect::<Vec<_>>();
    let orca = head.iter().any(|l| l.contains("orca"));
    let cfour = !orca && head.iter().any(|l| l.contains("cfour"));
    let xtb = !orca
        && !cfour
        && lines.len() > 2
        && lines[0].trim() == "[Molden Format]"
        && lines[1].trim() == "[Title]"
        && lines[2].trim() == "[Atoms] AU";

    // ── [Atoms] ──
    let at = find_section(&lines, "[atoms]").ok_or("no [Atoms] section")?;
    let scale = if lines[at].contains("Angs") {
        1.0 / BOHR_TO_ANGSTROM
    } else {
        1.0
    };
    let mut atoms = Vec::new();
    for line in &lines[at + 1..] {
        if line.trim().is_empty() || is_section(line) {
            break;
        }
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.len() < 6 {
            return Err(format!("bad [Atoms] line '{line}'"));
        }
        let z = atomic_number(t[0]);
        // The "atomic number" column is read as the nuclear charge (ECP files edit it)
        let charge = num(t[2]).unwrap_or(z as f64);
        atoms.push(Atom {
            z,
            charge,
            xyz: [num(t[3])? * scale, num(t[4])? * scale, num(t[5])? * scale],
        });
    }
    if atoms.is_empty() {
        return Err("no atoms in [Atoms]".into());
    }

    // [Pseudo] (ORCA ≥ 6, CP2K): "El  index  charge"
    if let Some(ps) = find_section(&lines, "[pseudo]") {
        for line in &lines[ps + 1..] {
            if line.trim().is_empty() || is_section(line) {
                break;
            }
            let t: Vec<&str> = line.split_whitespace().collect();
            if t.len() >= 3 {
                if let (Ok(idx), Ok(q)) = (t[1].parse::<usize>(), num(t[2])) {
                    if idx >= 1 && idx <= atoms.len() {
                        atoms[idx - 1].charge = q;
                    }
                }
            }
        }
    }
    // [Nval]: "El  n_valence" applied to every atom of that element
    if let Some(nv) = find_section(&lines, "[nval]") {
        for line in &lines[nv + 1..] {
            if line.trim().is_empty() || is_section(line) {
                break;
            }
            let t: Vec<&str> = line.split_whitespace().collect();
            if t.len() >= 2 {
                let z = atomic_number(t[0]);
                if let Ok(q) = num(t[1]) {
                    for a in atoms.iter_mut().filter(|a| a.z == z) {
                        a.charge = q;
                    }
                }
            }
        }
    }

    // ── [GTO] ──
    let mut raw: Vec<(usize, u32, bool, Vec<f64>, Vec<f64>)> = Vec::new(); // center, l, is_sp_p, exps, coefs
    let mut i = gto + 1;
    while i < lines.len() {
        let line = lines[i].trim();
        if is_section(line) {
            break;
        }
        if line.is_empty() {
            i += 1;
            continue;
        }
        // atom header: "iatm 0"
        let t: Vec<&str> = line.split_whitespace().collect();
        let center = t[0]
            .parse::<usize>()
            .map_err(|_| format!("bad [GTO] atom line '{line}'"))?;
        if center == 0 || center > atoms.len() {
            return Err(format!("[GTO] refers to atom {center}"));
        }
        i += 1;
        while i < lines.len() {
            let sh = lines[i].trim();
            if sh.is_empty() || is_section(sh) {
                break;
            }
            let t: Vec<&str> = sh.split_whitespace().collect();
            if t.len() < 2 {
                return Err(format!("bad shell line '{sh}'"));
            }
            let label = t[0].to_ascii_lowercase();
            let ncon = t[1]
                .parse::<usize>()
                .map_err(|_| format!("bad shell line '{sh}'"))?;
            let l = match label.as_str() {
                "sp" => 0,
                "s" => 0,
                "p" => 1,
                "d" => 2,
                "f" => 3,
                "g" => 4,
                "h" => 5,
                _ => return Err(format!("unsupported shell type '{}' (up to h)", t[0])),
            };
            let (mut e, mut c, mut c_p) = (Vec::new(), Vec::new(), Vec::new());
            for k in 0..ncon {
                let pl = lines.get(i + 1 + k).ok_or("truncated [GTO] section")?;
                let v: Vec<&str> = pl.split_whitespace().collect();
                let a = num(v.first().ok_or("empty primitive line")?)?;
                let mut cc = num(v.get(1).ok_or("primitive line without coefficient")?)?;
                // Molpro writes primitives with zero coefficient; drop them
                if cc == 0.0 {
                    continue;
                }
                if orca || xtb {
                    // ORCA/xtb multiply the primitive normalisation into the coefficient
                    cc /= norm_l00(a, l);
                }
                e.push(a);
                c.push(cc);
                if label == "sp" {
                    c_p.push(num(v
                        .get(2)
                        .ok_or("SP primitive without P coefficient")?)?);
                }
            }
            i += 1 + ncon;
            renormalize_molden(l, &e, &mut c);
            raw.push((center - 1, l, false, e.clone(), c));
            if label == "sp" {
                renormalize_molden(1, &e, &mut c_p);
                raw.push((center - 1, 1, true, e, c_p));
            }
        }
    }
    if raw.is_empty() {
        return Err("no basis functions in [GTO]".into());
    }

    // ── spherical or Cartesian ──
    let max_l = raw.iter().map(|r| r.1).max().unwrap_or(0);
    let (mut d5, mut f7, mut g9, mut h11) = (orca, orca, orca, orca);
    if !orca && max_l >= 2 {
        let mut f10 = false;
        for line in lines.iter().take_while(|l| !l.contains("[MO]")) {
            if !line.contains('[') {
                continue;
            }
            d5 |= line.contains("[5D") || line.contains("[5d");
            f7 |= line.contains("[7F") || line.contains("[7f");
            f10 |= line.contains("10F") || line.contains("10f");
            g9 |= line.contains("9G") || line.contains("9g");
            h11 |= line.contains("11H") || line.contains("11h");
        }
        if d5 {
            f7 = !f10;
        }
        if max_l == 4 && f7 && !g9 {
            g9 = true;
        }
        if max_l == 5 && g9 && !h11 {
            h11 = true;
        }
    }
    let spherical_l = |l: u32| match l {
        2 => d5,
        3 => f7,
        4 => g9,
        5 => h11,
        _ => false,
    };
    let raw_shells: Vec<RawShell> = raw
        .iter()
        .map(|(center, l, _, e, c)| RawShell {
            center: *center,
            l: *l,
            spherical: spherical_l(*l),
            exps: e.clone(),
            coefs: c.clone(),
        })
        .collect();
    let basis = ContractedBasis::new(&raw_shells, Convention::Molden)?;
    let nbasis = basis.n_file;

    // ── [MO] ──
    let mo = find_section(&lines, "[mo]").ok_or("no [MO] section")?;
    let mut mos: Vec<RawMo> = Vec::new();
    let mut cur: Option<RawMo> = None;
    for line in &lines[mo + 1..] {
        let s = line.trim();
        if s.is_empty() {
            continue;
        }
        if is_section(s) {
            break;
        }
        if let Some(eq) = s.find('=') {
            let key = s[..eq].trim().to_ascii_lowercase();
            let val = s[eq + 1..].trim();
            // a new orbital starts at whichever header line follows its coefficients
            if cur.as_ref().map(|m| !m.coefs.is_empty()).unwrap_or(true) {
                if let Some(m) = cur.take() {
                    mos.push(m);
                }
                cur = Some(RawMo {
                    energy: 0.0,
                    spin: Spin::Alpha,
                    occupation: 0.0,
                    coefs: Vec::new(),
                });
            }
            let m = cur.as_mut().unwrap();
            match key.as_str() {
                "ene" => m.energy = num(val.split_whitespace().next().unwrap_or("0"))?,
                "spin" => {
                    if val.to_ascii_lowercase().starts_with("beta") {
                        m.spin = Spin::Beta
                    }
                }
                "occup" => m.occupation = num(val.split_whitespace().next().unwrap_or("0"))?,
                _ => {}
            }
            continue;
        }
        let t: Vec<&str> = s.split_whitespace().collect();
        if t.len() >= 2 {
            if let (Ok(idx), Ok(v)) = (t[0].parse::<usize>(), num(t[1])) {
                if let Some(m) = cur.as_mut() {
                    if idx >= 1 && idx <= nbasis {
                        m.coefs.push((idx - 1, v));
                    }
                }
            }
        }
    }
    if let Some(m) = cur.take() {
        mos.push(m);
    }
    if mos.is_empty() {
        return Err("no orbitals in [MO]".into());
    }

    let unrestricted = mos.iter().any(|m| m.spin == Spin::Beta);
    // Alpha (or closed-shell) orbitals first, then beta — file order within each set
    mos.sort_by_key(|m| (m.spin == Spin::Beta) as u8);

    // ORCA: F(±3), G(±3,±4), H(±3,±4) are normalised to -1
    let mut flips = vec![false; nbasis];
    if orca {
        let mut off = 0;
        for s in &raw_shells {
            let n = if s.spherical {
                2 * s.l as usize + 1
            } else {
                (s.l as usize + 1) * (s.l as usize + 2) / 2
            };
            if s.spherical && s.l >= 3 {
                let last = if s.l == 3 { 7 } else { 9 };
                for f in &mut flips[off + 5..off + last] {
                    *f = true;
                }
            }
            off += n;
        }
    }
    // CFOUR (Cartesian only): rescale d/f/g components, as Molden2AIM does
    let mut cfour_scale = vec![1.0; nbasis];
    if cfour {
        let mut off = 0;
        for s in &raw_shells {
            let n = (s.l as usize + 1) * (s.l as usize + 2) / 2;
            let sc = &mut cfour_scale[off..off + n];
            match (s.l, s.spherical) {
                (2, false) => sc[..3].iter_mut().for_each(|v| *v = 3f64.sqrt()),
                (3, false) => {
                    sc[..3].iter_mut().for_each(|v| *v = 15f64.sqrt());
                    sc[3..9].iter_mut().for_each(|v| *v = 3f64.sqrt());
                }
                (4, false) => {
                    sc[..3].iter_mut().for_each(|v| *v = 105f64.sqrt());
                    sc[3..9].iter_mut().for_each(|v| *v = 15f64.sqrt());
                    sc[9..12].iter_mut().for_each(|v| *v = 3.0);
                    sc[12..15].iter_mut().for_each(|v| *v = 3f64.sqrt());
                }
                _ => {}
            }
            off += if s.spherical { 2 * s.l as usize + 1 } else { n };
        }
    }

    let orbitals = mos
        .into_iter()
        .map(|m| {
            let mut c = vec![0.0; nbasis];
            for (k, v) in m.coefs {
                c[k] = if flips[k] { -v } else { v } * cfour_scale[k];
            }
            Orbital {
                spin: if unrestricted {
                    m.spin
                } else {
                    Spin::Restricted
                },
                energy: Some(m.energy),
                occupation: m.occupation,
                coefs: basis.to_cartesian(&c),
            }
        })
        .collect();

    // xtb drops core orbitals: nuclear charges become valence charges
    if xtb {
        for a in &mut atoms {
            let core = match a.z {
                3..=10 => 2.0,
                11..=18 => 10.0,
                19..=29 => 18.0,
                30..=36 => 28.0,
                37..=47 => 36.0,
                48..=54 => 46.0,
                55..=56 => 54.0,
                72..=79 => 68.0,
                80..=86 => 78.0,
                _ => 0.0,
            };
            if (57..=71).contains(&a.z) {
                a.charge = 3.0;
            } else {
                a.charge -= core;
            }
        }
    }

    let title = find_section(&lines, "[title]")
        .and_then(|k| lines.get(k + 1))
        .filter(|l| !is_section(l))
        .map(|l| l.trim().to_string())
        .unwrap_or_default();

    Ok(Wavefunction {
        format: "molden",
        title,
        atoms,
        n_functions: basis.n_cart,
        shells: basis.shells,
        orbitals,
        energy: None,
        stated_charge: None,
        stated_multiplicity: None,
        edf: Edf::default(),
    })
}

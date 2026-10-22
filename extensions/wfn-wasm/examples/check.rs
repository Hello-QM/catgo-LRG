//! Diagnostics for wavefunction files:
//!   cargo run --release --example check -- FILE...            → electrons vs Tr(PS)
//!   cargo run --release --example check -- --points PTS FILE  → ρ, ∇ρ, ∇²ρ tensor and
//!       |ψ_HOMO| at each "x y z" (Bohr) line of PTS, one JSON line per point

use wfn_wasm::eval::{BasisValues, Order};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--points") {
        let pts = std::fs::read_to_string(&args[1]).unwrap();
        let path = &args[2];
        let wf = wfn_wasm::load(&std::fs::read_to_string(path).unwrap(), path).unwrap();
        let occ = wf.occupied_set();
        let mut buf = BasisValues::new(wf.n_functions);
        let homo = *wf
            .occupied()
            .iter()
            .filter(|&&i| wf.orbitals[i].spin != wfn_wasm::wavefunction::Spin::Beta)
            .max()
            .unwrap();
        for line in pts.lines() {
            let v: Vec<f64> = line
                .split_whitespace()
                .map(|s| s.parse().unwrap())
                .collect();
            let r = [v[0], v[1], v[2]];
            let (rho, g, h) = wf.density_at(r, Order::Hessian, &occ, &mut buf);
            let mo = wf.orbital_at(homo, r, &mut buf);
            println!("{{\"rho\":{rho:e},\"g\":[{:e},{:e},{:e}],\"h\":[{:e},{:e},{:e},{:e},{:e},{:e}],\"homo\":{mo:e}}}",
                g[0], g[1], g[2], h[0], h[1], h[2], h[3], h[4], h[5]);
        }
        return;
    }
    for path in &args {
        let text = std::fs::read_to_string(path).unwrap();
        match wfn_wasm::load(&text, path) {
            Ok(wf) => {
                let (n, _, _) = wf.electrons();
                let t = wf.trace_ps();
                let edf = if wf.edf.exps.is_empty() {
                    0.0
                } else {
                    wf.atoms.iter().map(|a| a.z as f64 - a.charge).sum()
                };
                let flag = if (t + edf - n).abs() > 0.01 {
                    "  <-- MISMATCH"
                } else {
                    ""
                };
                println!(
                    "{path}: nelec={n:.4} TrPS={t:.6} orbs={} funcs={} unrestricted={}{flag}",
                    wf.orbitals.len(),
                    wf.n_functions,
                    wf.unrestricted()
                );
            }
            Err(e) => println!("{path}: ERROR {e}"),
        }
    }
}

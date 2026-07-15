//! Native benchmark for large-structure bond detection.
//! Reproduces the 19968-atom trajectory-playback workload to attribute the
//! wasm-side 8-12s per-frame cost. Run:
//!   cargo run --release --example bench_bonds

use ferrox::bonding::{AtomRadiiOptions, detect_bonds_atom_radii};
use ferrox::element::Element;
use ferrox::lattice::Lattice;
use ferrox::species::Species;
use ferrox::structure::Structure;
use nalgebra::Vector3;
use std::time::Instant;

fn build_synthetic(n_side: usize, spacing: f64, pbc: [bool; 3]) -> Structure {
    let a = n_side as f64 * spacing;
    let mut lattice = Lattice::cubic(a);
    lattice.pbc = pbc;
    let n = n_side * n_side * n_side;
    let mut species = Vec::with_capacity(n);
    let mut frac = Vec::with_capacity(n);
    let mut k = 0usize;
    for i in 0..n_side {
        for j in 0..n_side {
            for l in 0..n_side {
                // Si/O alternation + a few Pt, roughly zeolite-ish composition
                let elem = match k % 13 {
                    0..=3 => Element::Si,
                    12 => Element::Pt,
                    _ => Element::O,
                };
                species.push(Species::neutral(elem));
                // jitter so distances aren't degenerate
                let jit = |v: usize| (v as f64 + 0.5 + 0.13 * ((k * (v + 7)) % 7) as f64 / 7.0)
                    / n_side as f64;
                frac.push(Vector3::new(jit(i), jit(j), jit(l)));
                k += 1;
            }
        }
    }
    Structure::new(lattice, species, frac)
}

/// Time `f` with one warmup + `iters` timed runs; returns (min, median) in seconds.
fn time_it<T>(iters: usize, mut f: impl FnMut() -> T) -> (f64, f64) {
    let _ = f(); // warmup
    let mut times: Vec<f64> = (0..iters)
        .map(|_| {
            let t0 = Instant::now();
            let out = f();
            let dt = t0.elapsed().as_secs_f64();
            std::hint::black_box(out);
            dt
        })
        .collect();
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (times[0], times[times.len() / 2])
}

fn bench(label: &str, s: &Structure) {
    let opts = AtomRadiiOptions::default();
    let bonds = detect_bonds_atom_radii(s, &opts);
    let (min, med) = time_it(5, || detect_bonds_atom_radii(s, &opts));
    println!(
        "{label}: {} atoms, pbc={:?} -> {} bonds | min {:.2}ms / median {:.2}ms (5 iters)",
        s.num_sites(),
        s.lattice.pbc,
        bonds.len(),
        min * 1e3,
        med * 1e3,
    );
}

fn main() {
    let n_side = 27; // 27^3 = 19683 atoms ~ the real 19968-atom case
    let spacing = 2.4; // Angstrom, dense-ish network solid

    let s_ppp = build_synthetic(n_side, spacing, [true, true, true]);
    let s_fff = build_synthetic(n_side, spacing, [false, false, false]);

    bench("pbc TTT (cell list)         ", &s_ppp);
    bench("pbc FFF (cell list)         ", &s_fff);

    // Small sanity case
    let small = build_synthetic(8, 2.4, [true, true, true]);
    bench("small 512 TTT               ", &small);

    // Full wasm-entry replica: JSON in -> parse -> detect -> JSON out.
    // This is exactly what detect_bonds_radii (wasm.rs) does per trajectory
    // frame; splits the per-call cost into boundary vs compute.
    let json = ferrox::io::structure_to_pymatgen_json(&s_ppp);
    println!("structure JSON size: {:.1} MB", json.len() as f64 / 1e6);
    let (p_min, p_med) = time_it(5, || ferrox::io::parse_structure_json(&json).expect("parse"));
    let parsed = ferrox::io::parse_structure_json(&json).expect("parse");
    let (d_min, d_med) =
        time_it(5, || detect_bonds_atom_radii(&parsed, &AtomRadiiOptions::default()));
    let bonds = detect_bonds_atom_radii(&parsed, &AtomRadiiOptions::default());
    let (s_min, s_med) = time_it(5, || serde_json::to_string(&bonds).expect("serialize"));
    let out = serde_json::to_string(&bonds).expect("serialize");
    println!(
        "wasm-entry replica (min/median of 5): parse {:.2}/{:.2}ms + detect {:.2}/{:.2}ms + serialize {:.2}/{:.2}ms ({} bonds, out {:.2} MB)",
        p_min * 1e3,
        p_med * 1e3,
        d_min * 1e3,
        d_med * 1e3,
        s_min * 1e3,
        s_med * 1e3,
        bonds.len(),
        out.len() as f64 / 1e6
    );
}

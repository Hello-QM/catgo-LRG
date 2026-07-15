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

fn bench(label: &str, s: &Structure) {
    let opts = AtomRadiiOptions::default();
    let t0 = Instant::now();
    let bonds = detect_bonds_atom_radii(s, &opts);
    let dt = t0.elapsed();
    println!(
        "{label}: {} atoms, pbc={:?} -> {} bonds in {:.1?}",
        s.num_sites(),
        s.lattice.pbc,
        bonds.len(),
        dt
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
    let t0 = std::time::Instant::now();
    let parsed = ferrox::io::parse_structure_json(&json).expect("parse");
    let t_parse = t0.elapsed();
    let t1 = std::time::Instant::now();
    let bonds = detect_bonds_atom_radii(&parsed, &AtomRadiiOptions::default());
    let t_detect = t1.elapsed();
    let t2 = std::time::Instant::now();
    let out = serde_json::to_string(&bonds).expect("serialize");
    let t_ser = t2.elapsed();
    println!(
        "wasm-entry replica: parse {:.1?} + detect {:.1?} + serialize {:.1?} ({} bonds, out {:.2} MB)",
        t_parse,
        t_detect,
        t_ser,
        bonds.len(),
        out.len() as f64 / 1e6
    );
}

//! cargo run --release --example aim -- FILE
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let wf = wfn_wasm::load(&std::fs::read_to_string(&path).unwrap(), &path).unwrap();
    let t = std::time::Instant::now();
    let r = wf.aim();
    println!(
        "{:?} PH={} in {:.2?}",
        r.counts,
        r.poincare_hopf,
        t.elapsed()
    );
    for c in &r.critical_points {
        println!(
            "{:3} {} rho={:.5} lap={:+.5} G={:.5} V={:+.5} H={:+.5} ELF={:.4} eps={:.4} eta={:.4} {:?} {:?}",
            c.index, c.label, c.rho, c.laplacian, c.g, c.v, c.h, c.elf, c.ellipticity, c.eta, c.nucleus, c.atoms
        );
    }
    println!("{} bond paths", r.bond_paths.len());
}

//! cargo run --release --example espbench -- FILE
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let wf = wfn_wasm::load(&std::fs::read_to_string(&path).unwrap(), &path).unwrap();
    let t = std::time::Instant::now();
    let e = wfn_wasm::esp::EspEngine::new(&wf);
    println!("setup {:.2?}, {} primitive pairs", t.elapsed(), e.n_pairs());
    let mut s = wfn_wasm::esp::EspScratch::new();
    let t = std::time::Instant::now();
    let mut acc = 0.0;
    for k in 0..2000 {
        let x = -8.0 + 16.0 * (k as f64 / 2000.0);
        acc += e.total([x, 0.3 * x, 4.0], &mut s);
    }
    println!(
        "{:.1} µs per point ({acc:.3})",
        t.elapsed().as_secs_f64() / 2000.0 * 1e6
    );
}

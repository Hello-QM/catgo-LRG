//! cargo run --release --example bench -- FILE [kind] [quality]
fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let wf = wfn_wasm::load(&std::fs::read_to_string(&a[0]).unwrap(), &a[0]).unwrap();
    let kind = a.get(1).map(String::as_str).unwrap_or("iri_sl2r");
    let spec = wf
        .grid(a.get(2).map(String::as_str).unwrap_or("medium"))
        .unwrap();
    let func = wfn_wasm::grid::Function::parse(kind, wf.occupied().len() - 1).unwrap();
    let t = std::time::Instant::now();
    let v = wf.evaluate_slab(func, &spec, 0, spec.dims[0]).unwrap();
    println!(
        "{kind}: {} points ({:?}) in {:.2?}, {} functions",
        spec.n_points(),
        spec.dims,
        t.elapsed(),
        wf.n_functions
    );
    let _ = v;
}

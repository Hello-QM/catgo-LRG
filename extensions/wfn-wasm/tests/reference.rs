//! Checks against PySCF.
//!
//! tests/data holds PySCF SCF results (RHF H2O/cc-pVTZ with spherical d/f,
//! UHF triplet CH2/def2-SVP, RHF NH3/6-31G** with Cartesian d) written as
//! .molden by PySCF and converted to .fchk/.wfn/.wfx with IOData, plus
//! ρ, ∇ρ, the Hessian of ρ and the HOMO evaluated by PySCF at sample points
//! (*.ref.json, Bohr / atomic units).

use serde::Deserialize;
use wfn_wasm::eval::{iri, sign_lambda2_rho, sym3_eigenvalues, BasisValues, Order};
use wfn_wasm::grid::Function;
use wfn_wasm::wavefunction::Spin;
use wfn_wasm::Wavefunction;

#[derive(Deserialize)]
struct Value {
    rho: f64,
    g: [f64; 3],
    h: [f64; 6],
    homo: f64,
}

#[derive(Deserialize)]
struct Reference {
    points: Vec<[f64; 3]>,
    values: Vec<Value>,
}

fn data(name: &str) -> String {
    std::fs::read_to_string(format!("{}/tests/data/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn load(name: &str) -> Wavefunction {
    wfn_wasm::load(&data(name), name).unwrap()
}

fn homo(wf: &Wavefunction) -> usize {
    (0..wf.orbitals.len())
        .filter(|&i| wf.orbitals[i].occupation > 0.0 && wf.orbitals[i].spin != Spin::Beta)
        .max()
        .unwrap()
}

/// Relative error, scaled by the largest reference component.
fn close(got: &[f64], want: &[f64], tol: f64, what: &str) {
    let scale = want.iter().fold(1e-6f64, |m, v| m.max(v.abs()));
    for (g, w) in got.iter().zip(want) {
        assert!(
            (g - w).abs() / scale < tol,
            "{what}: got {got:?}, want {want:?}"
        );
    }
}

fn check(file: &str, reference: &str, tol: f64) {
    let wf = load(file);
    let r: Reference = serde_json::from_str(&data(reference)).unwrap();
    let occ = wf.occupied_set();
    let h = homo(&wf);
    let mut buf = BasisValues::new(wf.n_functions);
    for (p, v) in r.points.iter().zip(&r.values) {
        let (rho, g, hess) = wf.density_at(*p, Order::Hessian, &occ, &mut buf);
        close(&[rho], &[v.rho], tol, &format!("{file} rho"));
        close(&g, &v.g, tol, &format!("{file} grad"));
        close(&hess, &v.h, tol, &format!("{file} hessian"));
        let psi = wf.orbital_at(h, *p, &mut buf);
        // orbital phase is arbitrary
        close(&[psi.abs()], &[v.homo.abs()], tol, &format!("{file} HOMO"));
    }
    let (n, _, _) = wf.electrons();
    assert!(
        (wf.trace_ps() - n).abs() < 1e-4,
        "{file}: Tr(PS) = {} for {n} electrons",
        wf.trace_ps()
    );
}

#[test]
fn molden_matches_pyscf() {
    check("h2o_tz.molden", "h2o_tz.ref.json", 1e-10);
    check("ch2_triplet.molden", "ch2_triplet.ref.json", 1e-10);
    check("nh3_cart.molden", "nh3_cart.ref.json", 1e-10);
}

#[test]
fn fchk_matches_pyscf() {
    // .fchk stores 9 significant digits
    check("h2o_tz.fchk", "h2o_tz.ref.json", 1e-6);
    check("ch2_triplet.fchk", "ch2_triplet.ref.json", 1e-6);
    check("nh3_cart.fchk", "nh3_cart.ref.json", 1e-6);
}

#[test]
fn wfn_and_wfx_match_pyscf() {
    check("nh3_cart.wfn", "nh3_cart.ref.json", 1e-6);
    check("nh3_cart.wfx", "nh3_cart.ref.json", 1e-10);
}

#[test]
fn orbital_summary() {
    let wf = load("ch2_triplet.fchk");
    assert!(wf.unrestricted());
    let info = wf.info();
    assert_eq!(info.charge, Some(0));
    assert_eq!(info.multiplicity, Some(3));
    let a = info.frontier.alpha.as_ref().unwrap();
    let b = info.frontier.beta.as_ref().unwrap();
    // 5 alpha and 3 beta electrons; beta orbitals are numbered after all alpha ones
    let n_alpha = info
        .orbitals
        .iter()
        .filter(|o| o.spin == Spin::Alpha)
        .count();
    assert_eq!(a.homo, Some(5));
    assert_eq!(b.homo, Some(n_alpha + 3));
    assert!(a.gap.unwrap() > 0.0);

    let wf = load("h2o_tz.molden");
    let info = wf.info();
    assert!(!info.unrestricted);
    assert_eq!(info.frontier.restricted.as_ref().unwrap().homo, Some(5));
    assert_eq!(info.atoms[0].symbol, "O");
    assert!(info.xyz.starts_with("3\n"));
    assert_eq!(info.n_electrons, 10.0);
}

#[test]
fn derivatives_match_finite_differences() {
    let wf = load("h2o_tz.molden");
    let occ = wf.occupied_set();
    let mut buf = BasisValues::new(wf.n_functions);
    let p = [0.3, -0.7, 0.9];
    let step = 1e-4;
    let (_, g, h) = wf.density_at(p, Order::Hessian, &occ, &mut buf);
    const PAIRS: [(usize, usize); 6] = [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)];
    for a in 0..3 {
        let mut plus = p;
        let mut minus = p;
        plus[a] += step;
        minus[a] -= step;
        let (rp, gp, _) = wf.density_at(plus, Order::Gradient, &occ, &mut buf);
        let (rm, gm, _) = wf.density_at(minus, Order::Gradient, &occ, &mut buf);
        assert!(((rp - rm) / (2.0 * step) - g[a]).abs() < 1e-6 * g[a].abs().max(1.0));
        for (k, (i, j)) in PAIRS.iter().enumerate() {
            if *j == a {
                let fd = (gp[*i] - gm[*i]) / (2.0 * step);
                assert!(
                    (fd - h[k]).abs() < 1e-5 * h[k].abs().max(1.0),
                    "h[{k}]: {fd} vs {}",
                    h[k]
                );
            }
        }
    }
}

#[test]
fn eigenvalues_and_iri() {
    let ev = sym3_eigenvalues(&[2.0, 3.0, 4.0, 0.0, 0.0, 0.0]);
    assert_eq!(ev, [2.0, 3.0, 4.0]);
    // [[2,1,0],[1,2,0],[0,0,5]] → 1, 3, 5
    let ev = sym3_eigenvalues(&[2.0, 2.0, 5.0, 1.0, 0.0, 0.0]);
    for (a, b) in ev.iter().zip([1.0, 3.0, 5.0]) {
        assert!((a - b).abs() < 1e-12);
    }
    assert_eq!(
        sign_lambda2_rho(0.02, &[2.0, -3.0, 4.0, 0.0, 0.0, 0.0]),
        0.02
    );
    assert_eq!(
        sign_lambda2_rho(0.02, &[2.0, -3.0, -4.0, 0.0, 0.0, 0.0]),
        -0.02
    );
    assert_eq!(iri(1e-6, &[1.0, 0.0, 0.0]), 5.0);
    assert!((iri(0.1, &[0.3, 0.4, 0.0]) - 0.5 / 0.1f64.powf(1.1)).abs() < 1e-12);
}

#[test]
fn grid_follows_multiwfn_setgrid() {
    let wf = load("nh3_cart.wfx");
    let spec = wf.grid("medium").unwrap();
    let n = spec.n_points() as f64;
    assert!((n / 512_000.0 - 1.0).abs() < 0.1, "{n} points");
    let lo = wf
        .atoms
        .iter()
        .map(|a| a.xyz[2])
        .fold(f64::INFINITY, f64::min);
    assert!((spec.origin[2] - (lo - 6.0)).abs() < 1e-12);
    assert!(wf.grid("ultra").is_err());

    // slabs concatenate to the full grid
    let small = wfn_wasm::grid::GridSpec {
        origin: [-2.0, -2.0, -2.0],
        spacing: [0.5; 3],
        dims: [6, 5, 4],
    };
    let full = wf.evaluate_slab(&Function::IriSl2r, &small, 0, 6).unwrap();
    let a = wf.evaluate_slab(&Function::IriSl2r, &small, 0, 2).unwrap();
    let b = wf.evaluate_slab(&Function::IriSl2r, &small, 2, 6).unwrap();
    let n = 6 * 5 * 4;
    assert_eq!(full.len(), 2 * n);
    assert_eq!(&full[..40], &a[..40]);
    assert_eq!(&full[40..n], &b[..80]);
    assert_eq!(&full[n..n + 40], &a[40..80]);
    // orbital out of range is an error, not a panic
    assert!(wf
        .evaluate_slab(&Function::Orbital(10_000), &small, 0, 1)
        .is_err());
}

#[test]
fn rejects_bad_input() {
    assert!(wfn_wasm::load("hello", "x.xyz").is_err());
    assert!(wfn_wasm::load("hello\n", "x.fchk").is_err());
    assert!(wfn_wasm::load("[Molden Format]\n", "x.molden").is_err());
    assert!(wfn_wasm::load("t\nGAUSSIAN 1 MOL ORBITALS 1 PRIMITIVES\n", "x.wfn").is_err());
    assert!(wfn_wasm::load("<Title>\nx\n</Title>\n", "x.wfx").is_err());
}

#[derive(Deserialize)]
struct EspReference {
    points: Vec<[f64; 3]>,
    esp: Vec<f64>,
}

fn check_esp(file: &str, reference: &str, tol: f64) {
    let wf = load(file);
    let engine = wfn_wasm::esp::EspEngine::new(&wf);
    let r: EspReference = serde_json::from_str(&data(reference)).unwrap();
    let mut s = wfn_wasm::esp::EspScratch::new();
    for (p, want) in r.points.iter().zip(&r.esp) {
        let got = engine.total(*p, &mut s);
        assert!(
            (got - want).abs() < tol * want.abs().max(1e-2),
            "{file} ESP at {p:?}: {got} vs {want}"
        );
    }
}

#[test]
fn esp_matches_pyscf() {
    for name in ["h2o_tz", "ch2_triplet", "nh3_cart"] {
        check_esp(&format!("{name}.molden"), &format!("{name}.esp.json"), 1e-9);
        check_esp(&format!("{name}.fchk"), &format!("{name}.esp.json"), 1e-6);
    }
    check_esp("nh3_cart.wfn", "nh3_cart.esp.json", 1e-6);
    check_esp("nh3_cart.wfx", "nh3_cart.esp.json", 1e-9);
}

#[test]
fn aim_topology_of_water_and_water_dimer() {
    let r = load("h2o_tz.molden").aim();
    assert_eq!(
        (r.counts.ncp, r.counts.bcp, r.counts.rcp, r.counts.ccp),
        (3, 2, 0, 0)
    );
    assert_eq!(r.poincare_hopf, 1);
    let bcp = r
        .critical_points
        .iter()
        .find(|c| c.label == "(3,-1)")
        .unwrap();
    // covalent O–H: high density, negative Laplacian, V = ¼∇²ρ − 2G
    assert!(bcp.rho > 0.3 && bcp.laplacian < 0.0);
    assert!((bcp.v - (0.25 * bcp.laplacian - 2.0 * bcp.g)).abs() < 1e-12);
    assert_eq!(r.bond_paths.len(), 2);
    for p in &r.bond_paths {
        assert_eq!(p.atoms[0], 1);
        assert!(p.points.len() > 10);
    }

    let wf = load("h2o_dimer.molden");
    let r = wf.aim();
    assert_eq!((r.counts.ncp, r.counts.bcp), (6, 5));
    assert_eq!(r.poincare_hopf, 1);
    // the hydrogen bond O1–H3···O4
    let hb = r
        .critical_points
        .iter()
        .find(|c| c.atoms == Some([3, 4]))
        .expect("H-bond BCP");
    assert!(hb.rho > 0.015 && hb.rho < 0.035, "{}", hb.rho);
    assert!(hb.laplacian > 0.0 && hb.g > 0.0 && hb.v < 0.0);
    assert!(hb.elf < 0.2);
    // its bond path runs from H3 to O4 (Å)
    let path = r.bond_paths.iter().find(|p| p.atoms == [3, 4]).unwrap();
    let to_a = |i: usize| wf.atoms[i].xyz.map(|c| c * 0.529177210903);
    let d = |a: [f64; 3], b: [f64; 3]| {
        ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
    };
    // ends at the NCPs; with def2-SVP the H maximum sits ~0.07 Å off its nucleus
    assert!(d(path.points[0], to_a(2)) < 0.1);
    assert!(d(*path.points.last().unwrap(), to_a(3)) < 0.1);
}

#[test]
fn igmh_highlights_the_hydrogen_bond() {
    use wfn_wasm::igmh::IgmhScratch;
    let wf = load("h2o_dimer.molden");
    let occ = wf.occupied_set();
    let mut buf = BasisValues::new(wf.n_functions);
    let mut s = IgmhScratch::new(wf.atoms.len());
    let frags = vec![vec![0, 1, 2], vec![3, 4, 5]];
    let mut at = |r: [f64; 3]| {
        let (rho, g, h) = wf.density_at(r, Order::Hessian, &occ, &mut buf);
        (
            wf.delta_g_inter(r, rho, &g, &frags, &mut s),
            sign_lambda2_rho(rho, &h),
        )
    };
    // midway along H3···O4
    let (h, o) = (wf.atoms[2].xyz, wf.atoms[3].xyz);
    let mid: [f64; 3] = std::array::from_fn(|k| 0.6 * h[k] + 0.4 * o[k]);
    let (dg, sl2r) = at(mid);
    assert!(dg > 0.01, "δg_inter {dg}");
    assert!(sl2r < -0.01 && sl2r > -0.05, "sign(λ2)ρ {sl2r}");
    // behind a monomer, away from the contact: no inter-fragment interaction
    let far = [
        wf.atoms[0].xyz[0] - 3.0,
        wf.atoms[0].xyz[1],
        wf.atoms[0].xyz[2],
    ];
    assert!(at(far).0 < 1e-3 * dg);
    // δg_inter ≥ 0 everywhere (triangle inequality)
    for k in 0..50 {
        let t = k as f64 / 49.0;
        let r: [f64; 3] = std::array::from_fn(|i| h[i] + (o[i] - h[i]) * (2.0 * t - 0.5) + 0.3);
        assert!(at(r).0 >= -1e-12);
    }
    // fragments are validated
    let bad = serde_json::json!({"fragments": [[1, 2, 3], [3, 4]]});
    assert!(Function::parse("igmh_sl2r", &bad, 6).is_err());
    let one = serde_json::json!({"fragments": [[1, 2, 3]]});
    assert!(Function::parse("igmh_sl2r", &one, 6).is_err());
    let ok = serde_json::json!({"fragments": [[1, 2, 3], [4, 5, 6]]});
    assert_eq!(
        Function::parse("igmh_sl2r", &ok, 6).unwrap(),
        Function::IgmhSl2r(frags.clone())
    );
}

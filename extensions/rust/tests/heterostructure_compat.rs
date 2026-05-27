//! Compatibility test for the SLAB-mode heterostructure builder against
//! pymatgen-backed reference values captured from the CatGO backend
//! (`/api/heterostructure/search` and `/build`, mode = "slab").
//!
//! Test slabs:
//!   substrate: square a=b=3.00, two Cu atoms at z=10,12, c=25 vacuum
//!   film:      square a=b=3.15, two Au atoms at z=10,12, c=25 vacuum
//! Search params: max_area=200, ratio_tol=0.09, length_tol=0.06, angle_tol=0.02.

use ferrox::heterostructure::{build_interface_slab, search_matches_slab};
use ferrox::lattice::Lattice;
use ferrox::species::Species;
use ferrox::structure::Structure;
use nalgebra::{Matrix3, Vector3};

fn square_slab(a: f64, c: f64, sym: &str, zs: &[f64]) -> Structure {
    let matrix = Matrix3::new(a, 0.0, 0.0, 0.0, a, 0.0, 0.0, 0.0, c);
    let lattice = Lattice::new(matrix);
    let el = ferrox::element::Element::from_symbol(sym).unwrap();
    let species: Vec<Species> = zs.iter().map(|_| Species::neutral(el)).collect();
    let frac: Vec<Vector3<f64>> = zs.iter().map(|z| Vector3::new(0.0, 0.0, z / c)).collect();
    Structure::new(lattice, species, frac)
}

/// Hex-like slab: a=b, gamma=120, atoms at origin (0,0,z).
fn hex_slab(a: f64, c: f64, atoms: &[(&str, f64)]) -> Structure {
    let g = (120.0_f64).to_radians();
    let matrix = Matrix3::new(a, 0.0, 0.0, a * g.cos(), a * g.sin(), 0.0, 0.0, 0.0, c);
    let lattice = Lattice::new(matrix);
    let species: Vec<Species> = atoms
        .iter()
        .map(|(s, _)| Species::neutral(ferrox::element::Element::from_symbol(s).unwrap()))
        .collect();
    let frac: Vec<Vector3<f64>> = atoms
        .iter()
        .map(|(_, z)| Vector3::new(0.0, 0.0, z / c))
        .collect();
    Structure::new(lattice, species, frac)
}

#[test]
fn slab_search_matches_backend() {
    let sub = square_slab(3.0, 25.0, "Cu", &[10.0, 12.0]);
    let film = square_slab(3.15, 25.0, "Au", &[10.0, 12.0]);

    let matches = search_matches_slab(&sub, &film, 200.0, 0.09, 0.06, 0.02, 50);

    // Backend returned 50 matches (capped). We should produce the same count.
    assert_eq!(matches.len(), 50, "match count should be 50 (capped)");

    // Reference (backend, area-sorted): first few entries.
    // (match_id, area, strain, sub_T, film_T)
    // id 0: 79.38, 201.5248, [[3,0],[0,3]], [[2,2],[0,4]]
    // id 1: 89.302, 9.1796,  [[1,0],[0,10]], [[1,0],[0,9]]
    // id 7: 99.225, 8.2479,  [[1,0],[0,11]], [[1,0],[0,10]]
    let by_id = |id: usize| matches.iter().find(|m| m.match_id == id).unwrap();

    let m0 = by_id(0);
    assert!((m0.match_area - 79.38).abs() < 0.05, "m0 area {}", m0.match_area);
    assert_eq!(m0.substrate_transformation, [[3, 0], [0, 3]]);
    assert_eq!(m0.film_transformation, [[2, 2], [0, 4]]);

    let m1 = by_id(1);
    assert!((m1.match_area - 89.302).abs() < 0.05, "m1 area {}", m1.match_area);
    assert!((m1.strain - 9.1796).abs() < 0.01, "m1 strain {}", m1.strain);
    assert_eq!(m1.substrate_transformation, [[1, 0], [0, 10]]);
    assert_eq!(m1.film_transformation, [[1, 0], [0, 9]]);
    assert_eq!(m1.n_atoms_substrate, 20);
    assert_eq!(m1.n_atoms_film, 18);

    let m7 = by_id(7);
    assert!((m7.match_area - 99.225).abs() < 0.05, "m7 area {}", m7.match_area);
    assert!((m7.strain - 8.2479).abs() < 0.01, "m7 strain {}", m7.strain);
    assert_eq!(m7.substrate_transformation, [[1, 0], [0, 11]]);
    assert_eq!(m7.film_transformation, [[1, 0], [0, 10]]);

    // Area-sorted: the smallest area match must be id 0 (79.38).
    assert_eq!(matches[0].match_id, 0);
}

#[test]
fn slab_build_match1_matches_backend() {
    let sub = square_slab(3.0, 25.0, "Cu", &[10.0, 12.0]);
    let film = square_slab(3.15, 25.0, "Au", &[10.0, 12.0]);

    // match_id 1 = generation-order index of the clean ~9.18% strain match.
    let res = build_interface_slab(&sub, &film, 1, 2.0, 20.0, 200.0, 0.09, 0.06, 0.02).unwrap();

    // Backend: n_atoms=38 (20 sub + 18 film), area=90.0, strain=9.1796,
    // lattice a=3.0 b=30.0 c=26.5, angles 90/90/90.
    assert_eq!(res.n_atoms, 38);
    assert_eq!(res.n_atoms_substrate, 20);
    assert_eq!(res.n_atoms_film, 18);
    assert!((res.match_area - 90.0).abs() < 0.05, "area {}", res.match_area);
    assert!((res.strain - 9.1796).abs() < 0.01, "strain {}", res.strain);

    let lengths = res.structure.lattice.lengths();
    assert!((lengths[0] - 3.0).abs() < 1e-3, "a {}", lengths[0]);
    assert!((lengths[1] - 30.0).abs() < 1e-3, "b {}", lengths[1]);
    assert!((lengths[2] - 26.5).abs() < 1e-3, "c {}", lengths[2]);
    let angles = res.structure.lattice.angles();
    for (i, ang) in angles.iter().enumerate() {
        assert!((ang - 90.0).abs() < 1e-3, "angle[{i}] {ang}");
    }

    // Compare atom positions (sorted by element, then x, y, z) to backend.
    let mut got: Vec<(String, f64, f64, f64)> = res
        .structure
        .cart_coords()
        .iter()
        .zip(res.structure.species())
        .map(|(p, sp)| {
            (
                sp.element.symbol().to_string(),
                (p.x * 1e4).round() / 1e4,
                (p.y * 1e4).round() / 1e4,
                (p.z * 1e4).round() / 1e4,
            )
        })
        .collect();
    got.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.partial_cmp(&b.1).unwrap())
            .then(a.2.partial_cmp(&b.2).unwrap())
            .then(a.3.partial_cmp(&b.3).unwrap())
    });

    // Backend reference positions (from ref_build1.json, rounded to 1e-4).
    let reference: &[(&str, f64, f64, f64)] = &[
        ("Au", 0.0, 0.0, 4.5),
        ("Au", 0.0, 0.0, 6.5),
        ("Au", 3.0, 3.3333, 4.5),
        ("Au", 3.0, 3.3333, 6.5),
        ("Au", 3.0, 6.6667, 4.5),
        ("Au", 3.0, 6.6667, 6.5),
        ("Au", 3.0, 10.0, 4.5),
        ("Au", 3.0, 10.0, 6.5),
        ("Au", 3.0, 13.3333, 4.5),
        ("Au", 3.0, 13.3333, 6.5),
        ("Au", 3.0, 16.6667, 4.5),
        ("Au", 3.0, 16.6667, 6.5),
        ("Au", 3.0, 20.0, 4.5),
        ("Au", 3.0, 20.0, 6.5),
        ("Au", 3.0, 23.3333, 4.5),
        ("Au", 3.0, 23.3333, 6.5),
        ("Au", 3.0, 26.6667, 4.5),
        ("Au", 3.0, 26.6667, 6.5),
        ("Cu", 0.0, 0.0, 0.5),
        ("Cu", 0.0, 0.0, 2.5),
        ("Cu", 0.0, 3.0, 0.5),
        ("Cu", 0.0, 3.0, 2.5),
        ("Cu", 0.0, 6.0, 0.5),
        ("Cu", 0.0, 6.0, 2.5),
        ("Cu", 0.0, 9.0, 0.5),
        ("Cu", 0.0, 9.0, 2.5),
        ("Cu", 0.0, 12.0, 0.5),
        ("Cu", 0.0, 12.0, 2.5),
        ("Cu", 0.0, 15.0, 0.5),
        ("Cu", 0.0, 15.0, 2.5),
        ("Cu", 0.0, 18.0, 0.5),
        ("Cu", 0.0, 18.0, 2.5),
        ("Cu", 0.0, 21.0, 0.5),
        ("Cu", 0.0, 21.0, 2.5),
        ("Cu", 0.0, 24.0, 0.5),
        ("Cu", 0.0, 24.0, 2.5),
        ("Cu", 0.0, 27.0, 0.5),
        ("Cu", 0.0, 27.0, 2.5),
    ];

    assert_eq!(got.len(), reference.len());
    for (g, r) in got.iter().zip(reference.iter()) {
        assert_eq!(g.0, r.0, "element mismatch: {:?} vs {:?}", g, r);
        // Allow wrap-equivalence on x (a=3.0): 0.0 and 3.0 are the same site.
        let dx = (g.1 - r.1).abs();
        let dx_wrap = (dx - 3.0).abs().min(dx);
        assert!(dx_wrap < 1e-2, "x mismatch: {:?} vs {:?}", g, r);
        assert!((g.2 - r.2).abs() < 1e-2, "y mismatch: {:?} vs {:?}", g, r);
        assert!((g.3 - r.3).abs() < 1e-2, "z mismatch: {:?} vs {:?}", g, r);
    }
}

#[test]
fn slab_pair2_hex_matches_backend() {
    // Pair 2: graphene-like substrate (a=2.46, hex) + BN-like film (a=2.50, hex),
    // ~1.6% mismatch. Search params: max_area=120, ratio_tol=0.09,
    // length_tol=0.04, angle_tol=0.02.
    let sub = hex_slab(2.46, 20.0, &[("C", 8.0), ("C", 8.0)]);
    let film = hex_slab(2.50, 20.0, &[("B", 8.0), ("N", 8.0)]);

    let matches = search_matches_slab(&sub, &film, 120.0, 0.09, 0.04, 0.02, 50);
    assert_eq!(matches.len(), 50, "match count should be 50 (capped)");

    // Smallest-area match (sorted first) = clean 1x1, area ~5.413, strain 1.6%.
    let m0 = &matches[0];
    assert_eq!(m0.match_id, 0);
    assert!((m0.match_area - 5.413).abs() < 0.05, "m0 area {}", m0.match_area);
    assert!((m0.strain - 1.6).abs() < 0.05, "m0 strain {}", m0.strain);
    assert_eq!(m0.substrate_transformation, [[1, 0], [0, 1]]);
    assert_eq!(m0.film_transformation, [[1, 0], [0, 1]]);

    // Build the 1x1 match (generation-order id 0).
    let res = build_interface_slab(&sub, &film, 0, 2.0, 20.0, 120.0, 0.09, 0.04, 0.02).unwrap();
    // Backend: n=4 (2 sub + 2 film), area 5.24, strain 1.6,
    // lattice a=b=2.46, c=22.5, gamma=60 (reduced hex).
    assert_eq!(res.n_atoms, 4);
    assert_eq!(res.n_atoms_substrate, 2);
    assert_eq!(res.n_atoms_film, 2);
    assert!((res.strain - 1.6).abs() < 0.05, "strain {}", res.strain);
    assert!((res.match_area - 5.24).abs() < 0.05, "area {}", res.match_area);

    let lengths = res.structure.lattice.lengths();
    assert!((lengths[0] - 2.46).abs() < 1e-3, "a {}", lengths[0]);
    assert!((lengths[1] - 2.46).abs() < 1e-3, "b {}", lengths[1]);
    assert!((lengths[2] - 22.5).abs() < 1e-3, "c {}", lengths[2]);
    let gamma = res.structure.lattice.angles()[2];
    assert!((gamma - 60.0).abs() < 1e-2, "gamma {}", gamma);

    // All four atoms sit on the c-axis at origin; substrate C at z=0.5,
    // film B/N at z=2.5 (gap=2.0 above the 0.5 substrate top -> 2.5).
    let zs: Vec<(String, f64)> = res
        .structure
        .cart_coords()
        .iter()
        .zip(res.structure.species())
        .map(|(p, sp)| (sp.element.symbol().to_string(), (p.z * 1e4).round() / 1e4))
        .collect();
    let n_sub_z05 = zs.iter().filter(|(s, z)| s == "C" && (z - 0.5).abs() < 1e-2).count();
    assert_eq!(n_sub_z05, 2, "two C at z=0.5");
    let n_film_z25 = zs
        .iter()
        .filter(|(s, z)| (s == "B" || s == "N") && (z - 2.5).abs() < 1e-2)
        .count();
    assert_eq!(n_film_z25, 2, "B and N at z=2.5");
}

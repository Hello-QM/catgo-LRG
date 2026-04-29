//! ferrox-cli: Native CLI for ferrox structure operations
//!
//! Provides the same slab generation as the WASM frontend,
//! callable from Python backend via subprocess.
//!
//! Usage:
//!   ferrox-cli generate-slab < request.json > result.json

use std::io::{self, Read};
use std::process;

use ferrox::element::Element;
use ferrox::lattice::Lattice;
use ferrox::species::{SiteOccupancy, Species};
use ferrox::structure::{SlabConfig, Structure};
use nalgebra::{Matrix3, Vector3};
use serde::{Deserialize, Serialize};

// ── JSON input/output types (pymatgen-compatible) ──

#[derive(Debug, Deserialize)]
struct InputSpecies {
    element: String,
    #[serde(default = "default_occu")]
    occu: f64,
    #[serde(default)]
    oxidation_state: Option<i8>,
}

fn default_occu() -> f64 { 1.0 }

#[derive(Debug, Deserialize)]
struct InputSite {
    species: Vec<InputSpecies>,
    abc: [f64; 3],
    #[serde(default)]
    xyz: Option<[f64; 3]>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    properties: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct InputLattice {
    matrix: [[f64; 3]; 3],
    #[serde(default = "default_pbc")]
    pbc: [bool; 3],
}

fn default_pbc() -> [bool; 3] { [true, true, true] }

#[derive(Debug, Deserialize)]
struct InputStructure {
    lattice: InputLattice,
    sites: Vec<InputSite>,
}

#[derive(Debug, Deserialize)]
struct GenerateSlabRequest {
    structure: InputStructure,
    miller_index: [i32; 3],
    #[serde(default = "default_slab_size")]
    min_slab_size: f64,
    #[serde(default = "default_vacuum_size")]
    min_vacuum_size: f64,
    #[serde(default = "default_true")]
    center_slab: bool,
    #[serde(default)]
    in_unit_planes: bool,
    #[serde(default = "default_symprec")]
    symprec: f64,
    #[serde(default)]
    termination_index: Option<usize>,
}

fn default_slab_size() -> f64 { 10.0 }
fn default_vacuum_size() -> f64 { 15.0 }
fn default_true() -> bool { true }
fn default_symprec() -> f64 { 0.01 }

// ── Output types ──

#[derive(Debug, Serialize)]
struct OutputSpecies {
    element: String,
    occu: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    oxidation_state: Option<i8>,
}

#[derive(Debug, Serialize)]
struct OutputSite {
    species: Vec<OutputSpecies>,
    abc: [f64; 3],
    xyz: [f64; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(skip_serializing_if = "serde_json::Map::is_empty")]
    properties: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct OutputLattice {
    matrix: [[f64; 3]; 3],
    pbc: [bool; 3],
}

#[derive(Debug, Serialize)]
struct OutputStructure {
    lattice: OutputLattice,
    sites: Vec<OutputSite>,
}

#[derive(Debug, Serialize)]
struct GenerateSlabResult {
    slabs: Vec<OutputStructure>,
    num_slabs: usize,
    miller_index: [i32; 3],
}

// ── Conversion helpers ──

fn input_to_structure(input: &InputStructure) -> Result<Structure, String> {
    let mat = input.lattice.matrix;
    let lattice = Lattice::new(Matrix3::new(
        mat[0][0], mat[0][1], mat[0][2],
        mat[1][0], mat[1][1], mat[1][2],
        mat[2][0], mat[2][1], mat[2][2],
    ));

    let mut frac_coords = Vec::with_capacity(input.sites.len());
    let mut site_occupancies = Vec::with_capacity(input.sites.len());

    for site in &input.sites {
        frac_coords.push(Vector3::new(site.abc[0], site.abc[1], site.abc[2]));

        let species: Vec<(Species, f64)> = site.species.iter().map(|sp| {
            let elem = Element::from_symbol(&sp.element)
                .unwrap_or(Element::Dummy);
            let species = Species {
                element: elem,
                oxidation_state: sp.oxidation_state,
            };
            (species, sp.occu)
        }).collect();

        let mut props: std::collections::HashMap<String, serde_json::Value> = site.properties.iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if let Some(label) = &site.label {
            props.insert("label".to_string(), serde_json::Value::String(label.clone()));
        }
        site_occupancies.push(SiteOccupancy { species, properties: props });
    }

    Ok(Structure::new_from_occupancies(lattice, site_occupancies, frac_coords))
}

fn structure_to_output(structure: &Structure) -> OutputStructure {
    let mat = structure.lattice.matrix();
    let cart_coords = structure.cart_coords();

    let sites: Vec<OutputSite> = structure.site_occupancies.iter()
        .zip(structure.frac_coords.iter())
        .zip(cart_coords.iter())
        .enumerate()
        .map(|(idx, ((site_occ, frac), cart))| {
            let species: Vec<OutputSpecies> = site_occ.species.iter()
                .map(|(sp, occu)| OutputSpecies {
                    element: sp.element.symbol().to_string(),
                    occu: *occu,
                    oxidation_state: sp.oxidation_state,
                })
                .collect();

            let site_props = structure.site_properties(idx);

            OutputSite {
                species,
                abc: [frac.x, frac.y, frac.z],
                xyz: [cart.x, cart.y, cart.z],
                label: Some(site_occ.species_string()),
                properties: site_props.iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            }
        })
        .collect();

    OutputStructure {
        lattice: OutputLattice {
            matrix: [
                [mat[(0, 0)], mat[(0, 1)], mat[(0, 2)]],
                [mat[(1, 0)], mat[(1, 1)], mat[(1, 2)]],
                [mat[(2, 0)], mat[(2, 1)], mat[(2, 2)]],
            ],
            pbc: structure.lattice.pbc,
        },
        sites,
    }
}

// ── Main ──

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: ferrox-cli <command>");
        eprintln!("Commands:");
        eprintln!("  generate-slab    Generate surface slab(s) from JSON on stdin");
        process::exit(1);
    }

    let result = match args[1].as_str() {
        "generate-slab" => cmd_generate_slab(),
        other => {
            eprintln!("Unknown command: {}", other);
            process::exit(1);
        }
    };

    if let Err(e) = result {
        let err_json = serde_json::json!({ "error": e.to_string() });
        eprintln!("{}", err_json);
        process::exit(1);
    }
}

fn cmd_generate_slab() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;

    let req: GenerateSlabRequest = serde_json::from_str(&input)
        .map_err(|e| format!("Invalid JSON input: {}", e))?;

    let structure = input_to_structure(&req.structure)?;

    let config = SlabConfig {
        miller_index: req.miller_index,
        min_slab_size: req.min_slab_size,
        min_vacuum_size: req.min_vacuum_size,
        center_slab: req.center_slab,
        in_unit_planes: req.in_unit_planes,
        primitive: false,
        symprec: req.symprec,
        termination_index: req.termination_index,
    };

    let slabs = structure.generate_slabs(&config)
        .map_err(|e| format!("Slab generation failed: {}", e))?;

    let output_slabs: Vec<OutputStructure> = slabs.iter()
        .map(structure_to_output)
        .collect();

    let result = GenerateSlabResult {
        num_slabs: output_slabs.len(),
        miller_index: req.miller_index,
        slabs: output_slabs,
    };

    serde_json::to_writer(io::stdout().lock(), &result)?;
    Ok(())
}

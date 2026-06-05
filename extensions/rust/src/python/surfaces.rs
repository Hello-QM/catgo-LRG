//! Surface and slab operations.

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use crate::surfaces;

use super::helpers::{StructureJson, parse_struct};

/// Enumerate Miller indices up to a maximum value.
#[pyfunction]
fn enumerate_miller(max_index: i32) -> Vec<[i32; 3]> {
    let miller_list = surfaces::enumerate_miller_indices(max_index);
    miller_list.into_iter().map(|m| m.to_array()).collect()
}

/// Parse site type string to enum.
#[inline]
fn parse_site_type(site_type: &str) -> Result<surfaces::AdsorptionSiteType, String> {
    match site_type.to_lowercase().as_str() {
        "atop" | "on_top" => Ok(surfaces::AdsorptionSiteType::Atop),
        "bridge" => Ok(surfaces::AdsorptionSiteType::Bridge),
        "hollow" | "hollow3" => Ok(surfaces::AdsorptionSiteType::Hollow3),
        "hollow4" => Ok(surfaces::AdsorptionSiteType::Hollow4),
        _ => Err(format!(
            "Unknown site type: '{site_type}'. Valid types: atop, on_top, bridge, hollow, hollow3, hollow4"
        )),
    }
}

/// Find adsorption sites on a slab.
#[pyfunction]
#[pyo3(signature = (slab, height = 2.0, site_types = None, neighbor_cutoff = None, surface_tolerance = None))]
fn find_adsorption_sites(
    py: Python<'_>,
    slab: StructureJson,
    height: f64,
    site_types: Option<Vec<String>>,
    neighbor_cutoff: Option<f64>,
    surface_tolerance: Option<f64>,
) -> PyResult<Vec<Py<PyDict>>> {
    let struc = parse_struct(&slab)?;

    let site_type_enums: Option<Vec<surfaces::AdsorptionSiteType>> = site_types
        .map(|types| {
            types
                .iter()
                .map(|s| parse_site_type(s).map_err(PyValueError::new_err))
                .collect::<PyResult<_>>()
        })
        .transpose()?;

    let sites = surfaces::find_adsorption_sites(
        &struc,
        height,
        site_type_enums.as_deref(),
        neighbor_cutoff,
        surface_tolerance,
    )
    .map_err(|err| PyValueError::new_err(err.to_string()))?;

    sites
        .into_iter()
        .map(|site| {
            let dict = PyDict::new(py);
            dict.set_item("frac_coords", site.position.as_slice())?;
            dict.set_item("cart_coords", site.cart_position.as_slice())?;
            dict.set_item(
                "site_type",
                match site.site_type {
                    surfaces::AdsorptionSiteType::Atop => "atop",
                    surfaces::AdsorptionSiteType::Bridge => "bridge",
                    surfaces::AdsorptionSiteType::Hollow3 => "hollow3",
                    surfaces::AdsorptionSiteType::Hollow4 => "hollow4",
                    surfaces::AdsorptionSiteType::Other => "other",
                },
            )?;
            dict.set_item("height", site.height)?;
            Ok(dict.unbind())
        })
        .collect()
}

/// Get surface atom indices.
#[pyfunction]
#[pyo3(signature = (slab, tolerance = 0.5))]
fn get_surface_atoms(slab: StructureJson, tolerance: f64) -> PyResult<Vec<usize>> {
    let struc = parse_struct(&slab)?;
    Ok(surfaces::get_surface_atoms(&struc, tolerance))
}

/// Get the surface area of a slab.
#[pyfunction]
fn area(slab: StructureJson) -> PyResult<f64> {
    let struc = parse_struct(&slab)?;
    Ok(surfaces::surface_area(&struc))
}

/// Calculate surface energy.
#[pyfunction]
fn calculate_energy(
    slab_energy: f64,
    bulk_energy_per_atom: f64,
    n_atoms: usize,
    surface_area: f64,
) -> PyResult<f64> {
    if surface_area <= 0.0 {
        return Err(PyValueError::new_err("surface_area must be positive"));
    }
    if n_atoms == 0 {
        return Err(PyValueError::new_err("n_atoms must be greater than 0"));
    }
    if !slab_energy.is_finite() || !bulk_energy_per_atom.is_finite() {
        return Err(PyValueError::new_err("energies must be finite"));
    }
    Ok(surfaces::calculate_surface_energy(
        slab_energy,
        bulk_energy_per_atom,
        n_atoms,
        surface_area,
    ))
}

/// Calculate d-spacing for a Miller index.
#[pyfunction]
fn d_spacing(structure: StructureJson, h: i32, k: i32, l: i32) -> PyResult<f64> {
    let struc = parse_struct(&structure)?;
    surfaces::d_spacing(&struc.lattice, [h, k, l])
        .map_err(|err| PyValueError::new_err(err.to_string()))
}

/// Compute the Wulff shape from surface energies.
#[pyfunction]
fn compute_wulff(
    py: Python<'_>,
    structure: StructureJson,
    surface_energies: Vec<([i32; 3], f64)>,
) -> PyResult<Py<PyDict>> {
    if surface_energies.is_empty() {
        return Err(PyValueError::new_err("surface_energies must not be empty"));
    }
    for (miller, energy) in &surface_energies {
        if miller == &[0, 0, 0] {
            return Err(PyValueError::new_err("Miller index cannot be [0, 0, 0]"));
        }
        if !energy.is_finite() || *energy <= 0.0 {
            return Err(PyValueError::new_err(
                "Surface energies must be positive and finite",
            ));
        }
    }

    let struc = parse_struct(&structure)?;
    // Convert surface_energies to use MillerIndex
    let miller_energies: Vec<(surfaces::MillerIndex, f64)> = surface_energies
        .into_iter()
        .map(|(m, e)| (surfaces::MillerIndex::new(m[0], m[1], m[2]), e))
        .collect();
    let wulff = surfaces::compute_wulff_shape(&struc.lattice, &miller_energies)
        .map_err(|err| PyValueError::new_err(err.to_string()))?;

    let dict = PyDict::new(py);
    dict.set_item("volume", wulff.volume)?;
    dict.set_item("surface_area", wulff.total_surface_area)?;
    dict.set_item("sphericity", wulff.sphericity)?;

    let facets = PyList::empty(py);
    for facet in &wulff.facets {
        let fd = PyDict::new(py);
        fd.set_item("miller_index", facet.miller_index.to_array())?;
        fd.set_item("area_fraction", facet.area_fraction)?;
        fd.set_item("surface_energy", facet.surface_energy)?;
        // Compute normal vector for this facet
        let normal = surfaces::miller_to_normal(&struc.lattice, facet.miller_index.to_array());
        fd.set_item("normal", [normal.x, normal.y, normal.z])?;
        facets.append(fd)?;
    }
    dict.set_item("facets", facets)?;

    Ok(dict.unbind())
}

/// Convert Miller index to a normal vector.
#[pyfunction]
fn miller_to_normal(structure: StructureJson, miller: [i32; 3]) -> PyResult<[f64; 3]> {
    let struc = parse_struct(&structure)?;
    let normal = surfaces::miller_to_normal(&struc.lattice, miller);
    Ok([normal.x, normal.y, normal.z])
}

/// Generate a slab from bulk structure (low-level, direct control).
#[pyfunction]
#[pyo3(signature = (structure, h, k, l, offset = 0.0, thickness = 10.0, vacuum = 15.0, growth_mode = "Centered", supercell_a = 1, supercell_b = 1))]
fn generate_slab(
    py: Python<'_>,
    structure: StructureJson,
    h: i32,
    k: i32,
    l: i32,
    offset: f64,
    thickness: f64,
    vacuum: f64,
    growth_mode: &str,
    supercell_a: i32,
    supercell_b: i32,
) -> PyResult<String> {
    let struc = parse_struct(&structure)?;
    let growth = match growth_mode.to_lowercase().as_str() {
        "anchor_minus_z" | "anchorminusz" => crate::slab::GrowthMode::AnchorMinusZ,
        "anchor_plus_z" | "anchorplusz" => crate::slab::GrowthMode::AnchorPlusZ,
        _ => crate::slab::GrowthMode::Centered,
    };
    let config = crate::slab::SlabConfig {
        miller_index: [h, k, l],
        offset,
        thickness,
        vacuum,
        growth_mode: growth,
        supercell: [supercell_a, supercell_b],
    };
    let slab = crate::slab::generate_slab(&struc, &config)
        .map_err(|err| PyValueError::new_err(err.to_string()))?;
    let dict = super::helpers::structure_to_pydict(py, &slab)?;
    // Serialize to JSON string for consistency with other APIs
    let json_mod = py.import("json")?;
    let json_str = json_mod.call_method1("dumps", (&dict,))?;
    Ok(json_str.extract()?)
}

/// Generate a slab by explicit atomic-layer count.
///
/// Calls the SAME `slab::generate_slab_layers` that the WASM/frontend
/// `wasm_generate_slab_layers` uses, so a slab cut in the editor and one cut by
/// the backend workflow engine are identical (same Rust source). Previously only
/// the thickness-based `generate_slab` was bound to Python, which produced a
/// different cell than the editor.
#[pyfunction]
#[pyo3(signature = (structure, h, k, l, num_layers = 4, termination_index = 0, vacuum = 15.0, supercell_a = 1, supercell_b = 1))]
fn generate_slab_layers(
    py: Python<'_>,
    structure: StructureJson,
    h: i32,
    k: i32,
    l: i32,
    num_layers: usize,
    termination_index: usize,
    vacuum: f64,
    supercell_a: i32,
    supercell_b: i32,
) -> PyResult<String> {
    let struc = parse_struct(&structure)?;
    let slab = crate::slab::generate_slab_layers(
        &struc,
        [h, k, l],
        num_layers,
        termination_index,
        vacuum,
        [supercell_a, supercell_b],
    )
    .map_err(|err| PyValueError::new_err(err.to_string()))?;
    let dict = super::helpers::structure_to_pydict(py, &slab)?;
    let json_mod = py.import("json")?;
    let json_str = json_mod.call_method1("dumps", (&dict,))?;
    Ok(json_str.extract()?)
}

/// Register the surfaces submodule.
pub fn register(parent: &Bound<'_, PyModule>) -> PyResult<()> {
    let submod = PyModule::new(parent.py(), "surfaces")?;
    submod.add_function(wrap_pyfunction!(enumerate_miller, &submod)?)?;
    submod.add_function(wrap_pyfunction!(find_adsorption_sites, &submod)?)?;
    submod.add_function(wrap_pyfunction!(get_surface_atoms, &submod)?)?;
    submod.add_function(wrap_pyfunction!(area, &submod)?)?;
    submod.add_function(wrap_pyfunction!(calculate_energy, &submod)?)?;
    submod.add_function(wrap_pyfunction!(d_spacing, &submod)?)?;
    submod.add_function(wrap_pyfunction!(compute_wulff, &submod)?)?;
    submod.add_function(wrap_pyfunction!(miller_to_normal, &submod)?)?;
    submod.add_function(wrap_pyfunction!(generate_slab, &submod)?)?;
    submod.add_function(wrap_pyfunction!(generate_slab_layers, &submod)?)?;
    parent.add_submodule(&submod)?;
    Ok(())
}

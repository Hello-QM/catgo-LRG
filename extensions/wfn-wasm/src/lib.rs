//! Wavefunction analysis for CatGo, compiled to WebAssembly.
//!
//! Loads .fchk / .molden / .wfn / .wfx files and computes orbitals, the
//! electron density and density-derived functions (IRI, sign(λ2)ρ, RDG,
//! IGMH δg_inter), the electrostatic potential and the QTAIM topology, so
//! the wavefunction panel needs no external program.
//!
//! The algorithms are ported from Multiwfn (http://sobereva.com/multiwfn),
//! whose license requires citing:
//!   Tian Lu, Feiwu Chen, J. Comput. Chem. 33, 580–592 (2012)
//!   Tian Lu, J. Chem. Phys. 161, 082503 (2024)

pub mod aim;
pub mod atom_densities;
pub mod contracted;
pub mod elements;
pub mod esp;
pub mod eval;
pub mod fchk;
pub mod grid;
pub mod igmh;
pub mod molden;
pub mod overlap;
pub mod primitive;
pub mod spherical;
pub mod wavefunction;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use wavefunction::Wavefunction;

/// Load a wavefunction file; the format is chosen from the file name.
pub fn load(text: &str, filename: &str) -> Result<Wavefunction, String> {
    let name = filename.to_ascii_lowercase();
    let wf = if name.ends_with(".fchk") || name.ends_with(".fch") {
        fchk::parse(text)
    } else if name.ends_with(".molden") || name.ends_with(".molden.input") {
        molden::parse(text)
    } else if name.ends_with(".wfn") {
        primitive::parse_wfn(text)
    } else if name.ends_with(".wfx") {
        primitive::parse_wfx(text)
    } else {
        return Err(format!("{filename}: not a .fchk/.molden/.wfn/.wfx file"));
    }
    .map_err(|e| format!("{filename}: {e}"))?;
    if wf.atoms.is_empty() {
        return Err(format!("{filename}: no atoms"));
    }
    if wf.orbitals.is_empty() {
        return Err(format!("{filename}: no orbitals"));
    }
    Ok(wf)
}

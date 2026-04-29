//! Native Rust tool implementations for local/analysis operations.
//!
//! These tools execute directly in the Rust runtime without HTTP round-trip
//! to the Python backend. They handle control flow, simple analysis, and
//! structure operations that don't require pymatgen or HPC submission.
//!
//! For HPC/remote nodes (VASP, CP2K, SLURM, SSH), the `HttpBridgeTool`
//! remains the canonical dispatch path to Python handlers.

pub mod energy_compare;
pub mod convergence;
pub mod control_flow;
pub mod structure;
pub mod structure_input;
pub mod doping_gen;
pub mod strain_deform;
pub mod supercell_gen;
pub mod defect_gen;

pub use energy_compare::EnergyCompareTool;
pub use convergence::ConvergenceCheckTool;
pub use control_flow::{ConditionTool, LoopTool, MergeTool};
pub use structure_input::StructureInputTool;
pub use doping_gen::DopingGenTool;
pub use strain_deform::StrainDeformTool;
pub use supercell_gen::SupercellGenTool;
pub use defect_gen::DefectGenTool;

use std::sync::Arc;
use crate::tools::registry::ToolRegistry;

/// Register all native tools into a registry.
/// Native tools take priority over HTTP bridge for the same node_type.
pub fn register_native_tools(registry: &mut ToolRegistry) {
    // Tier 1: control flow & analysis
    registry.register(Arc::new(EnergyCompareTool::new()));
    registry.register(Arc::new(ConvergenceCheckTool::new()));
    registry.register(Arc::new(ConditionTool::new()));
    registry.register(Arc::new(LoopTool::new()));
    registry.register(Arc::new(MergeTool::new()));
    // Tier 2: structure operations
    registry.register(Arc::new(StructureInputTool::new()));
    registry.register(Arc::new(DopingGenTool::new()));
    registry.register(Arc::new(StrainDeformTool::new()));
    registry.register(Arc::new(SupercellGenTool::new()));
    registry.register(Arc::new(DefectGenTool::new()));
}

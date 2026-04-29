//! VASP adaptor with dry-run mode.
//!
//! All chemistry-specific logic lives here in the tool layer, NOT in the runtime.
//! The runtime only sees a `Tool` that accepts JSON input and returns structured output.
//!
//! In dry-run mode (default), the tool:
//! 1. Generates INCAR/POSCAR/KPOINTS files from inputs
//! 2. Writes a simulated OUTCAR with deterministic fake results
//! 3. Returns structured outputs (energy, converged, n_ionic_steps)
//! 4. Registers all generated files as artifacts
//!
//! This allows full runtime integration testing without a real VASP binary.

use async_trait::async_trait;
use std::path::Path;
use uuid::Uuid;

use crate::core::*;
use crate::graph::run::{ArtifactKind, ArtifactRef, ToolExecutionResult};
use crate::tools::traits::{Tool, ToolExecutionContext};

pub struct VaspTool {
    tool_name: String,
    dry_run: bool,
}

impl VaspTool {
    /// Create a VASP tool in dry-run mode (no real VASP execution).
    pub fn new_dry_run(name: &str) -> Self {
        Self {
            tool_name: name.to_string(),
            dry_run: true,
        }
    }
}

#[async_trait]
impl Tool for VaspTool {
    fn name(&self) -> &str {
        &self.tool_name
    }

    async fn execute(
        &self,
        ctx: ToolExecutionContext,
        inputs: serde_json::Value,
    ) -> Result<ToolExecutionResult, StructuredError> {
        let work_dir = Path::new(&ctx.work_dir);
        std::fs::create_dir_all(work_dir).map_err(|e| StructuredError {
            category: ErrorCategory::ToolInvocation,
            code: Some("IO_ERROR".into()),
            message: format!("Failed to create work_dir: {e}"),
            retryable: true,
            details: serde_json::json!({"path": ctx.work_dir}),
        })?;

        // Extract input parameters
        let structure = inputs
            .get("structure")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let calculation_type = inputs
            .get("calculation_type")
            .and_then(|v| v.as_str())
            .unwrap_or("relax");
        let encut = inputs
            .get("encut")
            .and_then(|v| v.as_f64())
            .unwrap_or(520.0);
        let kpoints = inputs
            .get("kpoints")
            .and_then(|v| v.as_str())
            .unwrap_or("3 3 1");

        let mut artifacts = Vec::new();

        // Write INCAR
        let incar_content = generate_incar(calculation_type, encut);
        let incar_path = work_dir.join("INCAR");
        write_file(&incar_path, &incar_content)?;
        artifacts.push(make_artifact(&incar_path, ArtifactKind::File));

        // Write POSCAR
        let poscar_content = generate_poscar(structure);
        let poscar_path = work_dir.join("POSCAR");
        write_file(&poscar_path, &poscar_content)?;
        artifacts.push(make_artifact(&poscar_path, ArtifactKind::File));

        // Write KPOINTS
        let kpoints_content = generate_kpoints(kpoints);
        let kpoints_path = work_dir.join("KPOINTS");
        write_file(&kpoints_path, &kpoints_content)?;
        artifacts.push(make_artifact(&kpoints_path, ArtifactKind::File));

        if !self.dry_run {
            return Err(StructuredError {
                category: ErrorCategory::ToolInvocation,
                code: Some("NOT_IMPLEMENTED".into()),
                message: "Real VASP execution not yet implemented".into(),
                retryable: false,
                details: serde_json::json!({}),
            });
        }

        // Dry-run: generate deterministic fake results
        let energy = compute_fake_energy(structure, calculation_type);
        let converged = true;
        let n_ionic_steps = if calculation_type == "relax" { 12 } else { 1 };

        // Write simulated OUTCAR
        let outcar_content = generate_fake_outcar(structure, energy, converged, n_ionic_steps);
        let outcar_path = work_dir.join("OUTCAR");
        write_file(&outcar_path, &outcar_content)?;
        artifacts.push(make_artifact(&outcar_path, ArtifactKind::File));

        // Write CONTCAR (final structure)
        let contcar_path = work_dir.join("CONTCAR");
        write_file(&contcar_path, &poscar_content)?;
        artifacts.push(make_artifact(&contcar_path, ArtifactKind::File));

        // Write result.json
        let result_json = serde_json::json!({
            "energy": energy,
            "converged": converged,
            "n_ionic_steps": n_ionic_steps,
            "final_structure": structure,
            "calculation_type": calculation_type,
        });
        let result_path = work_dir.join("result.json");
        write_file(&result_path, &serde_json::to_string_pretty(&result_json).unwrap())?;
        artifacts.push(make_artifact(&result_path, ArtifactKind::Json));

        Ok(ToolExecutionResult {
            outputs: result_json,
            artifacts,
            logs: vec![format!(
                "[{}] dry-run {} for {} completed: energy={:.4} eV",
                self.tool_name, calculation_type, structure, energy
            )],
            metadata: Default::default(),
        })
    }
}

fn write_file(path: &Path, content: &str) -> Result<(), StructuredError> {
    std::fs::write(path, content).map_err(|e| StructuredError {
        category: ErrorCategory::ToolInvocation,
        code: Some("IO_ERROR".into()),
        message: format!("Failed to write {}: {e}", path.display()),
        retryable: true,
        details: serde_json::json!({"path": path.display().to_string()}),
    })
}

fn make_artifact(path: &Path, kind: ArtifactKind) -> ArtifactRef {
    ArtifactRef {
        id: Uuid::new_v4().to_string(),
        kind,
        path: Some(path.display().to_string()),
        uri: None,
        metadata: Default::default(),
    }
}

/// Generate a minimal INCAR file content.
fn generate_incar(calculation_type: &str, encut: f64) -> String {
    let ibrion = match calculation_type {
        "relax" => 2,
        "freq" => 5,
        _ => -1,
    };
    let nsw = match calculation_type {
        "relax" => 100,
        "freq" => 1,
        _ => 0,
    };
    format!(
        "SYSTEM = CatGo auto-generated\n\
         ENCUT = {:.1}\n\
         IBRION = {}\n\
         NSW = {}\n\
         EDIFF = 1E-6\n\
         EDIFFG = -0.02\n\
         ISMEAR = 0\n\
         SIGMA = 0.05\n\
         LWAVE = .FALSE.\n\
         LCHARG = .FALSE.\n",
        encut, ibrion, nsw
    )
}

/// Generate a minimal POSCAR file content.
fn generate_poscar(structure: &str) -> String {
    format!(
        "{}\n\
         1.0\n\
         3.0 0.0 0.0\n\
         0.0 3.0 0.0\n\
         0.0 0.0 3.0\n\
         X\n\
         1\n\
         Direct\n\
         0.0 0.0 0.0\n",
        structure
    )
}

/// Generate a minimal KPOINTS file content.
fn generate_kpoints(kpoints: &str) -> String {
    format!(
        "Automatic mesh\n\
         0\n\
         Gamma\n\
         {}\n\
         0 0 0\n",
        kpoints
    )
}

/// Compute a deterministic fake energy based on structure name and calc type.
fn compute_fake_energy(structure: &str, calculation_type: &str) -> f64 {
    // Deterministic: hash the structure name to a reproducible energy value
    let hash: u32 = structure.bytes().map(|b| b as u32).sum();
    let base = -(hash as f64) * 0.1;
    match calculation_type {
        "relax" => base - 0.5,
        "freq" => base - 0.3,
        _ => base,
    }
}

/// Generate a fake OUTCAR with key fields that a parser would extract.
fn generate_fake_outcar(
    structure: &str,
    energy: f64,
    converged: bool,
    n_ionic_steps: usize,
) -> String {
    let convergence_msg = if converged {
        " reached required accuracy"
    } else {
        " NOT converged"
    };

    format!(
        " vasp.6.4.2 (CatGo dry-run)\n\
         SYSTEM = {structure}\n\
         \n\
         --- Ionic step {n_ionic_steps} ---\n\
         \n\
         energy without entropy=    {energy:.8}  energy(sigma->0) =    {energy:.8}\n\
         \n\
         {convergence_msg}\n\
         \n\
         General timing:\n\
         LOOP:  cpu time    0.00: real time    0.00\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn test_ctx(work_dir: &str) -> ToolExecutionContext {
        ToolExecutionContext {
            run_id: "run-vasp-001".to_string(),
            node_id: "relax_slab".to_string(),
            attempt_index: 1,
            work_dir: work_dir.to_string(),
        }
    }

    #[tokio::test]
    async fn test_dry_run_creates_all_input_files() {
        let tmp = TempDir::new().unwrap();
        let tool = VaspTool::new_dry_run("vasp_relax");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let inputs = json!({
            "structure": "Pt(111)",
            "calculation_type": "relax",
            "encut": 450.0,
            "kpoints": "4 4 1"
        });

        let result = tool.execute(ctx, inputs).await.unwrap();

        // All VASP input files exist
        assert!(tmp.path().join("INCAR").exists());
        assert!(tmp.path().join("POSCAR").exists());
        assert!(tmp.path().join("KPOINTS").exists());

        // Output files from dry-run
        assert!(tmp.path().join("OUTCAR").exists());
        assert!(tmp.path().join("CONTCAR").exists());
        assert!(tmp.path().join("result.json").exists());

        // 6 artifacts total (INCAR, POSCAR, KPOINTS, OUTCAR, CONTCAR, result.json)
        assert_eq!(result.artifacts.len(), 6);
    }

    #[tokio::test]
    async fn test_dry_run_returns_structured_outputs() {
        let tmp = TempDir::new().unwrap();
        let tool = VaspTool::new_dry_run("vasp");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let result = tool
            .execute(
                ctx,
                json!({"structure": "Si", "calculation_type": "relax"}),
            )
            .await
            .unwrap();

        assert!(result.outputs.get("energy").is_some());
        assert_eq!(result.outputs["converged"], true);
        assert_eq!(result.outputs["n_ionic_steps"], 12);
        assert_eq!(result.outputs["final_structure"], "Si");
        assert_eq!(result.outputs["calculation_type"], "relax");
    }

    #[tokio::test]
    async fn test_deterministic_energy() {
        let tmp1 = TempDir::new().unwrap();
        let tmp2 = TempDir::new().unwrap();
        let tool = VaspTool::new_dry_run("vasp");

        let inputs = json!({"structure": "Pt(111)", "calculation_type": "relax"});

        let r1 = tool
            .execute(test_ctx(tmp1.path().to_str().unwrap()), inputs.clone())
            .await
            .unwrap();
        let r2 = tool
            .execute(test_ctx(tmp2.path().to_str().unwrap()), inputs)
            .await
            .unwrap();

        // Same structure + calc type = same energy
        assert_eq!(r1.outputs["energy"], r2.outputs["energy"]);
    }

    #[tokio::test]
    async fn test_incar_content_varies_by_calc_type() {
        let tmp = TempDir::new().unwrap();
        let tool = VaspTool::new_dry_run("vasp");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        tool.execute(
            ctx,
            json!({"structure": "Si", "calculation_type": "freq"}),
        )
        .await
        .unwrap();

        let incar = std::fs::read_to_string(tmp.path().join("INCAR")).unwrap();
        assert!(incar.contains("IBRION = 5")); // freq mode
        assert!(incar.contains("NSW = 1"));
    }

    #[tokio::test]
    async fn test_outcar_contains_energy() {
        let tmp = TempDir::new().unwrap();
        let tool = VaspTool::new_dry_run("vasp");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        let result = tool
            .execute(ctx, json!({"structure": "Fe", "calculation_type": "relax"}))
            .await
            .unwrap();

        let outcar = std::fs::read_to_string(tmp.path().join("OUTCAR")).unwrap();
        let energy_str = format!("{:.8}", result.outputs["energy"].as_f64().unwrap());
        assert!(outcar.contains(&energy_str));
        assert!(outcar.contains("reached required accuracy"));
    }

    #[tokio::test]
    async fn test_default_parameters() {
        let tmp = TempDir::new().unwrap();
        let tool = VaspTool::new_dry_run("vasp");
        let ctx = test_ctx(tmp.path().to_str().unwrap());

        // Minimal input — uses defaults
        let result = tool.execute(ctx, json!({})).await.unwrap();
        assert!(result.outputs["energy"].as_f64().is_some());
        assert_eq!(result.outputs["calculation_type"], "relax");

        let incar = std::fs::read_to_string(tmp.path().join("INCAR")).unwrap();
        assert!(incar.contains("ENCUT = 520.0")); // default
    }
}

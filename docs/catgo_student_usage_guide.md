# CatGo Workflow Usage Guide

Last updated: 2026-03-13

## Quick Start

### 1. Start the backend

```bash
pnpm desktop:serve
# Starts frontend (port 3100) + Python backend (port 8000)
```

### 2. Connect to HPC (if running VASP/CP2K/etc.)

In the CatGo UI: **HPC Panel → Connect** → enter host, username, auth method.

You must have an active HPC connection before running HPC workflows.

### 3. Create and run a workflow

Use the **Workflow Editor** to build a graph, or use CatBot:

```
CatBot: "Create a VASP relaxation workflow for my current structure"
```

Click **Run** → configure execution settings → submit.

## Which Path Does My Workflow Use?

### Rust-native path (fast, no HPC needed)

Your workflow uses the Rust engine if it contains ONLY these node types:

- Structure operations: structure_input, slab_gen, supercell_gen, defect_gen, etc.
- Analysis: dos_analysis, cohp_analysis, convergence_check, etc.
- ORCA calculations: orca_opt, orca_sp, orca_freq, etc.
- Control flow: condition, loop, merge

**No HPC connection required.** Runs locally on your machine.

### Python-backed HPC path (requires SSH connection)

Your workflow uses the Python HPC path if it contains ANY of these:

- VASP: vasp_relax, vasp_static, vasp_md, bulk_opt, slab_relax, frequency, electronic
- CP2K: cp2k_geopt, cp2k_static, cp2k_cellopt, cp2k_md, cp2k_freq
- xTB: xtb_relax, xtb_static
- Sella: sella_ts
- Unified nodes (geo_opt, single_point, etc.) with software set to vasp/cp2k/xtb

**Requirements:**
- Active HPC SSH connection
- `default_session_id` set in run config
- Job script template configured (or use built-in presets)
- POTCAR path configured (for VASP)

### How to tell which path was used

Check the workflow detail page. The `engine_type` field shows:
- `rust` — Rust-native path
- `python` — Python HPC adapter path

## Common Errors and What They Mean

### "catgo_run binary not found"

**Cause:** You tried to run a local/ORCA workflow, but the Rust engine binary isn't built.

**Fix:**
```bash
cd crates/catgo-graph && cargo build --features cli
```
Or set `CATGO_RUN_PATH` to point to the binary.

### "HPC session 'xxx' is not connected"

**Cause:** Your workflow contains VASP/CP2K nodes, but no HPC connection is active.

**Fix:** Go to HPC Panel → Connect to your cluster first, then retry.

### "No HPC session configured for node"

**Cause:** The run config doesn't specify which HPC connection to use.

**Fix:** In the Run dialog, set `default_session_id` to your active HPC session ID.

### "HPC node 'vasp_relax' requires the Python workflow engine"

**Cause:** A VASP node somehow reached the Rust tool_bridge. This is a routing bug.

**Fix:** This should not happen in normal usage. Report it as a bug.

### "Gaussian input generation is not yet implemented"

**Cause:** Gaussian workflows are defined in the UI but the input generator hasn't been written yet.

**Fix:** Use ORCA or VASP instead for now.

### "Job submission failed"

**Cause:** The HPC scheduler rejected your job. Common reasons:
- Invalid partition name
- Account/allocation not configured
- Walltime exceeds limit

**Fix:** Check the error message, adjust job parameters in the Run dialog.

### "HPC job xxx failed with status: FAILED"

**Cause:** Your calculation crashed on the cluster.

**Fix:** SSH to the cluster and check `work_dir` for error files (OUTCAR, stderr, etc.).

## Run Configuration Reference

| Field | Required for | Default | Description |
|---|---|---|---|
| execution_mode | all | "hpc" | "local" or "hpc" |
| default_session_id | HPC workflows | "" | HPC connection session ID |
| base_work_dir | HPC workflows | "~/calculations" | Remote base directory |
| poll_interval | HPC workflows | 15 | Seconds between job status checks |
| use_custodian | VASP | true | Enable VASP error auto-recovery |
| job_script_template | HPC workflows | generic_slurm | Job submission script template |

## Job Script Presets

Built-in presets available in the Run dialog:

| Preset | Scheduler | Use case |
|---|---|---|
| generic_slurm | SLURM | Most HPC clusters |
| generic_pbs | PBS/Torque | PBS-based clusters |
| shaheen3 | SLURM | KAUST Shaheen-III |
| lammps_slurm | SLURM | LAMMPS calculations |
| orca_slurm | SLURM | ORCA with local scratch |
| orca_local | None | ORCA on local machine |

## Workflow Examples

### Example 1: VASP Relaxation (HPC)

```
structure_input → vasp_relax → vasp_static
```

- Path: Python HPC adapters
- Requires: HPC connection, POTCAR configured
- Artifacts: INCAR, POSCAR, KPOINTS, POTCAR, CONTCAR, OUTCAR

### Example 2: ORCA Optimization (local)

```
structure_input → orca_opt → orca_freq
```

- Path: Rust-native
- Requires: ORCA installed locally
- Artifacts: ORCA input/output files

### Example 3: Surface Screening (mixed)

```
structure_input → slab_gen → vasp_relax → vasp_static → dos_analysis
```

- Path: Python HPC adapters (because vasp_relax is present)
- Local nodes (slab_gen, dos_analysis) execute through the same handlers
- Requires: HPC connection

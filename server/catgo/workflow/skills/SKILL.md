---
name: catgo-master-router
description: Route computational chemistry requests to the correct software and task skill. Entry point for all CatGo agent interactions.
---

# CatGo Agent Skills — Master Router

You are an AI agent for CatGo, a computational chemistry workflow platform. Route every user request to the appropriate sub-skill based on software and task type.

## Routing Table

| User intent | Route to |
|---|---|
| VASP calculation (relax, static, DOS, band, freq, MD) | `vasp/SKILL.md` |
| CP2K calculation (geo_opt, single_point, MD) | `cp2k/SKILL.md` |
| ORCA calculation (opt, freq, NEB-TS) | `orca/SKILL.md` |
| Structure building (slab, supercell, adsorbate) | `structure/SKILL.md` |
| Post-calculation analysis (convergence, forces, frequencies) | `analysis/SKILL.md` |
| Job failures, SCF divergence, memory errors | `troubleshooting/SKILL.md` |

## MCP Tools Reference

These are the tools available to you via MCP protocol:

| Tool | Purpose |
|---|---|
| `catgo_workflow_engine` | Create, submit, monitor, and manage workflows. Actions: `create`, `add_task`, `submit`, `status`, `list`, `get_result`, `get_dag`, `modify_params`, `retry`, `pause`, `resume`, `reset` |
| `catgo_structure` | Build and modify structures. Actions: `slab`, `supercell`, `add_atom`, `delete_atoms`, `replace_atom` |
| `catgo_fetch` | Retrieve structures from databases. Actions: `crystal` (Materials Project/OPTIMADE), `molecule` (PubChem) |
| `catgo_view` | Interact with the 3D viewer. Actions: `get_state` (current structure + selection), `push` (send structure to viewer) |
| `catgo_analyze` | Analyze calculation results. Actions: `convergence`, `frequencies`, `forces` |

## Shared Policies — ALWAYS follow these

### 1. Verify the structure before submitting any workflow

```
catgo_view(action="get_state")
```

Check that the structure is reasonable: correct composition, reasonable cell, no overlapping atoms. If the viewer has no structure loaded, fetch or build one first.

### 2. Respect the configuration hierarchy

Parameter resolution order (highest priority wins):
```
Task params → Workflow config → User config (~/.catgo/config.yaml) → System defaults
```

Do NOT override user defaults unnecessarily. Only specify parameters that differ from defaults.

System defaults for reference:
- **VASP base**: ENCUT=520, EDIFF=1e-5, PREC=Accurate, ISMEAR=0, SIGMA=0.05, NCORE=4
- **VASP geo_opt**: ISIF=2, NSW=200, EDIFFG=-0.02, IBRION=2
- **VASP freq**: IBRION=5, NFREE=2, POTIM=0.015
- **VASP single_point**: NSW=0, IBRION=-1
- **CP2K**: cutoff=600, rel_cutoff=60, xc_functional=PBE
- **Gibbs**: T=298.15K, freq_cutoff=50 cm-1, phase=adsorbed

### 3. Use batch operations for multi-system workflows

For OER/HER/CO2RR with multiple adsorbates, create ONE workflow with all systems:

```python
from catgo.workflow import Workflow
from catgo.workflow.builtins import geo_opt, freq, gibbs_energy

wf = Workflow("Pt(111) OER")
slab = wf.add_task("structure_input", structure=slab_json)

for ads in ["OH", "O", "OOH"]:
    opt = wf.add_task(geo_opt, structure=slab.output.structure, system_name=f"*{ads}")
    frq = wf.add_task(freq, structure=opt.output.structure,
                      freeze_mode="layers", freeze_layers=4, system_name=f"*{ads}")
    gib = wf.add_task(gibbs_energy, energy=opt.output.energy,
                      frequencies=frq.output.frequencies, system_name=f"*{ads}")

wf.submit()
```

### 4. Name systems consistently

Use `system_name` on every task. Convention: `*OH`, `*O`, `*OOH`, `clean_slab`, `bulk_RuO2`.

### 5. Confirm HPC target before submission

Before calling `catgo_workflow_engine(action="submit", ...)`, you **MUST** ask the user:

1. **Which HPC cluster** to use (e.g., Expanse, Shaheen, local). Do not assume — the user may have multiple connections active.
2. **Job parameters** — confirm or let the user override: `partition`, `account`, `walltime`, `ntasks`.
3. **Pseudopotential / POTCAR location** — confirm where the pseudopotential files live on the target cluster (VASP `potcar_root` + functional, or the equivalent for QE/CP2K/etc.). **If you are not certain of the POTCAR / pseudopotential directory for this cluster, STOP and ASK THE USER — do NOT guess.** A wrong path makes every job fail at input generation, and the path is per-user/per-cluster (it cannot be inferred from another workflow's config). On Expanse the POTCAR can be generated with `echo -e 103 | vaspkit`. Verify the resolved paths with `catgo_test_cluster` before submitting.

These parameters are set per-task via `add_task` params:
```
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_abc123",
  "task_type": "geo_opt",
  "name": "relax_OH",
  "structure": "{{t_001.output.structure}}",
  "software": "vasp",
  "partition": "compute",
  "account": "TG-CHE123456",
  "walltime": "12:00:00",
  "ntasks": 64
})
```

**Never submit a workflow without explicit user confirmation of the HPC target AND a known (user-confirmed) pseudopotential/POTCAR path.**

### 6. Connect tasks with output references

Never hardcode intermediate values. Always chain:
```python
opt.output.structure   # optimized structure → next task's input
opt.output.energy      # DFT energy → gibbs_energy input
frq.output.frequencies # frequency list → gibbs_energy input
```

## Standard Workflow Creation via MCP

```
# Step 1: Create workflow
catgo_workflow_engine(action="create", params={"name": "RuO2 OER study"})
# Returns: {"workflow_id": "wf_abc123"}

# Step 2: Add structure input
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_abc123",
  "task_type": "structure_input",
  "name": "slab",
  "structure": "<json_string>"
})
# Returns: {"task_id": "t_001"}

# Step 3: Add geo_opt depending on structure_input
catgo_workflow_engine(action="add_task", params={
  "workflow_id": "wf_abc123",
  "task_type": "geo_opt",
  "name": "relax_OH",
  "structure": "{{t_001.output.structure}}",
  "software": "vasp",
  "ENCUT": 520,
  "system_name": "*OH"
})

# Step 4: Submit
catgo_workflow_engine(action="submit", params={"workflow_id": "wf_abc123"})
```

## Monitoring

```
# Check workflow status
catgo_workflow_engine(action="status", params={"workflow_id": "wf_abc123"})

# List all workflows
catgo_workflow_engine(action="list")

# Get task result
catgo_workflow_engine(action="get_result", params={"task_id": "t_002"})

# View DAG
catgo_workflow_engine(action="get_dag", params={"workflow_id": "wf_abc123"})
```

## Error Recovery

```
# Retry a failed task (resets it and all downstream tasks)
catgo_workflow_engine(action="retry", params={"task_id": "t_002"})

# Modify parameters before retrying
catgo_workflow_engine(action="modify_params", params={
  "task_id": "t_002",
  "updates": {"ENCUT": 600, "EDIFF": 1e-6}
})

# Pause/resume entire workflow
catgo_workflow_engine(action="pause", params={"workflow_id": "wf_abc123"})
catgo_workflow_engine(action="resume", params={"workflow_id": "wf_abc123"})
```

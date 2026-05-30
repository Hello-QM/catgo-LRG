---
name: cluster_config_test
description: Validate an HPC/cluster configuration against the live cluster BEFORE submitting a VASP workflow, or diagnose why a remote job produced no output. Reads the user's submit script / run config, then calls the validate_hpc_config tool to probe the real cluster over SSH (POTCAR directories, per-element pseudopotentials, and VASP binary resolution under the real module-load + conda environment). Use whenever the user asks to "test my cluster config", "check if VASP will run", "verify my HPC setup", or after a job silently failed for environment/path reasons.
---

# Cluster Config Test

Provider-agnostic: works for any in-app AI (DeepSeek, Qwen, Kimi, Gemini, Anthropic,
Codex, …). You validate the cluster by calling the `validate_hpc_config` tool — you do
NOT run raw SSH yourself.

## When to Use

- The user wants to confirm their cluster settings work before running a workflow.
- A submitted VASP job "completed" but produced no real output, or POTCAR was missing.
- The user pasted a submit script and asks whether it will run on their cluster.

## Why this matters (the failure it catches)

CatGo builds the POTCAR on the remote host by concatenating
`<potcar_root>/<functional>/<variant>/POTCAR` in POSCAR element order. If the POTCAR
root is wrong/unreachable, an element pseudopotential is missing, or the VASP binary
doesn't resolve under the job's module-load/conda environment, the run fails — and a
plain SLURM job can still exit 0, so the failure is easy to miss. Validate first.

## Procedure

### 1. Gather the config

From the user's **run configuration** or their **submit script**, collect:

- `potcar_root` — directory holding the POTCAR tree, e.g. `/scratch/user/VASP/pot64`
- `potcar_functional` — e.g. `potpaw_PBE` (default), `potpaw_PBE.54`, `potpaw_LDA`
- `vasp_command` — the run line, e.g. `srun --hint=nomultithread vasp_std`
- `module_loads` — every `module load`/`module switch` line (newline-separated)
- `python_env` — the `source …/conda.sh` + `conda activate …` lines

If the user only pasted a submit script, parse these out of it. If something is missing,
ask the user for it (do not guess paths).

### 2. Call the tool

```json
validate_hpc_config({
  "potcar_root": "/scratch/user/VASP/pot64",
  "potcar_functional": "potpaw_PBE",
  "vasp_command": "srun --hint=nomultithread vasp_std",
  "module_loads": "module load vasp/6.4.2",
  "python_env": "source /scratch/user/miniconda3/etc/profile.d/conda.sh\nconda activate catgo"
})
```

The active HPC session and the element list (from the loaded structure) are filled in
automatically — only pass `elements`/`session_id` to override. The tool returns
`{ success, checks: [{ name, ok, severity, detail }], message }`.

### 3. Interpret and report

- `severity: "error"` + `ok: false` → **will break the run**. Report the exact problem
  and fix (wrong POTCAR root, missing element pseudopotential, etc.).
- `severity: "warn"` (e.g. the VASP binary not resolving) → advisory: the binary may
  live only on compute nodes, or the module-load line is wrong. Tell the user which.
- `success: true` → cluster is ready; offer to run the workflow.

Map results to the common causes:

| Check fails | Likely cause / fix |
|---|---|
| POTCAR root directory | wrong/unreachable path; fix `potcar_root`, check it exists on this host |
| Functional directory | wrong functional name; pick the one that exists (e.g. `potpaw_PBE.54`) |
| Element POTCARs (missing X) | that element's pseudopotential dir is absent under the functional |
| VASP binary (warn) | wrong/absent `module load`, or binary only on compute nodes |

### 4. Re-test after fixes

After the user updates a path or module line, call `validate_hpc_config` again. Iterate
until `success: true`, then proceed to submit.

## Notes

- Read-only: the tool only probes; it never writes or submits.
- If there is no connected cluster, the tool errors — tell the user to connect a cluster
  in the HPC panel first.
- This is the deeper counterpart to the "Test configuration" button in the Run dialog:
  the button checks fixed fields; here you read the user's actual submit script.

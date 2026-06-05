---
name: hpc_job_config_test
description: Validate a CatGo HPC job configuration by READING the user's submit script and probing the LIVE cluster over SSH — checks pseudopotential/POTCAR directories, module loads, conda/env activation, the run binary resolved under the real script environment, scheduler account/partition, and scratch write access. Use when the user wants to confirm cluster settings actually work before submitting a workflow, when a remote job failed for environment/path reasons, or when the deterministic "Test configuration" preflight button is not enough and the submit script needs to be interpreted.
---

# Test HPC Job Configuration

## When to Use

Use this skill when the user asks to "test my cluster config", "check if VASP/CP2K
will run", "why did my job produce no output", "validate the submit script", or
after a remote job silently failed (e.g. missing POTCAR, binary not found, wrong
account). This is the **script-reading, AI-driven** counterpart to the deterministic
`/hpc/preflight/vasp` button in the Run dialog: that button checks fixed fields; this
skill reads the user's *actual* submit script and validates everything it implies.

Engines covered: VASP, CP2K, ORCA, Quantum ESPRESSO (extend per script).

## Prerequisites (the "configure the AI first" part)

1. A live HPC SSH session must exist (the user connected the cluster in CatGo, or you
   have working `ssh <alias>` access). You will run commands through that connection.
2. You have permission to run **read-only** probe commands on the login node. Ask
   before anything that writes, submits, or consumes allocation.
3. You have the submit script and/or the cluster config (POTCAR root, functional,
   module loads, env activation, run command, account, partition, work dir). If the
   user only has a CatGo preset, read it from `~/.catgoat/presets/<name>.yaml`.

## Core Principle: test under the SCRIPT's environment, not a bare shell

The #1 mistake is probing a bare login shell. The binary, libraries, and paths only
resolve after the script's prelude (`module load …`, `source …/conda.sh; conda
activate …`, `export VASP_HOME=…`). **Always reconstruct the prelude from the script
and source it before any check.** A binary that "isn't found" on the bare login shell
is usually fine once modules are loaded.

```sh
# WRONG — bare login shell, false negative
command -v vasp_std

# RIGHT — same environment the job will run in
module load vasp/6.4.2
source /scratch/$USER/miniconda3/etc/profile.d/conda.sh; conda activate catgo
command -v vasp_std
```

## Procedure

### 1. Parse the submit script

Extract, quoting the lines you found:
- **Scheduler directives**: `#SBATCH --account`, `--partition`, `--nodes`, `--ntasks`,
  `--time`, `--mem`, `--qos`.
- **Environment prelude**: every `module load/switch`, `source`, `conda activate`,
  `export` line, in order.
- **Run command + binary**: the launcher (`srun`/`mpirun`/`ibrun`/`jsrun`) and the
  actual executable (e.g. `vasp_std`, `cp2k.psmp`, full path).
- **Engine inputs / pseudopotentials**: POTCAR root + functional (VASP), `cp2k_data_dir`
  (CP2K basis/potential), `orca_dir` (ORCA), UPF dir (QE).
- **Work/scratch dir** and any `cd` target.

### 2. Run read-only probes through the live session

Build one prelude string `P = "<module loads>\n<source/conda>\n<exports>"` and prefix it.
Run each check with `check=False` and read exit status / stdout.

| Check | Command (prefixed by prelude P) |
|---|---|
| Binary resolves | `command -v <binary>` |
| Shared libs OK | `ldd "$(command -v <binary>)" \| grep -i 'not found'` (expect empty) |
| Module exists | `module avail <name> 2>&1 \| grep -i <name>` (or `module load <name>` exit 0) |
| Conda env exists | `conda env list \| grep -w <env>` |
| POTCAR root (VASP) | `test -d <root>/<functional>` |
| Element POTCARs (VASP) | for each element→variant: `test -f <root>/<functional>/<variant>/POTCAR` |
| CP2K data dir | `test -f <cp2k_data_dir>/BASIS_MOLOPT && test -f <cp2k_data_dir>/GTH_POTENTIALS` |
| ORCA dir | `test -x <orca_dir>/orca` |
| QE pseudos | `ls <upf_dir>/*.UPF \| head` |
| Account valid | `sacctmgr -nP show assoc user=$USER format=Account \| grep -w <account>` |
| Partition exists | `sinfo -h -p <partition> -o '%P'` (non-empty) |
| Scratch writable | `touch <workdir>/.catgo_probe && rm <workdir>/.catgo_probe` (ask first — this writes) |

Use the VASP element→pseudopotential mapping that CatGo uses (Materials Project
defaults: `Fe→Fe_pv, O→O, Cu→Cu_pv, Mo→Mo_pv, Li→Li_sv, …`; see
`server/catgo/workflow/engine/submitter.py:_POTCAR_VARIANTS`). Derive the element list
from the structure(s) in the workflow, in POSCAR species order.

### 3. (Optional, with explicit permission) tiny smoke job

If static checks pass but the user wants certainty, submit a **minimal** job (1 node,
shortest walltime, a trivial input or `--version`) and read its exit code + stderr.
Never submit without asking — it consumes allocation.

### 4. Interpret and report

For each check emit one line: `PASS / WARN / FAIL  <check>  — <detail>`. WARN = advisory
(e.g. binary only on compute nodes). FAIL = will break the run. Then give the **fix**:
exact path to correct, module to add, account to request, element pseudo missing.

Map findings to the known CatGo failure modes:
- **No POTCAR generated** → was the POTCAR root reachable AND does every element variant
  exist? (CatGo concatenates `<root>/<functional>/<variant>/POTCAR` in POSCAR order.)
- **Job "completed" but no real output** → binary didn't resolve under the prelude, or a
  pseudo/basis path was wrong; the calc aborted but the batch script still exited 0.
- **Account/partition rejected** → `sbatch` would fail at submit.

## Output format

```
HPC config test — <host>, engine=<vasp|cp2k|...>

PASS  POTCAR root            /scratch/u/VASP/pot64/potpaw_PBE
PASS  Element POTCARs        O, H, Ru all present
FAIL  VASP binary            vasp_std not found even after `module load vasp/6.4.2`
        → fix: the cluster module is `vasp/6.4.2-cpu`; update module loads
WARN  Scratch dir            not checked (write probe needs permission)

Verdict: NOT ready — fix the binary module before running.
```

## Safety

- Default to **read-only** probes. Confirm before any write (scratch probe) or submit.
- Never echo secrets. Don't `cat` private keys or tokens.
- If the session is shared (a `work_root` boundary is set), keep probes inside it.
- Report faithfully: a WARN you couldn't verify is a WARN, not a PASS.

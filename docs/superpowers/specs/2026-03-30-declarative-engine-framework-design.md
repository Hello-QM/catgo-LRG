# Declarative Engine Framework Design

**Date:** 2026-03-30
**Status:** Draft
**Approach:** YAML + Python hooks (Option C)

## Problem

Adding a new computational software to CatGo requires changes in 3 places:
1. `server/workflow/engines/*.py` — Python engine implementation
2. `server/workflow/node_sets.py` — node-to-engine mapping
3. `src/lib/workflow/node-defs/` — frontend node definition

This is repetitive, error-prone, and prevents end users from adding custom software. There is also no way to run arbitrary commands as a workflow step.

## Goals

1. **Generic command node** — users can define arbitrary command-based workflow steps via frontend UI or AI Chat
2. **Declarative engine templates** — developers add new software by writing a single YAML file instead of touching 3 codebases
3. **Auto-derived frontend** — parameter panels generated from YAML metadata, no manual frontend code
4. **Preserve existing** — current engines and the shared collector continue to work, migration is gradual

## Design

### 1. YAML Engine Schema

Each engine is a YAML file in `server/workflow/engine_defs/`. A single YAML file replaces the current 3-file-change process.

```yaml
# server/workflow/engine_defs/gromacs.yaml
engine: gromacs
label: GROMACS
description: "Classical MD for biomolecular systems"

# Unified calc types this engine supports
supported_calc_types: [geo_opt, md]

# Parameter definitions — frontend auto-generates UI from these
params:
  - key: ensemble
    label: "Ensemble"
    type: select
    options: ["NVT", "NPT", "NVE"]
    default: "NVT"
    show_if: { calc_type: [md] }
  - key: temperature
    label: "Temperature"
    type: float
    default: 300
    unit: "K"
    range: [0, 10000]
    show_if: { calc_type: [md] }
  - key: n_steps
    label: "Number of Steps"
    type: int
    default: 10000

# Input file generation
input_files:
  "run.mdp":
    template: "templates/gromacs/run.mdp.j2"    # Jinja2 template
  "structure.gro":
    source: structure                             # auto-converted from upstream structure
    format: gro
  "topol.top":
    source: user                                  # user provides: upload file or edit in Monaco

# Execution commands (sequential)
run_commands:
  - "gmx grompp -f run.mdp -c structure.gro -p topol.top -o run.tpr"
  - "gmx mdrun -deffnm run"

# HPC environment
environment:
  modules: ["gromacs/2023.3"]

# Output file declarations
output_files:
  structure: "run.gro"        # passed to downstream nodes
  energy: "run.edr"
  log: "run.log"
  trajectory: "run.trr"

# Result parser (optional, see Parser section)
parser: "parsers/gromacs.py"

# Python hooks for complex logic (optional)
hooks:
  pre_generate: null
  post_parse: null

# Safety classification
safety: safe    # safe | warn | dangerous
```

#### Custom Command Node = Minimal YAML

When a user creates a custom command node (via frontend UI or AI Chat), the system generates a minimal YAML:

```yaml
engine: custom_user_abc123
label: "My LAMMPS Script"
params: []
input_files:
  "in.lammps":
    source: editor          # user writes in Monaco
  "data.lmp":
    source: upstream        # from upstream node
run_commands:
  - "lmp -in in.lammps"
output_files:
  structure: "final.data"
  log: "log.lammps"
parser: null
safety: warn               # custom commands default to warn
```

### 2. Backend Runtime

#### Directory Structure

```
server/workflow/
├── engine_defs/                # YAML engine definitions
│   ├── vasp.yaml
│   ├── cp2k.yaml
│   ├── xtb.yaml
│   ├── mlp.yaml
│   ├── ...
│   └── custom/                 # user-defined engines
│       └── {user_id}_{name}.yaml
├── templates/                  # Jinja2 input file templates
│   ├── vasp/
│   ├── gromacs/
│   └── ...
├── parsers/                    # custom result parsers
│   └── gromacs.py
├── hooks/                      # Python hook functions
│   ├── vasp_hooks.py           # frozen layers, pseudo-H, POTCAR, etc.
│   └── ...
└── engine_runtime.py           # core: YAML → engine executor
```

#### engine_runtime.py

```python
class DeclarativeEngineRuntime:
    """Loads a YAML engine spec and executes it."""

    def __init__(self, yaml_path: str):
        self.spec = load_yaml(yaml_path)

    async def generate_inputs(self, hpc, work_dir, node_type, params,
                              structure_str, config, task) -> None:
        # 1. Run pre_generate hook if defined
        if hook := self.spec.get("hooks", {}).get("pre_generate"):
            params, structure_str = await call_hook(hook, params, structure_str)

        # 2. Render Jinja2 templates + handle structure conversion
        files = {}
        for filename, file_spec in self.spec["input_files"].items():
            if "template" in file_spec:
                files[filename] = render_template(
                    file_spec["template"], params=params, structure=structure_str
                )
            elif file_spec.get("source") == "structure":
                files[filename] = convert_structure(structure_str, file_spec["format"])
            # upload/editor/upstream files are pre-attached to task.files

        # 3. Upload to HPC
        for name, content in files.items():
            await hpc_write(hpc, work_dir / name, content)

        # 4. Generate sbatch script from modules + run_commands
        sbatch = build_sbatch(
            modules=self.spec.get("environment", {}).get("modules", []),
            commands=self.spec["run_commands"],
            config=config,
        )
        await hpc_write(hpc, work_dir / "run.sh", sbatch)

    async def parse_results(self, hpc, work_dir, task) -> dict:
        if parser := self.spec.get("parser"):
            return await run_parser(parser, hpc, work_dir)
        return await collect_raw_files(self.spec["output_files"], hpc, work_dir)
```

#### Registry Bridge

Declarative engines register into the **same registry** as existing engines. The submitter requires zero changes:

```python
# In engine_builtins.py
for yaml_file in glob("engine_defs/*.yaml"):
    runtime = DeclarativeEngineRuntime(yaml_file)

    @register_engine(runtime.spec["engine"])
    async def gen(hpc, work_dir, node_type, params, structure_str, config, task,
                  _rt=runtime):
        return await _rt.generate_inputs(
            hpc, work_dir, node_type, params, structure_str, config, task
        )
```

Everything downstream (submitter, WebSocket monitoring, result collection) works unchanged.

### 3. Frontend Auto-Derivation

#### Backend API

```python
# server/catgo/routers/workflow.py — new endpoints

@router.get("/engine-defs")
async def list_engine_defs():
    """Return metadata for all engines (built-in + custom)."""
    return [runtime.spec for runtime in all_declarative_engines()]

@router.get("/engine-defs/{engine_key}")
async def get_engine_def(engine_key: str):
    return get_runtime(engine_key).spec

@router.post("/engine-defs/custom")
async def create_custom_engine(spec: dict, user=Depends(get_current_user)):
    """Create a user-defined engine from a YAML spec."""
    validate_engine_spec(spec)
    spec["safety"] = assess_safety(spec)
    save_yaml(f"engine_defs/custom/{user.id}_{spec['engine']}.yaml", spec)
    register_runtime(spec)
    return {"status": "created", "engine": spec["engine"]}
```

#### Dynamic Node Generation

```typescript
// src/lib/workflow/node-defs/dynamic.ts

async function loadDynamicEngines(api_base: string): Promise<void> {
  const specs = await fetch(`${api_base}/engine-defs`).then(r => r.json());

  for (const spec of specs) {
    // Register as a software option in unified calc type dropdowns
    registerSoftwareOption(spec.engine, spec.label, spec.supported_calc_types);

    // Convert YAML params → frontend ParamDef[]
    const params = spec.params.map(p => ({
      key: p.key,
      label: p.label,
      type: p.type,
      default: p.default,
      options: p.options,
      range: p.range,
      unit: p.unit,
      show_if: p.show_if
        ? { key: "software", values: [spec.engine] }
        : undefined,
    }));

    // Merge into unified calculation nodes
    mergeParamsToUnifiedNodes(spec.engine, params);
  }
}
```

#### Custom Command UI

A "Custom Command" node in the DAG editor palette opens a creation wizard:

- **Input Files** — add files as user-provided (Monaco editor or upload) or upstream connection
- **Commands** — list of shell commands to run sequentially
- **Output Files** — declare which files to collect (and which is the output structure)
- **Parser** — optional, upload a Python script or leave empty
- **HPC Modules** — module names to load before execution
- **Safety warning** — always shown for custom commands

On submit, the frontend POSTs to `/engine-defs/custom` and the node is immediately available.

#### AI Chat Integration

CatBot creates custom engines via MCP tools:

1. User: "Help me run a GROMACS NVT simulation"
2. CatBot generates YAML spec for the engine
3. POSTs to `/engine-defs/custom` to register
4. Inserts node into DAG with parameters filled
5. Prompts user to confirm before submitting

### 4. Safety Mechanism

Three-level classification:

| Level | Trigger | Frontend Behavior |
|-------|---------|-------------------|
| `safe` | Pre-defined engines, no custom commands | Normal submit |
| `warn` | Has custom `run_commands` | Yellow warning, user confirms |
| `dangerous` | Matches dangerous patterns | Red warning, shows matched patterns, double confirm |

Detection:

```python
DANGEROUS_PATTERNS = [
    r'\brm\s+-rf\b', r'\bsudo\b', r'\bcurl\b', r'\bwget\b',
    r'\bchmod\b.*777', r'\b>\s*/dev/', r'\bdd\b\s+if=',
]

def assess_safety(spec: dict) -> str:
    commands = " ".join(spec.get("run_commands", []))
    for pattern in DANGEROUS_PATTERNS:
        if re.search(pattern, commands):
            return "dangerous"
    if spec.get("run_commands"):
        return "warn"
    return "safe"
```

### 5. Parser System

**Three-tier priority:**

1. **YAML-specified parser** — custom `parse(work_dir, hpc) -> dict` function, returns arbitrary dict
2. **Existing collector** — the current shared collector, matched by engine key. Handles all known software (VASP, CP2K, ORCA, etc.). Preserved as-is.
3. **Raw file fallback** — just collects declared `output_files`, no parsing

```python
async def resolve_parser(engine_key, spec, hpc, work_dir, task):
    # 1. Custom parser from YAML
    if parser_path := spec.get("parser"):
        return await run_parser(parser_path, hpc, work_dir)

    # 2. Existing collector (if registered for this engine key)
    if collector := get_result_collector(engine_key):
        return await collector(hpc, work_dir, task)

    # 3. Raw file collection
    return await collect_raw_files(spec.get("output_files", {}), hpc, work_dir)
```

Custom parsers return a free-form dict. The frontend renders based on what keys are present:

| Key present | Renders as |
|-------------|------------|
| `energy` | Value card |
| `steps[].energy` | Convergence plot |
| `structure` | 3D viewer |
| `trajectory` | Trajectory player |
| `frequencies` | Frequency table |
| Unknown keys | Raw JSON display |

Existing collector output format is unchanged — it already returns structured dicts that the frontend knows how to render.

### 6. Migration Strategy

| Phase | Scope | Goal |
|-------|-------|------|
| 1 | Framework + custom command node | Core runtime, API, frontend wizard. xTB/MLP as first YAML engines to validate. |
| 2 | Medium engines | ORCA, CP2K, LAMMPS migrate to YAML + hooks. |
| 3 | VASP | Most complex, heaviest hooks (frozen layers, pseudo-H, POTCAR). |
| 4 | Cleanup | Delete old Python engine files, remove legacy node-definitions.ts. |

Each phase: migrate, verify tests pass, delete old code.

## Design Principles

- **Small files** — each engine def, template, parser, hook is its own file. No monolithic modules. Split aggressively.
- **No hardcoding** — software names, param types, calc types, safety patterns, renderer mappings are all data-driven (loaded from config/YAML), never hardcoded in Python or TypeScript.
- **Convention over configuration** — file naming conventions (`engine_defs/{engine}.yaml`, `templates/{engine}/`, `parsers/{engine}.py`, `hooks/{engine}_hooks.py`) eliminate explicit registration where possible.

## Non-Goals

- **General-purpose workflow engine** — this is specifically for computational chemistry on HPC
- **Real-time streaming output** — use existing WebSocket monitoring
- **GUI template editor** — Jinja2 templates are developer-authored, not end-user-editable

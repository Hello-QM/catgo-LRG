# Implementation Prompts: atomate2 & quacc Workflow Import (Built-in)

**Date:** 2026-03-18
**Goal:** Let users import atomate2/quacc workflows into CatGo's visual editor as nodes + edges, then submit and monitor using CatGo's own HPC engine.
**Principle:** CatGo is the execution engine. atomate2/quacc only provide workflow templates and node definitions. No external workflow engines (FireWorks, Prefect, Covalent, etc.) are involved at runtime.
**Design:** This is a **built-in core feature**, not a plugin. Templates are pre-generated JSON that ships with CatGo — no atomate2/quacc installation required. Users get these workflows out of the box.

---

## Architecture Overview

```
atomate2 Flow JSON ──┐
                     ├──→ CatGo Converter ──→ WfNode[] + WfEdge[] ──→ CatGo Workflow Editor
quacc recipe AST ────┘                                                      │
                                                                            ▼
                                                                   CatGo HPC Engine
                                                                   (existing infrastructure)
```

Two built-in converter modules, each with:
1. **Node registry** — register external Maker/recipe types as CatGo node definitions
2. **Flow converter** — parse external workflow format → CatGo `{ nodes, edges }` JSON
3. **Template library** — pre-built common workflows as one-click imports

---

## Key Design Decisions

### D1: Map to existing CatGo nodes when possible
atomate2's `RelaxMaker(VASP)` ≈ CatGo's `geo_opt` node with `software: "vasp"`.
Don't create duplicate node types. The converter should recognize common Makers and map them to existing CatGo nodes with the correct parameters.

### D2: Create new nodes only for unsupported calculations
atomate2 has EOS, Phonon, GW, AMSET, Electrode, Lobster flows. quacc has Q-Chem, Psi4, MRCC, DFTB+, TorchSim. These don't exist in CatGo yet — register them as new node types.

### D3: Built-in server modules, not plugins
The converters, templates, and node registry are built-in `server/` code that ships with CatGo. The frontend auto-discovers new node types via the existing `load_plugin_nodes()` API. No external dependencies needed for template import.

### D4: Parameter mapping, not pass-through
Don't just dump atomate2/quacc parameters as an opaque JSON blob. Map them to CatGo's `param_schema` system (with UI types, groups, show_if conditions) so users get proper form controls in the editor.

---

## Implementation Status

| # | Task | Status |
|---|------|--------|
| P1 | atomate2 → CatGo node mapper | ✅ |
| P2 | atomate2 Flow → CatGo graph converter | 🔲 (in progress) |
| P3 | atomate2 template library | 🔲 (in progress) |
| P4 | quacc recipe → CatGo node mapper | ✅ |
| P5 | quacc flow → CatGo graph converter | 🔲 (in progress) |
| P6 | quacc template library | 🔲 (in progress) |
| P7 | Import UI (frontend) | 🔲 |
| P8 | New node types (QE, Q-Chem, phonon, eos, elastic) | ✅ |
| P9 | High-throughput nodes (batch_generate, map, aggregate) | 🔲 |
| P9E | Parallel execution engine (MapExecutor, branches table, WebSocket) | 🔲 |
| P10 | High-throughput frontend UX (BranchStatusPanel, ResultTablePanel) | 🔲 |
| P11 | CatBot knowledge base update (all new features) | 🔲 |

---

## Prompt P1: atomate2 → CatGo Node Mapper

```
Create the atomate2 Maker-to-CatGo node mapping system.

## Read first
1. server/workflow/node_sets.py — existing CatGo node type sets
2. src/lib/workflow/node-defs/common.ts — CatGo parameter schemas (VASP, CP2K, ORCA)
3. src/lib/workflow/node-defs/calculation/ — existing calculation node definitions
4. src/lib/workflow/workflow-types.ts — NodeDefinition and ParamDef interfaces

## What to create

### server/converters/atomate2/maker_map.py

A mapping from atomate2 Maker class names to CatGo node configurations:

```python
MAKER_TO_CATGO: dict[str, MakerMapping] = {
    # === Direct mappings (Maker → existing CatGo node) ===

    # VASP
    "RelaxMaker":           {"type": "geo_opt",      "params": {"software": "vasp"}},
    "TightRelaxMaker":      {"type": "geo_opt",      "params": {"software": "vasp", "EDIFFG": -0.01}},
    "StaticMaker":          {"type": "single_point",  "params": {"software": "vasp"}},
    "NonSCFMaker":          {"type": "single_point",  "params": {"software": "vasp"}},
    "HSERelaxMaker":        {"type": "geo_opt",      "params": {"software": "vasp", "functional": "HSE06"}},
    "HSEStaticMaker":       {"type": "single_point",  "params": {"software": "vasp", "functional": "HSE06"}},
    "MDMaker":              {"type": "md",           "params": {"software": "vasp"}},
    "DielectricMaker":      {"type": "single_point",  "params": {"software": "vasp", "LEPSILON": True}},

    # CP2K
    "cp2k.StaticMaker":     {"type": "single_point",  "params": {"software": "cp2k"}},
    "cp2k.RelaxMaker":      {"type": "geo_opt",      "params": {"software": "cp2k"}},
    "cp2k.CellOptMaker":    {"type": "cell_opt",     "params": {"software": "cp2k"}},
    "cp2k.MDMaker":         {"type": "md",           "params": {"software": "cp2k"}},

    # Forcefields (MLP)
    "ForceFieldRelaxMaker": {"type": "geo_opt",      "params": {"software": "mlp"}},
    "ForceFieldStaticMaker":{"type": "single_point",  "params": {"software": "mlp"}},
    "ForceFieldMDMaker":    {"type": "md",           "params": {"software": "mlp"}},

    # === New node types (no CatGo equivalent yet) ===
    "PhononDisplacementMaker": {"type": "atomate2_phonon_displacement", "new_node": True},
    "EosRelaxMaker":           {"type": "atomate2_eos_relax",          "new_node": True},
    "LobsterStaticMaker":      {"type": "atomate2_lobster_static",     "new_node": True},
    "ElasticRelaxMaker":       {"type": "atomate2_elastic_relax",      "new_node": True},
    "MVLGWMaker":              {"type": "atomate2_gw",                 "new_node": True},
    "AmsetMaker":              {"type": "atomate2_amset",              "new_node": True},
}
```

### Parameter extraction from Maker dataclass fields

```python
def extract_maker_params(maker_dict: dict) -> dict:
    """
    Extract VASP/CP2K/ORCA parameters from a serialized Maker.

    atomate2 stores parameters inside the `input_set_generator` field.
    Map these to CatGo param keys:

    VaspInputGenerator.user_incar_settings → ENCUT, EDIFF, NSW, ISIF, etc.
    VaspInputGenerator.user_kpoints_settings → kpoints
    Cp2kInputGenerator → functional, basis_set, cutoff, etc.
    """
```

### Mapping rules
- If Maker has `input_set_generator.user_incar_settings`, extract VASP params
- If Maker has `input_set_generator.user_kpoints_settings`, extract kpoints
- Unrecognized params go into a `custom_params` JSON field (displayed as code editor)
- `prev_dir` references between jobs → CatGo edges (handled in P2)

## Validation
- Unit test: given a serialized DoubleRelaxMaker, verify both jobs map to geo_opt nodes
- Unit test: given HSEBandStructureMaker, verify correct functional params extracted
```

---

## Prompt P2: atomate2 Flow → CatGo Graph Converter

```
Create the converter that transforms an atomate2 Flow JSON into CatGo workflow JSON.

## Read first
1. server/converters/atomate2/maker_map.py — the node mapper from P1
2. src/lib/workflow/graph-model.ts — WfNode / WfEdge structure
3. server/services/workflow_service.py — workflow serialization

## What to create

### server/converters/atomate2/converter.py

```python
from __future__ import annotations
import json
from typing import Any


def atomate2_flow_to_catgo(flow_dict: dict) -> dict:
    """
    Convert a serialized atomate2 Flow (from flow.as_dict()) to CatGo workflow format.

    Input: flow_dict from `monty.json.MontyEncoder` / `flow.as_dict()`
    Output: {"nodes": WfNode[], "edges": WfEdge[]}

    Algorithm:
    1. Recursively flatten nested Flows into a flat job list
    2. For each Job:
       a. Look up Maker class in MAKER_TO_CATGO
       b. Extract parameters from input_set_generator
       c. Create WfNode with auto-layout position
    3. For each Job's input_references:
       a. Find which job UUID the OutputReference points to
       b. Create WfEdge connecting source → target
    4. Auto-layout nodes using topological sort + grid placement
    """

    jobs = _flatten_jobs(flow_dict)
    uuid_to_node_id = {}
    nodes = []
    edges = []

    # Topological sort for layout
    sorted_jobs = _topological_sort(jobs)

    for i, job_dict in enumerate(sorted_jobs):
        job_uuid = job_dict["uuid"]
        node_id = f"n{int(time.time()*1000)}-{i}"
        uuid_to_node_id[job_uuid] = node_id

        # Map Maker to CatGo node type
        maker_class = _get_maker_class_name(job_dict)
        mapping = MAKER_TO_CATGO.get(maker_class)

        if mapping:
            node_type = mapping["type"]
            params = {**mapping.get("params", {}), **extract_maker_params(job_dict)}
        else:
            # Fallback: generic "custom_job" node
            node_type = "custom_job"
            params = {"label": job_dict.get("name", maker_class), "raw_config": json.dumps(job_dict)}

        # Grid layout: 300px horizontal spacing, stagger vertically by depth
        col, row = _get_layout_position(i, sorted_jobs, job_dict)

        nodes.append({
            "id": node_id,
            "type": node_type,
            "x": col * 300 + 100,
            "y": row * 120 + 100,
            "params": params,
        })

    # Build edges from OutputReference dependencies
    for job_dict in jobs:
        target_id = uuid_to_node_id[job_dict["uuid"]]
        for ref_uuid in _get_input_reference_uuids(job_dict):
            source_id = uuid_to_node_id.get(ref_uuid)
            if source_id:
                edges.append({
                    "id": f"e-{source_id}-{target_id}",
                    "from": source_id,
                    "to": target_id,
                    "fromH": "out-0",
                    "toH": "in-0",
                })

    return {"nodes": nodes, "edges": edges}


def _flatten_jobs(flow_dict: dict) -> list[dict]:
    """Recursively extract all Jobs from nested Flow structure."""

def _get_maker_class_name(job_dict: dict) -> str:
    """Extract Maker class name from serialized Job function reference."""

def _get_input_reference_uuids(job_dict: dict) -> set[str]:
    """
    Scan job's function_args and function_kwargs for OutputReference objects.
    OutputReference is serialized as:
    {"@module": "jobflow.core.reference", "@class": "OutputReference", "uuid": "..."}
    """

def _topological_sort(jobs: list[dict]) -> list[dict]:
    """Sort jobs by dependency order for layout."""

def _get_layout_position(index: int, sorted_jobs: list, job: dict) -> tuple[int, int]:
    """Calculate grid position based on DAG depth and parallelism."""
```

### server/routers/atomate2.py — API endpoint

```python
from fastapi import APIRouter, UploadFile, File
from server.plugins.atomate2.converter import atomate2_flow_to_catgo

router = APIRouter(prefix="/atomate2", tags=["atomate2"])

@router.post("/import-flow")
async def import_flow(file: UploadFile = File(...)):
    """
    Import an atomate2 Flow from JSON file.
    Accepts: flow.as_dict() JSON output.
    Returns: CatGo workflow graph JSON ready for the editor.
    """
    content = await file.read()
    flow_dict = json.loads(content)
    catgo_graph = atomate2_flow_to_catgo(flow_dict)
    return catgo_graph

@router.post("/import-flow-from-python")
async def import_flow_from_python(body: dict):
    """
    Import by executing a Python snippet that creates a Flow.
    The snippet must define a variable `flow` of type jobflow.Flow.

    Example input:
    {
      "code": "from atomate2.vasp.flows.core import DoubleRelaxMaker\nflow = DoubleRelaxMaker().make(structure)"
    }

    Security: runs in a sandboxed subprocess with no network access.
    """
```

## Important
- OutputReference objects are nested in function_args/function_kwargs —
  must recursively scan dicts and lists for {"@class": "OutputReference"}
- Nested Flows (Flow containing Flows) must be flattened while preserving edges
- Jobs with `Response.detour` or `Response.replace` create dynamic sub-graphs —
  these cannot be statically converted. Mark them as "dynamic" nodes with a warning.

## Validation
- Test with DoubleRelaxMaker → should produce 2 geo_opt nodes + 1 edge
- Test with BandStructureMaker → should produce static + nscf nodes + edge
- Test with PhononMaker → should produce multiple displacement nodes
- Test with nested Flow(Flow([...]), Flow([...])) → should flatten correctly
```

---

## Prompt P3: atomate2 Template Library

```
Create pre-built atomate2 workflow templates that users can one-click import.

## Read first
1. server/converters/atomate2/converter.py — the converter from P2
2. src/lib/workflow/workflow-types.ts — WorkflowTemplate interface

## What to create

### server/converters/atomate2/templates.py

Pre-generate CatGo graph JSON for the most common atomate2 flows.
These are static JSON — no runtime atomate2 dependency needed.

Templates to create:

### VASP Templates
1. **Double Relaxation** (DoubleRelaxMaker)
   - relax (coarse) → relax (tight)
   - Params: ENCUT, EDIFF, ISIF, kpoints for each step

2. **Band Structure** (BandStructureMaker)
   - static → uniform BS → line-mode BS
   - Params: functional, ENCUT, kpoints density

3. **HSE Band Structure** (HSEBandStructureMaker)
   - PBE static → HSE static → HSE uniform → HSE line-mode

4. **Elastic Constants** (ElasticMaker)
   - relax → 6 deformation statics (parallel)
   - Shows parallel fan-out pattern

5. **Phonon** (PhononMaker)
   - relax → supercell generation → N displacement statics → phonopy post-processing
   - Dynamic fan-out — show as "phonon_displacements" grouped node

6. **EOS (Equation of State)** (EosMaker)
   - relax → 7 volume-scaled statics (parallel) → EOS fit

7. **Dielectric + Piezoelectric**
   - relax → dielectric static → polarization

8. **Optics** (OpticsMaker)
   - relax → static → optics (LOPTICS=True)

### MLP/Forcefield Templates
9. **MLP Relaxation + VASP Refinement**
   - MLP relax → VASP static
   - Shows cross-engine workflow

10. **MLP Phonon**
    - MLP relax → displacement statics (MLP) → phonopy

### Format
```python
ATOMATE2_TEMPLATES = [
    {
        "id": "atomate2-double-relax",
        "name": "Double Relaxation (atomate2)",
        "description": "Two-stage VASP relaxation: coarse → tight. Standard atomate2 DoubleRelaxMaker pattern.",
        "category": "atomate2",
        "tags": ["vasp", "relaxation", "atomate2"],
        "graph_json": json.dumps({
            "nodes": [
                {"id": "n1", "type": "structure_input", "x": 100, "y": 200, "params": {}},
                {"id": "n2", "type": "geo_opt", "x": 400, "y": 200, "params": {
                    "software": "vasp", "ENCUT": 520, "EDIFF": "1e-5", "EDIFFG": -0.05,
                    "ISIF": 3, "NSW": 200, "label": "Relax 1 (coarse)"
                }},
                {"id": "n3", "type": "geo_opt", "x": 700, "y": 200, "params": {
                    "software": "vasp", "ENCUT": 520, "EDIFF": "1e-6", "EDIFFG": -0.02,
                    "ISIF": 3, "NSW": 200, "label": "Relax 2 (tight)"
                }},
            ],
            "edges": [
                {"id": "e1", "from": "n1", "to": "n2", "fromH": "out-0", "toH": "in-0"},
                {"id": "e2", "from": "n2", "to": "n3", "fromH": "out-0", "toH": "in-0"},
            ]
        })
    },
    # ... more templates
]
```

### server/routers/atomate2.py — add endpoint

```python
@router.get("/templates")
async def list_templates():
    return ATOMATE2_TEMPLATES

@router.get("/templates/{template_id}")
async def get_template(template_id: str):
    ...
```

## Validation
- Each template must produce valid CatGo graph JSON
- Node types must exist in NODE_DEFINITIONS
- Edge handles must be valid (in-0, out-0, etc.)
```

---

## Prompt P4: quacc Recipe → CatGo Node Mapper

```
Create the quacc recipe-to-CatGo node mapping system.

## Read first
1. server/converters/atomate2/maker_map.py — reference for the mapping pattern
2. src/lib/workflow/node-defs/common.ts — CatGo parameter schemas

## What to create

### server/converters/quacc/recipe_map.py

Map quacc recipe functions to CatGo node types.

```python
RECIPE_TO_CATGO: dict[str, RecipeMapping] = {
    # === Direct mappings ===

    # VASP
    "quacc.recipes.vasp.core.static_job":      {"type": "single_point", "params": {"software": "vasp"}},
    "quacc.recipes.vasp.core.relax_job":        {"type": "geo_opt",     "params": {"software": "vasp"}},
    "quacc.recipes.vasp.slabs.slab_static_job": {"type": "single_point", "params": {"software": "vasp"}},
    "quacc.recipes.vasp.slabs.slab_relax_job":  {"type": "geo_opt",     "params": {"software": "vasp"}},

    # ORCA
    "quacc.recipes.orca.core.static_job":       {"type": "single_point", "params": {"software": "orca"}},
    "quacc.recipes.orca.core.relax_job":        {"type": "geo_opt",     "params": {"software": "orca"}},

    # Gaussian
    "quacc.recipes.gaussian.core.static_job":   {"type": "single_point", "params": {"software": "gaussian"}},
    "quacc.recipes.gaussian.core.relax_job":    {"type": "geo_opt",     "params": {"software": "gaussian"}},

    # xTB / TBLite
    "quacc.recipes.tblite.core.static_job":     {"type": "single_point", "params": {"software": "xtb"}},
    "quacc.recipes.tblite.core.relax_job":      {"type": "geo_opt",     "params": {"software": "xtb"}},

    # MLP
    "quacc.recipes.mlp.core.static_job":        {"type": "single_point", "params": {"software": "mlp"}},
    "quacc.recipes.mlp.core.relax_job":         {"type": "geo_opt",     "params": {"software": "mlp"}},

    # === New node types ===
    "quacc.recipes.qchem.core.static_job":      {"type": "quacc_qchem_static",  "new_node": True},
    "quacc.recipes.qchem.core.relax_job":       {"type": "quacc_qchem_relax",   "new_node": True},
    "quacc.recipes.qchem.ts.ts_job":            {"type": "quacc_qchem_ts",      "new_node": True},
    "quacc.recipes.psi4.core.static_job":       {"type": "quacc_psi4_static",   "new_node": True},
    "quacc.recipes.dftb.core.static_job":       {"type": "quacc_dftb_static",   "new_node": True},
    "quacc.recipes.dftb.core.relax_job":        {"type": "quacc_dftb_relax",    "new_node": True},
    "quacc.recipes.espresso.core.static_job":   {"type": "quacc_qe_static",     "new_node": True},
    "quacc.recipes.espresso.core.relax_job":    {"type": "quacc_qe_relax",      "new_node": True},
    "quacc.recipes.espresso.dos.dos_job":       {"type": "quacc_qe_dos",        "new_node": True},
    "quacc.recipes.espresso.bands.bands_job":   {"type": "quacc_qe_bands",      "new_node": True},
    "quacc.recipes.espresso.phonons.phonon_job":{"type": "quacc_qe_phonon",     "new_node": True},
}
```

### Parameter extraction from recipe function signatures

```python
import inspect

def extract_recipe_params(recipe_func) -> list[ParamDef]:
    """
    Introspect a quacc recipe function to extract parameters.

    quacc recipes follow the signature:
        def relax_job(atoms, opt_params=None, relax_cell=False, **kwargs)

    Map known params:
    - relax_cell → CatGo ISIF param
    - opt_params.fmax → CatGo EDIFFG equivalent
    - opt_params.optimizer → optimizer selection
    - **kwargs → code-specific calculator params
    """
```

## Key difference from atomate2
quacc recipes are functions, not classes. Parameters come from:
1. Function signature (inspect.signature)
2. Calculator kwargs (code-specific, passed as **kwargs)
3. opt_params dict (optimizer settings)

The mapping needs to document which kwargs map to which CatGo params
for each DFT code.

## Validation
- Verify all VASP recipes map to existing CatGo nodes
- Verify parameter extraction for relax_job (fmax, relax_cell, etc.)
```

---

## Prompt P5: quacc Flow → CatGo Graph Converter

```
Create the converter for quacc @flow-decorated functions.

## Read first
1. server/converters/quacc/recipe_map.py — recipe mapper from P4
2. server/converters/atomate2/converter.py — reference converter pattern

## What to create

### server/converters/quacc/converter.py

quacc flows are harder to parse than atomate2 because the DAG is implicit
in Python function composition. Two approaches:

### Approach A: AST-based static analysis (preferred for known flows)

```python
import ast

def parse_quacc_flow_source(source_code: str) -> dict:
    """
    Parse a @flow function's source code to extract the DAG.

    Example input:
    ```python
    @flow
    def band_structure_flow(atoms):
        result1 = static_job(atoms)
        result2 = non_scf_job(result1["atoms"], mode="uniform")
        result3 = non_scf_job(result1["atoms"], mode="line")
        return result3
    ```

    Algorithm:
    1. Parse AST of the function body
    2. For each assignment `result = some_job(...)`:
       a. Identify the recipe function (some_job)
       b. Track which variables are passed as arguments
       c. If an argument references a previous result, create edge
    3. Build CatGo nodes + edges from the dependency graph

    Limitations:
    - Cannot handle dynamic @subflow (fan-out based on runtime data)
    - Cannot handle conditional branches (if/else choosing different recipes)
    - These are represented as opaque "dynamic" nodes
    """
```

### Approach B: Pre-defined template conversion (for common flows)

Since quacc's built-in flows are well-known, we can hardcode their DAG
structure as templates (same approach as P6). This avoids the fragility
of AST parsing.

### Recommendation
Use Approach B (templates) for quacc's built-in flows.
Use Approach A (AST) only for user-defined @flow functions.

### server/routers/quacc.py — API endpoint

```python
@router.post("/import-flow")
async def import_quacc_flow(body: dict):
    """
    Import a quacc flow.

    Accepts either:
    1. {"template": "vasp-band-structure"} — use pre-built template
    2. {"source": "@flow\ndef my_flow(atoms):..."} — parse user code
    """
```

## Validation
- Test AST parser with simple 2-job linear flow
- Test AST parser with 3-job fan-out flow
- Test that @subflow produces a warning/opaque node
```

---

## Prompt P6: quacc Template Library

```
Create pre-built quacc workflow templates.

## What to create

### server/converters/quacc/templates.py

Templates for common quacc multi-step recipes:

### VASP Templates
1. **Slab Relaxation Flow**
   - bulk relax → slab generation → slab relax → slab static

2. **Band Structure Flow**
   - static → non-scf (uniform) → non-scf (line-mode)

### MLP Templates
3. **MLP Phonon**
   - MLP relax → phonon displacements (MLP) → phonopy post-process

4. **MLP Elastic**
   - MLP relax → deformation statics → elastic tensor fit

### Multi-Code Templates
5. **MLP Pre-screen + DFT Refinement**
   - MLP relax → VASP static (single-point validation)

6. **xTB Pre-opt + ORCA Refinement**
   - xTB relax → ORCA single-point

### Quantum Espresso Templates
7. **QE Band Structure**
   - scf → nscf → bands → dos

8. **QE Phonon**
   - scf → ph.x → matdyn

Same format as atomate2 templates (P3).

## Validation
- All templates produce valid CatGo graph JSON
- Node types exist in NODE_DEFINITIONS or in new node registry
```

---

## Prompt P7: Import UI (Frontend)

```
Add an "Import Workflow" feature to the workflow editor.

## Read first
1. src/lib/workflow/WorkflowEditor.svelte — current editor
2. src/lib/workflow/graph-model.ts — node/edge creation helpers

## What to create

### src/lib/workflow/components/ImportWorkflowDialog.svelte

A dialog with three tabs:

### Tab 1: Templates
- Dropdown to select source: "CatGo" | "atomate2" | "quacc"
- Grid/list of templates from the selected source
- Click template → preview DAG thumbnail
- "Import" button → loads nodes + edges into current workflow

### Tab 2: Import from JSON
- Textarea or file upload for atomate2 Flow JSON
- "Convert & Import" button
- Shows conversion warnings (unrecognized Makers, dynamic nodes, etc.)

### Tab 3: Import from Python
- Monaco editor for Python code
- User writes/pastes atomate2 or quacc flow code
- "Parse & Import" button
- Backend executes in sandbox, returns CatGo graph

### Integration
- Add "Import" button to WorkflowEditor toolbar (next to existing template buttons)
- Imported nodes are placed at current viewport position
- Existing nodes in the workflow are preserved (append, not replace)

## Validation
- Import atomate2 DoubleRelax template → 3 nodes appear in editor
- Import via JSON file → correct node mapping
- Import unrecognized Maker → warning shown, fallback node created
```

---

## Prompt P8: New Node Types for Unsupported Calculations

```
Register new CatGo node types for calculations that atomate2/quacc support
but CatGo doesn't have yet.

## Read first
1. src/lib/workflow/node-defs/calculation/ — existing calculation node files
2. src/lib/workflow/node-defs/common.ts — shared parameter builders
3. server/workflow/node_sets.py — backend node classification

## New node types to create

### Category: Calculation (extend existing)

1. **Quantum ESPRESSO nodes** (from quacc)
   - qe_scf, qe_relax, qe_dos, qe_bands, qe_phonon
   - Params: ecutwfc, ecutrho, kpoints, pseudopotentials, smearing
   - Engine: server/workflow/engines/qe.py (new)

2. **Q-Chem nodes** (from quacc)
   - qchem_static, qchem_relax, qchem_ts
   - Params: method, basis, charge, multiplicity, solvent
   - Engine: server/workflow/engines/qchem.py (new)

### Category: Analysis (extend existing)

3. **Phonon analysis node**
   - Wraps phonopy post-processing
   - Input: displacement forces from multiple statics
   - Output: phonon band structure, DOS, thermodynamics

4. **EOS analysis node**
   - Birch-Murnaghan / Vinet fit
   - Input: energy-volume data from multiple statics
   - Output: bulk modulus, equilibrium volume

5. **Elastic analysis node**
   - Input: stress-strain data from deformation statics
   - Output: elastic tensor, bulk/shear modulus

### For each new node
1. Create node-defs/calculation/<name>.ts or node-defs/analysis/<name>.ts
2. Add to category index
3. Add to server/workflow/node_sets.py
4. Create minimal engine stub (or mark as "requires external engine")

## Note
Not all new nodes need full CatGo engine support on day 1.
Nodes can be marked as "template-only" — they appear in the editor
for visualization but show a warning when the user tries to submit
without the required backend engine configured.

## Validation
- New nodes appear in workflow editor palette
- Parameter forms render correctly
- pnpm check passes
```

---

## Prompt P9: High-Throughput Screening Nodes

```
Create the core node types that enable high-throughput screening workflows
in CatGo's visual editor.

## Read first
1. src/lib/workflow/node-defs/logic/ — existing logic nodes (condition, loop, merge)
2. src/lib/workflow/node-defs/utility/ — existing tool nodes (slab_gen, doping_gen, etc.)
3. server/workflow/python_engine.py — workflow execution engine
4. server/workflow/node_dispatch.py — node dispatch logic
5. src/lib/workflow/graph-model.ts — WfNode/WfEdge structure

## What to create

### 9A: batch_generate node (frontend + backend)

A node that generates N candidate structures from a parameter space.

#### src/lib/workflow/node-defs/utility/batch-generate.ts
```typescript
{
  type: "batch_generate",
  label: "Batch Generate",
  color: "#8b5cf6",
  icon: "🔢",
  category: "Tools",
  description: "Generate multiple candidate structures from a parameter space",
  inputs: ["structure"],
  outputs: ["structures"],    // outputs a list, not a single structure
  default_params: {
    mode: "substituent",      // what to vary
    // Mode: substituent — try different elements at specified sites
    elements: "Ti, V, Cr, Mn, Fe, Co, Ni, Cu",
    sites: "all",             // or specific indices
    // Mode: surface — generate multiple Miller index surfaces
    miller_indices: "100, 110, 111, 211",
    slab_thickness: 4,
    vacuum: 15,
    // Mode: adsorbate — place adsorbate at all unique sites
    adsorbate: "OH",
    // Mode: lattice_scan — vary lattice parameter
    param_range: "0.95, 1.05",
    n_points: 11,
    // Mode: custom — user provides a Python generator
    custom_script: "",
  },
  param_schema: [
    {key: "mode", label: "Generation Mode", type: "select",
     options: [
       {label: "Element Substitution", value: "substituent"},
       {label: "Surface Miller Indices", value: "surface"},
       {label: "Adsorbate Sites", value: "adsorbate"},
       {label: "Lattice Parameter Scan", value: "lattice_scan"},
       {label: "Composition Scan", value: "composition"},
       {label: "Custom Python", value: "custom"},
     ]},
    {key: "elements", label: "Elements to try", type: "string",
     show_if: {key: "mode", values: ["substituent"]}},
    {key: "sites", label: "Sites to substitute", type: "string",
     show_if: {key: "mode", values: ["substituent"]},
     help: "'all' or comma-separated indices (0-based)"},
    {key: "miller_indices", label: "Miller Indices", type: "string",
     show_if: {key: "mode", values: ["surface"]}},
    {key: "slab_thickness", label: "Slab Thickness (layers)", type: "number",
     show_if: {key: "mode", values: ["surface"]}},
    {key: "vacuum", label: "Vacuum (Å)", type: "number",
     show_if: {key: "mode", values: ["surface"]}},
    {key: "adsorbate", label: "Adsorbate", type: "string",
     show_if: {key: "mode", values: ["adsorbate"]}},
    {key: "param_range", label: "Scale Range (min, max)", type: "string",
     show_if: {key: "mode", values: ["lattice_scan"]}},
    {key: "n_points", label: "Number of Points", type: "number",
     show_if: {key: "mode", values: ["lattice_scan"]}},
    {key: "custom_script", label: "Generator Script", type: "text",
     show_if: {key: "mode", values: ["custom"]},
     help: "Python function: def generate(structure) -> list[Structure]"},
  ],
}
```

#### server/workflow/engines/batch_generate.py
```python
async def execute_batch_generate(step, structure, params):
    """
    Generate N candidate structures based on mode.

    Returns: list[Structure] stored in step result.

    Modes:
    - substituent: for each element in list, replace target sites
    - surface: for each Miller index, generate slab
    - adsorbate: find all unique adsorption sites, place adsorbate
    - lattice_scan: scale lattice parameter across range
    - composition: generate all compositions in a specified range
    - custom: execute user Python script in sandbox
    """
```

### 9B: map (fan-out) node (frontend + backend)

A node that takes N structures and runs the downstream sub-workflow
on each one in parallel.

#### src/lib/workflow/node-defs/logic/map.ts
```typescript
{
  type: "map",
  label: "Map (Parallel)",
  color: "#6366f1",
  icon: "⚡",
  category: "Logic",
  description: "Run downstream workflow on each input structure in parallel",
  inputs: ["structures"],     // receives a list
  outputs: ["results"],       // outputs a list of results
  is_fan_out: true,           // new flag for the execution engine
  default_params: {
    max_parallel: 0,          // 0 = unlimited
    fail_strategy: "continue", // continue | abort_all
    retry_failed: false,
  },
  param_schema: [
    {key: "max_parallel", label: "Max Parallel Jobs", type: "number",
     help: "0 = submit all at once. Set a limit to avoid overwhelming the HPC queue."},
    {key: "fail_strategy", label: "On Failure", type: "select",
     options: [
       {label: "Continue others", value: "continue"},
       {label: "Abort all", value: "abort_all"},
     ]},
    {key: "retry_failed", label: "Auto-retry Failed", type: "boolean"},
  ],
}
```

#### Backend execution logic (server/workflow/engines/map_node.py)
```python
async def execute_map_node(step, structures: list, downstream_subgraph, config):
    """
    Fan-out execution:

    1. For each structure in the input list:
       a. Clone the downstream sub-workflow (nodes between map → aggregate)
       b. Create a new step group with a unique work_dir
       c. Submit the first node of the sub-workflow to HPC

    2. Track all parallel branches:
       - Each branch gets a branch_id
       - Status: { branch_id: "running" | "completed" | "failed" }

    3. When max_parallel > 0:
       - Use a semaphore/queue to limit concurrent submissions
       - As one branch completes, submit the next pending one

    4. When fail_strategy == "abort_all":
       - If any branch fails, cancel all running branches

    5. When all branches complete (or abort):
       - Collect results into a list
       - Pass to the aggregate node
    """
```

#### Backend changes needed
- server/workflow/python_engine.py: detect `is_fan_out` nodes and
  fork execution into parallel branches
- server/workflow/node_dispatch.py: add `map` to node routing
- The "downstream sub-workflow" is defined by the edges:
  everything between the `map` node and the `aggregate` node
  forms the per-structure sub-workflow

### 9C: aggregate (collect + filter) node (frontend + backend)

A node that collects results from all parallel branches,
creates a comparison table, and optionally filters.

#### src/lib/workflow/node-defs/logic/aggregate.ts
```typescript
{
  type: "aggregate",
  label: "Aggregate & Filter",
  color: "#6366f1",
  icon: "📊",
  category: "Logic",
  description: "Collect parallel results, compare, and filter top candidates",
  inputs: ["results"],        // receives list from map node
  outputs: ["filtered", "table"],  // filtered structures + full comparison table
  is_fan_in: true,            // new flag
  default_params: {
    sort_by: "energy_per_atom",
    sort_order: "ascending",
    filter_by: "",            // e.g. "band_gap > 1.5"
    top_n: 0,                 // 0 = keep all
    export_csv: true,
  },
  param_schema: [
    {key: "sort_by", label: "Sort By", type: "select",
     options: [
       {label: "Energy / atom", value: "energy_per_atom"},
       {label: "Total Energy", value: "total_energy"},
       {label: "Band Gap", value: "band_gap"},
       {label: "Formation Energy", value: "formation_energy"},
       {label: "Adsorption Energy", value: "adsorption_energy"},
       {label: "Force Max", value: "max_force"},
       {label: "Custom", value: "custom"},
     ]},
    {key: "sort_order", label: "Order", type: "select",
     options: [
       {label: "Ascending (lowest first)", value: "ascending"},
       {label: "Descending (highest first)", value: "descending"},
     ]},
    {key: "filter_by", label: "Filter Expression", type: "string",
     help: "Python expression, e.g. 'band_gap > 1.5 and energy_per_atom < -5.0'"},
    {key: "top_n", label: "Keep Top N", type: "number",
     help: "0 = keep all that pass filter"},
    {key: "export_csv", label: "Export CSV", type: "boolean"},
  ],
}
```

#### server/workflow/engines/aggregate_node.py
```python
async def execute_aggregate_node(step, results: list, params):
    """
    1. Collect results from all completed branches
    2. Extract comparable properties (energy, forces, band_gap, etc.)
    3. Build comparison table (pandas DataFrame or dict-of-lists)
    4. Apply filter expression (safe eval with limited namespace)
    5. Sort by specified property
    6. If top_n > 0, keep only top N
    7. Store:
       - Full table as CSV/JSON in work_dir
       - Filtered structures as output for downstream nodes
       - Summary statistics (min, max, mean, std for each property)
    """
```

### 9D: High-throughput workflow templates

Add to both atomate2 and quacc template libraries:

1. **Catalyst Screening**
   structure_input → batch_generate(mode=adsorbate) → map →
   [geo_opt → single_point] → aggregate(sort_by=adsorption_energy)

2. **Dopant Screening**
   structure_input → batch_generate(mode=substituent) → map →
   [geo_opt → single_point] → aggregate(sort_by=formation_energy)

3. **Surface Energy Screening**
   structure_input → batch_generate(mode=surface) → map →
   [geo_opt → single_point] → aggregate(sort_by=energy_per_atom)

4. **EOS / Lattice Scan**
   structure_input → batch_generate(mode=lattice_scan) → map →
   [single_point] → aggregate → eos_analysis

5. **MLP Pre-screen + DFT Validation**
   structure_input → batch_generate → map →
   [mlp_relax → mlp_static] → aggregate(top_n=10) → map →
   [vasp_static] → aggregate(sort_by=energy_per_atom)
   (two-stage: fast MLP screen, then DFT on top candidates)

## Important constraints
- The `map` node must identify its paired `aggregate` node automatically
  (by following edges forward until hitting an `aggregate` node)
- Nested map-aggregate pairs should be supported (for two-stage screening)
- The execution engine must handle branch tracking without losing state
  on server restart (persist branch status to SQLite)
- The comparison table should be viewable in CatGo's UI
  (new ResultTableView component, or reuse existing data grid)

## Validation
- batch_generate with mode=substituent on Cu produces N structures
- map → single_point → aggregate correctly fans out and collects
- filter expression "energy_per_atom < -5" correctly filters results
- pnpm check passes for all new node definitions
```

---

## Prompt P9E: Execution Engine for Parallel Fan-Out

```
Modify CatGo's workflow execution engine to support the map/aggregate
parallel fan-out pattern. Learn from Prefect's .map() + DaskTaskRunner
and Parsl's HighThroughputExecutor + join_app.

## Read first
1. server/workflow/python_engine.py — current execution engine (sequential DAG)
2. server/workflow/node_dispatch.py — node routing
3. server/utils/workflow_db.py — SQLite schema for steps/workflows
4. server/workflow/engines/ — existing engine modules (vasp, cp2k, orca)

## What to modify / create

### 1. New SQLite table: branches (server/utils/workflow_db.py)

```sql
CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,              -- branch_id = "{workflow_id}:{map_node_id}:{index}"
    workflow_id TEXT NOT NULL,
    map_node_id TEXT NOT NULL,        -- the map node that spawned this branch
    branch_index INTEGER NOT NULL,    -- 0, 1, 2, ... N-1
    label TEXT,                       -- human-readable label (e.g. "Cu-Ti substitution")
    status TEXT DEFAULT 'pending',    -- pending | queued | running | completed | failed
    structure_json TEXT,              -- input structure for this branch
    result_json TEXT,                 -- output result (energy, forces, etc.)
    error_message TEXT,
    work_dir TEXT,                    -- unique work directory for this branch
    started_at DATETIME,
    completed_at DATETIME,
    FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);
CREATE INDEX IF NOT EXISTS idx_branches_workflow ON branches(workflow_id, map_node_id);
```

### 2. Parallel execution coordinator (server/workflow/engines/map_node.py)

```python
"""
Map node execution engine.

Inspired by:
- Prefect's .map(): creates N task runs from a single task definition
- Parsl's HighThroughputExecutor: manages a pool of workers with backpressure
- Dask's delayed().compute(): lazy graph → parallel execution

Key design principles (learned from Prefect/Parsl):
1. NEVER hold all branches in memory — stream from DB
2. Use asyncio.Semaphore for max_parallel (like Parsl's max_workers)
3. Each branch is an independent unit of work that can be retried
4. State transitions are atomic DB writes (crash-safe)
5. The coordinator is re-entrant: can resume after server restart
"""
import asyncio
from dataclasses import dataclass


@dataclass
class BranchResult:
    branch_id: str
    index: int
    label: str
    status: str  # completed | failed
    result: dict | None
    error: str | None


class MapExecutor:
    """
    Manages parallel execution of N branches through a sub-workflow.

    Lifecycle:
    1. __init__: parse sub-graph, create branches in DB
    2. execute(): run all branches with concurrency control
    3. collect(): gather results for the aggregate node

    Usage:
        executor = MapExecutor(
            workflow_id=wf_id,
            map_node_id=node_id,
            structures=structures,          # list from batch_generate
            sub_graph=sub_graph,            # nodes between map→aggregate
            config=run_config,
            max_parallel=params["max_parallel"],
            fail_strategy=params["fail_strategy"],
        )
        results = await executor.execute()
    """

    def __init__(self, workflow_id, map_node_id, structures, sub_graph, config,
                 max_parallel=0, fail_strategy="continue", retry_failed=False):
        self.workflow_id = workflow_id
        self.map_node_id = map_node_id
        self.structures = structures
        self.sub_graph = sub_graph
        self.config = config
        self.fail_strategy = fail_strategy
        self.retry_failed = retry_failed

        # Semaphore for concurrency control (like Parsl's max_workers)
        # 0 = unlimited → use len(structures) as upper bound
        limit = max_parallel if max_parallel > 0 else len(structures)
        self.semaphore = asyncio.Semaphore(limit)

        # Abort flag (for fail_strategy="abort_all")
        self.abort_event = asyncio.Event()

    async def execute(self) -> list[BranchResult]:
        """
        Execute all branches with concurrency control.

        Pattern inspired by Prefect's ConcurrentTaskRunner:
        - Create all branch records in DB (status=pending)
        - Launch asyncio tasks with semaphore-gated execution
        - Each task: acquire semaphore → submit to HPC → wait for completion → release
        - If abort_event is set, all pending branches skip execution
        """
        # 1. Create branch records in DB (atomic, crash-safe)
        branches = self._create_branch_records()

        # 2. Launch all branches as asyncio tasks
        tasks = [
            asyncio.create_task(self._execute_branch(branch))
            for branch in branches
        ]

        # 3. Wait for all to complete (or abort)
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # 4. Handle exceptions
        branch_results = []
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                branch_results.append(BranchResult(
                    branch_id=branches[i]["id"],
                    index=i,
                    label=branches[i]["label"],
                    status="failed",
                    result=None,
                    error=str(result),
                ))
            else:
                branch_results.append(result)

        return branch_results

    async def _execute_branch(self, branch: dict) -> BranchResult:
        """
        Execute a single branch through the sub-workflow.

        Semaphore pattern (from Parsl's HighThroughputExecutor):
        - acquire() blocks if max_parallel branches are already running
        - As one branch completes and releases, the next pending one starts
        """
        # Check abort
        if self.abort_event.is_set():
            self._update_branch_status(branch["id"], "skipped")
            return BranchResult(branch["id"], branch["index"], branch["label"],
                                "skipped", None, "Aborted by fail_strategy")

        async with self.semaphore:
            # Check abort again (may have been set while waiting)
            if self.abort_event.is_set():
                self._update_branch_status(branch["id"], "skipped")
                return BranchResult(branch["id"], branch["index"], branch["label"],
                                    "skipped", None, "Aborted by fail_strategy")

            self._update_branch_status(branch["id"], "running")

            try:
                # Execute the sub-workflow for this branch's structure
                # Reuse existing node_dispatch for each node in the sub-graph
                result = await self._run_sub_workflow(
                    branch["structure"],
                    branch["work_dir"],
                )
                self._update_branch_status(branch["id"], "completed", result=result)
                return BranchResult(branch["id"], branch["index"], branch["label"],
                                    "completed", result, None)

            except Exception as e:
                self._update_branch_status(branch["id"], "failed", error=str(e))

                if self.fail_strategy == "abort_all":
                    self.abort_event.set()  # Signal all other branches to abort

                if self.retry_failed:
                    # Retry once (like Prefect's retries=1)
                    try:
                        result = await self._run_sub_workflow(
                            branch["structure"],
                            branch["work_dir"] + "_retry",
                        )
                        self._update_branch_status(branch["id"], "completed", result=result)
                        return BranchResult(branch["id"], branch["index"], branch["label"],
                                            "completed", result, None)
                    except Exception as e2:
                        self._update_branch_status(branch["id"], "failed", error=str(e2))

                return BranchResult(branch["id"], branch["index"], branch["label"],
                                    "failed", None, str(e))

    async def _run_sub_workflow(self, structure, work_dir):
        """
        Execute the sub-graph (nodes between map→aggregate) for one structure.

        For each node in topological order:
        1. Substitute the input structure
        2. Generate input files (VASP INCAR/KPOINTS/POSCAR, etc.)
        3. Submit to HPC via existing node_dispatch
        4. Poll for completion (using existing adaptive polling)
        5. Parse results
        6. Pass output to next node

        This reuses the existing python_engine's per-node execution logic.
        """

    def _create_branch_records(self) -> list[dict]:
        """Create branch records in SQLite (crash-safe)."""

    def _update_branch_status(self, branch_id, status, result=None, error=None):
        """Atomic status update in SQLite."""

    @classmethod
    async def resume(cls, workflow_id, map_node_id, config):
        """
        Resume execution after server restart.

        Pattern (from Prefect's Orion state recovery):
        1. Load all branches from DB for this map node
        2. Find branches with status=running (stale — server crashed)
        3. Re-check HPC job status for stale branches
        4. Re-submit or mark failed
        5. Find branches with status=pending
        6. Execute remaining branches
        """
```

### 3. Modify python_engine.py to detect fan-out nodes

```python
# In the main execution loop, add handling for map/aggregate nodes:

async def execute_node(self, node, ...):
    node_def = NODE_DEFINITIONS.get(node["type"])

    if node["type"] == "map":
        # 1. Get input structures from upstream (batch_generate output)
        structures = self.get_upstream_result(node, "structures")

        # 2. Identify sub-graph: everything between this map and its aggregate
        sub_graph = self.extract_sub_graph(node["id"])

        # 3. Create and run MapExecutor
        executor = MapExecutor(
            workflow_id=self.workflow_id,
            map_node_id=node["id"],
            structures=structures,
            sub_graph=sub_graph,
            config=self.config,
            **node["params"],
        )
        results = await executor.execute()

        # 4. Store results for the aggregate node
        self.store_result(node["id"], {"branch_results": results})

        # 5. Skip all nodes in the sub-graph (they were executed by MapExecutor)
        self.mark_sub_graph_completed(sub_graph)

    elif node["type"] == "aggregate":
        # Aggregate node receives branch_results from its paired map node
        map_node_id = self.find_paired_map_node(node["id"])
        branch_results = self.get_result(map_node_id)["branch_results"]

        result = await execute_aggregate_node(
            step=self.get_step(node["id"]),
            results=branch_results,
            params=node["params"],
        )
        self.store_result(node["id"], result)

    elif node["type"] == "batch_generate":
        # batch_generate is a local node — runs on the server, not HPC
        structure = self.get_upstream_result(node, "structure")
        structures = await execute_batch_generate(
            step=self.get_step(node["id"]),
            structure=structure,
            params=node["params"],
        )
        self.store_result(node["id"], {"structures": structures})

    else:
        # Existing dispatch logic for regular nodes
        ...
```

### 4. Sub-graph extraction (add to graph-model or python_engine)

```python
def extract_sub_graph(self, map_node_id: str) -> dict:
    """
    Find all nodes between a map node and its paired aggregate node.

    Algorithm:
    1. BFS forward from map_node_id following edges
    2. Stop at the first aggregate node encountered
    3. All nodes visited (excluding map and aggregate) form the sub-graph
    4. Return {"nodes": [...], "edges": [...]}

    For nested map-aggregate pairs:
    - If we encounter another map node during BFS, skip its entire
      sub-graph (it will be handled by its own MapExecutor)
    """
```

### 5. WebSocket progress updates for branches

```python
# In the WebSocket monitor, add branch-level status updates:

async def send_branch_status(self, ws, workflow_id, map_node_id):
    """
    Send real-time branch status updates to the frontend.

    Message format:
    {
        "type": "branch_status",
        "map_node_id": "n123",
        "branches": [
            {"index": 0, "label": "Cu-Ti", "status": "completed", "energy": -5.23},
            {"index": 1, "label": "Cu-V",  "status": "running"},
            {"index": 2, "label": "Cu-Cr", "status": "pending"},
        ],
        "progress": {"completed": 1, "running": 1, "pending": 1, "failed": 0, "total": 3}
    }
    """
```

## Validation
- Create a 3-structure batch → map → single_point → aggregate workflow
- Verify branches table has 3 entries
- Verify max_parallel=1 runs branches sequentially
- Verify fail_strategy=abort_all cancels remaining branches on failure
- Verify server restart resumes pending branches
- Verify WebSocket sends branch_status updates
```

---

## Prompt P10: High-Throughput Frontend UX

```
Create the frontend UI components for the high-throughput screening workflow.
Users MUST be able to understand and use this feature without reading docs.

## Read first
1. src/lib/workflow/WorkflowEditor.svelte — current editor
2. src/lib/workflow/graph-model.ts — node rendering
3. src/lib/workflow/workflow-execution.svelte.ts — execution state
4. src/lib/workflow/workflow-types.ts — status types

## What to create

### 10A: Map node canvas rendering (special visual treatment)

The map node on the canvas should look DIFFERENT from regular nodes
to clearly communicate "this is where parallelism happens."

#### Visual design for map node on canvas:
```
┌─────────────────────────────────┐
│ ⚡ Map (Parallel)              │
│ ─────────────────────────────── │
│ Max parallel: 10                │
│ On failure: Continue others     │
│                                 │
│  ┌─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │  ← dashed border = "sub-workflow zone"
│  │  (downstream nodes here)  │  │
│  └─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
│                                 │
│ During execution:               │
│ ████████░░░░ 8/12 branches     │  ← progress bar
│ ✅ 6  🔄 2  ⏳ 3  ❌ 1         │  ← status counts
└─────────────────────────────────┘
```

Implementation:
- In graph-model.ts, detect `is_fan_out` flag on node definition
- Render a wider node (400px instead of 260px)
- Add a dashed border zone around downstream nodes (up to aggregate)
- During execution, show inline progress bar and status counts
- Click the progress bar → opens BranchStatusPanel (10C)

### 10B: Aggregate node canvas rendering

```
┌─────────────────────────────────┐
│ 📊 Aggregate & Filter          │
│ ─────────────────────────────── │
│ Sort by: Energy / atom ↑        │
│ Filter: band_gap > 1.5          │
│ Keep top: 10                    │
│                                 │
│ After execution:                │
│ 12 → filtered → 4 candidates   │  ← summary line
│ [View Results Table]            │  ← clickable button
└─────────────────────────────────┘
```

Implementation:
- Show filter summary on the node
- After execution, show "N → filtered → M" count
- "View Results Table" button opens ResultTablePanel (10D)

### 10C: BranchStatusPanel (side panel)

When user clicks the map node's progress bar during execution,
open a side panel showing all branches:

```
┌── Branch Status ────────────────────────────────┐
│                                                  │
│  Screening: 12 structures                        │
│  Progress: ████████████░░░░░░ 8/12 (67%)        │
│                                                  │
│  ┌──────┬──────────┬────────┬──────────────────┐ │
│  │  #   │ Label    │ Status │ Energy (eV/atom) │ │
│  ├──────┼──────────┼────────┼──────────────────┤ │
│  │  1   │ Cu-Ti    │ ✅     │ -5.234           │ │
│  │  2   │ Cu-V     │ ✅     │ -5.102           │ │
│  │  3   │ Cu-Cr    │ 🔄     │ —                │ │
│  │  4   │ Cu-Mn    │ ⏳     │ —                │ │
│  │  5   │ Cu-Fe    │ ❌     │ Error: ZBRENT    │ │
│  │  ...                                         │ │
│  └──────────────────────────────────────────────┘ │
│                                                  │
│  [Retry Failed]  [Abort All]  [Export CSV]       │
│                                                  │
└──────────────────────────────────────────────────┘
```

#### src/lib/workflow/components/BranchStatusPanel.svelte

Features:
- Real-time updates via WebSocket (branch_status messages)
- Sortable table columns
- Click a row → load that branch's structure in the viewer
- Click error message → show full error log
- "Retry Failed" button → re-submit failed branches
- "Abort All" → cancel running branches + skip pending
- "Export CSV" → download current results as CSV
- Color-coded status pills (green=completed, blue=running, gray=pending, red=failed)

Props:
- workflow_id: string
- map_node_id: string
- branches: BranchInfo[]  (reactive, updated via WebSocket)

### 10D: ResultTablePanel (post-execution results view)

When user clicks "View Results Table" on the aggregate node,
show a full comparison table:

```
┌── Screening Results ────────────────────────────────────────────┐
│                                                                  │
│  12 candidates → 4 passed filter (band_gap > 1.5)              │
│                                                                  │
│  ┌───┬──────────┬────────────┬──────────┬─────────┬───────────┐ │
│  │ # │ Label    │ Energy/atom│ Band Gap │ Mag Mom │ Structure │ │
│  ├───┼──────────┼────────────┼──────────┼─────────┼───────────┤ │
│  │ 1 │ Cu-Ti    │ -5.234     │ 2.1 eV   │ 0.0     │ [View]   │ │
│  │ 2 │ Cu-Mn    │ -5.102     │ 1.8 eV   │ 3.2     │ [View]   │ │
│  │ 3 │ Cu-Co    │ -4.987     │ 1.6 eV   │ 1.1     │ [View]   │ │
│  │ 4 │ Cu-Ni    │ -4.890     │ 1.5 eV   │ 0.0     │ [View]   │ │
│  └───┴──────────┴────────────┴──────────┴─────────┴───────────┘ │
│                                                                  │
│  ☑ Show failed    ☑ Show filtered-out                           │
│                                                                  │
│  Sort: Energy/atom ↑↓    Filter: [band_gap > ___]              │
│                                                                  │
│  [Export CSV]  [Export JSON]  [Open Top N in Viewer]             │
│                                                                  │
│  Chart: [Bar ▼]                                                 │
│  ████████████████████████  Cu-Ti  -5.23                         │
│  ██████████████████████    Cu-Mn  -5.10                         │
│  ████████████████████      Cu-Co  -4.99                         │
│  ██████████████████        Cu-Ni  -4.89                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

#### src/lib/workflow/components/ResultTablePanel.svelte

Features:
- Sortable, filterable data table
- Column visibility toggle (show/hide properties)
- Inline bar chart for quick visual comparison
- "[View]" button loads that structure in the 3D viewer
- "[Open Top N in Viewer]" opens top candidates in multi-pane view
- "Show failed" checkbox → include failed branches in table
- "Show filtered-out" → show candidates that didn't pass filter (grayed out)
- Interactive filter input → live re-filter without re-running
- Export to CSV/JSON

Props:
- results: AggregateResult (from aggregate node output)
- on_view_structure: (structure) => void

### 10E: Batch Generate node parameter UI

The batch_generate node should have a CLEAR, guided parameter form.
When the user selects a mode, show ONLY the relevant parameters,
with helpful examples and previews.

Add to the node's config panel in WorkflowEditor:

```
┌── Batch Generate Configuration ────────────────────┐
│                                                      │
│  Mode: [Element Substitution ▼]                     │
│                                                      │
│  Elements to try:                                    │
│  ┌──────────────────────────────────────────────┐   │
│  │ Ti, V, Cr, Mn, Fe, Co, Ni, Cu               │   │
│  └──────────────────────────────────────────────┘   │
│  ℹ️ Comma-separated element symbols                  │
│                                                      │
│  Sites to substitute:                                │
│  ○ All sites of matching element                     │
│  ○ Specific indices: [0, 3, 7]                      │
│                                                      │
│  Preview: Will generate 8 structures                │
│  ┌─────────────────────────────────────────────┐    │
│  │ Cu₃Ti  Cu₃V  Cu₃Cr  Cu₃Mn  ...             │    │
│  └─────────────────────────────────────────────┘    │
│                                                      │
└──────────────────────────────────────────────────────┘
```

Implementation:
- Show a "Preview" section that calculates how many structures
  will be generated BEFORE the user runs the workflow
- For surface mode: show Miller indices as clickable pills
- For adsorbate mode: show a list of detected adsorption sites
- For custom mode: show a Python code editor with template

### 10F: Guided onboarding for high-throughput workflows

When user drags the first batch_generate, map, or aggregate node:
- Show a tooltip/popover explaining the 3-node pattern:
  "batch_generate → map → [your calculation] → aggregate"
- Offer a "Create Screening Template" button that auto-creates
  the full pattern with suggested parameters
- Include a "Learn More" link to in-app help

Add help_text to each node definition with clear JSDoc-style comments:

```typescript
// In batch-generate.ts
help_text: `
## Batch Generate

Generates multiple candidate structures from a parameter space.
Connect this to a **Map** node to run calculations on all candidates in parallel.

### Modes
- **Element Substitution**: Replace atoms with different elements. Great for dopant screening.
- **Surface Miller Indices**: Generate multiple surface cuts. Use for surface energy studies.
- **Adsorbate Sites**: Place adsorbates at all unique sites. Use for catalysis screening.
- **Lattice Scan**: Vary lattice parameter. Use for EOS curves.
- **Custom Python**: Write your own generator function.

### Example Workflow
\`\`\`
Structure Input → Batch Generate → Map → [Geo Opt → Static] → Aggregate
\`\`\`

### Tips
- Start with MLP (machine learning potential) for fast pre-screening
- Use the Aggregate node's "Top N" filter to select best candidates
- Then run DFT only on the top candidates (two-stage screening)
`,

// In map.ts
help_text: `
## Map (Parallel)

Runs the downstream workflow on each input structure **in parallel**.

### How it works
1. Receives a list of structures from Batch Generate
2. For each structure, clones the sub-workflow (everything until Aggregate)
3. Submits all branches to HPC simultaneously
4. Tracks progress in real-time

### Parameters
- **Max Parallel**: Limit concurrent HPC jobs (0 = no limit)
- **On Failure**: "Continue others" keeps running, "Abort all" cancels everything
- **Auto-retry**: Automatically re-submit failed branches once

### Monitoring
Click the progress bar during execution to see all branches,
their status, and intermediate results.
`,

// In aggregate.ts
help_text: `
## Aggregate & Filter

Collects results from all parallel branches and creates a comparison table.

### Features
- Sort by any computed property (energy, band gap, forces, etc.)
- Filter with expressions: \`band_gap > 1.5 and energy_per_atom < -5\`
- Keep only top N candidates
- Export results as CSV or JSON

### After execution
Click "View Results Table" to see the full comparison with:
- Sortable data table
- Bar chart visualization
- Click any row to view that structure in 3D
- Export filtered results
`,
```

## Frontend code comments standard
All new .svelte and .ts files MUST include:
1. File-level JSDoc comment explaining what the component does
2. Prop-level comments for every prop
3. Function-level comments for non-trivial logic
4. Inline comments for anything that would confuse a first-time reader

Example:
```typescript
/**
 * BranchStatusPanel — Real-time monitoring panel for parallel map execution.
 *
 * Shows a table of all branches spawned by a Map node, with live status
 * updates via WebSocket. Users can retry failed branches, abort all,
 * or export intermediate results.
 *
 * @example
 * <BranchStatusPanel
 *   workflow_id="wf-123"
 *   map_node_id="n456"
 *   branches={branch_data}
 *   on_view_structure={(s) => load_in_viewer(s)}
 * />
 */
```

## Validation
- Drag batch_generate → tooltip explains the 3-node pattern
- Map node shows progress bar during execution
- Click progress bar → BranchStatusPanel opens with live updates
- Aggregate node shows "View Results Table" after completion
- ResultTablePanel sorts, filters, and exports correctly
- All help_text renders as markdown in the help popover
- pnpm check passes
```

---

## Prompt P11: CatBot Knowledge Base Update

```
Update CatBot's knowledge base so it can help users with ALL new features.
CatBot should be able to answer ANY question about workflow import,
high-throughput screening, and new node types.

## Read first
1. src/lib/chat/workflow-tools.ts — CatBot's workflow tool definitions
2. server/mcp_tools/workflow_tools.py — MCP workflow tools (server-side)
3. server/mcp_tools/server.py — MCP server with tool definitions

## What to update

### 1. Update CatBot's system prompt / knowledge

Add comprehensive knowledge about:

#### atomate2 / quacc import
- How to import: "Use the Import button in the workflow editor toolbar"
- Template library: "Browse pre-built templates from atomate2 and quacc"
- JSON import: "Export your atomate2 flow with flow.as_dict(), save as JSON, then import"
- What gets mapped: "atomate2 Makers map to CatGo's existing nodes (RelaxMaker → geo_opt)"
- Limitations: "Dynamic workflows (Response.detour/replace) appear as opaque nodes"

#### High-throughput screening
CatBot must know how to guide users through building a screening workflow:

Step-by-step guidance:
1. "Start with a Structure Input node"
2. "Add a Batch Generate node — choose your screening mode"
   - Element substitution: "Enter comma-separated elements like Ti,V,Cr,Mn"
   - Surface screening: "Enter Miller indices like 100,110,111"
   - Adsorbate screening: "Enter your adsorbate molecule formula"
3. "Add a Map node — this runs your calculation on ALL candidates in parallel"
   - "Set max_parallel to limit concurrent HPC jobs"
   - "Choose 'Continue others' to keep running even if some fail"
4. "Add your calculation nodes between Map and Aggregate"
   - "For fast pre-screening, use MLP (machine learning potential)"
   - "For accurate results, use VASP or CP2K"
5. "Add an Aggregate node — this collects and filters results"
   - "Sort by energy_per_atom, band_gap, or any property"
   - "Filter with expressions like 'band_gap > 1.5'"
   - "Keep only top N candidates"
6. "Click Run to start — watch progress in the Branch Status panel"
7. "After completion, click 'View Results Table' on the Aggregate node"

Common user questions CatBot should answer:
- "How do I screen for catalysts?" → catalyst screening template
- "How do I find the best dopant?" → dopant screening template
- "How many structures can I screen at once?" → depends on HPC allocation
- "Can I do two-stage screening?" → yes, MLP pre-screen → DFT validation
- "What if some calculations fail?" → fail_strategy, retry_failed options
- "How do I export results?" → CSV/JSON from ResultTablePanel
- "Can I import my atomate2 workflow?" → yes, via Import dialog
- "What atomate2 Makers are supported?" → list all mapped Makers
- "How do I set up a phonon calculation?" → phonon template
- "What's the difference between Map and Loop?" → Map = parallel on list, Loop = sequential iteration

#### New node types
CatBot should know about every new node and be able to help configure them:

- QE nodes (qe_scf, qe_relax, qe_bands, qe_dos, qe_phonon):
  "Set ecutwfc (Ry), choose pseudopotentials (SSSP or PseudoDojo)"
- Q-Chem nodes (qchem_sp, qchem_opt, qchem_ts):
  "Choose method (B3LYP, wB97X-V), basis set, solvent model"
- Phonon analysis: "Needs displacement forces as input, outputs band structure + DOS"
- EOS analysis: "Needs energy-volume data, fits Birch-Murnaghan or Vinet"
- Elastic analysis: "Needs deformation statics, outputs elastic tensor"

### 2. Add workflow creation tools for CatBot

Update src/lib/chat/workflow-tools.ts to add new tools:

```typescript
// Tool: create_screening_workflow
{
  name: "create_screening_workflow",
  description: "Create a high-throughput screening workflow from a template",
  parameters: {
    template: "catalyst | dopant | surface | eos | mlp_prescreen",
    software: "vasp | cp2k | orca | mlp",
    // template-specific params
    elements?: string,      // for dopant screening
    miller_indices?: string, // for surface screening
    adsorbate?: string,     // for catalyst screening
  }
}

// Tool: import_atomate2_template
{
  name: "import_atomate2_template",
  description: "Import a pre-built atomate2 workflow template",
  parameters: {
    template_id: string,  // e.g. "atomate2-double-relax"
  }
}

// Tool: import_quacc_template
{
  name: "import_quacc_template",
  description: "Import a pre-built quacc workflow template",
  parameters: {
    template_id: string,
  }
}
```

### 3. Update MCP workflow tools (server-side)

In server/mcp_tools/workflow_tools.py, add knowledge of:
- All new node types and their default parameters
- Template IDs for atomate2 and quacc templates
- Screening workflow construction patterns
- Batch generate modes and their parameters

## Validation
- Ask CatBot: "How do I screen for the best catalyst?" → it should walk through the full workflow
- Ask CatBot: "Import the atomate2 double relaxation template" → it should use the import tool
- Ask CatBot: "What pseudopotentials should I use for QE?" → it should explain SSSP vs PseudoDojo
- Ask CatBot: "My screening has 5 failed branches, what should I do?" → it should explain retry/debug options
- Ask CatBot: "How do I do a two-stage MLP+DFT screening?" → it should build the workflow step by step
```

---

## Execution Order

```
P1 → P2 → P3    (atomate2 pipeline)
P4 → P5 → P6    (quacc pipeline)
P7               (import UI, depends on P2+P5)
P8               (new node types)
P9 → P9E → P10  (high-throughput: nodes → engine → frontend UX)
P11              (CatBot knowledge, depends on all above)
```

P1+P4 can run in parallel (independent backends).
P3+P6 can run in parallel (independent template sets).
P7 depends on the API endpoints from P2+P5.
P8 is independent and can start anytime.
P9+P9E+P10 is the high-throughput pipeline.
P11 must be done last — after all features are implemented.

## Dependencies

- **Zero dependencies for core features**: templates are pre-generated JSON, converter parses raw JSON/AST — no atomate2/quacc/jobflow installation needed
- **Optional: monty** (for robust atomate2 JSON deserialization with MSONable types) — lightweight, no transitive deps
- **Optional: atomate2 + quacc** — only needed for "Import from Python" feature (P7 Tab 3), where users execute Python code to dynamically generate workflows. This is an advanced feature, not required for the main workflow.

## File Structure

```
server/converters/                     # Built-in, ships with CatGo
├── atomate2/
│   ├── __init__.py
│   ├── maker_map.py      # P1: Maker → CatGo node mapping
│   ├── converter.py       # P2: Flow JSON → CatGo graph
│   └── templates.py       # P3: pre-built workflow templates
├── quacc/
│   ├── __init__.py
│   ├── recipe_map.py      # P4: recipe → CatGo node mapping
│   ├── converter.py       # P5: @flow AST → CatGo graph
│   └── templates.py       # P6: pre-built workflow templates

server/routers/
├── atomate2.py            # P2: import API endpoints
├── quacc.py               # P5: import API endpoints

src/lib/workflow/
├── components/
│   └── ImportWorkflowDialog.svelte  # P7: import UI

src/lib/workflow/node-defs/
├── calculation/
│   ├── qe-*.ts            # P8: Quantum ESPRESSO nodes
│   └── qchem-*.ts         # P8: Q-Chem nodes
├── analysis/
│   ├── phonon.ts          # P8: phonon post-processing
│   ├── eos.ts             # P8: equation of state
│   └── elastic.ts         # P8: elastic tensor
├── utility/
│   └── batch-generate.ts  # P9: batch structure generation
├── logic/
│   ├── map.ts             # P9: parallel fan-out
│   └── aggregate.ts       # P9: collect + filter

server/workflow/engines/
├── batch_generate.py      # P9: structure generation engine
├── map_node.py            # P9: parallel execution engine
└── aggregate_node.py      # P9: result collection engine
```

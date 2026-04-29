---
name: neb_ts
description: ORCA NEB-TS transition state search. Requires reactant and product structures. Handles NEB parameters, image count, and CI-NEB settings.
---

# ORCA NEB-TS Transition State Skill

## When to Use

Use this skill when the user wants to:
- Find a transition state between two structures
- Calculate a reaction barrier
- Map a minimum energy path (MEP) between reactant and product

Requirements: the user MUST provide both a reactant and a product structure.
If only one structure is available, ask for the other before proceeding.

## How NEB-TS Works

1. ORCA interpolates images between reactant and product geometries
2. NEB optimization finds the minimum energy path
3. Climbing-image NEB (CI-NEB) refines the highest-energy image
4. The TS is characterized by exactly one imaginary frequency

## MCP Tool Examples

### Step 1: Load reactant structure

```json
catgo_fetch(action: "molecule", query: "reactant_name")
```

Or if the user provides a file:

```json
catgo_structure(action: "load_file", file_content: "<xyz content>", file_format: "xyz")
```

Save the reactant -- get its structure from the viewer:

```json
catgo_view(action: "get_state")
```

### Step 2: Create NEB-TS workflow

```json
catgo_workflow_engine(action: "create", params: {
  name: "SN2 reaction TS search"
})
```

### Step 3: Add NEB-TS task

The `orca_neb_ts` node type requires both reactant and product structures
provided as inputs. In the v2 engine, these come from upstream structure_input
tasks:

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "orca_neb_ts",
  params: {
    software: "orca",
    orca_method: "B3LYP",
    orca_basis: "def2-SVP",
    charge: 0,
    multiplicity: 1,
    neb_images: 8,
    neb_convergence: "normal"
  }
})
```

### Using the v1 workflow with explicit structures

In the graph-based workflow (v1), use the `catgo_workflow` tool:

```json
catgo_workflow(action: "create", name: "NEB-TS Cl- + CH3Br")
```

```json
catgo_workflow(action: "batch", workflow_id: "<wf_id>", operations: [
  {"op": "add_node", "node_type": "structure_input", "label": "reactant"},
  {"op": "add_node", "node_type": "structure_input", "label": "product"},
  {"op": "add_node", "node_type": "orca_neb_ts", "label": "neb",
   "params": {
     "orca_method": "B3LYP",
     "orca_basis": "def2-SVP",
     "charge": -1,
     "multiplicity": 1,
     "neb_images": 8
   }},
  {"op": "connect", "from_id": "reactant", "to_id": "neb",
   "from_handle": "structure", "to_handle": "reactant"},
  {"op": "connect", "from_id": "product", "to_id": "neb",
   "from_handle": "structure", "to_handle": "product"}
])
```

### Step 4: Submit and monitor

```json
catgo_workflow_engine(action: "submit", params: { workflow_id: "<wf_id>" })
```

```json
catgo_workflow_engine(action: "status", params: { workflow_id: "<wf_id>" })
```

### Step 5: Verify the TS

After NEB-TS completes, run a frequency calculation on the TS geometry
to confirm exactly one imaginary frequency:

```json
catgo_workflow_engine(action: "add_task", params: {
  workflow_id: "<wf_id>",
  task_type: "freq",
  depends_on: ["<neb_task_id>"],
  params: {
    software: "orca",
    orca_method: "B3LYP",
    orca_basis: "def2-SVP",
    charge: 0,
    multiplicity: 1
  }
})
```

A valid TS has exactly one imaginary frequency (negative value). If there are
zero or more than one, the TS search failed.

## NEB Parameters

| Parameter | Default | Description |
|---|---|---|
| `neb_images` | 8 | Number of interpolated images |
| `neb_convergence` | "normal" | Convergence: "loose", "normal", "tight" |
| `orca_extra_keywords` | "" | Additional keywords (e.g., "D3BJ") |

### Image count guidelines

| System size | Recommended images |
|---|---|
| Small molecule (<15 atoms) | 6-8 |
| Medium molecule (15-50 atoms) | 8-12 |
| Large molecule (>50 atoms) | 12-16 |

More images = smoother path but higher cost (each image is a full DFT calc).

## Common Reaction Types

### SN2 reaction
- Charge: -1 (incoming nucleophile)
- Check that leaving group bond elongates along path

### Bond dissociation / formation
- Usually neutral, singlet
- Consider if radical pathway needs multiplicity: 3 (triplet)

### Proton transfer
- Include dispersion: `orca_extra_keywords: "D3BJ"`
- Consider solvent: `orca_extra_keywords: "D3BJ CPCM(Water)"`

## Troubleshooting

### NEB does not converge
- Increase `neb_images` (more interpolation points)
- Use a better starting path (optimize reactant and product first)
- Try `neb_convergence: "loose"` for initial run, then tighten

### Wrong TS found
- Check the imaginary frequency mode -- does it correspond to the expected
  bond breaking/forming?
- Try different initial interpolation (reorder atoms so they correspond)

### Too expensive
- Screen with `HF-3c` or `orca_method: "PBE", orca_basis: "def2-SVP"` first
- Refine with better method only on the TS geometry (single-point)

## Important Notes

- Reactant and product MUST have the same atoms in the same order
- Both structures should be pre-optimized at the same level of theory
- ORCA NEB-TS automatically switches to CI-NEB after initial convergence
- The barrier height is the energy difference between the TS and the reactant

---
name: catgo-build-workflow
description: One-shot CatGo DAG workflow construction. Use whenever the user asks to "create a workflow", "build a pipeline", "set up CO2RR/OER/HER/NEB/DOS/slow-growth", "make a workflow for X reaction", or any catalysis pipeline involving structure_input → calculation → analysis. Skips the exploration phase (avoids listing node_types / templates / node_details repeatedly) and goes straight to a single `catgo_workflow create` + `batch` round-trip with the full graph_json. Triggers in Chinese on 创建工作流, 建立工作流, 工作流, 计算流, 反应路径, 自由能图.
---

# catgo-build-workflow

Tight playbook for assembling a CatGo workflow in one or two MCP round-trips. The default CatBot path explores `node_types`, `node_details`, `templates`, then incrementally adds nodes and edges — that is 8+ MCP calls and the user sees the "Thinking…" indicator for tens of seconds. This skill cuts it to 1–2 calls.

## Iron rule: every reaction-mechanism workflow ends in Gibbs free energy

Activities, overpotentials, and barriers reported in catalysis literature are differences in **Gibbs free energy** at the operating temperature, *not* DFT electronic energies. So whenever the user asks for a reaction pathway — CO2RR, OER, HER, NRR, ORR, NEB, slow-growth, C–N coupling, anything ending in *RR, anything called "free energy diagram" or "volcano plot" — the workflow **must** contain a `freq` node between `geo_opt` (or `md`) and `free_energy` (or the reaction-specific analysis node). Without `freq` there is no ZPE and no thermal/entropic correction, the resulting numbers cannot be compared to experiment, and the user is silently wrong.

If the user proposes a mechanism workflow without a freq step, add one anyway and tell them one short sentence why ("Inserted a freq step so the ΔG values include ZPE + TS — without it the free-energy diagram is just an electronic-energy diagram"). If they explicitly say "skip freq for now, I just want a quick electronic-energy scan", honour it but flag that the result is not a Gibbs energy.

The `freq` node must run on the *same* geometry as the final relaxation it sits after — chaining `geo_opt → freq → free_energy` keeps the geometries consistent. For adsorbate thermochemistry, use `freeze_mode: "adsorbate"`: freeze the full slab and vibrate only atoms tagged by `adsorbate_place`.

## Clean-slab invariant

Every surface-reaction workflow built from a bulk structure must use `structure_input → slab_gen → geo_opt(clean slab) → adsorbate_place`. Reuse the same relaxed clean-slab output for every adsorbate branch. Never connect `slab_gen` directly to `adsorbate_place`: doing so optimizes only slab+adsorbate states and leaves no consistent relaxed clean-slab reference.

## When to use this skill

- User asks to *create*, *build*, *set up*, or *make* a workflow.
- User names a known reaction or pipeline (CO2RR, OER, HER, NRR, NEB, DOS, slow-growth, bulk→slab→adsorbate).
- User pastes a textual recipe like "structure_input → geo_opt → freq → free_energy".

If the user wants to *modify* an existing workflow (add a node to one that already exists), prefer a direct `catgo_workflow {action:"add_node"}` call rather than reloading this skill.

## The fast path

1. For stock HER/OER/ORR/NRR/CO2RR workflows, call `catgo_quickbuild` and stop; its server-side recipes enforce the clean-slab invariant. Use the manual path below only for custom graphs.
2. Pick a recipe from the "Recipes" section below — or assemble one from the node-type table — and prepare the `graph_json` payload.
3. Call `catgo_workflow` with `action="create"`, `name="<descriptive>"`, `template_id` only if you genuinely want the backend's stock template (most of the time you do not, because the recipes here are tighter). Otherwise omit `template_id` — `create` will auto-add a `structure_input` node seeded from the viewer's current structure.
4. Immediately call `catgo_workflow` with `action="batch"` and an `operations` array carrying every `add_node` + `connect` step in one round-trip. **Do not call `add_node` one at a time.**
5. Confirm with one short sentence ("Built '<name>': N nodes, M edges. Open the Workflow tab to inspect."). Do not list every node — the user can see the graph in the editor.

That is the entire happy path. **Do not call `templates`, `node_types`, `node_details`, `list_presets`, or `get` before creating** unless the user explicitly asks "what templates exist?" — those calls only exist for discovery and the recipes below already cover the common cases.

## Recipes

Each recipe gives the `operations` array you pass to `batch`. The seed `structure_input` node is already created for you by `create`; reference it as `"si"` in `from` fields. Use stable short IDs (`n1`, `n2`, …) for new nodes — these only need to be unique within the workflow.

### CO2RR (CO2 reduction on metal slab)

```json
[
  {"op":"add_node","id":"opt","type":"geo_opt","x":300,"y":200,"params":{"software":"vasp","encut":520,"ediffg":-0.03}},
  {"op":"add_node","id":"freq","type":"freq","x":520,"y":200,"params":{"software":"vasp","freeze_mode":"adsorbate"}},
  {"op":"add_node","id":"fe","type":"free_energy","x":740,"y":200,"params":{"temperature":298.15,"reference":"CHE"}},
  {"op":"connect","from":"si","to":"opt"},
  {"op":"connect","from":"opt","to":"freq"},
  {"op":"connect","from":"freq","to":"fe"}
]
```

For multi-intermediate CO2RR (CO2* → COOH* → CO* → CHO* …), duplicate `geo_opt` + `freq` per intermediate, all wired to the same `free_energy` node which aggregates ΔG values.

### OER (4-electron water oxidation)

```json
[
  {"op":"add_node","id":"opt","type":"geo_opt","x":300,"y":200,"params":{"software":"vasp","encut":520}},
  {"op":"add_node","id":"freq","type":"freq","x":520,"y":200,"params":{"software":"vasp"}},
  {"op":"add_node","id":"oer","type":"oer_analysis","x":740,"y":200,"params":{"reference":"CHE","pH":0}},
  {"op":"connect","from":"si","to":"opt"},
  {"op":"connect","from":"opt","to":"freq"},
  {"op":"connect","from":"freq","to":"oer"}
]
```

If the OER analysis node type is not registered, fall back to `free_energy` and tell the user to flip the analysis mode in the node panel.

### HER (hydrogen evolution)

```json
[
  {"op":"add_node","id":"opt","type":"geo_opt","x":300,"y":200,"params":{"software":"vasp","encut":520}},
  {"op":"add_node","id":"freq","type":"freq","x":520,"y":200,"params":{"software":"vasp"}},
  {"op":"add_node","id":"fe","type":"free_energy","x":740,"y":200,"params":{"reference":"CHE","target":"H"}},
  {"op":"connect","from":"si","to":"opt"},
  {"op":"connect","from":"opt","to":"freq"},
  {"op":"connect","from":"freq","to":"fe"}
]
```

### NEB / transition state

```json
[
  {"op":"add_node","id":"r_opt","type":"geo_opt","x":300,"y":120,"params":{"software":"vasp","label":"reactant"}},
  {"op":"add_node","id":"p_opt","type":"geo_opt","x":300,"y":320,"params":{"software":"vasp","label":"product"}},
  {"op":"add_node","id":"neb","type":"neb","x":540,"y":220,"params":{"software":"vasp","n_images":7,"climbing":true}},
  {"op":"add_node","id":"freq","type":"freq","x":760,"y":220,"params":{"software":"vasp"}},
  {"op":"connect","from":"si","to":"r_opt"},
  {"op":"connect","from":"si","to":"p_opt"},
  {"op":"connect","from":"r_opt","to":"neb","handle":"reactant"},
  {"op":"connect","from":"p_opt","to":"neb","handle":"product"},
  {"op":"connect","from":"neb","to":"freq"}
]
```

NEB needs **two** `structure_input` nodes if reactant and product are different structures. Ask the user before assuming the seed structure is one endpoint. If they confirm two endpoints, add a second `structure_input` in the operations array and skip the auto-seeded one (or repurpose it as the reactant).

### DOS / Band structure

```json
[
  {"op":"add_node","id":"opt","type":"geo_opt","x":300,"y":200,"params":{"software":"vasp","encut":520}},
  {"op":"add_node","id":"sp","type":"single_point","x":520,"y":200,"params":{"software":"vasp","encut":520}},
  {"op":"add_node","id":"dos","type":"dos_analysis","x":740,"y":200,"params":{"emin":-10,"emax":5,"d_band_center":true}},
  {"op":"connect","from":"si","to":"opt"},
  {"op":"connect","from":"opt","to":"sp"},
  {"op":"connect","from":"sp","to":"dos"}
]
```

Add a second `single_point` for band structure with a denser k-path if the user asks for both.

### Slow-growth AIMD (constrained MD with ICONST)

```json
[
  {"op":"add_node","id":"opt","type":"geo_opt","x":300,"y":200,"params":{"software":"vasp"}},
  {"op":"add_node","id":"equil","type":"md","x":520,"y":200,"params":{"software":"vasp","ensemble":"nvt","temperature":300,"nsw":2000,"potim":0.5}},
  {"op":"add_node","id":"sg","type":"slow_growth","x":740,"y":200,"params":{"software":"vasp","iconst":"<user-provided>"}},
  {"op":"add_node","id":"barrier","type":"md_analysis","x":960,"y":200,"params":{"mode":"barrier"}},
  {"op":"connect","from":"si","to":"opt"},
  {"op":"connect","from":"opt","to":"equil"},
  {"op":"connect","from":"equil","to":"sg"},
  {"op":"connect","from":"sg","to":"barrier"}
]
```

The `iconst` template depends on the reaction coordinate — for C–N coupling use `R 1 2 0` (where 1 and 2 are the atom indices and the trailing 0 increments per step). Confirm the indices with the user before submitting.

### Bulk → Slab → Adsorbate

```json
[
  {"op":"add_node","label":"bulk_opt","node_type":"cell_opt","params":{"software":"vasp","encut":520}},
  {"op":"add_node","label":"slab","node_type":"slab_gen","params":{"miller":"1,1,1","layers":4,"vacuum":15}},
  {"op":"add_node","label":"slab_opt","node_type":"geo_opt","params":{"software":"vasp","frozen_layers":2}},
  {"op":"add_node","label":"ads","node_type":"adsorbate_place","params":{"species":"CO","site":"ontop"}},
  {"op":"add_node","label":"ads_opt","node_type":"geo_opt","params":{"software":"vasp","frozen_layers":2}},
  {"op":"connect","from_id":"si","to_id":"bulk_opt"},
  {"op":"connect","from_id":"bulk_opt","to_id":"slab"},
  {"op":"connect","from_id":"slab","to_id":"slab_opt"},
  {"op":"connect","from_id":"slab_opt","to_id":"ads"},
  {"op":"connect","from_id":"ads","to_id":"ads_opt"}
]
```

## Node-type cheat sheet

When the user asks for something not in the recipes above, you can usually compose it from these node types. **Do not call `node_types` to refresh this list unless the user reports a node-type error.**

| Type | Purpose | Common params |
|---|---|---|
| `structure_input` | Seed structure (POSCAR/CIF/MP-ID) | `mp_id`, `structure_json` |
| `cell_opt` | Cell + ion relaxation (ISIF=3) | `software`, `encut`, `ediffg` |
| `geo_opt` | Ion-only relaxation (ISIF=2) | `software`, `encut`, `ediffg`, `frozen_layers` |
| `single_point` | Static SCF | `software`, `encut`, `ismear` |
| `md` | Molecular dynamics | `ensemble`, `temperature`, `nsw`, `potim` |
| `slow_growth` | Constrained AIMD via ICONST | `iconst`, `nsw` |
| `freq` | Vibrational frequencies | `freeze_mode`, `freeze_layers` |
| `neb` | NEB / CI-NEB TS search | `n_images`, `climbing` |
| `ts_search` | Sella / DIMER TS | `software`, `mode` |
| `slab_gen` | Cut slab from bulk | `miller`, `layers`, `vacuum`, `supercell` |
| `adsorbate_place` | Place adsorbate on slab | `species`, `site`, `height` |
| `dos_analysis` | DOS / PDOS / d-band | `emin`, `emax`, `d_band_center` |
| `free_energy` | ΔG with ZPE + TS corrections | `temperature`, `reference`, `target` |
| `md_analysis` | RDF / MSD / barrier from trajectory | `mode`, `pairs` |
| `condition` | If/else branching | `expression` |
| `loop` | Iterate over a list | `variable`, `values` |
| `merge` | Barrier / join branches | — |

## When to deviate

- If the user asks for an obscure pipeline ("slab convergence sweep across layer counts 3, 4, 5, 6"), you still build it in one `batch` call — just use a `loop` node with `variable=layers` and `values=[3,4,5,6]`.
- If a node type errors as unknown, **then and only then** call `catgo_workflow {action:"node_types"}` to refresh the catalogue. Don't preemptively check.
- If the user explicitly asks for a stock backend template, call `templates` first to look up the `template_id` and pass it to `create`.

## What to tell the user when done

One sentence. State the workflow name, node count, and that the workflow is open in the editor for inspection. Do **not** dump the operations array, the graph_json, or per-node parameter lists — the editor visualises all of that. Example:

> Built "CO2RR on Cu(100)": 4 nodes, 3 edges. Opened in the Workflow tab — review and click ▶ Run when ready.

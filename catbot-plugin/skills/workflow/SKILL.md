---
name: workflow
description: >
  Use when the user asks to create, build, inspect, validate, or run
  computational workflows, DAG pipelines, relaxation→static chains, NEB/IRC
  workflows, or HPC job submission flows.
---

# CatGO Workflow Skill

All MCP workflow operations use the single `catgo_workflow` tool with an `action` parameter.

## Current Reality

Do not assume old workflow docs are still correct.

Important current behavior:
- `create` creates a workflow that already contains one `structure_input` node.
- `run` starts execution immediately. It does not open a confirmation dialog.
- `connect` defaults both handles to `structure` if omitted.
- `node_types` is only a discovery list. It does not give full node schema.

## Quick Reference

| Action | Purpose | Required Params |
|--------|---------|----------------|
| `list` | List all workflows | — |
| `templates` | List available templates | — |
| `node_types` | List node types by category | `category?` |
| `create` | Create workflow | `name`, `template_id?` |
| `get` | Read workflow graph | `workflow_id` |
| `add_node` | Add node | `workflow_id`, `node_type`, `params?` |
| `remove_node` | Remove node | `workflow_id`, `node_id` |
| `connect` | Connect nodes | `workflow_id`, `from_id`, `to_id`, `from_handle?`, `to_handle?` |
| `set_params` | Update params | `workflow_id`, `node_id`, `params` |
| `validate` | Validate graph | `workflow_id` |
| `run` | Start execution immediately | `workflow_id`, `run_config?` |
| `pause` | Pause workflow | `workflow_id` |
| `resume` | Resume workflow | `workflow_id`, `run_config?` |
| `status` | Get run status | `workflow_id` |
| `step_error` | Get failure detail | `workflow_id`, `step_id` |

## Safe Build Sequence

### 1. Discover
- Call `node_types` first for coarse discovery.
- Call `templates` if the user wants a preset.

### 2. Create
```json
{"action": "create", "name": "TiO2 slab workflow"}
```

Immediately after create:
- Call `get`
- Check the graph
- Reuse the auto-created `structure_input` unless the workflow truly needs multiple independent inputs

### 3. Add Nodes
```json
{"action": "add_node", "workflow_id": "...", "node_type": "geo_opt"}
{"action": "add_node", "workflow_id": "...", "node_type": "single_point"}
```

### 4. Set Parameters
```json
{"action": "set_params", "workflow_id": "...", "node_id": "...", "params": {"software": "vasp", "ENCUT": 520}}
```

### 5. Connect Carefully

Only omit handles when both sides are obviously single-structure nodes.

Safer form:
```json
{
  "action": "connect",
  "workflow_id": "...",
  "from_id": "n1",
  "to_id": "n2",
  "from_handle": "structure",
  "to_handle": "structure"
}
```

## Do Not Do These

- Do not assume `create` returns an empty graph.
- Do not blindly add another `structure_input` after `create`.
- Do not assume `connect` can guess the right handle for multi-port nodes.
- Do not treat `validate` warnings as harmless.
- Do not call `run` before the user has provided a valid run configuration when HPC settings matter.

## Minimal Reliable Pattern

1. `node_types`
2. `create`
3. `get`
4. `add_node`
5. `set_params`
6. `connect` with explicit handles when needed
7. `validate`
8. `get`
9. `run`

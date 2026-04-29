---
title: Workflow Tools
description: AI workflow authoring surfaces in CatGO
source: src/lib/chat/workflow-tools.ts
---

# Workflow Tools

**Current status:** CatGO now has **two different AI-facing workflow surfaces**. Older docs that treated them as one layer are outdated.

## 1. Frontend Chat Workflow Tools

Source:
- `src/lib/chat/workflow-tools.ts`
- `src/lib/chat/workflow-tool-executor.ts`

These are the tools used by the in-app chat panel. They are separate named tools, not a single `action` router.

Available tool names:
- `list_workflows`
- `get_workflow_status`
- `get_step_error`
- `suggest_params`
- `get_node_definitions`
- `get_workflow_templates`
- `validate_workflow`
- `create_workflow`
- `add_node`
- `remove_node`
- `connect_nodes`
- `set_node_params`
- `run_workflow`
- `pause_workflow`

Behavior notes:
- `create_workflow` creates an **empty graph** in the frontend chat path.
- If the user is inside a project dashboard, the executor tries to auto-assign the new workflow to the active project.
- Mutation tools require an active `WorkflowEditor` instance.

## 2. MCP Workflow Tool

Source:
- `server/mcp_tools/tools/misc.py`
- `server/mcp_tools/server.py`
- `server/mcp_tools/server_claude_code.py`

This is the unified MCP tool:

`catgo_workflow`

It uses an `action` field:
- `list`
- `templates`
- `node_types`
- `create`
- `get`
- `add_node`
- `remove_node`
- `connect`
- `set_params`
- `validate`
- `run`
- `pause`
- `resume`
- `status`
- `step_error`

Behavior notes:
- MCP `create` currently creates a workflow with an initial `structure_input` node already present.
- MCP `run` sends the run request immediately; it does **not** open a UI dialog for confirmation.
- MCP `connect` defaults `from_handle` and `to_handle` to `structure` if omitted.

## 3. Important Difference

The frontend chat tools and the MCP tool do **not** behave identically.

Most important mismatch:
- Frontend chat `create_workflow` -> empty graph
- MCP `catgo_workflow(action="create")` -> graph pre-populated with `structure_input`

When updating prompts, skills, or agent instructions, do not assume these two surfaces are interchangeable.

## 4. Safe Authoring Pattern

For MCP / CatBot:
1. `node_types`
2. `create`
3. `get`
4. `add_node`
5. `set_params`
6. `connect` with explicit handles when the graph is not trivially `structure -> structure`
7. `validate`
8. `get`
9. `run` only after explicit `run_config`

For frontend chat:
1. `create_workflow`
2. `get_node_definitions`
3. `add_node`
4. `set_node_params`
5. `connect_nodes`
6. `validate_workflow`
7. `run_workflow`

## Related

- [Workflow Engine](/modules/workflow/workflow-engine)
- [Project Dashboard](/modules/workflow/project-dashboard)
- [Chat System](/modules/ai/chat-system)

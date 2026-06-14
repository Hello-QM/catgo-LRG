---
title: 工作流工具
description: CatGo 中面向 AI 的工作流编排入口
source: src/lib/chat/workflow-tools.ts
---

# 工作流工具

**当前状态：** CatGo 现在有**两个不同的 AI 工作流入口**。旧文档中把它们当作同一层的说法已经过时。

## 1. 前端聊天工作流工具

来源：
- `src/lib/chat/workflow-tools.ts`
- `src/lib/chat/workflow-tool-executor.ts`

这些是应用内聊天面板使用的工具。它们是彼此独立的具名工具，而不是单一的 `action` router。

可用工具名：
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

行为说明：
- `create_workflow` 会在前端聊天路径中创建一个**空图**。
- 如果用户位于项目仪表盘中，执行器会尝试把新工作流自动分配给当前活动项目。
- 修改类工具需要存在活动的 `WorkflowEditor` 实例。

## 2. MCP 工作流工具

来源：
- `server/mcp_tools/tools/misc.py`
- `server/mcp_tools/server.py`
- `server/mcp_tools/server_claude_code.py`

这是统一的 MCP 工具：

`catgo_workflow`

它使用 `action` 字段：
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

行为说明：
- MCP `create` 当前会创建一个已包含初始 `structure_input` 节点的工作流。
- MCP `run` 会立即发送运行请求，**不会**打开 UI 对话框进行确认。
- MCP `connect` 在省略时会把 `from_handle` 和 `to_handle` 默认设为 `structure`。

## 3. 重要差异

前端聊天工具和 MCP 工具的行为**并不完全相同**。

最重要的不一致点：
- 前端聊天 `create_workflow` -> 空图
- MCP `catgo_workflow(action="create")` -> 图中预先包含 `structure_input`

更新 prompts、skills 或 agent 指令时，不要假设这两个入口可以互换。

## 4. 安全编排模式

对于 MCP / CatBot：
1. `node_types`
2. `create`
3. `get`
4. `add_node`
5. `set_params`
6. 当图不是简单的 `structure -> structure` 链路时，使用显式 handle 执行 `connect`
7. `validate`
8. `get`
9. 只有在显式设置 `run_config` 后才执行 `run`

对于前端聊天：
1. `create_workflow`
2. `get_node_definitions`
3. `add_node`
4. `set_node_params`
5. `connect_nodes`
6. `validate_workflow`
7. `run_workflow`

## 相关内容

- [工作流引擎](/zh/modules/workflow/workflow-engine)
- [项目仪表盘](/zh/modules/workflow/project-dashboard)
- [聊天系统](/zh/modules/ai/chat-system)

# CatGo 插件架构分析

更新时间: 2026-03-13

状态说明:

- 本文是当前架构快照，不是任务方案，也不是 bug ledger。
- 当前确认 bug 请看 `WORKFLOW_BUGS.md` 与 `reports/bug-*.md`。
- 这里只保留能直接从当前源码验证的结论。

## 当前可确认的插件面

后端正式插件基类位于 `server/plugins/base.py`，当前已定义:

- `CalculatorPlugin`
- `OptimizerPlugin`
- `ReaderPlugin`
- `AnalyzerPlugin`
- `WorkflowNodePlugin`

对应的 `PluginType` 也已经包含:

- `calculator`
- `optimizer`
- `reader`
- `analyzer`
- `workflow_node`
- `router`

这意味着仓库已经不再是“只有 calculator / optimizer 两类插件”的旧状态。

## 当前发现与注册流程

插件发现入口在 `server/plugins/discovery.py`。

当前行为:

- 默认优先查找项目根目录 `plugins/`
- 若该目录不存在，再回退到 `server/plugins/`
- 用户级目录是 `~/.catgo/plugins/`
- 支持 `catgo-plugin.json` + 后端入口文件
- 也支持裸 `plugin.py`

当前 `_find_plugin_class()` 已能识别:

- `CalculatorPlugin`
- `OptimizerPlugin`
- `ReaderPlugin`
- `AnalyzerPlugin`
- `WorkflowNodePlugin`

`server/plugins/manager.py` 中的 `PluginManager` 也已经分别维护:

- calculator registry
- optimizer registry
- reader registry
- analyzer registry
- workflow-node registry

因此，旧文档里“发现器只支持两类插件”的说法已经过时。

## 当前已经接通的能力

`CalculatorPlugin` 的历史断路已经修复。

当前可直接从源码确认:

- `server/routers/optimize.py` 的 `list_calculators()` 已合并 `plugin_manager.get_all_calculators()`
- `server/calculators/base.py` 的 `get_calculator()` 已支持插件 calculator ID

所以，“插件能安装但优化接口完全看不见它们”不再是当前事实。

## 当前仍然存在的架构割裂

虽然正式插件系统已经扩展到多类插件，但仓库里的扩展机制仍未统一。

可以直接观察到至少四条并行路径:

1. `server/plugins/*`
   - 正式后端插件系统
   - 面向 calculator / optimizer / reader / analyzer / workflow node

2. `server/tools/*`
   - 新的统一 tool lifecycle
   - 面向 `catgo_create_tool` / `catgo_save_tool` / `catgo_upgrade_tool`

3. `server/plugins/tool_builder.py`
   - 旧的 AI tool builder 路径
   - 仍然存在，但已与 `server/tools/*` 脱节

4. `extensions/*`
   - 历史分析库 / Rust / WASM 扩展目录
   - 并不统一通过 `PluginManager` 注册

这也是当前文档容易漂移的根因: 仓库里并不是“一个插件系统”，而是多套扩展机制共存。

## 当前值得注意的真实风险

### 1. `router` 类型仍然只是预留位

`PluginType` 有 `ROUTER`，但当前发现器与管理器并没有形成一条完整的 router-plugin 执行路径。

结论:

- `router` 更像预留枚举值
- 不能把它视为已经完整落地的插件能力

### 2. 旧 `tool_builder` 子系统与当前基类不一致

`server/plugins/tool_builder.py` 仍然:

- `from .base import PluginError, ToolPlugin`
- 生成 `class GeneratedToolPlugin(ToolPlugin)`

但当前 `server/plugins/base.py` 中并没有 `ToolPlugin` 定义。

这说明旧 tool-builder 路径已经与当前插件基类脱节。这个问题应当视为当前源码不一致，详细状态见 `reports/bug-followup-2026-03-13.md`。

### 3. 扩展入口仍然分散

即使正式插件系统已经支持 reader / analyzer / workflow node，扩展发现与执行入口仍分散在:

- 插件管理器
- MCP 工具分发
- REST tools router
- 历史 `extensions/` 目录

这会持续带来:

- 文档漂移
- AI agent 误用旧入口
- 新能力接入时重复造轮子

## 当前更准确的判断

对这个仓库，最准确的描述不是“插件系统缺失”，而是:

- 正式插件系统已经存在，且能力范围比旧文档更大
- 但仓库尚未把所有扩展面统一收敛到这一套系统
- 尤其是 tool lifecycle 与历史插件路径仍然双轨并存

## 建议阅读

- `CLAUDE.md`
- `server/CLAUDE.md`
- `src/lib/workflow/CLAUDE.md`
- `reports/bug-followup-2026-03-13.md`
- `reports/refactor-hotspots-2026-03-13.md`

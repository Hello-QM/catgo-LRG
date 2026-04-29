# code_frame 文档索引

更新时间: 2026-03-13

用途:
- 这里保留的是仍有参考价值、且已做过时效性清理的架构分析文档。
- 明显过时的代码快照 / 旧方案 / 旧任务文档已删除或另行归档。

使用规则:
- `code_frame/` 文档是架构分析和源码导航，不是当前 bug ledger。
- 当前 bug 状态请优先看：
  - `WORKFLOW_BUGS.md`
  - `reports/bug-analysis-2026-03-13.md`
  - `reports/bug-followup-2026-03-13.md`

推荐阅读顺序:

1. `CLAUDE.md`
   - 仓库级当前结构快照
2. `src/lib/workflow/CLAUDE.md`
   - 当前 workflow UI / CatBot 相关事实
3. `code_frame/plugin-architecture-analysis.md`
   - 插件系统架构分析与统一方向
4. `code_frame/structure-controllers.md`
   - `Structure.svelte` 控制器拆分架构
5. `server/CLAUDE.md`
   - 后端 MCP / CLI agent / 事故记录入口

仍保留的主题文档:

- `plugin-architecture-analysis.md`
- `structure-controllers.md`

已移除的旧快照类文档:

- `architecture-analysis.md`
- `workflow-system.md`
- `workflow-system.en.md`
- `plugin-system-current.md`
- `plugin-system-current.en.md`
- `self-extending-tools-analysis.md`
- `self-extending-tools-analysis.en.md`
- `refactoring-prompts.md`
- `plans/unified-plugin-spec.md`
- `ai-chat-architecture.md`
- `mcp-tools.md`
- `mcp-tools.en.md`
- `dos-analysis.md`
- `dos-pipeline.md`
- `dos-pipeline.en.md`
- `file-readers-catalog.md`
- `file-readers-catalog.en.md`
- `visualization-layer.md`
- `visualization-layer.en.md`
- `atom-clipboard.md`
- `plugin-architecture-analysis.en.md`
- `tab-system.md`
- `windows-networking.md`

移除原因:
- 内容明显依赖过时行号、工具数量、旧实现状态或未落地路线图
- 继续保留会误导 AI 和开发者把历史分析当成当前事实

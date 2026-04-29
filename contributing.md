# CatGo 协作开发指南

> 本指南面向**使用 AI 助手**（Claude Code / Cursor / GitHub Copilot）参与 CatGo 开发的合作者。
> 即使你对项目不熟悉，按照下面的步骤操作即可。

---

## 一、环境准备

```bash
# 1. 克隆项目
git clone https://github.com/Hello-QM/CatGO.git
cd CatGO

# 2. 安装依赖
pnpm install

# 3. 启动开发服务器（二选一）
pnpm dev              # Web 版，打开 http://localhost:3000
pnpm desktop:dev      # Desktop 版（需要 Rust + Tauri）

# 4. 启动后端（如果需要做插件/分析/MCP 相关开发）
cd server
pip install -r requirements.txt
python main.py        # 后端跑在 http://localhost:8000
```

---

## 二、项目知识都在仓库里

本项目的所有架构知识、代码索引、实施计划都**写在仓库文件中**，不需要额外的文件。

### 知识文件一览

| 文件 | 干什么用的 |
|------|-----------|
| `CLAUDE.md` | 项目总览 — 技术栈、架构、构建命令、常见坑 |
| `code_frame/*.md` | 代码结构文档 — 每个子系统的详细索引 |
| `plans/*.md` / `tasks_done/*.md` | 进行中的实施计划 + 已完成任务归档 + 现成的 AI Prompt |
| `src/lib/*/CLAUDE.md` | 各模块的开发指南 |

**你不需要全部读完。** 根据你要做的任务，只读对应的文件就行。下面教你怎么做。

---

## 三、怎么用 AI 助手开发（手把手教学）

### 场景 1: 你刚接手项目，想了解整体架构

直接复制下面这段话发给 AI：

```
请读取以下两个文件，然后给我一个项目架构的简要说明：
1. CLAUDE.md
2. code_frame/README.md
```

AI 读完后会了解整个项目。然后你就可以自由提问了，比如：
- "DOS 分析的数据流是怎样的？"
- "怎么加一个新的文件格式支持？"
- "Structure.svelte 为什么这么大？"

---

### 场景 2: 你要做插件系统的某个 Phase

我们已经为每个开发阶段写好了**可以直接复制给 AI 的 Prompt**。

**第 1 步**：打开 `plans/ai-prompts-for-implementation.md`

**第 2 步**：找到你要做的 Phase（比如 Phase 1: ReaderPlugin）

**第 3 步**：把整个 Prompt 复制给 AI

就这么简单。Prompt 里已经包含了：
- AI 需要读哪些文件
- 要写什么代码
- 怎么验证结果

**Phase 对照表**：

| Phase | 任务 | 难度 |
|-------|------|------|
| Phase 0 | 修复 Calculator 插件断路 | 简单（改 3 个文件） |
| Phase 1 | 实现 ReaderPlugin + CP2K DOS | 中等（新增基类 + 示例插件） |
| Phase 2 | 实现 AnalyzerPlugin | 中等（与 Phase 1 类似） |
| Phase 3 | 实现 WorkflowNodePlugin | 中等（前后端都要改） |
| Phase 4 | MCP 动态工具注册 | 简单（改 1 个文件） |
| Phase 5 | 前端动态 Tab | 中等（Svelte 组件） |

---

### 场景 3: 你要修 bug 或加小功能

发给 AI 这样的 prompt：

```
请先读取 CLAUDE.md，然后帮我 [你的任务描述]。

比如：
- "帮我修复 DOS 图表在暗色模式下看不清的问题"
- "帮我给 XRD 图加一个导出 PNG 的按钮"
- "帮我在设置面板加一个原子半径缩放滑块"
```

如果 AI 不确定去哪里改，引导它读对应的 code_frame 文件：

```
请读取 docs/modules/electronic/dos.md，
然后帮我修改 DosPlot.svelte 的暗色模式样式。
```

---

### 场景 4: 你要加一个新的文件格式支持（比如 Quantum ESPRESSO 的 DOS）

```
请读取以下文件：
1. CLAUDE.md
2. docs/modules/core/file-io.md — 当前文件格式与 IO 说明
3. docs/modules/electronic/dos.md — 当前 DOS 模块说明

任务：我想让 CatGo 能读取 Quantum ESPRESSO 的 .dos 文件并显示 DOS 图。
请先告诉我 QE .dos 文件的格式，然后设计实现方案。
```

---

### 场景 5: 你要理解某个复杂模块

```
请读取 code_frame/structure-controllers.md，
然后解释 Structure.svelte 的控制器抽取是怎么做的。
我想知道 interaction.svelte.ts 处理了哪些用户交互。
```

---

## 四、Prompt 编写技巧

### 好的 Prompt 长这样

```
请读取以下文件：
1. [具体文件路径]
2. [具体文件路径]

背景：[一句话说清楚上下文]

任务：[明确的动作，如"添加"、"修复"、"重构"]

要求：
- [具体要求 1]
- [具体要求 2]

验证：运行 pnpm check 确认无错误
```

### 坏的 Prompt 长这样

```
"帮我改一下插件系统"      → 太模糊，AI 不知道改什么
"看看代码有什么问题"      → 太开放，AI 会浪费时间乱找
"把所有代码重构一下"      → 范围太大，容易出错
```

### 万能 Prompt 模板

不知道怎么写 prompt？用这个模板：

```
请先读取 CLAUDE.md 和 code_frame/README.md。

我想做的事情是：[用一句话描述]

请先告诉我：
1. 需要修改哪些文件
2. 大概的实现思路
3. 有什么风险或注意事项

确认后我再让你开始写代码。
```

这样 AI 会先做调研，给你一个方案，你同意后再动手。避免 AI 一上来就乱改代码。

---

## 五、哪个文档对应哪个任务

| 你要做什么 | 让 AI 读什么 |
|-----------|-------------|
| 了解项目全貌 | `CLAUDE.md` |
| 插件系统开发 | `tasks_done/unified-plugin-system-plan-done.md` + `plans/ai-prompts-for-implementation.md` |
| 添加新文件格式 | `docs/modules/core/file-io.md` |
| DOS/COHP/Band 分析 | `docs/modules/electronic/dos.md` + `docs/modules/electronic/band-structure.md` + `docs/modules/electronic/cohp.md` |
| Workflow / 架构入口 | `code_frame/README.md` + `src/lib/workflow/CLAUDE.md` |
| MCP / 后端工具层 | `server/CLAUDE.md` + `docs/modules/server/mcp-server.md` |
| 改 Structure.svelte | `code_frame/structure-controllers.md` |
| 插件架构理解 | `code_frame/plugin-architecture-analysis.md` |
| 图表/可视化 | `src/lib/chat/CLAUDE.md` + 相关 `docs/modules/*` |
| 所有 code_frame 文档入口 | `code_frame/README.md` |

---

## 六、开发规范

### 提交前必须做

```bash
pnpm check    # TypeScript + Svelte 类型检查，必须 0 errors
```

如果有 error，让 AI 修：
```
pnpm check 报了以下错误，请修复：
[粘贴错误信息]
```

### 代码风格

- **TypeScript** — 严格模式，不用 `any`
- **Svelte 5** — 用 `$state`, `$derived`, `$effect`（不用旧的 Store）
- **注释** — 用中文写
- **字符串** — 用模板字面量（反引号 `` ` ``）

### Git 分支

- `main` — 稳定版本
- `dev` — 开发分支（日常开发在这里）
- 功能分支 — 从 `dev` 拉，完成后合回 `dev`

---

## 七、任务分配参考

### 依赖关系

```
Phase 0 (Calculator 断路) ← 最先做，其他都依赖它
  ↓
Phase 1 (ReaderPlugin)   ←─┐
Phase 2 (AnalyzerPlugin) ←─┤ 这三个可以三个人并行做
Phase 3 (WorkflowNode)   ←─┘
  ↓
Phase 4 (MCP 动态注册)   ←─┐
Phase 5 (前端动态 Tab)   ←─┘ Phase 1/2/3 做完后再做
```

### 每个开发者开始时发给 AI 的 Prompt

**开发者 A — ReaderPlugin**:
```
请读取以下文件：
1. CLAUDE.md
2. tasks_done/unified-plugin-system-plan-done.md（重点看已完成的 Phase 0 和 Phase 1）
3. plans/ai-prompts-for-implementation.md（Prompt 0 和 Prompt 1）
4. docs/modules/core/file-io.md
5. docs/modules/electronic/dos.md

任务：先完成 Phase 0（修复 calculator 插件断路），
然后实现 Phase 1（ReaderPlugin 基类 + CP2K DOS reader 示例插件）。
```

**开发者 B — AnalyzerPlugin**:
```
请读取以下文件：
1. CLAUDE.md
2. tasks_done/unified-plugin-system-plan-done.md（重点看已完成的 Phase 2）
3. plans/ai-prompts-for-implementation.md（Prompt 2）
4. docs/modules/electronic/dos.md
5. code_frame/plugin-architecture-analysis.md

任务：实现 Phase 2（AnalyzerPlugin 基类 + bond-histogram 示例插件）。
```

**开发者 C — WorkflowNodePlugin**:
```
请读取以下文件：
1. CLAUDE.md
2. tasks_done/unified-plugin-system-plan-done.md（重点看已完成的 Phase 3）
3. plans/ai-prompts-for-implementation.md（Prompt 3）
4. code_frame/README.md

任务：实现 Phase 3（WorkflowNodePlugin + 动态节点注册）。
```

---

## 八、遇到问题怎么办

| 问题 | 解决方案 |
|------|---------|
| AI 不知道项目结构 | 让它读 `CLAUDE.md` |
| AI 改错文件了 | 让它先读对应的 `code_frame/*.md` |
| pnpm check 报错 | 把错误信息粘贴给 AI |
| 不知道该读什么文档 | 让 AI 读 `code_frame/README.md`（总索引） |
| 后端 API 不work | 确认 `python main.py` 在跑，试 `curl http://localhost:8000/docs` |
| 前端热更新没反应 | 重启 `pnpm dev`，清浏览器缓存 |

---

## 九、文档维护

如果你在开发中发现了新的坑：

```
请把这个发现记录到 [对应模块]/CLAUDE.md 的 Pitfalls 部分。
```

或者自己加到 `code_frame/` 对应文件中。

文档保持最新 = 下一个人不用踩同样的坑。

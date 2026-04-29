# Structure Controllers 架构分析

更新时间: 2026-03-13

状态说明:

- 本文描述当前 `src/lib/structure/` 控制器拆分现状。
- 它不是 bug ledger，也不是历史重构计划。
- 当前结构模块 bug 请看 `reports/bug-*.md` 和 `src/lib/structure/CLAUDE.md`。

## 当前可确认的结论

`src/lib/structure/Structure.svelte` 仍然是结构查看器的总编排器。

但当前代码已经把一部分高风险逻辑拆到了 `src/lib/structure/controllers/`：

- `tool-handler.ts`
- `xrd-state.svelte.ts`
- `build-tools.svelte.ts`
- `file-handlers.ts`
- `context-menu-actions.ts`
- `interaction.svelte.ts`
- `pencil-mode.svelte.ts`
- `analysis.svelte.ts`
- `settings.svelte.ts`
- `fragments.ts`

这些控制器现在是当前实现的一部分，不再只是设计目标。

## 当前 wiring 方式

`Structure.svelte` 通过工厂函数创建 controller，并用 deps 闭包把主组件状态传进去。

当前从源码可直接确认的创建点包括:

- `create_settings_controller(...)`
- `create_build_tools_controller(...)`
- `create_analysis_controller(...)`
- `create_xrd_controller(...)`
- `create_interaction_controller(...)`
- `create_pencil_mode_controller(...)`
- `create_structure_action_handler(...)`
- `start_mcp_bridge(...)`

这个模式的核心特征是:

- `Structure.svelte` 仍然拥有主状态
- controller 负责某一类逻辑与副作用
- controller 不直接成为全局状态源

因此，当前架构更接近“总编排器 + 多个局部控制器”，而不是彻底的 store 化或 context 化。

## 当前各控制器的大致职责

### `tool-handler.ts`

负责结构相关工具执行与 MCP 桥接。

从 `Structure.svelte` 当前导入可确认:

- `create_structure_action_handler`
- `start_mcp_bridge`
- `create_ui_tool_executor`

这意味着它同时承担:

- 结构工具动作分发
- 与聊天 / agent 的结构操作桥接
- MCP 轮询式同步

这是当前结构模块与 CatBot 耦合最深的入口之一。

### `interaction.svelte.ts`

负责高密度交互逻辑。

当前至少覆盖:

- 鼠标选中
- 键盘快捷键
- 拖拽 / 旋转
- 框选
- 裁剪导出
- 右键菜单相关交互

这部分已经完成控制器抽取，但仍然属于超高复杂度模块。

### `settings.svelte.ts`

负责 viewer 相关展示状态聚合。

当前 `Structure.svelte` 会从这里取出:

- `scene_props`
- `lattice_props`

这说明显示配置已经不再全部散落在主组件顶层。

### `analysis.svelte.ts` 与 `xrd-state.svelte.ts`

前者负责分析面板状态编排，后者处理 XRD 相关状态和计算链。

这说明分析功能已经不是纯粹内联在 `Structure.svelte` 中，而是开始按主题拆分。

### `build-tools.svelte.ts`

负责建模工具相关状态。

这让 slab / build / adsorbate / doping 一类工具不必全部直接堆在主组件逻辑里。

### `file-handlers.ts`

负责导入、拖放、解压和特定文件类型处理。

这是正确的拆分方向，因为文件 IO 与 3D viewer 交互本来就不应该混在一个超长组件里。

## 当前仍未完成的地方

控制器拆分已经发生，但没有完成到“主组件足够轻”的程度。

从当前结构来看，`Structure.svelte` 仍然同时承担:

- 顶层状态持有
- controller 初始化与 wiring
- 大量 pane 级 UI 组合
- 一部分渲染与工具协同逻辑
- 聊天 / workflow / MCP 相关桥接

因此，更准确的判断是:

- 当前不是“单体组件未拆分”
- 也不是“已经模块化完成”
- 而是处于“关键逻辑已抽出，但总编排器仍过重”的中间态

## 当前主要风险

### 1. 状态所有权仍集中在 `Structure.svelte`

controller 虽然存在，但多数核心状态仍由主组件持有。

这会导致:

- 新功能继续倾向往主组件塞状态
- controller 接口越来越宽
- 回归问题难以定位

### 2. 交互层与 agent/tool 桥接仍然离得太近

`tool-handler.ts` 让结构视图直接参与:

- 结构工具执行
- MCP 同步
- chat / agent bridge

这对产品功能是实用的，但对边界是危险的。结构 viewer 的正确性会被 agent 工具路径直接影响。

### 3. 控制器拆分并不自动消除索引空间问题

当前结构模块最稳定的风险仍是:

- base structure
- supercell
- displayed structure
- PBC image atoms

这些表示的索引空间并不统一。即使控制器拆分完成，这类 bug 仍然会反复出现。

## 当前更准确的判断

这套架构的真实状态是:

- 控制器拆分已经落地，并且是当前代码的正式结构
- 拆分重点集中在交互、文件处理、分析、建模工具和设置
- 但 `Structure.svelte` 仍然是超重 orchestration layer

因此，后续如果还要继续收敛复杂度，优先级应放在:

1. 明确状态所有权
2. 缩窄 controller deps 面
3. 把 viewer 本体与 agent / MCP 桥接再拉开一层

## 建议阅读

- `src/lib/structure/CLAUDE.md`
- `src/lib/structure/workers/CLAUDE.md`
- `src/lib/symmetry/CLAUDE.md`
- `reports/bug-followup-2026-03-13.md`
- `reports/refactor-hotspots-2026-03-13.md`

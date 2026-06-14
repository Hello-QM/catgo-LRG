# 更新日志

CatGo 的所有重要变更都会记录在这里。格式遵循 [Keep a Changelog](https://keepachangelog.com/)。

## [1.0.1] - 2026-05-12

### Added

- **Agent-bridge sidecar** - Claude Agent SDK 聊天现在可在打包后的 Tauri 构建中工作。Node sidecar 进程（`catgo-agent`）会与 Python sidecar 一起打包，因此 CatBot 可以流式返回响应，不需要用户在本机额外安装 Node。
- **Linux installers** - 每个 release 都会发布面向 x86_64 的官方 `.AppImage` 和 `.deb` 产物。
- **MCP server endpoint** - `/api/mcp/` 现在可在 PyInstaller 构建中响应。外部工具可以通过 Model Context Protocol 驱动 CatGo。
- **Persistent user data via `~/.catgo/`** - 工作流数据库、面板状态和 agent 工作目录会在升级后保留。可通过 `CATGO_HOME` 环境变量覆盖路径。

### Fixed

- **Windows HPC connect** - 现在会正确打包 `pywin32` helper libraries（`pywintypes`/`pythoncom`），修复 Windows 打包安装中启动工作流引擎时的 `ImportError`。
- **AppImage DB path resolution** - 数据库不再写入只读的 AppImage mount；路径会自动回退到 `~/.catgo/`。
- **macOS sidecar discovery** - `catgo-server` sidecar 使用 bundle basename，修复签名 `.app` 包中的启动失败。
- **PyInstaller `/api/mcp/` 404** - 现在会把 `rfc3987_syntax` `.lark` grammar 文件收集进 bundle，恢复 MCP HTTP transport。
- **Claude SDK binary lookup in packaged builds** - `resolveClaudeExecutable()` 现在通过 `PATH` 解析 CLI，而不是 bun cache，消除 CatBot 启动时的 "native binary not found" 错误。

### Changed

- README citation 现在指向 ChemRxiv preprint，而不是 Zenodo。
- 所有 package 的项目 license metadata 从 `MIT` 修正为 `AGPL-3.0-or-later`，与仓库 `LICENSE` 保持一致。

## [Unreleased]

### Added

- Plugin system（Phase 0-2）- 服务端插件架构，支持生命周期管理、依赖解析、沙箱执行、SFTP fallback 和前端集成
- 从结构查看器导出 ABACUS 输入文件（INPUT、STRU、KPT）
- 通过 Open Babel 转换力场（GAFF、GAFF2、OPLS-AA），并提供 CLI fallback
- Bond drag-to-connect - 在两个原子之间点击拖拽即可创建键，并显示实时虚拟键预览
- Per-atom charge labels - 右键原子即可切换，支持拖动重定位和双击编辑数值
- 通过上下文菜单批量显示/隐藏所有电荷标签
- 为没有 Bader 数据的原子手动输入电荷值
- 当切换出 charge coloring mode 时，电荷标签自动隐藏；切回后重新显示
- Gaussian CUBE 文件可视化，支持等值面渲染和 2D 切片平面
- Materials Project API 集成，支持 band gap、energy 和 stability 数据
- 粘贴结构内容功能（Ctrl+Enter 导入）
- Vacuum Box 独立弹窗，并带 ghost toolbar buttons
- 用于非周期结构的 `wrap_molecule_in_box`
- Depth cueing（雾化效果）增强视觉深度感
- Bond editing mode，支持添加/删除键
- Atom drag UX：按住 Shift+Alt 可不先点击就拖动

### Changed

- 化学键上的 depth cueing 现在会向背景色淡出（VESTA-style），而不是只变暗
- 从控制面板移除 depth cueing slider（配置项仍可通过 config 使用）

### Fixed

- AtomLegend x toggle visibility 只能工作一次的问题（Svelte 5 `$derived.by()` Set tracking issue）
- CatGo Database sidebar 中的轨迹文件（xyz.gz、traj、h5）加载失败；现在会通过 `load_from_url` 正确处理二进制文件
- 降低键 hitbox 灵敏度，避免创建键时误选
- 修复键选择命中检测和删除
- 修复滚轮旋转、超胞对齐和上下文菜单错误
- 修复 slab cutter 中来自左手晶格的 Y 轴翻转
- 修复 slab cut 和超胞操作后的相机晶格对齐
- Slab 生成后强制右手晶格
- 修复按 Ctrl 键时 TrackballControls 相机 snap-back
- 测量线在原子拖动/旋转时跟随原子位置
- 旋转后化学键正确显示
- 原子操作期间防止相机重新居中
- 原子数量变化时清空 index-keyed maps，防止 snap-back
- 修复 slab cut 后的 pencil mode ghost 问题

---

## [0.3.2] - 2026-02-02

### Added

- WASM slab generation functions（`wasm_generate_slab`、`wasm_detect_layers`）
- Ferrox upstream sync，跟进最新 Rust crate 功能
- Bundled backend CI 支持

### Changed

- 原子拖动/旋转性能优化

### Fixed

- CI workflow 改进，并移除重复 release workflow
- 在 GitHub Actions 中标准化 pnpm 使用

---

## [0.3.1] - 2026-02-02

### Added

- Tauri 应用的桌面 landing page
- 用于添加原子的 pencil/draw mode，并带键预览
- 搜索弹窗中嵌入周期表

### Fixed

- Slab 切割产生 NaN 晶格参数
- Slab cut 后的原子标签和轴矢量
- 设置跨会话持久化

---

## [0.3.0] - 2026-02-01

### Added

- 桌面应用内置 Python 计算服务器
- Bundled backend 构建脚本（`pnpm bundle`）

### Fixed

- 移除不必要的 binaries 目录
- 移除 Tauri config 中不必要的 shell permissions

---

## [0.2.3] - 2026-02-01

### Added

- VASP 输入文件生成
- 吸附位点查找器（atop、bridge、hollow）
- OPTIMADE 数据库搜索集成
- PubChem 分子搜索集成
- MACE 和 EMT 计算器支持
- UFF 本地优化器（基于 WASM，无需服务器）
- 通过 WASM binding 生成 slab
- 分子导入和处理
- 超胞变换
- 多面板桌面布局
- ferrox-wasm 集成（键合、邻居列表、对称性）

### Fixed

- 面向桌面端的 TypeScript 和 Svelte CI 构建配置

---

## [0.1.17] - 2026-01-26

### Changed

- 项目重命名为 CatGo

### Added

- 工具栏中的导入文件按钮

---

## [0.1.15] - 2026-01-26

### Added

- 面向 Tauri 的文件导入和导出处理
- 桌面应用拖放支持
- 扩展 Tauri 文件权限

---

## [0.1.13] - 2026-01-26

### Added

- 初始桌面应用 release（Tauri 2.0）
- macOS bundle category 配置
- CLAUDE.md 项目说明

---

## 版本历史摘要

| 版本 | 日期 | 亮点 |
|---------|------|-----------|
| 0.3.2 | 2026-02-02 | WASM slab 函数、性能优化 |
| 0.3.1 | 2026-02-02 | 桌面 landing page、pencil mode、弹窗周期表 |
| 0.3.0 | 2026-02-01 | 桌面应用内置 Python 后端 |
| 0.2.3 | 2026-02-01 | 主要功能扩展（数据库搜索、优化、slab cutter） |
| 0.1.17 | 2026-01-26 | 重命名为 CatGo |
| 0.1.13 | 2026-01-26 | 初始桌面应用 release |

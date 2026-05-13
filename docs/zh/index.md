---
layout: home

hero:
  name: CatGo
  text: 计算材料与催化研究工作台
  tagline: 开源平台，集交互式可视化、结构构建、AI 辅助工作流自动化于一体，服务于计算材料科学与催化研究。提供桌面应用、VS Code 扩展、浏览器三种形态。
  image:
    src: /logo-light.svg
    alt: CatGo
  actions:
    - theme: brand
      text: 下载
      link: https://github.com/Hello-QM/catgo-LRG/releases/latest
    - theme: alt
      text: 快速上手
      link: /zh/guide/installation
    - theme: alt
      text: GitHub
      link: https://github.com/Hello-QM/catgo-LRG

features:
  - icon: "\U0001F52C"
    title: 交互式 3D 查看器
    details: 晶体、分子、表面、轨迹一体可视。Rust/WASM 键检测、moyo 对称性分析、周期镜像。支持 CIF、POSCAR、XYZ、EXTXYZ、MOL2、PDB、HDF5、CUBE、LAMMPS 等格式。
    link: /modules/core/structure-viewer
  - icon: "\U0001F9F1"
    title: 表面与结构构建
    details: Miller 指数切割平板、超胞、莫尔图案、纳米管、异质结构、吸附质放置、水层、氢钝化、掺杂取代。
    link: /modules/crystallography/surfaces-slabs
  - icon: "\U0001F916"
    title: CatBot AI 助手
    details: 内置聊天，支持 Claude / Gemini / Codex。自然语言驱动："从 MP 拿 Cu 切个 (100) 平板"、"用 MACE 优化这个结构"。工具调用直接驱动查看器。
    link: /zh/guide/catbot
  - icon: "⚙️"
    title: 多引擎计算
    details: 本地：EMT、xTB、MACE、CHGNet、M3GNet。工作流引擎集成：VASP、ORCA、Quantum ESPRESSO、CP2K、ABINIT、SIESTA、DFTB+、GPAW、Gaussian。
    link: /modules/dynamics/optimization
  - icon: "\U0001F310"
    title: HPC 工作流引擎
    details: DAG 工作流通过 SSH 向 SLURM/PBS 集群提交并监控作业。自动重试、文件暂存、中间结果缓存、POTCAR 生成。
    link: /modules/workflow/overview
  - icon: "\U0001F50D"
    title: 数据库集成
    details: 应用内直接搜索 Materials Project、OPTIMADE、PubChem。一键加载结构、编辑、提交计算。
    link: /modules/integrations/database-integration
---

## 快速链接

| 资源 | 描述 |
|------|------|
| [安装](/zh/guide/installation) | macOS、Windows、Linux 安装指南 |
| [CatBot AI](/zh/guide/catbot) | 对话驱动的计算工作流 |
| [模块参考](/modules/core/structure-viewer) | 完整模块 API 文档（英文） |
| [常见问题](/reference/faq) | 故障排查与常见问题（英文） |
| [更新日志](/reference/changelog) | 版本历史与发布说明（英文） |

## v1.0.1 新功能

- **Agent-bridge sidecar** — Claude SDK 聊天在打包构建中可用（无需单独安装 Node）
- **Linux 安装包** — 官方 `.AppImage` 与 `.deb` (x86_64)
- **Windows HPC 修复** — pywin32 依赖已正确打包
- **MCP 服务端点** — `/api/mcp/` 可供外部工具集成
- **AppImage 安全数据路径** — 用户数据持久化到 `~/.catgo/`

详见 [更新日志](/reference/changelog)。

## 由 UCSD 出品

CatGo 由加州大学圣地亚哥分校 [Wanlu Li 课题组](https://lab.li-research-group.com/) 开发。请引用 [`citation.cff`](https://github.com/Hello-QM/catgo-LRG/blob/main/citation.cff) 或 [ChemRxiv 预印本](https://github.com/Hello-QM/catgo-LRG/blob/main/readme.md#citation)。

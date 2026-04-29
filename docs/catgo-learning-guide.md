# CatGo 架构学习指南 —— 面试准备完全手册

> 目标读者：没有计算机背景，需要在面试中清晰讲述 CatGo 项目的架构和自己的工作
> 建议学习时间：通读 2-3 小时，精读 + 实操 1-2 天

---

## 目录

- [第一部分：你需要的背景知识](#第一部分你需要的背景知识)
- [第二部分：CatGo 是什么——一句话到一段话](#第二部分catgo-是什么一句话到一段话)
- [第三部分：整体架构——从最外层往里看](#第三部分整体架构从最外层往里看)
- [第四部分：前端架构详解](#第四部分前端架构详解)
- [第五部分：后端架构详解](#第五部分后端架构详解)
- [第六部分：六大核心子系统深入](#第六部分六大核心子系统深入)
- [第七部分：关键技术决策——面试高频问题](#第七部分关键技术决策面试高频问题)
- [第八部分：数据是怎么流动的——端到端场景](#第八部分数据是怎么流动的端到端场景)
- [第九部分：面试话术模板](#第九部分面试话术模板)
- [第十部分：术语速查表](#第十部分术语速查表)

---

# 第一部分：你需要的背景知识

> 面试不需要你把每个词都解释清楚，但你需要知道它们是什么、为什么用。
> 每个概念只需要理解到「能用自己的话说出来」的程度。

## 1.1 Web 开发基础概念

### 前端 vs 后端

```
你打开一个网站时发生了什么？

  浏览器（前端）                     服务器（后端）
  ┌──────────────┐                  ┌──────────────┐
  │ 你看到的一切  │ ── HTTP 请求 ──→ │ 数据库、计算  │
  │ 按钮、图表    │ ←── 数据返回 ─── │ 业务逻辑      │
  └──────────────┘                  └──────────────┘

  前端 = 用户能看到、能点的部分（运行在你的浏览器里）
  后端 = 处理数据、做计算的部分（运行在服务器上）
```

**面试说法**：「CatGo 采用前后端分离架构，前端用 Svelte 做交互和渲染，后端用 Python FastAPI 做科学计算。」

### HTML / CSS / JavaScript / TypeScript

- **HTML** = 网页的骨架（标题、段落、按钮的结构）
- **CSS** = 网页的皮肤（颜色、字体、布局）
- **JavaScript (JS)** = 网页的大脑（点击按钮时做什么事）
- **TypeScript (TS)** = JavaScript 的升级版，加了「类型检查」。类型检查就是：如果一个变量应该是数字，你不小心传了文字进去，编译器会提前报错，而不是等运行时才崩溃。CatGo 全部使用 TypeScript

**面试说法**：「我们用 TypeScript 做前端开发，它的类型系统在大型项目中能显著减少 bug。」

### 框架（Framework）

框架 = 别人写好的一套代码骨架，你在里面填内容。好比盖房子时，框架提供了钢筋混凝土结构，你只需要装修。

CatGo 用的前端框架是 **Svelte 5**。同类产品有 React（Meta 出品）、Vue（尤雨溪出品）。Svelte 的特点是编译时就把响应式逻辑生成好了，运行时更快、包更小。

### API（应用程序接口）

**API = Application Programming Interface = 应用程序编程接口。**

名字很唬人，本质极其简单：**两个程序之间约定好的「对话规则」。**

生活类比——你去银行柜台办业务：

```
  你（程序 A）          柜台窗口（API）          银行系统（程序 B）
  ┌──────────┐         ┌──────────┐           ┌──────────┐
  │ "我要查余额" │ ──→  │ 柜员接收   │  ──→     │ 数据库查询 │
  │            │ ←──  │ 柜员返回   │  ←──     │ 余额: ¥5000│
  └──────────┘         └──────────┘           └──────────┘
```

你不需要知道银行内部数据库怎么存的、用什么软件——你只需要知道**对柜台说什么话、能拿到什么结果**。这个「柜台窗口」就是 API。

在 CatGo 中，前端（浏览器界面）和后端（Python 计算服务）是两个独立的程序。它们之间怎么对话？靠 API：

```
具体例子：用户点了"优化结构"按钮

  前端说：POST /api/optimize/structure
          {"原子坐标": [...], "计算器": "mace"}

  后端回：{"优化后坐标": [...], "能量": -3.72}
```

- `POST` = 动作类型（"我要提交一个任务"）
- `/api/optimize/structure` = 地址（"去优化窗口"）
- `{...}` = 你给的数据和拿回的结果

为什么需要 API？因为前端和后端是**独立运行的两个程序**，可能不在同一台电脑上。它们之间不能直接调用对方的函数，只能通过网络传消息。API 就是这个消息格式的约定。

**REST API** 是其中一种约定风格：用 HTTP 的 GET（获取）/POST（创建）/PUT（更新）/DELETE（删除）方法 + URL 路径来组织。CatGo 后端定义了约 30 个这样的路径（`/api/dos/*`, `/api/bands/*`, `/api/workflow/*` 等），每个路径处理一类请求。

### WebSocket

HTTP 是"一问一答"：前端问，后端答，然后连接断开。
WebSocket 是"持续通话"：连接建立后，双方随时可以发消息。

CatGo 用 WebSocket 做两件事：

1. 结构优化实时进度推送（每一步优化完立刻通知前端）
2. 工作流执行监控（任务状态实时更新）

## 1.2 你需要知道的前端技术栈

### Svelte 5 和 Runes

Svelte 是 CatGo 的 UI 框架。Svelte 5 引入了 **Runes** 语法：

```javascript
// $state = 声明一个「响应式变量」，值变了界面自动更新
let count = $state(0)

// $derived = 声明一个「自动计算的值」，依赖变了它自动重算
let doubled = $derived(count * 2)

// $effect = 声明一个「副作用」，依赖变了自动执行
$effect(() => {
  console.log(`count 变成了 ${count}`)
})
```

**面试说法**：「Svelte 5 的 Runes 语法（$state, $derived, $effect）让响应式数据流非常清晰。比如用户改变了结构，$derived 自动重算化学键，$effect 自动触发重新渲染。」

**类比**：想象一个 Excel 表格。A1 是输入值（$state），B1 写了公式 `=A1*2`（$derived）。你改 A1，B1 自动变。这就是响应式。

### SvelteKit

SvelteKit = Svelte 的"全家桶"，帮你处理路由（不同页面之间的切换）、构建优化、静态站点生成等。CatGo 网页版用 SvelteKit，但桌面版不用（原因后面讲）。

### Three.js 和 Threlte

- **Three.js** = JavaScript 的 3D 渲染库。能在浏览器里画 3D 物体（原子、化学键、晶格）
- **Threlte** = Three.js 的 Svelte 封装。让你用 Svelte 组件的写法来写 3D 场景，而不是写一堆命令式代码

```html
<!-- Threlte 的写法：声明式，像写 HTML 一样写 3D -->
<T.Mesh position={[0, 1, 0]}>
  <T.SphereGeometry args={[0.5]} />
  <T.MeshStandardMaterial color="red" />
</T.Mesh>
```

### D3.js

D3 = Data-Driven Documents，最强大的 2D 数据可视化库。CatGo 用它画：

- 能带结构图（Band Structure）
- 相图（Phase Diagram）
- 散点图、柱状图等通用图表

### Vite

Vite = 前端构建工具。它做两件事：

1. **开发时**：启动一个本地服务器，你改代码后浏览器立刻更新（热更新）
2. **打包时**：把所有 TypeScript/Svelte 文件编译、压缩成浏览器能直接运行的 JS/CSS/HTML

CatGo 有两个 Vite 配置：

- `vite.config.ts` → 网页版（通过 SvelteKit）
- `vite.desktop.config.ts` → 桌面版（绕过 SvelteKit，直接 Vite 构建）

## 1.3 你需要知道的后端技术栈

### Python

CatGo 后端用 Python，因为材料科学的核心库都是 Python 的：

- **pymatgen** = Python Materials Genomics，处理晶体结构的核心库（切表面、找吸附位、对称性分析）
- **ASE** = Atomic Simulation Environment，管理原子模拟（优化器、计算器接口）

### FastAPI

FastAPI = Python 的 Web 框架，用来写后端 API。特点是快、自动生成 API 文档、支持异步。

```python
# 一个简单的 FastAPI 端点
@router.post("/api/optimize/structure")
async def optimize_structure(request: OptimizeRequest):
    atoms = build_atoms_from_request(request)  # 构建 ASE Atoms 对象
    optimizer = BFGS(atoms)                     # 创建优化器
    optimizer.run(fmax=0.05)                    # 运行优化
    return {"optimized_structure": atoms_to_dict(atoms)}
```

#### 什么是异步？

先理解**同步**——一件事做完，才能做下一件，排队干等：

```
你去奶茶店点单（同步模式）：

  点单 → 站在柜台等 → 奶茶做好了 → 拿走 → 才能去做别的事
         ▲
         这段时间你什么都干不了，干等着
```

再理解**异步**——等待的时候去做别的事，好了再回来拿结果：

```
你去奶茶店点单（异步模式）：

  点单 → 拿到取餐号 → 去旁边刷手机/买别的东西 → 叫号了 → 回来拿奶茶
                      ▲
                 等待期间你可以做别的
```

CatGo 后端是一个服务器，可能**同时**有多个请求进来：

```
同步服务器（一次只能服务一个人）：

  用户 A 请求优化（要 10 秒） → 服务器在算...
  用户 B 请求查 DOS            → 排队等着，A 没完我不动
  用户 C 请求看计算器列表       → 继续等...
  总时间：10 秒 + B 的时间 + C 的时间（串行）

异步服务器（FastAPI 的做法）：

  用户 A 请求优化（要 10 秒） → 交给后台算，我先不管
  用户 B 请求查 DOS            → 立刻处理，返回
  用户 C 请求看计算器列表       → 立刻处理，返回
  用户 A 的优化算完了           → 返回结果
  总时间：≈ 10 秒（并行）
```

**一句话总结**：同步 = 干等；异步 = 等的时候做别的事。FastAPI 支持异步，所以 CatGo 后端能同时处理多个请求，不会因为一个慢任务堵住其他人。

### conda 环境

#### 什么是"环境"？

假设你电脑上有两个 Python 项目：

```
项目 A（CatGo）：需要 numpy 1.24、pymatgen 2024 版
项目 B（别的）：  需要 numpy 1.19、pymatgen 2022 版
```

但你电脑上只能装**一个版本**的 numpy。装了 1.24，项目 B 就崩了；装了 1.19，项目 A 就崩了。这叫**「依赖冲突」**。

**环境 = 隔离的房间**，每个项目住在自己的房间里，互不干扰：

```
没有环境管理（所有项目共用一套库）：

  你的电脑
  ┌─────────────────────────┐
  │  numpy 1.24              │ ← 只能装一个版本
  │  项目 A ✅  项目 B ❌     │ ← 必然有一个崩
  └─────────────────────────┘

用 conda 环境（每个项目一个隔离房间）：

  你的电脑
  ┌────────────┐  ┌────────────┐
  │ 房间 "catgo" │  │ 房间 "other"│
  │ numpy 1.24  │  │ numpy 1.19  │
  │ pymatgen新版 │  │ pymatgen旧版 │
  │ 项目 A ✅    │  │ 项目 B ✅    │
  └────────────┘  └────────────┘
     互不影响          互不影响
```

**conda** 就是"房间管理员"：

```bash
conda create -n catgo python=3.11    # 建一个叫 catgo 的房间
conda activate catgo                  # 走进这个房间
pip install pymatgen ase mace-torch   # 在房间里装库（只影响这个房间）
conda deactivate                      # 走出房间
```

CatGo 后端需要安装很多科学库（pymatgen、ASE、MACE、CHGNet 等），用 conda 环境把它们隔离起来，不污染你电脑上其他 Python 项目。

## 1.4 你需要知道的其他技术

### WebAssembly (WASM)

浏览器原生只能运行 JavaScript。但 JS 做数值计算很慢。

**WASM** = 一种可以在浏览器里运行的二进制格式。可以把 C/C++/Rust 代码编译成 WASM，在浏览器里以接近原生的速度运行。

CatGo 把性能敏感的计算（化学键检测、超胞构建）用 Rust 写，编译成 WASM：

- 纯 JS 检测 1000 原子的键：冻结 3-15 秒
- Rust WASM 做同样的事：0.1-0.3 秒

### Web Worker

JavaScript 是单线程的——同一时间只能做一件事。如果一个计算需要 5 秒，界面就会冻结 5 秒。

**Web Worker** = 在后台开一个独立线程做计算，不影响界面。CatGo 把 WASM 计算放在 Worker 里，用户在计算过程中仍然可以旋转、缩放 3D 视图。

### Tauri

Tauri = 把网页应用打包成桌面应用的框架。类似 Electron（VS Code 就是用 Electron 做的），但更小更快：

| 对比 | Electron | Tauri |
|------|----------|-------|
| 打包大小 | ~150MB（内置 Chromium） | ~15MB（用系统浏览器引擎） |
| 后端语言 | Node.js | Rust |
| 内存占用 | 较高 | 较低 |

CatGo 选 Tauri 是因为科研软件用户不想装一个 150MB 的东西。

### MCP（Model Context Protocol）

#### 先理解问题：AI 很聪明，但它"没有手"

AI（如 Claude、GPT）能理解你说的话，能推理、能写代码。但它本身**做不了任何实际操作**——不能打开文件、不能修改数据库、不能操作 CatGo 里的结构。它只是一个"大脑"，没有"手"。

```
没有 MCP 的世界：

  你对 AI 说："帮我建一个 2x2x1 超胞"
  AI 回答：   "你可以这样做：点击 Build 菜单，选择 Supercell，输入 2,2,1..."
              （只能告诉你步骤，不能帮你做）
```

#### MCP = 给 AI 装上"手"

**MCP（Model Context Protocol）** 是 Anthropic（Claude 的公司）定义的一套标准协议。它的作用是：**让 AI 能调用外部软件的功能**。

```
有了 MCP 的世界：

  你对 AI 说："帮我建一个 2x2x1 超胞"
  AI 思考：   "我需要调用 catgo_supercell 工具"
  AI 执行：   catgo_supercell(na=2, nb=2, nc=1)  ← AI 真的动手了！
  CatGo：    超胞构建完成，3D 视图自动更新
  AI 回复：   "已经建好了 2x2x1 超胞，现在有 X 个原子。"
```

#### 类比：遥控器

```
  你（用户）     →  AI（大脑）      →  MCP（遥控器）     →  CatGo（电视机）
  "切到CCTV1"       "需要按频道1"       发送指令             画面切换
```

- **你**用自然语言说你想做什么
- **AI** 理解意图，决定按哪个"按钮"
- **MCP** 是遥控器的通信协议（红外/蓝牙），定义了"按钮"的格式
- **CatGo** 是电视机，接到指令后执行

#### 注意区分三个东西

MCP 不是功能表本身，它们是三个不同的角色：

```
┌──────────────────────────────────────────────────┐
│ TOOLS 列表（菜单）                                 │
│ 定义在 mcp_server.py 里的一个 Python 列表           │
│                                                    │
│   "catgo_add_atom"       → 添加原子                │
│   "catgo_supercell"      → 建超胞                  │
│   "catgo_generate_slab"  → 切表面                  │
│   ...共 61 项                                      │
│                                                    │
│ 这只是一份清单，它本身不做任何事                      │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ MCP 协议（点餐系统）                               │
│                                                    │
│   1. 规定了怎么把功能表发给 AI（"这是我的菜单"）     │
│   2. 规定了 AI 怎么下单（"我要 catgo_supercell"）   │
│   3. 规定了结果怎么回传（"超胞建好了，27 个原子"）   │
│                                                    │
│ 它是通信规则，不是功能本身                           │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│ handle_call_tool()（后厨）                         │
│                                                    │
│   真正干活的代码。收到 "catgo_supercell" 这个指令后  │
│   → 调用 FastAPI 后端                              │
│   → pymatgen 做计算                                │
│   → 把结果推回前端                                  │
└──────────────────────────────────────────────────┘
```

**一句话：TOOLS 列表是菜单，MCP 是点餐协议，handle_call_tool 是后厨。**

#### MCP 的工作机制

```
步骤 1：CatGo 启动时，注册自己有哪些"按钮"（工具）——即把菜单交给 AI

  CatGo 告诉 AI："我有这些工具可以用——"
    catgo_add_atom      → 添加原子
    catgo_delete_atoms   → 删除原子
    catgo_supercell      → 建超胞
    catgo_generate_slab  → 切表面
    catgo_optimize       → 优化结构
    ...共 61 个工具

  每个工具都有说明书：
  {
    "name": "catgo_supercell",
    "description": "Build a supercell by repeating the unit cell",
    "inputSchema": {
      "na": "integer, 在 a 方向重复几次",
      "nb": "integer, 在 b 方向重复几次",
      "nc": "integer, 在 c 方向重复几次"
    }
  }

步骤 2：用户说话，AI 决定调哪个工具

  用户："帮我在 Cu(111) 表面放一个 CO"
  AI 思考：这需要两步——先切表面，再放吸附物
  AI 决定：
    第一步 → catgo_generate_slab(miller_index=[1,1,1], ...)
    第二步 → catgo_adsorption_place(molecule="CO", site="ontop", ...)

步骤 3：MCP 协议传递调用请求

  AI → MCP 协议（标准 JSON 格式） → CatGo 的 mcp_server.py

步骤 4：CatGo 执行并返回结果

  mcp_server.py 收到请求
  → 转发给 FastAPI 后端：POST /api/build/slab
  → pymatgen 切好表面
  → 结果推送回前端 3D 视图
  → 返回文字结果给 AI："Created 3-layer Cu(111) slab with 27 atoms"

步骤 5：AI 用结果继续对话

  AI 回复用户："已经切好了 Cu(111) 三层表面，共 27 个原子，
               接下来我在 top 位放一个 CO 分子..."
```

#### CatGo 的 MCP 实现细节

MCP 服务器代码在 `server/mcp_server.py`（约 1940 行），注册了 **61 个工具**：

| 类别 | 工具数 | 例子 |
|------|--------|------|
| 结构操作 | 9 | 添加/删除/移动原子、超胞、合并 |
| 表面/晶格 | 3 | 设置晶格、切表面、建缺陷 |
| 构建工具 | 8 | 掺杂、取代、插层、水层、钝化 |
| 优化/能量 | 3 | 结构优化、单点能、计算器列表 |
| 吸附 | 2 | 找吸附位、放吸附物 |
| 纳米结构 | 5 | 纳米管、Moire、异质结 |
| 输入文件 | 8 | 生成 VASP/QE/LAMMPS/CP2K 等输入 |
| 电子结构分析 | 8 | DOS/能带/COHP 计算和查询 |
| MD 分析 | 9 | RDF、RMSD、氢键、聚类 |
| 数据库查询 | 4 | 从 Materials Project/PubChem 获取结构 |

有一个精巧的设计——**自动注入**：

```
问题：AI 调用 catgo_supercell 时，需要传"当前结构"作为参数。
      但 AI 并不知道当前 3D 视图里是什么结构。

解决：mcp_server.py 自动处理——
  1. 检测到请求中没有 structure 参数
  2. 自动调用 GET /view/structure/current 从前端获取当前结构
  3. 把结构注入到请求参数中
  4. 再转发给后端处理

  → AI 只需要说"建超胞"，不需要关心"当前是什么结构"
```

还有**自动推送**：

```
后端处理完后，mcp_server.py 自动把结果推回前端：
  1. POST /view/structure/push → 把新结构发给前端
  2. POST /pending-update → 通知前端"有更新了"
  3. 前端每 500ms 轮询一次 /pending-update → 发现有更新 → 拉取并渲染
```

#### MCP vs 前端 AI 聊天的区别

CatGo 有**两条** AI 执行路径，解决不同场景：

```
路径 A：前端 AI 聊天（CatGo 网页/桌面内的聊天框）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  浏览器 → 直接调 Anthropic API → AI 返回工具调用
  → 前端 JS/WASM 立即执行 → 画面更新（< 50ms）

  优点：快、不需要后端
  缺点：只能做前端支持的操作

路径 B：MCP（终端里的 AI agent）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  终端 AI（Claude Code / Gemini CLI）→ MCP 协议
  → mcp_server.py → FastAPI 后端 → pymatgen 处理
  → 结果推回前端

  优点：能做复杂晶体学运算（切表面/对称性分析等需要 pymatgen 的操作）
  缺点：需要后端运行、稍慢
```

**面试说法**：「CatGo 通过 MCP 协议将 61 个材料科学操作暴露给 AI agent。MCP server 实现了结构的自动注入和结果的自动推送机制——AI 不需要知道当前结构是什么，也不需要手动把结果推送到前端，这些都由协议层透明处理。」

### 插件系统

#### 什么是插件？

**插件 = 不修改主程序源代码，就能添加新功能的机制。**

类比：手机本体是主程序，App Store 里的 App 是插件。你不需要改手机的操作系统就能装新 App。

CatGo 的插件系统让用户可以添加自己的计算器、文件读取器、分析工具等。

#### 为什么需要插件系统？

没有插件系统时，想加一个新的计算器（比如用户自己训练的机器学习势），需要：

```
1. 打开 CatGo 源代码
2. 在 server/calculators/ 里加一个新文件
3. 在 server/calculators/base.py 的枚举里加一项
4. 在 server/routers/optimize.py 里加分支
5. 重新编译、部署

→ 普通科研用户根本做不到这些
```

有了插件系统：

```
1. 写一个 plugin.py 文件（继承 CalculatorPlugin，实现 get_calculator 方法）
2. 写一个 catgo-plugin.json（声明名字、版本、类型）
3. 把文件夹放到 plugins/ 目录
4. 重启 CatGo（甚至可以热加载）

→ 任何人都能扩展 CatGo
```

#### 当前状态 vs 远景规划

CatGo 的插件系统分 **7 个阶段**逐步建设。按照当前仓库实现，Phase 0-5 已经完成并落地，Phase 6 仍属于长期方向：

```
Phase 0 ✅ 已完成 ── Calculator 插件（修复断路）
Phase 1 ✅ 已完成 ── 统一 Reader 插件（文件读取器）
Phase 2 ✅ 已完成 ── Analyzer 插件（自定义分析工具）
Phase 3 ✅ 已完成 ── Workflow Node 插件（自定义工作流节点）
Phase 4 ✅ 已完成 ── MCP 动态工具注册
Phase 5 ✅ 已完成 ── 前端动态 UI 注册
Phase 6    远景中 ── AI 自动生成插件（Self-Extending Tools）
```

#### 当前的问题：6 种扩展机制各自为政

在统一插件系统之前，CatGo 有 6 种不同的扩展方式，全部是硬编码的：

```
1. Calculator（计算器）
   状态：插件框架已有，但 optimize.py 不调用它 → Phase 0 修复了这个断路

2. Analysis 工具（DOS/COHP 分析库）
   状态：用 sys.path.insert() 硬编码路径导入 → 加新格式需改 5+ 文件

3. 文件读取器（20+ 种格式）
   状态：前端 parse.ts 一个大 switch，后端分散在 4 个 router 里

4. Workflow 节点（50+ 种）
   状态：静态 dict + 静态 Set，不能动态添加

5. MCP 工具（61 个）
   状态：全部硬编码在一个 Python list 里

6. 前端 Analysis Tab（5 个）
   状态：写死在 AnalysisPane.svelte 的数组里
```

#### 目标架构：统一的插件系统

所有 6 种扩展都收归到同一个插件框架下：

```
plugins/                              ← 用户/AI 创建的插件目录
├── my-calculator/                    ← CalculatorPlugin (Phase 0 ✅)
│   ├── catgo-plugin.json             ← 身份证（统一 manifest 格式）
│   └── plugin.py                     ← 代码
├── cp2k-dos-reader/                  ← ReaderPlugin (Phase 1)
│   ├── catgo-plugin.json
│   └── plugin.py
├── bond-histogram/                   ← AnalyzerPlugin (Phase 2)
│   ├── catgo-plugin.json
│   └── plugin.py
└── lammps-workflow/                  ← WorkflowNodePlugin (Phase 3)
    ├── catgo-plugin.json
    └── plugin.py

系统自动：
  1. 扫描 plugins/ 目录，发现所有插件
  2. 根据类型注册到 PluginManager 的对应注册表
  3. 自动生成 REST API 端点
  4. 自动注册 MCP 工具（Phase 4）
  5. 通知前端动态渲染新 UI（Phase 5）
```

统一 **catgo-plugin.json** manifest 格式——一个插件可以同时贡献多种类型：

```json
{
  "name": "my-awesome-plugin",
  "version": "1.0.0",
  "description": "A multi-contribution plugin",
  "catgo": {
    "backend": {
      "main": "plugin.py",
      "contributions": {
        "calculators": [{ "id": "my_calc", "description": "..." }],
        "readers":     [{ "id": "cp2k_pdos", "formats": [".pdos"], "output_type": "electronic_dos" }],
        "analyzers":   [{ "id": "bond_hist", "output_type": "bar_plot" }],
        "workflow_nodes": [{ "type": "my_node", "definition": {...} }]
      }
    }
  }
}
```

#### output_type 路由表（核心设计思想）

插件声明自己输出什么类型的数据，系统**自动路由**到对应的可视化管线：

```
插件说："我输出 electronic_dos 类型的数据"
系统说："好的，我把你的数据送进 DOS 分析管线，用 Plotly 画出来"

插件说："我输出 bar_plot 类型的数据"
系统说："好的，我用 D3 BarPlot 组件渲染"
```

完整路由表：

| output_type | 含义 | 送到哪个前端组件 |
|-------------|------|----------------|
| `structure` | 晶体结构 | 3D Structure viewer |
| `electronic_dos` | 态密度 | DosPlot (Plotly) |
| `electronic_bands` | 能带 | BandPlot (Plotly) |
| `cohp` | COHP | CohpPlot (Plotly) |
| `trajectory` | MD 轨迹 | Trajectory player |
| `volumetric` | 体数据(电荷密度等) | Cube 等值面渲染 |
| `scatter_plot` | 散点图 | ScatterPlot (D3) |
| `bar_plot` | 柱状图 | BarPlot (D3) |
| `table` | 表格 | 通用表格组件 |
| `image` | 图片 | `<img>` 标签 |

**面试说法**：「插件不需要关心前端怎么渲染，只需要声明 output_type。系统根据 output_type 自动路由到对应的可视化管线。这实现了插件和 UI 的完全解耦。」

#### 各 Phase 的最终结构

**Phase 0（已完成）：Calculator 插件**

用户写一个计算器插件，结构如下：

```
plugins/lennard-jones-calculator/
├── catgo-plugin.json       ← 声明 calculator_id = "lennard_jones"
└── plugin.py               ← 继承 CalculatorPlugin，实现 get_calculator()
```

系统内部的调用链是统一的——不区分内置还是插件：

```
前端选择计算器 "lennard_jones"
  → POST /api/optimize/structure { calculator: "lennard_jones" }
  → get_calculator("lennard_jones")
      → 先查内置字典（EMT/MACE/CHGNet/xTB/M3GNet）
      → 没找到 → fallback 到 plugin_manager.get_calculator("lennard_jones")
      → 返回 ASE Calculator 实例
  → BFGS 优化器用这个 Calculator 跑优化
  → 返回结果
```

`/api/optimize/calculators` 端点同时列出内置 + 插件计算器，前端无需区分。

**Phase 1（已完成）：ReaderPlugin — 统一文件读取**

用户写一个文件读取插件：

```
plugins/cp2k-dos-reader/
├── catgo-plugin.json       ← 声明 formats=[".pdos"], output_type="electronic_dos"
└── plugin.py               ← 继承 ReaderPlugin，实现 read() 方法
```

统一上传端点自动路由：

```
用户上传 .pdos 文件
  → POST /api/plugins/readers/upload
  → PluginManager.find_reader_for_files([".pdos"])
      → 匹配到 cp2k_pdos reader（按扩展名 + 优先级）
  → reader.read(file_paths) → 返回 VaspData 兼容 dict
  → output_type = "electronic_dos" → 创建 DOS session
  → 前端用 DosPlot 渲染
```

现有的专用端点（`/api/dos/upload` 等）保持不变，新的统一端点并行存在。现有 reader（VASP h5、PROCAR、COHPCAR 等）也包装为内置 ReaderPlugin。

**Phase 2（已完成）：AnalyzerPlugin — 自定义分析工具**

```
plugins/bond-histogram/
├── catgo-plugin.json       ← 声明 output_type="bar_plot"
└── plugin.py               ← 继承 AnalyzerPlugin，实现 analyze(structure) → BarSeries 数据
```

分析结果根据 output_type 自动送到对应的绘图组件（D3 BarPlot / ScatterPlot / 表格等）。前端 AnalysisPane 动态注册新 tab。

**Phase 3（已完成）：WorkflowNodePlugin — 自定义工作流节点**

```
plugins/lammps-workflow/
├── catgo-plugin.json       ← 声明 NodeDefinition（输入/输出端口、参数 schema）
└── plugin.py               ← 继承 WorkflowNodePlugin，实现 execute(params, structure)
```

工作流编辑器自动显示新节点类型。WorkflowEngine 通过 plugin_manager 路由执行。

**Phase 4（已完成）：MCP 动态工具注册**

```
PluginManager 启动后，自动为每个插件生成 MCP 工具定义：
  插件 bond-histogram → MCP 工具 catgo_bond_histogram
  插件 cp2k-dos-reader → MCP 工具 catgo_upload_cp2k_pdos

AI agent 立刻能使用新安装的插件，无需手动更新 TOOLS 列表。
```

**Phase 5（已完成）：前端动态 UI**

```
后端通过 API 告诉前端"有哪些 reader/analyzer 可用"
  → GET /api/plugins/readers → 前端动态渲染文件上传按钮
  → GET /api/plugins/analyzers → 前端动态渲染 AnalysisPane tab
  → 无需改前端代码，装了插件就有对应 UI
```

**Phase 6（远景）：AI 自动生成插件（Self-Extending Tools）**

```
用户说："我想分析键长分布"
  → AI 发现没有现成工具
  → AI 自动生成 plugin.py + catgo-plugin.json
  → 安装到 plugins/ → PluginManager 热加载
  → 使用新工具完成分析
  → 下次同样需求直接复用

CatGo 变成一个"会自我进化的工具平台"。
```

**面试说法**：「插件系统分 7 个 Phase 渐进实施。核心设计是统一的 manifest + output_type 路由——插件只声明自己输出什么类型的数据，系统自动对接到对应的可视化管线。当前仓库里，Phase 0-5 已完成，已经覆盖计算器、Reader、Analyzer、Workflow Node、MCP 动态工具和前端动态 UI；Phase 6 仍是长期目标，即 AI 自动生成插件，让平台具备自扩展能力。」

---

# 第二部分：CatGo 是什么——一句话到一段话

## 一句话版本（电梯演讲）

> CatGo 是一个面向材料科学家的交互式可视化与计算工具包，支持网页、桌面、Jupyter、VSCode 四种部署形态，核心功能是 3D 晶体结构的可视化、编辑和计算分析。

## 一段话版本（面试开场）

> CatGo 是一个为材料科学和计算化学设计的全栈工具平台。它解决的核心问题是：科研人员需要一个统一的界面来**查看**晶体结构（3D 旋转缩放）、**编辑**结构（建超胞、切表面、掺杂）、**计算**性质（结构优化、能量计算）、**分析**结果（态密度、能带、COHP）、以及**编排**多步计算流程。
>
> 技术上，前端用 Svelte 5 + Three.js 做响应式 3D 渲染，性能敏感的计算用 Rust 编译成 WebAssembly 在浏览器内高速执行，后端用 Python FastAPI 调用 pymatgen/ASE 做晶体学运算。它可以部署为网页、Tauri 桌面应用、VSCode 扩展和 Jupyter 小组件，四种形态共享同一套核心代码。还集成了 AI 聊天功能，支持用自然语言驱动结构操作。

## 详细版本（面试深入追问时展开）

在下面各部分逐步展开。

---

# 第三部分：整体架构——从最外层往里看

## 3.1 四种部署形态

CatGo 的核心代码只有一套（`src/lib/` 里的组件库），但可以打包成四种不同的产品：

```
                     同一套核心组件库 (src/lib/)
                              │
          ┌───────────┬───────┴────────┬────────────┐
          ▼           ▼                ▼            ▼
    ┌──────────┐ ┌──────────┐  ┌────────────┐ ┌──────────┐
    │  网页版   │ │ 桌面版    │  │ VSCode 扩展 │ │ Jupyter  │
    │ SvelteKit │ │  Tauri   │  │            │ │  Widget  │
    │ + GitHub  │ │ + Python │  │ WebView    │ │ WebView  │
    │   Pages   │ │  后端    │  │            │ │          │
    └──────────┘ └──────────┘  └────────────┘ └──────────┘
       纯前端      前端+后端      纯前端嵌入      纯前端嵌入
```

**关键区别**：

- **网页版**：只有前端，不能跑计算（没有 Python 后端），但能查看结构、做前端支持的编辑
- **桌面版**：前端 + 后端都有，是功能最完整的版本。Tauri 负责"桌面壳"，Python 做计算
- **VSCode 扩展**：把前端嵌入 VSCode 的 WebView 面板里，双击 .cif 文件就能预览
- **Jupyter Widget**：把 3D 视图嵌入 Python 笔记本的输出区域

**面试话术**：「我们通过将核心组件库与部署层解耦，实现了一套代码四端复用。settings.ts 定义了统一的配置 schema，每个平台根据 context 字段决定哪些设置可见。」

## 3.2 整体分层

```
┌─────────────────────────────────────────────────────────────┐
│                      用户交互层                              │
│  鼠标/键盘/触摸 → Svelte 组件 → 响应式状态更新               │
├─────────────────────────────────────────────────────────────┤
│                      渲染层                                  │
│  Three.js (3D 原子/键/晶格) + D3 (2D 图表) + Plotly (分析图) │
├─────────────────────────────────────────────────────────────┤
│                      计算层（浏览器内）                       │
│  ferrox-wasm (Rust→WASM 键检测/超胞)                         │
│  moyo-wasm (对称性分析)                                      │
│  h5wasm (HDF5 文件读取)                                      │
│  Web Worker (后台线程执行)                                    │
├─────────────────────────────────────────────────────────────┤
│                      通信层                                  │
│  REST API (HTTP) + WebSocket (实时) + MCP (AI 工具)          │
├─────────────────────────────────────────────────────────────┤
│                      后端计算层（仅桌面版）                    │
│  FastAPI 服务器                                              │
│  ├── routers/ (30 个 API 路由)                               │
│  ├── calculators/ (MACE/CHGNet/EMT/xTB)                     │
│  ├── plugins/ (插件管理器)                                    │
│  └── utils/workflow_engine.py (工作流引擎)                    │
├─────────────────────────────────────────────────────────────┤
│                      科学计算库层                             │
│  pymatgen (晶体学) + ASE (原子模拟) + numpy (数值计算)        │
│  MACE/CHGNet (ML 势函数) + xTB (半经验方法)                  │
└─────────────────────────────────────────────────────────────┘
```

## 3.3 文件目录与职责

```
CatGo/
│
├── src/                          ← 前端源代码
│   ├── lib/                      ←   核心组件库（这是整个项目的心脏）
│   │   ├── structure/            ←   [最大模块] 3D 结构查看器
│   │   ├── electronic/           ←   电子结构分析（DOS/能带/COHP）
│   │   ├── workflow/             ←   工作流 DAG 编辑器
│   │   ├── chat/                 ←   AI 聊天 + 工具执行系统
│   │   ├── plot/                 ←   D3 通用绘图组件
│   │   ├── api/                  ←   前端调后端的 HTTP 客户端
│   │   ├── element/              ←   元素数据 + 周期表
│   │   ├── trajectory/           ←   MD 轨迹播放器
│   │   ├── symmetry/             ←   对称性分析（moyo-wasm）
│   │   ├── xrd/                  ←   X 射线衍射
│   │   ├── periodic-table/       ←   交互式周期表
│   │   ├── phase-diagram/        ←   相图
│   │   ├── settings.ts           ←   [关键] 全平台统一设置 schema
│   │   └── state.svelte.ts       ←   全局响应式状态
│   │
│   └── routes/                   ←   SvelteKit 页面路由（网页版）
│
├── server/                       ← Python 后端（仅桌面版需要）
│   ├── main.py                   ←   FastAPI 入口 + 启动流程
│   ├── mcp_server.py             ←   MCP 工具服务器（61 个工具）
│   ├── routers/                  ←   30 个 API 路由模块
│   ├── calculators/              ←   内置计算器（MACE/CHGNet/EMT/xTB）
│   ├── plugins/                  ←   插件框架
│   ├── models/                   ←   Pydantic 数据模型
│   └── utils/                    ←   工作流引擎等工具
│
├── extensions/                   ← 扩展模块
│   ├── rust/ + rust-wasm/        ←   Rust → WASM 高性能计算（ferrox）
│   ├── dos-analysis/             ←   DOS 分析 Python 包
│   ├── cohp-analysis/            ←   COHP 分析 Python 包
│   ├── vscode/                   ←   VSCode 扩展
│   ├── uff-relax/                ←   UFF 力场松弛
│   └── vsepr-rs/                 ←   VSEPR 几何预测
│
├── src-tauri/                    ← Tauri 桌面后端（Rust）
├── desktop/                      ← 桌面版前端入口
├── plugins/                      ← 用户安装的插件目录
└── tests/                        ← 测试
    ├── vitest/                   ←   单元测试
    └── playwright/               ←   端到端测试
```

---

# 第四部分：前端架构详解

## 4.1 核心：Structure 模块

Structure 是 CatGo 最核心、最大的模块。理解了它就理解了 CatGo 的 50%。

### 文件职责

```
src/lib/structure/
├── Structure.svelte          ← 主控制器（~9100 行）
│                                全部响应式状态 ($state/$derived/$effect)
│                                编排所有子组件、处理用户操作
│
├── StructureScene.svelte     ← 3D 场景（~3300 行）
│                                Three.js 相机、灯光、渲染循环
│                                处理鼠标交互（选择、拖拽、旋转）
│
├── AtomImpostors.svelte      ← 原子渲染（GPU impostor 技术）
├── Bond.svelte               ← 化学键渲染（InstancedMesh）
│
├── bonding.ts                ← JS 化学键检测算法
├── ferrox-wasm.ts            ← WASM 桥接层（调用 Rust 代码）
├── supercell.ts              ← 超胞构建（TS 实现）
├── pbc.ts                    ← 周期性边界条件（PBC）镜像原子
├── parse.ts                  ← 文件格式解析（CIF/POSCAR/XYZ...）
├── atom-properties.ts        ← 原子属性着色（元素/配位数/Wyckoff）
│
├── controllers/              ← 控制器（拆分自 Structure.svelte 的逻辑）
└── workers/                  ← Web Worker 后台计算
    └── bonding-worker.ts     ← 在 Worker 线程中运行 WASM 键检测
```

### 数据流：用户打开一个 CIF 文件时发生了什么？

```
1. 用户拖拽 .cif 文件到浏览器
       │
2. parse.ts 解析文件
   → 提取晶格参数（a,b,c,α,β,γ）、原子坐标、元素类型
   → 生成 Structure 数据对象
       │
3. Structure.svelte 接收数据，触发响应式链
   │
   ├──→ $derived: atom_data        → 计算每个原子的位置、颜色、半径
   ├──→ $derived: bond_data        → 检测化学键（触发 WASM Worker）
   ├──→ $derived: lattice_vectors  → 计算晶格线段端点
   └──→ $derived: property_colors  → 根据着色模式计算颜色
       │
4. StructureScene.svelte 渲染
   │
   ├──→ AtomImpostors: 用 GPU impostor 画原子
   ├──→ Bond: 用 InstancedMesh 画化学键
   └──→ Lattice lines: 画晶格边框
       │
5. 用户看到 3D 结构，可以旋转/缩放/选择原子
```

### 响应式链（Reactive Chain）

这是 CatGo 前端最核心的设计模式。用 $state 和 $derived 构建一条数据依赖链：

```
用户输入的结构 ($state)
    │
    ├──→ atom_data ($derived)  ──→  AtomImpostors 渲染
    │
    ├──→ bond_data ($derived)  ──→  Bond 渲染
    │       │
    │       └── 三级回退: Worker WASM → 主线程 WASM → JS
    │
    ├──→ supercell ($derived)  ──→  超胞结构
    │
    └──→ property_colors ($derived)  ──→  着色
            │
            └── 依赖 base structure，NOT 超胞
```

**面试说法**：「Structure.svelte 是整个前端的核心编排器。它管理了所有的响应式状态，通过 Svelte 5 的 $state/$derived/$effect 构建了一条清晰的数据依赖链。任何输入变化都会沿着依赖链自动传播到渲染层。」

## 4.2 渲染技术：GPU Impostor

这是 CatGo 的一个重要技术亮点。

**问题**：普通 3D 软件画一个球需要很多三角面片。1000 个原子 = 几十万个三角面片 = 卡。

**CatGo 的解法**：

```
传统方法：每个原子 = SphereGeometry（数百个三角面）→ 慢
CatGo：   每个原子 = 一个平面 + 自定义着色器                → 快

着色器在 GPU 上对每个像素计算：
  1. 这个像素离球心多远？（数学公式）
  2. 如果在球的范围内 → 计算光照，画出来
  3. 如果在球的范围外 → 丢弃（透明）

结果：视觉上是完美的球体，但几何复杂度 = 每原子一个平面 = O(1)
```

**面试说法**：「我们用 GPU impostor 技术渲染原子。不画实际的球体几何，而是在着色器里做光线-球面求交。这样每个原子只需要一个四边形面片，渲染 10000 个原子也很流畅。」

**化学键渲染**：使用 Three.js 的 **InstancedMesh**——所有键共享一个圆柱模板，GPU 在每个实例上应用不同的位置/旋转/缩放。N 个键只需要 1 次 draw call。

## 4.3 电子结构分析模块

```
src/lib/electronic/
├── DosAnalysisPane.svelte    ← 态密度（DOS）分析界面
├── DosPlot.svelte            ← 态密度绘图（Plotly）
├── BandAnalysisPane.svelte   ← 能带分析界面
├── BandPlot.svelte           ← 能带绘图
├── CohpAnalysisPane.svelte   ← COHP 分析界面
├── CohpPlot.svelte           ← COHP 绘图
└── types.ts                  ← 所有类型定义
```

**工作流程**（以 DOS 为例）：

```
1. 用户上传 vaspout.h5 文件
2. 前端 POST /api/dos/upload → 后端用 catgo_dos 库解析
3. 后端返回 session_id + 元数据（元素列表、原子数等）
4. 用户选择分组（按元素、按层、按自定义索引）
5. 前端 POST /api/dos/compute → 后端计算 PDOS
6. 前端用 Plotly 渲染结果
```

这里有一个重要的设计模式：**会话（Session）机制**。

上传的大文件（几百 MB 的 vaspout.h5）缓存在后端内存里，给一个 session_id。后续的计算请求只传 session_id + 参数，不重新上传文件。会话 30 分钟过期自动清理。

## 4.4 工作流编辑器

```
src/lib/workflow/
├── WorkflowEditor.svelte      ← SVG DAG 编辑器（拖拽/连线/框选/撤销）
├── node-definitions.ts        ← 50+ 种节点定义
├── workflow-types.ts          ← 类型定义
└── workflow-state.svelte.ts   ← 工作流状态管理
```

这是一个可视化的**有向无环图（DAG）编辑器**。用户拖拽节点、用线连接、设置参数：

```
[结构输入] ──→ [几何优化(VASP)] ──→ [静态计算] ──→ [DOS 分析]
                    │
                    └──→ [切表面] ──→ [放吸附物] ──→ [优化] ──→ [吸附能]
```

每个节点有固定的类型定义（`NodeDefinition`），包括输入/输出端口、参数 schema、所属分类。前端负责编辑，执行由后端的 `WorkflowEngine` 负责。

## 4.5 AI 聊天系统

```
src/lib/chat/
├── chat-state.svelte.ts           ← 聊天状态 + 消息发送
├── llm-client.ts                  ← LLM API 客户端（SSE 流式）
├── tools.ts                       ← 12 个 viewer 工具定义
├── structure-tools.ts             ← 37 个结构操作工具定义
├── workflow-tools.ts              ← 14 个工作流工具定义
├── structure-tool-executor.ts     ← 结构工具执行器
├── workflow-tool-executor.ts      ← 工作流工具执行器
└── analysis-session-store.svelte.ts ← 分析会话注册表
```

核心概念：**Tool Use**（工具调用）

AI 不是直接操作 CatGo，而是通过调用「工具」来间接操作。

```
用户说："帮我建一个 2x2x1 的超胞"

AI 思考 → 决定调用工具：
{
  "name": "catgo_supercell",
  "input": { "nx": 2, "ny": 2, "nz": 1 }
}

前端执行器接收到 → 调用 Structure.svelte 的 handler → WASM 构建超胞
→ 结构更新 → 3D 视图自动刷新
```

**两条执行路径**：

| | 路径 A：浏览器内 AI | 路径 B：CLI Agent（MCP） |
|---|---|---|
| 入口 | 网页内聊天框 | 终端（Claude Code / Gemini CLI） |
| AI 在哪运行 | 浏览器直调 Anthropic API | 终端里的 AI agent |
| 工具在哪执行 | 前端 JS/WASM | 后端 Python（pymatgen） |
| 速度 | 快（< 50ms） | 较慢（网络 + 后端计算） |
| 需要后端？ | 不需要 | 需要 |

---

# 第五部分：后端架构详解

## 5.1 FastAPI 服务器

后端是一个 FastAPI 应用，启动流程：

```python
# server/main.py 简化版

# 1. 计算端口号（支持多个开发实例同时运行）
SERVER_PORT = 8000 + worktree_offset()

# 2. 创建 FastAPI 应用
app = FastAPI()

# 3. 启动时初始化
async def lifespan(app):
    await plugin_manager.initialize()    # 扫描插件目录
    ensure_all_mcp_configs()             # 注册 MCP 配置
    yield                                # 运行中...
    # 关闭时清理

# 4. 注册 ~30 个路由模块
app.include_router(optimize_router)      # /api/optimize/*
app.include_router(dos_router)           # /api/dos/*
app.include_router(workflow_router)      # /api/workflow/*
app.include_router(plugins_router)       # /api/plugins/*
# ...更多路由
```

## 5.2 API 路由一览

后端提供约 30 个路由模块，按功能分组：

| 分组 | 路由 | 做什么 |
|------|------|--------|
| **结构优化** | `/api/optimize/*` | BFGS/Sella 优化、单点能计算 |
| **电子结构** | `/api/dos/*`, `/api/bands/*`, `/api/cohp/*` | DOS/能带/COHP 分析 |
| **结构操作** | `/api/structure/*`, `/api/build/*` | 掺杂、缺陷、应变等 |
| **表面/吸附** | `/api/adsorption/*` | 找吸附位、放吸附物 |
| **纳米结构** | `/api/moire/*`, `/api/nanotube/*`, `/api/heterostructure/*` | Moire、纳米管、异质结 |
| **输入文件** | `/api/vasp/*`, `/api/cp2k/*`, `/api/orca/*`, `/api/lammps/*` | 生成各种软件的输入文件 |
| **工作流** | `/api/workflow/*` | 工作流 CRUD + 执行 |
| **MD 分析** | `/api/md/*` | RDF、RMSD、氢键、聚类等 |
| **插件** | `/api/plugins/*` | 插件安装/卸载/启用/禁用 |
| **HPC** | `/api/hpc/*` | 超算任务提交和监控 |
| **聊天** | `/api/chat/*` | AI 聊天代理管理 |

## 5.3 内置计算器

```
server/calculators/
├── base.py        ← 基类：get_calculator(name) 工厂函数
├── mace.py        ← MACE（机器学习原子间势）
├── chgnet.py      ← CHGNet（另一个 ML 势）
├── emt.py         ← EMT（有效介质理论，仅金属）
├── m3gnet.py      ← M3GNet（又一个 ML 势）
├── xtb.py         ← xTB（半经验量子化学）
└── xtb_cli.py     ← xTB 命令行版本
```

每个计算器都遵循 ASE 的 `Calculator` 接口：给一组原子坐标，返回能量和力。

**面试说法**：「内置计算器采用策略模式（Strategy Pattern），统一实现 ASE Calculator 接口。用户选择不同计算器（MACE、CHGNet、EMT），调用代码完全一致，只是底层模型不同。」

## 5.4 插件系统

这是你参与的核心工作之一。

### 架构

```
server/plugins/
├── base.py          ← 抽象基类 + 类型枚举
│     BasePlugin          → 所有插件的父类
│     CalculatorPlugin    → 计算器插件（提供 get_calculator()）
│     OptimizerPlugin     → 优化器插件（提供 get_optimizer()）
│     PluginType          → 枚举：CALCULATOR | OPTIMIZER | ROUTER
│
├── discovery.py     ← 插件发现
│     discover_plugins()       → 扫描目录找插件
│     load_plugin_from_path()  → 加载单个插件
│
├── manager.py       ← 插件管理器（单例模式）
│     PluginManager.initialize()     → 启动时扫描加载
│     PluginManager.get_calculator() → 获取计算器实例
│     PluginManager.install_plugin() → 安装新插件
│
└── __init__.py      ← 导出 + 全局单例 plugin_manager
```

### 插件生命周期

```
1. 用户把插件文件夹放到 plugins/ 目录
       │
2. 服务器启动 → plugin_manager.initialize()
       │
3. discovery.py 扫描 plugins/ 下每个子目录
   ├── 找到 catgo-plugin.json？→ 读 manifest，找到入口文件
   └── 没有 manifest？→ 找 plugin.py，扫描 BasePlugin 子类
       │
4. 动态 import 模块 → 找到插件类 → validate() 校验 → 实例化
       │
5. 注册到 manager：
   ├── CalculatorPlugin → _calculator_plugins[calc_id] = plugin
   └── OptimizerPlugin → _optimizer_plugins[opt_id] = plugin
       │
6. API 端点可用：
   GET  /api/plugins/             → 列出所有插件
   GET  /api/plugins/calculators  → 列出所有计算器
   POST /api/plugins/{name}/enable → 启用
   POST /api/plugins/{name}/disable → 禁用
```

### 插件目录搜索顺序

```python
# discovery.py: get_plugins_directory()
# 按优先级从高到低：
1. 项目根目录/plugins/      ← 开发时用
2. server/plugins/           ← 备选
3. ~/.catgo/plugins/         ← 用户全局安装
```

### 面试重点：你做了什么？

> Phase 0：修复了计算器插件在优化 API 中的断路（circuit break）问题。
>
> 问题：`/api/optimize/structure` 端点使用的是 `calculators.get_calculator()`（内置计算器），完全绕过了 `plugin_manager`。用户安装的插件计算器无法在优化流程中使用。
>
> 解决方案：修改了 4 个文件——
>
> 1. `models/structure.py`：在请求模型中添加 `calculator_params` 字段
> 2. `calculators/base.py`：`get_calculator()` 增加 fallback 到 `plugin_manager`
> 3. `routers/optimize.py`：传递 `calculator_params` 到计算器工厂
> 4. 对应的 WebSocket 路由同步修改
>
> 这样内置计算器和插件计算器走同一条路径，对上层透明。

## 5.5 MCP 工具服务器

```
server/mcp_server.py（~1940 行）
│
├── TOOLS 列表：61 个工具定义
│   每个工具 = { name, description, endpoint, method, inputSchema }
│
├── handle_call_tool()：工具分发器
│   ├── 普通工具 → HTTP 转发到 FastAPI
│   └── 特殊工具 → _handle_special_tool()
│
├── 自动注入机制：
│   _get_current_structure()  → 从前端获取当前结构
│   → 自动填充到缺少 structure 参数的工具调用中
│   → AI 不需要知道当前结构是什么，系统自动提供
│
└── 结果推送：
    _push_structure_to_viewer() → 把操作后的结构推回前端
    → 前端每 500ms 轮询 /pending-update
```

**面试说法**：「MCP server 是 AI agent 和 CatGo 之间的桥梁。它实现了结构的自动注入和结果的自动推送，让 AI 只需要关注"做什么操作"，不需要手动传递结构数据。」

## 5.6 工作流引擎

```
server/utils/workflow_engine.py

核心功能：把前端编辑的 DAG 图转化为实际可执行的计算任务

关键设计：_resolve_software()
  → 统一节点类型 + 用户选择的软件 → 路由到具体实现
  → ("geo_opt", "vasp")  → "vasp_relax"
  → ("geo_opt", "cp2k")  → "cp2k_geopt"
  → ("geo_opt", "orca")  → "orca_opt"
  → 支持 9 种计算引擎：VASP/CP2K/ORCA/Gaussian/LAMMPS/GROMACS/xTB/Sella/MLP
```

---

# 第六部分：六大核心子系统深入

## 子系统 1：WASM 计算系统

### 为什么需要 WASM？

| 任务 | 纯 JavaScript | Rust WASM | 加速比 |
|------|--------------|-----------|--------|
| 1000 原子键检测 | 3-15 秒 | 0.1-0.3 秒 | 10-50x |
| 超胞构建 | ~1 秒 | ~50ms | ~20x |
| 邻居列表 | ~2 秒 | ~100ms | ~20x |

### 三级回退策略

```
尝试 1: Worker WASM（后台线程 + Rust 速度）
  成功 → 用这个（最优方案）
  失败 → CSP 限制 / 移动端 Safari / Jupyter 环境不支持 Worker

尝试 2: 主线程 WASM（Rust 速度但阻塞 UI）
  成功 → 用这个（用户体验略差，大结构会卡一下）
  失败 → .wasm 文件加载失败

尝试 3: 纯 JavaScript（最慢但永远可用）
  永远成功 → 保底方案
```

**设计思想**：「优雅降级」（Graceful Degradation）。在最优方案不可用时，自动退回到次优方案，而不是直接报错。

### ferrox-wasm（自研 Rust 模块）

```
extensions/rust/src/
├── bonding.rs        ← 键检测算法（electroneg_ratio, solid_angle）
├── supercell.rs      ← 超胞构建
├── neighbor.rs       ← 邻居列表
├── wasm.rs           ← WASM 接口层
└── lib.rs            ← 入口

编译命令：
wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm
→ 输出到 extensions/rust-wasm/pkg/
→ 前端通过 @catgo/ferrox-wasm 包引用
```

## 子系统 2：Settings 系统

### 单一数据源（Single Source of Truth）

`src/lib/settings.ts` 是整个项目的设置中心。所有可配置项都在这里定义：

```typescript
export interface SettingType<T> {
  value: T              // 默认值
  description: string   // 描述文字
  enum?: Record<...>    // 可选值列表
  minimum?: number      // 最小值
  maximum?: number      // 最大值
  context?: 'web' | 'editor' | 'notebook' | 'all'  // 哪个平台可见
}
```

四个平台（网页/桌面/VSCode/Jupyter）都读同一份 schema。`context` 字段控制可见性：某些设置只在编辑器里显示，某些只在网页版显示。

**面试说法**：「设置系统采用 schema-driven 设计，settings.ts 是单一数据源。每个设置项自带类型约束、范围限制、平台过滤和描述文本，保证四个平台的行为一致。」

## 子系统 3：文件解析系统

CatGo 能读 20+ 种文件格式：

```
CIF      → 晶体信息文件（最常用）
POSCAR   → VASP 坐标文件
XYZ      → 简单坐标格式
extXYZ   → 扩展 XYZ（带晶格和属性）
JSON     → pymatgen dict 格式
PDB      → 蛋白质数据银行格式
CUBE     → 高斯 cube（体积数据）
HDF5     → VASP 6 输出（vaspout.h5）
COHPCAR  → LOBSTER COHP 数据
ICOHPLIST → LOBSTER ICOHP 数据
vasprun.xml → VASP 运行日志
...
```

解析代码分布在两处：

- 前端 `parse.ts`：纯 TS 解析（CIF/POSCAR/XYZ 等文本格式）
- 后端 `extensions/`：Python 解析（HDF5/vasprun.xml 等二进制/复杂格式）

## 子系统 4：AI 工具执行系统

### 工具总览

| 位置 | 工具数 | 类型 | 执行环境 |
|------|--------|------|---------|
| `tools.ts` | 12 | Viewer 控制 | 前端 |
| `structure-tools.ts` | 37 | 结构操作 | 前端 |
| `workflow-tools.ts` | 14 | 工作流管理 | 前端 |
| `mcp_server.py` | 61 | 全功能 | 后端 |

### Register/Execute 模式

```typescript
// Structure.svelte 挂载时
onMount(() => {
  register_structure_action_handler(my_handler)
})

// 聊天系统需要执行工具时
if (is_structure_tool(tool_name)) {
  result = await execute_structure_tool(tool_name, tool_input)
  // → 委托给 Structure.svelte 的 handler
}
```

这个模式解决了一个关键问题：聊天模块 (`chat/`) 和结构模块 (`structure/`) 是独立的，聊天模块不直接依赖结构模块。通过注册-执行模式，实现了松耦合。

## 子系统 5：分析会话系统

```
AnalysisSession = {
  type: 'dos' | 'bands' | 'cohp' | 'md'
  session_id: string     ← 后端缓存的 key
  label: string          ← 显示名称
  meta: {}               ← 元数据
}

设计规则：每种类型同时只有一个活跃 session
  → register_analysis_session()   注册
  → unregister_analysis_session() 注销
  → get_analysis_session()        查询

大数据存储：blob store
  → 分析数据可能很大（几十 MB），不放在 Svelte 响应式系统里
  → 单独的 store_session_blob() / get_session_blob()
  → 避免 Svelte proxy 的性能开销
```

## 子系统 6：构建系统（Build System）

CatGo 有两套构建配置：

```
网页版构建（SvelteKit）：
  vite.config.ts → SvelteKit adapter-static → build/ 目录
  → 生成纯静态网站，可部署到 GitHub Pages
  → 命令：pnpm build

桌面版构建（独立 Vite）：
  vite.desktop.config.ts → 直接 Vite 构建 → build-desktop/ 目录
  → 不走 SvelteKit 的路由/SSR
  → 用 mock 替代 $app/* 模块
  → 命令：pnpm desktop:build

为什么分开？
  → Tauri 需要一个纯静态的 HTML+JS+CSS 文件夹
  → SvelteKit 的路由机制在 Tauri WebView 里不需要
  → 桌面版用 $app/* 模块会报错，需要 mock
```

---

# 第七部分：关键技术决策——面试高频问题

## Q1: 为什么选 Svelte 而不是 React？

**回答框架**：

> Svelte 5 的优势在三个方面：
>
> 1. **包大小**：Svelte 编译时生成精确的 DOM 更新代码，不需要运行时的虚拟 DOM 库。React 的 runtime 约 40KB gzipped，Svelte 几乎为零
> 2. **性能**：科学可视化有大量实时更新（拖拽原子、旋转视图），Svelte 没有虚拟 DOM diff 的开销，直接更新真实 DOM
> 3. **响应式清晰度**：Svelte 5 的 Runes 语法（$state/$derived/$effect）让数据流非常显式，适合 Structure.svelte 这样复杂的状态管理
>
> 权衡：Svelte 生态不如 React 成熟，第三方库少一些，但对这个项目来说不是关键瓶颈。

## Q2: 为什么选 Tauri 而不是 Electron？

> 1. **包大小**：CatGo 桌面版 ~15MB，Electron 版本会 ~150MB。科研用户经常在 HPC 上下载，小体积很重要
> 2. **内存占用**：Tauri 用系统 WebView（macOS 的 WebKit、Windows 的 WebView2），不额外打包 Chromium
> 3. **Rust 后端**：Tauri 的 Rust 后端为未来做计算密集型功能（本地 ML 推理）留了空间
>
> 权衡：Tauri 生态不如 Electron 成熟，跨平台 WebView 行为差异比 Chromium 更多，开发和调试稍复杂。

## Q3: 为什么用 Rust 写 WASM 而不是用 C++ 或直接优化 JS？

> 1. **安全性**：Rust 的所有权系统保证内存安全，WASM 模块不会段错误
> 2. **wasm-pack 生态**：Rust → WASM 的工具链最成熟
> 3. **性能**：与 C++ 编译到 WASM 相当，但开发体验更好
> 4. **与 Tauri 协同**：Tauri 后端也是 Rust，团队统一技术栈
>
> 为什么不优化 JS？`solid_angle` 键检测涉及大量浮点数值计算和嵌套循环，JS 引擎优化有天花板（JIT 对这类计算不如 AOT）。

## Q4: 9100 行的 Structure.svelte 为什么不拆分？

> 这是有意识的技术债。目前没拆分的原因：
>
> 1. 响应式链高度耦合：文件内 20+ 个 $derived 变量相互依赖，拆分需要仔细设计跨组件通信
> 2. 性能考虑：Svelte 组件边界会引入额外的更新检查
> 3. 优先级：功能开发优先于重构
>
> 我们已经开始拆分：`controllers/` 目录存放从主文件抽取的逻辑模块。计划进一步拆分 build tools、analysis panes、settings panels。

## Q5: 三级回退策略的设计思想是什么？

> 核心原则是**优雅降级**（Graceful Degradation）：
>
> - 最佳方案（Worker WASM）在某些环境不可用（CSP 策略限制、移动端浏览器、Jupyter iframe 沙箱）
> - 次优方案（主线程 WASM）在 .wasm 文件无法加载时不可用
> - 保底方案（纯 JS）永远可用
>
> 关键：**静默回退**——用户不需要知道底层用的是哪一层。错误被 $derived 中的 try-catch 捕获，自动降级，不中断用户操作。

## Q6: 插件系统的设计考量？

> 设计目标：让用户不修改 CatGo 源码就能添加新的计算器或优化器。
>
> 技术方案：
>
> 1. **抽象基类**（Abstract Base Class）：定义 `CalculatorPlugin`、`OptimizerPlugin` 接口
> 2. **自动发现**：启动时扫描 `plugins/` 目录，动态 import Python 模块
> 3. **Manifest 驱动**：`catgo-plugin.json` 声明插件元数据，不需要修改注册表
> 4. **单例管理器**：`PluginManager` 统一管理生命周期（加载/卸载/启用/禁用）
>
> 当前状态：后端计算器/优化器插件已完成，前端插件（自定义 UI 面板）是概念阶段。

## Q7: 前端 AI 聊天和后端 MCP 有什么区别？

> 两条互补路径解决不同场景：
>
> | | 前端 AI 聊天 | 后端 MCP |
> |---|---|---|
> | 用户在哪操作 | CatGo 网页/桌面内的聊天框 | 终端（Claude Code / Gemini CLI） |
> | 工具在哪执行 | 浏览器内（JS/WASM） | 服务器（Python/pymatgen） |
> | 能力范围 | 63 个前端工具 | 61 个后端工具 |
> | 延迟 | < 50ms | 几百 ms（网络 + 计算） |
> | 需要后端？ | 不需要 | 需要 |
> | 优势 | 即时响应，离线可用 | 能做复杂晶体学运算 |
>
> MCP 有一个精巧的设计：**自动注入**。AI 调用工具时不需要传结构参数，`mcp_server.py` 会自动从前端获取当前结构并注入到请求中。

---

# 第八部分：数据是怎么流动的——端到端场景

## 场景 1：用户在桌面版优化一个晶体结构

```
1. 用户打开 Cu.cif 文件
   → 前端 parse.ts 解析 CIF
   → 生成 Structure 对象 { lattice, sites: [{element: "Cu", xyz: [0,0,0]}, ...] }
   → Structure.svelte $state 更新
   → 响应式链触发：atom_data, bond_data, lattice_vectors 全部重算
   → StructureScene 渲染 3D 视图

2. 用户点击"Optimize"按钮，选择 MACE 计算器
   → 前端 src/lib/api/compute.ts: optimizeStructure()
   → POST /api/optimize/structure
     body: { structure: {...}, calculator: "mace_mp", fmax: 0.05 }

3. 后端 server/routers/optimize.py 接收
   → calculators.get_calculator("mace_mp") 获取 MACE 计算器
   → ASE Atoms 对象构建
   → BFGS 优化器运行（每步计算力和能量）
   → 返回轨迹：[{step: 0, energy: -3.72, fmax: 0.8}, {step: 1, energy: -3.81, fmax: 0.3}, ...]

4. 前端接收结果
   → 更新 $state: structure = optimized_structure
   → 响应式链再次触发
   → 3D 视图更新到优化后的结构
```

## 场景 2：用户用 AI 聊天建超胞

```
1. 用户在聊天框输入："帮我建一个 3x3x1 的超胞"

2. chat-state.svelte.ts: send_message()
   → 组装 messages + tools 列表发给 Anthropic API
   → API 返回 tool_use:
     { name: "catgo_supercell", input: { na: 3, nb: 3, nc: 1 } }

3. run_tool_loop() 判断路由
   → is_structure_tool("catgo_supercell") === true
   → execute_structure_tool("catgo_supercell", { na: 3, nb: 3, nc: 1 })

4. structure-tool-executor.ts 委托给 Structure.svelte 注册的 handler
   → handler 内部调用 WASM make_supercell() 或 TS supercell.ts
   → 生成 27 倍原子的新结构（3 * 3 * 1）
   → $state 更新 → 渲染

5. 工具返回结果字符串："Supercell 3x3x1 created. 27 atoms."
   → 发回 Anthropic API 作为 tool_result
   → API 返回最终文本回复："好的，已经建好了 3x3x1 超胞，现在有 27 个原子。"
```

## 场景 3：CLI Agent 通过 MCP 切表面

```
1. 用户在终端输入：
   claude "帮我对当前结构切 (1,1,1) 表面，3 层，真空层 15 Å"

2. Claude 决定调用 MCP 工具：
   catgo_generate_slab(miller_index=[1,1,1], min_slab_size=3, vacuum=15)

3. mcp_server.py: handle_call_tool()
   → 检查参数中没有 structure
   → _get_current_structure(): GET http://localhost:3000/view/structure/current
   → 获得当前 3D 视图中的结构数据
   → 自动注入到请求参数中

4. HTTP 转发：
   POST http://localhost:8000/api/build/slab
   body: { structure: {...}, miller_index: [1,1,1], min_slab_size: 3, vacuum: 15 }

5. 后端 pymatgen 处理：
   → SlabGenerator(structure, miller_index).get_slabs()
   → 返回表面结构

6. _push_structure_to_viewer():
   POST http://localhost:3000/view/structure/push { structure: slab_data }
   POST http://localhost:3000/pending-update { type: "structure_update" }

7. 前端每 500ms 轮询 /pending-update
   → 发现有新结构
   → poll_structure_updates() 获取并应用
   → $state 更新 → 渲染新的表面结构
```

---

# 第九部分：面试话术模板

## 项目介绍（2 分钟版本）

> 我参与的项目是 CatGo，一个面向材料科学的全栈可视化与计算工具平台。
>
> **产品层面**：科研人员用它来查看和编辑晶体结构、运行计算优化、分析电子结构（DOS、能带、COHP），以及编排多步计算工作流。它支持网页、桌面、VSCode 扩展和 Jupyter 四种部署形态，共享同一套核心代码。
>
> **技术层面**：前端用 Svelte 5 + Three.js 做响应式 3D 渲染，性能关键计算用 Rust 编译成 WebAssembly 在浏览器内执行（比纯 JS 快 10-50 倍）。后端用 Python FastAPI + pymatgen/ASE 做科学计算。桌面版基于 Tauri 2.0，打包只有 15MB。还集成了 AI 聊天和 MCP 协议，支持自然语言驱动操作。
>
> **我的工作**：[根据你实际做的展开，比如] 我主要负责了插件系统的设计和实现，以及相关 API 端点的开发。具体来说，我实现了插件自动发现、动态加载、生命周期管理，并修复了插件计算器无法在优化流程中使用的断路问题。

## 追问：说说你解决的最有挑战的问题

> [以插件断路为例]
>
> 有一个问题是插件计算器安装后无法在结构优化 API 中使用。经过排查，发现 `/api/optimize/structure` 端点直接调用内置的 `calculators.get_calculator()`，完全绕过了 `plugin_manager`。
>
> 修复思路是在 `get_calculator()` 工厂函数中添加 fallback：先查内置计算器，找不到再查 `plugin_manager`。这样对上层路由完全透明，不需要修改调用方的代码。同时在请求模型中加入了 `calculator_params` 字段，让插件能接收自定义参数。
>
> 一共改了 4 个文件：模型层、计算器工厂、HTTP 路由、WebSocket 路由。整个改动保持了向后兼容——已有的内置计算器调用行为不变。

## 追问：说说项目中的一个架构决策

> [以三级 WASM 回退为例]
>
> CatGo 的化学键检测用 Rust WASM 实现，比纯 JS 快 10-50 倍。但 WASM 在某些环境不可用——比如 Jupyter 的 iframe 沙箱禁止创建 Web Worker，某些浏览器的 CSP 策略限制 WASM 加载。
>
> 我们设计了三级回退：Worker WASM（最优，后台线程不阻塞 UI）→ 主线程 WASM（次优，会短暂冻结界面）→ 纯 JS（保底，最慢但永远可用）。
>
> 回退是静默的——用 $derived 中的 try-catch 捕获异常，自动降级。用户不会看到错误弹窗，只是在大结构时可能会稍慢一些。
>
> 这个决策体现了「优雅降级」原则：永远不要因为环境问题让用户无法使用功能。

---

# 第十部分：术语速查表

| 术语 | 一句话解释 | CatGo 中在哪 |
|------|----------|-------------|
| **Svelte** | 前端 UI 框架，编译时生成 DOM 更新代码 | 整个前端 |
| **Runes** | Svelte 5 的响应式语法 ($state/$derived/$effect) | Structure.svelte |
| **SvelteKit** | Svelte 的全家桶（路由、SSG） | 网页版 |
| **Three.js** | JavaScript 3D 渲染库 | StructureScene.svelte |
| **Threlte** | Three.js 的 Svelte 封装 | 3D 组件 |
| **D3** | 2D 数据可视化库 | 能带图、相图等 |
| **Plotly** | 另一个图表库，更高层 | DOS/能带/COHP 绘图 |
| **Vite** | 前端构建工具（dev server + bundler） | 两个配置文件 |
| **WASM** | WebAssembly，浏览器内运行的二进制格式 | ferrox-wasm |
| **Web Worker** | 浏览器后台线程 | workers/bonding-worker.ts |
| **Tauri** | 网页→桌面应用框架（Rust 后端） | src-tauri/ |
| **FastAPI** | Python Web 框架 | server/main.py |
| **REST API** | 前后端通信协议 | server/routers/ |
| **WebSocket** | 实时双向通信 | 优化进度、工作流监控 |
| **MCP** | AI 工具调用协议 | server/mcp_server.py |
| **pymatgen** | Python 晶体学库 | 后端计算 |
| **ASE** | Python 原子模拟环境 | 后端优化 |
| **MACE/CHGNet** | 机器学习原子间势 | server/calculators/ |
| **DAG** | 有向无环图 | 工作流编辑器 |
| **Impostor** | GPU 着色器模拟几何体的技术 | AtomImpostors.svelte |
| **InstancedMesh** | Three.js 批量渲染相同几何体 | Bond.svelte |
| **SSE** | Server-Sent Events，服务器推送 | AI 聊天流式响应 |
| **Session** | 会话，后端缓存大数据的 key | DOS/能带/COHP 分析 |
| **Plugin** | 不改源码就能添加功能的机制 | server/plugins/ |
| **Singleton** | 单例模式，全局只有一个实例 | PluginManager |

---

# 推荐学习路线

## 第一天：概念建立（2-3 小时）

1. 通读本文档第一部分（背景知识）和第二部分（项目定位）
2. 通读第三部分（整体架构）
3. 在脑中建立"前端-通信-后端"三层图

## 第二天：前端深入（2-3 小时）

1. 精读第四部分（前端架构）
2. 打开 CatGo 网页版实际操作：
   - 导入一个 CIF 文件
   - 旋转缩放结构
   - 尝试建超胞
   - 切换着色模式
3. 对照操作回想数据流

## 第三天：后端深入 + 你的工作（2-3 小时）

1. 精读第五部分（后端架构），特别是插件系统
2. 精读第六部分（六大子系统）
3. 回顾你实际修改过的代码

## 第四天：面试准备（1-2 小时）

1. 精读第七部分（技术决策 Q&A）
2. 精读第八部分（端到端场景）
3. 用第九部分的话术模板练习自述
4. 找人模拟面试追问

## 持续参考

- 遇到术语 → 查第十部分速查表
- 需要源码级细节 → 查 `code_frame/README.md`
- 需要全局架构 → 查 `CLAUDE.md`

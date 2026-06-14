# 安装

CatGo 是一个桌面应用。大多数用户可以直接从 GitHub Releases 下载预构建安装包。需要从源码构建的开发者可以使用下面的快速开始流程。

## 下载预构建安装包

每个 release 的预构建安装包都会发布在 [GitHub Releases](https://github.com/Hello-QM/catgo-LRG/releases/latest)。所有安装包都内置 Python 后端（通过 PyInstaller）和 agent-bridge sidecar，不需要用户额外安装 Python 或 Node。

| 平台 | 文件 | 说明 |
|----------|------|-------|
| **macOS (Apple Silicon)** | `CatGo_<version>_aarch64.dmg` | 拖到 `/Applications`。首次启动可能需要右键 -> Open（未签名）。 |
| **macOS (Intel)** | `CatGo_<version>_x64.dmg` | 也提供 universal 构建，文件名包含 `universal`。 |
| **Windows** | `CatGo_<version>_x64-setup.exe` 或 `.msi` | 如果缺少 WebView2 runtime，会自动安装。 |
| **Linux (`.AppImage`)** | `CatGo_<version>_amd64.AppImage` | `chmod +x` 后运行。多数发行版无需 root 权限。 |
| **Linux (`.deb`)** | `CatGo_<version>_amd64.deb` | 在 Ubuntu / Debian 上使用 `sudo apt install ./CatGo_*.deb`。 |

安装后，从启动器打开 *CatGo*。Linux 也可以在终端中运行：

```bash
chmod +x CatGo_*.AppImage
./CatGo_*.AppImage
```

用户数据（数据库、面板状态、agent 工作目录）默认保存在 `~/.catgo/`。可通过 `CATGO_HOME` 环境变量覆盖位置。

## 前置条件

- **Node.js** >= 20，并安装 [pnpm](https://pnpm.io/)
- **Python** >= 3.10（推荐 Conda，便于隔离科学计算 Python 环境）
- **Git**

如果要完整构建 Tauri 桌面应用（生成 `.dmg` / `.msi` / `.AppImage` 安装包），还需要：

- [Rust](https://rustup.rs/) 工具链（stable channel）
- 平台相关构建工具，见 [Tauri 2.0 prerequisites](https://tauri.app/start/prerequisites/) 中对应操作系统的说明

## 快速开始

```bash
# 1. Clone
git clone https://github.com/Hello-QM/catgo-LRG.git
cd catgo-LRG

# 2. Frontend dependencies
pnpm install

# 3. Python environment
conda create -n catgo python=3.11
conda activate catgo
pip install -r server/requirements.txt

# 4. Launch (frontend on :3100, backend on :8000)
pnpm desktop:serve
```

在浏览器中打开 [http://localhost:3100](http://localhost:3100)。可以把 CIF / POSCAR / XYZ / extxyz / mol2 / pdb / traj 文件拖到查看器中，也可以向 CatBot 提问，例如 *"fetch Cu from Materials Project and cut a (100) slab."*

## 开发命令

| 命令 | 作用 |
|---|---|
| `pnpm desktop:serve` | 前端运行在 :3100，Python 后端运行在 :8000，推荐用于日常开发 |
| `pnpm desktop:dev` | 只启动前端，适合后端已单独运行或暂时不需要后端的情况 |
| `pnpm tauri:dev` | 带热更新的完整 Tauri 桌面应用（需要 Rust 工具链） |
| `pnpm check` | 对整个代码库运行 Svelte / TypeScript 类型检查 |
| `pnpm test` | 运行一次 Vitest 单元测试；`pnpm vitest` 为 watch mode |
| `cd server && pytest` | Python 后端测试 |
| `pnpm docs:dev` | 在 :5173 本地启动文档站点 |

## 生产构建

```bash
# Build the Tauri desktop app for your current platform
pnpm tauri:build

# Or target a specific platform explicitly
pnpm tauri:build:mac-arm     # macOS Apple Silicon (.dmg + .app)
pnpm tauri:build:mac         # macOS universal (Intel + Apple Silicon)
pnpm tauri:build:windows     # Windows x64 (.msi + .exe)
pnpm tauri:build:linux       # Linux x64 (.AppImage + .deb)

# Build with the Python backend bundled via PyInstaller (single-file install)
pnpm bundle                  # Current platform
pnpm bundle:mac-arm          # macOS Apple Silicon
pnpm bundle:windows          # Windows x64
```

构建产物会生成在 `src-tauri/target/release/bundle/`。`bundle:*` 变体会生成包含 Python 计算服务器的自包含安装包，用户不需要自行安装 Python。

## VSCode 扩展

```bash
cd extensions/vscode
pnpm install
pnpm build
```

可通过 VSCode 的 *Extensions -> Install from VSIX* 加载结果，或在打开 `extensions/vscode/` 文件夹后按 <kbd>F5</kbd> 在 Extension Development Host 中运行。

## WASM 模块（可选）

Rust -> WASM 模块（键合分析、slab 生成、快速几何操作）会以预构建形式发布在 `extensions/rust-wasm/pkg/`。只有在修改 Rust 代码时才需要从源码重建：

```bash
cd extensions/rust

# One-time: install wasm-pack
cargo install wasm-pack

# Build the WASM package
wasm-pack build --target web --out-dir ../rust-wasm/pkg
```

## 单独运行后端

如果只需要 Python 计算服务器（例如无头脚本、CI，或从 Jupyter notebook 驱动 CatGo），可以绕过前端：

```bash
cd server
python main.py
```

服务器监听 `http://localhost:8000`，并为前端启用 CORS。

### 可用计算器

| 计算器 | 包 | 说明 |
|---|---|---|
| EMT | ASE（内置） | 面向金属的 effective medium theory，速度快且无需额外配置 |
| xTB | tblite + xtb CLI | 半经验 tight-binding（GFN2 / GFN1 / GFN0 / GFN-FF） |
| MACE | mace-torch | 机器学习势，包含 `mace_mp` foundation models |
| CHGNet | chgnet | Crystal Hamiltonian Graph Network |
| M3GNet | matgl | Materials 3-body Graph Network |

## 故障排查

### 通用

- **`pnpm desktop:serve` 提示找不到 `python`** - 你的 shell 中的 `python` 可能指向损坏或无关的解释器。请先激活 `catgo` conda 环境（`conda activate catgo`），或把 `PYTHON` 环境变量设为绝对路径，例如 `/opt/anaconda3/bin/python`。
- **`pnpm tauri:dev` 编译失败** - 确认已安装 [Tauri 2.0](https://tauri.app/start/prerequisites/) 所需的平台构建工具（macOS 上是 Xcode Command Line Tools，Windows 上是 WebView2 runtime，Linux 上是标准 build essentials）。
- **前端加载了但查看器空白** - WASM 模块可能缺失。重新运行 `pnpm install`（预构建 WASM 以 workspace link 方式提供），或按上文从源码重建。

### Windows

- **HPC 连接因 `pywintypes` 或 `pythoncom` 的 `ImportError` 失败** - v1.0.1 已修复。如果你使用更早版本，请升级。内置后端现在会包含所需的 `pywin32` DLL。
- **CatBot 聊天立即退出** - Claude provider 的 agent-bridge sidecar 需要 `claude` CLI。可通过 `npm i -g @anthropic-ai/claude-cli` 安装，或在 *Settings* 中把 CatBot 切换到 Gemini / Codex provider。

### Linux (`.AppImage`)

- **`./CatGo_*.AppImage: cannot execute`** - 设置可执行权限：`chmod +x CatGo_*.AppImage`。
- **AppImage 因 `WebKit2GTK` 错误退出** - 安装 `libwebkit2gtk-4.1-0`（Ubuntu 24.04+）或 `libwebkit2gtk-4.0-37`（旧版本）。AppImage 不内置 WebKit，而是依赖系统库。
- **MCP 端点 `/api/mcp/` 返回 404** - v1.0.1 已修复。早期 PyInstaller 包会静默丢失 `rfc3987_syntax` grammar 文件。
- **升级后用户数据缺失** - CatGo 把数据库和面板状态保存在 `~/.catgo/`，不是 AppImage 挂载目录中。请确认该目录可写。

### macOS

- **"CatGo can't be opened because it is from an unidentified developer"** - 右键点击应用并选择 *Open*，然后确认。目前构建尚未签名。
- **Sidecar 进程启动失败** - v1.0.1 已修复；sidecar 查找现在使用 bundle basename。如果日志中出现 "catgo-server not found"，请升级到最新版。

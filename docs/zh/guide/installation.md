# 安装

CatGo 是桌面应用。大多数用户应从 GitHub Releases 下载预构建安装包。开发者可参照下方"快速开始"自源码构建。

## 下载预构建安装包

每个发行版的安装包都发布在 [GitHub Releases](https://github.com/Hello-QM/catgo-LRG/releases/latest)。所有安装包内置 Python 后端（PyInstaller 打包）与 agent-bridge sidecar —— 无需另装 Python 或 Node。

| 平台 | 文件 | 说明 |
|------|------|------|
| **macOS (Apple Silicon)** | `CatGo_<version>_aarch64.dmg` | 拖入 `/Applications`。首次启动可能需右键 → 打开（未签名）。 |
| **macOS (Intel)** | `CatGo_<version>_x64.dmg` | 也提供 universal 通用版（文件名含 `universal`）。 |
| **Windows** | `CatGo_<version>_x64-setup.exe` 或 `.msi` | 缺失时自动安装 WebView2 运行时。 |
| **Linux (`.AppImage`)** | `CatGo_<version>_amd64.AppImage` | `chmod +x` 后直接运行。多数发行版无需 root。 |
| **Linux (`.deb`)** | `CatGo_<version>_amd64.deb` | Ubuntu / Debian: `sudo apt install ./CatGo_*.deb` |

安装后从启动器打开 *CatGo*。Linux 终端：

```bash
chmod +x CatGo_*.AppImage
./CatGo_*.AppImage
```

用户数据（数据库、面板状态、agent 工作目录）保存在 `~/.catgo/`。可通过 `CATGO_HOME` 环境变量覆盖位置。

## 前置依赖（源码构建）

- **Node.js** ≥ 20，配合 [pnpm](https://pnpm.io/)
- **Python** ≥ 3.10（推荐 Conda — 提供独立环境）
- **Git**

打包 Tauri 桌面安装包（生成 `.dmg` / `.msi` / `.AppImage`）还需：

- [Rust](https://rustup.rs/) 工具链（stable）
- 平台构建工具 — 见 [Tauri 2.0 前置依赖](https://tauri.app/start/prerequisites/)

## 快速开始

```bash
# 1. 克隆
git clone https://github.com/Hello-QM/catgo-LRG.git
cd catgo-LRG

# 2. 前端依赖
pnpm install

# 3. Python 环境
conda create -n catgo python=3.11
conda activate catgo
pip install -r server/requirements.txt

# 4. 启动（前端 :3100，后端 :8000）
pnpm desktop:serve
```

浏览器打开 `http://localhost:3100`。把 CIF / POSCAR / XYZ / extxyz / mol2 / pdb / traj 文件拖入查看器，或对 CatBot 说："从 Materials Project 拿 Cu 然后切个 (100) 平板"。

## 故障排查

### 通用

- **`pnpm desktop:serve` 报找不到 `python`** — shell 中 `python` 可能不正确。先 `conda activate catgo`，或设环境变量 `PYTHON=/opt/anaconda3/bin/python`。
- **`pnpm tauri:dev` 编译失败** — 装 [Tauri 2.0](https://tauri.app/start/prerequisites/) 平台依赖（macOS: Xcode Command Line Tools；Windows: WebView2；Linux: build-essential）。
- **前端加载但查看器空白** — WASM 模块缺失。重跑 `pnpm install`（预构建 WASM 通过 workspace link 提供），或参照上文从源码重建。

### Windows

- **HPC 连接报 `pywintypes` / `pythoncom` ImportError** — v1.0.1 已修。升级即可，打包后的后端会正确携带 `pywin32` DLL。
- **CatBot 启动后立即退出** — agent-bridge 的 Claude 提供方需要 `claude` CLI。`npm i -g @anthropic-ai/claude-cli` 安装，或在 *Settings* 切到 Gemini / Codex。

### Linux (`.AppImage`)

- **`./CatGo_*.AppImage: cannot execute`** — 加可执行权限：`chmod +x CatGo_*.AppImage`。
- **AppImage 启动失败提示 WebKit2GTK** — 装 `libwebkit2gtk-4.1-0`（Ubuntu 24.04+）或 `libwebkit2gtk-4.0-37`（更老）。AppImage 不打包 WebKit，依赖系统库。
- **MCP 端点 `/api/mcp/` 返回 404** — v1.0.1 已修。早期 PyInstaller 包静默丢失 `rfc3987_syntax` 语法文件。
- **升级后用户数据丢失** — CatGo 数据在 `~/.catgo/`（不在 AppImage 内）。确保该目录可写。

### macOS

- **"CatGo 无法打开，因为来自身份不明的开发者"** — 右键 → 打开 → 确认。构建当前未签名。
- **Sidecar 进程启动失败** — v1.0.1 已修，sidecar 查找改用 bundle basename。日志中看到 "catgo-server not found" 升级即可。

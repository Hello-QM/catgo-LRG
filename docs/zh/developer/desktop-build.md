# 桌面构建指南

本指南说明如何使用 Tauri 2.0 将 CatGo 构建为桌面应用，并说明是否打包 Python 计算服务器的两种构建方式。

## 前置条件

### 1. 安装 Rust

**Windows：**

```powershell
# Download and run rustup-init.exe from https://rustup.rs
# Or use winget:
winget install Rustlang.Rustup
```

**macOS：**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Linux：**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

安装后，重启终端并验证：

```bash
rustc --version
cargo --version
```

### 2. 平台相关依赖

**Windows：**

- 安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，并选择 "C++ build tools" 工作负载
- Windows 10/11 已包含 WebView2

**macOS：**

- 安装 Xcode Command Line Tools：`xcode-select --install`

**Linux（Debian/Ubuntu）：**

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### 3. 安装 Node.js 依赖

```bash
pnpm install
```

## 开发

使用热更新模式运行应用：

```bash
pnpm tauri:dev
```

该命令会把桌面前端构建到 `build-desktop/`，运行在 3001 端口，然后启动指向该开发服务器的 Tauri 窗口。

## 生产构建

### 仅桌面应用

该方式只构建应用本体，不包含 Python 计算服务器。依赖服务器的功能，例如优化、数据库搜索、结构构建器，需要单独运行服务器。

```bash
pnpm tauri:build
```

输出位于 `src-tauri/target/release/bundle/`：

- **Windows：** `.msi` 安装器和 `.exe`
- **macOS：** `.dmg` 和 `.app`
- **Linux：** `.deb`、`.rpm`、`.AppImage`

### 平台指定构建

```bash
pnpm tauri:build:mac-arm    # macOS Apple Silicon (aarch64)
pnpm tauri:build:mac        # macOS Universal (Intel + ARM)
pnpm tauri:build:windows    # Windows x64
pnpm tauri:build:linux      # Linux x64
```

### 完整打包（应用 + 后端服务器）

该方式会通过 PyInstaller 将 Python 计算服务器构建为独立可执行文件，并作为 Tauri sidecar 打包。服务器会在应用启动时自动启动，并在窗口关闭时退出。

**打包前置条件：**

- Python 3.10+
- PyInstaller（`pip install pyinstaller`）
- 服务器依赖（`cd server && pip install -r requirements.txt`）

```bash
# Build for current platform
pnpm bundle

# Platform-specific
pnpm bundle:mac-arm     # macOS Apple Silicon
pnpm bundle:windows     # Windows x64
```

构建脚本（`scripts/build-backend.sh`）会把服务器编译为单个可执行文件，输出到 `src-tauri/binaries/catgo-server-{target}`，随后 Tauri 构建会把它作为 external binary 打包。

### 生成应用图标

```bash
pnpm tauri:icons
```

该命令会从 `desktop/logo.png` 生成所有需要的图标尺寸（32x32、128x128、ICNS、ICO）。

## 架构

桌面应用分为三层：

```
┌──────────────────────────────────┐
│  Desktop Frontend (Svelte 5)     │  desktop/App.svelte
│  Multi-pane editor, file I/O,    │  Vite build → build-desktop/
│  atom clipboard, settings        │
├──────────────────────────────────┤
│  Tauri Shell (Rust)              │  src-tauri/src/lib.rs
│  Plugins: fs, dialog, shell,     │  Spawns/kills backend sidecar
│  http, log                       │
├──────────────────────────────────┤
│  Python Backend (optional)       │  server/main.py
│  FastAPI on :8000                │  Bundled via PyInstaller
│  Optimization, DB proxy,         │
│  structure builders              │
└──────────────────────────────────┘
```

**使用的 Tauri 插件：**

| 插件 | 用途 |
|--------|---------|
| `tauri-plugin-fs` | 通过原生文件系统读写文件 |
| `tauri-plugin-dialog` | 带文件类型过滤的原生打开/保存对话框 |
| `tauri-plugin-shell` | 启动打包后的后端 sidecar |
| `tauri-plugin-http` | 向后端服务器发起 HTTP 请求 |
| `tauri-plugin-log` | 结构化日志 |

Rust 层刻意保持很薄，大约 150 行。它负责 sidecar 生命周期、文件关联处理和 PTY 会话，其余功能交给 Svelte 前端和 Tauri 插件。

## 文件关联

应用会注册操作系统级文件关联，用户可以双击打开：

| 扩展名 | 说明 |
|-----------|-------------|
| `.cif` | 晶体学信息文件（Crystallographic Information File） |
| `.poscar`, `.vasp`, `.contcar` | VASP 结构文件 |
| `.xyz`, `.extxyz` | XYZ 分子结构文件 |
| `.traj` | ASE 轨迹文件 |
| `.json` | JSON 结构数据 |

这些配置位于 `src-tauri/tauri.conf.json` 的 `bundle.fileAssociations` 下。

### 文档图标（macOS）

在 macOS 上，关联文件会在 Finder 中显示自定义 CatGo 文档图标。实现涉及：

- `src-tauri/icons/document.icns` - 图标文件，由 `document.svg` 生成
- `src-tauri/Info.plist` - 引用该图标的 `CFBundleDocumentTypes` 条目
- `src-tauri/tauri.conf.json` - 通过 `bundle.resources` 将 `.icns` 复制进 app bundle

### 文件打开处理

当用户双击关联文件时，macOS 会向 Tauri 后端发送 `RunEvent::Opened` 事件。Rust 层会把文件路径缓存在 `OpenedFiles` 状态中并通知前端，前端随后读取文件并加载到活动标签页。

## 移动端支持（实验性）

Tauri 2.0 支持 iOS 和 Android。初始化移动端：

### Android 设置

1. 安装 Android Studio 和 SDK
2. 设置 `ANDROID_HOME` 环境变量
3. 初始化 Android：
   ```bash
   npx tauri android init
   ```
4. 构建：
   ```bash
   npx tauri android build
   ```

### iOS 设置（仅 macOS）

1. 安装 Xcode
2. 初始化 iOS：
   ```bash
   npx tauri ios init
   ```
3. 构建：
   ```bash
   npx tauri ios build
   ```

## 使用 GitHub Actions 做 CI/CD

创建 `.github/workflows/release.yml`，用于自动构建：

```yaml
name: Release
on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        platform: [macos-latest, ubuntu-22.04, windows-latest]
    runs-on: ${{ matrix.platform }}

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: lts/*

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Install Rust stable
        uses: dtolnay/rust-action@stable

      - name: Install dependencies (Ubuntu)
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
            libssl-dev libayatana-appindicator3-dev librsvg2-dev

      - name: Install frontend dependencies
        run: pnpm install

      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: v__VERSION__
          releaseName: 'CatGo v__VERSION__'
          releaseBody: 'See the assets to download and install this version.'
          releaseDraft: true
          prerelease: false
```

## 故障排查

### 找不到 WebView2（Windows）

从以下地址下载并安装 WebView2 runtime：
https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### Rust 编译错误

更新 Rust：

```bash
rustup update stable
```

### 后端 Sidecar 无法启动

如果打包服务器启动失败：

1. 检查应用日志中的 `[Backend]` 消息（Tauri log plugin）
2. 确认二进制文件存在于 `src-tauri/binaries/catgo-server-{target}`
3. 尝试直接运行：`./src-tauri/binaries/catgo-server-{target}`
4. 作为兜底，手动运行服务器：`cd server && python main.py`

### WASM/WebGL 问题

确认显卡驱动已更新，并启用了硬件加速。

### 8000 端口已被占用

后端服务器运行在 8000 端口。如果已有其他进程占用：

```bash
# Find what's using port 8000
lsof -i :8000        # macOS/Linux
netstat -ano | findstr :8000  # Windows

# Kill the process, then restart the app
```

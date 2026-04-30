# CatGo 部署指南 / Deployment Guide

本指南帮助合作者快速搭建开发环境并运行项目。

## 环境要求 / Prerequisites

- **Node.js** >= 18.x
- **pnpm** >= 8.x (推荐) 或 npm
- **Rust** >= 1.75 (用于WASM编译)
- **wasm-pack** >= 0.12 (用于编译Rust到WebAssembly)

### 安装 wasm-pack

```bash
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
```

## 快速开始 / Quick Start

### 1. 克隆仓库

```bash
git clone https://github.com/Hello-QM/catgo-LRG.git
cd catgo
git checkout james/desktop
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 编译 WASM 模块

**重要**: 首次运行或修改 Rust 代码后，必须重新编译 WASM。

```bash
cd extensions/rust
wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm
```

编译完成后，需要同步到 node_modules:

```bash
cp ../rust-wasm/pkg/* ../../node_modules/@catgo/ferrox-wasm/pkg/
```

或使用一键命令:

```bash
cd extensions/rust && wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm && cp ../rust-wasm/pkg/* ../../node_modules/@catgo/ferrox-wasm/pkg/
```

### 4. 启动开发服务器

```bash
# 回到项目根目录
cd ../..
pnpm dev
```

访问 http://localhost:5173 查看应用。

## 新功能说明 / New Features

### UFF 优化器 (本地优化)

支持使用 Universal Force Field (UFF) 配合 FIRE 算法在浏览器中直接优化分子结构:

- 无需后端服务器
- 支持选择性原子优化 (只移动选中的原子)
- 实时显示能量和力的收敛曲线

使用方法:

1. 加载结构文件
2. (可选) 选择要优化的原子
3. 点击闪电图标打开优化面板
4. 选择 "Local (UFF)" 模式
5. 点击 "Optimize" 按钮

### Slab 切割器

支持沿任意 Miller 指数切割晶体表面:

- 实时预览切割效果
- 可调节 slab 厚度和真空层
- 支持多种生长模式 (centered, anchor_minus_z, anchor_plus_z)

## 常见问题 / Troubleshooting

### `mod.optimize_structure_uff is not a function`

**原因**: WASM 模块未正确加载或版本不匹配。

**解决方案**:

1. 重新编译 WASM:
   ```bash
   cd extensions/rust
   wasm-pack build --target web --out-dir ../rust-wasm/pkg --features wasm
   ```
2. 同步到 node_modules:
   ```bash
   cp ../rust-wasm/pkg/* ../../node_modules/@catgo/ferrox-wasm/pkg/
   ```
3. 重启开发服务器
4. 硬刷新浏览器 (Ctrl+Shift+R)

### WASM 编译失败

确保已安装正确版本的 Rust 和 wasm-pack:

```bash
rustup update
cargo install wasm-pack --force
```

### 开发服务器启动失败

清理缓存后重试:

```bash
rm -rf node_modules/.vite
pnpm dev
```

## 项目结构 / Project Structure

```
catgo/
├── extensions/
│   ├── rust/                 # Rust 核心库 (ferrox)
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── wasm.rs       # WASM 绑定
│   │   │   ├── optimizer.rs  # UFF/FIRE 优化器
│   │   │   └── bonding.rs    # 键检测算法
│   │   └── Cargo.toml
│   ├── rust-wasm/            # 编译后的 WASM 包
│   │   └── pkg/
│   └── vscode/               # VSCode 扩展
├── src/
│   └── lib/
│       └── structure/
│           ├── ferrox-wasm.ts        # WASM TypeScript 包装器
│           ├── ferrox-wasm-types.ts  # 类型定义
│           ├── OptimizationPane.svelte
│           ├── MillerSlabCutterPane.svelte
│           └── Structure.svelte
├── static/
│   └── wasm/                 # 静态 WASM 文件 (备用)
└── package.json
```

## 贡献指南 / Contributing

1. 创建功能分支: `git checkout -b feature/your-feature`
2. 提交更改: `git commit -m "feat: add your feature"`
3. 推送分支: `git push origin feature/your-feature`
4. 创建 Pull Request

## 联系 / Contact

如有问题，请在 GitHub Issues 中提出。

# CatGo 开发指南

本指南帮助开发者以及 Claude 这类 AI 助手理解 CatGo 开发中的架构决策。

## 架构概览

CatGo 使用混合架构：

- **Frontend**：SvelteKit + Three.js，用于可视化
- **WASM (Rust)**：在浏览器中执行高性能晶体学计算
- **Backend (FastAPI)**：服务器端操作、数据库访问、外部 API

---

## 什么时候使用 Rust + WASM

对于满足以下条件的**计算密集型操作**，使用 Rust/WASM：

1. 需要在浏览器中频繁运行
2. 受益于并行化或底层优化
3. 不需要网络访问或数据库操作

### 已实现的 WASM 函数

位于 `extensions/rust/src/wasm.rs`：

| 类别 | 函数 | 说明 |
| --------------------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| **Structure Parsing** | `parse_structure`, `parse_cif`, `parse_poscar` | 解析晶体学文件格式 |
| **Supercell** | `make_supercell_diag`, `make_supercell` | 创建超胞 |
| **Neighbor List** | `get_neighbor_list`, `get_all_neighbors`, `get_distance`, `get_distance_matrix` | 考虑 PBC 的距离计算 |
| **Symmetry** | `get_spacegroup_number`, `get_primitive_cell` | 通过 moyo 进行对称性分析 |
| **Slab Generation** | `generate_slab`, `compute_d_spacing`, `miller_to_normal`, `detect_layers` | 表面/slab 切割 |
| **Ewald Summation** | `compute_ewald`, `compute_ewald_auto`, `compute_ewald_from_species` | 静电能 |
| **Properties** | `get_volume`, `get_density`, `get_composition`, `get_reduced_formula` | 结构属性 |
| **Coordinates** | `get_cart_coords`, `get_frac_coords`, `wrap_to_unit_cell` | 坐标变换 |

### 什么时候添加新的 WASM 函数

符合以下条件时，添加到 Rust/WASM：

- 操作涉及矩阵数学、晶格变换或几何
- 需要实时运行，例如用户交互期间
- 是纯计算，不需要 I/O
- 性能很关键，在典型硬件上超过 10ms

**适合 WASM 的例子：**

- 键检测算法
- 配位数计算
- 结构插值（NEB images）
- 声子模可视化
- 电荷密度等值面生成

---

## 什么时候使用 FastAPI 后端

对于满足以下条件的操作，使用 FastAPI：

1. 需要数据库访问
2. 需要调用外部 API（Materials Project、AFLOW、ICSD）
3. 涉及认证/授权
4. 处理大文件或大型数据集
5. 需要持久化存储

### 后端职责

| 类别 | 操作 |
| -------------------- | ---------------------------------------------------------------- |
| **Database** | 存储/读取结构、用户偏好、计算结果 |
| **External APIs** | 查询 Materials Project、AFLOW、COD、ICSD |
| **File Storage** | 存储轨迹文件和大型数据集 |
| **Authentication** | 用户登录、API key、权限 |
| **Batch Processing** | 大规模结构匹配、数据库去重 |
| **ML Inference** | 运行机器学习模型，如果需要 GPU |

**适合后端的例子：**

- 按组成/性质搜索结构
- 存储计算结果
- 用户 workspace 管理
- 与 VASP/QE 作业提交集成
- 机器学习势推理，如果不能兼容 WASM

---

## Rust/WASM 开发指南

### 项目结构

```
extensions/
├── rust/                    # Main Rust crate
│   ├── src/
│   │   ├── lib.rs          # Module exports
│   │   ├── wasm.rs         # WASM bindings (wasm-bindgen)
│   │   ├── structure.rs    # Structure type
│   │   ├── lattice.rs      # Lattice operations
│   │   ├── slab.rs         # Slab generation
│   │   ├── ewald.rs        # Ewald summation
│   │   └── ...
│   ├── Cargo.toml
│   └── pkg/                # wasm-pack output (auto-generated)
│
└── rust-wasm/              # WASM package for npm
    ├── pkg/                # Copied from rust/pkg
    ├── package.json        # ferrox-wasm
    └── test-wasm.mjs       # Node.js test script
```

### 添加新的 WASM 函数

#### 步骤 1：在 Rust 中实现

在 `extensions/rust/src/wasm.rs` 中添加函数：

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn my_new_function(structure_json: &str, param: f64) -> Result<String, JsError> {
    // Parse input structure
    let structure = parse_structure_json(structure_json)
        .map_err(|e| JsError::new(&format!("Error parsing structure: {e}")))?;

    // Do computation
    let result = compute_something(&structure, param);

    // Return JSON string
    serde_json::to_string(&result)
        .map_err(|e| JsError::new(&format!("Error serializing result: {e}")))
}
```

#### 步骤 2：构建 WASM

```bash
cd extensions/rust
wasm-pack build --target web --features wasm --no-default-features

# Copy to rust-wasm package
cp -r pkg ../rust-wasm/
```

#### 步骤 3：添加 TypeScript 封装

编辑 `src/lib/structure/ferrox-wasm.ts`：

```typescript
// 1. Add to FerroxWasmModule interface
interface FerroxWasmModule {
  // ... existing functions
  my_new_function: (structure_json: string, param: number) => string
}

// 2. Add typed wrapper function
export async function my_new_function(
  structure: Crystal,
  param: number,
): Promise<WasmResult<MyResultType>> {
  const mod = await ensure_ferrox_wasm_ready()
  const json = JSON.stringify(structure)
  return wrapWasmCall(() =>
    JSON.parse(mod.my_new_function(json, param) as unknown as string)
  )
}
```

#### 步骤 4：添加类型（如需要）

编辑 `src/lib/structure/ferrox-wasm-types.ts`：

```typescript
export interface MyResultType {
  field1: number
  field2: string[]
}
```

### 构建命令

```bash
# Build WASM (from project root)
cd extensions/rust && wasm-pack build --target web --features wasm --no-default-features

# Copy to rust-wasm
cp -r extensions/rust/pkg extensions/rust-wasm/

# Test with Node.js
cd extensions/rust-wasm && node test-wasm.mjs

# Run Rust tests
cd extensions/rust && cargo test
```

### 桌面构建（Tauri）

桌面构建中的 WASM 在 `vite.desktop.config.ts` 中配置：

```bash
# Development
pnpm tauri:dev

# Production build
pnpm tauri:build
```

---

## 命名约定

### 与 TypeScript 冲突的 WASM 函数

当 WASM 函数名与已有 TypeScript 实现冲突时：

- 添加 `wasm_` 前缀，例如 `wasm_generate_slab`、`wasm_detect_layers`
- `miller-slab.ts` 中的 TypeScript 版本保留，用于向后兼容
- WASM 版本提供更好的性能

### 类型命名

当类型名冲突时：

- 添加 `Wasm` 前缀，例如 `WasmGrowthMode`、`WasmAtomLayer`
- 定义在 `ferrox-wasm-types.ts` 中

---

## 性能指南

### WASM 性能建议

1. **最小化 JSON 序列化**：结构解析成本较高
2. **批处理操作**：尽可能合并多个操作
3. **使用 typed arrays**：大数据优先使用 `Float64Array`，而不是 `number[]`
4. **惰性初始化**：WASM 通过 `ensure_ferrox_wasm_ready()` 首次使用时加载

### 什么时候不该使用 WASM

- 简单计算（< 1ms），调用开销超过收益
- 需要访问 DOM 的操作
- 带网络请求的异步操作
- 很小数据上的操作（< 100 atoms）

---

## 测试

### Rust 测试

```bash
cd extensions/rust
cargo test
```

### WASM 测试（Node.js）

```bash
cd extensions/rust-wasm
node test-wasm.mjs
```

### TypeScript 测试

```bash
pnpm test
```

---

## 故障排查

### WASM 构建错误

**错误：`--out-dir` flag is unstable**

```bash
# Build in rust directory, then copy
cd extensions/rust
wasm-pack build --target web --features wasm --no-default-features
cp -r pkg ../rust-wasm/
```

**错误：浏览器中找不到 WASM 模块**

- 确认 `extensions/rust-wasm/pkg/` 存在
- 检查 `vite.config.ts` 中 `ferrox-wasm` 的 alias

### TypeScript 错误

**导出冲突**

- 用 `wasm_` 前缀重命名 WASM 函数
- 用 `Wasm` 前缀重命名类型

---

## 相关文件

- `extensions/rust/src/wasm.rs` - WASM bindings
- `extensions/rust/src/lib.rs` - Module exports
- `src/lib/structure/ferrox-wasm.ts` - TypeScript wrapper
- `src/lib/structure/ferrox-wasm-types.ts` - Type definitions
- `vite.config.ts` - Web build config
- `vite.desktop.config.ts` - 桌面端构建配置
- `extensions/rust-wasm/test-wasm.mjs` - Node.js tests

---

## Claude 快速参考

当用户要求实现新功能时：

1. **确定位置**：
   - 几何/数学/结构操作 -> Rust/WASM
   - 数据库/API/认证操作 -> FastAPI 后端
   - UI/可视化 -> SvelteKit 前端

2. **WASM 开发流程**：
   - 在 `extensions/rust/src/wasm.rs` 中添加 Rust 函数
   - 用 `wasm-pack build --target web --features wasm --no-default-features` 构建
   - 将 `pkg/` 复制到 `extensions/rust-wasm/`
   - 在 `src/lib/structure/ferrox-wasm.ts` 中添加 TypeScript wrapper
   - 在 `src/lib/structure/ferrox-wasm-types.ts` 中添加类型
   - 用 `node test-wasm.mjs` 测试

3. **避免命名冲突**：
   - 检查 `miller-slab.ts`、`pbc.ts`、`composition/parse.ts` 是否已有同名内容
   - 冲突函数名使用 `wasm_` 前缀
   - 冲突类型名使用 `Wasm` 前缀

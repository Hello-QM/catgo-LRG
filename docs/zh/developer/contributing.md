# 为 CatGo 贡献

感谢你有兴趣为 CatGo 做贡献！本指南介绍如何搭建开发环境、遵循项目约定并提交贡献。

## 快速上手

### 前置条件

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) 包管理器
- [Rust](https://rustup.rs/) 工具链（用于 WASM 开发）
- [Python 3.10+](https://python.org/)（用于计算服务器）

### 设置

```bash
# Clone the repository
git clone https://github.com/Hello-QM/catgo-LRG.git
cd CatGo

# Install dependencies
pnpm install

# Start development server
pnpm dev
```

开发服务器运行在 `http://localhost:3000`，并支持热更新。

## 项目结构

```
CatGo/
├── src/lib/                  # Svelte component library
│   ├── structure/            # 3D structure viewer (largest module)
│   ├── bands/                # Band structure & DOS
│   ├── periodic-table/       # Interactive periodic table
│   ├── phase-diagram/        # Phase diagram components
│   ├── trajectory/           # MD trajectory player
│   ├── api/                  # API clients (OPTIMADE, MP, PubChem)
│   └── settings.ts           # Unified settings schema
├── extensions/rust/          # Rust library compiled to WASM
├── server/                   # Python FastAPI backend
├── src-tauri/                # Tauri desktop app shell
├── extensions/vscode/        # VSCode extension
├── tests/vitest/             # Unit tests
├── tests/playwright/         # E2E tests
└── docs/                     # Documentation (you are here)
```

## 开发流程

### 分支命名

- `feat/description` - 新功能
- `fix/description` - Bug 修复
- `docs/description` - 文档变更
- `refactor/description` - 代码重构
- `chore/description` - 工具链、CI、依赖等维护工作

### 运行测试

```bash
# Unit tests (Vitest + happy-dom)
pnpm test              # Run once
pnpm vitest            # Watch mode

# Type checking (TypeScript + Svelte)
pnpm check

# End-to-end tests (Playwright)
npx playwright test
```

### 构建

```bash
# Production web build
pnpm build

# Desktop app (development)
pnpm tauri:dev

# Desktop app (production)
pnpm tauri:build
```

## 代码风格

### 通用规则

- 字符串使用 **Template literals**（反引号）
- 全项目使用 **ESM imports**
- **TypeScript** 使用 strict mode
- 不使用分号，除非为了消除语法歧义必须使用

### Svelte 5

CatGo 使用 **Svelte 5 runes**，而不是旧的 Store API：

```svelte
<!-- Correct: Svelte 5 runes -->
<script lang="ts">
  let count = $state(0)
  let doubled = $derived(count * 2)

  $effect(() => {
    console.log(`Count is ${count}`)
  })
</script>

<!-- Incorrect: old Store API -->
<script>
  import { writable } from 'svelte/store'
  const count = writable(0)  // Don't use this
</script>
```

### 文件组织

- 类型与实现放在一起，不单独放到 `types/` 目录
- 通过 `index.ts` 文件集中导出
- 按功能组织目录，而不是按文件类型组织

### 设置

所有可配置项都定义在 `src/lib/settings.ts` 中，包含：

- 类型定义
- 默认值
- 最小/最大约束
- 面向用户的说明
- 上下文标注（web、editor、notebook、all）

新增设置时，请把它加入 `settings.ts` 的 schema，这样它会自动在所有部署目标中可用。

## 添加功能

### 代码应该放在哪里？

| 功能类型 | 位置 |
|-------------|----------|
| 几何、数学、结构操作 | `extensions/rust/`（Rust/WASM） |
| UI 组件和可视化 | `src/lib/`（Svelte） |
| 数据库、API、认证操作 | `server/`（FastAPI） |
| 设置和配置 | `src/lib/settings.ts` |

### 添加新的 WASM 函数

完整 WASM 开发流程见[开发指南](/zh/developer/development-guide)：

1. 在 Rust 中实现（`extensions/rust/src/wasm.rs`）
2. 使用 wasm-pack 构建
3. 添加 TypeScript 封装（`src/lib/structure/ferrox-wasm.ts`）
4. 添加类型（`src/lib/structure/ferrox-wasm-types.ts`）

### 命名约定

- 与 TypeScript 冲突的 WASM 函数名：加 `wasm_` 前缀
- 与 TypeScript 冲突的 WASM 类型名：加 `Wasm` 前缀
- 设置键：`snake_case`
- 组件名：`PascalCase.svelte`
- 工具函数：`snake_case`

## 测试

### 单元测试

单元测试位于 `tests/vitest/`，使用 **Vitest** 和 **happy-dom** 环境。

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm vitest tests/vitest/parse.test.ts

# Watch mode
pnpm vitest
```

### 添加测试

```typescript
import { describe, it, expect } from 'vitest'

describe(`my feature`, () => {
  it(`should do something`, () => {
    const result = my_function(input)
    expect(result).toBe(expected)
  })
})
```

### 测试夹具

测试数据放在 `tests/vitest/fixtures/` 中，支持的夹具格式包括：

- 用于结构解析测试的 CIF、POSCAR、XYZ 文件
- 用于期望输出对比的 JSON 文件

### E2E 测试

端到端测试位于 `tests/playwright/`，使用 **Playwright** 进行浏览器测试。

```bash
npx playwright test
```

## Pull Request 流程

1. 从 `main` 创建一个名称清晰的分支
2. 按上面的代码风格完成修改
3. 运行测试，`pnpm test` 和 `pnpm check` 都应通过
4. 写清楚 PR 描述，包含：
   - 这个修改做了什么
   - 为什么需要这个修改
   - 如何测试
5. 请求 review，PR 至少需要一个 approval
6. Squash and merge，合并时会压缩提交

### PR 描述模板

```markdown
## Summary
Brief description of changes.

## Changes
- List of specific changes

## Test plan
- [ ] Unit tests pass
- [ ] Manual testing steps
- [ ] Edge cases considered
```

## 文档

文档位于 `docs/`，使用 Markdown 编写。添加或修改功能时：

- 更新 `docs/modules/` 中相关模块文档
- 为面向用户的功能在 `docs/tutorials/` 中添加教程
- 如果修改解决了常见问题，更新 [FAQ](/zh/reference/faq)
- 在[更新日志](/zh/reference/changelog)中记录变更

## 报告问题

在 GitHub 上创建 issue，并包含：

1. **复现步骤** - 最小、具体的步骤
2. **期望行为** - 应该发生什么
3. **实际行为** - 实际发生了什么
4. **环境** - 浏览器、操作系统、CatGo 版本
5. **样例文件** - 如果问题涉及特定结构，请附上文件

## 获取帮助

- 通过 issue 报告 bug 或提出功能请求
- 查看 [FAQ](/zh/reference/faq) 中的常见问题
- 阅读[技巧与提示](/zh/guide/tips-and-tricks)了解使用建议

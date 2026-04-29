# 任务：迁移到 Rust-DAG 分支并保留本地功能

## ⚠️ 硬性约束

**只能修改 `D:/CatGO-dev/` 目录内的文件。禁止读写或修改该目录之外的任何文件（包括 `~/.claude/`、`~/.catgo/`、系统目录等）。**

## 背景

当前分支 `CatBot` 有大量未提交的本地修改（24 个文件 + 6 个新文件）。
目标是切换到 `origin/Rust-DAG`（比 CatBot 多 34 个 commit，263 个文件重构），
同时将本地功能完整移植过去。

**本地未提交功能（必须全部保留）：**

### 后端新功能
1. **VASP MD / Slow-Growth 支持**（核心功能）
   - `server/models/vasp.py`：新增 `MD`、`SLOW_GROWTH` 枚举值；新增 `ConstantPotentialMethod` enum（none/tpot/cpvasp）；`VASPInputRequest` 新增 slow-growth MD 参数（mdalgo, smass, tebeg, teend, nblock, lblueout, increm, iconst_content）和 TPOT/CP-VASP 参数
   - `server/utils/vasp_input.py`：约 +496 行，实现 slow-growth INCAR 生成、TPOT/CP-VASP 参数注入、ICONST 文件生成
   - `server/routers/vasp.py`：约 +146 行，新增 slow-growth 和 constant-potential 路由
   - `server/utils/vasp_report.py`（新文件）：解析 VASP REPORT 文件，提取 slow-growth 热力学积分数据（cc>/b_m> 行）

2. **HPC 增强**
   - `server/utils/hpc_client.py`：约 +27 行
   - `server/models/hpc.py`：约 +2 行
   - `server/routers/hpc.py`：约 +11 行
   - `server/utils/job_parser.py`：约 +12 行

3. **CP2K 修复**
   - `server/routers/cp2k.py`：约 +21 行/-5 行
   - `server/workflow/engines/cp2k.py`：约 -5 行

### 前端新功能
4. **API 类型扩展** `src/lib/api/compute.ts`：+149 行
   - `VASPCalculationType` 新增 `'md' | 'slow_growth'`
   - 新增 `ConstantPotentialMethod` 类型
   - `VASPInputRequest` 新增 slow-growth 和 TPOT/CP-VASP 字段
   - `VASPInputFiles` 新增 `iconst?`, `incar_nelect?`
   - 新增 slow-growth 相关 API 函数

5. **Export 增强** `src/lib/io/export.ts`：+352 行/-大量改动（需仔细对比）

6. **Settings** `src/lib/settings.ts`：+9 行

7. **新 Svelte 组件**
   - `src/lib/structure/SlowGrowthPane.svelte`（新文件）：slow-growth MD 分析面板，读 VASP REPORT，绘制自由能曲线
   - `src/lib/structure/ScaleBar.svelte`（新文件）：3D 视图比例尺 HTML 叠加层

8. **Structure 相关修改**
   - `src/lib/structure/ExportPane.svelte`：+528 行/-大量（VASP export 面板重构）
   - `src/lib/structure/Structure.svelte`：+84 行（集成 SlowGrowthPane、ScaleBar）
   - `src/lib/structure/StructureControls.svelte`：+6 行
   - `src/lib/structure/StructureScene.svelte`：+23 行
   - `src/lib/structure/ServerPane.svelte`：+27 行
   - `src/lib/structure/FileTree.svelte`：+15 行
   - `src/lib/io/fetch.ts`：+2 行
   - `src/lib/trajectory/parse.ts`：+53 行

---

## 执行步骤

### 步骤 1：保存本地修改为 patch

```bash
# 保存所有修改（包括未跟踪文件）到 patch 目录
mkdir -p /tmp/catgo-local-patch

# 保存 git diff（已跟踪文件的修改）
git diff HEAD > /tmp/catgo-local-patch/local_changes.patch

# 单独保存新文件（未跟踪）
cp server/utils/vasp_report.py /tmp/catgo-local-patch/
cp src/lib/structure/SlowGrowthPane.svelte /tmp/catgo-local-patch/
cp src/lib/structure/ScaleBar.svelte /tmp/catgo-local-patch/

echo "Patch saved successfully"
git diff HEAD --stat
```

### 步骤 2：提交本地修改到临时分支

```bash
git add -A
git commit -m "temp: save CatBot local changes before Rust-DAG migration"
```

### 步骤 3：切换到 Rust-DAG

```bash
# 拉取最新 Rust-DAG
git fetch origin Rust-DAG

# 创建本地 Rust-DAG 分支（从 CatBot 分叉，在此分支上 merge）
git checkout -b catbot-rust-dag-migration origin/Rust-DAG
```

### 步骤 4：Cherry-pick 或 merge 本地提交

```bash
# 找到刚才 temp commit 的 hash
TEMP_COMMIT=$(cd /tmp && git -C /d/CatGO-dev log --oneline CatBot | head -1 | cut -d' ' -f1)

# 将本地修改 cherry-pick 到新分支
git cherry-pick --no-commit $(git log --oneline CatBot | head -1 | cut -d' ' -f1)
```

**如果 cherry-pick 失败，改为手动 patch 方式：**

```bash
# 恢复新文件
cp /tmp/catgo-local-patch/vasp_report.py server/utils/vasp_report.py
cp /tmp/catgo-local-patch/SlowGrowthPane.svelte src/lib/structure/SlowGrowthPane.svelte
cp /tmp/catgo-local-patch/ScaleBar.svelte src/lib/structure/ScaleBar.svelte

# 尝试应用 patch（忽略已合并的部分）
git apply --3way /tmp/catgo-local-patch/local_changes.patch
```

### 步骤 5：处理冲突文件

冲突最多的文件（需手动检查）：
- `src/lib/structure/Structure.svelte` — Rust-DAG 重构了很多，本地加了 SlowGrowthPane 和 ScaleBar 集成
- `src/lib/structure/ExportPane.svelte` — Rust-DAG 重构了导出逻辑，本地大幅扩展了 VASP export
- `src/lib/structure/ServerPane.svelte` — 两边都有修改
- `src/lib/structure/FileTree.svelte` — 两边都有修改
- `src/lib/structure/StructureScene.svelte` — 两边都有修改
- `src/lib/trajectory/parse.ts` — 两边都有修改
- `server/utils/job_parser.py` — 两边都有修改

**处理原则：**
- Rust-DAG 的重构（架构变化）优先作为基础
- 本地的功能新增（slow-growth, constant-potential, scale-bar, VASP export）需移植进去
- 不要丢弃任何本地新增的 API 类型、UI 组件、后端逻辑

### 步骤 6：验证并修复 TypeScript 错误

```bash
pnpm check 2>&1 | head -100
```

修复所有类型错误（优先修复 compute.ts, vasp.py 相关的类型不匹配）。

---

## 测试验证（三轮）

### 第一轮：编译验证

```bash
# TypeScript/Svelte 类型检查
pnpm check

# 期望：0 new errors（相比 Rust-DAG 基线不新增错误）
# Rust-DAG 基线可能有预存 TS 错误，不算在内
```

### 第二轮：单元测试

```bash
pnpm vitest run 2>&1 | tail -30
# 期望：所有测试通过（与 Rust-DAG 基线一致）
```

### 第三轮：功能回归检查（代码审查）

逐一检查以下功能点的代码是否正确移植：

1. **VASP MD/Slow-Growth**
   - `server/models/vasp.py` 中 `VASPCalculationType` 包含 `MD` 和 `SLOW_GROWTH`
   - `server/models/vasp.py` 中 `ConstantPotentialMethod` enum 存在
   - `server/utils/vasp_input.py` 中有 slow-growth INCAR 生成逻辑
   - `server/utils/vasp_report.py` 文件存在且包含 `cc>` / `b_m>` 解析逻辑
   - `src/lib/api/compute.ts` 中 `VASPCalculationType` 包含 `'md' | 'slow_growth'`
   - `src/lib/api/compute.ts` 中 `ConstantPotentialMethod` 类型存在

2. **新 Svelte 组件**
   - `src/lib/structure/SlowGrowthPane.svelte` 存在，能被 Structure.svelte import
   - `src/lib/structure/ScaleBar.svelte` 存在，能被 Structure.svelte import

3. **ExportPane 功能**
   - ExportPane.svelte 能正确渲染（无 Svelte parse 错误）
   - 包含 VASP export 的 constant-potential 选项

4. **HPC 功能**
   - `server/utils/hpc_client.py` 的本地修改已移植
   - `server/routers/hpc.py` 的本地修改已移植

---

## 完成后

```bash
# 确认最终状态
git status
git log --oneline -5
pnpm check 2>&1 | grep -E "error|Error" | wc -l
```

如果 TypeScript 错误数量 ≤ Rust-DAG 基线错误数，迁移成功。

最后提交：
```bash
git add -A
git commit -m "feat: migrate CatBot features to Rust-DAG — slow-growth VASP, constant-potential, ScaleBar"
```

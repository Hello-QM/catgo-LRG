#!/usr/bin/env bash
# 无人值守迁移脚本：将 CatBot 本地功能移植到 Rust-DAG
# 用法：bash scripts/migrate-to-rust-dag.sh

set -e
cd "$(git rev-parse --show-toplevel)"

TASK_FILE="TASK_RUST_DAG_MIGRATION.md"
PROJECT_DIR="$(pwd)"

echo "=== CatGO Rust-DAG 迁移 ==="
echo "项目目录: $PROJECT_DIR"
echo "任务文件: $TASK_FILE"
echo ""

claude --dangerously-skip-permissions -p "$(cat <<'PROMPT'
请阅读并严格执行 TASK_RUST_DAG_MIGRATION.md 中描述的迁移任务。

## 核心约束（不可违反）
- 只能读写和修改 D:/CatGO-dev/ 目录内的文件
- 禁止修改该目录外的任何文件（~/.claude/、~/.catgo/ 等均不允许）
- 所有 git 操作只在该仓库内执行

## 执行要求
1. 完整执行 TASK_RUST_DAG_MIGRATION.md 中的全部步骤
2. 遇到合并冲突时，以 Rust-DAG 架构为基础，将本地新功能（slow-growth、constant-potential、ScaleBar 等）移植进去
3. 执行三轮测试验证（均已写在任务文件中）
4. 完成后提交一个 git commit

不要等待用户确认，自主完成全部步骤。
PROMPT
)"

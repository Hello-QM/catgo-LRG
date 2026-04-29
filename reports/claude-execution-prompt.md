# Claude Code 自动执行 Prompt

**用途:** 复制以下内容给一个新的 Claude Code 会话，让它自动执行所有 implementation prompts。

---

```
请阅读 reports/implementation-prompts-2026-03-17.md，按顺序从 Prompt 1 开始逐步执行。

## 代码规范

1. **注释要求**：
   - 每个函数写 docstring，说明功能、参数含义、返回值
   - 关键逻辑分支加行内注释，解释 **为什么** 这样做（不是 what，是 why）
   - 错误处理路径必须注释说明：什么情况会走到这里，为什么这样处理
   - 涉及 HPC/SLURM 交互的代码，注释说明对应的 SLURM 行为（如 "sacct 在作业结束后 N 分钟内可查"）
   - 魔数要注释来源（如 "4.92 eV = 2H₂O → O₂ + 4H⁺ + 4e⁻ 的标准自由能变化"）

2. **注释示例**：
   ```python
   # 指数退避：第 1 次失败等 30s，第 2 次 300s，第 3 次 1200s
   # 参考 jobflow-remote 的 delta_retry 模式
   delay = RETRY_DELAYS[min(poll_failures - 1, len(RETRY_DELAYS) - 1)]

   # sacct 在作业离开 squeue 后仍可查询终态（COMPLETED/FAILED/NODE_FAIL）
   # 但某些集群 sacct 有延迟（最多 ~5 分钟），所以首次查不到时继续轮询
   sacct_info = await hpc.scheduler.get_job_status_sacct(hpc.conn, job_id)

   # BFS 找所有下游节点：重置一个节点时，其所有后继也必须重置
   # 否则下游节点会使用旧的（已失效的）父节点结果
   queue = deque([step_id])
   ```

3. **不要过度注释**：
   - 自解释的代码不需要注释（如 `if not hpc: return`）
   - 不要注释 import 语句
   - 不要写 "这里做了 XX" 这种重复代码的注释

## 执行规则

1. 每个 Prompt 执行完后，运行验证命令确认无误
2. 验证通过后 commit（commit message 用 "feat:" 或 "fix:" 前缀）
3. 然后继续下一个 Prompt
4. 如果某个 Prompt 执行失败，记录错误原因到 reports/implementation-log.md，跳过继续下一个
5. 所有 Prompt 执行完后 git push

## 参考文档（遇到问题时查阅）
- reports/reference-code-patterns-2026-03-17.md — 来自 atomate2/jobflow 的代码模式
- reports/refactor-plan-2026-03-17.md — 文件拆分结构
- reports/bug-desktop-serve-hpc-2026-03-17.md — 已修复 bug 的记录
- reports/comparison-atomate2-jobflow-2026-03-17.md — 架构对比
- reports/feature-workflow-controls-2026-03-17.md — 工作流精细控制需求
- reports/feature-batch-node-2026-03-17.md — Batch Node 需求
- reports/high-throughput-catalysis-gap-analysis-2026-03-17.md — 高通量催化差距分析
- reports/improvement-roadmap-2026-03-17.md — 综合提升路线图
```

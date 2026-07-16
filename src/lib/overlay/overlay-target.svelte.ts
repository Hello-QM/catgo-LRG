/** Overlay 目标上下文基础设施 — 多视口下"这个弹层作用于谁"的唯一权威。
 *
 * 规则 (对象级弹层):
 * - 打开时用 create_viewport_target_context() 冻结目标 (稳定 viewer_id =
 *   `${tab_id}:${leaf_id}`), 提交/应用一律经 resolve_target_structure(ctx)
 *   解析冻结视口的活结构 — 禁止提交时重读全局 current/active 单例
 *   (current-structure 单例、无 panel_id 的 /view/structure/current 都是
 *   "显示窗口 2、实际操作窗口 1" 的根源)。
 * - "窗口 N" 是这里铸造的稳定显示编号: 首次按 pane 顺序编号, 之后布局重排
 *   不改号, 视口关闭后编号才可复用。业务逻辑永远用 viewer_id, 编号仅显示。
 * - 目标失效 (视口关闭/结构卸载) 由 validate_target() 判定, fixed 弹层
 *   必须据此禁用提交。
 */
import type { AnyStructure } from '$lib'
import {
  list_viewers,
  resolve_viewer,
  viewer_manifests_state,
} from '$lib/structure/viewer-registry.svelte'

export type OverlayScope =
  | `global`
  | `workspace`
  | `document`
  | `viewport`
  | `selection`
  | `workflow`
  | `job`

export type OverlayTargetPolicy = `fixed` | `follow-active` | `user-selectable`

export interface OverlayTargetContext {
  scope: OverlayScope
  workspace_id?: string
  document_id?: string
  /** 稳定视口标识 `${tab_id}:${leaf_id}` — 分屏/合并/重排均不变 */
  viewport_id?: string
  structure_id?: string
  workflow_id?: string
  job_id?: string
  /** 稳定显示编号 (铸造于打开时刻; 展示时优先读注册表活值) */
  display_index?: number
  display_name?: string
  file_name?: string
  selection_count?: number
  opened_from?: { viewport_id?: string; document_id?: string; source_component?: string }
}

export interface OverlayInstance {
  id: string
  type: string
  target: OverlayTargetContext
  policy: OverlayTargetPolicy
  parent_overlay_id?: string
  opened_at: number
  status: `active` | `invalid` | `closing`
}

const DEV = typeof import.meta !== `undefined` && !!import.meta.env?.DEV

/** 开发期断言: 违反目标契约在 dev 直接抛错, 生产降级为 console.warn */
export function overlay_assert(cond: unknown, msg: string): void {
  if (cond) return
  if (DEV) throw new Error(`[overlay] ${msg}`)
  console.warn(`[overlay] ${msg}`)
}

/** 结构化目标日志 — 排查"显示窗口 2、实际操作窗口 1"用 */
export function overlay_log(
  action: string,
  ctx: OverlayTargetContext | null | undefined,
  extra?: Record<string, unknown>,
): void {
  console.info(`[overlay]`, {
    action,
    scope: ctx?.scope,
    viewport_id: ctx?.viewport_id,
    display_index: ctx?.display_index,
    file_name: ctx?.file_name,
    workflow_id: ctx?.workflow_id,
    job_id: ctx?.job_id,
    source: ctx?.opened_from?.source_component,
    ...extra,
  })
}

// ── 稳定显示编号 ─────────────────────────────────────────────────────────
// viewer_id → n。首次为某 tab 铸号时按当时 pane 顺序整批分配 (直觉编号),
// 之后新视口取该 tab 最小空闲号; 已关视口的号在下次铸造时回收。
// 事件处理器/上下文创建时调用 (非响应式读), 无 $state 依赖。
const minted = new Map<string, number>()

export function viewport_display_index(viewport_id: string): number {
  const existing = minted.get(viewport_id)
  if (existing) return existing
  const { manifests } = viewer_manifests_state()
  for (const id of [...minted.keys()]) {
    if (!manifests[id]) minted.delete(id) // 回收已关视口的编号
  }
  const tab_id = viewport_id.split(`:`)[0]
  for (const m of list_viewers(tab_id)) { // pane 顺序整批铸号
    if (minted.has(m.viewer_id)) continue
    const used = new Set(
      [...minted.entries()]
        .filter(([id]) => id.split(`:`)[0] === tab_id)
        .map(([, n]) => n),
    )
    let n = 1
    while (used.has(n)) n += 1
    minted.set(m.viewer_id, n)
  }
  return minted.get(viewport_id) ?? 0
}

// ── 目标上下文 ───────────────────────────────────────────────────────────

/** 从触发源视口冻结一份对象级目标上下文 (弹层打开时调用一次) */
export function create_viewport_target_context(
  viewport_id: string,
  source_component?: string,
): OverlayTargetContext {
  overlay_assert(viewport_id, `viewport scope requires a viewport_id`)
  const m = viewer_manifests_state().manifests[viewport_id]
  return {
    scope: `viewport`,
    viewport_id,
    display_index: viewport_display_index(viewport_id),
    display_name: m?.label ?? m?.formula,
    file_name: m?.filename ?? undefined,
    opened_from: { viewport_id, source_component },
  }
}

export type TargetValidity =
  | { ok: true }
  | { ok: false; reason: `closed` | `empty` | `missing-id` }

/** 目标是否仍可操作: 视口存在且有结构 */
export function validate_target(ctx: OverlayTargetContext | null | undefined): TargetValidity {
  if (!ctx) return { ok: false, reason: `missing-id` }
  if (ctx.scope !== `viewport`) return { ok: true } // 其余 scope 由各自域校验
  if (!ctx.viewport_id) return { ok: false, reason: `missing-id` }
  const m = viewer_manifests_state().manifests[ctx.viewport_id]
  if (!m) return { ok: false, reason: `closed` }
  if (m.kind === `empty`) return { ok: false, reason: `empty` }
  return { ok: true }
}

/** 提交时解析冻结视口的活结构 — fixed 语义: 视口固定, 内容取当下 */
export function resolve_target_structure(
  ctx: OverlayTargetContext | null | undefined,
): AnyStructure | null {
  if (!ctx?.viewport_id) return null
  const { handle } = resolve_viewer(ctx.viewport_id)
  const s = handle?.get_structure()
  return (s as AnyStructure | undefined) ?? null
}

/** 异步操作开始时的目标快照: 结构按值捕获, 完成前不受视口切换影响 */
export interface OperationTargetSnapshot {
  context: OverlayTargetContext
  structure: AnyStructure | null
  taken_at: number
}

export function snapshot_operation_target(ctx: OverlayTargetContext): OperationTargetSnapshot {
  return { context: ctx, structure: resolve_target_structure(ctx), taken_at: Date.now() }
}

// ── 弹层实例注册表 (多实例隔离 + 视口角标数据源) ─────────────────────────
let instance_seq = 0
const instances = $state<Record<string, OverlayInstance>>({})

export function register_overlay_instance(args: {
  type: string
  target: OverlayTargetContext
  policy: OverlayTargetPolicy
  parent_overlay_id?: string
}): OverlayInstance {
  if (args.target.scope === `viewport`) {
    overlay_assert(args.target.viewport_id, `${args.type}: viewport scope without viewport_id`)
  }
  instance_seq += 1
  const inst: OverlayInstance = {
    id: `ov-${instance_seq}`,
    ...args,
    opened_at: Date.now(),
    status: `active`,
  }
  instances[inst.id] = inst
  overlay_log(`open`, inst.target, { overlay_type: inst.type, overlay_id: inst.id })
  return inst
}

export function close_overlay_instance(id: string): void {
  const inst = instances[id]
  if (!inst) return
  overlay_log(`close`, inst.target, { overlay_type: inst.type, overlay_id: id })
  delete instances[id]
}

export function overlay_instances_state(): { instances: Record<string, OverlayInstance> } {
  return {
    get instances() {
      return instances
    },
  }
}

// ── 视口联动高亮 (打开/切换目标时短促标示, 不动相机/选择/焦点) ────────────
const highlights = $state<Record<string, number>>({})

export function flash_viewport(viewport_id: string): void {
  highlights[viewport_id] = Date.now()
}

export function viewport_highlight_state(): { highlights: Record<string, number> } {
  return {
    get highlights() {
      return highlights
    },
  }
}

<script lang="ts">
  /**
   * StructureToolbar.svelte — 工具栏组件
   *
   * 从 Structure.svelte 抽取的工具栏按钮和测量模式下拉菜单。
   * 包含: 重置相机、全屏、手势控制、铅笔模式 UI、
   * Build/Analysis/Workflow/IO/Server/Chat/Terminal 工具栏按钮、测量模式选择器。
   *
   * 面板组件 (BuildPane, AnalysisPane 等) 通过 children snippet 从 Structure.svelte 传入，
   * 因为这些面板对 Structure.svelte 的状态有重度依赖（bind:structure, callbacks 等），
   * 通过 children snippet 保持对父组件作用域的直接访问。
   */
  import type { Snippet } from 'svelte'
  import type { AnyStructure, ElementSymbol } from '$lib'
  import { Icon, toggle_fullscreen } from '$lib'
  import type { GestureConfig } from '$lib/gesture/gesture-types'
  import type { Measurement } from './index'
  import type { MolecularFragment } from './controllers/fragments'
  import type { PencilModeController } from './controllers/pencil-mode.svelte'
  import { type create_interaction_controller } from './controllers/interaction.svelte'
  import { structure_to_poscar_str } from './export'
  import { writeRemoteFile } from '$lib/api/hpc'
  import { click_outside, tooltip } from 'svelte-multiselect'
  import { chat_position, set_chat_position } from '$lib/chat/chat-state.svelte'
  import { STATIC_ONLY } from '$lib/api/config'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { toolbar_state, set_toolbar_collapsed, set_toolbar_dock, toggle_toolbar_tool, toolbar_tool_hidden } from './toolbar-state.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

  let {
    // ── 只读状态 ──
    camera_has_moved = false,
    visible_buttons = false,
    hide_extra_tools = false,
    enable_measure_mode = false,
    fullscreen_toggle = undefined,
    hidden_toolbar_items = [] as string[],
    remote_origin = null,
    structure = undefined,
    molecular_fragments = [],
    reset_text = `Reset camera (or double-click)`,
    wrapper = undefined,

    // ── 铅笔控制器 (只读传入, 内部 getter/setter 可写) ──
    pencil,
    interaction,

    // ── 双向绑定状态 ($bindable) ──
    // 全屏
    fullscreen = $bindable(false),
    // 手势
    gesture_active = $bindable(false),
    gesture_config = $bindable({} as GestureConfig),
    gesture_art_mode = $bindable(false),
    show_gesture_settings = $bindable(false),
    // 铅笔
    selected_add_element = $bindable(`C` as ElementSymbol),
    periodic_table_visible = $bindable(false),
    selected_fragment = $bindable({} as MolecularFragment),
    // 面板开关
    build_pane_open = $bindable(false),
    analysis_pane_open = $bindable(false),
    workflow_pane_open = $bindable(false),
    io_pane_open = $bindable(false),
    server_pane_open = $bindable(false),
    plugin_hub_open = $bindable(false),
    large_system_mode = $bindable(false),
    webgpu_available = true,
    chat_pane_open = $bindable(false),
    // 测量
    measure_mode = $bindable<`distance` | `angle` | `dihedral`>(`distance`),
    measure_mode_active = $bindable(false),
    measure_menu_open = $bindable(false),
    measurements = $bindable<Measurement[]>([]),
    measured_sites = $bindable<number[]>([]),
    selected_measurement_id = $bindable<string | null>(null),
    selected_sites = $bindable<number[]>([]),
    current_continuous_measurement_sites = $bindable<number[]>([]),

    // ── 回调函数 ──
    reset_camera = () => {},
    delete_measurement = (_id: string) => {},
    delete_selected_atoms = () => {},
    on_popout_chat = undefined as (() => void) | undefined,
    on_upload_to_hpc = undefined as (() => void) | undefined,
    on_open_terminal = undefined as (() => void) | undefined,
    on_open_in_molstar = undefined as (() => void) | undefined,

    // ── 子组件 snippet (面板组件从 Structure.svelte 传入) ──
    children,
  }: {
    // 只读
    camera_has_moved?: boolean
    visible_buttons?: boolean
    hide_extra_tools?: boolean
    enable_measure_mode?: boolean
    fullscreen_toggle?: Snippet<[]> | boolean
    hidden_toolbar_items?: string[]
    remote_origin?: { session_id: string; file_path: string } | null
    structure?: AnyStructure
    molecular_fragments?: MolecularFragment[]
    reset_text?: string
    wrapper?: HTMLDivElement

    // 铅笔控制器
    pencil: PencilModeController
    interaction: ReturnType<typeof create_interaction_controller>

    // 双向绑定
    fullscreen?: boolean
    gesture_active?: boolean
    gesture_config?: GestureConfig
    gesture_art_mode?: boolean
    show_gesture_settings?: boolean
    selected_add_element?: ElementSymbol
    periodic_table_visible?: boolean
    selected_fragment?: MolecularFragment
    build_pane_open?: boolean
    analysis_pane_open?: boolean
    workflow_pane_open?: boolean
    io_pane_open?: boolean
    server_pane_open?: boolean
    plugin_hub_open?: boolean
    large_system_mode?: boolean
    webgpu_available?: boolean
    chat_pane_open?: boolean
    measure_mode?: `distance` | `angle` | `dihedral`
    measure_mode_active?: boolean
    measure_menu_open?: boolean
    measurements?: Measurement[]
    measured_sites?: number[]
    selected_measurement_id?: string | null
    selected_sites?: number[]
    current_continuous_measurement_sites?: number[]

    // 回调
    reset_camera?: () => void
    delete_measurement?: (id: string) => void
    delete_selected_atoms?: () => void
    on_popout_chat?: () => void
    on_upload_to_hpc?: () => void
    // Open a terminal as a pane-tree leaf (desktop). Replaces the old
    // side-panel terminal toggle.
    on_open_terminal?: () => void
    on_open_in_molstar?: () => void

    // 子组件 snippet
    children?: Snippet
  } = $props()

  // Touch-capability detection for the touch-mode buttons. `any-pointer: coarse`
  // is true when ANY available pointer is coarse (finger/stylus) — so it also
  // catches hybrid devices (touch laptops, a tablet with a mouse attached) that
  // `pointer: coarse` (primary pointer only) would miss. Kept reactive so it
  // updates if an input device is plugged/unplugged.
  let has_touch = $state(false)
  $effect(() => {
    if (typeof window === `undefined`) return
    const coarse = window.matchMedia?.(`(any-pointer: coarse)`)
    const update = () => {
      has_touch = (coarse?.matches ?? false) ||
        (typeof navigator !== `undefined` && navigator.maxTouchPoints > 0)
    }
    update()
    coarse?.addEventListener?.(`change`, update)
    return () => coarse?.removeEventListener?.(`change`, update)
  })

  // ── 工具栏收起 + 按钮自定义 ──
  // 状态在 toolbar-state.svelte.ts (localStorage 持久化),与 Structure.svelte 共享 ——
  // children 里自带 toggle 的面板 (optimize/info/controls) 也受同一列表控制。
  const TOOL_GROUPS = [
    { id: `view`, key: `structure.toolbar_group_view` },
    { id: `editing`, key: `structure.toolbar_group_editing` },
    { id: `analysis`, key: `structure.toolbar_group_analysis` },
    { id: `compute`, key: `structure.toolbar_group_compute` },
    { id: `assistant`, key: `structure.toolbar_group_assistant` },
  ] as const
  const TOOL_DEFS: { id: string; key: string; group: string }[] = [
    { id: `fullscreen`, key: `structure.toolbar_tool_fullscreen`, group: `view` },
    { id: `info`, key: `structure.toolbar_tool_info`, group: `view` },
    { id: `controls`, key: `structure.toolbar_tool_controls`, group: `view` },
    { id: `gauge`, key: `structure.large_system_mode`, group: `view` },
    { id: `molstar`, key: `structure.bio_open_in_molstar`, group: `view` },
    { id: `gesture`, key: `structure.toolbar_tool_gesture`, group: `editing` },
    { id: `pencil`, key: `structure.toolbar_tool_draw`, group: `editing` },
    { id: `build`, key: `structure.build_tools`, group: `editing` },
    { id: `optimize`, key: `structure.toolbar_tool_optimize`, group: `editing` },
    { id: `analysis`, key: `structure.analysis_tools`, group: `analysis` },
    { id: `measure`, key: `structure.toolbar_tool_measure`, group: `analysis` },
    { id: `workflow`, key: `common.workflow`, group: `compute` },
    { id: `server`, key: `structure.server_hpc`, group: `compute` },
    { id: `upload_hpc`, key: `structure.upload_to_hpc`, group: `compute` },
    { id: `terminal`, key: `structure.open_terminal`, group: `compute` },
    { id: `io`, key: `structure.import_export`, group: `compute` },
    { id: `chat`, key: `structure.ai_assistant`, group: `assistant` },
    { id: `plugin_hub`, key: `structure.plugin_hub`, group: `assistant` },
  ]
  let toolbar_edit_open = $state(false)
  let toolbar_edit_btn_el = $state<HTMLButtonElement | null>(null)
  let toolbar_edit_menu_el = $state<HTMLDivElement | null>(null)
  // 通用自适应浮层引擎 (自定义菜单 / 铅笔宫格 / 测量菜单共用):
  // fixed 定位, 按 dock 方向锚定 → 空间不足翻向对侧 → 两侧都不够则居中 →
  // 视口钳位 + 动态 max 尺寸 (内部滚动); resize 与内容尺寸变化实时重算。
  // 直接写 DOM, 不回写 $state; 传入 dock 使 attachment 随模式切换重建。
  function fit_popover(get_anchor: () => HTMLElement | null, _dock?: string) {
    return (node: HTMLElement) => {
      const place = () => {
        const anchor = get_anchor()
        if (!anchor) return
        const rect = anchor.getBoundingClientRect()
        const gap = 8
        const vw = window.innerWidth
        const vh = window.innerHeight
        // 极窄窗口: 不再贴栏浮出, 整体切换为居中模态 (类 Command Palette)
        const modal_mode = vw < 900
        node.style.maxWidth = modal_mode
          ? `${Math.min(520, vw - 2 * gap)}px`
          : `${vw - 2 * gap}px`
        node.style.maxHeight = `${vh - 2 * gap}px`
        const mw = node.offsetWidth
        const mh = node.offsetHeight
        let left: number
        let top: number
        let centered = false
        if (modal_mode) {
          left = (vw - mw) / 2
          top = Math.max(gap, (vh - mh) / 2)
          centered = true
        } else {
          if (toolbar_state.dock === `left`) {
            left = rect.right + gap
            if (left + mw > vw - gap) left = rect.left - mw - gap // 翻向左
          } else if (toolbar_state.dock === `top` || toolbar_state.dock === `bottom`) {
            left = rect.right - mw
          } else {
            left = rect.left - mw - gap
            if (left < gap) left = rect.right + gap // 翻向右
          }
          if (left < gap || left + mw > vw - gap) {
            left = (vw - mw) / 2 // 两侧都不够: 居中回退
            centered = true
          }
          // 侧向展开: 面板顶对齐按钮中心; 高度不足时向上偏移 (下方 clamp 兜底)
          top = toolbar_state.dock === `top`
            ? rect.bottom + gap
            : toolbar_state.dock === `bottom`
            ? rect.top - mh - gap
            : rect.top + rect.height / 2
          if (toolbar_state.dock === `top` && top + mh > vh - gap) {
            top = rect.top - mh - gap
          }
          if (toolbar_state.dock === `bottom` && top < gap) {
            top = rect.bottom + gap
          }
        }
        left = Math.max(gap, Math.min(left, vw - mw - gap))
        top = Math.max(gap, Math.min(top, vh - mh - gap))
        node.style.left = `${left}px`
        node.style.top = `${top}px`
        node.style.right = `auto`
        node.classList.toggle(`popover-modal`, centered)
      }
      place()
      const ro = new ResizeObserver(place) // 宫格数量/内容变化 → 重算列数后重定位
      ro.observe(node)
      window.addEventListener(`resize`, place)
      return () => {
        ro.disconnect()
        window.removeEventListener(`resize`, place)
      }
    }
  }
  let pencil_btn_el = $state<HTMLButtonElement | null>(null)
  let measure_btn_el = $state<HTMLButtonElement | null>(null)
  let toolbar_el = $state<HTMLElement | null>(null)
  let rail_overflowing = $state(false)
  // Tooltip: 单例 Portal 到 document.body (逃出 .structure 的 containment 堆叠上下文,
  // 分隔线/邻居面板永远盖不住)。树内 .struct-toolbar-tooltip 仅作 i18n 文案源 (display:none)。
  // 主体+箭头同一浮层根节点; 右→左→上→下探测, 整窗为界, 钳位后箭头仍指按钮中心。
  $effect(() => {
    const root_el = toolbar_el
    if (!root_el || typeof document === `undefined`) return
    const tip = document.createElement(`div`)
    tip.className = `struct-tip-root`
    const body = document.createElement(`div`)
    body.className = `struct-tip-body`
    const arrow = document.createElement(`div`)
    arrow.className = `struct-tip-arrow`
    tip.append(body, arrow)
    document.body.appendChild(tip)
    let cur: HTMLElement | null = null
    const hide = () => {
      cur = null
      tip.classList.remove(`visible`)
    }
    const place = () => {
      if (!cur || !cur.isConnected) return hide()
      const src = cur.querySelector<HTMLElement>(`.struct-toolbar-tooltip`)
      const btn = cur.querySelector<HTMLElement>(`button`) ?? cur
      if (!src || !src.textContent?.trim()) return hide()
      // 按钮激活/展开时不打扰 (原 :has() 规则的 JS 等价)
      if (cur.querySelector(`.active, [aria-expanded='true'], [aria-pressed='true']`)) {
        return hide()
      }
      body.textContent = src.textContent
      const r = btn.getBoundingClientRect()
      const gap = 8
      const pad = 8
      const vw = window.innerWidth
      const vh = window.innerHeight
      tip.classList.add(`visible`)
      const tw = tip.offsetWidth
      const th = tip.offsetHeight
      const fits = {
        right: r.right + gap + tw <= vw - pad,
        left: r.left - gap - tw >= pad,
        top: r.top - gap - th >= pad,
        bottom: r.bottom + gap + th <= vh - pad,
      }
      // 默认方向随停靠位置; 放不下按 对侧→交叉轴 降级 (flip 不覆盖默认)
      const pref: Record<string, (keyof typeof fits)[]> = {
        top: [`bottom`, `top`, `right`, `left`],
        bottom: [`top`, `bottom`, `right`, `left`],
        left: [`right`, `left`, `top`, `bottom`],
        right: [`left`, `right`, `top`, `bottom`],
      }
      const order = pref[toolbar_state.dock] ?? pref.right
      const side = order.find((s) => fits[s]) ?? order[0]
      let left: number
      let top: number
      if (side === `right`) {
        left = r.right + gap
        top = r.top + r.height / 2 - th / 2
      } else if (side === `left`) {
        left = r.left - gap - tw
        top = r.top + r.height / 2 - th / 2
      } else if (side === `top`) {
        left = r.left + r.width / 2 - tw / 2
        top = r.top - gap - th
      } else {
        left = r.left + r.width / 2 - tw / 2
        top = r.bottom + gap
      }
      left = Math.max(pad, Math.min(left, vw - tw - pad))
      top = Math.max(pad, Math.min(top, vh - th - pad))
      tip.style.left = `${left}px`
      tip.style.top = `${top}px`
      tip.dataset.side = side
      const off = side === `left` || side === `right`
        ? Math.max(10, Math.min(th - 10, r.top + r.height / 2 - top))
        : Math.max(10, Math.min(tw - 10, r.left + r.width / 2 - left))
      if (side === `left`) {
        arrow.style.left = `${tw}px`
        arrow.style.top = `${off}px`
      } else if (side === `right`) {
        arrow.style.left = `0px`
        arrow.style.top = `${off}px`
      } else if (side === `top`) {
        arrow.style.top = `${th}px`
        arrow.style.left = `${off}px`
      } else {
        arrow.style.top = `0px`
        arrow.style.left = `${off}px`
      }
    }
    const over = (e: Event) => {
      const wrap = (e.target as HTMLElement).closest?.(`.struct-toolbar-tooltip-wrap`)
      if (!wrap || !root_el.contains(wrap)) return
      cur = wrap as HTMLElement
      place()
    }
    const out = (e: Event) => {
      if (!cur) return
      const to = (e as PointerEvent).relatedTarget as HTMLElement | null
      if (!to || !cur.contains(to)) hide()
    }
    root_el.addEventListener(`pointerover`, over)
    root_el.addEventListener(`pointerout`, out)
    root_el.addEventListener(`focusin`, over)
    root_el.addEventListener(`focusout`, out)
    root_el.addEventListener(`click`, () => queueMicrotask(place), true)
    root_el.addEventListener(`scroll`, place, true)
    window.addEventListener(`resize`, place)
    return () => {
      root_el.removeEventListener(`pointerover`, over)
      root_el.removeEventListener(`pointerout`, out)
      root_el.removeEventListener(`focusin`, over)
      root_el.removeEventListener(`focusout`, out)
      root_el.removeEventListener(`scroll`, place, true)
      window.removeEventListener(`resize`, place)
      tip.remove()
    }
  })
  // 小面板 (多宫格分屏) 里工具比面板高时: 栏内滚动; 放得下时保持 visible,
  // 侧向 tooltip 不被裁。直接 toggle class, 不回写 $state。
  $effect(() => {
    void toolbar_state.hidden_by_dock
    void toolbar_state.dock
    void toolbar_state.collapsed
    const el = toolbar_el
    if (!el) return
    const update = () => {
      rail_overflowing = el.scrollHeight > el.clientHeight + 1 ||
        el.scrollWidth > el.clientWidth + 1
    }
    requestAnimationFrame(update)
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const mo = new MutationObserver(update) // 手势/铅笔激活等追加按钮 → 内容变高
    mo.observe(el, { childList: true, subtree: true })
    window.addEventListener(`resize`, update)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener(`resize`, update)
    }
  })
  // 父组件强制隐藏 (hidden_toolbar_items prop) 优先于用户选择
  const tool_hidden = (id: string): boolean =>
    hidden_toolbar_items.includes(id) || toolbar_tool_hidden(id)
  // 该工具在当前实例是否真实存在 —— 不存在的不进自定义菜单
  const tool_available = (id: string): boolean => {
    switch (id) {
      case `fullscreen`:
        return Boolean(fullscreen_toggle)
      case `measure`:
        return enable_measure_mode
      case `molstar`:
        return !hide_extra_tools && Boolean(on_open_in_molstar)
      case `build`:
      case `io`:
      case `chat`:
        return !hide_extra_tools
      case `analysis`:
      case `workflow`:
      case `server`:
      case `upload_hpc`:
      case `plugin_hub`:
      case `terminal`:
        return !hide_extra_tools && !STATIC_ONLY
      default:
        return true
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === `Escape` && toolbar_edit_open) toolbar_edit_open = false
  }}
/>

<section
  bind:this={toolbar_el}
  data-placement={toolbar_state.dock}
  class:visible={visible_buttons}
  class:collapsed={toolbar_state.collapsed}
  class:overflowing={rail_overflowing}
  class:dock-left={toolbar_state.dock === `left`}
  class:dock-top={toolbar_state.dock === `top`}
  class:dock-bottom={toolbar_state.dock === `bottom`}
  class="control-buttons"
>
  {#if visible_buttons}
    {#if !toolbar_state.collapsed}
    <!-- === View / Navigation === -->
    {#if camera_has_moved}
      <button class="reset-camera tb-left" style="--tb-order: 5" onclick={reset_camera} title={reset_text === `Reset camera (or double-click)` ? t('structure.reset_camera') : reset_text}>
        <Icon icon="Reset" />
      </button>
    {/if}
    {#if fullscreen_toggle && !tool_hidden(`fullscreen`)}
      <button
        type="button"
        onclick={() => fullscreen_toggle && toggle_fullscreen(wrapper)}
        title={fullscreen ? t('structure.exit_fullscreen') : t('structure.enter_fullscreen')}
        aria-pressed={fullscreen}
        class="fullscreen-toggle tb-left"
        style="padding: 0; --tb-order: 70"
        {@attach tooltip()}
      >
        {#if typeof fullscreen_toggle === `function`}
          {@render fullscreen_toggle()}
        {:else}
          <Icon icon="{fullscreen ? `Exit` : ``}Fullscreen" />
        {/if}
      </button>
    {/if}

    <!-- === Gesture Control === -->
    {#if !tool_hidden(`gesture`)}
    <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 50">
      <button
        type="button"
        onclick={() => {
          gesture_active = !gesture_active
          gesture_config = { ...gesture_config, enabled: gesture_active }
        }}
        class="gesture-toggle"
        class:active={gesture_active}
        aria-pressed={gesture_active}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
          <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
          <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
          <path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </svg>
      </button>
      <span class="struct-toolbar-tooltip" role="tooltip">{gesture_active ? t('structure.disable_gesture') : t('structure.enable_gesture')}</span>
    </span>
    {#if gesture_active}
      <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 50">
        <button
          type="button"
          onclick={() => { gesture_art_mode = !gesture_art_mode }}
          class="gesture-toggle art"
          class:active={gesture_art_mode}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="13.5" cy="6.5" r="2.5" />
            <circle cx="17" cy="15" r="1.5" />
            <circle cx="8.5" cy="14.5" r="1.5" />
            <circle cx="6.5" cy="8" r="1.5" />
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
          </svg>
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{gesture_art_mode ? t('structure.exit_art_mode') : t('structure.enter_art_mode')}</span>
      </span>
      <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 50">
        <button
          type="button"
          onclick={() => { show_gesture_settings = !show_gesture_settings }}
          class="gesture-toggle settings"
          class:active={show_gesture_settings}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{show_gesture_settings ? t('structure.close_voice_settings') : t('structure.open_voice_settings')}</span>
      </span>
    {/if}
    {/if}

    <!-- === Touch interaction modes (no modifier keys on touch devices) === -->
    {#if has_touch}
      <div class="touch-mode-container tb-left" style="--tb-order: 44">
        <span class="struct-toolbar-tooltip-wrap">
          <button
            type="button"
            class="touch-mode-toggle"
            class:active={interaction.touch_mode === `box`}
            aria-pressed={interaction.touch_mode === `box`}
            onclick={() => interaction.touch_mode = interaction.touch_mode === `box` ? `none` : `box`}
          >{t('structure.touch_box_select')}</button>
          <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.touch_box_select_hint')}</span>
        </span>
        <span class="struct-toolbar-tooltip-wrap">
          <button
            type="button"
            class="touch-mode-toggle"
            class:active={interaction.touch_mode === `move`}
            aria-pressed={interaction.touch_mode === `move`}
            onclick={() => interaction.touch_mode = interaction.touch_mode === `move` ? `none` : `move`}
          >{t('structure.touch_move_atoms')}</button>
          <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.touch_move_atoms_hint')}</span>
        </span>
        <span class="struct-toolbar-tooltip-wrap">
          <button
            type="button"
            class="touch-mode-toggle"
            class:active={interaction.touch_mode === `rotate`}
            aria-pressed={interaction.touch_mode === `rotate`}
            onclick={() => interaction.touch_mode = interaction.touch_mode === `rotate` ? `none` : `rotate`}
          >{t('structure.touch_rotate_atoms')}</button>
          <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.touch_rotate_atoms_hint')}</span>
        </span>
        <span class="struct-toolbar-tooltip-wrap">
          <button
            type="button"
            class="touch-mode-toggle touch-delete"
            disabled={selected_sites.length === 0}
            aria-label={t('structure.touch_delete_atoms')}
            onclick={() => delete_selected_atoms()}
          >{t('structure.touch_delete_atoms')}</button>
          <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.touch_delete_atoms_hint')}</span>
        </span>
      </div>
    {/if}

    <!-- === Structure Editing (Pencil Mode) === -->
    {#if !tool_hidden(`pencil`)}
    <div class="pencil-mode-container" style="--tb-order: 10">
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          onclick={() => {
            pencil.pencil_mode_active = !pencil.pencil_mode_active
            if (!pencil.pencil_mode_active) {
              pencil.pencil_drag_active = false
              pencil.pencil_anchor_idx = null
              pencil.pencil_ghost_atom = null
            }
          }}
          class="pencil-toggle"
          bind:this={pencil_btn_el}
          class:active={pencil.pencil_mode_active}
          aria-pressed={pencil.pencil_mode_active}
        >
          <Icon icon="Pencil" style={pencil.pencil_mode_active ? "color: var(--accent-color, #007acc)" : ""} />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{pencil.pencil_mode_active ? t('structure.exit_draw_mode') : t('structure.draw_mode_hint')}</span>
      </span>
      {#if pencil.pencil_mode_active}
        <button
          type="button"
          aria-label={t('structure.exit_draw_mode_btn')}
          title={t('structure.exit_draw_mode_btn')}
          onclick={() => {
            pencil.pencil_mode_active = false
            pencil.pencil_drag_active = false
            pencil.pencil_anchor_idx = null
            pencil.pencil_ghost_atom = null
          }}
          style="color: var(--accent-color, #007acc);"
        >
          <Icon icon="Cross" />
        </button>
      {/if}
      <!-- Pencil mode selector (atoms vs fragments) — dropdown below button -->
      {#if pencil.pencil_mode_active}
        <div
          class="pencil-mode-selector"
          {@attach fit_popover(() => pencil_btn_el, toolbar_state.dock)}
        >
          <div class="mode-toggle">
            <button
              type="button"
              class="mode-btn"
              class:active={pencil.pencil_add_mode === 'atom'}
              onclick={() => pencil.pencil_add_mode = 'atom'}
              title={t('structure.add_atoms')}
            >
              {t('common.atoms')}
            </button>
            <button
              type="button"
              class="mode-btn"
              class:active={pencil.pencil_add_mode === 'fragment'}
              onclick={() => { pencil.pencil_add_mode = 'fragment'; pencil.selected_bonds = []; pencil.bond_first_atom = null }}
              title={t('structure.add_fragments')}
            >
              {t('structure.fragments')}
            </button>
            <button
              type="button"
              class="mode-btn"
              class:active={pencil.pencil_add_mode === 'bonds'}
              onclick={() => { pencil.pencil_add_mode = 'bonds'; pencil.selected_bonds = []; pencil.bond_first_atom = null }}
              title={t('structure.add_remove_bonds')}
            >
              {t('structure.bonds')}
            </button>
          </div>
          {#if pencil.pencil_add_mode === 'bonds'}
            <div class="bond-mode-status">
              {#if pencil.selected_bonds.length > 0}
                <span style="color: var(--warning-color)">{t('structure.bonds_selected', { n: pencil.selected_bonds.length })}</span> — {t('structure.press_delete_to_remove')}
              {:else if pencil.bond_first_atom !== null}
                {t('structure.click_second_atom')}
              {:else}
                {t('structure.click_atom_or_bond')}
              {/if}
            </div>
          {/if}
          {#if pencil.pencil_add_mode === 'atom'}
            <div class="element-quick-selector">
              {#each [`H`, `C`, `N`, `O`, `S`, `F`, `Cl`, `Br`] as elem}
                <button
                  type="button"
                  class="element-btn"
                  class:selected={selected_add_element === elem}
                  onclick={() => selected_add_element = elem as ElementSymbol}
                  title={t('structure.add_elem_atoms', { elem })}
                >
                  {elem}
                </button>
              {/each}
              <button
                type="button"
                class="element-btn more-elements"
                onclick={() => periodic_table_visible = true}
                title={t('structure.select_from_pt')}
              >
                ···
              </button>
            </div>
          {:else if pencil.pencil_add_mode === 'fragment'}
            <div class="fragment-selector">
              <div class="fragment-categories">
                {#each ['ring', 'alkyl', 'chain', 'functional'] as cat}
                  {@const cat_fragments = molecular_fragments.filter(f => f.category === cat)}
                  {#if cat_fragments.length > 0}
                    <span class="category-label">{cat === 'alkyl' ? t('structure.alkyl') : cat === 'ring' ? t('structure.rings') : cat === 'chain' ? t('structure.chains') : t('structure.functional')}</span>
                    {#each cat_fragments as frag}
                      <button
                        type="button"
                        class="fragment-btn"
                        class:selected={selected_fragment.name === frag.name}
                        onclick={() => selected_fragment = frag}
                        title={`${frag.name} (${frag.formula})`}
                      >
                        {frag.name}
                      </button>
                    {/each}
                  {/if}
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
    {/if}

    <!-- === Large-system performance mode (always visible — also in trajectory/large views) === -->
    {#if !tool_hidden(`gauge`)}
    <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 68">
      <button
        type="button"
        disabled={!webgpu_available}
        onclick={() => { if (webgpu_available) large_system_mode = !large_system_mode }}
        class="build-tools-toggle"
        class:active={large_system_mode}
        aria-pressed={large_system_mode}
      >
        <Icon icon="Gauge" />
      </button>
      <span class="struct-toolbar-tooltip" role="tooltip">{webgpu_available ? t('structure.large_system_mode') : t('structure.large_system_mode_unavailable')}</span>
    </span>
    {/if}

    {#if !hide_extra_tools}
      <!-- === Build Tools === -->
      {#if !tool_hidden(`build`)}
      <span class="struct-toolbar-tooltip-wrap" style="--tb-order: 12">
        <button
          type="button"
          onclick={() => { build_pane_open = !build_pane_open }}
          class="build-tools-toggle"
          class:active={build_pane_open}
        >
          <Icon icon="Hammer" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.build_tools')}</span>
      </span>
      {/if}

      {#if !tool_hidden(`analysis`) && !STATIC_ONLY}
      <!-- === Analysis Tools === -->
      <!-- Gated like workflow/server below: AnalysisPane's DOS/band/COHP/freq/charge
           sub-tabs are backend-only (no WASM fallback), so on STATIC_ONLY (web + the
           iOS build) they'd 503. MobileWorkspace also lists 'analysis' in
           HIDDEN_TOOLBAR — this is the check that actually honours it. -->
      <span class="struct-toolbar-tooltip-wrap" style="--tb-order: 14">
        <button
          type="button"
          onclick={() => { analysis_pane_open = !analysis_pane_open }}
          class="build-tools-toggle"
          class:active={analysis_pane_open}
        >
          <Icon icon="ChartLine" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.analysis_tools')}</span>
      </span>
      {/if}

      {#if on_open_in_molstar && !tool_hidden(`molstar`)}
      <!-- === Open current structure in the Mol* bio viewer === -->
      <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 64">
        <button
          type="button"
          onclick={() => on_open_in_molstar?.()}
          class="build-tools-toggle"
        >
          <Icon icon="Dna" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.bio_open_in_molstar')}</span>
      </span>
      {/if}

      {#if !tool_hidden(`workflow`) && !STATIC_ONLY}
      <!-- === Workflow === -->
      <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 52">
        <button
          type="button"
          onclick={() => { workflow_pane_open = !workflow_pane_open }}
          class="build-tools-toggle"
          class:active={workflow_pane_open}
        >
          <Icon icon="Workflow" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('common.workflow')}</span>
      </span>
      {/if}

      <!-- === IO (Import/Export) === -->
      {#if !tool_hidden(`io`)}
      <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 54">
        <button
          type="button"
          onclick={() => { io_pane_open = !io_pane_open }}
          class="build-tools-toggle"
          class:active={io_pane_open}
        >
          <Icon icon="FileIO" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.import_export')}</span>
      </span>
      {/if}

      {#if !hidden_toolbar_items.includes('server') && !STATIC_ONLY}
      <!-- === Server (HPC) === -->
      {#if !tool_hidden(`server`)}
      <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 56">
        <button
          type="button"
          onclick={() => { server_pane_open = !server_pane_open }}
          class="build-tools-toggle"
          class:active={server_pane_open}
        >
          <Icon icon="Server" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.server_hpc')}</span>
      </span>
      {/if}
      <!-- === Upload current structure to HPC === -->
      {#if !tool_hidden(`upload_hpc`)}
      <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 58">
        <button
          type="button"
          onclick={() => on_upload_to_hpc?.()}
          class="build-tools-toggle"
        >
          <Icon icon="Cloud" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.upload_to_hpc')}</span>
      </span>
      {/if}
      {/if}

      {#if !tool_hidden(`plugin_hub`) && !STATIC_ONLY}
      <!-- === Plugin Hub === -->
      <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 66">
        <button
          type="button"
          onclick={() => { plugin_hub_open = !plugin_hub_open }}
          class="build-tools-toggle"
          class:active={plugin_hub_open}
        >
          <Icon icon="PluginHub" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.plugin_hub')}</span>
      </span>
      {/if}

      {#if !tool_hidden(`chat`)}
      <!-- === AI Chat === -->
      <!-- Shown in STATIC_ONLY too: CatBot runs the client-direct tool-calling
           loop in-browser (no backend) under static deploys. See is_client_direct. -->

      <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 62">
        <button
          type="button"
          onclick={() => {
            if (chat_position.value === `popout`) set_chat_position(`right`)
            chat_pane_open = !chat_pane_open
          }}
          class="build-tools-toggle"
          class:active={chat_pane_open}
        >
          <Icon icon="Chat" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.ai_assistant')}</span>
      </span>
      {/if}

      {#if !tool_hidden(`terminal`) && !STATIC_ONLY}
      <!-- === Terminal === — opens a terminal pane-tree leaf (no longer a
           side-panel toggle). -->
      <span class="struct-toolbar-tooltip-wrap tb-left" style="--tb-order: 60">
        <button
          type="button"
          onclick={() => on_open_terminal?.()}
          class="build-tools-toggle"
        >
          <Icon icon="Terminal" />
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.open_terminal')}</span>
      </span>
      {/if}

      <!-- === Push structure back to remote === -->
      {#if remote_origin && structure}
        <button
          type="button"
          onclick={async () => {
            if (!remote_origin || !structure) return
            try {
              const content = structure_to_poscar_str(structure)
              const result = await writeRemoteFile(remote_origin.session_id, remote_origin.file_path, content)
              if (result.success) {
                console.log(`Saved to ${remote_origin.file_path}`)
              }
            } catch (e) {
              console.error(`Push-back failed:`, e)
            }
          }}
          title={t('structure.save_back_to', { path: remote_origin.file_path })}
          class="build-tools-toggle push-back-btn tb-left" style="--tb-order: 72"
          {@attach tooltip()}
        >
          &#x21E7;
        </button>
      {/if}

      <!-- [2025-02] Removed Lattice Editor and Adsorption Sites toolbar buttons
           to reduce toolbar clutter. Functionality preserved in Build dropdown pane. -->
    {/if}

    <!-- === Analysis & Computation: Measurement Mode === -->
    {#if enable_measure_mode && !tool_hidden(`measure`)}
      <div
        class="measure-mode-dropdown"
        style="--tb-order: 16"
        {@attach click_outside({ callback: () => measure_menu_open = false })}
      >
        <span class="struct-toolbar-tooltip-wrap">
          <button
            bind:this={measure_btn_el}
            onclick={() => (measure_menu_open = !measure_menu_open)}
            class="view-mode-button"
            class:active={measure_menu_open || measure_mode_active}
            aria-expanded={measure_menu_open}
          >
            {#if measure_mode_active}
              <Icon
                icon={({ distance: `Ruler`, angle: `Angle`, dihedral: `Angle` } as const)[measure_mode]}
                style="color: var(--accent-color, #007acc)"
              />
            {:else if selected_sites.length > 0}
              <span class="selection-limit-text">
                {selected_sites.length}
              </span>
            {:else}
              <Icon
                icon={({ distance: `Ruler`, angle: `Angle`, dihedral: `Angle` } as const)[measure_mode]}
              />
            {/if}
          </button>
          <span class="struct-toolbar-tooltip" role="tooltip">{measure_mode_active
            ? t('structure.continuous_mode_on', { mode: measure_mode })
            : selected_sites.length > 0
              ? t('structure.atoms_selected_click', { n: selected_sites.length })
              : t('structure.select_atoms_then_click')}</span>
        </span>
        {#if measure_mode_active}
          <button
            type="button"
            aria-label={t('structure.exit_continuous_mode')}
            title={t('structure.exit_continuous_mode')}
            onclick={() => {
              measure_mode_active = false
              current_continuous_measurement_sites = []
            }}
            style="color: var(--accent-color, #007acc);"
          >
            <Icon icon="Cross" />
          </button>
        {:else if (selected_sites?.length ?? 0) > 0}
          <button
            type="button"
            aria-label={t('structure.clear_selection')}
            title={t('structure.clear_selection')}
            onclick={() => selected_sites = []}
          >
            <Icon icon="Cross" />
          </button>
        {/if}
        {#if measurements.length > 0}
          <button
            type="button"
            aria-label={t('structure.clear_all_measurements')}
            title={t('structure.clear_all_measurements')}
            onclick={() => {
              measurements = []
              measured_sites = []
              selected_measurement_id = null
            }}
            style="display: flex; align-items: center; gap: 2px;"
          >
            <Icon icon="Ruler" style="transform: scale(0.8)" />
            <span style="font-weight: bold;">×</span>
          </button>
        {/if}
        {#if measure_menu_open}
          {@const measure_options = [
            { mode: `distance` as const, icon: `Ruler` as const, label: t('structure.distance'), scale: 1.1, min_atoms: 2 },
            { mode: `angle` as const, icon: `Angle` as const, label: t('structure.angle'), scale: 1.3, min_atoms: 3 },
            { mode: `dihedral` as const, icon: `Angle` as const, label: t('structure.dihedral'), scale: 1.3, min_atoms: 4 },
          ]}
          <div
            class="view-mode-dropdown measure-menu-popover"
            {@attach fit_popover(() => measure_btn_el, toolbar_state.dock)}
          >
            {#each measure_options as { mode, icon, label, scale, min_atoms } (mode)}
              <button
                class="view-mode-option"
                class:selected={measure_mode === mode && measure_mode_active}
                title={selected_sites.length >= min_atoms
                  ? t('structure.measure_label', { label })
                  : t('structure.enter_label_mode', { label })}
                onclick={(event) => {
                  event.stopPropagation()
                  measure_mode = mode
                  measure_menu_open = false

                  // If enough atoms selected, measure them immediately
                  if (selected_sites.length >= min_atoms) {
                    const sites_to_measure = [...selected_sites]
                    measure_mode_active = false
                    const new_measurements: Measurement[] = []
                    if (mode === `distance`) {
                      for (let i = 0; i < sites_to_measure.length; i++) {
                        for (let j = i + 1; j < sites_to_measure.length; j++) {
                          new_measurements.push({
                            id: `meas_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${i}_${j}`,
                            type: mode,
                            sites: [sites_to_measure[i], sites_to_measure[j]]
                          })
                        }
                      }
                    } else {
                      new_measurements.push({
                        id: `meas_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                        type: mode,
                        sites: sites_to_measure
                      })
                    }
                    measurements = [...measurements, ...new_measurements]
                    selected_sites = []
                  } else {
                    // Not enough atoms - enter continuous measurement mode
                    measure_mode_active = true
                    current_continuous_measurement_sites = []
                  }
                }}
              >
                <Icon {icon} style="transform: scale({scale})" />
                <span>{label}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if selected_measurement_id}
      {@const selected_meas = measurements.find(m => m.id === selected_measurement_id)}
      {#if selected_meas}
        <div class="selected-measurement-indicator">
          <span>{t('structure.type_selected', { type: selected_meas.type === 'distance' ? t('structure.distance') : selected_meas.type === 'angle' ? t('structure.angle') : t('structure.dihedral') })}</span>
          <button
            type="button"
            aria-label={t('structure.delete_measurement')}
            title={t('structure.delete_measurement')}
            onclick={() => delete_measurement(selected_measurement_id!)}
          >
            <Icon icon="Close" style="transform: scale(0.8)" />
          </button>
        </div>
      {/if}
    {/if}

    <!-- 面板组件通过 children snippet 从 Structure.svelte 传入 -->
    {@render children?.()}

    <div class="toolbar-flex-spacer" aria-hidden="true"></div>

    <!-- === 工具栏自定义: 勾选哪些按钮显示 (分组) === -->
    <div
      class="toolbar-edit-container"
      style="--tb-order: 90"
      {@attach click_outside({ callback: () => toolbar_edit_open = false })}
    >
      <span class="struct-toolbar-tooltip-wrap">
        <button
          type="button"
          bind:this={toolbar_edit_btn_el}
          class="toolbar-edit-toggle"
          class:active={toolbar_edit_open}
          aria-expanded={toolbar_edit_open}
          onclick={() => toolbar_edit_open = !toolbar_edit_open}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="4" y1="6" x2="20" y2="6" /><circle cx="9" cy="6" r="2.2" />
            <line x1="4" y1="12" x2="20" y2="12" /><circle cx="15" cy="12" r="2.2" />
            <line x1="4" y1="18" x2="20" y2="18" /><circle cx="7" cy="18" r="2.2" />
          </svg>
        </button>
        <span class="struct-toolbar-tooltip" role="tooltip">{t('structure.toolbar_customize')}</span>
      </span>
      {#if toolbar_edit_open}
        <div
          class="view-mode-dropdown toolbar-edit-menu"
          bind:this={toolbar_edit_menu_el}
          {@attach fit_popover(() => toolbar_edit_btn_el, toolbar_state.dock)}
        >
          <div class="toolbar-edit-group">{t(`structure.toolbar_dock`)}</div>
          <div class="toolbar-dock-row">
            {#each [[`top`, `structure.toolbar_dock_top`], [`bottom`, `structure.toolbar_dock_bottom`], [`left`, `structure.toolbar_dock_left`], [`right`, `structure.toolbar_dock_right`]] as const as [dock, key] (dock)}
              <button
                type="button"
                class="toolbar-dock-btn"
                class:active={toolbar_state.dock === dock}
                onclick={() => set_toolbar_dock(dock)}
              >{t(key)}</button>
            {/each}
          </div>
          {#each TOOL_GROUPS as group (group.id)}
            {@const items = TOOL_DEFS.filter((d) =>
              d.group === group.id &&
              !hidden_toolbar_items.includes(d.id) &&
              tool_available(d.id)
            )}
            {#if items.length > 0}
              <div class="toolbar-edit-group">{t(group.key)}</div>
              {#each items as { id, key } (id)}
                <label class="toolbar-edit-option">
                  <input
                    type="checkbox"
                    checked={!toolbar_tool_hidden(id)}
                    onchange={() => toggle_toolbar_tool(id)}
                  />
                  <span>{t(key)}</span>
                </label>
              {/each}
            {/if}
          {/each}
        </div>
      {/if}
    </div>
    {/if}

    <!-- === 收起 / 展开 === -->
    <span class="struct-toolbar-tooltip-wrap toolbar-collapse-toggle-wrap" style="--tb-order: 95">
      <button
        type="button"
        class="toolbar-collapse-toggle"
        aria-expanded={!toolbar_state.collapsed}
        onclick={() => {
          set_toolbar_collapsed(!toolbar_state.collapsed)
          toolbar_edit_open = false
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          {#if toolbar_state.collapsed !== (toolbar_state.dock === `left`)}
            <path d="m17 17-5-5 5-5" /><path d="m10 17-5-5 5-5" />
          {:else}
            <path d="m7 7 5 5-5 5" /><path d="m14 7 5 5-5 5" />
          {/if}
        </svg>
      </button>
      <span class="struct-toolbar-tooltip" role="tooltip">{toolbar_state.collapsed ? t('structure.toolbar_expand') : t('structure.toolbar_collapse')}</span>
    </span>
  {/if}
</section>

<style>
  /* === 工具栏容器 === */
  section.control-buttons {
    position: absolute;
    display: flex;
    flex-direction: column;
    flex-wrap: nowrap;
    top: var(--struct-buttons-top, var(--ctrl-btn-top, 1ex));
    right: var(--struct-buttons-right, var(--ctrl-btn-right, 1ex));
    max-height: calc(100% - 2 * var(--struct-buttons-top, 1ex));
    left: auto;
    width: 36px;
    min-width: 36px;
    max-width: 36px;
    gap: 2px;
    justify-content: flex-start;
    align-items: center;
    padding: 4px 0;
    background: color-mix(in srgb, var(--pane-bg, #0f1012) 88%, transparent);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 9px;
    /* buttons need higher z-index than StructureLegend to make info/controls panes occlude legend */
    /* we also need crazy high z-index to make info/control pane occlude threlte/extras' <HTML> elements for site labels */
    z-index: var(--struct-buttons-z-index, 100000000);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease;
  }
  section.control-buttons.visible {
    opacity: 1;
    pointer-events: auto;
  }
  /* === 子视口紧凑档 (@container: 每个宫格独立计算, 拖分隔线实时生效) === */
  @container (max-height: 560px) {
    section.control-buttons {
      gap: 1pt;
      padding: 3px 2px;
      border-radius: 7px;
    }
    section.control-buttons :global(button) {
      padding: 2.5pt;
      font-size: clamp(0.82em, 1.6cqmin, 1.1em);
    }
  }
  @container (max-height: 400px) {
    section.control-buttons {
      gap: 0.5pt;
      padding: 2px 1px;
      border-radius: 6px;
    }
    section.control-buttons :global(button) {
      padding: 2pt;
      font-size: 0.8em;
    }
  }

  section.control-buttons.overflowing:not(.dock-top):not(.dock-bottom) {
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    overscroll-behavior: contain;
  }
  :is(section.control-buttons.dock-top, section.control-buttons.dock-bottom).overflowing {
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    overscroll-behavior: contain;
  }
  section.control-buttons.collapsed {
    bottom: auto;
    padding: 0;
    background: transparent;
    border-color: transparent;
  }
  /* VSCode-style active indicator on the bar's inner edge */
  section.control-buttons :global(button.active) {
    box-shadow: inset -2px 0 0 var(--accent-color, #007acc);
  }

  /* === 按钮基础样式 === */
  section.control-buttons > :global(button),
  section.control-buttons :global(.pane-toggle),
  section.control-buttons .view-mode-button,
  section.control-buttons .build-tools-toggle {
    background-color: transparent;
    display: flex;
    align-items: center;
    padding: 4pt;
    font-size: clamp(0.9em, 1.8cqmin, 1.3em);
    border-radius: 3pt;
    transition: background-color 0.2s;
  }
  section.control-buttons > :global(button:hover),
  section.control-buttons :global(.pane-toggle:hover),
  section.control-buttons .view-mode-button:hover,
  section.control-buttons .build-tools-toggle:hover:not(:disabled) {
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }
  section.control-buttons .build-tools-toggle:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  section.control-buttons .build-tools-toggle.active,
  section.control-buttons .view-mode-button.active,
  section.control-buttons :global(.pane-toggle.active) {
    color: var(--accent-color, #007acc);
    background-color: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
  }

  /* Pulsing dot on toolbar button when terminal is minimized */
  .build-tools-toggle.minimized-indicator {
    position: relative;
  }
  .build-tools-toggle.minimized-indicator::after {
    content: '';
    position: absolute;
    top: 2px;
    right: 2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-color, #3b82f6);
    animation: pulse-dot 2s ease-in-out infinite;
  }
  @keyframes pulse-dot {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .struct-toolbar-tooltip-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  /* 树内 tooltip span = 纯 i18n 文案源; 展示走 body 下的 Portal 单例 (见 $effect) */
  .struct-toolbar-tooltip {
    display: none;
  }
  /* Portal 浮层: 主体+箭头同一根节点, 同一堆叠上下文, 永不被面板/分隔线盖住 */
  :global(.struct-tip-root) {
    position: fixed;
    left: -9999px;
    top: -9999px;
    z-index: 2147483000; /* 全局最顶层 tooltip 档 */
    pointer-events: none;
    box-sizing: border-box;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.12s ease, visibility 0.12s ease;
  }
  :global(.struct-tip-root.visible) {
    opacity: 1;
    visibility: visible;
  }
  :global(.struct-tip-body) {
    width: max-content;
    max-width: min(320px, calc(100vw - 16px));
    white-space: normal;
    overflow-wrap: break-word;
    padding: 7px 12px;
    border-radius: 7px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: rgba(17, 17, 17, 0.96);
    color: #f5f5f5;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.3);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.25;
  }
  :global(.struct-tip-arrow) {
    position: absolute;
    width: 9px;
    height: 9px;
    background: rgba(17, 17, 17, 0.96);
    transform: translate(-50%, -50%) rotate(45deg);
  }
  :global(.struct-tip-root[data-side='left'] .struct-tip-arrow) {
    border-right: 1px solid rgba(255, 255, 255, 0.12);
    border-top: 1px solid rgba(255, 255, 255, 0.12);
  }
  :global(.struct-tip-root[data-side='right'] .struct-tip-arrow) {
    border-left: 1px solid rgba(255, 255, 255, 0.12);
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  }
  :global(.struct-tip-root[data-side='top'] .struct-tip-arrow) {
    border-right: 1px solid rgba(255, 255, 255, 0.12);
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  }
  :global(.struct-tip-root[data-side='bottom'] .struct-tip-arrow) {
    border-left: 1px solid rgba(255, 255, 255, 0.12);
    border-top: 1px solid rgba(255, 255, 255, 0.12);
  }

  /* === 下拉菜单样式 (匹配 Trajectory dropdown UI) === */
  .view-mode-dropdown {
    position: absolute;
    top: 0;
    right: calc(100% + 8px);
    max-width: calc(100vw - 24px);
    overflow-x: auto;
    background: var(--surface-bg);
    border-radius: 4px;
    box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.3), 0 4px 8px -2px rgba(0, 0, 0, 0.1);
    display: flex;
    flex-direction: column;
    font-size: 0.9rem;
  }
  .view-mode-option {
    display: flex;
    align-items: center;
    gap: 1ex;
    width: 100%;
    padding: var(--trajectory-view-mode-option-padding, 5pt);
    box-sizing: border-box;
    background: transparent;
    border-radius: 0;
    text-align: left;
    transition: background-color 0.15s ease;
  }
  .view-mode-option:first-child {
    border-top-left-radius: 3px;
    border-top-right-radius: 3px;
  }
  .view-mode-option.selected {
    color: var(--accent-color);
  }
  .view-mode-option span {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }

  /* === 测量模式 === */
  .measure-mode-dropdown {
    display: flex;
    flex-direction: column;
    align-items: center;
    position: relative;
    gap: 4pt;
  }
  .selected-measurement-indicator {
    position: absolute;
    right: calc(100% + 8px);
    top: 8px;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(255, 204, 0, 0.3);
    border: 1px solid var(--warning-color, #ffcc00);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 0.9em;
    color: var(--struct-text-color);
  }
  .selected-measurement-indicator button {
    background: transparent;
    border: none;
    padding: 2px;
    cursor: pointer;
    display: flex;
    align-items: center;
    color: inherit;
    opacity: 0.7;
  }
  .selected-measurement-indicator button:hover {
    opacity: 1;
  }
  .selection-limit-text {
    font-weight: bold;
    font-size: 0.9em;
    color: var(--accent-color, var(--error-color, #ff6b6b));
    min-width: 2.5em;
    text-align: center;
  }

  /* === 铅笔/画模式样式 === */
  .pencil-mode-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    position: relative;
    gap: 4pt;
  }
  .pencil-toggle {
    background-color: transparent;
    display: flex;
    align-items: center;
    padding: 4pt;
    font-size: clamp(0.9em, 1.8cqmin, 1.3em);
    border-radius: 3pt;
    transition: background-color 0.2s;
  }
  .pencil-toggle:hover {
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }
  .pencil-toggle.active {
    color: var(--accent-color, #007acc);
    background-color: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
  }
  .touch-mode-container {
    flex-direction: column;
    display: flex;
    position: relative;
    gap: 4pt;
  }
  .touch-mode-toggle {
    background-color: transparent;
    padding: 4pt 7pt;
    font-size: clamp(0.8em, 1.6cqmin, 1.1em);
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
    border-radius: 4pt;
    white-space: nowrap;
    transition: background-color 0.2s, color 0.2s;
  }
  .touch-mode-toggle:hover {
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }
  .touch-mode-toggle.active {
    color: var(--accent-color, #007acc);
    border-color: var(--accent-color, #007acc);
    background-color: color-mix(in srgb, var(--accent-color, #007acc) 18%, transparent);
  }
  .touch-mode-toggle.touch-delete:not(:disabled) {
    color: var(--error-color, #ef4444);
    border-color: color-mix(in srgb, var(--error-color, #ef4444) 45%, transparent);
  }
  .touch-mode-toggle:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* === 手势控制切换 === */
  .gesture-toggle {
    background-color: transparent;
    display: flex;
    align-items: center;
    padding: 4pt;
    border-radius: 3pt;
    transition: all 0.2s;
    color: var(--text-color, #ccc);
  }
  .gesture-toggle:hover {
    background-color: color-mix(in srgb, #00fff7 15%, transparent);
    color: #00fff7;
  }
  .gesture-toggle.active {
    color: #00fff7;
    background-color: color-mix(in srgb, #00fff7 15%, transparent);
    box-shadow: 0 0 8px rgba(0, 255, 247, 0.3);
  }
  .gesture-toggle.art.active {
    color: #ff00ff;
    background-color: color-mix(in srgb, #ff00ff 15%, transparent);
    box-shadow: 0 0 8px rgba(255, 0, 255, 0.3);
  }
  .gesture-toggle.settings {
    box-shadow: inset 0 0 0 1px rgba(0, 255, 247, 0.2);
  }
  .gesture-toggle.settings.active {
    box-shadow: inset 0 0 0 1px rgba(0, 255, 247, 0.5);
  }

  /* === 元素快速选择器 === */
  .element-quick-selector {
    display: grid;
    /* 列数随可用宽度 4/3/2/1 档滑动; 单格 34-56px, 不拉伸不压瘪 */
    grid-template-columns: repeat(auto-fit, minmax(34px, 56px));
    justify-content: center;
    width: min(300px, calc(100vw - 48px));
    box-sizing: border-box;
    gap: 2px;
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: var(--border-radius, 6px);
    padding: 2px 4px;
  }
  .element-btn {
    width: 100%;
    min-width: 28px;
    height: 28px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .element-btn:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
    border-color: color-mix(in srgb, currentColor 20%, transparent);
  }
  .element-btn.selected {
    background: var(--accent-color, #007acc);
    color: white;
    border-color: var(--accent-color, #007acc);
  }

  /* === 铅笔模式选择器 (atoms vs fragments vs bonds) === */
  .pencil-mode-selector {
    position: fixed; /* fit_popover 锚定+钳位 */
    z-index: 10;
    box-sizing: border-box;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: var(--border-radius, 6px);
    padding: 4px;
    width: max-content;
    max-width: min(420px, calc(100vw - 24px));
    max-height: calc(100vh - 96px);
    overflow-x: auto;
    overflow-y: auto;
    box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.3), 0 4px 8px -2px rgba(0, 0, 0, 0.1);
    font-size: 0.9rem;
  }
  .mode-toggle {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border-color, #333);
    padding-bottom: 4px;
    margin-bottom: 2px;
  }
  .mode-btn {
    flex: 1;
    padding: 4px 8px;
    font-weight: 600;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    color: var(--text-color-muted, #888);
  }
  .mode-btn:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }
  .mode-btn.active {
    background: var(--accent-color, #007acc);
    color: white;
    border-color: var(--accent-color, #007acc);
  }

  /* === 键编辑状态 === */
  .bond-mode-status {
    font-size: 0.72em;
    color: var(--text-color-muted, #aaa);
    padding: 4px 6px;
    text-align: center;
    line-height: 1.4;
  }

  /* === 片段选择器 === */
  .fragment-selector {
    width: min(400px, calc(100vw - 48px));
    max-width: 100%;
    box-sizing: border-box;
  }
  .fragment-categories {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
    gap: 3px;
    align-items: center;
  }
  .fragment-categories .category-label {
    grid-column: 1 / -1; /* 分类标题独占一行 */
  }
  .category-label {
    font-size: 0.65em;
    font-weight: 600;
    color: var(--text-color-muted, #888);
    text-transform: uppercase;
    padding: 2px 4px;
    margin-left: 4px;
  }
  .category-label:first-child {
    margin-left: 0;
  }
  .fragment-btn {
    padding: 3px 8px;
    font-size: 0.75em;
    font-weight: 500;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    background: transparent;
    border: 1px solid var(--border-color, #444);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }
  .fragment-btn:hover {
    background: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
    border-color: var(--accent-color, #007acc);
  }
  .fragment-btn.selected {
    background: var(--accent-color, #007acc);
    color: white;
    border-color: var(--accent-color, #007acc);
  }

  @media (max-width: 560px) {
    .pencil-mode-selector,
    .view-mode-dropdown {
      position: fixed;
      left: 50%;
      right: auto;
      top: 72px;
      transform: translateY(-50%) translateX(4px);
      width: max-content;
      max-width: calc(100vw - 24px);
      z-index: 100000020;
    }
  }

  /* === 竖排: 单列连续, 按使用频率从上到下 (--tb-order 逐工具排位) ===
     children 里的 pane-toggle (optimize/info/controls) 无内联变量 → 默认 40, 紧随核心工具 */
  section.control-buttons > :global(*) {
    order: var(--tb-order, 40);
  }
  section.control-buttons > :global(.toolbar-flex-spacer) {
    display: none; /* 竖排无上下分区; dock-top 里恢复为左右弹性间隔 */
    pointer-events: none;
  }

  /* === 工具栏收起 + 自定义 === */
  .toolbar-edit-container {
    display: flex;
    position: relative;
  }
  .toolbar-edit-toggle,
  .toolbar-collapse-toggle {
    background-color: transparent;
    display: flex;
    align-items: center;
    padding: 4pt;
    border-radius: 3pt;
    transition: background-color 0.2s;
  }
  .toolbar-edit-toggle:hover,
  .toolbar-collapse-toggle:hover {
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }
  .toolbar-edit-toggle.active {
    color: var(--accent-color, #007acc);
    background-color: color-mix(in srgb, var(--accent-color, #007acc) 15%, transparent);
  }
  .toolbar-edit-menu {
    position: fixed; /* JS 按 dock 方向锚定并钳位进视口 */
    right: auto;
    z-index: 10;
    padding: 4px;
    min-width: max-content;
    max-height: calc(100vh - 24px);
    overflow-y: auto;
  }
  .toolbar-edit-option {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    font-size: 0.9em;
    transition: background-color 0.15s ease;
  }
  .toolbar-edit-option:hover {
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }
  .toolbar-edit-option input {
    accent-color: var(--accent-color, #007acc);
    margin: 0;
  }
  .toolbar-edit-group {
    font-size: 0.62em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-color-muted, #8c8c8c);
    padding: 6px 8px 2px;
    margin-top: 2px;
    border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  }
  .toolbar-edit-group:first-child {
    margin-top: 0;
    border-top: none;
    padding-top: 4px;
  }

  :global(.popover-modal) {
    box-shadow:
      0 18px 48px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(255, 255, 255, 0.08);
    border-radius: 8px;
  }

  .measure-menu-popover {
    position: fixed; /* fit_popover 锚定+钳位 */
    right: auto;
    box-sizing: border-box;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* === 停靠位置切换 (自定义菜单顶部) === */
  .toolbar-dock-row {
    display: flex;
    gap: 2px;
    padding: 2px 6px 4px;
  }
  .toolbar-dock-btn {
    flex: 1;
    padding: 3px 8px;
    font-size: 0.8em;
    font-weight: 600;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    color: var(--text-color-muted, #888);
  }
  .toolbar-dock-btn:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }
  .toolbar-dock-btn.active {
    background: var(--accent-color, #007acc);
    color: white;
    border-color: var(--accent-color, #007acc);
  }

  /* === dock-left: 左缘竖栏 (镜像右缘) === */
  section.control-buttons.dock-left {
    left: var(--struct-buttons-left, 1ex);
    right: auto;
  }
  section.control-buttons.dock-left :global(button.active) {
    box-shadow: inset 2px 0 0 var(--accent-color, #007acc);
  }
  /* 浮层已 fixed + JS 定位, dock 变体无需再改锚向 */
  .dock-left .selected-measurement-indicator {
    right: auto;
    left: calc(100% + 8px);
  }

  /* === dock-top: 顶部横排 (原布局: 低频在左, 常用在右) === */
  section.control-buttons.dock-top,
  section.control-buttons.dock-bottom {
    flex-direction: row;
    flex-wrap: nowrap; /* 永不折行/变假竖栏; 溢出走横向滚动 */
    left: var(--struct-buttons-left, 1ex);
    right: var(--struct-buttons-right, var(--ctrl-btn-right, 1ex));
    width: auto;
    min-width: 0;
    max-width: none; /* 显式解除竖排 36px 约束的继承 */
    height: 40px;
    min-height: 40px;
    max-height: 40px;
    align-items: center;
    gap: 2px;
    padding: 4px;
    box-sizing: border-box;
  }
  section.control-buttons.dock-top {
    top: var(--struct-buttons-top, var(--ctrl-btn-top, 1ex));
    bottom: auto;
  }
  section.control-buttons.dock-bottom {
    top: auto;
    bottom: var(--struct-buttons-bottom, 1ex);
  }
  section.control-buttons.dock-bottom.collapsed {
    top: auto;
    bottom: var(--struct-buttons-bottom, 1ex);
  }
  /* 横排按钮与竖排同规格: 32px 定格, 不压缩 */
  :is(section.control-buttons.dock-top, section.control-buttons.dock-bottom) :global(:is(
    button.gesture-toggle, button.pencil-toggle, button.build-tools-toggle,
    button.view-mode-button, button.reset-camera, button.fullscreen-toggle,
    button.toolbar-edit-toggle, button.toolbar-collapse-toggle, .pane-toggle
  )) {
    width: 32px;
    height: 32px;
    min-width: 32px;
    min-height: 32px;
    flex: 0 0 32px;
    padding: 0;
    margin: 0;
    border: 0;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    border-radius: 5px;
  }
  :is(section.control-buttons.dock-top, section.control-buttons.dock-bottom) :global(:is(
    button.gesture-toggle, button.pencil-toggle, button.build-tools-toggle,
    button.view-mode-button, button.reset-camera, button.fullscreen-toggle,
    button.toolbar-edit-toggle, button.toolbar-collapse-toggle, .pane-toggle
  ) svg) {
    width: 20px;
    height: 20px;
    display: block;
    flex: 0 0 20px;
  }
  :is(section.control-buttons.dock-top, section.control-buttons.dock-bottom) > :global(*) {
    order: 2;
  }
  :is(section.control-buttons.dock-top, section.control-buttons.dock-bottom) > :global(.tb-left) {
    order: 0;
  }
  :is(section.control-buttons.dock-top, section.control-buttons.dock-bottom) > :global(.toolbar-flex-spacer) {
    order: 1;
    display: block; /* 横排保留左右分簇的弹性间隔 */
    flex: 1 1 0;
  }
  :is(section.control-buttons.dock-top, section.control-buttons.dock-bottom) > :global(.toolbar-edit-container) {
    order: 3;
  }
  :is(section.control-buttons.dock-top, section.control-buttons.dock-bottom) > :global(.toolbar-collapse-toggle-wrap) {
    order: 4;
  }
  :is(section.control-buttons.dock-top, section.control-buttons.dock-bottom) :global(button.active) {
    box-shadow: inset 0 -2px 0 var(--accent-color, #007acc);
  }
  :is(.dock-top, .dock-bottom) .pencil-mode-container,
  :is(.dock-top, .dock-bottom) .measure-mode-dropdown {
    flex-direction: row;
    align-items: flex-start;
  }
  :is(.dock-top, .dock-bottom) .selected-measurement-indicator {
    position: static;
    white-space: nowrap;
  }

  /* === 栏内按钮几何统一: 同一中心线, 悬停/激活零位移 (popover 内部按钮不在此列) === */
  section.control-buttons:not(.dock-top):not(.dock-bottom) :global(:is(
    button.gesture-toggle,
    button.pencil-toggle,
    button.build-tools-toggle,
    button.view-mode-button,
    button.reset-camera,
    button.fullscreen-toggle,
    button.toolbar-edit-toggle,
    button.toolbar-collapse-toggle,
    .pane-toggle
  )) {
    width: 32px;
    height: 32px;
    min-width: 32px;
    min-height: 32px;
    flex: 0 0 auto;
    padding: 0;
    margin: 0;
    border: 0;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px; /* 文字型图标 (如 ⇧) 也走整数尺寸 */
    border-radius: 5px;
  }
  section.control-buttons:not(.dock-top):not(.dock-bottom) :global(:is(
    button.gesture-toggle,
    button.pencil-toggle,
    button.build-tools-toggle,
    button.view-mode-button,
    button.reset-camera,
    button.fullscreen-toggle,
    button.toolbar-edit-toggle,
    button.toolbar-collapse-toggle,
    .pane-toggle
  ) svg) {
    width: 20px;
    height: 20px;
    display: block;
    flex: 0 0 20px;
  }
  /* wrap 只当按钮的透明壳: 不引入自身盒模型 */
  section.control-buttons:not(.dock-top):not(.dock-bottom) > :global(.struct-toolbar-tooltip-wrap) {
    display: flex;
    justify-content: center;
    padding: 0;
    margin: 0;
    width: 32px;
  }
  section.control-buttons:not(.dock-top):not(.dock-bottom) :global(.pencil-mode-container),
  section.control-buttons:not(.dock-top):not(.dock-bottom) :global(.measure-mode-dropdown) {
    width: 32px;
    align-items: center;
  }
  /* 附属小按钮 (激活态的 ×/清除) 同轨居中 */
  section.control-buttons:not(.dock-top):not(.dock-bottom) :global(:is(.pencil-mode-container, .measure-mode-dropdown) > button) {
    width: 32px;
    height: 26px;
    padding: 0;
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* 紧凑档整数化覆盖 (32/28/18, 28/24/16) */
  @container (max-height: 560px) {
    section.control-buttons:not(.dock-top):not(.dock-bottom) {
      width: 32px;
      min-width: 32px;
      max-width: 32px;
      gap: 2px;
      padding: 3px 0;
    }
    section.control-buttons:not(.dock-top):not(.dock-bottom) :global(:is(
      button.gesture-toggle, button.pencil-toggle, button.build-tools-toggle,
      button.view-mode-button, button.reset-camera, button.fullscreen-toggle,
      button.toolbar-edit-toggle, button.toolbar-collapse-toggle, .pane-toggle
    )) {
      width: 28px;
      height: 28px;
      min-width: 28px;
      min-height: 28px;
      font-size: 14px;
    }
    section.control-buttons:not(.dock-top):not(.dock-bottom) :global(:is(
      button.gesture-toggle, button.pencil-toggle, button.build-tools-toggle,
      button.view-mode-button, button.reset-camera, button.fullscreen-toggle,
      button.toolbar-edit-toggle, button.toolbar-collapse-toggle, .pane-toggle
    ) svg) {
      width: 18px;
      height: 18px;
      flex-basis: 18px;
    }
    section.control-buttons:not(.dock-top):not(.dock-bottom) > :global(.struct-toolbar-tooltip-wrap),
    section.control-buttons:not(.dock-top):not(.dock-bottom) :global(.pencil-mode-container),
    section.control-buttons:not(.dock-top):not(.dock-bottom) :global(.measure-mode-dropdown) {
      width: 28px;
    }
  }
  @container (max-height: 400px) {
    section.control-buttons:not(.dock-top):not(.dock-bottom) {
      width: 28px;
      min-width: 28px;
      max-width: 28px;
      gap: 1px;
      padding: 2px 0;
    }
    section.control-buttons:not(.dock-top):not(.dock-bottom) :global(:is(
      button.gesture-toggle, button.pencil-toggle, button.build-tools-toggle,
      button.view-mode-button, button.reset-camera, button.fullscreen-toggle,
      button.toolbar-edit-toggle, button.toolbar-collapse-toggle, .pane-toggle
    )) {
      width: 24px;
      height: 24px;
      min-width: 24px;
      min-height: 24px;
      font-size: 12px;
    }
    section.control-buttons:not(.dock-top):not(.dock-bottom) :global(:is(
      button.gesture-toggle, button.pencil-toggle, button.build-tools-toggle,
      button.view-mode-button, button.reset-camera, button.fullscreen-toggle,
      button.toolbar-edit-toggle, button.toolbar-collapse-toggle, .pane-toggle
    ) svg) {
      width: 16px;
      height: 16px;
      flex-basis: 16px;
    }
    section.control-buttons:not(.dock-top):not(.dock-bottom) > :global(.struct-toolbar-tooltip-wrap),
    section.control-buttons:not(.dock-top):not(.dock-bottom) :global(.pencil-mode-container),
    section.control-buttons:not(.dock-top):not(.dock-bottom) :global(.measure-mode-dropdown) {
      width: 24px;
    }
  }
</style>

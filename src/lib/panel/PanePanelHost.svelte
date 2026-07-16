<script lang="ts">
  /** 每-pane 面板宿主 — 一个 pane 一套完整闭环:
   *   [左停靠槽位?][视口][右停靠槽位?] + pane 内悬浮层 + 收起后的 reveal 按钮。
   *
   * 停靠参与本 pane 的 flex 布局 (真收缩本 pane 视口, 不影响其他 pane);
   * 收起 = 条件渲染整列移除, 占宽严格为 0, 只留贴边 reveal 按钮。
   * 悬浮层 absolute 于本 pane (不跨 pane, 不用窗口坐标)。
   * 独立 ResizeObserver: pane 尺寸变化只重钳位本 pane 的实例。
   * splitter 用 pointer capture — 拖动事件不进 3D 画布。 */
  import type { Snippet } from 'svelte'
  import { load_i18n_module, t } from '$lib/i18n/index.svelte'
  import PanelFrame from './PanelFrame.svelte'
  import {
    ensure_pane_panels_within,
    type PanelInstance,
    panel_state,
    set_docked_height,
    set_docked_width,
    toggle_panel,
  } from './panel-state.svelte'

  load_i18n_module(`common`)

  let { pane_id, panel_title, panel_content, children }: {
    pane_id: string
    panel_title: (p: PanelInstance) => string
    panel_content: Snippet<[PanelInstance]>
    children?: Snippet
  } = $props()

  const store = panel_state()
  const pane_panels = $derived(
    Object.values(store.panels).filter((p) => p.pane_id === pane_id),
  )
  const open_panels = $derived(pane_panels.filter((p) => p.is_open))
  const docked = $derived(open_panels.find((p) => p.mode === `docked`) ?? null)
  const closed = $derived(pane_panels.filter((p) => !p.is_open))
  const vertical = $derived(
    !!docked && (docked.dock_side === `top` || docked.dock_side === `bottom`),
  )

  let root_el = $state<HTMLElement | null>(null)
  let slot_el = $state<HTMLElement | null>(null)
  let float_el = $state<HTMLElement | null>(null)

  const host_size = () => ({
    w: root_el?.clientWidth ?? 800,
    h: root_el?.clientHeight ?? 600,
  })

  // 本 pane 独立 RO: 尺寸变化只重钳位本 pane 实例 (docked 宽 + floating 位置)
  $effect(() => {
    if (!root_el) return
    const ro = new ResizeObserver(() => ensure_pane_panels_within(pane_id, host_size()))
    ro.observe(root_el)
    return () => ro.disconnect()
  })

  let splitting = $state(false)
  // 四向 resize: left/top 沿正轴增长, right/bottom 沿负轴; 左右改 width,
  // 上下改 height — 用各 pane 自己的 dock_side 决定, 无全局 currentDockSide
  function start_split(e: PointerEvent) {
    if (!docked || !root_el) return
    e.preventDefault()
    e.stopPropagation()
    const id = docked.id
    const side = docked.dock_side
    const vert = side === `top` || side === `bottom`
    const start = vert ? docked.docked_height : docked.docked_width
    const s0 = vert ? e.clientY : e.clientX
    const host_main = vert ? root_el.clientHeight : root_el.clientWidth
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    splitting = true
    let raf = 0
    const apply = (size: number, commit: boolean) => {
      if (vert) set_docked_height(id, size, root_el?.clientHeight ?? host_main, commit)
      else set_docked_width(id, size, root_el?.clientWidth ?? host_main, commit)
    }
    const move = (ev: PointerEvent) => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const d = (vert ? ev.clientY : ev.clientX) - s0
        apply(side === `left` || side === `top` ? start + d : start - d, false)
      })
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener(`pointermove`, move)
      el.removeEventListener(`pointerup`, up)
      if (el.hasPointerCapture?.(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      splitting = false
      const cur = store.panels[id]
      apply((vert ? cur?.docked_height : cur?.docked_width) ?? start, true) // 释放才落盘
    }
    el.addEventListener(`pointermove`, move)
    el.addEventListener(`pointerup`, up)
  }

  function key_resize(e: KeyboardEvent) {
    if (!docked || !root_el) return
    const side = docked.dock_side
    if (side === `left` || side === `right`) {
      const dir = side === `left` ? 1 : -1
      if (e.key === `ArrowRight`) {
        set_docked_width(docked.id, docked.docked_width + 16 * dir, root_el.clientWidth)
      } else if (e.key === `ArrowLeft`) {
        set_docked_width(docked.id, docked.docked_width - 16 * dir, root_el.clientWidth)
      }
    } else {
      const dir = side === `top` ? 1 : -1
      if (e.key === `ArrowDown`) {
        set_docked_height(docked.id, docked.docked_height + 16 * dir, root_el.clientHeight)
      } else if (e.key === `ArrowUp`) {
        set_docked_height(docked.id, docked.docked_height - 16 * dir, root_el.clientHeight)
      }
    }
  }

  const REVEAL_GLYPH: Record<string, string> = {
    left: `❯`,
    right: `❮`,
    top: `▾`,
    bottom: `▴`,
  }
</script>

<div
  class="pane-panel-root"
  class:vertical
  bind:this={root_el}
  data-pane-id={pane_id}
  data-dock-side={docked?.dock_side ?? null}
>
  {#if docked && (docked.dock_side === `left` || docked.dock_side === `top`)}
    {@render sidebar_col()}
  {/if}
  <div class="pane-viewport">
    {@render children?.()}
  </div>
  {#if docked && (docked.dock_side === `right` || docked.dock_side === `bottom`)}
    {@render sidebar_col()}
  {/if}
  <div class="pane-float-layer" bind:this={float_el}></div>
  {#each closed as p (p.id)}
    <button
      type="button"
      class="sidebar-reveal"
      data-side={p.dock_side}
      aria-expanded="false"
      aria-controls={`panel-${p.id}`}
      aria-label={t(`common.panel_expand`)}
      title={panel_title(p)}
      onclick={(e) => {
        e.stopPropagation()
        toggle_panel(p.id)
      }}
    >{REVEAL_GLYPH[p.dock_side] ?? `❯`}</button>
  {/each}
  {#each open_panels as p (p.id)}
    <PanelFrame
      panel_id={p.id}
      title={panel_title(p)}
      docked_slot_el={docked?.id === p.id ? slot_el : null}
      floating_el={float_el}
      get_host_size={host_size}
    >
      {@render panel_content(p)}
    </PanelFrame>
  {/each}
</div>

{#snippet sidebar_col()}
  {#if docked}
    {@const vert = docked.dock_side === `top` || docked.dock_side === `bottom`}
    <div
      class="pane-sidebar"
      data-side={docked.dock_side}
      style:flex-basis={vert ? `${docked.docked_height}px` : `${docked.docked_width}px`}
      style:width={vert ? undefined : `${docked.docked_width}px`}
      style:height={vert ? `${docked.docked_height}px` : undefined}
    >
      <div class="pane-sidebar-slot" bind:this={slot_el}></div>
      <div
        class="pane-splitter"
        class:active={splitting}
        data-side={docked.dock_side}
        role="separator"
        aria-orientation={vert ? `horizontal` : `vertical`}
        aria-label={t(`common.panel_resize`)}
        tabindex="0"
        onpointerdown={start_split}
        onkeydown={key_resize}
      ></div>
    </div>
  {/if}
{/snippet}

<style>
  .pane-panel-root {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .pane-panel-root.vertical {
    flex-direction: column;
  }
  .pane-viewport {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .pane-viewport > :global(*) {
    flex: 1;
    min-height: 0;
  }
  .pane-sidebar {
    flex: 0 0 auto;
    position: relative;
    min-width: 0;
    min-height: 0;
    display: flex;
    background: var(--pane-bg, var(--surface-bg, #16161d));
  }
  .pane-sidebar[data-side='left'],
  .pane-sidebar[data-side='right'] {
    height: 100%;
  }
  .pane-sidebar[data-side='top'],
  .pane-sidebar[data-side='bottom'] {
    width: 100%;
  }
  .pane-sidebar[data-side='left'] {
    border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
  }
  .pane-sidebar[data-side='right'] {
    border-left: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
  }
  .pane-sidebar[data-side='top'] {
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
  }
  .pane-sidebar[data-side='bottom'] {
    border-top: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
  }
  .pane-sidebar-slot {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
  }
  .pane-sidebar-slot > :global(.panel-frame) {
    flex: 1;
    min-width: 0;
  }
  .pane-splitter {
    position: absolute;
    z-index: 6;
    background: transparent;
  }
  .pane-splitter[data-side='left'],
  .pane-splitter[data-side='right'] {
    top: 0;
    width: 6px;
    height: 100%;
    cursor: col-resize;
  }
  .pane-splitter[data-side='left'] {
    right: -3px;
  }
  .pane-splitter[data-side='right'] {
    left: -3px;
  }
  .pane-splitter[data-side='top'],
  .pane-splitter[data-side='bottom'] {
    left: 0;
    height: 6px;
    width: 100%;
    cursor: row-resize;
  }
  .pane-splitter[data-side='top'] {
    bottom: -3px;
  }
  .pane-splitter[data-side='bottom'] {
    top: -3px;
  }
  .pane-splitter:hover,
  .pane-splitter.active,
  .pane-splitter:focus-visible {
    background: color-mix(in srgb, var(--accent-color, #4a9eff) 45%, transparent);
    outline: none;
  }
  .pane-float-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 12;
  }
  .pane-float-layer > :global(.panel-frame.floating) {
    pointer-events: auto;
  }
  /* 槽位切换瞬间的防闪: docked frame 未入槽前不显示 */
  .pane-float-layer > :global(.panel-frame.docked) {
    display: none;
  }
  .sidebar-reveal {
    position: absolute;
    z-index: 15;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font-size: 10px;
    line-height: 1;
    color: var(--text-color-muted, #999);
    background: var(--pane-bg, var(--surface-bg, #16161d));
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    cursor: pointer;
  }
  .sidebar-reveal:hover {
    color: var(--accent-color, #4a9eff);
    border-color: var(--accent-color, #4a9eff);
  }
  .sidebar-reveal[data-side='left'],
  .sidebar-reveal[data-side='right'] {
    top: 50%;
    transform: translateY(-50%);
    width: 22px;
    height: 44px;
  }
  .sidebar-reveal[data-side='left'] {
    left: 0;
    border-left: 0;
    border-radius: 0 6px 6px 0;
  }
  .sidebar-reveal[data-side='right'] {
    right: 0;
    border-right: 0;
    border-radius: 6px 0 0 6px;
  }
  .sidebar-reveal[data-side='top'],
  .sidebar-reveal[data-side='bottom'] {
    left: 50%;
    top: auto;
    transform: translateX(-50%);
    width: 44px;
    height: 22px;
  }
  .sidebar-reveal[data-side='top'] {
    top: 0;
    border-top: 0;
    border-radius: 0 0 6px 6px;
  }
  .sidebar-reveal[data-side='bottom'] {
    bottom: 0;
    border-bottom: 0;
    border-radius: 6px 6px 0 0;
  }
</style>

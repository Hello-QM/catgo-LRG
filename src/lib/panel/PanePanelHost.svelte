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
  function start_split(e: PointerEvent) {
    if (!docked || !root_el) return
    e.preventDefault()
    e.stopPropagation()
    const id = docked.id
    const side = docked.dock_side
    const start_w = docked.docked_width
    const sx = e.clientX
    const host_w = root_el.clientWidth
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    splitting = true
    let raf = 0
    const move = (ev: PointerEvent) => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const dx = ev.clientX - sx
        set_docked_width(id, side === `left` ? start_w + dx : start_w - dx, host_w, false)
      })
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener(`pointermove`, move)
      el.removeEventListener(`pointerup`, up)
      if (el.hasPointerCapture?.(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      splitting = false
      set_docked_width(
        id,
        store.panels[id]?.docked_width ?? start_w,
        root_el?.clientWidth ?? host_w,
        true,
      ) // 释放才落盘
    }
    el.addEventListener(`pointermove`, move)
    el.addEventListener(`pointerup`, up)
  }

  function key_resize(e: KeyboardEvent) {
    if (!docked || !root_el) return
    const dir = docked.dock_side === `left` ? 1 : -1
    if (e.key === `ArrowRight`) {
      set_docked_width(docked.id, docked.docked_width + 16 * dir, root_el.clientWidth)
    } else if (e.key === `ArrowLeft`) {
      set_docked_width(docked.id, docked.docked_width - 16 * dir, root_el.clientWidth)
    }
  }
</script>

<div class="pane-panel-root" bind:this={root_el} data-pane-id={pane_id}>
  {#if docked && docked.dock_side === `left`}
    {@render sidebar_col()}
  {/if}
  <div class="pane-viewport">
    {@render children?.()}
  </div>
  {#if docked && docked.dock_side === `right`}
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
    >{p.dock_side === `right` ? `❮` : `❯`}</button>
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
    <div
      class="pane-sidebar"
      data-side={docked.dock_side}
      style:flex-basis={`${docked.docked_width}px`}
      style:width={`${docked.docked_width}px`}
    >
      <div class="pane-sidebar-slot" bind:this={slot_el}></div>
      <div
        class="pane-splitter"
        class:active={splitting}
        data-side={docked.dock_side}
        role="separator"
        aria-orientation="vertical"
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
    height: 100%;
    display: flex;
    background: var(--pane-bg, var(--surface-bg, #16161d));
  }
  .pane-sidebar[data-side='left'] {
    border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
  }
  .pane-sidebar[data-side='right'] {
    border-left: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
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
    top: 0;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 6;
    background: transparent;
  }
  .pane-splitter[data-side='left'] {
    right: -3px;
  }
  .pane-splitter[data-side='right'] {
    left: -3px;
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
    top: 50%;
    transform: translateY(-50%);
    width: 22px;
    height: 44px;
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
</style>

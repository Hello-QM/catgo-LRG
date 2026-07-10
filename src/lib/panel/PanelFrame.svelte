<script lang="ts">
  /** 统一面板外框 — pane 作用域双模式, 同一实例同一节点。
   *
   * docked: 填满所在 pane 的侧栏槽位; floating: absolute 于 pane 内
   * (绝不 fixed / 窗口坐标 — pane 即碰撞边界)。根节点由 attachment 依
   * mode 在槽位/悬浮层间搬移, 组件永不销毁重建。
   * 拖拽/缩放用 pointer capture (事件不冒泡进 3D 视口), rAF 节流,
   * 释放才持久化模板。菜单: 停靠左侧/停靠右侧/设为悬浮窗 (radio)。 */
  import type { Snippet } from 'svelte'
  import { load_i18n_module, t } from '$lib/i18n/index.svelte'
  import OverlayTargetHeader from '$lib/overlay/OverlayTargetHeader.svelte'
  import {
    bring_to_front,
    close_panel,
    type HostSize,
    panel_state,
    set_dock_side,
    set_floating_bounds,
    set_panel_mode,
  } from './panel-state.svelte'

  load_i18n_module(`common`)

  let { panel_id, title, docked_slot_el = null, floating_el = null, get_host_size, children }: {
    panel_id: string
    title: string
    docked_slot_el?: HTMLElement | null
    floating_el?: HTMLElement | null
    get_host_size: () => HostSize
    children?: Snippet
  } = $props()

  const store = panel_state()
  const inst = $derived(store.panels[panel_id])
  const floating = $derived(inst?.mode === `floating`)

  let menu_open = $state(false)

  // reparent: 同一节点在本 pane 的停靠槽位 / 悬浮层之间搬移
  function reparent(node: HTMLElement) {
    const target = inst?.mode === `docked` && docked_slot_el ? docked_slot_el : floating_el
    if (target && node.parentElement !== target) target.appendChild(node)
  }

  // pointer-capture 拖拽跟踪: 事件留在把手元素上, 不进画布 (§事件隔离)
  function track_pointer(
    e: PointerEvent,
    apply: (dx: number, dy: number) => void,
    done: () => void,
  ) {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const sx = e.clientX
    const sy = e.clientY
    let raf = 0
    const move = (ev: PointerEvent) => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        apply(ev.clientX - sx, ev.clientY - sy)
      })
    }
    const up = (ev: PointerEvent) => {
      el.removeEventListener(`pointermove`, move)
      el.removeEventListener(`pointerup`, up)
      if (el.hasPointerCapture?.(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      done()
    }
    el.addEventListener(`pointermove`, move)
    el.addEventListener(`pointerup`, up)
  }

  function start_drag(e: PointerEvent) {
    if (!floating || !inst) return
    if ((e.target as HTMLElement).closest(`button, select, input`)) return
    const { x, y } = inst.floating_bounds
    track_pointer(
      e,
      (dx, dy) => set_floating_bounds(panel_id, { x: x + dx, y: y + dy }, get_host_size(), false),
      () => set_floating_bounds(panel_id, {}, get_host_size(), true),
    )
  }

  function start_resize(e: PointerEvent, edge: `e` | `s` | `se`) {
    if (!floating || !inst) return
    const { width, height } = inst.floating_bounds
    track_pointer(
      e,
      (dx, dy) =>
        set_floating_bounds(panel_id, {
          width: edge !== `s` ? width + dx : width,
          height: edge !== `e` ? height + dy : height,
        }, get_host_size(), false),
      () => set_floating_bounds(panel_id, {}, get_host_size(), true),
    )
  }

  function choose_dock(side: `left` | `right` | `top` | `bottom`) {
    menu_open = false
    set_dock_side(panel_id, side)
    set_panel_mode(panel_id, `docked`)
  }

  function choose_float() {
    menu_open = false
    set_panel_mode(panel_id, `floating`, get_host_size())
  }
</script>

{#if inst?.is_open}
  <div
    id={`panel-${panel_id}`}
    class="panel-frame"
    class:floating
    class:docked={!floating}
    data-panel-id={panel_id}
    data-panel-type={inst.panel_type}
    data-mode={inst.mode}
    role="dialog"
    aria-label={title}
    style:left={floating ? `${inst.floating_bounds.x}px` : undefined}
    style:top={floating ? `${inst.floating_bounds.y}px` : undefined}
    style:width={floating ? `${inst.floating_bounds.width}px` : undefined}
    style:height={floating ? `${inst.floating_bounds.height}px` : undefined}
    style:z-index={floating ? inst.z_index : undefined}
    onpointerdown={(e) => {
      if (floating) {
        bring_to_front(panel_id)
        e.stopPropagation() // 不让画布手势收到面板内指针事件
      }
    }}
    {@attach reparent}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="panel-titlebar" class:draggable={floating} onpointerdown={start_drag}>
      <div class="panel-titlebar-main">
        <OverlayTargetHeader {title} context={inst.target} policy={inst.target_policy} />
      </div>
      <div class="panel-titlebar-actions">
        <div class="panel-menu-wrap">
          <button
            type="button"
            class="panel-icon-btn"
            aria-label={t(`common.panel_more`)}
            aria-expanded={menu_open}
            onclick={() => (menu_open = !menu_open)}
          >⋯</button>
          {#if menu_open}
            <div
              class="panel-mode-menu"
              role="menu"
              onkeydown={(e) => {
                if (e.key === `Escape`) menu_open = false
              }}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!floating && inst.dock_side === `left`}
                onclick={() => choose_dock(`left`)}
              >
                <span class="pm-check">{!floating && inst.dock_side === `left` ? `✓` : ``}</span>
                {t(`common.panel_dock_left`)}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!floating && inst.dock_side === `right`}
                onclick={() => choose_dock(`right`)}
              >
                <span class="pm-check">{!floating && inst.dock_side === `right` ? `✓` : ``}</span>
                {t(`common.panel_dock_right`)}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!floating && inst.dock_side === `top`}
                onclick={() => choose_dock(`top`)}
              >
                <span class="pm-check">{!floating && inst.dock_side === `top` ? `✓` : ``}</span>
                {t(`common.panel_dock_top`)}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!floating && inst.dock_side === `bottom`}
                onclick={() => choose_dock(`bottom`)}
              >
                <span class="pm-check">{!floating && inst.dock_side === `bottom` ? `✓` : ``}</span>
                {t(`common.panel_dock_bottom`)}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={floating}
                onclick={choose_float}
              >
                <span class="pm-check">{floating ? `✓` : ``}</span>
                {t(`common.panel_float`)}
              </button>
            </div>
          {/if}
        </div>
        <button
          type="button"
          class="panel-icon-btn"
          aria-label={t(`common.panel_close`)}
          aria-expanded="true"
          aria-controls={`panel-${panel_id}`}
          onclick={() => close_panel(panel_id)}
        >×</button>
      </div>
    </div>
    <div class="panel-body">
      {@render children?.()}
    </div>
    {#if floating}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="rs rs-e" onpointerdown={(e) => start_resize(e, `e`)}></div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="rs rs-s" onpointerdown={(e) => start_resize(e, `s`)}></div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="rs rs-se" onpointerdown={(e) => start_resize(e, `se`)}></div>
    {/if}
  </div>
{/if}

<style>
  .panel-frame {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--pane-bg, var(--surface-bg, #16161d));
    color: var(--text-color, inherit);
    overflow: hidden;
  }
  .panel-frame.docked {
    width: 100%;
    height: 100%;
    box-shadow: none;
  }
  .panel-frame.floating {
    position: absolute; /* pane 内坐标 — 绝不 fixed/窗口坐标 */
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3), 0 2px 6px rgba(0, 0, 0, 0.18);
    pointer-events: auto;
  }
  .panel-titlebar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 6px;
    padding: 8px 8px 6px 12px;
    border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.14));
    flex: 0 0 auto;
    min-width: 0;
  }
  .panel-titlebar.draggable {
    cursor: grab;
    user-select: none;
  }
  .panel-titlebar.draggable:active {
    cursor: grabbing;
  }
  .panel-titlebar-main {
    flex: 1;
    min-width: 0;
  }
  .panel-titlebar-main :global(.overlay-target-header) {
    margin: 0;
  }
  .panel-titlebar-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
  }
  .panel-icon-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-color-muted, #999);
    font-size: 14px;
    line-height: 1;
  }
  .panel-icon-btn:hover {
    background: color-mix(in srgb, currentColor 12%, transparent);
    color: var(--text-color, inherit);
  }
  .panel-menu-wrap {
    position: relative;
  }
  .panel-mode-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    min-width: 150px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--surface-bg, #1e1e24);
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 6px;
    box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.35);
  }
  .panel-mode-menu button {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
    text-align: left;
    white-space: nowrap;
    color: inherit;
  }
  .panel-mode-menu button:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }
  .pm-check {
    width: 1em;
    flex: 0 0 1em;
    color: var(--accent-color, #4a9eff);
  }
  .panel-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    padding: 8px 10px;
  }
  .rs {
    position: absolute;
  }
  .rs-e {
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    cursor: ew-resize;
  }
  .rs-s {
    left: 0;
    bottom: -3px;
    height: 6px;
    width: 100%;
    cursor: ns-resize;
  }
  .rs-se {
    right: -3px;
    bottom: -3px;
    width: 12px;
    height: 12px;
    cursor: nwse-resize;
  }
</style>

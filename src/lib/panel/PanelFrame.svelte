<script lang="ts">
  /** 统一面板外框 — 双模式渲染同一实例。
   *
   * 标题栏 = OverlayTargetHeader (窗口号/文件名/失效/目标切换) + 关闭 + 更多菜单
   * (停靠到侧边栏 / 设为悬浮窗, aria-checked)。floating: 标题栏拖拽、右/下/角
   * 缩放、pointerdown 置顶、bounds 由 store 钳位; docked: 填满槽位, 无阴影。
   * 根节点由 attachment 依 mode 搬进停靠槽位或悬浮层 (panel-hosts), 不销毁。 */
  import type { Snippet } from 'svelte'
  import { load_i18n_module, t } from '$lib/i18n/index.svelte'
  import OverlayTargetHeader from '$lib/overlay/OverlayTargetHeader.svelte'
  import {
    bring_to_front,
    close_panel,
    panel_state,
    set_floating_bounds,
    set_panel_mode,
  } from './panel-state.svelte'
  import { panel_hosts } from './panel-hosts.svelte'

  load_i18n_module(`common`)

  let { panel_id, title, on_switch_target, children }: {
    panel_id: string
    title: string
    on_switch_target?: (viewport_id: string) => void
    children?: Snippet
  } = $props()

  const store = panel_state()
  const hosts = panel_hosts()
  const inst = $derived(store.panels[panel_id])
  const floating = $derived(inst?.mode === `floating`)

  let menu_open = $state(false)

  // ── reparent: 同一节点在停靠槽位 / 悬浮层之间搬移 ──
  function reparent(node: HTMLElement) {
    const target = inst?.mode === `docked` && hosts.docked_slot?.panel_id === panel_id
      ? hosts.docked_slot.el
      : hosts.floating_el
    if (target && node.parentElement !== target) target.appendChild(node)
  }

  // ── floating 拖拽 (标题栏) 与缩放 (右/下/角), rAF 节流, 释放才落盘 ──
  let raf = 0
  function track_pointer(
    e: PointerEvent,
    apply: (dx: number, dy: number) => void,
    done: () => void,
  ) {
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    const move = (ev: PointerEvent) => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        apply(ev.clientX - sx, ev.clientY - sy)
      })
    }
    const up = () => {
      window.removeEventListener(`pointermove`, move)
      window.removeEventListener(`pointerup`, up)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      done()
    }
    window.addEventListener(`pointermove`, move)
    window.addEventListener(`pointerup`, up)
  }

  function start_drag(e: PointerEvent) {
    if (!floating || !inst) return
    if ((e.target as HTMLElement).closest(`button, select, input`)) return
    const { x, y } = inst.floating_bounds
    track_pointer(
      e,
      (dx, dy) => set_floating_bounds(panel_id, { x: x + dx, y: y + dy }, false),
      () => set_floating_bounds(panel_id, {}, true),
    )
  }

  function start_resize(e: PointerEvent, edge: `e` | `s` | `se`) {
    if (!floating || !inst) return
    e.stopPropagation()
    const { width, height } = inst.floating_bounds
    track_pointer(
      e,
      (dx, dy) =>
        set_floating_bounds(panel_id, {
          width: edge !== `s` ? width + dx : width,
          height: edge !== `e` ? height + dy : height,
        }, false),
      () => set_floating_bounds(panel_id, {}, true),
    )
  }

  function set_mode(mode: `docked` | `floating`) {
    menu_open = false
    set_panel_mode(panel_id, mode)
  }
</script>

{#if inst?.is_open}
  <div
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
    onpointerdowncapture={() => floating && bring_to_front(panel_id)}
    {@attach reparent}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="panel-titlebar" class:draggable={floating} onpointerdown={start_drag}>
      <div class="panel-titlebar-main">
        <OverlayTargetHeader
          {title}
          context={inst.target}
          policy={inst.target_policy}
          on_switch={on_switch_target}
        />
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
              onkeydown={(e) => { if (e.key === `Escape`) menu_open = false }}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!floating}
                onclick={() => set_mode(`docked`)}
              >
                <span class="pm-check">{!floating ? `✓` : ``}</span>
                {t(`common.panel_dock_to_sidebar`)}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={floating}
                onclick={() => set_mode(`floating`)}
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
    border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.18));
  }
  .panel-frame.floating {
    position: fixed;
    border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.2);
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
    min-width: 160px;
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

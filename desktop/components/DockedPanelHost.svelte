<script lang="ts">
  /** 停靠面板宿主 — 参与主布局的左侧列 (非覆盖)。
   *
   * 只渲染"当前停靠显示"的一个面板槽位 (open + docked + 未折叠, 多个取
   * 最近激活); PanelFrame 由 FloatingPanelHost 常驻渲染并把同一节点搬进
   * 这里的槽位。右缘 splitter: rAF 节流调宽 + 全屏 shield 挡 3D 视口事件,
   * 释放才持久化; 支持键盘 ←/→ 调宽 (role=separator)。 */
  import { panel_hosts, register_docked_slot } from '$lib/panel/panel-hosts.svelte'
  import { panel_state, set_docked_width } from '$lib/panel/panel-state.svelte'
  import { load_i18n_module, t } from '$lib/i18n/index.svelte'

  load_i18n_module(`common`)

  const store = panel_state()
  const hosts = panel_hosts()
  const docked = $derived(
    Object.values(store.panels)
      .filter((p) => p.is_open && p.mode === `docked` && !p.is_collapsed)
      .sort((a, b) => b.z_index - a.z_index)[0] ?? null,
  )

  let slot_el = $state<HTMLElement | null>(null)
  $effect(() => {
    if (docked && slot_el) register_docked_slot({ panel_id: docked.id, el: slot_el })
    else if (hosts.docked_slot) register_docked_slot(null)
    return () => register_docked_slot(null)
  })

  let dragging = $state(false)
  let raf = 0
  function start_split(e: PointerEvent) {
    if (!docked) return
    e.preventDefault()
    const id = docked.id
    const start_w = docked.docked_width
    const sx = e.clientX
    dragging = true
    const move = (ev: PointerEvent) => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        set_docked_width(id, start_w + (ev.clientX - sx), false)
      })
    }
    const up = () => {
      window.removeEventListener(`pointermove`, move)
      window.removeEventListener(`pointerup`, up)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      dragging = false
      set_docked_width(id, store.panels[id]?.docked_width ?? start_w, true) // 落盘
    }
    window.addEventListener(`pointermove`, move)
    window.addEventListener(`pointerup`, up)
  }

  function key_resize(e: KeyboardEvent) {
    if (!docked) return
    if (e.key === `ArrowLeft`) set_docked_width(docked.id, docked.docked_width - 16)
    else if (e.key === `ArrowRight`) set_docked_width(docked.id, docked.docked_width + 16)
  }
</script>

{#if docked}
  <div class="docked-panel-host" style:width={`${docked.docked_width}px`}>
    <div class="docked-slot" bind:this={slot_el}></div>
    <div
      class="docked-splitter"
      class:active={dragging}
      role="separator"
      aria-orientation="vertical"
      aria-label={t(`common.panel_resize`)}
      tabindex="0"
      onpointerdown={start_split}
      onkeydown={key_resize}
    ></div>
  </div>
  {#if dragging}
    <div class="split-shield"></div>
  {/if}
{/if}

<style>
  .docked-panel-host {
    position: relative;
    flex: 0 0 auto;
    display: flex;
    min-width: 0;
    height: 100%;
    background: var(--pane-bg, var(--surface-bg, #16161d));
  }
  .docked-slot {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
  }
  .docked-slot > :global(.panel-frame) {
    flex: 1;
    min-width: 0;
  }
  .docked-splitter {
    position: absolute;
    top: 0;
    right: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 5;
    background: transparent;
  }
  .docked-splitter:hover,
  .docked-splitter.active,
  .docked-splitter:focus-visible {
    background: color-mix(in srgb, var(--accent-color, #4a9eff) 45%, transparent);
    outline: none;
  }
  /* 拖动期间全屏遮罩: 3D 视口收不到 pointer 事件, 不触发旋转/选择 */
  .split-shield {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    cursor: col-resize;
  }
</style>

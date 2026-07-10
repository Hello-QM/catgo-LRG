<script lang="ts">
  /** 悬浮面板层 — 应用根级宿主 (无 transform/containment/overflow 祖先,
   * fixed 坐标即真视口坐标)。
   *
   * 常驻渲染所有 open 面板的 PanelFrame (无论模式) — 停靠时 frame 自己把
   * 节点搬进 DockedPanelHost 槽位, 切换模式绝不销毁组件。
   * window resize → 全部面板重新钳位 (监听器随组件清理)。 */
  import type { Snippet } from 'svelte'
  import type { PanelInstance } from '$lib/panel/panel-state.svelte'
  import { ensure_panels_within_host, panel_state } from '$lib/panel/panel-state.svelte'
  import { register_floating_host } from '$lib/panel/panel-hosts.svelte'
  import PanelFrame from '$lib/panel/PanelFrame.svelte'

  let { title_of, on_switch_target, panel_content }: {
    title_of: (p: PanelInstance) => string
    on_switch_target?: (p: PanelInstance, viewport_id: string) => void
    panel_content: Snippet<[PanelInstance]>
  } = $props()

  const store = panel_state()
  const open_panels = $derived(Object.values(store.panels).filter((p) => p.is_open))

  let layer_el = $state<HTMLElement | null>(null)
  $effect(() => {
    register_floating_host(layer_el)
    return () => register_floating_host(null)
  })
  $effect(() => {
    const on_resize = () => ensure_panels_within_host()
    window.addEventListener(`resize`, on_resize)
    return () => window.removeEventListener(`resize`, on_resize)
  })
</script>

<div class="floating-panel-layer" bind:this={layer_el}>
  {#each open_panels as p (p.id)}
    <PanelFrame
      panel_id={p.id}
      title={title_of(p)}
      on_switch_target={(viewport_id) => on_switch_target?.(p, viewport_id)}
    >
      {@render panel_content(p)}
    </PanelFrame>
  {/each}
</div>

<style>
  /* 层本身不拦事件; frame (fixed) 自带 pointer-events。z 高于结构工具栏
     (100000000), 低于 TabBar 及应用模态 (100000020+) */
  .floating-panel-layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 100000005;
  }
  .floating-panel-layer > :global(.panel-frame.floating) {
    pointer-events: auto;
  }
  /* 停靠槽位空置期间 frame 暂留本层但不可见 (搬移瞬间的防闪烁) */
  .floating-panel-layer > :global(.panel-frame.docked) {
    display: none;
  }
</style>

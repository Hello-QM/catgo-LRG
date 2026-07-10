/** 面板渲染宿主注册表 — reparent 的两端。
 *
 * FloatingPanelHost 注册悬浮层容器; DockedPanelHost 为"当前停靠显示的面板"
 * 注册槽位。PanelFrame 的 attachment 读这里决定把同一个 DOM 节点搬进哪个
 * 宿主 — 组件实例永不销毁重建, 内容状态 (表单/滚动/轮询) 全保留。
 * 两个宿主都在应用根内, Svelte 5 事件委托链不受搬移影响。 */

interface DockedSlot {
  panel_id: string
  el: HTMLElement
}

const hosts = $state<{ floating_el: HTMLElement | null; docked_slot: DockedSlot | null }>({
  floating_el: null,
  docked_slot: null,
})

export function register_floating_host(el: HTMLElement | null): void {
  hosts.floating_el = el
}

export function register_docked_slot(slot: DockedSlot | null): void {
  hosts.docked_slot = slot
}

export function panel_hosts(): typeof hosts {
  return hosts
}

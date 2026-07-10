<script lang="ts">
  /** 左缘 Activity Bar — 工具面板入口图标栏。
   *
   * 点击: 未开 → 按上次模式打开 (首次 docked, 初始目标 = 明确 active 视口
   * 或唯一视口, 否则留空由标题切换器选择 — 绝不默认数组第一个);
   * docked → 折叠/展开; floating → 激活置顶。 */
  import Icon from '$lib/Icon.svelte'
  import { load_i18n_module, t } from '$lib/i18n/index.svelte'
  import {
    create_viewport_target_context,
    flash_viewport,
  } from '$lib/overlay/overlay-target.svelte'
  import { get_active_viewer_id, list_viewers } from '$lib/structure/viewer-registry.svelte'
  import {
    bring_to_front,
    get_panel_by_type,
    open_panel,
    panel_state,
    toggle_panel_collapsed,
  } from '$lib/panel/panel-state.svelte'

  load_i18n_module(`common`)

  const store = panel_state()
  const wf = $derived(
    Object.values(store.panels).find((p) => p.panel_type === `workflow`) ?? null,
  )

  function initial_target() {
    const viewers = list_viewers().filter((m) => m.kind !== `empty`)
    const active = get_active_viewer_id()
    if (active && viewers.some((v) => v.viewer_id === active)) {
      return create_viewport_target_context(active, `ActivityBar`)
    }
    if (viewers.length === 1) {
      return create_viewport_target_context(viewers[0].viewer_id, `ActivityBar`)
    }
    return null // 多视口且无明确激活: 交给标题目标选择器, 不默认第一个
  }

  function click_workflow() {
    const p = get_panel_by_type(`workflow`)
    if (!p || !p.is_open) {
      const target = initial_target()
      const inst = open_panel({
        panel_type: `workflow`,
        target_policy: `user-selectable`,
        target,
        preferred_mode: `docked`,
      })
      if (inst.target?.viewport_id) flash_viewport(inst.target.viewport_id)
    } else if (p.mode === `docked`) {
      toggle_panel_collapsed(p.id)
    } else {
      bring_to_front(p.id)
    }
  }
</script>

<nav class="activity-bar" aria-label="Tool panels">
  <button
    type="button"
    class="ab-item"
    class:active={!!wf && wf.is_open && wf.mode === `docked` && !wf.is_collapsed}
    class:open={!!wf && wf.is_open}
    aria-label={t(`common.workflow`)}
    title={t(`common.workflow`)}
    onclick={click_workflow}
  >
    <Icon icon="Workflow" />
  </button>
</nav>

<style>
  .activity-bar {
    flex: 0 0 44px;
    width: 44px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 0;
    background: var(--page-bg, #0d0d12);
    border-right: 1px solid var(--border-color, rgba(128, 128, 128, 0.14));
  }
  .ab-item {
    position: relative;
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text-color-muted, #8b8b94);
    font-size: 17px;
  }
  .ab-item:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
    color: var(--text-color, #ddd);
  }
  .ab-item.active {
    color: var(--accent-color, #4a9eff);
    background: color-mix(in srgb, var(--accent-color, #4a9eff) 14%, transparent);
  }
  .ab-item.open::after {
    content: '';
    position: absolute;
    left: -7px;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 16px;
    border-radius: 2px;
    background: var(--accent-color, #4a9eff);
  }
</style>

<script lang="ts">
  /** 左缘 Activity Bar — 操作"当前 active pane"的面板, 但底层 API 显式携带
   * pane_id (不依赖隐式全局)。点击: 该 pane 无实例/已收起 → 打开 (模板模式,
   * 目标 = 本 pane 冻结上下文); docked 展开中 → 收起; floating → 置顶。 */
  import Icon from '$lib/Icon.svelte'
  import { load_i18n_module, t } from '$lib/i18n/index.svelte'
  import {
    create_viewport_target_context,
    flash_viewport,
  } from '$lib/overlay/overlay-target.svelte'
  import {
    bring_to_front,
    get_pane_panel,
    open_panel,
    panel_state,
    toggle_panel,
  } from '$lib/panel/panel-state.svelte'

  load_i18n_module(`common`)

  let { active_pane_id = null }: { active_pane_id?: string | null } = $props()

  const store = panel_state()
  const wf = $derived(
    active_pane_id
      ? Object.values(store.panels)
        .find((p) => p.panel_type === `workflow` && p.pane_id === active_pane_id) ?? null
      : null,
  )

  function click_workflow() {
    const pane_id = active_pane_id
    if (!pane_id) return
    const existing = get_pane_panel(`workflow`, pane_id)
    if (!existing || !existing.is_open) {
      if (existing) {
        toggle_panel(existing.id) // 重新展开, 保留原实例状态
      } else {
        open_panel({
          panel_type: `workflow`,
          pane_id,
          target: create_viewport_target_context(pane_id, `ActivityBar`),
          target_policy: `fixed`,
          preferred_mode: `docked`,
        })
      }
      flash_viewport(pane_id)
    } else if (existing.mode === `docked`) {
      toggle_panel(existing.id) // 收起 (完全退出布局, 留 reveal 按钮)
    } else {
      bring_to_front(existing.id)
    }
  }
</script>

<nav class="activity-bar" aria-label="Tool panels">
  <button
    type="button"
    class="ab-item"
    class:active={!!wf && wf.is_open && wf.mode === `docked`}
    class:open={!!wf && wf.is_open}
    disabled={!active_pane_id}
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
  .ab-item:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .ab-item:not(:disabled):hover {
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

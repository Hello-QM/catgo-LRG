<script lang="ts">
  /** 统一对象级弹层标题: "功能名 · 窗口 N" + 结构/文件副标题。
   *
   * 目标身份来自冻结的 context (viewport_id 固定); 显示名跟随该视口的
   * 活 manifest (文件换名/后载入即时更新)。视口关闭 → 失效横幅;
   * 无结构 → 空状态提示。policy=user-selectable 时窗口徽章可点,
   * 展开目标切换菜单 (切换不关弹层, 由宿主 on_switch 重建上下文)。 */
  import { load_i18n_module, t } from '$lib/i18n/index.svelte'
  import {
    list_viewers,
    viewer_manifests_state,
  } from '$lib/structure/viewer-registry.svelte'
  import {
    flash_viewport,
    type OverlayTargetContext,
    type OverlayTargetPolicy,
    validate_target,
    viewport_display_index,
  } from './overlay-target.svelte'

  load_i18n_module(`common`)

  let { title, context, policy = `fixed`, on_switch }: {
    title: string
    context: OverlayTargetContext | null
    policy?: OverlayTargetPolicy
    on_switch?: (viewport_id: string) => void
  } = $props()

  const reg = viewer_manifests_state()
  const live = $derived(
    context?.viewport_id ? reg.manifests[context.viewport_id] : undefined,
  )
  const validity = $derived(validate_target(context))
  const file_label = $derived(
    live?.filename ?? live?.label ?? context?.file_name ?? context?.display_name ?? ``,
  )
  const win_n = $derived(context?.display_index ?? 0)

  let switcher_open = $state(false)
  let choices = $state<{ id: string; n: number; name: string; current: boolean }[]>([])

  function toggle_switcher() {
    if (policy !== `user-selectable`) return
    if (!switcher_open) {
      choices = list_viewers()
        .filter((m) => m.kind !== `empty` || m.viewer_id === context?.viewport_id)
        .map((m) => ({
          id: m.viewer_id,
          n: viewport_display_index(m.viewer_id),
          name: m.filename ?? m.label,
          current: m.viewer_id === context?.viewport_id,
        }))
    }
    switcher_open = !switcher_open
  }

  function choose(id: string) {
    switcher_open = false
    if (id !== context?.viewport_id) {
      on_switch?.(id)
      flash_viewport(id)
    }
  }
</script>

<div class="overlay-target-header">
  <h4 class="oth-title">
    <span class="oth-name">{title}</span>
    {#if context?.scope === `viewport` && win_n > 0}
      <span class="oth-sep">·</span>
      <button
        type="button"
        class="oth-window-chip"
        class:switchable={policy === `user-selectable`}
        disabled={policy !== `user-selectable`}
        aria-expanded={switcher_open}
        title={policy === `user-selectable` ? t(`common.overlay_switch_target`) : undefined}
        onclick={toggle_switcher}
      >{t(`common.overlay_window_n`, { n: win_n })}</button>
    {:else if context?.scope === `document`}
      <span class="oth-sep">·</span>
      <span class="oth-window-chip static">{t(`common.overlay_document`)}</span>
    {:else if context?.scope === `job` && context.job_id}
      <span class="oth-sep">·</span>
      <span class="oth-window-chip static">Job {context.job_id}</span>
    {/if}
  </h4>
  {#if context?.scope === `selection` && context.selection_count != null}
    <div class="oth-subtitle">{t(`common.overlay_selected_atoms`, { n: context.selection_count })}</div>
  {:else if file_label}
    <div class="oth-subtitle" title={file_label}>{file_label}</div>
  {/if}
  {#if !validity.ok && validity.reason === `closed`}
    <div class="oth-banner oth-banner-error">{t(`common.overlay_target_closed`)}</div>
  {:else if !validity.ok && validity.reason === `empty`}
    <div class="oth-banner">{t(`common.overlay_no_structure_in_window`, { n: win_n })}</div>
  {/if}
  {#if switcher_open}
    <div class="oth-switcher" role="menu">
      {#each choices as c (c.id)}
        <button type="button" class="oth-choice" class:current={c.current} onclick={() => choose(c.id)}>
          <span class="oth-check">{c.current ? `✓` : ``}</span>
          <span class="oth-choice-win">{t(`common.overlay_window_n`, { n: c.n })}</span>
          <span class="oth-choice-name" title={c.name}>{c.name}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .overlay-target-header {
    position: relative;
    margin: 0 0 6px;
  }
  .oth-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 1em;
    min-width: 0;
  }
  .oth-sep {
    color: var(--text-color-muted, #888);
  }
  .oth-window-chip {
    padding: 1px 7px;
    font-size: 0.82em;
    font-weight: 600;
    border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, currentColor 8%, transparent);
    color: var(--accent-color, #4a9eff);
    white-space: nowrap;
  }
  button.oth-window-chip {
    cursor: default;
  }
  button.oth-window-chip.switchable {
    cursor: pointer;
  }
  button.oth-window-chip.switchable:hover {
    background: color-mix(in srgb, currentColor 16%, transparent);
  }
  .oth-subtitle {
    margin-top: 2px;
    font-size: 0.8em;
    color: var(--text-color-muted, #999);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .oth-banner {
    margin-top: 4px;
    padding: 4px 8px;
    font-size: 0.78em;
    border-radius: 4px;
    background: color-mix(in srgb, var(--warning-color, #d9a03f) 14%, transparent);
    color: var(--warning-color, #d9a03f);
  }
  .oth-banner-error {
    background: color-mix(in srgb, var(--error-color, #e05252) 14%, transparent);
    color: var(--error-color, #e05252);
  }
  .oth-switcher {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 30;
    min-width: 220px;
    max-width: 100%;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--surface-bg, #1e1e1e);
    border: 1px solid var(--border-color, #444);
    border-radius: 6px;
    box-shadow: 0 8px 16px -4px rgba(0, 0, 0, 0.35);
  }
  .oth-choice {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 4px;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    font-size: 0.85em;
    min-width: 0;
  }
  .oth-choice:hover {
    background: color-mix(in srgb, currentColor 10%, transparent);
  }
  .oth-choice.current {
    color: var(--accent-color, #4a9eff);
  }
  .oth-check {
    width: 1em;
    flex: 0 0 1em;
  }
  .oth-choice-win {
    flex: 0 0 auto;
    font-weight: 600;
  }
  .oth-choice-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-color-muted, #999);
  }
</style>

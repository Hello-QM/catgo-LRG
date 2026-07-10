<script lang="ts">
  /** 每-pane 工作流浮窗壳 — fixed 目标 (本视口), 内容复用
   * WorkflowPanelContent (与双模式面板同一份)。 */
  import { DraggablePane } from '$lib'
  import type { AnyStructure } from '$lib/structure'
  import type { Snippet } from 'svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import OverlayTargetHeader from '$lib/overlay/OverlayTargetHeader.svelte'
  import WorkflowPanelContent from './WorkflowPanelContent.svelte'
  import {
    close_overlay_instance,
    create_viewport_target_context,
    flash_viewport,
    register_overlay_instance,
    type OverlayTargetContext,
  } from '$lib/overlay/overlay-target.svelte'

  load_i18n_module('structure')
  load_i18n_module('common')

  let {
    show = $bindable(false),
    max_height = '',
    children,
    structure,
    viewer_id,
    on_open_workflow_editor,
  }: {
    show?: boolean
    max_height?: string
    children?: Snippet
    structure?: AnyStructure
    /** 宿主视口的稳定标识 (`tab:leaf`) — 本弹层的冻结目标 */
    viewer_id?: string
    on_open_workflow_editor?: (workflow_id: string) => void
  } = $props()

  // 对象级弹层 (fixed policy): 打开时冻结目标上下文, 关闭时注销
  let target = $state<OverlayTargetContext | null>(null)
  let overlay_instance_id: string | null = null
  $effect(() => {
    if (show && viewer_id && !target) {
      target = create_viewport_target_context(viewer_id, `WorkflowPane`)
      overlay_instance_id = register_overlay_instance({
        type: `workflow-pane`,
        target,
        policy: `fixed`,
      }).id
      flash_viewport(viewer_id)
    } else if (!show && overlay_instance_id) {
      close_overlay_instance(overlay_instance_id)
      overlay_instance_id = null
      target = null
    }
  })
  $effect(() => {
    return () => {
      if (overlay_instance_id) close_overlay_instance(overlay_instance_id)
    }
  })

  function open_editor_and_close(workflow_id: string) {
    if (on_open_workflow_editor) on_open_workflow_editor(workflow_id)
    else window.location.hash = `#workflow?id=${workflow_id}`
    show = false
  }
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  close_on_click_outside={false}
  max_width="28em"
  max_height={max_height || ``}
  pane_props={{ class: 'workflow-pane' }}
>
  {#if target}
    <OverlayTargetHeader title={t('common.workflow')} context={target} />
  {:else}
    <h4 class="pane-title">{t('common.workflow')}</h4>
  {/if}
  <div class="pane-content">
    {#if children}
      {@render children()}
    {:else}
      <WorkflowPanelContent
        {target}
        active={show}
        fallback_structure={structure}
        on_open_workflow_editor={open_editor_and_close}
      />
    {/if}
  </div>
</DraggablePane>

<style>
  .pane-title {
    margin: 0 0 6px;
    font-size: 1em;
  }
  .pane-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
</style>

<script lang="ts">
  import '$lib/dialog-shared.css'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { job_script_store } from './job-script-store.svelte'
  import type { JobScript } from './workflow-types'

  load_i18n_module(`workflow`)

  let {
    show = false,
    onclose,
  }: {
    show?: boolean
    onclose?: () => void
  } = $props()

  // ─── State ───
  let selected_id = $state<string | null>(null)
  let edit_name = $state(``)
  let edit_template = $state(``)
  let edit_cluster_tag = $state(``)
  let edit_calc_type = $state(``)
  let is_dirty = $state(false)

  // ─── Init store on show ───
  $effect(() => {
    if (show && !job_script_store.initialized) {
      job_script_store.init()
    }
  })

  // ─── Auto-select first script ───
  $effect(() => {
    if (show && job_script_store.scripts.length > 0 && !selected_id) {
      select_script(job_script_store.scripts[0].id)
    }
  })

  let selected_script = $derived(
    selected_id ? job_script_store.scripts.find(s => s.id === selected_id) : null
  )

  function select_script(id: string) {
    const s = job_script_store.find(id)
    if (!s) return
    selected_id = id
    edit_name = s.name
    edit_template = s.template
    edit_cluster_tag = s.cluster_tag
    edit_calc_type = s.calc_type
    is_dirty = false
  }

  function handle_save() {
    if (!selected_id || !selected_script) return

    if (selected_script.is_builtin) {
      // Auto-create a custom copy
      const new_id = job_script_store.add({
        name: edit_name.trim() || `${selected_script.name} (Custom)`,
        template: edit_template,
        cluster_tag: edit_cluster_tag,
        calc_type: edit_calc_type,
      })
      select_script(new_id)
    } else {
      job_script_store.update(selected_id, {
        name: edit_name.trim(),
        template: edit_template,
        cluster_tag: edit_cluster_tag,
        calc_type: edit_calc_type,
      })
      is_dirty = false
    }
  }

  function handle_duplicate() {
    if (!selected_id || !selected_script) return
    const new_id = job_script_store.duplicate(selected_id, `${selected_script.name} (Copy)`)
    if (new_id) select_script(new_id)
  }

  function handle_delete() {
    if (!selected_id || !selected_script || selected_script.is_builtin) return
    job_script_store.remove(selected_id)
    selected_id = null
    // Select first script if available
    if (job_script_store.scripts.length > 0) {
      select_script(job_script_store.scripts[0].id)
    }
  }

  function handle_new() {
    const new_id = job_script_store.add({
      name: `New Script`,
      template: `#!/bin/bash\n#SBATCH --job-name={{job_name}}\n#SBATCH --nodes={{nodes}}\n#SBATCH --time={{walltime}}\n\n{% if python_env_activate %}# Activate Python environment\n{{python_env_activate}}\n{% endif %}\ncd {{work_dir}}\n{{vasp_run_command}}\n`,
      cluster_tag: ``,
      calc_type: ``,
    })
    select_script(new_id)
    is_dirty = true
  }

  function mark_dirty() { is_dirty = true }

  // ─── Cluster tag options ───
  const CLUSTER_TAGS = [
    { value: ``, label: `Any cluster` },
    { value: `shaheen`, label: `Shaheen` },
    { value: `expanse`, label: `Expanse` },
    { value: `slurm`, label: `SLURM (generic)` },
    { value: `pbs`, label: `PBS (generic)` },
  ]

  // ─── Backdrop handling (same pattern as RunConfigDialog) ───
  let mousedown_on_backdrop = false
  function handle_backdrop_down(e: MouseEvent) {
    mousedown_on_backdrop = e.target === e.currentTarget
  }
  function handle_backdrop_up(e: MouseEvent) {
    if (mousedown_on_backdrop && e.target === e.currentTarget) onclose?.()
    mousedown_on_backdrop = false
  }
  function handle_keydown(e: KeyboardEvent) {
    if (e.key === `Escape`) onclose?.()
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog-backdrop" onmousedown={handle_backdrop_down} onmouseup={handle_backdrop_up} onkeydown={handle_keydown} role="dialog" aria-modal="true" tabindex="-1">
    <div class="dialog-modal jsw-modal">
      <!-- Header -->
      <div class="modal-header">
        <h2 class="modal-title">{t(`workflow.job_script_workplace`)}</h2>
        <button class="close-btn" onclick={() => onclose?.()}>x</button>
      </div>

      <!-- Two-panel body -->
      <div class="jsw-body">
        <!-- Left sidebar: script list -->
        <div class="jsw-sidebar">
          <button class="jsw-new-btn" onclick={handle_new}>{t(`workflow.job_script_new`)}</button>

          <div class="jsw-list">
            {#if job_script_store.loading}
              <div class="jsw-loading">{t(`workflow.loading`)}</div>
            {:else}
              {#each job_script_store.grouped as group}
                {#if group.scripts.length > 0 || group.category === ``}
                  <div class="jsw-group-label">{group.label}</div>
                  {#each group.scripts as script}
                    <button
                      class="jsw-item"
                      class:active={selected_id === script.id}
                      onclick={() => select_script(script.id)}
                    >
                      <span class="jsw-item-icon">{script.is_builtin ? `🔒` : `📝`}</span>
                      <span class="jsw-item-name">{script.name}</span>
                      {#if script.cluster_tag}
                        <span class="jsw-item-tag">{script.cluster_tag}</span>
                      {/if}
                    </button>
                  {/each}
                {/if}
              {/each}
            {/if}
          </div>
        </div>

        <!-- Right panel: editor -->
        <div class="jsw-editor">
          {#if selected_script}
            <div class="jsw-editor-fields">
              <div class="jsw-field-row">
                <div class="jsw-field" style="flex:2">
                  <label class="jsw-label">{t(`workflow.name`)}</label>
                  <input type="text" class="jsw-input"
                    bind:value={edit_name}
                    oninput={mark_dirty}
                    disabled={selected_script.is_builtin}
                  />
                </div>
              </div>

              <div class="jsw-field-row">
                <div class="jsw-field">
                  <label class="jsw-label">{t(`workflow.cluster`)}</label>
                  <select class="jsw-input jsw-select"
                    bind:value={edit_cluster_tag}
                    onchange={mark_dirty}
                    disabled={selected_script.is_builtin}
                  >
                    {#each CLUSTER_TAGS as opt}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  </select>
                </div>
                <div class="jsw-field">
                  <label class="jsw-label">{t(`workflow.calc_type`)}</label>
                  <select class="jsw-input jsw-select"
                    bind:value={edit_calc_type}
                    onchange={mark_dirty}
                    disabled={selected_script.is_builtin}
                  >
                    <option value="">{t(`workflow.general`)}</option>
                    {#each Object.entries(job_script_store.categories) as [key, cat]}
                      <option value={key}>{cat.label}</option>
                    {/each}
                  </select>
                </div>
              </div>
            </div>

            <div class="jsw-template-area">
              <label class="jsw-label">{t(`workflow.template`)}</label>
              <textarea class="jsw-textarea"
                bind:value={edit_template}
                oninput={mark_dirty}
                rows={18}
                readonly={selected_script.is_builtin}
              ></textarea>
            </div>

            <div class="jsw-vars-hint">
              {t(`workflow.variables`)} <code>{"{{job_name}}"}</code> <code>{"{{nodes}}"}</code> <code>{"{{ntasks}}"}</code>
              <code>{"{{cpus_per_task}}"}</code> <code>{"{{walltime}}"}</code> <code>{"{{partition}}"}</code>
              <code>{"{{work_dir}}"}</code> <code>{"{{python_env_activate}}"}</code> <code>{"{{vasp_run_command}}"}</code>
            </div>

            <div class="jsw-actions">
              {#if selected_script.is_builtin}
                <button class="jsw-btn jsw-btn-primary" onclick={handle_duplicate}>
                  {t(`workflow.job_script_customize_copy`)}
                </button>
              {:else}
                <button class="jsw-btn jsw-btn-danger" onclick={handle_delete}>{t(`workflow.delete`)}</button>
                <button class="jsw-btn" onclick={handle_duplicate}>{t(`workflow.duplicate`)}</button>
                <div style="flex:1"></div>
                <button class="jsw-btn jsw-btn-primary" onclick={handle_save} disabled={!is_dirty}>
                  {is_dirty ? t(`workflow.save`) : t(`workflow.saved`)}
                </button>
              {/if}
            </div>
          {:else}
            <div class="jsw-empty">
              <div style="font-size:28px; opacity:0.3; margin-bottom:8px">📝</div>
              <div>{t(`workflow.job_script_empty`)}</div>
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .jsw-modal {
    width: min(900px, 95vw);
    height: min(650px, 85vh);
  }

  .jsw-body {
    display: grid;
    grid-template-columns: 200px 1fr;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* ── Left sidebar ── */
  .jsw-sidebar {
    border-right: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .jsw-new-btn {
    margin: 8px;
    padding: 6px 10px;
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent-color, #3b82f6) 30%, transparent);
    border-radius: 5px;
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: all 0.15s;
  }
  .jsw-new-btn:hover {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 20%, transparent);
  }

  .jsw-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 8px 8px;
  }

  .jsw-loading {
    color: var(--text-color-muted);
    font-size: 11px;
    text-align: center;
    padding: 16px;
  }

  .jsw-group-label {
    font-size: 9px;
    font-weight: 700;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 8px 4px 3px;
    margin-top: 4px;
  }

  .jsw-item {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    padding: 5px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    text-align: left;
    transition: all 0.1s;
  }
  .jsw-item:hover {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .jsw-item.active {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent-color, #3b82f6) 30%, transparent);
    color: var(--text-color, light-dark(#374151, #eee));
  }

  .jsw-item-icon { font-size: 11px; flex-shrink: 0; }
  .jsw-item-name {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .jsw-item-tag {
    font-size: 8px; font-weight: 600; padding: 1px 4px; border-radius: 3px;
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 12%, transparent);
    color: var(--accent-color, #3b82f6);
    text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0;
  }

  /* ── Right editor ── */
  .jsw-editor {
    display: flex;
    flex-direction: column;
    padding: 12px 16px;
    gap: 8px;
    overflow-y: auto;
  }

  .jsw-editor-fields {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .jsw-field-row {
    display: flex;
    gap: 10px;
  }

  .jsw-field {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .jsw-label {
    font-size: 9px;
    font-weight: 600;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .jsw-input {
    padding: 6px 8px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 5px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-size: 12px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    width: 100%;
  }
  .jsw-input:focus {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .jsw-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .jsw-select {
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23484f58'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 24px;
  }

  .jsw-template-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-height: 0;
  }

  .jsw-textarea {
    flex: 1;
    min-height: 200px;
    padding: 8px 10px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 5px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 11px;
    line-height: 1.5;
    resize: none;
    outline: none;
    box-sizing: border-box;
  }
  .jsw-textarea:focus {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .jsw-textarea[readonly] {
    opacity: 0.7;
    cursor: default;
  }

  .jsw-vars-hint {
    font-size: 9px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    line-height: 1.8;
  }
  .jsw-vars-hint code {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 9px;
    color: #7ee787;
    font-family: inherit;
  }

  .jsw-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    padding-top: 4px;
  }

  .jsw-btn {
    padding: 6px 14px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    transition: all 0.15s;
  }
  .jsw-btn:hover {
    background: var(--surface-bg-hover, light-dark(#e5e7eb, #3a3a3a));
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .jsw-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .jsw-btn-primary {
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: #fff;
  }
  .jsw-btn-primary:hover {
    background: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
    color: #fff;
  }

  .jsw-btn-danger {
    color: var(--error-color, light-dark(#dc2626, #ef4444));
    border-color: color-mix(in srgb, var(--error-color) 30%, transparent);
  }
  .jsw-btn-danger:hover {
    background: color-mix(in srgb, var(--error-color) 12%, transparent);
  }

  .jsw-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-color-muted);
    font-size: 12px;
  }
</style>

<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('common')
  load_i18n_module('workflow')

  let {
    api_base,
    onclose,
    oncreated,
  }: {
    api_base: string
    onclose: () => void
    oncreated: (engine_key: string) => void
  } = $props()

  // ─── Form state ───
  let name = $state('')
  let commands = $state<string[]>([''])
  let input_files = $state<{ name: string; source: 'editor' | 'upstream' }[]>([])
  let output_files = $state<string[]>([''])
  let hpc_modules = $state<string[]>([''])

  let submitting = $state(false)
  let submit_error = $state('')

  // ─── Input files helpers ───
  function add_input_file() {
    input_files = [...input_files, { name: '', source: 'upstream' }]
  }
  function remove_input_file(i: number) {
    input_files = input_files.filter((_, idx) => idx !== i)
  }
  function set_input_file_name(i: number, val: string) {
    input_files = input_files.map((f, idx) => idx === i ? { ...f, name: val } : f)
  }
  function set_input_file_source(i: number, val: 'editor' | 'upstream') {
    input_files = input_files.map((f, idx) => idx === i ? { ...f, source: val } : f)
  }

  // ─── Commands helpers ───
  function add_command() {
    commands = [...commands, '']
  }
  function remove_command(i: number) {
    commands = commands.filter((_, idx) => idx !== i)
  }
  function set_command(i: number, val: string) {
    commands = commands.map((c, idx) => idx === i ? val : c)
  }

  // ─── Output files helpers ───
  function add_output_file() {
    output_files = [...output_files, '']
  }
  function remove_output_file(i: number) {
    output_files = output_files.filter((_, idx) => idx !== i)
  }
  function set_output_file(i: number, val: string) {
    output_files = output_files.map((f, idx) => idx === i ? val : f)
  }

  // ─── HPC modules helpers ───
  function add_module() {
    hpc_modules = [...hpc_modules, '']
  }
  function remove_module(i: number) {
    hpc_modules = hpc_modules.filter((_, idx) => idx !== i)
  }
  function set_module(i: number, val: string) {
    hpc_modules = hpc_modules.map((m, idx) => idx === i ? val : m)
  }

  // ─── Submit ───
  async function handle_submit() {
    if (!name.trim()) { submit_error = t('workflow.custom_command_name_required'); return }
    const valid_commands = commands.filter(c => c.trim())
    if (valid_commands.length === 0) { submit_error = t('workflow.custom_command_command_required'); return }

    submitting = true
    submit_error = ''

    const spec = {
      name: name.trim(),
      commands: valid_commands,
      input_files: input_files
        .filter(f => f.name.trim())
        .map(f => ({ name: f.name.trim(), source: f.source })),
      output_files: output_files.filter(f => f.trim()).map(f => f.trim()),
      hpc_modules: hpc_modules.filter(m => m.trim()).map(m => m.trim()),
    }

    try {
      const resp = await fetch(`${api_base}/workflow/engine-defs/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      })
      if (!resp.ok) {
        const msg = await resp.text().catch(() => `HTTP ${resp.status}`)
        throw new Error(msg)
      }
      const result = await resp.json()
      oncreated(result.engine_key ?? spec.name)
    } catch (err: any) {
      submit_error = err?.message ?? String(err)
    } finally {
      submitting = false
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ccw-overlay" onclick={onclose}>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ccw-modal" onclick={(e) => e.stopPropagation()}>

    <!-- Header -->
    <div class="ccw-header">
      <h3 class="ccw-title">{t('workflow.custom_command_title')}</h3>
      <button class="ccw-close-btn" onclick={onclose}>&times;</button>
    </div>

    <!-- Warning banner -->
    <div class="ccw-warning">
      <span class="ccw-warning-icon">⚠</span>
      {t('workflow.custom_command_warning')}
    </div>

    <!-- Form body -->
    <div class="ccw-body">

      <!-- Name -->
      <div class="ccw-section">
        <label class="ccw-label">{t('common.name')} <span class="ccw-req">*</span></label>
        <input
          class="ccw-input"
          type="text"
          placeholder={t('workflow.custom_command_name_placeholder')}
          bind:value={name}
        />
      </div>

      <!-- Commands -->
      <div class="ccw-section">
        <div class="ccw-section-header">
          <span class="ccw-label">{t('workflow.custom_command_commands')} <span class="ccw-req">*</span></span>
          <button class="ccw-add-btn" onclick={add_command}>+ {t('common.add')}</button>
        </div>
        <div class="ccw-help">{t('workflow.custom_command_commands_help')}</div>
        {#each commands as cmd, i}
          <div class="ccw-row">
            <input
              class="ccw-input ccw-mono"
              type="text"
              placeholder="e.g. python postprocess.py"
              value={cmd}
              oninput={(e) => set_command(i, e.currentTarget.value)}
            />
            {#if commands.length > 1}
              <button class="ccw-rm-btn" onclick={() => remove_command(i)}>×</button>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Input Files -->
      <div class="ccw-section">
        <div class="ccw-section-header">
          <span class="ccw-label">{t('workflow.custom_command_input_files')}</span>
          <button class="ccw-add-btn" onclick={add_input_file}>+ {t('common.add')}</button>
        </div>
        <div class="ccw-help">{t('workflow.custom_command_input_files_help_prefix')} <em>editor</em> = {t('workflow.custom_command_input_files_help_editor')}, <em>upstream</em> = {t('workflow.custom_command_input_files_help_upstream')}.</div>
        {#each input_files as file, i}
          <div class="ccw-row">
            <input
              class="ccw-input ccw-mono"
              type="text"
              placeholder="filename.ext"
              value={file.name}
              oninput={(e) => set_input_file_name(i, e.currentTarget.value)}
            />
            <select
              class="ccw-select"
              value={file.source}
              onchange={(e) => set_input_file_source(i, e.currentTarget.value as 'editor' | 'upstream')}
            >
              <option value="upstream">{t('workflow.custom_command_upstream')}</option>
              <option value="editor">{t('workflow.custom_command_editor')}</option>
            </select>
            <button class="ccw-rm-btn" onclick={() => remove_input_file(i)}>×</button>
          </div>
        {/each}
        {#if input_files.length === 0}
          <div class="ccw-empty">{t('workflow.custom_command_no_input_files')}</div>
        {/if}
      </div>

      <!-- Output Files -->
      <div class="ccw-section">
        <div class="ccw-section-header">
          <span class="ccw-label">{t('workflow.custom_command_output_files')}</span>
          <button class="ccw-add-btn" onclick={add_output_file}>+ {t('common.add')}</button>
        </div>
        <div class="ccw-help">{t('workflow.custom_command_output_files_help')}</div>
        {#each output_files as file, i}
          <div class="ccw-row">
            <input
              class="ccw-input ccw-mono"
              type="text"
              placeholder="output.txt"
              value={file}
              oninput={(e) => set_output_file(i, e.currentTarget.value)}
            />
            {#if output_files.length > 1}
              <button class="ccw-rm-btn" onclick={() => remove_output_file(i)}>×</button>
            {/if}
          </div>
        {/each}
      </div>

      <!-- HPC Modules -->
      <div class="ccw-section">
        <div class="ccw-section-header">
          <span class="ccw-label">{t('workflow.custom_command_hpc_modules')}</span>
          <button class="ccw-add-btn" onclick={add_module}>+ {t('common.add')}</button>
        </div>
        <div class="ccw-help">{t('workflow.custom_command_hpc_modules_help_prefix')} <code>module load</code>{t('workflow.custom_command_hpc_modules_help_suffix')}</div>
        {#each hpc_modules as mod, i}
          <div class="ccw-row">
            <input
              class="ccw-input ccw-mono"
              type="text"
              placeholder="e.g. python/3.10"
              value={mod}
              oninput={(e) => set_module(i, e.currentTarget.value)}
            />
            {#if hpc_modules.length > 1}
              <button class="ccw-rm-btn" onclick={() => remove_module(i)}>×</button>
            {/if}
          </div>
        {/each}
        {#if hpc_modules.length === 0}
          <div class="ccw-empty">{t('workflow.custom_command_no_modules')}</div>
        {/if}
      </div>

    </div>

    <!-- Footer -->
    <div class="ccw-footer">
      {#if submit_error}
        <div class="ccw-error">{submit_error}</div>
      {/if}
      <div class="ccw-footer-actions">
        <button class="ccw-cancel-btn" onclick={onclose} disabled={submitting}>{t('common.cancel')}</button>
        <button class="ccw-submit-btn" onclick={handle_submit} disabled={submitting}>
          {submitting ? t('workflow.custom_command_creating') : t('workflow.custom_command_create_node')}
        </button>
      </div>
    </div>

  </div>
</div>

<style>
  .ccw-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 9999;
    display: flex; align-items: center; justify-content: center;
  }
  .ccw-modal {
    width: min(640px, 94vw);
    max-height: 90vh;
    background: var(--surface-bg, #1e2330);
    border: 1px solid var(--border-color, rgba(255,255,255,0.1));
    border-radius: 10px;
    display: flex; flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    color: var(--text-color, #e2e8f0);
    overflow: hidden;
  }

  /* Header */
  .ccw-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.08));
    flex-shrink: 0;
  }
  .ccw-title { margin: 0; font-size: 14px; font-weight: 700; }
  .ccw-close-btn {
    width: 28px; height: 28px; border-radius: 5px; border: none;
    background: transparent; color: var(--text-color-muted, #94a3b8);
    font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    line-height: 1;
  }
  .ccw-close-btn:hover { background: rgba(255,255,255,0.08); color: var(--text-color, #e2e8f0); }

  /* Warning */
  .ccw-warning {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 16px;
    background: rgba(245, 158, 11, 0.12);
    border-bottom: 1px solid rgba(245, 158, 11, 0.25);
    font-size: 12px; color: #fbbf24; flex-shrink: 0;
  }
  .ccw-warning-icon { font-size: 14px; }

  /* Body */
  .ccw-body {
    flex: 1; overflow-y: auto; padding: 14px 16px;
    display: flex; flex-direction: column; gap: 16px;
    scrollbar-width: thin;
  }

  /* Sections */
  .ccw-section { display: flex; flex-direction: column; gap: 6px; }
  .ccw-section-header { display: flex; align-items: center; justify-content: space-between; }
  .ccw-label { font-size: 12px; font-weight: 600; color: var(--text-color, #e2e8f0); }
  .ccw-req { color: #f87171; }
  .ccw-help { font-size: 11px; color: var(--text-color-muted, #94a3b8); }
  .ccw-help code {
    font-family: monospace; font-size: 10px;
    background: rgba(255,255,255,0.06); padding: 1px 4px; border-radius: 3px;
  }
  .ccw-empty { font-size: 11px; color: var(--text-color-muted, #64748b); font-style: italic; }

  /* Row (input + remove button) */
  .ccw-row { display: flex; align-items: center; gap: 6px; }

  /* Inputs */
  .ccw-input {
    flex: 1; min-width: 0; padding: 6px 10px;
    background: var(--input-bg, rgba(255,255,255,0.05));
    border: 1px solid var(--border-color, rgba(255,255,255,0.12));
    border-radius: 5px; color: inherit; font-size: 12px; font-family: inherit;
    outline: none;
  }
  .ccw-input:focus { border-color: var(--accent-color, #3b82f6); }
  .ccw-mono { font-family: monospace; }
  .ccw-select {
    padding: 6px 8px; flex-shrink: 0; width: 100px;
    background: var(--input-bg, rgba(255,255,255,0.05));
    border: 1px solid var(--border-color, rgba(255,255,255,0.12));
    border-radius: 5px; color: inherit; font-size: 12px; font-family: inherit;
    outline: none; cursor: pointer;
  }
  .ccw-rm-btn {
    flex-shrink: 0; width: 24px; height: 24px;
    background: transparent; border: 1px solid var(--border-color, rgba(255,255,255,0.1));
    border-radius: 4px; color: var(--text-color-muted, #94a3b8); font-size: 14px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    line-height: 1;
  }
  .ccw-rm-btn:hover { background: rgba(239,68,68,0.15); color: #f87171; border-color: rgba(239,68,68,0.3); }
  .ccw-add-btn {
    padding: 3px 10px; border-radius: 4px; font-size: 11px; font-family: inherit;
    background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.25);
    color: #60a5fa; cursor: pointer;
  }
  .ccw-add-btn:hover { background: rgba(59,130,246,0.2); }

  /* Footer */
  .ccw-footer {
    flex-shrink: 0; padding: 12px 16px;
    border-top: 1px solid var(--border-color, rgba(255,255,255,0.08));
    display: flex; flex-direction: column; gap: 8px;
  }
  .ccw-error {
    font-size: 12px; color: #f87171;
    background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2);
    padding: 6px 10px; border-radius: 5px;
  }
  .ccw-footer-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .ccw-cancel-btn {
    padding: 6px 16px; border-radius: 6px; font-size: 12px; font-family: inherit;
    background: transparent; border: 1px solid var(--border-color, rgba(255,255,255,0.15));
    color: var(--text-color-muted, #94a3b8); cursor: pointer;
  }
  .ccw-cancel-btn:hover:not(:disabled) { background: rgba(255,255,255,0.06); color: var(--text-color, #e2e8f0); }
  .ccw-cancel-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .ccw-submit-btn {
    padding: 6px 20px; border-radius: 6px; font-size: 12px; font-weight: 600; font-family: inherit;
    background: var(--accent-color, #3b82f6); border: none;
    color: white; cursor: pointer;
  }
  .ccw-submit-btn:hover:not(:disabled) { filter: brightness(1.15); }
  .ccw-submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>

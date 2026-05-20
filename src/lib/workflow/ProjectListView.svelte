<script lang="ts">
  import * as project_api from '$lib/api/project'
  import type { ProjectSummary } from '$lib/api/project'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  let {
    onselect,
    on_all_workflows,
    onclose,
    ondbchange,
  }: {
    onselect: (project_id: string) => void
    on_all_workflows?: () => void
    onclose?: () => void
    ondbchange?: () => void
  } = $props()

  load_i18n_module('app')
  load_i18n_module('common')

  let projects = $state<ProjectSummary[]>([])
  let is_loading = $state(false)
  let error = $state(``)
  let show_create_dialog = $state(false)
  let new_name = $state(``)
  let new_description = $state(``)

  async function load_projects() {
    is_loading = true
    error = ``
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)
      projects = await Promise.race([
        project_api.list_projects(),
        new Promise<ProjectSummary[]>((_, reject) => {
          ctrl.signal.addEventListener(`abort`, () =>
            reject(new Error(`Request aborted (timeout)`)),
          )
        }),
      ])
      clearTimeout(timer)
    } catch (err) {
      const msg = String(err)
      if (msg.includes(`abort`)) {
        error = t('app.cannot_connect_backend')
      } else {
        error = msg
      }
      console.error(`[ProjectListView] load_projects error:`, err)
    } finally {
      is_loading = false
    }
  }

  async function create_project() {
    const name = new_name.trim()
    if (!name) return
    error = ``
    try {
      const created = await project_api.create_project(name, new_description.trim())
      projects = [created, ...projects]
      new_name = ``
      new_description = ``
      show_create_dialog = false
      ondbchange?.()
    } catch (err) {
      error = String(err)
    }
  }

  async function handle_delete(project: ProjectSummary) {
    if (!confirm(t('app.delete_project_irreversible', { name: project.name }))) return
    error = ``
    try {
      await project_api.delete_project(project.id)
      projects = projects.filter((p) => p.id !== project.id)
      ondbchange?.()
    } catch (err) {
      error = String(err)
    }
  }

  function format_date(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: `short`,
        day: `numeric`,
        hour: `2-digit`,
        minute: `2-digit`,
      })
    } catch {
      return iso
    }
  }

  function workflow_count_label(count: number): string {
    return t('app.workflow_count', { n: String(count), s: count === 1 ? `` : `s` })
  }

  // Load projects on mount
  $effect(() => {
    load_projects()
  })
</script>

<div class="project-list-view">
  <!-- Header -->
  <div class="header">
    {#if onclose}
      <button type="button" class="close-btn" onclick={onclose} title={t('app.back_to_structure_viewer')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    {/if}
    <div class="tab-nav">
      <button class="tab-btn active">{t('common.projects')}</button>
      {#if on_all_workflows}
        <button class="tab-btn" onclick={on_all_workflows}>{t('app.all_workflows')}</button>
      {/if}
    </div>
    <div class="header-spacer"></div>
    <button class="primary-btn" onclick={() => (show_create_dialog = true)}>{t('app.new_project')}</button>
  </div>

  <!-- Create dialog (inline, conditionally shown) -->
  {#if show_create_dialog}
    <div class="create-form">
      <input
        class="form-input"
        bind:value={new_name}
        placeholder={t('app.project_name_placeholder')}
      />
      <input
        class="form-input"
        bind:value={new_description}
        placeholder={t('app.description_optional_placeholder')}
      />
      <div class="form-actions">
        <button class="primary-btn" onclick={create_project} disabled={!new_name.trim()}>
          {t('common.create')}
        </button>
        <button
          class="secondary-btn"
          onclick={() => {
            show_create_dialog = false
            new_name = ``
            new_description = ``
          }}
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  {/if}

  <!-- Error -->
  {#if error}
    <div class="error-bar">{error}</div>
  {/if}

  <!-- Loading / Empty / Grid -->
  {#if is_loading}
    <div class="loading">{t('app.loading_projects')}</div>
  {:else if projects.length === 0}
    <div class="empty-state">
      <p>{t('app.no_projects_yet')}</p>
    </div>
  {:else}
    <div class="project-grid">
      {#each projects as project}
        <div class="project-card">
          <button class="card-main" onclick={() => onselect(project.id)}>
            <div class="card-header-row">
              <div class="card-name">{project.name}</div>
              {#if project.workflow_count !== undefined && project.workflow_count > 0}
                <span class="card-wf-count">{workflow_count_label(project.workflow_count)}</span>
              {/if}
            </div>
            {#if project.description}
              <div class="card-desc">{project.description}</div>
            {/if}
            <div class="card-meta">
              <span class="card-date">{format_date(project.updated_at)}</span>
            </div>
          </button>
          <button class="card-delete" onclick={() => handle_delete(project)} title={t('common.delete')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            </svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .project-list-view {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    color: var(--text-color, #eee);
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 13px;
    overflow-y: auto;
    padding: 24px 32px;
    max-width: 900px;
    margin: 0 auto;
    box-sizing: border-box;
  }

  .header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }

  .header-spacer {
    flex: 1;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-color-muted, #94a3b8);
    cursor: pointer;
    flex-shrink: 0;
  }

  .close-btn:hover {
    background: var(--surface-bg-hover);
    color: var(--text-color, #eee);
  }

  .tab-nav {
    display: flex;
    align-items: center;
    gap: 2px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 8px;
    padding: 3px;
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--text-color-muted, #94a3b8);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .tab-btn:hover {
    color: var(--text-color, #eee);
    background: rgba(255, 255, 255, 0.06);
  }

  .tab-btn.active {
    background: var(--surface-bg, rgba(255, 255, 255, 0.08));
    color: var(--text-color, #eee);
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .primary-btn {
    padding: 8px 16px;
    background: var(--accent-color, #3b82f6);
    border: none;
    border-radius: 6px;
    color: white;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }

  .primary-btn:hover {
    filter: brightness(1.15);
  }

  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .secondary-btn {
    padding: 6px 12px;
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-color-muted, #94a3b8);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .secondary-btn:hover {
    background: var(--surface-bg-hover);
    color: var(--text-color, #eee);
  }

  .create-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: var(--surface-bg);
    border: 1px solid var(--accent-color, #3b82f6);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
  }

  .form-input {
    width: 100%;
    padding: 8px 12px;
    background: var(--surface-bg-hover);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    color: var(--text-color, #eee);
    font-size: 13px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.2s;
  }

  .form-input::placeholder {
    color: var(--text-color-muted);
  }

  .form-input:focus {
    border-color: var(--accent-color, #3b82f6);
  }

  .form-actions {
    display: flex;
    gap: 8px;
  }

  .error-bar {
    padding: 8px 12px;
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    color: #ef4444;
    font-size: 12px;
    margin-bottom: 16px;
  }

  .loading,
  .empty-state {
    padding: 24px;
    text-align: center;
    color: var(--text-color-muted);
    font-size: 13px;
  }

  .empty-state p {
    margin: 0;
  }

  .project-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
  }

  .project-card {
    display: flex;
    align-items: stretch;
    background: var(--surface-bg);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    overflow: hidden;
    transition: all 0.2s;
  }

  .project-card:hover {
    border-color: rgba(59, 130, 246, 0.3);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    transform: translateY(-1px);
  }

  .card-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px 18px;
    background: none;
    border: none;
    text-align: left;
    color: inherit;
    cursor: pointer;
    font-family: inherit;
    min-width: 0;
  }

  .card-header-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .card-name {
    font-size: 15px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-wf-count {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent-color, #60a5fa);
    background: rgba(59, 130, 246, 0.12);
    padding: 2px 7px;
    border-radius: 10px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .card-desc {
    font-size: 11px;
    color: var(--text-color-muted, #94a3b8);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-meta {
    display: flex;
    gap: 12px;
    margin-top: 4px;
  }

  .card-date {
    font-size: 11px;
    color: var(--text-color-muted);
  }

  .card-delete {
    display: flex;
    align-items: center;
    padding: 12px;
    background: none;
    border: none;
    border-left: 1px solid var(--border-color);
    color: var(--text-color-muted);
    cursor: pointer;
    transition: all 0.2s;
  }

  .card-delete:hover {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
  }
</style>

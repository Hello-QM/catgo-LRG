<script lang="ts">
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'
  import { download_manager, format_download_size, type DownloadTask } from '$lib/downloads/download-manager.svelte'

  load_i18n_module('common')

  const active_count = $derived(download_manager.tasks.filter((task) => task.status === 'queued' || task.status === 'selecting' || task.status === 'downloading').length)
  const visible_tasks = $derived(download_manager.tasks)

  function progress(task: DownloadTask): number | null {
    if (!task.total_bytes || task.total_bytes <= 0) return null
    return Math.max(0, Math.min(100, Math.round((task.received_bytes / task.total_bytes) * 100)))
  }

  function status_label(task: DownloadTask): string {
    if (task.status === 'selecting') return t('common.download_selecting_location')
    if (task.status === 'queued') return t('common.download_queued')
    if (task.status === 'downloading') return task.is_archive ? t('common.download_archiving') : t('common.downloading')
    if (task.status === 'completed') return t('common.download_completed')
    if (task.status === 'canceled') return t('common.download_canceled')
    return t('common.download_failed')
  }
</script>

{#if visible_tasks.length > 0}
  {#if download_manager.panel_open}
    <section class="download-panel" aria-label="Download manager">
      <div class="download-header">
        <div>
          <strong>{t('common.downloads')}</strong>
          {#if active_count > 0}
            <span>{t('common.downloads_active', { count: active_count })}</span>
          {/if}
        </div>
        <div class="header-actions">
          <button onclick={() => download_manager.clear_finished()} disabled={visible_tasks.every((task) => task.status === 'downloading' || task.status === 'queued' || task.status === 'selecting')}>
            {t('common.downloads_clear_finished')}
          </button>
          <button class="icon-btn" onclick={() => download_manager.panel_open = false} aria-label={t('common.close')}>×</button>
        </div>
      </div>

      <div class="download-list">
        {#each visible_tasks as task (task.id)}
          <article class="download-task" class:failed={task.status === 'failed'} class:done={task.status === 'completed'}>
            <div class="task-main">
              <div class="task-title" title={task.source_path}>{task.filename}</div>
              <div class="task-status">
                {status_label(task)}
                {#if task.save_path}
                  <span title={task.save_path}> · {task.save_path}</span>
                {/if}
              </div>
            </div>

            {#if task.status === 'downloading'}
              {@const pct = progress(task)}
              <div class="progress-row">
                {#if pct !== null}
                  <div class="progress-track"><div class="progress-fill" style:width={`${pct}%`}></div></div>
                  <span>{pct}%</span>
                {:else}
                  <div class="progress-track indeterminate"><div class="progress-fill"></div></div>
                  <span>{format_download_size(task.received_bytes)}</span>
                {/if}
              </div>
            {:else if task.status === 'completed'}
              <div class="task-meta">{t('common.download_saved_size', { size: format_download_size(task.received_bytes) })}</div>
            {:else if task.status === 'failed'}
              <div class="task-error">{task.error}</div>
            {:else if task.status === 'selecting' || task.status === 'queued'}
              <div class="task-meta">{format_download_size(task.received_bytes)}</div>
            {/if}

            <div class="task-actions">
              {#if task.status === 'downloading' || task.status === 'queued' || task.status === 'selecting'}
                <button onclick={() => download_manager.cancel(task.id)}>{t('common.cancel')}</button>
              {:else}
                <button onclick={() => download_manager.remove(task.id)}>{t('common.close')}</button>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </section>
  {:else}
    <button class="download-pill" onclick={() => download_manager.panel_open = true}>
      {t('common.downloads')}
      {#if active_count > 0}
        <span>{active_count}</span>
      {/if}
    </button>
  {/if}
{/if}

<style>
  .download-panel {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 9000;
    width: min(440px, calc(100vw - 32px));
    max-height: min(520px, calc(100vh - 32px));
    display: flex;
    flex-direction: column;
    color: var(--text-color, #f8fafc);
    background: light-dark(rgba(255, 255, 255, 0.96), rgba(17, 24, 39, 0.96));
    border: 1px solid light-dark(rgba(15, 23, 42, 0.12), rgba(255, 255, 255, 0.14));
    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
    border-radius: 14px;
    overflow: hidden;
    backdrop-filter: blur(14px);
  }

  .download-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid light-dark(rgba(15, 23, 42, 0.1), rgba(255, 255, 255, 0.1));
  }

  .download-header strong { font-size: 14px; }
  .download-header span { margin-left: 8px; color: var(--text-color-muted, #64748b); font-size: 12px; }
  .header-actions { display: flex; align-items: center; gap: 6px; }

  button {
    border: 1px solid light-dark(rgba(15, 23, 42, 0.12), rgba(255, 255, 255, 0.14));
    background: light-dark(rgba(15, 23, 42, 0.05), rgba(255, 255, 255, 0.08));
    color: inherit;
    border-radius: 8px;
    padding: 5px 9px;
    cursor: pointer;
    font-size: 12px;
  }

  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .icon-btn { width: 28px; height: 28px; padding: 0; font-size: 18px; line-height: 1; }

  .download-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    overflow: auto;
  }

  .download-task {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px 10px;
    padding: 10px;
    border-radius: 10px;
    background: light-dark(rgba(15, 23, 42, 0.04), rgba(255, 255, 255, 0.06));
  }

  .download-task.failed { border: 1px solid rgba(239, 68, 68, 0.35); }
  .download-task.done { border: 1px solid rgba(34, 197, 94, 0.28); }
  .task-main { min-width: 0; }
  .task-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 13px; }
  .task-status, .task-meta, .task-error { margin-top: 3px; font-size: 12px; color: var(--text-color-muted, #64748b); }
  .task-error { color: var(--error-color, #ef4444); word-break: break-word; }
  .task-actions { grid-row: span 2; display: flex; align-items: flex-start; }

  .progress-row {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-color-muted, #64748b);
  }

  .progress-track {
    position: relative;
    flex: 1;
    height: 7px;
    border-radius: 999px;
    overflow: hidden;
    background: light-dark(rgba(15, 23, 42, 0.1), rgba(255, 255, 255, 0.12));
  }

  .progress-fill {
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #0ea5e9, #22c55e);
  }

  .indeterminate .progress-fill {
    width: 45%;
    animation: slide-progress 1.2s ease-in-out infinite;
  }

  .download-pill {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 9000;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
    background: #0f172a;
    color: #fff;
  }

  .download-pill span {
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 999px;
    background: #22c55e;
    color: #04111f;
  }

  @keyframes slide-progress {
    0% { transform: translateX(-110%); }
    100% { transform: translateX(240%); }
  }
</style>

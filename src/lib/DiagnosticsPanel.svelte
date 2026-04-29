<script lang="ts">
  import { API_BASE } from '$lib/api/config'

  let status = $state<any>(null)
  let errors = $state<any[]>([])
  let loading = $state(true)

  async function refresh() {
    loading = true
    try {
      const [statusRes, errorsRes] = await Promise.all([
        fetch(`${API_BASE}/system/status`).then(r => r.json()).catch(() => null),
        fetch(`${API_BASE}/system/errors?limit=20`).then(r => r.json()).catch(() => []),
      ])
      status = statusRes
      errors = errorsRes
    } finally {
      loading = false
    }
  }

  $effect(() => { refresh() })
</script>

<div class="diagnostics">
  <div class="diag-header">
    <h3>System Diagnostics</h3>
    <button class="diag-refresh" onclick={refresh}>Refresh</button>
  </div>

  {#if loading}
    <p class="diag-loading">Loading...</p>
  {:else}
    <div class="diag-section">
      <h4>Status</h4>
      {#if status}
        <div class="diag-status-row">
          <span>Backend: <span class="diag-ok">{status.backend}</span></span>
          <span>HPC: <span class="diag-mono">{status.hpc_connections}</span> connections</span>
        </div>
        {#if status.hpc_sessions?.length}
          <div class="diag-sessions">
            {#each status.hpc_sessions as s}
              <div class="diag-session">{s.username}@{s.host}</div>
            {/each}
          </div>
        {/if}
      {:else}
        <p class="diag-error">Backend unreachable</p>
      {/if}
    </div>

    <div class="diag-section">
      <h4>Recent Errors ({errors.length})</h4>
      {#if errors.length === 0}
        <p class="diag-empty">No recent errors</p>
      {:else}
        <div class="diag-error-list">
          {#each errors as err}
            <div class="diag-error-entry">
              <span class="diag-time">{err.timestamp?.slice(11, 19)}</span>
              <span class="diag-cat">[{err.category}]</span>
              <span>{err.message}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .diagnostics { padding: 16px; }
  .diag-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .diag-header h3 { margin: 0; font-size: 16px; }
  .diag-refresh { padding: 4px 8px; font-size: 12px; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; background: transparent; }
  .diag-section { margin-bottom: 16px; }
  .diag-section h4 { margin: 0 0 8px; font-size: 13px; }
  .diag-status-row { display: flex; gap: 16px; font-size: 13px; }
  .diag-ok { color: #22c55e; }
  .diag-mono { font-family: monospace; }
  .diag-sessions { margin-left: 16px; }
  .diag-session { font-family: monospace; font-size: 12px; }
  .diag-error { color: #ef4444; font-size: 13px; }
  .diag-loading { color: #888; font-size: 13px; }
  .diag-empty { color: #888; font-size: 12px; }
  .diag-error-list { max-height: 256px; overflow-y: auto; }
  .diag-error-entry { font-size: 11px; border-left: 2px solid #ef4444; padding: 4px 0 4px 8px; margin-bottom: 2px; }
  .diag-time { color: #888; }
  .diag-cat { font-weight: 500; margin-left: 4px; }
</style>

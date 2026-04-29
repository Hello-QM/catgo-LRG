<!-- src/lib/workflow/WorkflowListV2.svelte -->
<script lang="ts">
  import { list_v2_workflows, type V2WorkflowSummary } from '$lib/api/workflow-v2'

  interface Props {
    onselect?: (id: string) => void
  }
  let { onselect }: Props = $props()

  let workflows = $state<V2WorkflowSummary[]>([])
  let loading = $state(true)
  let error = $state('')

  async function load() {
    loading = true
    error = ''
    try {
      workflows = await list_v2_workflows()
    } catch (e: any) {
      error = e.message || 'Failed to load workflows'
    } finally {
      loading = false
    }
  }

  $effect(() => { load() })

  const STATUS_COLORS: Record<string, string> = {
    draft: '#475569',
    running: '#3b82f6',
    paused: '#a78bfa',
    completed: '#22c55e',
    failed: '#ef4444',
  }

  function fmt_date(iso: string | null): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleString()
  }
</script>

<div class="v2list">
  <div class="header">
    <h3>Engine Workflows</h3>
    <button onclick={load} class="refresh-btn">↻ Refresh</button>
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  {#if loading}
    <div class="loading">Loading…</div>
  {:else if workflows.length === 0}
    <div class="empty">No engine workflows yet. Create one via MCP or Python API.</div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
          <th>Tasks</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {#each workflows as wf}
          <tr onclick={() => onselect?.(wf.id)} class="clickable">
            <td class="name">{wf.name}</td>
            <td>
              <span class="badge" style="background:{STATUS_COLORS[wf.status] ?? '#475569'}">
                {wf.status}
              </span>
            </td>
            <td>{wf.task_count}</td>
            <td class="date">{fmt_date(wf.created_at)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .v2list { padding: 16px; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  h3 { margin: 0; color: var(--text-color); font-size: 16px; }
  .refresh-btn { background: none; border: 1px solid var(--border-color); color: var(--text-color); padding: 4px 10px; border-radius: 4px; cursor: pointer; }
  .error { color: #ef4444; margin-bottom: 8px; font-size: 13px; }
  .loading, .empty { color: var(--text-color-dim); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--text-color-dim); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid var(--border-color); }
  td { padding: 8px; border-bottom: 1px solid var(--border-color, #333); color: var(--text-color); }
  .clickable { cursor: pointer; }
  .clickable:hover { background: var(--hover-bg, rgba(255,255,255,0.05)); }
  .name { font-weight: 500; }
  .date { font-size: 11px; color: var(--text-color-dim); }
  .badge { padding: 2px 8px; border-radius: 10px; color: #fff; font-size: 11px; font-weight: 600; text-transform: uppercase; }
</style>

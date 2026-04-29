<script lang="ts">
  import { API_BASE } from '$lib/api/config'
  import type { AnyStructure } from '$lib/structure/index'

  interface Props {
    analyzer_id: string
    output_type: string
    display_name: string
    structure?: AnyStructure
  }

  let { analyzer_id, output_type, display_name, structure }: Props = $props()

  let loading = $state(false)
  let result = $state<any>(null)
  let error = $state<string | null>(null)

  async function run_analysis() {
    loading = true
    error = null
    result = null
    try {
      const resp = await fetch(`${API_BASE}/plugins/analyzers/${analyzer_id}/run`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({ structure }),
      })
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(detail.detail || resp.statusText)
      }
      const data = await resp.json()
      result = data.result ?? data.data ?? data
    } catch (e: any) {
      error = e.message
    } finally {
      loading = false
    }
  }
</script>

<section class="plugin-result-pane">
  <h5>{display_name}</h5>

  <button class="run-btn" onclick={run_analysis} disabled={loading || !structure}>
    {loading ? `Running...` : `Run Analysis`}
  </button>

  {#if error}
    <p class="error-msg">{error}</p>
  {/if}

  {#if result}
    {#if output_type === `bar_plot`}
      <div class="plot-container">
        {#each result.series || [result] as series}
          {#if series.label}
            <p class="series-label">{series.label}</p>
          {/if}
          {#if series.x && series.y}
            <div class="simple-bar-chart">
              {#each series.x as label, i}
                {@const max_val = Math.max(...(series.y as number[]))}
                {@const pct = max_val > 0 ? ((series.y[i] as number) / max_val) * 100 : 0}
                <div class="bar-row">
                  <span class="bar-label" title={String(label)}>{label}</span>
                  <div class="bar-track">
                    <div class="bar-fill" style:width="{pct}%"></div>
                  </div>
                  <span class="bar-value">{typeof series.y[i] === `number` ? series.y[i].toFixed(1) : series.y[i]}</span>
                </div>
              {/each}
            </div>
          {/if}
        {/each}
      </div>
    {:else if output_type === `table`}
      <div class="table-container">
        <table>
          {#if result.columns}
            <thead>
              <tr>
                {#each result.columns as col}
                  <th>{col}</th>
                {/each}
              </tr>
            </thead>
          {/if}
          <tbody>
            {#each result.rows || [] as row}
              <tr>
                {#each row as cell}
                  <td>{cell}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if output_type === `image`}
      <img src="data:{result.mime};base64,{result.data}" alt="Analysis result" />
    {:else}
      <pre class="json-result">{JSON.stringify(result, null, 2)}</pre>
    {/if}
  {/if}
</section>

<style>
  .plugin-result-pane {
    padding: 8px;
    background: var(--pane-card-bg, rgba(255, 255, 255, 0.04));
    border-radius: 6px;
  }
  h5 {
    margin: 0 0 8px;
    font-size: 0.85em;
    font-weight: 600;
    color: var(--text-color, #fff);
  }
  .run-btn {
    width: 100%;
    padding: 6px 12px;
    background: var(--accent-color, #3b82f6);
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.82em;
    transition: opacity 0.15s;
  }
  .run-btn:hover:not(:disabled) { opacity: 0.85; }
  .run-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .error-msg {
    font-size: 0.8em;
    color: var(--error-color, #ef4444);
    margin: 8px 0;
    line-height: 1.4;
  }
  .plot-container { margin-top: 8px; }
  .series-label {
    font-size: 0.78em;
    font-weight: 600;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
    margin: 6px 0 4px;
  }
  .simple-bar-chart {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .bar-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75em;
    color: var(--text-color, #fff);
  }
  .bar-label {
    flex: 0 0 60px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }
  .bar-track {
    flex: 1;
    height: 14px;
    background: light-dark(rgba(0, 0, 0, 0.06), rgba(255, 255, 255, 0.06));
    border-radius: 3px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    background: var(--accent-color, #3b82f6);
    border-radius: 3px;
    transition: width 0.3s ease;
  }
  .bar-value {
    flex: 0 0 40px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .table-container {
    margin-top: 8px;
    overflow-x: auto;
  }
  table {
    width: 100%;
    font-size: 0.78em;
    border-collapse: collapse;
    color: var(--text-color, #fff);
  }
  th, td {
    padding: 4px 6px;
    border-bottom: 1px solid light-dark(rgba(0, 0, 0, 0.08), rgba(255, 255, 255, 0.08));
    text-align: left;
  }
  th {
    font-weight: 600;
    color: var(--text-color-muted, rgba(255, 255, 255, 0.6));
  }
  img { max-width: 100%; margin-top: 8px; border-radius: 4px; }
  .json-result {
    margin-top: 8px;
    padding: 8px;
    background: light-dark(rgba(0, 0, 0, 0.04), rgba(0, 0, 0, 0.3));
    border-radius: 4px;
    font-size: 0.72em;
    color: var(--text-color, #fff);
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>

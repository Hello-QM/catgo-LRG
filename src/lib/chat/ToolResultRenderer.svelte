<!-- src/lib/chat/ToolResultRenderer.svelte -->
<script lang="ts">
    import { t, load_i18n_module } from '$lib/i18n/index.svelte'
    import type { Snippet } from 'svelte'

    interface TableColumn { key: string; label?: string }
    interface TableData { columns?: TableColumn[]; rows?: Record<string, unknown>[]; content?: string }

    interface ToolResultData {
        data: TableData & Record<string, unknown>
        output_type: string
        tool_id: string
        error?: string
        traceback?: string
        session_id?: string
    }

    load_i18n_module('chat')

    let { result }: { result: ToolResultData } = $props()

    // Lazy imports for heavy components
    let ScatterPlot: any = $state(null)
    let BarPlot: any = $state(null)
    let DosPlot: any = $state(null)
    let FileProposalRenderer: any = $state(null)

    $effect(() => {
        if (result.output_type === `scatter_plot` && !ScatterPlot) {
            import(`$lib/plot/ScatterPlot.svelte`).then(m => ScatterPlot = m.default)
        }
        if (result.output_type === `bar_plot` && !BarPlot) {
            import(`$lib/plot/BarPlot.svelte`).then(m => BarPlot = m.default)
        }
        if (result.output_type === `electronic_dos` && !DosPlot) {
            import(`$lib/electronic/DosPlot.svelte`).then(m => DosPlot = m.default).catch(() => {
                // Optional component: DosPlot may not be available in all builds
            })
        }
        if (result.output_type === `file_proposal` && !FileProposalRenderer) {
            import(`./FileProposalRenderer.svelte`).then(m => FileProposalRenderer = m.default).catch(err => {
                console.warn(`[CatBot] Failed to load FileProposalRenderer:`, err)
            })
        }
    })
</script>

{#if result.error}
    <div class="tool-result-error">
        <strong>{t('chat.tool_result_error_label')}:</strong> {result.error}
        {#if result.traceback}
            <pre class="traceback">{result.traceback}</pre>
        {/if}
    </div>
{:else if result.output_type === `scatter_plot` && ScatterPlot}
    <div class="tool-result-plot">
        <ScatterPlot data={result.data} />
    </div>
{:else if result.output_type === `bar_plot` && BarPlot}
    <div class="tool-result-plot">
        <BarPlot data={result.data} />
    </div>
{:else if result.output_type === `table`}
    <div class="tool-result-table">
        <table>
            <thead>
                <tr>
                    {#each (result.data.columns || []) as col}
                        <th>{col.label || col.key}</th>
                    {/each}
                </tr>
            </thead>
            <tbody>
                {#each (result.data.rows || []) as row}
                    <tr>
                        {#each (result.data.columns || []) as col}
                            <td>{row[col.key]}</td>
                        {/each}
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
{:else if result.output_type === `text`}
    <div class="tool-result-text">
        {result.data.content || JSON.stringify(result.data)}
    </div>
{:else if result.output_type === `image`}
    <div class="tool-result-image">
        <img src={`data:${result.data.mime || `image/png`};base64,${result.data.data}`} alt={t('chat.tool_result_image_alt')} />
    </div>
{:else if result.output_type === `electronic_dos` && result.session_id && DosPlot}
    <div class="tool-result-plot">
        <DosPlot sessionId={result.session_id} />
    </div>
{:else if result.output_type === `file_proposal` && FileProposalRenderer}
    <FileProposalRenderer {result} />
{:else}
    <div class="tool-result-raw">
        <pre>{JSON.stringify(result.data, null, 2)}</pre>
    </div>
{/if}

<style>
    .tool-result-error {
        padding: 8px 12px;
        background: var(--error-bg, #fee);
        border: 1px solid var(--error-border, #fcc);
        border-radius: 6px;
        font-size: 13px;
    }
    .traceback {
        font-size: 11px;
        max-height: 200px;
        overflow-y: auto;
        margin-top: 8px;
        opacity: 0.7;
    }
    .tool-result-plot {
        width: 100%;
        max-width: 600px;
        margin: 8px 0;
    }
    .tool-result-table table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
    }
    .tool-result-table th,
    .tool-result-table td {
        padding: 4px 8px;
        border: 1px solid var(--border-color, #ddd);
        text-align: left;
    }
    .tool-result-text {
        white-space: pre-wrap;
        font-size: 13px;
    }
    .tool-result-image img {
        max-width: 100%;
        border-radius: 4px;
    }
    .tool-result-raw pre {
        font-size: 11px;
        max-height: 300px;
        overflow-y: auto;
        background: var(--code-bg, #f5f5f5);
        padding: 8px;
        border-radius: 4px;
    }
</style>

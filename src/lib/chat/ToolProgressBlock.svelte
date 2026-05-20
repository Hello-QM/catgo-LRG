<!-- src/lib/chat/ToolProgressBlock.svelte -->
<script lang="ts">
    import { t, load_i18n_module } from '$lib/i18n/index.svelte'

    load_i18n_module('chat')

    interface Props {
        toolId: string
        toolName: string
        input?: unknown
        output?: string
        status: 'running' | 'complete' | 'error'
        elapsedSeconds?: number
    }

    let { toolId, toolName, input, output, status, elapsedSeconds }: Props = $props()

    // Default: expanded when running, collapsed when complete/error
    let expanded = $state(status === 'running')

    $effect(() => {
        if (status === 'running') {
            expanded = true
        }
    })

    const statusIcon = $derived(
        status === 'running' ? '▶' :
        status === 'complete' ? '✓' :
        '✗'
    )

    const inputPreview = $derived.by(() => {
        if (input === undefined || input === null) return null
        const s = typeof input === 'string' ? input : JSON.stringify(input, null, 2)
        return s.length > 300 ? s.slice(0, 300) + '…' : s
    })

    const outputPreview = $derived.by(() => {
        if (!output) return null
        return output.length > 2000 ? output.slice(0, 2000) + '…' : output
    })

    const elapsedLabel = $derived.by(() => {
        if (elapsedSeconds === undefined) return ''
        if (elapsedSeconds < 60) return `${elapsedSeconds.toFixed(1)}s`
        const m = Math.floor(elapsedSeconds / 60)
        const s = Math.round(elapsedSeconds % 60)
        return `${m}m ${s}s`
    })

    function toggle() {
        expanded = !expanded
    }
</script>

<div class="tool-progress-block" class:running={status === 'running'} class:complete={status === 'complete'} class:error={status === 'error'}>
    <!-- Header — always visible, click to toggle -->
    <button class="header" onclick={toggle} type="button" aria-expanded={expanded}>
        <span class="status-icon" aria-hidden="true">{statusIcon}</span>
        <span class="tool-name">{toolName}</span>
        {#if status === 'running'}
            <span class="running-indicator" aria-label={t('chat.tool_progress_running')}>{t('chat.tool_progress_running')}…</span>
        {/if}
        {#if elapsedLabel}
            <span class="elapsed">{elapsedLabel}</span>
        {/if}
        <span class="chevron" class:open={expanded} aria-hidden="true">›</span>
    </button>

    <!-- Detail section -->
    {#if expanded}
        <div class="detail">
            {#if inputPreview !== null}
                <div class="section">
                    <div class="section-label">{t('chat.tool_progress_input')}</div>
                    <pre class="code-block">{inputPreview}</pre>
                </div>
            {/if}
            {#if outputPreview !== null}
                <div class="section">
                    <div class="section-label">{t('chat.tool_progress_output')}</div>
                    <pre class="output-block">{outputPreview}</pre>
                </div>
            {/if}
            {#if inputPreview === null && outputPreview === null}
                <div class="empty-detail">{t('chat.tool_progress_no_details')}</div>
            {/if}
        </div>
    {/if}
</div>

<style>
    .tool-progress-block {
        font-size: 12px;
        border-radius: 6px;
        border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
        background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
        margin: 4px 0;
        overflow: hidden;
    }

    .header {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 5px 8px;
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;
        color: inherit;
        font-size: inherit;
        line-height: 1.4;
    }

    .header:hover {
        background: var(--pane-card-border, rgba(0, 0, 0, 0.08));
    }

    .status-icon {
        font-size: 11px;
        width: 14px;
        flex-shrink: 0;
        font-style: normal;
    }

    .running .status-icon {
        color: var(--accent-color, #007acc);
    }

    .complete .status-icon {
        color: #22c55e;
    }

    .error .status-icon {
        color: #ef4444;
    }

    .tool-name {
        font-family: var(--font-mono, ui-monospace, 'Cascadia Code', 'Source Code Pro', monospace);
        font-weight: 500;
        color: var(--text-color-muted, #6b7280);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .running .tool-name {
        color: var(--accent-color, #007acc);
    }

    .running-indicator {
        font-size: 11px;
        color: var(--accent-color, #007acc);
        opacity: 0.8;
        flex-shrink: 0;
    }

    .elapsed {
        font-size: 11px;
        color: var(--text-color-muted, #6b7280);
        flex-shrink: 0;
        opacity: 0.7;
    }

    .chevron {
        font-size: 14px;
        color: var(--text-color-muted, #6b7280);
        flex-shrink: 0;
        transform: rotate(0deg);
        transition: transform 0.15s ease;
        line-height: 1;
    }

    .chevron.open {
        transform: rotate(90deg);
    }

    .detail {
        border-top: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
        padding: 6px 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .section-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-color-muted, #6b7280);
        margin-bottom: 3px;
        opacity: 0.7;
    }

    .code-block,
    .output-block {
        margin: 0;
        padding: 5px 7px;
        font-family: var(--font-mono, ui-monospace, 'Cascadia Code', 'Source Code Pro', monospace);
        font-size: 11px;
        line-height: 1.5;
        background: var(--code-bg, rgba(0, 0, 0, 0.08));
        border-radius: 4px;
        border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
        white-space: pre-wrap;
        word-break: break-all;
        overflow-wrap: anywhere;
        max-height: 200px;
        overflow-y: auto;
        color: var(--text-color-muted, #6b7280);
    }

    .empty-detail {
        font-size: 11px;
        color: var(--text-color-muted, #6b7280);
        opacity: 0.5;
        font-style: italic;
    }
</style>

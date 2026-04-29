<!-- src/lib/chat/FileProposalRenderer.svelte -->
<script lang="ts">
    import { API_BASE } from '$lib/api/config'

    let { result }: { result: any } = $props()

    let status = $state<'pending' | 'approved' | 'rejected' | 'error'>(`pending`)
    let loading = $state(false)
    let error_msg = $state(``)

    const data = result.data ?? {}
    const proposal_id = data.proposal_id

    // Guard against malformed proposal data
    if (!proposal_id) {
        status = `error`
        error_msg = `Invalid proposal data — missing proposal ID`
    }

    async function approve() {
        loading = true
        try {
            const resp = await fetch(`${API_BASE}/files/sandbox/${proposal_id}/approve`, {
                method: `POST`,
            })
            if (!resp.ok) throw new Error(await resp.text())
            status = `approved`
        } catch (e) {
            error_msg = e instanceof Error ? e.message : `Failed to approve`
            status = `error`
        } finally {
            loading = false
        }
    }

    async function reject() {
        loading = true
        try {
            const resp = await fetch(`${API_BASE}/files/sandbox/${proposal_id}/reject`, {
                method: `POST`,
            })
            if (resp.ok) {
                status = `rejected`
            } else {
                error_msg = `Reject may not have been saved server-side (${resp.status})`
                status = `error`
            }
        } catch (e) {
            console.error(`Failed to reject proposal ${proposal_id}:`, e)
            error_msg = `Network error — proposal may still exist server-side`
            status = `error`
        } finally {
            loading = false
        }
    }

    const category_labels: Record<string, string> = {
        plugins: `Plugin`,
        scripts: `Script`,
        config: `Config`,
        tools: `Tool`,
    }
</script>

<div class="file-proposal">
    <div class="file-header">
        <span class="file-icon">&#128196;</span>
        <span class="file-path">{data.target_path}</span>
        {#if data.category}
            <span class="category-badge">{category_labels[data.category] ?? data.category}</span>
        {/if}
    </div>

    {#if data.audit_warnings && data.audit_warnings.length > 0}
        <div class="audit-warnings">
            <strong>Warnings:</strong>
            <ul>
                {#each data.audit_warnings as warning}
                    <li>{warning}</li>
                {/each}
            </ul>
        </div>
    {/if}

    {#if data.file_exists}
        <div class="overwrite-notice">
            This file already exists and will be overwritten.
        </div>
    {/if}

    <div class="code-preview">
        <pre><code>{data.content}</code></pre>
    </div>

    {#if data.description}
        <div class="file-description">{data.description}</div>
    {/if}

    {#if status === `pending`}
        <div class="action-buttons">
            <button class="btn-approve" disabled={loading} onclick={approve}>
                {loading ? `Approving...` : `Approve`}
            </button>
            <button class="btn-reject" disabled={loading} onclick={reject}>
                {loading ? `Rejecting...` : `Reject`}
            </button>
        </div>
    {:else if status === `approved`}
        <div class="status-approved">&#10003; File written to {data.target_path}</div>
    {:else if status === `rejected`}
        <div class="status-rejected">&#10007; Rejected</div>
    {:else if status === `error`}
        <div class="status-error">{error_msg}</div>
    {/if}
</div>

<style>
    .file-proposal {
        border: 1px solid var(--border-color, #444);
        border-radius: 8px;
        padding: 12px;
        margin: 8px 0;
        background: var(--surface-bg, #1a1a2e);
    }

    .file-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
    }

    .file-icon {
        font-size: 16px;
        flex-shrink: 0;
    }

    .file-path {
        font-family: monospace;
        font-size: 13px;
        color: var(--text-primary, #e0e0e0);
        word-break: break-all;
    }

    .category-badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
        background: var(--accent-bg, #2a4a7f);
        color: var(--accent-text, #a0c4ff);
        flex-shrink: 0;
    }

    .audit-warnings {
        padding: 8px 12px;
        background: rgba(255, 193, 7, 0.12);
        border: 1px solid rgba(255, 193, 7, 0.3);
        border-radius: 6px;
        font-size: 12px;
        margin-bottom: 8px;
        color: #ffc107;
    }

    .audit-warnings ul {
        margin: 4px 0 0 16px;
        padding: 0;
    }

    .audit-warnings li {
        margin: 2px 0;
    }

    .overwrite-notice {
        padding: 6px 12px;
        background: rgba(255, 152, 0, 0.12);
        border: 1px solid rgba(255, 152, 0, 0.3);
        border-radius: 6px;
        font-size: 12px;
        margin-bottom: 8px;
        color: #ff9800;
    }

    .code-preview {
        margin-bottom: 8px;
    }

    .code-preview pre {
        max-height: 300px;
        overflow-y: auto;
        background: var(--code-bg, #1e1e1e);
        color: var(--code-text, #d4d4d4);
        padding: 10px;
        border-radius: 6px;
        font-size: 12px;
        margin: 0;
        white-space: pre-wrap;
        word-break: break-all;
    }

    .code-preview code {
        font-family: monospace;
    }

    .file-description {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-bottom: 8px;
    }

    .action-buttons {
        display: flex;
        gap: 8px;
        margin-top: 8px;
    }

    .btn-approve,
    .btn-reject {
        padding: 6px 16px;
        border: none;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
        transition: opacity 0.15s;
    }

    .btn-approve {
        background: rgba(76, 175, 80, 0.2);
        color: #66bb6a;
        border: 1px solid rgba(76, 175, 80, 0.4);
    }

    .btn-approve:hover:not(:disabled) {
        background: rgba(76, 175, 80, 0.3);
    }

    .btn-reject {
        background: rgba(244, 67, 54, 0.12);
        color: #ef5350;
        border: 1px solid rgba(244, 67, 54, 0.3);
    }

    .btn-reject:hover:not(:disabled) {
        background: rgba(244, 67, 54, 0.2);
    }

    .btn-approve:disabled,
    .btn-reject:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .status-approved {
        color: #66bb6a;
        font-size: 13px;
        margin-top: 8px;
    }

    .status-rejected {
        color: #888;
        font-size: 13px;
        margin-top: 8px;
    }

    .status-error {
        color: #ef5350;
        font-size: 13px;
        margin-top: 8px;
        background: var(--error-bg, rgba(244, 67, 54, 0.1));
        padding: 6px 10px;
        border-radius: 4px;
    }
</style>

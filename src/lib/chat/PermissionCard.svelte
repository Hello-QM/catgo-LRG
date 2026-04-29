<!-- src/lib/chat/PermissionCard.svelte -->
<script lang="ts">
    import { resolve_permission } from './sdk-stream'

    interface Props {
        permissionId: string
        toolName: string
        input: Record<string, unknown>
        suggestions?: unknown[]
        decisionReason?: string
    }

    let { permissionId, toolName, input, suggestions, decisionReason }: Props = $props()

    let status = $state<'pending' | 'allowed' | 'denied'>(`pending`)
    let resolving = $state(false)

    const truncated_input = $derived(() => {
        const json = JSON.stringify(input, null, 2)
        return json.length > 400 ? json.slice(0, 400) + `\n…` : json
    })

    async function handle(behavior: `allow` | `allow_session` | `deny`) {
        if (resolving) return
        resolving = true
        try {
            await resolve_permission(permissionId, behavior, suggestions)
            status = behavior === `deny` ? `denied` : `allowed`
        } catch (err) {
            console.error(`[PermissionCard] resolve_permission failed:`, err)
        } finally {
            resolving = false
        }
    }
</script>

{#if status === `pending`}
    <div class="permission-card">
        <div class="card-header">
            <span class="shield-icon">🔐</span>
            <span class="header-label">Permission Required</span>
        </div>

        <div class="tool-row">
            <span class="tool-label">Tool</span>
            <code class="tool-name">{toolName}</code>
        </div>

        {#if decisionReason}
            <div class="reason">{decisionReason}</div>
        {/if}

        <pre class="input-preview">{truncated_input()}</pre>

        <div class="action-buttons">
            <button
                class="btn btn-allow"
                disabled={resolving}
                onclick={() => handle(`allow`)}
            >
                {resolving ? `…` : `Allow`}
            </button>
            <button
                class="btn btn-allow-session"
                disabled={resolving}
                onclick={() => handle(`allow_session`)}
            >
                {resolving ? `…` : `Allow Session`}
            </button>
            <button
                class="btn btn-deny"
                disabled={resolving}
                onclick={() => handle(`deny`)}
            >
                {resolving ? `…` : `Deny`}
            </button>
        </div>
    </div>
{:else}
    <div class="permission-resolved">
        {#if status === `allowed`}
            <span class="icon-allowed">✓</span>
            <span class="resolved-label">Allowed — <code class="tool-name-inline">{toolName}</code></span>
        {:else}
            <span class="icon-denied">✗</span>
            <span class="resolved-label">Denied — <code class="tool-name-inline">{toolName}</code></span>
        {/if}
    </div>
{/if}

<style>
    .permission-card {
        border: 1px solid var(--border-color, #444);
        border-left: 3px solid rgba(255, 193, 7, 0.6);
        border-radius: 6px;
        padding: 10px 12px;
        margin: 6px 0;
        background: var(--surface-bg, #1a1a2e);
        font-size: 13px;
    }

    .card-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
        font-weight: 600;
        color: var(--text-primary, #e0e0e0);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .shield-icon {
        font-size: 13px;
    }

    .header-label {
        color: rgba(255, 193, 7, 0.9);
    }

    .tool-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }

    .tool-label {
        font-size: 11px;
        color: var(--text-secondary, #888);
        flex-shrink: 0;
    }

    .tool-name {
        font-family: monospace;
        font-size: 12px;
        color: var(--accent-text, #a0c4ff);
        background: var(--accent-bg, rgba(100, 150, 255, 0.12));
        padding: 1px 6px;
        border-radius: 4px;
    }

    .reason {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-bottom: 6px;
        font-style: italic;
    }

    .input-preview {
        font-family: monospace;
        font-size: 11px;
        max-height: 120px;
        overflow-y: auto;
        background: var(--code-bg, #1e1e1e);
        color: var(--code-text, #d4d4d4);
        padding: 8px;
        border-radius: 4px;
        margin: 0 0 10px 0;
        white-space: pre-wrap;
        word-break: break-all;
    }

    .action-buttons {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
    }

    .btn {
        padding: 4px 12px;
        border-radius: 5px;
        font-size: 12px;
        cursor: pointer;
        border: 1px solid transparent;
        transition: opacity 0.15s, background 0.15s;
        line-height: 1.5;
    }

    .btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
    }

    .btn-allow {
        background: rgba(76, 175, 80, 0.18);
        color: #66bb6a;
        border-color: rgba(76, 175, 80, 0.35);
    }

    .btn-allow:hover:not(:disabled) {
        background: rgba(76, 175, 80, 0.28);
    }

    .btn-allow-session {
        background: rgba(33, 150, 243, 0.15);
        color: #64b5f6;
        border-color: rgba(33, 150, 243, 0.32);
    }

    .btn-allow-session:hover:not(:disabled) {
        background: rgba(33, 150, 243, 0.25);
    }

    .btn-deny {
        background: rgba(244, 67, 54, 0.12);
        color: #ef5350;
        border-color: rgba(244, 67, 54, 0.3);
    }

    .btn-deny:hover:not(:disabled) {
        background: rgba(244, 67, 54, 0.22);
    }

    /* Resolved one-liner */
    .permission-resolved {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        padding: 3px 10px;
        margin: 2px 0;
        border-radius: 4px;
        border: 1px solid var(--pane-card-border, rgba(0, 0, 0, 0.08));
        background: var(--pane-card-bg, rgba(0, 0, 0, 0.05));
        color: var(--text-color-muted, #6b7280);
    }

    .icon-allowed {
        color: #22c55e;
        font-size: 11px;
        font-weight: 600;
    }

    .icon-denied {
        color: #ef4444;
        font-size: 11px;
        font-weight: 600;
    }

    .resolved-label {
        color: var(--text-color-muted, #6b7280);
    }

    .tool-name-inline {
        font-family: monospace;
        font-size: 10px;
        color: var(--text-color-muted, #6b7280);
        opacity: 0.8;
    }
</style>

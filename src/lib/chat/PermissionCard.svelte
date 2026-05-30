<!-- src/lib/chat/PermissionCard.svelte -->
<script lang="ts">
    import { resolve_permission } from './sdk-stream'
    import { t, load_i18n_module } from '$lib/i18n/index.svelte'
    load_i18n_module('chat')

    interface Props {
        permissionId: string
        toolName: string
        input: Record<string, unknown>
        suggestions?: unknown[]
        decisionReason?: string
        // Client-direct path only: when set, the card settles the in-browser
        // tool-loop's pending permission promise instead of (and in addition
        // to skipping) the SDK backend round-trip. Undefined on the SDK path.
        // `session` is true for "Allow for session" so the caller can flip the
        // session-scoped skip_permission flag (the SDK path handles that itself).
        onResolve?: (approved: boolean, session?: boolean) => void
    }

    let { permissionId, toolName, input, suggestions, decisionReason, onResolve }: Props = $props()

    let status = $state<'pending' | 'allowed' | 'denied'>(`pending`)
    let resolving = $state(false)

    // AskUserQuestion is CatBot asking the user something — rendering its raw
    // JSON is unreadable. Parse it into question text + option list instead.
    interface AskOption { label?: string; description?: string }
    interface AskQuestion { question?: string; header?: string; options?: AskOption[]; multiSelect?: boolean }
    const is_ask = $derived(toolName === `AskUserQuestion`)
    const ask_questions = $derived.by<AskQuestion[]>(() => {
        if (!is_ask) return []
        const q = (input as { questions?: unknown }).questions
        return Array.isArray(q) ? (q as AskQuestion[]) : []
    })

    const truncated_input = $derived(() => {
        const json = JSON.stringify(input, null, 2)
        return json.length > 400 ? json.slice(0, 400) + `\n…` : json
    })

    async function handle(behavior: `allow` | `allow_session` | `deny`) {
        if (resolving) return
        resolving = true
        try {
            const approved = behavior !== `deny`
            if (onResolve) {
                // Client-direct: resolve the in-browser tool-loop's promise.
                // Pass `session` so "Allow for session" sets the session-scoped
                // skip_permission flag — otherwise it behaves like a one-time
                // Allow and every later tool re-prompts.
                onResolve(approved, behavior === `allow_session`)
            } else {
                // SDK path: backend round-trip.
                await resolve_permission(permissionId, behavior, suggestions)
            }
            status = approved ? `allowed` : `denied`
        } catch (err) {
            console.error(`[PermissionCard] resolve_permission failed:`, err)
        } finally {
            resolving = false
        }
    }

    // ── AskUserQuestion: selected option label(s) per question index ──
    let selections = $state<Record<number, string[]>>({})

    function toggle_option(qi: number, label: string, multi: boolean) {
        const cur = selections[qi] ?? []
        if (multi) {
            selections[qi] = cur.includes(label)
                ? cur.filter((l) => l !== label)
                : [...cur, label]
        } else {
            selections[qi] = [label]
        }
    }

    const all_answered = $derived(
        ask_questions.length > 0 &&
        ask_questions.every((_q, i) => (selections[i]?.length ?? 0) > 0),
    )

    async function submit_answers() {
        if (resolving || !all_answered) return
        resolving = true
        try {
            // Per the Agent SDK contract: answers maps each question's
            // `question` text → the chosen option label (string for
            // single-select, array for multiSelect). The SDK turns the
            // returned updatedInput into the tool_result automatically.
            const answers: Record<string, string | string[]> = {}
            ask_questions.forEach((q, i) => {
                const picked = selections[i] ?? []
                const key = q.question ?? q.header ?? `q${i}`
                answers[key] = q.multiSelect ? picked : (picked[0] ?? ``)
            })
            await resolve_permission(permissionId, `allow`, suggestions, {
                questions: ask_questions,
                answers,
            })
            status = `allowed`
        } catch (err) {
            console.error(`[PermissionCard] submit_answers failed:`, err)
        } finally {
            resolving = false
        }
    }
</script>

{#if status === `pending`}
    <div class="permission-card">
        <div class="card-header">
            <span class="shield-icon">{is_ask ? `💬` : `🔐`}</span>
            <span class="header-label">{is_ask ? t('chat.catbot_asking') : t('chat.permission_required')}</span>
        </div>

        {#if !is_ask}
            <div class="tool-row">
                <span class="tool-label">{t('chat.tool')}</span>
                <code class="tool-name">{toolName}</code>
            </div>
        {/if}

        {#if decisionReason}
            <div class="reason">{decisionReason}</div>
        {/if}

        {#if is_ask && ask_questions.length > 0}
            <div class="ask-block">
                {#each ask_questions as q, qi (q.question ?? q.header ?? qi)}
                    <div class="ask-question">
                        {#if q.header}<span class="ask-header">{q.header}</span>{/if}
                        <div class="ask-text">{q.question ?? ``}</div>
                        {#if q.options && q.options.length > 0}
                            <ul class="ask-options">
                                {#each q.options as opt}
                                    {@const label = opt.label ?? ``}
                                    {@const picked = (selections[qi] ?? []).includes(label)}
                                    <li>
                                        <button
                                            type="button"
                                            class="ask-opt-btn"
                                            class:picked
                                            disabled={resolving}
                                            onclick={() => toggle_option(qi, label, !!q.multiSelect)}
                                        >
                                            <span class="ask-opt-mark">{picked ? `●` : `○`}</span>
                                            <span class="ask-opt-body">
                                                <span class="ask-opt-label">{label}</span>
                                                {#if opt.description}<span class="ask-opt-desc">{opt.description}</span>{/if}
                                            </span>
                                        </button>
                                    </li>
                                {/each}
                            </ul>
                        {/if}
                        {#if q.multiSelect}<div class="ask-hint">({t('chat.select_one_or_more')})</div>{/if}
                    </div>
                {/each}
            </div>

            <div class="action-buttons">
                <button
                    class="btn btn-allow"
                    disabled={resolving || !all_answered}
                    onclick={submit_answers}
                    title={all_answered ? t('chat.send_choice') : t('chat.pick_every_question')}
                >
                    {resolving ? `…` : t('chat.submit')}
                </button>
                <button
                    class="btn btn-deny"
                    disabled={resolving}
                    onclick={() => handle(`deny`)}
                >
                    {resolving ? `…` : t('chat.cancel')}
                </button>
            </div>
        {:else}
            <pre class="input-preview">{truncated_input()}</pre>

            <div class="action-buttons">
                <button
                    class="btn btn-allow"
                    disabled={resolving}
                    onclick={() => handle(`allow`)}
                >
                    {resolving ? `…` : t('chat.allow')}
                </button>
                <button
                    class="btn btn-allow-session"
                    disabled={resolving}
                    onclick={() => handle(`allow_session`)}
                >
                    {resolving ? `…` : t('chat.allow_session')}
                </button>
                <button
                    class="btn btn-deny"
                    disabled={resolving}
                    onclick={() => handle(`deny`)}
                >
                    {resolving ? `…` : t('chat.deny')}
                </button>
            </div>
        {/if}
    </div>
{:else}
    <div class="permission-resolved">
        {#if status === `allowed`}
            <span class="icon-allowed">✓</span>
            <span class="resolved-label">{t('chat.allowed')} — <code class="tool-name-inline">{toolName}</code></span>
        {:else}
            <span class="icon-denied">✗</span>
            <span class="resolved-label">{t('chat.denied')} — <code class="tool-name-inline">{toolName}</code></span>
        {/if}
    </div>
{/if}

<style>
    /* All colors come from the app theme system (src/lib/theme/themes.js,
       applied as CSS custom properties on :root before first paint). No
       hardcoded palette — the card tracks light/dark/white/black themes.
       Semantic accents (allow/deny) derive from --success/--accent/--error
       via color-mix so backgrounds stay theme-consistent. */
    .permission-card {
        border: 1px solid var(--border-color);
        border-left: 3px solid var(--warning-color, var(--accent-color));
        border-radius: 6px;
        padding: 10px 12px;
        margin: 6px 0;
        background: var(--surface-bg, var(--pane-card-bg));
        color: var(--text-color);
        font-size: 13px;
    }

    .card-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
        font-weight: 600;
        color: var(--text-color);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .shield-icon {
        font-size: 13px;
    }

    .header-label {
        color: var(--warning-color, var(--accent-color));
    }

    .tool-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
    }

    .tool-label {
        font-size: 11px;
        color: var(--text-color-muted);
        flex-shrink: 0;
    }

    .tool-name {
        font-family: monospace;
        font-size: 12px;
        color: var(--text-color);
        background: var(--code-bg);
        padding: 1px 6px;
        border-radius: 4px;
    }

    .reason {
        font-size: 12px;
        color: var(--text-color-muted);
        margin-bottom: 6px;
        font-style: italic;
    }

    .input-preview {
        font-family: monospace;
        font-size: 12px;
        max-height: 120px;
        overflow-y: auto;
        background: var(--code-bg, var(--pre-bg));
        color: var(--text-color);
        padding: 8px;
        border-radius: 4px;
        margin: 0 0 10px 0;
        white-space: pre-wrap;
        word-break: break-all;
    }

    /* AskUserQuestion — readable question/option rendering */
    .ask-block {
        margin: 2px 0 10px 0;
    }

    .ask-question + .ask-question {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid var(--border-color);
    }

    .ask-header {
        display: inline-block;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--accent-color);
        margin-bottom: 3px;
    }

    .ask-text {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-color);
        margin-bottom: 6px;
        line-height: 1.4;
    }

    .ask-options {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
    }

    .ask-options li {
        margin: 0;
        padding: 0;
    }

    .ask-opt-btn {
        display: flex;
        align-items: flex-start;
        gap: 7px;
        width: 100%;
        text-align: left;
        padding: 6px 9px;
        border-radius: 4px;
        background: var(--code-bg);
        border: 1px solid var(--border-color);
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
        font: inherit;
    }

    .ask-opt-btn:hover:not(:disabled) {
        background: color-mix(in srgb, var(--accent-color) 12%, var(--code-bg));
    }

    .ask-opt-btn:disabled {
        cursor: not-allowed;
        opacity: 0.6;
    }

    .ask-opt-btn.picked {
        border-color: var(--accent-color);
        background: color-mix(in srgb, var(--accent-color) 18%, transparent);
    }

    .ask-opt-mark {
        color: var(--accent-color);
        font-size: 11px;
        line-height: 1.5;
        flex-shrink: 0;
    }

    .ask-opt-body {
        display: flex;
        flex-direction: column;
        min-width: 0;
    }

    .ask-opt-label {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-color);
    }

    .ask-opt-desc {
        display: block;
        font-size: 11px;
        color: var(--text-color-muted);
        margin-top: 2px;
        line-height: 1.35;
    }

    .ask-hint {
        font-size: 11px;
        font-style: italic;
        color: var(--text-color-muted);
        margin-top: 4px;
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
        background: color-mix(in srgb, var(--success-color) 16%, transparent);
        color: var(--success-color);
        border-color: color-mix(in srgb, var(--success-color) 35%, transparent);
    }

    .btn-allow:hover:not(:disabled) {
        background: color-mix(in srgb, var(--success-color) 28%, transparent);
    }

    .btn-allow-session {
        background: color-mix(in srgb, var(--accent-color) 15%, transparent);
        color: var(--accent-color);
        border-color: color-mix(in srgb, var(--accent-color) 32%, transparent);
    }

    .btn-allow-session:hover:not(:disabled) {
        background: color-mix(in srgb, var(--accent-color) 25%, transparent);
    }

    .btn-deny {
        background: color-mix(in srgb, var(--error-color) 12%, transparent);
        color: var(--error-color);
        border-color: color-mix(in srgb, var(--error-color) 30%, transparent);
    }

    .btn-deny:hover:not(:disabled) {
        background: color-mix(in srgb, var(--error-color) 22%, transparent);
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
        border: 1px solid var(--pane-card-border, var(--border-color));
        background: var(--pane-card-bg, var(--surface-bg));
        color: var(--text-color-muted);
    }

    .icon-allowed {
        color: var(--success-color);
        font-size: 11px;
        font-weight: 600;
    }

    .icon-denied {
        color: var(--error-color);
        font-size: 11px;
        font-weight: 600;
    }

    .resolved-label {
        color: var(--text-color-muted);
    }

    .tool-name-inline {
        font-family: monospace;
        font-size: 10px;
        color: var(--text-color-muted);
        opacity: 0.8;
    }
</style>

<script lang="ts">
  // "Connect & Check" wizard (Model C: hosted frontend → user-chosen backend).
  //
  // Flow:
  //   1. Connect: probe candidate backend URLs in order — [saved 'catgo-backend-url',
  //      DEFAULT_BACKEND_URL] — via GET <url>/api/health (~2s AbortController timeout).
  //      First that returns ok ⇒ apply_backend_url(url) (fan out to all API consumers)
  //      and mark connected.
  //   2. No backend reachable ⇒ "Start your backend" panel with copy-to-clipboard
  //      one-liners + Retry, plus a lightweight ~3s auto-poll while the panel is open.
  //   3. Connected ⇒ fetch diagnostics ('/api/diagnostics' then '/api/system/diagnostics',
  //      whichever 200s) and render a severity-colored checklist + mode/version/health.
  //
  // Reuses the backend-url store (no duplicated URL state).
  import {
    apply_backend_url,
    backend_url_store,
    DEFAULT_BACKEND_URL,
    load_backend_url,
  } from '$lib/api/backend-url.svelte'

  type Severity = `info` | `warn` | `error`

  interface DiagnosticsIssue {
    id: string
    severity: Severity
    message: string
    fix_hint?: string
  }

  interface Diagnostics {
    ok: boolean
    version: string
    mode: `thin` | `full`
    frontend_served: boolean
    routers: { loaded: number; missing: string[] }
    deps: { pymatgen: boolean; ase: boolean; asyncssh: boolean; numpy: boolean }
    hpc: { active_sessions: number; any_connected: boolean }
    health: `ok` | `degraded`
    issues: DiagnosticsIssue[]
  }

  type Phase = `idle` | `connecting` | `unreachable` | `connected`

  const HEALTH_TIMEOUT_MS = 2000
  const POLL_INTERVAL_MS = 3000
  const DIAGNOSTICS_PATHS = [`/api/diagnostics`, `/api/system/diagnostics`]

  let phase = $state<Phase>(`idle`)
  let connected_url = $state(``)
  let diagnostics = $state<Diagnostics | null>(null)
  let diag_error = $state(``)
  let copied_key = $state(``)
  let poll_id: ReturnType<typeof setInterval> | null = null

  // Effective backend URL currently in force (blank store ⇒ build-time default).
  let effective = $derived(
    (backend_url_store.url || ``).trim() || DEFAULT_BACKEND_URL,
  )

  /** Ordered, de-duplicated candidate base URLs to probe. */
  function candidate_urls(): string[] {
    const out: string[] = []
    const saved = load_backend_url()
    if (saved) out.push(saved)
    if (!out.includes(DEFAULT_BACKEND_URL)) out.push(DEFAULT_BACKEND_URL)
    return out
  }

  /** GET <base>/api/health with a short timeout; true when it responds ok. */
  async function probe_health(base: string): Promise<boolean> {
    try {
      const resp = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      return resp.ok
    } catch {
      return false
    }
  }

  /** Fetch diagnostics from whichever path 200s first. */
  async function fetch_diagnostics(base: string): Promise<Diagnostics | null> {
    for (const path of DIAGNOSTICS_PATHS) {
      try {
        const resp = await fetch(`${base}${path}`, {
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        })
        if (resp.ok) return (await resp.json()) as Diagnostics
      } catch {
        // try next path
      }
    }
    return null
  }

  /** Probe candidates in order; on first reachable, apply + load diagnostics. */
  async function connect(): Promise<void> {
    phase = `connecting`
    diag_error = ``
    for (const base of candidate_urls()) {
      if (await probe_health(base)) {
        apply_backend_url(base === DEFAULT_BACKEND_URL ? `` : base)
        connected_url = base
        phase = `connected`
        stop_poll()
        await load_diagnostics(base)
        return
      }
    }
    phase = `unreachable`
    start_poll()
  }

  async function load_diagnostics(base: string): Promise<void> {
    diagnostics = null
    diag_error = ``
    const result = await fetch_diagnostics(base)
    if (result) {
      diagnostics = result
    } else {
      diag_error = `Connected, but no diagnostics endpoint responded.`
    }
  }

  function start_poll(): void {
    stop_poll()
    poll_id = setInterval(() => {
      if (phase === `unreachable`) void connect()
    }, POLL_INTERVAL_MS)
  }

  function stop_poll(): void {
    if (poll_id !== null) {
      clearInterval(poll_id)
      poll_id = null
    }
  }

  async function copy(key: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      copied_key = key
      setTimeout(() => {
        if (copied_key === key) copied_key = ``
      }, 1500)
    } catch {
      // clipboard unavailable — silently ignore
    }
  }

  // One-liners to start a local backend.
  const START_COMMANDS: { key: string; label: string; cmd: string }[] = [
    {
      key: `installer`,
      label: `Desktop installer`,
      cmd: `curl -sSL https://app.catgo-ucsd.org/install.sh | bash`,
    },
    {
      key: `python`,
      label: `Run from source`,
      cmd: `python server/main.py`,
    },
  ]

  function severity_label(sev: Severity): string {
    if (sev === `error`) return `error`
    if (sev === `warn`) return `warning`
    return `info`
  }

  // Clean up the auto-poll when the component is destroyed.
  $effect(() => stop_poll)
</script>

<section class="connect-wizard" aria-label="Connect and check backend">
  <div class="cw-head">
    <span class="cw-title">Connect &amp; Check</span>
    <button
      type="button"
      class="cw-primary"
      onclick={connect}
      disabled={phase === `connecting`}
      aria-busy={phase === `connecting`}
    >
      {#if phase === `connecting`}
        Connecting…
      {:else if phase === `connected`}
        Reconnect
      {:else}
        Connect
      {/if}
    </button>
  </div>

  {#if phase === `connected`}
    <p class="cw-status cw-ok" role="status">
      Connected to <code>{connected_url}</code>
    </p>
  {:else}
    <p class="cw-status cw-muted">
      Will try: <code>{effective}</code>
    </p>
  {/if}

  {#if phase === `unreachable`}
    <div class="cw-panel" role="region" aria-label="Start your backend">
      <p class="cw-panel-title">No backend reachable — start one:</p>
      <ul class="cw-cmds">
        {#each START_COMMANDS as item (item.key)}
          <li>
            <span class="cw-cmd-label">{item.label}</span>
            <div class="cw-cmd-row">
              <code class="cw-cmd">{item.cmd}</code>
              <button
                type="button"
                class="cw-copy"
                onclick={() => copy(item.key, item.cmd)}
                aria-label={`Copy command: ${item.label}`}
              >
                {copied_key === item.key ? `Copied` : `Copy`}
              </button>
            </div>
          </li>
        {/each}
      </ul>
      <div class="cw-panel-foot">
        <button type="button" class="cw-retry" onclick={connect}>
          Retry now
        </button>
        <small class="cw-muted" aria-live="polite">Auto-retrying every 3s…</small>
      </div>
    </div>
  {/if}

  {#if phase === `connected`}
    {#if diag_error}
      <p class="cw-status cw-warn" role="alert">{diag_error}</p>
    {:else if diagnostics}
      {@const d = diagnostics}
      <div class="cw-summary">
        <span class="cw-badge cw-badge-{d.health === `ok` ? `ok` : `warn`}">
          {d.health}
        </span>
        <span class="cw-meta">mode: <code>{d.mode}</code></span>
        <span class="cw-meta">v<code>{d.version}</code></span>
        <span class="cw-meta">
          routers: {d.routers.loaded}{#if d.routers.missing.length}
            <span class="cw-warn"> ({d.routers.missing.length} missing)</span>
          {/if}
        </span>
      </div>

      {#if d.issues.length}
        <ul class="cw-checklist" aria-label="Diagnostics issues">
          {#each d.issues as issue (issue.id)}
            <li class="cw-issue cw-{issue.severity}">
              <span class="cw-dot" aria-hidden="true"></span>
              <div class="cw-issue-body">
                <span class="cw-issue-msg">
                  <span class="cw-sr">{severity_label(issue.severity)}:</span>
                  {issue.message}
                </span>
                {#if issue.severity === `error` && issue.fix_hint}
                  <span class="cw-fix">Fix: {issue.fix_hint}</span>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="cw-status cw-ok">No issues reported. All checks passed.</p>
      {/if}
    {:else}
      <p class="cw-status cw-muted">Loading diagnostics…</p>
    {/if}
  {/if}
</section>

<style>
  .connect-wizard {
    display: flex;
    flex-direction: column;
    gap: 6pt;
    font-size: 0.85em;
  }
  .cw-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6pt;
  }
  .cw-title {
    font-weight: 600;
  }
  button {
    padding: 3pt 8pt;
    border: 1px solid var(--border-color, #d1d5db);
    border-radius: 3pt;
    background: var(--btn-bg, rgba(0, 0, 0, 0.06));
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
    font: inherit;
  }
  button:hover:not(:disabled) {
    background: var(--btn-bg-hover, rgba(0, 0, 0, 0.12));
  }
  button:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .cw-status {
    margin: 0;
  }
  .cw-muted {
    color: var(--text-color-muted, #6b7280);
  }
  .cw-ok {
    color: var(--success-color, #16a34a);
  }
  .cw-warn {
    color: var(--warning-color, #d97706);
  }
  code {
    font-size: 0.92em;
  }
  .cw-panel {
    display: flex;
    flex-direction: column;
    gap: 6pt;
    padding: 6pt 8pt;
    border: 1px solid var(--border-color, #d1d5db);
    border-radius: 4pt;
    background: var(--input-bg, rgba(0, 0, 0, 0.02));
  }
  .cw-panel-title {
    margin: 0;
    font-weight: 600;
  }
  .cw-cmds {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6pt;
  }
  .cw-cmd-label {
    display: block;
    font-size: 0.9em;
    color: var(--text-color-muted, #6b7280);
    margin-bottom: 2pt;
  }
  .cw-cmd-row {
    display: flex;
    align-items: center;
    gap: 4pt;
  }
  .cw-cmd {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    white-space: nowrap;
    padding: 3pt 6pt;
    border: 1px solid var(--border-color, #d1d5db);
    border-radius: 3pt;
    background: var(--code-bg, rgba(0, 0, 0, 0.05));
  }
  .cw-panel-foot {
    display: flex;
    align-items: center;
    gap: 8pt;
  }
  .cw-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8pt;
  }
  .cw-meta {
    color: var(--text-color-muted, #6b7280);
  }
  .cw-badge {
    padding: 1pt 6pt;
    border-radius: 999px;
    font-weight: 600;
    text-transform: uppercase;
    font-size: 0.75em;
    color: #fff;
  }
  .cw-badge-ok {
    background: var(--success-color, #16a34a);
  }
  .cw-badge-warn {
    background: var(--warning-color, #d97706);
  }
  .cw-checklist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5pt;
  }
  .cw-issue {
    display: flex;
    align-items: flex-start;
    gap: 6pt;
  }
  .cw-issue-body {
    display: flex;
    flex-direction: column;
    gap: 1pt;
  }
  .cw-dot {
    flex: none;
    width: 8px;
    height: 8px;
    margin-top: 5px;
    border-radius: 50%;
    background: var(--text-color-muted, #6b7280);
  }
  .cw-issue.cw-error .cw-dot {
    background: var(--error-color, #dc2626);
  }
  .cw-issue.cw-warn .cw-dot {
    background: var(--warning-color, #d97706);
  }
  .cw-issue.cw-info .cw-dot {
    background: var(--info-color, #2563eb);
  }
  .cw-fix {
    color: var(--text-color-muted, #6b7280);
    font-size: 0.92em;
  }
  /* Visually-hidden label for screen readers. */
  .cw-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>

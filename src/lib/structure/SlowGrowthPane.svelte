<script lang="ts">
  import { DraggablePane } from '$lib'
  import {
    uploadSlowGrowthReport,
    uploadSlowGrowthReportText,
    getSlowGrowthAnalysis,
    type SlowGrowthAnalysisResponse,
    type SlowGrowthBarrierAnalysis,
  } from '$lib/api/compute'
  import { hpc_session_store } from '$lib/hpc-sessions.svelte'
  import { listFiles, readRemoteFile } from '$lib/api/hpc'
  import { scaleLinear } from 'd3-scale'
  import { line, curveMonotoneX } from 'd3-shape'
  import { extent } from 'd3-array'
  import { onMount, onDestroy } from 'svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module(`structure`)

  let {
    show = $bindable(false),
  }: {
    show?: boolean
  } = $props()

  // --- State ---
  let loading = $state(false)
  let error_msg = $state(``)
  let api_session_id = $state(``)
  let analysis = $state<SlowGrowthAnalysisResponse | null>(null)
  let active_constraint = $state(1)
  let active_plot = $state<'mean_force' | 'free_energy' | 'cv' | 'dA_dxsi'>(`free_energy`)
  let detect_status = $state(``)
  let export_status = $state(``)
  let exporting = $state(false)
  let source_label = $state(``) // show where the REPORT came from
  /** Track terminal CWD per session_id for REPORT detection */
  let session_cwd = $state(new Map<string, string>())

  // --- External event listeners ---
  function on_external_upload(e: Event) {
    const file = (e as CustomEvent).detail?.file as File | undefined
    if (file) upload_file(file)
  }
  function on_external_paste() { handle_paste() }
  async function on_external_text(e: Event) {
    const content = (e as CustomEvent).detail?.content as string | undefined
    if (!content) return
    await submit_text(content, `HPC remote`)
  }
  async function on_external_detect() { await detect_report() }

  function on_terminal_cwd(e: Event) {
    const { path, session_id } = (e as CustomEvent).detail ?? {}
    if (path && session_id) session_cwd.set(session_id, path)
  }

  onMount(() => {
    window.addEventListener(`catgo-sg-upload`, on_external_upload)
    window.addEventListener(`catgo-sg-paste`, on_external_paste)
    window.addEventListener(`catgo-sg-upload-text`, on_external_text)
    window.addEventListener(`catgo-sg-detect-report`, on_external_detect)
    window.addEventListener(`catgo-terminal-cwd`, on_terminal_cwd)
    // Also listen via BroadcastChannel for cross-window terminals
    try {
      const bc = new BroadcastChannel(`catgo-terminal-cwd`)
      bc.onmessage = (ev: MessageEvent) => {
        const { path, session_id } = ev.data ?? {}
        if (path && session_id) session_cwd.set(session_id, path)
      }
      ;(on_terminal_cwd as any)._bc = bc
    } catch { /* BroadcastChannel not supported */ }
  })
  onDestroy(() => {
    window.removeEventListener(`catgo-sg-upload`, on_external_upload)
    window.removeEventListener(`catgo-sg-paste`, on_external_paste)
    window.removeEventListener(`catgo-sg-upload-text`, on_external_text)
    window.removeEventListener(`catgo-sg-detect-report`, on_external_detect)
    window.removeEventListener(`catgo-terminal-cwd`, on_terminal_cwd)
    try { ;(on_terminal_cwd as any)._bc?.close() } catch {}
  })

  // --- Plot ---
  const W = 560
  const H = 320
  const margin = { top: 20, right: 20, bottom: 45, left: 65 }
  const pw = W - margin.left - margin.right
  const ph = H - margin.top - margin.bottom

  const PLOT_COLORS: Record<string, string> = {
    mean_force: `#4fc3f7`,
    free_energy: `#ffb74d`,
    cv: `#81c784`,
    dA_dxsi: `#ce93d8`,
  }

  // --- Handlers ---
  async function upload_file(file: File) {
    error_msg = ``
    loading = true
    source_label = file.name
    try {
      const resp = await uploadSlowGrowthReport(file)
      api_session_id = resp.session_id
      active_constraint = resp.constraints[0] ?? 1
      if (resp.has_blue_moon) active_plot = `mean_force`
      await load_analysis()
    } catch (err: any) {
      error_msg = err.message || `Upload failed`
    } finally {
      loading = false
    }
  }

  async function handle_file_upload(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    await upload_file(file)
    input.value = ``
  }

  async function handle_paste() {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) { error_msg = `Clipboard is empty`; return }
      await submit_text(text, `clipboard`)
    } catch (err: any) {
      error_msg = err.message || `Paste failed`
    }
  }

  async function submit_text(content: string, label: string) {
    error_msg = ``
    loading = true
    source_label = label
    try {
      const resp = await uploadSlowGrowthReportText(content)
      api_session_id = resp.session_id
      active_constraint = resp.constraints[0] ?? 1
      if (resp.has_blue_moon) active_plot = `mean_force`
      show = true
      await load_analysis()
    } catch (err: any) {
      error_msg = err.message || `Upload failed`
    } finally {
      loading = false
    }
  }

  async function load_analysis() {
    if (!api_session_id) return
    try {
      analysis = await getSlowGrowthAnalysis(api_session_id)
    } catch (err: any) {
      error_msg = err.message || `Analysis failed`
    }
  }

  /**
   * Auto-detect REPORT file in current HPC directory.
   * Uses the first connected HPC session and its current_path,
   * or the terminal CWD broadcast channel.
   */
  async function detect_report() {
    const sessions = hpc_session_store.sessions
    if (sessions.length === 0) {
      error_msg = `No HPC session connected. Connect to a server first.`
      return
    }

    error_msg = ``
    detect_status = `Scanning for REPORT file...`
    loading = true

    // Try each session
    for (const sess of sessions) {
      try {
        // Use terminal CWD if available, otherwise fall back to home directory
        const cwd = session_cwd.get(sess.session_id) ?? `~`
        const result = await listFiles(sess.session_id, cwd)
        if (!result.success) continue

        // Look for REPORT file
        const report = result.files.find((f) => f.name === `REPORT` && !f.is_dir)
        if (!report) {
          detect_status = `No REPORT file found in ${result.current_path}`
          continue
        }

        detect_status = `Found REPORT in ${result.current_path}, reading...`
        const content_result = await readRemoteFile(sess.session_id, report.path)
        if (content_result.success && content_result.content) {
          detect_status = ``
          source_label = `${sess.host}:${report.path}`
          await submit_text(content_result.content, source_label)
          return
        }
      } catch (err: any) {
        console.warn(`[SlowGrowth] detect failed on ${sess.host}:`, err)
      }
    }

    detect_status = ``
    error_msg = `No REPORT file found in current directory of any connected HPC session.`
    loading = false
  }

  // --- Derived ---
  let constraint_data = $derived(
    analysis?.constraints.find((c) => c.b_cnt === active_constraint) ?? null,
  )
  let constraint_idx = $derived(
    analysis?.constraints.findIndex((c) => c.b_cnt === active_constraint) ?? 0,
  )
  let barrier = $derived<SlowGrowthBarrierAnalysis | null>(
    analysis?.barriers[constraint_idx] ?? null,
  )
  let has_bm = $derived(analysis?.has_blue_moon ?? false)
  let has_hpc = $derived(hpc_session_store.sessions.length > 0)

  let plot_data = $derived.by(() => {
    if (!constraint_data) return null
    const cd = constraint_data

    let x_vals: number[]
    let y_vals: number[]
    let x_label: string
    let y_label: string

    if (active_plot === `mean_force`) {
      x_vals = cd.cv_actual.length ? cd.cv_actual : cd.cv
      y_vals = cd.mean_force.length ? cd.mean_force : cd.dA_dxsi
      x_label = `CV (\u00c5)`
      y_label = `Mean Force (eV/\u00c5)`
    } else if (active_plot === `free_energy`) {
      x_vals = cd.cv_actual.length ? cd.cv_actual : cd.cv
      y_vals = cd.delta_F
      x_label = `CV (\u00c5)`
      y_label = `\u0394F (eV)`
    } else if (active_plot === `cv`) {
      x_vals = cd.step
      y_vals = cd.cv_actual.length ? cd.cv_actual : cd.cv
      x_label = `MD Step`
      y_label = `CV (\u00c5)`
    } else {
      x_vals = cd.step
      y_vals = cd.dA_dxsi
      x_label = `MD Step`
      y_label = `dA/d\u03be (eV)`
    }

    if (x_vals.length === 0) return null

    const [xmin, xmax] = extent(x_vals) as [number, number]
    const [ymin, ymax] = extent(y_vals) as [number, number]
    const y_pad = (ymax - ymin) * 0.08 || 0.1

    const sx = scaleLinear().domain([xmin, xmax]).range([0, pw])
    const sy = scaleLinear().domain([ymin - y_pad, ymax + y_pad]).range([ph, 0])

    const points: [number, number][] = x_vals.map((x, i) => [sx(x), sy(y_vals[i])])

    const path_gen = line<[number, number]>()
      .x((p) => p[0])
      .y((p) => p[1])
      .curve(curveMonotoneX)

    const path_d = path_gen(points) ?? ``
    const x_ticks = sx.ticks(6)
    const y_ticks = sy.ticks(6)

    return { sx, sy, path_d, x_label, y_label, x_ticks, y_ticks, ymin: ymin - y_pad, ymax: ymax + y_pad }
  })

  function export_csv() {
    export_status = ``
    if (!constraint_data) {
      export_status = t(`structure.export_no_slowgrowth_data`)
      return
    }
    exporting = true
    try {
      const cd = constraint_data
      const has_bm_data = cd.mean_force.length > 0 && cd.mean_force.some((v: number) => v !== 0)
      let header: string
      let rows: string[]

      if (has_bm_data) {
        header = `step,cv_target,cv_actual,cv_diff,lambda,z_inv_sqrt,GkT,mean_force,delta_F`
        rows = cd.step.map((s: number, i: number) =>
          `${s},${cd.cv_target[i]},${cd.cv_actual[i]},${cd.cv_diff[i]},${cd.lambda_val[i]},${cd.z_inv_sqrt[i]},${cd.GkT[i]},${cd.mean_force[i]},${cd.delta_F[i]}`,
        )
      } else {
        header = `step,cv,dcv,dA_dxsi,delta_F`
        rows = cd.step.map((s: number, i: number) =>
          `${s},${cd.cv[i]},${cd.dcv[i]},${cd.dA_dxsi[i]},${cd.delta_F[i]}`,
        )
      }

      if (rows.length === 0) {
        export_status = t(`structure.export_no_rows`, { constraint: active_constraint })
        return
      }

      const csv_text = [header, ...rows].join(`\n`)
      const blob = new Blob([csv_text], { type: `text/csv;charset=utf-8` })
      const url = URL.createObjectURL(blob)
      const filename = `slow_growth_b${active_constraint}.csv`
      const a = document.createElement(`a`)
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      export_status = t(`structure.export_started`, { filename })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      export_status = t(`structure.export_failed`, { what: `CSV`, message })
    } finally {
      exporting = false
    }
  }
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  close_on_click_outside={false}
  max_width="none"
  pane_props={{ class: `sg-pane` }}
>
  <h4 class="pane-title drag-handle">
    <span class="title-text">Slow-Growth Analysis</span>
    {#if source_label}<span class="source-label">{source_label}</span>{/if}
  </h4>

  <!-- Upload section -->
  <div class="upload-section">
    <label class="sg-btn">
      Upload REPORT
      <input type="file" accept="*" onchange={handle_file_upload} hidden />
    </label>
    <button class="sg-btn" onclick={handle_paste}>Paste</button>
    <button
      class="sg-btn detect-btn"
      class:disabled={!has_hpc}
      onclick={detect_report}
      title={has_hpc
        ? `Search for REPORT in: ${hpc_session_store.sessions.map((s) => session_cwd.get(s.session_id) ?? `~`).join(`, `)}`
        : `No HPC session connected`}
    >Detect REPORT</button>
  </div>

  {#if loading}
    <div class="status">{detect_status || `Parsing REPORT file...`}</div>
  {/if}
  {#if error_msg}
    <div class="error">{error_msg}</div>
  {/if}

  {#if analysis}
    <!-- Barrier Analysis Summary -->
    {#if barrier}
      <div class="barrier-summary">
        <div class="barrier-title">Barrier Analysis</div>
        <div class="barrier-grid">
          <div class="barrier-item">
            <span class="barrier-label">CV Range</span>
            <span class="barrier-value">{barrier.cv_start.toFixed(4)} &rarr; {barrier.cv_end.toFixed(4)} &#197;</span>
          </div>
          <div class="barrier-item">
            <span class="barrier-label">Steps</span>
            <span class="barrier-value">{barrier.num_steps}</span>
          </div>
          <div class="barrier-item highlight-fwd">
            <span class="barrier-label">Forward Barrier</span>
            <span class="barrier-value">{barrier.barrier_forward.toFixed(4)} eV ({barrier.barrier_forward_kcal.toFixed(2)} kcal/mol)</span>
          </div>
          <div class="barrier-item highlight-rev">
            <span class="barrier-label">Reverse Barrier</span>
            <span class="barrier-value">{barrier.barrier_reverse.toFixed(4)} eV ({barrier.barrier_reverse_kcal.toFixed(2)} kcal/mol)</span>
          </div>
          <div class="barrier-item">
            <span class="barrier-label">&Delta;F (total)</span>
            <span class="barrier-value">{barrier.total_delta_F.toFixed(4)} eV ({barrier.total_delta_F_kcal.toFixed(2)} kcal/mol)</span>
          </div>
          <div class="barrier-item">
            <span class="barrier-label">F<sub>max</sub> @ CV</span>
            <span class="barrier-value">{barrier.max_F.toFixed(4)} eV @ {barrier.max_F_cv.toFixed(4)} &#197;</span>
          </div>
        </div>
      </div>
    {/if}

    <!-- Controls -->
    <div class="controls">
      {#if analysis.num_constraints > 1}
        <label>
          Constraint:
          <select bind:value={active_constraint}>
            {#each analysis.constraints as c}
              <option value={c.b_cnt}>#{c.b_cnt}</option>
            {/each}
          </select>
        </label>
      {/if}

      <div class="plot-tabs">
        {#if has_bm}
          <button
            class:active={active_plot === 'mean_force'}
            onclick={() => (active_plot = 'mean_force')}
          >Mean Force</button>
        {/if}
        <button
          class:active={active_plot === 'free_energy'}
          onclick={() => (active_plot = 'free_energy')}
        >&Delta;F vs CV</button>
        <button
          class:active={active_plot === 'cv'}
          onclick={() => (active_plot = 'cv')}
        >CV vs Step</button>
        <button
          class:active={active_plot === 'dA_dxsi'}
          onclick={() => (active_plot = 'dA_dxsi')}
        >dA/d&xi; vs Step</button>
      </div>

      {#if has_bm}
        <span class="bm-badge">Blue Moon</span>
      {/if}
    </div>

    <!-- Plot -->
    {#if plot_data}
      <svg viewBox="0 0 {W} {H}" class="plot-svg">
        <g transform="translate({margin.left},{margin.top})">
          {#each plot_data.y_ticks as tick}
            <line
              x1={0} x2={pw}
              y1={plot_data.sy(tick)} y2={plot_data.sy(tick)}
              stroke="rgba(255,255,255,0.08)" stroke-width="1"
            />
          {/each}
          {#each plot_data.x_ticks as tick}
            <line
              x1={plot_data.sx(tick)} x2={plot_data.sx(tick)}
              y1={0} y2={ph}
              stroke="rgba(255,255,255,0.08)" stroke-width="1"
            />
          {/each}

          <line x1={0} x2={pw} y1={ph} y2={ph} stroke="rgba(255,255,255,0.3)" />
          <line x1={0} x2={0} y1={0} y2={ph} stroke="rgba(255,255,255,0.3)" />

          {#each plot_data.x_ticks as tick}
            <text
              x={plot_data.sx(tick)} y={ph + 18}
              text-anchor="middle" font-size="11" fill="rgba(255,255,255,0.7)"
            >{tick.toLocaleString()}</text>
          {/each}

          {#each plot_data.y_ticks as tick}
            <text
              x={-8} y={plot_data.sy(tick) + 4}
              text-anchor="end" font-size="11" fill="rgba(255,255,255,0.7)"
            >{tick.toFixed(3)}</text>
          {/each}

          <text
            x={pw / 2} y={ph + 38}
            text-anchor="middle" font-size="12" fill="rgba(255,255,255,0.85)"
          >{plot_data.x_label}</text>
          <text
            x={-50} y={ph / 2}
            text-anchor="middle" font-size="12" fill="rgba(255,255,255,0.85)"
            transform="rotate(-90, -50, {ph / 2})"
          >{plot_data.y_label}</text>

          <path
            d={plot_data.path_d}
            fill="none"
            stroke={PLOT_COLORS[active_plot]}
            stroke-width="1.5"
          />

          {#if plot_data.ymin < 0 && plot_data.ymax > 0}
            <line
              x1={0} x2={pw}
              y1={plot_data.sy(0)} y2={plot_data.sy(0)}
              stroke="rgba(255,100,100,0.4)" stroke-width="1" stroke-dasharray="4,3"
            />
          {/if}

          {#if active_plot === 'free_energy' && barrier && barrier.max_F !== 0}
            <circle
              cx={plot_data.sx(barrier.max_F_cv)}
              cy={plot_data.sy(barrier.max_F)}
              r="4" fill="#ff5252" stroke="white" stroke-width="1"
            />
            <text
              x={plot_data.sx(barrier.max_F_cv) + 6}
              y={plot_data.sy(barrier.max_F) - 6}
              font-size="10" fill="#ff8a80"
            >TS: {barrier.max_F.toFixed(3)} eV</text>
          {/if}
        </g>
      </svg>
    {:else}
      <div class="status">No data for constraint #{active_constraint}</div>
    {/if}

    <!-- Export -->
    <div class="export-row">
      <button class="sg-btn" onclick={export_csv} disabled={exporting || !constraint_data}>
        {exporting ? `Exporting...` : `Export CSV`}
      </button>
    </div>
    {#if export_status}
      <div class="export-status">{export_status}</div>
    {/if}
  {/if}
</DraggablePane>

<style>
  /* Top-level pane — resizable, no size constraints */
  :global(.sg-pane) {
    min-width: 420px;
    min-height: 200px;
    width: 640px;
    max-width: unset !important;
    max-height: 90vh;
    overflow-y: auto;
    resize: both;
    overflow: auto;
  }

  .pane-title {
    margin: 0 0 0.5em;
    font-size: 0.9em;
    font-weight: 600;
    cursor: grab;
    display: flex;
    align-items: baseline;
    gap: 0.5em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .title-text {
    flex-shrink: 0;
  }
  .source-label {
    font-size: 0.72em;
    font-weight: 400;
    color: rgba(255,255,255,0.4);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }
  .upload-section {
    display: flex;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }
  .sg-btn {
    padding: 0.35em 0.7em;
    font-size: 0.82em;
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: 4px;
    background: rgba(255,255,255,0.06);
    color: inherit;
    cursor: pointer;
  }
  .sg-btn:hover { background: rgba(255,255,255,0.12); }
  .sg-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .detect-btn {
    background: rgba(79, 195, 247, 0.1);
    border-color: rgba(79, 195, 247, 0.3);
  }
  .detect-btn:hover { background: rgba(79, 195, 247, 0.2); }
  .detect-btn.disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .status {
    font-size: 0.82em;
    opacity: 0.6;
    padding: 0.3em 0;
  }
  .error {
    font-size: 0.82em;
    color: #ef5350;
    padding: 0.3em 0;
  }

  /* Barrier analysis */
  .barrier-summary {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    padding: 0.6em 0.8em;
    margin-bottom: 0.6em;
  }
  .barrier-title {
    font-size: 0.85em;
    font-weight: 600;
    margin-bottom: 0.4em;
    color: rgba(255,255,255,0.9);
  }
  .barrier-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.3em 1em;
  }
  .barrier-item {
    display: flex;
    flex-direction: column;
    font-size: 0.78em;
  }
  .barrier-label {
    color: rgba(255,255,255,0.5);
    font-size: 0.9em;
  }
  .barrier-value {
    color: rgba(255,255,255,0.9);
    font-family: monospace;
  }
  .highlight-fwd .barrier-value { color: #ffb74d; }
  .highlight-rev .barrier-value { color: #4fc3f7; }

  /* Controls */
  .controls {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }
  .controls label { font-size: 0.82em; }
  .controls select {
    padding: 0.2em 0.4em;
    font-size: 0.9em;
    background: rgba(0,0,0,0.2);
    color: inherit;
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: 3px;
  }
  .plot-tabs {
    display: flex;
    gap: 2px;
  }
  .plot-tabs button {
    padding: 0.25em 0.6em;
    font-size: 0.78em;
    border: 1px solid rgba(255,255,255,0.15);
    background: rgba(255,255,255,0.04);
    color: rgba(255,255,255,0.7);
    cursor: pointer;
    border-radius: 3px;
  }
  .plot-tabs button.active {
    background: rgba(255,255,255,0.15);
    color: white;
    border-color: rgba(255,255,255,0.3);
  }
  .plot-svg {
    width: 100%;
    height: auto;
    display: block;
  }
  .bm-badge {
    font-size: 0.68em;
    padding: 0.15em 0.5em;
    background: rgba(79, 195, 247, 0.15);
    color: #4fc3f7;
    border: 1px solid rgba(79, 195, 247, 0.3);
    border-radius: 3px;
  }
  .export-row {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .export-status {
    margin-top: 0.35rem;
    font-size: 0.78em;
    color: #fbbf24;
  }
</style>

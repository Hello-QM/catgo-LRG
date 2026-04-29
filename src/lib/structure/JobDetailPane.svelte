<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { DraggablePane } from '$lib'
  import {
    fetchJobDetailInfo,
    fetchConvergence,
    fetchJobStructure,
    fetchJobLog,
    fetchJobFiles,
    readRemoteFile,
    writeRemoteFile,
    cancelJob,
    resubmitJob,
    type JobDetailInfo,
    type ConvergenceData,
    type ConvergencePoint,
    type JobLogResponse,
    type CalcSoftware,
    type CalcType,
    type FileReadResponse,
    type JobFilesResponse,
    type JobResubmitResponse,
  } from '$lib/api/hpc'
  import { parse_poscar, parse_cp2k } from './parse'
  import { fetchJobTrajectory, uploadFile } from '$lib/api/hpc'
  import { structure_to_poscar_str } from './export'

  let {
    show = $bindable(false),
    session_id = ``,
    job_id = ``,
    on_load_structure,
    current_structure,
  }: {
    show?: boolean
    session_id?: string
    job_id?: string
    on_load_structure?: (structure: AnyStructure) => void
    current_structure?: AnyStructure
  } = $props()

  // Tab state
  type DetailTab = `info` | `convergence` | `log` | `files`
  let active_tab = $state<DetailTab>(`info`)

  // Data state
  let detail = $state<JobDetailInfo | null>(null)
  let detail_loading = $state(false)
  let detail_error = $state(``)

  let convergence = $state<ConvergenceData | null>(null)
  let convergence_loading = $state(false)
  let convergence_error = $state(``)

  let log_data = $state<JobLogResponse | null>(null)
  let log_loading = $state(false)
  let log_error = $state(``)
  let log_file = $state<`stdout` | `stderr`>(`stdout`)

  let structure_loading = $state(false)
  let structure_error = $state(``)

  // Trajectory state
  let trajectory_loading = $state(false)
  let trajectory_error = $state(``)
  let trajectory_frames = $state.raw<AnyStructure[]>([])
  let selected_frame = $state(0)

  // Push structure state
  let push_loading = $state(false)
  let push_message = $state(``)

  // Files tab state
  let file_list = $state<string[]>([])
  let file_list_loading = $state(false)
  let file_work_dir = $state(``)
  let selected_file = $state(``)
  let file_content = $state(``)
  let file_original = $state(``)
  let file_loading = $state(false)
  let file_saving = $state(false)
  let file_save_msg = $state(``)
  let file_error = $state(``)

  // Kill/Resubmit state
  let cancel_loading = $state(false)
  let cancel_msg = $state(``)
  let resubmit_loading = $state(false)
  let resubmit_msg = $state(``)

  let file_modified = $derived(file_content !== file_original)

  // Fetch detail when pane opens or job changes
  $effect(() => {
    if (show && session_id && job_id) {
      load_detail()
    }
  })

  // Fetch tab data when switching tabs
  $effect(() => {
    if (!show || !session_id || !job_id) return
    if (active_tab === `convergence` && !convergence && !convergence_loading) {
      load_convergence()
    }
    if (active_tab === `log` && !log_data && !log_loading) {
      load_log()
    }
    if (active_tab === `files` && file_list.length === 0 && !file_list_loading) {
      load_file_list()
    }
  })

  async function load_detail() {
    detail_loading = true
    detail_error = ``
    try {
      detail = await fetchJobDetailInfo(session_id, job_id)
    } catch (err) {
      detail_error = err instanceof Error ? err.message : `Failed to load job detail`
    }
    detail_loading = false
  }

  async function load_convergence() {
    convergence_loading = true
    convergence_error = ``
    try {
      convergence = await fetchConvergence(session_id, job_id)
      if (!convergence.success) {
        convergence_error = convergence.message || `No convergence data`
      }
    } catch (err) {
      convergence_error = err instanceof Error ? err.message : `Failed to load convergence`
    }
    convergence_loading = false
  }

  async function load_log() {
    log_loading = true
    log_error = ``
    try {
      log_data = await fetchJobLog(session_id, job_id, log_file, 200)
      if (!log_data.success) {
        log_error = log_data.message || `No log data`
      }
    } catch (err) {
      log_error = err instanceof Error ? err.message : `Failed to load log`
    }
    log_loading = false
  }

  async function switch_log_file(file: `stdout` | `stderr`) {
    log_file = file
    log_data = null
    await load_log()
  }

  async function load_structure() {
    if (!on_load_structure) return
    structure_loading = true
    structure_error = ``
    try {
      const result = await fetchJobStructure(session_id, job_id)
      let parsed = null
      if (result.format === `poscar`) {
        parsed = parse_poscar(result.content)
      } else if (result.format === `cp2k`) {
        parsed = parse_cp2k(result.content)
      }
      if (parsed) {
        on_load_structure(parsed as AnyStructure)
      } else if (result.format === `poscar` || result.format === `cp2k`) {
        structure_error = `Failed to parse structure file`
      } else {
        structure_error = `Unsupported structure format: ${result.format}`
      }
    } catch (err) {
      structure_error = err instanceof Error ? err.message : `Failed to load structure`
    }
    structure_loading = false
  }

  async function load_trajectory() {
    trajectory_loading = true
    trajectory_error = ``
    try {
      const result = await fetchJobTrajectory(session_id, job_id)
      const content = result.content
      const lines = content.trim().split(`\n`)
      // Parse XDATCAR: header is lines 0-6, then "Direct configuration=..." blocks
      const header_lines = lines.slice(0, 7)
      const element_counts = header_lines[6].trim().split(/\s+/).map(Number)
      const n_atoms = element_counts.reduce((a: number, b: number) => a + b, 0)
      const frames: AnyStructure[] = []
      let idx = 7
      while (idx < lines.length) {
        if (lines[idx]?.includes(`Direct configuration`)) {
          idx++
          const frame_lines = [
            ...header_lines,
            `Direct`,
            ...lines.slice(idx, idx + n_atoms),
          ]
          const parsed = parse_poscar(frame_lines.join(`\n`))
          if (parsed) frames.push(parsed as AnyStructure)
          idx += n_atoms
        } else {
          idx++
        }
      }
      trajectory_frames = frames
      if (frames.length === 0) {
        trajectory_error = `No frames found in XDATCAR`
      } else {
        selected_frame = frames.length - 1
      }
    } catch (err) {
      trajectory_error = err instanceof Error ? err.message : `Failed to load trajectory`
    }
    trajectory_loading = false
  }

  async function push_structure_to_job() {
    if (!current_structure || !detail?.work_dir) return
    push_loading = true
    push_message = ``
    try {
      const poscar_content = structure_to_poscar_str(current_structure)
      const blob = new Blob([poscar_content], { type: `text/plain` })
      const file = new File([blob], `POSCAR`, { type: `text/plain` })
      const result = await uploadFile(session_id, detail.work_dir, file)
      push_message = result.success ? `POSCAR uploaded to ${detail.work_dir}` : `Upload failed`
    } catch (err) {
      push_message = err instanceof Error ? err.message : `Upload failed`
    }
    push_loading = false
  }

  async function copy_text(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback: select text
    }
  }

  async function load_file_list() {
    file_list_loading = true
    file_error = ``
    try {
      const result = await fetchJobFiles(session_id, job_id)
      if (result.success) {
        file_list = result.files
        file_work_dir = result.work_dir
      } else {
        file_error = result.message || `Failed to list files`
      }
    } catch (err) {
      file_error = err instanceof Error ? err.message : `Failed to list files`
    }
    file_list_loading = false
  }

  async function load_file_content(filename: string) {
    file_loading = true
    file_save_msg = ``
    file_error = ``
    try {
      const path = `${file_work_dir}/${filename}`
      const result = await readRemoteFile(session_id, path)
      if (result.success) {
        file_content = result.content
        file_original = result.content
      } else {
        file_error = result.message || `Failed to read file`
      }
    } catch (err) {
      file_error = err instanceof Error ? err.message : `Failed to read file`
    }
    file_loading = false
  }

  async function save_file() {
    file_saving = true
    file_save_msg = ``
    try {
      const path = `${file_work_dir}/${selected_file}`
      const result = await writeRemoteFile(session_id, path, file_content)
      file_save_msg = result.success ? `Saved` : (result.message || `Save failed`)
      if (result.success) file_original = file_content
    } catch (err) {
      file_save_msg = err instanceof Error ? err.message : `Save failed`
    }
    file_saving = false
  }

  async function handle_cancel() {
    cancel_loading = true
    cancel_msg = ``
    try {
      const r = await cancelJob(session_id, job_id)
      cancel_msg = r.message
      if (r.success) await load_detail()
    } catch (err) {
      cancel_msg = err instanceof Error ? err.message : `Cancel failed`
    }
    cancel_loading = false
  }

  async function handle_resubmit() {
    resubmit_loading = true
    resubmit_msg = ``
    try {
      const r = await resubmitJob(session_id, job_id)
      resubmit_msg = r.message
    } catch (err) {
      resubmit_msg = err instanceof Error ? err.message : `Resubmit failed`
    }
    resubmit_loading = false
  }

  // Chart helpers
  function fmt(val: number, decimals: number = 4): string {
    return val.toFixed(decimals)
  }

  let chart_points = $derived(convergence?.points ?? [])
  let energy_min = $derived(
    chart_points.length > 0 ? Math.min(...chart_points.map(p => p.energy)) : 0,
  )
  let energy_max = $derived(
    chart_points.length > 0 ? Math.max(...chart_points.map(p => p.energy)) : 1,
  )
  let energy_range = $derived(energy_max - energy_min || 1)

  let force_max = $derived(
    chart_points.length > 0 ? Math.max(...chart_points.map(p => p.max_force)) : 1,
  )

  // Calc type display helpers
  function software_label(s: CalcSoftware): string {
    const labels: Record<CalcSoftware, string> = {
      vasp: `VASP`, qe: `QE`, lammps: `LAMMPS`, cp2k: `CP2K`, unknown: `Unknown`,
    }
    return labels[s] ?? s
  }

  function calc_type_label(t: CalcType): string {
    const labels: Record<CalcType, string> = {
      opt: `Optimization`, scf: `Single Point`, md: `MD`,
      freq: `Frequency`, band: `Band Structure`, dos: `DOS`,
      neb: `NEB`, unknown: `Unknown`,
    }
    return labels[t] ?? t
  }

  // Reset when job changes
  $effect(() => {
    void job_id
    convergence = null
    log_data = null
    active_tab = `info`
    structure_error = ``
    trajectory_frames = []
    trajectory_error = ``
    push_message = ``
    file_list = []
    selected_file = ``
    file_content = ``
    file_original = ``
    file_save_msg = ``
    file_error = ``
    cancel_msg = ``
    resubmit_msg = ``
  })

  const tab_defs: { id: DetailTab; label: string }[] = [
    { id: `info`, label: `Info` },
    { id: `convergence`, label: `Convergence` },
    { id: `log`, label: `Log` },
    { id: `files`, label: `Files` },
  ]
</script>

<DraggablePane
  bind:show
  show_toggle={false}
  max_width="28em"
  close_on_click_outside={false}
  max_height="80vh"
  pane_props={{ class: `job-detail-pane` }}
>
  <h4>
    Job {job_id}
    <button class="copy-btn" onclick={() => copy_text(job_id)}>Copy</button>
    {#if detail}
      <span class="job-status-badge"
        class:badge-green={detail.status === `RUNNING`}
        class:badge-yellow={detail.status === `PENDING`}
        class:badge-red={detail.status === `FAILED` || detail.status === `CANCELLED`}
        class:badge-blue={detail.status === `COMPLETED`}
      >
        {detail.status}
      </span>
    {/if}
  </h4>

  <!-- Tabs -->
  <div class="tab-bar">
    {#each tab_defs as tab}
      <button
        class="tab-btn"
        class:active={active_tab === tab.id}
        onclick={() => active_tab = tab.id}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <!-- INFO TAB -->
  {#if active_tab === `info`}
    {#if detail_loading}
      <p class="loading-text">Loading job details...</p>
    {:else if detail_error}
      <p class="error-text">{detail_error}</p>
    {:else if detail}
      <div class="detail-grid">
        <div class="detail-row">
          <span class="detail-label">Name</span>
          <span class="detail-value">{detail.job_name}</span>
        </div>
        {#if detail.calc_software !== `unknown`}
          <div class="detail-row">
            <span class="detail-label">Type</span>
            <span class="detail-value">
              <span class="calc-badge" class:vasp={detail.calc_software === `vasp`}
                class:qe={detail.calc_software === `qe`}
                class:lammps={detail.calc_software === `lammps`}
                class:cp2k={detail.calc_software === `cp2k`}
              >
                {software_label(detail.calc_software)}
              </span>
              <span class="calc-type-badge">{calc_type_label(detail.calc_type)}</span>
            </span>
          </div>
        {/if}
      {#if detail.work_dir}
        <div class="detail-row">
          <span class="detail-label">Work Dir</span>
          <span class="detail-value mono">
            {detail.work_dir}
            <button class="copy-btn" onclick={() => copy_text(detail?.work_dir || ``)}>Copy</button>
          </span>
        </div>
      {/if}
        <div class="detail-row">
          <span class="detail-label">Partition</span>
          <span class="detail-value">{detail.partition}</span>
        </div>
        {#if detail.account}
          <div class="detail-row">
            <span class="detail-label">Account</span>
            <span class="detail-value">{detail.account}</span>
          </div>
        {/if}
      <div class="detail-row">
        <span class="detail-label">Resources</span>
        <span class="detail-value">
          {detail.num_nodes} node{detail.num_nodes !== 1 ? `s` : ``}
          {#if detail.num_tasks > 0} · {detail.num_tasks} task{detail.num_tasks !== 1 ? `s` : ``}{/if}
          {#if detail.cpus_per_task > 0} · {detail.cpus_per_task} CPUs/task{/if}
        </span>
      </div>
        {#if detail.node_list}
          <div class="detail-row">
            <span class="detail-label">Node List</span>
            <span class="detail-value mono">
              {detail.node_list}
              <button class="copy-btn" onclick={() => copy_text(detail?.node_list || ``)}>Copy</button>
            </span>
          </div>
        {/if}
        <div class="detail-row">
          <span class="detail-label">Time</span>
          <span class="detail-value">{detail.time_elapsed} / {detail.time_limit}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Submitted</span>
          <span class="detail-value">{detail.submit_time}</span>
        </div>
        {#if detail.start_time}
          <div class="detail-row">
            <span class="detail-label">Started</span>
            <span class="detail-value">{detail.start_time}</span>
          </div>
        {/if}
        {#if detail.end_time}
          <div class="detail-row">
            <span class="detail-label">Ended</span>
            <span class="detail-value">{detail.end_time}</span>
          </div>
        {/if}
        {#if detail.exit_code}
          <div class="detail-row">
            <span class="detail-label">Exit Code</span>
            <span class="detail-value">{detail.exit_code}</span>
          </div>
        {/if}
        {#if detail.reason && detail.reason !== `None`}
          <div class="detail-row">
            <span class="detail-label">Reason</span>
            <span class="detail-value">{detail.reason}</span>
          </div>
        {/if}
      </div>

      <!-- Progress bar for running jobs -->
      {#if detail.status === `RUNNING` && detail.total_steps > 0}
        <div class="progress-section">
          <div class="progress-header">
            <span>Progress</span>
            <span>{detail.current_step} / {detail.total_steps} steps</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar" style:width="{(detail.current_step / detail.total_steps) * 100}%"></div>
          </div>
        </div>
      {/if}

      {#if (detail.calc_software === `vasp` || detail.calc_software === `cp2k`) && (detail.calc_type === `opt` || detail.calc_type === `md` || detail.calc_type === `scf` || detail.calc_type === `unknown`)}
        <div class="structure-actions">
          <button class="action-btn" onclick={load_structure} disabled={structure_loading}>
            {structure_loading ? `Loading...` : `Load Structure`}
          </button>
          {#if detail.calc_software === `vasp` && (detail.calc_type === `opt` || detail.calc_type === `md`)}
            <button class="action-btn" onclick={load_trajectory} disabled={trajectory_loading}>
              {trajectory_loading ? `Loading...` : `Load All Frames`}
            </button>
          {/if}
        </div>
        {#if trajectory_frames.length > 0}
          <div class="frame-selector">
            <span class="frame-label">Frame {selected_frame + 1} / {trajectory_frames.length}</span>
            <input type="range" min={0} max={trajectory_frames.length - 1}
              bind:value={selected_frame} style="flex: 1;" />
            <button class="action-btn small"
              onclick={() => on_load_structure?.(trajectory_frames[selected_frame])}>
              Load
            </button>
          </div>
        {/if}
        {#if structure_error}
          <p class="error-text small">{structure_error}</p>
        {/if}
        {#if trajectory_error}
          <p class="error-text small">{trajectory_error}</p>
        {/if}
      {/if}

      {#if current_structure && detail?.work_dir}
        <div class="push-section">
          <button class="action-btn" onclick={push_structure_to_job} disabled={push_loading}>
            {push_loading ? `Uploading...` : `Push Structure to Job Dir`}
          </button>
          {#if push_message}
            <span class="push-msg">{push_message}</span>
          {/if}
        </div>
      {/if}

      {#if detail}
        <div class="job-actions">
          {#if detail.status === `RUNNING` || detail.status === `PENDING`}
            <button class="action-btn cancel" onclick={handle_cancel} disabled={cancel_loading}>
              {cancel_loading ? `Cancelling...` : `Kill Job`}
            </button>
          {/if}
          <button class="action-btn" onclick={handle_resubmit} disabled={resubmit_loading}>
            {resubmit_loading ? `Submitting...` : `Submit`}
          </button>
        </div>
        {#if cancel_msg}
          <p class="action-msg">{cancel_msg}</p>
        {/if}
        {#if resubmit_msg}
          <p class="action-msg">{resubmit_msg}</p>
        {/if}
      {/if}

      <button class="refresh-btn" onclick={load_detail}>Refresh</button>
    {/if}

  <!-- CONVERGENCE TAB -->
  {:else if active_tab === `convergence`}
    {#if convergence_loading}
      <p class="loading-text">Loading convergence data...</p>
    {:else if convergence_error}
      <p class="error-text">{convergence_error}</p>
    {:else if convergence && convergence.points.length > 0}
      <!-- Convergence stats -->
      <div class="conv-stats">
        <div class="stat">
          <span class="stat-label">Steps</span>
          <span class="stat-value">{convergence.points.length}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Final E</span>
          <span class="stat-value">{fmt(convergence.points[convergence.points.length - 1].energy, 3)} eV</span>
        </div>
        {#if convergence.points[convergence.points.length - 1].max_force > 0}
          <div class="stat">
            <span class="stat-label">Max Force</span>
            <span class="stat-value">{fmt(convergence.points[convergence.points.length - 1].max_force, 4)} eV/A</span>
          </div>
        {/if}
        {#if chart_points.length > 0 && chart_points[chart_points.length - 1].rms_force > 0}
          <div class="conv-stat">
            <span class="conv-label">RMS Force</span>
            <span>{fmt(chart_points[chart_points.length - 1].rms_force)} eV/A</span>
          </div>
        {/if}
        {#if convergence.converged}
          <div class="stat converged-badge">Converged</div>
        {/if}
      </div>

      <!-- Energy chart -->
      <div class="chart-section">
        <h5>Energy vs Ionic Step</h5>
        <div class="energy-chart">
          <svg viewBox="0 0 300 80" preserveAspectRatio="none">
            <polyline
              fill="none"
              stroke="var(--accent-color, #007acc)"
              stroke-width="2"
              points={chart_points
                .map(
                  (p, i) =>
                    `${(i / Math.max(chart_points.length - 1, 1)) * 290 + 5},${75 - ((p.energy - energy_min) / energy_range) * 65 - 5}`,
                )
                .join(` `)}
            />
          </svg>
          <div class="chart-labels">
            <span>{fmt(energy_max, 2)} eV</span>
            <span>{fmt(energy_min, 2)} eV</span>
          </div>
        </div>
      </div>

      <!-- Force chart (if force data available) -->
      {#if force_max > 0}
        <div class="chart-section">
          <h5>Max Force vs Ionic Step</h5>
          <div class="energy-chart force-chart">
            <svg viewBox="0 0 300 80" preserveAspectRatio="none">
              <polyline
                fill="none"
                stroke="var(--warning-color, #eab308)"
                stroke-width="2"
                points={chart_points
                  .map(
                    (p, i) =>
                      `${(i / Math.max(chart_points.length - 1, 1)) * 290 + 5},${75 - (p.max_force / force_max) * 65 - 5}`,
                  )
                  .join(` `)}
              />
            </svg>
            <div class="chart-labels">
              <span>{fmt(force_max, 3)} eV/A</span>
              <span>0</span>
            </div>
          </div>
        </div>
      {/if}

      <!-- Load structure button -->
      {#if detail?.calc_software === `vasp` || detail?.calc_software === `cp2k`}
        <div class="action-section">
          <button
            class="load-structure-btn"
            onclick={load_structure}
            disabled={structure_loading}
          >
            {structure_loading ? `Loading...` : `Load Structure in Viewer`}
          </button>
          {#if structure_error}
            <p class="error-text small">{structure_error}</p>
          {/if}
        </div>
      {/if}

      <button class="refresh-btn" onclick={load_convergence}>Refresh</button>
    {:else if convergence}
      <p class="loading-text">{convergence.message || `No convergence data available`}</p>
    {/if}

  <!-- LOG TAB -->
  {:else if active_tab === `log`}
    <div class="log-controls">
      <div class="log-toggle">
        <button
          class="tab-btn small"
          class:active={log_file === `stdout`}
          onclick={() => switch_log_file(`stdout`)}
        >
          stdout
        </button>
        <button
          class="tab-btn small"
          class:active={log_file === `stderr`}
          onclick={() => switch_log_file(`stderr`)}
        >
          stderr
        </button>
      </div>
      <button class="refresh-btn small" onclick={load_log} disabled={log_loading}>
        Refresh
      </button>
    </div>

    {#if log_loading}
      <p class="loading-text">Loading log...</p>
    {:else if log_error}
      <p class="error-text">{log_error}</p>
    {:else if log_data}
      {#if log_data.file_path}
        <div class="log-path">{log_data.file_path}</div>
      {/if}
      <pre class="log-content">{log_data.content || `(empty)`}</pre>
      {#if log_data.total_lines > 0}
        <div class="log-info">Showing last {log_data.content.split(`\n`).length} of {log_data.total_lines} lines</div>
      {/if}
    {/if}

  <!-- FILES TAB -->
  {:else if active_tab === `files`}
    {#if file_list_loading}
      <p class="loading-text">Loading files...</p>
    {:else if file_error && file_list.length === 0}
      <p class="error-text">{file_error}</p>
    {:else}
      <div class="file-selector">
        <select bind:value={selected_file}
          onchange={() => { if (selected_file) load_file_content(selected_file) }}>
          <option value="">Select file...</option>
          {#each file_list as f}
            <option value={f}>{f}</option>
          {/each}
        </select>
      </div>

      {#if file_loading}
        <p class="loading-text">Loading...</p>
      {:else if selected_file && file_content !== undefined}
        <textarea
          class="file-editor"
          bind:value={file_content}
          spellcheck="false"
        ></textarea>
        <div class="file-actions">
          <button class="save-btn" onclick={save_file}
            disabled={file_saving || !file_modified}>
            {file_saving ? `Saving...` : `Save`}
          </button>
          {#if file_save_msg}
            <span class="save-msg">{file_save_msg}</span>
          {/if}
        </div>
        {#if file_error}
          <p class="error-text small">{file_error}</p>
        {/if}
      {/if}
    {/if}
  {/if}
</DraggablePane>

<style>
  h4 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
  }

  .job-status-badge {
    font-size: 0.75em;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 500;
  }
  .badge-green { background: color-mix(in srgb, var(--success-color) 20%, transparent); color: var(--success-color); }
  .badge-yellow { background: color-mix(in srgb, var(--warning-color) 20%, transparent); color: var(--warning-color); }
  .badge-red { background: color-mix(in srgb, var(--error-color) 20%, transparent); color: var(--error-color); }
  .badge-blue { background: color-mix(in srgb, var(--accent-color) 20%, transparent); color: var(--accent-color); }

  .tab-bar {
    display: flex;
    gap: 2px;
    margin-bottom: 10px;
    border-bottom: 1px solid var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1)));
    padding-bottom: 6px;
  }

  .tab-btn {
    padding: 5px 12px;
    border: none;
    background: transparent;
    color: var(--text-color, #fff);
    opacity: 0.6;
    cursor: pointer;
    border-radius: 4px 4px 0 0;
    font-size: 0.9em;
  }
  .tab-btn:hover { opacity: 0.8; }
  .tab-btn.active {
    opacity: 1;
    background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08)));
    border-bottom: 2px solid var(--accent-color, #007acc);
  }
  .tab-btn.small {
    padding: 3px 8px;
    font-size: 0.8em;
    border-radius: 3px;
  }
  .tab-btn.small.active {
    border-bottom: none;
    background: var(--border-color);
  }

  .loading-text {
    opacity: 0.6;
    font-size: 0.9em;
  }
  .error-text {
    color: var(--error-color, #ef4444);
    font-size: 0.85em;
  }
  .error-text.small { font-size: 0.8em; margin-top: 4px; }

  .detail-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.85em;
  }
  .detail-row {
    display: flex;
    gap: 8px;
  }
  .detail-label {
    min-width: 80px;
    opacity: 0.6;
    flex-shrink: 0;
  }
  .detail-value {
    word-break: break-all;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    user-select: text;
    cursor: text;
  }
  .detail-value.mono {
    font-family: monospace;
    font-size: 0.9em;
  }

  .calc-badge {
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.85em;
    font-weight: 600;
    background: rgba(100, 100, 100, 0.3);
  }
  .calc-badge.vasp { background: color-mix(in srgb, var(--accent-color) 20%, transparent); color: var(--accent-color); }
  .calc-badge.qe { background: color-mix(in srgb, light-dark(#7c3aed, #c084fc) 20%, transparent); color: light-dark(#7c3aed, #c084fc); }
  .calc-badge.lammps { background: color-mix(in srgb, var(--warning-color) 20%, transparent); color: var(--warning-color); }
  .calc-badge.cp2k { background: color-mix(in srgb, var(--success-color) 20%, transparent); color: var(--success-color); }

  .calc-type-badge {
    font-size: 0.85em;
    opacity: 0.8;
  }

  .progress-section {
    margin-top: 10px;
    background: light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.05));
    border-radius: 4px;
    padding: 8px;
  }
  .progress-header {
    display: flex;
    justify-content: space-between;
    font-size: 0.85em;
    margin-bottom: 4px;
  }
  .progress-bar-container {
    height: 6px;
    background: var(--border-color);
    border-radius: 4px;
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    background: var(--accent-color, #007acc);
    transition: width 0.3s ease-out;
  }

  .action-section {
    margin-top: 10px;
  }

  .load-structure-btn {
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-radius: 4px;
    background: var(--accent-color, #007acc);
    color: white;
    cursor: pointer;
    font-size: 0.9em;
  }
  .load-structure-btn:hover:not(:disabled) { filter: brightness(1.1); }
  .load-structure-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .refresh-btn {
    margin-top: 8px;
    padding: 5px 10px;
    border: 1px solid var(--border-color);
    background: light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.05));
    color: var(--text-color, #fff);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.8em;
    width: 100%;
  }
  .refresh-btn:hover { background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); }
  .refresh-btn.small {
    width: auto;
    padding: 3px 8px;
    margin-top: 0;
  }

  /* Convergence tab */
  .conv-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;
    padding: 8px;
    background: light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.05));
    border-radius: 4px;
  }
  .stat {
    text-align: center;
    flex: 1;
    min-width: 60px;
  }
  .stat-label {
    display: block;
    font-size: 0.75em;
    opacity: 0.6;
  }
  .stat-value {
    font-size: 0.85em;
    font-weight: 500;
  }
  .converged-badge {
    color: var(--success-color, #22c55e);
    font-weight: 600;
    font-size: 0.85em;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .chart-section {
    margin-bottom: 10px;
  }
  .chart-section h5 {
    margin: 0 0 4px;
    font-size: 0.8em;
    opacity: 0.6;
  }
  .energy-chart {
    height: 80px;
    background: light-dark(rgba(0,0,0,0.04), rgba(0,0,0,0.2));
    border-radius: 4px;
    overflow: hidden;
    position: relative;
  }
  .energy-chart svg {
    width: 100%;
    height: 100%;
  }
  .chart-labels {
    position: absolute;
    top: 2px;
    right: 4px;
    bottom: 2px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    font-size: 0.7em;
    opacity: 0.5;
    pointer-events: none;
  }

  /* Log tab */
  .log-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .log-toggle {
    display: flex;
    gap: 2px;
  }
  .log-path {
    font-family: monospace;
    font-size: 0.75em;
    opacity: 0.5;
    margin-bottom: 4px;
    word-break: break-all;
  }
  .log-content {
    font-family: monospace;
    font-size: 0.75em;
    background: light-dark(rgba(0,0,0,0.06), rgba(0,0,0,0.3));
    border-radius: 4px;
    padding: 8px;
    max-height: 400px;
    overflow-y: auto;
    overflow-x: auto;
    white-space: pre;
    margin: 0;
    line-height: 1.4;
  }
  .log-info {
    font-size: 0.75em;
    opacity: 0.5;
    margin-top: 4px;
    text-align: right;
  }

  .copy-btn {
    background: none;
    border: 1px solid var(--border-color);
    border-radius: 3px;
    color: inherit;
    opacity: 0.4;
    cursor: pointer;
    padding: 1px 5px;
    font-size: 0.75em;
    flex-shrink: 0;
  }
  .copy-btn:hover { opacity: 1; }

  .structure-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  .action-btn {
    padding: 5px 10px;
    border: 1px solid var(--border-color);
    background: light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.05));
    color: inherit;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .action-btn:hover:not(:disabled) { background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); }
  .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .action-btn.small { padding: 3px 8px; font-size: 0.8em; }

  .frame-selector {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: 0.85em;
  }
  .frame-label { white-space: nowrap; opacity: 0.7; }
  .frame-selector input[type="range"] { flex: 1; }

  .push-section {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .push-msg { font-size: 0.8em; opacity: 0.7; }

  .file-selector select {
    width: 100%;
    padding: 5px;
    border-radius: 4px;
    background: light-dark(rgba(0,0,0,0.04), rgba(0,0,0,0.2));
    border: 1px solid var(--border-color);
    color: inherit;
    margin-bottom: 8px;
  }
  .file-editor {
    width: 100%;
    height: 250px;
    font-family: monospace;
    font-size: 0.8em;
    background: light-dark(rgba(0,0,0,0.06), rgba(0,0,0,0.3));
    border: 1px solid var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1)));
    border-radius: 4px;
    padding: 8px;
    resize: vertical;
    color: inherit;
    line-height: 1.4;
    tab-size: 4;
  }
  .file-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .save-btn {
    padding: 5px 16px;
    border: none;
    border-radius: 4px;
    background: var(--accent-color, #007acc);
    color: white;
    cursor: pointer;
  }
  .save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .save-msg { font-size: 0.8em; opacity: 0.7; }
  .job-actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
  }
  .action-btn.cancel {
    border-color: color-mix(in srgb, var(--error-color) 40%, transparent);
    color: var(--error-color);
  }
  .action-btn.cancel:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error-color) 15%, transparent);
  }
  .action-msg {
    font-size: 0.8em;
    opacity: 0.7;
    margin-top: 4px;
  }
</style>

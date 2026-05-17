<script lang="ts">
  import '$lib/dialog-shared.css'
  import { API_BASE } from '$lib/api/config'
  import { parse_structure_file } from '$lib/structure/parse'
  import { get_current_structure } from '$lib/structure/current-structure.svelte'
  import { hpc_session_store, refresh_hpc_sessions, LOCAL_SESSION_ID } from '$lib/hpc-sessions.svelte'
  import OptimadeSearchModal from '$lib/structure/OptimadeSearchModal.svelte'
  import OptimadePreviewModal from '$lib/structure/OptimadePreviewModal.svelte'
  import PubchemSearchModal from '$lib/structure/PubchemSearchModal.svelte'
  import { is_trajectory_file, parse_trajectory_async, MAX_BIN_FILE_SIZE, MAX_TEXT_FILE_SIZE } from '$lib/trajectory/parse'
  import type { TrajectoryType } from '$lib/trajectory'
  import type { PymatgenStructure } from '$lib/structure'

  // ─── Props ───
  let {
    show = $bindable(false),
    structure_json = $bindable<string | null>(null),
    mode = `import`,
    title = `Structure Input`,
    onconfirm,
    onclose,
  }: {
    show?: boolean
    structure_json?: string | null
    mode?: `import` | `edit` | `view`
    title?: string
    onconfirm?: (data: { structure_json: string; trajectory?: TrajectoryType; n_frames?: number }) => void
    onclose?: () => void
  } = $props()

  // ─── Tab state ───
  type Tab = `paste` | `database` | `remote`
  let active_tab = $state<Tab>(`paste`)

  // ─── Paste / Upload state ───
  let paste_text = $state(``)
  let parse_loading = $state(false)
  let parse_error = $state(``)
  let drag_over = $state(false)

  // ─── Database tab state ───
  let db_search = $state(``)
  let db_results = $state<Array<{
    row_id: number
    formula: string
    energy: number | null
    workflow_name: string
    structure_json: string
  }>>([])
  let db_loading = $state(false)
  let db_error = $state(``)

  // ─── Remote tab state ───
  let remote_session_id = $state(``)
  let remote_path = $state(``)
  let remote_loading = $state(false)
  let remote_error = $state(``)
  let remote_sessions_fetched = $state(false)

  // Refresh HPC sessions when switching to Remote tab
  $effect(() => {
    if (active_tab === `remote` && !remote_sessions_fetched) {
      remote_sessions_fetched = true
      refresh_hpc_sessions()
    }
  })

  // ─── OPTIMADE / PubChem sub-modal state ───
  let show_optimade = $state(false)
  let show_pubchem = $state(false)

  // ─── Database import preview state (OPTIMADE / PubChem) ───
  let show_db_preview = $state(false)
  let db_preview_pymatgen = $state<PymatgenStructure | null>(null)
  let db_preview_title = $state(`Preview Structure Import`)
  let db_preview_formula = $state(``)
  let db_preview_details = $state<Array<{ label: string; value: string; mono?: boolean }>>([])
  let db_preview_lattice = $state<{ a: number; b: number; c: number; alpha: number; beta: number; gamma: number } | null>(null)

  // ─── Trajectory state ───
  // IMPORTANT: trajectory stored as non-reactive to avoid Svelte proxifying
  // millions of nested objects (sites, species, coords) which causes UI freeze
  let pending_trajectory: TrajectoryType | null = null
  let traj_parse_loading = $state(false)
  let traj_parse_error = $state(``)

  // ─── Parsed structure preview ───
  let preview = $state<{
    formula: string
    n_atoms: number
    lattice: { a: number; b: number; c: number; alpha: number; beta: number; gamma: number }
    spacegroup?: string
    n_frames?: number
  } | null>(null)

  let pending_json = $state<string | null>(null)

  // ─── Derived ───
  let has_structure = $derived(pending_json !== null)
  let is_view_mode = $derived(mode === `view`)

  // ─── Capture from Viewer ───
  let capture_loading = $state(false)
  let capture_error = $state(``)

  async function capture_from_viewer() {
    capture_loading = true
    capture_error = ``
    try {
      let data: { sites?: unknown[] } | null = null
      // Prefer the backend viewer state (covers multi-tab / external panes),
      // but it is wiped when the structure pane closes. Fall back to the
      // durable client-side store so this still works full-screen on the
      // Workflow editor with no visible structure pane.
      try {
        const resp = await fetch(`${API_BASE}/view/structure/current`)
        if (resp.ok) data = await resp.json()
      } catch { /* fall through to client store */ }
      if (!data || !(data.sites?.length)) {
        data = get_current_structure() as { sites?: unknown[] } | null
      }
      if (!data || !(data.sites?.length)) {
        throw new Error(`No structure loaded — open one in a structure viewer first`)
      }
      const json_str = JSON.stringify(data)
      pending_json = json_str
      extract_preview(data)
    } catch (err) {
      capture_error = err instanceof Error ? err.message : `Capture failed`
    } finally {
      capture_loading = false
    }
  }

  // ─── Tabs config ───
  const tabs: { id: Tab; label: string }[] = [
    { id: `paste`, label: `Paste / Upload` },
    { id: `database`, label: `From Database` },
    { id: `remote`, label: `From Server` },
  ]

  // ─── Reset state when dialog opens ───
  $effect(() => {
    if (show) {
      parse_error = ``
      db_error = ``
      remote_error = ``
      traj_parse_error = ``
      pending_trajectory = null
      show_optimade = false
      show_pubchem = false
      paste_text = ``

      // If we already have a structure_json (edit/view mode), parse preview from it
      if (structure_json) {
        pending_json = structure_json
        try {
          extract_preview(JSON.parse(structure_json))
        } catch {
          preview = null
        }
      } else {
        pending_json = null
        preview = null
      }
    }
  })

  // ─── Extract preview info from pymatgen-style JSON ───
  function extract_preview(data: Record<string, unknown>) {
    try {
      const lattice = data.lattice as Record<string, unknown> | undefined
      const sites = (data.sites as unknown[]) ?? []
      const matrix = lattice?.matrix as number[][] | undefined

      let a = 0, b = 0, c = 0, alpha = 90, beta = 90, gamma = 90
      if (matrix && matrix.length === 3) {
        // Compute lattice parameters from matrix
        const vec_len = (v: number[]) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
        const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
        const angle = (u: number[], v: number[]) =>
          Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (vec_len(u) * vec_len(v))))) * 180 / Math.PI
        a = vec_len(matrix[0])
        b = vec_len(matrix[1])
        c = vec_len(matrix[2])
        alpha = angle(matrix[1], matrix[2])
        beta = angle(matrix[0], matrix[2])
        gamma = angle(matrix[0], matrix[1])
      } else if (lattice) {
        a = (lattice.a as number) ?? 0
        b = (lattice.b as number) ?? 0
        c = (lattice.c as number) ?? 0
        alpha = (lattice.alpha as number) ?? 90
        beta = (lattice.beta as number) ?? 90
        gamma = (lattice.gamma as number) ?? 90
      }

      // Build formula from sites
      const species_counts: Record<string, number> = {}
      for (const site of sites) {
        const s = site as Record<string, unknown>
        const sp = s.species as Array<{ element: string }> | undefined
        const el = sp?.[0]?.element ?? (s.label as string) ?? `?`
        species_counts[el] = (species_counts[el] ?? 0) + 1
      }
      const formula = Object.entries(species_counts)
        .map(([el, n]) => (n === 1 ? el : `${el}${n}`))
        .join(``)

      preview = {
        formula: (formula || (data.formula as string)) ?? `Unknown`,
        n_atoms: sites.length,
        lattice: {
          a: +a.toFixed(4),
          b: +b.toFixed(4),
          c: +c.toFixed(4),
          alpha: +alpha.toFixed(2),
          beta: +beta.toFixed(2),
          gamma: +gamma.toFixed(2),
        },
        spacegroup: (data.spacegroup as string) ?? undefined,
      }
    } catch {
      preview = null
    }
  }

  // ─── Parse structure via backend ───
  async function parse_structure(content: string, format?: string) {
    parse_loading = true
    parse_error = ``
    try {
      const res = await fetch(`${API_BASE}/vasp/parse-structure`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({ content, ...(format ? { format } : {}) }),
      })
      if (!res.ok) {
        const err_data = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))
        throw new Error(err_data.detail ?? `Parse failed (${res.status})`)
      }
      const data = await res.json()
      const json_str = typeof data === `string` ? data : JSON.stringify(data)
      pending_json = json_str
      extract_preview(typeof data === `string` ? JSON.parse(data) : data)
    } catch (err) {
      parse_error = err instanceof Error ? err.message : `Parse failed`
      pending_json = null
      preview = null
    } finally {
      parse_loading = false
    }
  }

  // ─── File handling ───
  async function handle_file(file: File) {
    const is_bin = /\.(traj|h5|hdf5)$/i.test(file.name)
    const is_xyz = /\.(xyz|extxyz)$/i.test(file.name)

    // File size validation
    const size_limit = is_bin ? MAX_BIN_FILE_SIZE : MAX_TEXT_FILE_SIZE
    if (file.size > size_limit) {
      const limit_mb = Math.round(size_limit / 1024 / 1024)
      const file_mb = Math.round(file.size / 1024 / 1024)
      parse_error = `File too large (${file_mb} MB). Maximum is ${limit_mb} MB.`
      return
    }

    // For binary files or known trajectory formats, try trajectory parsing directly
    if (is_bin || is_trajectory_file(file.name)) {
      const result = await try_trajectory_parse(file, is_bin)
      if (result) return
    }

    // For text files (especially xyz), read content then check for multi-frame
    if (!is_bin) {
      const content = await file.text()

      // Check if xyz/text file is multi-frame using content-based detection
      if (is_xyz && is_trajectory_file(file.name, content)) {
        const result = await try_trajectory_parse_from_text(content, file.name)
        if (result) return
      }

      // Single structure parsing
      paste_text = content
      parse_client_side(content, file.name)
      return
    }
  }

  // Progress message for trajectory parsing
  let traj_progress_msg = $state(`Parsing trajectory file...`)

  // Helper: try parsing file as trajectory
  async function try_trajectory_parse(file: File, is_binary: boolean): Promise<boolean> {
    traj_parse_loading = true
    traj_parse_error = ``
    parse_error = ``
    traj_progress_msg = `Parsing trajectory file...`
    try {
      const data = is_binary ? await file.arrayBuffer() : await file.text()
      const trajectory = await parse_trajectory_async(data, file.name, (progress) => {
        traj_progress_msg = progress.stage || `Parsing... ${Math.round(progress.current)}%`
      })
      return handle_trajectory_result(trajectory)
    } catch {
      // Not a valid trajectory, fall through
    }
    traj_parse_loading = false
    return false
  }

  // Helper: try parsing text content as trajectory
  async function try_trajectory_parse_from_text(content: string, filename: string): Promise<boolean> {
    traj_parse_loading = true
    traj_parse_error = ``
    parse_error = ``
    traj_progress_msg = `Parsing trajectory file...`
    try {
      const trajectory = await parse_trajectory_async(content, filename, (progress) => {
        traj_progress_msg = progress.stage || `Parsing... ${Math.round(progress.current)}%`
      })
      return handle_trajectory_result(trajectory)
    } catch {
      // Not a valid trajectory, fall through
    }
    traj_parse_loading = false
    return false
  }

  // Helper: handle parsed trajectory result
  function handle_trajectory_result(trajectory: TrajectoryType): boolean {
    const total = trajectory.total_frames ?? trajectory.frames.length
    if (total > 1) {
      pending_trajectory = trajectory
      const first_struct = trajectory.frames[0].structure as Record<string, unknown>
      pending_json = JSON.stringify(first_struct)
      extract_preview(first_struct)
      if (preview) preview.n_frames = total
      traj_parse_loading = false
      return true
    } else if (trajectory.frames.length === 1) {
      pending_trajectory = null
      const struct = trajectory.frames[0].structure as Record<string, unknown>
      pending_json = JSON.stringify(struct)
      extract_preview(struct)
      traj_parse_loading = false
      return true
    }
    traj_parse_loading = false
    return false
  }

  // Try client-side parsing first (works without backend), fall back to backend
  function parse_client_side(content: string, filename?: string) {
    parse_loading = true
    parse_error = ``
    try {
      const parsed = parse_structure_file(content, filename)
      if (parsed && parsed.sites?.length) {
        // Convert to pymatgen-style JSON for storage
        const json_obj: Record<string, unknown> = {
          sites: parsed.sites,
          charge: 0,
          ...(parsed.lattice && {
            lattice: { ...parsed.lattice, pbc: [true, true, true] },
          }),
        }

        // For LAMMPS data files: store raw content so the workflow can use
        // the original file (with bonds, angles, charges, molecule IDs)
        // instead of regenerating a lossy data file from the structure.
        const is_lammps = (filename && /\.(data|lammps|lmp)$/i.test(filename)) ||
          guess_format(content) === `lammps-data`
        if (is_lammps) {
          json_obj._lammps_data_raw = content
        }

        const json_str = JSON.stringify(json_obj)
        pending_json = json_str
        extract_preview(json_obj)
        parse_loading = false
        return
      }
    } catch {
      // Client-side parse failed, try backend
    }
    // Fall back to backend parse
    const fmt = guess_format(content)
    parse_structure(content, fmt)
  }

  function on_file_input(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (file) handle_file(file)
    input.value = ``
  }

  function on_drop(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    drag_over = false
    const file = e.dataTransfer?.files?.[0]
    if (file) handle_file(file)
  }

  function on_dragover(e: DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    drag_over = true
  }

  function on_dragleave() {
    drag_over = false
  }

  // ─── Database search ───
  async function search_database() {
    db_loading = true
    db_error = ``
    try {
      const params = new URLSearchParams()
      if (db_search.trim()) params.set(`search`, db_search.trim())
      const res = await fetch(`${API_BASE}/workflow/results?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      db_results = Array.isArray(data) ? data : data.results ?? []
    } catch (err) {
      db_error = err instanceof Error ? err.message : `Search failed`
      db_results = []
    } finally {
      db_loading = false
    }
  }

  function select_db_result(result: typeof db_results[number]) {
    pending_json = result.structure_json
    try {
      extract_preview(JSON.parse(result.structure_json))
    } catch {
      preview = null
    }
  }

  // ─── Remote fetch ───
  async function resolve_structure_path(session_id: string, path: string): Promise<string> {
    const targets = [`CONTCAR`, `POSCAR`, `CONTCAR.vasp`, `POSCAR.vasp`]
    const params = new URLSearchParams({
      session_id,
      remote_path: path,
      targets: targets.join(`,`),
    })
    const resp = await fetch(`${API_BASE}/hpc/resolve-file?${params}`)
    if (!resp.ok) return path
    const data = await resp.json()
    if (data.is_dir && !data.found) {
      const hint = data.files?.length
        ? `\nFiles found: ${data.files.slice(0, 10).join(`, `)}`
        : ``
      throw new Error(`Directory does not contain POSCAR or CONTCAR${hint}`)
    }
    return data.resolved_path
  }

  async function fetch_remote() {
    if (!remote_session_id.trim() || !remote_path.trim()) {
      remote_error = `Session ID and path are required`
      return
    }
    remote_loading = true
    remote_error = ``
    try {
      // Resolve directory → structure file if needed
      const resolved = await resolve_structure_path(
        remote_session_id.trim(),
        remote_path.trim(),
      )

      const res = await fetch(`${API_BASE}/hpc/files/read-content`, {
        method: `POST`,
        headers: { 'Content-Type': `application/json` },
        body: JSON.stringify({
          session_id: remote_session_id.trim(),
          file_path: resolved,
        }),
      })
      if (!res.ok) {
        const err_data = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))
        throw new Error(err_data.detail ?? `Fetch failed (${res.status})`)
      }
      const data = await res.json()
      const content = typeof data === `string` ? data : data.content ?? ``
      paste_text = content
      await parse_structure(content, `poscar`)
    } catch (err) {
      remote_error = err instanceof Error ? err.message : `Fetch failed`
    } finally {
      remote_loading = false
    }
  }

  // ─── OPTIMADE / PubChem import handlers ───
  // Direct-import (no preview) — used as fallback if preview is bypassed.
  function handle_optimade_import(structure: PymatgenStructure) {
    pending_json = JSON.stringify(structure)
    pending_trajectory = null
    extract_preview(structure as unknown as Record<string, unknown>)
    show_optimade = false
  }

  function handle_pubchem_import(structure: PymatgenStructure) {
    pending_json = JSON.stringify(structure)
    pending_trajectory = null
    extract_preview(structure as unknown as Record<string, unknown>)
    show_pubchem = false
  }

  // Preview handlers — populate the preview modal instead of importing directly.
  function compute_lattice_params(lattice_vectors: number[][] | null | undefined) {
    if (!lattice_vectors || lattice_vectors.length !== 3) return null
    try {
      const [v1, v2, v3] = lattice_vectors
      const len = (v: number[]) => Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
      const a = len(v1)
      const b = len(v2)
      const c = len(v3)
      const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
      const alpha = (Math.acos(dot(v2, v3) / (b * c)) * 180) / Math.PI
      const beta = (Math.acos(dot(v1, v3) / (a * c)) * 180) / Math.PI
      const gamma = (Math.acos(dot(v1, v2) / (a * b)) * 180) / Math.PI
      return { a, b, c, alpha, beta, gamma }
    } catch {
      return null
    }
  }

  function handle_optimade_preview(optimade_struct: any, structure: PymatgenStructure) {
    db_preview_pymatgen = structure
    const attrs = optimade_struct?.attributes ?? {}
    const provider = attrs.database_provider ?? `OPTIMADE`
    const formula =
      attrs.chemical_formula_descriptive ?? attrs.chemical_formula_reduced ?? `Unknown formula`
    const sites =
      attrs.n_sites ??
      (Array.isArray(attrs.cartesian_site_positions) ? attrs.cartesian_site_positions.length : 0)

    db_preview_title = `Preview Structure Import`
    db_preview_formula = formula
    db_preview_lattice = compute_lattice_params(attrs.lattice_vectors)
    db_preview_details = [
      { label: `ID:`, value: String(optimade_struct?.id ?? ``), mono: true },
      { label: `Formula:`, value: formula },
      { label: `Sites:`, value: String(sites) },
      { label: `Database:`, value: provider },
    ]
    show_db_preview = true
  }

  function handle_pubchem_preview(
    compound: any,
    search_result: any | null,
    structure: PymatgenStructure,
  ) {
    db_preview_pymatgen = structure

    const cid = compound?.id?.id?.cid ?? search_result?.cid ?? ``
    const formula = search_result?.formula ?? ``
    const name = search_result?.name ?? ``
    const weight = search_result?.weight
    const heavy = search_result?.HeavyAtomCount
    const n_atoms = Array.isArray(compound?.atoms?.element)
      ? compound.atoms.element.length
      : (heavy ?? 0)

    const rows: Array<{ label: string; value: string; mono?: boolean }> = []
    if (cid) rows.push({ label: `CID:`, value: String(cid), mono: true })
    if (name) rows.push({ label: `Name:`, value: name })
    if (formula) rows.push({ label: `Formula:`, value: formula })
    if (n_atoms) rows.push({ label: `Atoms:`, value: String(n_atoms) })
    if (typeof weight === `number`) rows.push({ label: `Weight:`, value: `${weight.toFixed(2)} g/mol` })
    rows.push({ label: `Database:`, value: `PubChem` })

    db_preview_title = `Preview Compound Import`
    db_preview_formula = formula
    db_preview_lattice = null
    db_preview_details = rows
    show_db_preview = true
  }

  function confirm_db_preview() {
    if (db_preview_pymatgen) {
      pending_json = JSON.stringify(db_preview_pymatgen)
      pending_trajectory = null
      extract_preview(db_preview_pymatgen as unknown as Record<string, unknown>)
    }
    show_db_preview = false
    db_preview_pymatgen = null
    db_preview_details = []
    db_preview_formula = ``
    db_preview_lattice = null
    // Close the underlying search modal too
    show_optimade = false
    show_pubchem = false
  }

  function cancel_db_preview() {
    show_db_preview = false
    db_preview_pymatgen = null
    db_preview_details = []
    db_preview_formula = ``
    db_preview_lattice = null
    // Leave the search modal open so the user can pick a different result
  }

  // ─── Confirm / Close ───
  function handle_confirm() {
    if (pending_json) {
      structure_json = pending_json
      if (pending_trajectory && pending_trajectory.frames.length > 1) {
        onconfirm?.({
          structure_json: pending_json,
          trajectory: pending_trajectory,
          n_frames: pending_trajectory.total_frames ?? pending_trajectory.frames.length,
        })
      } else {
        onconfirm?.({ structure_json: pending_json })
      }
      show = false
    }
  }

  function handle_close() {
    onclose?.()
    show = false
  }

  function handle_backdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      handle_close()
    }
  }

  function handle_keydown(e: KeyboardEvent) {
    if (e.key === `Escape`) {
      handle_close()
    }
  }

  // ─── Detect file format from extension name in POSCAR/CONTCAR ───
  function guess_format(text: string): string | undefined {
    const trimmed = text.trim()
    const lines = trimmed.split(`\n`)

    // LAMMPS data file: look for "atoms", "atom types", and box dimension keywords
    const has_lammps = trimmed.includes(`atoms`) && trimmed.includes(`atom types`) &&
      /xlo\s+xhi/i.test(trimmed) && (trimmed.includes(`Masses`) || trimmed.includes(`Atoms`))
    if (has_lammps) return `lammps-data`

    // POSCAR usually starts with a comment line, then a scaling factor number
    if (lines.length >= 2) {
      const second = lines[1].trim()
      if (/^\d+(\.\d+)?$/.test(second)) return `poscar`
    }
    if (trimmed.startsWith(`data_`) || trimmed.includes(`_cell_length_a`)) return `cif`
    if (/^\s*\d+\s*$/.test(lines[0]?.trim()) && lines.length >= 3) return `xyz`
    return undefined
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="backdrop dialog-backdrop" onclick={handle_backdrop} onkeydown={handle_keydown} role="dialog" aria-modal="true" tabindex="-1">
    <div class="modal dialog-modal">

      <!-- Header -->
      <div class="modal-header">
        <h2 class="modal-title">{title}</h2>
        <button class="close-btn" onclick={handle_close}>x</button>
      </div>

      <!-- Capture from viewer -->
      {#if !is_view_mode}
        <div class="capture-row">
          <button class="capture-btn" onclick={capture_from_viewer} disabled={capture_loading}>
            {capture_loading ? `Capturing...` : `Capture from Viewer`}
          </button>
          {#if capture_error}
            <span class="capture-error">{capture_error}</span>
          {/if}
        </div>
      {/if}

      <!-- Tab bar -->
      {#if !is_view_mode}
        <div class="tab-bar">
          {#each tabs as tab}
            <button
              class="tab-btn"
              class:active={active_tab === tab.id}
              onclick={() => active_tab = tab.id}
            >
              {tab.label}
            </button>
          {/each}
        </div>
      {/if}

      <!-- Body -->
      <div class="modal-body">

        <!-- ═══ Paste / Upload Tab ═══ -->
        {#if active_tab === `paste` && !is_view_mode}
          <section class="section">
            <!-- Drop zone -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="drop-zone"
              class:drag-over={drag_over}
              ondrop={on_drop}
              ondragover={on_dragover}
              ondragleave={on_dragleave}
            >
              <div class="drop-icon">&#128196;</div>
              <div class="drop-text">Drop structure file here</div>
              <div class="drop-formats">.cif, .xyz, POSCAR, .json, .vasp, .mol2, .pdb, .traj, .h5, XDATCAR, .data, .lammps, .lmp</div>
              <label class="file-btn">
                Browse Files
                <input type="file" accept=".cif,.xyz,.json,.vasp,.poscar,.mol2,.pdb,.traj,.h5,.hdf5,.xdatcar,.data,.lammps,.lmp" onchange={on_file_input} hidden />
              </label>
            </div>
          </section>

          <section class="section">
            <h3 class="section-title">Paste Structure Data</h3>
            <textarea
              class="input textarea"
              rows={8}
              placeholder="Paste pymatgen JSON, POSCAR, CIF, or XYZ content..."
              bind:value={paste_text}
            ></textarea>
            <div class="parse-row">
              <button
                class="btn btn-parse"
                disabled={!paste_text.trim() || parse_loading}
                onclick={() => parse_client_side(paste_text)}
              >
                {parse_loading ? `Parsing...` : `Parse`}
              </button>
              {#if parse_error}
                <span class="error-text">{parse_error}</span>
              {/if}
            </div>
          </section>

        <!-- ═══ Database Tab ═══ -->
        {:else if active_tab === `database` && !is_view_mode}
          <section class="section">
            <h3 class="section-title">Search Stored Structures</h3>
            <div class="search-row">
              <input
                class="input"
                type="text"
                placeholder="Search by formula, workflow name..."
                bind:value={db_search}
                onkeydown={(e) => { if (e.key === `Enter`) search_database() }}
              />
              <button class="btn btn-search" onclick={search_database} disabled={db_loading}>
                {db_loading ? `...` : `Search`}
              </button>
            </div>
            {#if db_error}
              <div class="error-text">{db_error}</div>
            {/if}
          </section>

          <section class="section db-results">
            {#if db_results.length === 0 && !db_loading}
              <div class="empty-text">No results. Click Search to browse stored structures.</div>
            {/if}
            {#each db_results as result}
              <button class="db-row" onclick={() => select_db_result(result)}>
                <span class="db-formula">{result.formula}</span>
                <span class="db-meta">
                  {#if result.energy !== null}
                    <span class="db-energy">{result.energy.toFixed(4)} eV</span>
                  {/if}
                  <span class="db-workflow">{result.workflow_name}</span>
                </span>
              </button>
            {/each}
          </section>

          <!-- ═══ External Databases ═══ -->
          <section class="section">
            <h3 class="section-title">External Databases</h3>
            <div class="db-sources">
              <button class="btn btn-db-source" onclick={() => show_optimade = true}>
                <span class="db-source-icon">&#127760;</span>
                <span class="db-source-info">
                  <span class="db-source-name">OPTIMADE / Materials Project</span>
                  <span class="db-source-desc">Search crystal structures from MP, AFLOW, and more</span>
                </span>
              </button>
              <button class="btn btn-db-source" onclick={() => show_pubchem = true}>
                <span class="db-source-icon">&#9883;</span>
                <span class="db-source-info">
                  <span class="db-source-name">PubChem</span>
                  <span class="db-source-desc">Search molecular structures by name or formula</span>
                </span>
              </button>
            </div>
          </section>

        <!-- ═══ Remote Tab ═══ -->
        {:else if active_tab === `remote` && !is_view_mode}
          <section class="section">
            <h3 class="section-title">Fetch from Server</h3>
            <div class="field">
              <label class="field-label">Source</label>
              <div style="display: flex; gap: 6px; align-items: center">
                <select class="input select" bind:value={remote_session_id} style="flex: 1">
                  <option value="">-- Select source --</option>
                  <option value={LOCAL_SESSION_ID}>Local (server filesystem)</option>
                  {#each hpc_session_store.sessions as s}
                    <option value={s.session_id}>{s.username}@{s.host}</option>
                  {/each}
                </select>
                <button
                  class="btn btn-icon"
                  onclick={() => refresh_hpc_sessions()}
                  title="Refresh sessions"
                  disabled={hpc_session_store.loading}
                  style="padding: 4px 8px; font-size: 1.1em"
                >↻</button>
              </div>
            </div>
            <div class="field" style="margin-top: 8px">
              <label class="field-label">Remote Path</label>
              <input
                class="input"
                type="text"
                placeholder="e.g. ~/calculations/relax/CONTCAR"
                bind:value={remote_path}
              />
            </div>
            <div class="parse-row" style="margin-top: 10px">
              <button
                class="btn btn-fetch"
                disabled={remote_loading}
                onclick={fetch_remote}
              >
                {remote_loading ? `Fetching...` : `Fetch`}
              </button>
              {#if remote_error}
                <span class="error-text">{remote_error}</span>
              {/if}
            </div>
          </section>
        {/if}

        <!-- ═══ Loading indicator ═══ -->
        {#if traj_parse_loading}
          <section class="section">
            <div class="empty-text">{traj_progress_msg}</div>
          </section>
        {/if}

        <!-- ═══ Structure Preview ═══ -->
        {#if has_structure && preview}
          <section class="section preview-section">
            <h3 class="section-title">Structure Preview</h3>
            <div class="preview-grid">
              <div class="preview-item">
                <span class="preview-label">Formula</span>
                <span class="preview-value formula-value">{preview.formula}</span>
              </div>
              <div class="preview-item">
                <span class="preview-label">Atoms</span>
                <span class="preview-value">{preview.n_atoms}</span>
              </div>
              {#if preview.n_frames && preview.n_frames > 1}
                <div class="preview-item span-2">
                  <span class="preview-label">Frames</span>
                  <span class="preview-value traj-value">{preview.n_frames} frames (trajectory)</span>
                </div>
              {/if}
              {#if preview.spacegroup}
                <div class="preview-item span-2">
                  <span class="preview-label">Space Group</span>
                  <span class="preview-value">{preview.spacegroup}</span>
                </div>
              {/if}
              <div class="preview-item">
                <span class="preview-label">a</span>
                <span class="preview-value">{preview.lattice.a} &#197;</span>
              </div>
              <div class="preview-item">
                <span class="preview-label">b</span>
                <span class="preview-value">{preview.lattice.b} &#197;</span>
              </div>
              <div class="preview-item">
                <span class="preview-label">c</span>
                <span class="preview-value">{preview.lattice.c} &#197;</span>
              </div>
              <div class="preview-item">
                <span class="preview-label">&alpha;</span>
                <span class="preview-value">{preview.lattice.alpha}&deg;</span>
              </div>
              <div class="preview-item">
                <span class="preview-label">&beta;</span>
                <span class="preview-value">{preview.lattice.beta}&deg;</span>
              </div>
              <div class="preview-item">
                <span class="preview-label">&gamma;</span>
                <span class="preview-value">{preview.lattice.gamma}&deg;</span>
              </div>
            </div>
          </section>
        {/if}
      </div>

      <!-- Footer -->
      <div class="modal-footer">
        <button class="btn btn-cancel" onclick={handle_close}>
          {is_view_mode ? `Close` : `Cancel`}
        </button>
        {#if !is_view_mode}
          <button
            class="btn btn-confirm"
            disabled={!has_structure}
            onclick={handle_confirm}
          >
            Confirm
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<!-- ═══ OPTIMADE Sub-Modal ═══ -->
<OptimadeSearchModal
  visible={show_optimade}
  onclose={() => show_optimade = false}
  onimport={handle_optimade_import}
  onpreview={handle_optimade_preview}
  onpubchem_preview={handle_pubchem_preview}
/>

<!-- ═══ PubChem Sub-Modal ═══ -->
<PubchemSearchModal
  visible={show_pubchem}
  onclose={() => show_pubchem = false}
  onimport={handle_pubchem_import}
  onpreview={handle_pubchem_preview}
/>

<!-- ═══ Database Import Preview ═══ -->
<OptimadePreviewModal
  visible={show_db_preview}
  onclose={cancel_db_preview}
  onconfirm={confirm_db_preview}
  pymatgen_structure={db_preview_pymatgen}
  title={db_preview_title}
  formula={db_preview_formula}
  details={db_preview_details}
  lattice_params={db_preview_lattice}
/>

<style>
  /* ─── Backdrop ─── */
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
  }

  /* ─── Modal ─── */
  .modal {
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 12px;
    max-width: 500px;
    width: 95%;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    font-family: 'SF Mono', 'Cascadia Code', 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--text-color, light-dark(#374151, #eee));
  }

  /* ─── Header ─── */
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    flex-shrink: 0;
  }

  .modal-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-color, light-dark(#1f2937, #eee));
    letter-spacing: 0.3px;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    font-size: 18px;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: inherit;
    line-height: 1;
  }
  .close-btn:hover {
    color: var(--text-color, light-dark(#374151, #eee));
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), #3a3a3a));
  }

  /* ─── Capture from viewer ─── */
  .capture-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 20px 6px;
    flex-shrink: 0;
  }
  .capture-btn {
    padding: 7px 16px;
    border-radius: 6px;
    font-size: 0.85em;
    font-weight: 500;
    cursor: pointer;
    background: rgba(59, 130, 246, 0.12);
    border: 1px solid rgba(59, 130, 246, 0.3);
    color: var(--accent-color, light-dark(#4f46e5, #60a5fa));
    transition: all 0.15s;
  }
  .capture-btn:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.2);
    border-color: rgba(59, 130, 246, 0.5);
  }
  .capture-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .capture-error {
    font-size: 0.75em;
    color: #ef4444;
  }

  /* ─── Tab bar ─── */
  .tab-bar {
    display: flex;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    padding: 0 20px;
    flex-shrink: 0;
    background: var(--dialog-bg, light-dark(#fff, #1c1d21));
  }

  .tab-btn {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    padding: 10px 14px;
    cursor: pointer;
    transition: all 0.15s;
    letter-spacing: 0.3px;
  }
  .tab-btn:hover {
    color: var(--text-color, light-dark(#374151, #eee));
  }
  .tab-btn.active {
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    border-bottom-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }

  /* ─── Body ─── */
  .modal-body {
    padding: 16px 20px;
    overflow-y: auto;
    flex: 1;
  }

  /* ─── Sections ─── */
  .section {
    margin-bottom: 16px;
  }
  .section:last-child {
    margin-bottom: 4px;
  }

  .section-title {
    margin: 0 0 10px 0;
    font-size: 11px;
    font-weight: 700;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    text-transform: uppercase;
    letter-spacing: 1.2px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
  }

  /* ─── Drop zone ─── */
  .drop-zone {
    border: 2px dashed var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 8px;
    padding: 24px 16px;
    text-align: center;
    transition: all 0.2s;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
  }
  .drop-zone.drag-over {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 6%, transparent);
  }

  .drop-icon {
    font-size: 28px;
    margin-bottom: 8px;
    opacity: 0.5;
  }

  .drop-text {
    font-size: 12px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    margin-bottom: 4px;
  }

  .drop-formats {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    margin-bottom: 12px;
  }

  .file-btn {
    display: inline-block;
    padding: 6px 16px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), #3a3a3a));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .file-btn:hover {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
    border-color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }

  /* ─── Inputs ─── */
  .input {
    width: 100%;
    padding: 7px 10px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-size: 12px;
    font-family: inherit;
    outline: none;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }
  .input:focus {
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-color, #3b82f6) 15%, transparent);
  }
  .input::placeholder {
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }

  .textarea {
    resize: vertical;
    min-height: 80px;
    line-height: 1.5;
    font-size: 11px;
  }

  /* ─── Field ─── */
  .field {
    display: flex;
    flex-direction: column;
  }

  .field-label {
    display: block;
    font-size: 11px;
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
    margin-bottom: 4px;
  }

  /* ─── Parse row ─── */
  .parse-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
  }

  /* ─── Search row ─── */
  .search-row {
    display: flex;
    gap: 8px;
  }
  .search-row .input {
    flex: 1;
  }

  /* ─── Database results ─── */
  .db-results {
    max-height: 200px;
    overflow-y: auto;
  }

  .db-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 10px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    border-radius: 6px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
    margin-bottom: 4px;
    text-align: left;
  }
  .db-row:hover {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 8%, transparent);
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }
  .db-row:last-child {
    margin-bottom: 0;
  }

  .db-formula {
    font-weight: 600;
    color: var(--text-color, light-dark(#1f2937, #eee));
  }

  .db-meta {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 10px;
  }

  .db-energy {
    color: var(--success-color, light-dark(#059669, #10b981));
  }

  .db-workflow {
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }

  .empty-text {
    text-align: center;
    font-size: 11px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    padding: 16px 0;
  }

  /* ─── Error text ─── */
  .error-text {
    font-size: 11px;
    color: var(--error-color, light-dark(#dc2626, #ef4444));
  }

  /* ─── Preview section ─── */
  .preview-section {
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    padding-top: 14px;
    margin-top: 14px;
  }

  .preview-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 8px;
  }

  .preview-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    border-radius: 6px;
    padding: 6px 8px;
  }

  .preview-item.span-2 {
    grid-column: span 2;
  }

  .preview-label {
    font-size: 9px;
    font-weight: 700;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
    text-transform: uppercase;
    letter-spacing: 1.2px;
  }

  .preview-value {
    font-size: 12px;
    color: var(--text-color, light-dark(#374151, #eee));
  }

  .formula-value {
    font-weight: 700;
    color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    font-size: 13px;
  }

  .traj-value {
    font-weight: 600;
    color: var(--success-color, light-dark(#059669, #10b981));
  }

  /* ─── Database Sources ─── */
  .db-sources {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .btn-db-source {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 12px;
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), rgba(255, 255, 255, 0.05)));
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    color: var(--text-color, light-dark(#374151, #eee));
    font-family: inherit;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
    text-align: left;
  }
  .btn-db-source:hover {
    background: color-mix(in srgb, var(--accent-color, #3b82f6) 8%, transparent);
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
  }

  .db-source-icon {
    font-size: 20px;
    flex-shrink: 0;
    width: 28px;
    text-align: center;
  }

  .db-source-info {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .db-source-name {
    font-weight: 600;
    font-size: 12px;
    color: var(--text-color, light-dark(#1f2937, #eee));
  }

  .db-source-desc {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }

  /* ─── Footer ─── */
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--dialog-border, light-dark(#d1d5db, #3a3a3a));
    flex-shrink: 0;
  }

  /* ─── Buttons ─── */
  .btn {
    padding: 8px 18px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid;
    font-family: inherit;
    transition: all 0.15s;
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-cancel {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), #3a3a3a));
    border-color: var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color-muted, light-dark(#6b7280, #9ca3af));
  }
  .btn-cancel:hover {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color, light-dark(#374151, #eee));
  }

  .btn-confirm {
    background: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    border-color: var(--accent-color, light-dark(#4f46e5, #3b82f6));
    color: #fff;
  }
  .btn-confirm:hover:not(:disabled) {
    background: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
    border-color: var(--accent-hover-color, light-dark(#3730a3, #2563eb));
  }

  .btn-parse,
  .btn-fetch {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), #3a3a3a));
    border-color: var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color, light-dark(#374151, #eee));
    padding: 6px 16px;
  }
  .btn-parse:hover:not(:disabled),
  .btn-fetch:hover:not(:disabled) {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
    border-color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }

  .btn-search {
    background: var(--input-bg, light-dark(rgba(0,0,0,0.03), #3a3a3a));
    border-color: var(--dialog-border, light-dark(#d1d5db, #404040));
    color: var(--text-color, light-dark(#374151, #eee));
    padding: 7px 14px;
    flex-shrink: 0;
  }
  .btn-search:hover:not(:disabled) {
    background: var(--dialog-border, light-dark(#d1d5db, #404040));
    border-color: var(--text-color-dim, light-dark(#9ca3af, #484f58));
  }
</style>

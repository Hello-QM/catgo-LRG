/**
 * Tool Controller — extracted from Structure.svelte
 *
 * Manages tool pane open/close state and panel layout:
 * - Pane visibility toggles (workflow, IO, server, chat, job detail)
 * - Terminal split-view state (show, layout, session, host, sync)
 * - Monaco editor split-view state
 * - File preview split-view state
 * - Chat panel sizing and resize logic
 * - Side panel sizing, minimization, and resize logic
 * - Electronic analysis state (DOS, COHP, Band, MD)
 * - Measurement state
 * - Export pane and optimization pane state
 *
 * Uses .svelte.ts suffix because internal state uses $state/$derived/$effect runes.
 */

import type { BandPlot, BandViewState, CohpPlot, CohpViewState, DOSSessionInfo, DosPlot, DosViewState } from '$lib/electronic'
import { check_tauri } from '$lib/io'

// ─── Types ───

export interface ToolDeps {
  get_initial_panel: () => string | undefined
}

// ─── Factory ───

export function create_tool_controller(deps: ToolDeps) {
  // ═══ Pane Open/Close State ═══
  let workflow_pane_open = $state(false)
  let io_pane_open = $state(false)
  let server_pane_open = $state(false)
  let chat_pane_open = $state(false)
  let job_detail_open = $state(false)
  let job_detail_session_id = $state('')
  let job_detail_job_id = $state('')
  let export_pane_open = $state(false)
  let optimization_pane_open = $state(false)

  // ═══ Chat Panel ═══
  let chat_panel_size = $state(28)
  let chat_bottom_size = $state(35)
  let is_chat_resizing = $state(false)

  // ═══ Terminal Split-View ═══
  let show_terminal = $state(false)
  let terminal_layout = $state<'horizontal' | 'vertical'>('horizontal')
  let terminal_session_id = $state<string | undefined>()
  let terminal_host = $state('')
  let terminal_username = $state('')
  let terminal_sync_cwd = $state(false)
  let terminal_popped_out = $state(false)
  let terminal_popped_sync_cwd = $state(false)
  let server_nav_path = $state<string | undefined>()

  // ═══ Side Panel ═══
  let side_panel_size = $state(50)
  let side_panel_minimized = $state(false)
  let is_side_resizing = $state(false)

  // ═══ Monaco Editor ═══
  let show_editor = $state(false)
  let editor_content = $state('')
  let editor_filename = $state('')
  let editor_file_path = $state('')
  let editor_session_id = $state('')

  // ═══ File Preview ═══
  let show_preview = $state(false)
  let preview_mode = $state<'image' | 'pdf' | 'markdown' | 'csv' | 'excel' | 'text'>('text')
  let preview_content = $state('')
  let preview_binary_data = $state('')
  let preview_mime_type = $state('')
  let preview_filename = $state('')
  let preview_file_path = $state('')
  let preview_session_id = $state('')

  // ═══ Measurement State ═══
  let measure_mode = $state<'distance' | 'angle' | 'dihedral'>('distance')
  let measure_menu_open = $state(false)
  let measure_mode_active = $state(false)
  let current_continuous_measurement_sites = $state<number[]>([])

  // ═══ Electronic Analysis ═══
  let electronic_sub_tab = $state<'dos' | 'cohp' | 'bands'>('dos')
  let dos_session = $state<DOSSessionInfo | null>(null)
  let dos_state: DosViewState = $state({
    dos_result: null,
    dband_result: null,
    show_fermi_line: true,
    show_fill: false,
    show_spin_down: true,
    orientation: 'vertical',
    x_range: null,
    y_range: null,
    show_dband_line: false,
    line_styles: {},
    show_gridlines: true,
    show_axis_lines: true,
    axis_line_width: 1,
    tick_length: 5,
    tick_width: 1,
    title_size: 14,
    font_size: 12,
    legend_visible: true,
    hidden_series: [],
  })
  let dos_layout = $state<'horizontal' | 'vertical'>('horizontal')
  let dos_plot_ref: DosPlot | undefined = $state()
  let show_dos_panel = $derived(dos_state.dos_result !== null)
  let dband_center_for_plot = $derived(
    dos_state.show_dband_line && typeof dos_state.dband_result?.center_rel === 'number' &&
      Number.isFinite(dos_state.dband_result.center_rel)
      ? dos_state.dband_result.center_rel
      : null
  )

  let band_state: BandViewState = $state({
    band_data: null,
    projections: null,
    show_fermi_line: true,
    show_band_gap: true,
    show_spin_down: true,
    energy_range: [-8, 6] as [number, number],
    fat_band_scale: 10,
    show_gridlines: true,
    show_axis_lines: true,
    axis_line_width: 1,
    tick_length: 5,
    tick_width: 1,
    title_size: 14,
    font_size: 12,
    legend_visible: true,
  })
  let band_layout = $state<'horizontal' | 'vertical'>('horizontal')
  let band_plot_ref: BandPlot | undefined = $state()
  let show_band_panel = $derived(band_state.band_data !== null)

  let cohp_state: CohpViewState = $state({
    cohp_result: null,
    icohp_entries: null,
    show_fermi_line: true,
    show_fill: false,
    fill_opacity: 0.15,
    show_spin_down: true,
    spin_mode: 'separate',
    orientation: 'horizontal',
    x_range: null,
    y_range: null,
    invert_cohp: true,
    show_gridlines: true,
    show_axis_lines: true,
    axis_line_width: 1,
    tick_length: 5,
    tick_width: 1,
    title_size: 14,
    font_size: 12,
    legend_visible: true,
    hidden_series: [],
    line_styles: {},
  })
  let cohp_layout = $state<'horizontal' | 'vertical'>('horizontal')
  let cohp_plot_ref: CohpPlot | undefined = $state()
  let show_cohp_panel = $derived(cohp_state.cohp_result !== null)

  // ═══ MD Analysis ═══
  let imported_traj_b64 = $state('')
  let imported_traj_format = $state('')
  let md_plot_data: { traces: any[]; title: string; x_label: string; y_label: string; layout_overrides?: Record<string, any> } | null = $state(null)
  let md_layout = $state<'horizontal' | 'vertical'>('horizontal')
  let show_md_panel = $derived(md_plot_data !== null)
  let md_x_label = $state('')
  let md_y_label = $state('')
  let md_show_gridlines = $state(true)
  let md_show_legend = $state(true)
  let md_settings_open = $state(false)

  // ═══ Auto-open initial panel ═══
  const initial_panel = deps.get_initial_panel()
  if (initial_panel) {
    if (initial_panel === 'hpc') {
      server_pane_open = true
    } else if (initial_panel === 'chat') {
      chat_pane_open = true
    } else if (initial_panel === 'terminal') {
      show_terminal = true
      side_panel_minimized = false
    }
  }

  // ═══ CWD Broadcast Listener ═══
  let _last_cwd_seq = 0
  let _cwd_debounce_timer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    if (!terminal_popped_out || !terminal_popped_sync_cwd) return
    const bc = new BroadcastChannel('catgo-terminal-cwd')
    bc.onmessage = (event: MessageEvent) => {
      const { path, seq } = event.data
      if (!path) return
      if (typeof seq === 'number' && seq <= _last_cwd_seq) return
      if (typeof seq === 'number') _last_cwd_seq = seq
      if (_cwd_debounce_timer) clearTimeout(_cwd_debounce_timer)
      _cwd_debounce_timer = setTimeout(() => {
        server_nav_path = path
        _cwd_debounce_timer = null
      }, 150)
    }
    return () => {
      bc.close()
      if (_cwd_debounce_timer) clearTimeout(_cwd_debounce_timer)
    }
  })

  // ═══ Resize Handlers ═══

  function start_side_resize(
    event: PointerEvent,
    wrapper: HTMLDivElement | undefined,
    is_vertical_fn: () => boolean,
  ) {
    event.preventDefault()
    is_side_resizing = true
    const is_vertical = is_vertical_fn()
    const rect = wrapper?.getBoundingClientRect()
    if (!rect) return

    document.body.style.cursor = is_vertical ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'

    function on_move(e: PointerEvent) {
      if (!rect) return
      let pct: number
      if (is_vertical) {
        const offset = e.clientY - rect.top
        pct = 100 - (offset / rect.height) * 100
      } else {
        const offset = e.clientX - rect.left
        pct = 100 - (offset / rect.width) * 100
      }
      side_panel_size = Math.max(15, Math.min(80, pct))
    }
    function on_up() {
      is_side_resizing = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', on_move)
      window.removeEventListener('pointerup', on_up)
    }
    window.addEventListener('pointermove', on_move)
    window.addEventListener('pointerup', on_up)
  }

  function start_chat_resize(event: PointerEvent, wrapper: HTMLDivElement | undefined) {
    event.preventDefault()
    is_chat_resizing = true
    const rect = wrapper?.getBoundingClientRect()
    if (!rect) return

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function on_move(e: PointerEvent) {
      if (!rect) return
      const pct = 100 - ((e.clientX - rect.left) / rect.width) * 100
      chat_panel_size = Math.max(15, Math.min(50, pct))
    }
    function on_up() {
      is_chat_resizing = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', on_move)
      window.removeEventListener('pointerup', on_up)
    }
    window.addEventListener('pointermove', on_move)
    window.addEventListener('pointerup', on_up)
  }

  function start_chat_bottom_resize(event: PointerEvent, wrapper: HTMLDivElement | undefined) {
    event.preventDefault()
    is_chat_resizing = true
    const rect = wrapper?.getBoundingClientRect()
    if (!rect) return

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    function on_move(e: PointerEvent) {
      if (!rect) return
      const pct = 100 - ((e.clientY - rect.top) / rect.height) * 100
      chat_bottom_size = Math.max(15, Math.min(50, pct))
    }
    function on_up() {
      is_chat_resizing = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', on_move)
      window.removeEventListener('pointerup', on_up)
    }
    window.addEventListener('pointermove', on_move)
    window.addEventListener('pointerup', on_up)
  }

  async function popout_chat() {
    chat_pane_open = false
    const url = `${window.location.origin}${window.location.pathname}#chat`
    if (typeof window !== 'undefined') {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        const chat_window = new WebviewWindow('catgo-chat', {
          title: 'CatGo - AI Chat',
          url, width: 500, height: 700, center: true, resizable: true, decorations: true,
        })
        chat_window.once('tauri://error', () => {
          window.open(url, 'catgo-chat', 'width=500,height=700,resizable=yes')
        })
        return
      } catch { /* not Tauri */ }
    }
    window.open(url, 'catgo-chat', 'width=500,height=700,resizable=yes')
  }

  function popout_terminal() {
    const params = new URLSearchParams()
    if (terminal_session_id) params.set('session_id', terminal_session_id)
    if (terminal_host) params.set('host', terminal_host)
    if (terminal_username) params.set('username', terminal_username)
    if (terminal_sync_cwd) params.set('sync_cwd', 'true')
    const qs = params.toString()
    const url = `${window.location.origin}${window.location.pathname}#terminal${qs ? `?${qs}` : ''}`
    const win_id = `terminal-${Date.now()}`
    if (check_tauri()) {
      import('@tauri-apps/api/webviewWindow').then(({ WebviewWindow }) => {
        new WebviewWindow(win_id, {
          title: terminal_host ? `${terminal_username}@${terminal_host}` : 'CatGo - Terminal',
          url, width: 900, height: 600, center: true, resizable: true, decorations: true,
        })
      }).catch(() => {
        window.open(url, win_id, 'width=900,height=600,resizable=yes')
      })
    } else {
      window.open(url, win_id, 'width=900,height=600,resizable=yes')
    }
    terminal_popped_out = true
    terminal_popped_sync_cwd = terminal_sync_cwd
  }

  function open_terminal(sid: string, host: string, user: string) {
    terminal_session_id = sid
    terminal_host = host
    terminal_username = user
    show_terminal = true
    terminal_popped_out = false
    terminal_popped_sync_cwd = false
  }

  function disconnect_terminal() {
    show_terminal = false
    terminal_session_id = undefined
    terminal_host = ''
    terminal_username = ''
  }

  function open_editor(content: string, filename: string, file_path: string, sid: string) {
    editor_content = content
    editor_filename = filename
    editor_file_path = file_path
    editor_session_id = sid
    show_editor = true
    show_preview = false
  }

  function open_preview(
    mode: typeof preview_mode, filename: string, file_path: string, sid: string,
    content?: string, binary_data?: string, mime_type?: string,
  ) {
    preview_mode = mode
    preview_filename = filename
    preview_file_path = file_path
    preview_session_id = sid
    preview_content = content ?? ''
    preview_binary_data = binary_data ?? ''
    preview_mime_type = mime_type ?? ''
    show_preview = true
    show_editor = false
  }

  function open_job_detail(sid: string, jid: string) {
    job_detail_session_id = sid
    job_detail_job_id = jid
    job_detail_open = true
  }

  // ═══ Public Interface ═══

  return {
    // Pane open/close
    get workflow_pane_open() { return workflow_pane_open },
    set workflow_pane_open(v: boolean) { workflow_pane_open = v },
    get io_pane_open() { return io_pane_open },
    set io_pane_open(v: boolean) { io_pane_open = v },
    get server_pane_open() { return server_pane_open },
    set server_pane_open(v: boolean) { server_pane_open = v },
    get chat_pane_open() { return chat_pane_open },
    set chat_pane_open(v: boolean) { chat_pane_open = v },
    get job_detail_open() { return job_detail_open },
    set job_detail_open(v: boolean) { job_detail_open = v },
    get job_detail_session_id() { return job_detail_session_id },
    get job_detail_job_id() { return job_detail_job_id },
    get export_pane_open() { return export_pane_open },
    set export_pane_open(v: boolean) { export_pane_open = v },
    get optimization_pane_open() { return optimization_pane_open },
    set optimization_pane_open(v: boolean) { optimization_pane_open = v },

    // Chat
    get chat_panel_size() { return chat_panel_size },
    set chat_panel_size(v: number) { chat_panel_size = v },
    get chat_bottom_size() { return chat_bottom_size },
    set chat_bottom_size(v: number) { chat_bottom_size = v },
    get is_chat_resizing() { return is_chat_resizing },

    // Terminal
    get show_terminal() { return show_terminal },
    set show_terminal(v: boolean) { show_terminal = v },
    get terminal_layout() { return terminal_layout },
    set terminal_layout(v: 'horizontal' | 'vertical') { terminal_layout = v },
    get terminal_session_id() { return terminal_session_id },
    set terminal_session_id(v: string | undefined) { terminal_session_id = v },
    get terminal_host() { return terminal_host },
    get terminal_username() { return terminal_username },
    get terminal_sync_cwd() { return terminal_sync_cwd },
    set terminal_sync_cwd(v: boolean) { terminal_sync_cwd = v },
    get terminal_popped_out() { return terminal_popped_out },
    set terminal_popped_out(v: boolean) { terminal_popped_out = v },
    get terminal_popped_sync_cwd() { return terminal_popped_sync_cwd },
    set terminal_popped_sync_cwd(v: boolean) { terminal_popped_sync_cwd = v },
    get server_nav_path() { return server_nav_path },
    set server_nav_path(v: string | undefined) { server_nav_path = v },

    // Side panel
    get side_panel_size() { return side_panel_size },
    set side_panel_size(v: number) { side_panel_size = v },
    get side_panel_minimized() { return side_panel_minimized },
    set side_panel_minimized(v: boolean) { side_panel_minimized = v },
    get is_side_resizing() { return is_side_resizing },

    // Editor
    get show_editor() { return show_editor },
    set show_editor(v: boolean) { show_editor = v },
    get editor_content() { return editor_content },
    set editor_content(v: string) { editor_content = v },
    get editor_filename() { return editor_filename },
    set editor_filename(v: string) { editor_filename = v },
    get editor_file_path() { return editor_file_path },
    set editor_file_path(v: string) { editor_file_path = v },
    get editor_session_id() { return editor_session_id },
    set editor_session_id(v: string) { editor_session_id = v },

    // Preview
    get show_preview() { return show_preview },
    set show_preview(v: boolean) { show_preview = v },
    get preview_mode() { return preview_mode },
    set preview_mode(v: typeof preview_mode) { preview_mode = v },
    get preview_content() { return preview_content },
    get preview_binary_data() { return preview_binary_data },
    get preview_mime_type() { return preview_mime_type },
    get preview_filename() { return preview_filename },
    get preview_file_path() { return preview_file_path },
    get preview_session_id() { return preview_session_id },

    // Measurements
    get measure_mode() { return measure_mode },
    set measure_mode(v: 'distance' | 'angle' | 'dihedral') { measure_mode = v },
    get measure_menu_open() { return measure_menu_open },
    set measure_menu_open(v: boolean) { measure_menu_open = v },
    get measure_mode_active() { return measure_mode_active },
    set measure_mode_active(v: boolean) { measure_mode_active = v },
    get current_continuous_measurement_sites() { return current_continuous_measurement_sites },
    set current_continuous_measurement_sites(v: number[]) { current_continuous_measurement_sites = v },

    // Electronic analysis
    get electronic_sub_tab() { return electronic_sub_tab },
    set electronic_sub_tab(v: 'dos' | 'cohp' | 'bands') { electronic_sub_tab = v },
    get dos_session() { return dos_session },
    set dos_session(v: DOSSessionInfo | null) { dos_session = v },
    get dos_state() { return dos_state },
    set dos_state(v: DosViewState) { dos_state = v },
    get dos_layout() { return dos_layout },
    set dos_layout(v: 'horizontal' | 'vertical') { dos_layout = v },
    get dos_plot_ref() { return dos_plot_ref },
    set dos_plot_ref(v: DosPlot | undefined) { dos_plot_ref = v },
    get show_dos_panel() { return show_dos_panel },
    get dband_center_for_plot() { return dband_center_for_plot },
    get band_state() { return band_state },
    set band_state(v: BandViewState) { band_state = v },
    get band_layout() { return band_layout },
    set band_layout(v: 'horizontal' | 'vertical') { band_layout = v },
    get band_plot_ref() { return band_plot_ref },
    set band_plot_ref(v: BandPlot | undefined) { band_plot_ref = v },
    get show_band_panel() { return show_band_panel },
    get cohp_state() { return cohp_state },
    set cohp_state(v: CohpViewState) { cohp_state = v },
    get cohp_layout() { return cohp_layout },
    set cohp_layout(v: 'horizontal' | 'vertical') { cohp_layout = v },
    get cohp_plot_ref() { return cohp_plot_ref },
    set cohp_plot_ref(v: CohpPlot | undefined) { cohp_plot_ref = v },
    get show_cohp_panel() { return show_cohp_panel },

    // MD
    get imported_traj_b64() { return imported_traj_b64 },
    set imported_traj_b64(v: string) { imported_traj_b64 = v },
    get imported_traj_format() { return imported_traj_format },
    set imported_traj_format(v: string) { imported_traj_format = v },
    get md_plot_data() { return md_plot_data },
    set md_plot_data(v: typeof md_plot_data) { md_plot_data = v },
    get md_layout() { return md_layout },
    set md_layout(v: 'horizontal' | 'vertical') { md_layout = v },
    get show_md_panel() { return show_md_panel },
    get md_x_label() { return md_x_label },
    set md_x_label(v: string) { md_x_label = v },
    get md_y_label() { return md_y_label },
    set md_y_label(v: string) { md_y_label = v },
    get md_show_gridlines() { return md_show_gridlines },
    set md_show_gridlines(v: boolean) { md_show_gridlines = v },
    get md_show_legend() { return md_show_legend },
    set md_show_legend(v: boolean) { md_show_legend = v },
    get md_settings_open() { return md_settings_open },
    set md_settings_open(v: boolean) { md_settings_open = v },

    // Functions
    start_side_resize,
    start_chat_resize,
    start_chat_bottom_resize,
    popout_chat,
    popout_terminal,
    open_terminal,
    disconnect_terminal,
    open_editor,
    open_preview,
    open_job_detail,
  }
}

export type ToolController = ReturnType<typeof create_tool_controller>

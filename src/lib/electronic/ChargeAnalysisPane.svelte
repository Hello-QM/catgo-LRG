<script lang="ts">
  import FileSourceDialog from './FileSourceDialog.svelte'
  import { API_BASE } from '$lib/api/config'
  import { getDownloadUrl } from '$lib/api/hpc'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')
  load_i18n_module('common')

  let {
    on_load_chgcar,
    on_load_bader,
  }: {
    /** Called with File object when user loads a CHGCAR/LOCPOT/ELFCAR or computed cube — parent routes to CubePanel */
    on_load_chgcar?: (file: File) => void
    /** Called with ACF.dat content — parent routes to apply_charges */
    on_load_bader?: (content: string, filename: string) => void
  } = $props()

  let show_chgcar_dialog = $state(false)
  let show_bader_dialog = $state(false)
  let loading = $state(false)
  let error = $state<string | null>(null)

  // CHGCAR patterns
  const CHGCAR_RE = /CHGCAR|AECCAR|LOCPOT|ELFCAR|PARCHG/i

  // ── Difference charge density state ──
  let diff_file_ab = $state<File | null>(null)
  let diff_file_a = $state<File | null>(null)
  let diff_file_b = $state<File | null>(null)
  let diff_loading = $state(false)
  let diff_error = $state<string | null>(null)

  function handle_drop(e: DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    route_file(file)
  }

  function route_file(file: File) {
    error = null
    const is_cube = /\.(cube|cub)$/i.test(file.name)
    if (is_cube) {
      on_load_chgcar?.(file)
    } else if (CHGCAR_RE.test(file.name)) {
      on_load_chgcar?.(file)
    } else if (/ACF\.dat/i.test(file.name) || /bader/i.test(file.name)) {
      load_bader_file(file)
    } else {
      if (file.size > 1_000_000) {
        on_load_chgcar?.(file)
      } else {
        load_bader_file(file)
      }
    }
  }

  async function load_bader_file(file: File) {
    try {
      const content = await file.text()
      on_load_bader?.(content, file.name)
    } catch (err: any) {
      error = err.message || String(err)
    }
  }

  async function handle_remote_chgcar(session_id: string, path: string) {
    show_chgcar_dialog = false
    loading = true
    error = null
    try {
      // Stream the remote file via the existing HPC download endpoint
      // (GET /api/hpc/download). The old POST /chgcar/download never existed —
      // it fell through to the SPA GET catch-all → 405 Method Not Allowed.
      const resp = await fetch(getDownloadUrl(session_id, path))
      if (!resp.ok) throw new Error(await resp.text())
      const blob = await resp.blob()
      const filename = path.split('/').pop() || 'CHGCAR'
      on_load_chgcar?.(new File([blob], filename))
    } catch (err: any) {
      error = err.message || String(err)
    } finally {
      loading = false
    }
  }

  async function handle_remote_bader(session_id: string, path: string) {
    show_bader_dialog = false
    loading = true
    error = null
    try {
      // Stream the remote file via the existing HPC download endpoint
      // (GET /api/hpc/download). The old POST /chgcar/download never existed —
      // it fell through to the SPA GET catch-all → 405 Method Not Allowed.
      const resp = await fetch(getDownloadUrl(session_id, path))
      if (!resp.ok) throw new Error(await resp.text())
      const content = await resp.text()
      const filename = path.split('/').pop() || 'ACF.dat'
      on_load_bader?.(content, filename)
    } catch (err: any) {
      error = err.message || String(err)
    } finally {
      loading = false
    }
  }

  // ── Difference charge density ──

  function pick_diff_file(slot: 'ab' | 'a' | 'b') {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return
      if (slot === 'ab') diff_file_ab = f
      else if (slot === 'a') diff_file_a = f
      else diff_file_b = f
    }
    input.click()
  }

  async function compute_diff() {
    if (!diff_file_ab || !diff_file_a || !diff_file_b) return
    diff_loading = true
    diff_error = null
    try {
      const form = new FormData()
      form.append('file_ab', diff_file_ab)
      form.append('file_a', diff_file_a)
      form.append('file_b', diff_file_b)

      const resp = await fetch(`${API_BASE}/chgcar/compute-diff`, {
        method: 'POST',
        body: form,
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || t('structure.charge_compute_diff_failed', { reason: resp.statusText }))
      }

      const cube_text = await resp.text()
      const cube_blob = new Blob([cube_text], { type: 'chemical/x-cube' })
      on_load_chgcar?.(new File([cube_blob], 'CHGCAR_diff.cube'))
    } catch (err: any) {
      diff_error = err.message || String(err)
    } finally {
      diff_loading = false
    }
  }

  let can_compute = $derived(!!diff_file_ab && !!diff_file_a && !!diff_file_b && !diff_loading)
</script>

<div class="charge-pane">
  <div
    class="charge-dropzone"
    ondragover={(e) => e.preventDefault()}
    ondrop={handle_drop}
  >
    {#if loading}
      <div class="charge-loading">{t('common.loading')}</div>
    {:else}
      <div class="charge-drop-text">
        <strong>{t('structure.charge_drop_file')}</strong>
        <span class="charge-hint">CHGCAR / LOCPOT / ELFCAR / .cube / ACF.dat</span>
      </div>
    {/if}
  </div>

  <!-- Charge density (CHGCAR) section -->
  <div class="charge-section">
    <div class="charge-section-title">{t('structure.charge_density_isosurface')}</div>
    <div class="charge-section-desc">
      {t('structure.charge_density_desc')}
    </div>
    <div class="charge-btn-row">
      <label class="charge-btn">
        {t('structure.browse_local')}
        <input type="file" hidden onchange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0]
          if (f) on_load_chgcar?.(f)
        }} />
      </label>
      <button class="charge-btn" onclick={() => show_chgcar_dialog = true}>
        {t('structure.browse_remote')}
      </button>
    </div>
  </div>

  <!-- Difference charge density section -->
  <div class="charge-section">
    <div class="charge-section-title">{t('structure.difference_charge_density')}</div>
    <div class="charge-section-desc">
      {t('structure.difference_charge_density_desc')}
    </div>
    <div class="diff-slots">
      <button class="diff-slot" onclick={() => pick_diff_file('ab')}>
        <span class="diff-label">AB</span>
        <span class="diff-file">{diff_file_ab?.name ?? t('structure.select_chgcar_ab')}</span>
      </button>
      <button class="diff-slot" onclick={() => pick_diff_file('a')}>
        <span class="diff-label">A</span>
        <span class="diff-file">{diff_file_a?.name ?? t('structure.select_chgcar_a')}</span>
      </button>
      <button class="diff-slot" onclick={() => pick_diff_file('b')}>
        <span class="diff-label">B</span>
        <span class="diff-file">{diff_file_b?.name ?? t('structure.select_chgcar_b')}</span>
      </button>
    </div>
    <button
      class="compute-btn"
      disabled={!can_compute}
      onclick={compute_diff}
    >
      {diff_loading ? t('structure.computing') : t('structure.compute_difference')}
    </button>
    {#if diff_error}
      <div class="charge-error">{diff_error}</div>
    {/if}
  </div>

  <!-- Bader charges section -->
  <div class="charge-section">
    <div class="charge-section-title">{t('structure.bader_charge_analysis')}</div>
    <div class="charge-section-desc">
      {t('structure.bader_charge_desc')}
    </div>
    <div class="charge-btn-row">
      <label class="charge-btn">
        {t('structure.browse_local')}
        <input type="file" hidden onchange={(e) => {
          const f = (e.target as HTMLInputElement).files?.[0]
          if (f) load_bader_file(f)
        }} />
      </label>
      <button class="charge-btn" onclick={() => show_bader_dialog = true}>
        {t('structure.browse_remote')}
      </button>
    </div>
  </div>

  {#if error}
    <div class="charge-error">{error}</div>
  {/if}
</div>

<!-- Always mounted, visibility driven by bind:show (matches the working
     DosAnalysisPane pattern). A `{#if cond}<Dialog bind:show={cond}/>{/if}`
     wrapper is an anti-pattern here and left the dialog never showing. -->
<FileSourceDialog
  bind:show={show_chgcar_dialog}
  title={t('structure.load_chgcar_locpot')}
  file_types={['CHGCAR', 'LOCPOT', 'ELFCAR', 'PARCHG', 'AECCAR0', 'AECCAR2']}
  onremote_path={handle_remote_chgcar}
  onclose={() => show_chgcar_dialog = false}
/>
<FileSourceDialog
  bind:show={show_bader_dialog}
  title={t('structure.load_acf_bader')}
  file_types={['ACF.dat', '.dat']}
  onremote_path={handle_remote_bader}
  onclose={() => show_bader_dialog = false}
/>

<style>
  .charge-pane {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px;
    font-size: 12px;
  }
  .charge-dropzone {
    border: 2px dashed var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 6px;
    padding: 20px 16px;
    text-align: center;
  }
  .charge-drop-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
  }
  .charge-hint {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#9ca3af, #6b7280));
  }
  .charge-loading { color: var(--accent-color, #3b82f6); }
  .charge-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .charge-section-title {
    font-size: 11px;
    font-weight: 600;
  }
  .charge-section-desc {
    font-size: 10px;
    color: var(--text-color-dim, light-dark(#6b7280, #9ca3af));
  }
  .charge-btn-row {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }
  .charge-btn {
    padding: 3px 10px;
    font-size: 10px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    background: var(--input-bg, light-dark(#fff, #2a2b30));
    color: var(--text-color, light-dark(#374151, #eee));
    cursor: pointer;
    font-family: inherit;
  }
  .charge-btn:hover { background: var(--hover-bg, light-dark(#f3f4f6, #333)); }
  .charge-error {
    padding: 4px 8px;
    font-size: 11px;
    color: #ef4444;
    background: rgba(239, 68, 68, 0.08);
    border-radius: 4px;
  }

  /* ── Difference charge density ── */
  .diff-slots {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 2px;
  }
  .diff-slot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    font-size: 10px;
    border: 1px solid var(--dialog-border, light-dark(#d1d5db, #404040));
    border-radius: 4px;
    background: var(--input-bg, light-dark(#fff, #2a2b30));
    color: var(--text-color, light-dark(#374151, #eee));
    cursor: pointer;
    font-family: inherit;
    text-align: left;
  }
  .diff-slot:hover { background: var(--hover-bg, light-dark(#f3f4f6, #333)); }
  .diff-label {
    font-weight: 700;
    font-size: 10px;
    min-width: 20px;
    color: var(--accent-color, #3b82f6);
  }
  .diff-file {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.7;
  }
  .compute-btn {
    margin-top: 4px;
    padding: 5px 12px;
    font-size: 11px;
    font-weight: 600;
    border: 1px solid var(--accent-color, #3b82f6);
    border-radius: 4px;
    background: var(--accent-color, #3b82f6);
    color: #fff;
    cursor: pointer;
    font-family: inherit;
  }
  .compute-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }
  .compute-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>

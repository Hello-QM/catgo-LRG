<script lang="ts">
  // Self-contained "upload current structure to HPC" dialog.
  // Flow: pick HPC session → browse to a remote directory → name the file →
  // upload. Deliberately independent of the Server (HPC) management pane so the
  // upload flow is a single clear path instead of being mixed into that panel.
  import type { AnyStructure } from '$lib/structure'
  import { listFiles, writeRemoteFile, type RemoteFile } from '$lib/api/hpc'
  import { hpc_session_store, refresh_hpc_sessions, LOCAL_SESSION_ID } from '$lib/hpc-sessions.svelte'
  import {
    structure_to_poscar_str,
    structure_to_cif_str,
    structure_to_xyz_str,
    structure_to_extxyz_str,
    structure_to_pdb_str,
    structure_to_json_str,
  } from './export'
  import { show_toast } from '$lib/toast-state.svelte'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  load_i18n_module('structure')

  // Supported export formats: serializer + the default filename used when the
  // user hasn't typed one. All serializers are synchronous and take the
  // structure directly.
  type FmtKey = 'poscar' | 'cif' | 'xyz' | 'extxyz' | 'pdb' | 'json'
  const FORMATS: Record<FmtKey, { label: string; default_name: string; serialize: (s: AnyStructure) => string }> = {
    poscar: { label: 'POSCAR / VASP', default_name: 'POSCAR', serialize: (s) => structure_to_poscar_str(s) },
    cif: { label: 'CIF', default_name: 'structure.cif', serialize: (s) => structure_to_cif_str(s) },
    xyz: { label: 'XYZ', default_name: 'structure.xyz', serialize: (s) => structure_to_xyz_str(s) },
    extxyz: { label: 'Extended XYZ', default_name: 'structure.extxyz', serialize: (s) => structure_to_extxyz_str(s) },
    pdb: { label: 'PDB', default_name: 'structure.pdb', serialize: (s) => structure_to_pdb_str(s) },
    json: { label: 'JSON (pymatgen)', default_name: 'structure.json', serialize: (s) => structure_to_json_str(s) },
  }

  let {
    show = $bindable(false),
    structure = undefined,
  }: {
    show?: boolean
    structure?: AnyStructure
  } = $props()

  let session_id = $state('')
  let current_path = $state('~')
  // Editable mirror of current_path for the address bar (paste / type / Enter).
  let path_input = $state('~')
  $effect(() => { path_input = current_path })
  let entries = $state<RemoteFile[]>([])
  let listing = $state(false)
  let list_error = $state('')
  let filename = $state('POSCAR')
  let format = $state<FmtKey>('poscar')
  let uploading = $state(false)
  let progress = $state<number | null>(null)
  let upload_error = $state('')

  // Sessions to choose from (exclude the local pseudo-session — uploading to
  // "local" is not a remote upload).
  let sessions = $derived(
    hpc_session_store.sessions.filter((s) => s.session_id !== LOCAL_SESSION_ID),
  )

  // On open: refresh sessions and default to the first one + its work root.
  $effect(() => {
    if (!show) return
    refresh_hpc_sessions()
  })
  $effect(() => {
    if (!show || session_id) return
    const first = sessions[0]
    if (first) {
      session_id = first.session_id
      current_path = first.work_root || '~'
    }
  })

  // (Re)list whenever the session or path changes while open.
  $effect(() => {
    if (!show || !session_id) return
    void browse(current_path)
  })

  async function browse(path: string) {
    listing = true
    list_error = ''
    try {
      const res = await listFiles(session_id, path)
      if (res.success) {
        current_path = res.current_path || path
        entries = res.files.filter((f) => f.is_dir) // directory picker: dirs only
      } else {
        list_error = res.message || t('structure.list_failed')
        entries = []
      }
    } catch (e) {
      list_error = e instanceof Error ? e.message : String(e)
      entries = []
    } finally {
      listing = false
    }
  }

  function go_up() {
    const p = current_path.replace(/\/+$/, '')
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) || '/' : '~'
    current_path = parent
  }

  async function do_upload() {
    if (!session_id || !structure) return
    const name = filename.trim()
    if (!name) { show_toast({ message: t('structure.enter_filename'), variant: 'warning' }); return }

    let content: string
    try {
      content = FORMATS[format].serialize(structure)
    } catch (e) {
      upload_error = e instanceof Error ? e.message : String(e)
      return
    }
    // Write the serialized text via /hpc/files/write-content (JSON), not the
    // multipart /hpc/upload endpoint — the latter is rejected (403) by the
    // bundled sidecar, and the structure is plain text anyway.
    const dir = current_path.replace(/\/+$/, '')
    const target_path = `${dir}/${name}`

    uploading = true
    progress = null
    upload_error = ''
    try {
      const res = await writeRemoteFile(session_id, target_path, content)
      if (res.success) {
        show_toast({ message: t('structure.saved_to_hpc', { name }), variant: 'success', duration: 4000 })
        show = false
      } else {
        // Keep the backend message inline (persistent) — it explains work-root
        // restrictions etc. precisely; a toast vanishes before it can be read.
        upload_error = res.message || t('structure.upload_failed', { error: '' })
      }
    } catch (e) {
      upload_error = e instanceof Error ? e.message : String(e)
    } finally {
      uploading = false
      progress = null
    }
  }

  function close() { show = false }
</script>

{#if show}
  <div
    class="hpc-upload-overlay"
    role="button"
    tabindex="-1"
    onclick={(e) => { if (e.target === e.currentTarget) close() }}
    onkeydown={(e) => { if (e.key === 'Escape') close() }}
  >
    <div class="hpc-upload-dialog">
      <header>
        <h3>{t('structure.upload_to_hpc')}</h3>
        <button type="button" class="close-x" onclick={close} aria-label={t('common.close')}>✕</button>
      </header>

      {#if sessions.length === 0}
        <p class="hint">{t('structure.no_hpc_connected')}</p>
      {:else}
        <!-- 1. Session -->
        <label class="field">
          <span>{t('structure.hpc_session')}</span>
          <select bind:value={session_id} onchange={() => {
            const s = sessions.find((x) => x.session_id === session_id)
            current_path = s?.work_root || '~'
          }}>
            {#each sessions as s}
              <option value={s.session_id}>{s.username}@{s.host}</option>
            {/each}
          </select>
        </label>

        <!-- 2. Directory browser -->
        <div class="field">
          <span>{t('structure.target_directory')}</span>
          <div class="path-bar">
            <button type="button" onclick={go_up} title={t('structure.parent_directory')}>↑</button>
            <input
              type="text"
              class="cur-path"
              bind:value={path_input}
              placeholder="~/path/to/dir"
              spellcheck="false"
              onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); current_path = path_input.trim() || '~' } }}
            />
            <button type="button" onclick={() => { current_path = path_input.trim() || '~' }} title={t('structure.go')}>→</button>
          </div>
          <div class="dir-list">
            {#if listing}
              <div class="dir-row muted">{t('structure.loading')}…</div>
            {:else if list_error}
              <div class="dir-row error">{list_error}</div>
            {:else if entries.length === 0}
              <div class="dir-row muted">{t('structure.no_subdirectories')}</div>
            {:else}
              {#each entries as d}
                <button type="button" class="dir-row" onclick={() => { current_path = d.path }}>📁 {d.name}</button>
              {/each}
            {/if}
          </div>
        </div>

        <!-- 3. Format + filename -->
        <div class="field row">
          <label>
            <span>{t('structure.format')}</span>
            <select bind:value={format} onchange={() => { filename = FORMATS[format].default_name }}>
              {#each Object.entries(FORMATS) as [key, f]}
                <option value={key}>{f.label}</option>
              {/each}
            </select>
          </label>
          <label class="grow">
            <span>{t('structure.filename')}</span>
            <input type="text" bind:value={filename} placeholder={FORMATS[format].default_name} />
          </label>
        </div>

        {#if progress != null}
          <div class="progress"><div class="progress-fill" style="width:{progress}%"></div></div>
        {/if}
        {#if upload_error}
          <div class="upload-err">{upload_error}</div>
        {/if}

        <!-- 4. Upload -->
        <footer>
          <button type="button" class="ghost" onclick={close}>{t('common.cancel')}</button>
          <button type="button" class="primary" onclick={do_upload} disabled={uploading || !structure}>
            {uploading ? t('structure.uploading') : t('structure.upload')}
          </button>
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .hpc-upload-overlay {
    position: fixed; inset: 0; z-index: 2000;
    background: rgba(0, 0, 0, 0.45);
    display: flex; align-items: center; justify-content: center;
  }
  .hpc-upload-dialog {
    width: 460px; max-width: 92vw; max-height: 86vh; overflow: auto;
    background: var(--surface-bg, #1e1e1e); color: var(--text-color, #ddd);
    border: 1px solid var(--border-color, #444); border-radius: 8px;
    padding: 14px 16px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
    display: flex; flex-direction: column; gap: 10px;
  }
  header { display: flex; align-items: center; justify-content: space-between; }
  header h3 { margin: 0; font-size: 1.05em; }
  .close-x { background: none; border: none; color: inherit; cursor: pointer; font-size: 1.1em; }
  .hint, .muted { color: var(--text-color-dim, #888); }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .field > span { font-size: 0.85em; color: var(--text-color-dim, #999); }
  .field.row { flex-direction: row; gap: 10px; align-items: flex-end; }
  .field.row .grow { flex: 1; }
  .field.row label { display: flex; flex-direction: column; gap: 4px; }
  select, input[type='text'] {
    padding: 5px 7px; background: var(--input-bg, #2a2a2a);
    color: inherit; border: 1px solid var(--border-color, #444); border-radius: 4px;
  }
  .path-bar { display: flex; gap: 6px; align-items: center; }
  .path-bar button { padding: 3px 8px; border: 1px solid var(--border-color, #444); background: var(--input-bg, #2a2a2a); color: inherit; border-radius: 4px; cursor: pointer; }
  .cur-path { flex: 1; min-width: 0; font-size: 0.85em; font-family: monospace; background: var(--input-bg, #2a2a2a); padding: 4px 6px; border-radius: 4px; }
  .dir-list { max-height: 180px; overflow: auto; border: 1px solid var(--border-color, #444); border-radius: 4px; }
  .dir-row { display: block; width: 100%; text-align: left; padding: 5px 8px; background: none; border: none; color: inherit; cursor: pointer; font-size: 0.88em; }
  .dir-row:hover { background: var(--hover-bg, rgba(255, 255, 255, 0.06)); }
  .dir-row.error { color: #e57373; cursor: default; }
  .upload-err { color: #e57373; font-size: 0.85em; background: rgba(229, 115, 115, 0.1); padding: 6px 8px; border-radius: 4px; word-break: break-word; }
  .progress { height: 6px; background: var(--input-bg, #2a2a2a); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent-color, #2196f3); transition: width 0.15s; }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  footer .primary { background: var(--accent-color, #2196f3); color: #fff; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; }
  footer .primary:disabled { opacity: 0.5; cursor: not-allowed; }
  footer .ghost { background: none; border: 1px solid var(--border-color, #444); color: inherit; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
</style>

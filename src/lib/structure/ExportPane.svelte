<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { DraggablePane, Icon } from '$lib'
  import { export_canvas_as_image, export_canvas_as_png, export_trajectory_png_sequence, parse_frame_spec, type CropRegion, type ImageExportFormat } from '$lib/io/export'
  import * as exports from '$lib/structure/export'
  import MonacoEditorPanel from '$lib/structure/MonacoEditorPanel.svelte'
  import type { ComponentProps } from 'svelte'
  import { tooltip } from 'svelte-multiselect/attachments'
  import type { Camera, Scene } from 'three'
  import {
    get_unique_elements, get_constrained_atoms_info,
    download_file,
  } from '$lib/structure/export/common-export'
  import {
    structure_to_poscar, structure_to_xyz,
    type StructureData,
  } from '$lib/structure/export/offline-serialize'
  import { t, load_i18n_module } from '$lib/i18n/index.svelte'

  // Lazy-load structure translations
  load_i18n_module('structure')

  // Sub-components
  import QeExport from '$lib/structure/export/QeExport.svelte'
  import VaspExport from '$lib/structure/export/VaspExport.svelte'
  import LammpsExport from '$lib/structure/export/LammpsExport.svelte'
  import Cp2kExport from '$lib/structure/export/Cp2kExport.svelte'
  import GaussianExport from '$lib/structure/export/GaussianExport.svelte'
  import GromacsExport from '$lib/structure/export/GromacsExport.svelte'
  import OrcaExport from '$lib/structure/export/OrcaExport.svelte'
  import AbacusExport from '$lib/structure/export/AbacusExport.svelte'
  import AmberExport from '$lib/structure/export/AmberExport.svelte'
  import SparkExport from '$lib/structure/export/SparkExport.svelte'
  import CatRenderParamsPane from '$lib/structure/catrender/CatRenderParamsPane.svelte'
  import CatRenderViewPane from '$lib/structure/catrender/CatRenderViewPane.svelte'

  let {
    export_pane_open = $bindable(false),
    embedded = false,
    structure = undefined,
    wrapper = undefined,
    scene = undefined,
    camera = undefined,
    png_dpi = $bindable(150),
    crop_mode_active = $bindable(false),
    crop_region = $bindable<CropRegion | null>(null),
    pane_props = {},
    toggle_props = {},
    selected_indices = [],
    on_request_vacuum_box = undefined,
    trajectory_context,
    ...rest
  }: {
    export_pane_open?: boolean
    embedded?: boolean
    structure?: AnyStructure
    wrapper?: HTMLDivElement
    scene?: Scene
    camera?: Camera
    png_dpi?: number
    crop_mode_active?: boolean
    crop_region?: CropRegion | null
    pane_props?: ComponentProps<typeof DraggablePane>[`pane_props`]
    toggle_props?: ComponentProps<typeof DraggablePane>[`toggle_props`]
    selected_indices?: number[]
    on_request_vacuum_box?: () => void
    trajectory_context?: { total_frames: number; on_step: (idx: number) => void | Promise<void> }
  } = $props()

  // Active section tab
  let active_section = $state<'structure' | 'figure' | 'qe' | 'lammps' | 'vasp' | 'cp2k' | 'gaussian' | 'gromacs' | 'orca' | 'abacus' | 'amber' | 'spark' | 'catrender'>('structure')

  // RT13: catrender is now TWO independent floating DraggablePanes (Params +
  // View) so the preview is never buried under the 17 knobs. The "Render"
  // tab opens BOTH (mirrors the established bind:show DraggablePane pattern
  // used by AnalysisPane et al.); they are then independently movable.
  let catrender_params_open = $state(false)
  let catrender_view_open = $state(false)
  function open_catrender() {
    catrender_params_open = true
    catrender_view_open = true
  }

  // Multi-frame export state
  let frame_spec = $state(``)
  let seq_exporting = $state(false)
  let seq_progress = $state(0)
  // Initialize frame_spec to "1-N" when trajectory context becomes available
  $effect(() => {
    if (trajectory_context) frame_spec = `1-${trajectory_context.total_frames}`
  })
  let parsed_frames = $derived(
    trajectory_context ? parse_frame_spec(frame_spec, trajectory_context.total_frames) : []
  )

  // Image export format
  let image_format = $state<ImageExportFormat>(`png`)

  // Copy button feedback state
  let copy_status = $state<Record<string, boolean>>({})

  const text_export_formats = [
    { label: `JSON`, format: `json` },
    { label: `XYZ`, format: `xyz` },
    { label: `CIF`, format: `cif` },
    { label: `POSCAR`, format: `poscar` },
    { label: `MOL2`, format: `mol2` },
    { label: `PDB`, format: `pdb` },
  ] as const

  const model_3d_formats = [
    { label: `GLB`, format: `glb`, hint: `Binary GLTF for 3D apps` },
    { label: `OBJ`, format: `obj`, hint: `Wavefront Object format` },
  ] as const

  // ====== Common State ======
  let prefix = $state('calc')
  let generated_output = $state<Record<string, string>>({})
  let generation_error = $state<string | null>(null)
  let active_file = $state('')

  // ====== Shared constraint state ======
  let fix_mode = $state<'none' | 'selected' | 'z_below'>('none')
  let fix_z_threshold = $state(5.0)

  // Get unique elements - delegates to common-export
  let unique_elements = $derived.by(() => structure ? get_unique_elements(structure) : [])

  // Constrained atoms from structure - delegates to common-export
  let constrained_atoms_info = $derived.by(() => structure ? get_constrained_atoms_info(structure) : { count: 0, details: [] as { idx: number; element: string; constraint: [boolean, boolean, boolean] }[] })

  // ====== Monaco Editor State ======
  let monaco_container: HTMLDivElement | undefined = $state()
  let monaco_editor: any = null
  let monaco_module: any = null
  let setting_value = false // guard to prevent onDidChangeModelContent during setValue

  function get_editor_language(name: string): string {
    const ext = name.split(`.`).pop()?.toLowerCase() || ``
    const map: Record<string, string> = {
      py: `python`, sh: `shell`, bash: `shell`, zsh: `shell`,
      json: `json`, yaml: `yaml`, yml: `yaml`, toml: `toml`,
      js: `javascript`, ts: `typescript`, html: `html`, css: `css`,
      md: `markdown`, xml: `xml`, sql: `sql`, r: `r`,
      c: `c`, cpp: `cpp`, h: `c`, hpp: `cpp`,
      f90: `fortran`, f: `fortran`, f77: `fortran`,
      rs: `rust`, go: `go`, java: `java`,
      txt: `plaintext`, log: `plaintext`, out: `plaintext`,
      cif: `plaintext`, poscar: `plaintext`, vasp: `plaintext`,
      contcar: `plaintext`, incar: `plaintext`, kpoints: `plaintext`,
      potcar: `plaintext`, inp: `plaintext`, pwi: `plaintext`,
      in: `plaintext`, data: `plaintext`,
      mdp: `plaintext`, gro: `plaintext`, top: `plaintext`,
      gjf: `plaintext`, com: `plaintext`,
    }
    const base = name.toUpperCase()
    if ([`INCAR`, `POSCAR`, `CONTCAR`, `KPOINTS`, `POTCAR`, `OUTCAR`, `ICONST`].includes(base)) {
      return `plaintext`
    }
    return map[ext] || `plaintext`
  }

  // Initialize Monaco editor when container mounts
  $effect(() => {
    if (!monaco_container) return
    let disposed = false

    async function init() {
      const monaco = await import(`monaco-editor`)
      if (disposed) return
      monaco_module = monaco

      // @ts-ignore
      self.MonacoEnvironment = {
        getWorker(_: string, _label: string) {
          return new Worker(
            new URL(`monaco-editor/esm/vs/editor/editor.worker.js`, import.meta.url),
            { type: `module` },
          )
        },
      }

      const editor = monaco.editor.create(monaco_container!, {
        value: generated_output[active_file] || ``,
        language: get_editor_language(active_file),
        theme: `vs-dark`,
        automaticLayout: true,
        fontSize: 12,
        fontFamily: `'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace`,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: `on`,
        readOnly: false,
        tabSize: 2,
        lineNumbers: `on`,
        folding: true,
        renderWhitespace: `selection`,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      })
      if (disposed) { editor.dispose(); return }
      monaco_editor = editor

      editor.onDidChangeModelContent(() => {
        if (setting_value) return
        if (active_file) {
          generated_output[active_file] = editor.getValue()
        }
      })
    }

    init()

    return () => {
      disposed = true
      monaco_editor?.dispose()
      monaco_editor = null
      monaco_module = null
    }
  })

  // Sync editor content when active_file or generated_output changes
  $effect(() => {
    const content = generated_output[active_file] || ``
    const file = active_file
    if (!monaco_editor || !monaco_module || !file) return
    // Skip if content matches what's already in the editor (avoids cursor reset on user typing)
    if (monaco_editor.getValue() === content) {
      // Still update language in case file tab changed to a same-content file
      const lang = get_editor_language(file)
      monaco_module.editor.setModelLanguage(monaco_editor.getModel(), lang)
      return
    }
    setting_value = true
    monaco_editor.setValue(content)
    const lang = get_editor_language(file)
    monaco_module.editor.setModelLanguage(monaco_editor.getModel(), lang)
    setting_value = false
  })

  // Canvas check
  let has_canvas = $state(false)
  $effect(() => {
    if (!wrapper) { has_canvas = false; return }
    const check = () => (has_canvas = Boolean(wrapper.querySelector(`canvas`)))
    check()
    const observer = new MutationObserver(check)
    observer.observe(wrapper, { childList: true, subtree: true })
    return () => observer.disconnect()
  })

  // Structure export functions
  function export_structure(format: `json` | `xyz` | `cif` | `poscar` | `mol2` | `pdb`) {
    if (!structure) return
    const fns = {
      json: exports.export_structure_as_json,
      xyz: exports.export_structure_as_xyz,
      cif: exports.export_structure_as_cif,
      poscar: exports.export_structure_as_poscar,
      mol2: exports.export_structure_as_mol2,
      pdb: exports.export_structure_as_pdb,
    } as const
    fns[format](structure)
  }

  async function handle_copy(format: string, content?: string) {
    if (!content && !structure) return
    try {
      let text = content
      if (!text) {
        if (format === 'json') text = exports.structure_to_json_str(structure!)
        else if (format === 'xyz') text = exports.structure_to_xyz_str(structure!)
        else if (format === 'cif') text = exports.structure_to_cif_str(structure!)
        else if (format === 'poscar') text = exports.structure_to_poscar_str(structure!)
        else if (format === 'mol2') text = exports.structure_to_mol2_str(structure!)
        else if (format === 'pdb') text = exports.structure_to_pdb_str(structure!)
      }
      if (text) await navigator.clipboard.writeText(text)
      copy_status[format] = true
      setTimeout(() => { copy_status[format] = false }, 1000)
    } catch (e) { console.error(`Copy failed`, e) }
  }

  function handle_3d_export(format: `glb` | `obj`) {
    if (!scene) return
    if (format === 'glb') exports.export_structure_as_glb(scene, structure)
    else exports.export_structure_as_obj(scene, structure)
  }

  function download_all() {
    for (const [f, c] of Object.entries(generated_output)) download_file(c, f)
  }

  // Quick offline export — no backend needed
  function quick_export_poscar() {
    if (!structure) return
    try {
      const text = structure_to_poscar(structure as unknown as StructureData)
      const name = (structure as any)?.formula || (structure as any)?.id || `structure`
      download_file(text, `${name}_POSCAR`)
    } catch (e) {
      console.error(`[ExportPane] Offline POSCAR export failed:`, e)
    }
  }

  function quick_export_xyz() {
    if (!structure) return
    try {
      const text = structure_to_xyz(structure as unknown as StructureData)
      const name = (structure as any)?.formula || (structure as any)?.id || `structure`
      download_file(text, `${name}.xyz`)
    } catch (e) {
      console.error(`[ExportPane] Offline XYZ export failed:`, e)
    }
  }

  const has_lattice = $derived(
    structure && `lattice` in (structure as any) && !!(structure as any)?.lattice
  )

  // Reset output on section change
  $effect(() => {
    active_section
    generated_output = {}
    generation_error = null
    active_file = ''
  })

  let output_files = $derived(Object.keys(generated_output))
</script>

{#snippet export_content()}
  <!-- Section tabs -->
  <div class="section-tabs">
    <button class:active={active_section === 'structure'} onclick={() => active_section = 'structure'}>{t('structure.structure_tab')}</button>
    <button class:active={active_section === 'figure'} onclick={() => active_section = 'figure'}>{t('structure.figure')}</button>
    <button class:active={active_section === 'qe'} onclick={() => active_section = 'qe'}>QE</button>
    <button class:active={active_section === 'lammps'} onclick={() => active_section = 'lammps'}>LAMMPS</button>
    <button class:active={active_section === 'vasp'} onclick={() => active_section = 'vasp'}>VASP</button>
    <button class:active={active_section === 'cp2k'} onclick={() => active_section = 'cp2k'}>CP2K</button>
    <button class:active={active_section === 'gaussian'} onclick={() => active_section = 'gaussian'}>Gaussian</button>
    <button class:active={active_section === 'gromacs'} onclick={() => active_section = 'gromacs'}>GROMACS</button>
    <button class:active={active_section === 'orca'} onclick={() => active_section = 'orca'}>ORCA</button>
    <button class:active={active_section === 'abacus'} onclick={() => active_section = 'abacus'}>ABACUS</button>
    <button class:active={active_section === 'amber'} onclick={() => active_section = 'amber'}>AMBER</button>
    <button class:active={active_section === 'spark'} onclick={() => active_section = 'spark'}>SPARK</button>
    <button class:active={active_section === 'catrender'} onclick={() => { active_section = 'catrender'; open_catrender() }}>Render</button>
  </div>

  {#if active_section === 'structure'}
    <!-- Structure text formats -->
    <div class="section-content">
      <label class="section-label">{t('structure.text_formats')}</label>
      <div class="export-buttons">
        {#each text_export_formats as { label, format }}
          <div class="export-item">
            <span>{label}</span>
            <button onclick={() => export_structure(format)} title={t('common.download')}>⬇</button>
            <button onclick={() => handle_copy(format)} title={t('common.copy')}>{copy_status[format] ? '✓' : '📋'}</button>
          </div>
        {/each}
      </div>

      <!-- Quick offline export — no backend needed -->
      <label class="section-label" style="margin-top: 0.8em">{t('structure.quick_export')}</label>
      <div class="export-buttons">
        {#if has_lattice}
          <button class="quick-export-btn" onclick={quick_export_poscar}>POSCAR</button>
        {/if}
        <button class="quick-export-btn" onclick={quick_export_xyz}>XYZ</button>
      </div>
      <div class="quick-export-hint">{t('structure.no_backend_required')}</div>
    </div>

  {:else if active_section === 'figure'}
    <!-- Image and 3D exports -->
    <div class="section-content">
      <label class="section-label">{t('structure.image')}</label>
      <div class="export-buttons">
        <div class="export-item" style="flex: 1">
          <select bind:value={image_format} style="width: 5em; padding: 2px 4px; font-size: 0.85em; border-radius: 3px; border: 1px solid var(--border-color); background: var(--bg-color); color: inherit">
            <option value="png">PNG</option>
            <option value="jpg">JPG</option>
            <option value="tiff">TIFF</option>
            <option value="svg">SVG</option>
            <option value="pdf">PDF</option>
          </select>
          <button disabled={!has_canvas} onclick={() => {
            const canvas = wrapper?.querySelector('canvas') as HTMLCanvasElement
            if (canvas) export_canvas_as_image(canvas, structure, image_format, png_dpi, scene, camera, crop_region)
          }}>⬇</button>
          {#if image_format === 'svg' || image_format === 'pdf'}
            <span class="dpi-input" title="Controls the pixel resolution of the embedded raster image. The {image_format.toUpperCase()} container itself is resolution-independent.">{t('structure.raster_dpi')}<input type="number" min={72} max={600} bind:value={png_dpi} /></span>
          {:else}
            <span class="dpi-input">{t('structure.dpi')}<input type="number" min={50} max={500} bind:value={png_dpi} /></span>
          {/if}
        </div>
      </div>

      <!-- Crop controls -->
      <div class="crop-controls">
        <button
          class="crop-toggle"
          class:active={crop_mode_active}
          onclick={() => {
            crop_mode_active = !crop_mode_active
            if (!crop_mode_active) crop_region = null
          }}
        >
          {crop_mode_active ? t('structure.cancel_crop') : t('structure.crop_region')}
        </button>
        {#if crop_region}
          <span class="crop-info">
            {Math.round(crop_region.width)} x {Math.round(crop_region.height)} px
          </span>
          <button class="crop-clear" onclick={() => (crop_region = null)}>{t('common.clear')}</button>
        {:else if crop_mode_active}
          <span class="crop-hint">{t('structure.crop_hint')}</span>
        {/if}
      </div>

      {#if trajectory_context && trajectory_context.total_frames > 1}
        <label class="section-label" style="margin-top: 0.8em">{t('structure.multi_frame_export')}</label>
        <div class="frame-spec-row">
          <input
            type="text"
            class="frame-spec-input"
            bind:value={frame_spec}
            placeholder={t('structure.frame_spec_placeholder')}
            disabled={seq_exporting}
          />
          <span class="frame-count">{t('common.frames_count', { n: parsed_frames.length })}</span>
        </div>
        <div class="frame-spec-hint">{t('structure.frame_spec_hint', { total: trajectory_context.total_frames })}</div>
        <div class="export-buttons" style="margin-top: 4px">
          <div class="export-item" style="flex: 1">
            <span>{t('structure.png_sequence')}</span>
            <button
              disabled={!has_canvas || seq_exporting || parsed_frames.length === 0}
              onclick={async () => {
                const canvas = wrapper?.querySelector('canvas') as HTMLCanvasElement
                if (!canvas || !trajectory_context || parsed_frames.length === 0) return
                seq_exporting = true
                seq_progress = 0
                try {
                  const name = typeof structure === 'object' && structure && 'formula' in structure
                    ? (structure as any).formula || 'trajectory'
                    : 'trajectory'
                  await export_trajectory_png_sequence(canvas, name, {
                    frame_indices: parsed_frames,
                    png_dpi,
                    crop_region,
                    scene: scene ?? null,
                    camera: camera ?? null,
                    on_step: async (idx) => { await trajectory_context.on_step(idx) },
                    on_progress: (p) => { seq_progress = p },
                  })
                } finally {
                  seq_exporting = false
                }
              }}
            >
              {#if seq_exporting}
                {Math.round(seq_progress)}%
              {:else}
                {t('structure.zip')}
              {/if}
            </button>
          </div>
        </div>
        {#if seq_exporting}
          <div class="progress-bar">
            <div class="progress-fill" style="width: {seq_progress}%"></div>
          </div>
        {/if}
      {/if}

      <label class="section-label" style="margin-top: 0.8em">{t('structure.model_3d')}</label>
      <div class="export-buttons">
        {#each model_3d_formats as { label, format, hint }}
          <div class="export-item">
            <span>{label}</span>
            <button disabled={!scene} onclick={() => handle_3d_export(format)} {@attach tooltip({ content: hint })}>⬇</button>
          </div>
        {/each}
      </div>
    </div>

  {:else if active_section === 'qe'}
    <QeExport
      {structure}
      bind:prefix
      {selected_indices}
      {unique_elements}
      {constrained_atoms_info}
      bind:fix_mode
      bind:fix_z_threshold
      bind:generated_output
      bind:generation_error
      bind:active_file
    />

  {:else if active_section === 'lammps'}
    <LammpsExport
      {structure}
      bind:prefix
      {selected_indices}
      {unique_elements}
      {constrained_atoms_info}
      bind:fix_mode
      bind:fix_z_threshold
      bind:generated_output
      bind:generation_error
      bind:active_file
    />

  {:else if active_section === 'vasp'}
    <VaspExport
      {structure}
      {selected_indices}
      {unique_elements}
      bind:generated_output
      bind:generation_error
      bind:active_file
      {on_request_vacuum_box}
    />

  {:else if active_section === 'cp2k'}
    <Cp2kExport
      {structure}
      bind:prefix
      {selected_indices}
      {unique_elements}
      {constrained_atoms_info}
      bind:fix_mode
      bind:fix_z_threshold
      bind:generated_output
      bind:generation_error
      bind:active_file
      {on_request_vacuum_box}
    />

  {:else if active_section === 'gaussian'}
    <GaussianExport
      {structure}
      bind:prefix
      bind:generated_output
      bind:generation_error
      bind:active_file
    />

  {:else if active_section === 'gromacs'}
    <GromacsExport
      {structure}
      bind:prefix
      bind:generated_output
      bind:generation_error
      bind:active_file
    />

  {:else if active_section === 'orca'}
    <OrcaExport
      {structure}
      {selected_indices}
      bind:generated_output
      bind:generation_error
      bind:active_file
    />

  {:else if active_section === 'abacus'}
    <AbacusExport
      {structure}
      bind:prefix
      {selected_indices}
      {unique_elements}
      {constrained_atoms_info}
      bind:fix_mode
      bind:fix_z_threshold
      bind:generated_output
      bind:generation_error
      bind:active_file
      {on_request_vacuum_box}
    />

  {:else if active_section === 'amber'}
    <AmberExport
      {structure}
      bind:prefix
      bind:generated_output
      bind:generation_error
      bind:active_file
    />

  {:else if active_section === 'spark'}
    <SparkExport
      {structure}
      bind:prefix
      bind:generated_output
      bind:generation_error
      bind:active_file
    />

  {:else if active_section === 'catrender'}
    <div class="catrender-launcher">
      <p>
        The renderer opens as two independent, draggable windows so the
        preview is never buried under the parameter knobs.
      </p>
      <div class="catrender-launcher-btns">
        <button onclick={() => (catrender_params_open = !catrender_params_open)}>
          {catrender_params_open ? `Hide` : `Show`} Parameters
        </button>
        <button onclick={() => (catrender_view_open = !catrender_view_open)}>
          {catrender_view_open ? `Hide` : `Show`} View
        </button>
        <button onclick={open_catrender}>Open both</button>
      </div>
    </div>
  {/if}

  <!-- Generated output preview -->
  {#if output_files.length > 0}
    <div class="preview-section">
      <div class="file-tabs">
        {#each output_files as f}
          <button class:active={active_file === f} onclick={() => active_file = f}>{f}</button>
        {/each}
      </div>
      <div class="preview-actions">
        <button onclick={() => handle_copy(active_file, generated_output[active_file])}>{copy_status[active_file] ? '✓' : t('common.copy')}</button>
        <button onclick={() => download_file(generated_output[active_file], active_file)}>{t('common.download')}</button>
        {#if output_files.length > 1}
          <button onclick={download_all}>{t('common.all')}</button>
        {/if}
      </div>
      <div class="monaco-preview" bind:this={monaco_container}></div>
    </div>
  {/if}

  {#if generation_error}
    <p class="error">{generation_error}</p>
  {/if}
{/snippet}

{#if embedded}
  <div class="export-pane export-embedded">
    {@render export_content()}
  </div>
{:else}
  <DraggablePane
    bind:show={export_pane_open}
    open_icon="Cross"
    closed_icon="Download"
    pane_props={{ ...pane_props, class: `export-pane ${pane_props?.class ?? ``}` }}
    toggle_props={{ title: export_pane_open ? `` : t('common.export'), ...toggle_props }}
    max_width="none"
    {...rest}
  >
    <h4>{t('common.export')}</h4>
    {@render export_content()}
  </DraggablePane>
{/if}

<!-- RT13: the two independent catrender DraggablePanes. Mounted at the
     component root (NOT inside ExportPane's own pane) so each floats and
     drags independently and the View pane's drag-rotate surface is not an
     ExportPane descendant. Each has its own bind:show toggled by the Render
     tab — the established DraggablePane open pattern (cf. AnalysisPane). -->
<CatRenderParamsPane bind:show={catrender_params_open} />
<CatRenderViewPane bind:show={catrender_view_open} {structure} />

<style>
  .export-embedded {
    font-size: 0.9em;
  }
  .catrender-launcher { font-size: 0.9em; padding: 4px 2px; }
  .catrender-launcher p { color: #666; margin: 0 0 8px; }
  .catrender-launcher-btns { display: flex; flex-wrap: wrap; gap: 8px; }
  .section-tabs {
    display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 0.8em;
    border-bottom: 1px solid var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); padding-bottom: 0.5em;
  }
  .section-tabs button {
    padding: 5px 12px; background: light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.05)); border: none;
    border-radius: 4px; cursor: pointer; font-size: 0.9em;
  }
  .section-tabs button.active { background: var(--accent-color, #007acc); color: white; }
  .export-buttons { display: flex; flex-wrap: wrap; gap: 10px; }
  .export-item { display: flex; align-items: center; gap: 4px; }
  .export-item button { width: 1.8em; height: 1.5em; padding: 0; }
  .dpi-input { display: flex; align-items: center; gap: 2px; }
  .dpi-input input { width: 50px; }
  .preview-section { margin-top: 0.8em; border-top: 1px solid var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); padding-top: 0.6em; }
  .file-tabs { display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 0.4em; }
  .file-tabs button { padding: 3px 8px; background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); border: none; border-radius: 3px; cursor: pointer; font-size: 0.85em; font-family: monospace; }
  .file-tabs button.active { background: var(--btn-bg-hover, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.2))); }
  .preview-actions { display: flex; gap: 6px; margin-bottom: 0.4em; }
  .preview-actions button { padding: 3px 8px; background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); border: none; border-radius: 3px; cursor: pointer; }
  .preview-actions button:hover { background: var(--btn-bg-hover, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.2))); }
  .monaco-preview { width: 100%; height: 240px; border: 1px solid var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); border-radius: 4px; overflow: hidden; }
  .crop-controls { display: flex; align-items: center; gap: 6px; margin-top: 0.5em; flex-wrap: wrap; }
  .crop-toggle { padding: 3px 8px; font-size: 0.85em; border: 1px solid var(--border-color); border-radius: 3px; background: transparent; cursor: pointer; color: inherit; }
  .crop-toggle:hover { background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); }
  .crop-toggle.active { background: rgba(255, 152, 0, 0.25); border-color: var(--warning-color); color: var(--warning-color); }
  .crop-info { font-size: 0.8em; opacity: 0.7; }
  .crop-clear { padding: 2px 6px; font-size: 0.8em; border: 1px solid var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); border-radius: 3px; background: transparent; cursor: pointer; color: inherit; opacity: 0.7; }
  .crop-clear:hover { opacity: 1; background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); }
  .crop-hint { font-size: 0.8em; opacity: 0.6; font-style: italic; }
  .frame-spec-row { display: flex; align-items: center; gap: 8px; }
  .frame-spec-input { flex: 1; font-size: 0.85em; padding: 3px 6px; font-family: monospace; }
  .frame-spec-hint { font-size: 0.75em; opacity: 0.5; margin-top: 2px; }
  .frame-count { font-size: 0.8em; opacity: 0.6; white-space: nowrap; }
  .progress-bar { height: 4px; background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); border-radius: 2px; margin-top: 4px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--accent-color, #3b82f6); transition: width 0.15s; border-radius: 2px; }
  .quick-export-btn {
    padding: 4px 12px; background: light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08));
    border: 1px solid light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.15));
    border-radius: 4px; cursor: pointer; font-size: 0.85em; color: inherit;
    transition: background 0.15s;
  }
  .quick-export-btn:hover { background: light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.15)); }
  .quick-export-hint { font-size: 0.75em; opacity: 0.5; margin-top: 3px; }
</style>

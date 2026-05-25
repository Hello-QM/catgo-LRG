<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { Icon } from '$lib'
  import { API_BASE } from '$lib/api/config'
  import { gen_qe_local as _gen_qe_local, gen_dos_input as _gen_dos_input } from '$lib/structure/export/qe-export'
  import type { FixAtomParams } from '$lib/structure/export/common-export'

  let {
    structure = undefined,
    prefix = $bindable('calc'),
    selected_indices = [],
    unique_elements = [],
    constrained_atoms_info = { count: 0, details: [] as { idx: number; element: string; constraint: [boolean, boolean, boolean] }[] },
    fix_mode = $bindable<'none' | 'selected' | 'z_below'>('none'),
    fix_z_threshold = $bindable(5.0),
    generated_output = $bindable<Record<string, string>>({}),
    generation_error = $bindable<string | null>(null),
    active_file = $bindable(''),
  }: {
    structure?: AnyStructure
    prefix?: string
    selected_indices?: number[]
    unique_elements?: string[]
    constrained_atoms_info?: FixAtomParams['constrained_atoms_info']
    fix_mode?: 'none' | 'selected' | 'z_below'
    fix_z_threshold?: number
    generated_output?: Record<string, string>
    generation_error?: string | null
    active_file?: string
  } = $props()

  // ====== QE Settings ======
  let qe_calculation = $state<'scf' | 'relax' | 'vc-relax' | 'nscf' | 'bands'>('scf')
  let qe_ecutwfc = $state(60)
  let qe_ecutrho = $state(480)
  let qe_kpoints_auto = $state(true)
  let qe_kpoints = $state<[number, number, number]>([4, 4, 4])
  let qe_kspacing = $state(0.04)
  let qe_degauss = $state(0.01)
  let qe_conv_thr = $state(1e-8)
  let qe_forc_conv_thr = $state(1e-4)
  let qe_press = $state(0)
  let qe_coord_type = $state<'crystal' | 'angstrom'>('crystal')
  let qe_pseudo_dir = $state('./')
  let qe_pseudopotentials = $state<Record<string, string>>({})
  let qe_disk_io = $state<'none' | 'low' | 'medium' | 'high'>('low')
  let qe_wf_collect = $state(false)
  let qe_tprnfor = $state(true)
  let qe_tstress = $state(true)
  let qe_dos_enabled = $state(false)
  let qe_dos_emin = $state(-10)
  let qe_dos_emax = $state(10)
  let qe_dos_deltae = $state(0.01)

  // Init pseudopotentials
  $effect(() => {
    for (const el of unique_elements) {
      if (!(el in qe_pseudopotentials)) qe_pseudopotentials[el] = ''
    }
  })

  function gen_qe_local(): string {
    if (!structure) return ''
    return _gen_qe_local(structure, {
      calculation: qe_calculation, prefix, ecutwfc: qe_ecutwfc, ecutrho: qe_ecutrho,
      kpoints_auto: qe_kpoints_auto, kpoints: qe_kpoints, kspacing: qe_kspacing,
      degauss: qe_degauss, conv_thr: qe_conv_thr, forc_conv_thr: qe_forc_conv_thr,
      press: qe_press, coord_type: qe_coord_type, pseudo_dir: qe_pseudo_dir,
      pseudopotentials: qe_pseudopotentials, disk_io: qe_disk_io, wf_collect: qe_wf_collect,
      tprnfor: qe_tprnfor, tstress: qe_tstress, unique_elements,
    }, { fix_mode, fix_z_threshold, selected_indices, constrained_atoms_info })
  }

  function gen_dos_input(): string {
    return _gen_dos_input({ prefix, emin: qe_dos_emin, emax: qe_dos_emax, deltae: qe_dos_deltae })
  }

  async function generate_qe() {
    if (!structure) { generation_error = 'No structure'; return }
    generation_error = null
    const pp_dict: Record<string, string> = {}
    for (const el of unique_elements) if (qe_pseudopotentials[el]) pp_dict[el] = qe_pseudopotentials[el]

    let fixed_indices: number[] | null = null, fixed_z_below: number | null = null
    if (fix_mode === 'selected' && selected_indices.length > 0) fixed_indices = [...selected_indices]
    else if (fix_mode === 'z_below') fixed_z_below = fix_z_threshold

    try {
      const res = await fetch(`${API_BASE}/qe/input`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structure, calculation: qe_calculation, prefix, ecutwfc: qe_ecutwfc, ecutrho: qe_ecutrho,
          kpoints: qe_kpoints_auto ? null : qe_kpoints, kspacing: qe_kspacing, degauss: qe_degauss,
          conv_thr: qe_conv_thr, forc_conv_thr: qe_forc_conv_thr, press: qe_press, coord_type: qe_coord_type,
          pseudo_dir: qe_pseudo_dir, pseudopotentials: Object.keys(pp_dict).length > 0 ? pp_dict : null,
          fixed_indices, fixed_z_below, disk_io: qe_disk_io, wf_collect: qe_wf_collect, tprnfor: qe_tprnfor, tstress: qe_tstress,
        }),
      })
      if (!res.ok) throw new Error(`Server: ${res.status}`)
      const r = await res.json()
      if (r.success) {
        generated_output = { [`${prefix}.in`]: r.input_file }
        if (qe_dos_enabled) generated_output[`${prefix}.dos.in`] = gen_dos_input()
        active_file = `${prefix}.in`
      }
    } catch (e) {
      // Backend unavailable or errored (network failure, non-OK status, or
      // {success:false}) — fall back to fully client-side generation so the web
      // build can still produce a QE input.
      try {
        const inp = gen_qe_local()
        generated_output = { [`${prefix}.in`]: inp }
        if (qe_dos_enabled) generated_output[`${prefix}.dos.in`] = gen_dos_input()
        active_file = `${prefix}.in`
      } catch (localErr) {
        generation_error = localErr instanceof Error ? localErr.message
          : (e instanceof Error ? e.message : 'Failed to generate QE input')
      }
    }
  }
</script>

<div class="section-content calc-section">
  <div class="param-row">
    <span>Prefix <span class="param-help" title="Output file prefix for QE calculation files">?</span></span>
    <input type="text" bind:value={prefix} class="text-input" />
  </div>
  <div class="param-row">
    <span>Calculation <span class="param-help" title="SCF: self-consistent field energy. Relax: ionic relaxation. VC-Relax: variable-cell relaxation. NSCF: non-self-consistent (for DOS/bands). Bands: band structure calculation">?</span></span>
    <select bind:value={qe_calculation} onchange={() => generated_output = {}}>
      <option value="scf">SCF</option>
      <option value="relax">Relax</option>
      <option value="vc-relax">VC-Relax</option>
      <option value="nscf">NSCF</option>
      <option value="bands">Bands</option>
    </select>
  </div>
  <div class="param-row">
    <span>ecutwfc (Ry) <span class="param-help" title="Kinetic energy cutoff for wavefunctions in Rydberg. Higher = more accurate but slower. 30-60 Ry typical for ultrasoft, 60-100 for PAW/NC">?</span></span>
    <input type="number" step="10" bind:value={qe_ecutwfc} />
  </div>
  <div class="param-row">
    <span>ecutrho (Ry) <span class="param-help" title="Kinetic energy cutoff for charge density. Default is 4*ecutwfc (ultrasoft) or 8-12*ecutwfc (PAW). Leave 0 for automatic">?</span></span>
    <input type="number" step="50" bind:value={qe_ecutrho} />
  </div>
  <div class="param-row">
    <span>K-points <span class="param-help" title="Monkhorst-Pack k-point grid for Brillouin zone sampling. Denser grids give more accurate results. Auto mode uses KSPACING-like heuristic">?</span></span>
    {#if qe_kpoints_auto}
      <label class="checkbox-inline"><input type="checkbox" bind:checked={qe_kpoints_auto} /> auto</label>
    {:else}
      <div class="kpoint-inputs">
        <input type="number" min="1" max="20" bind:value={qe_kpoints[0]} />
        <input type="number" min="1" max="20" bind:value={qe_kpoints[1]} />
        <input type="number" min="1" max="20" bind:value={qe_kpoints[2]} />
        <label><input type="checkbox" bind:checked={qe_kpoints_auto} /></label>
      </div>
    {/if}
  </div>

  <details class="advanced-details">
    <summary>Advanced</summary>
    <div class="param-row">
      <span>disk_io <span class="param-help" title="Controls disk I/O level. 'none' saves memory, 'high' writes wavefunctions to disk for restarts">?</span></span>
      <select bind:value={qe_disk_io}>
        <option value="none">none</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
      </select>
    </div>
    <label class="checkbox-row"><input type="checkbox" bind:checked={qe_wf_collect} /> wf_collect <span class="param-help" title="Collect wavefunctions from all processors into a single file. Required for post-processing">?</span></label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={qe_tprnfor} /> tprnfor <span class="param-help" title="Print forces acting on atoms in the output">?</span></label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={qe_tstress} /> tstress <span class="param-help" title="Print stress tensor in the output. Needed for vc-relax">?</span></label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={qe_dos_enabled} /> DOS input <span class="param-help" title="Generate a separate dos.x input file for density of states calculation">?</span></label>
    {#if qe_dos_enabled}
      <div class="param-row"><span>Emin</span><input type="number" bind:value={qe_dos_emin} /></div>
      <div class="param-row"><span>Emax</span><input type="number" bind:value={qe_dos_emax} /></div>
    {/if}
  </details>

  <details class="advanced-details">
    <summary>Pseudopotentials</summary>
    <div class="param-row"><span>pseudo_dir</span><input type="text" bind:value={qe_pseudo_dir} class="text-input" /></div>
    {#each unique_elements as el}
      <div class="param-row pp-row">
        <span class="el-label">{el}</span>
        <input type="text" bind:value={qe_pseudopotentials[el]} placeholder={`${el}.upf`} class="pp-input" />
      </div>
    {/each}
  </details>

  {#if qe_calculation === 'relax' || qe_calculation === 'vc-relax'}
    <details class="advanced-details">
      <summary>Fixed Atoms</summary>
      {#if constrained_atoms_info.count > 0}
        <span class="constraint-badge">{constrained_atoms_info.count} from structure</span>
      {/if}
      <div class="param-row">
        <span>Mode</span>
        <select bind:value={fix_mode}>
          <option value="none">None</option>
          <option value="selected" disabled={selected_indices.length === 0}>Selected ({selected_indices.length})</option>
          <option value="z_below">z &lt; threshold</option>
        </select>
      </div>
      {#if fix_mode === 'z_below'}
        <div class="param-row"><span>z (Ang)</span><input type="number" step="0.5" bind:value={fix_z_threshold} /></div>
      {/if}
    </details>
  {/if}

  <div class="button-group">
    <button class="generate-btn" onclick={generate_qe}>
      <Icon icon="Zap" style="width: 14px; height: 14px" /> Generate
    </button>
  </div>
</div>

<style>
  .calc-section { max-height: 400px; overflow-y: auto; }
  .param-row span { flex-shrink: 0; }
  .param-help {
    display: inline-flex; align-items: center; justify-content: center;
    width: 13px; height: 13px; font-size: 9px; font-weight: 700;
    border-radius: 50%; background: var(--btn-bg, light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.1)));
    color: var(--text-color-muted); cursor: help; flex-shrink: 0; margin-left: 2px;
    border: 1px solid var(--btn-bg, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.15)));
    line-height: 1; vertical-align: middle;
  }
  .param-help:hover { background: var(--btn-bg-hover, light-dark(rgba(0,0,0,0.15), rgba(255,255,255,0.2))); color: var(--text-color); }
  .param-row input[type="number"], .param-row input[type="text"], .param-row select { width: 100px; text-align: right; flex-shrink: 0; }
  .text-input { flex: 1 !important; width: auto !important; min-width: 60px; }
  .kpoint-inputs { display: flex; gap: 3px; align-items: center; }
  .kpoint-inputs input[type="number"] { width: 32px !important; text-align: center; }
  .checkbox-inline { display: flex; align-items: center; gap: 4px; }
  .pp-row { margin-bottom: 0.25em; }
  .el-label { width: 28px; font-weight: 500; }
  .pp-input { flex: 1 !important; width: auto !important; font-family: monospace; }
  .advanced-details { background: light-dark(rgba(0,0,0,0.02), rgba(255,255,255,0.02)); border-radius: 4px; padding: 0.4em; margin: 0.5em 0; }
  .constraint-badge { display: inline-block; background: rgba(59,130,246,0.3); color: var(--accent-color); font-size: 0.85em; padding: 2px 6px; border-radius: 8px; margin-bottom: 0.3em; }
  .button-group { margin-top: 0.6em; }
  .generate-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; background: var(--accent-color, #007acc); color: white; border: none; border-radius: 4px; cursor: pointer; }
  .generate-btn:hover { filter: brightness(1.1); }
</style>

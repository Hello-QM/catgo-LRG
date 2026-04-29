<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { Icon } from '$lib'
  import { gen_abacus_input } from '$lib/structure/export/abacus-export'
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
    on_request_vacuum_box = undefined,
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
    on_request_vacuum_box?: () => void
  } = $props()

  // ====== ABACUS Settings ======
  let abacus_calculation = $state<'scf' | 'relax' | 'cell-relax' | 'nscf' | 'md'>('scf')
  let abacus_basis_type = $state<'pw' | 'lcao'>('lcao')
  let abacus_ecutwfc = $state(100)
  let abacus_kpoints_auto = $state(true)
  let abacus_kpoints = $state<[number, number, number]>([4, 4, 4])
  let abacus_kspacing = $state(0.1)
  let abacus_scf_nmax = $state(100)
  let abacus_scf_thr = $state(1e-7)
  let abacus_smearing_method = $state<'gauss' | 'mp' | 'fd' | 'fixed'>('gauss')
  let abacus_smearing_sigma = $state(0.015)
  let abacus_nspin = $state<1 | 2 | 4>(1)
  let abacus_dft_functional = $state('PBE')
  let abacus_mixing_type = $state<'pulay' | 'broyden' | 'plain'>('pulay')
  let abacus_mixing_beta = $state(0.4)
  let abacus_force_thr = $state(1e-3)
  let abacus_stress_thr = $state(0.5)
  let abacus_relax_nmax = $state(50)
  let abacus_symmetry = $state<-1 | 0 | 1>(1)
  let abacus_cal_force = $state(true)
  let abacus_cal_stress = $state(true)
  let abacus_out_chg = $state(false)
  let abacus_out_band = $state(false)
  let abacus_pseudo_dir = $state('./')
  let abacus_orbital_dir = $state('./')
  let abacus_pseudopotentials = $state<Record<string, string>>({})
  let abacus_orbitals = $state<Record<string, string>>({})
  let abacus_md_type = $state<'nve' | 'nvt' | 'npt'>('nvt')
  let abacus_md_nstep = $state(1000)
  let abacus_md_dt = $state(1.0)
  let abacus_md_temp = $state(300)

  // Init pseudopotentials
  $effect(() => {
    for (const el of unique_elements) {
      if (!(el in abacus_pseudopotentials)) abacus_pseudopotentials[el] = ''
      if (!(el in abacus_orbitals)) abacus_orbitals[el] = ''
    }
  })

  function generate_abacus() {
    if (!structure) { generation_error = 'No structure'; return }
    generation_error = null
    try {
      const files = gen_abacus_input(structure, {
        prefix, calculation: abacus_calculation, basis_type: abacus_basis_type,
        ecutwfc: abacus_ecutwfc, kpoints_auto: abacus_kpoints_auto, kpoints: abacus_kpoints,
        kspacing: abacus_kspacing, scf_nmax: abacus_scf_nmax, scf_thr: abacus_scf_thr,
        smearing_method: abacus_smearing_method, smearing_sigma: abacus_smearing_sigma,
        nspin: abacus_nspin, dft_functional: abacus_dft_functional,
        mixing_type: abacus_mixing_type, mixing_beta: abacus_mixing_beta,
        force_thr: abacus_force_thr, stress_thr: abacus_stress_thr, relax_nmax: abacus_relax_nmax,
        symmetry: abacus_symmetry, cal_force: abacus_cal_force, cal_stress: abacus_cal_stress,
        out_chg: abacus_out_chg, out_band: abacus_out_band,
        pseudo_dir: abacus_pseudo_dir, orbital_dir: abacus_orbital_dir,
        pseudopotentials: abacus_pseudopotentials, orbitals: abacus_orbitals,
        md_type: abacus_md_type, md_nstep: abacus_md_nstep, md_dt: abacus_md_dt, md_temp: abacus_md_temp,
        unique_elements,
      }, { fix_mode, fix_z_threshold, selected_indices, constrained_atoms_info })
      generated_output = files
      active_file = 'INPUT'
    } catch (e) {
      generation_error = e instanceof Error ? e.message : 'Failed to generate ABACUS input'
    }
  }
</script>

{#if !('lattice' in (structure ?? {})) || !(structure as any)?.lattice}
  <div class="section-content">
    <p>ABACUS requires a periodic structure with a lattice.</p>
    {#if on_request_vacuum_box}
      <button class="wrap-prompt-btn" onclick={on_request_vacuum_box}>
        Wrap in Vacuum Box
      </button>
    {/if}
  </div>
{:else}
<div class="section-content calc-section">
  <div style="font-size: 0.78em; color: var(--warning-color, #e89a3c); padding: 0.4em 0.5em; margin-bottom: 0.5em; background: light-dark(rgba(232,154,60,0.08), rgba(232,154,60,0.1)); border-radius: 4px; border-left: 3px solid var(--warning-color, #e89a3c);">
    Generated input is a starting template. Pseudopotentials, orbitals, and parameters must be validated for your system.
  </div>

  <div class="param-row"><span>Prefix</span><input type="text" bind:value={prefix} class="text-input" /></div>
  <div class="param-row">
    <span>Calculation <span class="param-help" title="scf: self-consistent field. relax: ionic relaxation. cell-relax: variable-cell relaxation. nscf: non-self-consistent (for DOS/bands). md: molecular dynamics">?</span></span>
    <select bind:value={abacus_calculation} onchange={() => generated_output = {}}>
      <option value="scf">SCF</option>
      <option value="relax">Relax</option>
      <option value="cell-relax">Cell-Relax</option>
      <option value="nscf">NSCF</option>
      <option value="md">MD</option>
    </select>
  </div>
  <div class="param-row">
    <span>Basis Type <span class="param-help" title="pw: plane-wave basis. lcao: linear combination of atomic orbitals (requires numerical orbital files)">?</span></span>
    <select bind:value={abacus_basis_type} onchange={() => generated_output = {}}>
      <option value="lcao">LCAO</option>
      <option value="pw">Plane Wave</option>
    </select>
  </div>
  <div class="param-row">
    <span>ecutwfc (Ry) <span class="param-help" title="Kinetic energy cutoff for wavefunctions in Rydberg. 50 Ry typical for PW, 100 Ry for LCAO">?</span></span>
    <input type="number" step="10" bind:value={abacus_ecutwfc} />
  </div>
  <div class="param-row">
    <span>Functional <span class="param-help" title="Exchange-correlation functional. PBE: standard GGA. LDA: local density approximation. PBEsol: revised PBE for solids. SCAN: meta-GGA. HSE: hybrid">?</span></span>
    <select bind:value={abacus_dft_functional} onchange={() => generated_output = {}}>
      <optgroup label="GGA"><option value="PBE">PBE</option><option value="PBEsol">PBEsol</option><option value="BLYP">BLYP</option><option value="revPBE">revPBE</option></optgroup>
      <optgroup label="LDA"><option value="LDA">LDA</option></optgroup>
      <optgroup label="meta-GGA"><option value="SCAN">SCAN</option><option value="r2SCAN">r2SCAN</option></optgroup>
      <optgroup label="Hybrid"><option value="HSE">HSE</option><option value="PBE0">PBE0</option></optgroup>
    </select>
  </div>
  <div class="param-row">
    <span>K-points <span class="param-help" title="Monkhorst-Pack k-point grid for Brillouin zone sampling. Auto uses 4x4x4">?</span></span>
    {#if abacus_kpoints_auto}
      <label class="checkbox-inline"><input type="checkbox" bind:checked={abacus_kpoints_auto} /> auto</label>
    {:else}
      <div class="kpoint-inputs">
        <input type="number" min="1" max="20" bind:value={abacus_kpoints[0]} />
        <input type="number" min="1" max="20" bind:value={abacus_kpoints[1]} />
        <input type="number" min="1" max="20" bind:value={abacus_kpoints[2]} />
        <label><input type="checkbox" bind:checked={abacus_kpoints_auto} /></label>
      </div>
    {/if}
  </div>
  <div class="param-row">
    <span>nspin <span class="param-help" title="1: no spin polarization. 2: collinear spin. 4: non-collinear spin">?</span></span>
    <select bind:value={abacus_nspin} onchange={() => generated_output = {}}>
      <option value={1}>1 (No spin)</option>
      <option value={2}>2 (Collinear)</option>
      <option value={4}>4 (Non-collinear)</option>
    </select>
  </div>

  <details class="advanced-details">
    <summary>SCF Settings</summary>
    <div class="param-row"><span>scf_nmax</span><input type="number" min="1" bind:value={abacus_scf_nmax} /></div>
    <div class="param-row"><span>scf_thr</span><select bind:value={abacus_scf_thr}><option value={1e-6}>1e-6</option><option value={1e-7}>1e-7</option><option value={1e-8}>1e-8</option><option value={1e-9}>1e-9</option></select></div>
    <div class="param-row"><span>Smearing</span><select bind:value={abacus_smearing_method}><option value="gauss">Gaussian</option><option value="mp">Methfessel-Paxton</option><option value="fd">Fermi-Dirac</option><option value="fixed">Fixed</option></select></div>
    <div class="param-row"><span>Sigma (Ry)</span><input type="number" step="0.005" bind:value={abacus_smearing_sigma} /></div>
    <div class="param-row"><span>Mixing</span><select bind:value={abacus_mixing_type}><option value="pulay">Pulay</option><option value="broyden">Broyden</option><option value="plain">Plain</option></select></div>
    <div class="param-row"><span>mixing_beta</span><input type="number" step="0.1" min="0.01" max="1" bind:value={abacus_mixing_beta} /></div>
    <div class="param-row"><span>Symmetry</span><select bind:value={abacus_symmetry}><option value={1}>1 (Full)</option><option value={0}>0 (Time-reversal)</option><option value={-1}>-1 (None)</option></select></div>
  </details>

  {#if abacus_calculation === 'relax' || abacus_calculation === 'cell-relax'}
    <details class="advanced-details">
      <summary>Relaxation</summary>
      <div class="param-row"><span>relax_nmax</span><input type="number" min="1" bind:value={abacus_relax_nmax} /></div>
      <div class="param-row"><span>force_thr (Ry/Bohr)</span><select bind:value={abacus_force_thr}><option value={1e-2}>1e-2</option><option value={1e-3}>1e-3</option><option value={1e-4}>1e-4</option></select></div>
      {#if abacus_calculation === 'cell-relax'}
        <div class="param-row"><span>stress_thr (GPa)</span><input type="number" step="0.1" bind:value={abacus_stress_thr} /></div>
      {/if}
    </details>

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

  {#if abacus_calculation === 'md'}
    <details class="advanced-details" open>
      <summary>MD Settings</summary>
      <div class="param-row"><span>Ensemble</span><select bind:value={abacus_md_type}><option value="nve">NVE</option><option value="nvt">NVT</option><option value="npt">NPT</option></select></div>
      <div class="param-row"><span>Steps</span><input type="number" min="1" bind:value={abacus_md_nstep} /></div>
      <div class="param-row"><span>dt (fs)</span><input type="number" step="0.5" bind:value={abacus_md_dt} /></div>
      <div class="param-row"><span>Temperature (K)</span><input type="number" min="0" bind:value={abacus_md_temp} /></div>
    </details>
  {/if}

  <details class="advanced-details">
    <summary>Pseudopotentials{abacus_basis_type === 'lcao' ? ' & Orbitals' : ''}</summary>
    <div class="param-row"><span>pseudo_dir</span><input type="text" bind:value={abacus_pseudo_dir} class="text-input" /></div>
    {#if abacus_basis_type === 'lcao'}
      <div class="param-row"><span>orbital_dir</span><input type="text" bind:value={abacus_orbital_dir} class="text-input" /></div>
    {/if}
    {#each unique_elements as el}
      <div class="param-row pp-row">
        <span class="el-label">{el} PP</span>
        <input type="text" bind:value={abacus_pseudopotentials[el]} placeholder={`${el}_ONCV_PBE-1.0.upf`} class="pp-input" />
      </div>
      {#if abacus_basis_type === 'lcao'}
        <div class="param-row pp-row">
          <span class="el-label">{el} Orb</span>
          <input type="text" bind:value={abacus_orbitals[el]} placeholder={`${el}_gga_8au_100Ry_2s2p1d.orb`} class="pp-input" />
        </div>
      {/if}
    {/each}
  </details>

  <details class="advanced-details">
    <summary>Output</summary>
    <label class="checkbox-row"><input type="checkbox" bind:checked={abacus_cal_force} /> cal_force</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={abacus_cal_stress} /> cal_stress</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={abacus_out_chg} /> out_chg</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={abacus_out_band} /> out_band</label>
  </details>

  <div class="button-group">
    <button class="generate-btn" onclick={generate_abacus}>
      <Icon icon="Zap" style="width: 14px; height: 14px" /> Generate
    </button>
  </div>
</div>
{/if}

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
  .wrap-prompt-btn { display: block; width: 100%; padding: 5px 10px; margin-top: 0.6em; background: var(--accent-color, #007acc); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; }
  .wrap-prompt-btn:hover { filter: brightness(1.1); }
</style>

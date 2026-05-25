<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { Icon } from '$lib'
  import { API_BASE } from '$lib/api/config'
  import { parse_index_range } from '$lib/structure/export/common-export'
  import { get_cp2k_valence, gen_cp2k_local as _gen_cp2k_local, apply_cp2k_preset as _apply_cp2k_preset, type CP2KPreset } from '$lib/structure/export/cp2k-export'
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
    constrained_atoms_info?: { count: number; details: { idx: number; element: string; constraint: [boolean, boolean, boolean] }[] }
    fix_mode?: 'none' | 'selected' | 'z_below'
    fix_z_threshold?: number
    generated_output?: Record<string, string>
    generation_error?: string | null
    active_file?: string
    on_request_vacuum_box?: (() => void) | undefined
  } = $props()

  // ====== CP2K Settings ======
  let cp2k_run_type = $state<'energy' | 'energy_force' | 'geo_opt' | 'cell_opt' | 'md' | 'vibrational_analysis' | 'linear_response'>('geo_opt')
  let cp2k_functional = $state<'PBE' | 'BLYP' | 'SCAN' | 'PBE0' | 'B3LYP' | 'revPBE' | 'PBEsol' | 'BP86' | 'RPBE' | 'TPSS' | 'revTPSS' | 'r2SCAN' | 'HSE06' | 'BHandHLYP'>('PBE')
  let cp2k_basis_set = $state('DZVP-MOLOPT-SR-GTH')
  let cp2k_cutoff = $state(400)
  let cp2k_rel_cutoff = $state(50)
  let cp2k_scf_method = $state<'OT' | 'DIAG'>('OT')
  let cp2k_scf_eps = $state(1e-5)
  let cp2k_max_scf = $state(300)
  let cp2k_ot_precond = $state<'FULL_KINETIC' | 'FULL_ALL' | 'FULL_SINGLE_INVERSE'>('FULL_KINETIC')
  let cp2k_ot_minimizer = $state<'DIIS' | 'CG' | 'BROYDEN'>('DIIS')
  let cp2k_outer_scf = $state(true)
  let cp2k_outer_max_scf = $state(20)
  let cp2k_outer_eps = $state(1e-5)
  let cp2k_smearing = $state(false)
  let cp2k_smearing_method = $state<'FERMI_DIRAC' | 'ENERGY_WINDOW'>('FERMI_DIRAC')
  let cp2k_electronic_temperature = $state(300)
  let cp2k_added_mos = $state(50)
  let cp2k_vdw = $state<'none' | 'DFTD3(BJ)' | 'DFTD3' | 'DFTD2' | 'DFTD4'>('DFTD3(BJ)')
  let cp2k_periodic = $state<'XYZ' | 'XY' | 'XZ' | 'YZ' | 'X' | 'Y' | 'Z' | 'NONE'>('XYZ')
  let cp2k_charge = $state(0)
  let cp2k_multiplicity = $state(1)
  let cp2k_uks = $state(false)
  let cp2k_spin_auto = $derived.by(() => {
    if (!structure?.sites) return null
    let total_valence = 0
    for (const site of structure.sites) {
      const el = site.species?.[0]?.element || 'X'
      total_valence += get_cp2k_valence(el)
    }
    const electrons = total_valence - cp2k_charge
    const is_odd = electrons % 2 !== 0
    return { electrons, is_odd }
  })
  $effect(() => {
    if (!cp2k_spin_auto) return
    if (cp2k_spin_auto.is_odd) {
      cp2k_uks = true
      if (cp2k_multiplicity < 2) cp2k_multiplicity = 2
    } else if (cp2k_scf_method === 'OT') {
      cp2k_uks = false
    } else if (cp2k_scf_method === 'DIAG' && !cp2k_smearing) {
      cp2k_uks = false
    }
  })
  let cp2k_kpoints_enabled = $state(false)
  let cp2k_kpoints_nx = $state(1)
  let cp2k_kpoints_ny = $state(1)
  let cp2k_kpoints_nz = $state(1)
  let cp2k_dftpu_enabled = $state(false)
  let cp2k_dftpu_settings = $state<Record<string, { l: number; u_minus_j: number }>>({})
  let cp2k_fix_elements = $state<string[]>([])
  let cp2k_fix_indices_str = $state('')
  let cp2k_cell_rep_x = $state(1)
  let cp2k_cell_rep_y = $state(1)
  let cp2k_cell_rep_z = $state(1)
  let cp2k_fine_grid_xc = $state(false)
  let cp2k_print_level = $state<'LOW' | 'MEDIUM' | 'HIGH'>('LOW')
  let cp2k_print_moments = $state(false)
  let cp2k_print_orbital_energies = $state(false)
  let cp2k_output_overlap_csr = $state(false)
  let cp2k_output_ks_csr = $state(false)
  let cp2k_epr_hyperfine = $state(false)
  let cp2k_efield_enabled = $state(false)
  let cp2k_efield_x = $state(0.0)
  let cp2k_efield_y = $state(0.0)
  let cp2k_efield_z = $state(0.0)
  let cp2k_magnetization = $state<Record<string, number>>({})
  let cp2k_center_coords = $state(false)
  let cp2k_cdft_enabled = $state(false)
  let cp2k_lrigpw = $state(false)
  let cp2k_ls_scf = $state(false)
  let cp2k_poisson_solver = $state<'PERIODIC' | 'ANALYTIC' | 'MT' | 'WAVELET' | 'IMPLICIT'>('PERIODIC')
  let cp2k_surf_dipole = $state<'NONE' | 'SURF_DIP' | 'BERRY'>('NONE')
  let cp2k_coord_from_file = $state(false)
  let cp2k_coord_file_name = $state('')
  let cp2k_geo_optimizer = $state<'BFGS' | 'LBFGS' | 'CG'>('BFGS')
  let cp2k_geo_max_force = $state(4.5e-4)
  let cp2k_geo_max_iter = $state(200)
  let cp2k_cell_opt_max_iter = $state(100)
  let cp2k_cell_opt_pressure = $state(0.0)
  let cp2k_md_ensemble = $state<'NVE' | 'NVT' | 'NPT_I'>('NVT')
  let cp2k_md_steps = $state(1000)
  let cp2k_md_timestep = $state(0.5)
  let cp2k_md_temperature = $state(300)
  let cp2k_md_thermostat = $state<'NOSE' | 'CSVR'>('CSVR')
  let cp2k_md_timecon = $state(100)

  function apply_cp2k_preset(preset: CP2KPreset) {
    generated_output = {}
    const p = _apply_cp2k_preset(preset)
    if (p.run_type !== undefined) cp2k_run_type = p.run_type
    if (p.functional !== undefined) cp2k_functional = p.functional
    if (p.basis_set !== undefined) cp2k_basis_set = p.basis_set
    if (p.cutoff !== undefined) cp2k_cutoff = p.cutoff
    if (p.rel_cutoff !== undefined) cp2k_rel_cutoff = p.rel_cutoff
    if (p.scf_eps !== undefined) cp2k_scf_eps = p.scf_eps
    if (p.max_scf !== undefined) cp2k_max_scf = p.max_scf
    if (p.scf_method !== undefined) cp2k_scf_method = p.scf_method
    if (p.vdw !== undefined) cp2k_vdw = p.vdw
    if (p.geo_max_force !== undefined) cp2k_geo_max_force = p.geo_max_force
    if (p.periodic !== undefined) cp2k_periodic = p.periodic
    if (p.smearing !== undefined) cp2k_smearing = p.smearing
    if (p.smearing_method !== undefined) cp2k_smearing_method = p.smearing_method
    if (p.electronic_temperature !== undefined) cp2k_electronic_temperature = p.electronic_temperature
    if (p.added_mos !== undefined) cp2k_added_mos = p.added_mos
    if (p.md_ensemble !== undefined) cp2k_md_ensemble = p.md_ensemble
    if (p.md_steps !== undefined) cp2k_md_steps = p.md_steps
    if (p.md_timestep !== undefined) cp2k_md_timestep = p.md_timestep
    if (p.md_temperature !== undefined) cp2k_md_temperature = p.md_temperature
    if (p.md_thermostat !== undefined) cp2k_md_thermostat = p.md_thermostat
    if (p.md_timecon !== undefined) cp2k_md_timecon = p.md_timecon
  }

  async function generate_cp2k() {
    if (!structure) { generation_error = 'No structure'; return }
    generation_error = null

    let fixed_indices: number[] | null = null, fixed_z_below: number | null = null
    if (fix_mode === 'selected' && selected_indices.length > 0) fixed_indices = [...selected_indices]
    else if (fix_mode === 'z_below') fixed_z_below = fix_z_threshold
    if (constrained_atoms_info.count > 0 && !fixed_indices) fixed_indices = constrained_atoms_info.details.map(d => d.idx)
    if (cp2k_fix_indices_str.trim()) {
      const idx_set = parse_index_range(cp2k_fix_indices_str, structure.sites?.length || 0)
      if (!fixed_indices) fixed_indices = []
      idx_set.forEach(i => { if (!fixed_indices!.includes(i)) fixed_indices!.push(i) })
    }

    const run_type_map: Record<string, string> = {
      energy: 'ENERGY', energy_force: 'ENERGY_FORCE', geo_opt: 'GEO_OPT', cell_opt: 'CELL_OPT', md: 'MD',
      vibrational_analysis: 'VIBRATIONAL_ANALYSIS', linear_response: 'LINEAR_RESPONSE',
    }

    try {
      const res = await fetch(`${API_BASE}/cp2k/input`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structure, prefix, run_type: run_type_map[cp2k_run_type] || cp2k_run_type.toUpperCase(),
          functional: cp2k_functional, basis_set: cp2k_basis_set, cutoff: cp2k_cutoff,
          rel_cutoff: cp2k_rel_cutoff,
          scf_method: cp2k_scf_method, scf_eps: cp2k_scf_eps, max_scf: cp2k_max_scf,
          ot_preconditioner: cp2k_ot_precond, ot_minimizer: cp2k_ot_minimizer,
          outer_scf: cp2k_outer_scf, outer_max_scf: cp2k_outer_max_scf, outer_eps: cp2k_outer_eps,
          smearing: cp2k_smearing, smearing_method: cp2k_smearing_method,
          electronic_temperature: cp2k_electronic_temperature, added_mos: cp2k_added_mos,
          vdw: cp2k_vdw, periodic: cp2k_periodic,
          charge: cp2k_charge, multiplicity: cp2k_multiplicity, uks: cp2k_uks,
          kpoints_enabled: cp2k_kpoints_enabled, kpoints_nx: cp2k_kpoints_nx, kpoints_ny: cp2k_kpoints_ny, kpoints_nz: cp2k_kpoints_nz,
          dftpu_enabled: cp2k_dftpu_enabled, dftpu_settings: cp2k_dftpu_enabled ? cp2k_dftpu_settings : null,
          geo_optimizer: cp2k_geo_optimizer, geo_max_force: cp2k_geo_max_force, geo_max_iter: cp2k_geo_max_iter,
          cell_opt_max_iter: cp2k_cell_opt_max_iter, cell_opt_pressure: cp2k_cell_opt_pressure,
          md_ensemble: cp2k_md_ensemble, md_steps: cp2k_md_steps, md_timestep: cp2k_md_timestep,
          md_temperature: cp2k_md_temperature, md_thermostat: cp2k_md_thermostat, md_timecon: cp2k_md_timecon,
          fixed_indices, fixed_z_below,
          fixed_elements: cp2k_fix_elements.length > 0 ? cp2k_fix_elements : null,
        }),
      })
      if (!res.ok) throw new Error(`Server: ${res.status}`)
      const r = await res.json()
      if (r.success) {
        generated_output = { [`${prefix}.inp`]: r.input_file }
        active_file = `${prefix}.inp`
      } else {
        throw new Error(r.message || 'Server returned failure')
      }
    } catch (e) {
      // Backend unavailable or errored (network failure, non-OK status, or
      // {success:false}) — fall back to fully client-side generation so the web
      // build can still produce a CP2K input.
      try {
        const inp = gen_cp2k_local()
        generated_output = { [`${prefix}.inp`]: inp }
        active_file = `${prefix}.inp`
      } catch (localErr) {
        generation_error = localErr instanceof Error ? localErr.message
          : (e instanceof Error ? e.message : 'Failed to generate CP2K input')
      }
    }
  }

  function gen_cp2k_local(): string {
    if (!structure) return ''
    return _gen_cp2k_local(structure, {
      prefix, run_type: cp2k_run_type, functional: cp2k_functional, basis_set: cp2k_basis_set,
      cutoff: cp2k_cutoff, rel_cutoff: cp2k_rel_cutoff,
      scf_method: cp2k_scf_method, scf_eps: cp2k_scf_eps, max_scf: cp2k_max_scf,
      ot_precond: cp2k_ot_precond, ot_minimizer: cp2k_ot_minimizer,
      outer_scf: cp2k_outer_scf, outer_max_scf: cp2k_outer_max_scf, outer_eps: cp2k_outer_eps,
      smearing: cp2k_smearing, smearing_method: cp2k_smearing_method,
      electronic_temperature: cp2k_electronic_temperature, added_mos: cp2k_added_mos,
      vdw: cp2k_vdw, periodic: cp2k_periodic,
      charge: cp2k_charge, multiplicity: cp2k_multiplicity, uks: cp2k_uks,
      kpoints_enabled: cp2k_kpoints_enabled, kpoints_nx: cp2k_kpoints_nx,
      kpoints_ny: cp2k_kpoints_ny, kpoints_nz: cp2k_kpoints_nz,
      dftpu_enabled: cp2k_dftpu_enabled, dftpu_settings: cp2k_dftpu_settings,
      fix_elements: cp2k_fix_elements, fix_indices_str: cp2k_fix_indices_str,
      cell_rep_x: cp2k_cell_rep_x, cell_rep_y: cp2k_cell_rep_y, cell_rep_z: cp2k_cell_rep_z,
      fine_grid_xc: cp2k_fine_grid_xc,
      print_level: cp2k_print_level, print_moments: cp2k_print_moments,
      print_orbital_energies: cp2k_print_orbital_energies,
      output_overlap_csr: cp2k_output_overlap_csr, output_ks_csr: cp2k_output_ks_csr,
      epr_hyperfine: cp2k_epr_hyperfine,
      efield_enabled: cp2k_efield_enabled, efield_x: cp2k_efield_x,
      efield_y: cp2k_efield_y, efield_z: cp2k_efield_z,
      magnetization: cp2k_magnetization, center_coords: cp2k_center_coords,
      coord_from_file: cp2k_coord_from_file, coord_file_name: cp2k_coord_file_name,
      geo_optimizer: cp2k_geo_optimizer, geo_max_force: cp2k_geo_max_force, geo_max_iter: cp2k_geo_max_iter,
      cell_opt_max_iter: cp2k_cell_opt_max_iter, cell_opt_pressure: cp2k_cell_opt_pressure,
      md_ensemble: cp2k_md_ensemble, md_steps: cp2k_md_steps, md_timestep: cp2k_md_timestep,
      md_temperature: cp2k_md_temperature, md_thermostat: cp2k_md_thermostat, md_timecon: cp2k_md_timecon,
      cdft_enabled: cp2k_cdft_enabled, lrigpw: cp2k_lrigpw, ls_scf: cp2k_ls_scf,
      poisson_solver: cp2k_poisson_solver, surf_dipole: cp2k_surf_dipole,
      unique_elements,
    }, { fix_mode, fix_z_threshold, selected_indices, constrained_atoms_info })
  }
</script>

{#if !('lattice' in (structure ?? {})) || !(structure as any)?.lattice}
  <div class="section-content">
    <p>CP2K requires a periodic structure with a lattice.</p>
    {#if on_request_vacuum_box}
      <button class="wrap-prompt-btn" onclick={on_request_vacuum_box}>
        Wrap in Vacuum Box
      </button>
      <p style="font-size: 0.8em; opacity: 0.6; margin-top: 0.4em;">
        Places the molecule in a periodic cell so CP2K inputs can be generated.
      </p>
    {/if}
  </div>
{:else}
<div class="section-content calc-section">
  <div style="font-size: 0.78em; color: var(--warning-color, #e89a3c); padding: 0.4em 0.5em; margin-bottom: 0.5em; background: light-dark(rgba(232,154,60,0.08), rgba(232,154,60,0.1)); border-radius: 4px; border-left: 3px solid var(--warning-color, #e89a3c);">
    Generated input is a starting template only. Parameters (basis set, cutoff, pseudopotentials, spin, etc.) must be validated by the user for physical correctness. Know what you are computing before submitting.
  </div>

  <!-- Preset buttons -->
  <div style="display: flex; gap: 0.25rem; margin-bottom: 0.5em; flex-wrap: wrap;">
    <button class="preset-btn" onclick={() => apply_cp2k_preset('quick')} title="Quick single point: DZVP-SR, 300 Ry, OT, no vdW">Quick</button>
    <button class="preset-btn" onclick={() => apply_cp2k_preset('accurate')} title="Accurate: TZV2P, 600 Ry, OT, D3(BJ)">Accurate</button>
    <button class="preset-btn" onclick={() => apply_cp2k_preset('surface')} title="Surface relaxation: DZVP-SR, 400 Ry, OT, D3(BJ)">Surface</button>
    <button class="preset-btn" onclick={() => apply_cp2k_preset('metal')} title="Metallic system: Diag+Smearing, Fermi-Dirac 300K">Metal</button>
    <button class="preset-btn" onclick={() => apply_cp2k_preset('md_equil')} title="MD equilibration: NVT, 5000 steps, CSVR">MD</button>
    <button class="preset-btn" onclick={() => apply_cp2k_preset('hybrid')} title="Hybrid PBE0 single-point">Hybrid</button>
  </div>

  <div class="param-row">
    <span>Prefix</span>
    <input type="text" bind:value={prefix} class="text-input" />
  </div>
  <div class="param-row">
    <span>Run Type <span class="param-help" title="ENERGY: single-point energy. GEO_OPT: geometry optimization. CELL_OPT: variable-cell optimization. MD: molecular dynamics. VIBRATIONAL_ANALYSIS: phonon frequencies">?</span></span>
    <select bind:value={cp2k_run_type} onchange={() => generated_output = {}}>
      <option value="energy">ENERGY (Single Point)</option>
      <option value="energy_force">ENERGY_FORCE (Energy + Forces)</option>
      <option value="geo_opt">GEO_OPT (Geometry Opt)</option>
      <option value="cell_opt">CELL_OPT (Cell Opt)</option>
      <option value="md">MD (Molecular Dynamics)</option>
      <option value="vibrational_analysis">VIBRATIONAL_ANALYSIS (Freq)</option>
      <option value="linear_response">LINEAR_RESPONSE (NMR)</option>
    </select>
  </div>
  <div class="param-row">
    <span>Functional <span class="param-help" title="Exchange-correlation functional. PBE: standard GGA. r2SCAN: modern meta-GGA. PBE0/B3LYP/HSE06: hybrid (more accurate but much slower)">?</span></span>
    <select bind:value={cp2k_functional}>
      <optgroup label="GGA">
        <option value="PBE">PBE</option>
        <option value="BLYP">BLYP</option>
        <option value="revPBE">revPBE</option>
        <option value="PBEsol">PBEsol</option>
        <option value="BP86">BP86</option>
        <option value="RPBE">RPBE</option>
      </optgroup>
      <optgroup label="meta-GGA">
        <option value="SCAN">SCAN</option>
        <option value="r2SCAN">r2SCAN</option>
        <option value="TPSS">TPSS</option>
        <option value="revTPSS">revTPSS</option>
      </optgroup>
      <optgroup label="Hybrid">
        <option value="PBE0">PBE0</option>
        <option value="B3LYP">B3LYP</option>
        <option value="HSE06">HSE06</option>
        <option value="BHandHLYP">BHandHLYP</option>
      </optgroup>
    </select>
  </div>
  <div class="param-row">
    <span>VDW <span class="param-help" title="Van der Waals dispersion correction. D3(BJ): recommended for most systems. D4: newer, slightly more accurate. None: skip if not needed">?</span></span>
    <select bind:value={cp2k_vdw}>
      <option value="DFTD3(BJ)">DFT-D3(BJ)</option>
      <option value="DFTD3">DFT-D3</option>
      <option value="DFTD4">DFT-D4</option>
      <option value="DFTD2">DFT-D2</option>
      <option value="none">None</option>
    </select>
  </div>
  <div class="param-row">
    <span>Basis Set <span class="param-help" title="Gaussian basis set. SR (short-range) variants optimized for periodic systems. DZVP: double-zeta (standard). TZVP: triple-zeta (more accurate). ccGRB: correlation-consistent">?</span></span>
    <select bind:value={cp2k_basis_set}>
      <optgroup label="MOLOPT (Short-Range)">
        <option value="SZV-MOLOPT-SR-GTH">SZV-MOLOPT-SR-GTH</option>
        <option value="DZVP-MOLOPT-SR-GTH">DZVP-MOLOPT-SR-GTH</option>
        <option value="TZVP-MOLOPT-SR-GTH">TZVP-MOLOPT-SR-GTH</option>
      </optgroup>
      <optgroup label="MOLOPT (Standard)">
        <option value="DZVP-MOLOPT-GTH">DZVP-MOLOPT-GTH</option>
        <option value="TZVP-MOLOPT-GTH">TZVP-MOLOPT-GTH</option>
        <option value="TZV2P-MOLOPT-GTH">TZV2P-MOLOPT-GTH</option>
      </optgroup>
      <optgroup label="ccGRB">
        <option value="cc-DZ">cc-DZ</option>
        <option value="cc-TZ">cc-TZ</option>
        <option value="cc-QZ">cc-QZ</option>
      </optgroup>
    </select>
  </div>
  <div class="param-row">
    <span>Cutoff (Ry) <span class="param-help" title="Plane-wave cutoff for the auxiliary PW grid in Rydberg. 300-400 Ry for DZVP, 600+ for TZVP or accurate calculations">?</span></span>
    <input type="number" step="50" min="100" max="2000" bind:value={cp2k_cutoff} />
  </div>

  <div style="font-size: 0.8em; color: var(--text-color-muted); margin: 0.4em 0; padding: 0.3em 0.5em; background: light-dark(rgba(0,0,0,0.04), rgba(30,35,40,0.3)); border-radius: 4px;">
    Basis/potential files (BASIS_MOLOPT, GTH_POTENTIALS) are bundled with CP2K under <code>data/</code>.
  </div>

  <!-- SCF Method -->
  <details class="advanced-details">
    <summary>SCF Method</summary>
    <div class="param-row">
      <span>Method</span>
      <select bind:value={cp2k_scf_method}>
        <option value="OT">OT (Orbital Transformation)</option>
        <option value="DIAG">Diagonalization</option>
      </select>
    </div>
    {#if cp2k_scf_method === 'OT'}
      <div class="param-row">
        <span>Preconditioner</span>
        <select bind:value={cp2k_ot_precond}>
          <option value="FULL_KINETIC">FULL_KINETIC</option>
          <option value="FULL_ALL">FULL_ALL</option>
          <option value="FULL_SINGLE_INVERSE">FULL_SINGLE_INVERSE</option>
        </select>
      </div>
      <div class="param-row">
        <span>Minimizer</span>
        <select bind:value={cp2k_ot_minimizer}>
          <option value="DIIS">DIIS</option>
          <option value="CG">CG</option>
          <option value="BROYDEN">BROYDEN</option>
        </select>
      </div>
      <div style="font-size: 0.75em; color: var(--text-color-muted); padding: 0.2em 0;">
        OT is efficient for insulators/semiconductors. For metals, use Diagonalization + Smearing.
      </div>
    {:else}
      <div class="param-row"><span>Added MOs</span><input type="number" min="0" max="500" bind:value={cp2k_added_mos} /></div>
      <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_smearing} /> Smearing</label>
      {#if cp2k_smearing}
        <div class="param-row">
          <span>Smearing Method</span>
          <select bind:value={cp2k_smearing_method}>
            <option value="FERMI_DIRAC">Fermi-Dirac</option>
            <option value="ENERGY_WINDOW">Energy Window</option>
          </select>
        </div>
        <div class="param-row"><span>Elec. Temp (K)</span><input type="number" min="1" step="50" bind:value={cp2k_electronic_temperature} /></div>
      {/if}
      <div style="font-size: 0.75em; color: var(--text-color-muted); padding: 0.2em 0;">
        Diagonalization is required for metallic systems and for UKS calculations.
      </div>
    {/if}
  </details>

  <!-- Advanced SCF & Spin -->
  <details class="advanced-details">
    <summary>Advanced</summary>
    <div class="param-row"><span>Rel Cutoff (Ry)</span><input type="number" step="10" min="10" max="200" bind:value={cp2k_rel_cutoff} /></div>
    <div class="param-row">
      <span>SCF eps</span>
      <select bind:value={cp2k_scf_eps}>
        <option value={1e-5}>1e-5</option>
        <option value={1e-6}>1e-6</option>
        <option value={1e-7}>1e-7</option>
        <option value={1e-8}>1e-8</option>
      </select>
    </div>
    <div class="param-row"><span>Max SCF</span><input type="number" min="10" max="1000" bind:value={cp2k_max_scf} /></div>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_outer_scf} /> OUTER_SCF</label>
    {#if cp2k_outer_scf}
      <div class="param-row"><span>Outer Max SCF</span><input type="number" min="1" max="100" bind:value={cp2k_outer_max_scf} /></div>
      <div class="param-row">
        <span>Outer EPS</span>
        <select bind:value={cp2k_outer_eps}>
          <option value={1e-4}>1e-4</option>
          <option value={1e-5}>1e-5</option>
          <option value={1e-6}>1e-6</option>
        </select>
      </div>
    {/if}
    <div class="param-row">
      <span>Periodic</span>
      <select bind:value={cp2k_periodic}>
        <option value="XYZ">XYZ</option>
        <option value="XY">XY</option>
        <option value="XZ">XZ</option>
        <option value="YZ">YZ</option>
        <option value="X">X</option>
        <option value="Y">Y</option>
        <option value="Z">Z</option>
        <option value="NONE">NONE</option>
      </select>
    </div>
    <div class="param-row"><span>Charge</span><input type="number" bind:value={cp2k_charge} /></div>
    <div class="param-row">
      <span>Multiplicity</span>
      <input type="number" min="1" bind:value={cp2k_multiplicity} />
    </div>
    <div class="param-row" style="align-items: center;">
      <label class="checkbox-inline">
        <input type="checkbox" bind:checked={cp2k_uks}
          disabled={cp2k_spin_auto?.is_odd || cp2k_scf_method === 'OT' || (cp2k_scf_method === 'DIAG' && !cp2k_smearing)} /> UKS
      </label>
      {#if cp2k_spin_auto}
        <span style="margin-left: auto; font-size: 0.78em; color: var(--text-color-muted);">{cp2k_spin_auto.electrons}e<sup>-</sup></span>
      {/if}
    </div>
    {#if cp2k_scf_method === 'OT' && !cp2k_spin_auto?.is_odd}
      <div style="font-size: 0.75em; color: var(--text-color-muted); padding: 0.2em 0;">
        UKS requires Diagonalization + Smearing. Switch SCF method to enable.
      </div>
    {:else if cp2k_scf_method === 'DIAG' && !cp2k_smearing && !cp2k_spin_auto?.is_odd}
      <div style="font-size: 0.75em; color: var(--text-color-muted); padding: 0.2em 0;">
        Enable Smearing to unlock UKS with Diagonalization.
      </div>
    {/if}
    {#if cp2k_spin_auto?.is_odd}
      <div style="font-size: 0.78em; color: var(--warning-color, #e89a3c); padding: 0.2em 0;">
        Odd electron count ({cp2k_spin_auto.electrons}) — UKS and multiplicity >= 2 required.
      </div>
    {/if}
  </details>

  <!-- K-Points -->
  <details class="advanced-details">
    <summary>K-Points</summary>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_kpoints_enabled} /> Enable Monkhorst-Pack K-Points</label>
    {#if cp2k_kpoints_enabled}
      <div style="display: flex; gap: 4px; align-items: center; padding: 0.3em 0;">
        <span style="font-size: 0.85em;">Grid:</span>
        <input type="number" min="1" max="20" bind:value={cp2k_kpoints_nx} style="width: 45px;" />
        <span>x</span>
        <input type="number" min="1" max="20" bind:value={cp2k_kpoints_ny} style="width: 45px;" />
        <span>x</span>
        <input type="number" min="1" max="20" bind:value={cp2k_kpoints_nz} style="width: 45px;" />
      </div>
      <div style="font-size: 0.75em; color: var(--text-color-muted); padding: 0.2em 0;">
        K-points require Diagonalization SCF method.
      </div>
    {/if}
  </details>

  <!-- DFT+U -->
  {#if unique_elements.length > 0}
    <details class="advanced-details">
      <summary>DFT+U</summary>
      <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_dftpu_enabled} /> Enable DFT+U</label>
      {#if cp2k_dftpu_enabled}
        {#each unique_elements as el}
          <div style="display: flex; gap: 6px; align-items: center; padding: 0.2em 0; font-size: 0.85em;">
            <span style="width: 2em; font-weight: 600;">{el}</span>
            <span>L=</span>
            <select style="width: 50px;" value={cp2k_dftpu_settings[el]?.l ?? 2}
              onchange={(e) => {
                const l = parseInt(e.currentTarget.value)
                cp2k_dftpu_settings = { ...cp2k_dftpu_settings, [el]: { l, u_minus_j: cp2k_dftpu_settings[el]?.u_minus_j ?? 0 } }
              }}>
              <option value={0}>0 (s)</option>
              <option value={1}>1 (p)</option>
              <option value={2}>2 (d)</option>
              <option value={3}>3 (f)</option>
            </select>
            <span>U-J=</span>
            <input type="number" step="0.1" min="0" max="10" style="width: 55px;"
              value={cp2k_dftpu_settings[el]?.u_minus_j ?? 0}
              onchange={(e) => {
                const u = parseFloat(e.currentTarget.value) || 0
                cp2k_dftpu_settings = { ...cp2k_dftpu_settings, [el]: { l: cp2k_dftpu_settings[el]?.l ?? 2, u_minus_j: u } }
              }} />
            <span>eV</span>
          </div>
        {/each}
      {/if}
    </details>
  {/if}

  {#if cp2k_run_type === 'geo_opt'}
    <details class="advanced-details">
      <summary>Geometry Optimization</summary>
      <div class="param-row">
        <span>Optimizer</span>
        <select bind:value={cp2k_geo_optimizer}>
          <option value="BFGS">BFGS</option>
          <option value="LBFGS">LBFGS</option>
          <option value="CG">CG</option>
        </select>
      </div>
      <div class="param-row"><span>Max Force</span><input type="text" value={cp2k_geo_max_force.toExponential(1)} onchange={(e) => { const v = parseFloat(e.currentTarget.value); if (!isNaN(v)) cp2k_geo_max_force = v }} style="font-family: monospace;" /></div>
      <div class="param-row"><span>Max Iter</span><input type="number" min="1" max="2000" bind:value={cp2k_geo_max_iter} /></div>
    </details>
  {/if}

  {#if cp2k_run_type === 'cell_opt'}
    <details class="advanced-details">
      <summary>Cell Optimization</summary>
      <div class="param-row"><span>Max Iter</span><input type="number" min="1" max="1000" bind:value={cp2k_cell_opt_max_iter} /></div>
      <div class="param-row"><span>Pressure (bar)</span><input type="number" step="0.1" bind:value={cp2k_cell_opt_pressure} /></div>
    </details>
  {/if}

  {#if cp2k_run_type === 'md'}
    <details class="advanced-details" open>
      <summary>Molecular Dynamics</summary>
      <div class="param-row">
        <span>Ensemble</span>
        <select bind:value={cp2k_md_ensemble}>
          <option value="NVE">NVE</option>
          <option value="NVT">NVT</option>
          <option value="NPT_I">NPT_I</option>
        </select>
      </div>
      <div class="param-row"><span>Steps</span><input type="number" min="1" step="100" bind:value={cp2k_md_steps} /></div>
      <div class="param-row"><span>Timestep (fs)</span><input type="number" step="0.1" min="0.1" bind:value={cp2k_md_timestep} /></div>
      <div class="param-row"><span>Temperature (K)</span><input type="number" min="0" bind:value={cp2k_md_temperature} /></div>
      {#if cp2k_md_ensemble !== 'NVE'}
        <div class="param-row">
          <span>Thermostat</span>
          <select bind:value={cp2k_md_thermostat}>
            <option value="CSVR">CSVR</option>
            <option value="NOSE">NOSE</option>
          </select>
        </div>
        <div class="param-row"><span>Timecon (fs)</span><input type="number" min="1" bind:value={cp2k_md_timecon} /></div>
      {/if}
    </details>
  {/if}

  {#if cp2k_run_type === 'geo_opt' || cp2k_run_type === 'cell_opt' || cp2k_run_type === 'md' || cp2k_run_type === 'vibrational_analysis'}
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
      <!-- Fix by element -->
      {#if unique_elements.length > 0}
        <div style="padding: 0.3em 0;">
          <span style="font-size: 0.85em;">Fix by element:</span>
          <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 0.2em;">
            {#each unique_elements as el}
              <label style="font-size: 0.82em; display: flex; align-items: center; gap: 2px;">
                <input type="checkbox" checked={cp2k_fix_elements.includes(el)}
                  onchange={(e) => {
                    if (e.currentTarget.checked) cp2k_fix_elements = [...cp2k_fix_elements, el]
                    else cp2k_fix_elements = cp2k_fix_elements.filter(x => x !== el)
                  }} />
                {el}
              </label>
            {/each}
          </div>
        </div>
      {/if}
      <!-- Fix by atom indices -->
      <div class="param-row">
        <span>Fix indices</span>
        <input type="text" bind:value={cp2k_fix_indices_str} placeholder="e.g. 1-10,15,20-25" style="font-family: monospace; font-size: 0.85em;" />
      </div>
      <div style="font-size: 0.73em; color: var(--text-color-muted); padding: 0.1em 0;">
        1-based atom indices. Comma-separated, ranges allowed.
      </div>
    </details>
  {/if}

  <!-- Other Settings (from cp2kmate) -->
  <details class="advanced-details">
    <summary>Other Settings</summary>
    <div class="param-row">
      <span>Print Level</span>
      <select bind:value={cp2k_print_level}>
        <option value="LOW">LOW</option>
        <option value="MEDIUM">MEDIUM</option>
        <option value="HIGH">HIGH</option>
      </select>
    </div>
    <div class="param-row">
      <span>Cell Repeat X</span>
      <input type="number" min="1" max="10" bind:value={cp2k_cell_rep_x} style="width: 50px;" />
    </div>
    <div class="param-row">
      <span>Cell Repeat Y</span>
      <input type="number" min="1" max="10" bind:value={cp2k_cell_rep_y} style="width: 50px;" />
    </div>
    <div class="param-row">
      <span>Cell Repeat Z</span>
      <input type="number" min="1" max="10" bind:value={cp2k_cell_rep_z} style="width: 50px;" />
    </div>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_fine_grid_xc} /> Finer grid for XC</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_print_moments} /> Print electric/magnetic moments</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_print_orbital_energies} /> Print orbital energies after SCF</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_center_coords} /> Center coordinates in box</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_lrigpw} /> LRIGPW acceleration</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_ls_scf} /> Linear Scaling SCF</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_output_overlap_csr} /> Output overlap matrix (.csr)</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_output_ks_csr} /> Output KS matrix (.csr)</label>
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_epr_hyperfine} /> EPR hyperfine coupling tensor</label>
    <div class="param-row">
      <span>Poisson Solver</span>
      <select bind:value={cp2k_poisson_solver}>
        <option value="PERIODIC">PERIODIC</option>
        <option value="ANALYTIC">ANALYTIC</option>
        <option value="MT">MT (Martyna-Tuckerman)</option>
        <option value="WAVELET">WAVELET</option>
        <option value="IMPLICIT">IMPLICIT</option>
      </select>
    </div>
    <div class="param-row">
      <span>Surface Dipole Corr.</span>
      <select bind:value={cp2k_surf_dipole}>
        <option value="NONE">None</option>
        <option value="SURF_DIP">Surface Dipole (Z dir)</option>
      </select>
    </div>
    <!-- Atomic magnetization -->
    {#if unique_elements.length > 0}
      <div style="padding: 0.3em 0;">
        <span style="font-size: 0.85em; font-weight: 500;">Atomic magnetization:</span>
        <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 0.2em;">
          {#each unique_elements as el}
            <div style="display: flex; align-items: center; gap: 2px; font-size: 0.82em;">
              <span style="width: 2em;">{el}</span>
              <input type="number" step="0.1" style="width: 50px;"
                value={cp2k_magnetization[el] ?? 0}
                onchange={(e) => {
                  cp2k_magnetization = { ...cp2k_magnetization, [el]: parseFloat(e.currentTarget.value) || 0 }
                }} />
            </div>
          {/each}
        </div>
        <div style="font-size: 0.72em; color: var(--text-color-muted);">Non-zero values trigger UKS automatically.</div>
      </div>
    {/if}
    <!-- External electric field -->
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_efield_enabled} /> External electric field</label>
    {#if cp2k_efield_enabled}
      <div style="display: flex; gap: 4px; align-items: center; padding: 0.2em 0; font-size: 0.85em;">
        <span>E:</span>
        <input type="number" step="0.001" bind:value={cp2k_efield_x} style="width: 60px;" placeholder="x" />
        <input type="number" step="0.001" bind:value={cp2k_efield_y} style="width: 60px;" placeholder="y" />
        <input type="number" step="0.001" bind:value={cp2k_efield_z} style="width: 60px;" placeholder="z" />
        <span>a.u.</span>
      </div>
    {/if}
    <!-- Coord from file -->
    <label class="checkbox-row"><input type="checkbox" bind:checked={cp2k_coord_from_file} /> Use geometry from external file</label>
    {#if cp2k_coord_from_file}
      <div class="param-row"><span>File name</span><input type="text" bind:value={cp2k_coord_file_name} placeholder="geometry.xyz" style="font-family: monospace;" /></div>
    {/if}
  </details>

  <div class="button-group">
    <button class="generate-btn" onclick={generate_cp2k}>
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
  .advanced-details { background: light-dark(rgba(0,0,0,0.02), rgba(255,255,255,0.02)); border-radius: 4px; padding: 0.4em; margin: 0.5em 0; }
  .button-group { margin-top: 0.6em; }
  .generate-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; background: var(--accent-color, #007acc); color: white; border: none; border-radius: 4px; cursor: pointer; }
  .generate-btn:hover { filter: brightness(1.1); }
  .preset-btn { padding: 2px 8px; font-size: 0.8em; background: rgba(59,130,246,0.3); border: 1px solid rgba(59,130,246,0.5); border-radius: 3px; cursor: pointer; color: var(--accent-color); white-space: nowrap; }
  .preset-btn:hover { background: rgba(59,130,246,0.5); }
  .constraint-badge { display: inline-block; font-size: 0.75em; background: var(--accent-color); color: white; padding: 1px 6px; border-radius: 3px; margin-bottom: 0.3em; }
  .checkbox-inline { display: flex; align-items: center; gap: 4px; font-size: 0.85em; }
  .wrap-prompt-btn { padding: 6px 14px; background: var(--accent-color, #007acc); color: white; border: none; border-radius: 4px; cursor: pointer; margin-top: 0.5em; }
  .wrap-prompt-btn:hover { filter: brightness(1.1); }
</style>

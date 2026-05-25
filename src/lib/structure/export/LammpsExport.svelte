<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { Icon } from '$lib'
  import { API_BASE } from '$lib/api/config'
  import * as exports from '$lib/structure/export'
  import {
    gen_lammps_local as _gen_lammps_local,
    make_lmp_preset, LMP_STAGE_PRESETS,
    type LmpStageType, type LmpStage,
  } from '$lib/structure/export/lammps-export'
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

  // ====== LAMMPS Settings ======
  let lmp_units = $state<'metal' | 'real' | 'lj'>('metal')
  let lmp_atom_style = $state<'atomic' | 'charge'>('atomic')
  let lmp_boundary = $state('p p p')
  let lmp_simulation_type = $state<'minimize' | 'nve' | 'nvt' | 'npt'>('minimize')
  let lmp_pair_style = $state('eam/alloy')
  let lmp_pair_coeff = $state('')
  let lmp_min_style = $state('cg')
  let lmp_etol = $state(1e-8)
  let lmp_ftol = $state(1e-8)
  let lmp_maxiter = $state(10000)
  let lmp_timestep = $state(0.001)
  let lmp_temperature = $state(300)
  let lmp_pressure = $state(0)
  let lmp_run_steps = $state(10000)
  let lmp_tdamp = $state(0.1)
  let lmp_pdamp = $state(1.0)
  let lmp_thermo_freq = $state(100)
  let lmp_dump_freq = $state(1000)

  // ====== Sequential/Multi-Stage Settings ======
  let lmp_sequential_mode = $state(false)
  let lmp_stages = $state<LmpStage[]>([
    { id: 1, stage_type: 'nvt', run_steps: 5000, temperature: 300, tdamp: 100 },
    { id: 2, stage_type: 'npt', run_steps: 5000, temperature: 300, pressure: 1.0, tdamp: 100, pdamp: 1000 }
  ])
  let next_stage_id = $state(3)

  function add_lmp_stage(type?: LmpStageType) {
    lmp_stages = [...lmp_stages, {
      id: next_stage_id++,
      stage_type: type || 'nvt',
      run_steps: 5000,
      temperature: 300,
      tdamp: 100
    }]
  }

  function remove_lmp_stage(id: number) {
    if (lmp_stages.length > 1) {
      lmp_stages = lmp_stages.filter(s => s.id !== id)
    }
  }

  function duplicate_lmp_stage(stage: LmpStage) {
    lmp_stages = [...lmp_stages, { ...stage, id: next_stage_id++ }]
  }

  const lmp_stage_presets = LMP_STAGE_PRESETS

  function apply_lmp_preset(preset: 'equil' | 'anneal' | 'melt-quench') {
    const result = make_lmp_preset(preset)
    lmp_stages = result.stages
    next_stage_id = result.next_id
  }

  // ====== LAMMPS Force Field Export State ======
  let lmp_output_mode = $state<'single' | 'multiple'>('single')
  let lmp_num_molecules = $state(1)
  let lmp_box_mode = $state<'density' | 'size'>('size')
  let lmp_density = $state(1.0)
  let lmp_box_size = $state('20 20 20')
  let lmp_forcefield = $state<'gaff2' | 'gaff' | 'oplsaa' | 'mmff94' | 'mmff94s' | 'uff' | 'ghemical'>('gaff2')
  let lmp_charge_method = $state<'gasteiger' | 'am1bcc' | 'mmff94' | 'zero'>('gasteiger')

  function gen_lammps_local(): { input: string; data: string } {
    if (!structure) return { input: '', data: '' }
    return _gen_lammps_local(structure, {
      prefix, units: lmp_units, atom_style: lmp_atom_style, boundary: lmp_boundary,
      simulation_type: lmp_simulation_type, pair_style: lmp_pair_style, pair_coeff: lmp_pair_coeff,
      min_style: lmp_min_style, etol: lmp_etol, ftol: lmp_ftol, maxiter: lmp_maxiter,
      timestep: lmp_timestep, temperature: lmp_temperature, pressure: lmp_pressure,
      run_steps: lmp_run_steps, tdamp: lmp_tdamp, pdamp: lmp_pdamp,
      thermo_freq: lmp_thermo_freq, dump_freq: lmp_dump_freq, unique_elements,
    }, { fix_mode, fix_z_threshold, selected_indices, constrained_atoms_info })
  }

  async function generate_lammps() {
    if (!structure) { generation_error = 'No structure'; return }
    generation_error = null
    let fixed_indices: number[] | null = null, fixed_z_below: number | null = null
    if (fix_mode === 'selected' && selected_indices.length > 0) fixed_indices = [...selected_indices]
    else if (fix_mode === 'z_below') fixed_z_below = fix_z_threshold
    if (constrained_atoms_info.count > 0 && !fixed_indices) fixed_indices = constrained_atoms_info.details.map(d => d.idx)

    try {
      if (lmp_sequential_mode) {
        const stages = lmp_stages.map(s => {
          const stage_data: any = { stage_type: s.stage_type, run_steps: s.run_steps }
          if (s.temperature !== undefined) stage_data.temperature = s.temperature
          if (s.pressure !== undefined) stage_data.pressure = s.pressure
          if (s.tdamp !== undefined) stage_data.tdamp = s.tdamp
          if (s.pdamp !== undefined) stage_data.pdamp = s.pdamp
          if (s.temp_start !== undefined) stage_data.temp_start = s.temp_start
          if (s.temp_end !== undefined) stage_data.temp_end = s.temp_end
          if (s.deform_rate !== undefined) stage_data.deform_rate = s.deform_rate
          if (s.target_pressure !== undefined) stage_data.target_pressure = s.target_pressure
          if (s.vacancy_index !== undefined) stage_data.vacancy_index = s.vacancy_index
          return stage_data
        })

        const res = await fetch(`${API_BASE}/lammps/sequential`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            structure, prefix, units: lmp_units, atom_style: lmp_atom_style, boundary: lmp_boundary,
            pair_style: lmp_pair_style, pair_coeff: lmp_pair_coeff || '* * <POTENTIAL>',
            stages,
            dump_interval: lmp_dump_freq,
            thermo_interval: lmp_thermo_freq,
            fixed_indices, fixed_z_below,
          }),
        })
        if (!res.ok) throw new Error(`Server: ${res.status}`)
        const r = await res.json()
        if (r.success) {
          generated_output = {
            [`${prefix}_combined.in`]: r.combined_input,
            [`${prefix}.data`]: r.data_file
          }
          r.stages.forEach((stage: any, i: number) => {
            generated_output[`${prefix}_stage${i + 1}.in`] = stage.input_script
          })
          active_file = `${prefix}_combined.in`
        }
      } else {
        const res = await fetch(`${API_BASE}/lammps/input`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            structure, prefix, units: lmp_units, atom_style: lmp_atom_style, boundary: lmp_boundary,
            simulation_type: lmp_simulation_type, pair_style: lmp_pair_style, pair_coeff: lmp_pair_coeff || null,
            min_style: lmp_min_style, etol: lmp_etol, ftol: lmp_ftol, maxiter: lmp_maxiter, maxeval: lmp_maxiter * 10,
            timestep: lmp_timestep, temperature: lmp_temperature, pressure: lmp_pressure, run_steps: lmp_run_steps,
            tdamp: lmp_tdamp, pdamp: lmp_pdamp, thermo_freq: lmp_thermo_freq, dump_freq: lmp_dump_freq,
            fixed_indices, fixed_z_below,
          }),
        })
        if (!res.ok) throw new Error(`Server: ${res.status}`)
        const r = await res.json()
        if (r.success) {
          generated_output = { [`${prefix}.in`]: r.input_script, [`${prefix}.data`]: r.data_file }
          active_file = `${prefix}.in`
        }
      }
    } catch (e) {
      // Backend unavailable or errored (network failure, non-OK status, or
      // server-side failure) — fall back to fully client-side generation so the
      // web build can still produce LAMMPS inputs.
      try {
        const local = gen_lammps_local()
        generated_output = { [`${prefix}.in`]: local.input, [`${prefix}.data`]: local.data }
        active_file = `${prefix}.in`
      } catch (localErr) {
        generation_error = localErr instanceof Error ? localErr.message
          : (e instanceof Error ? e.message : 'Failed')
      }
    }
  }

  async function generate_lammps_input() {
    if (!structure) { generation_error = 'No structure'; return }
    generation_error = null

    try {
      const pdb_content = exports.structure_to_pdb_str(structure)
      const res = await fetch(`${API_BASE}/forcefield/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          structure_content: pdb_content,
          structure_format: 'pdb',
          force_field: lmp_forcefield,
          charge_method: lmp_charge_method,
          num_molecules: lmp_output_mode === 'multiple' ? lmp_num_molecules : 1,
          box_mode: lmp_box_mode,
          box_size: lmp_box_size,
          density: lmp_density,
        })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || `Server error: ${res.status}`)
      }

      const result = await res.json()

      if (!result.success) {
        throw new Error(result.message || 'LAMMPS conversion failed')
      }

      const data_file = result.data_file || ''
      generated_output = { [`${prefix}.data`]: data_file }

      if (result.warnings && result.warnings.length > 0) {
        generated_output[`${prefix}_info.txt`] = `Warnings:\n${result.warnings.join('\n')}`
      }

      active_file = `${prefix}.data`
    } catch (e) {
      if (e instanceof TypeError && e.message.includes('fetch')) {
        generation_error = 'Backend not available. Please start the CatGo server.'
      } else {
        generation_error = e instanceof Error ? e.message : 'Failed to generate LAMMPS files'
      }
    }
  }
</script>

<div class="section-content calc-section">
  <div class="param-row">
    <span>Prefix</span>
    <input type="text" bind:value={prefix} class="text-input" />
  </div>

  <!-- Sequential Mode Toggle -->
  <div class="param-row" style="align-items: center; gap: 0.5rem;">
    <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
      <input type="checkbox" bind:checked={lmp_sequential_mode} />
      <span style="font-weight: 500;">Multi-Stage Simulation</span>
    </label>
    {#if lmp_sequential_mode}
      <div style="display: flex; gap: 0.25rem; margin-left: auto;">
        <button class="preset-btn" onclick={() => apply_lmp_preset('equil')} title="Equilibration: Minimize -> NVT -> NPT">Equil</button>
        <button class="preset-btn" onclick={() => apply_lmp_preset('anneal')} title="Annealing: Heat up and cool down">Anneal</button>
        <button class="preset-btn" onclick={() => apply_lmp_preset('melt-quench')} title="Melt-Quench: Heat to liquid then cool">Melt</button>
      </div>
    {/if}
  </div>

  <div class="param-row">
    <span>Units <span class="param-help" title="LAMMPS unit system. 'metal': eV, Ang, ps, K. 'real': kcal/mol, Ang, fs, K. 'lj': reduced Lennard-Jones units">?</span></span>
    <select bind:value={lmp_units}>
      <option value="metal">metal</option>
      <option value="real">real</option>
      <option value="lj">lj</option>
    </select>
  </div>
  <div class="param-row">
    <span>pair_style <span class="param-help" title="Interatomic potential type. eam/alloy: embedded atom for metals. lj/cut: Lennard-Jones. tersoff: covalent bonds. reaxff: reactive force field">?</span></span>
    <select bind:value={lmp_pair_style}>
      <option value="eam/alloy">eam/alloy</option>
      <option value="eam">eam</option>
      <option value="lj/cut">lj/cut</option>
      <option value="tersoff">tersoff</option>
      <option value="reaxff">reaxff</option>
    </select>
  </div>
  <div class="param-row">
    <span>pair_coeff <span class="param-help" title="Potential file and element mapping. Format: '* * filename.eam Element1 Element2'. The file must be in your LAMMPS working directory">?</span></span>
    <input type="text" bind:value={lmp_pair_coeff} class="text-input" placeholder="* * pot.eam" />
  </div>

  {#if !lmp_sequential_mode}
    <!-- Single Simulation Mode -->
    <div class="param-row">
      <span>Simulation <span class="param-help" title="Minimize: energy minimization. NVE: microcanonical (constant E). NVT: canonical (constant T). NPT: isothermal-isobaric (constant T & P)">?</span></span>
      <select bind:value={lmp_simulation_type} onchange={() => generated_output = {}}>
        <option value="minimize">Minimize</option>
        <option value="nve">NVE</option>
        <option value="nvt">NVT</option>
        <option value="npt">NPT</option>
      </select>
    </div>

    {#if lmp_simulation_type === 'minimize'}
      <div class="param-row"><span>etol <span class="param-help" title="Energy tolerance for stopping criterion. Smaller = tighter convergence">?</span></span><select bind:value={lmp_etol}><option value={1e-6}>1e-6</option><option value={1e-8}>1e-8</option><option value={1e-10}>1e-10</option></select></div>
      <div class="param-row"><span>maxiter <span class="param-help" title="Maximum number of minimization iterations">?</span></span><input type="number" min="100" step="1000" bind:value={lmp_maxiter} /></div>
    {:else}
      <div class="param-row"><span>timestep <span class="param-help" title="Integration timestep. Units depend on unit system: ps (metal), fs (real)">?</span></span><input type="number" step="0.0001" bind:value={lmp_timestep} /></div>
      <div class="param-row"><span>run_steps <span class="param-help" title="Total number of MD simulation steps">?</span></span><input type="number" min="100" step="1000" bind:value={lmp_run_steps} /></div>
      {#if lmp_simulation_type === 'nvt' || lmp_simulation_type === 'npt'}
        <div class="param-row"><span>Temperature (K)</span><input type="number" bind:value={lmp_temperature} /></div>
      {/if}
      {#if lmp_simulation_type === 'npt'}
        <div class="param-row"><span>Pressure (bar)</span><input type="number" bind:value={lmp_pressure} /></div>
      {/if}
    {/if}
  {:else}
    <!-- Multi-Stage Simulation Mode -->
    <div class="stages-container">
      <div class="stages-header">
        <span>Stages ({lmp_stages.length})</span>
        <button class="add-stage-btn" onclick={() => add_lmp_stage()}>
          <Icon icon="Plus" style="width: 12px; height: 12px;" /> Add Stage
        </button>
      </div>

      {#each lmp_stages as stage, index}
        <div class="stage-card">
          <div class="stage-header">
            <span class="stage-number">Stage {index + 1}</span>
            <div class="stage-actions">
              <button class="icon-btn" onclick={() => duplicate_lmp_stage(stage)} title="Duplicate stage" disabled={lmp_stages.length >= 10}>
                <Icon icon="Copy" style="width: 14px; height: 14px;" />
              </button>
              <button class="icon-btn" style="width: 28px;" onclick={() => remove_lmp_stage(stage.id)} title="Remove stage" disabled={lmp_stages.length <= 1}>
                -
              </button>
            </div>
          </div>

          <div class="stage-content">
            <div class="param-row">
              <span>Type</span>
              <select bind:value={stage.stage_type}>
                <option value="minimize">Minimize</option>
                <option value="nve">NVE</option>
                <option value="nvt">NVT</option>
                <option value="npt">NPT</option>
                <option value="temp">Temp Ramp</option>
                <option value="deform">Deform</option>
                <option value="press">Apply Pressure</option>
              </select>
            </div>

            <div class="param-row">
              <span>Steps</span>
              <input type="number" min="100" max="1000000" step="1000" bind:value={stage.run_steps} />
            </div>

            {#if ['nvt', 'npt', 'nve', 'temp'].includes(stage.stage_type)}
              <div class="param-row">
                <span>Temperature (K)</span>
                <input type="number" min="0" max="10000" bind:value={stage.temperature} />
              </div>
            {/if}

            {#if stage.stage_type === 'temp'}
              <div class="param-row-group">
                <div class="param-row">
                  <span>T Start (K)</span>
                  <input type="number" min="0" max="10000" bind:value={stage.temp_start} />
                </div>
                <div class="param-row">
                  <span>T End (K)</span>
                  <input type="number" min="0" max="10000" bind:value={stage.temp_end} />
                </div>
              </div>
            {/if}

            {#if ['nvt', 'npt', 'temp'].includes(stage.stage_type)}
              <div class="param-row">
                <span>T Damp</span>
                <input type="number" min="1" max="10000" step="10" bind:value={stage.tdamp} />
              </div>
            {/if}

            {#if ['npt', 'press'].includes(stage.stage_type)}
              <div class="param-row">
                <span>Pressure (atm)</span>
                <input type="number" min="0" max="100000" step="0.1" bind:value={stage.pressure} />
              </div>
            {/if}

            {#if stage.stage_type === 'npt'}
              <div class="param-row">
                <span>P Damp</span>
                <input type="number" min="1" max="100000" step="100" bind:value={stage.pdamp} />
              </div>
            {/if}

            {#if stage.stage_type === 'press'}
              <div class="param-row">
                <span>Target P (atm)</span>
                <input type="number" min="0" max="100000" step="0.1" bind:value={stage.target_pressure} />
              </div>
            {/if}

            {#if stage.stage_type === 'deform'}
              <div class="param-row-group">
                {#if !stage.deform_rate}
                  {@const _dr = stage.deform_rate = [0.0001, 0.0001, 0.0001]}
                {/if}
                <div class="param-row"><span>Strain Rate X</span><input type="number" step="0.0001" bind:value={stage.deform_rate[0]} /></div>
                <div class="param-row"><span>Strain Rate Y</span><input type="number" step="0.0001" bind:value={stage.deform_rate[1]} /></div>
                <div class="param-row"><span>Strain Rate Z</span><input type="number" step="0.0001" bind:value={stage.deform_rate[2]} /></div>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

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

  <details class="advanced-details">
    <summary>Output</summary>
    <div class="param-row"><span>Thermo Interval</span><input type="number" min="1" bind:value={lmp_thermo_freq} /></div>
    <div class="param-row"><span>Dump Interval</span><input type="number" min="1" bind:value={lmp_dump_freq} /></div>
  </details>

  <div class="button-group">
    <button class="generate-btn" onclick={generate_lammps}>
      <Icon icon="Zap" style="width: 14px; height: 14px" /> Generate {lmp_sequential_mode ? `(${lmp_stages.length} stages)` : ''}
    </button>
  </div>

  <hr style="border: none; border-top: 1px solid light-dark(#ccc, #444); margin: 1em 0;" />

  <!-- Force Field Export (AmberTools / Open Babel) -->
  <details class="advanced-details">
    <summary>Force Field Options</summary>
    <div class="param-row-group">
      <div class="param-row">
        <span>Output Mode</span>
        <select bind:value={lmp_output_mode}>
          <option value="single">Single Molecule</option>
          <option value="multiple">Multiple Molecules / Box</option>
        </select>
      </div>
      <div class="param-row">
        <span>Force Field</span>
        <select bind:value={lmp_forcefield}>
          <optgroup label="AmberTools (recommended)">
            <option value="gaff2">GAFF2 (organic molecules)</option>
            <option value="gaff">GAFF (backward compatible)</option>
          </optgroup>
          <optgroup label="Open Babel">
            <option value="oplsaa">OPLS-AA (proteins, liquids)</option>
            <option value="mmff94">MMFF94 (drug-like molecules)</option>
            <option value="mmff94s">MMFF94s (sparc-minimized)</option>
            <option value="uff">UFF (broad coverage)</option>
            <option value="ghemical">Ghemical</option>
          </optgroup>
        </select>
      </div>
      <div class="param-row">
        <span>Charge Method</span>
        <select bind:value={lmp_charge_method}>
          <option value="gasteiger">Gasteiger (fast, approximate)</option>
          <option value="am1bcc">AM1-BCC (accurate, GAFF only)</option>
          <option value="mmff94">MMFF94 charges</option>
          <option value="zero">Zero charge (testing)</option>
        </select>
      </div>
    </div>
    <p style="font-size: 0.8em; opacity: 0.8; margin: 0.5em 0 0 0;">
      GAFF uses AmberTools (antechamber, parmchk2, moltemplate). Other force fields use Open Babel.
    </p>

    {#if lmp_output_mode === 'multiple'}
      <div class="param-row-group">
        <div class="param-row">
          <span>Number of Molecules</span>
          <input type="number" min="1" max="10000" bind:value={lmp_num_molecules} class="text-input" />
        </div>
        <div class="param-row">
          <span>Box Specification</span>
          <select bind:value={lmp_box_mode}>
            <option value="size">Box Size (Ang)</option>
            <option value="density">Target Density (g/cm3)</option>
          </select>
        </div>
        {#if lmp_box_mode === 'size'}
          <div class="param-row">
            <span>Box Size (Ang)</span>
            <input type="text" bind:value={lmp_box_size} placeholder="20 20 20" class="text-input" />
          </div>
        {:else}
          <div class="param-row">
            <span>Density (g/cm3)</span>
            <input type="number" step="0.1" min="0.1" max="5.0" bind:value={lmp_density} class="text-input" />
          </div>
        {/if}
      </div>
    {/if}

    <div class="button-group">
      <button class="generate-btn" onclick={generate_lammps_input}>
        <Icon icon="Zap" style="width: 14px; height: 14px" /> Generate LAMMPS Files (Force Field)
      </button>
    </div>
  </details>
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
  .advanced-details { background: light-dark(rgba(0,0,0,0.02), rgba(255,255,255,0.02)); border-radius: 4px; padding: 0.4em; margin: 0.5em 0; }
  .constraint-badge { display: inline-block; background: rgba(59,130,246,0.3); color: var(--accent-color); font-size: 0.85em; padding: 2px 6px; border-radius: 8px; margin-bottom: 0.3em; }
  .button-group { margin-top: 0.6em; }
  .generate-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; background: var(--accent-color, #007acc); color: white; border: none; border-radius: 4px; cursor: pointer; }
  .generate-btn:hover { filter: brightness(1.1); }
  .preset-btn { padding: 2px 8px; font-size: 0.8em; background: rgba(59,130,246,0.3); border: 1px solid rgba(59,130,246,0.5); border-radius: 3px; cursor: pointer; color: var(--accent-color); white-space: nowrap; }
  .preset-btn:hover { background: rgba(59,130,246,0.5); }
  .stages-container { display: flex; flex-direction: column; gap: 8px; max-height: 280px; overflow-y: auto; padding: 4px; background: rgba(0,0,0,0.15); border-radius: 4px; margin: 0.5em 0; }
  .stages-header { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; background: light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.05)); border-radius: 4px; }
  .add-stage-btn { display: flex; align-items: center; gap: 4px; padding: 3px 8px; font-size: 0.8em; background: rgba(34,197,94,0.3); border: 1px solid rgba(34,197,94,0.5); border-radius: 3px; cursor: pointer; color: var(--success-color); }
  .add-stage-btn:hover { background: rgba(34,197,94,0.5); }
  .stage-card { background: light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.03)); border: 1px solid var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08))); border-radius: 4px; padding: 8px; margin-bottom: 4px; }
  .stage-card:hover { border-color: var(--border-color); }
  .stage-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08))); }
  .stage-number { font-weight: 600; font-size: 0.85em; color: var(--accent-color); }
  .stage-actions { display: flex; gap: 4px; }
  .icon-btn { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; background: transparent; border: 1px solid var(--border-color); border-radius: 3px; cursor: pointer; color: var(--text-color-muted); }
  .icon-btn:hover:not(:disabled) { background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); color: inherit; }
  .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .stage-content { display: flex; flex-direction: column; gap: 4px; }
  .param-row-group { display: flex; flex-direction: column; gap: 4px; padding-left: 8px; border-left: 2px solid var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08))); margin: 2px 0; }
</style>

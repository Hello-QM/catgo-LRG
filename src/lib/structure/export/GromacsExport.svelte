<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { Icon } from '$lib'
  import { generate_gromacs_input, apply_gmx_preset as _apply_gmx_preset, type GromacsPreset } from '$lib/structure/export/gromacs-export'

  let {
    structure = undefined,
    prefix = $bindable('calc'),
    generated_output = $bindable<Record<string, string>>({}),
    generation_error = $bindable<string | null>(null),
    active_file = $bindable(''),
  }: {
    structure?: AnyStructure
    prefix?: string
    generated_output?: Record<string, string>
    generation_error?: string | null
    active_file?: string
  } = $props()

  // ====== GROMACS state ======
  let gmx_sim_type = $state<'em' | 'eq_nvt' | 'eq_npt' | 'prod_npt' | 'prod_nvt' | 'heat_npt' | 'gas_phase'>('eq_npt')
  let gmx_dt = $state(0.002)
  let gmx_nsteps = $state(500000)
  let gmx_nsteps_display = $derived.by(() => {
    if (gmx_sim_type === 'em') return ``
    const time_ps = gmx_nsteps * gmx_dt
    return time_ps >= 1000 ? `${(time_ps / 1000).toFixed(1)} ns` : `${time_ps.toFixed(1)} ps`
  })
  let gmx_emtol = $state(1000)
  let gmx_emstep = $state(0.01)
  let gmx_tcoupl = $state(`V-rescale`)
  let gmx_ref_t = $state(300)
  let gmx_tau_t = $state(0.1)
  let gmx_pcoupl = $state(`no`)
  let gmx_pcoupltype = $state(`isotropic`)
  let gmx_ref_p = $state(1.0)
  let gmx_tau_p = $state(2.0)
  let gmx_coulombtype = $state(`PME`)
  let gmx_rcoulomb = $state(1.2)
  let gmx_rvdw = $state(1.2)
  let gmx_pbc = $state(`xyz`)
  let gmx_dispcorr = $state(`EnerPres`)
  let gmx_nstlog = $state(1000)
  let gmx_nstenergy = $state(1000)
  let gmx_nstxout_compressed = $state(5000)
  let gmx_constraints = $state(`hbonds`)
  let gmx_gen_vel = $state(`no`)
  let gmx_gen_temp = $state(300)
  let gmx_posres = $state(false)
  let gmx_anneal_time = $state(`0 100`)
  let gmx_anneal_temp = $state(`0 298.15`)

  function apply_gmx_preset(preset: GromacsPreset) {
    generated_output = {}
    const p = _apply_gmx_preset(preset)
    if (p.sim_type !== undefined) gmx_sim_type = p.sim_type
    if (p.dt !== undefined) gmx_dt = p.dt
    if (p.nsteps !== undefined) gmx_nsteps = p.nsteps
    if (p.emtol !== undefined) gmx_emtol = p.emtol
    if (p.emstep !== undefined) gmx_emstep = p.emstep
    if (p.tcoupl !== undefined) gmx_tcoupl = p.tcoupl
    if (p.ref_t !== undefined) gmx_ref_t = p.ref_t
    if (p.tau_t !== undefined) gmx_tau_t = p.tau_t
    if (p.pcoupl !== undefined) gmx_pcoupl = p.pcoupl
    if (p.ref_p !== undefined) gmx_ref_p = p.ref_p
    if (p.tau_p !== undefined) gmx_tau_p = p.tau_p
    if (p.gen_vel !== undefined) gmx_gen_vel = p.gen_vel
    if (p.gen_temp !== undefined) gmx_gen_temp = p.gen_temp
    if (p.constraints !== undefined) gmx_constraints = p.constraints
    if (p.posres !== undefined) gmx_posres = p.posres
    if (p.pbc !== undefined) gmx_pbc = p.pbc
    if (p.coulombtype !== undefined) gmx_coulombtype = p.coulombtype
    if (p.anneal_time !== undefined) gmx_anneal_time = p.anneal_time
    if (p.anneal_temp !== undefined) gmx_anneal_temp = p.anneal_temp
  }

  function generate_gromacs() {
    if (!structure) { generation_error = `No structure`; return }
    generation_error = null
    try {
      const files = generate_gromacs_input(structure, {
        prefix, sim_type: gmx_sim_type, dt: gmx_dt, nsteps: gmx_nsteps,
        nsteps_display: gmx_nsteps_display, emtol: gmx_emtol, emstep: gmx_emstep,
        tcoupl: gmx_tcoupl, ref_t: gmx_ref_t, tau_t: gmx_tau_t,
        pcoupl: gmx_pcoupl, pcoupltype: gmx_pcoupltype, ref_p: gmx_ref_p, tau_p: gmx_tau_p,
        coulombtype: gmx_coulombtype, rcoulomb: gmx_rcoulomb, rvdw: gmx_rvdw,
        pbc: gmx_pbc, dispcorr: gmx_dispcorr,
        nstlog: gmx_nstlog, nstenergy: gmx_nstenergy, nstxout_compressed: gmx_nstxout_compressed,
        constraints: gmx_constraints, gen_vel: gmx_gen_vel, gen_temp: gmx_gen_temp,
        posres: gmx_posres, anneal_time: gmx_anneal_time, anneal_temp: gmx_anneal_temp,
      })
      generated_output = files
      active_file = Object.keys(files)[0]
    } catch (e) {
      generation_error = e instanceof Error ? e.message : `Failed to generate GROMACS input`
    }
  }
</script>

<div class="section-content calc-section">
  <div style="font-size: 0.78em; color: var(--info-color, #5b9bd5); padding: 0.4em 0.5em; margin-bottom: 0.5em; background: light-dark(rgba(91,155,213,0.08), rgba(91,155,213,0.1)); border-radius: 4px; border-left: 3px solid var(--info-color, #5b9bd5);">
    Generates .mdp (parameters), .gro (coordinates), and .top (topology). Bonds, angles, and dihedrals are extracted from structure connectivity. Force constants and LJ parameters are placeholders — assign proper values via AmberTools, CHARMM-GUI, or manually.
  </div>

  <!-- Preset buttons -->
  <div style="display: flex; gap: 0.25rem; margin-bottom: 0.5em; flex-wrap: wrap;">
    <button class="preset-btn" onclick={() => apply_gmx_preset('em')} title="Energy Minimization (CG)">EM</button>
    <button class="preset-btn" onclick={() => apply_gmx_preset('eq_nvt')} title="NVT Equilibration (100 ps)">NVT</button>
    <button class="preset-btn" onclick={() => apply_gmx_preset('eq_npt')} title="NPT Equilibration (100 ps, POSRES)">NPT Eq</button>
    <button class="preset-btn" onclick={() => apply_gmx_preset('prod_npt')} title="NPT Production (2 ns)">Prod NPT</button>
    <button class="preset-btn" onclick={() => apply_gmx_preset('heat_npt')} title="Heating NPT with annealing (200 ps)">Heating</button>
    <button class="preset-btn" onclick={() => apply_gmx_preset('gas_phase')} title="Gas phase, no PBC">Gas Phase</button>
  </div>

  <div class="param-row">
    <span>Prefix</span>
    <input type="text" bind:value={prefix} class="text-input" />
  </div>
  <div class="param-row">
    <span>Simulation Type <span class="param-help" title="EM: steepest descent minimization. NVT: constant volume equilibration. NPT: constant pressure equilibration/production. Heating: simulated annealing">?</span></span>
    <select bind:value={gmx_sim_type} onchange={() => generated_output = {}}>
      <option value="em">Energy Minimization</option>
      <option value="eq_nvt">Equilibration NVT</option>
      <option value="eq_npt">Equilibration NPT</option>
      <option value="prod_npt">Production NPT</option>
      <option value="prod_nvt">Production NVT</option>
      <option value="heat_npt">Heating NPT</option>
      <option value="gas_phase">Gas Phase</option>
    </select>
  </div>

  {#if gmx_sim_type !== 'em'}
    <div class="param-row">
      <span>dt (ps) <span class="param-help" title="Integration timestep in picoseconds. 0.002 ps (2 fs) is standard with LINCS constraints. Use 0.001 ps for flexible models">?</span></span>
      <input type="number" step="0.001" min="0.0001" bind:value={gmx_dt} />
    </div>
  {/if}
  <div class="param-row">
    <span>nsteps <span class="param-help" title="Total number of simulation steps. Total time = nsteps * dt. E.g., 500000 steps * 0.002 ps = 1 ns">?</span></span>
    <input type="number" min="1" bind:value={gmx_nsteps} />
    <span style="font-size: 0.8em; opacity: 0.7; margin-left: 4px;">{gmx_nsteps_display}</span>
  </div>

  {#if gmx_sim_type === 'em'}
    <div class="param-row">
      <span>emtol (kJ/mol/nm) <span class="param-help" title="Force tolerance for energy minimization convergence. 1000 kJ/mol/nm is standard, lower for tighter convergence">?</span></span>
      <input type="number" step="10" min="0" bind:value={gmx_emtol} />
    </div>
    <div class="param-row">
      <span>emstep <span class="param-help" title="Initial step size for steepest descent minimization in nm. 0.01 is default">?</span></span>
      <input type="number" step="0.001" min="0" bind:value={gmx_emstep} />
    </div>
  {/if}

  <!-- Temperature Coupling -->
  {#if gmx_sim_type !== 'em'}
    <details class="advanced-details" open>
      <summary>Temperature</summary>
      <div class="param-row">
        <span>Thermostat</span>
        <select bind:value={gmx_tcoupl}>
          <option value="V-rescale">V-rescale</option>
          <option value="nose-hoover">Nose-Hoover</option>
          <option value="berendsen">Berendsen</option>
        </select>
      </div>
      <div class="param-row">
        <span>ref_t (K)</span>
        <input type="number" step="0.1" min="0" bind:value={gmx_ref_t} />
      </div>
      <div class="param-row">
        <span>tau_t (ps)</span>
        <input type="number" step="0.1" min="0.01" bind:value={gmx_tau_t} />
      </div>
    </details>
  {/if}

  <!-- Pressure Coupling -->
  {#if gmx_sim_type !== 'em' && gmx_sim_type !== 'gas_phase'}
    <details class="advanced-details" open={gmx_pcoupl !== 'no'}>
      <summary>Pressure</summary>
      <div class="param-row">
        <span>Barostat</span>
        <select bind:value={gmx_pcoupl}>
          <option value="no">None</option>
          <option value="parrinello-rahman">Parrinello-Rahman</option>
          <option value="Berendsen">Berendsen</option>
          <option value="C-rescale">C-rescale</option>
        </select>
      </div>
      {#if gmx_pcoupl !== 'no'}
        <div class="param-row">
          <span>pcoupltype</span>
          <select bind:value={gmx_pcoupltype}>
            <option value="isotropic">isotropic</option>
            <option value="semiisotropic">semiisotropic</option>
            <option value="anisotropic">anisotropic</option>
          </select>
        </div>
        <div class="param-row">
          <span>ref_p (bar)</span>
          <input type="number" step="0.1" min="0" bind:value={gmx_ref_p} />
        </div>
        <div class="param-row">
          <span>tau_p (ps)</span>
          <input type="number" step="0.1" min="0.1" bind:value={gmx_tau_p} />
        </div>
      {/if}
    </details>
  {/if}

  <!-- Electrostatics & VdW -->
  <details class="advanced-details">
    <summary>Electrostatics & VdW</summary>
    <div class="param-row">
      <span>coulombtype</span>
      <select bind:value={gmx_coulombtype}>
        <option value="PME">PME</option>
        <option value="Cut-off">Cut-off</option>
        <option value="Reaction-Field">Reaction-Field</option>
      </select>
    </div>
    <div class="param-row">
      <span>rcoulomb (nm)</span>
      <input type="number" step="0.1" min="0" bind:value={gmx_rcoulomb} />
    </div>
    <div class="param-row">
      <span>rvdw (nm)</span>
      <input type="number" step="0.1" min="0" bind:value={gmx_rvdw} />
    </div>
    <div class="param-row">
      <span>PBC</span>
      <select bind:value={gmx_pbc}>
        <option value="xyz">xyz</option>
        <option value="no">no</option>
      </select>
    </div>
    <div class="param-row">
      <span>DispCorr</span>
      <select bind:value={gmx_dispcorr}>
        <option value="EnerPres">EnerPres</option>
        <option value="Ener">Ener</option>
        <option value="no">no</option>
      </select>
    </div>
  </details>

  <!-- Output & Constraints -->
  <details class="advanced-details">
    <summary>Output & Constraints</summary>
    <div class="param-row"><span>nstlog</span><input type="number" min="1" bind:value={gmx_nstlog} /></div>
    <div class="param-row"><span>nstenergy</span><input type="number" min="1" bind:value={gmx_nstenergy} /></div>
    <div class="param-row"><span>nstxout-compressed</span><input type="number" min="1" bind:value={gmx_nstxout_compressed} /></div>
    <div class="param-row">
      <span>constraints</span>
      <select bind:value={gmx_constraints}>
        <option value="none">none</option>
        <option value="hbonds">hbonds</option>
        <option value="all-bonds">all-bonds</option>
      </select>
    </div>
    {#if gmx_sim_type !== 'em'}
      <div class="param-row">
        <span>gen_vel</span>
        <select bind:value={gmx_gen_vel}>
          <option value="no">no</option>
          <option value="yes">yes</option>
        </select>
      </div>
      {#if gmx_gen_vel === 'yes'}
        <div class="param-row">
          <span>gen_temp (K)</span>
          <input type="number" step="0.1" min="0" bind:value={gmx_gen_temp} />
        </div>
      {/if}
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={gmx_posres} /> Position restraints (define = -DPOSRES)
      </label>
    {/if}
  </details>

  <!-- Annealing (heat_npt) -->
  {#if gmx_sim_type === 'heat_npt'}
    <details class="advanced-details" open>
      <summary>Annealing</summary>
      <div class="param-row">
        <span>anneal time (ps)</span>
        <input type="text" bind:value={gmx_anneal_time} class="text-input" placeholder="0 100" />
      </div>
      <div class="param-row">
        <span>anneal temp (K)</span>
        <input type="text" bind:value={gmx_anneal_temp} class="text-input" placeholder="0 298.15" />
      </div>
    </details>
  {/if}

  <div class="button-group">
    <button class="generate-btn" onclick={generate_gromacs}>
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
  .advanced-details { background: light-dark(rgba(0,0,0,0.02), rgba(255,255,255,0.02)); border-radius: 4px; padding: 0.4em; margin: 0.5em 0; }
  .button-group { margin-top: 0.6em; }
  .generate-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; background: var(--accent-color, #007acc); color: white; border: none; border-radius: 4px; cursor: pointer; }
  .generate-btn:hover { filter: brightness(1.1); }
  .preset-btn { padding: 2px 8px; font-size: 0.8em; background: rgba(59,130,246,0.3); border: 1px solid rgba(59,130,246,0.5); border-radius: 3px; cursor: pointer; color: var(--accent-color); white-space: nowrap; }
  .preset-btn:hover { background: rgba(59,130,246,0.5); }
</style>

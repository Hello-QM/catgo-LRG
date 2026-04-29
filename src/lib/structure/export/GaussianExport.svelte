<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { Icon } from '$lib'
  import { generate_gaussian_input, apply_gaussian_preset as _apply_gaussian_preset, type GaussianPreset } from '$lib/structure/export/gaussian-export'

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

  // ====== Gaussian state ======
  let gauss_job_type = $state<'sp' | 'opt' | 'opt_freq' | 'freq' | 'td' | 'ts'>('opt')
  let gauss_method = $state(`B3LYP`)
  let gauss_basis = $state(`6-31G*`)
  let gauss_charge = $state(0)
  let gauss_multiplicity = $state(1)
  let gauss_nproc = $state(8)
  let gauss_mem = $state(`4GB`)
  let gauss_chk = $state(false)
  let gauss_dispersion = $state(`none`)
  let gauss_solvation = $state(`none`)
  let gauss_solvent = $state(`Water`)
  let gauss_td_nstates = $state(10)
  let gauss_pop = $state(`none`)
  let gauss_nosymm = $state(false)
  let gauss_out_wfn = $state(`none`)
  let gauss_title = $state(``)
  let gauss_extra_keywords = $state(``)

  function apply_gaussian_preset(preset: GaussianPreset) {
    generated_output = {}
    const p = _apply_gaussian_preset(preset)
    if (p.job_type !== undefined) gauss_job_type = p.job_type
    if (p.method !== undefined) gauss_method = p.method
    if (p.basis !== undefined) gauss_basis = p.basis
    if (p.dispersion !== undefined) gauss_dispersion = p.dispersion
    if (p.solvation !== undefined) gauss_solvation = p.solvation
    if (p.solvent !== undefined) gauss_solvent = p.solvent
    if (p.td_nstates !== undefined) gauss_td_nstates = p.td_nstates
    if (p.extra_keywords !== undefined) gauss_extra_keywords = p.extra_keywords
  }

  function generate_gaussian() {
    if (!structure) { generation_error = `No structure`; return }
    generation_error = null
    try {
      const files = generate_gaussian_input(structure, {
        prefix, job_type: gauss_job_type, method: gauss_method, basis: gauss_basis,
        charge: gauss_charge, multiplicity: gauss_multiplicity, nproc: gauss_nproc, mem: gauss_mem,
        chk: gauss_chk, dispersion: gauss_dispersion, solvation: gauss_solvation, solvent: gauss_solvent,
        td_nstates: gauss_td_nstates, pop: gauss_pop, nosymm: gauss_nosymm, out_wfn: gauss_out_wfn,
        title: gauss_title, extra_keywords: gauss_extra_keywords,
      })
      generated_output = files
      active_file = Object.keys(files)[0]
    } catch (e) {
      generation_error = e instanceof Error ? e.message : `Failed to generate Gaussian input`
    }
  }
</script>

<div class="section-content calc-section">
  <div style="font-size: 0.78em; color: var(--warning-color, #e89a3c); padding: 0.4em 0.5em; margin-bottom: 0.5em; background: light-dark(rgba(232,154,60,0.08), rgba(232,154,60,0.1)); border-radius: 4px; border-left: 3px solid var(--warning-color, #e89a3c);">
    Generated input is a starting template. Verify method, basis set, charge, and multiplicity before submission.
  </div>

  <!-- Preset buttons -->
  <div style="display: flex; gap: 0.25rem; margin-bottom: 0.5em; flex-wrap: wrap;">
    <button class="preset-btn" onclick={() => apply_gaussian_preset('quick_opt')} title="B3LYP/6-31G* Opt">Quick Opt</button>
    <button class="preset-btn" onclick={() => apply_gaussian_preset('accurate')} title="B3LYP/6-311+G(d,p) Opt+Freq, D3(BJ)">Accurate</button>
    <button class="preset-btn" onclick={() => apply_gaussian_preset('td_dft')} title="B3LYP/6-31G* TD-DFT">TD-DFT</button>
    <button class="preset-btn" onclick={() => apply_gaussian_preset('freq_thermo')} title="B3LYP/6-311+G(d,p) Freq, D3(BJ)">Freq</button>
    <button class="preset-btn" onclick={() => apply_gaussian_preset('solvation')} title="B3LYP/6-31G* Opt with SMD solvation">Solvation</button>
    <button class="preset-btn" onclick={() => apply_gaussian_preset('ts_search')} title="Transition state search">TS</button>
  </div>

  <div class="param-row">
    <span>Prefix</span>
    <input type="text" bind:value={prefix} class="text-input" />
  </div>
  <div class="param-row">
    <span>Job Type <span class="param-help" title="SP: single-point energy. Opt: geometry optimization. Freq: vibrational frequencies/thermodynamics. TD-DFT: UV-Vis spectra. TS: transition state search with force constants">?</span></span>
    <select bind:value={gauss_job_type} onchange={() => generated_output = {}}>
      <option value="sp">Single Point</option>
      <option value="opt">Optimization</option>
      <option value="opt_freq">Opt + Freq</option>
      <option value="freq">Frequency</option>
      <option value="td">TD-DFT (Excited States)</option>
      <option value="ts">TS Search (Opt CalcFC)</option>
    </select>
  </div>
  <div class="param-row">
    <span>Method <span class="param-help" title="B3LYP: standard hybrid DFT. M06-2X: good for thermochemistry & non-covalent. wB97XD: includes dispersion. MP2: wavefunction-based, more accurate but slower">?</span></span>
    <select bind:value={gauss_method}>
      <optgroup label="DFT">
        <option value="B3LYP">B3LYP</option>
        <option value="PBE1PBE">PBE0 (PBE1PBE)</option>
        <option value="M062X">M06-2X</option>
        <option value="wB97XD">wB97XD</option>
        <option value="CAM-B3LYP">CAM-B3LYP</option>
        <option value="PBEPBE">PBEPBE</option>
        <option value="B2PLYP">B2PLYP</option>
      </optgroup>
      <optgroup label="Wavefunction">
        <option value="HF">HF</option>
        <option value="MP2">MP2</option>
      </optgroup>
    </select>
  </div>
  <div class="param-row">
    <span>Basis Set <span class="param-help" title="Pople (6-31G*): standard, fast. Dunning (cc-pVTZ): correlation-consistent, systematic. Karlsruhe (def2-TZVP): good balance of cost/accuracy. Add + for diffuse functions (anions)">?</span></span>
    <select bind:value={gauss_basis}>
      <optgroup label="Pople">
        <option value="6-31G*">6-31G*</option>
        <option value="6-31G**">6-31G**</option>
        <option value="6-311G*">6-311G*</option>
        <option value="6-311+G(d,p)">6-311+G(d,p)</option>
        <option value="6-311++G(d,p)">6-311++G(d,p)</option>
      </optgroup>
      <optgroup label="Dunning">
        <option value="cc-pVDZ">cc-pVDZ</option>
        <option value="cc-pVTZ">cc-pVTZ</option>
        <option value="aug-cc-pVTZ">aug-cc-pVTZ</option>
      </optgroup>
      <optgroup label="Karlsruhe">
        <option value="def2SVP">def2-SVP</option>
        <option value="def2TZVP">def2-TZVP</option>
        <option value="def2TZVPP">def2-TZVPP</option>
      </optgroup>
    </select>
  </div>
  <div class="param-row">
    <span>Charge <span class="param-help" title="Net electric charge of the molecule. 0 for neutral, +1/-1 for ions">?</span></span>
    <input type="number" bind:value={gauss_charge} />
  </div>
  <div class="param-row">
    <span>Multiplicity <span class="param-help" title="Spin multiplicity (2S+1). 1=singlet (closed-shell), 2=doublet (1 unpaired e-), 3=triplet (2 unpaired e-)">?</span></span>
    <input type="number" min="1" bind:value={gauss_multiplicity} />
  </div>

  <!-- Resources -->
  <details class="advanced-details">
    <summary>Resources</summary>
    <div class="param-row">
      <span>%nproc</span>
      <input type="number" min="1" max="256" bind:value={gauss_nproc} />
    </div>
    <div class="param-row">
      <span>%mem</span>
      <input type="text" bind:value={gauss_mem} class="text-input" />
    </div>
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={gauss_chk} /> Include %chk
    </label>
  </details>

  <!-- Advanced Keywords -->
  <details class="advanced-details">
    <summary>Advanced Keywords</summary>
    <div class="param-row">
      <span>Dispersion</span>
      <select bind:value={gauss_dispersion}>
        <option value="none">None</option>
        <option value="EmpiricalDispersion=GD3BJ">GD3BJ (Grimme D3-BJ)</option>
        <option value="EmpiricalDispersion=GD3">GD3 (Grimme D3)</option>
      </select>
      {#if gauss_method === 'wB97XD' && gauss_dispersion !== 'none'}
        <span style="font-size: 0.75em; color: var(--warning-color, #e89a3c);">wB97XD has built-in dispersion, will be skipped</span>
      {/if}
    </div>
    <div class="param-row">
      <span>Solvation</span>
      <select bind:value={gauss_solvation}>
        <option value="none">None (gas phase)</option>
        <option value="scrf">SCRF (implicit solvent)</option>
      </select>
    </div>
    {#if gauss_solvation === 'scrf'}
      <div class="param-row">
        <span>Solvent</span>
        <select bind:value={gauss_solvent}>
          <option value="Water">Water</option>
          <option value="Ethanol">Ethanol</option>
          <option value="Methanol">Methanol</option>
          <option value="Acetonitrile">Acetonitrile</option>
          <option value="DMSO">DMSO</option>
          <option value="Dichloromethane">DCM</option>
          <option value="Toluene">Toluene</option>
          <option value="THF">THF</option>
          <option value="Chloroform">Chloroform</option>
          <option value="Hexane">Hexane</option>
          <option value="Benzene">Benzene</option>
        </select>
      </div>
    {/if}
    {#if gauss_job_type === 'td'}
      <div class="param-row">
        <span>TD nstates</span>
        <input type="number" min="1" max="100" bind:value={gauss_td_nstates} />
      </div>
    {/if}
    <div class="param-row">
      <span>Population</span>
      <select bind:value={gauss_pop}>
        <option value="none">None</option>
        <option value="full">pop=full</option>
        <option value="nbo">pop=nbo</option>
      </select>
    </div>
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={gauss_nosymm} /> nosymm
    </label>
    <div class="param-row">
      <span>Wavefunction</span>
      <select bind:value={gauss_out_wfn}>
        <option value="none">None</option>
        <option value="wfn">output=wfn</option>
        <option value="wfx">output=wfx (recommended)</option>
      </select>
    </div>
  </details>

  <!-- Title and extra keywords -->
  <details class="advanced-details">
    <summary>Title & Extra</summary>
    <div class="param-row">
      <span>Title</span>
      <input type="text" bind:value={gauss_title} class="text-input" />
    </div>
    <div style="padding: 0.3em 0;">
      <span style="font-size: 0.85em;">Extra keywords</span>
      <input type="text" bind:value={gauss_extra_keywords} class="text-input" style="width: 100%; margin-top: 0.2em;"
        placeholder="e.g. opt=(calcfc,ts) counterpoise=2" />
    </div>
  </details>

  <div class="button-group">
    <button class="generate-btn" onclick={generate_gaussian}>
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

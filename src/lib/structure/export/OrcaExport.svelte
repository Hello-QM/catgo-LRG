<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { Icon } from '$lib'
  import { gen_orca_input, BASIS_SET_RECOMMENDATIONS } from '$lib/structure/export/orca-export'

  let {
    structure = undefined,
    selected_indices = [],
    generated_output = $bindable<Record<string, string>>({}),
    generation_error = $bindable<string | null>(null),
    active_file = $bindable(''),
  }: {
    structure?: AnyStructure
    selected_indices?: number[]
    generated_output?: Record<string, string>
    generation_error?: string | null
    active_file?: string
  } = $props()

  // ====== ORCA Settings ======
  let orca_run_type = $state('Energy')
  let orca_method = $state('HF')
  let orca_functional = $state('B3LYP')
  let orca_functional_custom = $state('')
  let orca_wavefunction = $state('RHF')
  let orca_uno_enabled = $state(false)
  let orca_uco_enabled = $state(false)
  let orca_basis = $state('def2-SVP')
  let orca_basis_method = $state('')
  let orca_basis_quality = $state<'economy' | 'production'>('economy')
  let orca_charge = $state(0)
  let orca_multiplicity = $state(1)
  let orca_opt_convergence = $state('Opt')
  let orca_use_cartesian = $state(false)
  let orca_frozen_mode = $state<'none' | 'selected' | 'z_below'>('none')
  let orca_frozen_z = $state(5.0)
  let orca_md_initvel = $state(300)
  let orca_md_run = $state(100)
  let orca_cim_method = $state('RI-MP2')
  let orca_cim_thresh = $state(0.0001)

  // Auto-update wavefunction when method changes
  $effect(() => {
    if (orca_method === 'HF' && !['RHF', 'UHF', 'ROHF', 'AllowRHF', 'UNO', 'UCO'].includes(orca_wavefunction)) {
      orca_wavefunction = 'RHF'
    } else if (orca_method === 'DFT' && !['RKS', 'UKS', 'ROKS'].includes(orca_wavefunction)) {
      orca_wavefunction = 'RKS'
    }
  })

  function generate_orca() {
    if (!structure) { generation_error = 'No structure'; return }
    generation_error = null
    try {
      const content = gen_orca_input(structure, {
        run_type: orca_run_type, method: orca_method, functional: orca_functional,
        functional_custom: orca_functional_custom, wavefunction: orca_wavefunction,
        uno_enabled: orca_uno_enabled, uco_enabled: orca_uco_enabled, basis: orca_basis,
        charge: orca_charge, multiplicity: orca_multiplicity,
        opt_convergence: orca_opt_convergence, use_cartesian: orca_use_cartesian,
        frozen_mode: orca_frozen_mode, frozen_z: orca_frozen_z,
        md_initvel: orca_md_initvel, md_run: orca_md_run,
        cim_method: orca_cim_method, cim_thresh: orca_cim_thresh,
        selected_indices,
      })
      if (content) {
        generated_output = { 'orca.inp': content }
        active_file = 'orca.inp'
      }
    } catch (e) {
      generation_error = e instanceof Error ? e.message : 'Failed to generate ORCA input'
    }
  }
</script>

<div class="section-content calc-section">
  <label class="section-label">Run Type</label>
  <div class="param-row">
    <span>Type <span class="param-help" title="Energy: single-point calculation. EnGrad: energy + gradients. Opt: geometry optimization. MD: ab initio MD. MBIS: charge partitioning. CIM: cluster-in-molecules for large systems">?</span></span>
    <select bind:value={orca_run_type} onchange={() => generated_output = {}}>
      <option value="Energy">Energy (Single Point)</option>
      <option value="EnGrad">EnGrad (Energy + Gradient)</option>
      <option value="Opt">Opt (Geometry Optimization)</option>
      <option value="MD">MD (Molecular Dynamics)</option>
      <option value="MBIS">MBIS (Minimal Basis Iterative Stockholder)</option>
      <option value="CIM">CIM (Cluster-in-Molecules)</option>
    </select>
  </div>

  {#if orca_run_type === 'Opt'}
    <details class="advanced-details" style="margin-top: 0.5em;">
      <summary>Optimization Convergence</summary>
      <div class="param-row">
        <span>Convergence</span>
        <select bind:value={orca_opt_convergence} onchange={() => generated_output = {}}>
          <option value="Opt">Opt (Default convergence)</option>
          <option value="LooseOpt">LooseOpt (Loose convergence)</option>
          <option value="TightOpt">TightOpt (Tight convergence)</option>
          <option value="VeryTightOpt">VeryTightOpt (Very tight convergence)</option>
        </select>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" bind:checked={orca_use_cartesian} onchange={() => generated_output = {}} />
        COpt (Optimize in Cartesian coordinates)
      </label>
    </details>
  {/if}

  {#if orca_run_type === 'MD'}
    <details class="advanced-details" style="margin-top: 0.5em;">
      <summary>Molecular Dynamics Settings</summary>
      <div class="param-row">
        <span>Initvel (K)</span>
        <input type="number" min="1" bind:value={orca_md_initvel} onchange={() => generated_output = {}} />
      </div>
      <div class="param-row">
        <span>Run</span>
        <input type="number" min="1" bind:value={orca_md_run} onchange={() => generated_output = {}} />
      </div>
    </details>
  {/if}

  {#if orca_run_type === 'CIM'}
    <details class="advanced-details" style="margin-top: 0.5em;">
      <summary>CIM Settings</summary>
      <div class="param-row">
        <span>CIMTHRESH</span>
        <input type="number" step="0.0001" bind:value={orca_cim_thresh} onchange={() => generated_output = {}} />
      </div>
    </details>
  {/if}

  <label class="section-label" style="margin-top: 0.8em">Method</label>

  {#if orca_run_type === 'CIM'}
    <div class="param-row">
      <span>Method</span>
      <select bind:value={orca_cim_method} onchange={() => generated_output = {}}>
        <option value="RI-MP2">RI-MP2</option>
        <option value="CCSD(T)">CCSD(T)</option>
        <option value="DLNPO-CCSD(T)">DLNPO-CCSD(T)</option>
      </select>
    </div>
  {:else}
    <div class="param-row">
      <span>Method <span class="param-help" title="HF: Hartree-Fock (mean-field, no correlation). DFT: includes electron correlation via exchange-correlation functional">?</span></span>
      <select bind:value={orca_method} onchange={() => generated_output = {}}>
        <option value="HF">Hartree-Fock (HF)</option>
        <option value="DFT">Density Functional Theory (DFT)</option>
      </select>
    </div>

    {#if orca_method === 'DFT'}
    <div class="param-row">
      <span>Functional <span class="param-help" title="LDA: fast but inaccurate. GGA (PBE, BP86): good for solids. Hybrid (B3LYP, PBE0): better for molecules. Meta-GGA (r2SCAN): modern, accurate. Double-hybrid: most accurate DFT but expensive">?</span></span>
      <select bind:value={orca_functional} onchange={() => generated_output = {}}>
        <optgroup label="LDA (Local Density Approximation)">
          <option value="HFS">HFS -- Hartree-Fock-Slater</option>
          <option value="LDA">LDA -- Local Density Approximation</option>
          <option value="VWN5">VWN-V -- Vosko-Wilk-Nusair (set V)</option>
          <option value="VWN3">VWN-III -- Vosko-Wilk-Nusair (set III)</option>
          <option value="PWLDA">PW-LDA -- Perdew-Wang parameterization</option>
        </optgroup>
        <optgroup label="GGAs (Generalized Gradient Approximation)">
          <option value="BP86">BP86 -- Becke '88 + Perdew '86</option>
          <option value="BLYP">BLYP -- Becke '88 + Lee-Yang-Parr</option>
          <option value="PBE">PBE -- Perdew-Burke-Ernzerhoff</option>
        </optgroup>
        <optgroup label="Meta-GGAs (Meta Generalized Gradient Approximation)">
          <option value="B97M-D4">B97M-D4 -- B97M-V + DFT-D4 dispersion</option>
          <option value="R2SCAN">r2SCAN -- Regularized & Restored SCAN</option>
          <option value="M06L">M06-L -- Minnesota meta-GGA</option>
        </optgroup>
        <optgroup label="Hybrid GGAs (with HF Exchange)">
          <option value="B3LYP">B3LYP -- 20% HF, popular hybrid (Turbomole def)</option>
          <option value="PBE0">PBE0 -- 25% HF, PBE hybrid</option>
          <option value="B3PW91">B3PW91 -- 20% HF, Becke + PW91</option>
        </optgroup>
        <optgroup label="Hybrid Meta-GGAs (with HF Exchange)">
          <option value="M062X">M06-2X -- 54% HF, Minnesota hybrid meta-GGA</option>
          <option value="PW6B95">PW6B95 -- 28% HF, meta-GGA hybrid</option>
          <option value="R2SCAN0">r2SCAN0 -- 25% HF, r2SCAN hybrid</option>
        </optgroup>
        <optgroup label="Double Hybrids (HF + PT2/MP2)">
          <option value="DSD-PBEP86/2013 D3BJ">DSD-PBEP86-D3(BJ) -- 69% HF, 31% DFX, D3(BJ) dispersion</option>
          <option value="B2PLYP">B2PLYP -- 53% HF, 47% DFX, hybrid meta-GGA</option>
          <option value="REVDSD-PBEP86-D4/2021">revDSD-PBEP86-D4 -- 69% HF, 31% DFX, D4 dispersion</option>
        </optgroup>
        <option value="other">Other (custom)</option>
      </select>
    </div>
    {#if orca_functional === 'other'}
      <div class="param-row">
        <span>Custom Functional</span>
        <input type="text" bind:value={orca_functional_custom} placeholder="e.g., CAM-B3LYP, TPSS, wB97X-D" class="text-input" onchange={() => generated_output = {}} />
      </div>
    {/if}
    {/if}

    <div class="param-row">
      <span>Wavefunction</span>
      <select bind:value={orca_wavefunction} onchange={() => generated_output = {}}>
        {#if orca_method === 'HF'}
          <option value="RHF">RHF -- Restricted Hartree-Fock (closed-shell)</option>
          <option value="UHF">UHF -- Unrestricted Hartree-Fock (open-shell)</option>
          <option value="ROHF">ROHF -- Restricted open-shell HF</option>
          <option value="AllowRHF">AllowRHF -- Allow RHF for open-shell (half-electron)</option>
        {:else if orca_method === 'DFT'}
          <option value="RKS">RKS -- Restricted Kohn-Sham DFT (closed-shell)</option>
          <option value="UKS">UKS -- Unrestricted Kohn-Sham DFT (open-shell)</option>
          <option value="ROKS">ROKS -- Restricted open-shell Kohn-Sham DFT</option>
        {/if}
      </select>
    </div>
  {/if}

  {#if orca_run_type !== 'CIM'}
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={orca_uno_enabled} onchange={() => generated_output = {}} />
      UNO -- Generate natural orbitals
    </label>
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={orca_uco_enabled} onchange={() => generated_output = {}} />
      UCO -- Generate corresponding orbitals
    </label>
  {/if}

  {#if orca_run_type !== 'CIM'}
    <details class="advanced-details">
    <summary>Basis Set (Recommended)</summary>
    <div class="param-row">
      <span>Method</span>
      <select bind:value={orca_basis_method} onchange={() => {
        if (orca_basis_method && BASIS_SET_RECOMMENDATIONS[orca_basis_method]) {
          orca_basis = BASIS_SET_RECOMMENDATIONS[orca_basis_method][orca_basis_quality]
          generated_output = {}
        }
      }}>
        <option value="">Select a method...</option>
        <option value="DFT (geometry)">DFT (Geometry Optimization)</option>
        <option value="DFT (energy)">DFT (Energy Calculation)</option>
        <option value="MP2">MP2</option>
        <option value="CCSD(T)">CCSD(T)</option>
        <option value="F12">F12</option>
        <option value="Heavy elements">Heavy Elements (ZORA)</option>
      </select>
    </div>
    {#if orca_basis_method}
      <div class="param-row">
        <span>Quality</span>
        <select bind:value={orca_basis_quality} onchange={() => {
          if (orca_basis_method && BASIS_SET_RECOMMENDATIONS[orca_basis_method]) {
            orca_basis = BASIS_SET_RECOMMENDATIONS[orca_basis_method][orca_basis_quality]
            generated_output = {}
          }
        }}>
          <option value="economy">Economy -- Lower cost, reasonable accuracy</option>
          <option value="production">Production -- Higher accuracy, higher cost</option>
        </select>
      </div>
      <div style="font-size: 0.8em; color: rgba(150, 170, 165, 0.8); margin: 6px 0; padding: 4px 6px; background: rgba(30,35,40,0.3); border-radius: 4px;">
        Selected: <strong>{BASIS_SET_RECOMMENDATIONS[orca_basis_method][orca_basis_quality]}</strong>
      </div>
    {/if}
    <div class="param-row" style="margin-top: 8px;">
      <span>Or Select Manually</span>
      <select bind:value={orca_basis} onchange={() => { orca_basis_method = ''; generated_output = {} }}>
        <option value="def2-SVP">def2-SVP</option>
        <option value="def2-TZVP">def2-TZVP</option>
        <option value="def2-TZVPP">def2-TZVPP</option>
        <option value="def2-QZVP">def2-QZVP</option>
        <option value="cc-pVDZ">cc-pVDZ</option>
        <option value="cc-pVTZ">cc-pVTZ</option>
        <option value="cc-pVQZ">cc-pVQZ</option>
        <option value="cc-pVDZ-F12">cc-pVDZ-F12</option>
        <option value="cc-pVTZ-F12">cc-pVTZ-F12</option>
        <option value="6-31G*">6-31G*</option>
        <option value="6-311+G**">6-311+G**</option>
        <option value="SARC-ZORA-TZVP">SARC-ZORA-TZVP</option>
        <option value="SARC2-ZORA-QZVP">SARC2-ZORA-QZVP</option>
      </select>
    </div>
  </details>
  {/if}

  <div class="param-row">
    <span>Charge <span class="param-help" title="Net electric charge of the molecule. 0 for neutral, +1/-1 for ions">?</span></span>
    <input type="number" bind:value={orca_charge} />
  </div>

  <div class="param-row">
    <span>Multiplicity <span class="param-help" title="Spin multiplicity (2S+1). 1=singlet (closed-shell), 2=doublet (1 unpaired e-), 3=triplet (2 unpaired e-)">?</span></span>
    <input type="number" min="1" bind:value={orca_multiplicity} />
  </div>

  {#if orca_run_type === 'Opt' || orca_run_type === 'MD'}
    <details class="advanced-details">
      <summary>Frozen Atoms (for Opt/MD)</summary>
      <div class="param-row">
        <span>Mode</span>
        <select bind:value={orca_frozen_mode}>
          <option value="none">None (all atoms free)</option>
          <option value="selected" disabled={selected_indices.length === 0}>Selected ({selected_indices.length})</option>
          <option value="z_below">z &lt; threshold</option>
        </select>
      </div>
      {#if orca_frozen_mode === 'z_below'}
        <div class="param-row"><span>z threshold (Ang)</span><input type="number" step="0.5" bind:value={orca_frozen_z} /></div>
      {/if}
    </details>
  {/if}

  <div class="button-group">
    <button class="generate-btn" onclick={generate_orca}>
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
</style>

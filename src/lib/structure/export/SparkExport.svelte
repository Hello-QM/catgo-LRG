<script lang="ts">
  import type { AnyStructure } from '$lib'
  import { Icon } from '$lib'

  let {
    structure = undefined,
    prefix = $bindable('spark_job'),
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

  // ====== Simulation settings ======
  let mode = $state<'kmc' | 'mkm' | 'both' | 'polarization'>('both')
  let cycle_mode = $state(true)
  let temperature = $state(300)
  let potential = $state(0.0)
  let p_n2 = $state(1.0)

  // KMC specific
  let lattice_size = $state(20)
  let kmc_steps = $state(500000)

  // Scan
  let scan_type = $state<'none' | 'potential' | 'temperature'>('none')
  let scan_u_min = $state(-0.5)
  let scan_u_max = $state(-3.0)
  let scan_t_min = $state(250)
  let scan_t_max = $state(500)
  let scan_steps = $state(20)

  // Polarization curve settings
  let pol_u_min = $state(-2.0)
  let pol_u_max = $state(0.0)
  let pol_u_steps = $state(50)
  let pol_fit = $state<'spline' | 'quadratic'>('spline')

  // Model JSON & DFT data
  let model_json = $state('')
  let dft_data_json = $state('')

  // Binary path
  let spark_binary = $state('spark')

  // ====== Presets ======
  type SparkPreset = 'single_kmc' | 'single_mkm' | 'both' | 'potential_scan' | 'temperature_scan' | 'polarization'

  const DFT_EXAMPLE = `{
  "potentials": [-2.0, -1.5, -1.0, -0.5, 0.0],
  "state_energies": {
    "clean": [0.0, 0.0, 0.0, 0.0, 0.0],
    "N2*": [-0.80, -0.72, -0.60, -0.50, -0.38],
    "NNH*": [1.50, 1.65, 1.82, 2.00, 2.20]
  },
  "ts_energies": {
    "N2*->NNH*": [1.80, 2.00, 2.30, 2.60, 3.00]
  }
}`

  function apply_preset(preset: SparkPreset) {
    generated_output = {}
    switch (preset) {
      case 'single_kmc':
        mode = 'kmc'; scan_type = 'none'; kmc_steps = 500000; lattice_size = 20
        break
      case 'single_mkm':
        mode = 'mkm'; scan_type = 'none'
        break
      case 'both':
        mode = 'both'; scan_type = 'none'; kmc_steps = 500000; lattice_size = 20
        break
      case 'potential_scan':
        mode = 'mkm'; scan_type = 'potential'; scan_u_min = -0.5; scan_u_max = -3.0; scan_steps = 20
        break
      case 'temperature_scan':
        mode = 'mkm'; scan_type = 'temperature'; scan_t_min = 250; scan_t_max = 500; scan_steps = 20
        break
      case 'polarization':
        mode = 'polarization'; pol_u_min = -2.0; pol_u_max = 0.0; pol_u_steps = 50; pol_fit = 'spline'
        if (!dft_data_json.trim()) dft_data_json = DFT_EXAMPLE
        break
    }
  }

  function generate() {
    generation_error = null
    try {
      const files: Record<string, string> = {}
      const commands: string[] = []

      // ── Polarization mode ──
      if (mode === 'polarization') {
        if (!dft_data_json.trim()) {
          generation_error = 'DFT energy JSON is required for polarization curve computation.'
          return
        }
        let dft_data: any
        try {
          dft_data = JSON.parse(dft_data_json)
        } catch (e) {
          generation_error = `Invalid DFT JSON: ${e instanceof Error ? e.message : e}`
          return
        }
        if (!dft_data.potentials || !dft_data.state_energies || !dft_data.ts_energies) {
          generation_error = 'DFT JSON must contain "potentials", "state_energies", and "ts_energies" fields.'
          return
        }
        const dft_str = JSON.stringify(dft_data, null, 2)
        files['dft_energies.json'] = dft_str

        commands.push(
          `${spark_binary} polarization ` +
          `--dft-data dft_energies.json ` +
          `--t ${temperature} --p-n2 ${p_n2} ` +
          `--u-min ${pol_u_min} --u-max ${pol_u_max} --u-steps ${pol_u_steps} ` +
          `--fit ${pol_fit} ` +
          `--output ${prefix}_polarization.dat`
        )

        let run_script = `#!/bin/bash\n`
        run_script += `# CatGO SPARK polarization curve\n`
        run_script += `# T=${temperature} K, fit=${pol_fit}\n\n`
        run_script += `cd "$(dirname "$0")"\n\n`
        run_script += `${commands[0]}\n`
        run_script += `echo 'Polarization curve completed. Output: ${prefix}_polarization.dat'\n`
        files[`run_${prefix}.sh`] = run_script

        generated_output = files
        active_file = 'dft_energies.json'
        return
      }

      // ── KMC / MKM modes ──
      if (!model_json.trim()) {
        generation_error = 'Model JSON is required. Paste a SPARK model definition (with species, parameters, processes, lattice).'
        return
      }

      let model_data: any
      try {
        model_data = JSON.parse(model_json)
      } catch (e) {
        generation_error = `Invalid JSON: ${e instanceof Error ? e.message : e}`
        return
      }

      // Override T, U, p_N2 in model parameters
      for (const p of model_data.parameters ?? []) {
        if (p.name === 'T') p.value = temperature
        if (p.name === 'U') p.value = potential
        if (p.name === 'p_N2') p.value = p_n2
      }

      // Ensure new fields exist (spatial KMC)
      if (!model_data.lateral_interactions) model_data.lateral_interactions = []
      if (!model_data.bep_relations) model_data.bep_relations = []

      const model_json_str = JSON.stringify(model_data, null, 2)
      files['model.json'] = model_json_str

      // Build CLI commands
      const cycle_flag = cycle_mode ? '--cycle' : ''
      const p_n2_flag = !cycle_mode ? `--p-n2 ${p_n2}` : ''

      if (scan_type === 'potential') {
        commands.push(
          `${spark_binary} scan-u ${cycle_flag} ` +
          `--t ${temperature} ` +
          `--u-min ${scan_u_min} --u-max ${scan_u_max} --u-steps ${scan_steps} ` +
          `> potential_scan_results.dat 2>&1`
        )
      } else if (scan_type === 'temperature') {
        commands.push(
          `${spark_binary} scan-t ${cycle_flag} ` +
          `--u ${potential} ` +
          `--t-min ${scan_t_min} --t-max ${scan_t_max} --t-steps ${scan_steps} ` +
          `> temperature_scan_results.dat 2>&1`
        )
      } else {
        if (mode === 'kmc' || mode === 'both') {
          commands.push(
            `${spark_binary} kmc ${cycle_flag} ` +
            `--t ${temperature} --u ${potential} ${p_n2_flag} ` +
            `--size ${lattice_size} --steps ${kmc_steps} ` +
            `> kmc_results.dat 2>&1`
          )
        }
        if (mode === 'mkm' || mode === 'both') {
          commands.push(
            `${spark_binary} mkm ${cycle_flag} ` +
            `--t ${temperature} --u ${potential} ${p_n2_flag} ` +
            `> mkm_results.dat 2>&1`
          )
        }
      }

      // Build run script
      const model_name = model_data.meta?.model_name ?? 'unnamed'
      let run_script = `#!/bin/bash\n`
      run_script += `# CatGO SPARK simulation — ${model_name}\n`
      run_script += `# T=${temperature} K, U=${potential} V, mode=${mode}, scan=${scan_type}\n\n`
      run_script += `cd "$(dirname "$0")"\n\n`

      for (let i = 0; i < commands.length; i++) {
        const sub = commands[i].split(' ')[1] ?? 'run'
        run_script += `echo '=== Step ${i + 1}/${commands.length}: ${sub} ==='\n`
        run_script += `${commands[i]}\n`
        run_script += `echo 'Step ${i + 1} exit code:' $?\n\n`
      }
      run_script += `echo 'SPARK simulation completed.'\n`

      files[`run_${prefix}.sh`] = run_script

      generated_output = files
      active_file = 'model.json'
    } catch (e) {
      generation_error = e instanceof Error ? e.message : `Failed to generate SPARK input`
    }
  }
</script>

<div class="section-content calc-section">
  <div style="font-size: 0.78em; color: var(--info-color, #5b9bd5); padding: 0.4em 0.5em; margin-bottom: 0.5em; background: light-dark(rgba(91,155,213,0.08), rgba(91,155,213,0.1)); border-radius: 4px; border-left: 3px solid var(--info-color, #5b9bd5);">
    Generates input files for <a href="https://github.com/WanluLigroupUCSD/SPARK" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline;">SPARK</a> (KMC / Microkinetic / Polarization Curve engine).
    Supports spatial KMC with lateral interactions, BEP relations, and DFT-based polarization curves.
  </div>

  <!-- Preset buttons -->
  <div style="display: flex; gap: 0.25rem; margin-bottom: 0.5em; flex-wrap: wrap;">
    <button class="preset-btn" onclick={() => apply_preset('single_kmc')} title="Single-point KMC">KMC</button>
    <button class="preset-btn" onclick={() => apply_preset('single_mkm')} title="Single-point MKM (fast)">MKM</button>
    <button class="preset-btn" onclick={() => apply_preset('both')} title="Both KMC + MKM">Both</button>
    <button class="preset-btn" onclick={() => apply_preset('potential_scan')} title="Scan applied potential">U Scan</button>
    <button class="preset-btn" onclick={() => apply_preset('temperature_scan')} title="Scan temperature">T Scan</button>
    <button class="preset-btn preset-pol" onclick={() => apply_preset('polarization')} title="Polarization curve from DFT data">Polarization</button>
  </div>

  <div class="param-row">
    <span>Prefix</span>
    <input type="text" bind:value={prefix} class="text-input" />
  </div>
  <div class="param-row">
    <span>Mode</span>
    <select bind:value={mode} onchange={() => generated_output = {}}>
      <option value="kmc">KMC only</option>
      <option value="mkm">MKM only (fast)</option>
      <option value="both">Both KMC + MKM</option>
      <option value="polarization">Polarization Curve (DFT)</option>
    </select>
  </div>

  {#if mode !== 'polarization'}
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={cycle_mode} />
      Cycle mode (9 species, no adsorption/desorption)
    </label>
  {/if}

  <!-- Conditions -->
  <details class="advanced-details" open>
    <summary>Conditions</summary>
    <div class="param-row">
      <span>Temperature (K) <span class="param-help" title="Simulation temperature">?</span></span>
      <input type="number" min="100" max="2000" step="50" bind:value={temperature} />
    </div>
    {#if mode !== 'polarization'}
      <div class="param-row">
        <span>Potential (V vs RHE) <span class="param-help" title="Applied electrochemical potential. Negative = reductive.">?</span></span>
        <input type="number" min="-5" max="2" step="0.1" bind:value={potential} />
      </div>
    {/if}
    {#if !cycle_mode || mode === 'polarization'}
      <div class="param-row">
        <span>p(N2) (bar) <span class="param-help" title="N2 partial pressure. Only used in full mode (not cycle mode).">?</span></span>
        <input type="number" min="0" max="100" step="0.1" bind:value={p_n2} />
      </div>
    {/if}
  </details>

  <!-- Polarization curve settings -->
  {#if mode === 'polarization'}
    <details class="advanced-details" open>
      <summary>Polarization Curve</summary>
      <div class="param-row">
        <span>U min (V) <span class="param-help" title="Start potential for polarization scan">?</span></span>
        <input type="number" min="-5" max="2" step="0.1" bind:value={pol_u_min} />
      </div>
      <div class="param-row">
        <span>U max (V) <span class="param-help" title="End potential for polarization scan">?</span></span>
        <input type="number" min="-5" max="2" step="0.1" bind:value={pol_u_max} />
      </div>
      <div class="param-row">
        <span>Scan points <span class="param-help" title="Number of potential points">?</span></span>
        <input type="number" min="10" max="200" step="10" bind:value={pol_u_steps} />
      </div>
      <div class="param-row">
        <span>Fitting <span class="param-help" title="spline = cubic spline interpolation, quadratic = grand canonical quadratic fit">?</span></span>
        <select bind:value={pol_fit}>
          <option value="spline">Cubic spline</option>
          <option value="quadratic">Quadratic grand canonical</option>
        </select>
      </div>
    </details>

    <!-- DFT Energy JSON -->
    <details class="advanced-details" open>
      <summary>DFT Energy Data</summary>
      <div style="font-size: 0.75em; opacity: 0.7; margin-bottom: 4px;">
        Constant-potential DFT energies: potentials, state_energies, ts_energies
      </div>
      <textarea
        bind:value={dft_data_json}
        rows="10"
        class="model-textarea"
        placeholder={'{"potentials": [...], "state_energies": {"clean": [...], "N2*": [...]}, "ts_energies": {"N2*->NNH*": [...]}}'}
      ></textarea>
    </details>
  {:else}
    <!-- KMC settings -->
    {#if mode === 'kmc' || mode === 'both'}
      <details class="advanced-details" open>
        <summary>KMC Settings</summary>
        <div class="param-row">
          <span>Lattice size <span class="param-help" title="Side length of 2D square lattice. Total sites = size\u00B2. Supports 4-NN (2D) / 6-NN (3D) with PBC.">?</span></span>
          <input type="number" min="5" max="200" step="5" bind:value={lattice_size} />
        </div>
        <div class="param-row">
          <span>KMC steps <span class="param-help" title="Total KMC steps. 500k ~ seconds, 10M ~ minutes in Rust. Fenwick tree O(log N) site selection.">?</span></span>
          <input type="number" min="10000" max="100000000" step="100000" bind:value={kmc_steps} />
        </div>
      </details>
    {/if}

    <!-- Scan -->
    <details class="advanced-details" open={scan_type !== 'none'}>
      <summary>Parameter Scan</summary>
      <div class="param-row">
        <span>Scan type</span>
        <select bind:value={scan_type} onchange={() => generated_output = {}}>
          <option value="none">None (single point)</option>
          <option value="potential">Potential scan</option>
          <option value="temperature">Temperature scan</option>
        </select>
      </div>
      {#if scan_type === 'potential'}
        <div class="param-row">
          <span>U min (V)</span>
          <input type="number" min="-5" max="2" step="0.1" bind:value={scan_u_min} />
        </div>
        <div class="param-row">
          <span>U max (V)</span>
          <input type="number" min="-5" max="2" step="0.1" bind:value={scan_u_max} />
        </div>
        <div class="param-row">
          <span>Scan points</span>
          <input type="number" min="5" max="100" step="5" bind:value={scan_steps} />
        </div>
      {:else if scan_type === 'temperature'}
        <div class="param-row">
          <span>T min (K)</span>
          <input type="number" min="100" max="2000" step="50" bind:value={scan_t_min} />
        </div>
        <div class="param-row">
          <span>T max (K)</span>
          <input type="number" min="100" max="2000" step="50" bind:value={scan_t_max} />
        </div>
        <div class="param-row">
          <span>Scan points</span>
          <input type="number" min="5" max="100" step="5" bind:value={scan_steps} />
        </div>
      {/if}
    </details>

    <!-- Model JSON -->
    <details class="advanced-details" open>
      <summary>Model JSON</summary>
      <div style="font-size: 0.75em; opacity: 0.7; margin-bottom: 4px;">
        Supports lateral_interactions, bep_relations, site_type, diffusion processes
      </div>
      <textarea
        bind:value={model_json}
        rows="8"
        class="model-textarea"
        placeholder={'{"meta": {...}, "species": [...], "parameters": [...], "processes": [...], "lattice": {...}, "lateral_interactions": [...], "bep_relations": [...]}'}
      ></textarea>
    </details>
  {/if}

  <!-- Binary path -->
  <details class="advanced-details">
    <summary>Binary Path</summary>
    <div class="param-row">
      <span>SPARK binary <span class="param-help" title="Path to SPARK (mykmc-rs) binary on HPC">?</span></span>
      <input type="text" bind:value={spark_binary} class="text-input" placeholder="spark" />
    </div>
  </details>

  <div class="button-group">
    <button class="generate-btn" onclick={generate}>
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
  .preset-btn { padding: 2px 8px; font-size: 0.8em; background: rgba(5,150,105,0.3); border: 1px solid rgba(5,150,105,0.5); border-radius: 3px; cursor: pointer; color: #059669; white-space: nowrap; }
  .preset-btn:hover { background: rgba(5,150,105,0.5); }
  .preset-pol { background: rgba(139,92,246,0.3); border-color: rgba(139,92,246,0.5); color: #8b5cf6; }
  .preset-pol:hover { background: rgba(139,92,246,0.5); }
  .checkbox-row { display: flex; align-items: center; gap: 6px; font-size: 0.9em; cursor: pointer; padding: 2px 0; }
  .model-textarea {
    width: 100%; font-size: 0.82em; font-family: 'JetBrains Mono', monospace;
    resize: vertical; border: 1px solid var(--btn-bg); border-radius: 3px;
    background: transparent; color: inherit; padding: 4px; min-height: 100px;
  }
</style>

<script lang="ts">
  import type { AnyStructure, PymatgenStructure } from '$lib'
  import { Icon } from '$lib'
  import {
    generateVASPInputs,
    getVASPCalculationTypes,
    getVASPOptimizerTypes,
    type VASPCalculationType,
    type VASPOptimizerType,
    type VASPInputFiles,
    type ConstantPotentialMethod,
  } from '$lib/api/compute'
  import {
    MAGMOM_DATABASE, MAGMOM_DEFAULT, generate_magmom_string,
    get_unique_elements,
  } from '$lib/structure/export/common-export'
  import { structure_to_poscar, type StructureData } from '$lib/structure/export/offline-serialize'

  let {
    structure = undefined,
    selected_indices = [],
    unique_elements = [],
    generated_output = $bindable<Record<string, string>>({}),
    generation_error = $bindable<string | null>(null),
    generation_notice = $bindable<{ text: string; severity: 'info' | 'warning' } | null>(null),
    active_file = $bindable(''),
    on_request_vacuum_box = undefined,
  }: {
    structure?: AnyStructure
    selected_indices?: number[]
    unique_elements?: string[]
    generated_output?: Record<string, string>
    generation_error?: string | null
    generation_notice?: { text: string; severity: 'info' | 'warning' } | null
    active_file?: string
    on_request_vacuum_box?: () => void
  } = $props()

  // ====== VASP Settings ======
  let vasp_calculation = $state<VASPCalculationType>('scf')
  let vasp_optimizer = $state<VASPOptimizerType | ''>('')
  // ISIF for OPT: 2 = ions only (fixed cell), 3 = ions + cell shape + volume
  // (full cell relaxation), 4 = ions + cell shape (fixed volume).
  let vasp_isif = $state(2)
  let vasp_encut = $state(450)
  let vasp_prec = $state('Accurate')
  let vasp_gga = $state('PE')
  let vasp_ediff = $state(1e-6)
  let vasp_ediff_mode = $state<'preset' | 'custom'>('preset')
  let vasp_ediff_custom = $state('1e-6')
  let vasp_ispin = $state(2)
  let vasp_ivdw = $state(12)
  let vasp_kpoints_mode = $state<'auto' | 'preset' | 'custom'>('auto')
  let vasp_kpoints_preset = $state<'1x1x1' | '2x2x1' | '2x2x2' | '3x3x3' | '4x4x4'>('3x3x3')
  let vasp_kpoints_custom = $state<[number, number, number]>([3, 3, 3])
  let vasp_kspacing = $state(0.3)
  let vasp_calc_types = $state<Record<string, string>>({})
  let vasp_optimizer_types = $state<Record<string, string>>({})
  let vasp_generating = $state(false)
  let vasp_files = $state<VASPInputFiles | null>(null)
  let vasp_fix_mode = $state<'none' | 'selected' | 'z_below'>('none')
  let vasp_fix_z_threshold = $state(5.0)
  let vasp_ediffg = $state(-0.05)
  let vasp_ediffg_mode = $state<'preset' | 'custom'>('preset')
  let vasp_ediffg_custom = $state('-0.05')
  let vasp_magmom_enabled = $state(false)
  let vasp_magmom_mode = $state<'auto' | 'manual'>('auto')
  let vasp_magmom_custom = $state('')
  let vasp_magmom_overrides = $state<Record<string, number>>({})

  // ====== MD / Slow-Growth Settings ======
  let vasp_md_nsw = $state(10000)
  let vasp_md_potim = $state(1)
  let vasp_md_mdalgo = $state(2)
  let vasp_md_smass = $state(0)
  let vasp_md_tebeg = $state(300)
  let vasp_md_teend = $state(300)
  let vasp_md_nblock = $state(1)

  // Slow-growth specific
  let vasp_sg_increm = $state('-0.0008')
  type IconstPrimitive = { type: 'R' | 'A' | 'T'; atoms: number[]; status: 0 | 7 }
  type IconstComplex = { coeffs: number[]; status: 0 | 7 }
  let vasp_sg_primitives = $state<IconstPrimitive[]>([{ type: 'R', atoms: [1, 2], status: 0 }])
  let vasp_sg_complexes = $state<IconstComplex[]>([])
  let vasp_sg_iconst_manual = $state(false)
  let vasp_sg_iconst_text = $state('')

  // ====== Constant-Potential Settings ======
  let vasp_constant_potential = $state<ConstantPotentialMethod>('none')
  let vasp_cp_she_ref = $state(4.6)
  let vasp_cp_voltage_she = $state(0)
  let vasp_cp_nelect = $state<number | null>(null)

  // TPOT parameters
  let vasp_tpot_vdiff = $state(0.001)
  let vasp_tpot_vrate = $state(-1.6)
  let vasp_tpot_vratelim = $state(0.05)
  let vasp_tpot_electstep = $state(0.05)
  let vasp_tpot_eb_k = $state(78.4)
  let vasp_tpot_lambda_d_k = $state(3.04)
  let vasp_tpot_core_c = $state<number | null>(null)
  let vasp_tpot_tau = $state(0)

  // CP-VASP parameters
  let vasp_cpvasp_nescheme = $state(5)
  let vasp_cpvasp_neadjust = $state(1)
  let vasp_cpvasp_fermiconverge = $state(0.01)
  let vasp_cpvasp_cap_max = $state(2.0)
  let vasp_cpvasp_t_eta = $state(300)
  let vasp_cpvasp_eta_length = $state(1)
  let vasp_cpvasp_c_molar = $state(1.0)
  let vasp_cpvasp_r_ion = $state(4.0)

  let vasp_magmom_value = $derived.by(() => {
    if (!vasp_magmom_enabled) return undefined
    if (vasp_magmom_mode === 'auto') {
      return structure ? generate_magmom_string(structure, vasp_magmom_overrides) : undefined
    }
    return vasp_magmom_custom.trim() || undefined
  })

  // Constrained atoms from structure
  let constrained_atoms_info = $derived.by(() => {
    if (!structure?.sites) return { count: 0, details: [] as { idx: number; element: string; constraint: [boolean, boolean, boolean] }[] }
    const details: { idx: number; element: string; constraint: [boolean, boolean, boolean] }[] = []
    structure.sites.forEach((site, idx) => {
      const sd = site.properties?.selective_dynamics as [boolean, boolean, boolean] | undefined
      if (sd && !(sd[0] && sd[1] && sd[2])) {
        details.push({ idx, element: site.species?.[0]?.element || 'X', constraint: sd })
      }
    })
    return { count: details.length, details }
  })

  // Load VASP types on mount
  $effect(() => {
    getVASPCalculationTypes().then((types) => { vasp_calc_types = types }).catch((e) => {
      console.warn(`[VaspExport] Failed to load VASP calculation types:`, e)
    })
    getVASPOptimizerTypes().then((types) => { vasp_optimizer_types = types }).catch((e) => {
      console.warn(`[VaspExport] Failed to load VASP optimizer types:`, e)
    })
  })

  async function generate_vasp() {
    if (!structure) { generation_error = 'No structure'; return }
    vasp_generating = true
    generation_error = null
    generation_notice = null
    vasp_files = null
    try {
      let kpoints: number[][] | undefined = undefined
      let kspacing: number | undefined = undefined

      if (vasp_kpoints_mode === 'preset') {
        const [kx, ky, kz] = vasp_kpoints_preset.split('x').map(Number)
        kpoints = [[kx, ky, kz]]
      } else if (vasp_kpoints_mode === 'custom') {
        kpoints = [[vasp_kpoints_custom[0], vasp_kpoints_custom[1], vasp_kpoints_custom[2]]]
      } else {
        kspacing = vasp_kspacing
      }

      let ediff_value = vasp_ediff
      if (vasp_ediff_mode === 'custom') {
        const parsed = parseFloat(vasp_ediff_custom)
        if (!isNaN(parsed) && parsed > 0) ediff_value = parsed
      }

      let fixed_indices: number[] | undefined = undefined
      let fixed_z_below: number | undefined = undefined
      if (vasp_fix_mode === 'selected' && selected_indices.length > 0) {
        fixed_indices = [...selected_indices]
      } else if (vasp_fix_mode === 'z_below') {
        fixed_z_below = vasp_fix_z_threshold
      }

      let ediffg_value: number | undefined = undefined
      if (vasp_calculation === 'opt') {
        if (vasp_ediffg_mode === 'custom') {
          const parsed = parseFloat(vasp_ediffg_custom)
          if (!isNaN(parsed)) ediffg_value = parsed
        } else {
          ediffg_value = vasp_ediffg
        }
      }

      const magmom_value = (vasp_ispin === 2 && vasp_magmom_enabled) ? vasp_magmom_value : undefined

      const request: Record<string, unknown> = {
        structure: structure as PymatgenStructure,
        calculation_type: vasp_calculation,
        optimizer: vasp_optimizer || undefined,
        encut: vasp_encut,
        prec: vasp_prec,
        gga: vasp_gga,
        ediff: ediff_value,
        ediffg: ediffg_value,
        ispin: vasp_ispin,
        magmom: magmom_value,
        ivdw: vasp_ivdw,
        kpoints: kpoints,
        kspacing: kspacing,
        system_title: structure.id || undefined,
        fixed_indices: fixed_indices,
        fixed_z_below: fixed_z_below,
        isif: vasp_calculation === 'opt' ? vasp_isif : undefined,
        constant_potential: vasp_constant_potential !== 'none' ? vasp_constant_potential : undefined,
      }

      // MD parameters
      if (vasp_calculation === 'md' || vasp_calculation === 'slow_growth') {
        request.nsw = vasp_md_nsw
        request.potim = vasp_md_potim
        request.mdalgo = vasp_md_mdalgo
        request.smass = vasp_md_smass
        request.tebeg = vasp_md_tebeg
        request.teend = vasp_md_teend
        request.nblock = vasp_md_nblock
      }

      // Slow-growth specific
      if (vasp_calculation === 'slow_growth') {
        request.lblueout = true
        request.increm = vasp_sg_increm
        if (vasp_sg_iconst_manual) {
          request.iconst_content = vasp_sg_iconst_text
        } else {
          const lines: string[] = []
          for (const p of vasp_sg_primitives) {
            lines.push(`${p.type} ${p.atoms.join(' ')} ${p.status}`)
          }
          for (const c of vasp_sg_complexes) {
            lines.push(`S ${c.coeffs.join(' ')} ${c.status}`)
          }
          if (lines.length > 0) request.iconst_content = lines.join('\n')
        }
      }

      // Constant-potential parameters
      if (vasp_constant_potential === 'tpot') {
        request.tpot_vtarget = vasp_cp_voltage_she + vasp_cp_she_ref
        request.tpot_vdiff = vasp_tpot_vdiff
        request.tpot_vrate = vasp_tpot_vrate
        request.tpot_vratelim = vasp_tpot_vratelim
        request.tpot_electstep = vasp_tpot_electstep
        request.tpot_eb_k = vasp_tpot_eb_k
        request.tpot_lambda_d_k = vasp_tpot_lambda_d_k
        if (vasp_tpot_core_c != null) request.tpot_core_c = vasp_tpot_core_c
        request.tpot_tau = vasp_tpot_tau
        if (vasp_cp_nelect != null) request.nelect = vasp_cp_nelect
      } else if (vasp_constant_potential === 'cpvasp') {
        request.cpvasp_targetmu = -(vasp_cp_voltage_she + vasp_cp_she_ref)
        request.cpvasp_nescheme = vasp_cpvasp_nescheme
        request.cpvasp_neadjust = vasp_cpvasp_neadjust
        request.cpvasp_fermiconverge = vasp_cpvasp_fermiconverge
        if (vasp_cpvasp_nescheme === 2) {
          request.cpvasp_cap_max = vasp_cpvasp_cap_max
        } else if (vasp_cpvasp_nescheme === 5) {
          request.cpvasp_t_eta = vasp_cpvasp_t_eta
          request.cpvasp_eta_length = vasp_cpvasp_eta_length
        }
        request.cpvasp_c_molar = vasp_cpvasp_c_molar
        request.cpvasp_r_ion = vasp_cpvasp_r_ion
        if (vasp_cp_nelect != null) request.nelect = vasp_cp_nelect
      }

      const files = await generateVASPInputs(request as any)
      vasp_files = files
      generated_output = {
        'INCAR': files.incar,
        'POSCAR': files.poscar,
        'KPOINTS': files.kpoints,
      }
      if (files.iconst) generated_output['ICONST'] = files.iconst
      if (files.incar_nelect) generated_output['INCAR_NELECT'] = files.incar_nelect
      active_file = vasp_constant_potential !== 'none' ? 'INCAR_NELECT' : 'INCAR'
    } catch (e) {
      // Backend unavailable (web/static build, or desktop sidecar down/unreachable)
      // OR backend returned an error — surface the real reason for diagnosis,
      // then generate client-side with $lib/io/vasp-input as a fallback.
      console.warn('[VASP] backend generation failed; falling back to client-side (offline) generation:', e)
      try {
        const poscar = structure_to_poscar(structure as unknown as StructureData)
        const { generate_incar_str, generate_kpoints_str, face_centered_from_symmetry, SUPPORTED_CALC_TYPES } =
          await import('$lib/io/vasp-input')
        if ((SUPPORTED_CALC_TYPES as string[]).includes(vasp_calculation)) {
          const calc = vasp_calculation as 'opt' | 'scf' | 'freq' | 'dos' | 'bader'

          let off_ediff = vasp_ediff
          if (vasp_ediff_mode === 'custom') {
            const p = parseFloat(vasp_ediff_custom); if (!isNaN(p) && p > 0) off_ediff = p
          }
          let off_ediffg: number | undefined = undefined
          if (calc === 'opt') {
            off_ediffg = vasp_ediffg
            if (vasp_ediffg_mode === 'custom') { const p = parseFloat(vasp_ediffg_custom); if (!isNaN(p)) off_ediffg = p }
          }
          let off_kmesh: [number, number, number] | undefined = undefined
          let off_kspacing: number | undefined = undefined
          if (vasp_kpoints_mode === 'preset') {
            const [kx, ky, kz] = vasp_kpoints_preset.split('x').map(Number); off_kmesh = [kx, ky, kz]
          } else if (vasp_kpoints_mode === 'custom') {
            off_kmesh = [vasp_kpoints_custom[0], vasp_kpoints_custom[1], vasp_kpoints_custom[2]]
          } else {
            off_kspacing = vasp_kspacing
          }
          const off_magmom = (vasp_ispin === 2 && vasp_magmom_enabled) ? vasp_magmom_value : undefined

          // Face-centered detection (spglib via moyo-wasm) controls Gamma vs Monkhorst.
          let off_fcc = false
          try { off_fcc = await face_centered_from_symmetry(structure as AnyStructure) } catch { /* symmetry optional offline */ }

          const incar = generate_incar_str({
            calculation_type: calc, encut: vasp_encut, prec: vasp_prec, gga: vasp_gga,
            ediff: off_ediff, ispin: vasp_ispin, ivdw: vasp_ivdw, ediffg: off_ediffg, magmom: off_magmom,
          })
          const kpoints_str = generate_kpoints_str(
            structure as AnyStructure,
            { calculation_type: calc, kmesh: off_kmesh, kspacing: off_kspacing },
            { isFaceCentered: off_fcc },
          )
          generated_output = { 'INCAR': incar, 'POSCAR': poscar, 'KPOINTS': kpoints_str }
          active_file = 'INCAR'
          // Successful offline generation — this is not an error.
          generation_notice = {
            text: 'Generated client-side (offline). Advanced options (MD / constant-potential / element-specific POTCAR & MAGMOM tuning) require the Python backend.',
            severity: 'info',
          }
        } else {
          generated_output = { 'POSCAR': poscar }
          active_file = 'POSCAR'
          // Partial result — the requested calc type can't be produced offline.
          generation_notice = {
            text: `Backend unavailable — '${vasp_calculation}' needs the Python backend; only POSCAR exported offline.`,
            severity: 'warning',
          }
        }
      } catch (offlineErr) {
        console.error('[VASP] client-side fallback also failed:', offlineErr)
        generation_error = e instanceof Error ? e.message : 'Failed to generate VASP inputs'
      }
    } finally {
      vasp_generating = false
    }
  }
</script>

{#if !('lattice' in (structure ?? {})) || !(structure as any)?.lattice}
  <div class="section-content">
    <p>VASP requires a periodic structure with a lattice.</p>
    {#if on_request_vacuum_box}
      <button class="wrap-prompt-btn" onclick={on_request_vacuum_box}>
        Wrap in Vacuum Box
      </button>
      <p style="font-size: 0.8em; opacity: 0.6; margin-top: 0.4em;">
        Places the molecule in a periodic cell so VASP inputs can be generated.
      </p>
    {/if}
  </div>
{:else}
<div class="section-content calc-section">
  <div class="param-row">
    <span>Calculation Type <span class="param-help" title="SCF: single-point energy. OPT: geometry relaxation. FREQ: vibrational frequencies. DOS: density of states. BADER/DDEC: charge partitioning. ELF: electron localization function">?</span></span>
    <select bind:value={vasp_calculation} onchange={() => { generated_output = {}; vasp_files = null }}>
      <option value="scf">SCF (Single Point)</option>
      <option value="opt">OPT (Optimization)</option>
      <option value="freq">FREQ (Frequency)</option>
      <option value="dos">DOS (Density of States)</option>
      <option value="bader">BADER (Charge Analysis)</option>
      <option value="ddec">DDEC (Charge Analysis)</option>
      <option value="elf">ELF (Electron Localization)</option>
      <option value="md">MD (Molecular Dynamics)</option>
      <option value="slow_growth">Slow-Growth MD</option>
    </select>
  </div>

  {#if vasp_calculation === 'opt'}
    <div class="param-row">
      <span>Optimizer <span class="param-help" title="Ionic optimizer algorithm. Standard (CG, IBRION=2) is robust. Quasi-Newton (IBRION=1) converges faster near minimum. VTST FIRE requires external library">?</span></span>
      <select bind:value={vasp_optimizer}>
        <option value="">Standard (IBRION=2, default)</option>
        <option value="vtst_fire">VTST FIRE (requires VTST library)</option>
        <option value="quasi_newton">Quasi-Newton (IBRION=1)</option>
      </select>
    </div>
    <div class="param-row">
      <span>Relaxation (ISIF) <span class="param-help" title="ISIF=2: relax ions only, fixed cell. ISIF=3: relax ions + cell shape + volume (full cell optimization). ISIF=4: relax ions + cell shape, fixed volume.">?</span></span>
      <select bind:value={vasp_isif}>
        <option value={2}>Ions only — fixed cell (ISIF=2)</option>
        <option value={3}>Ions + cell + volume (ISIF=3)</option>
        <option value={4}>Ions + cell shape, fixed volume (ISIF=4)</option>
      </select>
    </div>
  {/if}

  {#if vasp_calculation === 'md' || vasp_calculation === 'slow_growth'}
    <details class="advanced-details" open>
      <summary>MD Parameters</summary>
      <div class="param-row"><span>NSW (steps)</span><input type="number" min="1" bind:value={vasp_md_nsw} /></div>
      <div class="param-row"><span>POTIM (fs)</span><input type="number" step="0.5" min="0.1" bind:value={vasp_md_potim} /></div>
      <div class="param-row"><span>MDALGO</span><select bind:value={vasp_md_mdalgo}><option value={2}>2 (Nosé-Hoover)</option><option value={3}>3 (Langevin)</option><option value={13}>13 (NVE)</option></select></div>
      <div class="param-row"><span>SMASS</span><input type="number" step="0.5" bind:value={vasp_md_smass} /></div>
      <div class="param-row"><span>TEBEG (K)</span><input type="number" min="0" bind:value={vasp_md_tebeg} /></div>
      <div class="param-row"><span>TEEND (K)</span><input type="number" min="0" bind:value={vasp_md_teend} /></div>
      <div class="param-row"><span>NBLOCK</span><input type="number" min="1" bind:value={vasp_md_nblock} /></div>
    </details>
  {/if}

  {#if vasp_calculation === 'slow_growth'}
    <details class="advanced-details" open>
      <summary>Slow-Growth Parameters</summary>
      <div class="param-row"><span>INCREM</span><input type="text" bind:value={vasp_sg_increm} placeholder="-0.0008" /></div>
      <div class="param-row">
        <span>ICONST</span>
        <label class="checkbox-inline"><input type="checkbox" bind:checked={vasp_sg_iconst_manual} /> Manual</label>
      </div>
      {#if vasp_sg_iconst_manual}
        <textarea bind:value={vasp_sg_iconst_text} rows="4" style="width:100%;font-family:monospace;font-size:0.85em;" placeholder="R 1 2 0&#10;..."></textarea>
      {:else}
        {#each vasp_sg_primitives as prim, i}
          <div class="param-row" style="gap:4px">
            <select bind:value={prim.type} style="width:50px"><option value="R">R</option><option value="A">A</option><option value="T">T</option></select>
            <input type="text" value={prim.atoms.join(' ')} oninput={(e) => { prim.atoms = e.currentTarget.value.split(/\s+/).map(Number) }} style="width:80px;" placeholder="1 2" />
            <select bind:value={prim.status} style="width:50px"><option value={0}>0</option><option value={7}>7</option></select>
            <button type="button" onclick={() => { vasp_sg_primitives = vasp_sg_primitives.filter((_, j) => j !== i) }} style="padding:1px 5px">✕</button>
          </div>
        {/each}
        <button type="button" onclick={() => { vasp_sg_primitives = [...vasp_sg_primitives, { type: 'R', atoms: [1, 2], status: 0 }] }} style="font-size:0.85em;margin-top:2px">+ Add constraint</button>
      {/if}
    </details>
  {/if}

  <div class="param-row">
    <span>ENCUT (eV) <span class="param-help" title="Plane-wave energy cutoff. Higher = more accurate but slower. 520 eV standard for most PAW potentials. Check POTCAR ENMAX for minimum">?</span></span>
    <input type="number" step="10" min="100" max="2000" bind:value={vasp_encut} />
  </div>
  <div class="param-row">
    <span>PREC <span class="param-help" title="Precision flag affecting FFT grids and projection operators. Use 'Accurate' for production, 'Normal' for quick tests">?</span></span>
    <select bind:value={vasp_prec}>
      <option value="Normal">Normal</option>
      <option value="Accurate">Accurate</option>
      <option value="Single">Single</option>
    </select>
  </div>
  <div class="param-row">
    <span>GGA <span class="param-help" title="Exchange-correlation functional. PBE: standard GGA. PBEsol: better for lattice constants. AM05: improved surface energies">?</span></span>
    <select bind:value={vasp_gga}>
      <option value="PE">PE (PBE)</option>
      <option value="PS">PS (PBEsol)</option>
      <option value="AM">AM (AM05)</option>
      <option value="RP">RP (revPBE)</option>
    </select>
  </div>
  <div class="param-row">
    <span>EDIFF (eV) <span class="param-help" title="Electronic SCF convergence criterion. 1e-5 is standard. Use tighter (1e-6 to 1e-8) for frequency or accurate energy differences">?</span></span>
    {#if vasp_ediff_mode === 'preset'}
      <select bind:value={vasp_ediff} onchange={() => { generated_output = {}; vasp_files = null }}>
        <option value={1e-4}>1e-4</option>
        <option value={1e-5}>1e-5</option>
        <option value={1e-6}>1e-6</option>
        <option value={1e-7}>1e-7</option>
        <option value={1e-8}>1e-8</option>
      </select>
      <button type="button" class="mode-toggle" onclick={(e) => { e.stopPropagation(); vasp_ediff_mode = 'custom'; vasp_ediff_custom = vasp_ediff.toExponential() }}>Custom</button>
    {:else}
      <input
        type="text"
        bind:value={vasp_ediff_custom}
        placeholder="1e-6 or 0.000001"
        class="ediff-input"
        onblur={() => {
          const parsed = parseFloat(vasp_ediff_custom)
          if (!isNaN(parsed) && parsed > 0) vasp_ediff = parsed
        }}
      />
      <button type="button" class="mode-toggle" onclick={(e) => { e.stopPropagation(); vasp_ediff_mode = 'preset' }}>Preset</button>
    {/if}
  </div>

  {#if vasp_calculation === 'opt'}
    <div class="param-row">
      <span>EDIFFG (eV/Ang) <span class="param-help" title="Ionic convergence criterion. Negative = force-based (recommended). -0.02 is standard, -0.01 is tight. Positive = energy-based">?</span></span>
      {#if vasp_ediffg_mode === 'preset'}
        <select bind:value={vasp_ediffg} onchange={() => { generated_output = {}; vasp_files = null }}>
          <option value={-0.01}>-0.01 (tight)</option>
          <option value={-0.02}>-0.02</option>
          <option value={-0.03}>-0.03</option>
          <option value={-0.05}>-0.05 (default)</option>
          <option value={-0.1}>-0.1 (loose)</option>
        </select>
        <button type="button" class="mode-toggle" onclick={(e) => { e.stopPropagation(); vasp_ediffg_mode = 'custom'; vasp_ediffg_custom = String(vasp_ediffg) }}>Custom</button>
      {:else}
        <input
          type="text"
          bind:value={vasp_ediffg_custom}
          placeholder="-0.05"
          class="ediff-input"
          onblur={() => {
            const parsed = parseFloat(vasp_ediffg_custom)
            if (!isNaN(parsed)) vasp_ediffg = parsed
          }}
        />
        <button type="button" class="mode-toggle" onclick={(e) => { e.stopPropagation(); vasp_ediffg_mode = 'preset' }}>Preset</button>
      {/if}
    </div>
  {/if}
  <div class="param-row">
    <span>ISPIN <span class="param-help" title="Spin polarization. ISPIN=1: non-magnetic. ISPIN=2: spin-polarized, required for magnetic systems (Fe, Co, Ni, Mn, etc.)">?</span></span>
    <select bind:value={vasp_ispin}>
      <option value={1}>1 (Non-spin polarized)</option>
      <option value={2}>2 (Spin polarized)</option>
    </select>
  </div>
  {#if vasp_ispin === 2}
    <label class="section-label" style="margin-top: 0.8em">MAGMOM (Initial Magnetic Moments)</label>
    <div class="param-row">
      <span>Enable</span>
      <label class="checkbox-inline">
        <input type="checkbox" bind:checked={vasp_magmom_enabled} />
        Use MAGMOM
      </label>
    </div>
    {#if vasp_magmom_enabled}
      <div class="param-row">
        <span>Mode</span>
        <select bind:value={vasp_magmom_mode} onchange={() => { generated_output = {}; vasp_files = null }}>
          <option value="auto">Auto-generate</option>
          <option value="manual">Manual</option>
        </select>
      </div>

      {#if vasp_magmom_mode === 'auto'}
        <div style="font-size: 0.8em; color: var(--text-color-muted); margin-bottom: 0.4em; padding: 0.3em; background: light-dark(rgba(0,0,0,0.04), rgba(30,35,40,0.3)); border-radius: 4px;">
          Auto-generated from structure elements (default: 0.6 uB for unknown elements)
        </div>
        <div class="param-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
          <input
            type="text"
            readonly
            value={vasp_magmom_value || ''}
            class="text-input"
            style="width: 100%; font-family: monospace; font-size: 0.85em; background: light-dark(rgba(0,0,0,0.06), rgba(30,35,40,0.6));"
            title="Auto-generated MAGMOM string"
          />
        </div>

        {#if unique_elements.length > 0}
          <details class="advanced-details" style="margin-top: 0.5em;">
            <summary>Override Element Values (uB)</summary>
            {#each unique_elements as el}
              {@const db_value = MAGMOM_DATABASE[el]}
              {@const current_value = vasp_magmom_overrides[el] ?? db_value ?? MAGMOM_DEFAULT}
              <div class="param-row" style="margin-bottom: 0.3em;">
                <span style="min-width: 40px; font-weight: 500;">{el}</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={current_value}
                  oninput={(e) => {
                    const v = parseFloat(e.currentTarget.value)
                    if (!isNaN(v)) vasp_magmom_overrides = { ...vasp_magmom_overrides, [el]: v }
                  }}
                  style="width: 80px;"
                />
                {#if db_value !== undefined}
                  <span style="font-size: 0.75em; opacity: 0.6;">DB: {db_value}</span>
                {:else}
                  <span style="font-size: 0.75em; opacity: 0.5;">default</span>
                {/if}
              </div>
            {/each}
          </details>
        {/if}
      {:else}
        <div class="param-row" style="flex-direction: column; align-items: flex-start; gap: 4px;">
          <input
            type="text"
            bind:value={vasp_magmom_custom}
            class="text-input"
            style="width: 100%; font-family: monospace; font-size: 0.85em;"
            placeholder="e.g. 2*3.0 4*0.6 ..."
          />
        </div>
      {/if}
    {/if}
  {/if}

  <!-- K-points section -->
  <div class="param-row">
    <span>IVDW <span class="param-help" title="VDW correction. 12=DFT-D3(BJ) recommended. 0=none">?</span></span>
    <select bind:value={vasp_ivdw}>
      <option value={0}>0 (None)</option>
      <option value={11}>11 (DFT-D3)</option>
      <option value={12}>12 (DFT-D3(BJ))</option>
    </select>
  </div>

  <details class="advanced-details">
    <summary>K-Points</summary>
    <div class="param-row">
      <span>Mode</span>
      <select bind:value={vasp_kpoints_mode} onchange={() => { generated_output = {}; vasp_files = null }}>
        <option value="auto">Auto (KSPACING)</option>
        <option value="preset">Preset Grid</option>
        <option value="custom">Custom Grid</option>
      </select>
    </div>
    {#if vasp_kpoints_mode === 'auto'}
      <div class="param-row">
        <span>KSPACING (1/Å) <span class="param-help" title="K-point spacing per reciprocal axis: N_i = max(1, ceil(|b_i| / KSPACING)). Smaller = denser mesh. ~0.3 fine, 0.5 coarse (VASP default). Large cells naturally give 1x1x1.">?</span></span>
        <input type="number" step="0.05" min="0.1" max="1" bind:value={vasp_kspacing} />
      </div>
    {:else if vasp_kpoints_mode === 'preset'}
      <div class="param-row">
        <span>Grid</span>
        <select bind:value={vasp_kpoints_preset}>
          <option value="1x1x1">1x1x1</option>
          <option value="2x2x1">2x2x1</option>
          <option value="2x2x2">2x2x2</option>
          <option value="3x3x3">3x3x3</option>
          <option value="4x4x4">4x4x4</option>
        </select>
      </div>
    {:else if vasp_kpoints_mode === 'custom'}
      <div class="kpoint-inputs" style="display: flex; gap: 4px; align-items: center;">
        <input type="number" min="1" max="20" bind:value={vasp_kpoints_custom[0]} style="width: 50px;" />
        <span>x</span>
        <input type="number" min="1" max="20" bind:value={vasp_kpoints_custom[1]} style="width: 50px;" />
        <span>x</span>
        <input type="number" min="1" max="20" bind:value={vasp_kpoints_custom[2]} style="width: 50px;" />
      </div>
    {/if}
  </details>

  {#if vasp_calculation === 'opt' || vasp_calculation === 'freq'}
    <details class="advanced-details">
      <summary>Frozen Atoms (Selective Dynamics)</summary>
      {#if constrained_atoms_info.count > 0}
        <span class="constraint-badge">{constrained_atoms_info.count} from structure</span>
      {/if}
      <div class="param-row">
        <span>Mode</span>
        <select bind:value={vasp_fix_mode}>
          <option value="none">None (all atoms free)</option>
          <option value="selected" disabled={selected_indices.length === 0}>Selected ({selected_indices.length})</option>
          <option value="z_below">z &lt; threshold</option>
        </select>
      </div>
      {#if vasp_fix_mode === 'z_below'}
        <div class="param-row"><span>z threshold (Ang)</span><input type="number" step="0.5" bind:value={vasp_fix_z_threshold} /></div>
      {/if}
      {#if vasp_fix_mode !== 'none'}
        <p style="font-size: 0.8em; opacity: 0.8; margin: 0.5em 0 0 0;">
          Frozen atoms will have "F F F" in POSCAR (selective dynamics).
        </p>
      {/if}
    </details>
  {/if}

  <details class="advanced-details">
    <summary>Constant-Potential Method</summary>
    <div class="param-row">
      <span>Method</span>
      <select bind:value={vasp_constant_potential}>
        <option value="none">None</option>
        <option value="tpot">TPOT (VASPsol)</option>
        <option value="cpvasp">CP-VASP (VASPsol++)</option>
      </select>
    </div>
    {#if vasp_constant_potential !== 'none'}
      <div class="param-row"><span>Voltage vs SHE (V)</span><input type="number" step="0.05" bind:value={vasp_cp_voltage_she} /></div>
      <div class="param-row"><span>SHE ref (V)</span><input type="number" step="0.1" bind:value={vasp_cp_she_ref} /></div>
      <div class="param-row"><span>NELECT (step 1)</span><input type="number" bind:value={vasp_cp_nelect} placeholder="optional" /></div>
    {/if}
    {#if vasp_constant_potential === 'tpot'}
      <div class="param-row"><span>TPOT_VDIFF</span><input type="number" step="0.001" bind:value={vasp_tpot_vdiff} /></div>
      <div class="param-row"><span>TPOT_VRATE</span><input type="number" step="0.1" bind:value={vasp_tpot_vrate} /></div>
      <div class="param-row"><span>TPOT_VRATELIM</span><input type="number" step="0.01" bind:value={vasp_tpot_vratelim} /></div>
      <div class="param-row"><span>TPOT_ELECTSTEP</span><input type="number" step="0.01" bind:value={vasp_tpot_electstep} /></div>
      <div class="param-row"><span>EB_K (dielectric)</span><input type="number" step="0.1" bind:value={vasp_tpot_eb_k} /></div>
      <div class="param-row"><span>LAMBDA_D_K (Å)</span><input type="number" step="0.1" bind:value={vasp_tpot_lambda_d_k} /></div>
      <div class="param-row"><span>TAU</span><input type="number" step="0.1" bind:value={vasp_tpot_tau} /></div>
    {:else if vasp_constant_potential === 'cpvasp'}
      <div class="param-row"><span>NESCHEME</span><select bind:value={vasp_cpvasp_nescheme}><option value={2}>2 (capacitor)</option><option value={5}>5 (Stern)</option></select></div>
      <div class="param-row"><span>NEADJUST</span><input type="number" min="0" max="2" bind:value={vasp_cpvasp_neadjust} /></div>
      <div class="param-row"><span>FERMICONVERGE</span><input type="number" step="0.001" bind:value={vasp_cpvasp_fermiconverge} /></div>
      {#if vasp_cpvasp_nescheme === 2}
        <div class="param-row"><span>CAP_MAX</span><input type="number" step="0.1" bind:value={vasp_cpvasp_cap_max} /></div>
      {:else if vasp_cpvasp_nescheme === 5}
        <div class="param-row"><span>T_ETA (K)</span><input type="number" bind:value={vasp_cpvasp_t_eta} /></div>
        <div class="param-row"><span>ETA_LENGTH (Å)</span><input type="number" step="0.5" bind:value={vasp_cpvasp_eta_length} /></div>
      {/if}
      <div class="param-row"><span>C_MOLAR (mol/L)</span><input type="number" step="0.1" bind:value={vasp_cpvasp_c_molar} /></div>
      <div class="param-row"><span>R_ION (Å)</span><input type="number" step="0.5" bind:value={vasp_cpvasp_r_ion} /></div>
    {/if}
  </details>

  <div class="button-group">
    <button class="generate-btn" onclick={generate_vasp} disabled={vasp_generating}>
      <Icon icon="Zap" style="width: 14px; height: 14px" />
      {vasp_generating ? 'Generating...' : 'Generate'}
    </button>
  </div>

  {#if vasp_files?.potcar_info}
    <div style="margin-top: 0.8em; padding: 0.5em; background: light-dark(rgba(59,130,246,0.08), rgba(59,130,246,0.1)); border-radius: 4px; font-size: 0.85em;">
      <strong>Note:</strong> POTCAR file must be generated separately for elements: {vasp_files.potcar_info.elements.join(', ')}
    </div>
  {/if}
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
  .mode-toggle { padding: 2px 6px; font-size: 0.85em; background: var(--btn-bg, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.1))); border: none; border-radius: 3px; cursor: pointer; white-space: nowrap; }
  .mode-toggle:hover { background: var(--btn-bg-hover, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.2))); }
  .ediff-input { width: 80px !important; font-family: monospace; }
  .kpoint-inputs { display: flex; gap: 3px; align-items: center; }
  .kpoint-inputs input[type="number"] { width: 32px !important; text-align: center; }
  .checkbox-inline { display: flex; align-items: center; gap: 4px; }
  .advanced-details { background: light-dark(rgba(0,0,0,0.02), rgba(255,255,255,0.02)); border-radius: 4px; padding: 0.4em; margin: 0.5em 0; }
  .constraint-badge { display: inline-block; background: rgba(59,130,246,0.3); color: var(--accent-color); font-size: 0.85em; padding: 2px 6px; border-radius: 8px; margin-bottom: 0.3em; }
  .button-group { margin-top: 0.6em; }
  .generate-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; background: var(--accent-color, #007acc); color: white; border: none; border-radius: 4px; cursor: pointer; }
  .generate-btn:hover { filter: brightness(1.1); }
  .wrap-prompt-btn { display: block; width: 100%; padding: 5px 10px; margin-top: 0.6em; background: var(--accent-color, #007acc); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 0.9em; }
  .wrap-prompt-btn:hover { filter: brightness(1.1); }
</style>

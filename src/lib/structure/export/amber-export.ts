/**
 * AMBER mdin input file generation (pure frontend, no backend needed).
 *
 * Mirrors server/workflow/engines/amber.py:_build_mdin() logic.
 */

export interface AmberParams {
  title: string
  job_type: 'md' | 'minimize'
  // MD params
  nstlim: number
  dt: number
  // Minimization params
  maxcyc: number
  ncyc: number
  drms: number
  // Restart
  irest: number
  // Thermostat
  ntt: number
  temp0: number
  tempi: number
  gamma_ln: number
  // Periodicity
  ntb: number
  cut: number
  // SHAKE
  ntc: number
  ntf: number
  // Output
  ntpr: number
  ntwe: number
  ntwx: number
  ntwv: number
  ntwr: number
  ioutfm: number
  ntxo: number
  // Barostat
  ntp: number
  barostat: number
  pres0: number
  // ML/MM
  use_mlp: boolean
  mlp_model: string
  animask: string
  mlp_shake: number
  gpu_id: number
  mlp_embedding: number
  mlp_multipole: number
  mlp_polar: number
  adjust_q: number
  // Extra
  extra_cntrl: string
  extra_mlp: string
}

export type AmberPreset = 'mlmm_md' | 'mlmm_min' | 'classical_md' | 'classical_min' | 'nvt_langevin' | 'npt_langevin'

export const MLP_MODELS: Record<string, string> = {
  macepol_l: `macepol_l`,
  macepol_m: `macepol_m`,
  macepol_s: `macepol_s`,
  maceomol_v2: `maceomol_v2`,
  mace_off23_large: `MACE-OFF23_large`,
  mace_off23_medium: `MACE-OFF23_medium`,
  mace_off23_small: `MACE-OFF23_small`,
  aimnet2: `aimnet2`,
  aimnet2nse: `aimnet2nse`,
  ani2x: `ani2x_model`,
  ani1_xnr: `ani1_xnr`,
  spookynet: `spookynet`,
  egret_s: `egret-s`,
}

export function apply_amber_preset(preset: AmberPreset): Partial<AmberParams> {
  switch (preset) {
    case 'mlmm_md':
      return {
        job_type: 'md', use_mlp: true, nstlim: 5000000, dt: 0.0001,
        ntt: 0, ntb: 0, cut: 9999.0, ntc: 1, ntf: 1,
        irest: 1, mlp_model: 'macepol_l',
      }
    case 'mlmm_min':
      return {
        job_type: 'minimize', use_mlp: true, maxcyc: 5000, ncyc: 2500,
        ntb: 0, cut: 9999.0, ntc: 1, ntf: 1,
        irest: 0, mlp_model: 'macepol_l',
      }
    case 'classical_md':
      return {
        job_type: 'md', use_mlp: false, nstlim: 500000, dt: 0.002,
        ntt: 3, temp0: 300, gamma_ln: 2.0, ntb: 1, cut: 10.0,
        ntc: 2, ntf: 2, irest: 1,
      }
    case 'classical_min':
      return {
        job_type: 'minimize', use_mlp: false, maxcyc: 10000, ncyc: 5000,
        ntb: 1, cut: 10.0, ntc: 1, ntf: 1, irest: 0,
      }
    case 'nvt_langevin':
      return {
        job_type: 'md', use_mlp: false, nstlim: 500000, dt: 0.002,
        ntt: 3, temp0: 300, gamma_ln: 2.0, ntb: 1, cut: 10.0,
        ntc: 2, ntf: 2, ntp: 0, irest: 1,
      }
    case 'npt_langevin':
      return {
        job_type: 'md', use_mlp: false, nstlim: 500000, dt: 0.002,
        ntt: 3, temp0: 300, gamma_ln: 2.0, ntb: 2, cut: 10.0,
        ntc: 2, ntf: 2, ntp: 1, barostat: 2, pres0: 1.0, irest: 1,
      }
  }
}

/** Generate AMBER mdin content string. */
export function generate_amber_mdin(params: AmberParams): string {
  const lines: string[] = []

  lines.push(params.title)

  // &cntrl namelist
  const cntrl: [string, string | number][] = []

  if (params.job_type === 'minimize') {
    cntrl.push(['imin', 1])
    cntrl.push(['maxcyc', params.maxcyc])
    cntrl.push(['ncyc', params.ncyc])
    cntrl.push(['drms', params.drms])
  } else {
    cntrl.push(['imin', 0])
    cntrl.push(['nstlim', params.nstlim])
    cntrl.push(['dt', params.dt])
  }

  // Restart
  cntrl.push(['irest', params.irest])
  cntrl.push(['ntx', params.irest === 1 ? 5 : 1])

  // Thermostat
  cntrl.push(['ntt', params.ntt])
  if (params.ntt >= 1 && params.ntt <= 3) {
    cntrl.push(['temp0', params.temp0])
    cntrl.push(['tempi', params.tempi])
  }
  if (params.ntt === 3) {
    cntrl.push(['gamma_ln', params.gamma_ln])
  }

  // Periodicity
  cntrl.push(['ntb', params.ntb])
  cntrl.push(['cut', params.cut])

  // SHAKE
  cntrl.push(['ntc', params.ntc])
  cntrl.push(['ntf', params.ntf])

  // Output
  cntrl.push(['ntpr', params.ntpr])
  cntrl.push(['ntwe', params.ntwe])
  cntrl.push(['ntwx', params.ntwx])
  cntrl.push(['ntwv', params.ntwv])
  cntrl.push(['ntwr', params.ntwr])
  cntrl.push(['ioutfm', params.ioutfm])
  cntrl.push(['ntxo', params.ntxo])

  // ML potential
  if (params.use_mlp) {
    cntrl.push(['ifmlp', 1])
  }

  // Barostat
  if (params.ntp > 0) {
    cntrl.push(['ntp', params.ntp])
    cntrl.push(['barostat', params.barostat])
    cntrl.push(['pres0', params.pres0])
  }

  lines.push(` &cntrl`)
  for (const [key, val] of cntrl) {
    lines.push(`  ${key} = ${val},`)
  }
  if (params.extra_cntrl.trim()) {
    for (const raw of params.extra_cntrl.trim().split('\n')) {
      const l = raw.trim()
      if (l) lines.push(`  ${l.endsWith(',') ? l : l + ','}`)
    }
  }
  lines.push(` /`)

  // &mlp namelist
  if (params.use_mlp) {
    const mlp: [string, string | number][] = []
    mlp.push(['mlp_model', `'${params.mlp_model}'`])
    if (params.animask.trim()) {
      mlp.push(['animask', `"${params.animask}"`])
    }
    mlp.push(['mlp_shake', params.mlp_shake])
    mlp.push(['gpu_id', params.gpu_id])
    mlp.push(['mlp_embedding', params.mlp_embedding])
    mlp.push(['mlp_multipole', params.mlp_multipole])
    mlp.push(['mlp_polar', params.mlp_polar])
    mlp.push(['adjust_q', params.adjust_q])

    lines.push(`&mlp`)
    for (const [key, val] of mlp) {
      lines.push(`${key}=${val},`)
    }
    if (params.extra_mlp.trim()) {
      for (const raw of params.extra_mlp.trim().split('\n')) {
        const l = raw.trim()
        if (l) lines.push(`${l.endsWith(',') ? l : l + ','}`)
      }
    }
    lines.push(`/`)
  }

  return lines.join('\n') + '\n'
}

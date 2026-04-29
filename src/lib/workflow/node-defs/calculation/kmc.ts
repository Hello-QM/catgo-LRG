import type { NodeDefinition } from '../../workflow-types'

export const KMC_NODE: NodeDefinition = {
  type: `kmc`,
  label: `KMC / Microkinetic`,
  color: `#059669`,
  icon: `\u{1F3B2}`,
  category: `Calculation`,
  description: `Kinetic Monte Carlo or mean-field microkinetic simulation (HPC)`,
  inputs: [`model`, `barriers`],
  outputs: [`coverages`, `tof`, `trajectory`],
  default_params: {
    mode: `both`,
    cycle_mode: true,
    temperature: 300,
    potential: 0.0,
    lattice_size: 20,
    kmc_steps: 500000,
    scan_type: `none`,
    scan_u_min: -0.5,
    scan_u_max: -3.0,
    scan_t_min: 250,
    scan_t_max: 500,
    scan_steps: 20,
    model_json: ``,
  },
  help_text: `**KMC / Microkinetic Modeling** \u2014 Runs on HPC using the mykmc-rs Rust binary.

**Input files generated:**
- \`model.json\` \u2014 KMC model definition (species, rate expressions, lattice)
- \`run_kmc.sh\` \u2014 Wrapper script for the Rust binary

**Modes:**
- **KMC**: Stochastic lattice simulation (BKL rejection-free, ~24\u00D7 faster in Rust)
- **MKM**: Deterministic mean-field ODE solver
- **Both**: Run both sequentially

**Prerequisites:** Compile mykmc-rs on HPC: \`cd KMC/mykmc-rs && cargo build --release\``,
  param_schema: [
    {
      key: `mode`, label: `Simulation Mode`, type: `select`, default: `both`, group: `Simulation`,
      options: [
        { label: `KMC only`, value: `kmc` },
        { label: `MKM only (fast)`, value: `mkm` },
        { label: `Both KMC + MKM`, value: `both` },
      ],
      help: `KMC = stochastic lattice. MKM = mean-field ODE. Both = run both for comparison.`,
    },
    {
      key: `cycle_mode`, label: `Cycle Mode`, type: `boolean`, default: true, group: `Simulation`,
      help: `Cycle mode: 9 species, pure chemistry (no adsorption/desorption). Full mode: 11 species with Hertz-Knudsen adsorption. Cycle mode is faster for mechanism screening.`,
    },
    // ── Conditions ──
    {
      key: `temperature`, label: `Temperature (K)`, type: `number`, default: 300, group: `Conditions`,
      min: 100, max: 2000, step: 50,
      help: `Simulation temperature in Kelvin.`,
    },
    {
      key: `potential`, label: `Potential (V vs RHE)`, type: `number`, default: 0.0, group: `Conditions`,
      min: -5.0, max: 2.0, step: 0.1,
      help: `Applied electrochemical potential (V vs RHE). Negative = reductive.`,
    },
    // ── KMC settings ──
    {
      key: `lattice_size`, label: `Lattice Size`, type: `number`, default: 20, group: `KMC`,
      min: 5, max: 200, step: 5,
      show_if: { key: `mode`, values: [`kmc`, `both`] },
      help: `Side length of 2D square lattice. Total sites = size\u00B2. 20\u201350 typical.`,
    },
    {
      key: `kmc_steps`, label: `KMC Steps`, type: `number`, default: 500000, group: `KMC`,
      min: 10000, max: 100000000, step: 100000,
      show_if: { key: `mode`, values: [`kmc`, `both`] },
      help: `Total KMC steps. Rust binary: 500k steps \u2248 seconds, 10M \u2248 minutes.`,
    },
    // ── Scan options ──
    {
      key: `scan_type`, label: `Parameter Scan`, type: `select`, default: `none`, group: `Scan`,
      options: [
        { label: `None (single point)`, value: `none` },
        { label: `Potential scan`, value: `potential` },
        { label: `Temperature scan`, value: `temperature` },
      ],
      help: `Scan across potentials or temperatures. Results written to .dat files.`,
    },
    {
      key: `scan_u_min`, label: `U min (V)`, type: `number`, default: -0.5, group: `Scan`,
      min: -5.0, max: 2.0, step: 0.1,
      show_if: { key: `scan_type`, values: [`potential`] },
    },
    {
      key: `scan_u_max`, label: `U max (V)`, type: `number`, default: -3.0, group: `Scan`,
      min: -5.0, max: 2.0, step: 0.1,
      show_if: { key: `scan_type`, values: [`potential`] },
    },
    {
      key: `scan_t_min`, label: `T min (K)`, type: `number`, default: 250, group: `Scan`,
      min: 100, max: 2000, step: 50,
      show_if: { key: `scan_type`, values: [`temperature`] },
    },
    {
      key: `scan_t_max`, label: `T max (K)`, type: `number`, default: 500, group: `Scan`,
      min: 100, max: 2000, step: 50,
      show_if: { key: `scan_type`, values: [`temperature`] },
    },
    {
      key: `scan_steps`, label: `Scan Points`, type: `number`, default: 20, group: `Scan`,
      min: 5, max: 100, step: 5,
      show_if: { key: `scan_type`, values: [`potential`, `temperature`] },
    },
    // ── Model definition ──
    {
      key: `model_json`, label: `Model JSON`, type: `text`, default: ``, group: `Model`,
      help: `KMC model in mykmc JSON format: {meta, species, parameters, processes, lattice}. Paste from C-N coupling network tool or from the KMC package examples.`,
    },
  ],
}

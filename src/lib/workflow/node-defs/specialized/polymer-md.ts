import type { NodeDefinition } from '../../workflow-types'

export const polymer_md: NodeDefinition = {
  type: `polymer_md`,
  label: `Polymer MD`,
  color: `#b91c1c`,
  icon: `\u{1F9EA}`,
  category: `Tools`,
  description: `Multi-stage polymer MD workflow (Kremer-Grest)`,
  inputs: [`structure`, `restart`],
  outputs: [`trajectory`, `log`, `restart`],
  default_params: {
    workflow_mode: `polymer_kg`,
    pair_style: `lj/cut 2.5`,
    pair_coeff: `* * 1.0 1.0`,
    bond_style: `fene`,
    bond_coeff: `1 30.0 1.5 1.0 1.0`,
    temperature: 298.15,
    pressure: 1.0,
    timestep: 0.005,
    gen_steps_nvt: 5000,
    gen_steps_npt: 50000,
    equil_steps: 100000,
    prod_steps: 100000,
    prod_dump_freq: 1000,
  },
  help_text: `**Polymer MD** — Multi-stage molecular dynamics for polymer systems.

Runs a complete polymer MD workflow using LAMMPS with multiple sequential stages.`,
  param_schema: [
    {
      key: `workflow_mode`, label: `Workflow Mode`, type: `select`, default: `polymer_kg`, group: `Workflow`,
      options: [
        { label: `Kremer-Grest (bead-spring)`, value: `polymer_kg` },
        { label: `All-Atom Polymer`, value: `all_atom` },
        { label: `Custom Multi-Stage`, value: `custom` },
      ],
    },
    {
      key: `lmp_command`, label: `LAMMPS Command`, type: `text`, default: `lmp_serial`, group: `Execution`,
    },
    {
      key: `pair_style`, label: `Pair Style`, type: `select`, default: `lj/cut 2.5`, group: `Potential`,
      options: [
        { label: `Lennard-Jones (lj/cut)`, value: `lj/cut 2.5` },
        { label: `OPLS-AA (opls)`, value: `opls` },
        { label: `PCFF (pcff)`, value: `pcff` },
        { label: `COMPASS (class2)`, value: `class2` },
      ],
    },
    {
      key: `pair_coeff`, label: `Pair Coefficients`, type: `text`, default: `* * 1.0 1.0`, group: `Potential`,
    },
    {
      key: `bond_style`, label: `Bond Style`, type: `select`, default: `fene`, group: `Potential`,
      options: [
        { label: `FENE (Kremer-Grest)`, value: `fene` },
        { label: `Harmonic`, value: `harmonic` },
        { label: `Class2`, value: `class2` },
      ],
    },
    {
      key: `bond_coeff`, label: `Bond Coefficients`, type: `text`, default: `1 30.0 1.5 1.0 1.0`, group: `Potential`,
    },
    {
      key: `temperature`, label: `Temperature (K)`, type: `number`, default: 300, group: `MD`,
      min: 1, max: 10000, step: 10,
    },
    {
      key: `pressure`, label: `Pressure (atm)`, type: `number`, default: 1.0, group: `MD`,
      min: 0, max: 1000, step: 0.1,
    },
    {
      key: `timestep`, label: `Timestep (ps)`, type: `number`, default: 0.001, group: `MD`,
      min: 0.0001, max: 0.01, step: 0.0005,
    },
    {
      key: `gen_steps_nvt`, label: `Generation NVT Steps`, type: `number`, default: 5000, group: `Stages`,
      min: 1000, max: 100000, step: 1000,
    },
    {
      key: `gen_steps_npt`, label: `Generation NPT Steps`, type: `number`, default: 50000, group: `Stages`,
      min: 1000, max: 1000000, step: 10000,
    },
    {
      key: `equil_steps`, label: `Equilibration Steps`, type: `number`, default: 100000, group: `Stages`,
      min: 1000, max: 10000000, step: 10000,
    },
    {
      key: `prod_steps`, label: `Production Steps`, type: `number`, default: 100000, group: `Stages`,
      min: 1000, max: 10000000, step: 10000,
    },
    {
      key: `prod_dump_freq`, label: `Production Dump Freq`, type: `number`, default: 1000, group: `Output`,
      min: 100, max: 100000, step: 100,
    },
    {
      key: `write_restart`, label: `Write Restart File`, type: `boolean`, default: true, group: `Output`,
    },
  ],
}

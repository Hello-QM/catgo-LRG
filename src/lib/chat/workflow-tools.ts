/**
 * Anthropic tool definitions for workflow operations.
 * Follows the same pattern as tools.ts (structure viewer tools).
 */

import type { ToolDefinition } from './tools'

// ─── SKILL path mappings for calculation types ───

/** Maps individual task types to their SKILL.md path under server/catgo/workflow/skills/ */
export const TASK_TYPE_TO_SKILL: Record<string, string> = {
  'geo_opt': 'vasp/relax',
  'vasp_relax': 'vasp/relax',
  'freq': 'vasp/freq',
  'vasp_freq': 'vasp/freq',
  'single_point': 'vasp/static',
  'vasp_static': 'vasp/static',
  'slab_gen': 'structure/slab',
  'adsorbate_place': 'structure/adsorbate',
  'gibbs_energy': 'analysis/gibbs',
  'free_energy': 'analysis/gibbs',
}

/** Maps reaction/pipeline types to their SKILL.md path */
export const REACTION_TYPE_TO_SKILL: Record<string, string> = {
  'oer': 'analysis/oer',
  'her': 'analysis/her',
  'co2rr': 'analysis/co2rr',
  'nrr': 'analysis/nrr',
}

export const WORKFLOW_TOOL_DEFINITIONS: ToolDefinition[] = [
  // ─── Pre-flight guideline tool ───
  {
    name: `get_calculation_guidelines`,
    description: `Read the SKILL guidelines and discussion checkpoints for a calculation type before building a workflow. MUST be called before creating geo_opt, freq, slab_gen, adsorbate_place, or reaction (OER/HER/CO2RR/NRR) workflows. Returns required discussion points (🔴 items) that must be confirmed with the user before proceeding.`,
    input_schema: {
      type: `object`,
      properties: {
        task_type: {
          type: `string`,
          description: `The calculation or reaction type: geo_opt, vasp_relax, freq, vasp_static, single_point, slab_gen, adsorbate_place, gibbs_energy, free_energy, oer, her, co2rr, nrr.`,
        },
      },
      required: [`task_type`],
    },
  },

  // ─── Read-only tools (work without editor open) ───
  {
    name: `list_workflows`,
    description: `List all saved workflows. Returns workflow names, IDs, statuses, and step counts.`,
    input_schema: {
      type: `object`,
      properties: {},
    },
  },
  {
    name: `get_workflow_status`,
    description: `Get the current status of the active workflow, including all node statuses. Use this to check progress during execution.`,
    input_schema: {
      type: `object`,
      properties: {},
    },
  },
  {
    name: `get_step_error`,
    description: `Get detailed error information for a failed workflow step. Use this to diagnose why a step failed.`,
    input_schema: {
      type: `object`,
      properties: {
        step_id: {
          type: `string`,
          description: `The node/step ID to get error details for.`,
        },
      },
      required: [`step_id`],
    },
  },
  {
    name: `suggest_params`,
    description: `Get parameter schema and current values for a node type, along with structure context for reasoning about optimal parameter choices. Returns the full param definitions so you can make informed suggestions.`,
    input_schema: {
      type: `object`,
      properties: {
        node_type: {
          type: `string`,
          description: `The workflow node type (e.g. "vasp_relax", "vasp_static", "mlp_relax").`,
        },
        node_id: {
          type: `string`,
          description: `Optional: specific node ID to include its current parameter values.`,
        },
      },
      required: [`node_type`],
    },
  },

  {
    name: `get_node_definitions`,
    description: `List all available workflow node types with their parameters, inputs, outputs, and categories. Essential for discovering what nodes exist when building a workflow. Categories include: INPUT, DFT, ML, NRR, SEMI-EMPIRICAL, TS, LOGIC, ANALYSIS.`,
    input_schema: {
      type: `object`,
      properties: {
        category: {
          type: `string`,
          description: `Optional filter by category (e.g. "DFT", "ML", "INPUT"). Returns all if omitted.`,
        },
      },
    },
  },
  {
    name: `get_workflow_templates`,
    description: `List available workflow templates with descriptions. Templates provide pre-built workflow patterns (e.g. bulk relaxation, NRR screening, convergence testing) that can be used with create_workflow.`,
    input_schema: {
      type: `object`,
      properties: {},
    },
  },
  {
    name: `validate_workflow`,
    description: `Validate the current workflow graph for errors before running. MUST be called before run_workflow. Fix ALL warnings before proceeding — do not ignore them.`,
    input_schema: {
      type: `object`,
      properties: {},
    },
  },

  // ─── Mutation tools (require active workflow editor) ───
  {
    name: `create_workflow`,
    description: `Create a new workflow or from a template. Returns the new workflow ID. IMPORTANT: create auto-adds a structure_input node that captures the viewer structure — do NOT add another. After create, call get_workflow_status to confirm the initial graph.`,
    input_schema: {
      type: `object`,
      properties: {
        name: {
          type: `string`,
          description: `Name for the new workflow.`,
        },
        template_id: {
          type: `string`,
          description: `Optional template ID to create from. Use list_workflows or suggest a common pattern.`,
        },
      },
      required: [`name`],
    },
  },
  {
    name: `plan_and_build_workflow`,
    description: `🚀 PREFERRED: Build an entire workflow in ONE call. Provide a simplified plan (node types + connections) and the system deterministically builds the full graph with correct IDs, handles, defaults, and layout. Use this instead of create→add_node→connect→set_params sequences. Connections reference nodes by label or index (0-based). Handle routing is automatic.

Example: {name: "VASP Relax+DOS", nodes: [{type: "structure_input", label: "input"}, {type: "geo_opt", label: "relax", software: "vasp"}, {type: "single_point", label: "static", software: "vasp", params: {LORBIT: 11}}], connections: [[0,1], [1,2]]}`,
    input_schema: {
      type: `object`,
      properties: {
        name: {
          type: `string`,
          description: `Name for the new workflow.`,
        },
        nodes: {
          type: `array`,
          description: `Array of node specs: {type: string, label?: string, software?: string, params?: {...}}. Omit defaults — they are auto-applied.`,
          items: {
            type: `object`,
            properties: {
              type: { type: `string`, description: `Node type (e.g. "geo_opt", "single_point", "freq", "slab_gen", "adsorbate_place", "gibbs_energy", "free_energy")` },
              label: { type: `string`, description: `Short label for referencing in connections (also used as display label)` },
              software: { type: `string`, description: `Software shorthand (e.g. "vasp", "orca", "cp2k"). Applied as params.software.` },
              params: { type: `object`, description: `Override default parameters. Only specify non-default values.` },
            },
            required: [`type`],
          },
        },
        connections: {
          type: `array`,
          description: `Array of connections. Each is [from_index_or_label, to_index_or_label] or [from, to, "handle_hint"]. Handle hint is the output name (e.g. "energy", "frequencies") for multi-output nodes. Simple structure→structure links need no hint.`,
          items: {},
        },
        material_ids: {
          type: `array`,
          items: { type: `string` },
          description: `Optional Materials Project IDs to auto-fetch structures for structure_input nodes.`,
        },
      },
      required: [`name`, `nodes`],
    },
  },
  {
    name: `add_node`,
    description: `Add a computation node to the active workflow. Common types: vasp_relax, vasp_static, vasp_md, mlp_relax, mlp_md, condition, loop, merge. NOTE: structure_input is auto-added by create — do NOT add duplicates.`,
    input_schema: {
      type: `object`,
      properties: {
        node_type: {
          type: `string`,
          description: `The node type to add (e.g. "vasp_relax", "structure_input").`,
        },
      },
      required: [`node_type`],
    },
  },
  {
    name: `remove_node`,
    description: `Remove a node from the active workflow. Also removes all edges connected to it.`,
    input_schema: {
      type: `object`,
      properties: {
        node_id: {
          type: `string`,
          description: `The ID of the node to remove.`,
        },
      },
      required: [`node_id`],
    },
  },
  {
    name: `connect_nodes`,
    description: `Add a directed edge between two nodes in the workflow. ALWAYS pass from_handle and to_handle explicitly (only omit for simple structure→structure links). Dedup checks (from, to, fromH, toH) — same node pair CAN have edges on different handles.`,
    input_schema: {
      type: `object`,
      properties: {
        from_node_id: {
          type: `string`,
          description: `The source node ID (output side).`,
        },
        to_node_id: {
          type: `string`,
          description: `The target node ID (input side).`,
        },
        from_handle: {
          type: `string`,
          description: `Output handle name on the source node (e.g. "structure", "energy", "trajectory"). Defaults to first output if omitted.`,
        },
        to_handle: {
          type: `string`,
          description: `Input handle name on the target node (e.g. "structure", "restart"). Defaults to first input if omitted.`,
        },
      },
      required: [`from_node_id`, `to_node_id`],
    },
  },
  {
    name: `set_node_params`,
    description: `Update parameters on a workflow node. Merges with existing params. Common VASP params: ENCUT, EDIFF, ISIF, NSW, kpoints, ISMEAR, ISPIN.`,
    input_schema: {
      type: `object`,
      properties: {
        node_id: {
          type: `string`,
          description: `The node ID to update parameters on.`,
        },
        params: {
          type: `object`,
          description: `Key-value pairs of parameters to set or update.`,
        },
      },
      required: [`node_id`, `params`],
    },
  },
  {
    name: `run_workflow`,
    description: `Run the active workflow. WARNING: This IMMEDIATELY starts execution (does NOT open a UI dialog). Always validate_workflow first. For HPC, ask user for cluster settings before running.`,
    input_schema: {
      type: `object`,
      properties: {},
    },
  },
  {
    name: `pause_workflow`,
    description: `Pause the currently running workflow.`,
    input_schema: {
      type: `object`,
      properties: {},
    },
  },

  // ─── Retry / batch tools ───
  {
    name: `retry_step`,
    description: `Reset a failed workflow step and all downstream nodes to pending, then resume. Use when a step failed and user wants to rerun from that point.`,
    input_schema: {
      type: `object`,
      properties: {
        workflow_id: { type: `string`, description: `Workflow ID` },
        step_id: { type: `string`, description: `Step ID to retry from` },
      },
      required: [`workflow_id`, `step_id`],
    },
  },
  {
    name: `get_batch_status`,
    description: `Get batch job progress summary: total/completed/failed/running counts and energy statistics.`,
    input_schema: {
      type: `object`,
      properties: {
        workflow_id: { type: `string`, description: `Workflow ID` },
        step_id: { type: `string`, description: `Batch step ID` },
      },
      required: [`workflow_id`, `step_id`],
    },
  },

  // ─── Catalysis computation tools ───
  {
    name: `compute_oer_overpotential`,
    description: `Compute OER (Oxygen Evolution Reaction) theoretical overpotential from adsorption free energies using the CHE model. Returns overpotential (V), limiting step, and step energies.`,
    input_schema: {
      type: `object`,
      properties: {
        dG_OH: { type: `number`, description: `Adsorption free energy of *OH (eV)` },
        dG_O: { type: `number`, description: `Adsorption free energy of *O (eV)` },
        dG_OOH: { type: `number`, description: `Adsorption free energy of *OOH (eV)` },
      },
      required: [`dG_OH`, `dG_O`, `dG_OOH`],
    },
  },
  {
    name: `compute_free_energy`,
    description: `Compute Gibbs free energy with thermodynamic corrections: G = E_DFT + ZPE - TS. Input DFT energy and vibrational frequencies.`,
    input_schema: {
      type: `object`,
      properties: {
        e_dft: { type: `number`, description: `DFT total energy in eV` },
        frequencies_cm: {
          type: `array`,
          items: { type: `number` },
          description: `Vibrational frequencies in cm^-1`,
        },
        temperature: { type: `number`, description: `Temperature in K (default 298.15)` },
      },
      required: [`e_dft`],
    },
  },
  {
    name: `list_vasp_presets`,
    description: `List available VASP calculation presets (relax, static, slab_relax, freq, band, md) with their INCAR parameters.`,
    input_schema: {
      type: `object`,
      properties: {},
    },
  },

  // ─── Workflow import tools ───
  {
    name: `import_atomate2_template`,
    description: `Import a pre-built atomate2 workflow template into a new CatGo workflow. Creates a complete workflow with nodes and edges ready to run. Available templates: atomate2-double-relax, atomate2-band-structure, atomate2-hse-band-structure, atomate2-elastic, atomate2-phonon, atomate2-eos, atomate2-dielectric, atomate2-optics, atomate2-mlp-vasp-refinement, atomate2-mlp-phonon.`,
    input_schema: {
      type: `object`,
      properties: {
        template_id: {
          type: `string`,
          description: `Template ID, e.g. 'atomate2-double-relax', 'atomate2-band-structure', 'atomate2-elastic', 'atomate2-phonon', 'atomate2-eos'.`,
        },
      },
      required: [`template_id`],
    },
  },
  {
    name: `import_quacc_template`,
    description: `Import a pre-built quacc workflow template into a new CatGo workflow. Creates a complete workflow with nodes and edges ready to run. Available templates: quacc-slab-relax, quacc-band-structure, quacc-mlp-phonon, quacc-mlp-elastic, quacc-mlp-dft-refine, quacc-xtb-orca, quacc-qe-bands, quacc-qe-phonon.`,
    input_schema: {
      type: `object`,
      properties: {
        template_id: {
          type: `string`,
          description: `Template ID, e.g. 'quacc-mlp-phonon', 'quacc-slab-relax', 'quacc-qe-bands'.`,
        },
      },
      required: [`template_id`],
    },
  },
  {
    name: `create_screening_workflow`,
    description: `Create a high-throughput screening workflow from a template pattern. Builds: structure_input → batch_generate → map → [calculation nodes] → aggregate. Supports screening types: catalyst (adsorbate placement), dopant (element substitution), surface (Miller indices), eos (lattice scan), mlp_prescreen (two-stage MLP+DFT). Example: create_screening_workflow({screening_type: "dopant", software: "vasp", elements: "Ti,V,Cr,Mn,Fe"}).`,
    input_schema: {
      type: `object`,
      properties: {
        screening_type: {
          type: `string`,
          enum: [`catalyst`, `dopant`, `surface`, `eos`, `mlp_prescreen`],
          description: `Type of screening: catalyst, dopant, surface, eos, or mlp_prescreen.`,
        },
        software: {
          type: `string`,
          enum: [`vasp`, `cp2k`, `orca`, `mlp`, `xtb`],
          description: `Calculation software to use.`,
        },
        elements: {
          type: `string`,
          description: `Comma-separated elements for dopant screening (e.g. "Ti,V,Cr,Mn,Fe").`,
        },
        miller_indices: {
          type: `string`,
          description: `Comma-separated Miller indices for surface screening (e.g. "100,110,111").`,
        },
        adsorbate: {
          type: `string`,
          description: `Adsorbate formula for catalyst screening (e.g. "OH", "CO", "N2").`,
        },
      },
      required: [`screening_type`, `software`],
    },
  },
]

/** Set of workflow tool names for quick lookup */
export const WORKFLOW_TOOL_NAMES = new Set(WORKFLOW_TOOL_DEFINITIONS.map((t) => t.name))

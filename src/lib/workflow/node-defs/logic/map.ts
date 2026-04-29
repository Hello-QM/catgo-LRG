import type { NodeDefinition } from '../../workflow-types'

export const map: NodeDefinition = {
  type: `map`,
  label: `Map (Parallel)`,
  color: `#6366f1`,
  icon: `\u26A1`,
  category: `Logic`,
  description: `Run downstream workflow on each input structure in parallel`,
  inputs: [`structures`],
  outputs: [`results`],
  is_fan_out: true,
  default_params: {
    max_parallel: 0,
    fail_strategy: `continue`,
    retry_failed: false,
  },
  help_text: `**Map (Parallel)** — Fan-out node for high-throughput screening.

## How it works

The Map node receives a **list of structures** (typically from a Batch Generate node) and runs the downstream sub-workflow on **each structure independently and in parallel**.

### Execution flow
1. Receives N structures from the upstream node
2. For each structure, creates an independent **branch**
3. Each branch executes the sub-workflow (all nodes between Map and Aggregate)
4. Branches run concurrently, controlled by Max Parallel Jobs
5. Results are collected by the downstream **Aggregate & Filter** node

### Parameters

- **Max Parallel Jobs**: Limits how many branches run simultaneously.
  Set to \`0\` for unlimited (all branches start at once).
  Use a limit (e.g. \`10\`) to avoid overwhelming the HPC queue.

- **On Failure**: What happens when a branch fails:
  - *Continue others*: remaining branches keep running; failed branches are marked in the results table
  - *Abort all*: cancel all running branches immediately (useful for expensive calculations)

- **Auto-retry Failed**: Automatically resubmit failed branches once. Useful for transient HPC failures.

### Usage pattern
\`\`\`
Batch Generate → Map (Parallel) → [geo_opt → single_point] → Aggregate & Filter
\`\`\`

The nodes between Map and Aggregate form the **sub-workflow** that runs for each candidate structure.

### Branch tracking
Each branch gets a unique ID and work directory. Progress is tracked in real-time via WebSocket updates and persisted to the database for crash recovery.

### Practical examples
- **Dopant screening**: Batch Generate (element substitution) \u2192 Map \u2192 Geo Opt + Static \u2192 Aggregate
- **Catalyst screening**: Batch Generate (adsorbate sites) \u2192 Map \u2192 Geo Opt \u2192 Aggregate by adsorption energy

### Tips
- Use **MLP** (machine learning potentials) as the sub-workflow calculator for fast pre-screening, then run DFT on top candidates only (two-stage workflow)
- Click the **progress bar** during execution to open the Branch Status panel with real-time updates
- Set Max Parallel Jobs to avoid flooding your HPC queue (e.g. 10-20 for shared clusters)`,
  param_schema: [
    {
      key: `max_parallel`, label: `Max Parallel Jobs`, type: `number`, default: 0,
      group: `Execution`, min: 0, max: 1000, step: 1,
      help: `Maximum concurrent branches. 0 = unlimited (submit all at once). Set a limit to avoid overwhelming the HPC queue.`,
    },
    {
      key: `fail_strategy`, label: `On Failure`, type: `select`, default: `continue`,
      group: `Execution`,
      options: [
        { label: `Continue others`, value: `continue` },
        { label: `Abort all`, value: `abort_all` },
      ],
      help: `How to handle branch failures. "Continue" lets other branches finish; "Abort all" cancels everything.`,
    },
    {
      key: `retry_failed`, label: `Auto-retry Failed`, type: `boolean`, default: false,
      group: `Execution`,
      help: `Automatically retry failed branches once. Useful for transient HPC errors.`,
    },
    {
      key: `param_overrides`, label: `Parameter Overrides (JSON)`, type: `text`, default: ``,
      group: `Advanced`,
      help: `Override calculation parameters for specific structures. JSON array of rules:
\`\`\`json
[
  {"match": {"elements_contain": ["Ti"]}, "params": {"ENCUT": 520}},
  {"match": {"label_regex": "defect.*"}, "params": {"NSW": 300}},
  {"match": {"indices": [0, 1]}, "params": {"ISPIN": 2}},
  {"match": {"expr": "n_elements > 3"}, "params": {"NCORE": 8}}
]
\`\`\`
Match types: \`elements_contain\` (all listed elements must be present), \`label_regex\`, \`indices\`, \`expr\` (safe Python expression with \`elements\`, \`index\`, \`label\`, \`has(el)\`). All matching rules are merged; later rules override earlier ones.`,
    },
  ],
}

/**
 * Workflow tool execution logic.
 *
 * - WorkflowActionHandler is registered per-tab by WorkflowEditor for
 *   mutation tools — so opening two workflow tabs doesn't have the second
 *   mount overwrite the first's closure.
 * - Read-only tools work even without an active editor.
 * - Mutation tools return a helpful error if no editor is open for that tab.
 *
 * Note: `execute_workflow_tool` and `is_workflow_tool` currently have no
 * callers in production code (they were part of a pre-SDK-bridge path).
 * They're kept for potential re-use and to keep the handler registration
 * API live for WorkflowEditor, but they don't participate in the
 * user-visible chat flow today.
 */

import { get_workflow_slice, active_project_context } from '$lib/workflow/workflow-state.svelte'
import { NODE_DEFINITIONS } from '$lib/workflow/node-definitions'
import { t } from '$lib/i18n/index.svelte'
import { WORKFLOW_TOOL_NAMES, TASK_TYPE_TO_SKILL, REACTION_TYPE_TO_SKILL } from './workflow-tools'
import * as workflow_api from '$lib/api/workflow'
import * as project_api from '$lib/api/project'
import { API_BASE } from '$lib/api/config'

/** Callback registered by WorkflowEditor to handle graph mutations */
export type WorkflowActionHandler = (
  action: string,
  params: Record<string, unknown>,
) => Promise<string>

// Per-tab registry — replaces the pre-Phase-2 single-slot `let action_handler`.
// With two workflow tabs open, the second `register_workflow_action_handler`
// call used to overwrite the first's closure; now each tab holds its own
// entry in the Map, and the tool dispatcher looks up by tab_id.
const action_handlers = new Map<string, WorkflowActionHandler>()

export function register_workflow_action_handler(
  tab_id: string,
  handler: WorkflowActionHandler,
): void {
  action_handlers.set(tab_id, handler)
}

export function unregister_workflow_action_handler(tab_id: string): void {
  action_handlers.delete(tab_id)
}

export function get_workflow_action_handler(tab_id: string): WorkflowActionHandler | null {
  return action_handlers.get(tab_id) ?? null
}

/** Check if a tool name is a workflow tool */
export function is_workflow_tool(name: string): boolean {
  return WORKFLOW_TOOL_NAMES.has(name)
}

/** Execute a workflow tool by name */
export async function execute_workflow_tool(
  name: string,
  input: Record<string, unknown>,
  tab_id: string,
): Promise<string> {
  switch (name) {
    // ─── Pre-flight guideline tool ───
    case `get_calculation_guidelines`:
      return handle_get_calculation_guidelines(input.task_type as string)

    // ─── Read-only tools (no editor required) ───
    case `list_workflows`:
      return handle_list_workflows()

    case `get_workflow_status`:
      return handle_get_workflow_status(tab_id)

    case `get_step_error`:
      return handle_get_step_error(tab_id, input.step_id as string)

    case `suggest_params`:
      return handle_suggest_params(tab_id, input.node_type as string, input.node_id as string | undefined)

    case `get_node_definitions`:
      return handle_get_node_definitions(input.category as string | undefined)

    case `get_workflow_templates`:
      return handle_get_workflow_templates()

    case `validate_workflow`:
      return handle_validate_workflow(tab_id)

    case `retry_step`:
      return handle_retry_step(input.workflow_id as string, input.step_id as string)

    case `get_batch_status`:
      return handle_get_batch_status(input.workflow_id as string, input.step_id as string)

    case `compute_oer_overpotential`:
      return handle_compute_oer_overpotential(
        input.dG_OH as number,
        input.dG_O as number,
        input.dG_OOH as number,
      )

    case `compute_free_energy`:
      return handle_compute_free_energy(
        input.e_dft as number,
        input.frequencies_cm as number[] | undefined,
        input.temperature as number | undefined,
      )

    case `list_vasp_presets`:
      return handle_list_vasp_presets()

    // ─── Workflow import tools ───
    case `import_atomate2_template`:
      return handle_import_template(tab_id, `atomate2`, input.template_id as string)

    case `import_quacc_template`:
      return handle_import_template(tab_id, `quacc`, input.template_id as string)

    case `create_screening_workflow`:
      return handle_create_screening_workflow(tab_id, input)

    // ─── Mutation tools (require editor) ───
    case `create_workflow`:
      return handle_create_workflow(tab_id, input.name as string, input.template_id as string | undefined)

    case `add_node`:
    case `remove_node`:
    case `connect_nodes`:
    case `set_node_params`:
    case `run_workflow`:
    case `pause_workflow`:
      return handle_mutation(tab_id, name, input)

    default:
      return `Unknown workflow tool: ${name}`
  }
}

async function handle_list_workflows(): Promise<string> {
  try {
    const workflows = await workflow_api.list_workflows()
    if (workflows.length === 0) return `No workflows found. Create one with the create_workflow tool.`
    const lines = workflows.map((w) =>
      `- **${w.name}** (id: ${w.id}) — status: ${w.status}, steps: ${w.completed_steps}/${w.step_count}`,
    )
    return `Found ${workflows.length} workflow(s):\n${lines.join(`\n`)}`
  } catch (err) {
    return `Failed to list workflows: ${err instanceof Error ? err.message : String(err)}`
  }
}

function handle_get_workflow_status(tab_id: string): string {
  const active_workflow = get_workflow_slice(tab_id).active_workflow
  if (!active_workflow.id) {
    return `No active workflow. Open a workflow in the editor to see its status.`
  }

  const lines = [`**${active_workflow.name}** — Status: ${active_workflow.status}`]

  if (active_workflow.nodes.length > 0) {
    lines.push(`\nSteps:`)
    for (const node of active_workflow.nodes) {
      const status = active_workflow.node_statuses[node.id] ?? `—`
      lines.push(`- ${node.label} (${node.id}): ${status}`)
    }
  }

  const failed_count = Object.values(active_workflow.node_statuses).filter(s => s === `failed`).length
  const completed_count = Object.values(active_workflow.node_statuses).filter(s => s === `completed`).length
  const total = active_workflow.nodes.length
  lines.push(`\nProgress: ${completed_count}/${total} completed${failed_count > 0 ? `, ${failed_count} failed` : ``}`)

  if (active_workflow.error) {
    lines.push(`\nError: ${active_workflow.error}`)
  }

  return lines.join(`\n`)
}

async function handle_get_step_error(tab_id: string, step_id: string): Promise<string> {
  const active_workflow = get_workflow_slice(tab_id).active_workflow
  if (!active_workflow.id) {
    return `No active workflow.`
  }

  try {
    const steps = await workflow_api.list_steps(active_workflow.id)
    const step = steps.find(s => s.id === step_id)
    if (!step) return `Step not found: ${step_id}`
    if (step.status !== `failed`) return `Step ${step_id} (${step.label}) is not failed — status: ${step.status}`

    const lines = [
      `**${step.label}** (${step.node_type}) — FAILED`,
      ``,
      `Error: ${step.error_message ?? `No error message available`}`,
    ]

    if (step.work_dir) {
      lines.push(`Work directory: ${step.work_dir}`)
    }

    // Try to get OUTCAR or stdout for more context
    try {
      const files = await workflow_api.get_step_files(active_workflow.id, step_id)
      const relevant = files.files.filter(f =>
        /\.(out|err|log)$/i.test(f.name) || f.name === `OUTCAR` || f.name === `stdout`,
      )
      if (relevant.length > 0) {
        lines.push(`\nAvailable log files: ${relevant.map(f => f.name).join(`, `)}`)
      }
    } catch {
      // File listing failed, not critical
    }

    return lines.join(`\n`)
  } catch (err) {
    return `Failed to get step details: ${err instanceof Error ? err.message : String(err)}`
  }
}

function handle_suggest_params(tab_id: string, node_type: string, node_id?: string): string {
  const def = NODE_DEFINITIONS[node_type]
  if (!def) {
    return `Unknown node type: ${node_type}. Available types: ${Object.keys(NODE_DEFINITIONS).join(`, `)}`
  }

  const lines = [
    `**${def.label}** (${def.type})`,
    def.description,
    ``,
  ]

  // Show param schema
  if (def.param_schema && def.param_schema.length > 0) {
    lines.push(`### Parameters`)
    for (const p of def.param_schema) {
      // label/group/help may be raw i18n keys (workflow.*) — translate for the LLM
      const group = p.group ? `[${t(p.group)}] ` : ``
      const range = p.min !== undefined || p.max !== undefined
        ? ` (range: ${p.min ?? ``}–${p.max ?? ``})`
        : ``
      const options = p.options
        ? ` Options: ${p.options.map(o => `${t(o.label)}`).join(`, `)}`
        : ``
      lines.push(`- **${p.key}** ${group}— ${t(p.label)}. Default: ${JSON.stringify(p.default)}${range}${options}`)
      if (p.help) lines.push(`  ${t(p.help)}`)
    }
  } else {
    lines.push(`Default params: ${JSON.stringify(def.default_params, null, 2)}`)
  }

  // Show current values if a specific node is referenced
  if (node_id) {
    const active_workflow = get_workflow_slice(tab_id).active_workflow
    const node = active_workflow.nodes.find(n => n.id === node_id)
    if (node) {
      lines.push(`\n### Current Values (${node_id})`)
      for (const [k, v] of Object.entries(node.params)) {
        lines.push(`- ${k}: ${JSON.stringify(v)}`)
      }
    }
  }

  return lines.join(`\n`)
}

function handle_get_node_definitions(category?: string): string {
  const entries = Object.entries(NODE_DEFINITIONS)
  const filtered = category
    ? entries.filter(([, def]) => def.category?.toUpperCase() === category.toUpperCase())
    : entries

  if (filtered.length === 0) {
    const categories = [...new Set(Object.values(NODE_DEFINITIONS).map(d => d.category).filter(Boolean))]
    return `No node types found${category ? ` for category "${category}"` : ``}. Available categories: ${categories.join(`, `)}`
  }

  const lines: string[] = [`Available workflow node types (${filtered.length}):\n`]
  // Group by category
  const by_category: Record<string, [string, typeof NODE_DEFINITIONS[string]][]> = {}
  for (const entry of filtered) {
    const cat = entry[1].category ?? `Other`
    if (!by_category[cat]) by_category[cat] = []
    by_category[cat].push(entry)
  }

  for (const [cat, defs] of Object.entries(by_category)) {
    lines.push(`## ${cat}`)
    for (const [type_key, def] of defs) {
      lines.push(`- **${type_key}** — ${def.label}: ${def.description ?? ``}`)
      if (def.param_schema && def.param_schema.length > 0) {
        const param_summary = def.param_schema.slice(0, 8).map(p =>
          `${p.key}=${JSON.stringify(p.default)}`,
        ).join(`, `)
        lines.push(`  Params: ${param_summary}${def.param_schema.length > 8 ? ` ... (${def.param_schema.length} total)` : ``}`)
      }
    }
    lines.push(``)
  }

  return lines.join(`\n`)
}

async function handle_get_workflow_templates(): Promise<string> {
  try {
    const templates = await workflow_api.list_templates()
    if (!templates || templates.length === 0) {
      return `No workflow templates available. You can build workflows from scratch using add_node and connect_nodes.`
    }
    const lines = [`Available workflow templates (${templates.length}):\n`]
    for (const t of templates) {
      lines.push(`- **${t.name}** (id: ${t.id}): ${t.description ?? `No description`}`)
    }
    lines.push(`\nUse create_workflow with template_id to create from a template.`)
    return lines.join(`\n`)
  } catch (err) {
    return `Failed to list templates: ${err instanceof Error ? err.message : String(err)}`
  }
}

function handle_validate_workflow(tab_id: string): string {
  const active_workflow = get_workflow_slice(tab_id).active_workflow
  if (!active_workflow.id) {
    return `No active workflow. Open a workflow in the editor first.`
  }

  const errors: string[] = []
  const warnings: string[] = []
  const nodes = active_workflow.nodes
  const edges = active_workflow.edges ?? []

  if (nodes.length === 0) {
    return `Workflow is empty — no nodes to validate.`
  }

  // Check: non-input nodes must have at least one incoming edge
  const input_types = new Set([`structure_input`, `file_input`, `param_input`])
  const nodes_with_incoming = new Set(edges.map(e => e.to))
  for (const node of nodes) {
    if (!input_types.has(node.type) && !nodes_with_incoming.has(node.id)) {
      errors.push(`Node "${node.label}" (${node.id}) has no incoming connections`)
    }
  }

  // Check: orphaned nodes (no edges at all)
  const nodes_with_edges = new Set([
    ...edges.map(e => e.from),
    ...edges.map(e => e.to),
  ])
  for (const node of nodes) {
    if (!nodes_with_edges.has(node.id) && nodes.length > 1) {
      warnings.push(`Node "${node.label}" (${node.id}) is disconnected from the graph`)
    }
  }

  // Check: cycle detection via topological sort
  const adj: Record<string, string[]> = {}
  const in_degree: Record<string, number> = {}
  for (const node of nodes) {
    adj[node.id] = []
    in_degree[node.id] = 0
  }
  for (const edge of edges) {
    if (adj[edge.from]) adj[edge.from].push(edge.to)
    in_degree[edge.to] = (in_degree[edge.to] ?? 0) + 1
  }
  const queue = Object.keys(in_degree).filter(id => in_degree[id] === 0)
  let visited = 0
  while (queue.length > 0) {
    const cur = queue.shift()!
    visited++
    for (const next of (adj[cur] ?? [])) {
      in_degree[next]--
      if (in_degree[next] === 0) queue.push(next)
    }
  }
  if (visited < nodes.length) {
    errors.push(`Workflow contains a cycle — execution order cannot be determined`)
  }

  // Summary
  if (errors.length === 0 && warnings.length === 0) {
    return `Workflow validation passed. ${nodes.length} nodes, ${edges.length} edges — ready to run.`
  }

  const lines: string[] = []
  if (errors.length > 0) {
    lines.push(`**Errors (${errors.length}):**`)
    for (const e of errors) lines.push(`- ${e}`)
  }
  if (warnings.length > 0) {
    lines.push(`**Warnings (${warnings.length}):**`)
    for (const w of warnings) lines.push(`- ${w}`)
  }
  return lines.join(`\n`)
}

async function handle_create_workflow(tab_id: string, name: string, template_id?: string): Promise<string> {
  try {
    let wf: { id: string; name: string }
    if (template_id) {
      wf = await workflow_api.create_from_template(template_id, name)
    } else {
      // Auto-add structure_input node (matches MCP create behavior). Capture
      // the viewer's current structure into params.structure_json so the
      // workflow's first node is pre-populated — without this the user has
      // to re-import a structure they already have loaded. Mirrors the
      // backend MCP `create` action (server/catgo/mcp_tools/workflow_tools.py
      // ~L1124) and the 2026-05-09 fix that was uncommitted on the parent
      // branch.
      const si_id = `n${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const si_params: Record<string, unknown> = {}
      try {
        const r = await fetch(
          `${API_BASE}/view/structure/current?panel_id=${encodeURIComponent(tab_id)}`,
        )
        if (r.ok) {
          const struct = await r.json()
          if (struct && typeof struct === `object` && Object.keys(struct).length > 0) {
            si_params.structure_json = JSON.stringify(struct)
          }
        }
        // 404 (empty viewer) is the expected no-op path — workflow is
        // created with an empty structure_input and the user wires it later.
      } catch {
        // Backend unreachable — proceed without pre-populated structure.
      }
      const init_graph = {
        nodes: [{ id: si_id, type: `structure_input`, x: 80, y: 200, params: si_params }],
        edges: [],
      }
      wf = await workflow_api.create_workflow(name, JSON.stringify(init_graph))
    }

    // Auto-assign to active project if user is in a ProjectDashboard
    const proj_id = active_project_context.id
    if (proj_id) {
      try {
        await project_api.assign_workflow_to_project(wf.id, proj_id)
      } catch {
        // Non-fatal: workflow was created, just not assigned
      }
    }

    get_workflow_slice(tab_id).pending_navigate_workflow.id = wf.id
    const suffix = template_id ? ` from template` : ``
    const proj_note = proj_id ? ` (assigned to active project)` : ``
    return `Created workflow "${wf.name}"${suffix} (id: ${wf.id})${proj_note}.`
  } catch (err) {
    return `Failed to create workflow: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handle_mutation(tab_id: string, name: string, input: Record<string, unknown>): Promise<string> {
  // Wait for editor to become available (e.g. after create_workflow triggers navigation)
  let handler = get_workflow_action_handler(tab_id)
  if (!handler) {
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      handler = get_workflow_action_handler(tab_id)
      if (handler) break
    }
  }

  if (!handler) {
    return `No workflow editor is active in this tab. Open a workflow in the editor first to use this tool.`
  }

  // Map tool names to action handler actions
  const action_map: Record<string, string> = {
    add_node: `add_node`,
    remove_node: `remove_node`,
    connect_nodes: `connect_nodes`,
    set_node_params: `set_params`,
    run_workflow: `run`,
    pause_workflow: `pause`,
  }

  const action = action_map[name]
  if (!action) return `Unknown mutation tool: ${name}`

  try {
    return await handler(action, input)
  } catch (err) {
    return `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ─── Retry / batch handlers ───

async function handle_retry_step(workflow_id: string, step_id: string): Promise<string> {
  try {
    const response = await fetch(`${API_BASE}/workflow/${workflow_id}/steps/${step_id}/retry`, {
      method: `POST`,
    })
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }))
      return `Failed to retry step: ${err.detail || response.statusText}`
    }
    const result = await response.json()
    const reset_count = result.reset_count ?? 0
    return `Step ${step_id} and ${reset_count} downstream node(s) reset to pending. Workflow resumed.`
  } catch (err) {
    return `Failed to retry step: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handle_get_batch_status(workflow_id: string, step_id: string): Promise<string> {
  try {
    const response = await fetch(`${API_BASE}/workflow/${workflow_id}/steps/${step_id}/batch-summary`)
    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: response.statusText }))
      return `Failed to get batch status: ${err.detail || response.statusText}`
    }
    const s = await response.json()
    const lines = [
      `**Batch status for step ${step_id}:**`,
      `Total: ${s.total ?? 0} | Completed: ${s.completed ?? 0} | Running: ${s.running ?? 0} | Failed: ${s.failed ?? 0} | Pending: ${s.pending ?? 0}`,
    ]
    if (s.energy_stats) {
      lines.push(`Energy — min: ${s.energy_stats.min?.toFixed(4)} eV, max: ${s.energy_stats.max?.toFixed(4)} eV, mean: ${s.energy_stats.mean?.toFixed(4)} eV`)
    }
    return lines.join(`\n`)
  } catch (err) {
    return `Failed to get batch status: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ─── SKILL guideline handler ───

async function handle_get_calculation_guidelines(task_type: string): Promise<string> {
  const skill_path = TASK_TYPE_TO_SKILL[task_type] ?? REACTION_TYPE_TO_SKILL[task_type]
  if (!skill_path) {
    return `No specific guidelines found for "${task_type}". Proceed with defaults, but confirm key parameters (functional, ISPIN, k-points) with the user.`
  }

  try {
    const res = await fetch(`${API_BASE}/skills/${skill_path}`)
    if (!res.ok) {
      return `Could not load guidelines for ${skill_path} (HTTP ${res.status}). Proceed carefully and confirm key parameters with the user.`
    }
    const data = await res.json()
    const content: string = data.content ?? ``

    // Extract the Discussion Checkpoints section
    const match = content.match(/## Discussion Checkpoints[\s\S]*?(?=\n## |\n---|$)/i)
    if (match) {
      return `**Guidelines for ${task_type}** (skill: ${skill_path}):\n\n${match[0]}\n\n**Action required:** Present the 🔴 items to the user and get confirmation before creating workflow nodes. For 🟡 items, present the defaults and ask if they are acceptable.`
    }

    return `Skill loaded for ${task_type} (${skill_path}) but no Discussion Checkpoints section found. Proceed carefully and confirm key parameters with the user.`
  } catch (e) {
    return `Could not fetch guidelines for ${task_type}: ${e instanceof Error ? e.message : String(e)}. Proceed carefully.`
  }
}

// ─── Catalysis computation handlers (pure TypeScript, no backend needed) ───

function handle_compute_oer_overpotential(dG_OH: number, dG_O: number, dG_OOH: number): string {
  // CHE model: four proton-coupled electron transfer steps for OER
  // H2O → *OH → *O → *OOH → O2
  // Standard free energy of water splitting: 4.92 eV (4 x 1.23 V)
  const dG1 = dG_OH                     // H2O → *OH + H+ + e-
  const dG2 = dG_O - dG_OH              // *OH → *O + H+ + e-
  const dG3 = dG_OOH - dG_O             // *O + H2O → *OOH + H+ + e-
  const dG4 = 4.92 - dG_OOH             // *OOH → O2 + H+ + e-

  const steps = [
    { name: `H2O → *OH`, dG: dG1 },
    { name: `*OH → *O`, dG: dG2 },
    { name: `*O → *OOH`, dG: dG3 },
    { name: `*OOH → O2`, dG: dG4 },
  ]

  // Ideal: each step = 1.23 eV. Overpotential = max(dGi) - 1.23
  const max_step = steps.reduce((a, b) => (a.dG > b.dG ? a : b))
  const overpotential = max_step.dG - 1.23

  const lines = [
    `**OER Overpotential (CHE model)**`,
    ``,
    `Step energies:`,
    ...steps.map(s => `- ${s.name}: ${s.dG.toFixed(4)} eV`),
    ``,
    `Limiting step: ${max_step.name} (${max_step.dG.toFixed(4)} eV)`,
    `Theoretical overpotential: ${overpotential.toFixed(4)} V`,
  ]
  return lines.join(`\n`)
}

function handle_compute_free_energy(
  e_dft: number,
  frequencies_cm?: number[],
  temperature?: number,
): string {
  const T = temperature ?? 298.15
  const kB = 8.617333262e-5  // eV/K
  const hbar_eV_s = 6.582119569e-16  // eV*s
  const c_cm_s = 2.99792458e10  // cm/s

  let zpe = 0
  let ts_vib = 0

  if (frequencies_cm && frequencies_cm.length > 0) {
    for (const freq_cm of frequencies_cm) {
      if (freq_cm <= 0) continue // skip imaginary frequencies
      const nu_hz = freq_cm * c_cm_s
      const hv = hbar_eV_s * 2 * Math.PI * nu_hz  // h*nu in eV
      zpe += 0.5 * hv
      // Vibrational entropy contribution: -TS_vib
      if (T > 0) {
        const x = hv / (kB * T)
        ts_vib += kB * T * (x / (Math.exp(x) - 1) - Math.log(1 - Math.exp(-x)))
      }
    }
  }

  const G = e_dft + zpe - ts_vib

  const lines = [
    `**Gibbs Free Energy Correction**`,
    ``,
    `E_DFT: ${e_dft.toFixed(6)} eV`,
    `ZPE: ${zpe.toFixed(6)} eV${frequencies_cm ? ` (${frequencies_cm.length} modes)` : ` (no frequencies provided)`}`,
    `-TS_vib: ${(-ts_vib).toFixed(6)} eV (T = ${T} K)`,
    ``,
    `G = E_DFT + ZPE - TS = ${G.toFixed(6)} eV`,
  ]
  return lines.join(`\n`)
}

async function handle_list_vasp_presets(): Promise<string> {
  try {
    const response = await fetch(`${API_BASE}/workflow/vasp-presets`)
    if (!response.ok) {
      // Fallback to hardcoded list if endpoint not available
      return format_hardcoded_vasp_presets()
    }
    const presets = await response.json()
    const lines = [`**Available VASP presets:**\n`]
    for (const p of presets) {
      lines.push(`- **${p.name}**: ${p.description ?? ``}`)
      if (p.incar) {
        const params = Object.entries(p.incar).map(([k, v]) => `${k}=${v}`).join(`, `)
        lines.push(`  INCAR: ${params}`)
      }
    }
    return lines.join(`\n`)
  } catch {
    return format_hardcoded_vasp_presets()
  }
}

// ─── Workflow import handlers ───

async function handle_import_template(tab_id: string, source: `atomate2` | `quacc`, template_id: string): Promise<string> {
  if (!template_id) return `Missing required parameter: template_id`

  try {
    const response = await fetch(`${API_BASE}/workflow/import-${source}-template`, {
      method: `POST`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify({ template_id }),
    })

    if (!response.ok) {
      // Fallback: try creating via the standard template mechanism
      try {
        const wf = await workflow_api.create_from_template(template_id, `${source} import`)
        get_workflow_slice(tab_id).pending_navigate_workflow.id = wf.id
        return `Imported ${source} template '${template_id}' as workflow (id: ${wf.id}).`
      } catch (err2) {
        return `Failed to import ${source} template '${template_id}': ${err2 instanceof Error ? err2.message : String(err2)}`
      }
    }

    const result = await response.json()
    if (result.id) {
      get_workflow_slice(tab_id).pending_navigate_workflow.id = result.id
    }
    return result.message ?? `Imported ${source} template '${template_id}' successfully.`
  } catch (err) {
    return `Failed to import ${source} template: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function handle_create_screening_workflow(tab_id: string, input: Record<string, unknown>): Promise<string> {
  const screening_type = input.screening_type as string
  const software = input.software as string

  if (!screening_type || !software) {
    return `Missing required parameters: screening_type and software are required.`
  }

  try {
    const response = await fetch(`${API_BASE}/workflow/create-screening`, {
      method: `POST`,
      headers: { 'Content-Type': `application/json` },
      body: JSON.stringify(input),
    })

    if (!response.ok) {
      // Fallback: create via MCP-style batch operations
      const err = await response.json().catch(() => ({ detail: response.statusText }))
      return `Failed to create screening workflow: ${err.detail || response.statusText}. Try building it manually with add_node and connect_nodes.`
    }

    const result = await response.json()
    if (result.id) {
      get_workflow_slice(tab_id).pending_navigate_workflow.id = result.id
    }
    return result.message ?? `Created ${screening_type} screening workflow with ${software} successfully.`
  } catch (err) {
    return `Failed to create screening workflow: ${err instanceof Error ? err.message : String(err)}`
  }
}

function format_hardcoded_vasp_presets(): string {
  const presets = [
    { name: `relax`, desc: `Ionic relaxation`, params: `IBRION=2, ISIF=3, NSW=200, EDIFF=1e-5, EDIFFG=-0.02` },
    { name: `static`, desc: `Single-point SCF`, params: `IBRION=-1, NSW=0, ISMEAR=-5, EDIFF=1e-6` },
    { name: `slab_relax`, desc: `Surface slab relaxation (fixed bottom layers)`, params: `IBRION=2, ISIF=2, NSW=200, EDIFF=1e-5, EDIFFG=-0.03, IDIPOL=3, LDIPOL=.TRUE.` },
    { name: `freq`, desc: `Vibrational frequency (finite differences)`, params: `IBRION=5, NSW=1, NFREE=2, EDIFF=1e-7, POTIM=0.015` },
    { name: `band`, desc: `Band structure (non-SCF)`, params: `ICHARG=11, ISMEAR=0, LORBIT=11` },
    { name: `md`, desc: `Ab initio molecular dynamics`, params: `IBRION=0, SMASS=0, NSW=5000, POTIM=1.0, TEBEG=300` },
  ]
  const lines = [`**Available VASP presets:**\n`]
  for (const p of presets) {
    lines.push(`- **${p.name}**: ${p.desc}`)
    lines.push(`  INCAR: ${p.params}`)
  }
  return lines.join(`\n`)
}

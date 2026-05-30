import { API_BASE } from '$lib/api/config'
import type { ChatConfig, ChatMessage, DocChunk, ProviderInfoResponse, LLMProvider } from './types'

const SYSTEM_PROMPT = `You are CatBot, an AI helper for CatGO — an interactive visualization toolkit for materials science. You help users with crystal structure visualization, MD trajectories, band structures, phase diagrams, and more.

Answer questions based on the documentation and structure context provided. Be concise and helpful. When the user asks about their current structure, reference the structure context below. If the documentation doesn't cover the topic, say so honestly.`

/** System message for SDK agents with agent-specific guidance. Exported for chat-state SDK path. */
export function build_sdk_system_prompt(provider: LLMProvider, structure_context?: string, has_session: boolean = false): string {
  let msg = `You are CatBot — a materials science assistant in CatGO. Respond in the user's language. Use catgo_* MCP tools to manipulate structures and run analysis. Call tools directly — never ask for confirmation.

Tool routing: To load/import structures, use catgo_fetch (crystals from OPTIMADE databases) or catgo_fetch (molecules from PubChem) — do NOT build structures manually. For molecules without a lattice, use set_lattice to add a periodic box (NOT make_supercell). For one-off viewer operations (supercell, doping, atom editing), use catgo_structure. To add water: catgo_structure add_molecule query:"water" count:N. For bulk fill to liquid density, use fill:true. When building WORKFLOWS (OER, HER, CO2RR, relaxation pipelines), use catgo_workflow with slab_gen/adsorbate_place nodes — do NOT cut slabs or place adsorbates via catgo_structure, because workflow nodes handle layer counting and reproducibility correctly. For transition state searches: create workflow with ts_search node (software:"sella", calculator:"orca" or "xtb").

WORKFLOW CREATION — PREFER plan_and_build: Instead of calling create→add_node→connect→set_params multiple times, use catgo_workflow action="plan_and_build" to build the ENTIRE workflow in ONE call. Provide a plan: {name, nodes: [{type, label, software?, params?}], connections: [[from_idx, to_idx], ...]}. The system auto-generates IDs, handles, defaults, and layout. Only use granular add_node/connect for modifying existing workflows.

Extra capabilities: You have WebSearch and WebFetch tools for internet access — use them to look up papers, documentation, material properties, or any information the user asks about. You can also write files (Bash, Write, Edit tools) and develop CatGO plugins using the catgo_file MCP tool (writes to ~/.catgo/plugins/). When asked to build plugins or extensions, do it directly.

Formatting: When describing workflow DAG structures or pipelines, ALWAYS use a fenced code block (\`\`\`text) to preserve ASCII formatting. Use clear node labels and arrows showing the data flow.

Rules: Act first, explain after. Use standard defaults (slab: 10 Å thickness, 15 Å vacuum; fmax=0.05). After executing, briefly state what you did and offer to adjust. When running multi-step workflows, proceed through all steps autonomously — only pause if something fails or requires genuine user input.`

  if (has_session) {
    msg += `\n\nCONTINUATION RULE: This is a resumed conversation. Skip all greetings and structural introductions. Respond directly and concisely to the latest user message.`
  }

  // Agent-specific behavioral hints
  if (provider === `sdk-codex`) {
    msg += `\n\nCodex runtime rule: never output execution-status boilerplate or tool call logs. Reply directly to the user intent with concise, helpful text. CRITICAL: always match the user's language — if they write Chinese, reply in Chinese; if English, reply in English.`
  } else if (provider === `sdk-gemini`) {
    msg += `\n\nGemini runtime rule: do NOT browse local files or use shell tools. All structure data is available through catgo_* MCP tools — call them instead. CRITICAL: always match the user's language — if they write Chinese, reply entirely in Chinese; if English, reply in English. Keep responses concise (2-3 sentences max). ${has_session ? `` : `When greeting, briefly describe the loaded structure in one sentence.`} Use LaTeX for math and chemical formulas ($H_2O$, $E = mc^2$, $\\alpha$-Fe₂O₃) with $...$ for inline and $$...$$ for display math. Never use HTML tags (<sub>, <sup>).`
  }

  if (structure_context) {
    msg += `\n\n${structure_context}`
  }
  return msg
}

/** Rough token count estimate (~4 chars per token) */
function estimate_tokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Max system prompt budget (leave room for messages + response) */
const MAX_SYSTEM_TOKENS = 3000

function build_system_message(rag_context: DocChunk[], structure_context?: string): string {
  const parts = [SYSTEM_PROMPT]

  if (structure_context) {
    parts.push(`\n\n--- Current Context ---\n\n${structure_context}`)
  }

  if (rag_context.length > 0) {
    // Budget-aware RAG injection: include chunks until budget exhausted
    const current_tokens = estimate_tokens(parts.join(``))
    const remaining = MAX_SYSTEM_TOKENS - current_tokens
    const rag_parts: string[] = []
    let rag_tokens = 0
    for (const chunk of rag_context) {
      const text = `[${chunk.source}${chunk.heading ? ` — ${chunk.heading}` : ``}]\n${chunk.content}`
      const chunk_tokens = estimate_tokens(text)
      if (rag_tokens + chunk_tokens > remaining && rag_parts.length > 0) break
      rag_parts.push(text)
      rag_tokens += chunk_tokens
    }
    if (rag_parts.length > 0) {
      parts.push(`\n\nRelevant documentation:\n\n${rag_parts.join(`\n\n---\n\n`)}`)
    }
  }

  return parts.join(``)
}

/** Check if context includes paper data */
export function has_paper_context(context?: string): boolean {
  return !!context && context.includes(`## Imported Paper`)
}

const PAPER_SYSTEM_ADDENDUM = `

You have an imported scientific paper available in your context. When the user asks you to create a workflow based on this paper:

1. **Identify computational methodology**: Look for sections like "Computational Details", "Methods", "DFT Calculations". Extract:
   - DFT code (VASP, QE, etc.), functional (PBE, PBE+U, HSE06), pseudopotentials (PAW, USPP)
   - ENCUT (energy cutoff), k-point mesh, convergence criteria (EDIFF, EDIFFG)
   - Relaxation settings (ISIF, NSW, IBRION), spin polarization (ISPIN)
   - MD settings if applicable (temperature, timestep, ensemble, POTIM, TEBEG)
   - ML potential usage (MACE, CHGNet, M3GNet)
   - Analysis performed (DOS, COHP, band structure, Bader charges)

2. **Map to CatGO workflow nodes**: Available node types include:
   - structure_input: Initial structure loading
   - vasp_relax: Geometry optimization (set ISIF, NSW, EDIFF, ENCUT, kpoints, ISMEAR, ISPIN)
   - vasp_static: Single-point energy/DOS calculation
   - vasp_md: Ab initio molecular dynamics
   - bulk_opt: Bulk cell optimization (ISIF=3, high k-points)
   - slab_gen: Surface slab generation (Miller indices, layers, vacuum)
   - slab_relax: Surface relaxation with frozen bottom layers
   - adsorbate_place: Place adsorbate molecules on surfaces
   - mlp_relax / mlp_md: ML potential calculations
   - xtb_relax / xtb_static: Semi-empirical xTB
   - frequency: Vibrational frequency analysis
   - dos_analysis / cohp_analysis / md_analysis: Post-processing
   - convergence_check / energy_compare / charge_analysis: Analysis nodes
   - condition / loop / merge: Control flow

3. **Propose before creating**: First explain what you found in the paper, then propose the workflow with node types and parameters. Wait for user confirmation before building.

4. **Build with tools**: Use create_workflow, add_node, connect_nodes, set_node_params. Set parameters to match the paper's values.

5. **Note gaps**: If the paper uses methods not supported in CatGO (e.g., specific DFT codes other than VASP, or specialized methods), mention this and suggest alternatives.`

/** Parse SSE lines from a ReadableStream */
async function* parse_sse(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ``

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(`\n`)
      buffer = lines.pop() ?? ``

      for (const line of lines) {
        if (!line.startsWith(`data: `)) continue
        const data_str = line.slice(6)
        if (data_str === `[DONE]`) return
        try {
          const data = JSON.parse(data_str)
          if (data.error) {
            yield `\n\n> ⚠️ ${data.error}\n`
            continue
          }
          if (data.text) yield data.text
        } catch (err) {
          if (err instanceof SyntaxError) continue // skip malformed JSON
          throw err
        }
      }
    }
  } catch (err) {
    // Stream interrupted — yield as inline warning to preserve partial content
    const msg = err instanceof Error ? err.message : `Stream interrupted`
    yield `\n\n> ⚠️ ${msg}\n`
  }
}

/** Stream via backend universal endpoint (OpenAI-compatible providers) */
async function* stream_universal(
  messages: ChatMessage[],
  config: ChatConfig,
  system: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const response = await fetch(`${API_BASE}/chat/stream-universal`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({
      provider_id: config.provider,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      system,
      base_url: (config.provider === `custom` || config.provider === `ollama`) ? config.base_url || undefined : undefined,
      api_format: (config.provider === `custom` || config.provider === `anthropic`) ? config.api_format : undefined,
      api_key: config.api_key || undefined,
    }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Server error ${response.status}: ${text}`)
  }

  yield* parse_sse(response.body!.getReader())
}

/** Fetch available providers from backend */
export async function fetch_providers(): Promise<ProviderInfoResponse[]> {
  try {
    const response = await fetch(`${API_BASE}/chat/providers`)
    if (!response.ok) {
      console.warn(`[CatBot] Failed to fetch providers: HTTP ${response.status}`)
      return []
    }
    const data = await response.json()
    return data.providers ?? []
  } catch (err) {
    console.warn(`[CatBot] Failed to fetch providers:`, err)
    return []
  }
}

/**
 * Main entry point: stream a chat response from the configured LLM.
 * Only universal (OpenAI-compatible) providers reach this path; SDK agents
 * are dispatched via stream_sdk_agent in chat-state.
 */
export async function* stream_chat(
  messages: ChatMessage[],
  config: ChatConfig,
  rag_context: DocChunk[],
  signal?: AbortSignal,
  structure_context?: string,
): AsyncGenerator<string> {
  let system = build_system_message(rag_context, structure_context)
  if (has_paper_context(structure_context)) {
    system += PAPER_SYSTEM_ADDENDUM
  }
  yield* stream_universal(messages, config, system, signal)
}

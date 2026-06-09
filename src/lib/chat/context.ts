/**
 * Build structured context strings from current state
 * for inclusion in the LLM system prompt.
 */

import type { AnyStructure } from '$lib'
import { element_data } from '$lib'
import { electro_neg_formula, get_density } from '$lib/structure'
import type { MoyoDataset } from '@spglib/moyo-wasm'
import type { ActiveWorkflow } from '$lib/workflow/workflow-state.svelte'

interface StructureContext {
  structure?: AnyStructure
  symmetry_data?: MoyoDataset | null
  selected_sites?: number[]
}

/** Strip HTML tags from formula string */
function strip_html(html: string): string {
  return html.replace(/<[^>]+>/g, ``)
}

/** Get unique elements with counts */
function get_composition(structure: AnyStructure): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const site of structure.sites) {
    for (const sp of site.species) {
      counts[sp.element] = (counts[sp.element] ?? 0) + sp.occu
    }
  }
  return counts
}

/** Format a number to reasonable precision */
function fmt(n: number, digits = 3): string {
  return Number(n.toFixed(digits)).toString()
}

export function build_structure_context(ctx: StructureContext): string {
  const { structure, symmetry_data, selected_sites } = ctx
  if (!structure) return ``

  const lines: string[] = []
  lines.push(`## Current Structure`)

  // Formula and atom count
  const formula = strip_html(electro_neg_formula(structure))
  lines.push(`- Formula: ${formula}`)
  lines.push(`- Atom count: ${structure.sites.length}`)

  // Composition
  const comp = get_composition(structure)
  const comp_str = Object.entries(comp)
    .map(([el, n]) => `${el}: ${n % 1 === 0 ? n : fmt(n)}`)
    .join(`, `)
  lines.push(`- Composition: ${comp_str}`)

  // Check if periodic
  const is_periodic = `lattice` in structure
  lines.push(
    `- Type: ${is_periodic ? `crystal (periodic)` : `molecule (non-periodic)`}`,
  )

  // Lattice parameters
  if (is_periodic) {
    const lat = structure.lattice
    if (lat.a != null && lat.b != null && lat.c != null) {
      lines.push(
        `- Lattice parameters: a=${fmt(lat.a)} b=${fmt(lat.b)} c=${fmt(lat.c)} alpha=${
          fmt(lat.alpha ?? 90)
        } beta=${fmt(lat.beta ?? 90)} gamma=${fmt(lat.gamma ?? 90)}`,
      )
    }
    if (lat.volume != null) {
      lines.push(`- Volume: ${fmt(lat.volume)} A^3`)
    }
    const density = get_density(structure)
    if (density != null && isFinite(density)) {
      lines.push(`- Density: ${fmt(density)} g/cm^3`)
    }
    const pbc = lat.pbc?.map((p) => (p ? `T` : `F`)).join(``) ?? `TTT`
    lines.push(`- PBC: ${pbc}`)
  }

  // Charge
  if (structure.charge && structure.charge !== 0) {
    lines.push(`- Charge: ${structure.charge}`)
  }

  // Symmetry
  if (symmetry_data) {
    lines.push(`\n## Symmetry`)
    lines.push(
      `- Space group: ${symmetry_data.number} (${symmetry_data.hm_symbol})`,
    )
    if (symmetry_data.pearson_symbol) {
      lines.push(`- Pearson symbol: ${symmetry_data.pearson_symbol}`)
    }
    lines.push(`- Symmetry operations: ${symmetry_data.operations.length}`)

    // Wyckoff positions summary
    if (symmetry_data.wyckoffs?.length > 0) {
      const wyckoff_counts: Record<string, string[]> = {}
      for (let i = 0; i < symmetry_data.wyckoffs.length; i++) {
        const wp = symmetry_data.wyckoffs[i]
        const elem = structure.sites[i]?.species[0]?.element ?? `?`
        if (!wyckoff_counts[wp]) wyckoff_counts[wp] = []
        if (!wyckoff_counts[wp].includes(elem)) wyckoff_counts[wp].push(elem)
      }
      const wp_str = Object.entries(wyckoff_counts)
        .map(([wp, elems]) => `${wp}(${elems.join(`,`)})`)
        .join(` `)
      lines.push(`- Wyckoff positions: ${wp_str}`)
    }
  }

  // Selected sites
  if (selected_sites && selected_sites.length > 0) {
    lines.push(`\n## Selected Atoms`)
    const max_show = 10
    const to_show = selected_sites.slice(0, max_show)
    for (const idx of to_show) {
      const site = structure.sites[idx]
      if (!site) continue
      const elem = site.species[0]?.element ?? `?`
      const coords = site.xyz.map((v) => fmt(v)).join(`, `)
      lines.push(`- Site ${idx}: ${elem} at (${coords}) A`)
    }
    if (selected_sites.length > max_show) {
      lines.push(`- ... and ${selected_sites.length - max_show} more selected`)
    }
  }

  // Per-site properties summary (forces, charges, etc.)
  const first_site = structure.sites[0]
  if (first_site?.properties && Object.keys(first_site.properties).length > 0) {
    const prop_keys = Object.keys(first_site.properties)
    lines.push(`\n## Available Site Properties`)
    lines.push(`- Properties: ${prop_keys.join(`, `)}`)

    // Show force stats if available
    if (first_site.properties.forces) {
      const forces = structure.sites
        .map((s) => s.properties?.forces as number[] | undefined)
        .filter(Boolean)
      if (forces.length > 0) {
        const magnitudes = forces.map((f) =>
          Math.sqrt(f![0] ** 2 + f![1] ** 2 + f![2] ** 2)
        )
        const max_f = Math.max(...magnitudes)
        lines.push(`- Max force magnitude: ${fmt(max_f, 4)} eV/A`)
      }
    }
  }

  const out = lines.join(`\n`)
  // Safety cap. This is a SUMMARY (no per-atom dump — selected sites are already
  // capped at `max_show`), so it's normally a few hundred chars regardless of
  // atom count. The cap only guards a pathological structure (e.g. thousands of
  // distinct species/Wyckoff entries) from bloating the prompt. ~4000 chars
  // (~1k tokens) is far above any real summary, so it never trims normal input.
  const MAX_CONTEXT_CHARS = 4000
  if (out.length > MAX_CONTEXT_CHARS) {
    return out.slice(0, MAX_CONTEXT_CHARS) +
      `\n\n… (structure summary truncated)`
  }
  return out
}

/** Build workflow context string from shared workflow state */
export function build_workflow_context(wf: ActiveWorkflow): string {
  if (!wf.id) return ``

  const lines: string[] = []
  lines.push(`## Active Workflow`)
  lines.push(`- Name: ${wf.name}`)
  lines.push(`- ID: ${wf.id}`)
  lines.push(`- Status: ${wf.status}`)

  if (wf.nodes.length > 0) {
    lines.push(`\n### Nodes (${wf.nodes.length})`)
    for (const node of wf.nodes) {
      const status = wf.node_statuses[node.id]
      const status_str = status ? ` [${status}]` : ``
      const key_params = Object.entries(node.params)
        .slice(0, 5)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(`, `)
      const params_str = key_params ? ` (${key_params})` : ``
      lines.push(
        `- ${node.label} (id: ${node.id}, type: ${node.type})${status_str}${params_str}`,
      )
    }
  }

  if (wf.edges.length > 0) {
    lines.push(`\n### Edges (${wf.edges.length})`)
    for (const edge of wf.edges) {
      const from_node = wf.nodes.find((n) => n.id === edge.from)
      const to_node = wf.nodes.find((n) => n.id === edge.to)
      lines.push(
        `- ${from_node?.label ?? edge.from} → ${to_node?.label ?? edge.to}`,
      )
    }
  }

  // Show failed steps
  const failed = Object.entries(wf.node_statuses)
    .filter(([, status]) => status === `failed`)
  if (failed.length > 0) {
    lines.push(`\n### Failed Steps`)
    for (const [step_id] of failed) {
      const node = wf.nodes.find((n) => n.id === step_id)
      lines.push(`- ${node?.label ?? step_id} (id: ${step_id})`)
    }
  }

  if (wf.error) {
    lines.push(`\n### Latest Error`)
    lines.push(wf.error)
  }

  return lines.join(`\n`)
}

/** Build paper context string for injection into system prompt */
export function build_paper_context(data: {
  title: string
  authors: string[]
  doi: string
  abstract: string
  full_text: string
  page_count: number
}): string {
  const lines: string[] = []
  lines.push(`## Imported Paper`)
  if (data.title) lines.push(`- Title: ${data.title}`)
  if (data.authors?.length) lines.push(`- Authors: ${data.authors.join(`, `)}`)
  if (data.doi) lines.push(`- DOI: ${data.doi}`)
  if (data.page_count) lines.push(`- Pages: ${data.page_count}`)
  lines.push(``)

  if (data.abstract) {
    lines.push(`### Abstract`)
    lines.push(data.abstract)
    lines.push(``)
  }

  const text = data.full_text || ``
  if (text.length > 30000) {
    // Try to find a "Methods" / "Computational" section and prioritize it
    const methods_idx = text.search(
      /(?:computational\s+(?:details|methods)|methods?\s+section|DFT\s+calculations|calculation\s+details)/i,
    )
    if (methods_idx > 0) {
      const before = text.slice(0, Math.min(methods_idx, 5000))
      const methods = text.slice(methods_idx, methods_idx + 20000)
      const end = text.slice(-5000)
      lines.push(`### Paper Text (truncated, methods-focused)`)
      lines.push(before)
      lines.push(`\n[...]\n`)
      lines.push(methods)
      lines.push(`\n[...]\n`)
      lines.push(end)
    } else {
      lines.push(`### Paper Text (truncated)`)
      lines.push(text.slice(0, 25000))
      lines.push(`\n[... truncated at 25000 chars ...]\n`)
      lines.push(text.slice(-5000))
    }
  } else if (text) {
    lines.push(`### Paper Full Text`)
    lines.push(text)
  }

  return lines.join(`\n`)
}

/** Build paper context from DOI metadata (no full text) */
export function build_paper_context_from_doi(data: {
  title: string
  authors: string[]
  doi: string
  abstract: string
  journal: string
  year: number | null
}): string {
  const lines: string[] = []
  lines.push(`## Imported Paper`)
  if (data.title) lines.push(`- Title: ${data.title}`)
  if (data.authors?.length) lines.push(`- Authors: ${data.authors.join(`, `)}`)
  if (data.doi) lines.push(`- DOI: ${data.doi}`)
  if (data.journal) lines.push(`- Journal: ${data.journal}`)
  if (data.year) lines.push(`- Year: ${data.year}`)
  if (data.abstract) {
    lines.push(``)
    lines.push(`### Abstract`)
    lines.push(data.abstract)
  }
  lines.push(``)
  lines.push(
    `Note: Only metadata available from DOI. For full paper text, upload the PDF.`,
  )
  return lines.join(`\n`)
}

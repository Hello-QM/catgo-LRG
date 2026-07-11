import type { ClipboardSite } from '$lib/state.svelte'

const MARKER = `CATGO_ATOMS_V1`

export function serialize_atoms(sites: ClipboardSite[]): string {
  return `${MARKER}\n${JSON.stringify(sites)}`
}

export function parse_atoms(text: string): ClipboardSite[] | null {
  if (!text || !text.startsWith(MARKER)) return null
  try {
    const body = text.slice(text.indexOf(`\n`) + 1)
    const parsed = JSON.parse(body)
    return Array.isArray(parsed) ? (parsed as ClipboardSite[]) : null
  } catch {
    return null
  }
}

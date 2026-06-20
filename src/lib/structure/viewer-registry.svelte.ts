import type { AnyStructure } from '$lib'
import { API_BASE, STATIC_ONLY } from '$lib/api/config'

export type ViewerPosition =
  | `single`
  | `left`
  | `right`
  | `top`
  | `bottom`
  | `top-left`
  | `top-right`
  | `bottom-left`
  | `bottom-right`
  | `hidden`

export interface AtomGraphEntry {
  index: number
  element: string
  xyz: number[]
  neighbors: number[]
  coordination: number
  component: number
  terminal: boolean
  branch_candidate: boolean
}

export interface ViewerManifest {
  viewer_id: string
  tab_id: string
  leaf_id: string
  position: ViewerPosition
  pane_number: number
  label: string
  filename: string | null
  formula: string
  kind: `empty` | `structure` | `trajectory`
  active: boolean
  current_frame: number
  total_frames: number
  atom_count: number
  streaming: boolean
  editable: boolean
}

export interface ViewerMutationResult {
  viewer_id: string
  scope: `structure` | `all_frames`
  atom_count: number
  total_frames: number
}

export interface ViewerHandle {
  get_manifest: () => ViewerManifest
  get_structure: () => AnyStructure | undefined
  set_structure: (structure: AnyStructure) => void
  set_scene_prop?: (key: string, value: unknown) => void
  reset_camera?: () => void
  set_selection?: (indices: number[]) => void
  select_by_element?: (element: string) => number
  clear_selection?: () => void
  inspect_atoms?: () => AtomGraphEntry[]
  add_atom?: (element: string, position: [number, number, number]) => ViewerMutationResult
  delete_atoms?: (indices: number[]) => ViewerMutationResult
  replace_atoms?: (indices: number[], element: string) => ViewerMutationResult
  move_atoms?: (displacements: Map<number, [number, number, number]>) => ViewerMutationResult
  scale_geometry?: (factor: number) => ViewerMutationResult
}

const manifests = $state<Record<string, ViewerManifest>>({})
const handles = new Map<string, ViewerHandle>()
let active_viewer_id = $state<string | null>(null)

function publish_manifest(manifest: ViewerManifest): void {
  if (STATIC_ONLY || import.meta.env?.MODE === `test` || typeof fetch === `undefined`) return
  void fetch(`${API_BASE}/view/manifest/update`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(manifest),
  }).catch(() => {})
}

export function register_viewer(handle: ViewerHandle): () => void {
  const id = handle.get_manifest().viewer_id
  handles.set(id, handle)
  manifests[id] = handle.get_manifest()
  publish_manifest(manifests[id])
  if (manifests[id].active) active_viewer_id = id
  return () => {
    if (handles.get(id) === handle) handles.delete(id)
    delete manifests[id]
    if (!STATIC_ONLY && import.meta.env?.MODE !== `test` && typeof fetch !== `undefined`) {
      void fetch(
        `${API_BASE}/view/manifest?viewer_id=${encodeURIComponent(id)}`,
        { method: `DELETE` },
      ).catch(() => {})
    }
    if (active_viewer_id === id) active_viewer_id = null
  }
}

export function refresh_viewer_manifest(viewer_id: string): void {
  const handle = handles.get(viewer_id)
  if (!handle) return
  const next = handle.get_manifest()
  manifests[viewer_id] = next
  publish_manifest(next)
  if (next.active) active_viewer_id = viewer_id
  else if (active_viewer_id === viewer_id) active_viewer_id = null
}

export function set_active_viewer(viewer_id: string | null): void {
  active_viewer_id = viewer_id
}

export function get_active_viewer_id(): string | null {
  return active_viewer_id
}

export function viewer_manifests_state(): {
  manifests: Record<string, ViewerManifest>
  active_viewer_id: string | null
} {
  return {
    get manifests() { return manifests },
    get active_viewer_id() { return active_viewer_id },
  }
}

export function list_viewers(tab_id?: string): ViewerManifest[] {
  return Object.values(manifests)
    .filter((m) => !tab_id || m.tab_id === tab_id)
    .sort((a, b) => a.pane_number - b.pane_number)
}

const POSITION_ALIASES: Record<string, ViewerPosition> = {
  single: `single`,
  left: `left`,
  right: `right`,
  top: `top`,
  bottom: `bottom`,
  'top-left': `top-left`,
  'top-right': `top-right`,
  'bottom-left': `bottom-left`,
  'bottom-right': `bottom-right`,
  '左': `left`,
  '右': `right`,
  '上': `top`,
  '下': `bottom`,
  '左上': `top-left`,
  '右上': `top-right`,
  '左下': `bottom-left`,
  '右下': `bottom-right`,
  '左上角': `top-left`,
  '右上角': `top-right`,
  '左下角': `bottom-left`,
  '右下角': `bottom-right`,
}

export function resolve_viewer(
  ref?: string | null,
  tab_id?: string,
): { handle?: ViewerHandle; manifest?: ViewerManifest; error?: string } {
  const candidates = list_viewers(tab_id)
  const raw = ref?.trim()
  if (!raw) {
    const id = active_viewer_id
    const handle = id ? handles.get(id) : undefined
    if (handle) return { handle, manifest: handle.get_manifest() }
    if (candidates.length === 1) {
      const only = candidates[0]
      return { handle: handles.get(only.viewer_id), manifest: only }
    }
    return { error: `No active viewer. Specify viewer_id or a pane position.` }
  }

  const direct = handles.get(raw)
  if (direct) return { handle: direct, manifest: direct.get_manifest() }

  const normalized = raw.toLowerCase().replace(/\s+/g, `-`)
  const position = POSITION_ALIASES[normalized]
  let matches = position ? candidates.filter((m) => m.position === position) : []
  if (!matches.length) {
    const pane_match = normalized.match(/(?:pane|window|窗口)[-_ ]?(\d+)/i)
    if (pane_match) {
      const n = Number(pane_match[1])
      matches = candidates.filter((m) => m.pane_number === n)
    }
  }
  if (!matches.length) {
    // Exact name/stem/label only — substring (`o` → `POSCAR`) routes to the
    // wrong pane. Mirrors the server's resolve_viewer_ref.
    const needle = raw.toLowerCase()
    matches = candidates.filter((m) => {
      const filename = m.filename?.toLowerCase() ?? ``
      const stem = filename.includes(`.`)
        ? filename.slice(0, filename.lastIndexOf(`.`))
        : filename
      return filename === needle || stem === needle || m.label.toLowerCase() === needle
    })
  }
  if (matches.length !== 1) {
    return {
      error: matches.length
        ? `Viewer reference "${raw}" is ambiguous: ${matches.map((m) => m.viewer_id).join(`, `)}.`
        : `Viewer "${raw}" was not found.`,
    }
  }
  const manifest = matches[0]
  return { handle: handles.get(manifest.viewer_id), manifest }
}

export function build_workspace_context(tab_id: string): string {
  const rows = list_viewers(tab_id)
  if (!rows.length) return ``
  return [
    `## Viewer Workspace`,
    `Use viewer_id for every viewer or structure tool when the user names a pane position.`,
    `If a position is ambiguous or an atom description has multiple candidates, inspect first and ask the user.`,
    ...rows.map((m) => {
      const trajectory = m.kind === `trajectory`
        ? `trajectory ${m.current_frame + 1}/${m.total_frames}`
        : m.kind
      return `- ${m.position} | viewer_id=${m.viewer_id} | ${m.label} | ${trajectory} | ${m.atom_count} atoms${m.active ? ` | ACTIVE` : ``}`
    }),
  ].join(`\n`)
}

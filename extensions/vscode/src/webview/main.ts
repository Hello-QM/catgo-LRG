// deno-lint-ignore-file require-await
// Import CatGo parsing functions and components
import '$lib/app.css'
import { setServerUrl } from '$lib/api/config'
import { setApiBase } from '$lib/api/compute'
import { setOptimadeApiBase } from '$lib/api/optimade'
import { setPubChemApiBase } from '$lib/api/pubchem'
import { setMPApiBase } from '$lib/api/materials-project'

// NOTE: we deliberately do NOT register the `set_vscode_api` / `set_vscode_pubchem_api`
// / `set_vscode_mp_api` proxies any more.  Those routed every external HTTPS
// call through the extension host's undici fetch (`postMessage('optimade_fetch')`
// etc.), which fails on VS Code 1.105's bundled Node with a bare
// `TypeError: fetch failed` (probably an IPv6 / TLS-stack quirk in Electron's
// undici bundle).  The bundled catgo-server sidecar's Python httpx is the
// reliable fallback, so we just let every `${API_BASE}/optimade/*` /
// `${API_BASE}/pubchem/*` / `${API_BASE}/mp/*` request hit the local sidecar
// over plain localhost HTTP and the sidecar proxies to the upstream APIs
// from there.  Closes the "fetch failed" + "Unknown provider: pubchem"
// chain reported in issue #14.
import { decompress_data, detect_compression_format } from '$lib/io/decompress'
import { parse_structure_file } from '$lib/structure/parse'
import type { AnyStructure } from '$lib'
import {
  structure_to_cif_str,
  structure_to_extxyz_str,
  structure_to_json_str,
  structure_to_mol2_str,
  structure_to_pdb_str,
  structure_to_poscar_str,
  structure_to_xyz_str,
} from '$lib/structure/export'
import { parse_cube_header, cube_atoms_to_molecule } from '$lib/cube/parse-cube'
import { chgcar_to_cube } from '$lib/electronic/chgdiff-wasm'
import Structure from '$lib/structure/Structure.svelte'
import { apply_theme_to_dom, is_valid_theme_name, type ThemeName } from '$lib/theme/index'
import { set_locale } from '$lib/i18n/index.svelte'
import '$lib/theme/themes'
import { ensure_ferrox_wasm_ready } from '$lib/structure/ferrox-wasm'
import { ensure_moyo_wasm_ready } from '$lib/symmetry'
import type { LoadingOptions } from '$lib/trajectory/parse'
import { is_trajectory_file, parse_trajectory_async } from '$lib/trajectory/parse'
// Add frame loader import
import { COMPRESSION_EXTENSIONS_REGEX } from '$lib/constants'
import { type DefaultSettings, merge } from '$lib/settings'
import type {
  FrameIndex,
  FrameLoader,
  FramePositionData,
  TrajectoryFrame,
  TrajectoryMetadata,
  TrajectoryType,
} from '$lib/trajectory/index'
import Trajectory from '$lib/trajectory/Trajectory.svelte'
import { mount, unmount } from 'svelte'

type ViewType = `trajectory` | `structure`
export interface FileData {
  filename: string
  content: string
  is_base64: boolean
}

export interface CatGoData {
  type: ViewType
  data: FileData
  theme: ThemeName
  locale?: `en` | `zh` // webview UI language, resolved from catgo.language by the extension
  defaults?: DefaultSettings
  wasm_binary?: string // base64-encoded ferrox WASM binary from extension
  moyo_wasm_binary?: string // base64-encoded moyo WASM binary from extension
  chgdiff_wasm_binary?: string // base64-encoded chgdiff WASM binary from extension
  catrender_wasm_binary?: string // base64-encoded catrender WASM binary from extension
}

export interface ParseResult {
  type: ViewType
  data: unknown
  filename: string
  // For trajectories that support VS Code streaming
  streaming_info?: { supports_streaming: boolean; file_path: string }
  // Cube/CHGCAR file content for isosurface rendering in Structure component
  cube_file?: File
}

export interface CatGoApp {
  $on?(type: string, callback: (event: Event) => void): () => void
  $set?(props: Partial<Record<string, unknown>>): void
}

export interface FileChangeMessage {
  command: `fileUpdated` | `fileDeleted`
  file_path?: string
  data?: FileData
  type?: ViewType
  theme?: ThemeName
}

// VS Code Frame Loader - streams frames via extension communication
class VSCodeFrameLoader implements FrameLoader {
  private readonly position_requests =
    new Map<number, Promise<FramePositionData | null>>()
  private readonly plot_requests =
    new Map<number, Promise<TrajectoryMetadata[]>>()

  constructor(private file_path: string, private vscode_api: VSCodeAPI) {}

  fork(): FrameLoader {
    return new VSCodeFrameLoader(this.file_path, this.vscode_api)
  }

  private request<T>(
    command: string,
    response_command: string,
    payload: Record<string, unknown>,
    timeout_label: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const request_id = crypto.randomUUID()
      let timer: ReturnType<typeof setTimeout> | null = null
      const handler = (event: MessageEvent) => {
        const { command: response, request_id: id, error } = event.data
        if (response === response_command && id === request_id) {
          globalThis.removeEventListener(`message`, handler)
          if (timer) clearTimeout(timer)
          if (error) reject(new Error(error))
          else resolve(event.data as T)
        }
      }

      globalThis.addEventListener(`message`, handler)
      this.vscode_api.postMessage({
        command,
        request_id,
        file_path: this.file_path,
        ...payload,
      })

      timer = setTimeout(() => {
        globalThis.removeEventListener(`message`, handler)
        reject(new Error(`${timeout_label} timeout`))
      }, 30000)
    })
  }

  async load_frame(
    _data: string | ArrayBuffer,
    frame_index: number,
  ): Promise<TrajectoryFrame | null> {
    const response = await this.request<{ frame: TrajectoryFrame | null }>(
      `request_frame`,
      `frame_response`,
      { frame_index },
      `Frame ${frame_index}`,
    )
    return response.frame
  }

  async load_frame_positions(
    _data: string | ArrayBuffer,
    frame_index: number,
  ): Promise<FramePositionData | null> {
    const cached = this.position_requests.get(frame_index)
    if (cached) return cached
    const pending = this.request<{ position_data: FramePositionData | null }>(
      `request_frame_positions`,
      `frame_positions_response`,
      { frame_index },
      `Frame positions ${frame_index}`,
    ).then(({ position_data }) => {
      if (!position_data) return null
      return {
        ...position_data,
        positions: float32_array(position_data.positions),
        forces: position_data.forces
          ? float32_array(position_data.forces)
          : null,
      }
    }).catch((error) => {
      this.position_requests.delete(frame_index)
      throw error
    })
    this.position_requests.set(frame_index, pending)
    while (this.position_requests.size > 16) {
      const oldest = this.position_requests.keys().next().value
      if (oldest === undefined) break
      this.position_requests.delete(oldest)
    }
    return pending
  }

  async get_total_frames(): Promise<number> {
    throw new Error(`Not implemented`)
  }
  async build_frame_index(): Promise<FrameIndex[]> {
    throw new Error(`Not implemented`)
  }
  async extract_plot_metadata(
    _data: string | ArrayBuffer,
    options?: { sample_rate?: number; properties?: string[] },
  ): Promise<TrajectoryMetadata[]> {
    const sample_rate = Math.max(1, options?.sample_rate ?? 1)
    const cached = this.plot_requests.get(sample_rate)
    if (cached) return cached
    const pending = this.request<{ plot_metadata: TrajectoryMetadata[] }>(
      `request_plot_metadata`,
      `plot_metadata_response`,
      { sample_rate },
      `Trajectory plot metadata`,
    ).then(({ plot_metadata }) => plot_metadata ?? []).catch((error) => {
      this.plot_requests.delete(sample_rate)
      throw error
    })
    this.plot_requests.set(sample_rate, pending)
    return pending
  }
}

function float32_array(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value
  if (value instanceof ArrayBuffer) return new Float32Array(value)
  if (ArrayBuffer.isView(value)) {
    return Float32Array.from(value as unknown as ArrayLike<number>)
  }
  if (Array.isArray(value)) return Float32Array.from(value)
  if (value && typeof value === `object`) {
    const record = value as Record<string, number>
    return Float32Array.from(
      Object.keys(record)
        .filter((key) => /^\d+$/.test(key))
        .sort((left, right) => Number(left) - Number(right))
        .map((key) => record[key]),
    )
  }
  return new Float32Array(0)
}

export type TrajectoryData = TrajectoryType

export interface StructureData {
  sites?: unknown[]
}

export interface VSCodeAPI {
  postMessage(message: unknown): void
}

// Extend globalThis interface for CatGo data
declare global {
  interface Window {
    catgoData?: CatGoData
    initializeCatGo?: () => Promise<CatGoApp | null>
    cleanupCatGo?: () => Promise<void>
    download?: (data: string | Blob, filename: string) => void
  }
  var catgoData: CatGoData | undefined

  // VSCode webview API
  function acquireVsCodeApi(): VSCodeAPI
}

// Store VSCode API instance to avoid multiple acquisitions
let vscode_api: VSCodeAPI | null = null
let current_app: CatGoApp | null = null

// Live structure for save round-trips: seeded with the parsed source file when
// a (non-trajectory) Structure is mounted, refreshed by every
// `on_structure_change` emission from the Structure component. `requestContent`
// serializes this in the SOURCE file's format (xyz→xyz, POSCAR→POSCAR, …) —
// never the last export format the user may have picked in the UI.
let current_structure: AnyStructure | null = null
let source_filename = ``

// Global backend port — set once server is ready, read by fetch/WebSocket interceptors.
// Backend-bound fetch/WebSocket calls made before the port is known are parked in
// `_port_waiters` and resumed via _apply_port(). Without this gate the backend URL
// resolves against the webview origin (`vscode-webview://...`) and VSCode returns 403.
let _backend_port: number | null = null
const _port_waiters: Array<() => void> = []
const _await_backend_port = (): Promise<number> => {
  if (_backend_port !== null) return Promise.resolve(_backend_port)
  return new Promise((resolve) => {
    _port_waiters.push(() => resolve(_backend_port as number))
  })
}
const _apply_port = (port: number) => {
  if (_backend_port === port) return
  _backend_port = port
  setServerUrl(`http://127.0.0.1:${port}`)
  setApiBase(`http://127.0.0.1:${port}/api`)
  // OPTIMADE / PubChem / Materials Project modules keep their own local API_BASE
  // (ES-module `let` rebinding breaks the live binding from config.ts), so we
  // have to push the port to each of them explicitly — otherwise their default
  // `http://localhost:8000/api` stays cached and every database search request
  // dies before reaching the bundled catgo-server.
  setOptimadeApiBase(`http://127.0.0.1:${port}/api`)
  setPubChemApiBase(`http://127.0.0.1:${port}/api`)
  setMPApiBase(`http://127.0.0.1:${port}/api`)
  console.log(`[CatGO Webview] Backend port set to ${port}`)
  globalThis.dispatchEvent(new CustomEvent(`catgo-server-ready`, { detail: { port } }))
  // Release any fetches/WebSockets that were waiting on the port
  const waiters = _port_waiters.splice(0)
  for (const wake of waiters) wake()
}

const _BACKEND_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1):\d+\//
const _needs_backend = (url: string): boolean =>
  url.startsWith('/api/') || url === '/api' || url.startsWith('/health') ||
  _BACKEND_URL_RE.test(url)
const _rewrite_backend_url = (url: string, port: number): string => {
  if (url.startsWith('/api/') || url === '/api' || url.startsWith('/health')) {
    return `http://127.0.0.1:${port}${url}`
  }
  return url.replace(/^(https?):\/\/(localhost|127\.0\.0\.1):\d+/, `http://127.0.0.1:${port}`)
}

// Monkey-patch fetch to rewrite API URLs to the actual backend port.
// If the port isn't known yet, the call is parked until _apply_port fires.
const _original_fetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async function (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url
  if (!_needs_backend(url)) return _original_fetch(input, init)
  const port = _backend_port ?? await _await_backend_port()
  return _original_fetch(_rewrite_backend_url(url, port), init)
}

// Monkey-patch WebSocket for optimization progress streaming.
// The constructor is synchronous, so callers must only create sockets after
// the backend port is known. Users trigger this via UI actions (e.g., clicking
// Optimize), which happens well after _apply_port has fired.
const _OriginalWebSocket = globalThis.WebSocket
globalThis.WebSocket = class extends _OriginalWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    let u = typeof url === 'string' ? url : url.href
    if (_backend_port === null) {
      console.warn('[CatGo] WebSocket created before backend port ready:', u)
    } else if (
      u.startsWith('/api/') || u.startsWith('ws:/api/') ||
      /^wss?:\/\/(localhost|127\.0\.0\.1):\d+\//.test(u)
    ) {
      if (u.startsWith('/') || u.startsWith('ws:/api/')) {
        const path = u.startsWith('ws:/') ? u.slice(3) : u
        u = `ws://127.0.0.1:${_backend_port}${path}`
      } else {
        u = u.replace(/^(wss?):\/\/(localhost|127\.0\.0\.1):\d+/, `ws://127.0.0.1:${_backend_port}`)
      }
    }
    super(u, protocols)
  }
} as typeof WebSocket

// Set up message listener EARLY (at module load time) so we don't miss server_ready
// events that arrive before initialize() completes.
globalThis.addEventListener(`message`, (event) => {
  if (event.data?.command === `server_ready` && event.data.port) {
    _apply_port(event.data.port)
  }
})

// Initialize VSCode API at module level
try {
  vscode_api = globalThis.acquireVsCodeApi?.() ?? null
  // Intentionally NOT calling `set_optimade_vscode_api` / `set_vscode_pubchem_api`
  // / `set_vscode_mp_api` here — see the comment at the top of this file.
  // The bundled catgo-server sidecar at `${API_BASE}` is the canonical proxy
  // for all upstream HTTP traffic, and routing through the extension host's
  // undici fetch is the source of the "fetch failed" errors in issue #14.
} catch (error) {
  console.warn(`VSCode API already acquired or not available:`, error)
  vscode_api = null
}

const get_catgo_data = (): CatGoData | undefined =>
  (globalThis as unknown as { catgoData?: CatGoData }).catgoData

// Set up VSCode-specific download override for file exports
export const setup_vscode_download = (): void => {
  if (!vscode_api) return
  ;(globalThis as unknown as Window).download = (
    data: string | Blob,
    filename: string,
  ): void => {
    if (!filename?.trim()) {
      console.error(`Invalid filename provided to download`)
      return
    }

    const send_message = (content: string, is_binary: boolean) => {
      vscode_api?.postMessage({
        command: `saveAs`,
        content,
        filename,
        is_binary,
      })
    }

    try {
      if (typeof data === `string`) {
        send_message(data, false)
      } else {
        const reader = new FileReader()
        reader.onload = () => send_message(reader.result as string, true)
        reader.onerror = () => {
          console.error(`Failed to read binary data for download`)
          vscode_api?.postMessage({
            command: `error`,
            text: `Failed to read binary data for download`,
          })
        }
        reader.readAsDataURL(data)
      }
    } catch (error) {
      console.error(`VSCode download failed:`, error)
      vscode_api?.postMessage({
        command: `error`,
        text: `Download failed: ${error}`,
      })
    }
  }
}

// Serialize the current (edited) structure in the SOURCE file's format —
// xyz→xyz, POSCAR→POSCAR, … — using the same `$lib/structure/export`
// serializers the in-app export/download path uses on the same base
// `structure`. Reads the live structure kept fresh by `on_structure_change`,
// so content reflects all edits at the moment of the request. Returns null
// when there is no structure (trajectory view) or the source format has no
// frontend serializer (OUTCAR, cube/CHGCAR, LAMMPS data, …) — the extension
// must treat an empty `content` reply as "cannot save".
// DRIFT NOTE: the desktop app shares this format→serializer dispatch as
// `save_format_from_path` in `src/lib/structure/save-format.ts`. This webview
// copy stays separate for bundle isolation — keep the two in lockstep (both
// cover xyz/extxyz/cif/mol2/pdb/json/POSCAR-family and refuse everything else).
export const serialize_current = (): {
  content: string
  is_binary: boolean
  filename: string
} | null => {
  if (!current_structure || !source_filename) return null
  // Mirror parse dispatch: strip compression extensions before reading the ext.
  let base = source_filename.toLowerCase()
  while (COMPRESSION_EXTENSIONS_REGEX.test(base)) {
    base = base.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
  }
  const ext = base.split(`.`).pop() ?? ``
  try {
    let content: string | null = null
    if (ext === `xyz`) content = structure_to_xyz_str(current_structure)
    else if (ext === `extxyz`) content = structure_to_extxyz_str(current_structure)
    else if (ext === `cif`) content = structure_to_cif_str(current_structure)
    else if (ext === `mol2`) content = structure_to_mol2_str(current_structure)
    else if (ext === `pdb`) content = structure_to_pdb_str(current_structure)
    else if (ext === `json`) content = structure_to_json_str(current_structure)
    else if (
      ext === `poscar` || ext === `vasp` || /poscar|contcar/.test(base)
    ) content = structure_to_poscar_str(current_structure)
    if (content === null) return null
    return { content, is_binary: false, filename: source_filename }
  } catch (error) {
    // e.g. POSCAR serializer throws when the structure has no lattice
    console.error(`[CatGO Webview] Failed to serialize ${source_filename}:`, error)
    return null
  }
}

// Answer an extension-host content request (save round-trip). Always replies —
// an empty `content` signals "nothing serializable" to the extension.
const handle_content_request = (request_id: string): void => {
  const payload = serialize_current()
  vscode_api?.postMessage({
    command: `content`,
    request_id,
    content: payload?.content ?? ``,
    is_binary: payload?.is_binary ?? false,
    filename: payload?.filename ?? ``,
  })
}

// Handle file change events from extension
const handle_file_change = async (message: FileChangeMessage): Promise<void> => {
  if (message.command === `fileDeleted`) {
    // File was deleted - show error message
    const container = document.getElementById(`catgo-app`)
    if (container) {
      container.innerHTML = `
        <div style="padding: 2rem; text-align: center; color: var(--vscode-errorForeground);">
          <h2>File Deleted</h2>
          <p>The file "${message.file_path}" has been deleted.</p>
        </div>
      `
    }
    return
  }

  if (message.command === `fileUpdated` && message.data) {
    try {
      if (message.theme && is_valid_theme_name(message.theme)) {
        apply_theme_to_dom(message.theme)
      }

      const { content, filename, is_base64 } = message.data
      const result = await parse_file_content(content, filename, undefined, is_base64)

      // Update the display
      const container = document.getElementById(`catgo-app`)
      if (container && current_app) {
        await unmount(current_app) // unmount the existing component to prevent memory leaks
        current_app = create_display(container, result, result.filename)
      }

      vscode_api?.postMessage({ command: `info`, text: `File reloaded successfully` })
    } catch (error) {
      console.error(`Failed to reload file:`, error)
      vscode_api?.postMessage({
        command: `error`,
        text: `Failed to reload file: ${error}`,
      })
    }
  }
}

// Convert base64 to ArrayBuffer for binary files
export function base64_to_array_buffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let idx = 0; idx < binary.length; idx++) {
    bytes[idx] = binary.charCodeAt(idx)
  }
  return bytes.buffer
}

// Request large file content from the extension using chunked streaming
function request_large_file_content(
  file_path: string,
  filename: string,
  is_compressed: boolean,
  timeout: number = 30_000, // 30 seconds
): Promise<
  string | ArrayBuffer | {
    trajectory: TrajectoryData
    supports_streaming: boolean
    file_path: string
  }
> {
  if (!vscode_api) throw new Error(`VS Code API not available`)

  return new Promise((resolve, reject) => {
    const request_id = crypto.randomUUID()

    let timer: ReturnType<typeof setTimeout> | null = null
    const handler = (event: MessageEvent) => {
      const { command, request_id: id, error, parsed_trajectory } = event.data
      const { is_parsed, stage, progress } = event.data
      if (command === `large_file_progress` && id === request_id) {
        // TODO maybe forward file load progress to UI
        console.log(`Progress: ${stage} - ${progress}%`)
        return
      }
      if (command === `large_file_response` && id === request_id) {
        globalThis.removeEventListener(`message`, handler)
        if (timer) clearTimeout(timer)
        if (error) return reject(new Error(error))
        if (is_parsed && parsed_trajectory) {
          return resolve({
            trajectory: parsed_trajectory,
            supports_streaming: true,
            file_path,
          })
        }
        resolve(event.data.content)
      }
    }

    globalThis.addEventListener(`message`, handler)
    vscode_api.postMessage({
      command: `request_large_file`,
      request_id,
      file_path,
      filename,
      is_compressed,
    })

    timer = setTimeout(() => {
      globalThis.removeEventListener(`message`, handler)
      reject(new Error(`Large file timeout`))
    }, timeout)
  })
}

// Parse file content and determine if it's a structure or trajectory
const parse_file_content = async (
  content: string,
  filename: string,
  loading_options?: LoadingOptions,
  is_compressed: boolean = false,
  recursion_depth: number = 0,
): Promise<ParseResult> => {
  if (recursion_depth > 2) {
    throw new Error(
      `parse_file_content exceeded max recursion depth=2 while parsing file ${filename}`,
    )
  }

  // Check if this is a large file marker from the extension
  if (content.startsWith(`LARGE_FILE:`)) {
    const marker = /^LARGE_FILE:(.*):(\d+)$/.exec(content)
    if (!marker) throw new Error(`Invalid large-file marker`)
    const [, file_path, file_size_str] = marker
    const file_size = parseInt(file_size_str, 10)

    console.log(
      `Handling large file: ${filename} (${Math.round(file_size / 1024 / 1024)}MB)`,
    )

    const parsed_trajectory = await request_large_file_content(
      file_path,
      filename,
      is_compressed,
    )

    // Check if we received a pre-parsed trajectory with VS Code streaming support
    if (
      parsed_trajectory && typeof parsed_trajectory === `object` &&
      `trajectory` in parsed_trajectory && `supports_streaming` in parsed_trajectory
    ) {
      const { trajectory, supports_streaming, file_path } = parsed_trajectory
      const streaming_info = { supports_streaming, file_path }
      return { type: `trajectory`, data: trajectory, filename, streaming_info }
    }

    // Fallback: if not pre-parsed, treat as raw content
    return parse_file_content(
      parsed_trajectory as string,
      filename,
      loading_options,
      is_compressed,
      recursion_depth + 1,
    )
  }

  // Handle compressed/binary files by converting from base64 first
  if (is_compressed) {
    const buffer = base64_to_array_buffer(content)

    // For HDF5 files, pass buffer directly to trajectory parser
    if (/\.(h5|hdf5)$/i.test(filename)) {
      const data = await parse_trajectory_async(
        buffer,
        filename,
        undefined,
        loading_options,
      )
      return { type: `trajectory`, filename, data }
    }

    // For ASE .traj files, pass buffer directly to trajectory parser
    if (/\.traj$/i.test(filename)) {
      const data = await parse_trajectory_async(
        buffer,
        filename,
        undefined,
        loading_options,
      )
      return { type: `trajectory`, filename, data }
    }

    // Unified handling for all supported compression formats
    const format = detect_compression_format(filename)
    if (format && format !== `zip`) { // Skip ZIP as it's not supported in browser
      content = await decompress_data(buffer, format)
      filename = filename.replace(COMPRESSION_EXTENSIONS_REGEX, ``)
    }
  }

  // Try trajectory parsing first if it looks like a trajectory
  if (is_trajectory_file(filename, content)) {
    const data = await parse_trajectory_async(
      content,
      filename,
      undefined,
      loading_options,
    )
    return { type: `trajectory`, data, filename }
  }

  // Gaussian cube and VASP volumetric grid files: parse header for atoms +
  // hand the cube text to the Structure component for isosurface rendering.
  // Cube is matched by extension; CHGCAR-family (CHGCAR / CHGDIFF / DIFFCHG /
  // CHGCAR_diff / AECCAR / LOCPOT / ELFCAR / PARCHG, with optional suffixes
  // like .diff / _HCO2) is matched by name substring and converted to cube
  // text via the chgdiff-wasm pipeline.
  const is_cube = /\.(cube|cub)$/i.test(filename)
  const stripped_basename = filename.replace(/\.(gz|bz2|xz|zst)$/i, ``)
  const is_chgcar_family = !is_cube &&
    /chgcar|chgdiff|diffchg|aeccar|locpot|elfcar|parchg/i.test(stripped_basename)
  if (is_cube || is_chgcar_family) {
    try {
      const cube_text = is_cube ? content : await chgcar_to_cube(content)
      const header = parse_cube_header(cube_text)
      // VASP charge densities are always periodic — derive the cell from the
      // cube grid so the slab renders with its unit-cell box + PBC bonds.
      // A genuine molecular Gaussian cube stays non-periodic (its grid is a
      // padded bounding box). A .cube re-emitted from VASP data carries a
      // VASP-origin name (CHGCAR_diff.cube / *.vasp.cube) → still periodic.
      const cube_is_periodic = is_chgcar_family ||
        /chgcar|chgdiff|diffchg|aeccar|locpot|elfcar|parchg|\.vasp/i.test(stripped_basename)
      const molecule = cube_atoms_to_molecule(header, { periodic: cube_is_periodic })
      if (!molecule.sites.length) {
        throw new Error(`cube header had no atoms`)
      }
      const cube_filename = is_cube ? filename : `${filename}.cube`
      const cube_blob = new Blob([cube_text], { type: `chemical/x-cube` })
      const data = {
        ...molecule,
        _aligned: true,
        id: filename.replace(/\.[^/.]+$/, ``),
      } as unknown
      return {
        type: `structure`,
        data,
        filename,
        cube_file: new File([cube_blob], cube_filename),
      }
    } catch (err) {
      console.error(`[CatGO Webview] Failed to handle cube/CHGCAR file:`, err)
      throw new Error(
        `Failed to parse ${
          is_chgcar_family ? `CHGCAR-family` : `cube`
        } file: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Parse as structure
  const structure = parse_structure_file(content, filename)
  if (!structure?.sites) {
    throw new Error(`Failed to parse file or no atoms found`)
  }

  const data = { ...structure, id: filename.replace(/\.[^/.]+$/, ``) }
  return { type: `structure`, data, filename }
}

// Create error display in container
const create_error_display = (
  container: HTMLElement,
  error: Error,
  filename: string,
): void => {
  container.innerHTML = `
    <div style="padding: 20px; text-align: center; color: var(--vscode-errorForeground, #f85149);
                background: var(--vscode-editor-background, #1e1e1e); height: 100%;
                display: flex; flex-direction: column; justify-content: center; align-items: center;">
      <div style="font-size: 48px; margin-bottom: 20px;">❌</div>
      <h2 style="margin: 0 0 15px 0;">Failed to Parse File</h2>
      <div style="background: rgba(255,255,255,0.1); padding: 20px; border-radius: 8px; max-width: 600px;">
        <p style="margin: 0 0 10px 0;"><strong>File:</strong> ${filename}</p>
        <p style="margin: 0 0 10px 0;"><strong>Error:</strong> ${error.message}</p>
        <p style="margin: 0; font-size: 14px; opacity: 0.8;">
          Supported formats: XYZ, CIF, JSON, POSCAR, trajectory files (.traj, .h5, .extxyz), etc.
        </p>
      </div>
    </div>`
}

// Mount Svelte component and create display
const create_display = (
  container: HTMLElement,
  result: ParseResult,
  filename: string,
): CatGoApp => {
  Object.assign(container.style, {
    width: `100%`,
    height: `100%`,
    position: `absolute`,
    top: `0`,
    left: `0`,
    right: `0`,
    bottom: `0`,
    background: `var(--vscode-editor-background, #1e1e1e)`,
    color: `var(--vscode-editor-foreground, #d4d4d4)`,
    overflow: `hidden`,
  })
  container.innerHTML = ``

  const is_trajectory = result.type === `trajectory`
  const Component = is_trajectory ? Trajectory : Structure

  // Seed the save-content cache from the freshly parsed source file; every
  // subsequent user edit refreshes it via `on_structure_change` below. A
  // remount from `fileUpdated` re-seeds here, so external reloads never
  // resurrect stale edits.
  if (!is_trajectory) {
    current_structure = result.data as AnyStructure
    source_filename = filename
  }

  // Get defaults and create props
  const catgo_data = get_catgo_data()
  const defaults = merge(catgo_data?.defaults)

  // Prepare trajectory data for VS Code streaming if supported
  let final_trajectory_data = result.data

  if (is_trajectory && result.streaming_info?.supports_streaming) {
    const trajectory_data = result.data as TrajectoryData

    if (vscode_api && result.streaming_info.file_path) {
      const loader = new VSCodeFrameLoader(
        result.streaming_info.file_path,
        vscode_api,
      )
      const frame_count = trajectory_data.total_frames ??
        trajectory_data.frames.length
      const metadata_sample_rate = Math.max(1, Math.ceil(frame_count / 2000))
      // Create trajectory with frame loader for streaming
      final_trajectory_data = {
        ...trajectory_data,
        is_indexed: true, // Mark as indexed so component uses frame loading logic
        // Keep existing frames for initial display
        frames: trajectory_data.frames || [],
        // Attach frame loader directly to trajectory
        frame_loader: loader,
        // Whole-file comment parsing starts only when a plot is visible.
        plot_metadata_loader: () => loader.extract_plot_metadata(
          ``,
          { sample_rate: metadata_sample_rate },
        ),
      }
    }
  }

  // `on_file_load` bubbles up from DopingPane / PathwayPane / SubstitutionPane
  // when the user clicks "Open as Trajectory". The webview has no SvelteKit
  // router, so we tear the current Structure mount down and re-render as
  // Trajectory in-place. (Trajectory's bond-cache + per-frame element
  // pipeline now stay stable thanks to the wire untrack + slow-path fixes,
  // so this remount no longer trips effect_update_depth_exceeded.)
  const on_file_load = (payload: { trajectory?: unknown; filename?: string }) => {
    if (!payload?.trajectory) return
    const next_filename = payload.filename ?? filename
    // Strip Svelte 5 `$state` proxies (DopingPane builds result_structures
    // via `$state` so its frames carry proxy wrappers that aren't
    // structuredClone-safe and add extra reactive slots on the new mount).
    let detached: unknown = payload.trajectory
    try {
      detached = JSON.parse(JSON.stringify(payload.trajectory))
    } catch (err) {
      console.warn(`[CatGO Webview] proxy-strip failed, using raw trajectory:`, err)
    }
    const next_result: ParseResult = {
      type: `trajectory`,
      data: detached,
      filename: next_filename,
    }
    // Defer to next macrotask so the originating click handler can finish
    // before we unmount the Structure component out from under it.
    setTimeout(() => {
      cleanup_catgo().then(() => {
        current_app = create_display(container, next_result, next_filename)
      }).catch((err) => {
        console.error(`[CatGO Webview] Failed to swap to Trajectory view:`, err)
      })
    }, 0)
  }

  // Create component props by mapping defaults to component props
  const props = {
    ...(is_trajectory
      ? {
        trajectory: final_trajectory_data,
        ...trajectory_props(defaults),
        fullscreen_toggle: false,
        hidden_toolbar_items: ['terminal', 'chat', 'plugin_hub', 'gesture', 'workflow'],
      }
      : {
        structure: result.data,
        ...structure_props(defaults),
        fullscreen_toggle: false,
        hidden_toolbar_items: ['terminal', 'chat', 'plugin_hub', 'gesture', 'workflow'],
        ...(result.cube_file ? { cube_file: result.cube_file } : {}),
        on_file_load,
        // Fired by Structure.svelte after every user edit (never on mount or
        // programmatic load): mark the VS Code document dirty and keep the
        // save-content cache pointing at the live edited structure.
        on_structure_change: (structure: AnyStructure) => {
          current_structure = structure
          vscode_api?.postMessage({ command: `dirty` })
        },
      }),
    allow_file_drop: false,
    style: `height: 100%; border-radius: 0`,
    enable_tips: false,
  }

  const app = mount(Component, { target: container, props })

  // VSCode message logging
  const trajectory_data = final_trajectory_data as TrajectoryData & {
    total_frames?: number
  }
  const structure_data = result.data as StructureData
  const message = is_trajectory
    ? `Trajectory rendered: ${filename} (${
      trajectory_data.frames?.length ?? 0
    } initial frames, ${trajectory_data.total_frames ?? `unknown`} total)`
    : `Structure rendered: ${filename} (${structure_data.sites?.length ?? 0} sites)`

  vscode_api?.postMessage({ command: `log`, text: message })

  return app
}

// Map defaults in settings.ts to structure component props
// TIGHT COUPLING WARNING: settings-to-props mapping functions create a direct dependency between the centralized settings schema
// (src/lib/settings.ts) and component prop interfaces. Changes to either side
// require manual updates here.
const structure_props = (defaults: DefaultSettings) => {
  const { structure } = defaults
  return {
    scene_props: { ...structure, gizmo: structure.show_gizmo },
    lattice_props: {
      show_cell_vectors: structure.show_cell_vectors,
      cell_edge_opacity: structure.cell_edge_opacity,
      cell_surface_opacity: structure.cell_surface_opacity,
      cell_edge_color: structure.cell_edge_color,
      cell_surface_color: structure.cell_surface_color,
    },
    color_scheme: defaults.color_scheme,
    background_color: defaults.background_color,
    background_opacity: defaults.background_opacity,
    show_image_atoms: structure.show_image_atoms,
  }
}

// Map defaults to trajectory component props
const trajectory_props = (defaults: DefaultSettings) => {
  const { trajectory, scatter, histogram } = defaults
  return {
    ...trajectory,
    structure_props: structure_props(defaults),
    loading_options: {
      bin_file_threshold: trajectory.bin_file_threshold,
      text_file_threshold: trajectory.text_file_threshold,
      use_indexing: trajectory.use_indexing,
      chunk_size: trajectory.chunk_size,
      max_frames_in_memory: trajectory.max_frames_in_memory,
      enable_performance_monitoring: trajectory.enable_performance_monitoring,
      prefetch_frames: trajectory.prefetch_frames,
      cache_parsed_data: trajectory.cache_parsed_data,
    },
    scatter_props: {
      display: scatter.display,
      styles: {
        show_points: scatter.show_points,
        show_lines: scatter.show_lines,
        point: scatter.point,
        line: scatter.line,
      },
      legend: { show: scatter.show_legend },
    },
    histogram_props: {
      mode: histogram.mode,
      show_legend: histogram.show_legend,
      bins: histogram.bin_count,
      display: histogram.display,
      bar: histogram.bar,
      legend: { show: histogram.show_legend },
    },
    spinner_props: { show_progress: trajectory.show_parsing_progress },
    property_labels: {},
  }
}

// Initialize the CatGo application
async function initialize() {
  // Get CatGo data passed from extension
  const catgo_data = get_catgo_data()
  const { content, filename, is_base64 } = catgo_data?.data || {}
  const theme = catgo_data?.theme
  const wasm_binary = catgo_data?.wasm_binary
  if (!content || !filename) {
    throw new Error(`No data provided to CatGo app`)
  }

  // Set backend server URL if port was provided by extension at init time (hot path)
  if ((catgo_data as any)?.server_port) {
    _apply_port((catgo_data as any).server_port)
  }

  // Set up VSCode-specific download override
  setup_vscode_download()

  // Apply theme early
  if (theme) apply_theme_to_dom(theme)

  // Apply UI language before components mount, so t() resolves in the chosen
  // locale instead of the webview's navigator.language (always 'en' here).
  const locale = catgo_data?.locale
  if (locale) {
    try {
      await set_locale(locale)
    } catch (err) {
      console.warn(`[CatGO Webview] Failed to set locale "${locale}":`, err)
    }
  }

  // Initialize ferrox WASM with binary data if provided by extension
  if (wasm_binary) {
    try {
      console.log(`[CatGO Webview] Received ferrox WASM binary (${wasm_binary.length} base64 chars)`)
      const buffer = base64_to_array_buffer(wasm_binary)
      const wasm_uint8 = new Uint8Array(buffer)
      console.log(`[CatGO Webview] Decoded to Uint8Array (${wasm_uint8.length} bytes)`)
      console.log(`[CatGO Webview] Initializing ferrox-wasm...`)
      await ensure_ferrox_wasm_ready(wasm_uint8)
      console.log(`[CatGO Webview] Successfully initialized ferrox-wasm from extension binary!`)
    } catch (error) {
      console.warn(`[CatGO Webview] Failed to initialize ferrox-wasm from extension binary:`, error)
      // Continue without WASM - web version can load it from bundled assets
    }
  } else {
    console.log(`[CatGO Webview] No ferrox WASM binary provided by extension - will use web bundled version`)
  }

  // Stash chgdiff WASM binary for lazy init when a CHGCAR-family file is loaded.
  // Lives on globalThis so $lib/electronic/chgdiff-wasm.ts can pick it up without
  // an extension-specific import.
  if (catgo_data?.chgdiff_wasm_binary) {
    try {
      console.log(`[CatGO Webview] Received chgdiff WASM binary (${catgo_data.chgdiff_wasm_binary.length} base64 chars)`)
      const chgdiff_buffer = base64_to_array_buffer(catgo_data.chgdiff_wasm_binary)
      ;(globalThis as unknown as { __catgo_chgdiff_wasm?: ArrayBuffer }).__catgo_chgdiff_wasm = chgdiff_buffer
      console.log(`[CatGO Webview] Stashed chgdiff WASM binary on globalThis (${chgdiff_buffer.byteLength} bytes)`)
    } catch (error) {
      console.warn(`[CatGO Webview] Failed to decode chgdiff WASM binary:`, error)
    }
  } else {
    console.log(`[CatGO Webview] No chgdiff WASM binary provided by extension - will fetch from bundled assets`)
  }

  // Stash catrender WASM binary for lazy init when the molecular SVG renderer
  // is first used. catrender-wasm.ts reads globalThis.__catgo_catrender_wasm.
  if (catgo_data?.catrender_wasm_binary) {
    try {
      console.log(`[CatGO Webview] Received catrender WASM binary (${catgo_data.catrender_wasm_binary.length} base64 chars)`)
      const catrender_buffer = base64_to_array_buffer(catgo_data.catrender_wasm_binary)
      ;(globalThis as unknown as { __catgo_catrender_wasm?: ArrayBuffer }).__catgo_catrender_wasm = catrender_buffer
      console.log(`[CatGO Webview] Stashed catrender WASM binary on globalThis (${catrender_buffer.byteLength} bytes)`)
    } catch (error) {
      console.warn(`[CatGO Webview] Failed to decode catrender WASM binary:`, error)
    }
  } else {
    console.log(`[CatGO Webview] No catrender WASM binary provided by extension - will fetch from bundled assets`)
  }

  // Initialize moyo WASM with binary data if provided by extension
  if (catgo_data?.moyo_wasm_binary) {
    try {
      console.log(`[CatGO Webview] Received moyo WASM binary (${catgo_data.moyo_wasm_binary.length} base64 chars)`)
      const moyo_buffer = base64_to_array_buffer(catgo_data.moyo_wasm_binary)
      const moyo_blob = new Blob([moyo_buffer], { type: `application/wasm` })
      const moyo_url = URL.createObjectURL(moyo_blob)
      console.log(`[CatGO Webview] Created blob URL for moyo WASM`)
      console.log(`[CatGO Webview] Initializing moyo-wasm...`)
      await ensure_moyo_wasm_ready(moyo_url)
      console.log(`[CatGO Webview] Successfully initialized moyo-wasm from extension binary!`)
    } catch (error) {
      console.warn(`[CatGO Webview] Failed to initialize moyo-wasm from extension binary:`, error)
      // Continue without WASM - web version can load it from bundled assets
    }
  } else {
    console.log(`[CatGO Webview] No moyo WASM binary provided by extension - will use web bundled version`)
  }

  const container = document.getElementById(`catgo-app`)
  if (!container) throw new Error(`Target container not found in DOM`)

  const result = await parse_file_content(content, filename, undefined, is_base64)
  const app = create_display(container, result, result.filename)

  // Store the app instance for file watching
  current_app = app

  // Set up file change monitoring
  if (vscode_api) {
    // Listen for file change + content request messages from extension
    globalThis.addEventListener(`message`, (event) => {
      if ([`fileUpdated`, `fileDeleted`].includes(event.data.command)) {
        handle_file_change(event.data)
      } else if (event.data.command === `requestContent`) {
        handle_content_request(event.data.request_id)
      }
    })
  }

  return app
}

// Cleanup function to properly dispose of components
async function cleanup_catgo(): Promise<void> {
  if (current_app) {
    await unmount(current_app)
    current_app = null
  }
} // Export initialization and cleanup functions to global scope
// Export initialization and cleanup functions to global scope

;(globalThis as unknown as {
  initializeCatGo?: () => Promise<CatGoApp | null>
  cleanupCatGo?: () => Promise<void>
}).initializeCatGo = async (): Promise<CatGoApp | null> => {
  if (!get_catgo_data()) {
    console.warn(`No catgoData found on window`)
    return null
  }

  try {
    const app = await initialize()
    current_app = app
    return app
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    const container = document.getElementById(`catgo-app`)
    if (container) {
      create_error_display(
        container,
        err,
        get_catgo_data()?.data?.filename || `Unknown file`,
      )
    }
    vscode_api?.postMessage({
      command: `error`,
      text: `Error rendering ${
        get_catgo_data()?.data?.filename || `Unknown file`
      }: ${err.message}`,
    })
    return null
  }
}
;(globalThis as unknown as { cleanupCatGo?: () => Promise<void> })
  .cleanupCatGo = cleanup_catgo

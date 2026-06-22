/**
 * 文件拖放/导入处理模块
 *
 * 处理所有外部文件的加载入口:
 * - handle_file_drop: 拖放文件到结构查看器
 * - handle_import_file: 点击 "Open File" 导入
 * - try_handle_cube_file: 检测并处理 .cube 文件
 * - handle_h5_upload: HDF5 文件上传到 DOS 分析后端
 *
 * UX 改进: 将原本重复 4 次的「解析文件 → 设置结构 → 居中相机 → 触发事件」
 * 逻辑统一到 process_parsed_content() 内部方法，消除代码重复并确保行为一致。
 *
 * 依赖:
 * - structure, cube_file, loading, error_msg 等状态通过 deps getter/setter 访问
 * - 纯函数模块，不使用 Svelte runes
 */

import type { AnyStructure } from '$lib'
import { API_BASE } from '$lib/api/config'
import { decompress_file, handle_url_drop, open_file, check_tauri } from '$lib/io'
import { parse_any_structure } from '$lib/structure/parse'
import { parse_cube_header, cube_atoms_to_molecule } from '$lib/cube/parse-cube'
import { upload_h5 } from '$lib/api/dos'
import { is_acf_dat } from '$lib/structure/parse-charges'

/** CHGCAR/AECCAR/LOCPOT 等 VASP 体积数据文件名检测 */
const CHGCAR_PATTERNS = /^(CHGCAR|AECCAR0|AECCAR1|AECCAR2|LOCPOT|ELFCAR|PARCHG)$/i
function is_chgcar_file(filename: string): boolean {
  // Files with .cube/.cub extension are NOT CHGCAR, even if name contains "CHGCAR"
  if (/\.(cube|cub)$/i.test(filename)) return false
  // Strip compression extensions
  const basename = filename.replace(/\.(gz|bz2|xz|zst)$/i, ``)
  // Match exact filenames like CHGCAR, LOCPOT, etc.
  if (CHGCAR_PATTERNS.test(basename)) return true
  // Also match files containing these names, e.g., CHGCAR_sum, AECCAR0.vasp
  if (/CHGCAR|AECCAR|LOCPOT|ELFCAR|PARCHG/i.test(basename)) return true
  return false
}

// ─── 类型 ───

/** 文件加载事件信息 */
export interface FileLoadEventInfo {
  structure: AnyStructure
  filename: string
  file_size: number
  total_atoms: number
}

/** 工厂函数的依赖接口 */
export interface FileHandlerDeps {
  // ── 状态读写 ──
  get_structure: () => AnyStructure | undefined
  set_structure: (s: AnyStructure) => void
  get_loading: () => boolean
  set_loading: (v: boolean) => void
  get_error_msg: () => string | undefined
  set_error_msg: (v: string | undefined) => void
  /** 增加此计数器触发相机居中 */
  inc_center_camera: () => void
  set_cube_file: (f: File | null) => void
  set_cube_pane_open: (v: boolean) => void
  /** DOS session 状态（h5 上传后设置） */
  set_dos_session: (s: any) => void
  set_analysis_open: (v: boolean) => void
  set_analysis_tab: (tab: string) => void
  /** MD 轨迹分析用的 base64 编码 */
  set_imported_traj: (b64: string, format: string) => void
  /** 拖放标记 */
  set_dragover: (v: boolean) => void

  // ── 回调 props ──
  get_allow_file_drop: () => boolean
  get_on_file_drop: () => ((content: string | ArrayBuffer, filename: string) => void) | undefined
  get_on_file_load: () => ((info: FileLoadEventInfo) => void) | undefined
  get_on_error: () => ((e: { error_msg: string; filename: string }) => void) | undefined
  /** Bader 电荷文件处理 */
  apply_charges: (content: string, filename: string) => void
}

// ─── 工具函数 ───

/** 将文件内容编码为 base64（用于后端 MD 轨迹分析） */
export function content_to_base64(content: string | ArrayBuffer): string {
  const bytes = typeof content === `string`
    ? new TextEncoder().encode(content)
    : new Uint8Array(content)
  let binary = ``
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** 判断文件是否为 HDF5 格式 */
function is_h5_file(filename: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith(`.h5`) || lower.endsWith(`.hdf5`)
}

// ─── 工厂函数 ───

/**
 * 创建文件处理器 — 统一管理文件拖放/导入逻辑
 *
 * 使用方式:
 * ```ts
 * const file_handlers = create_file_handlers({ ... })
 * // 模板: ondrop={file_handlers.handle_file_drop}
 * // 按钮: onclick={() => file_handlers.handle_import_file()}
 * ```
 */
export function create_file_handlers(deps: FileHandlerDeps) {

  // ── 内部: 统一的「解析成功后处理」逻辑 ──
  // 之前这段代码在 handle_file_drop 和 handle_import_file 中重复了 4 次

  function emit_file_load(structure: AnyStructure, filename: string, content: string | ArrayBuffer) {
    deps.get_on_file_load()?.({
      structure,
      filename,
      file_size: typeof content === `string`
        ? new Blob([content]).size
        : content.byteLength,
      total_atoms: structure.sites?.length || 0,
    })
  }

  /**
   * 统一处理已读取的文件内容:
   * 1. 尝试作为 cube 文件处理
   * 2. 解析为结构数据
   * 3. 设置结构 + 居中相机 + 捕获轨迹数据 + 触发事件
   *
   * @returns true 表示已成功处理
   */
  function process_parsed_content(
    content: string | ArrayBuffer,
    filename: string,
  ): boolean {
    // CHGCAR 类文件走后端转换路径（异步）
    if (is_chgcar_file(filename)) {
      try_handle_chgcar_file(content, filename)
      return true
    }

    const text = content instanceof ArrayBuffer
      ? new TextDecoder().decode(content)
      : content

    // Cube 文件走专门路径
    if (try_handle_cube_file(text, filename)) return true

    // 解析结构
    const parsed = parse_any_structure(text, filename)
    if (parsed) {
      deps.set_structure(parsed)
      deps.inc_center_camera()
      // 捕获用于 MD 分析的原始数据
      deps.set_imported_traj(
        content_to_base64(content),
        filename.split(`.`).pop()?.toLowerCase() || ``,
      )
      emit_file_load(parsed, filename, content)
      return true
    }

    // Fallback: try plugin readers for unknown formats
    return try_plugin_reader_upload(content, filename)
  }

  /**
   * 检测并处理 CHGCAR/AECCAR/LOCPOT 等 VASP 体积数据文件。
   * 通过后端转换为 cube 格式后在 CubeViewer 中打开。
   * 返回 true 表示是 CHGCAR 类文件（即使转换失败）。
   */
  async function try_handle_chgcar_file(
    content: string | ArrayBuffer,
    filename: string,
  ): Promise<boolean> {
    if (!is_chgcar_file(filename)) return false

    deps.set_loading(true)
    deps.set_error_msg(undefined)
    try {
      const blob = typeof content === `string`
        ? new Blob([content], { type: `application/octet-stream` })
        : new Blob([content], { type: `application/octet-stream` })
      const form_data = new FormData()
      form_data.append(`file`, new File([blob], filename))

      const resp = await fetch(`${API_BASE}/chgcar/convert-to-cube`, {
        method: `POST`,
        body: form_data,
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }))
        throw new Error(err.detail || `CHGCAR conversion failed: ${resp.statusText}`)
      }

      const cube_text = await resp.text()
      const cube_filename = filename.replace(/\.(gz|bz2|xz|zst)$/i, ``) + `.cube`

      // Parse cube header to extract structure for the 3D viewer.
      // CHGCAR-family files are always periodic — derive the cell from the
      // cube grid so the slab renders with its unit-cell box + PBC bonds.
      const header = parse_cube_header(cube_text)
      const molecule = cube_atoms_to_molecule(header, { periodic: true })
      if (molecule.sites.length > 0) {
        deps.set_structure({ ...molecule, _aligned: true } as AnyStructure)
        deps.inc_center_camera()
      }

      // Set cube file for CubeViewer
      const cube_blob = new Blob([cube_text], { type: `chemical/x-cube` })
      deps.set_cube_file(new File([cube_blob], cube_filename))
      deps.set_cube_pane_open(true)

      return true
    } catch (err) {
      console.error(`Failed to convert CHGCAR to cube:`, err)
      deps.set_error_msg(`Failed to convert CHGCAR to cube: ${err}`)
      deps.get_on_error()?.({ error_msg: `Failed to convert CHGCAR: ${err}`, filename })
      return true // 仍然是 CHGCAR 文件，只是转换失败
    } finally {
      deps.set_loading(false)
    }
  }

  /** 检测并处理 .cube/.cub 文件。返回 true 表示是 cube 文件（即使解析失败） */
  function try_handle_cube_file(text: string, filename: string): boolean {
    if (!/\.(cube|cub)$/i.test(filename)) return false
    try {
      const header = parse_cube_header(text)
      // Molecular Gaussian cubes are non-periodic, but VASP-origin cubes
      // (e.g. CHGCAR_diff.cube / *.vasp.cube) carry a real cell — keep it so
      // the slab renders with its unit-cell box + PBC bonds.
      const cube_is_vasp = /CHGCAR|CHGDIFF|DIFFCHG|AECCAR|LOCPOT|ELFCAR|PARCHG|\.vasp/i.test(filename)
      const molecule = cube_atoms_to_molecule(header, { periodic: cube_is_vasp })
      if (molecule.sites.length > 0) {
        deps.set_structure({ ...molecule, _aligned: true } as AnyStructure)
        deps.inc_center_camera()
      }
      const blob = new Blob([text], { type: `chemical/x-cube` })
      deps.set_cube_file(new File([blob], filename))
      deps.set_cube_pane_open(true)
      return true
    } catch (err) {
      console.error(`Failed to parse cube file:`, err)
      deps.set_error_msg(`Failed to parse cube file: ${err}`)
      deps.get_on_error()?.({ error_msg: `Failed to parse cube file: ${err}`, filename })
      return true // 仍然是 cube 文件，只是解析失败
    }
  }

  /** 上传 HDF5 文件到 DOS 分析后端 */
  async function handle_h5_upload(file: File) {
    deps.set_loading(true)
    deps.set_error_msg(undefined)
    try {
      const session_info = await upload_h5(file)
      deps.set_dos_session(session_info)
      // 将 h5 中的结构加载到 3D 查看器
      if (session_info.structure) {
        deps.inc_center_camera()
        deps.set_structure(session_info.structure as any)
      }
      // 打开 Analysis 面板的 Electronic 标签
      deps.set_analysis_open(true)
      deps.set_analysis_tab(`electronic`)
    } catch (e: any) {
      deps.set_error_msg(e.message || `Failed to upload HDF5 file`)
    } finally {
      deps.set_loading(false)
    }
  }

  /** 处理拖放事件（支持 URL 拖放和文件系统拖放） */
  async function handle_file_drop(event: DragEvent) {
    deps.set_dragover(false)
    if (!deps.get_allow_file_drop()) return // 让事件冒泡到父级处理
    event.preventDefault()
    event.stopPropagation()
    deps.set_loading(true)
    deps.set_error_msg(undefined)

    try {
      // 处理 URL 拖放（如从 FilePicker 拖入）
      const on_file_drop = deps.get_on_file_drop()
      const handled = await handle_url_drop(
        event,
        on_file_drop || ((content, filename) => {
          try {
            if (!process_parsed_content(content, filename)) {
              throw new Error(`Failed to parse structure from ${filename}`)
            }
          } catch (err) {
            deps.set_error_msg(`Failed to parse structure: ${err}`)
            deps.get_on_error()?.({ error_msg: `Failed to parse structure: ${err}`, filename })
          }
        }),
      ).catch(() => false)

      if (handled) return

      // 处理文件系统拖放
      const file = event.dataTransfer?.files[0]
      if (!file) return

      // HDF5 文件走 DOS 分析路径
      if (is_h5_file(file.name)) {
        await handle_h5_upload(file)
        return
      }

      try {
        const { content: raw_content, filename } = await decompress_file(file)
        const content = raw_content as string | ArrayBuffer
        if (!content) return

        const text = content instanceof ArrayBuffer
          ? new TextDecoder().decode(content)
          : content

        // CHGCAR 类文件走后端转换路径
        if (is_chgcar_file(filename)) {
          await try_handle_chgcar_file(content, filename)
        // Bader 电荷文件（ACF.dat）— 叠加到当前结构
        } else if (deps.get_structure() && is_acf_dat(text, filename)) {
          deps.apply_charges(text, filename)
        } else if (on_file_drop) {
          // 如果有外部 handler，优先交给它
          // 但先尝试 cube 文件
          if (!try_handle_cube_file(text, filename)) {
            on_file_drop(content, filename)
          }
        } else {
          // 内部解析
          if (!process_parsed_content(content, filename)) {
            throw new Error(`Failed to parse structure from ${filename}`)
          }
        }
      } catch (error) {
        deps.set_error_msg(`Failed to load file ${file.name}: ${error}`)
        deps.get_on_error()?.({ error_msg: `Failed to load file ${file.name}: ${error}`, filename: file.name })
      }
    } finally {
      deps.set_loading(false)
    }
  }

  /** 从 Open File 对话框导入文件（支持 Tauri 和浏览器两种路径） */
  async function handle_import_file() {
    if (check_tauri()) {
      // Tauri 桌面端: 使用原生文件对话框
      try {
        deps.set_loading(true)
        deps.set_error_msg(undefined)
        const result = await open_file()
        if (result) {
          const { content, filename } = result
          try {
            if (!process_parsed_content(content, filename)) {
              throw new Error(`Failed to parse structure from ${filename}`)
            }
          } catch (err) {
            deps.set_error_msg(`Failed to parse structure: ${err}`)
            deps.get_on_error()?.({ error_msg: `Failed to parse structure: ${err}`, filename })
          }
        }
      } finally {
        deps.set_loading(false)
      }
    } else {
      // 浏览器端: 创建隐藏的 file input
      const input = document.createElement(`input`)
      input.type = `file`
      input.accept = `.cif,.poscar,.vasp,.xyz,.json,.yaml,.yml,.h5,.hdf5,.cube,.cub,.data,.lammps,.xml,*`
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return

        // HDF5 文件走 DOS 分析路径
        if (is_h5_file(file.name)) {
          await handle_h5_upload(file)
          return
        }

        deps.set_loading(true)
        deps.set_error_msg(undefined)
        try {
          const { content: raw_content, filename } = await decompress_file(file)
          const content = raw_content as string | ArrayBuffer
          if (content) {
            if (!process_parsed_content(content, filename)) {
              throw new Error(`Failed to parse structure from ${filename}`)
            }
          }
        } catch (err) {
          deps.set_error_msg(`Failed to parse structure: ${err}`)
          deps.get_on_error()?.({
            error_msg: `Failed to parse structure: ${err}`,
            filename: file.name,
          })
        } finally {
          deps.set_loading(false)
        }
      }
      input.click()
    }
  }

  /**
   * Try uploading an unknown file format to plugin readers.
   * Returns true if a plugin reader handled the file.
   */
  function try_plugin_reader_upload(
    content: string | ArrayBuffer,
    filename: string,
  ): boolean {
    const blob = typeof content === `string`
      ? new Blob([content], { type: `application/octet-stream` })
      : new Blob([content], { type: `application/octet-stream` })
    const form_data = new FormData()
    form_data.append(`files`, new File([blob], filename))

    // Fire-and-forget async upload — return true optimistically
    // to prevent the "Failed to parse" error message
    fetch(`${API_BASE}/plugins/readers/upload`, {
      method: `POST`,
      body: form_data,
    })
      .then(async (resp) => {
        if (!resp.ok) return
        const data = await resp.json()
        if (data.output_type === `structure` && data.data?.structure) {
          deps.set_structure(data.data.structure as AnyStructure)
          deps.inc_center_camera()
        } else if (data.output_type === `electronic_dos` && data.data) {
          deps.set_dos_session(data.data)
          deps.set_analysis_open(true)
          deps.set_analysis_tab(`electronic`)
        } else {
          // Other output types — open analysis pane with raw data
          deps.set_analysis_open(true)
        }
      })
      .catch((e) => {
        console.warn(`[file-handlers] Plugin reader upload failed:`, e)
      })

    return true
  }

  return {
    handle_file_drop,
    handle_import_file,
    try_handle_cube_file,
    handle_h5_upload,
    /** 暴露给组件内其他需要复用的地方（如 structure_string prop 解析） */
    process_parsed_content,
    /** 暴露 emit 方法（一些回调需要直接触发） */
    emit_file_load,
  }
}

/** create_file_handlers 的返回类型 */
export type FileHandlers = ReturnType<typeof create_file_handlers>

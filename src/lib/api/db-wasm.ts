/**
 * Browser-side SQLite via sql.js (WASM) for desktop:dev mode.
 * Exports the same 16 functions as db-local.ts but runs entirely in the browser,
 * using Vite dev middleware (vite-plugin-db-fs) for file I/O.
 *
 * Routing: project.ts / workflow.ts detect __CATGO_DESKTOP__ → import this module.
 */

import initSqlJs, { type Database } from 'sql.js'
import type { DbInfo, ProjectSummary, ProjectDetail, BrowseResult, EnrichedResult, ExportStructureResult, SerializeStructureResult } from './project'
import { API_BASE } from './config'

// ---------------------------------------------------------------------------
// Singleton database
// ---------------------------------------------------------------------------

let db: Database | null = null
let db_path = `server/data/catgo_results.db`
let flush_timer: ReturnType<typeof setTimeout> | null = null
// On-disk mtime of the snapshot we loaded / last successfully wrote.
// /__db/write rejects (409) when the disk file moved on from this — i.e. the
// Python backend wrote the same file — so a stale whole-file image can never
// roll back backend rows (the "node disappears after run" bug).
let disk_mtime: number | null = null

async function get_db(): Promise<Database> {
  if (db) return db
  const SQL = await initSqlJs({
    locateFile: () => `/sql-wasm.wasm`,
  })
  try {
    const resp = await fetch(`/__db/read?path=${encodeURIComponent(db_path)}`)
    if (resp.ok) {
      const buf = await resp.arrayBuffer()
      const mt = resp.headers.get(`X-DB-Mtime`)
      disk_mtime = mt != null ? Number(mt) : null
      db = new SQL.Database(new Uint8Array(buf))
    } else {
      db = new SQL.Database()
    }
  } catch {
    db = new SQL.Database()
  }
  db.run(`PRAGMA foreign_keys=ON`)
  ensure_tables(db)
  return db
}

function ensure_tables(d: Database): void {
  d.run(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      ase_db_path TEXT,
      parent_id TEXT REFERENCES projects(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      template_id TEXT,
      status TEXT DEFAULT 'draft',
      graph_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      project_id TEXT REFERENCES projects(id),
      run_config_json TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      node_type TEXT NOT NULL,
      label TEXT DEFAULT '',
      config_json TEXT DEFAULT '{}',
      status TEXT DEFAULT 'pending',
      hpc_job_id TEXT,
      hpc_session_id TEXT,
      ase_db_id INTEGER,
      input_ase_db_id INTEGER,
      result_json TEXT DEFAULT '{}',
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      work_dir TEXT,
      input_source TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_edges (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      source_step_id TEXT NOT NULL,
      target_step_id TEXT NOT NULL,
      edge_type TEXT DEFAULT 'sequential',
      condition_json TEXT DEFAULT '{}',
      source_handle TEXT,
      target_handle TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      graph_json TEXT NOT NULL,
      metadata TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS workflow_folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      parent_id TEXT REFERENCES workflow_folders(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_steps_workflow ON workflow_steps(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_steps_status ON workflow_steps(status);
    CREATE INDEX IF NOT EXISTS idx_edges_workflow ON workflow_edges(workflow_id);

    CREATE TABLE IF NOT EXISTS systems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unique_id TEXT UNIQUE,
      ctime REAL,
      mtime REAL,
      username TEXT,
      numbers BLOB,
      positions BLOB,
      cell BLOB,
      pbc INTEGER,
      initial_magmoms BLOB,
      initial_charges BLOB,
      masses BLOB,
      tags BLOB,
      momenta BLOB,
      constraints TEXT,
      calculator TEXT,
      calculator_parameters TEXT,
      energy REAL,
      free_energy REAL,
      forces BLOB,
      stress BLOB,
      dipole BLOB,
      magmoms BLOB,
      magmom REAL,
      charges BLOB,
      key_value_pairs TEXT,
      data BLOB,
      natoms INTEGER,
      fmax REAL,
      smax REAL,
      volume REAL,
      mass REAL,
      charge REAL
    );
    CREATE TABLE IF NOT EXISTS species (
      Z INTEGER,
      n INTEGER,
      id INTEGER,
      FOREIGN KEY (id) REFERENCES systems(id)
    );
    CREATE TABLE IF NOT EXISTS keys (
      key TEXT,
      id INTEGER,
      FOREIGN KEY (id) REFERENCES systems(id)
    );
    CREATE TABLE IF NOT EXISTS text_key_values (
      key TEXT,
      value TEXT,
      id INTEGER,
      FOREIGN KEY (id) REFERENCES systems(id)
    );
    CREATE TABLE IF NOT EXISTS number_key_values (
      key TEXT,
      value REAL,
      id INTEGER,
      FOREIGN KEY (id) REFERENCES systems(id)
    );
    CREATE TABLE IF NOT EXISTS information (
      name TEXT,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS unique_id_index ON systems(unique_id);
    CREATE INDEX IF NOT EXISTS ctime_index ON systems(ctime);
    CREATE INDEX IF NOT EXISTS username_index ON systems(username);
    CREATE INDEX IF NOT EXISTS calculator_index ON systems(calculator);
    CREATE INDEX IF NOT EXISTS species_index ON species(Z);
    CREATE INDEX IF NOT EXISTS key_index ON keys(key);
    CREATE INDEX IF NOT EXISTS text_index ON text_key_values(key);
    CREATE INDEX IF NOT EXISTS number_index ON number_key_values(key);
  `)

  // ASE version marker
  const [{ cnt }] = query<{ cnt: number }>(d, `SELECT COUNT(*) as cnt FROM information`)
  if (cnt === 0) {
    d.run(`INSERT INTO information (name, value) VALUES ('version', '9')`)
  }
}

// ---------------------------------------------------------------------------
// Flush (debounced write-back to disk via Vite middleware)
// ---------------------------------------------------------------------------

function schedule_flush(): void {
  if (flush_timer) clearTimeout(flush_timer)
  flush_timer = setTimeout(flush_now, 1000)
}

export async function flush_now(): Promise<void> {
  if (!db) return
  const data = db.export()
  const base = disk_mtime != null ? `&base_mtime=${disk_mtime}` : ``
  const resp = await fetch(`/__db/write?path=${encodeURIComponent(db_path)}${base}`, {
    method: `POST`,
    body: new Blob([data as unknown as BlobPart]),
  })
  if (resp.status === 409) {
    // Backend wrote the file since our snapshot — dropping this whole-file
    // write is the safe choice (it would roll back the backend's rows).
    console.warn(`[db-wasm] Flush rejected: on-disk DB changed (backend wrote it). Snapshot is stale; skipping write.`)
    return
  }
  if (resp.ok) {
    const body = await resp.json().catch(() => null)
    if (body?.mtime != null) disk_mtime = body.mtime
  }
}

if (typeof window !== `undefined`) {
  window.addEventListener(`beforeunload`, () => {
    if (flush_timer) { clearTimeout(flush_timer); flush_timer = null }
    if (db) {
      const data = db.export()
      // Use sendBeacon for reliable delivery during unload. The middleware's
      // base_mtime guard (vite.desktop.config.ts) rejects the write when the
      // backend has since modified the file — fire-and-forget is then safe.
      const blob = new Blob([data as unknown as BlobPart], { type: `application/octet-stream` })
      const base = disk_mtime != null ? `&base_mtime=${disk_mtime}` : ``
      navigator.sendBeacon(`/__db/write?path=${encodeURIComponent(db_path)}${base}`, blob)
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function query<T>(d: Database, sql: string, params?: unknown[]): T[] {
  const stmt = d.prepare(sql)
  if (params) stmt.bind(params)
  const results: T[] = []
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T)
  }
  stmt.free()
  return results
}

/**
 * [2025-02 DEBUG] sql.js bug workaround: Database.run(sql, params) silently
 * drops all parameter bindings in the browser WASM build (sql-wasm-browser.js).
 * All `?` placeholders remain NULL, causing NOT NULL constraint failures.
 *
 * Root cause: Database.run() calls this.prepare(sql, params) which internally
 * calls stmt.bind(params), but the bindings don't actually reach the compiled
 * SQLite statement in the browser WASM environment. The same sql.js code works
 * fine in Node.js — the issue is browser-WASM specific.
 *
 * Fix: use prepare() without params, then bind() separately (same pattern as
 * query()). This was confirmed by diagnostic: d.run(INSERT, [params]) fails,
 * but escaped SQL literals succeed, and prepare→bind→step works correctly.
 */
function run_stmt(d: Database, sql: string, params?: unknown[]): void {
  const stmt = d.prepare(sql)
  try {
    if (params) stmt.bind(params)
    stmt.step()
  } finally {
    stmt.free()
  }
}

function now_iso(): string {
  return new Date().toISOString()
}

function now_epoch(): number {
  return Date.now() / 1000
}

// ---------------------------------------------------------------------------
// Elements periodic table
// ---------------------------------------------------------------------------

const ELEMENTS = [
  ``, `H`, `He`, `Li`, `Be`, `B`, `C`, `N`, `O`, `F`, `Ne`,
  `Na`, `Mg`, `Al`, `Si`, `P`, `S`, `Cl`, `Ar`, `K`, `Ca`,
  `Sc`, `Ti`, `V`, `Cr`, `Mn`, `Fe`, `Co`, `Ni`, `Cu`, `Zn`,
  `Ga`, `Ge`, `As`, `Se`, `Br`, `Kr`, `Rb`, `Sr`, `Y`, `Zr`,
  `Nb`, `Mo`, `Tc`, `Ru`, `Rh`, `Pd`, `Ag`, `Cd`, `In`, `Sn`,
  `Sb`, `Te`, `I`, `Xe`, `Cs`, `Ba`, `La`, `Ce`, `Pr`, `Nd`,
  `Pm`, `Sm`, `Eu`, `Gd`, `Tb`, `Dy`, `Ho`, `Er`, `Tm`, `Yb`,
  `Lu`, `Hf`, `Ta`, `W`, `Re`, `Os`, `Ir`, `Pt`, `Au`, `Hg`,
  `Tl`, `Pb`, `Bi`, `Po`, `At`, `Rn`, `Fr`, `Ra`, `Ac`, `Th`,
  `Pa`, `U`, `Np`, `Pu`, `Am`, `Cm`, `Bk`, `Cf`, `Es`, `Fm`,
  `Md`, `No`, `Lr`, `Rf`, `Db`, `Sg`, `Bh`, `Hs`, `Mt`, `Ds`,
  `Rg`, `Cn`, `Nh`, `Fl`, `Mc`, `Lv`, `Ts`, `Og`,
]

function element_to_z(symbol: string): number | null {
  const idx = ELEMENTS.indexOf(symbol)
  return idx >= 0 ? idx : null
}

function formula_from_species(d: Database, sys_id: number): string {
  const rows = query<{ Z: number; n: number }>(
    d, `SELECT Z, n FROM species WHERE id = ? ORDER BY Z`, [sys_id],
  )
  if (rows.length === 0) return ``

  const parts = rows.map(({ Z, n }) => ({
    sym: Z < ELEMENTS.length ? ELEMENTS[Z] : `X${Z}`,
    n,
  }))

  // Hill system: C first, H second, rest alphabetical
  parts.sort((a, b) => {
    const order = (s: string) => (s === `C` ? 0 : s === `H` ? 1 : 2)
    const oa = order(a.sym), ob = order(b.sym)
    if (oa !== ob) return oa - ob
    return a.sym.localeCompare(b.sym)
  })

  return parts.map(({ sym, n }) => sym + (n > 1 ? String(n) : ``)).join(``)
}

// ---------------------------------------------------------------------------
// Linear algebra (3×3)
// ---------------------------------------------------------------------------

type Mat3 = [[number, number, number], [number, number, number], [number, number, number]]

function invert_3x3(m: Mat3): Mat3 | null {
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  if (Math.abs(det) < 1e-30) return null
  const d = 1 / det
  return [
    [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) * d, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * d, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * d],
    [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) * d, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * d, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * d],
    [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) * d, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * d, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * d],
  ]
}

function mat_vec_mul(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ]
}

function cell_params(cell: Mat3): { a: number; b: number; c: number; alpha: number; beta: number; gamma: number; volume: number } {
  const [av, bv, cv] = cell
  const a = Math.sqrt(av[0] ** 2 + av[1] ** 2 + av[2] ** 2)
  const b = Math.sqrt(bv[0] ** 2 + bv[1] ** 2 + bv[2] ** 2)
  const c = Math.sqrt(cv[0] ** 2 + cv[1] ** 2 + cv[2] ** 2)
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
  const alpha = Math.acos(dot(bv, cv) / (b * c)) * 180 / Math.PI
  const beta = Math.acos(dot(av, cv) / (a * c)) * 180 / Math.PI
  const gamma = Math.acos(dot(av, bv) / (a * b)) * 180 / Math.PI
  const cross = [
    bv[1] * cv[2] - bv[2] * cv[1],
    bv[2] * cv[0] - bv[0] * cv[2],
    bv[0] * cv[1] - bv[1] * cv[0],
  ]
  const volume = Math.abs(dot(av, cross))
  return { a, b, c, alpha, beta, gamma, volume }
}

// ---------------------------------------------------------------------------
// BLOB helpers
// ---------------------------------------------------------------------------

/** Parse a BLOB of i32 little-endian values (atomic numbers). */
function parse_i32_blob(blob: Uint8Array): Int32Array {
  const buf = new ArrayBuffer(blob.byteLength)
  new Uint8Array(buf).set(blob)
  return new Int32Array(buf)
}

/** Parse a BLOB of f64 little-endian values. */
function parse_f64_blob(blob: Uint8Array): Float64Array {
  const buf = new ArrayBuffer(blob.byteLength)
  new Uint8Array(buf).set(blob)
  return new Float64Array(buf)
}

/** Pack an array of i32 into a little-endian Uint8Array. */
function pack_i32_blob(vals: number[]): Uint8Array {
  const buf = new ArrayBuffer(vals.length * 4)
  const view = new Int32Array(buf)
  for (let i = 0; i < vals.length; i++) view[i] = vals[i]
  return new Uint8Array(buf)
}

/** Pack an array of f64 into a little-endian Uint8Array. */
function pack_f64_blob(vals: number[]): Uint8Array {
  const buf = new ArrayBuffer(vals.length * 8)
  const view = new Float64Array(buf)
  for (let i = 0; i < vals.length; i++) view[i] = vals[i]
  return new Uint8Array(buf)
}

// ---------------------------------------------------------------------------
// Text key-value helpers
// ---------------------------------------------------------------------------

function get_text_kv(d: Database, sys_id: number, key: string): string {
  const rows = query<{ value: string }>(
    d, `SELECT value FROM text_key_values WHERE id = ? AND key = ?`, [sys_id, key],
  )
  return rows.length > 0 ? rows[0].value : ``
}

// ---------------------------------------------------------------------------
// DB management (4 functions)
// ---------------------------------------------------------------------------

export async function db_get_current(): Promise<DbInfo> {
  await get_db()
  const name = db_path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, ``) || ``
  return { path: db_path, name }
}

export async function db_new(path: string): Promise<DbInfo> {
  if (!/\.\w+$/.test(path)) path += `.db`
  // Close current
  if (db) { await flush_now(); db.close(); db = null }
  // Create empty via middleware
  const SQL = await initSqlJs({
    locateFile: () => `/sql-wasm.wasm`,
  })
  db = new SQL.Database()
  db.run(`PRAGMA foreign_keys=ON`)
  ensure_tables(db)
  db_path = path
  await flush_now()
  const name = path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, ``) || ``
  return { path, name }
}

export async function db_open(path: string): Promise<DbInfo> {
  if (db) { await flush_now(); db.close(); db = null }
  db_path = path
  await get_db()
  const name = path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, ``) || ``
  return { path, name }
}

export async function db_save_as(path: string): Promise<DbInfo> {
  if (!/\.\w+$/.test(path)) path += `.db`
  await flush_now() // ensure current is saved
  await fetch(`/__db/copy?src=${encodeURIComponent(db_path)}&dst=${encodeURIComponent(path)}`, { method: `POST` })
  db_path = path
  const name = path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, ``) || ``
  return { path, name }
}

export async function db_browse_directory(dir?: string): Promise<BrowseResult> {
  const resp = await fetch(`/__db/browse?dir=${encodeURIComponent(dir || `~`)}`)
  return resp.json()
}

// [2026-03] General filesystem browse + read + write (all files, not .db-filtered)
import type { FileBrowseResult, FileReadResult, FileWriteResult, FileOpResult } from './project'

export async function db_browse_files(dir?: string): Promise<FileBrowseResult> {
  const resp = await fetch(`/__files/browse?dir=${encodeURIComponent(dir || `~`)}`)
  if (!resp.ok) {
    const text = await resp.text().catch(() => `status ${resp.status}`)
    throw new Error(text || `Browse failed (${resp.status})`)
  }
  return resp.json()
}

export async function db_read_file(path: string): Promise<FileReadResult> {
  const resp = await fetch(`/__files/read?path=${encodeURIComponent(path)}`)
  if (!resp.ok) {
    const text = await resp.text().catch(() => `status ${resp.status}`)
    throw new Error(text || `Read failed (${resp.status})`)
  }
  return resp.json()
}

export async function db_write_file(path: string, content: string): Promise<FileWriteResult> {
  const resp = await fetch(`/__files/write`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ path, content }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => `status ${resp.status}`)
    throw new Error(text || `Write failed (${resp.status})`)
  }
  return resp.json()
}

export async function db_export_structure(
  structure: Record<string, unknown>,
  path: string,
  format?: string,
): Promise<ExportStructureResult> {
  // Requires pymatgen — forward to Python backend
  const resp = await fetch(`${API_BASE}/workflow/files/export-structure`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ structure, path, format }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new Error(err.detail || `Export failed: ${resp.statusText}`)
  }
  return resp.json()
}

export async function db_serialize_structure(
  structure: Record<string, unknown>,
  format: string = `cif`,
): Promise<SerializeStructureResult> {
  // Requires pymatgen — forward to Python backend
  const resp = await fetch(`${API_BASE}/workflow/files/serialize-structure`, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify({ structure, format }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: resp.statusText }))
    throw new Error(err.detail || `Serialization failed: ${resp.statusText}`)
  }
  return resp.json()
}

// [2026-03] File operations via Vite middleware
async function post_json<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const resp = await fetch(url, {
    method: `POST`,
    headers: { 'Content-Type': `application/json` },
    body: JSON.stringify(body),
  })
  return resp.json()
}

export async function db_fs_mkdir(path: string): Promise<FileOpResult> {
  return post_json(`/__files/mkdir`, { path })
}

export async function db_fs_delete(path: string): Promise<FileOpResult> {
  return post_json(`/__files/delete`, { path })
}

export async function db_fs_rename(old_path: string, new_path: string): Promise<FileOpResult> {
  return post_json(`/__files/rename`, { old_path, new_path })
}

export async function db_fs_copy(source: string, destination: string): Promise<FileOpResult> {
  return post_json(`/__files/copy`, { source, destination })
}

export async function db_fs_move(source: string, destination: string): Promise<FileOpResult> {
  return post_json(`/__files/move`, { source, destination })
}

// ---------------------------------------------------------------------------
// Projects (4 functions)
// ---------------------------------------------------------------------------

export async function db_list_projects(): Promise<ProjectSummary[]> {
  const d = await get_db()
  return query<ProjectSummary>(d,
    `SELECT p.*, (SELECT COUNT(*) FROM workflows WHERE project_id = p.id) as workflow_count
     FROM projects p ORDER BY p.updated_at DESC`,
  )
}

export async function db_create_project(
  name: string,
  description?: string,
  parent_id?: string,
): Promise<ProjectSummary> {
  const d = await get_db()
  const id = crypto.randomUUID()
  const ts = now_iso()
  const desc = description ?? ``
  run_stmt(d, `INSERT INTO projects (id, name, description, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, desc, parent_id ?? null, ts, ts])
  schedule_flush()
  return { id, name, description: desc, parent_id: parent_id ?? null, created_at: ts, updated_at: ts }
}

export async function db_update_project(
  id: string,
  data: { name?: string; description?: string; parent_id?: string | null },
): Promise<ProjectSummary> {
  const d = await get_db()
  const ts = now_iso()
  const sets: string[] = []
  const vals: unknown[] = []

  if (data.name !== undefined) { sets.push(`name = ?`); vals.push(data.name) }
  if (data.description !== undefined) { sets.push(`description = ?`); vals.push(data.description) }
  if (data.parent_id === null) { sets.push(`parent_id = NULL`) }
  else if (data.parent_id !== undefined) { sets.push(`parent_id = ?`); vals.push(data.parent_id) }

  if (sets.length > 0) {
    sets.push(`updated_at = ?`); vals.push(ts)
    vals.push(id)
    run_stmt(d, `UPDATE projects SET ${sets.join(`, `)} WHERE id = ?`, vals)
    schedule_flush()
  }

  const rows = query<ProjectSummary>(d,
    `SELECT p.*, (SELECT COUNT(*) FROM workflows WHERE project_id = p.id) as workflow_count
     FROM projects p WHERE p.id = ?`, [id],
  )
  return rows[0]
}

export async function db_get_project(id: string): Promise<ProjectDetail> {
  const d = await get_db()
  const rows = query<ProjectSummary>(d,
    `SELECT p.* FROM projects p WHERE p.id = ?`, [id],
  )
  if (rows.length === 0) throw new Error(`Project ${id} not found`)
  const project = rows[0]
  const workflows = query<{
    id: string; name: string; status: string; step_count: number;
    completed_steps: number; created_at: string
  }>(d,
    `SELECT w.id, w.name, w.status,
            (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count,
            (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND status = 'completed') as completed_steps,
            w.created_at
     FROM workflows w WHERE w.project_id = ? ORDER BY w.updated_at DESC`, [id],
  )
  return { ...project, workflows }
}

export async function db_get_enriched_results(project_id: string): Promise<EnrichedResult[]> {
  const d = await get_db()
  // NOTE: This function is no longer used by project.ts (which always uses HTTP).
  // Kept for backwards compatibility with custom implementations.
  // Find all results whose text_key_values workflow_id matches any workflow in this project
  const workflow_ids = query<{ id: string }>(d,
    `SELECT id FROM workflows WHERE project_id = ?`, [project_id],
  )
  if (workflow_ids.length === 0) return []
  const placeholders = workflow_ids.map(() => `?`).join(`,`)
  const sys_ids = query<{ id: number }>(d,
    `SELECT DISTINCT id FROM text_key_values WHERE key = 'workflow_id' AND value IN (${placeholders})`,
    workflow_ids.map(w => w.id),
  )
  const results: EnrichedResult[] = []
  for (const { id: sys_id } of sys_ids) {
    const sys = query<{ id: number; natoms: number; energy: number | null; volume: number | null; cell: Uint8Array | null }>(
      d, `SELECT id, natoms, energy, volume, cell FROM systems WHERE id = ?`, [sys_id],
    )
    if (sys.length === 0) continue
    const r = sys[0]
    const formula = formula_from_species(d, r.id)
    const wf_id = get_text_kv(d, r.id, `workflow_id`)
    const step_id = get_text_kv(d, r.id, `step_id`)
    const node_type = get_text_kv(d, r.id, `node_type`)
    const label = get_text_kv(d, r.id, `label`)
    const energy_per_atom = r.energy != null && r.natoms > 0 ? r.energy / r.natoms : null

    // Parse cell for lattice params
    let a = null, b = null, c = null, alpha = null, beta = null, gamma = null
    if (r.cell) {
      const cell_flat = parse_f64_blob(r.cell)
      if (cell_flat.length >= 9) {
        const cell_mat: Mat3 = [
          [cell_flat[0], cell_flat[1], cell_flat[2]],
          [cell_flat[3], cell_flat[4], cell_flat[5]],
          [cell_flat[6], cell_flat[7], cell_flat[8]],
        ]
        const cp = cell_params(cell_mat)
        if (cp.volume > 0.01) {
          a = cp.a; b = cp.b; c = cp.c
          alpha = cp.alpha; beta = cp.beta; gamma = cp.gamma
        }
      }
    }

    results.push({
      id: r.id, formula, energy: r.energy, energy_per_atom, natoms: r.natoms,
      volume: r.volume, a, b, c, alpha, beta, gamma,
      workflow_id: wf_id, workflow_name: ``, step_id, step_label: label, node_type,
    })
  }
  return results
}

export async function db_delete_project(id: string): Promise<void> {
  const d = await get_db()
  // Collect descendant IDs
  const ids_to_delete = [id]
  const queue = [id]
  while (queue.length > 0) {
    const pid = queue.pop()!
    const children = query<{ id: string }>(d, `SELECT id FROM projects WHERE parent_id = ?`, [pid])
    for (const c of children) {
      ids_to_delete.push(c.id)
      queue.push(c.id)
    }
  }
  const placeholders = ids_to_delete.map(() => `?`).join(`,`)
  run_stmt(d, `UPDATE workflows SET project_id = NULL WHERE project_id IN (${placeholders})`, ids_to_delete)
  run_stmt(d, `DELETE FROM projects WHERE id IN (${placeholders})`, ids_to_delete)
  schedule_flush()
}

export async function db_assign_workflow_to_project(
  workflow_id: string, project_id: string,
): Promise<void> {
  const d = await get_db()
  const existing = query<{ id: string }>(d, `SELECT id FROM workflows WHERE id = ?`, [workflow_id])
  if (existing.length === 0) return
  run_stmt(d, `UPDATE workflows SET project_id = ?, updated_at = ? WHERE id = ?`,
    [project_id, now_iso(), workflow_id])
  schedule_flush()
}

// ---------------------------------------------------------------------------
// Workflow Folders (CRUD) — mirrors Projects but for workflow organization
// ---------------------------------------------------------------------------

export interface WorkflowFolderSummary {
  id: string
  name: string
  description: string
  parent_id: string | null
  created_at: string
  updated_at: string
}

export interface WorkflowFolderDetail extends WorkflowFolderSummary {
  workflows: Array<{ id: string; name: string; status: string; step_count: number; completed_steps: number }>
}

export async function db_list_workflow_folders(): Promise<WorkflowFolderSummary[]> {
  const d = await get_db()
  return query<WorkflowFolderSummary>(d,
    `SELECT * FROM workflow_folders ORDER BY updated_at DESC`,
  )
}

export async function db_create_workflow_folder(
  name: string,
  description?: string,
  parent_id?: string,
): Promise<WorkflowFolderSummary> {
  const d = await get_db()
  const id = crypto.randomUUID()
  const ts = now_iso()
  const desc = description ?? ``
  run_stmt(d, `INSERT INTO workflow_folders (id, name, description, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, name, desc, parent_id ?? null, ts, ts])
  schedule_flush()
  return { id, name, description: desc, parent_id: parent_id ?? null, created_at: ts, updated_at: ts }
}

export async function db_update_workflow_folder(
  id: string,
  data: { name?: string; description?: string; parent_id?: string | null },
): Promise<WorkflowFolderSummary> {
  const d = await get_db()
  const ts = now_iso()
  const sets: string[] = []
  const vals: unknown[] = []

  if (data.name !== undefined) { sets.push(`name = ?`); vals.push(data.name) }
  if (data.description !== undefined) { sets.push(`description = ?`); vals.push(data.description) }
  if (data.parent_id === null) { sets.push(`parent_id = NULL`) }
  else if (data.parent_id !== undefined) { sets.push(`parent_id = ?`); vals.push(data.parent_id) }

  if (sets.length > 0) {
    sets.push(`updated_at = ?`); vals.push(ts)
    vals.push(id)
    run_stmt(d, `UPDATE workflow_folders SET ${sets.join(`, `)} WHERE id = ?`, vals)
    schedule_flush()
  }

  const rows = query<WorkflowFolderSummary>(d,
    `SELECT * FROM workflow_folders WHERE id = ?`, [id],
  )
  return rows[0]
}

export async function db_get_workflow_folder(id: string): Promise<WorkflowFolderDetail> {
  const d = await get_db()
  const rows = query<WorkflowFolderSummary>(d,
    `SELECT * FROM workflow_folders WHERE id = ?`, [id],
  )
  if (rows.length === 0) throw new Error(`Workflow folder ${id} not found`)
  const folder = rows[0]
  const workflows = query<{
    id: string; name: string; status: string; step_count: number;
    completed_steps: number
  }>(d,
    `SELECT w.id, w.name, w.status,
            (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count,
            (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND status = 'completed') as completed_steps
     FROM workflows w WHERE w.project_id = ? ORDER BY w.updated_at DESC`, [id],
  )
  return { ...folder, workflows }
}

export async function db_delete_workflow_folder(id: string): Promise<void> {
  const d = await get_db()
  // Collect descendant IDs
  const ids_to_delete = [id]
  const queue = [id]
  while (queue.length > 0) {
    const pid = queue.pop()!
    const children = query<{ id: string }>(d, `SELECT id FROM workflow_folders WHERE parent_id = ?`, [pid])
    for (const c of children) {
      ids_to_delete.push(c.id)
      queue.push(c.id)
    }
  }
  const placeholders = ids_to_delete.map(() => `?`).join(`,`)
  run_stmt(d, `UPDATE workflows SET project_id = NULL WHERE project_id IN (${placeholders})`, ids_to_delete)
  run_stmt(d, `DELETE FROM workflow_folders WHERE id IN (${placeholders})`, ids_to_delete)
  schedule_flush()
}

export async function db_assign_workflow_to_folder(
  workflow_id: string, folder_id: string,
): Promise<void> {
  const d = await get_db()
  const existing = query<{ id: string }>(d, `SELECT id FROM workflows WHERE id = ?`, [workflow_id])
  if (existing.length === 0) return
  run_stmt(d, `UPDATE workflows SET project_id = ?, updated_at = ? WHERE id = ?`,
    [folder_id, now_iso(), workflow_id])
  schedule_flush()
}

export async function db_unassign_workflow_from_folder(
  workflow_id: string,
): Promise<void> {
  const d = await get_db()
  run_stmt(d, `UPDATE workflows SET project_id = NULL, updated_at = ? WHERE id = ?`,
    [now_iso(), workflow_id])
  schedule_flush()
}

// ---------------------------------------------------------------------------
// Workflows (CRUD)
// ---------------------------------------------------------------------------

export async function db_list_workflows(): Promise<Array<{
  id: string
  name: string
  description: string
  status: string
  template_id: string | null
  project_id: string | null
  created_at: string
  updated_at: string
  step_count: number
  completed_steps: number
}>> {
  const d = await get_db()
  return query(d,
    `SELECT w.*,
            (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count,
            (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND status = 'completed') as completed_steps
     FROM workflows w ORDER BY w.updated_at DESC`,
  )
}

export async function db_create_workflow(
  name: string,
  graph_json: string,
  description?: string,
  template_id?: string,
): Promise<Record<string, unknown>> {
  const d = await get_db()
  const id = crypto.randomUUID()
  const ts = now_iso()
  const desc = description || ``
  run_stmt(d,
    `INSERT INTO workflows (id, name, description, template_id, status, graph_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
    [id, name, desc, template_id ?? null, graph_json, ts, ts],
  )
  sync_steps_from_graph(d, id, graph_json)
  schedule_flush()
  return db_get_workflow(d, id)
}

export async function db_update_workflow(
  id: string,
  data: { name?: string; description?: string; graph_json?: string; status?: string; metadata?: string },
): Promise<Record<string, unknown>> {
  const d = await get_db()
  const ts = now_iso()

  // Ensure workflow exists in current DB (may have been created by Python backend in another DB)
  const existing = query(d, `SELECT id FROM workflows WHERE id = ?`, [id])
  if (existing.length === 0) {
    run_stmt(d,
      `INSERT INTO workflows (id, name, description, status, graph_json, created_at, updated_at)
       VALUES (?, ?, '', 'draft', '{"nodes":[],"edges":[]}', ?, ?)`,
      [id, data.name || `Untitled Workflow`, ts, ts],
    )
  }

  const sets: string[] = []
  const vals: unknown[] = []

  if (data.name !== undefined) { sets.push(`name = ?`); vals.push(data.name) }
  if (data.description !== undefined) { sets.push(`description = ?`); vals.push(data.description) }
  if (data.status !== undefined) { sets.push(`status = ?`); vals.push(data.status) }
  if (data.metadata !== undefined) { sets.push(`metadata = ?`); vals.push(data.metadata) }
  if (data.graph_json !== undefined) {
    sets.push(`graph_json = ?`); vals.push(data.graph_json)
    sync_steps_from_graph(d, id, data.graph_json)
  }

  if (sets.length > 0) {
    sets.push(`updated_at = ?`); vals.push(ts)
    vals.push(id)
    run_stmt(d, `UPDATE workflows SET ${sets.join(`, `)} WHERE id = ?`, vals)
    schedule_flush()
  }

  return db_get_workflow(d, id)
}

export async function db_delete_workflow(id: string): Promise<void> {
  const d = await get_db()
  run_stmt(d, `DELETE FROM workflow_edges WHERE workflow_id = ?`, [id])
  run_stmt(d, `DELETE FROM workflow_steps WHERE workflow_id = ?`, [id])
  run_stmt(d, `DELETE FROM workflows WHERE id = ?`, [id])
  schedule_flush()
}

export async function db_get_workflow_detail(id: string): Promise<Record<string, unknown>> {
  const d = await get_db()
  return db_get_workflow(d, id)
}

// Workflow execution stubs — WASM mode doesn't support direct engine execution
export async function db_run_workflow(_workflow_id: string, _config_json: string): Promise<string> {
  throw new Error(`Direct workflow execution not available in WASM mode`)
}
export async function db_pause_workflow(_workflow_id: string): Promise<void> {
  throw new Error(`Direct workflow pause not available in WASM mode`)
}
export async function db_resume_workflow(_workflow_id: string, _config_json: string): Promise<string> {
  throw new Error(`Direct workflow resume not available in WASM mode`)
}
export async function db_get_run_status(_workflow_id: string): Promise<{
  workflow_id: string
  status: string
  progress: number
  steps: Array<{ id: string; status: string; hpc_job_id?: string; tool?: string; label?: string }>
}> {
  throw new Error(`Run status not available in WASM mode`)
}

export async function db_list_steps(workflow_id: string): Promise<Array<Record<string, unknown>>> {
  const d = await get_db()
  return query(d, `SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY id`, [workflow_id])
}

/** Internal: read a workflow row as WorkflowDetail-compatible object */
function db_get_workflow(d: Database, id: string): Record<string, unknown> {
  const rows = query<Record<string, unknown>>(d,
    `SELECT w.*,
            (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id) as step_count,
            (SELECT COUNT(*) FROM workflow_steps WHERE workflow_id = w.id AND status = 'completed') as completed_steps
     FROM workflows w WHERE w.id = ?`, [id],
  )
  if (rows.length === 0) throw new Error(`Workflow ${id} not found`)
  return rows[0]
}

/**
 * Sync workflow_steps and workflow_edges tables from Svelte Flow graph JSON.
 * Port of Python _sync_steps_from_graph().
 */
function sync_steps_from_graph(d: Database, wf_id: string, graph_json: string): void {
  let graph: { nodes?: Array<Record<string, unknown>>; edges?: Array<Record<string, unknown>> }
  try { graph = JSON.parse(graph_json) } catch { return }

  const nodes = graph.nodes || []
  const edges = graph.edges || []

  // Read existing steps
  const existing = new Map<string, Record<string, unknown>>()
  for (const row of query<Record<string, unknown>>(d,
    `SELECT id, status, config_json, result_json, hpc_job_id, error_message FROM workflow_steps WHERE workflow_id = ?`,
    [wf_id],
  )) {
    existing.set(row.id as string, row)
  }

  const node_ids = new Set(nodes.map(n => n.id as string))

  // Remove steps no longer in graph
  for (const old_id of existing.keys()) {
    if (!node_ids.has(old_id)) {
      run_stmt(d, `DELETE FROM workflow_steps WHERE id = ? AND workflow_id = ?`, [old_id, wf_id])
    }
  }

  // Upsert steps
  for (const node of nodes) {
    const nid = node.id as string
    const ntype = (node.type as string) || `unknown`
    const data = (node.data as Record<string, unknown>) || {}
    const label = (data.label as string) || ntype
    const raw_config = (data.config as Record<string, unknown>) || (node.params as Record<string, unknown>) || {}
    const config = JSON.stringify(raw_config)

    if (existing.has(nid)) {
      const old = existing.get(nid)!
      if (old.status === `pending` || old.status === `draft`) {
        run_stmt(d,
          `UPDATE workflow_steps SET label = ?, config_json = ?, node_type = ? WHERE id = ? AND workflow_id = ?`,
          [label, config, ntype, nid, wf_id],
        )
      }
    } else {
      run_stmt(d,
        `INSERT INTO workflow_steps (id, workflow_id, node_type, label, config_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, config_json = excluded.config_json, node_type = excluded.node_type`,
        [nid, wf_id, ntype, label, config],
      )
    }
  }

  // Replace edges
  run_stmt(d, `DELETE FROM workflow_edges WHERE workflow_id = ?`, [wf_id])
  for (const edge of edges) {
    if (!edge) continue
    const eid = (edge.id as string) || crypto.randomUUID()
    const source = (edge.source as string) || (edge.from as string) || ``
    const target = (edge.target as string) || (edge.to as string) || ``
    const src_handle = (edge.sourceHandle as string) || (edge.fromH as string) || ``
    const tgt_handle = (edge.targetHandle as string) || (edge.toH as string) || ``
    if (!source || !target) continue
    run_stmt(d,
      `INSERT INTO workflow_edges (id, workflow_id, source_step_id, target_step_id, edge_type, source_handle, target_handle)
       VALUES (?, ?, ?, ?, 'sequential', ?, ?)
       ON CONFLICT(id) DO UPDATE SET source_step_id = excluded.source_step_id, target_step_id = excluded.target_step_id,
         source_handle = excluded.source_handle, target_handle = excluded.target_handle`,
      [eid, wf_id, source, target, src_handle, tgt_handle],
    )
  }
}

// ---------------------------------------------------------------------------
// Results (6 functions)
// ---------------------------------------------------------------------------

export async function db_query_results(workflow_id: string): Promise<{
  results: Array<Record<string, unknown>>
  count: number
}> {
  const d = await get_db()
  const sys_ids = query<{ id: number }>(
    d, `SELECT DISTINCT id FROM text_key_values WHERE key = 'workflow_id' AND value = ?`, [workflow_id],
  )

  const results: Array<Record<string, unknown>> = []
  for (const { id: sys_id } of sys_ids) {
    const rows = query<{ id: number; natoms: number; energy: number | null }>(
      d, `SELECT id, natoms, energy FROM systems WHERE id = ?`, [sys_id],
    )
    if (rows.length === 0) continue
    const { id, natoms, energy } = rows[0]
    results.push({
      id,
      formula: formula_from_species(d, id),
      label: get_text_kv(d, id, `label`),
      energy,
      workflow_id: get_text_kv(d, id, `workflow_id`),
      step_id: get_text_kv(d, id, `step_id`),
      node_type: get_text_kv(d, id, `node_type`),
      natoms,
    })
  }
  return { results, count: results.length }
}

export async function db_update_result_label(
  row_id: number,
  label: string,
): Promise<{ row_id: number; label: string }> {
  const d = await get_db()
  const existing = query(
    d, `SELECT value FROM text_key_values WHERE id = ? AND key = 'label'`, [row_id],
  )
  if (existing.length > 0) {
    run_stmt(d, `UPDATE text_key_values SET value = ? WHERE id = ? AND key = 'label'`, [label, row_id])
  } else {
    run_stmt(d, `INSERT INTO text_key_values (key, value, id) VALUES ('label', ?, ?)`, [label, row_id])
    run_stmt(d, `INSERT OR IGNORE INTO keys (key, id) VALUES ('label', ?)`, [row_id])
  }
  schedule_flush()
  return { row_id, label }
}

export async function db_delete_result(row_id: number): Promise<void> {
  const d = await get_db()
  run_stmt(d, `DELETE FROM text_key_values WHERE id = ?`, [row_id])
  run_stmt(d, `DELETE FROM number_key_values WHERE id = ?`, [row_id])
  run_stmt(d, `DELETE FROM keys WHERE id = ?`, [row_id])
  run_stmt(d, `DELETE FROM species WHERE id = ?`, [row_id])
  run_stmt(d, `DELETE FROM systems WHERE id = ?`, [row_id])
  schedule_flush()
}

export async function db_move_or_copy_result(
  row_id: number,
  project_id: string,
): Promise<{ row_id: number; project_id: string; action: string }> {
  const d = await get_db()
  // Always copy — "Copy to" UI should never move/cut the original
  const new_id = copy_system_row(d, row_id, project_id)
  schedule_flush()
  return { row_id: new_id, project_id, action: `copied` }
}

function copy_system_row(d: Database, src_id: number, target_project_id: string): number {
  const rows = query<Record<string, unknown>>(d,
    `SELECT numbers, positions, cell, pbc, energy, free_energy, natoms, volume, mass, charge,
            calculator, calculator_parameters, forces, stress, data, constraints
     FROM systems WHERE id = ?`, [src_id],
  )
  if (rows.length === 0) throw new Error(`Source row ${src_id} not found`)
  const r = rows[0]
  const ts = now_epoch()
  const uid = crypto.randomUUID().replace(/-/g, ``)

  run_stmt(d,
    `INSERT INTO systems (unique_id, ctime, mtime, numbers, positions, cell, pbc,
     energy, free_energy, natoms, volume, mass, charge, calculator, calculator_parameters,
     forces, stress, data, constraints)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uid, ts, ts, r.numbers, r.positions, r.cell, r.pbc,
     r.energy, r.free_energy, r.natoms, r.volume, r.mass, r.charge,
     r.calculator, r.calculator_parameters, r.forces, r.stress, r.data, r.constraints],
  )

  // sql.js doesn't have last_insert_rowid() directly — query it
  const id_rows = query<{ id: number }>(d, `SELECT last_insert_rowid() as id`)
  const new_id = id_rows[0].id

  // Copy species
  run_stmt(d, `INSERT INTO species (Z, n, id) SELECT Z, n, ? FROM species WHERE id = ?`, [new_id, src_id])

  // Insert key-value pairs
  const label = get_text_kv(d, src_id, `label`)
  for (const [key, value] of [
    [`workflow_id`, target_project_id],
    [`step_id`, `__saved__`],
    [`node_type`, `user_save`],
    [`label`, label],
  ] as const) {
    run_stmt(d, `INSERT INTO text_key_values (key, value, id) VALUES (?, ?, ?)`, [key, value, new_id])
    run_stmt(d, `INSERT OR IGNORE INTO keys (key, id) VALUES (?, ?)`, [key, new_id])
  }

  return new_id
}

// ---------------------------------------------------------------------------
// Structure read (BLOB → PymatgenStructure JSON)
// ---------------------------------------------------------------------------

export async function db_get_result_structure(row_id: number): Promise<Record<string, unknown>> {
  const d = await get_db()
  const rows = query<{
    numbers: Uint8Array | null
    positions: Uint8Array | null
    cell: Uint8Array | null
    pbc: number
    energy: number | null
    data: string | null
  }>(d, `SELECT numbers, positions, cell, pbc, energy, data FROM systems WHERE id = ?`, [row_id])

  if (rows.length === 0) throw new Error(`Row ${row_id} not found`)
  const r = rows[0]

  const numbers = r.numbers ? parse_i32_blob(r.numbers) : new Int32Array()
  const positions_flat = r.positions ? parse_f64_blob(r.positions) : new Float64Array()
  const cell_flat = r.cell ? parse_f64_blob(r.cell) : new Float64Array()

  const natoms = numbers.length

  const cell: Mat3 = cell_flat.length >= 9
    ? [[cell_flat[0], cell_flat[1], cell_flat[2]],
       [cell_flat[3], cell_flat[4], cell_flat[5]],
       [cell_flat[6], cell_flat[7], cell_flat[8]]]
    : [[0, 0, 0], [0, 0, 0], [0, 0, 0]]

  const has_pbc = r.pbc !== 0
  const params = cell_params(cell)
  const is_periodic = has_pbc && params.volume > 0.01

  const lattice = is_periodic ? {
    matrix: cell,
    a: params.a, b: params.b, c: params.c,
    alpha: params.alpha, beta: params.beta, gamma: params.gamma,
    volume: params.volume,
    pbc: [(r.pbc & 1) !== 0, (r.pbc & 2) !== 0, (r.pbc & 4) !== 0],
  } : null

  const inv_cell = is_periodic ? invert_3x3(cell) : null

  const sites = []
  for (let i = 0; i < natoms; i++) {
    const z = numbers[i]
    const symbol = z < ELEMENTS.length ? ELEMENTS[z] : `X`
    const xyz: [number, number, number] = i * 3 + 2 < positions_flat.length
      ? [positions_flat[i * 3], positions_flat[i * 3 + 1], positions_flat[i * 3 + 2]]
      : [0, 0, 0]
    const abc = inv_cell ? mat_vec_mul(inv_cell, xyz) : xyz

    sites.push({
      species: [{ element: symbol, occu: 1.0 }],
      abc: [abc[0], abc[1], abc[2]],
      xyz: [xyz[0], xyz[1], xyz[2]],
      label: symbol,
      properties: {},
    })
  }

  // Restore site properties & labels from stored metadata
  // (pseudo_h_potcar, pseudo_h_charge, selective_dynamics, etc.)
  if (r.data) {
    try {
      const data = typeof r.data === `string` ? JSON.parse(r.data) : r.data
      const site_props = (data.site_properties || {}) as Record<string, Record<string, unknown>>
      const site_labels = (data.site_labels || {}) as Record<string, string>
      for (let i = 0; i < sites.length; i++) {
        const key = String(i)
        if (site_props[key]) {
          ;(sites[i] as Record<string, unknown>).properties = site_props[key]
        }
        if (site_labels[key]) {
          ;(sites[i] as Record<string, unknown>).label = site_labels[key]
        }
      }
    } catch { /* ignore malformed data */ }
  }

  const structure: Record<string, unknown> = { sites }
  if (lattice) structure.lattice = lattice
  if (r.energy != null) structure.energy = r.energy
  return structure
}

// ---------------------------------------------------------------------------
// Structure write (PymatgenStructure JSON → ASE BLOB)
// ---------------------------------------------------------------------------

export async function db_save_structure(
  structure: Record<string, unknown>,
  name: string,
  project_id?: string,
): Promise<{ row_id: number; formula: string }> {
  const d = await get_db()

  const lattice = structure.lattice as Record<string, unknown> | null | undefined
  const has_lattice = lattice != null && lattice.matrix != null

  let cell_flat: number[]
  let pbc: number
  if (has_lattice) {
    const matrix = lattice!.matrix as number[][]
    cell_flat = matrix.flat()
    if (cell_flat.length !== 9) throw new Error(`lattice.matrix must be 3x3`)
    pbc = 7
  } else {
    cell_flat = Array(9).fill(0)
    pbc = 0
  }

  const sites = structure.sites as Array<Record<string, unknown>>
  if (!sites) throw new Error(`missing sites array`)

  const natoms = sites.length
  const numbers_arr: number[] = []
  const positions_arr: number[] = []
  const species_counts = new Map<number, number>()

  for (const site of sites) {
    const species_arr = site.species as Array<Record<string, unknown>>
    const element = (species_arr?.[0]?.element as string) || `X`
    const z = element_to_z(element)
    if (z === null) throw new Error(`unknown element: ${element}`)
    numbers_arr.push(z)
    species_counts.set(z, (species_counts.get(z) || 0) + 1)
    const xyz = site.xyz as number[]
    positions_arr.push(xyz[0], xyz[1], xyz[2])
  }

  const cell_mat: Mat3 = [
    [cell_flat[0], cell_flat[1], cell_flat[2]],
    [cell_flat[3], cell_flat[4], cell_flat[5]],
    [cell_flat[6], cell_flat[7], cell_flat[8]],
  ]
  const { volume } = cell_params(cell_mat)

  const numbers_blob = pack_i32_blob(numbers_arr)
  const positions_blob = pack_f64_blob(positions_arr)
  const cell_blob = pack_f64_blob(cell_flat)

  const ts = now_epoch()
  const uid = crypto.randomUUID().replace(/-/g, ``)
  const wf_id = project_id || `__user__`

  // Extract site properties & labels that ASE can't preserve
  // (pseudo_h_potcar, pseudo_h_charge, selective_dynamics, custom labels)
  const site_metadata: Record<string, unknown> = {}
  const site_properties: Record<string, unknown> = {}
  const site_labels: Record<string, string> = {}
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]
    const props = site.properties as Record<string, unknown> | undefined
    if (props && Object.keys(props).length > 0) {
      const filtered: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(props)) {
        if (v != null) filtered[k] = v
      }
      if (Object.keys(filtered).length > 0) site_properties[String(i)] = filtered
    }
    const label = site.label as string | undefined
    const species_arr = site.species as Array<Record<string, unknown>>
    const elem = (species_arr?.[0]?.element as string) || ``
    if (label && label !== elem) site_labels[String(i)] = label
  }
  if (Object.keys(site_properties).length > 0) site_metadata.site_properties = site_properties
  if (Object.keys(site_labels).length > 0) site_metadata.site_labels = site_labels
  const data_json = Object.keys(site_metadata).length > 0 ? JSON.stringify(site_metadata) : null

  run_stmt(d,
    `INSERT INTO systems (unique_id, ctime, mtime, numbers, positions, cell, pbc, natoms, volume, energy, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [uid, ts, ts, numbers_blob, positions_blob, cell_blob, pbc, natoms, volume, data_json],
  )

  const id_rows = query<{ id: number }>(d, `SELECT last_insert_rowid() as id`)
  const new_id = id_rows[0].id

  // Insert species
  const sorted_species = [...species_counts.entries()].sort((a, b) => a[0] - b[0])
  for (const [z, n] of sorted_species) {
    run_stmt(d, `INSERT INTO species (Z, n, id) VALUES (?, ?, ?)`, [z, n, new_id])
  }

  // Insert key-value pairs
  for (const [key, value] of [
    [`workflow_id`, wf_id],
    [`step_id`, `__saved__`],
    [`node_type`, `user_save`],
    [`label`, name],
  ] as const) {
    run_stmt(d, `INSERT INTO text_key_values (key, value, id) VALUES (?, ?, ?)`, [key, value, new_id])
    run_stmt(d, `INSERT INTO keys (key, id) VALUES (?, ?)`, [key, new_id])
  }

  const formula = formula_from_species(d, new_id)
  schedule_flush()
  return { row_id: new_id, formula }
}

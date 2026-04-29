/**
 * Job Script Store — manages built-in presets and user-created custom job scripts.
 * Built-in scripts are fetched from the server API.
 * Custom scripts are persisted in localStorage.
 */
import type { JobScript, CalcTypeCategory } from './workflow-types'
import { API_BASE } from '$lib/api/config'

const LS_KEY = `catgo-custom-job-scripts`

/** Reverse map: node_type → calc_category key (built from fetched categories) */
let _node_type_to_category: Record<string, string> = {}

class JobScriptStore {
  scripts = $state<JobScript[]>([])
  categories = $state<Record<string, CalcTypeCategory>>({})
  initialized = $state(false)
  loading = $state(false)

  /** Fetch built-in presets + calc categories from API, load custom from localStorage */
  async init() {
    if (this.initialized || this.loading) return
    this.loading = true
    try {
      const [presets_res, cats_res] = await Promise.all([
        fetch(`${API_BASE}/workflow/job-script-presets`),
        fetch(`${API_BASE}/workflow/calc-type-categories`),
      ])

      // Parse built-in presets
      const builtin: JobScript[] = []
      if (presets_res.ok) {
        const data: { id: string; name: string; template: string }[] = await presets_res.json()
        for (const p of data) {
          builtin.push({
            id: `preset:${p.id}`,
            name: p.name,
            template: p.template,
            is_builtin: true,
            cluster_tag: p.id.includes(`shaheen`) ? `shaheen` : p.id.includes(`pbs`) ? `pbs` : `slurm`,
            calc_type: ``,  // builtins are general-purpose
          })
        }
      }

      // Parse calc type categories
      if (cats_res.ok) {
        const cats: Record<string, CalcTypeCategory> = await cats_res.json()
        this.categories = cats
        // Build reverse map
        _node_type_to_category = {}
        for (const [cat_key, cat_info] of Object.entries(cats)) {
          for (const nt of cat_info.node_types) {
            _node_type_to_category[nt] = cat_key
          }
        }
      }

      // Load custom from localStorage
      const custom = _load_custom()

      this.scripts = [...builtin, ...custom]
      this.initialized = true
    } catch (err) {
      console.error(`Failed to init job script store:`, err)
    } finally {
      this.loading = false
    }
  }

  /** Add a new custom script. Returns its ID. */
  add(entry: Omit<JobScript, 'id' | 'is_builtin'>): string {
    const id = `custom:${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const script: JobScript = { ...entry, id, is_builtin: false }
    this.scripts = [...this.scripts, script]
    _persist_custom(this.scripts)
    return id
  }

  /** Update an existing custom script. */
  update(id: string, updates: Partial<JobScript>) {
    this.scripts = this.scripts.map(s => {
      if (s.id !== id || s.is_builtin) return s
      return { ...s, ...updates, id, is_builtin: false }
    })
    _persist_custom(this.scripts)
  }

  /** Delete a custom script (cannot delete built-in). */
  remove(id: string) {
    this.scripts = this.scripts.filter(s => !(s.id === id && !s.is_builtin))
    _persist_custom(this.scripts)
  }

  /** Duplicate a script (creates a custom copy). */
  duplicate(id: string, new_name: string): string {
    const source = this.scripts.find(s => s.id === id)
    if (!source) return ``
    return this.add({
      name: new_name,
      template: source.template,
      cluster_tag: source.cluster_tag,
      calc_type: source.calc_type,
    })
  }

  /** Get scripts relevant to a given node type. Returns all scripts sorted by relevance. */
  get_for_node(node_type: string): JobScript[] {
    const cat = _node_type_to_category[node_type] || ``
    // Sort: matching calc_type first, then general, then others
    return [...this.scripts].sort((a, b) => {
      const a_match = a.calc_type === cat ? 0 : a.calc_type === `` ? 1 : 2
      const b_match = b.calc_type === cat ? 0 : b.calc_type === `` ? 1 : 2
      if (a_match !== b_match) return a_match - b_match
      // Within same relevance, builtins first
      if (a.is_builtin !== b.is_builtin) return a.is_builtin ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  /** Find a script by ID. */
  find(id: string): JobScript | undefined {
    return this.scripts.find(s => s.id === id)
  }

  /** Get scripts grouped by calc_type category for the workplace sidebar. */
  get grouped(): { category: string; label: string; scripts: JobScript[] }[] {
    const groups: { category: string; label: string; scripts: JobScript[] }[] = []

    // General (no calc_type)
    const general = this.scripts.filter(s => !s.calc_type)
    if (general.length > 0) {
      groups.push({ category: ``, label: `General`, scripts: general })
    }

    // Per calc_type category
    for (const [key, cat] of Object.entries(this.categories)) {
      const scripts = this.scripts.filter(s => s.calc_type === key)
      groups.push({ category: key, label: cat.label, scripts })
    }

    return groups
  }
}

/** Load custom scripts from localStorage. */
function _load_custom(): JobScript[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as JobScript[]
    return parsed.map(s => ({ ...s, is_builtin: false }))
  } catch {
    return []
  }
}

/** Persist only custom scripts to localStorage. */
function _persist_custom(all: JobScript[]) {
  const custom = all.filter(s => !s.is_builtin)
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(custom))
  } catch (err) {
    console.error(`Failed to persist job scripts:`, err)
  }
}

export const job_script_store = new JobScriptStore()

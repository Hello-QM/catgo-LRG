/**
 * Settings Controller — extracted from Structure.svelte (P2-3)
 *
 * Manages all structure viewer settings state with localStorage persistence:
 * - Scene props (atom rendering, bonds, camera, labels, lighting, forces, cell display)
 * - Lattice props (cell edge/surface styling)
 * - Background color override effect
 * - Auto-enable force vectors when structure has force data
 * - Performance optimization (sphere segments reduction for large structures)
 *
 * Persistence:
 * - On creation: loads saved settings from localStorage, merges with DEFAULTS
 * - On change: debounced save (1s) via $effect — writes both scene_props and lattice_props
 * - Safe for SSR: guarded by `typeof window !== 'undefined'`
 * - Forward-compatible: new settings get DEFAULTS, removed settings are ignored (merge_nested)
 *
 * NOT YET EXTRACTED (remain in Structure.svelte):
 * - Camera state: camera, camera_has_moved, camera_is_moving, camera_move_timeout
 * - Label management: visible_atom_labels, visible_bond_labels, visible_charge_labels,
 *   charge_label_offsets, charge_label_colors, charge_color_menu
 * - Bonding strategy: bonding_strategy, bonding_config, h_bond_* settings
 * - These are deeply coupled with StructureScene interaction handlers and would need
 *   careful extraction to avoid breaking the reactive chain.
 *
 * The scene_props object is deeply reactive ($state) and is:
 * 1. Passed by reference to StructureControls (which directly mutates it)
 * 2. Spread into StructureScene via {...scene_props}
 * 3. Directly mutated in various places in Structure.svelte
 *
 * Uses .svelte.ts suffix because internal state uses $state/$derived/$effect runes.
 *
 * Dependencies:
 * - structure accessed via getter dep (for auto-enable effects)
 * - wrapper accessed via getter dep (for background color effect)
 */

import type { AnyStructure } from '$lib'
import { DEFAULTS } from '$lib/settings'
import { merge_nested } from '$lib/utils'
import type { ComponentProps } from 'svelte'
import type StructureScene from '../StructureScene.svelte'

// ─── Constants ───

const STORAGE_KEY = `catgo-viewer-settings`
const SAVE_DEBOUNCE_MS = 1000

// ─── Types ───

/** Lattice display properties */
export interface LatticeProps {
  cell_edge_opacity: number
  cell_surface_opacity: number
  cell_edge_color: string
  cell_surface_color: string
  cell_edge_width: number
  show_cell_vectors: boolean
}

/** Shape of persisted settings in localStorage */
interface PersistedSettings {
  scene_props?: Record<string, unknown>
  lattice_props?: Partial<LatticeProps>
}

/** Dependencies interface — access parent component state via getter/setter closures */
export interface SettingsDeps {
  get_structure: () => AnyStructure | undefined
  get_wrapper: () => HTMLDivElement | undefined
  get_background_color: () => string | undefined
  get_background_opacity: () => number
  get_performance_mode: () => string
  /** Set false for preview/readonly instances to prevent writing to localStorage.
   *  Only the primary viewer should persist settings. Defaults to true. */
  persist?: boolean
}

// ─── Persistence helpers ───

function is_plain_object(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === `object` && !Array.isArray(v)
}

function load_persisted(): PersistedSettings {
  try {
    if (typeof window === `undefined`) return {}
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored)
      if (!is_plain_object(parsed)) {
        console.warn(`[CatGo] Ignoring invalid persisted settings (expected object, got ${typeof parsed})`)
        return {}
      }
      // Validate nested shapes — drop corrupted sub-objects rather than propagating garbage
      if (parsed.scene_props && !is_plain_object(parsed.scene_props)) delete parsed.scene_props
      if (parsed.lattice_props && !is_plain_object(parsed.lattice_props)) delete parsed.lattice_props
      // One-time strip of legacy hide_incomplete_bonds (default now `false` so
      // cross-cell bond stubs render). Old sessions saved the opposite value;
      // drop the key so the current default applies. Re-persists immediately
      // so subsequent loads skip this branch.
      if (is_plain_object(parsed.scene_props)) {
        const sp = parsed.scene_props as Record<string, unknown>
        if (`hide_incomplete_bonds` in sp) {
          delete sp[`hide_incomplete_bonds`]
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)) } catch { /* ignore */ }
        }
      }
      // One-time migration: when the show_site_indices default flipped from
      // `true` back to `false`, clear any stale persisted value so the new
      // default applies. Guarded by a sentinel so subsequent UI toggles are
      // preserved.
      if (!(parsed as Record<string, unknown>)._site_idx_default_false_migrated) {
        if (is_plain_object(parsed.scene_props) && `show_site_indices` in parsed.scene_props) {
          delete (parsed.scene_props as Record<string, unknown>)[`show_site_indices`]
        }
        ;(parsed as Record<string, unknown>)._site_idx_default_false_migrated = true
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)) } catch { /* ignore */ }
      }
      // One-time cleanup: an earlier bug re-wrapped site_label_bg_color in an
      // extra `color-mix(...)` on every mount, so the persisted value
      // accumulated dozens of nesting levels. A deeply nested color-mix() is
      // O(2^depth) for the CSS engine to resolve, freezing the main thread when
      // site labels/indices rendered. Drop any value with >1 color-mix() so the
      // default re-applies; the code fix (parse_label_bg) keeps it single-level.
      if (is_plain_object(parsed.scene_props)) {
        const sp = parsed.scene_props as Record<string, unknown>
        const bg = sp.site_label_bg_color
        if (typeof bg === `string` && (bg.match(/color-mix\(/g) ?? []).length > 1) {
          delete sp.site_label_bg_color
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed)) } catch { /* ignore */ }
        }
      }
      return parsed as PersistedSettings
    }

    // One-time migration from old desktop key (catgo-settings → catgo-viewer-settings).
    // Old format stored scene_props fields at the top level; new format nests under scene_props.
    const legacy = localStorage.getItem(`catgo-settings`)
    if (legacy) {
      const old = JSON.parse(legacy)
      if (is_plain_object(old)) {
        const migrated: PersistedSettings = { scene_props: old }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
        localStorage.removeItem(`catgo-settings`)
        return migrated
      }
    }
  } catch (err) {
    console.warn(`[CatGo] Failed to load persisted viewer settings:`, err)
  }
  return {}
}

function save_persisted(data: PersistedSettings): void {
  try {
    if (typeof window === `undefined`) return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (err) {
    console.warn(`[CatGo] Failed to save viewer settings:`, err)
  }
}

// ─── Factory ───

/**
 * Create settings controller — manages all scene and lattice settings state.
 *
 * Loads persisted user preferences from localStorage on creation,
 * merging with DEFAULTS so new settings always have sensible values.
 * Auto-saves on change with debouncing.
 *
 * Usage:
 * ```ts
 * const settings = create_settings_controller({
 *   get_structure: () => structure,
 *   get_wrapper: () => wrapper,
 *   get_background_color: () => background_color,
 *   get_background_opacity: () => background_opacity,
 *   get_performance_mode: () => performance_mode,
 * })
 * ```
 */
export function create_settings_controller(deps: SettingsDeps) {
  const should_persist = deps.persist !== false

  // ═══ Load persisted settings ═══
  // Always load (so preview instances show consistent settings), but only save if persist=true.
  const saved = load_persisted()

  // ═══ Scene Props ═══
  // Deeply reactive state object containing ALL structure viewer settings.
  // Initialized from DEFAULTS merged with any persisted user preferences.
  // merge_nested handles: new keys get defaults, saved keys override, nested objects merge recursively.
  // StructureControls mutates this directly via bind:, tool-handler sets props via set_scene_prop.

  let scene_props = $state(
    saved.scene_props
      ? merge_nested(DEFAULTS.structure, saved.scene_props as Partial<typeof DEFAULTS.structure>)
      : DEFAULTS.structure
  )

  // ═══ Lattice Props ═══
  // Separate state for lattice display settings (cell edge/surface styling).

  const default_lattice: LatticeProps = {
    cell_edge_opacity: DEFAULTS.structure.cell_edge_opacity,
    cell_surface_opacity: DEFAULTS.structure.cell_surface_opacity,
    cell_edge_color: DEFAULTS.structure.cell_edge_color,
    cell_surface_color: DEFAULTS.structure.cell_surface_color,
    cell_edge_width: DEFAULTS.structure.cell_edge_width,
    show_cell_vectors: DEFAULTS.structure.show_cell_vectors,
  }

  let lattice_props = $state<LatticeProps>(
    saved.lattice_props
      ? { ...default_lattice, ...saved.lattice_props } as LatticeProps
      : default_lattice
  )

  // ═══ Auto-Save ═══
  // Debounced persistence — watches scene_props and lattice_props for changes,
  // writes to localStorage after 1s of inactivity.
  // Only active when persist=true (skipped for preview/readonly instances).

  let save_timeout: ReturnType<typeof setTimeout> | null = null
  let save_initialized = false

  if (should_persist) {
    $effect(() => {
      // Read both reactive objects to establish dependencies.
      // Spreading creates a shallow snapshot that Svelte can diff.
      const snapshot: PersistedSettings = {
        scene_props: { ...scene_props },
        lattice_props: { ...lattice_props },
      }
      // Skip the first run — this is just the loaded state, don't re-save it.
      // Without this guard, the initial load would immediately write back to localStorage,
      // potentially overwriting saved settings if apply_scene_props runs before the first save.
      if (!save_initialized) { save_initialized = true; return }
      if (save_timeout) clearTimeout(save_timeout)
      save_timeout = setTimeout(() => save_persisted(snapshot), SAVE_DEBOUNCE_MS)
      return () => { if (save_timeout) clearTimeout(save_timeout) }
    })
  }

  // ═══ Force Vectors Auto-Enable ═══
  // Track whether we've already auto-enabled force vectors to avoid re-enabling after user disables.

  let force_vectors_auto_enabled = false

  $effect(() => {
    const structure = deps.get_structure()
    if (structure?.sites && !force_vectors_auto_enabled) {
      const has_force_data = structure.sites.some((site) =>
        site.properties?.force && Array.isArray(site.properties.force)
      )

      if (has_force_data && !scene_props.show_force_vectors) {
        scene_props.show_force_vectors = true
        scene_props.force_scale ??= DEFAULTS.structure.force_scale
        scene_props.force_color ??= DEFAULTS.structure.force_color
        scene_props.force_display_mode ??= DEFAULTS.structure.force_display_mode
        force_vectors_auto_enabled = true
      }
    }
  })

  // ═══ Performance Optimization ═══
  // Reduce sphere segments for large structures in speed mode.

  $effect(() => {
    const structure = deps.get_structure()
    const performance_mode = deps.get_performance_mode()
    if (structure?.sites && performance_mode === `speed`) {
      const site_count = structure.sites.length
      const current_sphere_segments = scene_props.sphere_segments || 20

      if (site_count > 200) {
        scene_props.sphere_segments = Math.min(current_sphere_segments, 12)
      }
    }
  })

  // ═══ Background Color Override ═══
  // Sets CSS custom property on wrapper for background color with opacity.

  $effect(() => {
    const wrapper = deps.get_wrapper()
    const background_color = deps.get_background_color()
    const background_opacity = deps.get_background_opacity()
    if (typeof window !== `undefined` && wrapper && background_color) {
      const alpha_hex = Math.round(background_opacity * 255)
        .toString(16)
        .padStart(2, `0`)
      wrapper.style.setProperty(
        `--struct-bg-override`,
        `${background_color}${alpha_hex}`,
      )
    } else if (typeof window !== `undefined` && wrapper) {
      wrapper.style.removeProperty(`--struct-bg-override`)
    }
  })

  // ═══ Functions ═══

  /**
   * Apply incoming scene_props from parent (shallow merge).
   * Called when scene_props_in bindable prop changes.
   */
  function apply_scene_props(incoming: ComponentProps<typeof StructureScene> | undefined) {
    if (incoming && typeof incoming === `object`) {
      Object.assign(scene_props, incoming)
    }
  }

  /**
   * Apply incoming lattice_props from parent (shallow merge).
   * Called when lattice_props_in bindable prop changes.
   */
  function apply_lattice_props(incoming: Partial<LatticeProps> | undefined) {
    if (incoming && typeof incoming === `object`) {
      Object.assign(lattice_props, incoming)
    }
  }

  /**
   * Set a single scene prop by key — used by tool-handler.
   */
  function set_scene_prop<K extends string>(key: K, value: unknown) {
    (scene_props as any)[key] = value
  }

  /**
   * Serialize current settings for save/restore.
   */
  function serialize(): { scene_props: Record<string, unknown>; lattice_props: LatticeProps } {
    return {
      scene_props: { ...scene_props },
      lattice_props: { ...lattice_props },
    }
  }

  /**
   * Reset all settings to factory defaults and clear persisted data.
   */
  function reset_to_defaults() {
    Object.assign(scene_props, DEFAULTS.structure)
    Object.assign(lattice_props, default_lattice)
    try {
      if (typeof window !== `undefined`) localStorage.removeItem(STORAGE_KEY)
    } catch (err) {
      console.warn(`[CatGo] Failed to clear persisted settings:`, err)
    }
  }

  // ═══ Public Interface ═══

  return {
    // ── Scene props (deeply reactive object, passed to StructureControls and spread into StructureScene) ──
    get scene_props() { return scene_props },
    set scene_props(v: typeof scene_props) { scene_props = v },

    // ── Lattice props ──
    get lattice_props() { return lattice_props },
    set lattice_props(v: LatticeProps) { lattice_props = v },

    // ── Functions ──
    apply_scene_props,
    apply_lattice_props,
    set_scene_prop,
    serialize,
    reset_to_defaults,
  }
}

/** Return type for the settings controller */
export type SettingsController = ReturnType<typeof create_settings_controller>

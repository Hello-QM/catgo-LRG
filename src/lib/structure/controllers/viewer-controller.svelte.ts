/**
 * Viewer Controller — extracted from Structure.svelte
 *
 * Manages property color computation:
 * - atom_color_config -> property_colors reactive pipeline
 * - coordination coloring (async via bond worker)
 * - wyckoff / charge / custom coloring (sync)
 *
 * Camera state (scene, camera, orbit_controls, movement tracking, reset logic)
 * remains in Structure.svelte because it requires template bind: directives.
 *
 * Uses .svelte.ts suffix because internal state uses $state/$derived/$effect runes.
 */

import type { AnyStructure } from '$lib/structure'
import type { AtomColorConfig } from '../atom-properties'
import { get_property_colors, expand_structure_for_pbc, coordination_colors_from_bonds } from '../atom-properties'
import type { AtomPropertyColors } from '../atom-properties'
import { compute_bonds_async } from '../workers/bond-worker-api'
import type { BondingStrategy } from '../bonding'
import type { MoyoDataset } from '@spglib/moyo-wasm'
import { analyze_mof, normalize_sbu_type } from '../mof-analysis'

// ─── Types ───

export interface ViewerDeps {
  get_structure: () => AnyStructure | undefined
  get_atom_color_config: () => Partial<AtomColorConfig>
  get_scene_props_bonding_strategy: () => BondingStrategy
  get_symmetry_data: () => MoyoDataset | null
}

// ─── Factory ───

export function create_viewer_controller(deps: ViewerDeps) {
  // ═══ Property Colors ═══
  let property_colors = $state<AtomPropertyColors | null>(null)
  let coordination_computing = $state(false)

  $effect(() => {
    const __t0 = (import.meta.env?.DEV) ? performance.now() : 0
    const s = deps.get_structure()
    const config = deps.get_atom_color_config()
    const strategy = deps.get_scene_props_bonding_strategy()
    const sym = deps.get_symmetry_data()

    if (!s || config.mode === 'element') {
      property_colors = null
      coordination_computing = false
      return
    }

    if (config.mode === 'coordination') {
      let cancelled = false
      coordination_computing = true
      const has_lattice = 'lattice' in s && s.lattice !== undefined
      const pbc = has_lattice ? (s as any).lattice.pbc : undefined
      const has_pbc = has_lattice && (pbc === undefined || pbc.some((p: boolean) => p))
      const __exp_t0 = (import.meta.env?.DEV) ? performance.now() : 0
      const expanded = has_pbc ? expand_structure_for_pbc(s) : s
      const orig_count = s.sites.length
      if (import.meta.env?.DEV) {
        const __exp_dt = performance.now() - __exp_t0
        if (__exp_dt > 5) console.log(`[probe] property_colors expand_pbc: ${__exp_dt.toFixed(1)}ms (${s.sites.length} sites → ${expanded.sites.length})`)
      }

      const __async_t0 = (import.meta.env?.DEV) ? performance.now() : 0
      compute_bonds_async(expanded, strategy, {})
        .then((bonds) => {
          if (cancelled) return
          const __color_t0 = (import.meta.env?.DEV) ? performance.now() : 0
          property_colors = coordination_colors_from_bonds(
            bonds, expanded, orig_count, config.scale, config.scale_type,
          )
          if (import.meta.env?.DEV) {
            const __bond_dt = performance.now() - __async_t0
            const __color_dt = performance.now() - __color_t0
            console.log(`[probe] property_colors coordination async: bonds=${__bond_dt.toFixed(1)}ms colors=${__color_dt.toFixed(1)}ms (${expanded.sites.length} expanded sites, ${bonds.length} bonds, strategy=${strategy})`)
          }
        })
        .catch((err) => {
          if (cancelled) return
          console.error('[property_colors] async coordination failed:', err)
          property_colors = null
        })
        .finally(() => {
          if (!cancelled) coordination_computing = false
        })

      if (import.meta.env?.DEV) {
        const __dt = performance.now() - __t0
        if (__dt > 5) console.log(`[probe] property_colors $effect (coordination sync portion): ${__dt.toFixed(1)}ms`)
      }
      return () => { cancelled = true }
    }

    if (config.mode === 'mof_sbu') {
      let cancelled = false
      coordination_computing = true // reuse the loading indicator

      analyze_mof(s)
        .then((analysis) => {
          if (cancelled || !analysis) {
            property_colors = null
            return
          }
          const result = analysis.clusters
          // Color atoms by SBU type: Node=blue, Linker=green, Ligand/Cap=orange, POE=gray
          const SBU_COLORS: Record<string, string> = {
            Node: '#3b82f6', Linker: '#22c55e', Ligand: '#f59e0b', PointOfExtension: '#9ca3af',
          }
          const colors: string[] = []
          const values: (string)[] = []
          for (let i = 0; i < s.sites.length; i++) {
            const sbu_idx = result.attributions[i]
            if (sbu_idx !== undefined && sbu_idx < result.sbus.length) {
              const sbu = result.sbus[sbu_idx]
              const norm_type = normalize_sbu_type(sbu.sbu_type)
              values.push(norm_type)
              colors.push(SBU_COLORS[norm_type] || '#808080')
            } else {
              values.push('Unknown')
              colors.push('#808080')
            }
          }
          property_colors = {
            colors, values,
            unique_values: [...new Set(values)],
          }
        })
        .catch((err) => {
          if (cancelled) return
          console.error('[property_colors] MOF SBU coloring failed:', err)
          property_colors = null
        })
        .finally(() => {
          if (!cancelled) coordination_computing = false
        })

      return () => { cancelled = true }
    }

    // Sync path for cheap modes (wyckoff, charge, custom)
    try {
      property_colors = get_property_colors(s, config, strategy, sym)
    } catch (error) {
      console.error('[property_colors] computation failed, falling back to element colors:', error)
      property_colors = null
    }

    if (import.meta.env?.DEV) {
      const __dt = performance.now() - __t0
      if (__dt > 5) console.log(`[probe] property_colors $effect (mode=${config.mode}): ${__dt.toFixed(1)}ms (${s.sites.length} sites)`)
    }
  })

  // ═══ Public Interface ═══

  return {
    // Property colors
    get property_colors() { return property_colors },
    get coordination_computing() { return coordination_computing },
  }
}

export type ViewerController = ReturnType<typeof create_viewer_controller>

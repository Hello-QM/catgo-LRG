// CatGo settings defaults - runtime default values extracted from config

import { merge_nested } from '$lib/utils'
import { SETTINGS_CONFIG } from './config'
import type { DefaultSettings, PhaseDiagramDefaults, SettingType, SettingsConfig } from './types'

// Extract values from settings config for runtime use
const extract_values = (
  config: SettingsConfig | SettingType | Record<string, unknown>,
): DefaultSettings => {
  const result = {} as Record<string, unknown>
  for (const [key, value] of Object.entries(config)) {
    if (value && typeof value === `object` && `value` in value) {
      result[key] = (value as SettingType).value
    } else if (value && typeof value === `object`) {
      result[key] = extract_values(value as Record<string, unknown>)
    }
  }
  return result as DefaultSettings
}

// Runtime defaults - extracted values for use in components
export const DEFAULTS = extract_values(SETTINGS_CONFIG)

// Helper to merge with defaults - handles nested structure
export const merge = (user?: Partial<DefaultSettings>): DefaultSettings => ({
  ...DEFAULTS,
  ...(user || {}),
  structure: merge_nested(DEFAULTS.structure, user?.structure),
  trajectory: merge_nested(DEFAULTS.trajectory, user?.trajectory),
  composition: merge_nested(DEFAULTS.composition, user?.composition),
  plot: merge_nested(DEFAULTS.plot, user?.plot),
  scatter: merge_nested(DEFAULTS.scatter, user?.scatter),
  histogram: merge_nested(DEFAULTS.histogram, user?.histogram),
  bar: merge_nested(DEFAULTS.bar, user?.bar),
  chat: merge_nested(DEFAULTS.chat, user?.chat),
  phase_diagram: merge_nested(DEFAULTS.phase_diagram, user?.phase_diagram),
  gesture: merge_nested(DEFAULTS.gesture, user?.gesture),
} as DefaultSettings)

// Narrowed accessor for phase diagram defaults to ensure strong typing at call sites
export const PD_DEFAULTS: PhaseDiagramDefaults = DEFAULTS
  .phase_diagram as PhaseDiagramDefaults

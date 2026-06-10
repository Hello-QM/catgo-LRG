import { describe, it, expect } from 'vitest'
import { NODE_DEFINITIONS, CALC_TYPE_OPTIONS, TOOL_TYPE_OPTIONS } from '../node-definitions'
import en_workflow from '$lib/i18n/en/workflow'
import zh_workflow from '$lib/i18n/zh/workflow'

/**
 * i18n contract for node definitions (regression for two bugs):
 *
 * 1. "WORKFLOW.NODE_GROUP_*" leak — node-definitions.ts used to call t() at
 *    module load, before the async workflow i18n pack resolved, freezing raw
 *    keys into the consts.
 * 2. Wrong-locale freeze — eagerly translating at load froze whichever locale
 *    was active at import time, so switching EN↔ZH left stale text behind.
 *
 * The contract now: def fields store either plain display strings or raw
 * `workflow.*` i18n keys; consumers (NodeConfigPanel, EngineTaskEditor, …)
 * translate at render time via t(), which is reactive to locale switches.
 * Every key referenced here MUST exist in BOTH locale packs, otherwise t()
 * falls back to the raw key and the UI shows "WORKFLOW.NODE_GROUP_…".
 */
describe('node-definitions i18n keys', () => {
  const all_params = Object.values(NODE_DEFINITIONS).flatMap(
    def => def.param_schema ?? []
  )

  const referenced_keys = new Set<string>()
  for (const p of all_params) {
    for (const v of [p.group, p.label, p.help]) {
      if (typeof v === 'string' && v.startsWith('workflow.')) referenced_keys.add(v)
    }
    const options = `options` in p && Array.isArray(p.options) ? p.options : []
    for (const o of options) {
      const l = (o as { label?: string }).label
      if (typeof l === 'string' && l.startsWith('workflow.')) referenced_keys.add(l)
    }
  }
  for (const o of [...CALC_TYPE_OPTIONS, ...TOOL_TYPE_OPTIONS]) {
    if (o.label.startsWith('workflow.')) referenced_keys.add(o.label)
  }

  it('references at least the node_group_* keys (sanity: extraction works)', () => {
    expect(
      [...referenced_keys].some(k => k.startsWith('workflow.node_group_'))
    ).toBe(true)
  })

  it('every workflow.* key referenced in defs exists in the EN pack', () => {
    const missing = [...referenced_keys].filter(
      k => en_workflow[k.slice('workflow.'.length)] == null
    )
    expect(missing).toEqual([])
  })

  it('every workflow.* key referenced in defs exists in the ZH pack', () => {
    const missing = [...referenced_keys].filter(
      k => zh_workflow[k.slice('workflow.'.length)] == null
    )
    expect(missing).toEqual([])
  })
})

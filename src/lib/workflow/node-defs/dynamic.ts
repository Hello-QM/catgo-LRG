/**
 * Dynamic engine loading — fetches declarative engine specs from the backend
 * and registers them as software options in unified calculation nodes.
 */
import type { ParamDef, EngineSpec, ShowIfCondition } from '../workflow-types'
import { NODE_DEFINITIONS } from './index'

const _engine_specs: Map<string, EngineSpec> = new Map()

export async function load_dynamic_engines(api_base: string): Promise<void> {
  try {
    const resp = await fetch(`${api_base}/workflow/engine-defs`)
    if (!resp.ok) return
    const specs: EngineSpec[] = await resp.json()
    for (const spec of specs) {
      _engine_specs.set(spec.engine, spec)
      _register_software_option(spec)
      _merge_params(spec)
    }
  } catch {
    // Backend may not support engine-defs yet
  }
}

function _register_software_option(spec: EngineSpec): void {
  for (const calc_type of spec.supported_calc_types) {
    const node_def = NODE_DEFINITIONS[calc_type]
    if (!node_def?.param_schema) continue
    const software_param = node_def.param_schema.find(p => p.key === `software`)
    if (!software_param?.options) continue
    const exists = software_param.options.some(o => o.value === spec.engine)
    if (!exists) {
      software_param.options.push({ label: spec.label, value: spec.engine })
    }
  }
}

function _merge_params(spec: EngineSpec): void {
  const frontend_params: ParamDef[] = spec.params.map(p => {
    const show_if: ShowIfCondition | ShowIfCondition[] = p.show_if
      ? [{ key: `software`, values: [spec.engine] }, ...(Array.isArray(p.show_if) ? p.show_if : [p.show_if])]
      : { key: `software`, values: [spec.engine] }
    return {
      key: p.key,
      label: p.label,
      type: p.type as ParamDef[`type`],
      default: p.default,
      options: p.options,
      help: p.help,
      group: p.group,
      show_if,
      min: p.range?.[0],
      max: p.range?.[1],
    }
  })
  for (const calc_type of spec.supported_calc_types) {
    const node_def = NODE_DEFINITIONS[calc_type]
    if (!node_def) continue
    for (const param of frontend_params) {
      const existing = node_def.param_schema?.find(p => p.key === param.key)
      if (!existing) {
        node_def.param_schema = node_def.param_schema || []
        node_def.param_schema.push(param)
      }
    }
  }
}

export function get_engine_spec(engine_key: string): EngineSpec | undefined {
  return _engine_specs.get(engine_key)
}

export function all_engine_specs(): EngineSpec[] {
  return [..._engine_specs.values()]
}


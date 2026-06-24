import { describe, expect, it } from 'vitest'
import {
  snap,
  uid,
  get_nh,
  get_handle_pos,
  bezier,
  point_on_bezier,
  has_cycle,
  would_create_cycle,
  auto_layout,
  to_workflow_json,
  clone_for_paste,
  is_vasp_node,
  is_hpc_node,
  is_structure_node,
  get_display_params,
  GRID,
  NW,
  NH,
  TEMPLATES,
  TEMPLATE_GROUPS,
  parse_kpoints_str,
  get_vasp_calc_type,
  resolve_input_structure,
  has_structure_io,
  type WfNode,
  type WfEdge,
} from '$lib/workflow/graph-model'

// ─── Helpers ───

function make_node(id: string, type: string, x = 0, y = 0, params: Record<string, unknown> = {}): WfNode {
  return { id, type, x, y, params }
}

function make_edge(id: string, from: string, to: string, fromH = `out-0`, toH = `in-0`): WfEdge {
  return { id, from, to, fromH, toH }
}

// ─── Tests ───

describe(`snap`, () => {
  it(`snaps value to nearest grid multiple`, () => {
    expect(snap(0)).toBe(0)
    expect(snap(GRID)).toBe(GRID)
    expect(snap(GRID + 1)).toBe(GRID)
    expect(snap(GRID * 1.5)).toBe(GRID * 2)
    // Math.round(-0.5) === 0 in JS (rounds toward +Infinity)
    expect(snap(-GRID / 2)).toBe(-0)
    expect(snap(-GRID * 0.6)).toBe(-GRID)
  })

  it(`returns exact value when already on grid`, () => {
    expect(snap(GRID * 5)).toBe(GRID * 5)
    expect(snap(-GRID * 3)).toBe(-GRID * 3)
  })
})

describe(`uid`, () => {
  it(`returns a string starting with 'n'`, () => {
    const id = uid()
    expect(typeof id).toBe(`string`)
    expect(id.startsWith(`n`)).toBe(true)
  })

  it(`returns unique strings on repeated calls`, () => {
    const ids = new Set(Array.from({ length: 100 }, () => uid()))
    expect(ids.size).toBe(100)
  })
})

describe(`get_nh`, () => {
  it(`returns base NH for structure_input (no display params)`, () => {
    const node = make_node(`n1`, `structure_input`)
    expect(get_nh(node)).toBe(NH)
  })

  it(`returns 95 for condition node (is_condition)`, () => {
    const node = make_node(`n1`, `condition`)
    expect(get_nh(node)).toBe(95)
  })

  it(`returns 80 for loop node (is_loop)`, () => {
    const node = make_node(`n1`, `loop`)
    expect(get_nh(node)).toBe(80)
  })

  it(`returns 80 for merge node (is_merge)`, () => {
    const node = make_node(`n1`, `merge`)
    expect(get_nh(node)).toBe(80)
  })

  it(`returns NH for unknown node type`, () => {
    const node = make_node(`n1`, `nonexistent_type_xyz`)
    expect(get_nh(node)).toBe(NH)
  })

  it(`increases height when node has display params`, () => {
    // geo_opt with visible params like ENCUT. software=vasp so the VASP-only
    // params pass the node-def show_if filter (get_display_params now hides
    // params irrelevant to the chosen software, e.g. ENCUT on an MLP node).
    const node = make_node(`n1`, `geo_opt`, 0, 0, { software: `vasp`, ENCUT: 520, EDIFF: `1e-5`, ISIF: 3 })
    const h = get_nh(node)
    expect(h).toBeGreaterThan(NH)
  })
})

describe(`get_handle_pos`, () => {
  it(`input handle is at left edge of node`, () => {
    const node = make_node(`n1`, `structure_input`, 100, 200)
    const pos = get_handle_pos(node, `in-0`, true)
    expect(pos.x).toBe(100) // left edge = node.x
  })

  it(`output handle is at right edge of node`, () => {
    const node = make_node(`n1`, `structure_input`, 100, 200)
    const pos = get_handle_pos(node, `out-0`, false)
    expect(pos.x).toBe(100 + NW) // right edge = node.x + NW
  })

  it(`y position is distributed within node height`, () => {
    const node = make_node(`n1`, `structure_input`, 100, 200)
    const pos = get_handle_pos(node, `out-0`, false)
    const nh = get_nh(node)
    expect(pos.y).toBeGreaterThan(200)
    expect(pos.y).toBeLessThan(200 + nh)
  })

  it(`multiple handles are spaced vertically`, () => {
    // condition node has 2 inputs
    const node = make_node(`n1`, `condition`, 100, 200)
    const pos0 = get_handle_pos(node, `in-0`, true)
    const pos1 = get_handle_pos(node, `in-1`, true)
    expect(pos0.y).toBeLessThan(pos1.y)
    expect(pos0.x).toBe(pos1.x)
  })
})

describe(`bezier`, () => {
  it(`returns an SVG path string starting with M`, () => {
    const path = bezier(0, 0, 300, 100)
    expect(path.startsWith(`M`)).toBe(true)
    expect(path).toContain(`C`)
  })

  it(`starts at (x1,y1)`, () => {
    const path = bezier(10, 20, 300, 100)
    expect(path.startsWith(`M10,20`)).toBe(true)
  })

  it(`ends at (x2,y2)`, () => {
    const path = bezier(10, 20, 300, 100)
    expect(path.endsWith(`300,100`)).toBe(true)
  })
})

describe(`point_on_bezier`, () => {
  it(`returns start point at t=0`, () => {
    const p = point_on_bezier(10, 20, 300, 200, 0)
    expect(p.x).toBeCloseTo(10, 5)
    expect(p.y).toBeCloseTo(20, 5)
  })

  it(`returns end point at t=1`, () => {
    const p = point_on_bezier(10, 20, 300, 200, 1)
    expect(p.x).toBeCloseTo(300, 5)
    expect(p.y).toBeCloseTo(200, 5)
  })

  it(`returns midpoint approximately between start and end at t=0.5`, () => {
    const p = point_on_bezier(0, 0, 400, 0, 0.5)
    // midpoint x should be roughly 200 for symmetric case
    expect(p.x).toBeCloseTo(200, 0)
    expect(p.y).toBeCloseTo(0, 5)
  })

  it(`stays within bounding box of start and end`, () => {
    const x1 = 50, y1 = 100, x2 = 400, y2 = 300
    for (let t = 0; t <= 1; t += 0.1) {
      const p = point_on_bezier(x1, y1, x2, y2, t)
      // y should be within [y1, y2]
      expect(p.y).toBeGreaterThanOrEqual(y1 - 1)
      expect(p.y).toBeLessThanOrEqual(y2 + 1)
    }
  })
})

describe(`has_cycle`, () => {
  it(`returns false for a simple DAG`, () => {
    const nodes = [make_node(`a`, `geo_opt`), make_node(`b`, `geo_opt`), make_node(`c`, `geo_opt`)]
    const edges = [make_edge(`e1`, `a`, `b`), make_edge(`e2`, `b`, `c`)]
    expect(has_cycle(nodes, edges)).toBe(false)
  })

  it(`returns true for a cycle`, () => {
    const nodes = [make_node(`a`, `geo_opt`), make_node(`b`, `geo_opt`), make_node(`c`, `geo_opt`)]
    const edges = [make_edge(`e1`, `a`, `b`), make_edge(`e2`, `b`, `c`), make_edge(`e3`, `c`, `a`)]
    expect(has_cycle(nodes, edges)).toBe(true)
  })

  it(`returns false for single node with no edges`, () => {
    const nodes = [make_node(`a`, `geo_opt`)]
    expect(has_cycle(nodes, [])).toBe(false)
  })

  it(`returns false for empty graph`, () => {
    expect(has_cycle([], [])).toBe(false)
  })

  it(`returns true for self-loop`, () => {
    const nodes = [make_node(`a`, `geo_opt`)]
    const edges = [make_edge(`e1`, `a`, `a`)]
    expect(has_cycle(nodes, edges)).toBe(true)
  })
})

describe(`would_create_cycle`, () => {
  it(`returns false when new edge does not create cycle`, () => {
    const nodes = [make_node(`a`, `geo_opt`), make_node(`b`, `geo_opt`), make_node(`c`, `geo_opt`)]
    const edges = [make_edge(`e1`, `a`, `b`)]
    expect(would_create_cycle(nodes, edges, `b`, `c`)).toBe(false)
  })

  it(`returns true when new edge would complete a cycle`, () => {
    const nodes = [make_node(`a`, `geo_opt`), make_node(`b`, `geo_opt`), make_node(`c`, `geo_opt`)]
    const edges = [make_edge(`e1`, `a`, `b`), make_edge(`e2`, `b`, `c`)]
    expect(would_create_cycle(nodes, edges, `c`, `a`)).toBe(true)
  })

  it(`returns true for self-referencing edge`, () => {
    const nodes = [make_node(`a`, `geo_opt`)]
    expect(would_create_cycle(nodes, [], `a`, `a`)).toBe(true)
  })
})

describe(`auto_layout`, () => {
  it(`returns the same number of nodes`, () => {
    const nodes = [make_node(`a`, `structure_input`), make_node(`b`, `geo_opt`), make_node(`c`, `single_point`)]
    const edges = [make_edge(`e1`, `a`, `b`), make_edge(`e2`, `b`, `c`)]
    const laid = auto_layout(nodes, edges)
    expect(laid).toHaveLength(3)
  })

  it(`preserves node ids and types`, () => {
    const nodes = [make_node(`a`, `structure_input`), make_node(`b`, `geo_opt`)]
    const edges = [make_edge(`e1`, `a`, `b`)]
    const laid = auto_layout(nodes, edges)
    expect(laid.map(n => n.id)).toEqual([`a`, `b`])
    expect(laid.map(n => n.type)).toEqual([`structure_input`, `geo_opt`])
  })

  it(`places upstream nodes to the left of downstream`, () => {
    const nodes = [make_node(`a`, `structure_input`), make_node(`b`, `geo_opt`)]
    const edges = [make_edge(`e1`, `a`, `b`)]
    const laid = auto_layout(nodes, edges)
    const a = laid.find(n => n.id === `a`)!
    const b = laid.find(n => n.id === `b`)!
    expect(a.x).toBeLessThan(b.x)
  })

  it(`handles disconnected nodes`, () => {
    const nodes = [make_node(`a`, `structure_input`), make_node(`b`, `geo_opt`)]
    const laid = auto_layout(nodes, [])
    expect(laid).toHaveLength(2)
    // Both should have finite positions
    for (const n of laid) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
  })

  it(`handles empty graph`, () => {
    expect(auto_layout([], [])).toEqual([])
  })
})

describe(`to_workflow_json`, () => {
  it(`serializes nodes with id, type, params`, () => {
    const nodes = [make_node(`n1`, `geo_opt`, 100, 200, { ENCUT: 520 })]
    const json = to_workflow_json(nodes, [])
    expect(json.nodes).toHaveLength(1)
    expect(json.nodes[0]).toEqual({ id: `n1`, type: `geo_opt`, params: { ENCUT: 520 } })
  })

  it(`strips x, y from nodes`, () => {
    const nodes = [make_node(`n1`, `geo_opt`, 100, 200)]
    const json = to_workflow_json(nodes, [])
    expect(json.nodes[0]).not.toHaveProperty(`x`)
    expect(json.nodes[0]).not.toHaveProperty(`y`)
  })

  it(`serializes edges with from, to, fromHandle, toHandle`, () => {
    const edges: WfEdge[] = [{ id: `e1`, from: `a`, to: `b`, fromH: `out-0`, toH: `in-0` }]
    const json = to_workflow_json([], edges)
    expect(json.edges).toHaveLength(1)
    expect(json.edges[0]).toEqual({ from: `a`, to: `b`, fromHandle: `out-0`, toHandle: `in-0` })
  })

  it(`includes label when present`, () => {
    const edges: WfEdge[] = [{ id: `e1`, from: `a`, to: `b`, fromH: `out-0`, toH: `in-0`, label: `yes` }]
    const json = to_workflow_json([], edges)
    expect(json.edges[0].label).toBe(`yes`)
  })

  it(`omits label key when absent`, () => {
    const edges: WfEdge[] = [{ id: `e1`, from: `a`, to: `b`, fromH: `out-0`, toH: `in-0` }]
    const json = to_workflow_json([], edges)
    expect(json.edges[0]).not.toHaveProperty(`label`)
  })
})

describe(`is_vasp_node`, () => {
  it(`returns true for legacy VASP types`, () => {
    for (const t of [`vasp_relax`, `vasp_static`, `vasp_md`, `bulk_opt`, `slab_relax`, `frequency`, `electronic`]) {
      expect(is_vasp_node(t)).toBe(true)
    }
  })

  it(`returns true for unified types with software=vasp`, () => {
    expect(is_vasp_node(`geo_opt`, { software: `vasp` })).toBe(true)
    expect(is_vasp_node(`single_point`, { software: `vasp` })).toBe(true)
  })

  it(`returns false for unified types with non-vasp software`, () => {
    expect(is_vasp_node(`geo_opt`, { software: `cp2k` })).toBe(false)
    expect(is_vasp_node(`single_point`)).toBe(false)
  })

  it(`returns false for non-vasp types`, () => {
    expect(is_vasp_node(`structure_input`)).toBe(false)
    expect(is_vasp_node(`analysis`)).toBe(false)
  })
})

describe(`is_hpc_node`, () => {
  it(`returns true for VASP node types`, () => {
    expect(is_hpc_node(`vasp_relax`)).toBe(true)
    expect(is_hpc_node(`vasp_static`)).toBe(true)
  })

  it(`returns true for MLP node types`, () => {
    expect(is_hpc_node(`mlp_relax`)).toBe(true)
    expect(is_hpc_node(`mlp_md`)).toBe(true)
  })

  it(`returns true for unified calc types`, () => {
    expect(is_hpc_node(`geo_opt`)).toBe(true)
    expect(is_hpc_node(`single_point`)).toBe(true)
    expect(is_hpc_node(`md`)).toBe(true)
    expect(is_hpc_node(`freq`)).toBe(true)
  })

  it(`returns false for charge_analysis (post-processing, not HPC)`, () => {
    expect(is_hpc_node(`charge_analysis`)).toBe(false)
  })

  it(`returns false for non-HPC types`, () => {
    expect(is_hpc_node(`structure_input`)).toBe(false)
    expect(is_hpc_node(`condition`)).toBe(false)
    expect(is_hpc_node(`analysis`)).toBe(false)
  })
})

describe(`is_structure_node`, () => {
  it(`returns true for structure-related types`, () => {
    expect(is_structure_node(`structure_input`)).toBe(true)
    expect(is_structure_node(`slab_gen`)).toBe(true)
    expect(is_structure_node(`adsorbate_place`)).toBe(true)
  })

  it(`returns false for non-structure types`, () => {
    expect(is_structure_node(`geo_opt`)).toBe(false)
    expect(is_structure_node(`condition`)).toBe(false)
  })
})

describe(`get_display_params`, () => {
  it(`returns empty array for undefined`, () => {
    expect(get_display_params(undefined)).toEqual([])
  })

  it(`returns empty array for empty params`, () => {
    expect(get_display_params({})).toEqual([])
  })

  it(`filters out hidden keys`, () => {
    const params = { structure_json: `{...}`, ENCUT: 520, hpc_session_id: `abc` }
    const result = get_display_params(params)
    const keys = result.map(([k]) => k)
    expect(keys).not.toContain(`structure_json`)
    expect(keys).not.toContain(`hpc_session_id`)
    expect(keys).toContain(`ENCUT`)
  })

  it(`filters out values longer than 80 chars`, () => {
    const params = { short: `ok`, long: `x`.repeat(81) }
    const result = get_display_params(params)
    const keys = result.map(([k]) => k)
    expect(keys).toContain(`short`)
    expect(keys).not.toContain(`long`)
  })

  it(`returns at most 3 entries`, () => {
    const params = { a: 1, b: 2, c: 3, d: 4, e: 5 }
    const result = get_display_params(params)
    expect(result.length).toBeLessThanOrEqual(3)
  })
})

describe(`clone_for_paste`, () => {
  it(`creates new ids for nodes`, () => {
    const clipboard = {
      nodes: [make_node(`orig1`, `geo_opt`, 100, 200)],
      edges: [],
    }
    const result = clone_for_paste(clipboard)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].id).not.toBe(`orig1`)
    expect(result.nodes[0].id.startsWith(`n`)).toBe(true)
  })

  it(`offsets positions by 40`, () => {
    const clipboard = {
      nodes: [make_node(`orig1`, `geo_opt`, 100, 200)],
      edges: [],
    }
    const result = clone_for_paste(clipboard)
    expect(result.nodes[0].x).toBe(140)
    expect(result.nodes[0].y).toBe(240)
  })

  it(`remaps edge from/to to new node ids`, () => {
    const clipboard = {
      nodes: [make_node(`a`, `geo_opt`), make_node(`b`, `single_point`)],
      edges: [make_edge(`e1`, `a`, `b`)],
    }
    const result = clone_for_paste(clipboard)
    const newA = result.nodes[0].id
    const newB = result.nodes[1].id
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0].from).toBe(newA)
    expect(result.edges[0].to).toBe(newB)
    expect(result.edges[0].id).not.toBe(`e1`)
  })

  it(`preserves node type and params`, () => {
    const clipboard = {
      nodes: [make_node(`a`, `geo_opt`, 0, 0, { ENCUT: 520 })],
      edges: [],
    }
    const result = clone_for_paste(clipboard)
    expect(result.nodes[0].type).toBe(`geo_opt`)
    expect(result.nodes[0].params).toEqual({ ENCUT: 520 })
  })
})

describe(`TEMPLATES`, () => {
  it(`has at least one template`, () => {
    expect(Object.keys(TEMPLATES).length).toBeGreaterThan(0)
  })

  for (const [key, tmpl] of Object.entries(TEMPLATES)) {
    describe(`template: ${key}`, () => {
      it(`has name and desc`, () => {
        expect(typeof tmpl.name).toBe(`string`)
        expect(tmpl.name.length).toBeGreaterThan(0)
        expect(typeof tmpl.desc).toBe(`string`)
        expect(tmpl.desc.length).toBeGreaterThan(0)
      })

      it(`has at least one node`, () => {
        expect(tmpl.nodes.length).toBeGreaterThan(0)
      })

      it(`has unique node ids`, () => {
        const ids = tmpl.nodes.map(n => n.id)
        expect(new Set(ids).size).toBe(ids.length)
      })

      it(`has unique edge ids`, () => {
        const ids = tmpl.edges.map(e => e.id)
        expect(new Set(ids).size).toBe(ids.length)
      })

      it(`edge references point to existing nodes`, () => {
        const nodeIds = new Set(tmpl.nodes.map(n => n.id))
        for (const e of tmpl.edges) {
          expect(nodeIds.has(e.from)).toBe(true)
          expect(nodeIds.has(e.to)).toBe(true)
        }
      })

      it(`is acyclic (valid DAG)`, () => {
        expect(has_cycle(tmpl.nodes, tmpl.edges)).toBe(false)
      })
    })
  }
})

describe(`TEMPLATE_GROUPS`, () => {
  it(`references only existing template keys`, () => {
    const allKeys = TEMPLATE_GROUPS.flatMap(g => g.keys)
    for (const k of allKeys) {
      expect(TEMPLATES).toHaveProperty(k)
    }
  })

  it(`covers all template keys`, () => {
    const groupKeys = new Set(TEMPLATE_GROUPS.flatMap(g => g.keys))
    for (const k of Object.keys(TEMPLATES)) {
      expect(groupKeys.has(k)).toBe(true)
    }
  })
})

describe(`parse_kpoints_str`, () => {
  it(`parses "4x4x4" to [[4,4,4]]`, () => {
    expect(parse_kpoints_str(`4x4x4`)).toEqual([[4, 4, 4]])
  })

  it(`parses "3 3 1"`, () => {
    expect(parse_kpoints_str(`3 3 1`)).toEqual([[3, 3, 1]])
  })

  it(`returns undefined for falsy input`, () => {
    expect(parse_kpoints_str(null)).toBeUndefined()
    expect(parse_kpoints_str(undefined)).toBeUndefined()
    expect(parse_kpoints_str(``)).toBeUndefined()
  })

  it(`returns undefined for invalid strings`, () => {
    expect(parse_kpoints_str(`abc`)).toBeUndefined()
    expect(parse_kpoints_str(`4x4`)).toBeUndefined()
  })
})

describe(`get_vasp_calc_type`, () => {
  it(`maps legacy types correctly`, () => {
    expect(get_vasp_calc_type(`vasp_relax`)).toBe(`opt`)
    expect(get_vasp_calc_type(`vasp_static`)).toBe(`scf`)
    expect(get_vasp_calc_type(`electronic`)).toBe(`dos`)
    expect(get_vasp_calc_type(`frequency`)).toBe(`freq`)
  })

  it(`maps unified types correctly`, () => {
    expect(get_vasp_calc_type(`geo_opt`)).toBe(`opt`)
    expect(get_vasp_calc_type(`single_point`)).toBe(`scf`)
    expect(get_vasp_calc_type(`freq`)).toBe(`freq`)
  })

  it(`returns scf as default`, () => {
    expect(get_vasp_calc_type(`unknown_type`)).toBe(`scf`)
  })
})

describe(`resolve_input_structure`, () => {
  it(`finds structure_json from direct parent`, () => {
    const nodes = [
      make_node(`a`, `structure_input`, 0, 0, { structure_json: `{"atoms":[]}` }),
      make_node(`b`, `geo_opt`),
    ]
    const edges = [make_edge(`e1`, `a`, `b`)]
    expect(resolve_input_structure(`b`, nodes, edges)).toBe(`{"atoms":[]}`)
  })

  it(`returns null when no ancestor has structure_json`, () => {
    const nodes = [make_node(`a`, `structure_input`), make_node(`b`, `geo_opt`)]
    const edges = [make_edge(`e1`, `a`, `b`)]
    expect(resolve_input_structure(`b`, nodes, edges)).toBeNull()
  })

  it(`traverses multiple hops upstream`, () => {
    const nodes = [
      make_node(`a`, `structure_input`, 0, 0, { structure_json: `{"data":true}` }),
      make_node(`b`, `geo_opt`),
      make_node(`c`, `single_point`),
    ]
    const edges = [make_edge(`e1`, `a`, `b`), make_edge(`e2`, `b`, `c`)]
    expect(resolve_input_structure(`c`, nodes, edges)).toBe(`{"data":true}`)
  })
})

describe(`has_structure_io`, () => {
  it(`returns true for structure_input`, () => {
    expect(has_structure_io(`structure_input`)).toBe(true)
  })

  it(`returns false for unknown type`, () => {
    expect(has_structure_io(`nonexistent_xyz`)).toBe(false)
  })
})

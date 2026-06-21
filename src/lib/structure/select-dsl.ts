/**
 * CatGo selection DSL — a dependency-free, recursive-descent parser + evaluator
 * for the textual atom-selection grammar CatBot drives the viewer with.
 *
 * Semantics are ported from AtomCanvas's `selection_parser.py` / `selection_ops.py`
 * but evaluated against CatGo's `Site[]` shape (`species[0].element`, fractional
 * `abc`, cartesian `xyz`, `label`). All resolved indices are **0-based** to match
 * CatGo's `selected_sites`.
 *
 * Design invariants:
 *  - `select_atoms` is TOTAL: it never throws. Malformed input returns
 *    `{ error: string }`; an empty/whitespace query returns `{ indices: new Set() }`.
 *  - No catastrophic backtracking: the tokenizer is a single linear scan and the
 *    parser is straight LL recursive descent with a recursion-depth guard, so a
 *    pathological query terminates in O(token count) time.
 *  - bonded:/sphere: reuse `build_atom_graph`'s exact PBC minimum-image distance
 *    and `get_default_bond_length(...) * 1.25` cutoff so results agree with the
 *    viewer's atom-graph / inspect output.
 *
 * --- Grammar (EBNF) ---
 *   query     := or_expr
 *   or_expr   := and_expr  ( ('OR'  | '|') and_expr )*
 *   and_expr  := not_expr  ( ('AND' | '&') not_expr )*   # AND binds tighter than OR
 *   not_expr  := ('NOT' | '!') not_expr | primary
 *   primary   := '(' or_expr ')' | selector
 *   selector  := '*' | elem | label | ids | id | pos | frac | bonded | sphere
 */

import type { AnyStructure, ElementSymbol, Matrix3x3, Pbc, Site, Vec3 } from '$lib/structure'
import { mat3x3_vec3_multiply, transpose_3x3_matrix } from '$lib/math'
import { get_default_bond_length } from './atom-manipulation'
import { build_atom_graph } from './atom-graph'

export type SelectResult = { indices: Set<number> } | { error: string }

// Float-equality epsilon for the '='/'==' comparison operators.
const EPS = 1e-6

// Hard ceiling on parser recursion to defuse adversarial deeply-nested input.
const MAX_DEPTH = 512

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokKind = 'AND' | 'OR' | 'NOT' | 'LPAREN' | 'RPAREN' | 'SELECTOR'

interface Token {
  kind: TokKind
  // For SELECTOR tokens: the raw selector text (e.g. "elem:O", "pos:z>10",
  // "bonded:@0", "sphere:@1;3.5", "*"). For operators/parens: the literal.
  text: string
  pos: number
}

class ParseError extends Error {}

/** Split a query string into tokens. A selector token greedily consumes a
 *  contiguous run of non-whitespace, non-paren characters that is not itself a
 *  bare boolean operator. `&`, `|`, `!` are single-char operators; `(`/`)` are
 *  structural. Keywords AND/OR/NOT are recognised case-insensitively only when
 *  they stand alone (whitespace/paren-delimited), so `elem:Na` is never split. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  const n = input.length
  let i = 0

  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r'

  while (i < n) {
    const c = input[i]

    if (isSpace(c)) {
      i++
      continue
    }

    if (c === '(') {
      tokens.push({ kind: 'LPAREN', text: '(', pos: i })
      i++
      continue
    }
    if (c === ')') {
      tokens.push({ kind: 'RPAREN', text: ')', pos: i })
      i++
      continue
    }
    if (c === '&') {
      tokens.push({ kind: 'AND', text: '&', pos: i })
      i++
      continue
    }
    if (c === '|') {
      tokens.push({ kind: 'OR', text: '|', pos: i })
      i++
      continue
    }
    // `!` is the NOT operator, but `!=` is the comparison operator inside a
    // selector (e.g. `pos:y!=5`). Only treat a bare `!` (not followed by `=`)
    // as NOT here; an embedded `!=` is consumed as part of the selector word.
    if (c === '!' && input[i + 1] !== '=') {
      tokens.push({ kind: 'NOT', text: '!', pos: i })
      i++
      continue
    }

    // Otherwise consume a word: a run up to the next whitespace, paren, or
    // bare boolean operator. A `!` only breaks the word when standalone (not
    // part of `!=`), so comparison ops survive inside the selector token.
    const start = i
    while (i < n) {
      const ch = input[i]
      if (isSpace(ch) || ch === '(' || ch === ')' || ch === '&' || ch === '|') {
        break
      }
      if (ch === '!' && input[i + 1] !== '=') {
        break
      }
      i++
    }
    const word = input.slice(start, i)
    const upper = word.toUpperCase()
    if (upper === 'AND') tokens.push({ kind: 'AND', text: word, pos: start })
    else if (upper === 'OR') tokens.push({ kind: 'OR', text: word, pos: start })
    else if (upper === 'NOT') tokens.push({ kind: 'NOT', text: word, pos: start })
    else tokens.push({ kind: 'SELECTOR', text: word, pos: start })
  }

  return tokens
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Node =
  | { type: 'and'; left: Node; right: Node }
  | { type: 'or'; left: Node; right: Node }
  | { type: 'not'; operand: Node }
  | { type: 'selector'; text: string; pos: number }

// ---------------------------------------------------------------------------
// Parser (recursive descent, LL, depth-guarded)
// ---------------------------------------------------------------------------

class Parser {
  private toks: Token[]
  private idx = 0
  private depth = 0

  constructor(toks: Token[]) {
    this.toks = toks
  }

  private peek(): Token | undefined {
    return this.toks[this.idx]
  }

  private next(): Token | undefined {
    return this.toks[this.idx++]
  }

  private enter() {
    if (++this.depth > MAX_DEPTH) {
      throw new ParseError('expression nested too deeply')
    }
  }
  private leave() {
    this.depth--
  }

  parse(): Node {
    const node = this.parseOr()
    if (this.idx < this.toks.length) {
      const t = this.toks[this.idx]
      throw new ParseError(`unexpected token '${t.text}' at position ${t.pos}`)
    }
    return node
  }

  private parseOr(): Node {
    this.enter()
    let left = this.parseAnd()
    for (;;) {
      const t = this.peek()
      if (t && t.kind === 'OR') {
        this.next()
        const right = this.parseAnd()
        left = { type: 'or', left, right }
      } else break
    }
    this.leave()
    return left
  }

  private parseAnd(): Node {
    this.enter()
    let left = this.parseNot()
    for (;;) {
      const t = this.peek()
      if (t && t.kind === 'AND') {
        this.next()
        const right = this.parseNot()
        left = { type: 'and', left, right }
      } else break
    }
    this.leave()
    return left
  }

  private parseNot(): Node {
    this.enter()
    const t = this.peek()
    if (t && t.kind === 'NOT') {
      this.next()
      const operand = this.parseNot()
      this.leave()
      return { type: 'not', operand }
    }
    const node = this.parsePrimary()
    this.leave()
    return node
  }

  private parsePrimary(): Node {
    const t = this.next()
    if (!t) throw new ParseError('unexpected end of expression')
    if (t.kind === 'LPAREN') {
      const inner = this.parseOr()
      const close = this.next()
      if (!close || close.kind !== 'RPAREN') {
        throw new ParseError('unbalanced parentheses')
      }
      return inner
    }
    if (t.kind === 'SELECTOR') {
      return { type: 'selector', text: t.text, pos: t.pos }
    }
    // An operator / RPAREN where a primary was expected.
    throw new ParseError(`unexpected token '${t.text}' at position ${t.pos}`)
  }
}

// ---------------------------------------------------------------------------
// Selector evaluation
// ---------------------------------------------------------------------------

const COMP_OPS = ['>=', '<=', '!=', '==', '>', '<', '='] as const
type CompOp = (typeof COMP_OPS)[number]

function applyOp(op: CompOp, a: number, b: number): boolean {
  switch (op) {
    case '>':
      return a > b
    case '<':
      return a < b
    case '>=':
      return a >= b
    case '<=':
      return a <= b
    case '!=':
      return Math.abs(a - b) > EPS
    case '=':
    case '==':
      return Math.abs(a - b) <= EPS
  }
}

function elementOf(site: Site): string {
  return (site.species?.[0]?.element ?? site.label ?? '?') as string
}

/** Build a minimum-image distance function matching build_atom_graph exactly. */
function makeDistanceFn(structure: AnyStructure): (i: number, j: number) => number {
  const sites = structure.sites ?? []
  const lattice = 'lattice' in structure
    ? (structure as { lattice?: { matrix?: Matrix3x3; pbc?: Pbc } }).lattice
    : undefined
  const matrix_T = lattice?.matrix ? transpose_3x3_matrix(lattice.matrix) : undefined
  const pbc: Pbc = lattice?.pbc ?? [true, true, true]
  const use_pbc = !!matrix_T && sites.every((s) => Array.isArray(s.abc))

  return (i: number, j: number): number => {
    if (use_pbc && matrix_T) {
      const da = sites[i].abc[0] - sites[j].abc[0]
      const db = sites[i].abc[1] - sites[j].abc[1]
      const dc = sites[i].abc[2] - sites[j].abc[2]
      const wrapped: Vec3 = [
        pbc[0] ? da - Math.round(da) : da,
        pbc[1] ? db - Math.round(db) : db,
        pbc[2] ? dc - Math.round(dc) : dc,
      ]
      const [dx, dy, dz] = mat3x3_vec3_multiply(matrix_T, wrapped)
      return Math.hypot(dx, dy, dz)
    }
    return Math.hypot(
      sites[i].xyz[0] - sites[j].xyz[0],
      sites[i].xyz[1] - sites[j].xyz[1],
      sites[i].xyz[2] - sites[j].xyz[2],
    )
  }
}

function selectElem(sites: Site[], symbolRaw: string): Set<number> {
  if (!/^[A-Za-z]+$/.test(symbolRaw)) {
    throw new ParseError(`elem: expects an element symbol, got '${symbolRaw}'`)
  }
  const target = symbolRaw.charAt(0).toUpperCase() + symbolRaw.slice(1).toLowerCase()
  const out = new Set<number>()
  for (let i = 0; i < sites.length; i++) {
    if (elementOf(sites[i]) === target) out.add(i)
  }
  return out
}

function selectLabel(sites: Site[], body: string): Set<number> {
  const out = new Set<number>()
  // Pre-compute per-element ordering (site order) for the ordinal form.
  let symbolMap: Map<string, number[]> | null = null
  const ensureSymbolMap = () => {
    if (symbolMap) return symbolMap
    symbolMap = new Map<string, number[]>()
    for (let i = 0; i < sites.length; i++) {
      const sym = elementOf(sites[i])
      const arr = symbolMap.get(sym)
      if (arr) arr.push(i)
      else symbolMap.set(sym, [i])
    }
    return symbolMap
  }

  const items = body.split(',')
  for (const rawItem of items) {
    const item = rawItem.trim()
    if (item === '') {
      throw new ParseError('label: empty item')
    }
    // Symbol + ordinal:  O1 / O1-5
    const m = /^([A-Za-z]+)(\d+)(?:-(\d+))?$/.exec(item)
    if (m) {
      const sym0 = m[1]
      const sym = sym0.charAt(0).toUpperCase() + sym0.slice(1).toLowerCase()
      const start = parseInt(m[2], 10)
      const end = m[3] ? parseInt(m[3], 10) : start
      if (start > end) continue
      const list = ensureSymbolMap().get(sym)
      if (!list) continue
      for (let k = start; k <= end; k++) {
        if (k >= 1 && k <= list.length) out.add(list[k - 1])
      }
      continue
    }
    // Bare number = 1-based GLOBAL site number:  3 / 3-7
    const mn = /^(\d+)(?:-(\d+))?$/.exec(item)
    if (mn) {
      const start = parseInt(mn[1], 10)
      const end = mn[2] ? parseInt(mn[2], 10) : start
      if (start > end) continue
      for (let k = start; k <= end; k++) {
        const idx0 = k - 1
        if (idx0 >= 0 && idx0 < sites.length) out.add(idx0)
      }
      continue
    }
    throw new ParseError(`label: malformed item '${item}'`)
  }
  return out
}

function selectIds(sites: Site[], body: string): Set<number> {
  const out = new Set<number>()
  if (body.trim() === '') return out
  for (const part of body.split(',')) {
    const p = part.trim()
    if (!/^-?\d+$/.test(p)) {
      throw new ParseError(`ids: non-integer index '${p}'`)
    }
    const v = parseInt(p, 10)
    if (v >= 0 && v < sites.length) out.add(v) // clamp out-of-range silently
  }
  return out
}

function selectId(sites: Site[], body: string): Set<number> {
  const p = body.trim()
  if (!/^-?\d+$/.test(p)) {
    throw new ParseError(`id: non-integer index '${p}'`)
  }
  const out = new Set<number>()
  const v = parseInt(p, 10)
  if (v >= 0 && v < sites.length) out.add(v)
  return out
}

function selectPosFrac(
  sites: Site[],
  body: string,
  kind: 'pos' | 'frac',
  hasLattice: boolean,
): Set<number> {
  // body like "z>10", "a>=0.5". First char(s) = axis, then op, then number.
  const m = /^([A-Za-z]+)\s*(>=|<=|!=|==|>|<|=)\s*(.+)$/.exec(body)
  if (!m) {
    throw new ParseError(`${kind}: expected AXIS OP VALUE, got '${body}'`)
  }
  const axisRaw = m[1].toLowerCase()
  const op = m[2] as CompOp
  const valStr = m[3].trim()
  const val = Number(valStr)
  if (valStr === '' || !Number.isFinite(val)) {
    throw new ParseError(`${kind}: non-numeric value '${valStr}'`)
  }
  let axis: number
  if (kind === 'pos') {
    axis = { x: 0, y: 1, z: 2 }[axisRaw] ?? -1
    if (axis < 0) throw new ParseError(`pos: invalid axis '${m[1]}' (use x/y/z)`)
  } else {
    axis = { a: 0, b: 1, c: 2 }[axisRaw] ?? -1
    if (axis < 0) throw new ParseError(`frac: invalid axis '${m[1]}' (use a/b/c)`)
  }
  const out = new Set<number>()
  // frac with no lattice / no abc -> empty (graceful), never a throw.
  if (kind === 'frac' && !hasLattice) return out
  for (let i = 0; i < sites.length; i++) {
    const coords = kind === 'pos' ? sites[i].xyz : sites[i].abc
    if (!coords) continue
    if (applyOp(op, coords[axis], val)) out.add(i)
  }
  return out
}

function parseAtIndex(token: string, body: string, n: number): number {
  const m = /^@(\d+)$/.exec(body.trim())
  if (!m) {
    throw new ParseError(`${token}: expected @INDEX, got '${body}'`)
  }
  const i = parseInt(m[1], 10)
  if (i < 0 || i >= n) {
    throw new ParseError(`${token}: index @${i} out of range (0..${n - 1})`)
  }
  return i
}

function evalSelector(text: string, structure: AnyStructure): Set<number> {
  const sites = structure.sites ?? []
  const n = sites.length
  const hasLattice = 'lattice' in structure &&
    !!(structure as { lattice?: { matrix?: Matrix3x3 } }).lattice?.matrix &&
    sites.every((s) => Array.isArray(s.abc))

  if (text === '*') {
    const out = new Set<number>()
    for (let i = 0; i < n; i++) out.add(i)
    return out
  }

  const colon = text.indexOf(':')
  if (colon < 0) {
    throw new ParseError(`unknown selector '${text}'`)
  }
  const tag = text.slice(0, colon).toLowerCase()
  const body = text.slice(colon + 1)

  switch (tag) {
    case 'elem':
      return selectElem(sites, body)
    case 'label':
      return selectLabel(sites, body)
    case 'ids':
      return selectIds(sites, body)
    case 'id':
      return selectId(sites, body)
    case 'pos':
      return selectPosFrac(sites, body, 'pos', hasLattice)
    case 'frac':
      return selectPosFrac(sites, body, 'frac', hasLattice)
    case 'bonded': {
      const i = parseAtIndex('bonded', body, n)
      const graph = build_atom_graph(structure)
      return new Set<number>(graph[i]?.neighbors ?? [])
    }
    case 'sphere': {
      const semi = body.indexOf(';')
      if (semi < 0) {
        throw new ParseError(`sphere: expected @INDEX;RADIUS, got '${body}'`)
      }
      const i = parseAtIndex('sphere', body.slice(0, semi), n)
      const rStr = body.slice(semi + 1).trim()
      const r = Number(rStr)
      if (rStr === '' || !Number.isFinite(r)) {
        throw new ParseError(`sphere: non-numeric radius '${rStr}'`)
      }
      const dist = makeDistanceFn(structure)
      const out = new Set<number>()
      for (let j = 0; j < n; j++) {
        if (dist(i, j) <= r) out.add(j) // includes i (dist 0)
      }
      return out
    }
    default:
      throw new ParseError(`unknown selector tag '${tag}:'`)
  }
}

// ---------------------------------------------------------------------------
// AST evaluation
// ---------------------------------------------------------------------------

function evalNode(node: Node, structure: AnyStructure, all: () => Set<number>): Set<number> {
  switch (node.type) {
    case 'selector':
      return evalSelector(node.text, structure)
    case 'not': {
      const sub = evalNode(node.operand, structure, all)
      const out = new Set<number>()
      for (const i of all()) {
        if (!sub.has(i)) out.add(i)
      }
      return out
    }
    case 'and': {
      const l = evalNode(node.left, structure, all)
      const r = evalNode(node.right, structure, all)
      const out = new Set<number>()
      for (const i of l) if (r.has(i)) out.add(i)
      return out
    }
    case 'or': {
      const l = evalNode(node.left, structure, all)
      const r = evalNode(node.right, structure, all)
      const out = new Set<number>(l)
      for (const i of r) out.add(i)
      return out
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and evaluate a selection DSL query against a structure.
 *
 * @returns `{ indices: Set<number> }` (0-based base-site indices) on success, or
 *   `{ error: string }` on a malformed query. Empty/whitespace query yields an
 *   empty index set. Never throws.
 */
export function select_atoms(query: string, structure?: AnyStructure): SelectResult {
  try {
    if (!query || query.trim() === '') {
      return { indices: new Set<number>() }
    }
    const struct: AnyStructure = structure ?? ({ sites: [] } as AnyStructure)
    const tokens = tokenize(query)
    if (tokens.length === 0) {
      return { indices: new Set<number>() }
    }
    const ast = new Parser(tokens).parse()

    const sites = struct.sites ?? []
    let allCache: Set<number> | null = null
    const all = () => {
      if (allCache) return allCache
      allCache = new Set<number>()
      for (let i = 0; i < sites.length; i++) allCache.add(i)
      return allCache
    }

    const indices = evalNode(ast, struct, all)
    return { indices }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { error: msg }
  }
}

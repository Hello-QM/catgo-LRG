import { describe, expect, it } from 'vitest'
import { select_atoms } from '$lib/structure/select-dsl'
import type { Matrix3x3, PymatgenMolecule, PymatgenStructure, Site } from '$lib/structure'

// --- helpers -------------------------------------------------------------

function site(
  element: string,
  abc: [number, number, number],
  xyz: [number, number, number],
  label: string,
): Site {
  return {
    species: [{ element: element as Site['species'][0]['element'], occu: 1 }],
    abc,
    xyz,
    label,
    properties: {},
  }
}

// A small periodic test structure: 8 atoms, a cubic 10 Å cell.
//  idx element  frac (a,b,c)        cart (x,y,z)        label
//   0  O        (0.00,0.00,0.05)    (0,0,0.5)           O1
//   1  H        (0.10,0.00,0.10)    (1.0,0,1.0)         H1   (bonded to O0)
//   2  H        (0.00,0.10,0.10)    (0,1.0,1.0)         H2   (bonded to O0)
//   3  O        (0.50,0.50,0.95)    (5.0,5.0,9.5)       O2   (top of cell, z high)
//   4  C        (0.50,0.50,0.50)    (5.0,5.0,5.0)       C1
//   5  N        (0.50,0.60,0.55)    (5.0,6.0,5.5)       N1   (bonded to C4)
//   6  O        (0.98,0.50,0.50)    (9.8,5.0,5.0)       O3   (near a-edge)
//   7  H        (0.02,0.50,0.50)    (0.2,5.0,5.0)       H3   (wraps to O6 across a)
const LAT: Matrix3x3 = [
  [10, 0, 0],
  [0, 10, 0],
  [0, 0, 10],
]

function make_structure(): PymatgenStructure {
  const sites: Site[] = [
    site('O', [0.0, 0.0, 0.05], [0, 0, 0.5], 'O1'),
    site('H', [0.1, 0.0, 0.1], [1.0, 0, 1.0], 'H1'),
    site('H', [0.0, 0.1, 0.1], [0, 1.0, 1.0], 'H2'),
    site('O', [0.5, 0.5, 0.95], [5.0, 5.0, 9.5], 'O2'),
    site('C', [0.5, 0.5, 0.5], [5.0, 5.0, 5.0], 'C1'),
    site('N', [0.5, 0.6, 0.55], [5.0, 6.0, 5.5], 'N1'),
    site('O', [0.98, 0.5, 0.5], [9.8, 5.0, 5.0], 'O3'),
    site('H', [0.02, 0.5, 0.5], [0.2, 5.0, 5.0], 'H3'),
  ]
  return {
    sites,
    lattice: {
      matrix: LAT,
      pbc: [true, true, true],
      volume: 1000,
      a: 10,
      b: 10,
      c: 10,
      alpha: 90,
      beta: 90,
      gamma: 90,
    },
  }
}

// A 3-atom water molecule, NO lattice (for frac: graceful empty + sphere fallback).
function make_molecule(): PymatgenMolecule {
  return {
    sites: [
      site('O', [0, 0, 0], [0, 0, 0], 'O1'),
      site('H', [0, 0, 0], [0.96, 0, 0], 'H1'),
      site('H', [0, 0, 0], [-0.24, 0.93, 0], 'H2'),
    ],
  }
}

// Convenience: get sorted indices array, throwing if the parse errored.
function idx(query: string, structure: PymatgenStructure | PymatgenMolecule): number[] {
  const res = select_atoms(query, structure)
  if ('error' in res) throw new Error(`unexpected error: ${res.error}`)
  return [...res.indices].sort((a, b) => a - b)
}

// --- elem ---------------------------------------------------------------

describe('elem selector', () => {
  it('selects all atoms of an element', () => {
    expect(idx('elem:O', make_structure())).toEqual([0, 3, 6])
    expect(idx('elem:H', make_structure())).toEqual([1, 2, 7])
    expect(idx('elem:C', make_structure())).toEqual([4])
  })

  it('is case-insensitive on the symbol', () => {
    expect(idx('elem:o', make_structure())).toEqual([0, 3, 6])
    expect(idx('ELEM:O', make_structure())).toEqual([0, 3, 6])
  })

  it('two-letter symbols capitalize correctly', () => {
    // No Fe in structure -> empty, but must not error
    expect(idx('elem:fe', make_structure())).toEqual([])
  })
})

// --- label --------------------------------------------------------------

describe('label selector', () => {
  it('per-element 1-based ordinal (O1 = first O)', () => {
    expect(idx('label:O1', make_structure())).toEqual([0])
    expect(idx('label:O2', make_structure())).toEqual([3])
    expect(idx('label:O3', make_structure())).toEqual([6])
    expect(idx('label:H1', make_structure())).toEqual([1])
  })

  it('per-element ordinal range O1-3', () => {
    expect(idx('label:O1-3', make_structure())).toEqual([0, 3, 6])
  })

  it('per-element out-of-range ordinal silently skipped', () => {
    expect(idx('label:O5', make_structure())).toEqual([])
    // O1-9 -> only 3 O's, so just those three, no error
    expect(idx('label:O1-9', make_structure())).toEqual([0, 3, 6])
  })

  it('bare-number form = 1-based GLOBAL site number', () => {
    expect(idx('label:1', make_structure())).toEqual([0]) // site #1 -> index 0
    expect(idx('label:5', make_structure())).toEqual([4]) // site #5 -> index 4
  })

  it('bare-number range 3-5 (1-based global, inclusive)', () => {
    expect(idx('label:3-5', make_structure())).toEqual([2, 3, 4])
  })

  it('comma list of label items', () => {
    expect(idx('label:O1,H1', make_structure())).toEqual([0, 1])
  })
})

// --- ids / id -----------------------------------------------------------

describe('ids / id selectors (0-based)', () => {
  it('ids: comma list of 0-based indices', () => {
    expect(idx('ids:0,4,5', make_structure())).toEqual([0, 4, 5])
  })

  it('id: single 0-based index', () => {
    expect(idx('id:7', make_structure())).toEqual([7])
  })

  it('out-of-range indices dropped silently', () => {
    expect(idx('ids:0,99,3', make_structure())).toEqual([0, 3])
    expect(idx('id:99', make_structure())).toEqual([])
  })
})

// --- pos (cartesian) ----------------------------------------------------

describe('pos selector (cartesian Å)', () => {
  it('pos:z>5 selects high-z atoms', () => {
    // z>5: O2(idx3, z=9.5) and N1(idx5, z=5.5)
    expect(idx('pos:z>5', make_structure())).toEqual([3, 5])
  })

  it('pos:z>=5 includes the equal value', () => {
    // z == 5.0 atoms are 4,5,6,7 plus z=9.5 atom 3
    expect(idx('pos:z>=5', make_structure())).toEqual([3, 4, 5, 6, 7])
  })

  it('pos:x<1 selects low-x atoms', () => {
    expect(idx('pos:x<1', make_structure())).toEqual([0, 2, 7])
  })

  it('pos:y=5 with float-eps equality', () => {
    // y == 5.0 atoms: O2(idx3, [5,5,9.5]), C1(idx4), O3(idx6), H3(idx7)
    expect(idx('pos:y=5', make_structure())).toEqual([3, 4, 6, 7])
    expect(idx('pos:y==5', make_structure())).toEqual([3, 4, 6, 7])
  })

  it('pos:y!=5 negates', () => {
    expect(idx('pos:y!=5', make_structure())).toEqual([0, 1, 2, 5])
  })

  it('pos:x<=1 includes equal', () => {
    expect(idx('pos:x<=1', make_structure())).toEqual([0, 1, 2, 7])
  })
})

// --- frac (fractional) --------------------------------------------------

describe('frac selector (fractional)', () => {
  it('frac:c>0.9 selects top-fractional atoms', () => {
    expect(idx('frac:c>0.9', make_structure())).toEqual([3])
  })

  it('frac:c>0.5 several atoms', () => {
    expect(idx('frac:c>0.5', make_structure())).toEqual([3, 5])
  })

  it('frac:a>=0.5', () => {
    expect(idx('frac:a>=0.5', make_structure())).toEqual([3, 4, 5, 6])
  })

  it('molecule with no lattice -> frac is empty set, never throws', () => {
    expect(idx('frac:c>0.5', make_molecule())).toEqual([])
  })
})

// --- bonded -------------------------------------------------------------

describe('bonded selector', () => {
  it('bonded:@0 returns O0 neighbours (the two H), excludes O0 itself', () => {
    expect(idx('bonded:@0', make_structure())).toEqual([1, 2])
  })

  it('bonded:@4 returns C neighbours (N)', () => {
    const got = idx('bonded:@4', make_structure())
    expect(got).toContain(5)
    expect(got).not.toContain(4)
  })

  it('bonded across a cell boundary (MIC): O6 and H7 are neighbours', () => {
    // O3(idx6) frac a=0.98, H3(idx7) frac a=0.02 -> wrapped distance ~0.4 Å
    expect(idx('bonded:@6', make_structure())).toContain(7)
    expect(idx('bonded:@7', make_structure())).toContain(6)
  })
})

// --- sphere -------------------------------------------------------------

describe('sphere selector', () => {
  it('sphere:@4;2.0 includes the center atom (dist 0)', () => {
    const got = idx('sphere:@4;2.0', make_structure())
    expect(got).toContain(4) // includes itself
    expect(got).toContain(5) // N at ~1.12 Å
  })

  it('sphere across cell boundary uses MIC', () => {
    // O6<->H7 MIC distance ~0.4 Å, so a 1 Å sphere around O6 includes H7
    const got = idx('sphere:@6;1.0', make_structure())
    expect(got).toContain(6)
    expect(got).toContain(7)
  })

  it('sphere on a molecule (no lattice) uses raw cartesian', () => {
    const got = idx('sphere:@0;1.0', make_molecule())
    expect(got).toContain(0) // self
    expect(got).toContain(1) // H at 0.96 Å
    expect(got).toContain(2) // H at ~0.96 Å
  })
})

// --- '*' ----------------------------------------------------------------

describe('star selector', () => {
  it('* selects all indices', () => {
    expect(idx('*', make_structure())).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})

// --- boolean combinators ------------------------------------------------

describe('logic combinators', () => {
  it('AND = intersection: elem:O AND pos:z>5', () => {
    expect(idx('elem:O AND pos:z>5', make_structure())).toEqual([3])
  })

  it('OR = union: elem:C OR elem:N', () => {
    expect(idx('elem:C OR elem:N', make_structure())).toEqual([4, 5])
  })

  it('NOT = complement: NOT elem:O', () => {
    expect(idx('NOT elem:O', make_structure())).toEqual([1, 2, 4, 5, 7])
  })

  it('NOT bonded combo: elem:H AND NOT bonded:@0', () => {
    // H atoms are 1,2,7; bonded:@0 = {1,2}; so result = {7}
    expect(idx('elem:H AND NOT bonded:@0', make_structure())).toEqual([7])
  })

  it('AND binds tighter than OR', () => {
    // elem:C OR elem:N AND pos:z>=5 == elem:C OR (elem:N AND pos:z>=5)
    // N(idx5) z=5.5>=5 true -> {4} OR {5} = {4,5}
    expect(idx('elem:C OR elem:N AND pos:z>=5', make_structure())).toEqual([4, 5])
  })

  it('parentheses override precedence: (elem:C OR elem:N) AND frac:c>0.5', () => {
    // C(idx4) frac c=0.5 not >0.5; N(idx5) frac c=0.55>0.5 -> {5}
    expect(idx('(elem:C OR elem:N) AND frac:c>0.5', make_structure())).toEqual([5])
  })

  it('symbolic operators & | !', () => {
    expect(idx('elem:O & pos:z>5', make_structure())).toEqual([3])
    expect(idx('elem:C | elem:N', make_structure())).toEqual([4, 5])
    expect(idx('! elem:O', make_structure())).toEqual([1, 2, 4, 5, 7])
  })

  it('case-insensitive keywords', () => {
    expect(idx('elem:O and pos:z>5', make_structure())).toEqual([3])
    expect(idx('elem:C or elem:N', make_structure())).toEqual([4, 5])
    expect(idx('not elem:O', make_structure())).toEqual([1, 2, 4, 5, 7])
  })

  it('nested parentheses', () => {
    expect(idx('((elem:O)) AND (pos:z>5)', make_structure())).toEqual([3])
  })

  it('double NOT', () => {
    expect(idx('NOT NOT elem:C', make_structure())).toEqual([4])
  })
})

// --- empty / whitespace -------------------------------------------------

describe('empty queries', () => {
  it('empty string -> empty set, no error', () => {
    const res = select_atoms('', make_structure())
    expect('error' in res).toBe(false)
    if (!('error' in res)) expect([...res.indices]).toEqual([])
  })

  it('whitespace-only -> empty set, no error', () => {
    const res = select_atoms('   ', make_structure())
    expect('error' in res).toBe(false)
    if (!('error' in res)) expect([...res.indices]).toEqual([])
  })
})

// --- error cases (never throw) ------------------------------------------

describe('error handling (returns {error}, never throws)', () => {
  it('unknown selector tag', () => {
    const res = select_atoms('foo:bar', make_structure())
    expect('error' in res).toBe(true)
  })

  it('bad axis for pos', () => {
    const res = select_atoms('pos:q>5', make_structure())
    expect('error' in res).toBe(true)
  })

  it('missing operand', () => {
    const res = select_atoms('elem:', make_structure())
    expect('error' in res).toBe(true)
  })

  it('unbalanced parentheses', () => {
    const res = select_atoms('(elem:O AND pos:z>5', make_structure())
    expect('error' in res).toBe(true)
  })

  it('non-numeric value for pos', () => {
    const res = select_atoms('pos:z>abc', make_structure())
    expect('error' in res).toBe(true)
  })

  it('bonded @-index out of range', () => {
    const res = select_atoms('bonded:@99', make_structure())
    expect('error' in res).toBe(true)
  })

  it('sphere @-index out of range', () => {
    const res = select_atoms('sphere:@99;2.0', make_structure())
    expect('error' in res).toBe(true)
  })

  it('dangling operator', () => {
    const res = select_atoms('elem:O AND', make_structure())
    expect('error' in res).toBe(true)
  })

  it('leading operator', () => {
    const res = select_atoms('AND elem:O', make_structure())
    expect('error' in res).toBe(true)
  })

  it('error result is total: never throws on garbage', () => {
    expect(() => select_atoms(')(&|!@#$', make_structure())).not.toThrow()
    expect(() => select_atoms('@@@@', make_structure())).not.toThrow()
  })
})

// --- pathological input (no catastrophic backtracking / hang) -----------

describe('pathological / long queries do not hang', () => {
  it('very long deeply-nested parens resolves quickly', () => {
    const depth = 2000
    const query = '('.repeat(depth) + 'elem:O' + ')'.repeat(depth)
    const start = Date.now()
    const res = select_atoms(query, make_structure())
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000)
    // Either resolves to the O set or rejects with an error (depth guard) —
    // both are fine; the requirement is it must NOT hang or throw.
    if (!('error' in res)) {
      expect([...res.indices].sort((a, b) => a - b)).toEqual([0, 3, 6])
    }
  })

  it('very long OR chain resolves quickly', () => {
    const query = Array(1000).fill('elem:O').join(' OR ')
    const start = Date.now()
    const res = select_atoms(query, make_structure())
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000)
    expect('error' in res).toBe(false)
    if (!('error' in res)) {
      expect([...res.indices].sort((a, b) => a - b)).toEqual([0, 3, 6])
    }
  })

  it('long unbalanced garbage returns error fast (no backtracking blowup)', () => {
    const query = 'elem:O AND '.repeat(500) + '('
    const start = Date.now()
    const res = select_atoms(query, make_structure())
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000)
    expect('error' in res).toBe(true)
  })
})

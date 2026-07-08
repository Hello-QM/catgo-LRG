type MolfileStructure = {
  sites: Array<{
    species: Array<{ element: string; occu: number }>
    abc: number[]
    xyz: number[]
    label: string
    properties: Record<string, never>
  }>
  charge: number
  spin_multiplicity: number
}

export function parse_molfile(text: string): MolfileStructure | null {
  const lines = text.replace(/\r\n/g, `\n`).split(`\n`)
  if (lines.length < 4) return null
  const counts = lines[3] ?? ``
  const atom_count = Number.parseInt(counts.slice(0, 3).trim(), 10)
  if (!Number.isFinite(atom_count) || atom_count <= 0) return null
  const sites = []
  for (let i = 0; i < atom_count; i++) {
    const line = lines[4 + i] ?? ``
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) return null
    const xyz = parts.slice(0, 3).map(Number)
    const element = parts[3]
    if (xyz.some(n => !Number.isFinite(n)) || !/^[A-Z][a-z]?$/.test(element)) return null
    sites.push({
      species: [{ element, occu: 1 }],
      abc: [0, 0, 0],
      xyz,
      label: element,
      properties: {},
    })
  }
  return { sites, charge: 0, spin_multiplicity: 1 }
}

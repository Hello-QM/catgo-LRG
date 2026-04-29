import { elem_symbols, type ElementSymbol, type Vec3 } from '$lib'
import type { ParsedStructure } from './common'

// Parse MOL2 (Tripos Mol2) file format
export function parse_mol2(content: string): ParsedStructure | null {
  try {
    const lines = content.trim().split(/\r?\n/)
    const sites: import('$lib').Site[] = []

    let in_atoms_section = false
    for (const line of lines) {
      const trimmed = line.trim()

      // Start of ATOM section
      if (trimmed.startsWith(`@<TRIPOS>ATOM`)) {
        in_atoms_section = true
        continue
      }

      // End of ATOM section (next section starts)
      if (trimmed.startsWith(`@<TRIPOS>`)) {
        if (in_atoms_section && trimmed !== `@<TRIPOS>ATOM`) {
          in_atoms_section = false
        }
        continue
      }

      // Parse atom lines
      if (in_atoms_section && trimmed && !trimmed.startsWith(`#`)) {
        const tokens = trimmed.split(/\s+/)
        // MOL2 atom format: atom_id atom_name x y z atom_type ...
        if (tokens.length >= 6) {
          const x = parseFloat(tokens[2])
          const y = parseFloat(tokens[3])
          const z = parseFloat(tokens[4])

          if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
            // Extract element symbol from atom name (e.g., "C1" -> "C", "O2" -> "O")
            let atom_name = tokens[1]
            let element = atom_name?.[0] || `X`

            // If atom_type has more info (e.g., "C.3", "O.2"), use first char
            const atom_type = tokens[5]
            if (atom_type && /^[A-Z][a-z]?/.test(atom_type)) {
              element = atom_type[0]
            }

            // Validate element symbol
            if (!elem_symbols.includes(element as ElementSymbol)) {
              // Try to extract from atom_name
              const match = atom_name?.match(/^([A-Z][a-z]?)/)
              if (match && elem_symbols.includes(match[1] as ElementSymbol)) {
                element = match[1]
              }
            }

            sites.push({
              species: [{ element: element as ElementSymbol, occu: 1 }],
              abc: [0, 0, 0] as Vec3,
              xyz: [x, y, z] as Vec3,
              label: atom_name || element,
              properties: {},
            })
          }
        }
      }
    }

    if (sites.length === 0) {
      console.error(`No atoms found in MOL2 file`)
      return null
    }

    // MOL2 is typically for molecules without periodic boundary
    return { sites }
  } catch (error) {
    console.error(`Error parsing MOL2 file:`, error)
    return null
  }
}

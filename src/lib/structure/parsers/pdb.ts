import { elem_symbols, type ElementSymbol, type Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'
import type { ParsedStructure } from './common'

// Parse PDB (Protein Data Bank) file format
export function parse_pdb(content: string): ParsedStructure | null {
  try {
    const lines = content.trim().split(/\r?\n/)
    const sites: import('$lib').Site[] = []

    for (const line of lines) {
      // Only parse ATOM and HETATM records
      if (!line.startsWith(`ATOM`) && !line.startsWith(`HETATM`)) {
        continue
      }

      // PDB format is fixed-width:
      // Columns 1-6: Record name (ATOM/HETATM)
      // 7-11: Atom serial number
      // 13-16: Atom name
      // 17: Alternate location indicator
      // 18-20: Residue name
      // 22: Chain identifier
      // 23-26: Residue sequence number
      // 27: Code for insertions of residues
      // 31-38: X coordinate (Å)
      // 39-46: Y coordinate (Å)
      // 47-54: Z coordinate (Å)
      // ...

      if (line.length < 54) continue

      const atom_name = line.substring(12, 16).trim()
      const x_str = line.substring(30, 38).trim()
      const y_str = line.substring(38, 46).trim()
      const z_str = line.substring(46, 54).trim()

      const x = parseFloat(x_str)
      const y = parseFloat(y_str)
      const z = parseFloat(z_str)

      if (isNaN(x) || isNaN(y) || isNaN(z)) continue

      // Extract element symbol - usually first character of atom name
      // or first 2 characters if second is lowercase (e.g., "Fe", "Ca")
      let element = `X`
      if (atom_name.length > 0) {
        // Check for two-letter elements (case sensitive: first uppercase, second lowercase)
        if (atom_name.length >= 2 && /^[A-Z][a-z]$/.test(atom_name.substring(0, 2))) {
          element = atom_name.substring(0, 2)
        } else {
          element = atom_name[0]
        }
      }

      // Validate element symbol
      if (!elem_symbols.includes(element as ElementSymbol)) {
        // Try to find valid element in atom name
        for (let i = 1; i <= atom_name.length; i++) {
          const candidate = atom_name.substring(0, i)
          if (elem_symbols.includes(candidate as ElementSymbol)) {
            element = candidate
            break
          }
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

    if (sites.length === 0) {
      console.error(`No atoms found in PDB file`)
      return null
    }

    // Check for CRYST1 record for unit cell information
    for (const line of lines) {
      if (line.startsWith(`CRYST1`)) {
        // CRYST1 format: a b c alpha beta gamma spacegroup
        const a = parseFloat(line.substring(6, 15))
        const b = parseFloat(line.substring(15, 24))
        const c = parseFloat(line.substring(24, 33))
        const alpha = parseFloat(line.substring(33, 40))
        const beta = parseFloat(line.substring(40, 47))
        const gamma = parseFloat(line.substring(47, 54))

        if (!isNaN(a) && !isNaN(b) && !isNaN(c)) {
          // Convert to lattice matrix using standard crystallographic convention
          const alpha_rad = (alpha * Math.PI) / 180
          const beta_rad = (beta * Math.PI) / 180
          const gamma_rad = (gamma * Math.PI) / 180

          const omega = a * b * c *
            Math.sqrt(1 - Math.cos(alpha_rad) ** 2 - Math.cos(beta_rad) ** 2 - Math.cos(gamma_rad) ** 2 +
              2 * Math.cos(alpha_rad) * Math.cos(beta_rad) * Math.cos(gamma_rad))

          const lattice_matrix: Matrix3x3 = [
            [a, b * Math.cos(gamma_rad), c * Math.cos(beta_rad)],
            [0, b * Math.sin(gamma_rad), c * (Math.cos(alpha_rad) - Math.cos(beta_rad) * Math.cos(gamma_rad)) / Math.sin(gamma_rad)],
            [0, 0, omega / (a * b * Math.sin(gamma_rad))],
          ]

          const calculated_lattice_params = math.calc_lattice_params(lattice_matrix)

          return {
            sites,
            lattice: {
              matrix: lattice_matrix,
              ...calculated_lattice_params,
            },
          }
        }
      }
    }

    // No CRYST1 record - return as molecule
    return { sites }
  } catch (error) {
    console.error(`Error parsing PDB file:`, error)
    return null
  }
}

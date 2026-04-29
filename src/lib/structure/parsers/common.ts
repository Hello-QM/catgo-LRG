import { elem_symbols, type ElementSymbol, type Vec3 } from '$lib'
import type { Matrix3x3 } from '$lib/math'
import * as math from '$lib/math'

export type { Matrix3x3 }
export { math, elem_symbols, type ElementSymbol, type Vec3 }

export interface ParsedStructure {
  sites: import('$lib').Site[]
  lattice?: {
    matrix: Matrix3x3
    a: number
    b: number
    c: number
    alpha: number
    beta: number
    gamma: number
    volume: number
  }
}

// Normalize scientific notation in coordinate strings
// Handles eEdD and *^ notation variants
export function normalize_scientific_notation(str: string): string {
  return str
    .toLowerCase()
    .replace(/d/g, `e`) // Replace D/d with e
    .replace(/\*\^/g, `e`) // Replace *^ with e
}

// Parse a coordinate value that might be in various scientific notation formats
export function parse_coordinate(str: string): number {
  const normalized = normalize_scientific_notation(str.trim())
  const value = parseFloat(normalized)
  if (isNaN(value)) throw new Error(`Invalid coordinate value: ${str}`)
  return value
}

// Parse coordinates from a line, handling malformed formatting
export function parse_coordinate_line(line: string): number[] {
  let tokens = line.trim().split(/\s+/)

  // Handle malformed coordinates like "1.0-2.0-3.0" (missing spaces)
  if (tokens.length < 3) {
    // Insert a space only for subtraction between numbers, not exponent signs (e/E)
    const sanitized = line
      .trim()
      // Add space when '-' follows a digit and precedes a digit or dot
      .replace(/(\d)-(?=[\d.])/g, `$1 -`)
      // Revert accidental spaces after exponent markers
      .replace(/([eE])\s-\s/g, `$1-`)
    tokens = sanitized.split(/\s+/)
  }

  if (tokens.length < 3) throw new Error(`Insufficient coordinates in line: ${line}`)

  return tokens.slice(0, 3).map(parse_coordinate)
}

// Validate element symbol and provide fallback
export function validate_element_symbol(symbol: string, index: number): ElementSymbol {
  // Clean symbol (remove suffixes like _pv, /hash)
  const clean_symbol = symbol.split(/[_/]/)[0]

  if (elem_symbols && elem_symbols.includes(clean_symbol as ElementSymbol)) {
    return clean_symbol as ElementSymbol
  }

  // VASP pseudo-hydrogen labels: H.66, H1.75, H.25, H1.25, etc.
  // Strip trailing charge number to get the base element
  const base_element = clean_symbol.replace(/[\d.]+$/, ``)
  if (base_element && elem_symbols?.includes(base_element as ElementSymbol)) {
    return base_element as ElementSymbol
  }

  // Fallback to default elements by atomic number
  const fallback_elements = [`H`, `He`, `Li`, `Be`, `B`, `C`, `N`, `O`, `F`, `Ne`]
  const fallback = fallback_elements[index % fallback_elements.length]
  console.warn(
    `Invalid element symbol '${symbol}', using fallback '${fallback}'`,
  )
  return fallback as ElementSymbol
}

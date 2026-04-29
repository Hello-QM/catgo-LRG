// Parser for Bader charge analysis output files (ACF.dat)

export function parse_acf_dat(content: string): number[] {
  const charges: number[] = []
  for (const line of content.split(`\n`)) {
    const trimmed = line.trim()
    // Skip empty lines, header/separator lines, and footer lines
    if (
      !trimmed ||
      trimmed.startsWith(`#`) ||
      trimmed.startsWith(`-`) ||
      /^[A-Z]/.test(trimmed)
    ) continue
    const cols = trimmed.split(/\s+/)
    if (cols.length >= 5) {
      const charge = parseFloat(cols[4])
      if (!isNaN(charge)) charges.push(charge)
    }
  }
  return charges
}

export function is_acf_dat(content: string, filename: string): boolean {
  // Check filename
  if (/ACF/i.test(filename)) return true
  // Check header for CHARGE column
  const first_lines = content.split(`\n`).slice(0, 5).join(`\n`)
  return /CHARGE/.test(first_lines)
}

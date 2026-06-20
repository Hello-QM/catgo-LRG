// Build the "Electronic structure" rows shown in import preview modals,
// from whatever electronic-property fields a database happens to expose.
// One source of truth so MP, OPTIMADE, and any future provider render the
// same way (and degrade to "—" identically when fields are missing).

import type { PreviewDetailRow } from './OptimadePreviewModal.svelte'

export interface ElectronicProps {
  band_gap?: number | null
  is_metal?: boolean | null
  efermi?: number | null
  cbm?: number | null
  vbm?: number | null
  has_dos?: boolean | null
  has_bandstructure?: boolean | null
  magnetic_ordering?: string | null
}

export interface ElectronicLabels {
  band_gap: string
  is_metal: string
  efermi: string
  cbm: string
  vbm: string
  dos_available: string
  bands_available: string
  magnetic_ordering: string
  /** Yes/no for the "Metal:" row. */
  yes: string
  no: string
  /** Available/not available for "DOS:" and "Bands:" rows. */
  available: string
  not_available: string
  metallic: string
  missing: string
}

const DEFAULT_LABELS: ElectronicLabels = {
  band_gap: `Band gap:`,
  is_metal: `Metal:`,
  efermi: `Fermi energy:`,
  cbm: `CBM:`,
  vbm: `VBM:`,
  dos_available: `DOS:`,
  bands_available: `Bands:`,
  magnetic_ordering: `Magnetic order:`,
  yes: `Yes`,
  no: `No`,
  available: `available`,
  not_available: `not available`,
  metallic: `metallic`,
  missing: `—`, // em dash
}

function fmt_eV(v: number | null | undefined): string | null {
  if (typeof v !== `number` || !Number.isFinite(v)) return null
  // 3 decimals is the MP convention; trim trailing zeros for readability.
  return `${v.toFixed(3).replace(/\.?0+$/, ``)} eV`
}

function fmt_bool_available(v: boolean | null | undefined, labels: ElectronicLabels): string | null {
  if (v === true) return labels.available
  if (v === false) return labels.not_available
  return null
}

// MP's `ordering` enum → human label. Pass anything else through verbatim so
// providers with their own vocabulary (or future MP additions) aren't lost.
function fmt_magnetic_ordering(v: string | null | undefined): string | null {
  if (!v) return null
  const map: Record<string, string> = {
    FM: `Ferromagnetic`,
    AFM: `Antiferromagnetic`,
    FiM: `Ferrimagnetic`,
    NM: `Nonmagnetic`,
    Unknown: `Unknown`,
  }
  return map[v] ?? v
}

/**
 * Build preview rows for the electronic-structure block.
 *
 * Always returns the same 8 rows in the same order so the modal layout is
 * stable across databases. Missing fields render as labels.missing ("—").
 */
export function buildElectronicRows(
  props: ElectronicProps,
  labels: Partial<ElectronicLabels> = {},
): PreviewDetailRow[] {
  const L = { ...DEFAULT_LABELS, ...labels }

  // band_gap row: if the material is metallic show "metallic" (band gap of 0
  // is conventionally reported but "metallic" reads better in a preview).
  let gap_value: string
  if (props.is_metal === true) {
    gap_value = L.metallic
  } else {
    gap_value = fmt_eV(props.band_gap ?? null) ?? L.missing
  }

  return [
    { label: L.band_gap, value: gap_value },
    {
      label: L.is_metal,
      value: props.is_metal === true ? L.yes : props.is_metal === false ? L.no : L.missing,
    },
    { label: L.efermi, value: fmt_eV(props.efermi ?? null) ?? L.missing },
    { label: L.cbm, value: fmt_eV(props.cbm ?? null) ?? L.missing },
    { label: L.vbm, value: fmt_eV(props.vbm ?? null) ?? L.missing },
    { label: L.dos_available, value: fmt_bool_available(props.has_dos ?? null, L) ?? L.missing },
    {
      label: L.bands_available,
      value: fmt_bool_available(props.has_bandstructure ?? null, L) ?? L.missing,
    },
    {
      label: L.magnetic_ordering,
      value: fmt_magnetic_ordering(props.magnetic_ordering ?? null) ?? L.missing,
    },
  ]
}

// Adapters: normalize a payload from a specific database into ElectronicProps
// so callers don't sprinkle field-name knowledge across the codebase.

export function electronic_props_from_mp(
  summary: {
    band_gap?: number
    is_metal?: boolean
    efermi?: number
    cbm?: number
    vbm?: number
    ordering?: string
    has_props?: Record<string, boolean>
  } | null | undefined,
): ElectronicProps {
  if (!summary) return {}
  return {
    band_gap: summary.band_gap,
    is_metal: summary.is_metal,
    efermi: summary.efermi,
    cbm: summary.cbm,
    vbm: summary.vbm,
    has_dos: summary.has_props?.dos,
    has_bandstructure: summary.has_props?.bandstructure,
    magnetic_ordering: summary.ordering,
  }
}

export function electronic_props_from_optimade(
  details: {
    band_gap?: number
    is_metal?: boolean
    efermi?: number
    cbm?: number
    vbm?: number
    has_dos?: boolean
    has_bandstructure?: boolean
    magnetic_ordering?: string
  } | null | undefined,
): ElectronicProps {
  if (!details) return {}
  return {
    band_gap: details.band_gap,
    is_metal: details.is_metal,
    efermi: details.efermi,
    cbm: details.cbm,
    vbm: details.vbm,
    has_dos: details.has_dos,
    has_bandstructure: details.has_bandstructure,
    magnetic_ordering: details.magnetic_ordering,
  }
}

import { describe, it, expect } from 'vitest'
import {
  buildElectronicRows,
  electronic_props_from_mp,
  electronic_props_from_optimade,
} from '../electronic_preview'

const by_label = (rows: { label: string; value: string }[]) =>
  Object.fromEntries(rows.map((r) => [r.label, r.value]))

describe('buildElectronicRows', () => {
  it('renders all 8 rows in stable order even when empty', () => {
    const rows = buildElectronicRows({})
    expect(rows.map((r) => r.label)).toEqual([
      'Band gap:',
      'Metal:',
      'Fermi energy:',
      'CBM:',
      'VBM:',
      'DOS:',
      'Bands:',
      'Magnetic order:',
    ])
    // All values fall back to em-dash when the database supplies nothing.
    for (const r of rows) expect(r.value).toBe('—')
  })

  it('formats a full MP-style payload with eV units and ordering enum', () => {
    const rows = buildElectronicRows({
      band_gap: 1.234,
      is_metal: false,
      efermi: 4.5,
      cbm: 5.1,
      vbm: 3.87654,
      has_dos: true,
      has_bandstructure: true,
      magnetic_ordering: 'AFM',
    })
    const b = by_label(rows)
    expect(b['Band gap:']).toBe('1.234 eV')
    expect(b['Metal:']).toBe('No')
    expect(b['Fermi energy:']).toBe('4.5 eV')
    expect(b['CBM:']).toBe('5.1 eV')
    expect(b['VBM:']).toBe('3.877 eV') // trailing zero trimmed after rounding
    expect(b['DOS:']).toBe('available')
    expect(b['Bands:']).toBe('available')
    expect(b['Magnetic order:']).toBe('Antiferromagnetic')
  })

  it('shows "metallic" in the band-gap slot when is_metal=true', () => {
    const rows = buildElectronicRows({ is_metal: true, band_gap: 0 })
    const b = by_label(rows)
    expect(b['Band gap:']).toBe('metallic')
    expect(b['Metal:']).toBe('Yes')
  })

  it('renders partial payload with mixed missing fields', () => {
    const rows = buildElectronicRows({
      band_gap: 0.5,
      is_metal: false,
      has_dos: false, // explicit "not available"
      // efermi/cbm/vbm/has_bandstructure/ordering all missing
    })
    const b = by_label(rows)
    expect(b['Band gap:']).toBe('0.5 eV')
    expect(b['Metal:']).toBe('No')
    expect(b['Fermi energy:']).toBe('—')
    expect(b['CBM:']).toBe('—')
    expect(b['VBM:']).toBe('—')
    expect(b['DOS:']).toBe('not available')
    expect(b['Bands:']).toBe('—')
    expect(b['Magnetic order:']).toBe('—')
  })

  it('honours custom label overrides (i18n path)', () => {
    const rows = buildElectronicRows(
      { is_metal: true, has_dos: true, magnetic_ordering: 'FM' },
      {
        band_gap: '带隙：',
        is_metal: '金属性：',
        dos_available: '态密度：',
        magnetic_ordering: '磁有序：',
        metallic: '金属性',
        yes: '是',
        no: '否',
        available: '可用',
        not_available: '不可用',
        missing: '—',
      },
    )
    const b = by_label(rows)
    expect(b['带隙：']).toBe('金属性')
    expect(b['金属性：']).toBe('是')
    expect(b['态密度：']).toBe('可用')
    expect(b['磁有序：']).toBe('Ferromagnetic') // ordering enum is provider data, not localized
  })

  it('passes through unknown ordering values verbatim', () => {
    const rows = buildElectronicRows({ magnetic_ordering: 'SomeNewOrdering' })
    expect(by_label(rows)['Magnetic order:']).toBe('SomeNewOrdering')
  })

  it('treats null/undefined and NaN as missing, never crashes', () => {
    const rows = buildElectronicRows({
      band_gap: null as any,
      is_metal: null as any,
      efermi: Number.NaN,
      cbm: undefined,
      vbm: Infinity, // not finite → missing
    })
    const b = by_label(rows)
    expect(b['Band gap:']).toBe('—')
    expect(b['Metal:']).toBe('—')
    expect(b['Fermi energy:']).toBe('—')
    expect(b['CBM:']).toBe('—')
    expect(b['VBM:']).toBe('—')
  })
})

describe('electronic_props_from_mp', () => {
  it('extracts dos/bandstructure from has_props', () => {
    const props = electronic_props_from_mp({
      band_gap: 1.1,
      is_metal: false,
      efermi: 5.0,
      cbm: 5.6,
      vbm: 4.5,
      ordering: 'NM',
      has_props: { dos: true, bandstructure: true, magnetism: false },
    })
    expect(props.band_gap).toBe(1.1)
    expect(props.efermi).toBe(5.0)
    expect(props.has_dos).toBe(true)
    expect(props.has_bandstructure).toBe(true)
    expect(props.magnetic_ordering).toBe('NM')
  })

  it('returns empty object for null/undefined input', () => {
    expect(electronic_props_from_mp(null)).toEqual({})
    expect(electronic_props_from_mp(undefined)).toEqual({})
  })
})

describe('electronic_props_from_optimade', () => {
  it('passes ProviderDetails fields straight through', () => {
    const props = electronic_props_from_optimade({
      band_gap: 2.3,
      is_metal: false,
      efermi: 3.1,
      magnetic_ordering: 'FM',
    })
    expect(props.band_gap).toBe(2.3)
    expect(props.efermi).toBe(3.1)
    expect(props.magnetic_ordering).toBe('FM')
  })

  it('returns empty object for null/undefined input', () => {
    expect(electronic_props_from_optimade(null)).toEqual({})
    expect(electronic_props_from_optimade(undefined)).toEqual({})
  })
})

describe('end-to-end: OPTIMADE attrs → ElectronicProps → rows', () => {
  // Lock in the realistic shape MP's OPTIMADE adapter returns when the
  // search/fetch endpoint requests _mp_* extras (the bug we just fixed).
  it('renders Band gap / Metal rows for a metallic MP structure (Mg, mp-1056702)', async () => {
    const { extract_provider_details } = await import('../../api/optimade')
    const mp_mg_attrs = {
      chemical_formula_reduced: 'Mg',
      chemical_formula_descriptive: 'Mg',
      nsites: 1,
      _mp_band_gap: 0,
      _mp_is_metal: true,
    }
    const pd = extract_provider_details(mp_mg_attrs as Record<string, unknown>)
    const elec = electronic_props_from_optimade(pd)
    const rows = buildElectronicRows(elec)
    const b = by_label(rows)
    expect(b['Band gap:']).toBe('metallic')
    expect(b['Metal:']).toBe('Yes')
    // Fields MP's OPTIMADE adapter doesn't expose should fall through to —.
    expect(b['Fermi energy:']).toBe('—')
    expect(b['CBM:']).toBe('—')
    expect(b['VBM:']).toBe('—')
  })

  it('renders a richer row set when MP REST summary is available', () => {
    const elec = electronic_props_from_mp({
      band_gap: 1.234,
      is_metal: false,
      efermi: 4.5,
      cbm: 5.1,
      vbm: 3.877,
      ordering: 'AFM',
      has_props: { dos: true, bandstructure: true },
    })
    const b = by_label(buildElectronicRows(elec))
    expect(b['Band gap:']).toBe('1.234 eV')
    expect(b['Metal:']).toBe('No')
    expect(b['Fermi energy:']).toBe('4.5 eV')
    expect(b['Magnetic order:']).toBe('Antiferromagnetic')
    expect(b['DOS:']).toBe('available')
    expect(b['Bands:']).toBe('available')
  })
})

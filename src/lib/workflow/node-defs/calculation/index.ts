import type { NodeDefinition } from '../../workflow-types'
import { GEO_OPT_NODE } from './geo-opt'
import { SINGLE_POINT_NODE } from './single-point'
import { CELL_OPT_NODE } from './cell-opt'
import { MD_NODE } from './md'
import { FREQ_NODE } from './freq'
import { TS_SEARCH_NODE } from './ts-search'
import { IRC_NODE } from './irc'
import { QE_SCF_NODE } from './qe-scf'
import { QE_RELAX_NODE } from './qe-relax'
import { QE_BANDS_NODE } from './qe-bands'
import { QE_DOS_NODE } from './qe-dos'
import { QE_PHONON_NODE } from './qe-phonon'
import { QCHEM_STATIC_NODE } from './qchem-static'
import { QCHEM_OPT_NODE } from './qchem-opt'
import { QCHEM_TS_NODE } from './qchem-ts'
import { SLOW_GROWTH_NODE } from './slow-growth'
import { KMC_NODE } from './kmc'
import { MD_MINIMIZE_NODE } from './md-minimize'

export const CALCULATION_NODES: Record<string, NodeDefinition> = {
  geo_opt: GEO_OPT_NODE,
  single_point: SINGLE_POINT_NODE,
  cell_opt: CELL_OPT_NODE,
  md: MD_NODE,
  freq: FREQ_NODE,
  ts_search: TS_SEARCH_NODE,
  irc: IRC_NODE,
  qe_scf: QE_SCF_NODE,
  qe_relax: QE_RELAX_NODE,
  qe_bands: QE_BANDS_NODE,
  qe_dos: QE_DOS_NODE,
  qe_phonon: QE_PHONON_NODE,
  qchem_static: QCHEM_STATIC_NODE,
  qchem_opt: QCHEM_OPT_NODE,
  qchem_ts: QCHEM_TS_NODE,
  slow_growth: SLOW_GROWTH_NODE,
  kmc: KMC_NODE,
  md_minimize: MD_MINIMIZE_NODE,
}

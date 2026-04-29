import type { NodeDefinition } from '../../workflow-types'

import { dos_analysis } from './dos-analysis'
import { cohp_analysis } from './cohp-analysis'
import { md_analysis } from './md-analysis'
import { charge_analysis } from './charge-analysis'
import { electronic } from './electronic'
import { free_energy } from './free-energy'
import { gibbs_energy } from './gibbs-energy'
import { phonon_analysis } from './phonon-analysis'
import { eos_analysis } from './eos-analysis'
import { elastic_analysis } from './elastic-analysis'
import { surface_energy } from './surface-energy'
import { wulff_construction } from './wulff-construction'
import { adsorption_energy } from './adsorption-energy'
import { coverage_analysis } from './coverage-analysis'

export const ANALYSIS_NODES: Record<string, NodeDefinition> = {
  dos_analysis,
  cohp_analysis,
  md_analysis,
  charge_analysis,
  electronic,
  free_energy,
  gibbs_energy,
  phonon_analysis,
  eos_analysis,
  elastic_analysis,
  surface_energy,
  wulff_construction,
  adsorption_energy,
  coverage_analysis,
}

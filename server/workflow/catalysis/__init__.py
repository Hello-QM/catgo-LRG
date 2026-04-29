"""Catalysis analysis: thermodynamic corrections and reaction overpotentials."""

from workflow.catalysis.free_energy import (
    gibbs_free_energy,
    compute_zpe,
    compute_entropy_correction,
)
from workflow.catalysis.oer import (
    compute_oer_overpotential,
    compute_adsorption_free_energy,
    estimate_dG_OOH_from_scaling,
)
from workflow.catalysis.co2rr import compute_co2rr_limiting_potential
from workflow.catalysis.nrr import compute_nrr_overpotential
from workflow.catalysis.volcano import generate_volcano_data
from workflow.catalysis.descriptors import (
    compute_d_band_center,
    compute_coordination_number,
    compute_surface_strain,
)

"""catgo_dos - Electronic structure DOS analysis library.

Reads VASP HDF5 output (vaspout.h5) and computes:
- Total DOS and projected DOS (PDOS) for arbitrary atom/orbital selections
- DOS integration and cumulative DOS
- D-band center, width, filling, skewness, kurtosis
- Band edge detection

Quick start
-----------
>>> from catgo_dos import read_vaspout_h5, compute_pdos, analyze_d_band
>>> from catgo_dos import select_by_element
>>>
>>> data = read_vaspout_h5("vaspout.h5")
>>> mo_atoms = select_by_element(data.elements, "Mo")
>>> pdos = compute_pdos(data, mo_atoms, "d", sigma=0.05)
>>> props = analyze_d_band(data, mo_atoms)
>>> print(f"d-band center = {props.center.eps_rel:.4f} eV")
"""

__version__ = "0.1.0"

# IO
from .io import VaspData, read_vaspout_h5, read_procar, read_poscar, extract_efermi_outcar, write_contcar

# Orbital mapping
from .orbital import (
    channel_indices,
    channel_map,
    channel_name_map,
    d_indices,
    f_indices,
    p_indices,
    parse_orbital_spec,
    s_indices,
)

# Atom selection
from .selection import (
    combine_selections,
    select_bottom_layer,
    select_by_element,
    select_by_index,
    select_top_layer,
    select_within_radius,
    select_within_radius_of_atom,
)

# PDOS computation
from .pdos import (
    PDOSResult,
    compute_pdos,
    compute_pdos_groups,
    compute_total_dos,
    cumulative_dos,
    find_band_edges,
    gaussian_broaden,
    integrate_dos,
)

# D-band analysis
from .dband import (
    DBandCenter,
    DBandFilling,
    DBandMoments,
    DBandProperties,
    DBandWidth,
    analyze_d_band,
    compute_d_band_edges,
    compute_d_center,
    compute_d_filling,
    compute_d_moments,
    compute_d_width,
)

__all__ = [
    # IO
    "VaspData",
    "read_vaspout_h5",
    "read_procar",
    "read_poscar",
    "extract_efermi_outcar",
    "write_contcar",
    # Orbital
    "channel_map",
    "channel_indices",
    "channel_name_map",
    "d_indices",
    "s_indices",
    "p_indices",
    "f_indices",
    "parse_orbital_spec",
    # Selection
    "select_by_element",
    "select_by_index",
    "select_top_layer",
    "select_bottom_layer",
    "select_within_radius",
    "select_within_radius_of_atom",
    "combine_selections",
    # PDOS
    "PDOSResult",
    "gaussian_broaden",
    "compute_pdos",
    "compute_total_dos",
    "compute_pdos_groups",
    "integrate_dos",
    "cumulative_dos",
    "find_band_edges",
    # D-band
    "DBandCenter",
    "DBandWidth",
    "DBandFilling",
    "DBandMoments",
    "DBandProperties",
    "compute_d_center",
    "compute_d_width",
    "compute_d_filling",
    "compute_d_moments",
    "compute_d_band_edges",
    "analyze_d_band",
]

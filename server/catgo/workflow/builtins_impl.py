"""Implementation functions for built-in local task types.

Separated from builtins.py to keep each file under 150 lines.
These are called by the @task-decorated functions in builtins.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


# Single source of truth for adsorbate species: server/data/adsorbates.json,
# which is also imported by the frontend (src/lib/api/adsorbate.ts) and used
# by the MCP `list_presets` action. Add new species there and they propagate
# to all surfaces. Formula keys in the JSON are ASCII (H2O, NH2NH2, …); the
# UI's Unicode subscript variants are kept in a separate `display_formula`
# field and are not used as lookup keys.
_ADSORBATES_JSON_PATH = Path(__file__).parent.parent.parent / "data" / "adsorbates.json"


def _load_adsorbate_library() -> dict[str, tuple[list[str], list[list[float]]]]:
    try:
        data = json.loads(_ADSORBATES_JSON_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    library: dict[str, tuple[list[str], list[list[float]]]] = {}
    for group in data.get("groups", []):
        for preset in group.get("presets", []):
            formula_upper = str(preset["formula"]).upper()
            elements = [a["symbol"] for a in preset["atoms"]]
            coords = [list(a["position"]) for a in preset["atoms"]]
            # First occurrence wins — order in JSON puts Common group first
            # so e.g. "H" / "OH" canonical defs come from the Common group
            # rather than reaction-specific duplicates.
            library.setdefault(formula_upper, (elements, coords))
    return library


def run_structure_input(structure: Any = None, structure_json: Any = None, **params) -> dict:
    """Pass-through: accept string or dict, return {"structure": json_string}.

    Accepts both 'structure' and 'structure_json' keys — the frontend stores
    structures in node params as 'structure_json', while the V1 API uses 'structure'.
    """
    if structure is None and structure_json is not None:
        structure = structure_json
    if structure is None:
        return {"structure": None}
    if isinstance(structure, str):
        return {"structure": structure}
    return {"structure": json.dumps(structure)}


def run_gibbs_energy(
    energy: Any = None,
    frequencies: Any = None,
    phase: str = "adsorbed",
    temperature: float = 298.15,
    freq_cutoff: float = 50,
    pressure_atm: float = 1.0,
    n_unpaired: int = 0,
    system_name: str = "",
    **params,
) -> dict:
    """Compute Gibbs free energy: G = E_DFT + ZPE - TS."""
    if energy is None:
        return {"gibbs": None, "zpe": None}

    e_dft = float(energy)

    # Parse frequencies
    real_freqs_cm: list[float] = []
    imag_freqs_cm: list[float] = []
    if frequencies:
        freq_data = json.loads(frequencies) if isinstance(frequencies, str) else frequencies
        if isinstance(freq_data, list):
            for f in freq_data:
                if isinstance(f, dict):
                    real_freqs_cm.append(float(f.get("frequency_cm", 0)))
                else:
                    val = float(f)
                    if val < 0:
                        imag_freqs_cm.append(abs(val))
                    else:
                        real_freqs_cm.append(val)

    # Import gibbs_calculator directly to avoid utils/__init__.py pulling in ase/numpy
    import importlib.util, os
    _spec = importlib.util.spec_from_file_location(
        "gibbs_calculator",
        os.path.join(os.path.dirname(__file__), "..", "..", "utils", "gibbs_calculator.py"),
    )
    _mod = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_mod)
    calc_adsorbed, calc_gas = _mod.calc_adsorbed, _mod.calc_gas

    if phase == "gas":
        gibbs_result = calc_gas(
            real_freqs_cm, imag_freqs_cm, [], [], [],
            T=temperature, P=pressure_atm * 101325.0,
            n_unpaired=n_unpaired,
        )
    else:
        gibbs_result = calc_adsorbed(
            real_freqs_cm, imag_freqs_cm,
            T=temperature, freq_cutoff=freq_cutoff,
        )

    zpe = gibbs_result["zpe_ev"]
    g_corr = gibbs_result["g_corr_ev"]
    g_total = e_dft + g_corr

    return {
        "gibbs": g_total,
        "zpe": zpe,
        "energy": e_dft,
        "g_corr": g_corr,
        "ts_correction": gibbs_result["h_corr_ev"] - g_corr,
        "system_name": system_name,
    }


def run_slab_gen(
    structure: Any = None,
    miller: tuple = (1, 1, 0),
    layers: int = 4,
    vacuum: float = 15.0,
    thickness: float = 10.0,
    **params,
) -> dict:
    """Generate slab from bulk structure using ferrox (Rust).

    Supercell expansion and bottom-layer freezing are applied to BOTH the ferrox
    and pymatgen paths (previously the ferrox path returned early, silently
    dropping supercell/layers/freeze). Freezing is written as a
    ``selective_dynamics`` site property so the constraint is stored ON the
    structure \u2014 visible in the 3D viewer and inherited by downstream nodes \u2014
    rather than only materializing in the VASP POSCAR at run time.
    """
    # Frontend contract (SlabGenPreview.svelte: "When locked, preview shows the
    # saved structure_json instead of regenerating"): a LOCKED slab_gen node has
    # already finalized its slab into `structure_json` — possibly hand-edited in
    # the 3D viewer (atoms removed, bottom layers frozen via selective_dynamics).
    # Return it verbatim instead of rebuilding from bulk+params, which diverges
    # in atom count and silently drops the user's selective_dynamics (the slab
    # the user saw on screen must be exactly what is sent to HPC).
    if params.get("slab_locked") and params.get("structure_json"):
        sj = params["structure_json"]
        return {"structure": sj if isinstance(sj, str) else json.dumps(sj)}

    if structure is None:
        raise ValueError("slab_gen requires a structure input")

    from pymatgen.core import Structure as PmgStructure

    struct_str = structure if isinstance(structure, str) else json.dumps(structure)
    # Accept both tuple/list (1,1,1) and string "1,1,1" for miller indices
    if isinstance(miller, str):
        miller = tuple(int(x) for x in miller.replace(" ", "").split(","))
    h, k, l = (int(m) for m in miller)

    # Convert requested layer count -> physical thickness so `layers` is honored
    # (the ferrox API is thickness-based).
    eff_thickness = thickness
    try:
        _bulk = PmgStructure.from_dict(
            json.loads(struct_str) if isinstance(struct_str, str) else struct_str
        )
        _nlc = max(1, len(set(round(s.frac_coords[2], 4) for s in _bulk)))
        _d = _bulk.lattice.c / _nlc
        if layers:
            eff_thickness = max(float(thickness), int(layers) * _d)
    except Exception:
        pass

    slab = None
    try:
        import ferrox
        slab_json = ferrox.surfaces.generate_slab(
            struct_str, h, k, l, thickness=eff_thickness, vacuum=vacuum,
        )
        slab = PmgStructure.from_dict(
            json.loads(slab_json) if isinstance(slab_json, str) else slab_json
        )
    except Exception:
        slab = None

    if slab is None:
        # Fallback: pymatgen SlabGenerator when ferrox is unavailable / failed
        from pymatgen.core.surface import SlabGenerator
        struct_dict = json.loads(struct_str) if isinstance(struct_str, str) else struct_str
        bulk = PmgStructure.from_dict(struct_dict)
        c_param = bulk.lattice.c
        n_layers_in_cell = max(1, len(set(round(s.frac_coords[2], 4) for s in bulk)))
        min_slab_size = int(layers) * (c_param / n_layers_in_cell)
        gen = SlabGenerator(bulk, (h, k, l), min_slab_size=min_slab_size,
                            min_vacuum_size=vacuum, center_slab=True)
        slabs = gen.get_slabs()
        if not slabs:
            raise RuntimeError(f"SlabGenerator returned no slabs for miller=({h},{k},{l})")
        # Orthogonalize c so it is perpendicular to the ab surface plane (vacuum
        # cleanly along c) — matches the interactive /structure-ops slab path and
        # the ferrox primary path; the raw oriented cell has a tilted c.
        slab = slabs[0].get_orthogonal_c_slab()

    # --- Supercell (applies to BOTH paths) ---
    sa = int(params.get("supercell_a", 1) or 1)
    sb = int(params.get("supercell_b", 1) or 1)
    if sa == 1 and sb == 1 and params.get("supercell"):
        sc_parts = str(params["supercell"]).replace("\u00d7", "x").lower().split("x")
        if len(sc_parts) >= 2:
            sa, sb = int(sc_parts[0]), int(sc_parts[1])
    if sa > 1 or sb > 1:
        slab.make_supercell([[sa, 0, 0], [0, sb, 0], [0, 0, 1]])

    # --- Freeze bottom N layers as selective dynamics (stored on the structure) ---
    n_frozen = 0
    for _key in ("frozen_layers", "freeze_layers", "freeze_n_layers"):
        _v = params.get(_key)
        if _v:
            try:
                n_frozen = int(_v)
                break
            except (TypeError, ValueError):
                pass
    if n_frozen > 0 and len(slab) > 0:
        z_levels = sorted(set(round(s.coords[2], 2) for s in slab))
        if 0 < n_frozen < len(z_levels):
            z_thr = (z_levels[n_frozen - 1] + z_levels[n_frozen]) / 2
            sd = [[False, False, False] if s.coords[2] < z_thr else [True, True, True]
                  for s in slab]
            slab.add_site_property("selective_dynamics", sd)

    return {"structure": json.dumps(slab.as_dict())}


_ADSORBATE_MOLECULES: dict[str, tuple[list[str], list[list[float]]]] = _load_adsorbate_library()


def run_adsorbate_place(
    structure: Any = None,
    species: str = "OH",
    site: str = "ontop",
    height: float = 2.0,
    site_index: int | None = None,
    **params,
) -> dict:
    """Place adsorbate on slab surface using ferrox site finder + CatGo placement engine.

    Uses the same algorithm as the frontend (Rodrigues rotation, overlap detection,
    multi-dentate support) via utils/adsorbate_placement.py.

    Args:
        structure: Slab structure (JSON string or dict).
        species: Adsorbate species name (OH, O, OOH, H, H2O, CO, etc.).
        site: Site type — "ontop", "bridge", "hollow", or "all" (picks ontop).
        height: Height above surface in Å (default 2.0).
        site_index: Which site of the given type to use. When ``None`` (the
            default), pick the site whose xy projection is closest to the
            slab's xy centroid — this is what a user almost always wants for
            an auto-generated workflow (CatBot-built OER/HER/CO2RR pipelines)
            so the adsorbate lands somewhere visible in the viewer rather
            than at whatever corner ferrox happened to enumerate first.
    """
    if structure is None:
        raise ValueError("adsorbate_place requires a structure input")

    # Accept structure_json key from frontend (same pattern as run_structure_input)
    if structure is None and params.get("structure_json"):
        structure = params["structure_json"]

    # Accept POSCAR/CONTCAR text too — an upstream geo_opt passes its relaxed
    # CONTCAR (POSCAR format), not pymatgen-JSON. Convert text -> JSON so the
    # ferrox and fallback paths (which json.loads the structure) work and the
    # slab's selective_dynamics is preserved.
    if isinstance(structure, str) and structure.lstrip()[:1] not in "{[":
        from pymatgen.core import Structure as _PmgS
        structure = _PmgS.from_str(structure, fmt="poscar").to(fmt="json")

    try:
        import ferrox
    except ImportError:
        # Fallback: pymatgen AdsorbateSiteFinder when ferrox (Rust) is not available
        import numpy as _np
        from pymatgen.core import Structure as PmgStructure, Molecule
        from pymatgen.analysis.adsorption import AdsorbateSiteFinder

        struct_str = structure if isinstance(structure, str) else json.dumps(structure)
        struct_dict = json.loads(struct_str) if isinstance(struct_str, str) else struct_str
        slab = PmgStructure.from_dict(struct_dict)

        # Build adsorbate molecule
        species_upper = species.lstrip("*").upper()
        if species_upper in _ADSORBATE_MOLECULES:
            elements, coords = _ADSORBATE_MOLECULES[species_upper]
        else:
            elements, coords = [species.lstrip("*")], [[0, 0, 0]]
        mol = Molecule(elements, coords)

        asf = AdsorbateSiteFinder(slab)

        # Get raw site coordinates (not structures), filter to the requested
        # site type, then pick the one closest to the slab's top-layer xy
        # centroid (or honour an explicit site_index). Going through
        # generate_adsorption_structures() directly would just return the
        # first available site, which often lands at a cell corner.
        site_key = (site or "all").lower()
        # Accept LLM-natural aliases too — Claude / GPT tend to write "top"
        # for an ontop site even when the schema enum says "ontop". Mapping
        # them here is cheaper than catching every miswritten node param
        # on the frontend.
        pmg_key_map = {"ontop": "ontop", "on_top": "ontop", "top": "ontop",
                       "atop": "ontop", "bridge": "bridge",
                       "hollow": "hollow", "fcc": "hollow", "hcp": "hollow",
                       "hollow3": "hollow", "hollow4": "hollow",
                       "all": "ontop"}
        pmg_key = pmg_key_map.get(site_key, site_key)
        sites_by_type = asf.find_adsorption_sites(symm_reduce=0)
        candidates = sites_by_type.get(pmg_key, [])
        if not candidates:
            for k in ("ontop", "bridge", "hollow"):
                candidates = sites_by_type.get(k, [])
                if candidates:
                    break
        if not candidates:
            raise RuntimeError(f"No adsorption sites found for {species} on surface")

        all_pos = slab.cart_coords
        z_top = float(all_pos[:, 2].max())
        top_layer = all_pos[all_pos[:, 2] >= z_top - 1.0]
        xy_center = (top_layer[:, :2].mean(axis=0)
                     if len(top_layer) else all_pos[:, :2].mean(axis=0))
        if site_index is None:
            cand_arr = _np.asarray(candidates)
            d2 = ((cand_arr[:, :2] - xy_center) ** 2).sum(axis=1)
            chosen = candidates[int(d2.argmin())]
        else:
            chosen = candidates[min(site_index, len(candidates) - 1)]

        # Place adsorbate at chosen site (height handled by pymatgen)
        chosen_3d = list(chosen)
        chosen_3d[2] = z_top + height
        new_slab = slab.copy()
        for elem, off in zip(elements, coords):
            new_slab.append(
                elem,
                [chosen_3d[0] + off[0], chosen_3d[1] + off[1], chosen_3d[2] + off[2]],
                coords_are_cartesian=True,
            )
        # Tag adsorbate atoms so downstream freq can fix the slab and vibrate
        # only the adsorbate (freeze_mode=adsorbate).
        n_slab = len(slab)
        new_slab.add_site_property(
            "is_adsorbate", [i >= n_slab for i in range(len(new_slab))]
        )
        return {"structure": json.dumps(new_slab.as_dict())}

    import numpy as np
    from catgo.utils.adsorbate_placement import place_adsorbate

    struct_str = structure if isinstance(structure, str) else json.dumps(structure)
    slab_dict = json.loads(struct_str)

    # Extract slab positions and symbols
    lattice_matrix = np.array(slab_dict["lattice"]["matrix"])
    slab_positions = []
    slab_symbols = []
    for site_d in slab_dict["sites"]:
        xyz = site_d.get("xyz")
        if xyz is None:
            abc = site_d["abc"]
            xyz = (np.array(abc) @ lattice_matrix).tolist()
        slab_positions.append(xyz)
        slab_symbols.append(site_d["species"][0]["element"])
    slab_positions = np.array(slab_positions)

    # Build adsorbate molecule
    species_upper = species.upper()
    if species_upper in _ADSORBATE_MOLECULES:
        elements, coords = _ADSORBATE_MOLECULES[species_upper]
    else:
        elements, coords = [species], [[0, 0, 0]]
    ads_positions = np.array(coords)

    # Find adsorption sites using ferrox (Rust)
    all_sites = ferrox.surfaces.find_adsorption_sites(struct_str)
    if not all_sites:
        raise RuntimeError(f"No adsorption sites found on slab")

    # Filter by site type
    site_key = site.lower()
    if site_key == "all":
        site_key = "atop"
    # Map our naming to ferrox naming. "top" / "atop" are accepted as
    # LLM-natural aliases for "ontop" (CatBot tends to write "top"); "fcc"
    # and "hcp" are the frontend's enum names for 3-fold hollow sites.
    _type_map = {"ontop": "atop", "on_top": "atop", "top": "atop", "atop": "atop",
                 "bridge": "bridge",
                 "hollow": "hollow3", "hollow3": "hollow3", "hollow4": "hollow4",
                 "fcc": "hollow3", "hcp": "hollow3"}
    ferrox_type = _type_map.get(site_key, site_key)

    filtered = [s for s in all_sites if s["site_type"] == ferrox_type]
    if not filtered:
        # Fallback to any available
        for ft in ["atop", "bridge", "hollow3", "hollow4"]:
            filtered = [s for s in all_sites if s["site_type"] == ft]
            if filtered:
                break
    if not filtered:
        filtered = all_sites

    # Pick the site whose xy projection is closest to the slab's xy centroid
    # when no explicit index is given. The centroid uses only the top-most
    # layer of the slab (≥ z_max − 1 Å) so a thick slab's bulk atoms don't
    # drag the target away from the surface that the adsorbate actually
    # binds to.
    if site_index is None:
        z_max = float(slab_positions[:, 2].max())
        top_layer_mask = slab_positions[:, 2] >= z_max - 1.0
        top_layer = slab_positions[top_layer_mask] if top_layer_mask.any() else slab_positions
        xy_center = top_layer[:, :2].mean(axis=0)
        best_idx = 0
        best_d2 = float("inf")
        for i, s in enumerate(filtered):
            xy = np.asarray(s["cart_coords"][:2])
            d2 = float(((xy - xy_center) ** 2).sum())
            if d2 < best_d2:
                best_d2 = d2
                best_idx = i
        idx = best_idx
    else:
        idx = min(site_index, len(filtered) - 1)
    chosen_site = filtered[idx]
    site_position = np.array(chosen_site["cart_coords"])

    # Surface normal: [0, 0, 1] for slabs (pointing out of surface)
    site_normal = np.array([0.0, 0.0, 1.0])

    # Place adsorbate using CatGo placement engine
    result = place_adsorbate(
        slab_positions=slab_positions,
        slab_symbols=slab_symbols,
        slab_cell=lattice_matrix,
        slab_pbc=[True, True, False],
        adsorbate_positions=ads_positions,
        adsorbate_symbols=elements,
        binding_atom_indices=[0],
        site_position=site_position,
        site_normal=site_normal,
        height_offset=height,
        auto_rotate=True,
    )

    # Build output structure dict
    merged_positions = result["positions"]
    merged_symbols = result["symbols"]
    inv_lat = np.linalg.inv(lattice_matrix)

    # Preserve the slab's selective_dynamics so a frozen slab stays frozen after
    # adsorption: slab atoms (first n_slab, same order) keep their flags; the
    # newly placed adsorbate atoms are fully free (T T T). Without this the freeze
    # silently vanished the moment a structure passed through the adsorbate node.
    n_slab = len(slab_dict["sites"])
    slab_has_sd = any("selective_dynamics" in (s.get("properties") or {})
                      for s in slab_dict["sites"])
    out_sites = []
    for i, (pos, sym) in enumerate(zip(merged_positions, merged_symbols)):
        xyz = pos.tolist() if hasattr(pos, 'tolist') else list(pos)
        abc = (np.array(xyz) @ inv_lat).tolist()
        if i < n_slab:
            props = dict(slab_dict["sites"][i].get("properties") or {})
        else:
            props = {"selective_dynamics": [True, True, True]} if slab_has_sd else {}
        # Tag adsorbate atoms so downstream freq can fix the slab and vibrate
        # only the adsorbate (freeze_mode=adsorbate).
        props["is_adsorbate"] = i >= n_slab
        out_sites.append({
            "species": [{"element": sym, "occu": 1}],
            "abc": abc,
            "xyz": xyz,
            "label": sym,
            "properties": props,
        })

    out_dict = {
        "lattice": slab_dict["lattice"],
        "sites": out_sites,
    }
    return {"structure": json.dumps(out_dict)}


def run_free_energy_diagram(gibbs_values=None, step_order=None, **params) -> dict:
    """Generate free energy diagram data (implemented via frontend)."""
    return {"plotly_data": None}


def run_dos_analysis(data=None, d_band=True, **params) -> dict:
    """DOS analysis -- requires HPC output data."""
    return {"dos_data": data}


def run_charge_analysis(data=None, method="bader", **params) -> dict:
    """Charge analysis -- requires HPC output data."""
    return {"charges": data}

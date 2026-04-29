"""C-N coupling reaction network generator for electrocatalysis.

Enumerates all possible C-N coupling pairs between C-species and N-species
intermediates, assesses chemical feasibility, and provides ICONST templates
for VASP slow-growth AIMD simulations.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Species database
# ---------------------------------------------------------------------------

C_SPECIES: dict[str, dict] = {
    "CO2":  {"formula": "CO2",  "c_atom_label": "C", "oxidation": +4, "radical": False,
             "notes": "Linear, weakly activated on Cu; C shielded by two O"},
    "COOH": {"formula": "COOH", "c_atom_label": "C", "oxidation": +3, "radical": True,
             "notes": "Carboxyl radical; electrophilic C available for nucleophilic N attack"},
    "CO":   {"formula": "CO",   "c_atom_label": "C", "oxidation": +2, "radical": True,
             "notes": "Surface-bound CO; most reactive C-species for coupling"},
    "CHO":  {"formula": "CHO",  "c_atom_label": "C", "oxidation": +2, "radical": True,
             "notes": "Formyl; moderate C-N reactivity, electrophilic C"},
    "CH2O": {"formula": "CH2O", "c_atom_label": "C", "oxidation": 0,  "radical": False,
             "notes": "Formaldehyde; C is sp3-like, lower coupling tendency"},
}

N_SPECIES: dict[str, dict] = {
    "NO2":  {"formula": "NO2",  "n_atom_label": "N", "oxidation": +4, "radical": False,
             "notes": "Adsorbed NO2; N shielded by two O, limited coupling"},
    "NO":   {"formula": "NO",   "n_atom_label": "N", "oxidation": +2, "radical": True,
             "notes": "Surface-bound NO; N exposed and available for coupling"},
    "NOH":  {"formula": "NOH",  "n_atom_label": "N", "oxidation": +1, "radical": True,
             "notes": "N-hydroxide; N moderately available"},
    "NHOH": {"formula": "NHOH", "n_atom_label": "N", "oxidation": -1, "radical": True,
             "notes": "Hydroxylamine; strong nucleophilic N"},
    "HNO":  {"formula": "HNO",  "n_atom_label": "N", "oxidation": +1, "radical": True,
             "notes": "Nitroxyl; N available for electrophilic attack"},
    "N":    {"formula": "N",    "n_atom_label": "N", "oxidation": -3, "radical": True,
             "notes": "Adsorbed N atom; highly reactive, strong coupling"},
    "NH":   {"formula": "NH",   "n_atom_label": "N", "oxidation": -3, "radical": True,
             "notes": "Imide; strong nucleophile for C-N bond formation"},
    "NH2":  {"formula": "NH2",  "n_atom_label": "N", "oxidation": -3, "radical": True,
             "notes": "Amine; strong nucleophile, well-studied coupling partner"},
}


# ---------------------------------------------------------------------------
# Product prediction
# ---------------------------------------------------------------------------

_PRODUCT_MAP: dict[tuple[str, str], tuple[str, str]] = {
    # (c_species, n_species) -> (product_formula, product_name)
    ("CO", "N"):    ("CON",   "isocyanate-like"),
    ("CO", "NH"):   ("CONH",  "amide-like"),
    ("CO", "NH2"):  ("CONH2", "urea precursor"),
    ("CO", "NO"):   ("CONO",  "nitrosyl carbonyl"),
    ("CO", "NOH"):  ("CONOH", "C-N coupled hydroxylamine"),
    ("CO", "HNO"):  ("COHNO", "C-HNO coupled"),
    ("CO", "NHOH"): ("CONHOH","N-hydroxy amide"),
    ("CO", "NO2"):  ("CONO2", "nitro-carbonyl"),
    ("CO2", "N"):   ("CO2N",  "carbamate-like"),
    ("CO2", "NH"):  ("CO2NH", "carbamic acid-like"),
    ("CO2", "NH2"): ("CO2NH2","carbamic acid"),
    ("CO2", "NO"):  ("CO2NO", "nitrosyl carboxylate"),
    ("CO2", "NOH"): ("CO2NOH","C-NOH carboxylate"),
    ("CO2", "HNO"): ("CO2HNO","C-HNO carboxylate"),
    ("CO2", "NHOH"):("CO2NHOH","N-hydroxy carbamate"),
    ("CO2", "NO2"): ("CO2NO2","dinitro species"),
    ("COOH", "N"):   ("COONH",  "amino acid-like"),
    ("COOH", "NH"):  ("COOHNH", "glycine precursor"),
    ("COOH", "NH2"): ("COOHNH2","glycine-like"),
    ("COOH", "NO"):  ("COOHNO", "nitroso carboxylic"),
    ("COOH", "NOH"): ("COOHNOH","N-hydroxy amino acid"),
    ("COOH", "HNO"): ("COOHHNO","C-HNO carboxylic"),
    ("COOH", "NHOH"):("COOHNHOH","hydroxylamine carboxylic"),
    ("COOH", "NO2"): ("COOHNO2","nitro carboxylic"),
    ("CHO", "N"):    ("CHON",   "formamide-like"),
    ("CHO", "NH"):   ("CHONH",  "formamide"),
    ("CHO", "NH2"):  ("CHONH2", "formamide"),
    ("CHO", "NO"):   ("CHONO",  "nitroso aldehyde"),
    ("CHO", "NOH"):  ("CHONOH", "C-NOH formyl"),
    ("CHO", "HNO"):  ("CHOHNO", "C-HNO formyl"),
    ("CHO", "NHOH"): ("CHONHOH","N-hydroxy formamide"),
    ("CHO", "NO2"):  ("CHONO2", "nitro formyl"),
    ("CH2O", "N"):    ("CH2ON",   "aminomethanol-like"),
    ("CH2O", "NH"):   ("CH2ONH",  "N-methyl hydroxylamine-like"),
    ("CH2O", "NH2"):  ("CH2ONH2", "aminomethanol"),
    ("CH2O", "NO"):   ("CH2ONO",  "nitroso methanol"),
    ("CH2O", "NOH"):  ("CH2ONOH", "C-NOH methanol"),
    ("CH2O", "HNO"):  ("CH2OHNO", "C-HNO methanol"),
    ("CH2O", "NHOH"): ("CH2ONHOH","N-hydroxy aminomethanol"),
    ("CH2O", "NO2"):  ("CH2ONO2", "nitro methanol"),
}


# ---------------------------------------------------------------------------
# Feasibility assessment
# ---------------------------------------------------------------------------

def _assess_feasibility(c_name: str, n_name: str) -> dict:
    """Assess chemical feasibility of a C-N coupling pair.

    Conservative: only mark infeasible when both species are fully oxidized
    and have no radical character.
    """
    c = C_SPECIES[c_name]
    n = N_SPECIES[n_name]

    # Both fully oxidized and non-radical → infeasible
    if c["oxidation"] >= 4 and n["oxidation"] >= 4 and not c["radical"] and not n["radical"]:
        return {
            "feasible": False,
            "coupling_type": "none",
            "reason": f"Both {c_name} (C oxidation={c['oxidation']}) and {n_name} "
                      f"(N oxidation={n['oxidation']}) are fully oxidized with no radical character",
        }

    # Determine coupling type
    if n["oxidation"] <= -1 and c["oxidation"] >= 2:
        coupling_type = "nucleophilic"
        reason = f"Nucleophilic N ({n_name}, ox={n['oxidation']}) attacks electrophilic C ({c_name}, ox={c['oxidation']})"
    elif c["radical"] and n["radical"]:
        coupling_type = "radical"
        reason = f"Radical coupling between {c_name} and {n_name}"
    elif c["oxidation"] <= 0 and n["oxidation"] >= 2:
        coupling_type = "electrophilic"
        reason = f"Nucleophilic C ({c_name}) attacks electrophilic N ({n_name})"
    else:
        coupling_type = "mixed"
        reason = f"Mixed coupling mechanism between {c_name} and {n_name}"

    # CH2O is sp3-like, coupling with shielded N species is less favorable
    if c_name == "CH2O" and n_name == "NO2":
        return {
            "feasible": True,
            "coupling_type": coupling_type,
            "reason": reason + " (note: both species have limited reactivity, higher barrier expected)",
            "difficulty": "hard",
        }

    return {"feasible": True, "coupling_type": coupling_type, "reason": reason}


# ---------------------------------------------------------------------------
# ICONST template generation
# ---------------------------------------------------------------------------

def _iconst_template(c_name: str, n_name: str) -> dict:
    """Generate ICONST constraint template for slow-growth AIMD.

    Atom indices are placeholders ({C_idx}, {N_idx}) to be resolved
    at model-building time when actual atom positions are known.
    """
    # C-N bond distance ranges
    # Single bond: ~1.47 Å, Double bond: ~1.29 Å
    if c_name in ("CO", "CHO") and n_name in ("N", "NH"):
        # Expect C=N double bond in product
        end_distance = 1.3
    elif c_name == "CO2":
        # CO2 coupling typically gives longer C-N
        end_distance = 1.5
    else:
        # Standard C-N single bond
        end_distance = 1.4

    start_distance = 4.0  # Start from non-bonded distance
    increm = -0.005       # Å per AIMD step (approach)
    total_steps = int((start_distance - end_distance) / abs(increm))

    return {
        "iconst_lines": [
            f"R {'{C_idx}'} {'{N_idx}'} 0",
        ],
        "increm_value": increm,
        "c_atom_element": "C",
        "n_atom_element": "N",
        "c_species": c_name,
        "n_species": n_name,
        "start_distance_angstrom": start_distance,
        "end_distance_angstrom": end_distance,
        "recommended_nsw": total_steps,
        "notes": f"Constrain C-N distance from {start_distance} to {end_distance} Å, "
                 f"INCREM={increm} Å/step, ~{total_steps} MD steps",
    }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def generate_cn_coupling_network(
    c_species: list[str] | None = None,
    n_species: list[str] | None = None,
    include_infeasible: bool = False,
) -> dict:
    """Generate the full C-N coupling reaction network.

    Args:
        c_species: C-species names (default: all 5).
        n_species: N-species names (default: all 8).
        include_infeasible: Include chemically infeasible paths.

    Returns:
        Dict with coupling_paths, infeasible_paths, and summary stats.
    """
    c_list = c_species or list(C_SPECIES.keys())
    n_list = n_species or list(N_SPECIES.keys())

    # Validate inputs
    for c in c_list:
        if c not in C_SPECIES:
            return {"error": f"Unknown C-species: {c}. Valid: {list(C_SPECIES.keys())}"}
    for n in n_list:
        if n not in N_SPECIES:
            return {"error": f"Unknown N-species: {n}. Valid: {list(N_SPECIES.keys())}"}

    coupling_paths = []
    infeasible_paths = []

    for c_name in c_list:
        for n_name in n_list:
            assessment = _assess_feasibility(c_name, n_name)

            if not assessment["feasible"]:
                infeasible_paths.append({
                    "path_id": f"{c_name}_{n_name}",
                    "c_species": c_name,
                    "n_species": n_name,
                    "feasible": False,
                    "reason": assessment["reason"],
                })
                continue

            product = _PRODUCT_MAP.get((c_name, n_name), (f"{c_name}-{n_name}", "unknown"))
            iconst = _iconst_template(c_name, n_name)

            coupling_paths.append({
                "path_id": f"{c_name}_{n_name}",
                "c_species": c_name,
                "n_species": n_name,
                "feasible": True,
                "product_formula": product[0],
                "product_name": product[1],
                "coupling_type": assessment["coupling_type"],
                "reason": assessment["reason"],
                "iconst_template": iconst,
                "distance_range": {
                    "start": iconst["start_distance_angstrom"],
                    "end": iconst["end_distance_angstrom"],
                },
                "increm": iconst["increm_value"],
                "recommended_nsw": iconst["recommended_nsw"],
            })

    result = {
        "c_species": c_list,
        "n_species": n_list,
        "total_pairs": len(c_list) * len(n_list),
        "feasible_count": len(coupling_paths),
        "infeasible_count": len(infeasible_paths),
        "coupling_paths": coupling_paths,
    }

    if include_infeasible:
        result["infeasible_paths"] = infeasible_paths

    # Summary for CatBot
    result["summary"] = (
        f"C-N coupling network: {len(coupling_paths)} feasible paths "
        f"out of {len(c_list) * len(n_list)} total "
        f"({len(c_list)} C-species × {len(n_list)} N-species). "
        f"{len(infeasible_paths)} paths marked infeasible."
    )

    return result

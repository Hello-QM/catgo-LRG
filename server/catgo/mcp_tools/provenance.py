#!/usr/bin/env python3
"""Provenance envelope for numeric tool returns (stdlib only, additive).

Why this exists, with a number: on an information-isolated corpus of 94 real
failures from 17 projects, 28% were failures the verification gates already have a
class and a gate for — they were missed only because the persisted record did not
carry the field the gate needs. Ranked by how many real failures each field would
have unlocked, the top of the list is embarrassingly plain: `energy` (18) and
`n_atoms` (12), then region, min_pair_ang, committee_sigma_max, fmax.

So the bottleneck is not detection logic, it is emission. A numeric tool that
returns a bare number is unverifiable by anyone — including its own author later.

Two rules this encodes:
  1. every numeric return carries how it was produced and from what
  2. a tool that CANNOT vouch for something says so, in a machine-readable field,
     instead of letting the omission look like an absence of problems

`unverifiable_without` is the load-bearing part: it is the tool declaring the gap.
Downstream, catgo_verify's verifiability layer turns exactly those names into an
UNVERIFIABLE verdict rather than a silent pass.
"""

# what a checkable claim of each kind needs, beyond the value itself
NEEDS = {
    # `reference_dir` is asked for on the EMISSION side even though certification does
    # not strictly require it: measured on a live ai-screen tree, only 67 of 751
    # adsorbate directories could be paired with their bare slab by name heuristics
    # (9%), because one project used two opposite naming conventions across its own
    # trees (<species>_<M1>_<M2> in one, <M1>_<M2>_<species> in another) with
    # inconsistent metal-pair ordering. The pairwise PAW gate carries the largest
    # recorded blast radius here (~3.1 eV across 122 units, undetected for two months)
    # and it simply cannot run without knowing which calculation was referenced.
    "binding_dG": ["ads_titels", "bare_titels", "nelect_ads", "nelect_bare",
                   "reference_dir"],
    "limiting_potential": ["ul_reaction", "ul_reference", "ul_convention"],
    "her_dGH": ["gas_entropy_included"],
    "free_energy": ["temperature", "pressure", "gas_entropy_included"],
    "band_gap": ["kgrid_coarse"],
    "d_band_center": ["kpoint_weights_applied", "dos_window", "nelect"],
    "energy": ["n_atoms", "xc_functional", "potcar_titels", "nelect", "kgrid"],
    # Bader/charge partitioning depends on the PAW set and the electron count it was
    # partitioned from; a charge without them cannot be compared to another charge.
    "charge": ["potcar_titels", "nelect", "xc_functional"],
    # A DOS-derived quantity is only meaningful if the integration is complete: the
    # k-point weights must have been applied and the energy window must cover both spin
    # channels. Both have produced recorded artefacts here (a 74 uB moment from an
    # unweighted sum, a 73 uB moment from a truncated window).
    "electronic_structure": ["kgrid", "kpoint_weights_applied", "dos_window", "nelect"],
    # A partial Hessian is defined by which atoms were free; n_modes == 3*n_free is the
    # identity that catches a POSCAR silently missing `Selective dynamics`.
    "frequencies": ["n_free_atoms", "n_modes", "selective_dynamics_present"],
}


def envelope(value, *, tool, action, inputs=None, unit=None, convention=None,
             claim=None, extra_needs=(), **provenance):
    """Wrap a numeric result so it can be checked later.

    value       the number or dict of numbers the tool computed
    tool/action which call produced it (re-derivable)
    inputs      the arguments it was computed from, echoed verbatim
    claim       claim type, so `unverifiable_without` can be filled from NEEDS
    provenance  anything else the tool genuinely knows (method module, version,
                source file, job id). Never invent one — an absent field belongs
                in unverifiable_without, not in a plausible-looking default.
    """
    known = {k: v for k, v in provenance.items() if v is not None}
    supplied = set(known) | set((inputs or {}))
    missing = [f for f in list(NEEDS.get(claim, [])) + list(extra_needs)
               if f not in supplied]
    out = {"value": value,
           "provenance": {"tool": tool, "action": action, "inputs": inputs or {}, **known}}
    if unit is not None:
        out["provenance"]["unit"] = unit
    if convention is not None:
        out["provenance"]["convention"] = convention
    if claim is not None:
        out["claim"] = claim
    if missing:
        out["unverifiable_without"] = missing
        out["note"] = ("this value cannot be physics-checked from what the tool knows; "
                       "supply the listed fields (or pass them to catgo_verify) before "
                       "treating it as a result")
    return out


def wrap_payload(text, *, tool, action, inputs=None):
    """Envelope a tool's JSON payload at the dispatcher, so EVERY numeric tool emits
    provenance instead of only the ones someone remembered to edit.

    Why here and not in each handler: an audit of 178 numeric-returning tools across 18
    public comp-chem agent repos found 59.6% emit no method provenance at all, and the
    dominant cause was not ignorance but DISCARD at the payload boundary — a handler
    builds a rich dict and the wrapper returns one float. One boundary, one fix.

    Returns the enveloped JSON text, or None when there is nothing to wrap: a non-JSON
    payload (prose report), an already-enveloped payload, or an error string. Those are
    left untouched and counted honestly as non-emitting in our own self-audit rather
    than papered over.
    """
    import json
    stripped = (text or "").lstrip()
    if not stripped.startswith(("{", "[")):
        return None
    try:
        payload = json.loads(text)
    except (ValueError, TypeError):
        return None
    if isinstance(payload, dict) and "provenance" in payload and "value" in payload:
        return None                                  # a handler already enveloped it
    claim = CATALYSIS_CLAIM.get(str(action)) if tool == "catgo_catalysis" else TOOL_CLAIM.get(tool)
    env = envelope(payload, tool=tool, action=action, inputs=inputs, claim=claim,
                   emitted_by="dispatcher")
    return json.dumps(env, indent=2, ensure_ascii=False)


# claim type per numeric tool family, where one applies
TOOL_CLAIM = {
    "catgo_energy": "energy",
    "catgo_bader": "charge",
    "catgo_charge": "charge",
    "catgo_dos": "electronic_structure",
    "catgo_cohp": "electronic_structure",
    "catgo_freq": "frequencies",
    "catgo_gibbs": "free_energy",
    "catgo_thermo": "free_energy",
    "catgo_overpot": "limiting_potential",
    "catgo_bands": "band_gap",
    "catgo_band": "band_gap",
}

# claim type per catgo_catalysis action, where one applies
CATALYSIS_CLAIM = {
    "oer": "limiting_potential",
    "co2rr": "limiting_potential",
    "nrr": "limiting_potential",
    "free_energy": "free_energy",
    "adsorption_energy": "binding_dG",
    "d_band_center": "d_band_center",
}


if __name__ == "__main__":
    e = envelope({"eta": 0.51}, tool="catgo_catalysis", action="oer",
                 inputs={"dG_OH": -0.7, "dG_O": 1.6, "dG_OOH": 3.2},
                 unit="V", claim="limiting_potential", method="workflow.catalysis.oer")
    assert e["unverifiable_without"] == ["ul_reaction", "ul_reference", "ul_convention"], e
    assert e["provenance"]["method"] == "workflow.catalysis.oer"
    # supplying them removes the declaration — nothing left unvouched
    ok = envelope({"eta": 0.51}, tool="catgo_catalysis", action="oer",
                  inputs={"dG_OH": -0.7}, claim="limiting_potential",
                  ul_reaction="OER", ul_reference="bare_slab", ul_convention="CHE")
    assert "unverifiable_without" not in ok, ok
    # a None-valued provenance field is NOT provenance
    n = envelope(1.0, tool="t", action="a", claim="her_dGH", gas_entropy_included=None)
    assert n["unverifiable_without"] == ["gas_entropy_included"], n
    # unregistered claim -> nothing invented
    u = envelope(1.0, tool="t", action="a", claim="something_new")
    assert "unverifiable_without" not in u and u["claim"] == "something_new"
    # dispatcher-level wrapping
    import json as _json
    w = wrap_payload('{"gap_ev": 1.2}', tool="catgo_bands", action="data")
    assert _json.loads(w)["claim"] == "band_gap" and "kgrid_coarse" in _json.loads(w)["unverifiable_without"]
    assert _json.loads(w)["provenance"]["emitted_by"] == "dispatcher"
    assert wrap_payload("Workflow run failed: ...", tool="catgo_energy", action="x") is None
    assert wrap_payload("not json {", tool="catgo_energy", action="x") is None
    assert wrap_payload(w, tool="catgo_bands", action="data") is None   # no double-wrap
    print("provenance envelope self-test OK — declares what it cannot vouch for; "
          "None is not provenance; nothing is invented; dispatcher wraps JSON payloads "
          "once and leaves prose/errors alone")

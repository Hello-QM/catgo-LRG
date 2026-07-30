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

import hashlib
import hmac
import json
import math
import re

_UNKNOWN_PLACEHOLDERS = {
    "?", "n/a", "na", "none", "null", "tbd", "unknown", "unset",
}
_ENVELOPE_CONTROL_FIELDS = {
    "tool", "action", "inputs", "unit", "convention", "emitted_by", "method",
    "result_identity",
}
_STRICT_RESULT_FIELDS = {
    "energy", "n_atoms", "fmax", "ediffg", "potcar_titels", "nelect", "kgrid",
    "xc_functional", "submission_manifest_digest", "input_hashes",
    "vasp_binary", "resolved_run_command", "kpoint_source", "kspacing",
    "reference_digest", "slab_adsorbate_digest", "gas_reference_digest",
    "E_ads_eV", "E_ads_unit", "dG_ads_eV", "dG_ads_unit",
}
_RESULT_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")

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
    "binding_Eads": [
        "E_ads_eV", "E_ads_unit",
        "reference_task_id", "reference_digest",
        "slab_adsorbate_task_id", "slab_adsorbate_digest", "pairing_mode",
        "lineage_records", "declared_role_bindings",
    ],
    "binding_dG": [
        "E_ads_eV", "E_ads_unit", "dG_ads_eV", "dG_ads_unit",
        "temperature", "pressure",
        "zpe_correction_eV", "entropy_correction_eV",
        "gas_entropy_included",
        "reference_task_id", "reference_digest",
        "slab_adsorbate_task_id", "slab_adsorbate_digest", "pairing_mode",
        "lineage_records", "declared_role_bindings",
    ],
    "limiting_potential": ["ul_reaction", "ul_reference", "ul_convention"],
    "her_dGH": ["gas_entropy_included"],
    "free_energy": ["temperature", "pressure", "gas_entropy_included"],
    "band_gap": ["kgrid_coarse"],
    "d_band_center": ["kpoint_weights_applied", "dos_window", "nelect"],
    "energy": ["n_atoms", "xc_functional", "potcar_titels", "nelect", "kgrid"],
    "vasp_energy": [
        "n_atoms", "xc_functional", "potcar_titels", "nelect", "kgrid",
        "submission_manifest_digest", "input_hashes", "vasp_binary",
        "resolved_run_command", "kpoint_source",
    ],
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
             claim=None, extra_needs=(), trusted_input_fields=(), **provenance):
    """Wrap a numeric result so it can be checked later.

    value       the number or dict of numbers the tool computed
    tool/action which call produced it (re-derivable)
    inputs      the arguments it was computed from, echoed verbatim
    claim       claim type, so `unverifiable_without` can be filled from NEEDS
    provenance  anything else the tool genuinely knows (method module, version,
                source file, job id). Never invent one — an absent field belongs
                in unverifiable_without, not in a plausible-looking default.
    """
    known = {
        k: v for k, v in provenance.items()
        if _valid_provenance_value(k, v)
    }
    # Stable logical identity lets a corrected rerun replace the failed digest for
    # the same call without clearing unrelated results. The content digest below
    # still changes whenever the value or provenance changes.
    known["result_identity"] = _result_identity(
        tool=tool,
        action=action,
        inputs=inputs,
        discriminator=known.get("result_task_id"),
    )
    trusted = set(trusted_input_fields)
    supplied_inputs = {
        k for k, v in (inputs or {}).items()
        if k in trusted and _valid_provenance_value(k, v)
    }
    supplied = set(known) | supplied_inputs
    missing = [f for f in list(NEEDS.get(claim, [])) + list(extra_needs)
               if f not in supplied]
    out = {"value": value,
           "provenance": {"tool": tool, "action": action, "inputs": inputs or {}, **known}}
    if _valid_provenance_value("unit", unit):
        out["provenance"]["unit"] = unit
    if _valid_provenance_value("convention", convention):
        out["provenance"]["convention"] = convention
    if claim is not None:
        out["claim"] = claim
    out["result_digest"] = _result_digest(
        out["value"], out.get("claim"), out["provenance"]
    )
    if missing:
        out["unverifiable_without"] = missing
        out["note"] = ("this value cannot be physics-checked from what the tool knows; "
                       "supply the listed fields (or pass them to catgo_verify) before "
                       "treating it as a result")
    return out


def _digest_normalize(value):
    """Return a JSON-safe, deterministic representation for result hashing."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return {"__nonfinite_float__": "NaN"}
        if math.isinf(value):
            return {"__nonfinite_float__": "Infinity" if value > 0 else "-Infinity"}
        return value
    if isinstance(value, dict):
        return {
            str(key): _digest_normalize(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, (list, tuple)):
        return [_digest_normalize(item) for item in value]
    if isinstance(value, set):
        normalized = [_digest_normalize(item) for item in value]
        return sorted(
            normalized,
            key=lambda item: json.dumps(
                item, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ),
        )
    return {
        "__python_type__": f"{type(value).__module__}.{type(value).__qualname__}",
        "__repr__": repr(value),
    }


def _result_digest(value, claim, provenance):
    canonical = json.dumps(
        _digest_normalize({
            "value": value,
            "claim": claim,
            "provenance": provenance,
        }),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(canonical).hexdigest()}"


def _result_identity(*, tool, action, inputs=None, discriminator=None):
    canonical = json.dumps(
        _digest_normalize({
            "tool": tool,
            "action": action,
            "inputs": inputs or {},
            "discriminator": discriminator,
        }),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(canonical).hexdigest()}"


def valid_result_digest(value):
    return isinstance(value, str) and bool(_RESULT_DIGEST_RE.fullmatch(value))


def extract_result_records(payload):
    """Collect bound digest/identity pairs from provenance envelopes."""
    try:
        value = json.loads(payload) if isinstance(payload, str) else payload
    except (ValueError, TypeError):
        return []
    found = []
    seen = set()

    def _walk(item):
        if isinstance(item, dict):
            digest = bound_result_digest(item)
            provenance = item.get("provenance")
            identity = (
                provenance.get("result_identity")
                if isinstance(provenance, dict) else None
            )
            if digest and digest not in seen:
                found.append({
                    "digest": digest,
                    "identity": identity if valid_result_digest(identity) else None,
                })
                seen.add(digest)
            for child in item.values():
                _walk(child)
        elif isinstance(item, list):
            for child in item:
                _walk(child)

    _walk(value)
    return found


def extract_result_digests(payload):
    """Collect unique, cryptographically bound result-envelope digests."""
    return [record["digest"] for record in extract_result_records(payload)]


def _is_provenance_envelope(payload):
    if not isinstance(payload, dict):
        return False
    provenance = payload.get("provenance")
    return (
        "value" in payload
        and isinstance(provenance, dict)
        and (
            "claim" in payload
            or "unverifiable_without" in payload
            or _present(provenance.get("tool"))
        )
    )


def bound_result_digest(payload):
    """Return a digest only when it is cryptographically bound to this envelope."""
    if not _is_provenance_envelope(payload):
        return None
    supplied = payload.get("result_digest")
    if not valid_result_digest(supplied):
        return None
    expected = _result_digest(
        payload.get("value"),
        payload.get("claim"),
        payload["provenance"],
    )
    return supplied if hmac.compare_digest(supplied, expected) else None


def supplied_envelope_digest(payload):
    """Return a syntactically valid digest only from a recognized envelope."""
    if not _is_provenance_envelope(payload):
        return None
    supplied = payload.get("result_digest")
    return supplied if valid_result_digest(supplied) else None


def _present(value):
    """Missing means absent, not a plausible default or an empty placeholder."""
    if value is None:
        return False
    if isinstance(value, (str, list, tuple, dict, set)):
        return bool(value)
    return True


def _valid_provenance_value(field, value):
    """Reject placeholders that would falsely clear a required provenance field."""
    if not _present(value):
        return False
    if field == "n_atoms":
        return (
            isinstance(value, int)
            and not isinstance(value, bool)
            and value > 0
        )
    if field == "potcar_titels":
        return (
            isinstance(value, (list, tuple))
            and all(
                isinstance(item, str)
                and item.strip()
                and item.strip().lower() not in _UNKNOWN_PLACEHOLDERS
                for item in value
            )
        )
    if field == "xc_functional":
        return (
            isinstance(value, str)
            and value.strip().lower() not in _UNKNOWN_PLACEHOLDERS
        )
    if field == "kgrid":
        return (
            isinstance(value, (list, tuple))
            and len(value) == 3
            and all(
                isinstance(item, int)
                and not isinstance(item, bool)
                and item > 0
                for item in value
            )
        )
    if field in {
        "energy", "nelect", "fmax", "ediffg", "kspacing",
        "E_ads_eV", "dG_ads_eV",
        "temperature", "pressure", "zpe_correction_eV",
        "entropy_correction_eV",
    }:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        if not math.isfinite(float(value)):
            return False
        if field in {
            "energy", "ediffg", "E_ads_eV", "dG_ads_eV",
            "zpe_correction_eV", "entropy_correction_eV",
        }:
            return True
        if field == "nelect":
            return float(value) > 0.0
        if field in {"temperature", "pressure", "kspacing"}:
            return float(value) > 0.0
        return float(value) >= 0.0
    if field in {"E_ads_unit", "dG_ads_unit"}:
        return value == "eV"
    if field == "gas_entropy_included":
        return isinstance(value, bool)
    if field in {"source_pointer", "energy_source", "metadata_parser"}:
        return not (
            isinstance(value, str)
            and value.strip().lower() in _UNKNOWN_PLACEHOLDERS
        )
    if field == "submission_manifest_digest":
        return valid_result_digest(value)
    if field in {
        "reference_digest", "slab_adsorbate_digest", "gas_reference_digest",
    }:
        return valid_result_digest(value)
    if field == "input_hashes":
        required = {"INCAR", "POSCAR", "POTCAR"}
        return (
            isinstance(value, dict)
            and set(value) == {"INCAR", "POSCAR", "POTCAR", "KPOINTS"}
            and all(
                isinstance(value.get(name), str)
                and bool(re.fullmatch(r"[0-9a-f]{64}", value[name]))
                for name in required
            )
            and (
                value["KPOINTS"] is None
                or (
                    isinstance(value["KPOINTS"], str)
                    and bool(re.fullmatch(r"[0-9a-f]{64}", value["KPOINTS"]))
                )
            )
        )
    if field == "kpoint_source":
        return value in {"KPOINTS", "INCAR:KSPACING"}
    if field in {"vasp_binary", "resolved_run_command"}:
        return (
            isinstance(value, str)
            and bool(value.strip())
            and value.strip().lower() not in _UNKNOWN_PLACEHOLDERS
        )
    if field == "pairing_mode":
        return value == "explicit_roles"
    if field in {"lineage_records", "declared_role_bindings"}:
        return isinstance(value, dict) and bool(value)
    return True


def verification_view(payload):
    """Flatten one provenance envelope for ``catgo_verify``.

    Returns ``(result, inferred_claims, conflicts)``. Input echoes are never
    promoted: only the computed value and producer-owned provenance participate.
    A value/provenance disagreement removes that field so certification fails
    closed instead of choosing one plausible-looking copy.
    """
    if not isinstance(payload, dict):
        return payload, [], {}
    provenance = payload.get("provenance")
    if not _is_provenance_envelope(payload):
        conflicts = {}
        if "result_digest" in payload:
            conflicts["result_digest"] = {
                "value": payload.get("result_digest"),
                "expected": "a digest bound to {value, claim, provenance}",
            }
        return dict(payload), [], conflicts

    claim = payload.get("claim")
    inferred_claims = [claim] if isinstance(claim, str) and claim.strip() else []
    value = payload.get("value")
    if isinstance(value, dict):
        result = dict(value)
    elif claim == "energy" and _valid_provenance_value("energy", value):
        result = {"energy": value}
    else:
        result = {}

    # Invalid strict fields must not reach value gates merely because their keys
    # exist. The claim registry will report them as missing/UNVERIFIABLE.
    for field in _STRICT_RESULT_FIELDS & set(result):
        if not _valid_provenance_value(field, result[field]):
            result.pop(field)

    conflicts = {}
    expected_digest = _result_digest(value, claim, provenance)
    supplied_digest = payload.get("result_digest")
    if (
        not valid_result_digest(supplied_digest)
        or not hmac.compare_digest(supplied_digest, expected_digest)
    ):
        conflicts["result_digest"] = {
            "value": supplied_digest,
            "expected": expected_digest,
        }
    for field, producer_value in provenance.items():
        if field in _ENVELOPE_CONTROL_FIELDS:
            continue
        if not _valid_provenance_value(field, producer_value):
            continue
        if field not in result:
            result[field] = producer_value
        elif result[field] != producer_value:
            conflicts[field] = {
                "value": result.pop(field),
                "provenance": producer_value,
            }
    return result, inferred_claims, conflicts


def _wrap_batch_results(payload, *, tool, action, inputs):
    """Add one envelope per batch item without changing the legacy result shape."""
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        return None
    wrapped = 0
    for item in payload["items"]:
        if not isinstance(item, dict) or "result_envelope" in item:
            continue
        value = item.get("result")
        if not isinstance(value, dict) or not _valid_provenance_value(
            "energy", value.get("energy")
        ):
            continue
        known = _known_from_payload(value)
        unit = known.pop("unit", None)
        item_inputs = {
            **(inputs or {}),
            "subtask_index": item.get("subtask_index"),
            "work_dir": item.get("work_dir") or value.get("work_dir"),
        }
        item["result_envelope"] = envelope(
            value,
            tool=tool,
            action=action,
            inputs=item_inputs,
            unit=unit,
            claim=_energy_claim(value),
            emitted_by="dispatcher",
            **known,
        )
        wrapped += 1
    if not wrapped:
        return None
    payload["provenance_envelope_count"] = wrapped
    return payload


def batch_payload_is_empty(text):
    """True only for a successfully parsed batch page with exactly zero items."""
    try:
        payload = json.loads(text) if isinstance(text, str) else text
    except (ValueError, TypeError):
        return False
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("items"), list)
        and len(payload["items"]) == 0
    )


_SCIENTIFIC_RESULT_KEYS = {
    "energy", "final_energy", "free_energy", "gibbs_energy", "dG", "dG_eV",
    "E_ads_eV", "E_ads_ZPE_eV", "overpotential", "limiting_potential",
    "band_gap", "band_gap_eV", "d_band_center", "fmax", "max_force",
    "forces", "frequencies", "charges", "magnetic_moment",
}


def _scientific_result(value):
    """Recognize result_json data without mistaking counters/status for physics."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return math.isfinite(float(value))
    if isinstance(value, list):
        return any(_scientific_result(item) for item in value)
    if not isinstance(value, dict):
        return False
    summary = value.get("summary")
    if isinstance(summary, (dict, list)) and _scientific_result(summary):
        return True
    return any(
        key in _SCIENTIFIC_RESULT_KEYS and _scientific_result(item)
        for key, item in value.items()
    )


def workflow_payload_has_results(text):
    """Detect V2 status/step payloads that expose scientific result_json."""
    try:
        payload = json.loads(text) if isinstance(text, str) else text
    except (ValueError, TypeError):
        return False

    def _walk(value):
        if isinstance(value, dict):
            if "result_json" in value and _scientific_result(value["result_json"]):
                return True
            return any(_walk(item) for item in value.values())
        if isinstance(value, list):
            return any(_walk(item) for item in value)
        return False

    return _walk(payload)


def _wrap_workflow_results(payload, *, tool, action, inputs):
    """Attach an envelope beside each numeric V2 task result_json."""
    wrapped = 0

    def _walk(value):
        nonlocal wrapped
        if isinstance(value, dict):
            raw = value.get("result_json")
            parsed = raw
            if isinstance(raw, str):
                try:
                    parsed = json.loads(raw)
                except (ValueError, TypeError):
                    parsed = None
            if (
                "result_envelope" not in value
                and _scientific_result(parsed)
            ):
                payload_value = (
                    parsed.get("summary")
                    if isinstance(parsed, dict)
                    and isinstance(parsed.get("summary"), dict)
                    else parsed
                )
                known = _known_from_payload(payload_value)
                unit = known.pop("unit", None)
                claim = None
                if isinstance(payload_value, dict):
                    if _valid_provenance_value(
                        "energy", payload_value.get("energy")
                    ):
                        claim = _energy_claim(payload_value)
                    elif payload_value.get("analysis_type") == "adsorption_energy":
                        claim = "binding_Eads"
                result_task_id = next(
                    (
                        value.get(key)
                        for key in ("id", "task_id", "step_id", "node_id")
                        if _present(value.get(key))
                    ),
                    None,
                )
                value["result_envelope"] = envelope(
                    payload_value,
                    tool=tool,
                    action=action,
                    inputs=inputs,
                    unit=unit,
                    claim=claim,
                    extra_needs=("result_task_id",),
                    emitted_by="dispatcher",
                    result_task_id=result_task_id,
                    **known,
                )
                wrapped += 1
            for child in list(value.values()):
                _walk(child)
        elif isinstance(value, list):
            for child in value:
                _walk(child)

    _walk(payload)
    return payload if wrapped else None


def claim_for(tool, action=None):
    """Resolve both merged tools and fine-grained prefix families."""
    if tool == "catgo_catalysis":
        return CATALYSIS_CLAIM.get(str(action))
    if tool.startswith("catgo_catalysis_"):
        return CATALYSIS_CLAIM.get(tool.removeprefix("catgo_catalysis_"))
    exact = TOOL_CLAIM.get(tool)
    if exact:
        return exact
    return next(
        (claim for prefix, claim in sorted(
            TOOL_CLAIM.items(), key=lambda item: len(item[0]), reverse=True
        ) if tool.startswith(prefix)),
        None,
    )


def _energy_claim(payload):
    """Use the stricter VASP claim when realized VASP provenance is present."""
    if isinstance(payload, dict) and (
        payload.get("input_manifest_schema_version") is not None
        or str(payload.get("metadata_parser", "")).startswith(
            "catgo.workflow.engine.result_collector._parse_vasp_metadata@"
        )
    ):
        return "vasp_energy"
    return "energy"


def _known_from_payload(payload):
    """Promote only explicit producer fields; never infer method defaults."""
    if not isinstance(payload, dict):
        return {}
    aliases = {
        "n_atoms": ("n_atoms", "total_atoms", "nions"),
        "xc_functional": ("xc_functional",),
        "potcar_titels": ("potcar_titels", "titels"),
        "nelect": ("nelect",),
        "kgrid": ("kgrid",),
        "kpoint_source": ("kpoint_source",),
        "kspacing": ("kspacing",),
        "fmax": ("fmax", "max_force"),
        "ediffg": ("ediffg",),
        "converged": ("converged",),
        "ionic_converged": ("ionic_converged",),
        "solvation": ("solvation",),
        "reference_dir": ("reference_dir",),
        "reference_task_id": ("reference_task_id", "clean_slab_task_id"),
        "reference_digest": ("reference_digest", "clean_slab_digest"),
        "pairing_mode": ("pairing_mode",),
        "lineage_records": ("lineage_records",),
        "declared_role_bindings": ("declared_role_bindings",),
        "slab_adsorbate_task_id": ("slab_adsorbate_task_id",),
        "slab_adsorbate_digest": ("slab_adsorbate_digest",),
        "gas_reference_task_id": ("gas_reference_task_id",),
        "gas_reference_digest": ("gas_reference_digest",),
        "gas_reference_dir": ("gas_reference_dir",),
        "E_ads_eV": ("E_ads_eV",),
        "E_ads_unit": ("E_ads_unit",),
        "dG_ads_eV": ("dG_ads_eV",),
        "dG_ads_unit": ("dG_ads_unit",),
        "zpe_correction_eV": ("zpe_correction_eV",),
        "entropy_correction_eV": ("entropy_correction_eV",),
        "ads_titels": ("ads_titels",),
        "bare_titels": ("bare_titels",),
        "nelect_ads": ("nelect_ads",),
        "nelect_bare": ("nelect_bare",),
        "zval_adsorbate": ("zval_adsorbate",),
        "n_free_atoms": ("n_free_atoms",),
        "n_modes": ("n_modes",),
        "selective_dynamics_present": ("selective_dynamics_present",),
        "temperature": ("temperature",),
        "pressure": ("pressure",),
        "gas_entropy_included": ("gas_entropy_included",),
        "xc_tags": ("xc_tags",),
        "energy_source": ("energy_source",),
        "field_sources": ("field_sources",),
        "metadata_parser": ("metadata_parser",),
        "submission_manifest_digest": ("submission_manifest_digest",),
        "input_hashes": ("input_hashes",),
        "vasp_binary": ("vasp_binary",),
        "resolved_run_command": ("resolved_run_command",),
    }
    known = {}
    for field, candidates in aliases.items():
        for candidate in candidates:
            value = payload.get(candidate)
            if _valid_provenance_value(field, value):
                known[field] = value
                break
    if _present(payload.get("units")):
        known["unit"] = payload["units"]
    elif _present(payload.get("unit")):
        known["unit"] = payload["unit"]
    return known


def wrap_payload(text, *, tool, action, inputs=None):
    """Envelope a tool's JSON payload at the dispatcher, so EVERY numeric tool emits
    provenance instead of only the ones someone remembered to edit.

    Why here and not in each handler: an audit of 178 numeric-returning tools across 18
    public comp-chem agent repos found 59.6% emit no method provenance at all, and the
    dominant cause was not ignorance but DISCARD at the payload boundary — a handler
    builds a rich dict and the wrapper returns one float. One boundary, one fix.

    Returns the enveloped JSON text, or None only for an already-enveloped payload or
    an empty specialized result page. Successful scalar/prose responses are enveloped
    too; otherwise legacy aggregate bookkeeping could not bind a later verification
    to exactly one result.
    """
    import json
    try:
        payload = json.loads(text)
    except (ValueError, TypeError):
        payload = text
    if isinstance(payload, dict) and "provenance" in payload and "value" in payload:
        return None                                  # a handler already enveloped it
    if tool == "catgo_workflow" and str(action) == "batch_results":
        batch = _wrap_batch_results(
            payload, tool=tool, action=action, inputs=inputs
        )
        if batch is not None:
            return json.dumps(batch, indent=2, ensure_ascii=False)
        if batch_payload_is_empty(payload):
            return None
    if tool == "catgo_workflow" and str(action) in {
        "status", "results", "step_error"
    }:
        workflow = _wrap_workflow_results(
            payload, tool=tool, action=action, inputs=inputs
        )
        if workflow is not None:
            return json.dumps(workflow, indent=2, ensure_ascii=False)
    known = _known_from_payload(payload)
    unit = known.pop("unit", None)
    claim = claim_for(tool, action)
    if (
        isinstance(payload, dict)
        and payload.get("analysis_type") == "adsorption_energy"
        and _valid_provenance_value("E_ads_eV", payload.get("E_ads_eV"))
        and not _valid_provenance_value("dG_ads_eV", payload.get("dG_ads_eV"))
    ):
        claim = "binding_Eads"
    if claim == "energy":
        claim = _energy_claim(payload)
    env = envelope(
        payload, tool=tool, action=action, inputs=inputs,
        unit=unit, claim=claim,
        emitted_by="dispatcher", **known,
    )
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
    empty = envelope(1.0, tool="t", action="a", claim="energy",
                     n_atoms=0, xc_functional="", potcar_titels=[],
                     nelect=float("nan"), kgrid={})
    assert empty["unverifiable_without"] == [
        "n_atoms", "xc_functional", "potcar_titels", "nelect", "kgrid"
    ], empty
    untrusted = envelope(1.0, tool="t", action="a", claim="band_gap",
                         inputs={"kgrid_coarse": [3, 3, 1]})
    assert untrusted["unverifiable_without"] == ["kgrid_coarse"], untrusted
    # unregistered claim -> nothing invented
    u = envelope(1.0, tool="t", action="a", claim="something_new")
    assert "unverifiable_without" not in u and u["claim"] == "something_new"
    # dispatcher-level wrapping
    import json as _json
    w = wrap_payload('{"gap_ev": 1.2}', tool="catgo_bands_data", action="data")
    assert _json.loads(w)["claim"] == "band_gap" and "kgrid_coarse" in _json.loads(w)["unverifiable_without"]
    assert _json.loads(w)["provenance"]["emitted_by"] == "dispatcher"
    realized = wrap_payload(_json.dumps({
        "energy": -123.456, "n_atoms": 4, "fmax": 0.015, "ediffg": -0.02,
        "xc_functional": "PBE",
        "potcar_titels": ["PAW_PBE Fe", "PAW_PBE O"],
        "nelect": 32.0, "kgrid": [3, 3, 1],
        "units": {"energy": "eV", "fmax": "eV/Angstrom"},
    }), tool="catgo_energy", action=None)
    realized = _json.loads(realized)
    for field in (
        "n_atoms", "fmax", "ediffg", "xc_functional",
        "potcar_titels", "nelect", "kgrid",
    ):
        assert realized["provenance"][field] is not None, (field, realized)
    assert realized["provenance"]["unit"]["energy"] == "eV", realized
    assert "unverifiable_without" not in realized, realized
    for scalar_or_prose in ("-1.25", "not json {"):
        wrapped = _json.loads(
            wrap_payload(scalar_or_prose, tool="catgo_energy", action="x")
        )
        assert bound_result_digest(wrapped) == wrapped["result_digest"]
    assert wrap_payload(w, tool="catgo_bands_data", action="data") is None   # no double-wrap
    batch = wrap_payload(_json.dumps({
        "items": [{
            "subtask_index": 0,
            "work_dir": "/runs/0",
            "result": {
                "energy": -123.456, "n_atoms": 4,
                "potcar_titels": ["PAW_PBE Fe"], "nelect": 32.0,
                "kgrid": [3, 3, 1], "field_sources": {
                    "energy": "OUTCAR:last_TOTEN",
                    "n_atoms": "OUTCAR:NIONS",
                },
            },
        }],
        "total": 1,
    }), tool="catgo_workflow", action="batch_results",
        inputs={"workflow_id": "wf", "step_id": "sp"})
    batch = _json.loads(batch)
    assert batch["provenance_envelope_count"] == 1, batch
    batch_env = batch["items"][0]["result_envelope"]
    assert batch_env["claim"] == "energy", batch_env
    assert batch_env["provenance"]["n_atoms"] == 4, batch_env
    assert batch["items"][0]["result"]["energy"] == -123.456, batch
    print("provenance envelope self-test OK — declares what it cannot vouch for; "
          "None is not provenance; nothing is invented; dispatcher wraps JSON, scalar, "
          "and successful prose payloads once")

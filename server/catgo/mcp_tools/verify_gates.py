#!/usr/bin/env python3
"""Physics verification gates + verifiability layer for CatBot comp-chem outputs.

Vendored (pure-stdlib) from the ai-agent verification-layer work. Two layers:
  audit(result)              — 16 value gates over the silent-error taxonomy
                               (A1 PAW / A2 range / A3 gas-thermo / B ZPE / C1-C3
                               convergence+exit / D1-D2 freq / E geometry / F3 MLIP
                               force / H k-grid / I field-prov / J label-prov).
  verifiability(result,claims) — the distinguishing feature: refuses to certify a
                               claim whose provenance is absent (flags UNVERIFIABLE
                               instead of silently passing). Catches the value-gate
                               ceiling (G: in-range value, no provenance).
Additive: no existing CatGo module imports or depends on this file.

Design rule: a gate that never fires is worse than no gate — absent inputs are
reported as SKIP (never silently omitted); a claim without provenance is flagged
UNVERIFIABLE (never silently trusted).
"""

from collections import defaultdict

# ---- thresholds: each traces to a recorded real failure ---------------------
PHYS_RANGE = {  # eV, plausible adsorption ΔG windows (ai-screen 物理范围门)
    "default": (-3.5, 3.0),  # FeNi ΔG_OH -4.6~-4.8 → U_L 9.45 V slipped into an 8-host volcano
}
HESSIAN_ASYM_MAX = 1.0   # eV/Å²; clean 0.01-0.37 vs corrupted 4.2-121.7 (D-599)
FREQ_GEOM_MAXDEV = 0.10  # Å; freq run must sit on the current CONTCAR (D2: E -668.4 vs true -701.9 = 33.5 eV off)
E_SANE_PER_ATOM = (-15.0, 0.0)  # eV/atom; C1 caught cached E=-90530 eV on a ~100-atom slab
GAS_SPECIES = {"N2", "H2", "O2", "NH3", "CH4", "CO", "CO2", "H2O"}  # A3: need full gas thermo, not ZPE-only


def _v(gate, ok, detail, cls):
    return {"gate": gate, "taxon": cls, "status": "PASS" if ok else "FAIL", "detail": detail}


def _skip(gate, cls, needs):
    return {"gate": gate, "taxon": cls, "status": "SKIP",
            "detail": f"inputs absent: {needs} (declared, not silently dropped)"}


# ---- A1 PAW / electron-count reference consistency --------------------------
def gate_paw_consistency(ads_titels, bare_titels):
    """Same element must use one POTCAR TITEL across ads/bare pair (D-592).
    Blast radius: Hf_pv→Hf_sv on 1 atom ≈ -3.1 eV; 122 units / 69 catalysts; ran 2 months
    undetected because geometry QC passes 100% (ΔG is a finite, plausible-looking real)."""
    variants = defaultdict(set)
    for t in list(ads_titels) + list(bare_titels):
        parts = t.split()
        if len(parts) >= 2:
            variants[parts[1].split("_")[0]].add(parts[1])
    bad = {el: sorted(vs) for el, vs in variants.items() if len(vs) > 1}
    return _v("paw_consistency", not bad,
              f"mixed POTCAR variants: {bad}" if bad else "consistent", "A1")


def gate_nelect_consistency(nelect_ads, nelect_bare, zval_adsorbate):
    """NELECT(ads) must equal NELECT(bare) + ΣZVAL(adsorbate) (A1 second gate).
    Catches PAW swaps the TITEL gate misses AND cross-directory contamination."""
    expect = nelect_bare + zval_adsorbate
    ok = abs(nelect_ads - expect) < 1e-6
    return _v("nelect_consistency", ok,
              f"NELECT_ads={nelect_ads} vs bare+ΣZVAL={expect}", "A1")


# ---- A2/G physical range ----------------------------------------------------
def gate_physical_range(dG, species="default"):
    """Binding ΔG outside the physical window = reference-mismatch artifact, not chemistry.
    Geometry is 100% normal in these cases — only the number is impossible."""
    lo, hi = PHYS_RANGE.get(species, PHYS_RANGE["default"])
    return _v("physical_range", lo <= dG <= hi,
              f"dG={dG:+.3f} eV vs window [{lo},{hi}] ({species})", "A2")


# ---- A3 gas-phase thermodynamics -------------------------------------------
def gate_gas_thermo_completeness(ladder):
    """Gas-release steps need FULL gas thermo, not ZPE-only (A3).
    Blast radius: NH3 step over-estimated ~0.5-0.6 eV (missing translational+rotational
    entropy) → dG3-as-PDS went 7→2; after also fixing E_NH3 (0.41 eV off): 7/19 → 0/19,
    i.e. the entire 'N-N cleavage is rate-limiting' claim was an artifact."""
    bad = [s for s, d in ladder.items()
           if s in GAS_SPECIES and not d.get("gas_thermo_full")]
    return _v("gas_thermo_completeness", not bad,
              f"gas species with ZPE-only (missing trans+rot entropy): {bad}" if bad
              else "all gas species carry full thermodynamics", "A3")


# ---- B ZPE zero-fill --------------------------------------------------------
def gate_zpe_completeness(ladder):
    """Every ladder species needs ZPE+Gcorr; zero-fill fabricates PDS (B).
    None AND exact 0.0 both count as missing — `zpe or 0.0` is the fingerprint.
    Blast radius: complete-6 67→39; top-ranked Cr_W was falsified."""
    missing = [s for s, d in ladder.items()
               if not d.get("zpe") or not d.get("gcorr")]
    return _v("zpe_completeness", not missing,
              f"species missing thermal corrections: {missing}" if missing else "complete", "B")


# ---- C1/C2 convergence: force-based, never the string -----------------------
def gate_force_convergence(fmax, ediffg):
    """Force-based only. 'reached required accuracy' can be STALE (a restart appends to the
    same OUTCAR, so the old flag survives while the tail energy is garbage): 8 dirs carried
    a false converged flag; Cu3Al_CO cached E=-90530 eV."""
    crit = abs(ediffg)
    return _v("force_convergence", fmax is not None and fmax <= crit,
              f"Fmax={fmax} vs crit={crit} (string flags ignored)", "C1")


def gate_energy_physical(energy, n_atoms):
    """Physical-energy guard, the companion to the force gate (C1).
    Catches cached/garbage energies that are finite and thus survive every string check."""
    lo, hi = E_SANE_PER_ATOM
    per = energy / n_atoms if n_atoms else float("nan")
    return _v("energy_physical", lo <= per <= hi,
              f"E/atom={per:.3f} eV vs window [{lo},{hi}] (E={energy}, N={n_atoms})", "C1")


def gate_opt_converged_flag(opt_conv):
    """Downstream counts MUST gate on opt_conv=='1' (C2). A mid-run OSZICAR energy is a
    real number of normal magnitude on a non-equilibrium geometry — completeness counts
    even go UP. Blast radius: ΔG1 187→184→177 fake 'regression'; honest baseline was 142."""
    ok = str(opt_conv) == "1"
    return _v("opt_converged_flag", ok, f"opt_conv={opt_conv!r} (mid-run energies must not count)", "C2")


# ---- C3 exit-0 masking ------------------------------------------------------
def gate_products_exist(product_paths_found, expected_products):
    """Check PRODUCTS, never the scheduler State (C3). `mpirun ...; echo rc=$?` makes the
    exit code echo's, so SLURM records COMPLETED on a crash: 14 'COMPLETED' jobs had all crashed."""
    missing = sorted(set(expected_products) - set(product_paths_found))
    return _v("products_exist", not missing,
              f"missing products despite job State=COMPLETED: {missing}" if missing
              else "all expected products present", "C3")


# ---- D1/D2 frequency integrity ---------------------------------------------
def gate_hessian_symmetry(max_asym):
    """max|H_ij-H_ji| on the UN-symmetrized Hessian separates clean (0.01-0.37) from
    corrupt (4.2-121.7 eV/Å²) (D-599). This is the gate n_imag CANNOT replace:
    14 of 16 corrupted runs had n_imag=0, i.e. the imaginary-freq gate was 100% blind
    while ZPE was silently wrong."""
    return _v("hessian_symmetry", max_asym <= HESSIAN_ASYM_MAX,
              f"max|H_ij-H_ji|={max_asym} eV/Å² vs {HESSIAN_ASYM_MAX}", "D1")


def gate_freq_geometry_fresh(freq_first_frame_maxdev):
    """The freq run must sit on the CURRENT CONTCAR (D2). A stale-geometry freq still
    reports force_conv=1 and a plausible negative E: one unit gave E=-668.4 vs true -701.9
    (33.5 eV off)."""
    ok = freq_first_frame_maxdev <= FREQ_GEOM_MAXDEV
    return _v("freq_geometry_fresh", ok,
              f"freq frame0 vs CONTCAR maxdev={freq_first_frame_maxdev:.3f} Å vs {FREQ_GEOM_MAXDEV}", "D2")


# ---- F3 MLIP force quality: relative, not absolute --------------------------
def gate_relative_force_rmse(rmse_f, force_std, max_rel=0.30):
    """Absolute RMSE_F flatters near-equilibrium-only training sets (F3).
    RMSE_F=100.1 meV/Å looks respectable while relative RMSE=80.85%, i.e. the model
    explains only 19% of force variance — useless for relaxation/MD."""
    rel = rmse_f / force_std if force_std else float("inf")
    return _v("relative_force_rmse", rel <= max_rel,
              f"relative F RMSE={rel:.1%} (RMSE_F={rmse_f}, σ_F={force_std}) vs {max_rel:.0%}", "F3")


# ---- D3 residual imaginary frequency (corpus-informed, added after the
# independent-corpus eval exposed it as a blind spot — the Hessian-symmetry gate
# deliberately replaced n_imag for CORRUPTION detection, but a *clean* Hessian
# with genuine residual imaginary modes is its own failure class: ai-screen
# certification gate 2 (residual imag) + D-497 (fake 2570-24956 cm^-1 modes).
# NOTE for honest reporting: any number quoted on the same corpus that taught us
# this gate is corpus-informed, not held-out.) --------------------------------
IMAG_TOL_CM = 50.0  # cm^-1; ai-screen convention (imag_borderline band is 50-100i)


def gate_residual_imag(n_imag, imag_max_cm=None):
    """Adsorbate residual imaginary modes after relaxation (D3).
    n_imag == 0 passes. n_imag > 0 with no magnitude info fails (no evidence the
    modes are soft); with magnitude, fails above IMAG_TOL_CM."""
    if n_imag == 0:
        return _v("residual_imag", True, "n_imag=0", "D3")
    if imag_max_cm is None:
        return _v("residual_imag", False,
                  f"n_imag={n_imag} with no magnitude info (cannot claim soft modes)", "D3")
    return _v("residual_imag", imag_max_cm <= IMAG_TOL_CM,
              f"n_imag={n_imag}, max imag {imag_max_cm} cm^-1 vs tol {IMAG_TOL_CM}", "D3")


# ---- G2 limiting-potential physical window (corpus-informed, same caveat as
# D3: learned from the independent corpus — FeNi UL_OER=9.452 V from a
# reference-mismatch artifact sailed through every per-step gate) -------------
UL_RANGE_V = (-2.0, 3.5)  # V; thermodynamic limit + any plausible overpotential


def gate_ul_range(ul_v):
    lo, hi = UL_RANGE_V
    return _v("ul_range", lo <= ul_v <= hi,
              f"U_L={ul_v:+.3f} V vs physical window [{lo},{hi}]", "G2")


# ---- E geometry parse sanity (min interatomic pair) ------------------------
def gate_min_pair(min_pair_ang, lo=0.7, hi=5.0):
    """Nearest interatomic distance must be physical (E).
    < 0.7 Å = clash / overlap collapse; > 5 Å in a condensed phase = a parse error,
    e.g. a Cartesian CONTCAR re-multiplied by the lattice → fake min_pair ~30 Å
    (feedback_structure_harvest_silent_traps). Numerically judgeable → a gate can catch it."""
    return _v("min_pair", lo <= min_pair_ang <= hi,
              f"min interatomic pair={min_pair_ang:.2f} Å vs physical [{lo},{hi}]", "E")


# ---- H k-grid boundary gap (numeric + method flag) -------------------------
def gate_kgrid_gap_boundary(gap_ev, kgrid_coarse, boundary=0.05):
    """A near-zero indirect gap from a COARSE k-grid can miss the band extremum and
    flip metal/semiconductor (H). |gap| < 0.05 eV on a coarse grid → must re-check on a
    dense band path (W6Se8: coarse +27 meV 'semiconductor' → dense -14.5 meV semimetal,
    feedback_coarse_kgrid_indirect_gap_sign_flip_semimetal)."""
    ok = not (kgrid_coarse and abs(gap_ev) < boundary)
    return _v("kgrid_gap_boundary", ok,
              f"gap={gap_ev*1000:.1f} meV on {'coarse' if kgrid_coarse else 'dense'} grid "
              f"(|gap|<{boundary*1000:.0f} meV on coarse needs dense recheck)", "H")


# ---- I/J provenance gates: catchable ONLY if the trace carries origin metadata
def gate_field_provenance(pc_field_source):
    """A silent fallback (field set to zeros and treated as vacuum) shifts energies
    ~0.5 eV while dG stays in the physical range, so no VALUE gate catches it (I). It is
    catchable ONLY because the trace declares its source: any 'fallback'/'zeros' origin
    is untrusted (feedback_frozen_pc_field_ood). No provenance field → not verifiable."""
    src = str(pc_field_source).lower()
    ok = not ("fallback" in src or "zeros" in src or "vacuum" in src)
    return _v("field_provenance", ok, f"field source={pc_field_source!r} (fallback/zeros = untrusted)", "I")


def gate_label_provenance(netq_true, netq_label):
    """A stratification label rebuilt heuristically (RDKit pH7) can disagree with the
    quantity actually fed to the calc (prmtop netq) — 30.3% mislabeled, fabricating a
    clean-looking mirror (J, feedback_stratify_by_quantity_actually_fed_to_calc). Catchable
    ONLY when BOTH the true and the label value are carried; a value gate alone cannot."""
    ok = netq_true == netq_label
    return _v("label_provenance", ok, f"label netq={netq_label} vs true netq={netq_true}", "J")


# ---- audit: coverage-aware, no silent skips --------------------------------
_SPEC = [
    ("physical_range",          "A2", ("dG",),                                   lambda r: gate_physical_range(r["dG"], r.get("species", "default"))),
    ("paw_consistency",         "A1", ("ads_titels", "bare_titels"),             lambda r: gate_paw_consistency(r["ads_titels"], r["bare_titels"])),
    ("nelect_consistency",      "A1", ("nelect_ads", "nelect_bare", "zval_adsorbate"), lambda r: gate_nelect_consistency(r["nelect_ads"], r["nelect_bare"], r["zval_adsorbate"])),
    ("gas_thermo_completeness", "A3", ("ladder",),                               lambda r: gate_gas_thermo_completeness(r["ladder"])),
    ("zpe_completeness",        "B",  ("ladder",),                               lambda r: gate_zpe_completeness(r["ladder"])),
    ("force_convergence",       "C1", ("fmax",),                                 lambda r: gate_force_convergence(r["fmax"], r.get("ediffg", -0.02))),
    ("energy_physical",         "C1", ("energy", "n_atoms"),                     lambda r: gate_energy_physical(r["energy"], r["n_atoms"])),
    ("opt_converged_flag",      "C2", ("opt_conv",),                             lambda r: gate_opt_converged_flag(r["opt_conv"])),
    ("products_exist",          "C3", ("products_found", "products_expected"),   lambda r: gate_products_exist(r["products_found"], r["products_expected"])),
    ("hessian_symmetry",        "D1", ("hessian_max_asym",),                     lambda r: gate_hessian_symmetry(r["hessian_max_asym"])),
    ("freq_geometry_fresh",     "D2", ("freq_frame0_maxdev",),                   lambda r: gate_freq_geometry_fresh(r["freq_frame0_maxdev"])),
    ("relative_force_rmse",     "F3", ("rmse_f", "force_std"),                   lambda r: gate_relative_force_rmse(r["rmse_f"], r["force_std"])),
    ("min_pair",                "E",  ("min_pair_ang",),                         lambda r: gate_min_pair(r["min_pair_ang"])),
    ("kgrid_gap_boundary",      "H",  ("gap_ev", "kgrid_coarse"),                lambda r: gate_kgrid_gap_boundary(r["gap_ev"], r["kgrid_coarse"])),
    ("field_provenance",        "I",  ("pc_field_source",),                      lambda r: gate_field_provenance(r["pc_field_source"])),
    ("label_provenance",        "J",  ("netq_true", "netq_label"),               lambda r: gate_label_provenance(r["netq_true"], r["netq_label"])),
    ("residual_imag",           "D3", ("n_imag",),                               lambda r: gate_residual_imag(r["n_imag"], r.get("imag_max_cm"))),
    ("ul_range",                "G2", ("ul_v",),                                 lambda r: gate_ul_range(r["ul_v"])),
]


def audit(result, require=None):
    """result: dict of whatever the trace carries. require: optional iterable of gate
    names that MUST run (raises if their inputs are absent) — use it in a benchmark so a
    trace missing a field fails loudly instead of scoring a silent clean sheet.

    Returns {"verdicts": [...], "coverage": {"ran": n, "skipped": n, "failed": n, ...}}.
    Every gate in _SPEC appears in verdicts with PASS/FAIL/SKIP — never omitted (D-010 K).
    """
    verdicts = []
    for name, cls, needs, fn in _SPEC:
        if all(k in result for k in needs):
            verdicts.append(fn(result))
        else:
            verdicts.append(_skip(name, cls, needs))

    if require:
        skipped = {v["gate"] for v in verdicts if v["status"] == "SKIP"}
        blind = sorted(set(require) & skipped)
        if blind:
            raise ValueError(f"required gates could not run (missing inputs): {blind}")

    ran = [v for v in verdicts if v["status"] != "SKIP"]
    failed = [v for v in ran if v["status"] == "FAIL"]
    return {
        "verdicts": verdicts,
        "coverage": {
            "ran": len(ran), "skipped": len(verdicts) - len(ran),
            "failed": len(failed), "gates_total": len(_SPEC),
            "failed_taxa": sorted({v["taxon"] for v in failed}),
            "skipped_gates": sorted(v["gate"] for v in verdicts if v["status"] == "SKIP"),
        },
    }


def catch_rate(cases):
    """cases: [(result_dict, should_fail_bool)] → catch-rate report for error-injection runs.
    This is the number the paper reports; without it a gate suite is unfalsifiable."""
    tp = fp = fn = tn = 0
    for result, should_fail in cases:
        caught = any(v["status"] == "FAIL" for v in audit(result)["verdicts"])
        if should_fail and caught:
            tp += 1
        elif should_fail and not caught:
            fn += 1
        elif not should_fail and caught:
            fp += 1
        else:
            tn += 1
    n_bad = tp + fn
    return {"caught": tp, "missed": fn, "false_alarms": fp, "clean_passed": tn,
            "catch_rate": tp / n_bad if n_bad else None}


# ============================================================================
# Verifiability layer — the distinguishing feature (D-014)
# ----------------------------------------------------------------------------
# The value gates above answer "is this number wrong?". Some silent errors
# (taxon G: ΔG_H* missing H2 gas entropy) produce a number that is inside the
# physical range AND carry no provenance, so NO value gate can ever catch them
# (D-013 ceiling result). The verifiability layer answers the prior question:
# "does this result even carry the provenance needed to check the claim it makes?"
# If not, the result is flagged UNVERIFIABLE — a red flag, not a silent pass.
#
# This is the optimization that sets our agent apart: existing comp-chem agents
# (AtomisticSkills, VaspAgent) report a result as done once the run exits 0; ours
# refuses to certify a claim whose provenance is absent. It turns an unverifiable
# output from a silent success into an explicit "cannot verify — do not trust".
# ============================================================================

# claim_type → provenance a downstream checker needs to verify that class of claim.
# any_of: at least one field-group must be fully present. all_of: every field required.
PROVENANCE_SPEC = {
    "binding_dG":   {"any_of": [("ads_titels", "bare_titels"),
                                ("nelect_ads", "nelect_bare", "zval_adsorbate")],
                     "why": "a ΔG difference is only meaningful if PAW set / electron count is self-consistent (A1)"},
    "her_dGH":      {"all_of": [("gas_entropy_included",)],
                     "why": "ΔG_H* must declare whether H2 gas-phase entropy was included (G: 0.15 eV, in-range, else invisible)"},
    "band_gap":     {"all_of": [("kgrid_coarse",)],
                     "why": "a near-zero gap's sign depends on k-grid density; the grid must be declared (H)"},
    "field_energy": {"all_of": [("pc_field_source",)],
                     "why": "energy under a field is trustworthy only if the field is real, not a fallback (I)"},
    "stratified":   {"all_of": [("label_source", "netq_true"),],
                     "why": "a stratification label must be traceable to the value actually fed to the calc (J)"},
    "converged_E":  {"all_of": [("opt_conv",)],
                     "why": "an energy is only usable if it comes from a converged geometry, not a mid-run frame (C2)"},
}


# default-deny policy: statuses a caller must treat as "not certified" (never a pass)
NOT_CERTIFIED = ("UNVERIFIABLE", "UNKNOWN-CLAIM")


def _group_present(result, group):
    # a key must be present AND carry a non-empty value — None / [] / {} / "" do NOT
    # satisfy provenance (else a claim declaring `ads_titels: None` would be certified).
    return all(result.get(k) not in (None, [], {}, "") for k in group)


def workflow_consistency(steps):
    """steps: ordered list of per-step result dicts from ONE workflow
    (relax→static→dos→bader, or NEB endpoints→images). Extends the *pairwise*
    gate_paw_consistency to the whole DAG — SOTA agents validate a single result,
    not the chain. The A1 PAW cross-directory bug (Hf_pv in the bare slab, Hf_sv in
    the adsorbate step, -3.1 eV, 122 units, 2 months undetected) IS a cross-step
    inconsistency; caught here as a workflow property, not per-step.

    Checks (each runs only when the fields are present across steps, else declared):
      (1) POTCAR TITEL set identical across steps — an element's variant must not change
      (2) ENCUT monotone non-decreasing — a later step must not silently lower the cutoff
      (3) k-grid identical across steps
    ponytail: geometry hand-off (relax final == next-step initial, maxdev) needs the
    structure objects; add once workflow trace ingestion carries per-step geometry.
    Returns a list of verdicts (gate/taxon 'WF'/status/detail).
    """
    out = []
    labels = [s.get("step", str(i)) for i, s in enumerate(steps)]

    # (1) POTCAR variant per element must be identical across every step that declares it
    if sum("titels" in s for s in steps) >= 2:
        per_el = defaultdict(set)
        for s in steps:
            for t in s.get("titels", []):
                parts = t.split()
                if len(parts) >= 2:
                    per_el[parts[1].split("_")[0]].add(parts[1])
        bad = {el: sorted(v) for el, v in per_el.items() if len(v) > 1}
        out.append(_v("wf_potcar_consistency", not bad,
                      f"element(s) using >1 PAW variant across steps: {bad}" if bad
                      else f"POTCAR set consistent across {labels}", "WF"))
    else:
        out.append(_skip("wf_potcar_consistency", "WF", ("titels×≥2 steps",)))

    # (2) ENCUT must not decrease down the chain
    encuts = [(s.get("step", str(i)), s["encut"]) for i, s in enumerate(steps) if "encut" in s]
    if len(encuts) >= 2:
        ok = all(encuts[i][1] <= encuts[i + 1][1] + 1e-9 for i in range(len(encuts) - 1))
        out.append(_v("wf_encut_monotone", ok,
                      f"ENCUT chain {encuts} must be non-decreasing", "WF"))
    else:
        out.append(_skip("wf_encut_monotone", "WF", ("encut×≥2 steps",)))

    # (3) k-grid identical across steps
    kgrids = [s["kgrid"] for s in steps if "kgrid" in s]
    if len(kgrids) >= 2:
        ok = len(set(map(str, kgrids))) == 1
        out.append(_v("wf_kgrid_consistency", ok,
                      f"k-grids differ across steps: {kgrids}" if not ok
                      else f"k-grid consistent ({kgrids[0]})", "WF"))
    else:
        out.append(_skip("wf_kgrid_consistency", "WF", ("kgrid×≥2 steps",)))

    return out


def verifiability(result, claims):
    """result: the agent's output dict. claims: iterable of claim_type strings the
    result asserts (e.g. ['her_dGH']). Returns one verdict per claim:
      VERIFIABLE      — provenance present, the value gates can do their job
      UNVERIFIABLE    — the claim is made but provenance to check it is absent → red flag
      UNKNOWN-CLAIM   — we have no provenance spec for this claim type
    A result that scores VERIFIABLE is not thereby correct — it is merely checkable.

    DEFAULT-DENY (policy): UNKNOWN-CLAIM is NOT a silent pass. A claim we cannot even
    describe the provenance for is, by policy, not certified — callers must treat both
    UNVERIFIABLE and UNKNOWN-CLAIM as not-certified. Otherwise an unregistered claim
    type becomes a silent channel, contradicting the whole "no provenance = red flag"
    design (an incomplete registry would then quietly weaken the guarantee).
    """
    out = []
    for claim in claims:
        spec = PROVENANCE_SPEC.get(claim)
        if spec is None:
            out.append({"claim": claim, "status": "UNKNOWN-CLAIM",
                        "detail": "no provenance spec registered for this claim type"})
            continue
        if "any_of" in spec:
            ok = any(_group_present(result, g) for g in spec["any_of"])
            need = " OR ".join("+".join(g) for g in spec["any_of"])
        else:
            groups = spec["all_of"]
            ok = all(_group_present(result, g) for g in groups)
            need = " AND ".join("+".join(g) for g in groups)
        out.append({"claim": claim,
                    "status": "VERIFIABLE" if ok else "UNVERIFIABLE",
                    "detail": (f"provenance present ({need})" if ok
                               else f"MISSING provenance ({need}) — {spec['why']}")})
    return out

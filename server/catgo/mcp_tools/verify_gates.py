#!/usr/bin/env python3
"""Physics verification gates + verifiability layer for CatBot comp-chem outputs.

Vendored (pure-stdlib) from the ai-agent verification-layer work. Three entry points:
  audit(result)                  — value gates over the silent-error taxonomy, each
                                   PASS/FAIL/SKIP (absent inputs declared, never dropped).
  verifiability(result, claims)  — refuses to certify a claim whose provenance is absent
                                   (UNVERIFIABLE), default-deny for unregistered claims.
  workflow_consistency(steps) / harvest_consistency(rows, ...)
                                 — cross-step and cross-record identities that no
                                   single-result gate can see.
Additive: no existing CatGo module imports or depends on this file.

Design rule: a gate that never fires is worse than no gate — absent inputs are reported
as SKIP; a claim without provenance is flagged UNVERIFIABLE, never silently trusted.

GENERATED from catgo-projects/data/ai-agent/agentbench/verifier.py by sync_copies.py —
edit that file, not this one.
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


# ---- G2 limiting potential: NO value gate (see below) ----------------------


# RETIRED as a value gate (D-030). Measured on the independent corpus, the good
# and bad U_L populations OVERLAP: accepted results reach +6.550 V (strong-binder
# regime, geometry verified) while a reference-mismatch artifact sits at +6.346 V.
# The zero-false-alarm ceiling of ANY window is 2/4 catches; the deployed [-2.0,3.5]
# window bought 2 catches at the price of every false alarm the suite had (6/79).
# Tuning it would be fitting the test set. The information that separates the two
# populations is not the magnitude — it is which reaction, which reference state and
# which PCET convention produced it, i.e. provenance. So U_L moves to the
# verifiability layer as the claim `limiting_potential`; see eval_threshold_separability.py.


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


# ===========================================================================
# D-030 batch: deductive gates mined from 477 memory notes + 4438 decisions
# across 65 projects (analysis/NEW_GATE_SPECS_2026-07-25.md). Every one is an
# IDENTITY or a conservation law — pass/fail with no tunable threshold, so none
# of them can be accused of a fitted constant. Each cites the recorded case and
# its blast radius. They are PROVISIONAL: exercised by the self-test on the real
# recorded numbers, but not yet by a held-out corpus (their input fields are not
# in corpus v1 — see PROVISIONAL_GATES and eval_gate_audit.py).
# ===========================================================================

# VASP legally coerces these, so an echo differing from the request is not a fault
_VASP_COERCED_TAGS = {"NBANDS", "NPAR", "NCORE", "KPAR", "ISMEAR", "LREAL", "LMAXMIX"}


def gate_incar_tag_echo_identity(incar_requested, outcar_param_echo):
    """What was asked must be what ran (K1). The `vasp.6.4.2-cp` build parses only the
    FIRST tag on a space-separated INCAR line; every later tag silently falls back to its
    default, with no error and no warning. The run converges and reports energies computed
    under settings nobody chose.
    Case: ai-emlp-iface D-78 (feedback_vasp_cp_build_one_tag_per_line_incar) — the line
    `ALGO=All PREC=Accurate ENCUT=450 GGA=PE IVDW=12` applied ALGO only, so the campaign
    ran with IVDW=0 (no D3) and ISPIN=1 (no spin); NELM fell 500 -> 60.
    Blast radius: a whole multi-stage campaign on unchosen physics; every absolute
    capacitance / PZC / energy had to be recomputed."""
    mismatch = {}
    for tag, want in incar_requested.items():
        if tag in _VASP_COERCED_TAGS or tag not in outcar_param_echo:
            continue
        got = outcar_param_echo[tag]
        try:
            same = abs(float(want) - float(got)) < 1e-9
        except (TypeError, ValueError):
            same = str(want).strip().upper() == str(got).strip().upper()
        if not same:
            mismatch[tag] = f"asked {want!r}, ran {got!r}"
    return _v("incar_tag_echo_identity", not mismatch,
              f"INCAR request vs OUTCAR echo: {mismatch}" if mismatch
              else f"all {len(incar_requested)} requested tags echoed as applied", "K1")


def gate_grand_potential_energy(energy_source, nelect_states, lcep=True):
    """Under constant potential, compared states float to DIFFERENT NELECT, so a canonical
    TOTEN difference silently omits mu_e*dN_e (K2). The number has the right units and a
    plausible magnitude.
    Case: ai-strain D-108/109 (feedback_fcp_lcep_use_gce_not_canonical_energy) — naive
    E(H*)-E(clean) gave Mo2CO2 dG_H* = -6 eV and a 5.6 eV spread across strain, all
    artefact; the build's own GCE field restored physical values.
    Deductive: if NELECT differs across the compared states and the energies are TOTEN,
    the comparison is provably missing a term. Canonical fixed-NELECT runs are exempt."""
    vals = {round(float(n), 6) for n in nelect_states}
    floated = len(vals) > 1
    ok = (not lcep) or (not floated) or str(energy_source).upper() == "GCE"
    return _v("grand_potential_energy", ok,
              f"energy_source={energy_source!r}, NELECT across states={sorted(vals)}"
              + (" — TOTEN differences omit mu_e*dN_e" if not ok else ""), "K2")


# elements whose valence configuration carries d (l=2) or f (l=3) occupancy
_D_BLOCK = set("Sc Ti V Cr Mn Fe Co Ni Cu Zn Y Zr Nb Mo Tc Ru Rh Pd Ag Cd "
               "Hf Ta W Re Os Ir Pt Au Hg".split())
_F_BLOCK = set("La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu "
               "Ac Th Pa U Np Pu".split())


def gate_lmaxmix_covers_valence(titels, lmaxmix):
    """LMAXMIX must reach 2*l_max of the valence shell: d -> 4, f -> 6 (K3). The default 2
    mixes only up to l=1, so with d electrons the d density is not fully mixed; SCF
    oscillates, hits NELM, and settles in a spurious metastable spin solution that then
    reports a converged energy.
    Case: ai-plasma D-41 (feedback_vasp_lmaxmix_4_for_d_electrons) — all intermediates
    missing LMAXMIX hit NELM=120 with oscillating dE; magmom n_vac +2.59 / nh2 -0.57 /
    CycleB -6.5 uB while the clean slab is ~0, producing a false PDS *NH -> *NH2 = +0.85 eV.
    No false-alarm cost: LMAXMIX=4 on an s/p-only system is merely slightly slower."""
    els = {t.split()[1].split("_")[0] for t in titels if len(t.split()) >= 2}
    need = 6 if (els & _F_BLOCK) else (4 if (els & _D_BLOCK) else 2)
    return _v("lmaxmix_covers_valence", lmaxmix is not None and lmaxmix >= need,
              f"LMAXMIX={lmaxmix} vs required {need} for {sorted(els & (_D_BLOCK | _F_BLOCK)) or 's/p only'}",
              "K3")


def gate_gas_reference_spin(species, magnetization, e_total=None):
    """A closed-shell gas reference must come out with zero net moment (K4). With ISPIN=2
    and a default MAGMOM, H2 happily converges to the FERROMAGNETIC DISSOCIATED triplet:
    SCF converges, relaxation converges, the energy is a real number.
    Case: ai-seawater D-39 (feedback_vasp_gas_h2_highspin_dissociation_nupdown0) —
    E(H2) ~ -2.2 eV instead of -6.77 eV, OSZICAR mag=2.0000 throughout, H-H stretched
    0.74 -> ~3.5 A. Every CHE step was biased +2.27 eV. NUPDOWN=0 fixed it:
    E(H2) = -6.76881170 eV, mag = 0.
    Deductive for the closed-shell set; O2 (triplet ground state) is excluded by name."""
    closed_shell = {"H2", "N2", "H2O", "CO", "CO2", "CH4", "NH3"}
    if str(species) not in closed_shell:
        return _v("gas_reference_spin", True, f"{species} is not in the closed-shell set", "K4")
    ok = abs(float(magnetization)) < 0.05
    detail = f"{species} net moment={magnetization} (closed shell must be 0)"
    if e_total is not None:
        detail += f", E={e_total}"
    return _v("gas_reference_spin", ok, detail, "K4")


def gate_partial_hessian_dof(n_modes, n_free_atoms):
    """A partial Hessian is defined by which atoms are free: n_modes == 3 * n_free (K5).
    A POSCAR missing `Selective dynamics` makes the frequency tool compute ALL modes; the
    thermal correction is then a perfectly finite, plausible number of the wrong magnitude.
    Case: ai-gs D-010 — vaspkit task 501 produced 285 modes over 95 atoms instead of the
    12 modes of the 4 free NH3 atoms; G_corr came out 2.799 eV against the sibling Mo
    value 0.965 eV (delta -1.834 eV), moving the W Distal onset 0.876 -> -0.16 V vs SHE.
    Exactly 1 of 60+ freq POSCARs was affected — a per-file gate, not a per-campaign one.
    Pure identity: a deliberately full Hessian still satisfies it with n_free = n_atoms."""
    expect = 3 * int(n_free_atoms)
    return _v("partial_hessian_dof", int(n_modes) == expect,
              f"n_modes={n_modes} vs 3*n_free_atoms={expect} (n_free={n_free_atoms})", "K5")


def gate_optimizer_step_budget(ibrion, nsw, n_ionic_steps=None):
    """An optimiser that took no steps still writes a clean output and exits COMPLETED (K6).
    Case: ai-strain D-131 — a VTST NEB with `IBRION=3 POTIM=0 IOPT=3` and no NSW line
    defaulted to NSW=0, so every image froze at its IDPP starting geometry and the barriers
    came out 3-5 eV too high; the diagnostic was 'each image OSZICAR has only 1 F= step'.
    Exempt on the intentional single-point pair IBRION=-1 with NSW=0."""
    if int(ibrion) < 0:
        return _v("optimizer_step_budget", True, f"IBRION={ibrion} (single point, NSW ignored)", "K6")
    ok = nsw is not None and int(nsw) >= 1
    if ok and n_ionic_steps is not None:
        ok = int(n_ionic_steps) >= 2
    return _v("optimizer_step_budget", ok,
              f"IBRION={ibrion} NSW={nsw} ionic_steps={n_ionic_steps} "
              f"(an optimisation that took <2 steps optimised nothing)", "K6")


def gate_dos_electron_count(dos_integral, nelect, tol=0.02):
    """Integrating the DOS to the Fermi level must return the electron count (K7).
    A sum rule, so no threshold: if it does not, the DOS was integrated wrongly — k-point
    weights dropped, or the energy window truncated — and every quantity derived from it
    (magnetic moment, d-band centre, N(E_F)) is wrong while looking perfectly plausible.
    Cases (both from ai-spin, and both invisible to every other gate):
      - DOS harvested with an UNWEIGHTED k-point sum gave Cr magmom = 74 uB, while the
        DFT run's own `mags` field held the physical 2-3 uB and no value was ever > 8.
      - A truncated DOS window produced a 73 uB moment entirely from s-orbital spin-up
        (sum_up 73.62 vs sum_dn 0.88), i.e. the missing channel was simply outside the
        window that was integrated."""
    err = abs(float(dos_integral) - float(nelect)) / max(abs(float(nelect)), 1.0)
    return _v("dos_electron_count", err <= tol,
              f"integral(DOS)={dos_integral} vs NELECT={nelect} "
              f"({err:.1%} off — k-point weights or window)", "K7")


def gate_relaxation_minimum_endpoint(energy_series, tol=0.005):
    """A relaxation must END at the lowest energy it found (K8). The force criterion can
    trigger on a shoulder: forces fall below EDIFFG while the energy has already risen off
    the minimum, so the run stops, reports 'reached required accuracy', and hands back a
    point that is not the minimum it already walked through.
    Case: 8 ionic steps, stopped on max force 0.00848 < 0.01, but step2 = -298.550 eV and
    step8 = -298.526 eV — the reported endpoint is 24 meV ABOVE a geometry the same run
    had already visited.
    Deductive: an optimiser's own trajectory is the witness; no external threshold."""
    es = [float(e) for e in energy_series]
    best = min(es)
    gap = es[-1] - best
    return _v("relaxation_minimum_endpoint", gap <= tol,
              f"E_final={es[-1]:.3f} eV is {gap*1000:.0f} meV above the run's own minimum "
              f"{best:.3f} eV (step {es.index(best)+1}/{len(es)})", "K8")


def gate_restoring_force_sign(r_series, r0):
    """A restoring bias must move the coordinate TOWARD its target (K9). Sign errors in a
    biasing force are silent: the simulation runs, the thermostat reports a sane
    temperature, and the collective variable simply drifts the wrong way.
    Case: `adjust_forces` used f = -k(r-r0)u while ASE's get_distance vector points i->j,
    so the restraint pushed the cation AWAY: a pilot with r0 = 3.0 A ended at r = 6.13 A
    (std 1.62) with E = +733 +/- 1058 eV.
    Deductive: compare |r-r0| at the start and end of the biased segment."""
    rs = [float(x) for x in r_series]
    start, end = abs(rs[0] - float(r0)), abs(rs[-1] - float(r0))
    return _v("restoring_force_sign", end <= start,
              f"|r-r0| grew {start:.2f} -> {end:.2f} A under a restraint targeting "
              f"r0={r0} (a restoring force cannot push away)", "K9")


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
    ("incar_tag_echo_identity", "K1", ("incar_requested", "outcar_param_echo"),  lambda r: gate_incar_tag_echo_identity(r["incar_requested"], r["outcar_param_echo"])),
    ("grand_potential_energy",  "K2", ("energy_source", "nelect_states"),        lambda r: gate_grand_potential_energy(r["energy_source"], r["nelect_states"], r.get("lcep", True))),
    ("lmaxmix_covers_valence",  "K3", ("ads_titels", "lmaxmix"),                 lambda r: gate_lmaxmix_covers_valence(r["ads_titels"], r["lmaxmix"])),
    ("gas_reference_spin",      "K4", ("species", "magnetization"),              lambda r: gate_gas_reference_spin(r["species"], r["magnetization"], r.get("energy"))),
    ("partial_hessian_dof",     "K5", ("n_modes", "n_free_atoms"),               lambda r: gate_partial_hessian_dof(r["n_modes"], r["n_free_atoms"])),
    ("optimizer_step_budget",   "K6", ("ibrion", "nsw"),                         lambda r: gate_optimizer_step_budget(r["ibrion"], r["nsw"], r.get("n_ionic_steps"))),
    ("dos_electron_count",      "K7", ("dos_integral", "nelect"),                lambda r: gate_dos_electron_count(r["dos_integral"], r["nelect"])),
    ("relaxation_minimum_endpoint", "K8", ("energy_series",),                    lambda r: gate_relaxation_minimum_endpoint(r["energy_series"])),
    ("restoring_force_sign",    "K9", ("r_series", "r0"),                        lambda r: gate_restoring_force_sign(r["r_series"], r["r0"])),
]

# Added in the D-030 batch: proven on their recorded cases in the self-test, but their
# input fields do not exist in corpus v1, so no held-out corpus has exercised them yet.
# eval_gate_audit.py separates these from gates that are dead for lack of firing.
PROVISIONAL_GATES = {"incar_tag_echo_identity", "grand_potential_energy",
                     "lmaxmix_covers_valence", "gas_reference_spin",
                     "partial_hessian_dof", "optimizer_step_budget",
                     "dos_electron_count", "relaxation_minimum_endpoint",
                     "restoring_force_sign"}


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
    "limiting_potential":
                    {"all_of": [("ul_reaction",), ("ul_reference",), ("ul_convention",)],
                     "why": "U_L magnitude alone cannot separate a strong-binder result from a "
                            "reference-mismatch artifact (their ranges overlap on the independent "
                            "corpus: accepted +6.550 V vs artifact +6.346 V) — the reaction, the "
                            "reference state and the PCET convention are what make it checkable (G2)"},
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


def harvest_consistency(rows, key_fields, value_field, tol=1e-6):
    """rows: harvested records from >=1 host/run. Two CROSS-RECORD identities that no
    single-result gate can see (D-030 batch, taxon HV).

    (1) duplicate-key agreement — two hosts computed the same cell and both wrote a row.
        Neither errored; the table just has extra rows and every aggregate double-counts.
        Case: ai-pbsa D-117 (feedback_multihost_harvest_duplicate_keys_disagree) — 268
        duplicated (combo, system, ligand) keys, 244 of them DISAGREE on dg_bind, median
        4.09 kcal/mol, worst 77314.93. Not float32 noise (~0.5 kcal). The headline claim
        "MACEPOL >> AIMNet2, 0.309 vs 0.137" was comparing 597 cells against 11 and was
        overturned by the matched subset. NEVER average duplicates — averaging hides a
        77315 kcal/mol disagreement.
    (2) variational lower bound — SCF is a minimisation, so on the SAME geometry a
        converged HIGHER energy is provably a spurious metastable state, however smooth
        its forces and however happily it met EDIFF.
        Case: ai-xmat D-27 — ALGO=Normal "converged" cu_ref/clean at -142.30 eV while
        ALGO=All reached -191.36 eV (sibling scale ~ -2.98 eV/atom): 49.06 eV of pure
        spurious-state error, caused by MAGMOM=64*1.0 on non-magnetic Cu. D-38: NUPDOWN
        locked to the clean-slab moment gave Fe_CO dE +6.10 eV and Mn ~ +8.4 eV.
    Both are deductive: uniqueness/agreement and an inequality that minimisation
    guarantees. Records must declare `geometry_hash` for (2) — without it the comparison
    is not defined, and the check is declared SKIP rather than guessed."""
    out = []

    dupes = defaultdict(list)
    for r in rows:
        if all(k in r for k in key_fields) and value_field in r:
            dupes[tuple(r[k] for k in key_fields)].append(r)
    dup_keys = {k: v for k, v in dupes.items() if len(v) > 1}
    if dup_keys:
        disagree = {}
        for k, group in dup_keys.items():
            vals = [float(r[value_field]) for r in group]
            if max(vals) - min(vals) > tol:
                disagree[k] = (min(vals), max(vals),
                               sorted({str(r.get("source_host", "?")) for r in group}))
        worst = max((hi - lo for lo, hi, _ in disagree.values()), default=0.0)
        out.append(_v("hv_duplicate_agreement", not disagree,
                      f"{len(disagree)}/{len(dup_keys)} duplicated keys disagree on "
                      f"{value_field}; worst spread {worst:.2f}" if disagree
                      else f"{len(dup_keys)} duplicated keys all agree within {tol}", "HV"))
    else:
        out.append(_v("hv_duplicate_agreement", True,
                      f"no duplicated {key_fields} keys among {len(rows)} rows", "HV"))

    by_geom = defaultdict(list)
    for r in rows:
        if "geometry_hash" in r and "energy" in r:
            by_geom[r["geometry_hash"]].append(r)
    families = {g: v for g, v in by_geom.items() if len(v) > 1}
    if families:
        spurious = {}
        for g, group in families.items():
            best = min(float(r["energy"]) for r in group)
            for r in group:
                gap = float(r["energy"]) - best
                if gap > tol:
                    spurious[f"{g}/{r.get('recipe', '?')}"] = round(gap, 3)
        out.append(_v("hv_variational_bound", not spurious,
                      f"converged states above their family minimum (eV): {spurious} "
                      f"— the higher energy is a spurious metastable solution" if spurious
                      else f"{len(families)} geometry families each at their minimum", "HV"))
    else:
        out.append(_skip("hv_variational_bound", "HV", ("geometry_hash+energy ×≥2 recipes",)))

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

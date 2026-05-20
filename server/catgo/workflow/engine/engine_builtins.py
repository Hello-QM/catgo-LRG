"""Built-in engine and collector registrations for all supported software.

Engines with existing modules import directly.
Engines without modules yet use a safe ImportError pattern.
"""

from catgo.workflow.engine.engine_registry import register_engine, register_collector


# ─── Engines with existing modules ───


@register_engine("vasp")
async def _gen_vasp(hpc, work_dir, node_type, params, structure_str, config, task):
    session_id = task.get("hpc_session_id", "")
    from workflow.engines.vasp import generate_vasp_inputs
    # v2 engine passes config as a plain dict; the old generate_vasp_inputs
    # expects a Pydantic WorkflowRunConfig with .cluster_configs for POTCAR
    # resolution.  In v2, POTCAR generation is handled separately by
    # submitter.py, so we only need INCAR/POSCAR/KPOINTS from here.
    # Pass config=None when it's a dict to skip the POTCAR step.
    effective_config = None if isinstance(config, dict) else config
    await generate_vasp_inputs(hpc, work_dir, node_type, params, structure_str, effective_config, session_id)


@register_engine("cp2k")
async def _gen_cp2k(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.cp2k import generate_cp2k_inputs

    # Apply per-workflow CP2K defaults (RunConfigDialog → Settings tab →
    # CP2K) for keys the node didn't override. Resolution order:
    #   task params  >  config.defaults.cp2k  >  engine fallbacks
    # Mirrors the ORCA branch above so RunConfigDialog's CP2K SCF/grid
    # knobs reach the actual cp2k.inp generator.
    if isinstance(config, dict):
        cp2k_defaults = config.get("defaults", {}).get("cp2k", {})
        for key, value in cp2k_defaults.items():
            if key not in params:
                params[key] = value
        # Cluster-level CP2K path (cp2k_data_dir) → params so the .inp
        # writer can emit absolute BASIS_SET / POTENTIAL paths.
        # scanner._merged_config puts it in hpc.job_defaults.
        job_defaults = config.get("hpc", {}).get("job_defaults", {})
        if job_defaults.get("cp2k_data_dir") and "cp2k_data_dir" not in params:
            params["cp2k_data_dir"] = job_defaults["cp2k_data_dir"]

    await generate_cp2k_inputs(hpc, work_dir, node_type, params, structure_str)


@register_engine("orca")
async def _gen_orca(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.orca import generate_orca_input_files

    # Apply config defaults for ORCA params not explicitly set by the task.
    # Resolution: task params > config.defaults.orca > engine fallbacks
    if isinstance(config, dict):
        orca_defaults = config.get("defaults", {}).get("orca", {})
        for key, value in orca_defaults.items():
            if key not in params:
                params[key] = value

    # Product structure for NEB-TS is stashed in params by the submitter
    # (resolved from the second parent's "product_structure" link).
    product_structure_str = params.pop("_resolved_product_structure", None)
    if node_type == "orca_neb_ts":
        import logging as _log
        _log.getLogger(__name__).info(
            "NEB-TS engine: product_structure_str present=%s, length=%s",
            product_structure_str is not None,
            len(product_structure_str) if product_structure_str else 0,
        )

    # Copy parent .gbw wavefunction file for SCF restart (massive speedup)
    parent_gbw = params.pop("_resolved_wavefunction_file", None)
    if parent_gbw:
        import logging as _log
        _logger = _log.getLogger(__name__)
        try:
            dest_gbw = f"{work_dir}/parent.gbw"
            result = await hpc.run_on_owner(lambda: hpc.conn.run(f"cp {parent_gbw} {dest_gbw}", check=False))
            if result.exit_status == 0:
                params["_parent_gbw_name"] = "parent.gbw"
                _logger.info("Copied parent .gbw %s -> %s", parent_gbw, dest_gbw)
            else:
                _logger.warning("Failed to copy parent .gbw: %s", parent_gbw)
        except Exception as e:
            _logger.warning("Failed to copy parent .gbw: %s", e)

    files = generate_orca_input_files(node_type, params, structure_str, product_structure_str)
    from catgo.utils.job_parser import write_remote_files
    await hpc.run_on_owner(
        lambda: write_remote_files(hpc.conn, {f"{work_dir}/{k}": v for k, v in files.items()})
    )


@register_engine("mlp")
async def _gen_mlp(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.mlp import generate_mlp_inputs
    await generate_mlp_inputs(hpc, work_dir, node_type, params, structure_str)


@register_engine("lammps")
async def _gen_lammps(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.lammps import generate_lammps_inputs
    await generate_lammps_inputs(hpc, work_dir, node_type, params, structure_str)


@register_engine("xtb")
async def _gen_xtb(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.xtb import generate_xtb_inputs
    await generate_xtb_inputs(hpc, work_dir, node_type, params, structure_str)


@register_engine("sella")
async def _gen_sella(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.sella import generate_sella_inputs
    await generate_sella_inputs(hpc, work_dir, node_type, params, structure_str)


@register_engine("amber")
async def _gen_amber(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.amber import generate_amber_inputs
    await generate_amber_inputs(hpc, work_dir, node_type, params, structure_str)


@register_engine("kmc")
async def _gen_kmc(hpc, work_dir, node_type, params, structure_str, config, task):
    from workflow.engines.kmc import generate_kmc_inputs
    await generate_kmc_inputs(hpc, work_dir, node_type, params, structure_str)


# ─── Engines without modules yet (safe ImportError pattern) ───


@register_engine("gaussian")
async def _gen_gaussian(hpc, work_dir, node_type, params, structure_str, config, task):
    try:
        from workflow.engines.gaussian import generate_gaussian_inputs
        await generate_gaussian_inputs(hpc, work_dir, node_type, params, structure_str)
    except ImportError:
        raise RuntimeError("Gaussian engine not yet implemented")


@register_engine("qe")
async def _gen_qe(hpc, work_dir, node_type, params, structure_str, config, task):
    try:
        from workflow.engines.qe import generate_qe_inputs
        await generate_qe_inputs(hpc, work_dir, node_type, params, structure_str)
    except ImportError:
        raise RuntimeError("Quantum ESPRESSO engine not yet implemented")


@register_engine("qchem")
async def _gen_qchem(hpc, work_dir, node_type, params, structure_str, config, task):
    try:
        from workflow.engines.qchem import generate_qchem_inputs
        await generate_qchem_inputs(hpc, work_dir, node_type, params, structure_str)
    except ImportError:
        raise RuntimeError("Q-Chem engine not yet implemented")


@register_engine("gromacs")
async def _gen_gromacs(hpc, work_dir, node_type, params, structure_str, config, task):
    try:
        from workflow.engines.gromacs import generate_gromacs_inputs
        await generate_gromacs_inputs(hpc, work_dir, node_type, params, structure_str)
    except ImportError:
        raise RuntimeError("GROMACS engine not yet implemented")


# ─── Local file generation (for PENDING_REVIEW preview) ───


def _generate_inputs_local(work_dir: str, node_type: str, engine_key: str, params: dict, structure_str: str | None) -> None:
    """Generate input files to a LOCAL directory (no HPC connection needed).

    Called by advancer.py when a task enters PENDING_REVIEW so the user
    can inspect and edit files before confirming HPC submission.
    """
    if engine_key == "vasp":
        _generate_vasp_inputs_local(work_dir, node_type, params, structure_str)
    elif engine_key == "cp2k":
        _generate_cp2k_inputs_local(work_dir, node_type, params, structure_str)
    elif engine_key == "orca":
        _generate_orca_inputs_local(work_dir, node_type, params, structure_str)


def _generate_vasp_inputs_local(work_dir: str, node_type: str, params: dict, structure_str: str | None) -> None:
    """Generate INCAR, POSCAR, KPOINTS locally."""
    import json as _json
    from pathlib import Path

    wd = Path(work_dir)

    # POSCAR from structure
    if structure_str:
        try:
            struct_dict = _json.loads(structure_str) if isinstance(structure_str, str) else structure_str
            from pymatgen.core import Structure
            struct = Structure.from_dict(struct_dict)
            poscar_str = struct.to(fmt="poscar")
            (wd / "POSCAR").write_text(poscar_str)
        except Exception as e:
            (wd / "POSCAR").write_text(f"# Failed to generate: {e}")

    # INCAR from params
    incar_lines: list[str] = []
    VASP_KEYS = {
        'ENCUT', 'EDIFF', 'EDIFFG', 'NSW', 'IBRION', 'ISIF', 'ISMEAR', 'SIGMA',
        'PREC', 'ALGO', 'LREAL', 'LWAVE', 'LCHARG', 'NELM', 'NELMIN', 'NCORE',
        'KPAR', 'ISPIN', 'MAGMOM', 'LDAU', 'LDAUU', 'LDAUJ', 'LDAUL', 'IVDW',
        'GGA', 'METAGGA', 'LASPH', 'LORBIT', 'NEDOS', 'EMIN', 'EMAX',
        'NFREE', 'POTIM',
    }
    for k, v in params.items():
        if k.upper() in VASP_KEYS:
            val = '.TRUE.' if v is True else '.FALSE.' if v is False else str(v)
            incar_lines.append(f"{k.upper()} = {val}")

    # Add node-type specific defaults if missing
    param_keys_upper = {k.upper() for k in params}
    if node_type in ('geo_opt', 'vasp_relax', 'slab_relax', 'bulk_opt'):
        if 'IBRION' not in param_keys_upper:
            incar_lines.append("IBRION = 2")
        if 'NSW' not in param_keys_upper:
            incar_lines.append("NSW = 200")
    elif node_type == 'freq' or node_type == 'frequency':
        if 'IBRION' not in param_keys_upper:
            incar_lines.append("IBRION = 5")
        if 'NFREE' not in param_keys_upper:
            incar_lines.append("NFREE = 2")
        if 'NSW' not in param_keys_upper:
            incar_lines.append("NSW = 1")

    (wd / "INCAR").write_text("\n".join(sorted(incar_lines)) + "\n")

    # KPOINTS
    kpoints = params.get("KPOINTS", params.get("kpoints", [1, 1, 1]))
    if isinstance(kpoints, list) and len(kpoints) == 3:
        kpt_str = f"Automatic\n0\nGamma\n{kpoints[0]} {kpoints[1]} {kpoints[2]}\n0 0 0\n"
    else:
        kpt_str = "Automatic\n0\nGamma\n1 1 1\n0 0 0\n"
    (wd / "KPOINTS").write_text(kpt_str)


def _generate_cp2k_inputs_local(work_dir: str, node_type: str, params: dict, structure_str: str | None) -> None:
    """Generate a minimal CP2K input file locally."""
    import json as _json
    from pathlib import Path

    wd = Path(work_dir)

    # Write structure as XYZ
    if structure_str:
        try:
            struct_dict = _json.loads(structure_str) if isinstance(structure_str, str) else structure_str
            from pymatgen.core import Structure
            struct = Structure.from_dict(struct_dict)
            xyz_str = struct.to(fmt="xyz")
            (wd / "structure.xyz").write_text(xyz_str)
        except Exception as e:
            (wd / "structure.xyz").write_text(f"# Failed to generate: {e}")

    # Write params as reference JSON for the user
    (wd / "params.json").write_text(_json.dumps(params, indent=2) + "\n")


def _generate_orca_inputs_local(work_dir: str, node_type: str, params: dict, structure_str: str | None) -> None:
    """Generate ORCA input files locally for PENDING_REVIEW preview."""
    from pathlib import Path

    # Apply config defaults so preview matches what HPC engine generates
    try:
        from catgo.workflow.config import load_config
        config = load_config()
        orca_defaults = config.get("defaults", {}).get("orca", {})
        for key, value in orca_defaults.items():
            if key not in params:
                params[key] = value
    except Exception:
        pass  # Config not available — proceed without defaults

    # Product structure for NEB-TS is stashed in params by the advancer
    # (resolved from the second parent's "product_structure" link).
    product_structure_str = params.pop("_resolved_product_structure", None)

    wd = Path(work_dir)
    try:
        from workflow.engines.orca import generate_orca_input_files
        files = generate_orca_input_files(node_type, params, structure_str, product_structure_str)
        for fname, content in files.items():
            (wd / fname).write_text(content, encoding="utf-8")
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("ORCA local preview generation failed: %s", e)
        # Write error + params as fallback so user sees something
        (wd / "ORCA.inp").write_text(f"# Failed to generate: {e}\n")
        import json as _json
        (wd / "params.json").write_text(_json.dumps(params, indent=2) + "\n")


# ─── Collectors (all use the same generic collect_completed_results pattern) ───

_ALL_ENGINE_KEYS = [
    "vasp", "cp2k", "orca", "mlp", "lammps", "xtb", "sella",
    "amber", "kmc", "gaussian", "qe", "qchem", "gromacs",
]


def _make_collector(key: str):
    """Create and register a collector for the given engine key."""
    @register_collector(key)
    async def _collector(hpc, work_dir, task_id, node_type, params, session_id, job_id):
        from catgo.workflow.engine.result_collector import collect_completed_results
        return await collect_completed_results(
            hpc, work_dir, task_id, node_type, params, session_id, job_id,
        )
    return _collector


for _key in _ALL_ENGINE_KEYS:
    _make_collector(_key)


# ─── Declarative engines (YAML-based) ───

def _register_declarative_engines():
    """Load all YAML engine defs and register them in the engine/collector registries.

    Declarative engines coexist with handwritten engines. If a YAML def has the same
    engine key as an already-registered handwritten engine, the handwritten one wins
    (it was registered first via @register_engine above).
    """
    try:
        from workflow.engine_runtime import load_all_engine_defs
    except ImportError as e:
        import logging
        logging.getLogger(__name__).warning(
            "Declarative engine registration skipped — workflow.engine_runtime "
            "not importable (sys.path issue?): %s", e,
        )
        return
    from catgo.workflow.engine.engine_registry import get_engine_generator

    for runtime in load_all_engine_defs():
        key = runtime.spec.engine
        if get_engine_generator(key):
            # Handwritten engine already registered — skip YAML override
            continue

        @register_engine(key)
        async def _gen(hpc, work_dir, node_type, params, structure_str, config, task,
                       _rt=runtime):
            await _rt.generate_inputs(hpc, work_dir, node_type, params, structure_str, config, task)

        # Also register collector if not already present
        if key not in _ALL_ENGINE_KEYS:
            _make_collector(key)


_register_declarative_engines()

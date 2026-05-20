"""Populate the OperationRegistry — the one place ops are registered."""
from __future__ import annotations

from catgo.cli import ops_build, ops_convert
from catgo.cli.registry import Operation, OperationRegistry, Param


def build_registry() -> OperationRegistry:
    reg = OperationRegistry()
    reg.add(Operation(
        name="slab", group="build", summary="bulk -> surface slab",
        params=[
            Param("miller", tuple, help="Miller indices, e.g. 1,1,0"),
            Param("layers", int, default=4, help="number of atomic layers (unit planes)"),
            Param("vacuum", float, default=15.0, help="vacuum size (A)"),
        ],
        handler=ops_build.slab,
    ))
    reg.add(Operation(
        name="supercell", group="build", summary="integer supercell",
        params=[Param("scaling", tuple, help="na,nb,nc e.g. 2,2,1")],
        handler=ops_build.supercell,
    ))
    reg.add(Operation(
        name="convert", group="convert",
        summary="write active structure to another format",
        params=[Param("out", str, help="output path; ext sets format")],
        handler=ops_convert.convert, mutates=False,
    ))
    reg.add(Operation(
        name="inspect", group="convert",
        summary="print composition / symmetry / nearest-neighbor",
        params=[], handler=ops_convert.inspect, mutates=False,
    ))
    from catgo.cli import ops_analyze
    reg.add(Operation(
        name="dos", group="analyze",
        summary="vaspout.h5 -> PDOS publication plot + d-band center",
        params=[
            Param("atoms", str, default="all", help="atom indices or 'all'"),
            Param("channels", str, default="spd",
                  help="orbital spec: s|p|d|spd|... (catgo_dos)"),
            Param("edit", bool, default=False, help="open pylustrator GUI editor"),
            Param("latex", bool, default=False, help="LaTeX text rendering"),
            Param("dump", str, default="", help="also write raw data JSON"),
            Param("groups", str, default="",
                  help="multi-group PDOS spec: "
                       "'a1:c1[:l1];a2:c2[:l2];…' (overrides --atoms/--channels)"),
        ],
        handler=ops_analyze.dos, mutates=False))
    reg.add(Operation(
        name="band", group="analyze",
        summary="vasprun.xml -> band structure plot + gap",
        params=[
            Param("edit", bool, default=False, help="open pylustrator GUI editor"),
            Param("latex", bool, default=False, help="LaTeX text rendering"),
            Param("dump", str, default="", help="also write raw data JSON"),
        ],
        handler=ops_analyze.band, mutates=False))
    reg.add(Operation(
        name="cohp", group="analyze",
        summary="COHPCAR.lobster -> -pCOHP plot + ICOHP",
        params=[
            Param("edit", bool, default=False, help="open pylustrator GUI editor"),
            Param("latex", bool, default=False, help="LaTeX text rendering"),
            Param("dump", str, default="", help="also write raw data JSON"),
        ],
        handler=ops_analyze.cohp, mutates=False))
    reg.add(Operation(
        name="freq", group="analyze",
        summary="OUTCAR -> Gibbs correction + TS imaginary-mode animation",
        params=[
            Param("mode", str, default="adsorbed",
                  help="adsorbed|gas", choices=["adsorbed", "gas"]),
            Param("T", float, default=298.15, help="temperature (K)"),
            Param("P", float, default=1.0, help="pressure (bar, gas)"),
            Param("freq_cutoff", float, default=50.0,
                  help="soft-mode cutoff (cm-1)"),
            Param("unpaired", int, default=0, help="unpaired electrons (gas)"),
            Param("frames", int, default=20, help="animation frames"),
            Param("amplitude", float, default=0.5,
                  help="animation amplitude (A)"),
            Param("mode_index", int, default=-1,
                  help="mode to animate (-1 = first imaginary)"),
            Param("symbols", str, default="",
                  help="comma element symbols, one per atom (animation)"),
            Param("no_anim", bool, default=False,
                  help="skip the TS animation, numbers only"),
            Param("dump", str, default="", help="also write Gibbs JSON"),
            # IR spectrum (real-mode Gaussian-broadened absorption).
            # Path extension picks text (.dat/.txt/.csv) vs plot
            # (.pdf/.png/.svg). Sentinel -1 on emin/emax = auto range
            # (registry has no Optional-float Param surface yet).
            Param("ir_spectrum", str, default="",
                  help="write IR spectrum (.dat/.pdf/.png)"),
            Param("ir_sigma", float, default=10.0,
                  help="Gaussian width (cm-1) for IR spectrum"),
            Param("ir_emin", float, default=-1.0,
                  help="IR spectrum lower bound (cm-1); <0 = auto"),
            Param("ir_emax", float, default=-1.0,
                  help="IR spectrum upper bound (cm-1); <0 = auto"),
        ],
        handler=ops_analyze.freq, mutates=False))
    from catgo.cli import ops_viewer
    reg.add(Operation(
        name="push", group="viewer",
        summary="upload structure to the CatGO viewer (auto-starts server)",
        params=[
            Param("panel", str, default="",
                  help="viewer panel id (empty = server default)"),
        ],
        handler=ops_viewer.push, needs_server=True, mutates=False))
    reg.add(Operation(
        name="pull", group="viewer",
        summary="download current viewer structure into the session",
        params=[
            Param("panel", str, default="",
                  help="viewer panel id (empty = server default)"),
            Param("format", str, default="poscar",
                  choices=["poscar", "cif", "xyz", "extxyz"],
                  help="export format"),
        ],
        handler=ops_viewer.pull, needs_server=True, mutates=True))
    from catgo.cli import ops_submit
    reg.add(Operation(
        name="submit", group="hpc",
        summary="generate code input + scp + sbatch to remote HPC",
        params=[
            Param("code", str, default="vasp",
                  choices=["vasp", "cp2k"],
                  help="code: vasp|cp2k"),
            Param("host", str, default="",
                  help="HPC profile name (~/.catgo/hpc_profiles.json); "
                       "empty = first available"),
            Param("queue", str, default="",
                  help="SLURM partition (empty = scheduler default)"),
            Param("walltime", int, default=24,
                  help="wall time (hours)"),
            Param("nodes", int, default=1,
                  help="number of nodes"),
            Param("remote_dir", str, default="",
                  help="remote work dir (empty = ~/catgo-jobs/<ts>-<name>)"),
            Param("job_name", str, default="",
                  help="SLURM job name (empty = catgo_<formula>)"),
        ],
        handler=ops_submit.submit, needs_server=False, mutates=False))
    return reg

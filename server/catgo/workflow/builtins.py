"""Built-in task type definitions for CatGo.

Import this module to register all standard task types:
    from catgo.workflow.builtins import geo_opt, freq, gibbs_energy

Implementations live in builtins_impl.py to keep this file focused
on @task registrations with minimal bodies.
"""

from catgo.workflow.task_decorator import task
from catgo.workflow.builtins_impl import (
    run_structure_input,
    run_gibbs_energy,
    run_slab_gen,
    run_adsorbate_place,
    run_free_energy_diagram,
    run_dos_analysis,
    run_charge_analysis,
)


# --- Control-Flow ---

@task(task_type="__map__", local=True, outputs=["status"])
def map_controller(**kwargs):
    """Map controller -- never executed directly. Children run instead."""
    return {"status": "mapped"}


@task(task_type="__while__", local=True, outputs=["status", "iterations"])
def while_controller(**kwargs):
    """While loop controller -- manages iteration cycles.

    The scanner handles while-loop logic directly; this function
    is only called if the loop has no children (immediate completion).
    """
    return {"status": "loop_complete", "iterations": 0}


@task(task_type="__zone__", local=True, outputs=["status"])
def zone_controller(**kwargs):
    """Zone controller -- completes when all children complete.

    The scanner handles zone completion logic directly; this function
    is only called if the zone has no children (immediate completion).
    """
    return {"status": "zone_complete"}


# --- Input ---

@task(task_type="structure_input", local=True, outputs=["structure"])
def structure_input(structure=None, **params):
    """Pass-through: provides a structure to the workflow."""
    return run_structure_input(structure, **params)


@task(task_type="structure_list_input", local=True, outputs=["structures"])
def structure_list_input(structures=None, **params):
    return {"structures": structures}


# --- Build ---

@task(task_type="slab_gen", local=True, outputs=["structure"])
def slab_gen(structure=None, miller=(1, 1, 0), layers=4, vacuum=15.0, **params):
    """Generate slab -- delegates to pymatgen SlabGenerator."""
    return run_slab_gen(structure, miller, layers, vacuum, **params)


@task(task_type="adsorbate_place", local=True, outputs=["structure"])
def adsorbate_place(structure=None, species="OH", site="all", height=2.0, **params):
    """Place adsorbate on surface -- returns structure with adsorbate."""
    return run_adsorbate_place(structure, species, site, height, **params)


# --- Calculation (HPC) ---

@task(software="vasp", task_type="geo_opt", outputs=["structure", "energy"])
def geo_opt(structure, ENCUT=520, EDIFF=1e-5, NSW=200, ISIF=2, IBRION=2,
            EDIFFG=-0.02, system_name="", **params):
    pass


@task(software="vasp", task_type="single_point", outputs=["structure", "energy"])
def single_point(structure, ENCUT=520, EDIFF=1e-5, NSW=0, IBRION=-1,
                 system_name="", **params):
    pass


@task(software="vasp", task_type="freq", outputs=["frequencies", "zpe"])
def freq(structure, ENCUT=520, EDIFF=1e-6, IBRION=5, NFREE=2, POTIM=0.015,
         freeze_mode="none", system_name="", **params):
    pass


@task(software="vasp", task_type="cell_opt", outputs=["structure", "energy"])
def cell_opt(structure, ENCUT=520, EDIFF=1e-5, NSW=200, ISIF=3,
             system_name="", **params):
    pass


@task(software="vasp", task_type="md", outputs=["trajectory", "energy"])
def md(structure, ENCUT=520, NSW=1000, IBRION=0, POTIM=1.0,
       TEBEG=300, system_name="", **params):
    pass


# --- Analysis (Local) ---

@task(task_type="gibbs_energy", local=True, outputs=["gibbs", "zpe"])
def gibbs_energy(energy=None, frequencies=None, phase="adsorbed",
                 temperature=298.15, freq_cutoff=50, pressure_atm=1.0,
                 n_unpaired=0, system_name="", **params):
    """Compute Gibbs free energy: G = E_DFT + ZPE - TS."""
    return run_gibbs_energy(
        energy, frequencies, phase, temperature,
        freq_cutoff, pressure_atm, n_unpaired, system_name, **params,
    )


@task(task_type="free_energy_diagram", local=True, outputs=["plotly_data"])
def free_energy_diagram(gibbs_values=None, step_order=None, **params):
    """Generate free energy diagram data."""
    return run_free_energy_diagram(gibbs_values, step_order, **params)


@task(task_type="dos_analysis", local=True, outputs=["dos_data"])
def dos_analysis(data=None, d_band=True, **params):
    """DOS analysis -- requires HPC output data."""
    return run_dos_analysis(data, d_band, **params)


@task(task_type="charge_analysis", local=True, outputs=["charges"])
def charge_analysis(data=None, method="bader", **params):
    """Charge analysis -- requires HPC output data."""
    return run_charge_analysis(data, method, **params)

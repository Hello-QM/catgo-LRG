"""LAMMPS router package — split from monolithic lammps.py for maintainability.

Sub-modules:
  setup.py      — input file generation, validation, polymer, sequential endpoints
  simulation.py — MD simulation submission, monitoring, results endpoints
  utils.py      — shared enums, constants, helper functions
"""

from fastapi import APIRouter

from .setup import router as setup_router
from .simulation import router as simulation_router

__all__ = ["router", "setup_router", "simulation_router"]

router = APIRouter(prefix="/lammps", tags=["lammps"])
router.include_router(simulation_router)
router.include_router(setup_router)

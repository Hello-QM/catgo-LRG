"""KMC (Kinetic Monte Carlo) simulation endpoints."""

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/kmc", tags=["kmc"])


# ── Request / Response models ──

class KMCModelJSON(BaseModel):
    """A KMC model definition in mykmc JSON format."""
    meta: dict = Field(default_factory=dict)
    species: list[dict] = Field(default_factory=list)
    parameters: list[dict] = Field(default_factory=list)
    processes: list[dict] = Field(default_factory=list)
    lattice: dict = Field(default_factory=dict)


class KMCSimulateRequest(BaseModel):
    model: KMCModelJSON
    temperature: float = 300.0
    potential: float = 0.0
    lattice_size: int = 20
    steps: int = 100000


class MKMRequest(BaseModel):
    model: KMCModelJSON
    temperature: float = 300.0
    potential: float = 0.0


class PotentialScanRequest(BaseModel):
    model: KMCModelJSON
    temperature: float = 300.0
    u_min: float = -0.5
    u_max: float = -3.0
    u_steps: int = 20
    method: str = "mkm"
    lattice_size: int = 20
    kmc_steps: int = 100000


class TemperatureScanRequest(BaseModel):
    model: KMCModelJSON
    potential: float = -1.0
    t_min: float = 250.0
    t_max: float = 500.0
    t_steps: int = 20
    method: str = "mkm"
    lattice_size: int = 20
    kmc_steps: int = 100000


class ValidateResponse(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    summary: dict = Field(default_factory=dict)


# ── Endpoints ──

@router.post("/simulate")
def simulate_kmc(req: KMCSimulateRequest) -> dict[str, Any]:
    """Run lattice KMC simulation."""
    try:
        from catgo.utils.kmc_runner import run_kmc
        result = run_kmc(
            model_json=req.model.model_dump(),
            temperature=req.temperature,
            potential=req.potential,
            lattice_size=req.lattice_size,
            steps=req.steps,
        )
        return result
    except Exception as e:
        logger.error("KMC simulation failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/microkinetic")
def solve_microkinetic(req: MKMRequest) -> dict[str, Any]:
    """Run mean-field microkinetic model (fast ODE solver)."""
    try:
        from catgo.utils.kmc_runner import run_microkinetic
        result = run_microkinetic(
            model_json=req.model.model_dump(),
            temperature=req.temperature,
            potential=req.potential,
        )
        return result
    except Exception as e:
        logger.error("MKM solve failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/scan-potential")
def scan_potential(req: PotentialScanRequest) -> dict[str, Any]:
    """Scan applied potential and collect TOF/coverage."""
    try:
        from catgo.utils.kmc_runner import run_potential_scan
        result = run_potential_scan(
            model_json=req.model.model_dump(),
            temperature=req.temperature,
            u_min=req.u_min,
            u_max=req.u_max,
            u_steps=req.u_steps,
            method=req.method,
            lattice_size=req.lattice_size,
            kmc_steps=req.kmc_steps,
        )
        return result
    except Exception as e:
        logger.error("Potential scan failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/scan-temperature")
def scan_temperature(req: TemperatureScanRequest) -> dict[str, Any]:
    """Scan temperature and collect TOF/coverage."""
    try:
        from catgo.utils.kmc_runner import run_temperature_scan
        result = run_temperature_scan(
            model_json=req.model.model_dump(),
            potential=req.potential,
            t_min=req.t_min,
            t_max=req.t_max,
            t_steps=req.t_steps,
            method=req.method,
            lattice_size=req.lattice_size,
            kmc_steps=req.kmc_steps,
        )
        return result
    except Exception as e:
        logger.error("Temperature scan failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/validate")
def validate_model(model: KMCModelJSON) -> ValidateResponse:
    """Validate a KMC model JSON definition."""
    errors = []
    data = model.model_dump()

    if not data.get("species"):
        errors.append("No species defined")
    if not data.get("processes"):
        errors.append("No processes defined")

    species_names = {sp["name"] for sp in data.get("species", [])}
    for proc in data.get("processes", []):
        for c in proc.get("conditions", []):
            if c.get("species") not in species_names:
                errors.append(f"Process '{proc['name']}': unknown species '{c.get('species')}' in conditions")
        for a in proc.get("actions", []):
            if a.get("species") not in species_names:
                errors.append(f"Process '{proc['name']}': unknown species '{a.get('species')}' in actions")
        if not proc.get("rate_constant"):
            errors.append(f"Process '{proc['name']}': missing rate_constant")

    summary = {
        "n_species": len(data.get("species", [])),
        "n_parameters": len(data.get("parameters", [])),
        "n_processes": len(data.get("processes", [])),
        "species": [sp["name"] for sp in data.get("species", [])],
        "model_name": data.get("meta", {}).get("model_name", ""),
    }

    return ValidateResponse(valid=len(errors) == 0, errors=errors, summary=summary)

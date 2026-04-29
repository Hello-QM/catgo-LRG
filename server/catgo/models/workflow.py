"""Pydantic models for workflow management."""

from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class WorkflowStatus(str, Enum):
    DRAFT = "draft"
    RUNNING = "running"
    COMPLETED = "completed"
    NOT_CONVERGED = "not_converged"
    FAILED = "failed"
    PAUSED = "paused"


class StepStatus(str, Enum):
    PENDING = "pending"
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    NOT_CONVERGED = "not_converged"
    FAILED = "failed"
    SKIPPED = "skipped"


class NodeType(str, Enum):
    STRUCTURE_INPUT = "structure_input"
    VASP_RELAX = "vasp_relax"
    VASP_STATIC = "vasp_static"
    VASP_MD = "vasp_md"
    MLP_RELAX = "mlp_relax"
    MLP_MD = "mlp_md"
    BULK_OPT = "bulk_opt"
    SLAB_GEN = "slab_gen"
    SLAB_RELAX = "slab_relax"
    ADSORBATE_PLACE = "adsorbate_place"
    GEOMETRY_OPT = "geometry_opt"
    XTB_RELAX = "xtb_relax"
    XTB_STATIC = "xtb_static"
    SELLA_TS = "sella_ts"
    FREQUENCY = "frequency"
    REFERENCE_MOL = "reference_mol"
    FREE_ENERGY = "free_energy"
    HER_ANALYSIS = "her_analysis"
    ELECTRONIC = "electronic"
    ORCA_OPT = "orca_opt"
    ORCA_SP = "orca_sp"
    ORCA_FREQ = "orca_freq"
    ORCA_NEB_TS = "orca_neb_ts"
    ORCA_IRC = "orca_irc"
    CONDITION = "condition"
    LOOP = "loop"
    MERGE = "merge"
    ANALYSIS = "analysis"
    EXPORT = "export"


class EdgeType(str, Enum):
    SEQUENTIAL = "sequential"
    PARALLEL = "parallel"
    CONDITIONAL = "conditional"


class WorkflowCreate(BaseModel):
    name: str = Field(description="Workflow name")
    description: str = Field(default="", description="Workflow description")
    template_id: Optional[str] = Field(default=None, description="Source template ID")
    graph_json: str = Field(description="Svelte Flow graph JSON (nodes, edges, viewport)")
    id: Optional[str] = Field(default=None, description="Optional ID (for syncing from Tauri/Desktop local DB)")
    project_id: Optional[str] = Field(default=None, description="Optional project ID")


class WorkflowUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    graph_json: Optional[str] = None
    status: Optional[WorkflowStatus] = None
    metadata: Optional[str] = None


class WorkflowSummary(BaseModel):
    id: str
    name: str
    description: str
    status: WorkflowStatus
    template_id: Optional[str] = None
    project_id: Optional[str] = None
    created_at: str
    updated_at: str
    step_count: int = 0
    completed_steps: int = 0


class WorkflowDetail(WorkflowSummary):
    graph_json: str
    metadata: str = "{}"


class StepUpdate(BaseModel):
    config_json: Optional[str] = None
    status: Optional[StepStatus] = None
    hpc_job_id: Optional[str] = None
    result_json: Optional[str] = None
    error_message: Optional[str] = None


class WorkflowTemplate(BaseModel):
    id: str
    name: str
    description: str = ""
    category: str = "general"
    graph_json: str
    metadata: str = "{}"


class SaveStructureRequest(BaseModel):
    structure: dict  # PymatgenStructure JSON
    name: str = ""
    project_id: Optional[str] = None

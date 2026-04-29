"""
Plugin management API endpoints.

Provides REST API for:
- Listing installed plugins
- Getting plugin information
- Installing/uninstalling plugins
- Enabling/disabling plugins
- Listing readers and uploading files for auto-routed reading
"""

import logging
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from catgo.plugins import plugin_manager
from catgo.plugins.base import AnalyzerPlugin, PluginType, PluginError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/plugins", tags=["plugins"])


# =============================================================================
# Response Models
# =============================================================================


class PluginInfo(BaseModel):
    """Plugin information for API responses."""

    name: str
    plugin_type: str
    display_name: str
    description: str
    version: str
    author: str
    enabled: bool
    error: Optional[str] = None
    supported_elements: Optional[list[str]] = None
    parameter_schema: Optional[dict] = None
    extra: dict = {}


class CalculatorInfo(BaseModel):
    """Calculator plugin information."""

    id: str
    name: str
    display_name: str
    description: str
    version: str
    author: str
    enabled: bool
    supported_elements: Optional[list[str]] = None
    parameter_schema: Optional[dict] = None
    is_plugin: bool = True


class PluginsListResponse(BaseModel):
    """Response for listing plugins."""

    plugins: list[PluginInfo]
    total: int


class CalculatorsListResponse(BaseModel):
    """Response for listing calculators (built-in + plugins)."""

    calculators: list[CalculatorInfo]
    total: int


class WorkflowNodesListResponse(BaseModel):
    """Response for listing workflow node plugins."""

    nodes: list[dict]
    total: int


class PluginActionResponse(BaseModel):
    """Response for plugin actions."""

    success: bool
    message: str
    plugin: Optional[PluginInfo] = None


class ReaderInfo(BaseModel):
    """Reader plugin information."""

    reader_id: str
    name: str
    display_name: str
    description: str
    version: str
    enabled: bool
    formats: list[str]
    output_type: str
    multi_file: bool


class ReadersListResponse(BaseModel):
    """Response for listing readers."""

    readers: list[ReaderInfo]
    total: int


class ReaderUploadResponse(BaseModel):
    """Response from reader file upload."""

    reader_id: str
    reader_name: str
    output_type: str
    session_id: Optional[str] = None
    data: Optional[dict] = None
    message: str


# =============================================================================
# Endpoints
# =============================================================================


@router.get("/", response_model=PluginsListResponse)
def list_plugins():
    """List all installed plugins."""
    plugins = plugin_manager.get_all_plugins()

    return PluginsListResponse(
        plugins=[
            PluginInfo(
                name=p.name,
                plugin_type=p.plugin_type.value,
                display_name=p.display_name,
                description=p.description,
                version=p.version,
                author=p.author,
                enabled=p.enabled,
                error=p.error,
                supported_elements=p.supported_elements,
                parameter_schema=p.parameter_schema,
                extra=p.extra,
            )
            for p in plugins
        ],
        total=len(plugins),
    )


@router.get("/calculators", response_model=CalculatorsListResponse)
def list_plugin_calculators():
    """List all calculator plugins."""
    calculators = plugin_manager.get_all_calculators()

    return CalculatorsListResponse(
        calculators=[
            CalculatorInfo(
                id=c["id"],
                name=c["name"],
                display_name=c["display_name"],
                description=c["description"],
                version=c["version"],
                author=c["author"],
                enabled=c["enabled"],
                supported_elements=c["supported_elements"],
                parameter_schema=c["parameter_schema"],
                is_plugin=True,
            )
            for c in calculators
        ],
        total=len(calculators),
    )


@router.get("/readers", response_model=ReadersListResponse)
def list_readers():
    """List all registered reader plugins (built-in + external)."""
    readers = plugin_manager.get_all_readers()

    return ReadersListResponse(
        readers=[
            ReaderInfo(
                reader_id=r["reader_id"],
                name=r["name"],
                display_name=r["display_name"],
                description=r["description"],
                version=r["version"],
                enabled=r["enabled"],
                formats=r["formats"],
                output_type=r["output_type"],
                multi_file=r["multi_file"],
            )
            for r in readers
        ],
        total=len(readers),
    )


@router.post("/readers/upload")
async def upload_to_reader(
    files: list[UploadFile] = File(...),
    reader_id: Optional[str] = Form(None),
    options: Optional[str] = Form(None),
):
    """Upload files and route to the appropriate reader plugin.

    If reader_id is provided, uses that specific reader.
    Otherwise, auto-detects based on file extensions.

    Returns:
        {
            "reader_id": "cp2k_pdos",
            "output_type": "electronic_dos",
            "data": { ... output_type-specific data ... },
            "session_id": "..." (for DOS/Band/COHP that create sessions)
        }
    """
    import json
    import shutil

    if not files:
        raise HTTPException(status_code=400, detail="No files provided")

    filenames = [f.filename or "unknown" for f in files]
    opts = json.loads(options) if options else {}

    # Find reader
    if reader_id:
        try:
            reader = plugin_manager.get_reader(reader_id)
        except PluginError as e:
            raise HTTPException(status_code=404, detail=str(e))
    else:
        reader = plugin_manager.find_reader_for_files(filenames)
        if not reader:
            raise HTTPException(
                status_code=400,
                detail=f"No reader found for files: {filenames}. "
                f"Available readers: {[r['reader_id'] for r in plugin_manager.get_all_readers()]}",
            )

    # Save files to temp directory
    tmp_dir = Path(tempfile.mkdtemp(prefix="catgo_reader_"))
    tmp_paths: list[str] = []
    try:
        for f in files:
            fname = f.filename or "unknown"
            tmp_path = tmp_dir / fname
            content = await f.read()
            tmp_path.write_bytes(content)
            tmp_paths.append(str(tmp_path))

        if not tmp_paths:
            raise HTTPException(status_code=400, detail="No valid files provided")

        # Call reader
        try:
            result = await reader.read(tmp_paths, opts)
        except Exception as e:
            logger.exception(f"Reader {reader.reader_id} failed")
            raise HTTPException(
                status_code=400,
                detail=f"Reader failed: {e}",
            )

        # Route based on output_type
        response: dict = {
            "reader_id": reader.reader_id,
            "output_type": reader.output_type,
        }

        if reader.output_type == "electronic_dos":
            session_resp = _create_dos_session_from_reader(result)
            response["session_id"] = session_resp["session_id"]
            response["data"] = session_resp

        elif reader.output_type == "electronic_bands":
            session_resp = _create_bands_session_from_reader(result)
            response["session_id"] = session_resp["session_id"]
            response["data"] = session_resp

        elif reader.output_type == "cohp":
            session_resp = _create_cohp_session_from_reader(result)
            response["session_id"] = session_resp["session_id"]
            response["data"] = session_resp

        elif reader.output_type == "structure":
            response["data"] = result

        else:
            # scatter_plot, bar_plot, table, image, etc.
            response["data"] = result

        return response

    finally:
        # Cleanup temp files
        shutil.rmtree(tmp_dir, ignore_errors=True)


# =========================================================================
# Session creation helpers (reader result → pipeline session)
# =========================================================================


def _create_dos_session_from_reader(reader_result: dict) -> dict:
    """Convert reader output to DOS session, reusing dos.py infrastructure."""
    import sys

    import numpy as np

    _ext_dir = Path(__file__).resolve().parent.parent.parent / "extensions" / "dos-analysis"
    if str(_ext_dir) not in sys.path:
        sys.path.insert(0, str(_ext_dir))

    from catgo_dos.io import VaspData
    from catgo.routers.dos import _create_session

    # Reconstruct VaspData from the reader dict
    eigenvalues = np.array(reader_result["eigenvalues"])
    kweights = np.array(reader_result["kweights"])
    projectors = np.array(reader_result["projectors"]) if reader_result.get("projectors") is not None else np.zeros((1, 1, 1, 1, 1))
    positions = np.array(reader_result.get("positions", [[0, 0, 0]]))
    positions_frac = np.array(reader_result.get("positions_frac", positions))
    lattice = np.array(reader_result.get("lattice", np.eye(3) * 10))
    elements = np.array(reader_result["elements"], dtype=object)

    # ion_types / ion_counts — preserve order from reader
    from collections import Counter
    elem_list = list(reader_result["elements"])
    ion_counter = Counter(elem_list)
    seen: list[str] = []
    for e in elem_list:
        if e not in seen:
            seen.append(e)
    ion_types = reader_result.get("ion_types", seen)
    ion_counts = reader_result.get("ion_counts", [ion_counter[t] for t in ion_types])

    data = VaspData(
        eigenvalues=eigenvalues,
        kweights=kweights,
        efermi=float(reader_result.get("efermi", 0.0)),
        projectors=projectors,
        positions=positions,
        positions_frac=positions_frac,
        lattice=lattice,
        elements=elements,
        ion_types=list(ion_types),
        ion_counts=list(ion_counts),
    )

    # Reuse dos.py's _create_session to get a proper DOSUploadResponse
    upload_resp = _create_session(data, source="plugin")

    return {
        "session_id": upload_resp.session_id,
        "nions": upload_resp.nions,
        "nkpts": upload_resp.nkpts,
        "nbands": upload_resp.nbands,
        "nspin": upload_resp.nspin,
        "elements": upload_resp.elements,
        "efermi": upload_resp.efermi,
        "structure": upload_resp.structure,
    }


def _create_bands_session_from_reader(reader_result: dict) -> dict:
    """Create a band session from reader output containing pymatgen objects."""
    vr = reader_result.get("_vasprun")
    bs = reader_result.get("_bandstructure")

    if vr is None or bs is None:
        raise HTTPException(
            status_code=400,
            detail="Band reader must return '_vasprun' and '_bandstructure' keys",
        )

    from catgo.routers.bands import _create_band_session

    upload_resp = _create_band_session(vr, bs)
    return {
        "session_id": upload_resp.session_id,
        "nbands": upload_resp.nbands,
        "nkpts": upload_resp.nkpts,
        "nspin": upload_resp.nspin,
        "efermi": upload_resp.efermi,
        "is_metal": upload_resp.is_metal,
        "elements": upload_resp.elements,
    }


def _create_cohp_session_from_reader(reader_result: dict) -> dict:
    """Create a COHP session from reader output containing parsed COHP data."""
    import time
    import uuid

    cohp_data = reader_result.get("_cohp_data")
    if cohp_data is None:
        raise HTTPException(
            status_code=400,
            detail="COHP reader must return '_cohp_data' key",
        )

    from catgo.routers.cohp import _sessions, _cleanup_expired

    session_id = str(uuid.uuid4())
    _sessions[session_id] = (cohp_data, time.time())
    _cleanup_expired()

    return {
        "session_id": session_id,
        "nspin": cohp_data.nspin,
        "npoints": cohp_data.npoints,
        "efermi": cohp_data.efermi,
    }


@router.get("/analyzers")
def list_analyzer_plugins():
    """List all analyzer plugins with their schemas."""
    analyzers = plugin_manager.get_all_analyzers()
    return {"analyzers": analyzers, "total": len(analyzers)}


@router.post("/analyzers/{analyzer_id}/run")
async def run_analyzer(analyzer_id: str, input_data: dict):
    """
    Execute an analyzer plugin.

    The analyzer_id must match the plugin's analyzer_id.
    Input body should conform to the analyzer's input_schema.
    Returns {analyzer_id, output_type, result}.
    """
    # Try by analyzer_id first, then by plugin name
    plugin = None
    if plugin_manager.has_analyzer(analyzer_id):
        plugin = plugin_manager.get_analyzer(analyzer_id)
    else:
        p = plugin_manager.get_plugin(analyzer_id)
        if p and isinstance(p, AnalyzerPlugin):
            plugin = p

    if not plugin:
        raise HTTPException(status_code=404, detail=f"Analyzer not found: {analyzer_id}")
    if not plugin._enabled:
        raise HTTPException(
            status_code=400, detail=f"Analyzer plugin is disabled: {analyzer_id}"
        )

    try:
        result = await plugin.analyze(input_data)
        return {
            "analyzer_id": plugin.analyzer_id,
            "output_type": plugin.output_type,
            "result": result,
        }
    except Exception as e:
        logger.exception(f"Analyzer {analyzer_id} failed")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/workflow-nodes", response_model=WorkflowNodesListResponse)
def list_workflow_node_plugins():
    """List all workflow node plugins and their definitions."""
    nodes = plugin_manager.get_all_workflow_nodes()
    return WorkflowNodesListResponse(nodes=nodes, total=len(nodes))


@router.get("/{plugin_name}", response_model=PluginInfo)
def get_plugin(plugin_name: str):
    """Get information about a specific plugin."""
    plugin = plugin_manager.get_plugin(plugin_name)

    if plugin is None:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_name}")

    meta = plugin.get_metadata()
    return PluginInfo(
        name=meta.name,
        plugin_type=meta.plugin_type.value,
        display_name=meta.display_name,
        description=meta.description,
        version=meta.version,
        author=meta.author,
        enabled=meta.enabled,
        error=meta.error,
        supported_elements=meta.supported_elements,
        parameter_schema=meta.parameter_schema,
        extra=meta.extra,
    )


@router.post("/{plugin_name}/enable", response_model=PluginActionResponse)
def enable_plugin(plugin_name: str):
    """Enable a plugin."""
    try:
        plugin_manager.enable_plugin(plugin_name)
        plugin = plugin_manager.get_plugin(plugin_name)
        meta = plugin.get_metadata()

        return PluginActionResponse(
            success=True,
            message=f"Plugin '{plugin_name}' enabled",
            plugin=PluginInfo(
                name=meta.name,
                plugin_type=meta.plugin_type.value,
                display_name=meta.display_name,
                description=meta.description,
                version=meta.version,
                author=meta.author,
                enabled=meta.enabled,
            ),
        )
    except PluginError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/{plugin_name}/disable", response_model=PluginActionResponse)
def disable_plugin(plugin_name: str):
    """Disable a plugin."""
    try:
        plugin_manager.disable_plugin(plugin_name)
        plugin = plugin_manager.get_plugin(plugin_name)
        meta = plugin.get_metadata()

        return PluginActionResponse(
            success=True,
            message=f"Plugin '{plugin_name}' disabled",
            plugin=PluginInfo(
                name=meta.name,
                plugin_type=meta.plugin_type.value,
                display_name=meta.display_name,
                description=meta.description,
                version=meta.version,
                author=meta.author,
                enabled=meta.enabled,
            ),
        )
    except PluginError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{plugin_name}", response_model=PluginActionResponse)
async def uninstall_plugin(plugin_name: str):
    """Uninstall a plugin."""
    try:
        await plugin_manager.uninstall_plugin(plugin_name)
        return PluginActionResponse(
            success=True,
            message=f"Plugin '{plugin_name}' uninstalled",
        )
    except PluginError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/install/upload", response_model=PluginActionResponse)
async def install_plugin_upload(file: UploadFile = File(...)):
    """Install a plugin from uploaded ZIP file."""
    import tempfile
    import shutil

    if not file.filename or not file.filename.endswith(".zip"):
        raise HTTPException(status_code=400, detail="File must be a ZIP archive")

    try:
        # Save uploaded file to temp location
        with tempfile.NamedTemporaryFile(delete=False, suffix=".zip") as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp_path = Path(tmp.name)

        # Install the plugin
        meta = await plugin_manager.install_plugin(tmp_path)

        # Clean up temp file
        tmp_path.unlink()

        return PluginActionResponse(
            success=True,
            message=f"Plugin '{meta.name}' installed successfully",
            plugin=PluginInfo(
                name=meta.name,
                plugin_type=meta.plugin_type.value,
                display_name=meta.display_name,
                description=meta.description,
                version=meta.version,
                author=meta.author,
                enabled=meta.enabled,
            ),
        )
    except PluginError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("Error installing plugin")
        raise HTTPException(status_code=500, detail=f"Installation error: {e}")


@router.post("/refresh", response_model=PluginsListResponse)
async def refresh_plugins():
    """Re-discover plugins from the plugins directory."""
    plugins = await plugin_manager.discover_plugins()

    return PluginsListResponse(
        plugins=[
            PluginInfo(
                name=p.name,
                plugin_type=p.plugin_type.value,
                display_name=p.display_name,
                description=p.description,
                version=p.version,
                author=p.author,
                enabled=p.enabled,
                error=p.error,
            )
            for p in plugins
        ],
        total=len(plugins),
    )

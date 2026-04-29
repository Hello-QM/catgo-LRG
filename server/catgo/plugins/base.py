"""
Base plugin classes for CatGo plugin system.

Plugin developers should inherit from these base classes to create
new calculators, optimizers, or other extensions.

Example Calculator Plugin:
    from catgo.plugins.base import CalculatorPlugin

    class MyCalculatorPlugin(CalculatorPlugin):
        name = "my-calculator"
        calculator_id = "my_calc"
        display_name = "My Custom Calculator"
        description = "A custom ML potential calculator"
        version = "1.0.0"
        author = "Your Name"

        supported_elements = ["H", "C", "N", "O"]  # Optional

        def get_calculator(self, **kwargs):
            from my_library import MyCalculator
            return MyCalculator(**kwargs)

        def get_parameter_schema(self) -> dict:
            return {
                "type": "object",
                "properties": {
                    "model": {"type": "string", "default": "default"},
                    "device": {"type": "string", "enum": ["cpu", "cuda"]}
                }
            }
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

if TYPE_CHECKING:
    from ase.calculators.calculator import Calculator


# =============================================================================
# Errors
# =============================================================================


class PluginError(Exception):
    """Base exception for plugin-related errors."""

    pass


class PluginLoadError(PluginError):
    """Raised when a plugin fails to load."""

    pass


class PluginValidationError(PluginError):
    """Raised when plugin validation fails."""

    pass


# =============================================================================
# Plugin Metadata
# =============================================================================


class PluginType(str, Enum):
    """Types of plugins supported by CatGo."""

    CALCULATOR = "calculator"
    OPTIMIZER = "optimizer"
    READER = "reader"
    ANALYZER = "analyzer"
    WORKFLOW_NODE = "workflow_node"
    ROUTER = "router"  # Future: custom API endpoints


@dataclass
class PluginMetadata:
    """Metadata about a loaded plugin."""

    name: str
    plugin_type: PluginType
    display_name: str
    description: str
    version: str
    author: str
    path: Path
    enabled: bool = True
    error: Optional[str] = None
    supported_elements: Optional[list[str]] = None
    parameter_schema: Optional[dict] = None
    extra: dict = field(default_factory=dict)


# =============================================================================
# Base Plugin Class
# =============================================================================


class BasePlugin(ABC):
    """
    Base class for all CatGo plugins.

    Plugin developers must implement required class attributes and methods.
    """

    # Required attributes - must be set by subclasses
    name: str  # Unique plugin identifier (e.g., "my-calculator")
    display_name: str  # Human-readable name
    description: str  # Brief description
    version: str  # Semantic version (e.g., "1.0.0")
    author: str  # Author name or organization

    # Optional attributes
    homepage: Optional[str] = None  # Project homepage
    license: Optional[str] = None  # License identifier
    requires: list[str] = []  # Python package dependencies

    # Internal - set by plugin manager
    _path: Optional[Path] = None
    _enabled: bool = True

    @classmethod
    def get_plugin_type(cls) -> PluginType:
        """Return the type of this plugin."""
        if issubclass(cls, CalculatorPlugin):
            return PluginType.CALCULATOR
        elif issubclass(cls, OptimizerPlugin):
            return PluginType.OPTIMIZER
        elif issubclass(cls, ReaderPlugin):
            return PluginType.READER
        elif issubclass(cls, AnalyzerPlugin):
            return PluginType.ANALYZER
        elif issubclass(cls, WorkflowNodePlugin):
            return PluginType.WORKFLOW_NODE
        else:
            raise NotImplementedError(f"Unknown plugin type for {cls.__name__}")

    @classmethod
    def validate(cls) -> list[str]:
        """
        Validate plugin configuration.

        Returns a list of validation error messages, or empty list if valid.
        """
        errors = []

        required_attrs = ["name", "display_name", "description", "version", "author"]
        for attr in required_attrs:
            if not hasattr(cls, attr) or not getattr(cls, attr):
                errors.append(f"Missing required attribute: {attr}")

        return errors

    def get_metadata(self) -> PluginMetadata:
        """Return plugin metadata."""
        return PluginMetadata(
            name=self.name,
            plugin_type=self.get_plugin_type(),
            display_name=self.display_name,
            description=self.description,
            version=self.version,
            author=self.author,
            path=self._path or Path("."),
            enabled=self._enabled,
        )

    async def on_load(self) -> None:
        """Called when plugin is loaded. Override for setup logic."""
        pass

    async def on_unload(self) -> None:
        """Called when plugin is unloaded. Override for cleanup logic."""
        pass


# =============================================================================
# Calculator Plugin
# =============================================================================


class CalculatorPlugin(BasePlugin):
    """
    Base class for calculator plugins.

    Calculator plugins provide ASE-compatible calculators for structure
    optimization and energy calculations.

    Example:
        class MACEPlugin(CalculatorPlugin):
            name = "mace-plugin"
            calculator_id = "mace_custom"
            display_name = "Custom MACE"
            description = "Custom trained MACE model"
            version = "1.0.0"
            author = "Your Name"

            def get_calculator(self, model_path=None, device="cpu"):
                from mace.calculators import MACECalculator
                return MACECalculator(model_path=model_path, device=device)
    """

    # Calculator-specific attributes
    calculator_id: str  # ID for API (e.g., "mace_custom")
    supported_elements: Optional[list[str]] = None  # None = all elements

    @abstractmethod
    def get_calculator(self, **kwargs) -> "Calculator":
        """
        Return an ASE-compatible calculator instance.

        Args:
            **kwargs: Calculator parameters from the request

        Returns:
            An ASE Calculator instance
        """
        pass

    def get_parameter_schema(self) -> Optional[dict]:
        """
        Return JSON schema for calculator parameters.

        This schema is used to validate parameters and generate UI forms.

        Returns:
            JSON schema dict or None if no parameters needed
        """
        return None

    def supports_structure(self, symbols: list[str]) -> tuple[bool, str]:
        """
        Check if calculator supports the given elements.

        Args:
            symbols: List of element symbols in the structure

        Returns:
            Tuple of (supported: bool, error_message: str)
        """
        if self.supported_elements is None:
            return True, ""

        unsupported = set(symbols) - set(self.supported_elements)
        if unsupported:
            return False, f"Unsupported elements: {', '.join(sorted(unsupported))}"
        return True, ""

    @classmethod
    def validate(cls) -> list[str]:
        """Validate calculator plugin configuration."""
        errors = super().validate()

        if not hasattr(cls, "calculator_id") or not cls.calculator_id:
            errors.append("Missing required attribute: calculator_id")

        # Check calculator_id is valid identifier
        if hasattr(cls, "calculator_id") and cls.calculator_id:
            calc_id = cls.calculator_id
            if not calc_id.replace("_", "").isalnum():
                errors.append(
                    f"calculator_id must be alphanumeric with underscores: {calc_id}"
                )

        return errors

    def get_metadata(self) -> PluginMetadata:
        """Return calculator plugin metadata."""
        meta = super().get_metadata()
        meta.supported_elements = self.supported_elements
        meta.parameter_schema = self.get_parameter_schema()
        meta.extra["calculator_id"] = self.calculator_id
        return meta


# =============================================================================
# Optimizer Plugin
# =============================================================================


class OptimizerPlugin(BasePlugin):
    """
    Base class for optimizer plugins.

    Optimizer plugins provide custom optimization algorithms that work
    with ASE calculators.

    Example:
        class BFGSPlugin(OptimizerPlugin):
            name = "custom-bfgs"
            optimizer_id = "custom_bfgs"
            display_name = "Custom BFGS"
            description = "Modified BFGS with custom line search"
            version = "1.0.0"
            author = "Your Name"

            def get_optimizer(self, atoms, **kwargs):
                return CustomBFGS(atoms, **kwargs)
    """

    # Optimizer-specific attributes
    optimizer_id: str  # ID for API
    supports_cell_optimization: bool = False  # Can optimize cell parameters

    @abstractmethod
    def get_optimizer(self, atoms: Any, **kwargs) -> Any:
        """
        Return an ASE-compatible optimizer instance.

        Args:
            atoms: ASE Atoms object to optimize
            **kwargs: Optimizer parameters

        Returns:
            An ASE Optimizer instance
        """
        pass

    def get_parameter_schema(self) -> Optional[dict]:
        """Return JSON schema for optimizer parameters."""
        return None

    @classmethod
    def validate(cls) -> list[str]:
        """Validate optimizer plugin configuration."""
        errors = super().validate()

        if not hasattr(cls, "optimizer_id") or not cls.optimizer_id:
            errors.append("Missing required attribute: optimizer_id")

        return errors

    def get_metadata(self) -> PluginMetadata:
        """Return optimizer plugin metadata."""
        meta = super().get_metadata()
        meta.parameter_schema = self.get_parameter_schema()
        meta.extra["optimizer_id"] = self.optimizer_id
        meta.extra["supports_cell_optimization"] = self.supports_cell_optimization
        return meta


# =============================================================================
# Reader Plugin
# =============================================================================


class ReaderPlugin(BasePlugin):
    """
    Base class for file reader plugins.

    Reader plugins parse domain-specific file formats (e.g., CP2K .pdos,
    Gaussian .log, VASP vaspout.h5) and produce standardized output dicts
    that can be fed into CatGo's analysis pipelines (DOS, bands, COHP, etc.).

    Example:
        class MyDosReader(ReaderPlugin):
            name = "my-dos-reader"
            reader_id = "my_dos"
            display_name = "My DOS Reader"
            description = "Reads custom DOS files"
            version = "1.0.0"
            author = "Your Name"

            supported_formats = [".mydos", ".dat"]
            output_type = "electronic_dos"

            async def read(self, file_paths, options=None):
                data = parse_my_format(file_paths[0])
                return {
                    "eigenvalues": data.eigenvalues,
                    "efermi": data.efermi,
                    ...
                }
    """

    # Reader-specific attributes
    reader_id: str = ""  # Unique ID for API (e.g., "cp2k_pdos")
    supported_formats: list[str] = []  # File extensions (e.g., [".pdos", ".h5"])
    output_type: str = ""  # Pipeline target: "electronic_dos" | "electronic_bands" | "cohp" | ...
    multi_file: bool = False  # Whether reader accepts multiple files at once
    required_files: list[str] = []  # Hint for required filenames (e.g., ["PROCAR"])
    optional_files: list[str] = []  # Hint for optional filenames (e.g., ["OUTCAR", "POSCAR"])

    @abstractmethod
    async def read(
        self, file_paths: list[str], options: Optional[dict] = None
    ) -> dict:
        """
        Read and parse input files, returning a standardized result dict.

        The returned dict must be compatible with VaspData construction or
        directly usable by the target pipeline (DOS session, band session, etc.).

        Args:
            file_paths: List of absolute file path strings
            options: Optional reader-specific parameters

        Returns:
            Dict with parsed data. For output_type="electronic_dos", must contain:
                - eigenvalues: ndarray (nspin, nkpts, nbands)
                - kweights: ndarray (nkpts,)
                - efermi: float (eV)
                - projectors: ndarray (nspin, nions, nchannels, nkpts, nbands)
                - positions: ndarray (nions, 3) — Cartesian Angstrom
                - positions_frac: ndarray (nions, 3)
                - lattice: ndarray (3, 3)
                - elements: list[str]
                - ion_types: list[str]
                - ion_counts: list[int]

        Raises:
            ValueError: If files cannot be parsed.
            FileNotFoundError: If required files are missing.
        """
        ...

    def detect_files(self, filenames: list[str]) -> bool:
        """
        Check if this reader can handle the given set of files.

        Default: matches if ANY filename has a supported extension.
        Override for multi-file readers that need specific combinations.

        Args:
            filenames: Candidate filenames (just names, not full paths)

        Returns:
            True if this reader can handle at least one of the files
        """
        for fn in filenames:
            lower = fn.lower()
            for ext in self.supported_formats:
                if lower.endswith(ext.lower()):
                    return True
        return False

    def priority_score(self, filenames: list[str]) -> int:
        """
        Return match priority (higher = better match).

        Used when multiple readers claim to handle the same files.
        Default: number of matching files.

        Args:
            filenames: Candidate filenames

        Returns:
            Integer priority score (higher = preferred)
        """
        score = 0
        for fn in filenames:
            lower = fn.lower()
            for ext in self.supported_formats:
                if lower.endswith(ext.lower()):
                    score += 1
        return score

    _VALID_OUTPUT_TYPES = {
        "electronic_dos", "electronic_bands", "cohp",
        "structure", "trajectory", "volumetric",
        "scatter_plot", "bar_plot", "table", "image",
    }

    @classmethod
    def validate(cls) -> list[str]:
        """Validate reader plugin configuration."""
        errors = super().validate()

        if not hasattr(cls, "reader_id") or not cls.reader_id:
            errors.append("Missing required attribute: reader_id")

        if not hasattr(cls, "supported_formats") or not cls.supported_formats:
            errors.append("Missing required attribute: supported_formats")

        if not hasattr(cls, "output_type") or not cls.output_type:
            errors.append("Missing required attribute: output_type")

        if hasattr(cls, "output_type") and cls.output_type and cls.output_type not in cls._VALID_OUTPUT_TYPES:
            errors.append(
                f"Invalid output_type '{cls.output_type}'. "
                f"Must be one of: {cls._VALID_OUTPUT_TYPES}"
            )

        return errors

    def get_metadata(self) -> PluginMetadata:
        """Return reader plugin metadata."""
        meta = super().get_metadata()
        meta.extra["reader_id"] = self.reader_id
        meta.extra["supported_formats"] = self.supported_formats
        meta.extra["output_type"] = self.output_type
        meta.extra["multi_file"] = self.multi_file
        return meta


# =============================================================================
# Analyzer Plugin
# =============================================================================


class AnalyzerPlugin(BasePlugin):
    """
    Base class for analysis tool plugins.

    Analyzer plugins take structured input (typically a structure + parameters)
    and produce visualization data (plots, tables, images).

    The output_type determines which frontend renderer is used:
    - "scatter_plot": DataSeries-compatible output -> ScatterPlot component
    - "bar_plot": BarSeries-compatible output -> BarPlot component
    - "table": Tabular data -> HTML table
    - "image": Base64 image -> <img> tag
    - "text": Plain text / markdown

    Example:
        class BondHistogramPlugin(AnalyzerPlugin):
            name = "bond-histogram"
            analyzer_id = "bond_histogram"
            display_name = "Bond Length Histogram"
            description = "Distribution of bond lengths in the structure"
            version = "1.0.0"
            author = "CatGo Team"

            output_type = "bar_plot"
            input_schema = {
                "type": "object",
                "properties": {
                    "structure": {"type": "object"},
                    "n_bins": {"type": "integer", "default": 30},
                    "max_distance": {"type": "number", "default": 4.0},
                },
                "required": ["structure"]
            }

            async def analyze(self, input_data):
                # Parse structure, compute bond lengths, histogram
                return {
                    "series": [{"x": bin_centers, "y": counts, "label": "Bond Lengths"}],
                    "x_axis": {"label": "Distance (A)"},
                    "y_axis": {"label": "Count"},
                }
    """

    # Analyzer-specific attributes
    analyzer_id: str = ""  # API identifier (e.g., "bond_histogram")
    output_type: str = "table"  # "scatter_plot" | "bar_plot" | "table" | "image" | "text"
    input_schema: dict = {}  # JSON Schema for analyze() input

    @abstractmethod
    async def analyze(self, input_data: dict) -> dict:
        """
        Run analysis and produce visualization data.

        Args:
            input_data: Input matching input_schema (typically includes "structure")

        Returns:
            Dict formatted according to output_type:

            scatter_plot / bar_plot:
            {
                "series": [
                    {"x": [...], "y": [...], "label": "Series 1"},
                ],
                "x_axis": {"label": "X Label", "unit": "eV"},
                "y_axis": {"label": "Y Label"},
            }

            table:
            {
                "columns": [
                    {"key": "element", "label": "Element"},
                    {"key": "cn", "label": "CN", "format": ".0f"},
                ],
                "rows": [
                    {"element": "Fe", "cn": 8},
                ],
            }

            image:
            {
                "data": "base64-encoded-image-data",
                "mime": "image/png",
                "width": 800, "height": 600,
            }

            text:
            {
                "content": "Markdown formatted text...",
            }
        """
        pass

    @classmethod
    def validate(cls) -> list[str]:
        """Validate analyzer plugin configuration."""
        errors = super().validate()

        if not hasattr(cls, "analyzer_id") or not cls.analyzer_id:
            errors.append("Missing required attribute: analyzer_id")

        if not hasattr(cls, "output_type") or not cls.output_type:
            errors.append("Missing required attribute: output_type")

        valid_types = {"scatter_plot", "bar_plot", "table", "image", "text"}
        if hasattr(cls, "output_type") and cls.output_type and cls.output_type not in valid_types:
            errors.append(
                f"Invalid output_type: {cls.output_type}. Must be one of {valid_types}"
            )

        if not hasattr(cls, "input_schema") or not cls.input_schema:
            errors.append("Missing required attribute: input_schema")

        return errors

    def get_metadata(self) -> PluginMetadata:
        """Return analyzer plugin metadata."""
        meta = super().get_metadata()
        meta.extra["analyzer_id"] = self.analyzer_id
        meta.extra["output_type"] = self.output_type
        meta.extra["input_schema"] = self.input_schema
        return meta


# =============================================================================
# Workflow Node Plugin
# =============================================================================


class WorkflowNodePlugin(BasePlugin):
    """
    Base class for workflow node plugins.

    Defines a custom node type for the visual workflow editor.
    Each plugin provides:
    - node_definition: UI metadata (label, icon, category, params)
    - execute(): async function called during workflow execution
    - execution_mode: "local" (run on CatGo server) or "hpc" (submit to HPC)

    Example:
        class CustomMDNode(WorkflowNodePlugin):
            name = "custom-md-node"
            node_type = "custom_md"
            display_name = "Custom MD"
            description = "Run MD with custom force field"
            version = "1.0.0"
            author = "Your Name"
            execution_mode = "local"

            node_definition = {
                "type": "custom_md",
                "label": "Custom MD",
                "color": "#22c55e",
                "icon": "🏃",
                "category": "Plugin",
                "description": "Run MD with custom force field",
                "inputs": ["structure"],
                "outputs": ["trajectory"],
                "default_params": {"steps": 1000, "temperature": 300},
                "param_schema": [
                    {"key": "steps", "label": "Steps", "type": "number", "default": 1000},
                    {"key": "temperature", "label": "Temperature (K)", "type": "number", "default": 300},
                ],
            }

            async def execute(self, structure_json, params, config):
                return {"structure_json": optimized_json, "trajectory": frames}
    """

    # Workflow node attributes
    node_type: str  # Unique node type ID (e.g., "custom_md")
    node_definition: dict  # NodeDefinition-compatible dict for frontend UI
    execution_mode: str = "local"  # "local" | "hpc"

    @abstractmethod
    async def execute(
        self,
        structure_json: str,
        params: dict,
        config: dict,
    ) -> dict:
        """
        Execute the workflow node.

        Args:
            structure_json: Input structure as JSON string (pymatgen dict)
            params: Node parameters from the workflow editor
            config: Workflow run configuration (execution_mode, hpc settings, etc.)

        Returns:
            Result dict. Must include "structure_json" key if node outputs a structure.
        """
        pass

    @classmethod
    def validate(cls) -> list[str]:
        """Validate workflow node plugin configuration."""
        errors = super().validate()

        if not hasattr(cls, "node_type") or not cls.node_type:
            errors.append("Missing required attribute: node_type")

        if not hasattr(cls, "node_definition") or not cls.node_definition:
            errors.append("Missing required attribute: node_definition")

        # Validate node_definition has required keys
        required_keys = {"type", "label", "color", "icon", "category", "description", "inputs", "outputs"}
        if hasattr(cls, "node_definition") and cls.node_definition:
            missing = required_keys - set(cls.node_definition.keys())
            if missing:
                errors.append(f"node_definition missing keys: {missing}")

        return errors

    def get_metadata(self) -> PluginMetadata:
        """Return workflow node plugin metadata."""
        meta = super().get_metadata()
        meta.extra["node_type"] = self.node_type
        meta.extra["node_definition"] = self.node_definition
        meta.extra["execution_mode"] = self.execution_mode
        return meta

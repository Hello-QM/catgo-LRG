"""
Plugin Manager for CatGo backend.

The PluginManager is responsible for:
- Discovering and loading plugins
- Managing plugin lifecycle (enable/disable)
- Registering plugin calculators/optimizers
- Providing API for querying plugins
"""

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from .base import (
    AnalyzerPlugin,
    BasePlugin,
    CalculatorPlugin,
    OptimizerPlugin,
    ReaderPlugin,
    WorkflowNodePlugin,
    PluginMetadata,
    PluginType,
    PluginError,
)
from .discovery import discover_plugins, get_plugins_directory, load_plugin_from_path

if TYPE_CHECKING:
    from ase.calculators.calculator import Calculator

logger = logging.getLogger(__name__)


class PluginManager:
    """
    Central manager for all CatGo plugins.

    Usage:
        from catgo.plugins import plugin_manager

        # Initialize on server startup
        await plugin_manager.initialize()

        # Get all calculators (built-in + plugins)
        calculators = plugin_manager.get_all_calculators()

        # Get specific plugin calculator
        calc = plugin_manager.get_calculator("my_plugin_calc", device="cuda")
    """

    def __init__(self):
        self._plugins: dict[str, BasePlugin] = {}  # name -> plugin
        self._calculator_plugins: dict[str, CalculatorPlugin] = {}  # calc_id -> plugin
        self._optimizer_plugins: dict[str, OptimizerPlugin] = {}  # opt_id -> plugin
        self._reader_plugins: dict[str, ReaderPlugin] = {}  # reader_id -> plugin
        self._analyzer_plugins: dict[str, AnalyzerPlugin] = {}  # analyzer_id -> plugin
        self._workflow_node_plugins: dict[str, WorkflowNodePlugin] = {}  # node_type -> plugin
        self._initialized = False
        self._plugins_dir: Optional[Path] = None

    @property
    def plugins_directory(self) -> Path:
        """Get the plugins directory path."""
        if self._plugins_dir is None:
            self._plugins_dir = get_plugins_directory()
        return self._plugins_dir

    async def initialize(self, plugins_dir: Optional[Path] = None) -> None:
        """
        Initialize the plugin manager and discover plugins.

        Args:
            plugins_dir: Optional custom plugins directory
        """
        if self._initialized:
            logger.warning("PluginManager already initialized")
            return

        if plugins_dir:
            self._plugins_dir = plugins_dir

        logger.info(f"Initializing PluginManager with plugins dir: {self.plugins_directory}")

        # Discover and load plugins
        await self.discover_plugins()

        # Register built-in readers
        await self._register_builtin_readers()

        self._initialized = True
        logger.info(
            f"PluginManager initialized: {len(self._plugins)} plugins, "
            f"{len(self._calculator_plugins)} calculators, "
            f"{len(self._optimizer_plugins)} optimizers, "
            f"{len(self._reader_plugins)} readers, "
            f"{len(self._analyzer_plugins)} analyzers, "
            f"{len(self._workflow_node_plugins)} workflow nodes"
        )

    async def discover_plugins(self) -> list[PluginMetadata]:
        """
        Discover and load all plugins from the plugins directory.

        Returns:
            List of plugin metadata for all discovered plugins
        """
        results = discover_plugins(self.plugins_directory)
        loaded_plugins: list[PluginMetadata] = []

        for path, plugin, error in results:
            if error:
                logger.warning(f"Plugin at {path} failed to load: {error}")
                # Create error metadata
                loaded_plugins.append(
                    PluginMetadata(
                        name=path.name,
                        plugin_type=PluginType.CALCULATOR,
                        display_name=path.name,
                        description="Failed to load",
                        version="unknown",
                        author="unknown",
                        path=path,
                        enabled=False,
                        error=error,
                    )
                )
            elif plugin:
                await self._register_plugin(plugin)
                loaded_plugins.append(plugin.get_metadata())

        return loaded_plugins

    async def _register_plugin(self, plugin: BasePlugin) -> None:
        """Register a plugin and its contributions."""
        # Store in main registry
        self._plugins[plugin.name] = plugin

        # Register by type
        if isinstance(plugin, CalculatorPlugin):
            if plugin.calculator_id in self._calculator_plugins:
                logger.warning(
                    f"Calculator ID '{plugin.calculator_id}' already registered, "
                    f"overwriting with plugin '{plugin.name}'"
                )
            self._calculator_plugins[plugin.calculator_id] = plugin
            logger.info(f"Registered calculator: {plugin.calculator_id}")

        elif isinstance(plugin, OptimizerPlugin):
            if plugin.optimizer_id in self._optimizer_plugins:
                logger.warning(
                    f"Optimizer ID '{plugin.optimizer_id}' already registered, "
                    f"overwriting with plugin '{plugin.name}'"
                )
            self._optimizer_plugins[plugin.optimizer_id] = plugin
            logger.info(f"Registered optimizer: {plugin.optimizer_id}")

        elif isinstance(plugin, ReaderPlugin):
            if plugin.reader_id in self._reader_plugins:
                logger.warning(
                    f"Reader ID '{plugin.reader_id}' already registered, "
                    f"overwriting with plugin '{plugin.name}'"
                )
            self._reader_plugins[plugin.reader_id] = plugin
            logger.info(f"Registered reader: {plugin.reader_id}")

        elif isinstance(plugin, AnalyzerPlugin):
            if plugin.analyzer_id in self._analyzer_plugins:
                logger.warning(
                    f"Analyzer ID '{plugin.analyzer_id}' already registered, "
                    f"overwriting with plugin '{plugin.name}'"
                )
            self._analyzer_plugins[plugin.analyzer_id] = plugin
            logger.info(f"Registered analyzer: {plugin.analyzer_id}")

        elif isinstance(plugin, WorkflowNodePlugin):
            if plugin.node_type in self._workflow_node_plugins:
                logger.warning(
                    f"Workflow node type '{plugin.node_type}' already registered, "
                    f"overwriting with plugin '{plugin.name}'"
                )
            self._workflow_node_plugins[plugin.node_type] = plugin
            logger.info(f"Registered workflow node: {plugin.node_type}")

        # Call plugin's on_load hook
        try:
            await plugin.on_load()
        except Exception as e:
            logger.exception(f"Error in plugin {plugin.name} on_load: {e}")

    async def install_plugin(
        self,
        source: str | Path,
        install_requirements: bool = True,
    ) -> PluginMetadata:
        """
        Install a plugin from a path or URL.

        Args:
            source: Path to plugin directory or ZIP file, or URL
            install_requirements: Whether to install requirements.txt

        Returns:
            Metadata of installed plugin

        Raises:
            PluginError: If installation fails
        """
        from .discovery import install_requirements as install_reqs

        source_path = Path(source) if isinstance(source, str) else source

        if not source_path.exists():
            raise PluginError(f"Plugin source not found: {source_path}")

        # If it's a ZIP file, extract it
        if source_path.suffix == ".zip":
            source_path = await self._extract_plugin_zip(source_path)

        # Install requirements if requested
        if install_requirements:
            success, message = install_reqs(source_path)
            if not success:
                logger.warning(f"Failed to install requirements: {message}")

        # Load the plugin
        plugin = load_plugin_from_path(source_path)
        await self._register_plugin(plugin)

        return plugin.get_metadata()

    async def _extract_plugin_zip(self, zip_path: Path) -> Path:
        """Extract a plugin ZIP file to the plugins directory."""
        import zipfile

        # Extract to plugins directory
        extract_dir = self.plugins_directory / zip_path.stem

        if extract_dir.exists():
            raise PluginError(
                f"Plugin directory already exists: {extract_dir}. "
                "Please uninstall the existing plugin first."
            )

        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_dir)

        return extract_dir

    async def uninstall_plugin(self, plugin_name: str) -> bool:
        """
        Uninstall a plugin.

        Args:
            plugin_name: Name of the plugin to uninstall

        Returns:
            True if successfully uninstalled
        """
        import shutil

        if plugin_name not in self._plugins:
            raise PluginError(f"Plugin not found: {plugin_name}")

        plugin = self._plugins[plugin_name]

        # Call unload hook
        try:
            await plugin.on_unload()
        except Exception as e:
            logger.exception(f"Error in plugin {plugin_name} on_unload: {e}")

        # Remove from registries
        del self._plugins[plugin_name]

        if isinstance(plugin, CalculatorPlugin):
            del self._calculator_plugins[plugin.calculator_id]

        if isinstance(plugin, OptimizerPlugin):
            del self._optimizer_plugins[plugin.optimizer_id]

        if isinstance(plugin, ReaderPlugin):
            del self._reader_plugins[plugin.reader_id]

        if isinstance(plugin, AnalyzerPlugin):
            del self._analyzer_plugins[plugin.analyzer_id]

        if isinstance(plugin, WorkflowNodePlugin):
            del self._workflow_node_plugins[plugin.node_type]

        # Remove plugin directory
        if plugin._path and plugin._path.exists():
            shutil.rmtree(plugin._path)
            logger.info(f"Removed plugin directory: {plugin._path}")

        return True

    def enable_plugin(self, plugin_name: str) -> bool:
        """Enable a plugin."""
        if plugin_name not in self._plugins:
            raise PluginError(f"Plugin not found: {plugin_name}")

        self._plugins[plugin_name]._enabled = True
        return True

    def disable_plugin(self, plugin_name: str) -> bool:
        """Disable a plugin."""
        if plugin_name not in self._plugins:
            raise PluginError(f"Plugin not found: {plugin_name}")

        self._plugins[plugin_name]._enabled = False
        return True

    # =========================================================================
    # Calculator Methods
    # =========================================================================

    def get_calculator(self, calculator_id: str, **kwargs) -> "Calculator":
        """
        Get a calculator instance from a plugin.

        Args:
            calculator_id: The calculator ID
            **kwargs: Calculator parameters

        Returns:
            ASE Calculator instance

        Raises:
            PluginError: If calculator not found or disabled
        """
        if calculator_id not in self._calculator_plugins:
            raise PluginError(f"Calculator not found: {calculator_id}")

        plugin = self._calculator_plugins[calculator_id]

        if not plugin._enabled:
            raise PluginError(f"Calculator plugin is disabled: {calculator_id}")

        return plugin.get_calculator(**kwargs)

    def has_calculator(self, calculator_id: str) -> bool:
        """Check if a calculator plugin is registered."""
        return calculator_id in self._calculator_plugins

    def get_calculator_info(self, calculator_id: str) -> Optional[dict]:
        """Get information about a calculator plugin."""
        if calculator_id not in self._calculator_plugins:
            return None

        plugin = self._calculator_plugins[calculator_id]
        return {
            "id": calculator_id,
            "name": plugin.name,
            "display_name": plugin.display_name,
            "description": plugin.description,
            "version": plugin.version,
            "author": plugin.author,
            "enabled": plugin._enabled,
            "supported_elements": plugin.supported_elements,
            "parameter_schema": plugin.get_parameter_schema(),
        }

    def get_all_calculators(self) -> list[dict]:
        """Get information about all registered calculator plugins."""
        return [
            self.get_calculator_info(calc_id)
            for calc_id in self._calculator_plugins.keys()
        ]

    # =========================================================================
    # Optimizer Methods
    # =========================================================================

    def get_optimizer(self, optimizer_id: str, atoms: Any, **kwargs) -> Any:
        """
        Get an optimizer instance from a plugin.

        Args:
            optimizer_id: The optimizer ID
            atoms: ASE Atoms object
            **kwargs: Optimizer parameters

        Returns:
            ASE Optimizer instance
        """
        if optimizer_id not in self._optimizer_plugins:
            raise PluginError(f"Optimizer not found: {optimizer_id}")

        plugin = self._optimizer_plugins[optimizer_id]

        if not plugin._enabled:
            raise PluginError(f"Optimizer plugin is disabled: {optimizer_id}")

        return plugin.get_optimizer(atoms, **kwargs)

    def has_optimizer(self, optimizer_id: str) -> bool:
        """Check if an optimizer plugin is registered."""
        return optimizer_id in self._optimizer_plugins

    def get_all_optimizers(self) -> list[dict]:
        """Get information about all registered optimizer plugins."""
        return [
            {
                "id": plugin.optimizer_id,
                "name": plugin.name,
                "display_name": plugin.display_name,
                "description": plugin.description,
                "version": plugin.version,
                "enabled": plugin._enabled,
                "supports_cell_optimization": plugin.supports_cell_optimization,
                "parameter_schema": plugin.get_parameter_schema(),
            }
            for plugin in self._optimizer_plugins.values()
        ]

    # =========================================================================
    # Reader Methods
    # =========================================================================

    def get_reader(self, reader_id: str) -> ReaderPlugin:
        """
        Get a reader plugin by ID.

        Args:
            reader_id: The reader ID

        Returns:
            ReaderPlugin instance

        Raises:
            PluginError: If reader not found or disabled
        """
        if reader_id not in self._reader_plugins:
            raise PluginError(f"Reader not found: {reader_id}")

        plugin = self._reader_plugins[reader_id]

        if not plugin._enabled:
            raise PluginError(f"Reader plugin is disabled: {reader_id}")

        return plugin

    def has_reader(self, reader_id: str) -> bool:
        """Check if a reader plugin is registered."""
        return reader_id in self._reader_plugins

    def find_reader_for_files(self, filenames: list[str]) -> Optional[ReaderPlugin]:
        """
        Find the best matching reader for a set of filenames.

        Iterates all registered readers, checks detect_files(), and returns
        the one with the highest priority_score().

        Args:
            filenames: List of filenames (not full paths)

        Returns:
            Best matching ReaderPlugin, or None if no match
        """
        best_reader: Optional[ReaderPlugin] = None
        best_score = 0

        for plugin in self._reader_plugins.values():
            if not plugin._enabled:
                continue
            if plugin.detect_files(filenames):
                score = plugin.priority_score(filenames)
                if score > best_score:
                    best_score = score
                    best_reader = plugin

        return best_reader

    def get_all_readers(self) -> list[dict]:
        """Get information about all registered reader plugins."""
        return [
            {
                "reader_id": plugin.reader_id,
                "name": plugin.name,
                "display_name": plugin.display_name,
                "description": plugin.description,
                "version": plugin.version,
                "enabled": plugin._enabled,
                "formats": plugin.supported_formats,
                "output_type": plugin.output_type,
                "multi_file": plugin.multi_file,
            }
            for plugin in self._reader_plugins.values()
        ]

    async def _register_builtin_readers(self) -> None:
        """Register built-in file readers as ReaderPlugin instances."""
        try:
            from .builtin_readers import BUILTIN_READERS

            for reader_cls in BUILTIN_READERS:
                try:
                    instance = reader_cls()
                    instance._path = Path(__file__).parent
                    await self._register_plugin(instance)
                except Exception as e:
                    logger.warning(f"Failed to register builtin reader {reader_cls.__name__}: {e}")
        except ImportError as e:
            logger.debug(f"Builtin readers not available: {e}")

    # =========================================================================
    # Analyzer Methods
    # =========================================================================

    def get_analyzer(self, analyzer_id: str) -> AnalyzerPlugin:
        """
        Get an analyzer plugin by ID.

        Args:
            analyzer_id: The analyzer ID

        Returns:
            AnalyzerPlugin instance

        Raises:
            PluginError: If analyzer not found or disabled
        """
        if analyzer_id not in self._analyzer_plugins:
            raise PluginError(f"Analyzer not found: {analyzer_id}")

        plugin = self._analyzer_plugins[analyzer_id]

        if not plugin._enabled:
            raise PluginError(f"Analyzer plugin is disabled: {analyzer_id}")

        return plugin

    def has_analyzer(self, analyzer_id: str) -> bool:
        """Check if an analyzer plugin is registered."""
        return analyzer_id in self._analyzer_plugins

    def get_all_analyzers(self) -> list[dict]:
        """Get information about all registered analyzer plugins."""
        return [
            {
                "analyzer_id": p.analyzer_id,
                "name": p.name,
                "display_name": p.display_name,
                "description": p.description,
                "output_type": p.output_type,
                "input_schema": p.input_schema,
                "enabled": p._enabled,
            }
            for p in self._analyzer_plugins.values()
        ]

    # =========================================================================
    # Workflow Node Methods
    # =========================================================================

    def get_workflow_node(self, node_type: str) -> WorkflowNodePlugin:
        """
        Get a workflow node plugin by node type.

        Args:
            node_type: The node type ID

        Returns:
            WorkflowNodePlugin instance

        Raises:
            PluginError: If node type not found or disabled
        """
        if node_type not in self._workflow_node_plugins:
            raise PluginError(f"Workflow node not found: {node_type}")

        plugin = self._workflow_node_plugins[node_type]

        if not plugin._enabled:
            raise PluginError(f"Workflow node plugin is disabled: {node_type}")

        return plugin

    def has_workflow_node(self, node_type: str) -> bool:
        """Check if a workflow node plugin is registered."""
        return node_type in self._workflow_node_plugins

    def get_all_workflow_nodes(self) -> list[dict]:
        """Get all workflow node plugin definitions (for frontend)."""
        return [
            plugin.node_definition
            for plugin in self._workflow_node_plugins.values()
            if plugin._enabled
        ]

    # =========================================================================
    # General Plugin Methods
    # =========================================================================

    def get_plugin(self, plugin_name: str) -> Optional[BasePlugin]:
        """Get a plugin by name."""
        return self._plugins.get(plugin_name)

    def get_all_plugins(self) -> list[PluginMetadata]:
        """Get metadata for all registered plugins."""
        return [plugin.get_metadata() for plugin in self._plugins.values()]

    def get_plugins_by_type(self, plugin_type: PluginType) -> list[PluginMetadata]:
        """Get all plugins of a specific type."""
        return [
            plugin.get_metadata()
            for plugin in self._plugins.values()
            if plugin.get_plugin_type() == plugin_type
        ]


# Global singleton instance
plugin_manager = PluginManager()

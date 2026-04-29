"""
Plugin discovery and loading utilities.

This module handles discovering plugins from the file system,
loading them dynamically, and validating their structure.
"""

import importlib.util
import json
import logging
import sys
from pathlib import Path
from typing import Optional, Type

from .base import (
    AnalyzerPlugin,
    BasePlugin,
    CalculatorPlugin,
    OptimizerPlugin,
    ReaderPlugin,
    WorkflowNodePlugin,
    PluginError,
    PluginLoadError,
    PluginValidationError,
)

logger = logging.getLogger(__name__)


def get_plugins_directory() -> Path:
    """Get the path to the user plugins directory."""
    # Look for plugins directory relative to server
    server_dir = Path(__file__).parent.parent
    project_dir = server_dir.parent

    # Try multiple locations
    possible_paths = [
        project_dir / "plugins",  # Project root/plugins
        server_dir / "plugins",  # server/plugins
        Path.home() / ".catgo" / "plugins",  # User home
    ]

    for path in possible_paths:
        if path.exists():
            return path

    # Default to project root/plugins, create if needed
    default_path = project_dir / "plugins"
    default_path.mkdir(exist_ok=True)
    return default_path


def discover_plugins(
    plugins_dir: Optional[Path] = None,
) -> list[tuple[Path, Optional[BasePlugin], Optional[str]]]:
    """
    Discover all plugins in the plugins directory.

    Args:
        plugins_dir: Optional path to plugins directory

    Returns:
        List of tuples: (plugin_path, plugin_instance or None, error or None)
    """
    if plugins_dir is None:
        plugins_dir = get_plugins_directory()

    results: list[tuple[Path, Optional[BasePlugin], Optional[str]]] = []

    if not plugins_dir.exists():
        logger.info(f"Plugins directory does not exist: {plugins_dir}")
        return results

    # Look for plugin directories (contain catgo-plugin.json or plugin.py)
    for item in plugins_dir.iterdir():
        if not item.is_dir():
            continue

        # Skip hidden directories and __pycache__
        if item.name.startswith(".") or item.name == "__pycache__":
            continue

        try:
            plugin = load_plugin_from_path(item)
            results.append((item, plugin, None))
            logger.info(f"Loaded plugin: {plugin.name} from {item}")
        except PluginError as e:
            logger.warning(f"Failed to load plugin from {item}: {e}")
            results.append((item, None, str(e)))
        except Exception as e:
            logger.exception(f"Unexpected error loading plugin from {item}")
            results.append((item, None, f"Unexpected error: {e}"))

    return results


def load_plugin_from_path(plugin_path: Path) -> BasePlugin:
    """
    Load a plugin from a directory path.

    The plugin directory should contain either:
    - catgo-plugin.json (manifest) + main Python file
    - plugin.py (standalone plugin module)

    Args:
        plugin_path: Path to plugin directory

    Returns:
        Loaded plugin instance

    Raises:
        PluginLoadError: If plugin cannot be loaded
        PluginValidationError: If plugin fails validation
    """
    if not plugin_path.is_dir():
        raise PluginLoadError(f"Plugin path is not a directory: {plugin_path}")

    # Check for manifest
    manifest_path = plugin_path / "catgo-plugin.json"
    if manifest_path.exists():
        return _load_plugin_with_manifest(plugin_path, manifest_path)

    # Fallback to plugin.py
    plugin_py = plugin_path / "plugin.py"
    if plugin_py.exists():
        return _load_plugin_module(plugin_path, plugin_py)

    raise PluginLoadError(
        f"No plugin found in {plugin_path}. "
        "Expected catgo-plugin.json or plugin.py"
    )


def _load_plugin_with_manifest(plugin_path: Path, manifest_path: Path) -> BasePlugin:
    """Load plugin using manifest file."""
    try:
        with open(manifest_path) as f:
            manifest = json.load(f)
    except json.JSONDecodeError as e:
        raise PluginLoadError(f"Invalid JSON in manifest: {e}")

    # Get catgo configuration
    catgo_config = manifest.get("catgo", {})
    backend_config = catgo_config.get("backend", {})

    # Find main Python file
    main_file = backend_config.get("main", "plugin.py")
    main_path = plugin_path / main_file

    if not main_path.exists():
        raise PluginLoadError(f"Main file not found: {main_path}")

    # Load the module
    plugin = _load_plugin_module(plugin_path, main_path)

    # Update plugin metadata from manifest if not set
    if not hasattr(plugin, "version") or not plugin.version:
        plugin.version = manifest.get("version", "0.0.0")
    if not hasattr(plugin, "display_name") or not plugin.display_name:
        plugin.display_name = manifest.get("displayName", manifest.get("name", ""))

    return plugin


def _load_plugin_module(plugin_path: Path, module_path: Path) -> BasePlugin:
    """Load plugin from a Python module."""
    module_name = f"catgo_plugin_{plugin_path.name.replace('-', '_')}"

    # Create module spec
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise PluginLoadError(f"Cannot create module spec for {module_path}")

    # Load module
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module

    try:
        spec.loader.exec_module(module)
    except Exception as e:
        del sys.modules[module_name]
        raise PluginLoadError(f"Error executing plugin module: {e}")

    # Find plugin class
    plugin_class = _find_plugin_class(module)
    if plugin_class is None:
        del sys.modules[module_name]
        raise PluginLoadError(
            f"No plugin class found in {module_path}. "
            "Module must define a class inheriting from CalculatorPlugin, OptimizerPlugin, ReaderPlugin, AnalyzerPlugin, or WorkflowNodePlugin"
        )

    # Validate plugin
    errors = plugin_class.validate()
    if errors:
        del sys.modules[module_name]
        raise PluginValidationError(
            f"Plugin validation failed: {'; '.join(errors)}"
        )

    # Create instance
    try:
        instance = plugin_class()
        instance._path = plugin_path
        return instance
    except Exception as e:
        del sys.modules[module_name]
        raise PluginLoadError(f"Error instantiating plugin: {e}")


def _find_plugin_class(module) -> Optional[Type[BasePlugin]]:
    """Find the main plugin class in a module."""
    plugin_classes: list[Type[BasePlugin]] = []

    for name in dir(module):
        if name.startswith("_"):
            continue

        obj = getattr(module, name)

        # Check if it's a class that inherits from our base classes
        if not isinstance(obj, type):
            continue

        if obj in (BasePlugin, CalculatorPlugin, OptimizerPlugin, ReaderPlugin, AnalyzerPlugin, WorkflowNodePlugin):
            continue

        if issubclass(obj, (CalculatorPlugin, OptimizerPlugin, ReaderPlugin, AnalyzerPlugin, WorkflowNodePlugin)):
            plugin_classes.append(obj)

    if not plugin_classes:
        return None

    # If multiple classes found, prefer ones with explicit name attribute
    for cls in plugin_classes:
        if hasattr(cls, "name") and cls.name:
            return cls

    # Return first found
    return plugin_classes[0]


def install_requirements(plugin_path: Path) -> tuple[bool, str]:
    """
    Install plugin requirements from requirements.txt.

    Args:
        plugin_path: Path to plugin directory

    Returns:
        Tuple of (success: bool, message: str)
    """
    import subprocess

    requirements_file = plugin_path / "requirements.txt"

    if not requirements_file.exists():
        return True, "No requirements.txt found"

    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-r", str(requirements_file)],
            capture_output=True,
            text=True,
            timeout=300,  # 5 minute timeout
        )

        if result.returncode == 0:
            return True, "Requirements installed successfully"
        else:
            return False, f"pip install failed: {result.stderr}"

    except subprocess.TimeoutExpired:
        return False, "Installation timed out"
    except Exception as e:
        return False, f"Installation error: {e}"

"""
CatGo Plugin System - Backend

This module provides the plugin infrastructure for extending CatGo's
backend functionality with custom calculators, optimizers, and more.

Example usage:
    from catgo.plugins import plugin_manager

    # Initialize and discover plugins
    await plugin_manager.discover_plugins()

    # Get all registered calculators (built-in + plugins)
    calculators = plugin_manager.get_all_calculators()
"""

from .base import (
    BasePlugin,
    CalculatorPlugin,
    OptimizerPlugin,
    ReaderPlugin,
    AnalyzerPlugin,
    WorkflowNodePlugin,
    PluginMetadata,
    PluginError,
    PluginLoadError,
    PluginValidationError,
)
from .manager import plugin_manager
from .discovery import discover_plugins, load_plugin_from_path

__all__ = [
    # Base classes
    "BasePlugin",
    "CalculatorPlugin",
    "OptimizerPlugin",
    "ReaderPlugin",
    "AnalyzerPlugin",
    "WorkflowNodePlugin",
    "PluginMetadata",
    # Errors
    "PluginError",
    "PluginLoadError",
    "PluginValidationError",
    # Manager
    "plugin_manager",
    # Discovery
    "discover_plugins",
    "load_plugin_from_path",
]

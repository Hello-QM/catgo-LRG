"""MCP Tools package — CatGo's Model Context Protocol tool server.

Package structure:
    server.py            — MCP server setup, tool listing, call dispatch
    helpers.py           — Shared helpers (push to viewer, schema stripping, etc.)
    workflow_tools.py    — Workflow tool handlers (create, add_node, connect, run, etc.)
    structure_tools.py   — Structure/viewer tool handlers (OPTIMADE, PubChem, set-lattice)
    plugin_tools.py      — Plugin manager and plugin tool handlers
    tool_types.py        — TypedDict definitions for tool schemas
    tools/               — Tool definitions grouped by category
        structure.py, optimization.py, adsorption.py,
        nanotube_moire.py, view.py, dft_input.py,
        analysis.py, misc.py
"""

__all__ = ["main", "server"]

from .server import main, server

"""MCP over SSE — serves the 5 consolidated CatGO tools via HTTP.

Embeds the MCP server directly in the FastAPI backend so Claude Code
can connect with just a URL (no Python or source code needed on the client):

    ~/.claude/mcp.json:
    {"mcpServers": {"catgo": {"url": "http://localhost:8000/api/mcp/sse"}}}

For remote servers: SSH tunnel (-R 8000:localhost:8000) + same config.
"""

import logging

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.routing import Mount, Route

from mcp.server import Server
from mcp.server.sse import SseServerTransport
from mcp.types import TextContent, Tool

logger = logging.getLogger(__name__)


def create_mcp_sse_app() -> Starlette:
    """Create a Starlette sub-app serving MCP over SSE.

    Returns a Starlette app to be mounted at /api/mcp in the main FastAPI app.
    """

    # Import tool definitions and handlers from the Claude Code MCP server.
    # These are the same 5 consolidated tools used by the stdio server.
    import sys
    from pathlib import Path
    _server_dir = str(Path(__file__).resolve().parent.parent)
    if _server_dir not in sys.path:
        sys.path.insert(0, _server_dir)

    from catgo.mcp_tools.server_claude_code import (
        TOOLS,
        _handle_structure,
        _handle_fetch,
        _handle_workflow,
        _handle_analyze,
        _handle_view,
        _handle_catalysis,
        _handle_file,
        _handle_system,
        _handle_quickbuild,
        _handle_heterostructure,
        _handle_nanotube,
        _handle_moire,
        _handle_workflow_engine,
        _handle_diagnose,
        _handle_skills,
        API_BASE,
    )

    import httpx

    # Create a fresh MCP Server instance (separate from the stdio one)
    mcp_server = Server("catgo-claude-code-sse")

    # The SSE transport directs clients to POST messages to /messages/
    # (relative to where this sub-app is mounted)
    sse_transport = SseServerTransport("/messages/")

    @mcp_server.list_tools()
    async def list_tools() -> list[Tool]:
        return TOOLS

    @mcp_server.call_tool()
    async def call_tool(name: str, arguments: dict | None) -> list[TextContent]:
        arguments = arguments or {}
        T = TextContent
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                if name == "catgo_structure":
                    return await _handle_structure(client, arguments)
                elif name == "catgo_fetch":
                    return await _handle_fetch(client, arguments)
                elif name == "catgo_workflow":
                    return await _handle_workflow(client, arguments)
                elif name == "catgo_analyze":
                    return await _handle_analyze(client, arguments)
                elif name == "catgo_view":
                    return await _handle_view(client, arguments)
                elif name == "catgo_catalysis":
                    return await _handle_catalysis(client, arguments)
                elif name == "catgo_file":
                    return await _handle_file(client, arguments)
                elif name == "catgo_system":
                    return await _handle_system(client, arguments)
                elif name == "catgo_quickbuild":
                    return await _handle_quickbuild(client, arguments)
                elif name == "catgo_heterostructure":
                    return await _handle_heterostructure(client, arguments)
                elif name == "catgo_nanotube":
                    return await _handle_nanotube(client, arguments)
                elif name == "catgo_moire":
                    return await _handle_moire(client, arguments)
                elif name == "catgo_workflow_engine":
                    return await _handle_workflow_engine(arguments)
                elif name == "catgo_diagnose":
                    return await _handle_diagnose(arguments)
                elif name == "catgo_skills":
                    return await _handle_skills(arguments)
                else:
                    return [T(type="text", text=f"Unknown tool: {name}")]
        except httpx.ConnectError:
            return [T(
                type="text",
                text=f"Cannot connect to CatGO backend at {API_BASE}. "
                     "Is the backend running?",
            )]
        except Exception as exc:
            logger.error("MCP SSE tool %s failed: %s", name, exc, exc_info=True)
            return [T(type="text", text=f"{name} failed: {exc}")]

    async def handle_sse(request: Request):
        async with sse_transport.connect_sse(
            request.scope, request.receive, request._send
        ) as (read_stream, write_stream):
            await mcp_server.run(
                read_stream,
                write_stream,
                mcp_server.create_initialization_options(),
            )

    return Starlette(
        routes=[
            Route("/sse", endpoint=handle_sse),
            Mount("/messages/", app=sse_transport.handle_post_message),
        ],
    )

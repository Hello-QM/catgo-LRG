"""Backward-compatible entry point — delegates to mcp_tools package."""
import asyncio
import logging
import os
import sys

# Ensure server/ is on sys.path so mcp_tools is importable
_server_dir = os.path.dirname(os.path.abspath(__file__))
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

from catgo.mcp_tools.server import main

if __name__ == "__main__":
    _log_file = os.path.join(_server_dir, "mcp_debug.log")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(_log_file, encoding="utf-8"),
            logging.StreamHandler(sys.stderr),
        ],
    )
    asyncio.run(main())

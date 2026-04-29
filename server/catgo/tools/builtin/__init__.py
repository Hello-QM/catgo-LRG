# server/tools/builtin/__init__.py
"""Built-in tools that ship with CatGo server."""


def get_builtin_tool_modules():
    """Return list of modules containing TOOL dicts."""
    from . import vasp_readers
    return [vasp_readers]

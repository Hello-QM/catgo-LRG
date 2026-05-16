# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec file for CatGo backend server.

Build with: pyinstaller catgo_server.spec

This creates a standalone executable that bundles:
- FastAPI server with all routers
- xTB calculator (via tblite / xtb-python)
- EMT calculator (ASE built-in)
- VASP/QE/LAMMPS/ORCA/CP2K input generators
- Workflow engine with engine defs and templates
- MCP HTTP server
- Skill docs and tool schemas

MACE and other ML potentials are excluded to keep the bundle size reasonable.
"""

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

# Get the server directory
server_dir = Path(SPECPATH)

# cube-processor binary name is platform-specific (Windows appends .exe).
# The source path must match the actual cargo artifact or PyInstaller fails
# with "Unable to find ...cube-processor"; the bundle dest dir stays the
# same so runtime path resolution is unchanged on each platform.
_cube_bin = 'cube-processor.exe' if sys.platform == 'win32' else 'cube-processor'

# Auto-collect all submodules (lazy imports invisible to PyInstaller)
catgo_submodules = collect_submodules('catgo')
workflow_submodules = collect_submodules('workflow')

# Collect data files from packages that bundle .json/.json.gz/.yaml etc.
pymatgen_datas = collect_data_files('pymatgen')
tblite_datas = collect_data_files('tblite', include_py_files=False)
ase_datas = collect_data_files('ase', include_py_files=False)
# rfc3987_syntax ships a .lark grammar consumed by mcp's URL validation;
# without it the MCP HTTP router fails to register at startup and the
# `/api/mcp/*` endpoints 404.
rfc3987_syntax_datas = collect_data_files('rfc3987_syntax')

a = Analysis(
    ['main.py'],
    pathex=[str(server_dir)],
    binaries=[],
    datas=[
        # Workflow engine definition YAML files
        ('workflow/engine_defs/*.yaml', 'workflow/engine_defs'),
        ('workflow/engine_defs/custom/*.yaml', 'workflow/engine_defs/custom'),
        # Workflow Jinja2 templates
        ('workflow/templates/xtb/*.j2', 'workflow/templates/xtb'),
        ('workflow/templates/mlp/*.j2', 'workflow/templates/mlp'),
        # Skill documentation (recursive SKILL.md files)
        ('catgo/workflow/skills', 'catgo/workflow/skills'),
        # Tool JSON schemas
        ('catgo/tool_schema/*.json', 'catgo/tool_schema'),
        # HPC job script templates
        ('templates/*.sh', 'templates'),
        # Rust cube-processor binary — used by /api/cube/{compute,slice,export-glb,
        # export-obj} for mesh extraction and isosurface ops. Without it the
        # bundled backend returns 503 "cube-processor binary not found" the
        # moment a user clicks Export GLB / Export OBJ. Path inside the bundle
        # must match the layout `server/catgo/routers/{chgcar,cube}.py` use,
        # which is `<MEIPASS>/tools/cube-processor/target/release/cube-processor`
        # (from Path(__file__).parent.parent.parent / "tools" / ...).
        (f'../tools/cube-processor/target/release/{_cube_bin}',
         'tools/cube-processor/target/release'),
    ] + pymatgen_datas + tblite_datas + ase_datas + rfc3987_syntax_datas,
    hiddenimports=catgo_submodules + workflow_submodules + [
        # ---------------------------------------------------------------
        # FastAPI / ASGI stack
        # ---------------------------------------------------------------
        'uvicorn',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'fastapi',
        'starlette',
        'pydantic',
        'pydantic_core',

        # ---------------------------------------------------------------
        # Pymatgen (core, transformations, analysis, I/O)
        # ---------------------------------------------------------------
        'pymatgen',
        'pymatgen.core',
        'pymatgen.core.structure',
        'pymatgen.core.surface',
        'pymatgen.transformations',
        'pymatgen.analysis',
        'pymatgen.io.vasp',
        'pymatgen.symmetry',

        # ---------------------------------------------------------------
        # ASE (calculators, optimization, I/O)
        # ---------------------------------------------------------------
        'ase',
        'ase.calculators',
        'ase.calculators.emt',
        'ase.optimize',
        'ase.optimize.bfgs',
        'ase.optimize.fire',
        'ase.constraints',
        'ase.io',
        'ase.filters',

        # ---------------------------------------------------------------
        # tblite for xTB calculator
        # ---------------------------------------------------------------
        'tblite',
        'tblite.ase',

        # ---------------------------------------------------------------
        # Scientific computing
        # ---------------------------------------------------------------
        'numpy',
        'scipy',
        'scipy.spatial',
        'scipy.optimize',

        # ---------------------------------------------------------------
        # MD analysis
        # ---------------------------------------------------------------
        'mdtraj',
        'sklearn',
        'h5py',

        # ---------------------------------------------------------------
        # HTTP client
        # ---------------------------------------------------------------
        'httpx',
        'httpx._transports',
        'httpx._transports.default',
        'anyio',
        'anyio._backends',
        'anyio._backends._asyncio',
        'h11',
        'httpcore',
        'certifi',
        'idna',
        'sniffio',

        # ---------------------------------------------------------------
        # MCP (Model Context Protocol)
        # ---------------------------------------------------------------
        'mcp',
        'mcp.server',
        'mcp.types',

        # ---------------------------------------------------------------
        # Windows: pywin32 helper modules in win32/lib/
        #
        # PyInstaller's pywin32 hook captures the .pyd C extensions but does
        # NOT run pywin32's .pth file, which is what makes the pure-Python
        # helpers in win32/lib/ importable at the top level (e.g.
        # `import win32timezone`). pywin32 itself and some of its dependents
        # lazy-import these helpers from inside C code paths; without them,
        # HPC connect raises `ModuleNotFoundError: No module named 'win32timezone'`
        # at runtime even though all the .pyd files are present.
        #
        # Listed explicitly so PyInstaller's importer finds the .py files and
        # packs them. Build is unaffected on macOS/Linux — unresolved hidden
        # imports emit a warning but do not fail the build.
        # ---------------------------------------------------------------
        'win32timezone',
        'pywin32_bootstrap',
    ],
    hookspath=[str(server_dir / 'pyinstaller_hooks')],
    hooksconfig={},
    runtime_hooks=[str(server_dir / 'pyinstaller_hooks' / 'runtime-hook-catgo.py')],
    excludes=[
        # Heavy ML libraries
        'torch',
        'pytorch',
        'mace',
        'mace_torch',
        'chgnet',
        'matgl',
        'm3gnet',
        'tensorflow',
        # NOTE: 'workflow' is NOT excluded — our server/workflow/ package needs it.
        # The buggy third-party hook-workflow.py is overridden by
        # pyinstaller_hooks/hook-workflow.py (empty hook).
        # Dev / visualization tools
        'matplotlib',
        'PIL',
        'IPython',
        'jupyter',
        'notebook',
        'pytest',
        'sphinx',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='catgo-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

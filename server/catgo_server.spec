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
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, collect_dynamic_libs

block_cipher = None

# Get the server directory
server_dir = Path(SPECPATH)
project_dir = server_dir.parent
dos_ext_dir = project_dir / 'extensions' / 'dos-analysis'
cohp_ext_dir = project_dir / 'extensions' / 'cohp-analysis'

for _ext_dir in (dos_ext_dir, cohp_ext_dir):
    if _ext_dir.is_dir() and str(_ext_dir) not in sys.path:
        sys.path.insert(0, str(_ext_dir))

# cube-processor binary name is platform-specific (Windows appends .exe).
# The source path must match the actual cargo artifact or PyInstaller fails
# with "Unable to find ...cube-processor"; the bundle dest dir stays the
# same so runtime path resolution is unchanged on each platform.
_cube_bin = 'cube-processor.exe' if sys.platform == 'win32' else 'cube-processor'

# Auto-collect all submodules (lazy imports invisible to PyInstaller)
catgo_submodules = collect_submodules('catgo')
workflow_submodules = collect_submodules('workflow')
dos_submodules = collect_submodules('catgo_dos')
cohp_submodules = collect_submodules('catgo_cohp')

# Collect data files from packages that bundle .json/.json.gz/.yaml etc.
pymatgen_datas = collect_data_files('pymatgen')
tblite_datas = collect_data_files('tblite', include_py_files=False)
ase_datas = collect_data_files('ase', include_py_files=False)
# rfc3987_syntax ships a .lark grammar consumed by mcp's URL validation;
# without it the MCP HTTP router fails to register at startup and the
# `/api/mcp/*` endpoints 404.
rfc3987_syntax_datas = collect_data_files('rfc3987_syntax')

# faster-whisper (CTranslate2) — native STT engine for desktop voice dictation.
# routers/stt.py imports it LAZILY (inside functions), so PyInstaller's static
# analysis never sees it; without explicit collection the bundled backend ships
# no native STT and /api/stt/health reports unavailable, forcing the broken
# in-webview WASM fallback. Collect the package, its submodules, and the
# CTranslate2 native shared libs. CPU int8 works on every platform incl. Apple
# Silicon (no NVIDIA); CUDA uses the user's own cuBLAS/cuDNN (not bundled).
try:
    ctranslate2_bins = collect_dynamic_libs('ctranslate2')
    faster_whisper_datas = collect_data_files('faster_whisper')
    stt_hiddenimports = (
        ['faster_whisper', 'ctranslate2', 'tokenizers', 'huggingface_hub']
        + collect_submodules('ctranslate2')
        + collect_submodules('faster_whisper')
    )
except Exception as _stt_exc:
    # Don't fail the whole build, but make a missing dep loud — otherwise the
    # shipped sidecar silently has no native STT and falls back to the broken
    # in-webview WASM path. Install `faster-whisper` before building.
    print(
        f"WARNING [catgo_server.spec]: faster-whisper not collected ({_stt_exc!r}); "
        "native STT will be UNAVAILABLE in this build — `pip install faster-whisper`",
        file=sys.stderr,
    )
    ctranslate2_bins, faster_whisper_datas, stt_hiddenimports = [], [], []

a = Analysis(
    ['main.py'],
    pathex=[str(server_dir)],
    binaries=ctranslate2_bins,
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
        # Local DOS/COHP analysis extension packages. They are source-tree
        # packages rather than normal dependencies, so bundle their package dirs
        # and let server/main.py add <MEIPASS>/extensions/* to sys.path.
        ('../extensions/dos-analysis/catgo_dos',
         'extensions/dos-analysis/catgo_dos'),
        ('../extensions/cohp-analysis/catgo_cohp',
         'extensions/cohp-analysis/catgo_cohp'),
    ] + pymatgen_datas + tblite_datas + ase_datas + rfc3987_syntax_datas
      + faster_whisper_datas,
    hiddenimports=catgo_submodules + workflow_submodules + dos_submodules + cohp_submodules + stt_hiddenimports + [
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

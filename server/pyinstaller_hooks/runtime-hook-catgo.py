# PyInstaller runtime hook — pre-import modules that are loaded via
# __getattr__ / importlib.import_module() at runtime. The frozen importer
# bundles the bytecode but importlib.import_module() sometimes fails to
# find it unless the parent package is already imported.

import importlib

# Modules lazily imported via catgo.utils.hpc_client.__getattr__
_lazy_modules = [
    'catgo.utils.connection_pool',
    'catgo.utils.hpc_connection',
    'catgo.utils.local_connection',
    'catgo.utils.ssh_auth',
    'catgo.utils.ssh_file_ops',
    'catgo.utils.slurm',
    'catgo.utils.pbs',
]

for mod in _lazy_modules:
    try:
        importlib.import_module(mod)
    except ImportError:
        pass

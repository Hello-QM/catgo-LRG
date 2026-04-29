# PyInstaller hook for catgo package.
# Forces collection of all catgo submodules since many use lazy __getattr__ imports
# that importlib.import_module() can't resolve in frozen binaries.

from PyInstaller.utils.hooks import collect_submodules, collect_data_files

hiddenimports = collect_submodules('catgo')
datas = collect_data_files('catgo', include_py_files=False)
